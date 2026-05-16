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

// v1.8.3 — extract "HH:MM" from an ISO datetime string for action_summary formatting.
// Falls back to the raw string if the shape is unexpected.
function formatIsoTime(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
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
  const hhmmToMinutes = (s: string): number => {
    const [h, m] = s.split(':').map(n => parseInt(n, 10));
    return (h * 60) + m;
  };
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
    // hhmmToMinutes still referenced by other paths — keep the function defined.
    void hhmmToMinutes;
  }
  return blocks;
}
// Local alias for the profile type without adding another import — re-use the
// one imported below. Ts hoists type-only imports so this works.
type UserProfileType = import('../../config/userProfile').UserProfile;
import type { UserProfile } from '../../config/userProfile';
import {
  getCalendarEvents,
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
  getDismissedIssueKeys,
} from '../../db';
import { buildIssueKey } from '../../db/calendarIssues';
import { closeMeetingArtifacts } from '../../utils/closeMeetingArtifacts';

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
  // No offset → Graph returned it in the event's timezone (via Prefer header)
  // v2.3.1 (B5 / #63) — same fix: re-zone to fallbackTz so display is owner-local
  // even when Graph honored an event-side declared zone like "UTC".
  return DateTime.fromISO(clean, { zone: tz }).setZone(fallbackTz);
}

/**
 * Returns true when a full-day event belongs to someone else (e.g. a manager's OOO
 * shared on Idan's calendar). Heuristic: title starts with another person's name
 * followed by a dash/colon separator.
 * Matches: "Yael - Meir Hospital", "Brett - NY trip", "Amazia - Conference"
 * No match: "Vacation", "Conference", "Office Day", "Idan - offsite"
 */
function isOtherPersonsAllDayEvent(subject: string, ownerName: string, organizerEmail: string, ownerEmail: string): boolean {
  if (organizerEmail && organizerEmail.toLowerCase() === ownerEmail.toLowerCase()) return false;
  const ownerFirst = ownerName.split(' ')[0].toLowerCase();
  const match = subject.match(/^([A-Za-zÀ-ÿ]+)\s*[-–—:]\s*/);
  if (match) {
    const leadName = match[1].toLowerCase();
    if (leadName !== ownerFirst) return true;
  }
  return false;
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

    // Private/personal events: mask the subject
    const sensitivity = ev.sensitivity ?? 'normal';
    const subject = (sensitivity === 'private' || sensitivity === 'personal')
      ? '[Private]'
      : ev.subject;

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
  type: 'oof_with_meetings' | 'no_buffer' | 'missing_floating_block' | 'back_to_back' | 'overlap' | 'work_on_day_off';
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
  dismissedKeys?: Set<string>,
): DayAnalysis[] {
  const officeDays = new Set(profile.schedule.office_days.days as string[]);
  const homeDays   = new Set(profile.schedule.home_days.days   as string[]);
  const allWorkDays = new Set([...officeDays, ...homeDays]);

  // Floating blocks (lunch + any custom). Uses the same matcher every other
  // code path (slot search, book_floating_block, rebalance) uses.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fb = require('../../utils/floatingBlocks') as typeof import('../../utils/floatingBlocks');
  const floatingBlocks = fb.getFloatingBlocks(profile);
  const bufferMin = profile.meetings.buffer_minutes ?? 15;
  // v1.6.11 — per-day-type focus-time threshold. Office days usually need
  // more protected focus time than home days; profile can set each
  // separately. Home falls back to office value when not set.
  const requiredFreeOfficeMin = (profile.meetings.free_time_per_office_day_hours ?? 2) * 60;
  const requiredFreeHomeMin = ((profile.meetings.free_time_per_home_day_hours
    ?? profile.meetings.free_time_per_office_day_hours ?? 2)) * 60;

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

    // Time-block analysis (only non-all-day meetings within work hours)
    const timedMeetings = nonAllDayMeetings.filter(e => {
      const [h, m] = e._localStartTime.split(':').map(Number);
      const startMin = h * 60 + m;
      return startMin >= workStartMin && startMin < workEndMin;
    });

    // Compute gaps (free blocks) between meetings
    let totalMeetingMin = 0;
    let prevEndMin = workStartMin;
    let freeMin = 0;
    const gaps: Array<{ start: number; end: number }> = [];

    for (const ev of timedMeetings) {
      const [sh, sm] = ev._localStartTime.split(':').map(Number);
      const [eh, em] = ev._localEndTime.split(':').map(Number);
      const evStart = sh * 60 + sm;
      const evEnd   = Math.min(eh * 60 + em, workEndMin);
      const evDur   = Math.max(0, evEnd - Math.max(evStart, prevEndMin));

      if (evStart > prevEndMin) {
        const gapSize = evStart - prevEndMin;
        gaps.push({ start: prevEndMin, end: evStart });
        // Only count time BEYOND the transition buffer as productive focus time.
        // A 5-min gap between meetings is just breathing room, not thinking time.
        freeMin += Math.max(0, gapSize - bufferMin);
      }

      // v2.0.8 — true overlap detection. A new meeting starting BEFORE the
      // previous one ends is a real time conflict and must be flagged as high
      // severity. Previously the analyzer only fired a back_to_back issue
      // when evStart >= prevEndMin (adjacent, not overlapping). Overlaps
      // slipped through silently — the Apr 29 FC & Capri 14:45–15:30 +
      // Fulcrum Product Sync 15:00 case is the observed example.
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
      // Back-to-back check (adjacent, <bufferMin gap)
      if (prevEndMin > workStartMin && evStart < prevEndMin + bufferMin && evStart >= prevEndMin) {
        issues.push({
          type: 'back_to_back',
          severity: 'low',
          detail: `${ev.subject} at ${ev._localStartTime} starts immediately after the previous meeting (< ${bufferMin} min gap)`,
        });
      }

      totalMeetingMin += evDur;
      prevEndMin = Math.max(prevEndMin, evEnd);
    }
    // Gap from last meeting to end of work day (counts fully — no transition needed)
    if (prevEndMin < workEndMin) {
      const trailingGap = workEndMin - prevEndMin;
      gaps.push({ start: prevEndMin, end: workEndMin });
      freeMin += trailingGap;
    }

    // Buffer check (cumulative free time < required for THIS day type)
    const requiredFreeMin = isOffice ? requiredFreeOfficeMin : requiredFreeHomeMin;
    if (freeMin < requiredFreeMin) {
      issues.push({
        type: 'no_buffer',
        severity: 'high',
        detail: `Only ${freeMin} min free during work hours (${workTotalMin} min total). Need at least ${requiredFreeMin} min for focus/planning on a ${isOffice ? 'office' : 'home'} day.`,
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
      if (blockEvent) continue;  // present, in window — nothing to flag

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

    // Filter out issues the user has already dismissed
    const filteredIssues = dismissedKeys
      ? issues.filter(issue => !dismissedKeys.has(buildIssueKey(issue.type, issue.detail)))
      : issues;

    results.push({
      date: dateStr,
      day: dayName,
      dayType,
      isWorkDay: true,
      events: myEvents,
      issues: filteredIssues,
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

  // v2.0.7 — former getTools + getSystemPromptSection methods deleted. Both
  // were documented as "DEAD CODE since v1.7" and verified unused (zero
  // callers — MeetingsSkill owns both schemas + prompts). Only executeToolCall
  // is still invoked externally via `this.ops.executeToolCall(...)` from
  // meetings.ts.

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { email: userEmail, timezone } = context.profile.user;

    switch (toolName) {
      case 'get_calendar': {
        const rawEvents = await getCalendarEvents(
          userEmail,
          args.start_date as string,
          args.end_date as string,
          timezone,
        );
        return processCalendarEvents(rawEvents, userEmail, context.profile.user.name, timezone, context.profile);
      }

      case 'analyze_calendar': {
        const rawEvents = await getCalendarEvents(
          userEmail,
          args.start_date as string,
          args.end_date as string,
          timezone,
        );
        const processed = processCalendarEvents(rawEvents, userEmail, context.profile.user.name, timezone, context.profile);
        const dismissedKeys = getDismissedIssueKeys(
          context.profile.user.slack_user_id,
          args.start_date as string,
          args.end_date as string,
        );
        return analyzeCalendar(processed, args.start_date as string, args.end_date as string, context.profile, dismissedKeys);
      }

      case 'get_free_busy':
        try {
          const raw = await getFreeBusy(userEmail, args.emails as string[], args.start_date as string, args.end_date as string, timezone);
          // v2.1.5 — for colleague-context asks, synthesize out-of-work-hours
          // busy blocks on the OWNER's row so the free gaps returned to Sonnet
          // are already clipped to Idan's work hours. A colleague should not
          // be able to learn that 09:00 is free when Idan's office day starts
          // at 10:30 — out-of-hours availability requires explicit owner
          // override, not a drive-by "check get_free_busy" bypass. Owner-path
          // calls get raw data (owner knows their own schedule and may
          // genuinely want to see all gaps).
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
          return raw;
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
        // scope the workDays per mode (in_person → office only, else both).
        // Do NOT pre-pass workDays from here — we let the function's own
        // mode-aware logic decide so in_person is enforced as a hard rule.
        {
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

          // v2.6.6 — auto-fill from this thread's prior attendee context.
          // When Sonnet calls find_available_slots WITHOUT attendee_emails
          // but a previous call in this thread already established who the
          // meeting is for, recover that list so the work-hours / availability
          // constraint isn't silently dropped. Closes the 2026-05-10 Shayan
          // bug where Sonnet's 2nd call (after Yael said "I'm not a factor")
          // dropped Shayan's email and the slot finder proposed times outside
          // his TZ work hours.
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
          // bypasses it. Owner direction (#77): "I can force them to move
          // another meeting, not to wake up at 3 AM." So
          // `attendeeAvailability` (work-hours clip) is unconditional;
          // `ignore_attendee_availability` only suppresses the busy filter.
          // Owner direction (2026-05-14): `relaxed=true` (owner override) ALSO
          // implies ignoring attendee busy — when owner says "book it anyway,"
          // he's overriding everyone's other meetings, not just his own. Their
          // work hours stay enforced (no 3-AM bookings).
          const ignoreAttendeeBusy =
            args.ignore_attendee_availability === true
            || (args.relaxed === true && isOwnerInitiatedSearch);

          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { loadAttendeeAvailabilityForEmails } = require('../../utils/attendeeAvailability') as
            typeof import('../../utils/attendeeAvailability');
          const attendeeAvailability = loadAttendeeAvailabilityForEmails(attendeeEmails, userEmail);

          // #77 — owner-initiated path with attendees: auto-pass
          // attendeeBusyEmails so Graph free/busy filters the candidate
          // pool, not just work-hour clipping. Prior fixes (v2.2.3 #43,
          // v2.3.6 #71) wired the work-hours half but left the busy half
          // requiring explicit per-call args nobody passed. The
          // colleague-initiated path (coord state machine) deliberately
          // does NOT auto-pass — coord uses annotateSlotsWithAttendeeStatus
          // to TAG slots with status, showing all options per owner's rule.
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

          try {
            const rawSlots = await findAvailableSlots({
              userEmail,
              timezone,
              durationMinutes: args.duration_minutes as number,
              attendeeEmails,
              attendeeBusyEmails,
              searchFrom: effectiveSearchFrom,
              searchTo: args.search_to as string,
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
              // candidates. See findAvailableSlots.excludeEventIds for the
              // full semantics.
              excludeEventIds: Array.isArray(args.moving_event_ids)
                ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
                : undefined,
              // v2.6 — category scheduling rules. When set, slot loop filters
              // out slots that would violate the category's day_type / per_day
              // / per_week limits.
              category: args.category as string | undefined,
              diagnosticsOut,
            });
            // v2.4.2 — narrow to 3 spread options before returning to Sonnet.
            // Owner spec: "spread 3 options as I want" — one per day where
            // possible, then ≥2h apart same-day, then ≥30min last-resort.
            // pickSpreadSlots was already used by the coord path
            // (`pickSpreadSlots(slots, ownerTz, 3)`) but the owner-direct path
            // had been returning up to 30 raw candidates since v2.0.9 — Sonnet
            // had to pick which to surface (often over-listed). Single source
            // of truth now: tool returns spread, Sonnet narrates.
            // Edge case: narrow validation searches (HYPOTHETICAL VALIDATION
            // rule, "can we do X at Y?") naturally return ≤1 candidate from
            // findAvailableSlots, and pickSpreadSlots' Pass 1 (one-per-day)
            // returns it unchanged. No regression on the validation path.

            // v2.7.6 — auto-relaxed recovery on user-named narrow windows.
            // When strict returns 0 AND owner asked about a specific day/window
            // AND he didn't already opt into relaxed, automatically re-run with
            // relaxed=true so soft-rule-breaking slots surface tagged. Lets
            // Sonnet narrate "12:30 fits everyone but breaks your focus block
            // — book anyway?" instead of "Monday fully booked." Owner-path only.
            const isAlreadyRelaxed = args.relaxed === true && context.senderRole === 'owner';
            const shouldRecover =
              rawSlots.length === 0
              && isOwnerInitiatedSearch
              && userNamedNarrowWindow
              && !isAlreadyRelaxed;
            if (rawSlots.length === 0 && !shouldRecover) {
              return rawSlots;
            }
            let relaxedRecoverySlots: typeof rawSlots = [];
            const strictDaySummary = diagnosticsOut.daySummary;
            if (shouldRecover) {
              try {
                relaxedRecoverySlots = await findAvailableSlots({
                  userEmail,
                  timezone,
                  durationMinutes: args.duration_minutes as number,
                  attendeeEmails,
                  attendeeBusyEmails,
                  searchFrom: effectiveSearchFrom,
                  searchTo: args.search_to as string,
                  preferMorning: args.prefer_morning as boolean | undefined,
                  meetingMode: mode as import('../../connectors/graph/calendar').MeetingMode,
                  travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
                  attendeeAvailability,
                  minBufferHours: (context.senderRole === 'owner' || context.isOwnerInGroup === true)
                    ? 1
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
              if (relaxedRecoverySlots.length === 0) {
                // Recovery also empty — return original empty result with day_summary.
                if (strictDaySummary && strictDaySummary.length > 0) {
                  return { slots: [], day_summary: strictDaySummary };
                }
                return [];
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
            const candidateSet = relaxedRecoverySlots.length > 0 ? relaxedRecoverySlots : rawSlots;
            const chosenStarts = new Set(pickSpreadSlots(candidateSet, timezone, 3, anchorDay));
            const slots = candidateSet.filter(s => chosenStarts.has(s.start));

            // v2.7.0 — initiator-aware annotation. Owner-path already pre-
            // dropped attendee-busy slots via attendeeBusyEmails (line 807).
            // Colleague-path didn't pre-drop — slots may come back when an
            // internal attendee is busy. Annotate each slot with each
            // internal attendee's free/busy status so Sonnet narrates honestly
            // (per owner direction: colleague-path includes + annotates,
            // owner-path drops).
            let annotatedSlots: Array<any> = slots;
            if (!isOwnerInitiatedSearch && attendeeEmails.length > 0) {
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
            // lines. Travelers list only present when at least one attendee
            // had an active travel record at availability-load time.
            const travelers = (attendeeAvailability ?? [])
              .filter(a => a.travel)
              .map(a => ({
                email: a.email,
                location: a.travel!.location,
                until: a.travel!.until,
                travelTimezone: a.timezone,
                homeTimezone: a.travel!.homeTimezone,
              }));

            // v2.8.3 hotfix — when attendees live in a TZ different from
            // owner's, pre-render the slot in each such attendee's local TZ
            // and attach to the slot result. Sonnet quotes verbatim instead
            // of doing the math in chat (real-day bug 2026-05-16: she said
            // "10:30 IL = 08:30 Boston", off by ~5h). Code over prompt: the
            // conversion is pure determinism, no judgment.
            const differentTzAttendees = (attendeeAvailability ?? []).filter(
              a => a.timezone && a.timezone !== timezone,
            );
            if (differentTzAttendees.length > 0) {
              annotatedSlots = annotatedSlots.map((s: any) => {
                const per_attendee_local = differentTzAttendees.map(a => {
                  const dt = DateTime.fromISO(s.start, { zone: timezone }).setZone(a.timezone);
                  if (!dt.isValid) return null;
                  return {
                    email: a.email,
                    timezone: a.timezone,
                    local_iso: dt.toISO(),
                    local_display: dt.toFormat('EEE d MMM HH:mm'),
                  };
                }).filter((p): p is NonNullable<typeof p> => p !== null);
                return per_attendee_local.length > 0 ? { ...s, per_attendee_local } : s;
              });
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
            if (travelers.length > 0 || hasDaySummary || isRecoveryResult) {
              const result: Record<string, unknown> = { slots: annotatedSlots };
              if (travelers.length > 0) result.travelers = travelers;
              if (hasDaySummary) result.day_summary = daySummary;
              if (isRecoveryResult) {
                // Flag so Sonnet knows these slots break soft rules — she
                // should narrate the trade-off, not present as clean options.
                result._relaxed_recovery = true;
                result._recovery_note =
                  'Strict pass returned 0 in the named window. These slots come from a relaxed retry that bypassed soft rules (focus_time / lunch / work-hours). Read day_summary.top_reasons to see WHICH rule each slot is breaking, and present with that trade-off explicitly ("X fits but eats into your focus block — book anyway?"). Owner gets the final say.';
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
        const attendees = args.attendees as Array<{ name?: string; email?: string; slack_id?: string }>;
        const assistantEmail = context.profile.assistant.email;
        const ownerEmail = context.profile.user.email;

        // v2.6.6 — port of v2.0.6 coord email auto-fill to create_meeting.
        // Sonnet sometimes drops the email field even though we have it in
        // people_memory (the 2026-05-10 Shayan MPIM incident: email was in
        // people_memory by 12:01 via find_slack_user upsert; at 12:04
        // Sonnet called create_meeting with attendees=[{name:"Shayan
        // Memari"}] — no email — and Guard A refused). Symmetric to the
        // existing coord fill. Primary lookup: by slack_id; fallback: by
        // fuzzy name. Only fills missing entries; pre-existing emails
        // pass through untouched. If still missing after lookup, the
        // downstream Guard A returns error: 'attendee_missing_email' so
        // Sonnet asks for the email instead of papering over the gap.
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

        // v2.3.2 — colleague-path booking gate. When a colleague has
        // confirmed slot + duration + subject in this DM (1:1 or fast-path
        // multi-internal flow), Maelle calls create_meeting directly instead
        // of falling back to "you send the invite" or kicking off a redundant
        // coordinate_meeting. Same trust pattern as v2.2.1 move_meeting:
        // rule-compliance is the gate.
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
          // v2.6 Bug 4 — early idempotency probe BEFORE Guards A and B.
          // Background: when a colleague's continuing chat causes Sonnet to
          // re-attempt create_meeting after the first attempt already
          // succeeded, Guard B's rule-compliance check can throw (Graph
          // free/busy interval errors, transient API failures) and
          // defensively escalate to create_approval(kind=policy_exception).
          // That stale approval lands in the owner's DM and re-surfaces in
          // every brief until manually rejected (the actual incident:
          // 2026-05-05 Oran chatbot ask — first attempt 06:13:11 booked at
          // 13:30 successfully; second attempt 06:15:31 threw Graph error
          // and created appr_1777961736240_i064x which sat pending until
          // 2026-05-06 morning when the owner manually rejected it).
          //
          // Fix: probe Graph for an existing meeting at this same
          // subject+start (±2-min tolerance) BEFORE Guards A/B fire. If
          // found → return success with idempotent=true. The downstream
          // late-idempotency check at line ~1049 stays as defense-in-depth.
          // Subject+start match is the same heuristic the late check uses;
          // attendee-list matching is a future tightening (the rare collision
          // case is owner manually booked an unrelated event with the same
          // subject; trade-off favors avoiding stale approvals).
          try {
            const startDt = DateTime.fromISO(args.start as string, { zone: timezone });
            if (startDt.isValid) {
              const requestedSubject = (args.subject as string).trim();
              const probeDate = startDt.toFormat('yyyy-MM-dd');
              const startMs = startDt.toMillis();
              const existingEvents = await getCalendarEvents(userEmail, probeDate, probeDate, timezone);
              const duplicate = existingEvents.find(ev => {
                if (ev.isCancelled) return false;
                if ((ev.subject ?? '').trim().toLowerCase() !== requestedSubject.toLowerCase()) return false;
                const evStartMs = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).toMillis();
                return Math.abs(evStartMs - startMs) <= 2 * 60 * 1000;
              });
              if (duplicate) {
                const ownerFirst = context.profile.user.name.split(' ')[0];
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

          // Guard A — every attendee must have an email so the calendar
          // invite can actually reach them. Internal attendees and the
          // requester themselves pass trivially; externals are also allowed
          // (they get the calendar invite via Outlook — same delivery path
          // as v2.6.5 fast-path Case B already designs for). Only refuse
          // when an attendee has no email — that's the unclassifiable case
          // (could be an internal Maelle should DM, could be an external
          // Sonnet hasn't fully resolved). Pre-v2.6.6 this guard refused
          // ANY external, which contradicted the v2.6.5 fast-path Case B
          // note that tells Sonnet "call create_meeting after the requester
          // picks — externals get the invite via Outlook." That contradiction
          // was the real Bug 4 in the 2026-05-10 Yael / Idan Wagner incident:
          // fast-path Case B told Sonnet to book; Guard A refused; Sonnet
          // fell back to create_approval(kind=slot_pick) which has no
          // coord_job to drive the resolver, so booking succeeded only
          // when the owner manually approved AND no requester loop-close
          // ever fired to Yael.
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
                message: `I don't have an email for ${unclassifiable.map(a => a.name).join(', ')}. Without an email I can't add them to the calendar invite. Either call coordinate_meeting (which DMs them for slot pick + collects email), or come back with their email.`,
              };
            }
          } catch (err) {
            logger.warn('create_meeting colleague-path attendee guard threw — proceeding to rule check', {
              err: String(err).slice(0, 200),
            });
          }

          // Guard B — slot rule-compliance via findAvailableSlots narrow window.
          try {
            const startDt = DateTime.fromISO(args.start as string, { zone: timezone });
            const endDt = DateTime.fromISO(args.end as string, { zone: timezone });
            if (startDt.isValid && endDt.isValid) {
              const durationMin = Math.max(5, Math.round((endDt.toMillis() - startDt.toMillis()) / 60_000));
              const { findAvailableSlots } = await import('../../connectors/graph/calendar');
              const startMs = startDt.toMillis();
              // v2.6.1 — pass the EXACT requested window. Pre-v2.6.1 widened
              // by ±60s on each side, but findAvailableSlots strides 15-min
              // from searchFrom — so cursor landed at start-1min and the
              // requested slot was never tested. Worst-case bug: a 10:30
              // request on an office day with hours_start: '10:30' got
              // rejected as outside_owner_work_hours because cursor was at
              // 10:29 (one minute outside the boundary). Confirmed in log
              // 2026-05-06T18:39:45.015Z. The widening defended against
              // nothing concrete (work-hours / busy / focus checks read
              // integer-minute fields, sub-second drift doesn't matter).
              const fromIso = startDt.toUTC().toISO();
              const toIso = endDt.toUTC().toISO();
              let validSlots: Array<{ start: string }> = [];
              // v2.6.1 — collect rejection diagnostics from findAvailableSlots
              // by reference so we can name THIS slot's broken rule in the
              // refusal returned to Sonnet (instead of forcing her to guess
              // which led to "rule-non-compliant" + fabricated reasons).
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
                });
              }
              const matches = validSlots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000);
              if (!matches) {
                const ownerFirst = context.profile.user.name.split(' ')[0];
                // v2.6.1 — derive a one-phrase human label for the rule
                // that rejected this slot. Sonnet pastes this verbatim
                // into create_approval(kind=policy_exception).ask_text so
                // the owner sees "in your lunch window" / "outside your
                // work hours" / etc. instead of "rule-non-compliant" or a
                // fabricated reason. broken_rule_label === 'unknown' means
                // the diagnostics didn't fire (rare — defensive); Sonnet
                // says so honestly rather than guessing.
                // v2.7.1 — owner_buffer_collision removed (was a soft-preference
                // collision check that duplicated the buffer baked into standard
                // durations). Connected back-to-backs are fine by design.
                const labelFor = (reason: string | undefined): string => {
                  switch (reason) {
                    case 'outside_owner_work_hours': return `outside ${ownerFirst}'s work hours`;
                    case 'outside_attendee_work_hours': return `outside the attendee's working hours`;
                    case 'owner_busy_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                    // legacy label name kept as alias in case any older diagnostics path still emits it
                    case 'owner_busy_or_buffer_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                    case 'overlaps_meeting_being_moved': return `overlaps the meeting being moved`;
                    case 'focus_time_office': return `breaks ${ownerFirst}'s focus-time protection (office day)`;
                    case 'focus_time_home': return `breaks ${ownerFirst}'s focus-time protection (home day)`;
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
            const { DateTime: DT } = await import('luxon');
            const requestedStart = DT.fromISO(args.start as string, { zone: timezone });
            const probeFrom = requestedStart.minus({ days: 30 }).toFormat('yyyy-MM-dd');
            const probeTo = requestedStart.plus({ days: 1 }).toFormat('yyyy-MM-dd');
            const events = await getCalendarEvents(userEmail, probeFrom, probeTo, timezone);
            const predecessor = events.find(e => e.id === mustBeAfterId);
            if (predecessor) {
              const predEnd = DT.fromISO(predecessor.end.dateTime, { zone: predecessor.end.timeZone ?? 'utc' })
                .setZone(timezone);
              if (requestedStart.toMillis() < predEnd.toMillis()) {
                logger.info('create_meeting refused — must_be_after_event_id ordering violated', {
                  predecessorId: mustBeAfterId,
                  predecessorEnd: predEnd.toISO(),
                  requestedStart: requestedStart.toISO(),
                });
                return {
                  success: false,
                  error: 'order_violation',
                  message: `That start time (${requestedStart.toFormat("EEE d MMM 'at' HH:mm")}) is BEFORE the predecessor meeting "${predecessor.subject ?? 'unknown'}" ends (${predEnd.toFormat("EEE d MMM 'at' HH:mm")}). The series must stay in order. Pick a slot after that.`,
                };
              }
            } else {
              logger.warn('create_meeting — must_be_after_event_id not found in nearby calendar; proceeding without order check', {
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

        // Work day validation — warn if outside work schedule
        const startDt = DateTime.fromISO(args.start as string, { zone: timezone });
        const dayName = startDt.toFormat('EEEE');
        const allWorkDays = [
          ...context.profile.schedule.office_days.days,
          ...context.profile.schedule.home_days.days,
        ];
        if (!allWorkDays.includes(dayName as any)) {
          // Check if user explicitly overrode — indicated by override flag in args
          if (!args.override_work_day) {
            return {
              warning: `${dayName} is not a work day. Ask the user briefly: "That's a ${dayName} — want me to book it anyway, or would Sunday work better?" If they confirm, call create_meeting again with override_work_day=true.`,
              needs_confirmation: true,
            };
          }
          // User confirmed — proceed with booking
        }

        // v1.8.14 — cross-turn idempotency. If a meeting with the SAME subject
        // at the SAME start time already exists on the owner's calendar (±2 min
        // tolerance), return that event id instead of creating a duplicate.
        // Root cause: date-verifier retries and claim-checker retries can each
        // re-run the whole orchestrator loop on a new turn. Per-turn dedup
        // (like delete_meeting has) doesn't help across turns. Graph is the
        // source of truth — query it.
        try {
          const requestedSubject = (args.subject as string).trim();
          const probeDate = startDt.toFormat('yyyy-MM-dd');
          const startMs = startDt.toMillis();
          const existingEvents = await getCalendarEvents(userEmail, probeDate, probeDate, timezone);
          const duplicate = existingEvents.find(ev => {
            if (ev.isCancelled) return false;
            const evSubject = (ev.subject ?? '').trim();
            if (evSubject.toLowerCase() !== requestedSubject.toLowerCase()) return false;
            const evStartMs = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone }).toMillis();
            return Math.abs(evStartMs - startMs) <= 2 * 60 * 1000;
          });
          if (duplicate) {
            logger.warn('create_meeting idempotent short-circuit — same subject+start already on calendar', {
              subject: requestedSubject,
              start: args.start,
              existingEventId: duplicate.id,
            });
            return {
              success: true,
              meetingId: duplicate.id,
              idempotent: true,
              action_summary: `'${requestedSubject}' is already on the calendar for ${formatIsoTime(args.start as string)}–${formatIsoTime(args.end as string)}. Did not create a duplicate.`,
              _note: 'A meeting with this exact subject and start time was already on the calendar. Returning the existing event id instead of creating a duplicate. Do NOT call create_meeting again for this slot.',
            };
          }
        } catch (err) {
          logger.warn('create_meeting idempotency pre-check failed — proceeding with create', { err: String(err) });
        }

        // v2.7.0 — single pipeline through planMeeting. Replaces the v2.6.x
        // determineSlotLocation + helperForcesOnline + skipLocationField mess.
        // planMeeting handles category detection, location resolution, and
        // rule application as ONE coherent decision. Output drives the rest
        // of the booking.
        const { planMeeting } = await import('./planMeeting');
        const plan = await planMeeting({
          profile: context.profile,
          intent: 'new_booking',
          initiator: context.senderRole === 'colleague' ? 'colleague' : 'owner',
          initiatorSlackId: context.userId,
          slotStartIso: args.start as string,
          slotEndIso: args.end as string,
          subject: args.subject as string,
          body: args.body as string | undefined,
          participants: attendees.map(a => ({
            email: a.email, name: a.name, slack_id: a.slack_id,
          })),
          locationHint: args.location as string | undefined,
          isOnlineHint: typeof args.is_online === 'boolean' ? args.is_online : undefined,
          allowRelaxed: args.relaxed === true,
        });
        logger.info('create_meeting — planMeeting verdict', {
          action: plan.action, start: args.start, subject: args.subject,
          reasoning: 'reasoning' in plan ? plan.reasoning : undefined,
          category: 'category' in plan ? plan.category : undefined,
        });

        // Early-return on non-book plans:
        if (plan.action === 'confirm_override' || plan.action === 'escalate_approval') {
          return {
            success: false,
            error: 'rule_violation',
            violation_label: plan.violationLabel,
            suggested_ask_text: plan.suggestedAskText,
            category: plan.category,
            // v2.7.2 — deferred_action_hint: the original tool call, ready
            // to be stamped on a follow-up create_approval. Orchestrator
            // auto-attaches this to payload.deferred_action when Sonnet
            // raises a policy_exception this turn, so the resolver can
            // replay the booking on approve. The "redirect URL token"
            // pattern — args round-trip through the approval.
            _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
            _note: plan.action === 'escalate_approval'
              ? 'A scheduling rule was violated. Use create_approval(kind=policy_exception) with suggested_ask_text to get the owner to decide.'
              : 'A scheduling rule was violated. Surface suggested_ask_text to the owner and wait for an explicit override before retrying with relaxed=true.',
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
        const planTeamsUrlAsLocation = plan.teamsUrlAsLocation === true;
        // skipLocationField fires when resolveLocation gave us no physical
        // string AND we're not in the Teams-URL-as-location flow (those get
        // patched post-create, so the create call sends empty location).
        const skipLocationField = planLocation.trim().length === 0;
        if (planCategory && !args.category) {
          args.category = planCategory;
        }
        // v2.8.2 — location stamping is now a single string from resolveLocation
        // (no more multi-part label/address/parking joining). For owner-explicit
        // non-ASCII venues we still resolve to English for the calendar.
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

        return createMeeting({
          userEmail,
          timezone,
          // v2.4.3 (E1) — subject NOT scrubbed (per owner direction: " - "
          // separator is fine in subjects, "Welcome Meeting - X & Y" reads
          // naturally). The em-dash + " - " pattern is the chat-side issue;
          // calendar subjects can keep them.
          subject:    args.subject  as string,
          start:      args.start    as string,
          end:        args.end      as string,
          // By this point Guard A has refused any attendee missing email and
          // the auto-fill has populated names. Coerce to the strict shape.
          attendees:  attendees.map(a => ({ name: a.name ?? '', email: a.email ?? '' })),
          // v2.4.3 (E1) — body scrubbed AND auto-enriched with location.
          // Pre-v2.4.3 the location often rendered cluttered ("Reflectiz HQ
          // — Shoham 5 — Parking: ...") in the Outlook location field where
          // many clients truncate it; Sonnet's body sometimes lacked the
          // address entirely. Now the body always carries a readable
          // location line at the top so attendees can find the meeting
          // regardless of how their client renders the location field.
          body: (() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { scrubInternalLeakage } = require('../../utils/textScrubber') as typeof import('../../utils/textScrubber');
            const raw = args.body as string | undefined;
            const cleanedRaw = raw ? scrubInternalLeakage(raw) : '';
            // v2.6.2 (D5) — same fix as resolvedLocationParts above. Use
            // skipLocationField (not effectiveIsOnline) so office-day internal
            // hybrid meetings DO get a location block in the body even when a
            // Teams link is also being added.
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
          // falls back to determineSlotLocation's day-aware decision when both
          // is_online and location were left blank.
          isOnline:   effectiveIsOnline,
          // All-day events. Sonnet sets is_all_day=true ONLY when owner
          // explicitly asks for a full-day event. createMeeting() clamps
          // start/end to midnight-of-day → midnight-of-next-day per Graph's
          // requirement; we just pass the flag through here.
          isAllDay:   args.is_all_day === true,
          // v2.3.2 (1C) / v2.3.6 (#73) / v2.4.3 (E1) — clean comma-joined
          // location with no em-dash separators. Pre-v2.4.3 used " — " as
          // the joiner which made the Outlook location field hard to read.
          // Same parts, comma-separated, then routed through scrubInternalLeakage
          // for safety against any owner-yaml accidental dashes.
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
          sensitivity: (() => {
            const cat = (args.category as string | undefined) ?? null;
            if (!cat) return undefined;
            const match = (context.profile.categories ?? []).find(c => c.name === cat);
            return match?.sets_sensitivity_private ? 'private' : undefined;
          })(),
          // v2.3.1 (B23) — invite-body attribution names this assistant + owner.
          defaultBodyAuthor: `${context.profile.assistant.name}, ${context.profile.user.name.split(' ')[0]} Assistant`,
        }).then(async createdMeeting => {
          const meetingId = createdMeeting.id;
          // v2.8.2 — Teams-URL-as-location patch. When the location decision
          // tree said "online with Teams URL as the location" (4a1, 5a,
          // travel-override, non-work-day default), read the joinUrl back from
          // Graph and patch the event's location.displayName so the calendar
          // invite shows the join link as the location.
          if (planTeamsUrlAsLocation && createdMeeting.joinUrl) {
            try {
              const { updateMeeting } = await import('../../connectors/graph/calendar');
              await updateMeeting({
                userEmail,
                timezone,
                meetingId,
                location: createdMeeting.joinUrl,
              });
              logger.info('create_meeting — patched location with Teams join URL', {
                meetingId, joinUrl: createdMeeting.joinUrl,
              });
            } catch (err) {
              logger.warn('create_meeting — Teams URL location patch failed, leaving as auto', {
                meetingId, err: String(err).slice(0, 200),
              });
            }
          }
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

          // v2.3.2 — colleague-path booking: shadow-DM the owner so he
          // sees the book happen even when he wasn't in the loop. Mirrors the
          // v2.2.1 move_meeting shadow on inbound reschedule. Threaded under
          // the colleague conversation key so all shadows from this thread
          // group together in the owner's DM.
          if (context.senderRole === 'colleague') {
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

            // v2.3.2 — post-booking heads-up DMs to non-self internal
            // attendees. The fast-path skipped DMs during slot search (we
            // checked their calendars directly via Graph) — they deserve a
            // soft "this just got booked" so they aren't surprised by the
            // calendar invite. Phrased like a human EA: "Hi Amazia, Oran
            // asked for a meeting with you and Idan — I checked your
            // calendar and booked it for Tue 09:00. See you then." Lookup
            // by email via searchPeopleMemory; skip silently if no slack_id
            // available (the calendar invite still went out).
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
                  // location string typically already includes "Name, Street City".
                  // Future Google-Places integration (#96) will split these out.
                });
              }
            } catch (err) {
              logger.warn('venue save-on-book hook failed — continuing', {
                err: String(err).slice(0, 200),
              });
            }
          }

          return {
            success: true,
            meetingId,
            // v1.8.3 — past-tense summary the reply can quote verbatim. Prevents
            // Sonnet from narrating the post-action calendar state as a fresh
            // discovery instead of the result of her own action (issue #26 bug 1).
            action_summary: `Booked '${args.subject}' for ${formatIsoTime(args.start as string)}–${formatIsoTime(args.end as string)}.`,
          };
        });
      }

      case 'update_meeting': {
        // v2.1.4 — attendee-only guard. If the event's organizer is not the
        // owner, the owner is an ATTENDEE on someone else's meeting. Graph
        // rejects PATCH from non-organizers, but the error message is
        // unhelpful; refuse early with a clear human message so Maelle
        // doesn't offer a fake "I'll add the location" then silently fail.
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

        await updateMeeting({
          userEmail,
          timezone,
          meetingId:  args.meeting_id  as string,
          subject:    args.new_subject as string | undefined,  // subjects allow " - " (E1, owner direction)
          categories: args.category ? [args.category as string] : undefined,
        });
        closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'updated',
        });
        auditLog({
          action: 'update_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          details: { subject: args.meeting_subject, category: args.category, new_subject: args.new_subject },
          outcome: 'success',
        });
        const updateChanges: string[] = [];
        if (args.new_subject) updateChanges.push(`renamed to '${args.new_subject}'`);
        if (args.category) updateChanges.push(`category set to ${args.category}`);
        return {
          success: true,
          updated: args.meeting_subject,
          category: args.category ?? null,
          new_subject: args.new_subject ?? null,
          // v1.8.3 — past-tense summary for owner-visible reply. Issue #26 bug 1.
          action_summary: `Updated '${args.meeting_subject}'${updateChanges.length > 0 ? ': ' + updateChanges.join(', ') : ''}.`,
        };
      }

      case 'move_meeting': {
        // v2.2.1 — colleague-path rule-compliance gate. When an inbound colleague
        // DM asks Maelle to move an existing meeting, she can do it autonomously
        // IF the new slot fits the owner's rules (work hours, work days, buffers,
        // floating blocks, no conflicts). If the new slot breaks a rule, the tool
        // refuses and signals needs_owner_approval — Sonnet then falls back to
        // create_approval(kind=meeting_reschedule). Owner-path callers skip this
        // check (owner override IS the approval).
        if (context.senderRole === 'colleague') {
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
                // v2.6.1 — pass exact requested window. See parallel comment
                // in create_meeting Guard B for the full reasoning (±60s
                // padding caused cursor to land outside work-hours boundaries
                // by one minute, slot never tested).
                const fromIso = startDt.toUTC().toISO();
                const toIso = endDt.toUTC().toISO();
                let validSlots: Array<{ start: string }> = [];
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
                    // v2.6 — pass category so move_meeting colleague-path
                    // also enforces day_type / per_day / per_week limits at
                    // the destination. The destination day's count excludes
                    // the event being moved (it's leaving its current day);
                    // findAvailableSlots widens its event fetch when
                    // category is set so day/week counts are accurate.
                    category: args.category as string | undefined,
                    diagnosticsOut: diagnostics,
                  });
                }
                const matches = validSlots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000);
                if (!matches) {
                  const ownerFirst = context.profile.user.name.split(' ')[0];
                  // v2.6.1 — same rule-name surfacing as create_meeting Guard B.
                  const labelFor = (reason: string | undefined): string => {
                    switch (reason) {
                      case 'outside_owner_work_hours': return `outside ${ownerFirst}'s work hours`;
                      case 'outside_attendee_work_hours': return `outside the attendee's working hours`;
                      case 'owner_busy_or_buffer_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                      case 'overlaps_meeting_being_moved': return `overlaps the meeting being moved`;
                      case 'focus_time_office': return `breaks ${ownerFirst}'s focus-time protection (office day)`;
                      case 'focus_time_home': return `breaks ${ownerFirst}'s focus-time protection (home day)`;
                      case 'floating_block_no_room': return `would leave no room for one of ${ownerFirst}'s daily blocks (lunch / break / etc.)`;
                      case 'category_day_type': return `wrong day type for this category (e.g. office-only category on a home day)`;
                      case 'category_per_day': return `over ${ownerFirst}'s per-day limit for this category`;
                      case 'category_per_week': return `over ${ownerFirst}'s per-week limit for this category`;
                      default: return 'unknown';
                    }
                  };
                  const counts = diagnostics.rejectedCounts ?? {};
                  const fired = Object.keys(counts);
                  const brokenRule = fired[0];
                  const brokenRuleLabel = labelFor(brokenRule);
                  logger.info('move_meeting colleague-path refused — new slot breaks owner rules', {
                    meetingId: args.meeting_id, newStart, newEnd, requester: context.userId,
                    broken_rule: brokenRule ?? 'unknown',
                    broken_rule_label: brokenRuleLabel,
                  });
                  return {
                    needs_owner_approval: true,
                    reason: 'not_rule_compliant',
                    broken_rule: brokenRule ?? 'unknown',
                    broken_rule_label: brokenRuleLabel,
                    meeting_subject: args.meeting_subject,
                    requested_start: newStart,
                    requested_end: newEnd,
                    message: brokenRuleLabel === 'unknown'
                      ? `That time doesn't pass ${ownerFirst}'s scheduling rules and I can't tell exactly which one flagged it. Call create_approval(kind=meeting_reschedule) — describe the slot honestly and let him decide.`
                      : `That time is ${brokenRuleLabel} for ${ownerFirst}. I can't move it on my own — call create_approval(kind=meeting_reschedule) and pass the same phrase ("${brokenRuleLabel}") in ask_text so he knows what he's overriding.`,
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
        // occurrence moves (type='occurrence' or 'exception') are allowed;
        // Graph creates an exception pinning just that date.
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
        } catch (err) {
          logger.warn('move_meeting recurring-preflight failed — proceeding', { err: String(err) });
        }

        // v2.3.1 (B1 / #61) — deterministic floating-block alignment. When the
        // meeting being moved is a floating block (lunch, coffee, etc.), don't
        // trust args.new_start verbatim — Sonnet keeps doing time math in
        // chat and getting it wrong (window check, buffer, alignment). Run
        // findAlignedSlotForBlock with args.new_start as a HINT to compute
        // the correct slot; if no in-window slot fits, refuse with a clear
        // pointer to lunch_bump approval. Owner-directed moves no longer ask
        // permission for in-window adjustments — code computes the right
        // answer once.
        let effectiveStart = args.new_start as string;
        let effectiveEnd   = args.new_end   as string;
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
              const buffer = context.profile.meetings.buffer_minutes ?? 5;

              // v2.3.2 (3A) — owner-explicit hint respects target as-is when
              // in-window. Don't snap to a different slot, don't refuse on
              // conflict. findAlignedSlotForBlock conflated window-check and
              // conflict-check; for owner-explicit moves only the window
              // matters — owner overrides any conflict (it shows as a normal
              // calendar overlap she can sort separately, e.g. she said
              // "I'll move Elan after"). Out-of-window still refuses, that's
              // the lunch_bump approval territory.
              const isOwnerPath = context.senderRole === 'owner' || context.isOwnerInGroup === true;
              if (isOwnerPath) {
                const hintStartMs = newStartDt.toMillis();
                const hintEndMs = hintStartMs + matchedBlock.duration_minutes * 60 * 1000;
                const inWindow = hintStartMs >= wStart && hintEndMs <= wEnd;
                const overrideOk = args.confirm_outside_window === true;
                if (inWindow || overrideOk) {
                  effectiveStart = newStartDt.toISO()!;
                  effectiveEnd = newStartDt
                    .plus({ minutes: matchedBlock.duration_minutes })
                    .toISO()!;
                  logger.info(inWindow
                    ? 'move_meeting (owner) — floating block in-window, using hint as-is'
                    : 'move_meeting (owner) — floating block out-of-window override accepted', {
                    meetingId: args.meeting_id, block: matchedBlock.name, hint: args.new_start,
                    window: `${matchedBlock.preferred_start}-${matchedBlock.preferred_end}`,
                    override_used: !inWindow,
                  });
                } else {
                  logger.info('move_meeting refused — owner hint out of window without override', {
                    meetingId: args.meeting_id, block: matchedBlock.name, hint: args.new_start,
                    window: `${matchedBlock.preferred_start}-${matchedBlock.preferred_end}`,
                  });
                  return {
                    success: false,
                    error: 'out_of_window',
                    message: `${args.new_start} is outside the ${matchedBlock.preferred_start}–${matchedBlock.preferred_end} window for ${matchedBlock.name}. To proceed anyway, retry with confirm_outside_window=true (owner override IS the approval — no separate lunch_bump needed).`,
                  };
                }
                // Skip the colleague-path findAlignedSlotForBlock branch below.
                return await updateMeeting({
                  userEmail, timezone,
                  meetingId: args.meeting_id as string,
                  start: effectiveStart, end: effectiveEnd,
                }).then(async () => {
                  closeMeetingArtifacts({
                    ownerUserId: context.profile.user.slack_user_id,
                    meetingId: args.meeting_id as string,
                    reason: 'moved',
                  });
                  return {
                    success: true,
                    action_summary: `Moved ${matchedBlock.name} to ${formatIsoTime(effectiveStart)}.`,
                  };
                });
              }

              // Colleague-path — keep existing alignment + conflict guard.
              const alignedMs = fb.findAlignedSlotForBlock(matchedBlock, dayStr, timezone, busy, buffer);
              if (alignedMs === null) {
                logger.info('move_meeting refused — no in-window slot for floating block', {
                  meetingId: args.meeting_id, block: matchedBlock.name, hint: args.new_start,
                });
                return {
                  success: false,
                  error: 'no_in_window_slot',
                  message: `No room in the ${matchedBlock.preferred_start}–${matchedBlock.preferred_end} window for ${matchedBlock.name} after that hint. To move it OUTSIDE the window, raise create_approval(kind='lunch_bump') with the desired slot.`,
                };
              }
              const alignedDt = DateTime.fromMillis(alignedMs).setZone(timezone);
              const alignedEndDt = alignedDt.plus({ minutes: matchedBlock.duration_minutes });
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
        let movePlanTeamsUrlAsLocation = false;
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
            // v2.8.2 — owner-explicit hints flow through on move too. Without
            // these, every owner-explicit "move it to 3pm in person" lost the
            // physical signal and resolveLocation defaulted to day-type rules.
            locationHint: args.location as string | undefined,
            isOnlineHint: typeof args.is_online === 'boolean' ? args.is_online : undefined,
            allowRelaxed: args.relaxed === true,
          });
          logger.info('move_meeting — planMeeting verdict', {
            action: movePlan.action, meetingId: args.meeting_id,
            priorStart: priorStartIso, newStart: effectiveStart,
            reasoning: 'reasoning' in movePlan ? movePlan.reasoning : undefined,
          });
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
                : 'Move violates a scheduling rule. Surface suggested_ask_text to the owner; if he confirms, retry with relaxed=true.',
            };
          }
          // v2.8.2 — ask_location_mode on move (rare — external attendee, same/unknown TZ,
          // and the move flips into office day). Refuse + surface the ask.
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
            movePlanTeamsUrlAsLocation = movePlan.teamsUrlAsLocation === true;
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

        await updateMeeting({
          userEmail,
          timezone,
          meetingId: args.meeting_id as string,
          start: effectiveStart,
          end: effectiveEnd,
          // v2.7.0 — pass-through location/isOnline/categories from the
          // planMeeting verdict. Undefined values leave the existing fields
          // untouched on Graph's side. v2.8.2 — preserveExisting keeps both
          // undefined so a move within the same day-type doesn't overwrite
          // owner conventions like "Huddle".
          location: movePlanLocation,
          isOnline: movePlanIsOnline,
          categories: movePlanCategories,
        });

        // v2.8.2 — post-move Teams URL patch. When the move flipped into an
        // online location-flavor, the updateMeeting call above set isOnline=true
        // but left location empty. Read the event back to get joinUrl and
        // patch location.displayName with it.
        if (movePlanTeamsUrlAsLocation) {
          try {
            const { getCalendarEvents: getCal, updateMeeting: updateMeeting2 } = await import('../../connectors/graph/calendar');
            const dayStart = DateTime.fromISO(effectiveStart, { zone: timezone }).toFormat('yyyy-MM-dd');
            const dayEnd = DateTime.fromISO(effectiveStart, { zone: timezone }).plus({ days: 1 }).toFormat('yyyy-MM-dd');
            const refreshed = await getCal(userEmail, dayStart, dayEnd, timezone);
            const ev = refreshed.find(e => e.id === args.meeting_id);
            const joinUrl = (ev as any)?.onlineMeeting?.joinUrl as string | undefined;
            if (joinUrl) {
              await updateMeeting2({
                userEmail,
                timezone,
                meetingId: args.meeting_id as string,
                location: joinUrl,
              });
              logger.info('move_meeting — patched location with Teams join URL', {
                meetingId: args.meeting_id, joinUrl,
              });
            }
          } catch (err) {
            logger.warn('move_meeting — Teams URL location patch failed', {
              meetingId: args.meeting_id, err: String(err).slice(0, 200),
            });
          }
        }

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

        closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'moved',
        });
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
        if (context.senderRole === 'colleague') {
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
        // via the existing lunch_bump approval flow).
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { rebalanceFloatingBlocksAfterMutation } = require('../../utils/rebalanceFloatingBlocks') as
            typeof import('../../utils/rebalanceFloatingBlocks');
          await rebalanceFloatingBlocksAfterMutation({
            profile: context.profile,
            affectedSlotIso: effectiveStart,
            ownerSlackId: context.profile.user.slack_user_id,
          });
        } catch (err) {
          logger.warn('rebalance after move_meeting threw — continuing', { err: String(err).slice(0, 200) });
        }

        return {
          success: true,
          moved: args.meeting_subject,
          new_start: args.new_start,
          new_end: args.new_end,
          // v1.8.3 — past-tense summary the reply quotes verbatim. Issue #26 bug 1:
          // without this, Sonnet could re-read the calendar post-move and narrate
          // the new time as a fresh discovery ("already at 12:30, nothing to change")
          // instead of acknowledging her own action.
          action_summary: `Moved '${args.meeting_subject}' to ${formatIsoTime(args.new_start as string)}–${formatIsoTime(args.new_end as string)}.`,
        };
      }

      case 'delete_meeting': {
        // v2.7.0 — track auto-relay outcome so Sonnet narrates honestly:
        //   'sent'                  → DM went out to the organizer (Slack)
        //   'skipped_no_slack_id'   → organizer is external / not in workspace;
        //                              owner-side decline still landed but the
        //                              organizer was NOT notified
        //   'not_attempted'         → owner is the organizer (no relay needed)
        let relayStatus: 'sent' | 'skipped_no_slack_id' | 'not_attempted' = 'not_attempted';
        let relayOrganizerName: string | null = null;
        let relayOrganizerEmail: string | null = null;
        // v2.7.0 — ownership-aware delete via planMeeting.
        // Path tree (per D3 / Q1=B / D4):
        //   - owner is organizer → proceed with delete (existing flow below)
        //   - owner is attendee + asker is the requester/organizer → decline on
        //     owner's side (effectively the same Graph delete call from owner's
        //     calendar — Graph drops the event from his view)
        //   - owner is attendee + asker is someone ELSE (incl. owner himself) →
        //     decline on owner's side + auto-DM the organizer politely
        try {
          const { planMeeting } = await import('./planMeeting');
          const decision = await planMeeting({
            profile: context.profile,
            intent: 'cancel',
            initiator: context.senderRole === 'colleague' ? 'colleague' : 'owner',
            initiatorSlackId: context.userId,
            existingEventId: args.meeting_id as string,
            subject: args.meeting_subject as string | undefined,
            participants: [],
          });
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

        // Defense-in-depth: refuse a series-level delete if the id resolves to
        // a seriesMaster. Mirrors the guard in update_meeting and move_meeting.
        // get_calendar normally returns occurrence ids (Graph calendarView
        // expands recurring series), so a master id should never reach here
        // through the normal path — but if it ever does, a one-shot mistake
        // would wipe an entire recurring series.
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
        } catch (err) {
          logger.warn('delete_meeting recurring-preflight failed — proceeding', { err: String(err) });
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
        closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'deleted',
        });
        auditLog({
          action: 'delete_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          details: { subject: args.meeting_subject },
          outcome: 'success',
        });
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
          relay_status: relayStatus,
          organizer_name: relayOrganizerName ?? undefined,
          organizer_email: relayOrganizerEmail ?? undefined,
          action_summary: actionSummary,
          _note: relayStatus === 'skipped_no_slack_id'
            ? 'IMPORTANT: do NOT claim "I notified the organizer" — the organizer has no Slack account, no DM was sent. Tell the owner that explicitly and offer to draft an email if they want.'
            : undefined,
        };
      }

      // v2.0.7 — legacy escalate_to_user / store_request / get_pending_requests /
      // resolve_request cases retired. See tool-declaration comment above.
      // v2.6.4 — dead duplicate find_slack_user case removed. Live handler had
      // moved to skills/meetings.ts long ago; that one in turn moved to
      // SlackConnection (src/connections/slack/index.ts) in v2.6.4.

      case 'coordinate_meeting': {
        if (!context.app) return { error: 'App not available in context' };
        return { error: 'Coordination feature initializing — please try again.' };
      }

      default:
        return null; // not our tool
    }
  }

}
