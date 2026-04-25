/**
 * Slack outreach + utilities (v1.6.0).
 *
 * What lives here:
 *   - calcResponseDeadline / nextWorkingHourStart: shared helpers for tz math
 *   - sendOutreachDM: primitive for posting an outreach DM
 *   - handleOutreachReply: triggered by app.ts when a colleague replies to an
 *     outreach — classifies (continue/done/schedule) and progresses the job
 *   - findSlackUser / findSlackChannel / postToChannel / openDM: Slack utilities
 *
 * What used to live here but is gone in 1.6:
 *   - sendCoordinationDM / handleCoordinationReply / confirmAndBook / handleDecline:
 *     single-colleague `coordination_jobs` flow (table dropped)
 *   - checkExpiredCoordinations + sendScheduledOutreach: replaced by the
 *     task-runner pipeline — outreach scheduled-send and expiry are now
 *     `type='outreach_send'` / `type='outreach_expiry'` tasks processed by
 *     `src/tasks/runner.ts`. Same goes for coord 24h nudge + abandon.
 */

import Anthropic from '@anthropic-ai/sdk';
import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../../config';
import type { UserProfile } from '../../config/userProfile';
import {
  updateOutreachJob,
  getOutreachJobsByColleague,
  logEvent,
  getDb,
  appendToConversation,
  type OutreachJob,
} from '../../db';
import { findAvailableSlots, pickSpreadSlots } from '../graph/calendar';
import { initiateCoordination } from '../../skills/meetings/coord/state';
import { determineSlotLocation, type SlotWithLocation } from '../../skills/meetings/coord/utils';
import { searchPeopleMemory, getPersonMemory } from '../../db/people';
import logger from '../../utils/logger';

// ── Working-hour helpers ─────────────────────────────────────────────────────
/**
 * Next "business hour start" ≥ now, using the supplied work days (defaults to
 * Mon–Fri). Used by calcResponseDeadline so reply timers never fire during
 * someone's night.
 */
function nextWorkingHourStart(timezone: string, workDays?: string[]): DateTime {
  let dt = DateTime.now().setZone(timezone);
  const dayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  for (let i = 0; i < 10; i++) {
    const todayName = dayNames[dt.weekday];
    const isWorkDay = workDays
      ? workDays.includes(todayName)
      : dt.weekday >= 1 && dt.weekday <= 5;
    if (isWorkDay) {
      if (dt.hour < 8) return dt.set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
      if (dt.hour < 19) return dt;
    }
    dt = dt.plus({ days: 1 }).set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
  }
  return dt;
}

/**
 * Reply deadline: 3 working hours from now in the colleague's timezone.
 * Shared with message_colleague and outreach_expiry task scheduling.
 */
export function calcResponseDeadline(colleagueTz: string): string {
  const workStart = nextWorkingHourStart(colleagueTz);
  return workStart.plus({ hours: 3 }).toUTC().toISO()!;
}

// ── Outreach primitives ──────────────────────────────────────────────────────

export async function sendOutreachDM(
  app: App,
  params: {
    jobId: string;
    colleague_slack_id: string;
    colleague_name: string;
    message: string;
    await_reply: boolean;
    bot_token: string;
  }
): Promise<void> {
  const dmChannel = await openDM(app, params.bot_token, params.colleague_slack_id);
  await app.client.chat.postMessage({
    token: params.bot_token,
    channel: dmChannel,
    text: params.message,
  });
  logger.info('Outreach DM sent', {
    jobId: params.jobId,
    colleague: params.colleague_name,
    await_reply: params.await_reply,
    preview: params.message.slice(0, 80),
  });
}

// ── Outreach reply classifier (Sonnet) ───────────────────────────────────────

/**
 * Decides whether the colleague's message continues an open outreach (answers
 * what we asked) or is an unrelated new request. Returning `false` lets the
 * message fall through to the normal inbound pipeline.
 */
async function isOutreachReplyByContext(params: {
  newReply: string;
  originalMessage: string;
  conversation: Array<{ role: 'maelle' | 'colleague'; text: string }>;
  colleagueName: string;
  assistantName: string;
}): Promise<boolean> {
  try {
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const historyText = params.conversation.length > 0
      ? '\n\nPrior back-and-forth:\n' + params.conversation
          .map(m => `${m.role === 'maelle' ? params.assistantName : params.colleagueName}: ${m.text}`)
          .join('\n')
      : '';

    const prompt =
      `${params.assistantName} previously sent ${params.colleagueName} this message:\n` +
      `"${params.originalMessage}"${historyText}\n\n` +
      `${params.colleagueName} just sent: "${params.newReply}"\n\n` +
      `Is this new message a reply to / continuation of the conversation above, or is it an unrelated new request?\n\n` +
      `Answer with ONLY "reply" or "new". A short acknowledgement, "yes/no/sounds good", a time preference, a follow-up question about the topic, or any feedback on what was asked → "reply". Anything that introduces a new subject, asks for something different, or reads as a fresh incoming request → "new".`;

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
    });
    const out = ((resp.content[0] as Anthropic.TextBlock).text ?? '').trim().toLowerCase();
    return out.startsWith('reply');
  } catch (err) {
    logger.warn('isOutreachReplyByContext failed — defaulting to reply', { err: String(err) });
    return true;
  }
}

/**
 * Given a colleague reply, decide: done (report to owner), continue (ping
 * colleague back), or schedule (hand off to coord).
 */
async function processOutreachReply(params: {
  originalMessage: string;
  conversation: Array<{ role: 'maelle' | 'colleague'; text: string }>;
  newReply: string;
  colleagueName: string;
  ownerName: string;
  assistantName: string;
}): Promise<
  | { action: 'done'; summary: string }
  | { action: 'continue'; response: string }
  | { action: 'schedule'; summary: string; details: { subject: string; preferredDay?: string; preferredTime?: string; durationMin: number; isOnline: boolean } }
> {
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const historyText = params.conversation.length > 0
    ? '\n\nConversation so far:\n' + params.conversation
        .map(m => `${m.role === 'maelle' ? params.assistantName : params.colleagueName}: ${m.text}`)
        .join('\n')
    : '';

  const prompt = `You are ${params.assistantName}, executive assistant to ${params.ownerName}.

You sent this message to ${params.colleagueName} on behalf of ${params.ownerName}:
"${params.originalMessage}"${historyText}

${params.colleagueName} just replied: "${params.newReply}"

Decide what to do:
- If the conversation has turned into SCHEDULING (colleague mentions specific days, times, availability, or wants to set up a meeting) → reply with: SCHEDULE: [subject]|[preferred_day or ""]|[preferred_time like "10:00" or ""]|[duration_min guess 30-60]|[online: true/false]
- If the colleague gave feedback, suggestions, or edits that ${params.ownerName} now needs to act on → reply with: DONE: [summary + "Want me to apply these now?"]
- If the task is fully resolved with no further work implied → reply with: DONE: [1-2 sentence summary, no trailing question]
- If the colleague asked a question or needs more info → reply with: CONTINUE: [your natural response to them, as ${params.assistantName}]

IMPORTANT: If the colleague mentioned ANY specific day or time preference, that's SCHEDULE — do NOT continue chatting about times.

Reply with ONLY "DONE: ...", "CONTINUE: ...", or "SCHEDULE: ..." — nothing else.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (resp.content[0] as Anthropic.TextBlock).text.trim();

    if (text.startsWith('SCHEDULE:')) {
      const parts = text.slice(9).trim().split('|').map(s => s.trim());
      return {
        action: 'schedule',
        summary: `${params.colleagueName} wants to schedule: ${parts[0] || 'meeting'}`,
        details: {
          subject: parts[0] || 'Meeting',
          preferredDay: parts[1] || undefined,
          preferredTime: parts[2] || undefined,
          durationMin: parseInt(parts[3]) || 30,
          isOnline: parts[4] === 'true',
        },
      };
    } else if (text.startsWith('DONE:')) {
      return { action: 'done', summary: text.slice(5).trim() };
    } else if (text.startsWith('CONTINUE:')) {
      return { action: 'continue', response: text.slice(9).trim() };
    } else {
      return { action: 'done', summary: `${params.colleagueName} replied — ${text.slice(0, 150)}` };
    }
  } catch (err) {
    logger.error('processOutreachReply Sonnet call failed', { err: String(err) });
    return { action: 'done', summary: `${params.colleagueName} replied: "${params.newReply.slice(0, 200)}"` };
  }
}

/**
 * Primary entry for colleague replies on DM. Called by app.ts before the
 * general orchestrator runs. If this returns true, the orchestrator is
 * skipped — the reply was handled as part of an outreach conversation.
 *
 * Side effects:
 *   - Marks the outreach job replied/continued/handed-off to coord
 *   - Closes / continues the linked task (v1.6 — also cancels any
 *     outreach_expiry task for this outreach)
 *   - Logs an event
 */
export async function handleOutreachReply(
  app: App,
  params: {
    senderId: string;
    text: string;
    profile: UserProfile;
    bot_token: string;
  }
): Promise<boolean> {
  const allJobs = getOutreachJobsByColleague(params.senderId, params.profile.user.slack_user_id);
  if (allJobs.length === 0) return false;

  // Classify against each active outreach — if nothing plausibly matches, let
  // the message fall through as a new request.
  const matches: OutreachJob[] = [];
  for (const j of allJobs) {
    const conv: Array<{ role: 'maelle' | 'colleague'; text: string }> =
      j.conversation_json ? JSON.parse(j.conversation_json) : [];
    const isReply = await isOutreachReplyByContext({
      newReply: params.text,
      originalMessage: j.message,
      conversation: conv,
      colleagueName: j.colleague_name,
      assistantName: params.profile.assistant.name,
    });
    if (isReply) matches.push(j);
  }

  if (matches.length === 0) {
    logger.info('Outreach classifier — no match, treating as new request', {
      senderId: params.senderId,
      activeCount: allJobs.length,
    });
    return false;
  }

  let job: OutreachJob;
  if (matches.length === 1) {
    job = matches[0];
  } else {
    const lines = matches.map((j, i) => `${i + 1}. ${j.message.slice(0, 100)}${j.message.length > 100 ? '…' : ''}`).join('\n');
    const dmChannel = await openDM(app, params.bot_token, params.senderId);
    await app.client.chat.postMessage({
      token: params.bot_token,
      channel: dmChannel,
      text: `I have a couple of open threads with you — which one is this about?\n${lines}`,
    });
    logger.info('Outreach classifier — multiple matches, asked to disambiguate', {
      senderId: params.senderId,
      matchCount: matches.length,
    });
    return true;
  }

  logger.info('Outreach reply received', {
    jobId: job.id,
    from: job.colleague_name,
    preview: params.text.slice(0, 80),
    intent: job.intent ?? null,
  });

  // v1.8.4 — intent-routed outreach replies. If the outreach was tagged with
  // a recognized intent (meeting_reschedule for now), dispatch to the skill's
  // dedicated handler instead of the generic done/continue/schedule classifier.
  // Handler returns true if it handled the reply; false if we should fall
  // through (e.g. context_json missing or unparseable).
  if (job.intent === 'meeting_reschedule') {
    try {
      const { handleRescheduleReply } = await import('../../skills/meetingReschedule');
      const handled = await handleRescheduleReply(app, {
        job,
        replyText: params.text,
        profile: params.profile,
        bot_token: params.bot_token,
      });
      if (handled) return true;
    } catch (err) {
      logger.error('meeting_reschedule intent handler threw — falling through', { err: String(err), jobId: job.id });
    }
  }

  const conversation: Array<{ role: 'maelle' | 'colleague'; text: string }> =
    job.conversation_json ? JSON.parse(job.conversation_json) : [];
  conversation.push({ role: 'colleague', text: params.text });

  const decision = await processOutreachReply({
    originalMessage: job.message,
    conversation: conversation.slice(0, -1),
    newReply: params.text,
    colleagueName: job.colleague_name,
    ownerName: params.profile.user.name,
    assistantName: params.profile.assistant.name,
  });

  // v1.6 — a reply of any kind kills the outreach_expiry task for this outreach.
  // Done inline rather than via a lifecycle observer so cancellation is atomic
  // with the reply processing, never stale.
  getDb().prepare(
    `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
     WHERE skill_ref = ? AND type = 'outreach_expiry' AND status = 'new'`
  ).run(job.id);

  if (decision.action === 'continue') {
    const dmChannel = await openDM(app, params.bot_token, params.senderId);
    await app.client.chat.postMessage({
      token: params.bot_token,
      channel: dmChannel,
      text: decision.response,
    });
    conversation.push({ role: 'maelle', text: decision.response });
    updateOutreachJob(job.id, { conversation_json: JSON.stringify(conversation) });
    logger.info('Outreach conversation continued', {
      jobId: job.id,
      response: decision.response.slice(0, 80),
    });
    return true;
  }

  // Scheduling handoff — outreach closes, coordination takes over
  if (decision.action === 'schedule') {
    logger.info('Outreach → scheduling handoff', { jobId: job.id, details: decision.details });

    updateOutreachJob(job.id, {
      status: 'replied',
      reply_text: `[Schedule handoff] ${decision.summary}`,
      conversation_json: JSON.stringify(conversation),
    });
    getDb().prepare(
      `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
       WHERE skill_ref = ? AND status IN ('new','in_progress','pending_colleague')`
    ).run(job.id);

    const peopleMatches = searchPeopleMemory(job.colleague_name);
    const personInfo = peopleMatches.length > 0 ? peopleMatches[0] : null;
    const colleagueTz = personInfo?.timezone ?? params.profile.user.timezone;
    const colleagueEmail = personInfo?.email ?? undefined;

    const { preferredDay, preferredTime, durationMin, isOnline, subject } = decision.details;
    const ownerTz = params.profile.user.timezone;
    const now = DateTime.now().setZone(ownerTz);

    let searchFrom: DateTime;
    let searchTo: DateTime;
    if (preferredDay) {
      const dayLower = preferredDay.toLowerCase();
      const dayMap: Record<string, number> = {
        monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
        friday: 5, saturday: 6, sunday: 7,
      };
      const targetDow = dayMap[dayLower];
      if (targetDow) {
        const currentDow = now.weekday;
        const daysAhead = targetDow > currentDow ? targetDow - currentDow : targetDow + 7 - currentDow;
        searchFrom = now.plus({ days: daysAhead }).startOf('day');
        searchTo = searchFrom.endOf('day');
      } else {
        searchFrom = now.plus({ days: 1 }).startOf('day');
        searchTo = now.plus({ days: 7 }).endOf('day');
      }
    } else {
      searchFrom = now.plus({ days: 1 }).startOf('day');
      searchTo = now.plus({ days: 7 }).endOf('day');
    }

    try {
      const schedule = params.profile.schedule;
      const allWorkDays = [
        ...schedule.office_days.days,
        ...schedule.home_days.days,
      ] as string[];

      // v2.2.3 (#43) — build per-attendee work window from people_memory
      // (effective working hours: manual override → auto from TZ default).
      // Slots that fall outside an attendee's window get clipped pre-Graph,
      // so Maelle never proposes 03:30 ET to someone in Boston.
      const attendeeAvailability: NonNullable<Parameters<typeof findAvailableSlots>[0]['attendeeAvailability']> = [];
      if (colleagueEmail) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getEffectiveWorkingHours } = require('../../utils/workingHoursDefault') as
            typeof import('../../utils/workingHoursDefault');
          const personRow = job.colleague_slack_id ? getPersonMemory(job.colleague_slack_id) : null;
          if (personRow) {
            const wh = getEffectiveWorkingHours(personRow);
            const tz = personRow.timezone;
            if (wh && tz) {
              attendeeAvailability.push({
                email: colleagueEmail,
                timezone: tz,
                workdays: wh.workdays,
                hoursStart: wh.hoursStart,
                hoursEnd: wh.hoursEnd,
              });
            }
          }
        } catch (_) { /* fail open — no clip on this attendee */ }
      }

      const slots = await findAvailableSlots({
        userEmail: params.profile.user.email,
        timezone: ownerTz,
        durationMinutes: durationMin,
        attendeeEmails: colleagueEmail ? [colleagueEmail] : [],
        searchFrom: searchFrom.toISO()!,
        searchTo: searchTo.toISO()!,
        preferMorning: true,
        workDays: allWorkDays,
        workHoursStart: schedule.home_days.hours_start,
        workHoursEnd: schedule.office_days.hours_end,
        minBufferHours: params.profile.meetings.min_slot_buffer_hours ?? 4,
        meetingMode: 'either',  // coord outreach — location determined later
        autoExpand: false,
        profile: params.profile,
        // v2.2.3 (#43) — owner-only busy filter by default (no
        // attendeeBusyEmails). Attendee status is annotated on chosen slots
        // separately, post-pick. Recipient can opt in to deeper search later.
        attendeeAvailability: attendeeAvailability.length > 0 ? attendeeAvailability : undefined,
      });

      if (slots.length === 0) {
        const msg = `My conversation with ${job.colleague_name} turned into scheduling — they want to meet${preferredDay ? ` ${preferredDay}` : ''}${preferredTime ? ` around ${preferredTime}` : ''} for "${subject}" (${durationMin} min). But I couldn't find open slots in your calendar. Want me to look at a wider window?`;
        await app.client.chat.postMessage({
          token: params.bot_token,
          channel: job.owner_channel,
          thread_ts: job.owner_thread_ts ?? undefined,
          text: msg,
        });
        if (job.owner_thread_ts) {
          appendToConversation(job.owner_thread_ts, job.owner_channel, { role: 'assistant', content: msg });
        }
        return true;
      }

      const chosen = pickSpreadSlots(slots, ownerTz, 3);
      const participant = {
        slack_id: job.colleague_slack_id,
        name: job.colleague_name,
        tz: colleagueTz,
        email: colleagueEmail,
      };

      const ownerDomain = params.profile.user.email.split('@')[1];
      const isColleagueInternal = colleagueEmail
        ? colleagueEmail.endsWith(`@${ownerDomain}`)
        : true;
      const proposedSlots: SlotWithLocation[] = chosen.map(slotStart => {
        const loc = determineSlotLocation(slotStart, params.profile, 2, isColleagueInternal);
        return {
          start: slotStart,
          end: DateTime.fromISO(slotStart).plus({ minutes: durationMin }).toISO()!,
          location: loc.location,
          isOnline: loc.isOnline,
        };
      });

      await initiateCoordination({
        ownerUserId: params.profile.user.slack_user_id,
        ownerChannel: job.owner_channel,
        ownerThreadTs: job.owner_thread_ts,
        ownerName: params.profile.user.name,
        ownerEmail: params.profile.user.email,
        ownerTz,
        subject,
        topic: `Handoff from outreach conversation — ${job.colleague_name} prefers${preferredDay ? ` ${preferredDay}` : ''}${preferredTime ? ` ${preferredTime}` : ''}`,
        durationMin,
        participants: [participant],
        proposedSlots,
        profile: params.profile,
      });

      const handoffMsg = `My chat with ${job.colleague_name} turned into scheduling. They want "${subject}"${preferredDay ? ` on ${preferredDay}` : ''}${preferredTime ? ` around ${preferredTime}` : ''} — I've sent them slot options and started coordination.`;
      await app.client.chat.postMessage({
        token: params.bot_token,
        channel: job.owner_channel,
        thread_ts: job.owner_thread_ts ?? undefined,
        text: handoffMsg,
      });

      logEvent({
        ownerUserId: params.profile.user.slack_user_id,
        type: 'outreach_reply',
        title: `${job.colleague_name} — scheduling handoff`,
        detail: handoffMsg,
        actor: job.colleague_name,
        refId: job.id,
      });

      if (job.owner_thread_ts) {
        appendToConversation(job.owner_thread_ts, job.owner_channel, { role: 'assistant', content: handoffMsg });
      }

      logger.info('Outreach→coordination handoff complete', {
        jobId: job.id,
        colleague: job.colleague_name,
        subject,
      });
      return true;
    } catch (err) {
      logger.error('Outreach→coordination handoff failed', { jobId: job.id, err: String(err) });
      const fallbackMsg = `${job.colleague_name} wants to schedule "${subject}"${preferredDay ? ` on ${preferredDay}` : ''}${preferredTime ? ` around ${preferredTime}` : ''} (${durationMin} min${isOnline ? ', online' : ''}). I couldn't set it up automatically — can you tell me to coordinate this?`;
      await app.client.chat.postMessage({
        token: params.bot_token,
        channel: job.owner_channel,
        thread_ts: job.owner_thread_ts ?? undefined,
        text: fallbackMsg,
      });
      if (job.owner_thread_ts) {
        appendToConversation(job.owner_thread_ts, job.owner_channel, { role: 'assistant', content: fallbackMsg });
      }
      return true;
    }
  }

  // decision.action === 'done'
  updateOutreachJob(job.id, {
    status: 'replied',
    reply_text: params.text,
    conversation_json: JSON.stringify(conversation),
  });
  await app.client.chat.postMessage({
    token: params.bot_token,
    channel: job.owner_channel,
    thread_ts: job.owner_thread_ts ?? undefined,
    text: decision.summary,
  });
  logEvent({
    ownerUserId: params.profile.user.slack_user_id,
    type: 'outreach_reply',
    title: `${job.colleague_name} — outreach complete`,
    detail: decision.summary,
    actor: job.colleague_name,
    refId: job.id,
  });
  getDb().prepare(
    `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
     WHERE skill_ref = ? AND status IN ('pending_colleague', 'new')`
  ).run(job.id);

  if (job.owner_thread_ts) {
    appendToConversation(job.owner_thread_ts, job.owner_channel, {
      role: 'assistant',
      content: decision.summary,
    });
  }

  logger.info('Outreach complete — summarised for owner', {
    jobId: job.id,
    summary: decision.summary.slice(0, 100),
  });
  return true;
}

// ── Slack utilities ──────────────────────────────────────────────────────────

export async function findSlackUser(
  app: App,
  bot_token: string,
  name: string
): Promise<Array<{ id: string; name: string; real_name: string; tz: string }>> {
  try {
    const result = await app.client.users.list({ token: bot_token, limit: 200 });
    const members = (result.members ?? []) as any[];
    const query = name.toLowerCase();

    return members
      .filter(m =>
        !m.deleted && !m.is_bot &&
        (
          m.real_name?.toLowerCase().includes(query) ||
          m.name?.toLowerCase().includes(query) ||
          m.profile?.display_name?.toLowerCase().includes(query)
        )
      )
      .map(m => ({
        id: m.id,
        name: m.name,
        real_name: m.real_name ?? m.name,
        tz: m.tz ?? 'UTC',
      }));
  } catch (err) {
    logger.error('Failed to search Slack users', { err, name });
    return [];
  }
}

export async function findSlackChannel(
  app: App,
  bot_token: string,
  name: string
): Promise<Array<{ id: string; name: string }>> {
  try {
    const result = await app.client.conversations.list({
      token: bot_token,
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
    });
    const channels = (result.channels ?? []) as any[];
    const query = name.toLowerCase().replace(/^#/, '');

    return channels
      .filter(c => c.name?.toLowerCase().includes(query))
      .map(c => ({ id: c.id, name: c.name }));
  } catch (err) {
    logger.error('Failed to search Slack channels', { err, name });
    return [];
  }
}

export async function postToChannel(
  app: App,
  params: {
    bot_token: string;
    channel_id: string;
    colleague_slack_id: string;
    message: string;
  }
): Promise<{ ok: true } | { ok: false; reason: 'not_in_channel_private' | 'error'; detail: string }> {
  const text = `<@${params.colleague_slack_id}> ${params.message}`;

  const tryPost = async () => {
    await app.client.chat.postMessage({
      token: params.bot_token,
      channel: params.channel_id,
      text,
    });
  };

  try {
    await tryPost();
    logger.info('Channel post sent', { channel: params.channel_id, mention: params.colleague_slack_id });
    return { ok: true };
  } catch (err: any) {
    const code: string = err?.data?.error ?? err?.message ?? '';

    if (code === 'not_in_channel') {
      try {
        const info = await app.client.conversations.info({
          token: params.bot_token,
          channel: params.channel_id,
        }) as any;

        const isPrivate: boolean = info?.channel?.is_private ?? true;

        if (!isPrivate) {
          await app.client.conversations.join({
            token: params.bot_token,
            channel: params.channel_id,
          });
          await tryPost();
          logger.info('Channel post sent after join', { channel: params.channel_id });
          return { ok: true };
        } else {
          logger.warn('Cannot post to private channel — not a member', { channel: params.channel_id });
          return { ok: false, reason: 'not_in_channel_private', detail: `I'm not a member of that private channel and can't join without an invite.` };
        }
      } catch (infoErr: any) {
        logger.error('Failed to check channel info after not_in_channel', { infoErr });
        return { ok: false, reason: 'error', detail: String(infoErr?.message ?? infoErr) };
      }
    }

    logger.error('Failed to post to channel', { err: code, channel: params.channel_id });
    return { ok: false, reason: 'error', detail: code };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export async function openDM(app: App, bot_token: string, userId: string): Promise<string> {
  const result = await app.client.conversations.open({ token: bot_token, users: userId });
  return (result.channel as any)?.id;
}
