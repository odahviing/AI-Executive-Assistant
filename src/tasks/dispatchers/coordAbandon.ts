import { DateTime } from 'luxon';
import { completeTask, updateTask } from '../index';
import { getDb, getCoordJob, updateCoordJob } from '../../db';
import { getConnection } from '../../connections/registry';
import { isWithinOwnerWorkHours, nextOwnerWorkdayStart } from '../../utils/workHours';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * If still stuck in collecting/negotiating 4h after the nudge, close it.
 * Defers the close + owner notification to the next work window if we'd
 * otherwise fire at 3am Saturday.
 */
export const dispatchCoordAbandon: TaskDispatcher = async (_app, task, profile) => {
  if (!task.skill_ref) { updateTask(task.id, { status: 'failed' }); return; }
  const job = getCoordJob(task.skill_ref);
  if (!job) {
    updateTask(task.id, { status: 'failed' });
    return;
  }
  if (job.status !== 'collecting' && job.status !== 'negotiating') {
    logger.info('coord_abandon — coord already progressed, skipping', {
      taskId: task.id,
      coordId: job.id,
      status: job.status,
    });
    completeTask(task.id);
    return;
  }

  const ownerNow = DateTime.now().setZone(profile.user.timezone);
  if (!isWithinOwnerWorkHours(profile, ownerNow)) {
    const deferredAt = nextOwnerWorkdayStart(profile);
    logger.info('coord_abandon — outside owner work hours; deferring', {
      taskId: task.id,
      coordId: job.id,
      now: ownerNow.toISO(),
      deferredAt,
    });
    updateTask(task.id, { due_at: deferredAt });
    return;
  }
  updateCoordJob(job.id, {
    status: 'abandoned',
    abandoned_at: new Date().toISOString(),
    notes: 'abandoned after 24-hour nudge + 4-hour grace period',
  });
  getDb().prepare(
    `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
     WHERE skill_ref = ? AND type = 'coordination' AND status IN ('new','in_progress','pending_owner','pending_colleague')`
  ).run(job.id);

  const slackConn = getConnection(profile.user.slack_user_id, 'slack');
  if (slackConn) {
    await slackConn.postToChannel(
      job.owner_channel,
      `I couldn't get a response on "${job.subject}" — I've closed it. Want me to try again later?`,
      { threadTs: job.owner_thread_ts ?? undefined },
    );
  }
  completeTask(task.id);
  logger.info('coord_abandon — coord closed', {
    taskId: task.id,
    coordId: job.id,
    subject: job.subject,
  });
};
