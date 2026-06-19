/**
 * Requests resolver (v2.7.0) — replaces core/approvals/resolver.ts.
 *
 * Single entry point for owner-decision side-effects. The orchestrator never
 * calls book/cancel/DM directly; it calls resolveRequest with the request id
 * and a verdict. This file owns per-kind downstream behavior — booking the
 * meeting on slot_pick approval, notifying the requester, etc.
 *
 * Then it calls closeRequest, which is the single closure entry. All audit,
 * cascade, and timer-clearing happen there.
 */

import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../../config/userProfile';
import { getRequest, mergeRequestDetails, updateRequest } from '../../db/requests';
import { closeRequest } from './closeRequest';
import type { RequestRow } from './types';
import { parseDetails } from './types';
import { getFreeBusy } from '../../connectors/graph/calendar';
import { runPostBookingHealthCheck } from '../../utils/postBookingHealthCheck';
import { getCoordBookingHandler } from '../approvals/coordBookingHandler';
import {
  extractCallbacks,
  mergeAmendIntoApprove,
  RESOLVER_REPLAY_TOOLS,
  type ToolCallback,
} from '../approvals/approvalCallbacks';
import { runDeferredAction } from './deferredActionReplay';
import logger from '../../utils/logger';

export type ResolveVerdict =
  | { verdict: 'approve'; data?: Record<string, unknown> }
  | { verdict: 'reject'; reason?: string }
  | { verdict: 'amend'; counter: Record<string, unknown>; reason?: string }
  | { verdict: 'cancel'; reason?: string };

export interface ResolveContext {
  app?: App;
  profile: UserProfile;
  /**
   * v3.1.3 — set by the CALLER: true only when the COLLEAGUE (requester) is the
   * one resolving — i.e. responding to the owner's relayed counter on an
   * amending approval (resolve_approval invoked on the colleague path,
   * senderRole !== 'owner'). False/undefined for every owner-driven resolve
   * (owner's resolve_approval, emoji reaction, thread-bound auto-resolve).
   *
   * This is the ACTOR, distinct from the row's STATE. The bounce-back logic
   * (reject/amend while awaiting_colleague) must fire ONLY when the colleague
   * is acting — otherwise an OWNER reject on an awaiting_colleague row (e.g.
   * "close it, already booked") gets misread as "the colleague rejected my
   * counter" and bounced back to awaiting_owner instead of closing. That was
   * the Eli ghost: an owner reject silently turned into a bounce.
   */
  resolvedByColleague?: boolean;
  /**
   * Derived inside resolveRequest = (row.state === 'awaiting_colleague' &&
   * resolvedByColleague). Used by notifyRequesterOfDecision to pick relay
   * phrasing (a colleague-accepted counter shouldn't be credited as "owner
   * said yes").
   */
  wasAwaitingColleague?: boolean;
}

export interface ResolveResult {
  ok: boolean;
  request_id: string;
  state: RequestRow['state'];
  effect?: string;
  reason?: string;
  subject?: string;
  slot?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * v3.4.2 (2.2 close-loop) — grace window for the "owner approved, fulfilling
 * action pending" hold. The booking/cancel that fulfills an approved colleague
 * request is almost always a separate later tool call (the slot wasn't known at
 * approve time, or Sonnet books it in a follow-up turn). We keep the request
 * OPEN this long so that action can reconnect via closeMeetingArtifacts and the
 * requester hears the CONCRETE outcome ("booked Mon 17:00"). If nothing lands
 * in the window, approval_action_timeout relays a neutral "owner signed off" so
 * the requester is never left hanging. Tunable; favors catching the booking
 * over relaying a bare "yes" instantly.
 */
const APPROVAL_ACTION_GRACE_HOURS = 4;

/**
 * Should this approved request stay OPEN until its fulfilling action lands,
 * instead of closing now? True for a colleague-requested approval the OWNER
 * just approved with NO replayable action wired — the classic dead-end where
 * closing at approve orphans the later booking/cancel so the requester never
 * hears the concrete result (Daniel never heard "booked Mon 17:00").
 *
 * Scoped deliberately:
 *   - kind='approval' only (coord/outreach own their own lifecycle).
 *   - a real colleague requester (not owner-internal, where there's nobody to
 *     loop back to — those just close).
 *   - owner-resolving only (NOT ctx.wasAwaitingColleague — the colleague-
 *     accepts-counter path keeps its bespoke "locked in" phrasing).
 */
function shouldHoldForFulfillingAction(row: RequestRow, ctx: ResolveContext): boolean {
  return row.kind === 'approval'
    && !!row.requester_slack_id
    && row.requester_slack_id !== row.owner_user_id
    && !ctx.wasAwaitingColleague;
}

/**
 * Keep an approved colleague request OPEN (state=in_flight) and arm a grace
 * timer instead of closing + notifying now. The fulfilling booking/cancel will
 * reconnect via closeMeetingArtifacts' open-request scan and fire the concrete
 * close-loop DM; approval_action_timeout is the safety net if it never lands.
 * Deliberately does NOT notify the requester yet — that's the whole point.
 */
function holdForFulfillingAction(row: RequestRow, approveData: Record<string, unknown>): ResolveResult {
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  updateRequest(row.id, {
    state: 'in_flight',
    details: {
      ...details,
      awaiting_fulfilling_action: true,
      approved_at: DateTime.now().toISO(),
      approve_data: approveData,
    },
    nextCheckAt: DateTime.now().plus({ hours: APPROVAL_ACTION_GRACE_HOURS }).toUTC().toISO(),
    nextCheckHandler: 'approval_action_timeout',
  });
  logger.info('resolveRequest — owner approved, holding open for the fulfilling action to reconnect (close-loop 2.2)', {
    id: row.id, requester: row.requester_slack_id, graceHours: APPROVAL_ACTION_GRACE_HOURS,
  });
  return {
    ok: true,
    request_id: row.id,
    state: 'in_flight',
    effect: 'approved — held open so the booking/cancel closes the loop with the concrete result',
  };
}

/**
 * Owner-busy freshness re-check before committing a slot_pick booking. Reads
 * FRESH (forceRefresh) — the owner's calendar drifts while an approval sits,
 * and a STALE cache hit is exactly what bounced a real booking over a slot that
 * was actually free (the Isaac incident: the recheck read "busy" from a 5-min
 * cache while a fresh search showed the slot open). Only the OWNER is checked:
 * a colleague's busy is a HELPER surfaced when slots are offered, never a
 * commit-time blocker — the owner can book over anyone (owner rule 6).
 *
 * Returns a reason if the owner is now busy, else null. Graph failure → null
 * (a freshness-API blip shouldn't block all approvals).
 */
async function recheckOwnerFreeForBooking(args: {
  ownerEmail: string;
  startIso: string;
  endIso: string;
  timezone: string;
}): Promise<string | null> {
  try {
    const busy = await getFreeBusy(
      args.ownerEmail,
      [args.ownerEmail],
      args.startIso,
      args.endIso,
      args.timezone,
      true,   // forceRefresh — freshness is the entire point of a pre-commit recheck
    );
    const cStart = DateTime.fromISO(args.startIso).toMillis();
    const cEnd = DateTime.fromISO(args.endIso).toMillis();
    const ownerEmailLower = args.ownerEmail.toLowerCase();
    for (const [email, slots] of Object.entries(busy)) {
      if (email.toLowerCase() !== ownerEmailLower) continue;
      const conflict = slots.find(s => {
        if (s.status !== 'busy' && s.status !== 'tentative' && s.status !== 'oof') return false;
        const sStart = DateTime.fromISO(s.start).toMillis();
        const sEnd = DateTime.fromISO(s.end).toMillis();
        return sStart < cEnd && sEnd > cStart;
      });
      if (conflict) return `you're ${conflict.status}`;
    }
  } catch (err) {
    logger.warn('recheckOwnerFreeForBooking — Graph call failed, proceeding', {
      err: String(err).slice(0, 200),
    });
  }
  return null;
}

// ── Entry ───────────────────────────────────────────────────────────────────

export async function resolveRequest(
  requestId: string,
  verdict: ResolveVerdict,
  ctx: ResolveContext,
): Promise<ResolveResult> {
  const row = getRequest(requestId);
  if (!row) {
    // v3.0.5 — surface this. Pre-fix this return was completely silent:
    // when Sonnet passed a malformed id (`#req_…`, or a hallucinated id),
    // getRequest returned null, the resolver returned a polite "request not
    // found" with NO log entry, and the calling tool result looked like a
    // generic failure to the next iteration. Across a day this manifested
    // as "approval never closes" symptoms where the only thing tracking the
    // failure was the v2.4.2 closeLoopOnOwnerHandled scanner running hours
    // later. Loud log here lets us catch the next instance immediately.
    logger.warn('resolveRequest — requestId not found in DB', {
      requestId,
      verdict: verdict.verdict,
    });
    return { ok: false, request_id: requestId, state: 'cancelled', reason: 'request not found' };
  }
  // v2.9.1 — `awaiting_colleague` is the amending state (owner counter relayed
  // to requester); requester's response resolves the request. Both states are
  // valid entry points for resolveRequest.
  if (row.state !== 'awaiting_owner' && row.state !== 'awaiting_colleague') {
    logger.warn('resolveRequest called on non-pending request', {
      id: requestId, state: row.state, kind: row.kind,
    });
    return {
      ok: false,
      request_id: requestId,
      state: row.state,
      reason: `request is in state ${row.state}; only awaiting_owner / awaiting_colleague can be resolved`,
    };
  }

  logger.info('resolveRequest', {
    id: requestId, kind: row.kind, subkind: row.subkind, verdict: verdict.verdict,
  });

  // v2.9.1 — universal callback table. Every approval kind reads on_approve /
  // on_reject / on_amend from details_json.callbacks (with legacy fallback to
  // deferred_action via extractCallbacks). Resolver dispatches uniformly.
  const detailsAll = parseDetails<Record<string, unknown>>(row) ?? {};
  const callbacks = extractCallbacks(detailsAll);

  // v2.9.1 — direction of the resolution. When state=awaiting_owner the
  // owner is replying; when state=awaiting_colleague the requester is
  // replying to owner's counter (amend bounce-back path).
  // v3.1.3 — gate on the ACTOR, not just the state. Bounce-back only when the
  // COLLEAGUE is resolving an awaiting_colleague row. An owner reject/amend on
  // such a row (he's overriding / closing) must NOT bounce — it must resolve.
  const wasAwaitingColleague = row.state === 'awaiting_colleague' && ctx.resolvedByColleague === true;
  // Stamp the flag on ctx so downstream helpers (notifyRequesterOfDecision)
  // can branch relay phrasing on actor direction without each call site
  // threading an extra param.
  ctx.wasAwaitingColleague = wasAwaitingColleague;

  // ── reject / cancel ────────────────────────────────────────────────────
  if (verdict.verdict === 'reject' || verdict.verdict === 'cancel') {
    const reason = verdict.reason ?? `owner ${verdict.verdict}ed`;

    // v2.9.1 — colleague rejecting owner's counter (amending state). Don't
    // close; bounce back to awaiting_owner so owner sees "Yael says no to
    // 14:00 — what now?". Owner can then amend again with a different time,
    // or reject which cascades to a real closure.
    if (wasAwaitingColleague) {
      const detailsAfter = parseDetails<Record<string, unknown>>(row) ?? {};
      updateRequest(requestId, {
        state: 'awaiting_owner',
        details: {
          ...detailsAfter,
          colleague_pushback: verdict.reason ?? 'said no to counter',
          bounced_back_at: DateTime.now().toISO(),
        },
      });
      // Notify OWNER (not requester) about the pushback.
      await notifyOwnerOfColleaguePushback(row, 'reject', verdict.reason, ctx);
      return {
        ok: true, request_id: requestId, state: 'awaiting_owner',
        effect: 'colleague rejected counter — bounced back to owner',
      };
    }

    // on_reject side-effect — fire-and-forget tool (e.g. release a hold,
    // notify a queue). Most rejects don't define this; the default path is
    // just close + notify requester.
    if (callbacks.on_reject && RESOLVER_REPLAY_TOOLS.has(callbacks.on_reject.tool)) {
      const replayArgs: Record<string, unknown> = { ...callbacks.on_reject.args };
      logger.info('resolveRequest — on_reject side-effect firing', {
        id: requestId, tool: callbacks.on_reject.tool,
      });
      const tool = callbacks.on_reject.tool;
      setImmediate(async () => {
        try {
          await runDeferredAction({
            ownerUserId: row.owner_user_id,
            profile: ctx.profile,
            tool,
            args: replayArgs,
            requestId: row.id,
          });
        } catch (err) {
          logger.warn('on_reject replay threw — non-fatal', {
            id: row.id, tool, err: String(err).slice(0, 300),
          });
        }
      });
    }

    closeRequest({
      id: requestId,
      state: 'cancelled',
      closureReason: reason,
      closedBy: 'owner',
    });
    await notifyRequesterOfDecision(row, 'reject', null, verdict.reason, ctx);
    return {
      ok: true, request_id: requestId, state: 'cancelled',
      effect: `${verdict.verdict}ed; linked work cancelled`,
    };
  }

  // ── amend ──────────────────────────────────────────────────────────────
  if (verdict.verdict === 'amend') {
    const amendMode = callbacks.on_amend?.mode ?? 'relay_to_requester';
    const amendRound = ((detailsAll.amend_round as number | undefined) ?? 0) + 1;

    // v2.9.1 — colleague countering owner's counter (amending state). Bounce
    // back to awaiting_owner; owner sees "Yael said: not 14:00, how about
    // 15:30?". Owner re-decides. Same round-cap protection.
    const MAX_AMEND_ROUNDS_BOUNCE = 5;
    if (wasAwaitingColleague) {
      if (amendRound > MAX_AMEND_ROUNDS_BOUNCE) {
        logger.warn('resolveRequest — colleague-counter amend round cap hit', {
          id: requestId, round: amendRound,
        });
        closeRequest({
          id: requestId,
          state: 'expired',
          closureReason: `amend ping-pong exceeded ${MAX_AMEND_ROUNDS_BOUNCE} rounds`,
          closedBy: 'expiry',
        });
        await notifyRequesterOfDecision(row, 'reject', null, 'too many rounds — closing', ctx);
        return { ok: true, request_id: requestId, state: 'expired', effect: 'amend cap hit' };
      }
      // v2.9.1 — store latest counter in details.counter (regardless of who
      // sent it) so the eventual approve-merge picks up the most recent
      // alternative. counter_history tracks the full chain for audit.
      const counterHistory = Array.isArray(detailsAll.counter_history)
        ? (detailsAll.counter_history as Array<Record<string, unknown>>)
        : [];
      counterHistory.push({ by: 'colleague', counter: verdict.counter, at: DateTime.now().toISO() });
      updateRequest(requestId, {
        state: 'awaiting_owner',
        details: {
          ...detailsAll,
          counter: verdict.counter,
          counter_history: counterHistory,
          amend_round: amendRound,
          amended_at: DateTime.now().toISO(),
          amended_by: 'colleague',
        },
      });
      // Notify OWNER about the colleague's counter-counter.
      await notifyOwnerOfColleaguePushback(row, 'amend', verdict.reason, ctx, verdict.counter);
      return {
        ok: true, request_id: requestId, state: 'awaiting_owner',
        effect: `colleague counter-amend bounced back to owner (round ${amendRound})`,
      };
    }

    // run_with_amend → counter merges into on_approve.args and fires
    // immediately. Used when owner's amend is a simple parameter change
    // that doesn't need requester sign-off (e.g. "yes, but make it 13:30
    // instead of 13:00" on a meeting owner is hosting where attendees
    // don't decide times).
    if (amendMode === 'run_with_amend' && callbacks.on_approve) {
      const merged = mergeAmendIntoApprove(callbacks.on_approve, verdict.counter);
      logger.info('resolveRequest — amend run_with_amend, firing on_approve with merged args', {
        id: requestId, tool: merged.tool, round: amendRound,
      });
      return runApproveCallback(row, merged, ctx, { mergedFromAmend: true, amendRound });
    }

    // relay_to_requester (default) → state flips to awaiting_colleague,
    // Maelle DMs requester with the counter for their yes/no. When the
    // requester responds in their thread, orchestrator picks it up via
    // PENDING APPROVALS prompt block + Sonnet calls resolve_approval.
    //
    // Cap rounds to prevent infinite ping-pong (owner counters, requester
    // counters, owner counters again, …). Default cap 5; after that the
    // request expires.
    const MAX_AMEND_ROUNDS = 5;
    if (amendRound > MAX_AMEND_ROUNDS) {
      logger.warn('resolveRequest — amend round cap hit, closing as expired', {
        id: requestId, round: amendRound, cap: MAX_AMEND_ROUNDS,
      });
      closeRequest({
        id: requestId,
        state: 'expired',
        closureReason: `amend ping-pong exceeded ${MAX_AMEND_ROUNDS} rounds`,
        closedBy: 'expiry',
      });
      await notifyRequesterOfDecision(row, 'reject', null, 'too many rounds — closing', ctx);
      return { ok: true, request_id: requestId, state: 'expired', effect: 'amend cap hit' };
    }

    // v2.9.1 — append to counter_history for audit; counter holds the latest.
    const counterHistoryOwnerSide = Array.isArray(detailsAll.counter_history)
      ? (detailsAll.counter_history as Array<Record<string, unknown>>)
      : [];
    counterHistoryOwnerSide.push({ by: 'owner', counter: verdict.counter, at: DateTime.now().toISO() });
    updateRequest(requestId, {
      state: 'awaiting_colleague',
      details: {
        ...detailsAll,
        counter: verdict.counter,
        counter_history: counterHistoryOwnerSide,
        amend_round: amendRound,
        amended_at: DateTime.now().toISO(),
        amended_by: 'owner',
      },
    });
    await notifyRequesterOfDecision(row, 'amend', verdict.counter, verdict.reason, ctx);
    return {
      ok: true, request_id: requestId, state: 'awaiting_colleague',
      effect: `owner counter relayed to requester (round ${amendRound})`,
    };
  }

  // ── approve ────────────────────────────────────────────────────────────
  const approveData = verdict.data ?? {};

  // Slot-pick / calendar-conflict subkinds retain their bespoke booking
  // flow (freshness re-check, coord_job lookup, idempotency guard). Those
  // paths predate the callback model and run the booking themselves.
  if ((row.kind === 'approval' || row.kind === 'coord')
      && (row.subkind === 'slot_pick' || row.subkind === 'calendar_conflict')) {
    return resolveSlotPickApproval(row, approveData, ctx);
  }

  // v2.9.1 — universal approve path: read on_approve and dispatch.
  // - If callbacks.on_approve.tool is in RESOLVER_REPLAY_TOOLS → replay it
  //   (with relaxed=true / confirm_outside_window=true override flag).
  // - If on_approve is absent → close + notify (Sonnet handles the implied
  //   work next turn; Module D Y.2 should have already gated this case).
  //
  // v2.9.1 counter-merge: if details.counter is present (set by ANY amend
  // round, owner or colleague), merge it into on_approve.args. The counter
  // holds the LATEST alternative regardless of state — owner approving
  // after a colleague counter-amend uses the colleague's counter; colleague
  // accepting owner's counter uses the owner's counter. counter_history
  // keeps the full audit chain.
  let effectiveApprove: ToolCallback | undefined = callbacks.on_approve;
  const latestCounter = (detailsAll.counter as Record<string, unknown> | undefined) ?? null;
  const hasCounter = latestCounter && Object.keys(latestCounter).length > 0;
  if (hasCounter && callbacks.on_approve) {
    effectiveApprove = mergeAmendIntoApprove(callbacks.on_approve, latestCounter);
    logger.info('resolveRequest — approve with prior counter, merging into on_approve', {
      id: requestId, tool: effectiveApprove.tool,
      counterPreview: JSON.stringify(latestCounter).slice(0, 120),
      amendedBy: detailsAll.amended_by,
    });
  }

  // v3.2.1 (#120 / Yariv) — carry a location-mode answer from resolve_approval
  // `data` into the replayed action. When a move/create deferred action lands
  // on the ask_owner_online_or_physical branch (external attendee, unknown TZ,
  // office day), the replay errors `location_mode_unspecified` and the owner's
  // later "online" / "in person" had nowhere to go — every retry re-hit the
  // same wall (the Yariv loop). Now the owner answers via resolve_approval
  // data:{is_online} / data:{location}; we merge it into the action args so the
  // replay resolves the location instead of re-asking. is_online flows to
  // move_meeting/create_meeting as isOnlineHint → resolveLocation resolves it.
  if (effectiveApprove
      && (typeof approveData.is_online === 'boolean'
          || (typeof approveData.location === 'string' && approveData.location.trim().length > 0))) {
    const mergedArgs: Record<string, unknown> = { ...effectiveApprove.args };
    if (typeof approveData.is_online === 'boolean') mergedArgs.is_online = approveData.is_online;
    if (typeof approveData.location === 'string' && approveData.location.trim().length > 0) {
      mergedArgs.location = approveData.location.trim();
    }
    effectiveApprove = { ...effectiveApprove, args: mergedArgs };
    logger.info('resolveRequest — merged location-mode answer from approve data into replay args', {
      id: requestId, tool: effectiveApprove.tool,
      is_online: approveData.is_online, location: approveData.location,
    });
  }

  if (effectiveApprove) {
    return runApproveCallback(row, effectiveApprove, ctx, {
      mergedFromAmend: !!hasCounter,
      amendRound: (detailsAll.amend_round as number | undefined) ?? 0,
    });
  }

  // No on_approve — the fulfilling work (book/cancel) is a separate later step
  // that Sonnet does next. v3.4.2 (2.2 close-loop): for a colleague-requested
  // approval, DON'T close + notify now — that's the dead-end. Closing here marks
  // the request terminal, so when the booking lands later closeMeetingArtifacts
  // (which only scans OPEN requests) can't reconnect, and the requester never
  // hears the concrete outcome. Hold it open instead; the booking reconnects and
  // notifies with the real result, and a grace timer is the safety net.
  if (shouldHoldForFulfillingAction(row, ctx)) {
    return holdForFulfillingAction(row, approveData);
  }
  closeRequest({
    id: requestId,
    state: 'resolved',
    closureReason: `owner approved ${row.subkind ?? row.kind}`,
    closedBy: 'owner',
    outcomeJson: { approved: true, data: approveData },
  });
  await notifyRequesterOfDecision(row, 'approve', approveData, undefined, ctx);
  return {
    ok: true, request_id: requestId, state: 'resolved',
    effect: `approved ${row.kind}/${row.subkind ?? '-'} (no callback, Sonnet handles work)`,
  };
}

/**
 * Shared "fire on_approve + close + notify" helper. Used by direct approve
 * verdicts AND by amend's run_with_amend mode (which routes through this
 * with merged args).
 */
async function runApproveCallback(
  row: RequestRow,
  approveCallback: ToolCallback,
  ctx: ResolveContext,
  meta: { mergedFromAmend: boolean; amendRound: number },
): Promise<ResolveResult> {
  const { tool, args } = approveCallback;

  if (!RESOLVER_REPLAY_TOOLS.has(tool)) {
    // Unknown tool — close as resolved but don't replay. Sonnet's next turn
    // can pick up the resolution if needed.
    logger.warn('resolveRequest — on_approve tool not replayable, closing without firing', {
      id: row.id, tool,
    });
    // v3.4.2 (2.2 close-loop) — same dead-end guard as the no-callback path: a
    // colleague-requested approval whose action runs as a separate later step
    // must stay open so the booking/cancel can reconnect + notify with the
    // concrete result, rather than closing here and orphaning it.
    if (shouldHoldForFulfillingAction(row, ctx)) {
      return holdForFulfillingAction(row, {});
    }
    closeRequest({
      id: row.id,
      state: 'resolved',
      closureReason: `owner approved ${row.subkind ?? row.kind} (on_approve.tool=${tool} not replayable)`,
      closedBy: 'owner',
      outcomeJson: { approved: true, on_approve_tool: tool },
    });
    await notifyRequesterOfDecision(row, 'approve', {}, undefined, ctx);
    return { ok: true, request_id: row.id, state: 'resolved', effect: 'approved (no replay)' };
  }

  // Inject the override flag matching the tool. Same semantics as the
  // legacy deferred_action replay (v2.7.2 / v2.8.6).
  const replayArgs: Record<string, unknown> = { ...args };
  if (tool === 'book_floating_block') {
    replayArgs.confirm_outside_window = true;
  } else if (tool !== 'delete_meeting') {
    replayArgs.relaxed = true;
  }

  logger.info('resolveRequest — on_approve replay', {
    id: row.id, tool, kind: row.kind, subkind: row.subkind,
    mergedFromAmend: meta.mergedFromAmend, amendRound: meta.amendRound,
  });

  // No attendee freshness re-check on an approved policy_exception replay. The
  // owner already SAW the conflict in the approval ask and approved it — a
  // colleague's busy is a helper, never a commit-time blocker (owner rule 6).
  // Re-checking attendees here is what bounced a real owner-approved booking
  // four times on stale "Isaac/Joe busy" while the slot was actually free. The
  // owner's OWN freshness is handled at slot_pick (recheckOwnerFreeForBooking);
  // a policy_exception means he consented to his own calendar state too.

  // Sync-then-close: run the replay BEFORE marking the request resolved
  // and BEFORE relaying to the requester. On replay failure the request
  // stays awaiting_owner so the owner can retry; the requester is not
  // told "approved" for an action that never happened.
  //
  // Matches the resolveSlotPickApproval pattern. closeRequest is
  // idempotent (no-op on terminal rows) so a closeMeetingArtifacts
  // cascade firing during replay won't conflict with the explicit close
  // below.
  try {
    await runDeferredAction({
      ownerUserId: row.owner_user_id,
      profile: ctx.profile,
      tool,
      args: replayArgs,
      requestId: row.id,
    });
  } catch (err) {
    logger.error('on_approve replay failed — leaving request awaiting_owner for retry', {
      id: row.id, tool, err: String(err).slice(0, 300),
    });
    return {
      ok: false,
      request_id: row.id,
      state: row.state,
      effect: `approve_replay_failed:${tool}`,
      reason: err instanceof Error ? err.message : String(err).slice(0, 300),
    };
  }

  // Replay succeeded — close and relay.
  closeRequest({
    id: row.id,
    state: 'resolved',
    closureReason: `owner approved ${row.subkind ?? row.kind} (auto-replayed ${tool})`,
    closedBy: 'owner',
    outcomeJson: {
      approved: true,
      replayed: tool,
      merged_from_amend: meta.mergedFromAmend,
      amend_round: meta.amendRound,
    },
  });

  await notifyRequesterOfDecision(row, 'approve', { replayed: tool }, undefined, ctx);
  return {
    ok: true, request_id: row.id, state: 'resolved',
    effect: `approved ${row.kind}/${row.subkind ?? '-'} — replayed ${tool}`,
  };
}

// ── slot_pick / calendar_conflict booking flow ──────────────────────────────

interface SlotPickDetails {
  coord_job_id?: string;
  subject?: string;
  slots?: Array<{ iso: string; label?: string }>;
  participants_emails?: string[];
  duration_min?: number;
}

async function resolveSlotPickApproval(
  row: RequestRow,
  data: Record<string, unknown>,
  ctx: ResolveContext,
): Promise<ResolveResult> {
  const details = (parseDetails<SlotPickDetails & { winning_slot?: string }>(row) ?? {});
  // Sonnet may omit slot_iso when the slot is already determined (coord
  // resolved to winning_slot before asking owner). Fall back to that.
  const chosenIso = (data.slot_iso as string | undefined)
    ?? details.winning_slot
    ?? '';
  if (!chosenIso) {
    return {
      ok: false, request_id: row.id, state: row.state,
      reason: 'slot_pick approve requires data.slot_iso (or details.winning_slot)',
    };
  }
  const chosenDt = DateTime.fromISO(chosenIso);
  if (!chosenDt.isValid) {
    return {
      ok: false, request_id: row.id, state: row.state,
      reason: `slot_iso "${chosenIso}" is not a valid ISO datetime`,
    };
  }

  const coordJobId = details.coord_job_id;
  if (!coordJobId) {
    return {
      ok: false, request_id: row.id, state: row.state,
      reason: 'slot_pick details missing coord_job_id',
    };
  }
  const durationMin = details.duration_min ?? 30;
  const subject = details.subject ?? row.subject;

  // Freshness re-check — catch a slot that went stale on the OWNER's side
  // before we book (reads fresh; attendee busy is a helper, not a blocker).
  const endDt = chosenDt.plus({ minutes: durationMin });
  const staleConflict = await recheckOwnerFreeForBooking({
    ownerEmail: ctx.profile.user.email,
    startIso: chosenDt.toISO()!,
    endIso: endDt.toISO()!,
    timezone: ctx.profile.user.timezone,
  });

  if (staleConflict) {
    // Stale slot — flip back to awaiting_owner with conflict_reason in details,
    // orchestrator's next turn will offer fresh options.
    mergeRequestDetails(row.id, {
      stale_conflict: staleConflict,
      stale_at_iso: chosenIso,
      slots: [],   // explicitly empty — caller must re-plan
    });
    return {
      ok: false, request_id: row.id, state: 'awaiting_owner',
      reason: `slot no longer free (${staleConflict}) — request stays awaiting_owner for fresh options`,
      subject,
    };
  }

  // Idempotency: if outcome_external_event_id already set + matches, skip.
  if (row.outcome_external_event_id) {
    closeRequest({
      id: row.id, state: 'resolved',
      closureReason: 'already_booked_idempotent',
      closedBy: 'system',
      outcomeJson: { slot_iso: chosenIso, external_event_id: row.outcome_external_event_id, already_booked: true },
    });
    return {
      ok: true, request_id: row.id, state: 'resolved',
      effect: 'already booked — idempotent short-circuit',
      subject, slot: chosenIso,
    };
  }

  if (!ctx.app) {
    return { ok: false, request_id: row.id, state: 'awaiting_owner', reason: 'no Slack app in resolver context — cannot book synchronously' };
  }

  const handler = getCoordBookingHandler();
  if (!handler) {
    return { ok: false, request_id: row.id, state: 'awaiting_owner', reason: 'no coord booking handler registered — MeetingsSkill may be disabled' };
  }

  try {
    const result = await handler({
      jobId: coordJobId,
      chosenSlotIso: chosenIso,
      profile: ctx.profile,
      synchronous: true,
    });
    if (result.ok) {
      closeRequest({
        id: row.id, state: 'resolved',
        closureReason: 'owner_approved_slot_pick_and_booked',
        closedBy: 'owner',
        outcomeExternalEventId: result.externalEventId ?? undefined,
        outcomeJson: { slot_iso: chosenIso, booked: true, subject: result.subject },
      });
      void runPostBookingHealthCheck({
        profile: ctx.profile,
        slotIso: chosenIso,
        subject: result.subject ?? subject ?? 'meeting',
      });
      return { ok: true, request_id: row.id, state: 'resolved', effect: 'booked', subject: result.subject, slot: chosenIso };
    }
    // Booking failed — leave request awaiting_owner so retry can happen.
    logger.warn('resolveSlotPickApproval — booking failed, request stays awaiting_owner', {
      id: row.id, reason: result.reason, status: result.status,
    });
    return {
      ok: false, request_id: row.id, state: 'awaiting_owner',
      reason: result.reason ?? `booking not completed (${result.status})`,
      subject: result.subject, slot: chosenIso,
    };
  } catch (err) {
    logger.error('resolveSlotPickApproval — booking threw', { id: row.id, err: String(err) });
    return {
      ok: false, request_id: row.id, state: 'awaiting_owner',
      reason: `booking threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Requester loop-close DM ─────────────────────────────────────────────────

/**
 * v2.8.6 — filter out the auto-generated `<subkind> needs your input` phrase
 * that lands on row.subject when Sonnet didn't pass an explicit subject. That
 * phrase leaked into MPIM resolution messages as "Idan said yes on policy
 * exception needs your input" — internal jargon visible to colleagues. When
 * this returns true, the caller falls back to a generic phrase instead.
 */
function looksLikeApprovalMeta(subject: string): boolean {
  const lower = subject.trim().toLowerCase();
  return lower.endsWith('needs your input')
    || lower === 'unknown person'
    || lower === 'policy exception'
    || lower === 'duration override'
    || lower === 'lunch bump'
    || lower === 'calendar conflict';
}

// v3.3.x (Dina webinar, 2026-06-14) — a candidate subject that is phrased as a
// QUESTION is the internal approval ASK ("Can Idan find 10 minutes with Dina
// tomorrow for Zoom webinar setup?"), framed to the OWNER. Pasting it into the
// requester-facing "{owner} said yes on {X}" relay leaked that internal framing
// to Dina ("said yes on Can Idan find 10 minutes…?"). A real meeting subject is
// a noun phrase, never a question — reject question-form candidates so the relay
// falls back to a clean generic.
function looksLikeApprovalQuestion(subject: string): boolean {
  const t = subject.trim();
  if (t.endsWith('?')) return true;
  return /^(can|could|would|will|should|does|is|are|may|shall)\b/i.test(t);
}

function usableRelaySubject(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const s = candidate.trim();
  if (!s) return undefined;
  if (looksLikeApprovalMeta(s) || looksLikeApprovalQuestion(s)) return undefined;
  return s;
}

async function notifyRequesterOfDecision(
  row: RequestRow,
  verdict: 'approve' | 'reject' | 'amend',
  data: Record<string, unknown> | null,
  reason: string | undefined,
  ctx: ResolveContext,
): Promise<void> {
  const requesterSlackId = row.requester_slack_id;
  if (!requesterSlackId) return;  // owner-internal request, nothing to close back
  // For coord/slot_pick the coordinator's own loop-close path handles it.
  if (row.kind === 'coord') return;
  if (row.kind === 'approval' && (row.subkind === 'slot_pick' || row.subkind === 'calendar_conflict')) return;

  const details = parseDetails(row) ?? {};
  const requesterName = row.requester_name ?? (details.requester_name as string | undefined);

  // v2.8.6 — subject for the requester-facing "Idan said yes on X" message.
  // Source priority:
  //   (1) deferred_action.args.subject — the meeting subject from the
  //       underlying tool call; most accurate when a replay is wired
  //   (2) details.subject — what Sonnet explicitly passed
  //   (3) details.question — the freeform question text
  //   (4) row.subject — the auto-generated fallback (e.g. "policy exception
  //       needs your input"), filtered through looksLikeApprovalMeta to
  //       avoid leaking internal jargon to colleagues
  //   (5) generic "that ask"
  // Pre-fix this fell straight to row.subject, leaking the auto-generated
  // "<subkind> needs your input" phrase into MPIM resolution messages.
  const deferred = details.deferred_action as { args?: Record<string, unknown> } | undefined;
  // Pull subject + start time + location from the on_approve callback when
  // present. v2.9.4 (#107d) — pre-fix the relay body said "I'll take it from
  // here, will let you know once it's sorted" even though the booked time +
  // subject were sitting in deferred.args. Now: when start is known, render
  // the concrete time so the requester knows exactly what was booked.
  const deferredSubject = typeof deferred?.args?.subject === 'string'
    ? deferred.args.subject as string
    : (typeof deferred?.args?.meeting_subject === 'string' ? deferred.args.meeting_subject as string : undefined);
  const deferredStart = typeof deferred?.args?.start === 'string'
    ? deferred.args.start as string
    : (typeof deferred?.args?.new_start === 'string' ? deferred.args.new_start as string : undefined);
  // v3.3.x — every candidate is filtered through usableRelaySubject, which
  // rejects approval-meta ("policy exception") AND question-form internal asks
  // ("Can Idan find 10 minutes…?") so neither leaks into the requester relay.
  // (Pre-fix only row.subject was filtered; details.question — the raw internal
  // question — fell straight through and leaked to Dina, 2026-06-14.)
  const subject =
    usableRelaySubject(deferredSubject) ||
    usableRelaySubject(details.subject) ||
    usableRelaySubject(details.question) ||
    usableRelaySubject(row.subject) ||
    'that ask';

  // v2.9.4 (#107d) — language-aware relay body. Renders Hebrew when the
  // requester's profile_json.language_preference is set to Hebrew; falls back
  // to English. Pre-fix the relay was always English even for Hebrew-speaking
  // requesters (Yael), so the "Idan said yes" DM didn't read as a recognizable
  // confirmation. profile_json is best-effort — null/undefined → English.
  let requesterLang: 'he' | 'en' = 'en';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPersonMemory } = require('../../db/people') as typeof import('../../db/people');
    const personRow = getPersonMemory(requesterSlackId);
    if (personRow?.profile_json) {
      const pj = JSON.parse(personRow.profile_json);
      const pref = (pj?.language_preference as string | undefined ?? '').toLowerCase().trim();
      // Explicit whitelist only — the prior outer `pref.includes('he')` guard
      // accepted any string containing the substring 'he' (e.g. 'they', 'shes',
      // random pref values), and only the inner whitelist kept things sane.
      // Dropping the outer guard removes the fragile fail-open and keeps a
      // single source of truth.
      if (pref === 'he' || pref === 'hebrew' || pref === 'he-il' || pref.startsWith('hebrew') || pref.includes('עברית')) {
        requesterLang = 'he';
      }
    }
  } catch { /* fail-open to English */ }

  // Format start time in the requester's timezone if known, else owner's.
  const formatStart = (iso: string): string => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getPersonMemory } = require('../../db/people') as typeof import('../../db/people');
      const personRow = getPersonMemory(requesterSlackId);
      const tz = personRow?.timezone || ctx.profile.user.timezone;
      const dt = DateTime.fromISO(iso, { zone: tz });
      if (!dt.isValid) return '';
      return requesterLang === 'he'
        ? dt.setLocale('he').toFormat('cccc d MMMM, HH:mm')
        : dt.toFormat('cccc d MMM, HH:mm');
    } catch { return ''; }
  };
  const startFormatted = deferredStart ? formatStart(deferredStart) : '';

  const { getConnection } = await import('../../connections/registry');
  const conn = getConnection(row.owner_user_id, 'slack');
  if (!conn) {
    logger.warn('notifyRequesterOfDecision — no Slack connection', { id: row.id });
    return;
  }

  const ownerFirst = ctx.profile.user.name.split(' ')[0];
  const requesterFirst = requesterName ? requesterName.split(' ')[0] : undefined;
  const hi = requesterFirst
    ? (requesterLang === 'he' ? `היי ${requesterFirst}` : `Hey ${requesterFirst}`)
    : (requesterLang === 'he' ? 'היי' : 'Hey');
  let body: string;
  if (verdict === 'approve') {
    // wasAwaitingColleague=true → the COLLEAGUE (requester) just accepted
    // the owner's counter. Crediting "Idan said yes" is wrong; the colleague
    // is the actor here. Use a neutral booking-confirmation phrasing
    // instead. The relay still goes to the requester as a confirmation
    // they can scroll back to.
    if (ctx.wasAwaitingColleague) {
      if (startFormatted) {
        body = requesterLang === 'he'
          ? `${hi} — סגרנו על "${subject}" ל${startFormatted}. הזימון בדרך.`
          : `${hi} — locked in "${subject}" for ${startFormatted}. Calendar invite incoming.`;
      } else {
        body = requesterLang === 'he'
          ? `${hi} — סגרנו על ${subject}. אעדכן אותך כשהזימון יוצא.`
          : `${hi} — locked in ${subject}. I'll let you know once the invite goes out.`;
      }
    } else if (startFormatted) {
      // Owner-resolved: concrete-time form when we know the booked slot.
      body = requesterLang === 'he'
        ? `${hi} — ${ownerFirst} אישר. אני קובעת את "${subject}" ל${startFormatted}. הזימון בדרך.`
        : `${hi} — ${ownerFirst} said yes. Booking "${subject}" for ${startFormatted}. Calendar invite incoming.`;
    } else {
      // Action-AGNOSTIC fallback. The LLM composer below is the primary path;
      // this only fires if it errors. It must NOT assert "approved {subject}" —
      // for a cancellation that reads as approving the meeting itself (the Yael
      // "you mean approved to cancel?" bug). A neutral "got back to me, I'm on it"
      // is never wrong regardless of the underlying action.
      body = requesterLang === 'he'
        ? `${hi} — ${ownerFirst} חזר אליי בנושא. אני מטפלת בזה ואעדכן אותך.`
        : `${hi} — ${ownerFirst} got back to me on this. I'm on it and will update you.`;
    }
  } else if (verdict === 'reject') {
    const reasonTail = reason && reason.trim() ? ` (${reason.trim()})` : '';
    body = requesterLang === 'he'
      ? `${hi} — ${ownerFirst} לא יכול לעשות את זה כרגע${reasonTail}. סליחה — אם תרצי שאחפש משהו אחר, רק תגידי.`
      : `${hi} — ${ownerFirst} can't make that work right now${reasonTail}. Sorry about that — happy to find another path if you want.`;
  } else {
    // v2.9.2 — question-shape counter: when counter.text is a clarifying
    // question from the owner ("what time?", "where?", "who else?"), render
    // it as a question relay instead of "suggested a different approach".
    // Detection: counter.text ends in `?` (any language) or starts with a
    // common question-word in EN/HE.
    const counterText = typeof data?.text === 'string' ? data.text.trim() : '';
    const isQuestion =
      counterText.length > 0
      && (
        /[?؟]\s*$/.test(counterText)  // any-language question mark
        || /^(what|when|where|who|why|how|which|can|could|would|should|do|does|did|is|are|was|were)\b/i.test(counterText)
        || /^(מה|מתי|איפה|מי|למה|איך|איזה|האם)\b/.test(counterText)  // Hebrew question-words
      );
    if (isQuestion) {
      body = requesterLang === 'he'
        ? `${hi} — ${ownerFirst} שאל: ${counterText}`
        : `${hi} — ${ownerFirst} asked: ${counterText}`;
    } else {
      const counterSummary = summarizeCounter(data);
      body = requesterLang === 'he'
        ? `${hi} — ${ownerFirst} הציע משהו אחר${counterSummary ? ': ' + counterSummary : ''}. זה עובד לך?`
        : `${hi} — ${ownerFirst} suggested a different approach${counterSummary ? ': ' + counterSummary : ''}. Does that work for you?`;
    }
  }

  // 2.1 — the templates above are now a FALLBACK. Compose the requester relay as
  // FREE TEXT with the LLM so it (a) names the ACTION correctly — a cancellation
  // reads as "okayed cancelling it", never "approved {meeting}" (which reads as
  // approving the meeting itself; Yael: "you mean approved to cancel?", 2026-06-15)
  // — and (b) writes in the requester's actual language instead of the rigid
  // he/en branch. Approve + reject only; amend keeps its template (it carries the
  // specific counter/question the composer wouldn't have). Fails open to `body`.
  if (verdict === 'approve' || verdict === 'reject') {
    try {
      const rawAsk =
        (typeof details.question === 'string' && details.question.trim() ? details.question.trim() : '') ||
        (typeof details.subject === 'string' && details.subject.trim() ? details.subject.trim() : '') ||
        row.subject || subject;
      const deferredTool = (details.deferred_action as { tool?: string } | undefined)?.tool;
      const actionHint =
        deferredTool === 'delete_meeting' ? 'a cancellation'
          : (deferredTool === 'move_meeting' || deferredTool === 'update_meeting') ? 'a change to an existing meeting'
            : (deferredTool === 'create_meeting' || deferredTool === 'finalize_coord_meeting') ? 'a booking'
              : undefined;
      const outcome = verdict === 'approve'
        ? `${ownerFirst} said yes`
        : `${ownerFirst} can't make it work${reason && reason.trim() ? ` (${reason.trim()})` : ''}`;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAnthropicClient } = require('../../llm/client') as typeof import('../../llm/client');
      const anthropic = getAnthropicClient();
      const assistantName = ctx.profile.assistant?.name ?? 'the assistant';
      const sys = `You are ${assistantName}, ${ownerFirst}'s executive assistant, sending ONE short, warm Slack message to ${requesterFirst ?? 'a colleague'} to close the loop on something they asked you to arrange with ${ownerFirst}.
RULES:
- Language: ${requesterLang === 'he' ? 'write in Hebrew' : 'match the language of their request below (English / Spanish / etc.)'}.
- Name the ACTION clearly, zero ambiguity. If their request was to CANCEL something, say it's cancelled / being taken care of — NEVER phrase it as "${ownerFirst} approved {the meeting}", which reads like approving the meeting itself. If it was a booking, say it's booked${startFormatted ? ` for ${startFormatted}` : ''}.
- Do NOT mention approvals, "policy", internal tools, or that you "asked ${ownerFirst}" — just the human outcome, EA-voiced and natural.
- ONE sentence. A light "Hi ${requesterFirst ?? ''}" is fine; no sign-off.`;
      const usr = `Their request: "${rawAsk}".${actionHint ? ` (This was ${actionHint}.)` : ''} Outcome: ${outcome}.${startFormatted ? ` Scheduled for ${startFormatted}.` : ''} Write the message.`;
      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: sys,
        messages: [{ role: 'user', content: usr }],
      });
      const composed = ((resp.content[0] as { text?: string })?.text ?? '').trim();
      if (composed) body = composed;
    } catch (err) {
      logger.warn('notifyRequesterOfDecision — LLM relay compose failed, using template', { id: row.id, err: String(err).slice(0, 150) });
    }
  }

  // v3.1 (115a/115b) — single-notification idempotency + owner shadow.
  // Re-read fresh: closeMeetingArtifacts may have stamped requester_notified_at
  // during the on_approve replay that ran just before this call. If so the
  // requester already got their DM — skip the duplicate, but STILL shadow the
  // owner so he can see the loop closed (he was blind to it before — issue #115).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRequest: getReqFresh, updateRequest: stampReq } = require('../../db/requests') as typeof import('../../db/requests');
  const alreadyNotified = (() => {
    try { return !!getReqFresh(row.id)?.requester_notified_at; } catch { return false; }
  })();
  const fireOwnerShadow = async (): Promise<void> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { shadowNotify } = require('../../utils/shadowNotify') as typeof import('../../utils/shadowNotify');
      await shadowNotify(ctx.profile, {
        channel: row.owner_dm_channel ?? row.origin_channel ?? '',
        action: `I → ${requesterFirst ?? 'them'}`,
        detail: body,
        conversationKey: row.origin_thread_ts ?? row.id,
        conversationHeader: requesterFirst ? `Conversation with ${requesterName ?? requesterFirst}` : undefined,
      });
    } catch (_) { /* shadow is best-effort */ }
  };
  const stampIfTerminal = (): void => {
    // Stamp on approve/reject (terminal outcomes). NOT on amend — the request
    // stays open and the eventual booking must still notify the requester.
    if (verdict === 'approve' || verdict === 'reject') {
      try { stampReq(row.id, { requesterNotifiedAt: new Date().toISOString() }); } catch (_) {}
    }
  };

  if (alreadyNotified) {
    logger.info('notifyRequesterOfDecision — requester already notified (cascade), shadow-only', { id: row.id });
    await fireOwnerShadow();
    return;
  }

  // MPIM origin → post back in MPIM thread; else 1:1 DM.
  try {
    if (row.origin_is_mpim && row.origin_channel) {
      const res = await conn.postToChannel(row.origin_channel, body, { threadTs: row.origin_thread_ts ?? undefined });
      if (res.ok) {
        logger.info('notifyRequesterOfDecision — posted in MPIM origin', { id: row.id, channel: row.origin_channel });
        stampIfTerminal();
        await fireOwnerShadow();
        return;
      }
      logger.warn('notifyRequesterOfDecision — MPIM post failed, falling back to 1:1 DM', {
        id: row.id, reason: res.reason,
      });
    }
    // v2.9.4 (#107ef) — thread the relay DM into the ORIGINAL conversation
    // when known. Pre-fix sendDirect was called without opts, so the message
    // landed as a NEW top-level in the requester's DM (new thread_ts). When
    // the requester then replied to that DM ("ok waiting"), her reply lived
    // in the new thread with no booking-history context — Sonnet ran the
    // turn with historyLength=1 and hallucinated (2026-05-20 Yael case at
    // 10:04:17 UTC, thread `1779271297.491389`). Passing origin_thread_ts
    // keeps the relay inside the original thread; the requester's reply
    // continues the same thread; Sonnet sees the full booking conversation.
    const res = await conn.sendDirect(requesterSlackId, body, {
      threadTs: row.origin_thread_ts ?? undefined,
    });
    if (!res.ok) {
      logger.warn('notifyRequesterOfDecision — direct DM failed', {
        id: row.id, requesterSlackId, reason: res.reason,
      });
    } else {
      stampIfTerminal();
    }
    await fireOwnerShadow();
  } catch (err) {
    logger.warn('notifyRequesterOfDecision — threw, non-fatal', {
      id: row.id, err: String(err).slice(0, 200),
    });
  }
}

/**
 * v2.9.1 — colleague responded to owner's counter (amending state). DM owner
 * to bring his attention back, with the colleague's pushback. The original
 * approval is now back to awaiting_owner so the system prompt's PENDING
 * APPROVALS block will show it next time owner messages, but a fresh DM
 * is much more responsive.
 */
async function notifyOwnerOfColleaguePushback(
  row: RequestRow,
  verdict: 'reject' | 'amend',
  reason: string | undefined,
  ctx: ResolveContext,
  colleagueCounter?: Record<string, unknown>,
): Promise<void> {
  const requesterName = row.requester_name?.split(' ')[0] ?? 'the colleague';
  const subject = row.subject || 'the ask';
  let body: string;
  if (verdict === 'reject') {
    const tail = reason && reason.trim() ? ` (${reason.trim()})` : '';
    body = `${requesterName} said the counter doesn't work${tail}. Back to you on "${subject}" — want to suggest something else, or drop it?`;
  } else {
    const cnt = colleagueCounter ? summarizeCounter(colleagueCounter) : '';
    body = `${requesterName} countered with ${cnt || 'an alternative'} on "${subject}". Approve, reject, or counter again?`;
    // Append the REBUILT consequence line so the owner sees what saying yes
    // actually does NOW (after the counter merges into on_approve.args).
    // Pre-fix the only consequence line the owner saw was the one from the
    // original create_approval DM, which reflected the ORIGINAL slot — but
    // approving here would replay the MERGED args (new slot). The fresh
    // line eliminates the "I thought yes meant 14:00, got 16:00" confusion.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { extractCallbacks, mergeAmendIntoApprove, buildConsequenceText } =
        require('../approvals/approvalCallbacks') as
          typeof import('../approvals/approvalCallbacks');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { parseDetails } = require('./types') as typeof import('./types');
      const details = parseDetails<Record<string, unknown>>(row) ?? {};
      const callbacks = extractCallbacks(details);
      if (callbacks.on_approve && colleagueCounter) {
        const merged = mergeAmendIntoApprove(callbacks.on_approve, colleagueCounter);
        const consequence = buildConsequenceText({ on_approve: merged }, ctx.profile);
        if (consequence) {
          body = `${body}\n\n${consequence}`;
        }
      }
    } catch (err) {
      logger.warn('notifyOwnerOfColleaguePushback — consequence rebuild threw, sending bare body', {
        id: row.id, err: String(err).slice(0, 200),
      });
    }
  }
  try {
    const { getConnection } = await import('../../connections/registry');
    const conn = getConnection(row.owner_user_id, 'slack');
    if (!conn) {
      logger.warn('notifyOwnerOfColleaguePushback — no Slack connection', { id: row.id });
      return;
    }
    const res = await conn.sendDirect(row.owner_user_id, body);
    if (res.ok && res.ts) {
      // Update terminal_dm_msg_ts so Module D can auto-resolve the bounce
      // reply on this fresh DM thread.
      updateRequest(row.id, { terminalDmMsgTs: res.ts });
    }
  } catch (err) {
    logger.warn('notifyOwnerOfColleaguePushback — threw, non-fatal', {
      id: row.id, err: String(err).slice(0, 200),
    });
  }
}

function summarizeCounter(data: Record<string, unknown> | null): string {
  if (!data) return '';
  if (typeof data.text === 'string' && data.text.trim()) return data.text.trim();
  if (typeof data.slot_iso === 'string') return `a different time (${data.slot_iso})`;
  if (typeof data.to === 'string') return `move it to ${data.to}`;
  return '';
}
