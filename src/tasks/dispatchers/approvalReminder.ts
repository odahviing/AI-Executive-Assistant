/**
 * approval_reminder — halfway-point nag for an unresolved approval (v2.1.3).
 *
 * Paired with `approval_expiry`. Where `approval_expiry` fires at `expires_at`
 * and cascades the close (coord abandon, task cancel, owner "I closed it" DM),
 * `approval_reminder` fires at roughly the midpoint of the expiry window and
 * does one thing: if the approval is still pending, DM the owner a reminder.
 *
 * Why this exists: the morning brief already includes pending approvals in
 * `pending_your_input`, so technically the owner already gets a daily
 * reminder. In practice a passive list entry in a longer brief is easy to
 * scroll past. A dedicated short DM *"heads up, still waiting on X — want to
 * approve, decline, or should I close it?"* is impossible to miss and
 * costs one short message. Owner asked for this explicitly (scenario 11).
 *
 * Fires at most ONCE per approval. Scheduled alongside `approval_expiry` in
 * `createApproval`. No-ops if the approval moved past `pending` by the time
 * the reminder task runs (resolved, rejected, amended, cancelled, expired).
 */

import { completeTask, updateTask } from '../index';
import { getApproval } from '../../db/approvals';
import { getConnection } from '../../connections/registry';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

export const dispatchApprovalReminder: TaskDispatcher = async (_app, task, profile) => {
  if (!task.skill_ref) {
    updateTask(task.id, { status: 'failed' });
    return;
  }
  const approval = getApproval(task.skill_ref);
  if (!approval) {
    logger.warn('approval_reminder — approval missing, completing', { taskId: task.id });
    completeTask(task.id);
    return;
  }
  if (approval.status !== 'pending') {
    logger.info('approval_reminder — approval already resolved, skipping', {
      taskId: task.id, approvalId: approval.id, status: approval.status,
    });
    completeTask(task.id);
    return;
  }

  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    logger.warn('approval_reminder — no Slack connection registered', { taskId: task.id });
    completeTask(task.id);
    return;
  }

  // Pull a short description from the payload for the reminder text.
  let subjectLine = `the approval I asked about (${approval.kind})`;
  try {
    const payload = JSON.parse(approval.payload_json) as Record<string, unknown>;
    const subj = (payload.subject as string | undefined)
      ?? (payload.question as string | undefined)
      ?? null;
    if (subj) subjectLine = `"${subj.slice(0, 120)}"`;
  } catch (_) { /* use fallback */ }

  const dmChannel = approval.slack_channel ?? profile.user.slack_user_id;
  const msg = `Still waiting on your call on ${subjectLine}. Want to approve, decline, or should I close it? I'll auto-close if I don't hear back.`;

  try {
    if (approval.slack_channel) {
      await conn.postToChannel(dmChannel, msg, {
        threadTs: approval.slack_thread_ts ?? undefined,
      });
    } else {
      await conn.sendDirect(profile.user.slack_user_id, msg);
    }
    logger.info('approval_reminder — sent', {
      taskId: task.id, approvalId: approval.id, subject: subjectLine,
    });
  } catch (err) {
    logger.warn('approval_reminder — send failed, completing task', {
      err: String(err), approvalId: approval.id,
    });
  }
  completeTask(task.id);
};
