import { getDb } from '../db';
import { getActiveOutreachForThread } from '../db/jobs';
import { reactActivityComplete } from '../utils/threadActivity';
import { DISPATCHERS } from './dispatchers';
import logger from '../utils/logger';
import type { Task } from './types';

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
  // gh#198 — the recurring system tick this suppressed (social_decay,
  // self-rearming every 7 days) is gone; every remaining task type is
  // user-facing, so task creation always logs now.
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
  // v4.2.x — the create-with-status='completed' react hook that used to sit here
  // went with its only caller. message_colleague was the one path that created a
  // task already completed (fire-and-forget send) purely to trigger the ✅ tick;
  // it now calls reactActivityComplete directly and mints no row. Every remaining
  // createTask caller opens with status='new', so a completed-on-create task is
  // no longer reachable.
  return id;
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

  // Only types with a live dispatcher can ever leave these statuses — a type
  // whose dispatcher was removed (e.g. 'coordination', retired 3.5.0) is a
  // stranded timer: nothing will ever execute or complete it, so a row stuck
  // in pending_colleague from before the removal would otherwise render as
  // "ACTIVE IN THIS THREAD — you already committed to these" forever
  // (buildTurnContext.ts). Bound the query to DISPATCHERS' keys — the same
  // canonical live-type set the runner itself dispatches against — instead of
  // naming retired types one at a time.
  const liveTypes = Object.keys(DISPATCHERS);
  const placeholders = liveTypes.map(() => '?').join(', ');
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE owner_user_id = ?
    AND owner_thread_ts = ?
    AND status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
    AND type IN (${placeholders})
  `).all(ownerUserId, threadTs, ...liveTypes) as Task[];

  // #41 — "is this outreach still open?" is a question about its REQUEST, and it
  // is asked in exactly one place (db/jobs.ts). This is the most consequential
  // caller: what comes back is injected into the system prompt as "ACTIVE IN THIS
  // THREAD — you already committed to these" on every owner turn
  // (core/orchestrator/buildTurnContext.ts:356), so a row that is finished but
  // reads as live is fed to the model as a live commitment.
  const outreachJobs = getActiveOutreachForThread(ownerUserId, threadTs);

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
  const before = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task | undefined;
  updateTask(id, { status: 'completed', completed_at: new Date().toISOString() });
  if (before?.owner_thread_ts && before.owner_user_id) {
    reactActivityComplete(before.owner_user_id, before.owner_thread_ts, id);
  }
}

