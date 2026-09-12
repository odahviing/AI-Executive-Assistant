/** Live overlap revalidation and shared autonomous move execution. */
import { DateTime } from 'luxon';
import {
  getCalendarEvents,
  type CalendarEvent,
  updateMeeting,
  findAvailableSlots,
} from '../../connectors/graph/calendar';
import { updateCalendarIssueStatus, type CalendarIssueRow } from '../../db';
import { closeMeetingArtifacts } from '../../utils/closeMeetingArtifacts';
import logger from '../../utils/logger';
import { displaySubject } from '../../utils/displaySubject';
import type { UserProfile } from '../../config/userProfile';
import { densityConfigFromProfile, scoreSlotDensity, alignDownQuarter } from '../../utils/calendarDensity';
import { densityCommitments } from '../../utils/floatingBlocks';
import { parseGraphDt } from './classify';
import type { HealthIssue } from './types';

/**
 * Re-validate tracked OVERLAP issues against the CURRENT calendar before they're
 * surfaced. A stored row goes stale when the owner moves an event DIRECTLY in
 * Outlook (no closeMeetingArtifacts cascade fires → resolveCalendarIssuesForMeeting
 * never runs) AND its date sits outside the health window (so markStaleResolved
 * can't reach it). The row then surfaces every run until manually dismissed — the
 * June-28 "Yael weekly overlaps the El Al flight" case the owner moved two days
 * earlier in Outlook. Here we re-fetch the issue's day and recompute the overlap;
 * if it's gone we resolve the row and drop it from the surfaced set.
 *
 * FAIL-SAFE: on any fetch error or ambiguity we KEEP the row surfaced — never
 * silently hide a real conflict. Only the `overlap` class is re-checked (it's the
 * one deterministically verifiable from two event times); other classes keep
 * their existing re-detection + markStaleResolved path untouched.
 */
export async function revalidateActiveOverlapIssues(
  issues: CalendarIssueRow[],
  userEmail: string,
  timezone: string,
): Promise<CalendarIssueRow[]> {
  const overlapDates = new Set(
    issues.filter(i => i.issue_class === 'overlap' && i.peer_event_id).map(i => i.event_date),
  );
  if (overlapDates.size === 0) return issues;

  const eventsByDate = new Map<string, Awaited<ReturnType<typeof getCalendarEvents>>>();
  for (const date of overlapDates) {
    try {
      eventsByDate.set(date, await getCalendarEvents(userEmail, date, date, timezone, 'live'));
    } catch (err) {
      logger.warn('revalidateOverlap — day fetch failed, keeping its issues surfaced', {
        date, err: String(err).slice(0, 120),
      });
    }
  }

  const survivors: CalendarIssueRow[] = [];
  for (const row of issues) {
    if (row.issue_class !== 'overlap' || !row.peer_event_id) { survivors.push(row); continue; }
    const dayEvents = eventsByDate.get(row.event_date);
    if (!dayEvents) { survivors.push(row); continue; }          // fetch failed → fail-safe keep
    const a = dayEvents.find(e => e.id === row.event_id && !e.isCancelled);
    const b = dayEvents.find(e => e.id === row.peer_event_id && !e.isCancelled);
    let stillOverlaps: boolean;
    if (!a || !b) {
      stillOverlaps = false;   // one moved off this day / was deleted → overlap gone
    } else {
      const aS = parseGraphDt(a.start.dateTime, a.start.timeZone ?? '', timezone).toMillis();
      const aE = parseGraphDt(a.end.dateTime, a.end.timeZone ?? '', timezone).toMillis();
      const bS = parseGraphDt(b.start.dateTime, b.start.timeZone ?? '', timezone).toMillis();
      const bE = parseGraphDt(b.end.dateTime, b.end.timeZone ?? '', timezone).toMillis();
      if (![aS, aE, bS, bE].every(Number.isFinite) || aE <= aS || bE <= bS) {
        survivors.push(row); // malformed time is unknown, never proof of resolution
        continue;
      }
      stillOverlaps = aS < bE && aE > bS;
    }
    if (stillOverlaps) {
      survivors.push(row);
    } else {
      updateCalendarIssueStatus(row.id, 'resolved', '[re-validated: overlap no longer present on the calendar]');
      logger.info('revalidateOverlap — resolved stale overlap issue before surfacing', {
        id: row.id, event_date: row.event_date,
      });
    }
  }
  return survivors;
}

// #133 — shared autonomous internal-meeting move. Extracted from the
// double_booking auto-fix so EVERY active-mode auto-move (clash-clearing AND
// efficient-calendar defrag) runs ONE path: record the revert handle → PATCH
// and verify → record success → rebalance/notify → shadow-notify the owner.
// Caller supplies the already-chosen, free + rule-valid
// target (newStartIso) and the human phrasing; verified writes are recorded
// before ancillary cleanup/notifications, whose failures remain in fix_detail.
export async function executeInternalAutoMove(params: {
  movable: CalendarEvent;
  origStart: DateTime;
  origEnd: DateTime;
  durationMin: number;
  newStartIso: string;
  participantsRaw: NonNullable<CalendarEvent['attendees']>;
  conflictReason: string;
  moveVerb: string;               // "to clear the clash" / "to pack it back-to-back after your prior meeting"
  keptEventId?: string;
  issue: HealthIssue;
  userEmail: string;
  ownerUserId: string;
  timezone: string;
  profile: UserProfile;
  context: { channelId: string; threadTs?: string };
  internalActions: Array<{ tool: string; detail: string }>;
}): Promise<void> {
  const { movable, origStart: mStart, origEnd: mEnd, durationMin, participantsRaw,
    conflictReason, moveVerb, keptEventId, issue, userEmail, ownerUserId, timezone,
    profile, context, internalActions } = params;
  // gh#180 (private-mask) — three audiences read a subject derived HERE: the
  // owner (fix_detail / fix_error / shadowNotify — check_calendar_health's
  // summary is an owner-only surface), the colleague notified of the move
  // NOW (notifyColleagueOfMove's DM, M10-gated — its OWN stored
  // ctx.meeting_subject is what a later revert's correction actually quotes,
  // via closeMeetingArtifacts's relayVoidedNotices), and the owner again
  // LATER if he reverts (handleRevertAction, ops/handlers/calendarReads.ts,
  // gh#52 52-U4b). displaySubject's default viewer is 'other'
  // (mask) — right for a colleague, wrong for the owner text, which was
  // showing him "[Private]" for his own meeting. Both views are computed;
  // `colleague_subject` below rides along in this request row too, as the
  // revert path's own last-resort fallback if the live calendar probe ever
  // fails at revert time.
  const subj = displaySubject(movable, profile, 'owner') || 'Meeting';
  const colleagueSubj = displaySubject(movable, profile) || 'Meeting';
  const newStartIso = params.newStartIso;
  const newEndIso = DateTime.fromISO(newStartIso).plus({ minutes: durationMin }).toUTC().toISO()!;

  // Owner rule — NEVER auto-move a SOLO event (no non-owner attendee). A
  // placeholder / personal block with nobody else on it is the owner's own time:
  // there's no one to coordinate with, and relocating it is exactly the "Tax
  // placeholder moved for no reason" mistake. This is the chokepoint for EVERY
  // auto-move (double_booking, defrag, and anything future) — surface it, don't
  // move it. Floating blocks (lunch/gym) never reach here (they slide via
  // rebalanceFloatingBlocks, not this path), so this only stops real solo events.
  {
    const ownerEmailLc = profile.user.email.toLowerCase();
    const roomEmailLc = (profile.meetings.room_email ?? '').toLowerCase();
    const hasRealAttendee = participantsRaw.some(a => {
      const e = (a.emailAddress?.address ?? '').toLowerCase();
      return !!e && e !== ownerEmailLc && e !== roomEmailLc;
    });
    if (!hasRealAttendee) {
      logger.info('auto-move skipped — solo event (no non-owner attendees); left for the owner', {
        subject: subj, eventId: movable.id, issueType: issue.type,
      });
      issue.fix_failed = true;
      issue.fix_error = `"${subj}" has no other attendees — it's your own block, so I left it for you to move.`;
      return;
    }
  }

  // Re-read memory at the mutation chokepoint. The detector's snapshot predates
  // earlier moves in this sweep; pending writes must not be repeated on retry.
  const { getRecentlyAutoMovedEventIds, getRequestsByExternalEventId } = require('../../db/requests') as typeof import('../../db/requests');
  const { getSuppressedEventIds } = require('../../db') as typeof import('../../db');
  if (getSuppressedEventIds(ownerUserId).has(movable.id)
      || getRecentlyAutoMovedEventIds(ownerUserId).has(movable.id)
      || getRequestsByExternalEventId(ownerUserId, movable.id).some(r => r.subkind === 'auto_move')) {
    logger.info('auto-move skipped — event already settled or a move is pending', { eventId: movable.id });
    return;
  }

  // Record BEFORE executing so every move has durable memory and a revert
  // handle. Existing expiry owns pending/unknown completion; notification is
  // separate from whether the calendar mutation was confirmed.
  let autoMoveReq: { id: string } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequest } = require('../../db/requests') as typeof import('../../db/requests');
    autoMoveReq = createRequest({
      ownerUserId, initiatedBy: ownerUserId, initiatedByRole: 'system',
      kind: 'follow_up', subkind: 'auto_move',
      subject: `Auto-moved "${subj}" ${moveVerb}`,
      description: issue.description, state: 'in_flight',
      ownerDmChannel: context.channelId,
      outcomeExternalEventId: movable.id,
      outcomeJson: {
        original_start: mStart.toISO(), original_end: mEnd.toISO(),
        new_start: newStartIso, new_end: newEndIso, subject: subj,
        // gh#180 (bounce 2) — colleague_subject is the M10-masked view, stored
        // ALONGSIDE the owner's real `subject`. gh#52 (52-U4b): the revert
        // dispatch (calendarReads.ts's handleRevertAction) reads this ONLY as
        // a last-resort fallback if its own live calendar probe fails — its
        // primary colleague-correction path is closeMeetingArtifacts's
        // relayVoidedNotices, which reads the ALREADY-masked subject back off
        // notifyColleagueOfMove's own stored outreach context instead. Kept
        // here so a revert is never left with only the owner-view `subject`
        // to work with if that probe comes back empty.
        colleague_subject: colleagueSubj, kept_event_id: keptEventId,
      },
      idempotencyKey: `auto_move:${movable.id}:${Date.now()}`,
      nextCheckAt: DateTime.now().plus({ hours: 12 }).toUTC().toISO()!,
      nextCheckHandler: 'expiry',
    });
  } catch (reqErr) {
    logger.warn('auto-move request-record create failed — no calendar write', { err: String(reqErr).slice(0, 160) });
    issue.fix_failed = true;
    issue.fix_error = `I couldn't record the move of "${subj}", so I left it unchanged.`;
    return;
  }

  issue.fix_unconfirmed = true;
  try {
    await updateMeeting({ userEmail, timezone, meetingId: movable.id, start: newStartIso, end: newEndIso });
  } catch (err) {
    // A transport failure can arrive after PATCH applied. The same safe,
    // exact-id readback below decides the outcome; never blindly repeat PATCH.
    logger.warn('auto-move write threw — checking the calendar outcome', { eventId: movable.id, err: String(err).slice(0, 160) });
  }

  // Verify the exact requested start AND end before claiming success. Reuse
  // the strict readback comparator: the legacy start-only verifier treats an
  // unreadable calendar as success, which cannot authorize notifications.
  {
    const { verifyApprovedCalendarAction } = await import('../../connectors/graph/calendar');
    const verify = await verifyApprovedCalendarAction({
      userEmail, profile, tool: 'move_meeting',
      args: { meeting_id: movable.id, new_start: newStartIso, new_end: newEndIso },
    });
    if (verify.status !== 'desired_state_observed') {
      logger.warn('auto-move completion unconfirmed by calendar readback', {
        eventId: movable.id, issueType: issue.type, reason: verify.reason,
        status: verify.status,
      });
      issue.fix_failed = true;
      issue.fix_error = verify.status === 'unavailable'
        ? `I tried to move "${subj}" but couldn't verify the calendar afterward — left it for you to check.`
        : `I tried to move "${subj}" but the calendar afterward did not match the requested start and end — left it for you to check.`;
      // An inconclusive readback cannot prove no write occurred. Keep the
      // existing in-flight handle/timer so the next sweep cannot repeat it.
      return;
    }
  }

  const newLocal = DateTime.fromISO(newStartIso, { zone: timezone }).toFormat('EEE d MMM HH:mm');
  issue.fixed = true;
  issue.fix_unconfirmed = false;
  issue.fix_failed = false;
  issue.fix_error = undefined;
  issue.fix_detail = `Moved "${subj}" to ${newLocal} ${moveVerb}.`;
  internalActions.push({ tool: 'move_meeting', detail: `Auto-moved "${subj}" to ${newLocal} (${issue.type})` });
  const followUpFailures: string[] = [];
  try {
    const { closeRequest } = require('../../core/requests/closeRequest') as typeof import('../../core/requests/closeRequest');
    const closed = closeRequest({
      id: autoMoveReq.id, state: 'resolved', closureReason: 'auto_move_executed', closedBy: 'system',
      outcomeExternalEventId: movable.id,
      outcomeJson: {
        original_start: mStart.toISO(), original_end: mEnd.toISO(),
        new_start: newStartIso, new_end: newEndIso, subject: subj,
        colleague_subject: colleagueSubj, kept_event_id: keptEventId,
      },
    });
    if (!closed.ok) throw new Error('Move record could not be closed.');
  } catch (err) {
    followUpFailures.push('I could not finish updating the move record.');
    logger.warn('auto-move request-record resolve failed — move already done', { err: String(err).slice(0, 160) });
  }

  // elan-hold-survives-the-move-that-resolved-it (2026-09-06) — every OTHER
  // meeting-mutation path calls closeMeetingArtifacts (moveMeeting.ts:1942);
  // this autonomous path never did, so a colleague already DM'd a (now-stale)
  // time for this meeting via an open outreach request never got corrected
  // and their request never closed. Mirrors moveMeeting.ts's call verbatim:
  // same reason/newStartIso/newEndIso shape, placed here past verifyEventMoved
  // for the same reason moveMeeting.ts places it there — only a write we've
  // confirmed landed may be relayed as fact. `correctedColleagueSlackIds`
  // (registrar-added return) lets the notify loop below skip anyone this
  // cascade already told, so Elan doesn't get a correction AND a fresh
  // "I moved it" DM for the same move.
  let correctedColleagueSlackIds = new Set<string>();
  let cascadeComplete = false;
  try {
  const artifactsResult = await closeMeetingArtifacts({
    ownerUserId,
    meetingId: movable.id,
    reason: 'moved',
    subject: subj,
    bookingThreadTs: context.threadTs,
    newStartIso,
    newEndIso,
    // This caller owns auto_move_executed closure, including if its closure
    // write failed above. The cascade must not close that handle differently.
    ...(autoMoveReq ? { fulfillingRequestId: autoMoveReq.id } : {}),
  });
  correctedColleagueSlackIds = new Set(artifactsResult.correctedColleagueSlackIds);
  cascadeComplete = true;
  } catch (err) {
    // The cascade can have partially notified people before failing. Do not
    // send fresh notices with an unknown correction set and risk duplicates.
    followUpFailures.push('I could not confirm that the related follow-ups and attendee notifications finished.');
    logger.warn('auto-move artifact cleanup failed — move already confirmed', { err: String(err).slice(0, 160) });
  }

  try {
    const { rebalanceFloatingBlocksAfterMutation } = await import('../../utils/rebalanceFloatingBlocks');
    await rebalanceFloatingBlocksAfterMutation({ profile, affectedSlotIso: newStartIso, ownerSlackId: ownerUserId });
  } catch (rebErr) {
    logger.warn('rebalance after auto-move threw — continuing', { err: String(rebErr).slice(0, 160) });
  }

  // Notify each non-owner internal attendee (resolve slack_id from email). The
  // notice is a meeting_reschedule(already_moved) so a "doesn't work" reply
  // routes back to the owner with a revert option. Skip anyone
  // closeMeetingArtifacts already corrected above — they've already been told
  // the real new time via the relay; a second "I moved it" DM would be a
  // duplicate notice for the same move.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { notifyColleagueOfMove } = require('../meetingReschedule') as typeof import('../meetingReschedule');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getPersonByEmail } = require('../../db') as typeof import('../../db');
  const notified: string[] = [];
  for (const a of participantsRaw) {
    if (!cascadeComplete) break;
    const email = a.emailAddress.address;
    if (!email || email.toLowerCase() === profile.user.email.toLowerCase()) continue;
    try {
    const row = getPersonByEmail(email.trim().toLowerCase());
    if (!row?.slack_id) continue;
    if (correctedColleagueSlackIds.has(row.slack_id)) continue;
    const delivered = await notifyColleagueOfMove({
      profile, ownerChannel: context.channelId, ownerThreadTs: context.threadTs,
      colleagueSlackId: row.slack_id,
      colleagueName: a.emailAddress.name || row.name || email,
      colleagueTz: row.timezone, meetingId: movable.id, meetingSubject: colleagueSubj,
      originalStartIso: mStart.toISO()!, originalEndIso: mEnd.toISO()!,
      newStartIso, newEndIso, conflictReason,
    });
    if (!delivered) throw new Error('Attendee notification was not confirmed.');
    notified.push((a.emailAddress.name || row.name || email).split(' ')[0]);
    } catch (err) {
      followUpFailures.push(`I couldn't confirm the notification to ${a.emailAddress.name || email}.`);
      logger.warn('auto-move attendee notice failed — move already confirmed', { eventId: movable.id, err: String(err).slice(0, 160) });
    }
  }

  issue.fix_detail = notified.length > 0
    ? `Moved "${subj}" (was ${mStart.toFormat('HH:mm')}–${mEnd.toFormat('HH:mm')}) to ${newLocal} ${moveVerb}, and let ${notified.join(' and ')} know — I'll loop you in if they push back.`
    : `Moved "${subj}" to ${newLocal} ${moveVerb}.`;
  if (followUpFailures.length) issue.fix_detail += ` ${followUpFailures.join(' ')}`;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shadowNotify } = require('../../utils/shadowNotify') as typeof import('../../utils/shadowNotify');
    await shadowNotify(profile, {
      channel: context.channelId,
      icon: '🔧',
      action: `Active-mode autofix — ${issue.type}`,
      detail: `${issue.fix_detail} Say "revert" if you'd rather I hadn't.`,
      // Key the owner notice to the durable move handle for later correction.
      conversationKey: autoMoveReq?.id,
    });
  } catch (err) {
    logger.warn('shadowNotify on active-mode move threw — continuing', { err: String(err).slice(0, 200) });
  }
}

// #133c — shared "pull an internal meeting back to abut an anchor" primitive.
// The anchor is the END of the earlier commitment the meeting should sit right
// after — a MEETING (the meeting-to-meeting defrag) or a FLOATING BLOCK (lunch,
// the #133c fallback). Validates the target the SAME way for both: a same-day,
// grid-aligned, attendee-free slot that doesn't itself open a new dead gap; then
// routes through executeInternalAutoMove (the one move+notify path). Sets
// issue.fix_failed with a reason when there's no clean slot. The CALLER owns the
// protection / external / recently-moved gates before calling.
export async function pullInternalMeetingToAbut(params: {
  movable: CalendarEvent;
  keptEndDt: DateTime;                 // abut target — the anchor's end (grid-aligned by the finder)
  keptEventId: string;
  moveVerb: string;
  conflictReason: string;
  dayEventsForBusy: CalendarEvent[];   // the day's events, for the net-improvement density check
  issue: HealthIssue;                  // real (defrag) or synthetic (fallback); receives fixed / fix_failed
  userEmail: string;
  ownerUserId: string;
  timezone: string;
  profile: UserProfile;
  context: { channelId: string; threadTs?: string };
  internalActions: Array<{ tool: string; detail: string }>;
}): Promise<void> {
  const { movable, keptEndDt, keptEventId, moveVerb, conflictReason,
    dayEventsForBusy, issue, userEmail, ownerUserId, timezone, profile, context, internalActions } = params;
  const mStart = parseGraphDt(movable.start.dateTime, movable.start.timeZone, timezone);
  const mEnd = parseGraphDt(movable.end.dateTime, movable.end.timeZone, timezone);
  const durationMin = Math.round(mEnd.diff(mStart, 'minutes').minutes);
  const participantsRaw = (movable.attendees ?? []).filter(a => a.status?.response !== 'declined');
  const attendeeEmails = participantsRaw.map(a => a.emailAddress.address).filter(Boolean);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { attendeeCheckParams } = require('../../utils/attendeeAvailability') as typeof import('../../utils/attendeeAvailability');
  const slots = await findAvailableSlots({
    userEmail, timezone, durationMinutes: durationMin,
    // Only pull the meeting to where the attendees are actually free AND inside
    // their (cross-TZ) work hours — never before their day starts. #M3 — pass
    // the owner's zone as the no-stored-TZ fallback (same convention as
    // findAvailableSlots.ts:900 / createMeeting.ts's Guard B / moveMeeting.ts):
    // without it a no-TZ attendee was silently skipped from this hours check
    // entirely, so an autonomous pull could land a meeting on their night.
    ...attendeeCheckParams(attendeeEmails, userEmail, timezone),
    searchFrom: keptEndDt.toUTC().toISO()!,
    searchTo: mEnd.toUTC().toISO()!,
    minBufferHours: 0,              // owner-authority active move; no colleague lead-time
    excludeEventIds: [movable.id],  // its own current slot isn't a conflict
    allowMovingEventOverlap: true,  // a back-to-back pull overlaps the meeting's own slot — that's the point, not a forbidden "offer it back"
    autoExpand: false,              // stays in the SAME-DAY gap — never widen across days
    gridAlignStart: true,           // off-grid anchor end → aligned back-to-back start
    profile,
  });
  // M2 — clean-strict beats WE-optional beats "whatever's first": this pick used
  // to read ONLY disturbs_floating_block (does taking this slot itself disturb a
  // floating block?), with no read of `over_optional` (does the slot SIT ON a
  // Working-Elsewhere/optional event?) at all — so among chronologically-ordered
  // candidates, an earlier WE-optional slot beat a later genuinely-clean one
  // (the Elan triweekly auto-moved onto a 15:45 WE slot while a clean slot
  // existed later the same day). Mirrors the same clean › WE-optional ladder
  // `pickSpreadSlots` already runs for offered slots (calendarReads.ts) — this
  // is the auto-move's own pick catching up to it, not a new preference.
  const top = slots.find(s => !s.disturbs_floating_block && !s.over_optional)
    ?? slots.find(s => !s.disturbs_floating_block)
    ?? slots[0];
  // Net-improvement guard: the chosen slot must NOT itself open a dead gap —
  // never just shove the sliver onto the next meeting.
  let cleanTarget = false;
  if (top) {
    const densCfg = densityConfigFromProfile(profile.meetings);
    // floatingBlocksAsNeighbours: true — this guard is specifically about
    // pulling a meeting back to abut whatever's already there, including a
    // floating block; the block must score as a real neighbour or the
    // abut/dead-gap math has nothing to compare against.
    const dayBusy = densityCommitments(dayEventsForBusy, profile, {
      floatingBlocksAsNeighbours: true,
      excludeEventIds: [movable.id],
    });
    const tStartDt = DateTime.fromISO(top.start).setZone(timezone);
    const sameDay = tStartDt.hasSame(mStart, 'day');
    const tScore = scoreSlotDensity(tStartDt.toMillis(), tStartDt.toMillis() + durationMin * 60000, dayBusy, densCfg);
    cleanTarget = sameDay && !tScore.createsDeadGap;
  }
  if (!top || !cleanTarget) {
    issue.fix_failed = true;
    issue.fix_error = 'No back-to-back slot that cleanly closes the gap (attendee busy, or it would just shift the gap) — left for you.';
    return;
  }
  await executeInternalAutoMove({
    movable, origStart: mStart, origEnd: mEnd, durationMin,
    newStartIso: top.start, participantsRaw, conflictReason, moveVerb,
    keptEventId, issue, userEmail, ownerUserId, timezone, profile, context, internalActions,
  });
}

// #133d — mirror of pullInternalMeetingToAbut for the BEFORE-block case. A
// meeting that ENDS in a dead sliver just before a floating block (the "push
// Michal" case: meeting ends 11:15, lunch pinned at its 11:30 window floor, a
// 15-min dead gap between them that lunch CAN'T slide down to swallow) is pushed
// LATER so it ends exactly at the block's start. Target start is grid-aligned
// DOWN (any residual ≤ a quarter is connective, never dead). Same guards as the
// pull: same-day, attendee-free, and it must NOT open a new dead gap on the
// meeting's LEFT (scoreSlotDensity checks both neighbours). Caller owns the
// protection / external / recently-moved gates. Routes through the ONE move path.
export async function pushInternalMeetingToAbutBefore(params: {
  movable: CalendarEvent;
  blockStartDt: DateTime;              // the floating block's START — abut target
  blockEventId: string;               // recorded as kept_event_id (revert handle)
  moveVerb: string;
  conflictReason: string;
  dayEventsForBusy: CalendarEvent[];
  issue: HealthIssue;
  userEmail: string;
  ownerUserId: string;
  timezone: string;
  profile: UserProfile;
  context: { channelId: string; threadTs?: string };
  internalActions: Array<{ tool: string; detail: string }>;
}): Promise<void> {
  const { movable, blockStartDt, blockEventId, moveVerb, conflictReason,
    dayEventsForBusy, issue, userEmail, ownerUserId, timezone, profile, context, internalActions } = params;
  const mStart = parseGraphDt(movable.start.dateTime, movable.start.timeZone, timezone);
  const mEnd = parseGraphDt(movable.end.dateTime, movable.end.timeZone, timezone);
  const durationMin = Math.round(mEnd.diff(mStart, 'minutes').minutes);
  const durationMs = durationMin * 60000;
  const participantsRaw = (movable.attendees ?? []).filter(a => a.status?.response !== 'declined');
  const attendeeEmails = participantsRaw.map(a => a.emailAddress.address).filter(Boolean);

  // Target: the meeting ENDS at the block's start. Prefer an on-grid start
  // (align DOWN); but if that leaves a DEAD residual gap to the block (durations
  // ≡ 5 mod 15 — 20/50 min — where no quarter start abuts a quarter block), fall
  // back to the EXACT abut (off-grid start, 0-gap). A clean kiss beats an on-grid
  // start with a fresh sliver. The walker tests the exact off-grid start as-is
  // when gridAlignStart is off (findAvailableSlots: cursor starts at searchFrom).
  const densCfg = densityConfigFromProfile(profile.meetings);
  let targetStartMs = alignDownQuarter(blockStartDt.toMillis() - durationMs, timezone);
  let gridAligned = true;
  if ((blockStartDt.toMillis() - (targetStartMs + durationMs)) / 60000 > densCfg.bufferMinutes) {
    targetStartMs = blockStartDt.toMillis() - durationMs;   // exact abut, off-grid
    gridAligned = false;
  }
  const targetStartDt = DateTime.fromMillis(targetStartMs, { zone: timezone });
  const targetEndMs = targetStartMs + durationMs;

  // Must push LATER (never earlier), stay same-day, and not overlap the block.
  if (targetStartMs <= mStart.toMillis()
      || !targetStartDt.hasSame(mStart, 'day')
      || targetEndMs > blockStartDt.toMillis()) {
    issue.fix_failed = true;
    issue.fix_error = 'No clean slot that abuts the block — left for you.';
    return;
  }

  // Attendee-free at the target (owner + required attendees, cross-TZ hours).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { attendeeCheckParams } = require('../../utils/attendeeAvailability') as typeof import('../../utils/attendeeAvailability');
  // #M3 — owner's zone as the no-stored-TZ fallback (see pullInternalMeetingToAbut
  // above); otherwise a no-TZ attendee dropped out of this hours check entirely.
  const slots = await findAvailableSlots({
    userEmail, timezone, durationMinutes: durationMin,
    ...attendeeCheckParams(attendeeEmails, userEmail, timezone),
    searchFrom: targetStartDt.toUTC().toISO()!,
    searchTo: blockStartDt.toUTC().toISO()!,
    minBufferHours: 0,
    excludeEventIds: [movable.id],   // its own current slot isn't a conflict
    allowMovingEventOverlap: true,   // a push forward overlaps the meeting's own slot — that's the point, not a forbidden "offer it back"
    autoExpand: false,               // stay in the SAME-DAY gap — never widen
    gridAlignStart: gridAligned,     // aligned target → align; exact off-grid abut → test as-is
    profile,
  });
  const free = slots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - targetStartMs) <= 60000);

  // Net-improvement guard: the pushed slot must NOT open a new dead gap on the
  // LEFT (the meeting before it) — never just shove the sliver onto the
  // neighbour. floatingBlocksAsNeighbours: true — this push target's whole
  // point is abutting the floating block, so the block must score as a real
  // neighbour (same rationale as pullInternalMeetingToAbut above).
  const dayBusy = densityCommitments(dayEventsForBusy, profile, {
    floatingBlocksAsNeighbours: true,
    excludeEventIds: [movable.id],
  });
  const tScore = scoreSlotDensity(targetStartMs, targetEndMs, dayBusy, densCfg);

  if (!free || tScore.createsDeadGap) {
    issue.fix_failed = true;
    issue.fix_error = 'No back-to-back slot that cleanly closes the gap (attendee busy, or it would just shift the gap) — left for you.';
    return;
  }

  await executeInternalAutoMove({
    movable, origStart: mStart, origEnd: mEnd, durationMin,
    newStartIso: targetStartDt.toUTC().toISO()!, participantsRaw, conflictReason, moveVerb,
    keptEventId: blockEventId, issue, userEmail, ownerUserId, timezone, profile, context, internalActions,
  });
}
