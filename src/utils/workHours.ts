/**
 * Owner work-hours helpers.
 *
 * v2.8.1 — multi-window support. Each weekday can have multiple work-hour
 * ranges (e.g. Tuesday "09:00-15:30" + "21:30-23:59" for a split-shift day).
 * The yaml field `schedule.work_hours: Record<weekday, string[]>` is the
 * authoritative source when set; otherwise the legacy single-window from
 * `office_days.hours_start/hours_end` (or `home_days.*`) is used.
 *
 * Day-type classification (office vs home) is independent of work_hours —
 * it always comes from office_days.days / home_days.days for category
 * rules + location resolution.
 *
 * Originally used only by task dispatchers; now also by the slot finder
 * (calendar.ts) and scheduleRules.checkSlot.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';

export interface WorkHourRange {
  startMin: number;  // inclusive, minutes since local midnight
  endMin: number;    // exclusive
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function parseRange(rangeStr: string): WorkHourRange | null {
  const m = rangeStr.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (!m) return null;
  const startMin = parseHHMM(m[1]);
  const endMin = parseHHMM(m[2]);
  if (endMin <= startMin) return null;
  return { startMin, endMin };
}

/**
 * Returns the work-hour windows for `dayName` (English weekday).
 * Empty array means non-workday.
 *
 * Resolution: yaml `work_hours[dayName]` if set, else fall back to
 * office_days/home_days legacy shape. Day-type classification (office vs
 * home) is unrelated; that's read separately from office_days.days /
 * home_days.days.
 */
export function getOwnerWorkHoursForDay(
  profile: UserProfile,
  dayName: string,
): WorkHourRange[] {
  const wh = profile.schedule.work_hours;
  const dayRanges = wh ? wh[dayName as keyof typeof wh] : undefined;
  if (!dayRanges || dayRanges.length === 0) return [];
  const ranges: WorkHourRange[] = [];
  for (const r of dayRanges) {
    const parsed = parseRange(r);
    if (parsed) ranges.push(parsed);
  }
  return ranges.sort((a, b) => a.startMin - b.startMin);
}

/**
 * True iff [slotStartMin, slotEndMin) fits fully inside ANY window in the day.
 */
export function isSlotInWorkHours(
  windows: WorkHourRange[],
  slotStartMin: number,
  slotEndMin: number,
): boolean {
  for (const w of windows) {
    if (slotStartMin >= w.startMin && slotEndMin <= w.endMin) return true;
  }
  return false;
}

/**
 * Sum of work-hour minutes across all windows on the day. Used by
 * focus-time computation.
 */
export function totalWorkMinutes(windows: WorkHourRange[]): number {
  return windows.reduce((acc, w) => acc + (w.endMin - w.startMin), 0);
}

/**
 * Returns true if `now` falls within ANY of the owner's work windows for
 * the current weekday. Multi-window aware (Tuesday split into morning +
 * evening windows is honored if yaml defines it).
 */
export function isWithinOwnerWorkHours(profile: UserProfile, now: DateTime): boolean {
  const day = now.toFormat('EEEE');
  const windows = getOwnerWorkHoursForDay(profile, day);
  if (windows.length === 0) return false;
  const minutes = now.hour * 60 + now.minute;
  for (const w of windows) {
    if (minutes >= w.startMin && minutes < w.endMin) return true;
  }
  return false;
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
 * v2.1.4 — default date window for the daily calendar health check.
 *
 * Rule (owner simplification):
 *   start = today (local date, start of day)
 *   end   = the owner's last workday of the current week, at end-of-hours
 *   if (end - start) <= 24 hours → extend end by 7 calendar days
 *
 * The <=24h branch catches "we're already on the last workday" — no point
 * checking only today; push the window into next week so there's actually
 * runway to coordinate moves with colleagues. Otherwise the window is
 * today through end of workweek (Sun-Thu for Idan's profile).
 *
 * Returns YYYY-MM-DD strings so the health-check tool can plug them in
 * directly. Deterministic — Sonnet doesn't compute dates.
 */
export function computeHealthCheckWindow(profile: UserProfile): {
  startDate: string;
  endDate: string;
} {
  const tz = profile.user.timezone;
  const officeDays = profile.schedule.office_days.days as string[];
  const homeDays = profile.schedule.home_days.days as string[];
  const workDaySet = new Set<string>([...officeDays, ...homeDays]);

  const now = DateTime.now().setZone(tz);

  // Walk today..today+6 and take the LAST workday seen across the full
  // 7-day window. The previous "stop at first non-workday" heuristic
  // assumed contiguous workweeks — on a non-contiguous schedule (e.g.
  // Sun/Mon/Wed/Thu with Tuesday off), calling this on Sunday would
  // STOP at Tuesday and return Monday, losing Wednesday + Thursday from
  // the coverage window. With a calendar that mixes office days through
  // the week, just take the furthest workday inside 7 days.
  let endWorkday = now;
  for (let i = 0; i < 7; i++) {
    const d = now.plus({ days: i });
    if (workDaySet.has(d.toFormat('EEEE'))) {
      endWorkday = d;
    }
  }

  // Compute the end-of-work-hours timestamp for the selected endWorkday.
  // v2.8.1 — multi-window aware: use the LAST window's end on the day
  // (so Tuesday "09:00-15:30, 21:30-23:59" → end is 23:59).
  const dayName = endWorkday.toFormat('EEEE');
  const windows = getOwnerWorkHoursForDay(profile, dayName);
  const lastWindow = windows.length > 0 ? windows[windows.length - 1] : null;
  const endDt = lastWindow
    ? endWorkday.set({
        hour: Math.floor(lastWindow.endMin / 60),
        minute: lastWindow.endMin % 60,
        second: 0,
        millisecond: 0,
      })
    : endWorkday.endOf('day');

  // If the full window is <= 24 hours, we're essentially out of runway
  // this week. Extend into next week so there's time to coordinate moves.
  const hoursInWindow = endDt.diff(now, 'hours').hours;
  const finalEnd = hoursInWindow <= 24
    ? endDt.plus({ days: 7 })
    : endDt;

  return {
    startDate: now.toFormat('yyyy-MM-dd'),
    endDate: finalEnd.toFormat('yyyy-MM-dd'),
  };
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

  for (let i = 0; i < 14; i++) {
    const candidate = cursor.plus({ days: i });
    const day = candidate.toFormat('EEEE');
    const windows = getOwnerWorkHoursForDay(profile, day);
    if (windows.length === 0) continue;
    // Find the earliest window start that's still in the future (or first
    // window of a future day). Multi-window: a slot at 21:30 after the
    // current 17:30 cutoff is still "next work-time start" for the same day.
    for (const w of windows) {
      const dt = candidate.set({
        hour: Math.floor(w.startMin / 60),
        minute: w.startMin % 60,
        second: 0,
        millisecond: 0,
      });
      if (dt >= cursor) return dt.toUTC().toISO()!;
    }
  }
  return cursor.plus({ hours: 8 }).toUTC().toISO()!;
}
