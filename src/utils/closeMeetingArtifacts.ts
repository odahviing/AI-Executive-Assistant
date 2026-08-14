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
 *      outcome_external_event_id, details meeting_id, origin_thread_ts, and
 *      (v4.5.x) subject+start for an orphaned create_meeting approval that a
 *      direct tool call fulfilled with none of the above to go on.
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
 *      2a. (v4.2.x, owner decision "option C") FIRST, if `newStartIso` says this
 *      write landed on a different instant than one of those colleagues was told,
 *      relay the correction to him — closing an ask records the outcome on our
 *      side, it does not un-say what Maelle told a human. Capped at once per event
 *      per day; absent `newStartIso` ⇒ no relay. See the step for the 07-13 case.
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
import type { OutreachJob } from '../db/jobs';
import type { RequestRow } from '../core/requests/types';
import logger from './logger';

export type MeetingArtifactReason = 'created' | 'moved' | 'updated' | 'deleted';

export interface CloseMeetingArtifactsResult {
  tasksCancelled: number;
  outreachClosed: number;
  calendarIssuesResolved: number;
  /** v4.2.x — colleagues told that the time they were given no longer holds. */
  correctionsRelayed: number;
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
  /**
   * v4.2.x (owner decision "option C") — the instant this write ACTUALLY landed
   * on: post-snap, post-`verifyEventMoved`. Supplied only by mutations that moved
   * the event to a new time (the two `reason:'moved'` sites in
   * skills/meetings/ops/handlers/moveMeeting.ts).
   *
   * Its only consumer is step 2a: when a colleague has already been DM'd a time
   * for this meeting and this write contradicts it, Maelle corrects him instead of
   * silently closing his ask as "resolved".
   *
   * FAIL-SAFE BY DESIGN — absent (or `newEndIso` absent) means NO relay at all, so
   * a call site that doesn't pass it behaves exactly as it did before. The other
   * three reasons don't supply it and shouldn't: `'updated'` never changes the time
   * (and is skipped wholesale below), `'created'` is the first write for that event
   * id so it cannot void a prior notice, and `'deleted'` has no new time to state.
   */
  newStartIso?: string;
  newEndIso?: string;
  /**
   * v4.5.x — colleague-approval-orphaned-after-replay-failure-direct-book.
   * The start time THIS booking landed on, supplied only by `reason:'created'`
   * call sites. Its one consumer is step 5's orphaned-approval match: when an
   * approval's automatic replay throws (resolver.ts's on_approve catch block
   * leaves the request `awaiting_owner` for retry) and the model then books the
   * decision with a direct tool call instead of retrying `resolve_approval`,
   * that call carries no `_fulfilling_request_id` — and a brand-new event has
   * no pre-existing meeting_id for the id/details_json matches above to find
   * either. Thread-match cannot help here by design: a colleague-initiated
   * approval's `origin_thread_ts` is the colleague's own thread (R10), never
   * the owner's decision thread this booking landed in. Matching on subject +
   * exact requested start (both read off the approval's own stored
   * `deferred_action`, never re-derived) closes the gap without touching that
   * separation. FAIL-SAFE: absent, step 5's orphan tier is a no-op.
   */
  bookingStartIso?: string;
}): Promise<CloseMeetingArtifactsResult> {
  const result: CloseMeetingArtifactsResult = {
    tasksCancelled: 0,
    outreachClosed: 0,
    calendarIssuesResolved: 0,
    correctionsRelayed: 0,
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
        // 2a. (v4.2.x — owner decision "option C") CORRECT THE COLLEAGUE BEFORE
        // CLOSING HIS ASK. The closure below records the outcome on OUR side; it
        // does not un-say what Maelle already told a human.
        //
        // 2026-07-13, one event id across three writes: 04:35 the active-mode
        // autofix moved "Ysrael & Idan - BiWeekly" to Tue 14 Jul 12:45 and DM'd
        // Ysrael that time (outreach out_1783917319399_5ilp, ctx.proposed_start
        // 2026-07-14T12:45:00.000+03:00). 04:51 the owner moved it back to Mon
        // 13:30 via move_meeting — this cascade fired, matched that outreach, and
        // closed req_1783917319400_u1uu1 as `resolved / meeting_moved` (all four
        // values verified on disk). Ysrael was never told, so he held a time that
        // no longer existed, and the request recorded SUCCESS for an ask whose
        // answer had just been thrown away. 10:01 the next sweep moved it back to
        // Tue 12:45 and re-DM'd him.
        //
        // The expiry-tombstone fix on this class (reply_deadline +
        // owner_dm_channel, skills/meetingReschedule.ts) made the ask genuinely
        // end — but expiry tells the OWNER "he never replied". It cannot correct
        // the colleague. This is that missing half.
        //
        // The owner's rule, and why this needed his ruling at all: correcting a
        // false statement Maelle made to a human is not chasing; re-confirming an
        // unchanged time is. So it fires ONLY when the executed instant differs
        // from what that colleague was actually told, and at most once per event
        // per day.
        result.correctionsRelayed = await relayVoidedNotices(params, matchingOutreach);

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

    // 5. (v2.7.0) Close matching requests on the spine. Match paths, in order:
    //    (a) outcome_external_event_id directly matches (coord that already
    //        booked, request preserved the Graph id).
    //    (b) details_json references the meeting id under common keys.
    //    (c) origin_thread_ts thread-match (single-candidate guard, below).
    //    (d) (v4.5.x) orphaned-approval subject+start match (single-candidate
    //        guard, below) — for a brand-new event neither (a)/(b) nor (c) can
    //        ever fire; see findOrphanedApprovalMatch's own comment.
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
      // closeMeetingArtifacts-fulfilling-request-not-excluded (2026-08-14) —
      // exclude the tier-0 fulfilling request from the candidate pool itself,
      // mirroring directMatches' own tier-0 skip (above) and the main loop's
      // (below). Pre-fix it stayed IN `open`, so it could win the single-
      // candidate slot in threadCandidates / findOrphanedApprovalMatch — it
      // is trivially an exact subject+start match for its own booking — and
      // when a genuinely different request also matched, the pair read as
      // AMBIGUOUS (length > 1) and BOTH were left open, instead of the one
      // real match closing. The main loop's own `continue` on this id only
      // stopped it from closing itself; it never stopped it from crowding
      // out someone else's match.
      const open = getOpenRequestsForOwner(params.ownerUserId)
        .filter(r => !(params.fulfillingRequestId && r.id === params.fulfillingRequestId));

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

      // v4.5.x (colleague-approval-orphaned-after-replay-failure-direct-book) —
      // catch an approval whose auto-replay THREW (resolver.ts leaves it
      // `awaiting_owner` for retry) and was then executed by a direct tool call
      // instead of a `resolve_approval` retry, so neither the id/details_json
      // match above nor the thread-match below can ever find it: the event is
      // brand new (no pre-existing meeting_id to match on) and, for a colleague-
      // initiated approval, the owner's decision thread is never the colleague's
      // own origin thread (R10) the way `bookingThreadTs` above assumes. Matches
      // on subject + exact requested start, both read off the approval's OWN
      // stored `deferred_action` — never re-derived. SINGLE-CANDIDATE GUARD, same
      // discipline as the thread-match: ambiguous → log, leave open, never guess.
      const approvalMatchId = findOrphanedApprovalMatch(
        open.filter(r => !directMatches.some(d => d.id === r.id)),
        { reason: params.reason, subject: params.subject, bookingStartIso: params.bookingStartIso },
      );

      for (const r of open) {
        // tier-0 (the resolver owns that request's close + relay) is already
        // excluded from `open` itself, above — nothing left to skip here for it.
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
        if (!matched && approvalMatchId && r.id === approvalMatchId) {
          matched = true;
          logger.info('closeMeetingArtifacts — orphaned-approval subject+start match fired', {
            requestId: r.id, subject: r.subject,
            bookingStartIso: params.bookingStartIso, meetingId: params.meetingId,
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

    if (result.tasksCancelled > 0 || result.outreachClosed > 0 || result.calendarIssuesResolved > 0
        || result.correctionsRelayed > 0) {
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

/**
 * What a colleague was actually TOLD, read off the outreach payload that carried
 * the notice — never re-derived from thread context. `notifyColleagueOfMove`
 * writes exactly the time it states into `ctx.proposed_start`, so this is the
 * record of the claim Maelle made to that human.
 */
function readToldNotice(payloadJson: string | null | undefined): { start?: string; subject?: string } {
  if (!payloadJson) return {};
  try {
    const p = JSON.parse(payloadJson) as { proposed_start?: unknown; meeting_subject?: unknown };
    return {
      start: typeof p.proposed_start === 'string' ? p.proposed_start : undefined,
      subject: typeof p.meeting_subject === 'string' ? p.meeting_subject : undefined,
    };
  } catch (_) {
    return {};
  }
}

/**
 * Option C — tell each colleague whose stated time THIS write just voided, then
 * let the caller close their asks.
 *
 * Ordering is load-bearing: the caller snapshots the matching open notices, calls
 * this, and only then closes them. So the correction is sent while the record of
 * what was said still counts as open, and the NEW notice this creates (a fresh
 * outreach + request pair) is not in that snapshot and is therefore not closed by
 * the same pass — it becomes the new record of what the colleague was last told.
 *
 * Returns the number of colleagues actually told.
 */
async function relayVoidedNotices(
  params: {
    ownerUserId: string;
    meetingId: string;
    subject?: string;
    newStartIso?: string;
    newEndIso?: string;
  },
  openNotices: OutreachJob[],
): Promise<number> {
  // FAIL-SAFE. A call site that supplies no executed time cannot tell us whether
  // anything was voided, so nothing is said. This is what makes the two halves of
  // option C safe to land in either order.
  if (!params.newStartIso || !params.newEndIso) return 0;
  const newMs = new Date(params.newStartIso).getTime();
  if (!Number.isFinite(newMs)) return 0;

  // Only notices this write actually CONTRADICTS. Instants, not strings: the told
  // value carries an offset ("...T12:45:00.000+03:00") and the executed value is
  // formatted independently, so identical moments routinely differ as text — a
  // string compare would relay "corrections" that change nothing, which is exactly
  // the chasing the owner ruled against.
  const contradicted: Array<{ row: OutreachJob; told: string; subject?: string }> = [];
  for (const row of openNotices) {
    if (!row.colleague_slack_id) continue;
    const { start: told, subject } = readToldNotice(row.context_json);
    if (!told) continue;  // never stated a time → nothing to correct
    const toldMs = new Date(told).getTime();
    if (!Number.isFinite(toldMs) || toldMs === newMs) continue;
    contradicted.push({ row, told, subject });
  }
  if (contradicted.length === 0) return 0;

  // The owner's cap: at most ONE correction per event per day. Checked ONCE, before
  // the loop — a meeting with three notified attendees is one correction pass, not
  // three. Measured as a rolling 24h window so a flip-flop either side of midnight
  // can't slip a second correction through, and so the cap needs neither a new
  // column nor the owner's timezone.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { countCorrectionNoticesSince } = require('../db/jobs') as typeof import('../db/jobs');
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if (countCorrectionNoticesSince(params.ownerUserId, params.meetingId, since) > 0) {
    logger.info('closeMeetingArtifacts — correction already relayed for this event today, staying quiet', {
      meetingId: params.meetingId, wouldHaveTold: contradicted.length,
    });
    return 0;
  }

  // Profile carries the owner's name + timezone for the notice. Cached behind
  // loadUserProfile's profileCache, and reached only after every gate above, so
  // this costs one readdir at most once per event per day.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadAllProfiles } = require('../config/userProfile') as typeof import('../config/userProfile');
  const profile = [...loadAllProfiles().values()].find(p => p.user.slack_user_id === params.ownerUserId);
  if (!profile) {
    logger.warn('closeMeetingArtifacts — no profile for owner, voided notice NOT relayed', {
      ownerUserId: params.ownerUserId, meetingId: params.meetingId, wouldHaveTold: contradicted.length,
    });
    return 0;
  }

  // Not a hand-rolled send: the SAME function that sent the notice being corrected.
  // So the correction writes an outreach_job + its paired request (one spine, one
  // expiry, one close-loop — R2/R4), is tagged intent='meeting_reschedule' +
  // already_moved so a "that doesn't work" reply still routes through
  // handleRescheduleReply back to the owner, and cancels itself through the spine
  // if the DM never lands.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { notifyColleagueOfMove } = require('../skills/meetingReschedule') as
    typeof import('../skills/meetingReschedule');

  let relayed = 0;
  for (const { row, told, subject } of contradicted) {
    try {
      const delivered = await notifyColleagueOfMove({
        profile,
        // Channel ONLY — never this row's owner_thread_ts. On the autofix path that
        // is the pseudo-key `brief_health_<ownerId>` (tasks/briefs.ts), not a Slack
        // ts, and it would be handed straight to chat.postMessage.
        ownerChannel: row.owner_channel,
        colleagueSlackId: row.colleague_slack_id,
        colleagueName: row.colleague_name,
        colleagueTz: row.colleague_tz ?? undefined,
        meetingId: params.meetingId,
        // The name he already saw, so the correction is recognisably about the same
        // meeting even if the event has since been retitled.
        meetingSubject: subject ?? params.subject ?? 'our meeting',
        newStartIso: params.newStartIso,
        newEndIso: params.newEndIso,
        correctsToldStartIso: told,
      });
      // Count only what actually landed — an undelivered notice cancels its own
      // ask through the spine and must not be reported as a correction made.
      if (delivered) relayed++;
    } catch (err) {
      // One colleague failing must not silence the rest.
      logger.warn('closeMeetingArtifacts — voided-notice relay threw for one colleague, continuing', {
        meetingId: params.meetingId, colleague: row.colleague_name, err: String(err).slice(0, 200),
      });
    }
  }

  if (relayed > 0) {
    logger.info('closeMeetingArtifacts — corrected the time for colleagues whose notice this write voided', {
      meetingId: params.meetingId, count: relayed, newStart: params.newStartIso,
    });
  }
  return relayed;
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

/**
 * v4.5.x (colleague-approval-orphaned-after-replay-failure-direct-book) — find
 * the ONE open `create_meeting` approval this freshly-booked meeting fulfills,
 * when nothing stamped `_fulfilling_request_id` and there was no pre-existing
 * meeting_id or shared thread to match on (see the call site's comment for the
 * full scenario). Reads the approval's OWN stored `deferred_action` — the exact
 * tool + args the resolver would have replayed — never re-derives from subject
 * text alone (that fragile tier was deleted in v3.4.6 for good reason: a
 * renamed meeting must never false-match a stale same-subject request). The
 * exact-start requirement is what makes subject reuse safe again: two asks
 * that happen to share a subject essentially never share the same instant too.
 */
function findOrphanedApprovalMatch(
  candidates: RequestRow[],
  params: { reason: MeetingArtifactReason; subject?: string; bookingStartIso?: string },
): string | null {
  if (params.reason !== 'created' || !params.subject || !params.bookingStartIso) return null;
  const bookingMs = new Date(params.bookingStartIso).getTime();
  if (!Number.isFinite(bookingMs)) return null;
  const wantSubject = params.subject.trim().toLowerCase();

  const matches = candidates.filter(r => {
    if (r.kind !== 'approval') return false;
    if (!r.requester_slack_id) return false;
    if (r.subject.trim().toLowerCase() !== wantSubject) return false;
    if (!r.details_json) return false;
    try {
      const details = JSON.parse(r.details_json) as {
        deferred_action?: { tool?: string; args?: { start?: string } };
      };
      if (details.deferred_action?.tool !== 'create_meeting') return false;
      const askedStart = details.deferred_action.args?.start;
      if (typeof askedStart !== 'string') return false;
      const askedMs = new Date(askedStart).getTime();
      return Number.isFinite(askedMs) && askedMs === bookingMs;
    } catch (_) {
      return false;
    }
  });

  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    logger.info('closeMeetingArtifacts — multiple open approvals match this booking by subject+start, not auto-closing (ambiguous)', {
      count: matches.length, subject: params.subject, requestIds: matches.map(m => m.id),
    });
  }
  return null;
}
