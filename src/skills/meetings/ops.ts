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

// v3.2.1 (#120 / 120b) — the VACATED slot of a move: the window the meeting
// occupied BEFORE it moved, so a follow-up "move X into the freed slot"
// resolves from this turn instead of Maelle re-asking the old time. Window =
// old start + the moved duration. ONE helper, called from BOTH move return
// sites (the regular-meeting tail AND the floating-block early return) so the
// two paths can never drift apart again — the original bug was that only the
// regular path returned `vacated`, so moving lunch to free its slot dropped
// the freed-slot info entirely.
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
  getSuppressedEventIds,
  dismissFloatingBlockGap,
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

    // Private/personal events: mask the subject. v2.9.4 (#107a) — checks
    // BOTH paths via the central displaySubject helper:
    //   (1) Outlook sensitivity is 'private' / 'personal'
    //   (2) any of the event's categories matches a yaml category with
    //       sets_sensitivity_private:true (e.g. Idan's `Personal` category)
    // Pre-fix only path (1) was masked here — category-based privacy was
    // silently bypassed, so Sonnet saw raw subjects for category-private
    // events and could narrate them verbatim (root of #107a). The lower-
    // level getCalendarEvents still returns raw subjects; the internal
    // classifier flows (autoCategorize / detectCategory) read those directly
    // and stay unaffected.
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
  // v3.0.3 — pre-filter parameter removed. Suppression now happens at row-
  // write time via upsertCluster's 'suppressed' return (callers that write
  // rows skip already-approved clusters). Read-only callers see the full
  // detected list; Sonnet's prompt covers narration filtering.
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
  const bufferMin = profile.meetings.buffer_minutes ?? 15;
  // v1.6.11 — per-day-type focus-time threshold. Office days usually need
  // more protected focus time than home days; profile can set each
  // separately. Home falls back to office value when not set.
  const requiredFreeOfficeMin = (profile.meetings.free_time_per_office_day_hours ?? 0) * 60;
  const requiredFreeHomeMin = ((profile.meetings.free_time_per_home_day_hours
    ?? profile.meetings.free_time_per_office_day_hours ?? 0)) * 60;

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
      // back_to_back emit retired. The scheduler removed buffer-between-
      // meetings enforcement in v2.7.1 ("Connected back-to-backs are fine
      // by design"), so flagging them as analyzer issues had no fix path
      // and just produced morning-brief noise.
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

    // v3.0.3 — no pre-filter here. Suppression handled by upsertCluster at
    // row-write time; this function is read-only and returns the full detected
    // list. Callers that surface to the owner do so via the cluster-write path.
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
          args.force_refresh === true,  // v3.2.x (#121) — user asked to LOOK now → fresh
        );
        const processed = processCalendarEvents(rawEvents, userEmail, context.profile.user.name, timezone, context.profile);

        // v3.3 (fix #2) — Working Elsewhere enrichment. If the range covers
        // WE days, attach the away-TZ note so Sonnet does NOT eyeball home-TZ
        // "mornings clear" (the regression that offered Israel mornings while
        // the owner was in Boston). Null when no WE marker → nothing attached.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const weModGc = require('../../utils/workingElsewhere') as typeof import('../../utils/workingElsewhere');
        const weNoteGc = await weModGc.summarizeWorkingElsewhere(rawEvents, timezone);

        // v2.8.6 (99C, Shape A) — when the query window comes back with no
        // events on an owner-DM turn, enrich the result with recent
        // delete_meeting + create_meeting audit entries that intersect the
        // window. Closes the "did you cancel the meeting you booked with X?"
        // amnesia (root of the 2026-05-18 Michal incident: get_calendar
        // returned empty post-delete, Sonnet asserted "I don't have a record
        // of booking a meeting with Michal" — the booking + delete were both
        // in audit_log but never read). Owner-DM only — colleagues mustn't
        // see audit traces of meetings they're not on.
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

        // Colleague-path enumeration guard. When a colleague (not in MPIM
        // with owner present) reads the owner's calendar, wrap the events
        // with a `_colleague_view` flag + hard-rule note so Sonnet does NOT
        // enumerate subjects/companies/locations back to the requester. The
        // colleague-block prompt rule's "title + time = fine" is over-permissive
        // for the "show me the day" pattern; this tool-side guard keeps the
        // data available for Maelle's OWN reasoning (e.g. which slot to
        // propose) while telling Sonnet to summarize, not enumerate.
        const isColleaguePath = context.senderRole === 'colleague' && context.isOwnerInGroup !== true;
        if (isColleaguePath) {
          return {
            events: processed,
            _colleague_view: true,
            _enumeration_rule: 'You are reading the owner\'s calendar on behalf of a colleague. Do NOT list more than one specific meeting back to them. "He has a 1:1 at 11am" is fine when proposing a slot; "he has Isaac at 10:45, Elan at 11:30, Bank Hapoalim at 12:30..." is a privacy leak. Default response when the day is busy: "He\'s fully booked Thursday." If they push for which meetings could move, escalate via create_approval(kind=freeform) asking the owner — DO NOT enumerate options to the colleague yourself.',
          };
        }

        return weNoteGc ? { events: processed, ...weNoteGc } : processed;
      }

      case 'analyze_calendar': {
        const rawEvents = await getCalendarEvents(
          userEmail,
          args.start_date as string,
          args.end_date as string,
          timezone,
        );
        const processed = processCalendarEvents(rawEvents, userEmail, context.profile.user.name, timezone, context.profile);
        // v3.0.3 — pre-filter removed; analyzeCalendar is read-only.
        // Suppression handled at row-write time elsewhere.
        const _suppressed = getSuppressedEventIds(context.profile.user.slack_user_id);
        void _suppressed;
        const analysis = analyzeCalendar(processed, args.start_date as string, args.end_date as string, context.profile);
        // v3.3 (fix #2) — attach the Working Elsewhere note when the range has
        // WE days, so issue-narration is framed in the away timezone too.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const weModAc = require('../../utils/workingElsewhere') as typeof import('../../utils/workingElsewhere');
        const weNoteAc = await weModAc.summarizeWorkingElsewhere(rawEvents, timezone);
        return weNoteAc ? { day_analysis: analysis, ...weNoteAc } : analysis;
      }

      case 'get_free_busy':
        try {
          const raw = await getFreeBusy(userEmail, args.emails as string[], args.start_date as string, args.end_date as string, timezone, args.force_refresh === true);
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
          // v3.1.6 (L2) — duration safety default. The tool description tells
          // Sonnet to default to default_meeting_duration when no length was
          // stated; this is the code backstop for when she omits it entirely.
          // (When she WRONGLY passes a longer value off a meeting-type guess —
          // "interview" → 55 — the description tightening is what corrects that;
          // the handler can't tell a guessed value from a stated one.)
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
          // tool description (added in v3.0.3 fix-up) authorizes Sonnet to
          // pass date-only `"2026-05-27"` for "end of Wednesday", but the
          // downstream parser reads any date-only string as 00:00 of that
          // day. When Sonnet passed `search_from=search_to="2026-05-27"`
          // for "tomorrow", both sides resolved to 2026-05-27T00:00 →
          // 0-minute window → getFreeBusy bailed → strict pass returned 0
          // → Maelle said "nothing tomorrow" on a wide-open day (real
          // observed bug, 2026-05-26 09:20 IL). Mirror what
          // getCalendarEvents already does internally via
          // `toEndOfDayLocal` — append T23:59:59 to a bare YYYY-MM-DD so
          // the description matches reality.
          let effectiveSearchTo = ((): string => {
            const raw = args.search_to as string;
            if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
              return `${raw}T23:59:59`;
            }
            return raw;
          })();
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
          // next Tuesday?" is a point-in-time availability check; Sonnet maps
          // it to search_from == search_to (a single instant). getFreeBusy
          // bails on a zero-width (or inverted) window and returns empty, the
          // relaxed-recovery fallback also returns empty, so the whole
          // iteration is wasted and Sonnet has to redo the search with a wider
          // window on the NEXT turn — observed 2026-06-04T18:01 (Ayala MPIM),
          // cost ~18s + a full extra Sonnet iteration. Defensive fix mirrors
          // the date-only expansion above: when from >= to, expand `to` to
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
          // colleague's middle-of-the-night (real bug 2026-05-28: 10:30 IL =
          // 03:30 ET offered to Boston-based Ayala). Auto-add catches this so
          // the existing v2.8.3 per_attendee_local enrichment also kicks in,
          // giving Sonnet the dual-TZ rendering she needs.
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
          // Owner direction (2026-05-26): when owner triggers the full
          // override (relaxed=true on owner-path, OR explicit
          // ignore_attendee_availability=true), the override is TOTAL — drop
          // BOTH the busy filter AND the attendee work-hours clip. Earlier
          // direction had work-hours stay enforced ("no 3-AM bookings") but
          // the attendee work-hours data is owner-curated in people_memory,
          // can go stale, and silently filtered owner-valid slots. New rule:
          // surface the work-hours rejection once (via day_summary.blocked_by
          // attribution emitted by calendar.ts), and on owner override the
          // tool drops the clip too. "If I decide, it's on me."
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
            workingElsewhere?: {
              resolved: Array<{ date: string; away_tz: string; location: string }>;
              unresolved: Array<{ date: string; location: string }>;
            };
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
          // specific times to check ("can we do A, B, C, or D?"), Sonnet
          // passes them all as `candidate_slots`. We fire N parallel narrow
          // findAvailableSlots calls (each autoExpand:false), collect per-
          // candidate verdicts in ONE response.
          //
          // Pre-v3.0.6 Sonnet had to call find_available_slots N times
          // sequentially — N Sonnet round-trips. Ayalla coord turn
          // 2026-05-28T19:14 was 6 iterations + 40s + $0.31 for 4 candidates;
          // candidate_slots collapses that to 2 iterations.
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
                let endIso = c.end;
                if (!endIso) {
                  const s = DateTime.fromISO(c.start, { zone: timezone });
                  if (s.isValid) endIso = s.plus({ minutes: durationMin }).toISO() ?? c.start;
                  else endIso = c.start;
                }
                return { start: c.start, end: endIso as string };
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
                case 'focus_time_office': return `breaks ${ownerFirst}'s focus-time protection (office day)`;
                case 'focus_time_home': return `breaks ${ownerFirst}'s focus-time protection (home day)`;
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
              // v3.3 — fail loud on an all-Working-Elsewhere window: surface the
              // marker so Sonnet asks about timezone instead of saying "busy."
              const weInfo = diagnosticsOut.workingElsewhere;
              if (weInfo && (weInfo.resolved.length > 0 || weInfo.unresolved.length > 0)) {
                return {
                  slots: [],
                  working_elsewhere: weInfo,
                  _working_elsewhere_note: 'The window is entirely Working-Elsewhere day(s). For any day in `working_elsewhere.unresolved`, ASK the owner what timezone he is in that day — do NOT say he is unavailable. For `resolved` days with no slots, his day there is genuinely full. NEVER present his home-timezone availability for a working-elsewhere day.',
                };
              }
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
                  searchTo: effectiveSearchTo,
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
              // v3.1.7 — clip the AUTO-recovery to the owner's working DAY.
              // The recovery relaxes IN-DAY soft blocks (focus / lunch / category)
              // so it can surface "13:00 breaks your lunch — book anyway?" — but it
              // must NEVER offer a slot outside his working hours (pre-start /
              // post-end). Maelle proposing "09:00, before your 10:30 start" was the
              // bug (2026-05-31 Daniel): relaxing a soft block ≠ extending his day.
              // (When the OWNER explicitly names an off-hours time, that call passes
              // relaxed=true directly and never enters this auto-recovery branch.)
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
                  };
                }
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
            const chosenStarts = new Set(pickSpreadSlots(candidateSet, timezone, 3, anchorDay, args.duration_minutes as number | undefined));

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
            // v3.1.2 — `location` (free text, e.g. "Boston") is the ONLY
            // field Sonnet should narrate; it's the proper location source.
            // The raw IANA tz fields (travelTimezone/homeTimezone) were
            // dropped — a timezone is not a place, and leaving the IANA in
            // the tool JSON re-opened the "America/New_York → New York" paste
            // risk. TZ math is handled by per_attendee_local below + the
            // slot-finder clip; Sonnet never needs the raw zone.
            const travelers = (attendeeAvailability ?? [])
              .filter(a => a.travel)
              .map(a => ({
                email: a.email,
                location: a.travel!.location,
                until: a.travel!.until,
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
                  // v3.1.2 — raw `timezone: a.timezone` (IANA) dropped from the
                  // result. local_display is the pre-rendered string Sonnet
                  // quotes; local_iso carries the offset (no city). Shipping
                  // the IANA tag invited "America/New_York → New York" pastes.
                  return {
                    email: a.email,
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
            // v3.3 — Working Elsewhere surfacing. `resolved` days carry tentative
            // slots (already tagged in annotatedSlots); `unresolved` days had a
            // marker whose location couldn't be mapped to a timezone → Sonnet
            // must ASK, never offer home-TZ times.
            const weInfo = diagnosticsOut.workingElsewhere;
            const hasWe = !!weInfo && (weInfo.resolved.length > 0 || weInfo.unresolved.length > 0);
            if (travelers.length > 0 || hasDaySummary || isRecoveryResult || hasWe) {
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
              if (hasWe) {
                result.working_elsewhere = weInfo;
                result._working_elsewhere_note =
                  'Some days in this window are marked Working Elsewhere — the owner is in a different place/timezone, so his normal scheduling rules are SUSPENDED. Slots tagged `tentative_working_elsewhere:true` are TENTATIVE openings computed in his away timezone (see each slot\'s `away_tz` + `away_location`): present them in HIS local time there, ideally dual-TZ (e.g. "10:00 Boston / 17:00 your time"), say they need his confirmation, and route any booking through approval — never present as locked. For any day in `working_elsewhere.unresolved` (a marker whose location I could not map to a timezone), DO NOT offer times — ASK the owner what timezone he is in that day. NEVER show his home-timezone clock for a working-elsewhere day.';
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
        // v3.0.7 — runtime array guard. Pre-fix the cast `as Array<...>` was a
        // pure-TS assertion, no runtime check. When Sonnet passed `attendees`
        // as a non-array shape (single object, keyed object, null, omitted —
        // all observed in the wild), the downstream `attendees.filter(...)`
        // call at line ~1669/1864 crashed with
        // `TypeError: attendees.filter is not a function`. The registry's
        // generic catch wrapped it as `{ error: 'Tool ... failed: ...' }`,
        // the summarizer rendered it as `[create_meeting FAILED ...
        // unclear_result]`, and Sonnet retried with the same broken shape →
        // owner saw 3 identical FAILEDs in one turn (2026-05-26 08:57 IL,
        // Onn/Oran/Lital booking). Refuse early with a shape-explicit error
        // message Sonnet can react to instead of the opaque TypeError.
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

        // v2.9.0 — BookingRequest normalization. Single validated pre-data
        // shape that planMeeting consumes (replacing ad-hoc PlanMeetingInput
        // construction below). The normalizer is idempotent: it reads from
        // args (after the legacy in-handler prep below runs), produces a
        // strict BookingRequest with owner-in-participants invariant +
        // snapped duration + gated sensitivity + gated relaxed + minimal
        // context (threadTs / isMpim / isOwnerInGroup). Phase A keeps the
        // legacy handler prep alongside; Phase B consolidates by reading
        // req.X downstream and removing the duplicate handler-side blocks.
        const { normalizeBookingRequest } = await import('./bookingRequest');
        const { planInputFromBookingRequest } = await import('./planMeeting');

        // v2.8.6 (102a) — sensitivity gate on colleague-path. The tool schema
        // exposes `sensitivity` so Yael can ask "mark this private" at booking
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

        // v2.8.6 — snap duration to profile.meetings.allowed_durations at the
        // single chokepoint every booking path reaches (direct Sonnet call,
        // outreach handoff, deferred-replay). Pre-fix, only the outreach
        // handoff in coordinator.ts snapped; direct create_meeting calls
        // shipped whatever start/end Sonnet passed (root of the Maayan 20-min
        // booking landing at 12:15-12:35 off-alignment).
        const startIsoIn = args.start as string | undefined;
        const endIsoIn   = args.end   as string | undefined;
        if (typeof startIsoIn === 'string' && typeof endIsoIn === 'string') {
          const startMs = Date.parse(startIsoIn);
          const endMs   = Date.parse(endIsoIn);
          if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
            const requestedMin = Math.round((endMs - startMs) / 60000);
            const allowed = context.profile.meetings.allowed_durations;
            if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(requestedMin)) {
              const snapped = allowed.reduce((best, candidate) =>
                Math.abs(candidate - requestedMin) < Math.abs(best - requestedMin) ? candidate : best,
              allowed[0]);
              const snapDelta = Math.abs(requestedMin - snapped);
              // v3.2.6 (2.4) — a SMALL snap (≤5 min, e.g. "1 hour" → 55) is the
              // expected preset-alignment; apply it silently. A LARGE snap
              // (>5 min, e.g. an explicit 2-hour copy → 55) used to silently
              // DESTROY the length the owner actually asked for. Don't shrink it
              // on our own — surface a verify question; honor the full length
              // only on owner confirm (override_duration), or shrink to the
              // preset if they pass duration_minutes=<preset> instead.
              if (snapDelta > 5 && !args.override_duration) {
                return {
                  warning: `You asked for a ${requestedMin}-minute meeting, which is longer than the usual lengths (${allowed.join(', ')} min). Ask briefly: "That's ${requestedMin} min — book the full length, or shorten to ${snapped}?" If they want the full ${requestedMin} min, call create_meeting again with override_duration=true; if ${snapped} is fine, call again with duration_minutes=${snapped}.`,
                  needs_confirmation: true,
                };
              }
              if (snapDelta <= 5) {
                const newEndIso = new Date(startMs + snapped * 60000).toISOString();
                logger.info('create_meeting — snapped duration to allowed_durations', {
                  requested: requestedMin, snappedTo: snapped, allowed,
                  start: startIsoIn, endWas: endIsoIn, endNow: newEndIso,
                });
                args.end = newEndIso;
              }
              // snapDelta > 5 && override_duration → fall through: honor the
              // requested length as-is (no snap).
            }
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

          // v2.8.6 (103D/F) — owner-in-MPIM deterministic override. When the
          // owner is present in this MPIM and recently proposed THIS exact
          // slot in chat (24h or 12h time format match against owner-typed
          // messages in the recent history), treat his presence as the
          // approval. Set relaxed=true on the args so the downstream Guard B
          // check and planMeeting both bypass soft rules (work hours, focus,
          // floating blocks). Closes the path that today produces the leaked
          // "Idan said yes on policy exception needs your input" MPIM message
          // — when owner just typed "what about 10:30pm?" in the same thread,
          // there's no reason to escalate it back to him as an approval.
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
                message: `I don't have an email for ${unclassifiable.map(a => a.name).join(', ')}. Without an email I can't add them to the calendar invite. Either call coordinate_meeting (which DMs them for slot pick + collects email), or come back with their email.`,
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
                  // v3.0.6 — this is a single-slot yes/no validation. The
                  // window is exactly [start, end], so findAvailableSlots
                  // returns ≤1 slot → <3 → auto-expand would re-query the
                  // calendar 2-3 more times at widening ranges (~5-6s on
                  // every colleague booking), and the expanded slots are
                  // discarded anyway (matches checks ±60s of the requested
                  // start). Disable it.
                  autoExpand: false,
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
                  // v2.8.6 (103E wiring) — stamp the deferred_action_hint so
                  // the orchestrator can auto-attach it to the follow-up
                  // create_approval. Pre-fix this colleague-path early-reject
                  // returned without a hint, so owner-approve resolved the
                  // request with no replay — booking never fired, requester
                  // got the "I'll take it from here" empty promise. Now the
                  // same `payload.deferred_action` machinery that the
                  // planMeeting-path refusals use also covers this path.
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
        // v2.9.0 — build the normalized BookingRequest and feed it through
        // planInputFromBookingRequest. Replaces the previous ad-hoc
        // PlanMeetingInput construction. Args are passed AS-IS to the
        // normalizer — the legacy in-handler prep above already applied
        // (duration snap, sensitivity gate, email auto-fill); the
        // normalizer reads those mutated values and produces the canonical
        // shape. See bookingRequest.ts for the invariants the normalizer
        // enforces.
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
              // v3.2.1 (#120a — one mechanism) — owner-path soft-rule override flows
              // through the SAME persisted approval path as escalate. If the owner
              // ALREADY authorized it in THIS message, retry create_meeting now with
              // relaxed=true. Otherwise create_approval(kind=policy_exception) so the
              // override PERSISTS and his later "yes" replays it deterministically.
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
          // v2.8.6 — explicit args.sensitivity overrides the category-driven
          // default. Lets owner OR an attendee ask "mark this private" at
          // booking time. Default is undefined (Outlook normal); only set
          // when the conversation asked for it (102a on the 2026-05-18 wave).
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

          // v2.8.2 / v3.1.x — Teams-URL-as-location patch, now FIRE-AND-FORGET.
          // When the location decision tree said "online with Teams URL as the
          // location" (4a1, 5a, travel-override, non-work-day default), patch
          // the event's location.displayName to the joinUrl so the invite shows
          // the link as its location. This is PURELY COSMETIC — the meeting was
          // already created WITH the online meeting in the single createMeeting
          // POST (isOnlineMeeting:true), so the Teams link + Join button exist
          // in the body regardless of this patch. Pre-v3.1.x this was an
          // awaited second Graph PATCH (~2.5s) blocking the tool return on every
          // Teams booking. Now we fire it AFTER verify (so we only patch a
          // confirmed-good event) and DON'T await it — the ~2.5s leaves the
          // critical path. Worst case on failure: location shows the auto label
          // instead of the URL. Runs only on the confirmed-success path.
          if (planTeamsUrlAsLocation && createdMeeting.joinUrl) {
            void (async () => {
              try {
                const { updateMeeting } = await import('../../connectors/graph/calendar');
                await updateMeeting({ userEmail, timezone, meetingId, location: createdMeeting.joinUrl });
                logger.info('create_meeting — patched location with Teams join URL (async)', {
                  meetingId, joinUrl: createdMeeting.joinUrl,
                });
              } catch (err) {
                logger.warn('create_meeting — Teams URL location patch failed, leaving as auto', {
                  meetingId, err: String(err).slice(0, 200),
                });
              }
            })();
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

          // v2.9.2 — close in-flight artifacts. Per closeMeetingArtifacts'
          // own contract (v1.8.8 / v2.4.2 comments): "Every meeting mutation
          // — create / move / update / delete — can leave stale artifacts."
          // Pre-fix this path was the one mutation type that DIDN'T call the
          // cascade, so in_flight_action follow_ups opened during a spilled
          // create attempt (#11.2) never closed on the successful retry.
          // Subject is passed so the subject-fallback match catches rows
          // whose details.meeting_id is undefined.
          closeMeetingArtifacts({
            ownerUserId: context.profile.user.slack_user_id,
            meetingId,
            reason: 'created',
            subject: args.subject as string | undefined,
            bookingThreadTs: context.threadTs,
          });

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

          // v3.1.4 (Y3) — record the requester-link for a colleague's direct
          // booking. findMeetingOwner reads the requests spine to decide
          // "who controls this meeting"; coord bookings already record their
          // requester, but a direct colleague create_meeting did not — so a
          // colleague editing the meeting they just requested wasn't
          // recognized as its requester. One terminal row keyed on the event
          // closes that gap; the requester then controls add/rename/location
          // via the update_meeting + move_meeting gates.
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

        // v2.9.1 — attendee add/remove path. The schema introduced
        // `add_attendees` and `remove_attendees`; when either is non-empty
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
          // booking path uses. Pre-fix, "add Eli Feldman" (no email) was
          // dropped here → attendee_missing_email → Maelle asked the colleague
          // for an email she already had on file.
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
          // they can add anyone, rename, change location, even if they're not
          // on it. A non-requester colleague editing the owner's meeting →
          // escalate to ONE approval. The requester is resolved from the
          // requests spine via findMeetingOwner (coord bookings + the v3.1.4
          // colleague-booking requester-link both populate it).
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
              // preserve_existing / ask_owner / room_unavailable — leave the
              // event's location alone. Category change still applies if any.
            } catch (err) {
              logger.warn('update_meeting — shape re-evaluation threw, applying attendee change without category/location update', {
                err: String(err).slice(0, 200),
              });
            }
          }
        }

        await updateMeeting({
          userEmail,
          timezone,
          meetingId:  args.meeting_id  as string,
          subject:    args.new_subject as string | undefined,  // subjects allow " - " (E1, owner direction)
          categories: args.category
            ? [args.category as string]
            : (newCategoryFromShape ? [newCategoryFromShape] : undefined),
          attendees: mergedAttendees,
          location: newLocationFromShape,
          isOnline: newIsOnlineFromShape,
        });
        closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'updated',
          subject: (args.new_subject as string | undefined) ?? (args.meeting_subject as string | undefined),
          bookingThreadTs: context.threadTs,
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
        if (newLocationFromShape !== undefined) updateChanges.push(`location updated to "${newLocationFromShape}"`);
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
        // v2.2.1 — colleague-path rule-compliance gate. When an inbound colleague
        // DM asks Maelle to move an existing meeting, she can do it autonomously
        // IF the new slot fits the owner's rules (work hours, work days, buffers,
        // floating blocks, no conflicts). If the new slot breaks a rule, the tool
        // refuses and signals needs_owner_approval — Sonnet then falls back to
        // create_approval(kind=meeting_reschedule). Owner-path callers skip this
        // check (owner override IS the approval).
        if (context.senderRole === 'colleague') {
          // v3.1.4 (Y3) — requester-controls gate. Only the meeting's requester
          // gets the autonomous rule-compliant auto-move below; any other
          // colleague → straight to owner approval. Mirrors the update_meeting
          // gate. (Owner-path skips this whole block.)
          try {
            const { findMeetingOwner } = await import('./findMeetingOwner');
            const ownerInfo = await findMeetingOwner({
              ownerUserId: context.profile.user.slack_user_id,
              ownerEmail: userEmail,
              eventId: args.meeting_id as string,
            });
            if (ownerInfo.requesterSlackId && ownerInfo.requesterSlackId !== context.userId) {
              const ownerFirst = context.profile.user.name.split(' ')[0];
              logger.info('move_meeting — non-requester colleague → escalate', {
                meetingId: args.meeting_id, requester: context.userId,
              });
              return {
                needs_owner_approval: true,
                reason: 'colleague_not_requester',
                meeting_subject: args.meeting_subject,
                requested_start: args.new_start,
                requested_end: args.new_end,
                message: `Only ${ownerFirst} (or whoever requested this meeting) can move "${args.meeting_subject}". Raise create_approval(kind=meeting_reschedule) so he can decide.`,
              };
            }
          } catch (err) {
            logger.warn('move_meeting requester gate — findMeetingOwner threw, falling through to rule check', {
              err: String(err).slice(0, 200),
            });
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
                    // v3.0.6 — single-slot validation; see parallel comment
                    // in create_meeting Guard B. Auto-expand would re-query
                    // the calendar at widening ranges for slots that get
                    // discarded (matches checks ±60s of newStart). Disable.
                    autoExpand: false,
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
        let effectiveStart = args.new_start as string;
        let effectiveEnd   = args.new_end   as string;
        // v3.x — grid-align an off-grid move target to the :00/:15/:30/:45 grid
        // unless the owner named the exact time. Floating blocks are realigned
        // by findAlignedSlotForBlock below, so this only affects the regular
        // (non-floating) move fall-through. Replaces the SLOT START TIMES rule.
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

              // v2.3.2 (3A) — owner-explicit hint respects target as-is when
              // in-window. Don't snap to a different slot, don't refuse on
              // conflict. findAlignedSlotForBlock conflated window-check and
              // conflict-check; for owner-explicit moves only the window
              // matters — owner overrides any conflict (it shows as a normal
              // calendar overlap she can sort separately, e.g. she said
              // "I'll move a conflict after"). Out-of-window still refuses —
              // that's policy_exception territory.
              const isOwnerPath = context.senderRole === 'owner' || context.isOwnerInGroup === true;
              if (isOwnerPath) {
                // v3.1.8 (D5) — snap the hint to the quarter grid. The general
                // snap above is bypassed on the floating-block path because this
                // branch overwrites effectiveStart with the raw hint, so a
                // "right after" that lands at :40 booked lunch at :40 instead of
                // the owner's quarter convention (:45). Redo the snap here; honor
                // an exact owner-given time (start_is_explicit) as-is.
                const alignedMs = args.start_is_explicit
                  ? newStartDt.toMillis()
                  : fb.alignNearestQuarter(newStartDt.toMillis(), timezone);
                const hintStartDt = DateTime.fromMillis(alignedMs, { zone: timezone });
                const hintStartMs = hintStartDt.toMillis();
                const hintEndMs = hintStartMs + matchedBlock.duration_minutes * 60 * 1000;
                const inWindow = hintStartMs >= wStart && hintEndMs <= wEnd;
                const overrideOk = args.confirm_outside_window === true;
                if (inWindow || overrideOk) {
                  effectiveStart = hintStartDt.toISO()!;
                  effectiveEnd = hintStartDt
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
                    message: `${args.new_start} is outside the ${matchedBlock.preferred_start}–${matchedBlock.preferred_end} window for ${matchedBlock.name}. To proceed anyway, retry with confirm_outside_window=true (owner override IS the approval — no separate policy_exception needed).`,
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
                    subject: args.meeting_subject as string | undefined,
                    bookingThreadTs: context.threadTs,
                  });
                  // v3.2.1 (#120 / 120b) — return the vacated slot here too. The
                  // floating-block move (e.g. lunch) is exactly the case where
                  // the owner moves a block to FREE its slot for another
                  // meeting; without this the freed-slot info was dropped.
                  const vacated = computeVacatedSlot(preMoveStartIso, effectiveStart, effectiveEnd, timezone);
                  return {
                    success: true,
                    action_summary: `Moved ${matchedBlock.name} to ${formatIsoTime(effectiveStart)}.`,
                    ...(vacated ? { vacated } : {}),
                  };
                });
              }

              // Colleague-path — keep existing alignment + conflict guard.
              const alignedMs = fb.findAlignedSlotForBlock(matchedBlock, dayStr, timezone, busy);
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
          // v2.8.5 — also extract prior END so planMeeting's freebusy
          // overlap check can exclude the source event when an attendee's
          // calendar still shows it. Closes the "move 13:00→13:15 trips
          // confirm_override because Onn is busy at 13:15 (with the very
          // meeting being moved)" bug.
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
                // v3.2.1 (#120a — one mechanism) — owner-path soft-rule override now
                // flows through the SAME persisted approval path as the colleague
                // escalate, instead of the fragile "ask, then re-issue relaxed next
                // turn" path (Sonnet dropped that re-issue → the meeting silently
                // never moved). If the owner ALREADY authorized the override in THIS
                // message ("do it anyway", "move it, I'll handle the conflict"), retry
                // move_meeting now with relaxed=true. OTHERWISE call
                // create_approval(kind=policy_exception) with suggested_ask_text — the
                // orchestrator stamps the deferred move, so the override PERSISTS and
                // the owner's later "yes" replays it deterministically. Do NOT just ask
                // and rely on re-issuing the move yourself next turn.
                : 'Move violates a soft scheduling rule. If the owner ALREADY authorized overriding it in THIS message (e.g. "do it anyway", "I\'ll handle the conflict"), retry move_meeting now with relaxed=true. Otherwise call create_approval(kind=policy_exception) with suggested_ask_text — this PERSISTS the override (the orchestrator stamps the deferred move) so the owner\'s later "yes" replays it on its own. Do NOT ask and then rely on re-issuing the move yourself next turn — that pending action gets lost.',
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
          subject: args.meeting_subject as string | undefined,
          bookingThreadTs: context.threadTs,
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
        // via the policy_exception approval flow).
        // v3.1.8 — the VACATED slot (where the meeting WAS), so a follow-up
        // "move X into the freed slot" resolves from this turn instead of
        // Maelle re-asking the old time. v3.2.1 — shared helper (see top of
        // file); the floating-block early return uses the same one.
        // Computed BEFORE the rebalance so it can gate reclaim detection to the
        // slot this move actually freed.
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
          new_start: args.new_start,
          new_end: args.new_end,
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
          action_summary: `Moved '${args.meeting_subject}' to ${formatIsoTime(args.new_start as string)}–${formatIsoTime(args.new_end as string)}.`,
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
        closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'deleted',
          subject: args.meeting_subject as string | undefined,
          bookingThreadTs: context.threadTs,
        });
        // v3.1.7 / #119 — if the deleted event was a floating block (lunch,
        // etc.), record a date-scoped dismissal so active-mode health doesn't
        // re-book the gap the owner just cleared. Keyed to the exact day via
        // the synthetic event_id, so only THIS day is suppressed — future
        // same-weekday blocks still get placed. Replaces the old audit-log
        // delete suppressor that over-suppressed the whole forward window.
        // Subject-only match (categories aren't captured pre-delete); mirrors
        // the prior audit approach's match basis. Non-fatal on any failure.
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
