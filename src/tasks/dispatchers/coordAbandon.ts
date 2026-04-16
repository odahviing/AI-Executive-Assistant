import { completeTask, updateTask } from '../index';
import { getDb, getCoordJob, updateCoordJob } from '../../db';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * If still stuck in collecting/negotiating 4h after the nudge, close it.
 */
export const dispatchCoordAbandon: TaskDispatcher = async (app, task, profile) => {
  const bot_token = profile.assistant.slack.bot_token;

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
  updateCoordJob(job.id, {
    status: 'abandoned',
    abandoned_at: new Date().toISOString(),
    notes: 'abandoned after 24-hour nudge + 4-hour grace period',
  });
  getDb().prepare(
    `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
     WHERE skill_ref = ? AND type = 'coordination' AND status IN ('new','in_progress','pending_owner','pending_colleague')`
  ).run(job.id);
  await app.client.chat.postMessage({
    token: bot_token,
    channel: job.owner_channel,
    thread_ts: job.owner_thread_ts ?? undefined,
    text: `I couldn't get a response on "${job.subject}" — I've closed it. Want me to try again later?`,
  });
  completeTask(task.id);
  logger.info('coord_abandon — coord closed', {
    taskId: task.id,
    coordId: job.id,
    subject: job.subject,
  });
};
