import { completeTask, markTaskInformed, updateTask } from '../index';
import { getDb, appendToConversation } from '../../db';
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
 * Leading glyph for a routine's owner-facing post, so scheduled/automatic
 * threads read as distinct from the owner's OWN conversations (which never
 * route through here). The calendar-health system thread gets its own icon;
 * every other cron shares the general automation glyph. The morning briefing
 * is NOT here — it posts via sendMorningBriefing with its own icon.
 */
function routineIcon(routine: Routine): string {
  if ((routine.prompt ?? '').includes('check_calendar_health')) return '🩺';
  return '🔁';
}

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

  // Piece 2 — ONE Connection for every outbound send in this dispatcher. A task
  // dispatcher posts through the transport-neutral Connection interface, never
  // a transport module directly; resolved once here so the skip notice, the
  // progress placeholder and the final post cannot drift onto different paths.
  const conn = getConnection(profile.user.slack_user_id, 'slack');

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
  // placeholder for the final content (or retract it on a silent return).
  // Fallback to the old synthesized-ts path if the placeholder post itself
  // fails — better degraded than blocked. All three steps — post, replace,
  // retract — go through the Connection resolved above; this dispatcher holds
  // no transport handle of its own.
  let placeholderTs: string | undefined;
  try {
    // Piece 2 — the placeholder is an outbound SEND, so it goes through the
    // Connection like every other send here. SendResult already carries the
    // message ref (`ts`), which is all the threading below needs. No
    // connection registered → no placeholder, and the synthetic-threadTs
    // fallback right below carries the run (better than a "Working…" nobody
    // can ever replace).
    const placeholder = await conn?.postToChannel(routine.owner_channel, 'Working…');
    if (placeholder?.ok && placeholder.ts) {
      placeholderTs = placeholder.ts;
    } else {
      logger.warn('dispatchRoutine — placeholder post failed, falling back to synthetic threadTs', {
        routineId: routine.id,
        detail: !placeholder ? 'no_connection' : placeholder.ok ? 'no_ts' : placeholder.reason,
      });
    }
  } catch (err) {
    logger.warn('dispatchRoutine — placeholder post threw, falling back', {
      routineId: routine.id, err: String(err).slice(0, 200),
    });
  }
  const runThreadTs = placeholderTs ?? `routine_${routine.id}_${Date.now()}`;

  // v3.0.2 — wrap user-routine prompts with a context preamble so Sonnet
  // opens her reply with a short line naming what this is from. Pre-fix the
  // owner saw long brainstorm dumps (e.g. weekly LinkedIn content ideas)
  // with no header — couldn't tell which routine fired. v2.5.1 dropped the
  // old bold-title prepend as machine framing; this restores context via
  // Sonnet's own voice. System routines (briefing, calendar health) already
  // self-narrate, so they keep their prompt unchanged.
  const wrappedPrompt = routine.is_system
    ? routine.prompt
    : `[This is the scheduled firing of your "${routine.title}" routine. ` +
      `Open your reply with one short conversational line naming what this is from ` +
      `(e.g. "From this week's LinkedIn ideas routine:" — your phrasing, your voice), ` +
      `then the content. Don't bold it, don't use a header — just a natural opener.]\n\n` +
      routine.prompt;

  try {
    const result = await runOrchestrator({
      userMessage: wrappedPrompt,
      conversationHistory: [],
      threadTs: runThreadTs,
      channelId: routine.owner_channel,
      userId: routine.owner_user_id,
      senderRole: 'owner',
      // v4.4.x (#154) — a scheduled routine firing is always a private
      // owner-alone run, never a live conversation. Declared explicitly now
      // that the fields are required (core/orchestrator/index.ts OrchestratorInput).
      authority: 'owner',
      surface: 'owner_dm',
      channel: 'slack',
      interactive: false,  // v3.2.6 (6.4) — scheduled report, not a conversation: no social coda
      profile,
      app,
    });

    const rawReply = result.reply ?? '';
    // v2.0.2 — scrub first, then decide silence. SlackConnection auto-applies
    // Slack-specific formatting + scrubbing; we scrub here too so the silence
    // check sees the post-scrub text (a reply that was "only internal leakage"
    // becomes empty and shouldn't post a lonely "*Routine title*" header).
    const cleaned = rawReply ? scrubInternalLeakage(rawReply) : '';
    // v3.1.2 (#118) — code-deterministic silence override. When the only
    // substantive thing this routine did was a vacuous calendar-health check
    // (no issues, no auto-fixes, no booking, no mutations), suppress the
    // post regardless of what Sonnet wrote. The routine prompt already says
    // "stay silent if nothing to report" but Sonnet kept narrating "all clear,
    // nothing flagged" anyway — same prompt-drift class as bug D. Hard guard
    // here. Owner-asked check_calendar_health calls don't reach this code
    // path (they go through the chat dispatcher), so they keep replying so
    // the owner can verify "all good".
    const vacuousRoutineRun =
      result.healthCheckVacuous === true &&
      !result.bookingOccurred &&
      (!result.mutationActions || result.mutationActions.length === 0);
    const isSilent = vacuousRoutineRun || cleaned.trim().length === 0;

    // v3.2.x — DIAGNOSTIC (not a fix). The silent path only logged on silence,
    // so a "morning health didn't arrive" couldn't be told apart from "it
    // sent and you missed it". Log the FULL send/silence decision on EVERY
    // firing with the exact inputs, so the next occurrence is self-explaining:
    // did it send or stay silent, and precisely why (vacuous health run vs a
    // reply that scrubbed to empty vs Sonnet produced nothing).
    logger.info('Routine reply decision', {
      routineId: routine.id,
      routineTitle: routine.title,
      isSilent,
      reason: isSilent
        ? (vacuousRoutineRun ? 'vacuous_health_run' : (rawReply.trim().length === 0 ? 'empty_reply_from_orchestrator' : 'scrubbed_to_empty'))
        : 'sending',
      vacuousRoutineRun,
      healthCheckVacuous: result.healthCheckVacuous === true,
      bookingOccurred: result.bookingOccurred === true,
      mutationActions: result.mutationActions?.length ?? 0,
      rawReplyLen: rawReply.length,
      cleanedLen: cleaned.trim().length,
    });

    if (!isSilent) {
      // Icon on the automatic thread so it reads distinct from the owner's own
      // DMs (which never route through dispatchRoutine). Health = its own glyph;
      // every other cron shares the general one. The briefing isn't here — it
      // posts via sendMorningBriefing with its own icon.
      const decorated = `${routineIcon(routine)} ${cleaned}`;
      // The ts of the message the owner actually ends up looking at — the one
      // his reply threads under. The placeholder EDIT keeps the placeholder's
      // ts; both fallbacks mint a new one. Captured because the reply-history
      // record below has to be keyed on the thread he'll reply into, not on
      // the ts we happened to run the orchestrator under.
      let deliveredTs: string | undefined;
      if (placeholderTs) {
        // Swap the placeholder for the final content. Same message id, no new
        // notification noise. Slack auto-clears the assistant-panel status
        // indicator on the update. Going through the Connection is what applies
        // the transport's outbound formatting to this text — the direct-module
        // call it replaced skipped it, so routine output reached the owner as
        // raw markdown on the path that almost always runs.
        // `updateMessage` is optional on the interface: a transport without an
        // edit primitive returns undefined here and degrades exactly like a
        // failed edit — the fresh post below carries the result either way.
        const upd = await conn?.updateMessage?.(routine.owner_channel, placeholderTs, decorated);
        if (!upd || !upd.ok) {
          // No edit verb, or the edit failed — last-resort post a new top-level
          // message so the result isn't lost.
          logger.warn('dispatchRoutine — placeholder update failed, posting fresh message', {
            routineId: routine.id, detail: upd ? upd.detail : 'no_update_verb',
          });
          const fresh = conn ? await conn.postToChannel(routine.owner_channel, decorated) : undefined;
          if (fresh && fresh.ok) deliveredTs = fresh.ts;
        } else {
          // Edit landed — the message still lives at the placeholder's ts.
          deliveredTs = upd.ts ?? placeholderTs;
        }
      } else if (conn) {
        // Placeholder path failed earlier — fall back to original behaviour.
        // v2.5.1 — no title prepend. The bot-style "*Routine title*\n..."
        // header read as machine framing. Routines that legitimately want
        // a header have Sonnet write one in the body. Most don't.
        const fresh = await conn.postToChannel(routine.owner_channel, decorated);
        if (fresh.ok) deliveredTs = fresh.ts;
      } else {
        logger.warn('dispatchRoutine — no Slack connection registered, routine output dropped', { routineId: routine.id });
      }

      // A routine ASKS things ("which category?", "want me to move it?"), and the
      // owner answers by replying in this thread. Pre-fix nothing wrote that
      // question to `conversations`, so processMessage's getConversationHistory
      // came back EMPTY and Maelle answered his reply with no idea what she had
      // just asked (2026-07-26 10:01, threadTs 1785060015.621749 —
      // `historyLength:0` on a reply to the health routine's own question).
      //
      // Thread memory is thread memory: the SAME appendToConversation the
      // interactive path uses (postReply.ts:407 for the assistant turn), keyed on
      // the ts the owner replies under. No `user` row is invented — a scheduled
      // post has no inbound, and every other place Maelle speaks unprompted
      // records exactly one assistant row too (handlers.ts:339 summary draft,
      // :860 reaction resolve, coordinator.ts:343, meetingReschedule.ts:268).
      // The bracketed label rides that same convention so the next turn knows
      // this was a scheduled post and not an answer to something he said.
      // Stored WITHOUT the glyph — that is transport decoration, and the
      // interactive path stores the undecorated draft too.
      if (deliveredTs) {
        appendToConversation(deliveredTs, routine.owner_channel, {
          role: 'assistant',
          content: `[Scheduled routine: ${routine.title}]\n${cleaned}`,
        });
      }
    } else {
      // Silent return — delete the placeholder so the owner doesn't see a
      // stale "Working…" hanging in their DM. Pre-placeholder we just
      // posted nothing; the new behaviour matches that effective state.
      if (placeholderTs) {
        // Best-effort retract, same as before: no branch on the outcome, and a
        // transport without a delete primitive simply leaves it standing.
        await conn?.deleteMessage?.(routine.owner_channel, placeholderTs);
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
        await conn?.deleteMessage?.(routine.owner_channel, placeholderTs);
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
