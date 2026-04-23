/**
 * v2.1.4 — verify whether a pending outreach / coord outcome already landed
 * on the owner's calendar via a third party.
 *
 * Scenario: Maelle tells Michal "Wed 29 Apr noon works for the bank visit,
 * confirm with Inbar." Inbar (or her assistant) creates the meeting from
 * their side. The invite arrives on Idan's calendar. Maelle's outreach row
 * is still `status='sent'`, so the next morning she'd narrate "still waiting
 * to hear back" — wrong. This helper scans the calendar for events that
 * match the proposed slots + subject keyword, and if one's there, reports
 * back what happened so the brief can close the loop honestly.
 *
 * Shape-agnostic — works for both `outreach_jobs` (new proposed_slots /
 * subject_keyword columns) and `coord_jobs` (proposed_slots + subject).
 * Returns one of:
 *   - 'none' → no matching event found on any proposed date
 *   - 'booked_compliant' → event found AND its time passes the owner's
 *     scheduling rules (no buffer/lunch/hours violation)
 *   - 'booked_conflict' → event found BUT its time breaks a rule →
 *     caller surfaces it to the owner for approve-or-push-back
 *
 * Design note: match is by DATE (same day as a proposed slot) + subject
 * keyword fuzzy match. Exact time isn't required — if Maelle proposed noon
 * and the booker landed at 13:00, that still counts as "the meeting they
 * were setting up". The compliance check decides whether it deserves an
 * alarm in the brief.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import type { CalendarEvent } from '../connectors/graph/calendar';
import { getFloatingBlocks, isFloatingBlockEvent, blockAppliesOnDay, windowMsForDay, findAlignedSlotForBlock } from './floatingBlocks';

export type ScheduleOutcomeStatus = 'none' | 'booked_compliant' | 'booked_conflict';

export interface ScheduleOutcome {
  status: ScheduleOutcomeStatus;
  event?: CalendarEvent;
  issues?: string[];             // populated when status='booked_conflict'
  proposed_slot_matched?: string; // which proposed ISO the event is closest to
}

export interface VerifyInput {
  proposedSlots: string[];       // JSON-parsed ISO strings
  subjectKeyword?: string;       // optional — when absent, date match alone suffices for outreach
  colleagueSlackId?: string;     // optional — used as a secondary match signal
  colleagueEmail?: string;       // optional — for attendee-based matching
}

/**
 * Fuzzy subject match — case-insensitive substring in either direction, plus
 * a token-based check so "bank visit" matches "Bank Hapoalim visit" and
 * "Interview: Don Nguyen" matches keyword "Don Nguyen interview".
 */
function subjectMatches(eventSubject: string, keyword: string): boolean {
  const s = eventSubject.toLowerCase();
  const k = keyword.toLowerCase().trim();
  if (!k) return false;
  if (s.includes(k)) return true;
  if (k.includes(s)) return true;
  // Token overlap: split both on non-word chars, count overlap.
  const sTokens = new Set(s.split(/\W+/).filter(t => t.length >= 3));
  const kTokens = k.split(/\W+/).filter(t => t.length >= 3);
  if (kTokens.length === 0) return false;
  const overlap = kTokens.filter(t => sTokens.has(t)).length;
  // Need at least half the keyword tokens to match.
  return overlap / kTokens.length >= 0.5;
}

/**
 * Does the event's time pass the owner's basic scheduling rules?
 * Checks:
 *   1. Inside work hours for the event's day-type (office/home).
 *   2. No floating-block window violation (lunch still fits, etc.).
 *   3. Owner's buffer isn't broken against OTHER events on the day
 *      (deferred — the existing buffer logic lives in findAvailableSlots
 *      which needs a full calendar pull; cheapest path for v2.1.4 is to
 *      flag only the hard violations above).
 */
function checkCompliance(
  event: CalendarEvent,
  allDayEvents: CalendarEvent[],
  profile: UserProfile,
): string[] {
  const issues: string[] = [];
  const tz = profile.user.timezone;
  const eStart = DateTime.fromISO(event.start.dateTime, { zone: event.start.timeZone ?? 'utc' })
    .setZone(tz);
  const eEnd = DateTime.fromISO(event.end.dateTime, { zone: event.end.timeZone ?? 'utc' })
    .setZone(tz);
  const dayName = eStart.toFormat('EEEE');

  // 1. Work hours check
  const officeDays = profile.schedule.office_days.days as string[];
  const homeDays = profile.schedule.home_days.days as string[];
  let hoursStart: string | null = null;
  let hoursEnd: string | null = null;
  if (officeDays.includes(dayName)) {
    hoursStart = profile.schedule.office_days.hours_start;
    hoursEnd = profile.schedule.office_days.hours_end;
  } else if (homeDays.includes(dayName)) {
    hoursStart = profile.schedule.home_days.hours_start;
    hoursEnd = profile.schedule.home_days.hours_end;
  } else {
    issues.push(`booked on ${dayName} (${eStart.toFormat('d MMM')}) — not a work day`);
  }
  if (hoursStart && hoursEnd) {
    const [sh, sm] = hoursStart.split(':').map(Number);
    const [eh, em] = hoursEnd.split(':').map(Number);
    const startMin = eStart.hour * 60 + eStart.minute;
    const endMin = eEnd.hour * 60 + eEnd.minute;
    if (startMin < sh * 60 + sm) issues.push(`starts before your work hours (${hoursStart})`);
    if (endMin > eh * 60 + em) issues.push(`runs past your work hours (${hoursEnd})`);
  }

  // 2. Floating-block feasibility — any block for this day-of-week that
  //    overlaps the event window must still have a valid aligned slot.
  const blocks = getFloatingBlocks(profile);
  const dayStr = eStart.toFormat('yyyy-MM-dd');
  const bufferMin = profile.meetings.buffer_minutes ?? 5;
  for (const block of blocks) {
    if (!blockAppliesOnDay(block, dayName, profile)) continue;
    const winStart = windowMsForDay(dayStr, block.preferred_start, tz);
    const winEnd = windowMsForDay(dayStr, block.preferred_end, tz);
    if (eEnd.toMillis() <= winStart || eStart.toMillis() >= winEnd) continue;
    // Build busyInWindow from OTHER events on this day (skip the event itself
    // + any existing block events — the block is elastic).
    const busyInWindow: Array<{ start: number; end: number }> = [];
    for (const other of allDayEvents) {
      if (other.id === event.id) continue;
      if (other.isCancelled || other.isAllDay || other.showAs === 'free') continue;
      if (isFloatingBlockEvent(
        { subject: other.subject, categories: (other as unknown as { categories?: unknown }).categories },
        block,
      )) continue;
      const os = DateTime.fromISO(other.start.dateTime, { zone: other.start.timeZone ?? 'utc' }).toMillis();
      const oe = DateTime.fromISO(other.end.dateTime, { zone: other.end.timeZone ?? 'utc' }).toMillis();
      if (os < winEnd && oe > winStart) {
        busyInWindow.push({ start: Math.max(os, winStart), end: Math.min(oe, winEnd) });
      }
    }
    // Add the NEW event to the busy pool.
    busyInWindow.push({
      start: Math.max(eStart.toMillis(), winStart),
      end: Math.min(eEnd.toMillis(), winEnd),
    });
    const aligned = findAlignedSlotForBlock(block, dayStr, tz, busyInWindow, bufferMin);
    if (aligned === null && !block.can_skip) {
      issues.push(`no room left for ${block.name} in ${block.preferred_start}–${block.preferred_end}`);
    }
  }

  return issues;
}

export function verifyScheduledOutcome(
  input: VerifyInput,
  calendarEvents: CalendarEvent[],
  profile: UserProfile,
): ScheduleOutcome {
  if (!input.proposedSlots || input.proposedSlots.length === 0) {
    return { status: 'none' };
  }
  const tz = profile.user.timezone;

  // Dates the caller considers "relevant" — any event on one of these dates
  // that matches the subject keyword is a candidate for "this is what they
  // booked". De-duplicate by yyyy-MM-dd.
  const proposedDates = new Set<string>();
  const proposedByDate = new Map<string, string>(); // date → representative ISO
  for (const iso of input.proposedSlots) {
    const dt = DateTime.fromISO(iso).setZone(tz);
    if (!dt.isValid) continue;
    const d = dt.toFormat('yyyy-MM-dd');
    proposedDates.add(d);
    if (!proposedByDate.has(d)) proposedByDate.set(d, iso);
  }
  if (proposedDates.size === 0) return { status: 'none' };

  // Candidate events: same-day as any proposed slot, non-cancelled, non-free.
  const sameDayEvents = calendarEvents.filter(e => {
    if (e.isCancelled || e.showAs === 'free') return false;
    if (e.isAllDay) return false;
    const eStart = DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' }).setZone(tz);
    return proposedDates.has(eStart.toFormat('yyyy-MM-dd'));
  });
  if (sameDayEvents.length === 0) return { status: 'none' };

  // Score candidates: subject keyword match counts strongly; attendee email
  // match is a tiebreaker. Best scoring candidate wins.
  let best: { event: CalendarEvent; score: number; date: string } | null = null;
  for (const e of sameDayEvents) {
    let score = 0;
    if (input.subjectKeyword && subjectMatches(e.subject || '', input.subjectKeyword)) score += 10;
    if (input.colleagueEmail) {
      const atts = e.attendees ?? [];
      if (atts.some(a => a.emailAddress.address.toLowerCase() === input.colleagueEmail!.toLowerCase())) {
        score += 3;
      }
    }
    // Even without matchers, a same-day new-ish event on a proposed date
    // counts as a weak candidate IF no subject keyword was provided (we
    // can't rule out it's the one). With a subject keyword provided and
    // no match, score stays at 0 → skip.
    if (score === 0 && input.subjectKeyword) continue;
    if (score === 0 && !input.subjectKeyword) score = 1;
    const eDate = DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' })
      .setZone(tz).toFormat('yyyy-MM-dd');
    if (!best || score > best.score) best = { event: e, score, date: eDate };
  }

  if (!best) return { status: 'none' };

  // Compliance check
  const allDayEvents = calendarEvents.filter(e => {
    if (e.isCancelled || e.isAllDay) return false;
    const eStart = DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' }).setZone(tz);
    return eStart.toFormat('yyyy-MM-dd') === best!.date;
  });
  const issues = checkCompliance(best.event, allDayEvents, profile);
  return {
    status: issues.length === 0 ? 'booked_compliant' : 'booked_conflict',
    event: best.event,
    issues: issues.length > 0 ? issues : undefined,
    proposed_slot_matched: proposedByDate.get(best.date),
  };
}
