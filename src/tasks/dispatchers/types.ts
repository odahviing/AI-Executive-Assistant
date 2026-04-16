/**
 * Dispatcher signature (v1.6.2 split).
 *
 * Every task type has its own dispatcher file. The runner's main switch is
 * replaced by a map keyed on TaskType; each entry is a function with this
 * exact signature. Keeps the 700-line switch from all living in runner.ts.
 *
 * Dispatchers own their own lifecycle — they must call completeTask or
 * updateTask({ status: 'failed' | 'cancelled' | 'stale' }) before returning.
 * The runner won't mark the task complete on their behalf.
 */

import type { App } from '@slack/bolt';
import type { UserProfile } from '../../config/userProfile';
import type { Task } from '../index';

export type TaskDispatcher = (
  app: App,
  task: Task,
  profile: UserProfile,
  ctx: Record<string, unknown>,
) => Promise<void>;
