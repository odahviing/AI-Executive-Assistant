/**
 * Outreach skill (v1.8.11 — moved from src/core to src/skills).
 *
 * Owns the "how Maelle speaks to people on behalf of the owner" primitives:
 *   - message_colleague — send a DM or a channel post
 *   - find_slack_channel — resolve channel name → channel id
 *
 * Still registered as a core module in the registry (always active when a
 * Connection is available) but the implementation is now fully transport-
 * agnostic. Sends go through the Connection interface resolved via registry.
 * When email / WhatsApp Connections land, externals route through them
 * automatically via the router (sub-phase F+).
 *
 * Changed in sub-phase C (v1.8.11):
 *   - File moved from core/outreach.ts → skills/outreach.ts
 *   - _requires_slack_client return pattern removed — sends happen
 *     synchronously inside the tool handler via Connection
 *   - find_slack_channel uses Connection.findChannelByName
 *   - Channel-post branch prepends `<@slack_id>` mention before calling
 *     Connection.postToChannel (@mention was previously done by coordinator.ts)
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
import { createTask } from '../tasks';
import { calcResponseDeadline } from '../connectors/slack/coordinator';
import { getConnection } from '../connections/registry';
import logger from '../utils/logger';

export class OutreachCoreSkill implements Skill {
  id = 'outreach' as const;
  name = 'Outreach';
  description = 'Sends messages to colleagues on behalf of the owner — DMs and channel posts. Always core on any Slack profile.';

  getTools(_profile: UserProfile): Anthropic.Tool[] {
    return [
      {
        name: 'message_colleague',
        description: `Send a message to a colleague — either as a DM or as a post in a Slack channel.
Use when the user asks you to:
- "Go say hi to X"
- "Check in with Y and see how they are doing"
- "Tell Z that the meeting is confirmed"
- "Ask X if they have time this week"
- "Post this to #product and mention Simon"
- "Share this research in #marketing, tag Yael"

DM (default): sends privately to the colleague.
Channel post: when the user specifies a channel (e.g. "post on #product"), post there and mention the colleague. Call find_slack_channel first if you don't have the channel ID. await_reply is ignored for channel posts.

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
              description: 'The message to send. Write naturally in first person as Maelle. Be warm and human. For channel posts, do NOT include the @mention — it is added automatically.',
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
              description: 'Optional, used alongside proposed_slots. A short keyword from the meeting topic ("bank visit", "Privacy GTM", "interview with Don") that will appear in the calendar event subject when it\'s booked. The verifier fuzzy-matches event subjects against this so a third party (Yael, Michal, etc.) who books on their side still gets matched back to this outreach.',
            },
          },
          required: ['colleague_slack_id', 'colleague_name', 'message', 'await_reply'],
        },
      },
      {
        name: 'find_slack_channel',
        description: 'Find a Slack channel ID by name. Use before message_colleague when the user specifies a channel (e.g. "post in #product") and you need the channel ID.',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Channel name to search for, with or without # (e.g. "product" or "#product")',
            },
          },
          required: ['name'],
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
        const sendAt = args.send_at as string | undefined;
        const isFuture = sendAt ? new Date(sendAt) > new Date() : false;

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
          colleague_slack_id: args.colleague_slack_id as string,
          colleague_name: args.colleague_name as string,
          colleague_tz: args.colleague_tz as string | undefined,
          message: args.message as string,
          await_reply: args.await_reply ? 1 : 0,
          status: isFuture ? 'pending_scheduled' : 'sent',
          sent_at: isFuture ? undefined : new Date().toISOString(),
          reply_deadline: deadline,
          scheduled_at: sendAt,
          intent,
          context_json: contextPayload,
          proposed_slots: proposedSlotsJson,
          subject_keyword: subjectKeywordArg,
        });

        logger.info('message_colleague — outreach row created', {
          jobId,
          colleague: args.colleague_name,
          isFuture,
          await_reply: !!args.await_reply,
          skill_origin: 'outreach',
        });

        if (isFuture) {
          const scheduledDt = DateTime.fromISO(sendAt!).setZone(context.profile.user.timezone);
          // Scheduled-send task drives the actual DM post — see runner.ts
          createTask({
            owner_user_id: userId,
            owner_channel: context.channelId,
            owner_thread_ts: context.threadTs,
            type: 'outreach_send',
            status: 'new',
            title: `Send scheduled message to ${args.colleague_name as string}`,
            due_at: sendAt,
            skill_ref: jobId,
            context: JSON.stringify({ outreach_id: jobId }),
            who_requested: 'system',
            skill_origin: 'outreach',
          });
          // Also create the user-facing tracking task so it shows in get_my_tasks
          createTask({
            owner_user_id: userId,
            owner_channel: context.channelId,
            owner_thread_ts: context.threadTs,
            type: 'outreach',
            status: 'pending_colleague',
            title: `Scheduled message to ${args.colleague_name as string}`,
            due_at: sendAt,
            skill_ref: jobId,
            context: JSON.stringify({ jobId, colleague: args.colleague_name }),
            who_requested: context.userId,
            pending_on: JSON.stringify([args.colleague_slack_id]),
            created_context: context.isMpim ? `mpim:${context.channelId}` : 'dm',
            skill_origin: 'outreach',
          });
          return {
            scheduled: true,
            jobId,
            scheduled_at: sendAt,
            _status: 'scheduled_not_sent',
            _note: `Message is scheduled for ${scheduledDt.toFormat('EEEE d MMM \'at\' HH:mm')} — NOT sent yet. Tell the user exactly this: "I've scheduled the message to ${args.colleague_name as string} for ${scheduledDt.toFormat('EEEE at HH:mm')}."`,
          };
        }

        // Not scheduled — send path. Track the person, create tasks.
        upsertPersonMemory({
          slackId:  args.colleague_slack_id as string,
          name:     args.colleague_name as string,
          timezone: args.colleague_tz as string | undefined,
        });
        // v1.6.8 — DON'T write to interaction_log here. The outreach_jobs +
        // tasks rows already track this message end-to-end (status, reply,
        // follow-up). Writing "Sent message: '...'" into people_memory makes
        // the LLM re-surface the message forever when asked about the person,
        // even after the outreach is resolved. Operational state belongs in
        // the operational tables; interaction_log is for social + relationship
        // context only.

        // User-facing task row so it shows up in get_my_tasks
        createTask({
          owner_user_id: userId,
          owner_channel: context.channelId,
          owner_thread_ts: context.threadTs,
          type: 'outreach',
          status: args.await_reply ? 'pending_colleague' : 'completed',
          title: args.await_reply
            ? `Waiting for reply from ${args.colleague_name as string}`
            : `Messaged ${args.colleague_name as string}`,
          due_at: args.await_reply ? deadline : undefined,
          skill_ref: jobId,
          context: JSON.stringify({ jobId, colleague: args.colleague_name }),
          who_requested: context.userId,
          pending_on: args.await_reply ? JSON.stringify([args.colleague_slack_id]) : undefined,
          created_context: context.isMpim ? `mpim:${context.channelId}` : 'dm',
          skill_origin: 'outreach',
        });

        // Reply-deadline task (drives the expiry check via runner.ts)
        if (args.await_reply && deadline) {
          createTask({
            owner_user_id: userId,
            owner_channel: context.channelId,
            owner_thread_ts: context.threadTs,
            type: 'outreach_expiry',
            status: 'new',
            title: `Check reply deadline from ${args.colleague_name as string}`,
            due_at: deadline,
            skill_ref: jobId,
            context: JSON.stringify({ outreach_id: jobId }),
            who_requested: 'system',
            skill_origin: 'outreach',
          });
        }

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
          const mention = `<@${args.colleague_slack_id as string}>`;
          const fullText = `${mention} ${args.message as string}`;
          const outcome = await connection.postToChannel(args.channel_id as string, fullText);
          if (!outcome.ok) {
            updateOutreachJob(jobId, { status: 'cancelled', reply_text: `Channel post failed: ${outcome.reason}` });
            const hint = outcome.reason === 'not_in_channel_private'
              ? `That channel is private and I haven't been invited. Ask an admin to add me, then try again.`
              : `Channel post failed: ${outcome.detail ?? outcome.reason}`;
            return { ok: false, error: outcome.reason, detail: hint };
          }
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
        const outcome = await connection.sendDirect(args.colleague_slack_id as string, args.message as string);
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
        }
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

      case 'find_slack_channel': {
        const connection = getConnection(userId, 'slack');
        if (!connection) return { error: 'slack_connection_not_registered' };
        const channels = await connection.findChannelByName(args.name as string);
        return { channels, count: channels.length };
      }

      default:
        return null;
    }
  }

  getSystemPromptSection(_profile: UserProfile): string {
    return `## OUTREACH

When the owner asks you to send someone a message, use message_colleague. Default is a DM; pass a channel_id for a channel post (use find_slack_channel first). Pass send_at for scheduled future sends — those are driven by the task runner, not sent immediately.

Never reach out to people on your own. Only on explicit owner request. If the colleague might reply, set await_reply=true so we'll track the response.

## RESCHEDULE EXISTING MEETINGS — intent + context are MANDATORY

Any message_colleague that talks about MOVING / SHIFTING / RESCHEDULING / CANCELLING an event already on the calendar MUST set intent='meeting_reschedule' AND context. This includes BOTH directions:
- Owner asks you to relay a move TO a colleague ("ask Yael if we can start our weekly 15 min earlier") — set the intent.
- Colleague asked owner to move, owner decided, you're relaying back ("Idan agreed — let's do Wed 15:00 Boston time") — STILL set the intent.

Steps:
1. Call get_calendar to find the existing meeting — note the meeting_id and current start/end.
2. Call message_colleague with:
   - colleague_slack_id, colleague_name, colleague_tz
   - message: natural phrasing asking them to move
   - await_reply: true
   - intent: "meeting_reschedule"     ← REQUIRED
   - context: { meeting_id, meeting_subject, proposed_start (ISO), proposed_end (ISO), original_start (ISO), original_end (ISO) }     ← REQUIRED

When the colleague replies "yes" → the system automatically calls updateMeeting on the existing event, the calendar moves, the colleague gets the updated invite. NO duplicate coord, NO new meeting spawned.

When they decline or propose a different time → the system tells the owner; the owner decides next; if owner accepts the counter, you call message_colleague AGAIN with intent='meeting_reschedule' and the new proposed_start/end so the next yes also auto-moves.

WHAT GOES WRONG IF YOU OMIT THE INTENT TAG: the colleague's reply gets routed to the generic done/continue/schedule classifier, which classifies it as SCHEDULE → spawns a NEW coordination → sends them a fresh DM with new slot options and a generic subject. The original meeting NEVER gets moved on the calendar even after they say yes. Symptom: colleague says "got it, send me the invite" but no invite arrives because nothing was patched.

Use coordinate_meeting ONLY for brand-new meetings that don't exist yet.`;
  }
}
