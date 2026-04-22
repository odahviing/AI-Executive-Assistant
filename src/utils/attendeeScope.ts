/**
 * Attendee-scope helpers (v2.1.1).
 *
 * Deterministic checks for "is this meeting internal-only?" — used by the
 * active-mode calendar-health flow to decide whether Maelle may try to
 * reshuffle a meeting autonomously (internal-only → candidate; any external
 * attendee → never touch).
 *
 * Domain is derived from the owner's email (`profile.user.email`). A meeting
 * is "internal-only" when every attendee email ends in the owner's domain.
 * One attendee whose domain differs (or is empty / unknown) → external →
 * treated as protected by the active-mode flow.
 */

import type { UserProfile } from '../config/userProfile';
import type { CalendarEvent } from '../connectors/graph/calendar';

export function getOwnerDomain(profile: UserProfile): string | null {
  const email = profile.user.email ?? '';
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * True if every attendee's email ends in the owner's domain. Attendees with
 * no email, or declined/cancelled status, are skipped from the domain check
 * (can't classify them — safer to treat missing info as "internal-ok"
 * ONLY when the rest of the attendees ARE internal). If the attendee list
 * is empty or undefined → returns `true` (solo block = internal by default).
 *
 * If the owner's domain can't be derived, returns `false` defensively
 * (everything is treated as external — no auto-move).
 */
export function isInternalOnly(
  event: Pick<CalendarEvent, 'attendees'> | { attendees?: unknown },
  profile: UserProfile,
): boolean {
  const domain = getOwnerDomain(profile);
  if (!domain) return false;

  const attendees = (event.attendees as unknown[] | undefined) ?? [];
  if (attendees.length === 0) return true;

  for (const a of attendees) {
    const rec = a as { emailAddress?: { address?: string }; status?: { response?: string } };
    const status = rec.status?.response;
    // Skip attendees who declined or haven't been invited yet — they won't
    // be on the meeting anyway.
    if (status === 'declined' || status === 'none') continue;
    const email = (rec.emailAddress?.address ?? '').toLowerCase();
    if (!email) continue;  // missing email — inconclusive, skip
    if (!email.endsWith('@' + domain)) return false;
  }
  return true;
}

/**
 * Count attendees that will realistically show up. Includes the organizer
 * (implicit +1 since Graph's `attendees` array does not include them).
 * Declined / none statuses are dropped — we care about true participant count.
 */
export function countEffectiveAttendees(
  event: Pick<CalendarEvent, 'attendees'> | { attendees?: unknown },
): number {
  const attendees = (event.attendees as unknown[] | undefined) ?? [];
  let count = 1;  // organizer (owner)
  for (const a of attendees) {
    const rec = a as { status?: { response?: string }; emailAddress?: { address?: string } };
    const status = rec.status?.response;
    if (status === 'declined' || status === 'none') continue;
    if (!rec.emailAddress?.address) continue;
    count += 1;
  }
  return count;
}
