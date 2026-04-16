import { getDb } from './client';

// ── Pending requests ─────────────────────────────────────────────────────────

export interface PendingRequest {
  id: string;
  status: string;
  source: string;
  thread_ts?: string;
  channel_id?: string;
  requester: string;
  subject: string;
  participants: string[];
  priority: string;
  duration_min: number;
  preferred_slots?: string[];
  proposed_slot?: string;
  notes?: string;
}

export function createPendingRequest(req: Omit<PendingRequest, 'id'>): string {
  const db = getDb();
  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(`
    INSERT INTO pending_requests
      (id, source, thread_ts, channel_id, requester, subject, participants, priority, duration_min, preferred_slots, proposed_slot, notes)
    VALUES
      (@id, @source, @thread_ts, @channel_id, @requester, @subject, @participants, @priority, @duration_min, @preferred_slots, @proposed_slot, @notes)
  `).run({
    id,
    ...req,
    participants: JSON.stringify(req.participants),
    preferred_slots: req.preferred_slots ? JSON.stringify(req.preferred_slots) : null,
    proposed_slot: req.proposed_slot ?? null,
    notes: req.notes ?? null,
  });
  return id;
}

export function resolvePendingRequest(id: string, resolution: 'resolved' | 'cancelled'): boolean {
  const db = getDb();
  const result = db.prepare(
    `UPDATE pending_requests SET status = @resolution, updated_at = datetime('now') WHERE id = @id AND status = 'open'`
  ).run({ id, resolution });
  return result.changes > 0;
}

export function updatePendingRequest(id: string, updates: Partial<PendingRequest>): void {
  const db = getDb();
  const sets = Object.keys(updates)
    .filter(k => k !== 'id')
    .map(k => `${k} = @${k}`)
    .join(', ');
  const params: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(updates)) {
    params[k] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  db.prepare(`UPDATE pending_requests SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run(params);
}

// ── Approval queue ───────────────────────────────────────────────────────────

export interface ApprovalItem {
  id: string;
  action_type: string;
  payload: Record<string, unknown>;
  reason: string;
  slack_msg_ts?: string;
}

export function enqueueApproval(item: Omit<ApprovalItem, 'id'>): string {
  const db = getDb();
  const id = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(`
    INSERT INTO approval_queue (id, action_type, payload, reason, slack_msg_ts)
    VALUES (@id, @action_type, @payload, @reason, @slack_msg_ts)
  `).run({
    id,
    ...item,
    payload: JSON.stringify(item.payload),
    slack_msg_ts: item.slack_msg_ts ?? null,
  });
  return id;
}

export function resolveApproval(id: string, status: 'approved' | 'rejected'): ApprovalItem | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM approval_queue WHERE id = ?').get(id) as any;
  if (!row) return null;
  db.prepare(`
    UPDATE approval_queue SET status = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(status, id);
  return { ...row, payload: JSON.parse(row.payload) };
}

export function getPendingApprovals(): ApprovalItem[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM approval_queue WHERE status = 'pending' ORDER BY created_at ASC`).all() as any[];
  return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}
