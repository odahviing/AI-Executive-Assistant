/**
 * Meetings-skill direct-ops helper (internal; not a loadable skill).
 *
 * This file holds the direct calendar operations (`get_calendar`, `create_meeting`,
 * `move_meeting`, `delete_meeting`, `update_meeting`, `get_free_busy`,
 * `find_available_slots`, `analyze_calendar`) and the pure helpers
 * `processCalendarEvents` and `analyzeCalendar` used by the task runner's
 * `calendar_fix` dispatcher.
 *
 * It exposes a class (`SchedulingSkill`) that conforms to the Skill interface
 * ONLY because `MeetingsSkill` instantiates it and delegates `executeToolCall`
 * for direct-ops tool names. Its `getTools` and `getSystemPromptSection` are
 * never consulted — `MeetingsSkill` owns both — so keeping them would be dead
 * code. They are intentionally absent.
 *
 * NOT registered in `skills/registry.ts`. The leading underscore in the
 * filename signals "internal helper, not a togglable skill."
 */
import type { SkillContext } from '../types';

// v3.7.x (pass B) — the direct-ops case bodies now live in ./ops/handlers/*;
// executeToolCall is a thin dispatcher. The only value this file still owns is
// the analysis re-export below (a public export other modules consume). All
// other former top-level imports moved with the case bodies to the handlers.
export { processCalendarEvents, analyzeCalendar } from './ops/analysis';
import { handleFindAvailableSlots } from './ops/handlers/findAvailableSlots';
import { handleCreateMeeting } from './ops/handlers/createMeeting';
import { handleUpdateMeeting, handleMoveMeeting } from './ops/handlers/moveMeeting';
import {
  handleHoldSlot,
  handleGetCalendar,
  handleRevertLastAutoMove,
  handleSetWorkScheduleOverride,
  handleGetWorkScheduleOverrides,
  handleAnalyzeCalendar,
  handleGetFreeBusy,
  handleDeleteMeeting,
} from './ops/handlers/calendarReads';
import type { OpCtx } from './ops/handlers/context';

/**
 * Internal ops helper. Not a registered skill (see file header). MeetingsSkill
 * delegates direct-ops tool execution to an instance of this class. Only
 * `executeToolCall` is ever called from outside.
 */
export class SchedulingSkill {
  // Kept only for call sites inside executeToolCall that reference `this.id` etc.
  readonly id = 'meetings' as const;

  // v2.0.7 — no getTools / getSystemPromptSection here (the former methods,
  // dead since v1.7, were deleted). MeetingsSkill owns both schemas and
  // prompts. Only executeToolCall is invoked externally, via
  // `this.ops.executeToolCall(...)` from meetings.ts.

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { email: userEmail, timezone } = context.profile.user;
    const opCtx: OpCtx = { context, userEmail, timezone };

    switch (toolName) {
      case 'hold_slot':
        return handleHoldSlot(args, opCtx);
      case 'get_calendar':
        return handleGetCalendar(args, opCtx);

      case 'revert_last_auto_move':
        return handleRevertLastAutoMove(args, opCtx);
      case 'set_work_schedule_override':
        return handleSetWorkScheduleOverride(args, opCtx);
      case 'get_work_schedule_overrides':
        return handleGetWorkScheduleOverrides(args, opCtx);
      case 'analyze_calendar':
        return handleAnalyzeCalendar(args, opCtx);

      case 'get_free_busy':
        return handleGetFreeBusy(args, opCtx);

      case 'find_available_slots':
        return handleFindAvailableSlots(args, opCtx);

      case 'create_meeting':
        return handleCreateMeeting(args, opCtx);

      case 'update_meeting':
        return handleUpdateMeeting(args, opCtx);

      case 'move_meeting':
        return handleMoveMeeting(args, opCtx);

      case 'delete_meeting':
        return handleDeleteMeeting(args, opCtx);

      // v2.0.7 — legacy escalate_to_user / store_request / get_pending_requests /
      // resolve_request cases retired. See tool-declaration comment above.

      default:
        return null; // not our tool
    }
  }

}
