import { DateTime } from 'luxon';
import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { config } from '../../config';
import logger from '../../utils/logger';
import { auditLog } from '../../db';
import type { UserProfile } from '../../config/userProfile';

// ── Auth ─────────────────────────────────────────────────────────────────────

function createGraphClient(): Client {
  const credential = new ClientSecretCredential(
    config.AZURE_TENANT_ID,
    config.AZURE_CLIENT_ID,
    config.AZURE_CLIENT_SECRET
  );
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
  return Client.initWithMiddleware({ authProvider });
}

let _client: Client | null = null;
function getClient(): Client {
  if (!_client) _client = createGraphClient();
  return _client;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  importance: string;
  showAs?: 'free' | 'busy' | 'tentative' | 'oof' | 'workingElsewhere' | 'unknown';
  sensitivity?: 'normal' | 'personal' | 'private' | 'confidential';
  categories?: string[];
  organizer?: { emailAddress: { name: string; address: string } };
  attendees?: Array<{ emailAddress: { name: string; address: string }; status: { response: string } }>;
  isCancelled: boolean;
  isOnlineMeeting: boolean;
  onlineMeetingUrl?: string;
  // Graph's location object. displayName is the user-facing string (e.g.
  // "Idan Office", "Meeting Room", "Reflectiz HQ — Shoham 5"). When
  // isOnlineMeeting=true AND location.displayName is set, the meeting is
  // hybrid (physical room + Teams link). Brief/render code reads this to
  // narrate the physical location instead of defaulting to "Online".
  location?: { displayName?: string };
  bodyPreview?: string;
  // v1.8.8 — recurring-event metadata. type='seriesMaster' = the series root
  // (mutations affect every occurrence — don't touch). 'occurrence' = one
  // instance of a recurring series. 'exception' = an already-customized
  // occurrence. 'singleInstance' = ordinary non-recurring event.
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  seriesMasterId?: string;
}

export interface FreeBusySlot {
  start: string;
  end: string;
  status: 'free' | 'busy' | 'tentative' | 'oof' | 'workingElsewhere' | 'unknown';
  // Explicit IANA zone the start/end strings are expressed in. Set by
  // parseGraphFreeBusySlot. Without this annotation, downstream consumers
  // (Sonnet via get_free_busy, util code) silently treat raw Graph strings
  // as if they were already local — which has bitten us repeatedly when an
  // attendee in another zone is read as if their busy block were in the
  // owner's zone.
  _timezone?: string;
}

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

export interface CreatedMeeting {
  id: string;
  joinUrl?: string;            // Teams join URL when isOnline=true
}

export interface CreateMeetingParams {
  subject: string;
  start: string;
  end: string;
  attendees: Array<{ name: string; email: string; optional?: boolean }>;
  body?: string;
  isOnline?: boolean;         // true = generate Teams meeting link
  location?: string;          // display name e.g. "Idan's office", "Meeting Room"
  onlineMeetingProvider?: 'teamsForBusiness' | 'skypeForBusiness';
  categories?:  string[];     // Outlook category names, e.g. ["Meeting"] or ["Physical"]
  sensitivity?: 'normal' | 'personal' | 'private' | 'confidential';
  // All-day events. Graph requires isAllDay=true with start/end anchored to
  // midnight of consecutive days in the user's timezone (00:00 both ends;
  // end is the day AFTER). Pre-this change callers had no way to set this
  // and any "all day" attempt landed as a 0-min event at midnight. Default
  // false — only set true when owner explicitly asks for a full-day event.
  // showAs is intentionally not exposed: every meeting Maelle books is busy
  // by default (owner direction).
  isAllDay?: boolean;
  userEmail: string;
  timezone: string;
  // v2.3.1 (B23) — when `body` is not provided, the default attribution line
  // names this assistant + owner instead of "your executive assistant".
  // E.g. "Maelle, Idan Assistant". Pass `${assistant.name}, ${owner first name} Assistant`
  // from the call site where profile is in scope. When omitted, falls back to
  // the legacy generic line for back-compat.
  defaultBodyAuthor?: string;
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
function toStartOfDayLocal(dateStr: string, timezone: string): string {
  const datePart = dateStr.split('T')[0];
  // Convert to UTC so the value ends in Z — passing +HH:00 in a query param encodes + as space
  return DateTime.fromISO(`${datePart}T00:00:00`, { zone: timezone })
    .toUTC()
    .toISO({ suppressMilliseconds: true })!;
}

function toEndOfDayLocal(dateStr: string, timezone: string): string {
  const datePart = dateStr.split('T')[0];
  return DateTime.fromISO(`${datePart}T23:59:59`, { zone: timezone })
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
  slots: Array<{ start: string }>,
  timezone: string,
  count = 3,
  anchorDay?: string,
): string[] {
  const MIN_GAP_HOURS = 1;
  const MAX_PER_DAY = 2;

  // Group candidates by local day.
  const byDay = new Map<string, Array<{ start: string; dt: DateTime }>>();
  for (const s of slots) {
    const dt = DateTime.fromISO(s.start).setZone(timezone);
    const day = dt.toFormat('yyyy-MM-dd');
    let bucket = byDay.get(day);
    if (!bucket) { bucket = []; byDay.set(day, bucket); }
    bucket.push({ start: s.start, dt });
  }

  // Chronological day list. Slots from findAvailableSlots are already
  // chronological so per-day buckets are too; just sort the day keys.
  const allDays = [...byDay.keys()].sort();
  const dayOrder = (anchorDay && byDay.has(anchorDay))
    ? [anchorDay, ...allDays.filter(d => d !== anchorDay)]
    : allDays;

  const chosen: string[] = [];
  const chosenDts: DateTime[] = [];

  for (const day of dayOrder) {
    if (chosen.length >= count) break;
    const bucket = byDay.get(day)!;
    let perDay = 0;
    for (const { start, dt } of bucket) {
      if (chosen.length >= count) break;
      if (perDay >= MAX_PER_DAY) break;
      const tooClose = chosenDts.some(c => Math.abs(dt.diff(c, 'hours').hours) < MIN_GAP_HOURS);
      if (tooClose) continue;
      chosen.push(start);
      chosenDts.push(dt);
      perDay++;
    }
  }

  // HARD constraint: when returning 3, require ≥2 unique days.
  // If only one day had candidates and we packed 2 from it, we already
  // returned 2 (loop above exits). If somehow 3 collapsed to one day,
  // drop to 2.
  if (chosen.length >= 3) {
    const uniqueDays = new Set(chosenDts.map(dt => dt.toFormat('yyyy-MM-dd')));
    if (uniqueDays.size < 2) {
      chosen.splice(2);
    }
  }

  // Output chronological regardless of day walk order.
  chosen.sort((a, b) => DateTime.fromISO(a).toMillis() - DateTime.fromISO(b).toMillis());
  return chosen;
}

export async function getCalendarEvents(
  userEmail: string,
  startDate: string,
  endDate: string,
  timezone: string = 'UTC'
): Promise<CalendarEvent[]> {
  // v2.4.3 (A3) — per-turn memoization. Trace from 2026-05-03 showed 5
  // identical calendar queries for the same date range within 12 seconds
  // (single booking flow). Pure waste — calendar doesn't change between
  // Sonnet's tool iterations within a single turn. turnCache.memoize
  // returns the same promise to concurrent callers within a turn; outside
  // a turn (background tasks, dispatchers) it bypasses and fetches normally.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { memoize } = require('../../utils/turnCache') as typeof import('../../utils/turnCache');
  const cacheKey = `getCalendarEvents|${userEmail}|${startDate}|${endDate}|${timezone}`;
  return memoize(cacheKey, () => getCalendarEventsImpl(userEmail, startDate, endDate, timezone));
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
  timezone: string
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

  const client = getClient();
  try {
    const response = await client.api(`/users/${callerEmail}/calendar/getSchedule`).post({
      schedules: emails,
      startTime: { dateTime: startDate, timeZone: timezone },
      endTime: { dateTime: endDate, timeZone: timezone },
      availabilityViewInterval: 15,
    });

    const result: Record<string, FreeBusySlot[]> = {};
    for (const schedule of response.value || []) {
      result[schedule.scheduleId] = (schedule.scheduleItems || []).map((item: any) =>
        parseGraphFreeBusySlot(item, timezone),
      );
    }
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

// ── Slot-rule helpers ────────────────────────────────────────────────────────

/**
 * Compute "quality" free time on a day — only counts free chunks ≥ minChunkMinutes.
 * Used for thinking-time protection: skip days where booking would leave the owner
 * with too little uninterrupted free time.
 */
function computeDayQualityFreeMinutes(
  dayDate: string,
  timezone: string,
  workStart: string,
  workEnd: string,
  busyBlocks: Array<{ start: Date; end: Date }>,
  minChunkMinutes: number,
): number {
  const dayStartMs = DateTime.fromISO(`${dayDate}T${workStart}`, { zone: timezone }).toMillis();
  const dayEndMs   = DateTime.fromISO(`${dayDate}T${workEnd}`,   { zone: timezone }).toMillis();

  // Filter and clip busy blocks to this day's work window
  const dayBusy = busyBlocks
    .filter(b => b.start.getTime() < dayEndMs && b.end.getTime() > dayStartMs)
    .map(b => ({
      start: Math.max(b.start.getTime(), dayStartMs),
      end:   Math.min(b.end.getTime(), dayEndMs),
    }))
    .sort((a, b) => a.start - b.start);

  // Merge overlapping blocks
  const merged: Array<{ start: number; end: number }> = [];
  for (const block of dayBusy) {
    if (merged.length > 0 && block.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, block.end);
    } else {
      merged.push({ ...block });
    }
  }

  // Sum free chunks that are ≥ minChunkMinutes
  let totalFreeMin = 0;
  let prev = dayStartMs;
  for (const block of merged) {
    const gapMin = (block.start - prev) / 60_000;
    if (gapMin >= minChunkMinutes) totalFreeMin += gapMin;
    prev = block.end;
  }
  const finalGapMin = (dayEndMs - prev) / 60_000;
  if (finalGapMin >= minChunkMinutes) totalFreeMin += finalGapMin;

  return totalFreeMin;
}

// v2.1 — former `canLunchFitAfterBooking` retired. Replaced by the
// generalized floating-blocks feasibility loop inside findAvailableSlots,
// which uses `utils/floatingBlocks.findAlignedSlotForBlock` (lunch + any
// custom block, day-scoped, quarter-aligned, buffer-compliant, elastic
// detection of matching calendar events).

/**
 * Meeting mode (v1.6.4) — steers the slot search.
 *   in_person : office days only (physical meetings require an office day).
 *   online    : any work day (office or home); day-type is irrelevant.
 *   either    : any work day; results tagged with day_type so the caller can
 *               narrate "Monday in your office or Tuesday from home online."
 *   custom    : venue-driven (client site, offsite, external meeting link).
 *               Caller MUST pass travelBufferMinutes; we pad slots on both
 *               sides so a 1h-drive meeting doesn't crash into the next event.
 *               day_type is returned but the caller usually asks the owner
 *               which day to pick since the venue drives it.
 */
export type MeetingMode = 'in_person' | 'online' | 'either' | 'custom';

export async function findAvailableSlots(params: {
  userEmail: string;
  timezone: string;
  durationMinutes: number;
  attendeeEmails: string[];
  searchFrom: string;
  searchTo: string;
  preferMorning?: boolean;
  workDays?: string[];
  workHoursStart?: string;
  workHoursEnd?: string;
  extendedHours?: boolean;
  minBufferHours?: number;
  profile?: UserProfile;
  // v1.6.4 — mode determines which days are valid + travel buffer
  meetingMode?: MeetingMode;       // default 'either' (back-compat)
  travelBufferMinutes?: number;    // custom mode only; padded on both sides
  // v1.6.4 — auto-expand search until we have ≥3 slots or hit maxSearchDays
  autoExpand?: boolean;            // default true
  maxSearchDays?: number;          // default 21
  // v2.2.3 (#43) — opt-in deeper search. By default we only filter slots
  // against the OWNER's busy time + each attendee's working window (cheap, no
  // assumptions about which of the attendee's meetings are movable). When the
  // recipient explicitly opts in to "find a time I'm free," pass their email
  // here to also subtract their busy time from the candidate pool.
  attendeeBusyEmails?: string[];
  // v2.2.3 (#43) — per-attendee working windows. Slots that fall outside ANY
  // listed attendee's workdays / hoursStart..hoursEnd (in their own TZ) are
  // dropped before Graph cost. Empty / omitted → no clipping.
  attendeeAvailability?: Array<{
    email: string;
    timezone: string;          // IANA
    workdays: Array<'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday'>;
    hoursStart: string;        // 'HH:MM'
    hoursEnd: string;
  }>;
  // v2.3.2 (2A) — owner-override "show me everything" mode. When true:
  //   - skips focus-time protection (free_time_per_office/home_day_hours)
  //   - skips floating-block feasibility check (lunch/coffee/etc. windows)
  //   - widens hours to 07-22 (same as extendedHours)
  // ALWAYS keeps the 5-min buffer between meetings (sacred).
  // Day type (work day vs day off) is also still respected.
  // Caller is expected to narrate to the owner that these slots break their
  // soft rules ("outside your focus protection / lunch window / normal hours").
  relaxed?: boolean;
  // v2.4.1 — events to treat as "the meeting(s) being moved." Each id is
  // matched against the owner's calendar events for the search range and
  // produces TWO behaviors:
  //   1) The event's time range is SUBTRACTED from the owner's busy pool —
  //      so other candidate slots aren't blocked by a meeting that's about
  //      to move away. (Same pattern as floating-block subtraction.)
  //   2) The event's time range is FORBIDDEN as a candidate — so the slot
  //      finder never offers the original time (or any overlap with it) as
  //      a "move target". 11:00 + 10:45 are both excluded when moving an
  //      11:00-11:45 meeting because they're not really moves.
  // Pass when validating ("can we move it to 10:30?") or discovering ("what
  // are options to move it?") a move. Omit for new bookings.
  excludeEventIds?: string[];
  // v2.6 — category scheduling rules. When set, the slot loop applies the
  // category's rules (day_type, per_day, per_week limits) and filters out
  // slots that would violate them. When omitted, no category enforcement
  // (today's behavior). The arg is the category NAME (must match a
  // profile.categories[].name); resolution + rule lookup happens via
  // utils/categoryRules.ts.
  category?: string;
  // v2.6.1 — optional diagnostics output. When passed, the function
  // populates this object by reference with the same per-rule rejection
  // counts + examples it logs at the end of the search. Lets a CALLER
  // (notably the colleague-path Guard B narrow check) read WHY a specific
  // slot was rejected without parsing log lines. Owner direction:
  // findAvailableSlots stays the single source of truth for rule logic;
  // diagnostics ride on the same call. No return-shape change so existing
  // callers are unaffected.
  diagnosticsOut?: {
    rejectedCounts?: Record<string, number>;
    rejectedExamples?: Record<string, string[]>;
    /**
     * Per-day summary across the search window. One entry per workday touched
     * by the slot walker (off-workweek days like Friday/Saturday are omitted).
     * `accepted` is the count of slots that survived all rules for that day;
     * `top_reasons` is the top 2 distinct rejection reasons ordered by count,
     * empty when the day accepted ≥1 slot. Used by Sonnet to narrate honestly
     * when the user asks "why no Monday?" — instead of fabricating.
     */
    daySummary?: Array<{
      date: string;
      accepted: number;
      top_reasons: string[];
      /**
       * Per-attendee blame for this day. Populated when one or more attendees'
       * busy time blocked slots. Empty when the blockers were all owner-side
       * (owner_busy / focus_time / etc). Lets Sonnet narrate "Isaac blocked
       * 8 slots on Monday, that's where it dies" instead of "fully booked."
       */
      blocked_by?: Array<{ email: string; slots_blocked: number }>;
    }>;
  };
}): Promise<Array<{ start: string; end: string; day_type?: 'office' | 'home' | 'other' }>> {
  const meetingMode: MeetingMode = params.meetingMode ?? 'either';
  const autoExpand = params.autoExpand !== false;
  const maxSearchDays = params.maxSearchDays ?? 21;
  // v2.5.4 — category-driven travel buffer. When the requested category has
  // `requires_travel_buffer: true` (e.g. "Outside meeting") AND the caller
  // didn't pass an explicit travel_buffer_minutes, default to 30 min on each
  // side. Owner direction: the buffer fact belongs to the category ("if it's
  // Outside, we need buffer"), the buffer LENGTH is independent of the
  // category and stays fixed at a sensible default for now.
  let effectiveTravelBufferMinutes = params.travelBufferMinutes ?? 0;
  if (params.category && params.profile && effectiveTravelBufferMinutes === 0) {
    const matchedCat = (params.profile.categories ?? []).find(
      c => c.name.toLowerCase() === params.category!.toLowerCase(),
    );
    if (matchedCat?.requires_travel_buffer) {
      effectiveTravelBufferMinutes = 30;
    }
  }
  const travelBufferMs = effectiveTravelBufferMinutes * 60 * 1000;
  // v2.2.3 (#43) — owner-only by default for the busy filter. Don't assume
  // we can / should move attendee meetings. Their work-window clips below.
  // Opt-in deeper search: caller passes attendeeBusyEmails after recipient
  // says "yes look at my calendar."
  const busyFilterEmails = [params.userEmail, ...(params.attendeeBusyEmails ?? [])];

  // v1.6.4 — auto-expand loop. Start with the caller's window; if we find
  // fewer than 3 candidates (empirically the point at which pickSpreadSlots
  // can't produce a useful spread), extend searchTo by +7 days and try
  // again, up to maxSearchDays total. Stops early once we have ≥3.
  const initialFrom = DateTime.fromISO(params.searchFrom, { zone: params.timezone });
  const initialTo = DateTime.fromISO(params.searchTo, { zone: params.timezone });
  const absoluteCap = initialFrom.plus({ days: maxSearchDays });
  let currentTo = initialTo;

  let candidates: Array<{ start: string; end: string; day_type?: 'office' | 'home' | 'other' }> = [];

  while (true) {
    candidates = [];
    const windowFrom = params.searchFrom;
    const windowTo = currentTo.toISO()!;

    const busyMap = await getFreeBusy(params.userEmail, busyFilterEmails, windowFrom, windowTo, params.timezone);

    // FreeBusySlot.start/end now carry an explicit IANA offset (set by
    // parseGraphFreeBusySlot inside getFreeBusy). Luxon honors that offset
    // when parsing, so .toJSDate() yields the correct absolute moment
    // regardless of the second-arg zone hint. Historical context: Graph's
    // getSchedule returns wall-clock-as-UTC without any offset; we used to
    // parse with { zone: 'utc' } to compensate, which broke the moment
    // anyone changed the call site without knowing the convention. The
    // chokepoint helper makes the convention live in the data, not the
    // reader.
    // Tag each busy interval with the email it came from so rule-8 rejections
    // can distinguish owner-vs-attendee blame. Owner direction (2026-05-15):
    // "did Maelle go only for me, or the other?" — pre-fix every busy hit was
    // labeled owner_busy_collision even when an attendee's calendar was the
    // real blocker. Now attendee blocks get `attendee_busy_collision:<email>`
    // and surface per-attendee in day_summary.blocked_by.
    const ownerEmailLower = params.userEmail.toLowerCase();
    const allBusy: Array<{ start: Date; end: Date; email: string }> = [];
    for (const [emailKey, slots] of Object.entries(busyMap)) {
      const email = emailKey.toLowerCase();
      for (const slot of slots) {
        if (slot.status !== 'free') {
          allBusy.push({
            start: DateTime.fromISO(slot.start).toJSDate(),
            end:   DateTime.fromISO(slot.end).toJSDate(),
            email,
          });
        }
      }
    }

    const searchEnd = DateTime.fromISO(windowTo, { zone: params.timezone }).toJSDate();
    const durationMs = params.durationMinutes * 60 * 1000;
    const step = 15 * 60 * 1000;

    // v1.6.4 — meetingMode steers which work days are valid.
    //   in_person → office_days only
    //   online    → office_days + home_days (all work days)
    //   either    → office_days + home_days, tagged so caller can narrate
    //   custom    → office_days + home_days + travel buffer padded
    const profile = params.profile;
    const officeDayNames = profile ? (profile.schedule.office_days.days as string[]) : [];
    const homeDayNames = profile ? (profile.schedule.home_days.days as string[]) : [];
    const defaultWorkDays: string[] =
      params.workDays ?? (profile
        ? (meetingMode === 'in_person' ? officeDayNames : [...officeDayNames, ...homeDayNames])
        : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
    const workDays = meetingMode === 'in_person' && profile
      ? officeDayNames                    // hard constraint: in-person = office only
      : defaultWorkDays;

    const [defaultStartHour, defaultStartMin] = (params.workHoursStart ?? '09:00').split(':').map(Number);
    const [defaultEndHour, defaultEndMin] = (params.workHoursEnd ?? '18:00').split(':').map(Number);

    // ── Buffer from now (hard constraint) ─────────────────────────────────
    const minBufferMs = (params.minBufferHours ?? 0) * 60 * 60 * 1000;
    const earliestAllowed = new Date(Date.now() + minBufferMs);

    // ── Profile-aware settings ────────────────────────────────────────────
    // v1.6.6 — no more "extra buffer around busy blocks" in the search.
    // The owner's allowed durations (10/25/40/55) already bake a 5-min
    // natural trailing buffer into every meeting Maelle books (e.g. a
    // 55-min meeting at 17:00 ends at 17:55, naturally leaving 5 min
    // before 18:00). Applying the profile buffer AGAIN in the isFree
    // check produced artefacts like "17:05" when the previous meeting
    // ended at 17:00 — wrong by design. Connected slots are fine.
    // The only additional padding we keep is travel buffer for custom mode
    // OR for categories with `requires_travel_buffer: true` (v2.5.4).
    const bufferMs = (meetingMode === 'custom' || effectiveTravelBufferMinutes > 0)
      ? travelBufferMs
      : 0;
    const thinkingTimeMinChunk = profile?.meetings.thinking_time_min_chunk_minutes ?? 30;
    // v1.6.11 — per-day-type thinking-time threshold. Office days usually need
    // more protected focus time than home days; profile can set each
    // separately. Home falls back to office value if unset (old profiles).
    const freeTimeOfficeMin = (profile?.meetings.free_time_per_office_day_hours ?? 0) * 60;
    const freeTimeHomeMin = ((profile?.meetings.free_time_per_home_day_hours
      ?? profile?.meetings.free_time_per_office_day_hours ?? 0)) * 60;

    // v2.1 — floating-block feasibility. For every configured floating
    // block (lunch + any custom block, day-scoped via block.days), verify
    // that AFTER placing the proposed meeting here the block still has an
    // aligned, buffer-compliant slot somewhere in its window. Detected
    // calendar events that ARE a floating block are treated as elastic:
    // excluded from the busy-block pool for THAT block's feasibility
    // check (since Maelle can move them). The block-aware path replaces
    // the hardcoded lunch-only check below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fb = require('../../utils/floatingBlocks') as typeof import('../../utils/floatingBlocks');
    const floatingBlocks = profile ? fb.getFloatingBlocks(profile) : [];
    const blockBufferMin = profile?.meetings.buffer_minutes ?? 5;

    // v2.1 — fetch owner's own events for the search range so we can tell
    // WHICH busy slots are floating-block events (lunch, coffee break, etc).
    // getFreeBusy gives status-only, no subjects; to detect a block we need
    // subject/category. One fetch, cached for the whole slot walk.
    // Non-fatal: if this fails, blocks are treated as non-elastic (safer).
    // v2.2.3 (scenario 9 row 7) — also used for the all-day-busy block
    // injection below, so fetch whenever a profile is available, not only
    // when floating blocks are configured.
    let ownerEventsForFb: CalendarEvent[] = [];
    if (profile) {
      try {
        // v2.6 — when a category is set, the rule-check needs to count
        // category occurrences across the FULL day (per_day) and FULL week
        // (per_week) containing each candidate slot. Narrow ±1min checks
        // (create_meeting / move_meeting rule-compliance) would otherwise
        // see 0 events and pass through any limit. Widen the fetch range
        // to cover at least the ISO week containing searchFrom..searchTo.
        // No-op when category is unset — preserves the cheap narrow fetch.
        let fetchFrom = params.searchFrom;
        let fetchTo = params.searchTo;
        if (params.category) {
          const sfDt = DateTime.fromISO(params.searchFrom, { zone: params.timezone });
          const stDt = DateTime.fromISO(params.searchTo, { zone: params.timezone });
          if (sfDt.isValid && stDt.isValid) {
            fetchFrom = sfDt.startOf('week').toISO()!;
            fetchTo = stDt.endOf('week').toISO()!;
          }
        }
        ownerEventsForFb = await getCalendarEvents(
          params.userEmail,
          fetchFrom,
          fetchTo,
          params.timezone,
        );
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const logger = require('../../utils/logger').default;
        logger.warn('findAvailableSlots — owner-events fetch failed', {
          err: String(err),
        });
      }
    }

    // v2.2.3 (scenario 9 row 7) — all-day busy events should block their
    // entire day. Owner direction:
    //   isAllDay && showAs === 'free'  → ignore (already handled, getFreeBusy
    //                                     filters status='free' at line 420)
    //   isAllDay && showAs !== 'free'  → block the entire day
    // Graph getFreeBusy SHOULD return all-day busy as full-day busy intervals,
    // but this is the belt-and-suspenders pass — explicit + deterministic.
    // Pushing duplicate ranges into allBusy is idempotent (slot walker just
    // checks for overlap).
    if (ownerEventsForFb.length > 0) {
      for (const evt of ownerEventsForFb) {
        if (!evt.isAllDay) continue;
        if (evt.isCancelled) continue;
        if (evt.showAs === 'free') continue;  // PTO marked free / WFH "available" / etc
        // All-day busy / oof / tentative / workingElsewhere → full-day block.
        // Graph all-day events span midnight-to-midnight in their declared zone;
        // parse and treat as the whole local day.
        const dayStart = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' })
          .setZone(params.timezone).startOf('day').toJSDate();
        const dayEnd = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' })
          .setZone(params.timezone).endOf('day').toJSDate();
        allBusy.push({ start: dayStart, end: dayEnd, email: ownerEmailLower });
      }
    }

    // v2.1 — remove floating-block time ranges from the base busy pool.
    // Without this, the isFree collision check below would reject any
    // slot that overlaps where lunch currently sits — even though lunch
    // is elastic and Maelle is allowed to move it within its window.
    // Collect block-event ranges and subtract from allBusy (exact-match
    // drop; we don't split partials since floating blocks don't overlap
    // other events by construction).
    if (floatingBlocks.length > 0 && ownerEventsForFb.length > 0) {
      const blockRanges: Array<{ start: number; end: number }> = [];
      for (const evt of ownerEventsForFb) {
        if (evt.isCancelled || evt.isAllDay || evt.showAs === 'free') continue;
        for (const block of floatingBlocks) {
          if (fb.isFloatingBlockEvent(
            { subject: evt.subject, categories: (evt as unknown as { categories?: unknown }).categories },
            block,
          )) {
            const eStart = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' })
              .setZone(params.timezone).toMillis();
            const eEnd = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' })
              .setZone(params.timezone).toMillis();
            blockRanges.push({ start: eStart, end: eEnd });
            break;  // one block-match is enough to exclude this event
          }
        }
      }
      if (blockRanges.length > 0) {
        // In-place filter: drop any busy whose range matches a block range
        // within 1-minute tolerance (Graph / Luxon rounding slack).
        const TOLERANCE_MS = 60 * 1000;
        for (let i = allBusy.length - 1; i >= 0; i--) {
          const b = allBusy[i];
          const bs = b.start.getTime();
          const be = b.end.getTime();
          if (blockRanges.some(r =>
            Math.abs(r.start - bs) <= TOLERANCE_MS && Math.abs(r.end - be) <= TOLERANCE_MS,
          )) {
            allBusy.splice(i, 1);
          }
        }
      }
    }

    // v2.4.1 — moving-event subtraction + forbidden-zone build. When the
    // caller passes excludeEventIds (the meeting(s) being moved), each one
    // is removed from the busy pool (so candidate slots aren't blocked by a
    // meeting that's leaving its current time anyway) AND added to a
    // forbidden-zones list (so the slot walker won't offer the original time
    // as a "move target"). Closes the "move 11:00 to 10:30" / "options to
    // move 11:00" cases that pre-v2.4.1 either over-rejected (treated the
    // meeting as a hard conflict with itself) or would have offered 11:00
    // back as a valid alternative.
    const movingEventForbiddenZones: Array<{ start: number; end: number }> = [];
    if (params.excludeEventIds && params.excludeEventIds.length > 0 && ownerEventsForFb.length > 0) {
      const TOLERANCE_MS = 60 * 1000;
      const idSet = new Set(params.excludeEventIds);
      for (const evt of ownerEventsForFb) {
        if (!idSet.has(evt.id)) continue;
        if (evt.isCancelled || evt.showAs === 'free') continue;
        const eStart = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' })
          .setZone(params.timezone).toMillis();
        const eEnd = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' })
          .setZone(params.timezone).toMillis();
        movingEventForbiddenZones.push({ start: eStart, end: eEnd });
        // Subtract from allBusy (mirror the floating-block in-place filter).
        for (let i = allBusy.length - 1; i >= 0; i--) {
          const b = allBusy[i];
          const bs = b.start.getTime();
          const be = b.end.getTime();
          if (Math.abs(eStart - bs) <= TOLERANCE_MS && Math.abs(eEnd - be) <= TOLERANCE_MS) {
            allBusy.splice(i, 1);
          }
        }
      }
    }

    // Per-day work hours + day-type classifier (office / home / other).
    const classifyDay = (dayName: string): 'office' | 'home' | 'other' => {
      if (officeDayNames.includes(dayName)) return 'office';
      if (homeDayNames.includes(dayName)) return 'home';
      return 'other';
    };
    // v2.8.1 — multi-window per-day work hours. Returns an ARRAY of ranges;
    // a slot is valid if it falls within any one of them. Splits on the
    // yaml `schedule.work_hours[dayName]` if defined; otherwise falls back
    // to legacy office_days/home_days hours.
    const getWorkHoursForDay = (dayName: string): Array<{ startMin: number; endMin: number }> => {
      // `relaxed` mode and `extendedHours` flag widen to a single 07-22 window
      // (or whatever defaultStart/End come from params). Bypasses multi-window
      // so owner's "show me everything" really shows everything.
      if (!profile || params.extendedHours || params.relaxed) {
        return [{
          startMin: defaultStartHour * 60 + defaultStartMin,
          endMin: defaultEndHour * 60 + defaultEndMin,
        }];
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOwnerWorkHoursForDay } = require('../../utils/workHours') as
        typeof import('../../utils/workHours');
      return getOwnerWorkHoursForDay(profile, dayName);
    };

    const minToStr = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    // Pre-compute per-day quality free time (thinking-time check).
    // v2.8.1 — multi-window aware: sum free-minutes across all work windows
    // on the day so a split-shift Tuesday (9-15:30 + 21:30-23:59) gets the
    // total quality time from BOTH windows, not just one.
    const dayFreeTimeCache = new Map<string, number>();
    const getDayQualityFree = (dayDate: string, dayHours: Array<{ startMin: number; endMin: number }>): number => {
      if (dayFreeTimeCache.has(dayDate)) return dayFreeTimeCache.get(dayDate)!;
      let totalFree = 0;
      for (const w of dayHours) {
        totalFree += computeDayQualityFreeMinutes(
          dayDate, params.timezone,
          minToStr(w.startMin), minToStr(w.endMin),
          allBusy, thinkingTimeMinChunk,
        );
      }
      dayFreeTimeCache.set(dayDate, totalFree);
      return totalFree;
    };

    // v2.0.9 — walker collects ALL valid 15-min-stepped candidates per day
    // into dayBuckets. After the walker, per-day post-processing picks up to
    // MAX_PER_DAY with 30-min preferred spacing and 15-min fallback. Prior
    // chronological-slice(10) truncated the rest of the week whenever Sunday
    // had 10+ hits; hard-capping the walker at 4/day would also over-cluster
    // in 15-min increments. Two-stage approach gives both day-diversity AND
    // nice intra-day spacing ("10, 10:30, 11:30, 14:00" not "10, 10:15,
    // 10:30, 10:45").
    const MAX_PER_DAY = 4;
    const PREFERRED_GAP_MS = 30 * 60 * 1000;
    const dayBuckets: Map<string, Array<{ start: string; end: string; day_type?: 'office' | 'home' | 'other' }>> = new Map();

    // v2.3.6 (#71a) — diagnostic rejection counters. Helps debug "why was 17:45
    // rejected?" by showing the per-rule breakdown at the end of the search.
    // Each rejection point increments its bucket; we also track up to 5 example
    // rejected slots per reason for grepping in logs.
    const rejectedCounts: Record<string, number> = {};
    const rejectedExamples: Record<string, string[]> = {};
    // Per-day reason aggregation. Same trackReject feeds both global counts
    // and per-day. The per-day map drives the daySummary that's surfaced to
    // Sonnet via diagnosticsOut so she can narrate "Monday was fully booked"
    // instead of fabricating "Monday is a day off."
    const dayReasons = new Map<string, Map<string, number>>();
    const trackReject = (reason: string, slotIso: string) => {
      rejectedCounts[reason] = (rejectedCounts[reason] ?? 0) + 1;
      if (!rejectedExamples[reason]) rejectedExamples[reason] = [];
      if (rejectedExamples[reason].length < 5) rejectedExamples[reason].push(slotIso);
      const day = slotIso.slice(0, 10);  // yyyy-MM-dd prefix of ISO
      let dayMap = dayReasons.get(day);
      if (!dayMap) { dayMap = new Map(); dayReasons.set(day, dayMap); }
      dayMap.set(reason, (dayMap.get(reason) ?? 0) + 1);
    };

    // All workweek days regardless of meetingMode filter — used to detect
    // when a workday was excluded specifically because of the requested mode
    // (e.g. Monday is a home day; meetingMode='in_person' excludes it). We
    // surface this as `wrong_day_type` in daySummary so Sonnet can narrate
    // "Monday is a home day, in-person needs an office day" instead of
    // fabricating "Monday is a day off."
    const allWorkweekDays: string[] = profile
      ? [...officeDayNames, ...homeDayNames]
      : workDays;

    let cursor = DateTime.fromISO(params.searchFrom, { zone: params.timezone }).toJSDate();
    while (cursor.getTime() + durationMs <= searchEnd.getTime()) {
      const cursorDt = DateTime.fromJSDate(cursor).setZone(params.timezone);
      const dayName = cursorDt.toFormat('EEEE');
      const dayKey = cursorDt.toFormat('yyyy-MM-dd');

      if (!workDays.includes(dayName)) {
        // Track once per day when this workweek day was excluded by meetingMode
        // (e.g. home day with mode='in_person'). Pure off-workweek days
        // (Fri/Sat for Israel) skip silently — they're not interesting to
        // surface.
        if (allWorkweekDays.includes(dayName) && !dayReasons.has(dayKey)) {
          dayReasons.set(dayKey, new Map([['wrong_day_type', 1]]));
        }
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      const dayHours = getWorkHoursForDay(dayName);
      if (dayHours.length === 0) {
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      const slotTotalMin = cursorDt.hour * 60 + cursorDt.minute;
      const slotEndMin = slotTotalMin + params.durationMinutes;
      const inAnyWindow = dayHours.some(w => slotTotalMin >= w.startMin && slotEndMin <= w.endMin);
      if (!inAnyWindow) {
        trackReject('outside_owner_work_hours', cursorDt.toISO()!);
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      if (cursor.getTime() < earliestAllowed.getTime()) {
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      const slotEnd = new Date(cursor.getTime() + durationMs);
      // v2.6.5 — split rejection labels. Pre-split the check lumped actual
      // overlap with within-buffer collisions under one label
      // (`owner_busy_or_buffer_collision`). The colleague-path treated both
      // the same and escalated to policy_exception approval — owner's
      // 5-min buffer is a HELPER (a preference for healthy back-to-backs),
      // not a hard rule. With the split, colleague-path can proceed on
      // buffer-only collisions and reserve approval for genuine overlap.
      const overlapsBusy = allBusy.find(busy =>
        cursor.getTime() < busy.end.getTime() &&
        slotEnd.getTime() > busy.start.getTime()
      );
      if (overlapsBusy) {
        // v2.7.6 — attribute by email. Owner's own busy stays
        // `owner_busy_collision`; an attendee's busy time becomes
        // `attendee_busy_collision:<email>` so Sonnet can narrate WHO is
        // blocking (closes "Monday fully booked" misattribution).
        const label = overlapsBusy.email === ownerEmailLower
          ? 'owner_busy_collision'
          : `attendee_busy_collision:${overlapsBusy.email}`;
        trackReject(label, cursorDt.toISO()!);
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      const withinBuffer = bufferMs > 0 && allBusy.find(busy =>
        cursor.getTime() < busy.end.getTime() + bufferMs &&
        slotEnd.getTime() > busy.start.getTime() - bufferMs
      );
      if (withinBuffer) {
        trackReject('owner_buffer_collision', cursorDt.toISO()!);
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      // v2.4.1 — forbid candidates that overlap the meeting being moved.
      // Without this, "options to move 11:00-11:45" would offer 11:00 (no
      // move at all) and 10:45-11:25 (15-min shift, basically same slot).
      // Owner direction: "the entire meeting time is block" for offered
      // alternatives. Pure overlap check (no buffer pad — the moving event
      // is leaving, no need to keep distance from itself).
      if (movingEventForbiddenZones.length > 0) {
        const overlapsMovingEvent = movingEventForbiddenZones.some(zone =>
          cursor.getTime() < zone.end && slotEnd.getTime() > zone.start
        );
        if (overlapsMovingEvent) {
          trackReject('overlaps_meeting_being_moved', cursorDt.toISO()!);
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
      }
      // v2.2.3 (#43) — per-attendee work-window clip. Drop slots that fall
      // outside ANY attendee's working window in their own TZ. No Graph cost
      // (pure math against people_memory data threaded in by the caller).
      // Attendees with no availability data are skipped (no clip — back-compat).
      if (params.attendeeAvailability && params.attendeeAvailability.length > 0) {
        const slotOutsideAnyAttendee = params.attendeeAvailability.some(att => {
          try {
            const attStart = DateTime.fromJSDate(cursor).setZone(att.timezone);
            const attEnd = DateTime.fromJSDate(slotEnd).setZone(att.timezone);
            if (!attStart.isValid || !attEnd.isValid) return false;
            const attDay = attStart.toFormat('EEEE') as 'Sunday'|'Monday'|'Tuesday'|'Wednesday'|'Thursday'|'Friday'|'Saturday';
            if (!att.workdays.includes(attDay)) return true;  // outside their workdays
            // Compare HH:MM as minutes-of-day in attendee TZ
            const [shH, shM] = att.hoursStart.split(':').map(Number);
            const [ehH, ehM] = att.hoursEnd.split(':').map(Number);
            const startMin = attStart.hour * 60 + attStart.minute;
            const endMin = attEnd.hour * 60 + attEnd.minute;
            const winStart = shH * 60 + shM;
            const winEnd = ehH * 60 + ehM;
            // Slot must START at or after winStart AND END at or before winEnd
            return startMin < winStart || endMin > winEnd;
          } catch {
            return false;  // any parse error → don't filter on this attendee
          }
        });
        if (slotOutsideAnyAttendee) {
          trackReject('outside_attendee_work_hours', cursorDt.toISO()!);
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
      }
      // v2.3.2 (2A) — focus-time protection skipped in relaxed mode. Owner
      // explicitly opted in; he sees the trade-off in the narration.
      if (profile && !params.relaxed) {
        // v1.6.11 — threshold depends on whether this is an office or home day
        const dayType = classifyDay(dayName);
        const thresholdMin =
          dayType === 'office' ? freeTimeOfficeMin
          : dayType === 'home' ? freeTimeHomeMin
          : 0;
        if (thresholdMin > 0) {
          const dayDate = cursorDt.toFormat('yyyy-MM-dd');
          const dayFreeMin = getDayQualityFree(dayDate, dayHours);
          if (dayFreeMin - params.durationMinutes < thresholdMin) {
            trackReject(`focus_time_${dayType}`, cursorDt.toISO()!);
            cursor = new Date(cursor.getTime() + step);
            continue;
          }
        }
      }
      // v2.1 — floating-block feasibility (replaces the old hardcoded
      // lunch-only check). For every block that applies to THIS day,
      // verify a quarter-aligned buffer-compliant slot still exists in
      // the window after adding the proposed meeting. Detected events
      // that ARE this block are excluded from the busy-block pool —
      // Maelle can reshuffle them inside the window. Blocks that don't
      // apply on this day (e.g. "Thursday coffee break" on a Monday) or
      // that are `can_skip:true` and truly have no room simply skip the
      // feasibility check for this slot.
      // v2.3.2 (2A) — floating-block feasibility skipped in relaxed mode.
      // Owner sees the trade-off in narration ("squeezes lunch").
      if (profile && floatingBlocks.length > 0 && !params.relaxed) {
        const dayDate = cursorDt.toFormat('yyyy-MM-dd');
        let blockConflict = false;
        for (const block of floatingBlocks) {
          if (!fb.blockAppliesOnDay(block, dayName, profile)) continue;

          const winStart = fb.windowMsForDay(dayDate, block.preferred_start, params.timezone);
          const winEnd = fb.windowMsForDay(dayDate, block.preferred_end, params.timezone);
          // Proposed slot touches this block's window?
          if (slotEnd.getTime() <= winStart || cursor.getTime() >= winEnd) continue;

          // Build busyInWindow from OWNER EVENTS for this day,
          // EXCLUDING any event that looks like THIS block (because
          // Maelle can move it) and INCLUDING the proposed meeting.
          const busyInWindow: Array<{ start: number; end: number }> = [];
          for (const evt of ownerEventsForFb) {
            if (evt.isCancelled || evt.isAllDay || evt.showAs === 'free') continue;
            if (fb.isFloatingBlockEvent(
              { subject: evt.subject, categories: (evt as unknown as { categories?: unknown }).categories },
              block,
            )) continue;  // elastic — skip
            const eStart = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' })
              .setZone(params.timezone).toMillis();
            const eEnd = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' })
              .setZone(params.timezone).toMillis();
            if (eStart < winEnd && eEnd > winStart) {
              busyInWindow.push({
                start: Math.max(eStart, winStart),
                end: Math.min(eEnd, winEnd),
              });
            }
          }
          busyInWindow.push({
            start: Math.max(cursor.getTime(), winStart),
            end: Math.min(slotEnd.getTime(), winEnd),
          });

          const aligned = fb.findAlignedSlotForBlock(
            block, dayDate, params.timezone, busyInWindow, blockBufferMin,
          );
          if (aligned === null && !block.can_skip) {
            blockConflict = true;
            break;
          }
        }
        if (blockConflict) {
          trackReject('floating_block_no_room', cursorDt.toISO()!);
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
      }

      // v2.6 — category scheduling rules. When the caller passed a category,
      // check this slot against the category's day_type / per_day / per_week
      // limits. Reject if any rule fires; otherwise let the slot through.
      // Skipped in relaxed mode (owner override) to mirror floating-block
      // feasibility behavior — relaxed already implies "show me everything,
      // I'll narrate the costs."
      if (params.category && !params.relaxed && params.profile) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cr = require('../../utils/categoryRules') as typeof import('../../utils/categoryRules');
        const result = cr.checkCategorySlot({
          slotStart: cursorDt,
          slotEnd: DateTime.fromJSDate(slotEnd).setZone(params.timezone),
          categoryName: params.category,
          events: ownerEventsForFb,
          profile: params.profile,
        });
        if (!result.allowed) {
          const reason = result.rule_broken === 'day_type' ? 'category_day_type'
                       : result.rule_broken === 'per_day' ? 'category_per_day'
                       : 'category_per_week';
          trackReject(reason, cursorDt.toISO()!);
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
      }

      if (!dayBuckets.has(dayKey)) dayBuckets.set(dayKey, []);
      // v2.4.2 — emit local-zoned ISO with explicit offset (e.g.
      // "2026-05-05T09:00:00.000+03:00") instead of UTC ("...Z"). Matches the
      // convention established by the v2.3.4 parseGraphFreeBusySlot chokepoint.
      // Pre-v2.4.2 used `cursor.toISOString()` which always emits UTC,
      // forcing Sonnet to mentally convert and narrate "the slots are
      // returning in UTC, converting to Israel time" — both an INTERNALS
      // leak and a real risk of conversion errors.
      const cursorLocal = DateTime.fromJSDate(cursor).setZone(params.timezone);
      const slotEndLocal = DateTime.fromJSDate(slotEnd).setZone(params.timezone);
      dayBuckets.get(dayKey)!.push({
        start: cursorLocal.toISO()!,
        end: slotEndLocal.toISO()!,
        day_type: classifyDay(dayName),
      });
      cursor = new Date(cursor.getTime() + step);
    }

    // v2.0.9 — per-day selection. For each day, pick up to MAX_PER_DAY with
    // PREFERRED_GAP (30 min) between picks; if that yields fewer than
    // MAX_PER_DAY, fill remaining from the unused list at 15-min spacing.
    // Owner preference: "10, 10:30, 11:30, 14:00" > "10, 10:15, 10:30, 10:45".
    for (const [, daySlots] of dayBuckets) {
      if (daySlots.length === 0) continue;
      const picked: typeof daySlots = [daySlots[0]];
      let lastTime = new Date(daySlots[0].start).getTime();
      for (let i = 1; i < daySlots.length && picked.length < MAX_PER_DAY; i++) {
        const t = new Date(daySlots[i].start).getTime();
        if (t - lastTime >= PREFERRED_GAP_MS) {
          picked.push(daySlots[i]);
          lastTime = t;
        }
      }
      // Fallback: if we still have room, fill with anything we skipped (15-min
      // spacing allowed). Re-sort chronologically after to keep output tidy.
      if (picked.length < MAX_PER_DAY) {
        const pickedSet = new Set(picked.map(p => p.start));
        for (let i = 0; i < daySlots.length && picked.length < MAX_PER_DAY; i++) {
          if (!pickedSet.has(daySlots[i].start)) picked.push(daySlots[i]);
        }
        picked.sort((a, b) => a.start.localeCompare(b.start));
      }
      candidates.push(...picked);
    }

    // v2.3.6 (#71a) — diagnostic log for rejection reasons. When a slot
    // search returns fewer slots than expected (or zero), this log line
    // tells WHICH RULE rejected what. Grep `findAvailableSlots — rejection
    // breakdown` in maelle-YYYY-MM-DD.log to debug "why was 17:45 not
    // proposed?".
    if (Object.keys(rejectedCounts).length > 0) {
      logger.info('findAvailableSlots — rejection breakdown', {
        searchFrom: params.searchFrom,
        searchTo: currentTo.toISO(),
        durationMinutes: params.durationMinutes,
        relaxed: params.relaxed === true,
        candidatesAccepted: candidates.length,
        rejectedCounts,
        rejectedExamples,
      });
      // v2.6.1 — also surface to the caller via diagnosticsOut, if passed.
      // Used by colleague-path create_meeting Guard B to extract the
      // SPECIFIC rule that rejected a narrow-window slot, so the refusal
      // returned to Sonnet can name it (broken_rule_label) instead of
      // forcing Sonnet to guess. Last call wins on auto-expand reruns —
      // that's the loop's final verdict, which is what callers care about.
      if (params.diagnosticsOut) {
        params.diagnosticsOut.rejectedCounts = rejectedCounts;
        params.diagnosticsOut.rejectedExamples = rejectedExamples;

        // Per-day summary for Sonnet's narration. accepted=count of slots
        // surviving all rules per day; top_reasons=top 2 rejection causes when
        // accepted=0. `outside_owner_work_hours` is iteration noise (every
        // quarter-hour outside work hours gets tracked) — excluded from
        // top_reasons.
        const IRRELEVANT_FOR_DAY = new Set(['outside_owner_work_hours']);
        const acceptedPerDay = new Map<string, number>();
        for (const c of candidates) {
          const day = c.start.slice(0, 10);
          acceptedPerDay.set(day, (acceptedPerDay.get(day) ?? 0) + 1);
        }
        const allDays = new Set<string>([...acceptedPerDay.keys(), ...dayReasons.keys()]);
        const daySummary = [...allDays].sort().map(date => {
          const accepted = acceptedPerDay.get(date) ?? 0;
          let top_reasons: string[] = [];
          let blocked_by: Array<{ email: string; slots_blocked: number }> | undefined;
          if (accepted === 0) {
            const reasons = dayReasons.get(date);
            if (reasons) {
              // Split per-attendee labels (`attendee_busy_collision:<email>`)
              // out into the blocked_by aggregate, and collapse them to the
              // single canonical label in top_reasons so output stays clean.
              const perAttendee = new Map<string, number>();
              const reasonCounts = new Map<string, number>();
              for (const [r, c] of reasons.entries()) {
                if (r.startsWith('attendee_busy_collision:')) {
                  const email = r.slice('attendee_busy_collision:'.length);
                  perAttendee.set(email, (perAttendee.get(email) ?? 0) + c);
                  reasonCounts.set('attendee_busy_collision',
                    (reasonCounts.get('attendee_busy_collision') ?? 0) + c);
                } else {
                  reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + c);
                }
              }
              const ranked = [...reasonCounts.entries()]
                .filter(([r]) => !IRRELEVANT_FOR_DAY.has(r))
                .sort((a, b) => b[1] - a[1])
                .map(([r]) => r);
              top_reasons = ranked.slice(0, 2);
              if (top_reasons.length === 0 && reasonCounts.size > 0) {
                const first = reasonCounts.keys().next().value;
                if (first) top_reasons = [first];
              }
              if (perAttendee.size > 0) {
                blocked_by = [...perAttendee.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([email, slots_blocked]) => ({ email, slots_blocked }));
              }
            }
          }
          return blocked_by
            ? { date, accepted, top_reasons, blocked_by }
            : { date, accepted, top_reasons };
        });
        params.diagnosticsOut.daySummary = daySummary;
      }
    }

    // v1.6.4 — enough? If yes, stop. Otherwise extend the window (but not
    // past the absolute cap) and try again.
    if (candidates.length >= 3 || !autoExpand) break;
    const nextTo = currentTo.plus({ days: 7 });
    if (nextTo.toMillis() > absoluteCap.toMillis()) {
      // Can't expand further — try one final pass at the cap, then stop.
      if (currentTo.toMillis() >= absoluteCap.toMillis()) break;
      currentTo = absoluteCap;
      continue;
    }
    currentTo = nextTo;
  }

  // v2.0.9 — cap raised from 10 to 30. With MAX_PER_DAY=4 and up to 5 work
  // days in a typical week (Sun-Thu in Israel / Mon-Fri elsewhere), 4 × 5 =
  // 20 is the normal maximum; 30 gives headroom if a multi-week search
  // window somehow slips through. pickSpreadSlots still narrows to the final
  // 3. The old cap of 10 combined with chronological candidate accumulation
  // meant a single open morning could dominate the output.
  return candidates.slice(0, 30);
}

export interface UpdateMeetingParams {
  userEmail: string;
  meetingId: string;
  timezone: string;
  subject?: string;
  start?: string;
  end?: string;
  body?: string;
  categories?: string[];
  // v2.7.0 — optional location + isOnline. Lets move_meeting flip the
  // location when a move crosses day-type (office↔home). Pass-through to
  // Graph PATCH; when omitted, the event's existing location/isOnlineMeeting
  // are preserved.
  location?: string;
  isOnline?: boolean;
  // v2.9.1 — optional full attendee list. When provided, Graph PATCH replaces
  // the event's attendees array. Caller is responsible for assembling the
  // FINAL list (existing - removed + added) before passing — Graph does not
  // diff. Omit entirely to leave attendees untouched.
  attendees?: Array<{ name?: string; email: string; optional?: boolean }>;
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
}> {
  const client = getClient();
  const event = await client
    .api(`/users/${userEmail}/events/${meetingId}`)
    .select('id,type,subject,seriesMasterId,start')
    .get();
  return {
    type: event?.type,
    subject: event?.subject,
    seriesMasterId: event?.seriesMasterId,
    startDateTime: event?.start?.dateTime,
    startTimeZone: event?.start?.timeZone,
  };
}

/**
 * v2.2.7 — Normalize an ISO datetime for Graph's `dateTime` field. Graph honors
 * any offset/Z in `dateTime` over the sibling `timeZone` field, so an ISO with
 * `Z` lands the event in UTC even when we also send timeZone='Asia/Jerusalem'.
 * Strip the offset, convert to the target timezone's wall-clock, emit zoneless.
 * Fix-once-here so every Graph mutation is consistent regardless of what
 * shape Sonnet (or any caller) handed us.
 */
function normalizeForGraph(iso: string, tz: string): string {
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) return iso;  // fail open — let Graph reject if truly malformed
  return dt.setZone(tz).toISO({ includeOffset: false, suppressMilliseconds: true })!;
}

export async function updateMeeting(params: UpdateMeetingParams): Promise<void> {
  const client = getClient();

  const patch: Record<string, unknown> = {};
  if (params.subject)    patch.subject    = params.subject;
  if (params.start)      patch.start      = { dateTime: normalizeForGraph(params.start, params.timezone), timeZone: params.timezone };
  if (params.end)        patch.end        = { dateTime: normalizeForGraph(params.end,   params.timezone), timeZone: params.timezone };
  if (params.body)       patch.body       = { contentType: 'HTML', content: params.body };
  if (params.categories) patch.categories = params.categories;
  // v2.7.0 — location + isOnline pass-through.
  // Empty string on location clears it on Graph's side (e.g. office→home flip
  // moves to Teams-only with no physical address). Explicit undefined skips
  // the field entirely so existing location is preserved.
  if (params.location !== undefined) {
    patch.location = { displayName: params.location };
  }
  if (params.isOnline !== undefined) {
    patch.isOnlineMeeting = params.isOnline;
  }
  // v2.9.1 — attendees PATCH. Graph replaces the whole array. Caller built
  // the final list (existing - removed + added) already.
  if (params.attendees !== undefined) {
    patch.attendees = params.attendees.map(a => ({
      emailAddress: { name: a.name ?? a.email, address: a.email },
      type: a.optional ? 'optional' : 'required',
    }));
  }

  try {
    await client.api(`/users/${params.userEmail}/events/${params.meetingId}`).patch(patch);

    auditLog({
      action: 'update_meeting',
      source: 'graph_api',
      actor: 'assistant',
      target: params.meetingId,
      details: { subject: params.subject, start: params.start },
      outcome: 'success',
    });

    logger.info('Meeting updated', { id: params.meetingId, subject: params.subject, start: params.start });
  } catch (err) {
    auditLog({
      action: 'update_meeting',
      source: 'graph_api',
      actor: 'assistant',
      target: params.meetingId,
      details: { error: String(err) },
      outcome: 'failure',
    });
    logger.error('Failed to update meeting', { err, meetingId: params.meetingId });
    throw err;
  }
}

export async function deleteMeeting(
  userEmail: string,
  meetingId: string,
  options: { comment?: string } = {},
): Promise<void> {
  const client = getClient();

  // v2.8.6 — use Graph's POST /cancel endpoint instead of bare DELETE. Pre-fix
  // `.delete()` removed the event from the organizer's calendar but did NOT
  // reliably send cancellation invites to attendees — they'd keep orphaned
  // copies of the meeting on their own calendars (root of the 2026-05-18 Dirk
  // incident: Maelle "deleted" the meeting from owner's view but Dirk's copy
  // stayed for hours, owner had to manually delete it).
  //
  // /cancel is the right endpoint: it sends a "Cancelled: <subject>" invite
  // to every attendee AND removes the event from the organizer's calendar in
  // one call. Requires the user to be the organizer; non-organizer cancels
  // (when owner is invited to someone else's meeting) take the v2.7.0
  // not_organizer path instead, which never reaches here.
  //
  // Fallback: if Graph rejects /cancel (rare — happens when the event is in
  // a draft state with no attendees), retry with DELETE. Solo events
  // ("personal block" with no attendees) tolerate either endpoint.
  try {
    await client.api(`/users/${userEmail}/events/${meetingId}/cancel`).post({
      Comment: options.comment ?? '',
    });
    return;
  } catch (err: any) {
    const code = err?.statusCode ?? err?.code;
    // 400 BadRequest happens when the event has no attendees — fall back to
    // DELETE (which is the right call for solo events anyway).
    if (code === 400 || code === 'ErrorMissingArgument') {
      logger.info('deleteMeeting — /cancel rejected (likely no attendees), falling back to DELETE', {
        meetingId, code,
      });
      await client.api(`/users/${userEmail}/events/${meetingId}`).delete();
      return;
    }
    throw err;
  }
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
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'start_drift'; got?: string; expected?: string };

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

export async function createMeeting(params: CreateMeetingParams): Promise<CreatedMeeting> {
  const client = getClient();

  // Teams-location sanitization: when isOnline=true, Graph auto-creates the
  // Teams meeting and populates the location with the actual join link.
  // If we ALSO pass a plain string like "Microsoft Teams" / "Teams" as the
  // displayName, Graph stores the string and fails to link it — Outlook shows
  // "Microsoft Teams — Unknown / No address". Drop those sentinel strings.
  // Real physical locations ("Idan's Office", "Meeting Room", "Slack Huddle",
  // "+972-..." phone numbers, "WeWork Sarona") pass through unchanged so the
  // location pill still shows them alongside the auto-generated Teams link.
  const isTeamsSentinel = (s?: string): boolean => {
    if (!s) return false;
    const n = s.trim().toLowerCase();
    return n === 'teams' || n === 'ms teams' || n === 'microsoft teams' || n === 'teams meeting' || n === 'microsoft teams meeting';
  };
  const effectiveLocation = (params.isOnline && isTeamsSentinel(params.location))
    ? undefined
    : params.location;

  const defaultBody = params.defaultBodyAuthor
    ? `<p>Meeting booked by ${params.defaultBodyAuthor}.</p>`
    : `<p>Meeting scheduled by your executive assistant.</p>`;

  // All-day normalization. Graph requires isAllDay events to start at 00:00
  // of the day and end at 00:00 of the NEXT day (both in user TZ). Any other
  // shape Graph rejects or silently degrades to a non-all-day 0-min event
  // (the bug owner saw before this fix). Normalize here regardless of what
  // the caller passed — a "Sunday all-day" becomes Sun 00:00 → Mon 00:00.
  let startIso = params.start;
  let endIso = params.end;
  if (params.isAllDay) {
    const startDt = DateTime.fromISO(params.start, { zone: params.timezone });
    if (startDt.isValid) {
      const dayStart = startDt.startOf('day');
      const dayEnd = dayStart.plus({ days: 1 });
      startIso = dayStart.toISO()!;
      endIso = dayEnd.toISO()!;
    }
  }

  const event: Record<string, unknown> = {
    subject: params.subject,
    body: {
      contentType: 'HTML',
      content: params.body || defaultBody,
    },
    start: { dateTime: normalizeForGraph(startIso, params.timezone), timeZone: params.timezone },
    end:   { dateTime: normalizeForGraph(endIso,   params.timezone), timeZone: params.timezone },
    attendees: params.attendees.map(a => ({
      emailAddress: { address: a.email, name: a.name },
      type: a.optional ? 'optional' : 'required',
    })),
    isOnlineMeeting: params.isOnline ?? false,
    ...(params.isOnline && {
      onlineMeetingProvider: params.onlineMeetingProvider ?? 'teamsForBusiness',
    }),
    ...(effectiveLocation && { location:    { displayName: effectiveLocation } }),
    ...(params.categories  && { categories:  params.categories }),
    ...(params.sensitivity && { sensitivity: params.sensitivity }),
    ...(params.isAllDay    && { isAllDay:    true }),
  };

  try {
    const created = await client.api(`/users/${params.userEmail}/events`).post(event);

    auditLog({
      action: 'create_meeting',
      source: 'graph_api',
      actor: 'assistant',
      target: created.id,
      details: { subject: params.subject, start: params.start, attendees: params.attendees },
      outcome: 'success',
    });

    logger.info('Meeting created', { id: created.id, subject: params.subject, start: params.start });
    const joinUrl: string | undefined = created?.onlineMeeting?.joinUrl;
    return { id: created.id, joinUrl };
  } catch (err) {
    auditLog({
      action: 'create_meeting',
      source: 'graph_api',
      actor: 'assistant',
      details: { subject: params.subject, error: String(err) },
      outcome: 'failure',
    });
    logger.error('Failed to create meeting', { err, subject: params.subject });
    throw err;
  }
}
