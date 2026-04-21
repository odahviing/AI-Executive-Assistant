import { completeTask, markTaskInformed } from '../index';
import { getConnection } from '../../connections/registry';
import logger from '../../utils/logger';
import type { TaskDispatcher } from './types';

export const dispatchFollowUp: TaskDispatcher = async (_app, task, profile, ctx) => {
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    logger.warn('dispatchFollowUp — no Slack connection registered', { profileId: profile.user.slack_user_id });
    return;
  }
  const message = (ctx.message as string | undefined) ?? `Following up: ${task.title}`;
  await conn.postToChannel(task.owner_channel, message, {
    threadTs: task.owner_thread_ts ?? undefined,
  });
  completeTask(task.id);
  markTaskInformed(task.id);
};
