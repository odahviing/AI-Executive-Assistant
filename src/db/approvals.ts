/**
 * Approvals — legacy table layer.
 *
 * NOTE: most of this module's writers no longer have callers — approval
 * creation + resolution now lives on the requests spine (`src/core/requests/`);
 * the live tools (`create_approval`, `resolve_approval` in `src/tasks/skill.ts`)
 * write to `requests` directly. What remains here is the small set of helpers
 * still wired into the coord-reply path: `setApprovalDecision`,
 * `mergeApprovalPayload`, and `getPendingApprovalsBySkillRef`. Everything else
 * was deleted in the v3.0.x dead-code sweep.
 *
 * For new work, write against the requests spine — not this module.
 */

import { getDb } from './client';
import logger from '../utils/logger';

export type ApprovalKind =
  | 'slot_pick'
  | 'duration_override'
  | 'policy_exception'
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
  // Cancel any sibling reminder + expiry tasks so they don't fire after the
  // approval is already resolved. Mirrors the coord-terminal cascade in
  // updateCoordJob. Applies to every setApprovalDecision caller (coord +
  // non-coord), not just the coord-linked ones.
  db.prepare(`
    UPDATE tasks
    SET status = 'cancelled', updated_at = datetime('now')
    WHERE type IN ('approval_expiry', 'approval_reminder')
      AND skill_ref = @approval_id
      AND status IN ('new','scheduled','in_progress','pending_owner')
  `).run({ approval_id: opts.id });

  // Bridge to requests spine. When the legacy approval transitions to terminal,
  // close the linked request too. Idempotent — closeRequest no-ops on
  // already-terminal rows.
  try {
    const row = db.prepare(`SELECT request_id FROM approvals WHERE id = ?`).get(opts.id) as { request_id: string | null } | undefined;
    if (row?.request_id) {
      const reqState: 'resolved' | 'cancelled' | 'expired' =
        opts.status === 'approved' || opts.status === 'amended' ? 'resolved'
        : opts.status === 'expired' ? 'expired'
        : 'cancelled';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { closeRequest } = require('../core/requests/closeRequest') as typeof import('../core/requests/closeRequest');
      closeRequest({
        id: row.request_id,
        state: reqState,
        closureReason: `approval_${opts.status}`,
        closedBy: opts.status === 'expired' ? 'expiry' : 'owner',
      });
    }
  } catch (_) { /* non-fatal */ }

  logger.info('setApprovalDecision', { id: opts.id, status: opts.status });
}

/**
 * Merge additional fields into a pending approval's payload_json. Used when a
 * counter-offer or amendment arrives on a waiting_owner coord and we want the
 * extra context (amended_offer, counter_offer_at, etc.) visible on the row.
 * Shallow merge at the top level. No-op if the approval is not pending.
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
