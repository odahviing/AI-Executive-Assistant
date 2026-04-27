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
  schedule_time: string;    // 'HH:MM' in user's timezone
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
 * Compute the next UTC ISO datetime at which a routine should run.
 */
export function computeNextRunAt(
  scheduleType: string,
  scheduleTime: string,
  scheduleDay: string | null,
  timezone: string,
  afterTime?: DateTime,
  workDays?: string[],
): string {
  const [hStr, mStr] = scheduleTime.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
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
  const [hStr, mStr] = routine.schedule_time.split(':');
  const time = DateTime
    .fromObject({ hour: parseInt(hStr), minute: parseInt(mStr) }, { zone: tz })
    .toFormat('HH:mm');

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
        name: 'create_routine',
        description: `Create a recurring routine — an instruction that runs automatically on a schedule.

Use when asked to set up anything recurring, e.g.:
- "Every work day at 8:30am, check my calendar for conflicts"
- "Every Sunday, make sure I have a lunch block this week"
- "Every Thursday at 4pm, remind me to send a weekly status update"
- "Daily at 9am, alert me if I have back-to-back meetings"

Routines run autonomously in the background and report results to your DM.
They have full access to all active skills — calendar, tasks, coordination, etc.

IMPORTANT: Before creating a routine, ALWAYS call get_routines first to check if a similar one already exists. If a matching routine exists, offer to update it instead of creating a duplicate.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            title: {
              type: 'string',
              description: 'Short name, e.g. "Daily calendar check" or "Weekly lunch guard"',
            },
            prompt: {
              type: 'string',
              description: 'The full instruction to execute each time. Write it as if giving Maelle a task right now.',
            },
            schedule_type: {
              type: 'string',
              enum: ['daily', 'weekdays', 'weekly', 'monthly'],
              description: `How often to run: daily (every day), weekdays (${workDaysStr}), weekly (once a week on a specific day), monthly (once a month on a specific day)`,
            },
            schedule_time: {
              type: 'string',
              description: 'Time to run in 24h HH:MM format, in the user\'s local timezone. e.g. "08:30"',
            },
            schedule_day: {
              type: 'string',
              description: 'Required for weekly (day name, e.g. "Sunday") and monthly (day of month as string, e.g. "1"). Omit for daily/weekdays.',
            },
            never_stale: {
              type: 'boolean',
              description: 'If true, this routine must run at the next opportunity no matter how late — the normal cadence-based skip thresholds (4h for daily, 24h for every-few-days, 48h for weekly, 1 week for monthly) do not apply. Use for critical things the owner explicitly wants run even when delayed. Default false.',
            },
            notify_on_skip: {
              type: 'boolean',
              description: 'If true, send a DM when a scheduled firing is skipped because it ran too late. Use only for routines the owner depends on (e.g. morning brief, deadline reminders). Default false — silent skip is correct for low-stakes routines.',
            },
          },
          required: ['title', 'prompt', 'schedule_type', 'schedule_time'],
        },
      },
      {
        name: 'get_routines',
        description: 'List all routines (active and paused). Call when asked "what routines do you have?", "show my recurring tasks", "what runs automatically?", etc.',
        input_schema: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      },
      {
        name: 'update_routine',
        description: 'Modify a routine — change title, prompt, schedule, or pause/resume it.',
        input_schema: {
          type: 'object' as const,
          properties: {
            routine_id: { type: 'string', description: 'ID of the routine to update' },
            title:         { type: 'string' },
            prompt:        { type: 'string' },
            schedule_type: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly'] },
            schedule_time: { type: 'string', description: 'HH:MM in user timezone' },
            schedule_day:  { type: 'string' },
            status:        { type: 'string', enum: ['active', 'paused'], description: 'Pause or resume the routine' },
            never_stale:   { type: 'boolean', description: 'Toggle the always-run-even-late flag. See create_routine for semantics.' },
            notify_on_skip: { type: 'boolean', description: 'Toggle the skip-notification flag. See create_routine for semantics.' },
          },
          required: ['routine_id'],
        },
      },
      {
        name: 'delete_routine',
        description: 'Permanently delete a routine. Use when asked to "remove", "delete", or "stop" a recurring task.',
        input_schema: {
          type: 'object' as const,
          properties: {
            routine_id: { type: 'string' },
          },
          required: ['routine_id'],
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
        // v2.3.1 (B19 / #59 follow-up) — system-routine carve-out for
        // notify_on_skip ONLY. The morning brief is the primary use case for
        // notify_on_skip, but the original guard rejected any update on
        // is_system=1 routines, so the owner couldn't toggle the flag on it.
        // Now: fetch without the is_system filter; if it's a system routine,
        // only notify_on_skip is mutable. All other fields stay locked.
        const routine = db.prepare(
          'SELECT * FROM routines WHERE id = ? AND owner_user_id = ?'
        ).get(args.routine_id as string, ownerUserId) as Routine | null;

        if (!routine) return { error: 'Routine not found' };

        if (routine.is_system === 1) {
          if (args.notify_on_skip == null) {
            return { error: 'Built-in routines cannot be modified — only their skip-notification setting can be changed.' };
          }
          const newVal = args.notify_on_skip ? 1 : 0;
          db.prepare(
            `UPDATE routines SET notify_on_skip = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(newVal, args.routine_id as string);
          logger.info('System routine notify_on_skip toggled', { id: args.routine_id, value: newVal });
          return { updated: true, routine_id: args.routine_id };
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

        logger.info('Routine updated', { id: args.routine_id, updates: Object.keys(updates) });
        return { updated: true, routine_id: args.routine_id };
      }

      case 'delete_routine': {
        const routine = db.prepare(
          'SELECT * FROM routines WHERE id = ? AND owner_user_id = ? AND is_system = 0'
        ).get(args.routine_id as string, ownerUserId) as Routine | null;

        if (!routine) return { error: 'Routine not found' };

        db.prepare(
          `UPDATE routines SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`
        ).run(args.routine_id as string);

        logger.info('Routine deleted', { id: args.routine_id, title: routine.title });
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
- Before creating a routine, ALWAYS call get_routines first to check for duplicates. If a similar one exists, update it instead.
- Add \`notify_on_skip: true\` to flag a routine as important — I'll DM you if a firing is skipped.

When creating a routine, write the prompt as a complete, self-contained instruction.

Schedules: daily | weekdays (${workDaysStr}) | weekly (specify day) | monthly (specify day-of-month)

Tools: create_routine, get_routines, update_routine, delete_routine`;
  }
}
