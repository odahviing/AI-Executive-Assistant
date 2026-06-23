/**
 * Slack outreach + utilities (v1.6.0).
 *
 * What lives here:
 *   - sendOutreachDM: primitive for posting an outreach DM
 *   - handleOutreachReply: triggered by app.ts when a colleague replies to an
 *     outreach — classifies (continue/done/schedule) and progresses the job
 *   - findSlackUser / findSlackChannel / postToChannel / openDM: Slack utilities
 *
 * What used to live here but is gone in 1.6:
 *   - sendCoordinationDM / handleCoordinationReply / confirmAndBook / handleDecline:
 *     single-colleague `coordination_jobs` flow (table dropped)
 *   - checkExpiredCoordinations + sendScheduledOutreach: replaced by the
 *     requests-spine timer. v3.1 (Path 2): outreach scheduled-send and expiry,
 *     and coord nudge/abandon, are NOT tasks — they live on the request row as
 *     `next_check_at` / `next_check_handler` and are swept by
 *     `core/requests/runner.ts:sweepDueRequests`. The old `type='outreach_send'`
 *     / `type='outreach_expiry'` task types were deleted.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../../llm/client';
import { App } from '@slack/bolt';
import { config } from '../../config';
import type { UserProfile } from '../../config/userProfile';
import { updateRequest } from '../../db/requests';
import {
  updateOutreachJob,
  getOutreachJobsByColleague,
  logEvent,
  getDb,
  appendToConversation,
  type OutreachJob,
} from '../../db';
import logger from '../../utils/logger';

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
    const anthropic = getAnthropicClient();
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
  const anthropic = getAnthropicClient();

  const historyText = params.conversation.length > 0
    ? '\n\nConversation so far:\n' + params.conversation
        .map(m => `${m.role === 'maelle' ? params.assistantName : params.colleagueName}: ${m.text}`)
        .join('\n')
    : '';

  // v2.2.4 (bug 4) — anchor today's date in the prompt so date references in
  // the colleague's reply ("Wed 17 Jun") resolve to the right year. Without
  // this anchor Sonnet has been parsing "17 Jun" as 2025 even when the
  // conversation is happening in 2026.
  const todayIso = new Date().toISOString().slice(0, 10);

  const prompt = `You are ${params.assistantName}, executive assistant to ${params.ownerName}.

Today is ${todayIso}. Resolve any partial dates in the reply against today — never assume a past year.

You sent this message to ${params.colleagueName} on behalf of ${params.ownerName}:
"${params.originalMessage}"${historyText}

${params.colleagueName} just replied: "${params.newReply}"

Decide what to do:
- If the conversation has turned into SCHEDULING A NEW MEETING (colleague mentions specific days, times, availability for a new meeting they want to set up) → reply with: SCHEDULE: [subject]|[preferred_day or ""]|[preferred_time like "10:00" or ""]|[duration_min guess 30-60]|[online: true/false]
- If the colleague gave feedback, suggestions, or edits that ${params.ownerName} now needs to act on → reply with: DONE: [summary + "Want me to apply these now?"]
- If the task is fully resolved with no further work implied → reply with: DONE: [1-2 sentence summary, no trailing question]
- If the colleague asked a question or needs more info, OR the reply is about MOVING an existing meeting (counter-times for an event that already exists on the calendar — including "can't make any slot" with a counter-suggestion when we were already moving an existing meeting), OR the reply is a brief acknowledgment that doesn't ask for a new meeting → reply with: CONTINUE: [your natural response to them, as ${params.assistantName}]

CRITICAL: Reschedule conversations are CONTINUE, NOT SCHEDULE. If the original message ${params.assistantName} sent was about moving an existing meeting (you'll see phrasing like "asked to relay", "move", "shift", "doesn't fit", or it references a specific existing meeting subject), then any counter-time reply is the continuation of that reschedule — not a new meeting request. Use CONTINUE; ${params.ownerName} will decide on the counter through the normal reschedule path.

SCHEDULE is for fresh meeting requests only — colleague says "let's set up time" or "I'd like to grab 30 min" with no existing event being discussed.

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

  // v3.1.1 — a reply of any kind kills the expiry timer for this outreach.
  // Path 2 moved that timer off the (deleted) `outreach_expiry` TASK onto the
  // linked request's next_check; clear it here so an actively-replying colleague
  // is never falsely marked no_response. Closing branches also close the request
  // (which clears next_check); this covers the 'continue' branch that keeps it open.
  if (job.request_id) {
    updateRequest(job.request_id, { nextCheckAt: null, nextCheckHandler: null });
  }

  if (decision.action === 'continue') {
    // v2.2.4 (bug 6) — preserve thread context. v2.1.5 added dm_message_ts +
    // dm_channel_id so follow-ups can land in the same DM thread the outreach
    // started in. The continue branch was opening a fresh DM and posting at
    // top level, breaking out of the thread the colleague was reading. Use
    // the Connection registry with threadTs when we have it; fall back to
    // sendDirect (no thread) for legacy rows that pre-date the columns.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConnection } = require('../../connections/registry') as typeof import('../../connections/registry');
    const conn = getConnection(params.profile.user.slack_user_id, 'slack');
    if (conn) {
      const sendOpts = job.dm_message_ts
        ? { threadTs: job.dm_message_ts }
        : undefined;
      await conn.sendDirect(params.senderId, decision.response, sendOpts);
    } else {
      // Final fallback — the Connection registry should always be populated
      // at startup, but if not, post via raw client as before so we don't
      // silently swallow the reply.
      const dmChannel = await openDM(app, params.bot_token, params.senderId);
      await app.client.chat.postMessage({
        token: params.bot_token,
        channel: dmChannel,
        text: decision.response,
      });
    }
    conversation.push({ role: 'maelle', text: decision.response });
    updateOutreachJob(job.id, { conversation_json: JSON.stringify(conversation) });
    logger.info('Outreach conversation continued', {
      jobId: job.id,
      response: decision.response.slice(0, 80),
    });
    return true;
  }

  // Scheduling turn — RELAY TO OWNER. The colleague's reply has turned into a
  // request to set up a new meeting. We do NOT auto-find slots or coordinate
  // here (the multi-party coord subsystem was removed). Instead: close the
  // outreach as replied, complete its task, and DM the owner with the gist so
  // he can decide and book through the normal direct path (find_available_slots
  // → create_meeting).
  if (decision.action === 'schedule') {
    logger.info('Outreach → scheduling relay to owner', { jobId: job.id, details: decision.details });

    updateOutreachJob(job.id, {
      status: 'replied',
      reply_text: `[Schedule] ${decision.summary}`,
      conversation_json: JSON.stringify(conversation),
    });
    getDb().prepare(
      `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
       WHERE skill_ref = ? AND status IN ('new','in_progress','pending_colleague')`
    ).run(job.id);

    const { preferredDay, preferredTime, subject, durationMin } = decision.details;
    const dayPart = preferredDay ? ` on ${preferredDay}` : '';
    const timePart = preferredTime ? ` around ${preferredTime}` : '';
    const relayMsg = `${job.colleague_name} wants to meet${dayPart}${timePart} for "${subject}" (${durationMin} min). Want me to find a time and book it?`;
    await app.client.chat.postMessage({
      token: params.bot_token,
      channel: job.owner_channel,
      thread_ts: job.owner_thread_ts ?? undefined,
      text: relayMsg,
    });
    if (job.owner_thread_ts) {
      appendToConversation(job.owner_thread_ts, job.owner_channel, { role: 'assistant', content: relayMsg });
    }
    logEvent({
      ownerUserId: params.profile.user.slack_user_id,
      type: 'outreach_reply',
      title: `${job.colleague_name} — scheduling request`,
      detail: relayMsg,
      actor: job.colleague_name,
      refId: job.id,
    });

    logger.info('Outreach → scheduling relay complete', {
      jobId: job.id,
      colleague: job.colleague_name,
      subject,
    });
    return true;
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
