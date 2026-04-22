/**
 * Meeting protection (v2.1.1).
 *
 * Deterministic "can Maelle move this meeting autonomously?" check. Used by
 * the active-mode calendar-health flow so the model never has to judge it.
 *
 * A meeting is PROTECTED if ANY of these is true:
 *
 *   1. ≥ 4 effective attendees (organizer + ≥ 3 non-declined invitees). Small
 *      meetings are cheap to reshuffle; group meetings create too much
 *      coordination cost to move without the owner's say.
 *   2. Has at least one external attendee (any email whose domain ≠ owner's
 *      company domain derived from profile.user.email). External-facing
 *      meetings are never touched in active mode.
 *   3. Subject matches an entry in `profile.meetings.protected[].name`
 *      (existing behavior — substring, case-insensitive).
 *   4. Any of the event's Outlook categories matches an entry in
 *      `profile.meetings.protected[].category` (v2.1.1 additive — lets the
 *      owner mark a whole category as protected without naming every event).
 *
 * All others are movable. The owner can always force a move manually — this
 * is only about what Maelle does on her own.
 */

import type { UserProfile } from '../config/userProfile';
import type { CalendarEvent } from '../connectors/graph/calendar';
import { countEffectiveAttendees, isInternalOnly } from './attendeeScope';

export interface ProtectionVerdict {
  protected: boolean;
  reasons: string[];  // human-readable reasons; empty when not protected
}

export function isProtected(event: CalendarEvent, profile: UserProfile): ProtectionVerdict {
  const reasons: string[] = [];

  // Rule 1 — 4+ effective attendees
  const attendeeCount = countEffectiveAttendees(event);
  if (attendeeCount >= 4) {
    reasons.push(`${attendeeCount} attendees`);
  }

  // Rule 2 — external attendee
  if (!isInternalOnly(event, profile)) {
    reasons.push('has external attendee');
  }

  // Rule 3 — subject match against profile.meetings.protected[].name
  const subject = (event.subject ?? '').toLowerCase();
  const categoriesOnEvent = Array.isArray((event as unknown as { categories?: unknown }).categories)
    ? ((event as unknown as { categories: string[] }).categories)
    : [];
  for (const entry of profile.meetings.protected ?? []) {
    const name = (entry as { name?: string }).name;
    if (name && subject.includes(name.toLowerCase())) {
      reasons.push(`matches protected name "${name}"`);
    }
    // Rule 4 — category match (new in v2.1.1; forward-compat — owner can add
    // `{category: "Protected", rule: "never_move"}` to yaml when he creates
    // the Outlook category).
    const cat = (entry as { category?: string }).category;
    if (cat && categoriesOnEvent.includes(cat)) {
      reasons.push(`matches protected category "${cat}"`);
    }
  }

  return { protected: reasons.length > 0, reasons };
}

/**
 * Given two overlapping events, return the one Maelle may move autonomously
 * (the "movable side"), or null if both are protected. Ties go to the later
 * start time (newer meeting yields to older — arbitrary but stable).
 */
export function pickMovableSide(
  a: CalendarEvent,
  b: CalendarEvent,
  profile: UserProfile,
): { movable: CalendarEvent; kept: CalendarEvent } | null {
  const aProt = isProtected(a, profile);
  const bProt = isProtected(b, profile);

  if (!aProt.protected && bProt.protected) return { movable: a, kept: b };
  if (aProt.protected && !bProt.protected) return { movable: b, kept: a };
  if (!aProt.protected && !bProt.protected) {
    // Both movable — keep the earlier, move the later (stable tiebreaker)
    const aStart = a.start.dateTime;
    const bStart = b.start.dateTime;
    return aStart <= bStart ? { movable: b, kept: a } : { movable: a, kept: b };
  }
  return null;  // both protected — owner decides
}
