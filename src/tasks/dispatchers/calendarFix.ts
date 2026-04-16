import { DateTime } from 'luxon';
import { completeTask, createTask, updateTask } from '../index';
import {
  getCalendarIssueById,
  getDismissedIssueKeys,
  buildIssueKey,
  updateCalendarIssueStatus,
} from '../../db/calendarIssues';
import { analyzeCalendar, processCalendarEvents } from '../../skills/_meetingsOps';
import { getCalendarEvents } from '../../connectors/graph/calendar';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * Re-check whether a calendar issue marked 'to_resolve' still exists.
 * If yes → re-ping owner; if no → mark resolved silently.
 */
export const dispatchCalendarFix: TaskDispatcher = async (app, task, profile) => {
  const bot_token = profile.assistant.slack.bot_token;

  if (!task.skill_ref) { updateTask(task.id, { status: 'failed' }); return; }
  const issue = getCalendarIssueById(task.skill_ref);
  if (!issue) {
    logger.warn('calendar_fix — issue missing', { taskId: task.id, issueId: task.skill_ref });
    updateTask(task.id, { status: 'failed' });
    return;
  }
  if (issue.resolution === 'resolved' || issue.resolution === 'approved' || issue.resolution === 'dismissed') {
    logger.info('calendar_fix — issue already resolved/approved, nothing to do', {
      taskId: task.id,
      issueId: issue.id,
      resolution: issue.resolution,
    });
    completeTask(task.id);
    return;
  }

  let stillPresent = true;
  try {
    if (!analyzeCalendar) {
      logger.warn('calendar_fix — analyzeCalendar not exported, falling back to status-only check');
    } else {
      const raw = await getCalendarEvents(profile.user.email, issue.event_date, issue.event_date, profile.user.timezone);
      const processed = processCalendarEvents(raw, profile.user.email, profile.user.name, profile.user.timezone);
      const dismissed = getDismissedIssueKeys(profile.user.slack_user_id, issue.event_date, issue.event_date);
      const dayAnalyses = analyzeCalendar(processed, issue.event_date, issue.event_date, profile, dismissed);
      const allIssues: Array<{ type: string; description: string }> = [];
      for (const day of (Array.isArray(dayAnalyses) ? dayAnalyses : [])) {
        for (const i of ((day as any).issues ?? [])) {
          allIssues.push({ type: i.type, description: i.description });
        }
      }
      stillPresent = allIssues.some(i => buildIssueKey(i.type, i.description) === issue.issue_key);
    }
  } catch (err) {
    logger.warn('calendar_fix — re-detection failed, defaulting to re-ping', { err: String(err), issueId: issue.id });
    stillPresent = true;
  }

  if (!stillPresent) {
    updateCalendarIssueStatus(issue.id, 'resolved', 'auto-resolved by calendar_fix task (issue no longer detected)');
    completeTask(task.id);
    logger.info('calendar_fix — issue auto-resolved', { issueId: issue.id });
    return;
  }

  await app.client.chat.postMessage({
    token: bot_token,
    channel: task.owner_channel,
    thread_ts: task.owner_thread_ts ?? undefined,
    text: `Checking back on a calendar issue I flagged — it's still there: ${issue.detail}. Want me to help fix it, or should I let it sit?`,
  });
  // Re-queue: check again in 1 day
  const nextDue = DateTime.now().plus({ days: 1 }).toUTC().toISO()!;
  createTask({
    owner_user_id: task.owner_user_id,
    owner_channel: task.owner_channel,
    owner_thread_ts: task.owner_thread_ts,
    type: 'calendar_fix',
    status: 'new',
    title: task.title,
    due_at: nextDue,
    skill_ref: issue.id,
    context: JSON.stringify({ issue_id: issue.id }),
    who_requested: 'system',
    skill_origin: 'calendar_health',
  });
  completeTask(task.id);
  logger.info('calendar_fix — issue re-pinged, re-queued for tomorrow', {
    issueId: issue.id,
    nextDue,
  });
};
