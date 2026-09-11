/** Recipient business-time arithmetic shared by outreach producers and timers.
 * Person data and dated travel come from the same availability spine as slot search.
 */
import { DateTime } from 'luxon';
import { getPersonMemory } from '../db/people';
import { attendeeWorkIntervalsBetween, loadAttendeeAvailabilityForPerson } from './attendeeAvailability';
import { defaultWorkingHoursForTz } from './workingHoursDefault';

export interface ColleagueTimeContext {
  slackId: string;
  ownerTimezone: string;
}

/** Iterate real work intervals in the explicitly stated work-window zone, or
 * the dated physical zone when no fixed window zone was stated. The shared
 * attendee spine owns destination-local trip boundaries and window clipping.
 * Explicit tool/job zones are fallback data: stored permanent person data and
 * stated dated travel retain the same authority they have in slot search.
 */
function* workIntervals(fallbackTimezone: string, fromMs: number, recipient?: ColleagueTimeContext): Generator<[number, number]> {
  const person = recipient ? getPersonMemory(recipient.slackId) : undefined;
  const entry = loadAttendeeAvailabilityForPerson(person ?? undefined, fallbackTimezone);
  const hours = entry ?? { ...defaultWorkingHoursForTz(fallbackTimezone), timezone: fallbackTimezone, email: '' };
  const ownerTimezone = recipient?.ownerTimezone ?? fallbackTimezone;
  const from = DateTime.fromMillis(fromMs, { zone: ownerTimezone });
  const until = from.startOf('day').plus({ days: 60 });
  for (const { start, end } of attendeeWorkIntervalsBetween(hours, from, until)) yield [start.toMillis(), end.toMillis()];
}

/** 24 working hours from now in the person's stated window zone, otherwise
 * each intervening day's travel/return zone. Nights and weekends do not count.
 */
export function calcResponseDeadline(colleagueTz: string, recipient?: ColleagueTimeContext): string {
  let remainingMs = 24 * 60 * 60 * 1000;
  for (const [start, end] of workIntervals(colleagueTz, Date.now(), recipient)) {
    if (end - start >= remainingMs) return DateTime.fromMillis(start + remainingMs).toUTC().toISO()!;
    remainingMs -= end - start;
  }
  throw new Error('No recipient response deadline within 60 calendar days');
}

/** Now when already working; otherwise the next work start at/after fromMs.
 * Scheduled sends anchor to their requested instant, never today's trip zone.
 */
export function colleagueWorkTimeBaseFromNow(
  colleagueTz: string | null | undefined,
  fromMs = Date.now(),
  recipient?: ColleagueTimeContext,
): string {
  for (const [start] of workIntervals(colleagueTz || 'UTC', fromMs, recipient)) {
    return DateTime.fromMillis(start).toUTC().toISO()!;
  }
  throw new Error('No recipient work time within 60 calendar days');
}

/** Timer slop only; schedule-time floors use the exact work start above. */
const COLLEAGUE_SEND_GATE_SLOP_MS = 60_000;

export function isColleagueSendDeferred(
  colleagueTz: string | null | undefined,
  recipient?: ColleagueTimeContext,
): { deferred: false } | { deferred: true; deferredTo: string } {
  const deferredTo = colleagueWorkTimeBaseFromNow(colleagueTz, Date.now(), recipient);
  return Date.parse(deferredTo) > Date.now() + COLLEAGUE_SEND_GATE_SLOP_MS
    ? { deferred: true, deferredTo }
    : { deferred: false };
}
