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
}

/**
 * Build an AttendeeAvailability list from people_memory for the given emails.
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
    const { searchPeopleMemory } = require('../db') as typeof import('../db');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getEffectiveWorkingHours } = require('./workingHoursDefault') as
      typeof import('./workingHoursDefault');

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
      built.push({
        email,
        timezone: person.timezone,
        workdays: wh.workdays,
        hoursStart: wh.hoursStart,
        hoursEnd: wh.hoursEnd,
      });
    }

    if (built.length === 0) return undefined;
    logger.info('attendeeAvailability — auto-loaded', {
      attendees: built.map(b => `${b.email}(${b.timezone}, ${b.hoursStart}-${b.hoursEnd})`),
    });
    return built;
  } catch (err) {
    logger.warn('attendeeAvailability auto-load threw, proceeding without', {
      err: String(err).slice(0, 200),
    });
    return undefined;
  }
}
