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
import { getAnthropicClient } from '../llm/client';
import { SONNET } from '../llm/models';
import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import type { OutreachJob } from '../db/jobs';
import { createOutreachJob, updateOutreachJob, getLinkedRequestIdForOutreach } from '../db/jobs';
import { updateRequest } from '../db/requests';
import { calcResponseDeadline } from '../utils/responseDeadline';
import { updateMeeting, findAvailableSlots } from '../connectors/graph/calendar';
import { appendToConversation } from '../db';
import { config } from '../config';
import { getConnection } from '../connections/registry';
import { shadowNotify } from '../utils/shadowNotify';
import logger from '../utils/logger';
import { extractFirstJsonObject } from '../utils/extractJson';

export interface RescheduleContext {
  meeting_id: string;
  meeting_subject: string;
  proposed_start: string;  // ISO
  proposed_end: string;    // ISO
  original_start?: string; // ISO, optional — kept for narration
  original_end?: string;
  // v3.2.6 (Part A) — the meeting was ALREADY moved (active-mode autofix moved
  // it to a verified-free in-week slot, then notified the colleague). So a
  // "yes/fine" reply is a no-op (don't re-move), a "doesn't work" reply must
  // escalate to the owner WITH a revert option (the event is at proposed_*, not
  // original_*), and a counter is handled as usual.
  already_moved?: boolean;
  // v4.2.x (owner decision "option C") — this notice CORRECTS an earlier notice
  // for the same meeting whose stated time a later calendar write voided. Marks
  // the payload so the once-per-event-per-day cap can count corrections off
  // history (db/jobs.ts → countCorrectionNoticesSince) instead of a new column.
  correction?: boolean;
}

interface RescheduleClassification {
  status: 'approved' | 'declined' | 'counter' | 'checking';
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
  const anthropic = getAnthropicClient();
  const prompt = `You are ${params.assistantName}, ${params.ownerName}'s executive assistant.

You asked ${params.colleagueName} to reschedule "${params.askedAbout}" to ${params.proposedStartLocal}–${params.proposedEndLocal}.

${params.colleagueName} replied: "${params.reply}"

Classify their reply and output strict JSON only (no prose, no fences):

{
  "status": "approved" | "declined" | "counter" | "checking",
  "counter_start": "HH:MM" | null,
  "counter_end": "HH:MM" | null,
  "summary": "one sentence describing what they said"
}

- "approved": they accepted the proposed time. Examples: "yes", "works", "sounds good", "sure".
- "declined": they said no / it doesn't work and offered no alternative. Examples: "no", "can't", "not possible today".
- "counter": they accepted rescheduling but proposed a different time. Extract the time they offered into counter_start (and counter_end if they gave a range). Example: "yes but 09:30 would be better" → counter_start="09:30".
- "checking": they acknowledged but have NOT decided yet — they need to check or confirm with someone/something before they can answer. Examples: "let me check", "I'll confirm with the candidate and come back to you", "need to look at my calendar", "will get back to you". This is neither yes, no, nor a counter — it's "not yet." Classify by MEANING in any language, not keywords.

Tie-break: a genuine NON-answer (they haven't decided, "I'll get back to you", truly unclear) → "checking". Only prefer "declined" when the reply leans actually-negative but vague ("probably not", "I doubt it").`;

  try {
    const resp = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (resp.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined)?.text ?? '';
    const match = extractFirstJsonObject(text);
    const parsed = JSON.parse(match ?? text.trim());
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

  // v3.1.1 — reply arrived → kill the expiry timer. Path 2 moved it off the
  // deleted `outreach_expiry` TASK onto the linked request's next_check.
  if (job.request_id) {
    updateRequest(job.request_id, { nextCheckAt: null, nextCheckHandler: null });
  }

  const conversation: Array<{ role: 'maelle' | 'colleague'; text: string }> =
    job.conversation_json ? JSON.parse(job.conversation_json) : [];
  conversation.push({ role: 'colleague', text: replyText });

  // ── Branch: approved → move the meeting ──────────────────────────────────
  if (decision.status === 'approved') {
    // v3.2.6 (Part A) — when the meeting was ALREADY moved (autofix), an
    // approval is a no-op: confirm to the colleague + report to owner, don't
    // re-move. Skip straight past the move + rebalance.
    if (ctx.already_moved) {
      const colleagueMsg = `Great — see you then.`;
      try {
        if (job.dm_channel_id) await conn.postToChannel(job.dm_channel_id, colleagueMsg, { threadTs: job.dm_message_ts });
        else await conn.sendDirect(job.colleague_slack_id, colleagueMsg);
      } catch (err) { logger.warn('reschedule (already_moved approve) colleague DM failed', { err: String(err).slice(0, 160) }); }
      conversation.push({ role: 'maelle', text: colleagueMsg });
      await conn.postToChannel(job.owner_channel,
        `${job.colleague_name} is fine with the moved time for "${ctx.meeting_subject}" (${proposedStartLocal}).`,
        { threadTs: job.owner_thread_ts ?? undefined });
      updateOutreachJob(job.id, { status: 'replied', reply_text: replyText, conversation_json: JSON.stringify(conversation) });
      return true;
    }
    try {
      await updateMeeting({
        userEmail: profile.user.email,
        timezone,
        meetingId: ctx.meeting_id,
        start: ctx.proposed_start,
        end: ctx.proposed_end,
      });
      // v3.2.x — this is a headless reschedule (no owner turn), so a floating
      // block the move just landed on must be auto-slid in code, not offered.
      // Own try/catch: a rebalance hiccup must not read as a move failure.
      try {
        const { rebalanceFloatingBlocksAfterMutation } = await import('../utils/rebalanceFloatingBlocks');
        await rebalanceFloatingBlocksAfterMutation({
          profile,
          affectedSlotIso: ctx.proposed_start,
          ownerSlackId: profile.user.slack_user_id,
        });
      } catch (rebErr) {
        logger.warn('rebalance after reschedule-approval move threw — continuing', { err: String(rebErr).slice(0, 200), jobId: job.id });
      }
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
    return true;
  }

  // ── Branch: checking → colleague acknowledged but hasn't decided ──────────
  // v3.5.x — a "let me check / I'll come back to you" is NOT a decline. Do not
  // move, resolve, or report a decline. Keep the request OPEN (it stays
  // awaiting_colleague — still genuinely waiting on the colleague) and re-arm ITS
  // spine timer for a SINGLE re-ask in 24h (reschedule_reask). If the colleague
  // comes back with a real answer before then, that reply runs this handler
  // again and resolves normally — clearing this timer. No new state: reuses the
  // open outreach job + the linked request's next_check.
  if (decision.status === 'checking') {
    const ownerMsg = `${job.colleague_name} is checking on "${ctx.meeting_subject}" and will come back to me — nothing decided yet, so I'm keeping the current time and will wait. If I don't hear back I'll nudge once tomorrow.`;
    await conn.postToChannel(job.owner_channel, ownerMsg, { threadTs: job.owner_thread_ts ?? undefined });
    if (job.owner_thread_ts) {
      appendToConversation(job.owner_thread_ts, job.owner_channel, { role: 'assistant', content: ownerMsg });
    }
    // Persist the colleague reply; DO NOT set a terminal status → job stays open.
    updateOutreachJob(job.id, { reply_text: replyText, conversation_json: JSON.stringify(conversation) });
    // Re-arm the request's spine timer: one re-ask at +24h (overrides the
    // reply-time timer clear above).
    if (job.request_id) {
      // outreach-expiry-tombstone-says-never-replied (2026-08-12) — this IS a
      // genuine reply ("checking"), so mark it same as coordinator.ts's continue
      // branch: `state` stays awaiting_colleague through this re-arm (and the
      // reschedule_reask → outreach_expiry re-arm after it), so without this
      // marker a later silence reads as "never replied" at expiry time.
      updateRequest(job.request_id, {
        nextCheckAt: DateTime.now().plus({ hours: 24 }).toUTC().toISO(),
        nextCheckHandler: 'reschedule_reask',
        phase: 'outreach:re_engaged',
      });
    }
    logger.info('Reschedule reply = checking — kept open, armed reschedule_reask +24h', {
      jobId: job.id, requestId: job.request_id ?? null,
    });
    return true;
  }

  // ── Branch: declined → report to owner ───────────────────────────────────
  if (decision.status === 'declined') {
    // v3.2.6 (Part A) — if the meeting was ALREADY moved, "doesn't work" can't
    // just "keep the original" (it's not there anymore). Escalate to the owner
    // WITH the revert option; his next-turn reply ("revert" / "leave it" / a new
    // time) is handled by the orchestrator — same lightweight pattern as the
    // counter fallback below.
    const ownerMsg = ctx.already_moved
      ? `${job.colleague_name} says the time I moved "${ctx.meeting_subject}" to (${proposedStartLocal}) doesn't work — I'd shifted it to clear a clash. Want me to move it back to ${ctx.original_start ? formatLocalTime(ctx.original_start, timezone) : 'the original time'} (back into the clash), or find another slot? Reply preview: "${replyText.slice(0, 120)}"`
      : `${job.colleague_name} declined moving "${ctx.meeting_subject}". Keeping the original time. Reply preview: "${replyText.slice(0, 120)}"`;
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
              let moveApplied = false;
              try {
                await updateMeeting({
                  userEmail: profile.user.email,
                  timezone,
                  meetingId: ctx.meeting_id,
                  start: counterStartDt.toISO() ?? ctx.proposed_start,
                  end: counterEndDt.toISO() ?? ctx.proposed_end,
                });
                // v3.2.x — headless move (auto-accepted counter): slide any
                // floating block it landed on, in code. Own try/catch.
                try {
                  const { rebalanceFloatingBlocksAfterMutation } = await import('../utils/rebalanceFloatingBlocks');
                  await rebalanceFloatingBlocksAfterMutation({
                    profile,
                    affectedSlotIso: counterStartDt.toISO() ?? ctx.proposed_start,
                    ownerSlackId: profile.user.slack_user_id,
                  });
                } catch (rebErr) {
                  logger.warn('rebalance after counter auto-accept move threw — continuing', { err: String(rebErr).slice(0, 200), jobId: job.id });
                }
                moveApplied = true;
              } catch (err) {
                // updateMeeting threw → the move did NOT land. Do NOT confirm it:
                // this used to fall straight through and ship a phantom "moved to
                // X" to the colleague + "so I moved it" to the owner + close the
                // job, all on a failed PATCH. Leave moveApplied false and drop to
                // the owner-ask fallback below — mirror the `approved` branch,
                // which errors out on the same failure instead of lying.
                logger.error('Reschedule counter auto-accept: updateMeeting failed — asking owner instead', {
                  err: String(err), jobId: job.id,
                });
              }

              if (moveApplied) {
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
                return true;
              }
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

/**
 * v3.2.6 (Part A) — notify a colleague that an active-mode autofix ALREADY moved
 * a shared meeting (off a clash) to a verified-free in-week slot, with a pushback
 * escape hatch. Creates a `meeting_reschedule` outreach job tagged
 * `already_moved` so the colleague's reply routes back through
 * `handleRescheduleReply`: "fine" → no-op confirm; "doesn't work" → owner
 * approval w/ revert; a counter → auto-accept (same-week, rule-compliant) or ask.
 * Best-effort; never throws (a notify failure must not unwind the move). Returns
 * whether the DM actually reached the colleague — v4.2.x, so the option-C
 * correction relay can't report a correction it never delivered.
 *
 * R4/R5 — this ask ENDS ON ITS OWN. It is `await_reply: 1`, so it needs the two
 * things that make silence a complete outcome instead of an orphan: a
 * `reply_deadline` (the only thing that arms the linked request's
 * `outreach_expiry` timer) and the owner's return channel on that request (the
 * only thing that lets the expiry tombstone reach him). Both were missing until
 * 2026-07-26, which is why the request was born `awaiting_colleague` with
 * `next_check_at` NULL and a later calendar mutation was the ONLY thing that
 * could ever close it. See the block at the createOutreachJob call below.
 */
export async function notifyColleagueOfMove(params: {
  profile: UserProfile;
  ownerChannel: string;
  ownerThreadTs?: string;
  colleagueSlackId: string;
  colleagueName: string;
  colleagueTz?: string;
  meetingId: string;
  meetingSubject: string;
  /**
   * The time the meeting is moving FROM. Optional (v4.2.x): a CORRECTION relay
   * doesn't have a meaningful "original" to offer — the time it is correcting is
   * one the owner just undid, so naming it as the revert target on a "doesn't
   * work" reply would offer him back the thing he rejected. Omitted → the decline
   * branch says "the original time" generically.
   */
  originalStartIso?: string;
  originalEndIso?: string;
  newStartIso: string;
  newEndIso: string;
  conflictReason?: string;
  /**
   * v4.2.x (owner decision "option C") — set when this notice CORRECTS a time
   * this colleague was already told for this meeting: the ISO instant from the
   * voided outreach's `ctx.proposed_start`. Rewords the notice as an explicit
   * correction and marks the payload `correction: true`.
   *
   * Only a genuinely DIFFERENT time reaches here — the caller
   * (utils/closeMeetingArtifacts.ts → relayVoidedNotices) compares instants
   * first, because re-confirming an unchanged time is the chasing the owner
   * ruled against.
   */
  correctsToldStartIso?: string;
}): Promise<boolean> {
  try {
    const { profile } = params;
    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (!conn) return false;
    const tz = profile.user.timezone;
    const newLocal = DateTime.fromISO(params.newStartIso, { zone: tz }).toFormat('EEEE d MMM \'at\' HH:mm');
    const ownerFirst = profile.user.name.split(' ')[0];
    const colleagueFirst = params.colleagueName.split(' ')[0];
    const because = params.conflictReason ? ` — it clashed with ${params.conflictReason}` : '';
    const toldLocal = params.correctsToldStartIso
      ? DateTime.fromISO(params.correctsToldStartIso, { zone: tz }).toFormat('EEEE d MMM \'at\' HH:mm')
      : null;
    const message = toldLocal
      ? `Hi ${colleagueFirst}, quick correction on "${params.meetingSubject}" — I told you ${toldLocal}, and that's changed: it's now ${newLocal}. Sorry for the back-and-forth. If the new time doesn't work for you, say the word and I'll sort it out with ${ownerFirst}.`
      : `Hi ${colleagueFirst}, I moved our "${params.meetingSubject}" to ${newLocal}${because}. If that doesn't work for you, just say the word and I'll sort it out with ${ownerFirst}.`;

    const ctx: RescheduleContext = {
      meeting_id: params.meetingId,
      meeting_subject: params.meetingSubject,
      proposed_start: params.newStartIso,
      proposed_end: params.newEndIso,
      original_start: params.originalStartIso,
      original_end: params.originalEndIso,
      already_moved: true,
      ...(params.correctsToldStartIso ? { correction: true } : {}),
    };

    const jobId = createOutreachJob({
      owner_user_id: profile.user.slack_user_id,
      owner_channel: params.ownerChannel,
      owner_thread_ts: params.ownerThreadTs,
      colleague_slack_id: params.colleagueSlackId,
      colleague_name: params.colleagueName,
      colleague_tz: params.colleagueTz,
      message,
      await_reply: 1,
      status: 'sent',
      sent_at: new Date().toISOString(),
      intent: 'meeting_reschedule',
      // `reply_deadline` is the ONLY thing that arms the linked request's
      // `outreach_expiry` next_check (db/jobs.ts — the reply_deadline branch of
      // createOutreachJob). Omitting it fell through to the "no explicit
      // deadline" branch: state `awaiting_colleague`, phase
      // `outreach:awaiting_reply`, next_check_at NULL — an ask with no terminal
      // path, which is what left a calendar mutation as its only possible
      // closer. Same shared convention message_colleague uses (24 working
      // hours in THEIR zone, skills/outreach.ts → calcResponseDeadline), so
      // silence resolves the way it does for every other await_reply
      // outreach: expire, close, tell both sides.
      reply_deadline: calcResponseDeadline(params.colleagueTz ?? tz),
      context_json: JSON.stringify(ctx),
    });

    const res = await conn.sendDirect(params.colleagueSlackId, message);
    if (!res.ok) {
      // Not delivered → there is no ask. Cancel it through the spine (the bridge in
      // updateOutreachJob closes the linked request) rather than leaving a live
      // `awaiting_colleague` row: with the timer now armed, an undelivered notice
      // would otherwise expire and tell the owner "they never replied" about a
      // message that never arrived. Mirrors skills/outreach.ts's send-failure path.
      updateOutreachJob(jobId, {
        status: 'cancelled',
        reply_text: `Move notice not delivered: ${res.reason}`,
      });
      logger.warn('notifyColleagueOfMove — DM not delivered, ask cancelled (move stands)', {
        jobId, colleague: params.colleagueName, meetingId: params.meetingId, reason: res.reason,
      });
      return false;
    }
    // Delivered. `ts` is optional — without it we just can't thread follow-ups to
    // the DM; the ask itself stays live and the reply still routes by colleague
    // (db/jobs.ts → getOutreachJobsByColleague), so a missing ts is not a failure.
    if (res.ts) {
      updateOutreachJob(jobId, { dm_channel_id: res.ref, dm_message_ts: res.ts });
    }

    // The expiry tombstone to the owner is gated on the REQUEST's
    // `owner_dm_channel` (core/requests/runner.ts — runOutreachExpiryOrDecision),
    // and createOutreachJob never sets it: only message_colleague stamped it
    // post-send. So this class expired silently on the owner's side even once the
    // timer existed. Channel ONLY — never the thread ts: on the autofix path
    // `ownerThreadTs` is the pseudo-key `brief_health_<ownerId>` (tasks/briefs.ts),
    // not a Slack ts, and it is passed straight through to chat.postMessage, which
    // rejects an invalid thread_ts. A top-level DM in his own channel is the right
    // home for an autofix tombstone anyway — the daily decision thread is
    // approvals-only by owner ruling (utils/ownerDailyThread.ts).
    if (params.ownerChannel) {
      try {
        const linkedRequestId = getLinkedRequestIdForOutreach(jobId);
        if (linkedRequestId) updateRequest(linkedRequestId, { ownerDmChannel: params.ownerChannel });
      } catch (err) {
        logger.warn('notifyColleagueOfMove — owner return-channel stamp failed (expiry tombstone may not land)', {
          jobId, err: String(err).slice(0, 200),
        });
      }
    }

    logger.info('notifyColleagueOfMove — sent move notice', {
      jobId, colleague: params.colleagueName, meetingId: params.meetingId,
      newStart: params.newStartIso, correction: !!params.correctsToldStartIso,
    });
    return true;
  } catch (err) {
    logger.warn('notifyColleagueOfMove threw — move stands, notice not sent', { err: String(err).slice(0, 200) });
    return false;
  }
}
