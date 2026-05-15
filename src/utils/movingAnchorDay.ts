/**
 * Resolve the local-date (yyyy-MM-dd in owner timezone) of the meeting being
 * moved. Used by pickSpreadSlots to prefer same-day options on move flows.
 *
 * Called only on owner-initiated find_available_slots when moving_event_ids
 * is non-empty. Cheap because getCalendarEvents memoizes via turnCache —
 * Sonnet has typically already called get_calendar this turn, so this fetch
 * is a cache hit.
 *
 * Returns undefined when the id can't be resolved (cancelled / past the
 * lookup window / Graph error). Picker falls back to chronological order
 * in that case — graceful degradation, not an error path.
 */
import { DateTime } from 'luxon';
import { getCalendarEvents } from '../connectors/graph/calendar';
import logger from './logger';

export async function resolveMovingAnchorDay(
  eventIds: string[],
  userEmail: string,
  timezone: string,
): Promise<string | undefined> {
  if (!eventIds || eventIds.length === 0) return undefined;

  // ±60 days from now covers every realistic "move that meeting" ask.
  const today = DateTime.now().setZone(timezone);
  const start = today.minus({ days: 7 }).toFormat("yyyy-MM-dd'T'00:00:00");
  const end = today.plus({ days: 60 }).toFormat("yyyy-MM-dd'T'23:59:59");

  try {
    const events = await getCalendarEvents(userEmail, start, end, timezone);
    const idSet = new Set(eventIds);
    for (const evt of events) {
      if (!idSet.has(evt.id)) continue;
      const dt = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' })
        .setZone(timezone);
      return dt.toFormat('yyyy-MM-dd');
    }
  } catch (err) {
    logger.debug('resolveMovingAnchorDay failed (non-fatal)', {
      eventIds, err: String(err).slice(0, 200),
    });
  }
  return undefined;
}
