/**
 * Shared helper for auto-loading attendee work-hour availability from
 * people_memory. Used by both `find_available_slots` and `coordinate_meeting`
 * paths so attendee TZ + work hours clip slots consistently regardless of
 * which entry point Sonnet picked.
 *
 * SCOPE: TIMEZONE + WORK HOURS ONLY. This helper does NOT touch busy/free
 * data — that's an annotation/overlay concern handled separately by
 * `attendeeBusyEmails` (busy-time pre-filter for mixed coords) and
 * `annotateSlotsWithAttendeeStatus` (per-slot per-attendee status tags).
 * The work-hour clip is the only HARD filter on slot proposals from this
 * helper's data; busy time is intentionally not a hard filter — Sonnet
 * sees busy slots with annotation and decides whether to propose them.
 *
 * Returns undefined when no attendee in the list has structured availability
 * data — back-compat with the no-clip path that existed before v2.3.3.
 */

import logger from './logger';
import type { WeekDay } from './floatingBlocks';

export interface AttendeeAvailabilityEntry {
  email: string;
  timezone: string;
  workdays: WeekDay[];
  hoursStart: string;
  hoursEnd: string;
  // v2.5.2 — when active travel overrode the stored profile timezone for this
  // entry, this carries the original stored timezone + travel location so the
  // caller can render dual-TZ ("15:00 Boston / 22:00 Idan") on slot proposals
  // and surface "Yael is in Boston this week" honestly to the owner.
  // Undefined when the attendee is not traveling — the timezone field above
  // is the only one that matters in that case.
  travel?: {
    location: string;       // free text, e.g. "Boston"
    homeTimezone: string;   // stored profile timezone, e.g. "Asia/Jerusalem"
    until: string;          // ISO yyyy-MM-dd
  };
  /** v3.3.8 — stored profile timezone, always set when known. Per-day TZ
   * resolution (attendeeTzForDay) derives from THIS + travelWindow, never
   * from the now-collapsed `timezone` field above. */
  homeTimezone?: string;
  /**
   * v3.3.8 — the travel record as a DATED window (covers future trips too).
   * The work-hours clip and per-slot local display resolve the attendee's
   * timezone PER SEARCHED DAY: inside [from, until] → this timezone, outside
   * → homeTimezone. Fixes both directions of the now-collapse bug: a future
   * trip ("back in Israel on Tuesday") was invisible when searching Tuesday,
   * and a current trip ending Friday wrongly clipped next week's search.
   */
  travelWindow?: {
    from: string;        // ISO yyyy-MM-dd (inclusive)
    until: string;       // ISO yyyy-MM-dd (inclusive)
    timezone: string;    // IANA of the travel location
    location: string;
  };
  /**
   * True when this entry has NO stored people_memory timezone and was built
   * from `fallbackTimezone` + `defaultWorkingHoursForTz` (#M3) — a GUESS, not
   * data the attendee or owner ever stated. Callers that narrate this entry's
   * hours to the model (e.g. the day_summary grounding note) must say
   * "assumed", never "stated", when this is true — otherwise a guess reads as
   * a fact. Cleared back to false by a conversational owner override
   * (attendee_hours in find_available_slots), which IS a real statement.
   */
  assumed?: boolean;
}

/**
 * v3.3.8 — the attendee's effective IANA timezone on a specific calendar day.
 * `isoDate` is yyyy-MM-dd (the slot walker's owner-TZ day — travel dates are
 * calendar-level facts, sub-day boundary effects are noise).
 */
export function attendeeTzForDay(
  entry: Pick<AttendeeAvailabilityEntry, 'timezone' | 'homeTimezone' | 'travelWindow'>,
  isoDate: string,
): string {
  const tw = entry.travelWindow;
  if (tw && isoDate >= tw.from && isoDate <= tw.until) return tw.timezone;
  return entry.homeTimezone ?? entry.timezone;
}

/**
 * Build an AttendeeAvailability list from people_memory for the given emails.
 *
 * v2.5.2 — when an attendee has an active travel record (`getCurrentTravel`
 * returns non-null), the entry's `timezone` becomes the travel location's
 * timezone (resolved via `inferTimezoneFromStateStatic`) instead of the
 * stored profile timezone. The original stored timezone is preserved on
 * `entry.travel.homeTimezone` so callers can render dual-TZ slot lines.
 * Static-map lookup only — async Sonnet fallback would block slot search.
 * If the location can't be resolved statically, we fall back to the stored
 * timezone (no travel override) and log so it surfaces in diagnostics.
 *
 * @param emails       Attendee email addresses to look up. The owner's own
 *                     email (if present) is filtered out — owner availability
 *                     comes from the profile, not from people_memory.
 * @param ownerEmail   Owner email — used to filter the owner out of the list.
 * @returns            List of work-hour entries (one per attendee with known
 *                     timezone), or undefined if none. Use the result as the
 *                     `attendeeAvailability` arg to `findAvailableSlots`.
 */
export function loadAttendeeAvailabilityForEmails(
  emails: string[],
  ownerEmail: string,
  fallbackTimezone?: string,   // #M3 — no-TZ attendee is assumed in this zone (owner/requester frame)
): AttendeeAvailabilityEntry[] | undefined {
  if (!emails || emails.length === 0) return undefined;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { searchPeopleMemory, getTravelRecord } = require('../db') as typeof import('../db');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getEffectiveWorkingHours, defaultWorkingHoursForTz } = require('./workingHoursDefault') as
      typeof import('./workingHoursDefault');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { inferTimezoneFromStateStatic } = require('./locationTz') as
      typeof import('./locationTz');

    const ownerLower = ownerEmail.toLowerCase();
    const built: AttendeeAvailabilityEntry[] = [];
    for (const email of emails) {
      const lower = email.toLowerCase();
      if (lower === ownerLower) continue;
      const matches = searchPeopleMemory(email);
      const person = matches.find(m => (m.email ?? '').toLowerCase() === lower);
      // #M3 (2026-07-23 owner direction) — an attendee with no stored timezone is
      // ASSUMED to be in the requester's frame (fallbackTimezone = owner's TZ) with
      // standard hours, instead of being SKIPPED (which left them unclipped so the
      // search could offer owner-morning to a would-be-remote person). A human-stated
      // TZ/time still overrides via search_window_timezone. When fallbackTimezone is
      // omitted (other callers) → unchanged: skip the no-TZ attendee.
      const resolvedTz = person?.timezone ?? fallbackTimezone;
      if (!resolvedTz) continue;
      const wh = person?.timezone ? getEffectiveWorkingHours(person) : defaultWorkingHoursForTz(resolvedTz);
      if (!wh) continue;

      let timezone = resolvedTz;
      let travelMeta: AttendeeAvailabilityEntry['travel'];
      let travelWindow: AttendeeAvailabilityEntry['travelWindow'];
      // v3.3.8 — travel applies only to a KNOWN person with a stored TZ (an
      // assumed-frame attendee has no travel record). Raw record includes FUTURE
      // trips; the dated window drives per-day resolution.
      if (person?.timezone) {
        const travel = person.slack_id ? getTravelRecord(person.slack_id) : null;
        if (travel) {
          const travelTz = inferTimezoneFromStateStatic(travel.location);
          if (travelTz && travelTz !== person.timezone) {
            travelWindow = {
              from: travel.from,
              until: travel.until,
              timezone: travelTz,
              location: travel.location,
            };
            const today = new Date().toISOString().slice(0, 10);
            const activeToday = travel.from <= today;  // until >= today guaranteed by getTravelRecord
            if (activeToday) {
              travelMeta = {
                location: travel.location,
                homeTimezone: person.timezone,
                until: travel.until,
              };
              timezone = travelTz;
            }
          } else if (!travelTz) {
            logger.info('attendeeAvailability — travel location not in static TZ map, using stored', {
              email, location: travel.location,
            });
          }
        }
      }

      built.push({
        email,
        timezone,
        workdays: wh.workdays,
        hoursStart: wh.hoursStart,
        hoursEnd: wh.hoursEnd,
        homeTimezone: resolvedTz,
        ...(travelMeta ? { travel: travelMeta } : {}),
        ...(travelWindow ? { travelWindow } : {}),
        // #M3 — no stored person.timezone means resolvedTz came from the
        // fallback (requester's frame) and wh came from the generic zone
        // default, not this attendee's own profile. A GUESS, flag it.
        ...(person?.timezone ? {} : { assumed: true }),
      });
    }

    if (built.length === 0) return undefined;
    logger.info('attendeeAvailability — auto-loaded', {
      attendees: built.map(b => {
        const tag = b.travel ? `${b.email}(${b.timezone} via ${b.travel.location} until ${b.travel.until}, was ${b.travel.homeTimezone}, ${b.hoursStart}-${b.hoursEnd})` :
                                `${b.email}(${b.timezone}, ${b.hoursStart}-${b.hoursEnd})`;
        return tag;
      }),
    });
    return built;
  } catch (err) {
    logger.warn('attendeeAvailability auto-load threw, proceeding without', {
      err: String(err).slice(0, 200),
    });
    return undefined;
  }
}

/**
 * The full attendee-check param bundle for `findAvailableSlots`, in ONE call.
 *
 * The finder only checks attendees when BOTH `attendeeBusyEmails` (busy
 * subtraction) AND `attendeeAvailability` (work-hours/tz clip) are passed —
 * `attendeeEmails` alone is a no-op. Callers that wanted real attendee-aware
 * scheduling used to hand-build both at the call site; forget the availability
 * half and you silently get an owner-only check (the #133 auto-move bug class).
 * Bundling them means callers pass the attendee list ONCE and can't desync.
 *
 * `emails` is the attendee-only list — the owner is filtered out of the
 * availability lookup internally and never belongs in the busy pool. Spread the
 * result into the `findAvailableSlots` params: `{ ...base, ...attendeeCheckParams(emails, owner) }`.
 */
export function attendeeCheckParams(
  emails: string[],
  ownerEmail: string,
  fallbackTimezone?: string,   // #M3 — no-TZ attendees assumed in this zone (owner frame)
): { attendeeBusyEmails: string[]; attendeeAvailability?: AttendeeAvailabilityEntry[] } {
  const availability = loadAttendeeAvailabilityForEmails(emails, ownerEmail, fallbackTimezone);
  return { attendeeBusyEmails: emails, ...(availability ? { attendeeAvailability: availability } : {}) };
}
