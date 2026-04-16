import { completeTask, createTask, updateTask } from '../index';
import { getDb, updateOutreachJob } from '../../db';
import { sendOutreachDM, calcResponseDeadline } from '../../connectors/slack/coordinator';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * Scheduled outreach DM send. skill_ref → outreach_jobs.id.
 * On success, auto-queues an outreach_expiry task if await_reply is set.
 */
export const dispatchOutreachSend: TaskDispatcher = async (app, task, profile) => {
  const bot_token = profile.assistant.slack.bot_token;

  if (!task.skill_ref) {
    logger.warn('outreach_send task missing skill_ref', { taskId: task.id });
    updateTask(task.id, { status: 'failed' });
    return;
  }

  const job = getDb().prepare(
    `SELECT * FROM outreach_jobs WHERE id = ?`
  ).get(task.skill_ref) as any;

  if (!job) {
    logger.warn('outreach_send — outreach_jobs row missing', { taskId: task.id, outreachId: task.skill_ref });
    updateTask(task.id, { status: 'failed' });
    return;
  }
  if (job.status !== 'pending_scheduled') {
    logger.info('outreach_send — outreach already progressed past pending_scheduled, skipping', {
      taskId: task.id,
      outreachId: task.skill_ref,
      status: job.status,
    });
    completeTask(task.id);
    return;
  }

  try {
    await sendOutreachDM(app, {
      jobId: job.id,
      colleague_slack_id: job.colleague_slack_id,
      colleague_name: job.colleague_name,
      message: job.message,
      await_reply: job.await_reply === 1,
      bot_token,
    });
    updateOutreachJob(job.id, { status: 'sent', sent_at: new Date().toISOString() });
    await app.client.chat.postMessage({
      token: bot_token,
      channel: job.owner_channel,
      thread_ts: job.owner_thread_ts ?? undefined,
      text: `Just sent your message to ${job.colleague_name} as scheduled. I'll let you know what they say.`,
    });

    if (job.await_reply === 1) {
      const deadline = calcResponseDeadline(job.colleague_tz ?? profile.user.timezone);
      updateOutreachJob(job.id, { reply_deadline: deadline });
      createTask({
        owner_user_id: job.owner_user_id,
        owner_channel: job.owner_channel,
        owner_thread_ts: job.owner_thread_ts,
        type: 'outreach_expiry',
        status: 'new',
        title: `Check reply deadline from ${job.colleague_name}`,
        due_at: deadline,
        skill_ref: job.id,
        context: JSON.stringify({ outreach_id: job.id }),
        who_requested: 'system',
        skill_origin: 'outreach',
      });
    }
    completeTask(task.id);
    logger.info('outreach_send dispatched via task runner', {
      taskId: task.id,
      outreachId: job.id,
      colleague: job.colleague_name,
    });
  } catch (err) {
    logger.error('outreach_send failed', { err: String(err), taskId: task.id, outreachId: job.id });
    updateOutreachJob(job.id, { status: 'cancelled', reply_text: `Send failed: ${String(err)}` });
    updateTask(task.id, { status: 'failed' });
  }

};
