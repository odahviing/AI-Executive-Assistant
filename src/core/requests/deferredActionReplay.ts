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
 * MeetingsSkill (the home for create_meeting / move_meeting) or
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

export interface RunDeferredActionInput {
  ownerUserId: string;
  profile: UserProfile;
  tool: string;
  args: Record<string, unknown>;
  /** The originating approval request id — used for audit + log tagging. */
  requestId: string;
}

/**
 * Replay the deferred action. Best-effort; failures log but don't throw.
 */
export async function runDeferredAction(input: RunDeferredActionInput): Promise<void> {
  const { ownerUserId, profile, tool, args, requestId } = input;

  // Resolve the Slack connection so meeting handlers can shadow-DM the owner.
  const slackConn = getConnection(ownerUserId, 'slack');
  if (!slackConn) {
    logger.warn('runDeferredAction — no Slack connection registered, skipping replay', {
      requestId, tool,
    });
    return;
  }

  // Build a minimal SkillContext that the tool handlers will accept. The
  // owner-path identity is what we need (planMeeting checks initiator='owner'
  // for the override path). channelId/threadTs are best-effort — pulled from
  // the original args if present; the meeting handlers only use them for
  // shadow notifications, which fail gracefully.
  const channelId = (args.channel_id as string | undefined) ?? '';
  // SkillContext.threadTs is required string. Default to empty string when
  // the original call didn't carry one (synthetic replay context).
  const threadTs = (args.thread_ts as string | undefined) ?? '';
  const context = {
    userId: ownerUserId,
    senderRole: 'owner' as const,
    channelId,
    threadTs,
    channel: 'slack' as const,
    profile,
    isMpim: false,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skill = new (m as unknown as { SchedulingSkill: new () => any }).SchedulingSkill();
    } else if (tool === 'book_floating_block') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = require('../../skills/calendarHealth') as typeof import('../../skills/calendarHealth');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skill = new (m as unknown as { CalendarHealthSkill: new () => any }).CalendarHealthSkill();
    } else {
      logger.warn('runDeferredAction — unsupported tool, skipping replay', { requestId, tool });
      return;
    }
    if (!skill?.executeToolCall) {
      logger.warn('runDeferredAction — skill has no executeToolCall, skipping replay', { requestId, tool });
      return;
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
        throw new Error(`tool returned error: ${r.error}`);
      }
      if (r.success === false) {
        const reason = typeof r.reason === 'string' ? r.reason : 'unknown';
        throw new Error(`tool returned success:false (${reason})`);
      }
      if (r.ok === false) {
        const reason = typeof r.reason === 'string' ? r.reason : 'unknown';
        throw new Error(`tool returned ok:false (${reason})`);
      }
    }

    logger.info('runDeferredAction — replay completed', {
      requestId, tool,
      resultPreview: typeof result === 'object' && result !== null
        ? JSON.stringify(result).slice(0, 240)
        : String(result).slice(0, 240),
    });
  } catch (err) {
    // Surface to caller — the resolver's outer try/catch keeps the request
    // in awaiting_owner so the owner can retry. Log here for visibility.
    logger.error('runDeferredAction — replay failed', {
      requestId, tool, err: String(err).slice(0, 300),
    });
    throw err;
  }
}
