/**
 * Routine → Task materializer (v1.5.1).
 *
 * Routines are no longer scheduled or executed directly. They exist only to
 * describe "at this cadence, insert a task of type=routine with due_at equal
 * to the scheduled instant." The task runner does the actual work.
 *
 * This file replaces `runDueRoutines` from `crons.runner.ts`. The old 90-min
 * "are we in the window?" guard and the "I was offline at X — run now or skip?"
 * DM are gone. Lateness is decided by the task runner, not here.
 *
 * Catch-up semantics: if a routine has been missed multiple times (bot down for
 * days), we fast-forward `next_run_at` past the stale occurrences and insert
 * ONE task — the most recent missed firing. We don't replay history.
 */

import { DateTime } from 'luxon';
import { getDb } from '../db';
import type { UserProfile } from '../config/userProfile';
import { computeNextRunAt, getProfileWorkDays, type Routine } from './crons';
import { assessLateness } from './lateness';
import { createTask } from './index';
import { getConnection } from '../connections/registry';
import logger from '../utils/logger';

function getDueRoutines(): Routine[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM routines
    WHERE status = 'active'
      AND next_run_at IS NOT NULL
      AND datetime(next_run_at) <= datetime('now')
  `).all() as Routine[];
}

/**
 * One-shot startup repair for routines whose `next_run_at` is NULL.
 *
 * The chicken-and-egg failure: the materializer's `getDueRoutines` query
 * filters `next_run_at IS NOT NULL`, and the materializer is the only
 * code path that updates `next_run_at`. So a routine created (or migrated
 * in) with NULL is silently invisible forever — it never fires, and the
 * silence has no diagnostic. Surfaced 2026-04-30 (#75 — calendar health
 * routine created Apr 23, never ran).
 *
 * Called from `initProfile` per profile. Idempotent — only touches rows
 * still at NULL. Logs a `warn` per backfill so we know if something is
 * still creating routines outside `create_routine` (the create path
 * always populates next_run_at; a backfill hit means a non-tool path
 * inserted a row).
 */
export function backfillNullNextRunAt(profile: UserProfile): number {
  const db = getDb();
  const ownerUserId = profile.user.slack_user_id;
  const broken = db.prepare(`
    SELECT id, schedule_type, schedule_time, schedule_day, title
    FROM routines
    WHERE owner_user_id = ? AND status = 'active' AND next_run_at IS NULL
  `).all(ownerUserId) as Array<{
    id: string;
    schedule_type: string;
    schedule_time: string;
    schedule_day: string | null;
    title: string;
  }>;
  if (broken.length === 0) return 0;

  const workDays = getProfileWorkDays(profile);
  const tz = profile.user.timezone;
  let repaired = 0;
  for (const row of broken) {
    try {
      const nextRunAt = computeNextRunAt(
        row.schedule_type,
        row.schedule_time,
        row.schedule_day,
        tz,
        undefined,
        workDays,
      );
      db.prepare(
        `UPDATE routines SET next_run_at = @next, updated_at = datetime('now') WHERE id = @id`
      ).run({ id: row.id, next: nextRunAt });
      repaired++;
      logger.warn('Routine had NULL next_run_at — backfilled at startup', {
        ownerUserId,
        routineId: row.id,
        title: row.title,
        scheduleType: row.schedule_type,
        scheduleTime: row.schedule_time,
        scheduleDay: row.schedule_day,
        nextRunAt,
      });
    } catch (err) {
      logger.error('Routine NULL backfill failed for one row — continuing', {
        ownerUserId,
        routineId: row.id,
        err: String(err),
      });
    }
  }
  return repaired;
}

/**
 * Called on the 5-minute background tick. For every active routine whose
 * `next_run_at` is past, insert a task at that instant and advance the
 * routine's `next_run_at` to the next future occurrence.
 *
 * Idempotent per (routine_id, due_at) via the UNIQUE index — running twice
 * in the same tick is safe.
 */
export async function materializeRoutineTasks(
  profiles: Map<string, UserProfile>,
): Promise<number> {
  const due = getDueRoutines();
  if (due.length === 0) return 0;

  const db = getDb();
  let materialized = 0;

  for (const routine of due) {
    const profile = [...profiles.values()].find(
      p => p.user.slack_user_id === routine.owner_user_id,
    );
    if (!profile) {
      logger.warn('Routine owner profile not found — skipping materialization', {
        routineId: routine.id,
      });
      continue;
    }

    const workDays = getProfileWorkDays(profile);
    const tz = profile.user.timezone;

    // v1.6.10 — walk forward from routine.next_run_at through every missed
    // firing. Find the MOST RECENT firing that is still within the lateness
    // threshold (per assessLateness). Materialize a task for THAT one.
    //
    // The old behavior materialized the OLDEST missed firing and
    // fast-forwarded past everything else — which meant on a late-boot day,
    // we created a task for yesterday's 07:30 (dead on arrival, skipped as
    // 24h late), while today's 07:30 firing — which was only 29 min late and
    // perfectly viable — got blown past and never ran.
    //
    // New algorithm: iterate firings until we pass `now`. Keep the most recent
    // viable one. After the loop, the cursor is the first FUTURE firing; set
    // next_run_at to that. Materialize the viable one if we found one.
    const now = DateTime.utc();
    let cursorIso: string = routine.next_run_at!;
    let mostRecentViable: string | null = null;
    let mostRecentViableReason = '';

    const advance = (fromIso: string): string => computeNextRunAt(
      routine.schedule_type,
      routine.schedule_time,
      routine.schedule_day,
      tz,
      DateTime.fromISO(fromIso, { zone: 'utc' }),
      workDays,
    );

    let walkGuard = 0;
    while (walkGuard++ < 1000) {
      const cursorDt = DateTime.fromISO(cursorIso, { zone: 'utc' });
      if (cursorDt > now) break;  // cursorIso is the first future firing

      const verdict = assessLateness({ routine, scheduledAtIso: cursorIso });
      if (verdict.run) {
        // Viable: keep as candidate. Keep walking — a LATER firing might also
        // be viable, and we prefer the most recent one (minimizes lateness).
        mostRecentViable = cursorIso;
        mostRecentViableReason = `${verdict.latenessMinutes}min late, within threshold`;
      }

      const nextCursor = advance(cursorIso);
      // Safety: if computeNextRunAt returns the same or earlier instant,
      // break to avoid infinite loop (should not happen for valid schedules).
      if (DateTime.fromISO(nextCursor, { zone: 'utc' }) <= cursorDt) break;
      cursorIso = nextCursor;
    }

    const nextFuture = cursorIso;  // first firing > now after the walk

    if (mostRecentViable) {
      try {
        const taskId = createTask({
          owner_user_id: routine.owner_user_id,
          owner_channel: routine.owner_channel,
          owner_thread_ts: undefined,
          type: 'routine',
          status: 'new',
          title: routine.title,
          description: undefined,
          due_at: mostRecentViable,
          context: JSON.stringify({
            routine_run: true,
            scheduled_at: mostRecentViable,
            is_system: routine.is_system === 1,
            never_stale: (routine as any).never_stale === 1,
          }),
          // v1.8.6 — routine tasks are owner-authored, not system-created.
          // The owner set the routine up; its materialized firings are "on
          // his plate" (visible to get_my_tasks). Only skill-internal tasks
          // (outreach dispatch, coord nudge, calendar fix, etc.) should
          // remain 'system' and stay hidden from the owner's queue.
          who_requested: routine.owner_user_id,
          routine_id: routine.id,
        });
        logger.info('Routine materialized', {
          routineId: routine.id,
          taskId,
          scheduledAt: mostRecentViable,
          nextRunAt: nextFuture,
          viability: mostRecentViableReason,
        });
        materialized++;
      } catch (err) {
        const msg = String(err);
        if (msg.includes('UNIQUE') || msg.includes('constraint')) {
          logger.debug('Routine already materialized for this firing — skipping', {
            routineId: routine.id,
            scheduledAt: mostRecentViable,
          });
        } else {
          logger.error('Routine materialization insert failed', {
            err: msg,
            routineId: routine.id,
          });
          continue;  // don't advance next_run_at if we failed to record it
        }
      }
    } else {
      // No viable missed firing — every missed slot was past its lateness
      // threshold. Don't materialize anything; just advance the clock.
      logger.info('Routine had missed firings but all were past lateness threshold — advancing clock only', {
        routineId: routine.id,
        title: routine.title,
        previousNextRunAt: routine.next_run_at,
        advancedTo: nextFuture,
      });

      // Issue #59 — notify owner if they opted in
      if ((routine as any).notify_on_skip === 1) {
        try {
          const conn = getConnection(routine.owner_user_id, 'slack');
          if (conn) {
            const nextDt = DateTime.fromISO(nextFuture).setZone(profile.user.timezone);
            const nextFormatted = nextDt.toFormat("EEE d MMM 'at' HH:mm");
            await conn.sendDirect(
              routine.owner_user_id,
              `Just so you know — your *${routine.title}* routine was due earlier, ` +
              `but by the time I came back online it was too late to run it usefully, ` +
              `so I skipped this round. Next one is ${nextFormatted}.`,
            );
          }
        } catch (notifyErr) {
          logger.warn('notify_on_skip DM failed in materializer', {
            routineId: routine.id,
            err: String(notifyErr),
          });
        }
      }
    }

    // Advance routine.next_run_at to the first future firing. Even if we
    // didn't materialize, the clock must move forward or we'd loop forever.
    db.prepare(
      `UPDATE routines SET next_run_at = @next, updated_at = datetime('now') WHERE id = @id`
    ).run({ id: routine.id, next: nextFuture });
  }

  return materialized;
}
