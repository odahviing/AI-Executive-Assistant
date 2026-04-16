/**
 * Task runner — single 5-minute loop that executes every due task.
 *
 * v1.6.2 split: this file used to carry a ~700-line switch with one case per
 * TaskType. Each dispatcher now lives in `src/tasks/dispatchers/<type>.ts` and
 * is looked up through the registry in `dispatchers/index.ts`. Keeping the
 * runner itself thin makes it possible to add a new task type without
 * touching this file at all.
 *
 * Responsibilities of the runner:
 *   1. Pull due tasks from the DB.
 *   2. Resolve the right profile by owner_user_id.
 *   3. Flip the task to 'in_progress'.
 *   4. Call the dispatcher.
 *   5. On thrown error, mark the task 'failed' and DM the owner a soft apology.
 *
 * Dispatchers own their own terminal state (completeTask / updateTask failed /
 * cancelled / stale). The runner never marks a task complete on their behalf.
 */

import { App } from '@slack/bolt';
import type { UserProfile } from '../config/userProfile';
import { getTasksDueNow, updateTask, type Task } from './index';
import { DISPATCHERS } from './dispatchers';
import logger from '../utils/logger';

export async function runDueTasks(
  app: App,
  profiles: Map<string, UserProfile>,
): Promise<void> {
  const dueTasks = getTasksDueNow();
  if (dueTasks.length === 0) return;

  logger.info('Running due tasks', { count: dueTasks.length });

  for (const task of dueTasks) {
    const profile = [...profiles.values()].find(p => p.user.slack_user_id === task.owner_user_id);
    if (!profile) continue;

    try {
      await executeTask(app, task, profile);
    } catch (err) {
      logger.error('Task execution failed', { err, taskId: task.id, type: task.type });
      updateTask(task.id, { status: 'failed' });
      await app.client.chat.postMessage({
        token: profile.assistant.slack.bot_token,
        channel: task.owner_channel,
        thread_ts: task.owner_thread_ts ?? undefined,
        text: `I couldn't complete "${task.title}" — something went wrong. Want me to try again?`,
      });
    }
  }
}

async function executeTask(app: App, task: Task, profile: UserProfile): Promise<void> {
  const ctx = task.context ? JSON.parse(task.context) as Record<string, unknown> : {};

  updateTask(task.id, { status: 'in_progress' });

  const dispatcher = DISPATCHERS[task.type];
  if (!dispatcher) {
    logger.warn('Unknown task type — skipping', { type: task.type, id: task.id });
    updateTask(task.id, { status: 'failed' });
    return;
  }

  await dispatcher(app, task, profile, ctx);
}
