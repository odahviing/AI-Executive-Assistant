/**
 * The Request spine (v2.7.0).
 *
 * Every user-facing piece of work Maelle tracks is a `request` row. Approvals,
 * outreach, reminders, research — one
 * table, one lifecycle, one closure API. Replaces the v2.6.x multi-table mess
 * (tasks + approvals + outreach_jobs) that orphaned items every
 * brief because no single layer owned the lifecycle.
 *
 * Hierarchy: a request can spawn child requests via `parent_request_id`.
 * Brief surfaces only top-level rows.
 *
 * Time-based reactions live ON the request row (`next_check_at` +
 * `next_check_handler`) — no separate dispatch table for one-shot expiries.
 * The runner sweeps requests where next_check_at <= now and dispatches.
 */

import { DateTime } from 'luxon';

export type RequestKind =
  | 'approval'         // colleague→owner decision request (replaces approvals table)
  | 'outreach'         // send DM to colleague, optionally await reply
  | 'reminder'         // owner-self: "remind me Friday"
  | 'follow_up'        // owner-self: "check back on X in 3 days"
  | 'research'         // owner-self: "look this up and tell me"
  | 'social_outreach'; // proactive social DM to a colleague

export type ApprovalSubkind =
  | 'duration_override'
  | 'policy_exception'
  | 'unknown_person'
  | 'freeform';

export type RequestState =
  | 'awaiting_owner'      // owner action blocks progress (most approvals start here)
  | 'awaiting_colleague'  // colleague reply blocks progress (most outreach lives here)
  | 'in_flight'           // Maelle is working (research running, scheduled outreach not yet sent)
  | 'resolved'            // terminal — closed normally
  | 'cancelled'           // terminal — owner dropped OR auto-cancelled by surfaced_threshold
  | 'expired'             // terminal — no action within window
  | 'logged';             // terminal — a completed Maelle-initiated action, recorded for
                          // history/undo (gh#52); pulled, never pushed — never surfaces in
                          // the brief (see getRequestsForBrief) and never pruned — the
                          // requests-spine prune job was removed outright (52-U9,
                          // core/background.ts), so nothing here is ever deleted for age

export type RequestRole = 'owner' | 'colleague' | 'system';

export type ClosedBy =
  | 'owner'              // owner explicitly approved / rejected / cancelled
  | 'scanner'            // closeLoopOnOwnerHandled matched owner free-text
  | 'expiry'             // next_check_at fired with handler='expiry'
  | 'meeting_cascade'    // a calendar mutation made this request obsolete
  | 'colleague_reply'    // colleague replied to an awaiting_colleague outreach
  | 'system'             // internal closure (auto-fix, idempotent short-circuit)
  | 'brief';             // surfaced_threshold hit during brief generation

/**
 * v3.1 (Path 2) — kind-namespaced activity sub-state values. The string union
 * documents the legal phases; `phase` is stored as TEXT so callers pass these
 * literals. Never mix a phase onto the wrong request kind — both write paths
 * in src/db/requests.ts (createRequest's INSERT and updateRequest's `phase`
 * branch) call the shared `isPhaseValidForKind` guard before writing, and
 * drop the write (with a warning) otherwise.
 */
export type OutreachPhase =
  | 'outreach:scheduled'      // future send_at, not yet sent (state=in_flight)
  | 'outreach:awaiting_reply' // sent, waiting (state=awaiting_colleague)
  | 'outreach:nudged'         // follow-up sent once
  | 'outreach:re_engaged'     // colleague replied non-decisively ("let me check") and the
                              // deadline was re-armed off that reply — state stays
                              // awaiting_colleague throughout, so this is the only record
                              // that a reply ever happened (outreach-expiry-tombstone-says-
                              // never-replied, 2026-08-12; see runner.ts's
                              // runOutreachExpiryOrDecision)
  | 'outreach:no_response';   // window elapsed, pending owner decision

export type RequestPhase = OutreachPhase;

export type NextCheckHandler =
  | 'expiry'                 // generic expiry → close with state=expired
  | 'approval_reminder'      // midpoint nag DM, then re-arm for expiry
  | 'outreach_expiry'        // outreach awaiting_colleague past window → close as expired
  | 'send_scheduled_outreach' // fire a future-dated outreach DM
  | 'reminder_fire'          // fire a reminder DM at due_at
  | 'research_run'           // run a research prompt through the agent loop, DM the result
  | 'reschedule_reask'       // colleague said "checking" → re-ping them ONCE at +24h, then re-arm to outreach_expiry
  // gh#201-d — a colleague's meeting search dead-ended on the owner's away
  // period (owner_out_of_office). Fires when the tracked away period should
  // have ended: re-verifies the owner is actually back (or bumps the check to
  // the newly-discovered end date if the period was extended), then sends the
  // colleague a reengagement DM. See core/requests/colleagueOofReengage.ts.
  | 'colleague_oof_recheck'
  // gh#201-d — the reengagement DM's colleague said "checking" → re-ping them
  // ONCE at +24h, then re-arm to outreach_expiry (mirrors reschedule_reask).
  | 'oof_reengage_reask'
  // chris-kelley-oof-block-b round 2 (2026-08-18) — flagUnresolvedFreeformForOwner's
  // immediate postOwnerDecision attempt failed (thread post AND the DM
  // fallback both failed). Bounded, short linear-backoff retry — never
  // workTimeBaseFromNow/nextOwnerWorkdayStart, the deferred-past-vacation
  // timer this backstop exists to avoid. See runner.ts's runFreeformFlagRetry.
  | 'freeform_flag_retry';

export interface RequestRow {
  // Identity
  id: string;
  created_at: string;
  updated_at: string;

  // Ownership + initiation
  owner_user_id: string;
  initiated_by: string;
  initiated_by_role: RequestRole;

  // Hierarchy
  parent_request_id: string | null;

  // Kind
  kind: RequestKind;
  subkind: string | null;
  subject: string;
  description: string | null;

  // State
  state: RequestState;
  // v3.1 (Path 2) — kind-namespaced activity sub-state. `state` is the
  // universal lifecycle; `phase` is the finer dance for multi-step kinds.
  // e.g. outreach:scheduled | outreach:awaiting_reply |
  // outreach:nudged | outreach:no_response. NULL for single-step kinds.
  phase: string | null;
  state_changed_at: string;
  closure_reason: string | null;
  closed_at: string | null;
  closed_by: ClosedBy | null;

  // Surfacing
  informed: number;        // 0 | 1
  surfaced_count: number;
  last_surfaced_at: string | null;

  // Time-based reaction
  expires_at: string | null;
  next_check_at: string | null;
  next_check_handler: NextCheckHandler | null;

  // Targets
  requester_slack_id: string | null;
  requester_name: string | null;
  target_slack_id: string | null;
  target_email: string | null;
  target_name: string | null;

  // Slack context
  origin_channel: string | null;
  origin_thread_ts: string | null;
  origin_is_mpim: number;  // 0 | 1

  // Owner-DM tracking
  owner_dm_channel: string | null;
  owner_dm_thread_ts: string | null;
  terminal_dm_msg_ts: string | null;

  // v3.1 (Path 2) — set once when the colleague-requester is told the outcome.
  // Idempotency across the two notify paths (resolver + meeting cascade).
  requester_notified_at: string | null;

  // Dedup
  idempotency_key: string | null;

  // Outcome
  outcome_external_event_id: string | null;
  outcome_json: string | null;

  // Kind-specific payload (JSON-encoded)
  details_json: string | null;
}

export interface CreateRequestInput {
  ownerUserId: string;
  initiatedBy: string;
  initiatedByRole: RequestRole;
  parentRequestId?: string;

  kind: RequestKind;
  subkind?: string;
  subject: string;
  description?: string;

  state: RequestState;
  /** v3.1 — kind-namespaced activity sub-state (see RequestRow.phase). */
  phase?: string;

  /** Defaults: owner-initiated → 1, colleague/system-initiated → 0 */
  informed?: number;

  expiresAt?: string;
  nextCheckAt?: string;
  nextCheckHandler?: NextCheckHandler;

  requesterSlackId?: string;
  requesterName?: string;
  targetSlackId?: string;
  targetEmail?: string;
  targetName?: string;

  originChannel?: string;
  originThreadTs?: string;
  originIsMpim?: boolean;

  ownerDmChannel?: string;
  ownerDmThreadTs?: string;
  /** Set ONLY when this request's first DM IS the terminal-question. Reminder/status DMs do NOT stamp this. */
  terminalDmMsgTs?: string;

  /** If omitted, computed from (owner, requester, kind, subject_normalized). */
  idempotencyKey?: string;

  outcomeExternalEventId?: string;
  outcomeJson?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export interface CloseRequestInput {
  id: string;
  state: 'resolved' | 'cancelled' | 'expired' | 'logged';
  closureReason: string;
  closedBy: ClosedBy;
  outcomeExternalEventId?: string;
  outcomeJson?: Record<string, unknown>;
  /** When true, the closure does NOT cascade to children (caller will close them separately). Default false. */
  skipChildren?: boolean;
}

/** Helper: parse details_json with a known shape. */
export function parseDetails<T = Record<string, unknown>>(row: RequestRow): T | null {
  if (!row.details_json) return null;
  try { return JSON.parse(row.details_json) as T; } catch { return null; }
}

/**
 * v4.4.x (#154-replay-surface) — derive the turn `surface` for a SYNTHETIC
 * re-entry into the skill/orchestrator layer (deferred-action replay, a
 * scheduled research run) FROM THE REQUEST ROW's own origin fields — never
 * guessed, never defaulted to 'owner_dm'. Mirrors the live-turn formula at
 * connectors/slack/app/processMessage.ts (`(isMpim || isChannel) ? 'room' :
 * (rawRole === 'owner' ? 'owner_dm' : 'colleague_dm')`):
 *   - `origin_is_mpim` already collapses MPIM + a real channel into one "room"
 *     bit (#154-origin-room; see tasks/skill.ts's `originIsMpim: context.
 *     surface === 'room'` stamp) — true here means the ask was raised in a room.
 *   - `initiated_by_role` stands in for the live turn's authenticated
 *     `authority`/`rawRole` ONLY in the non-room case: a genuine 1:1 DM never
 *     clamps `senderRole` (processMessage.ts: "a genuine 1:1 DM, never
 *     clamped"), and `initiated_by_role` is stamped straight off `senderRole`
 *     at creation (tasks/skill.ts's create_task / create_approval), so the two
 *     agree exactly in the one case where there is no room to clamp them apart.
 *
 * A falsy `origin_is_mpim` with `initiated_by_role !== 'colleague'` reads as
 * 'owner_dm' — correct for the owner's own un-clamped DM, for EITHER an
 * approval or a research/reminder row. (Corrected 2026-08 / o#219:
 * research/reminder rows are NOT "owner-only by construction" — create_task
 * is COLLEAGUE-reachable via registry.ts's COLLEAGUE_ALLOWED_TOOLS, exactly
 * like create_approval, so `initiated_by_role` is genuinely stamped either
 * way on both kinds now.) A colleague-raised row's `initiated_by_role` is
 * 'colleague' by that same construction, so it reads 'colleague_dm' instead.
 * For an approval, the replay still executes with owner authority regardless
 * (grantRelaxed's senderRole==='owner' fast path — resolving an approval is
 * always the owner's act), so only the narrated SURFACE varies here. For
 * research, the EXECUTING authority itself must track the true raiser, and
 * `initiated_by_role` alone can't do that (it's surface-clamped to
 * 'colleague' for anyone — owner included — raised from inside a room) — see
 * runner.ts's runResearchRun, which re-derives authority from `initiated_by`
 * against the owner's own id instead. This function only ever supplies the
 * narration surface, never the tool-access floor.
 */
export function deriveOriginSurface(
  row: Pick<RequestRow, 'origin_is_mpim' | 'initiated_by_role'>,
): 'owner_dm' | 'colleague_dm' | 'room' {
  if (row.origin_is_mpim) return 'room';
  return row.initiated_by_role === 'colleague' ? 'colleague_dm' : 'owner_dm';
}

/**
 * Anchor an EXTERNALLY-SUPPLIED timer time and return it as a UTC instant.
 *
 * `next_check_at` / `expires_at` are UTC instants — `getDueRequests()` selects on
 * `datetime(next_check_at) <= datetime('now')`, and SQLite's `now` is UTC. Every
 * INTERNAL arming site satisfies that by construction (`DateTime.now().plus(…)
 * .toUTC().toISO()`), so the invariant was never written down and never enforced.
 * A MODEL-authored time does not satisfy it: `create_task.due_at` and
 * `message_colleague.send_at` arrive as a bare wall-clock — "2026-07-27T10:32:00"
 * — and stored verbatim the row only became due when UTC reached that clock, i.e.
 * exactly one owner-offset late (#149: a 10:32 reminder delivered at 13:35, UTC+3).
 *
 * A bare clock means the OWNER's local time: that is the frame he and the model
 * spoke in. An explicit offset / `Z` already denotes an instant and is preserved.
 * Unparseable → null, so the caller REFUSES instead of arming a timer that can
 * never fire (SQLite `datetime()` of a bad string is NULL → the row is invisible
 * to the sweep forever, which is the silent-hang R3 forbids).
 */
export function toTimerInstant(raw: string, ownerTimezone: string): string | null {
  const dt = DateTime.fromISO(raw, { zone: ownerTimezone });
  return dt.isValid ? dt.toUTC().toISO() : null;
}

