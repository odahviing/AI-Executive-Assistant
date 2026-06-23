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

export type OutreachSubkind =
  | 'general'
  | 'meeting_reschedule'
  | 'invite'
  | 'note';

export type RequestState =
  | 'awaiting_owner'      // owner action blocks progress (most approvals start here)
  | 'awaiting_colleague'  // colleague reply blocks progress (most outreach lives here)
  | 'in_flight'           // Maelle is working (research running, scheduled outreach not yet sent)
  | 'resolved'            // terminal — closed normally
  | 'cancelled'           // terminal — owner dropped OR auto-cancelled by surfaced_threshold
  | 'expired';            // terminal — no action within window

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
 * literals. Never mix a phase onto the wrong request kind — setPhase
 * validates the namespace matches the kind.
 */
export type OutreachPhase =
  | 'outreach:scheduled'      // future send_at, not yet sent (state=in_flight)
  | 'outreach:awaiting_reply' // sent, waiting (state=awaiting_colleague)
  | 'outreach:nudged'         // follow-up sent once
  | 'outreach:no_response';   // window elapsed, pending owner decision

export type RequestPhase = OutreachPhase;

export type NextCheckHandler =
  | 'expiry'                 // generic expiry → close with state=expired
  | 'approval_reminder'      // midpoint nag DM, then re-arm for expiry
  | 'outreach_expiry'        // outreach awaiting_colleague past window → flip to outreach_decision
  | 'outreach_decision'      // 2 workdays after no-response → auto-close with "want me to try again?"
  | 'send_scheduled_outreach' // fire a future-dated outreach DM
  | 'reminder_fire'          // fire a reminder DM at due_at
  | 'research_run';          // run a research prompt through the agent loop, DM the result

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
  state: 'resolved' | 'cancelled' | 'expired';
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

/** Helper: outcome_json parse. */
export function parseOutcome<T = Record<string, unknown>>(row: RequestRow): T | null {
  if (!row.outcome_json) return null;
  try { return JSON.parse(row.outcome_json) as T; } catch { return null; }
}
