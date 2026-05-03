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
 * Build a unique key for a calendar issue so we can match dismissals / dedup.
 * Format: "{type}:{time}:{subject}" — e.g. "double_booking:16:15:Weekly Sales Ops"
 */
export function buildIssueKey(type: string, detail: string): string {
  const timeMatch = detail.match(/(\d{2}:\d{2})/);
  const time = timeMatch ? timeMatch[1] : 'unknown';
  const fingerprint = detail.slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, '').trim();
  return `${type}:${time}:${fingerprint}`;
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
  const issueKey = buildIssueKey(issueType, detail);

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
