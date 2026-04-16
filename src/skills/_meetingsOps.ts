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
import logger from '../utils/logger';
import { DateTime } from 'luxon';
import type { SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import {
  getCalendarEvents,
  type CalendarEvent,
  getFreeBusy,
  findAvailableSlots,
  createMeeting,
  deleteMeeting,
  updateMeeting,
  GraphPermissionError,
} from '../connectors/graph/calendar';
import {
  enqueueApproval,
  createPendingRequest,
  resolvePendingRequest,
  getDb,
  auditLog,
  getDismissedIssueKeys,
  dismissCalendarIssue,
  buildIssueKey,
} from '../db';

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
  type: 'oof_with_meetings' | 'no_buffer' | 'no_lunch' | 'back_to_back' | 'work_on_day_off';
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

      // Back-to-back check
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

    // Lunch check — first look for an existing lunch event, then for a free gap
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
      if (!subj.includes('lunch') && !subj.includes('ארוחת')) return false;
      const [sh, sm] = e._localStartTime.split(':').map(Number);
      const evStart = sh * 60 + sm;
      return evStart >= lunchWindowStart && evStart < lunchWindowEnd;
    });
    if (lunchEvent) {
      hasLunch = true;
      lunchGap = `${lunchEvent._localStartTime}–${lunchEvent._localEndTime}`;
    }

    // If no lunch event, check for a free gap in the lunch window
    if (!hasLunch) {
      for (const gap of gaps) {
        const overlapStart = Math.max(gap.start, lunchWindowStart);
        const overlapEnd   = Math.min(gap.end, lunchWindowEnd);
        if (overlapEnd - overlapStart >= minLunchMin) {
          hasLunch = true;
          const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
          lunchGap = `${fmt(overlapStart)}–${fmt(overlapEnd)}`;
          break;
        }
      }
    }

    if (!hasLunch && !lunch.can_skip) {
      const [lsH2, lsM2] = lunch.preferred_start.split(':').map(Number);
      const suggestedStart = `${String(lsH2).padStart(2,'0')}:${String(lsM2).padStart(2,'0')}`;
      issues.push({
        type: 'no_lunch',
        severity: 'medium',
        detail: `No lunch gap of ≥${minLunchMin} min between ${lunch.preferred_start}–${lunch.preferred_end}`,
        suggestedFix: `Want me to block ${minLunchMin} min starting around ${suggestedStart}?`,
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

  /**
   * DEAD CODE: getTools is defined here but never invoked — MeetingsSkill
   * owns the tool definitions. The array is kept because removing it requires
   * also reorganizing local references to profile-shape-dependent descriptions.
   * TODO (1.7+): inline the relevant direct-ops tool descriptions into
   * meetings.ts and delete this method entirely.
   */
  getTools(profile: UserProfile): unknown[] {
    return [
      {
        name: 'get_calendar',
        description: "Read the user's calendar events for a given date range. Use for specific scheduling decisions (finding slots, checking a meeting exists, etc.). For weekly reviews or issue detection, use analyze_calendar instead. Also call this before sending any reminder or message that references a specific meeting — always verify the exact title and time from the calendar before using it.",
        input_schema: {
          type: 'object',
          properties: {
            start_date: { type: 'string', description: 'Start date YYYY-MM-DD in the user\'s local timezone. Use the DATE LOOKUP table — never calculate.' },
            end_date: { type: 'string', description: 'End date YYYY-MM-DD in the user\'s local timezone.' },
          },
          required: ['start_date', 'end_date'],
        },
      },
      {
        name: 'analyze_calendar',
        description: `Analyze the calendar for a date range and return a structured report of issues per day.
Use this when asked: "any issues next week?", "what's wrong with my calendar?", "check my schedule", "do I have lunch?", "am I too busy?".

Returns per-day analysis including:
- Issues: OOF with meetings, insufficient buffer time, missing lunch, back-to-back meetings, work meetings on days off
- Stats: meeting count, total meeting time, free time in work hours, lunch availability
- Events: list of your own meetings for that day (private events masked as [Private])

Work days and non-work days are handled separately. Days off only appear if there's a work meeting scheduled.`,
        input_schema: {
          type: 'object',
          properties: {
            start_date: { type: 'string', description: 'Start date YYYY-MM-DD. Use the DATE LOOKUP table — never calculate.' },
            end_date:   { type: 'string', description: 'End date YYYY-MM-DD.' },
          },
          required: ['start_date', 'end_date'],
        },
      },
      {
        name: 'dismiss_calendar_issue',
        description: `Mark a calendar issue as acknowledged so it won't be flagged again in future checks.
Use this when the user says "that's fine", "I'm ok with that", "no need to fix", "leave it", or similar about a specific calendar issue.
This prevents the same issue from being re-reported in the daily check or when the user asks about conflicts again.`,
        input_schema: {
          type: 'object',
          properties: {
            event_date: { type: 'string', description: 'Date of the issue YYYY-MM-DD' },
            issue_type: { type: 'string', enum: ['back_to_back', 'no_buffer', 'no_lunch', 'oof_with_meetings', 'work_on_day_off', 'overlap'], description: 'Type of the calendar issue' },
            detail: { type: 'string', description: 'Brief description of the specific issue (e.g. "Quick sync with Yael at 12:15 starts right after lunch")' },
            resolution: { type: 'string', enum: ['dismissed', 'resolved'], description: '"dismissed" = user is ok with it, "resolved" = the issue was fixed' },
          },
          required: ['event_date', 'issue_type', 'detail'],
        },
      },
      {
        name: 'get_free_busy',
        description: `Check free/busy data for a calendar — use ONLY for checking ${profile.user.name}'s own calendar, or when a colleague explicitly asks "when is ${profile.user.name.split(' ')[0]} free?".

NEVER use this to check a colleague's availability before scheduling a meeting. Maelle's job is to DM the colleague and ask — not to read their calendar. Use coordinate_meeting instead.`,
        input_schema: {
          type: 'object',
          properties: {
            emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses to check' },
            start_date: { type: 'string', description: 'Start of range in ISO 8601 format' },
            end_date: { type: 'string', description: 'End of range in ISO 8601 format' },
          },
          required: ['emails', 'start_date', 'end_date'],
        },
      },
      {
        name: 'find_available_slots',
        description: `Find open slots on ${profile.user.name}'s own calendar — useful when you need to know what times are free before proposing options.

NEVER call this directly for colleague scheduling. The coordinate_meeting tool already calls this internally and then DMs the colleagues. Calling it yourself would bypass the entire DM flow.

Before calling: ASK two human questions (don't list "meeting_mode" options — that's robotic):
  • "In person or online?"
  • If in-person and not at ${profile.user.name.split(' ')[0]}'s office: "Where?" + "Roughly how long is the trip each way?"
Then YOU decide the meeting_mode value:
  • online / Teams / Zoom / video → 'online'
  • in person at the office → 'in_person'
  • in person somewhere else / client / external → 'custom' + travel_buffer_minutes
  • whatever works / either → 'either'`,
        input_schema: {
          type: 'object',
          properties: {
            duration_minutes: { type: 'number', enum: [10, 25, 40, 55] },
            attendee_emails: { type: 'array', items: { type: 'string' } },
            search_from: { type: 'string', description: 'Start of search window in ISO 8601 format' },
            search_to: { type: 'string', description: 'End of search window in ISO 8601 format (auto-expanded up to 21 days if fewer than 3 slots found)' },
            prefer_morning: { type: 'boolean', description: 'Prefer morning slots in the user timezone' },
            meeting_mode: {
              type: 'string',
              enum: ['in_person', 'online', 'either', 'custom'],
              description: 'REQUIRED. Ask the owner if you do not know.',
            },
            travel_buffer_minutes: {
              type: 'number',
              description: 'Only for meeting_mode=custom. One-way travel time in minutes; pads slots on BOTH sides.',
            },
          },
          required: ['duration_minutes', 'attendee_emails', 'search_from', 'search_to', 'meeting_mode'],
        },
      },
      {
        name: 'create_meeting',
        description: `Create a new calendar event. Only call when all scheduling rules are satisfied.

MEETING TITLE RULES:
- 1:1 meeting: "Quick sync with [Name]" or "[Topic] with [Name]" if topic is known
- Group meeting (3+ people): use the topic/purpose e.g. "Q2 Planning", "Customer Review"
- Never use vague titles like "Quick sync" or "Meeting" without a name or context
- If you don't know the purpose, ask before creating

ATTENDEES:
- Include all participants the user mentioned
- Do NOT add the assistant as an attendee — she has calendar access and does not need an invite

LOCATION RULES (follow exactly):
External = any attendee whose email does not end with @${profile.user.email.split('@')[1]} (no Slack access)
Internal = all attendees share the @${profile.user.email.split('@')[1]} domain

- Any external attendee → is_online=true, OMIT location (Graph auto-generates the Teams meeting + link; passing "Microsoft Teams" as a location string breaks the Outlook link)
- Internal only + home day → is_online=false, location="Slack Huddle", note "Join via Slack huddle" in body
- Internal only + office day + 1-2 people → is_online=true, location="${profile.user.name.split(' ')[0]}'s office" (physical location stays; Teams link added as backup)
- Internal only + office day + 3+ people → is_online=true, location="Meeting Room"${profile.meetings.room_email ? ', add_room_email=true' : ''}
- User says "Teams" explicitly → is_online=true, OMIT location
- User says "Slack" or "huddle" → is_online=false, note in body
- Never pass "Microsoft Teams" / "Teams" as the location string — that's what is_online=true is for.

CATEGORY RULES — always set a category:
- "Meeting"  → any regular meeting between people (default for meetings)
- "Physical" → meeting that MUST happen in person; people are physically coming to the office, or it's an event that can't be moved to huddle/remote/Teams
- "Logistic" → any non-meeting calendar block: lunch, driving time, travel buffer, personal time block, blocked focus time
- "Private"  → personal/private event; automatically marked private (attendees see no details)
- Do NOT use: Cadence, Weekly, Vacation — those are owner-managed categories

WORK DAY ENFORCEMENT:
- NEVER book on Saturday
- Check the user's office_days and home_days — only book within those days
- If the only available slot is outside work days, ask the user first`,
        input_schema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Meeting title — must be specific and meaningful' },
            start: { type: 'string', description: 'ISO 8601 datetime in user local timezone' },
            end: { type: 'string', description: 'ISO 8601 datetime in user local timezone' },
            attendees: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, email: { type: 'string' } },
                required: ['name', 'email'],
              },
              description: 'All attendees including the assistant email',
            },
            body: { type: 'string', description: 'Meeting agenda or context' },
            is_online: { type: 'boolean', description: 'True = generate Teams meeting link' },
            location: { type: 'string', description: 'Location display name' },
            category: {
              type: 'string',
              enum: ['Meeting', 'Physical', 'Logistic', 'Private'],
              description: 'Outlook category. Meeting = regular meeting; Physical = must be in-person at office; Logistic = non-meeting block (lunch, travel, buffer); Private = personal/private event (will automatically be marked private so attendees see no details)',
            },
            add_room_email: { type: 'boolean', description: `If true, also add the configured room_email (${profile.meetings.room_email || 'not configured'}) to book the physical meeting room` },
            override_work_day: { type: 'boolean', description: 'Set to true if the user has explicitly confirmed they want to book outside normal work days' },
          },
          required: ['subject', 'start', 'end', 'attendees', 'is_online', 'category'],
        },
      },
      {
        name: 'move_meeting',
        description: `Move (reschedule) an existing meeting to a new time slot.
ALWAYS prefer this over delete + recreate — it preserves attendees, the Teams link, and meeting history.
Only call AFTER the user has confirmed the new time. Never claim success until the tool returns it.`,
        input_schema: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string', description: 'Event ID from get_calendar results' },
            meeting_subject: { type: 'string', description: 'Meeting title — for confirmation message' },
            new_start: { type: 'string', description: 'New start time in ISO 8601 format in user local timezone' },
            new_end: { type: 'string', description: 'New end time in ISO 8601 format in user local timezone' },
          },
          required: ['meeting_id', 'meeting_subject', 'new_start', 'new_end'],
        },
      },
      {
        name: 'update_meeting',
        description: `Update metadata on an existing meeting — category, subject, or body — without rescheduling it.
Use this to set or fix a category on an event, rename a meeting, or update its description.
Never claim the update succeeded until the tool returns success.`,
        input_schema: {
          type: 'object',
          properties: {
            meeting_id:      { type: 'string', description: 'Event ID from get_calendar results' },
            meeting_subject: { type: 'string', description: 'Meeting title — for confirmation message' },
            category:        { type: 'string', enum: ['Meeting', 'Physical', 'Logistic', 'Private'], description: 'Outlook category to set on the event' },
            new_subject:     { type: 'string', description: 'New meeting title, if renaming' },
          },
          required: ['meeting_id', 'meeting_subject'],
        },
      },
      {
        name: 'delete_meeting',
        description: `Cancel and permanently delete a meeting from the calendar.
Before calling this tool, ask the user naturally to confirm (e.g. "Are you sure you want to cancel [meeting]?").
Only call AFTER they explicitly say yes. Do NOT use escalate_to_user for delete confirmation — just ask inline.
Never claim you deleted something until the tool returns success.`,
        input_schema: {
          type: 'object',
          properties: {
            meeting_id: {
              type: 'string',
              description: 'The event ID from get_calendar results',
            },
            meeting_subject: {
              type: 'string',
              description: 'Meeting title — for confirmation message to user',
            },
          },
          required: ['meeting_id', 'meeting_subject'],
        },
      },
      {
        name: 'escalate_to_user',
        description: "Flag an action for the user's approval. Use when rules would be broken, protected meetings are affected, or judgment is required.",
        input_schema: {
          type: 'object',
          properties: {
            action_type: { type: 'string', enum: ['reschedule', 'cancel', 'rule_exception', 'unclear_priority', 'other'] },
            summary: { type: 'string', description: 'What needs approval and why, including what was already tried' },
            payload: { type: 'object', additionalProperties: true },
          },
          required: ['action_type', 'summary', 'payload'],
        },
      },
      {
        name: 'store_request',
        description: 'Save a scheduling request to follow up on later. Also call this whenever you tell a colleague "I\'ll flag this for the owner" or "I\'ll pass that along" — only say you\'ve flagged something if this tool was actually called.',
        input_schema: {
          type: 'object',
          properties: {
            requester: { type: 'string' },
            subject: { type: 'string' },
            participants: { type: 'array', items: { type: 'string' } },
            priority: { type: 'string', enum: ['highest', 'high', 'medium', 'low'] },
            duration_min: { type: 'number', enum: [10, 25, 40, 55] },
            notes: { type: 'string' },
          },
          required: ['requester', 'subject', 'participants', 'priority', 'duration_min'],
        },
      },
      {
        name: 'get_pending_requests',
        description: 'Retrieve all open scheduling requests.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'resolve_request',
        description: 'Mark a pending request as resolved or cancelled. Call this BEFORE telling the user you cleared/removed/resolved something — never claim it happened without calling this first.',
        input_schema: {
          type: 'object',
          properties: {
            request_id: { type: 'string', description: 'The request ID from get_pending_requests' },
            resolution: { type: 'string', enum: ['resolved', 'cancelled'], description: 'resolved = completed, cancelled = no longer needed' },
          },
          required: ['request_id', 'resolution'],
        },
      },
      {
        name: 'find_slack_user',
        description: 'Find a Slack user by name to get their Slack ID and timezone. Call this before starting coordination if you only know a name.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The name to search for (first name, last name, or full name)' },
          },
          required: ['name'],
        },
      },
      {
        name: 'coordinate_meeting',
        description: 'Start an outreach coordination job — Maelle will DM the colleague to find a time, then book and report back when confirmed. Use when the owner asks to book a meeting with someone.',
        input_schema: {
          type: 'object',
          properties: {
            colleague_slack_id: { type: 'string', description: 'Slack user ID of the colleague to coordinate with (use find_slack_user if unknown)' },
            colleague_name: { type: 'string', description: 'Display name of the colleague' },
            colleague_tz: { type: 'string', description: 'Timezone of the colleague (IANA format e.g. Asia/Jerusalem, America/New_York, Europe/London). Use the user timezone as fallback if unknown.' },
            meeting_subject: { type: 'string', description: 'Brief subject/title for the meeting' },
            meeting_topic: { type: 'string', description: 'What the meeting is about — include only if the owner mentioned it or if it is clearly known. Omit if not sure.' },
            duration_min: { type: 'number', enum: [10, 25, 40, 55], description: 'Meeting duration in minutes' },
          },
          required: ['colleague_slack_id', 'colleague_name', 'colleague_tz', 'meeting_subject', 'duration_min'],
        },
      },
    ];
  }

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
          return await getFreeBusy(userEmail, args.emails as string[], args.start_date as string, args.end_date as string, timezone);
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
              meetingMode: mode as import('../connectors/graph/calendar').MeetingMode,
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
        }).then(meetingId => ({ success: true, meetingId }));
      }

      case 'update_meeting': {
        await updateMeeting({
          userEmail,
          timezone,
          meetingId:  args.meeting_id  as string,
          subject:    args.new_subject as string | undefined,
          categories: args.category ? [args.category as string] : undefined,
        });
        auditLog({
          action: 'update_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          details: { subject: args.meeting_subject, category: args.category, new_subject: args.new_subject },
          outcome: 'success',
        });
        return { success: true, updated: args.meeting_subject, category: args.category ?? null, new_subject: args.new_subject ?? null };
      }

      case 'move_meeting': {
        await updateMeeting({
          userEmail,
          timezone,
          meetingId: args.meeting_id as string,
          start: args.new_start as string,
          end: args.new_end as string,
        });
        auditLog({
          action: 'move_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          details: { subject: args.meeting_subject, new_start: args.new_start, new_end: args.new_end },
          outcome: 'success',
        });
        return { success: true, moved: args.meeting_subject, new_start: args.new_start, new_end: args.new_end };
      }

      case 'delete_meeting': {
        await deleteMeeting(userEmail, args.meeting_id as string);
        auditLog({
          action: 'delete_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          details: { subject: args.meeting_subject },
          outcome: 'success',
        });
        return { success: true, deleted: args.meeting_subject };
      }

      case 'escalate_to_user': {
        const id = enqueueApproval({
          action_type: args.action_type as string,
          payload: args.payload as Record<string, unknown>,
          reason: args.summary as string,
          slack_msg_ts: context.threadTs,
        });
        return { queued: true, approvalId: id, requiresApproval: true };
      }

      case 'store_request': {
        const requestId = createPendingRequest({
          source: context.channel,
          thread_ts: context.threadTs,
          channel_id: context.channelId,
          requester: args.requester as string,
          subject: args.subject as string,
          participants: args.participants as string[],
          priority: args.priority as string,
          duration_min: args.duration_min as number,
          notes: args.notes as string | undefined,
          status: 'open',
        });
        return { saved: true, requestId };
      }

      case 'get_pending_requests': {
        const db = getDb();
        return db.prepare(`SELECT * FROM pending_requests WHERE status = 'open' ORDER BY created_at DESC`).all();
      }

      case 'resolve_request': {
        const ok = resolvePendingRequest(args.request_id as string, args.resolution as 'resolved' | 'cancelled');
        return ok
          ? { success: true, request_id: args.request_id, status: args.resolution }
          : { success: false, error: 'Request not found or already closed' };
      }

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

  getSystemPromptSection(profile: UserProfile): string {
    const { schedule, meetings, priorities, vip_contacts, behavior, rescheduling, interviews } = profile;
    const ns = schedule.night_shift;

    const protectedList = meetings.protected
      .map(p => `- "${p.name}" → IMMUTABLE — cannot be changed under any circumstance, even with approval`)
      .join('\n');

    const vipList = vip_contacts.length > 0
      ? vip_contacts.map(v => `- ${v.name}${v.email ? ` (${v.email})` : ''} → ${v.priority} priority. ${v.note || ''}`).join('\n')
      : 'None configured.';

    const reschedulingLines = Object.entries(rescheduling)
      .map(([cat, rule]) => {
        const desc = 'description' in rule && rule.description ? ` — ${rule.description}` : '';
        switch (rule.type) {
          case 'immutable': return `- "${cat}": IMMUTABLE${desc}`;
          case 'flexible': return `- "${cat}": FLEXIBLE (${rule.flexibility.replace(/_/g, ' ')})${desc}`;
          case 'approval_required': return `- "${cat}": REQUIRES APPROVAL${desc}`;
        }
      }).join('\n');

    const immutableList = Object.entries(rescheduling)
      .filter(([, r]) => r.type === 'immutable')
      .map(([cat]) => `"${cat}"`).join(', ') || 'none';

    const autonomyNote = behavior.autonomous_meeting_creation
      ? '✓ You MAY create new meetings without approval when all rules are satisfied.'
      : '✗ All meeting creation requires approval.';

    return `
═══════════════════════════════════════════════
SKILL: SCHEDULING
═══════════════════════════════════════════════
Your primary active skill. Get to ONE good outcome — not a list of options.

MEETING PRIORITIES
Highest: ${priorities.highest.join(', ')}
High: ${priorities.high.join(', ')}
Medium: ${priorities.medium.join(', ')}
Low: ${priorities.low.join(', ')}

VIP CONTACTS
${vipList}

PROTECTED MEETINGS (ABSOLUTE — CANNOT BE OVERRIDDEN)
${protectedList}

WORK SCHEDULE
Office days (${schedule.office_days.days.join(', ')}): ${schedule.office_days.hours_start}–${schedule.office_days.hours_end}
  → ${schedule.office_days.notes || 'Prefer for important and external meetings'}
  ${meetings.physical_meetings_require_office_day ? '→ Physical meetings MUST be on office days' : ''}
Home/remote days (${schedule.home_days.days.join(', ')}): ${schedule.home_days.hours_start}–${schedule.home_days.hours_end}
  → ${schedule.home_days.notes || 'Prefer for lighter and internal meetings'}

SCHEDULING RULES
Allowed durations: ${meetings.allowed_durations.join(', ')} minutes only
Buffer between meetings: ~${meetings.buffer_minutes} min — already baked into the allowed durations (10/25/40/55 min always end 5 min before the next quarter-hour).
Slot start times: ALWAYS :00 / :15 / :30 / :45. Never propose :05, :10, :20, :35, :40, :50 etc. — not even to "recover" a few minutes of buffer.
Buffer is a preference you can suggest, NOT a reason to refuse or rewrite an exact time the owner gave.
Adjacency vs overlap: a meeting ending at 13:00 and another starting at 13:00 is ADJACENT (0 gap), NOT overlapping. Never call that an "overlap."
When the owner gives an exact start time ("move X to 1pm"):
  - If the slot has no real overlap → do it. Don't offer a menu of "cleaner" alternatives.
  - If it'll be back-to-back with a prior meeting, you MAY add one short soft offer: "That'll be back-to-back — I can do 13:15 and get you a short break, want that?" Then wait. Don't pile on 2–3 alternatives or ask three questions.
  - If the slot actually overlaps (real time conflict) → say so plainly and offer one nearby :00/:15/:30/:45 slot.
The "aim for next :00/:15/:30/:45" preference is for when YOU are choosing a slot to PROPOSE to an external — not a reason to push the owner's own internal meetings away from back-to-back.
Minimum buffer from now: ${meetings.min_slot_buffer_hours ?? 4}h for colleagues — reduced to 1h when the owner requests (owner can book urgent same-day meetings)
Protected focus time: office days ~${meetings.free_time_per_office_day_hours}h, home days ~${meetings.free_time_per_home_day_hours ?? meetings.free_time_per_office_day_hours}h; in chunks of ≥${meetings.thinking_time_min_chunk_minutes ?? 30} min. Days that would drop below their type's threshold are skipped when searching for slots.
Lunch: ${schedule.lunch.duration_minutes} min between ${schedule.lunch.preferred_start}–${schedule.lunch.preferred_end} ${schedule.lunch.can_skip ? '(can skip if needed)' : '(protected — never book over it)'} — slots that would eliminate lunch are automatically skipped
Timezone: local=${schedule.timezone_preferences.local_participants}, remote=${schedule.timezone_preferences.remote_participants}

NARRATING AVAILABILITY IN CHAT — when a colleague asks "does ${profile.user.name.split(' ')[0]} have X min?":
- Offer slots of the REQUESTED duration, placed inside available gaps. Do NOT quote the raw gap size. If they asked for 25 min and you have a 45-min gap at 10:00, say "10:00–10:25 works" — not "you have 10:00–10:45 free (45 min)".
- Aggregate contiguous gaps. If 10:00–10:30 and 10:30–11:00 are both free, that's "10:00–11:00 (1 hour)" — one slot, not two. Same for back-to-back 15-min gaps.
- Pick :00/:15/:30/:45 start times inside the gap. Prefer the earliest fit unless the gap is very long, in which case offer one earlier and one later.
- Stay inside working hours and respect lunch / protected focus time / minimum buffer-from-now.
- If the requested duration doesn't fit any gap that day, say so plainly and offer the closest alternative day — don't offer a shorter slot unless they asked.

OFFERING ALTERNATIVES — when proposing multiple options:
- **Max 3 options** unless the person asks for more. More than 3 is noise, not help.
- **Minimum 30-minute spacing between options on the same day**. Offer 10:15 and 10:45 or 12:00 and 12:30 — never 12:00, 12:15, 12:30 as three separate picks; the person can't meaningfully choose between adjacent 15-min offsets.
- **Pack efficiently to minimize gaps**. If a meeting ends at 12:00 and the gap is clean (no lunch conflict, no buffer violation, no thinking-time break planned), start the next slot at 12:15 rather than 13:00 — tight scheduling beats loose scheduling. Only spread when there's a rule-driven reason (lunch, buffer, focus).
- If someone replies wanting a specific time you didn't originally propose (e.g. "can you do 12:15?"), book it if it's actually free and doesn't violate a rule. The 30-min spacing rule is for YOUR proactive proposals, not for refusing the person's specific ask.
- **Don't annotate each slot with who's adjacent** ("10:15 right after Yael & Idan"). Just list start–end. The person doesn't need your calendar map to pick a time.

AUTONOMY
${autonomyNote}
✗ Rescheduling approval_required meetings → needs approval
✗ Cancelling any meeting → needs approval
✗ Breaking any rule → needs approval
Immutable categories (${immutableList}) cannot be changed even with approval.

RESCHEDULING BY CATEGORY
${reschedulingLines}

NEGOTIATION (before escalating)
Style: ${behavior.rescheduling_style}. Try alternatives for ~${behavior.escalate_after_days} days before escalating.
Steps: 1) try other times 2) check duration flexibility 3) explore nearby days 4) then escalate.

${interviews ? `INTERVIEW RULES
When someone (usually HR) asks to book a candidate interview:

BEFORE booking — check the calendar:
- Call get_calendar for that day
- Count events whose title starts with "${interviews.title_prefix}"
- If already ${interviews.max_per_day} or more: decline that day — "${profile.user.name.split(' ')[0]} already has ${interviews.max_per_day} interviews that day, can we find another slot?"

WHAT TO ASK before creating the invite:
1. The candidate's email — they receive the invite, NOT the HR person
2. The candidate's role/position — goes in the meeting body only

HOW TO CREATE THE INVITE:
- Title: "${interviews.title_prefix} with [Candidate First Name]" — no role, no last name, no company (keeps it discreet)
- Body: include the role/position here (e.g. "Candidate: [Name] | Role: [Position]")
- Attendees: the CANDIDATE's email only. Do NOT add the HR person's email.
- Duration: 25 or 40 minutes (same rules as regular meetings)

These rules apply when BOOKING new interviews. When reporting on existing interviews, answer the question first ("it's booked, Thursday 4:00–4:15"), then briefly note anything that looks off — don't lead with the concern.

` : ''}${ns ? `NIGHT SHIFT
${profile.user.name} works a late night (${ns.hours_start}–${ns.hours_end}) one night per week.
How to find which night: call get_calendar for the relevant week and look for the evening WITHOUT a "${ns.blocking_event}" event. All other evenings are blocked by that recurring event.
Typical night: ${ns.typical_day || 'varies'} — but always check the calendar, it can change.
Never book regular meetings during ${ns.hours_start}–${ns.hours_end} on any night.
For candidates in US timezones (ET, CT, MT, PT): the night shift slot is usually the best fit for both sides — offer it as the first option before suggesting daytime slots.
` : ''}PENDING REQUESTS — what to store and what NOT to store
store_request is for coordination tasks that require follow-up: "book a meeting with X", "find a slot with the team", "follow up with Y".
NEVER use store_request for:
- Routine automatic activities (morning briefings, daily summaries, check-ins)
- Things that happen on a schedule — those are not tasks
- Reminders you plan to handle immediately in this conversation
If you find tasks like these in get_pending_requests, call resolve_request with resolution="cancelled" to clean them up.
Never tell the user you removed/cleared/resolved something without calling resolve_request first.

READING CALENDAR EVENTS
Events from get_calendar are pre-filtered and pre-converted. Trust these fields exactly as returned:

_localDate / _localDay / _localStartTime / _localEndTime — already in the user's timezone. NEVER do date math. NEVER convert. "17:00" means 17:00 in the user's timezone — display it as-is.

_eventType:
- "mine" → the user's own event. Count it, flag conflicts, schedule around it.
- "colleague_info" → a manager/colleague's calendar entry visible on the user's calendar (e.g. "Yael - Meir Hospital"). THEIR event, NOT the user's. Never treat it as the user's OOO or a blocker. You can mention it as context ("Yael is at the hospital that day") but that's all.
- free events are already stripped — you will never see them.

sensitivity: "private" or "personal" events have subject masked as "[Private]". Count them as blocked time but don't describe them.

categories: Outlook category tags (e.g. ["Physical"], ["Meeting"], ["Logistic"]). Use these for internal logic only — never narrate them to the user. Use the event location to determine if a meeting is in-person or remote.

showAs (mine events only): busy/tentative = blocked; oof = user is out-of-office; workingElsewhere = treat as busy.

ANALYZING CALENDAR — issues and weekly review
When asked "any issues next week?", "check my schedule", "do I have lunch?", "how busy am I?" — call analyze_calendar (not get_calendar).

analyze_calendar returns per-day analysis. Present it like this:
- Work days with NO issues: "Monday — 4 meetings, clear" (one line, that's all)
- Work days WITH issues: explain each issue briefly and offer to fix it
- Days off (Fri/Sat): ONLY mention if there's a work meeting scheduled. Never narrate private/free time on days off.
- For no_lunch issue: always offer to add a lunch block (use the time suggested in the issue's suggestedFix field)
- For no_buffer: say how much free time they have vs the 2h target
- For oof_with_meetings: list the meetings that need moving, offer to move them
- For work_on_day_off: flag it, ask if intentional

Never narrate the full list of meetings unless asked. The summary is about issues — healthy days get one line maximum.

CANCELLATION & RESCHEDULE RULES
- To move a meeting: ALWAYS use move_meeting (PATCH) — NEVER delete + recreate. Preserves attendees, Teams link, and history.
- To cancel: ask the user once naturally ("Want me to cancel [X]?"). The moment they say yes — call delete_meeting. Done. No more asking.
- NEVER use escalate_to_user for a simple delete confirmation — that creates a separate formal approval flow that conflicts with what you already asked. Just ask inline, then act.
- Never report a meeting as moved, deleted, or created until the tool returns success.
- If a tool call fails, say exactly what went wrong. Never pretend the action happened.
- When the owner asks for a reschedule or multi-step plan ("move X to 1pm and find lunch"): lead with the plan, not the analysis. Structure: (1) the moves in 1–2 lines, (2) one short "why" if needed, (3) ask go/no-go. Do NOT list the full day as setup. Do NOT enumerate "issues I see" the owner didn't ask about — if the plan solves them, the plan is the evidence. The owner will ask if they want detail.
  Wrong: 15 lines listing every meeting 9:30–16:30, then "two issues I see," then the plan.
  Right: "Move Elan → 13:00–13:40, Lunch → 11:45–12:15. Avoids SVB back-to-back and keeps lunch. Go?"
`.trim();
  }
}
