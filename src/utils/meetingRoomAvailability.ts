/**
 * meetingRoomAvailability (v2.8.2) — busy/free check on the office meeting
 * room mailbox, with size-aware fallback.
 *
 * Called only when the location decision tree picks the big meeting room
 * (office day + internal-only, ≥4 people). Probes the room mailbox via Graph
 * free/busy:
 *
 *   - Room free
 *       → caller proceeds with Meeting Room + room mailbox invited.
 *   - Room busy + participantCount ≤ 5
 *       → caller switches location to `small_meeting_room_label` ("Office"),
 *         drops the room mailbox from the invite. The 4-5 person group can
 *         use the small office space.
 *   - Room busy + participantCount ≥ 6
 *       → caller refuses the booking and surfaces `suggestedAskText` to the
 *         owner: room is taken AND the group is too big for the small
 *         fallback. Owner decides: change time, shrink the list, etc.
 *
 * Fails open: if the free/busy call throws or the room email is missing, the
 * caller proceeds as if the room is free — Outlook will tell the owner if
 * the booking conflicts. Better than blocking the entire booking pipeline on
 * a Graph hiccup.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { getFreeBusy } from '../connectors/graph/calendar';
import logger from './logger';

export type RoomAvailabilityVerdict =
  | { kind: 'room_free' }
  | { kind: 'room_busy_small_fits'; smallLabel: string }
  | { kind: 'room_busy_too_big'; suggestedAskText: string }
  | { kind: 'skip'; reason: string };

export async function checkMeetingRoomAvailability(params: {
  profile: UserProfile;
  startIso: string;
  endIso: string;
  participantCount: number;
}): Promise<RoomAvailabilityVerdict> {
  const { profile, startIso, endIso, participantCount } = params;
  const roomEmail = profile.meetings.room_email;
  if (!roomEmail) return { kind: 'skip', reason: 'no room_email configured' };

  let isBusy = false;
  try {
    // P15 — `notChecked` means the free/busy read never happened for this window
    // (malformed window / Graph rejected it), which used to come back as `{}` and
    // land on `room_free`. "The room's free" is one of M11's own examples of a
    // reason that has to be TRUE; an unread calendar is not evidence of a free
    // room. Same outcome as the throw path below, which already declines to guess.
    const fbDiag: { notChecked?: string[] } = {};
    const fb = await getFreeBusy(
      profile.user.email,
      [roomEmail],
      startIso,
      endIso,
      profile.user.timezone,
      false,
      fbDiag,
    );
    if ((fbDiag.notChecked ?? []).length > 0) {
      logger.warn('checkMeetingRoomAvailability — room free/busy was never read; not claiming the room is free', {
        roomEmail, startIso, endIso,
      });
      return { kind: 'skip', reason: 'room availability could not be read' };
    }
    const slots = fb[roomEmail] ?? [];
    const slotStart = DateTime.fromISO(startIso);
    const slotEnd = DateTime.fromISO(endIso);
    isBusy = slots.some(s => {
      if (s.status === 'free') return false;
      const sStart = DateTime.fromISO(s.start, { zone: (s as any)._timezone ?? 'utc' });
      const sEnd = DateTime.fromISO(s.end, { zone: (s as any)._timezone ?? 'utc' });
      return sStart < slotEnd && sEnd > slotStart;
    });
  } catch (err) {
    logger.warn('checkMeetingRoomAvailability — getFreeBusy threw, failing open as room free', {
      roomEmail, err: String(err).slice(0, 200),
    });
    return { kind: 'skip', reason: 'freebusy call threw' };
  }

  if (!isBusy) return { kind: 'room_free' };

  // Room is busy. Decide fallback by group size.
  if (participantCount <= 5) {
    const smallLabel = profile.meetings.office_location?.small_meeting_room_label || 'Office';
    return { kind: 'room_busy_small_fits', smallLabel };
  }
  const whenLabel = DateTime.fromISO(startIso)
    .setZone(profile.user.timezone)
    .toFormat("EEEE 'at' HH:mm");
  const suggestedAskText = `The meeting room is taken at ${whenLabel} and ${participantCount} people don't fit a small space. Push the time, trim the list, or pick a different day?`;
  return { kind: 'room_busy_too_big', suggestedAskText };
}
