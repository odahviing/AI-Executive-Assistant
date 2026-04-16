import { DateTime } from 'luxon';
import { completeTask, createTask, updateTask } from '../index';
import { getCoordJob, updateCoordJob, type CoordParticipant } from '../../db';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * 24-work-hour nudge: DM non-responders once, then schedule coord_abandon
 * at +4h from now.
 */
export const dispatchCoordNudge: TaskDispatcher = async (app, task, profile) => {
  const bot_token = profile.assistant.slack.bot_token;

  if (!task.skill_ref) { updateTask(task.id, { status: 'failed' }); return; }
  const job = getCoordJob(task.skill_ref);
  if (!job) {
    logger.warn('coord_nudge — coord_job missing', { taskId: task.id });
    updateTask(task.id, { status: 'failed' });
    return;
  }
  if (job.status !== 'collecting' && job.status !== 'negotiating') {
    logger.info('coord_nudge — coord no longer needs nudge, skipping', {
      taskId: task.id,
      coordId: job.id,
      status: job.status,
    });
    completeTask(task.id);
    return;
  }

  const participants = JSON.parse(job.participants) as CoordParticipant[];
  const nonResponders = participants.filter(p =>
    !p.just_invite &&
    p.dm_sent_at &&
    (p.response === null || p.response === undefined),
  );
  if (nonResponders.length === 0) {
    logger.info('coord_nudge — all key participants have responded, nothing to do', { taskId: task.id });
    completeTask(task.id);
    return;
  }

  for (const p of nonResponders) {
    if (!p.slack_id) continue;
    try {
      const dmResult = await app.client.conversations.open({ token: bot_token, users: p.slack_id });
      const dmChannel = (dmResult.channel as any)?.id;
      if (dmChannel) {
        await app.client.chat.postMessage({
          token: bot_token,
          channel: dmChannel,
          text: `Hi ${p.name}, gentle nudge about "${job.subject}" — let me know when you get a chance.`,
        });
      }
    } catch (err) {
      logger.warn('coord_nudge — DM failed for participant', { err: String(err), participant: p.name });
    }
  }
  updateCoordJob(job.id, { follow_up_sent_at: new Date().toISOString() });

  // Schedule the abandon check +4h from now
  const abandonAt = DateTime.now().plus({ hours: 4 }).toUTC().toISO()!;
  createTask({
    owner_user_id: job.owner_user_id,
    owner_channel: job.owner_channel,
    owner_thread_ts: job.owner_thread_ts,
    type: 'coord_abandon',
    status: 'new',
    title: `Close "${job.subject}" if still unanswered`,
    due_at: abandonAt,
    skill_ref: job.id,
    context: JSON.stringify({ coord_job_id: job.id }),
    who_requested: 'system',
    skill_origin: 'meetings',
  });
  completeTask(task.id);
  logger.info('coord_nudge sent and abandon scheduled', {
    taskId: task.id,
    coordId: job.id,
    nudged: nonResponders.map(p => p.name),
    abandonAt,
  });
};
