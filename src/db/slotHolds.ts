/**
 * Slot holds (#30) — tentative reservations on a slot someone picked but hasn't
 * confirmed, or the owner explicitly parked. Internal state ONLY: never an
 * Outlook event (it would leak the negotiation + show phantom busy org-wide).
 *
 * A hold is a flat, single-leg reservation with a hot read (the slot-finder
 * checks it on every search), so it lives in its OWN table — NOT the requests
 * spine (a hold isn't multi-step work awaiting anyone's action; forcing it onto
 * the spine would degenerate the row + overload `follow_up`). Storage analysis:
 * `.claude/RESERVE_SLOT_PROJECT.md`.
 *
 * Lifecycle: active → (released | expired). Expiry = min(2 owner-workdays,
 * slot-start), enforced by `sweepExpiredSlotHolds` on the 5-min tick, which
 * DMs the holder that the time was freed. Release also fires on confirm/book
 * (the hold became a real meeting) and on owner-books-over (with a heads-up).
 *
 * Honest-tentative, never a hard lock: the reads ANNOTATE a held slot and let
 * Maelle narrate it; they never hard-remove it. A race (someone insists on a
 * held time) routes to the owner via create_approval — code never silently
 * picks a winner.
 */
import { getDb } from './client';

export type SlotHoldStatus = 'active' | 'released' | 'expired';

export interface SlotHold {
  id: string;
  owner_user_id: string;
  holder_slack_id: string | null;
  holder_name: string;
  subject: string | null;
  start_iso: string;
  end_iso: string;
  origin_channel: string | null;
  origin_thread_ts: string | null;
  reason: string | null;
  status: SlotHoldStatus;
  created_at: string;
  expires_at: string;
  closure_reason: string | null;
  closed_at: string | null;
}

/** Per-holder cap (flat now; future: VIP→3, non-VIP→1 via people_memory.is_vip).
 *  No global cap — the morning brief is the owner's overuse oversight. */
export const MAX_HOLDS_PER_HOLDER = 3;
/** v3.5.x — per-MEETING cap: a holder can hold up to MAX_HOLDS_PER_HOLDER slots
 *  total, but no more than this many for any one meeting (subject). Owner
 *  direction 2026-06-25: "3 per holder, no more than 2 per meeting." */
export const MAX_HOLDS_PER_MEETING = 2;

function genId(): string {
  return `hold_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Active holds for an owner that haven't passed their slot end — used by the
 *  slot-finder annotation, the owner-book gate, and the morning brief. */
export function getActiveSlotHolds(ownerUserId: string): SlotHold[] {
  const db = getDb();
  const nowIso = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM slot_holds
    WHERE owner_user_id = ? AND status = 'active' AND end_iso > ?
    ORDER BY start_iso ASC
  `).all(ownerUserId, nowIso) as SlotHold[];
}

/** The active hold (if any) overlapping [startIso, endIso) for this owner.
 *  Used to annotate a search slot and to gate an owner booking over a hold. */
export function getActiveHoldOverlapping(
  ownerUserId: string,
  startIso: string,
  endIso: string,
): SlotHold | null {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  for (const h of getActiveSlotHolds(ownerUserId)) {
    const hs = Date.parse(h.start_iso);
    const he = Date.parse(h.end_iso);
    if (Number.isFinite(hs) && Number.isFinite(he) && startMs < he && endMs > hs) {
      return h;
    }
  }
  return null;
}

export function countActiveHoldsForHolder(ownerUserId: string, holderSlackId: string): number {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM slot_holds
    WHERE owner_user_id = ? AND holder_slack_id = ? AND status = 'active' AND end_iso > ?
  `).get(ownerUserId, holderSlackId, nowIso) as { n: number };
  return row?.n ?? 0;
}

/** v3.5.x — active holds for a holder on ONE meeting (matched by subject,
 *  case/space-insensitive). Drives the per-meeting cap (MAX_HOLDS_PER_MEETING)
 *  so a holder can hold several options for a meeting but not unboundedly. */
export function countActiveHoldsForHolderSubject(
  ownerUserId: string,
  holderSlackId: string,
  subject: string | null | undefined,
): number {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const subj = (subject ?? '').trim().toLowerCase();
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM slot_holds
    WHERE owner_user_id = ? AND holder_slack_id = ? AND status = 'active' AND end_iso > ?
      AND LOWER(TRIM(COALESCE(subject,''))) = ?
  `).get(ownerUserId, holderSlackId, nowIso, subj) as { n: number };
  return row?.n ?? 0;
}

// v3.5.x — `releaseHoldsForHolderThread` (the old repick-replace: a new pick
// released ALL of the holder's prior holds in the thread) was removed. Holds
// now accumulate up to the per-holder + per-meeting caps; re-holding the SAME
// slot is handled idempotently by the caller via releaseHoldsForOwner({startIso}).

/** Create a hold. Caller computes `expiresAt` = min(2 owner-workdays, slot-start)
 *  with utils/workHours.addWorkdays (the db layer stays profile-free). */
export function createSlotHold(params: {
  ownerUserId: string;
  holderSlackId?: string | null;
  holderName: string;
  subject?: string | null;
  startIso: string;
  endIso: string;
  originChannel?: string | null;
  originThreadTs?: string | null;
  reason?: string | null;
  expiresAt: string;
}): SlotHold {
  const db = getDb();
  const id = genId();
  db.prepare(`
    INSERT INTO slot_holds
      (id, owner_user_id, holder_slack_id, holder_name, subject, start_iso, end_iso,
       origin_channel, origin_thread_ts, reason, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    id, params.ownerUserId, params.holderSlackId ?? null, params.holderName,
    params.subject ?? null, params.startIso, params.endIso,
    params.originChannel ?? null, params.originThreadTs ?? null, params.reason ?? null,
    params.expiresAt,
  );
  return db.prepare(`SELECT * FROM slot_holds WHERE id = ?`).get(id) as SlotHold;
}

/** Terminal release. `expired=true` stamps status='expired' (sweep path),
 *  otherwise 'released' (confirm/book/owner-override/explicit cancel). */
export function releaseSlotHold(id: string, closureReason: string, expired = false): boolean {
  const db = getDb();
  const res = db.prepare(`
    UPDATE slot_holds
    SET status = ?, closure_reason = ?, closed_at = datetime('now')
    WHERE id = ? AND status = 'active'
  `).run(expired ? 'expired' : 'released', closureReason, id);
  return res.changes > 0;
}

/** Owner cancels — release any active hold matching (holder name and/or slot).
 *  Owner-only path; returns the rows released so the caller can DM each holder. */
export function releaseHoldsForOwner(
  ownerUserId: string,
  opts: { holderSlackId?: string; startIso?: string },
  reason: string,
): SlotHold[] {
  const active = getActiveSlotHolds(ownerUserId).filter(h => {
    if (opts.holderSlackId && h.holder_slack_id !== opts.holderSlackId) return false;
    if (opts.startIso && h.start_iso !== opts.startIso) return false;
    return true;
  });
  for (const h of active) releaseSlotHold(h.id, reason);
  return active;
}

/** Holds due for expiry (active + past min(2wd, slot-start)). The sweep releases
 *  each as 'expired' and DMs the holder it was freed. */
export function getDueSlotHolds(nowIso: string): SlotHold[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM slot_holds
    WHERE status = 'active' AND expires_at <= ?
  `).all(nowIso) as SlotHold[];
}

/** Holds released as fulfilled-by-booking in the last `hours` — so the brief can
 *  tell the owner "the slot I was holding for X became a real meeting." */
export function getRecentlyFulfilledHolds(ownerUserId: string, hours = 24): SlotHold[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM slot_holds
    WHERE owner_user_id = ? AND status = 'released'
      AND closure_reason = 'fulfilled_by_booking'
      AND closed_at >= datetime('now', ?)
    ORDER BY closed_at DESC
  `).all(ownerUserId, `-${hours} hours`) as SlotHold[];
}

/** Drop terminal rows older than 30 days (retention; called from the brief routine). */
export function cleanOldSlotHolds(): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM slot_holds
    WHERE status IN ('released','expired') AND closed_at < datetime('now', '-30 days')
  `).run();
}
