/**
 * Calendar event processing + calendar analysis. Module-level functions moved
 * VERBATIM (v3.7.x) out of ops.ts; only the inline require() paths were
 * deepened one level for the ops/ subdirectory. `processCalendarEvents` and
 * `analyzeCalendar` are re-exported from ops.ts so importers don't change.
 */
import logger from '../../../utils/logger';
import { DateTime } from 'luxon';
import type { UserProfile } from '../../../config/userProfile';
import type { CalendarEvent } from '../../../connectors/graph/calendar';
import { searchPeopleMemory } from '../../../db';

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
export function enrichUnresolvedInternal(emails: string[], ownerDomainLower: string): Array<{ email: string; did_you_mean?: string }> {
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
  const fb = require('../../../utils/floatingBlocks') as typeof import('../../../utils/floatingBlocks');
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
    const { displaySubject } = require('../../../utils/displaySubject') as
      typeof import('../../../utils/displaySubject');
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
  // Floating blocks (lunch + any custom). Uses the same matcher every other
  // code path (slot search, book_floating_block, rebalance) uses.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fb = require('../../../utils/floatingBlocks') as typeof import('../../../utils/floatingBlocks');
  const floatingBlocks = fb.getFloatingBlocks(profile);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { requiredFreeMinutesForWorkDay } = require('../../../utils/scheduleRules') as typeof import('../../../utils/scheduleRules');
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

    // v2.8.1 + v3.7.x (#143) — day CLASSIFICATION and hours both come from the
    // date's EFFECTIVE work day (a per-date chat override wins over raw weekday
    // yaml). Pre-fix isWorkDay/dayType read raw office_days/home_days, so an "off
    // next Wed" override still analyzed Wed as a 9-19 workday (false no_buffer /
    // missing-lunch) and a made-working off-day was mis-flagged work_on_day_off.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getEffectiveWorkDay, totalWorkMinutes } = require('../../../utils/workHours') as
      typeof import('../../../utils/workHours');
    const effectiveDay = getEffectiveWorkDay(dateStr, profile);
    const isWorkDay  = effectiveDay.isWorkday;
    const isOffice   = effectiveDay.location === 'office';
    const dayType: DayAnalysis['dayType'] = !isWorkDay ? 'day_off' : isOffice ? 'office' : 'home';
    const windows = effectiveDay.windows;
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
    // shave; a single gap under the min chunk is dropped entirely, not trimmed.
    // #133 — the min chunk is thinking_time_min_chunk_minutes (the SAME block the
    // slot-path focus floor counts via computeDayQualityFreeMinutes); a sub-chunk
    // gap is a dead sliver, not free time. Was hardcoded 15; now aligned so
    // analyze_calendar and the booking floor agree on what a "real break" is.
    // required = 1h free per N hours worked, rounded UP to 15 min, off the
    // summed work-window length (workTotalMin).
    const freeWindows = windows.length > 0 ? windows : [{ startMin: workStartMin, endMin: workEndMin }];
    const meetingIntervals = timedMeetings.map(ev => {
      const [sh, sm] = ev._localStartTime.split(':').map(Number);
      const [eh, em] = ev._localEndTime.split(':').map(Number);
      return { start: sh * 60 + sm, end: eh * 60 + em };
    });
    const minChunk = profile.meetings.thinking_time_min_chunk_minutes ?? 30;
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
        if (gap >= minChunk) freeMin += gap;   // full gap; sub-chunk slivers don't count
        cursor = Math.max(cursor, b.end);
      }
      const trailing = w.endMin - cursor;
      if (trailing >= minChunk) freeMin += trailing;
    }

    const requiredFreeMin = requiredFreeMinutesForWorkDay(workTotalMin, profile.meetings.work_hours_per_free_hour);
    if (requiredFreeMin > 0 && freeMin < requiredFreeMin) {
      issues.push({
        type: 'no_buffer',
        severity: 'high',
        detail: `Only ${freeMin} min free inside your ${workTotalMin}-min work day; you want at least ${requiredFreeMin} min (1h free per 4h worked; gaps under ${minChunk} min don't count).`,
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
