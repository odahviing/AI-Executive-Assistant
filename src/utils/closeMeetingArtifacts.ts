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
 *   1. (v3.4.6) Close matching spine REQUESTS — pending approvals are requests
 *      now (the legacy approvals table is retired). Match order: tier-0
 *      fulfillingRequestId (skip — the resolver owns it), then
 *      outcome_external_event_id, details meeting_id, and origin_thread_ts.
 *      See step 5 for the full cascade.
 *
 *   2. Close reschedule outreach whose context_json references this meeting_id, by
 *      closing its REQUEST — the lifecycle owner, which clears the row's own
 *      timers too. (The old "cancel its outreach_expiry / outreach_decision task"
 *      step went with those task types when outreach timing moved onto the spine.)
 *      Scoped to mutations that could actually settle the ask: `reason:'updated'`
 *      is skipped (it never changes the time), and 'deleted' closes 'cancelled'
 *      rather than 'resolved'. See the step for why.
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
  tasksCancelled: number;
  outreachClosed: number;
  calendarIssuesResolved: number;
}

export async function closeMeetingArtifacts(params: {
  ownerUserId: string;
  meetingId: string;
  reason: MeetingArtifactReason;
  /**
   * v2.9.2 — meeting subject, used only to compose the close-loop DM to the
   * requester (falls back to the request's own subject). Optional.
   */
  subject?: string;
  /**
   * The Slack thread the booking happened in. Used to thread-match the booking
   * to its originating colleague request via request.origin_thread_ts — far
   * more robust than exact-subject equality, which broke when a meeting's final
   * title differed from the request's working title (Dina: request "Gong call"
   * vs booked "Gong <> Reflectiz" → never closed → false expiry tombstone).
   * Optional; when absent, thread-match is skipped (only id matches run).
   */
  bookingThreadTs?: string;
  /**
   * v3.4.6 (spine collapse) — the HARD approve→book link. When this booking is
   * a resolver-driven replay fulfilling a specific request, the resolver stamps
   * that request's id here (via the replay args → tool handler). This function
   * then SKIPS that exact request — the resolver owns its close + relay right
   * after the replay returns. This is what removes the resolver-vs-cascade
   * relay race at the root: exactly one owner per booking, decided by id, not
   * reconstructed by fuzzy subject/thread match. All OTHER artifacts still
   * cascade normally.
   */
  fulfillingRequestId?: string;
}): Promise<CloseMeetingArtifactsResult> {
  const result: CloseMeetingArtifactsResult = {
    tasksCancelled: 0,
    outreachClosed: 0,
    calendarIssuesResolved: 0,
  };

  if (!params.meetingId) return result;

  try {
    const db = getDb();

    // v3.4.6 (spine collapse) — the legacy `approvals`-table scan that used to
    // live here is GONE. Nothing writes that table anymore (createApproval was
    // deleted in v3.0.6; emitWaitingOwnerApproval + create_approval write only
    // the requests spine), so the scan always matched zero rows. Pending
    // approvals are spine requests now, closed by the request cascade in step 5.

    // 2. Reschedule outreach still awaiting an outcome that references this
    // meeting. #41 — openness comes from the linked REQUEST, asked once in
    // db/jobs.ts; the rows this returns are exactly the ones there is still
    // something to close.
    //
    // A reschedule outreach asks a human about a TIME. `reason: 'updated'` is the
    // one mutation that provably did not change the time — its only call site
    // (skills/meetings/ops/handlers/moveMeeting.ts, the venue/subject/category/
    // attendee branch) passes no start/end to updateMeeting. Closing the ask there
    // recorded a false outcome ("resolved: meeting_updated") and dropped a live
    // question to a colleague because the owner renamed the meeting or recategorized
    // it. Nothing is orphaned by skipping: the ask carries its own `outreach_expiry`
    // timer (skills/meetingReschedule.ts → notifyColleagueOfMove) and the colleague's
    // reply closes it through handleRescheduleReply, so this cascade is no longer its
    // only exit.
    if (params.reason !== 'updated') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOpenRescheduleOutreach } = require('../db/jobs') as typeof import('../db/jobs');
      const matchingOutreach = getOpenRescheduleOutreach(params.ownerUserId)
        .filter(row => payloadReferencesMeeting(row.context_json, params.meetingId));

      if (matchingOutreach.length > 0) {
        // v3.1.1 — close the linked REQUEST for each match: the request owns the
        // lifecycle, so closing it IS closing the outreach, and it is what drops the
        // row out of the scan above on the next pass. `request_id` is non-null by
        // construction (the reader INNER JOINs on it), so the counter below now only
        // counts closures that actually happened.
        //
        // State matches reality, the same split step 5 already makes: the meeting
        // still exists → the ask was overtaken by a real booking → 'resolved'; the
        // meeting is GONE → there is nothing left to agree to → 'cancelled'. This
        // step used to hardcode 'resolved' for every reason, so a deleted meeting
        // closed its colleague ask as a success and the brief narrated it as one.
        const closureState = params.reason === 'deleted' ? 'cancelled' : 'resolved';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { closeRequest } = require('../core/requests/closeRequest') as typeof import('../core/requests/closeRequest');
        for (const row of matchingOutreach) {
          if (!row.request_id) continue;
          closeRequest({ id: row.request_id, state: closureState, closureReason: `meeting_${params.reason}`, closedBy: 'meeting_cascade' });
          result.outreachClosed++;
        }
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

    // 4b. (v3.7.x #143 residual #3) On DELETE, retire the colleague_booking_record's
    // requester→event link. That record is created 'resolved', so the open-state
    // request cascade in step 5 never touches it — a direct cancel is needed so a
    // deleted meeting stops surfacing as requester-actionable (a move attempt no
    // longer pings the owner about a meeting that's gone). Delete only; a MOVED
    // colleague-booked meeting stays live so the requester can still act on it.
    if (params.reason === 'deleted') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { cancelColleagueBookingRecordsForEvent } = require('../db/requests') as
          typeof import('../db/requests');
        cancelColleagueBookingRecordsForEvent(params.ownerUserId, params.meetingId);
      } catch (err) {
        logger.warn('closeMeetingArtifacts — colleague booking-record retire threw, non-fatal', {
          err: String(err).slice(0, 160), meetingId: params.meetingId,
        });
      }
    }

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
        // tier-0 skip — the resolver owns this request's close + relay.
        if (params.fulfillingRequestId && r.id === params.fulfillingRequestId) continue;
        closeRequest({
          id: r.id,
          state: 'cancelled',
          closureReason: `meeting_${params.reason}`,
          closedBy: 'meeting_cascade',
        });
      }

      // Fallback — sweep open top-level requests: match by meeting_id in
      // details_json (catches coords still in-flight whose outcome was never
      // stamped), or by origin_thread_ts thread-match (below). Bounded to open
      // state so closed rows aren't disturbed. (v2.9.2 + v3.4.6 — the old exact-
      // subject / subkind='in_flight_action' fallback tier was deleted in v3.4.6;
      // the thread-match below replaced it. See the tier note in the loop.)
      const open = getOpenRequestsForOwner(params.ownerUserId);

      // Thread-match the booking to its originating colleague request. A
      // request's origin_thread_ts is its "return address"; a booking made in
      // that same thread is fulfilling that request. This is the robust signal
      // that exact-subject equality lacked — it survives a meeting being titled
      // differently from the request (Dina: "Gong call" vs "Gong <> Reflectiz").
      // SINGLE-CANDIDATE GUARD: only auto-close when EXACTLY ONE open colleague
      // request shares the booking thread. If a colleague has two open asks in
      // one thread we don't guess (logged, left open) — never false-close.
      let threadMatchId: string | null = null;
      if (params.bookingThreadTs) {
        const threadCandidates = open.filter(r =>
          !directMatches.some(d => d.id === r.id)
          && !!r.requester_slack_id
          && r.requester_slack_id !== params.ownerUserId
          && r.origin_thread_ts === params.bookingThreadTs,
        );
        if (threadCandidates.length === 1) {
          threadMatchId = threadCandidates[0].id;
        } else if (threadCandidates.length > 1) {
          logger.info('closeMeetingArtifacts — multiple open colleague requests in booking thread, not auto-closing (ambiguous)', {
            count: threadCandidates.length,
            bookingThreadTs: params.bookingThreadTs,
            requestIds: threadCandidates.map(c => c.id),
          });
        }
      }

      for (const r of open) {
        // tier-0 skip — the resolver owns this exact request's close + relay
        // (it stamped its id into the replay). Touching it here is the race we
        // deleted: leave it entirely to the resolver.
        if (params.fulfillingRequestId && r.id === params.fulfillingRequestId) continue;
        if (directMatches.some(d => d.id === r.id)) continue;
        let matched = payloadReferencesMeeting(r.details_json, params.meetingId);

        // Colleague linkage for NON-resolver bookings (direct create, or a
        // booking that landed in a free turn): the request originated in the
        // booking's thread and is the sole open colleague candidate there.
        // Robust to the meeting being titled differently from the request
        // (Dina: "Gong call" vs "Gong <> Reflectiz"). v3.4.6 — the fragile
        // exact-subject tier that used to back this up is DELETED; tier-0
        // (resolver-driven) + this thread-match cover the real cases, and a
        // renamed meeting never false-matches a stale same-subject request.
        if (!matched && threadMatchId && r.id === threadMatchId) {
          matched = true;
          logger.info('closeMeetingArtifacts — colleague-request thread-match fired', {
            requestId: r.id, subject: r.subject,
            bookingThreadTs: params.bookingThreadTs, meetingId: params.meetingId,
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
            // v3.1 (115b) — single-notification idempotency. If the request was
            // already stamped (the resolver's notifyRequesterOfDecision, or a
            // prior cascade), don't double-DM the requester. The request owns
            // the "told them" fact; both paths honor it. No new gate — one
            // field on the spine.
            && !r.requester_notified_at
          ) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { getConnection } = require('../connections/registry') as
                typeof import('../connections/registry');
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { updateRequest } = require('../db/requests') as typeof import('../db/requests');
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
                // Stamp requester_notified_at ONLY after a confirmed ok send.
                // On failure (throw OR {ok:false}) leave it UNSET so a later
                // relay (or the next cascade) can retry — a silent send failure
                // becomes a safe retry instead of a permanent invisible drop.
                //
                // v3.4.6 — consistent requester threading: relay into the
                // requester's ORIGIN thread (MPIM channel or 1:1 DM), mirroring
                // notifyRequesterOfDecision, so the close-loop never lands as a
                // stray new top-level DM. This path only fires for NON-resolver
                // bookings now (tier-0 hands resolver-driven requests back to
                // the resolver); the resolver's own relay owns those.
                try {
                  const sent = (r.origin_is_mpim && r.origin_channel)
                    ? await conn.postToChannel(r.origin_channel, text, { threadTs: r.origin_thread_ts ?? undefined })
                    : await conn.sendDirect(r.requester_slack_id, text, { threadTs: r.origin_thread_ts ?? undefined });
                  if (sent.ok) {
                    updateRequest(r.id, { requesterNotifiedAt: new Date().toISOString() });
                    logger.info('closeMeetingArtifacts — close-loop DM sent + stamped', {
                      requestId: r.id, requesterSlackId: r.requester_slack_id, subject: subjectText,
                    });
                  } else {
                    logger.warn('closeMeetingArtifacts — close-loop DM not ok, leaving requester_notified_at unset for retry', {
                      requestId: r.id, requesterSlackId: r.requester_slack_id, reason: sent.reason,
                    });
                  }
                } catch (err) {
                  logger.warn('closeMeetingArtifacts — close-loop DM threw, leaving requester_notified_at unset for retry', {
                    requestId: r.id, requesterSlackId: r.requester_slack_id, err: String(err).slice(0, 200),
                  });
                }
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

    if (result.tasksCancelled > 0 || result.outreachClosed > 0 || result.calendarIssuesResolved > 0) {
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
