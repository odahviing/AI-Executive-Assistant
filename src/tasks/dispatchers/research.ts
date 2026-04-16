import { completeTask, markTaskInformed } from '../index';
import { runOrchestrator } from '../../core/orchestrator';
import type { TaskDispatcher } from './types';

export const dispatchResearch: TaskDispatcher = async (app, task, profile, ctx) => {
  const bot_token = profile.assistant.slack.bot_token;
  const researchPrompt =
    (ctx.prompt as string | undefined) ||
    (ctx.message as string | undefined) ||
    task.description ||
    `Research: ${task.title}`;
  const runThreadTs = `research_${task.id}_${Date.now()}`;

  const result = await runOrchestrator({
    userMessage: researchPrompt,
    conversationHistory: [],
    threadTs: runThreadTs,
    channelId: task.owner_channel,
    userId: task.owner_user_id,
    senderRole: 'owner',
    channel: 'slack',
    profile,
    app,
  });

  if (result.reply) {
    await app.client.chat.postMessage({
      token: bot_token,
      channel: task.owner_channel,
      thread_ts: task.owner_thread_ts ?? undefined,
      text: result.reply,
    });
  }

  completeTask(task.id);
  markTaskInformed(task.id);
};
