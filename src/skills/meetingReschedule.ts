/**
 * Meeting-reschedule outreach-reply handler (v1.8.4).
 *
 * When message_colleague is called with intent='meeting_reschedule' and a
 * context_json payload carrying { meeting_id, proposed_start, proposed_end },
 * the outreach job records that intent. Later, when the colleague replies,
 * connectors/slack/coordinator.ts dispatches the reply to this handler
 * instead of the generic processOutreachReply classifier.
 *
 * Three outcomes:
 *   - approved  → call updateMeeting to MOVE the existing event, DM colleague
 *                 a quick confirmation, DM owner that it's done.
 *   - declined  → DM owner that the colleague declined; keep original time.
 *   - counter   → DM owner with the counter-offer + ask whether to accept;
 *                 creates an approval row so owner's free-text "yes, take it"
 *                 in their next turn resolves correctly.
 *
 * The handler closes the outreach job on any terminal outcome.
 */

import type { App } from '@slack/bolt';
import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import type { OutreachJob } from '../db/jobs';
import { updateOutreachJob } from '../db/jobs';
import { getDb } from '../db';
import { updateMeeting } from '../connectors/graph/calendar';
import { appendToConversation } from '../db';
import { config } from '../config';
import logger from '../utils/logger';

export interface RescheduleContext {
  meeting_id: string;
  meeting_subject: string;
  proposed_start: string;  // ISO
  proposed_end: string;    // ISO
  original_start?: string; // ISO, optional — kept for narration
  original_end?: string;
}

interface RescheduleClassification {
  status: 'approved' | 'declined' | 'counter';
  counter_start?: string;  // HH:MM if counter
  counter_end?: string;
  summary: string;
}

function formatLocalTime(iso: string, timezone: string): string {
  try {
    const dt = DateTime.fromISO(iso, { zone: timezone });
    return dt.isValid ? dt.toFormat('HH:mm') : iso;
  } catch { return iso; }
}

async function classifyRescheduleReply(params: {
  askedAbout: string;
  proposedStartLocal: string;
  proposedEndLocal: string;
  reply: string;
  colleagueName: string;
  assistantName: string;
  ownerName: string;
}): Promise<RescheduleClassification> {
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const prompt = `You are ${params.assistantName}, ${params.ownerName}'s executive assistant.

You asked ${params.colleagueName} to reschedule "${params.askedAbout}" to ${params.proposedStartLocal}–${params.proposedEndLocal}.

${params.colleagueName} replied: "${params.reply}"

Classify their reply and output strict JSON only (no prose, no fences):

{
  "status": "approved" | "declined" | "counter",
  "counter_start": "HH:MM" | null,
  "counter_end": "HH:MM" | null,
  "summary": "one sentence describing what they said"
}

- "approved": they accepted the proposed time. Examples: "yes", "works", "sounds good", "sure".
- "declined": they said no and did not propose an alternative. Examples: "no", "can't", "not possible today".
- "counter": they accepted rescheduling but proposed a different time. Extract the time they offered into counter_start (and counter_end if they gave a range). Example: "yes but 09:30 would be better" → counter_start="09:30".

If ambiguous, prefer "declined" over guessing.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (resp.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined)?.text ?? '';
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : cleaned);
    return {
      status: parsed.status,
      counter_start: parsed.counter_start ?? undefined,
      counter_end: parsed.counter_end ?? undefined,
      summary: parsed.summary ?? '',
    };
  } catch (err) {
    logger.warn('classifyRescheduleReply failed — defaulting to declined', { err: String(err) });
    return { status: 'declined', summary: `${params.colleagueName} replied: "${params.reply.slice(0, 150)}"` };
  }
}

/**
 * Main entry. Returns true if the reply was handled as a reschedule; false if
 * the caller should fall through to the generic processOutreachReply classifier
 * (e.g. intent missing or context unparseable).
 */
export async function handleRescheduleReply(
  app: App,
  params: {
    job: OutreachJob;
    replyText: string;
    profile: UserProfile;
    bot_token: string;
  },
): Promise<boolean> {
  const { job, replyText, profile } = params;
  if (job.intent !== 'meeting_reschedule' || !job.context_json) return false;

  let ctx: RescheduleContext;
  try {
    ctx = JSON.parse(job.context_json);
  } catch {
    logger.warn('handleRescheduleReply: context_json unparseable — falling through', { jobId: job.id });
    return false;
  }
  if (!ctx.meeting_id || !ctx.proposed_start || !ctx.proposed_end) {
    logger.warn('handleRescheduleReply: context missing required fields — falling through', { jobId: job.id });
    return false;
  }

  const timezone = profile.user.timezone;
  const proposedStartLocal = formatLocalTime(ctx.proposed_start, timezone);
  const proposedEndLocal   = formatLocalTime(ctx.proposed_end,   timezone);

  const decision = await classifyRescheduleReply({
    askedAbout: ctx.meeting_subject,
    proposedStartLocal,
    proposedEndLocal,
    reply: replyText,
    colleagueName: job.colleague_name,
    assistantName: profile.assistant.name,
    ownerName: profile.user.name,
  });

  logger.info('Reschedule reply classified', {
    jobId: job.id,
    meetingId: ctx.meeting_id,
    status: decision.status,
    counter: decision.counter_start,
  });

  // Shared: cancel any outreach_expiry task for this outreach (reply arrived)
  getDb().prepare(
    `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
     WHERE skill_ref = ? AND type = 'outreach_expiry' AND status = 'new'`,
  ).run(job.id);

  const conversation: Array<{ role: 'maelle' | 'colleague'; text: string }> =
    job.conversation_json ? JSON.parse(job.conversation_json) : [];
  conversation.push({ role: 'colleague', text: replyText });

  const { openDM } = await import('../connectors/slack/coordinator');

  // ── Branch: approved → move the meeting ──────────────────────────────────
  if (decision.status === 'approved') {
    try {
      await updateMeeting({
        userEmail: profile.user.email,
        timezone,
        meetingId: ctx.meeting_id,
        start: ctx.proposed_start,
        end: ctx.proposed_end,
      });
    } catch (err) {
      logger.error('updateMeeting failed on reschedule approval', { err: String(err), jobId: job.id });
      await app.client.chat.postMessage({
        token: params.bot_token,
        channel: job.owner_channel,
        thread_ts: job.owner_thread_ts ?? undefined,
        text: `${job.colleague_name} said yes to moving "${ctx.meeting_subject}" to ${proposedStartLocal}, but I hit an error updating the calendar. You'll need to move it manually.`,
      });
      updateOutreachJob(job.id, {
        status: 'replied',
        reply_text: replyText,
        conversation_json: JSON.stringify(conversation),
      });
      return true;
    }

    // Confirm to colleague
    const colleagueMsg = `Great — moved to ${proposedStartLocal}. See you then.`;
    try {
      const dmCh = await openDM(app, params.bot_token, job.colleague_slack_id);
      await app.client.chat.postMessage({
        token: params.bot_token,
        channel: dmCh,
        text: colleagueMsg,
      });
    } catch (err) {
      logger.warn('Failed to DM colleague the confirmation', { err: String(err) });
    }
    conversation.push({ role: 'maelle', text: colleagueMsg });

    // Report to owner
    const ownerMsg = `${job.colleague_name} confirmed — moved "${ctx.meeting_subject}" to ${proposedStartLocal}–${proposedEndLocal}.`;
    await app.client.chat.postMessage({
      token: params.bot_token,
      channel: job.owner_channel,
      thread_ts: job.owner_thread_ts ?? undefined,
      text: ownerMsg,
    });
    if (job.owner_thread_ts) {
      appendToConversation(job.owner_thread_ts, job.owner_channel, { role: 'assistant', content: ownerMsg });
    }

    updateOutreachJob(job.id, {
      status: 'replied',
      reply_text: replyText,
      conversation_json: JSON.stringify(conversation),
    });
    // Close the user-facing outreach task
    getDb().prepare(
      `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
       WHERE skill_ref = ? AND status IN ('new','in_progress','pending_colleague')`,
    ).run(job.id);
    return true;
  }

  // ── Branch: declined → report to owner, keep original time ───────────────
  if (decision.status === 'declined') {
    const ownerMsg = `${job.colleague_name} declined moving "${ctx.meeting_subject}". Keeping the original time. Reply preview: "${replyText.slice(0, 120)}"`;
    await app.client.chat.postMessage({
      token: params.bot_token,
      channel: job.owner_channel,
      thread_ts: job.owner_thread_ts ?? undefined,
      text: ownerMsg,
    });
    if (job.owner_thread_ts) {
      appendToConversation(job.owner_thread_ts, job.owner_channel, { role: 'assistant', content: ownerMsg });
    }
    updateOutreachJob(job.id, {
      status: 'replied',
      reply_text: replyText,
      conversation_json: JSON.stringify(conversation),
    });
    getDb().prepare(
      `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
       WHERE skill_ref = ? AND status IN ('new','in_progress','pending_colleague')`,
    ).run(job.id);
    return true;
  }

  // ── Branch: counter → surface to owner as plain DM ───────────────────────
  // Owner's natural reply ("yes take it" / "no, push back to 09:15") is handled
  // by the orchestrator in the next turn — no separate approval row needed.
  if (decision.status === 'counter') {
    const counterDesc = decision.counter_start
      ? (decision.counter_end ? `${decision.counter_start}–${decision.counter_end}` : `around ${decision.counter_start}`)
      : '(time not cleanly extracted — check their reply)';
    const ownerMsg = `${job.colleague_name} can't do ${proposedStartLocal}, but offers ${counterDesc} for "${ctx.meeting_subject}". Want me to take it?`;

    await app.client.chat.postMessage({
      token: params.bot_token,
      channel: job.owner_channel,
      thread_ts: job.owner_thread_ts ?? undefined,
      text: ownerMsg,
    });
    if (job.owner_thread_ts) {
      appendToConversation(job.owner_thread_ts, job.owner_channel, { role: 'assistant', content: ownerMsg });
    }
    updateOutreachJob(job.id, {
      status: 'replied',
      reply_text: replyText,
      conversation_json: JSON.stringify(conversation),
    });
    return true;
  }

  return false;
}
