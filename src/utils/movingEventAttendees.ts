/**
 * Resolve attendee emails from the event(s) being moved — PER EVENT ID.
 *
 * When `find_available_slots` is called with `moving_event_ids`, the meeting's
 * existing attendees are KNOWN — Sonnet shouldn't have to re-pass them. This
 * helper reads the moving events from the calendar and returns each id's OWN
 * attendee roster (excluding the owner), keyed by event id. Caller merges
 * with any explicit args.
 *
 * Why: the painful Sales BiWeekly conversation (2026-05-14) showed Sonnet
 * sometimes drops attendees on the move-search call (after the first turn she
 * might call with attendee_emails=[] thinking she already verified them).
 * Owner direction: "find_available_slots should just take the list of people
 * to check if they're free or not" — the tool should not depend on Sonnet
 * remembering. Auto-fill from the event itself.
 *
 * v4.5.6 (moving-event-gate-false-positive-blocks-attendeeless-move) — also
 * carries durationMinutes/categories per id, read off the SAME event fetch
 * (no extra Graph round trip). Needed by the owner-path id-mismatch gate in
 * findAvailableSlots.ts for the genuinely-empty-roster case, where there is
 * no attendee to cross-check and the only remaining signal is "does this
 * candidate event even resemble what was asked for."
 *
 * Cheap: uses getCalendarEvents (per-turn memoized via turnCache).
 *
 * Keyed per id (not unioned) so a caller gating on membership — e.g. the
 * colleague-path check in findAvailableSlots.ts that requires the requester
 * to be ON an event's roster before it folds in — tests each id's OWN roster
 * instead of a blind union. A union would let one id she's on (which passes
 * the membership test) drag in a second, unrelated id's attendees whose
 * calendars she has no standing to read.
 *
 * Returns an empty map when the events can't be resolved — caller falls back
 * to whatever else it has (thread context, args.attendee_emails).
 */
import { DateTime } from 'luxon';
import { getCalendarEvents } from '../connectors/graph/calendar';
import logger from './logger';

export interface MovingEventInfo {
  attendees: string[];
  durationMinutes: number | null;
  categories: string[];
}

export async function resolveMovingEventAttendees(
  eventIds: string[],
  userEmail: string,
  timezone: string,
): Promise<Map<string, MovingEventInfo>> {
  const result = new Map<string, MovingEventInfo>();
  if (!eventIds || eventIds.length === 0) return result;

  const today = DateTime.now().setZone(timezone);
  const start = today.minus({ days: 7 }).toFormat("yyyy-MM-dd'T'00:00:00");
  const end = today.plus({ days: 60 }).toFormat("yyyy-MM-dd'T'23:59:59");

  try {
    const events = await getCalendarEvents(userEmail, start, end, timezone);
    const idSet = new Set(eventIds);
    const ownerEmailLower = userEmail.toLowerCase();
    for (const evt of events) {
      if (!idSet.has(evt.id)) continue;
      const attendees = (evt.attendees ?? []) as Array<{ emailAddress?: { address?: string } }>;
      const emails = new Set<string>();
      for (const a of attendees) {
        const addr = a?.emailAddress?.address;
        if (!addr) continue;
        if (addr.toLowerCase() === ownerEmailLower) continue;
        emails.add(addr);
      }
      let durationMinutes: number | null = null;
      const s = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' });
      const e = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' });
      if (s.isValid && e.isValid) durationMinutes = Math.round(e.diff(s, 'minutes').minutes);
      result.set(evt.id, {
        attendees: [...emails],
        durationMinutes,
        categories: evt.categories ?? [],
      });
    }
    return result;
  } catch (err) {
    logger.debug('resolveMovingEventAttendees failed (non-fatal)', {
      eventIds, err: String(err).slice(0, 200),
    });
    return result;
  }
}
