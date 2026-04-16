import { completeTask, markTaskInformed } from '../index';
import { logEvent } from '../../db';
import type { TaskDispatcher } from './types';

export const dispatchReminder: TaskDispatcher = async (app, task, profile, ctx) => {
  const bot_token = profile.assistant.slack.bot_token;
  const targetId = ctx.target_slack_id as string | undefined;
  const message = (ctx.message as string | undefined) || task.description || task.title;

  if (targetId && targetId !== profile.user.slack_user_id) {
    // Remind someone else — DM them, then report back to owner.
    const dmResult = await app.client.conversations.open({ token: bot_token, users: targetId });
    const dmChannel = (dmResult.channel as any)?.id;
    await app.client.chat.postMessage({
      token: bot_token,
      channel: dmChannel,
      text: message,
    });
    await app.client.chat.postMessage({
      token: bot_token,
      channel: task.owner_channel,
      thread_ts: task.owner_thread_ts ?? undefined,
      text: `Done — sent the reminder to ${(ctx.target_name as string | undefined) ?? 'them'}.`,
    });
  } else {
    // Remind the owner
    await app.client.chat.postMessage({
      token: bot_token,
      channel: task.owner_channel,
      thread_ts: task.owner_thread_ts ?? undefined,
      text: message,
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
