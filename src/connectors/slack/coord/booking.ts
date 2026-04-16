/**
 * Coord booking (v1.6.2 split from coord.ts).
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
 * Why its own file: booking was ~400 lines of end-of-state-machine logic that
 * was inflating coord.ts. The agent-vs-Slack seam (planned next) will split
 * this further — the `createMeeting` / `getCalendarEvents` calls are pure
 * meetings-domain work, while the participant/owner DM sends are Slack-
 * specific transport. For now we keep them together so the booking flow is
 * readable in one place.
 */

import type { App } from '@slack/bolt';
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
import { createMeeting, getCalendarEvents } from '../../graph/calendar';
import { shadowNotify } from '../../../utils/shadowNotify';
import { determineSlotLocation } from './utils';
import { emitWaitingOwnerApproval } from './approval';
import logger from '../../../utils/logger';

// ── Force-book: owner decided, skip waiting ─────────────────────────────────

/**
 * Owner-initiated force-book. Bypasses the "wait for every participant" logic
 * when the owner has explicitly picked a slot. Marks all unresponded key
 * participants as accepted at that slot, sets winning_slot, and invokes the
 * real booking path so the calendar invite actually gets created.
 */
export async function forceBookCoordinationByOwner(
  app: App,
  jobId: string,
  chosenSlotIso: string,
  profile: UserProfile,
  botToken: string,
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
  await bookCoordination(app, jobId, finalSlot, profile, botToken, {
    suppressOwnerConfirm: synchronous,
  });

  // Re-read job to see what actually happened. bookCoordination may have
  // left us in 'booked' (success) or 'waiting_owner' (conflict, duration
  // approval needed, or calendar error — each posts its own explanatory
  // message that the LLM should NOT second-guess).
  const after = getCoordJob(jobId);
  if (!after) return { ok: false, reason: 'coord job disappeared after booking', subject: job.subject, slot: finalSlot };
  if (after.status === 'booked') {
    // Approval sync lives inside updateCoordJob (v1.6.2) — no per-call-site
    // mirroring needed.
    return { ok: true, status: 'booked', subject: after.subject, slot: finalSlot };
  }
  // Not booked — bookCoordination already told the owner why. Surface the
  // status so the LLM can stay quiet or echo a short acknowledgment without
  // inventing an outcome.
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
  app: App,
  jobId: string,
  slot: string,
  profile: UserProfile,
  botToken: string,
  options: { suppressOwnerConfirm?: boolean } = {},
): Promise<void> {
  const { suppressOwnerConfirm = false } = options;
  const job = getCoordJob(jobId);
  if (!job) return;

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

  // Check if there's a location override from notes (participant requested a change)
  let notesObj: Record<string, unknown> = {};
  try { notesObj = JSON.parse(job.notes ?? '{}'); } catch (_) {}

  let isOnline: boolean;
  let location: string | undefined;

  if (notesObj.locationOverride) {
    location = notesObj.locationOverride as string;
    isOnline = true; // custom location always gets Teams
  } else {
    // Check slot-specific metadata first
    const slotsMetadata = (notesObj.slotsMetadata as Array<{ start: string; location: string; isOnline: boolean }>) ?? [];
    const slotMeta = slotsMetadata.find(sm => sm.start === slot);
    if (slotMeta) {
      location = slotMeta.location;
      isOnline = slotMeta.isOnline;
    } else {
      // Fallback: auto-determine from day
      const locInfo = determineSlotLocation(slot, profile, totalPeople, isInternal);
      location = locInfo.location;
      isOnline = locInfo.isOnline;
    }
  }

  // Override from participant preference if set
  if (notesObj.isOnline !== undefined) {
    isOnline = notesObj.isOnline as boolean;
  }

  // ── Pre-booking validation: check the owner's calendar is still free ──
  // Skip if we checked less than 60 seconds ago (calendar freshness)
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
    const hasConflict = existingEvents.some(ev => {
      if (ev.isCancelled || ev.showAs === 'free') return false;
      const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone }).toMillis();
      const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone }).toMillis();
      return evStart < slotEndMs && evEnd > slotStartMs;
    });
    if (hasConflict) {
      logger.warn('Slot has a calendar conflict — escalating to owner', { jobId, slot });
      const participantsParsed = JSON.parse(job.participants) as CoordParticipant[];
      await emitWaitingOwnerApproval(app, {
        job,
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
        botToken,
        winningSlot: slot,
      });
      return;
    }
  } catch (err) {
    logger.warn('Pre-booking calendar check failed — proceeding anyway', { err: String(err), jobId });
  }

  // ── Duration approval gate ─────────────────────────────────────────────────
  // If a colleague requested a non-standard duration, ask the owner before booking
  if (notesObj.needsDurationApproval) {
    await emitWaitingOwnerApproval(app, {
      job,
      kind: 'duration_override',
      payload: {
        coord_job_id: job.id,
        subject: job.subject,
        duration_min: job.duration_min,
        slot,
        reason: 'non-standard duration requested by colleague',
      },
      askText: `Everyone agreed on ${slotDt.toFormat("EEEE, d MMMM 'at' HH:mm")} for "${job.subject}" (${job.duration_min} min). The ${job.duration_min}-minute duration was requested by a colleague and isn't one of your standard durations. Shall I book it as-is, or adjust to a standard length?`,
      botToken,
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

  // ── Actually create the event in Graph ─────────────────────────────────────
  let newEventId: string;
  try {
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
    });
  } catch (err) {
    logger.error('Calendar booking failed for coordination', { err: String(err), jobId });
    try {
      await emitWaitingOwnerApproval(app, {
        job,
        kind: 'freeform',
        payload: {
          coord_job_id: job.id,
          subject: job.subject,
          slot,
          question: 'retry_or_abandon',
          failure_reason: err instanceof Error ? err.message : String(err),
        },
        askText: `Everyone agreed on ${slotDt.toFormat("EEEE, d MMMM 'at' HH:mm")} for "${job.subject}", but I couldn't create the calendar event. Want me to try again?`,
        botToken,
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
      try {
        const dm = await app.client.conversations.open({ token: botToken, users: r.slack_id });
        const ch = (dm.channel as any)?.id;
        const rDt = DateTime.fromISO(slot);
        await app.client.chat.postMessage({
          token: botToken,
          channel: ch,
          text: `Following up — I set up "${job.subject}" for ${rDt.toFormat("EEEE, d MMMM 'at' HH:mm")}. All set.`,
        });
      } catch (err) {
        logger.warn('Could not notify requester of booking', { err: String(err), slackId: r.slack_id });
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
    try {
      await app.client.chat.postMessage({
        token: botToken,
        channel,
        thread_ts: threadTs,
        text: `All confirmed! "${job.subject}" is booked for ${pDt.toFormat("EEEE, d MMMM 'at' HH:mm")}${locationLine}. Calendar invites are on their way.`,
      });
    } catch (err) {
      logger.warn('Could not post booking confirmation in group thread', { err: String(err) });
    }
  }

  for (const p of privateDmConfirm) {
    if (!p.slack_id) continue;
    try {
      const dmResult = await app.client.conversations.open({ token: botToken, users: p.slack_id });
      const dmChannel = (dmResult.channel as any)?.id;
      const pDt = DateTime.fromISO(slot).setZone(p.tz);
      await app.client.chat.postMessage({
        token: botToken,
        channel: dmChannel,
        text: `All confirmed! "${job.subject}" is booked for ${pDt.toFormat("EEEE, d MMMM 'at' HH:mm")}${locationLine}. See you there.`,
      });
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

  if (!suppressOwnerConfirm) {
    await app.client.chat.postMessage({
      token: botToken,
      channel: job.owner_channel,
      thread_ts: job.owner_thread_ts ?? undefined,
      text: `Done — "${job.subject}" booked with ${keyNames}${extraSuffix} on ${slotDt.toFormat("EEEE, d MMMM 'at' HH:mm")}${locationLine}.${closing}`,
    });
  }

  await shadowNotify(app, profile, {
    channel: job.owner_channel,
    threadTs: job.owner_thread_ts ?? undefined,
    action: 'Meeting booked',
    detail: `"${job.subject}" with ${keyNames} on ${slotDt.toFormat("EEE d MMM HH:mm")}${locationLine}`,
  });

  logEvent({
    ownerUserId: profile.user.slack_user_id,
    type: 'coordination',
    title: `"${job.subject}" booked with ${participants.map(p => p.name).join(', ')}`,
    detail: slotDt.toFormat("EEEE, d MMMM 'at' HH:mm") + locationLine,
  });
}
