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
    const jobId = ctx.job_id ?? task.skill_ref;
    if (!colleagueSlackId || !jobId) {
      logger.warn('social_ping_rank_check: missing context, skipping', { taskId: task.id });
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
