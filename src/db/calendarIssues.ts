import { getDb } from './client';

export type CalendarIssueStatus = 'new' | 'approved' | 'to_resolve' | 'resolved' | 'dismissed';

export interface CalendarIssue {
  id: string;
  created_at: string;
  owner_user_id: string;
  event_date: string;
  issue_type: string;
  issue_key: string;
  detail: string;
  resolution: CalendarIssueStatus;
  resolution_notes: string | null;
}

/**
 * v2.7.4 — Issue-class normalization. Different issue types describe the
 * same underlying problem from different angles:
 *   double_booking + back_to_back + no_buffer → all are "overlap"
 *   oof_conflict → "oof"
 * The dismissal fingerprint should be class-based, not type-based, so a
 * dismissed double_booking row doesn't get re-flagged as back_to_back on
 * the next run (the May 12 Michal-Happy-Hour dismissal failure).
 */
function normalizeIssueClass(type: string): string {
  switch (type) {
    case 'double_booking':
    case 'back_to_back':
    case 'no_buffer':
    case 'overlap':
      return 'overlap';
    case 'oof_conflict':
      return 'oof';
    case 'missing_floating_block':
      return 'missing_block';
    case 'work_on_day_off':
      return 'day_off';
    case 'busy_day':
      return 'busy_day';
    case 'category_limit_exceeded':
      return 'category_limit';
    default:
      return type;  // unknown types fall back to literal
  }
}

/**
 * Build a unique key for a calendar issue so we can match dismissals / dedup.
 *
 * v2.7.4 — stable fingerprint via (class, sorted_event_ids) when event IDs
 * are available; falls back to (type, time-extract, prose-prefix) for legacy
 * callers that dismiss by free-form description without IDs. Same overlap
 * across runs now keys identically regardless of how the description prose
 * is phrased (Sonnet free-form vs analyzer structured).
 *
 * Format with IDs: "{class}:{id1},{id2}"     — stable
 * Format legacy:   "{type}:{time}:{prefix}"  — old behavior, used when no IDs
 */
export function buildIssueKey(type: string, detail: string, eventIds?: string[]): string {
  const cls = normalizeIssueClass(type);
  if (eventIds && eventIds.length > 0) {
    const sorted = [...eventIds].sort().join(',');
    return `${cls}:${sorted}`;
  }
  // Legacy fallback — used when caller has no eventIds (older Sonnet-typed
  // dismissals via dismiss_calendar_issue free-text). Less stable but at
  // least carries forward for items dismissed before this version.
  const timeMatch = detail.match(/(\d{2}:\d{2})/);
  const time = timeMatch ? timeMatch[1] : 'unknown';
  const fingerprint = detail.slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, '').trim();
  return `${cls}:${type}:${time}:${fingerprint}`;
}

/**
 * Get all dismissed/approved issue keys for a date range — used to skip re-flagging.
 */
export function getDismissedIssueKeys(ownerUserId: string, startDate: string, endDate: string): Set<string> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT issue_key FROM calendar_dismissed_issues
    WHERE owner_user_id = ?
    AND event_date >= ? AND event_date <= ?
    AND resolution IN ('dismissed', 'approved', 'resolved')
  `).all(ownerUserId, startDate, endDate) as { issue_key: string }[];
  return new Set(rows.map(r => r.issue_key));
}

/**
 * Create or update a calendar issue. If the same issue_key already exists
 * with status 'approved' or 'dismissed', it won't be re-created.
 * Returns true if a new issue was created, false if already tracked.
 */
export function upsertCalendarIssue(
  ownerUserId: string,
  eventDate: string,
  issueType: string,
  detail: string,
  eventIds?: string[],
): boolean {
  const db = getDb();
  // v2.7.4 — pass eventIds through so fingerprint is stable across runs.
  const issueKey = buildIssueKey(issueType, detail, eventIds);

  // Check if already tracked
  const existing = db.prepare(`
    SELECT id, resolution FROM calendar_dismissed_issues
    WHERE owner_user_id = ? AND issue_key = ?
  `).get(ownerUserId, issueKey) as { id: string; resolution: string } | undefined;

  if (existing) {
    // Don't re-create approved/dismissed/resolved issues
    if (['approved', 'dismissed', 'resolved'].includes(existing.resolution)) {
      return false;
    }
    // Already tracked as 'new' or 'to_resolve' — skip
    return false;
  }

  const id = `ci_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  // v2.4.2 — eventIds now persisted into the event_ids column (was a silent
  // drop pre-v2.4.2 — column didn't exist). Enables closeMeetingArtifacts to
  // cascade-resolve issue rows when their source meetings move/update/delete.
  db.prepare(`
    INSERT INTO calendar_dismissed_issues
    (id, owner_user_id, event_date, issue_type, issue_key, detail, resolution, resolution_notes, event_ids)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)
  `).run(
    id, ownerUserId, eventDate, issueType, issueKey, detail,
    null,                                              // resolution_notes
    eventIds && eventIds.length > 0 ? JSON.stringify(eventIds) : null,
  );
  return true;
}

/**
 * v2.4.2 — Find active calendar_issue rows whose persisted event_ids JSON
 * references this meeting and mark them resolved. Called from
 * closeMeetingArtifacts on every meeting state change. Idempotent: rows
 * already in a terminal state are not re-touched.
 *
 * Match is exact — we search the JSON column for the meeting_id substring
 * (cheap, indexed by owner_user_id). We're matching event ids which are
 * opaque Graph strings like "AAMkAG...=", so substring matching has no
 * collision risk in practice.
 */
export function resolveCalendarIssuesForMeeting(
  ownerUserId: string,
  meetingId: string,
): number {
  if (!ownerUserId || !meetingId) return 0;
  const db = getDb();
  // SQLite LIKE on the JSON string. We also bound on owner_user_id so the
  // LIKE only walks rows for this owner (cheap).
  const result = db.prepare(`
    UPDATE calendar_dismissed_issues
    SET resolution = 'resolved'
    WHERE owner_user_id = ?
      AND resolution IN ('new', 'to_resolve')
      AND event_ids IS NOT NULL
      AND event_ids LIKE ?
  `).run(ownerUserId, `%${meetingId}%`);
  return result.changes;
}

/**
 * Fetch a single calendar issue by id (v1.6 — used by the calendar_fix task
 * dispatcher to re-check whether a flagged issue still exists).
 */
export function getCalendarIssueById(id: string): CalendarIssue | null {
  const db = getDb();
  return (db.prepare(`SELECT * FROM calendar_dismissed_issues WHERE id = ?`).get(id) as CalendarIssue | null) ?? null;
}

/**
 * Get all active calendar issues (not yet resolved/approved) for an owner.
 */
export function getActiveCalendarIssues(ownerUserId: string): CalendarIssue[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM calendar_dismissed_issues
    WHERE owner_user_id = ?
    AND resolution IN ('new', 'to_resolve')
    ORDER BY event_date ASC
  `).all(ownerUserId) as CalendarIssue[];
}

/**
 * Update the status of a calendar issue.
 */
export function updateCalendarIssueStatus(
  issueId: string,
  status: CalendarIssueStatus,
  notes?: string,
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE calendar_dismissed_issues
    SET resolution = ?, resolution_notes = COALESCE(?, resolution_notes)
    WHERE id = ?
  `).run(status, notes ?? null, issueId);
  return result.changes > 0;
}

/**
 * Dismiss a calendar issue (legacy compat + shortcut).
 */
export function dismissCalendarIssue(
  ownerUserId: string,
  eventDate: string,
  issueType: string,
  issueKey: string,
  detail: string,
  resolution: 'dismissed' | 'resolved' = 'dismissed',
): void {
  const db = getDb();
  const id = `cdi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT OR REPLACE INTO calendar_dismissed_issues
    (id, owner_user_id, event_date, issue_type, issue_key, detail, resolution)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, ownerUserId, eventDate, issueType, issueKey, detail, resolution);
}

/**
 * Clean up old issues (> 30 days old) to prevent table bloat.
 */
export function cleanOldDismissedIssues(): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM calendar_dismissed_issues
    WHERE event_date < date('now', '-30 days')
  `).run();
}
