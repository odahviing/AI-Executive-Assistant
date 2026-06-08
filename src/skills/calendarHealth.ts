import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import { DateTime } from 'luxon';
import {
  getCalendarEvents,
  type CalendarEvent,
  createMeeting,
  updateMeeting,
  deleteMeeting,
  findAvailableSlots,
} from '../connectors/graph/calendar';
import { auditLog, getActiveCalendarIssues, updateCalendarIssueStatus, buildClusters, upsertCluster, markStaleResolved, type DetectedIssue, type IssueClass, type IssueStatus } from '../db';
import logger from '../utils/logger';
import { displaySubject } from '../utils/displaySubject';
import { formatSkillPreferencesBlock } from '../utils/skillPreferences';
import type { PreferPosition, AnchorEvent } from '../utils/floatingBlocks';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a Graph datetime string into Luxon DateTime.
 * Handles the trailing fractional-seconds Graph sometimes returns.
 */
function parseGraphDt(dateTimeStr: string, eventTz: string, fallbackTz: string): DateTime {
  const clean = dateTimeStr.replace(/\.\d+$/, '');
  const tz = eventTz || fallbackTz;
  if (clean.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(clean)) {
    return DateTime.fromISO(clean).setZone(tz);
  }
  return DateTime.fromISO(clean, { zone: tz });
}

/**
 * v2.1.1 — high-confidence category classifier. Returns the picked category
 * name only when Sonnet says confidence='high'. Anything else returns null,
 * which means "don't auto-tag, leave for owner". Deliberately conservative —
 * mis-tagging is more annoying than leaving a category empty.
 */
async function classifyEventCategory(
  event: CalendarEvent,
  profile: UserProfile,
): Promise<string | null> {
  if (!profile.categories || profile.categories.length === 0) return null;
  const catalog = profile.categories.map(c => `- ${c.name}: ${c.description}`).join('\n');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = (require('@anthropic-ai/sdk') as typeof import('@anthropic-ai/sdk')).default;
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      tools: [{
        name: 'pick_category',
        description: 'Pick the single best-fit category for this event, or return confidence=low to skip.',
        input_schema: {
          type: 'object' as const,
          properties: {
            category: { type: 'string', description: 'Category name, exactly as listed. Empty string if none fits.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['category', 'confidence'],
        },
      }],
      tool_choice: { type: 'tool', name: 'pick_category' },
      messages: [{
        role: 'user',
        content: `Event: "${event.subject}"
Body preview: ${(event.bodyPreview ?? '').slice(0, 200)}
All-day: ${event.isAllDay}
Online: ${event.isOnlineMeeting ?? 'unknown'}

Available categories:
${catalog}

Pick the single best-fit category. Return confidence=high ONLY when the match is unambiguous. Default to low/medium for anything borderline — the owner prefers an untagged event over a mis-tagged one.`,
      }],
    });
    const toolUse = resp.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return null;
    const input = toolUse.input as Record<string, unknown>;
    const confidence = input.confidence as string | undefined;
    const category = input.category as string | undefined;
    if (confidence !== 'high' || !category) return null;
    // Defense: only return a name that's actually in the profile.
    const match = profile.categories.find(c => c.name === category);
    return match ? match.name : null;
  } catch (err) {
    logger.warn('classifyEventCategory failed — skipping auto-tag', { err: String(err).slice(0, 200) });
    return null;
  }
}

interface HealthIssue {
  type:
    | 'missing_floating_block'   // owner-configured block didn't land on the calendar; block_name carries which one (lunch, coffee, gym, thinking time, ...)
    | 'double_booking'
    | 'oof_conflict'
    | 'missing_category'
    | 'category_limit_exceeded'  // v2.6 — per_day or per_week limit on a category violated
    | 'busy_day';                 // v2.1.1 — day exceeds busy thresholds (free-time / count / longest-free-block)
  date: string;
  description: string;
  eventIds?: string[];
  suggestion?: string;
  // v2.6 — for category_limit_exceeded
  category_name?: string;
  rule_broken?: 'per_day' | 'per_week';
  rule_value?: number;
  current_count?: number;
  // v2.5.6 — for busy_day (re-enabled)
  free_minutes?: number;
  longest_gap_minutes?: number;
  threshold_minutes?: number;
  is_office_day?: boolean;
  // v2.1.1 — structured fields used by active-mode fix loop. Optional so
  // older callers / narration paths keep working unchanged.
  block_name?: string;            // for missing_floating_block: which block ('lunch', 'coffee_break', ...)
  internal_only?: boolean;        // for double_booking: every attendee same company domain
  movable_event_id?: string;      // for double_booking: which side is unprotected (4+ attendees / external / matched rule)
  kept_event_id?: string;         // for double_booking: the protected side
  protection_reasons?: string[];  // for double_booking: WHY the kept side is protected (≥4 attendees, external, ...)
  fixed?: boolean;                // set by active-mode loop when Maelle acted on this issue
  fix_detail?: string;            // human-readable one-liner describing the fix applied
  fix_failed?: boolean;           // set when active-mode tried to fix and an error was thrown
  fix_error?: string;
}

export class CalendarHealthSkill implements Skill {
  id = 'calendar' as const;
  readonly skillId = 'calendar';
  name = 'Calendar Health';
  description = 'Monitors calendar hygiene: lunch protection, double-booking detection, OOF conflicts, and event categories';

  getTools(profile: UserProfile): Anthropic.Tool[] {
    // Floating-block names — read from yaml so the tool's enum stays in sync
    // with whatever blocks the owner has configured (lunch + any custom).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
    const floatingBlockNames = fb.getFloatingBlocks(profile).map(b => b.name);
    const categoryNames = (profile.categories ?? []).map(c => c.name);
    return [
      {
        name: 'check_calendar_health',
        description: `Scan the owner's calendar for a date range and report health issues:
- Missing floating blocks: a configured block (lunch, coffee break, thinking time, any other user-defined block) didn't land on the calendar on a day it applies to
- Double bookings: overlapping non-all-day events (tagged with internal_only + movable_event_id when detectable)
- OOF conflicts: meetings scheduled on days with an OOF/vacation event
- Missing categories: events without Outlook categories
- Busy day: a work day with free time below the profile threshold / 6+ meetings / no 30-min block for thinking time

Returns a list of issues. Behavior depends on \`mode\`:
- passive (default) → returns the issues for you to narrate. Owner asks for fixes; you execute them via book_floating_block / set_event_category / etc. in follow-up calls.
- active → executes safe fixes in-tool before returning: missing floating blocks get booked, missing categories get set when the classifier is high-confidence, busy-day threshold breaches fire a DM to the owner. Overlap + OOF conflicts on a MOVABLE (internal-only, no external attendee) meeting are auto-resolved by initiating a move-coordination to reschedule it (see the fix loop below); a movable meeting with an external attendee is left for the owner. Each issue in the returned list is tagged \`fixed: true\` with \`fix_detail\` when Maelle acted on it.

Use this proactively when the owner asks about their schedule, or when they ask you to check calendar health.`,
        input_schema: {
          type: 'object',
          properties: {
            start_date: {
              type: 'string',
              description: 'Start date YYYY-MM-DD. Defaults to today. When omitted, the tool uses a smart default window: today → end of the owner\'s current workweek, extended by 7 days when ≤24h remain (so there\'s runway to coordinate moves).',
            },
            end_date: {
              type: 'string',
              description: 'End date YYYY-MM-DD. Defaults paired with start_date — see above. Only override when you have a specific reason (e.g. owner asked "check next month").',
            },
            mode: {
              type: 'string',
              enum: ['passive', 'active'],
              description: 'Optional override. When omitted, uses profile.behavior.calendar_health_mode. "active" executes the safe subset of fixes in-tool; "passive" just detects and reports.',
            },
          },
          required: [],
        },
      },
      {
        name: 'book_floating_block',
        description: `Book a floating-block event (lunch / coffee break / gym / thinking time / etc) on a specific day, inside that block's preferred window.

Pick \`block_name\` from the FLOATING BLOCKS section of your system prompt — these are the blocks the owner has configured. The handler finds an aligned + buffered slot inside the block's preferred window and creates the event with the block's default subject.

Use this when: the owner explicitly asks to book one (e.g. "block 30 min for lunch tomorrow", "add a coffee break Thursday"), OR check_calendar_health surfaces a missing block on a workday.

POSITIONAL PREFERENCE — express the owner's intent semantically, don't compute the time yourself:
- Default (no \`prefer_position\` arg) → earliest aligned slot in the window. Use this when the owner just says "book lunch" without a time preference.
- \`prefer_position: 'latest_in_window'\` → latest aligned slot in the window. Use when the owner says "book lunch as late as possible" / "right before lunch ends".
- \`prefer_position: 'abut_before'\` + \`anchor_event_id\` → slot ends right before the anchor meeting (directly abuts, no buffer — standard meeting durations carry their own spacing). Use when the owner says "before [meeting]" / "right before [person]" / "just before X".
- \`prefer_position: 'abut_after'\` + \`anchor_event_id\` → slot starts right after the anchor meeting (directly abuts, no buffer). Use when the owner says "after [meeting]" / "right after [person]".

Pass anchor_event_id from get_calendar's event id field. NEVER hand-compute the start time and pass it through create_meeting — let this tool do the alignment math. Boundary times like the exact lunch_end are unbookable as lunch (the window's preferred_end is exclusive); the abut_after path will refuse honestly if math lands at/past the boundary.

CATEGORIES: if the EVENT CATEGORIES block is in your system prompt, pass \`category\` with the name that fits this kind of block (typically the one whose description mentions personal time / schedule admin). Omit if no categories are defined or none fits.

OWNER OVERRIDE — booking outside the preferred window:
When the owner explicitly says to book a floating block at a time OUTSIDE its preferred window ("book lunch at 14:00 even though that's late", "yes I know it's after my lunch hours, do it anyway"), call this tool with start_time="HH:MM" + confirm_outside_window=true. The handler bypasses the window check (owner override IS the approval) AND bypasses the day-of-week check (owner is allowed to book a block on any day they ask). It still enforces the rules that DON'T bend: buffer, conflict detection, alignment. Resulting event is tagged as a first-class floating block (canonical subject + matching category) so downstream code recognizes it. Never fall back to create_meeting for this — that path would lose the floating-block-ness. Owner-only path: this flag is ignored on colleague calls (colleagues can't trigger this tool anyway — it's owner-restricted by registry).`,
        input_schema: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Date YYYY-MM-DD to book the block on.',
            },
            block_name: floatingBlockNames.length > 0
              ? {
                  type: 'string',
                  enum: floatingBlockNames,
                  description: 'Which floating block to book. Must match a name in the FLOATING BLOCKS section of your system prompt.',
                }
              : {
                  type: 'string',
                  description: 'Which floating block to book.',
                },
            prefer_position: {
              type: 'string',
              enum: ['earliest', 'latest_in_window', 'abut_before', 'abut_after'],
              description: 'OPTIONAL. Where in the block window to place this booking. Default: earliest. Use abut_before / abut_after with anchor_event_id when the owner says "before X" / "after X".',
            },
            anchor_event_id: {
              type: 'string',
              description: 'OPTIONAL. The event id (from get_calendar) to abut against. REQUIRED when prefer_position is abut_before or abut_after.',
            },
            start_time: {
              type: 'string',
              description: 'OPTIONAL. Explicit HH:MM start time (24h). Honored ONLY when confirm_outside_window=true and the owner has explicitly directed the time. Quarter-hour alignment is still enforced — if the owner names off-grid time, snap silently to the nearest valid quarter unless they pinned it (15:13 from get_calendar may be valid for booking onto an existing slot; 15:13 from a free-form ask should snap to 15:15).',
            },
            confirm_outside_window: {
              type: 'boolean',
              description: 'OPTIONAL. Owner override flag — when true, the handler accepts a start_time that is OUTSIDE the block\'s preferred window AND/OR on a day the block is not normally scheduled. Use ONLY when the owner has explicitly said to book it there ("yes book lunch at 14:00, late is fine"). The override IS the approval — no separate policy_exception approval needed. Buffer + conflict checks still enforced. Pair with start_time.',
            },
            category: categoryNames.length > 0
              ? {
                  type: 'string',
                  enum: categoryNames,
                  description: 'OPTIONAL. Name of the Outlook category to tag this event with. Must match EXACTLY one of the owner\'s defined categories. Omit if none fits.',
                }
              : {
                  type: 'string',
                  description: 'OPTIONAL. Outlook category. Omit if no categories are defined.',
                },
          },
          required: ['date', 'block_name'],
        },
      },
      {
        name: 'set_event_category',
        description: `Add or update the Outlook category on a calendar event. Categories help with calendar organization and analytics.

Use the owner's own categories listed in the EVENT CATEGORIES block of your system prompt. Names must match EXACTLY (case-sensitive). Do NOT invent category names — if you think a new category should exist, say so in the reply; don't silently create one.`,
        input_schema: {
          type: 'object',
          properties: {
            event_id: { type: 'string', description: 'The calendar event ID' },
            categories: {
              type: 'array',
              items: { type: 'string' },
              description: 'Category names to set on the event',
            },
          },
          required: ['event_id', 'categories'],
        },
      },
      {
        // v2.9 — merged get_calendar_issues + update_calendar_issue.
        name: 'manage_calendar_issue',
        description: `Calendar issues (overlaps, work-on-day-off, OOF, missing blocks, etc.) — list or transition. v3.0.3 redesign.

Actions:
- list — read active rows (filtered to event_end > now).
- approve — owner said "it's fine, leave it." Marks the row terminal (won't re-flag).
- start_resolve — owner said "fix it." Opens a request_id under the row, transitions to in_progress. Caller MUST follow with move_meeting / coordinate_meeting / etc. as appropriate; the row auto-resolves on cascade when the underlying event changes.
- owner_will_resolve — owner said "I'll handle it." Row sits in owner_side state until owner declares done OR the underlying event changes.
- owner_done — owner declared he fixed it. Row transitions to resolved.

issue_id is required for everything except 'list'. Get it from a prior list / check_calendar_health call. Use \`notes\` to capture what owner said ("Sunday is travel, leave it") — surfaces on future narration.

v3.0.6 — PREEMPTIVE APPROVE for floating-block gaps (NEW). When you mention a missing floating block ("no lunch on Tuesday") and the owner replies it's covered by another event / he'll skip it / not needed today, call \`manage_calendar_issue\` with:
  action='approve', date='<YYYY-MM-DD>', block_name='<lunch | gym | etc.>', notes='covered by Natan meeting'
No issue_id needed. A terminal row gets created directly so the next check_calendar_health run sees the suppressor and skips re-narrating the same gap. Use this whenever the owner waives a floating-block gap in conversation — don't wait for the daily detection to fire to dismiss it.`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'approve', 'start_resolve', 'owner_will_resolve', 'owner_done'], description: 'see description.' },
            issue_id: { type: 'string', description: 'required for start_resolve / owner_will_resolve / owner_done. Optional for approve when you pass date + block_name instead.' },
            date: { type: 'string', description: 'YYYY-MM-DD. Use with block_name for the preemptive-approve path (no issue_id needed). v3.0.6.' },
            block_name: { type: 'string', description: 'Floating-block name (must match profile.meetings.floating_blocks, e.g. "lunch"). Use with date for the preemptive-approve path.' },
            notes: { type: 'string', description: 'optional. Owner reason ("travel week"), or what got done.' },
          },
          required: ['action'],
        },
      },
      {
        name: 'manage_working_elsewhere',
        description: `Mark (or clear) days the OWNER is working from a different location/timezone — travel days, working from another office, etc. Sets Outlook's "Working Elsewhere" status so Maelle knows his normal office/home/work-hours rules don't apply those days: availability becomes tentative in his AWAY timezone and bookings route to approval.

Use when the owner says he'll be elsewhere: "next week I'm in France Monday and Tuesday", "I'm working from the NYC office Thu–Fri", "I'll be in London all next week".

action='set' — create the all-day Working Elsewhere marker spanning the dates. Always include \`location\` (where he'll be) — it's what derives his timezone there.
action='clear' — remove Working Elsewhere markers overlapping the date range (a trip got cancelled / changed).

Owner-only. This is a personal status marker, NOT a meeting — no attendees, no booking rules. Resolve the dates from the owner's words using your date table.`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['set', 'clear'], description: 'set = create the marker; clear = remove markers in the range.' },
            start_date: { type: 'string', description: 'First day, YYYY-MM-DD.' },
            end_date: { type: 'string', description: 'Last day, YYYY-MM-DD (inclusive). Omit for a single day.' },
            location: { type: 'string', description: 'Where he\'ll be — city or office ("France", "Boston Office", "London"). Drives the away-timezone; include whenever known (required for set).' },
          },
          required: ['action', 'start_date'],
        },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { profile } = context;
    const { email: userEmail, timezone } = profile.user;

    switch (toolName) {
      case 'manage_working_elsewhere': {
        // v3.3 — owner-only personal status marker (Working Elsewhere). Creates
        // / removes an all-day showAs=workingElsewhere event so WE-mode (slot
        // finder + booking gate + active-mode skip) reads it. NOT a meeting.
        if (context.senderRole !== 'owner') {
          return { error: 'not_permitted', reason: 'Only the owner can set their working-elsewhere days.' };
        }
        const action = (args.action as string | undefined)?.trim();
        const startDateArg = (args.start_date as string | undefined)?.trim();
        const endDateArg = (args.end_date as string | undefined)?.trim() || startDateArg;
        const location = (args.location as string | undefined)?.trim() ?? '';
        if (!startDateArg) return { error: 'empty_start_date' };
        const startDt = DateTime.fromISO(startDateArg, { zone: timezone });
        const endDtInclusive = DateTime.fromISO(endDateArg!, { zone: timezone });
        if (!startDt.isValid || !endDtInclusive.isValid) {
          return { error: 'bad_date', message: 'start_date / end_date must be YYYY-MM-DD.' };
        }

        if (action === 'clear') {
          try {
            const events = await getCalendarEvents(userEmail, startDt.toFormat('yyyy-MM-dd'), endDtInclusive.toFormat('yyyy-MM-dd'), timezone);
            const markers = events.filter(e => e.isAllDay && !e.isCancelled && e.showAs === 'workingElsewhere');
            for (const m of markers) {
              await deleteMeeting(userEmail, m.id);
            }
            logger.info('manage_working_elsewhere — cleared', { count: markers.length, from: startDateArg, to: endDateArg });
            return { ok: true, action: 'clear', cleared: markers.length };
          } catch (err) {
            logger.warn('manage_working_elsewhere clear failed', { err: String(err).slice(0, 200) });
            return { ok: false, error: 'clear_failed' };
          }
        }

        if (action !== 'set') {
          return { error: 'bad_action', message: "action must be 'set' or 'clear'." };
        }
        // All-day Graph event: start = midnight of first day, end = midnight of
        // the day AFTER the last day (exclusive).
        const allDayStart = startDt.startOf('day').toFormat("yyyy-MM-dd'T'00:00:00");
        const allDayEnd = endDtInclusive.startOf('day').plus({ days: 1 }).toFormat("yyyy-MM-dd'T'00:00:00");
        const subject = location ? `Working Elsewhere — ${location}` : 'Working Elsewhere';
        try {
          const created = await createMeeting({
            subject,
            start: allDayStart,
            end: allDayEnd,
            attendees: [],
            isAllDay: true,
            showAs: 'workingElsewhere',
            ...(location ? { location } : {}),
            userEmail,
            timezone,
          });
          logger.info('manage_working_elsewhere — set', { id: created.id, from: startDateArg, to: endDateArg, location });
          return {
            ok: true,
            action: 'set',
            event_id: created.id,
            from: startDt.toFormat('yyyy-MM-dd'),
            to: endDtInclusive.toFormat('yyyy-MM-dd'),
            location,
            _note: location
              ? `Marked Working Elsewhere (${location}) ${startDt.toFormat('EEE d MMM')}–${endDtInclusive.toFormat('EEE d MMM')}. Those days now use ${location} time for availability and route bookings to you.`
              : `Marked Working Elsewhere ${startDt.toFormat('EEE d MMM')}–${endDtInclusive.toFormat('EEE d MMM')}. Tip: add a location next time so I can use the right timezone there.`,
          };
        } catch (err) {
          logger.warn('manage_working_elsewhere set failed', { err: String(err).slice(0, 200) });
          return { ok: false, error: 'set_failed' };
        }
      }

      case 'check_calendar_health': {
        // v2.1.4 — default window is owner-rule-driven (today → end of
        // workweek; extend 7 days when ≤24h left). Explicit args still
        // override. See utils/workHours.computeHealthCheckWindow.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { computeHealthCheckWindow } = require('../utils/workHours') as typeof import('../utils/workHours');
        const defaultWindow = computeHealthCheckWindow(profile);
        const startDate = (args.start_date as string) ?? defaultWindow.startDate;
        const endDate = (args.end_date as string) ?? defaultWindow.endDate;
        // v2.1.1 — mode resolution. Explicit arg wins; else profile default.
        const mode: 'passive' | 'active' =
          (args.mode === 'active' || args.mode === 'passive')
            ? args.mode
            : (profile.behavior.calendar_health_mode ?? 'passive');

        let events: CalendarEvent[];
        try {
          events = await getCalendarEvents(userEmail, startDate, endDate, timezone);
        } catch (err) {
          logger.error('Calendar health: failed to fetch events', { err });
          return { error: 'Failed to fetch calendar events.' };
        }

        const issues: HealthIssue[] = [];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const protection = require('../utils/meetingProtection') as typeof import('../utils/meetingProtection');
        const floatingBlocks = fb.getFloatingBlocks(profile);
        const allWorkDays = [
          ...profile.schedule.office_days.days,
          ...profile.schedule.home_days.days,
        ] as string[];

        // v2.8.7 (bug 1.4) — skip the `missing_floating_block` issue entirely
        // on days the owner deliberately cleared, so detection never pushes
        // it (no narration, no auto-book, no daily skip-message). The check
        // lives in DETECTION, not just the auto-book path.
        //
        // v3.1.7 / #119 — suppression source switched from the audit_log
        // delete-meeting rows to the `calendar_issues` waived set. The audit
        // approach over-suppressed: a single delete row lacking event_start_iso
        // matched EVERY day in the window (`d.date === undefined`), so one
        // dateless "Lunch" delete silenced the whole forward week of lunch
        // detection for 14 days (the bug). The waived set is date-scoped via
        // the block's synthetic event_id — only the exact day(s) the owner
        // approved/deleted are suppressed.
        let waivedBlockGapIds: Set<string> = new Set();
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getWaivedFloatingBlockEventIds } = require('../db/calendarIssues') as typeof import('../db/calendarIssues');
          waivedBlockGapIds = getWaivedFloatingBlockEventIds(profile.user.slack_user_id);
        } catch (err) {
          logger.warn('Calendar health: waived-gap preload failed — detection will not suppress', {
            err: String(err).slice(0, 200),
          });
        }

        // Iterate through each day in range
        let cursor = DateTime.fromISO(startDate, { zone: timezone });
        const end = DateTime.fromISO(endDate, { zone: timezone });

        while (cursor <= end) {
          const dayStr = cursor.toFormat('yyyy-MM-dd');
          const dayName = cursor.toFormat('EEEE');

          if (!allWorkDays.includes(dayName)) {
            cursor = cursor.plus({ days: 1 });
            continue;
          }

          // Get events for this day
          const dayEvents = events.filter(e => {
            if (e.isCancelled) return false;
            const eventStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
            return eventStart.toFormat('yyyy-MM-dd') === dayStr;
          });

          // v3.2.6 (6.3) — a FULL-DAY busy or OOF event (vacation / all-day
          // block) means the day is off or fully spoken for: don't flag a
          // missing floating block on it. The owner blocks vacation days; no
          // lunch is expected there.
          const fullDayBlocked = dayEvents.some(e =>
            e.isAllDay && !e.isCancelled && (e.showAs === 'oof' || e.showAs === 'busy'));

          // ── Missing floating blocks ──
          // Every block configured for the profile (lunch + any custom) is
          // checked independently. Only the ones that apply on this day-of-week
          // are in scope. A block is "missing" when no event on the calendar
          // matches it (subject regex OR category match, via the helper).
          // missing_floating_block scope follows the analyzer's overall
          // window (computeHealthCheckWindow — day-of-week aware: Mon-Wed
          // sees through end-of-this-week, Thursday sees Thursday + next
          // week). Owner direction: scope matches calendarHealth, not
          // today+tomorrow. The recentlyDeleted suppressor catches the
          // "owner just deleted this block on this day" case so a fresh
          // delete doesn't re-fire; future days where the block genuinely
          // hasn't been placed surface for the active-mode auto-book on
          // the day of.
          for (const block of floatingBlocks) {
            if (fullDayBlocked) break;  // v3.2.6 (6.3) — full-day busy/OOF: no lunch expected
            if (!fb.blockAppliesOnDay(block, dayName, profile)) continue;
            const hasBlock = dayEvents.some(e => {
              if (e.isAllDay) return false;
              return fb.isFloatingBlockEvent(
                { subject: e.subject, categories: e.categories },
                block,
              );
            });
            if (!hasBlock) {
              // v3.1.7 / #119 — skip days the owner deliberately waived
              // (approved the gap via manage_calendar_issue, or deleted the
              // block on that day). Keyed to the exact day via the synthetic
              // event_id (floatingBlockSyntheticEventId — single source of
              // truth), so only that day is suppressed; future same-weekday
              // blocks still surface. The issue never enters issues[] → no
              // brief narration, no auto-book attempt.
              const synth = fb.floatingBlockSyntheticEventId(profile, block.name, dayStr, timezone);
              if (synth && waivedBlockGapIds.has(synth.eventId)) continue;
              issues.push({
                type: 'missing_floating_block',
                date: dayStr,
                description: `No ${block.name.replace(/_/g, ' ')} on ${dayName} ${dayStr}`,
                suggestion: `Book a ${block.duration_minutes}-minute ${block.name.replace(/_/g, ' ')} between ${block.preferred_start} and ${block.preferred_end}`,
                block_name: block.name,
              });
            }
          }

          // ── Double bookings (v2.1.1 — tagged with internal_only + movable_event_id) ──
          //
          // Filter to events that COUNT as work meetings for overlap purposes.
          // Anything outside that scope is the owner's life and shouldn't be
          // surfaced as a calendar issue. Exclusions (v3.0.3):
          //   1. all-day / showAs free / showAs workingElsewhere
          //   2. subject matches anything in profile.meetings.issue_exclusions.subjects
          //      (yaml-driven; replaces the v2.x hardcoded night_shift.blocking_event
          //       check — owner's "Home Time" now lives in this list and the same
          //       mechanism extends to any other silent subject)
          //   3. matches a configured floating block (lunch / coffee / gym /
          //      thinking-time / etc — elastic personal time, not work)
          //   4. entirely outside the day's work-hours window (Boot Camp 20:00-
          //      21:30 on a 10:30-19:00 office day, etc.)
          //   5. v3.0.3 — any of the event's categories matches a yaml category
          //      flagged `no_issue_tracking: true` (e.g. "Personal" category —
          //      owner's life, not work-tracking territory)
          // v2.8.1 — multi-window aware. workStart = earliest window start,
          // workEnd = latest window end on this day.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getOwnerWorkHoursForDay: _getWH, formatMinuteOfDay: _fmtMin } = require('../utils/workHours') as
            typeof import('../utils/workHours');
          const wins = _getWH(profile, dayName);
          const dayHoursStart = wins.length > 0
            ? _fmtMin(wins[0].startMin)
            : '09:00';
          const dayHoursEnd = wins.length > 0
            ? _fmtMin(wins[wins.length-1].endMin)
            : '19:00';
          const dayWorkStart = DateTime.fromISO(`${dayStr}T${dayHoursStart}`, { zone: timezone });
          const dayWorkEnd = DateTime.fromISO(`${dayStr}T${dayHoursEnd}`, { zone: timezone });
          const exclSubjects = (profile.meetings.issue_exclusions?.subjects ?? [])
            .map(s => s.toLowerCase()).filter(s => s.length > 0);
          const noTrackCategories = new Set(
            (profile.categories ?? [])
              .filter(c => c.no_issue_tracking === true)
              .map(c => c.name),
          );

          const nonAllDay = dayEvents.filter(e => {
            if (e.isAllDay) return false;
            if (e.showAs === 'free' || e.showAs === 'workingElsewhere') return false;
            // Exclusion 2: yaml-driven subject silence list
            const subjLower = (e.subject ?? '').toLowerCase();
            if (exclSubjects.some(s => subjLower.includes(s))) return false;
            // Exclusion 3: any configured floating block
            const matchesAnyBlock = floatingBlocks.some(b =>
              fb.isFloatingBlockEvent(
                { subject: e.subject, categories: e.categories },
                b,
              ),
            );
            if (matchesAnyBlock) return false;
            // Exclusion 5: yaml category flagged no_issue_tracking
            const eCats = e.categories ?? [];
            if (eCats.some(c => noTrackCategories.has(c))) return false;
            // Exclusion 4: entirely outside work-hours (start >= workEnd OR end <= workStart)
            const eStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
            const eEnd = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
            if (eStart >= dayWorkEnd || eEnd <= dayWorkStart) return false;
            return true;
          });
          for (let i = 0; i < nonAllDay.length; i++) {
            const a = nonAllDay[i];
            const aStart = parseGraphDt(a.start.dateTime, a.start.timeZone, timezone);
            const aEnd = parseGraphDt(a.end.dateTime, a.end.timeZone, timezone);
            for (let j = i + 1; j < nonAllDay.length; j++) {
              const b = nonAllDay[j];
              const bStart = parseGraphDt(b.start.dateTime, b.start.timeZone, timezone);
              const bEnd = parseGraphDt(b.end.dateTime, b.end.timeZone, timezone);

              if (aStart < bEnd && aEnd > bStart) {
                // Protection assessment for both sides + internal-only check
                const aProt = protection.isProtected(a, profile);
                const bProt = protection.isProtected(b, profile);
                const bothInternal = !aProt.reasons.includes('has external attendee')
                  && !bProt.reasons.includes('has external attendee');
                const pick = protection.pickMovableSide(a, b, profile);

                // v2.7.4 — mask private subjects in issue descriptions so the
                // brief / coord DMs / shadow notes don't leak.
                const aDisp = displaySubject(a, profile);
                const bDisp = displaySubject(b, profile);
                // Dismissal fingerprint anchors on the OCCURRENCE id, not
                // seriesMasterId. Owner direction: when a different occurrence
                // of the same recurring event overlaps with something new, that
                // IS worth re-flagging — the prior dismissal was for one
                // specific pair, not a blanket rule for the series. Personal-
                // category events are skipped from the detector entirely
                // (exclusion 5 above); recurring non-personal overlaps flag
                // per occurrence as intended.
                issues.push({
                  type: 'double_booking',
                  date: dayStr,
                  description: `"${aDisp}" (${aStart.toFormat('HH:mm')}-${aEnd.toFormat('HH:mm')}) overlaps with "${bDisp}" (${bStart.toFormat('HH:mm')}-${bEnd.toFormat('HH:mm')})`,
                  eventIds: [a.id, b.id],
                  suggestion: pick
                    ? `Propose moving "${displaySubject(pick.movable, profile)}" — the less-protected side. The other meeting is protected (${(pick.movable === a ? bProt : aProt).reasons.join(', ')}).`
                    : 'Both sides are protected — the owner needs to decide which to move.',
                  internal_only: bothInternal,
                  movable_event_id: pick?.movable.id,
                  kept_event_id: pick?.kept.id,
                  protection_reasons: pick ? (pick.movable === a ? bProt : aProt).reasons : [...aProt.reasons, ...bProt.reasons],
                });
              }
            }
          }

          // ── OOF conflicts ──────────────────────────────────────────────────
          // v2.3.1 (B16) — trust showAs only. Owner pushed back on keyword
          // matching: if an event is marked SHOW AS FREE in Outlook, it's
          // free regardless of subject text. Previous logic let an all-day
          // event with subject containing "vacation"/"oof"/"holiday"/"pto"
          // upgrade to OOF even when showAs=free, generating false conflicts
          // for every meeting on that day. Only Outlook's explicit OOF
          // status counts now.
          const oofEvents = dayEvents.filter(e => e.showAs === 'oof');
          if (oofEvents.length > 0) {
            const ownerEmailLower = profile.user.email.toLowerCase();
            // v2.8.7 (bug 1.1) — skip owner-only events. A solo meeting on
            // the owner's OWN OOF day is intentional personal time (e.g.
            // "Bookcamp" during his Holiday Block), not a conflict to flag.
            // Solo := no attendees, OR every attendee is the owner himself.
            // Same shape downstream auto-move already filters by (state.ts
            // returns 'no_participants' when coordParticipants is empty),
            // but here we stop the detection from firing at all so the
            // brief doesn't see a phantom "clash" issue either.
            const isSoloOwnerEvent = (e: typeof nonAllDay[number]): boolean => {
              const att = e.attendees ?? [];
              if (att.length === 0) return true;
              return att.every(a =>
                (a.emailAddress?.address ?? '').toLowerCase() === ownerEmailLower
              );
            };
            // v2.9.2 — also skip events the owner has explicitly locked as
            // unmovable in yaml (`profile.meetings.protected[]` with
            // `movable: false`). When the owner has marked something as
            // never-move (e.g. "Bookcamp" — solo-but-intentional during
            // Holiday Block), the oof_conflict flag is noise — he placed it
            // there on purpose.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { isYamlLockedUnmovable } = require('../utils/meetingProtection') as
              typeof import('../utils/meetingProtection');
            const meetings = nonAllDay.filter(e =>
              (e.showAs === 'busy' || e.showAs === 'tentative')
              && !isSoloOwnerEvent(e)
              && !isYamlLockedUnmovable(e, profile),
            );
            for (const meeting of meetings) {
              const mStart = parseGraphDt(meeting.start.dateTime, meeting.start.timeZone, timezone);
              issues.push({
                type: 'oof_conflict',
                date: dayStr,
                description: `"${meeting.subject}" at ${mStart.toFormat('HH:mm')} is scheduled on a day marked OOF/vacation`,
                eventIds: [meeting.id],
                suggestion: 'Decline or reschedule this meeting — you are out of office',
              });
            }
          }

          // ── Missing categories ─────────────────────────────────────────────
          for (const e of nonAllDay) {
            if (!e.categories || e.categories.length === 0) {
              issues.push({
                type: 'missing_category',
                date: dayStr,
                description: `"${e.subject}" has no category`,
                eventIds: [e.id],
                suggestion: profile.categories && profile.categories.length > 0
                  ? `Add a category — choose from ${profile.categories.map(c => c.name).join(', ')}`
                  : 'Add a category to organize this event',
              });
            }
          }

          // ── Busy day (v2.1.1) ──────────────────────────────────────────────
          // Three signals — any ONE triggers. Tuned so a "rough Thursday"
          // with 6+ meetings, sub-threshold free time, or no 30-min block
          // gets surfaced to the owner. Thresholds read from profile where
          // they already exist; defaults inline for the rest.
          {
            const isOffice = (profile.schedule.office_days.days as string[]).includes(dayName);
            const freeTimeThresholdHours = isOffice
              ? profile.meetings.free_time_per_office_day_hours
              : (profile.meetings.free_time_per_home_day_hours
                ?? profile.meetings.free_time_per_office_day_hours);
            const freeTimeThresholdMin = freeTimeThresholdHours * 60;

            // v2.8.7 (bug 1.3) — per-window aware. Pre-fix (v2.8.1 multi-
            // window introduction) used a bounding-box approach: clip busy
            // intervals to [first.start, last.end] then merge. On split-shift
            // days that bounding box INCLUDES the gap between windows, so a
            // meeting between 15:30 and 21:30 (Tuesday's mid-day off-stretch
            // for Idan) got counted as busy AND the inter-window gap also
            // counted as "free", producing the impossible "0 free time +
            // 110-min gap" narration on 2026-05-19. The fix walks each
            // window separately and aggregates.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getOwnerWorkHoursForDay, totalWorkMinutes } = require('../utils/workHours') as
              typeof import('../utils/workHours');
            const windows = getOwnerWorkHoursForDay(profile, dayName);
            const fallbackWindows = windows.length > 0
              ? windows
              : [{ startMin: 9 * 60, endMin: 18 * 60 }];
            const workTotalMin = totalWorkMinutes(fallbackWindows);

            // Parse busy events ONCE; per-window calc reuses these.
            const allBusy = nonAllDay
              .filter(e => e.showAs !== 'workingElsewhere')
              .map(e => {
                const s = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
                const en = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
                return {
                  start: s.hour * 60 + s.minute,
                  end: en.hour * 60 + en.minute,
                };
              })
              .filter(b => b.end > b.start);

            // Walk each window: clip busy to THIS window only, merge, compute
            // window-local busy total and longest gap. Aggregate across windows.
            let totalBusyInWork = 0;
            let longestGap = 0;
            for (const w of fallbackWindows) {
              const inWindow = allBusy
                .map(b => ({
                  start: Math.max(b.start, w.startMin),
                  end: Math.min(b.end, w.endMin),
                }))
                .filter(b => b.end > b.start)
                .sort((a, b) => a.start - b.start);

              const merged: Array<{ start: number; end: number }> = [];
              for (const b of inWindow) {
                if (merged.length > 0 && b.start <= merged[merged.length - 1].end) {
                  merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, b.end);
                } else {
                  merged.push({ ...b });
                }
              }
              totalBusyInWork += merged.reduce((sum, m) => sum + (m.end - m.start), 0);

              // Longest free segment INSIDE this window only.
              let prev = w.startMin;
              for (const m of merged) {
                longestGap = Math.max(longestGap, m.start - prev);
                prev = m.end;
              }
              longestGap = Math.max(longestGap, w.endMin - prev);
            }
            const freeMin = Math.max(0, workTotalMin - totalBusyInWork);

            // v2.5.6 (re-enabled) — busy_day flagging restored. Was removed
            // in v2.3.1 (#67) per prior owner direction; reversed in 2026-05
            // after a real-world test where almost every office day was under
            // the 2h focus target and the owner never heard about it. Fires
            // on a single signal: total free time during work hours falls
            // below profile.meetings.free_time_per_office_day_hours (or
            // _per_home_day_hours) for that day type. Pure report-only — no
            // auto-fix; owner decides which meeting to move. The longestGap
            // value rides along in the issue payload so Sonnet can narrate
            // honest detail without recomputing ("only 80 min of focus, your
            // 2h target needs more").
            if (freeMin < freeTimeThresholdMin) {
              const dayLabel = cursor.toFormat('EEEE d MMMM');
              const freeHrs = (freeMin / 60).toFixed(1);
              const targetHrs = (freeTimeThresholdMin / 60).toFixed(0);
              issues.push({
                type: 'busy_day',
                date: cursor.toISODate() ?? '',
                description: `${dayLabel} has only ${freeMin} min of free time during work hours (under your ${targetHrs}h ${isOffice ? 'office' : 'home'}-day target). Longest single block: ${longestGap} min.`,
                free_minutes: freeMin,
                longest_gap_minutes: longestGap,
                threshold_minutes: freeTimeThresholdMin,
                is_office_day: isOffice,
              });
            }
            void nonAllDay;
          }

          cursor = cursor.plus({ days: 1 });
        }

        // v2.6 — category limit detection. Walk all configured categories with
        // limits.per_day / limits.per_week and flag windows that exceed.
        // Report-only; active mode doesn't auto-resolve (which interview gets
        // bumped is a judgment call only the owner can make).
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { findCategoryViolations } = require('../utils/categoryRules') as
            typeof import('../utils/categoryRules');
          const allEvents = events;  // already in scope, full range fetch
          const rangeStart = DateTime.fromISO(startDate, { zone: timezone }).startOf('day');
          const rangeEnd = DateTime.fromISO(endDate, { zone: timezone }).endOf('day');
          const violations = findCategoryViolations({
            events: allEvents,
            profile,
            rangeStart,
            rangeEnd,
          });
          for (const v of violations) {
            const window = v.rule_broken === 'per_day' ? 'on' : 'in the';
            issues.push({
              type: 'category_limit_exceeded',
              date: v.window_start,
              description: `${v.category_name} ${v.rule_broken.replace('_', '-')} limit exceeded — ${v.current_count}/${v.rule_value} ${window} ${v.window_label}`,
              eventIds: v.event_ids,
              category_name: v.category_name,
              rule_broken: v.rule_broken,
              rule_value: v.rule_value,
              current_count: v.current_count,
            });
          }
        } catch (err) {
          logger.warn('analyze_calendar — category violation pass threw, skipping', {
            err: String(err).slice(0, 200),
          });
        }

        // Dedup: one entry per (type, sorted event-pair). Belt-and-suspenders
        // against the same conflict appearing under multiple detection paths.
        const seen = new Set<string>();
        const dedupedIssues: HealthIssue[] = [];
        for (const issue of issues) {
          const ids = [...(issue.eventIds ?? [])].sort().join('|');
          const key = `${issue.type}:${issue.date}:${ids}`;
          if (seen.has(key)) continue;
          seen.add(key);
          dedupedIssues.push(issue);
        }
        issues.length = 0;
        issues.push(...dedupedIssues);

        // v3.0.3 — suppression + write moved AFTER the active-mode fix loop.
        // Pre-write filtering against terminal rows is handled by upsertCluster's
        // 'suppressed' return; legacy dismissed-key filter retired. Auto-fix
        // success (active mode) → no row needed (audit_log carries it). Only
        // un-fixed issues land on the table. See cluster-based write block
        // below the fix loop.
        const ownerUserId = profile.user.slack_user_id;
        let newIssueCount = 0;

        // Include any active (unresolved) issues from previous checks
        const activeIssues = getActiveCalendarIssues(ownerUserId);

        // Active-mode fix loop. Runs ONLY when mode='active'. Each fix is
        // deterministic or high-confidence; failures fail open (the issue
        // stays flagged, fix_failed=true). Fixes covered:
        //   - missing_floating_block → book the block
        //   - missing_category → set category when classifier is high-conf
        //   - oof_conflict → move-coord for non-protected meetings
        //   - double_booking → direct floating-block move (Path a) OR
        //     move-coord on the movable side (Path b)
        //   - busy_day → DM the owner with candidates to move (no auto-move)
        let fixesApplied = 0;
        // v2.6.5 — internal_actions surfaces active-mode auto-fixes back up
        // through the tool result so the claim-checker can see them. Without
        // this, Sonnet's draft "I auto-fixed lunch on Tuesday" would be
        // flagged as a hallucination because the claim-checker only sees the
        // top-level tool (`check_calendar_health`), not the internal
        // book_floating_block / updateMeeting calls. The orchestrator's
        // summary-builder pushes each entry into toolCallSummaries.
        const internalActions: Array<{ tool: string; detail: string }> = [];
        if (mode === 'active') {
          logger.info('Calendar health: active mode — running fix loop', {
            ownerUserId, startDate, endDate, issueCount: issues.length,
          });
          // v3.3 — Working Elsewhere days: the owner's rule layer is unreliable
          // (different place + timezone), so DON'T auto-fix on them (no auto-add
          // lunch in the wrong timezone, no auto-resolve). Detection off the
          // already-fetched events; empty set → no-op (normal behavior).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const weMod = require('../utils/workingElsewhere') as typeof import('../utils/workingElsewhere');
          const weActiveDays = weMod.detectWorkingElsewhereDays(events, timezone);
          for (const issue of issues) {
            try {
              if (weActiveDays.size > 0 && weActiveDays.has(issue.date)) {
                logger.info('Calendar health: skipping auto-fix on working-elsewhere day', {
                  date: issue.date, type: issue.type,
                });
                continue;
              }
              if (issue.type === 'missing_floating_block') {
                // v3.1.7 / #119 — no suppression check here. Days the owner
                // waived (approved gap, or deleted the block that day) are
                // skipped at DETECTION via the waivedBlockGapIds set, so a
                // suppressed gap never reaches this auto-book loop. The old
                // audit-log delete check that lived here (and at detection)
                // is gone — replaced by the date-scoped calendar_issues set.
                // Reuse book_floating_block so alignment + buffer + day-scope
                // rules apply consistently. Pass the block_name from the
                // issue (set by the detector loop above) — the handler now
                // requires it explicitly, no implicit "lunch" fallback.
                const result = await this.executeToolCall(
                  'book_floating_block',
                  { date: issue.date, block_name: issue.block_name },
                  context,
                ) as { ok?: boolean; created?: boolean; start?: string; end?: string; error?: string; message?: string } | null;
                if (result?.ok && result.created) {
                  issue.fixed = true;
                  issue.fix_detail = `Booked ${issue.block_name ?? 'floating block'} ${issue.date} ${result.start}–${result.end}.`;
                  fixesApplied += 1;
                  internalActions.push({
                    tool: 'book_floating_block',
                    detail: `${issue.block_name ?? 'floating block'} ${issue.date} ${result.start}–${result.end}`,
                  });
                } else if (result?.error) {
                  issue.fix_failed = true;
                  issue.fix_error = result.message ?? result.error;
                }
              } else if (issue.type === 'missing_category' && profile.categories && profile.categories.length > 0 && issue.eventIds && issue.eventIds[0]) {
                // High-confidence Sonnet classifier. If confidence isn't
                // high, skip — we'd rather under-tag than mis-tag.
                const eventId = issue.eventIds[0];
                const event = events.find(e => e.id === eventId);
                if (event) {
                  const picked = await classifyEventCategory(event, profile);
                  if (picked) {
                    await updateMeeting({
                      userEmail, meetingId: eventId,
                      categories: [picked],
                      timezone,
                    });
                    issue.fixed = true;
                    issue.fix_detail = `Tagged "${event.subject}" as ${picked}.`;
                    fixesApplied += 1;
                    internalActions.push({
                      tool: 'set_event_category',
                      detail: `Tagged "${event.subject}" as ${picked}`,
                    });
                  }
                }
              }
              // busy_day: no fix action in-tool — the owner needs to decide
              // which meeting to move. A separate DM already fires below
              // (batched) so this issue stays in the returned list for narration.
              else if (issue.type === 'oof_conflict' && issue.eventIds && issue.eventIds[0]) {
                // v2.1.1 — surprise-vacation handling. When an OOF day has
                // meetings scheduled BEFORE the vacation, the non-protected
                // ones get moved out automatically (1:1s, small internal
                // groups). Protected meetings (≥4 attendees / external /
                // rule-matched) stay flagged for the owner. Same pattern
                // as double_booking path (b) — internal-only coord with
                // the meeting's attendees, move-intent.
                try {
                  const conflictingId = issue.eventIds[0];
                  const conflicting = events.find(e => e.id === conflictingId);
                  if (!conflicting) {
                    // Event vanished between detection and fix — skip.
                  } else {
                    const prot = protection.isProtected(conflicting, profile);
                    if (prot.protected) {
                      // Leave it for the owner — this is the "10-person
                      // meeting on a surprise vacation" case.
                      issue.protection_reasons = prot.reasons;
                    } else {
                      // Movable — start a move-coord to reschedule outside
                      // the OOF day. We search the NEXT 7 days forward
                      // from the day AFTER the OOF (we're not moving it
                      // earlier — vacation typically starts now).
                      const mStart = parseGraphDt(conflicting.start.dateTime, conflicting.start.timeZone, timezone);
                      const mEnd = parseGraphDt(conflicting.end.dateTime, conflicting.end.timeZone, timezone);
                      const durationMin = Math.round(mEnd.diff(mStart, 'minutes').minutes);

                      // v2.7.4 — only filter 'declined'; 'none' is Graph's
                      // default (untracked response) and should NOT drop the
                      // attendee. See parallel fix at line ~981.
                      const participantsRaw = (conflicting.attendees ?? []).filter(a => {
                        const status = a.status?.response;
                        return status !== 'declined';
                      });
                      const attendeeEmails = participantsRaw
                        .map(a => a.emailAddress.address)
                        .filter(Boolean);

                      // v2.5.2 — bidirectional search. Forward-only (the
                      // pre-v2.5.2 default) misses the natural "one day early"
                      // option when vacation starts the next morning: a
                      // Thursday OOF auto-move would never even consider
                      // Wednesday. Owner direction: search [-3d, +7d] around
                      // the OOF day, but never propose a date already in the
                      // past — clamp the lower bound at today.
                      const issueDt   = DateTime.fromISO(issue.date, { zone: timezone });
                      const earliest  = DateTime.now().setZone(timezone).startOf('day');
                      const lowerBound = DateTime.max(issueDt.minus({ days: 3 }).startOf('day'), earliest);
                      const searchFrom = lowerBound.toUTC().toISO()!;
                      let searchTo = issueDt.plus({ days: 7 }).endOf('day').toUTC().toISO()!;
                      // v2.1.4 — cadence-aware cap for recurring meetings
                      // displaced by a surprise OOF. Can't push a weekly
                      // forward into a week that already has its next
                      // instance; cap at (next occurrence - 1min).
                      const conflictingSeriesId = (conflicting as unknown as { seriesMasterId?: string }).seriesMasterId;
                      if (conflictingSeriesId) {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const cal = require('../connectors/graph/calendar') as typeof import('../connectors/graph/calendar');
                        const nextInstance = await cal.getNextSeriesOccurrenceAfter(
                          userEmail, conflictingSeriesId, mStart.toUTC().toISO()!,
                        );
                        if (nextInstance) {
                          const capped = DateTime.fromISO(nextInstance).minus({ minutes: 1 }).toUTC().toISO()!;
                          if (capped < searchTo) searchTo = capped;
                          logger.info('OOF move-coord: capped search at next series occurrence', {
                            conflictingId: conflicting.id, seriesMasterId: conflictingSeriesId,
                            nextInstance, capped,
                          });
                        }
                      }
                      const slots = await findAvailableSlots({
                        userEmail,
                        timezone,
                        durationMinutes: durationMin,
                        attendeeEmails: [userEmail, ...attendeeEmails],
                        searchFrom,
                        searchTo,
                        profile,
                      });
                      const proposed = slots.slice(0, 3).map(s => ({
                        start: s.start,
                        location: 'Online' as string,
                        isOnline: true,
                      }));
                      if (proposed.length === 0) {
                        issue.fix_failed = true;
                        issue.fix_error = 'No alternate slot in the next 7 days — leaving for owner.';
                      } else {
                        const coordParticipants = participantsRaw
                          .filter(a => a.emailAddress.address.toLowerCase() !== profile.user.email.toLowerCase())
                          .map(a => ({
                            name: a.emailAddress.name || a.emailAddress.address,
                            email: a.emailAddress.address,
                            tz: profile.user.timezone,
                          }));
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const stateMod = require('./meetings/coord/state') as typeof import('./meetings/coord/state');
                        const coordResult = await stateMod.initiateCoordination({
                          ownerUserId,
                          ownerChannel: context.channelId,
                          ownerThreadTs: context.threadTs,
                          ownerName: profile.user.name,
                          ownerEmail: profile.user.email,
                          ownerTz: profile.user.timezone,
                          subject: conflicting.subject ?? 'Meeting',
                          durationMin,
                          participants: coordParticipants as Parameters<typeof stateMod.initiateCoordination>[0]['participants'],
                          proposedSlots: proposed as Parameters<typeof stateMod.initiateCoordination>[0]['proposedSlots'],
                          profile,
                          moveExistingEvent: {
                            id: conflicting.id,
                            currentStartIso: mStart.toISO()!,
                            currentEndIso: mEnd.toISO()!,
                            conflictReason: `${profile.user.name.split(' ')[0]} is out of office on ${issue.date}`,
                          },
                        });
                        // v2.8.7 (bug 1.5) — honor initiateCoordination's
                        // 'no_participants' return. Owner-only events have
                        // coordParticipants=[] after the owner-filter above;
                        // state.ts returns the sentinel and does nothing.
                        // Pre-fix the calling code claimed "Started a
                        // move-coord ... DM'd ." (empty join) as if it
                        // succeeded, which is a straight lie in the brief
                        // (2026-05-19 Bookcamp incident). Flag as failed
                        // instead. Pairs with bug 1.1's solo-event filter —
                        // belt and suspenders.
                        if (coordResult === 'no_participants') {
                          issue.fix_failed = true;
                          issue.fix_error = `Can't auto-move "${conflicting.subject}" — meeting is owner-only, no one to coordinate with.`;
                        } else {
                          issue.fixed = true;
                          issue.fix_detail = `Started a move-coord to reschedule "${conflicting.subject}" — ${profile.user.name.split(' ')[0]}'s on vacation ${issue.date}. DM'd ${coordParticipants.map(p => p.name).join(' and ')}.`;
                          fixesApplied += 1;
                          // v3.1.2 (A1b-fix) — shadow-notify the owner the
                          // moment an active-mode coord fires. Active mode is
                          // by design autonomous (no pre-approval gate), but
                          // owner needs real-time visibility so he can
                          // countermand BEFORE the colleague responds. Pre-fix
                          // the owner only saw it in the next morning's
                          // brief — too late.
                          try {
                            // eslint-disable-next-line @typescript-eslint/no-require-imports
                            const { shadowNotify } = require('../utils/shadowNotify') as
                              typeof import('../utils/shadowNotify');
                            await shadowNotify(profile, {
                              channel: context.channelId,
                              action: 'Active-mode autofix — OOF conflict',
                              detail: `${profile.user.name.split(' ')[0]} on vacation ${issue.date}; started move-coord on "${conflicting.subject}" — DMed ${coordParticipants.map(p => p.name).join(', ')}. Say "cancel" to abort.`,
                            });
                          } catch (err) {
                            logger.warn('shadowNotify on active-mode coord threw — continuing', {
                              err: String(err).slice(0, 200),
                            });
                          }
                        }
                      }
                    }
                  }
                } catch (err) {
                  issue.fix_failed = true;
                  issue.fix_error = `OOF auto-move failed: ${String(err).slice(0, 200)}`;
                  logger.warn('OOF auto-move failed', {
                    issueDate: issue.date, err: String(err).slice(0, 300),
                  });
                }
              }
              else if (
                issue.type === 'double_booking'
                && issue.movable_event_id
                && issue.kept_event_id
              ) {
                // v2.1.1 — overlap with a clear movable side. Two paths:
                //   (b) Movable side is a regular internal-only meeting
                //       with attendees → MOVE-COORD: DM the attendees,
                //       propose slots, moveMeeting on their agreement.
                //   (c) Protected (4+ / external / rule-matched) or
                //       external-attendee on either side → skip entirely,
                //       report to owner.
                //
                // v2.9.3 (#104) — Path (a) (floating-block direct move from a
                // double_booking issue) deleted. It was unreachable: the
                // double_booking detector excludes floating blocks from its
                // pair-overlap scan (Exclusion 3 at the nonAllDay filter), so
                // no issue with movable=floating-block was ever produced. The
                // periodic rebalance sweep below the issue-loop now handles
                // every floating-block overlap on the day, regardless of how
                // the conflicting meeting was booked.
                try {
                  const movable = events.find(e => e.id === issue.movable_event_id);
                  const kept = events.find(e => e.id === issue.kept_event_id);
                  if (movable && kept) {
                    // ── Path (b): regular move-coord ──
                    // Gate on the MOVABLE side only — does the meeting we're
                    // about to move have any external attendees? If not, we
                    // can move-coord it (DM its internal attendees, propose
                    // slots, updateMeeting on agreement). The KEPT side's
                    // externals are exactly WHY it's kept; they don't block
                    // moving the OTHER side. Prior gate `issue.internal_only`
                    // (both-sides-internal) was too strict — for an
                    // internal-vs-external overlap, internal_only=false but
                    // the internal side is still freely movable. #76 surfaced
                    // this: Elan (internal) overlapped Gilly (external) and
                    // active mode silently skipped instead of moving Elan.
                    const movableHasExternal = protection.isProtected(movable, profile)
                      .reasons.includes('has external attendee');
                    if (movableHasExternal) {
                      // Movable side itself has externals — move-coord would
                      // need their say-so, which is owner-decision territory.
                      continue;
                    }
                    // v3.2.6 (Part C) — idempotency: if a move notice for THIS
                    // event is already open (awaiting the colleague), don't move
                    // + notify again on a later run. The direct move usually
                    // self-resolves the overlap, but this guards the window
                    // before the colleague replies (and a revert→re-detect race).
                    try {
                      // eslint-disable-next-line @typescript-eslint/no-require-imports
                      const { getDb } = require('../db') as typeof import('../db');
                      const inflight = getDb().prepare(
                        `SELECT 1 FROM outreach_jobs WHERE owner_user_id = ? AND intent = 'meeting_reschedule'
                           AND status = 'sent' AND context_json LIKE ? LIMIT 1`,
                      ).get(ownerUserId, `%${movable.id}%`);
                      if (inflight) {
                        logger.info('Overlap autofix — move notice for this event already open; skipping', { movableId: movable.id });
                        continue;
                      }
                    } catch (err) {
                      logger.warn('Overlap idempotency check threw — proceeding', { err: String(err).slice(0, 160) });
                    }
                    const mStart = parseGraphDt(movable.start.dateTime, movable.start.timeZone, timezone);
                    const mEnd = parseGraphDt(movable.end.dateTime, movable.end.timeZone, timezone);
                    const durationMin = Math.round(mEnd.diff(mStart, 'minutes').minutes);

                    // Find fresh slots to propose.
                    // v2.7.4 — only filter out 'declined'. Per Microsoft Graph
                    // docs, 'none' is the default response status — attendees
                    // who haven't been tracked yet (common when YOU organized
                    // and they haven't accepted). Outlook's "Didn't respond"
                    // UI label maps to 'none' AND 'notResponded'; both should
                    // KEEP the attendee for downstream coord/move logic.
                    const participantsRaw = (movable.attendees ?? []).filter(a => {
                      const status = a.status?.response;
                      return status !== 'declined';
                    });
                    const attendeeEmails = participantsRaw
                      .map(a => a.emailAddress.address)
                      .filter(Boolean);

                    // v2.1.4 — cadence-aware search window. For recurring
                    // occurrences, cap `searchTo` at the next instance of
                    // the same series (exclusive) — moving Brett's biweekly
                    // forward past the next biweekly would duplicate the
                    // cadence. For non-recurring meetings, use the legacy
                    // +2 days window. Fail-open: if the series lookup fails,
                    // proceed with default window (safer to propose than to
                    // stall silently).
                    const searchFrom = DateTime.fromISO(issue.date, { zone: timezone }).startOf('day').toUTC().toISO()!;
                    let searchTo = DateTime.fromISO(issue.date, { zone: timezone }).plus({ days: 2 }).endOf('day').toUTC().toISO()!;
                    const movableSeriesId = (movable as unknown as { seriesMasterId?: string }).seriesMasterId;
                    if (movableSeriesId) {
                      // eslint-disable-next-line @typescript-eslint/no-require-imports
                      const cal = require('../connectors/graph/calendar') as typeof import('../connectors/graph/calendar');
                      const nextInstance = await cal.getNextSeriesOccurrenceAfter(
                        userEmail, movableSeriesId, mStart.toUTC().toISO()!,
                      );
                      if (nextInstance) {
                        // Cap at 1 minute before the next instance — strict
                        // exclusion so the slot search can't land on the
                        // same moment as the next cadence firing.
                        const capped = DateTime.fromISO(nextInstance).minus({ minutes: 1 }).toUTC().toISO()!;
                        // Only apply the cap if it's EARLIER than the
                        // default window. If the next occurrence is far out
                        // (single non-recurring or rare cadence), keep the
                        // narrow default.
                        if (capped < searchTo) searchTo = capped;
                        logger.info('Overlap move-coord: capped search at next series occurrence', {
                          movableId: movable.id, seriesMasterId: movableSeriesId,
                          originalSearchTo: searchTo, nextInstance, capped,
                        });
                      }
                    }
                    // v3.2.6 (Part A) — keep the move within the SAME week as the
                    // conflict (owner direction: don't push it to next week).
                    // Clamp searchTo to the end of the conflict's week (Sun–Sat,
                    // owner-local). If nothing's free in-week, surface to the owner.
                    const conflictDt = DateTime.fromISO(issue.date, { zone: timezone });
                    const weekEndIso = conflictDt.minus({ days: conflictDt.weekday % 7 }).plus({ days: 6 }).endOf('day').toUTC().toISO()!;
                    if (weekEndIso < searchTo) searchTo = weekEndIso;

                    const slots = await findAvailableSlots({
                      userEmail,
                      timezone,
                      durationMinutes: durationMin,
                      attendeeEmails: [userEmail, ...attendeeEmails],
                      searchFrom,
                      searchTo,
                      profile,
                    });
                    // v3.2.6 (RC1) — prefer a slot that leaves floating blocks
                    // (lunch) untouched. Only displace a block when NO
                    // non-disturbing slot is free this week. This stops the
                    // "moved Eli onto lunch at 12:45, then shoved lunch to
                    // 13:30" damage — a free post-lunch slot wins over the
                    // earliest-but-lunch-colliding one.
                    const top = slots.find(s => !s.disturbs_floating_block) ?? slots[0];
                    if (!top) {
                      // v3.2.6 (Part A) — no in-week slot free for everyone. Per
                      // owner direction: do NOT push to next week — return it to him.
                      issue.fix_failed = true;
                      issue.fix_error = 'No slot free for everyone this week — left for you (move it yourself, or tell me to look next week).';
                    } else {
                      // v3.2.6 (Part A) — the movable meeting is internal-only
                      // (external attendees were gated out above) and `top` is a
                      // slot verified free for the owner + all attendees, IN-WEEK.
                      // MOVE IT DIRECTLY (owner authority, active mode), then notify
                      // the attendee(s) with a pushback escape hatch. No coord, no
                      // waiting, no orphan.
                      const subj = displaySubject(movable, profile) || 'Meeting';
                      const newStartIso = top.start;
                      const newEndIso = DateTime.fromISO(newStartIso).plus({ minutes: durationMin }).toUTC().toISO()!;
                      const conflictReason = protection.sanitizeConflictReason(kept, profile.user.name.split(' ')[0], profile);

                      await updateMeeting({ userEmail, timezone, meetingId: movable.id, start: newStartIso, end: newEndIso });
                      // Headless move — slide any floating block it landed on, in code.
                      try {
                        const { rebalanceFloatingBlocksAfterMutation } = await import('../utils/rebalanceFloatingBlocks');
                        await rebalanceFloatingBlocksAfterMutation({ profile, affectedSlotIso: newStartIso, ownerSlackId: ownerUserId });
                      } catch (rebErr) {
                        logger.warn('rebalance after overlap auto-move threw — continuing', { err: String(rebErr).slice(0, 160) });
                      }

                      // Notify each non-owner attendee. Calendar attendees carry
                      // email only → resolve slack_id (getPersonByEmail). The notice
                      // is a meeting_reschedule(already_moved) so a "doesn't work"
                      // reply routes back to the owner with a revert option.
                      // eslint-disable-next-line @typescript-eslint/no-require-imports
                      const { notifyColleagueOfMove } = require('./meetingReschedule') as typeof import('./meetingReschedule');
                      // eslint-disable-next-line @typescript-eslint/no-require-imports
                      const { getPersonByEmail } = require('../db') as typeof import('../db');
                      const notified: string[] = [];
                      for (const a of participantsRaw) {
                        const email = a.emailAddress.address;
                        if (!email || email.toLowerCase() === profile.user.email.toLowerCase()) continue;
                        const row = getPersonByEmail(email.trim().toLowerCase());
                        if (!row?.slack_id) continue; // can't DM → skip (meeting still moved; owner shadowed below)
                        await notifyColleagueOfMove({
                          profile,
                          ownerChannel: context.channelId,
                          ownerThreadTs: context.threadTs,
                          colleagueSlackId: row.slack_id,
                          colleagueName: a.emailAddress.name || row.name || email,
                          colleagueTz: row.timezone,
                          meetingId: movable.id,
                          meetingSubject: subj,
                          originalStartIso: mStart.toISO()!,
                          originalEndIso: mEnd.toISO()!,
                          newStartIso,
                          newEndIso,
                          conflictReason,
                        });
                        notified.push((a.emailAddress.name || row.name || email).split(' ')[0]);
                      }

                      const newLocal = DateTime.fromISO(newStartIso, { zone: timezone }).toFormat('EEE d MMM HH:mm');
                      issue.fixed = true;
                      issue.fix_detail = notified.length > 0
                        ? `Moved "${subj}" (was ${mStart.toFormat('HH:mm')}–${mEnd.toFormat('HH:mm')}) to ${newLocal} to clear the clash, and let ${notified.join(' and ')} know — I'll loop you in if they push back.`
                        : `Moved "${subj}" to ${newLocal} to clear the clash.`;
                      fixesApplied += 1;
                      internalActions.push({
                        tool: 'move_meeting',
                        detail: `Auto-moved "${subj}" to ${newLocal} (overlap autofix)${notified.length ? ` — notified ${notified.join(', ')}` : ''}`,
                      });
                      // Shadow-notify owner in real time — keeps autonomy, gives him
                      // a chance to "revert" before the colleague even replies.
                      try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { shadowNotify } = require('../utils/shadowNotify') as
                          typeof import('../utils/shadowNotify');
                        await shadowNotify(profile, {
                          channel: context.channelId,
                          action: `Active-mode autofix — ${issue.type}`,
                          detail: `${issue.description}. I moved "${subj}" to ${newLocal} (free for everyone, same week)${notified.length ? ` and let ${notified.join(', ')} know` : ''}. Say "revert" if you'd rather I hadn't.`,
                        });
                      } catch (err) {
                        logger.warn('shadowNotify on active-mode move threw — continuing', {
                          err: String(err).slice(0, 200),
                        });
                      }
                    }
                  }
                } catch (err) {
                  issue.fix_failed = true;
                  issue.fix_error = `Move-coord init failed: ${String(err).slice(0, 200)}`;
                  logger.warn('Move-coord for internal overlap failed', {
                    issueDate: issue.date, err: String(err).slice(0, 300),
                  });
                }
              }
              // Other overlap cases (both protected, external, unclear
              // movable side): intentionally unhandled — fall through to the
              // passive report path so the owner decides.
            } catch (err) {
              issue.fix_failed = true;
              issue.fix_error = String(err).slice(0, 300);
              logger.warn('Calendar health active-mode fix threw', {
                issueType: issue.type, date: issue.date, err: String(err).slice(0, 300),
              });
            }
          }

          // v2.3.1 (B12 / #67) — busy_day DM removed per owner direction.
          // He never asked for "rough day" alerts and they were firing
          // unsolicited. Active mode now only handles conflict / OOF /
          // missing-block / buffer issues.

          // v2.9.3 (#104) — periodic floating-block rebalance sweep. The
          // mutation-time hook (rebalanceFloatingBlocksAfterMutation in
          // meetings/ops.ts + coord/booking.ts) only fires when Maelle
          // herself booked or moved a meeting via her own tools. Events
          // added in Outlook directly never trigger it, leaving lunch (or
          // any floating block) sitting on top of a meeting until owner
          // notices. Active-mode runs twice a day; iterating each date in
          // the health window and calling the helper catches Outlook-direct
          // entries before the next brief. The helper self-checks "no
          // overlap → skip silently" so safe to call unconditionally per
          // date. Replaces the dead Path (a) inside the double_booking
          // branch — the detector excludes floating blocks from its
          // pair-overlap scan (line 463-470), so Path (a) could never fire.
          try {
            const { rebalanceFloatingBlocksAfterMutation } = await import('../utils/rebalanceFloatingBlocks');
            const sweepStart = DateTime.fromISO(startDate, { zone: timezone });
            const sweepEnd = DateTime.fromISO(endDate, { zone: timezone });
            const dayCount = Math.max(1, Math.floor(sweepEnd.diff(sweepStart, 'days').days) + 1);
            for (let d = 0; d < dayCount; d++) {
              const dt = sweepStart.plus({ days: d }).set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
              const affectedIso = dt.toUTC().toISO();
              if (!affectedIso) continue;
              const result = await rebalanceFloatingBlocksAfterMutation({
                profile,
                affectedSlotIso: affectedIso,
                ownerSlackId: profile.user.slack_user_id,
              });
              if (result.moved > 0) {
                internalActions.push({
                  tool: 'rebalance_floating_blocks',
                  detail: `Rebalanced ${result.moved} floating block(s) on ${dt.toFormat('EEE d MMM')} (sweep).`,
                });
                fixesApplied += result.moved;
              }
            }
          } catch (err) {
            logger.warn('Periodic rebalance sweep threw — continuing', {
              err: String(err).slice(0, 200),
            });
          }

          logger.info('Calendar health: active mode complete', {
            ownerUserId, fixesApplied, totalIssues: issues.length,
          });
        }

        // v3.1.7 / #119 — the old "drop .suppressed issues" pass is gone.
        // Days the owner waived are now skipped at DETECTION (never enter
        // issues[]), so there's nothing to filter out here before the brief.

        // v3.0.3 — cluster-based write for un-fixed issues. Maps HealthIssue
        // shape to DetectedIssue, groups via overlap edges into clusters,
        // upserts one row per cluster. Terminal rows suppress; active rows
        // merge/migrate; new clusters insert. After all clusters processed,
        // auto-stale flips any non-touched active row to 'resolved' (its
        // condition vanished since last detection).
        //
        // Active-mode SUCCESS (issue.fixed) → no row write. Failure or no-fix-
        // attempt → row gets written. Owner sees only what needs attention.
        const eventEndMs = new Map<string, number>();
        const eventDateByEventId = new Map<string, string>();
        const eventSubjectByEventId = new Map<string, string>();
        for (const e of events) {
          if (!e?.id) continue;
          try {
            const eEnd = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
            eventEndMs.set(e.id, eEnd.toMillis());
            eventDateByEventId.set(e.id, eEnd.toFormat('yyyy-MM-dd'));
            if (e.subject) eventSubjectByEventId.set(e.id, e.subject);
          } catch (_) { /* skip events with unparseable dates */ }
        }

        const classMap: Record<string, IssueClass> = {
          double_booking:           'overlap',
          oof_conflict:             'oof_with_meetings',
          category_limit_exceeded:  'category_limit',
          missing_floating_block:   'missing_floating_block',
          busy_day:                 'busy_day',
        };

        const detectedForWrite: DetectedIssue[] = [];
        const dateFallback = new Map<string, string>();
        for (const issue of issues) {
          if (issue.fixed) continue;  // active-mode success → no row
          const cls = classMap[issue.type];
          if (!cls) continue;          // missing_category / unknown — not tracked
          const eIds = issue.eventIds ?? [];
          let primaryId: string | undefined = eIds[0];
          let peerId: string | undefined = eIds[1];
          // missing_floating_block: synthesize event_id per owner direction
          // ({NNN}-{MMDDYYYY}-{HHMM}). Index from profile.meetings.floating_blocks.
          if (cls === 'missing_floating_block') {
            // v3.1.7 / #119 — synthetic id via the single-source helper. Must
            // match the detection-suppression, approve, and delete→dismiss
            // paths exactly (they all call the same helper), so a waived gap
            // suppresses and a re-detected gap re-anchors the same row.
            const synth = fb.floatingBlockSyntheticEventId(profile, issue.block_name ?? '', issue.date, timezone);
            if (synth) {
              primaryId = synth.eventId;
              peerId = undefined;
              eventEndMs.set(primaryId, synth.eventEndMs);
              dateFallback.set(primaryId, issue.date);
            }
          }
          if (!primaryId) continue;
          const endMs = eventEndMs.get(primaryId) ?? 0;
          const peerEnd = peerId ? eventEndMs.get(peerId) : undefined;
          // Use issue.date as the date fallback when we don't have it from events.
          if (!eventDateByEventId.has(primaryId)) {
            eventDateByEventId.set(primaryId, dateFallback.get(primaryId) ?? issue.date);
          }
          const detail = issue.fix_failed
            ? `auto-fix attempted: ${issue.fix_error ?? 'unknown reason'} (${issue.description})`
            : issue.description;
          detectedForWrite.push({
            class: cls,
            event_id: primaryId,
            event_subject: eventSubjectByEventId.get(primaryId),
            event_end_ms: endMs,
            peer_event_id: peerId,
            peer_subject: peerId ? eventSubjectByEventId.get(peerId) : undefined,
            peer_end_ms: peerEnd,
            detail,
          });
        }

        const touchedRowIds = new Set<string>();
        if (detectedForWrite.length > 0) {
          const clusters = buildClusters(detectedForWrite, eventDateByEventId);
          for (const c of clusters) {
            // status: 'awaiting_owner' is the post-detection landing for
            // passive mode and for active-mode-failure. We set it
            // unconditionally here — the caller decides whether to narrate.
            const res = upsertCluster(ownerUserId, c, 'awaiting_owner');
            if (res.row_id && (res.action === 'insert' || res.action === 'update' || res.action === 'merge')) {
              touchedRowIds.add(res.row_id);
              if (res.action === 'insert') newIssueCount += 1;
            }
          }
        }
        // Auto-stale anything not touched in this pass within the date range.
        markStaleResolved(ownerUserId, touchedRowIds, startDate, endDate);

        // Route 2 narration. Build a deterministic per-issue summary text
        // directly from the issue list + fix outcomes. The routine prompt
        // uses this verbatim instead of asking Sonnet to "tell me what got
        // done" (fabrications crept in when fix_failed wasn't narrated
        // honestly). humanGate humanizes the template downstream. One
        // truth source.
        const summaryLines: string[] = [];
        for (const i of issues) {
          if (i.fixed && i.fix_detail) {
            // Successful fix — narrate the action.
            summaryLines.push(`✓ ${i.fix_detail}`);
          } else if (i.fix_failed) {
            // Attempted fix but failed — narrate the attempt + the reason.
            const reason = i.fix_error ?? 'unknown reason';
            summaryLines.push(`× Tried to fix "${i.description}" but couldn't: ${reason}`);
          } else if (mode === 'active') {
            // Detected but no autofix attempted (or autofix skipped). Surface.
            summaryLines.push(`! Detected: ${i.description}`);
          }
        }
        const summaryText = summaryLines.length > 0
          ? summaryLines.join('\n')
          : (issues.length === 0
              ? 'Calendar looks healthy — no issues found.'
              : `Scanned ${startDate} to ${endDate} — ${issues.length} issue${issues.length === 1 ? '' : 's'} detected.`);

        // v3.1.2 fix (#118) — vacuous flag: nothing found, nothing fixed.
        // Routine dispatcher checks this to stay silent on auto-fired runs
        // (the routine prompt already says "stay silent if nothing to report"
        // but Sonnet ignored it). Owner-asked runs from chat don't go through
        // dispatchRoutine, so they ignore this flag and narrate normally so
        // the owner can verify "all good".
        const vacuous = issues.length === 0 && fixesApplied === 0;
        return {
          issues,
          count: issues.length,
          mode,
          fixes_applied: fixesApplied,
          // v2.6.5 — surface internal mutations so the claim-checker doesn't
          // false-positive on legitimate auto-fix claims. Empty array stays
          // empty — only populated when active mode actually mutated something.
          internal_actions: internalActions.length > 0 ? internalActions : undefined,
          activeTrackedIssues: activeIssues.length > 0 ? activeIssues : undefined,
          // v2.7.4 — deterministic summary text the caller (routine, brief,
          // narration) should pass verbatim instead of having Sonnet improvise
          // from issues[]. humanGate humanizes the template downstream.
          summary_text: summaryText,
          vacuous,
          summary: issues.length === 0
            ? 'Calendar looks healthy — no issues found.'
            : mode === 'active'
            ? `Scanned ${startDate} to ${endDate}: ${issues.length} issue${issues.length === 1 ? '' : 's'} found, ${fixesApplied} fixed automatically. Remaining need your input.`
            : `Found ${issues.length} issue${issues.length === 1 ? '' : 's'} across ${startDate} to ${endDate}.${newIssueCount > 0 ? ` ${newIssueCount} new issue(s) tracked for follow-up.` : ''}`,
        };
      }

      case 'book_floating_block': {
        const date = args.date as string;
        const blockName = (args.block_name as string | undefined)?.trim();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
        const blocks = fb.getFloatingBlocks(profile);
        if (blocks.length === 0) {
          return { error: 'no_floating_blocks', message: 'No floating blocks configured in profile.' };
        }
        const block = blockName ? blocks.find(b => b.name === blockName) : undefined;
        if (!block) {
          return {
            error: 'unknown_block',
            message: `Unknown block_name "${blockName ?? ''}". Configured blocks: ${blocks.map(b => b.name).join(', ')}.`,
          };
        }

        const blockLabel = block.default_subject ?? (block.name.charAt(0).toUpperCase() + block.name.slice(1).replace(/_/g, ' '));
        const dayName = DateTime.fromISO(date, { zone: timezone }).toFormat('EEEE');

        // Owner-override path — owner explicitly directs an out-of-window
        // (or off-schedule-day) booking. The flag IS the approval; the same
        // pattern as v2.3.3 find_available_slots.relaxed and v2.2.1
        // colleague-path move_meeting auto-accept. Only the window/day-scope
        // bend; buffer + conflict + alignment checks still hold below.
        const confirmOutsideWindow = args.confirm_outside_window === true;
        const explicitStartTime = (args.start_time as string | undefined)?.trim();

        if (!confirmOutsideWindow && !fb.blockAppliesOnDay(block, dayName, profile)) {
          return {
            error: 'not_applicable_today',
            message: `${blockLabel} isn't scheduled for ${dayName} in your profile (days: ${(block.days ?? ['every work day']).join(', ')}). If owner explicitly directs you to book it on this day anyway, retry with confirm_outside_window=true and start_time="HH:MM".`,
          };
        }

        // Get events for the day to find a free slot in the block window
        let events: CalendarEvent[];
        try {
          events = await getCalendarEvents(userEmail, date, date, timezone);
        } catch (err) {
          logger.error('book_floating_block: failed to fetch events', { err, blockName });
          return { error: 'Failed to fetch calendar events.' };
        }

        const windowStart = DateTime.fromISO(`${date}T${block.preferred_start}`, { zone: timezone });
        const windowEnd = DateTime.fromISO(`${date}T${block.preferred_end}`, { zone: timezone });

        // Owner-override branch — when confirm_outside_window=true AND a
        // start_time was given, skip the positional/window logic entirely
        // and book at the explicit time. Buffer + conflict checks still run.
        if (confirmOutsideWindow && explicitStartTime) {
          if (!/^\d{2}:\d{2}$/.test(explicitStartTime)) {
            return {
              error: 'invalid_start_time',
              message: `start_time must be HH:MM (24h). Got "${explicitStartTime}".`,
            };
          }
          const rawOverrideStart = DateTime.fromISO(`${date}T${explicitStartTime}`, { zone: timezone });
          if (!rawOverrideStart.isValid) {
            return { error: 'invalid_start_time', message: `Couldn't parse ${date}T${explicitStartTime} in ${timezone}.` };
          }
          // Snap off-grid start_time to the NEAREST quarter so the standard
          // :00/:15/:30/:45 grid the rest of the system assumes is honored.
          // The tool description promises this; pre-fix the override branch
          // skipped alignment entirely (positional path snapped via
          // findAlignedSlotForBlock, but the override branch doesn't go
          // through that helper).
          const overrideStart = DateTime.fromMillis(
            fb.alignNearestQuarter(rawOverrideStart.toMillis(), timezone),
          ).setZone(timezone);
          const overrideEnd = overrideStart.plus({ minutes: block.duration_minutes });

          // Idempotency — any same-block event on this day already on the
          // calendar (anywhere, not just near the override time). Pre-fix
          // this only matched within ±60s of the override start, which
          // meant a 14:00 override on a day that already had lunch booked
          // at 11:30 would CREATE A SECOND lunch. Owner sees two lunches
          // same day. Match the same shape the non-override branch uses
          // at :1531 (any block event on the day → already_existed).
          const existingNearby = events.find(e => {
            if (e.isAllDay || e.isCancelled || e.showAs === 'free') return false;
            if (!fb.isFloatingBlockEvent(
              { subject: e.subject, categories: e.categories },
              block,
            )) return false;
            const eStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
            return eStart.toFormat('yyyy-MM-dd') === date;
          });
          if (existingNearby) {
            const eStart = parseGraphDt(existingNearby.start.dateTime, existingNearby.start.timeZone, timezone);
            const eEnd = parseGraphDt(existingNearby.end.dateTime, existingNearby.end.timeZone, timezone);
            return {
              ok: true, created: false, already_existed: true,
              event_id: existingNearby.id, subject: existingNearby.subject,
              start: eStart.toFormat('HH:mm'), end: eEnd.toFormat('HH:mm'),
              date, block_name: block.name, override_used: true,
              message: `${blockLabel} is already on the calendar on ${date} at ${eStart.toFormat('HH:mm')}–${eEnd.toFormat('HH:mm')}. To move it to ${explicitStartTime}, use move_meeting with confirm_outside_window=true rather than book_floating_block.`,
            };
          }

          // Override is TOTAL. No conflict / buffer check in this branch.
          // Owner direction: "she can raise a flag, but if I say yes, it's
          // yes." By the time the tool is called with confirm_outside_window
          // = true, owner has already seen the conversational warning and
          // re-consented. The tool obeys — true overlap, back-to-back,
          // off-hours all allowed. Maelle can warn in the conversation
          // (and does), but does not refuse via tool-level conflict error.

          // Delegate category/location/rule-check to planMeeting.
          // Window-aware slot finding stays here; the booking step joins
          // the unified flow. confirm_outside_window=true → allowRelaxed=true
          // so planMeeting bypasses outside-working-hours etc., matching the
          // historical override semantic.
          let blockCategories: string[] | undefined = undefined;
          let blockLocation: string = '';
          let blockIsOnline: boolean = false;
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { planMeeting } = require('./meetings/planMeeting') as typeof import('./meetings/planMeeting');
            const plan = await planMeeting({
              profile,
              intent: 'new_booking',
              initiator: 'owner',
              initiatorSlackId: context.userId,
              slotStartIso: overrideStart.toISO()!,
              slotEndIso: overrideEnd.toISO()!,
              subject: blockLabel,
              participants: [],
              allowRelaxed: true,  // override path always bypasses soft rules
              isFloatingBlock: true,  // skip owner_busy_collision — focus/lunch blocks coexist with meetings
            });
            if (plan.action === 'confirm_override' || plan.action === 'escalate_approval') {
              // Should be unreachable with allowRelaxed=true. If somehow
              // hit, surface the violation back to Sonnet.
              return {
                error: 'rule_violation',
                message: `Override slot still violates a rule planMeeting can't bypass: ${plan.violationLabel}`,
              };
            }
            if (plan.action === 'book') {
              if (plan.category) blockCategories = [plan.category];
              blockLocation = plan.location;
              blockIsOnline = plan.isOnline;
            }
          } catch (err) {
            logger.warn('book_floating_block override-path: planMeeting threw, falling back to raw category', {
              err: String(err).slice(0, 200),
            });
          }

          // Fallback: yaml block.default_category if planMeeting couldn't classify.
          if (!blockCategories) {
            const categoryArg = (args.category as string | undefined)?.trim();
            const validCategoryNames = (profile.categories ?? []).map(c => c.name);
            if (block.default_category && validCategoryNames.includes(block.default_category)) {
              blockCategories = [block.default_category];
            } else if (categoryArg && (validCategoryNames.length === 0 || validCategoryNames.includes(categoryArg))) {
              blockCategories = [categoryArg];
            }
          }

          try {
            const created = await createMeeting({
              subject: blockLabel,
              start: overrideStart.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
              end: overrideEnd.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
              attendees: [],
              body: `<p>${blockLabel} — booked by ${profile.assistant.name}, ${profile.user.name.split(' ')[0]} Assistant. (Owner-override: outside the ${block.preferred_start}-${block.preferred_end} window.)</p>`,
              isOnline: blockIsOnline,
              location: blockLocation || undefined,
              categories: blockCategories,
              userEmail,
              timezone,
            });
            const eventId = created.id;
            logger.info('book_floating_block: owner-override booking', {
              blockName: block.name, date, start_time: explicitStartTime,
              window: `${block.preferred_start}-${block.preferred_end}`,
              event_id: eventId,
            });
            return {
              ok: true, created: true, already_existed: false,
              event_id: eventId, subject: blockLabel,
              start: overrideStart.toFormat('HH:mm'),
              end: overrideEnd.toFormat('HH:mm'),
              date, block_name: block.name, booked: true,
              override_used: true,
              window: { start: block.preferred_start, end: block.preferred_end },
              message: `I booked ${blockLabel} on ${date} from ${overrideStart.toFormat('HH:mm')} to ${overrideEnd.toFormat('HH:mm')} — outside your usual ${block.preferred_start}-${block.preferred_end} window per your direction.`,
              assistant_hint: `Acknowledge the override briefly when narrating ("booked at ${overrideStart.toFormat('HH:mm')} per your call, outside the usual window") so the owner sees the trade-off was logged. Don't apologize — they asked for it.`,
            };
          } catch (err) {
            logger.error('book_floating_block: failed to create override event', { err, blockName });
            return { error: `Failed to create ${blockLabel} event: ${String(err)}` };
          }
        }

        if (confirmOutsideWindow && !explicitStartTime) {
          return {
            error: 'override_needs_start_time',
            message: `confirm_outside_window=true requires start_time="HH:MM". The override path doesn't infer a time — owner must direct it explicitly.`,
          };
        }

        // Idempotency: if the block's event already exists in the window,
        // return created:false. Bug-3 fix: the message now ATTRIBUTES the
        // booking to Maelle herself instead of phrasing it as discovered
        // calendar state. The previous wording ("Lunch is already on the
        // calendar...") was being parroted verbatim by Sonnet, making her
        // narrate her own bookings as if she'd just stumbled onto them.
        const existingEvent = events.find(e => {
          if (e.isAllDay || e.isCancelled || e.showAs === 'free') return false;
          const matches = fb.isFloatingBlockEvent(
            { subject: e.subject, categories: e.categories },
            block,
          );
          if (!matches) return false;
          const eStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
          const eEnd = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
          return eStart.toMillis() < windowEnd.toMillis() && eEnd.toMillis() > windowStart.toMillis();
        });
        if (existingEvent) {
          const eStart = parseGraphDt(existingEvent.start.dateTime, existingEvent.start.timeZone, timezone);
          const eEnd = parseGraphDt(existingEvent.end.dateTime, existingEvent.end.timeZone, timezone);
          return {
            ok: true,
            created: false,
            already_existed: true,
            event_id: existingEvent.id,
            subject: existingEvent.subject,
            start: eStart.toFormat('HH:mm'),
            end: eEnd.toFormat('HH:mm'),
            date,
            block_name: block.name,
            // Bug-3 fix: action-attributed phrasing. Read as "you (Maelle)
            // already did this" rather than "the calendar happens to have
            // this." Pairs with the action-tape closing line that asks
            // Sonnet to lead with what she did.
            message: `You already booked ${blockLabel} on ${date} at ${eStart.toFormat('HH:mm')}–${eEnd.toFormat('HH:mm')} — same slot, no change.`,
            assistant_hint: `You (Maelle) booked this earlier in this conversation. Narrate as your action ("I booked it at ${eStart.toFormat('HH:mm')}"), not as discovered state ("it's on the calendar").`,
          };
        }

        // Busy blocks in the window, EXCLUDING events that are this block
        // (we're about to book one; don't let a stale one self-block).
        const busyInWindow = events
          .filter(e => {
            if (e.isAllDay || e.isCancelled || e.showAs === 'free') return false;
            if (fb.isFloatingBlockEvent(
              { subject: e.subject, categories: e.categories },
              block,
            )) return false;
            const eStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
            const eEnd = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
            return eStart.toMillis() < windowEnd.toMillis() && eEnd.toMillis() > windowStart.toMillis();
          })
          .map(e => ({
            start: Math.max(parseGraphDt(e.start.dateTime, e.start.timeZone, timezone).toMillis(), windowStart.toMillis()),
            end: Math.min(parseGraphDt(e.end.dateTime, e.end.timeZone, timezone).toMillis(), windowEnd.toMillis()),
          }));

        // v3.0.2 — floating-block math no longer applies a buffer (meeting
        // durations 10/25/40/55 already carry natural spacing). The previous
        // `profile.meetings.buffer_minutes ?? 0` was a path for the owner's
        // yaml-set buffer to leak in here and reject in-window slots.
        //
        // Default chain: explicit Sonnet arg wins; otherwise the yaml-set
        // `block.prefer_position` (interface doc on FloatingBlock promises
        // this); else 'earliest'. Without the middle tier, an auto-book from
        // missing_floating_block ignored an owner-set `latest_in_window` and
        // always landed at earliest.
        const yamlPreferPosition = block.prefer_position === 'latest_in_window'
          ? 'latest_in_window'
          : undefined;
        const preferPosition = ((args.prefer_position as string | undefined)
          ?? yamlPreferPosition
          ?? 'earliest') as PreferPosition;
        const anchorEventId = (args.anchor_event_id as string | undefined)?.trim();
        let anchor: AnchorEvent | undefined;
        if (anchorEventId) {
          const anchorEvent = events.find(e => e.id === anchorEventId);
          if (!anchorEvent) {
            return {
              error: 'anchor_not_found',
              message: `anchor_event_id ${anchorEventId} doesn't appear in the calendar for ${date}. Either pick a different anchor or call get_calendar to refresh ids.`,
            };
          }
          anchor = {
            start: parseGraphDt(anchorEvent.start.dateTime, anchorEvent.start.timeZone, timezone).toMillis(),
            end: parseGraphDt(anchorEvent.end.dateTime, anchorEvent.end.timeZone, timezone).toMillis(),
          };
        }

        const slotResult = fb.findPositionalSlotForBlock(
          block, date, timezone, busyInWindow, preferPosition, anchor,
        );

        if ('error' in slotResult) {
          // Diagnostic: list the busy blocks that fragmented the window.
          // Without this, "no_room" is opaque — Sonnet narrates "tight" or
          // "no clean window" with no specifics, and the owner has to guess
          // why a slot he eyeballs as free was rejected.
          const busyDetails = busyInWindow
            .sort((a, b) => a.start - b.start)
            .map(b => ({
              start: DateTime.fromMillis(b.start).setZone(timezone).toFormat('HH:mm'),
              end: DateTime.fromMillis(b.end).setZone(timezone).toFormat('HH:mm'),
            }));
          logger.info('book_floating_block: rejection — diagnostic', {
            blockName: block.name,
            date,
            window: `${block.preferred_start}-${block.preferred_end}`,
            duration_min: block.duration_minutes,
            prefer_position: preferPosition,
            anchor_event_id: anchorEventId,
            error: slotResult.error,
            detail: slotResult.detail,
            busyInWindow: busyDetails,
          });

          // Map error codes to human-friendly messages. The diagnostic detail
          // string from the helper is already specific (e.g. "abut_before
          // would land at 12:15-12:40, conflicting with a busy block at
          // 12:25-12:30") so we surface it directly.
          const messageByError: Record<string, string> = {
            no_room: `No room for a ${block.duration_minutes}-minute ${blockLabel} between ${block.preferred_start} and ${block.preferred_end} on ${date} with quarter-hour alignment.`,
            anchor_required: slotResult.detail,
            anchor_outside_window: `${blockLabel} doesn't fit ${preferPosition === 'abut_before' ? 'before' : 'after'} the anchor inside the ${block.preferred_start}-${block.preferred_end} window: ${slotResult.detail}`,
            anchor_conflicts_busy: `${blockLabel} can't abut the anchor without conflicting: ${slotResult.detail}`,
            unknown_position: slotResult.detail,
          };

          return {
            error: slotResult.error,
            message: messageByError[slotResult.error] ?? slotResult.detail,
            detail: slotResult.detail,
            window: { start: block.preferred_start, end: block.preferred_end },
            duration_minutes: block.duration_minutes,
            prefer_position: preferPosition,
            busy_blocks_in_window: busyDetails,
            assistant_hint: slotResult.error === 'no_room' && busyDetails.length > 0
              ? `The window was fragmented by these busy blocks: ${busyDetails.map(b => `${b.start}-${b.end}`).join(', ')}. With quarter-hour alignment, no aligned ${block.duration_minutes}-min slot fit any gap. If the owner pushes back ("but I have time at HH:MM"), explain WHICH busy block conflicts — don't just say "tight".`
              : slotResult.error === 'anchor_outside_window'
              ? `Tell the owner honestly: the requested position lands outside the block's preferred window (${block.preferred_start}-${block.preferred_end}). Don't fall back to create_meeting at the boundary time — that's a policy_exception approval (deferred_action move_meeting with confirm_outside_window=true) if the owner explicitly wants to override.`
              : slotResult.error === 'anchor_conflicts_busy'
              ? `Tell the owner the abut slot conflicts with another meeting (named in the detail above). Either pick a different anchor or fall back to earliest position.`
              : undefined,
          };
        }

        const bestStart = slotResult.ms;

        const blockStart = DateTime.fromMillis(bestStart).setZone(timezone);
        const blockEnd = blockStart.plus({ minutes: block.duration_minutes });

        // v2.7.4 — delegate category/location/rule-check to planMeeting so
        // the floating-block path uses the same engine as regular bookings.
        // Window-aware slot finding stayed above; the booking step is unified.
        let blockCategories: string[] | undefined = undefined;
        let blockLocation: string = '';
        let blockIsOnline: boolean = false;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { planMeeting } = require('./meetings/planMeeting') as typeof import('./meetings/planMeeting');
          const plan = await planMeeting({
            profile,
            intent: 'new_booking',
            initiator: 'owner',
            initiatorSlackId: context.userId,
            slotStartIso: blockStart.toISO()!,
            slotEndIso: blockEnd.toISO()!,
            subject: blockLabel,
            participants: [],
            // Inside the block's preferred window — soft rules should pass,
            // so allowRelaxed stays false. If a rule fires, return error
            // pointing Sonnet to retry with confirm_outside_window=true.
            allowRelaxed: false,
            isFloatingBlock: true,  // skip owner_busy_collision — focus/lunch blocks coexist with meetings
          });
          if (plan.action === 'confirm_override' || plan.action === 'escalate_approval') {
            return {
              error: 'rule_violation',
              violation_label: plan.violationLabel,
              suggested_ask_text: plan.suggestedAskText,
              message: `${blockLabel} at ${blockStart.toFormat('HH:mm')} on ${date} can't book: ${plan.violationLabel}. To override, retry book_floating_block with confirm_outside_window=true and start_time="${blockStart.toFormat('HH:mm')}".`,
            };
          }
          if (plan.action === 'book') {
            if (plan.category) blockCategories = [plan.category];
            blockLocation = plan.location;
            blockIsOnline = plan.isOnline;
          }
        } catch (err) {
          logger.warn('book_floating_block: planMeeting threw, falling back to yaml category', {
            err: String(err).slice(0, 200),
          });
        }

        // Fallback ladder: planMeeting category → yaml block.default_category → Sonnet's arg → none.
        if (!blockCategories) {
          const categoryArg = (args.category as string | undefined)?.trim();
          const validCategoryNames = (profile.categories ?? []).map(c => c.name);
          if (block.default_category && validCategoryNames.includes(block.default_category)) {
            blockCategories = [block.default_category];
          } else if (categoryArg) {
            if (validCategoryNames.length === 0 || validCategoryNames.includes(categoryArg)) {
              blockCategories = [categoryArg];
            } else {
              logger.warn('book_floating_block: agent proposed category not in profile — dropping', {
                proposed: categoryArg,
                allowed: validCategoryNames,
                blockName: block.name,
              });
            }
          }
        }

        try {
          const created = await createMeeting({
            subject: blockLabel,
            start: blockStart.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            end: blockEnd.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            attendees: [],
            // Invite-body attribution names this assistant + owner.
            body: `<p>${blockLabel} — booked by ${profile.assistant.name}, ${profile.user.name.split(' ')[0]} Assistant.</p>`,
            isOnline: blockIsOnline,
            location: blockLocation || undefined,
            categories: blockCategories,
            // No sensitivity tag — pre-v2.1.7 'personal' stamps caused the
            // recurring "Private block" misdetection bug. Floating-block
            // matching is subject-regex/category based via
            // isFloatingBlockEvent, so leaving sensitivity at default
            // ('normal') doesn't affect detection.
            userEmail,
            timezone,
          });
          const eventId = created.id;

          // Surface any pre-existing meetings sitting inside the booked
          // floating-block window. Floating blocks coexist with meetings by
          // design, but the caller (Sonnet) should know so she can offer to
          // move them: "Blocked 13:00–18:15. Your BiWeekly at 17:00 sits
          // inside — want me to find it a new slot?"
          const overlapping = events
            .filter(ev => !ev.isCancelled && (ev as any).showAs !== 'free')
            .filter(ev => {
              const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
              const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' });
              return evStart < blockEnd && evEnd > blockStart;
            })
            .map(ev => ({
              event_id: ev.id,
              subject: ev.subject,
              start: DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' })
                .setZone(timezone).toFormat('HH:mm'),
              end: DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' })
                .setZone(timezone).toFormat('HH:mm'),
            }));

          return {
            ok: true,
            created: true,
            already_existed: false,
            event_id: eventId,
            subject: blockLabel,
            start: blockStart.toFormat('HH:mm'),
            end: blockEnd.toFormat('HH:mm'),
            date,
            block_name: block.name,
            booked: true,
            message: `I booked ${blockLabel} on ${date} from ${blockStart.toFormat('HH:mm')} to ${blockEnd.toFormat('HH:mm')}.`,
            ...(overlapping.length > 0 ? { overlapping_events: overlapping } : {}),
          };
        } catch (err) {
          logger.error('book_floating_block: failed to create event', { err, blockName });
          return { error: `Failed to create ${blockLabel} event: ${String(err)}` };
        }
      }

      case 'set_event_category': {
        const eventId = args.event_id as string;
        const categories = args.categories as string[];

        try {
          await updateMeeting({
            userEmail,
            meetingId: eventId,
            timezone,
            categories,
          });

          return {
            updated: true,
            event_id: eventId,
            categories,
            message: `Categories set to: ${categories.join(', ')}`,
          };
        } catch (err) {
          logger.error('Calendar health: failed to set category', { err, eventId });
          return { error: `Failed to update event category: ${String(err)}` };
        }
      }

      case 'manage_calendar_issue': {
        const action = String(args.action ?? '').toLowerCase();
        const issueId = args.issue_id as string | undefined;
        const notes = args.notes as string | undefined;
        const ownerUserId = profile.user.slack_user_id;

        if (action === 'list') {
          const rows = getActiveCalendarIssues(ownerUserId);
          return {
            issues: rows,
            count: rows.length,
            summary: rows.length === 0
              ? 'No outstanding calendar issues.'
              : `${rows.length} active issue(s) need attention.`,
          };
        }

        // v3.0.6 — preemptive approve for floating-block gaps. When owner
        // waives a gap in conversation ("no lunch tomorrow — Natan meeting
        // includes it"), Maelle calls approve with date + block_name and we
        // insert a terminal row directly. Tomorrow's check_calendar_health
        // sees the matching synthetic event_id in upsertCluster, returns
        // 'suppressed', and the gap doesn't re-narrate. Path closed without
        // first having to materialize the issue row via check_calendar_health.
        if (action === 'approve' && !issueId) {
          const date = (args.date as string | undefined)?.trim();
          const blockName = (args.block_name as string | undefined)?.trim();
          if (!date || !blockName) {
            return {
              error: 'missing_args',
              message: `'approve' needs either issue_id OR (date + block_name) to preemptively dismiss a floating-block gap.`,
            };
          }
          const fbs = profile.meetings.floating_blocks ?? [];
          const idx = fbs.findIndex(b => b.name === blockName);
          if (idx === -1) {
            return {
              error: 'unknown_block',
              message: `block_name="${blockName}" not in profile.meetings.floating_blocks. Known: ${fbs.map(b => b.name).join(', ') || '(none configured)'}`,
            };
          }
          // v3.1.7 / #119 — synthetic id via the single-source helper (same
          // formula the detector + delete→dismiss paths use, so the terminal
          // row this writes actually matches what detection later looks up).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { floatingBlockSyntheticEventId } = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
          const synth = floatingBlockSyntheticEventId(profile, blockName, date, timezone);
          if (!synth) {
            return { error: 'bad_date', message: `date="${date}" is not a valid YYYY-MM-DD.` };
          }
          const syntheticEventId = synth.eventId;
          const eventEndMs = synth.eventEndMs;

          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getDb } = require('../db') as typeof import('../db');
          const db = getDb();
          const existing = db.prepare(
            `SELECT id FROM calendar_issues WHERE owner_user_id = ? AND event_id = ?`,
          ).get(ownerUserId, syntheticEventId) as { id: string } | undefined;

          if (existing) {
            db.prepare(`
              UPDATE calendar_issues
              SET status = 'approved',
                  notes = COALESCE(?, notes),
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(notes ?? null, existing.id);
          } else {
            const id = `ci_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            db.prepare(`
              INSERT INTO calendar_issues
                (id, owner_user_id, event_id, peer_event_id, event_date, event_end_ms,
                 issue_class, status, notes, request_id)
              VALUES (?, ?, ?, NULL, ?, ?, 'missing_floating_block', 'approved', ?, NULL)
            `).run(id, ownerUserId, syntheticEventId, date, eventEndMs, notes ?? null);
          }

          auditLog({
            action: 'manage_calendar_issue',
            source: 'calendar_health',
            actor: profile.user.name,
            details: { action: 'approve', method: 'preemptive', date, block_name: blockName, synthetic_event_id: syntheticEventId, notes },
            outcome: 'success',
          });

          return {
            ok: true,
            method: 'preemptive_approve',
            synthetic_event_id: syntheticEventId,
            message: `${blockName} gap on ${date} marked approved — future detection will suppress.`,
          };
        }

        // All other non-list actions need issue_id.
        if (!issueId) {
          return { error: 'issue_id_required', message: `${action} requires issue_id. Get it from manage_calendar_issue(list) or check_calendar_health.` };
        }

        // Map action → status. Reject unknown actions.
        const statusByAction: Record<string, IssueStatus> = {
          approve:            'approved',
          start_resolve:      'in_progress',
          owner_will_resolve: 'owner_side',
          owner_done:         'resolved',
        };
        const newStatus = statusByAction[action];
        if (!newStatus) {
          return { error: 'bad_action', message: `manage_calendar_issue action must be 'list' | 'approve' | 'start_resolve' | 'owner_will_resolve' | 'owner_done', got "${action}".` };
        }

        // start_resolve opens a follow_up request before flipping the row
        // so the row carries a request_id back. Other actions just update.
        let requestId: string | undefined;
        if (action === 'start_resolve') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createRequest } = require('../db/requests') as
              typeof import('../db/requests');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getCalendarIssueById } = require('../db/calendarIssues') as
              typeof import('../db/calendarIssues');
            const row = getCalendarIssueById(issueId);
            const subject = row
              ? `Resolve ${row.issue_class}: ${(notes ?? '').slice(0, 60) || row.event_date}`
              : 'Resolve calendar issue';
            const created = createRequest({
              ownerUserId,
              initiatedBy: ownerUserId,
              initiatedByRole: 'owner',
              kind: 'follow_up',
              subkind: 'calendar_fix',
              subject,
              description: `Calendar issue fix — ${row?.issue_class ?? '(unknown class)'} on ${row?.event_date ?? '?'}. ${notes ?? ''}`.trim(),
              state: 'in_flight',
              informed: 1,
              outcomeExternalEventId: row?.event_id,
              details: { calendar_issue_id: issueId, notes },
            });
            requestId = created.id;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { attachRequestToIssue } = require('../db/calendarIssues') as
              typeof import('../db/calendarIssues');
            attachRequestToIssue(issueId, requestId);
          } catch (err) {
            logger.warn('start_resolve — request creation failed, falling back to status-only', {
              issueId, err: String(err).slice(0, 200),
            });
          }
        }

        const updated = updateCalendarIssueStatus(issueId, newStatus, notes);
        if (!updated) {
          return { error: 'not_found', message: `Issue "${issueId}" not found.` };
        }

        auditLog({
          action: 'manage_calendar_issue',
          source: 'calendar_health',
          actor: profile.user.name,
          details: { issueId, action, newStatus, notes, requestId },
          outcome: 'success',
        });

        const messageByAction: Record<string, string> = {
          approve:            'Issue acknowledged — won\'t be flagged again.',
          start_resolve:      requestId
            ? 'Request opened. Call move_meeting / coordinate_meeting as appropriate; cascade auto-resolves the row on event change.'
            : 'Marked for resolution. Call move_meeting / coordinate_meeting as appropriate.',
          owner_will_resolve: 'Marked owner_side — waiting on you to handle.',
          owner_done:         'Issue resolved.',
        };

        return {
          updated: true,
          issue_id: issueId,
          status: newStatus,
          request_id: requestId,
          message: messageByAction[action],
        };
      }

      default:
        return null;
    }
  }

  getSystemPromptSection(profile: UserProfile, scopes?: string[], isOwner?: boolean): string {
    // v3.x (Block 3 — prose lazy-load, "option 1"). The calendar-health TOOLS
    // (check_calendar_health / analyze_calendar / manage_calendar_issue) stay in
    // the 'meetings' scope so they ALWAYS ship on a scheduling turn — Sonnet can
    // always detect/use them when needed. Only this ~2.3k of PROSE is gated, on
    // the 'calendar' scope (review/health/free-time turns; the classifier picks
    // it, and freeTimeInquiry deterministically unions it). A misroute therefore
    // soft-degrades (tools present, less written guidance) rather than failing.
    // Undefined/general → render (colleague path, classifier off).
    if (scopes && !scopes.includes('calendar') && !scopes.includes('general')) return '';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
    const blocks = fb.getFloatingBlocks(profile);
    const blocksLine = blocks.length > 0
      ? blocks.map(b => `${b.name} ${b.preferred_start}–${b.preferred_end} ${b.duration_minutes}min`).join(' · ')
      : 'none configured';
    const mode = profile.behavior.calendar_health_mode ?? 'passive';
    const firstName = profile.user.name.split(' ')[0];
    return `
CALENDAR HEALTH SKILL
You can monitor and improve the owner's calendar hygiene.

Available tools:
- check_calendar_health: scan for issues. Mode = ${mode.toUpperCase()} (profile default; can be overridden with the \`mode\` arg)
  • passive: detects and returns the issue list — you narrate, owner asks for fixes, you execute
  • active: detects + EXECUTES the safe fixes in one pass (books missing floating blocks, tags uncategorized events with high-confidence category, DMs owner about busy days). Each issue comes back tagged \`fixed:true\` with a one-liner \`fix_detail\` describing what changed.
- book_floating_block: book a floating block in its preferred window. Pass \`block_name\` (one of: ${blocks.map(b => b.name).join(', ') || 'none configured'}). Configured blocks: ${blocksLine}. All floating blocks live under \`meetings.floating_blocks\`.
  POSITIONAL INTENT: when the owner says "before X" / "after X" for a floating block (X = a meeting on the same day), pass \`prefer_position: 'abut_before' | 'abut_after'\` + \`anchor_event_id\` (the event id from get_calendar). The handler computes \`anchor.start - buffer - duration\` (abut_before) or \`anchor.end + buffer\` (abut_after), snaps to a quarter-hour aligned slot, and verifies window + conflicts. Don't compute the time yourself and pass it through create_meeting — that bypasses the alignment + window-edge checks (the lunch window's preferred_end is exclusive, so e.g. starting AT 13:30 isn't a valid lunch slot). When the owner says "as late as possible" / "right before lunch ends", pass \`prefer_position: 'latest_in_window'\`.
- set_event_category: add Outlook categories to events
- get_calendar_issues: see all unresolved calendar issues (double bookings, OOF conflicts)
- update_calendar_issue: change the status of a tracked issue

Calendar issue workflow:
1. check_calendar_health detects issues; active mode auto-fixes the safe subset before returning
2. For ANY remaining issues (overlaps, OOF conflicts, busy days that need owner input), report to the owner with the issue ID
3. Owner responds:
   - "it's fine" / "I know" → call update_calendar_issue with status "approved"
   - "move X to Y" / "fix it" → call update_calendar_issue with "to_resolve" + their instructions, then use move_meeting to reschedule, then call update_calendar_issue with "resolved"
   - "cancel X" → use delete_meeting, then call update_calendar_issue with "resolved"
4. Approved/resolved issues won't be flagged again

NARRATING ACTIVE-MODE RESULTS — use \`summary_text\` verbatim (v2.7.4):
When check_calendar_health returns, the response carries a \`summary_text\` field that is a DETERMINISTIC per-issue summary built from \`fixed: true + fix_detail\` (successes) and \`fix_failed: true + fix_error\` (failures). USE THIS VERBATIM as the body of your reply — do NOT improvise from \`issues[]\` directly, do NOT skip fix_failed lines, do NOT add invented commentary about what got done.

Why: previously Sonnet narrated "I started moving X" when the move-coord actually failed silently (slot search returned zero). The summary_text is the only honest source for "what got done this turn" — fixed actions appear as ✓ lines, failed attempts as × lines, undetected/skipped as ! lines. Owner sees the truth.

Light polish only: you may strip the ✓/×/! prefix characters when posting to Slack, and may slightly rephrase awkward template strings into natural EA voice (humanGate runs after you anyway). But every CLAIM in your reply must trace back to a line in summary_text. If summary_text is "Calendar looks healthy — no issues found." then your reply is "Calendar looks good." or similar — nothing more.

WRONG: "Calendar looks good" when summary_text contains ✓ lines (erases the autonomous actions).
WRONG: "I started moving Michal's biweekly" when summary_text says "× Tried to fix ... but couldn't" — must narrate the failure honestly, not the wish.

Every fix fires a shadow DM automatically (via \`book_floating_block\` / \`set_event_category\` wrappers + v1_shadow_mode) — you don't need to DM separately.

PROTECTION RULES (v2.1.1 — deterministic, in code):
A meeting is PROTECTED from auto-reshuffle if ANY of:
  1. 4+ effective attendees (organizer + ≥3 non-declined invitees)
  2. Has any external attendee (email domain ≠ owner's company)
  3. Subject matches an entry in \`meetings.protected[].name\`
  4. Any category matches an entry in \`meetings.protected[].category\`
When the analyzer flags an overlap, it tells you which side is protected (\`kept_event_id\`) and which is movable (\`movable_event_id\`), plus \`protection_reasons\`. Use those fields when narrating. Active-mode DOES NOT auto-move overlaps in this release — that's v2.2 (needs the move-coord state machine). For now, report the overlap + the movable candidate + the protection reasons, and ask the owner to direct.

BUSY_DAY — narrate from the structured numbers, briefly:
When the analyzer flags a \`busy_day\` issue, it carries \`free_minutes\` (total free during work hours), \`longest_gap_minutes\` (the longest single uninterrupted block), and \`threshold_minutes\` (the owner's target). Surface ONE short line per day in HUMAN time — never "80 min" / "110 min": "Wed 14 May runs tight — just under 1.5h free, under your 2h office-day target." Don't enumerate the meetings on that day — owner can ask for detail if he wants it. If multiple days flag, bundle: "Wed 14, Thu 7, and Wed 13 are all under your 2h office-day target." Offer to look at moveable items only when owner asks. Active mode does NOT auto-resolve these — picking what to move is judgment-heavy.

CATEGORY_LIMIT_EXCEEDED — surface as informational, ask for direction:
When the analyzer flags a \`category_limit_exceeded\` issue, narrate it briefly with the named category, the rule (per_day or per_week), the count vs limit, and the day/week label. Active mode does NOT auto-resolve these — picking which interview / outside-meeting to bump is judgment-heavy and only ${firstName} can decide. Frame as a question: "Tuesday has 3 interviews, your limit is 2 — want me to move one, or keep all 3?". Include the affected event subjects (look them up via \`get_calendar\` if not already in context) so ${firstName} can pick. On owner decline ("keep them all" / "leave it"), call \`update_calendar_issue\` with the issue_id and status='approved' so tomorrow's check doesn't re-surface the same row.

OOF_CONFLICT WITH PROTECTION REASONS — frame as a question, not a status line.
When an \`oof_conflict\` issue carries \`protection_reasons\` (the meeting can't be auto-moved because it has externals, ≥4 attendees, etc.), present it to the owner as a QUESTION: "External meeting on Thursday during your vacation — want me to handle, or you'll fix it yourself?". Include the meeting subject + date + the protection reasons in plain words, and the issue_id. If the owner says "I'll fix it" / "no, leave it" / "I'll handle", call \`update_calendar_issue\` with that issue_id and status='approved' so tomorrow's check doesn't re-surface the same row. Don't dismiss without explicit owner intent — only on a clear "I'll handle / leave it / no" reply.

Rules:
- In passive mode: only book floating blocks when explicitly asked or after check_calendar_health reveals a gap
- In active mode: book / tag as described above. Never auto-resolve double bookings (even internal-only) in this release — that ships in v2.2.
- Never auto-resolve OOF conflicts — always ask the owner first.
- Categories are informational — suggest them but don't batch-apply without asking, UNLESS in active mode where the high-confidence classifier handles it.
- When reporting issues, include the issue_id so the owner's response can be tracked.

REPORTING ISSUES — say each thing once:
- Mention each conflict or issue ONCE, briefly. Do not reframe the same event pair under different framings ("there's an overlap" ... "more importantly" ... "the real issue is").
- If two events overlap, say it in one sentence with the times. Don't mix in adjacent meetings that aren't part of the conflict.
- No closing "the real issue" re-summary. The list IS the report.
- If the user has seen a conflict before and marked it approved, don't bring it up again.

TRUST THE ANALYZER (v1.6.4):
- analyze_calendar / check_calendar_health return a structured \`issues\` list per day. That list IS the truth about what's wrong.
- If a day's \`issues\` is empty, that day has NO issues. Do not invent one — don't say "lunch is effectively blocked" because the gap looked tight, don't say "back-to-back" because two meetings were close, don't say "no time for coffee" because nothing's scheduled. The analyzer already considers the buffer, the lunch window, the work hours, and free-time thresholds. If it didn't flag it, it isn't an issue.
- If you spot something in the raw events that you THINK is an issue but the analyzer didn't flag, ask the owner — don't assert: "I noticed Monday is pretty packed, want me to check if there's room for [X]?"
- Same for the events list: the analyzer already filtered personal events on non-working days. If a day returns empty, it IS empty for our purposes — don't pull personal events from get_calendar to fill the silence.

LEARNING ${firstName.toUpperCase()}'S CALENDAR STYLE (v3.3):
- When ${firstName} states a STANDING calendar preference — something to apply EVERY time, not a one-off for today — offer to remember it, and on his "yes" call \`update_my_preferences(skill='calendar', mode='add', text='<his preference, in his words>')\`.
  Examples: "on Sundays, if there's no lunch, don't add one" · "duplicate invites from the recruiting system — just delete them, don't ask" · "don't flag duplicates until end of next week, I know about them".
- A one-off instruction for TODAY's calendar is NOT a preference — just do it, don't save it.
- To EDIT or REMOVE a saved preference, call \`update_my_preferences(skill='calendar', mode='replace', text='<the full new list>')\`.
- His saved calendar preferences (if any) appear in the block below — already in force. Don't re-ask about something already listed there.${isOwner ? formatSkillPreferencesBlock(profile, 'calendar', { label: 'CALENDAR' }) : ''}
`;
  }
}
