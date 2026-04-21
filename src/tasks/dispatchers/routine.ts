import { completeTask, markTaskInformed, updateTask } from '../index';
import { getDb } from '../../db';
import { runOrchestrator } from '../../core/orchestrator';
import { assessLateness } from '../lateness';
import { sendMorningBriefing } from '../briefs';
import { scrubInternalLeakage } from '../../utils/textScrubber';
import { getConnection } from '../../connections/registry';
import type { Routine } from '../crons';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * Materialized firing of a routine (v1.5.1).
 * The cadence-based lateness policy decides whether to run or skip. No more
 * "I was offline at X, run now or skip?" DMs.
 */
export const dispatchRoutine: TaskDispatcher = async (app, task, profile, ctx) => {
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

    const rawReply = result.reply ?? '';
    // v2.0.2 — scrub first, then decide silence. SlackConnection auto-applies
    // Slack-specific formatting + scrubbing; we scrub here too so the silence
    // check sees the post-scrub text (a reply that was "only internal leakage"
    // becomes empty and shouldn't post a lonely "*Routine title*" header).
    const cleaned = rawReply ? scrubInternalLeakage(rawReply) : '';
    const isSilent = cleaned.trim().length === 0;

    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (!isSilent) {
      if (conn) {
        await conn.postToChannel(routine.owner_channel, `*${routine.title}*\n${cleaned}`);
      } else {
        logger.warn('dispatchRoutine — no Slack connection registered, routine output dropped', { routineId: routine.id });
      }
    } else {
      logger.info('Routine completed silently (no message sent to owner)', {
        taskId: task.id,
        routineId: routine.id,
        routineTitle: routine.title,
        scheduledAt,
        replyPreview: rawReply ? rawReply.slice(0, 120) : '(empty)',
        scrubbedEmpty: !!rawReply && cleaned.length === 0,
      });
    }

    const summary = isSilent ? 'No issues found' : cleaned.slice(0, 300);
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
