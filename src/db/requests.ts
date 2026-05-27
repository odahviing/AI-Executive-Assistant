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

// ── create ──────────────────────────────────────────────────────────────────

export function createRequest(input: CreateRequestInput): RequestRow {
  const db = getDb();
  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

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
    phase: input.phase ?? null,
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
 */
export function getRequestsForBrief(ownerUserId: string, briefingDayStartIso: string): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND parent_request_id IS NULL
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

/** For outreach reply matching — open outreach for this colleague awaiting reply. */
export function getOpenOutreachForColleague(
  ownerUserId: string,
  colleagueSlackId: string,
): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND kind IN ('outreach','social_outreach')
      AND target_slack_id = ?
      AND state = 'awaiting_colleague'
    ORDER BY created_at DESC
  `).all(ownerUserId, colleagueSlackId) as RequestRow[];
}

// ── v3.1 (Path 2) — coord status queries off the spine ────────────────────────
// These replace the coord_jobs.status readers (getActiveCoordJobs,
// getCoordJobsByParticipant, getPendingRequestCountForColleague). The coord's
// STATUS now lives on its parent request (kind='coord'); coord_jobs keeps only
// the DATA (participants, slots), joined by request_id when content is needed.

/** Open coord requests for an owner (top-level coord parents still in flight). */
export function getOpenCoordRequests(ownerUserId: string): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND kind = 'coord'
      AND parent_request_id IS NULL
      AND state IN ('awaiting_owner','in_flight')
    ORDER BY created_at ASC
  `).all(ownerUserId) as RequestRow[];
}

/** Set the kind-namespaced activity phase, validating the namespace matches kind. */
export function setPhase(id: string, phase: RequestPhase): void {
  const row = getRequest(id);
  if (!row) return;
  const ns = phase.split(':')[0];
  // coord phases on coord rows; outreach phases on outreach/social_outreach.
  const kindOk =
    (ns === 'coord' && row.kind === 'coord') ||
    (ns === 'outreach' && (row.kind === 'outreach' || row.kind === 'social_outreach'));
  if (!kindOk) {
    logger.warn('setPhase — namespace/kind mismatch, ignoring', { id, kind: row.kind, phase });
    return;
  }
  getDb().prepare(`UPDATE requests SET phase = ?, updated_at = datetime('now') WHERE id = ?`).run(phase, id);
}

/** Requests due for the time-based sweep, narrowed to a specific handler. */
export function getDueRequestsByHandler(handler: NextCheckHandler): RequestRow[] {
  return getDb().prepare(`
    SELECT * FROM requests
    WHERE next_check_handler = ?
      AND next_check_at IS NOT NULL
      AND datetime(next_check_at) <= datetime('now')
      AND state IN ('awaiting_owner','awaiting_colleague','in_flight')
  `).all(handler) as RequestRow[];
}

// ── update ──────────────────────────────────────────────────────────────────

export interface UpdateRequestPatch {
  state?: RequestState;
  /** v3.1 — kind-namespaced activity sub-state. */
  phase?: string | null;
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
}

export function updateRequest(id: string, patch: UpdateRequestPatch): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (patch.state !== undefined) {
    sets.push(`state = @state`, `state_changed_at = datetime('now')`);
    params.state = patch.state;
  }
  if (patch.phase !== undefined) { sets.push(`phase = @phase`); params.phase = patch.phase; }
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

/**
 * Merge fields into an existing details_json blob. Used for outreach
 * conversation appends, coord participant status updates, etc.
 */
export function mergeRequestDetails(id: string, patch: Record<string, unknown>): void {
  const row = getRequest(id);
  if (!row) return;
  let current: Record<string, unknown> = {};
  if (row.details_json) {
    try { current = JSON.parse(row.details_json) as Record<string, unknown>; } catch { /* keep empty */ }
  }
  const merged = { ...current, ...patch };
  getDb().prepare(
    `UPDATE requests SET details_json = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(JSON.stringify(merged), id);
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
