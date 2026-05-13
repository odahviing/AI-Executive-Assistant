/**
 * Deferred action replay (v2.7.2).
 *
 * The "redirect URL token" pattern for approvals: when an approval is raised
 * because a tool call hit a rule, the caller stamps the original tool +
 * args on the request's details_json.deferred_action. When the owner
 * approves, the resolver re-invokes that tool with the override flag set
 * (relaxed=true for create/move_meeting, confirm_outside_window=true for
 * book_floating_block) so the action actually executes — no more "approved
 * but never moved" gaps (root of the Ysrael BiWeekly 2026-05-12 failure).
 *
 * This module is the replay engine. It re-creates the SkillContext that
 * the original tool handler expects, then calls executeToolCall on the
 * registered MeetingsSkill (the home for create_meeting / move_meeting)
 * or CalendarHealthSkill (book_floating_block). Errors are non-fatal —
 * they log and bail; the resolver already closed the request as resolved,
 * and Sonnet can retry next owner turn if needed.
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
  const threadTs = (args.thread_ts as string | undefined) ?? undefined;
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
    if (tool === 'create_meeting' || tool === 'move_meeting') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = require('../../skills/meetings/ops') as typeof import('../../skills/meetings/ops');
      // SchedulingSkill is the direct-ops home for create_meeting / move_meeting / etc.
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
    logger.info('runDeferredAction — replay completed', {
      requestId, tool,
      resultPreview: typeof result === 'object' && result !== null
        ? JSON.stringify(result).slice(0, 240)
        : String(result).slice(0, 240),
    });
  } catch (err) {
    logger.warn('runDeferredAction — replay threw', {
      requestId, tool, err: String(err).slice(0, 300),
    });
  }
}
