import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from '../skills/types';
import type { UserProfile } from '../config/userProfile';
import { getDb } from '../db';
import { DateTime } from 'luxon';
import logger from '../utils/logger';

// Luxon weekday numbers: 1=Mon … 7=Sun
const WEEKDAY_MAP: Record<string, number> = {
  Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
  Friday: 5, Saturday: 6, Sunday: 7,
};

export interface Routine {
  id: string;
  created_at: string;
  updated_at: string;
  owner_user_id: string;
  owner_channel: string;
  title: string;
  prompt: string;
  schedule_type: 'daily' | 'weekdays' | 'weekly' | 'monthly';
  schedule_time: string;    // 'HH:MM' in user's timezone — or comma-separated "HH:MM,HH:MM" for twice-daily (v2.9.3)
  schedule_day: string | null; // day name for weekly; day-of-month string for monthly
  status: 'active' | 'paused';
  next_run_at: string | null;
  last_run_at: string | null;
  last_result: string | null;
  run_count: number;
  is_system: number;        // 1=system cron (briefing), 0=user-created
  never_stale: number;      // v1.5.1 — 1=always run even when late, 0=apply cadence-based skip thresholds
  notify_on_skip: number;   // Issue #59 — 1=DM owner when a firing is skipped, 0=silent (default)
}

/**
 * Parse a `schedule_time` string into one or more `{ hour, minute }` slots.
 *
 * v2.9.3 — multi-time support. The column accepts either a single "HH:MM"
 * (legacy) or a comma-separated list of times like "07:30,13:00". Used when
 * a single routine should fire multiple times per day — e.g. the
 * calendar-health routine running both at the morning brief AND mid-day
 * so Outlook-direct entries that don't trip the per-mutation rebalance
 * hook still get caught the same day.
 *
 * Invalid tokens are filtered out; the result is sorted ascending. Returns
 * an empty array only if the input has no valid times (caller falls back).
 */
export function parseScheduleTimes(scheduleTime: string): Array<{ h: number; m: number }> {
  const tokens = scheduleTime.split(',').map(t => t.trim()).filter(Boolean);
  const slots: Array<{ h: number; m: number }> = [];
  for (const tok of tokens) {
    const [hStr, mStr] = tok.split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    if (!Number.isFinite(h) || h < 0 || h > 23) continue;
    if (!Number.isFinite(m) || m < 0 || m > 59) continue;
    slots.push({ h, m });
  }
  slots.sort((a, b) => (a.h - b.h) || (a.m - b.m));
  return slots;
}

/**
 * Compute the next UTC ISO datetime at which a routine should run.
 *
 * v2.9.3 — multi-time aware. If `scheduleTime` carries multiple comma-
 * separated times ("07:30,13:00"), we compute the next firing for each
 * and return the earliest one. Single-time behavior is unchanged.
 */
export function computeNextRunAt(
  scheduleType: string,
  scheduleTime: string,
  scheduleDay: string | null,
  timezone: string,
  afterTime?: DateTime,
  workDays?: string[],
): string {
  const slots = parseScheduleTimes(scheduleTime);
  if (slots.length === 0) {
    // Fallback for malformed input: keep the legacy single-time path so
    // a bad write doesn't silently drop a routine.
    return computeNextRunAtForSlot(scheduleType, 0, 0, scheduleDay, timezone, afterTime, workDays);
  }

  let earliestMs = Infinity;
  let earliestIso = '';
  for (const slot of slots) {
    const iso = computeNextRunAtForSlot(scheduleType, slot.h, slot.m, scheduleDay, timezone, afterTime, workDays);
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms < earliestMs) {
      earliestMs = ms;
      earliestIso = iso;
    }
  }
  return earliestIso;
}

/**
 * Single-slot variant — the original computeNextRunAt body, with the
 * (h, m) lifted to parameters so the multi-slot wrapper can call it.
 */
function computeNextRunAtForSlot(
  scheduleType: string,
  h: number,
  m: number,
  scheduleDay: string | null,
  timezone: string,
  afterTime?: DateTime,
  workDays?: string[],
): string {
  const base = (afterTime ?? DateTime.now()).setZone(timezone);

  const snap = (dt: DateTime) =>
    dt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  const nextDay = (dt: DateTime) => snap(dt).plus({ days: 1 });

  const luxonDayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  let candidate = snap(base);

  switch (scheduleType) {
    case 'daily': {
      if (candidate <= base) candidate = nextDay(base);
      break;
    }
    case 'weekdays': {
      const days = workDays && workDays.length > 0
        ? workDays
        : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
      if (candidate <= base) candidate = nextDay(base);
      let guard = 0;
      while (!days.includes(luxonDayNames[candidate.weekday]) && guard++ < 7) {
        candidate = nextDay(candidate);
      }
      break;
    }
    case 'weekly': {
      const target = WEEKDAY_MAP[scheduleDay ?? 'Monday'] ?? 1;
      if (candidate <= base) candidate = nextDay(base);
      let guard = 0;
      while (candidate.weekday !== target && guard++ < 7) {
        candidate = nextDay(candidate);
      }
      break;
    }
    case 'monthly': {
      const targetDay = Math.max(1, parseInt(scheduleDay ?? '1', 10));
      candidate = snap(base).set({ day: targetDay });
      if (candidate <= base) {
        candidate = snap(base.plus({ months: 1 })).set({ day: targetDay });
      }
      break;
    }
  }

  return candidate.toUTC().toISO()!;
}

export function getProfileWorkDays(profile: UserProfile): string[] {
  const days = [
    ...profile.schedule.office_days.days,
    ...profile.schedule.home_days.days,
  ];
  return [...new Set(days)];
}

function formatSchedule(routine: Routine, tz: string, workDays?: string[]): string {
  // v2.9.3 — multi-time aware. "07:30,13:00" renders as "07:30 + 13:00".
  const slots = parseScheduleTimes(routine.schedule_time);
  const time = slots.length > 0
    ? slots
        .map(s => DateTime
          .fromObject({ hour: s.h, minute: s.m }, { zone: tz })
          .toFormat('HH:mm'))
        .join(' + ')
    : routine.schedule_time;

  switch (routine.schedule_type) {
    case 'daily':    return `Daily at ${time}`;
    case 'weekdays': {
      const label = workDays && workDays.length > 0
        ? workDays.map(d => d.slice(0, 3)).join('/')
        : 'Mon–Fri';
      return `Weekdays (${label}) at ${time}`;
    }
    case 'weekly':   return `Every ${routine.schedule_day} at ${time}`;
    case 'monthly': {
      const day = parseInt(routine.schedule_day ?? '1', 10);
      return `Monthly on the ${ordinal(day)} at ${time}`;
    }
    default: return `${routine.schedule_type} at ${time}`;
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

// ── System cron management ───────────────────────────────────────────────────

/**
 * Ensures the system briefing cron exists and is up to date.
 * Called at startup — idempotent.
 */
export function ensureBriefingCron(profile: UserProfile): void {
  const db = getDb();
  const ownerUserId = profile.user.slack_user_id;
  const cronId = `system_briefing_${ownerUserId}`;

  const existing = db.prepare('SELECT * FROM routines WHERE id = ?').get(cronId) as Routine | null;

  // Get briefing time from preferences or profile
  const { getBriefingHourMin, getBriefingWorkDays } = require('./briefs') as typeof import('./briefs');
  const [h, m] = getBriefingHourMin(profile);
  const scheduleTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const workDays = getProfileWorkDays(profile);

  if (existing) {
    // Update schedule if it changed
    if (existing.schedule_time !== scheduleTime) {
      const nextRunAt = computeNextRunAt('weekdays', scheduleTime, null, profile.user.timezone, undefined, workDays);
      db.prepare(`
        UPDATE routines SET schedule_time = ?, next_run_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(scheduleTime, nextRunAt, cronId);
      logger.info('Briefing cron schedule updated', { cronId, scheduleTime });
    }
    return;
  }

  // Create the system briefing cron
  const dmResult = db.prepare(`
    SELECT owner_channel FROM routines WHERE owner_user_id = ? LIMIT 1
  `).get(ownerUserId) as { owner_channel: string } | null;

  // We'll set owner_channel later when the DM channel is known (startup)
  const nextRunAt = computeNextRunAt('weekdays', scheduleTime, null, profile.user.timezone, undefined, workDays);

  db.prepare(`
    INSERT INTO routines (
      id, owner_user_id, owner_channel, title, prompt,
      schedule_type, schedule_time, schedule_day, status, next_run_at, run_count, is_system
    ) VALUES (
      @id, @owner_user_id, @owner_channel, @title, @prompt,
      @schedule_type, @schedule_time, @schedule_day, 'active', @next_run_at, 0, 1
    )
  `).run({
    id: cronId,
    owner_user_id: ownerUserId,
    owner_channel: dmResult?.owner_channel ?? '',
    title: 'Morning Briefing',
    prompt: '__system_briefing__',
    schedule_type: 'weekdays',
    schedule_time: scheduleTime,
    schedule_day: null,
    next_run_at: nextRunAt,
  });

  logger.info('Briefing cron created', { cronId, scheduleTime, nextRunAt });
}

/**
 * Updates the briefing cron's owner_channel — called at startup once we know the DM channel.
 */
export function updateBriefingCronChannel(ownerUserId: string, channelId: string): void {
  const db = getDb();
  const cronId = `system_briefing_${ownerUserId}`;
  db.prepare(`UPDATE routines SET owner_channel = ? WHERE id = ?`).run(channelId, cronId);
}

// ─────────────────────────────────────────────────────────────────────────────

export class CronsSkill implements Skill {
  id = 'routines' as const;
  name = 'Routines';
  description = 'Creates and manages recurring routines — instructions that run automatically on a schedule';

  getTools(profile: UserProfile): Anthropic.Tool[] {
    const workDays = getProfileWorkDays(profile);
    const workDaysStr = workDays.join(', ');

    return [
      {
        // v2.9 — merged create_routine + update_routine + delete_routine + get_routines.
        name: 'manage_routine',
        description: `Recurring routines — instructions that run automatically on a schedule. One tool, four actions.

action='create' — set up a new routine. Required: title, prompt, schedule_type, schedule_time.
  Examples: "Every work day at 8:30am, check my calendar for conflicts" · "Every Sunday, make sure I have a lunch block this week" · "Daily at 9am, alert me if I have back-to-back meetings".
  Routines run autonomously and report results to the owner's DM. They have full access to all active skills.
  IMPORTANT: before creating, call manage_routine(action='list') to check if a similar one already exists — prefer 'update' over duplicate.

action='update' — modify a routine's title, prompt, schedule, status (pause/resume), or flags. Required: routine_id. Pass only the fields you want to change.

action='delete' — permanently delete a routine. Required: routine_id. Use when asked to "remove", "delete", or "stop" a recurring task.

action='list' — list all routines (active and paused). Call when asked "what routines do you have?", "show my recurring tasks", "what runs automatically?".`,
        input_schema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string',
              enum: ['create', 'update', 'delete', 'list'],
              description: 'create, update, delete, or list.',
            },
            routine_id: {
              type: 'string',
              description: 'update/delete: REQUIRED, id of the routine. create/list: ignored.',
            },
            title: {
              type: 'string',
              description: 'create: REQUIRED. Short name, e.g. "Daily calendar check". update: optional.',
            },
            prompt: {
              type: 'string',
              description: 'create: REQUIRED. The full instruction to execute each time. update: optional.',
            },
            schedule_type: {
              type: 'string',
              enum: ['daily', 'weekdays', 'weekly', 'monthly'],
              description: `create: REQUIRED. daily (every day), weekdays (${workDaysStr}), weekly (once a week), monthly (once a month). update: optional.`,
            },
            schedule_time: {
              type: 'string',
              description: 'create: REQUIRED. Time to run in 24h HH:MM in the user\'s local timezone, e.g. "08:30". Multi-time supported: pass comma-separated values to fire the same routine more than once a day, e.g. "07:30,13:00" runs it both at 07:30 and at 13:00. update: optional.',
            },
            schedule_day: {
              type: 'string',
              description: 'REQUIRED for weekly (day name, e.g. "Sunday") and monthly (day of month, e.g. "1"). Omit for daily/weekdays.',
            },
            status: {
              type: 'string',
              enum: ['active', 'paused'],
              description: 'update only: pause or resume the routine.',
            },
            never_stale: {
              type: 'boolean',
              description: 'If true, runs at the next opportunity no matter how late — bypasses the normal skip thresholds. Use for critical routines. Default false.',
            },
            notify_on_skip: {
              type: 'boolean',
              description: 'If true, DM the owner when a scheduled firing is skipped. Default false.',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { profile, channelId } = context;
    const db = getDb();
    const ownerUserId = profile.user.slack_user_id;

    // v2.9 — merged tool. Dispatch on args.action so the four old cases keep
    // their original logic with minimal churn.
    if (toolName === 'manage_routine') {
      const action = String(args.action ?? '').toLowerCase();
      if (action === 'create')      toolName = 'create_routine';
      else if (action === 'update') toolName = 'update_routine';
      else if (action === 'delete') toolName = 'delete_routine';
      else if (action === 'list')   toolName = 'get_routines';
      else return { error: 'bad_action', message: `manage_routine action must be one of 'create' | 'update' | 'delete' | 'list', got "${action}".` };
    }

    switch (toolName) {

      case 'create_routine': {
        const scheduleType = args.schedule_type as string;
        const scheduleTime = args.schedule_time as string;
        const scheduleDay = (args.schedule_day as string | undefined) ?? null;
        const title = (args.title as string | undefined) ?? '';

        if (scheduleType === 'weekly' && !scheduleDay) {
          return { error: 'schedule_day is required for weekly routines (e.g. "Monday")' };
        }
        if (scheduleType === 'monthly' && !scheduleDay) {
          return { error: 'schedule_day is required for monthly routines (e.g. "1" for the 1st of the month)' };
        }

        // v1.6.10 — morning briefing is a core SYSTEM routine managed by
        // ensureBriefingCron (`system_briefing_<ownerId>`). Don't let the LLM
        // create a second briefing routine — that created silent duplicates
        // (e.g. one 08:00 user-made briefing + one 09:00 system briefing
        // coexisting, both firing every morning). If the owner wants a
        // different briefing time, they'll change the profile — not add a
        // duplicate routine.
        const looksLikeBriefing = /\b(morning|daily)?\s*brief(ing)?\b/i.test(title);
        if (looksLikeBriefing) {
          return {
            error: 'briefing_is_core',
            message: `Morning briefing is a built-in routine — it runs automatically every working day. You don't need to create a routine for it. If the owner wants to change the briefing time, update their profile's briefing time. If they want a SECOND, different briefing (e.g. an afternoon recap), pick a different title — don't call it "briefing".`,
          };
        }

        const id = `routine_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const nextRunAt = computeNextRunAt(scheduleType, scheduleTime, scheduleDay, profile.user.timezone, undefined, getProfileWorkDays(profile));

        const neverStale = args.never_stale === true ? 1 : 0;
        const notifyOnSkip = args.notify_on_skip === true ? 1 : 0;
        db.prepare(`
          INSERT INTO routines (
            id, owner_user_id, owner_channel, title, prompt,
            schedule_type, schedule_time, schedule_day, status, next_run_at, run_count, is_system, never_stale, notify_on_skip
          ) VALUES (
            @id, @owner_user_id, @owner_channel, @title, @prompt,
            @schedule_type, @schedule_time, @schedule_day, 'active', @next_run_at, 0, 0, @never_stale, @notify_on_skip
          )
        `).run({
          id,
          owner_user_id: ownerUserId,
          owner_channel: channelId,
          title: args.title as string,
          prompt: args.prompt as string,
          schedule_type: scheduleType,
          schedule_time: scheduleTime,
          schedule_day: scheduleDay,
          next_run_at: nextRunAt,
          never_stale: neverStale,
          notify_on_skip: notifyOnSkip,
        });

        const nextDt = DateTime.fromISO(nextRunAt).setZone(profile.user.timezone);
        const nextFormatted = nextDt.toFormat('EEEE, d MMMM') + ' at ' + nextDt.toFormat('HH:mm');

        logger.info('Routine created', { id, title: args.title, scheduleType, nextRunAt });
        return { created: true, routine_id: id, title: args.title, first_run: nextFormatted };
      }

      case 'get_routines': {
        const routines = db.prepare(`
          SELECT * FROM routines
          WHERE owner_user_id = ? AND status != 'deleted'
          ORDER BY is_system ASC, created_at ASC
        `).all(ownerUserId) as Routine[];

        if (routines.length === 0) {
          return { routines: [], formatted: 'No routines set up yet.', count: 0 };
        }

        const profileWorkDays = getProfileWorkDays(profile);
        const formatted = routines.map(r => {
          const schedStr = formatSchedule(r, profile.user.timezone, profileWorkDays);
          const paused   = r.status === 'paused' ? ' *(paused)*' : '';
          const builtIn  = r.is_system === 1 ? ' *(built-in)*' : '';
          const lastRun  = r.last_run_at
            ? `Last ran ${DateTime.fromISO(r.last_run_at).setZone(profile.user.timezone).toFormat('EEE d MMM')}. `
            : 'Never run yet. ';
          const nextRun  = r.next_run_at
            ? DateTime.fromISO(r.next_run_at).setZone(profile.user.timezone).toFormat('EEE d MMM HH:mm')
            : 'unscheduled';
          return `• [${r.id}] *${r.title}*${paused}${builtIn}\n  ${schedStr} — ${lastRun}Next: ${nextRun}`;
        }).join('\n');

        return { routines, formatted, count: routines.length };
      }

      case 'update_routine': {
        // v2.5.1 — routine management is a normal assistant capability.
        // Owner asks to change a routine's time / pause it / un-pause it
        // / delete it the same way they'd ask a human EA. Schedule + status
        // + notify_on_skip are mutable on EVERY routine, including system.
        // Title + prompt stay locked on system routines because the
        // dispatcher pivots on `prompt === '__system_briefing__'` — changing
        // those would break the special briefing rendering path. When the
        // briefing's schedule_time changes, we ALSO write the briefing_time
        // preference so the value persists across restarts (ensureBriefingCron
        // reads it at startup).
        const routine = db.prepare(
          'SELECT * FROM routines WHERE id = ? AND owner_user_id = ?'
        ).get(args.routine_id as string, ownerUserId) as Routine | null;

        if (!routine) return { error: 'Routine not found' };

        if (routine.is_system === 1 && (args.title != null || args.prompt != null)) {
          return { error: 'system_routine_identity_locked', field: args.title != null ? 'title' : 'prompt' };
        }

        const updates: Record<string, unknown> = {};
        if (args.title  != null) updates.title  = args.title;
        if (args.prompt != null) updates.prompt = args.prompt;
        if (args.status != null) updates.status = args.status;
        if (args.never_stale != null) updates.never_stale = args.never_stale ? 1 : 0;
        if (args.notify_on_skip != null) updates.notify_on_skip = args.notify_on_skip ? 1 : 0;

        const newType = (args.schedule_type as string | undefined) ?? routine.schedule_type;
        const newTime = (args.schedule_time as string | undefined) ?? routine.schedule_time;
        const newDay  = (args.schedule_day  as string | undefined) ?? routine.schedule_day;

        const scheduleChanged = args.schedule_type != null || args.schedule_time != null || args.schedule_day != null;
        const reactivating    = args.status === 'active' && routine.status === 'paused';

        if (scheduleChanged || reactivating) {
          updates.schedule_type = newType;
          updates.schedule_time = newTime;
          updates.schedule_day  = newDay ?? null;
          updates.next_run_at   = computeNextRunAt(newType, newTime, newDay ?? null, profile.user.timezone, undefined, getProfileWorkDays(profile));
        }

        const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
        if (!fields) return { updated: false, message: 'Nothing to update' };

        db.prepare(
          `UPDATE routines SET ${fields}, updated_at = datetime('now') WHERE id = @routine_id`
        ).run({ ...updates, routine_id: args.routine_id as string });

        // v2.5.1 — persist briefing time across restarts. ensureBriefingCron
        // reads `briefing_time` pref at startup; without this write, a live
        // schedule_time edit on the system briefing would reset on next
        // restart back to whatever the pref / profile default holds.
        if (routine.is_system === 1 && routine.id.startsWith('system_briefing_') && args.schedule_time != null) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { savePreference } = require('../db/preferences') as typeof import('../db/preferences');
          savePreference({
            userId: ownerUserId,
            category: 'general',
            key: 'briefing_time',
            value: args.schedule_time as string,
            source: 'user_taught',
          });
          logger.info('Briefing schedule_time persisted to preference', {
            ownerUserId, value: args.schedule_time,
          });
        }

        logger.info('Routine updated', { id: args.routine_id, updates: Object.keys(updates), is_system: routine.is_system });
        return { updated: true, routine_id: args.routine_id };
      }

      case 'delete_routine': {
        // v2.5.1 — system routines deletable too. Soft-delete (status='deleted')
        // means ensureBriefingCron at next startup sees the row and won't
        // recreate it — owner's stop-this intent persists.
        const routine = db.prepare(
          'SELECT * FROM routines WHERE id = ? AND owner_user_id = ?'
        ).get(args.routine_id as string, ownerUserId) as Routine | null;

        if (!routine) return { error: 'Routine not found' };

        db.prepare(
          `UPDATE routines SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`
        ).run(args.routine_id as string);

        logger.info('Routine deleted', { id: args.routine_id, title: routine.title, is_system: routine.is_system });
        return { deleted: true, title: routine.title };
      }

      default:
        return null;
    }
  }

  getSystemPromptSection(profile: UserProfile): string {
    const workDays = getProfileWorkDays(profile);
    const workDaysStr = workDays.join(', ');

    return `## ROUTINES

You can set up recurring routines — instructions that run automatically on a schedule and report results to your DM. Routines have full access to all active skills.

Good uses:
- Daily calendar hygiene ("Every work day at 8:30am, check today's calendar for back-to-backs, missing lunch, or conflicts")
- Weekly prep ("Every Sunday at 9am, look at the week ahead and flag anything that needs attention")
- Proactive scheduling ("Every Sunday, check if I have a lunch block — if not, suggest a free 45 min slot")
- Periodic summaries ("Every Thursday at 4pm, summarise open tasks and outstanding coordinations")
- Regular outreach ("First Sunday of each month, DM the team a reminder about 1:1 notes")

SCHEDULE RULES:
- "weekdays" means the user's configured work days: ${workDaysStr} — NOT Mon–Fri unless that matches
- Before creating a routine, ALWAYS call \`manage_routine(action='list')\` first to check for duplicates. If a similar one exists, update it instead.
- Add \`notify_on_skip: true\` to flag a routine as important — I'll DM you if a firing is skipped.

META QUESTIONS — when the owner asks ABOUT a routine ("when does the calendar check run?", "what time is my morning brief?", "how often does X fire?"), use \`manage_routine(action='list')\` to look up the schedule and answer from there. DO NOT call the routine's underlying tool (\`check_calendar_health\`, \`send_briefing_now\`, etc.) just to "see what it would say" — that runs the actual side-effects (auto-fixes, brief sent) and answers the wrong question. The owner asked about the schedule, not for output.

When creating a routine, write the prompt as a complete, self-contained instruction.

Schedules: daily | weekdays (${workDaysStr}) | weekly (specify day) | monthly (specify day-of-month)

Tool: \`manage_routine\` — one tool, four actions (create / update / delete / list).`;
  }
}
