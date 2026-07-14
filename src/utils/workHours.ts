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
import { getScheduleOverride } from '../db/scheduleOverrides';

export interface WorkHourRange {
  startMin: number;  // inclusive, minutes since local midnight
  endMin: number;    // exclusive
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Format minute-of-day as "HH:MM". Special-cases 1440 → "23:59" to avoid
 * producing "24:00", which luxon parses as next-day 00:00 — silently
 * extending day-bounded ranges past midnight in any caller that round-
 * trips the string through DateTime.fromISO. Pre-fix, both the
 * issue-detection bounding box (calendarHealth) and the HARD RULES prompt
 * block (meetings.ts) emitted "24:00" for any owner work_hours range
 * ending at 23:59 (which parseRange canonicalizes to endMin=1440).
 */
export function formatMinuteOfDay(minOfDay: number): string {
  const clamped = minOfDay >= 1440 ? 1439 : minOfDay;
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function parseRange(rangeStr: string): WorkHourRange | null {
  const m = rangeStr.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (!m) return null;
  const startMin = parseHHMM(m[1]);
  let endMin = parseHHMM(m[2]);
  if (endMin <= startMin) return null;
  // Normalize "23:59" (last expressible minute in HH:MM) to 1440 (end-of-
  // day, exclusive). Yaml authors use 23:59 to mean "work runs through
  // the end of the day" — but the literal endMin=1439 left a 1-minute
  // dead zone at the boundary where isWithinOwnerWorkHours returned false
  // at 23:59:00 while isSlotInWorkHours accepted a slot ending at 23:59.
  // With endMin=1440, both functions agree the boundary minute is
  // in-window (1439 < 1440, 1439 <= 1440).
  if (endMin === 1439) endMin = 1440;
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

export interface EffectiveWorkDay {
  isWorkday: boolean;
  windows: WorkHourRange[];              // minute-of-day, interpreted in `timezone`
  location: 'office' | 'home' | 'elsewhere';
  timezone: string;                      // effective IANA (home tz unless an override sets one)
  isAway: boolean;                       // timezone !== the owner's home tz
  hasOverride: boolean;                  // an override row exists for this date
  source: 'yaml' | 'override';
}

/**
 * v3.7.x (#143) — THE accessor for a date's effective work context: YAML is the
 * base, a per-date chat override wins per-column, no row = YAML (fail-safe). Sync
 * (a better-sqlite3 read) so the hot validator checkSlot stays sync. An override
 * with an explicit `timezone` marks an away day (windows evaluated in that zone,
 * booked directly — no forced approval); with no timezone the day stays in the
 * owner's home tz ("Tuesday 9-3" is home-tz 9-3). Every work-hours consumer
 * (slot search, checkSlot, resolveLocation, "is he working now") routes through
 * this, so search and validate can never disagree on a date.
 */
export function getEffectiveWorkDay(dateIso: string, profile: UserProfile): EffectiveWorkDay {
  const homeTz = profile.user.timezone;
  const dayName = DateTime.fromISO(dateIso, { zone: homeTz }).toFormat('EEEE');
  const baseWindows = getOwnerWorkHoursForDay(profile, dayName);
  const officeDays = (profile.schedule.office_days?.days ?? []) as string[];
  const homeDays = (profile.schedule.home_days?.days ?? []) as string[];
  const baseLoc: 'office' | 'home' | 'elsewhere' =
    officeDays.includes(dayName) ? 'office' : homeDays.includes(dayName) ? 'home' : 'elsewhere';
  const baseIsWorkday = baseWindows.length > 0 || officeDays.includes(dayName) || homeDays.includes(dayName);

  let row: ReturnType<typeof getScheduleOverride> = null;
  try { row = getScheduleOverride(profile.user.slack_user_id, dateIso); }
  catch { row = null; }  // fail-safe → yaml base

  if (!row) {
    return { isWorkday: baseIsWorkday, windows: baseWindows, location: baseLoc, timezone: homeTz, isAway: false, hasOverride: false, source: 'yaml' };
  }

  const tz = row.timezone ?? homeTz;
  let windows = baseWindows;
  if (row.windows) {
    const parsed: WorkHourRange[] = [];
    for (const r of row.windows) { const p = parseRange(r); if (p) parsed.push(p); }
    windows = parsed.sort((a, b) => a.startMin - b.startMin);
  }
  const isWorkday = row.isWorkday != null ? row.isWorkday : (windows.length > 0 || baseIsWorkday);
  if (!isWorkday) windows = [];
  const location: 'office' | 'home' | 'elsewhere' = row.location ?? (row.timezone ? 'elsewhere' : baseLoc);
  return { isWorkday, windows, location, timezone: tz, isAway: tz !== homeTz, hasOverride: true, source: 'override' };
}

/**
 * v3.7.x (#143) — instant-aware variant for SLOT-level consumers (the search
 * walk, checkSlot's hours rule, the dual-clock/location resolver). A far-west
 * away window (e.g. Chicago 9-5 CDT, ~8h behind home) crosses home-tz midnight,
 * so ONE home-tz date hosts slots from TWO trip days — a plain date lookup then
 * evaluates a Chicago-afternoon slot (which is home-tz next-day 00:30) against
 * HOME hours and wrongly rejects it. Resolve by which trip-day actually OWNS the
 * instant: an away override owns it iff, in that override's OWN timezone, the
 * instant falls on that override's date. Check the home date first (a home-tz
 * override or an owning away override wins), then either neighbouring home date
 * (west trips spill into the next, east trips into the previous). Otherwise fall
 * through to getEffectiveWorkDay(homeDate) —
 * byte-identical to today for every non-far-west case (no override, a home-tz
 * override, or Boston/east where the home date owns the instant).
 */
export function getEffectiveWorkDayForInstant(instantIso: string, profile: UserProfile): EffectiveWorkDay {
  const homeTz = profile.user.timezone;
  const dt = DateTime.fromISO(instantIso, { setZone: true });
  if (!dt.isValid) return getEffectiveWorkDay(instantIso, profile);  // defensive — let the date path handle a bad input
  const homeDate = dt.setZone(homeTz).toFormat('yyyy-MM-dd');

  // The home-date override wins UNLESS it is a far-west away override whose window
  // does not actually cover this instant (the instant belongs to the previous trip day).
  let homeRow: ReturnType<typeof getScheduleOverride> = null;
  try { homeRow = getScheduleOverride(profile.user.slack_user_id, homeDate); } catch { homeRow = null; }
  if (homeRow && (!homeRow.timezone || dt.setZone(homeRow.timezone).toFormat('yyyy-MM-dd') === homeDate)) {
    return getEffectiveWorkDay(homeDate, profile);
  }

  // Neighbour spillover: a far-WEST away window spills into the NEXT home date,
  // a far-EAST one into the PREVIOUS — an away override owns the instant iff, in
  // ITS OWN zone, the instant falls on ITS date. Check both neighbours so the fix
  // is symmetric (US trips west of home AND Asia/Pacific trips east of home).
  for (const delta of [-1, 1]) {
    const neighbour = dt.setZone(homeTz).plus({ days: delta }).toFormat('yyyy-MM-dd');
    let nRow: ReturnType<typeof getScheduleOverride> = null;
    try { nRow = getScheduleOverride(profile.user.slack_user_id, neighbour); } catch { nRow = null; }
    if (nRow?.timezone && dt.setZone(nRow.timezone).toFormat('yyyy-MM-dd') === neighbour) {
      return getEffectiveWorkDay(neighbour, profile);
    }
  }

  return getEffectiveWorkDay(homeDate, profile);
}

/**
 * A slot's [startMin, endMin] as minutes-from-midnight of the START day, with
 * the end computed as start + DURATION so it NEVER wraps past midnight.
 *
 * The bug this fixes: computing endMin as `slotEnd.hour*60 + slotEnd.minute`
 * wraps for a slot ending after midnight — 23:30–00:10 gave endMin=10, so
 * `endMin <= window.endMin` (10 <= 19:00) was trivially true and a late meeting
 * "fit" EVERY day's hours, booking the owner at night on a non-night-shift day.
 * Owner/attendee windows never cross midnight (parseRange caps them at 1440), so
 * a slot ending past midnight (endMin > 1440) is always outside working hours.
 * Duration-based end is DST/TZ-safe and matches the slot finder's own
 * `startMin + durationMinutes`.
 */
export function slotDayMinutes(slotStart: DateTime, slotEnd: DateTime): { startMin: number; endMin: number } {
  const startMin = slotStart.hour * 60 + slotStart.minute;
  const durationMin = Math.max(0, Math.round(slotEnd.diff(slotStart, 'minutes').minutes));
  return { startMin, endMin: startMin + durationMin };
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
  // v3.7.x (#143) — date-aware: a per-date override (day off, custom hours, or an
  // away/tz day) reshapes "is he working now." Resolve the effective day for the
  // instant's home-tz date, then evaluate the moment in that day's effective tz
  // (an away override shifts it). No override → home tz + yaml windows → identical
  // to the old weekday lookup. This is the #141 "is he working now" tail.
  const homeTz = profile.user.timezone;
  const eff = getEffectiveWorkDay(now.setZone(homeTz).toFormat('yyyy-MM-dd'), profile);
  if (!eff.isWorkday || eff.windows.length === 0) return false;
  const local = now.setZone(eff.timezone);
  const minutes = local.hour * 60 + local.minute;
  for (const w of eff.windows) {
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
  const now = DateTime.now().setZone(tz);

  // v3.2.6 — window is "rest of this week + all of next week" (owner direction):
  // today through the SATURDAY that ends NEXT week (Sun–Sat week). On a Sunday
  // that's a full 14 days (Sun → Sat-after); on a Thursday it's Thu → Sat-after.
  // Bounded + intuitive — short enough that the daily report stops re-narrating
  // conflicts three weeks out (the old 21-day M-11 sweep over-surfaced).
  // dayIndex: Sunday=0 … Saturday=6 (Luxon weekday is Mon=1..Sun=7 → %7).
  const dayIndex = now.weekday % 7;
  const endOfNextWeek = now.minus({ days: dayIndex }).startOf('day').plus({ days: 13 });

  return {
    startDate: now.toFormat('yyyy-MM-dd'),
    endDate: endOfNextWeek.toFormat('yyyy-MM-dd'),
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
 * Walks forward day-by-day; picks the earliest still-future window start
 * across the day's multi-window work_hours (split-shift aware). Caps at
 * 14 days lookahead (defensive — should never hit).
 */
export function nextOwnerWorkdayStart(profile: UserProfile): string {
  const homeTz = profile.user.timezone;
  const cursor = DateTime.now().setZone(homeTz);

  for (let i = 0; i < 14; i++) {
    const candidate = cursor.plus({ days: i });
    // v3.7.x (#143) — per-date effective day: an override day off is skipped, an
    // override work day (or away day) is honored with its own windows + tz. No
    // override → identical to the old weekday work_hours lookup.
    const eff = getEffectiveWorkDay(candidate.toFormat('yyyy-MM-dd'), profile);
    if (!eff.isWorkday || eff.windows.length === 0) continue;
    // Find the earliest window start that's still in the future (or first
    // window of a future day). Multi-window: a slot at 21:30 after the current
    // 17:30 cutoff is still "next work-time start" for the same day. Window
    // starts are minute-of-day in the day's EFFECTIVE tz.
    for (const w of eff.windows) {
      const dt = DateTime.fromISO(candidate.toFormat('yyyy-MM-dd'), { zone: eff.timezone }).set({
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
