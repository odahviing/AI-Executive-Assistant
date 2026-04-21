import { completeTask, markTaskInformed } from '../index';
import { logEvent } from '../../db';
import { getConnection } from '../../connections/registry';
import logger from '../../utils/logger';
import type { TaskDispatcher } from './types';

export const dispatchReminder: TaskDispatcher = async (_app, task, profile, ctx) => {
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    logger.warn('dispatchReminder — no Slack connection registered', { profileId: profile.user.slack_user_id });
    return;
  }
  const targetId = ctx.target_slack_id as string | undefined;
  const message = (ctx.message as string | undefined) || task.description || task.title;

  if (targetId && targetId !== profile.user.slack_user_id) {
    // Remind someone else — DM them, then report back to owner.
    await conn.sendDirect(targetId, message);
    await conn.postToChannel(
      task.owner_channel,
      `Done, sent the reminder to ${(ctx.target_name as string | undefined) ?? 'them'}.`,
      { threadTs: task.owner_thread_ts ?? undefined },
    );
  } else {
    // Remind the owner
    await conn.postToChannel(task.owner_channel, message, {
      threadTs: task.owner_thread_ts ?? undefined,
    });
  }

  logEvent({
    ownerUserId: task.owner_user_id,
    type: 'task_update',
    title: task.title,
    detail: (ctx.message as string | undefined) ?? task.description,
    refId: task.id,
  });
  completeTask(task.id);
  markTaskInformed(task.id);
};
