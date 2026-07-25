import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../../llm/client';
import { MODEL_SONNET } from '../../llm/models';
import { buildSystemPromptParts } from './systemPrompt';
import { classifyTurn, type OwnerIntentClassification } from '../social/classifyTurn';
import { chooseSocialDirective, formatDirectiveForPromptBlock, type SocialDirective, noDirective } from '../social/stateMachine';
import { getSkillTools, WRITE_TOOLS } from '../../skills/registry';
import { buildSocialContextBlock, buildPersonWorkContextBlock, getSummarySessionByThread, getOutreachLifecycle } from '../../db';
import { getActiveJobsForThread } from '../../tasks';
import { DateTime } from 'luxon';
import logger from '../../utils/logger';
import { trimHistory, extractActionTape, stampHistoryTime } from './turnHelpers';
import type { OrchestratorInput } from './index';

const anthropic = getAnthropicClient();

export async function buildTurnContext(input: OrchestratorInput) {
  const { userMessage, conversationHistory, threadTs, profile } = input;

  // v2.5.4 Bug 3 — MPIM with non-owner members forces colleague-context.
  // Pre-v2.5.4 the prompt unlocked owner-level rules whenever isOwnerInGroup
  // was true. That leaked subjects / attendees / project names into
  // colleague-readable threads when owner asked things like "am I free?".
  // Owner direction (Calendly / Julia thread, 2026-05-05): in any MPIM with
  // non-owner members, treat the conversation as colleague-shaped — tools
  // restricted, narration sanitized, even when owner is the typer. Owner
  // retains AUTH (his typed asks still execute via the colleague-allowed
  // tools that have rule-compliance gates). For owner-only data (memory,
  // preferences, full calendar narration) he asks in his private DM.
  // isOwnerInGroup stays true so social classification + people-memory
  // path still recognizes "owner is typing"; the override here only
  // affects tool gating + prompt framing + handler senderRole.
  const mpimWithOthers = !!(input.isMpim && input.mpimMemberIds &&
    input.mpimMemberIds.some(id => id !== profile.user.slack_user_id));
  if (mpimWithOthers && input.senderRole === 'owner') {
    logger.info('orchestrator — MPIM with non-owner: forcing colleague-context', {
      actualTyper: input.userId,
      mpimMembers: input.mpimMemberIds,
      threadTs: input.threadTs,
    });
    input.senderRole = 'colleague';
  }

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
  // v2.8.5 — no assistant-thread gating: always try setStatus when we have
  // channel+thread context. Slack rejects non-panel calls with
  // channel_not_found / not_in_assistant_thread, which the catch in
  // setAssistantStatus already swallows at debug level. (The old v2.7.3 panel
  // registry this used to consult was removed in the v3.7.x cleanup.)
  if (input.app && input.channelId && input.threadTs) {
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
  //                 discards scopes for tool selection — registry.ts:486 — and
  //                 systemPrompt.ts:319 is built on toolScopes being undefined
  //                 there, so computing them off-path only skews the prose)
  // Result.scope feeds getSkillTools below (toolScopes); result.intent drives
  // the social directive. Both fail open (intent→other, scopes→general).
  let toolScopes: string[] | undefined;
  // v3.1.2 (D) — captured from classifyTurn so a deterministic analyzeCalendar
  // pre-check can fire below for owner buffer/free-time questions, replacing
  // the leaky meetings.ts:2044 prompt rule.
  let isFreeTimeInquiry = false;
  // v3.6.4 — participant names classifyTurn extracted from a scheduling
  // request, and the internal colleagues we deterministically resolved from
  // them. Threaded into the search so a known colleague is never dropped
  // because Sonnet forgot to resolve the name (Lori 07-08, Simon 07-09).
  let turnMeetingPeople: string[] = [];
  let resolvedMeetingAttendees: string[] = [];
  let resolvedAttendeesBlock = '';
  // v3.2.6 (6.4) — never run the social directive/coda on a non-interactive
  // (routine/system) turn; a scheduled report isn't a conversation.
  const needIntent = socialActive && input.interactive !== false && !!userMessage && userMessage.trim().length > 1;
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
      // Last few turns of context so the classifier can read conversation
      // state (e.g. "Maelle asked a social question and they answered" →
      // open vs "her question went unanswered, now closing out" → closing).
      const recentContext = conversationHistory
        .slice(-4)
        .map(m => `${m.role === 'user' ? (input.senderName ?? profile.user.name.split(' ')[0]) : profile.assistant.name}: ${m.content.slice(0, 280)}`)
        .join('\n');
      const turnResult = await classifyTurn({
        anthropic,
        message: userMessage,
        profile,
        needIntent,
        needScopes,
        needMeetingPeople,
        senderRole: turnSenderRole,
        senderName: input.senderName,
        recentContext: recentContext || undefined,
      });

      if (needScopes) toolScopes = turnResult.scope.scopes;
      if (isOwnerPath) isFreeTimeInquiry = turnResult.freeTimeInquiry === true;
      if (needMeetingPeople) turnMeetingPeople = turnResult.meetingPeople ?? [];
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
        // v3.0 follow-up — subject decisions + engagement signals + topic-beat
        // recording moved to end-of-chat (`runSubjectReconciliation` in
        // src/memory/capturePass.ts). Per-turn classifier still produces
        // kind/category/sentiment/direction/topic_label which drive the
        // social directive (engage/celebrate/etc.) for THIS turn — no
        // subject-row writes happen per turn anymore.
        socialDirective = chooseSocialDirective({
          personSlackId: turnPersonSlackId,
          classification: socialClassification,
          ownerTimezone: profile.user.timezone,
        });
        // Stamp the subject as raised the moment we commit to surfacing it
        // proactively. last_assistant_initiated_at is the linchpin the picker's
        // 72h re-raise defer, the raise→ignored decay, and the daily/24h
        // initiation gates all key on. The old stamp site lived in the
        // task-turn coda block, which got hard-disabled (codaEligible=false);
        // the proactive-directive path that replaced it never picked up the
        // marking, so every subject sat at last_assistant_initiated_at=NULL and
        // the whole rotation/decay machinery was dead. (raise_new has no
        // subject yet — it's stamped when reconciliation creates the subject.)
        if (socialDirective.mode === 'continue' && socialDirective.subjectId) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { markSubjectRaised } = require('../../db/socialSubjects') as
              typeof import('../../db/socialSubjects');
            markSubjectRaised(socialDirective.subjectId);
          } catch (err) {
            logger.warn('markSubjectRaised (proactive directive) threw — continuing', {
              err: String(err).slice(0, 200),
            });
          }
        }
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
  // participant names classifyTurn extracted into KNOWN INTERNAL colleagues
  // (single unambiguous people_memory match only — never fuzzy-guessed). The
  // resolved set is (a) threaded into the search via skillContext so
  // find_available_slots can't run a partial list, and (b) surfaced to Sonnet as
  // a resolved-participants block so she searches instead of asking who they are
  // / for an email she already has. External / unknown names are deliberately
  // left out — they never block showing options; their email matters only at
  // booking. Fail-open: any error → empty, Sonnet's normal flow takes over.
  if (turnMeetingPeople.length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolveNamedInternalAttendees } = require('../../memory/resolveAttendeeEmails') as
        typeof import('../../memory/resolveAttendeeEmails');
      const { resolved, unresolved } = resolveNamedInternalAttendees({
        names: turnMeetingPeople,
        ownerEmail: profile.user.email,
        ownerName: profile.user.name,
      });
      resolvedMeetingAttendees = resolved.map(r => r.email);
      if (resolved.length > 0 || unresolved.length > 0) {
        const ownerFirst = profile.user.name.split(' ')[0];
        const sections: string[] = ['## MEETING PARTICIPANTS (deterministic — use this, do not re-derive)'];
        if (resolved.length > 0) {
          const list = resolved.map(r => `- ${r.name} <${r.email}>`).join('\n');
          sections.push(`Known internal colleagues, resolved from the directory — do NOT call find_slack_user for these and do NOT ask who they are or for their email. I have ALREADY added them to this turn's find_available_slots search; search now and offer times that work for everyone, never propose without them:\n${list}`);
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
  const messages: Anthropic.MessageParam[] = trimHistory([
    ...conversationHistory.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.role === 'user'
        ? stampHistoryTime(m.content, m.ts, profile.user.timezone)
        : m.content,
    })),
    currentTurn,
  ]);

  // Model routing — Sonnet everywhere. We used to route colleagues to Haiku
  // to save cost, but colleague turns carry the same judgment load as owner
  // turns (owner-must-include gate, participant construction, security
  // signals, RULE 3 promise tracking) and Haiku produced subtler failure
  // modes — malformed coord args, missed RULE 3 triggers, over-sensitive to
  // conversational idioms. The stable-solution bias is "one strong model
  // everywhere" over "two models with a cost gap and a behavior gap".
  const MODEL_OWNER     = MODEL_SONNET;
  const MODEL_COLLEAGUE = MODEL_SONNET;
  const model = input.senderRole === 'colleague' ? MODEL_COLLEAGUE : MODEL_OWNER;

  // max_tokens — now carries THINKING headroom. The orchestrator runs adaptive
  // thinking at `high` (Sonnet-5 retry, see the callClaude site), and thinking
  // shares the output budget with the reply + tool_use blocks. The old 1400/2700
  // (sized for thinking-OFF, response-text-only) would truncate the moment the
  // model reasons — the exact stop_reason:max_tokens failure the migration guide
  // warns of, worsened by Sonnet 5's ~30%-denser tokenizer. These are a CEILING,
  // not a target: adaptive throttles actual spend per turn, so easy turns stay
  // cheap; reply brevity stays a PROMPT concern, not a max_tokens one.
  const maxTokens = input.senderRole === 'colleague' ? 12000 : 16000;

  // Build system prompt in two parts for prompt caching:
  //   static  → skills rules (large, profile-driven) — cached for 5 min
  //   dynamic → date/time, prefs, people memory, auth — uncached
  // v1.6.14 — focus contacts: MPIM participants get their FULL memory loaded
  // into the prompt; everyone else gets the 10-entry tail. In 1:1 DMs or
  // channels there are no focus contacts, so the whole list is capped at 10.
  const focusSlackIds = input.isMpim && input.mpimMemberIds
    ? new Set(input.mpimMemberIds.filter(id => id !== profile.user.slack_user_id))
    : undefined;
  const promptParts = buildSystemPromptParts(profile, input.senderRole, input.senderName, input.isOwnerInGroup, focusSlackIds, input.isMpim, input.isChannel, input.threadTs, input.userId, input.mpimMemberIds, toolScopes);

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
      actionTapeBlock = `\n\nACTIONS YOU TOOK IN THIS THREAD:\n${tape.map(t => `- ${t}`).join('\n')}\n\nWhen the owner asks about anything in this list, lead with what YOU did — not what the calendar currently shows. If he says it didn't happen or the calendar shows otherwise, do NOT insist on this list — re-check via get_calendar and reconcile honestly. The list is what the tool reported, not ground truth.`;
    }
  }

  // v3.1.4 (Y4) — colleague-path: carry the event(s) this colleague just
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
        colleagueBookingBlock = `## MEETINGS YOU REQUESTED (use these IDs to change one)\n\nThese are meetings you asked ${ownerFirst} to set up. If you ask to change one ("add someone", "rename it", "move it", "cancel it"), use the matching event_id below — do NOT get_calendar to re-find it. You can add/rename directly; a MOVE or CANCEL of one of these needs ${ownerFirst}'s OK, so route it to him for approval:\n\n${lines.join('\n')}`;
      }
    } catch (err) {
      logger.warn('colleagueBookingBlock builder threw — proceeding without it', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // v3.4.2 (F1) — owner-path equivalent of colleagueBookingBlock: the events
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
      const viewed = getViewedThreadEvents(input.threadTs).filter(v => !createdIds.has(v.eventId)).slice(0, 10);
      if (evs.length > 0 || viewed.length > 0) {
        const ownerFirst = profile.user.name.split(' ')[0];
        const parts: string[] = [];
        if (evs.length > 0) {
          const lines = evs.slice(-10).map(e => `  - "${e.subject}" — event_id=${e.eventId}`);
          // v3.4.2 (F2) — active-window anchor for bare day references. Pure
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
  //   - WORK context (role, reports_to, response speed, collaboration, recent
  //     work exchanges + bookings) — ALWAYS on. It is what makes Maelle
  //     competent with this person; P6 forbids gating work-competence behind
  //     the optional social skill, and pre-split `skills.social: false` cost a
  //     tenant all of it as collateral.
  //   - SOCIAL context (engagement rank, initiation cadence, personal notes) —
  //     gated on the toggle (v2.2.3 #3), which is what the toggle is for.
  // Both keyed on isOwnerTyping ON PURPOSE — that's the "who is the human"
  // question, not a data gate. In a clamped MPIM input.userId is the OWNER's id,
  // so falling to the colleague branch would build a per-person block out of the
  // owner's own row and inject it into the group thread.
  const personWorkBlock = isOwnerTyping
    ? ''
    : buildPersonWorkContextBlock(input.userId, {
        // MPIM / channel: the answer is read by people other than the speaker,
        // so the block drops the parts only the speaker is entitled to.
        sharedSurface: input.isMpim === true || input.isChannel === true,
      });
  const socialBlock = (isOwnerTyping || !socialActive)
    ? ''
    : buildSocialContextBlock(input.userId, input.profile.user.timezone, input.profile.assistant.name);

  // v2.2 — Social Directive block. Populated by the pre-pass above.
  // When mode === 'none' this is empty and has no effect on the prompt.
  const socialDirectiveBlock = formatDirectiveForPromptBlock(socialDirective);

  // v2.6.1 (D4) — recent-outbound context block. Populated by the Slack
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
  if (input.senderRole === 'colleague' && userMessage && userMessage.trim().length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { precheckAvailability } = require('../../utils/availabilityPreCheck') as
        typeof import('../../utils/availabilityPreCheck');
      const result = await precheckAvailability({
        message: userMessage,
        profile,
        // v3.3.7 (#125b) — the day a bare time refers to often lives a
        // message earlier ("מחר... 17:00" → "13:00/13:30?").
        recentThread: conversationHistory.slice(-4),
      });
      if (result.ran && result.promptBlock) {
        availabilityPrecheckBlock = result.promptBlock;
      }
      // A slot the colleague ASKED about that we confirmed bookable IS a slot
      // we offered them — record it into the SAME stash find_available_slots
      // feeds, so the hold gate (which validates "was this offered?") passes on
      // "is he free at X? → yes → hold it". One source of truth: both
      // availability surfaces (search + point-check) record what they confirmed;
      // pre-fix only the search did, so a point-check confirmation couldn't be held.
      if (result.ran && input.channelId && result.verdicts.length > 0) {
        const bookableStarts = result.verdicts
          .filter(v => v.bookable)
          .map(v => {
            const dt = DateTime.fromISO(`${v.date}T${v.time}`, { zone: profile.user.timezone });
            return dt.isValid ? { start: dt.toISO()! } : null;
          })
          .filter((s): s is { start: string } => s !== null);
        if (bookableStarts.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { recordOfferedSlots } = require('../../utils/offeredSlotsStash') as
            typeof import('../../utils/offeredSlotsStash');
          recordOfferedSlots({
            channelId: input.channelId,
            threadTs: input.threadTs,
            timezone: profile.user.timezone,
            slots: bookableStarts,
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
  if (input.senderRole === 'colleague' && input.channelId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOfferedSlots } = require('../../utils/offeredSlotsStash') as
        typeof import('../../utils/offeredSlotsStash');
      const offered = getOfferedSlots(input.channelId, input.threadTs);
      if (offered && offered.length > 0) {
        offeredSlotsBlock = `## SLOTS ALREADY OFFERED IN THIS CONVERSATION (binding)
These exact instants were offered to this colleague earlier and are still on the table:
${offered.map(s => `- ${s.display} → start_iso ${s.startIso}`).join('\n')}
If their message picks one of these — by time ("20:30"), weekday+time ("Tuesday 20:30"), or position ("the second one") — it means THAT exact instant: use its start_iso verbatim in any create_meeting / validation call. NEVER re-resolve the date from a weekday word; the offer above is the authoritative date.`;
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
  // meetings.ts:2044 "USE THE TOOL — don't math by hand" prompt rule that
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

  // v3.1.2 (B2) — recently-surfaced calendar issues. When the calendar_health
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
        recentCalendarIssuesBlock = `## RECENT CALENDAR ISSUES (last 6h — use these IDs, do not re-search by subject)\n\nThe calendar_health routine or the brief surfaced the following issues recently. If the owner says "delete it" / "fix it" / "cancel it" referring to one of these, USE the event_id (or peer_event_id when the reference is to the second event) directly with delete_meeting / move_meeting / update_meeting. Do NOT do a fresh get_calendar subject search — the event may have already vanished externally while you still have the id from the surface.\n\n${lines.join('\n')}`;
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
  // language into the UNCACHED dynamic block every turn can't decay. Fires only
  // for scripts that actually drift (Hebrew/Cyrillic/Arabic); Latin-script input
  // returns null and falls through to the static rule. Voice messages are
  // exempt — they reply in English regardless (systemPrompt VOICE rule, #12).
  let languageDirectiveBlock = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { detectMessageLanguage } = require('../../utils/detectMessageLanguage') as
      typeof import('../../utils/detectMessageLanguage');
    const isVoice = typeof userMessage === 'string' && userMessage.trimStart().startsWith('[Voice message]');
    let lang = isVoice ? null : detectMessageLanguage(userMessage);
    if (!lang && !isVoice) {
      // A contentless reply — "11:15", "yes", "ok", an emoji — carries no
      // language signal, so detectMessageLanguage returns null and the per-turn
      // LANGUAGE override vanishes. That let a stored/attendee language_pref pull
      // the reply into another language (English booking → Hebrew confirmation on
      // "11:15"). Carry the language forward from the most recent prior message
      // that DID carry one (the human's, not Maelle's own past replies) so the
      // conversation's language sticks across short replies.
      for (let i = conversationHistory.length - 1; i >= 0; i--) {
        const m = conversationHistory[i];
        if (m.role !== 'user') continue;
        const prior = detectMessageLanguage(m.content);
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
  // reads the most recent inbound (people.resolveOutboundLanguageForPerson),
  // default English — so an English-writing colleague never gets a Hebrew DM off
  // a stale one-off pref (the Ayala bug). Stamp the RAW current-message script
  // only (not the carried-forward value): a contentless "yes" detects null and
  // leaves the prior signal intact. Colleague senders only; best-effort.
  try {
    if (input.senderRole === 'colleague' && input.userId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { detectMessageLanguage } = require('../../utils/detectMessageLanguage') as
        typeof import('../../utils/detectMessageLanguage');
      const raw = detectMessageLanguage(userMessage);
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

  const systemBlocksDynamic = [
    languageDirectiveBlock,
    priorOutboundBlock,
    availabilityPrecheckBlock,
    resolvedAttendeesBlock,
    offeredSlotsBlock,
    ownerLocationBlock,
    freeTimePrecheckBlock,
    recentCalendarIssuesBlock,
    promptParts.dynamic,
    threadContextBlock,
    actionTapeBlock,
    colleagueBookingBlock,
    ownerThreadEventsBlock,
    personWorkBlock,
    socialBlock,
    socialDirectiveBlock,
  ].filter(Boolean).join('\n\n');

  const systemBlocks: Anthropic.TextBlockParam[] = promptParts.static
    ? [
        { type: 'text', text: promptParts.static, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam,
        { type: 'text', text: systemBlocksDynamic } as Anthropic.TextBlockParam,
      ]
    : [{ type: 'text', text: systemBlocksDynamic } as Anthropic.TextBlockParam];

  // v2.7.7 (Module G) — intent-aware tool scoping. `toolScopes` was resolved
  // in the v3.0.6 merged classifier pre-pass above (classifyTurn), gated on
  // profile.behavior.intent_aware_tools + owner turn. Colleagues use the
  // static COLLEAGUE_ALLOWED_TOOLS allowlist (toolScopes stays undefined).
  // Fails open: any classifier error left toolScopes undefined → getSkillTools
  // ships every tool as before.

  // Tools are collected from active skills — filtered by sender role and
  // (when Module G is on) by the classifier-picked scope set.
  // Colleagues get the static restricted subset; owner gets scope-filtered.
  let tools = getSkillTools(profile, input.senderRole, toolScopes);

  // v2.8.6 — prose-only mode strips every write tool. Used by the
  // dateVerifier retry path so a date-typo retry can't fire a fresh
  // calendar mutation. Reads (get_calendar / find_available_slots /
  // get_my_tasks / recall_*) stay available so Sonnet can re-verify state
  // while she rewrites the wording.
  if (input.proseOnly === true) {
    const before = tools.length;
    tools = tools.filter(t => !WRITE_TOOLS.has(t.name));
    logger.info('Orchestrator — proseOnly mode: filtered out write tools', {
      before, after: tools.length, dropped: before - tools.length,
    });
  }

  // v3.1.6 (L3) — don't re-fire a mutation on a bare acknowledgment of a
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
        [...WRITE_TOOLS].filter(t => t !== 'create_approval' && t !== 'resolve_approval'),
      );
      const priorTurnMutated = [...ackGuardTools].some(t => lastAssistant.content.includes(`[${t} OK`));
      if (priorTurnMutated) {
        const before = tools.length;
        tools = tools.filter(t => !ackGuardTools.has(t.name));
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
    const allOwnerToolsCount = getSkillTools(profile, 'owner', undefined).length;
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
    model,
    maxTokens,
    turnSenderRole,
    turnPersonSlackId,
    socialActive,
    socialClassification,
    resolvedMeetingAttendees,
  };
}
