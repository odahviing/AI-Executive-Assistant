/**
 * Rank-check feedback loop for proactive social pings (v2.2).
 *
 * Scheduled 48h after a proactive ping via `social_outreach_tick`. Checks
 * the matching outreach_jobs row to determine whether the colleague replied:
 *
 *   - No reply at all         → adjustEngagementRank(-1, 'no_reply_to_ping')
 *   - Brief reply (≤30 chars)  → no delta (still engaging, just not chatty)
 *   - Engaged reply (>30)      → adjustEngagementRank(+1, 'reply_engaged')
 *
 * Rank clamped to [0, 3] inside adjustEngagementRank. Repeated no-replies
 * drift the colleague toward rank 0, at which point the outreach tick stops
 * considering them until they initiate contact themselves.
 */

import { completeTask } from '../index';
import { getDb, adjustEngagementRank } from '../../db';
import logger from '../../utils/logger';
import type { TaskDispatcher } from './types';

const BRIEF_REPLY_CHAR_LIMIT = 30;

export const dispatchSocialPingRankCheck: TaskDispatcher = async (_app, task) => {
  try {
    const ctx = (() => {
      try { return JSON.parse(task.context || '{}') as Record<string, string>; } catch { return {}; }
    })();
    const colleagueSlackId = ctx.colleague_slack_id;
    if (!colleagueSlackId) {
      logger.warn('social_ping_rank_check: missing colleague_slack_id, skipping', { taskId: task.id });
      return;
    }

    // v2.3.2 (C2) — coda kind. Cold-DM pings (existing) read outreach_jobs.
    // Codas don't create an outreach_jobs row; instead we compare
    // people_memory.last_social_at vs the coda timestamp. If the person
    // hasn't engaged socially in the 48h window → -1.
    if (ctx.kind === 'coda') {
      const codaAtIso = ctx.coda_at_iso;
      if (!codaAtIso) {
        logger.warn('social_ping_rank_check (coda): missing coda_at_iso, skipping', { taskId: task.id });
        return;
      }
      const db = getDb();
      const row = db.prepare(`
        SELECT last_social_at, last_initiated_at FROM people_memory WHERE slack_id = ?
      `).get(colleagueSlackId) as { last_social_at?: string; last_initiated_at?: string } | undefined;
      if (!row) {
        logger.warn('social_ping_rank_check (coda): person row not found', { colleagueSlackId });
        return;
      }
      const lastSocialMs = row.last_social_at ? new Date(row.last_social_at).getTime() : 0;
      const codaMs = new Date(codaAtIso).getTime();
      // Engaged if last_social_at moved AFTER the coda fired AND it wasn't
      // Maelle herself bumping it (recordSocialMoment with maelle also moves
      // last_social_at). Conservative check: last_social_at strictly greater
      // than the coda timestamp by some margin (5 min) is the colleague
      // genuinely engaging.
      const engaged = lastSocialMs > codaMs + 5 * 60 * 1000;
      if (!engaged) {
        adjustEngagementRank(colleagueSlackId, -1, 'no_social_response_to_coda');
        logger.info('social_ping_rank_check (coda): no social engagement, rank -1', {
          colleague_slack_id: colleagueSlackId, coda_at: codaAtIso,
        });
      } else {
        logger.info('social_ping_rank_check (coda): person engaged socially, no rank change', {
          colleague_slack_id: colleagueSlackId, coda_at: codaAtIso, last_social_at: row.last_social_at,
        });
      }
      return;
    }

    // Default — cold-DM ping path (existing behavior, outreach_jobs based).
    const jobId = ctx.job_id ?? task.skill_ref;
    if (!jobId) {
      logger.warn('social_ping_rank_check: missing job_id, skipping', { taskId: task.id });
      return;
    }

    const db = getDb();
    const job = db.prepare(`
      SELECT status, reply_text FROM outreach_jobs WHERE id = ?
    `).get(jobId) as { status: string; reply_text?: string } | undefined;

    if (!job) {
      logger.warn('social_ping_rank_check: outreach_job not found', { jobId });
      return;
    }

    if (job.status !== 'replied' || !job.reply_text) {
      // No reply → rank drifts down.
      adjustEngagementRank(colleagueSlackId, -1, 'no_reply_to_ping');
      logger.info('social_ping_rank_check: no reply, rank -1', {
        colleague_slack_id: colleagueSlackId, jobId,
      });
      return;
    }

    const replyLen = job.reply_text.trim().length;
    if (replyLen > BRIEF_REPLY_CHAR_LIMIT) {
      adjustEngagementRank(colleagueSlackId, 1, 'reply_engaged');
      logger.info('social_ping_rank_check: engaged reply, rank +1', {
        colleague_slack_id: colleagueSlackId, replyLen,
      });
    } else {
      // Brief reply — no delta, just log for audit
      logger.info('social_ping_rank_check: brief reply, rank unchanged', {
        colleague_slack_id: colleagueSlackId, replyLen,
      });
    }
  } finally {
    completeTask(task.id);
  }
};
