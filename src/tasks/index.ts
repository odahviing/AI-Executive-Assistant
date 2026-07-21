import { getDb } from '../db';
import logger from '../utils/logger';
import type { Task, TaskType, TaskStatus } from './types';

export type { Task, TaskType, TaskStatus } from './types';

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createTask(params: Omit<Task, 'id' | 'created_at' | 'updated_at'>): string {
  const db = getDb();
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO tasks (
      id, owner_user_id, owner_channel, owner_thread_ts,
      type, status, title, description, due_at, skill_ref, context,
      who_requested, pending_on, created_context, routine_id, skill_origin,
      target_slack_id, target_name
    ) VALUES (
      @id, @owner_user_id, @owner_channel, @owner_thread_ts,
      @type, @status, @title, @description, @due_at, @skill_ref, @context,
      @who_requested, @pending_on, @created_context, @routine_id, @skill_origin,
      @target_slack_id, @target_name
    )
  `).run({
    id,
    owner_user_id: params.owner_user_id,
    owner_channel: params.owner_channel,
    owner_thread_ts: params.owner_thread_ts ?? null,
    type: params.type,
    status: params.status,
    title: params.title,
    description: params.description ?? null,
    due_at: params.due_at ?? null,
    skill_ref: params.skill_ref ?? null,
    context: typeof params.context === 'string' ? params.context : JSON.stringify(params.context),
    who_requested: params.who_requested ?? 'system',
    pending_on: params.pending_on ?? null,
    created_context: params.created_context ?? null,
    routine_id: params.routine_id ?? null,
    skill_origin: params.skill_origin ?? null,
    target_slack_id: params.target_slack_id ?? null,
    target_name: params.target_name ?? null,
  });
  // The recurring system tick (social_decay) self-rearms every 7 days. Its
  // creation is deterministic from the dispatcher's own behavior — logging it
  // adds zero signal and floods the live log. Skip entirely. Everything
  // user-facing (reminders, follow-ups, outreach, coord) stays at info.
  const isSystemTick = params.type === 'social_decay';
  if (!isSystemTick) {
    logger.info('Task created', {
      id,
      type: params.type,
      title: params.title,
      skill_origin: params.skill_origin,
      skill_ref: params.skill_ref,
      due_at: params.due_at,
      status: params.status,
      target_slack_id: params.target_slack_id,
    });
  }
  // v2.6.5 (Bug 8.3) — when a task is created already in `completed` status
  // (outreach skill does this for fire-and-forget non-await sends), still
  // fire the ✅-on-Maelle's-last-message hook. Pre-fix the hook only fired
  // from completeTask(), so direct create-with-completed bypassed it. Owner
  // saw "Done!" replies with no ✅ on direct booking + outreach-send turns.
  if (params.status === 'completed' && params.owner_thread_ts && params.owner_user_id) {
    fireCompletionReact(params.owner_user_id, params.owner_thread_ts, id);
  }
  return id;
}

/**
 * v2.6.5 — fire-and-forget react ✅ on Maelle's most recent message in the
 * task's thread. Extracted so both completeTask() and createTask(status=
 * 'completed') trigger the same behavior. Wrapped in setImmediate so DB
 * operations return to the caller without waiting on Slack API. Failures
 * are non-fatal.
 */
function fireCompletionReact(ownerUserId: string, ownerThreadTs: string, taskId: string): void {
  setImmediate(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getLastMaelleMessage } = require('../utils/threadActivity') as typeof import('../utils/threadActivity');
      const msg = getLastMaelleMessage(ownerThreadTs);
      if (!msg) return;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConnection } = require('../connections/registry') as typeof import('../connections/registry');
      const conn = getConnection(ownerUserId, 'slack');
      if (conn?.reactToMessage) {
        await conn.reactToMessage(msg.channelId, msg.messageTs, 'white_check_mark');
      }
    } catch (err) {
      logger.warn('completion react ✅ failed — non-fatal', { taskId, err: String(err).slice(0, 200) });
    }
  });
}

export function updateTask(id: string, updates: Partial<Omit<Task, 'id' | 'created_at'>>): void {
  const db = getDb();
  const fields = Object.keys(updates)
    .filter(k => k !== 'id' && k !== 'created_at')
    .map(k => `${k} = @${k}`)
    .join(', ');
  if (!fields) return;
  const params: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(updates)) {
    params[k] = k === 'context' && typeof v === 'object' ? JSON.stringify(v) : (v ?? null);
  }
  db.prepare(`UPDATE tasks SET ${fields}, updated_at = datetime('now') WHERE id = @id`).run(params);
}

/**
 * Returns active tasks linked to a specific thread, plus active outreach
 * jobs whose owner_thread_ts matches. Used to inject thread context into the system
 * prompt so Maelle knows what she already committed to in this conversation.
 */
export function getActiveJobsForThread(ownerUserId: string, threadTs: string): {
  tasks: Task[];
  outreachJobs: import('../db').OutreachJob[];
} {
  const db = getDb();

  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE owner_user_id = ?
    AND owner_thread_ts = ?
    AND status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
  `).all(ownerUserId, threadTs) as Task[];

  const outreachJobs = db.prepare(`
    SELECT * FROM outreach_jobs
    WHERE owner_user_id = ?
    AND owner_thread_ts = ?
    AND status NOT IN ('replied', 'cancelled', 'no_response')
    ORDER BY created_at DESC
  `).all(ownerUserId, threadTs) as import('../db').OutreachJob[];

  return { tasks, outreachJobs };
}

export function markTaskInformed(id: string): void {
  const db = getDb();
  db.prepare(`UPDATE tasks SET status = 'informed', updated_at = datetime('now') WHERE id = ?`).run(id);
}

export function getTasksDueNow(): Task[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('new', 'pending_colleague')
    AND due_at IS NOT NULL
    AND datetime(due_at) <= datetime('now')
  `).all() as Task[];
}

export function completeTask(id: string): void {
  // v2.6.5 — read the task BEFORE updating so we can react ✅ on the most
  // recent Maelle message in its thread. Using the task system as the source
  // of truth for "activity complete" replaces the v2.6.2 unconditional react
  // in postReply.ts. Tasks created without an owner_thread_ts (system tasks,
  // background routines) skip silently — nothing to react on.
  // Bug 8.3 fix: react logic extracted to fireCompletionReact() so
  // createTask(status='completed') also triggers it, not just this path.
  const before = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task | undefined;
  updateTask(id, { status: 'completed', completed_at: new Date().toISOString() });
  if (before?.owner_thread_ts && before.owner_user_id) {
    fireCompletionReact(before.owner_user_id, before.owner_thread_ts, id);
  }
}

