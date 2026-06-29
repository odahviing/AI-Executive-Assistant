/**
 * Working Elsewhere mode (v3.3) — see .claude/WORKING_ELSEWHERE_MODE.md.
 *
 * When the owner marks days with Outlook's "Working Elsewhere" status, his
 * normal scheduling rules (office/home day shape, work hours, free-time floor)
 * are unreliable — he's in a different place and timezone. On those days:
 *   - busy/free is still TRUE (real meetings are absolute time) → respected
 *   - the rule layer is SUSPENDED
 *   - availability is computed in the AWAY timezone (derived from the marker's
 *     location), tagged tentative, and bookings route to approval
 *
 * SAFETY INVARIANT: every consumer gates on `detectWorkingElsewhereDays`
 * returning a non-empty map. With no all-day workingElsewhere marker, none of
 * this code path executes and behavior is identical to pre-v3.3.
 *
 * Scope: ALL-DAY workingElsewhere events only (the travel-day marker). Timed
 * workingElsewhere events keep their existing (busy) behavior — untouched.
 */

import { DateTime } from 'luxon';
import type { CalendarEvent } from '../connectors/graph/calendar';
import type { UserProfile } from '../config/userProfile';
import { inferTimezoneFromState } from './locationTz';
import logger from './logger';

export interface WorkingElsewhereDay {
  date: string;            // yyyy-MM-dd in owner TZ
  location: string;        // marker location.displayName, '' if none
}

/**
 * Build the set of owner-local dates covered by an ALL-DAY workingElsewhere
 * marker. Returns an empty map when there's no such marker (the common case)
 * — callers MUST treat empty as "WE mode off, behave normally."
 */
export function detectWorkingElsewhereDays(
  ownerEvents: CalendarEvent[],
  ownerTz: string,
): Map<string, WorkingElsewhereDay> {
  const out = new Map<string, WorkingElsewhereDay>();
  for (const evt of ownerEvents) {
    if (!evt.isAllDay || evt.isCancelled) continue;
    if (evt.showAs !== 'workingElsewhere') continue;
    const location = (evt.location?.displayName ?? '').trim();
    // All-day Graph events: start = midnight of first day, end = midnight of
    // the day AFTER the last covered day (exclusive). Iterate [start, end).
    const startDt = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' }).setZone(ownerTz).startOf('day');
    const endDt = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' }).setZone(ownerTz).startOf('day');
    if (!startDt.isValid || !endDt.isValid) continue;
    let cur = startDt;
    let guard = 0;
    while (cur < endDt && guard < 60) {
      const iso = cur.toFormat('yyyy-MM-dd');
      // First marker wins per date (a location-bearing one shouldn't be lost).
      if (!out.has(iso) || (location && !out.get(iso)!.location)) {
        out.set(iso, { date: iso, location });
      }
      cur = cur.plus({ days: 1 });
      guard++;
    }
  }
  return out;
}

/**
 * v3.5.x (WE spine) — the SEARCH's owner-away-day map, DUAL-SOURCE so it matches
 * the write path. `detectWorkingElsewhereDays` (all-day marker) was the ONLY
 * source `find_available_slots` consulted, while the booking path's
 * `resolveOwnerTravelContextForDate` ALSO honors the
 * `people_memory.currently_traveling` travel record. A trip backed only by the
 * record (no marker) therefore made SEARCH see "home" (offered home-tz slots)
 * while BOOK saw "away" and re-stamped them — the Alliance July-1 day-rollover.
 * This merges both sources, clamped to the search window, keyed by the SAME
 * owner-home-tz date `detectWorkingElsewhereDays` writes (markers win on a tie).
 */
export function detectOwnerAwayDaysInWindow(
  ownerEvents: CalendarEvent[],
  ownerTz: string,
  ownerSlackId: string,
  fromIso: string,
  toIso: string,
): Map<string, WorkingElsewhereDay> {
  const out = detectWorkingElsewhereDays(ownerEvents, ownerTz);   // markers first — they win
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getTravelRecord } = require('../db/people') as typeof import('../db/people');
    const rec = getTravelRecord(ownerSlackId);
    if (rec && rec.location) {
      const from = DateTime.fromISO(fromIso, { zone: ownerTz }).startOf('day');
      const to = DateTime.fromISO(toIso, { zone: ownerTz }).startOf('day');
      if (from.isValid && to.isValid) {
        let cur = from;
        let guard = 0;
        while (cur <= to && guard < 366) {
          const iso = cur.toFormat('yyyy-MM-dd');
          // Add a record-covered day only when no marker already claimed it.
          if (iso >= rec.from && iso <= rec.until && !out.has(iso)) {
            out.set(iso, { date: iso, location: rec.location });
          }
          cur = cur.plus({ days: 1 });
          guard++;
        }
      }
    }
  } catch (err) {
    logger.warn('detectOwnerAwayDaysInWindow — travel record merge threw', { err: String(err).slice(0, 160) });
  }
  return out;
}

/**
 * v3.4.2 — THE single "where is the owner, and in what timezone, on date D?"
 * resolver for the booking WRITE path (create_meeting / move_meeting). The slot
 * finder already resolves per-day travel TZ; this gives the write tools the same
 * awareness so a bare trip-time ("10am" during a Boston week) stores as Boston,
 * and an onsite trip meeting stamps the trip location instead of a home-TZ
 * Huddle. ONE source, fed to the timezone + location + display consumers.
 *
 * `isAway=false` (no WE marker, no covering travel record) → effectiveTz is the
 * home TZ and location is '' → every consumer is a no-op (the WE invariant:
 * no marker = byte-identical behavior).
 *
 * Reuses the owner's already-fetched events (zero extra Graph call when the
 * caller passes the events it loaded for the rule check). When the WE marker's
 * location can't be resolved to a TZ, returns isAway=true with effectiveTz=home
 * (so time math is a safe no-op) but the location still surfaces for the stamp.
 */
export interface OwnerTravelContext {
  isAway: boolean;
  effectiveTz: string;   // trip TZ when away + resolvable, else the owner home TZ
  location: string;      // trip location when away, else ''
}

export async function resolveOwnerTravelContextForDate(
  dayIso: string,                  // yyyy-MM-dd in the owner's home TZ
  ownerSlackId: string,
  homeTz: string,
  ownerEvents: CalendarEvent[],
): Promise<OwnerTravelContext> {
  // 1. All-day WE marker for the day — the owner's actual travel mechanism.
  try {
    const day = detectWorkingElsewhereDays(ownerEvents, homeTz).get(dayIso);
    if (day) {
      const tz = day.location ? await resolveWorkingElsewhereTz(day.location) : null;
      return { isAway: true, effectiveTz: tz ?? homeTz, location: day.location };
    }
  } catch (err) {
    logger.warn('resolveOwnerTravelContextForDate — WE detect threw', { err: String(err).slice(0, 160) });
  }
  // 2. Travel record fallback (future-inclusive DB read, cheap).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getTravelRecord } = require('../db/people') as typeof import('../db/people');
    const rec = getTravelRecord(ownerSlackId);
    if (rec && dayIso >= rec.from && dayIso <= rec.until) {
      const tz = await resolveWorkingElsewhereTz(rec.location);
      return { isAway: true, effectiveTz: tz ?? homeTz, location: rec.location };
    }
  } catch (err) {
    logger.warn('resolveOwnerTravelContextForDate — travel record lookup threw', { err: String(err).slice(0, 160) });
  }
  // 3. Home — no conversion, no trip location.
  return { isAway: false, effectiveTz: homeTz, location: '' };
}

/**
 * v3.4.2 — convenience wrapper: travel context for the DAY of an instant,
 * fetching that day's events itself. This is the ONE place the create / move /
 * update_meeting handlers call (they don't have the day's events in hand). The
 * availabilityPreCheck path reuses `resolveOwnerTravelContextForDate` directly
 * with the week events it already fetched — no extra Graph call there. Fails
 * open to "not away" on any error.
 */
export async function getTravelContextForInstant(
  startIso: string,
  ownerEmail: string,
  ownerSlackId: string,
  homeTz: string,
): Promise<OwnerTravelContext> {
  const dt = DateTime.fromISO(startIso, { zone: homeTz });
  if (!dt.isValid) return { isAway: false, effectiveTz: homeTz, location: '' };
  const dayIso = dt.toFormat('yyyy-MM-dd');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCalendarEvents } = require('../connectors/graph/calendar') as
      typeof import('../connectors/graph/calendar');
    const events = await getCalendarEvents(ownerEmail, dayIso, dayIso, homeTz);
    return resolveOwnerTravelContextForDate(dayIso, ownerSlackId, homeTz, events);
  } catch (err) {
    logger.warn('getTravelContextForInstant — day fetch threw', { err: String(err).slice(0, 160) });
    return { isAway: false, effectiveTz: homeTz, location: '' };
  }
}

// Module-level resolution cache: location string → IANA (or null). Resolution
// happens OFF the slot hot-loop (once per search), so the async static→Sonnet
// resolver is fine. The static map is just a warm-start; a miss costs one
// Sonnet call, never a wrong answer.
const tzCache = new Map<string, string | null>();

/**
 * Resolve a marker's location to an IANA timezone. static fast-path → Sonnet
 * fallback (long tail: "Boston Office", "our NYC hub"). Returns null when the
 * location is empty or genuinely unresolvable — callers MUST then ask the
 * owner, never silently fall back to his home TZ.
 */
export async function resolveWorkingElsewhereTz(location: string): Promise<string | null> {
  const key = location.trim().toLowerCase();
  if (!key) return null;
  if (tzCache.has(key)) return tzCache.get(key)!;
  let iana: string | null = null;
  try {
    iana = await inferTimezoneFromState(location);
  } catch (err) {
    logger.warn('workingElsewhere — tz resolve threw', { location, err: String(err).slice(0, 160) });
    iana = null;
  }
  tzCache.set(key, iana);
  return iana;
}

/**
 * Shared enrichment for calendar-READ tools (get_calendar / analyze_calendar):
 * if the fetched events include all-day Working Elsewhere markers, return a note
 * telling the LLM those days' home-timezone clock is misleading, with the away
 * timezones resolved. Returns null when there's no WE marker (the common case →
 * callers attach nothing, behavior unchanged). Async (resolves away-TZ off any
 * hot loop). This is how WE-awareness reaches list-and-eyeball surfaces, not
 * just the slot finder.
 */
export async function summarizeWorkingElsewhere(
  events: CalendarEvent[],
  ownerTz: string,
  // #WE-spine — pass slackId + window to get the DUAL-SOURCE away-day set
  // (marker + travel record), so the read tools surface a record-backed trip
  // too, not just all-day markers. Omitted → marker-only (back-compat).
  ownerSlackId?: string,
  fromIso?: string,
  toIso?: string,
): Promise<{
  working_elsewhere: { days: Array<{ date: string; away_tz: string | null; location: string }> };
  _working_elsewhere_note: string;
} | null> {
  const weDays = (ownerSlackId && fromIso && toIso)
    ? detectOwnerAwayDaysInWindow(events, ownerTz, ownerSlackId, fromIso, toIso)
    : detectWorkingElsewhereDays(events, ownerTz);
  if (weDays.size === 0) return null;
  const days: Array<{ date: string; away_tz: string | null; location: string }> = [];
  for (const [date, info] of weDays) {
    const away_tz = await resolveWorkingElsewhereTz(info.location);
    days.push({ date, away_tz, location: info.location });
  }
  const locs = [...new Set(days.map(d => d.location).filter(Boolean))].join(', ') || 'another location';
  const note =
    `The owner is WORKING ELSEWHERE on ${days.map(d => d.date).join(', ')} (${locs}). On those days his normal office/home days and work hours DO NOT apply, and his home-timezone clock is MISLEADING — a time that looks like "morning" on this calendar is the middle of his night where he actually is. Do NOT eyeball availability from these event times or call any day "open in the morning." For real openings on those days, call find_available_slots (it returns tentative slots computed in his away timezone). Any booking on those days routes to approval.`;
  return { working_elsewhere: { days }, _working_elsewhere_note: note };
}

/**
 * The resolved Working-Elsewhere offer window for ONE search layer. `days` is
 * the set of weekday long-names to offer at all; the hour/min pairs bound the
 * band inside each offered day (in the trip tz).
 */
export interface WeWindow {
  days: Set<string>;
  startHour: number;
  startMin: number;
  endHour: number;
  endMin: number;
}

/**
 * Resolve the WE offer window for a search. `relaxed` picks the owner-override
 * layer (wider net) vs the regular colleague-facing layer. Values come from
 * `profile.meetings.working_elsewhere`; when that block is absent we fall back
 * to the owner's normal work-week (office ∪ home days) + a neutral business
 * band (09:00-17:00 regular / 08:00-20:00 relaxed) so an unconfigured tenant
 * still behaves sanely. The owner's own values live in YAML, never hardcoded.
 */
export function getWeWindow(profile: UserProfile, relaxed: boolean): WeWindow {
  const cfg = profile.meetings.working_elsewhere?.[relaxed ? 'relaxed' : 'regular'];
  const days = (cfg?.days && cfg.days.length > 0)
    ? cfg.days
    : [...new Set<string>([
        ...(profile.schedule.office_days.days as string[]),
        ...(profile.schedule.home_days.days as string[]),
      ])];
  const hours = cfg?.hours ?? (relaxed ? '08:00-20:00' : '09:00-17:00');
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(hours);
  const [sh, sm, eh, em] = m
    ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    : (relaxed ? [8, 0, 20, 0] : [9, 0, 17, 0]);
  return { days: new Set(days), startHour: sh, startMin: sm, endHour: eh, endMin: em };
}

export interface TentativeSlot {
  start: string;                         // owner-TZ ISO (absolute instant; same as the rest of the array)
  end: string;
  day_type?: 'office' | 'home' | 'other';
  tentative_working_elsewhere: true;
  away_tz: string;                       // IANA of where he actually is
  away_location: string;                 // human label for narration ("Boston Office")
}

/**
 * Compute tentative availability for ONE working-elsewhere day, in the away
 * timezone. Busy-aware (absolute time), no soft-rule layer. Walks a generous
 * daytime band [dayStartHour, dayEndHour) in the away TZ so we never offer the
 * owner the middle of his actual night (the "8am Israel = 1am Boston" bug).
 */
export function computeTentativeWeSlots(params: {
  date: string;                          // yyyy-MM-dd (owner TZ)
  awayTz: string;
  awayLocation: string;
  ownerTz: string;
  durationMinutes: number;
  allBusy: Array<{ start: Date; end: Date }>;
  earliestAllowedMs: number;
  dayStartHour?: number;                 // away-TZ band start hour (default 08)
  dayStartMin?: number;                  // away-TZ band start minute (default 00)
  dayEndHour?: number;                   // away-TZ band end hour (default 20)
  dayEndMin?: number;                    // away-TZ band end minute (default 00)
}): TentativeSlot[] {
  const startHour = params.dayStartHour ?? 8;
  const startMin = params.dayStartMin ?? 0;
  const endHour = params.dayEndHour ?? 20;
  const endMin = params.dayEndMin ?? 0;
  const stepMs = 15 * 60 * 1000;
  const durMs = params.durationMinutes * 60 * 1000;

  // Anchor the band on the OWNER-local calendar date, but in the AWAY zone:
  // the day the colleague/owner is asking about, rendered in the traveler's
  // local clock. Use the owner-local date as the anchor day in the away TZ.
  const bandStart = DateTime.fromISO(`${params.date}T00:00:00`, { zone: params.awayTz }).set({ hour: startHour, minute: startMin });
  const bandEnd = DateTime.fromISO(`${params.date}T00:00:00`, { zone: params.awayTz }).set({ hour: endHour, minute: endMin });
  if (!bandStart.isValid || !bandEnd.isValid) return [];

  const collected: TentativeSlot[] = [];
  let cursorMs = bandStart.toMillis();
  const lastStartMs = bandEnd.toMillis() - durMs;
  while (cursorMs <= lastStartMs) {
    const slotEndMs = cursorMs + durMs;
    if (cursorMs < params.earliestAllowedMs) { cursorMs += stepMs; continue; }
    const overlaps = params.allBusy.some(b =>
      cursorMs < b.end.getTime() && slotEndMs > b.start.getTime(),
    );
    if (overlaps) { cursorMs += stepMs; continue; }
    // Emit in owner-TZ ISO (same absolute instant) for array consistency; the
    // away_tz tag drives dual-TZ narration.
    const startOwner = DateTime.fromMillis(cursorMs).setZone(params.ownerTz);
    const endOwner = DateTime.fromMillis(slotEndMs).setZone(params.ownerTz);
    collected.push({
      start: startOwner.toISO()!,
      end: endOwner.toISO()!,
      tentative_working_elsewhere: true,
      away_tz: params.awayTz,
      away_location: params.awayLocation,
    });
    cursorMs += stepMs;
  }

  // Emit the FULL free-slot pool — no per-day cap, no pre-spread. pickSpreadSlots
  // is the single spreader for both paths: the regular walk also emits every
  // valid slot and lets pickSpreadSlots own the round-robin selection. (This
  // previously pre-spread to 4/day, double-spreading with pickSpreadSlots.)
  return collected;
}
