import { completeTask, updateTask } from '../index';
import { getDb, getCoordJob, updateCoordJob } from '../../db';
import { getApproval, setApprovalDecision } from '../../db/approvals';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * Approval past its expires_at — expire it and cascade.
 */
export const dispatchApprovalExpiry: TaskDispatcher = async (app, task, profile) => {
  const bot_token = profile.assistant.slack.bot_token;

  if (!task.skill_ref) { updateTask(task.id, { status: 'failed' }); return; }
  const approval = getApproval(task.skill_ref);
  if (!approval) {
    logger.warn('approval_expiry — approval missing', { taskId: task.id });
    updateTask(task.id, { status: 'failed' });
    return;
  }
  if (approval.status !== 'pending') {
    logger.info('approval_expiry — approval already resolved, skipping', {
      taskId: task.id,
      approvalId: approval.id,
      status: approval.status,
    });
    completeTask(task.id);
    return;
  }
  setApprovalDecision({ id: approval.id, status: 'expired' });
  // Cascade: cancel parent task, abandon linked coord if any
  getDb().prepare(
    `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
     WHERE id = ? AND status IN ('new','in_progress','pending_owner','pending_colleague')`
  ).run(approval.task_id);
  if (approval.skill_ref) {
    const coord = getCoordJob(approval.skill_ref);
    if (coord && !['booked', 'cancelled', 'abandoned'].includes(coord.status)) {
      updateCoordJob(approval.skill_ref, {
        status: 'abandoned',
        abandoned_at: new Date().toISOString(),
        notes: `approval ${approval.id} expired`,
      });
    }
  }
  if (approval.slack_channel) {
    try {
      await app.client.chat.postMessage({
        token: bot_token,
        channel: approval.slack_channel,
        thread_ts: approval.slack_thread_ts ?? undefined,
        text: `I never heard back on the approval I asked about. I've closed it — let me know if you want to try again.`,
      });
    } catch (err) {
      logger.warn('approval_expiry — owner DM failed', { err: String(err), approvalId: approval.id });
    }
  }
  completeTask(task.id);
  logger.info('approval_expiry — approval expired via task', {
    taskId: task.id,
    approvalId: approval.id,
    kind: approval.kind,
  });
};
