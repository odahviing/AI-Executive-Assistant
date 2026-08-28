/**
 * Cost-free (no LLM), language-neutral date/time extraction (G8/G10 — structural
 * signals, digits and separators, never a language word). One canonical
 * definition (G9), split out of `availabilityPreCheck.ts` (o#260) so a second
 * consumer — `availabilityGate.ts`'s blocked-slot detector — can confirm a
 * quoted span actually names a specific date+time without hand-copying the
 * regex and drifting out of sync with the original the way `humanGate` and
 * `securityGate` once did over what counted as a leak.
 */

import { DateTime } from 'luxon';

// Time pattern — HH:MM (24-hour, with optional leading zero).
export const TIME_PATTERN = /\b(\d{1,2}):(\d{2})\b/g;

// Date pattern — two 1-2 digit components + optional year. Day/month ORDER is
// resolved in extractDates (value-based, then locale tiebreaker) — the regex
// itself is order-agnostic. The hours/minutes pattern collides with the d/m
// pair if the year is missing — guarded by the month<=12 check downstream.
export const DATE_PATTERN = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g;

export interface TimeMatch { hour: number; minute: number; index: number }
export interface DateMatch { date: string; index: number }

export function extractTimes(text: string): TimeMatch[] {
  const out: TimeMatch[] = [];
  for (const m of text.matchAll(TIME_PATTERN)) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) continue;
    out.push({ hour: h, minute: min, index: m.index ?? 0 });
  }
  return out;
}

export function extractDates(text: string, tz: string, monthFirst: boolean): DateMatch[] {
  const out: DateMatch[] = [];
  for (const m of text.matchAll(DATE_PATTERN)) {
    // Don't hardcode DD/MM (Israeli/EU). Disambiguate by value first (a
    // component >12 can't be a month), then fall back to the locale order for
    // the genuinely ambiguous case (e.g. "6/2" = June 2 month-first, 6 Feb
    // day-first).
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    let d: number, mo: number;
    if (a > 12 && b <= 12) { d = a; mo = b; }
    else if (b > 12 && a <= 12) { d = b; mo = a; }
    else if (monthFirst) { mo = a; d = b; }
    else { d = a; mo = b; }
    if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    let year: number;
    if (m[3]) {
      const y = parseInt(m[3], 10);
      year = y < 100 ? 2000 + y : y;
    } else {
      // No year — assume current year, but if the date is more than ~2 weeks
      // in the past relative to today, roll to next year (e.g. December
      // referencing January).
      const now = DateTime.now().setZone(tz);
      const candidate = DateTime.fromObject({ year: now.year, month: mo, day: d }, { zone: tz });
      year = candidate.isValid && candidate.diff(now.minus({ days: 14 })).milliseconds < 0
        ? now.year + 1
        : now.year;
    }
    const dt = DateTime.fromObject({ year, month: mo, day: d }, { zone: tz });
    if (!dt.isValid) continue;
    out.push({ date: dt.toFormat('yyyy-MM-dd'), index: m.index ?? 0 });
  }
  return out;
}
