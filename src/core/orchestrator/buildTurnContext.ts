import crypto from 'node:crypto';
import { isClockReply, clockReply } from '../../utils/schedulingClockReply';
import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../../llm/client';
import { MODEL_SONNET } from '../../llm/models';
import { buildSystemPromptParts } from './systemPrompt';
import { classifyTurn, type OwnerIntentClassification } from '../social/classifyTurn';
import { chooseSocialDirective, formatDirectiveForPromptBlock, type SocialDirective, noDirective } from '../social/stateMachine';
import { getSkillTools, WRITE_TOOLS } from '../../skills/registry';
import { buildSocialContextBlock, buildPersonWorkContextBlock, getSummarySessionByThread, getOutreachLifecycle, markThreadHadSocialTurn } from '../../db';
import { getActiveJobsForThread } from '../../tasks';
import { DateTime } from 'luxon';
import logger from '../../utils/logger';
import { trimHistory, extractActionTape, stampHistoryTime } from './turnHelpers';
import type { OrchestratorInput } from './index';
import type { SkillContext } from '../../skills/types';
import type { RefusedBooking } from '../../db/conversations';

const anthropic = getAnthropicClient();

// A participant identifier already has human-message provenance below. Slack's
// mailto destination, not its display label or a directory namesake, is its inbox.
function participantMailbox(identifier:string):string|undefined {
  const links=[...identifier.matchAll(/<mailto:([^>|]+)(?:\|[^>]*)?>/gi)];
  const value=links.length===1 ? links[0][1] : identifier.trim();
  return /^[A-Z0-9.!#$%&'*+/=?^_`{}|~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+$/i.test(value)
    ? value.toLowerCase() : undefined;
}

/** A message consisting only of mailbox tokens needs no semantic extraction. */
function mailboxOnlyReply(message:string):string[] {
  const token=/<mailto:[^>]+>|[A-Z0-9.!#$%&'*+/=?^_`{}|~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
  const literals=[...message.matchAll(token)].map(match=>match[0]);
  return literals.length && /^[\s,;]*$/.test(message.replace(token,''))
    ? literals.filter(literal=>!!participantMailbox(literal)) : [];
}

function participantIdentifier(identifier:string):string {
  const mailbox=participantMailbox(identifier);
  if (mailbox) return mailbox;
  const mentions=[...identifier.matchAll(/<@[A-Z0-9]+(?:\|[^>]+)?>/g)];
  return mentions.length===1 ? mentions[0][0].split('|')[0].replace(/>?$/, '>') : identifier;
}

export async function buildTurnContext(input: OrchestratorInput) {
  const { userMessage, conversationHistory, threadTs, profile } = input;

  // v4.4.9 (gh#154-R9) / gh#154-W3 fix — "who else can read the answer" (surface). Computed
  // once, up top, so every wholesale room-suppression site (the proactive
  // raise-stamp below, personWorkBlock/socialBlock/socialDirectiveBlock
  // further down) reads the SAME value. A room turn never renders a proactive
  // subject, so it must never MARK one raised either — the two have to stay
  // paired or the re-raise defer / decay / initiation gate (socialSubjects.ts)
  // key off a stamp that no render ever produced.
  const isRoom = input.isMpim === true || input.isChannel === true;

  // v2.5.4 Bug 3 — MPIM with non-owner members forces colleague-context.
  // Removed 2026-08 (#154): there is no MPIM without non-owner members —
  // Maelle has exactly one owner, so any MPIM she's in is by definition
  // crowded, and this branch's own condition (mpimWithOthers && senderRole
  // === 'owner') could never come out false. `role`/`senderRole` is now
  // clamped to 'colleague' in every MPIM at the single front door
  // (processMessage.ts's isMpim/isChannel role clamp) before the orchestrator is called, so
  // there is nothing left for a second clamp here to reconcile.
  // isOwnerInGroup still carries "the owner is the one typing" through to
  // social classification + people-memory unchanged.

  logger.info('Orchestrator invoked', {
    user: profile.user.name,
    channel: input.channel,
    senderRole: input.senderRole,
    isOwnerInGroup: input.isOwnerInGroup ?? false,
    isMpim: input.isMpim ?? false,
    preview: userMessage.slice(0, 80),
  });

  // Initial assistant-panel status — fires the instant the message lands so
  // the user sees "On it" instead of Slack's auto-default ("Gathering
  // information…" / "Reviewing findings…") during the ~10s pre-first-tool
  // reasoning gap (classifyTurn pre-pass + initial Sonnet pass). Per-tool
  // status text from the pre-tool hook below overwrites this as tools fire.
  // Interactive turns try setStatus when we have channel+thread context.
  // Slack rejects non-panel calls with
  // channel_not_found / not_in_assistant_thread, which the catch in
  // setAssistantStatus already swallows at debug level. (The old v2.7.3 panel
  // registry this used to consult was removed in the v3.7.x cleanup.)
  // Scheduled runs have only an internal run key, not an existing Slack thread.
  if (input.interactive !== false && input.app && input.channelId && input.threadTs) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { setAssistantStatus } = require('../../connections/slack/messaging') as
        typeof import('../../connections/slack/messaging');
      void setAssistantStatus(input.app, input.profile.assistant.slack.bot_token, {
        channelId: input.channelId,
        threadTs: input.threadTs,
        status: 'Thinking',
      });
    } catch (_) { /* helper failure is non-fatal */ }
  }

  // v1.6.2 — claim-checker retry path: allow appending a one-shot nudge to the
  // current user message so the model knows why it's being re-invoked. Never
  // persisted to conversation history (callers pass it as extraInstruction
  // exactly once per retry).
  const effectiveUserMessage = input.extraInstruction
    ? `${userMessage}\n\n[SYSTEM NOTE — not from ${profile.user.name.split(' ')[0]}: ${input.extraInstruction}]`
    : userMessage;

  // v2.2.3 (#3) — Social Engine pre-pass GATED on the persona skill being
  // active in this profile. When persona is off, skip the classifier Sonnet
  // call entirely + leave directive empty — saves an API call per turn and
  // keeps the prompt clean of social context. Read fresh per turn so a YAML
  // edit takes effect on the next message (no caching).
  let socialDirective: SocialDirective = noDirective();
  let socialClassification: OwnerIntentClassification | null = null;
  let meetingRequest: import('../../db/conversations').MeetingRequestState | undefined;
  let meetingExplorationOnly = false;
  let unresolvedHoldSelection = false;
  let firmWindowBooking = false;
  let searchBeforeReply = false;
  let decisionReportLocale:'en'|'he'|undefined;
  let answeredQuestion:string|undefined;
  let requestedOptionCount:number|null|undefined;
  let consultOwnerQuote: string | undefined;
  let consultBackground: string | undefined;
  let optionsReplyLocale: 'en' | 'he' | undefined;
  let singleZoneOptions = false;
  let continuedRefusal: RefusedBooking | undefined;
  let existingInviteSubject: string | undefined;
  let existingInviteStart: string | undefined;
  let existingInviteLocale: string | undefined;
  let withdrawalId: string | undefined;
  let exactBookingRequested = false;
  let requestedException: RefusedBooking | undefined;
  // Defined only for a colleague's request to hold selected prior offers. An empty
  // map means no eligible offer (including after a restart or stash failure).
  let holdOnlyWindows: Map<number, number> | undefined;
  let checkRequestedHold = false;
  // ── TWO questions, two names — never one flag ────────────────────────────
  // Pre-fix this file carried two competing definitions of "owner turn":
  // `input.senderRole === 'owner'` (post-clamp) and a looser
  // `senderRole === 'owner' || isOwnerInGroup === true`. Blocks picked one ad
  // hoc, so in an MPIM the action tape (strict) was suppressed while the
  // thread-event ledger 50 lines later (loose) was not — the owner's meeting
  // subjects + event ids went into a colleague-readable thread's context, the
  // exact leak the clamp above exists to prevent. One name per question now:
  //
  //   isOwnerPath   — is this the OWNER PATH? The effective authority + data
  //                   scope AFTER the MPIM clamp above. Every owner-only
  //                   payload (his calendar, his session ledger, his action
  //                   tape, his open issues) and every owner-only tool gate
  //                   rides THIS and nothing else. It is false in a clamped
  //                   MPIM even though the owner is the one typing — that is
  //                   the whole point of the clamp.
  //   isOwnerTyping — WHO is the human on this turn? Identity only, for social
  //                   classification + people-memory attribution
  //                   (isOwnerInGroup deliberately survives the clamp — see
  //                   the block at the top of this file). NEVER gate data or
  //                   tools on it: attributing a turn to the owner is not the
  //                   same as granting the owner's data scope.
  const isOwnerPath = input.senderRole === 'owner';
  const isOwnerTyping = isOwnerPath || input.isOwnerInGroup === true;
  // person-of-the-turn: owner id when the owner is the typer, colleague id otherwise
  const turnPersonSlackId = isOwnerTyping ? profile.user.slack_user_id : input.userId;
  const turnSenderRole: 'owner' | 'colleague' = isOwnerTyping ? 'owner' : 'colleague';
  // v2.6.2 — renamed from socialActive. Master toggle for codas, engage,
  // proactive ticks, social topic logging, social context blocks.
  // Legacy `skills.persona` already auto-migrated to `skills.social` in
  // registry.ts; reading `skills.social` here is the canonical path.
  const socialActive = (profile.skills as any)?.social === true;

  // v3.0.6 — merged per-turn classifier. The social-intent pre-pass (was
  // classifyOwnerIntent, Sonnet) and the tool-scope pre-pass (was
  // classifyToolScope, Haiku) were two serial LLM calls (~2.9s). They
  // classify the SAME message with the SAME recent-context, so they're now
  // one Haiku call (~1s) via classifyTurn. Each half is gated independently:
  //   - needIntent: social skill on + message has substance (owner OR colleague)
  //   - needScopes: intent_aware_tools on + owner PATH (the colleague path
  //                 discards scopes for tool selection — `needScopes` below is
  //                 gated on `isOwnerPath` — and systemPrompt.ts's
  //                 `toolScopes`-driven prose is built assuming it's undefined
  //                 there, so computing them off-path only skews the prose)
  // Result.scope feeds getSkillTools below (toolScopes); result.intent drives
  // the social directive. Both fail open (intent→other, scopes→general).
  let toolScopes: string[] | undefined;
  let currentPromptScopes: string[] | undefined;
  // v3.1.2 (D) — captured from classifyTurn so a deterministic analyzeCalendar
  // pre-check can fire below for owner buffer/free-time questions, replacing
  // a leaky free-time prompt rule that meetings.ts has since removed.
  let isFreeTimeInquiry = false;
  // v3.6.4 — participant names classifyTurn extracted from a scheduling
  // request, and the internal colleagues we deterministically resolved from
  // them. Threaded into the search so a known colleague is never dropped
  // because Sonnet forgot to resolve the name (Lori 07-08, Simon 07-09).
  let turnMeetingPeople: string[] = [];
  let currentMessageMeetingPeople: string[] = [];
  let resolvedMeetingAttendees: string[] = [];
  let resolvedOptionalAttendees: string[] = [];
  let meetingPeopleGroups: string[][] | undefined;
  let ordinaryCreateSubject: string | undefined;
  let ordinaryCreateAfterOtherMeeting: SkillContext['ordinaryCreateAfterOtherMeeting'];
  let directorySpellings: Array<{name:string; spelling:string}> = [];
  let resolvedMeetingAttendeeGroups: SkillContext['resolvedMeetingAttendeeGroups'];
  let contextualApprovalDecisions: SkillContext['contextualApprovalDecisions'];
  let calendarOperations: import('../social/classifyTurn').ClassifyTurnResult['calendarOperations'];
  let standaloneBookingApproval: SkillContext['standaloneBookingApproval'];
  let exactRequestClock: SkillContext['exactRequestClock'];
  let ownerOutreachAuthorized=false;
  let requireAttendeeAvailability=false;
  let existingStatusOnly=false;
  // gh#158 residual — `resolvedMeetingAttendees` serves two purposes that need
  // different scopes: WHO to auto-add to the search (everyone genuinely on the
  // meeting, including addresses extracted from a forwarded email header below)
  // vs WHO the pre-check's bail signal means by "this turn names someone other
  // than the owner" (availabilityPreCheck.ts's namedAttendeeEmails contract —
  // only names actually present in THIS message's own text). A header address is
  // never "named" in that sense; unioning it into the same list made every
  // forwarded-email booking turn (which almost always carries one) bail the
  // owner's own hard-block pre-check, silently disabling the availability floor
  // for the whole email channel. Snapshot the named-only set BEFORE the header
  // union below extends `resolvedMeetingAttendees`, and feed the bail from this
  // narrower list instead.
  let namedInternalAttendeeEmails: string[] = [];
  let resolvedAttendeesBlock = '';
  // v3.2.6 (6.4) — never run the social directive/coda on a non-interactive
  // (routine/system) turn; a scheduled report isn't a conversation.
  // v4.3.0 (#24 row 131) — nor on a non-Slack transport. Both consumers keyed
  // off this flag are Slack-only concepts: chooseSocialDirective below (feeds
  // the system prompt only — the in-prompt directive never stamps a raise;
  // only a confirmed-delivered coda does, via recordCodaDelivered) and the
  // end-of-turn coda in
  // orchestrator/index.ts (gated on socialClassification?.kind === 'task',
  // which stays null whenever needIntent is false — see the return at the
  // bottom of this function). A coda is composed and delivered by the
  // Slack transport's own 10s beat (connectors/slack/postReply.ts); email
  // (and dormant whatsapp) have no such beat, so on those legs a directive
  // was being computed, sometimes stamped, and then silently dropped —
  // confirmed in production (run 3, #24): "Social coda DUE on a task turn"
  // logged, nothing ever sent. Gating HERE, the single computation site,
  // prevents the work rather than trying to catch the drop at every
  // delivery point. Deliberately independent of needScopes / needMeetingPeople
  // below — the email leg's attendee resolution rides needMeetingPeople and
  // must keep running (see classifyTurn.ts: the three flags gate independent
  // halves of the same classifier call).
  const model = MODEL_SONNET;
  const maxTokens = input.senderRole === 'colleague' ? 12000 : 16000;
  const needIntent = socialActive && input.interactive !== false && !!userMessage && userMessage.trim().length > 1
    && input.channel === 'slack';
  const needScopes = profile.behavior?.intent_aware_tools === true
    && isOwnerPath
    && !!userMessage
    && userMessage.trim().length > 0;
  // v3.6.4 — extract meeting participants on any substantive INTERACTIVE turn
  // (owner OR colleague). Cheap (rides the classifyTurn call that already runs
  // for these turns) and returns [] on non-scheduling messages. This is what
  // makes attendee resolution deterministic instead of a prompt rule Sonnet
  // ignores. Skipped on non-interactive (routine/system) turns — no colleague
  // scheduling request there.
  const needMeetingPeople = input.interactive !== false && !!userMessage && userMessage.trim().length > 1;
  if (needIntent || needScopes || needMeetingPeople) {
    try {
      // Open questions and human conditions can precede an intervening reply.
      // Keep each indexed exchange intact: truncating all but the latest
      // assistant to 280 characters erased unanswered category/identity
      // questions and made the human's answer look unrelated. The same
      // bounded text is used both by classification and citation validation.
      // This is input to the existing call, not durable agreement state.
      const recentMessages = conversationHistory.slice(-4);
      const meetingContextMessages = recentMessages
        .map(m => {
          const content = m.content.length <= 8000 ? m.content
            : `${m.content.slice(0, 4000)}\n[...middle omitted...]\n${m.content.slice(-4000)}`;
          return { role: m.role, content };
        });
      const recentContext = meetingContextMessages
        .map(m => `${m.role === 'user' ? (input.senderName ?? profile.user.name.split(' ')[0]) : profile.assistant.name}: ${m.content}`)
        .join('\n');
      // Shared-surface history can contain transport roster framing rather
      // than authored participant names. Only private Slack history supplies
      // provenance for continuation; other surfaces keep current-turn extraction.
      const isPrivateSlackDm = input.channel === 'slack' && !isRoom
        && (input.surface === 'owner_dm' || input.surface === 'colleague_dm');
      const ownerDecisionPath = input.interactive !== false && input.channel === 'slack' && !isRoom
        && input.surface === 'owner_dm' && input.authority === 'owner' && input.senderRole === 'owner'
        && input.userId === profile.user.slack_user_id;
      const approvalCandidates: Array<{ row: import('../requests/types').RequestRow;
        action: { tool: string; args: Record<string, unknown> } }> = [];
      let boundBooking: typeof approvalCandidates[number] | undefined;
      if (ownerDecisionPath) {
        try {
          const { getAwaitingOwnerRequests } = require('../../db/requests') as typeof import('../../db/requests');
          const pending = getAwaitingOwnerRequests(profile.user.slack_user_id).filter(row =>
            row.state === 'awaiting_owner' && row.owner_user_id === profile.user.slack_user_id);
          const rows = pending.filter(row => row.kind === 'approval');
          // Count every outstanding decision in the same private thread, including
          // other request kinds. The model never selects the referent of a bare assent.
          const bound = input.threadTs && input.channelId && input.typedUserMessage === userMessage
            && userMessage.trim() && !input.images?.length && !input.extractedAttendeeEmails?.length
            && !input.proseOnly && !input.forceToolOnFirstTurn
            && (!input.inboundConnectionId || input.inboundConnectionId === 'slack')
            ? pending.filter(row => row.owner_dm_channel === input.channelId
              && (row.terminal_dm_msg_ts === input.threadTs || row.owner_dm_thread_ts === input.threadTs))
            : [];
          const sole = bound.length === 1 && bound[0].kind === 'approval' ? bound[0] : undefined;
          // Contextual comparisons need the complete set. The exact thread can
          // still identify a standalone booking when the global queue is larger.
          const inspect = rows.length <= 10 ? rows : sole ? [sole] : [];
          if (inspect.length) {
            const { parseDetails } = require('../requests/types') as typeof import('../requests/types');
            const { extractCallbacks, mergeAmendIntoApprove } = require('../approvals/approvalCallbacks') as typeof import('../approvals/approvalCallbacks');
            for (const row of inspect) {
              const details = parseDetails<Record<string, unknown>>(row);
              let action = extractCallbacks(details).on_approve;
              if (!action || !['create_meeting', 'move_meeting', 'update_meeting'].includes(action.tool)) continue;
              if (details?.counter && typeof details.counter === 'object') {
                action = mergeAmendIntoApprove(action, details.counter as Record<string, unknown>, profile);
              }
              const candidate = { row, action };
              approvalCandidates.push(candidate);
              if (row === sole && action.tool === 'create_meeting' && row.details_json) boundBooking = candidate;
            }
            // An unsupported candidate remains a possible referent. Do not guess
            // among the supported subset when the complete open set is unknown.
            if (approvalCandidates.length !== rows.length) approvalCandidates.length = 0;
          }
        } catch { approvalCandidates.length = 0; boundBooking = undefined; }
      }
      // Only a delivered runtime receipt may anchor this transition. A synthetic
      // history row, a model-authored receipt, or an ambiguous group of mutations cannot.
      const prior = recentMessages.at(-1);
      const priorRefusal = prior?.role === 'assistant' && Array.isArray(prior.toolSummaries) ? prior.refusedBooking : undefined;
      const refusedArgs = priorRefusal?.action?.args;
      const requesterText = input.typedUserMessage?.trim();
      const refusedBooking = priorRefusal && refusedArgs && priorRefusal.action.tool === 'create_meeting'
        && priorRefusal.ownerId === profile.user.slack_user_id && priorRefusal.requesterId === input.userId
        && priorRefusal.channelId === input.channelId && priorRefusal.threadTs === threadTs
        && input.authority === 'colleague' && turnSenderRole === 'colleague' && isPrivateSlackDm
        && input.surface === 'colleague_dm' && input.userId !== profile.user.slack_user_id
        && input.interactive !== false && !input.extraInstruction && !input.forceToolOnFirstTurn && !input.proseOnly
        && !input.images?.length && requesterText && userMessage.includes(requesterText)
        && typeof refusedArgs.subject === 'string' && typeof refusedArgs.start === 'string' && typeof refusedArgs.end === 'string'
        && DateTime.fromISO(refusedArgs.start, { zone: profile.user.timezone }).toMillis() > Date.now()
        ? { subject: refusedArgs.subject, start: refusedArgs.start, end: refusedArgs.end, reason: priorRefusal.reason, requesterText }
        : undefined;
      const receipts = prior?.toolSummaries;
      const prefix = receipts?.length ? receipts.join(' ') + '\n' : '';
      const writes = receipts?.filter(line => line.startsWith('[move_meeting ') || line.startsWith('[create_meeting '));
      const receipt = writes?.length === 1 ? writes[0] : undefined;
      const priorProse = prior?.role === 'assistant' && receipts && prior.content.startsWith(prefix)
        ? prior.content.slice(prefix.length) : '';
      const inspectCreate = ownerDecisionPath && !!input.typedUserMessage?.trim() && !!priorProse
        && !input.proseOnly && !input.extraInstruction && !input.forceToolOnFirstTurn
        && !input.images?.length && !input.extractedAttendeeEmails?.length
        && (!input.inboundConnectionId || input.inboundConnectionId === 'slack')
        && receipt?.endsWith(' attendee_check=noted')
        && (receipt.startsWith("[move_meeting OK — Moved '") || receipt.startsWith("[create_meeting OK — Booked '"));
      // A visit-wide instruction can precede the four recent messages. For this
      // candidate alone, include all earlier available owner messages once, intact.
      // Skip the optional signal if the complete owner text exceeds the budget.
      const privateOwnerContext = inspectCreate ? conversationHistory.flatMap((m, i) => {
        if (m.role !== 'user') return [];
        const recentIndex = i - (conversationHistory.length - recentMessages.length);
        const included = recentIndex < 0 ? '' : meetingContextMessages[recentIndex].content;
        return included.length === m.content.length ? [] : [m.content];
      }) : [];
      const inspectIndependentOrdinaryCreate = !!inspectCreate && !approvalCandidates.length
        && privateOwnerContext.reduce((sum, message) => sum + message.length, 0) <= 4000;
      const classifierCandidates = approvalCandidates.length ? approvalCandidates : boundBooking ? [boundBooking] : [];
      // The offer must have been delivered in this conversation. Never bind
      // against tool summaries, remote/legacy rows without delivery receipts,
      // or a merged room batch whose authenticated typed text is unavailable.
      let holdCandidates: NonNullable<Parameters<typeof classifyTurn>[0]['holdCandidates']> = [];
      if (needMeetingPeople && priorProse && priorProse.length <= 8000 && input.channel === 'slack'
        && input.authority === 'colleague' && turnSenderRole === 'colleague' && input.userId !== profile.user.slack_user_id
        && ((isPrivateSlackDm && input.surface === 'colleague_dm') || (isRoom && input.surface === 'room' && !!threadTs))
        && input.typedUserMessage?.trim() && userMessage.includes(input.typedUserMessage)
        && !input.proseOnly && !input.images?.length && !input.forceToolOnFirstTurn) {
        try {
          const { getOfferedSlots } = require('../../utils/offeredSlotsStash') as typeof import('../../utils/offeredSlotsStash');
          const offered = getOfferedSlots(input.channelId, threadTs)?.filter(slot => slot.endIso) ?? [];
          if (offered.length) {
            const { getPersonMemory } = require('../../db') as typeof import('../../db');
            const { attendeeKnownTimezoneForDay, loadAttendeeAvailabilityForPerson } =
              require('../../utils/attendeeAvailability') as typeof import('../../utils/attendeeAvailability');
            const requester = loadAttendeeAvailabilityForPerson(getPersonMemory(input.userId) ?? undefined, profile.user.timezone);
            holdCandidates = offered.flatMap(slot => {
              const start = DateTime.fromISO(slot.startIso, { zone: profile.user.timezone });
              const end = DateTime.fromISO(slot.endIso!, { zone: profile.user.timezone });
              if (!start.isValid || !(end > start)) return [];
              const zone = requester && attendeeKnownTimezoneForDay(requester, slot.startIso);
              const localZones = new Set([slot.presentationZone, zone]);
              localZones.delete(profile.user.timezone);
              const label = (dt: DateTime) => `${dt.toFormat('yyyy-MM-dd HH:mm')} [${dt.zoneName}]`;
              return [{ startIso:slot.startIso, endIso:slot.endIso!, display:label(start),
                presentationZone:slot.presentationZone ?? zone ?? profile.user.timezone,
                localDisplays: [...localZones].flatMap(tz => {
                  if (!tz) return [];
                  const local = start.setZone(tz);
                  return local.isValid ? [label(local)] : [];
                }) }];
            });
          }
        } catch (err) {
          logger.warn('Orchestrator — hold options unavailable for selection', { err: String(err).slice(0, 160) });
        }
      }
      // A classifier outage while resolving a concrete offer cannot grant a
      // write. A normal execute result still permits confirmed invitations.
      if (holdCandidates.length || refusedBooking) meetingExplorationOnly = true;
      const previousRequest = prior?.role === 'assistant' && Array.isArray(prior.toolSummaries) ? prior.meetingRequest : undefined;
      const requestScope = isPrivateSlackDm && !input.proseOnly && !input.extraInstruction && input.interactive !== false
        && input.typedUserMessage?.trim() && input.userId && userMessage.includes(input.typedUserMessage);
      let activeRequest = requestScope && previousRequest?.requesterId === input.userId
        && previousRequest.ownerId === profile.user.slack_user_id && previousRequest.threadTs === threadTs
        && previousRequest.channelId === input.channelId ? previousRequest : undefined;
      const requestHistory=new Map<string,import('../../db/conversations').MeetingRequestState>();
      if(requestScope) for(const row of conversationHistory) {
        const state=row.role==='assistant' && Array.isArray(row.toolSummaries) ? row.meetingRequest : undefined;
        if(state?.requestId && state.requesterId===input.userId && state.ownerId===profile.user.slack_user_id
          && state.threadTs===threadTs && state.channelId===input.channelId) {
          requestHistory.delete(state.requestId);requestHistory.set(state.requestId,state);
        }
      }
      const recentRequests=[...requestHistory.values()].slice(-4);
      if (activeRequest && !isOwnerTyping) {
        // The directory extractor must be able to cite the original roster
        // even after several turns selecting dates or correcting an address.
        const priorHuman = [activeRequest.original, ...activeRequest.updates];
        const recentHuman = new Set(recentMessages.filter(row => row.role === 'user').map(row => row.content.trim()));
        meetingContextMessages.unshift(...priorHuman.filter(content => !recentHuman.has(content.trim()))
          .map(content => ({role:'user' as const,content})));
      }
      let requesterDayZone: string | undefined;
      if (requestScope && input.authority === 'colleague' && input.userId !== profile.user.slack_user_id) {
        try {
          const {getPersonMemory} = await import('../../db');
          const {loadAttendeeAvailabilityForPerson, attendeeKnownTimezoneForDay} = await import('../../utils/attendeeAvailability');
          const person = loadAttendeeAvailabilityForPerson(getPersonMemory(input.userId) ?? undefined, profile.user.timezone);
          if (person) requesterDayZone = attendeeKnownTimezoneForDay(person, new Date().toISOString()) ?? undefined;
        } catch { /* No established requester clock. */ }
      }
      const turnResult = await classifyTurn({
        anthropic,
        requesterDayZone,
        message: userMessage,
        profile,
        needIntent,
        // The feature flag governs tool narrowing. Selecting the appropriate
        // instructions still needs the current domain on an owner DM; reuse
        // the same classification call without restricting any capability.
        needScopes:needScopes || (needMeetingPeople && isPrivateSlackDm && input.surface==='owner_dm' && isOwnerPath),
        needMeetingPeople,
        refusedBooking,
        senderRole: turnSenderRole,
        senderName: input.senderName,
        recentContext: recentContext || undefined,
        priorMeetingRequest: activeRequest && {original:activeRequest.original,updates:activeRequest.updates,batch:activeRequest.batch,hasConfirmedBooking:activeRequest.hasConfirmedBooking,duration:activeRequest.duration,participantGroups:activeRequest.participantGroups,requiredDay:activeRequest.requiredDay,bookingInstruction:!activeRequest.hasConfirmedBooking ? activeRequest.bookingInstruction : undefined},
        recentMeetingRequests:recentRequests.length>1 ? recentRequests.map(({requestId,original,updates,batch,hasConfirmedBooking,duration,participantGroups,requiredDay,bookingInstruction,existingMeeting})=>({
          requestId,original,updates:updates.slice(-3),batch,hasConfirmedBooking,duration,participantGroups,requiredDay,
          bookingInstruction:hasConfirmedBooking?undefined:bookingInstruction,existingMeeting,
        })) : undefined,
        meetingContextMessages: isPrivateSlackDm ? meetingContextMessages : undefined,
        ...(holdCandidates.length ? { holdCandidates, holdOfferText:priorProse, holdSelectionText:input.typedUserMessage } : {}),
        inspectIndependentOrdinaryCreate,
        ordinaryCreateOwnerContext: inspectIndependentOrdinaryCreate ? privateOwnerContext : undefined,
        approvalCandidates: classifierCandidates.length ? classifierCandidates.map(({ row, action }) => {
          const details = JSON.parse(row.details_json ?? '{}');
          return {subject:row.subject ?? '',action,reason:details.honest_hard_reason ?? details.rule_label ?? details.rule};
        }) : undefined,
      });
      if(turnResult.selectedRequestId) {
        const selected=recentRequests.find(state=>state.requestId===turnResult.selectedRequestId);
        if(selected) activeRequest=selected;
      }
      const followsOffer = !!activeRequest && !activeRequest.batch && !!receipts?.some(line => line.startsWith('[find_available_slots ') && line.includes(' slots:'))
        && !!input.typedUserMessage && isClockReply(input.typedUserMessage);
      const requestUpdate = followsOffer ? { relation: 'continue' as const, duration: undefined, clockZone:undefined, batch:false } : turnResult.requestUpdate;
      if (requestScope && input.surface === 'owner_dm' && input.userId === profile.user.slack_user_id
        && turnResult.decisionReport?.quote === input.typedUserMessage) decisionReportLocale = turnResult.decisionReport?.locale;
      if (requestScope && input.surface==='owner_dm' && input.authority==='owner' && input.userId===profile.user.slack_user_id
        && !input.images?.length && !input.forceToolOnFirstTurn) answeredQuestion=turnResult.answeredQuestion;
      if (requestScope && input.surface==='owner_dm' && input.authority==='owner' && input.userId===profile.user.slack_user_id
        && turnResult.ownerOutreachQuote===input.typedUserMessage && input.typedUserMessage===userMessage
        && !input.images?.length && !input.forceToolOnFirstTurn && !input.extraInstruction) ownerOutreachAuthorized=!!turnResult.ownerOutreachQuote;
      if (requestScope && isOwnerTyping && input.surface==='owner_dm' && turnResult.requireAvailabilityQuote===input.typedUserMessage
        && !!turnResult.requireAvailabilityQuote && input.typedUserMessage===userMessage && !input.proseOnly && !input.extraInstruction && !input.forceToolOnFirstTurn && !input.images?.length) requireAttendeeAvailability=true;
      if (requestScope) requestedOptionCount = turnResult.requestedOptionCount ?? null;
      searchBeforeReply = !!(requestScope && turnResult.searchBeforeReply && turnResult.searchBeforeReply === input.typedUserMessage
        && !input.proseOnly && !input.extraInstruction && !input.images?.length && !input.forceToolOnFirstTurn);
      if (requestScope && requestUpdate && input.typedUserMessage) {
        const update = requestUpdate;
        const text = input.typedUserMessage.trim().slice(0, 4000);
        const previous = update.relation === 'continue' ? activeRequest : undefined;
        const batch = !!(update.batch || previous?.batch);
        meetingRequest = {
          batch, requestId:previous?.requestId ?? crypto.randomUUID(), hasConfirmedBooking:previous?.hasConfirmedBooking,
          ownerId:profile.user.slack_user_id, requesterId:input.userId, channelId:input.channelId, threadTs,
          original: previous?.original ?? text, updates: previous
            ? [...previous.updates.filter(item => item !== text), text].slice(-12) : [],
          requiredDay:previous?.requiredDay,
          searchDay:batch ? undefined : previous?.searchDay,
          bookingInstruction:previous?.bookingInstruction,
          individualSearchEmails:previous?.individualSearchEmails,
          requesterPair:!batch && input.surface==='colleague_dm' && (turnResult.requesterPair === true
            || (previous?.requesterPair === true && (turnResult.participantsUnchanged || followsOffer))),
          participantGroups:previous?.participantGroups,
          directorySpellings:previous?.directorySpellings,
          participantBindings:previous?.participantBindings,
          optionalParticipants:previous?.optionalParticipants,
          conflictOptions:previous?.conflictOptions,
          existingMeeting:batch ? undefined : turnResult.existingMeetingQuote
            ? {...previous?.existingMeeting,sourceQuote:turnResult.existingMeetingQuote}
            : (turnResult.participantsUnchanged || followsOffer) ? previous?.existingMeeting : undefined,
          clockZone:batch ? undefined : update.clockZone && text.includes(update.clockZone.quote) ? update.clockZone : previous?.clockZone,
          duration: batch ? undefined : update.duration && text.includes(update.duration.quote) ? update.duration : previous?.duration,
        };
      }
      if (meetingRequest && !meetingRequest.batch && requestUpdate?.searchDay
        && input.typedUserMessage?.includes(requestUpdate.searchDay.quote)) {
        const {date:expression,quote}=requestUpdate.searchDay;
        if (expression==='flexible') {
          delete meetingRequest.searchDay;
          // A newly requested range supersedes the previous single-day
          // restriction. Permission to book still comes from this turn's intent.
          delete meetingRequest.requiredDay;
          delete meetingRequest.bookingInstruction;
        }
        else {
          const zone=meetingRequest.clockZone?.zone ?? requesterDayZone ?? profile.user.timezone;
          const offset=['today','tomorrow','day_after_tomorrow'].indexOf(expression);
          const anchor=isOwnerTyping && zone===profile.user.timezone
            ? (await import('../../utils/effectiveToday')).getEffectiveToday(profile) : DateTime.now().setZone(zone);
          const date=offset>=0 ? anchor.plus({days:offset}).toISODate() : expression;
          if (date && DateTime.fromISO(date,{zone}).toISODate()===date) {
            meetingRequest.searchDay={date,zone,quote};
            if (meetingRequest.requiredDay && meetingRequest.requiredDay.date!==date) {
              delete meetingRequest.requiredDay;
              delete meetingRequest.bookingInstruction;
            }
          }
        }
      }
      if (meetingRequest && !meetingRequest.batch && requestUpdate && 'dayChange' in requestUpdate && requestUpdate.dayChange
        && input.typedUserMessage?.includes(requestUpdate.dayChange.quote)) {
        const {date:expression, quote} = requestUpdate.dayChange;
        if (expression === 'flexible') {
          delete meetingRequest.requiredDay;
          delete meetingRequest.bookingInstruction;
        }
        else {
          const zone = meetingRequest.clockZone?.zone ?? requesterDayZone ?? profile.user.timezone;
          const offset = ['today','tomorrow','day_after_tomorrow'].indexOf(expression);
          let date = expression;
          if (offset >= 0) {
            const anchor = isOwnerTyping && zone === profile.user.timezone
              ? (await import('../../utils/effectiveToday')).getEffectiveToday(profile) : DateTime.now().setZone(zone);
            date = anchor.plus({days:offset}).toISODate() ?? '';
            // The classifier can emit both an absolute search date and a
            // relative required date for the very same quoted day. Resolve
            // that shared phrase once, using its validated absolute date;
            // otherwise the search rejects its own requested calendar day.
            const search = requestUpdate.searchDay;
            if (search && meetingRequest.searchDay?.quote === search.quote
              && meetingRequest.searchDay.date === search.date
              && (search.quote.includes(quote) || quote.includes(search.quote))) {
              date = meetingRequest.searchDay.date;
            }
          }
          if (date && DateTime.fromISO(date,{zone}).toISODate() === date) meetingRequest.requiredDay = {date, zone, quote};
        }
      }
      if (refusedBooking && turnResult.refusedBookingReply === 'ask_owner') requestedException = priorRefusal;
      if (refusedBooking && turnResult.refusedBookingReply === 'continue') continuedRefusal = priorRefusal;
      exactBookingRequested = !!turnResult.exactBookingQuote && input.authority === 'colleague'
        && input.userId !== profile.user.slack_user_id && input.channel === 'slack' && !!input.typedUserMessage?.includes(turnResult.exactBookingQuote)
        && !input.extraInstruction && !input.proseOnly && !input.forceToolOnFirstTurn;
      if (isPrivateSlackDm && input.surface === 'colleague_dm' && input.authority === 'colleague'
        && turnSenderRole === 'colleague' && input.interactive !== false && !refusedBooking
        && !input.proseOnly && !input.extraInstruction && !input.forceToolOnFirstTurn && !input.images?.length
        && userMessage === input.typedUserMessage) {
        optionsReplyLocale = turnResult.optionsReplyLocale;
        singleZoneOptions = turnResult.singleZoneOptions === true;
      }
      if (requestScope && input.authority === 'colleague' && input.surface === 'colleague_dm'
        && turnSenderRole === 'colleague' && !refusedBooking && !input.forceToolOnFirstTurn && !input.images?.length
        && userMessage === input.typedUserMessage && input.userId !== profile.user.slack_user_id) {
        firmWindowBooking = !!turnResult.firmWindowQuote && turnResult.firmWindowQuote === input.typedUserMessage
          && !input.proseOnly && !input.extraInstruction;
        if (meetingRequest && !meetingRequest.batch && (exactBookingRequested || firmWindowBooking)) {
          meetingRequest.bookingInstruction ??= {kind:exactBookingRequested ? 'exact' : 'window',
            text:input.typedUserMessage!, localDate:DateTime.now().setZone(profile.user.timezone).toISODate()!};
        }
        if (turnResult.consultOwnerQuote === input.typedUserMessage && !input.proseOnly && !input.extraInstruction)
          { consultOwnerQuote = turnResult.consultOwnerQuote; consultBackground = turnResult.consultBackground; }
        existingInviteSubject = turnResult.existingInviteSubject;
        existingInviteLocale = turnResult.existingInviteLocale;
        if (turnResult.withdrawOwnRequest) {
          const { getOpenRequestsForThread } = await import('../../db/requests');
          const {canWithdrawOwnRequest} = await import('./requesterMeetingState');
          const pending = getOpenRequestsForThread(profile.user.slack_user_id,threadTs)
            .filter(row => canWithdrawOwnRequest(row,profile.user.slack_user_id,input.userId,input.channelId,threadTs,meetingRequest?.requestId));
          if (pending.length === 1) withdrawalId = pending[0].id;
        }
      }
      const fresh = turnResult.independentOrdinaryCreate;
      if (inspectIndependentOrdinaryCreate && fresh && fresh.sourceMessageIndex === meetingContextMessages.length - 1
        && input.typedUserMessage!.includes(fresh.subjectQuote) && priorProse.includes(fresh.priorSubjectQuote) && fresh.subjectQuote.trim().length > 0
        && fresh.subjectQuote.trim().normalize('NFKC').toLowerCase() !== fresh.priorSubjectQuote.trim().normalize('NFKC').toLowerCase()
        && (receipt!.startsWith("[move_meeting OK — Moved '" + fresh.priorSubjectQuote + "' to ")
          || receipt!.startsWith("[create_meeting OK — Booked '" + fresh.priorSubjectQuote + "' for "))) {
        ordinaryCreateSubject = fresh.subjectQuote;
      }
      if (boundBooking?.row.details_json && turnResult.standaloneApprovalQuote === input.typedUserMessage
        && turnResult.standaloneApprovalQuote === userMessage) {
        standaloneBookingApproval = { requestId: boundBooking.row.id,
          requestDetailsJson: boundBooking.row.details_json, quote: userMessage };
      }
      if (isPrivateSlackDm && turnResult.exactRequestClock?.quote === input.typedUserMessage
        && input.typedUserMessage === userMessage && !input.images?.length && !input.proseOnly && !input.forceToolOnFirstTurn) {
        exactRequestClock = turnResult.exactRequestClock;
      }
      if (isPrivateSlackDm && input.surface==='owner_dm' && isOwnerTyping && input.typedUserMessage===userMessage
        && !input.images?.length && !input.proseOnly && !input.forceToolOnFirstTurn && !input.extraInstruction) {
        const clock=clockReply(userMessage);
        if (clock) exactRequestClock={clock,zone:meetingRequest?.clockZone?.zone ?? profile.user.timezone,quote:userMessage};
      }
      // A positively identified standalone courtesy needs just the current human
      // message. Keep operational history, tools and prechecks out of this draft.
      if (turnResult.standaloneCourtesy === true && isPrivateSlackDm
        && input.interactive !== false && !input.extraInstruction && !input.forceToolOnFirstTurn
        && !input.images?.length && !input.extractedAttendeeEmails?.length
        && !input.proseOnly && !turnResult.approvalDecisions?.length) {
        const messages: Anthropic.MessageParam[] = [{ role: 'user', content: input.rawUserMessage ?? userMessage }];
        const systemBlocks: Anthropic.TextBlockParam[] = [{ type: 'text',
          text: `You are ${profile.assistant.name}. Reply in the sender's language. For thanks, acknowledge it naturally and let the exchange end. For a greeting, greet them back. One short sentence.` }];
        return { messages, systemBlocks, tools: [], blockedWriteTools: new Set<string>(),
          model, maxTokens, turnSenderRole, turnPersonSlackId, socialActive,
          socialClassification: turnResult.intent, resolvedMeetingAttendees, resolvedMeetingAttendeeGroups,
          contextualApprovalDecisions, meetingRequest: undefined, requestedSearchWindow: undefined, availabilityQuestionDetected: false, availabilityPrecheckToolSummaries: [] };
      }
      if (ownerDecisionPath && approvalCandidates.length && turnResult.approvalDecisions?.length) {
        const { getMatchingRequestReferences } = require('../../utils/closeLoopOnOwnerHandled') as typeof import('../../utils/closeLoopOnOwnerHandled');
        contextualApprovalDecisions = turnResult.approvalDecisions.flatMap(decision => {
          const candidate = approvalCandidates[decision.candidateIndex];
          const rawMessage = input.rawUserMessage ?? userMessage;
          if (!candidate || !rawMessage.includes(decision.instructionQuote)
            || !meetingContextMessages[decision.sourceMessageIndex]?.content.includes(decision.sourceQuote)) return [];
          if (decision.disposition !== 'amend_or_search' && turnResult.meetingAction !== 'execute') return [];
          // The existing matcher accepts any subject/name reference. A shared
          // name (e.g. Idan in two subjects) cannot distinguish candidates, but
          // must not erase a unique reference elsewhere in the same quote.
          // Use the matcher's complete references, including compound first
          // names. A reference shared by candidates cannot identify either;
          // distinct references to two candidates remain ambiguous. The
          // classifier still owns meaning and instruction/source gates.
          const referenceOwners = new Map<string, typeof approvalCandidates>();
          for (const current of approvalCandidates) {
            for (const reference of getMatchingRequestReferences(decision.sourceQuote, current.row)) {
              const owners = referenceOwners.get(reference) ?? [];
              owners.push(current);
              referenceOwners.set(reference, owners);
            }
          }
          const referencedCandidates = new Set<typeof candidate>();
          for (const owners of referenceOwners.values()) {
            if (owners.length === 1) referencedCandidates.add(owners[0]);
          }
          if (referencedCandidates.size !== 1 || !referencedCandidates.has(candidate)) return [];
          return [{ requestId: candidate.row.id, requestDetailsJson: candidate.row.details_json,
            action: candidate.action, disposition: decision.disposition, instructionQuote: decision.instructionQuote,
            sourceMessageIndex: decision.sourceMessageIndex, sourceQuote: decision.sourceQuote,
            preservesRecipients: turnResult.participantsUnchanged === true && !turnResult.participantCorrections?.length }];
        });
      }

      if (needScopes) toolScopes = turnResult.scope.scopes;
      if (turnResult.scope.source==='classifier') currentPromptScopes=turnResult.scope.scopes;
      existingStatusOnly = !!turnResult.existingStatusQuote && turnResult.existingStatusQuote === userMessage;
      if (isOwnerPath) isFreeTimeInquiry = turnResult.freeTimeInquiry === true;
      if (needMeetingPeople) {
        unresolvedHoldSelection = turnResult.unresolvedHoldSelection === true;
        const priorAssistant = [...conversationHistory].reverse().find(row=>row.role==='assistant');
        // A clock-only owner reply to an actual offer selects or replaces the
        // clock. It does not decide an absent date, widen the roster, or consent
        // to outreach. Questions and already completed bookings stay excluded.
        const ownerSelectsClock = isPrivateSlackDm && input.surface==='owner_dm' && isOwnerTyping
          && input.typedUserMessage===userMessage && /^\d{1,2}:\d{2}$/.test(userMessage.trim())
          && !!clockReply(userMessage) && !!activeRequest && !activeRequest.hasConfirmedBooking
          && turnResult.meetingContinuation===true && !input.proseOnly && !input.extraInstruction
          && !input.forceToolOnFirstTurn && !input.images?.length
          && !!priorAssistant?.toolSummaries?.some(line=>line.startsWith('[find_available_slots '));
        if(ownerSelectsClock) exactBookingRequested=true;
        meetingExplorationOnly = !ownerSelectsClock && (turnResult.meetingAction === 'explore'
          || (!turnResult.meetingAction && (!!refusedBooking || holdCandidates.length > 0)));
        if ((isOwnerPath || isPrivateSlackDm) && !ownerSelectsClock && !input.proseOnly && !input.extraInstruction && !input.forceToolOnFirstTurn)
          calendarOperations = turnResult.calendarOperations?.filter(operation => (input.typedUserMessage ?? input.rawUserMessage ?? userMessage).includes(operation.quote));
        checkRequestedHold = turnResult.meetingAction === 'hold' && !!turnResult.requestedHoldQuote
          && !turnResult.selectedHoldCandidateIndices?.length;
        if (turnResult.meetingAction === 'hold' && !checkRequestedHold) {
          holdOnlyWindows = new Map();
          const indices = turnResult.selectedHoldCandidateIndices;
          if (indices?.length && new Set(indices).size === indices.length
            && indices.every(index => Number.isInteger(index) && holdCandidates[index])) {
            for (const index of indices) {
              const slot = holdCandidates[index];
              holdOnlyWindows.set(Date.parse(slot.startIso), Date.parse(slot.endIso));
            }
          }
        }
        directorySpellings = turnResult.directorySpellings ?? [];
        const rawMeetingPeople = [...new Set([...(turnResult.meetingPeople ?? []),
          ...(meetingRequest && input.typedUserMessage ? mailboxOnlyReply(input.typedUserMessage) : [])])];
        // gh#158-a — classifyTurn is fed both THIS turn's message and up to 4
        // turns of recentContext so it can read conversational state, but its
        // own meeting_people contract promises names are "copied as written"
        // from the current message. A name that only exists in the history
        // (context bleed — this is what put "Yael Aharon" into a real invite
        // for a turn that only ever named "Levana Bagants") is an unconfirmed
        // classifier guess by the time it reaches resolvedMeetingAttendees,
        // and createMeeting.ts's union has no way to tell it from a genuine
        // ask. Gate it HERE, at the one place turnMeetingPeople is produced,
        // instead of at each of its three downstream consumers: keep a name
        // only if it is actually present in THIS turn's raw text. A
        // genuinely-named attendee is copied verbatim per the classifier's
        // own contract, so an ordinary booking is never touched — this only
        // drops a name the model could not have read off this message.
        const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
        // Slack's model-facing message also includes room rosters and transport
        // framing. Those names are context, not people named by the human.
        const normalizedMessage = normalize(input.rawUserMessage ?? (isRoom ? '' : userMessage));
        turnMeetingPeople = rawMeetingPeople.filter(
          name => typeof name === 'string' && name.trim() && normalizedMessage.includes(normalize(name)),
        );
        currentMessageMeetingPeople = [...turnMeetingPeople];
        const droppedMeetingPeople = rawMeetingPeople.filter(name => !turnMeetingPeople.includes(name));
        if (droppedMeetingPeople.length > 0) {
          logger.warn('orchestrator — meeting_people dropped, not present in this turn\'s raw message (classifier context-bleed guard)', {
            dropped: droppedMeetingPeople, kept: turnMeetingPeople, senderRole: turnSenderRole,
          });
        }
        // A separate, explicitly classified continuation may retain people
        // grounded in an indexed human request. Never relax the current-name
        // guard above or accept an assistant-invented/historical union roster.
        if (isPrivateSlackDm && turnResult.meetingContinuation === true
          && (!activeRequest || turnResult.requestUpdate?.relation === 'continue')) {
          const contextual = (turnResult.contextMeetingPeople ?? []).filter(entry => {
            if (!Number.isInteger(entry.sourceMessageIndex) || typeof entry.name !== 'string' || !entry.name.trim()) return false;
            const source = meetingContextMessages[entry.sourceMessageIndex];
            return source?.role === 'user' && normalize(source.content).includes(normalize(entry.name));
          }).map(entry => entry.name.trim());
          turnMeetingPeople = [...new Set([...turnMeetingPeople, ...contextual])];
        }
        // Grouping never grants membership. Reuse the current-message and
        // private-history provenance gates above; incomplete partitions remain
        // explicitly ambiguous rather than silently dropping a known person.
        const priorGroups = meetingRequest?.participantGroups;
        const bindings=new Map((meetingRequest?.participantBindings ?? []).map(binding=>[normalize(binding.name),binding]));
        const currentMailboxes = new Set(currentMessageMeetingPeople.map(participantMailbox).filter(Boolean));
        // Slack encodes a supplied address separately from its adjacent name.
        // The classifier may use the full identifier in membership and only
        // its label in groups. Bind that literal label before partition checks;
        // a unique human-supplied destination outranks a directory namesake.
        const labelledMailboxes = new Map<string,Array<{name:string;identifier:string;quote:string}>>();
        for (const literal of currentMessageMeetingPeople) {
          const at=literal.toLowerCase().indexOf('<mailto:');
          const email=participantMailbox(literal);
          let name=at>0?literal.slice(0,at).trim():'';
          // Presentation separators carry no identity. Keep the literal label
          // while allowing the roster extractor to omit a trailing dash/colon.
          while (name && '-:–—'.includes(name.at(-1)!)) name=name.slice(0,-1).trimEnd();
          if (!name || !email || !literal.endsWith('>')) continue;
          const key=normalize(name),items=labelledMailboxes.get(key) ?? [];
          items.push({name,identifier:email,quote:literal});labelledMailboxes.set(key,items);
        }
        for (const [key,items] of labelledMailboxes) {
          if (new Set(items.map(item=>item.identifier)).size===1) bindings.set(key,items[0]);
          else bindings.delete(key);
        }
        if (meetingRequest && requestUpdate?.relation==='continue' && turnResult.selfParticipant && input.surface==='colleague_dm'
          && input.authority==='colleague' && input.userId!==profile.user.slack_user_id && input.typedUserMessage?.includes(turnResult.selfParticipant.quote)
          && !mailboxOnlyReply(turnResult.selfParticipant.quote).length
          && priorGroups?.some(group=>group.includes(turnResult.selfParticipant!.name))) {
          const self=turnResult.selfParticipant;
          bindings.set(normalize(self.name),{name:self.name,identifier:'<@'+input.userId+'>',quote:self.quote});
        }
        if (meetingRequest) for (const correction of turnResult.participantCorrections ?? []) {
          if (!input.typedUserMessage?.includes(correction.quote) || !correction.quote.includes(correction.to)) continue;
          const namedQuote=normalize(correction.quote.replace(/<mailto:[^>]+>/gi,' ')
            .replace(/[A-Z0-9.!#$%&'*+/=?^_`{}|~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi,' '));
          const currentNamedBinding=currentMessageMeetingPeople.some(name=>normalize(name)===normalize(correction.from))
            && turnResult.meetingPeopleGroups?.[correction.group]?.includes(correction.from)
            && namedQuote.includes(normalize(correction.from));
          if(!currentNamedBinding && !(requestUpdate?.relation==='continue' && priorGroups?.[correction.group]?.includes(correction.from))) continue;
          // Several anonymous mailboxes do not establish a name-to-address
          // mapping. In particular, two answers cannot be assigned to the
          // last two names Maelle happened to ask about when an earlier human
          // asked about different people. Keep those addresses unresolved
          // until their labels are supplied; a single requested address and
          // explicitly labelled multi-address corrections remain usable.
          if (currentMailboxes.size > 1 && participantMailbox(correction.to)
            && !namedQuote.includes(normalize(correction.from))
            && !(turnResult.directorySpellings ?? []).some(item=>normalize(item.name)===normalize(correction.from)
              && namedQuote.includes(normalize(item.spelling)))) continue;
          for (const [key,binding] of bindings) if(normalize(binding.identifier)===normalize(correction.from))
            bindings.set(key,{...binding,identifier:correction.to,quote:correction.quote});
          bindings.set(normalize(correction.from),{name:correction.from,identifier:correction.to,quote:correction.quote});
        }
        // A literal participant mailbox is established even before its name
        // or appointment is known. Retain it in the existing binding map so a
        // later acknowledgement cannot silently restore a directory namesake.
        for (const literal of currentMessageMeetingPeople) {
          const email=participantMailbox(literal);
          if (email && input.typedUserMessage?.includes(literal)
            && ![...bindings.values()].some(binding=>participantMailbox(binding.identifier)===email)) {
            bindings.set(normalize(email),{name:email,identifier:email,quote:literal});
          }
        }
        const canonicalParticipant=(name:string)=>{
          const identifier=bindings.get(normalize(name))?.identifier ?? name;
          return participantIdentifier(identifier);
        };
        turnMeetingPeople=[...new Set(turnMeetingPeople.map(canonicalParticipant))];
        if (Array.isArray(turnResult.meetingPeopleGroups)) {
          const {nameGenuinelyMatches} = require('../../memory/resolveAttendeeEmails') as typeof import('../../memory/resolveAttendeeEmails');
          // The calendar owner is implicit in every appointment. His spelling
          // cannot invalidate another person's roster or create a solo group.
          const ownerName = (name:string) => name.toLowerCase() === profile.user.email.toLowerCase()
            || name === '<@'+profile.user.slack_user_id+'>'
            || nameGenuinelyMatches(profile.user.name,profile.user.email,name)
            || (!!profile.user.name_he && nameGenuinelyMatches(profile.user.name_he,undefined,name));
          const accepted = new Set(turnMeetingPeople.filter(name=>!ownerName(name)).map(normalize));
          // Stored members already passed provenance checks on earlier turns.
          // They need not be re-extracted from a truncated recent transcript.
          const allowed=new Set([...accepted,...(requestUpdate?.relation==='continue' ? priorGroups?.flat() ?? [] : [])
            .map(canonicalParticipant).filter(name=>!ownerName(name)).map(normalize)]);
          const mentions = turnMeetingPeople.filter(name=>name.startsWith('<@')).flatMap(name=>{
            const {resolveNamedInternalAttendees} = require('../../memory/resolveAttendeeEmails') as typeof import('../../memory/resolveAttendeeEmails');
            const person = resolveNamedInternalAttendees({names:[name],ownerEmail:profile.user.email}).resolved[0];
            return person ? [{literal:name,person}] : [];
          });
          const groupName = (name:string):string[] => {
            name=canonicalParticipant(name);
            if (ownerName(name)) return [];
            if (allowed.has(normalize(name))) return [name];
            const candidates = mentions.filter(({literal,person})=>name === literal.slice(2,-1)
              || nameGenuinelyMatches(person.name,person.email,name));
            return candidates.length === 1 ? [candidates[0].literal] : [];
          };
          const groups = turnResult.meetingPeopleGroups.map(group => [...new Set(
            group.flatMap(groupName),
          )]).filter(group => group.length > 0);
          const covered = new Set(groups.flat().map(normalize));
          meetingPeopleGroups = [...accepted].every(name => covered.has(name))
            ? groups.length ? groups : accepted.size === 0 && turnResult.meetingPeopleGroups.length === 1 ? [[]] : []
            : [];
        }
        const correctedGroups = priorGroups?.map(group=>group.map(canonicalParticipant));
        // Commit each source-validated identity correction independently of
        // the complete new partition. An additional unassigned address can
        // keep this turn ambiguous, but cannot erase a correction already
        // established for another participant in the same human message.
        if (meetingRequest && requestUpdate?.relation==='continue' && correctedGroups?.length) {
          meetingRequest.participantGroups=correctedGroups;
          const members=new Set(correctedGroups.flat().map(normalize));
          meetingRequest.participantBindings=[...bindings.values()].filter(binding=>members.has(normalize(canonicalParticipant(binding.name))));
          meetingRequest.optionalParticipants=meetingRequest.optionalParticipants?.map(canonicalParticipant);
        }
        if (meetingRequest && !turnResult.confirmedAppointmentGroups && turnResult.meetingContinuation && requestUpdate?.relation==='continue' && correctedGroups?.length
          && (turnResult.participantsUnchanged || (turnResult.participantCorrections?.length
            && currentMessageMeetingPeople.every(name=>[...priorGroups!.flat(),...correctedGroups.flat()].some(member=>normalize(member)===normalize(name)))))) {
          // The same meeting retains its human-specified membership. Explicit
          // quoted corrections replace that member in its own stored group.
          meetingPeopleGroups = correctedGroups;
          turnMeetingPeople = [...new Set(meetingPeopleGroups.flat())];
        }
        if (meetingRequest?.batch && !turnResult.confirmedAppointmentGroups && requestUpdate?.relation==='continue' && correctedGroups && correctedGroups.length>1 && meetingPeopleGroups?.length) {
          // A short reply can focus on one appointment in a batch without
          // removing the others. Update only the uniquely identified group;
          // a proposed union of distinct rosters remains ambiguous.
          const counts=new Map<string,number>();
          for(const group of correctedGroups) for(const name of new Set(group.map(normalize))) counts.set(name,(counts.get(name)??0)+1);
          const merged=correctedGroups.map(group=>[...group]);
          let ambiguous=false;
          for(const group of meetingPeopleGroups) {
            const anchors=group.map(normalize).filter(name=>counts.get(name)===1);
            const matches=correctedGroups.flatMap((prior,index)=>anchors.some(name=>prior.map(normalize).includes(name))?[index]:[]);
            if(matches.length!==1){ambiguous=true;break;}
            merged[matches[0]]=group;
          }
          meetingPeopleGroups=ambiguous?[]:merged;
        }
        const assignedNames=new Set((meetingPeopleGroups?.length ? meetingPeopleGroups : correctedGroups ?? []).flat().map(canonicalParticipant).map(normalize));
        const unassignedMailboxes=[...bindings.values()].filter(binding=>binding.name===binding.identifier
          && !!participantMailbox(binding.identifier) && !assignedNames.has(normalize(binding.identifier)));
        if (meetingRequest && unassignedMailboxes.length) {
          meetingPeopleGroups=[];
          turnMeetingPeople=[...new Set([...turnMeetingPeople,...(correctedGroups?.flat() ?? []),...unassignedMailboxes.map(binding=>binding.identifier)])];
          const retained=new Map((meetingRequest.participantBindings ?? []).map(binding=>[normalize(binding.name),binding]));
          for(const binding of unassignedMailboxes)retained.set(normalize(binding.name),binding);
          meetingRequest.participantBindings=[...retained.values()];
        }
        if (meetingRequest && meetingPeopleGroups?.length) {
          if (meetingPeopleGroups.length>1 && !meetingRequest.batch) {
            meetingRequest.batch=true;
            meetingRequest.requiredDay=undefined;meetingRequest.searchDay=undefined;meetingRequest.duration=undefined;
            meetingRequest.clockZone=undefined;meetingRequest.bookingInstruction=undefined;meetingRequest.existingMeeting=undefined;
            meetingRequest.requesterPair=false;
          }
          meetingRequest.participantGroups = meetingPeopleGroups.map(group=>[...group]);
          meetingRequest.participantBindings=[...bindings.values()].filter(binding=>meetingPeopleGroups!.flat()
            .some(name=>normalize(name)===normalize(binding.identifier)));
          const optional=new Set((meetingRequest.optionalParticipants ?? []).map(canonicalParticipant));
          for (const role of turnResult.participantRoles ?? []) {
            const name=canonicalParticipant(role.name);
            if (!meetingPeopleGroups.flat().includes(name) || !input.typedUserMessage?.includes(role.quote) || !role.quote.includes(role.name)) continue;
            if (role.role==='optional') optional.add(name);else optional.delete(name);
          }
          meetingRequest.optionalParticipants=[...optional].filter(name=>meetingPeopleGroups!.flat().includes(name));
          turnMeetingPeople=[...new Set(meetingPeopleGroups.flat())];
          const spellings = new Map((meetingRequest.directorySpellings ?? []).map(item=>[item.name,item]));
          for (const item of directorySpellings) spellings.set(item.name,item);
          directorySpellings = [...spellings.values()].filter(item=>turnMeetingPeople.includes(item.name));
          meetingRequest.directorySpellings = directorySpellings;
        }
      }
      // v3.x (Block 3 — calendar prose lazy-load). A free-time / buffer / "how
      // packed" question needs the calendar-health guidance. Deterministically
      // union the 'calendar' scope so that prose loads even if the classifier
      // tagged the turn 'meetings'-only. (No-op when scopes already widened to
      // 'general'.) The tools themselves live in 'meetings' and ship regardless.
      if (isFreeTimeInquiry && toolScopes && !toolScopes.includes('calendar') && !toolScopes.includes('general')) {
        toolScopes = [...toolScopes, 'calendar'];
      }

      if (needIntent) {
        socialClassification = turnResult.intent;
        // gh#198-LIB-6 (answer 19) — persist the per-turn kind so the
        // end-of-chat reconciler (capturePass.ts) has a deterministic
        // code-side signal for whether THIS thread ever had a social turn,
        // rather than trusting its own prompt alone to keep work out of
        // social_subjects. Reuses classifyTurn's existing kind — no new
        // LLM call, no keyword blocklist. Only stamps on 'social'; 'task'/
        // 'other' turns leave the thread's row as-is (a thread needs the OR
        // of every turn it ever saw, never a downgrade from one task-shaped
        // message in an otherwise social thread).
        if (threadTs && socialClassification.kind === 'social') {
          try {
            markThreadHadSocialTurn(threadTs);
          } catch (err) {
            logger.warn('markThreadHadSocialTurn threw — non-fatal', { threadTs, err: String(err).slice(0, 200) });
          }
        }
        // v3.0 follow-up — subject decisions + engagement signals + topic-beat
        // recording moved to end-of-chat (`runSubjectReconciliation` in
        // src/memory/capturePass.ts). Per-turn classifier still produces
        // kind/category/sentiment/direction/topic_label which drive the
        // social directive (engage/celebrate/etc.) for THIS turn — no
        // subject-row writes happen per turn anymore.
        //
        // gh#179-c / coda-repeats-and-merges-with-action-confirmations — an
        // approval-outcome relay (PENDING APPROVALS / WORK ALREADY IN FLIGHT /
        // STATUS OF THE REQUEST IN THIS THREAD, systemPrompt.ts) is computed
        // independently of `classification` straight from the requests spine,
        // so a turn the classifier reads as social/other can still land a
        // relay Sonnet must deliver — and it was free-composing both into one
        // reply (Yael, 2026-08-03). Mirrors systemPrompt.ts's own gating
        // exactly (isOwnerTyping decides owner- vs colleague-shaped state) so
        // this is provably the same signal, not a new heuristic.
        //
        // bouncer overturn 2026-08-10 — the owner branch used to be
        // `getAwaitingOwnerRequests(...).length > 0` with NO thread scoping:
        // as long as ANY approval sat awaiting_owner ANYWHERE, celebrate/
        // engage/raise_new/continue went dark on every owner turn in every
        // thread, for as long as that approval stayed open (days). Narrowed to
        // the SAME thread-bound test systemPrompt.ts's pendingApprovalsSection
        // already uses to decide a bare "yes" is answering THIS approval
        // (terminal_dm_msg_ts / owner_dm_thread_ts === threadTs) — so
        // suppression now tracks the one thread that could actually be
        // relaying/confirming a pending approval, not the owner's whole
        // pending queue.
        let hasOperationalRelay = false;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getAwaitingOwnerRequests, getOpenRequestsForThread, getUnrelayedTerminalRequestForThread } =
            require('../../db/requests') as typeof import('../../db/requests');
          if (isOwnerTyping) {
            hasOperationalRelay = getAwaitingOwnerRequests(profile.user.slack_user_id).some(
              r => r.terminal_dm_msg_ts === threadTs || r.owner_dm_thread_ts === threadTs,
            );
          } else if (threadTs) {
            const openInThread = getOpenRequestsForThread(profile.user.slack_user_id, threadTs)
              .filter(r => r.state === 'awaiting_owner' || r.state === 'awaiting_colleague');
            // Same selection systemPrompt.ts's threadRequestStatusSection renders
            // from, so the coda is suppressed exactly when that section ships.
            const terminalUnrelayed = !!getUnrelayedTerminalRequestForThread(profile.user.slack_user_id, threadTs);
            hasOperationalRelay = openInThread.length > 0 || terminalUnrelayed;
          }
        } catch (err) {
          logger.warn('operational-relay check threw — continuing without it (social directive not suppressed)', {
            err: String(err).slice(0, 200),
          });
        }
        socialDirective = chooseSocialDirective({
          personSlackId: turnPersonSlackId,
          classification: socialClassification,
          ownerUserId: profile.user.slack_user_id,
          ownerTimezone: profile.user.timezone,
          hasOperationalRelay,
        });
        // The in-prompt directive (continue/celebrate/engage) never stamps a
        // raise — it is a rendered suggestion Sonnet may or may not act on,
        // and there is no way to detect from here whether it survived into
        // the actual reply. Only a confirmed-delivered coda increments the
        // raise counter, via recordCodaDelivered → markSubjectRaised
        // (core/social/logEngagement.ts, gated on postReply.ts's delivery
        // confirmation). Removed 2026-08-15 (gh#198): the old stamp here
        // fired the moment `continue` was chosen, before Sonnet had written
        // anything, so a directive that never made it into the reply (or
        // whose surrounding message never posted) still burned the person's
        // raise and parked the subject for the 72h re-raise defer.
      }
    } catch (err) {
      logger.warn('classifyTurn pre-pass threw — continuing without directive / scopes', { err: String(err).slice(0, 300) });
      socialDirective = noDirective();
      socialClassification = null;
      toolScopes = undefined;  // → getSkillTools ships all tools (safe widen)
    }
  }

  // v3.6.4 — DETERMINISTIC attendee resolution (the "resolve WHO before WHEN"
  // guarantee, moved from a prompt rule Sonnet ignored into code). Resolve the
  // current or provenance-checked continuing participants into KNOWN INTERNAL colleagues
  // (single unambiguous people_memory match — never fuzzy-guessed). The
  // stored resolved set is (a) threaded into the search via skillContext so
  // find_available_slots can't run a partial list, and (b) surfaced to Sonnet as
  // a resolved-participants block so she searches instead of asking who they are
  // / for an email she already has. Explicit human mailboxes are preserved;
  // unresolved names never block showing owner-side options. Their email is
  // needed at booking. Unresolved names get the existing scoped directory lookup;
  // its contact evidence does not decide required/optional participation.
  // Lookup errors remain unresolved; Sonnet's normal flow takes over.
  if (turnMeetingPeople.length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolveNamedInternalAttendees, nameGenuinelyMatches } = require('../../memory/resolveAttendeeEmails') as
        typeof import('../../memory/resolveAttendeeEmails');
      const resolveParticipants=(names:string[])=>{
        const mailboxes=[...new Set(names.map(participantMailbox).filter((email):email is string=>!!email
          && email!==profile.user.email.toLowerCase()))];
        const result=resolveNamedInternalAttendees({names:names.filter(name=>!participantMailbox(name)),
          ownerEmail:profile.user.email,ownerName:profile.user.name,ownerLocalName:profile.user.name_he});
        return {resolved:[...result.resolved,...mailboxes.filter(email=>!result.resolved.some(p=>p.email===email))
          .map(email=>({name:email,email}))],unresolved:result.unresolved};
      };
      const { resolved, unresolved } = resolveParticipants(turnMeetingPeople);
      resolvedMeetingAttendees = resolved.map(r => r.email);
      resolvedOptionalAttendees=resolveParticipants(meetingRequest?.optionalParticipants ?? []).resolved.map(person=>person.email);
      if (meetingPeopleGroups !== undefined) {
        // Resolution may return a canonical display name. Resolve group names
        // with the same deterministic resolver rather than guessing identity.
        resolvedMeetingAttendeeGroups = meetingPeopleGroups.map(names => {
          const group = resolveParticipants(names);
          // An unresolved participant still belongs to this meeting. Dropping
          // an external-only group turns a different meeting into the sole
          // roster and wrongly invites/checks its internal colleagues.
          return { emails: group.resolved.map(person => person.email), unresolvedNames: [...group.unresolved] };
        });
        const covered = new Set(resolvedMeetingAttendeeGroups.flatMap(group => group.emails).map(email => email.toLowerCase()));
        if (!resolvedMeetingAttendees.every(email => covered.has(email.toLowerCase()))) resolvedMeetingAttendeeGroups = [];
      }
      const group = resolvedMeetingAttendeeGroups?.length === 1 ? resolvedMeetingAttendeeGroups[0] : undefined;
      if (ordinaryCreateSubject && group && !group.unresolvedNames.length && group.emails.length > 0
        && currentMessageMeetingPeople.length === turnMeetingPeople.length && unresolved.length === 0
        && resolved.length === currentMessageMeetingPeople.length) {
        // A literal Slack mention identifies a person even though the classifier
        // sees a display name. Reconcile the literal IDs, not transport framing.
        const typed = input.typedUserMessage!;
        const mentions = [...new Set([...typed.matchAll(/<@([A-Z0-9]+)>/g)].map(m => m[1]))];
        const { resolveAttendeeEmail } = require('../../memory/resolveAttendeeEmails') as typeof import('../../memory/resolveAttendeeEmails');
        const mentioned = mentions.filter(id => id !== profile.user.slack_user_id).map(slack_id => resolveAttendeeEmail({ slack_id }).email);
        const emails = new Set(group.emails.map(email => email.toLowerCase()));
        const complete = mentioned.every(email => emails.has(email)) && resolved.every(person =>
          mentioned.includes(person.email) || typed.toLowerCase().includes(person.name.toLowerCase()));
        if (complete) ordinaryCreateAfterOtherMeeting = { subject: ordinaryCreateSubject, attendeeEmails: [...emails].sort() };
      }
      // Continuation participants constrain the meeting search, but do not
      // turn an owner-calendar question into a current named-person question.
      namedInternalAttendeeEmails = turnMeetingPeople.length === currentMessageMeetingPeople.length
        ? resolvedMeetingAttendees
        : resolveNamedInternalAttendees({
          names: currentMessageMeetingPeople,
          ownerEmail: profile.user.email,
          ownerName: profile.user.name,
            ownerLocalName:profile.user.name_he,
        }).resolved.map(r => r.email);
      // Memory ambiguity is not current directory ambiguity. Use the existing
      // surface-scoped lookup before asking the human for a known identity.
      // Identity alone does not establish required participation: these contacts
      // are context, never automatically added to required availability.
      const directoryContacts: Array<{ name: string; email: string }> = [];
      const directoryStates: Array<{ name: string; status: string; names?:string[] }> = [];
      if (unresolved.length > 0) {
        const { getConnection } = require('../../connections/registry') as typeof import('../../connections/registry');
        const connection = getConnection(profile.user.slack_user_id, 'slack');
        for (const name of [...new Set(unresolved)]) {
          try {
            const response = await connection?.executeToolCall?.('find_slack_user', { name }, { surface: input.surface });
            const result = response as { error?: unknown; matches?: Array<{ name?: string; email?: string }> } | null;
            if (!result || result.error || !Array.isArray(result.matches)) {
              directoryStates.push({ name, status: 'directory_unavailable' });
              continue;
            }
            const domain = profile.user.email.toLowerCase().split('@')[1];
            let matches = result.matches.filter(m => typeof m?.email === 'string' && typeof m.name === 'string'
              && m.email.toLowerCase().endsWith('@' + domain)
              && nameGenuinelyMatches(m.name, m.email, name));
            const spelling = directorySpellings.find(item => item.name === name)?.spelling;
            if (!matches.length && spelling) {
              const lookup = await connection?.executeToolCall?.('find_slack_user', {name:spelling}, {surface:input.surface}) as typeof result;
              matches = lookup?.matches?.filter(person => typeof person.name === 'string' && typeof person.email === 'string'
                && person.email.toLowerCase().endsWith('@' + domain) && nameGenuinelyMatches(person.name,person.email,spelling)) ?? [];
            }
            const distinct = new Map(matches.map(m => [m.email!.toLowerCase(), { name: m.name!, email: m.email!.toLowerCase() }]));
            if (distinct.size === 1) {
              const contact = [...distinct.values()][0];
              directoryContacts.push(contact);
              if (meetingRequest?.optionalParticipants?.includes(name)) resolvedOptionalAttendees.push(contact.email);
              // The directory establishes identity. Only a name already in a
              // specific meeting roster establishes required participation.
              for (const roster of resolvedMeetingAttendeeGroups ?? []) {
                if (!roster.unresolvedNames.includes(name)) continue;
                roster.unresolvedNames = roster.unresolvedNames.filter(member => member !== name);
                if (!roster.emails.includes(contact.email)) roster.emails.push(contact.email);
                if (!resolvedMeetingAttendees.includes(contact.email)) resolvedMeetingAttendees.push(contact.email);
              }
              unresolved.splice(unresolved.indexOf(name), 1);
            } else {
              directoryStates.push({name,status:distinct.size > 1 ? 'multiple_internal_matches' : 'no_scoped_internal_contact',
                ...(distinct.size > 1 ? {names:[...distinct.values()].map(contact=>contact.name)} : {})});
            }
          } catch {
            directoryStates.push({ name, status: 'directory_unavailable' });
          }
        }
      }
      if (meetingRequest && resolvedMeetingAttendeeGroups && resolvedMeetingAttendeeGroups.length > 0) {
        const singles = resolvedMeetingAttendeeGroups.flatMap(group => group.emails.length === 1 && !group.unresolvedNames.length ? group.emails : []);
        meetingRequest.individualSearchEmails = [...new Set(singles.map(email => email.toLowerCase()))];
      }
      if (resolved.length > 0 || unresolved.length > 0 || directoryContacts.length > 0) {
        const ownerFirst = profile.user.name.split(' ')[0];
        const sections: string[] = ['## MEETING PARTICIPANTS (deterministic — use this, do not re-derive)'];
        if (meetingRequest?.participantBindings?.length) sections.push('Human-supplied participant identities for this request (retain these corrections): '+JSON.stringify(meetingRequest.participantBindings));
        const assigned=new Set(meetingRequest?.participantGroups?.flat().map(name=>name.toLowerCase()) ?? []);
        const unassigned=meetingRequest?.participantBindings?.filter(binding=>binding.name===binding.identifier
          && !!participantMailbox(binding.identifier) && !assigned.has(binding.identifier.toLowerCase()));
        if (unassigned?.length) sections.push('Supplied participant addresses still awaiting assignment to a person or appointment: '
          +unassigned.map(binding=>binding.identifier).join(', ')+'. Keep the known corrections. Clarify only this remaining mapping before sending an invitation; a directory namesake does not resolve it.');
        if (meetingRequest?.optionalParticipants?.length) sections.push('Optional invitees (include in the invitation, but they need not be free): '+JSON.stringify(meetingRequest.optionalParticipants));
        if (directoryContacts.length > 0) {
          sections.push(`Current directory contact identities (not added to required availability; retain the participation role requested in the current message):\n${directoryContacts.map(r => `- ${r.name} <${r.email}>`).join('\n')}`);
        }
        if (directoryStates.length > 0) sections.push(`Current directory lookup outcomes: ${JSON.stringify(directoryStates)}`);
        if (resolved.length > 0) {
          const list = resolved.map(r => `- ${r.name} <${r.email}>`).join('\n');
          sections.push(`Participant identities from the directory or the human's explicit mailbox — use these addresses without another name lookup or email question. A supplied external inbox need not match a directory namesake. Use each requested meeting's own participants when searching or booking; these identities are not a combined roster for separate meetings:\n${list}`);
        }
        if (unresolved.length > 0) {
          // The external-vs-unknown JUDGMENT stays with the model (owner rule);
          // code only enforces the invariant: never withhold ${ownerFirst}'s
          // times, never demand an email just to search. This is the "Yael asks
          // for dates, then checks with the external candidate later" flow.
          sections.push(`Named, but NOT matched to an internal colleague: ${unresolved.join(', ')}. Do NOT demand an email or withhold times for these. If external (candidate / another company / personal domain) — search ${ownerFirst}'s side and show his open times NOW; you only need their email at BOOKING, to send the invite (never up front). If instead it's an internal person you don't recognize, you may ask "who is <name>?" — but never ask for an email you'd only use to send an invite.`);
        }
        resolvedAttendeesBlock = sections.join('\n\n');
        logger.info('orchestrator — attendee pre-resolution', {
          named: turnMeetingPeople,
          resolved: resolvedMeetingAttendees,
          unresolved,
          senderRole: turnSenderRole,
        });
      }
    } catch (err) {
      logger.warn('orchestrator — attendee pre-resolution threw, continuing', { err: String(err).slice(0, 200) });
    }
  }

  // v4.3.0 (#24 rows 132/133/137 — owner ruling: "the only gap is second
  // participant -> please resolve and use the same format") — union in
  // attendee addresses a TRANSPORT's own inbound extraction already resolved
  // this turn (input.extractedAttendeeEmails). This is the SAME
  // resolvedMeetingAttendees list the block above populates from NAMED
  // internal colleagues — one authoritative route, two contributors — so
  // find_available_slots / create_meeting's existing union logic picks these
  // up completely unchanged, unaware of which channel supplied them. Slack
  // never sets this field (its own named-colleague resolution above already
  // covers it), so this is a no-op there. The email connector sets it from
  // connectors/email/extractParticipants.ts's forwarded-header extraction,
  // which resolves genuine EXTERNAL addresses no internal-name lookup could
  // ever produce (an external is never in people_memory under the owner's
  // own domain) — that gap is what rows 132/133/137 were.
  const extractedExternalAttendees = (input.extractedAttendeeEmails ?? [])
    .map(e => (e ?? '').trim().toLowerCase())
    .filter(e => e.includes('@') && e !== profile.user.email.trim().toLowerCase());
  if (extractedExternalAttendees.length > 0) {
    const existingLower = new Set(resolvedMeetingAttendees.map(e => e.toLowerCase()));
    const added = extractedExternalAttendees.filter(e => !existingLower.has(e));
    if (added.length > 0) {
      resolvedMeetingAttendees = [...resolvedMeetingAttendees, ...added];
      resolvedAttendeesBlock = [
        resolvedAttendeesBlock,
        `Participant address(es) extracted from the forwarded email header — do NOT ask for these again; preserve their participation in the relevant meeting: ${added.join(', ')}`,
      ].filter(Boolean).join('\n\n');
      logger.info('orchestrator — email header attendee extraction merged into resolvedMeetingAttendees', {
        added, finalResolved: resolvedMeetingAttendees, senderRole: turnSenderRole,
      });
    }
    // Headers do not identify which of several meetings an address belongs to.
    // Keep their protection for a single group; leave multi-group input
    // ambiguous until a caller supplies a complete meeting-specific roster.
    if (resolvedMeetingAttendeeGroups !== undefined) {
      resolvedMeetingAttendeeGroups = resolvedMeetingAttendeeGroups.length === 1
        ? [{ ...resolvedMeetingAttendeeGroups[0], emails: [...new Set([...resolvedMeetingAttendeeGroups[0].emails, ...extractedExternalAttendees])] }] : [];
    }
  }

  // Build the current turn. When images are attached (v1.7.1), the user
  // message becomes a content array `[image, ..., text]` so Sonnet sees the
  // actual pixels — much higher fidelity than a pre-described summary.
  const hasImages = !!input.images && input.images.length > 0;
  const currentTurn: Anthropic.MessageParam = hasImages
    ? {
        role: 'user',
        content: [
          ...(input.images as Anthropic.ImageBlockParam[]),
          { type: 'text', text: effectiveUserMessage },
        ],
      }
    : { role: 'user', content: effectiveUserMessage };

  if (hasImages) {
    logger.info('Orchestrator user message includes images', {
      threadTs,
      imageCount: input.images!.length,
      captionPreview: effectiveUserMessage.slice(0, 80),
    });
  }

  // Build message list, then trim history to stay within token budget.
  // The current user message is always kept; older history is pruned by character count.
  // Carry earlier human details across the history window once, in their
  // original position before recent turns. Repeating old requests directly
  // beside the latest reply makes them look like fresh instructions.
  const messages: Anthropic.MessageParam[] = trimHistory([
    ...conversationHistory.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.role === 'user'
        ? stampHistoryTime(m.content, m.ts, profile.user.timezone)
        : m.content,
    })),
    currentTurn,
  ]);
  if (meetingRequest?.updates.length) {
    const retained = messages.slice(0,-1).filter(row => row.role === 'user' && typeof row.content === 'string').map(row => row.content as string);
    const earlier = [meetingRequest.original, ...meetingRequest.updates.slice(0,-1)].filter(text => !retained.some(turn => turn.endsWith(text)));
    if (earlier.length) {
      messages.unshift({role:'user',content:'Earlier details for this same request, in chronological order. These are history, not a new instruction: ' + JSON.stringify(earlier)});
    }
  }

  // Build system prompt in two parts for prompt caching:
  //   static  → skills rules (large, profile-driven) — cached for 5 min
  //   dynamic → date/time, prefs, people memory, auth — uncached
  // v1.6.14 — focus contacts: MPIM participants get their FULL memory loaded
  // into the prompt; everyone else gets the 10-entry tail. In 1:1 DMs or
  // channels there are no focus contacts, so the whole list is capped at 10.
  const focusSlackIds = input.isMpim && input.mpimMemberIds
    ? new Set(input.mpimMemberIds.filter(id => id !== profile.user.slack_user_id))
    : undefined;
  const promptParts = buildSystemPromptParts(profile, input.senderRole, input.senderName, input.isOwnerInGroup, focusSlackIds, input.isMpim, input.isChannel, input.threadTs, input.userId, input.mpimMemberIds, currentPromptScopes ?? toolScopes, input.channel, input.authority, input.threadParticipantIds);

  // Inject active jobs for this thread so Maelle knows what she already committed to.
  // This prevents her from treating follow-up messages as new requests.
  let threadContextBlock = '';
  if (isOwnerPath && threadTs) {
    const { tasks, outreachJobs } = getActiveJobsForThread(
      profile.user.slack_user_id,
      threadTs,
    );

    const lines: string[] = [];

    for (const job of outreachJobs) {
      // v2.3.6 (#69a) — surface colleague reply_text into the thread block.
      // The reply was captured to the outreach_jobs row by the inbound
      // pipeline, but the prompt-rendering only showed the OUTGOING message.
      // That left Sonnet narrating "no reply yet" while the reply was
      // already in the DB. Now: if reply_text is populated, status reads
      // "replied" and the reply preview is included alongside the original
      // message — Sonnet can see the back-and-forth in one block.
      const hasReply = typeof job.reply_text === 'string' && job.reply_text.trim().length > 0;
      // v3.1 (Path 2 Stage 7) — outreach status reads off the linked request.
      const oLc = getOutreachLifecycle(job.id);
      const status = oLc.phase === 'outreach:scheduled' && job.scheduled_at
        ? `scheduled — message goes out ${DateTime.fromISO(job.scheduled_at).setZone(profile.user.timezone).toFormat('EEEE d MMM')}`
        : hasReply
        ? `replied`
        : oLc.requestState === 'awaiting_colleague'
        ? `sent, waiting for reply`
        : (oLc.requestState ?? 'in flight');
      const sentPreview = job.message ? `: "${job.message.slice(0, 80)}${job.message.length > 80 ? '…' : ''}"` : '';
      const replyPreview = hasReply
        ? `\n   ↳ reply: "${job.reply_text!.slice(0, 200)}${job.reply_text!.length > 200 ? '…' : ''}"`
        : '';
      lines.push(`• Outreach to ${job.colleague_name} — ${status}${sentPreview}${replyPreview}`);
    }

    for (const task of tasks) {
      if (!outreachJobs.some(j => j.id === task.skill_ref)) {
        lines.push(`• Task: "${task.title}" — ${task.status}`);
      }
    }

    // v1.7.2 — Summary session (one per thread). When present + iterating,
    // tell Sonnet explicitly so it routes owner replies through the
    // classify_summary_feedback tool rather than treating them as new requests.
    const summarySession = getSummarySessionByThread(threadTs);
    if (summarySession && summarySession.stage === 'iterating') {
      const subject = summarySession.meeting_subject ?? '(untitled)';
      lines.push(`• Summary session: "${subject}" — drafting/iterating. ANY reply from ${profile.user.name.split(' ')[0]} in this thread is feedback on the summary — call classify_summary_feedback first to route correctly (style rule / draft edit / share intent).`);
    } else if (summarySession && summarySession.stage === 'shared') {
      const subject = summarySession.meeting_subject ?? '(untitled)';
      const shared = summarySession.shared_at ? ` (shared ${summarySession.shared_at})` : '';
      lines.push(`• Summary session: "${subject}" — already shared${shared}. Draft text is no longer available; only the meta (subject/attendees/date) remains. If asked, recall what you can from the meta.`);
    }

    if (lines.length > 0) {
      threadContextBlock = `\n\nACTIVE IN THIS THREAD — you already committed to these:\n${lines.join('\n')}\nDo NOT re-ask for confirmation. If asked about status, report it. If asked to do something already in progress, say it's already scheduled/underway.`;
    }
  }

  // v2.2.5 — Action tape: pin the mutation tool calls Maelle made earlier in
  // this thread so she can't narrate her own actions as discoveries one turn
  // later. Replaces the rotting RULE 2e prompt rule. Owner-only (colleagues
  // don't see Maelle's action history) and only when threadTs is present.
  let actionTapeBlock = '';
  if (isOwnerPath && threadTs) {
    const tape = extractActionTape(input.conversationHistory);
    if (tape.length > 0) {
      actionTapeBlock = `\n\nREPORTED OUTCOMES IN THIS THREAD:\n${tape.map(t => `- ${t}`).join('\n')}\n\nDescribe each reported outcome accurately: OK confirms an action; UNCHANGED means no update; OBSERVED confirms current state without proving this attempt caused it. FAILED, UNCONFIRMED and remaining work stay distinct. COMPLETE describes the whole plan's confirmed state; INCOMPLETE supports only the individual confirmed outcomes. Reconcile disputed or stale state with get_calendar before asserting it. These are tool reports, not independent ground truth.`;
    }
  }

  // v3.1.4 — colleague-path: carry the event(s) this colleague just
  // requested forward by event_id, from the requests spine (the requester-link
  // row written on a colleague booking). Pre-fix, a colleague who booked then
  // said "add Eli / rename it" sent Maelle to get_calendar, which returned 0
  // (Graph calendarView indexing lag right after a write) — she "lost" the
  // meeting and flailed. With the full event_id in context, the follow-up edit
  // targets update_meeting directly. No lagging re-read.
  let colleagueBookingBlock = '';
  if (input.senderRole === 'colleague' && input.userId) {
    try {
      // v3.7.x (#141) — meetings THIS colleague requested (booked through Maelle),
      // via the shared reverse-requester helper. Broadened from the just-booked 3h
      // window to the recent (7d) window so a requester can act on a meeting they
      // set up days ago: the colleague get_calendar clamp hides meetings they
      // aren't an attendee of, so without these ids Maelle "can't see" a meeting
      // the requester legitimately controls (#141). A move/cancel routes to owner.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getMeetingsRequestedBy } = require('../../db/requests') as typeof import('../../db/requests');
      const requestedSinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const rows = getMeetingsRequestedBy(profile.user.slack_user_id, input.userId, {
        // includeApprovals: an approval-booked meeting (Talia-shaped) gets its
        // event id linked back at book time (#141 Ch5), so once linked it must
        // surface here too — else the requester still can't act on it. #141.
        sinceIso: requestedSinceIso, withEventIdOnly: true, includeApprovals: true,
      }).slice(0, 5);
      if (rows.length > 0) {
        const ownerFirst = profile.user.name.split(' ')[0];
        const lines = rows.map(r => `  - "${r.subject}" — event_id=${r.outcome_external_event_id}`);
        colleagueBookingBlock = `## MEETINGS YOU REQUESTED (use these IDs to change one)\n\nThese are meetings you asked ${ownerFirst} to set up. For a requested change use the matching event_id below. Add or rename through update_meeting; move through move_meeting, which checks the current scheduling rules and raises an approval only when needed. Cancellation requires ${ownerFirst}'s approval. A request to move this occurrence keeps its identity and attendees; it is not a new booking.\n\n${lines.join('\n')}`;
      }
    } catch (err) {
      logger.warn('colleagueBookingBlock builder threw — proceeding without it', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // v3.4.2 — owner-path equivalent of colleagueBookingBlock: the events
  // the owner created/edited THIS thread, by full event_id (from the in-memory
  // thread ledger). Lets a later "rename it / add Chris / make it Weekly" edit
  // by id instead of re-searching by name — which lagged after a write AND
  // re-resolved the date to the wrong week (the "Week Summary doesn't appear"
  // miss). Empty when nothing's been booked this thread → no block.
  // OWNER PATH ONLY (isOwnerPath, not isOwnerTyping): this block names his
  // meeting subjects and event ids. In a clamped MPIM it would put them in a
  // colleague-readable thread's context — and point at move/cancel/update
  // tools the colleague allow-list doesn't even ship. The colleague path has
  // its own scoped equivalent above (colleagueBookingBlock: only what THEY
  // requested).
  let ownerThreadEventsBlock = '';
  if (isOwnerPath && input.threadTs) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getThreadEvents, getViewedThreadEvents, getActivePlanningWindow } = require('../../utils/threadEventLedger') as
        typeof import('../../utils/threadEventLedger');
      const evs = getThreadEvents(input.threadTs);
      const createdIds = new Set(evs.map(e => e.eventId));
      // v4.0.x — events pulled up via get_calendar this thread (minus ones already
      // listed as created/edited), soonest-first, capped for the prompt. Lets a
      // follow-up "move it / cancel it / who's on it" resolve by id instead of the
      // model re-searching by name — or fabricating "I can't find it" (the "Getting
      // back the Automation" move: read one turn, "not found" the next).
      const observed = getViewedThreadEvents(input.threadTs).filter(v => !createdIds.has(v.eventId));
      const viewed = observed.slice(0, 10);
      if (evs.length > 0 || viewed.length > 0) {
        const ownerFirst = profile.user.name.split(' ')[0];
        const parts: string[] = [];
        if (evs.length > 0) {
          const lines = evs.slice(-10).map(e => `  - "${e.subject}" — event_id=${e.eventId}`);
          // v3.4.2 — active-window anchor for bare day references. Pure
          // conversation signal (the dates booked this session) — NO travel/marker
          // needed, so it works for a plain "plan my July" thread. Resolves the
          // "Thursday → wrong calendar week" drift (booked Jul 2, then reverted to
          // Jun 25).
          const win = getActivePlanningWindow(input.threadTs);
          const anchorLine = win
            ? `This session you've been scheduling for **${win.from} to ${win.until}**. When ${ownerFirst} gives a bare day reference ("Thursday", "the 1st", "that week", "Monday morning") with no full date, resolve it WITHIN that window — NOT the nearest upcoming calendar day. If he clearly names a different week, follow that.\n\n`
            : '';
          parts.push(`## YOUR SESSION SO FAR (active planning week + event IDs)\n\n${anchorLine}When ${ownerFirst} asks to change one of the events below ("rename it", "add someone", "move it", "make it Weekly", "set its category"), call update_meeting / move_meeting / set_event_category with the matching event_id — do NOT get_calendar to re-find it by name (a just-written event lags a few seconds, and re-resolving by name can land the wrong week):\n\n${lines.join('\n')}`);
        }
        if (viewed.length > 0) {
          const vlines = viewed.map(v => `  - "${v.subject}"${v.dateIso ? ` (${v.dateIso})` : ''} — event_id=${v.eventId}`);
          parts.push(`## MEETINGS YOU'VE PULLED UP THIS THREAD (already on ${ownerFirst}'s calendar)\n\nWhen ${ownerFirst} asks to move / cancel / reschedule one of these, or who's on it, use the matching event_id directly (move_meeting / delete_meeting / update_meeting / get its attendees) — do NOT say you can't find it and do NOT re-search by name; you already have it:\n\n${vlines.join('\n')}`);
        }
        if (observed.length > viewed.length) {
          // Retain the remaining names/dates without repeating long Graph IDs.
          // The previous ten-earliest-only prompt silently forgot later weeks.
          parts.push('Other events observed in this conversation (read the named day to recover details when relevant):\n'+observed.slice(viewed.length).map(v=>`  - ${v.dateIso}: ${v.subject}`).join('\n'));
        }
        ownerThreadEventsBlock = parts.join('\n\n');
      }
    } catch (err) {
      logger.warn('ownerThreadEventsBlock builder threw — proceeding without it', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // Per-person context on COLLEAGUE turns (owner turns use the Social Engine
  // directive below instead). TWO blocks, gated differently:
  //   - WORK context (recent work exchanges + bookings) — on for a colleague's
  //     OWN 1:1 DM. It is what makes Maelle competent with this person; L3
  //     forbids gating work-competence behind the optional social skill.
  //   - SOCIAL context (engagement rank, subjects/topics talked about) —
  //     gated on the toggle (v2.2.3 #3), which is what the toggle is for.
  //     gh#198 — the unconditional "find ONE natural moment to check in"
  //     line and the initiation-cadence lines that used to render alongside
  //     it were a third, ungrounded proactive-origination surface; deleted,
  //     not gated. Proactive social now originates only from the coda
  //     (grounded, generateCoda.ts) or the in-prompt directive below.
  // v4.5.x (#154) — both ALSO suppressed wholesale on a room surface (MPIM or
  // channel), never only trimmed. `isOwnerTyping` answers "who is the human on
  // this turn" (identity), `isRoom` answers "who else can read the answer"
  // (surface) — a colleague's own work/social memory is his to read in his own
  // DM, but the moment other people share the room it is provenance the owner
  // gathered on this person for MAELLE's use, not a profile to hand back to a
  // crowd. (This replaces the narrower `sharedSurface` trim that used to run
  // inside buildPersonWorkContextBlock — see its own history there.) `isRoom`
  // itself is computed once, at the top of this function — see there.
  const personWorkBlock = (isOwnerTyping || isRoom)
    ? ''
    : buildPersonWorkContextBlock(input.userId);
  const socialBlock = (isOwnerTyping || isRoom || !socialActive)
    ? ''
    : buildSocialContextBlock(input.userId);

  // v2.2 — Social Directive block. Populated by the pre-pass above.
  // When mode === 'none' this is empty and has no effect on the prompt.
  // v4.4.9 (gh#154-R9) — same wholesale room suppression as personWorkBlock/socialBlock
  // above. The directive is built from `turnPersonSlackId`, which on an
  // owner-in-room turn (isOwnerTyping) IS the owner's own id — so the picker
  // (directiveForProactiveSlot) surfaces the OWNER's own private subjects
  // ("Zoe the mini pincher", a trip, etc.) and prints them straight into the
  // shared-room prompt via `Subject: <label>`, with no provenance filter at
  // all. This is the same leak buildSocialContextBlockById's created_by
  // filter closes for a colleague's subjects — but socialDirectiveBlock isn't
  // routed through that filter, it's a raw label. Suppressing wholesale on
  // any room surface (MPIM or channel) is correct here too: a proactive
  // social nudge is for a 1:1, never for an audience.
  const socialDirectiveBlock = isRoom ? '' : formatDirectiveForPromptBlock(socialDirective);

  // v2.6.1 — recent-outbound context block. Populated by the Slack
  // connector at inbound-DM time when a colleague's reply lands within a
  // recent outbound's window (≤10min deterministic, 10min-24h LLM-classified,
  // or thread-reply on the outbound's ts). Pinned NEAR THE TOP of the
  // dynamic prompt so Sonnet sees it before drafting any reply.
  const priorOutboundBlock = input.priorOutboundContext ?? '';

  // Availability pre-check. Before the main Sonnet loop, detect specific
  // (date, time) availability questions in the inbound message and run
  // find_available_slots deterministically for each. Closes the
  // get_calendar-eyeball-vs-rule-aware mismatch where Sonnet's first
  // "free" verdict and the booking flow's later "doesn't work" verdict
  // disagreed because they used different tools on the same data. Pinned
  // to the top of dynamic block so Sonnet's first answer matches what
  // the booking flow will accept later. Fails open: regex doesn't match
  // → block empty → normal flow.
  let availabilityPrecheckBlock = '';
  let bookingClockQuestion: string | undefined;
  let ambiguousBookingClock = false;
  // bug 1.1 (2026-08-27, Mike Naumenko / D0ARQRD5H28) — did THIS turn's inbound
  // message contain a detected (date, time) availability question at all? Set
  // from `precheckAvailability`'s own `ran` (below) — true only when at least
  // one slot was actually extracted and tested, never re-derived. Threaded all
  // the way to `runOutputGates`'s `OrchestratorOutput.availabilityQuestionDetected`
  // so the slot-grounding checker can still run when this turn fired ZERO
  // availability tools (the checker's own hard gate on `groundedToolLines`
  // otherwise skips it entirely) — a real Sonnet answer to "is he free at X"
  // with no tool call is exactly the shape that let a stale time from three
  // days earlier in the thread ship as fact.
  let availabilityQuestionDetected = false;
  let requestedSearchWindow: SkillContext['requestedSearchWindow'];
  // 2026-08-30 — the precheck's synthetic tool-summary lines (stable prefix
  // `[availability_precheck`, rendered by the one producer —
  // availabilityPreCheck.ts's renderToolSummaryLines). Carried verbatim to the
  // orchestrator, which prepends them to `OrchestratorOutput.toolSummaries`, so
  // the output-time checkers (claimChecker owner_fact / slot_grounding,
  // runOutputGates' groundedToolLines) see this deterministic zero-tool check as
  // legitimate grounding instead of rewriting a correct precheck-backed answer
  // into "let me check and get back to you".
  let availabilityPrecheckToolSummaries: string[] = [];
  let availabilityChecks: Array<Record<string,unknown>> = [];
  let availabilityAlternatives: Array<Record<string,unknown>> = [];
  // v4.4.x (#154) — gated on `authority`, not the surface-clamped `senderRole`.
  // This precheck's own rendered text names the asker "this colleague's
  // question" (availabilityPreCheck.ts) — true for a genuine colleague, false
  // for the AUTHENTICATED owner typing in an MPIM/channel (where senderRole
  // reads 'colleague' by clamp design but authority still reads 'owner').
  // Running it for him addressed him as a colleague in his own turn; now it
  // simply doesn't run for him, which costs him nothing he actually needs —
  // the owner keeps direct tool access even in a room, so Sonnet calls
  // find_available_slots itself rather than leaning on this eyeball-mismatch
  // guard the way a colleague's more restricted tool access does.
  //
  // gh#handyman-authority-clamp-sweep — `authority` alone still misses one
  // case, the SAME one gh#201-d found and fixed at orchestrator/index.ts's
  // find_available_slots tracking call: processMessage.ts's debounce merge
  // clamps `effectiveAuthority` to 'colleague' for the WHOLE turn whenever the
  // merged batch spans multiple senders, even when `input.userId` is still
  // the owner's own Slack id. Without the identity check below, that merge
  // reopens the exact "addressed him as a colleague in his own turn" bug the
  // v4.4.x comment above describes fixing. Compare the authenticated identity
  // directly, same pattern as orchestrator/index.ts's find_available_slots
  // gate and core/requests/runner.ts's `rawRole` derivation (`runResearchRun`).
  if (
    input.authority === 'colleague'
    && input.userId !== profile.user.slack_user_id
    // A selected hold must bind to an earlier offer. A fresh availability
    // precheck can record new offers before the existing stash is read below.
    && !holdOnlyWindows
    && !existingStatusOnly
    && userMessage && userMessage.trim().length > 0
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { precheckAvailability } = require('../../utils/availabilityPreCheck') as
        typeof import('../../utils/availabilityPreCheck');
      // Carry the asker's permanent zone and dated travel together, so the
      // precheck can resolve each proposed date through the same attendee
      // helper as slot search. A raw current/home zone loses future travel.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getPersonMemory } = require('../../db') as typeof import('../../db');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { loadAttendeeAvailabilityForPerson, attendeeTzForDay } = require('../../utils/attendeeAvailability') as
        typeof import('../../utils/attendeeAvailability');
      const asker = input.userId ? getPersonMemory(input.userId) ?? undefined : undefined;
      const requesterAvailability = loadAttendeeAvailabilityForPerson(asker, profile.user.timezone);
      const result = await precheckAvailability({
        requiredDay:meetingRequest?.requiredDay,
        searchDay:meetingRequest?.searchDay,
        message: userMessage,
        profile,
        requesterAvailability,
        // Compatibility fallback only when no structured entry is available.
        requesterTimezone: requesterAvailability ? undefined : asker?.timezone ?? undefined,
        // v3.3.7 (#125b) — the day a bare time refers to often lives a
        // message earlier ("מחר... 17:00" → "13:00/13:30?").
        recentThread: conversationHistory.slice(-4),
        requestZone: meetingRequest?.clockZone?.zone,
        durationMinutes: meetingRequest?.duration?.minutes,
        // v4.2.x — thread identity for the alternatives block. When every tested
        // slot comes back blocked, nearbyAlternatives offers concrete times and
        // records them into the offered-slots stash (ops/helpers.ts's recordOfferedSlots). Must be
        // the SAME (channelId, threadTs) pair the stash READ below uses: the
        // stash keys group surfaces as `channelId|threadTs`, so passing only the
        // channel would file an MPIM's alternatives under `C…|_none_` while the
        // binding block looks up `C…|<ts>` — offered, never bindable.
        channelId: input.channelId,
        threadTs: input.threadTs,
        // gh#158 — namedInternalAttendeeEmails is non-empty ONLY when the turn
        // names someone other than the owner (resolveNamedInternalAttendees
        // explicitly filters the owner out). That's exactly the signal this
        // owner-scoped pre-check needs to know it does not apply: "does Levana
        // free tomorrow at 10am?" is not a question this file can answer.
        // Deliberately NOT resolvedMeetingAttendees (the search-scoped union,
        // widened below by forwarded-email addresses) — a header address isn't
        // "named" in this turn's own text, and unioning it in here bailed this
        // pre-check on nearly every forwarded-email booking turn regardless of
        // whether the question was actually about a third party's calendar.
        namedAttendeeEmails: namedInternalAttendeeEmails,
      });
      if (existingInviteSubject && result.verdicts.length === 1 && !result.verdicts[0].other) {
        existingInviteStart = result.verdicts[0].instantIso;
      }
      if (!existingInviteSubject && result.ran && result.promptBlock) {
        availabilityPrecheckBlock = result.promptBlock;
      }
      const ambiguous = result.verdicts.length === 1 && result.verdicts[0].other ? result.verdicts[0] : undefined;
      ambiguousBookingClock = !!(exactBookingRequested && ambiguous?.other && !existingInviteSubject && !requestedException);
      if (ambiguousBookingClock && ambiguous?.statedClock && ambiguous.other && (ambiguous.bookable || ambiguous.other.bookable)) {
        const local = ambiguous.other.zone;
        const home = profile.user.timezone;
        const label = (zone: string) => zone.split('/').at(-1)!.replace(/_/g,' ');
        const clock = ambiguous.statedClock;
        if (existingInviteLocale === 'he') {
          const city = (zone: string) => zone === 'America/New_York' ? 'ניו יורק' : zone === 'Asia/Jerusalem' ? 'ישראל' : label(zone);
          bookingClockQuestion = 'התכוונת ל־' + clock + ' לפי שעון ' + city(local) + ' או שעון ' + city(home) + '?';
        } else if (existingInviteLocale === 'en') {
          bookingClockQuestion = 'Did you mean ' + clock + ' in ' + label(local) + ' or ' + label(home) + '?';
        }
      }
      requestedSearchWindow = result.searchWindow;
      availabilityQuestionDetected = result.ran;
      availabilityPrecheckToolSummaries = result.toolSummaryLines;
      availabilityAlternatives = (result.alternatives ?? []).map(slot => ({
        start:slot.start,end:slot.end,available:true,owner_available:true,
        presentation_local:DateTime.fromISO(slot.start,{zone:profile.user.timezone}).setZone(meetingRequest?.clockZone?.zone
          ?? slot.presentationZone ?? (requesterAvailability ? attendeeTzForDay(requesterAvailability,slot.start) : asker?.timezone)
          ?? profile.user.timezone).setLocale('en').toFormat('ccc d LLL HH:mm ZZZZ'),
        preference:slot.overOptional ? 'less preferred' : undefined,attendees:[{status:'unknown',kind:'not_checked'}],
      }));
      availabilityChecks = result.verdicts.flatMap(verdict => [verdict, ...(verdict.other ? [verdict.other] : [])]
        .flatMap(slot => {
          const start = DateTime.fromISO(slot.instantIso ?? `${slot.date}T${slot.time}`, {zone:profile.user.timezone});
          if (!start.isValid) return [];
          const requesterZone = requesterAvailability ? attendeeTzForDay(requesterAvailability,start.toISO()!) : asker?.timezone;
          return [{owner_clock:start.setZone(profile.user.timezone).toFormat('ccc d LLL HH:mm ZZZZ'),
            owner_zone:profile.user.timezone,
            requester_clock:requesterZone ? start.setZone(requesterZone).toFormat('ccc d LLL HH:mm ZZZZ') : undefined,
            requester_zone:requesterZone, available:slot.bookable, reason:slot.rejection_reason,
            ambiguous:!!verdict.other, duration_minutes:verdict.durationMin}];
        }));
      // A slot the colleague ASKED about that we confirmed bookable IS a slot
      // we offered them — record it into the SAME stash find_available_slots
      // feeds, so the hold gate (which validates "was this offered?") passes on
      // "is he free at X? → yes → hold it". One source of truth: both
      // availability surfaces (search + point-check) record what they confirmed;
      // pre-fix only the search did, so a point-check confirmation couldn't be held.
      if (result.ran && input.channelId && result.verdicts.length > 0) {
        const bookableSlots = result.verdicts
          .filter(v => v.bookable && !v.other)
          .flatMap(v => {
            // Keep the exact checked occurrence when the owner's clock repeats.
            const dt = DateTime.fromISO(v.instantIso ?? `${v.date}T${v.time}`, { zone: profile.user.timezone });
            if (!dt.isValid) return [];
            const minutes = v.gapQuery ? v.maxFreeMinutes : v.durationMin;
            return [{ start: dt.toISO()!, ...(minutes && minutes > 0 ? { end: dt.plus({ minutes }).toISO()! } : {}) }];
          });
        if (bookableSlots.length > 0) {
          if (checkRequestedHold && bookableSlots.length === 1 && bookableSlots[0].end) {
            holdOnlyWindows = new Map([[Date.parse(bookableSlots[0].start), Date.parse(bookableSlots[0].end)]]);
          }
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { recordOfferedSlots } = require('../../utils/offeredSlotsStash') as
            typeof import('../../utils/offeredSlotsStash');
          recordOfferedSlots({
            channelId: input.channelId,
            threadTs: input.threadTs,
            timezone: profile.user.timezone,
            slots: bookableSlots,
          });
        }
      }
    } catch (err) {
      logger.warn('availabilityPreCheck threw — proceeding without pre-check', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // v3.3.8 — offered-slots binding block. When a previous turn in this
  // conversation OFFERED specific slots (find_available_slots, colleague
  // path), inject the exact instants so a pick ("Tuesday 20:30") binds to
  // the offered date instead of being re-derived — re-derivation is how
  // "יום שלישי 20:30" validated against Jun 23 when the offer was Jun 16
  // (false "not free" on a free slot; the quiet variant books the wrong
  // week silently). Coord stored offers on its job row; this is the same
  // protection for the direct path. Same injection rail as the pre-check.
  let offeredSlotsBlock = '';
  // v4.3.0 (#24) — also the email leg. Its turns always carry senderRole
  // 'owner' (the email sender gate), but the owner is only relaying an external's
  // pick from a forwarded chain — the exact "bind, don't re-derive" problem
  // the colleague path already solves. offeredSlotsStash gives the email key
  // its own longer TTL by key prefix; this gate only needs to widen so the
  // block actually gets injected on that leg.
  const privateOwnerClock = input.channel==='slack' && input.surface==='owner_dm' && input.authority==='owner'
    && input.userId===profile.user.slack_user_id && !input.isChannel && !input.isMpim;
  if ((input.senderRole === 'colleague' || input.channel === 'email' || privateOwnerClock) && input.channelId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOfferedSlots } = require('../../utils/offeredSlotsStash') as
        typeof import('../../utils/offeredSlotsStash');
      const offered = getOfferedSlots(input.channelId, input.threadTs)?.filter(slot => !holdOnlyWindows
        || (slot.endIso && holdOnlyWindows.get(Date.parse(slot.startIso)) === Date.parse(slot.endIso)));
      if (offered && offered.length > 0) {
        const literalClock=privateOwnerClock && input.typedUserMessage===userMessage
          && /^\s*\d{1,2}:\d{2}\s*$/.test(userMessage) ? clockReply(userMessage) : undefined;
        const selectedDay=meetingRequest?.requiredDay?.date ?? meetingRequest?.searchDay?.date;
        if(literalClock && (!selectedDay || selectedDay==='flexible')) {
          const zone=meetingRequest?.clockZone?.zone ?? profile.user.timezone;
          const days=new Set(offered.map(slot=>DateTime.fromISO(slot.startIso,{zone}).toISODate()).filter(Boolean));
          const matches=offered.filter(slot=>DateTime.fromISO(slot.startIso,{zone}).toFormat('HH:mm')===literalClock);
          if(days.size>1 && matches.length!==1) {
            ambiguousBookingClock=true;
            offeredSlotsBlock=`The current reply supplies only ${literalClock} (${zone}); the current offers span ${[...days].join(', ')} and do not identify one matching occurrence. Ask which day this time refers to before booking.\n`;
          }
        }
        // Email vs. colleague-chat phrasing: on email the "requester" reading
        // this is the owner relaying an external's pick from a forwarded
        // chain, not a colleague typing directly — say so accurately (M9).
        const whoPicks = input.channel === 'email'
          ? 'whoever the forwarded chain quotes as picking a time'
          : privateOwnerClock ? 'the owner' : 'this colleague';
        offeredSlotsBlock += `## SLOTS ALREADY OFFERED IN THIS CONVERSATION (binding)
These exact instants were offered to ${whoPicks} earlier and are still on the table:
${offered.map(s => `- ${s.display} → start_iso ${s.startIso}${holdOnlyWindows && s.endIso ? `, end_iso ${s.endIso}` : ''}`).join('\n')}
If the message picks one of these — by time ("20:30"), weekday+time ("Tuesday 20:30"), or position ("the second one") — it means THAT exact instant: use its start_iso verbatim in any create_meeting / validation call. NEVER re-resolve the date from a weekday word; the offer above is the authoritative date.`;
      }
    } catch (err) {
      logger.warn('offeredSlotsStash read threw — proceeding without block', {
        err: String(err).slice(0, 150),
      });
    }
  }

  // v3.1.2 (D) — free-time pre-check. Owner-path only. When classifyTurn
  // flagged this turn as a buffer/free-time inquiry ("do I have buffer?",
  // "how packed is Thursday?", "am I free this afternoon?"), run
  // analyzeCalendar for today + tomorrow deterministically and inject the
  // real freeMin + gap structure into the prompt. Replaces the leaky
  // meetings.ts:1307 "USE THE TOOL — don't math by hand" prompt rule that
  // Sonnet kept ignoring, producing fabricated "2h45 free / healthy"
  // narrations. No NL regex — the classifier's LLM pre-pass decides
  // intent. Fails open: any error in analyze leaves the block empty and
  // the prompt rule + Sonnet's normal flow take over.
  let freeTimePrecheckBlock = '';
  if (isFreeTimeInquiry && isOwnerPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ops = require('../../skills/meetings/ops') as typeof import('../../skills/meetings/ops');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cal = require('../../connectors/graph/calendar') as typeof import('../../connectors/graph/calendar');
      const tz = profile.user.timezone;
      // Today + tomorrow window. Enough surface for "do I have buffer today",
      // "how packed is tomorrow", or "this afternoon vs tomorrow morning"
      // questions without paying for a week's worth of events.
      const { DateTime: Lux } = require('luxon') as typeof import('luxon');
      const todayStr = Lux.now().setZone(tz).toFormat('yyyy-MM-dd');
      const tomorrowStr = Lux.now().setZone(tz).plus({ days: 1 }).toFormat('yyyy-MM-dd');
      const rawEvents = await cal.getCalendarEvents(profile.user.email, todayStr, tomorrowStr, tz);
      const processed = ops.processCalendarEvents(
        rawEvents,
        profile.user.email,
        profile.user.name,
        tz,
        profile,
        // Gated on isOwnerPath (senderRole === 'owner'), which — per
        // processMessage.ts's room clamp — only ever holds for the owner's own
        // DM, never a room a colleague can read. 'owner' matches that
        // guarantee (mirrors the isOwnerDm callers in calendarReads.ts).
        'owner',
      );
      const days = ops.analyzeCalendar(processed, todayStr, tomorrowStr, profile);
      if (days.length > 0) {
        const lines: string[] = [];
        for (const d of days) {
          if (d.dayType === 'day_off') continue;
          const free = d.stats?.freeMinInWorkHours ?? 0;
          const meetings = d.stats?.meetingCount ?? 0;
          const noBuffer = d.issues?.some(i => i.type === 'no_buffer') === true;
          const totalMin = d.stats?.totalMeetingMin ?? 0;
          const hh = Math.floor(free / 60);
          const mm = free % 60;
          const freeStr = hh > 0 ? `${hh}h${mm > 0 ? `${String(mm).padStart(2, '0')}m` : ''}` : `${mm}m`;
          const meetingsHh = Math.floor(totalMin / 60);
          const meetingsMm = totalMin % 60;
          const meetingsStr = meetingsHh > 0 ? `${meetingsHh}h${meetingsMm > 0 ? `${String(meetingsMm).padStart(2, '0')}m` : ''}` : `${meetingsMm}m`;
          // Full-day occupancy is not an overloaded ordinary workday. Keep
          // actual meeting counts, and distinguish OOF from a Busy commitment:
          // Busy alone does not establish that the owner is away or on vacation.
          if (d.outOfOfficeAllDay || d.allDayBusy) {
            const stillBooked = meetings > 0
              ? `; ${meetings} ${meetings === 1 ? 'meeting is' : 'meetings are'} still booked on it (${meetingsStr})`
              : '';
            const blockedReason = d.outOfOfficeAllDay
              ? "you're out of office all day"
              : 'you have an all-day commitment';
            lines.push(`  - ${d.date} (${d.day}): ${blockedReason} — the whole day is blocked on your calendar, so there is no free time to report${stillBooked}`);
            continue;
          }
          lines.push(`  - ${d.date} (${d.day}, ${d.dayType}): ${freeStr} free during work hours / ${meetingsStr} in meetings across ${meetings} ${meetings === 1 ? 'meeting' : 'meetings'}${noBuffer ? ' — flagged as BUSY (below your daily focus-time floor)' : ''}`);
        }
        if (lines.length > 0) {
          freeTimePrecheckBlock = `## CALENDAR HEALTH (rule-aware, deterministic — use these numbers)\n\nYou asked about your free time / buffer. I ran the analyzer; here are the real numbers — narrate from THESE, do not eyeball get_calendar and recompute:\n\n${lines.join('\n')}\n\nIf a day is flagged BUSY, say so honestly. If you have buffer, say how much. Do not invent figures.`;
        }
      }
    } catch (err) {
      logger.warn('freeTimePreCheck threw — proceeding without pre-check', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // v3.1.2 — recently-surfaced calendar issues. When the calendar_health
  // routine (or the brief) tells the owner about a duplicate / overlap /
  // OOF-conflict and the owner replies "delete it" / "fix it" minutes later,
  // the next-turn search-by-subject was losing the event_id the routine
  // already had in hand — Maelle was searching get_calendar for "Video
  // Interview" and missing the now-vanished event, replying "may have
  // already been removed" instead of resolving against the known
  // event_id/peer_event_id. Owner-path only. Pull calendar_issues rows
  // touched in the last 6h (regardless of status — auto-stale-resolved
  // rows from this morning are still candidates for "delete it" follow-ups
  // throughout the workday), inject as a compact block. Sonnet uses the
  // IDs to call delete_meeting / manage_calendar_issue directly instead
  // of subject re-search.
  //
  // v4.2.x (#148) — the guidance now covers BOTH directions a row can be
  // referenced. Health tracks `missing_category` (checkHealth.ts's day-loop
  // issue push, status awaiting_owner), so some rows are no longer a problem Maelle reported but a
  // QUESTION she asked; the answer arrives as one word ("Meeting"), which read
  // as a fresh booking request while the text only taught delete/fix/cancel.
  // Class-keyed, not status-keyed: an awaiting_owner OVERLAP row is still a
  // problem, and only `missing_category` is answered by a category name
  // (db/calendarIssues.ts QUESTION_ONLY_CLASSES).
  let recentCalendarIssuesBlock = '';
  if (isOwnerPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getDb } = require('../../db') as typeof import('../../db');
      const rows = getDb().prepare(`
        SELECT id, event_id, peer_event_id, event_date, issue_class, status, notes, updated_at
        FROM calendar_issues
        WHERE owner_user_id = ?
          AND datetime(updated_at) >= datetime('now', '-6 hours')
        ORDER BY datetime(updated_at) DESC
        LIMIT 5
      `).all(profile.user.slack_user_id) as Array<{
        id: string;
        event_id: string;
        peer_event_id: string | null;
        event_date: string;
        issue_class: string;
        status: string;
        notes: string | null;
        updated_at: string;
      }>;
      if (rows.length > 0) {
        const lines = rows.map(r => {
          const peerPart = r.peer_event_id ? `, peer_event_id=${r.peer_event_id}` : '';
          const noteSnip = (r.notes ?? '').slice(0, 180).replace(/\s+/g, ' ').trim();
          return `  - issue_id=${r.id} (${r.issue_class} on ${r.event_date}, status=${r.status}): event_id=${r.event_id}${peerPart}\n    notes: ${noteSnip}`;
        });
        recentCalendarIssuesBlock = `## RECENT CALENDAR ISSUES (last 6h — act by id, not by subject search)\n\nThe calendar_health routine or the brief surfaced these. Resolve them from the ids below; the event may have vanished externally since, so a fresh get_calendar subject search can miss it.\n\n- "delete it" / "fix it" / "cancel it" → act on that row's event_id (peer_event_id when the reference is the second event) with delete_meeting / move_meeting / update_meeting.\n- issue_class=missing_category + status=awaiting_owner is a "which category?" question YOU asked; the notes name the event and when it is. A short reply naming a category, in any language, ANSWERS that row — call set_event_category(event_id=<the row's event_id>, categories=[...]) and confirm it as the answer you were waiting for (answered_open_question:true in the result = that question is now closed). Several open at once → take the event the reply points to, or ask which.\n\n${lines.join('\n')}`;
      }
    } catch (err) {
      logger.warn('recentCalendarIssues block builder threw — proceeding without it', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // v3.1.7 — the blind research pre-check (researchPreCheck) is GONE. It
  // mis-extracted the topic (searched the task framing), then injected a
  // "research done" block that suppressed the real, focused searches the turn
  // needed — so content got written from training memory, ungrounded. Replaced
  // by the `research` tool in the search skill: the model calls it with a real
  // goal, it plans focused searches, fetches + reads real sources, and returns
  // them so the draft is grounded and cited.

  // v3.3.x (RC3) — per-turn reply-language reinforcement. The static
  // CURRENT-TURN-WINS language rule decays across a thread (drifts to Hebrew
  // when Hebrew tool-results / memory bleed in). Re-stamping the detected
  // language into the UNCACHED dynamic block reinforces the current message,
  // including voice transcripts. Latin is a script sentinel, not an English guess.
  // Exclude the transport marker from detection only; keep the audio input intact.
  const languageText = (text: string): string => {
    const trimmed = text.trimStart();
    const marker = '[Voice message]:';
    return trimmed.startsWith(marker) ? trimmed.slice(marker.length) : text;
  };
  let languageDirectiveBlock = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { detectMessageLanguage } = require('../../utils/detectMessageLanguage') as
      typeof import('../../utils/detectMessageLanguage');
    let lang = detectMessageLanguage(languageText(userMessage));
    if (!lang) {
      // A contentless reply — "11:15" or an emoji — carries no
      // language signal, so detectMessageLanguage returns null and the per-turn
      // LANGUAGE override vanishes. That let a stored/attendee language_pref pull
      // the reply into another language (English booking → Hebrew confirmation on
      // "11:15"). Carry the language forward from the most recent prior message
      // that DID carry one (the human's, not Maelle's own past replies) so the
      // conversation's language sticks across short replies.
      for (let i = conversationHistory.length - 1; i >= 0; i--) {
        const m = conversationHistory[i];
        if (m.role !== 'user') continue;
        const prior = detectMessageLanguage(languageText(m.content));
        if (prior) { lang = prior; break; }
      }
    }
    if (lang === 'Latin') {
      // v3.3.x — symmetric override for a Latin-script inbound. Don't name the
      // language (script can't distinguish English/Spanish/French); just bind
      // to THIS message and forbid drifting to a non-Latin language or a stored
      // preference. Fixes "English in, Hebrew out" (Ayala) when the thread /
      // stored pref skews non-Latin.
      languageDirectiveBlock = `LANGUAGE (this turn): the sender's current message is in a Latin-script language (English, Spanish, etc.) — reply in the EXACT same language as THIS message. Do NOT reply in Hebrew or any non-Latin language, and do NOT carry over the language of earlier messages in this thread, a stored language preference, or any tool result.`;
    } else if (lang) {
      languageDirectiveBlock = `LANGUAGE (this turn): the sender wrote in ${lang} — reply in ${lang}. This overrides any prior-turn language and the language of anything you read this turn (tool results, memory, calendar subjects).`;
    }
  } catch (_) { /* detection failure is non-fatal — static rule still governs */ }

  // v3.5.x (person-memory rebuild) — persist the colleague's inbound language as
  // a derived signal. Outbound composition TO them (relay / outreach / coord)
  // uses the stored preference first, then recent inbound as fallback
  // (people.resolveOutboundLanguageForPerson). Stamp the current transcript's script
  // only (not the carried-forward value): contentless input detects null and
  // leaves the prior signal intact. Colleague senders only; best-effort.
  try {
    if (input.senderRole === 'colleague' && input.userId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { detectMessageLanguage } = require('../../utils/detectMessageLanguage') as
        typeof import('../../utils/detectMessageLanguage');
      const raw = detectMessageLanguage(languageText(userMessage));
      const code = raw === 'Hebrew' ? 'he'
        : raw === 'Russian' ? 'ru'
        : raw === 'Arabic' ? 'ar'
        : raw === 'Latin' ? 'en'
        : null;
      if (code) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { setLastInboundLang } = require('../../db/people') as typeof import('../../db/people');
        setLastInboundLang(input.userId, code);
      }
    }
  } catch (_) { /* signal stamping is best-effort */ }

  // #WE-spine (Gidon fix, #134) — per-turn owner-location grounding. Assert WHICH
  // days the owner is away (+ where) and that other days he's home, so a stale
  // "he's in Boston" can't bleed from an earlier thread onto a home day. DUAL-
  // SOURCE: the owner's WE days are CALENDAR MARKERS (his primary mechanism), so
  // this reads the 14-day calendar (markers) AND the travel record. The read goes
  // through the warm calendarCache (one fetch per ~5-min window, shared across
  // turns — NOT a per-tool reload), and ONLY on scheduling-relevant turns
  // (colleague, or an owner turn scoped to meetings/calendar) so a trivial "thanks"
  // never pays for it. Empty (no block) when no trip is in the window or the read
  // fails (fail-open).
  let ownerLocationBlock = '';
  try {
    const weBlockRelevant = input.senderRole === 'colleague'
      || (Array.isArray(toolScopes) && (toolScopes.includes('meetings') || toolScopes.includes('calendar')));
    if (weBlockRelevant) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const we = require('../../utils/workingElsewhere') as typeof import('../../utils/workingElsewhere');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DateTime: LuxWe } = require('luxon') as typeof import('luxon');
      const homeTz = profile.user.timezone;
      const winFrom = LuxWe.now().setZone(homeTz).toFormat('yyyy-MM-dd');
      const winTo = LuxWe.now().setZone(homeTz).plus({ days: 14 }).toFormat('yyyy-MM-dd');
      // v3.7.x (#143) — away days come from the override table (no Graph fetch).
      const awayDays = we.detectOwnerAwayDaysInWindow(profile, winFrom, winTo);
      if (awayDays.size > 0) {
        const ownerFirst = profile.user.name.split(' ')[0];
        const byLoc = new Map<string, string[]>();
        for (const [date, info] of awayDays) {
          const key = info.location || 'another location';
          if (!byLoc.has(key)) byLoc.set(key, []);
          byLoc.get(key)!.push(date);
        }
        const parts = [...byLoc.entries()].map(([locName, dates]) => `${dates.sort().join(', ')} (${locName})`);
        ownerLocationBlock = `## OWNER LOCATION (next 14 days)\n\n${ownerFirst} is WORKING ELSEWHERE on: ${parts.join('; ')}. On those days his clock and location are the trip's, not home. On any day NOT listed above, treat ${ownerFirst} as in his home base (${homeTz}) — and do NOT carry a trip location/timezone that came up earlier in the conversation onto a day that isn't listed here (that bleed is the bug this prevents).\n\nOn one of his working-elsewhere days, lead with the destination-local time (e.g. "10:45 Boston / 17:45 your usual time"), not home-first. And when flagging an over-hours or conflict on such a day, name the real reason in one clause — don't say "past your usual finish" unless it is actually true in the timezone he is in that day.`;
      }
    }
  } catch (err) {
    logger.warn('ownerLocationBlock — resolve threw, skipping', { err: String(err).slice(0, 160) });
  }

  const currentSchedulingTask = currentPromptScopes?.some(scope=>scope!=='general')
    ? currentPromptScopes.some(scope=>scope==='calendar'||scope==='meetings')
      && !currentPromptScopes.some(scope=>['knowledge','summary','news'].includes(scope))
    : !!(meetingRequest || toolScopes?.some(scope=>scope==='calendar'||scope==='meetings')
      || standaloneBookingApproval || contextualApprovalDecisions?.length);
  // A task change does not erase the stored calendar request. It does stop
  // unrelated calendar inventories and pending decisions from being injected
  // as current instructions into a writing or research follow-up.
  const calendarContextRelevant = !currentPromptScopes?.some(scope=>scope!=='general')
    || currentPromptScopes.some(scope=>scope==='calendar'||scope==='meetings')
    || !!calendarOperations?.length || !!contextualApprovalDecisions?.length;
  const systemBlocksDynamic = [
    languageDirectiveBlock,
    priorOutboundBlock,
    calendarContextRelevant && meetingRequest ? 'Current scheduling request at the start of this turn: '+JSON.stringify({
      meetingRequestId:meetingRequest.batch?undefined:meetingRequest.requestId,
      priorBookingConfirmed:meetingRequest.hasConfirmedBooking===true,
      duration:meetingRequest.duration,participantGroups:meetingRequest.participantGroups,
    })+'. These are request details, not proof of an invitation. Planned participants are included in the requested roster; describe them as already invited only when a successful booking receipt or matching existing event establishes that. Current tool results supersede the starting state.' : undefined,
    calendarContextRelevant && meetingRequest?.requiredDay ? 'Required meeting date: '+JSON.stringify(meetingRequest.requiredDay)+'. Keep the search and any counterproposal within this date unless the person changes it.' : undefined,
    calendarContextRelevant && meetingRequest?.searchDay ? 'Latest day the human is exploring: '+JSON.stringify(meetingRequest.searchDay)+'. A follow-up clock refers to this day. This is search context, not a deadline or booking authority.' : undefined,
    availabilityPrecheckBlock,
    calendarContextRelevant ? resolvedAttendeesBlock : undefined,
    calendarContextRelevant ? offeredSlotsBlock : undefined,
    ownerLocationBlock,
    freeTimePrecheckBlock,
    calendarContextRelevant ? recentCalendarIssuesBlock : undefined,
    promptParts.dynamic,
    threadContextBlock,
    actionTapeBlock,
    calendarContextRelevant ? colleagueBookingBlock : undefined,
    calendarContextRelevant ? ownerThreadEventsBlock : undefined,
    personWorkBlock,
    socialBlock,
    socialDirectiveBlock,
  ].filter(Boolean).join('\n\n');

  // Existing-invitation/status questions deliberately create no new booking
  // state. They still use the same scheduling workflow and owner-question route.
  const schedulingDm = !!(meetingRequest || existingStatusOnly || existingInviteSubject || meetingExplorationOnly || consultOwnerQuote || searchBeforeReply || exactBookingRequested)
    && input.channel === 'slack' && !input.isChannel && !input.isMpim && input.authority === 'colleague'
    && input.surface === 'colleague_dm' && !input.images?.length && !input.forceToolOnFirstTurn
    && !input.proseOnly && !input.extraInstruction;
  let priorMeetingState:ReturnType<typeof import('./requesterMeetingState').requesterMeetingState>;
  if (input.channel==='slack' && input.surface==='colleague_dm' && input.authority==='colleague'
    && !input.isChannel && !input.isMpim && input.userId && input.channelId && threadTs) {
    try {
      priorMeetingState = (await import('./requesterMeetingState')).requesterMeetingState(profile.user.slack_user_id,input.userId,input.channelId,threadTs);
    } catch (err) { logger.warn('Requester meeting state unavailable',{threadTs,error:String(err).slice(0,120)}); }
  }
  const privateOwnerWork = input.channel==='slack' && input.interactive!==false && input.surface==='owner_dm' && input.authority==='owner'
    && input.userId===profile.user.slack_user_id && !input.isChannel && !input.isMpim
    && !input.images?.length && !input.forceToolOnFirstTurn && !input.proseOnly && !input.extraInstruction;
  const ownerSchedulingDm = currentSchedulingTask && privateOwnerWork;
  const staticInstructions = ownerSchedulingDm
    ? (await import('./ownerSchedulingPrompt')).ownerSchedulingPrompt(profile.user.name,profile.assistant.name,profile.meetings?.default_meeting_duration ?? 25) + '\n\n' + promptParts.audienceRules + '\n\n' + (promptParts.ownerPreferences ?? '')
    : schedulingDm
    ? (await import('./colleagueSchedulingPrompt')).colleagueSchedulingPrompt(profile.user.name, profile.assistant.name, profile.meetings?.default_meeting_duration ?? 25) + '\n\n' + promptParts.audienceRules
    : privateOwnerWork
    ? (await import('./ownerSchedulingPrompt')).ownerWorkPrompt(profile.user.name,profile.assistant.name) + '\n\n' + promptParts.audienceRules + '\n\n' + (promptParts.ownerPreferences ?? '')
    : promptParts.static;
  const systemBlocks: Anthropic.TextBlockParam[] = staticInstructions
    ? [
        { type: 'text', text: staticInstructions, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam,
        { type: 'text', text: systemBlocksDynamic } as Anthropic.TextBlockParam,
      ]
    : [{ type: 'text', text: systemBlocksDynamic } as Anthropic.TextBlockParam];
  const ownerSettings = ownerSchedulingDm
    ? (await import('./ownerSchedulingPrompt')).ownerSchedulingSettings(profile) : undefined;
  if (ownerSettings) systemBlocks.push({type:'text',text:'Current owner scheduling settings (private facts). Dense means packing appointments together to preserve useful free time. Calendar tools enforce these settings and the owner’s authorized exceptions: '+JSON.stringify(ownerSettings)});
  if (requireAttendeeAvailability) systemBlocks.push({type:'text',text:'The owner made this action conditional on attendee availability. Check it and proceed only if confirmed free. If the condition fails, leave the meeting unchanged, explain the actual conflict or uncertainty and offer the next useful choice. The conditional request does not accept that conflict.'});
  if (exactRequestClock) systemBlocks.push({type:'text',text:'The current human clock is bound to this frame: '+JSON.stringify(exactRequestClock)+'. Use that literal clock in that zone for the requested date. Calendar handlers verify the same binding; an earlier displayed clock in another zone does not replace it.'});
  if (existingStatusOnly) systemBlocks.push({type:'text',text:'This is a question about an existing invitation. Read that shared event and answer its actual status/details. Its current clock is evidence to identify it, not a proposed new booking to validate. If the question requires an owner decision not recorded in the evidence, offer to ask through the approval process.'});
  if (answeredQuestion) systemBlocks.push({type:'text',text:'The current owner reply answers this exact proposal from your last message: '+JSON.stringify(answeredQuestion)+'. Complete the portion they decided through the normal tools. Other unanswered questions remain separate. This identifies the conversational referent; all normal identity, target and write checks still apply.'});
  if(contextualApprovalDecisions?.length) systemBlocks.push({type:'text',text:
    'Pending requests referenced by the current owner message, with their stored actions: '
    +JSON.stringify(contextualApprovalDecisions.map(({requestId,action,instructionQuote,preservesRecipients})=>({requestId,action,instructionQuote,preservesRecipients})))
    +'. Interpret the original owner instruction against each actual action. A scheduling constraint is a condition to apply, not a rejection of every request. Keep unrelated or already matching terms separate. Only an actual rejection closes a request. A changed time uses resolve_approval with data={tool,args} after checking the replacement. Preserve the roster and subject unless changed by the owner. A question or search-only instruction remains a read. Do not replace a pending request by creating an unrelated meeting or ask the owner to switch threads. The resolver rechecks the binding and stored action.'});
  if (priorMeetingState && (priorMeetingState.approvals.length || priorMeetingState.holds.length)) {
    systemBlocks.push({type:'text',text:'Open calendar decisions and holds belonging to this authenticated requester across their conversations: '+JSON.stringify(priorMeetingState)+
      '. Match the current request by meetingRequestId, meeting and time. When the person corrects the same request or supplies its missing duration or participants, refresh that pending owner question with create_approval and the complete current facts. Do not ask again whether to consult the owner. If it is now a verified calendar action, use policy_exception with the checked action; the handler retains the same undecided request. A shorter fallback leaves the original pending unless the person asks to replace it. A pending decision about another meeting does not require another approval or prevent a new search.'});
  }

  // v2.7.7 (Module G) — intent-aware tool scoping. `toolScopes` was resolved
  // in the v3.0.6 merged classifier pre-pass above (classifyTurn), gated on
  // profile.behavior.intent_aware_tools + owner turn. Colleagues use the
  // static COLLEAGUE_ALLOWED_TOOLS allowlist (toolScopes stays undefined).
  // Fails open: any classifier error left toolScopes undefined → getSkillTools
  // ships every tool as before.

  // Tools are collected from active skills — filtered by sender role and
  // (when Module G is on) by the classifier-picked scope set.
  // Colleagues get the static restricted subset; owner gets scope-filtered.
  // v4.4.x (#154) — `input.authority` widens a colleague-context (room)
  // turn's floor to OWNER_ROOM_ACTION_TOOLS when the AUTHENTICATED sender is
  // the owner, so his book/move/cancel/approve authority survives the room
  // clamp even though his DATA access does not (registry.ts getSkillTools).
  let tools = getSkillTools(profile, input.senderRole, toolScopes, input.channel, input.authority);
  // Role capabilities describe what a subsequent authorized request can do.
  // Intent filters below govern execution on this turn only.
  const supportedOperations = getSkillTools(profile, input.senderRole, undefined, input.channel, input.authority)
    .map(tool => tool.name);
  // Carry the same per-turn write boundary into dispatch. Tool descriptions
  // alone cannot prevent a stale or invented tool_use from reaching a handler.
  const blockedWriteTools = new Set<string>();
  if (calendarOperations !== undefined) {
    // One requested mutation does not authorize every other kind of calendar
    // write in the conversation. In particular, correcting an explanation or
    // rejecting a time cannot accept a still-unbooked appointment.
    const operations = new Set(calendarOperations.map(item=>item.operation));
    // "Book it at the corrected time" can continue an invitation already
    // created in this same request. The accepted calendar effect may then
    // require moving/updating that event; create's idempotency check remains.
    if (meetingRequest?.hasConfirmedBooking && !meetingRequest.batch && operations.has('create')) {
      operations.add('move');
      operations.add('update');
      systemBlocks.push({type:'text',text:'This same request has a confirmed invitation. Apply the current instruction to that existing event with move_meeting/update_meeting when its time or participants change; an unchanged repeat keeps the existing invitation. A new appointment is a separate request.'});
    }
    const permitted:Record<string,boolean> = {
      create_meeting:operations.has('create'), move_meeting:operations.has('move'),
      update_meeting:operations.has('update'), set_event_category:operations.has('update'),
      delete_meeting:operations.has('cancel'), hold_slot:operations.has('hold'),
      book_floating_block:operations.has('create') || operations.has('move'),
    };
    for (const [name,allowed] of Object.entries(permitted)) if (!allowed) blockedWriteTools.add(name);
    tools = tools.filter(tool=>!blockedWriteTools.has(tool.name));
    if (calendarContextRelevant) systemBlocks.push({type:'text',text:'Current direct calendar instructions: '+JSON.stringify(calendarOperations)+
      '. Complete these instructed direct changes. Decisions on stored pending requests are separate and use resolve_approval. A declined proposal or a constraint correction alone leaves other appointments unconfirmed; check a suitable alternative or clarify the remaining choice.'});
  }
  if (calendarContextRelevant && meetingRequest && input.surface==='owner_dm' && input.authority==='owner' && input.userId===profile.user.slack_user_id
    && !ownerOutreachAuthorized && !input.forceToolOnFirstTurn && !input.extraInstruction) {
    blockedWriteTools.add('message_colleague');
    tools=tools.filter(tool=>tool.name!=='message_colleague');
    systemBlocks.push({type:'text',text:'This scheduling instruction authorizes calendar work. Separate colleague outreach has not been requested. Complete the requested check or calendar action and use its normal invitation/update delivery.'});
  }
  if (ambiguousBookingClock) {
    for (const name of ['create_meeting','move_meeting','update_meeting','hold_slot','book_floating_block']) blockedWriteTools.add(name);
    tools = tools.filter(tool => !blockedWriteTools.has(tool.name));
  }
  if (exactBookingRequested && !ambiguousBookingClock && !meetingExplorationOnly) {
    systemBlocks.push({type:'text',text:'The requester asked for this booking. After resolving its time and participants, use create_meeting for the requested slot. A search result alone neither books the meeting nor sends an approval. The booking handler checks current conflicts and supplies the actionable approval when needed.'});
  }
  const negativeReaction = socialClassification?.kind === 'social'
    && socialClassification.social?.direction === 'reaction'
    && socialClassification.social?.sentiment === 'negative';

  // Calendar exploration withholds calendar actions, not unrelated requested
  // work (for example saving the participant's stated working hours). Pure
  // negative feedback and prose retries still withhold every write.
  // Prose-only mode also strips every write tool. Used by the
  // dateVerifier retry path so a date-typo retry can't fire a fresh
  // calendar mutation. Reads (get_calendar / find_available_slots /
  // get_my_tasks / recall_*) stay available so Sonnet can re-verify state
  // while she rewrites the wording.
  if (negativeReaction || !tools.some(t => t.name === 'create_approval') || !tools.some(t => t.name === 'check_join_availability')) existingInviteSubject = undefined;
  if (existingInviteSubject) logger.info('Checking organizer invitation', { threadTs });
  if (existingInviteSubject) systemBlocks.push({type:'text',text:'The requester wants the owner to join their existing invitation. Check the stated meeting with check_join_availability using the original subject. The organizer keeps the invitation. The check can route a needed attendance decision. Report its actual result in one or two sentences.'});
  if (negativeReaction || !tools.some(t => t.name === 'create_approval')) consultOwnerQuote = undefined;
  if (consultOwnerQuote) systemBlocks.push({type:'text',text:
    'The requester explicitly asks you to consult the owner. Complete that request through create_approval, using the existing request when the same decision is already pending. For a concrete calendar exception, first obtain a checked owner_approval_candidate from find_available_slots (owner_hours_exception_requested=true for an owner-hours exception). Copy that candidate into payload.deferred_action with tool=create_meeting and the exact subject, start, end and resolved attendees, then create_approval. A precheck verdict alone does not supply a replayable action. If unresolved booking details prevent a safe deferred action but the owner can already answer the question, use the existing freeform approval with the known facts and missing details stated explicitly; gather those details before sending any invitation. A normal free slot needs no policy exception, but an explicit request for the owner’s decision can use freeform. Do not claim the approval was raised until its receipt succeeds. The visible owner question must stand alone: name the requester, purpose, requested change, date, time and timezone, duration when known, and the actual reason a decision is needed. Use the conversation and verified calendar facts; ask only for a detail essential to that decision. Report the actual delivery receipt to the requester. This authorizes the consultation, not a calendar change. Request context (data): '+JSON.stringify({current:consultOwnerQuote,background:consultBackground})});
  // A new explicit hold is authorized only for the unambiguous interval just
  // validated by the same availability spine. Failure leaves an empty allowlist.
  if (checkRequestedHold) {
    holdOnlyWindows ??= new Map();
    systemBlocks.push({type:'text',text:holdOnlyWindows.size
      ? 'The requester explicitly asked to hold this time now. Its exact interval has been checked and is available. Place the internal hold now using the checked interval, then report its actual expiry. The later decision about an invitation remains separate.'
      : 'The requested hold has no unambiguous verified available interval yet. Explain the actual check result or clarify the unresolved clock. A hold has not been placed.'});
  }
  const readOnly = !!consultOwnerQuote || !!existingInviteSubject || input.proseOnly === true || meetingExplorationOnly || !!requestedException || negativeReaction;
  if (readOnly || holdOnlyWindows) {
    const canHold = !readOnly && !!holdOnlyWindows?.size && tools.some(t => t.name === 'hold_slot');
    // The tools on a status/selection turn describe what can happen NOW.
    // Expose the actual route from an expired offer to a new, verified choice.
    const priorOfferReceipt = conversationHistory.at(-1)?.toolSummaries?.some(line => line.startsWith('[find_available_slots '));
    if (!existingInviteSubject && (unresolvedHoldSelection || priorOfferReceipt) && meetingExplorationOnly && !input.proseOnly && !negativeReaction
      && input.channel === 'slack' && input.authority === 'colleague' && input.userId !== profile.user.slack_user_id
      && tools.some(t => t.name === 'hold_slot') && tools.some(t => t.name === 'find_available_slots')) {
      if (unresolvedHoldSelection) {
        const {MAX_HOLDS_PER_MEETING} = await import('../../db/slotHolds');
        systemBlocks.push({type:'text',text:`A colleague may hold up to ${MAX_HOLDS_PER_MEETING} choices for one meeting. When they request more, ask which times to keep, within that limit.`});
      }
      systemBlocks.push({ type: 'text', text: `If the requester asks about a previous hold or invitation, use its actual status. If they reported sending an invitation themselves, first use get_calendar to check for that shared invitation on the discussed date. A busy interval alone cannot identify it. A matching shared invite may already reserve this time; report its actual duration and leave it in place. For a status question report only confirmed actions. If they request a tentative hold and an earlier choice has gone stale or is unclear, use find_available_slots with candidate_slots to recheck the discussed date, start and duration. If two durations or choices are plausible, clarify that detail. Offer the verified interval in their clock and ask them to select it for an internal hold. You can place that hold on their selection without an Outlook invitation.${tools.some(t => t.name === 'create_meeting') ? ' You can also send an invitation when they authorize an actual booking.' : ''}` });
    }
    const calendarExploration = meetingExplorationOnly && !consultOwnerQuote && !existingInviteSubject
      && !input.proseOnly && !requestedException && !negativeReaction && !holdOnlyWindows;
    // Asking the owner to decide an unresolved meeting question is not a
    // calendar mutation. The authenticated requester may need that route
    // while exploring a solution, before they can pick a concrete slot.
    const canConsultForRequest = calendarExploration && schedulingDm
      && input.userId!==profile.user.slack_user_id
      && socialClassification?.kind==='task' && !continuedRefusal;
    const canAsk = (!!consultOwnerQuote || !!requestedException || canConsultForRequest)
      && !input.proseOnly && !negativeReaction && tools.some(t => t.name === 'create_approval');
    // An owner counter still has to update the tracked request. Its resolver
    // checks the bound decision and replacement action; withholding it here
    // strands both the owner and the requester after an otherwise valid search.
    const canResolveRequest = calendarExploration && isOwnerPath
      && !!contextualApprovalDecisions?.length && tools.some(t=>t.name==='resolve_approval');
    if (!canAsk) requestedException = undefined;
    if(canConsultForRequest) systemBlocks.push({type:'text',text:
      'You may raise the current meeting question through create_approval when it needs the owner’s judgment, a rule exception or identification of an event outside the requester’s view. An ordinary permitted search needs no approval. Check what you can first; use an existing pending request for the same decision. A real owner-only blocker should reach the owner with the known facts, rather than sending the requester to ask or asking permission to ask. A concrete calendar change uses the normal structured approval; an unresolved question grants no calendar change. Calendar execution remains unavailable on this exploratory turn.'});
    const calendarWrites = new Set(['create_meeting','move_meeting','update_meeting','delete_meeting',
      'book_floating_block','set_event_category','hold_slot','revert_last_auto_move',
      'set_work_schedule_override','check_calendar_health','manage_calendar_issue','create_approval','resolve_approval']);
    for (const name of WRITE_TOOLS) {
      if (calendarExploration && !calendarWrites.has(name)) continue;
      if (!(canHold && name === 'hold_slot') && !(canAsk && name === 'create_approval')
        && !(canResolveRequest && name === 'resolve_approval')) blockedWriteTools.add(name);
    }
    const before = tools.length;
    tools = tools.filter(t => !blockedWriteTools.has(t.name));
    if (canHold) {
      tools = tools.map(t => t.name === 'hold_slot'
        ? { ...t, input_schema: { ...t.input_schema, required: ['action', 'start_iso', 'end_iso'], properties: {
          ...(t.input_schema.properties as Record<string, unknown>), action: { type: 'string', enum: ['hold'] },
        } } } : t);
    }
    logger.info('Orchestrator — filtered turn write tools', {
      proseOnly: input.proseOnly === true, meetingExplorationOnly, negativeReaction, canHold,
      before, after: tools.length, dropped: before - tools.length,
    });
  }

  // v3.1.6 — don't re-fire a mutation on a bare acknowledgment of a
  // just-completed action. Real bug: "Done, renamed to X" → owner says
  // "Perfect, thanks" → Sonnet re-ran update_meeting and DOWNGRADED the title.
  // Guard fires only when BOTH hold:
  //   (a) the classifier says this turn is NOT a task (a bare "thanks"/social
  //       ack is kind 'other'/'social'; an explicit "change it to Y" is 'task'
  //       → writes stay), AND
  //   (b) the PREVIOUS assistant turn already executed a write (its action-tape
  //       markers like "[update_meeting OK …]" are in the history).
  // The (b) condition is what preserves "Want me to change X?" → "yes, thanks":
  // that prior turn fired NO write (it only offered), so writes stay and the
  // approval executes. Acks only get blocked when the action was already done.
  if (isOwnerPath && socialClassification && socialClassification.kind !== 'task') {
    const lastAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant');
    if (lastAssistant) {
      // An approval GRANT ("ok" to a pending approval) is NOT an ack of a
      // finished action — exclude create_approval + resolve_approval from BOTH
      // the marker detection and the strip. Otherwise a prior-turn `[create_approval OK`
      // (the escalation) + a bare "ok" (the grant) reads as an ack of completed
      // work and strips resolve_approval → the grant can't resolve, forcing a
      // second "yes". A prior CALENDAR mutation still triggers, so "thanks" after
      // "Done, renamed X" still can't re-fire update_meeting; a re-fired
      // create_approval is caught by dedup anyway.
      const ackGuardTools = new Set(
        // Accepting an unresolved health warning is distinct from repeating
        // the calendar mutation just completed. Issue resolution is idempotent
        // and still requires an actual issue identity in its handler.
        [...WRITE_TOOLS].filter(t => t !== 'create_approval' && t !== 'resolve_approval' && t !== 'manage_calendar_issue'),
      );
      const priorTurnMutated = [...ackGuardTools].some(t => lastAssistant.content.includes(`[${t} OK`));
      if (priorTurnMutated) {
        for (const name of ackGuardTools) blockedWriteTools.add(name);
        const before = tools.length;
        tools = tools.filter(t => !ackGuardTools.has(t.name));
        systemBlocks.push({type:'text',text:'The current message is an acknowledgement after completed work. Acknowledge briefly, or record an unresolved issue decision the person just gave. Do not replay the earlier status, options or explanation unless the current message asks for it.'});
        logger.info('Orchestrator — ack-after-completed-action: stripped write tools (no re-mutation on "thanks")', {
          kind: socialClassification.kind, before, after: tools.length,
        });
      }
    }
  }

  // Approval-bound thread lock. When the owner is replying in a thread
  // that's the terminal DM of a pending approval, restrict Sonnet's tools
  // to resolve_approval + list_pending_approvals only. Forces engagement
  // with the approval — she can't drift into find_available_slots,
  // create_meeting, get_calendar, etc., and turn an approval thread into
  // a fresh booking conversation. The amend ping-pong rails (text-shape
  // counter) can carry clarifying questions like "what time?" through
  // this constraint.
  if (
    isOwnerPath
    && input.threadTs
    && input.proseOnly !== true  // proseOnly already handled above
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAwaitingOwnerRequests } = require('../../db/requests') as
        typeof import('../../db/requests');
      const pending = getAwaitingOwnerRequests(profile.user.slack_user_id);
      const boundApprovals = pending.filter(r =>
        r.kind === 'approval' && r.terminal_dm_msg_ts === input.threadTs,
      );
      if (boundApprovals.length >= 1) {
        // v3.0.5 — `message_colleague` added. Owner saying "tell him" /
        // "let her know" / "give him the answer" in a thread bound to an
        // approval should let Maelle ACT on both fronts in one turn: close
        // the approval AND ping the colleague who's waiting on the answer.
        // Pre-fix she'd resolve_approval but the message_colleague tool was
        // filtered out, so her draft promised the ping with no tool call
        // behind it — claim-checker caught the lie but couldn't retry
        // because the tool wasn't in scope, and the colleague never heard
        // the outcome.
        const APPROVAL_BOUND_TOOLS = new Set([
          'resolve_approval',
          'list_pending_approvals',
          'message_colleague',
          // v3.2.x — the owner is never limited from acting on his own approval.
          // The original lock assumed the only valid reply was a clean yes/no on
          // the EXACT pending action — but real replies REDIRECT it ("no, move it
          // instead of cancelling"; "book a different time"). Locking those out
          // trapped the owner (the cancel→move / bad-hour→good-time breaks). The
          // owner keeps the full scheduling toolset in an approval thread so he
          // can resolve OR pivot in one turn; the pending approval is still in his
          // prompt, so awareness/closure isn't lost. Only NON-scheduling tools
          // (web, person-writes, knowledge) stay filtered — they can't bear on a
          // scheduling decision and would just be drift.
          'get_calendar', 'get_free_busy', 'find_available_slots',
          'create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting',
          'check_join_availability',
        ]);
        // v3.2.1 (#120 / Yariv) — escape hatch for a TRAPPED recovery. When a
        // bound approval's deferred action failed mid-replay needing a
        // parameter (e.g. ask_location_mode → location_mode_unspecified), the
        // owner-path thread was stuck: only resolve_approval was available, and
        // it just re-ran the identical broken replay (the Yariv loop, 5×). Let
        // the bound approval's OWN deferred-action tool through so Sonnet can
        // complete it directly (e.g. move_meeting with is_online=true). This is
        // on-topic for the approval, not drift — every OTHER tool stays
        // filtered, so the anti-drift guard is intact.
        for (const r of boundApprovals) {
          try {
            const det = JSON.parse(r.details_json ?? '{}') as { deferred_action?: { tool?: string } };
            const deferredTool = det.deferred_action?.tool;
            if (typeof deferredTool === 'string' && deferredTool.length > 0) {
              APPROVAL_BOUND_TOOLS.add(deferredTool);
            }
          } catch { /* unparseable details — leave the base allow-list */ }
        }
        const before = tools.length;
        tools = tools.filter(t => APPROVAL_BOUND_TOOLS.has(t.name));
        logger.info('Orchestrator — approval-bound thread, locked tool scope', {
          threadTs: input.threadTs,
          boundApprovalIds: boundApprovals.map(r => r.id),
          toolsBefore: before,
          toolsAfter: tools.length,
        });
      }
    } catch (err) {
      logger.warn('Orchestrator — approval-bound-thread filter threw, leaving tools unchanged', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // Diagnostic: log the scope decision + the tool-count effect so we can
  // see Module G hits vs misses in production logs. Cheap; only on owner
  // turns when the flag is on.
  if (toolScopes !== undefined) {
    const allOwnerToolsCount = getSkillTools(profile, 'owner', undefined, input.channel).length;
    logger.info('Module G — tool scope applied', {
      scopes: toolScopes,
      toolsShipped: tools.length,
      toolsAllOwner: allOwnerToolsCount,
      savedTools: allOwnerToolsCount - tools.length,
    });
  }

  return {
    messages,
    systemBlocks,
    tools,
    supportedOperations,
    blockedWriteTools,
    holdOnlyWindows,
    continuedRefusal,
    existingInviteSubject,
    existingInviteStart,
    existingInviteLocale,
    withdrawalId,
    firmWindowBooking,
    searchBeforeReply,
    consultOwnerQuote,
    calendarOperations,
    decisionReportLocale,
    priorMeetingState,
    requestedOptionCount,
    optionsReplyLocale,
    singleZoneOptions,
    exactBookingRequested,
    requestedException,
    model,
    maxTokens,
    turnSenderRole,
    turnPersonSlackId,
    socialActive,
    socialClassification,
    resolvedMeetingAttendees,
    resolvedOptionalAttendees,
    participantContext:resolvedAttendeesBlock,
    resolvedMeetingAttendeeGroups,
    ordinaryCreateAfterOtherMeeting,
    contextualApprovalDecisions,
    standaloneBookingApproval,
    requireAttendeeAvailability,
    exactRequestClock,
    requestedSearchWindow,
    meetingRequest,
    ownerSettings,
    availabilityQuestionDetected,
    availabilityPrecheckToolSummaries,
    availabilityChecks,
    availabilityAlternatives,
    bookingClockQuestion,
  };
}
