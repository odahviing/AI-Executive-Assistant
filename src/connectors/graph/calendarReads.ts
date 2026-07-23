import { DateTime } from 'luxon';
import logger from '../../utils/logger';
import { getClient } from './graphClient';
import type { CalendarEvent, FreeBusySlot, VerifyResult } from './calendarTypes';

/**
 * Single chokepoint for parsing Graph getSchedule's scheduleItems.
 * Graph returns dateTimes as UTC wall-clock strings WITHOUT an explicit
 * offset suffix, regardless of the timeZone field set in the request.
 * We parse as UTC, re-zone to the caller's requested zone, and emit an
 * ISO string that includes the offset — so the TZ context is encoded
 * in the data itself, not lost in transit.
 */
export function parseGraphFreeBusySlot(item: any, requestedTz: string): FreeBusySlot {
  const start = DateTime.fromISO(item.start.dateTime, { zone: 'utc' })
    .setZone(requestedTz);
  const end = DateTime.fromISO(item.end.dateTime, { zone: 'utc' })
    .setZone(requestedTz);
  return {
    start: start.isValid ? start.toISO()! : item.start.dateTime,
    end: end.isValid ? end.toISO()! : item.end.dateTime,
    status: item.status,
    _timezone: requestedTz,
  };
}

// ── Calendar reads ────────────────────────────────────────────────────────────

// ── Date helpers ──────────────────────────────────────────────────────────────


/**
 * Graph calendarView: startDateTime/endDateTime are ALWAYS interpreted as UTC
 * unless they include an explicit timezone offset. The Prefer header only changes
 * how RETURNED event times are formatted — it does NOT affect the query window.
 *
 * Fix: use Luxon to produce a full ISO string with offset, e.g. "2025-04-14T00:00:00+03:00"
 * so Graph uses the correct local midnight, not UTC midnight.
 */
// The yyyy-MM-dd prefix of a date/ISO string. Guards a missing/blank arg:
// an undefined start_date/end_date reaching here used to crash the WHOLE
// calendar query (`undefined.split('T')` → TypeError, surfaced to the owner as
// "trouble pulling up the calendar", 2026-07-13). A missing date now degrades
// to "today" in the mailbox zone instead of throwing — so every caller of
// getCalendarEvents / getFreeBusy is protected at this one chokepoint, not
// per-handler.
function datePart(dateStr: string | undefined | null, timezone: string): string {
  if (!dateStr || !dateStr.trim()) return DateTime.now().setZone(timezone).toISODate()!;
  return dateStr.split('T')[0];
}

function toStartOfDayLocal(dateStr: string | undefined | null, timezone: string): string {
  // Convert to UTC so the value ends in Z — passing +HH:00 in a query param encodes + as space
  return DateTime.fromISO(`${datePart(dateStr, timezone)}T00:00:00`, { zone: timezone })
    .toUTC()
    .toISO({ suppressMilliseconds: true })!;
}

function toEndOfDayLocal(dateStr: string | undefined | null, timezone: string): string {
  return DateTime.fromISO(`${datePart(dateStr, timezone)}T23:59:59`, { zone: timezone })
    .toUTC()
    .toISO({ suppressMilliseconds: true })!;
}

/**
 * Spread rules:
 *   • Max 3 total
 *   • Max 2 per day (with ≥1h gap between same-day picks)
 *   • ≥2 unique days when returning 3 (no all-same-day)
 *
 * Day walk order:
 *   • If `anchorDay` (yyyy-MM-dd) is set and has candidates → walk that day
 *     first, then the rest of the days in chronological order. This is the
 *     "move" shape — prefer same-day options for the meeting being moved,
 *     spill to other days to satisfy the ≥2 unique days rule.
 *   • Otherwise → pure chronological. The "new booking" shape — packs the
 *     earliest day's candidates up to 2, then spills to the next day.
 *
 * Within each day: walk the day's candidates chronologically, take up to 2
 * with ≥1h gap from every already-chosen slot.
 *
 * Returns 1 or 2 slots if that's all the candidate list yields — caller's
 * search window may legitimately be narrow (e.g. owner asked "today between
 * 14:00 and 17:00"). Don't widen silently; just return what's there.
 *
 * Output: chronological regardless of internal day walk order.
 */
export function pickSpreadSlots(
  slots: Array<{ start: string; disturbs_floating_block?: boolean; away_tz?: string; over_optional?: string }>,
  timezone: string,
  count = 5,
  anchorDay?: string,
  // When set, no two returned slots start within `durationMinutes` of each
  // other (a later start landing inside an earlier slot is never a useful
  // option). Omitted → no overlap guard.
  durationMinutes?: number,
): string[] {
  const MIN_GAP_HOURS = 1;

  const chosen: string[] = [];
  const chosenDts: DateTime[] = [];

  // Fill `chosen` (up to `count`) from ONE tier of candidates, round-robin by
  // day: round 1 takes the first viable slot from EACH day (maximize distinct
  // days), round 2 a second from each (≥1h from that day's prior pick, no
  // overlapping start), and so on. Diversity first, then depth. Respects the
  // ≥1h / duration gap against slots ALREADY chosen (by an earlier tier), so a
  // later tier never lands on top of an earlier-tier pick. This is the SINGLE
  // spreader for the regular, Working-Elsewhere-travel, and optional-join paths.
  const fillFrom = (pool: typeof slots, relaxGap = false) => {
    if (chosen.length >= count || pool.length === 0) return;
    // Group candidates by their EFFECTIVE local day. WE-travel slot's day is its
    // TRIP-tz day (away_tz set); home slots group by `timezone` exactly as
    // before (zero regression).
    const byDay = new Map<string, Array<{ start: string; dt: DateTime; disturbs: boolean }>>();
    for (const s of pool) {
      const dt = DateTime.fromISO(s.start).setZone(s.away_tz ?? timezone);
      const day = dt.toFormat('yyyy-MM-dd');
      let bucket = byDay.get(day);
      if (!bucket) { bucket = []; byDay.set(day, bucket); }
      bucket.push({ start: s.start, dt, disturbs: s.disturbs_floating_block === true });
    }
    // v3.2.6 (RC1) — within each day, prefer slots that DON'T disturb a floating
    // block (lunch). Stable sort keeps chronological order inside each group.
    for (const bucket of byDay.values()) {
      bucket.sort((a, b) => (a.disturbs ? 1 : 0) - (b.disturbs ? 1 : 0));
    }
    const allDays = [...byDay.keys()].sort();
    const dayOrder = (anchorDay && byDay.has(anchorDay))
      ? [anchorDay, ...allDays.filter(d => d !== anchorDay)]
      : allDays;
    const cursor = new Map<string, number>();   // next unscanned index per day
    let progressed = true;
    while (chosen.length < count && progressed) {
      progressed = false;
      for (const day of dayOrder) {
        if (chosen.length >= count) break;
        const bucket = byDay.get(day)!;
        let i = cursor.get(day) ?? 0;
        for (; i < bucket.length; i++) {
          const { start, dt } = bucket[i];
          // ≥1h from anything already chosen. Only same-day picks can ever be
          // <1h away (cross-day diffs are far larger), so scanning the whole set
          // is safe and cheap.
          if (!relaxGap && chosenDts.some(c => Math.abs(dt.diff(c, 'hours').hours) < MIN_GAP_HOURS)) continue;
          if (durationMinutes && durationMinutes > 0
            && chosenDts.some(c => Math.abs(dt.diff(c, 'minutes').minutes) < durationMinutes)) continue;
          chosen.push(start);
          chosenDts.push(dt);
          i++;                       // consume this slot before recording the cursor
          progressed = true;
          break;                     // one pick per day per round
        }
        cursor.set(day, i);
      }
    }
  };

  // v3.6.4 — TIER: clean slots FIRST. An optional-join (WE-soft) slot never
  // surfaces while clean slots satisfy the spread; only if the clean tier comes
  // up short do we complete the quota from WE-soft (each tagged "over your
  // optional …"). Explicit priority: clean › book-over-optional. (The relaxed
  // recovery — break a real rule — is a separate, lower tier handled upstream.)
  fillFrom(slots.filter(s => !s.over_optional));
  fillFrom(slots.filter(s => !!s.over_optional));
  // #Ayala (2026-07-23) — RELAXED FILL. The ≥1h spread gap is right for diverse
  // options across a week, but when the only clean slots are clustered in one
  // narrow band (e.g. the single ET-afternoon window overlapping the owner's day
  // for two ET attendees), it strands real openings and returns just ONE. If the
  // spread came up short, fill the rest from the same clean slots WITHOUT the 1h
  // gap — the durationMinutes non-overlap guard still blocks overlapping starts,
  // so these stay genuine, bookable options (21:15 + 21:45, not just 21:15).
  if (chosen.length < count) fillFrom(slots.filter(s => !s.over_optional), true);

  // Output chronological regardless of round-robin order.
  chosen.sort((a, b) => DateTime.fromISO(a).toMillis() - DateTime.fromISO(b).toMillis());
  return chosen;
}

export async function getCalendarEvents(
  userEmail: string,
  startDate: string,
  endDate: string,
  timezone: string = 'UTC',
  // v3.2.x (#121) — force a fresh Graph read, bypassing both caches. Set when
  // the user explicitly asks Maelle to LOOK at the calendar (see the tool
  // descriptions). "If she's sent to the calendar, she goes to the calendar."
  forceRefresh: boolean = false,
): Promise<CalendarEvent[]> {
  const cacheKey = `getCalendarEvents|${userEmail}|${startDate}|${endDate}|${timezone}`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cache = require('./calendarCache') as typeof import('./calendarCache');

  // v3.2.x (#121) — cross-turn cache (default 300s TTL, write-invalidated).
  // Force → straight to Graph, then repopulate so the warm copy is fresh.
  if (forceRefresh) {
    const data = await getCalendarEventsImpl(userEmail, startDate, endDate, timezone);
    cache.setCachedEvents(cacheKey, data);
    return data;
  }
  const cached = cache.getCachedEvents<CalendarEvent[]>(cacheKey);
  if (cached) return cached;

  // v2.4.3 (A3) — per-turn memoization wraps the cross-turn miss: concurrent
  // callers within one turn share a single in-flight fetch. Outside a turn
  // (background tasks) memoize bypasses and just fetches.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { memoize } = require('../../utils/turnCache') as typeof import('../../utils/turnCache');
  return memoize(cacheKey, async () => {
    const data = await getCalendarEventsImpl(userEmail, startDate, endDate, timezone);
    cache.setCachedEvents(cacheKey, data);
    return data;
  });
}

/**
 * findDuplicateEvent — the ONE idempotency primitive. Returns the owner's
 * existing event whose subject (trim + lowercase) matches and whose start is
 * within `toleranceMs` of the requested start, else undefined. Callers own
 * their own short-circuit shape — only the fetch + match lives here.
 *
 * Why: date-verifier / claim-checker retries re-run the whole orchestrator on a
 * new turn, and a direct create_meeting can race a coord book. Graph is the
 * source of truth — query it before creating so a re-attempt of an
 * already-booked meeting returns the existing id instead of a duplicate.
 */
export async function findDuplicateEvent(
  userEmail: string,
  subject: string,
  startIso: string,
  timezone: string,
  toleranceMs = 2 * 60 * 1000,
): Promise<CalendarEvent | undefined> {
  const startDt = DateTime.fromISO(startIso, { zone: timezone });
  if (!startDt.isValid) return undefined;
  const wantSubject = subject.trim().toLowerCase();
  const startMs = startDt.toMillis();
  const probeDate = startDt.toFormat('yyyy-MM-dd');
  const events = await getCalendarEvents(userEmail, probeDate, probeDate, timezone);
  return events.find(ev => {
    if (ev.isCancelled) return false;
    if ((ev.subject ?? '').trim().toLowerCase() !== wantSubject) return false;
    const evStartMs = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).toMillis();
    return Math.abs(evStartMs - startMs) <= toleranceMs;
  });
}

/**
 * findReschedulableSibling (v3.6.x) — the create-vs-move slop guard's finder. A
 * sibling of findDuplicateEvent (idempotency), widened for the reschedule case:
 * returns an existing owner event that looks like the SAME meeting as the one
 * about to be created — same subject (trim+lowercase) AND ≥1 shared non-owner
 * attendee — within a ~3-week window around the requested start, EXCLUDING
 * the requested instant itself (that exact-time case is findDuplicateEvent's
 * job). Time-INDEPENDENT by design: a reschedule lands on a different day/time,
 * so we match WHO + WHAT, never WHEN. Structured fields only — no NL match, so
 * it's language-neutral. Returns the sibling nearest the requested start (the
 * occurrence the owner most likely means to move), else undefined.
 *
 * Caller uses it as surface-and-ask, NOT a block: offer move_meeting on this id,
 * and still book a genuine second meeting on force_new — so a legit second 1:1
 * with the same person stays bookable (the false-fire that kept the older
 * description-only fix soft). Catches "move X" → create_meeting duplicating a
 * live series (the 2026-07-05 Simon double-book across two days).
 */
export async function findReschedulableSibling(params: {
  userEmail: string;
  ownerEmail: string;
  subject: string;
  attendeeEmails: string[];
  startIso: string;
  timezone: string;
}): Promise<CalendarEvent | undefined> {
  const startDt = DateTime.fromISO(params.startIso, { zone: params.timezone });
  const wantSubject = params.subject.trim().toLowerCase();
  if (!startDt.isValid || !wantSubject) return undefined;
  const ownerLower = params.ownerEmail.toLowerCase();
  const wantAttendees = new Set(
    params.attendeeEmails.map(e => e.toLowerCase()).filter(e => e && e !== ownerLower),
  );
  if (wantAttendees.size === 0) return undefined;  // need a shared attendee to be confident
  const startMs = startDt.toMillis();
  // ~3-week window: 1 week back + 2 weeks forward. Forward-weighted because the
  // occurrence being rescheduled is usually the upcoming one, and covers a
  // biweekly series' next instance; wide enough for the common same-week move,
  // bounded to keep this one extra fetch cheap.
  const from = startDt.minus({ days: 7 }).toFormat('yyyy-MM-dd');
  const to = startDt.plus({ days: 14 }).toFormat('yyyy-MM-dd');
  const events = await getCalendarEvents(params.userEmail, from, to, params.timezone);
  const evMsOf = (ev: CalendarEvent): number =>
    DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).toMillis();
  const matches = events.filter(ev => {
    if (ev.isCancelled) return false;
    if ((ev.subject ?? '').trim().toLowerCase() !== wantSubject) return false;
    if (Math.abs(evMsOf(ev) - startMs) <= 2 * 60 * 1000) return false;  // exact-time = idempotency's job
    return (ev.attendees ?? []).some(a => wantAttendees.has((a.emailAddress?.address ?? '').toLowerCase()));
  });
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => Math.abs(evMsOf(a) - startMs) - Math.abs(evMsOf(b) - startMs));
  return matches[0];
}

async function getCalendarEventsImpl(
  userEmail: string,
  startDate: string,
  endDate: string,
  timezone: string,
): Promise<CalendarEvent[]> {
  const client = getClient();

  // Normalise dates: strip Z/ms suffix so Graph uses the mailbox timezone
  // Also ensure we always query the FULL day — never start mid-day
  const cleanStart = toStartOfDayLocal(startDate, timezone);
  const cleanEnd   = toEndOfDayLocal(endDate, timezone);

  logger.info('Querying calendar', { userEmail, start: cleanStart, end: cleanEnd });

  // v2.1.6 — follow @odata.nextLink until exhausted (or a sane hard cap).
  // Previous single-shot `.query({$top: 100})` silently truncated at 100
  // events, leading to bugs like "the series doesn't seem to have instances
  // beyond Jun 11" when the series in fact ran through July — Graph returned
  // the first 100 chronologically, the LLM saw no nextLink handling, and the
  // narration described a false terminal boundary. Hard cap of 1000 prevents
  // runaway queries on accidentally-enormous ranges while comfortably
  // covering realistic multi-month calendar views.
  const HARD_CAP = 1000;
  try {
    const events: CalendarEvent[] = [];
    let request: any = client
      .api(`/users/${userEmail}/calendarView`)
      .header('Prefer', `outlook.timezone="${timezone}"`)
      .query({
        startDateTime: cleanStart,
        endDateTime: cleanEnd,
        $select: 'id,subject,start,end,isAllDay,importance,showAs,sensitivity,categories,organizer,attendees,isCancelled,isOnlineMeeting,onlineMeetingUrl,location,bodyPreview,type,seriesMasterId',
        $orderby: 'start/dateTime',
        $top: 100,
      });

    while (request && events.length < HARD_CAP) {
      const response: any = await request.get();
      const page: CalendarEvent[] = response.value ?? [];
      events.push(...page);
      const nextLink: string | undefined = response['@odata.nextLink'];
      if (!nextLink) break;
      // Graph SDK accepts the full nextLink as an api() URL. The cursor
      // preserves the QUERY (filter/select/orderby) but NOT request HEADERS.
      // v2.3.1 (B6 / #63) — re-attach Prefer so subsequent pages also come
      // back in the owner's timezone instead of defaulting to UTC.
      request = client.api(nextLink).header('Prefer', `outlook.timezone="${timezone}"`);
    }

    const truncated = events.length >= HARD_CAP;
    logger.info('Calendar events fetched', {
      count: events.length,
      start: cleanStart,
      end: cleanEnd,
      truncated,
    });
    if (truncated) {
      logger.warn('Calendar fetch hit HARD_CAP — result may be incomplete', {
        userEmail, start: cleanStart, end: cleanEnd, cap: HARD_CAP,
      });
    }
    return events;
  } catch (err) {
    logger.error('Failed to fetch calendar events', { err, userEmail, startDate, endDate });
    throw err;
  }
}

export class GraphPermissionError extends Error {
  constructor(public readonly operation: string, public readonly detail: string) {
    super(`Graph permission denied for "${operation}": ${detail}`);
    this.name = 'GraphPermissionError';
  }
}

export async function getFreeBusy(
  callerEmail: string,
  emails: string[],
  startDate: string,
  endDate: string,
  timezone: string,
  forceRefresh: boolean = false,
  // v3.3.7 (#124h) — optional by-reference diagnostics. `unresolved` is filled
  // with addresses Graph could NOT resolve to a mailbox (per-schedule `error`
  // entry, or address missing from the response). Pre-fix this was silently
  // dropped, so a guessed/typo'd internal address read as FULLY FREE — the
  // "elinor.avny@" slots were offered without ever checking the real Elinor.
  diagnostics?: { unresolved?: string[] },
): Promise<Record<string, FreeBusySlot[]>> {
  // v2.7.6 — guard against invalid time windows that crash Graph's
  // getSchedule with ErrorInvalidTimeInterval. Graph requires
  // startTime < endTime AND a window between 1 hour and 62 days. Pre-fix,
  // the auto-expand loop in findAvailableSlots could produce equal or
  // inverted windows on edge cases (off-by-one when search_from was at the
  // boundary of an iteration). Throw a clean TypeError instead of poking
  // Graph and letting the slot finder die mid-loop with an opaque 400.
  const parsedStart = DateTime.fromISO(startDate, { zone: timezone });
  const parsedEnd = DateTime.fromISO(endDate, { zone: timezone });
  if (!parsedStart.isValid || !parsedEnd.isValid) {
    logger.warn('getFreeBusy — invalid date param, returning empty', {
      startDate, endDate, parsedStartValid: parsedStart.isValid, parsedEndValid: parsedEnd.isValid,
    });
    return {};
  }
  const windowMinutes = parsedEnd.diff(parsedStart, 'minutes').minutes;
  if (windowMinutes <= 0) {
    logger.warn('getFreeBusy — zero or inverted window, returning empty', {
      startDate, endDate, windowMinutes,
    });
    return {};
  }
  if (windowMinutes > 62 * 24 * 60) {
    logger.warn('getFreeBusy — window > 62 days, clamping to 62 days', {
      startDate, endDate, windowMinutes,
    });
    const clamped = parsedStart.plus({ days: 62 }).toISO()!;
    return getFreeBusy(callerEmail, emails, startDate, clamped, timezone);
  }

  // v3.2.x (#121) — cross-turn free/busy cache (others' calendars change like
  // ours → same write-invalidation + TTL + force-refresh). Key on the sorted
  // attendee set + window so any caller order hits the same entry.
  const fbKey = `getFreeBusy|${[...emails].sort().join(',')}|${startDate}|${endDate}|${timezone}`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fbCache = require('./calendarCache') as typeof import('./calendarCache');
  if (!forceRefresh) {
    const hit = fbCache.getCachedFreeBusy<Record<string, FreeBusySlot[]>>(fbKey);
    if (hit) {
      if (diagnostics) {
        diagnostics.unresolved = fbCache.getCachedFreeBusy<string[]>(`${fbKey}|unresolved`) ?? [];
      }
      return hit;
    }
  }

  const client = getClient();
  try {
    // v3.7.x (#137) — availabilityViewInterval must be < the requested window or
    // Graph 400s with ErrorInvalidMergedFreeBusyInterval. A single-slot
    // verification window (colleague-path Guard B / move-check) for a SHORT
    // meeting (e.g. a 10-min slot) is narrower than the hardcoded 15, which failed
    // DETERMINISTICALLY and mis-escalated a rule-COMPLIANT booking to a
    // policy_exception approval (#137 — a same-params retry can't fix a malformed
    // request). Derive a valid interval for short windows; windows ≥16 min keep 15
    // (no behavior change — scheduleItems, the busy blocks we actually read, are
    // returned regardless of the view interval).
    const availabilityViewInterval = windowMinutes >= 16
      ? 15
      : Math.max(5, Math.floor(windowMinutes) - 1);
    const response = await client.api(`/users/${callerEmail}/calendar/getSchedule`).post({
      schedules: emails,
      startTime: { dateTime: startDate, timeZone: timezone },
      endTime: { dateTime: endDate, timeZone: timezone },
      availabilityViewInterval,
    });

    const result: Record<string, FreeBusySlot[]> = {};
    const unresolved: string[] = [];
    for (const schedule of response.value || []) {
      // v3.3.7 (#124h) — Graph marks a non-existent / unresolvable address
      // with a per-schedule `error` object instead of scheduleItems. Surface
      // it; an empty array here is indistinguishable from "free all week".
      if (schedule.error) {
        unresolved.push(String(schedule.scheduleId ?? '').toLowerCase());
        result[schedule.scheduleId] = [];
        continue;
      }
      result[schedule.scheduleId] = (schedule.scheduleItems || []).map((item: any) =>
        parseGraphFreeBusySlot(item, timezone),
      );
    }
    // Belt-and-suspenders: an address Graph dropped from the response entirely.
    for (const e of emails) {
      const lower = e.toLowerCase();
      const present = Object.keys(result).some(k => k.toLowerCase() === lower);
      if (!present && !unresolved.includes(lower)) unresolved.push(lower);
    }
    if (diagnostics) diagnostics.unresolved = unresolved;
    fbCache.setCachedFreeBusy(fbKey, result);
    fbCache.setCachedFreeBusy(`${fbKey}|unresolved`, unresolved);
    return result;
  } catch (err: any) {
    logger.error('Failed to fetch free/busy', { err, emails });

    // 403 / ErrorAccessDenied means the Azure app lacks Calendars.Read application
    // permission (admin consent required in the company tenant).
    // Surface this as a typed error so callers can give a useful message.
    if (err?.statusCode === 403 || err?.code === 'ErrorAccessDenied') {
      throw new GraphPermissionError(
        'getFreeBusy',
        'The Azure app does not have Calendars.Read permission to query other users\' availability. ' +
        'A tenant admin needs to grant Calendars.Read application permission in Azure AD.',
      );
    }
    // ErrorInvalidTimeInterval — return empty so the slot finder iteration
    // doesn't die. Pre-fix, this 400 propagated up and broke the whole search.
    if (err?.code === 'ErrorInvalidTimeInterval' || err?.body?.includes?.('ErrorInvalidTimeInterval')) {
      logger.warn('getFreeBusy — Graph returned ErrorInvalidTimeInterval, returning empty', {
        startDate, endDate, emails,
      });
      return {};
    }
    throw err;
  }
}

/**
 * v1.8.8 — cheap probe to check whether an event is part of a recurring
 * series. Returns { type, subject, seriesMasterId? } from a lightweight
 * GET. Used by update_meeting and move_meeting to block changes to the
 * series root while allowing single-occurrence edits.
 */
/**
 * v2.1.4 — find the next occurrence of a recurring series after a given
 * ISO timestamp. Used by active-mode move-coord to cap the slot search so
 * Maelle doesn't propose moving a weekly meeting into a date where the
 * NEXT weekly instance already lives (would duplicate the cadence).
 *
 * Query Graph's `/events/{seriesMasterId}/instances` endpoint — returns
 * expanded occurrences of the series within a date range. Pick the first
 * one with a start strictly after `afterIso`.
 *
 * Returns null when:
 *   - the series has no more occurrences after `afterIso` (end of series)
 *   - the Graph call fails (fail-open — caller treats as "no cap")
 *   - seriesMasterId is empty
 *
 * Lookahead window: 60 days. Weekly / biweekly always fit; a monthly
 * cadence would fit twice; yearly recurrences fall outside — accept that
 * trade-off, a yearly event uncapped is rare and the safer cap is fine.
 */
export async function getNextSeriesOccurrenceAfter(
  userEmail: string,
  seriesMasterId: string,
  afterIso: string,
): Promise<string | null> {
  if (!seriesMasterId) return null;
  try {
    const client = getClient();
    const afterDt = DateTime.fromISO(afterIso).toUTC();
    const startQueryIso = afterDt.plus({ minutes: 1 }).toISO()!;
    const endQueryIso = afterDt.plus({ days: 60 }).toISO()!;
    const resp = await client
      .api(`/users/${userEmail}/events/${seriesMasterId}/instances`)
      .query({ startDateTime: startQueryIso, endDateTime: endQueryIso })
      .select('id,start,isCancelled')
      .top(5)
      .get();
    const items: Array<{ id: string; start?: { dateTime: string; timeZone: string }; isCancelled?: boolean }>
      = resp?.value ?? [];
    for (const inst of items) {
      if (inst.isCancelled) continue;
      if (!inst.start?.dateTime) continue;
      // Graph returns instance start in the series' original timezone; normalise to UTC.
      const instStartIso = DateTime
        .fromISO(inst.start.dateTime, { zone: inst.start.timeZone ?? 'utc' })
        .toUTC()
        .toISO()!;
      if (instStartIso > afterIso) return instStartIso;
    }
    return null;
  } catch (err) {
    logger.warn('getNextSeriesOccurrenceAfter — failed, returning null (fail-open)', {
      seriesMasterId, err: String(err).slice(0, 200),
    });
    return null;
  }
}

/**
 * v2.1.4 — who organized a calendar event? Used by update_meeting /
 * move_meeting guards to refuse mutations on meetings the owner didn't
 * organize (Graph would reject the PATCH anyway, but we fail early with a
 * human error message + avoid Maelle narrating a fake success).
 *
 * Returns null when the Graph call fails — caller treats as "unknown, allow".
 */
export async function getEventOrganizer(
  userEmail: string,
  meetingId: string,
): Promise<{ name?: string; address: string } | null> {
  try {
    const client = getClient();
    const event = await client
      .api(`/users/${userEmail}/events/${meetingId}`)
      .select('id,organizer')
      .get();
    const addr = event?.organizer?.emailAddress?.address;
    if (!addr) return null;
    return {
      name: event.organizer.emailAddress.name,
      address: String(addr).toLowerCase(),
    };
  } catch (err) {
    logger.warn('getEventOrganizer — failed, returning null (fail-open)', {
      meetingId, err: String(err).slice(0, 200),
    });
    return null;
  }
}

/**
 * v3.5.x — single GET of one event's END instant (resolved to `timezone`) + its
 * subject. ONE lookup-by-id, no calendarView range-probe. Two callers:
 *   - create_meeting `start_at_event_end_id` — anchor "X after my flight/meeting"
 *     deterministically (start = this end; no model clock-arithmetic, nothing to ask).
 *   - the must_be_after_event_id ordering guard — refuse a start before this end.
 * Returns null when the event can't be loaded (deleted / permission / bad id);
 * callers treat null as "skip the check / refuse the anchor."
 */
export async function getEventEndInstant(
  userEmail: string,
  eventId: string,
  timezone: string,
): Promise<{ end: DateTime; subject: string } | null> {
  try {
    const client = getClient();
    const event = await client
      .api(`/users/${userEmail}/events/${eventId}`)
      .header('Prefer', `outlook.timezone="${timezone}"`)
      .select('id,subject,end')
      .get();
    const endIso = event?.end?.dateTime;
    if (!endIso) return null;
    const dt = DateTime.fromISO(endIso, { zone: event.end.timeZone ?? timezone }).setZone(timezone);
    if (!dt.isValid) return null;
    return { end: dt, subject: event.subject ?? 'unknown' };
  } catch (err) {
    logger.warn('getEventEndInstant — failed, returning null', {
      eventId, err: String(err).slice(0, 200),
    });
    return null;
  }
}

/**
 * v2.9.1 — load just enough event detail for an attendee-update flow:
 * existing attendees (so the handler can compute the new list), start/end
 * (so location resolution can re-evaluate day-type), categories, location,
 * isOnline. Single GET, no calendarView pagination.
 *
 * Returns null when the event cannot be loaded (deleted, permission, etc.).
 * Caller treats null as "refuse the update with a clear message."
 */
export async function getEventForAttendeeUpdate(
  userEmail: string,
  meetingId: string,
): Promise<{
  attendees: Array<{ name?: string; email: string; optional?: boolean }>;
  startIso?: string;
  endIso?: string;
  startTimeZone?: string;
  categories: string[];
  location?: string;
  isOnline?: boolean;
} | null> {
  try {
    const client = getClient();
    const event: any = await client
      .api(`/users/${userEmail}/events/${meetingId}`)
      .select('id,start,end,attendees,categories,location,isOnlineMeeting')
      .get();
    if (!event) return null;
    const attendees = ((event.attendees as any[]) ?? [])
      .filter(a => a?.emailAddress?.address)
      .map(a => ({
        name: a.emailAddress?.name as string | undefined,
        email: String(a.emailAddress.address).toLowerCase(),
        optional: a.type === 'optional',
      }));
    return {
      attendees,
      startIso: event.start?.dateTime,
      endIso: event.end?.dateTime,
      startTimeZone: event.start?.timeZone,
      categories: (event.categories as string[]) ?? [],
      location: event.location?.displayName as string | undefined,
      isOnline: event.isOnlineMeeting as boolean | undefined,
    };
  } catch (err) {
    logger.warn('getEventForAttendeeUpdate — failed', {
      meetingId, err: String(err).slice(0, 200),
    });
    return null;
  }
}

export async function getEventType(userEmail: string, meetingId: string): Promise<{
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  subject?: string;
  seriesMasterId?: string;
  // v2.8.5 — also surface start so callers (notably delete_meeting's audit
  // log) can record WHICH DAY was affected, enabling active-mode to detect
  // "owner just deleted this floating block — don't re-book it" later.
  startDateTime?: string;
  startTimeZone?: string;
  // v3.4.x (#135c) — also surface end so a pure move (new_end omitted) can
  // preserve the meeting's existing duration without forcing the model to
  // supply (or re-ask for) a length it already knows.
  endDateTime?: string;
  endTimeZone?: string;
}> {
  const client = getClient();
  const event = await client
    .api(`/users/${userEmail}/events/${meetingId}`)
    .select('id,type,subject,seriesMasterId,start,end')
    .get();
  return {
    type: event?.type,
    subject: event?.subject,
    seriesMasterId: event?.seriesMasterId,
    startDateTime: event?.start?.dateTime,
    startTimeZone: event?.start?.timeZone,
    endDateTime: event?.end?.dateTime,
    endTimeZone: event?.end?.timeZone,
  };
}

/**
 * v2.1.6 — post-delete verification. Returns true when Graph confirms the
 * event is no longer retrievable (HTTP 404 on GET), false when it's still
 * there despite the delete call returning success. Any other error is
 * treated as "unknown / assume still present" so the caller narrates
 * honestly rather than falsely confirming a delete. Mirrors the spirit of
 * `create_meeting`'s pre-check (same trust-but-verify principle for
 * calendar-mutating ops).
 */
export async function verifyEventDeleted(
  userEmail: string,
  meetingId: string,
): Promise<boolean> {
  const client = getClient();
  try {
    await client.api(`/users/${userEmail}/events/${meetingId}`).get();
    // Event still exists — delete did NOT land.
    return false;
  } catch (err: any) {
    const code = err?.statusCode ?? err?.code;
    if (code === 404 || code === 'ErrorItemNotFound') return true;
    logger.warn('verifyEventDeleted: unexpected error, assuming NOT deleted', {
      meetingId, code, message: err?.message,
    });
    return false;
  }
}

// v2.2.5 (#54) — post-create / post-move verification. Mirrors the spirit of
// verifyEventDeleted: re-read the event from Graph after a write to confirm it
// actually landed at the requested time. Microsoft Graph occasionally returns
// 200 OK on writes that don't take effect (sync delays, lost writes, race
// conditions). With the new action tape pinning successful mutations into the
// owner system prompt, a silent failure would make Maelle assert "I moved X"
// against the owner's pushback. These verifiers turn that into honest
// `success:false` so the tape never lists a write that didn't land.
//
// Tolerance: ±60s on start. Graph normalizes ISO formats (Z vs offset) and
// occasional truncation of milliseconds; tighter than 60s produces false
// drifts. Subject drift is intentionally NOT checked — Outlook normalizes
// whitespace/emojis/quote styles, that's a separate problem class, not a
// silent-write failure.

const VERIFY_TOLERANCE_MS = 60_000;

async function verifyEventStartMatches(
  userEmail: string,
  meetingId: string,
  expectedStartIso: string,
  expectedTimezone: string,
): Promise<VerifyResult> {
  const client = getClient();
  let evt: { start?: { dateTime: string; timeZone?: string } };
  try {
    evt = await client.api(`/users/${userEmail}/events/${meetingId}`).get();
  } catch (err: any) {
    const code = err?.statusCode ?? err?.code;
    if (code === 404 || code === 'ErrorItemNotFound') {
      return { ok: false, reason: 'not_found' };
    }
    // Network blip / auth blip / unknown error: treat as unknown and return ok
    // to avoid false-positive failures. The honest move is to NOT block on
    // verifier errors — let downstream layers (claim-checker, brief) catch
    // anything that's actually wrong.
    logger.warn('verifyEventStartMatches: readback threw, assuming OK', {
      meetingId, code, message: err?.message,
    });
    return { ok: true };
  }
  if (!evt?.start?.dateTime) {
    return { ok: false, reason: 'not_found' };
  }
  const got = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' });
  const expected = DateTime.fromISO(expectedStartIso, { zone: expectedTimezone });
  if (!got.isValid || !expected.isValid) {
    logger.warn('verifyEventStartMatches: invalid datetime, assuming OK', {
      meetingId, gotRaw: evt.start.dateTime, expectedRaw: expectedStartIso,
    });
    return { ok: true };
  }
  const diff = Math.abs(got.toMillis() - expected.toMillis());
  if (diff <= VERIFY_TOLERANCE_MS) return { ok: true };
  return {
    ok: false,
    reason: 'start_drift',
    got: got.setZone(expectedTimezone).toFormat("EEE d MMM 'at' HH:mm"),
    expected: expected.toFormat("EEE d MMM 'at' HH:mm"),
  };
}

export async function verifyEventCreated(
  userEmail: string,
  meetingId: string,
  expectedStartIso: string,
  expectedTimezone: string,
): Promise<VerifyResult> {
  return verifyEventStartMatches(userEmail, meetingId, expectedStartIso, expectedTimezone);
}

export async function verifyEventMoved(
  userEmail: string,
  meetingId: string,
  expectedStartIso: string,
  expectedTimezone: string,
): Promise<VerifyResult> {
  return verifyEventStartMatches(userEmail, meetingId, expectedStartIso, expectedTimezone);
}
