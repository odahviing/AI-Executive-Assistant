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
} from '../db';
import { getLinkedRequestIdForOutreach } from '../db/jobs';
import { reactActivityComplete } from '../utils/threadActivity';
import { updateRequest, getOpenRequestsForColleague, getAwaitingOwnerRequests } from '../db/requests';
import { toTimerInstant } from '../core/requests/types';
import { calcResponseDeadline } from '../utils/responseDeadline';
import { getConnection } from '../connections/registry';
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
              description: 'ISO 8601 datetime to send the message. Use when the user asks to reach out at a future time. Leave empty to send now.',
            },
            intent: {
              type: 'string',
              enum: ['meeting_reschedule'],
              description: 'REQUIRED when the message is about MOVING an existing meeting (not optional). Set to "meeting_reschedule" whenever you\'re relaying a request to shift / postpone / move / pull-forward / cancel an event that\'s already on the calendar — no matter who initiated it (owner asking to move his meeting, or colleague asking to move and you\'re relaying back to them after owner decides). When set, the `context` field MUST also be populated with { meeting_id, proposed_start, proposed_end }. Without this tag the colleague\'s reply gets classified as a NEW scheduling request and a duplicate coord coord spawns instead of patching the existing event — the actual move never happens. Omit ONLY when the message is about a brand-new meeting being scheduled fresh.',
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
              description: 'Optional. Attach Slack files (images, PDFs) to the outgoing DM. Pass file URLs from earlier in the conversation — e.g. an image the owner shared, or a chart a colleague suggested. DM only — channel posts ignore this. Each file is downloaded with the bot token and re-uploaded to the recipient\'s DM under the same thread.',
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

        // gh#Yael-25min — an owner reply in the SAME thread as an approval THIS
        // colleague raised is presumptively about deciding that approval, never
        // a fresh outbound message to them (R3: replay the decision, never
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
        // 2026-08-10) — `owner_dm_thread_ts` is the SHARED daily thread (R10 —
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
        const sendAt = sendAtRaw
          ? (toTimerInstant(sendAtRaw, context.profile.user.timezone) ?? undefined)
          : undefined;
        if (sendAtRaw && !sendAt) {
          return {
            ok: false,
            error: 'bad_send_at',
            message: `send_at "${sendAtRaw}" isn't a parseable ISO 8601 datetime. Pass an owner-local wall-clock ("2026-07-28T09:00:00") or an explicit offset.`,
          };
        }
        const isFuture = sendAt ? Date.parse(sendAt) > Date.now() : false;

        const colleagueTzForDeadline = (args.colleague_tz as string | undefined) ?? context.profile.user.timezone;
        const deadline = args.await_reply && !isFuture
          ? calcResponseDeadline(colleagueTzForDeadline)
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

        const jobId = createOutreachJob({
          owner_user_id: userId,
          owner_channel: context.channelId,
          owner_thread_ts: context.threadTs,
          colleague_slack_id: colleagueSlackId,
          colleague_name: args.colleague_name as string,
          colleague_tz: args.colleague_tz as string | undefined,
          message: args.message as string,
          await_reply: args.await_reply ? 1 : 0,
          status: isFuture ? 'pending_scheduled' : 'sent',
          sent_at: isFuture ? undefined : new Date().toISOString(),
          reply_deadline: deadline,
          // Only a DEFERRED send is "scheduled". Every other field here already
          // forks on isFuture; this one didn't, so a send_at already in the past
          // sent the DM immediately AND still armed send_scheduled_outreach at that
          // past instant — the sweep then sent it a SECOND time, and the row sat in
          // phase 'outreach:scheduled' forever (R4: never twice).
          scheduled_at: isFuture ? sendAt : undefined,
          intent,
          context_json: contextPayload,
          proposed_slots: proposedSlotsJson,
          subject_keyword: subjectKeywordArg,
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
          await_reply: !!args.await_reply,
          skill_origin: 'outreach',
        });

        if (isFuture) {
          const scheduledDt = DateTime.fromISO(sendAt!).setZone(context.profile.user.timezone);
          // v3.1 (Path 2 Stage 6) — the actual scheduled DM post is driven by
          // the spine timer: createOutreachJob set the paired request's
          // next_check_handler='send_scheduled_outreach' (see db/jobs.ts +
          // core/requests/runner.ts:runSendScheduledOutreach). No separate
          // outreach_send task, and (v4.2.x) no `tasks` tracking row either —
          // get_my_tasks reads the requests spine (tasks/skill.ts:get_my_tasks →
          // getOpenRequestsForOwner), so the row it was supposedly "for" was
          // never read there; all it added was a second due_at with no
          // dispatcher behind it.
          return {
            scheduled: true,
            jobId,
            scheduled_at: sendAt,
            _status: 'scheduled_not_sent',
            _note: `Message is scheduled for ${scheduledDt.toFormat('EEEE d MMM \'at\' HH:mm')} — NOT sent yet. Tell the user exactly this: "I've scheduled the message to ${args.colleague_name as string} for ${scheduledDt.toFormat('EEEE at HH:mm')}."`,
          };
        }

        // Not scheduled — send path. Track the person.
        upsertPersonMemory({
          slackId:  colleagueSlackId,
          name:     args.colleague_name as string,
          timezone: args.colleague_tz as string | undefined,
        });
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
        const tickThreadTs = args.await_reply ? undefined : context.threadTs;

        // v3.1 (Path 2 Stage 6) — reply-deadline expiry is a spine timer:
        // createOutreachJob armed the paired request's
        // next_check_handler='outreach_expiry' from reply_deadline (db/jobs.ts +
        // core/requests/runner.ts:runOutreachExpiryOrDecision). No separate
        // outreach_expiry task.

        // v1.8.11 — resolve the Connection and send synchronously here, no
        // more _requires_slack_client dispatch to app.ts. Uses the owner's
        // Slack Connection for now; router-based resolution will kick in
        // per-recipient when EmailConnection / WhatsAppConnection land.
        const connection = getConnection(userId, 'slack');
        if (!connection) {
          logger.error('message_colleague — Slack Connection not registered for profile', { userId });
          updateOutreachJob(jobId, { status: 'cancelled', reply_text: 'Connection not registered' });
          return { ok: false, error: 'connection_not_registered' };
        }

        // Channel post branch: prepend @mention so the colleague is pinged
        if (args.channel_id) {
          const mention = `<@${colleagueSlackId}>`;
          const fullText = `${mention} ${args.message as string}`;
          const outcome = await connection.postToChannel(args.channel_id as string, fullText);
          if (!outcome.ok) {
            updateOutreachJob(jobId, { status: 'cancelled', reply_text: `Channel post failed: ${outcome.reason}` });
            const hint = outcome.reason === 'not_in_channel_private'
              ? `That channel is private and I haven't been invited. Ask an admin to add me, then try again.`
              : `Channel post failed: ${outcome.detail ?? outcome.reason}`;
            return { ok: false, error: outcome.reason, detail: hint };
          }
          if (tickThreadTs) reactActivityComplete(userId, tickThreadTs, jobId);
          logger.info('message_colleague — channel post sent', {
            jobId,
            channel: args.channel_name ?? args.channel_id,
            colleague: args.colleague_name,
          });
          return {
            ok: true,
            posted_to_channel: args.channel_name ?? args.channel_id,
            colleague_mentioned: args.colleague_name,
            jobId,
            _must_reply_with: `One short sentence acknowledging the post, e.g. "Posted to #${args.channel_name ?? 'the channel'} with ${args.colleague_name} tagged."`,
          };
        }

        // DM branch: send directly to the colleague
        // v2.2.7 — optional file attachments. Tool schema uses
        // snake_case slack_file_url for Sonnet ergonomics; SendOptions uses
        // camelCase sourceUrl. Map at the boundary.
        const attachmentsArg = Array.isArray(args.attachments)
          ? (args.attachments as Array<{ slack_file_url: string; filename?: string }>).map(a => ({
              sourceUrl: a.slack_file_url,
              filename: a.filename,
            }))
          : undefined;

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
        if (linkedRequestId && context.senderRole === 'owner' && context.channelId && context.threadTs) {
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
        const outcome = await connection.sendDirect(
          colleagueSlackId,
          args.message as string,
          Object.keys(sendOpts).length > 0 ? sendOpts : undefined,
        );
        if (!outcome.ok) {
          updateOutreachJob(jobId, { status: 'cancelled', reply_text: `Send failed: ${outcome.reason}` });
          return { ok: false, error: outcome.reason, detail: outcome.detail };
        }
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
          if (linkedRequestId && outcome.ref && outcome.ts && !threadTsForSend) {
            try {
              updateRequest(linkedRequestId, {
                originChannel: outcome.ref,
                originThreadTs: outcome.ts,
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
        if (tickThreadTs) reactActivityComplete(userId, tickThreadTs, jobId);
        logger.info('message_colleague — DM sent', {
          jobId,
          colleague: args.colleague_name,
          await_reply: !!args.await_reply,
          preview: (args.message as string).slice(0, 80),
        });
        return {
          ok: true,
          sent: true,
          jobId,
          colleague_name: args.colleague_name,
          await_reply: !!args.await_reply,
          _must_reply_with: args.await_reply
            ? `One short sentence confirming the send and that you will report back, e.g. "Sent — I\'ll let you know when ${args.colleague_name} replies."`
            : `One short sentence confirming the send, e.g. "Sent to ${args.colleague_name}."`,
        };
      }

      default:
        return null;
    }
  }

  getSystemPromptSection(profile: UserProfile): string {
    const firstName = profile.user.name.split(' ')[0];
    return `## OUTREACH

When the owner asks you to send someone a message, use message_colleague. Default is a DM; pass a channel_id for a Slack channel post (use find_slack_channel first to resolve the channel name). Pass send_at for scheduled future sends — those are driven by the task runner, not sent immediately.

Never reach out to people on your own. Only on explicit owner request. If the colleague might reply, set await_reply=true so we'll track the response.

## RESCHEDULE EXISTING MEETINGS — intent + context are MANDATORY

Any message_colleague that talks about MOVING / SHIFTING / RESCHEDULING / CANCELLING an event already on the calendar MUST set intent='meeting_reschedule' AND context. This includes BOTH directions:
- Owner asks you to relay a move TO a colleague ("ask Anna if we can start our weekly 15 min earlier") — set the intent.
- Colleague asked owner to move, owner decided, you're relaying back ("${firstName} agreed — let's do Wed 15:00 your time") — STILL set the intent.

Steps:
1. Call get_calendar to find the existing meeting — note the meeting_id and current start/end.
2. Call message_colleague with:
   - colleague_slack_id, colleague_name, colleague_tz
   - message: natural phrasing asking them to move
   - await_reply: true
   - intent: "meeting_reschedule"     ← REQUIRED
   - context: { meeting_id, meeting_subject, proposed_start (ISO), proposed_end (ISO), original_start (ISO), original_end (ISO) }     ← REQUIRED

When the colleague replies "yes" → the system automatically calls updateMeeting on the existing event, the calendar moves, the colleague gets the updated invite. NO new meeting spawned.

When they decline or propose a different time → the system tells the owner; the owner decides next; if owner accepts the counter, you call message_colleague AGAIN with intent='meeting_reschedule' and the new proposed_start/end so the next yes also auto-moves.

WHAT GOES WRONG IF YOU OMIT THE INTENT TAG: the colleague's reply gets routed to the generic done/continue/schedule classifier, which classifies it as SCHEDULE → relays to the owner as a brand-new meeting request. The original meeting NEVER gets moved on the calendar even after they say yes. Symptom: colleague says "got it, send me the invite" but no invite arrives because nothing was patched.`;
  }
}
