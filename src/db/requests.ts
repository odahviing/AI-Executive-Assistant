/**
 * Requests CRUD (v2.7.0).
 *
 * The spine. Read this file once and you understand every read/write against
 * the requests table. closeRequest lives in src/core/requests/closeRequest.ts
 * — kept out of the CRUD module because closure runs side-effects (DMs,
 * cascade) that belong in the core layer, not in db.
 */

import crypto from 'crypto';
import { DateTime } from 'luxon';
import { getDb } from './client';
import type {
  CreateRequestInput,
  NextCheckHandler,
  RequestPhase,
  RequestRow,
  RequestState,
} from '../core/requests/types';
import { ACTIVITY_REVERTIBILITY } from '../core/requests/activityRevertibility';
import logger from '../utils/logger';

// ── idempotency ──────────────────────────────────────────────────────────────

function normalizeSubject(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim();
}

export function buildIdempotencyKey(parts: {
  ownerUserId: string;
  requesterSlackId?: string | null;
  kind: string;
  subject: string;
}): string {
  const canonical = [
    parts.ownerUserId,
    parts.requesterSlackId ?? '_',
    parts.kind,
    normalizeSubject(parts.subject),
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

// ── phase validation (shared by BOTH write paths — see updateRequest) ───────

/**
 * Namespace/kind guard for `phase` (setPhase-dead-code-bypassed-by-tonights-
 * writes, 2026-08-12, round 2). A `phase` value is namespaced (`outreach:…`)
 * and only legal on the kind that namespace belongs to. Shared by
 * createRequest's INSERT and updateRequest's UPDATE branch so there is
 * exactly one validation RULE — even though there are necessarily two write
 * paths (an INSERT and an UPDATE statement) — instead of the rule being
 * re-typed twice and drifting between them.
 */
function isPhaseValidForKind(phase: string, kind: string): boolean {
  const ns = phase.split(':')[0];
  return ns === 'outreach' && (kind === 'outreach' || kind === 'social_outreach');
}

// ── create ──────────────────────────────────────────────────────────────────

export function createRequest(input: CreateRequestInput): RequestRow {
  const db = getDb();
  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Validate phase at creation too — this is the highest-volume phase write
  // in the system (every outreach_jobs row, via db/jobs.ts) and it INSERTs
  // straight into this row with no other gate in front of it.
  let phase: string | null = input.phase ?? null;
  if (phase !== null && !isPhaseValidForKind(phase, input.kind)) {
    logger.warn('createRequest — phase namespace/kind mismatch, dropping phase write', { kind: input.kind, phase });
    phase = null;
  }

  const idempotencyKey = input.idempotencyKey ?? buildIdempotencyKey({
    ownerUserId: input.ownerUserId,
    requesterSlackId: input.requesterSlackId ?? null,
    kind: input.kind,
    subject: input.subject,
  });

  // Default informed by initiator role: owner-initiated → 1 (he already knows
  // he asked), colleague/system-initiated → 0 (next brief surfaces it).
  const informed = input.informed ?? (input.initiatedByRole === 'owner' ? 1 : 0);

  db.prepare(`
    INSERT INTO requests (
      id, owner_user_id, initiated_by, initiated_by_role, parent_request_id,
      kind, subkind, subject, description,
      state, phase, state_changed_at,
      informed, surfaced_count,
      expires_at, next_check_at, next_check_handler,
      requester_slack_id, requester_name,
      target_slack_id, target_email, target_name,
      origin_channel, origin_thread_ts, origin_is_mpim,
      owner_dm_channel, owner_dm_thread_ts, terminal_dm_msg_ts,
      idempotency_key,
      outcome_external_event_id, outcome_json,
      details_json
    ) VALUES (
      @id, @owner_user_id, @initiated_by, @initiated_by_role, @parent_request_id,
      @kind, @subkind, @subject, @description,
      @state, @phase, datetime('now'),
      @informed, 0,
      @expires_at, @next_check_at, @next_check_handler,
      @requester_slack_id, @requester_name,
      @target_slack_id, @target_email, @target_name,
      @origin_channel, @origin_thread_ts, @origin_is_mpim,
      @owner_dm_channel, @owner_dm_thread_ts, @terminal_dm_msg_ts,
      @idempotency_key,
      @outcome_external_event_id, @outcome_json,
      @details_json
    )
  `).run({
    id,
    owner_user_id: input.ownerUserId,
    initiated_by: input.initiatedBy,
    initiated_by_role: input.initiatedByRole,
    parent_request_id: input.parentRequestId ?? null,
    kind: input.kind,
    subkind: input.subkind ?? null,
    subject: input.subject,
    description: input.description ?? null,
    state: input.state,
    phase,
    informed,
    expires_at: input.expiresAt ?? null,
    next_check_at: input.nextCheckAt ?? null,
    next_check_handler: input.nextCheckHandler ?? null,
    requester_slack_id: input.requesterSlackId ?? null,
    requester_name: input.requesterName ?? null,
    target_slack_id: input.targetSlackId ?? null,
    target_email: input.targetEmail ?? null,
    target_name: input.targetName ?? null,
    origin_channel: input.originChannel ?? null,
    origin_thread_ts: input.originThreadTs ?? null,
    origin_is_mpim: input.originIsMpim ? 1 : 0,
    owner_dm_channel: input.ownerDmChannel ?? null,
    owner_dm_thread_ts: input.ownerDmThreadTs ?? null,
    terminal_dm_msg_ts: input.terminalDmMsgTs ?? null,
    idempotency_key: idempotencyKey,
    outcome_external_event_id: input.outcomeExternalEventId ?? null,
    outcome_json: input.outcomeJson ? JSON.stringify(input.outcomeJson) : null,
    details_json: input.details ? JSON.stringify(input.details) : null,
  });

  const row = getRequest(id)!;
  logger.info('createRequest', {
    id, kind: input.kind, subkind: input.subkind, state: input.state,
    initiatedByRole: input.initiatedByRole, parentRequestId: input.parentRequestId,
  });
  return row;
}

// ── read ────────────────────────────────────────────────────────────────────

export function getRequest(id: string): RequestRow | null {
  return (getDb().prepare(`SELECT * FROM requests WHERE id = ?`).get(id) as RequestRow | null) ?? null;
}

/**
 * Find ANY request by idempotency key, regardless of state. Used by the
 * create_approval collision-recovery path: the idempotency_key UNIQUE
 * constraint is global, so a closed row (resolved/cancelled/expired) still
 * blocks a fresh INSERT with the same key. Without seeing closed rows here
 * the recovery lookup would miss → caller would re-throw SqliteError →
 * Sonnet sees a crash on a re-ask the user perceives as legitimate.
 *
 * Caller is expected to branch on row.state to decide between "still open,
 * follow-up reuse" and "already closed, replay refused".
 */
export function getRequestByIdempotencyKey(key: string): RequestRow | null {
  return (getDb().prepare(
    `SELECT * FROM requests WHERE idempotency_key = ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(key) as RequestRow | null) ?? null;
}

export function getOpenRequestsForOwner(ownerUserId: string): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND parent_request_id IS NULL
      AND state IN ('awaiting_owner','awaiting_colleague','in_flight')
    ORDER BY state, created_at ASC
  `).all(ownerUserId) as RequestRow[];
}

/**
 * v3.0.8 — open requests involving a specific colleague, as either requester
 * or target. Used by outreach send-path thread-continuity logic: when Maelle
 * is about to DM Dina, look up if there's an open conversation already
 * happening with Dina (either Dina-DM'd-Maelle or Maelle-DM'd-Dina earlier
 * and the conversation hasn't closed). If yes, the new outbound message
 * should thread into the existing conversation rather than open a new
 * top-level DM.
 *
 * Most-recently-updated first so the freshest active conversation wins
 * when there are multiple (unusual but possible).
 */
export function getOpenRequestsForColleague(
  ownerUserId: string,
  colleagueSlackId: string,
): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND (target_slack_id = ? OR requester_slack_id = ?)
      AND state IN ('awaiting_owner','awaiting_colleague','in_flight')
    ORDER BY updated_at DESC
  `).all(ownerUserId, colleagueSlackId, colleagueSlackId) as RequestRow[];
}

/**
 * v3.1.7 — the OWNER's return-thread for a recent outreach to this colleague.
 *
 * When the owner asks Maelle (in a DM thread) to message a colleague, the
 * outreach records the owner's conversation thread in owner_dm_channel /
 * owner_dm_thread_ts. Later, when the colleague's reply gets relayed back to
 * the owner (e.g. as an approval), this lets the relay land in the OWNER's
 * ORIGINAL conversation thread instead of a new top-level DM.
 *
 * Most-recent outreach targeting this colleague that carries an owner thread,
 * within the last 2 days (open OR recently closed — fire-and-forget outreach
 * closes immediately, so we can't gate on open-state). Returns null if none.
 */
export function getRecentOutreachOwnerThread(
  ownerUserId: string,
  colleagueSlackId: string,
): { owner_dm_channel: string; owner_dm_thread_ts: string } | null {
  const row = getDb().prepare(`
    SELECT owner_dm_channel, owner_dm_thread_ts FROM requests
    WHERE owner_user_id = ?
      AND kind = 'outreach'
      AND target_slack_id = ?
      AND owner_dm_thread_ts IS NOT NULL
      AND created_at > datetime('now', '-2 days')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(ownerUserId, colleagueSlackId) as { owner_dm_channel: string; owner_dm_thread_ts: string } | undefined;
  return row ?? null;
}

/**
 * chris-kelley-oof-block-c round 2 (2026-08-18) — the LATEST freeform-owner-
 * flag row (tasks/skill.ts's flagUnresolvedFreeformForOwner) raised by this
 * colleague in this thread, ANY state. That function's own idempotency key
 * only ever matches the FIRST row it ever inserts for a given thread — once
 * a genuinely new ask mints its own fresh key (so the UNIQUE constraint
 * doesn't block it), getRequestByIdempotencyKey(baseKey) keeps finding that
 * same original row forever and can never see the most recent one. This
 * finds it directly, scoped to exactly this backstop, never a real
 * approval/outreach/reminder that happens to share the same thread.
 *
 * Round 3 (bouncer overturn, 2026-08-18): round 2 scoped on
 * `kind='reminder' AND subkind='freeform_owner_flag'`, but that shape is NOT
 * unique to this backstop — runOutputGates.ts's claim-checker relay backstop
 * mints the identical kind/subkind for an entirely different alert (both are
 * merely co-excluded from the colleague pending-cap count, per jobs.ts:70-80
 * — that's a shared EXCLUSION CATEGORY, never a shared mechanism identity).
 * A claim-checker row in the same thread was matching here and getting
 * treated as "still delivering"/"recently delivered", silently swallowing a
 * later, genuinely different real ask. Scoped instead on `subkind =
 * 'freeform_owner_ask'` — a value only flagUnresolvedFreeformForOwner ever
 * writes — so this can never match the claim-checker's rows again. (The
 * shared 'freeform_owner_flag' value is untouched on the claim-checker's own
 * rows; it stays load-bearing there for the same pending-cap exclusion.)
 * `next_check_handler` was considered and rejected as the discriminator
 * instead: this backstop's own confirmed-delivery path (the common case)
 * never sets one, and closeRequest unconditionally nulls it on every
 * terminal transition — it can't tell a `logged`/`cancelled` row apart from
 * anything else.
 */
export function getLatestFreeformOwnerFlag(
  ownerUserId: string,
  requesterSlackId: string,
  threadTs: string,
): RequestRow | null {
  const row = getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND requester_slack_id = ?
      AND origin_thread_ts = ?
      AND kind = 'reminder'
      AND subkind = 'freeform_owner_ask'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(ownerUserId, requesterSlackId, threadTs) as RequestRow | undefined;
  return row ?? null;
}

/**
 * Pending owner-decision requests — drives the system-prompt injection block.
 * Top-level rows only; awaiting_owner state.
 */
export function getAwaitingOwnerRequests(ownerUserId: string): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND parent_request_id IS NULL
      AND state = 'awaiting_owner'
    ORDER BY created_at ASC
  `).all(ownerUserId) as RequestRow[];
}

/**
 * Thread-scoped open requests — surfaced to colleague-path Sonnet so she
 * doesn't re-fire create_approval on the same ack. Privacy: only requests
 * originated in this thread leak.
 */
export function getOpenRequestsForThread(ownerUserId: string, threadTs: string): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND origin_thread_ts = ?
      AND state IN ('awaiting_owner','awaiting_colleague','in_flight')
    ORDER BY created_at ASC
  `).all(ownerUserId, threadTs) as RequestRow[];
}

/**
 * #145-followup (Oran "still waiting" on a dead approval, 2026-07-22) — the LATEST
 * request that originated in this thread, ANY state (including terminal). The
 * colleague-path context only surfaces OPEN thread requests (getOpenRequestsForThread),
 * so a colleague chasing a resolved/expired/cancelled approval got NO state signal and
 * the model confabulated "still waiting on Idan." This returns the real row so the
 * colleague-path can answer honestly (and, on a terminal row, offer to revive it).
 * Thread-scoped for privacy — only the row from THIS conversation's thread. Returns
 * null when the thread never carried a request.
 *
 * gh#52 (52-U11) — `state != 'logged'` excludes logActivity() rows. Those
 * record something Maelle did on the OWNER's behalf (a DM sent, an approval
 * resolved) and are not scoped to protect a colleague's own privacy the way
 * every other row here is; without this a colleague chasing their own
 * request in a thread could have the newest row in that thread be an
 * unrelated activity record instead of their actual request, and
 * systemPrompt.ts's threadRequestStatusSection would render its terminal
 * state straight to them (the 'cancelled' fallback branch, since 'logged'
 * matches neither its 'resolved' nor 'expired' checks).
 */
export function getLatestRequestForThread(ownerUserId: string, threadTs: string): RequestRow | null {
  const row = getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND origin_thread_ts = ?
      AND state != 'logged'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(ownerUserId, threadTs) as RequestRow | undefined;
  return row ?? null;
}

/**
 * o#224 — ground truth for the room-approval honesty check (claimChecker's
 * approvalGrantContext) needs more than "the single newest request in this
 * thread": 12 of 47 live request-carrying threads hold 2+ rows, and when an
 * OLDER row was approved while a NEWER one is still pending,
 * getLatestRequestForThread's newest-row state alone made a TRUTHFUL "he
 * approved it" claim about the older row look false and get rewritten away —
 * inverting a correct reply, the one failure G5 forbids outright. Until the
 * checker can bind a claim to the SPECIFIC request row a sentence is about
 * (real NLP work, not a query), the safe ground truth is "was ANY request in
 * this thread EVER resolved" — a true grant anywhere in the thread's history
 * makes a "he approved it" claim plausible and must never be inverted. This
 * only under-catches the rarer case of a false claim about a *different*,
 * still-pending request in the same thread, which is a safe MISS (G5), not a
 * corrupted reply.
 */
export function anyRequestResolvedForThread(ownerUserId: string, threadTs: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM requests
    WHERE owner_user_id = ?
      AND origin_thread_ts = ?
      AND state = 'resolved'
    LIMIT 1
  `).get(ownerUserId, threadTs);
  return !!row;
}

/**
 * gh#154-R6 (2026-08-06), narrowed by gh#154-R7 (2026-08-06) — ground truth for whether a
 * decision is genuinely outstanding RIGHT NOW (`awaiting_owner`), as opposed
 * to merely "a request row exists somewhere in this thread's history". This
 * answers ONE of the two questions the room-approval honesty check needs —
 * "is a decision still pending" — not "is a fabricated grant claim still a
 * risk on this thread". The caller (runOutputGates.ts) combines this with
 * `anyRequestResolvedForThread`: a thread that resolved stops being a risk
 * (a "he approved it" claim there is plausibly true), but a thread whose only
 * requests went CANCELLED or EXPIRED (never resolved) reads `isResolved=false`
 * PERMANENTLY — and that is exactly the standing risk, not a false positive:
 * a "he approved it" claim on a cancelled thread is provably false for as
 * long as the thread stays active. Do not use this function alone to decide
 * whether the honesty check should run at all — see the call site.
 */
export function anyRequestPendingForThread(ownerUserId: string, threadTs: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM requests
    WHERE owner_user_id = ?
      AND origin_thread_ts = ?
      AND state = 'awaiting_owner'
    LIMIT 1
  `).get(ownerUserId, threadTs);
  return !!row;
}

export function getChildRequests(parentId: string): RequestRow[] {
  return getDb().prepare(
    `SELECT * FROM requests WHERE parent_request_id = ? ORDER BY created_at ASC`
  ).all(parentId) as RequestRow[];
}

/**
 * Emoji ✅ resolution — find the (one) pending request whose terminal DM ts
 * matches. NULL when no match (msg wasn't a terminal ask, or already closed).
 * Only matches OPEN requests; ✅ on a stale closure DM is a no-op.
 */
export function getRequestByTerminalMsgTs(msgTs: string): RequestRow | null {
  return (getDb().prepare(`
    SELECT * FROM requests
    WHERE terminal_dm_msg_ts = ?
      AND state IN ('awaiting_owner','awaiting_colleague','in_flight')
    ORDER BY created_at DESC LIMIT 1
  `).get(msgTs) as RequestRow | null) ?? null;
}

/**
 * gh#174-a — does `candidateThreadTs` already anchor a DIFFERENT tracked
 * request for this owner (its own decision thread root, or the ts of one of
 * its posted asks)? Checked before resolve_approval's chronological fallback
 * (tasks/skill.ts) binds an unanchored reply to the sole open approval: if the
 * owner deliberately replied inside a thread that belongs to some OTHER
 * request (any kind — an outreach relay, a different approval's own thread),
 * that is a real anchor to THAT conversation and must never be reinterpreted
 * as an answer to this one just because this one happens to be the only
 * approval currently open.
 */
export function isKnownRequestThreadAnchor(
  ownerUserId: string,
  candidateThreadTs: string,
  excludeRequestId: string,
): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM requests
    WHERE owner_user_id = ?
      AND id != ?
      AND (owner_dm_thread_ts = ? OR terminal_dm_msg_ts = ?)
    LIMIT 1
  `).get(ownerUserId, excludeRequestId, candidateThreadTs, candidateThreadTs);
  return !!row;
}

/** Requests due for time-based reaction sweep. */
export function getDueRequests(): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE next_check_at IS NOT NULL
      AND datetime(next_check_at) <= datetime('now')
      AND state IN ('awaiting_owner','awaiting_colleague','in_flight')
  `).all() as RequestRow[];
}

/**
 * Brief read: requests that should surface this morning. Either:
 *   - open state AND last_surfaced_at is older than `briefingDayStart`
 *   - OR informed=0 (covers post-closure narration)
 * Top-level rows only.
 *
 * gh#52 (52-U1) — `state != 'logged'` is an EXPLICIT, unconditional exclusion,
 * not folded into the `informed = 0` arm it would otherwise ride along with.
 * logActivity() rows record something Maelle already did that needed no
 * owner decision — pulled (undo/history), never pushed to the brief — and
 * they are minted with no control over `informed` from this function's point
 * of view, so guarding only the OR-branch would leave the door open the
 * moment a caller's default informed value ever changed. Excluding the state
 * outright makes a 'logged' row surfacing here impossible by construction.
 */
export function getRequestsForBrief(ownerUserId: string, briefingDayStartIso: string): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND parent_request_id IS NULL
      AND state != 'logged'
      AND (
        (state IN ('awaiting_owner','awaiting_colleague','in_flight')
         AND (last_surfaced_at IS NULL OR datetime(last_surfaced_at) < datetime(?)))
        OR informed = 0
      )
    ORDER BY
      CASE state
        WHEN 'awaiting_owner' THEN 0
        WHEN 'awaiting_colleague' THEN 1
        WHEN 'in_flight' THEN 2
        WHEN 'resolved' THEN 3
        WHEN 'cancelled' THEN 4
        WHEN 'expired' THEN 5
        ELSE 6
      END,
      created_at DESC
  `).all(ownerUserId, briefingDayStartIso) as RequestRow[];
}

/** All requests linked to a Graph meeting (used by closeMeetingArtifacts replacement). */
export function getRequestsByExternalEventId(ownerUserId: string, eventId: string): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND outcome_external_event_id = ?
      AND state IN ('awaiting_owner','awaiting_colleague','in_flight')
  `).all(ownerUserId, eventId) as RequestRow[];
}

/**
 * gh#52 (52-U4b) — generalized replacement for the old auto-move-only
 * `getRevertibleAutoMove`. The newest activity row a generic "undo that" /
 * revert dispatch might act on, spanning every subkind
 * ACTIVITY_REVERTIBILITY (core/requests/activityRevertibility.ts) knows
 * about, PLUS the auto-fix engine's own `auto_move` subkind — a REQUEST
 * subkind, not a literal tool name (its underlying tool IS `move_meeting`,
 * per that table's own key-naming comment), so it gets its own state/
 * closure_reason shape here (`resolved` + `auto_move_executed`, matching the
 * old query exactly) rather than a table key of its own.
 *
 * Returns the single newest qualifying row REGARDLESS of whether it is
 * itself revertible or whether the event it acted on has already passed —
 * that filtering is the caller's job, reading ACTIVITY_REVERTIBILITY (+
 * isEventStillUpcoming), because a non-revertible or already-past row must
 * still be findable so the revert dispatch can name it honestly ("I can't
 * undo the cancellation") instead of silently reaching past it to an older
 * row that IS still eligible, which would undo the wrong thing. NULL only
 * when nothing qualifying exists at all.
 *
 * A completed revert relabels `closure_reason` on the row it acted on
 * (retiring it from this query — the pre-existing double-revert guard,
 * generalized to every subkind rather than a new column).
 *
 * Owner ruling 2026-08-12 (revert-intent-and-single-step-undo-scope): this
 * zero-arg lookup is ALSO bounded to rows logged in the last 30 days (see
 * REVERTIBLE_ACTIVITY_MAX_AGE_DAYS below) — a bare "undo that" names nothing,
 * so it should not reach weeks back just because the event it acted on is
 * still upcoming. getRevertibleActivityById has no such bound: naming a
 * specific past action is deliberate and may reach arbitrarily far back.
 */
// bouncer fix (revert-intent-and-single-step-undo-scope, cleanup round 2) —
// the exact kind/subkind/state/closure_reason shape a revert candidate must
// have, shared verbatim by getRevertibleActivity and getRevertibleActivityById
// below (was two hand-maintained copies) so a future eligibility edit can't
// land in one and miss the other.
const REVERTIBLE_ACTIVITY_SUBKINDS = Object.keys(ACTIVITY_REVERTIBILITY);
const REVERTIBLE_ACTIVITY_PLACEHOLDERS = REVERTIBLE_ACTIVITY_SUBKINDS.map(() => '?').join(',');
const REVERTIBLE_ACTIVITY_PREDICATE = `
      kind = 'follow_up'
      AND (
        (subkind = 'auto_move' AND state = 'resolved' AND closure_reason = 'auto_move_executed')
        OR (subkind IN (${REVERTIBLE_ACTIVITY_PLACEHOLDERS}) AND state = 'logged' AND closure_reason IS NULL)
      )
`;

// Owner ruling 2026-08-12 (revert-intent-and-single-step-undo-scope) — the
// explicit by-id path (getRevertibleActivityById below) may reach arbitrarily
// far back because the owner named a specific past action deliberately. The
// bare zero-arg "undo that" has nothing named, so it stays bounded: it must
// not accidentally reach a row logged weeks ago just because the event it
// acted on happens to still be upcoming. Bounded on `created_at` (when the
// action was LOGGED), not the event's own date — that's the separate
// isEventStillUpcoming check the caller already does.
const REVERTIBLE_ACTIVITY_MAX_AGE_DAYS = 30;

export function getRevertibleActivity(ownerUserId: string): RequestRow | null {
  return (getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND ${REVERTIBLE_ACTIVITY_PREDICATE}
      AND datetime(created_at) >= datetime('now', '-${REVERTIBLE_ACTIVITY_MAX_AGE_DAYS} days')
    ORDER BY datetime(COALESCE(closed_at, created_at)) DESC
    LIMIT 1
  `).get(ownerUserId, ...REVERTIBLE_ACTIVITY_SUBKINDS) as RequestRow | null) ?? null;
}

/**
 * gh#52 follow-up (revert-intent-and-single-step-undo-scope, piece 2) — the
 * SAME eligibility predicate as getRevertibleActivity above (identical
 * kind/subkind/state/closure_reason shape), generalized to a SPECIFIC row
 * instead of "whichever is newest": the owner describes a past action ("undo
 * the move I made for Dana yesterday") and a caller (matching against
 * get_my_tasks's recent_activity, piece 3) already knows which request id
 * that is. Returns null when the id doesn't exist, isn't this owner's, or
 * doesn't match the shape getRevertibleActivity requires — a row outside
 * that shape was never a revert candidate in the first place, by id or
 * otherwise. Revertibility / event-still-upcoming filtering (ACTIVITY_
 * REVERTIBILITY + isEventStillUpcoming) is still the caller's job here too —
 * this only targets WHICH row. getRevertibleActivity() itself is untouched
 * and stays the zero-argument default for "just undo the last thing."
 */
export function getRevertibleActivityById(ownerUserId: string, requestId: string): RequestRow | null {
  return (getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND id = ?
      AND ${REVERTIBLE_ACTIVITY_PREDICATE}
  `).get(ownerUserId, requestId, ...REVERTIBLE_ACTIVITY_SUBKINDS) as RequestRow | null) ?? null;
}

/**
 * v3.7.x (#139) — event ids the owner's calendar-health auto-moved in the last
 * 12h (executed, not yet reverted). The double_booking detector consults this so
 * that when a cleared clash RE-APPEARS — meaning the owner reverted the move (by
 * hand or via revert_last_auto_move) — active mode does NOT re-move it. This is
 * the "auto-fix has memory" guard; it reads the record 3.7.1 already writes.
 */
export function getRecentlyAutoMovedEventIds(ownerUserId: string): Set<string> {
  const cutoff = DateTime.now().minus({ hours: 12 }).toUTC().toISO()!;
  const rows = getDb().prepare(`
    SELECT DISTINCT outcome_external_event_id AS id FROM requests
    WHERE owner_user_id = ?
      AND kind = 'follow_up' AND subkind = 'auto_move'
      AND state = 'resolved'
      AND closure_reason = 'auto_move_executed'
      AND closed_at >= ?
      AND outcome_external_event_id IS NOT NULL
  `).all(ownerUserId, cutoff) as Array<{ id: string }>;
  return new Set(rows.map(r => r.id));
}

/**
 * v3.7.x (#141) — the inverse of findMeetingOwner (which goes event_id →
 * requester). Meetings a COLLEAGUE requested (booked through Maelle), so a
 * requester can act on a meeting they set up even when it isn't on their shared
 * calendar — the colleague get_calendar clamp hides meetings they aren't an
 * attendee of. Matches `colleague_booking_record` rows (which link an event id);
 * with `includeApprovals`, also `approval` rows that name a requester (the
 * approval-booked case — requester provable even before the event id is linked
 * back). Newest first.
 */
export function getMeetingsRequestedBy(
  ownerUserId: string,
  requesterSlackId: string,
  opts?: { sinceIso?: string; includeApprovals?: boolean; withEventIdOnly?: boolean },
): RequestRow[] {
  if (!ownerUserId || !requesterSlackId) return [];
  const clauses = ['owner_user_id = ?', 'requester_slack_id = ?'];
  const params: unknown[] = [ownerUserId, requesterSlackId];
  clauses.push(opts?.includeApprovals
    ? "(subkind = 'colleague_booking_record' OR kind = 'approval')"
    : "subkind = 'colleague_booking_record'");
  // v3.7.x (#143 residual #3) — exclude records whose meeting was cancelled/
  // deleted. The delete cascade marks the colleague_booking_record 'cancelled'
  // (it's created 'resolved', so the open-state request cascade skips it). Without
  // this the stale event id surfaced in the MEETINGS-YOU-REQUESTED block and a
  // move/cancel attempt pinged the owner about a meeting that no longer exists.
  clauses.push("state != 'cancelled'");
  if (opts?.withEventIdOnly) clauses.push('outcome_external_event_id IS NOT NULL');
  if (opts?.sinceIso) { clauses.push('datetime(created_at) >= datetime(?)'); params.push(opts.sinceIso); }
  return getDb().prepare(
    `SELECT * FROM requests WHERE ${clauses.join(' AND ')} ORDER BY datetime(created_at) DESC`
  ).all(...params) as RequestRow[];
}

/**
 * v3.7.x (#143 residual #3) — when a colleague-requested meeting is DELETED, mark
 * its colleague_booking_record cancelled. That record is created 'resolved' at
 * book time, so the open-state cascade in closeMeetingArtifacts never touches it;
 * a direct UPDATE is needed to retire the stale requester→event link so
 * getMeetingsRequestedBy stops surfacing a dead meeting. Idempotent (skips rows
 * already cancelled). Only fires on delete — a MOVED meeting stays live so the
 * requester can still act on it.
 */
export function cancelColleagueBookingRecordsForEvent(ownerUserId: string, eventId: string): void {
  if (!ownerUserId || !eventId) return;
  const rows = getDb().prepare(`
    SELECT id FROM requests
    WHERE owner_user_id = ? AND subkind = 'colleague_booking_record'
      AND outcome_external_event_id = ? AND state != 'cancelled'
  `).all(ownerUserId, eventId) as Array<{ id: string }>;
  if (rows.length === 0) return;
  getDb().prepare(`
    UPDATE requests
    SET state = 'cancelled', closure_reason = 'meeting_deleted', closed_by = 'meeting_cascade',
        closed_at = datetime('now'), state_changed_at = datetime('now'), updated_at = datetime('now')
    WHERE owner_user_id = ? AND subkind = 'colleague_booking_record'
      AND outcome_external_event_id = ? AND state != 'cancelled'
  `).run(ownerUserId, eventId);
  // This is closeRequest.ts's ONE named exception to "no direct terminal
  // write" (these rows are born 'resolved', so its already-terminal guard
  // would no-op them) — so it mirrors closeRequest's audit_log row itself:
  // every terminal transition stays on the record. Audit failure never blocks
  // the cascade, same as there.
  try {
    const audit = getDb().prepare(`
      INSERT INTO audit_log (owner_user_id, action, source, actor, target, details, outcome)
      VALUES (?, 'request_closed', 'requests.cancelColleagueBookingRecordsForEvent', 'meeting_cascade', ?, ?, 'success')
    `);
    for (const r of rows) {
      audit.run(ownerUserId, r.id, JSON.stringify({
        state: 'cancelled', closure_reason: 'meeting_deleted', event_id: eventId,
      }));
    }
  } catch (err) {
    logger.warn('cancelColleagueBookingRecordsForEvent — audit log insert threw', { err: String(err).slice(0, 200) });
  }
}

/**
 * gh#52 (52-U6) — recall of Maelle's own completed activity: `logged`-state
 * rows written by logActivity() (a colleague DM, a resolved approval, a
 * research run — see logActivity.ts for the exact scope). Newest first, NO
 * time-based cutoff ever (owner's explicit ruling: this table is never
 * pruned — 52-U9 already deleted the prune job outright). `limit` is the
 * only cost control; a caller asking "what did you do three months ago"
 * must still find it as long as it's inside the limit.
 */
export function getRecentActivityForOwner(ownerUserId: string, limit: number): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND state = 'logged'
    ORDER BY datetime(created_at) DESC
    LIMIT ?
  `).all(ownerUserId, limit) as RequestRow[];
}

/** For closeLoopOnOwnerHandled scanner — collect open top-level requests for the LLM. */
export function getOpenScannerItems(ownerUserId: string): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND parent_request_id IS NULL
      AND state IN ('awaiting_owner','awaiting_colleague','in_flight')
    ORDER BY updated_at DESC
    LIMIT 25
  `).all(ownerUserId) as RequestRow[];
}

// ── update ──────────────────────────────────────────────────────────────────

export interface UpdateRequestPatch {
  state?: RequestState;
  /**
   * v3.1 — kind-namespaced activity sub-state. Typed `RequestPhase | null`
   * (updateRequestPatch-phase-typed-string-not-RequestPhase, 2026-08-14) — the
   * standalone `setPhase(id, phase: RequestPhase)` export that used to give this
   * write a compile-time literal check was deleted as dead code (2026-08-12,
   * see isPhaseValidForKind's header) and its runtime replacement only checks
   * the NAMESPACE prefix, not the exact literal, so a typo'd phase like
   * `'outreach:reengaged'` (vs the real `'outreach:re_engaged'`) used to write
   * cleanly as a bare `string` and silently defeat every exact-match reader.
   * Restoring the union type here makes that a compile error again.
   */
  phase?: RequestPhase | null;
  closureReason?: string;
  closedBy?: string;
  closedAt?: string;
  informed?: number;
  surfacedCount?: number;
  lastSurfacedAt?: string;
  expiresAt?: string | null;
  nextCheckAt?: string | null;
  nextCheckHandler?: NextCheckHandler | null;
  terminalDmMsgTs?: string;
  ownerDmChannel?: string;
  ownerDmThreadTs?: string;
  // v3.0.8 — repurposed for outreach kind: anchor the request's origin to
  // the colleague-side DM thread after the first outbound send (option A
  // in the Dina-2-DMs thread-continuity fix). Other kinds keep origin
  // meaning "where the user originated the ask."
  originChannel?: string;
  originThreadTs?: string;
  outcomeExternalEventId?: string | null;
  outcomeJson?: Record<string, unknown>;
  details?: Record<string, unknown>;
  description?: string;
  subject?: string;
  /** v3.1 — stamp when the colleague-requester has been told the outcome (idempotency). */
  requesterNotifiedAt?: string | null;
  /** Recompute + rewrite ONLY when a subject correction must not stay matchable by the old subject's key (see refreshIfOpen, skill.ts). */
  idempotencyKey?: string;
}

export function updateRequest(id: string, patch: UpdateRequestPatch): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (patch.state !== undefined) {
    sets.push(`state = @state`, `state_changed_at = datetime('now')`);
    params.state = patch.state;
  }
  if (patch.phase !== undefined) {
    if (patch.phase === null) {
      sets.push(`phase = @phase`); params.phase = patch.phase;
    } else {
      // Namespace/kind guard (setPhase-dead-code-bypassed-by-tonights-writes,
      // 2026-08-12) — this validation used to live in a standalone `setPhase`
      // export that had zero callers; every real phase write (including the
      // two added tonight, coordinator.ts + meetingReschedule.ts) went through
      // this function's raw field instead, bypassing it entirely. Inlined here
      // and shared (isPhaseValidForKind, above createRequest) with the INSERT
      // path in this same file, so BOTH places a `phase` can land on a row are
      // validated by the one rule — round 2 (still same day) closed the INSERT
      // gap: db/jobs.ts's createOutreachJob → requests.createRequest was the
      // highest-volume phase write of all and had no gate whatsoever.
      const row = getRequest(id);
      const kindOk = !!row && isPhaseValidForKind(patch.phase, row.kind);
      if (!kindOk) {
        logger.warn('updateRequest — phase namespace/kind mismatch, ignoring phase write', { id, kind: row?.kind, phase: patch.phase });
      } else {
        sets.push(`phase = @phase`); params.phase = patch.phase;
      }
    }
  }
  if (patch.closureReason !== undefined) { sets.push(`closure_reason = @closure_reason`); params.closure_reason = patch.closureReason; }
  if (patch.closedBy !== undefined) { sets.push(`closed_by = @closed_by`); params.closed_by = patch.closedBy; }
  if (patch.closedAt !== undefined) { sets.push(`closed_at = @closed_at`); params.closed_at = patch.closedAt; }
  if (patch.informed !== undefined) { sets.push(`informed = @informed`); params.informed = patch.informed; }
  if (patch.surfacedCount !== undefined) { sets.push(`surfaced_count = @surfaced_count`); params.surfaced_count = patch.surfacedCount; }
  if (patch.lastSurfacedAt !== undefined) { sets.push(`last_surfaced_at = @last_surfaced_at`); params.last_surfaced_at = patch.lastSurfacedAt; }
  if (patch.expiresAt !== undefined) { sets.push(`expires_at = @expires_at`); params.expires_at = patch.expiresAt; }
  if (patch.nextCheckAt !== undefined) { sets.push(`next_check_at = @next_check_at`); params.next_check_at = patch.nextCheckAt; }
  if (patch.nextCheckHandler !== undefined) { sets.push(`next_check_handler = @next_check_handler`); params.next_check_handler = patch.nextCheckHandler; }
  if (patch.terminalDmMsgTs !== undefined) { sets.push(`terminal_dm_msg_ts = @terminal_dm_msg_ts`); params.terminal_dm_msg_ts = patch.terminalDmMsgTs; }
  if (patch.originChannel !== undefined) { sets.push(`origin_channel = @origin_channel`); params.origin_channel = patch.originChannel; }
  if (patch.originThreadTs !== undefined) { sets.push(`origin_thread_ts = @origin_thread_ts`); params.origin_thread_ts = patch.originThreadTs; }
  if (patch.ownerDmChannel !== undefined) { sets.push(`owner_dm_channel = @owner_dm_channel`); params.owner_dm_channel = patch.ownerDmChannel; }
  if (patch.ownerDmThreadTs !== undefined) { sets.push(`owner_dm_thread_ts = @owner_dm_thread_ts`); params.owner_dm_thread_ts = patch.ownerDmThreadTs; }
  if (patch.outcomeExternalEventId !== undefined) { sets.push(`outcome_external_event_id = @outcome_external_event_id`); params.outcome_external_event_id = patch.outcomeExternalEventId; }
  if (patch.outcomeJson !== undefined) { sets.push(`outcome_json = @outcome_json`); params.outcome_json = JSON.stringify(patch.outcomeJson); }
  if (patch.details !== undefined) { sets.push(`details_json = @details_json`); params.details_json = JSON.stringify(patch.details); }
  if (patch.description !== undefined) { sets.push(`description = @description`); params.description = patch.description; }
  if (patch.subject !== undefined) { sets.push(`subject = @subject`); params.subject = patch.subject; }
  if (patch.requesterNotifiedAt !== undefined) { sets.push(`requester_notified_at = @requester_notified_at`); params.requester_notified_at = patch.requesterNotifiedAt; }
  if (patch.idempotencyKey !== undefined) { sets.push(`idempotency_key = @idempotency_key`); params.idempotency_key = patch.idempotencyKey; }

  if (sets.length === 0) return;

  sets.push(`updated_at = datetime('now')`);
  getDb().prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/** Stamp brief surfacing — atomically increments surfaced_count + sets timestamps + flips informed=1. */
export function markRequestSurfaced(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE requests
    SET surfaced_count = surfaced_count + 1,
        last_surfaced_at = datetime('now'),
        informed = 1,
        updated_at = datetime('now')
    WHERE id = ?
  `);
  const tx = db.transaction((ids: string[]) => { for (const id of ids) stmt.run(id); });
  tx(ids);
}

// ── timing helpers ──────────────────────────────────────────────────────────

/**
 * Compute today_start in the owner's timezone, returned as a UTC ISO string
 * for SQL comparison. Drives the brief's "surface if last_surfaced_at <
 * today_start" filter.
 */
export function todayStartUtcIso(ownerTz: string): string {
  return DateTime.now().setZone(ownerTz).startOf('day').toUTC().toISO()!;
}
