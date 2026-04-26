import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import { DateTime } from 'luxon';
import {
  getCalendarEvents,
  type CalendarEvent,
  createMeeting,
  updateMeeting,
  findAvailableSlots,
} from '../connectors/graph/calendar';
import { auditLog, upsertCalendarIssue, getActiveCalendarIssues, updateCalendarIssueStatus, getDismissedIssueKeys, buildIssueKey, type CalendarIssueStatus } from '../db';
import logger from '../utils/logger';

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
    const client = new Anthropic();
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
    | 'missing_floating_block'   // v2.1.1 — generalized from 'missing_lunch'; owner-configured block didn't land on the calendar
    | 'missing_lunch'             // kept as alias for the lunch-specific block; same shape as missing_floating_block with block_name='lunch'
    | 'double_booking'
    | 'oof_conflict'
    | 'missing_category'
    | 'busy_day';                 // v2.1.1 — day exceeds busy thresholds (free-time / count / longest-free-block)
  date: string;
  description: string;
  eventIds?: string[];
  suggestion?: string;
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

  getTools(_profile: UserProfile): Anthropic.Tool[] {
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
- passive (default) → returns the issues for you to narrate. Owner asks for fixes; you execute them via book_lunch / set_event_category / etc. in follow-up calls.
- active → executes safe fixes in-tool before returning: missing floating blocks get booked, missing categories get set when the classifier is high-confidence, busy-day threshold breaches fire a DM to the owner. Overlap auto-resolve is NOT in this release (protected by design; use the owner's direction). Each issue in the returned list is tagged \`fixed: true\` with \`fix_detail\` when Maelle acted on it.

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
        name: 'book_lunch',
        description: `Book a lunch event on a specific day within the owner's preferred lunch window.
Finds the best available slot in the lunch window (preferred_start to preferred_end) and creates a calendar event.
Only book lunch when explicitly asked or when check_calendar_health reveals a missing lunch.

CATEGORIES: if the EVENT CATEGORIES block is present in your system prompt, pass the \`category\` arg with the name of the category that fits a lunch event (typically the one whose description mentions lunch / schedule admin / personal time). If no categories are defined, omit the arg and the event will be created uncategorized.`,
        input_schema: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Date YYYY-MM-DD to book lunch on',
            },
            category: {
              type: 'string',
              description: 'OPTIONAL. Name of the Outlook category to tag this lunch event with. Must match EXACTLY one of the owner\'s defined categories (see EVENT CATEGORIES in system prompt). Omit if no categories are defined or none fits.',
            },
          },
          required: ['date'],
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
        name: 'get_calendar_issues',
        description: `Get all active (unresolved) calendar issues — double bookings and OOF conflicts that haven't been approved or resolved yet.
Use this to check if there are outstanding calendar problems the owner needs to address.`,
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'update_calendar_issue',
        description: `Update the status of a tracked calendar issue.

Statuses:
- "approved" — owner is aware and says it's fine, stop flagging it
- "to_resolve" — owner wants it fixed; include their instructions in resolution_notes, then use move_meeting or coordinate_meeting to fix it
- "resolved" — the issue has been fixed (meeting moved, cancelled, etc.)

After setting "to_resolve": act on the owner's instructions (e.g. move a meeting), then call this again with "resolved".`,
        input_schema: {
          type: 'object',
          properties: {
            issue_id: { type: 'string', description: 'The calendar issue ID (from get_calendar_issues or check_calendar_health)' },
            status: { type: 'string', enum: ['approved', 'to_resolve', 'resolved'], description: 'New status' },
            resolution_notes: { type: 'string', description: 'What the owner said to do, or what was done to resolve it' },
          },
          required: ['issue_id', 'status'],
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

          // ── Missing floating blocks (v2.1.1 — generalized from missing_lunch) ──
          // Every block configured for the profile (lunch + any custom) is
          // checked independently. Only the ones that apply on this day-of-week
          // are in scope. A block is "missing" when no event on the calendar
          // matches it (subject regex OR category match, via the helper).
          for (const block of floatingBlocks) {
            if (!fb.blockAppliesOnDay(block, dayName, profile)) continue;
            const hasBlock = dayEvents.some(e => {
              if (e.isAllDay) return false;
              return fb.isFloatingBlockEvent(
                { subject: e.subject, categories: (e as unknown as { categories?: unknown }).categories },
                block,
              );
            });
            if (!hasBlock) {
              issues.push({
                type: block.name === 'lunch' ? 'missing_lunch' : 'missing_floating_block',
                date: dayStr,
                description: `No ${block.name.replace(/_/g, ' ')} on ${dayName} ${dayStr}`,
                suggestion: `Book a ${block.duration_minutes}-minute ${block.name.replace(/_/g, ' ')} between ${block.preferred_start} and ${block.preferred_end}`,
                block_name: block.name,
              });
            }
          }

          // ── Double bookings (v2.1.1 — tagged with internal_only + movable_event_id) ──
          const nonAllDay = dayEvents.filter(e =>
            !e.isAllDay && e.showAs !== 'free' && e.showAs !== 'workingElsewhere'
          );
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

                issues.push({
                  type: 'double_booking',
                  date: dayStr,
                  description: `"${a.subject}" (${aStart.toFormat('HH:mm')}-${aEnd.toFormat('HH:mm')}) overlaps with "${b.subject}" (${bStart.toFormat('HH:mm')}-${bEnd.toFormat('HH:mm')})`,
                  eventIds: [a.id, b.id],
                  suggestion: pick
                    ? `Propose moving "${pick.movable.subject}" — the less-protected side. The other meeting is protected (${(pick.movable === a ? bProt : aProt).reasons.join(', ')}).`
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
          const oofEvents = dayEvents.filter(e =>
            e.showAs === 'oof' || (e.isAllDay && (e.subject || '').toLowerCase().match(/vacation|oof|out of office|holiday|pto/))
          );
          if (oofEvents.length > 0) {
            const meetings = nonAllDay.filter(e =>
              e.showAs === 'busy' || e.showAs === 'tentative'
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

            const hoursStart = isOffice
              ? profile.schedule.office_days.hours_start
              : profile.schedule.home_days.hours_start;
            const hoursEnd = isOffice
              ? profile.schedule.office_days.hours_end
              : profile.schedule.home_days.hours_end;
            const [sh, sm] = hoursStart.split(':').map(Number);
            const [eh, em] = hoursEnd.split(':').map(Number);
            const workStartMin = sh * 60 + sm;
            const workEndMin = eh * 60 + em;
            const workTotalMin = workEndMin - workStartMin;

            // Compute free time in work hours
            const busyInWork = nonAllDay
              .filter(e => e.showAs !== 'workingElsewhere')
              .map(e => {
                const s = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
                const en = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
                const sMin = Math.max(s.hour * 60 + s.minute, workStartMin);
                const eMin = Math.min(en.hour * 60 + en.minute, workEndMin);
                return { start: sMin, end: eMin };
              })
              .filter(b => b.end > b.start)
              .sort((a, b) => a.start - b.start);
            const merged: Array<{ start: number; end: number }> = [];
            for (const b of busyInWork) {
              if (merged.length > 0 && b.start <= merged[merged.length - 1].end) {
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, b.end);
              } else {
                merged.push({ ...b });
              }
            }
            const totalBusy = merged.reduce((sum, m) => sum + (m.end - m.start), 0);
            const freeMin = Math.max(0, workTotalMin - totalBusy);

            // Longest continuous free gap (for thinking-time feasibility)
            let longestGap = 0;
            let prev = workStartMin;
            for (const m of merged) {
              longestGap = Math.max(longestGap, m.start - prev);
              prev = m.end;
            }
            longestGap = Math.max(longestGap, workEndMin - prev);

            const meetingCount = nonAllDay.length;
            const BUSY_COUNT_THRESHOLD = 6;
            const MIN_CONTINUOUS_GAP = 30;

            const reasons: string[] = [];
            if (freeMin < freeTimeThresholdMin) reasons.push(`only ${Math.round(freeMin / 60 * 10) / 10}h free (threshold ${freeTimeThresholdHours}h)`);
            if (meetingCount > BUSY_COUNT_THRESHOLD) reasons.push(`${meetingCount} meetings`);
            if (longestGap < MIN_CONTINUOUS_GAP) reasons.push(`no ${MIN_CONTINUOUS_GAP}-min unbroken block`);
            if (reasons.length > 0) {
              issues.push({
                type: 'busy_day',
                date: dayStr,
                description: `${dayName} ${dayStr} is rough — ${reasons.join(', ')}`,
                suggestion: 'Pick a lower-priority meeting to push.',
              });
            }
          }

          cursor = cursor.plus({ days: 1 });
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

        // v1.5.1 fix — filter out issues the owner has already approved / dismissed.
        // Previously `upsertCalendarIssue` skipped the DB insert for these but the
        // `issues` array still carried them through to the briefing, so the owner
        // got re-pinged about the same conflict every morning no matter how many
        // times they said "it's fine". Now we drop them from the returned list.
        const ownerUserId = profile.user.slack_user_id;
        const dismissedKeys = getDismissedIssueKeys(ownerUserId, startDate, endDate);
        if (dismissedKeys.size > 0) {
          const preCount = issues.length;
          const filtered = issues.filter(i => !dismissedKeys.has(buildIssueKey(i.type, i.description)));
          if (filtered.length !== preCount) {
            logger.info('Calendar health: suppressed already-approved issues', {
              suppressed: preCount - filtered.length,
              kept: filtered.length,
              ownerUserId,
            });
          }
          issues.length = 0;
          issues.push(...filtered);
        }

        // Auto-track actionable issues (double bookings + OOF conflicts) in DB
        let newIssueCount = 0;
        for (const issue of issues) {
          if (issue.type === 'double_booking' || issue.type === 'oof_conflict') {
            const created = upsertCalendarIssue(
              ownerUserId,
              issue.date,
              issue.type,
              issue.description,
              issue.eventIds,
            );
            if (created) newIssueCount++;
          }
        }

        // Include any active (unresolved) issues from previous checks
        const activeIssues = getActiveCalendarIssues(ownerUserId);

        // v2.1.1 — active-mode fix loop. Runs ONLY when mode='active'. Each
        // fix is deterministic or high-confidence; failures fail open (the
        // issue stays flagged, fix_failed=true). Fixes are limited in this
        // release to the safe set:
        //   - missing_floating_block / missing_lunch → book the block
        //   - missing_category → set category when classifier is high-conf
        //   - busy_day → DM the owner with candidates to move (no auto-move)
        // Overlap auto-move (even internal-only) is DEFERRED to v2.2 where
        // the coord state machine gains a "move" intent. Today it stays in
        // the report for the owner to direct.
        let fixesApplied = 0;
        if (mode === 'active') {
          logger.info('Calendar health: active mode — running fix loop', {
            ownerUserId, startDate, endDate, issueCount: issues.length,
          });
          for (const issue of issues) {
            try {
              if (issue.type === 'missing_lunch' || issue.type === 'missing_floating_block') {
                // Reuse the book_lunch handler path so alignment + buffer +
                // day-scope rules apply consistently. Call through the same
                // switch recursively — clean, shares code.
                const result = await this.executeToolCall(
                  'book_lunch',
                  { date: issue.date },
                  context,
                ) as { ok?: boolean; created?: boolean; start?: string; end?: string; error?: string; message?: string } | null;
                if (result?.ok && result.created) {
                  issue.fixed = true;
                  issue.fix_detail = `Booked ${issue.block_name ?? 'lunch'} ${issue.date} ${result.start}–${result.end}.`;
                  fixesApplied += 1;
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

                      const participantsRaw = (conflicting.attendees ?? []).filter(a => {
                        const status = a.status?.response;
                        return status !== 'declined' && status !== 'none';
                      });
                      const attendeeEmails = participantsRaw
                        .map(a => a.emailAddress.address)
                        .filter(Boolean);

                      const searchFrom = DateTime.fromISO(issue.date, { zone: timezone }).plus({ days: 1 }).startOf('day').toUTC().toISO()!;
                      let searchTo = DateTime.fromISO(issue.date, { zone: timezone }).plus({ days: 7 }).endOf('day').toUTC().toISO()!;
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
                        await stateMod.initiateCoordination({
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
                        issue.fixed = true;
                        issue.fix_detail = `Started a move-coord to reschedule "${conflicting.subject}" — Idan's on vacation ${issue.date}. DM'd ${coordParticipants.map(p => p.name).join(' and ')}.`;
                        fixesApplied += 1;
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
                //   (a) Movable side IS a floating block (lunch, coffee,
                //       thinking time, etc.) → DIRECT MOVE: no coord
                //       needed; a floating block is elastic by its own
                //       definition. Just updateMeeting to a new aligned
                //       slot within its window. Shadow DM fires naturally.
                //   (b) Movable side is a regular internal-only meeting
                //       with attendees → MOVE-COORD: DM the attendees,
                //       propose slots, moveMeeting on their agreement.
                //   (c) Protected (4+ / external / rule-matched) or
                //       external-attendee on either side → skip entirely,
                //       report to owner.
                try {
                  const movable = events.find(e => e.id === issue.movable_event_id);
                  const kept = events.find(e => e.id === issue.kept_event_id);
                  if (movable && kept) {
                    const matchedBlock = floatingBlocks.find(b =>
                      fb.isFloatingBlockEvent(
                        { subject: movable.subject, categories: (movable as unknown as { categories?: unknown }).categories },
                        b,
                      ) && fb.blockAppliesOnDay(b, DateTime.fromISO(issue.date, { zone: timezone }).toFormat('EEEE'), profile),
                    );
                    if (matchedBlock) {
                      // ── Path (a): floating-block direct move ──────────
                      const bufferMinutes = profile.meetings.buffer_minutes ?? 5;
                      // Busy-in-window = every other event in the block's
                      // window on this date, EXCLUDING the block event
                      // itself (we're moving it) AND including the kept
                      // event (whose slot the block must vacate).
                      const wStart = fb.windowMsForDay(issue.date, matchedBlock.preferred_start, timezone);
                      const wEnd = fb.windowMsForDay(issue.date, matchedBlock.preferred_end, timezone);
                      const busyInWindow = events
                        .filter(e => {
                          if (e.id === movable.id) return false;
                          if (e.isCancelled || e.isAllDay || e.showAs === 'free') return false;
                          if (fb.isFloatingBlockEvent(
                            { subject: e.subject, categories: (e as unknown as { categories?: unknown }).categories },
                            matchedBlock,
                          )) return false;  // other matching blocks don't block each other
                          const s = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone).toMillis();
                          const en = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone).toMillis();
                          return s < wEnd && en > wStart;
                        })
                        .map(e => ({
                          start: Math.max(parseGraphDt(e.start.dateTime, e.start.timeZone, timezone).toMillis(), wStart),
                          end: Math.min(parseGraphDt(e.end.dateTime, e.end.timeZone, timezone).toMillis(), wEnd),
                        }));
                      const newStartMs = fb.findAlignedSlotForBlock(
                        matchedBlock, issue.date, timezone, busyInWindow, bufferMinutes,
                      );
                      if (newStartMs === null) {
                        issue.fix_failed = true;
                        issue.fix_error = `No aligned slot left in the ${matchedBlock.name} window after accommodating "${kept.subject}".`;
                      } else {
                        const newStart = DateTime.fromMillis(newStartMs).setZone(timezone);
                        const newEnd = newStart.plus({ minutes: matchedBlock.duration_minutes });
                        await updateMeeting({
                          userEmail, meetingId: movable.id,
                          start: newStart.toISO()!,
                          end: newEnd.toISO()!,
                          timezone,
                        });
                        issue.fixed = true;
                        issue.fix_detail = `Moved ${matchedBlock.name} to ${newStart.toFormat('HH:mm')}–${newEnd.toFormat('HH:mm')} to make room for "${kept.subject}".`;
                        fixesApplied += 1;
                      }
                      // This overlap is handled; skip the coord path below.
                      continue;
                    }
                    // ── Path (b): regular move-coord (internal only) ──
                    if (issue.internal_only !== true) {
                      // Non-block + has external attendee somewhere → leave
                      // for owner. Protection rules already flagged this.
                      continue;
                    }
                    const mStart = parseGraphDt(movable.start.dateTime, movable.start.timeZone, timezone);
                    const mEnd = parseGraphDt(movable.end.dateTime, movable.end.timeZone, timezone);
                    const durationMin = Math.round(mEnd.diff(mStart, 'minutes').minutes);

                    // Find fresh slots to propose.
                    const participantsRaw = (movable.attendees ?? []).filter(a => {
                      const status = a.status?.response;
                      return status !== 'declined' && status !== 'none';
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
                    const slots = await findAvailableSlots({
                      userEmail,
                      timezone,
                      durationMinutes: durationMin,
                      attendeeEmails: [userEmail, ...attendeeEmails],
                      searchFrom,
                      searchTo,
                      profile,
                    });
                    // Pick up to 3 distinct candidate slots
                    const proposed = slots.slice(0, 3).map(s => ({
                      start: s.start,
                      location: 'Online' as string,
                      isOnline: true,
                    }));
                    if (proposed.length === 0) {
                      issue.fix_failed = true;
                      issue.fix_error = 'No alternate slot found — leaving for owner.';
                    } else {
                      // Build participants for the coord (movable meeting's
                      // attendees, excluding the owner)
                      const coordParticipants = participantsRaw
                        .filter(a => a.emailAddress.address.toLowerCase() !== profile.user.email.toLowerCase())
                        .map(a => ({
                          name: a.emailAddress.name || a.emailAddress.address,
                          email: a.emailAddress.address,
                          tz: profile.user.timezone,
                        }));
                      // eslint-disable-next-line @typescript-eslint/no-require-imports
                      const stateMod = require('./meetings/coord/state') as typeof import('./meetings/coord/state');
                      await stateMod.initiateCoordination({
                        ownerUserId,
                        ownerChannel: context.channelId,
                        ownerThreadTs: context.threadTs,
                        ownerName: profile.user.name,
                        ownerEmail: profile.user.email,
                        ownerTz: profile.user.timezone,
                        subject: movable.subject ?? 'Meeting',
                        durationMin,
                        participants: coordParticipants as Parameters<typeof stateMod.initiateCoordination>[0]['participants'],
                        proposedSlots: proposed as Parameters<typeof stateMod.initiateCoordination>[0]['proposedSlots'],
                        profile,
                        moveExistingEvent: {
                          id: movable.id,
                          currentStartIso: mStart.toISO()!,
                          currentEndIso: mEnd.toISO()!,
                          conflictReason: protection.sanitizeConflictReason(kept, profile.user.name.split(' ')[0]),
                        },
                      });
                      issue.fixed = true;
                      issue.fix_detail = `Started a move-coord: asking ${coordParticipants.map(p => p.name).join(' and ')} to shift "${movable.subject}" (currently ${mStart.toFormat('HH:mm')}–${mEnd.toFormat('HH:mm')}). Will book once they agree.`;
                      fixesApplied += 1;
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

          // Busy-day DM: one real DM to the owner with the busy days this
          // run found. Real DM (not shadow) because this needs the owner's
          // decision. De-dup via a task-row with (kind=busy_day_alert,
          // date-range) — if a previous run already alerted for this
          // range today, skip.
          const busyDays = issues.filter(i => i.type === 'busy_day');
          if (busyDays.length > 0) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { getConnection } = require('../connections/registry') as typeof import('../connections/registry');
              const conn = getConnection(ownerUserId, 'slack');
              if (conn) {
                const lines = busyDays.map(d => `• ${d.description}`).join('\n');
                const dmText = `Heads up — rough day${busyDays.length === 1 ? '' : 's'} ahead:\n${lines}\n\nWant me to suggest what to push?`;
                await conn.sendDirect(ownerUserId, dmText);
                logger.info('Calendar health active-mode: busy-day DM sent', {
                  ownerUserId, days: busyDays.map(d => d.date),
                });
              }
            } catch (err) {
              logger.warn('Busy-day DM failed — non-fatal', { err: String(err) });
            }
          }

          logger.info('Calendar health: active mode complete', {
            ownerUserId, fixesApplied, totalIssues: issues.length,
          });
        }

        return {
          issues,
          count: issues.length,
          mode,
          fixes_applied: fixesApplied,
          activeTrackedIssues: activeIssues.length > 0 ? activeIssues : undefined,
          summary: issues.length === 0
            ? 'Calendar looks healthy — no issues found.'
            : mode === 'active'
            ? `Scanned ${startDate} to ${endDate}: ${issues.length} issue${issues.length === 1 ? '' : 's'} found, ${fixesApplied} fixed automatically. Remaining need your input.`
            : `Found ${issues.length} issue${issues.length === 1 ? '' : 's'} across ${startDate} to ${endDate}.${newIssueCount > 0 ? ` ${newIssueCount} new issue(s) tracked for follow-up.` : ''}`,
        };
      }

      case 'book_lunch': {
        const date = args.date as string;
        // v2.1 — book_lunch generalized via floating_blocks. Still called
        // "book_lunch" (back-compat) but now delegates to the floating-
        // block helper. The "lunch" block is always present (auto-
        // promoted from schedule.lunch). Day-scope check too: if the
        // profile has declared lunch.days and the requested date isn't
        // in them, refuse the booking honestly.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
        const blocks = fb.getFloatingBlocks(profile);
        const block = blocks.find(b => b.name === 'lunch') ?? blocks[0];
        if (!block) {
          return { error: 'no_lunch_block', message: 'No lunch / floating block configured in profile.' };
        }
        const dayName = DateTime.fromISO(date, { zone: timezone }).toFormat('EEEE');
        if (!fb.blockAppliesOnDay(block, dayName, profile)) {
          return {
            error: 'not_applicable_today',
            message: `${block.name} isn't scheduled for ${dayName} in your profile (days: ${(block.days ?? ['every work day']).join(', ')}).`,
          };
        }

        // Get events for the day to find a free slot in the block window
        let events: CalendarEvent[];
        try {
          events = await getCalendarEvents(userEmail, date, date, timezone);
        } catch (err) {
          logger.error('book_lunch: failed to fetch events', { err });
          return { error: 'Failed to fetch calendar events.' };
        }

        const windowStart = DateTime.fromISO(`${date}T${block.preferred_start}`, { zone: timezone });
        const windowEnd = DateTime.fromISO(`${date}T${block.preferred_end}`, { zone: timezone });

        // Idempotency: if the block's event already exists in the window,
        // return created:false so the LLM narrates "already booked".
        const existingEvent = events.find(e => {
          if (e.isAllDay || e.isCancelled || e.showAs === 'free') return false;
          const matches = fb.isFloatingBlockEvent(
            { subject: e.subject, categories: (e as unknown as { categories?: unknown }).categories },
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
            message: `Lunch is already on the calendar on ${date} from ${eStart.toFormat('HH:mm')} to ${eEnd.toFormat('HH:mm')} — nothing to add.`,
          };
        }

        // Busy blocks in the window, EXCLUDING events that are this block
        // (we're about to book one; don't let a stale one self-block).
        const busyInWindow = events
          .filter(e => {
            if (e.isAllDay || e.isCancelled || e.showAs === 'free') return false;
            if (fb.isFloatingBlockEvent(
              { subject: e.subject, categories: (e as unknown as { categories?: unknown }).categories },
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

        const bufferMinutes = profile.meetings.buffer_minutes ?? 5;
        const bestStart = fb.findAlignedSlotForBlock(
          block, date, timezone, busyInWindow, bufferMinutes,
        );
        if (bestStart === null) {
          return {
            error: 'no_room',
            message: `No room for a ${block.duration_minutes}-minute ${block.name} between ${block.preferred_start} and ${block.preferred_end} on ${date}. The window is fully booked once quarter-hour alignment and the ${bufferMinutes}-min buffer are applied.`,
          };
        }

        const lunch = { duration_minutes: block.duration_minutes };  // preserve downstream naming
        const lunchStart = DateTime.fromMillis(bestStart).setZone(timezone);
        const lunchEnd = lunchStart.plus({ minutes: block.duration_minutes });

        // v1.7.8 — category is no longer hardcoded. Sonnet picks from
        // profile.categories (the owner's real Outlook categories, injected
        // into the system prompt) and passes the name here. Skip the field
        // entirely when no category was supplied.
        const categoryArg = (args.category as string | undefined)?.trim();
        const validCategoryNames = (profile.categories ?? []).map(c => c.name);
        // Defense: if Sonnet picked a name not in the profile, log + drop it
        // rather than silently inventing a category Outlook will create on-the-fly.
        let lunchCategories: string[] | undefined = undefined;
        if (categoryArg) {
          if (validCategoryNames.length === 0 || validCategoryNames.includes(categoryArg)) {
            lunchCategories = [categoryArg];
          } else {
            logger.warn('book_lunch: agent proposed category not in profile — dropping', {
              proposed: categoryArg,
              allowed: validCategoryNames,
            });
          }
        }

        try {
          const eventId = await createMeeting({
            subject: 'Lunch',
            start: lunchStart.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            end: lunchEnd.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            attendees: [],
            body: '<p>Lunch break — booked by your executive assistant.</p>',
            isOnline: false,
            categories: lunchCategories,
            // v2.1.7 — no sensitivity tag. Previous `sensitivity: 'personal'`
            // made Maelle re-label her own lunches as "private block" /
            // "personal event" in weekly reviews (her prompt rules skip or
            // generic-label personal events). Owner's stance: if something
            // is secret he marks it private; a lunch block doesn't need
            // hiding. Floating-block detection is subject-regex-based, so
            // this change doesn't affect isFloatingBlockEvent matching.
            userEmail,
            timezone,
          });

          return {
            ok: true,
            created: true,
            already_existed: false,
            event_id: eventId,
            subject: 'Lunch',
            start: lunchStart.toFormat('HH:mm'),
            end: lunchEnd.toFormat('HH:mm'),
            date,
            // Kept for back-compat with any caller reading `booked`.
            booked: true,
            message: `Lunch booked on ${date} from ${lunchStart.toFormat('HH:mm')} to ${lunchEnd.toFormat('HH:mm')}.`,
          };
        } catch (err) {
          logger.error('Calendar health: failed to book lunch', { err });
          return { error: `Failed to create lunch event: ${String(err)}` };
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

      case 'get_calendar_issues': {
        const activeIssues = getActiveCalendarIssues(profile.user.slack_user_id);
        return {
          issues: activeIssues,
          count: activeIssues.length,
          summary: activeIssues.length === 0
            ? 'No outstanding calendar issues.'
            : `${activeIssues.length} active issue(s) need attention.`,
        };
      }

      case 'update_calendar_issue': {
        const issueId = args.issue_id as string;
        const status = args.status as CalendarIssueStatus;
        const notes = args.resolution_notes as string | undefined;

        const updated = updateCalendarIssueStatus(issueId, status, notes);
        if (!updated) {
          return { error: `Issue "${issueId}" not found.` };
        }

        auditLog({
          action: 'update_calendar_issue',
          source: 'calendar_health',
          actor: profile.user.name,
          details: { issueId, status, notes },
          outcome: 'success',
        });

        // v1.6.0 — when marked `to_resolve`, spawn a calendar_fix task due in
        // 1 day so the issue actually gets re-checked instead of sitting with
        // a status string. If still present after 1 day → owner gets re-pinged.
        // If resolved → auto-close silently.
        if (status === 'to_resolve') {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { createTask } = require('../tasks') as typeof import('../tasks');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getCalendarIssueById } = require('../db/calendarIssues') as typeof import('../db/calendarIssues');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { DateTime } = require('luxon');
          const issue = getCalendarIssueById(issueId);
          const dueAt = DateTime.now().plus({ days: 1 }).toUTC().toISO()!;
          try {
            createTask({
              owner_user_id: profile.user.slack_user_id,
              owner_channel: context.channelId,
              owner_thread_ts: context.threadTs,
              type: 'calendar_fix',
              status: 'new',
              title: issue ? `Re-check calendar issue: ${issue.detail.slice(0, 60)}` : 'Re-check calendar issue',
              due_at: dueAt,
              skill_ref: issueId,
              context: JSON.stringify({ issue_id: issueId, notes }),
              who_requested: 'system',
              skill_origin: 'calendar_health',
            });
            logger.info('calendar_fix task scheduled', { issueId, dueAt });
          } catch (err) {
            logger.error('Failed to schedule calendar_fix task', { err: String(err), issueId });
          }
        }

        return {
          updated: true,
          issue_id: issueId,
          status,
          message: status === 'approved'
            ? 'Issue acknowledged — won\'t be flagged again.'
            : status === 'to_resolve'
            ? 'Issue marked for resolution. I\'ll re-check it in 1 day and re-ping you if it\'s still there.'
            : 'Issue resolved.',
        };
      }

      default:
        return null;
    }
  }

  getSystemPromptSection(profile: UserProfile): string {
    const lunch = profile.schedule.lunch;
    const mode = profile.behavior.calendar_health_mode ?? 'passive';
    return `
CALENDAR HEALTH SKILL
You can monitor and improve the owner's calendar hygiene.

Available tools:
- check_calendar_health: scan for issues. Mode = ${mode.toUpperCase()} (profile default; can be overridden with the \`mode\` arg)
  • passive: detects and returns the issue list — you narrate, owner asks for fixes, you execute
  • active: detects + EXECUTES the safe fixes in one pass (books missing floating blocks, tags uncategorized events with high-confidence category, DMs owner about busy days). Each issue comes back tagged \`fixed:true\` with a one-liner \`fix_detail\` describing what changed.
- book_lunch / book_floating_block helpers: book a floating block in its preferred window (lunch: ${lunch.preferred_start}–${lunch.preferred_end}, ${lunch.duration_minutes} min — other custom blocks live under \`schedule.floating_blocks\`)
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

NARRATING ACTIVE-MODE RESULTS:
When check_calendar_health is called in active mode, the response includes \`fixes_applied\` count and each auto-fixed issue carries \`fixed:true\` + \`fix_detail\`. Your reply MUST acknowledge what was done using those fix_detail strings. Example:
- RIGHT: "Booked lunch Thursday 12:00–12:25 and tagged two uncategorized meetings as Meeting. Still open: Wednesday has a conflict between Fulcrum and FC Capri — which do you want to move?"
- WRONG: "Calendar looks good" (erases the autonomous actions) or "I ran a check, no issues" (also wrong).
Every fix fires a shadow DM automatically (via \`book_lunch\` / \`set_event_category\` wrappers + v1_shadow_mode) — you don't need to DM separately.

PROTECTION RULES (v2.1.1 — deterministic, in code):
A meeting is PROTECTED from auto-reshuffle if ANY of:
  1. 4+ effective attendees (organizer + ≥3 non-declined invitees)
  2. Has any external attendee (email domain ≠ owner's company)
  3. Subject matches an entry in \`meetings.protected[].name\`
  4. Any category matches an entry in \`meetings.protected[].category\`
When the analyzer flags an overlap, it tells you which side is protected (\`kept_event_id\`) and which is movable (\`movable_event_id\`), plus \`protection_reasons\`. Use those fields when narrating. Active-mode DOES NOT auto-move overlaps in this release — that's v2.2 (needs the move-coord state machine). For now, report the overlap + the movable candidate + the protection reasons, and ask the owner to direct.

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
`;
  }
}
