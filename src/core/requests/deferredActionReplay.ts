/**
 * Deferred action replay.
 *
 * The "redirect URL token" pattern for approvals: when an approval is raised
 * because a tool call hit a rule, the caller stamps the original tool +
 * args on the request's details_json.deferred_action. When the owner
 * approves, the resolver re-invokes that tool with the override flag set
 * (relaxed=true for create/move_meeting, confirm_outside_window=true for
 * book_floating_block) so the action actually executes.
 *
 * This module is the replay engine. It re-creates the SkillContext that the
 * original tool handler expects, then calls executeToolCall on the registered
 * SchedulingSkill (the direct-ops home for create_meeting / move_meeting) or
 * CalendarHealthSkill (book_floating_block).
 *
 * Errors PROPAGATE — they don't silently log+swallow. The resolver wraps each
 * call in try/catch and keeps the request in `awaiting_owner` on failure so
 * the requester is never told "approved" for an action that never happened
 * (the phantom-confirmation class of bug). The replay also inspects the tool
 * result for `{ error: string }` / `{ success: false }` / `{ ok: false }`
 * shapes and throws on those — meeting tools return error sentinels rather
 * than throwing for rule violations, busy collisions, etc.
 */

import type { UserProfile } from '../../config/userProfile';
import { getConnection } from '../../connections/registry';
import logger from '../../utils/logger';

/**
 * Thrown when the replayed tool returned a structured `{ error }` / `{ success:
 * false }` / `{ ok: false }` sentinel — carries the FULL result (never just the
 * flattened message string) so a caller with an actual recovery path for a
 * SPECIFIC sentinel (e.g. resolver.ts's `possible_reschedule` handling) can read
 * the fields it needs (existing_meeting_id, etc.) instead of losing them the
 * instant this module turns the sentinel into a bare Error.
 */
export class ReplayToolError extends Error {
  constructor(message: string, public readonly sentinel: Record<string, unknown>) {
    super(message);
    this.name = 'ReplayToolError';
  }
}

export interface RunDeferredActionInput {
  ownerUserId: string;
  profile: UserProfile;
  tool: string;
  args: Record<string, unknown>;
  /** The originating approval request id — used for audit + log tagging. */
  requestId: string;
  /**
   * The request's ORIGIN thread (requests.origin_channel / origin_thread_ts) —
   * where the ask was raised and where the requester relay posts the outcome.
   * Callers must pass the request row's own fields. NEVER read this off
   * `args` — create_meeting / move_meeting / update_meeting / delete_meeting /
   * book_floating_block carry no channel_id/thread_ts in their input_schema
   * (verified 2026-08-03), so a `args.channel_id`/`args.thread_ts` fallback is
   * not "best-effort", it is unconditionally empty. Used only for shadow
   * notifications during replay (S4) — never for the booking's own
   * parameters, which come from `args` alone (R2).
   */
  originChannel: string | null;
  originThreadTs: string | null;
  /**
   * v4.4.x (#154-replay-surface) — the request row's own origin surface,
   * from `deriveOriginSurface(row)` (core/requests/types.ts) — NEVER guessed,
   * NEVER defaulted to 'owner_dm'. The replay always executes with
   * `authority: 'owner'` (the approved action runs with owner privilege
   * regardless of who raised the original ask — grantRelaxed's
   * `senderRole === 'owner'` fast path is untouched by this), but a room- or
   * colleague-DM-originated ask still narrates back into that same surface
   * (S4): she always speaks, the restriction is at the tool layer, never
   * silence (owner ruling). Also feeds `isMpim` on the synthetic SkillContext
   * below, so `subjectViewerFor`/`viewerEmailFor` (utils/displaySubject.ts —
   * which key off `isMpim`, not this field directly) stop reading EVERY
   * replay as a fully private owner DM regardless of where the ask actually
   * came from. That isMpim-always-false mismatch was the #137b-shaped bypass
   * for this leg: a room-originated approval could replay a rule-bend and
   * have the tool handlers render its real subject as if to the owner alone.
   */
  surface: 'owner_dm' | 'colleague_dm' | 'room';
}

/**
 * Replay the deferred action. THROWS on failure (the tool threw, OR returned an
 * `{ error }` / `{ success: false }` / `{ ok: false }` sentinel) so the resolver
 * keeps the request in `awaiting_owner` for retry — see the file header. Do NOT
 * wrap the throw in a swallow: that resurrects the phantom-confirmed-booking bug
 * (owner approves → replay fails silently → requester told "invite incoming" →
 * nothing booked).
 *
 * Returns the tool result on success (GH #140 / 138c) so the resolver can
 * surface the concrete outcome — `booked_start`, `action_summary`, etc. —
 * instead of a bare "replayed create_meeting". Without it the resolver returned
 * no booking signal, so Sonnet hedged ("confirming that's what you mean?") AND
 * announced completion ("booking went through") in the same breath. Returns
 * undefined on the no-op paths (no connection / unsupported tool).
 */
export async function runDeferredAction(input: RunDeferredActionInput): Promise<Record<string, unknown> | undefined> {
  const { ownerUserId, profile, tool, args, requestId, originChannel, originThreadTs, surface } = input;

  // Resolve the Slack connection so meeting handlers can shadow-DM the owner.
  const slackConn = getConnection(ownerUserId, 'slack');
  if (!slackConn) {
    logger.warn('runDeferredAction — no Slack connection registered, skipping replay', {
      requestId, tool,
    });
    return undefined;
  }

  // Build a minimal SkillContext that the tool handlers will accept. The
  // owner-path identity is what we need (planMeeting checks initiator='owner'
  // for the override path). channelId/threadTs are the request's OWN origin
  // thread (S4, 2026-08-03 ruling) — an approved action replays into the same
  // thread the ask was raised in, not a blind void. The meeting handlers use
  // them for shadow notifications + closeMeetingArtifacts' thread-fallback
  // match; SkillContext.threadTs is a required string, so an owner-internal
  // row with no origin thread still defaults to ''.
  const channelId = originChannel ?? '';
  const threadTs = originThreadTs ?? '';
  const context = {
    userId: ownerUserId,
    senderRole: 'owner' as const,
    // v4.4.x (#154-replay-surface) — the ACTION always runs as the
    // authenticated owner (unchanged); `surface` is the SEPARATE, row-derived
    // question of where this narrates back to, and is never inferred from
    // authority.
    authority: 'owner' as const,
    surface,
    channelId,
    threadTs,
    channel: 'slack' as const,
    profile,
    // isMpim mirrors `surface` (both cover the 'room' case — MPIM or a real
    // channel, per the owner's "channel = MPIM" ruling) so
    // subjectViewerFor/viewerEmailFor keep clamping a room-originated replay
    // exactly as they would a live room turn, instead of the hardcoded
    // `false` that made every replay read as a private owner DM.
    isMpim: surface === 'room',
    isOwnerInGroup: false,
  };

  let skill: { executeToolCall?: (name: string, args: Record<string, unknown>, ctx: typeof context) => Promise<unknown> } | undefined;
  try {
    if (tool === 'create_meeting' || tool === 'move_meeting' || tool === 'delete_meeting' || tool === 'update_meeting') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = require('../../skills/meetings/ops') as typeof import('../../skills/meetings/ops');
      // SchedulingSkill is the direct-ops home for create_meeting / move_meeting /
      // delete_meeting / update_meeting. v2.9.1 added update_meeting as a
      // replayable on_approve target (attendee changes via approval flow).
      skill = new (m as unknown as { SchedulingSkill: new () => unknown }).SchedulingSkill() as typeof skill;
    } else if (tool === 'book_floating_block') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = require('../../skills/calendarHealth') as typeof import('../../skills/calendarHealth');
      skill = new (m as unknown as { CalendarHealthSkill: new () => unknown }).CalendarHealthSkill() as typeof skill;
    } else {
      logger.warn('runDeferredAction — unsupported tool, skipping replay', { requestId, tool });
      return undefined;
    }
    if (!skill?.executeToolCall) {
      logger.warn('runDeferredAction — skill has no executeToolCall, skipping replay', { requestId, tool });
      return undefined;
    }
    const result = await skill.executeToolCall(tool, args, context);

    // Inspect the result for failure-sentinel shapes. Many meeting tools
    // return { error: string } / { success: false } / { ok: false } on
    // rule violations or transient failures rather than throwing. Pre-fix,
    // such failures were treated as success — the resolver closed the
    // request resolved and DM'd the requester "Calendar invite incoming"
    // for a meeting that never landed.
    const r = result as Record<string, unknown> | null | undefined;
    if (r && typeof r === 'object') {
      if (typeof r.error === 'string' && r.error.length > 0) {
        throw new ReplayToolError(`tool returned error: ${r.error}`, r);
      }
      if (r.success === false) {
        const reason = typeof r.reason === 'string' ? r.reason : 'unknown';
        throw new ReplayToolError(`tool returned success:false (${reason})`, r);
      }
      if (r.ok === false) {
        const reason = typeof r.reason === 'string' ? r.reason : 'unknown';
        throw new ReplayToolError(`tool returned ok:false (${reason})`, r);
      }
    }

    logger.info('runDeferredAction — replay completed', {
      requestId, tool,
      resultPreview: typeof result === 'object' && result !== null
        ? JSON.stringify(result).slice(0, 240)
        : String(result).slice(0, 240),
    });
    return (r && typeof r === 'object') ? r : undefined;
  } catch (err) {
    // Surface to caller — the resolver's outer try/catch keeps the request
    // in awaiting_owner so the owner can retry. Log here for visibility.
    logger.error('runDeferredAction — replay failed', {
      requestId, tool, err: String(err).slice(0, 300),
    });
    throw err;
  }
}
