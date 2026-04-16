import { getDb } from './client';

// ── Events ────────────────────────────────────────────────────────────────────

export type EventType = 'message' | 'meeting_invite' | 'task_update' | 'coordination' | 'outreach_reply';

export interface MaelleEvent {
  id: string;
  created_at: string;
  owner_user_id: string;
  type: EventType;
  title: string;
  detail?: string;
  actor?: string;
  ref_id?: string;
  seen: number;
  actioned: number;
}

export function logEvent(params: {
  ownerUserId: string;
  type: EventType;
  title: string;
  detail?: string;
  actor?: string;
  refId?: string;
}): void {
  const db = getDb();
  const id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  db.prepare(`
    INSERT INTO events (id, owner_user_id, type, title, detail, actor, ref_id)
    VALUES (@id, @owner_user_id, @type, @title, @detail, @actor, @ref_id)
  `).run({
    id,
    owner_user_id: params.ownerUserId,
    type: params.type,
    title: params.title,
    detail: params.detail ?? null,
    actor: params.actor ?? null,
    ref_id: params.refId ?? null,
  });
}

export function getUnseenEvents(ownerUserId: string): MaelleEvent[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM events
    WHERE owner_user_id = ? AND seen = 0
    ORDER BY created_at ASC
  `).all(ownerUserId) as MaelleEvent[];
}

export function markEventsSeen(ownerUserId: string): void {
  const db = getDb();
  db.prepare(`UPDATE events SET seen = 1 WHERE owner_user_id = ? AND seen = 0`).run(ownerUserId);
}

export function getEventsByActor(ownerUserId: string, actorName: string): MaelleEvent[] {
  const db = getDb();
  const query = `%${actorName.toLowerCase()}%`;
  return db.prepare(`
    SELECT * FROM events
    WHERE owner_user_id = ?
    AND lower(actor) LIKE ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(ownerUserId, query) as MaelleEvent[];
}

export function markEventActioned(id: string): void {
  const db = getDb();
  db.prepare(`UPDATE events SET actioned = 1 WHERE id = ?`).run(id);
}
