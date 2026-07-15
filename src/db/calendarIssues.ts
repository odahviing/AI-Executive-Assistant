/**
 * Calendar Issues — v3.0.3 redesign.
 *
 * One row per CLUSTER of linked events. Clusters form via shared overlap
 * edges: events linked by an overlap issue belong to the same cluster.
 * Single-event issues (work_on_day_off, missing_floating_block, etc.) each
 * own a single-event cluster. Pair issues (overlap) merge their two events
 * into one cluster.
 *
 * For each cluster, the detector finds the HIGHEST-PRIORITY issue across
 * all its events. That issue becomes the row's `issue_class`; its event
 * becomes the `event_id` (anchor). The other issues are silently dropped
 * — moving the anchor event resolves the cluster anyway, and slot finder
 * handles any remaining timing constraints on re-detection.
 *
 * Priority order (highest→lowest):
 *   1. work_on_day_off
 *   2. oof_with_meetings
 *   3. overlap
 *   4. category_limit
 *   5. missing_floating_block
 *   6. busy_day
 *
 * Status lifecycle:
 *   new → awaiting_owner → (approved | in_progress | owner_side)
 *                                       ↓               ↓
 *                                       resolved        resolved
 *   resolved/approved/dismissed are terminal.
 *
 * Suppression: at detection time, if a row exists for the cluster (matched
 * by event_id IN cluster OR peer_event_id IN cluster) AND its status is
 * terminal → suppress. If active → no-op (already tracked). If absent →
 * INSERT.
 *
 * Auto-stale: after each detection pass, rows not re-emitted are flipped
 * to status='resolved' (their underlying condition vanished).
 *
 * Cascade: on event move/delete/cancel, rows where event_id=E or
 * peer_event_id=E are resolved.
 *
 * Past filter: rows with event_end_ms < now() are filtered out at read
 * time. No need for a cron to expire them.
 *
 * Migration note: the legacy `calendar_dismissed_issues` table is dropped
 * by the db/client schema init. All old rows are gone (owner direction —
 * clean start). No data migration path.
 */
import { getDb } from './client';

// ── Types ────────────────────────────────────────────────────────────────────

export type IssueClass =
  | 'work_on_day_off'
  | 'oof_with_meetings'
  | 'overlap'
  | 'category_limit'
  | 'missing_floating_block'
  | 'busy_day';

export type IssueStatus =
  | 'new'
  | 'awaiting_owner'
  | 'in_progress'
  | 'owner_side'
  | 'approved'
  | 'dismissed'
  | 'resolved';

/** Priority — lower number = higher priority. Used to choose the anchor
 *  issue per cluster. Tiebreak: lex-min event_id. */
const CLASS_PRIORITY: Record<IssueClass, number> = {
  work_on_day_off:        1,
  oof_with_meetings:      2,
  overlap:                3,
  category_limit:         4,
  missing_floating_block: 5,
  busy_day:               6,
};

const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  'approved', 'dismissed', 'resolved',
]);

const ACTIVE_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  'new', 'awaiting_owner', 'in_progress', 'owner_side',
]);

/** Single detected issue, pre-clustering. The detector emits these in
 *  memory; the cluster builder groups them and writes rows. */
export interface DetectedIssue {
  class: IssueClass;
  event_id: string;            // the event this issue is about
  event_subject?: string;      // for narration without re-fetch
  event_end_ms: number;        // when this event stops mattering
  peer_event_id?: string;      // only set when class==='overlap'
  peer_subject?: string;
  peer_end_ms?: number;
  detail?: string;             // free prose for notes
}

/** A cluster — one or more detected issues sharing event_ids transitively
 *  via overlap edges. Produced by `buildClusters`. */
export interface IssueCluster {
  /** Every event_id referenced by any issue in this cluster. */
  events: Set<string>;
  /** The issues that fell into this cluster. */
  issues: DetectedIssue[];
  /** Anchor: event_id of the issue with the highest priority.
   *  Tiebreak: among same-priority issues, lex-min of their event_ids. */
  anchor_event_id: string;
  /** The chosen anchor issue's class. */
  anchor_class: IssueClass;
  /** Anchor issue's peer (only when anchor_class==='overlap'). */
  anchor_peer_event_id?: string;
  anchor_peer_subject?: string;
  /** Max(end_ms) across all events in the cluster. */
  event_end_ms: number;
  /** Date of the anchor event (YYYY-MM-DD, owner-local). */
  event_date: string;
  /** Anchor issue's detail string, when present. */
  detail?: string;
}

export interface CalendarIssueRow {
  id: string;
  owner_user_id: string;
  event_id: string;
  peer_event_id: string | null;
  event_date: string;
  event_end_ms: number;
  issue_class: IssueClass;
  status: IssueStatus;
  notes: string | null;
  request_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── Cluster building ─────────────────────────────────────────────────────────

/** Group detected issues into clusters via connected components.
 *  Two issues land in the same cluster iff they share an event_id, or one
 *  is an overlap that links them via peer_event_id. */
export function buildClusters(
  issues: DetectedIssue[],
  eventDateByEventId: Map<string, string>,
): IssueCluster[] {
  if (issues.length === 0) return [];

  // Union-find over event_ids.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    while (r !== (parent.get(r) ?? r)) r = parent.get(r) ?? r;
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const i of issues) {
    if (!parent.has(i.event_id)) parent.set(i.event_id, i.event_id);
    if (i.peer_event_id) {
      if (!parent.has(i.peer_event_id)) parent.set(i.peer_event_id, i.peer_event_id);
      union(i.event_id, i.peer_event_id);
    }
  }

  // Group issues by cluster root.
  const groups = new Map<string, DetectedIssue[]>();
  for (const i of issues) {
    const root = find(i.event_id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const clusters: IssueCluster[] = [];
  for (const [, items] of groups) {
    // Anchor selection: highest priority (lowest CLASS_PRIORITY number).
    // Tiebreak among equal-priority issues: lex-min event_id.
    let bestIdx = 0;
    for (let i = 1; i < items.length; i++) {
      const a = items[bestIdx];
      const b = items[i];
      const pa = CLASS_PRIORITY[a.class];
      const pb = CLASS_PRIORITY[b.class];
      if (pb < pa || (pb === pa && b.event_id < a.event_id)) bestIdx = i;
    }
    const anchorIssue = items[bestIdx];

    // Collect every event_id touched by any issue in this cluster.
    const events = new Set<string>();
    let maxEnd = 0;
    for (const it of items) {
      events.add(it.event_id);
      if (it.peer_event_id) events.add(it.peer_event_id);
      if (it.event_end_ms > maxEnd) maxEnd = it.event_end_ms;
      if (it.peer_end_ms && it.peer_end_ms > maxEnd) maxEnd = it.peer_end_ms;
    }

    const eventDate = eventDateByEventId.get(anchorIssue.event_id) ?? '';

    clusters.push({
      events,
      issues: items,
      anchor_event_id: anchorIssue.event_id,
      anchor_class: anchorIssue.class,
      anchor_peer_event_id: anchorIssue.class === 'overlap' ? anchorIssue.peer_event_id : undefined,
      anchor_peer_subject: anchorIssue.class === 'overlap' ? anchorIssue.peer_subject : undefined,
      event_end_ms: maxEnd,
      event_date: eventDate,
      detail: anchorIssue.detail,
    });
  }
  return clusters;
}

// ── Write path ───────────────────────────────────────────────────────────────

/**
 * Upsert a cluster's row. Three paths:
 *   - 0 existing rows touched by cluster → INSERT new row
 *   - 1 row whose event_id is in cluster.events → UPDATE in place
 *       (also covers the migrate-anchor case: row.event_id may differ from
 *        cluster.anchor_event_id; we re-anchor by updating event_id, class,
 *        peer_event_id together)
 *   - 2+ rows touched → MERGE: pick the oldest, fold into it, DELETE the
 *       rest. Handles cluster-joining (a new overlap linking two events
 *       that each had their own active row before).
 *
 * Terminal-status rows (approved/dismissed/resolved) suppress re-emission —
 * we don't disturb them, we just no-op.
 */
export function upsertCluster(
  ownerUserId: string,
  cluster: IssueCluster,
  initialStatus: IssueStatus = 'awaiting_owner',
): { action: 'insert' | 'update' | 'merge' | 'suppressed' | 'noop'; row_id?: string } {
  const db = getDb();

  // Look up any rows whose event_id is in this cluster.
  const eventIds = Array.from(cluster.events);
  const placeholders = eventIds.map(() => '?').join(',');
  const existing = db.prepare(`
    SELECT * FROM calendar_issues
    WHERE owner_user_id = ?
      AND (event_id IN (${placeholders}) OR peer_event_id IN (${placeholders}))
  `).all(ownerUserId, ...eventIds, ...eventIds) as CalendarIssueRow[];

  // Any terminal row → suppressed.
  const terminal = existing.find(r => TERMINAL_STATUSES.has(r.status));
  if (terminal) return { action: 'suppressed', row_id: terminal.id };

  const active = existing.filter(r => ACTIVE_STATUSES.has(r.status));

  if (active.length === 0) {
    // Fresh insert.
    const id = `ci_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO calendar_issues
        (id, owner_user_id, event_id, peer_event_id, event_date, event_end_ms,
         issue_class, status, notes, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id, ownerUserId,
      cluster.anchor_event_id,
      cluster.anchor_peer_event_id ?? null,
      cluster.event_date,
      cluster.event_end_ms,
      cluster.anchor_class,
      initialStatus,
      cluster.detail ?? null,
    );
    return { action: 'insert', row_id: id };
  }

  if (active.length === 1) {
    // Update in place; possibly re-anchor.
    const row = active[0];
    db.prepare(`
      UPDATE calendar_issues
      SET event_id = ?, peer_event_id = ?, event_date = ?, event_end_ms = ?,
          issue_class = ?, notes = COALESCE(notes, ?),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      cluster.anchor_event_id,
      cluster.anchor_peer_event_id ?? null,
      cluster.event_date,
      cluster.event_end_ms,
      cluster.anchor_class,
      cluster.detail ?? null,
      row.id,
    );
    return { action: 'update', row_id: row.id };
  }

  // 2+ active rows touched → MERGE.
  const sorted = [...active].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const canonical = sorted[0];
  db.prepare(`
    UPDATE calendar_issues
    SET event_id = ?, peer_event_id = ?, event_date = ?, event_end_ms = ?,
        issue_class = ?, notes = COALESCE(notes, ?),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    cluster.anchor_event_id,
    cluster.anchor_peer_event_id ?? null,
    cluster.event_date,
    cluster.event_end_ms,
    cluster.anchor_class,
    cluster.detail ?? null,
    canonical.id,
  );
  for (let i = 1; i < sorted.length; i++) {
    db.prepare(`DELETE FROM calendar_issues WHERE id = ?`).run(sorted[i].id);
  }
  return { action: 'merge', row_id: canonical.id };
}

// ── Auto-stale (after a detection pass) ──────────────────────────────────────

/**
 * After processing a detection batch, mark any ACTIVE row not touched in
 * this pass as resolved — its underlying condition is gone.
 *
 * Called once per detection per owner. Pass the set of row IDs that were
 * upserted in this pass; everything else with active status + event_end_ms
 * in the date range gets flipped.
 *
 * Scope to the date range being analyzed so we don't touch unrelated rows
 * for other dates that this detection pass didn't even look at.
 */
export function markStaleResolved(
  ownerUserId: string,
  touchedRowIds: Set<string>,
  dateRangeStart: string,
  dateRangeEnd: string,
): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id FROM calendar_issues
    WHERE owner_user_id = ?
      AND status IN ('new','awaiting_owner','in_progress','owner_side')
      AND event_date >= ? AND event_date <= ?
  `).all(ownerUserId, dateRangeStart, dateRangeEnd) as Array<{ id: string }>;

  let changed = 0;
  for (const r of rows) {
    if (touchedRowIds.has(r.id)) continue;
    db.prepare(`
      UPDATE calendar_issues
      SET status = 'resolved',
          notes = COALESCE(notes, '') || ' [auto-stale: conditions vanished]',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(r.id);
    changed++;
  }
  return changed;
}

// ── Cascade ──────────────────────────────────────────────────────────────────

/**
 * Called from closeMeetingArtifacts on every event move/delete/cancel.
 * Resolves any non-terminal row that references this event_id as either
 * the anchor or the peer.
 */
export function resolveCalendarIssuesForMeeting(
  ownerUserId: string,
  meetingId: string,
): number {
  if (!ownerUserId || !meetingId) return 0;
  const db = getDb();
  const result = db.prepare(`
    UPDATE calendar_issues
    SET status = 'resolved',
        notes = COALESCE(notes, '') || ' [cascade: anchor/peer event changed]',
        updated_at = datetime('now')
    WHERE owner_user_id = ?
      AND status IN ('new','awaiting_owner','in_progress','owner_side')
      AND (event_id = ? OR peer_event_id = ?)
  `).run(ownerUserId, meetingId, meetingId);
  return result.changes;
}

// ── Read helpers ─────────────────────────────────────────────────────────────

/** Active rows for an owner that haven't passed their event_end_ms yet.
 *  Used by manage_calendar_issue(action='list') and the brief. */
export function getActiveCalendarIssues(ownerUserId: string): CalendarIssueRow[] {
  const db = getDb();
  const nowMs = Date.now();
  return db.prepare(`
    SELECT * FROM calendar_issues
    WHERE owner_user_id = ?
      AND status IN ('new','awaiting_owner','in_progress','owner_side')
      AND event_end_ms > ?
    ORDER BY event_date ASC, event_end_ms ASC
  `).all(ownerUserId, nowMs) as CalendarIssueRow[];
}

/** Fetch a single row by id. */
export function getCalendarIssueById(id: string): CalendarIssueRow | null {
  const db = getDb();
  return (db.prepare(`SELECT * FROM calendar_issues WHERE id = ?`).get(id) as CalendarIssueRow | null) ?? null;
}

/** Set of event_ids referenced by TERMINAL rows (approved/dismissed/resolved
 *  + event_end_ms still in the future). Read-only callers (analyze_calendar,
 *  brief-pre-filter) use this to drop issues whose event_ids fall in the set,
 *  so the owner doesn't see already-acknowledged conflicts re-narrated.
 *  Write-path callers (upsertCluster) handle suppression independently via
 *  the 'suppressed' return value. */
export function getSuppressedEventIds(ownerUserId: string): Set<string> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT event_id, peer_event_id FROM calendar_issues
    WHERE owner_user_id = ?
      AND status IN ('approved','dismissed','resolved')
      AND event_end_ms > ?
  `).all(ownerUserId, Date.now()) as Array<{ event_id: string; peer_event_id: string | null }>;
  const out = new Set<string>();
  for (const r of rows) {
    out.add(r.event_id);
    if (r.peer_event_id) out.add(r.peer_event_id);
  }
  return out;
}

/** v3.1.7 / #119 — synthetic event_ids of floating-block gaps the owner has
 *  DELIBERATELY waived: `missing_floating_block` rows that are `approved`
 *  (preemptive dismiss) or `dismissed` (owner deleted the block on that day),
 *  with event_end_ms still in the future. The detector skips re-flagging /
 *  re-booking any day whose synthetic id is in this set.
 *
 *  Deliberately EXCLUDES `resolved` — that status means the gap auto-filled
 *  (a block got placed), not that the owner waived it; suppressing on resolved
 *  would block re-booking a lunch that was simply deleted after being placed.
 *  This is the date-scoped replacement for the old audit-log delete suppressor
 *  (which over-suppressed every day when a delete row lacked event_start_iso). */
export function getWaivedFloatingBlockEventIds(ownerUserId: string): Set<string> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT event_id FROM calendar_issues
    WHERE owner_user_id = ?
      AND issue_class = 'missing_floating_block'
      AND status IN ('approved','dismissed')
      AND event_end_ms > ?
  `).all(ownerUserId, Date.now()) as Array<{ event_id: string }>;
  const out = new Set<string>();
  for (const r of rows) out.add(r.event_id);
  return out;
}

/** v3.1.7 / #119 — record that the owner deleted a floating block on a
 *  specific day, so active-mode health doesn't re-book the gap. Writes a
 *  terminal `dismissed` row keyed to the day's synthetic event_id (date is
 *  encoded in the id → only that exact day is suppressed; future same-weekday
 *  blocks are untouched). Idempotent: a pre-existing `approved` waiver is left
 *  alone; anything else is flipped to `dismissed`. */
export function dismissFloatingBlockGap(opts: {
  ownerUserId: string;
  eventId: string;       // synthetic id from floatingBlockSyntheticEventId
  eventDate: string;     // YYYY-MM-DD (owner-local)
  eventEndMs: number;
  notes?: string;
}): void {
  const db = getDb();
  const existing = db.prepare(
    `SELECT id, status FROM calendar_issues WHERE owner_user_id = ? AND event_id = ?`,
  ).get(opts.ownerUserId, opts.eventId) as { id: string; status: string } | undefined;
  if (existing) {
    // Don't downgrade an explicit approval; otherwise ensure terminal-dismissed.
    if (existing.status === 'approved') return;
    db.prepare(`
      UPDATE calendar_issues
      SET status = 'dismissed', notes = COALESCE(?, notes), updated_at = datetime('now')
      WHERE id = ?
    `).run(opts.notes ?? null, existing.id);
    return;
  }
  const id = `ci_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO calendar_issues
      (id, owner_user_id, event_id, peer_event_id, event_date, event_end_ms,
       issue_class, status, notes, request_id)
    VALUES (?, ?, ?, NULL, ?, ?, 'missing_floating_block', 'dismissed', ?, NULL)
  `).run(id, opts.ownerUserId, opts.eventId, opts.eventDate, opts.eventEndMs, opts.notes ?? null);
}

/** v3.7.x (#139) — record that the owner REJECTED an active-mode auto-move of an
 *  overlapping meeting (via revert_last_auto_move). Writes a terminal `dismissed`
 *  overlap row anchored on the meeting's event id (+ the peer it clashed with,
 *  when known) so getSuppressedEventIds returns it and the double_booking
 *  detector stops re-flagging + re-moving it — the "if I said no, it's no"
 *  guarantee, using the SAME dismissal mechanism as floating-block gaps.
 *  Occurrence-anchored: only this event/occurrence is suppressed; other
 *  occurrences of a recurring series still surface. Idempotent: an existing
 *  `approved` waiver is left alone; anything else is ensured terminal-dismissed. */
export function dismissOverlapIssue(opts: {
  ownerUserId: string;
  eventId: string;
  peerEventId?: string | null;
  eventDate: string;      // YYYY-MM-DD (owner-local)
  eventEndMs: number;     // when this occurrence stops mattering (past-filtered on read)
  notes?: string;
}): void {
  if (!opts.ownerUserId || !opts.eventId) return;
  const db = getDb();
  const existing = db.prepare(
    `SELECT id, status FROM calendar_issues WHERE owner_user_id = ? AND event_id = ?`,
  ).get(opts.ownerUserId, opts.eventId) as { id: string; status: string } | undefined;
  if (existing) {
    if (existing.status === 'approved') return;  // don't downgrade an explicit approval
    db.prepare(`
      UPDATE calendar_issues
      SET status = 'dismissed',
          peer_event_id = COALESCE(?, peer_event_id),
          notes = COALESCE(?, notes),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(opts.peerEventId ?? null, opts.notes ?? null, existing.id);
    return;
  }
  const id = `ci_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO calendar_issues
      (id, owner_user_id, event_id, peer_event_id, event_date, event_end_ms,
       issue_class, status, notes, request_id)
    VALUES (?, ?, ?, ?, ?, ?, 'overlap', 'dismissed', ?, NULL)
  `).run(id, opts.ownerUserId, opts.eventId, opts.peerEventId ?? null, opts.eventDate, opts.eventEndMs, opts.notes ?? null);
}

/** v3.5.x — stable synthetic anchor id for a DAY/WINDOW-level issue that isn't
 *  tied to a single real event. `busy_day` has no real event_id, so without an
 *  anchor it was dropped at the write step and could never be tracked, approved,
 *  or suppressed — it re-narrated every routine run. A deterministic id per
 *  (class, date) lets the row materialize, lets the owner approve it, and lets
 *  getSuppressedEventIds silence re-narration — the same mechanism
 *  floatingBlockSyntheticEventId gives missing_floating_block. */
export function dayLevelIssueSyntheticId(
  issueClass: 'busy_day' | 'category_limit',
  date: string,            // YYYY-MM-DD (busy_day: the day; category_limit: window start)
  key?: string,            // category name for category_limit (independent waivers per category)
): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const base = `dli-${issueClass}-${date}`;
  return key ? `${base}-${norm(key)}` : base;
}

// ── Status transitions ───────────────────────────────────────────────────────

export function updateCalendarIssueStatus(
  issueId: string,
  status: IssueStatus,
  notes?: string,
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE calendar_issues
    SET status = ?, notes = COALESCE(?, notes), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, notes ?? null, issueId);
  return result.changes > 0;
}

export function attachRequestToIssue(issueId: string, requestId: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE calendar_issues
    SET request_id = ?, status = 'in_progress', updated_at = datetime('now')
    WHERE id = ?
  `).run(requestId, issueId);
  return result.changes > 0;
}
