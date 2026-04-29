/**
 * Determine whether a meeting should default to online based on attendee
 * locations vs the owner. Code-level smart-skip — no prompt rule, no regex
 * scan of conversation text. The signal is in people_memory: if any
 * attendee's timezone differs from the owner's, the meeting is remote and
 * Maelle shouldn't ask "online or in-person?".
 *
 * Persisted-state mechanism (v2.2.2 #46): when the owner volunteers location
 * info ("she's in Boston", "Brett works ET"), Sonnet calls
 * update_person_profile with state/timezone. That data lands in
 * people_memory and this helper reads it for every booking.
 *
 * Returns 'online' when at least one attendee is remote-from-owner;
 * 'either' otherwise (ask flow runs as before).
 */

import type { UserProfile } from '../config/userProfile';
import type { PersonMemory } from '../db/people';

export type DefaultMeetingMode = 'online' | 'either';

/**
 * @param attendees Resolved people_memory rows for the meeting attendees.
 *                  Pass an empty array (or skip) to fall back to 'either'.
 * @param profile   Owner profile — used as the timezone anchor.
 */
export function inferDefaultMeetingMode(
  attendees: Array<Pick<PersonMemory, 'timezone' | 'state' | 'currently_traveling'>>,
  profile: UserProfile,
): DefaultMeetingMode {
  if (!attendees || attendees.length === 0) return 'either';
  const ownerTz = profile.user.timezone;
  if (!ownerTz) return 'either';

  const today = new Date().toISOString().split('T')[0];
  const anyRemote = attendees.some(att => {
    // Active travel overrides stored timezone for the window.
    let effectiveTz = att.timezone;
    if (att.currently_traveling) {
      try {
        const t = JSON.parse(att.currently_traveling) as { from?: string; until?: string; location?: string };
        if (t.until && t.until >= today && t.from && t.from <= today) {
          // Don't have travel→tz here without locationTz lookup; skip
          // override unless the attendee's stored tz is already different.
        }
      } catch (_) { /* ignore malformed travel JSON */ }
    }
    if (!effectiveTz) return false;  // no signal, skip
    return effectiveTz !== ownerTz;
  });

  return anyRemote ? 'online' : 'either';
}
