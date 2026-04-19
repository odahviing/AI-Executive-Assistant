/**
 * Outreach core module (v1.6.1).
 *
 * Owns the "how Maelle speaks to people on behalf of the owner" primitives:
 *   - message_colleague — send a DM or a channel post
 *   - find_slack_channel — resolve channel name → channel id
 *
 * This is a CORE module (always active), not a togglable skill. Every
 * Slack-based profile needs outreach for routine interactions: "tell Yael
 * the meeting's confirmed", "post this to #marketing and tag Mike", etc.
 * If/when we add more comm surfaces (email, WhatsApp), outreach will gain
 * connection abstraction — today it's Slack-specific via `context.app`.
 *
 * Extracted from `src/core/assistant.ts` in 1.6.1 to separate "memory about
 * people" (assistant.ts) from "messages to people" (this file).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from '../skills/types';
import type { UserProfile } from '../config/userProfile';
import { DateTime } from 'luxon';
import {
  createOutreachJob,
  upsertPersonMemory,
  appendPersonInteraction,
} from '../db';
import { createTask } from '../tasks';
import { calcResponseDeadline } from '../connectors/slack/coordinator';
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
              description: 'Optional. Tag the outreach with a specific intent so the colleague\'s reply is handled correctly. Use "meeting_reschedule" when the owner is asking a colleague to MOVE an existing meeting (not to set up a new one). When set, you must also supply the context field with the meeting details. If omitted, the reply is classified generically (done/continue/schedule).',
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

        // Channel post — bypass DM flow (app.ts sees _requires_slack_client)
        if (args.channel_id) {
          return {
            _requires_slack_client: true,
            _status: 'queued_not_sent',
            _note: `Message has NOT been posted yet. Say "On it — I'll post that to #${args.channel_name ?? 'the channel'} now" and nothing more.`,
            action: 'post_to_channel',
            channel_id: args.channel_id,
            channel_name: args.channel_name,
            colleague_slack_id: args.colleague_slack_id,
            colleague_name: args.colleague_name,
            message: args.message,
          };
        }

        return {
          _requires_slack_client: true,
          _status: 'queued_not_sent',
          _note: 'Message has NOT been sent yet — it is queued. Do NOT say Done/Sent/Confirmed. Say "On it — I\'ll send that now and let you know when [name] replies." and STOP. Do NOT generate any follow-up text about their reply — you will be notified asynchronously when they actually respond.',
          action: 'send_outreach_dm',
          jobId,
          colleague_slack_id: args.colleague_slack_id,
          colleague_name: args.colleague_name,
          message: args.message,
          await_reply: args.await_reply,
        };
      }

      case 'find_slack_channel': {
        if (!context.app) return { error: 'Slack client not available' };
        const { findSlackChannel } = await import('../connectors/slack/coordinator');
        const channels = await findSlackChannel(context.app, context.profile.assistant.slack.bot_token, args.name as string);
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

## RESCHEDULE EXISTING MEETINGS

When the owner asks you to ask a colleague to MOVE an existing meeting (e.g. "ask Yael if we can start our weekly 15 minutes earlier"), do NOT use coordinate_meeting — that tool creates NEW meetings. Instead:

1. Call get_calendar to find the existing meeting — note the meeting_id and current start/end.
2. Call message_colleague with:
   - colleague_slack_id, colleague_name, colleague_tz
   - message: natural phrasing asking them to move to the new time
   - await_reply: true
   - intent: "meeting_reschedule"
   - context: { meeting_id, meeting_subject, proposed_start (ISO), proposed_end (ISO), original_start (ISO), original_end (ISO) }

When the colleague replies "yes" → the system automatically moves the meeting on the calendar and reports back to the owner.
When they decline or propose a different time → the system tells the owner; the owner decides next.

If you forget intent + context, the reply falls through to the generic classifier and the move will NOT be applied automatically — the owner would have to ask again.`;
  }
}
