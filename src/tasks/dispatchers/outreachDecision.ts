/**
 * outreach_decision dispatcher (v2.0.7).
 *
 * Problem this solves: before 2.0.7, an outreach that went `no_response`
 * lived in that status forever. The morning-brief collector surfaced it
 * every day ("no response yet") until the owner manually resolved it, and
 * nothing ever auto-closed the zombie. Amazia's Privacy GTM outreach from
 * April 16 sat in no_response for 6+ days for exactly this reason.
 *
 * New flow: when outreachExpiry marks a job `no_response`, it also schedules
 * an `outreach_decision` task to fire 2 owner-workdays later (Fri/Sat are
 * skipped per the profile). When we fire:
 *
 *   - If the outreach is still in `no_response` and the owner never replied
 *     to the "want me to try again or leave it?" DM → auto-close to `done`
 *     with a brief shadow note to the owner so they know we gave up.
 *   - If the outreach already moved on (owner said "try again" → status
 *     flipped, colleague finally replied, coord took over, etc.) → no-op.
 *
 * The 48-workhour window respects the owner's schedule so asking on a
 * Thursday doesn't silently give up on Sunday because "48 calendar hours"
 * passed over the weekend.
 */

import { completeTask, updateTask } from '../index';
import { getDb, updateOutreachJob } from '../../db';
import { getConnection } from '../../connections/registry';
import { shadowNotify } from '../../utils/shadowNotify';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

export const dispatchOutreachDecision: TaskDispatcher = async (_app, task, profile) => {
  if (!task.skill_ref) {
    updateTask(task.id, { status: 'failed' });
    return;
  }

  const job = getDb().prepare(
    `SELECT * FROM outreach_jobs WHERE id = ?`
  ).get(task.skill_ref) as
    | {
        id: string;
        status: string;
        colleague_name: string;
        colleague_slack_id: string;
        owner_channel: string;
        owner_thread_ts: string | null;
      }
    | undefined;

  if (!job) {
    logger.warn('outreach_decision — outreach_jobs row missing, completing task', {
      taskId: task.id, outreachId: task.skill_ref,
    });
    completeTask(task.id);
    return;
  }

  // If the outreach moved on (owner acted, colleague replied, coord took over,
  // etc.) — nothing to decide. Just complete the task.
  if (job.status !== 'no_response') {
    logger.info('outreach_decision — outreach moved past no_response, no-op', {
      taskId: task.id, outreachId: job.id, status: job.status,
    });
    completeTask(task.id);
    return;
  }

  // Still `no_response` after 2 workdays of owner silence. Give up cleanly.
  updateOutreachJob(job.id, { status: 'done' } as any);
  completeTask(task.id);

  // One-line shadow DM to the owner so they know we gave up. The earlier
  // "want me to try again or leave it?" DM already fired from outreachExpiry
  // when we first entered no_response; this is the tombstone, not a nag.
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (conn) {
    await shadowNotify(profile, {
      channel: job.owner_channel,
      threadTs: job.owner_thread_ts ?? undefined,
      action: 'Outreach closed',
      detail: `${job.colleague_name} didn't reply after 2 working days — closed out. Ping me if you want me to try again.`,
    });
  }

  logger.info('outreach_decision — auto-closed stuck outreach', {
    taskId: task.id,
    outreachId: job.id,
    colleague: job.colleague_name,
  });
};
