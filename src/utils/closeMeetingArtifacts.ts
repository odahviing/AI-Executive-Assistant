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
  /**
   * v2.9.2 — meeting subject. Used by the in_flight_action fallback cascade:
   * when an in_flight follow_up row was opened mid-turn (e.g. create_meeting
   * spilled) without a meeting_id in details, the meeting_id-based match
   * misses it. The subject-based fallback catches those. Optional — when
   * absent, the in_flight_action subject fallback is skipped (callers that
   * have subject in scope should pass it).
   */
  subject?: string;
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

    // 5. (v2.7.0) Close matching requests on the spine. Two match paths:
    //    (a) outcome_external_event_id directly matches (coord that already
    //        booked, request preserved the Graph id).
    //    (b) details_json references the meeting id under common keys.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getRequestsByExternalEventId, getOpenRequestsForOwner } = require('../db/requests') as
        typeof import('../db/requests');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { closeRequest } = require('../core/requests/closeRequest') as
        typeof import('../core/requests/closeRequest');

      const directMatches = getRequestsByExternalEventId(params.ownerUserId, params.meetingId);
      for (const r of directMatches) {
        closeRequest({
          id: r.id,
          state: 'cancelled',
          closureReason: `meeting_${params.reason}`,
          closedBy: 'meeting_cascade',
        });
      }

      // Fallback — sweep open top-level requests whose details_json references
      // this meetingId (catches coords still in-flight whose outcome was never
      // stamped). Bounded to open state so closed rows aren't disturbed.
      //
      // v2.9.2 — also include a SUBJECT-based fallback for in_flight_action
      // rows. Those get created mid-turn by maybeOpenInFlightMeetingRequest
      // when create_meeting spills; the row stores subject in details but the
      // meeting_id is undefined (the new event id isn't known yet). When the
      // create eventually succeeds, the meeting_id-based match never finds
      // these rows. Subject-match catches them. Scoped to subkind=
      // 'in_flight_action' to avoid false-positive matches with other request
      // kinds that happen to share a subject string.
      const open = getOpenRequestsForOwner(params.ownerUserId);
      const subjectLower = (params.subject ?? '').trim().toLowerCase();
      for (const r of open) {
        if (directMatches.some(d => d.id === r.id)) continue;
        let matched = payloadReferencesMeeting(r.details_json, params.meetingId);
        if (!matched && subjectLower && r.subkind === 'in_flight_action' && r.details_json) {
          try {
            const det = JSON.parse(r.details_json) as Record<string, unknown>;
            const detSubject = typeof det.subject === 'string' ? det.subject.toLowerCase() : '';
            if (detSubject && detSubject === subjectLower) {
              matched = true;
              logger.info('closeMeetingArtifacts — in_flight_action subject-match fallback fired', {
                requestId: r.id, subject: params.subject, meetingId: params.meetingId,
              });
            }
          } catch (_) { /* malformed details — skip */ }
        }
        // v3.0.7 — broadened subject match for colleague-initiated requests.
        // Pre-fix the subject-match fallback was scoped to `in_flight_action`
        // subkind only. But the Eli case (2026-05-26): owner amended a
        // policy_exception approval, then booked the new time via direct
        // create_meeting (not via the resolver's deferred-action replay). The
        // new meeting_id never linked back to the approval row → cascade
        // missed it → request stayed in `awaiting_colleague` forever → Eli
        // never got the close-loop "Idan locked it in" DM that Maelle had
        // promised. Broaden: any OPEN colleague-initiated request
        // (requester_slack_id set, ≠ owner) whose row subject matches the
        // booked meeting's subject is a candidate. Scoped to ensure we don't
        // false-match unrelated requests.
        if (
          !matched
          && subjectLower
          && r.requester_slack_id
          && r.requester_slack_id !== params.ownerUserId
          && r.subject
          && r.subject.trim().toLowerCase() === subjectLower
        ) {
          matched = true;
          logger.info('closeMeetingArtifacts — colleague-request subject-match fallback fired', {
            requestId: r.id, subkind: r.subkind, subject: params.subject,
            requesterSlackId: r.requester_slack_id, meetingId: params.meetingId,
          });
        }
        if (matched) {
          // v3.0.7 — close-loop DM to colleague-requester BEFORE closing the
          // request. Owner direction: requests are the canonical route; the
          // lifecycle is "owner approve → notify requester → close request".
          // Pre-fix: a colleague-initiated approval got the booking via
          // create_meeting on owner-path (not via the resolver's deferred-
          // action replay), so notifyRequesterOfDecision never fired and the
          // colleague never heard back. Maelle had promised "I'll let you
          // know once Idan responds" — broken. Fire a simple Connection DM
          // here so the loop closes regardless of which booking path ran.
          //
          // Constraints:
          //   - Only colleague-initiated requests (requester_slack_id is set
          //     and != owner).
          //   - Only positive booking reasons (created / moved / updated) —
          //     deletes have their own decline-and-relay path.
          //   - Fire-and-forget; never block the cascade or the booking.
          const positiveBooking = params.reason === 'created' || params.reason === 'moved' || params.reason === 'updated';
          if (
            r.requester_slack_id
            && r.requester_slack_id !== params.ownerUserId
            && positiveBooking
          ) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { getConnection } = require('../connections/registry') as
                typeof import('../connections/registry');
              const conn = getConnection(params.ownerUserId, 'slack');
              if (conn) {
                const requesterFirst = (r.requester_name ?? '').split(/\s+/)[0] || 'there';
                const subjectText = params.subject || r.subject || 'the meeting';
                // Voice mirrors notifyRequesterOfDecision but kept minimal —
                // the full impl with time/lang/MPIM/origin-channel routing
                // lives in core/requests/resolver.ts and runs from the
                // resolver path. This is the fallback when booking landed
                // outside the resolver.
                const text = `Hey ${requesterFirst}, locked in "${subjectText}" — calendar invite is on its way.`;
                void conn.sendDirect(r.requester_slack_id, text).catch(err => {
                  logger.warn('closeMeetingArtifacts — requester close-loop DM failed', {
                    requestId: r.id, requesterSlackId: r.requester_slack_id,
                    err: String(err).slice(0, 200),
                  });
                });
                logger.info('closeMeetingArtifacts — fired close-loop DM to colleague-requester', {
                  requestId: r.id, requesterSlackId: r.requester_slack_id, subject: subjectText,
                });
              }
            } catch (err) {
              logger.warn('closeMeetingArtifacts — requester notify path threw, continuing to close', {
                requestId: r.id, err: String(err).slice(0, 200),
              });
            }
          }
          // v3.0.7 — close state matches reality: positive booking = resolved
          // (not cancelled). Old `cancelled` reason was wrong for create/move/
          // update success cases; the linked work DID happen. Delete keeps
          // 'cancelled' since the meeting itself is gone.
          const closureState = positiveBooking ? 'resolved' : 'cancelled';
          closeRequest({
            id: r.id,
            state: closureState,
            closureReason: positiveBooking
              ? `meeting_${params.reason}_and_notified_requester`
              : `meeting_${params.reason}`,
            closedBy: 'meeting_cascade',
          });
        }
      }
    } catch (err) {
      logger.warn('closeMeetingArtifacts — request cascade threw, non-fatal', {
        err: String(err).slice(0, 200), meetingId: params.meetingId,
      });
    }

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
