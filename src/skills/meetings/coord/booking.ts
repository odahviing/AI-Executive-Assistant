/**
 * Coord booking.
 *
 * Two entry points:
 *   - bookCoordination (internal): called by the resolver path once the state
 *     machine has a winning slot. Pre-booking calendar sanity-check, duration
 *     approval gate, idempotency guard (external_event_id), actual Graph
 *     create_meeting, then notify requesters + participants + owner.
 *   - forceBookCoordinationByOwner (exported): owner-override entry point.
 *     Marks all unresponded key participants as accepted at the chosen slot,
 *     then delegates to bookCoordination. This is the code-level guarantee
 *     behind the prompt rule "owner's pick wins" — finalize_coord_meeting
 *     calls this, so the LLM can't narrate a fake confirmation.
 *
 * Ported from connectors/slack/coord/booking.ts (issue #1 sub-phase D4).
 * Slack-specific `app.client.*` calls now go through the Slack Connection
 * resolved via the registry — skills stay transport-agnostic.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../../../config/userProfile';
import {
  getCoordJob,
  updateCoordJob,
  cancelOrphanCoordJobs,
  logEvent,
  getDb,
  type CoordParticipant,
} from '../../../db';
import { getOpenTasksForOwner } from '../../../tasks';
import { createMeeting, getCalendarEvents, updateMeeting } from '../../../connectors/graph/calendar';
import { shadowNotify } from '../../../utils/shadowNotify';
import { getConnection } from '../../../connections/registry';
import { registerCoordBookingHandler } from '../../../core/approvals/coordBookingHandler';
import { determineSlotLocation } from './utils';
import { emitWaitingOwnerApproval } from './approval';
import logger from '../../../utils/logger';

// ── Force-book: owner decided, skip waiting ─────────────────────────────────

/**
 * Owner-initiated force-book. Bypasses the "wait for every participant" logic
 * when the owner has explicitly picked a slot. Marks all unresponded key
 * participants as accepted at that slot, sets winning_slot, and invokes the
 * real booking path so the calendar invite actually gets created.
 *
 * `app` is kept in the signature for shadowNotify (still Slack-specific) but
 * all coord-owned messaging now goes through the Connection registry.
 */
export async function forceBookCoordinationByOwner(
  jobId: string,
  chosenSlotIso: string,
  profile: UserProfile,
  options: { synchronous?: boolean } = {},
): Promise<{ ok: boolean; reason?: string; status?: string; subject?: string; slot?: string }> {
  const { synchronous = false } = options;
  const job = getCoordJob(jobId);
  if (!job) return { ok: false, reason: `coord job ${jobId} not found` };
  if (job.status === 'booked' || job.status === 'cancelled') {
    return { ok: false, reason: `coord job ${jobId} already ${job.status}`, status: job.status, subject: job.subject };
  }

  const participants = JSON.parse(job.participants) as CoordParticipant[];

  // Normalize slot: if the ISO matches a proposed slot exactly, use that.
  // Otherwise accept the owner-provided time as-is (they may have picked
  // a specific time outside the offered options).
  const proposedSlots = JSON.parse(job.proposed_slots || '[]') as string[];
  const chosenMs = DateTime.fromISO(chosenSlotIso).toMillis();
  const matchedProposed = proposedSlots.find(s => DateTime.fromISO(s).toMillis() === chosenMs);
  const finalSlot = matchedProposed ?? chosenSlotIso;

  const now = new Date().toISOString();
  const updatedParticipants = participants.map(p => {
    if (p.just_invite) return p;
    // Leave explicit "no" responses alone — owner can still book over them,
    // but we shouldn't rewrite their stated answer in the audit trail.
    if (p.response === 'no') return p;
    return {
      ...p,
      response: 'yes' as const,
      preferred_slot: finalSlot,
      responded_at: p.responded_at ?? now,
      _owner_force_booked: true,
    };
  });

  updateCoordJob(jobId, {
    participants: JSON.stringify(updatedParticipants),
    winning_slot: finalSlot,
    status: 'waiting_owner', // bookCoordination transitions to 'booked' on success
  });

  logger.info('Force-booking coord by owner', {
    jobId,
    chosenSlotIso,
    finalSlot,
    matchedProposed: !!matchedProposed,
    participantCount: updatedParticipants.filter(p => !p.just_invite).length,
  });

  // When invoked synchronously from the LLM tool path, suppress the owner
  // confirmation message inside bookCoordination so the LLM's reply is the
  // sole narrator (prevents double-post). The async queue path keeps the
  // legacy behavior where bookCoordination narrates itself.
  await bookCoordination(jobId, finalSlot, profile, {
    suppressOwnerConfirm: synchronous,
  });

  const after = getCoordJob(jobId);
  if (!after) return { ok: false, reason: 'coord job disappeared after booking', subject: job.subject, slot: finalSlot };
  if (after.status === 'booked') {
    return { ok: true, status: 'booked', subject: after.subject, slot: finalSlot };
  }
  return {
    ok: false,
    status: after.status,
    subject: after.subject,
    slot: finalSlot,
    reason: after.status === 'waiting_owner'
      ? 'booking paused — calendar conflict, duration approval, or booking error; a detailed message was already posted to the owner'
      : `booking not completed — job is now ${after.status}`,
  };
}

// ── Actual booking ───────────────────────────────────────────────────────────

export async function bookCoordination(
  jobId: string,
  slot: string,
  profile: UserProfile,
  options: { suppressOwnerConfirm?: boolean } = {},
): Promise<void> {
  const { suppressOwnerConfirm = false } = options;
  const job = getCoordJob(jobId);
  if (!job) return;

  const slackConn = getConnection(profile.user.slack_user_id, 'slack');
  if (!slackConn) {
    logger.error('bookCoordination — no Slack connection registered; aborting', {
      jobId,
      ownerUserId: profile.user.slack_user_id,
    });
    return;
  }

  logger.info('Booking coordination meeting', { jobId, slot, subject: job.subject });

  const participants = JSON.parse(job.participants) as CoordParticipant[];
  const keyParticipants = participants.filter(p => !p.just_invite);
  const justInviteParticipants = participants.filter(p => p.just_invite);
  const slotDt = DateTime.fromISO(slot).setZone(profile.user.timezone);
  const endDt = DateTime.fromISO(slot).plus({ minutes: job.duration_min });

  // Determine final location based on the winning slot's day
  const ownerDomain = profile.user.email.split('@')[1];
  const isInternal = participants.every(p => !p.email || p.email.endsWith(`@${ownerDomain}`));
  const totalPeople = participants.length + 1;

  let notesObj: Record<string, unknown> = {};
  try { notesObj = JSON.parse(job.notes ?? '{}'); } catch (_) {}

  let isOnline: boolean;
  let location: string | undefined;

  if (notesObj.locationOverride) {
    location = notesObj.locationOverride as string;
    isOnline = true; // custom location always gets Teams
  } else {
    const slotsMetadata = (notesObj.slotsMetadata as Array<{ start: string; location: string; isOnline: boolean }>) ?? [];
    const slotMeta = slotsMetadata.find(sm => sm.start === slot);
    if (slotMeta) {
      location = slotMeta.location;
      isOnline = slotMeta.isOnline;
    } else {
      // v2.2.4 (bug 8b) — fallback path when slotsMetadata is missing.
      // Mirror the traveling-participant check upstream paths apply.
      let anyTraveling = false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getCurrentTravel } = require('../../../db') as typeof import('../../../db');
        for (const p of participants) {
          if (p.slack_id && getCurrentTravel(p.slack_id)) { anyTraveling = true; break; }
        }
      } catch (_) { /* fail open */ }
      const locInfo = determineSlotLocation(slot, profile, totalPeople, isInternal, undefined, anyTraveling);
      location = locInfo.location;
      isOnline = locInfo.isOnline;
    }
  }

  if (notesObj.isOnline !== undefined) {
    isOnline = notesObj.isOnline as boolean;
  }

  // ── Pre-booking validation: check the owner's calendar is still free ──
  const lastCheck = job.last_calendar_check ? new Date(job.last_calendar_check).getTime() : 0;
  const secondsSinceCheck = (Date.now() - lastCheck) / 1000;
  if (secondsSinceCheck < 60) {
    logger.info('Skipping pre-booking calendar check — last check was <60s ago', { jobId, secondsSinceCheck });
  } else try {
    const slotDate = slotDt.toFormat('yyyy-MM-dd');
    updateCoordJob(jobId, { last_calendar_check: new Date().toISOString() });
    const existingEvents = await getCalendarEvents(
      profile.user.email,
      slotDate,
      slotDate,
      profile.user.timezone,
    );
    const slotStartMs = DateTime.fromISO(slot).toMillis();
    const slotEndMs = endDt.toMillis();
    // v2.3.1 (B7 / #64) — floating blocks (lunch, coffee, etc.) are elastic
    // and were ALREADY accounted for when findAvailableSlots produced this
    // candidate slot. Re-flagging them as a "conflict" at booking time is
    // exactly what made Maelle "forget" her own suggestion and escalate to
    // owner approval. Filter them out here; they get re-placed elsewhere in
    // their window via rebalanceFloatingBlocksAfterMutation post-create.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fb = require('../../../utils/floatingBlocks') as typeof import('../../../utils/floatingBlocks');
    const blocks = fb.getFloatingBlocks(profile);
    const hasConflict = existingEvents.some(ev => {
      if (ev.isCancelled || ev.showAs === 'free') return false;
      // Floating blocks are elastic — not real conflicts.
      if (blocks.some(b => fb.isFloatingBlockEvent(ev, b))) return false;
      const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone }).toMillis();
      const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone }).toMillis();
      return evStart < slotEndMs && evEnd > slotStartMs;
    });
    if (hasConflict) {
      logger.warn('Slot has a calendar conflict — escalating to owner', { jobId, slot });
      const participantsParsed = JSON.parse(job.participants) as CoordParticipant[];
      await emitWaitingOwnerApproval({
        job,
        profile,
        kind: 'calendar_conflict',
        payload: {
          coord_job_id: job.id,
          subject: job.subject,
          original_slot: slot,
          slots: [{ iso: slot, label: slotDt.toFormat("EEEE, d MMMM 'at' HH:mm") }],
          participants_emails: participantsParsed.filter(p => !!p.email).map(p => p.email!),
          duration_min: job.duration_min,
          conflict_reason: 'owner now has a calendar conflict at the agreed slot',
        },
        askText: `Everyone agreed on ${slotDt.toFormat("EEEE, d MMMM 'at' HH:mm")} for "${job.subject}", but you now have a conflict at that time. Want me to book anyway or find a new slot?`,
        winningSlot: slot,
      });
      return;
    }
  } catch (err) {
    logger.warn('Pre-booking calendar check failed — proceeding anyway', { err: String(err), jobId });
  }

  // ── Duration approval gate ─────────────────────────────────────────────────
  if (notesObj.needsDurationApproval) {
    await emitWaitingOwnerApproval({
      job,
      profile,
      kind: 'duration_override',
      payload: {
        coord_job_id: job.id,
        subject: job.subject,
        duration_min: job.duration_min,
        slot,
        reason: 'non-standard duration requested by colleague',
      },
      askText: `Everyone agreed on ${slotDt.toFormat("EEEE, d MMMM 'at' HH:mm")} for "${job.subject}" (${job.duration_min} min). The ${job.duration_min}-minute duration was requested by a colleague and isn't one of your standard durations. Shall I book it as-is, or adjust to a standard length?`,
      winningSlot: slot,
    });
    return;
  }

  // ── Idempotency guard: already booked at this exact slot → no-op ─────────
  if (job.external_event_id && job.winning_slot === slot) {
    logger.info('bookCoordination — already booked, skipping re-book', {
      jobId, slot, externalEventId: job.external_event_id,
    });
    updateCoordJob(jobId, { status: 'booked' });
    return;
  }

  // ── Actually create / move the event in Graph ────────────────────────────
  // v2.1.1 — MOVE branch. When intent='move', we reshuffle the existing
  // event rather than creating a fresh one. Graph preserves attendees +
  // Teams link + history on PATCH (same as move_meeting). When intent is
  // 'schedule' (default, historical path), we createMeeting as before.
  let newEventId: string | undefined;
  try {
    const isMove = job.intent === 'move' && !!job.existing_event_id;
    if (isMove) {
      await updateMeeting({
        userEmail: profile.user.email,
        meetingId: job.existing_event_id!,
        start: slot,
        end: endDt.toISO()!,
        timezone: profile.user.timezone,
      });
      newEventId = job.existing_event_id!;
      logger.info('bookCoordination — moved existing event', {
        jobId, eventId: newEventId, slot,
      });
    } else {
      // v2.3.1 (B9 / #65) — cross-turn idempotency check. Mirror the dedup
      // logic ops.ts create_meeting:824-855 has. Without it, when a direct
      // create_meeting already booked this slot (e.g. Sonnet bypassing a
      // gate-stuck coord, see #65), bookCoordination would create a second
      // event next to the first one. Same subject + same start (±2 min) on
      // the owner's calendar → return the existing id, skip the create.
      try {
        const requestedSubject = job.subject.trim();
        const startDt = DateTime.fromISO(slot, { zone: profile.user.timezone });
        const probeDate = startDt.toFormat('yyyy-MM-dd');
        const startMs = startDt.toMillis();
        const existingEvents = await getCalendarEvents(profile.user.email, probeDate, probeDate, profile.user.timezone);
        const duplicate = existingEvents.find(ev => {
          if (ev.isCancelled) return false;
          const evSubject = (ev.subject ?? '').trim();
          if (evSubject.toLowerCase() !== requestedSubject.toLowerCase()) return false;
          const evStartMs = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone }).toMillis();
          return Math.abs(evStartMs - startMs) <= 2 * 60 * 1000;
        });
        if (duplicate) {
          logger.warn('bookCoordination idempotent short-circuit — same subject+start already on calendar', {
            jobId, subject: requestedSubject, start: slot, existingEventId: duplicate.id,
          });
          newEventId = duplicate.id;
        }
      } catch (err) {
        logger.warn('bookCoordination dedup pre-check failed — proceeding with create', {
          jobId, err: String(err).slice(0, 200),
        });
      }

      if (!newEventId) {
        newEventId = await createMeeting({
          userEmail: profile.user.email,
          timezone: profile.user.timezone,
          subject: job.subject,
          start: slot,
          end: endDt.toISO()!,
          attendees: participants.map(p => ({ name: p.name, email: p.email || '' })),
          body: job.topic ? `Topic: ${job.topic}` : undefined,
          isOnline,
          location: location || undefined,
          // v2.2.7 — match the direct create_meeting path's fallback. Without
          // this, coord-booked meetings landed uncategorized; the direct path
          // already defaults to 'Meeting' via skills/meetings/ops.ts.
          categories: ['Meeting'],
          // v2.3.1 (B23) — invite-body attribution.
          defaultBodyAuthor: `${profile.assistant.name}, ${profile.user.name.split(' ')[0]} Assistant`,
        });
      }
    }

    // v2.3.1 (B7 / #64) — post-create floating block rebalance. The conflict
    // check above filtered floating blocks out (so booking proceeds), but
    // the new event may now sit on top of e.g. lunch. Re-place the affected
    // block elsewhere in its window via the existing helper.
    if (newEventId && !isMove) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { rebalanceFloatingBlocksAfterMutation } = require('../../../utils/rebalanceFloatingBlocks') as
          typeof import('../../../utils/rebalanceFloatingBlocks');
        await rebalanceFloatingBlocksAfterMutation({
          profile,
          affectedSlotIso: slot,
          ownerSlackId: profile.user.slack_user_id,
        });
      } catch (err) {
        logger.warn('rebalance after coord booking threw — continuing', {
          jobId, err: String(err).slice(0, 200),
        });
      }
    }
  } catch (err) {
    logger.error('Calendar booking failed for coordination', { err: String(err), jobId });
    try {
      await emitWaitingOwnerApproval({
        job,
        profile,
        kind: 'freeform',
        payload: {
          coord_job_id: job.id,
          subject: job.subject,
          slot,
          question: 'retry_or_abandon',
          failure_reason: err instanceof Error ? err.message : String(err),
        },
        askText: `Everyone agreed on ${slotDt.toFormat("EEEE, d MMMM 'at' HH:mm")} for "${job.subject}", but I couldn't create the calendar event. Want me to try again?`,
        winningSlot: slot,
      });
    } catch (inner) {
      logger.error('emitWaitingOwnerApproval during booking-failure path also failed', { err: String(inner), jobId });
    }
    return;
  }

  updateCoordJob(jobId, { status: 'booked', winning_slot: slot, external_event_id: newEventId });
  cancelOrphanCoordJobs(job.owner_user_id, job.subject, jobId);

  // ── Notify requesters (colleagues who asked but aren't on the invite) ────
  try {
    const requesters = JSON.parse(job.requesters || '[]') as Array<{ slack_id: string; name?: string }>;
    const participantSlackIds = new Set(participants.map(p => p.slack_id).filter(Boolean));
    for (const r of requesters) {
      if (!r.slack_id || participantSlackIds.has(r.slack_id)) continue;
      const rDt = DateTime.fromISO(slot);
      const res = await slackConn.sendDirect(
        r.slack_id,
        `Following up — I set up "${job.subject}" for ${rDt.toFormat("EEEE, d MMMM 'at' HH:mm")}. All set.`,
      );
      if (!res.ok) {
        logger.warn('Could not notify requester of booking', { reason: res.reason, slackId: r.slack_id });
      }
    }
  } catch (err) {
    logger.warn('Requester notification pass failed — non-fatal', { err: String(err), jobId });
  }

  // ── Notify key participants ───────────────────────────────────────────────
  const inGroupConfirm = keyParticipants.filter(p => p.contacted_via === 'group' && p.group_channel && p.group_thread_ts);
  const privateDmConfirm = keyParticipants.filter(p => p.contacted_via !== 'group');

  const locationLine = location ? ` (${location})` : '';

  if (inGroupConfirm.length > 0) {
    const channel = inGroupConfirm[0].group_channel!;
    const threadTs = inGroupConfirm[0].group_thread_ts!;
    const pDt = DateTime.fromISO(slot).setZone(inGroupConfirm[0].tz);
    const res = await slackConn.postToChannel(
      channel,
      `All confirmed! "${job.subject}" is booked for ${pDt.toFormat("EEEE, d MMMM 'at' HH:mm")}${locationLine}. Calendar invites are on their way.`,
      { threadTs },
    );
    if (!res.ok) {
      logger.warn('Could not post booking confirmation in group thread', { reason: res.reason, detail: res.detail });
    }
  }

  for (const p of privateDmConfirm) {
    if (!p.slack_id) continue;
    // v1.8.6 — post the booking confirmation back in the ORIGINAL coord DM
    // thread when we have it recorded (dm_channel + dm_thread_ts set in
    // sendCoordDM). Falls back to a fresh DM for older coord rows that
    // predate thread-tracking.
    const pDt = DateTime.fromISO(slot).setZone(p.tz);
    const msgText = `All confirmed! "${job.subject}" is booked for ${pDt.toFormat("EEEE, d MMMM 'at' HH:mm")}${locationLine}. See you there.`;
    try {
      if (p.dm_channel) {
        await slackConn.postToChannel(p.dm_channel, msgText, { threadTs: p.dm_thread_ts });
      } else {
        await slackConn.sendDirect(p.slack_id, msgText);
      }
    } catch (_) {}
  }

  // Mark linked task as done
  getDb().prepare(`UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE skill_ref = ?`).run(jobId);

  const openTasks = getOpenTasksForOwner(profile.user.slack_user_id);
  const closing = openTasks.length === 0 ? " That's everything — all done for now." : '';

  const keyNames = keyParticipants.map(p => p.name).join(' and ');
  const extraSuffix = justInviteParticipants.length > 0
    ? ` (${justInviteParticipants.map(p => p.name).join(', ')} also invited)`
    : '';

  // v2.1.5 — skip the standalone "Done —" owner post when the in-group
  // "All confirmed!" above already landed in the owner's channel + thread.
  // Happens for MPIM coords (group_channel === owner_channel) and any
  // channel-initiated coord where the owner is in the group. Prevents the
  // duplicate "one message in thread, one right after" noise; the earlier
  // group post already told the owner what happened.
  const ownerAlreadyNotifiedViaGroup = inGroupConfirm.some(
    p => p.group_channel === job.owner_channel
      && (p.group_thread_ts ?? undefined) === (job.owner_thread_ts ?? undefined),
  );

  if (!suppressOwnerConfirm && !ownerAlreadyNotifiedViaGroup) {
    await slackConn.postToChannel(
      job.owner_channel,
      `Done — "${job.subject}" booked with ${keyNames}${extraSuffix} on ${slotDt.toFormat("EEEE, d MMMM 'at' HH:mm")}${locationLine}.${closing}`,
      { threadTs: job.owner_thread_ts ?? undefined },
    );
  }

  await shadowNotify(profile, {
    channel: job.owner_channel,
    threadTs: job.owner_thread_ts ?? undefined,
    action: 'Meeting booked',
    detail: `"${job.subject}" with ${keyNames} on ${slotDt.toFormat("EEE d MMM HH:mm")}${locationLine}`,
    conversationKey: `coord:${job.id}`,
    conversationHeader: `Coord: "${job.subject}"`,
  });

  logEvent({
    ownerUserId: profile.user.slack_user_id,
    type: 'coordination',
    title: `"${job.subject}" booked with ${participants.map(p => p.name).join(', ')}`,
    detail: slotDt.toFormat("EEEE, d MMMM 'at' HH:mm") + locationLine,
  });
}

// ── Register with the core approval resolver ─────────────────────────────────
// The resolver (core/approvals/resolver.ts) calls this handler when the owner
// approves a slot_pick approval. Registered at module-load time so it's
// available as soon as MeetingsSkill is required.
registerCoordBookingHandler(args =>
  forceBookCoordinationByOwner(args.jobId, args.chosenSlotIso, args.profile, {
    synchronous: args.synchronous,
  }),
);
