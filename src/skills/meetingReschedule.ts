/**
 * Meeting-reschedule outreach-reply handler (v1.8.4).
 *
 * When message_colleague is called with intent='meeting_reschedule' and a
 * context_json payload carrying { meeting_id, proposed_start, proposed_end },
 * the outreach job records that intent. Later, when the colleague replies,
 * connectors/slack/coordinator.ts dispatches the reply to this handler
 * instead of falling through to the full orchestrator (the generic,
 * no-routed-intent path — see coordinator.ts's handleOutreachReply).
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
import { getRequest, updateRequest } from '../db/requests';
import { withRequestLock } from '../core/requests/resolver';
import { closeRequest } from '../core/requests/closeRequest';
import { attendeeTzForDay, loadAttendeeAvailabilityForPerson } from '../utils/attendeeAvailability';
import { renderClockInZone } from '../utils/timezoneConvert';
import { resolveStatedInstant } from '../utils/weTimeResolver';
import { getPersonMemory } from '../db/people';
import { updateMeeting, findAvailableSlots } from '../connectors/graph/calendar';
import { appendToConversation } from '../db';
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
 * the caller should fall through to the generic no-routed-intent path (the
 * full orchestrator — e.g. intent missing or context unparseable).
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
  const requestId = params.job.request_id ?? getLinkedRequestIdForOutreach(params.job.id);
  // Serialize with the spine sweep while retaining the durable timer.
  const handle = () => handleRescheduleReplyLocked(params, requestId);
  return requestId ? withRequestLock(requestId, handle) : handle();
}

async function handleRescheduleReplyLocked(
  params: Parameters<typeof handleRescheduleReply>[1],
  requestId: string | null | undefined,
): Promise<boolean> {
  const { job, replyText, profile } = params;
  const current = requestId ? getRequest(requestId) : undefined;
  if (current && !['awaiting_owner', 'awaiting_colleague', 'in_flight'].includes(current.state)) return true;
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

  // Completion clears the timer through the canonical closure. Until then,
  // retain it so parsing, delivery, or process failures cannot orphan the work.

  const conversation: Array<{ role: 'maelle' | 'colleague'; text: string }> =
    job.conversation_json ? JSON.parse(job.conversation_json) : [];
  conversation.push({ role: 'colleague', text: replyText });

  const finishHandledAction = () => updateOutreachJob(job.id, {
    status: 'replied', reply_text: replyText, conversation_json: JSON.stringify(conversation),
  });
  const notifyHandledOwner = async (text: string, remember = false) => {
    try {
      await conn.postToChannel(job.owner_channel, text, { threadTs: job.owner_thread_ts ?? undefined });
      if (remember && job.owner_thread_ts) {
        appendToConversation(job.owner_thread_ts, job.owner_channel, { role: 'assistant', content: text });
      }
    } catch (err) {
      // A notification failure cannot authorize replaying a completed or
      // already-attempted calendar action through the generic reply path.
      logger.warn('Reschedule handled; owner notification failed', { jobId: job.id, err: String(err).slice(0, 200) });
    }
  };

  const finishUncertainMove = async (start: string, end: string): Promise<boolean> => {
    // An exception does not prove a calendar write failed. Verify only the
    // exact requested state with the existing non-mutating recovery reader.
    let status: 'desired_state_observed' | 'different_state_observed' | 'unavailable' = 'unavailable';
    try {
      const { verifyApprovedCalendarAction } = await import('../connectors/graph/calendarReads');
      const verification = await verifyApprovedCalendarAction({
        userEmail: profile.user.email, profile, tool: 'move_meeting', eventId: ctx.meeting_id,
        args: { meeting_id: ctx.meeting_id, new_start: start, new_end: end, stated_zone: timezone },
      });
      status = verification.status;
    } catch (err) {
      logger.warn('Reschedule read-only verification unavailable', { jobId: job.id, err: String(err).slice(0, 200) });
    }
    const observed = status === 'desired_state_observed';
    const reason = observed ? 'reschedule_desired_state_observed'
      : status === 'different_state_observed' ? 'reschedule_requested_state_not_observed'
      : 'reschedule_action_attempted_unconfirmed';
    const ownerMsg = observed
      ? `I tried to move "${ctx.meeting_subject}". A read-only check confirms the requested time is now on the calendar, but does not establish which attempt produced it. I have not repeated the action.`
      : status === 'different_state_observed'
        ? `I tried to move "${ctx.meeting_subject}", but a read-only check did not find the requested calendar state. I have not repeated the action, and no further automatic check is pending.`
        : `I tried to move "${ctx.meeting_subject}", but could not confirm whether it worked. I have not repeated the action, and no further automatic check is pending.`;
    // Persist an honest outcome BEFORE fallible delivery. closeRequest sets
    // informed=0 so the existing owner brief can surface this exact reason
    // even when the immediate warning fails. No unresolved calendar retry.
    updateOutreachJob(job.id, { reply_text: replyText, conversation_json: JSON.stringify(conversation) });
    if (requestId) {
      closeRequest({ id: requestId, state: observed ? 'resolved' : 'cancelled',
        closureReason: reason, closedBy: 'system', skipChildren: true,
        outcomeJson: { replayed: 'move_meeting', verified: observed } });
    }
    await notifyHandledOwner(ownerMsg);
    return true;
  };

  // ── Branch: approved → move the meeting ──────────────────────────────────
  if (decision.status === 'approved') {
    // v3.2.6 (Part A) — when the meeting was ALREADY moved (autofix), an
    // approval is a no-op: confirm to the colleague + report to owner, don't
    // re-move. Skip straight past the move + rebalance.
    if (ctx.already_moved) {
      const colleagueMsg = `Great — see you then.`;
      conversation.push({ role: 'maelle', text: colleagueMsg });
      finishHandledAction();
      try {
        if (job.dm_channel_id) await conn.postToChannel(job.dm_channel_id, colleagueMsg, { threadTs: job.dm_message_ts });
        else await conn.sendDirect(job.colleague_slack_id, colleagueMsg);
      } catch (err) { logger.warn('reschedule (already_moved approve) colleague DM failed', { err: String(err).slice(0, 160) }); }
      await notifyHandledOwner(
        `${job.colleague_name} is fine with the moved time for "${ctx.meeting_subject}" (${proposedStartLocal}).`);
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
      return finishUncertainMove(ctx.proposed_start, ctx.proposed_end);
    }

    // Confirm to colleague — thread back into the original outreach DM
    // when we recorded it (v2.1.5); fall back to a fresh DM for legacy
    // rows that predate the ts capture.
    const colleagueMsg = `Great, moved to ${proposedStartLocal}. See you then.`;
    conversation.push({ role: 'maelle', text: colleagueMsg });
    finishHandledAction();
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

    // Report to owner
    const ownerMsg = `${job.colleague_name} confirmed, moved "${ctx.meeting_subject}" to ${proposedStartLocal}–${proposedEndLocal}.`;
    await notifyHandledOwner(ownerMsg, true);
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
    const alreadyNudged = job.request_id ? getRequest(job.request_id)?.phase === 'outreach:nudged' : false;
    const ownerMsg = `${job.colleague_name} is checking on "${ctx.meeting_subject}" — nothing decided yet, so I'm keeping the current time. ${alreadyNudged ? 'The one reminder was already sent; this will close at the existing deadline if there is no answer.' : "If I don't hear back I'll nudge once tomorrow."}`;
    await conn.postToChannel(job.owner_channel, ownerMsg, { threadTs: job.owner_thread_ts ?? undefined });
    if (job.owner_thread_ts) {
      appendToConversation(job.owner_thread_ts, job.owner_channel, { role: 'assistant', content: ownerMsg });
    }
    // Persist the colleague reply; DO NOT set a terminal status → job stays open.
    updateOutreachJob(job.id, { reply_text: replyText, conversation_json: JSON.stringify(conversation) });
    // Re-arm the existing request timer for one re-ask at +24h.
    if (job.request_id && !alreadyNudged) {
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
                logger.error('Reschedule counter write threw; verifying without replay', {
                  err: String(err), jobId: job.id,
                });
                return finishUncertainMove(counterStartDt.toISO() ?? ctx.proposed_start,
                  counterEndDt.toISO() ?? ctx.proposed_end);
              }

              if (moveApplied) {
                // Confirm to colleague — thread into the original DM if we have it
                const counterLocal = counterStartDt.toFormat('HH:mm');
                const colleagueMsg = `Works — moved to ${counterLocal}. See you then.`;
                conversation.push({ role: 'maelle', text: colleagueMsg });
                finishHandledAction();
                try {
                  if (job.dm_channel_id) {
                    await conn.postToChannel(job.dm_channel_id, colleagueMsg, { threadTs: job.dm_message_ts });
                  } else {
                    await conn.sendDirect(job.colleague_slack_id, colleagueMsg);
                  }
                } catch (err) {
                  logger.warn('Reschedule counter auto-accept: colleague DM failed', { err: String(err) });
                }

                // The move is terminal; shadow delivery cannot fall into owner approval.
                try {
                await shadowNotify(profile, {
                  channel: job.owner_channel,
                  threadTs: job.owner_thread_ts ?? undefined,
                  action: 'Auto-accepted counter',
                  detail: `${job.colleague_name} countered "${ctx.meeting_subject}" to ${counterStartDt.toFormat('EEEE d MMM HH:mm')} — same week, within your rules, so I moved it. Say the word if you'd rather I hadn't.`,
                });

                } catch (err) {
                  logger.warn('Reschedule counter handled; shadow notification failed', { jobId: job.id, err: String(err).slice(0, 200) });
                }
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

    // Owner ruling 2026-09-19: a counter needing judgment is an approval,
    // never an untracked question. The classifier supplies only a clock, not
    // an authoritative date, so use the existing open-conflict move anchor:
    // the owner's exact choice must arrive before anything can be replayed.
    const { createApprovalRequest } = await import('../tasks/skill');
    const raised = await createApprovalRequest({
      kind: 'policy_exception',
      ask_text: `${job.colleague_name} can't do ${proposedStartLocal}, and offers ${counterDesc} for "${ctx.meeting_subject}". Their reply: "${replyText}". Which exact date and time should I use?`,
      payload: {
        meeting_id: ctx.meeting_id,
        subject: ctx.meeting_subject,
        open_options: [replyText],
        context: `The colleague countered the proposed move; automatic acceptance was not established. Proposed interval: ${ctx.proposed_start}–${ctx.proposed_end}. Reply: ${replyText}`,
        rule: 'reschedule_counter_requires_owner_decision',
      },
    }, {
      profile,
      // This decision originates with the colleague, never with the owner
      // merely because the outbound request carries his return channel.
      userId: job.colleague_slack_id, senderRole: 'colleague', authority: 'colleague',
      surface: 'colleague_dm', channel: 'slack',
      channelId: job.dm_channel_id ?? '', threadTs: job.dm_message_ts ?? '',
      currentUserMessage: replyText,
    }, { replacingOutreachRequestId: requestId ?? undefined }) as { ok?: boolean; approval_id?: string; error?: string };
    if (!raised?.ok || !raised.approval_id) {
      // Keep the original timed work if raising was refused or unavailable.
      // In particular, the existing two-pending-request cap still applies.
      throw new Error(`Reschedule counter approval was not tracked: ${raised?.error ?? 'unconfirmed'}`);
    }
    finishHandledAction();
    return true;
  }

  return false;
}

/**
 * v3.2.6 (Part A) — notify a colleague that an active-mode autofix ALREADY moved
 * a shared meeting (off a clash) to a verified-free in-week slot. This is an
 * informational notice: confirmed delivery finishes the request; silence is
 * fine. A later reply uses the existing recent-outbound conversation context.
 * Explicit owner checks and actual proposals use message_colleague's required
 * await_reply argument instead; this automatic producer never invents one.
 * Best-effort; never throws (a notify failure must not unwind the move). Returns
 * whether the DM actually reached the colleague — v4.2.x, so the option-C
 * correction relay can't report a correction it never delivered.
 *
 * No calendar action is retried to recover notice delivery.
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
  let jobId: string | undefined;
  try {
    const { profile } = params;
    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (!conn) return false;
    const tz = profile.user.timezone;
    const recipient = loadAttendeeAvailabilityForPerson(getPersonMemory(params.colleagueSlackId) ?? undefined, params.colleagueTz ?? tz);
    const localTime = (iso: string): string => {
      const instant = resolveStatedInstant({ startIso: iso, homeTz: tz, profile }).startIso;
      return renderClockInZone(instant, tz,
        recipient ? attendeeTzForDay(recipient, instant) : tz);
    };
    const newLocal = localTime(params.newStartIso);
    const ownerFirst = profile.user.name.split(' ')[0];
    const colleagueFirst = params.colleagueName.split(' ')[0];
    const because = params.conflictReason ? ` — it clashed with ${params.conflictReason}` : '';
    const toldLocal = params.correctsToldStartIso
      ? localTime(params.correctsToldStartIso)
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

    jobId = createOutreachJob({
      owner_user_id: profile.user.slack_user_id,
      owner_channel: params.ownerChannel,
      owner_thread_ts: params.ownerThreadTs,
      colleague_slack_id: params.colleagueSlackId,
      colleague_name: params.colleagueName,
      colleague_tz: params.colleagueTz,
      message,
      await_reply: 0,
      status: 'sent',
      intent: 'meeting_reschedule',
      // The existing bridge keeps unconfirmed delivery in_flight with a
      // bounded timer. Only a confirmed send may stamp sent_at and resolve.
      context_json: JSON.stringify(ctx),
    });

    const res = await conn.sendDirect(params.colleagueSlackId, message);
    if (!res.ok) {
      const requestId = getLinkedRequestIdForOutreach(jobId);
      if (requestId) closeRequest({ id: requestId, state: 'cancelled',
        closureReason: res.reason === 'error' ? 'move_notice_attempted_unconfirmed' : 'move_notice_not_delivered',
        closedBy: 'system', skipChildren: true });
      logger.warn('notifyColleagueOfMove — delivery not confirmed, notice closed (move stands)', {
        jobId, colleague: params.colleagueName, meetingId: params.meetingId, reason: res.reason,
      });
      return false;
    }
    // Stamping confirmed delivery closes this informational request through
    // the existing bridge, while retaining conversational follow-up context.
    updateOutreachJob(jobId, { sent_at: new Date().toISOString(),
      dm_channel_id: res.ref, dm_message_ts: res.ts });

    logger.info('notifyColleagueOfMove — sent move notice', {
      jobId, colleague: params.colleagueName, meetingId: params.meetingId,
      newStart: params.newStartIso, correction: !!params.correctsToldStartIso,
    });
    return true;
  } catch (err) {
    try {
      if (jobId) {
        const requestId = getLinkedRequestIdForOutreach(jobId);
        if (requestId) closeRequest({ id: requestId, state: 'cancelled',
          closureReason: 'move_notice_attempted_unconfirmed', closedBy: 'system', skipChildren: true });
      }
    } catch (closeErr) {
      logger.warn('notifyColleagueOfMove — could not persist notice outcome; existing timer retained', { jobId, err: String(closeErr).slice(0, 200) });
    }
    logger.warn('notifyColleagueOfMove threw — move stands, notice unconfirmed', { err: String(err).slice(0, 200) });
    return false;
  }
}
