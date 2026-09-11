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
  // at 23:59:00 while a slot-fit test accepted a slot ending at 23:59.
  // With endMin=1440, both agree the boundary minute is in-window
  // (1439 < 1440, 1439 <= 1440).
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
  // Anchor a bare (zoneless) instant in the owner's HOME tz — NOT the process
  // zone. `setZone:true` alone leaves a no-offset string in the server's local
  // zone (UTC once off Idan's box), which would resolve a near-midnight slot to
  // the wrong calendar date. checkSlot anchors the same string with { zone: tz }
  // (scheduleRules.ts) — match it so the two never disagree on the day.
  const dt = DateTime.fromISO(instantIso, { zone: homeTz, setZone: true });
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
  // IANA zones span UTC-12 through UTC+14: opposite date-line zones can
  // differ by TWO calendar dates, despite representing the same instant.
  for (const delta of [-1, 1, -2, 2]) {
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
 * The wall-clock minute bounds visited by the explicit interval [start,end),
 * relative to its start date. Date rollover stays above 1440; elapsed duration
 * is NOT a wall-clock end on a DST day. Across a backward transition include
 * both sides of the repeated hour, so a slot cannot hide an off-hours portion
 * between endpoints. This never chooses an occurrence for a bare clock or
 * interprets a configured work-window boundary as an instant.
 */
export function slotDayMinutes(slotStart: DateTime, slotEnd: DateTime): { startMin: number; endMin: number } {
  const dateBase = DateTime.utc(slotStart.year, slotStart.month, slotStart.day);
  const wallMinute = (dt: DateTime): number =>
    DateTime.utc(dt.year, dt.month, dt.day).diff(dateBase, 'days').days * 1440
    + dt.hour * 60 + dt.minute + dt.second / 60 + dt.millisecond / 60000;
  let startMin = wallMinute(slotStart);
  if (slotEnd <= slotStart) return { startMin, endMin: startMin };
  const last = slotEnd.minus({ milliseconds: 1 });
  let endMin = wallMinute(last) + 1 / 60000;
  // Same-date intervals can cross one zone transition. Longer intervals already
  // overrun day-bounded hours; their date-aware end is sufficient to reject.
  if (slotStart.hasSame(last, 'day') && slotStart.offset !== last.offset) {
    let low = slotStart.toMillis();
    let high = last.toMillis();
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (DateTime.fromMillis(mid, { zone: slotStart.zone }).offset === slotStart.offset) low = mid;
      else high = mid;
    }
    const before = DateTime.fromMillis(low, { zone: slotStart.zone });
    const after = DateTime.fromMillis(high, { zone: slotStart.zone });
    startMin = Math.min(startMin, wallMinute(after));
    endMin = Math.max(endMin, wallMinute(before) + 1 / 60000);
  }
  // Millisecond-precision input, without floating-point boundary noise.
  return { startMin: Math.round(startMin * 60000) / 60000, endMin: Math.round(endMin * 60000) / 60000 };
}

export interface OwnerWorkSegment {
  start: DateTime;
  end: DateTime;
  effectiveDay: EffectiveWorkDay;
  fitsWorkHours: boolean;
}

/** Materialize configured wall-clock membership, not a chosen clock occurrence.
 * Both fall-back occurrences count; spring-forward minutes simply do not exist.
 * Ordinary days use one constant-offset range. Only transition days need a
 * binary search for the offset boundary (the same one-change/day assumption
 * used by slotDayMinutes), never a minute-by-minute scan of the timer horizon. */
export function configuredWorkIntervalsBetween(
  from: DateTime, until: DateTime, timezone: string, windows: WorkHourRange[],
): Array<{ start: DateTime; end: DateTime }> {
  const intervals: Array<{ start: DateTime; end: DateTime }> = [];
  if (!from.isValid || !until.isValid || until <= from) return intervals;
  for (let day = from.setZone(timezone).startOf('day'); day < until; day = day.plus({ days: 1 }).startOf('day')) {
    const next = day.plus({ days: 1 }).startOf('day');
    const cuts = [day.toMillis(), next.toMillis()];
    if (day.offset !== next.minus({ milliseconds: 1 }).offset) {
      let low = cuts[0], high = cuts[1] - 1;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (DateTime.fromMillis(mid, { zone: timezone }).offset === day.offset) low = mid;
        else high = mid;
      }
      cuts.splice(1, 0, high);
    }
    const wallMidnight = DateTime.utc(day.year, day.month, day.day).toMillis();
    for (let i = 0; i < cuts.length - 1; i++) {
      const offsetMs = DateTime.fromMillis(cuts[i], { zone: timezone }).offset * 60000;
      for (const window of windows) {
        const start = Math.max(from.toMillis(), cuts[i], wallMidnight + window.startMin * 60000 - offsetMs);
        const end = Math.min(until.toMillis(), cuts[i + 1], wallMidnight + window.endMin * 60000 - offsetMs);
        if (end > start) intervals.push({ start: DateTime.fromMillis(start, { zone: timezone }), end: DateTime.fromMillis(end, { zone: timezone }) });
      }
    }
  }
  return intervals.sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

/** Partition an explicit interval wherever a dated schedule can change authority.
 * Home-date overrides and every candidate trip-date midnight are boundaries;
 * checking just the endpoints misses an intervening off day. Window membership
 * uses visited wall clocks, so this does not choose a bare DST clock occurrence.
 */
export function ownerWorkSegmentsBetween(from: DateTime, until: DateTime, profile: UserProfile): OwnerWorkSegment[] {
  if (!from.isValid || !until.isValid || until <= from) return [];
  const homeTz = profile.user.timezone;
  const boundaries = new Set<number>([from.toMillis(), until.toMillis()]);
  const lastDate = until.setZone(homeTz).startOf('day').plus({ days: 2 });
  for (let date = from.setZone(homeTz).startOf('day').minus({ days: 2 }); date <= lastDate; date = date.plus({ days: 1 })) {
    const eff = getEffectiveWorkDay(date.toISODate()!, profile);
    const localDay = DateTime.fromISO(date.toISODate()!, { zone: eff.timezone });
    for (const boundary of [date, localDay, localDay.plus({ days: 1 })]) {
      if (boundary > from && boundary < until) boundaries.add(boundary.toMillis());
    }
  }
  const cuts = [...boundaries].sort((a, b) => a - b);
  return cuts.slice(0, -1).map((ms, i) => {
    const start = DateTime.fromMillis(ms, { zone: homeTz });
    const end = DateTime.fromMillis(cuts[i + 1], { zone: homeTz });
    const effectiveDay = getEffectiveWorkDayForInstant(start.toISO()!, profile);
    const { startMin, endMin } = slotDayMinutes(start.setZone(effectiveDay.timezone), end.setZone(effectiveDay.timezone));
    const fitsWorkHours = effectiveDay.isWorkday
      && effectiveDay.windows.some(w => startMin >= w.startMin && endMin <= w.endMin);
    return { start, end, effectiveDay, fitsWorkHours };
  });
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
  // Contact timing and booking resolve the SAME trip day, including a trip
  // afternoon that has already crossed midnight in the owner's home zone.
  const eff = getEffectiveWorkDayForInstant(now.toISO()!, profile);
  if (!eff.isWorkday || eff.windows.length === 0) return false;
  const local = now.setZone(eff.timezone);
  const minutes = local.hour * 60 + local.minute;
  for (const w of eff.windows) {
    if (minutes >= w.startMin && minutes < w.endMin) return true;
  }
  return false;
}

/** Actual work intervals in an instant range. Window clocks belong to their
 * effective trip date, while explicit home-date overrides retain the same
 * precedence as booking's getEffectiveWorkDayForInstant. */
export function ownerWorkIntervalsBetween(
  from: DateTime,
  until: DateTime,
  profile: UserProfile,
): Array<{ start: DateTime; end: DateTime }> {
  const intervals: Array<{ start: DateTime; end: DateTime }> = [];
  for (const segment of ownerWorkSegmentsBetween(from, until, profile)) {
    const eff = segment.effectiveDay;
    if (!eff.isWorkday) continue;
    intervals.push(...configuredWorkIntervalsBetween(segment.start, segment.end, eff.timezone, eff.windows));
  }
  return intervals.sort((a, b) => a.start.toMillis() - b.start.toMillis());
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

  let cursor = DateTime.fromISO(fromIso, { zone: profile.user.timezone });
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
 * v2.1.4 + v3.2.6 — default date window for the daily calendar health check.
 *
 * Rule (v3.2.6, owner direction): start = today (local); end = the Saturday
 * that ends NEXT week (Sun–Sat weeks). So on a Sunday it's a full 14 days
 * (Sun → Sat-after); on a Thursday it's Thu → Sat-after. Bounded and short
 * enough that the daily report stops re-narrating conflicts weeks out (the old
 * v2.1.4 "last workday + <=24h → extend 7d" rule and the earlier 21-day sweep
 * both over-surfaced).
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
 * Selects the earliest future window INSTANT across adjacent trip dates and
 * the next 14 home dates. Date order is not instant order across timezones.
 */
export function nextOwnerWorkdayStart(profile: UserProfile): string {
  const homeTz = profile.user.timezone;
  const cursor = DateTime.now().setZone(homeTz);
  const intervals = ownerWorkIntervalsBetween(cursor, cursor.startOf('day').plus({ days: 14 }), profile);
  if (intervals.length > 0) return intervals[0].start.toUTC().toISO()!;
  return cursor.plus({ hours: 8 }).toUTC().toISO()!;
}
