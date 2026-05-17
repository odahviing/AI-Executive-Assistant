import { completeTask, markTaskInformed, updateTask } from '../index';
import { getDb } from '../../db';
import { runOrchestrator } from '../../core/orchestrator';
import { assessLateness } from '../lateness';
import { sendMorningBriefing } from '../briefs';
import { scrubInternalLeakage } from '../../utils/textScrubber';
import { getConnection } from '../../connections/registry';
import { DateTime } from 'luxon';
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

    if (routine.notify_on_skip === 1) {
      try {
        const conn = getConnection(profile.user.slack_user_id, 'slack');
        if (conn) {
          const nextTs = routine.next_run_at;
          const nextFormatted = nextTs
            ? DateTime.fromISO(nextTs).setZone(profile.user.timezone).toFormat("EEE d MMM 'at' HH:mm")
            : 'when I next catch up';
          await conn.sendDirect(
            profile.user.slack_user_id,
            `Just so you know — your *${routine.title}* routine was due earlier, ` +
            `but by the time it reached the top of the queue it was too late to run it usefully, ` +
            `so I skipped this round. Next one is ${nextFormatted}.`,
          );
        }
      } catch (notifyErr) {
        logger.warn('notify_on_skip DM failed in dispatcher', {
          routineId: routine.id,
          err: String(notifyErr),
        });
      }
    }
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
      // v2.6.5 — same error-detail capture as the user-routine branch below.
      const errMsg = err instanceof Error ? err.message : String(err);
      const lastResult = `Failed: ${errMsg.slice(0, 200).replace(/\s+/g, ' ').trim()}`;
      getDb().prepare(
        `UPDATE routines SET last_result = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(lastResult, routine.id);
      updateTask(task.id, { status: 'failed' });
      return;
    }
    completeTask(task.id);
    markTaskInformed(task.id);
    return;
  }

  // v2.8.5 — placeholder-then-update pattern. Pre-fix the routine ran with a
  // synthesized threadTs (`routine_${id}_${Date.now()}`) so Slack rejected
  // every assistant.threads.setStatus call — the owner never saw "Searching
  // the web" / "Reading the page" during routine tool runs. Now we post a
  // placeholder FIRST, capture its real ts, run the orchestrator threaded
  // under it (status indicator now fires on the real thread), then swap the
  // placeholder for the final content via chat.update (or delete it on a
  // silent return). Fallback to the old synthesized-ts path if the
  // placeholder post itself fails — better degraded than blocked.
  const botToken = profile.assistant.slack.bot_token;
  let placeholderTs: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { postToChannel } = require('../../connections/slack/messaging') as
      typeof import('../../connections/slack/messaging');
    const placeholder = await postToChannel(app, botToken, routine.owner_channel, 'Working…');
    if (placeholder.ok && placeholder.ts) {
      placeholderTs = placeholder.ts;
    } else {
      logger.warn('dispatchRoutine — placeholder post failed, falling back to synthetic threadTs', {
        routineId: routine.id, detail: placeholder.ok ? 'no_ts' : placeholder.reason,
      });
    }
  } catch (err) {
    logger.warn('dispatchRoutine — placeholder post threw, falling back', {
      routineId: routine.id, err: String(err).slice(0, 200),
    });
  }
  const runThreadTs = placeholderTs ?? `routine_${routine.id}_${Date.now()}`;

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messaging = require('../../connections/slack/messaging') as
      typeof import('../../connections/slack/messaging');
    if (!isSilent) {
      if (placeholderTs) {
        // Swap the placeholder for the final content. Same message id, no
        // new notification noise. Slack auto-clears the assistant-panel
        // status indicator on the update.
        const upd = await messaging.updateMessage(
          app, botToken, routine.owner_channel, placeholderTs, cleaned,
        );
        if (!upd.ok) {
          // Update failed — last-resort post a new top-level message so
          // the result isn't lost.
          logger.warn('dispatchRoutine — placeholder update failed, posting fresh message', {
            routineId: routine.id, detail: upd.detail,
          });
          if (conn) await conn.postToChannel(routine.owner_channel, cleaned);
        }
      } else if (conn) {
        // Placeholder path failed earlier — fall back to original behaviour.
        // v2.5.1 — no title prepend. The bot-style "*Routine title*\n..."
        // header read as machine framing. Routines that legitimately want
        // a header have Sonnet write one in the body. Most don't.
        await conn.postToChannel(routine.owner_channel, cleaned);
      } else {
        logger.warn('dispatchRoutine — no Slack connection registered, routine output dropped', { routineId: routine.id });
      }
    } else {
      // Silent return — delete the placeholder so the owner doesn't see a
      // stale "Working…" hanging in their DM. Pre-placeholder we just
      // posted nothing; the new behaviour matches that effective state.
      if (placeholderTs) {
        await messaging.deleteMessage(app, botToken, routine.owner_channel, placeholderTs);
      }
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
    // v2.8.5 — clean up the placeholder so the owner doesn't see a stale
    // "Working…" forever when the routine throws.
    if (placeholderTs) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { deleteMessage } = require('../../connections/slack/messaging') as
          typeof import('../../connections/slack/messaging');
        await deleteMessage(app, botToken, routine.owner_channel, placeholderTs);
      } catch (_) { /* best effort */ }
    }
    // v2.6.5 — capture the actual error message in last_result instead of the
    // bare string 'Failed'. Pre-fix, when the owner asked "what went wrong
    // with the routine?", Maelle could only say "the last result shows
    // 'Failed'" — no diagnostic detail. Now last_result carries up to 200
    // chars of the error so she has something concrete to share.
    const errMsg = err instanceof Error ? err.message : String(err);
    const lastResult = `Failed: ${errMsg.slice(0, 200).replace(/\s+/g, ' ').trim()}`;
    getDb().prepare(
      `UPDATE routines SET last_result = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(lastResult, routine.id);
    updateTask(task.id, { status: 'failed' });
  }
};
