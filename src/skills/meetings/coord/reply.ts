/**
 * Coord reply handling.
 *
 * Ported from connectors/slack/coord.ts (issue #1 sub-phase D5).
 * Handles incoming participant replies:
 *   - Out-of-thread disambiguation (Sonnet context classifier)
 *   - Follow-up on a waiting_owner job (ack + relay to owner)
 *   - Preference replies ("mornings", "Tuesday PM") via parseTimePreference
 *   - Normal slot picks (regex + AI fallback)
 *
 * Calls into state.ts for resolveCoordination / triggerRoundTwo once input
 * is recorded.
 */

import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import type { UserProfile } from '../../../config/userProfile';
import { config } from '../../../config';
import {
  updateCoordJob,
  getCoordJobsByParticipant,
  getPendingApprovalsBySkillRef,
  mergeApprovalPayload,
  setApprovalDecision,
  type CoordParticipant,
  type CoordJob,
} from '../../../db';
import { shadowNotify } from '../../../utils/shadowNotify';
import { getConnection } from '../../../connections/registry';
import { interpretReplyWithAI, isCoordReplyByContext } from './utils';
import { resolveCoordination, triggerRoundTwo } from './state';
import logger from '../../../utils/logger';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * Handles a coordination reply. Supports in-thread replies and out-of-thread
 * replies (falls back to Sonnet context check when the sender has active coord
 * jobs). Disambiguates if multiple jobs match.
 */
export async function handleCoordReply(
  params: {
    senderId: string;
    text: string;
    channelId: string;
    threadTs?: string;
    profile: UserProfile;
  }
): Promise<boolean> {
  const slackConn = getConnection(params.profile.user.slack_user_id, 'slack');
  if (!slackConn) {
    logger.error('handleCoordReply — no Slack connection registered');
    return false;
  }

  const allJobs = getCoordJobsByParticipant(params.senderId, params.profile.user.slack_user_id);
  if (allJobs.length === 0) return false;

  // ── Thread-boundary fast-path ─────────────────────────────────────────────
  // If a coord was initiated in a group DM / channel (C-prefix owner_channel)
  // and this new message arrived in a different channel (e.g. participant's
  // 1:1 DM with Maelle), it's not a reply to that coord — it's a new request.
  const jobs = allJobs.filter(j => {
    const coordIsGroup = j.owner_channel?.startsWith('C');
    if (!coordIsGroup) return true;
    return j.owner_channel === params.channelId;
  });
  if (jobs.length === 0) {
    logger.info('Coord reply: no jobs match the current thread context — routing to orchestrator', {
      senderId: params.senderId,
      channelId: params.channelId,
      filteredOutCount: allJobs.length,
    });
    return false;
  }

  const namesFor = (j: CoordJob): string[] => {
    try {
      const parts = JSON.parse(j.participants) as CoordParticipant[];
      return parts.map(p => p.name).filter(Boolean);
    } catch { return []; }
  };

  const slotsFor = (j: CoordJob): string[] => {
    try { return JSON.parse(j.proposed_slots) as string[]; } catch { return []; }
  };

  // v2.3.2 — pending vote check. The recency safety net only fires when the
  // sender hasn't already responded; a colleague who picked yesterday and
  // sends a casual chat today shouldn't get pulled back into the coord.
  const senderHasPendingVote = (j: CoordJob): boolean => {
    try {
      const parts = JSON.parse(j.participants) as CoordParticipant[];
      const me = parts.find(p => p.slack_id === params.senderId);
      return !!me && me.response === null;
    } catch { return false; }
  };

  // v2.3.2 — pre-LLM deterministic gate. Catches the "Amazia quoted the slot
  // text back" pattern + the "we just DM'd them, anything they say is likely
  // about it" pattern. Both bypass `isCoordReplyByContext` (which is too
  // strict on bare confirmations like "it is ok").
  //
  // Layer 1: slot-label substring match. If the message text contains a
  // date-time label that matches one of THIS coord's proposed slots (using
  // the same format we sent in the DM), confidence is high enough to skip
  // the LLM gate.
  //
  // Layer 2: recency-based softening. If the sender has a pending vote in a
  // coord whose last DM landed in the last RECENT_REPLY_WINDOW_MIN minutes,
  // override the gate. The intuition: a colleague who JUST got slot options
  // and sends a vague "ok" / "sure" / "sounds good" moments later is almost
  // certainly responding to those slots, not opening a new topic.
  const RECENT_REPLY_WINDOW_MIN = 10;

  const slotLabelMatchFor = (j: CoordJob): boolean => {
    const slots = slotsFor(j);
    if (slots.length === 0) return false;
    const tz = params.profile.user.timezone;
    const text = params.text;
    for (const iso of slots) {
      const dt = DateTime.fromISO(iso).setZone(tz);
      if (!dt.isValid) continue;
      // Match the same label format used in `sendCoordDM`
      // ("Thursday, 30 April at 13:30"). Substring check is enough — we
      // don't need an exact match, the colleague might prefix/suffix.
      const fullLabel = dt.toFormat("EEEE, d MMMM 'at' HH:mm");
      if (text.includes(fullLabel)) return true;
      // Looser fallback — date + time without "at" wording.
      const looser = dt.toFormat("d MMMM") + ' ' + dt.toFormat('HH:mm');
      if (text.includes(looser)) return true;
    }
    return false;
  };

  const recentDmTo = (j: CoordJob): boolean => {
    try {
      const parts = JSON.parse(j.participants) as CoordParticipant[];
      const me = parts.find(p => p.slack_id === params.senderId);
      const lastDmIso = (me as any)?.dm_sent_at as string | undefined;
      if (!lastDmIso) return false;
      const sent = DateTime.fromISO(lastDmIso);
      if (!sent.isValid) return false;
      const ageMin = DateTime.utc().diff(sent.toUTC(), 'minutes').minutes;
      return ageMin <= RECENT_REPLY_WINDOW_MIN;
    } catch { return false; }
  };

  let job: CoordJob;

  // Layer 1 + 2 — try deterministic / recency match across pending-vote jobs
  // first. If exactly one job matches, lock to it and skip the LLM gate.
  const pendingJobs = jobs.filter(senderHasPendingVote);
  const deterministicMatch = pendingJobs.filter(j => slotLabelMatchFor(j) || recentDmTo(j));
  if (deterministicMatch.length === 1) {
    job = deterministicMatch[0];
    logger.info('Coord reply: deterministic / recency match — bypassing LLM gate', {
      jobId: job.id, sender: params.senderId,
      reason: slotLabelMatchFor(job) ? 'slot_label_match' : 'recent_dm',
    });
  } else if (jobs.length === 1) {
    const isRelevant = await isCoordReplyByContext(params.text, jobs[0].subject, namesFor(jobs[0]));
    if (!isRelevant) return false;
    job = jobs[0];
  } else {
    for (const j of jobs) {
      const isRelevant = await isCoordReplyByContext(params.text, j.subject, namesFor(j));
      if (isRelevant) {
        job = j;
        break;
      }
    }
    if (!job!) {
      const subjects = jobs.map((j, i) => `${i + 1}. "${j.subject}"`).join('\n');
      await slackConn.postToChannel(
        params.channelId,
        `I have a few open scheduling threads with you — which one is this about?\n${subjects}`,
        { threadTs: params.threadTs },
      );
      return true;
    }
  }

  const participants = JSON.parse(job.participants) as CoordParticipant[];
  const proposedSlots = JSON.parse(job.proposed_slots) as string[];
  const participant = participants.find(p => p.slack_id === params.senderId);
  if (!participant) return false;

  logger.info('Coord reply received', { jobId: job.id, from: participant.name });

  // ── Follow-up on a waiting_owner job ────────────────────────────────────
  // v2.0.4 — classify the follow-up and act on it. Previously this branch just
  // acked + shadow-logged, throwing away counter-offers / cancellations. Now:
  //   - counter (new time): update the pending approval's payload with the
  //     amended offer + DM the owner directly so they see the new option
  //   - confirm (just acknowledging): ack + log (prior behavior)
  //   - cancel (participant pulling out): resolve approval cancelled + notify owner
  //   - other (question / vague): ack + log (prior behavior)
  if (job.status === 'waiting_owner' && participant.response !== null) {
    const ackInThread = participant.contacted_via === 'group' && job.owner_channel === params.channelId;
    const followupIntent = await classifyWaitingOwnerFollowup({
      text: params.text.trim(),
      subject: job.subject,
      participantName: participant.name,
      originalSlot: job.winning_slot ?? undefined,
      timezone: params.profile.user.timezone,
    });

    logger.info('Coord waiting_owner follow-up classified', {
      jobId: job.id,
      participant: participant.name,
      intent: followupIntent.intent,
      hasProposed: !!followupIntent.proposed_iso,
      reason: followupIntent.reason,
    });

    // Counter-offer: new time proposed by the participant.
    //
    // v2.1.1 — MOVE-intent auto-accept path. When the coord is moving an
    // existing meeting (not booking a new one) AND the counter is
    // (a) same ISO week as the original AND (b) within Idan's rules
    // (no buffer break, no floating-block window violation, within work
    // hours — all enforced by `findAvailableSlots`), we accept the counter
    // autonomously: book the move, shadow-DM the owner, done. If any check
    // fails, fall through to the existing approval flow so the owner can
    // decide. The auto-accept never fires for schedule-intent coords.
    if (followupIntent.intent === 'counter') {
      if (
        params.profile.behavior.calendar_health_mode === 'active'
        && job.intent === 'move'
        && job.existing_event_id
        && followupIntent.proposed_iso
      ) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const cal = require('../../../connectors/graph/calendar') as typeof import('../../../connectors/graph/calendar');
          // Parse the original-meeting start from the move context we
          // stashed in notes at initiateCoordination time.
          let moveCtx: { currentStart?: string } | null = null;
          try { moveCtx = job.notes ? (JSON.parse(job.notes).moveContext ?? null) : null; } catch (_) {}
          const originalStart = moveCtx?.currentStart;
          const counterDt = DateTime.fromISO(followupIntent.proposed_iso).setZone(params.profile.user.timezone);
          const originalDt = originalStart
            ? DateTime.fromISO(originalStart).setZone(params.profile.user.timezone)
            : null;

          // Rule 1 — same ISO week.
          const sameWeek = originalDt
            ? (counterDt.weekYear === originalDt.weekYear && counterDt.weekNumber === originalDt.weekNumber)
            : false;

          if (sameWeek) {
            // Rule 2 — rule compliance. Narrow-window findAvailableSlots:
            // search exactly the counter slot (± 1 min) for the meeting's
            // duration. If the slot comes back, it passes every scheduled
            // rule (buffer, work hours, floating blocks, protected list).
            const duration = job.duration_min;
            const startMs = counterDt.toMillis();
            const fromIso = DateTime.fromMillis(startMs - 60_000).toUTC().toISO()!;
            const toIso = DateTime.fromMillis(startMs + duration * 60_000 + 60_000).toUTC().toISO()!;
            let validSlots: Array<{ start: string }> = [];
            try {
              validSlots = await cal.findAvailableSlots({
                userEmail: params.profile.user.email,
                timezone: params.profile.user.timezone,
                durationMinutes: duration,
                attendeeEmails: [params.profile.user.email],
                searchFrom: fromIso,
                searchTo: toIso,
                profile: params.profile,
              });
            } catch (err) {
              logger.warn('Counter auto-accept: findAvailableSlots threw, falling back to approval', {
                err: String(err).slice(0, 200), jobId: job.id,
              });
            }

            const matches = validSlots.some(s => {
              const s1 = DateTime.fromISO(s.start).toMillis();
              return Math.abs(s1 - startMs) <= 60_000;
            });

            if (matches) {
              logger.info('Counter auto-accept (move coord, rule-compliant, same week) — booking', {
                jobId: job.id, counterIso: followupIntent.proposed_iso,
              });
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const booking = require('./booking') as typeof import('./booking');
              await booking.bookCoordination(job.id, followupIntent.proposed_iso, params.profile);
              // Shadow DM so owner sees what happened
              await shadowNotify(params.profile, {
                channel: job.owner_channel,
                threadTs: job.owner_thread_ts ?? undefined,
                action: 'Auto-accepted counter',
                detail: `${participant.name} countered "${job.subject}" to ${counterDt.toFormat('EEEE d MMM HH:mm')} — same week, within your rules, so I moved it. Let me know if you'd rather I hadn't.`,
                conversationKey: `coord:${job.id}`,
                conversationHeader: `Coord: "${job.subject}"`,
              });
              // Ack the participant
              await slackConn.postToChannel(params.channelId, `Works — I've moved "${job.subject}" to ${counterDt.toFormat('EEEE d MMM, HH:mm')}. See you then.`, {
                threadTs: ackInThread ? (job.owner_thread_ts ?? undefined) : undefined,
              });
              return true;
            }
          }
        } catch (err) {
          logger.warn('Counter auto-accept pre-check threw — falling back to approval', {
            err: String(err).slice(0, 200), jobId: job.id,
          });
        }
        // Fall through to the approval path below on any failure.
      }

      // Existing path: attach counter to pending approval + DM owner for
      // sign-off. Used for schedule-intent coords, passive mode, counters
      // outside same week, or counters that break a rule.
      const pendings = getPendingApprovalsBySkillRef(job.id);
      const proposedLocalLabel = followupIntent.proposed_iso
        ? DateTime.fromISO(followupIntent.proposed_iso).setZone(params.profile.user.timezone).toFormat('EEEE d MMM \'at\' HH:mm')
        : null;
      for (const ap of pendings) {
        mergeApprovalPayload(ap.id, {
          counter_offer: {
            iso: followupIntent.proposed_iso ?? null,
            label: proposedLocalLabel,
            raw_text: params.text.trim(),
            from_participant: participant.name,
            received_at: new Date().toISOString(),
          },
        });
      }
      // DM owner so they SEE this (not just log it)
      const ownerMsg = proposedLocalLabel
        ? `${participant.name} came back on "${job.subject}" — now proposing ${proposedLocalLabel} instead. Want me to take that, or suggest something else?`
        : `${participant.name} came back on "${job.subject}" with a different time: "${params.text.trim().slice(0, 200)}". Want me to work that out?`;
      await slackConn.postToChannel(job.owner_channel, ownerMsg, {
        threadTs: job.owner_thread_ts ?? undefined,
      });
      await slackConn.postToChannel(params.channelId, `Got it, I'll run that past Idan.`, {
        threadTs: ackInThread ? (job.owner_thread_ts ?? undefined) : undefined,
      });
      return true;
    }

    // Cancellation: participant pulling out. Resolve pending approval as
    // cancelled (cascading task/coord cleanup is handled by setApprovalDecision).
    if (followupIntent.intent === 'cancel') {
      const pendings = getPendingApprovalsBySkillRef(job.id);
      for (const ap of pendings) {
        setApprovalDecision({ id: ap.id, status: 'cancelled', decision: { reason: `${participant.name} pulled out: ${params.text.trim().slice(0, 160)}` } });
      }
      updateCoordJob(job.id, { status: 'cancelled', notes: `${participant.name} pulled out` });
      await slackConn.postToChannel(job.owner_channel,
        `${participant.name} pulled out of "${job.subject}": "${params.text.trim().slice(0, 200)}". I've closed it.`,
        { threadTs: job.owner_thread_ts ?? undefined },
      );
      await slackConn.postToChannel(params.channelId, `No worries, I'll let Idan know.`, {
        threadTs: ackInThread ? (job.owner_thread_ts ?? undefined) : undefined,
      });
      return true;
    }

    // Confirm or other: prior behavior — ack + shadow log.
    await slackConn.postToChannel(params.channelId, `Thanks! I'll pass that along.`, {
      threadTs: ackInThread ? (job.owner_thread_ts ?? undefined) : undefined,
    });
    await shadowNotify(params.profile, {
      channel: job.owner_channel,
      threadTs: job.owner_thread_ts ?? undefined,
      action: 'Follow-up received',
      detail: `${participant.name} followed up on "${job.subject}": "${params.text.trim().slice(0, 200)}"`,
      conversationKey: `coord:${job.id}`,
      conversationHeader: `Coord: "${job.subject}"`,
    });
    return true;
  }

  // ── Preference reply: they were asked "what times work for you?" ─
  if ((participant as any)._awaiting_preference) {
    await handlePreferenceReply(job, participant, params.text.trim(), params.profile);
    return true;
  }

  // ── Normal slot-selection reply ─
  const text = params.text.trim();
  let preferredSlot: string | undefined;
  let response: 'yes' | 'no' | 'maybe' = 'maybe';
  let suggestedAlternative: string | null = null;
  let locationOverride: string | undefined;

  const numMatch = text.match(/^[123]/);
  if (numMatch) {
    const idx = parseInt(numMatch[0]) - 1;
    if (idx >= 0 && idx < proposedSlots.length) {
      preferredSlot = proposedSlots[idx];
      response = 'yes';
    }
  } else if (/\b(none|doesn'?t work|no time|can'?t|cannot|busy|not available|nope|no)\b/i.test(text)) {
    response = 'no';
  } else if (/\b(any|works|fine|good|ok|sure|yes|yep|yeah|perfect|great|sounds good)\b/i.test(text)) {
    response = 'yes';
    preferredSlot = proposedSlots[0];
  } else {
    const aiResult = await interpretReplyWithAI(text, proposedSlots, params.profile.user.timezone);
    response = aiResult.response;
    suggestedAlternative = aiResult.suggestedAlternative;
    locationOverride = aiResult.locationOverride ?? undefined;
    if (aiResult.response === 'yes') {
      const idx = aiResult.slotIndex ?? 0;
      preferredSlot = proposedSlots[idx] ?? proposedSlots[0];
    }

    if (aiResult.preferOnline !== undefined || locationOverride) {
      try {
        const existingNotes = JSON.parse(job.notes ?? '{}');
        const updatedNotes: Record<string, unknown> = { ...existingNotes };
        if (aiResult.preferOnline !== undefined) updatedNotes.isOnline = aiResult.preferOnline;
        if (locationOverride) updatedNotes.location = locationOverride;
        updateCoordJob(job.id, { notes: JSON.stringify(updatedNotes) });
      } catch (_) {}
    }
  }

  logger.info('Coord reply parsed', {
    jobId: job.id,
    participant: participant.name,
    response,
    preferredSlot: preferredSlot ?? null,
    suggestedAlternative,
  });

  // ── Handle 'maybe' ─
  if (response === 'maybe' && suggestedAlternative) {
    response = 'no';
  }
  if (response === 'maybe') {
    // v2.3.2 — human phrasing for ambiguous-reply confirmation. Owner direction:
    // never say "pick a number 1/2/3" — that reads like a bot form. Name the
    // slots and ask plainly. Single slot → "just verifying X works for you?".
    // Multiple slots → "was that <a> or <b>?".
    const tz = params.profile.user.timezone;
    const slotLabels = proposedSlots.map(iso => {
      const dt = DateTime.fromISO(iso).setZone(tz);
      return dt.isValid ? dt.toFormat("EEEE 'at' HH:mm") : iso;
    });
    let clarification: string;
    if (slotLabels.length === 0) {
      clarification = `Just want to make sure I've got that right — which time works for you?`;
    } else if (slotLabels.length === 1) {
      clarification = `Just verifying — ${slotLabels[0]} works for you?`;
    } else if (slotLabels.length === 2) {
      clarification = `Just to make sure — was that ${slotLabels[0]} or ${slotLabels[1]}?`;
    } else {
      const last = slotLabels[slotLabels.length - 1];
      const rest = slotLabels.slice(0, -1).join(', ');
      clarification = `Just to make sure — was that ${rest}, or ${last}? Or none of those — happy to find something else.`;
    }
    await slackConn.postToChannel(
      params.channelId,
      clarification,
      { threadTs: params.threadTs },
    );
    // v2.2.4 (bug 3c) — 'Reply received — unclear' shadow dropped. The owner
    // sees the participant's actual reply through the audit log; an extra DM
    // for "we asked them to clarify" is per-state-hop noise.
    return true;
  }

  // Pre-parse preference from suggestedAlternative
  let preParsedPreference: { searchFrom: string; searchTo: string; hoursStart: string; hoursEnd: string } | undefined;
  if (response === 'no' && suggestedAlternative) {
    preParsedPreference = await parseTimePreference(suggestedAlternative, params.profile.user.timezone);
  }

  // Update participant response
  const updatedParticipants = participants.map(p =>
    p.slack_id === params.senderId
      ? {
          ...p,
          response,
          preferred_slot: preferredSlot,
          responded_at: new Date().toISOString(),
          ...(suggestedAlternative ? { _suggestedAlternative: suggestedAlternative } : {}),
          ...(preParsedPreference ? { _preference: preParsedPreference } : {}),
        }
      : p
  );
  updateCoordJob(job.id, {
    participants: JSON.stringify(updatedParticipants),
    last_participant_activity_at: new Date().toISOString(),
  });

  // v2.1.5 — compute allResponded BEFORE the ack so we can skip the
  // "I'll confirm once everyone responds" line when this yes-vote completes
  // the round. The booking confirmation from resolveCoordination follows
  // moments later and is the real response; the intermediate ack just
  // added noise (three messages in a thread where one was right).
  const keyParticipants = updatedParticipants.filter(p => !p.just_invite);
  const allResponded = keyParticipants.every(p => p.response !== null && p.response !== 'maybe');

  // Acknowledge — suppress the wait-ack when a yes-vote completes the round.
  const ackText = response === 'no'
    ? `Got it — I'll find some other options and come back to you.`
    : allResponded
      ? null   // booking confirmation is about to arrive; skip the interim ack
      : `Great, noted! I'll confirm once everyone responds.`;

  const ackInThread = participant.contacted_via === 'group' && job.owner_channel === params.channelId;
  if (ackText !== null) {
    await slackConn.postToChannel(params.channelId, ackText, {
      threadTs: ackInThread ? (job.owner_thread_ts ?? undefined) : undefined,
    });
  }

  // v2.2.4 (bug 3c) — 'Reply received' per-vote shadow dropped on the yes
  // path. The booking confirmation (when allResponded) is the decision-worthy
  // event and lands moments later. On the no path, the round-2 shadow that
  // follows carries the same narration ("X countered with …, looking at new
  // window"). One shadow per cycle, not four.
  if (response === 'no') {
    const counterLabel = suggestedAlternative ? ` (suggested: "${suggestedAlternative}")` : '';
    await shadowNotify(params.profile, {
      channel: job.owner_channel,
      threadTs: job.owner_thread_ts ?? undefined,
      action: 'Counter received',
      detail: `${participant.name} can't make any slot for "${job.subject}"${counterLabel} — looking for a new window`,
      conversationKey: `coord:${job.id}`,
      conversationHeader: `Coord: "${job.subject}"`,
    });
  }

  if (allResponded) {
    await resolveCoordination(job.id, params.profile);
  }

  return true;
}

/**
 * Use Sonnet to parse a free-text time preference into a concrete search window.
 */
/**
 * Classify a reply that arrived on a coord already in waiting_owner state.
 * The participant has already given their slot pick; this later message is a
 * follow-up. It could be a counter-offer, confirmation, cancellation, or noise.
 * Uses a tool_use Sonnet call so the structured output is guaranteed.
 */
async function classifyWaitingOwnerFollowup(params: {
  text: string;
  subject: string;
  participantName: string;
  originalSlot?: string;  // ISO of the slot currently pending approval
  timezone: string;
}): Promise<{
  intent: 'counter' | 'confirm' | 'cancel' | 'other';
  proposed_iso?: string;
  reason: string;
}> {
  const originalLocal = params.originalSlot
    ? DateTime.fromISO(params.originalSlot).setZone(params.timezone).toFormat('EEEE d MMM \'at\' HH:mm')
    : '(unknown)';
  const today = DateTime.now().setZone(params.timezone).toFormat('yyyy-MM-dd');

  const prompt = `${params.participantName} was asked to confirm a meeting time for "${params.subject}" — they earlier picked ${originalLocal}. That slot is currently pending the owner's approval because of a calendar conflict. Now they've sent this follow-up message:

"${params.text.slice(0, 500)}"

Classify the follow-up. Today is ${today} (${params.timezone}). Output ONE of:
- intent="counter" — they're proposing a NEW time (different day/hour). Extract the proposed time as ISO if clear.
- intent="confirm" — they're just reconfirming / nudging about the original slot.
- intent="cancel" — they're pulling out, declining, or saying "never mind".
- intent="other" — a question, small talk, or ambiguous.

Only set intent=counter if you can tell they want a DIFFERENT time from the original. "Still works for me" = confirm, NOT counter. Convert relative dates ("next Monday", "tomorrow") to ISO relative to today.`;

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      tools: [{
        name: 'classify_followup',
        description: 'Classify a coord follow-up message from a participant after they already picked a slot.',
        input_schema: {
          type: 'object' as const,
          properties: {
            intent: { type: 'string', enum: ['counter', 'confirm', 'cancel', 'other'] },
            proposed_iso: { type: 'string', description: 'ISO datetime of the new time, in the participant timezone. Only when intent=counter AND the time is clear. Empty string otherwise.' },
            reason: { type: 'string', description: 'One sentence explaining the call.' },
          },
          required: ['intent', 'reason'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify_followup' },
      messages: [{ role: 'user', content: prompt }],
    });
    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    if (!toolUse?.input) return { intent: 'other', reason: 'classifier returned no verdict' };
    const v = toolUse.input as { intent: string; proposed_iso?: string; reason?: string };
    const intent = (v.intent === 'counter' || v.intent === 'confirm' || v.intent === 'cancel') ? v.intent : 'other';
    const proposed = v.proposed_iso && v.proposed_iso.trim().length > 0 ? v.proposed_iso.trim() : undefined;
    return { intent, proposed_iso: proposed, reason: v.reason ?? '' };
  } catch (err) {
    logger.warn('classifyWaitingOwnerFollowup failed', { err: String(err).slice(0, 200) });
    return { intent: 'other', reason: 'classifier error' };
  }
}

async function parseTimePreference(
  text: string,
  timezone: string,
): Promise<{ searchFrom: string; searchTo: string; hoursStart: string; hoursEnd: string }> {
  const today = DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');
  const nextWeek = DateTime.now().setZone(timezone).plus({ days: 7 }).toFormat('yyyy-MM-dd');
  try {
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system:
        `Today is ${today} (timezone: ${timezone}). ` +
        `Parse this scheduling preference into a search window.\n` +
        `Reply with JSON only — no other text:\n` +
        `{"searchFrom":"YYYY-MM-DD","searchTo":"YYYY-MM-DD","hoursStart":"HH:MM","hoursEnd":"HH:MM"}\n\n` +
        `Rules:\n` +
        `- "morning" = 08:00-12:00, "afternoon" = 13:00-17:00, "evening" = 17:00-20:00\n` +
        `- If a specific day is named, use that day for both from and to\n` +
        `- If no day specified, use today through ${nextWeek}\n` +
        `- Default hours (no preference stated): 09:00-18:00`,
      messages: [{ role: 'user', content: text }],
    });
    const raw = ((result.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const parsed = JSON.parse(raw);
    return {
      searchFrom: parsed.searchFrom ?? today,
      searchTo: parsed.searchTo ?? nextWeek,
      hoursStart: parsed.hoursStart ?? '09:00',
      hoursEnd: parsed.hoursEnd ?? '18:00',
    };
  } catch {
    return { searchFrom: today, searchTo: nextWeek, hoursStart: '09:00', hoursEnd: '18:00' };
  }
}

async function handlePreferenceReply(
  job: CoordJob,
  participant: CoordParticipant,
  text: string,
  profile: UserProfile,
): Promise<void> {
  const slackConn = getConnection(profile.user.slack_user_id, 'slack');
  if (!slackConn) {
    logger.error('handlePreferenceReply — no Slack connection registered');
    return;
  }

  const window = await parseTimePreference(text, profile.user.timezone);

  const allParticipants = JSON.parse(job.participants) as CoordParticipant[];
  const updated = allParticipants.map(p =>
    p.slack_id === participant.slack_id
      ? { ...p, _awaiting_preference: false, _preference: window, response: 'yes' as const, preferred_slot: undefined, responded_at: new Date().toISOString() }
      : p
  );
  updateCoordJob(job.id, { participants: JSON.stringify(updated) });

  if (participant.contacted_via === 'group' && participant.group_channel && participant.group_thread_ts) {
    await slackConn.postToChannel(
      participant.group_channel,
      `Got it ${participant.name} — I'll find some options that work for you and check with the others.`,
      { threadTs: participant.group_thread_ts },
    );
  } else if (participant.slack_id) {
    await slackConn.sendDirect(
      participant.slack_id,
      `Got it — I'll find some options that work for you and check with the others.`,
    );
  }

  const stillWaiting = updated.filter(p => !p.just_invite && (p as any)._awaiting_preference === true);
  if (stillWaiting.length > 0) {
    await shadowNotify(profile, {
      channel: job.owner_channel,
      threadTs: job.owner_thread_ts ?? undefined,
      action: 'Preference received',
      detail: `${participant.name} said they prefer ${text} — still waiting for ${stillWaiting.map(p => p.name).join(', ')}`,
      conversationKey: `coord:${job.id}`,
      conversationHeader: `Coord: "${job.subject}"`,
    });
    return;
  }

  await triggerRoundTwo(job, updated, profile);
}
