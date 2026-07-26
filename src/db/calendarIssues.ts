/**
 * Calendar Issues — v3.0.3 redesign.
 *
 * One row per CLUSTER of linked events, PER AXIS. Clusters form via shared
 * overlap edges: events linked by an overlap issue belong to the same cluster.
 * Single-event issues (work_on_day_off, missing_floating_block, etc.) each
 * own a single-event cluster. Pair issues (overlap) merge their two events
 * into one cluster. Two issues on the same event but on DIFFERENT axes (see
 * `QUESTION_ONLY_CLASSES`) never share a cluster or a row — a problem with the
 * owner's day and an open question about an event's metadata are independent
 * facts, each of which has to be trackable, answerable and closable alone.
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
 *   7. missing_category
 *
 * Status lifecycle:
 *   new → awaiting_owner → (approved | in_progress | owner_side)
 *                                       ↓               ↓
 *                                       resolved        resolved
 *   resolved/approved/dismissed are terminal.
 *
 * Suppression: at detection time, only rows on the cluster's OWN AXIS (see
 * `QUESTION_ONLY_CLASSES`) are consulted — matched by event_id IN cluster OR
 * peer_event_id IN cluster. If such a row is terminal → suppress. If active →
 * update in place (already tracked). If absent → INSERT.
 *
 * Auto-stale: after each detection pass, rows not re-emitted are flipped
 * to status='resolved' (their underlying condition vanished).
 *
 * Cascade: on event move/delete/cancel, the PROBLEM-axis rows where event_id=E
 * or peer_event_id=E are resolved. A question row closes when it is answered,
 * not when the event it asks about changes.
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
  | 'busy_day'
  // v4.2.x (#148) — an event the health check couldn't confidently categorize,
  // so it ASKED the owner.
  //
  // NOT a regression — settled from history, because it looked like one. The
  // owner has been SEEING missing-category flags since v1.7.0 and was right
  // about that: the detector and its narration shipped in the very first commit
  // (84d399c, calendarHealth.ts:255) and have run every day since. What never
  // existed is the ROW. The DB write gate was `issue.type === 'double_booking'
  // || issue.type === 'oof_conflict'` from 84d399c through ef18d1b^, and the
  // 3.0.3 cluster redesign carried the same exclusion forward as an explicit
  // `if (!cls) continue; // missing_category / unknown — not tracked`. Across
  // every revision the literal 'missing_category' appears in exactly one file
  // (calendarHealth, later its split) and never in this one. No commit removed
  // it; there is nothing to restore. Live DB agrees: zero rows of this class,
  // ever.
  //
  // So the flagging was real and the memory was not, which is why the question
  // had no memory: with no row, the "RECENT CALENDAR ISSUES" block
  // buildTurnContext injects carried nothing, so the owner's one-word answer
  // ("Meeting") arrived with no event, no date and no open question attached —
  // and got read as a booking request. Lowest priority, so it never steals a
  // cluster's anchor from a real conflict on the same event.
  | 'missing_category';

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
  missing_category:       7,
};

const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  'approved', 'dismissed', 'resolved',
]);

const ACTIVE_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  'new', 'awaiting_owner', 'in_progress', 'owner_side',
]);

/**
 * v4.2.x (#148) — the two AXES. One concept, governing three things:
 * clustering, row identity, and suppression.
 *
 * Every class above except these says "something about this event is wrong with
 * the owner's day" (it clashes, it's on a day off, the day is overloaded). Those
 * are all restatements of one day-shape complaint, so they legitimately share a
 * cluster and a row: the highest-priority one anchors it, moving that event
 * resolves the rest, and a terminal row means "he's acknowledged the problem on
 * this event — stop nagging" for all of them.
 *
 * `missing_category` is NOT that. It's a QUESTION about the event's metadata,
 * and answering it ("Meeting") says nothing whatsoever about whether the event
 * clashes with something. Sharing an axis with the day-shape classes broke it in
 * both directions:
 *   • SUPPRESSION — the answer flips the row terminal (markStaleResolved, once
 *     the category is present), the event_id lands in `getSuppressedEventIds`,
 *     and from then until the event ends a REAL double-booking on it is dropped
 *     at `checkHealth.ts:350` — no row, no narration, no log line. A silent
 *     missed conflict, which is worse than the bug #148 fixed.
 *   • CLUSTERING / ROW IDENTITY — an uncategorized event that ALSO clashes emits
 *     both issues from the same `nonAllDay` set (checkHealth.ts:374 and :491),
 *     so they land in one cluster; the overlap anchors it (priority 3 vs 7) and
 *     the question's class, event and time notes are dropped. The question then
 *     has no row — exactly the no-memory state #148 exists to end — and, worse,
 *     an active row can be re-anchored across axes or deleted by the merge.
 *
 * So both are axis-scoped: a cluster holds one axis, and a row only speaks for
 * classes on its own axis. For the six pre-existing classes this is a no-op, and
 * structurally so, not just by luck: `missing_category` was never in any write
 * gate in the project's history (see the type union above), so no row of the new
 * axis exists to change how the old six cluster or suppress each other. Their
 * behaviour before the first `missing_category` row is written is byte-identical.
 *
 * Precedent: `getWaivedFloatingBlockEventIds` below already scopes its read to
 * one class for the same reason.
 */
const QUESTION_ONLY_CLASSES: ReadonlySet<IssueClass> = new Set<IssueClass>([
  'missing_category',
]);

/** True when two classes sit on the same axis — i.e. they may share a cluster
 *  and a row, and a terminal row of one may suppress a detection of the other. */
function sameAxis(a: IssueClass, b: IssueClass): boolean {
  return QUESTION_ONLY_CLASSES.has(a) === QUESTION_ONLY_CLASSES.has(b);
}

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

/** Group detected issues into clusters via connected components, ONE AXIS AT A
 *  TIME (see `QUESTION_ONLY_CLASSES`). Two issues land in the same cluster iff
 *  they are on the same axis AND they share an event_id, or one is an overlap
 *  that links them via peer_event_id. */
export function buildClusters(
  issues: DetectedIssue[],
  eventDateByEventId: Map<string, string>,
): IssueCluster[] {
  if (issues.length === 0) return [];
  const problems = issues.filter(i => !QUESTION_ONLY_CLASSES.has(i.class));
  const questions = issues.filter(i => QUESTION_ONLY_CLASSES.has(i.class));
  const out: IssueCluster[] = [];
  for (const axis of [problems, questions]) {
    if (axis.length > 0) out.push(...clustersForOneAxis(axis, eventDateByEventId));
  }
  return out;
}

/** The connected-components pass. Called once per axis by `buildClusters`. */
function clustersForOneAxis(
  issues: DetectedIssue[],
  eventDateByEventId: Map<string, string>,
): IssueCluster[] {
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
 * Only rows on the cluster's own AXIS are considered (see
 * `QUESTION_ONLY_CLASSES`); a row on the other axis is left entirely alone.
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

  // Look up any rows whose event_id is in this cluster, then keep only the ones
  // on the cluster's OWN AXIS (see QUESTION_ONLY_CLASSES). Cross-axis rows are
  // invisible here, which is what makes a category question and a conflict on
  // the same event two independent rows: a settled question can't suppress a
  // real conflict from being tracked, an active question can't be re-anchored
  // into an overlap row (losing its class and its notes), and the 2+ merge
  // below can't delete one axis's row in the other's name.
  const eventIds = Array.from(cluster.events);
  const placeholders = eventIds.map(() => '?').join(',');
  const existing = (db.prepare(`
    SELECT * FROM calendar_issues
    WHERE owner_user_id = ?
      AND (event_id IN (${placeholders}) OR peer_event_id IN (${placeholders}))
  `).all(ownerUserId, ...eventIds, ...eventIds) as CalendarIssueRow[])
    .filter(r => sameAxis(r.issue_class, cluster.anchor_class));

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
 * Resolves the non-terminal PROBLEM-axis rows that reference this event_id as
 * either the anchor or the peer — every day-shape complaint was computed FROM
 * the event's time, so changing the event voids it and "he acted on it" is the
 * right reading.
 *
 * v4.2.x (#148) — the QUESTION axis is deliberately NOT part of that cascade,
 * and is reachable only through an explicit `opts.onlyClass`. Moving or renaming
 * an event is not an ANSWER to "which category should this be?", but the cascade
 * resolve is terminal, and a terminal row suppresses re-detection until the
 * event ends (upsertCluster) — so an unscoped cascade meant that rescheduling
 * the very meeting Maelle had just asked about killed the question for good and
 * left the event uncategorized in silence. The question closes when it is
 * ANSWERED (`set_event_category` → onlyClass:'missing_category'), or when the
 * category shows up by any other route and the next detection pass auto-stales
 * the row. For the six pre-existing classes this changes nothing — they are all
 * problem-axis, so every existing caller behaves exactly as before.
 *
 * Residual, accepted: a DELETED event's question row is not cascaded away; it
 * auto-stales on the next detection pass over that date and can never mislead
 * (`set_event_category` on a dead id fails at Graph). Closing it at delete time
 * needs the `reason` this helper doesn't get — one line in closeMeetingArtifacts
 * (requests lane), not worth a cross-lane round-trip on its own.
 *
 * `opts.note` replaces the default cascade marker so the row records why it
 * closed.
 */
export function resolveCalendarIssuesForMeeting(
  ownerUserId: string,
  meetingId: string,
  opts: { onlyClass?: IssueClass; note?: string } = {},
): number {
  if (!ownerUserId || !meetingId) return 0;
  const db = getDb();
  const questionClasses = Array.from(QUESTION_ONLY_CLASSES);
  const classClause = opts.onlyClass
    ? 'AND issue_class = ?'
    : `AND issue_class NOT IN (${questionClasses.map(() => '?').join(',')})`;
  const result = db.prepare(`
    UPDATE calendar_issues
    SET status = 'resolved',
        notes = COALESCE(notes, '') || ?,
        updated_at = datetime('now')
    WHERE owner_user_id = ?
      AND status IN ('new','awaiting_owner','in_progress','owner_side')
      AND (event_id = ? OR peer_event_id = ?)
      ${classClause}
  `).run(
    opts.note ?? ' [cascade: anchor/peer event changed]',
    ownerUserId, meetingId, meetingId,
    ...(opts.onlyClass ? [opts.onlyClass] : questionClasses),
  );
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
 *  + event_end_ms still in the future). Read-only callers (the double_booking /
 *  dead-gap detectors, analyze_calendar, brief-pre-filter, routine narration)
 *  use this to drop issues whose event_ids fall in the set, so the owner doesn't
 *  see already-acknowledged conflicts re-narrated or re-auto-moved.
 *  Write-path callers (upsertCluster) handle suppression independently via
 *  the 'suppressed' return value.
 *
 *  v4.2.x (#148) — AXIS-SCOPED. `forClass` names the class being suppressed, and
 *  only terminal rows on that class's axis are returned (see
 *  QUESTION_ONLY_CLASSES). Omit it for the conflict axis, which is what every
 *  day-shape detector wants: an answered "which category?" must never silence a
 *  double-booking. Pass a question-only class to get that question's own settled
 *  set (so a dismissed category ask isn't re-narrated every run). */
export function getSuppressedEventIds(ownerUserId: string, forClass?: IssueClass): Set<string> {
  const db = getDb();
  const questionAxis = forClass !== undefined && QUESTION_ONLY_CLASSES.has(forClass);
  const axisClasses = Array.from(QUESTION_ONLY_CLASSES);
  const placeholders = axisClasses.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT event_id, peer_event_id FROM calendar_issues
    WHERE owner_user_id = ?
      AND status IN ('approved','dismissed','resolved')
      AND event_end_ms > ?
      AND issue_class ${questionAxis ? 'IN' : 'NOT IN'} (${placeholders})
  `).all(ownerUserId, Date.now(), ...axisClasses) as Array<{ event_id: string; peer_event_id: string | null }>;
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
