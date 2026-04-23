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
import { updateMeeting, findAvailableSlots } from '../connectors/graph/calendar';
import { appendToConversation } from '../db';
import { config } from '../config';
import { getConnection } from '../connections/registry';
import { shadowNotify } from '../utils/shadowNotify';
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
  _app: App,
  params: {
    job: OutreachJob;
    replyText: string;
    profile: UserProfile;
    bot_token: string;
  },
): Promise<boolean> {
  const { job, replyText, profile } = params;
  if (job.intent !== 'meeting_reschedule' || !job.context_json) return false;

  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    logger.warn('handleRescheduleReply — no Slack connection registered', { profileId: profile.user.slack_user_id });
    return false;
  }

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
      await conn.postToChannel(
        job.owner_channel,
        `${job.colleague_name} said yes to moving "${ctx.meeting_subject}" to ${proposedStartLocal}, but I hit an error updating the calendar. You'll need to move it manually.`,
        { threadTs: job.owner_thread_ts ?? undefined },
      );
      updateOutreachJob(job.id, {
        status: 'replied',
        reply_text: replyText,
        conversation_json: JSON.stringify(conversation),
      });
      return true;
    }

    // Confirm to colleague — thread back into the original outreach DM
    // when we recorded it (v2.1.5); fall back to a fresh DM for legacy
    // rows that predate the ts capture.
    const colleagueMsg = `Great, moved to ${proposedStartLocal}. See you then.`;
    try {
      if (job.dm_channel_id) {
        await conn.postToChannel(job.dm_channel_id, colleagueMsg, {
          threadTs: job.dm_message_ts,
        });
      } else {
        await conn.sendDirect(job.colleague_slack_id, colleagueMsg);
      }
    } catch (err) {
      logger.warn('Failed to DM colleague the confirmation', { err: String(err) });
    }
    conversation.push({ role: 'maelle', text: colleagueMsg });

    // Report to owner
    const ownerMsg = `${job.colleague_name} confirmed, moved "${ctx.meeting_subject}" to ${proposedStartLocal}–${proposedEndLocal}.`;
    await conn.postToChannel(job.owner_channel, ownerMsg, {
      threadTs: job.owner_thread_ts ?? undefined,
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
    await conn.postToChannel(job.owner_channel, ownerMsg, {
      threadTs: job.owner_thread_ts ?? undefined,
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

  // ── Branch: counter → auto-accept if rule-compliant, else ask owner ──────
  // Owner's natural reply ("yes take it" / "no, push back to 09:15") is handled
  // by the orchestrator in the next turn — no separate approval row needed.
  //
  // v2.1.5 — mirror the coord counter auto-accept: when active mode is on
  // AND the counter is same ISO week AND passes every schedule rule (buffer,
  // work hours, floating blocks — all enforced by findAvailableSlots), move
  // the meeting autonomously and shadow-DM the owner. Maelle doesn't need
  // approval for "15 minutes earlier on the same day" — that's her job.
  if (decision.status === 'counter') {
    const counterDesc = decision.counter_start
      ? (decision.counter_end ? `${decision.counter_start}–${decision.counter_end}` : `around ${decision.counter_start}`)
      : '(time not cleanly extracted — check their reply)';

    // Attempt auto-accept before falling back to owner approval.
    const activeMode = profile.behavior.calendar_health_mode === 'active';
    if (activeMode && decision.counter_start) {
      try {
        const proposedStartDt = DateTime.fromISO(ctx.proposed_start, { zone: timezone });
        const [ch, cm] = decision.counter_start.split(':').map(n => parseInt(n, 10));
        if (proposedStartDt.isValid && !isNaN(ch) && !isNaN(cm)) {
          const counterStartDt = proposedStartDt.set({ hour: ch, minute: cm, second: 0, millisecond: 0 });
          const durationMs = DateTime.fromISO(ctx.proposed_end).toMillis() - DateTime.fromISO(ctx.proposed_start).toMillis();
          const durationMin = Math.max(5, Math.round(durationMs / 60_000));
          const counterEndDt = counterStartDt.plus({ milliseconds: durationMs });

          // Rule 1 — same ISO week as the original meeting time (falls back to
          // the proposed_start date when original_start isn't recorded).
          const originalDt = ctx.original_start
            ? DateTime.fromISO(ctx.original_start, { zone: timezone })
            : proposedStartDt;
          const sameWeek = counterStartDt.weekYear === originalDt.weekYear
            && counterStartDt.weekNumber === originalDt.weekNumber;

          if (sameWeek) {
            // Rule 2 — narrow-window findAvailableSlots. Search ±1 min around
            // the counter; if it comes back, every schedule rule is satisfied.
            const startMs = counterStartDt.toMillis();
            const fromIso = DateTime.fromMillis(startMs - 60_000).toUTC().toISO();
            const toIso = DateTime.fromMillis(startMs + durationMin * 60_000 + 60_000).toUTC().toISO();
            let validSlots: Array<{ start: string }> = [];
            if (fromIso && toIso) {
              try {
                validSlots = await findAvailableSlots({
                  userEmail: profile.user.email,
                  timezone,
                  durationMinutes: durationMin,
                  attendeeEmails: [profile.user.email],
                  searchFrom: fromIso,
                  searchTo: toIso,
                  profile,
                });
              } catch (err) {
                logger.warn('Reschedule counter auto-accept: findAvailableSlots threw, falling back to approval', {
                  err: String(err).slice(0, 200), jobId: job.id,
                });
              }
            }
            const matches = validSlots.some(s => {
              const s1 = DateTime.fromISO(s.start).toMillis();
              return Math.abs(s1 - startMs) <= 60_000;
            });

            if (matches) {
              logger.info('Reschedule counter auto-accept (same week, rule-compliant) — moving', {
                jobId: job.id, counter: decision.counter_start,
              });
              try {
                await updateMeeting({
                  userEmail: profile.user.email,
                  timezone,
                  meetingId: ctx.meeting_id,
                  start: counterStartDt.toISO() ?? ctx.proposed_start,
                  end: counterEndDt.toISO() ?? ctx.proposed_end,
                });
              } catch (err) {
                logger.error('Reschedule counter auto-accept: updateMeeting failed, falling back to approval', {
                  err: String(err), jobId: job.id,
                });
                // fall through to approval path below
              }

              // Confirm to colleague — thread into the original DM if we have it
              const counterLocal = counterStartDt.toFormat('HH:mm');
              const colleagueMsg = `Works — moved to ${counterLocal}. See you then.`;
              try {
                if (job.dm_channel_id) {
                  await conn.postToChannel(job.dm_channel_id, colleagueMsg, { threadTs: job.dm_message_ts });
                } else {
                  await conn.sendDirect(job.colleague_slack_id, colleagueMsg);
                }
              } catch (err) {
                logger.warn('Reschedule counter auto-accept: colleague DM failed', { err: String(err) });
              }
              conversation.push({ role: 'maelle', text: colleagueMsg });

              // Shadow DM the owner
              await shadowNotify(profile, {
                channel: job.owner_channel,
                threadTs: job.owner_thread_ts ?? undefined,
                action: 'Auto-accepted counter',
                detail: `${job.colleague_name} countered "${ctx.meeting_subject}" to ${counterStartDt.toFormat('EEEE d MMM HH:mm')} — same week, within your rules, so I moved it. Say the word if you'd rather I hadn't.`,
              });

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
          }
        }
      } catch (err) {
        logger.warn('Reschedule counter auto-accept pre-check threw — falling back to approval', {
          err: String(err).slice(0, 200), jobId: job.id,
        });
      }
    }

    // Fallback: ask owner.
    const ownerMsg = `${job.colleague_name} can't do ${proposedStartLocal}, but offers ${counterDesc} for "${ctx.meeting_subject}". Want me to take it?`;

    await conn.postToChannel(job.owner_channel, ownerMsg, {
      threadTs: job.owner_thread_ts ?? undefined,
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
