import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import { DateTime } from 'luxon';
import {
  getCalendarEvents,
  type CalendarEvent,
  createMeeting,
  updateMeeting,
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

interface HealthIssue {
  type: 'missing_lunch' | 'double_booking' | 'oof_conflict' | 'missing_category';
  date: string;
  description: string;
  eventIds?: string[];
  suggestion?: string;
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
- Missing lunch: work days with no lunch event in the preferred lunch window
- Double bookings: overlapping non-all-day events
- OOF conflicts: meetings scheduled on days with an OOF/vacation event
- Missing categories: events without Outlook categories

Returns a list of issues with suggestions. Use this proactively when the owner asks about their schedule, or when they ask you to check calendar health.`,
        input_schema: {
          type: 'object',
          properties: {
            start_date: {
              type: 'string',
              description: 'Start date YYYY-MM-DD. Defaults to today.',
            },
            end_date: {
              type: 'string',
              description: 'End date YYYY-MM-DD. Defaults to end of current week.',
            },
          },
          required: [],
        },
      },
      {
        name: 'book_lunch',
        description: `Book a lunch event on a specific day within the owner's preferred lunch window.
Finds the best available slot in the lunch window (preferred_start to preferred_end) and creates a calendar event.
Only book lunch when explicitly asked or when check_calendar_health reveals a missing lunch.`,
        input_schema: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Date YYYY-MM-DD to book lunch on',
            },
          },
          required: ['date'],
        },
      },
      {
        name: 'set_event_category',
        description: `Add or update the Outlook category on a calendar event. Categories help with calendar organization and analytics.
Common categories: "Meeting", "Internal", "External", "Interview", "Lunch", "Logistic", "Focus Time".`,
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
        const clockNow = DateTime.now().setZone(timezone);
        // Late-night adjustment: before 5am the user is still in "yesterday"
        const now = clockNow.hour < 5 ? clockNow.minus({ days: 1 }).startOf('day') : clockNow;
        const startDate = (args.start_date as string) ?? now.toFormat('yyyy-MM-dd');
        const endDate = (args.end_date as string) ?? now.endOf('week').toFormat('yyyy-MM-dd');

        let events: CalendarEvent[];
        try {
          events = await getCalendarEvents(userEmail, startDate, endDate, timezone);
        } catch (err) {
          logger.error('Calendar health: failed to fetch events', { err });
          return { error: 'Failed to fetch calendar events.' };
        }

        const issues: HealthIssue[] = [];
        const lunch = profile.schedule.lunch;
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

          // ── Missing lunch ──────────────────────────────────────────────────
          const lunchStart = DateTime.fromISO(`${dayStr}T${lunch.preferred_start}`, { zone: timezone });
          const lunchEnd = DateTime.fromISO(`${dayStr}T${lunch.preferred_end}`, { zone: timezone });

          const hasLunch = dayEvents.some(e => {
            if (e.isAllDay) return false;
            const subj = (e.subject || '').toLowerCase();
            return subj.includes('lunch') || subj.includes('ארוחת');
          });

          if (!hasLunch) {
            issues.push({
              type: 'missing_lunch',
              date: dayStr,
              description: `No lunch event on ${dayName} ${dayStr}`,
              suggestion: `Book a ${lunch.duration_minutes}-minute lunch between ${lunch.preferred_start} and ${lunch.preferred_end}`,
            });
          }

          // ── Double bookings ────────────────────────────────────────────────
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
                issues.push({
                  type: 'double_booking',
                  date: dayStr,
                  description: `"${a.subject}" (${aStart.toFormat('HH:mm')}-${aEnd.toFormat('HH:mm')}) overlaps with "${b.subject}" (${bStart.toFormat('HH:mm')}-${bEnd.toFormat('HH:mm')})`,
                  eventIds: [a.id, b.id],
                  suggestion: 'Review and resolve the overlap — reschedule or decline one of them',
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
                suggestion: 'Add a category (Meeting, Internal, External, Interview, Lunch, Logistic, Focus Time)',
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

        return {
          issues,
          count: issues.length,
          activeTrackedIssues: activeIssues.length > 0 ? activeIssues : undefined,
          summary: issues.length === 0
            ? 'Calendar looks healthy — no issues found.'
            : `Found ${issues.length} issue${issues.length === 1 ? '' : 's'} across ${startDate} to ${endDate}.${newIssueCount > 0 ? ` ${newIssueCount} new issue(s) tracked for follow-up.` : ''}`,
        };
      }

      case 'book_lunch': {
        const date = args.date as string;
        const lunch = profile.schedule.lunch;

        // Get events for the day to find a free slot in the lunch window
        let events: CalendarEvent[];
        try {
          events = await getCalendarEvents(userEmail, date, date, timezone);
        } catch (err) {
          logger.error('Calendar health: failed to fetch events for lunch booking', { err });
          return { error: 'Failed to fetch calendar events.' };
        }

        const lunchWindowStart = DateTime.fromISO(`${date}T${lunch.preferred_start}`, { zone: timezone });
        const lunchWindowEnd = DateTime.fromISO(`${date}T${lunch.preferred_end}`, { zone: timezone });
        const lunchDurationMs = lunch.duration_minutes * 60 * 1000;

        // v1.6.4 — check whether a lunch event already exists in (or touching)
        // the lunch window, so we don't double-book AND the LLM can narrate
        // correctly via the created:false signal. A "lunch event" is any
        // event whose subject matches /lunch/i or is categorized 'Lunch'.
        const existingLunch = events.find(e => {
          if (e.isAllDay || e.isCancelled || e.showAs === 'free') return false;
          const subject = String(e.subject ?? '').toLowerCase();
          const categories: string[] = Array.isArray((e as any).categories) ? (e as any).categories : [];
          const looksLikeLunch = /\blunch\b|ארוחת\s*צהריים/i.test(subject) || categories.includes('Lunch');
          if (!looksLikeLunch) return false;
          const eStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
          const eEnd = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
          return eStart.toMillis() < lunchWindowEnd.toMillis() && eEnd.toMillis() > lunchWindowStart.toMillis();
        });
        if (existingLunch) {
          const eStart = parseGraphDt(existingLunch.start.dateTime, existingLunch.start.timeZone, timezone);
          const eEnd = parseGraphDt(existingLunch.end.dateTime, existingLunch.end.timeZone, timezone);
          return {
            ok: true,
            created: false,
            already_existed: true,
            event_id: existingLunch.id,
            subject: existingLunch.subject,
            start: eStart.toFormat('HH:mm'),
            end: eEnd.toFormat('HH:mm'),
            date,
            message: `Lunch is already on the calendar on ${date} from ${eStart.toFormat('HH:mm')} to ${eEnd.toFormat('HH:mm')} — nothing to add.`,
          };
        }

        // Get busy blocks within the lunch window
        const busyInWindow = events
          .filter(e => {
            if (e.isAllDay || e.isCancelled || e.showAs === 'free') return false;
            const eStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
            const eEnd = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
            return eStart.toMillis() < lunchWindowEnd.toMillis() && eEnd.toMillis() > lunchWindowStart.toMillis();
          })
          .map(e => ({
            start: Math.max(parseGraphDt(e.start.dateTime, e.start.timeZone, timezone).toMillis(), lunchWindowStart.toMillis()),
            end: Math.min(parseGraphDt(e.end.dateTime, e.end.timeZone, timezone).toMillis(), lunchWindowEnd.toMillis()),
          }))
          .sort((a, b) => a.start - b.start);

        // Merge overlapping
        const merged: Array<{ start: number; end: number }> = [];
        for (const block of busyInWindow) {
          if (merged.length > 0 && block.start <= merged[merged.length - 1].end) {
            merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, block.end);
          } else {
            merged.push({ ...block });
          }
        }

        // Find first free block >= lunch duration
        let bestStart: number | null = null;
        let prev = lunchWindowStart.toMillis();
        for (const block of merged) {
          if (block.start - prev >= lunchDurationMs) {
            bestStart = prev;
            break;
          }
          prev = block.end;
        }
        if (bestStart === null && lunchWindowEnd.toMillis() - prev >= lunchDurationMs) {
          bestStart = prev;
        }

        if (bestStart === null) {
          return {
            error: 'no_room',
            message: `No room for a ${lunch.duration_minutes}-minute lunch between ${lunch.preferred_start} and ${lunch.preferred_end} on ${date}. The window is fully booked.`,
          };
        }

        const lunchStart = DateTime.fromMillis(bestStart).setZone(timezone);
        const lunchEnd = lunchStart.plus({ minutes: lunch.duration_minutes });

        try {
          const eventId = await createMeeting({
            subject: 'Lunch',
            start: lunchStart.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            end: lunchEnd.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            attendees: [],
            body: '<p>Lunch break — booked by your executive assistant.</p>',
            isOnline: false,
            categories: ['Lunch'],
            sensitivity: 'personal',
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
    return `
CALENDAR HEALTH SKILL
You can monitor and improve the owner's calendar hygiene.

Available tools:
- check_calendar_health: scan for issues (missing lunch, double bookings, OOF conflicts, missing categories)
- book_lunch: book a lunch event in the preferred window (${lunch.preferred_start}–${lunch.preferred_end}, ${lunch.duration_minutes} min)
- set_event_category: add Outlook categories to events
- get_calendar_issues: see all unresolved calendar issues (double bookings, OOF conflicts)
- update_calendar_issue: change the status of a tracked issue

Calendar issue workflow:
1. check_calendar_health auto-tracks double bookings and OOF conflicts in the database
2. Report them to the owner with the issue ID
3. Owner responds:
   - "it's fine" / "I know" → call update_calendar_issue with status "approved"
   - "move X to Y" / "fix it" → call update_calendar_issue with "to_resolve" + their instructions, then use move_meeting to reschedule, then call update_calendar_issue with "resolved"
   - "cancel X" → use delete_meeting, then call update_calendar_issue with "resolved"
4. Approved/resolved issues won't be flagged again

Rules:
- Only book lunch when explicitly asked or after check_calendar_health reveals a gap
- Never auto-resolve double bookings or OOF conflicts — always ask the owner first
- Categories are informational — suggest them but don't batch-apply without asking
- When reporting issues, include the issue_id so the owner's response can be tracked

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
