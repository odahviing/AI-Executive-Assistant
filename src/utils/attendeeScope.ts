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
    // v2.7.4 — only skip 'declined'. Per Microsoft Graph, 'none' is the
    // default response state (attendee added but not tracked yet) and
    // SHOULD count as an attendee. Outlook's "Didn't respond" label maps
    // to 'none' AND 'notResponded' — both real attendees.
    if (status === 'declined') continue;
    const email = (rec.emailAddress?.address ?? '').toLowerCase();
    if (!email) continue;  // missing email — inconclusive, skip
    if (!email.endsWith('@' + domain)) return false;
  }
  return true;
}

/**
 * v2.3.2 — coord-side internal-only check. Takes a participant list shaped
 * (v2.7.2) Function removed — was used solely by the coord fast-path that
 * v2.7.2 deleted. coord now always runs the state-machine path; the
 * "no internal pollables" case refuses with a clear error so Sonnet
 * switches to find_available_slots + create_meeting. See meetings.ts.
 */

/**
 * Count attendees that will realistically show up. Includes the organizer
 * (implicit +1 since Graph's `attendees` array does not include them).
 * v2.7.4 — only 'declined' is dropped. 'none' is the default response state
 * in Graph (untracked); those attendees still count.
 */
export function countEffectiveAttendees(
  event: Pick<CalendarEvent, 'attendees'> | { attendees?: unknown },
): number {
  const attendees = (event.attendees as unknown[] | undefined) ?? [];
  let count = 1;  // organizer (owner)
  for (const a of attendees) {
    const rec = a as { status?: { response?: string }; emailAddress?: { address?: string } };
    const status = rec.status?.response;
    if (status === 'declined') continue;
    if (!rec.emailAddress?.address) continue;
    count += 1;
  }
  return count;
}
