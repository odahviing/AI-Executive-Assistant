/**
 * Outreach skill — core, transport-agnostic.
 *
 * The universal "how Maelle speaks to people on behalf of the owner" skill.
 * Every transport (Slack today; email, WhatsApp, Teams later) supports
 * messaging someone, so this skill stays in CORE_MODULES. Per-transport
 * extras (Slack channel lookup, email thread search, etc.) live in their
 * own transport-bound skills (see src/skills/slackTransport.ts).
 *
 * Tools owned here:
 *   - message_colleague — send a DM (or a channel post when channel_id is
 *     provided) on behalf of the owner. Routes via the Connection interface.
 *
 * History:
 *   v2.6.4 — find_slack_channel split out into SlackTransportSkill so this
 *            skill is genuinely universal (not Slack-flavored).
 *   v1.8.11 — moved from src/core to src/skills; Connection-based sends.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import { DateTime } from 'luxon';
import {
  createOutreachJob,
  updateOutreachJob,
  upsertPersonMemory,
  getPersonMemory,
} from '../db';
import { getLinkedRequestIdForOutreach, getOutreachJobByRequestId } from '../db/jobs';
import { reactActivityComplete } from '../utils/threadActivity';
import { updateRequest, getRequest, getChildRequests, getOpenRequestsForColleague, getAwaitingOwnerRequests } from '../db/requests';
import { toTimerInstant, parseDetails } from '../core/requests/types';
import { resolveStatedInstant, StatedTimeClarificationError } from '../utils/weTimeResolver';
import { logActivity } from '../core/requests/logActivity';
import { closeRequest } from '../core/requests/closeRequest';
import { calcResponseDeadline, colleagueWorkTimeBaseFromNow, isColleagueSendDeferred } from '../utils/responseDeadline';
import { getConnection } from '../connections/registry';
import type { CoreInfoFromTransport } from '../connections/types';
import logger from '../utils/logger';

export class OutreachCoreSkill implements Skill {
  id = 'outreach' as const;
  name = 'Outreach';
  description = 'Universal outreach — the activity of "talking to someone on behalf of the owner." Transport-agnostic; the actual send goes through whichever Connection (Slack, email, WhatsApp) is registered for the agent. Always core.';

  getTools(profile: UserProfile): Anthropic.Tool[] {
    return [
      {
        name: 'message_colleague',
        description: `Send a message to a colleague — either as a DM or as a post in a Slack channel.
Use when the user asks you to:
- "Go say hi to X"
- "Check in with Y and see how they are doing"
- "Tell Z that the meeting is confirmed"
- "Ask X if they have time this week"
- "Post this to #product and mention Anna"
- "Share this research in #marketing, tag Ben"

DM (default): sends privately to the colleague.
Channel post (Slack only): when the user specifies a channel (e.g. "post on #product"), post there and mention the colleague. Call find_slack_channel first if you don't have the channel ID. await_reply is ignored for channel posts.

You write the message in Maelle's voice — warm, natural, professional.
Only send messages the user explicitly asks for — never reach out to people on your own.`,
        input_schema: {
          type: 'object',
          properties: {
            colleague_slack_id: {
              type: 'string',
              description: 'Slack user ID of the colleague. If the user @mentioned them the ID is already in the message as "(slack_id: XXXXX)" or in WORKSPACE CONTACTS — use it directly. Otherwise call find_slack_user first.',
            },
            colleague_name: {
              type: 'string',
              description: 'Display name of the colleague',
            },
            colleague_tz: {
              type: 'string',
              description: 'Timezone of the colleague (from find_slack_user). Used to give context if they do not reply.',
            },
            message: {
              type: 'string',
              description: `The message to send. Write naturally in first person as ${profile.assistant.name}. Be warm and human. For channel posts, do NOT include the @mention — it is added automatically.`,
            },
            await_reply: {
              type: 'boolean',
              description: 'DM only: if true, wait for their reply and report back to the user. Ignored for channel posts.',
            },
            channel_id: {
              type: 'string',
              description: 'Slack channel ID to post in (e.g. "C1234567"). If provided, posts to the channel and mentions the colleague instead of sending a DM. Get this from find_slack_channel if needed.',
            },
            channel_name: {
              type: 'string',
              description: 'Human-readable channel name for confirmation (e.g. "product"). Only used alongside channel_id.',
            },
            send_at: {
              type: 'string',
              description: 'ISO 8601 datetime to send the message. Use when the user asks to reach out at a future time. Leave empty for the default: it goes out now if the recipient is inside their working hours, otherwise at their next work start.',
            },
            send_now: {
              type: 'boolean',
              description: 'true ONLY when the user explicitly asked for the message to go out right now, even outside the recipient\'s working hours. Omit otherwise.',
            },
            original_request_id: {
              type: 'string',
              description: 'For a send-now follow-up to an EXISTING message, pass its request_id from the earlier message_colleague result/history with send_now=true. This checks that exact original and sends its stored message only if still held; if already delivered, reports already sent without sending again. Omit for a genuinely new message or an explicitly requested intentional new send, even to the same person in the same thread. Never guess an ID or substitute a jobId.',
            },
            intent: {
              type: 'string',
              enum: ['meeting_reschedule'],
              description: 'REQUIRED when the message is about MOVING an existing meeting (not optional). Set to "meeting_reschedule" whenever you\'re relaying a request to shift / postpone / move / pull-forward / cancel an event that\'s already on the calendar — no matter who initiated it (owner asking to move his meeting, or colleague asking to move and you\'re relaying back to them after owner decides). When set, the `context` field MUST also be populated with { meeting_id, proposed_start, proposed_end }. Without this tag the colleague\'s reply gets classified as a NEW scheduling request and a duplicate coord spawns instead of patching the existing event — the actual move never happens. Omit ONLY when the message is about a brand-new meeting being scheduled fresh.',
            },
            context: {
              type: 'object',
              description: 'Optional. Intent-specific payload. For intent="meeting_reschedule", supply { meeting_id, meeting_subject, proposed_start, proposed_end } where proposed_start/end are ISO datetimes in the owner\'s timezone. meeting_id must come from get_calendar so the actual calendar event can be updated when the colleague approves.',
              properties: {
                meeting_id: { type: 'string', description: 'Calendar event ID from get_calendar (the existing meeting being rescheduled).' },
                meeting_subject: { type: 'string', description: 'The existing meeting\'s subject as it appears on the calendar.' },
                proposed_start: { type: 'string', description: 'Proposed new start time as ISO datetime (e.g. "2026-04-19T09:00:00").' },
                proposed_end: { type: 'string', description: 'Proposed new end time as ISO datetime.' },
                original_start: { type: 'string', description: 'Optional — the meeting\'s current start time (ISO). Helps narration.' },
                original_end: { type: 'string', description: 'Optional — the meeting\'s current end time (ISO).' },
              },
            },
            proposed_slots: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional, but STRONGLY RECOMMENDED when your message proposes specific dates / times the colleague might act on (e.g. "Wed 29 Apr noon works for the bank visit"). Pass the proposed start timestamps as ISO strings (owner timezone OK). The brief verifier uses this at report time to check whether the colleague actually booked a meeting at one of your proposed slots — so Maelle can say "they booked it at noon" instead of "still waiting to hear back" when the invite has already landed on the calendar.',
            },
            subject_keyword: {
              type: 'string',
              description: 'Optional, used alongside proposed_slots. A short keyword from the meeting topic ("bank visit", "Privacy GTM", "interview with the candidate") that will appear in the calendar event subject when it\'s booked. The verifier fuzzy-matches event subjects against this so a third party who books on their side still gets matched back to this outreach.',
            },
            attachments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  slack_file_url: {
                    type: 'string',
                    description: 'Slack permalink or url_private of a file shared earlier in this conversation (image, PDF, etc.).',
                  },
                  filename: {
                    type: 'string',
                    description: 'Optional filename override for the upload.',
                  },
                },
                required: ['slack_file_url'],
              },
              description: 'Optional. Attach Slack files (images, PDFs) to the outgoing message — DM or channel post, immediate or scheduled. Pass file URLs from earlier in the conversation — e.g. an image the owner shared, or a chart a colleague suggested. Each file is downloaded with the bot token and re-uploaded under the same thread.',
            },
          },
          required: ['colleague_slack_id', 'colleague_name', 'message', 'await_reply'],
        },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    if (toolName === 'message_colleague' && args.original_request_id !== undefined) {
      if (context.authority !== 'owner' || context.userId !== context.profile.user.slack_user_id
          || typeof args.original_request_id !== 'string' || !args.original_request_id.trim()
          || args.send_now !== true || args.send_at) {
        return { ok: false, error: 'invalid_original_request', _must_reply_with: 'I could not use that original message reference. No message was sent.' };
      }
      // The same lock covers lookup, held replacement and confirmed outcome.
      // A retry waits for this exact operation rather than starting another send.
      const { withRequestLock } = await import('../core/requests/resolver');
      return withRequestLock(args.original_request_id, () => this.executeOutreach(toolName, args, context, args.original_request_id as string));
    }
    return this.executeOutreach(toolName, args, context);
  }

  private async executeOutreach(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
    originalRequestId?: string,
  ): Promise<unknown | null> {
    const userId = context.profile.user.slack_user_id;

    switch (toolName) {
      case 'message_colleague': {
        // v2.4.2 — boundary-validate colleague_slack_id (Sonnet sometimes
        // hallucinates a slug like "oran_frenkel" instead of pulling the
        // real Slack ID from WORKSPACE CONTACTS, which then explodes at
        // sendDirect with user_not_found). resolveSlackId does format check
        // + people_memory lookup by name. On miss we return a clean tool
        // error so Sonnet falls back to find_slack_user.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolveSlackId } = require('../utils/resolveSlackId') as typeof import('../utils/resolveSlackId');
        const idResolution = resolveSlackId(
          args.colleague_slack_id as string | undefined,
          args.colleague_name as string | undefined,
        );
        if (idResolution.was_hallucinated) {
          logger.warn('message_colleague — colleague_slack_id hallucinated', {
            rejected: idResolution.rejected_input,
            colleagueName: args.colleague_name,
            resolvedTo: idResolution.slack_id ?? null,
          });
        }
        if (!idResolution.slack_id) {
          return {
            ok: false,
            error: 'unknown_colleague',
            message: `I don't have a Slack ID for "${args.colleague_name}" — call find_slack_user with their name first, then retry message_colleague with the returned slack_id.`,
          };
        }
        const colleagueSlackId = idResolution.slack_id;

        if (originalRequestId) {
          const original = getRequest(originalRequestId);
          const job = original && getOutreachJobByRequestId(original.id);
          const details = original ? parseDetails<Record<string, unknown>>(original) ?? {} : {};
          const destination = typeof args.channel_id === 'string' ? args.channel_id : undefined;
          if (!original || original.kind !== 'outreach' || original.owner_user_id !== userId
              || original.target_slack_id !== colleagueSlackId || !job
              || job.owner_user_id !== userId || job.colleague_slack_id !== colleagueSlackId
              || (details.channel_id || undefined) !== destination) {
            return { ok: false, error: 'invalid_original_request', _must_reply_with: 'I could not use that original message reference. No message was sent.' };
          }
          // A send-now replacement is already linked by parent_request_id.
          // Follow only that exact successful replacement, never same-person history.
          const replacement = original.closure_reason === 'superseded_by_send_now'
            ? getChildRequests(original.id).filter(r => r.kind === 'outreach' && r.owner_user_id === userId
              && r.target_slack_id === colleagueSlackId
              && (parseDetails<Record<string, unknown>>(r)?.channel_id || undefined) === destination).map(r => getOutreachJobByRequestId(r.id))
              .find(j => j?.owner_user_id === userId && j.colleague_slack_id === colleagueSlackId && j.sent_at)
            : undefined;
          const sentAt = job.sent_at || replacement?.sent_at;
          if (sentAt) return {
            ok: true, sent: false, already_sent: true, request_id: original.id, sent_at: sentAt,
            _must_reply_with: `That message to ${job.colleague_name} was already sent; I didn't send it again.`,
          };
          if (original.state !== 'in_flight' || original.phase !== 'outreach:scheduled'
              || original.next_check_handler !== 'send_scheduled_outreach') {
            return {
              ok: false, error: 'original_request_not_sendable', request_id: original.id,
              _must_reply_with: 'That original message is no longer held for sending. I cannot confirm it was delivered, so I did not send it again. Check the conversation before requesting a new send.',
            };
          }
          // This reference denotes the existing operation: replay its stored
          // decision, including channel/files, instead of reconstructing its text.
          args = { ...args, message: job.message, await_reply: job.await_reply === 1,
            intent: job.intent, context: job.context_json ? JSON.parse(job.context_json) : undefined,
            proposed_slots: job.proposed_slots ? JSON.parse(job.proposed_slots) : undefined,
            subject_keyword: job.subject_keyword,
            attachments: Array.isArray(details.attachments) ? (details.attachments as Array<{sourceUrl: string; filename?: string}>).map(a => ({ slack_file_url: a.sourceUrl, filename: a.filename })) : undefined,
          };
        }

        // gh#Yael-25min — an owner reply in the SAME thread as an approval THIS
        // colleague raised is presumptively about deciding that approval, never
        // a fresh outbound message to them (R2: replay the decision, never
        // re-derive it). Pre-fix, a free-text amend to an undecided approval
        // ("not tonight, Tuesday! 25 mins at 22:45", replying in the approval's
        // own daily thread) got sent here as a brand-new — and wrong-context —
        // outreach instead of resolve_approval(verdict='amend'): the approval's
        // stored terms never updated, and the colleague received a message about
        // an unrelated calendar event (2026-08-09, req_1786281967442_i5xm1). A
        // deterministic block is the fix, not more prompt text — the binding
        // rules already told Sonnet to call resolve_approval here and it didn't.
        //
        // approval-amend-routes-through-reschedule-not-merge (bouncer overturn,
        // 2026-08-10) — `owner_dm_thread_ts` is the SHARED daily thread (R8 —
        // every ask of the day nests under one root, ownerDailyThread.ts), so a
        // genuinely unrelated "tell Yael I'll be late" typed there hits this
        // block too, with the old error text falsely promising a retry would
        // get through. It deterministically wouldn't: the gate is keyed on
        // thread + colleague, neither of which retrying message_colleague (same
        // or different wording) can change. A content-based auto-bypass was
        // considered and rejected as UNSAFE to build tonight: approval subjects
        // are free text the model itself writes and often name this SAME
        // colleague as part of describing the ask ("Quick sync with Michal"),
        // and the proven bug's own amend text ("not tonight, Tuesday! 25 mins
        // at 22:45") names neither the colleague nor the subject — so a
        // same-turn content check would both misfire on real unrelated
        // messages AND silently let a real amend back through unblocked,
        // regressing the proven bug this gate exists to prevent (W2: no
        // autonomous code on a guess). There is no safe deterministic signal
        // here without asking, so the honest answer is: not this tool. The
        // message now says so plainly instead of promising a retry that can't
        // work, and gives the one path that structurally CAN: resolve the
        // approval first (any verdict closes or bounces it, freeing this
        // colleague), or have the owner say it outside this thread.
        if (context.authority === 'owner') {
          const stuckApproval = getAwaitingOwnerRequests(userId).find(r =>
            r.kind === 'approval'
            && r.id !== args._fulfilling_request_id
            && r.id !== args._fulfilling_request_id
            && r.requester_slack_id === colleagueSlackId
            && (r.owner_dm_thread_ts === context.threadTs || r.terminal_dm_msg_ts === context.threadTs),
          );
          if (stuckApproval) {
            logger.warn('message_colleague — blocked, colleague has an open approval anchored to this thread', {
              colleagueSlackId, requestId: stuckApproval.id, threadTs: context.threadTs,
            });
            return {
              ok: false,
              error: 'pending_approval_from_this_colleague',
              message: `${args.colleague_name as string} has an open approval waiting on your decision in THIS thread (${stuckApproval.id}${stuckApproval.subject ? ` — "${stuckApproval.subject}"` : ''}). If this message is deciding or countering that ask, call resolve_approval(approval_id='${stuckApproval.id}', verdict=<approve|reject|amend>, ...) instead — that updates the stored terms and relays your real decision to them, whichever verdict it is. If it's genuinely unrelated: do NOT retry message_colleague here — this block is keyed on the thread and colleague, not on your wording, so a retry with the same or different text will hit the identical refusal. Either resolve this approval first (freeing this colleague for a fresh message), or tell the user the unrelated message needs to go from outside this approval's thread.`,
            };
          }
        }

        // #149 — send_at becomes the paired request's next_check_at (db/jobs.ts →
        // runSendScheduledOutreach), and spine timers are UTC instants. The model
        // writes a bare owner-local clock, which BOTH readers got wrong:
        // `new Date(bare)` parses in the PROCESS zone, and the sweep compares
        // against SQLite's UTC `now` — so a scheduled DM went out one owner-offset
        // late. Anchor once, here, where the owner's zone is known.
        const sendAtRaw = args.send_at as string | undefined;
        let sendAt: string | undefined;
        try {
          sendAt = sendAtRaw ? (toTimerInstant(resolveStatedInstant({
            startIso: sendAtRaw, statedZone: 'home', homeTz: context.profile.user.timezone,
          }).startIso, context.profile.user.timezone) ?? undefined) : undefined;
        } catch (err) {
          if (err instanceof StatedTimeClarificationError) return err.toToolResult();
          throw err;
        }
        if (sendAtRaw && !sendAt) {
          return {
            ok: false,
            error: 'bad_send_at',
            message: `send_at "${sendAtRaw}" isn't a parseable ISO 8601 datetime. Pass an owner-local wall-clock ("2026-07-28T09:00:00") or an explicit offset.`,
          };
        }

        // An authorized outreach engages the recipient; directory search does
        // not. Collect transport core info before responseDeadline's shared
        // availability path reads the store for send floors and reply timers.
        // The auto-tier store write preserves person/owner corrections to the
        // name and timezone. A missing tz in a successful read clears a stale
        // Slack temp reading; an unavailable read must not clear it. Null means
        // a confirmed missing recipient and must not mint a person. Model args
        // supply only a fallback name and an unpersisted fallback timer zone.
        const connection = getConnection(userId, 'slack');
        let coreInfo: CoreInfoFromTransport | null | undefined;
        try {
          coreInfo = await connection?.collectCoreInfo?.(colleagueSlackId);
        } catch (err) {
          logger.warn('message_colleague — recipient profile read failed; zone unknown for this send', {
            colleagueSlackId, err: String(err).slice(0, 200),
          });
        }
        if (coreInfo !== null) {
          const existingColleague = getPersonMemory(colleagueSlackId);
          upsertPersonMemory({
            slackId:  colleagueSlackId,
            name:     coreInfo?.displayName || existingColleague?.name?.trim() || (args.colleague_name as string),
            email:    coreInfo?.email,
            timezone: coreInfo?.timezone,
            // A real users.info read that succeeded and carried no `tz`.
            timezoneReadingAbsent: !!coreInfo && !coreInfo.timezone,
          });
        }

        const colleagueTzForDeadline = (args.colleague_tz as string | undefined) ?? context.profile.user.timezone;
        const recipientTime = { slackId: colleagueSlackId, ownerTimezone: context.profile.user.timezone };

        // Owner rule (colleague-sends-respect-recipient-work-hours; 2026-08-19
        // "check timezone when reaching to colleague, work week and time zone")
        // — every message_colleague send lands in the RECIPIENT's working time,
        // judged on their own local working day (stored zone, work hours and
        // dated travel via the shared business-time walk), never the owner's.
        //   - send_at: floored to the recipient's first work time at/after the
        //     requested instant (or now, whichever is later), so a requested
        //     time on their non-work day is never what the owner is told fires.
        //   - no send_at: sent now inside their hours, otherwise held to their
        //     next work start through the same scheduled-send timer.
        //   - send_now=true (the owner explicitly asked for immediate delivery,
        //     without a send_at): sent now, unfloored.
        // A recipient with no known zone uses the existing fallback: the tool's
        // colleague_tz, else the owner's zone with standard hours (#M3).
        let effectiveSendAt = sendAt;
        const explicitImmediate = !sendAt && args.send_now === true;
        if (sendAt) {
          const anchorMs = Math.max(Date.parse(sendAt), Date.now());
          effectiveSendAt = colleagueWorkTimeBaseFromNow(colleagueTzForDeadline, anchorMs, recipientTime);
        } else if (!explicitImmediate) {
          const gate = isColleagueSendDeferred(colleagueTzForDeadline, recipientTime);
          if (gate.deferred) effectiveSendAt = gate.deferredTo;
        }
        const heldForRecipientHours = !sendAt && !!effectiveSendAt;
        const isFuture = effectiveSendAt ? Date.parse(effectiveSendAt) > Date.now() : false;
        // An explicit "send it now" in the owner thread that is holding a
        // scheduled message to this colleague replaces that held copy, so the ask
        // never reaches them twice (R3); an interrupted attempt is reported as
        // uncertain, including a crash immediately before the transport call.
        // Under the same request
        // lock the sweep fires it under, the held copy's timer changes to an
        // outcome-only expiry (SUSPEND_MS) BEFORE this send: if the sweep got there first, its copy
        // is the delivery and this call sends nothing more; otherwise it cannot
        // fire during this send. A confirmed send cancels it. A DEFINITE non-send
        // (no connection, or Slack refused before delivering) restores its
        // original timer, so the scheduled message still stands. An UNKNOWN
        // outcome (Slack 'error' or a throw once the send was attempted — it may
        // have landed) is treated as possibly delivered: the held copy is
        // cancelled and the owner is told to check, never that nothing went out
        // (owner ruling 2026-09-23; same never-resend-unconfirmed rule as
        // runner.ts's closeUnconfirmedSend). The copy is never left timerless.
        const SUSPEND_MS = 60 * 60 * 1000;
        const suspended: Array<{ id: string; nextCheckAt: string | null }> = [];
        const stillHeld = (id: string) => {
          const current = getRequest(id);
          return !!current && current.state === 'in_flight' && current.phase === 'outreach:scheduled'
            && (current.next_check_handler === 'send_scheduled_outreach' || current.next_check_handler === 'outreach_expiry');
        };
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const heldLock = () => originalRequestId
          ? async <T>(id: string, work: () => Promise<T>): Promise<T> => id === originalRequestId ? work()
            : (require('../core/requests/resolver') as typeof import('../core/requests/resolver')).withRequestLock(id, work)
          : (require('../core/requests/resolver') as typeof import('../core/requests/resolver')).withRequestLock;
        const cancelHeld = async (closureReason = 'superseded_by_send_now'): Promise<string[]> => {
          const replaced: string[] = [];
          for (const copy of suspended.splice(0)) {
            await heldLock()(copy.id, async () => {
              if (!stillHeld(copy.id)) return;
              const closed = closeRequest({ id: copy.id, state: 'cancelled', closureReason, closedBy: 'owner', skipChildren: true });
              if (closed.ok && closed.state === 'cancelled' && closed.reason !== 'already terminal') replaced.push(copy.id);
            });
          }
          return replaced;
        };
        const restoreHeld = async (): Promise<Record<string, unknown>> => {
          const kept: string[] = [];
          for (const copy of suspended.splice(0)) {
            await heldLock()(copy.id, async () => {
              if (!stillHeld(copy.id)) return;
              updateRequest(copy.id, { nextCheckAt: copy.nextCheckAt, nextCheckHandler: 'send_scheduled_outreach' });
              if (copy.nextCheckAt) kept.push(copy.nextCheckAt);
            });
          }
          if (!kept.length) return {};
          const when = DateTime.fromISO(kept[0]).setZone(context.profile.user.timezone).toFormat('EEEE \'at\' HH:mm');
          return {
            scheduled_copy_kept: true,
            _must_reply_with: `Nothing reached ${args.colleague_name as string} just now; the message scheduled for ${when} still stands.`,
          };
        };
        // Every attempted send with an unknown outcome may have landed, including
        // a first send with no held copy. Cancel any held copy and report uncertainty.
        const unconfirmedHeld = async (): Promise<Record<string, unknown>> => {
          const cancelled = await cancelHeld('superseded_by_unconfirmed_send_now');
          return {
            delivery_unconfirmed: true,
            ...(cancelled.length ? { scheduled_copy_cancelled: true } : {}),
            _must_reply_with: `I tried to send it to ${args.colleague_name as string} now but couldn't confirm it went through, so it may have reached them. ${cancelled.length ? "I cancelled the scheduled copy so they won't get it twice — please" : 'Please'} check the conversation before sending again.`,
          };
        };
        if (explicitImmediate) {
          const held = (originalRequestId ? [getRequest(originalRequestId)!] : getOpenRequestsForColleague(userId, colleagueSlackId)).filter(r =>
            r.kind === 'outreach' && r.next_check_handler === 'send_scheduled_outreach'
            && r.target_slack_id === colleagueSlackId
            && (originalRequestId || (r.origin_channel === context.channelId && r.origin_thread_ts === context.threadTs)));
          let heldAlreadyDelivered = false;
          for (const copy of held) {
            await heldLock()(copy.id, async () => {
              if (stillHeld(copy.id)) {
                suspended.push({ id: copy.id, nextCheckAt: getRequest(copy.id)?.next_check_at ?? null });
                updateRequest(copy.id, { nextCheckAt: new Date(Date.now() + SUSPEND_MS).toISOString(), nextCheckHandler: 'outreach_expiry' });
              } else if (getOutreachJobByRequestId(copy.id)?.sent_at) {
                heldAlreadyDelivered = true;
              }
            });
          }
          if (heldAlreadyDelivered && suspended.length === 0) {
            logger.info('message_colleague — held copy was delivered by its timer; not sending again', { colleagueSlackId });
            return {
              ok: true,
              sent: false,
              already_delivered_by_schedule: true,
              _must_reply_with: `The scheduled message to ${args.colleague_name as string} went out just now, so I didn't send it a second time.`,
            };
          }
        }
        // channelIdArg is resolved here (before deadline) so awaitReplyEffective
        // can zero it for channel posts — see the zeroing comment below.
        const channelIdArg = typeof args.channel_id === 'string' ? args.channel_id : undefined;
        // Channel posts can never receive a DM-thread reply, so await_reply is
        // meaningless and must be zeroed here — the prompt instruction at line
        // 57 is a hint to the model, not a code guarantee (W3). Zeroing at this
        // chokepoint prevents both the reply deadline and the expiry timer from
        // arming, so the outreach never closes 'expired' with a false no-response.
        const awaitReplyEffective = channelIdArg ? false : !!args.await_reply;

        const deadline = awaitReplyEffective && !isFuture
          ? calcResponseDeadline(colleagueTzForDeadline, recipientTime)
          : undefined;

        // v1.8.4 — intent + context for intent-routed reply dispatch
        const intent = typeof args.intent === 'string' ? args.intent : undefined;
        const contextPayload = args.context && typeof args.context === 'object'
          ? JSON.stringify(args.context)
          : undefined;

        // v2.1.4 — stash proposed_slots + subject_keyword on the outreach row
        // so the brief verifier can match third-party-booked meetings back to
        // this outreach. Only set when Sonnet actually supplied them.
        const proposedSlotsArg = Array.isArray(args.proposed_slots) ? args.proposed_slots as string[] : null;
        const proposedSlotsJson = proposedSlotsArg && proposedSlotsArg.length > 0
          ? JSON.stringify(proposedSlotsArg)
          : undefined;
        const subjectKeywordArg = typeof args.subject_keyword === 'string' && args.subject_keyword.trim()
          ? args.subject_keyword.trim()
          : undefined;

        // v2.2.7 — optional file attachments. Tool schema uses snake_case
        // slack_file_url for Sonnet ergonomics; SendOptions uses camelCase
        // sourceUrl. Map at the boundary.
        //
        // registrar fix (scheduled-first-outreach-send-not-gated-to-recipient-
        // hours, wf_29a0d866-021 round 2) — moved up from the DM-send branch
        // below so a SCHEDULED send (isFuture) can stash channel_id/
        // channel_name/attachments on the request too. Pre-fix, only
        // `message` + `await_reply` survived onto a deferred job — a
        // scheduled "post this to #product and tag Anna" or a scheduled DM
        // carrying a file silently became a bare DM with no attachment when
        // runSendScheduledOutreach later fired, because there was nowhere on
        // the row to read the channel or the file back from (R2: replay the
        // stored decision literally, never a downgraded reconstruction of it).
        const attachmentsArg = Array.isArray(args.attachments)
          ? (args.attachments as Array<{ slack_file_url: string; filename?: string }>).map(a => ({
              sourceUrl: a.slack_file_url,
              filename: a.filename,
            }))
          : undefined;
        const channelNameArg = typeof args.channel_name === 'string' ? args.channel_name : undefined;

        const jobId = createOutreachJob({
          // If this process dies during the replacement send, the held row's
          // outcome-only expiry closes this child too and tells the owner once.
          parentRequestId: suspended[0]?.id,
          owner_user_id: userId,
          owner_channel: context.channelId,
          owner_thread_ts: context.threadTs,
          colleague_slack_id: colleagueSlackId,
          colleague_name: args.colleague_name as string,
          colleague_tz: args.colleague_tz as string | undefined,
          message: args.message as string,
          await_reply: awaitReplyEffective ? 1 : 0,
          status: isFuture ? 'pending_scheduled' : 'sent',
          // Delivery is stamped only after Connection confirms the send.
          reply_deadline: deadline,
          // Only a DEFERRED send is "scheduled". Every other field here already
          // forks on isFuture; this one didn't, so a send_at already in the past
          // sent the DM immediately AND still armed send_scheduled_outreach at that
          // past instant — the sweep then sent it a SECOND time, and the row sat in
          // phase 'outreach:scheduled' forever (R3: never twice).
          scheduled_at: isFuture ? effectiveSendAt : undefined,
          intent,
          context_json: contextPayload,
          proposed_slots: proposedSlotsJson,
          subject_keyword: subjectKeywordArg,
          // The existing channel field also scopes exact-original references
          // after immediate delivery. Deferred files/name replay at timer fire.
          channel_id: channelIdArg,
          channel_name: isFuture ? channelNameArg : undefined,
          attachments: isFuture ? attachmentsArg : undefined,
        });

        // v3.0.5 (Path 2 stage 1) — duplicate paired-request block deleted.
        // `createOutreachJob` above already writes its own `requests` row via
        // the v2.7.1 bridge (`db/jobs.ts:createOutreachJob`), keyed on a
        // unique subject derived from the message preview. The block here
        // wrote a SECOND row with a generic "Waiting for reply from X" /
        // "Messaged X" subject — identical every time the same colleague
        // was messaged → idempotency_key collision → UNIQUE constraint
        // throws → `sendDirect` never runs → silent fail (the Yael bug
        // that triggered Path 2).

        logger.info('message_colleague — outreach row created', {
          jobId,
          colleague: args.colleague_name,
          isFuture,
          heldForRecipientHours,
          explicitImmediate,
          await_reply: awaitReplyEffective,
          skill_origin: 'outreach',
        });

        if (isFuture) {
          const scheduledDt = DateTime.fromISO(effectiveSendAt!).setZone(context.profile.user.timezone);
          // v3.1 (Path 2 Stage 6) — the actual scheduled DM post is driven by
          // the spine timer: createOutreachJob set the paired request's
          // next_check_handler='send_scheduled_outreach' (see db/jobs.ts +
          // core/requests/runner.ts:runSendScheduledOutreach). No separate
          // outreach_send task, and (v4.2.x) no `tasks` tracking row either —
          // get_my_tasks reads the requests spine (tasks/skill.ts:get_my_tasks →
          // getOpenRequestsForOwner), so the row it was supposedly "for" was
          // never read there; all it added was a second due_at with no
          // dispatcher behind it.
          const colleagueName = args.colleague_name as string;
          return {
            scheduled: true,
            jobId,
            request_id: getLinkedRequestIdForOutreach(jobId),
            scheduled_at: effectiveSendAt,
            _status: 'scheduled_not_sent',
            ...(heldForRecipientHours ? { held_for_recipient_work_hours: true } : {}),
            _note: heldForRecipientHours
              ? `${colleagueName} is outside their working hours, so the message is scheduled for their next work start, ${scheduledDt.toFormat('EEEE d MMM \'at\' HH:mm')} the user's time — NOT sent yet. Tell the user exactly this: "It's outside ${colleagueName}'s working hours, so I've scheduled it for ${scheduledDt.toFormat('EEEE at HH:mm')}, when their day starts." For a send-now follow-up, pass this result's request_id as original_request_id with send_now=true.`
              : `Message is scheduled for ${scheduledDt.toFormat('EEEE d MMM \'at\' HH:mm')} — NOT sent yet. Tell the user exactly this: "I've scheduled the message to ${colleagueName} for ${scheduledDt.toFormat('EEEE at HH:mm')}."`,
          };
        }

        // Not scheduled — send path. The person's row was already written by
        // the engagement-time pull above, before the timer math.
        // v1.6.8 — DON'T write to interaction_log here. The outreach_jobs row and
        // its paired request already track this message end-to-end (state, reply,
        // follow-up). Writing "Sent message: '...'" into people_memory makes
        // the LLM re-surface the message forever when asked about the person,
        // even after the outreach is resolved. Operational state belongs in
        // the operational tables; interaction_log is for social + relationship
        // context only.

        // v4.2.x — a fire-and-forget send (await_reply=false) ticks ✅ on Maelle's
        // last message in the owner's thread. This used to ride a `tasks` row
        // created with status='completed' just to trip createTask's react hook —
        // a third work-item record beside the request (lifecycle) and the
        // outreach_job (payload), with its own status enum and its own due_at that
        // no dispatcher served. The tick is the only thing that row did, so it
        // moved here and the row is gone. Two deliberate differences from the old
        // hook: the tick fires only AFTER a confirmed send (the createTask call
        // ran before it, so a send that then failed still got a ✅), and an
        // await_reply send still gets no tick — nothing is done yet.
        const tickThreadTs = awaitReplyEffective ? undefined : context.threadTs;

        // v3.1 (Path 2 Stage 6) — reply-deadline expiry is a spine timer:
        // createOutreachJob armed the paired request's
        // next_check_handler='outreach_expiry' from reply_deadline (db/jobs.ts +
        // core/requests/runner.ts:runOutreachExpiryOrDecision). No separate
        // outreach_expiry task.

        // v1.8.11 — send synchronously here through the Connection resolved
        // above (no _requires_slack_client dispatch to app.ts). Uses the owner's
        // Slack Connection for now; router-based resolution will kick in
        // per-recipient when EmailConnection / WhatsAppConnection land.
        if (!connection) {
          logger.error('message_colleague — Slack Connection not registered for profile', { userId });
          updateOutreachJob(jobId, { status: 'cancelled', reply_text: 'Connection not registered' });
          return { ok: false, error: 'connection_not_registered', ...(await restoreHeld()) };
        }

        // Channel post branch: prepend @mention so the colleague is pinged
        if (args.channel_id) {
          const mention = `<@${colleagueSlackId}>`;
          const fullText = `${mention} ${args.message as string}`;
          // registrar fix (outreach-immediate-channel-post-also-drops-
          // attachments) — attachmentsArg (computed above at :340 for the
          // scheduled-send replay) was never passed on THIS, the immediate
          // send path, so a channel post with a file silently dropped it
          // while the sibling DM branch below (sendOpts) already carried it.
          // Same defect the deferred-send fix (runner.ts:685-689) closed on
          // the scheduled-channel-post path — mirrored here.
          let outcome: Awaited<ReturnType<typeof connection.postToChannel>>;
          try {
            outcome = await connection.postToChannel(
              args.channel_id as string,
              fullText,
              attachmentsArg?.length ? { attachments: attachmentsArg } : undefined,
            );
          } catch (err) {
            updateOutreachJob(jobId, { status: 'cancelled', reply_text: 'Channel post outcome unknown' });
            return { ok: false, error: 'send_threw', detail: String(err).slice(0, 200), ...(await unconfirmedHeld()) };
          }
          if (!outcome.ok) {
            updateOutreachJob(jobId, { status: 'cancelled', reply_text: `Channel post failed: ${outcome.reason}` });
            const hint = outcome.reason === 'not_in_channel_private'
              ? `That channel is private and I haven't been invited. Ask an admin to add me, then try again.`
              : `Channel post failed: ${outcome.detail ?? outcome.reason}`;
            return { ok: false, error: outcome.reason, detail: hint, ...(await (outcome.reason === 'error' ? unconfirmedHeld() : restoreHeld())) };
          }
          const replacedScheduled = await cancelHeld();
          updateOutreachJob(jobId, { sent_at: new Date().toISOString() });
          if (tickThreadTs && !outcome.attachments_failed) reactActivityComplete(userId, tickThreadTs, jobId);
          // gh#52 (52-U2) — history/undo record of the send itself. Fail-soft,
          // fires only after the post is confirmed sent.
          logActivity({
            ownerUserId: userId,
            kind: 'outreach',
            subkind: 'channel_post',
            subject: `Posted to #${(args.channel_name as string | undefined) ?? args.channel_id as string} — mentioned ${args.colleague_name as string}`,
            initiatedBy: context.userId,
            initiatedByRole: context.authority,
            targetSlackId: colleagueSlackId,
          });
          logger.info('message_colleague — channel post sent', {
            jobId,
            request_id: getLinkedRequestIdForOutreach(jobId),
            channel: args.channel_name ?? args.channel_id,
            colleague: args.colleague_name,
            replacedScheduled,
          });
          return {
            ok: true,
            posted_to_channel: args.channel_name ?? args.channel_id,
            colleague_mentioned: args.colleague_name,
            jobId,
            request_id: getLinkedRequestIdForOutreach(jobId),
            ...(replacedScheduled.length ? { replaced_scheduled_copy: true } : {}),
            attachments_failed: outcome.attachments_failed ?? 0,
            _must_reply_with: outcome.attachments_failed
              ? `The text was posted, but ${outcome.attachments_failed} attachment(s) failed. Report this partial delivery; do not claim everything was sent or repeat the text.`
              : `One short sentence acknowledging the post, e.g. "Posted to #${args.channel_name ?? 'the channel'} with ${args.colleague_name} tagged."`,
          };
        }

        // DM branch: send directly to the colleague. attachmentsArg computed
        // above (moved up so a SCHEDULED send can persist it too).

        // v3.0.8 — thread continuity via requests spine. If there's an OPEN
        // request involving this colleague (as requester or target) and it
        // has a colleague-side thread anchor on it (origin_channel +
        // origin_thread_ts populated to the colleague's DM, not the owner's
        // DM), reply IN that thread instead of opening a new top-level DM.
        // Owner direction: use the request as the canonical conversation
        // anchor, not a separate column or time-window heuristic. The
        // request being OPEN is itself the "this conversation is still
        // active" signal; closed requests no longer anchor continuity.
        //
        // Owner-initiated outreach: origin_channel/origin_thread_ts get
        // updated post-send below to point at the colleague side, so the
        // SECOND outreach to the same colleague (while the first is still
        // open) threads back into the first.
        // Colleague-initiated requests: origin is already the colleague's
        // DM thread (set when their inbound created the request), so the
        // first outbound from Maelle to them threads naturally.
        // v3.0.8 — lookup the linked request_id for this outreach (created
        // moments earlier inside createOutreachJob's bridge). Used to (a)
        // exclude this request from the thread-anchor search, and (b) update
        // its origin_* post-send to point at the colleague side.
        const linkedRequestId = getLinkedRequestIdForOutreach(jobId);

        // v3.1.7 — record the OWNER's return thread on the outreach request so a
        // later colleague-reply relay (create_approval) threads back into the
        // owner's ORIGINAL conversation instead of a new top-level DM. This is
        // SEPARATE from origin_* (repurposed for colleague-side continuity just
        // below) — origin can't double as the owner return address once it's
        // pointed at the colleague side. Owner-initiated only; a colleague-
        // initiated outreach has no owner conversation thread to anchor.
        if (linkedRequestId && context.authority === 'owner' && /^D/.test(context.channelId) && context.threadTs) {
          try {
            updateRequest(linkedRequestId, {
              ownerDmChannel: context.channelId,
              ownerDmThreadTs: context.threadTs,
            });
          } catch (err) {
            logger.warn('message_colleague — owner return-thread anchor write failed (non-fatal)', {
              err: String(err).slice(0, 200),
            });
          }
        }

        let threadTsForSend: string | undefined;
        try {
          const openForColleague = getOpenRequestsForColleague(userId, colleagueSlackId);
          const anchor = openForColleague.find(r =>
            r.origin_thread_ts && r.origin_channel
            // Avoid picking the request we're about to write to itself —
            // the current outreach's request was created just above with
            // origin set to the owner's channel (will be updated post-send).
            && r.id !== linkedRequestId
            // A still-scheduled send has never reached the colleague, so its
            // origin is still the OWNER's thread — never a colleague-side anchor.
            && r.next_check_handler !== 'send_scheduled_outreach'
            && !(r.state === 'in_flight' && r.phase === 'outreach:scheduled')
            // Sanity: the recorded origin channel should look like a DM
            // (starts with 'D'). Owner-side origins are also 'D' so we
            // can't fully disambiguate, but coupled with "open colleague
            // request involving this colleague," DM-channel filter is the
            // best cheap signal we have.
            && /^D/.test(r.origin_channel),
          );
          if (anchor?.origin_thread_ts) {
            threadTsForSend = anchor.origin_thread_ts;
            logger.info('message_colleague — reusing open-request thread anchor', {
              jobId, colleagueSlackId, anchorRequestId: anchor.id,
              threadTs: anchor.origin_thread_ts,
            });
          }
        } catch (err) {
          logger.warn('message_colleague — thread-continuity lookup threw, sending top-level', {
            err: String(err).slice(0, 200),
          });
        }

        const sendOpts = {
          ...(threadTsForSend ? { threadTs: threadTsForSend } : {}),
          ...(attachmentsArg ? { attachments: attachmentsArg } : {}),
        };
        let outcome: Awaited<ReturnType<typeof connection.sendDirect>>;
        try {
          outcome = await connection.sendDirect(
            colleagueSlackId,
            args.message as string,
            Object.keys(sendOpts).length > 0 ? sendOpts : undefined,
          );
        } catch (err) {
          updateOutreachJob(jobId, { status: 'cancelled', reply_text: 'Send outcome unknown' });
          return { ok: false, error: 'send_threw', detail: String(err).slice(0, 200), ...(await unconfirmedHeld()) };
        }
        if (!outcome.ok) {
          updateOutreachJob(jobId, { status: 'cancelled', reply_text: `Send failed: ${outcome.reason}` });
          return { ok: false, error: outcome.reason, detail: outcome.detail, ...(await (outcome.reason === 'error' ? unconfirmedHeld() : restoreHeld())) };
        }
        const replacedScheduled = await cancelHeld();
        updateOutreachJob(jobId, { sent_at: new Date().toISOString() });
        // v2.1.5 — record the Slack ts + DM channel so follow-up sends
        // (post-approval confirmation, relay replies) can thread back
        // into this conversation instead of starting a fresh top-level
        // DM. Non-blocking: if the connection omitted either field we
        // just skip the update and behave like a legacy row.
        if (outcome.ts || outcome.ref) {
          updateOutreachJob(jobId, {
            dm_message_ts: outcome.ts,
            dm_channel_id: outcome.ref,
          });

          // v3.0.8 (option A — repurpose origin_* for outreach kind).
          // For owner-initiated outreach, the request's origin_channel /
          // origin_thread_ts start out pointing at the OWNER's DM (where
          // Idan typed the ask). After the outbound DM lands on the
          // colleague's side, update them to point at the colleague side
          // so subsequent message_colleague calls to this colleague reuse
          // the thread. Only do this on the FIRST send to anchor the
          // thread — the lookup above skips already-anchored requests
          // (origin_thread_ts already populated to a 'D...' channel).
          if (linkedRequestId && outcome.ref && outcome.ts) {
            try {
              updateRequest(linkedRequestId, {
                originChannel: outcome.ref,
                originThreadTs: threadTsForSend ?? outcome.ts,
              });
              logger.info('message_colleague — anchored request origin to colleague-side thread', {
                requestId: linkedRequestId, colleagueChannel: outcome.ref, threadTs: outcome.ts,
              });
            } catch (err) {
              logger.warn('message_colleague — failed to anchor request origin', {
                requestId: linkedRequestId, err: String(err).slice(0, 200),
              });
            }
          }
        }
        if (tickThreadTs && !outcome.attachments_failed) reactActivityComplete(userId, tickThreadTs, jobId);
        // shadow-dm-gap (2026-08-12) — mirror the OUTBOUND question to the
        // owner's shadow feed. Pre-fix, only a colleague's REPLY got mirrored
        // (postReply.ts Step 4.6) — the question that prompted it never did,
        // so the owner's shadow thread started mid-conversation with a reply
        // to a question he never saw. Same conversationKey convention this
        // spine already uses elsewhere for "conversation with a colleague"
        // shadows (resolver.ts's notifyRequesterOfDecision keys on
        // origin_thread_ts): threadTsForSend when we're continuing an
        // already-anchored thread, else this send's own ts, so a later
        // shadow of the same conversation threads under this one instead of
        // opening a fresh header. Fail-soft — never let a shadow hiccup
        // undo a confirmed send.
        try {
          const { shadowNotify } = await import('../utils/shadowNotify');
          const rawPreview = (args.message as string).replace(/\s+/g, ' ').trim();
          const preview = rawPreview.length > 350 ? `${rawPreview.slice(0, 350).trim()}…` : rawPreview;
          await shadowNotify(context.profile, {
            channel: context.channelId,
            threadTs: context.threadTs,
            action: 'Message sent',
            detail: `I → ${args.colleague_name as string}: "${preview}"`,
            conversationKey: threadTsForSend ?? outcome.ts ?? linkedRequestId ?? jobId,
            conversationHeader: `Conversation with ${args.colleague_name as string}`,
          });
        } catch (err) {
          logger.warn('message_colleague — shadowNotify for outbound DM failed, continuing', { err: String(err) });
        }
        // gh#52 (52-U2) — history/undo record of the send itself. Fail-soft,
        // fires only after the DM is confirmed sent.
        logActivity({
          ownerUserId: userId,
          kind: 'outreach',
          subkind: 'dm',
          subject: `Messaged ${args.colleague_name as string}`,
          initiatedBy: context.userId,
          initiatedByRole: context.authority,
          targetSlackId: colleagueSlackId,
        });
        logger.info('message_colleague — DM sent', {
          jobId,
          colleague: args.colleague_name,
          await_reply: !!args.await_reply,
          replacedScheduled,
          preview: (args.message as string).slice(0, 80),
        });
        return {
          ok: true,
          sent: true,
          jobId,
          request_id: linkedRequestId,
          colleague_name: args.colleague_name,
          await_reply: !!args.await_reply,
          ...(replacedScheduled.length ? { replaced_scheduled_copy: true } : {}),
          attachments_failed: outcome.attachments_failed ?? 0,
          _must_reply_with: outcome.attachments_failed
            ? `The text reached ${args.colleague_name}, but ${outcome.attachments_failed} attachment(s) failed. Report this partial delivery; do not claim everything was sent or repeat the text.`
            : args.await_reply
            ? `One short sentence confirming the send and that you will report back, e.g. "Sent — I\'ll let you know when ${args.colleague_name} replies."`
            : `One short sentence confirming the send, e.g. "Sent to ${args.colleague_name}."`,
        };
      }

      default:
        return null;
    }
  }

  getSystemPromptSection(_profile: UserProfile): string {
    // Intentionally empty, and deliberately so — same as AssistantSkill's.
    // OutreachCoreSkill is a CORE_MODULE (skills/registry.ts CORE_MODULES), and
    // the prompt assembly at systemPrompt.ts:450 maps over getActiveSkills(),
    // which returns SKILL_MAP entries only. Nothing returned here can ever
    // render. The OUTREACH prose that sat here until 2026-09-07 had therefore
    // never shipped, and every rule in it was already live in the
    // message_colleague description or on the parameter it governs — a strictly
    // better place for it, since a param description sits right next to the
    // field the model is filling in:
    //   - DM by default, channel post, find_slack_channel first, and "never
    //     reach out on your own": the message_colleague description above.
    //   - scheduled future sends: the send_at param.
    //   - the whole intent='meeting_reschedule' contract — mandatory on a move
    //     in EITHER direction, the { meeting_id, proposed_start, proposed_end }
    //     payload, meeting_id sourced from get_calendar, and what breaks when
    //     the tag is missing: the intent and context params.
    // So nothing was promoted out of it.
    return '';
  }
}
