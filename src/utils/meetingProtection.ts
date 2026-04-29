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
 * Privacy-aware conflict phrasing. When Maelle DMs a colleague asking to
 * move their meeting because of a conflict on the owner's side, she
 * explains what she's conflicting WITH. Default: include the kept meeting's
 * subject ("overlaps with 'Fulcrum Product Sync'"). When the kept meeting
 * is private, she discloses only the fact ("overlaps with another meeting
 * Idan has"). Never leaks the subject/body of a private event to an
 * external attendee.
 *
 * Privacy signals (any one triggers the sanitization):
 *   - sensitivity === 'private' or 'confidential'
 *   - any category on the event has `sets_sensitivity_private: true` in
 *     the owner's yaml (so "what counts as private" lives in the profile,
 *     not in the code).
 */
export function sanitizeConflictReason(
  keptEvent: CalendarEvent,
  ownerFirstName: string,
  profile: UserProfile,
): string {
  const sensitivity = keptEvent.sensitivity;
  const categories = Array.isArray((keptEvent as unknown as { categories?: unknown }).categories)
    ? ((keptEvent as unknown as { categories: string[] }).categories)
    : [];
  const privateCategoryNames = new Set(
    (profile.categories ?? []).filter(c => c.sets_sensitivity_private).map(c => c.name),
  );
  const isPrivate =
    sensitivity === 'private'
    || sensitivity === 'confidential'
    || categories.some(c => privateCategoryNames.has(c));
  if (isPrivate) {
    return `overlaps with another meeting ${ownerFirstName} has`;
  }
  const subject = keptEvent.subject || 'another meeting';
  return `overlaps with "${subject}"`;
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
