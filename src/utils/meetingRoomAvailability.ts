/**
 * Checks the configured room mailbox when a create, move, or update selects its
 * venue label, explicitly invites the mailbox, or retains it at a new time.
 * Internal, external, and hybrid meetings of any size can request the room.
 * A move excludes its own occurrence and includes other proposed room commitments.
 *
 * A free room can be invited. An unread calendar yields an unconfirmed result.
 * For a busy room, the helper reports whether the group fits the smaller space
 * (up to five people). Availability of that space is unchecked. The planner
 * and colleague update handler can select the smaller venue or seek a decision
 * for a larger group. An owner updating the venue receives a busy-room notice
 * and keeps the requested location text while the update drops the busy mailbox.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { getFreeBusyForDecision, type CalendarEvent } from '../connectors/graph/calendar';
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
  existingEventId?: string;
  calendarReplacements?: CalendarEvent[];
}): Promise<RoomAvailabilityVerdict> {
  const { profile, startIso, endIso, participantCount } = params;
  const roomEmail = profile.meetings.room_email;
  if (!roomEmail) return { kind: 'skip', reason: 'no room_email configured' };

  let isBusy = false;
  try {
    // `notChecked` means the free/busy read never happened for this window
    // (malformed window / Graph rejected it), which used to come back as `{}` and
    // land on `room_free`. "The room's free" is one of M9's own examples of a
    // reason that has to be TRUE; an unread calendar is not evidence of a free
    // room. Same outcome as the throw path below, which already declines to guess.
    const fbDiag: { notChecked?: string[]; unresolved?: string[] } = {};
    const fb = await getFreeBusyForDecision(
      profile.user.email,
      [roomEmail],
      startIso,
      endIso,
      profile.user.timezone,
      fbDiag,
      params.calendarReplacements?.map(e => e.id) ?? (params.existingEventId ? [params.existingEventId] : undefined),
    );
    if ((fbDiag.notChecked ?? []).length > 0 || (fbDiag.unresolved ?? []).length > 0) {
      logger.warn('checkMeetingRoomAvailability — room free/busy was never read; not claiming the room is free', {
        roomEmail, startIso, endIso,
      });
      return { kind: 'skip', reason: 'room availability could not be read' };
    }
    const slots = [...(fb[roomEmail.toLowerCase()] ?? []), ...(params.calendarReplacements ?? [])
      .filter(e => e.id !== params.existingEventId && e.attendees?.some(a => a.emailAddress.address.toLowerCase() === roomEmail.toLowerCase()))
      .map(e => ({ start: DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone }).toISO()!,
        end: DateTime.fromISO(e.end.dateTime, { zone: e.end.timeZone }).toISO()!, status: 'busy' }))];
    const slotStart = DateTime.fromISO(startIso, { zone: profile.user.timezone });
    const slotEnd = DateTime.fromISO(endIso, { zone: profile.user.timezone });
    const overlapping = slots.filter(s => {
      const sStart = DateTime.fromISO(s.start, { zone: (s as any)._timezone ?? 'utc' });
      const sEnd = DateTime.fromISO(s.end, { zone: (s as any)._timezone ?? 'utc' });
      return sStart < slotEnd && sEnd > slotStart;
    });
    isBusy = overlapping.some(s => s.status !== 'free' && s.status !== 'unknown');
    if (!isBusy && overlapping.some(s => s.status === 'unknown')) return { kind: 'skip', reason: 'room availability could not be confirmed' };
  } catch (err) {
    logger.warn('checkMeetingRoomAvailability — getFreeBusy threw, room availability unconfirmed', {
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
  const whenLabel = DateTime.fromISO(startIso, { zone: profile.user.timezone })
    .setZone(profile.user.timezone)
    .toFormat("EEEE 'at' HH:mm");
  const suggestedAskText = `The meeting room is taken at ${whenLabel} and ${participantCount} people don't fit a small space. Push the time, trim the list, or pick a different day?`;
  return { kind: 'room_busy_too_big', suggestedAskText };
}
