/**
 * Meetings-skill direct-ops helper (internal; not a loadable skill).
 *
 * This file holds the direct calendar operations (`get_calendar`, `create_meeting`,
 * `move_meeting`, `delete_meeting`, `update_meeting`, `get_free_busy`,
 * `find_available_slots`, `analyze_calendar`) and the pure helpers
 * `processCalendarEvents` and `analyzeCalendar` used by the task runner's
 * `calendar_fix` dispatcher.
 *
 * It exposes a class (`SchedulingSkill`) that conforms to the Skill interface
 * ONLY because `MeetingsSkill` instantiates it and delegates `executeToolCall`
 * for direct-ops tool names. Its `getTools` and `getSystemPromptSection` are
 * never consulted — `MeetingsSkill` owns both — so keeping them would be dead
 * code. They are intentionally absent.
 *
 * NOT registered in `skills/registry.ts`. The leading underscore in the
 * filename signals "internal helper, not a togglable skill."
 */
import logger from '../../utils/logger';
import { DateTime } from 'luxon';
import type { SkillContext } from '../types';

// v1.8.3 — extract "HH:MM" from an ISO datetime string for action_summary
// formatting. Falls back to the raw string if the shape is unexpected.
function formatIsoTime(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

// v3.2.1 (#120 / 120b) — the VACATED slot of a move: the window the meeting
// occupied BEFORE it moved, so a follow-up "move X into the freed slot"
// resolves from this turn instead of Maelle re-asking the old time. Window =
// old start + the moved duration. ONE helper, called from BOTH move return
// sites (the regular-meeting tail AND the floating-block early return) so the
// two paths can never drift apart — both must return `vacated`, otherwise
// moving lunch to free its slot drops the freed-slot info entirely.
function computeVacatedSlot(
  preMoveStartIso: string | undefined,
  newStartIso: string | undefined,
  newEndIso: string | undefined,
  timezone: string,
): { start: string; end: string; label: string } | undefined {
  if (!preMoveStartIso) return undefined;
  const vs = DateTime.fromISO(preMoveStartIso, { zone: timezone });
  if (!vs.isValid) return undefined;
  const ns = newStartIso ? DateTime.fromISO(newStartIso, { zone: timezone }) : undefined;
  const ne = newEndIso ? DateTime.fromISO(newEndIso, { zone: timezone }) : undefined;
  const durMs = ns?.isValid && ne?.isValid ? ne.toMillis() - ns.toMillis() : 0;
  const ve = durMs > 0 ? vs.plus({ milliseconds: durMs }) : vs;
  return {
    start: vs.toISO() ?? preMoveStartIso,
    end: ve.toISO() ?? '',
    label: `${vs.toFormat('EEE d MMM HH:mm')}–${ve.toFormat('HH:mm')}`,
  };
}

// v2.1.5 — build synthetic busy blocks covering everything OUTSIDE the owner's
// work hours (and all-day busy for non-work days) across the given range. Used
// only for colleague-path get_free_busy calls so raw free gaps returned to
// Sonnet never include out-of-hours time. Rule enforcement in code — the LLM
// literally cannot narrate a 09:00 slot to a colleague when office day starts
// 10:30 because that window is no longer present as "free" in the data.
function buildOutOfHoursBusy(
  startDate: string,
  endDate: string,
  profile: UserProfileType,
  timezone: string,
): Array<{ start: string; end: string; status: 'oof' }> {
  const blocks: Array<{ start: string; end: string; status: 'oof' }> = [];
  const rangeStart = DateTime.fromISO(startDate, { zone: timezone });
  const rangeEnd = DateTime.fromISO(endDate, { zone: timezone });
  if (!rangeStart.isValid || !rangeEnd.isValid) return blocks;
  const officeDays = profile.schedule.office_days.days;
  const homeDays = profile.schedule.home_days.days;
  const dayName = (dt: DateTime) => dt.toFormat('cccc');
  for (let d = rangeStart.startOf('day'); d <= rangeEnd; d = d.plus({ days: 1 })) {
    const name = dayName(d);
    const isOffice = officeDays.includes(name as typeof officeDays[number]);
    const isHome = homeDays.includes(name as typeof homeDays[number]);
    const dayStart = d.startOf('day');
    const dayEnd = d.endOf('day');
    if (!isOffice && !isHome) {
      // Non-work day — block the whole day.
      blocks.push({
        start: dayStart.toISO() ?? `${d.toISODate()}T00:00:00`,
        end: dayEnd.toISO() ?? `${d.toISODate()}T23:59:59`,
        status: 'oof',
      });
      continue;
    }
    // v2.8.1 — read all work-hour windows for this day. Build OOF blocks
    // for every gap: 00:00 → first window start, between windows, last
    // window end → 23:59. Multi-window aware (Tuesday "09:00-15:30" +
    // "21:30-23:59" leaves an OOF block 15:30-21:30 in the middle).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getOwnerWorkHoursForDay } = require('../../utils/workHours') as
      typeof import('../../utils/workHours');
    const wins = getOwnerWorkHoursForDay(profile, name);
    if (wins.length === 0) {
      // No windows on this workday — treat the whole day as OOF.
      blocks.push({
        start: dayStart.toISO() ?? `${d.toISODate()}T00:00:00`,
        end: dayEnd.toISO() ?? `${d.toISODate()}T23:59:59`,
        status: 'oof',
      });
      continue;
    }
    // Morning block: 00:00 → first window start.
    if (wins[0].startMin > 0) {
      const morningEnd = dayStart.plus({ minutes: wins[0].startMin });
      blocks.push({
        start: dayStart.toISO() ?? `${d.toISODate()}T00:00:00`,
        end: morningEnd.toISO() ?? `${d.toISODate()}T00:00:00`,
        status: 'oof',
      });
    }
    // Between-windows gaps.
    for (let i = 0; i < wins.length - 1; i++) {
      const gapStart = dayStart.plus({ minutes: wins[i].endMin });
      const gapEnd = dayStart.plus({ minutes: wins[i + 1].startMin });
      blocks.push({
        start: gapStart.toISO() ?? `${d.toISODate()}T00:00:00`,
        end: gapEnd.toISO() ?? `${d.toISODate()}T00:00:00`,
        status: 'oof',
      });
    }
    // Evening block: last window end → end of day.
    const lastEnd = wins[wins.length - 1].endMin;
    if (lastEnd < 24 * 60) {
      const eveningStart = dayStart.plus({ minutes: lastEnd });
      blocks.push({
        start: eveningStart.toISO() ?? `${d.toISODate()}T00:00:00`,
        end: dayEnd.toISO() ?? `${d.toISODate()}T23:59:59`,
        status: 'oof',
      });
    }
  }
  return blocks;
}
// Local alias for the profile type without adding another import — re-use the
// one imported below. Ts hoists type-only imports so this works.
type UserProfileType = import('../../config/userProfile').UserProfile;
import type { UserProfile } from '../../config/userProfile';
import {
  getCalendarEvents,
  getEventEndInstant,
  findDuplicateEvent,
  findReschedulableSibling,
  type CalendarEvent,
  getFreeBusy,
  findAvailableSlots,
  createMeeting,
  deleteMeeting,
  verifyEventDeleted,
  updateMeeting,
  GraphPermissionError,
} from '../../connectors/graph/calendar';
import {
  getDb,
  auditLog,
  getSuppressedEventIds,
  dismissFloatingBlockGap,
  searchPeopleMemory,
  getPersonMemory,
} from '../../db';
import { closeMeetingArtifacts } from '../../utils/closeMeetingArtifacts';
import { reinterpretClockInZone, renderClockInZone } from '../../utils/timezoneConvert';
import { recordWeConfirmShown, consumeWeConfirmShown } from '../../utils/weConfirmStash';
import { resolveStatedInstant, renderWeDualClock } from '../../utils/weTimeResolver';
import { checkIntendedWeekday } from '../../utils/weekdayGuard';

// ── Calendar event processing ─────────────────────────────────────────────────

/**
 * Parse a Graph API datetime string safely.
 * Graph returns strings like "2026-04-18T17:00:00.0000000" (7-digit fractional seconds)
 * with the timezone in a separate field. We strip the fractional seconds, then
 * parse using the event's own timeZone field (not just the user's timezone) —
 * this is the single authoritative source and prevents off-by-one-day errors.
 */
function parseGraphDateTime(dateTimeStr: string, eventTimeZone: string, fallbackTz: string): DateTime {
  const clean = dateTimeStr.replace(/\.\d+$/, '');   // strip .0000000
  const tz = eventTimeZone || fallbackTz;
  // If the string already has a Z or offset, parse as-is and convert
  if (clean.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(clean)) {
    // v2.3.1 (B5 / #63) — convert to fallbackTz for display, not the event's
    // own zone. Without this, a UTC-stamped event renders as UTC in briefings
    // even when the owner is in Asia/Jerusalem. Idempotent when fallbackTz
    // matches the parsed zone.
    return DateTime.fromISO(clean).setZone(fallbackTz);
  }
  // No offset → Graph returned it in the event's timezone (via Prefer header).
  // v2.3.1 (B5 / #63) — re-zone to fallbackTz so display is owner-local even
  // when Graph honored an event-side declared zone like "UTC".
  return DateTime.fromISO(clean, { zone: tz }).setZone(fallbackTz);
}

/**
 * Returns true when a full-day event belongs to someone else (e.g. a manager's OOO
 * shared on the owner's calendar). The real signal is the organizer (≠ owner);
 * the title heuristic is a fallback — a leading name token before a dash/colon
 * that isn't the owner's. Script-agnostic (\p{L}) so a Hebrew/Cyrillic-named
 * colleague's OOO ("יעל - בית חולים") isn't mistaken for the owner's own day.
 * Matches: "Yael - Meir Hospital", "Brett - NY trip", "יעל - בית חולים"
 * No match: "Vacation", "Conference", "Office Day", "Idan - offsite"
 */
function isOtherPersonsAllDayEvent(subject: string, ownerName: string, organizerEmail: string, ownerEmail: string): boolean {
  if (organizerEmail && organizerEmail.toLowerCase() === ownerEmail.toLowerCase()) return false;
  const ownerFirst = ownerName.split(' ')[0].toLowerCase();
  const match = subject.match(/^(\p{L}+)\s*[-–—:]\s*/u);
  if (match) {
    const leadName = match[1].toLowerCase();
    if (leadName !== ownerFirst) return true;
  }
  return false;
}

/**
 * Enrich a list of unresolvable internal attendee addresses with a `did_you_mean`
 * pulled from people_memory (first-name token of the local-part). Shared by
 * find_available_slots (which already has the unresolved list from the search
 * diagnostics) and create_meeting (which probes for it) — one did_you_mean
 * lookup, not two copies. A nonexistent @company mailbox returns no busy data,
 * so it reads as fully free; both callers must surface it, never book/offer a
 * ghost. (Splitting the local-part on `._-` is email-format parsing, not NL.)
 */
function enrichUnresolvedInternal(emails: string[], ownerDomainLower: string): Array<{ email: string; did_you_mean?: string }> {
  return emails.map(email => {
    let didYouMean: string | undefined;
    try {
      const token = email.split('@')[0].split(/[._-]/)[0];
      if (token.length >= 3) {
        const hit = searchPeopleMemory(token).find(p =>
          p.email
          && p.email.toLowerCase() !== email
          && p.email.toLowerCase().endsWith('@' + ownerDomainLower));
        didYouMean = hit?.email ?? undefined;
      }
    } catch { /* non-fatal — entry ships without the suggestion */ }
    return { email, ...(didYouMean ? { did_you_mean: didYouMean } : {}) };
  });
}

/**
 * A calendar event processed and ready for Claude consumption.
 * Raw ISO timestamps are deliberately REMOVED — Claude only gets human-readable
 * local fields to prevent her from doing her own (error-prone) date arithmetic.
 */
interface ProcessedEvent {
  id: string;
  subject: string;           // "[Private]" for sensitivity=private/personal
  _localDate: string;        // "2026-04-18"  ← authoritative, always in owner's TZ
  _localDay: string;         // "Friday"
  _localStartTime: string;   // "17:00"  (already in owner's TZ — no conversion needed)
  _localEndTime: string;     // "19:00"
  _durationMin: number;      // pre-computed meeting duration
  isAllDay: boolean;
  showAs: string;            // busy | tentative | oof | workingElsewhere
  sensitivity: string;       // normal | personal | private | confidential
  categories?: string[];     // Outlook categories e.g. ["Physical"] or ["Meeting"]
  _eventType: 'mine' | 'colleague_info';
  isCancelled: boolean;
  isOnlineMeeting: boolean;
  onlineMeetingUrl?: string;
  // Physical location displayName from Graph. Present when the meeting has
  // a real venue stamped (office, meeting room, address). Co-exists with
  // isOnlineMeeting=true on hybrid meetings (physical room + Teams link).
  location?: string;
  attendees?: string[];
  // Floating-block marker. When this event matches one of the profile's
  // configured floating blocks (lunch, coffee break, gym, thinking time,
  // etc.) the matching block's name is surfaced here. Computed against the
  // RAW subject — privacy masking later in this same pass replaces the
  // visible subject with "[Private]" but the detection has already happened,
  // so private-flagged lunches still get detected correctly. Match goes
  // through `isFloatingBlockEvent` so it honors the yaml's
  // `match_subject_regex` + `match_category` (instead of duplicating
  // keyword lists in two places).
  is_floating_block?: { name: string } | null;
}

export function processCalendarEvents(
  events: CalendarEvent[],
  ownerEmail: string,
  ownerName: string,
  timezone: string,
  profile: UserProfile,
): ProcessedEvent[] {
  const result: ProcessedEvent[] = [];

  // Load floating blocks once per pass. Iterated for every event to surface
  // `is_floating_block` so brief/analyze can treat lunch/coffee/gym
  // uniformly without redoing keyword matching downstream.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fb = require('../../utils/floatingBlocks') as typeof import('../../utils/floatingBlocks');
  const floatingBlocks = fb.getFloatingBlocks(profile);

  for (const ev of events) {
    // showAs=free → strip entirely before Claude sees it
    if (ev.showAs === 'free') {
      logger.debug('Skipping free event', { subject: ev.subject });
      continue;
    }

    const startDt = parseGraphDateTime(ev.start.dateTime, ev.start.timeZone, timezone);
    const endDt   = parseGraphDateTime(ev.end.dateTime,   ev.end.timeZone,   timezone);

    const localDate      = startDt.toFormat('yyyy-MM-dd');
    const localDay       = startDt.toFormat('EEEE');          // "Friday"
    const localStartTime = startDt.toFormat('HH:mm');         // "17:00"
    const localEndTime   = endDt.toFormat('HH:mm');           // "19:00"
    const durationMin    = Math.round(endDt.diff(startDt, 'minutes').minutes);

    // Classify all-day events that belong to someone else
    const organizerEmail = ev.organizer?.emailAddress?.address ?? '';
    let eventType: ProcessedEvent['_eventType'] = 'mine';
    if (ev.isAllDay && isOtherPersonsAllDayEvent(ev.subject, ownerName, organizerEmail, ownerEmail)) {
      eventType = 'colleague_info';
    }

    // Private/personal events: mask the subject. v2.9.4 (#107a) — checks BOTH
    // paths via the central displaySubject helper:
    //   (1) Outlook sensitivity is 'private' / 'personal'
    //   (2) any of the event's categories matches a yaml category with
    //       sets_sensitivity_private:true (e.g. the `Personal` category)
    // Both must be masked here, else Sonnet sees raw subjects for category-
    // private events and could narrate them verbatim. The lower-level
    // getCalendarEvents still returns raw subjects; the internal classifier
    // flows (autoCategorize / detectCategory) read those directly and stay
    // unaffected.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { displaySubject } = require('../../utils/displaySubject') as
      typeof import('../../utils/displaySubject');
    const sensitivity = ev.sensitivity ?? 'normal';
    const subject = displaySubject(
      { subject: ev.subject, sensitivity, categories: ev.categories },
      profile,
    );

    const attendeeNames = (ev.attendees ?? [])
      .map(a => a.emailAddress.name)
      .filter(n => n && n.toLowerCase() !== ownerName.toLowerCase())
      .slice(0, 10);

    result.push({
      id: ev.id,
      subject,
      _localDate: localDate,
      _localDay: localDay,
      _localStartTime: localStartTime,
      _localEndTime: localEndTime,
      _durationMin: durationMin,
      isAllDay: ev.isAllDay,
      showAs: ev.showAs ?? 'busy',
      sensitivity,
      _eventType: eventType,
      categories: ev.categories && ev.categories.length > 0 ? ev.categories : undefined,
      isCancelled: ev.isCancelled,
      isOnlineMeeting: ev.isOnlineMeeting,
      onlineMeetingUrl: ev.onlineMeetingUrl,
      location: ev.location?.displayName?.trim() || undefined,
      attendees: attendeeNames.length > 0 ? attendeeNames : undefined,
      // Floating-block marker. Match goes against the RAW `ev.subject` —
      // NOT the masked `subject` computed above — because privacy masking
      // turns "Lunch" into "[Private]" for sensitivity=private/personal,
      // and we still need detection to fire. The boolean-shaped output
      // (just block name) doesn't leak private content. Matcher honors
      // each block's match_subject_regex + match_category from
      // meetings.floating_blocks. First match wins.
      is_floating_block: (() => {
        for (const block of floatingBlocks) {
          if (fb.isFloatingBlockEvent(
            { subject: ev.subject, categories: ev.categories },
            block,
          )) {
            return { name: block.name };
          }
        }
        return null;
      })(),
    });
  }

  return result;
}

// ── Calendar analysis (detect issues) ────────────────────────────────────────

interface CalendarIssue {
  type: 'oof_with_meetings' | 'no_buffer' | 'missing_floating_block' | 'back_to_back' | 'overlap' | 'work_on_day_off' | 'category_over_limit';
  severity: 'high' | 'medium' | 'low';
  detail: string;
  suggestedFix?: string;
  /** Set when type === 'missing_floating_block' — which block (lunch / coffee / gym / etc) is missing. */
  block_name?: string;
}

interface DayAnalysis {
  date: string;
  day: string;
  dayType: 'office' | 'home' | 'day_off';
  isWorkDay: boolean;
  events: ProcessedEvent[];   // sorted by start, mine only, not cancelled
  issues: CalendarIssue[];
  stats: {
    meetingCount: number;
    firstMeeting?: string;    // "09:30"
    lastMeeting?: string;     // "17:00"
    totalMeetingMin: number;
    freeMinInWorkHours: number;
  };
}

export function analyzeCalendar(
  events: ProcessedEvent[],
  startDate: string,
  endDate: string,
  profile: UserProfile,
  // v3.0.3 — suppression happens at row-write time via upsertCluster's
  // 'suppressed' return (callers that write rows skip already-approved
  // clusters). Read-only callers see the full detected list; Sonnet's prompt
  // covers narration filtering.
  _legacy?: Set<string>,
): DayAnalysis[] {
  const officeDays = new Set(profile.schedule.office_days.days as string[]);
  const homeDays   = new Set(profile.schedule.home_days.days   as string[]);
  const allWorkDays = new Set([...officeDays, ...homeDays]);

  // Floating blocks (lunch + any custom). Uses the same matcher every other
  // code path (slot search, book_floating_block, rebalance) uses.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fb = require('../../utils/floatingBlocks') as typeof import('../../utils/floatingBlocks');
  const floatingBlocks = fb.getFloatingBlocks(profile);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { requiredFreeMinutesForWorkDay } = require('../../utils/scheduleRules') as typeof import('../../utils/scheduleRules');
  // v3.6.x (bug 1.13) — required free time is now LENGTH-based, not a fixed
  // office/home target: 1h free per 4h worked, rounded UP to the next 15 min,
  // off the TOTAL work-window minutes for the day (morning + night shift
  // summed). The old fixed free_time_per_office/home_day_hours and the
  // buffer_minutes shave are gone from this calc (buffer_minutes still lives in
  // check_join_availability). Computed per day in the loop below via workTotalMin.

  // Iterate every calendar day in the range
  const results: DayAnalysis[] = [];
  let cursor = DateTime.fromISO(startDate, { zone: profile.user.timezone });
  const end  = DateTime.fromISO(endDate,   { zone: profile.user.timezone });

  while (cursor <= end) {
    const dateStr = cursor.toFormat('yyyy-MM-dd');
    const dayName = cursor.toFormat('EEEE'); // "Monday"

    const isWorkDay  = allWorkDays.has(dayName);
    const isOffice   = officeDays.has(dayName);
    const dayType: DayAnalysis['dayType'] = isOffice ? 'office' : allWorkDays.has(dayName) ? 'home' : 'day_off';

    // v2.8.1 — multi-window aware work hours for this day.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getOwnerWorkHoursForDay, totalWorkMinutes } = require('../../utils/workHours') as
      typeof import('../../utils/workHours');
    const windows = getOwnerWorkHoursForDay(profile, dayName);
    const workStartMin = windows.length > 0 ? windows[0].startMin : 9 * 60;
    const workEndMin = windows.length > 0 ? windows[windows.length - 1].endMin : 19 * 60;
    const workTotalMin = totalWorkMinutes(windows) || (workEndMin - workStartMin);

    // All events for this date
    const dayEvents = events
      .filter(e => e._localDate === dateStr && !e.isCancelled)
      .sort((a, b) => a._localStartTime.localeCompare(b._localStartTime));

    const myEvents = dayEvents.filter(e => e._eventType === 'mine');

    const issues: CalendarIssue[] = [];

    if (!isWorkDay) {
      // Day off — only report non-private work meetings
      const workMeetingsOnDayOff = myEvents.filter(
        e => e.sensitivity === 'normal' && e.showAs !== 'free' && !e.isAllDay
      );
      if (workMeetingsOnDayOff.length > 0) {
        issues.push({
          type: 'work_on_day_off',
          severity: 'medium',
          detail: `${workMeetingsOnDayOff.map(e => `${e.subject} at ${e._localStartTime}`).join(', ')}`,
          suggestedFix: 'Consider moving these to a work day, or confirm they are intentional.',
        });
      }
      results.push({
        date: dateStr,
        day: dayName,
        dayType,
        isWorkDay: false,
        events: workMeetingsOnDayOff,
        issues,
        stats: { meetingCount: workMeetingsOnDayOff.length, totalMeetingMin: 0, freeMinInWorkHours: 0 },
      });
      cursor = cursor.plus({ days: 1 });
      continue;
    }

    // ── Work day analysis ───────────────────────────────────────────────────

    // Check for OOF event
    const oofEvent = myEvents.find(e => e.showAs === 'oof');
    const nonAllDayMeetings = myEvents.filter(e => !e.isAllDay && e.showAs !== 'oof');

    if (oofEvent && nonAllDayMeetings.length > 0) {
      issues.push({
        type: 'oof_with_meetings',
        severity: 'high',
        detail: `You're out-of-office but have ${nonAllDayMeetings.length} meeting(s) scheduled: ${nonAllDayMeetings.map(e => `${e.subject} at ${e._localStartTime}`).join(', ')}`,
        suggestedFix: 'These meetings need to be moved or cancelled.',
      });
    }

    // Time-block analysis — any non-all-day meeting that OVERLAPS work hours,
    // not only those that START inside them. An event beginning before work
    // hours but running into them (e.g. a private block 08:30–10:30 when work
    // starts 09:00) occupies real in-hours time; filtering by start alone
    // dropped it entirely and counted 09:00–10:30 as free (the Sunday "1h55
    // free" overcount). Only the in-hours portion is ever counted: the gap /
    // duration loop below starts prevEndMin at workStartMin and caps evEnd at
    // workEndMin, so the pre-work and post-work slivers are clamped away.
    const timedMeetings = nonAllDayMeetings.filter(e => {
      // v3.6.4 — a TIMED workingElsewhere event is an OPTIONAL-join (e.g. a
      // daily standup) — free time the owner can reclaim, not a real
      // commitment. Exclude it so it never counts as busy, never reduces the
      // free-time floor, and a real meeting overlapping it is NOT flagged as a
      // conflict. (All-day WE is already excluded — these are non-all-day only.)
      if (e.showAs === 'workingElsewhere') return false;
      const [sh, sm] = e._localStartTime.split(':').map(Number);
      const [eh, em] = e._localEndTime.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      return endMin > workStartMin && startMin < workEndMin;
    });

    // Compute gaps (free blocks) between meetings + detect overlaps. gaps[] and
    // totalMeetingMin feed floating-block detection + stats below; free-time is
    // computed per-window afterward (bug 1.13) so split shifts read correctly.
    let totalMeetingMin = 0;
    let prevEndMin = workStartMin;
    const gaps: Array<{ start: number; end: number }> = [];

    for (const ev of timedMeetings) {
      const [sh, sm] = ev._localStartTime.split(':').map(Number);
      const [eh, em] = ev._localEndTime.split(':').map(Number);
      const evStart = sh * 60 + sm;
      const evEnd   = Math.min(eh * 60 + em, workEndMin);
      const evDur   = Math.max(0, evEnd - Math.max(evStart, prevEndMin));

      if (evStart > prevEndMin) {
        gaps.push({ start: prevEndMin, end: evStart });
      }

      // v2.0.8 — true overlap detection. A new meeting starting BEFORE the
      // previous one ends is a real time conflict and must be flagged as high
      // severity (distinct from adjacent back-to-back, which is fine).
      if (prevEndMin > workStartMin && evStart < prevEndMin) {
        // Find the previous meeting (the one ending at prevEndMin) for a
        // clearer error message. Walk back through timedMeetings.
        const prev = timedMeetings
          .slice(0, timedMeetings.indexOf(ev))
          .reverse()
          .find(p => {
            const [peh, pem] = p._localEndTime.split(':').map(Number);
            return Math.min(peh * 60 + pem, workEndMin) === prevEndMin;
          });
        const prevLabel = prev
          ? `${prev.subject} (${prev._localStartTime}–${prev._localEndTime})`
          : `the previous meeting (ends ${String(Math.floor(prevEndMin/60)).padStart(2,'0')}:${String(prevEndMin%60).padStart(2,'0')})`;
        issues.push({
          type: 'overlap',
          severity: 'high',
          detail: `${ev.subject} (${ev._localStartTime}–${ev._localEndTime}) overlaps ${prevLabel} by ${prevEndMin - evStart} min`,
          suggestedFix: 'Move one of the meetings or drop out of one.',
        });
      }
      // v2.7.1 — no back_to_back emit: connected back-to-backs are fine by
      // design (no buffer-between-meetings enforcement), so flagging them as
      // analyzer issues would have no fix path and just produce morning-brief
      // noise.
      totalMeetingMin += evDur;
      prevEndMin = Math.max(prevEndMin, evEnd);
    }
    // Trailing gap from the last meeting to end of the work span — for the
    // floating-block detection below (free-time uses its own per-window pass).
    if (prevEndMin < workEndMin) {
      gaps.push({ start: prevEndMin, end: workEndMin });
    }

    // ── Free time (bug 1.13) ───────────────────────────────────────────────
    // Sum free gaps INSIDE each work window only — the off-period between a
    // morning and a night shift is never counted (it isn't work time). No buffer
    // shave; any single gap under 15 min is dropped entirely, not trimmed.
    // required = 1h free per 4h worked, rounded UP to the next 15 min, off the
    // summed work-window length (workTotalMin).
    const freeWindows = windows.length > 0 ? windows : [{ startMin: workStartMin, endMin: workEndMin }];
    const meetingIntervals = timedMeetings.map(ev => {
      const [sh, sm] = ev._localStartTime.split(':').map(Number);
      const [eh, em] = ev._localEndTime.split(':').map(Number);
      return { start: sh * 60 + sm, end: eh * 60 + em };
    });
    let freeMin = 0;
    for (const w of freeWindows) {
      // Clamp meetings to this window, drop empties, sort, merge overlaps.
      const busy = meetingIntervals
        .map(m => ({ start: Math.max(m.start, w.startMin), end: Math.min(m.end, w.endMin) }))
        .filter(m => m.end > m.start)
        .sort((a, b) => a.start - b.start);
      const merged: Array<{ start: number; end: number }> = [];
      for (const b of busy) {
        const last = merged[merged.length - 1];
        if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
        else merged.push({ ...b });
      }
      let cursor = w.startMin;
      for (const b of merged) {
        const gap = b.start - cursor;
        if (gap >= 15) freeMin += gap;   // full gap; sub-15 fragments don't count
        cursor = Math.max(cursor, b.end);
      }
      const trailing = w.endMin - cursor;
      if (trailing >= 15) freeMin += trailing;
    }

    const requiredFreeMin = requiredFreeMinutesForWorkDay(workTotalMin, profile.meetings.work_hours_per_free_hour);
    if (requiredFreeMin > 0 && freeMin < requiredFreeMin) {
      issues.push({
        type: 'no_buffer',
        severity: 'high',
        detail: `Only ${freeMin} min free inside your ${workTotalMin}-min work day; you want at least ${requiredFreeMin} min (1h free per 4h worked; gaps under 15 min don't count).`,
        suggestedFix: 'Consider moving or shortening some meetings.',
      });
    }

    // Floating-block missing detection. Walk every block configured in the
    // profile (lunch + any custom). For each block applying on this
    // day-of-week:
    //   - "present" means: an event matches via is_floating_block AND its
    //     start lands inside the block's preferred window. Strict-window
    //     check matches the prior lunch semantic — a "Lunch" at 18:00 on a
    //     workday still counts as a missing lunch in its window.
    //   - missing AND !block.can_skip → emit `missing_floating_block` with
    //     a suggested start computed from the best free gap inside the
    //     block's preferred window.
    // Detection uses ProcessedEvent.is_floating_block (already computed via
    // isFloatingBlockEvent on the raw subject upstream — so private-flagged
    // lunches are still detected).
    const fmt = (min: number) =>
      `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

    for (const block of floatingBlocks) {
      if (!fb.blockAppliesOnDay(block, dayName, profile)) continue;

      const [bsH, bsM] = block.preferred_start.split(':').map(Number);
      const [beH, beM] = block.preferred_end.split(':').map(Number);
      const blockWindowStart = bsH * 60 + bsM;
      const blockWindowEnd   = beH * 60 + beM;
      const minBlockMin = block.duration_minutes;

      const blockEvent = timedMeetings.find(e => {
        if (e.is_floating_block?.name !== block.name) return false;
        const [sh, sm] = e._localStartTime.split(':').map(Number);
        const evStart = sh * 60 + sm;
        return evStart >= blockWindowStart && evStart < blockWindowEnd;
      });
      if (blockEvent) {
        // v3.0.3 — block exists. Check whether it's STUCK on a meeting that
        // overlaps it AND no clean alternative slot exists in the window.
        // (rebalance handles silent moves when an alternative exists; this
        // detects the can't-be-fixed-silently case so it surfaces to the
        // owner via the new calendar_issues row.)
        const [bsh, bsm] = blockEvent._localStartTime.split(':').map(Number);
        const [beh, bem] = blockEvent._localEndTime.split(':').map(Number);
        const bStartMin = bsh * 60 + bsm;
        const bEndMin = beh * 60 + bem;
        const overlapper = timedMeetings.find(other => {
          if (other === blockEvent) return false;
          if (other.is_floating_block) return false;  // ignore other blocks
          const [osh, osm] = other._localStartTime.split(':').map(Number);
          const [oeh, oem] = other._localEndTime.split(':').map(Number);
          const oStartMin = osh * 60 + osm;
          const oEndMin = oeh * 60 + oem;
          return oStartMin < bEndMin && oEndMin > bStartMin;
        });
        if (!overlapper) continue;  // block in window, not overlapped — fine

        // Does an alternative aligned slot exist in the window?
        // Re-compute gaps minus the block itself (it's the one moving) to see
        // if any gap can hold the block's duration.
        let alternativeExists = false;
        for (const gap of gaps) {
          const overlapStart = Math.max(gap.start, blockWindowStart);
          const overlapEnd   = Math.min(gap.end, blockWindowEnd);
          if (overlapEnd - overlapStart >= minBlockMin) { alternativeExists = true; break; }
        }
        if (alternativeExists) continue;  // rebalance can fix silently

        // Block is stuck. Emit under existing class so owner direction
        // "use the current framework" is honored. Detail carries the
        // specific story so Sonnet narrates accurately.
        if (!block.can_skip) {
          const blockLabel = block.name.replace(/_/g, ' ');
          issues.push({
            type: 'missing_floating_block',
            severity: 'medium',
            detail: `${blockLabel} at ${blockEvent._localStartTime} overlaps ${overlapper.subject} (${overlapper._localStartTime}-${overlapper._localEndTime}); no clean alternative in ${block.preferred_start}-${block.preferred_end}`,
            suggestedFix: `Move ${overlapper.subject}, skip ${blockLabel} today, or override the window.`,
            block_name: block.name,
          });
        }
        continue;
      }

      // Compute the best free gap inside the block's preferred window for the
      // suggestedFix narration. Same shape as the prior lunch-only logic.
      let bestGapStart: number | undefined;
      let bestGapSize = 0;
      for (const gap of gaps) {
        const overlapStart = Math.max(gap.start, blockWindowStart);
        const overlapEnd   = Math.min(gap.end, blockWindowEnd);
        const overlapSize = overlapEnd - overlapStart;
        if (overlapSize >= minBlockMin && overlapSize > bestGapSize) {
          bestGapStart = overlapStart;
          bestGapSize = overlapSize;
        }
      }

      if (!block.can_skip) {
        const suggestedStart = bestGapStart !== undefined ? fmt(bestGapStart) : block.preferred_start;
        const blockLabel = block.name.replace(/_/g, ' ');
        const suggestedFix = bestGapStart !== undefined
          ? `Want me to block ${minBlockMin} min at ${suggestedStart}?`
          : `No free gap in your ${blockLabel} window — want me to bump something and block ${minBlockMin} min at ${suggestedStart}?`;
        issues.push({
          type: 'missing_floating_block',
          severity: 'medium',
          detail: `No ${blockLabel} event booked`,
          suggestedFix,
          block_name: block.name,
        });
      }
    }

    const sortedMy = timedMeetings.sort((a, b) => a._localStartTime.localeCompare(b._localStartTime));

    // v3.0.3 — suppression handled by upsertCluster at row-write time; this
    // function is read-only and returns the full detected list. Callers that
    // surface to the owner do so via the cluster-write path.
    results.push({
      date: dateStr,
      day: dayName,
      dayType,
      isWorkDay: true,
      events: myEvents,
      issues,
      stats: {
        meetingCount: timedMeetings.length,
        firstMeeting: sortedMy[0]?._localStartTime,
        lastMeeting:  sortedMy[sortedMy.length - 1]?._localEndTime,
        totalMeetingMin,
        freeMinInWorkHours: freeMin,
      },
    });

    cursor = cursor.plus({ days: 1 });
  }

  return results;
}

/**
 * Internal ops helper. Not a registered skill (see file header). MeetingsSkill
 * delegates direct-ops tool execution to an instance of this class. Only
 * `executeToolCall` is ever called from outside.
 */
export class SchedulingSkill {
  // Kept only for call sites inside executeToolCall that reference `this.id` etc.
  readonly id = 'meetings' as const;

  // v2.0.7 — no getTools / getSystemPromptSection here (the former methods,
  // dead since v1.7, were deleted). MeetingsSkill owns both schemas and
  // prompts. Only executeToolCall is invoked externally, via
  // `this.ops.executeToolCall(...)` from meetings.ts.

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { email: userEmail, timezone } = context.profile.user;

    switch (toolName) {
      case 'hold_slot': {
        // Tentative slot reservation. Colleague-path: only a slot WE
        // offered them this conversation, max 3, re-pick replaces same-thread.
        // Owner-path: any slot, any holder. Auto-expires at min(2 workdays,
        // slot-start) via the tick (sweepExpiredSlotHolds). See db/slotHolds.ts.
        const ownerUserId = context.profile.user.slack_user_id;
        const isOwner = context.senderRole === 'owner';
        const action = args.action as string;
        const sh = await import('../../db/slotHolds');

        // Normalize any provided slot bound to a UTC instant up front, so store,
        // release-match, and the readers all compare the same zone. Sonnet passes
        // a bare owner-local clock string ("2026-06-24T16:30:00", no offset);
        // stored raw, the readers (Date.parse / SQL string-compare vs a UTC
        // `nowIso`) read it as server-local and drift by the offset off a
        // non-Israel host. Interpreting in the owner TZ → UTC makes every hold
        // comparison instant-correct. (An offset-form input passes through —
        // fromISO honors an explicit offset.)
        const holdTz = context.profile.user.timezone;
        const normIso = (s: unknown): string | undefined =>
          (typeof s === 'string' && s)
            ? (DateTime.fromISO(s, { zone: holdTz }).toUTC().toISO() ?? s)
            : undefined;
        const normStartIso = normIso(args.start_iso);
        const normEndIso = normIso(args.end_iso);

        if (action === 'release') {
          if (typeof args.hold_id === 'string' && args.hold_id) {
            const ok = sh.releaseSlotHold(args.hold_id, isOwner ? 'owner_cancelled' : 'colleague_released');
            return { success: ok, released: ok ? 1 : 0 };
          }
          const released = isOwner
            ? sh.releaseHoldsForOwner(ownerUserId, { startIso: normStartIso }, 'owner_cancelled')
            : sh.releaseHoldsForOwner(ownerUserId, { holderSlackId: context.userId, startIso: normStartIso }, 'colleague_released');
          return { success: true, released: released.length };
        }

        // action === 'hold'
        const startIso = normStartIso;
        const endIso = normEndIso;
        if (!startIso || !endIso) {
          return { success: false, error: 'missing_slot', message: 'Need start_iso and end_iso to hold a slot.' };
        }
        // Expiry = min(2 owner-workdays from now, the slot's own start).
        const { addWorkdays } = await import('../../utils/workHours');
        const twoWd = addWorkdays(new Date().toISOString(), 2, context.profile);
        const expiresAt = Date.parse(twoWd) < Date.parse(startIso) ? twoWd : startIso;

        if (isOwner) {
          const hold = sh.createSlotHold({
            ownerUserId,
            holderSlackId: typeof args.holder_slack_id === 'string' ? args.holder_slack_id : null,
            holderName: (args.holder_name as string | undefined) ?? 'someone',
            subject: args.subject as string | undefined,
            startIso, endIso,
            originChannel: context.channelId,
            originThreadTs: context.threadTs,
            reason: args.reason as string | undefined,
            expiresAt,
          });
          return { success: true, hold_id: hold.id, expires_at: expiresAt };
        }

        // Colleague path — validate the slot was offered here, enforce the cap.
        const holderSlackId = context.userId;
        const { getOfferedSlots } = await import('../../utils/offeredSlotsStash');
        const offered = getOfferedSlots(context.channelId, context.threadTs) ?? [];
        const startMs = Date.parse(startIso);
        const wasOffered = offered.some(o => Math.abs(Date.parse(o.startIso) - startMs) <= 60_000);
        if (!wasOffered) {
          return { success: false, error: 'slot_not_offered', message: 'You can only hold a time I actually offered you in this conversation.' };
        }
        // v3.5.x — holds ACCUMULATE; they don't blanket-replace. The old
        // repick-replace released ALL of the holder's prior holds on every call,
        // so "hold these 3 options" left only the last — the cap of 3 was
        // unreachable and "all three are held" was a false narrative (Oran,
        // 2026-06-25). Now: re-holding the SAME slot is idempotent (drop just
        // that slot's prior hold, keep the others); a DIFFERENT slot stacks,
        // bounded by ≤MAX_HOLDS_PER_HOLDER total AND ≤MAX_HOLDS_PER_MEETING for
        // one meeting (subject). Owner: "3 per holder, no more than 2 per meeting."
        sh.releaseHoldsForOwner(ownerUserId, { holderSlackId, startIso }, 'replaced_same_slot');
        if (sh.countActiveHoldsForHolder(ownerUserId, holderSlackId) >= sh.MAX_HOLDS_PER_HOLDER) {
          return { success: false, error: 'hold_cap_reached', message: `You already have ${sh.MAX_HOLDS_PER_HOLDER} times on hold — release one before adding another.` };
        }
        if (sh.countActiveHoldsForHolderSubject(ownerUserId, holderSlackId, args.subject as string | undefined) >= sh.MAX_HOLDS_PER_MEETING) {
          return { success: false, error: 'meeting_hold_cap_reached', message: `You already have ${sh.MAX_HOLDS_PER_MEETING} slots on hold for that meeting — release one before holding another for it.` };
        }
        const { getPersonMemory: getPM } = await import('../../db');
        const requesterRow = getPM(holderSlackId);
        const hold = sh.createSlotHold({
          ownerUserId,
          holderSlackId,
          holderName: requesterRow?.name ?? (args.holder_name as string | undefined) ?? 'a colleague',
          subject: args.subject as string | undefined,
          startIso, endIso,
          originChannel: context.channelId,
          originThreadTs: context.threadTs,
          reason: args.reason as string | undefined,
          expiresAt,
        });
        return { success: true, hold_id: hold.id, expires_at: expiresAt, message: 'Holding it tentatively while you check.' };
      }
      case 'get_calendar': {
        const rawEvents = await getCalendarEvents(
          userEmail,
          args.start_date as string,
          args.end_date as string,
          timezone,
          args.force_refresh === true,  // v3.2.x (#121) — user asked to LOOK now → fresh
        );
        const processed = processCalendarEvents(rawEvents, userEmail, context.profile.user.name, timezone, context.profile);

        // v3.3 (fix #2) — Working Elsewhere enrichment. If the range covers
        // WE days, attach the away-TZ note so Sonnet does NOT eyeball home-TZ
        // "mornings clear" (the regression that offered Israel mornings while
        // the owner was in Boston). Null when no WE marker → nothing attached.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const weModGc = require('../../utils/workingElsewhere') as typeof import('../../utils/workingElsewhere');
        const weNoteGc = await weModGc.summarizeWorkingElsewhere(rawEvents, timezone, context.profile.user.slack_user_id, args.start_date as string, args.end_date as string);

        // v2.8.6 (99C, Shape A) — when the query window comes back with no
        // events on an owner-DM turn, enrich the result with recent
        // delete_meeting + create_meeting audit entries that intersect the
        // window. Closes the "did you cancel the
        // meeting you booked with X?" amnesia — get_calendar returns empty
        // post-delete, but the booking + delete are both in audit_log. Owner-DM
        // only — colleagues mustn't see audit traces of meetings they're not on.
        const isOwnerDm = context.senderRole === 'owner' && context.isMpim !== true;
        const eventCount = Array.isArray(processed) ? processed.length : 0;
        if (isOwnerDm && eventCount === 0) {
          try {
            const { recentAuditEntries } = await import('../../db/client');
            const audits = recentAuditEntries({ action: 'delete_meeting', windowDays: 7 });
            const auditsCreate = recentAuditEntries({ action: 'create_meeting', windowDays: 7 });
            // Filter to entries whose event_start_iso falls inside the queried window.
            const windowStartMs = Date.parse(args.start_date as string);
            const windowEndMs = Date.parse(args.end_date as string);
            const inWindow = (e: { details: Record<string, unknown> | null }): boolean => {
              const start = e.details?.event_start_iso;
              if (typeof start !== 'string') return false;
              const ms = Date.parse(start);
              if (!Number.isFinite(ms)) return false;
              return ms >= windowStartMs && ms <= windowEndMs + 24 * 60 * 60 * 1000;
            };
            const relevantDeletes = audits.filter(inWindow);
            const relevantCreates = auditsCreate.filter(inWindow);
            if (relevantDeletes.length > 0 || relevantCreates.length > 0) {
              const fmt = (action: 'cancelled' | 'created', e: { timestamp: string; details: Record<string, unknown> | null }) => {
                const subj = (e.details?.subject as string | undefined) ?? '(no subject)';
                const start = (e.details?.event_start_iso as string | undefined) ?? '';
                return `- ${action} "${subj}" (was on ${start.slice(0, 16) || 'unknown date'}) at ${e.timestamp}`;
              };
              const lines = [
                ...relevantCreates.map(e => fmt('created', e)),
                ...relevantDeletes.map(e => fmt('cancelled', e)),
              ];
              return {
                events: processed,
                _audit_context: `Calendar window is empty for the requested range, but Maelle has performed recent calendar actions inside this window. When the owner asks "did you do X" / "have you booked Y" / "what happened to Z", use this audit context BEFORE saying "I don't have a record":\n${lines.join('\n')}`,
                ...(weNoteGc ?? {}),
              };
            }
          } catch (err) {
            logger.warn('get_calendar audit enrichment threw — returning bare events', {
              err: String(err).slice(0, 200),
            });
          }
        }

        // v3.3.7 (#125a) — colleague-path calendar scoping. A colleague (not in
        // MPIM with owner present) only ever sees the meetings THEY are on.
        // Shipping the full
        // day to Sonnet led to wrong availability answers eyeballed off the
        // event list. With only shared meetings visible, "when is our sync?"
        // still works, and availability can ONLY come from find_available_slots
        // / check_join_availability — there is nothing else to reason from.
        // This also closes the enumeration-privacy hole in code rather than
        // asking Sonnet nicely.
        const isColleaguePath = context.senderRole === 'colleague' && context.isOwnerInGroup !== true;
        if (isColleaguePath) {
          let colleagueEmailLower = '';
          try {
            colleagueEmailLower = (getPersonMemory(context.userId)?.email ?? '').toLowerCase();
          } catch { /* unknown colleague → no shared events, note still explains */ }
          const sharedRaw = rawEvents.filter(ev => {
            if (!colleagueEmailLower) return false;
            const onAttendees = (ev.attendees ?? []).some(
              a => (a?.emailAddress?.address ?? '').toLowerCase() === colleagueEmailLower,
            );
            const isOrganizer = ((ev.organizer?.emailAddress?.address ?? '').toLowerCase() === colleagueEmailLower);
            return onAttendees || isOrganizer;
          });
          const sharedProcessed = processCalendarEvents(sharedRaw, userEmail, context.profile.user.name, timezone, context.profile);
          return {
            events: sharedProcessed,
            _colleague_view: true,
            _scope_note: 'COLLEAGUE VIEW — this list contains ONLY the meetings this colleague is on (their shared meetings with the owner). The rest of the owner\'s calendar is not visible here and must never be described or enumerated. This is NOT an availability source: whether the owner is free/busy at any time comes ONLY from find_available_slots (or check_join_availability for joining an existing meeting) — never from the absence or presence of events in this list.',
          };
        }

        // v3.6.4 — visibility for the optional-join tier. A TIMED
        // workingElsewhere event is a "join only if free" meeting (e.g. a daily
        // standup), not a hard commitment. Tag the result so Sonnet lists it but
        // never treats it as blocking, and knows a booking can sit over it.
        const optionalJoinNote = rawEvents.some(e => !e.isAllDay && !e.isCancelled && e.showAs === 'workingElsewhere')
          ? { _optional_join_note: 'Any listed event with showAs "workingElsewhere" that is NOT all-day is an OPTIONAL-join meeting (the owner attends only if free — e.g. a standup), NOT a hard commitment. Present it as "optional, joins if free"; it never blocks the owner and a new meeting may be booked over it (he simply skips it). (An ALL-DAY workingElsewhere event is a travel day — a different thing entirely.)' }
          : undefined;
        const gcNotes = { ...(weNoteGc ?? {}), ...(optionalJoinNote ?? {}) };
        return Object.keys(gcNotes).length > 0 ? { events: processed, ...gcNotes } : processed;
      }

      case 'analyze_calendar': {
        const rawEvents = await getCalendarEvents(
          userEmail,
          args.start_date as string,
          args.end_date as string,
          timezone,
        );
        const processed = processCalendarEvents(rawEvents, userEmail, context.profile.user.name, timezone, context.profile);
        // v3.0.3 — analyzeCalendar is read-only. Suppression handled at
        // row-write time elsewhere.
        const _suppressed = getSuppressedEventIds(context.profile.user.slack_user_id);
        void _suppressed;
        const analysis = analyzeCalendar(processed, args.start_date as string, args.end_date as string, context.profile);
        // v3.6.x (bug 1.2) — category per-day / per-week limit breaches. The
        // detection logic already exists (findCategoryViolations, run by the
        // daily calendar-health sweep) but was never wired into the INTERACTIVE
        // review, so "how does my week look?" never flagged e.g. 4 Weeklies on a
        // day whose limit is 3. Mirror calendarHealth's pass and merge each
        // violation into the day it lands on (per_week → its week-start day, or
        // day 0 when that week-start falls outside the queried range).
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { findCategoryViolations } = require('../../utils/categoryRules') as
            typeof import('../../utils/categoryRules');
          const rangeStart = DateTime.fromISO(args.start_date as string, { zone: timezone }).startOf('day');
          const rangeEnd = DateTime.fromISO(args.end_date as string, { zone: timezone }).endOf('day');
          const violations = findCategoryViolations({ events: rawEvents, profile: context.profile, rangeStart, rangeEnd });
          for (const v of violations) {
            const target = analysis.find(d => d.date === v.window_start) ?? analysis[0];
            if (!target) continue;
            const where = v.rule_broken === 'per_day' ? `on ${v.window_label}` : `in the ${v.window_label}`;
            target.issues.push({
              type: 'category_over_limit',
              severity: 'medium',
              detail: `${v.category_name} ${v.rule_broken.replace('_', '-')} limit is ${v.rule_value}; ${where} there ${v.current_count === 1 ? 'is' : 'are'} ${v.current_count}.`,
              suggestedFix: 'Move one to another day, or confirm it\'s intentional.',
            });
          }
        } catch (err) {
          logger.warn('analyze_calendar — category violation pass threw, skipping', { err: String(err).slice(0, 200) });
        }
        // v3.3 (fix #2) — attach the Working Elsewhere note when the range has
        // WE days, so issue-narration is framed in the away timezone too.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const weModAc = require('../../utils/workingElsewhere') as typeof import('../../utils/workingElsewhere');
        const weNoteAc = await weModAc.summarizeWorkingElsewhere(rawEvents, timezone, context.profile.user.slack_user_id, args.start_date as string, args.end_date as string);
        return weNoteAc ? { day_analysis: analysis, ...weNoteAc } : analysis;
      }

      case 'get_free_busy':
        try {
          const raw = await getFreeBusy(userEmail, args.emails as string[], args.start_date as string, args.end_date as string, timezone, args.force_refresh === true);
          // v2.1.5 — for colleague-context asks, synthesize out-of-work-hours
          // busy blocks on the OWNER's row so the free gaps returned to Sonnet
          // are already clipped to the owner's work hours. A colleague should not
          // be able to learn that 09:00 is free when the office day starts at
          // 10:30 — out-of-hours availability requires explicit owner override,
          // not a drive-by "check get_free_busy" bypass. Owner-path calls get
          // raw data (owner knows their own schedule and may want all gaps).
          const isColleaguePath = context.senderRole === 'colleague' && context.isOwnerInGroup !== true;
          if (isColleaguePath && Array.isArray(args.emails) && (args.emails as string[]).includes(userEmail)) {
            const ownerBusy = raw[userEmail] ?? [];
            const synthetic = buildOutOfHoursBusy(
              args.start_date as string,
              args.end_date as string,
              context.profile,
              timezone,
            );
            raw[userEmail] = [...ownerBusy, ...synthetic];
          }
          // Daniel-bug (offer-then-retract) — get_free_busy returns RAW per-person
          // blocks, NOT a validated set of common bookable slots. When it's called
          // with attendees, presenting its gaps as "both free / best bet" is
          // owner-only eyeballing that contradicts the booking check (planMeeting
          // DOES intersect attendees) → the 14:30 "both free" then "both busy"
          // flip. Steer to find_available_slots, the one tool that intersects
          // everyone's calendar + work hours. (Stronger than the static tool
          // description, which Sonnet ignored — this rides the result it just read.)
          // #WE-spine — owner free/busy on a travel day: attach the away-tz note
          // so "am I free Wed 3pm?" on a Boston day isn't answered in a misleading
          // home clock. Record-based (summarizeWorkingElsewhere with no events →
          // travel-record only, ZERO Graph) — the SAME one-source the search uses.
          let weFbNote: string | null = null;
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const weModFb = require('../../utils/workingElsewhere') as typeof import('../../utils/workingElsewhere');
            const weFb = await weModFb.summarizeWorkingElsewhere([], timezone, context.profile.user.slack_user_id, args.start_date as string, args.end_date as string);
            weFbNote = weFb?._working_elsewhere_note ?? null;
          } catch { /* fail open — no note */ }
          // Daniel-bug (offer-then-retract) — get_free_busy returns RAW per-person
          // blocks, NOT a validated set of common bookable slots. When it's called
          // with attendees, presenting its gaps as "both free / best bet" is
          // owner-only eyeballing that contradicts the booking check (planMeeting
          // DOES intersect attendees) → the 14:30 "both free" then "both busy"
          // flip. Steer to find_available_slots, the one tool that intersects
          // everyone's calendar + work hours. (Stronger than the static tool
          // description, which Sonnet ignored — this rides the result it just read.)
          const emailsArg = Array.isArray(args.emails) ? (args.emails as string[]) : [];
          const hasOtherAttendees = emailsArg.some(e => e && e.toLowerCase() !== userEmail.toLowerCase());
          if (hasOtherAttendees) {
            return {
              ...(raw as Record<string, unknown>),
              ...(weFbNote ? { _working_elsewhere_note: weFbNote } : {}),
              _note: 'These are RAW per-person free/busy blocks, NOT a validated set of common bookable slots. To present bookable meeting options across these people (or ANY meeting with attendees), call find_available_slots — it intersects everyone\'s calendar + work hours. Do NOT offer gaps from this result as "both free" / "best bet"; that is owner-only eyeballing and will contradict the attendee check at booking time.',
            };
          }
          return weFbNote ? { ...(raw as Record<string, unknown>), _working_elsewhere_note: weFbNote } : raw;
        } catch (err) {
          if (err instanceof GraphPermissionError) {
            return {
              error: 'calendar_permission_denied',
              message: 'I can read your calendar but I don\'t have permission to check other people\'s availability. ' +
                `The Azure app needs Calendars.Read application permission granted by a ${context.profile.user.company ?? 'company'} tenant admin. ` +
                'Tell the user you cannot check their colleagues\' schedules right now due to a permissions issue, ' +
                'and ask if they know when those people are free.',
            };
          }
          throw err;
        }

      case 'find_available_slots':
        // v1.6.4 — meeting_mode is required from the LLM. Let findAvailableSlots
        // scope the workDays per mode (in_person → office only, else both). Do
        // NOT pre-pass workDays from here — the function's own mode-aware logic
        // decides so in_person is enforced as a hard rule.
        {
          // v3.1.6 (L2) — duration safety default — code backstop for when
          // Sonnet omits duration entirely (the tool description tells her to
          // default to default_meeting_duration when no length was stated).
          if (args.duration_minutes == null) {
            const allowed = context.profile.meetings.allowed_durations;
            args.duration_minutes = context.profile.meetings.default_meeting_duration
              ?? [...allowed].sort((a, b) => a - b)[0];
          }
          // v3.0.3 — entry log for diagnostic visibility. Shows exactly what
          // Sonnet passes — critical for debugging "did the time-of-day window
          // actually clip?" and "did she pass the attendee?" cases.
          logger.info('find_available_slots — call entry', {
            senderRole: context.senderRole,
            isOwnerInGroup: context.isOwnerInGroup,
            threadTs: context.threadTs,
            search_from: args.search_from,           // raw, as Sonnet passed
            search_to: args.search_to,               // raw, as Sonnet passed
            search_from_has_time: typeof args.search_from === 'string' && args.search_from.includes('T'),
            search_to_has_time: typeof args.search_to === 'string' && args.search_to.includes('T'),
            duration_minutes: args.duration_minutes,
            attendee_emails: args.attendee_emails,
            meeting_mode: args.meeting_mode,
            relaxed: args.relaxed === true,
            ignore_attendee_availability: args.ignore_attendee_availability === true,
            moving_event_ids: args.moving_event_ids,
            preferred_slot: args.preferred_slot,
            category: args.category,
          });

          const mode = (args.meeting_mode as string | undefined) ?? 'either';
          if (!['in_person', 'online', 'either', 'custom'].includes(mode)) {
            return {
              error: 'invalid_meeting_mode',
              message: `meeting_mode must be one of: in_person, online, either, custom. Got "${mode}". Ask the owner which one applies before calling again.`,
            };
          }
          // v2.2.5 (C) — must_be_after_event_id: clip searchFrom to AFTER the
          // predecessor's end. Optional; when omitted, behavior is unchanged.
          // Predecessor lookup via getCalendarEvents window around the
          // searchFrom date — saves a per-event-id roundtrip and is bounded.
          let effectiveSearchFrom = args.search_from as string;
          // v3.0.6 — expand date-only search_to to end-of-that-day. The
          // downstream parser reads any date-only string as 00:00 of that day,
          // so a bare `search_from=search_to="2026-05-27"` would collapse to a
          // 0-minute window and return nothing on a wide-open day. Mirror what
          // getCalendarEvents does internally via `toEndOfDayLocal` — append
          // T23:59:59 to a bare YYYY-MM-DD.
          let effectiveSearchTo = ((): string => {
            const raw = args.search_to as string;
            if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
              return `${raw}T23:59:59`;
            }
            return raw;
          })();
          // Input-side timezone conversion (the Tyler bug). When the requested
          // meeting time was given in a NON-owner timezone ("9:45 AM ET"),
          // Sonnet tags it with `search_window_timezone` and passes the clock
          // time as-given (09:45). Re-interpret those clock times AS that zone
          // and convert to the owner timezone for the search — so Sonnet never
          // hand-converts a search time. Without this, Sonnet searched 09:45
          // ISRAEL for a 9:45-ET ask → before the 10:30 start →
          // outside_owner_work_hours → then mis-explained it as "Wednesday ends
          // before 16:45." Symmetric to present_in_timezone (output side).
          const searchWindowTz = typeof args.search_window_timezone === 'string'
            ? args.search_window_timezone.trim()
            : '';
          if (searchWindowTz) {
            // v3.4.2 (A2) — shared helper, identical to create/move's conversion.
            const fromRequested = effectiveSearchFrom;
            effectiveSearchFrom = reinterpretClockInZone(effectiveSearchFrom, searchWindowTz, timezone);
            effectiveSearchTo = reinterpretClockInZone(effectiveSearchTo, searchWindowTz, timezone);
            logger.info('find_available_slots — converted search window from requested TZ to owner TZ', {
              searchWindowTz, from_requested: fromRequested, from_owner: effectiveSearchFrom,
            });
          }
          const mustBeAfterId = args.must_be_after_event_id as string | undefined;
          if (mustBeAfterId) {
            try {
              const probeFrom = DateTime.fromISO(args.search_from as string, { zone: timezone })
                .minus({ days: 30 }).toFormat('yyyy-MM-dd');
              const probeTo = DateTime.fromISO(args.search_to as string, { zone: timezone })
                .plus({ days: 30 }).toFormat('yyyy-MM-dd');
              const events = await getCalendarEvents(userEmail, probeFrom, probeTo, timezone);
              const predecessor = events.find(e => e.id === mustBeAfterId);
              if (predecessor) {
                const predEnd = DateTime.fromISO(predecessor.end.dateTime, { zone: predecessor.end.timeZone ?? 'utc' })
                  .setZone(timezone);
                const requestedFrom = DateTime.fromISO(args.search_from as string, { zone: timezone });
                if (predEnd.toMillis() > requestedFrom.toMillis()) {
                  effectiveSearchFrom = predEnd.toISO()!;
                  logger.info('find_available_slots — clipped searchFrom to after predecessor', {
                    predecessorId: mustBeAfterId,
                    predecessorEnd: predEnd.toISO(),
                    originalFrom: args.search_from,
                    clippedFrom: effectiveSearchFrom,
                  });
                }
              } else {
                logger.warn('find_available_slots — must_be_after_event_id not found, ignoring', {
                  eventId: mustBeAfterId,
                });
              }
            } catch (err) {
              logger.warn('find_available_slots — predecessor lookup threw, ignoring constraint', {
                err: String(err).slice(0, 200),
              });
            }
          }

          // v3.1.x — zero-width / inverted window guard. "Am I free at 3pm ET
          // next Tuesday?" is a point-in-time availability check; Sonnet maps it
          // to search_from == search_to (a single instant). getFreeBusy bails on
          // a zero-width (or inverted) window and returns empty, the
          // relaxed-recovery fallback also returns empty, so the whole iteration
          // is wasted and Sonnet has to redo the search with a wider window on
          // the NEXT turn. Mirror the date-only expansion above: when from >=
          // to, expand `to` to
          // from + duration_minutes so the requested instant is actually
          // tested. (A predecessor-clip that pushed `from` past `to` lands
          // here too.) The preferred_slot (when set) already pins the exact
          // instant inside this window, so the asked time is guaranteed tested.
          {
            const fromDt = DateTime.fromISO(effectiveSearchFrom, { zone: timezone });
            const toDt = DateTime.fromISO(effectiveSearchTo, { zone: timezone });
            if (fromDt.isValid && toDt.isValid && fromDt.toMillis() >= toDt.toMillis()) {
              const durMin = (args.duration_minutes as number) ?? 30;
              const expandedTo = fromDt.plus({ minutes: durMin }).toISO();
              if (expandedTo) {
                logger.info('find_available_slots — zero-width/inverted window expanded to from+duration', {
                  original_from: effectiveSearchFrom,
                  original_to: effectiveSearchTo,
                  expanded_to: expandedTo,
                  duration_minutes: durMin,
                });
                effectiveSearchTo = expandedTo;
              }
            }
          }

          // v2.3.2 (5B/5C) / v2.3.6 — auto-load attendee work-hour availability
          // from people_memory via shared helper. Pre-clips slots to the
          // intersection of every attendee's window so Brett (Boston/EST)
          // never gets proposed 10:15 IL (3:15 ET). Helper covers both this
          // path and coordinate_meeting consistently. Owner can opt out via
          // `ignore_attendee_availability: true` for "find times I'm free,
          // I'll handle the others" scenarios.
          let attendeeEmails = (args.attendee_emails as string[]) ?? [];

          // MOVE-PATH AUTHORITY (owner-path only): when moving_event_ids is set
          // AND the owner is the initiator, the meeting's existing attendees
          // ARE the attendees to check. Owner direction: "find_available_slots
          // should just take the list of people to check if they're free or
          // not" — tool reads them itself; Sonnet doesn't have to remember.
          // Closes the painful Sales BiWeekly trace where Sonnet's later call
          // dropped Isaac from attendee_emails and 17:00 was proposed without
          // Isaac being verified. Colleague-path skips this — that flow uses
          // per-attendee annotation (see v2.7.0 colleague-path block below).
          const isOwnerInitiatedSearch =
            context.senderRole === 'owner' || context.isOwnerInGroup === true;
          const movingIdsForAttendees = (isOwnerInitiatedSearch && Array.isArray(args.moving_event_ids))
            ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
            : [];
          if (movingIdsForAttendees.length > 0) {
            try {
              const { resolveMovingEventAttendees } = await import('../../utils/movingEventAttendees');
              const fromEvent = await resolveMovingEventAttendees(
                movingIdsForAttendees,
                userEmail,
                timezone,
              );
              if (fromEvent.length > 0) {
                // Union with any explicit args.attendee_emails (don't drop what
                // Sonnet passed; just guarantee the event's attendees are in).
                const merged = new Set<string>([...attendeeEmails.map(e => e.toLowerCase()), ...fromEvent.map(e => e.toLowerCase())]);
                const before = attendeeEmails.length;
                attendeeEmails = [...merged];
                if (attendeeEmails.length > before) {
                  logger.info('find_available_slots — auto-filled attendees from moving event', {
                    movingEventIds: movingIdsForAttendees,
                    addedFromEvent: fromEvent,
                    finalAttendees: attendeeEmails,
                  });
                }
              }
            } catch (err) {
              logger.warn('find_available_slots — moving-event attendees recovery threw', {
                err: String(err).slice(0, 200),
              });
            }
          }

          // v3.1.2 (Ayala-TZ) — auto-add @-mentioned colleagues to attendeeEmails
          // on owner-path turns. When the owner pings Maelle quoting a colleague
          // ("@Maelle @Ayala asking if I'm free at..."), Sonnet often calls
          // find_available_slots WITHOUT including the colleague in
          // attendee_emails — so loadAttendeeAvailabilityForEmails below has
          // nothing to load, work-hours clip never runs, and slots fall in the
          // colleague's middle-of-the-night. Auto-add catches this so the
          // v2.8.3 per_attendee_local enrichment also kicks in, giving Sonnet the
          // dual-TZ rendering she needs.
          //
          // Owner-path only. Detection is structured Slack mention syntax
          // <@Uxxx>, not freeform NL — no scaling concern.
          if (isOwnerInitiatedSearch && context.conversationHistory && context.conversationHistory.length > 0) {
            try {
              const lastUserMsg = [...context.conversationHistory]
                .reverse()
                .find(m => m.role === 'user');
              const mentionRe = /<@(U[A-Z0-9]+)>/g;
              const mentionedIds = new Set<string>();
              if (lastUserMsg) {
                for (const m of lastUserMsg.content.matchAll(mentionRe)) {
                  mentionedIds.add(m[1]);
                }
              }
              if (mentionedIds.size > 0) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getPersonMemory } = require('../../db') as typeof import('../../db');
                const ownerLower = userEmail.toLowerCase();
                const ownerSlackId = context.profile.user.slack_user_id;
                const existingLower = new Set(attendeeEmails.map(e => e.toLowerCase()));
                const added: string[] = [];
                for (const id of mentionedIds) {
                  if (id === ownerSlackId) continue;  // skip @Maelle/@Owner-self mentions
                  const person = getPersonMemory(id);
                  const email = person?.email;
                  if (!email || email.toLowerCase() === ownerLower) continue;
                  if (existingLower.has(email.toLowerCase())) continue;
                  attendeeEmails.push(email);
                  existingLower.add(email.toLowerCase());
                  added.push(email);
                }
                if (added.length > 0) {
                  logger.info('find_available_slots — auto-added @-mentioned colleagues to attendees', {
                    threadTs: context.threadTs,
                    added,
                  });
                }
              }
            } catch (err) {
              logger.warn('find_available_slots — @-mention auto-add threw, proceeding without', {
                err: String(err).slice(0, 200),
              });
            }
          }

          // v3.6.4 — union the internal colleagues the orchestrator resolved
          // from THIS turn's named participants (deterministic pre-search pass).
          // This is the guarantee that a KNOWN named colleague is in the search
          // even when Sonnet passed a partial attendee_emails (Lori dropped,
          // 07-08) or the wrong shape — resolution no longer depends on Sonnet
          // remembering to call find_slack_user. Per-turn set (no thread
          // staleness), owner AND colleague paths, deduped; the owner-self and
          // any ambiguous/external names were already filtered out upstream.
          if (Array.isArray(context.resolvedMeetingAttendees) && context.resolvedMeetingAttendees.length > 0) {
            const existingLower = new Set(attendeeEmails.map(e => e.toLowerCase()));
            const added: string[] = [];
            for (const email of context.resolvedMeetingAttendees) {
              const lower = (email ?? '').toLowerCase().trim();
              if (!lower.includes('@') || existingLower.has(lower)) continue;
              attendeeEmails.push(email);
              existingLower.add(lower);
              added.push(email);
            }
            if (added.length > 0) {
              logger.info('find_available_slots — unioned orchestrator-resolved internal attendees', {
                added,
                finalAttendees: attendeeEmails,
                senderRole: context.senderRole,
              });
            }
          }

          // Auto-fill from this thread's prior attendee context. When Sonnet
          // calls find_available_slots WITHOUT attendee_emails but a previous
          // call in this thread already established who the meeting is for,
          // recover that list so the work-hours / availability constraint
          // isn't silently dropped between turns.
          if (attendeeEmails.length === 0 && context.threadTs) {
            try {
              const { getThreadAttendees } = await import('../../utils/threadAttendees');
              const recovered = getThreadAttendees(context.threadTs);
              if (recovered.length > 0) {
                logger.info('find_available_slots — auto-filled attendee_emails from thread context', {
                  threadTs: context.threadTs,
                  recovered,
                });
                attendeeEmails = recovered;
              }
            } catch (err) {
              logger.warn('find_available_slots — thread attendees recovery threw', {
                err: String(err).slice(0, 200),
              });
            }
          } else if (attendeeEmails.length > 0 && context.threadTs) {
            // Record for future calls in this thread.
            try {
              const { recordThreadAttendees } = await import('../../utils/threadAttendees');
              recordThreadAttendees(context.threadTs, attendeeEmails);
            } catch (_) { /* best-effort */ }
          }
          // Owner can opt out of attendee BUSY filtering (their other meetings)
          // when forcing a slot regardless of their existing calendar — but
          // their TIMEZONE / work-hours window is ALWAYS honored, no flag
          // Owner direction: when the owner triggers the full override
          // (relaxed=true on owner-path, OR explicit
          // ignore_attendee_availability=true), the override is TOTAL — drop
          // BOTH the busy filter AND the attendee work-hours clip. The attendee
          // work-hours data is owner-curated in people_memory, can go stale, and
          // would otherwise silently filter owner-valid slots. So: surface the
          // work-hours rejection once (via day_summary.blocked_by attribution
          // emitted by calendar.ts), and on owner override the tool drops the
          // clip too. "If I decide, it's on me."
          // REQUESTER ≠ ATTENDEE — but DEFAULT-SAFE for the common case. When a
          // colleague asks to book a meeting they're
          // ATTENDING, they ARE an attendee: their TZ drives per_attendee_local
          // (correct cross-TZ labels) and their work-hours correctly steer the
          // search — dropping them would BREAK that (lose the ET conversion +
          // the clip). So we only drop the requester when Sonnet explicitly
          // flags her as organizing-not-attending (`requester_is_attending:
          // false` — e.g. an EA collecting options for OTHERS, like Yael). Then
          // her own calendar/work-hours stop clipping the search and she's not
          // annotated "busy" back to herself. Default (flag unset/true) = keep,
          // so the attending-requester case is untouched.
          if (!isOwnerInitiatedSearch && context.userId && args.requester_is_attending === false) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { getPersonMemory } = require('../../db') as typeof import('../../db');
              const requesterEmailLower = (getPersonMemory(context.userId)?.email ?? '').toLowerCase();
              if (requesterEmailLower) {
                const before = attendeeEmails.length;
                attendeeEmails = attendeeEmails.filter(e => e.toLowerCase() !== requesterEmailLower);
                if (attendeeEmails.length < before) {
                  logger.info('find_available_slots — dropped requester from attendees (organizer, not attendee)', {
                    requester: requesterEmailLower,
                  });
                }
              }
            } catch (err) {
              logger.warn('find_available_slots — requester-exclusion lookup threw, continuing', {
                err: String(err).slice(0, 200),
              });
            }
          }

          const ignoreAttendeeBusy =
            args.ignore_attendee_availability === true
            || (args.relaxed === true && isOwnerInitiatedSearch);

          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { loadAttendeeAvailabilityForEmails } = require('../../utils/attendeeAvailability') as
            typeof import('../../utils/attendeeAvailability');
          // Drop the work-hours clip entirely when override is active. The
          // first call (no override) loads availability and lets calendar.ts
          // surface `outside_attendee_work_hours:<email>` per blocked attendee
          // so Sonnet narrates the conflict. Owner's retry with override
          // gets unfiltered slots.
          const attendeeAvailability = ignoreAttendeeBusy
            ? undefined
            : loadAttendeeAvailabilityForEmails(attendeeEmails, userEmail);

          // #77 — owner-initiated path with attendees: auto-pass
          // attendeeBusyEmails so Graph free/busy filters the candidate pool,
          // not just work-hour clipping. Prior fixes (v2.2.3 #43, v2.3.6 #71)
          // wired the work-hours half. The colleague-initiated path (coord state
          // machine) deliberately does NOT auto-pass — coord uses
          // annotateSlotsWithAttendeeStatus to TAG slots with status, showing
          // all options per owner's rule.
          const attendeeBusyEmails = (isOwnerInitiatedSearch && !ignoreAttendeeBusy && attendeeEmails.length > 0)
            ? attendeeEmails
            : undefined;

          // Diagnostics receiver — surfaces per-day summary to Sonnet so she
          // can honestly answer "why no Monday?" instead of fabricating.
          const diagnosticsOut: {
            rejectedCounts?: Record<string, number>;
            rejectedExamples?: Record<string, string[]>;
            daySummary?: Array<{
              date: string;
              accepted: number;
              top_reasons: string[];
              blocked_by?: Array<{ email: string; slots_blocked: number }>;
            }>;
            workingElsewhere?: {
              resolved: Array<{ date: string; away_tz: string; location: string }>;
              unresolved: Array<{ date: string; location: string }>;
            };
            unresolvedAttendees?: string[];
          } = {};

          // v2.7.6 — narrow-window detection. When owner explicitly named a
          // day/window ("Monday", "this week", "Tuesday afternoon"), the
          // search window will be ≤7 days. Disable auto-expand in that case
          // so we don't silently jump to next week. Open-ended asks ("when
          // can we meet") usually pass wider windows and benefit from
          // auto-expand.
          const userNamedNarrowWindow = (() => {
            try {
              const from = DateTime.fromISO(effectiveSearchFrom, { zone: timezone });
              const to = DateTime.fromISO(args.search_to as string, { zone: timezone });
              if (!from.isValid || !to.isValid) return false;
              const spanDays = to.diff(from, 'days').days;
              return spanDays <= 7;
            } catch { return false; }
          })();

          // v3.0.6 — candidate-slots batch validation. When the caller has N
          // specific times to check ("can we do A, B, C, or D?"), Sonnet passes
          // them all as `candidate_slots`. We fire N parallel narrow
          // findAvailableSlots calls (each autoExpand:false) and collect
          // per-candidate verdicts in ONE response — collapsing what would
          // otherwise be N sequential Sonnet round-trips into one.
          //
          // Returns a DIFFERENT shape than the default branch:
          //   { mode: 'candidate_validation', results: [{start, end,
          //     available, broken_rule?, broken_rule_label?}, ...] }
          // Caller (Sonnet) narrates blocked candidates by reading
          // broken_rule_label verbatim.
          if (Array.isArray(args.candidate_slots) && args.candidate_slots.length > 0) {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            const durationMin = args.duration_minutes as number;
            const candidates = args.candidate_slots as Array<{ start: string; end?: string }>;
            const normalized = candidates
              .filter(c => typeof c?.start === 'string' && c.start.length > 0)
              .map(c => {
                // #136 — apply the SAME conversion the default branch runs at :1083.
                // candidate_slots[].start is a clock time tagged with
                // search_window_timezone (the colleague's zone); reinterpret it into
                // the owner's zone BEFORE searching. Without this a 10:00-ET candidate
                // was searched as 10:00 owner-local (the Ayala July-8 bug: tested
                // 10:00 IL instead of 17:00 IL → a false outside_attendee_work_hours
                // that masked the real owner_busy reason).
                const startConv = searchWindowTz
                  ? reinterpretClockInZone(c.start, searchWindowTz, timezone)
                  : c.start;
                let endIso = c.end
                  ? (searchWindowTz ? reinterpretClockInZone(c.end, searchWindowTz, timezone) : c.end)
                  : undefined;
                if (!endIso) {
                  const s = DateTime.fromISO(startConv, { zone: timezone });
                  endIso = s.isValid ? (s.plus({ minutes: durationMin }).toISO() ?? startConv) : startConv;
                }
                return { start: startConv, end: endIso as string };
              });

            // Same rule-label mapping as Guard B uses; kept in sync (extract
            // to a shared helper next time we touch this file).
            const labelFor = (reason: string | undefined): string => {
              switch (reason) {
                case 'outside_owner_work_hours': return `outside ${ownerFirst}'s work hours`;
                case 'outside_attendee_work_hours': return `outside the attendee's working hours`;
                case 'owner_busy_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                case 'owner_busy_or_buffer_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                case 'overlaps_meeting_being_moved': return `overlaps the meeting being moved`;
                case 'focus_time_office': return `would leave ${ownerFirst} under the free-time floor (office day)`;
                case 'focus_time_home': return `would leave ${ownerFirst} under the free-time floor (home day)`;
                case 'floating_block_no_room': return `would leave no room for one of ${ownerFirst}'s daily blocks (lunch / break / etc.)`;
                case 'category_day_type': return `wrong day type for this category (e.g. office-only category on a home day)`;
                case 'category_per_day': return `over ${ownerFirst}'s per-day limit for this category`;
                case 'category_per_week': return `over ${ownerFirst}'s per-week limit for this category`;
                default: return 'unknown';
              }
            };

            const results = await Promise.all(normalized.map(async (cand) => {
              const diag: {
                rejectedCounts?: Record<string, number>;
                workingElsewhere?: {
                  resolved: Array<{ date: string; away_tz: string; location: string }>;
                  unresolved: Array<{ date: string; location: string }>;
                };
              } = {};
              try {
                const slots = await findAvailableSlots({
                  userEmail,
                  timezone,
                  durationMinutes: durationMin,
                  attendeeEmails,
                  attendeeBusyEmails,
                  attendeeAvailability,
                  searchFrom: cand.start,
                  searchTo: cand.end,
                  meetingMode: mode as import('../../connectors/graph/calendar').MeetingMode,
                  travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
                  profile: context.profile,
                  category: args.category as string | undefined,
                  relaxed: args.relaxed === true && context.senderRole === 'owner',
                  excludeEventIds: Array.isArray(args.moving_event_ids)
                    ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
                    : undefined,
                  autoExpand: false,
                  minBufferHours: (context.senderRole === 'owner' || context.isOwnerInGroup === true)
                    ? 1
                    : (context.profile.meetings.min_slot_buffer_hours ?? 4),
                  diagnosticsOut: diag,
                });
                const startMs = DateTime.fromISO(cand.start, { zone: timezone }).toMillis();
                const matches = slots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000);
                // v3.3 — Working Elsewhere reason. On a WE day the slot walk
                // skips without recording a rejection (rejectedCounts is empty),
                // so an unavailable candidate would have NO reason → Sonnet
                // fabricates "conflict." Read diag.workingElsewhere and label it
                // honestly: the candidate is outside his hours WHERE HE IS.
                const candDate = DateTime.fromISO(cand.start, { zone: timezone }).toFormat('yyyy-MM-dd');
                const weResolved = diag.workingElsewhere?.resolved.find(r => r.date === candDate);
                const weUnresolved = diag.workingElsewhere?.unresolved.find(u => u.date === candDate);
                let brokenRule = matches ? undefined : Object.keys(diag.rejectedCounts ?? {})[0];
                let weLabel: string | undefined;
                if (!matches && weResolved) {
                  const awayClock = DateTime.fromISO(cand.start, { zone: timezone }).setZone(weResolved.away_tz).toFormat('HH:mm');
                  brokenRule = 'owner_working_elsewhere';
                  weLabel = `${ownerFirst} is working elsewhere${weResolved.location ? ` (${weResolved.location})` : ''} that day — this is ${awayClock} where he actually is, outside his working hours there. His real window that day is daytime in ${weResolved.location || 'his away location'}.`;
                } else if (!matches && weUnresolved) {
                  brokenRule = 'owner_working_elsewhere';
                  weLabel = `${ownerFirst} is working elsewhere${weUnresolved.location ? ` (${weUnresolved.location})` : ''} that day and I don't have his timezone there — I'd need to confirm his local hours before booking.`;
                }
                return {
                  start: cand.start,
                  end: cand.end,
                  available: matches,
                  ...(brokenRule ? { broken_rule: brokenRule, broken_rule_label: weLabel ?? labelFor(brokenRule) } : {}),
                };
              } catch (err) {
                logger.warn('candidate-slot validation threw — marking unavailable', {
                  candidateStart: cand.start,
                  err: String(err).slice(0, 200),
                });
                return { start: cand.start, end: cand.end, available: false, error: 'validation_error' };
              }
            }));

            const availableCount = results.filter(r => r.available).length;
            logger.info('find_available_slots — candidate_slots batch', {
              candidates: normalized.length,
              available_count: availableCount,
              requester: context.userId,
              threadTs: context.threadTs,
            });

            return {
              mode: 'candidate_validation',
              duration_minutes: durationMin,
              candidates_checked: normalized.length,
              results,
            };
          }

          try {
            const rawSlots = await findAvailableSlots({
              userEmail,
              timezone,
              durationMinutes: args.duration_minutes as number,
              attendeeEmails,
              attendeeBusyEmails,
              searchFrom: effectiveSearchFrom,
              searchTo: effectiveSearchTo,
              preferMorning: args.prefer_morning as boolean | undefined,
              meetingMode: mode as import('../../connectors/graph/calendar').MeetingMode,
              travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
              attendeeAvailability,
              autoExpand: !userNamedNarrowWindow,
              minBufferHours: (context.senderRole === 'owner' || context.isOwnerInGroup === true)
                ? 1
                : (context.profile.meetings.min_slot_buffer_hours ?? 4),
              profile: context.profile,
              // v2.3.2 (2A) — relaxed mode opt-in (owner-only). Bypasses
              // focus / lunch / work-hours; keeps the 5-min between-meeting buffer.
              relaxed: args.relaxed === true && context.senderRole === 'owner',
              // v2.4.1 — when validating/discovering a MOVE, the meeting(s)
              // being moved are subtracted from busy AND forbidden as
              // candidates. See findAvailableSlots.excludeEventIds for the full
              // semantics.
              excludeEventIds: Array.isArray(args.moving_event_ids)
                ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
                : undefined,
              // v2.6 — category scheduling rules. When set, slot loop filters
              // out slots that would violate the category's day_type / per_day /
              // per_week limits.
              category: args.category as string | undefined,
              diagnosticsOut,
            });
            // v3.0.3 — strict-pass log. Shows the effective args the low-level
            // function actually ran with, plus what came back. The crucial fields:
            // effectiveSearchFrom / search_to (after any internal clipping) and
            // the resulting slot count + first few. Pairs with the entry log.
            logger.info('find_available_slots — strict pass result', {
              effectiveSearchFrom,
              search_to: args.search_to,
              attendeeEmailsResolved: attendeeEmails,
              attendeeAvailabilityCount: attendeeAvailability?.length ?? 0,
              ignoreAttendeeBusy,
              userNamedNarrowWindow,
              relaxed: args.relaxed === true && context.senderRole === 'owner',
              slotCount: rawSlots.length,
              firstSlots: rawSlots.slice(0, 5).map(s => ({ start: s.start, end: s.end })),
              daySummary: diagnosticsOut.daySummary?.map(d => ({
                date: d.date, accepted: d.accepted, top_reasons: d.top_reasons,
              })),
            });

            // v3.3.7 (#124h) — internal attendee addresses Graph could NOT
            // resolve. A nonexistent mailbox returns NO busy data → reads as
            // fully free → slots get offered without that person's calendar ever
            // being checked. External addresses are skipped: Graph never has
            // their data, and first-time externals are normal. did_you_mean
            // comes from people_memory by the address's first name token.
            const ownerDomainLower = userEmail.includes('@') ? userEmail.split('@')[1].toLowerCase() : '';
            const unresolvedInternal = (diagnosticsOut.unresolvedAttendees ?? [])
              .filter(e => ownerDomainLower && e.endsWith('@' + ownerDomainLower));
            let attendeeEmailWarning: Record<string, unknown> | undefined;
            if (unresolvedInternal.length > 0) {
              const entries = enrichUnresolvedInternal(unresolvedInternal, ownerDomainLower);
              attendeeEmailWarning = {
                unresolved_attendee_emails: entries,
                _attendee_email_warning: 'These attendee addresses do NOT exist in the company directory — their availability was NOT checked (a nonexistent mailbox reads as fully free). The address is most likely a wrong guess. Re-call find_available_slots with the corrected address (see did_you_mean) or resolve the person via find_slack_user first. Do NOT present any slot as working for that person until the address resolves.',
              };
              logger.warn('find_available_slots — unresolved internal attendee email(s)', {
                unresolvedInternal,
                entries,
              });
            }

            // v3.3.7 (#125a) — colleague-path soft-block narration hint. When
            // the strict pass rejected slots on the owner's SOFT, owner-
            // relaxable protections (free-time floor / 5-min buffer / floating
            // block), the colleague must hear "his day is too loaded around
            // then" (true, mechanism-free) — and an insisted-on time goes to
            // the owner as an approval, never a flat refusal. Hard busy stays
            // "he's booked".
            const SOFT_REJECT_PREFIXES = ['focus_time', 'owner_buffer_collision', 'floating_block_no_room', 'within_lead_time'];
            const softRejectLabels = Object.keys(diagnosticsOut.rejectedCounts ?? {})
              .filter(l => SOFT_REJECT_PREFIXES.some(p => l.startsWith(p)));
            const colleagueSoftBlockHint = (!isOwnerInitiatedSearch && softRejectLabels.length > 0)
              ? {
                  _colleague_soft_block_hint: `Some times in this window were excluded by ${context.profile.user.name.split(' ')[0]}'s day-load protections — NOT by real meetings. To the colleague, phrase those as "his day is pretty loaded around then" (never reveal the mechanism, never enumerate his calendar). If the requester INSISTS on one of those specific times, do NOT flatly refuse and do NOT book it: raise it via create_approval(kind=policy_exception) with the requested slot so he decides.`,
                }
              : undefined;
            // v2.4.2 — narrow to 3 spread options before returning to Sonnet.
            // Owner spec: "spread 3 options" — one per day where possible, then
            // ≥2h apart same-day, then ≥30min last-resort. Single source of
            // truth: tool returns the spread, Sonnet narrates (rather than
            // receiving raw candidates and over-listing).
            // Edge case: narrow validation searches (HYPOTHETICAL VALIDATION
            // rule, "can we do X at Y?") naturally return ≤1 candidate from
            // findAvailableSlots, and pickSpreadSlots' Pass 1 (one-per-day)
            // returns it unchanged. No regression on the validation path.

            // v2.7.6 — auto-relaxed recovery on user-named narrow windows. When
            // strict returns 0 AND owner asked about a specific day/window
            // AND he didn't already opt into relaxed, automatically re-run with
            // relaxed=true so soft-rule-breaking slots surface tagged. Lets
            // Sonnet narrate "12:30 fits everyone but breaks your focus block
            // — book anyway?" instead of "Monday fully booked." Owner-path only.
            const isAlreadyRelaxed = args.relaxed === true && context.senderRole === 'owner';
            // #128 part-2 — a colleague's MUST-BE request (Sonnet sets must_be:
            // they named a specific time, or said "has to be today/tomorrow" and
            // the owner's clean options are too far) reuses the SAME relaxed
            // recovery as the owner path to surface the soft-blocked candidates —
            // but they come back for the OWNER's approval ONLY, never offered to
            // the colleague (see the must-be return below). Regular colleague
            // requests stay fully blocked (no recovery, no surfacing).
            const mustBe = args.must_be === true && !isOwnerInitiatedSearch;
            const shouldRecover =
              rawSlots.length === 0
              && (isOwnerInitiatedSearch || mustBe)
              && userNamedNarrowWindow
              && !isAlreadyRelaxed;
            // ── Rule 6 backstop (shared) — attendee free/busy is a HELPER,
            // never a blocker. When the STRICT pass returned 0 ONLY because
            // attendee(s) are busy/off-hours, don't dead-end. Re-run the SAME
            // window recovering the owner's real openings, presented per
            // audience. ONE function, two callers (rule 2 — no parallel copies):
            //   'owner_tagged'         — owner rules stay STRICT (his day / focus
            //       / own busy all enforced via checkSlot); attendee conflicts
            //       come back TAGGED (attendee_conflicts[]) so he sees his open
            //       times + who can't make each and books whom he likes (rules
            //       6/7/11). This is what stops the "0 clean → Sonnet flips
            //       ignore_attendee_availability → offered-then-bounced" loop
            //       (Maayan+Lori, 2026-07-08): the tool hands back the annotated
            //       truth in ONE call, so Sonnet never guesses a blind 2nd search.
            //   'colleague_owner_only' — owner-only (attendees drop to a high-
            //       level caveat; a colleague never sees calendar detail, rule 7).
            //       If the owner is himself busy, owner-only also returns 0 →
            //       honest "he's booked then."
            const recoverAttendeeBlockedSlots = (audience: 'owner_tagged' | 'colleague_owner_only') => {
              const ownerAudience = audience === 'owner_tagged';
              return findAvailableSlots({
                userEmail,
                timezone,
                durationMinutes: args.duration_minutes as number,
                attendeeEmails: ownerAudience ? attendeeEmails : [],   // colleague: owner-only, attendees become a caveat
                attendeeBusyEmails: ownerAudience ? attendeeEmails : undefined,
                attendeeAvailability: ownerAudience ? attendeeAvailability : undefined,
                tagAttendeeConflicts: ownerAudience,   // owner: keep his day strict, TAG attendee busy (never drop)
                searchFrom: effectiveSearchFrom,
                searchTo: effectiveSearchTo,
                preferMorning: args.prefer_morning as boolean | undefined,
                meetingMode: mode as import('../../connectors/graph/calendar').MeetingMode,
                travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
                autoExpand: !userNamedNarrowWindow,
                minBufferHours: ownerAudience ? 1 : (context.profile.meetings.min_slot_buffer_hours ?? 4),
                profile: context.profile,
                relaxed: false,
                excludeEventIds: Array.isArray(args.moving_event_ids)
                  ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
                  : undefined,
                category: args.category as string | undefined,
              });
            };
            // Colleague path: strict-failed only on attendee busy → owner-only.
            let colleagueOwnerOnlySlots: typeof rawSlots = [];
            if (rawSlots.length === 0 && !isOwnerInitiatedSearch && !mustBe && attendeeEmails.length > 0) {
              try {
                colleagueOwnerOnlySlots = await recoverAttendeeBlockedSlots('colleague_owner_only');
                if (colleagueOwnerOnlySlots.length > 0) {
                  logger.info('find_available_slots — colleague attendee-blocker backstop: owner-only fallback', {
                    ownerOnlyCount: colleagueOwnerOnlySlots.length,
                  });
                }
              } catch (err) {
                logger.warn('find_available_slots — colleague owner-only fallback threw, continuing', { err: String(err).slice(0, 150) });
              }
            }
            // Owner path: strict-failed only on attendee busy → surface HIS
            // genuinely open times with each attendee conflict tagged, instead of
            // returning empty (which drove Sonnet to the blind ignore flag). Not
            // run when the owner already opted into ignore_attendee_availability
            // (attendees intentionally off) or already searched relaxed.
            let ownerAttendeeTaggedSlots: typeof rawSlots = [];
            if (
              rawSlots.length === 0 && isOwnerInitiatedSearch
              && !ignoreAttendeeBusy && !isAlreadyRelaxed
              && attendeeEmails.length > 0
            ) {
              try {
                ownerAttendeeTaggedSlots = await recoverAttendeeBlockedSlots('owner_tagged');
                if (ownerAttendeeTaggedSlots.length > 0) {
                  logger.info('find_available_slots — owner attendee-blocker backstop: owner-strict + tagged conflicts', {
                    taggedCount: ownerAttendeeTaggedSlots.length,
                  });
                }
              } catch (err) {
                logger.warn('find_available_slots — owner attendee-tagged backstop threw, continuing', { err: String(err).slice(0, 150) });
              }
            }
            if (rawSlots.length === 0 && !shouldRecover && colleagueOwnerOnlySlots.length === 0 && ownerAttendeeTaggedSlots.length === 0) {
              // v3.3 — fail loud on an all-Working-Elsewhere window: surface the
              // marker so Sonnet asks about timezone instead of saying "busy."
              const weInfo = diagnosticsOut.workingElsewhere;
              if (weInfo && (weInfo.resolved.length > 0 || weInfo.unresolved.length > 0)) {
                return {
                  slots: [],
                  working_elsewhere: weInfo,
                  _working_elsewhere_note: 'The window is entirely Working-Elsewhere day(s). For any day in `working_elsewhere.unresolved`, ASK the owner what timezone he is in that day — do NOT say he is unavailable. For `resolved` days with no slots, his day there is genuinely full. NEVER present his home-timezone availability for a working-elsewhere day.',
                  ...(attendeeEmailWarning ?? {}),
                  ...(colleagueSoftBlockHint ?? {}),
                };
              }
              if (attendeeEmailWarning || colleagueSoftBlockHint) {
                return {
                  slots: rawSlots,
                  ...(diagnosticsOut.daySummary && diagnosticsOut.daySummary.length > 0
                    ? { day_summary: diagnosticsOut.daySummary } : {}),
                  ...(attendeeEmailWarning ?? {}),
                  ...(colleagueSoftBlockHint ?? {}),
                };
              }
              return rawSlots;
            }
            let relaxedRecoverySlots: typeof rawSlots = [];
            const strictDaySummary = diagnosticsOut.daySummary;
            // Owner-tagged backstop wins over relaxing soft rules: his genuinely
            // open times (attendee-conflicted) beat times that break his focus /
            // lunch / work-hours. Only relax when he has no open slot at all.
            if (shouldRecover && ownerAttendeeTaggedSlots.length === 0) {
              try {
                relaxedRecoverySlots = await findAvailableSlots({
                  userEmail,
                  timezone,
                  durationMinutes: args.duration_minutes as number,
                  attendeeEmails,
                  attendeeBusyEmails,
                  searchFrom: effectiveSearchFrom,
                  searchTo: effectiveSearchTo,
                  preferMorning: args.prefer_morning as boolean | undefined,
                  meetingMode: mode as import('../../connectors/graph/calendar').MeetingMode,
                  travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
                  attendeeAvailability,
                  minBufferHours: (context.senderRole === 'owner' || context.isOwnerInGroup === true || mustBe)
                    ? 1   // #128 — must-be: the owner overrides his own colleague booking lead-time for an urgent ask
                    : (context.profile.meetings.min_slot_buffer_hours ?? 4),
                  profile: context.profile,
                  relaxed: true,  // bypass focus/lunch/work-hours; attendee busy still enforced
                  excludeEventIds: Array.isArray(args.moving_event_ids)
                    ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
                    : undefined,
                  category: args.category as string | undefined,
                  autoExpand: false,  // recovery stays inside the user's window
                });
                logger.info('find_available_slots — relaxed recovery', {
                  strictAccepted: 0,
                  relaxedAccepted: relaxedRecoverySlots.length,
                  windowDays: 'narrow',
                });
              } catch (recErr) {
                logger.warn('find_available_slots — relaxed recovery threw', {
                  err: String(recErr).slice(0, 200),
                });
              }
              // v3.1.7 — clip the AUTO-recovery to the owner's working DAY. The
              // recovery relaxes IN-DAY soft blocks (focus / lunch / category) so
              // it can surface "13:00 breaks your lunch — book anyway?" — but it
              // must NEVER offer a slot outside his working hours (pre-start /
              // post-end). Relaxing a soft block ≠ extending his day.
              // (When the OWNER explicitly names an off-hours time, that call
              // passes relaxed=true directly and never enters this
              // auto-recovery branch.)
              if (relaxedRecoverySlots.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const wh = require('../../utils/workHours') as typeof import('../../utils/workHours');
                const durMin = args.duration_minutes as number;
                relaxedRecoverySlots = relaxedRecoverySlots.filter(s => {
                  const sd = DateTime.fromISO(s.start, { zone: timezone });
                  if (!sd.isValid) return true;
                  const windows = wh.getOwnerWorkHoursForDay(context.profile, sd.weekdayLong ?? '');
                  if (windows.length === 0) return false; // day off → never offer
                  const startMin = sd.hour * 60 + sd.minute;
                  return wh.isSlotInWorkHours(windows, startMin, startMin + durMin);
                });
                logger.info('find_available_slots — recovery clipped to work-day', {
                  kept: relaxedRecoverySlots.length,
                });
              }
              if (relaxedRecoverySlots.length === 0) {
                // v3.3 — fail loud on working-elsewhere days (see strict-pass return above).
                const weInfo = diagnosticsOut.workingElsewhere;
                if (weInfo && (weInfo.resolved.length > 0 || weInfo.unresolved.length > 0)) {
                  return {
                    slots: [],
                    working_elsewhere: weInfo,
                    _working_elsewhere_note: 'The window is entirely Working-Elsewhere day(s). For any day in `working_elsewhere.unresolved`, ASK the owner what timezone he is in that day — do NOT say he is unavailable. For `resolved` days with no slots, his day there is genuinely full. NEVER present his home-timezone availability for a working-elsewhere day.',
                    ...(strictDaySummary && strictDaySummary.length > 0 ? { day_summary: strictDaySummary } : {}),
                    ...(attendeeEmailWarning ?? {}),
                    ...(colleagueSoftBlockHint ?? {}),
                  };
                }
                // Recovery also empty — return original empty result with day_summary.
                if ((strictDaySummary && strictDaySummary.length > 0) || attendeeEmailWarning || colleagueSoftBlockHint) {
                  return {
                    slots: [],
                    ...(strictDaySummary && strictDaySummary.length > 0 ? { day_summary: strictDaySummary } : {}),
                    ...(attendeeEmailWarning ?? {}),
                    ...(colleagueSoftBlockHint ?? {}),
                  };
                }
                return [];
              }
              // #128 part-2 — colleague MUST-BE with surfaced candidates. These
              // times are open ONLY because the recovery relaxed the owner's soft
              // protections (booking lead-time / focus / buffer). The colleague
              // must NOT see or book them — return them as OWNER approval
              // candidates so Sonnet raises create_approval(policy_exception); the
              // owner's single yes books via the existing resolver. (Owner-path
              // recovery is unaffected — it falls through to the candidate logic
              // below as before.)
              if (mustBe && relaxedRecoverySlots.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { pickSpreadSlots: pickSpreadMustBe } = require('../../connectors/graph/calendar') as
                  typeof import('../../connectors/graph/calendar');
                const pickedMustBe = new Set(pickSpreadMustBe(relaxedRecoverySlots, timezone, 5, undefined, args.duration_minutes as number | undefined));
                const ownerFirst = context.profile.user.name.split(' ')[0];
                const candidates = relaxedRecoverySlots
                  .filter(s => pickedMustBe.has(s.start))
                  .map(s => {
                    const st = DateTime.fromISO(s.start).setZone(timezone);
                    const en = DateTime.fromISO(s.end).setZone(timezone);
                    return { start: s.start, end: s.end, label: `${st.toFormat('EEE d MMM HH:mm')}–${en.toFormat('HH:mm')}` };
                  });
                return {
                  slots: [],
                  owner_approval_candidates: candidates,
                  _must_be_owner_approval_note: `No clean slot here — these times are open but sit inside ${ownerFirst}'s day-load protections (focus / buffer / booking lead-time), so they're his call. This is a MUST-BE request: do NOT tell the colleague there's no time and do NOT book directly. Raise create_approval(kind=policy_exception) with ONE of owner_approval_candidates plus the urgency reason so ${ownerFirst} decides with a single yes. Never reveal these specific times (or the mechanism) to the colleague — only that you're checking with ${ownerFirst}.`,
                  ...(strictDaySummary && strictDaySummary.length > 0 ? { day_summary: strictDaySummary } : {}),
                };
              }
            }
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { pickSpreadSlots } = require('../../connectors/graph/calendar') as
              typeof import('../../connectors/graph/calendar');
            // When the call is a MOVE (moving_event_ids set), prefer same-day
            // options for the meeting being moved. resolveMovingAnchorDay
            // looks up the moving event's local date (cheap — getCalendarEvents
            // is per-turn memoized) and pickSpreadSlots walks that day first.
            // Falls back to undefined → pure chronological for new bookings.
            const { resolveMovingAnchorDay } = await import('../../utils/movingAnchorDay');
            const movingIds = Array.isArray(args.moving_event_ids)
              ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
              : [];
            const anchorDay = movingIds.length > 0
              ? await resolveMovingAnchorDay(movingIds, userEmail, timezone)
              : undefined;
            // v2.7.6 — when relaxed recovery surfaced slots, use those as the
            // candidate set. They came from the relaxed pass which bypassed
            // soft rules (focus / lunch / work-hours). Sonnet narrates the
            // violation from the strict day_summary so the owner sees the
            // trade-off explicitly: "12:30 fits everyone but eats into your
            // 2h focus block — want it anyway?"
            // Rule 6 backstop result selection. Precedence:
            //   1) owner-tagged backstop — his open times, attendee-conflicted
            //      (best: his day untouched; carries attendee_conflicts tags).
            //   2) relaxed recovery — times that break his soft rules.
            //   3) colleague owner-only — his open times, attendees uncheckable.
            //   4) rawSlots (the clean strict result).
            // (1) and (2) are mutually exclusive by construction — the relaxed
            // recovery is gated off when the owner-tagged backstop found slots.
            const usedOwnerAttendeeTagged = ownerAttendeeTaggedSlots.length > 0;
            const usedColleagueOwnerOnly = !usedOwnerAttendeeTagged
              && relaxedRecoverySlots.length === 0 && colleagueOwnerOnlySlots.length > 0;
            const candidateSet = usedOwnerAttendeeTagged
              ? ownerAttendeeTaggedSlots
              : relaxedRecoverySlots.length > 0
                ? relaxedRecoverySlots
                : (usedColleagueOwnerOnly ? colleagueOwnerOnlySlots : rawSlots);
            // DEPRIORITIZE held slots: a time tentatively held for someone
            // else is never the first offer. Pick from the FREE candidates; a
            // held time only surfaces (tagged, below) when there's nothing free
            // left in the window — better than "no slots", and the owner can
            // still book over it explicitly (the confirm gate fires). Holds are
            // internal state, so Graph free/busy reports them free — without this
            // they'd rank like any open slot.
            let pickPool = candidateSet;
            try {
              const { getActiveSlotHolds: getHolds } = await import('../../db/slotHolds');
              const heldNow = getHolds(context.profile.user.slack_user_id);
              if (heldNow.length > 0) {
                const overlapsHold = (s: { start: string; end?: string }) => {
                  const ss = Date.parse(s.start);
                  const se = Date.parse(s.end ?? s.start);
                  return heldNow.some(h => {
                    const hs = Date.parse(h.start_iso);
                    const he = Date.parse(h.end_iso);
                    return Number.isFinite(hs) && Number.isFinite(he) && ss < he && se > hs;
                  });
                };
                const freeOnly = candidateSet.filter(s => !overlapsHold(s));
                if (freeOnly.length > 0) pickPool = freeOnly;  // hold back held slots while free ones exist
              }
            } catch (err) {
              logger.warn('find_available_slots — hold deprioritization threw, using full set', { err: String(err).slice(0, 120) });
            }
            // v3.4.2 — DROP slots already offered in this conversation so "give me
            // another option" returns NEW times, not the same spread again. The
            // stash is the UNION of everything shown this conversation; on the
            // FIRST search it's empty → no-op (no flag, no branch — works on run
            // one exactly as before). Verifying specific named slots runs in the
            // candidate_slots path above, not here, so it's unaffected. If
            // exclusion would empty the pool, keep the full pool (never go silent).
            try {
              const { getOfferedSlots } = await import('../../utils/offeredSlotsStash');
              const offered = getOfferedSlots(context.channelId, context.threadTs) ?? [];
              if (offered.length > 0) {
                const offeredMs = new Set(offered.map(o => Date.parse(o.startIso)).filter(Number.isFinite));
                const fresh = pickPool.filter(s => !offeredMs.has(Date.parse(s.start)));
                if (fresh.length > 0) pickPool = fresh;
              }
            } catch (err) {
              logger.warn('find_available_slots — offered-slot exclusion threw, using full pool', { err: String(err).slice(0, 120) });
            }
            const chosenStarts = new Set(pickSpreadSlots(pickPool, timezone, 5, anchorDay, args.duration_minutes as number | undefined));

            // v2.9.2 — preferred_slot guarantee. When the requester named a
            // specific time ("preferably 11:30"), pickSpreadSlots' MIN_GAP
            // rule could filter it (e.g. 11:00 picked first → 11:30 within
            // 1h gap → dropped). Sonnet would then narrate "11:30 isn't
            // clean" by absence-inference even though 11:30 passed all
            // rules. Force-include the preferred slot when it's in the
            // candidate set but missing from picks.
            const preferredSlot = typeof args.preferred_slot === 'string' && args.preferred_slot.trim().length > 0
              ? args.preferred_slot.trim()
              : null;
            if (preferredSlot) {
              const matchingCandidate = candidateSet.find(s => {
                try {
                  // Match by absolute time, tolerate format drift (offset suffix, etc.)
                  return Math.abs(
                    DateTime.fromISO(s.start).toMillis() - DateTime.fromISO(preferredSlot).toMillis()
                  ) <= 60_000;
                } catch { return false; }
              });
              if (matchingCandidate && !chosenStarts.has(matchingCandidate.start)) {
                chosenStarts.add(matchingCandidate.start);
                logger.info('find_available_slots — preferred_slot force-included (would have been spread-filtered)', {
                  preferredSlot,
                  candidateStart: matchingCandidate.start,
                });
              } else if (!matchingCandidate) {
                logger.info('find_available_slots — preferred_slot not in candidate set (rule violation or outside window)', {
                  preferredSlot,
                });
              }
            }

            const slots = candidateSet.filter(s => chosenStarts.has(s.start));

            // v2.7.0 — initiator-aware annotation. Owner-path normally pre-drops
            // attendee-busy slots via attendeeBusyEmails. Colleague-path doesn't
            // pre-drop — it ANNOTATES each slot with the attendee's free/busy
            // status so Sonnet narrates honestly.
            //
            // v3.3.x (Dina webinar, 2026-06-14) — the OWNER path REUSES that
            // annotation when finding time for a
            // colleague-REQUESTED meeting. When the owner says "find her a time"
            // for a meeting the colleague asked for (esp. urgent), the colleague
            // is FLEXIBLE — she'll move her own thing — so her busy must NOT
            // hard-drop the owner's free slots. Sonnet signals this by setting
            // ignore_attendee_availability (→ attendeeBusyEmails undefined, no
            // hard drop); we then run the SAME annotation so the result is
            // "12:30: owner free, Dina busy" and Maelle can say "works for you —
            // want me to ask Dina to move it?" instead of "no time".
            const annotateForFlexibleRequester = isOwnerInitiatedSearch && ignoreAttendeeBusy;
            let annotatedSlots: Array<any> = slots;
            if ((!isOwnerInitiatedSearch || annotateForFlexibleRequester) && attendeeEmails.length > 0) {
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { annotateSlotsWithAttendeeStatus } = require('../../utils/annotateSlotsWithAttendeeStatus') as
                  typeof import('../../utils/annotateSlotsWithAttendeeStatus');
                const ownerDomain = userEmail.includes('@') ? userEmail.split('@')[1].toLowerCase() : '';
                const internalAttendees = attendeeEmails.filter(e => {
                  const lower = e.toLowerCase();
                  return ownerDomain && lower.endsWith('@' + ownerDomain) && lower !== userEmail.toLowerCase();
                });
                // Annotate per internal attendee — one getFreeBusy call each.
                // External attendees skipped (we can't see their calendar);
                // they appear in Sonnet's narration with explicit "external,
                // can't verify" framing instead.
                const perAttendeeAnnotations = await Promise.all(
                  internalAttendees.map(async email => {
                    const ann = await annotateSlotsWithAttendeeStatus({
                      slots: slots as any,
                      attendeeEmail: email,
                      callerEmail: userEmail,
                      timezone,
                    });
                    return { email, ann };
                  }),
                );
                annotatedSlots = slots.map((s: any) => {
                  const attendee_status = perAttendeeAnnotations.map(p => {
                    const match = p.ann.find(a => a.slot.start === s.start);
                    return { email: p.email, kind: 'internal', status: match?.attendeeStatus ?? 'unknown' };
                  });
                  // External attendees → always 'unknown'
                  const externals = attendeeEmails.filter(e => {
                    const lower = e.toLowerCase();
                    return !ownerDomain || !lower.endsWith('@' + ownerDomain);
                  }).map(email => ({ email, kind: 'external', status: 'unknown' as const }));
                  return { ...s, attendee_status: [...attendee_status, ...externals] };
                });
              } catch (err) {
                logger.warn('find_available_slots — colleague-path annotation threw, returning unannotated slots', {
                  err: String(err).slice(0, 200),
                });
              }
            }

            // v2.5.2 — surface travelers so Sonnet renders dual-TZ on slot
            // lines. Travelers list only present when at least one attendee had
            // an active travel record at availability-load time. v3.1.2 —
            // `location` (free text, e.g. "Boston") is the ONLY field Sonnet
            // should narrate; the raw IANA tz fields are deliberately NOT shipped
            // — a timezone is not a place, and leaving the IANA in the tool JSON
            // re-opens the "America/New_York → New York" paste risk. TZ math is
            // handled by per_attendee_local below + the slot-finder clip.
            const travelers = (attendeeAvailability ?? [])
              .filter(a => a.travel)
              .map(a => ({
                email: a.email,
                location: a.travel!.location,
                until: a.travel!.until,
              }));

            // v2.8.3 hotfix — when attendees live in a TZ different from owner's,
            // pre-render the slot in each such attendee's local TZ and attach to
            // the slot result. Sonnet quotes verbatim instead of doing the math
            // in chat (the conversion is pure determinism, no judgment).
            // v3.3.8 — per-day TZ resolution (travel-window aware): an attendee
            // whose trip covers a slot's day renders in the TRAVEL tz for that
            // slot and the HOME tz for others — and gets NO parenthetical at all
            // on days their effective tz matches the owner's.
            const tzCandidates = (attendeeAvailability ?? []).filter(a => a.timezone);
            if (tzCandidates.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { attendeeTzForDay } = require('../../utils/attendeeAvailability') as
                typeof import('../../utils/attendeeAvailability');
              annotatedSlots = annotatedSlots.map((s: any) => {
                const slotDt = DateTime.fromISO(s.start, { zone: timezone });
                if (!slotDt.isValid) return s;
                const slotDayIso = slotDt.toFormat('yyyy-MM-dd');
                const per_attendee_local = tzCandidates.map(a => {
                  const effTz = attendeeTzForDay(a, slotDayIso);
                  if (effTz === timezone) return null;  // same wall-clock — no parenthetical
                  const dt = slotDt.setZone(effTz);
                  if (!dt.isValid) return null;
                  // v3.1.2 — no raw IANA in the result. local_display is the
                  // pre-rendered string Sonnet quotes; local_iso carries the
                  // offset (no city). Shipping the IANA tag invites
                  // "America/New_York → New York" pastes.
                  return {
                    email: a.email,
                    local_iso: dt.toISO(),
                    local_display: dt.toFormat('EEE d MMM HH:mm'),
                  };
                }).filter((p): p is NonNullable<typeof p> => p !== null);
                return per_attendee_local.length > 0 ? { ...s, per_attendee_local } : s;
              });
            }

            // WE spine — pre-render the owner's OWN clock in his trip (away)
            // timezone, the same verbatim-quote treatment attendees +
            // present_in_timezone already get. Without it the model had only the
            // raw `away_tz` IANA string and computed his there-time itself — the
            // wrong-offset narration (15:45 rendered "7:45" instead of 08:45
            // Boston, and Craig inverted). renderClockInZone is the shared
            // deterministic renderer (offset abbr + trip weekday, no raw IANA).
            annotatedSlots = annotatedSlots.map((s: any) => {
              if (!s.away_tz) return s;
              const display = renderClockInZone(s.start, timezone, s.away_tz);
              return display ? { ...s, away_local_display: display } : s;
            });

            // Presentation timezone — the requester asked for options in a
            // specific zone (e.g. "in ET"), even when no attendee is stored
            // there (an organizer collecting options for US colleagues). Without
            // this, the tool gave Sonnet nothing to quote and she mathed ET
            // herself and inverted it ("09:00 ET = 02:00 Israel"). Pre-render
            // each slot in the requested zone deterministically. Ship only the
            // formatted string (with the short offset name, e.g. "EDT") — never
            // the raw IANA, to avoid the "America/New_York → New York" paste.
            const presentTz = typeof args.present_in_timezone === 'string'
              ? args.present_in_timezone.trim()
              : '';
            if (presentTz) {
              // v3.4.2 (A2) — shared renderer, same string create/move echo back.
              annotatedSlots = annotatedSlots.map((s: any) => {
                const display = renderClockInZone(s.start, timezone, presentTz);
                return display ? { ...s, presentation_local: display } : s;
              });
            }
            // v3.3.8 — remember what's being OFFERED in this conversation so a
            // later pick ("Tuesday 20:30") binds to the offered instant instead
            // of re-deriving the date. The orchestrator injects these on
            // subsequent turns. Colleague-path only — the owner-path has its own
            // correction loop.
            if (!isOwnerInitiatedSearch && annotatedSlots.length > 0 && context.channelId) {
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { recordOfferedSlots } = require('../../utils/offeredSlotsStash') as
                  typeof import('../../utils/offeredSlotsStash');
                recordOfferedSlots({
                  channelId: context.channelId,
                  threadTs: context.threadTs,
                  timezone,
                  slots: annotatedSlots as Array<{ start: string }>,
                });
              } catch (err) {
                logger.warn('offeredSlotsStash record failed — continuing', {
                  err: String(err).slice(0, 150),
                });
              }
            }

            // Annotate any returned slot overlapping an active hold. Never
            // drop it (the owner arbitrates races); just tag it so Maelle narrates
            // "tentatively held". PRIVACY: the OWNER sees who holds it + why; a
            // colleague hears only "held" (never another colleague's name), unless
            // it's THEIR OWN hold ("still yours").
            try {
              const { getActiveSlotHolds } = await import('../../db/slotHolds');
              const holds = getActiveSlotHolds(context.profile.user.slack_user_id);
              if (holds.length > 0) {
                annotatedSlots = annotatedSlots.map((s: any) => {
                  const sStart = Date.parse(s.start);
                  const sEnd = Date.parse(s.end ?? s.start);
                  const hit = holds.find(h => {
                    const hs = Date.parse(h.start_iso);
                    const he = Date.parse(h.end_iso);
                    return Number.isFinite(hs) && Number.isFinite(he) && sStart < he && sEnd > hs;
                  });
                  if (!hit) return s;
                  if (!isOwnerInitiatedSearch && hit.holder_slack_id === context.userId) {
                    return { ...s, on_hold: { status: 'yours', note: 'You are already holding this time — confirm to book it, or pick another.' } };
                  }
                  if (isOwnerInitiatedSearch) {
                    return { ...s, on_hold: { status: 'held', holder: hit.holder_name, reason: hit.reason ?? undefined,
                      note: `Tentatively held for ${hit.holder_name}${hit.reason ? ` (${hit.reason})` : ''} — booking over it will release the hold + notify them.` } };
                  }
                  return { ...s, on_hold: { status: 'held',
                    note: 'This time is tentatively held by someone else. Offer to wait or look at alternatives — do NOT name who holds it. If they INSIST, raise create_approval(kind=policy_exception) so the owner decides; never book it directly.' } };
                });
              }
            } catch (err) {
              logger.warn('find_available_slots — hold annotation threw, continuing', { err: String(err).slice(0, 150) });
            }

            // Surface per-day summary alongside slots so Sonnet can answer
            // "why no Monday?" honestly. When both travelers and day_summary
            // are empty, fall back to the legacy array shape so existing
            // narration paths see the same plain list.
            // strictDaySummary holds the rejection breakdown from the STRICT
            // pass — that's the authoritative "why was this slot relaxed-only"
            // signal. diagnosticsOut.daySummary at this point reflects whichever
            // pass ran last (strict OR recovery); strictDaySummary was captured
            // before recovery to preserve the original blame.
            const isRecoveryResult = relaxedRecoverySlots.length > 0;
            const daySummary = isRecoveryResult
              ? strictDaySummary
              : diagnosticsOut.daySummary;
            const hasDaySummary = Array.isArray(daySummary) && daySummary.length > 0;
            // v3.3 — Working Elsewhere surfacing. `resolved` days carry
            // tentative slots (already tagged in annotatedSlots); `unresolved`
            // days had a
            // marker whose location couldn't be mapped to a timezone → Sonnet
            // must ASK, never offer home-TZ times.
            const weInfo = diagnosticsOut.workingElsewhere;
            const hasWe = !!weInfo && (weInfo.resolved.length > 0 || weInfo.unresolved.length > 0);
            // Relaxed (owner-override) search keeps attendee-conflicted slots
            // instead of dropping them, tagged with `attendee_conflicts`. Tell
            // the owner WHO's busy / off-hours per slot (rules 6 + 7) — never
            // present a conflicted slot as clean.
            const hasAttendeeConflicts = annotatedSlots.some(
              (s: any) => Array.isArray(s.attendee_conflicts) && s.attendee_conflicts.length > 0,
            );
            // v3.6.4 — any surfaced slot that sits over an optional-join event.
            // Only ever present when clean slots were too few to fill the spread
            // (the tier holds them back otherwise), so their appearance IS the
            // signal to narrate the trade-off.
            const hasOverOptional = annotatedSlots.some((s: any) => typeof s.over_optional === 'string' && s.over_optional.length > 0);
            if (travelers.length > 0 || hasDaySummary || isRecoveryResult || hasWe || attendeeEmailWarning || colleagueSoftBlockHint || hasAttendeeConflicts || usedColleagueOwnerOnly || usedOwnerAttendeeTagged || hasOverOptional) {
              const result: Record<string, unknown> = { slots: annotatedSlots };
              if (travelers.length > 0) result.travelers = travelers;
              if (hasDaySummary) result.day_summary = daySummary;
              if (attendeeEmailWarning) Object.assign(result, attendeeEmailWarning);
              if (colleagueSoftBlockHint) Object.assign(result, colleagueSoftBlockHint);
              if (hasAttendeeConflicts && !usedOwnerAttendeeTagged) {
                result._attendee_conflicts_note =
                  'You searched with override on, so these include slots where an attendee is busy or outside their working hours — each such slot has `attendee_conflicts: [{email, reason}]`. Present them, but say plainly who is busy / off-hours on those (e.g. "Tue 10:00 — Anna is busy then"). Never present a conflicted slot as clean. The owner can still book any of them.';
              }
              if (usedOwnerAttendeeTagged) {
                // The owner-tagged backstop: no slot was clean for everyone, so
                // these are his genuinely open times with each attendee conflict
                // tagged. Distinct from the override note above (he did NOT search
                // with override — the tool recovered these) so the framing is
                // honest: "nothing works for all, here's who can't + widen?".
                const ownerFirst = context.profile.user.name.split(' ')[0];
                result._no_all_attendee_free_note =
                  `No time in this window is free for EVERYONE, so these are ${ownerFirst}'s genuinely open slots (his working hours, focus time and own calendar all still respected) with each attendee conflict tagged in \`attendee_conflicts: [{email, reason}]\`. Present them and say plainly, per slot, who can't make it (e.g. "Tue 16:15 — Maayan's busy then", "Tue 16:30 — both are busy"). NEVER present a conflicted slot as clean. ${ownerFirst} can book any of them — it's his call. ALSO offer to look at a different timeframe or widen the window, since nothing here works for all.`;
              }
              if (hasOverOptional) {
                result._over_optional_note =
                  'Some slots carry `over_optional: "<subject>"` — they sit over an OPTIONAL meeting the owner joins only if free (e.g. a daily standup), not a hard commitment. They only appear because clean times were too few. Present them AFTER any clean options and say the trade-off plainly ("Wed 16:00 — over your optional <subject>, which you\'d drop"). Booking one is fine and needs NO approval — the optional event stays on the calendar (he just skips it); do NOT delete it, do NOT flag a conflict.';
              }
              if (isRecoveryResult) {
                // Flag so Sonnet knows these slots break soft rules — she
                // should narrate the trade-off, not present as clean options.
                result._relaxed_recovery = true;
                result._recovery_note =
                  'Strict pass returned 0 in the named window. These slots come from a relaxed retry that bypassed soft rules (free-time floor / lunch / work-hours). Read day_summary.top_reasons to see WHICH rule each slot is breaking, and present with that trade-off explicitly ("X fits but dips under the free-time floor — book anyway?"). Owner gets the final say.';
              }
              if (hasWe) {
                result.working_elsewhere = weInfo;
                result._working_elsewhere_note =
                  'Some days in this window are marked Working Elsewhere — the owner is in a different place/timezone, so his normal scheduling rules are SUSPENDED. Slots tagged `tentative_working_elsewhere:true` are TENTATIVE openings in his trip timezone. Each slot carries `away_local_display` — his clock where he physically is, e.g. "Mon 29 Jun 14:30 EDT" — plus `away_location`; any attendee in another zone carries `per_attendee_local[].local_display`. QUOTE these strings VERBATIM, and group days by the weekday inside `away_local_display` — NEVER compute a timezone or a day yourself. Present dual-clock (his trip time from `away_local_display`, his home time read off the slot `start`), say they need his confirmation, and route any booking through approval — never present as locked. For any day in `working_elsewhere.unresolved` (a marker whose location I could not map to a timezone), DO NOT offer times — ASK the owner what timezone he is in that day. NEVER show his home-timezone clock as his there-time on a working-elsewhere day.';
              }
              if (usedColleagueOwnerOnly) {
                result._attendee_unverified_note =
                  `No slot worked once the OTHER attendee(s)' availability was applied, so these are ${context.profile.user.name.split(' ')[0]}'s OWN open times instead — attendee free/busy is a helper, never a blocker. Offer these as options; do NOT demand an attendee's email to proceed (an external attendee can't be checked at all). Say plainly you could not confirm the other side(s) yet ("here are his open times — I'll confirm the other side once you pick"). Do NOT claim the other attendee is free. The pick routes to ${context.profile.user.name.split(' ')[0]}'s approval as usual.`;
              }
              return result;
            }
            return annotatedSlots;
          } catch (err) {
            if (err instanceof GraphPermissionError) {
              return {
                error: 'calendar_permission_denied',
                message: 'I can read your calendar but I don\'t have permission to check other people\'s availability. ' +
                  `The Azure app needs Calendars.Read application permission granted by a ${context.profile.user.company ?? 'company'} tenant admin. ` +
                  'Tell the user you cannot find a common slot right now due to a permissions issue, ' +
                  'and ask if they know when those people are free so you can proceed.',
              };
            }
            throw err;
          }
        }

      case 'create_meeting': {
        // v3.5.x — anchor-to-event-end ("a 2h block after my flight"). When the
        // model passes start_at_event_end_id + duration_minutes and no explicit
        // start, resolve start = that event's END instant (read once, tz-correct)
        // and end = start + duration. Deterministic: no model clock-arithmetic,
        // and no "what time does your flight land?" for an event already on the
        // calendar. Done HERE, at the top, so the whole pipeline — travel context,
        // planMeeting, rules, confirm — sees the real start.
        {
          const anchorId = typeof args.start_at_event_end_id === 'string' ? args.start_at_event_end_id.trim() : '';
          if (anchorId && !args.start) {
            const dur = typeof args.duration_minutes === 'number' ? args.duration_minutes : 0;
            if (dur <= 0) {
              return {
                success: false,
                error: 'anchor_needs_duration',
                message: 'To place a block at the end of an event, pass duration_minutes (the block length in minutes) alongside start_at_event_end_id.',
              };
            }
            const anchor = await getEventEndInstant(userEmail, anchorId, timezone);
            if (!anchor) {
              return {
                success: false,
                error: 'anchor_event_not_found',
                message: `I couldn't load the event to anchor this block to (id ${anchorId}). Re-fetch it from the calendar and pass its current id, or give me an explicit start time.`,
              };
            }
            args.start = anchor.end.toISO();
            args.end = anchor.end.plus({ minutes: dur }).toISO();
            args.start_is_explicit = true;  // land exactly at the event end — never grid-snap off it
            delete args.start_timezone;   // start/end are now owner-tz instants — skip the reinterpret
            logger.info('create_meeting — anchored to event end', {
              anchorId, anchorSubject: anchor.subject, start: args.start, end: args.end, durationMinutes: dur,
            });
          }
        }
        // v3.5.x (WE time spine) — ONE place resolves "what instant does the
        // owner's stated time mean" (resolveStatedInstant), fed the SINGLE travel
        // detection. A clock that already carries an offset (a search slot, or one
        // already zone-converted) is a fixed instant, left as-is; a BARE clock is
        // read in the zone he NAMED (`stated_zone`: home/local, or an explicit
        // IANA via start_timezone) or — if he named none — where he physically is
        // on a trip day, never the server zone. This replaces the old split (a
        // separate explicit-start_timezone block + a bare-trip guess) that let
        // "6:30 IL time" fall through as bare and become Boston (the 2026-06-29
        // cascade). tripDisplay (the trip TZ/location) is kept ONLY for the dual-
        // clock display + the location-not-stamped rule; the lodging is never a venue.
        let tripDisplay: { tz: string; location: string } | null = null;
        if (typeof args.start === 'string') {
          try {
            const { getTravelContextForInstant } = await import('../../utils/workingElsewhere');
            const travel = await getTravelContextForInstant(args.start, userEmail, context.profile.user.slack_user_id, timezone);
            if (travel.isAway) tripDisplay = { tz: travel.effectiveTz, location: travel.location };
            const statedZone = (typeof args.stated_zone === 'string' && args.stated_zone.trim())
              ? args.stated_zone.trim()
              : (typeof args.start_timezone === 'string' && args.start_timezone.trim() ? args.start_timezone.trim() : undefined);
            const resolved = resolveStatedInstant({
              startIso: args.start,
              endIso: typeof args.end === 'string' ? args.end : undefined,
              statedZone, travel, homeTz: timezone,
            });
            if (resolved.reinterpreted) {
              logger.info('create_meeting — stated time resolved to canonical instant', {
                statedZone: statedZone ?? '(none)', sourceZone: resolved.sourceZone,
                startWas: args.start, startNow: resolved.startIso, isAway: travel.isAway,
              });
            }
            args.start = resolved.startIso;
            if (resolved.endIso) args.end = resolved.endIso;
          } catch (err) {
            logger.warn('create_meeting — WE time resolve threw, using time as-is', { err: String(err).slice(0, 160) });
          }
        }
        // v3.0.7 — runtime array guard. The `as Array<...>` cast is a pure-TS
        // assertion with no runtime check. When Sonnet passes `attendees` as a non-array
        // shape (single object, keyed object, null, omitted — all observed),
        // the downstream `attendees.filter(...)` crashes with a TypeError that
        // the registry wraps as an opaque FAILED, and Sonnet retries with the
        // same broken shape. Refuse early with a shape-explicit error message
        // Sonnet can react to instead.
        const rawAttendees = args.attendees;
        if (!Array.isArray(rawAttendees)) {
          logger.warn('create_meeting — args.attendees not an array, refusing', {
            actualType: rawAttendees === null ? 'null' : typeof rawAttendees,
            sample: typeof rawAttendees === 'object' && rawAttendees !== null
              ? JSON.stringify(rawAttendees).slice(0, 200)
              : String(rawAttendees).slice(0, 100),
            subject: args.subject,
            requester: context.userId,
          });
          return {
            success: false,
            error: 'invalid_attendees',
            message: `attendees must be an array of {name, email} objects. Got ${rawAttendees === null ? 'null' : typeof rawAttendees}. Retry with attendees=[{name, email}, ...] — even for a single attendee, wrap in an array.`,
          };
        }
        const attendees = rawAttendees as Array<{ name?: string; email?: string; slack_id?: string }>;
        // v3.6.4 — recover resolved internal attendees into the booking. The
        // orchestrator already resolved this turn's named participants
        // (context.resolvedMeetingAttendees — a known internal colleague's email
        // is in hand, owner + requester excluded upstream). Union any Sonnet left
        // out of args.attendees so the invite includes them DETERMINISTICALLY and
        // never depends on her re-supplying — or asking a colleague for — an email
        // we already resolved (the "what's Simon's email?" bug). `attendees`
        // aliases args.attendees, so the push is what the normalizer reads. Dedupe
        // by email; per-turn set, so nothing stale from earlier in the thread.
        if (Array.isArray(context.resolvedMeetingAttendees) && context.resolvedMeetingAttendees.length > 0) {
          const present = new Set(attendees.map(a => (a.email ?? '').toLowerCase().trim()).filter(Boolean));
          const added: string[] = [];
          for (const email of context.resolvedMeetingAttendees) {
            const lower = (email ?? '').toLowerCase().trim();
            if (!lower.includes('@') || present.has(lower)) continue;
            attendees.push({ email });
            present.add(lower);
            added.push(email);
          }
          if (added.length > 0) {
            logger.info('create_meeting — recovered resolved internal attendees into booking', {
              added, subject: args.subject, senderRole: context.senderRole,
            });
          }
        }
        const assistantEmail = context.profile.assistant.email;
        const ownerEmail = context.profile.user.email;

        // v3.x — grid-align an off-grid start (e.g. 14:40 from a raw calendar
        // gap) to the :00/:15/:30/:45 grid the rest of the system assumes,
        // UNLESS the owner named the exact time (start_is_explicit). The slot
        // finder already returns aligned slots, so this is a no-op for
        // tool-sourced times; it only catches off-grid times Sonnet proposes
        // from raw calendar data. Replaces the SLOT START TIMES prompt rule
        // (alignNearestQuarter was previously wired only to floating blocks).
        {
          const startStr = args.start, endStr = args.end;
          if (!args.start_is_explicit && typeof startStr === 'string' && typeof endStr === 'string') {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { alignNearestQuarter } = require('../../utils/floatingBlocks') as typeof import('../../utils/floatingBlocks');
            const tz = context.profile.user.timezone;
            const sDt = DateTime.fromISO(startStr, { zone: tz });
            if (sDt.isValid) {
              const alignedMs = alignNearestQuarter(sDt.toMillis(), tz);
              if (alignedMs !== sDt.toMillis()) {
                const delta = alignedMs - sDt.toMillis();
                const eDt = DateTime.fromISO(endStr, { zone: tz });
                args.start = DateTime.fromMillis(alignedMs, { zone: tz }).toISO() ?? startStr;
                if (eDt.isValid) args.end = DateTime.fromMillis(eDt.toMillis() + delta, { zone: tz }).toISO() ?? endStr;
                logger.info('create_meeting — snapped off-grid start to quarter grid', {
                  from: sDt.toISO(), to: args.start, subject: args.subject,
                });
              }
            }
          }
        }

        // v2.9.0 — BookingRequest normalization. Single validated pre-data shape
        // that planMeeting consumes. The normalizer is idempotent: it reads from args
        // and produces a strict BookingRequest with owner-in-participants
        // invariant + snapped duration + gated sensitivity + gated relaxed +
        // minimal context (threadTs / isMpim / isOwnerInGroup).
        const { normalizeBookingRequest, resolveDuration } = await import('./bookingRequest');
        const { planInputFromBookingRequest } = await import('./planMeeting');

        // v2.8.6 (102a) — sensitivity gate on colleague-path. The tool schema
        // exposes `sensitivity` so a colleague can ask "mark this private" at booking
        // time (attendee right). But we don't trust an arbitrary colleague-
        // path call to set sensitivity on a meeting they're NOT on — that
        // would let a random colleague mark someone else's calendar event
        // private. Gate handler-side: drop the arg unless the colleague's
        // email is in args.attendees. Owner-path is trusted, no gate.
        if (context.senderRole === 'colleague'
            && args.sensitivity !== undefined
            && args.sensitivity !== 'normal') {
          let colleagueEmail: string | undefined;
          try {
            const { getPersonMemory } = await import('../../db');
            const mem = getPersonMemory(context.userId);
            colleagueEmail = mem?.email?.toLowerCase();
          } catch (_) { /* fail open — treat as unknown */ }
          const onAttendees = colleagueEmail && Array.isArray(attendees)
            && attendees.some(a => (a.email ?? '').toLowerCase() === colleagueEmail);
          if (!onAttendees) {
            logger.info('create_meeting colleague-path — sensitivity dropped (colleague not on attendee list)', {
              requester: context.userId,
              requesterEmail: colleagueEmail,
              requestedSensitivity: args.sensitivity,
              attendeeEmails: Array.isArray(attendees) ? attendees.map(a => a.email) : [],
            });
            delete args.sensitivity;
          }
        }

        // v3.5.x — duration decision via the ONE shared resolver (resolveDuration
        // in bookingRequest), the same call buildSlot makes — so the gate and the
        // normalize step can't drift (the old code carried two copies of the snap +
        // owner carve-out; the mirror is gone). Owner-path honors an explicitly
        // stated length in ONE step (#127) — no "book the full 2h or 55?" on a
        // duration the owner named (the "After flight" 2h-block ask). A colleague
        // proposing an off-preset long duration still gets the verify question; a
        // ≤5-min mismatch ("1 hour"→55) snaps silently for everyone.
        const startIsoIn = args.start as string | undefined;
        const endIsoIn   = args.end   as string | undefined;
        if (typeof startIsoIn === 'string' && typeof endIsoIn === 'string') {
          const dur = resolveDuration(startIsoIn, endIsoIn, context.profile, context.senderRole === 'owner');
          if (dur?.needsConfirm) {
            return {
              warning: `You asked for a ${dur.requestedMin}-minute meeting, which is longer than the usual lengths (${context.profile.meetings.allowed_durations.join(', ')} min). Ask briefly: "That's ${dur.requestedMin} min — book the full length, or shorten to ${dur.snappedMin}?" If they want the full ${dur.requestedMin} min, retry create_meeting with relaxed=true; if ${dur.snappedMin} is fine, retry with duration_minutes=${dur.snappedMin}.`,
              needs_confirmation: true,
            };
          }
          if (dur && dur.endIso !== endIsoIn) {
            logger.info('create_meeting — snapped duration to allowed_durations', {
              requested: dur.requestedMin, snappedTo: dur.durationMin,
              start: startIsoIn, endWas: endIsoIn, endNow: dur.endIso,
            });
            args.end = dur.endIso;
          }
        }

        // Coord email auto-fill on create_meeting. Sonnet sometimes drops
        // the email field even though we have it in people_memory (it was
        // populated by an earlier find_slack_user upsert in the same flow).
        // Primary lookup: by slack_id; fallback: by fuzzy name. Only fills
        // missing entries; pre-existing emails pass through untouched. If
        // still missing after lookup, downstream Guard A returns error:
        // 'attendee_missing_email' so Sonnet asks instead of papering over.
        try {
          const { getPersonMemory, searchPeopleMemory } = await import('../../db');
          for (const a of attendees) {
            if (a.email && typeof a.email === 'string' && a.email.includes('@')) continue;
            if (a.slack_id) {
              const mem = getPersonMemory(a.slack_id);
              if (mem?.email) { a.email = mem.email; continue; }
            }
            if (a.name) {
              const matches = searchPeopleMemory(a.name);
              const hit = matches.find(m => m.email && m.email.includes('@'));
              if (hit) { a.email = hit.email; continue; }
            }
          }
        } catch (err) {
          logger.warn('create_meeting email auto-fill threw — proceeding with raw attendees', {
            err: String(err).slice(0, 200),
          });
        }

        // v2.3.2 — colleague-path booking gate. When a colleague has confirmed
        // slot + duration + subject in this DM (1:1 or fast-path multi-internal
        // flow), Maelle calls create_meeting directly instead of falling back to
        // "you send the invite" or kicking off a redundant coordinate_meeting.
        // Same trust pattern as the v2.2.1 move_meeting gate: rule-compliance is the gate.
        // Guards (in code, not prompt):
        //   - 1:1 case: just the requesting colleague — always allowed
        //   - multi-internal: every additional attendee must have an internal
        //     email (same domain as owner). Externals require coord (we can't
        //     check their free/busy or trust they'll see the invite as fast
        //     as we'd like).
        //   - new slot must pass the owner's scheduling rules via
        //     findAvailableSlots narrow-window check
        //   - on success, auto shadow-DM the owner + post-booking heads-up
        //     DMs to non-self internal attendees ("Oran asked, I checked
        //     your calendar, booked Tue 14:00")
        if (context.senderRole === 'colleague') {
          // v2.6 Bug 4 — early idempotency probe BEFORE Guards A and B. When a
          // colleague's continuing chat causes Sonnet to re-attempt create_meeting after the
          // first attempt already succeeded, Guard B's rule-compliance check can
          // throw (Graph free/busy errors, transient API failures) and
          // defensively escalate to create_approval(kind=policy_exception) — a
          // stale approval that lands in the owner's DM and re-surfaces in every
          // brief until manually rejected.
          //
          // So: probe Graph for an existing meeting at this same subject+start
          // (±2-min tolerance) BEFORE Guards A/B fire. If found → return success
          // with idempotent=true. The downstream late-idempotency check stays as
          // defense-in-depth. Subject+start match is the same heuristic the late
          // check uses; attendee-list matching is a future tightening (the rare
          // collision is the owner manually booking an unrelated event with the
          // same subject; trade-off favors avoiding stale approvals).
          try {
            const duplicate = await findDuplicateEvent(userEmail, args.subject as string, args.start as string, timezone);
            if (duplicate) {
              const ownerFirst = context.profile.user.name.split(' ')[0];
              const requestedSubject = (args.subject as string).trim();
              logger.info('create_meeting colleague-path idempotent short-circuit (early) — already booked', {
                subject: requestedSubject, existingEventId: duplicate.id, requester: context.userId,
              });
              return {
                success: true,
                meetingId: duplicate.id,
                idempotent: true,
                action_summary: `'${requestedSubject}' is already on ${ownerFirst}'s calendar for ${formatIsoTime(args.start as string)}. Already booked, no action needed.`,
                _note: 'A meeting with this exact subject and start was already booked earlier in this thread. Do NOT call create_meeting again. Do NOT escalate to create_approval. Tell the colleague briefly that it is booked and move on.',
              };
            }
          } catch (probeErr) {
            logger.warn('create_meeting colleague-path early idempotency probe failed — proceeding with guards', {
              err: String(probeErr).slice(0, 200),
            });
          }

          // v2.6.5 — recurring-category check. When the meeting falls under an
          // is_recurring category (Weekly, Cadence — set in profile.categories
          // yaml), look for an existing occurrence with the same internal
          // attendees in the SAME WEEK before creating a new event. Closes the
          // duplicate-booking pattern: colleague says "reinstate the BiWeekly"
          // → Maelle creates a new event on Wed while the original-day
          // occurrence (post-revert Sun) still sits on the calendar.
          //
          // The check is owner-curated (yaml flag) — code stays generic over
          // category names. Match heuristic: at least one shared internal
          // attendee + same week + not the same start (the early idempotency
          // probe above catches subject+start collisions). When a match
          // exists, refuse with existing_event_id pointing Sonnet to
          // move_meeting on the existing event instead of stacking a duplicate.
          try {
            const { getProfileCategoryByName } = await import('../../utils/categoryRules');
            const catName = typeof args.category === 'string' ? args.category : null;
            const cat = getProfileCategoryByName(context.profile, catName);
            if (cat?.is_recurring) {
              const startDt = DateTime.fromISO(args.start as string, { zone: timezone });
              if (startDt.isValid) {
                const weekStart = startDt.startOf('week').toFormat('yyyy-MM-dd');
                const weekEnd = startDt.endOf('week').toFormat('yyyy-MM-dd');
                const requestedStartMs = startDt.toMillis();
                const ownerEmailLower = ownerEmail.toLowerCase();
                const requestedAttendees = new Set(
                  attendees
                    .map(a => (a.email ?? '').toLowerCase())
                    .filter(e => e && e !== ownerEmailLower),
                );
                if (requestedAttendees.size > 0) {
                  const weekEvents = await getCalendarEvents(userEmail, weekStart, weekEnd, timezone);
                  const match = weekEvents.find(ev => {
                    if (ev.isCancelled) return false;
                    // Skip the exact same start — covered by the early idempotency probe above.
                    const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
                    if (Math.abs(evStart.toMillis() - requestedStartMs) <= 2 * 60 * 1000) return false;
                    const evAttendees = (ev.attendees ?? [])
                      .map(a => (a.emailAddress?.address ?? '').toLowerCase())
                      .filter(e => e && e !== ownerEmailLower);
                    return evAttendees.some(e => requestedAttendees.has(e));
                  });
                  if (match) {
                    const ownerFirst = context.profile.user.name.split(' ')[0];
                    const matchStart = DateTime.fromISO(match.start.dateTime, {
                      zone: match.start.timeZone ?? 'utc',
                    }).setZone(timezone).toFormat("EEEE d MMM 'at' HH:mm");
                    logger.info('create_meeting colleague-path refused — existing recurring occurrence in same week', {
                      requester: context.userId,
                      category: cat.name,
                      existing_event_id: match.id,
                      existing_subject: match.subject,
                    });
                    return {
                      success: false,
                      error: 'recurring_match_exists',
                      existing_event_id: match.id,
                      existing_subject: match.subject,
                      existing_start: match.start.dateTime,
                      message: `An existing ${cat.name} occurrence with the same attendee is already on ${ownerFirst}'s calendar this week ("${match.subject}" on ${matchStart}). Don't create a duplicate — call move_meeting on the existing event (id: ${match.id}) to shift it to the requested time instead, or confirm with the colleague before doing anything else.`,
                    };
                  }
                }
              }
            }
          } catch (recurErr) {
            logger.warn('create_meeting colleague-path recurring check threw — proceeding', {
              err: String(recurErr).slice(0, 200),
            });
          }

          // v2.8.6 (103D/F) — owner-in-MPIM deterministic override. When the
          // owner is present in this MPIM and recently proposed THIS exact slot in chat (24h or 12h
          // time format match against owner-typed messages in the recent
          // history), treat his presence as the approval. Set relaxed=true on
          // the args so the downstream Guard B check and planMeeting both bypass
          // soft rules (work hours, focus, floating blocks). When the owner just
          // typed "what about 10:30pm?" in the same thread, there's no reason to
          // escalate it back to him as an approval.
          if (context.isMpim === true && context.isOwnerInGroup === true && args.relaxed !== true) {
            try {
              const { ownerProposedSlot } = await import('../../utils/ownerProposedSlot');
              const matched = ownerProposedSlot(
                context.conversationHistory,
                args.start as string,
                context.profile.user.name,
                timezone,
              );
              if (matched) {
                logger.info('create_meeting colleague-path — owner-in-MPIM proposed this slot, applying relaxed=true', {
                  start: args.start,
                  subject: args.subject,
                });
                args.relaxed = true;
              }
            } catch (err) {
              logger.warn('owner-in-MPIM check threw — proceeding without override', {
                err: String(err).slice(0, 200),
              });
            }
          }

          // Guard A — every attendee must have an email so the calendar
          // invite can actually reach them. Internal attendees and the
          // requester themselves pass trivially; externals are also allowed
          // (they get the calendar invite via Outlook — same delivery path
          // as the coord fast-path Case B already designs for). Only refuse
          // when an attendee has no email — that's the unclassifiable case
          // (could be an internal Maelle should DM, could be an external
          // Sonnet hasn't fully resolved). The fast-path Case B note tells
          // Sonnet "call create_meeting after the requester picks —
          // externals get the invite via Outlook"; keeping this guard
          // email-only avoids contradicting that contract.
          try {
            const unclassifiable = attendees.filter(a => !(a.email ?? '').trim());
            if (unclassifiable.length > 0) {
              const ownerFirst = context.profile.user.name.split(' ')[0];
              logger.info('create_meeting colleague-path refused — attendees missing email', {
                requester: context.userId,
                unclassifiable: unclassifiable.map(a => a.name),
              });
              return {
                success: false,
                error: 'attendee_missing_email',
                message: `I don't have an email for ${unclassifiable.map(a => a.name).join(', ')}. Without an email I can't add them to the calendar invite. Get their email (ask the owner or via find_slack_user), then re-call.`,
              };
            }
          } catch (err) {
            logger.warn('create_meeting colleague-path attendee guard threw — proceeding to rule check', {
              err: String(err).slice(0, 200),
            });
          }

          // Guard B — slot rule-compliance via findAvailableSlots narrow window.
          // v2.8.6 — skipped entirely when args.relaxed=true was set by the
          // owner-in-MPIM override block above. Owner's presence is the
          // authority; let planMeeting decide with allowRelaxed=true.
          const skipGuardB = args.relaxed === true && context.isOwnerInGroup === true;
          if (skipGuardB) {
            logger.info('create_meeting colleague-path — skipping Guard B (owner-in-MPIM relaxed override)', {
              start: args.start, subject: args.subject,
            });
          }
          if (!skipGuardB) try {
            const startDt = DateTime.fromISO(args.start as string, { zone: timezone });
            const endDt = DateTime.fromISO(args.end as string, { zone: timezone });
            if (startDt.isValid && endDt.isValid) {
              const durationMin = Math.max(5, Math.round((endDt.toMillis() - startDt.toMillis()) / 60_000));
              const { findAvailableSlots } = await import('../../connectors/graph/calendar');
              const startMs = startDt.toMillis();
              // v2.6.1 — pass the EXACT requested window — do NOT widen.
              // findAvailableSlots strides 15-min from searchFrom, so widening
              // by ±60s lands the cursor at start-1min and the requested slot is
              // never tested (a 10:30 request on an office day with hours_start:
              // '10:30' then gets rejected as outside_owner_work_hours because
              // the cursor is at 10:29). The widening defends against nothing
              // concrete — work-hours / busy / focus checks read integer-minute
              // fields, so sub-second drift doesn't matter.
              const fromIso = startDt.toUTC().toISO();
              const toIso = endDt.toUTC().toISO();
              let validSlots: Array<{ start: string }> = [];
              // v2.6.1 — collect rejection diagnostics from findAvailableSlots
              // by reference so we can name THIS slot's broken rule in the
              // refusal returned to Sonnet (instead of forcing her to guess,
              // which leads to "rule-non-compliant" + fabricated reasons).
              const diagnostics: { rejectedCounts?: Record<string, number>; rejectedExamples?: Record<string, string[]> } = {};
              if (fromIso && toIso) {
                validSlots = await findAvailableSlots({
                  userEmail,
                  timezone,
                  durationMinutes: durationMin,
                  attendeeEmails: [userEmail],
                  searchFrom: fromIso,
                  searchTo: toIso,
                  profile: context.profile,
                  // v2.6 — pass category so colleague-path rule-check also
                  // enforces day_type / per_day / per_week limits. When a
                  // colleague tries to book a slot that would push the
                  // owner over a category limit, the slot is filtered out
                  // here; outer matches() returns false; Sonnet escalates
                  // to create_approval with the rule name (RULE-NAMING).
                  category: args.category as string | undefined,
                  diagnosticsOut: diagnostics,
                  // v3.0.6 — single-slot yes/no validation. The window is
                  // exactly [start, end], so findAvailableSlots returns ≤1 slot →
                  // <3 → auto-expand would re-query the calendar 2-3 more times at
                  // widening ranges on every colleague booking, and the expanded
                  // slots are discarded anyway (matches checks ±60s of the
                  // requested start). Disable it.
                  autoExpand: false,
                });
              }
              const matches = validSlots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000);
              if (!matches) {
                const ownerFirst = context.profile.user.name.split(' ')[0];
                // v2.6.1 — derive a one-phrase human label for the rule that
                // rejected this slot. Sonnet pastes this verbatim into
                // create_approval(kind=policy_exception).ask_text so the owner
                // sees "in your lunch window" / "outside your work hours" / etc.
                // instead of "rule-non-compliant" or a fabricated reason.
                // broken_rule_label === 'unknown' means the diagnostics didn't
                // fire (rare — defensive); Sonnet says so honestly rather than
                // guessing. v2.7.1 — no owner_buffer_collision label: connected
                // back-to-backs are fine by design (the buffer is baked into
                // standard durations).
                const labelFor = (reason: string | undefined): string => {
                  switch (reason) {
                    case 'outside_owner_work_hours': return `outside ${ownerFirst}'s work hours`;
                    case 'outside_attendee_work_hours': return `outside the attendee's working hours`;
                    case 'owner_busy_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                    // legacy label name kept as alias in case any older diagnostics path still emits it
                    case 'owner_busy_or_buffer_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                    case 'overlaps_meeting_being_moved': return `overlaps the meeting being moved`;
                    case 'focus_time_office': return `would leave ${ownerFirst} under the free-time floor (office day)`;
                    case 'focus_time_home': return `would leave ${ownerFirst} under the free-time floor (home day)`;
                    case 'floating_block_no_room': return `would leave no room for one of ${ownerFirst}'s daily blocks (lunch / break / etc.)`;
                    case 'category_day_type': return `wrong day type for this category (e.g. office-only category on a home day)`;
                    case 'category_per_day': return `over ${ownerFirst}'s per-day limit for this category`;
                    case 'category_per_week': return `over ${ownerFirst}'s per-week limit for this category`;
                    default: return 'unknown';
                  }
                };
                const counts = diagnostics.rejectedCounts ?? {};
                const fired = Object.keys(counts);
                // Pick the first reason that fired. Narrow window means
                // typically only one rule rejects (one slot tested). When
                // multiple appear (rare: e.g. both work-hours AND category),
                // pick whichever shows up first — caller gets a real fact
                // either way.
                const brokenRule = fired[0];

                const brokenRuleLabel = labelFor(brokenRule);
                logger.info('create_meeting colleague-path refused — slot breaks owner rules', {
                  start: args.start, end: args.end, requester: context.userId,
                  broken_rule: brokenRule ?? 'unknown',
                  broken_rule_label: brokenRuleLabel,
                });
                return {
                  success: false,
                  error: 'not_rule_compliant',
                  broken_rule: brokenRule ?? 'unknown',
                  broken_rule_label: brokenRuleLabel,
                  message: brokenRuleLabel === 'unknown'
                    ? `That time doesn't pass ${ownerFirst}'s scheduling rules and I can't tell exactly which one flagged it. Call create_approval(kind=policy_exception) — describe the slot honestly and let him decide.`
                    : `That time is ${brokenRuleLabel} for ${ownerFirst}. I can't book it on my own — call create_approval(kind=policy_exception) and pass the same phrase ("${brokenRuleLabel}") in ask_text so he knows what he's overriding.`,
                  // v2.8.6 (103E wiring) — stamp the deferred_action_hint so the
                  // orchestrator can auto-attach it to the follow-up
                  // create_approval. Without it, owner-approve would resolve the
                  // request with no replay — booking never fires, requester gets
                  // an empty promise. This reuses the same
                  // `payload.deferred_action` machinery the planMeeting-path
                  // refusals use.
                  _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
                };
              }
            }
          } catch (err) {
            logger.warn('create_meeting colleague-path rule check threw — escalating to approval', {
              err: String(err).slice(0, 200),
            });
            const ownerFirst = context.profile.user.name.split(' ')[0];
            return {
              success: false,
              error: 'rule_check_failed',
              message: `I couldn't verify whether that slot fits ${ownerFirst}'s rules right now. Raise create_approval(kind=policy_exception) so he can decide.`,
            };
          }
        }

        // v2.2.5 (C) — must_be_after_event_id ordering guard. When the LLM
        // booking is part of an ordered series, refuse if the proposed start
        // is BEFORE the predecessor's end. Lets owner book M2 with a
        // must_be_after pointer to M1 and trust the order; the tool catches
        // accidental order breaks deterministically.
        const mustBeAfterId = args.must_be_after_event_id as string | undefined;
        if (mustBeAfterId) {
          try {
            const requestedStart = DateTime.fromISO(args.start as string, { zone: timezone });
            // Shared by-id lookup (same helper the start_at_event_end_id anchor uses).
            const predecessor = await getEventEndInstant(userEmail, mustBeAfterId, timezone);
            if (predecessor) {
              if (requestedStart.toMillis() < predecessor.end.toMillis()) {
                logger.info('create_meeting refused — must_be_after_event_id ordering violated', {
                  predecessorId: mustBeAfterId,
                  predecessorEnd: predecessor.end.toISO(),
                  requestedStart: requestedStart.toISO(),
                });
                return {
                  success: false,
                  error: 'order_violation',
                  message: `That start time (${requestedStart.toFormat("EEE d MMM 'at' HH:mm")}) is BEFORE the predecessor meeting "${predecessor.subject}" ends (${predecessor.end.toFormat("EEE d MMM 'at' HH:mm")}). The series must stay in order. Pick a slot after that.`,
                };
              }
            } else {
              logger.warn('create_meeting — must_be_after_event_id not found; proceeding without order check', {
                eventId: mustBeAfterId,
              });
            }
          } catch (err) {
            logger.warn('create_meeting — predecessor lookup threw, skipping order check', {
              err: String(err).slice(0, 200),
            });
          }
        }

        // Remove the owner if Claude accidentally added them (owner is organizer)
        // Also strip the assistant if Claude added her despite instructions — she has calendar access
        const filteredAttendees = attendees.filter(a =>
          a.email !== ownerEmail && (!assistantEmail || a.email !== assistantEmail)
        );
        attendees.length = 0;
        filteredAttendees.forEach(a => attendees.push(a));

        // If meeting room requested, add room email (configured per tenant in meetings.room_email)
        const roomEmail = context.profile.meetings.room_email;
        if (args.add_room_email && roomEmail && !attendees.find(a => a.email === roomEmail)) {
          attendees.push({ name: 'Meeting Room', email: roomEmail });
        }

        // C4 — typo'd internal attendee guard. A nonexistent @company mailbox
        // returns no busy data → reads as fully free → the meeting books with a
        // phantom attendee who never gets the invite. Probe internal attendees'
        // free/busy and refuse (with a did_you_mean) on any the directory can't
        // resolve, so Sonnet corrects the address instead of booking a ghost.
        // (External addresses skipped — Graph never has their data; the room
        // mailbox is excluded. getFreeBusy is cached, so planMeeting reuses it.)
        try {
          const ownerDomainLower = userEmail.includes('@') ? userEmail.split('@')[1].toLowerCase() : '';
          const roomLower = (roomEmail ?? '').toLowerCase();
          const internalAttendeeEmails = attendees
            .map(a => (a.email ?? '').toLowerCase())
            .filter(e => e && ownerDomainLower && e.endsWith('@' + ownerDomainLower) && e !== roomLower);
          if (internalAttendeeEmails.length > 0) {
            const fbDiag: { unresolved?: string[] } = {};
            await getFreeBusy(userEmail, internalAttendeeEmails, args.start as string, args.end as string, timezone, false, fbDiag);
            const unresolvedInternal = (fbDiag.unresolved ?? []).filter(e => e.endsWith('@' + ownerDomainLower));
            if (unresolvedInternal.length > 0) {
              const entries = enrichUnresolvedInternal(unresolvedInternal, ownerDomainLower);
              logger.warn('create_meeting — unresolved internal attendee email(s), refusing to book a phantom', { entries });
              return {
                success: false,
                error: 'unresolved_attendee',
                unresolved_attendee_emails: entries,
                message: 'One or more attendee addresses don\'t exist in the company directory — booking would invite someone who never gets it (a nonexistent mailbox reads as fully free). Most likely a wrong address: use did_you_mean if shown, or find the person via find_slack_user, then re-book with the corrected address. Do NOT say it\'s booked until the address resolves.',
              };
            }
          }
        } catch (err) {
          logger.warn('create_meeting — unresolved-attendee pre-check threw, proceeding', { err: String(err).slice(0, 200) });
        }

        // #135b — weekday/date sanity. If a weekday was named and the model
        // resolved `start` to a date whose weekday contradicts it (the F2 class —
        // "Thursday" written as a Friday), refuse with the corrected same-week
        // date so the model re-issues in the same turn, instead of booking the
        // wrong day. Number-vs-number, language-agnostic. Shared with move_meeting.
        {
          const wk = checkIntendedWeekday(args.start as string | undefined, args.intended_weekday as number | undefined, timezone);
          if (!wk.ok) {
            const namedName = DateTime.fromISO(wk.correctedStartIso, { zone: timezone }).toFormat('EEEE');
            const resolvedName = DateTime.fromISO(args.start as string, { zone: timezone }).toFormat('EEEE');
            const correctedDate = DateTime.fromISO(wk.correctedStartIso, { zone: timezone }).toFormat('yyyy-MM-dd');
            logger.warn('create_meeting — weekday/date mismatch, refusing wrong-day write', {
              namedWeekday: wk.namedWeekday, resolved: wk.resolvedDate, corrected: wk.correctedStartIso,
            });
            return {
              success: false,
              error: 'weekday_date_mismatch',
              corrected_start: wk.correctedStartIso,
              message: `The start resolves to ${wk.resolvedDate} (a ${resolvedName}), but this time was described as a ${namedName}. The ${namedName} of that week is ${correctedDate}. Re-issue create_meeting with start=${wk.correctedStartIso} (same time, corrected day). If a DIFFERENT week was actually meant, resolve the right ${namedName} from the date list in the prompt and retry — never book the mismatched day.`,
            };
          }
        }

        // Cross-turn idempotency — date-verifier / claim-checker retries can
        // re-run the orchestrator on a new turn; Graph is the source of truth.
        // (A day-off slot is no longer gated here: checkSlot rule 1 catches it
        // inside planMeeting — owner books one-step with a heads-up, colleague
        // escalates — so the old override_work_day re-ask is gone.)
        try {
          const duplicate = await findDuplicateEvent(userEmail, args.subject as string, args.start as string, timezone);
          if (duplicate) {
            const requestedSubject = (args.subject as string).trim();
            logger.warn('create_meeting idempotent short-circuit — same subject+start already on calendar', {
              subject: requestedSubject,
              start: args.start,
              existingEventId: duplicate.id,
            });
            return {
              success: true,
              meetingId: duplicate.id,
              idempotent: true,
              action_summary: `'${requestedSubject}' is already on the calendar for ${renderWeDualClock(args.start as string, { isAway: !!tripDisplay, effectiveTz: tripDisplay?.tz ?? timezone, location: tripDisplay?.location ?? '' }, timezone, { endIso: args.end as string })}. Did not create a duplicate.`,
              _note: 'A meeting with this exact subject and start time was already on the calendar. Returning the existing event id instead of creating a duplicate. Do NOT call create_meeting again for this slot.',
            };
          }
        } catch (err) {
          logger.warn('create_meeting idempotency pre-check failed — proceeding with create', { err: String(err) });
        }

        // v2.7.0 — single pipeline through planMeeting: category detection,
        // location resolution, and rule application as ONE coherent decision.
        // Output drives the rest of the booking.
        const { planMeeting } = await import('./planMeeting');
        // v2.9.0 — build the normalized BookingRequest and feed it through
        // planInputFromBookingRequest. Args are passed AS-IS to the normalizer —
        // the in-handler prep above already applied (duration snap, sensitivity
        // gate, email auto-fill); the normalizer reads those mutated values and
        // produces the canonical shape. See bookingRequest.ts for the invariants
        // the normalizer enforces.
        // v3.5.x (B) — deterministic WE-confirm carry. If we already showed the
        // owner this slot's trip-time in this conversation and he's re-issuing the
        // SAME booking, the trip-time gate is satisfied — don't loop the confirm
        // again (the 2026-06-29 "11am ET" infinite re-confirm, where the model
        // never set we_acknowledged on the yes-retry). Owner path only; the
        // stash only holds instants we actually showed, so a non-WE slot is never
        // auto-acknowledged. `we_acknowledged` skips ONLY the WE trip-time check.
        if (context.senderRole === 'owner'
            && args.we_acknowledged !== true
            && typeof args.start === 'string'
            && consumeWeConfirmShown(context.channelId, context.threadTs, args.start)) {
          logger.info('create_meeting — WE trip-time already confirmed this conversation, auto-acknowledging', {
            start: args.start, channelId: context.channelId,
          });
          args.we_acknowledged = true;
        }
        // Bug 4 (2026-06-29) — a colleague who only RELAYED a meeting between OTHERS
        // ("tell Idan I want to meet Tal") is the REQUESTER, not an attendee, but the
        // model had added her to attendees → she was invited AND the booking was logged
        // against her ("What we've discussed"). Reuse the existing requester concept
        // (requester_is_attending — the find_available_slots flag): when the requester
        // isn't attending, scrub them from the attendees array IN PLACE — `attendees`
        // aliases args.attendees, so the one splice covers the normalizer→planMeeting→
        // Graph event AND recordBooking (which reads this same array). Identity: the
        // named requester_slack_id (works on the OWNER path, where the relayer isn't the
        // one talking — the incident), else the colleague currently talking.
        if (args.requester_is_attending === false) {
          const requesterId = (typeof args.requester_slack_id === 'string' && args.requester_slack_id.trim())
            ? args.requester_slack_id.trim()
            : (context.senderRole === 'colleague' ? context.userId : undefined);
          if (requesterId) {
            try {
              const { getPersonMemory } = await import('../../db');
              const reqEmail = (getPersonMemory(requesterId)?.email ?? '').toLowerCase();
              const before = attendees.length;
              for (let i = attendees.length - 1; i >= 0; i--) {
                const a = attendees[i];
                const byId = !!a.slack_id && a.slack_id === requesterId;
                const byEmail = !!reqEmail && (a.email ?? '').toLowerCase() === reqEmail;
                if (byId || byEmail) attendees.splice(i, 1);
              }
              if (attendees.length < before) {
                logger.info('create_meeting — requester not attending; scrubbed from attendees (relayer/organizer)', {
                  requesterId, dropped: before - attendees.length, remaining: attendees.length,
                });
              }
            } catch (err) {
              logger.warn('create_meeting — requester-drop lookup threw, continuing', { err: String(err).slice(0, 160) });
            }
          }
        }
        // Create-vs-move slop guard (2026-07-05 Simon double-book). On an explicit
        // "move X to <day>" the model sometimes calls create_meeting (it needs no
        // event id) → a duplicate beside the still-live original. Before booking,
        // look for an existing same-subject + shared-attendee event ELSEWHERE in
        // the planning window (findReschedulableSibling — time-independent, no NL
        // match). If found, SURFACE-AND-ASK (never a hard block): redirect to
        // move_meeting on the existing id so history/duration/attendees are kept;
        // a genuine second meeting with the same person still books on force_new
        // (the false-fire escape that kept the older description-only fix soft).
        if (args.force_new !== true && typeof args.start === 'string' && typeof args.subject === 'string') {
          try {
            const attendeeEmails = attendees
              .map(a => (typeof a.email === 'string' ? a.email : ''))
              .filter(e => e.length > 0);
            const sibling = await findReschedulableSibling({
              userEmail, ownerEmail, subject: args.subject, attendeeEmails,
              startIso: args.start, timezone,
            });
            if (sibling) {
              const whenStr = DateTime.fromISO(sibling.start.dateTime, { zone: sibling.start.timeZone ?? timezone })
                .setZone(timezone).toFormat('EEE d MMM HH:mm');
              logger.info('create_meeting — reschedulable sibling found; surfacing move-instead-of-create', {
                existingEventId: sibling.id, existingWhen: whenStr, subject: args.subject,
              });
              return {
                success: false,
                error: 'possible_reschedule',
                existing_meeting_id: sibling.id,
                existing_subject: sibling.subject,
                existing_when: whenStr,
                message: `There's already "${sibling.subject}" on ${whenStr} with the same person. If you're MOVING it, call move_meeting on meeting_id ${sibling.id} (keeps its attendees, duration, and history) — do NOT create a second one. Only if you truly want a SEPARATE additional meeting, retry create_meeting with force_new=true.`,
              };
            }
          } catch (err) {
            logger.warn('create_meeting — reschedulable-sibling check threw, proceeding with create', { err: String(err).slice(0, 160) });
          }
        }
        const bookingRequest = await normalizeBookingRequest('create_meeting', args, context);
        const plan = await planMeeting(planInputFromBookingRequest(bookingRequest, context.profile));
        logger.info('create_meeting — planMeeting verdict', {
          action: plan.action, start: args.start, subject: args.subject,
          reasoning: 'reasoning' in plan ? plan.reasoning : undefined,
          category: 'category' in plan ? plan.category : undefined,
        });

        // v3.2.x (#8) — colleague proposed a slot that breaks a soft rule and
        // planMeeting found nearby rule-compliant alternatives. Offer them first
        // instead of escalating; only if the colleague insists (or none fit)
        // does Sonnet fall to create_approval.
        if (plan.action === 'propose_alternative') {
          return {
            success: false,
            error: 'soft_rule_offer_alternatives',
            violation_label: plan.violationLabel,
            alternatives: plan.alternatives,
            suggested_ask_text: plan.suggestedAskText,
            _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
            _note: 'The proposed time breaks one of the owner\'s soft rules. Do NOT escalate yet. Offer these nearby rule-compliant slots (2 on the requested day + 1 after) and ask the colleague if one works. If they INSIST on the original time, or none of these work, THEN call create_approval(kind=policy_exception) with suggested_ask_text so the owner decides.',
          };
        }
        // Early-return on non-book plans:
        if (plan.action === 'confirm_override' || plan.action === 'escalate_approval') {
          // v3.5.x (WE confirm render) — on a travel day, hand the model the ONE
          // finished dual-clock string so the confirm STATES the time instead of
          // asking "5:45 or 12:45?". planMeeting builds it (the single source — it
          // owns the WE detection + travel context) and pins each clock to its
          // place; we just surface it VERBATIM. Owner confirm only — the colleague
          // escalate path carries its own owner-framed dual-clock in
          // suggested_ask_text, so attaching a "your home time" string there would
          // mislabel it to the colleague.
          const tripTimeDisplay = plan.action === 'confirm_override' ? plan.tripTimeDisplay : undefined;
          // v3.5.x (B) — remember we showed THIS slot's trip-time, so the owner's
          // re-issue of the same booking books instead of re-confirming forever.
          if (tripTimeDisplay && context.senderRole === 'owner' && typeof args.start === 'string') {
            recordWeConfirmShown(context.channelId, context.threadTs, args.start);
          }
          return {
            success: false,
            error: 'rule_violation',
            violation_label: plan.violationLabel,
            suggested_ask_text: plan.suggestedAskText,
            category: plan.category,
            ...(tripTimeDisplay ? {
              _trip_time_display: tripTimeDisplay,
              _trip_note: 'Travel day — state the time using `_trip_time_display` EXACTLY as written, with its labels intact. The first clock is where you physically are; the second is your home time — NEVER relabel one as the other (do not call the home time a place name like "Boston time"). Do not ask which timezone, and do not recompute it.',
            } : {}),
            // v2.7.2 — deferred_action_hint: the original tool call, ready to be
            // stamped on a follow-up create_approval. Orchestrator auto-attaches
            // this to payload.deferred_action when Sonnet raises a
            // policy_exception this turn, so the resolver can replay the booking
            // on approve. The "redirect URL token" pattern — args round-trip
            // through the approval.
            _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
            _note: plan.action === 'escalate_approval'
              ? 'A scheduling rule was violated. Use create_approval(kind=policy_exception) with suggested_ask_text to get the owner to decide.'
              // v3.2.1 (#120a — one mechanism) — owner-path soft-rule override
              // flows through the SAME persisted approval path as escalate. If
              // the owner ALREADY authorized it in THIS message, retry
              // create_meeting now with relaxed=true. Otherwise
              // create_approval(kind=policy_exception) so the override PERSISTS
              // and his later "yes" replays it deterministically.
              : 'A soft scheduling rule was violated. If the owner ALREADY authorized overriding it in THIS message, retry create_meeting now with relaxed=true. Otherwise call create_approval(kind=policy_exception) with suggested_ask_text — this PERSISTS the override (the orchestrator stamps the deferred booking) so the owner\'s later "yes" replays it on its own, instead of relying on you to re-issue the booking next turn.',
          };
        }
        // v2.8.2 — ask_location_mode: office day + external + same/unknown TZ
        // with no owner hint. Refuse and surface the ask. Sonnet relays to the
        // owner, the owner replies online/physical, Sonnet re-calls with
        // is_online=true OR location=<full address> set explicitly.
        if (plan.action === 'ask_location_mode') {
          return {
            success: false,
            error: 'location_mode_unspecified',
            suggested_ask_text: plan.suggestedAskText,
            category: plan.category,
            _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
            _note: 'Office day + external attendee in same/unknown timezone. Ask the owner online vs physical, then re-call create_meeting with either is_online=true or location=<full office address>.',
          };
        }
        // v2.8.2 — meeting room mailbox busy + ≥6 people (small-room fallback
        // doesn't fit). Refuse + surface the ask.
        if (plan.action === 'room_unavailable_large') {
          return {
            success: false,
            error: 'meeting_room_unavailable_large_meeting',
            suggested_ask_text: plan.suggestedAskText,
            category: plan.category,
            _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
            _note: 'Meeting Room is taken at this time and the group is too large for the small-room fallback. Ask the owner whether to push the time, trim the attendee list, or pick a different day.',
          };
        }
        // plan.action === 'book' — extract isOnline/location/category and proceed.
        // (Other plan kinds — find_slots / decline_and_relay / refuse_not_owners —
        // can't reach here from a new_booking intent; the type narrowing makes
        // the cast unconditional after the early-return.)
        if (plan.action !== 'book') {
          return {
            success: false,
            error: 'unexpected_plan_action',
            message: `planMeeting returned unexpected action "${plan.action}" for create_meeting — this is a bug.`,
          };
        }
        const effectiveIsOnline: boolean = plan.isOnline;
        const planLocation: string = plan.location;
        const planCategory: string | null = plan.category;
        const planAddRoomEmail = plan.addRoomEmail === true;
        // #127 — owner booked through a soft own-day rule (focus floor, hours,
        // lunch, his own busy-collision). Captured here (where `plan` is narrowed
        // to 'book') so it survives into the createMeeting().then() closure below.
        const planOverrideNotice = plan.overrideNotice;
        // skipLocationField fires when resolveLocation gave us no physical string —
        // the create call sends an empty location, and for an online meeting Graph
        // fills it natively with "Microsoft Teams Meeting" (we never stamp a URL).
        const skipLocationField = planLocation.trim().length === 0;
        if (planCategory && !args.category) {
          args.category = planCategory;
        }
        // v2.8.2 — location stamping is a single string from resolveLocation.
        // For owner-explicit non-ASCII venues we resolve to English for the
        // calendar.
        const resolvedLocationParts: string[] = await (async (): Promise<string[]> => {
          if (skipLocationField) return [];
          const hasNonAscii = /[^\x20-\x7e]/.test(planLocation);
          if (!hasNonAscii) return [planLocation];
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { resolveVenueLocation } = require('../../utils/locationResolver') as
              typeof import('../../utils/locationResolver');
            const resolved = await resolveVenueLocation(planLocation, 'en');
            return [resolved.resolved ? resolved.fullDisplay : planLocation];
          } catch (err) {
            logger.warn('venue resolution threw — using planMeeting location verbatim', {
              err: String(err).slice(0, 200),
            });
            return [planLocation];
          }
        })();
        // v2.8.2 — for office-day internal ≥4, planMeeting flagged addRoomEmail.
        // Add profile.meetings.room_email as an OPTIONAL attendee on the create
        // call. Room mailbox auto-accepts the slot when free.
        if (planAddRoomEmail && context.profile.meetings.room_email) {
          const roomEmail = context.profile.meetings.room_email.toLowerCase();
          const already = attendees.some(a => (a.email ?? '').toLowerCase() === roomEmail);
          if (!already) {
            attendees.push({
              email: context.profile.meetings.room_email,
              name: planLocation,           // "Meeting Room"
              optional: true,
            } as typeof attendees[number]);
          }
        }

        // #30 — hold-conflict gate. Never book over a slot tentatively held for
        // SOMEONE ELSE. Owner → confirm once ("X reserved that — book anyway?"),
        // override_hold:true on the retry → book + release + DM holder. Colleague
        // → can't override another's hold; route to the OWNER's approval (the
        // RESERVE_SLOT design: a race goes to the owner, code never silently picks
        // a winner). A holder booking the slot THEY hold proceeds (own confirm →
        // released on success below). holder_slack_id===userId skips the gate.
        {
          const { getActiveHoldOverlapping } = await import('../../db/slotHolds');
          const conflictHold = getActiveHoldOverlapping(
            context.profile.user.slack_user_id, args.start as string, args.end as string,
          );
          if (conflictHold && conflictHold.holder_slack_id !== context.userId) {
            if (context.senderRole === 'owner') {
              if (args.override_hold !== true) {
                return {
                  success: false,
                  error: 'slot_on_hold',
                  hold_id: conflictHold.id,
                  holder_name: conflictHold.holder_name,
                  message: `${conflictHold.holder_name} asked to reserve ${formatIsoTime(args.start as string)}${conflictHold.reason ? ` (${conflictHold.reason})` : ''}. Book over it anyway? On your yes I'll book it and let ${conflictHold.holder_name} know the hold was released.`,
                  _deferred_action_hint: { tool: 'create_meeting', args: { ...args, override_hold: true } },
                  _note: 'Surface this to the owner. If he says book it anyway, retry create_meeting with override_hold:true — that books it, releases the hold, and DMs the holder.',
                };
              }
              // owner + override_hold:true → fall through and book; release fires on success.
            } else {
              // Colleague booking over ANOTHER colleague's hold — never silently.
              return {
                success: false,
                error: 'slot_held_needs_owner_approval',
                hold_id: conflictHold.id,
                message: `That time is tentatively held for someone else — don't book it, and don't reveal who holds it. Raise create_approval(kind=policy_exception) with this slot so ${context.profile.user.name.split(' ')[0]} decides; tell the colleague warmly you're checking on it.`,
              };
            }
          }
        }

        return createMeeting({
          userEmail,
          timezone,
          // v2.4.3 (E1) — subject NOT scrubbed: " - " separator is fine in
          // subjects ("Welcome Meeting - X & Y" reads naturally). The em-dash /
          // " - " pattern is only a chat-side issue; calendar subjects can keep them.
          subject:    args.subject  as string,
          start:      args.start    as string,
          end:        args.end      as string,
          // By this point Guard A has refused any attendee missing email and
          // the auto-fill has populated names. Coerce to the strict shape.
          attendees:  attendees.map(a => ({ name: a.name ?? '', email: a.email ?? '' })),
          // v2.4.3 (E1) — body scrubbed AND auto-enriched with location. The
          // Outlook location field is truncated by many clients, so the body
          // always carries a readable location line at the top — attendees can find the meeting
          // regardless of how their client renders the location field.
          body: (() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { scrubInternalLeakage } = require('../../utils/textScrubber') as typeof import('../../utils/textScrubber');
            const raw = args.body as string | undefined;
            const cleanedRaw = raw ? scrubInternalLeakage(raw) : '';
            // v2.6.2 (D5) — use skipLocationField (not effectiveIsOnline) so
            // office-day internal hybrid meetings DO get a location block in the
            // body even when a Teams link is also being added.
            if (skipLocationField) {
              // Fully online — no physical location to surface. Return body as-is.
              return cleanedRaw || undefined;
            }
            if (!resolvedLocationParts || resolvedLocationParts.length === 0) {
              return cleanedRaw || undefined;
            }
            // Build a clean location block — one line per part, no em-dash
            // separators. Reads cleanly in any client.
            const locBlock =
              `<p><strong>Location:</strong></p>\n` +
              `<ul>${resolvedLocationParts.map(p => `<li>${p}</li>`).join('')}</ul>`;
            const composed = cleanedRaw
              ? `${locBlock}\n<hr/>\n${cleanedRaw}`
              : locBlock;
            return composed;
          })(),
          // v2.5.2 — effective isOnline pulls from Sonnet's explicit arg first,
          // falls back to the day-aware decision when both is_online and location
          // were left blank.
          isOnline:   effectiveIsOnline,
          // All-day events. Sonnet sets is_all_day=true ONLY when owner
          // explicitly asks for a full-day event. createMeeting() clamps
          // start/end to midnight-of-day → midnight-of-next-day per Graph's
          // requirement; we just pass the flag through here.
          isAllDay:   args.is_all_day === true,
          // v2.3.2 (1C) / v2.3.6 (#73) / v2.4.3 (E1) — clean comma-joined
          // location with no em-dash separators (an em-dash joiner makes the
          // Outlook location field hard to read), routed through
          // scrubInternalLeakage for safety against any owner-yaml accidental
          // dashes.
          location: ((): string | undefined => {
            if (args.is_online === true) return undefined;
            if (!resolvedLocationParts || resolvedLocationParts.length === 0) return undefined;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { scrubInternalLeakage } = require('../../utils/textScrubber') as typeof import('../../utils/textScrubber');
            return scrubInternalLeakage(resolvedLocationParts.join(', '));
          })(),
          categories:  args.category ? [args.category as string] : ['Meeting'],  // default fallback
          // Stamp sensitivity=private on the Graph event when the chosen
          // category carries `sets_sensitivity_private: true` in yaml. Reads
          // from profile rather than hardcoding any specific category name —
          // a future profile that wants a different category to be its
          // privacy marker just sets the flag in yaml.
          // v2.8.6 — explicit args.sensitivity overrides the category-driven
          // default. Lets owner OR an attendee ask "mark this private" at booking
          // time. Default is undefined (Outlook normal); only set when the
          // conversation asked for it.
          sensitivity: (() => {
            const explicit = args.sensitivity as string | undefined;
            const ALLOWED = ['normal', 'personal', 'private', 'confidential'];
            if (explicit && ALLOWED.includes(explicit) && explicit !== 'normal') {
              return explicit as 'personal' | 'private' | 'confidential';
            }
            const cat = (args.category as string | undefined) ?? null;
            if (!cat) return undefined;
            const match = (context.profile.categories ?? []).find(c => c.name === cat);
            return match?.sets_sensitivity_private ? 'private' : undefined;
          })(),
          // v2.3.1 (B23) — invite-body attribution names this assistant + owner.
          defaultBodyAuthor: `${context.profile.assistant.name}, ${context.profile.user.name.split(' ')[0]} Assistant`,
        }).then(async createdMeeting => {
          const meetingId = createdMeeting.id;
          // v2.2.5 (#54) — post-create verification. Graph occasionally returns
          // 200 OK + an event id on writes that didn't actually land (sync
          // delays, race conditions). Re-read by id and confirm the start time
          // matches before declaring success. On failure, downstream layers see
          // {success:false} so the action tape, claim-checker, and brief all
          // narrate honestly instead of asserting a write that didn't happen.
          const { verifyEventCreated } = await import('../../connectors/graph/calendar');
          const verify = await verifyEventCreated(userEmail, meetingId, args.start as string, timezone);
          if (!verify.ok) {
            logger.warn('create_meeting verify failed — Graph returned id but readback drifted', {
              meetingId, reason: verify.reason,
              expected: 'expected' in verify ? verify.expected : undefined,
              got: 'got' in verify ? verify.got : undefined,
            });
            const subject = args.subject as string;
            const message = verify.reason === 'not_found'
              ? `I tried to book '${subject}' but couldn't read it back from the calendar afterward — the booking may not have landed. Want me to retry?`
              : `I created '${subject}' but the calendar shows it at ${verify.got} instead of ${verify.expected}. Something drifted on the write — want me to delete and retry?`;
            return {
              success: false,
              error: verify.reason === 'not_found' ? 'created_but_missing' : 'created_but_drift',
              message,
            };
          }

          // v3.6.x — the Teams-URL-as-location patch was REMOVED. It overwrote the
          // location Graph auto-sets on an online meeting ("Microsoft Teams
          // Meeting") with the raw joinUrl → the new Outlook then showed the URL as
          // an "Unknown" location AND dropped the native Teams rendering (the toggle
          // went off) even though isOnlineMeeting stayed true (the 2026-07-05
          // Catchup bug). A native Teams meeting needs NOTHING after create:
          // isOnlineMeeting + provider (in the createMeeting POST) already give the
          // toggle, the Join button, the body block, and the location label. Never
          // write the raw joinUrl into location.

          // v2.2.3 (scenario 8 row 7) — post-mutation floating-block rebalance.
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { rebalanceFloatingBlocksAfterMutation } = require('../../utils/rebalanceFloatingBlocks') as
              typeof import('../../utils/rebalanceFloatingBlocks');
            await rebalanceFloatingBlocksAfterMutation({
              profile: context.profile,
              affectedSlotIso: args.start as string,
              ownerSlackId: context.profile.user.slack_user_id,
            });
          } catch (err) {
            logger.warn('rebalance after create_meeting threw — continuing', { err: String(err).slice(0, 200) });
          }

          // v2.9.2 — close in-flight artifacts. Per closeMeetingArtifacts' own
          // contract (v1.8.8 / v2.4.2 comments): "Every meeting mutation —
          // create / move / update / delete — can leave stale artifacts." Every
          // mutation path must call the cascade,
          // else in_flight_action follow_ups opened during a spilled create
          // attempt never close on the successful retry. Subject is passed so
          // the subject-fallback match catches rows whose details.meeting_id is
          // undefined.
          await closeMeetingArtifacts({
            ownerUserId: context.profile.user.slack_user_id,
            meetingId,
            reason: 'created',
            subject: args.subject as string | undefined,
            bookingThreadTs: context.threadTs,
            // v3.4.6 — approve→book link: on a resolver-driven replay this is
            // the originating request id, so the cascade skips it (resolver owns
            // its close + relay). Undefined on direct/owner-path books.
            fulfillingRequestId: args._fulfilling_request_id as string | undefined,
          });

          // The booked slot became real, so any tentative hold on it is
          // resolved. Release it; if it was held by SOMEONE ELSE (the owner
          // booked over it via override_hold), DM that holder it was let go.
          // The holder's own confirm releases silently (it's their meeting now).
          try {
            const sh = await import('../../db/slotHolds');
            const cleared = sh.releaseHoldsForOwner(
              context.profile.user.slack_user_id, { startIso: args.start as string }, 'slot_booked',
            );
            for (const h of cleared) {
              if (!h.holder_slack_id || h.holder_slack_id === context.userId) continue;
              try {
                const { getConnection } = await import('../../connections/registry');
                const conn = getConnection(context.profile.user.slack_user_id, 'slack');
                if (conn) {
                  await conn.sendDirect(
                    h.holder_slack_id,
                    `Quick heads up — ${context.profile.user.name.split(' ')[0]} ended up taking ${formatIsoTime(args.start as string)}, so I've released the hold I had for you there. Happy to find you another time whenever.`,
                    h.origin_thread_ts ? { threadTs: h.origin_thread_ts } : undefined,
                  );
                }
              } catch (dmErr) {
                logger.warn('create_meeting — hold-release DM failed (hold already released)', { err: String(dmErr).slice(0, 150) });
              }
            }
          } catch (err) {
            logger.warn('create_meeting — slot-hold release threw, continuing', { err: String(err).slice(0, 150) });
          }

          // v2.3.2 — colleague-path booking: shadow-DM the owner so he sees the
          // book happen even when he wasn't in the loop. Mirrors the v2.2.1
          // move_meeting shadow on inbound reschedule. Threaded under the
          // colleague conversation key so all shadows from this thread group
          // together in the owner's DM.
          // Skip when the "colleague" is really the OWNER clamped to colleague-
          // context in an MPIM/channel: he booked it himself and was right there,
          // so a self-shadow ("Idan confirmed slot in DM — booked…") is nonsense.
          if (context.senderRole === 'colleague' && context.userId !== context.profile.user.slack_user_id) {
            try {
              const { shadowNotify } = await import('../../utils/shadowNotify');
              const { getPersonMemory } = await import('../../db');
              const requesterRow = getPersonMemory(context.userId);
              const requesterName = requesterRow?.name ?? 'a colleague';
              const whenLocal = DateTime.fromISO(args.start as string, { zone: timezone });
              const whenLabel = whenLocal.isValid
                ? whenLocal.toFormat('EEE d MMM HH:mm')
                : formatIsoTime(args.start as string);
              await shadowNotify(context.profile, {
                channel: context.channelId,
                threadTs: context.threadTs,
                action: 'Meeting booked',
                detail: `${requesterName} confirmed slot in DM — booked "${args.subject}" for ${whenLabel}.`,
                conversationKey: context.threadTs,
                conversationHeader: `Conversation with ${requesterName}`,
              });
            } catch (err) {
              logger.warn('shadowNotify after colleague create_meeting failed — continuing', { err: String(err).slice(0, 200) });
            }

            // v2.3.2 — post-booking heads-up DMs to non-self internal attendees.
            // The fast-path skipped DMs during slot search (we checked their
            // calendars directly via Graph) — they deserve a soft "this just got
            // booked" so they aren't surprised by the calendar invite, phrased
            // like a human EA. Lookup by email via searchPeopleMemory; skip
            // silently if no slack_id available (the calendar invite still went
            // out).
            try {
              const { searchPeopleMemory, getPersonMemory } = await import('../../db');
              const { getConnection } = await import('../../connections/registry');
              const conn = getConnection(context.profile.user.slack_user_id, 'slack');
              if (conn) {
                const requesterRow = getPersonMemory(context.userId);
                const requesterName = requesterRow?.name ?? 'a colleague';
                const requesterEmail = (requesterRow?.email ?? '').toLowerCase();
                const ownerFirst = context.profile.user.name.split(' ')[0];
                const ownerDomain = ownerEmail.includes('@') ? ownerEmail.split('@')[1].toLowerCase() : '';
                const whenLocal = DateTime.fromISO(args.start as string, { zone: timezone });
                const whenLabel = whenLocal.isValid
                  ? whenLocal.toFormat('EEEE d MMM \'at\' HH:mm')
                  : formatIsoTime(args.start as string);
                for (const att of attendees) {
                  const e = (att.email ?? '').toLowerCase();
                  if (!e) continue;
                  if (e === ownerEmail.toLowerCase()) continue;
                  if (e === requesterEmail) continue;
                  if (assistantEmail && e === assistantEmail.toLowerCase()) continue;
                  if (!ownerDomain || !e.endsWith('@' + ownerDomain)) continue;  // internal only
                  const matches = searchPeopleMemory(e);
                  const targetSlackId = matches.find(m => (m.email ?? '').toLowerCase() === e)?.slack_id;
                  if (!targetSlackId) {
                    logger.debug('post-booking heads-up DM skipped — no slack_id for attendee', { email: e });
                    continue;
                  }
                  const heuristicFirstName = (att.name ?? '').split(' ')[0];
                  const text = `Hi ${heuristicFirstName} — ${requesterName} asked for a meeting with you and ${ownerFirst}. I checked your calendar and booked "${args.subject}" for ${whenLabel}. See you then.`;
                  void conn.sendDirect(targetSlackId, text).catch(err => {
                    logger.warn('post-booking heads-up DM failed', { email: e, err: String(err).slice(0, 200) });
                  });
                }
              }
            } catch (err) {
              logger.warn('post-booking heads-up DMs threw — continuing', { err: String(err).slice(0, 200) });
            }
          }

          // v2.9 — venue skill save-on-book hook. Persist non-company venues
          // to the owner's catalog at rank=2 (or bump last_used_at if already
          // saved). Only fires when the skill is on AND the stamped location
          // is an external venue (not the office, not Huddle, not Teams URL).
          if ((context.profile.skills as any)?.venue === true && planLocation && planLocation.trim().length > 0) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { isCompanyLocation } = require('../../db/venues') as typeof import('../../db/venues');
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { saveOrBumpVenueOnBook } = require('../venue') as typeof import('../venue');
              const officeLoc = context.profile.meetings.office_location ?? {};
              if (!isCompanyLocation(planLocation, officeLoc)) {
                saveOrBumpVenueOnBook({
                  ownerUserId: context.profile.user.slack_user_id,
                  name: planLocation,
                  // address is the same as name for the v2.9 MVP — the stamped
                  // location string typically already includes "Name, Street
                  // City". Future Google-Places integration (#96) will split
                  // these out.
                });
              }
            } catch (err) {
              logger.warn('venue save-on-book hook failed — continuing', {
                err: String(err).slice(0, 200),
              });
            }
          }

          // v3.0.6 — write a "Booked X" line to each non-owner attendee's
          // person_memory md so future reads have the venue/subject/date.
          // Fire-and-forget; never blocks the response. Externals without a
          // people_memory row are silently skipped (see recordBooking.ts).
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { recordBookingInPersonMemory } = require('../../memory/recordBooking') as
              typeof import('../../memory/recordBooking');
            void recordBookingInPersonMemory({
              profile: context.profile,
              subject: args.subject as string,
              startIso: args.start as string,
              location: planLocation,
              attendees: attendees
                .filter((a): a is typeof a & { email: string } => typeof a.email === 'string' && a.email.length > 0)
                .map(a => ({ email: a.email, name: a.name, slack_id: a.slack_id })),
              mutation: 'booked',
              // v3.1.7 — only the owner asking to book persists new externals.
              ownerInitiated: context.senderRole === 'owner',
            });
          } catch (err) {
            logger.warn('recordBookingInPersonMemory invocation failed (colleague-path) — continuing', {
              err: String(err).slice(0, 200),
            });
          }

          // v3.3.8 — the offer on the table was consumed by this booking; clear
          // it so a stale "bind picks to these" block can't mislead the
          // conversation's next exchange.
          if (context.channelId) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { clearOfferedSlots } = require('../../utils/offeredSlotsStash') as
                typeof import('../../utils/offeredSlotsStash');
              clearOfferedSlots(context.channelId, context.threadTs);
            } catch (_) { /* non-fatal */ }
          }

          // v3.1.4 (Y3) — record the requester-link for a colleague's direct
          // booking. findMeetingOwner reads the requests spine to decide "who
          // controls this meeting"; a direct colleague create_meeting must record its
          // requester (coord bookings already do), else a colleague editing the
          // meeting they just requested isn't recognized as its requester. One
          // terminal row keyed on the event lets the requester control
          // add/rename/location via the update_meeting + move_meeting gates.
          if (context.senderRole === 'colleague' && meetingId) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { createRequest } = require('../../db/requests') as typeof import('../../db/requests');
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { getPersonMemory } = require('../../db/people') as typeof import('../../db/people');
              const requesterName = getPersonMemory(context.userId)?.name ?? undefined;
              createRequest({
                ownerUserId: context.profile.user.slack_user_id,
                initiatedBy: context.userId,
                initiatedByRole: 'colleague',
                kind: 'follow_up',
                subkind: 'colleague_booking_record',
                subject: `Booking requested by ${requesterName ?? context.userId}: ${args.subject ?? 'meeting'}`,
                state: 'resolved',
                informed: 1,
                requesterSlackId: context.userId,
                requesterName,
                outcomeExternalEventId: meetingId,
              });
            } catch (err) {
              logger.warn('colleague booking requester-link write failed — continuing', {
                err: String(err).slice(0, 200),
              });
            }
          }

          // v3.5.x (Consumer 3) — the booked-confirmation states the time via the ONE
          // renderer (dual-clock on a travel day, single clock at home), so the model
          // quotes it instead of re-narrating from the raw home-zone `booked_start`
          // and mislabelling it (the "17:00 = 5 PM EDT" inversion, 2026-06-29).
          const bookedTravel = { isAway: !!tripDisplay, effectiveTz: tripDisplay?.tz ?? timezone, location: tripDisplay?.location ?? '' };
          const bookedWhen = renderWeDualClock(args.start as string, bookedTravel, timezone, { endIso: args.end as string });
          const bookedTripNote = tripDisplay
            ? 'Travel day — state the booked time from `action_summary` VERBATIM (it carries both clocks, correctly labelled). Do NOT recompute it from `booked_start`/`booked_end`, which are the raw home-zone instant kept for verification only.'
            : undefined;
          return {
            success: true,
            meetingId,
            // #1.5 — surface the ACTUAL booked start/end (after the grid-snap at
            // :2274 + any TZ convert), so narration, dateVerifier, and the #135
            // honesty backstop (via the orchestrator's mutationActions) see where
            // the meeting TRULY landed — not the pre-snap arg Sonnet passed.
            booked_start: args.start as string,
            booked_end: args.end as string,
            // v1.8.3 — past-tense summary the reply can quote verbatim. Prevents
            // Sonnet from narrating the post-action calendar state as a fresh
            // discovery instead of the result of her own action (issue #26 bug 1).
            action_summary: `Booked '${args.subject}' for ${bookedWhen}.`,
            ...(bookedTripNote ? { _trip_note: bookedTripNote } : {}),
            // #127 — owner booked through a soft own-day rule: surface the
            // heads-up so Maelle mentions it ONCE ("Booked — note this dips your focus floor
            // to 1h55"), never a blocking re-ask. Undefined on clean bookings.
            ...(planOverrideNotice ? { override_notice: planOverrideNotice } : {}),
          };
        });
      }

      case 'update_meeting': {
        // v2.1.4 — attendee-only guard. If the event's organizer is not the
        // owner, the owner is an ATTENDEE on someone else's meeting. Graph
        // rejects PATCH from non-organizers, but the error message is unhelpful;
        // refuse early with a clear human message so Maelle doesn't offer a fake
        // "I'll add the location" then silently fail.
        try {
          // v2.7.0 — ownership via findMeetingOwner (per D4 / Q1).
          const { findMeetingOwner } = await import('./findMeetingOwner');
          const ownerInfo = await findMeetingOwner({
            ownerUserId: context.profile.user.slack_user_id,
            ownerEmail: userEmail,
            eventId: args.meeting_id as string,
          });
          if (!ownerInfo.ownerIsOrganizer && ownerInfo.organizerEmail) {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            const orgName = ownerInfo.organizerName ?? ownerInfo.organizerEmail;
            logger.info('update_meeting refused — owner is attendee, not organizer', {
              meetingId: args.meeting_id, organizer: ownerInfo.organizerEmail,
            });
            return {
              error: 'not_organizer',
              meeting_subject: args.meeting_subject,
              organizer_name: orgName,
              organizer_email: ownerInfo.organizerEmail,
              message: `Can't change "${args.meeting_subject}" — ${orgName} organized that one, not ${ownerFirst}. Only the organizer can change the subject, location, or body. Want me to flag it to ${ownerFirst}?`,
            };
          }
        } catch (err) {
          logger.warn('update_meeting attendee-only guard threw — proceeding', { err: String(err) });
        }

        // v1.8.8 — block series-level mutations on recurring meetings. If the
        // event is a seriesMaster, updating it would change every occurrence,
        // which is almost never what the owner wants. Refuse and hand back
        // control. Occurrences (single firings of a recurring series) and
        // exceptions (already-customized single firings) are allowed — Graph
        // creates/modifies an exception for that instance on PATCH.
        try {
          const { getEventType } = await import('../../connectors/graph/calendar');
          const probe = await getEventType(userEmail, args.meeting_id as string);
          if (probe?.type === 'seriesMaster') {
            logger.info('update_meeting refused on recurring seriesMaster', {
              meetingId: args.meeting_id,
              subject: probe.subject,
            });
            return {
              error: 'recurring_series_master',
              meeting_subject: probe.subject,
              message: `"${probe.subject}" is a recurring series. Updating the series here would change every occurrence — that's not safe to do automatically. The owner should update the series directly in the calendar. For a SINGLE occurrence, call update_meeting with that occurrence's meeting_id (get it from get_calendar for that specific date) — the system will create an exception for that one date only.`,
            };
          }
        } catch (err) {
          logger.warn('update_meeting recurring-preflight failed — proceeding', { err: String(err) });
        }

        // v2.9.1 — attendee add/remove path. When `add_attendees` or
        // `remove_attendees` is non-empty
        // we (a) gate colleague-path to self-only, (b) load the existing
        // event, (c) compute the new attendee list, (d) re-evaluate
        // category + location ONLY when the change is shape-affecting
        // (internal-only ↔ has-external, or count crossing 4↔5), and
        // (e) call updateMeeting with the merged shape.
        const rawAdd = (args.add_attendees as Array<{ name?: string; email?: string; optional?: boolean }> | undefined) ?? [];
        const rawRemove = (args.remove_attendees as string[] | undefined) ?? [];
        const hasAttendeeChange = rawAdd.length > 0 || rawRemove.length > 0;
        let mergedAttendees: Array<{ name?: string; email: string; optional?: boolean }> | undefined;
        let newCategoryFromShape: string | undefined;
        let newLocationFromShape: string | undefined;
        let newIsOnlineFromShape: boolean | undefined;

        if (hasAttendeeChange) {
          const ownerFirst = context.profile.user.name.split(' ')[0];
          // v3.1.4 (Y2) — resolve name-only adds to emails from the directory
          // BEFORE the missing-email filter, via the shared resolver every
          // booking path uses. Without this, "add Eli Feldman" (no email) gets
          // dropped → attendee_missing_email → Maelle asks the colleague for an
          // email she already has on file.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { resolveAttendeeEmail } = require('./resolveAttendeeEmails') as
            typeof import('./resolveAttendeeEmails');
          const addList = rawAdd
            .map(a => {
              const resolved = resolveAttendeeEmail({ name: a.name, email: a.email });
              return { name: resolved.name, email: resolved.email, optional: a.optional === true };
            })
            .filter(a => a.email.includes('@'));
          const removeList = rawRemove
            .map(e => (e ?? '').trim().toLowerCase())
            .filter(e => e.includes('@'));

          if (addList.length === 0 && rawAdd.length > 0) {
            return {
              error: 'attendee_missing_email',
              meeting_subject: args.meeting_subject,
              message: `Can't add attendees without emails — at least one entry in add_attendees had no email. Pass each as { email: "...", name: "..." }.`,
            };
          }

          // v3.1.4 (Y3) — requester-controls gate (replaces the old self-only
          // gate). Owner direction: whoever REQUESTED a meeting controls it —
          // they can add anyone, rename, change location, even if they're not on
          // it. A non-requester colleague editing the owner's meeting → escalate
          // to ONE approval. The requester is resolved from the requests spine
          // via findMeetingOwner (coord bookings + the v3.1.4 colleague-booking
          // requester-link both populate it).
          if (context.senderRole === 'colleague') {
            let isRequester = false;
            try {
              const { findMeetingOwner } = await import('./findMeetingOwner');
              const ownerInfo = await findMeetingOwner({
                ownerUserId: context.profile.user.slack_user_id,
                ownerEmail: userEmail,
                eventId: args.meeting_id as string,
              });
              isRequester = ownerInfo.requesterSlackId === context.userId;
            } catch (err) {
              logger.warn('update_meeting requester gate — findMeetingOwner threw, treating as non-requester', {
                err: String(err).slice(0, 200),
              });
            }
            if (!isRequester) {
              logger.info('update_meeting — non-requester colleague attendee change → escalate', {
                meetingId: args.meeting_id,
                requester: context.userId,
                adds: addList.map(a => a.email),
                removes: removeList,
              });
              return {
                error: 'colleague_not_requester',
                meeting_subject: args.meeting_subject,
                message: `Only ${ownerFirst} (or whoever requested this meeting) can change who's on "${args.meeting_subject}". Raise it with ${ownerFirst} via create_approval(kind=meeting_change) so he can decide.`,
              };
            }
          }

          // Load existing event for current attendees + shape signals.
          const { getEventForAttendeeUpdate } = await import('../../connectors/graph/calendar');
          const existing = await getEventForAttendeeUpdate(userEmail, args.meeting_id as string);
          if (!existing) {
            return {
              error: 'event_load_failed',
              meeting_subject: args.meeting_subject,
              message: `Couldn't load "${args.meeting_subject}" to update its attendees. The event may have been cancelled or moved.`,
            };
          }

          // Build the merged list: keep all existing not in removeList,
          // then append adds not already present. Dedupe by lowercase email.
          const removeSet = new Set(removeList);
          const merged = new Map<string, { name?: string; email: string; optional?: boolean }>();
          for (const a of existing.attendees) {
            if (removeSet.has(a.email)) continue;
            merged.set(a.email, a);
          }
          for (const a of addList) {
            if (removeSet.has(a.email)) continue;  // a remove + add in same call: removed wins
            if (!merged.has(a.email)) merged.set(a.email, a);
          }
          mergedAttendees = [...merged.values()];

          // Shape change detection — same signals resolveLocation reads:
          // (a) has-external flipped, (b) participant count crossed 4↔5.
          const ownerEmailLc = context.profile.user.email.toLowerCase();
          const ownerDomain = ownerEmailLc.includes('@') ? ownerEmailLc.split('@')[1] : '';
          const wasExternal = existing.attendees.some(a =>
            ownerDomain && a.email.endsWith('@' + ownerDomain) ? false : a.email !== ownerEmailLc
          );
          const isExternalNow = mergedAttendees.some(a =>
            ownerDomain && a.email.endsWith('@' + ownerDomain) ? false : a.email !== ownerEmailLc
          );
          // Count includes owner (resolveLocation reads total participantCount).
          const oldCount = existing.attendees.some(a => a.email === ownerEmailLc)
            ? existing.attendees.length
            : existing.attendees.length + 1;
          const newCount = mergedAttendees.some(a => a.email === ownerEmailLc)
            ? mergedAttendees.length
            : mergedAttendees.length + 1;
          const crossedThreshold = (oldCount <= 3 && newCount >= 4)
            || (oldCount >= 4 && newCount <= 3)
            || (oldCount <= 4 && newCount >= 5)
            || (oldCount >= 5 && newCount <= 4);
          const shapeChanged = (wasExternal !== isExternalNow) || crossedThreshold;

          if (shapeChanged && existing.startIso) {
            logger.info('update_meeting — attendee shape changed, re-evaluating category + location', {
              meetingId: args.meeting_id,
              wasExternal, isExternalNow,
              oldCount, newCount,
            });
            try {
              const { detectCategory } = await import('./detectCategory');
              const { resolveLocation } = await import('../../utils/resolveLocation');
              const catResult = await detectCategory({
                profile: context.profile,
                subject: args.meeting_subject as string,
                attendees: mergedAttendees,
                isRecurring: false,
              });
              const newCategory = catResult.category;
              const oldCategory = existing.categories[0] ?? null;

              if (newCategory && newCategory !== oldCategory) {
                newCategoryFromShape = newCategory;
              }

              // Attendee-shape change re-evaluation: intent='new_booking'
              // (NOT 'move') and omit priorStartIso so resolveLocation
              // doesn't take the preserve_existing path. With intent='move' +
              // priorStartIso and an unchanged day-type, resolveLocation
              // would short-circuit to preserve_existing and the location
              // would never be re-stamped — which lost Teams URLs on
              // home-day internal→has-external transitions. Existing-state
              // fields stay populated for downstream callers but don't
              // gate the verdict.
              const loc = resolveLocation({
                profile: context.profile,
                startIso: existing.startIso,
                intent: 'new_booking',
                category: newCategory ?? oldCategory ?? undefined,
                participantCount: newCount,
                hasExternalAttendee: isExternalNow,
                existingLocation: existing.location,
                existingIsOnline: existing.isOnline,
              });
              if (loc.kind === 'resolved') {
                if (loc.location !== existing.location) newLocationFromShape = loc.location;
                if (loc.isOnline !== existing.isOnline) newIsOnlineFromShape = loc.isOnline;
              }
              // v3.4.2 (travel context) — when the meeting's day is a trip day,
              // an onsite (internal, not remote-forced) meeting's location is the
              // TRIP place, not the home day-type default (Huddle/Teams) the
              // re-eval above produced. This is the placeholder-update path —
              // adding people to a Boston-week meeting came back "Huddle" because
              // the re-eval was travel-blind. Mirrors create/move. No-op off-trip.
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getTravelContextForInstant } = require('../../utils/workingElsewhere') as
                  typeof import('../../utils/workingElsewhere');
                const tctx = await getTravelContextForInstant(existing.startIso, userEmail, context.profile.user.slack_user_id, timezone);
                if (tctx.isAway && tctx.location && isExternalNow === false) {
                  newLocationFromShape = tctx.location;
                  newIsOnlineFromShape = false;
                  logger.info('update_meeting — trip day, location → trip place', { location: tctx.location });
                }
              } catch (err) {
                logger.warn('update_meeting — travel-context location override threw', { err: String(err).slice(0, 160) });
              }
              // preserve_existing / ask_owner / room_unavailable — leave the
              // event's location alone. Category change still applies if any.
            } catch (err) {
              logger.warn('update_meeting — shape re-evaluation threw, applying attendee change without category/location update', {
                err: String(err).slice(0, 200),
              });
            }
          }
        }

        // v3.5.x — explicit location / is_online change ("update the location to
        // The Bosworth"). Graph's updateMeeting already supports it; this exposes
        // it on the tool. An explicit arg WINS over the shape-derived location
        // (which only fires on an attendee add/remove). Both omitted → undefined →
        // the event's CURRENT location is preserved (a subject/attendee change
        // never wipes the venue).
        const explicitLocation = typeof args.location === 'string' && (args.location as string).trim()
          ? (args.location as string).trim()
          : undefined;
        const explicitIsOnline = typeof args.is_online === 'boolean' ? (args.is_online as boolean) : undefined;
        await updateMeeting({
          userEmail,
          timezone,
          meetingId:  args.meeting_id  as string,
          subject:    args.new_subject as string | undefined,  // subjects allow " - " (E1, owner direction)
          categories: args.category
            ? [args.category as string]
            : (newCategoryFromShape ? [newCategoryFromShape] : undefined),
          attendees: mergedAttendees,
          location: explicitIsOnline === true ? '' : (explicitLocation ?? newLocationFromShape),
          isOnline: explicitIsOnline ?? newIsOnlineFromShape,
        });
        await closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'updated',
          subject: (args.new_subject as string | undefined) ?? (args.meeting_subject as string | undefined),
          bookingThreadTs: context.threadTs,
          fulfillingRequestId: args._fulfilling_request_id as string | undefined,
        });
        auditLog({
          action: 'update_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          details: {
            subject: args.meeting_subject,
            category: args.category,
            new_subject: args.new_subject,
            added_attendees: (args.add_attendees as Array<{ email?: string }> | undefined)?.map(a => a.email).filter(Boolean),
            removed_attendees: (args.remove_attendees as string[] | undefined),
            shape_recategorized: newCategoryFromShape ?? null,
            shape_relocated: newLocationFromShape ?? null,
          },
          outcome: 'success',
        });
        const updateChanges: string[] = [];
        if (args.new_subject) updateChanges.push(`renamed to '${args.new_subject}'`);
        if (args.category) updateChanges.push(`category set to ${args.category}`);
        if (rawAdd.length > 0) {
          const names = rawAdd.map(a => a.name || a.email).filter(Boolean) as string[];
          updateChanges.push(`added ${names.join(', ')}`);
        }
        if (rawRemove.length > 0) {
          updateChanges.push(`removed ${rawRemove.join(', ')}`);
        }
        if (newCategoryFromShape) updateChanges.push(`category re-tagged ${newCategoryFromShape} (attendee shape changed)`);
        // v3.6.x — narrate EXPLICIT location / online changes too (not just the
        // shape-derived one), so action_summary — and therefore the claim-checker
        // — can verify a "moved to X" / "switched to online" claim instead of
        // seeing no evidence and flagging a done change as not-done. Explicit
        // wins over shape (matches the apply at updateMeeting above).
        if (explicitLocation) updateChanges.push(`location set to "${explicitLocation}"`);
        else if (newLocationFromShape !== undefined) updateChanges.push(`location updated to "${newLocationFromShape}"`);
        if (explicitIsOnline === true) updateChanges.push('switched to online');
        else if (explicitIsOnline === false) updateChanges.push('switched to in-person');
        return {
          success: true,
          updated: args.meeting_subject,
          category: args.category ?? newCategoryFromShape ?? null,
          new_subject: args.new_subject ?? null,
          added_attendees: rawAdd.map(a => a.email).filter(Boolean),
          removed_attendees: rawRemove,
          // v1.8.3 — past-tense summary for owner-visible reply. Issue #26 bug 1.
          action_summary: `Updated '${args.meeting_subject}'${updateChanges.length > 0 ? ': ' + updateChanges.join(', ') : ''}.`,
        };
      }

      case 'move_meeting': {
        // v3.5.x (WE time spine) — the SAME single resolver as create_meeting (see
        // its block for the full rationale). On a WE day a BARE new_start the owner
        // typed is trip-LOCAL; a zone he named (`stated_zone`/start_timezone) wins;
        // an offset-tagged new_start is a fixed instant, left as-is. moveTripDisplay
        // is kept only for the dual-clock narration.
        let moveTripDisplay: { tz: string; location: string } | null = null;
        if (typeof args.new_start === 'string') {
          try {
            const { getTravelContextForInstant } = await import('../../utils/workingElsewhere');
            const travel = await getTravelContextForInstant(args.new_start, userEmail, context.profile.user.slack_user_id, timezone);
            if (travel.isAway) moveTripDisplay = { tz: travel.effectiveTz, location: travel.location };
            const statedZone = (typeof args.stated_zone === 'string' && args.stated_zone.trim())
              ? args.stated_zone.trim()
              : (typeof args.start_timezone === 'string' && args.start_timezone.trim() ? args.start_timezone.trim() : undefined);
            const resolved = resolveStatedInstant({
              startIso: args.new_start,
              endIso: typeof args.new_end === 'string' ? args.new_end : undefined,
              statedZone, travel, homeTz: timezone,
            });
            if (resolved.reinterpreted) {
              logger.info('move_meeting — stated time resolved to canonical instant', {
                statedZone: statedZone ?? '(none)', sourceZone: resolved.sourceZone,
                newStartWas: args.new_start, newStartNow: resolved.startIso, isAway: travel.isAway,
              });
            }
            args.new_start = resolved.startIso;
            if (resolved.endIso) args.new_end = resolved.endIso;
          } catch (err) {
            logger.warn('move_meeting — WE time resolve threw, using time as-is', { err: String(err).slice(0, 160) });
          }
        }
        // #135c — pure reschedule keeps the meeting's length. When the model
        // omits new_end (it should, on a plain "move it to Thursday 11:00"),
        // derive it from the moving event's existing duration and populate
        // args.new_end HERE — early, before the colleague rule-check, the audit
        // log, and the success result all read it — so the model never has to
        // supply (or re-ask the owner for) a length it already knows. One light
        // event fetch, only on the omit path; 30-min fallback if unreadable.
        if ((typeof args.new_end !== 'string' || (args.new_end as string).length === 0) && typeof args.new_start === 'string') {
          let durMin = 30;
          try {
            const { getEventType } = await import('../../connectors/graph/calendar');
            const probe = await getEventType(userEmail, args.meeting_id as string);
            if (probe?.startDateTime && probe?.endDateTime) {
              const s0 = DateTime.fromISO(probe.startDateTime, { zone: timezone });
              const e0 = DateTime.fromISO(probe.endDateTime, { zone: timezone });
              if (s0.isValid && e0.isValid && e0.toMillis() > s0.toMillis()) durMin = Math.round(e0.diff(s0, 'minutes').minutes);
            }
          } catch (err) {
            logger.warn('move_meeting — duration probe threw; defaulting new_end to 30min', { err: String(err).slice(0, 160) });
          }
          args.new_end = DateTime.fromISO(args.new_start as string, { zone: timezone }).plus({ minutes: durMin }).toISO() ?? (args.new_start as string);
          logger.info('move_meeting — derived new_end from existing duration (new_end omitted)', {
            meetingId: args.meeting_id, durMin, new_end: args.new_end,
          });
        }

        // v2.2.1 — colleague-path rule-compliance gate. When an inbound colleague
        // DM asks Maelle to move an existing meeting, she can do it autonomously
        // IF the new slot fits the owner's rules (work hours, work days, buffers,
        // floating blocks, no conflicts). If the new slot breaks a rule, the tool
        // refuses and signals needs_owner_approval — Sonnet then falls back to
        // create_approval(kind=meeting_reschedule). Owner-path callers skip this
        // check (owner override IS the approval).
        if (context.senderRole === 'colleague') {
          // v3.5.x — colleague-requested move gate (replaces the v3.1.4
          // requester-controls gate). Maelle organizes every meeting, so the old
          // "is the asker the REQUESTER?" test resolved to the owner ~every time
          // and escalated EVERY colleague move (Ysrael's clean 15:30→14:00 still
          // pinged the owner). Right axis: a colleague may move a meeting on their
          // own ONLY IF (1) they're a REQUIRED attendee, (2) every OTHER required
          // attendee is free at the new slot, (3) it fits the owner's rules. Else
          // escalate with the SPECIFIC reason. Owner-path skips this whole block —
          // owner override IS the approval (he can move over anyone).
          const ownerFirst = context.profile.user.name.split(' ')[0];
          const ownerEmailLc = userEmail.toLowerCase();

          // Load the meeting's REQUIRED attendees once — reused for the membership
          // check (step 1) AND the other-attendee free/busy check (step 2). Same
          // Graph helper update_meeting uses.
          let requiredAttendees: Array<{ name?: string; email: string }> = [];
          let attendeesLoaded = false;
          try {
            const { getEventForAttendeeUpdate } = await import('../../connectors/graph/calendar');
            const ev = await getEventForAttendeeUpdate(userEmail, args.meeting_id as string);
            if (ev) {
              requiredAttendees = (ev.attendees ?? [])
                .filter(a => !a.optional)
                .map(a => ({ name: a.name, email: a.email.toLowerCase() }));
              attendeesLoaded = true;
            }
          } catch (err) {
            logger.warn('move_meeting colleague gate — attendee load threw', { err: String(err).slice(0, 200) });
          }

          // Resolve the asker's email/name (the invite lists emails; match the
          // asker's slack_id → email via people_memory).
          let askerEmail: string | undefined;
          let askerName: string | undefined;
          try {
            const { getPersonMemory } = await import('../../db/people');
            const pm = getPersonMemory(context.userId);
            askerEmail = pm?.email?.toLowerCase() || undefined;
            askerName = pm?.name || undefined;
          } catch (_) { /* treated as non-member below */ }
          const askerFirst = askerName?.split(/\s+/)[0] ?? 'they';

          // Couldn't read the invite → don't guess; let the owner decide.
          if (!attendeesLoaded) {
            return {
              needs_owner_approval: true,
              reason: 'attendee_check_failed',
              meeting_subject: args.meeting_subject,
              requested_start: args.new_start,
              requested_end: args.new_end,
              message: `I couldn't read who's on "${args.meeting_subject}" to check whether ${askerFirst} can move it. Raise create_approval(kind=meeting_reschedule) so ${ownerFirst} decides.`,
            };
          }

          // Step 1 — the asker must be a REQUIRED attendee of the meeting.
          const askerIsRequired = !!askerEmail && requiredAttendees.some(a => a.email === askerEmail);
          if (!askerIsRequired) {
            logger.info('move_meeting — asker is not a required attendee → escalate', {
              meetingId: args.meeting_id, asker: context.userId,
            });
            return {
              needs_owner_approval: true,
              reason: 'requester_not_attendee',
              meeting_subject: args.meeting_subject,
              requested_start: args.new_start,
              requested_end: args.new_end,
              message: `${askerName ?? 'Someone'} asked to move "${args.meeting_subject}" but isn't on the invite — a meeting should only be moved by someone who's actually in it, so this needs ${ownerFirst}. Raise create_approval(kind=meeting_reschedule) and tell him ${askerFirst} isn't an attendee.`,
            };
          }
          // Step 1.5 — every OTHER required attendee must be INTERNAL so we can
          // actually verify their availability. An external attendee (client /
          // partner, different domain) can't be read cross-tenant — getFreeBusy
          // returns an empty (= "free all week") result for them, so step 2 would
          // pass them blindly. Moving a meeting that involves outside people is
          // high-stakes, so we never auto-move it: escalate to the owner with the
          // external attendee named.
          const ownerDomain = ownerEmailLc.includes('@') ? ownerEmailLc.split('@')[1] : '';
          const externalRequired = requiredAttendees.filter(a =>
            a.email !== ownerEmailLc
            && a.email !== askerEmail
            && (!ownerDomain || !a.email.endsWith('@' + ownerDomain)));
          if (externalRequired.length > 0) {
            const names = externalRequired.map(a => a.name?.split(/\s+/)[0] ?? a.email).join(', ');
            logger.info('move_meeting — external required attendee(s), availability unverifiable → escalate', {
              meetingId: args.meeting_id, external: externalRequired.map(a => a.email),
            });
            return {
              needs_owner_approval: true,
              reason: 'external_attendee_unverifiable',
              meeting_subject: args.meeting_subject,
              requested_start: args.new_start,
              requested_end: args.new_end,
              message: `${askerName ?? 'They'} asked to move "${args.meeting_subject}", but it has external attendee(s) whose availability I can't check (${names}) — moving a meeting with outside people needs ${ownerFirst}. Raise create_approval(kind=meeting_reschedule) and note the external attendee(s).`,
            };
          }

          const newStart = args.new_start as string | undefined;
          const newEnd = args.new_end as string | undefined;
          if (newStart && newEnd) {
            try {
              const startDt = DateTime.fromISO(newStart, { zone: timezone });
              const endDt = DateTime.fromISO(newEnd, { zone: timezone });
              if (startDt.isValid && endDt.isValid) {
                const durationMin = Math.max(5, Math.round((endDt.toMillis() - startDt.toMillis()) / 60_000));
                const { findAvailableSlots } = await import('../../connectors/graph/calendar');
                const startMs = startDt.toMillis();
                // v2.6.1 — pass exact requested window. See the parallel comment
                // in create_meeting Guard B for the full reasoning (±60s padding
                // lands the cursor outside work-hours boundaries by one minute,
                // and the slot is never tested).
                const fromIso = startDt.toUTC().toISO();
                const toIso = endDt.toUTC().toISO();
                let validSlots: Array<{ start: string }> = [];
                const diagnostics: { rejectedCounts?: Record<string, number>; rejectedExamples?: Record<string, string[]> } = {};
                // v3.5.x (step 2) — check the OTHER required attendees too: owner
                // + every required attendee EXCEPT the asker (the asker's own busy
                // doesn't block their own request). findAvailableSlots' diagnostics
                // then tell us WHO is busy so the escalation names them.
                const colleagueMoveCheckEmails = [userEmail, ...requiredAttendees
                  .map(a => a.email)
                  .filter(e => e !== ownerEmailLc && e !== askerEmail)];
                if (fromIso && toIso) {
                  validSlots = await findAvailableSlots({
                    userEmail,
                    timezone,
                    durationMinutes: durationMin,
                    attendeeEmails: colleagueMoveCheckEmails,
                    searchFrom: fromIso,
                    searchTo: toIso,
                    profile: context.profile,
                    // v2.6 — pass category so move_meeting colleague-path also
                    // enforces day_type / per_day / per_week limits at
                    // the destination. The destination day's count excludes
                    // the event being moved (it's leaving its current day);
                    // findAvailableSlots widens its event fetch when
                    // category is set so day/week counts are accurate.
                    category: args.category as string | undefined,
                    diagnosticsOut: diagnostics,
                    // v3.0.6 — single-slot validation; see the parallel comment
                    // in create_meeting Guard B. Auto-expand would re-query the
                    // calendar at widening ranges for slots that get discarded
                    // (matches checks ±60s of newStart). Disable.
                    autoExpand: false,
                  });
                }
                const matches = validSlots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000);
                if (!matches) {
                  // Surface the SPECIFIC blocker (step 2 vs step 3) so the
                  // approval tells the owner — and, downstream, the requester —
                  // exactly why. Attendee-scoped diagnostic keys
                  // (`attendee_busy_collision:<email>` /
                  // `outside_attendee_work_hours:<email>`) name the person; the
                  // rest are owner-rule violations. (ownerFirst from the gate above.)
                  const labelFor = (reason: string | undefined): string => {
                    switch (reason) {
                      case 'outside_owner_work_hours': return `outside ${ownerFirst}'s work hours`;
                      case 'owner_busy_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                      // legacy label name kept as alias in case any older diagnostics path still emits it
                      case 'owner_busy_or_buffer_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                      case 'overlaps_meeting_being_moved': return `overlaps the meeting being moved`;
                      case 'focus_time_office': return `would leave ${ownerFirst} under the free-time floor (office day)`;
                      case 'focus_time_home': return `would leave ${ownerFirst} under the free-time floor (home day)`;
                      case 'floating_block_no_room': return `would leave no room for one of ${ownerFirst}'s daily blocks (lunch / break / etc.)`;
                      case 'category_day_type': return `wrong day type for this category (e.g. office-only category on a home day)`;
                      case 'category_per_day': return `over ${ownerFirst}'s per-day limit for this category`;
                      case 'category_per_week': return `over ${ownerFirst}'s per-week limit for this category`;
                      default: return 'unknown';
                    }
                  };
                  const nameForEmail = (em: string): string =>
                    requiredAttendees.find(a => a.email === em.toLowerCase())?.name?.split(/\s+/)[0] ?? 'another attendee';
                  const counts = diagnostics.rejectedCounts ?? {};
                  const fired = Object.keys(counts);
                  const brokenRule = fired[0];
                  let reasonCode: string;
                  let humanReason: string;
                  if (brokenRule && brokenRule.startsWith('attendee_busy_collision')) {
                    reasonCode = 'attendee_unavailable';
                    humanReason = `${nameForEmail(brokenRule.split(':')[1] ?? '')} isn't free then`;
                  } else if (brokenRule && brokenRule.startsWith('outside_attendee_work_hours')) {
                    reasonCode = 'attendee_unavailable';
                    humanReason = `it's outside ${nameForEmail(brokenRule.split(':')[1] ?? '')}'s working hours`;
                  } else {
                    reasonCode = 'not_rule_compliant';
                    humanReason = labelFor(brokenRule);
                  }
                  logger.info('move_meeting colleague-path refused — new slot blocked', {
                    meetingId: args.meeting_id, newStart, newEnd, requester: context.userId,
                    broken_rule: brokenRule ?? 'unknown', reason_code: reasonCode, human_reason: humanReason,
                  });
                  return {
                    needs_owner_approval: true,
                    reason: reasonCode,
                    broken_rule: brokenRule ?? 'unknown',
                    broken_rule_label: humanReason,
                    meeting_subject: args.meeting_subject,
                    requested_start: newStart,
                    requested_end: newEnd,
                    message: humanReason === 'unknown'
                      ? `${askerName ?? 'They'} asked to move "${args.meeting_subject}" to that time, but it doesn't pass ${ownerFirst}'s scheduling rules and I can't tell which one. Call create_approval(kind=meeting_reschedule) and let him decide.`
                      : `${askerName ?? 'They'} asked to move "${args.meeting_subject}" to that time, but ${humanReason}. I can't do it on my own — call create_approval(kind=meeting_reschedule) and pass "${humanReason}" in ask_text so ${ownerFirst} knows what he's deciding.`,
                  };
                }
              }
            } catch (err) {
              logger.warn('move_meeting colleague-path rule check threw — escalating to approval', { err: String(err) });
              return {
                needs_owner_approval: true,
                reason: 'rule_check_failed',
                meeting_subject: args.meeting_subject,
                requested_start: newStart,
                requested_end: newEnd,
                message: `I couldn't verify whether that slot fits ${context.profile.user.name.split(' ')[0]}'s rules right now. Raise create_approval(kind=meeting_reschedule) so he can decide.`,
              };
            }
          }
        }

        // v2.1.4 — same attendee-only guard as update_meeting.
        // v2.7.0 — ownership check via findMeetingOwner (requests + Graph).
        // Per D4: when owner isn't organizer, refuse politely. No DM, no
        // propose-reschedule — just tell the asker it's not the owner's to move.
        try {
          const { findMeetingOwner } = await import('./findMeetingOwner');
          const ownerInfo = await findMeetingOwner({
            ownerUserId: context.profile.user.slack_user_id,
            ownerEmail: userEmail,
            eventId: args.meeting_id as string,
          });
          if (!ownerInfo.ownerIsOrganizer && ownerInfo.organizerEmail) {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            const orgName = ownerInfo.organizerName ?? ownerInfo.organizerEmail;
            logger.info('move_meeting refused — owner is attendee, not organizer', {
              meetingId: args.meeting_id, organizer: ownerInfo.organizerEmail,
            });
            return {
              error: 'not_organizer',
              meeting_subject: args.meeting_subject,
              organizer_name: orgName,
              organizer_email: ownerInfo.organizerEmail,
              message: `Can't move "${args.meeting_subject}" — ${orgName} organized that one, not ${ownerFirst}. The organizer is the only one who can shift the time. Want me to flag it to ${ownerFirst} so he can ping them, or skip?`,
            };
          }
        } catch (err) {
          logger.warn('move_meeting ownership lookup threw — proceeding', { err: String(err) });
        }

        // v1.8.8 — same series-master block as update_meeting. Moving a
        // seriesMaster would shift every occurrence in the series. Single
        // occurrence moves (type='occurrence' or 'exception') are allowed; Graph
        // creates an exception pinning just that date.
        // v3.1.8 — capture the meeting's OLD start so the success result can
        // report the VACATED slot (the time that just opened up). Lets a
        // follow-up "move X into the freed slot" resolve without Maelle
        // re-asking what time the moved meeting used to be at.
        let preMoveStartIso: string | undefined;
        try {
          const { getEventType } = await import('../../connectors/graph/calendar');
          const probe = await getEventType(userEmail, args.meeting_id as string);
          if (probe?.type === 'seriesMaster') {
            logger.info('move_meeting refused on recurring seriesMaster', {
              meetingId: args.meeting_id,
              subject: probe.subject,
            });
            return {
              error: 'recurring_series_master',
              meeting_subject: probe.subject,
              message: `"${probe.subject}" is a recurring series. Moving the series here would shift every occurrence — the owner should do series-level moves directly in the calendar. For a SINGLE occurrence, call move_meeting with that occurrence's meeting_id from get_calendar for that specific date; Graph will create an exception for that one.`,
            };
          }
          preMoveStartIso = probe?.startDateTime;
        } catch (err) {
          logger.warn('move_meeting recurring-preflight failed — proceeding', { err: String(err) });
        }

        // v2.3.1 (B1 / #61) — deterministic floating-block alignment. When the
        // meeting being moved is a floating block (lunch, coffee, etc.), don't
        // trust args.new_start verbatim — Sonnet keeps doing time math in
        // chat and getting it wrong (window check, buffer, alignment). Run
        // findAlignedSlotForBlock with args.new_start as a HINT to compute
        // the correct slot; if no in-window slot fits, refuse with a clear
        // pointer to policy_exception (deferred_action move_meeting). Owner-
        // directed moves no longer ask permission for in-window adjustments
        // — code computes the right answer once.
        // #135b — weekday/date sanity (shared with create_meeting). Refuse a move
        // whose resolved new_start weekday contradicts the weekday the owner named
        // ("return it to Thursday" that resolved to a Friday — the F2 wrong-day
        // write), handing back the corrected same-week date to retry with.
        {
          const wk = checkIntendedWeekday(args.new_start as string | undefined, args.intended_weekday as number | undefined, timezone);
          if (!wk.ok) {
            const namedName = DateTime.fromISO(wk.correctedStartIso, { zone: timezone }).toFormat('EEEE');
            const resolvedName = DateTime.fromISO(args.new_start as string, { zone: timezone }).toFormat('EEEE');
            const correctedDate = DateTime.fromISO(wk.correctedStartIso, { zone: timezone }).toFormat('yyyy-MM-dd');
            logger.warn('move_meeting — weekday/date mismatch, refusing wrong-day write', {
              namedWeekday: wk.namedWeekday, resolved: wk.resolvedDate, corrected: wk.correctedStartIso,
            });
            return {
              success: false,
              error: 'weekday_date_mismatch',
              meeting_subject: args.meeting_subject,
              corrected_start: wk.correctedStartIso,
              message: `new_start resolves to ${wk.resolvedDate} (a ${resolvedName}), but this was described as a ${namedName}. The ${namedName} of that week is ${correctedDate}. Re-issue move_meeting with new_start=${wk.correctedStartIso} (same time, corrected day). If a DIFFERENT week was actually meant, resolve the right ${namedName} from the date list and retry — never move to the mismatched day.`,
            };
          }
        }

        let effectiveStart = args.new_start as string;
        let effectiveEnd   = args.new_end   as string;
        // v3.x — grid-align an off-grid move target to the :00/:15/:30/:45 grid
        // unless the owner named the exact time. Floating blocks are realigned
        // by findAlignedSlotForBlock below, so this only affects the regular
        // (non-floating) move fall-through.
        if (!args.start_is_explicit && typeof effectiveStart === 'string') {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { alignNearestQuarter } = require('../../utils/floatingBlocks') as typeof import('../../utils/floatingBlocks');
          const sDt = DateTime.fromISO(effectiveStart, { zone: timezone });
          if (sDt.isValid) {
            const alignedMs = alignNearestQuarter(sDt.toMillis(), timezone);
            if (alignedMs !== sDt.toMillis()) {
              const delta = alignedMs - sDt.toMillis();
              effectiveStart = DateTime.fromMillis(alignedMs, { zone: timezone }).toISO() ?? effectiveStart;
              const eDt = DateTime.fromISO(effectiveEnd, { zone: timezone });
              if (eDt.isValid) effectiveEnd = DateTime.fromMillis(eDt.toMillis() + delta, { zone: timezone }).toISO() ?? effectiveEnd;
              logger.info('move_meeting — snapped off-grid start to quarter grid', { from: sDt.toISO(), to: effectiveStart });
            }
          }
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fb = require('../../utils/floatingBlocks') as typeof import('../../utils/floatingBlocks');
          const blocks = fb.getFloatingBlocks(context.profile);
          // Identify whether the meeting being moved is a floating block. We
          // need its current event to match against blocks. Cheap probe via
          // the day's events using args.new_start as the day target.
          const newStartDt = DateTime.fromISO(args.new_start as string, { zone: timezone });
          if (newStartDt.isValid) {
            const dayStr = newStartDt.toFormat('yyyy-MM-dd');
            const dayEvents = await getCalendarEvents(userEmail, dayStr, dayStr, timezone);
            const movingEvent = dayEvents.find(e => e.id === args.meeting_id);
            const matchedBlock = movingEvent ? blocks.find(b => fb.isFloatingBlockEvent(movingEvent, b)) : null;
            if (matchedBlock) {
              // v3.4.2 (E1) — preserve the MOVING EVENT's own duration. Pre-fix
              // a move re-derived the end from the block CONFIG (duration_minutes,
              // e.g. 25), so moving an owner-stretched 40-min lunch silently reset
              // it to 25. Read the event's actual span; fall back to config only
              // if the event's times don't parse. effectiveBlock carries it so the
              // placement search (findAlignedSlotForBlock) also sizes for the real
              // duration.
              const movingDurationMin = (() => {
                try {
                  const s = DateTime.fromISO(movingEvent!.start.dateTime, { zone: movingEvent!.start.timeZone ?? 'utc' });
                  const e = DateTime.fromISO(movingEvent!.end.dateTime, { zone: movingEvent!.end.timeZone ?? 'utc' });
                  if (s.isValid && e.isValid && e.toMillis() > s.toMillis()) {
                    return Math.round(e.diff(s, 'minutes').minutes);
                  }
                } catch { /* fall through to config */ }
                return matchedBlock.duration_minutes;
              })();
              const effectiveBlock = movingDurationMin !== matchedBlock.duration_minutes
                ? { ...matchedBlock, duration_minutes: movingDurationMin }
                : matchedBlock;
              // Build the busy-window list for findAlignedSlotForBlock.
              // Exclude the floating block itself (it's about to move).
              const wStart = fb.windowMsForDay(dayStr, matchedBlock.preferred_start, timezone);
              const wEnd   = fb.windowMsForDay(dayStr, matchedBlock.preferred_end,   timezone);
              const busy = dayEvents
                .filter(e => e.id !== args.meeting_id && !e.isCancelled && e.showAs !== 'free')
                .map(e => ({
                  start: DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' }).toMillis(),
                  end:   DateTime.fromISO(e.end.dateTime,   { zone: e.end.timeZone   ?? 'utc' }).toMillis(),
                }))
                .filter(b => b.end > wStart && b.start < wEnd)
                .map(b => ({ start: Math.max(b.start, wStart), end: Math.min(b.end, wEnd) }));
              // v3.0.2 — floating-block math is buffer-free; meeting durations carry the spacing.

              // v2.3.2 (3A) — owner-explicit hint respects target as-is. Don't
              // snap to a different slot, don't refuse on conflict. Out-of-window
              // is NOT refused either: owner override is total and one-step
              // (rules 1, 6, 11) — moving his own lunch to 16:00 is his call, so
              // we move it and add a heads-up rather than bouncing for a
              // confirm_outside_window re-ask.
              const isOwnerPath = context.senderRole === 'owner' || context.isOwnerInGroup === true;
              if (isOwnerPath) {
                // v3.1.8 (D5) — snap the hint to the quarter grid. The general
                // snap above is bypassed on the floating-block path because this
                // branch overwrites effectiveStart with the raw hint, so a "right
                // after" landing at :40 would book lunch at :40 instead of the
                // owner's quarter convention (:45). Redo the snap here; honor an
                // exact owner-given time (start_is_explicit) as-is.
                const alignedMs = args.start_is_explicit
                  ? newStartDt.toMillis()
                  : fb.alignNearestQuarter(newStartDt.toMillis(), timezone);
                const hintStartDt = DateTime.fromMillis(alignedMs, { zone: timezone });
                const hintStartMs = hintStartDt.toMillis();
                const hintEndMs = hintStartMs + movingDurationMin * 60 * 1000;
                const inWindow = hintStartMs >= wStart && hintEndMs <= wEnd;
                effectiveStart = hintStartDt.toISO()!;
                effectiveEnd = hintStartDt
                  .plus({ minutes: movingDurationMin })
                  .toISO()!;
                logger.info(inWindow
                  ? 'move_meeting (owner) — floating block in-window, using hint as-is'
                  : 'move_meeting (owner) — floating block out-of-window, one-step owner override', {
                  meetingId: args.meeting_id, block: matchedBlock.name, hint: args.new_start,
                  window: `${matchedBlock.preferred_start}-${matchedBlock.preferred_end}`,
                  outOfWindow: !inWindow,
                });
                const windowNote = inWindow
                  ? ''
                  : ` (outside its usual ${matchedBlock.preferred_start}–${matchedBlock.preferred_end} window — moved as asked).`;
                // Skip the colleague-path findAlignedSlotForBlock branch below.
                return await updateMeeting({
                  userEmail, timezone,
                  meetingId: args.meeting_id as string,
                  start: effectiveStart, end: effectiveEnd,
                }).then(async () => {
                  await closeMeetingArtifacts({
                    ownerUserId: context.profile.user.slack_user_id,
                    meetingId: args.meeting_id as string,
                    reason: 'moved',
                    subject: args.meeting_subject as string | undefined,
                    bookingThreadTs: context.threadTs,
                    fulfillingRequestId: args._fulfilling_request_id as string | undefined,
                  });
                  // v3.2.1 (#120 / 120b) — return the vacated slot here too. The
                  // floating-block move (e.g. lunch) is exactly the case where
                  // the owner moves a block to FREE its slot for another meeting;
                  // without this the freed-slot info was dropped.
                  const vacated = computeVacatedSlot(preMoveStartIso, effectiveStart, effectiveEnd, timezone);
                  return {
                    success: true,
                    action_summary: `Moved ${matchedBlock.name} to ${formatIsoTime(effectiveStart)}.${windowNote}`,
                    // #1.5 — surface the POST-snap booked instant on the floating-block
                    // owner-move path too (lunch is the canonical case). Without it
                    // mutationActions falls back to the pre-snap input arg and the reply
                    // narrates a time the block never landed on (the 11:10-vs-11:15 bug).
                    booked_start: effectiveStart,
                    booked_end: effectiveEnd,
                    ...(vacated ? { vacated } : {}),
                  };
                });
              }

              // Colleague-path — keep existing alignment + conflict guard.
              const alignedMs = fb.findAlignedSlotForBlock(effectiveBlock, dayStr, timezone, busy);
              if (alignedMs === null) {
                logger.info('move_meeting refused — no in-window slot for floating block', {
                  meetingId: args.meeting_id, block: matchedBlock.name, hint: args.new_start,
                });
                return {
                  success: false,
                  error: 'no_in_window_slot',
                  message: `No room in the ${matchedBlock.preferred_start}–${matchedBlock.preferred_end} window for ${matchedBlock.name} after that hint. To move it OUTSIDE the window, raise create_approval(kind='policy_exception') with deferred_action={ tool: 'move_meeting', args: { meeting_id, new_start, confirm_outside_window: true } }.`,
                };
              }
              const alignedDt = DateTime.fromMillis(alignedMs).setZone(timezone);
              const alignedEndDt = alignedDt.plus({ minutes: movingDurationMin });
              const alignedStartIso = alignedDt.toISO()!;
              const alignedEndIso   = alignedEndDt.toISO()!;
              if (alignedStartIso !== effectiveStart) {
                logger.info('move_meeting — floating block snapped to aligned slot', {
                  meetingId: args.meeting_id, block: matchedBlock.name,
                  hint: args.new_start, snapped: alignedStartIso,
                });
              }
              effectiveStart = alignedStartIso;
              effectiveEnd   = alignedEndIso;
            }
          }
        } catch (err) {
          logger.warn('move_meeting floating-block alignment threw — proceeding with caller args', {
            err: String(err).slice(0, 200),
          });
        }

        // v2.7.0 — route the move through planMeeting so location + category
        // re-resolve when the day-type flips (office↔home). Per Q2: only
        // re-detect category when location-relevant attributes change; same-
        // day-type moves keep the existing category. resolveLocation always
        // runs so the Graph PATCH can update location + isOnline.
        let movePlanLocation: string | undefined;
        let movePlanIsOnline: boolean | undefined;
        let movePlanCategories: string[] | undefined;
        let movePlanPreserveExisting = false;
        try {
          const { planMeeting: planMove } = await import('./planMeeting');
          // Pull existing event metadata (categories, current location) for
          // the priorSlotStartIso + existingEventCategories inputs.
          const existing = await getCalendarEvents(
            userEmail,
            DateTime.fromISO(effectiveStart, { zone: timezone }).minus({ days: 1 }).toFormat('yyyy-MM-dd'),
            DateTime.fromISO(effectiveStart, { zone: timezone }).plus({ days: 1 }).toFormat('yyyy-MM-dd'),
            timezone,
          );
          const movingEvent = existing.find(e => e.id === args.meeting_id);
          const priorStartIso = movingEvent?.start?.dateTime;
          // v2.8.5 — also extract prior END so planMeeting's freebusy overlap
          // check can exclude the source event when an attendee's calendar still
          // shows it. Otherwise a move like 13:00→13:15 trips confirm_override
          // because the attendee looks busy at 13:15 (with the very meeting being moved).
          const priorEndIso = movingEvent?.end?.dateTime;
          const existingCats = ((movingEvent as any)?.categories as string[] | undefined) ?? [];
          const existingLocation = (movingEvent as any)?.location?.displayName as string | undefined;
          const existingIsOnline = (movingEvent as any)?.isOnlineMeeting as boolean | undefined;
          const movePlan = await planMove({
            profile: context.profile,
            intent: 'move',
            initiator: context.senderRole === 'colleague' ? 'colleague' : 'owner',
            initiatorSlackId: context.userId,
            slotStartIso: effectiveStart,
            slotEndIso: effectiveEnd,
            subject: (movingEvent?.subject ?? args.meeting_subject) as string | undefined,
            participants: ((movingEvent?.attendees ?? []) as any[]).map(a => ({
              email: a?.emailAddress?.address,
              name: a?.emailAddress?.name,
            })),
            existingEventId: args.meeting_id as string,
            existingEventCategories: existingCats,
            existingEventLocation: existingLocation,
            existingEventIsOnline: existingIsOnline,
            priorSlotStartIso: priorStartIso,
            priorSlotEndIso: priorEndIso,
            // v2.8.2 — owner-explicit hints flow through on move too. Without
            // these, an owner-explicit "move it to 3pm in person" loses the
            // physical signal and resolveLocation defaults to day-type rules.
            locationHint: args.location as string | undefined,
            isOnlineHint: typeof args.is_online === 'boolean' ? args.is_online : undefined,
            allowRelaxed: args.relaxed === true,
            weAcknowledged: args.we_acknowledged === true,
          });
          logger.info('move_meeting — planMeeting verdict', {
            action: movePlan.action, meetingId: args.meeting_id,
            priorStart: priorStartIso, newStart: effectiveStart,
            reasoning: 'reasoning' in movePlan ? movePlan.reasoning : undefined,
          });
          // v3.2.x (#8) — colleague reschedule onto a soft-rule-breaking slot:
          // offer nearby rule-compliant alternatives before escalating.
          if (movePlan.action === 'propose_alternative') {
            return {
              success: false,
              error: 'soft_rule_offer_alternatives',
              meeting_subject: args.meeting_subject,
              violation_label: movePlan.violationLabel,
              alternatives: movePlan.alternatives,
              suggested_ask_text: movePlan.suggestedAskText,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: 'The requested new time breaks one of the owner\'s soft rules. Do NOT escalate yet. Offer these nearby rule-compliant slots (2 on the requested day + 1 after) and ask if one works. If the colleague INSISTS on the original time, or none of these work, THEN call create_approval(kind=policy_exception) with suggested_ask_text so the owner decides.',
            };
          }
          if (movePlan.action === 'confirm_override' || movePlan.action === 'escalate_approval') {
            return {
              success: false,
              error: 'rule_violation',
              meeting_subject: args.meeting_subject,
              violation_label: movePlan.violationLabel,
              suggested_ask_text: movePlan.suggestedAskText,
              category: movePlan.category,
              // v2.7.2 — deferred_action_hint for resolver replay on approve.
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: movePlan.action === 'escalate_approval'
                ? 'Move violates a scheduling rule. Use create_approval(kind=policy_exception) with suggested_ask_text.'
                // v3.2.1 (#120a — one mechanism) — owner-path soft-rule override
                // flows through the SAME persisted approval path as the colleague
                // escalate, instead of the fragile "ask, then re-issue relaxed
                // next turn" path (Sonnet can drop that re-issue → the meeting
                // silently never moves). If the owner ALREADY authorized the
                // override in THIS message, retry move_meeting now with
                // relaxed=true. OTHERWISE call
                // create_approval(kind=policy_exception) — the orchestrator
                // stamps the deferred move, so the override PERSISTS and the
                // owner's later "yes" replays it deterministically.
                : 'Move violates a soft scheduling rule. If the owner ALREADY authorized overriding it in THIS message (e.g. "do it anyway", "I\'ll handle the conflict"), retry move_meeting now with relaxed=true. Otherwise call create_approval(kind=policy_exception) with suggested_ask_text — this PERSISTS the override (the orchestrator stamps the deferred move) so the owner\'s later "yes" replays it on its own. Do NOT ask and then rely on re-issuing the move yourself next turn — that pending action gets lost.',
            };
          }
          // v2.8.2 — ask_location_mode on move (rare — external attendee,
          // same/unknown TZ, and the move flips into office day). Refuse +
          // surface the ask.
          if (movePlan.action === 'ask_location_mode') {
            return {
              success: false,
              error: 'location_mode_unspecified',
              meeting_subject: args.meeting_subject,
              suggested_ask_text: movePlan.suggestedAskText,
              category: movePlan.category,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: 'Move lands on an office day with external attendee in same/unknown timezone. Ask the owner online vs physical, then re-call move_meeting with either is_online=true or location=<full office address>.',
            };
          }
          // v2.8.2 — meeting room busy + ≥6 people on the move target slot.
          if (movePlan.action === 'room_unavailable_large') {
            return {
              success: false,
              error: 'meeting_room_unavailable_large_meeting',
              meeting_subject: args.meeting_subject,
              suggested_ask_text: movePlan.suggestedAskText,
              category: movePlan.category,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: 'Move target time has the Meeting Room taken and the group is too large for the small-room fallback. Ask the owner whether to push the time, trim attendees, or pick another day.',
            };
          }
          if (movePlan.action === 'book') {
            movePlanPreserveExisting = movePlan.preserveExisting === true;
            // (v2.8.2) preserveExisting: leave location/isOnline undefined so the
            // Graph PATCH doesn't touch them. Re-stamping the BiWeekly's "Huddle"
            // with the office address on every move is exactly what we're killing.
            if (!movePlanPreserveExisting) {
              movePlanLocation = movePlan.location;
              movePlanIsOnline = movePlan.isOnline;
            }
            if (movePlan.category) {
              // Preserve any non-yaml-category labels already on the event
              // (rare but possible), then add the canonical category once.
              const profileCatNames = new Set((context.profile.categories ?? []).map(c => c.name.toLowerCase()));
              const preserved = existingCats.filter(c => !profileCatNames.has(c.toLowerCase()));
              movePlanCategories = [...preserved, movePlan.category];
            }
          }
        } catch (err) {
          logger.warn('move_meeting — planMeeting threw, proceeding with time-only move', {
            err: String(err).slice(0, 200), meetingId: args.meeting_id,
          });
        }

        // #30 — hold-conflict gate on MOVE (mirror of the create gate). Never
        // move a meeting onto a slot tentatively held for SOMEONE ELSE. Owner →
        // confirm once (override_hold:true on retry → move + release + DM holder).
        // Colleague → route to the owner's approval. The mover's OWN hold proceeds.
        {
          const { getActiveHoldOverlapping } = await import('../../db/slotHolds');
          const conflictHold = getActiveHoldOverlapping(
            context.profile.user.slack_user_id, effectiveStart, effectiveEnd,
          );
          if (conflictHold && conflictHold.holder_slack_id !== context.userId) {
            if (context.senderRole === 'owner') {
              if (args.override_hold !== true) {
                return {
                  success: false,
                  error: 'slot_on_hold',
                  meeting_subject: args.meeting_subject,
                  hold_id: conflictHold.id,
                  holder_name: conflictHold.holder_name,
                  message: `${conflictHold.holder_name} asked to reserve ${formatIsoTime(effectiveStart)}${conflictHold.reason ? ` (${conflictHold.reason})` : ''}. Move "${args.meeting_subject}" over it anyway? On your yes I'll move it and let ${conflictHold.holder_name} know the hold was released.`,
                  _deferred_action_hint: { tool: 'move_meeting', args: { ...args, override_hold: true } },
                  _note: 'Surface to the owner. If he says move it anyway, retry move_meeting with override_hold:true — that moves it, releases the hold, and DMs the holder.',
                };
              }
              // owner + override_hold:true → fall through and move; release fires on success.
            } else {
              return {
                success: false,
                error: 'slot_held_needs_owner_approval',
                meeting_subject: args.meeting_subject,
                hold_id: conflictHold.id,
                message: `That time is tentatively held for someone else — don't move it there, and don't reveal who holds it. Raise create_approval(kind=policy_exception) with this slot so ${context.profile.user.name.split(' ')[0]} decides; tell the colleague warmly you're checking.`,
              };
            }
          }
        }

        await updateMeeting({
          userEmail,
          timezone,
          meetingId: args.meeting_id as string,
          start: effectiveStart,
          end: effectiveEnd,
          // v2.7.0 — pass-through location/isOnline/categories from the
          // planMeeting verdict. Undefined values leave the existing fields
          // untouched on Graph's side. v2.8.2 — preserveExisting keeps both
          // undefined so a move within the same day-type doesn't overwrite owner
          // conventions like "Huddle".
          location: movePlanLocation,
          isOnline: movePlanIsOnline,
          categories: movePlanCategories,
        });

        // v3.6.x — the post-move Teams-URL-as-location patch was REMOVED (same
        // root as the create path): overwriting the online meeting's location with
        // the raw joinUrl broke Outlook's native Teams rendering. isOnlineMeeting
        // stays true through the move, so Graph keeps the toggle / Join button /
        // "Microsoft Teams Meeting" label — nothing to stamp.

        // v2.2.5 (#54) — post-move verification. Graph PATCH can return 200 OK
        // without the change landing (sync delays, race conditions). Re-read
        // the event by id and confirm the start matches the requested move
        // target. Fail-fast: if verify fails, skip the closeMeetingArtifacts
        // cascade, audit success log, shadow notify, and rebalance — none of
        // those should fire on a move that didn't actually happen.
        {
          const { verifyEventMoved } = await import('../../connectors/graph/calendar');
          // v2.3.1 (B1) — verify against the EFFECTIVE start (post-snap for
          // floating blocks), not the original args.new_start hint.
          const verify = await verifyEventMoved(userEmail, args.meeting_id as string, effectiveStart, timezone);
          if (!verify.ok) {
            logger.warn('move_meeting verify failed — Graph accepted PATCH but readback drifted', {
              meetingId: args.meeting_id, reason: verify.reason,
              expected: 'expected' in verify ? verify.expected : undefined,
              got: 'got' in verify ? verify.got : undefined,
            });
            const subject = args.meeting_subject as string;
            const message = verify.reason === 'not_found'
              ? `I tried to move '${subject}' but couldn't find it on the calendar afterward — the move may not have landed. Want me to investigate?`
              : `I tried to move '${subject}' to ${verify.expected} but the calendar still shows it at ${verify.got}. Graph accepted the change but didn't apply it — want me to retry?`;
            return {
              success: false,
              error: verify.reason === 'not_found' ? 'moved_but_missing' : 'move_did_not_land',
              message,
            };
          }
        }

        await closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'moved',
          subject: args.meeting_subject as string | undefined,
          bookingThreadTs: context.threadTs,
          fulfillingRequestId: args._fulfilling_request_id as string | undefined,
        });
        // #30 — the move landed on this slot, so release any hold overlapping it
        // (overlap, not exact-start: a move target may not begin exactly at the
        // held slot). If held by someone ELSE (owner moved over it via
        // override_hold), DM that holder; the mover's own hold releases silently.
        try {
          const sh = await import('../../db/slotHolds');
          const overlapHold = sh.getActiveHoldOverlapping(
            context.profile.user.slack_user_id, effectiveStart, effectiveEnd,
          );
          if (overlapHold) {
            sh.releaseSlotHold(overlapHold.id, 'slot_taken_by_move');
            if (overlapHold.holder_slack_id && overlapHold.holder_slack_id !== context.userId) {
              try {
                const { getConnection } = await import('../../connections/registry');
                const conn = getConnection(context.profile.user.slack_user_id, 'slack');
                if (conn) {
                  await conn.sendDirect(
                    overlapHold.holder_slack_id,
                    `Quick heads up — ${context.profile.user.name.split(' ')[0]} ended up taking ${formatIsoTime(effectiveStart)}, so I've released the hold I had for you there. Happy to find you another time whenever.`,
                    overlapHold.origin_thread_ts ? { threadTs: overlapHold.origin_thread_ts } : undefined,
                  );
                }
              } catch (dmErr) {
                logger.warn('move_meeting — hold-release DM failed (hold already released)', { err: String(dmErr).slice(0, 150) });
              }
            }
          }
        } catch (err) {
          logger.warn('move_meeting — slot-hold release threw, continuing', { err: String(err).slice(0, 150) });
        }
        auditLog({
          action: 'move_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          details: { subject: args.meeting_subject, new_start: args.new_start, new_end: args.new_end },
          outcome: 'success',
        });

        // v2.2.1 — colleague-path inbound reschedule: shadow-DM the owner so he
        // sees the move happen even when he wasn't in the approval loop.
        // v2.3.2 — threaded under the colleague conversation key so all
        // shadows from this thread group together in the owner's DM.
        // Skip the OWNER clamped to colleague-context in an MPIM/channel — he
        // moved it himself and was present; no self-shadow.
        if (context.senderRole === 'colleague' && context.userId !== context.profile.user.slack_user_id) {
          try {
            const { shadowNotify } = await import('../../utils/shadowNotify');
            const { getPersonMemory } = await import('../../db');
            const requesterRow = getPersonMemory(context.userId);
            const requesterName = requesterRow?.name ?? 'a colleague';
            const whenLocal = DateTime.fromISO(args.new_start as string, { zone: timezone });
            const whenLabel = whenLocal.isValid
              ? whenLocal.toFormat('EEE d MMM HH:mm')
              : formatIsoTime(args.new_start as string);
            await shadowNotify(context.profile, {
              channel: context.channelId,
              threadTs: context.threadTs,
              action: 'Reschedule auto-accepted',
              detail: `${requesterName} asked to move "${args.meeting_subject}" — rule-compliant, moved to ${whenLabel}.`,
              conversationKey: context.threadTs,
              conversationHeader: `Conversation with ${requesterName}`,
            });
          } catch (err) {
            logger.warn('shadowNotify after colleague reschedule failed — continuing', { err: String(err) });
          }
        }

        // v2.2.3 (scenario 8 row 7) — post-mutation floating-block rebalance.
        // The new meeting time may have landed on top of lunch (or any
        // configured floating block). Try to slide the block elsewhere in its
        // window. If no in-window slot fits, leave it overlapping and ping
        // the owner (the bumping-out-of-window decision still belongs to him,
        // via the policy_exception approval flow).
        // v3.1.8 — the VACATED slot (where the meeting WAS) lets a follow-up
        // "move X into the freed slot" resolve from this turn instead of Maelle
        // re-asking the old time. v3.2.1 — shared helper (see top of file); the
        // floating-block early return uses the same one. Computed BEFORE the
        // rebalance so it can gate reclaim detection to the slot this move
        // actually freed.
        const vacated = computeVacatedSlot(preMoveStartIso, args.new_start as string, args.new_end as string, timezone);

        // v3.2.x (Tier 1) — capture the rebalance return so a displaced
        // floating block whose window this move just freed can be OFFERED back
        // (reclaimable_block), same propose-only pattern as `vacated`. The freed
        // range (the meeting's OLD slot) gates the offer to a relevant move.
        let reclaimable: import('../../utils/rebalanceFloatingBlocks').ReclaimableBlock[] = [];
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { rebalanceFloatingBlocksAfterMutation } = require('../../utils/rebalanceFloatingBlocks') as
            typeof import('../../utils/rebalanceFloatingBlocks');
          const rebal = await rebalanceFloatingBlocksAfterMutation({
            profile: context.profile,
            affectedSlotIso: effectiveStart,
            ownerSlackId: context.profile.user.slack_user_id,
            ...(vacated ? { freedRangeIso: { start: vacated.start, end: vacated.end } } : {}),
          });
          reclaimable = rebal?.reclaimable ?? [];
        } catch (err) {
          logger.warn('rebalance after move_meeting threw — continuing', { err: String(err).slice(0, 200) });
        }

        return {
          success: true,
          moved: args.meeting_subject,
          // #1.5 — the ACTUAL booked time (after the grid-snap at :4156), not the
          // pre-snap arg. So narration AND the orchestrator's mutationActions
          // (→ dateVerifier + #135 honesty backstop) reflect where it truly landed.
          new_start: effectiveStart,
          new_end: effectiveEnd,
          booked_start: effectiveStart,
          booked_end: effectiveEnd,
          // v3.1.8 — the slot that just opened up (old time of the moved meeting).
          ...(vacated ? { vacated } : {}),
          // v3.2.x — a displaced floating block this move could bring home.
          // PROPOSE-ONLY: surface it; the reply offers ("…frees 12:30 — want
          // lunch back there?"). Not auto-moved (may be owner-pinned).
          ...(reclaimable.length ? { reclaimable_block: reclaimable[0] } : {}),
          // v1.8.3 — past-tense summary the reply quotes verbatim. Issue #26 bug 1:
          // without this, Sonnet could re-read the calendar post-move and narrate
          // the new time as a fresh discovery ("already at 12:30, nothing to change")
          // instead of acknowledging her own action.
          action_summary: `Moved '${args.meeting_subject}' to ${renderWeDualClock(effectiveStart, { isAway: !!moveTripDisplay, effectiveTz: moveTripDisplay?.tz ?? timezone, location: moveTripDisplay?.location ?? '' }, timezone, { endIso: effectiveEnd })}.`,
          ...(moveTripDisplay ? { _trip_note: 'Travel day — state the moved time from `action_summary` VERBATIM (both clocks, correctly labelled); do not recompute it.' } : {}),
        };
      }

      case 'delete_meeting': {
        // Defense-in-depth: refuse a series-level delete if the id resolves
        // to a seriesMaster. Mirrors the guard in update_meeting and
        // move_meeting. get_calendar normally returns occurrence ids
        // (Graph calendarView expands recurring series), so a master id
        // should never reach here through the normal path — but if it
        // ever does, a one-shot mistake would wipe an entire recurring
        // series. This probe runs BEFORE the planMeeting / decline_and_relay
        // path so a series-master refusal doesn't first fire an organizer
        // DM saying "won't make it" for a meeting that ends up untouched.
        // Also captures the event's start date so the success audit_log
        // entry can record WHICH DAY was deleted (active-mode's
        // missing_floating_block branch reads this).
        let preDeleteStartIso: string | undefined;
        let preDeleteSubject: string | undefined;
        try {
          const { getEventType } = await import('../../connectors/graph/calendar');
          const probe = await getEventType(userEmail, args.meeting_id as string);
          if (probe?.type === 'seriesMaster') {
            logger.info('delete_meeting refused on recurring seriesMaster', {
              meetingId: args.meeting_id,
              subject: probe.subject,
            });
            return {
              error: 'recurring_series_master',
              meeting_subject: probe.subject,
              message: `"${probe.subject}" is a recurring series. Deleting the series here would cancel every occurrence — that's not safe to do automatically. To cancel a single occurrence, call delete_meeting with that occurrence's meeting_id (get it from get_calendar for the specific date). To end the series itself, the owner should do that directly in Outlook.`,
            };
          }
          preDeleteStartIso = probe?.startDateTime;
          preDeleteSubject = probe?.subject;
        } catch (err) {
          logger.warn('delete_meeting recurring-preflight failed — proceeding', { err: String(err) });
        }

        // Track auto-relay outcome so Sonnet narrates honestly:
        //   'sent'                  → DM went out to the organizer (Slack)
        //   'skipped_no_slack_id'   → organizer is external / not in workspace;
        //                              owner-side decline still landed but the
        //                              organizer was NOT notified
        //   'not_attempted'         → owner is the organizer (no relay needed)
        let relayStatus: 'sent' | 'skipped_no_slack_id' | 'not_attempted' = 'not_attempted';
        let relayOrganizerName: string | null = null;
        let relayOrganizerEmail: string | null = null;
        // Ownership-aware delete via planMeeting.
        // Path tree (per D3 / Q1=B / D4):
        //   - owner is organizer → proceed with delete (existing flow below)
        //   - owner is attendee + asker is the requester/organizer → decline on
        //     owner's side (effectively the same Graph delete call from owner's
        //     calendar — Graph drops the event from his view)
        //   - owner is attendee + asker is someone ELSE (incl. owner himself) →
        //     decline on owner's side + auto-DM the organizer politely
        try {
          const { planMeeting, planInputFromBookingRequest } = await import('./planMeeting');
          const { normalizeBookingRequest } = await import('./bookingRequest');
          // v2.9.0 — normalized BookingRequest for the cancel path. Owner-
          // in-participants invariant lets findMeetingOwner / decline-and-
          // relay branch reason over a uniform shape. The cancel intent
          // doesn't carry a slot or other attendees by default — the
          // normalizer + planMeeting handle the absent fields gracefully.
          const cancelReq = await normalizeBookingRequest('delete_meeting', args, context, { intent: 'cancel' });
          // Carry the subject through for narration (delete_meeting passes
          // meeting_subject, not subject — normalizer doesn't auto-fetch it).
          if (!cancelReq.subject && typeof args.meeting_subject === 'string') {
            cancelReq.subject = args.meeting_subject;
          }
          const decision = await planMeeting(planInputFromBookingRequest(cancelReq, context.profile));
          if (decision.action === 'refuse_not_owners') {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            const orgName = decision.organizerName ?? decision.organizerEmail ?? 'the organizer';
            return {
              error: 'not_organizer_refuse',
              meeting_subject: args.meeting_subject,
              organizer_name: decision.organizerName,
              organizer_email: decision.organizerEmail,
              message: `Can't cancel "${args.meeting_subject}" — ${orgName} organized that one. Only the organizer can cancel for everyone. I can remove it from ${ownerFirst}'s calendar though if that helps.`,
            };
          }
          if (decision.action === 'decline_and_relay') {
            // Proceed with the Graph delete (which removes from owner's calendar)
            // AND post the organizer-DM in parallel (fire-and-forget). Track
            // whether the DM was actually attempted so the tool result tells
            // Sonnet the honest story — no over-claiming "I notified the
            // organizer" when the organizer has no slack_id (external).
            const orgEmail = decision.organizerEmail;
            const orgSlackId = decision.organizerSlackId;
            const orgName = decision.organizerName;
            const dmText = decision.suggestedDmText;
            logger.info('delete_meeting — decline_and_relay path', {
              meetingId: args.meeting_id, organizer: orgEmail, orgSlackId,
            });
            if (orgSlackId) {
              relayStatus = 'sent';
              relayOrganizerName = orgName;
              setImmediate(async () => {
                try {
                  const { getConnection } = await import('../../connections/registry');
                  const conn = getConnection(context.profile.user.slack_user_id, 'slack');
                  if (conn) await conn.sendDirect(orgSlackId, dmText);
                } catch (err) {
                  logger.warn('decline_and_relay DM threw — non-fatal', {
                    err: String(err).slice(0, 200), meetingId: args.meeting_id,
                  });
                }
              });
            } else {
              // External organizer or unresolved Slack identity — no DM can be
              // sent on Slack. Sonnet must NOT claim "I notified the organizer".
              relayStatus = 'skipped_no_slack_id';
              relayOrganizerName = orgName;
              relayOrganizerEmail = orgEmail;
            }
          }
        } catch (err) {
          logger.warn('delete_meeting planMeeting threw — proceeding with raw delete', {
            err: String(err).slice(0, 200), meetingId: args.meeting_id,
          });
        }

        await deleteMeeting(userEmail, args.meeting_id as string);
        // v2.1.6 — verify the delete actually landed. Graph can return 200 OK
        // on the DELETE but still retain the event (rare: partial failures,
        // recurring-series exception edge cases). Without this check the LLM
        // would claim "cancelled" even when the event was still on the
        // calendar, and then blame "sync delay" when the owner pointed it
        // out. Now the tool returns the truth and the LLM narrates that.
        const confirmedGone = await verifyEventDeleted(userEmail, args.meeting_id as string);
        if (!confirmedGone) {
          auditLog({
            action: 'delete_meeting',
            source: context.channel,
            actor: context.userId,
            target: args.meeting_id as string,
            details: { subject: args.meeting_subject, reason: 'still_present_after_delete' },
            outcome: 'failure',
          });
          return {
            success: false,
            error: 'still_present_after_delete',
            subject: args.meeting_subject,
            message: `Delete call returned success but "${args.meeting_subject}" is still on the calendar. Tell the owner honestly — don't claim it's deleted.`,
          };
        }
        await closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'deleted',
          subject: args.meeting_subject as string | undefined,
          bookingThreadTs: context.threadTs,
          fulfillingRequestId: args._fulfilling_request_id as string | undefined,
        });
        // v3.1.7 / #119 — if the deleted event was a floating block (lunch,
        // etc.), record a date-scoped dismissal so active-mode health doesn't
        // re-book the gap the owner just cleared. Keyed to the exact day via the
        // synthetic event_id, so only THIS day is suppressed — future
        // same-weekday blocks still get placed. Subject-only match (categories
        // aren't captured pre-delete). Non-fatal on any failure.
        try {
          const delStartIso = preDeleteStartIso;
          const delSubject = (args.meeting_subject ?? preDeleteSubject ?? '') as string;
          if (delStartIso && delSubject) {
            const fbMod = require('../../utils/floatingBlocks') as typeof import('../../utils/floatingBlocks');
            const matchedBlock = fbMod.getFloatingBlocks(context.profile)
              .find(b => fbMod.isFloatingBlockEvent({ subject: delSubject }, b));
            if (matchedBlock) {
              const synth = fbMod.floatingBlockSyntheticEventId(
                context.profile, matchedBlock.name, delStartIso.slice(0, 10), context.profile.user.timezone,
              );
              if (synth) {
                dismissFloatingBlockGap({
                  ownerUserId: context.profile.user.slack_user_id,
                  eventId: synth.eventId,
                  eventDate: delStartIso.slice(0, 10),
                  eventEndMs: synth.eventEndMs,
                  notes: `Owner deleted ${matchedBlock.name} on ${delStartIso.slice(0, 10)} — gap waived (won't re-book).`,
                });
                logger.info('delete_meeting — floating-block gap dismissed', {
                  block: matchedBlock.name, date: delStartIso.slice(0, 10), syntheticEventId: synth.eventId,
                });
              }
            }
          }
        } catch (err) {
          logger.warn('delete_meeting: floating-block dismissal write failed — non-fatal', {
            err: String(err).slice(0, 200),
          });
        }
        auditLog({
          action: 'delete_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          // v2.8.5 — `event_start_iso` lets active-mode's
          // missing_floating_block branch read recent deletions and skip
          // re-booking on a day the owner just cleared. `subject` falls back
          // to the Graph probe when Sonnet didn't pass meeting_subject (the
          // probe runs on the same id, so the names match).
          details: {
            subject: args.meeting_subject ?? preDeleteSubject,
            event_start_iso: preDeleteStartIso,
          },
          outcome: 'success',
        });

        // v3.2.x (Tier 1) — a delete frees the deleted event's slot, which may
        // open a displaced floating block's window. Run the same post-mutation
        // rebalance (move_meeting/create_meeting already do) and surface any
        // reclaim candidate as a PROPOSE-ONLY offer. Guarded on preDeleteStartIso
        // (the freed slot); skipped if the pre-delete probe didn't capture it.
        let reclaimable: import('../../utils/rebalanceFloatingBlocks').ReclaimableBlock[] = [];
        if (preDeleteStartIso) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { rebalanceFloatingBlocksAfterMutation } = require('../../utils/rebalanceFloatingBlocks') as
              typeof import('../../utils/rebalanceFloatingBlocks');
            const rebal = await rebalanceFloatingBlocksAfterMutation({
              profile: context.profile,
              affectedSlotIso: preDeleteStartIso,
              ownerSlackId: context.profile.user.slack_user_id,
            });
            reclaimable = rebal?.reclaimable ?? [];
          } catch (err) {
            logger.warn('rebalance after delete_meeting threw — continuing', { err: String(err).slice(0, 200) });
          }
        }

        // v2.7.0 — narrate the relay outcome honestly. Three shapes:
        //   sent                 → "Removed it from your side. I let <name> know."
        //   skipped_no_slack_id  → "Removed it from your side. <name> organized this one
        //                          but they're not in Slack so I couldn't ping them — you
        //                          may want to email them directly."
        //   not_attempted        → "Cancelled it." (owner was organizer; no relay needed)
        let actionSummary = `Cancelled '${args.meeting_subject}'.`;
        if (relayStatus === 'sent') {
          actionSummary = `Removed '${args.meeting_subject}' from your calendar. I let ${relayOrganizerName ?? 'the organizer'} know on Slack.`;
        } else if (relayStatus === 'skipped_no_slack_id') {
          actionSummary = `Removed '${args.meeting_subject}' from your calendar. ${relayOrganizerName ?? 'The organizer'} set it up${relayOrganizerEmail ? ` (${relayOrganizerEmail})` : ''} but they're not in Slack — you may want to email them directly to cancel for everyone.`;
        }
        return {
          success: true,
          deleted: args.meeting_subject,
          // v3.x — surface the deleted event's start so the reply can name the
          // day+time FROM the tool result (DELETE-MEETING PROTOCOL step 6),
          // instead of from lossy chat memory. Captured pre-delete at the probe.
          deleted_start_iso: preDeleteStartIso,
          relay_status: relayStatus,
          organizer_name: relayOrganizerName ?? undefined,
          organizer_email: relayOrganizerEmail ?? undefined,
          // v3.2.x — a displaced floating block whose window this delete freed.
          // PROPOSE-ONLY: the reply offers to bring it home; not auto-moved.
          ...(reclaimable.length ? { reclaimable_block: reclaimable[0] } : {}),
          action_summary: actionSummary,
          _note: relayStatus === 'skipped_no_slack_id'
            ? 'IMPORTANT: do NOT claim "I notified the organizer" — the organizer has no Slack account, no DM was sent. Tell the owner that explicitly and offer to draft an email if they want.'
            : undefined,
        };
      }

      // v2.0.7 — legacy escalate_to_user / store_request / get_pending_requests /
      // resolve_request cases retired. See tool-declaration comment above.

      default:
        return null; // not our tool
    }
  }

}
