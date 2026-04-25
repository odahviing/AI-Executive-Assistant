/**
 * Meetings-skill direct-ops helper (internal; not a loadable skill).
 *
 * This file holds the direct calendar operations (`get_calendar`, `create_meeting`,
 * `move_meeting`, `delete_meeting`, `update_meeting`, `get_free_busy`,
 * `find_available_slots`, `analyze_calendar`, `dismiss_calendar_issue`) and the
 * pure helpers `processCalendarEvents` and `analyzeCalendar` used by the task
 * runner's `calendar_fix` dispatcher.
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
    const spec = isOffice ? profile.schedule.office_days : profile.schedule.home_days;
    const startMin = hhmmToMinutes(spec.hours_start);
    const endMin = hhmmToMinutes(spec.hours_end);
    // Morning block: 00:00 → hours_start
    if (startMin > 0) {
      const morningEnd = dayStart.plus({ minutes: startMin });
      blocks.push({
        start: dayStart.toISO() ?? `${d.toISODate()}T00:00:00`,
        end: morningEnd.toISO() ?? `${d.toISODate()}T${spec.hours_start}:00`,
        status: 'oof',
      });
    }
    // Evening block: hours_end → end of day
    if (endMin < 24 * 60) {
      const eveningStart = dayStart.plus({ minutes: endMin });
      blocks.push({
        start: eveningStart.toISO() ?? `${d.toISODate()}T${spec.hours_end}:00`,
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
  dismissCalendarIssue,
  buildIssueKey,
} from '../../db';
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
    return DateTime.fromISO(clean).setZone(tz);
  }
  // No offset → Graph returned it in the event's timezone (via Prefer header)
  return DateTime.fromISO(clean, { zone: tz });
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
  attendees?: string[];
}

export function processCalendarEvents(
  events: CalendarEvent[],
  ownerEmail: string,
  ownerName: string,
  timezone: string,
): ProcessedEvent[] {
  const result: ProcessedEvent[] = [];

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
      attendees: attendeeNames.length > 0 ? attendeeNames : undefined,
    });
  }

  return result;
}

// ── Calendar analysis (detect issues) ────────────────────────────────────────

interface CalendarIssue {
  type: 'oof_with_meetings' | 'no_buffer' | 'no_lunch' | 'back_to_back' | 'overlap' | 'work_on_day_off';
  severity: 'high' | 'medium' | 'low';
  detail: string;
  suggestedFix?: string;
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
    hasLunch: boolean;
    lunchGap?: string;        // "12:30–13:15"
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

  const lunch = profile.schedule.lunch;
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

    // Work hours for this day type
    const hoursStart = isOffice
      ? profile.schedule.office_days.hours_start
      : profile.schedule.home_days.hours_start ?? '09:00';
    const hoursEnd = isOffice
      ? profile.schedule.office_days.hours_end
      : profile.schedule.home_days.hours_end ?? '19:00';

    const [wsH, wsM] = hoursStart.split(':').map(Number);
    const [weH, weM] = hoursEnd.split(':').map(Number);
    const workStartMin = wsH * 60 + wsM;
    const workEndMin   = weH * 60 + weM;
    const workTotalMin = workEndMin - workStartMin;

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
        stats: { meetingCount: workMeetingsOnDayOff.length, totalMeetingMin: 0, freeMinInWorkHours: 0, hasLunch: false },
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

    // v2.0.8 — strict lunch semantics. hasLunch is ONLY true when an actual
    // "Lunch" event is booked in the lunch window. A free gap is not
    // sufficient — the owner wants a blocked calendar event, otherwise the
    // gap gets eaten by something else mid-day. If no lunch event exists,
    // we still compute the largest free gap inside the lunch window so the
    // no_lunch issue can suggest a specific time ("Want me to block 30 min
    // starting at 12:30?"), but hasLunch stays false.
    const [lsH, lsM] = lunch.preferred_start.split(':').map(Number);
    const [leH, leM] = lunch.preferred_end.split(':').map(Number);
    const lunchWindowStart = lsH * 60 + lsM;
    const lunchWindowEnd   = leH * 60 + leM;
    const minLunchMin = lunch.duration_minutes ?? 30;

    let hasLunch = false;
    let lunchGap: string | undefined;

    // Check if a "Lunch" event is already booked in the lunch window
    const lunchEvent = timedMeetings.find(e => {
      const subj = (e.subject || '').toLowerCase();
      if (!subj.includes('lunch')) return false;
      const [sh, sm] = e._localStartTime.split(':').map(Number);
      const evStart = sh * 60 + sm;
      return evStart >= lunchWindowStart && evStart < lunchWindowEnd;
    });
    if (lunchEvent) {
      hasLunch = true;
      lunchGap = `${lunchEvent._localStartTime}–${lunchEvent._localEndTime}`;
    }

    // Find the best free gap inside the lunch window — used ONLY for the
    // suggestedFix when no lunch event exists. Does NOT flip hasLunch.
    let bestGapStart: number | undefined;
    let bestGapSize = 0;
    if (!hasLunch) {
      for (const gap of gaps) {
        const overlapStart = Math.max(gap.start, lunchWindowStart);
        const overlapEnd   = Math.min(gap.end, lunchWindowEnd);
        const overlapSize = overlapEnd - overlapStart;
        if (overlapSize >= minLunchMin && overlapSize > bestGapSize) {
          bestGapStart = overlapStart;
          bestGapSize = overlapSize;
        }
      }
    }

    if (!hasLunch && !lunch.can_skip) {
      const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
      const suggestedStart = bestGapStart !== undefined
        ? fmt(bestGapStart)
        : lunch.preferred_start;
      const suggestedFix = bestGapStart !== undefined
        ? `Want me to block ${minLunchMin} min at ${suggestedStart}?`
        : `No free gap in your lunch window — want me to bump something and block ${minLunchMin} min at ${suggestedStart}?`;
      issues.push({
        type: 'no_lunch',
        severity: 'medium',
        detail: `No lunch event booked`,
        suggestedFix,
      });
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
        hasLunch,
        lunchGap,
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
        return processCalendarEvents(rawEvents, userEmail, context.profile.user.name, timezone);
      }

      case 'analyze_calendar': {
        const rawEvents = await getCalendarEvents(
          userEmail,
          args.start_date as string,
          args.end_date as string,
          timezone,
        );
        const processed = processCalendarEvents(rawEvents, userEmail, context.profile.user.name, timezone);
        const dismissedKeys = getDismissedIssueKeys(
          context.profile.user.slack_user_id,
          args.start_date as string,
          args.end_date as string,
        );
        return analyzeCalendar(processed, args.start_date as string, args.end_date as string, context.profile, dismissedKeys);
      }

      case 'dismiss_calendar_issue': {
        const issueKey = buildIssueKey(args.issue_type as string, args.detail as string);
        dismissCalendarIssue(
          context.profile.user.slack_user_id,
          args.event_date as string,
          args.issue_type as string,
          issueKey,
          args.detail as string,
          (args.resolution as 'dismissed' | 'resolved') ?? 'dismissed',
        );
        return { dismissed: true, issue_key: issueKey };
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
                'The Azure app needs Calendars.Read application permission granted by a Reflectiz tenant admin. ' +
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
          try {
            return await findAvailableSlots({
              userEmail,
              timezone,
              durationMinutes: args.duration_minutes as number,
              attendeeEmails: args.attendee_emails as string[],
              searchFrom: args.search_from as string,
              searchTo: args.search_to as string,
              preferMorning: args.prefer_morning as boolean | undefined,
              meetingMode: mode as import('../../connectors/graph/calendar').MeetingMode,
              travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
              minBufferHours: (context.senderRole === 'owner' || context.isOwnerInGroup === true)
                ? 1
                : (context.profile.meetings.min_slot_buffer_hours ?? 4),
              profile: context.profile,
            });
          } catch (err) {
            if (err instanceof GraphPermissionError) {
              return {
                error: 'calendar_permission_denied',
                message: 'I can read your calendar but I don\'t have permission to check other people\'s availability. ' +
                  'The Azure app needs Calendars.Read application permission granted by a Reflectiz tenant admin. ' +
                  'Tell the user you cannot find a common slot right now due to a permissions issue, ' +
                  'and ask if they know when those people are free so you can proceed.',
              };
            }
            throw err;
          }
        }

      case 'create_meeting': {
        const attendees = args.attendees as Array<{ name: string; email: string }>;
        const assistantEmail = context.profile.assistant.email;
        const ownerEmail = context.profile.user.email;

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
        const { DateTime } = await import('luxon');
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

        return createMeeting({
          userEmail,
          timezone,
          subject:    args.subject  as string,
          start:      args.start    as string,
          end:        args.end      as string,
          attendees,
          body:       args.body     as string | undefined,
          isOnline:   args.is_online as boolean,
          location:   args.location  as string | undefined,
          categories:  args.category ? [args.category as string] : ['Meeting'],  // default fallback
          sensitivity: args.category === 'Private' ? 'private' : undefined,
        }).then(meetingId => ({
          success: true,
          meetingId,
          // v1.8.3 — past-tense summary the reply can quote verbatim. Prevents
          // Sonnet from narrating the post-action calendar state as a fresh
          // discovery instead of the result of her own action (issue #26 bug 1).
          action_summary: `Booked '${args.subject}' for ${formatIsoTime(args.start as string)}–${formatIsoTime(args.end as string)}.`,
        }));
      }

      case 'update_meeting': {
        // v2.1.4 — attendee-only guard. If the event's organizer is not the
        // owner, the owner is an ATTENDEE on someone else's meeting. Graph
        // rejects PATCH from non-organizers, but the error message is
        // unhelpful; refuse early with a clear human message so Maelle
        // doesn't offer a fake "I'll add the location" then silently fail.
        try {
          const { getEventOrganizer } = await import('../../connectors/graph/calendar');
          const organizer = await getEventOrganizer(userEmail, args.meeting_id as string);
          if (organizer && organizer.address !== userEmail.toLowerCase()) {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            logger.info('update_meeting refused — owner is attendee, not organizer', {
              meetingId: args.meeting_id, organizer: organizer.address,
            });
            return {
              error: 'not_organizer',
              meeting_subject: args.meeting_subject,
              organizer_name: organizer.name ?? organizer.address,
              organizer_email: organizer.address,
              message: `Can't modify "${args.meeting_subject}" — ${organizer.name ?? organizer.address} organized it, ${ownerFirst} is just an attendee. I can message them to request the change, or decline on ${ownerFirst}'s side. I cannot change the subject, location, or body of a meeting he didn't organize.`,
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
          subject:    args.new_subject as string | undefined,
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
                const fromIso = DateTime.fromMillis(startMs - 60_000).toUTC().toISO();
                const toIso = DateTime.fromMillis(endDt.toMillis() + 60_000).toUTC().toISO();
                let validSlots: Array<{ start: string }> = [];
                if (fromIso && toIso) {
                  validSlots = await findAvailableSlots({
                    userEmail,
                    timezone,
                    durationMinutes: durationMin,
                    attendeeEmails: [userEmail],
                    searchFrom: fromIso,
                    searchTo: toIso,
                    profile: context.profile,
                  });
                }
                const matches = validSlots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000);
                if (!matches) {
                  const ownerFirst = context.profile.user.name.split(' ')[0];
                  logger.info('move_meeting colleague-path refused — new slot breaks owner rules', {
                    meetingId: args.meeting_id, newStart, newEnd, requester: context.userId,
                  });
                  return {
                    needs_owner_approval: true,
                    reason: 'not_rule_compliant',
                    meeting_subject: args.meeting_subject,
                    requested_start: newStart,
                    requested_end: newEnd,
                    message: `That time breaks one of ${ownerFirst}'s scheduling rules (work hours, work days, lunch window, or a conflict). I can't move it on my own — I'll check with ${ownerFirst} and come back to you. Call create_approval(kind=meeting_reschedule) with the requested slot so he can decide.`,
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
        try {
          const { getEventOrganizer } = await import('../../connectors/graph/calendar');
          const organizer = await getEventOrganizer(userEmail, args.meeting_id as string);
          if (organizer && organizer.address !== userEmail.toLowerCase()) {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            logger.info('move_meeting refused — owner is attendee, not organizer', {
              meetingId: args.meeting_id, organizer: organizer.address,
            });
            return {
              error: 'not_organizer',
              meeting_subject: args.meeting_subject,
              organizer_name: organizer.name ?? organizer.address,
              organizer_email: organizer.address,
              message: `Can't move "${args.meeting_subject}" — ${organizer.name ?? organizer.address} organized it, ${ownerFirst} is just an attendee. I can message them to request a reschedule, or decline on ${ownerFirst}'s side. I cannot change the time of a meeting he didn't organize.`,
            };
          }
        } catch (err) {
          logger.warn('move_meeting attendee-only guard threw — proceeding', { err: String(err) });
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

        await updateMeeting({
          userEmail,
          timezone,
          meetingId: args.meeting_id as string,
          start: args.new_start as string,
          end: args.new_end as string,
        });
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
            });
          } catch (err) {
            logger.warn('shadowNotify after colleague reschedule failed — continuing', { err: String(err) });
          }
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
        return {
          success: true,
          deleted: args.meeting_subject,
          // v1.8.3 — past-tense summary for owner-visible reply. Issue #26 bug 1.
          action_summary: `Cancelled '${args.meeting_subject}'.`,
        };
      }

      // v2.0.7 — legacy escalate_to_user / store_request / get_pending_requests /
      // resolve_request cases retired. See tool-declaration comment above.

      case 'find_slack_user': {
        if (!context.app) return { error: 'App not available in context' };
        try {
          const token = context.profile.assistant.slack.bot_token;
          const result = await context.app.client.users.list({ token, limit: 200 });
          const members = (result.members as any[]) ?? [];
          const query = (args.name as string).toLowerCase();
          const matches = members.filter(m =>
            !m.deleted && !m.is_bot &&
            (m.real_name?.toLowerCase().includes(query) ||
             m.name?.toLowerCase().includes(query) ||
             m.profile?.display_name?.toLowerCase().includes(query))
          ).map(m => ({
            slack_id: m.id,
            name: m.real_name || m.profile?.display_name || m.name,
            timezone: m.tz || 'UTC',
            email: m.profile?.email,
          }));
          logger.info('find_slack_user', { query: args.name, matches: matches.length });
          return { matches, count: matches.length };
        } catch (err) {
          logger.error('find_slack_user failed', { err: String(err) });
          return { error: String(err) };
        }
      }

      case 'coordinate_meeting': {
        if (!context.app) return { error: 'App not available in context' };
        return { error: 'Coordination feature initializing — please try again.' };
      }

      default:
        return null; // not our tool
    }
  }

}
