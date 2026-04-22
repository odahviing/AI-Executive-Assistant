/**
 * Owner work-hours helpers.
 *
 * Used by task dispatchers that send system→owner notifications outside of
 * the user's flow. Respects the owner's `schedule.office_days` + `home_days`
 * windows from the profile so Maelle doesn't DM at 3am Saturday.
 *
 * Extracted from tasks/dispatchers/outreachExpiry.ts (v1.8.0) when coord_nudge
 * picked up the same pattern.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';

/**
 * Returns true if `now` falls within ANY of the owner's defined work windows
 * (office_days OR home_days, each with their own hours).
 */
export function isWithinOwnerWorkHours(profile: UserProfile, now: DateTime): boolean {
  const day = now.toFormat('EEEE'); // "Monday"
  const officeDays = profile.schedule.office_days.days as string[];
  const homeDays = profile.schedule.home_days.days as string[];

  if (officeDays.includes(day)) {
    return isInWindow(now, profile.schedule.office_days.hours_start, profile.schedule.office_days.hours_end);
  }
  if (homeDays.includes(day)) {
    return isInWindow(now, profile.schedule.home_days.hours_start, profile.schedule.home_days.hours_end);
  }
  return false; // not a work day
}

function isInWindow(dt: DateTime, startHHMM: string, endHHMM: string): boolean {
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const minutes = dt.hour * 60 + dt.minute;
  return minutes >= (sh * 60 + sm) && minutes <= (eh * 60 + em);
}

/**
 * Add N owner work-days to an ISO timestamp and return the resulting ISO.
 *
 * "Work-day" = any day listed in the owner's office_days or home_days. Weekend
 * days (Friday/Saturday for the default profile) do not advance the counter.
 * The time-of-day portion of `fromIso` is preserved; we only skip the date
 * forward across non-work days. Used by `outreach_decision` to give up on a
 * colleague after N working days regardless of weekends in between. v2.0.7.
 *
 * Examples for a profile with workDays = Sun/Mon/Tue/Wed/Thu:
 *   - fromIso=Sun 12:00, addWorkdays(2) → Tue 12:00
 *   - fromIso=Thu 12:00, addWorkdays(2) → Mon 12:00  (Fri+Sat skipped)
 *   - fromIso=Sat 12:00, addWorkdays(2) → Tue 12:00  (count starts from Sun)
 */
export function addWorkdays(fromIso: string, n: number, profile: UserProfile): string {
  const officeDays = profile.schedule.office_days.days as string[];
  const homeDays = profile.schedule.home_days.days as string[];
  const workDays = new Set([...officeDays, ...homeDays]);

  let cursor = DateTime.fromISO(fromIso).setZone(profile.user.timezone);
  let remaining = n;

  // If fromIso falls on a non-work day, advance to next work day without
  // consuming any of the N — "counter starts from Sunday" when asked Saturday.
  while (!workDays.has(cursor.toFormat('EEEE'))) {
    cursor = cursor.plus({ days: 1 });
  }

  // Now consume N work-days. Each iteration moves +1 calendar day then skips
  // over any non-work days before the next count.
  while (remaining > 0) {
    cursor = cursor.plus({ days: 1 });
    while (!workDays.has(cursor.toFormat('EEEE'))) {
      cursor = cursor.plus({ days: 1 });
    }
    remaining -= 1;
  }

  return cursor.toUTC().toISO()!;
}

/**
 * v2.1.3 — base timestamp for owner-workday expiry calculations.
 * Returns NOW when the owner is currently within their work hours, else
 * the ISO of the next work-time start.
 *
 * Why: when an approval is created at 20:00 (colleague asked late), the
 * "2 workdays from now" expiry shouldn't count the 13 off-hours between
 * creation and the next work morning. The counter should start when the
 * owner is actually at work. Otherwise a 20:00 approval gets an expiry
 * ~13 hours earlier in the workday than a 09:00 approval — silent bias.
 */
export function workTimeBaseFromNow(profile: UserProfile): string {
  const now = DateTime.now().setZone(profile.user.timezone);
  if (isWithinOwnerWorkHours(profile, now)) return now.toUTC().toISO()!;
  return nextOwnerWorkdayStart(profile);
}

/**
 * Returns ISO of the next moment the owner is in work hours.
 * Walks forward day-by-day; for each candidate day, picks the relevant
 * hours_start. Caps at 14 days lookahead (defensive — should never hit).
 */
export function nextOwnerWorkdayStart(profile: UserProfile): string {
  const cursor = DateTime.now().setZone(profile.user.timezone);
  const officeDays = profile.schedule.office_days.days as string[];
  const homeDays = profile.schedule.home_days.days as string[];

  for (let i = 0; i < 14; i++) {
    const candidate = cursor.plus({ days: i });
    const day = candidate.toFormat('EEEE');
    if (officeDays.includes(day)) {
      const [h, m] = profile.schedule.office_days.hours_start.split(':').map(Number);
      const dt = candidate.set({ hour: h, minute: m, second: 0, millisecond: 0 });
      if (i === 0 && dt < cursor) continue; // already past today's start; try tomorrow
      return dt.toUTC().toISO()!;
    }
    if (homeDays.includes(day)) {
      const [h, m] = profile.schedule.home_days.hours_start.split(':').map(Number);
      const dt = candidate.set({ hour: h, minute: m, second: 0, millisecond: 0 });
      if (i === 0 && dt < cursor) continue;
      return dt.toUTC().toISO()!;
    }
  }
  // Fallback — schedule looks empty; fire in 8 hours
  return cursor.plus({ hours: 8 }).toUTC().toISO()!;
}
