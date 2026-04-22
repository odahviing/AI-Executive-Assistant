/**
 * Outreach orphan backfill (v2.0.8, one-shot at startup).
 *
 * The v2.0.7 sibling-outreach cleanup lives inside `updateCoordJob` terminal
 * transitions — which only fires for NEW bookings. Coords that transitioned
 * to terminal BEFORE v2.0.7 shipped never triggered the cleanup, so their
 * sibling `outreach_jobs` rows still sit in the DB as `no_response` / `sent`
 * / `replied` and keep re-surfacing in the morning brief.
 *
 * Symptom we hit: Amazia "Kickoff website agent" coord booked on 2026-04-21,
 * three stale `no_response` outreach rows from the pre-coord attempts were
 * still in the DB, and 2026-04-22's brief surfaced "Amazia never responded
 * to the Kickoff invite — that one's still hanging" even though the meeting
 * was on the calendar.
 *
 * Two passes:
 *   1) For every coord_job in terminal state (booked / cancelled / abandoned)
 *      in the last 30 days, run the same sibling cleanup `updateCoordJob`
 *      now does on new transitions — close matching outreach_jobs to `done`
 *      and cancel their pending outreach_expiry / outreach_decision tasks.
 *
 *   2) For every outreach_job still in `no_response` status with no
 *      outreach_decision task scheduled, schedule one 2 owner-workdays out
 *      so it gets a proper tombstone instead of living forever.
 *
 * Idempotent: pass (1) is a no-op once sibling outreach is already closed.
 * Pass (2) checks for an existing outreach_decision task before inserting.
 * Safe to run on every startup; the work bounds by the 30-day / no_response
 * filters so it's O(dozens), not O(everything).
 */

import type { UserProfile } from '../../config/userProfile';
import { getDb } from '../../db/client';
import { createTask } from '../../tasks';
import { addWorkdays } from '../../utils/workHours';
import { DateTime } from 'luxon';
import logger from '../../utils/logger';

export function backfillOutreachOrphans(profiles: Map<string, UserProfile>): void {
  const db = getDb();

  // ── Pass 1: close siblings on already-terminal coords ──────────────────
  let closedFromCoords = 0;
  try {
    const terminalCoords = db.prepare(`
      SELECT id, participants
      FROM coord_jobs
      WHERE status IN ('booked', 'cancelled', 'abandoned')
        AND datetime(updated_at) >= datetime('now', '-30 days')
    `).all() as Array<{ id: string; participants: string }>;

    for (const coord of terminalCoords) {
      let slackIds: string[] = [];
      try {
        const parts = JSON.parse(coord.participants || '[]') as Array<{ slack_id?: string; just_invite?: boolean }>;
        slackIds = parts.filter(p => p.slack_id && !p.just_invite).map(p => p.slack_id!) as string[];
      } catch (_) { continue; }
      if (slackIds.length === 0) continue;

      const placeholders = slackIds.map(() => '?').join(',');
      const closed = db.prepare(`
        UPDATE outreach_jobs
        SET status = 'done', updated_at = datetime('now')
        WHERE colleague_slack_id IN (${placeholders})
          AND status IN ('sent', 'no_response', 'replied')
          AND datetime(created_at) >= datetime('now', '-30 days')
      `).run(...slackIds);
      if (closed.changes > 0) {
        closedFromCoords += closed.changes;
        db.prepare(`
          UPDATE tasks
          SET status = 'cancelled', updated_at = datetime('now')
          WHERE type IN ('outreach_expiry', 'outreach_decision')
            AND status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
            AND skill_ref IN (
              SELECT id FROM outreach_jobs
              WHERE colleague_slack_id IN (${placeholders})
            )
        `).run(...slackIds);
      }
    }
  } catch (err) {
    logger.warn('outreachOrphanBackfill pass 1 (coord siblings) threw — continuing to pass 2', {
      err: String(err),
    });
  }

  // ── Pass 2: schedule outreach_decision tombstone for any bare no_response ─
  let tombstonesScheduled = 0;
  try {
    const orphanNoResponse = db.prepare(`
      SELECT o.id, o.owner_user_id, o.owner_channel, o.owner_thread_ts,
             o.colleague_name, o.colleague_slack_id
      FROM outreach_jobs o
      WHERE o.status = 'no_response'
        AND datetime(o.created_at) >= datetime('now', '-30 days')
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.skill_ref = o.id
            AND t.type = 'outreach_decision'
            AND t.status IN ('new', 'in_progress')
        )
    `).all() as Array<{
      id: string;
      owner_user_id: string;
      owner_channel: string;
      owner_thread_ts: string | null;
      colleague_name: string;
      colleague_slack_id: string;
    }>;

    for (const job of orphanNoResponse) {
      const profile = profiles.get(job.owner_user_id);
      if (!profile) continue;  // profile not loaded — skip, don't fail
      try {
        const decisionDueAt = addWorkdays(DateTime.now().toUTC().toISO()!, 2, profile);
        createTask({
          owner_user_id: job.owner_user_id,
          owner_channel: job.owner_channel,
          owner_thread_ts: job.owner_thread_ts ?? undefined,
          type: 'outreach_decision',
          status: 'new',
          title: `Auto-close ${job.colleague_name}'s stuck outreach if still silent`,
          due_at: decisionDueAt,
          skill_ref: job.id,
          context: JSON.stringify({
            outreach_id: job.id,
            reason: 'backfill_orphan_no_response_v2_0_8',
          }),
          who_requested: 'system',
          skill_origin: 'outreach',
        });
        tombstonesScheduled += 1;
      } catch (err) {
        logger.warn('outreachOrphanBackfill — failed to schedule decision task for one row', {
          err: String(err), outreachId: job.id,
        });
      }
    }
  } catch (err) {
    logger.warn('outreachOrphanBackfill pass 2 (orphan no_response) threw', {
      err: String(err),
    });
  }

  if (closedFromCoords > 0 || tombstonesScheduled > 0) {
    logger.info('outreachOrphanBackfill — sweep complete', {
      closedFromCoords,
      tombstonesScheduled,
    });
  }
}
