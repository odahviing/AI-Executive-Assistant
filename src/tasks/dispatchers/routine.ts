import { completeTask, markTaskInformed, updateTask } from '../index';
import { getDb } from '../../db';
import { runOrchestrator } from '../../core/orchestrator';
import { assessLateness } from '../lateness';
import { sendMorningBriefing } from '../briefs';
import { normalizeSlackText } from '../../utils/slackFormat';
import type { Routine } from '../crons';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * Materialized firing of a routine (v1.5.1).
 * The cadence-based lateness policy decides whether to run or skip. No more
 * "I was offline at X, run now or skip?" DMs.
 */
export const dispatchRoutine: TaskDispatcher = async (app, task, profile, ctx) => {
  const bot_token = profile.assistant.slack.bot_token;

  if (!task.routine_id) {
    logger.warn('Routine task has no routine_id — failing', { taskId: task.id });
    updateTask(task.id, { status: 'failed' });
    return;
  }

  const routine = getDb().prepare(
    `SELECT * FROM routines WHERE id = ?`
  ).get(task.routine_id) as Routine | undefined;

  if (!routine) {
    logger.warn('Routine task references missing routine — failing', {
      taskId: task.id,
      routineId: task.routine_id,
    });
    updateTask(task.id, { status: 'failed' });
    return;
  }

  if (routine.status !== 'active') {
    logger.info('Routine paused/deleted since task was queued — cancelling task', {
      taskId: task.id,
      routineId: routine.id,
      routineStatus: routine.status,
    });
    updateTask(task.id, { status: 'cancelled' });
    return;
  }

  const scheduledAt = (ctx.scheduled_at as string | undefined) || task.due_at || task.created_at;
  const verdict = assessLateness({ routine, scheduledAtIso: scheduledAt });
  if (!verdict.run) {
    logger.info('Routine task skipped — past lateness threshold', {
      taskId: task.id,
      routineId: routine.id,
      title: routine.title,
      latenessMinutes: verdict.latenessMinutes,
      reason: verdict.reason,
    });
    updateTask(task.id, { status: 'stale' });
    getDb().prepare(
      `UPDATE routines SET last_result = @res, updated_at = datetime('now') WHERE id = @id`
    ).run({ id: routine.id, res: `Skipped (${verdict.reason})` });
    return;
  }

  // System briefing cron is a special prompt sentinel
  if (routine.is_system && routine.prompt === '__system_briefing__') {
    try {
      await sendMorningBriefing(app, profile, routine.owner_channel);
      getDb().prepare(
        `UPDATE routines SET last_run_at = datetime('now'), run_count = run_count + 1, last_result = 'Briefing sent', updated_at = datetime('now') WHERE id = ?`
      ).run(routine.id);
    } catch (err) {
      logger.error('System briefing from routine task failed', { err, routineId: routine.id });
      getDb().prepare(
        `UPDATE routines SET last_result = 'Failed', updated_at = datetime('now') WHERE id = ?`
      ).run(routine.id);
      updateTask(task.id, { status: 'failed' });
      return;
    }
    completeTask(task.id);
    markTaskInformed(task.id);
    return;
  }

  // User-created routine — run through orchestrator
  const runThreadTs = `routine_${routine.id}_${Date.now()}`;

  try {
    const result = await runOrchestrator({
      userMessage: routine.prompt,
      conversationHistory: [],
      threadTs: runThreadTs,
      channelId: routine.owner_channel,
      userId: routine.owner_user_id,
      senderRole: 'owner',
      channel: 'slack',
      profile,
      app,
    });

    const isSilent = !result.reply || result.reply.trim().toUpperCase() === 'NO_ISSUES';

    if (!isSilent) {
      await app.client.chat.postMessage({
        token: bot_token,
        channel: routine.owner_channel,
        text: `*${routine.title}*\n${normalizeSlackText(result.reply)}`,
      });
    }

    const summary = isSilent ? 'No issues found' : result.reply.slice(0, 300);
    getDb().prepare(
      `UPDATE routines SET last_run_at = datetime('now'), run_count = run_count + 1, last_result = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(summary, routine.id);

    completeTask(task.id);
    if (!isSilent) markTaskInformed(task.id);
  } catch (err) {
    logger.error('Routine orchestrator run failed', { err, routineId: routine.id });
    getDb().prepare(
      `UPDATE routines SET last_result = 'Failed', updated_at = datetime('now') WHERE id = ?`
    ).run(routine.id);
    updateTask(task.id, { status: 'failed' });
  }
};
