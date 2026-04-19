import { completeTask, createTask, updateTask } from '../index';
import { getDb, updateOutreachJob } from '../../db';
import { calcResponseDeadline } from '../../connectors/slack/coordinator';
import { getConnection } from '../../connections/registry';
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
    // v1.8.11 — use the registered Slack Connection instead of the direct
    // coordinator.sendOutreachDM helper. Keeps the dispatcher transport-
    // agnostic; when email / WhatsApp Connections come online and an
    // outreach was scheduled for a non-Slack recipient, the router will
    // resolve to the right connection here.
    const slackConn = getConnection(job.owner_user_id, 'slack');
    if (!slackConn) {
      throw new Error('slack_connection_not_registered');
    }
    const outcome = await slackConn.sendDirect(job.colleague_slack_id, job.message);
    if (!outcome.ok) {
      throw new Error(`send failed: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`);
    }
    logger.info('Scheduled outreach DM sent', {
      jobId: job.id,
      colleague: job.colleague_name,
      preview: job.message.slice(0, 80),
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
