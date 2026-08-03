/**
 * Requests resolver (v2.7.0) — replaces core/approvals/resolver.ts.
 *
 * Single entry point for owner-decision side-effects. The orchestrator never
 * calls book/cancel/DM directly; it calls resolveRequest with the request id
 * and a verdict. This file owns per-kind downstream behavior — replaying the
 * approved action (deferred_action / on_approve), notifying the requester, etc.
 *
 * Then it calls closeRequest, which is the single closure entry. All audit,
 * cascade, and timer-clearing happen there.
 */

import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../../config/userProfile';
import { getRequest, updateRequest } from '../../db/requests';
import { closeRequest } from './closeRequest';
import type { RequestRow } from './types';
import { parseDetails } from './types';
import {
  composeOwnerAskText,
  extractCallbacks,
  mergeAmendIntoApprove,
  RESOLVER_REPLAY_TOOLS,
  type ToolCallback,
} from '../approvals/approvalCallbacks';
import { runDeferredAction } from './deferredActionReplay';
import logger from '../../utils/logger';
import { MODEL_HAIKU } from '../../llm/models';
import { INTERNAL_WORK_ITEM_ID_RE } from '../../utils/textScrubber';

/**
 * How many counter-offers a single request may carry before it is brought to a
 * close — counted across BOTH directions (owner counters, colleague
 * counter-counters), because the ping-pong is what's bounded, not either side's
 * share of it. Round 1 and 2 relay; round 3 expires the request and both sides
 * are told (R4). Owner ruling 2026-07-25: two. It lives here, once — the two
 * copies of this cap (relay + bounce-back) had drifted to 3 apiece behind a
 * stale dated comment, which is exactly how a rule ends up with two answers.
 */
const MAX_COUNTER_ROUNDS = 2;

/**
 * How long the COLLEAGUE gets to answer a counter relayed to them. Matches the
 * colleague-side wait already used on this spine (runner.ts reschedule_reask →
 * outreach_expiry at +48h) rather than inventing a second convention.
 */
const COLLEAGUE_COUNTER_WINDOW_HOURS = 48;

/** Owner-side decision window, in owner workdays — same default create_approval raises with. */
const OWNER_DECISION_WORKDAYS = 2;

/**
 * #42 — re-aim the request's clock at whichever side is now being waited on.
 *
 * The timers were a function of the RAISE, not of the STATE: a request raised
 * awaiting_owner kept its owner-facing midpoint-nag + expiry schedule even after
 * an amend handed the ball to the colleague. So the midpoint DM'd the owner
 * "Still waiting on your call here" about a call he had already made, and expiry
 * told BOTH parties he'd ghosted a decision the colleague was actually sitting
 * on — the precise pair of wrong outcomes R4 exists to prevent. Every transition
 * between the two waiting states now goes through here.
 *
 * Handler is always `expiry`: runExpiry reads the row's state at fire time and
 * tells each side the true story, so one terminal path serves both directions.
 * The midpoint nag is deliberately NOT re-armed on a transition — the message
 * that caused the transition (the counter relay, the pushback DM) IS the nudge.
 *
 * The deadline never shortens a live one: whichever of the current `expires_at`
 * and the fresh side-appropriate window is later wins, so someone handed the
 * ball at the tail end of the window still gets a fair chance to answer.
 * expires_at moves with next_check_at — one deadline, never two disagreeing.
 */
function timersForWaitingSide(
  row: RequestRow,
  side: 'owner' | 'colleague',
  profile: UserProfile,
): { expiresAt: string; nextCheckAt: string; nextCheckHandler: 'expiry' } {
  let fresh: DateTime;
  if (side === 'colleague') {
    fresh = DateTime.now().plus({ hours: COLLEAGUE_COUNTER_WINDOW_HOURS }).toUTC();
  } else {
    // Owner-facing deadlines respect his work hours (R5) — same helper pair the
    // raise-time expiry uses, so a counter bounced back at 22:00 doesn't burn
    // the night.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { addWorkdays, workTimeBaseFromNow } = require('../../utils/workHours') as
      typeof import('../../utils/workHours');
    fresh = DateTime.fromISO(
      addWorkdays(workTimeBaseFromNow(profile), OWNER_DECISION_WORKDAYS, profile),
      { zone: 'utc' },
    );
  }
  const existing = row.expires_at ? DateTime.fromISO(row.expires_at, { zone: 'utc' }) : null;
  const at = ((existing?.isValid && existing > fresh) ? existing : fresh).toUTC().toISO()!;
  return { expiresAt: at, nextCheckAt: at, nextCheckHandler: 'expiry' };
}

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
  /**
   * v3.4.7 — reverse-order double-notify guard. The set of colleague slack_ids
   * Sonnet already messaged (message_colleague) THIS turn. When Sonnet messages
   * the requester the outcome BEFORE calling resolve_approval in the same turn
   * (owner said "tell her and approve it"), the resolver's own relay would be a
   * SECOND DM. notifyRequesterOfDecision skips its relay for a requester in this
   * set — they already heard it. Populated by the orchestrator from its
   * turn-scoped messagedColleaguesThisTurn; absent on non-orchestrator paths
   * (emoji, Module D), where there's no competing message_colleague.
   */
  alreadyMessagedRequesterIds?: Set<string>;
}

export interface ResolveResult {
  ok: boolean;
  request_id: string;
  state: RequestRow['state'];
  effect?: string;
  reason?: string;
  subject?: string;
  slot?: string;
  // 138c (GH #140) — concrete replay outcome so Sonnet narrates the booking
  // cleanly instead of hedging + announcing in the same breath. `booked` is set
  // only for booking tools; `action_summary` is the tool's own past-tense,
  // travel-aware confirmation line (quote it verbatim). Absent on non-replay
  // resolves.
  booked?: boolean;
  start?: string;
  action_summary?: string;
}

// ── Entry ───────────────────────────────────────────────────────────────────

// v4.4.x (backlog: concurrent-double-resolve-no-lock) — the state gate below
// (`row.state !== 'awaiting_owner' && ...`) is a plain check-then-act: it reads
// the row, then this function runs a long async body (Slack posts, the LLM
// replay call, notifyRequesterOfDecision) before its own closeRequest() call
// commits the terminal state. Two decisive reactions to the SAME request
// arriving close together (an emoji ✅ and a typed reply; a double-tap) both
// pass this check while the first is still mid-flight, and both then execute
// their own booking/notify side effects — closeRequest's OWN idempotency
// guard (closeRequest.ts:49) only catches the SECOND request-state write, not
// the duplicated work that already happened before either call reached it.
// Single fork process (ecosystem.config.js: exec_mode 'fork', never cluster),
// so an in-process lock is a complete fix, not a partial one.
//
// A per-request FIFO queue, not just a single wait-then-retry: each call
// chains onto whatever is CURRENTLY queued for this id (read + overwrite in
// one synchronous statement, so two near-simultaneous callers can never both
// read the same tail) and only starts its own resolveRequestInner once every
// earlier call for this id has fully settled. A single wait-for-the-current-
// holder design closes the reported 2-caller race but not a 3rd+ caller that
// arrives while the first two are already both waiting on the same holder —
// this queue closes it for any number of concurrent callers. A failed link
// (`.catch(() => undefined)`) never wedges the ones behind it; each still
// runs its own fresh state check, so a caller queued behind one that already
// closed the request lands on the pre-existing "request is in state …"
// rejection below, rather than re-running the side effects.
const resolveQueue = new Map<string, Promise<unknown>>();

export async function resolveRequest(
  requestId: string,
  verdict: ResolveVerdict,
  ctx: ResolveContext,
): Promise<ResolveResult> {
  const tail = resolveQueue.get(requestId) ?? Promise.resolve();
  const run = tail.catch(() => undefined).then(() => resolveRequestInner(requestId, verdict, ctx));
  resolveQueue.set(requestId, run);
  try {
    return await run;
  } finally {
    if (resolveQueue.get(requestId) === run) resolveQueue.delete(requestId);
  }
}

async function resolveRequestInner(
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
        // #42 — ball back with the owner, so the clock goes back to his window.
        ...timersForWaitingSide(row, 'owner', ctx.profile),
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
            originChannel: row.origin_channel,
            originThreadTs: row.origin_thread_ts,
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
    // 15:30?". Owner re-decides. Same round cap — one constant, both directions.
    if (wasAwaitingColleague) {
      if (amendRound > MAX_COUNTER_ROUNDS) {
        logger.warn('resolveRequest — colleague-counter amend round cap hit', {
          id: requestId, round: amendRound, cap: MAX_COUNTER_ROUNDS,
        });
        closeRequest({
          id: requestId,
          state: 'expired',
          closureReason: `amend ping-pong exceeded ${MAX_COUNTER_ROUNDS} rounds`,
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
        // #42 — ball back with the owner, so the clock goes back to his window.
        ...timersForWaitingSide(row, 'owner', ctx.profile),
        details: {
          ...detailsAll,
          counter: verdict.counter,
          counter_history: counterHistory,
          amend_round: amendRound,
          amended_at: DateTime.now().toISO(),
          amended_by: 'colleague',
        },
      });
      // Hand the decision back to the OWNER (composed from the row we just wrote —
      // the stored counter is what a ✅ there replays).
      await notifyOwnerOfColleaguePushback(row, 'amend', verdict.reason, ctx);
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
    // counters, owner counters again, …); past the cap it's just annoying, so
    // bring it to a close — the request expires and both sides are told.
    if (amendRound > MAX_COUNTER_ROUNDS) {
      logger.warn('resolveRequest — amend round cap hit, closing as expired', {
        id: requestId, round: amendRound, cap: MAX_COUNTER_ROUNDS,
      });
      closeRequest({
        id: requestId,
        state: 'expired',
        closureReason: `amend ping-pong exceeded ${MAX_COUNTER_ROUNDS} rounds`,
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
    // #42 — the ball just moved to the colleague; re-aim the clock at them.
    const colleagueTimers = timersForWaitingSide(row, 'colleague', ctx.profile);
    updateRequest(requestId, {
      state: 'awaiting_colleague',
      ...colleagueTimers,
      details: {
        ...detailsAll,
        counter: verdict.counter,
        counter_history: counterHistoryOwnerSide,
        amend_round: amendRound,
        amended_at: DateTime.now().toISO(),
        amended_by: 'owner',
      },
    });
    logger.info('resolveRequest — amend relayed, timers re-aimed at the colleague', {
      id: requestId, round: amendRound, expiresAt: colleagueTimers.expiresAt,
    });
    await notifyRequesterOfDecision(row, 'amend', verdict.counter, verdict.reason, ctx);
    return {
      ok: true, request_id: requestId, state: 'awaiting_colleague',
      effect: `owner counter relayed to requester (round ${amendRound})`,
    };
  }

  // ── approve ────────────────────────────────────────────────────────────
  const approveData = verdict.data ?? {};

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

  // No on_approve — this is a PURE yes/no approval (e.g. "ok to share my
  // number?"): there's no fulfilling booking/cancel to wait for, so close +
  // relay "owner said yes" now. v3.4.6 (spine collapse) — the old
  // holdForFulfillingAction bridge + 4h timer is GONE. Booking-implying
  // approvals carry on_approve (policy_exception auto-stamps deferred_action),
  // so they go through runApproveCallback → tier-0 relay with the concrete
  // time; a booking that genuinely lands in a later free turn reconnects via
  // closeMeetingArtifacts' thread-ts match. Nothing is left hanging either way.
  closeRequest({
    id: requestId,
    state: 'resolved',
    closureReason: `owner approved ${row.subkind ?? row.kind}`,
    closedBy: 'owner',
    outcomeJson: { approved: true, data: approveData },
  });
  await notifyRequesterOfDecision(row, 'approve', approveData, undefined, ctx);
  // 138a — no kind/subkind jargon in the owner-facing return (same leak class
  // as the replay path): a pure yes/no approval just closes, Sonnet does any
  // follow-up work in chat.
  return {
    ok: true, request_id: requestId, state: 'resolved',
    effect: 'approved — no action to replay (handled in chat)',
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
    // v3.4.6 (spine collapse) — close + notify now. The hold/timer bridge is
    // gone; an unreplayable on_approve.tool means Sonnet's next turn does the
    // work, and a booking that lands then reconnects via closeMeetingArtifacts'
    // thread-ts match. The requester hears "owner said yes" here regardless.
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
  // v3.4.6 (spine collapse) — the HARD approve→book link. Stamp the
  // originating request id onto the replay so the booking-side cleanup
  // (closeMeetingArtifacts) can identify the EXACT request this booking
  // fulfills and SKIP it — because THIS function owns its close + relay
  // (right after the replay returns). That ownership is what kills the
  // resolver-vs-cascade relay race at the root: no more reconstruct-by-
  // fuzzy-subject + requester_notified_at refereeing. The id rides through
  // runDeferredAction → the tool handler → closeMeetingArtifacts.
  replayArgs._fulfilling_request_id = row.id;

  logger.info('resolveRequest — on_approve replay', {
    id: row.id, tool, kind: row.kind, subkind: row.subkind,
    mergedFromAmend: meta.mergedFromAmend, amendRound: meta.amendRound,
  });

  // No attendee freshness re-check on an approved policy_exception replay. The
  // owner already SAW the conflict in the approval ask and approved it — a
  // colleague's busy is a helper, never a commit-time blocker (owner rule 6).
  // Re-checking attendees here is what bounced a real owner-approved booking
  // four times on stale "Isaac/Joe busy" while the slot was actually free. A
  // policy_exception means he consented to his own calendar state too.

  // Sync-then-close: run the replay BEFORE marking the request resolved
  // and BEFORE relaying to the requester. On replay failure the request
  // stays awaiting_owner so the owner can retry; the requester is not
  // told "approved" for an action that never happened.
  //
  // Matches the resolveSlotPickApproval pattern. closeRequest is
  // idempotent (no-op on terminal rows) so a closeMeetingArtifacts
  // cascade firing during replay won't conflict with the explicit close
  // below.
  let replayResult: Record<string, unknown> | undefined;
  try {
    replayResult = await runDeferredAction({
      ownerUserId: row.owner_user_id,
      profile: ctx.profile,
      tool,
      args: replayArgs,
      requestId: row.id,
      originChannel: row.origin_channel,
      originThreadTs: row.origin_thread_ts,
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

  // #141 Change 5 — link the booked event id on the approval row when a
  // colleague requested it. The replay runs as a SYNTHETIC owner
  // (deferredActionReplay forces senderRole:'owner'), so the direct colleague
  // requester-link at ops.ts:3869 never fires for approval-booked meetings, and
  // no id was ever recorded — a colleague who requested a meeting via approval
  // then couldn't move it (the "Talia" gap). Stamping the event id onto the
  // approval row (which already carries requester_slack_id) lets
  // getMeetingsRequestedBy reverse-resolve it. One arg on the close we already do.
  const bookedEventId = typeof replayResult?.meetingId === 'string'
    ? (replayResult.meetingId as string)
    : undefined;

  // #11 — WHAT ACTUALLY HAPPENED, read off the executed action, not off the row.
  // The stored `deferred_action` is the ORIGINAL ask; on an amended approval the
  // executed args are `mergeAmendIntoApprove(on_approve, counter)`, built locally
  // and never written back. So a counter of 13:00 → 15:30 booked 15:30 while
  // anything reading the row still said 13:00 — and the requester relay read the
  // row. Both the tool return and the relay are now fed from this one object:
  // `booked_start` is the tool's own truth (it can snap/normalize the time),
  // falling back to the args we actually replayed. Same for subject — a counter
  // can rename the meeting too.
  const executed = {
    tool,
    start: typeof replayResult?.booked_start === 'string'
      ? (replayResult.booked_start as string)
      : (typeof replayArgs.start === 'string'
          ? (replayArgs.start as string)
          : (typeof replayArgs.new_start === 'string' ? (replayArgs.new_start as string) : undefined)),
    subject: typeof replayArgs.subject === 'string'
      ? (replayArgs.subject as string)
      : (typeof replayArgs.meeting_subject === 'string' ? (replayArgs.meeting_subject as string) : undefined),
  };

  // Replay succeeded — close and relay.
  closeRequest({
    id: row.id,
    state: 'resolved',
    closureReason: `owner approved ${row.subkind ?? row.kind} (auto-replayed ${tool})`,
    closedBy: 'owner',
    ...(row.requester_slack_id && bookedEventId
      ? { outcomeExternalEventId: bookedEventId }
      : {}),
    outcomeJson: {
      approved: true,
      replayed: tool,
      merged_from_amend: meta.mergedFromAmend,
      amend_round: meta.amendRound,
      ...(executed.start ? { booked_start: executed.start } : {}),
    },
  });

  await notifyRequesterOfDecision(row, 'approve', { replayed: tool }, undefined, ctx, executed);

  // 138a + 138c (GH #140) — surface the CONCRETE outcome, not resolver jargon.
  // Pre-fix this returned `approved approval/policy_exception — replayed
  // create_meeting`, which Sonnet relayed to the owner as "the policy exception
  // approved" (internal-meta leak, 138a), and it carried no booking signal, so
  // the model hedged AND announced completion at once (138c). Now the return is
  // the booking itself: `action_summary` is the tool's ready-to-quote,
  // travel-aware line (same one the direct-book path gives her); `booked` marks
  // it a real booking. No kind/subkind string ever reaches the model.
  const isBookingTool = tool === 'create_meeting' || tool === 'book_floating_block';
  const replayStart = executed.start;
  const replaySubject = executed.subject ?? row.subject ?? undefined;
  const replaySummary = typeof replayResult?.action_summary === 'string'
    ? (replayResult.action_summary as string)
    : undefined;
  return {
    ok: true, request_id: row.id, state: 'resolved',
    effect: 'approved — action replayed',
    ...(isBookingTool ? { booked: true } : {}),
    ...(replaySubject ? { subject: replaySubject } : {}),
    ...(replayStart ? { start: replayStart } : {}),
    ...(replaySummary ? { action_summary: replaySummary } : {}),
  };
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

/**
 * What the resolver ACTUALLY executed for this request, handed in by the only
 * caller that executed anything (runApproveCallback, post-replay).
 *
 * #11 — the relay is TOLD the outcome; it never reconstructs one. It used to
 * read the time out of the row's stored `deferred_action`, which is the original
 * ASK: after an amend the executed args are a locally-merged object that is
 * never persisted, so the colleague was told "locked in for 13:00" while 15:30
 * was on the calendar. Absent here (reject, amend relay, pure approve, an
 * unreplayable on_approve) means nothing ran — and then the relay names no time
 * at all, which is the honest thing to say about an action that hasn't happened.
 */
interface ExecutedOutcome {
  tool: string;
  /** ISO start the action actually landed on. */
  start?: string;
  /** Subject as executed — a counter can rename the meeting, not just move it. */
  subject?: string;
}

async function notifyRequesterOfDecision(
  row: RequestRow,
  verdict: 'approve' | 'reject' | 'amend',
  data: Record<string, unknown> | null,
  reason: string | undefined,
  ctx: ResolveContext,
  executed?: ExecutedOutcome,
): Promise<void> {
  // Definitive relay tracing (Yael/Eve drop, 2026-06-18). This path used to log
  // nothing on the common 1:1-DM success route, so a silent miss couldn't be
  // pinned down. Now every outcome is provable from the log: an entry line, a
  // positive line at each early-return, and a sent/failed line at the send.
  // If you see the entry line with NO follow-up line, the body below threw
  // before reaching the send (lines outside the send try/catch).
  logger.info('notifyRequesterOfDecision — entry', {
    id: row.id, kind: row.kind, subkind: row.subkind ?? null,
    verdict, state: row.state, hasRequester: !!row.requester_slack_id,
  });
  const requesterSlackId = row.requester_slack_id;
  if (!requesterSlackId) {
    logger.info('notifyRequesterOfDecision — skip: no requester_slack_id (owner-internal)', { id: row.id });
    return;  // owner-internal request, nothing to close back
  }
  // v3.4.7 — reverse-order double-notify guard. Sonnet already messaged this
  // requester THIS turn (message_colleague ran before resolve_approval), so this
  // relay would be the SECOND DM. Skip it; stamp requester_notified_at on a
  // terminal verdict so state stays truthful (they WERE told) and downstream
  // reads it. Symmetric to the orchestrator's forward guard; deterministic, no
  // clock. (If the message_colleague send had failed it wouldn't be in the set,
  // so the relay would still go — no silent drop.)
  if (requesterSlackId && ctx.alreadyMessagedRequesterIds?.has(requesterSlackId)) {
    logger.info('notifyRequesterOfDecision — skip: requester already messaged this turn (reverse-order double-notify guard)', {
      id: row.id, requesterSlackId, verdict,
    });
    if (verdict === 'approve' || verdict === 'reject') {
      try { updateRequest(row.id, { requesterNotifiedAt: new Date().toISOString() }); } catch (_) { /* non-fatal */ }
    }
    return;
  }

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
  // #11 — the EXECUTED subject leads. The stored deferred_action's subject is
  // still a usable fallback for the paths where nothing ran (it's the ask's own
  // wording), but it must never outrank what actually happened: a counter merges
  // arbitrary keys into the replayed args, subject included.
  const deferred = details.deferred_action as { args?: Record<string, unknown> } | undefined;
  const deferredSubject = typeof deferred?.args?.subject === 'string'
    ? deferred.args.subject as string
    : (typeof deferred?.args?.meeting_subject === 'string' ? deferred.args.meeting_subject as string : undefined);
  // v3.3.x — every candidate is filtered through usableRelaySubject, which
  // rejects approval-meta ("policy exception") AND question-form internal asks
  // ("Can Idan find 10 minutes…?") so neither leaks into the requester relay.
  // (Pre-fix only row.subject was filtered; details.question — the raw internal
  // question — fell straight through and leaked to Dina, 2026-06-14.)
  const subject =
    usableRelaySubject(executed?.subject) ||
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
    const { getPersonMemory, resolveOutboundLanguageForPerson } = require('../../db/people') as typeof import('../../db/people');
    const personRow = getPersonMemory(requesterSlackId);
    // v3.5.x — DERIVE the relay language from their most recent inbound (default
    // English), not a frozen one-off language_preference (the Ayala bug). The
    // relay renders he/en only; any non-Hebrew code (en/ru/ar/…) → English.
    requesterLang = resolveOutboundLanguageForPerson(personRow) === 'he' ? 'he' : 'en';
  } catch { /* fail-open to English */ }

  // Format start time in the requester's timezone if known, else owner's.
  const formatStart = (iso: string): string => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getPersonMemory } = require('../../db/people') as typeof import('../../db/people');
      const personRow = getPersonMemory(requesterSlackId);
      // v3.5.x — a guessed (auto) timezone must not silently steer a presented
      // time (the Gidon bug: auto Amsterdam, he's in Israel). Only an EXPLICIT
      // auto guess falls back to the owner's tz; owner/person-set AND legacy
      // (NULL set_by) values keep their prior behavior (use the person's tz).
      const tzIsGuess = personRow?.timezone_set_by === 'auto';
      const tz = (personRow?.timezone && !tzIsGuess) ? personRow.timezone : ctx.profile.user.timezone;
      const dt = DateTime.fromISO(iso, { zone: tz });
      if (!dt.isValid) return '';
      return requesterLang === 'he'
        ? dt.setLocale('he').toFormat('cccc d MMMM, HH:mm')
        : dt.toFormat('cccc d MMM, HH:mm');
    } catch { return ''; }
  };
  // #11 — ONLY an executed action produces a time here. No executed action → no
  // time in the relay, and the action-agnostic wording below carries it instead.
  // (Pre-fix this read the stored ask's time, so an unreplayable on_approve also
  // announced "Booking X for 14:00" for a booking that hadn't happened.)
  const startFormatted = executed?.start ? formatStart(executed.start) : '';

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
  // #153-followup — the amend relay's classified parts, lifted out of the branch
  // that builds them so the language composer below can PIN them. `pinned` is
  // machine-labelled decision data (a duration, an instant, a venue) that must
  // survive rephrasing character-for-character; `prose` is the owner's own wording,
  // which may be translated; `withheld` is what this reader must not be shown.
  let amendPinned: Array<{ key: string; value: string }> = [];
  let amendProse: string[] = [];
  let amendWithheld: string[] = [];
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
    // #153 — the owner's own rationale travels too. `reason` is accepted by
    // resolve_approval and relayed on reject, but was silently dropped on amend —
    // so a counter whose only human phrasing lived in `reason` reached the
    // requester as a bare "a different approach". Deduped against the rendered
    // counter, since the model often puts the same sentence in both.
    const rationale = reason && reason.trim() ? reason.trim() : '';
    if (isQuestion) {
      // Everything OTHER than the question still has to travel: a question bundled
      // with a concrete change must not lose the change.
      const rest = renderCounter(
        Object.fromEntries(Object.entries(data ?? {}).filter(([k]) => k !== 'text')),
        { audience: 'requester', formatInstant: formatStart },
      );
      amendWithheld = rest.withheld;
      const tail = [rest.text, rationale && !rest.text.includes(rationale) ? rationale : '']
        .filter(Boolean).join(' — ');
      body = requesterLang === 'he'
        ? `${hi} — ${ownerFirst} שאל: ${counterText}${tail ? ` (${tail})` : ''}`
        : `${hi} — ${ownerFirst} asked: ${counterText}${tail ? ` (${tail})` : ''}`;
    } else {
      const rendered = renderCounter(data, { audience: 'requester', formatInstant: formatStart });
      amendWithheld = rendered.withheld;
      amendPinned = rendered.pinned;
      const counterSummary = rendered.text;
      // The owner's rationale is prose for the composer too — deduped against the
      // rendered counter exactly as the template line below dedupes it.
      amendProse = rationale && !counterSummary.includes(rationale)
        ? [...rendered.prose, rationale]
        : rendered.prose;
      const detail = [counterSummary, rationale && !counterSummary.includes(rationale) ? rationale : '']
        .filter(Boolean).join(' — ');
      body = requesterLang === 'he'
        ? `${hi} — ${ownerFirst} הציע משהו אחר${detail ? ': ' + detail : ''}. זה עובד לך?`
        : `${hi} — ${ownerFirst} suggested a different approach${detail ? ': ' + detail : ''}. Does that work for you?`;
    }
  }

  if (amendWithheld.length > 0) {
    // R4 — a withheld counter key is never a SILENT omission. `resolve_approval`
    // runs the same renderer before it stores anything and refuses an amend whose
    // counter carries one of these (skill.ts), so this can only fire on a row
    // written before that gate existed — and when it does, the key names are on the
    // record here instead of quietly missing from her DM.
    logger.warn('notifyRequesterOfDecision — counter key withheld from the requester relay (internal work-item id)', {
      id: row.id, verdict, withheld: amendWithheld,
    });
  }

  // 2.1 — the templates above are now a FALLBACK. Compose the requester relay as
  // FREE TEXT with the LLM so it (a) names the ACTION correctly — a cancellation
  // reads as "okayed cancelling it", never "approved {meeting}" (which reads as
  // approving the meeting itself; Yael: "you mean approved to cancel?", 2026-06-15)
  // — and (b) writes in the requester's actual language instead of the rigid
  // he/en branch. Fails open to `body`.
  //
  // #153-followup — AMEND composes too, and that closes the last relay that could
  // not speak the reader's language. Its template interpolates machine-built ENGLISH
  // labels ("55 minutes", "venue: Tel Aviv 3") into the Hebrew sentence, and no
  // label table fixes that: #153 opened the counter key set on purpose, so the
  // labels that need translating are exactly the ones nobody wrote prose for, and a
  // he/en table covers neither them nor a Russian or Spanish requester. The composer
  // needs no key knowledge at all.
  //
  // The reason amend was excluded is kept — in code, not by abstention: the decided
  // values are handed over PRE-RENDERED and pinned, and a composition that dropped
  // or altered one is discarded in favour of the template (amendCompositionFault).
  // The LLM owns the phrasing, code owns the decision, so the number cannot drift.
  // Two amend shapes deliberately stay on the template: a counter with no
  // machine-labelled part (pure owner prose — already human words, nothing to
  // relabel) and a question-shaped counter (his question must travel verbatim).
  const composeAmend = verdict === 'amend' && amendPinned.length > 0;
  if (verdict === 'approve' || verdict === 'reject' || composeAmend) {
    try {
      const rawAsk =
        (typeof details.question === 'string' && details.question.trim() ? details.question.trim() : '') ||
        (typeof details.subject === 'string' && details.subject.trim() ? details.subject.trim() : '') ||
        row.subject || subject;
      // The tool that RAN when one ran; else the one the ask was about.
      const deferredTool = executed?.tool
        ?? (details.deferred_action as { tool?: string } | undefined)?.tool;
      const actionHint =
        deferredTool === 'delete_meeting' ? 'a cancellation'
          : (deferredTool === 'move_meeting' || deferredTool === 'update_meeting') ? 'a change to an existing meeting'
            : (deferredTool === 'create_meeting') ? 'a booking'
              : undefined;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAnthropicClient } = require('../../llm/client') as typeof import('../../llm/client');
      const anthropic = getAnthropicClient();
      const assistantName = ctx.profile.assistant?.name ?? 'the assistant';
      // One definition of the language rule for both prompts.
      const langRule = requesterLang === 'he'
        ? 'write in Hebrew'
        : 'match the language of their request below (English / Spanish / etc.)';
      // S5 (2026-08-03 ruling) — threading this DM into origin_thread_ts (below)
      // only fixes WHERE it lands; this is what fixes what it KNOWS. Bounded
      // recent window (last 6 messages) off the same DB-backed store every other
      // outbound path already reads (postReply.ts / coordinator.ts / briefs.ts) —
      // one DB lookup, no Slack API call, so composing costs nothing extra over
      // the LLM call this block already makes. Nobody recalls a whole thread
      // verbatim; the bar is not contradicting or re-asking what's already there.
      let threadHistoryText = '';
      if (row.origin_thread_ts) {
        try {
          const { getConversationHistory } = require('../../db/conversations') as typeof import('../../db/conversations');
          threadHistoryText = getConversationHistory(row.origin_thread_ts)
            .slice(-6)
            .map(m => `${m.role === 'assistant' ? assistantName : (requesterFirst ?? 'them')}: ${m.content}`)
            .join('\n');
        } catch { /* best-effort — never block the relay on a history read */ }
      }
      const historyRule = threadHistoryText
        ? '- You are replying INTO an existing thread (history below) — read it. Do not repeat something already said or re-ask something already answered there; do not quote it back verbatim.'
        : '';
      const historyBlock = threadHistoryText ? `\nRecent thread so far (most recent last):\n${threadHistoryText}\n` : '';
      let sys: string;
      let usr: string;
      if (composeAmend) {
        sys = `You are ${assistantName}, ${ownerFirst}'s executive assistant, sending ONE short Slack message to ${requesterFirst ?? 'a colleague'} with ${ownerFirst}'s counter-proposal on something they asked you to arrange.
RULES:
- Language: ${langRule}.
- The DECIDED VALUES below are ${ownerFirst}'s actual decision. Reproduce each value EXACTLY as written, character for character — never round it, convert it, recalculate it, spell it out in words, or restate a time or date in another format. Translate and rephrase the words AROUND them, including the label each value carries.
- Say plainly that ${ownerFirst} can't do it exactly as asked and what he proposes instead, then ask whether that works for them. It is a proposal awaiting their yes or no, not a done deal.
- Do NOT mention approvals, "policy", internal tools, or that you "asked ${ownerFirst}" — just the human proposal, EA-voiced and natural.
- ONE or TWO sentences. A light "Hi ${requesterFirst ?? ''}" is fine; no sign-off.${historyRule ? `\n${historyRule}` : ''}`;
        usr = `${historyBlock}Their request: "${rawAsk}".${actionHint ? ` (This was ${actionHint}.)` : ''}
${ownerFirst}'s counter — DECIDED VALUES, copy each one exactly as given:
${amendPinned.map(p => `- ${p.key.replace(/_/g, ' ')} = ${p.value}`).join('\n')}${amendProse.length > 0 ? `\n${ownerFirst}'s own words (translate if you are writing in another language; keep the meaning): "${amendProse.join(' ')}"` : ''}
Write the message.`;
      } else {
        const outcome = verdict === 'approve'
          ? `${ownerFirst} said yes`
          : `${ownerFirst} can't make it work${reason && reason.trim() ? ` (${reason.trim()})` : ''}`;
        sys = `You are ${assistantName}, ${ownerFirst}'s executive assistant, sending ONE short, warm Slack message to ${requesterFirst ?? 'a colleague'} to close the loop on something they asked you to arrange with ${ownerFirst}.
RULES:
- Language: ${langRule}.
- Name the ACTION clearly, zero ambiguity. If their request was to CANCEL something, say it's cancelled / being taken care of — NEVER phrase it as "${ownerFirst} approved {the meeting}", which reads like approving the meeting itself. If it was a booking, say it's booked${startFormatted ? ` for ${startFormatted}` : ''}.
- Do NOT mention approvals, "policy", internal tools, or that you "asked ${ownerFirst}" — just the human outcome, EA-voiced and natural.
- ONE sentence. A light "Hi ${requesterFirst ?? ''}" is fine; no sign-off.${historyRule ? `\n${historyRule}` : ''}`;
        usr = `${historyBlock}Their request: "${rawAsk}".${actionHint ? ` (This was ${actionHint}.)` : ''} Outcome: ${outcome}.${startFormatted ? ` Scheduled for ${startFormatted}.` : ''} Write the message.`;
      }
      const resp = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 200,
        system: sys,
        messages: [{ role: 'user', content: usr }],
      });
      const composed = ((resp.content[0] as { text?: string })?.text ?? '').trim();
      if (composed) {
        const fault = composeAmend ? amendCompositionFault(composed, amendPinned) : null;
        if (fault) {
          logger.warn('notifyRequesterOfDecision — amend composition rejected, keeping the deterministic template', {
            id: row.id, fault, composedPreview: composed.slice(0, 120),
          });
        } else {
          body = composed;
        }
      }
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
      logger.info('notifyRequesterOfDecision — direct DM sent', {
        id: row.id, requesterSlackId, verdict, threadTs: row.origin_thread_ts ?? null,
      });
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
 * v2.9.1 — colleague responded to owner's counter (amending state). Hand the
 * decision back to the owner: the request is already back in awaiting_owner, and
 * this post re-stamps `terminal_dm_msg_ts`, so a ✅ HERE resolves the approval and
 * replays the stored action. That makes this a full owner-decision surface, not a
 * notification — so it composes through `composeOwnerAskText` like the other two
 * (first raise, re-ask revival) and cannot omit the proven hard reason or what a
 * yes actually does. It used to hand-roll its own line plus a locally-rebuilt
 * consequence, which is how a colleague's SUBJECT-ONLY counter could hand him a
 * ✅ that booked over a meeting he already had without ever naming the clash: the
 * counter moved no time at all, yet the proven collision appeared nowhere on the
 * message he ticked. Both verdicts route here — a ✅ after a colleague's REJECT
 * books just as surely as one after a counter.
 *
 * Reads the row FRESH: resolveRequest has just written `details.counter` (the
 * colleague's) and re-aimed the timers, and the `row` captured at entry predates
 * that. Reading it back is also what keeps the lead and the consequence on ONE
 * source — the stored counter that a ✅ will actually replay (R3).
 */
async function notifyOwnerOfColleaguePushback(
  row: RequestRow,
  verdict: 'reject' | 'amend',
  reason: string | undefined,
  ctx: ResolveContext,
): Promise<void> {
  const fresh = getRequest(row.id) ?? row;
  try {
    const details = parseDetails<Record<string, unknown>>(fresh) ?? {};
    const requesterName = fresh.requester_name?.split(' ')[0] ?? 'the colleague';
    const subject = fresh.subject || 'the ask';
    let lead: string;
    if (verdict === 'reject') {
      const tail = reason && reason.trim() ? ` (${reason.trim()})` : '';
      lead = `${requesterName} said the counter doesn't work${tail}. Back to you on "${subject}" — want to suggest something else, or drop it?`;
    } else {
      const stored = details.counter && typeof details.counter === 'object' && !Array.isArray(details.counter)
        ? details.counter as Record<string, unknown>
        : null;
      // Owner-facing, so instants render in HIS zone.
      const ownerTz = ctx.profile.user.timezone;
      const cnt = renderCounter(stored, {
        // Nothing is withheld from the man whose own system minted these ids, on a
        // surface no output gate scrubs anyway — and hiding a decided value from the
        // DECIDER is the one failure worse than showing him a `req_…`.
        audience: 'owner',
        formatInstant: iso => {
          const dt = DateTime.fromISO(iso, { zone: ownerTz });
          return dt.isValid ? dt.toFormat("cccc d MMM, HH:mm") : '';
        },
      }).text;
      lead = `${requesterName} countered with ${cnt || 'an alternative'} on "${subject}". Approve, reject, or counter again?`;
    }
    const body = await composeOwnerAskText({
      askText: fresh.description ?? fresh.subject,
      details,
      profile: ctx.profile,
      requestId: fresh.id,
      lead,
      reSurface: { raisedAt: fresh.created_at },
    });
    const { getConnection } = await import('../../connections/registry');
    const conn = getConnection(fresh.owner_user_id, 'slack');
    if (!conn) {
      logger.warn('notifyOwnerOfColleaguePushback — no Slack connection', { id: fresh.id });
      return;
    }
    // #45 — a decision coming BACK to the owner is still a decision, so it goes
    // in the signature book, not into a fresh top-level DM outside it. Today's
    // book, resolved at post time: a counter that lands days after the original
    // ask belongs in today's list of things needing his signature, not with the
    // day he last touched it (owner ruling 2026-07-25 — "new day, new tasks").
    // Re-stamp all three pointers so the row names where the ask now lives:
    // terminal_dm_msg_ts keeps ✅ working on THIS message, and owner_dm_thread_ts
    // is what threadBoundApprovalAutoResolve matches a typed reply against — the
    // row is back in awaiting_owner by now, so it's a live candidate there.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { postOwnerDecision } = require('../../utils/ownerDailyThread') as
      typeof import('../../utils/ownerDailyThread');
    const res = await postOwnerDecision({
      profile: ctx.profile, conn, text: body, label: `colleague ${verdict} bounce-back`,
    });
    if (res.ok) {
      updateRequest(fresh.id, {
        ownerDmChannel: res.channel ?? fresh.owner_dm_channel ?? undefined,
        ownerDmThreadTs: res.threadTs ?? fresh.owner_dm_thread_ts ?? undefined,
        terminalDmMsgTs: res.ts ?? fresh.terminal_dm_msg_ts ?? undefined,
      });
    }
  } catch (err) {
    logger.warn('notifyOwnerOfColleaguePushback — threw, non-fatal', {
      id: row.id, err: String(err).slice(0, 200),
    });
  }
}

/** Counter keys whose value is already a human sentence — relayed verbatim, unlabelled. */
const COUNTER_PROSE_KEYS = new Set(['text', 'message', 'reason', 'note', 'comment', 'question']);

/**
 * Readable phrasings for the counter keys this spine sees most. A key that is NOT
 * listed still renders (as "<key with spaces>: <value>") — the guarantee here is
 * that nothing is DROPPED, not that every possible key has hand-written prose.
 *
 * These labels are ENGLISH and deliberately stay that way: they are the wording of
 * the deterministic FALLBACK template. The primary requester-facing path composes
 * the whole sentence in the reader's own language (notifyRequesterOfDecision), which
 * is the only mechanism that can label a key nobody anticipated — and #153 opened
 * the key set on purpose. A per-language table here would cover he/en and only the
 * keys someone thought of: half the readers, half the keys.
 */
const COUNTER_KEY_PHRASING: Record<string, (v: string) => string> = {
  duration_min:     v => `${v} minutes`,
  duration_minutes: v => `${v} minutes`,
  slot_iso:         v => `a different time: ${v}`,
  start:            v => `a different time: ${v}`,
  new_start:        v => `a different time: ${v}`,
  to:               v => `move it to ${v}`,
  date:             v => `a different day: ${v}`,
  day:              v => `a different day: ${v}`,
};

/** ISO datetime = a language-independent STRUCTURED string, so regex is fine here. */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * amend-reason-bypasses-id-veto — the id veto `renderCounter` applies to a
 * counter's rendered parts, exposed so a free-text field that isn't counter-shaped
 * (the owner's `reason` on an amend, accepted by resolve_approval and typed by him
 * about a specific meeting — the field most likely to carry one of our own ids)
 * can be checked with the identical regex instead of a second, drifting copy.
 * One spelling of the rule, two call sites.
 *
 * The requester relay ships via conn.sendDirect, so the gate that owns this token
 * class (securityGate's `internal_ref_id` trigger) never sees it; and the one
 * scrubber that DOES run on every outbound (scrubInternalLeakage, inside
 * formatForSlack) has no rule for these ids — it wraps account ids into rendered
 * mentions and strips Graph ids, IANA tokens, sentinels and tool names, all of
 * which therefore need no veto here. These four prefixes (`req_`/`task_`/`out_`/
 * `ci_`) are the exact residual gap on this path, minted by this lane. The remedy
 * is the payload one (rule 10): the value never enters the text and never enters
 * the composer's context, rather than a scrub that runs after it has been written.
 */
export function textCarriesInternalWorkItemId(text: string): boolean {
  return INTERNAL_WORK_ITEM_ID_RE.test(text);
}

function renderCounterValue(raw: unknown, formatInstant?: (iso: string) => string): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return '';
    return ISO_DATETIME_RE.test(s) ? (formatInstant?.(s) || s) : s;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) {
    return raw.map(v => renderCounterValue(v, formatInstant)).filter(Boolean).join(', ');
  }
  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .map(([k, v]) => {
        const inner = renderCounterValue(v, formatInstant);
        if (!inner) return '';
        return COUNTER_PROSE_KEYS.has(k) ? inner : `${k.replace(/_/g, ' ')} ${inner}`;
      })
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

/**
 * Who is going to read the rendered counter. The owner sees his own decision whole;
 * a requester sees only what a colleague may be shown (rule 10 — the payload is
 * scoped to the reader, so what must not leak never enters the text at all).
 */
export type CounterAudience = 'owner' | 'requester';

/** The four views of ONE classification pass over the counter's keys. */
export interface CounterRendering {
  /** The deterministic sentence fragment — the fallback template's detail. */
  text: string;
  /**
   * Machine-labelled DECISION data. A language composer must reproduce each `value`
   * verbatim; that is what stops the decided number drifting when an LLM rewrites
   * the sentence around it.
   */
  pinned: Array<{ key: string; value: string }>;
  /** Values that are already human sentences — translatable, never pinned. */
  prose: string[];
  /** Keys withheld from THIS reader. Never silent: see the contract below. */
  withheld: string[];
}

/**
 * Render an owner (or colleague) counter for the surface that has to act on it, and
 * decide in the SAME pass what that surface may be shown. One classification of the
 * key set, four views of it — a second predicate over these keys, anywhere, is the
 * drift this function exists to prevent.
 *
 * #153 — this used to be a three-key WHITELIST (text / slot_iso / to) over a
 * payload that is open-ended BY DESIGN (R8: his resolution may differ wildly from
 * the ask; R9: open-ended in KIND). Every other shape returned '' — so Maayan's
 * 90→55 duration counter, stored as `{duration_min: 55, reason: "…"}`, was relayed
 * to her as "Idan suggested a different approach." with the decision itself
 * missing, and the owner-facing bounce-back said "countered with an alternative".
 * You cannot answer a counter you were never told.
 *
 * The contract: NO key is ever dropped. Known keys get a human phrasing, any other
 * key falls through to "<key with spaces>: <value>", nested objects/arrays recurse,
 * and ISO datetimes are localised via `formatInstant` when the caller has a zone to
 * render in (raw ISO is the fallback — ugly beats absent).
 *
 * #153-followup — ONE exception, and it is not a silent one. A part carrying an
 * internal work-item id is WITHHELD from a requester and named in `withheld`;
 * `resolve_approval` runs this same function before it stores anything and REFUSES
 * the amend when `withheld` is non-empty, naming the key it choked on. So the id
 * never reaches a colleague, the owner's decision is never quietly thinned on its
 * way to her, and the model is told exactly what to restate. That is how the
 * "allowlist what may be relayed" shape keeps its safety without re-creating the
 * whitelist that swallowed Maayan's `duration_min`: nothing passes through
 * unclassified, and a refusal is loud instead of an omission being quiet.
 *
 * Note the veto is on the RENDERED part (label + value), i.e. exactly the text that
 * would have shipped — not on the key name and not on the raw value.
 */
export function renderCounter(
  data: Record<string, unknown> | null | undefined,
  opts: { audience: CounterAudience; formatInstant?: (iso: string) => string },
): CounterRendering {
  const out: CounterRendering = { text: '', pinned: [], prose: [], withheld: [] };
  if (!data) return out;
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(data)) {
    const value = renderCounterValue(raw, opts.formatInstant);
    if (!value) continue;
    const isProse = COUNTER_PROSE_KEYS.has(key);
    const phrase = COUNTER_KEY_PHRASING[key];
    const part = isProse
      ? value
      : (phrase ? phrase(value) : `${key.replace(/_/g, ' ')}: ${value}`);
    if (opts.audience === 'requester' && INTERNAL_WORK_ITEM_ID_RE.test(part)) {
      out.withheld.push(key);
      continue;
    }
    parts.push(part);
    if (isProse) out.prose.push(value);
    else out.pinned.push({ key, value });
  }
  out.text = parts.join('; ');
  return out;
}

/**
 * Why a composed amend relay may NOT be sent, or null when it holds.
 *
 * This is the whole reason an LLM is allowed on the amend path at all: the composer
 * translates the labels and writes the sentence, but every decided value has to come
 * out the other side character-for-character, and it must not have invented an
 * internal id of its own (it was never shown one — a withheld part never enters the
 * prompt). A fault means the deterministic template ships instead: clumsy labels beat
 * a drifted number.
 */
function amendCompositionFault(
  composed: string,
  pinned: Array<{ key: string; value: string }>,
): string | null {
  const dropped = pinned.filter(p => !composed.includes(p.value)).map(p => p.key);
  if (dropped.length > 0) return `decided value(s) not reproduced verbatim: ${dropped.join(', ')}`;
  if (INTERNAL_WORK_ITEM_ID_RE.test(composed)) return 'composition carries an internal work-item id';
  return null;
}
