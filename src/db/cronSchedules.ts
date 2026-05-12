/**
 * Cron schedules CRUD (v2.7.0).
 *
 * Recurring trigger config. Replaces the old `routines` table AND the cron-
 * typed rows that used to live in `tasks` (social_outreach_tick, social_decay,
 * morning_brief, user routines). One concept: "this thing fires on a schedule;
 * each fire MAY create a request when there's actual work to do."
 *
 * Empty fires (e.g. social_outreach_tick picks zero candidates) do NOT create
 * a request — they just update last_fired_at + next_fire_at and exit.
 *
 * One-shot lifecycle timers (approval_expiry, coord_nudge, outreach_decision)
 * do NOT live here — they live on the request row itself as `next_check_at` +
 * `next_check_handler`. See db/requests.ts getDueRequests.
 */

import { DateTime } from 'luxon';
import { getDb } from './client';
import logger from '../utils/logger';

export type CronHandler =
  | 'morning_brief'
  | 'social_outreach_tick'
  | 'social_decay'
  | 'user_routine';

export interface CronScheduleRow {
  id: string;
  created_at: string;
  updated_at: string;

  owner_user_id: string | null;
  name: string;
  handler: CronHandler;

  interval_seconds: number | null;
  cron_expression: string | null;
  routine_yaml: string | null;

  enabled: number;          // 0 | 1
  last_fired_at: string | null;
  last_request_id: string | null;
  next_fire_at: string;

  consecutive_failures: number;
  last_error: string | null;
}

export interface CreateCronScheduleInput {
  ownerUserId?: string;
  name: string;
  handler: CronHandler;
  intervalSeconds?: number;
  cronExpression?: string;
  routineYaml?: string;
  enabled?: boolean;
  nextFireAt?: string;
}

export function createCronSchedule(input: CreateCronScheduleInput): CronScheduleRow {
  const db = getDb();
  const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const nextFireAt = input.nextFireAt ?? DateTime.now().toUTC().toISO()!;
  db.prepare(`
    INSERT INTO cron_schedules (
      id, owner_user_id, name, handler,
      interval_seconds, cron_expression, routine_yaml,
      enabled, next_fire_at
    ) VALUES (
      @id, @owner_user_id, @name, @handler,
      @interval_seconds, @cron_expression, @routine_yaml,
      @enabled, @next_fire_at
    )
  `).run({
    id,
    owner_user_id: input.ownerUserId ?? null,
    name: input.name,
    handler: input.handler,
    interval_seconds: input.intervalSeconds ?? null,
    cron_expression: input.cronExpression ?? null,
    routine_yaml: input.routineYaml ?? null,
    enabled: input.enabled === false ? 0 : 1,
    next_fire_at: nextFireAt,
  });
  logger.info('createCronSchedule', { id, name: input.name, handler: input.handler });
  return getCronSchedule(id)!;
}

export function getCronSchedule(id: string): CronScheduleRow | null {
  return (getDb().prepare(`SELECT * FROM cron_schedules WHERE id = ?`).get(id) as CronScheduleRow | null) ?? null;
}

export function listCronSchedulesForOwner(ownerUserId: string): CronScheduleRow[] {
  return getDb().prepare(
    `SELECT * FROM cron_schedules WHERE owner_user_id = ? OR owner_user_id IS NULL ORDER BY name`
  ).all(ownerUserId) as CronScheduleRow[];
}

/** Schedules due to fire NOW. Sweeper reads this, dispatches, then re-arms next_fire_at. */
export function getDueCronSchedules(): CronScheduleRow[] {
  return getDb().prepare(`
    SELECT * FROM cron_schedules
    WHERE enabled = 1
      AND datetime(next_fire_at) <= datetime('now')
  `).all() as CronScheduleRow[];
}

export interface UpdateCronSchedulePatch {
  enabled?: boolean;
  intervalSeconds?: number;
  cronExpression?: string;
  routineYaml?: string;
  nextFireAt?: string;
  lastFiredAt?: string;
  lastRequestId?: string | null;
  consecutiveFailures?: number;
  lastError?: string | null;
}

export function updateCronSchedule(id: string, patch: UpdateCronSchedulePatch): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (patch.enabled !== undefined) { sets.push(`enabled = @enabled`); params.enabled = patch.enabled ? 1 : 0; }
  if (patch.intervalSeconds !== undefined) { sets.push(`interval_seconds = @interval_seconds`); params.interval_seconds = patch.intervalSeconds; }
  if (patch.cronExpression !== undefined) { sets.push(`cron_expression = @cron_expression`); params.cron_expression = patch.cronExpression; }
  if (patch.routineYaml !== undefined) { sets.push(`routine_yaml = @routine_yaml`); params.routine_yaml = patch.routineYaml; }
  if (patch.nextFireAt !== undefined) { sets.push(`next_fire_at = @next_fire_at`); params.next_fire_at = patch.nextFireAt; }
  if (patch.lastFiredAt !== undefined) { sets.push(`last_fired_at = @last_fired_at`); params.last_fired_at = patch.lastFiredAt; }
  if (patch.lastRequestId !== undefined) { sets.push(`last_request_id = @last_request_id`); params.last_request_id = patch.lastRequestId; }
  if (patch.consecutiveFailures !== undefined) { sets.push(`consecutive_failures = @consecutive_failures`); params.consecutive_failures = patch.consecutiveFailures; }
  if (patch.lastError !== undefined) { sets.push(`last_error = @last_error`); params.last_error = patch.lastError; }

  if (sets.length === 0) return;

  sets.push(`updated_at = datetime('now')`);
  getDb().prepare(`UPDATE cron_schedules SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function deleteCronSchedule(id: string): void {
  getDb().prepare(`DELETE FROM cron_schedules WHERE id = ?`).run(id);
}

/**
 * Advance next_fire_at after a fire. Interval-based only (cron-style schedules
 * compute their own next via cron-parser); on no interval, schedule is treated
 * as one-shot and disabled.
 */
export function advanceCronSchedule(id: string, opts: { spawnedRequestId?: string | null; error?: string | null } = {}): void {
  const row = getCronSchedule(id);
  if (!row) return;
  const now = DateTime.now().toUTC();
  const patch: UpdateCronSchedulePatch = {
    lastFiredAt: now.toISO()!,
    lastRequestId: opts.spawnedRequestId ?? null,
  };
  if (opts.error) {
    patch.consecutiveFailures = (row.consecutive_failures ?? 0) + 1;
    patch.lastError = opts.error;
  } else {
    patch.consecutiveFailures = 0;
    patch.lastError = null;
  }
  if (row.interval_seconds && row.interval_seconds > 0) {
    patch.nextFireAt = now.plus({ seconds: row.interval_seconds }).toISO()!;
  } else if (row.cron_expression) {
    // Defer to caller — they own the cron-expression library. We just leave
    // next_fire_at as-is and expect the caller to update it explicitly.
  } else {
    patch.enabled = false;
  }
  updateCronSchedule(id, patch);
}
