/**
 * Approval callbacks (v2.9.1) — the universal 3-verdict dispatch table.
 *
 * Replaces the ad-hoc `deferred_action` pattern with a structured object that
 * lives in `request.details_json.callbacks`. The resolver reads this and
 * dispatches; the same object covers every approval kind (rule_exception,
 * cancel_confirm, freeform, future non-meeting confirms).
 *
 *   on_approve  — tool that fires on yes. When omitted, Module D's Y.2 gate
 *                 skips auto-resolve so Sonnet handles the work via reasoning.
 *   on_reject   — tool that fires on no. When omitted, just close + DM the
 *                 requester (today's default).
 *   on_amend    — how owner's counter merges in. Default mode is
 *                 `relay_to_requester`: state flips to `awaiting_colleague`,
 *                 Maelle relays counter to requester for their yes/no.
 *                 Alternative `run_with_amend`: counter merges into
 *                 on_approve.args and fires immediately.
 *
 * Legacy bridge: callers still on `deferred_action` shape are transparently
 * mapped to `on_approve` via `extractCallbacks()`. We accept both for one
 * version window; new code writes `callbacks` directly.
 */

import type { UserProfile } from '../../config/userProfile';
import type { OwnerTravelContext } from '../../utils/workingElsewhere';
import { renderWeDualClock } from '../../utils/weTimeResolver';

export interface ToolCallback {
  tool: string;
  args: Record<string, unknown>;
}

export type AmendDispatch =
  | { mode: 'relay_to_requester' }
  | { mode: 'run_with_amend' };

export interface ApprovalCallbacks {
  on_approve?: ToolCallback;
  on_reject?: ToolCallback;
  on_amend?: AmendDispatch;
}

/**
 * Read structured callbacks from a request's details_json. Bridges the legacy
 * `deferred_action` field — if `callbacks.on_approve` is unset but
 * `deferred_action` exists, treat that as on_approve. Idempotent + safe on
 * malformed input.
 */
export function extractCallbacks(details: Record<string, unknown> | null | undefined): ApprovalCallbacks {
  if (!details) return {};
  const callbacks = (details.callbacks as ApprovalCallbacks | undefined) ?? {};

  // Legacy alias: deferred_action == on_approve when on_approve isn't set.
  if (!callbacks.on_approve) {
    const legacy = details.deferred_action as ToolCallback | undefined;
    if (legacy && typeof legacy.tool === 'string' && legacy.args && typeof legacy.args === 'object') {
      return { ...callbacks, on_approve: { tool: legacy.tool, args: legacy.args } };
    }
  }

  return callbacks;
}

/**
 * Verbalize on_approve for the owner-facing approval DM. The owner reads
 * "Approve X? — If yes, I'll [verbalized consequence]" and knows what saying
 * yes actually does. When on_approve is absent, returns null (Sonnet will
 * handle the work after Module D passes-to-Sonnet).
 *
 * Heuristic per tool — kept inline because the verbalization is tightly
 * coupled to each tool's args shape; extracting to a registry would be more
 * indirection than value at this scope.
 */
export function buildConsequenceText(
  callbacks: ApprovalCallbacks,
  profile: UserProfile,
  // v3.5.x (WE preview) — pre-resolved owner travel context for the meeting day,
  // supplied by the async caller (resolveConsequenceTravel). When present, the
  // ISO-start tools render via the WE dual-clock (trip + home on a trip day,
  // single home clock otherwise) so this preview matches the post-approve
  // booked-confirmation, which the meeting chat migrated to the same renderer.
  // Absent (no start / resolve failed / non-time tool) → home-zone fmtTime,
  // byte-identical to before. Verbalizer stays SYNC — no Graph here.
  travel?: OwnerTravelContext,
): string | null {
  if (!callbacks.on_approve) return null;
  const { tool, args } = callbacks.on_approve;
  const fmtTime = (iso: string | undefined): string => {
    if (!iso) return '';
    try {
      const dt = new Date(iso);
      if (Number.isNaN(dt.getTime())) return iso;
      // Best-effort local-time render; resolver doesn't have luxon imported here.
      const opts: Intl.DateTimeFormatOptions = {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: profile.user.timezone,
      };
      return new Intl.DateTimeFormat('en-GB', opts).format(dt);
    } catch { return iso; }
  };
  // WE-aware time render for the ISO-start tools: dual trip/home clock when
  // travel is resolved, else the home-zone fallback.
  const fmtStart = (iso: string | undefined, endIso?: string): string => {
    if (!iso) return '';
    return travel ? renderWeDualClock(iso, travel, profile.user.timezone, { endIso }) : fmtTime(iso);
  };
  switch (tool) {
    case 'create_meeting': {
      const subj = (args.subject as string) ?? 'this meeting';
      const start = fmtStart(args.start as string | undefined, args.end as string | undefined);
      return start ? `If yes → I'll book "${subj}" at ${start}.` : `If yes → I'll book "${subj}".`;
    }
    case 'move_meeting': {
      const subj = (args.meeting_subject as string) ?? 'the meeting';
      const newStart = fmtStart(args.new_start as string | undefined, args.new_end as string | undefined);
      return newStart ? `If yes → I'll move "${subj}" to ${newStart}.` : `If yes → I'll move "${subj}".`;
    }
    case 'delete_meeting': {
      const subj = (args.meeting_subject as string) ?? 'the meeting';
      return `If yes → I'll cancel "${subj}".`;
    }
    case 'book_floating_block': {
      const blockName = (args.is_floating_block as { name?: string } | undefined)?.name ?? 'this block';
      const start = (args.start_time as string | undefined) ?? '';
      return start ? `If yes → I'll book ${blockName} at ${start}.` : `If yes → I'll book ${blockName}.`;
    }
    case 'update_meeting': {
      const subj = (args.meeting_subject as string) ?? 'the meeting';
      return `If yes → I'll update "${subj}".`;
    }
    default:
      return `If yes → I'll run ${tool}.`;
  }
}

/**
 * v3.5.x (WE preview) — resolve the owner's travel context for the on_approve's
 * meeting day, so buildConsequenceText can render the WE dual-clock and the
 * approval preview matches the booked-confirmation. ASYNC (fetches that day's
 * events via getTravelContextForInstant); call it at the async approval call
 * sites, then pass the result into the sync verbalizer. Only the time-bearing
 * tools carry a start; everything else (and a missing/invalid start, or any
 * failure) returns undefined → the verbalizer falls back to the home clock.
 */
export async function resolveConsequenceTravel(
  callbacks: ApprovalCallbacks,
  profile: UserProfile,
): Promise<OwnerTravelContext | undefined> {
  const args = callbacks.on_approve?.args;
  const start = (args?.start ?? args?.new_start) as string | undefined;
  if (typeof start !== 'string' || !start) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getTravelContextForInstant } = require('../../utils/workingElsewhere') as
      typeof import('../../utils/workingElsewhere');
    return await getTravelContextForInstant(
      start,
      profile.user.email,
      profile.user.slack_user_id,
      profile.user.timezone,
    );
  } catch {
    return undefined;  // fail-open → home-zone render, never block the approval DM
  }
}

/**
 * Merge owner's amend counter into on_approve.args. The counter shape is
 * approval-kind-specific (freeform: arbitrary keys, etc.). We do a shallow
 * spread: counter wins on key conflict. Caller is
 * responsible for ensuring the counter keys correspond to on_approve.args
 * keys — that's a tool-description responsibility, not a code invariant.
 */
export function mergeAmendIntoApprove(
  approveCallback: ToolCallback,
  counter: Record<string, unknown>,
): ToolCallback {
  // Common slot-pick alias: counter.slot_iso → args.start. Specific to
  // create_meeting / move_meeting whose start field carries the slot.
  const args = { ...approveCallback.args };
  if (typeof counter.slot_iso === 'string') {
    if (approveCallback.tool === 'create_meeting' || approveCallback.tool === 'book_floating_block') {
      args.start = counter.slot_iso;
    } else if (approveCallback.tool === 'move_meeting') {
      args.new_start = counter.slot_iso;
    }
  }
  // Fall-through: spread the rest, allowing kind-specific keys to land.
  for (const [k, v] of Object.entries(counter)) {
    if (k === 'slot_iso') continue;  // already handled above
    args[k] = v;
  }
  return { tool: approveCallback.tool, args };
}

/**
 * Tools the resolver knows how to replay autonomously. The deferred-action
 * replay path (`runDeferredAction`) loads SchedulingSkill / CalendarHealthSkill
 * for these; anything else falls back to "close + Sonnet next turn" behavior.
 * Keep this set in sync with deferredActionReplay.ts.
 */
export const RESOLVER_REPLAY_TOOLS = new Set<string>([
  'create_meeting',
  'move_meeting',
  'delete_meeting',
  'update_meeting',
  'book_floating_block',
]);
