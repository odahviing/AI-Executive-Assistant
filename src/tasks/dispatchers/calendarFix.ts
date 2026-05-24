import { completeTask, updateTask } from '../index';
import { getCalendarIssueById } from '../../db/calendarIssues';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * Legacy calendar_fix task dispatcher (v3.0.3 — retired).
 *
 * Pre-v3.0.3 this dispatcher re-checked issues that the owner had marked
 * `to_resolve`, re-pinging if still present and auto-closing if vanished.
 * Under the v3.0.3 redesign, `to_resolve` is replaced by `in_progress` with
 * an attached request_id — the request runner handles its own re-check
 * cadence, and `closeMeetingArtifacts` cascade auto-resolves rows when the
 * underlying event changes. No new code path spawns calendar_fix tasks.
 *
 * Kept here as a graceful no-op so any legacy in-flight tasks complete
 * cleanly rather than failing the runner.
 */
export const dispatchCalendarFix: TaskDispatcher = async (_app, task, _profile) => {
  if (!task.skill_ref) {
    updateTask(task.id, { status: 'failed' });
    return;
  }
  const issue = getCalendarIssueById(task.skill_ref);
  if (!issue) {
    logger.info('calendar_fix — legacy task references missing row, completing', {
      taskId: task.id, issueRef: task.skill_ref,
    });
    completeTask(task.id);
    return;
  }
  logger.info('calendar_fix — legacy task no-op (handled by requests spine + cascade now)', {
    taskId: task.id, issueId: issue.id, status: issue.status,
  });
  completeTask(task.id);
};
