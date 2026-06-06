/**
 * social_ping_rank_check — RETIRED (v3.2.6).
 *
 * Previously scored engagement_rank 48h after a proactive ping / coda
 * (no reply → −1). That model is gone on two counts: the cold-open ping system
 * was removed (v3.2.5), and an ignored tail-end coda now costs NOTHING
 * ("nothing to lose by ignoring", owner direction). engagement_rank now moves
 * ONLY on a live reply, via `adjustRankFromColleagueResponse` (logEngagement.ts):
 * +1 on an engaged social reply, −1 on an explicit deflection.
 *
 * Nothing schedules this task anymore. This no-op dispatcher stays only to
 * DRAIN any in-flight rows queued before the cutover — completing them cleanly
 * (rather than letting the runner mark an unknown type 'failed', and without
 * applying the retired −1 penalty).
 */

import { completeTask } from '../index';
import logger from '../../utils/logger';
import type { TaskDispatcher } from './types';

export const dispatchSocialPingRankCheck: TaskDispatcher = async (_app, task) => {
  logger.debug('social_ping_rank_check is retired (v3.2.6) — draining as no-op', { taskId: task.id });
  completeTask(task.id);
};
