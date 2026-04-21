/**
 * Approvals (v1.5) — first-class structured decisions Maelle needs from the owner.
 *
 * Every approval is attached to a parent task (task_id required). The task
 * system is the root; approvals are a typed view of the "blocked on owner"
 * moments. When an approval resolves, downstream effects (book the meeting,
 * apply the override, notify requesters) run off the `kind` and `decision_json`.
 *
 * There are NO buttons. The owner replies in natural language and Sonnet
 * decides which approval is being answered. That's why `idempotency_key`
 * matters: if Sonnet misroutes and retries, we don't double-book.
 */

import { getDb } from './client';
import crypto from 'crypto';
import logger from '../utils/logger';

export type ApprovalKind =
  | 'slot_pick'
  | 'duration_override'
  | 'policy_exception'
  | 'lunch_bump'
  | 'unknown_person'
  | 'calendar_conflict'
  | 'freeform';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'amended'       // owner didn't approve as-asked but proposed an alternative
  | 'expired'
  | 'superseded'
  | 'cancelled';

export interface Approval {
  id: string;
  created_at: string;
  updated_at: string;
  task_id: string;
  owner_user_id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  payload_json: string;
  decision_json?: string;
  skill_ref?: string;
  slack_channel?: string;
  slack_thread_ts?: string;
  slack_msg_ts?: string;
  expires_at?: string;
  responded_at?: string;
  superseded_by?: string;
  idempotency_key?: string;
  notes?: string;
}

/**
 * Stable canonical JSON — same object always hashes identically.
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson((v as any)[k])).join(',') + '}';
}

export function buildIdempotencyKey(parts: {
  taskId: string;
  kind: ApprovalKind;
  payload: unknown;
}): string {
  const canonical = parts.taskId + '|' + parts.kind + '|' + canonicalJson(parts.payload);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

export interface CreateApprovalInput {
  taskId: string;
  ownerUserId: string;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  skillRef?: string;
  slackChannel?: string;
  slackThreadTs?: string;
  slackMsgTs?: string;
  expiresAt?: string;   // ISO
  notes?: string;
}

/**
 * Create an approval. Idempotent: if a pending approval already exists with
 * the same (taskId, kind, payload) it is returned instead of creating a new
 * one. This is the anti-double-ask guarantee.
 *
 * Returns { approval, created } — created=false means we reused an existing row.
 */
export function createApproval(input: CreateApprovalInput): { approval: Approval; created: boolean } {
  const db = getDb();
  const idempotencyKey = buildIdempotencyKey({
    taskId: input.taskId,
    kind: input.kind,
    payload: input.payload,
  });

  // Reuse any still-pending row with the same key
  const existing = db.prepare(
    `SELECT * FROM approvals WHERE idempotency_key = ? AND status = 'pending'`
  ).get(idempotencyKey) as Approval | undefined;

  if (existing) {
    logger.info('createApproval — reused existing pending row', {
      id: existing.id,
      kind: existing.kind,
      taskId: input.taskId,
    });
    return { approval: existing, created: false };
  }

  const id = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(`
    INSERT INTO approvals (
      id, task_id, owner_user_id, kind, status, payload_json,
      skill_ref, slack_channel, slack_thread_ts, slack_msg_ts,
      expires_at, idempotency_key, notes
    ) VALUES (
      @id, @task_id, @owner_user_id, @kind, 'pending', @payload_json,
      @skill_ref, @slack_channel, @slack_thread_ts, @slack_msg_ts,
      @expires_at, @idempotency_key, @notes
    )
  `).run({
    id,
    task_id: input.taskId,
    owner_user_id: input.ownerUserId,
    kind: input.kind,
    payload_json: JSON.stringify(input.payload),
    skill_ref: input.skillRef ?? null,
    slack_channel: input.slackChannel ?? null,
    slack_thread_ts: input.slackThreadTs ?? null,
    slack_msg_ts: input.slackMsgTs ?? null,
    expires_at: input.expiresAt ?? null,
    idempotency_key: idempotencyKey,
    notes: input.notes ?? null,
  });

  // Flip the parent task to pending_owner + point its due_at to the approval expiry.
  // The existing task-runner cron will pick up expired approvals via the approval
  // expiry sweeper; we also mirror expires_at on the task for visibility and so
  // the existing `getTasksDueNow` path works without special-casing.
  db.prepare(`
    UPDATE tasks SET status = 'pending_owner',
                     due_at = COALESCE(@expires_at, due_at),
                     pending_on = @pending_on,
                     updated_at = datetime('now')
    WHERE id = @task_id
  `).run({
    task_id: input.taskId,
    expires_at: input.expiresAt ?? null,
    pending_on: JSON.stringify([input.ownerUserId]),
  });

  // v1.6.0 — schedule the expiry check as a first-class task instead of
  // relying on a background sweep. When the task fires, the runner's
  // 'approval_expiry' dispatcher will expire the approval and cascade.
  if (input.expiresAt) {
    try {
      // Look up owner channel/thread from the parent task so the expiry DM
      // lands in the right place.
      const parentTask = db.prepare(
        `SELECT owner_channel, owner_thread_ts FROM tasks WHERE id = ?`
      ).get(input.taskId) as { owner_channel: string; owner_thread_ts: string | null } | undefined;
      if (parentTask) {
        const expiryTaskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        db.prepare(`
          INSERT INTO tasks (
            id, owner_user_id, owner_channel, owner_thread_ts,
            type, status, title, due_at, skill_ref, context, who_requested, skill_origin
          ) VALUES (
            @id, @owner_user_id, @owner_channel, @owner_thread_ts,
            'approval_expiry', 'new', @title, @due_at, @skill_ref, @context, 'system', 'tasks'
          )
        `).run({
          id: expiryTaskId,
          owner_user_id: input.ownerUserId,
          owner_channel: parentTask.owner_channel,
          owner_thread_ts: parentTask.owner_thread_ts ?? null,
          title: `Approval expiry check (${input.kind})`,
          due_at: input.expiresAt,
          skill_ref: id,
          context: JSON.stringify({ approval_id: id, kind: input.kind }),
        });
      }
    } catch (err) {
      logger.warn('Failed to schedule approval_expiry task — approval still live but sweep-free expiry may not fire', {
        err: String(err), approvalId: id,
      });
    }
  }

  const approval = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as Approval;
  logger.info('createApproval — new approval created', {
    id,
    kind: input.kind,
    taskId: input.taskId,
    expiresAt: input.expiresAt,
  });
  return { approval, created: true };
}

export function getApproval(id: string): Approval | null {
  const db = getDb();
  return (db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as Approval | null) ?? null;
}

export function getPendingApprovalsForOwner(ownerUserId: string): Approval[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM approvals WHERE owner_user_id = ? AND status = 'pending' ORDER BY created_at ASC`
  ).all(ownerUserId) as Approval[];
}

export function getPendingApprovalsForTask(taskId: string): Approval[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC`
  ).all(taskId) as Approval[];
}

export function getPendingApprovalsBySkillRef(skillRef: string): Approval[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM approvals WHERE skill_ref = ? AND status = 'pending' ORDER BY created_at ASC`
  ).all(skillRef) as Approval[];
}

/**
 * Mark an approval with a final status + decision. Does NOT run downstream
 * effects — the resolver layer handles that after calling this.
 */
export function setApprovalDecision(opts: {
  id: string;
  status: Exclude<ApprovalStatus, 'pending'>;
  decision?: unknown;
  notes?: string;
}): void {
  const db = getDb();
  db.prepare(`
    UPDATE approvals
    SET status = @status,
        decision_json = COALESCE(@decision_json, decision_json),
        responded_at = datetime('now'),
        notes = COALESCE(@notes, notes),
        updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id: opts.id,
    status: opts.status,
    decision_json: opts.decision !== undefined ? JSON.stringify(opts.decision) : null,
    notes: opts.notes ?? null,
  });
  logger.info('setApprovalDecision', { id: opts.id, status: opts.status });
}

/**
 * Mark an approval as superseded by another one (e.g. stale slot → new options).
 * The superseding approval's id is recorded so audit trails stay traversable.
 */
export function supersedeApproval(oldId: string, newId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE approvals SET status = 'superseded', superseded_by = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(newId, oldId);
}

/**
 * Expiry sweep — run by a cron. Flips past-due pending approvals to expired.
 * Returns the list of approvals that were expired so the caller can cascade.
 */
export function sweepExpiredApprovals(): Approval[] {
  const db = getDb();
  const expired = db.prepare(`
    SELECT * FROM approvals
    WHERE status = 'pending'
    AND expires_at IS NOT NULL
    AND datetime(expires_at) <= datetime('now')
  `).all() as Approval[];

  for (const a of expired) {
    db.prepare(`UPDATE approvals SET status = 'expired', updated_at = datetime('now') WHERE id = ?`).run(a.id);
  }
  if (expired.length > 0) {
    logger.info('sweepExpiredApprovals flipped approvals to expired', { count: expired.length });
  }
  return expired;
}

/**
 * Cancel all pending approvals for a task — used when the parent task is
 * cancelled or superseded so owner isn't left with orphan asks.
 */
/**
 * Merge additional fields into a pending approval's payload_json. Used when a
 * counter-offer or amendment arrives on a waiting_owner coord and we want the
 * extra context (amended_offer, counter_offer_at, etc.) visible in the owner's
 * system prompt via getPendingApprovalsForOwner. Shallow merge at the top level.
 * No-op if the approval is not pending.
 */
export function mergeApprovalPayload(id: string, patch: Record<string, unknown>): void {
  const db = getDb();
  const row = db.prepare(`SELECT status, payload_json FROM approvals WHERE id = ?`).get(id) as
    | { status: ApprovalStatus; payload_json: string }
    | undefined;
  if (!row) return;
  if (row.status !== 'pending') return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const merged = { ...payload, ...patch };
  db.prepare(
    `UPDATE approvals SET payload_json = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(JSON.stringify(merged), id);
}

export function cancelApprovalsForTask(taskId: string, reason?: string): void {
  const db = getDb();
  const info = db.prepare(`
    UPDATE approvals SET status = 'cancelled',
                         notes = COALESCE(@reason, notes),
                         updated_at = datetime('now')
    WHERE task_id = @task_id AND status = 'pending'
  `).run({ task_id: taskId, reason: reason ?? null });
  logger.info('cancelApprovalsForTask', { taskId, changes: info.changes });
}
