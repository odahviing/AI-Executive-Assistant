import { completeTask, markTaskInformed } from '../index';
import { runOrchestrator } from '../../core/orchestrator';
import { getConnection } from '../../connections/registry';
import logger from '../../utils/logger';
import type { TaskDispatcher } from './types';

export const dispatchResearch: TaskDispatcher = async (app, task, profile, ctx) => {
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    logger.warn('dispatchResearch — no Slack connection registered', { profileId: profile.user.slack_user_id });
    return;
  }
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
    await conn.postToChannel(task.owner_channel, result.reply, {
      threadTs: task.owner_thread_ts ?? undefined,
    });
  }

  completeTask(task.id);
  markTaskInformed(task.id);
};
