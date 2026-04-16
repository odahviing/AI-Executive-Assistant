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
  bodyPreview?: string;
}

export interface FreeBusySlot {
  start: string;
  end: string;
  status: 'free' | 'busy' | 'tentative' | 'oof' | 'workingElsewhere' | 'unknown';
}

export interface CreateMeetingParams {
  subject: string;
  start: string;
  end: string;
  attendees: Array<{ name: string; email: string }>;
  body?: string;
  isOnline?: boolean;         // true = generate Teams meeting link
  location?: string;          // display name e.g. "Idan's office", "Meeting Room"
  onlineMeetingProvider?: 'teamsForBusiness' | 'skypeForBusiness';
  categories?:  string[];     // Outlook category names, e.g. ["Meeting"] or ["Physical"]
  sensitivity?: 'normal' | 'personal' | 'private' | 'confidential';
  userEmail: string;
  timezone: string;
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
 * Picks up to `count` well-spread slots from a candidate list.
 *
 * Priority:
 *   1. Different days (ideal: all 3 on different days)
 *   2. If fewer than `count` days available: allow same-day slots,
 *      but require ≥ 2 hours gap between any two slots on the same day.
 *   3. Fallback: ≥ 30 min gap (better than nothing).
 *
 * This prevents Maelle from proposing Monday 09:00 / 09:30 / 10:00
 * when a single meeting could block all three.
 */
export function pickSpreadSlots(
  slots: Array<{ start: string }>,
  timezone: string,
  count = 3,
): string[] {
  const PREFERRED_GAP_HOURS = 2;
  const MIN_GAP_HOURS = 0.5;
  const chosen: string[] = [];
  const chosenDts: DateTime[] = [];

  // Pass 1: one slot per day
  const seenDays = new Set<string>();
  for (const slot of slots) {
    const dt = DateTime.fromISO(slot.start).setZone(timezone);
    const day = dt.toFormat('yyyy-MM-dd');
    if (!seenDays.has(day)) {
      chosen.push(slot.start);
      chosenDts.push(dt);
      seenDays.add(day);
      if (chosen.length >= count) return chosen;
    }
  }

  // Pass 2: same-day allowed but ≥ PREFERRED_GAP_HOURS apart from all chosen
  for (const slot of slots) {
    if (chosen.includes(slot.start)) continue;
    const dt = DateTime.fromISO(slot.start).setZone(timezone);
    const tooClose = chosenDts.some(c => Math.abs(dt.diff(c, 'hours').hours) < PREFERRED_GAP_HOURS);
    if (!tooClose) {
      chosen.push(slot.start);
      chosenDts.push(dt);
      if (chosen.length >= count) return chosen;
    }
  }

  // Pass 3: last resort — relax to MIN_GAP_HOURS
  for (const slot of slots) {
    if (chosen.includes(slot.start)) continue;
    const dt = DateTime.fromISO(slot.start).setZone(timezone);
    const tooClose = chosenDts.some(c => Math.abs(dt.diff(c, 'hours').hours) < MIN_GAP_HOURS);
    if (!tooClose) {
      chosen.push(slot.start);
      chosenDts.push(dt);
      if (chosen.length >= count) break;
    }
  }

  // HARD constraint: at least 2 unique days when returning 3+ slots.
  // If all chosen are on the same day, cap at 2 so the caller expands the search window.
  if (chosen.length >= 3) {
    const uniqueDays = new Set(chosenDts.map(dt => dt.toFormat('yyyy-MM-dd')));
    if (uniqueDays.size < 2) {
      chosen.splice(2);
    }
  }

  // Return chronologically ordered — discovery passes can produce out-of-order
  // results (e.g. Sun, Mon, Sun) which feels strange when shown to a human.
  chosen.sort((a, b) => DateTime.fromISO(a).toMillis() - DateTime.fromISO(b).toMillis());
  return chosen;
}

export async function getCalendarEvents(
  userEmail: string,
  startDate: string,
  endDate: string,
  timezone: string = 'UTC'
): Promise<CalendarEvent[]> {
  const client = getClient();

  // Normalise dates: strip Z/ms suffix so Graph uses the mailbox timezone
  // Also ensure we always query the FULL day — never start mid-day
  const cleanStart = toStartOfDayLocal(startDate, timezone);
  const cleanEnd   = toEndOfDayLocal(endDate, timezone);

  logger.info('Querying calendar', { userEmail, start: cleanStart, end: cleanEnd });

  try {
    const response = await client
      .api(`/users/${userEmail}/calendarView`)
      .header('Prefer', `outlook.timezone="${timezone}"`)
      .query({
        startDateTime: cleanStart,
        endDateTime: cleanEnd,
        $select: 'id,subject,start,end,isAllDay,importance,showAs,sensitivity,categories,organizer,attendees,isCancelled,isOnlineMeeting,onlineMeetingUrl,bodyPreview',
        $orderby: 'start/dateTime',
        $top: 100,
      })
      .get();

    const count = response.value?.length ?? 0;
    logger.info('Calendar events fetched', { count, start: cleanStart, end: cleanEnd });
    return response.value || [];
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
      result[schedule.scheduleId] = (schedule.scheduleItems || []).map((item: any) => ({
        start: item.start.dateTime,
        end: item.end.dateTime,
        status: item.status,
      }));
    }
    return result;
  } catch (err: any) {
    logger.error('Failed to fetch free/busy', { err, emails });

    // 403 / ErrorAccessDenied means the Azure app lacks Calendars.Read application
    // permission (admin consent required in the Reflectiz tenant).
    // Surface this as a typed error so callers can give a useful message.
    if (err?.statusCode === 403 || err?.code === 'ErrorAccessDenied') {
      throw new GraphPermissionError(
        'getFreeBusy',
        'The Azure app does not have Calendars.Read permission to query other users\' availability. ' +
        'A tenant admin needs to grant Calendars.Read application permission in Azure AD.',
      );
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

/**
 * Check whether lunch can still fit in the lunch window after adding a proposed slot.
 * Returns true if there's a contiguous free block ≥ lunchDurationMinutes remaining.
 */
function canLunchFitAfterBooking(
  dayDate: string,
  timezone: string,
  lunchStart: string,
  lunchEnd: string,
  lunchDurationMinutes: number,
  busyBlocks: Array<{ start: Date; end: Date }>,
  proposedStart: Date,
  proposedEnd: Date,
): boolean {
  const lStartMs = DateTime.fromISO(`${dayDate}T${lunchStart}`, { zone: timezone }).toMillis();
  const lEndMs   = DateTime.fromISO(`${dayDate}T${lunchEnd}`,   { zone: timezone }).toMillis();

  // If proposed slot doesn't overlap lunch window at all → no issue
  if (proposedEnd.getTime() <= lStartMs || proposedStart.getTime() >= lEndMs) return true;

  // Collect all busy blocks in lunch window (existing + proposed)
  const allBlocks = [
    ...busyBlocks.filter(b => b.start.getTime() < lEndMs && b.end.getTime() > lStartMs),
    { start: proposedStart, end: proposedEnd },
  ].map(b => ({
    start: Math.max(b.start.getTime(), lStartMs),
    end:   Math.min(b.end.getTime(), lEndMs),
  })).sort((a, b) => a.start - b.start);

  // Merge overlapping
  const merged: Array<{ start: number; end: number }> = [];
  for (const block of allBlocks) {
    if (merged.length > 0 && block.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, block.end);
    } else {
      merged.push({ ...block });
    }
  }

  // Find largest contiguous free block remaining in lunch window
  let maxFreeMin = 0;
  let prev = lStartMs;
  for (const block of merged) {
    maxFreeMin = Math.max(maxFreeMin, (block.start - prev) / 60_000);
    prev = block.end;
  }
  maxFreeMin = Math.max(maxFreeMin, (lEndMs - prev) / 60_000);

  return maxFreeMin >= lunchDurationMinutes;
}

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
}): Promise<Array<{ start: string; end: string; day_type?: 'office' | 'home' | 'other' }>> {
  const meetingMode: MeetingMode = params.meetingMode ?? 'either';
  const autoExpand = params.autoExpand !== false;
  const maxSearchDays = params.maxSearchDays ?? 21;
  const travelBufferMs = (params.travelBufferMinutes ?? 0) * 60 * 1000;
  const allEmails = [params.userEmail, ...params.attendeeEmails];

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

    const busyMap = await getFreeBusy(params.userEmail, allEmails, windowFrom, windowTo, params.timezone);

    const allBusy: Array<{ start: Date; end: Date }> = [];
    for (const slots of Object.values(busyMap)) {
      for (const slot of slots) {
        if (slot.status !== 'free') {
          allBusy.push({
            start: DateTime.fromISO(slot.start, { zone: params.timezone }).toJSDate(),
            end:   DateTime.fromISO(slot.end,   { zone: params.timezone }).toJSDate(),
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
    // The only additional padding we keep is travel buffer for custom mode.
    const bufferMs = (meetingMode === 'custom' ? travelBufferMs : 0);
    const thinkingTimeMinChunk = profile?.meetings.thinking_time_min_chunk_minutes ?? 30;
    // v1.6.11 — per-day-type thinking-time threshold. Office days usually need
    // more protected focus time than home days; profile can set each
    // separately. Home falls back to office value if unset (old profiles).
    const freeTimeOfficeMin = (profile?.meetings.free_time_per_office_day_hours ?? 0) * 60;
    const freeTimeHomeMin = ((profile?.meetings.free_time_per_home_day_hours
      ?? profile?.meetings.free_time_per_office_day_hours ?? 0)) * 60;
    const lunch = profile?.schedule.lunch;

    // Per-day work hours + day-type classifier (office / home / other).
    const classifyDay = (dayName: string): 'office' | 'home' | 'other' => {
      if (officeDayNames.includes(dayName)) return 'office';
      if (homeDayNames.includes(dayName)) return 'home';
      return 'other';
    };
    const getWorkHoursForDay = (dayName: string): { startMin: number; endMin: number } | null => {
      if (profile && !params.extendedHours) {
        const { office_days, home_days } = profile.schedule;
        if (officeDayNames.includes(dayName)) {
          const [sh, sm] = office_days.hours_start.split(':').map(Number);
          const [eh, em] = office_days.hours_end.split(':').map(Number);
          return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
        }
        if (homeDayNames.includes(dayName)) {
          const [sh, sm] = home_days.hours_start.split(':').map(Number);
          const [eh, em] = home_days.hours_end.split(':').map(Number);
          return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
        }
        return null; // not a known work day in profile
      }
      return { startMin: defaultStartHour * 60 + defaultStartMin, endMin: defaultEndHour * 60 + defaultEndMin };
    };

    const minToStr = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    // Pre-compute per-day quality free time (thinking-time check)
    const dayFreeTimeCache = new Map<string, number>();
    const getDayQualityFree = (dayDate: string, dayHours: { startMin: number; endMin: number }): number => {
      if (dayFreeTimeCache.has(dayDate)) return dayFreeTimeCache.get(dayDate)!;
      const freeMin = computeDayQualityFreeMinutes(
        dayDate, params.timezone,
        minToStr(dayHours.startMin), minToStr(dayHours.endMin),
        allBusy, thinkingTimeMinChunk,
      );
      dayFreeTimeCache.set(dayDate, freeMin);
      return freeMin;
    };

    let cursor = DateTime.fromISO(params.searchFrom, { zone: params.timezone }).toJSDate();
    while (cursor.getTime() + durationMs <= searchEnd.getTime()) {
      const cursorDt = DateTime.fromJSDate(cursor).setZone(params.timezone);
      const dayName = cursorDt.toFormat('EEEE');

      if (!workDays.includes(dayName)) {
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      const dayHours = getWorkHoursForDay(dayName);
      if (!dayHours) {
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      const slotTotalMin = cursorDt.hour * 60 + cursorDt.minute;
      if (slotTotalMin < dayHours.startMin || slotTotalMin + params.durationMinutes > dayHours.endMin) {
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      if (cursor.getTime() < earliestAllowed.getTime()) {
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      const slotEnd = new Date(cursor.getTime() + durationMs);
      const isFree = !allBusy.some(busy =>
        cursor.getTime() < busy.end.getTime() + bufferMs &&
        slotEnd.getTime() > busy.start.getTime() - bufferMs
      );
      if (!isFree) {
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      if (profile) {
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
            cursor = new Date(cursor.getTime() + step);
            continue;
          }
        }
      }
      if (lunch) {
        const dayDate = cursorDt.toFormat('yyyy-MM-dd');
        if (!canLunchFitAfterBooking(
          dayDate, params.timezone,
          lunch.preferred_start, lunch.preferred_end, lunch.duration_minutes,
          allBusy, cursor, slotEnd,
        )) {
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
      }

      candidates.push({
        start: cursor.toISOString(),
        end: slotEnd.toISOString(),
        day_type: classifyDay(dayName),
      });
      cursor = new Date(cursor.getTime() + step);
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

  return candidates.slice(0, 10);
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
}

export async function updateMeeting(params: UpdateMeetingParams): Promise<void> {
  const client = getClient();

  const patch: Record<string, unknown> = {};
  if (params.subject)    patch.subject    = params.subject;
  if (params.start)      patch.start      = { dateTime: params.start, timeZone: params.timezone };
  if (params.end)        patch.end        = { dateTime: params.end,   timeZone: params.timezone };
  if (params.body)       patch.body       = { contentType: 'HTML', content: params.body };
  if (params.categories) patch.categories = params.categories;

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
  meetingId: string
): Promise<void> {
  const client = getClient();
  await client.api(`/users/${userEmail}/events/${meetingId}`).delete();
}

export async function createMeeting(params: CreateMeetingParams): Promise<string> {
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

  const event: Record<string, unknown> = {
    subject: params.subject,
    body: {
      contentType: 'HTML',
      content: params.body || `<p>Meeting scheduled by your executive assistant.</p>`,
    },
    start: { dateTime: params.start, timeZone: params.timezone },
    end: { dateTime: params.end, timeZone: params.timezone },
    attendees: params.attendees.map(a => ({
      emailAddress: { address: a.email, name: a.name },
      type: 'required',
    })),
    isOnlineMeeting: params.isOnline ?? false,
    ...(params.isOnline && {
      onlineMeetingProvider: params.onlineMeetingProvider ?? 'teamsForBusiness',
    }),
    ...(effectiveLocation && { location:    { displayName: effectiveLocation } }),
    ...(params.categories  && { categories:  params.categories }),
    ...(params.sensitivity && { sensitivity: params.sensitivity }),
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
    return created.id;
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
