import { completeTask, markTaskInformed } from '../index';
import type { TaskDispatcher } from './types';

export const dispatchFollowUp: TaskDispatcher = async (app, task, profile, ctx) => {
  const bot_token = profile.assistant.slack.bot_token;
  const message = (ctx.message as string | undefined) ?? `Following up: ${task.title}`;
  await app.client.chat.postMessage({
    token: bot_token,
    channel: task.owner_channel,
    thread_ts: task.owner_thread_ts ?? undefined,
    text: message,
  });
  completeTask(task.id);
  markTaskInformed(task.id);
};
