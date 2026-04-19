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
