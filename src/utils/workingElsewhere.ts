/**
 * Working Elsewhere adapters (v3.3 → v3.7.x / #143).
 *
 * As of #143 the full-day WE "travel spine" is GONE. The owner's away days are
 * now driven by the per-date `owner_schedule_overrides` table (a row with an
 * explicit `timezone` ⇒ away day), resolved through `getEffectiveWorkDay`. These
 * functions are thin ADAPTERS over that one accessor, kept so the display +
 * prompt consumers (weTimeResolver dual-clock, the OWNER LOCATION block, the
 * calendar-read away-note) don't have to change shape:
 *   - getTravelContextForInstant → the ONE "where is the owner, in what tz, on
 *     the day of instant T?" for the display path (SYNC).
 *   - detectOwnerAwayDaysInWindow → the away-day SET over a window (override rows
 *     with a non-home timezone).
 *   - summarizeWorkingElsewhere → the calendar-read away-note.
 * No marker, no `currently_traveling`, no location→IANA inference for the OWNER
 * anymore — the override stores an explicit IANA. `currently_traveling` still
 * drives COLLEAGUE away-detection (attendeeAvailability) — untouched.
 *
 * Scope note — the TIMED (non-all-day) showAs=workingElsewhere event is a
 * DIFFERENT feature (a soft / optional-join standup, v3.6.4): bookable-over as a
 * fallback, handled by the slot finder's soft tier + calendar-health
 * (calendar.ts `softOccupied`), NOT here. #143 does not touch it.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { getEffectiveWorkDayForInstant } from './workHours';
import { listScheduleOverrides } from '../db/scheduleOverrides';
import logger from './logger';

export interface WorkingElsewhereDay {
  date: string;            // yyyy-MM-dd in owner home TZ
  location: string;        // the away IANA timezone (override has no city); '' when unknown
}

/**
 * v3.7.x (#143) — the owner-away-day SET over a window, from the per-date
 * override table: every override row whose explicit `timezone` differs from the
 * owner's home tz is an away day. Same shape (`Map<date,{date,location}>`) the
 * old marker+record detector returned, so the OWNER LOCATION block / calendar-
 * health suppressor don't churn. `location` carries the away IANA (no city is
 * stored). Empty map when the owner has no away override in the window → every
 * consumer no-ops, behavior identical to a normal week.
 */
export function detectOwnerAwayDaysInWindow(
  profile: UserProfile,
  fromIso: string,
  toIso: string,
): Map<string, WorkingElsewhereDay> {
  const out = new Map<string, WorkingElsewhereDay>();
  try {
    const homeTz = profile.user.timezone;
    const rows = listScheduleOverrides(profile.user.slack_user_id, fromIso, toIso);
    for (const r of rows) {
      if (r.timezone && r.timezone !== homeTz) {
        out.set(r.date, { date: r.date, location: r.timezone });
      }
    }
  } catch (err) {
    logger.warn('detectOwnerAwayDaysInWindow — override list threw', { err: String(err).slice(0, 160) });
  }
  return out;
}

/**
 * v3.7.x (#143) — the resolved owner-location context for the DISPLAY path
 * (booked dual-clock, approval preview, stated-time resolution), produced by
 * getTravelContextForInstant. `isAway` is true only when the day has an override
 * with an explicit `timezone` ≠ home; then `effectiveTz` is that IANA, else the
 * owner home TZ → every display consumer is a no-op.
 *
 * `location` is deliberately '' — the override stores no city, and the dual-clock
 * names the tz abbreviation, not a place (naming the lodging read as a venue).
 */
export interface OwnerTravelContext {
  isAway: boolean;
  effectiveTz: string;   // away IANA when away, else the owner home TZ
  location: string;      // always '' post-#143 (kept for the display type's shape)
}

/**
 * v3.7.x (#143) — travel context for the DAY of an instant. Now a pure override
 * read (no Graph fetch): resolve the instant's home-tz calendar date, then that
 * date's override. The create / move / update handlers + the approval preview
 * call this to render the dual-clock. Fails open to "not away".
 */
export function getTravelContextForInstant(
  startIso: string,
  profile: UserProfile,
): OwnerTravelContext {
  const homeTz = profile.user.timezone;
  const dt = DateTime.fromISO(startIso, { zone: homeTz });
  if (!dt.isValid) return { isAway: false, effectiveTz: homeTz, location: '' };
  // v3.7.x (#143) — instant-aware so a far-west away window that crosses home
  // midnight is attributed to the right trip-day; the dual-clock + location
  // follow the slot's actual trip-day, not just the home-tz calendar date.
  try {
    const eff = getEffectiveWorkDayForInstant(startIso, profile);
    if (eff.isAway) return { isAway: true, effectiveTz: eff.timezone, location: '' };
  } catch (err) {
    logger.warn('getTravelContextForInstant — override resolve threw', { err: String(err).slice(0, 160) });
  }
  return { isAway: false, effectiveTz: homeTz, location: '' };
}

/**
 * v3.7.x (#143) — calendar-read away-note for get_calendar / analyze_calendar /
 * get_free_busy. When the window covers an away override day (a row with an
 * explicit non-home tz), return a note telling the model the home-tz clock is
 * misleading there and to lead with the away clock. Null when the window has no
 * away day (the common case → callers attach nothing). SYNC — a per-window
 * override read; the away tz is the override's explicit IANA, no inference.
 */
export function summarizeWorkingElsewhere(
  profile: UserProfile,
  fromIso: string,
  toIso: string,
): {
  working_elsewhere: { days: Array<{ date: string; away_tz: string | null; location: string }> };
  _working_elsewhere_note: string;
} | null {
  const weDays = detectOwnerAwayDaysInWindow(profile, fromIso, toIso);
  if (weDays.size === 0) return null;
  const days: Array<{ date: string; away_tz: string | null; location: string }> = [];
  for (const [date, info] of weDays) {
    days.push({ date, away_tz: info.location || null, location: info.location });
  }
  const zones = [...new Set(days.map(d => d.away_tz).filter(Boolean))].join(', ') || 'another timezone';
  const note =
    `The owner is WORKING ELSEWHERE on ${days.map(d => d.date).join(', ')} (in ${zones}). On those days his home-timezone clock is MISLEADING — a time that looks like "morning" on this calendar can be the middle of his night where he actually is. Do NOT eyeball availability from these event times. For real openings on those days, call find_available_slots — it returns real slots computed in his away timezone, and a booking there goes through normally (no separate approval).`;
  return { working_elsewhere: { days }, _working_elsewhere_note: note };
}
