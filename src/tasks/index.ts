import { getDb } from '../db';
import { DateTime } from 'luxon';
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
      who_requested, pending_on, created_context, routine_id, skill_origin
    ) VALUES (
      @id, @owner_user_id, @owner_channel, @owner_thread_ts,
      @type, @status, @title, @description, @due_at, @skill_ref, @context,
      @who_requested, @pending_on, @created_context, @routine_id, @skill_origin
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
  });
  logger.info('Task created', {
    id,
    type: params.type,
    title: params.title,
    skill_origin: params.skill_origin,
    skill_ref: params.skill_ref,
    due_at: params.due_at,
    status: params.status,
  });
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

export function getTask(id: string): Task | null {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null;
}

export function getOpenTasksForOwner(ownerUserId: string): Task[] {
  const db = getDb();
  // v1.6.8 — include 'completed' so fire-and-forget tasks (e.g.
  // message_colleague with await_reply=false) stay visible until the owner
  // is actually informed about them. The completed → informed transition is
  // the existing two-step: `completed` = action happened, `informed` = owner
  // has seen it reported. A "what's on your plate" question counts as the
  // moment of informing for briefings/catch-ups — once a task is surfaced,
  // the runner or briefing flow flips it to 'informed' and it drops off.
  return db.prepare(`
    SELECT * FROM tasks
    WHERE owner_user_id = ?
    AND who_requested != 'system'
    AND status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague', 'completed')
    ORDER BY due_at ASC, created_at ASC
  `).all(ownerUserId) as Task[];
}

/**
 * Returns active tasks for a specific person (by who_requested).
 * Also includes completed/failed tasks from the last 24 hours.
 * Used to inject context when a colleague DMs Maelle.
 */
export function getTasksForPerson(personSlackId: string): Task[] {
  const db = getDb();
  const oneDayAgo = DateTime.now().minus({ hours: 24 }).toUTC().toISO()!;
  return db.prepare(`
    SELECT * FROM tasks
    WHERE who_requested = ?
    AND (
      status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
      OR (status IN ('completed', 'informed', 'failed') AND updated_at >= ?)
    )
    ORDER BY created_at DESC
    LIMIT 20
  `).all(personSlackId, oneDayAgo) as Task[];
}

/**
 * Returns active tasks linked to a specific thread, plus active coordination/outreach
 * jobs whose owner_thread_ts matches. Used to inject thread context into the system
 * prompt so Maelle knows what she already committed to in this conversation.
 */
export function getActiveJobsForThread(ownerUserId: string, threadTs: string): {
  tasks: Task[];
  coordJobs: import('../db').CoordJob[];
  outreachJobs: import('../db').OutreachJob[];
} {
  const db = getDb();

  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE owner_user_id = ?
    AND owner_thread_ts = ?
    AND status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
  `).all(ownerUserId, threadTs) as Task[];

  const coordJobs = db.prepare(`
    SELECT * FROM coord_jobs
    WHERE owner_user_id = ?
    AND owner_thread_ts = ?
    AND status NOT IN ('booked', 'cancelled', 'abandoned')
    ORDER BY created_at DESC
  `).all(ownerUserId, threadTs) as import('../db').CoordJob[];

  const outreachJobs = db.prepare(`
    SELECT * FROM outreach_jobs
    WHERE owner_user_id = ?
    AND owner_thread_ts = ?
    AND status NOT IN ('replied', 'cancelled', 'no_response')
    ORDER BY created_at DESC
  `).all(ownerUserId, threadTs) as import('../db').OutreachJob[];

  return { tasks, coordJobs, outreachJobs };
}

// Get tasks that completed but requester hasn't been notified yet
export function getCompletedUninformedTasks(ownerUserId: string): Task[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM tasks
    WHERE owner_user_id = ?
    AND who_requested != 'system'
    AND status = 'completed'
    ORDER BY completed_at DESC
  `).all(ownerUserId) as Task[];
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
    AND due_at <= datetime('now')
  `).all() as Task[];
}

export function cancelTask(id: string): void {
  updateTask(id, { status: 'cancelled' });
}

export function completeTask(id: string): void {
  updateTask(id, { status: 'completed', completed_at: new Date().toISOString() });
}

// ── Formatting for display ────────────────────────────────────────────────────

export function formatTasksForUser(tasks: Task[]): string {
  if (tasks.length === 0) return 'Nothing on my list right now.';

  return tasks.map(t => {
    let status: string;
    switch (t.status) {
      case 'pending_colleague': status = 'waiting for reply'; break;
      case 'pending_owner':     status = 'needs your input'; break;
      case 'in_progress':       status = 'in progress'; break;
      case 'completed':         status = 'done'; break;
      case 'new': {
        if (t.due_at) {
          const due = DateTime.fromISO(t.due_at);
          status = `scheduled for ${due.toFormat('EEE d MMM HH:mm')}`;
        } else {
          status = 'new';
        }
        break;
      }
      default: status = t.status;
    }
    return `${t.title} — ${status}`;
  }).join('\n');
}
