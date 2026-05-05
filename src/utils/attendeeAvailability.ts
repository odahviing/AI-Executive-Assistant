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
): AttendeeAvailabilityEntry[] | undefined {
  if (!emails || emails.length === 0) return undefined;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { searchPeopleMemory, getCurrentTravel } = require('../db') as typeof import('../db');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getEffectiveWorkingHours } = require('./workingHoursDefault') as
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
      if (!person?.timezone) continue;
      const wh = getEffectiveWorkingHours(person);
      if (!wh) continue;

      let timezone = person.timezone;
      let travelMeta: AttendeeAvailabilityEntry['travel'];
      const travel = getCurrentTravel(person.slack_id);
      if (travel) {
        const travelTz = inferTimezoneFromStateStatic(travel.location);
        if (travelTz && travelTz !== person.timezone) {
          travelMeta = {
            location: travel.location,
            homeTimezone: person.timezone,
            until: travel.until,
          };
          timezone = travelTz;
        } else if (!travelTz) {
          logger.info('attendeeAvailability — travel location not in static TZ map, using stored', {
            email, location: travel.location,
          });
        }
      }

      built.push({
        email,
        timezone,
        workdays: wh.workdays,
        hoursStart: wh.hoursStart,
        hoursEnd: wh.hoursEnd,
        ...(travelMeta ? { travel: travelMeta } : {}),
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
