/**
 * Centralized cleanup for any meeting state change (v2.1.6, extended v2.4.2).
 *
 * Every meeting mutation — create / move / update / delete — can leave stale
 * artifacts in the DB: pending approvals the owner was asked about, reminder
 * tasks tracking the outcome, outreach rows tracking a colleague's reply,
 * and calendar-health issue rows tracking known overlaps / OOF conflicts.
 * Each mutation site had to remember to close them, and they didn't.
 *
 * This helper is the single choke point. Call it after a successful meeting
 * mutation and it will:
 *
 *   1. Resolve pending approvals whose payload references this meeting_id
 *      (keys: meeting_id / existing_event_id / event_id / external_event_id).
 *      Cancels their sibling approval_expiry + approval_reminder tasks via
 *      the existing setApprovalDecision cascade.
 *
 *   2. Close outreach_jobs with intent='meeting_reschedule' whose context_json
 *      references this meeting_id. Cancels their outreach_expiry +
 *      outreach_decision follow-up tasks.
 *
 *   3. Cancel open follow_up / reminder tasks whose payload_json references
 *      this meeting_id. These are Sonnet-created "remind me to update Yael"
 *      style tasks; the cascade fires when meeting_id is in the payload.
 *
 *   4. (v2.4.2) Resolve open calendar_dismissed_issues rows whose persisted
 *      event_ids JSON references this meeting_id. Closes the long-standing
 *      gap where issue rows accumulated for weeks ("carry-over from last
 *      week" surfacing in active-mode health checks) because the source
 *      meeting moved/recategorized but the issue row stayed at status='new'.
 *      Pre-v2.4.2 the event_ids column didn't exist (column-less ALTER
 *      shipped same release) so older rows can't be cascaded — they need a
 *      one-shot DB cleanup. Forward-going rows cascade cleanly.
 *
 * The cascade is additive to the coord-terminal cascade in updateCoordJob.
 * Double-cascading is idempotent — an already-resolved approval / issue won't
 * match the active-status filter.
 *
 * Never throws. A DB error here must never undo a successful calendar
 * mutation — the calendar is source of truth; DB cleanup is best-effort.
 */
import { getDb } from '../db';
import { resolveCalendarIssuesForMeeting } from '../db/calendarIssues';
import logger from './logger';

export type MeetingArtifactReason = 'created' | 'moved' | 'updated' | 'deleted';

export interface CloseMeetingArtifactsResult {
  approvalsResolved: number;
  tasksCancelled: number;
  outreachClosed: number;
  calendarIssuesResolved: number;
}

export function closeMeetingArtifacts(params: {
  ownerUserId: string;
  meetingId: string;
  reason: MeetingArtifactReason;
}): CloseMeetingArtifactsResult {
  const result: CloseMeetingArtifactsResult = {
    approvalsResolved: 0,
    tasksCancelled: 0,
    outreachClosed: 0,
    calendarIssuesResolved: 0,
  };

  if (!params.meetingId) return result;

  try {
    const db = getDb();

    // 1. Pending approvals whose payload references this meeting
    const pendingApprovals = db.prepare(`
      SELECT id, payload_json FROM approvals
      WHERE owner_user_id = ? AND status = 'pending'
    `).all(params.ownerUserId) as Array<{ id: string; payload_json: string }>;

    const matchingApprovalIds: string[] = [];
    for (const row of pendingApprovals) {
      if (payloadReferencesMeeting(row.payload_json, params.meetingId)) {
        matchingApprovalIds.push(row.id);
      }
    }

    if (matchingApprovalIds.length > 0) {
      const decisionJson = JSON.stringify({
        auto_synced: true,
        closed_by: 'meeting_artifact_cleanup',
        reason: params.reason,
        meeting_id: params.meetingId,
      });
      const resolveStmt = db.prepare(`
        UPDATE approvals
        SET status = 'superseded',
            decision_json = COALESCE(decision_json, @decision_json),
            responded_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = @id
      `);
      const cancelApprovalTasksStmt = db.prepare(`
        UPDATE tasks
        SET status = 'cancelled', updated_at = datetime('now')
        WHERE type IN ('approval_expiry', 'approval_reminder')
          AND skill_ref = @approval_id
          AND status IN ('new','scheduled','in_progress','pending_owner')
      `);
      for (const approvalId of matchingApprovalIds) {
        resolveStmt.run({ id: approvalId, decision_json: decisionJson });
        cancelApprovalTasksStmt.run({ approval_id: approvalId });
        result.approvalsResolved++;
      }
    }

    // 2. Outreach jobs with intent='meeting_reschedule' referencing this meeting
    const outreachRows = db.prepare(`
      SELECT id, context_json FROM outreach_jobs
      WHERE owner_user_id = ?
        AND intent = 'meeting_reschedule'
        AND status IN ('sent', 'no_response', 'replied')
    `).all(params.ownerUserId) as Array<{ id: string; context_json: string }>;

    const matchingOutreachIds: string[] = [];
    for (const row of outreachRows) {
      if (payloadReferencesMeeting(row.context_json, params.meetingId)) {
        matchingOutreachIds.push(row.id);
      }
    }

    if (matchingOutreachIds.length > 0) {
      const closeOutreachStmt = db.prepare(`
        UPDATE outreach_jobs
        SET status = 'done', updated_at = datetime('now')
        WHERE id = ?
      `);
      const cancelOutreachTasksStmt = db.prepare(`
        UPDATE tasks
        SET status = 'cancelled', updated_at = datetime('now')
        WHERE type IN ('outreach_expiry', 'outreach_decision')
          AND skill_ref = ?
          AND status IN ('new','scheduled','in_progress','pending_owner','pending_colleague')
      `);
      for (const outreachId of matchingOutreachIds) {
        closeOutreachStmt.run(outreachId);
        cancelOutreachTasksStmt.run(outreachId);
        result.outreachClosed++;
      }
    }

    // 3. Open follow_up / reminder tasks whose context references this meeting.
    // v2.4.2 — was querying payload_json which doesn't exist on `tasks` (it
    // exists on `approvals`). The query threw `SqliteError: no such column`
    // on every meeting mutation since v2.1.6, caught by the outer try/catch
    // and logged as warn. Functional impact: the third cascade target never
    // fired — stale follow_up/reminder tasks referencing moved/deleted
    // meetings stayed open indefinitely. Tasks table column is `context`.
    const openTasks = db.prepare(`
      SELECT id, context FROM tasks
      WHERE owner_user_id = ?
        AND type IN ('follow_up', 'reminder')
        AND status IN ('new','scheduled','in_progress','pending_owner','pending_colleague')
    `).all(params.ownerUserId) as Array<{ id: string; context: string }>;

    const matchingTaskIds: string[] = [];
    for (const row of openTasks) {
      if (payloadReferencesMeeting(row.context, params.meetingId)) {
        matchingTaskIds.push(row.id);
      }
    }

    if (matchingTaskIds.length > 0) {
      const cancelTaskStmt = db.prepare(`
        UPDATE tasks
        SET status = 'cancelled', updated_at = datetime('now')
        WHERE id = ?
      `);
      for (const taskId of matchingTaskIds) {
        cancelTaskStmt.run(taskId);
        result.tasksCancelled++;
      }
    }

    // 4. (v2.4.2) Resolve calendar_dismissed_issues rows referencing this meeting
    result.calendarIssuesResolved = resolveCalendarIssuesForMeeting(
      params.ownerUserId,
      params.meetingId,
    );

    if (result.approvalsResolved > 0 || result.tasksCancelled > 0 || result.outreachClosed > 0 || result.calendarIssuesResolved > 0) {
      logger.info('closeMeetingArtifacts — cascade fired', {
        meetingId: params.meetingId,
        reason: params.reason,
        ...result,
      });
    }
  } catch (err) {
    // Never let this break the mutation itself. Calendar is source of truth.
    logger.warn('closeMeetingArtifacts threw — non-fatal, mutation still succeeded', {
      err: String(err), meetingId: params.meetingId, reason: params.reason,
    });
  }

  return result;
}

function payloadReferencesMeeting(payloadJson: string | null | undefined, meetingId: string): boolean {
  if (!payloadJson) return false;
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const candidateKeys = ['meeting_id', 'existing_event_id', 'event_id', 'external_event_id'];
    for (const key of candidateKeys) {
      if (payload[key] === meetingId) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}
