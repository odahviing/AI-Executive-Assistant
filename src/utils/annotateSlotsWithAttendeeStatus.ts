/**
 * Per-slot attendee status annotation (v2.2.3, #43).
 *
 * Given a list of proposed slots (already chosen against the OWNER's calendar)
 * and a single attendee, returns each slot tagged with the attendee's status
 * at that time: 'free' | 'busy' | 'tentative' | 'oof' | 'unknown'.
 *
 * One getFreeBusy call per attendee covering the full slot range — same Graph
 * footprint as today (we used to fold attendees into the busy filter; now we
 * just use the same data for annotation instead of filtering).
 *
 * Used in coord DM rendering: "1. Wednesday 14:00 (you look free)" lets the
 * recipient decide whether the slot works without Maelle assuming any of their
 * meetings are movable.
 *
 * Falls back to status='unknown' on Graph error — never blocks coord.
 */

import { DateTime } from 'luxon';
import { getFreeBusy } from '../connectors/graph/calendar';
import logger from './logger';

export type AttendeeSlotStatus = 'free' | 'busy' | 'tentative' | 'oof' | 'unknown';

export interface AnnotatedSlot<S extends { start: string; end: string }> {
  slot: S;
  attendeeStatus: AttendeeSlotStatus;
}

export async function annotateSlotsWithAttendeeStatus<S extends { start: string; end: string }>(params: {
  slots: S[];
  attendeeEmail: string;
  callerEmail: string;
  timezone: string;
}): Promise<AnnotatedSlot<S>[]> {
  if (params.slots.length === 0) return [];

  // Single Graph call covering the full range of all slots.
  const earliest = params.slots.reduce(
    (min, s) => (s.start < min ? s.start : min),
    params.slots[0].start,
  );
  const latest = params.slots.reduce(
    (max, s) => (s.end > max ? s.end : max),
    params.slots[0].end,
  );

  let busyRanges: Array<{ start: number; end: number; status: string }> = [];
  try {
    const busyMap = await getFreeBusy(params.callerEmail, [params.attendeeEmail], earliest, latest, params.timezone);
    const slots = busyMap[params.attendeeEmail] ?? [];
    busyRanges = slots
      .filter(s => s.status !== 'free')
      .map(s => ({
        // FreeBusySlot.start/end carry an explicit offset (set by
        // parseGraphFreeBusySlot inside getFreeBusy). Luxon honors it.
        start: DateTime.fromISO(s.start).toMillis(),
        end:   DateTime.fromISO(s.end).toMillis(),
        status: s.status,
      }));
  } catch (err) {
    logger.warn('annotateSlotsWithAttendeeStatus: getFreeBusy failed — returning unknown', {
      attendeeEmail: params.attendeeEmail,
      err: String(err).slice(0, 200),
    });
    return params.slots.map(slot => ({ slot, attendeeStatus: 'unknown' as const }));
  }

  // Status priority: oof > busy > tentative > free
  const statusRank: Record<string, number> = { oof: 4, busy: 3, tentative: 2, free: 1 };

  return params.slots.map(slot => {
    const slotStart = DateTime.fromISO(slot.start).toMillis();
    const slotEnd = DateTime.fromISO(slot.end).toMillis();
    let topStatus: AttendeeSlotStatus = 'free';
    let topRank = 0;
    for (const r of busyRanges) {
      if (r.start < slotEnd && r.end > slotStart) {
        const rank = statusRank[r.status] ?? 0;
        if (rank > topRank) {
          topRank = rank;
          topStatus = (r.status as AttendeeSlotStatus);
        }
      }
    }
    return { slot, attendeeStatus: topStatus };
  });
}

/**
 * Render an attendee status as a short tag for coord DM display.
 *   free → "looks free"
 *   busy → "you look busy"
 *   tentative → "looks tentative"
 *   oof → "you're out of office"
 *   unknown → '' (no tag — degraded data)
 */
export function statusTag(status: AttendeeSlotStatus): string {
  switch (status) {
    case 'free':      return 'looks free';
    case 'busy':      return 'you look busy';
    case 'tentative': return 'looks tentative';
    case 'oof':       return 'you\'re out of office';
    case 'unknown':   return '';
  }
}
