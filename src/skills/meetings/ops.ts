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
import { clampedRelaxedNotice } from './bookingRequest';

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
    const result = await this.dispatch(toolName, args, context);

    // The owner's relaxed override, dropped by the group-DM clamp, used to be
    // visible only in a log line — so he was answered un-relaxed and told
    // nothing (2026-07-27; see clampedRelaxedNotice). Attached HERE, the one
    // point every direct op returns through, so the disclosure rides EVERY
    // branch of every relaxed-aware tool — booked, refused, rule_violation,
    // needs_owner_approval — instead of three handlers each having to remember
    // it at each of their own return sites. Mutated rather than spread so the
    // result keeps its identity for downstream consumers; the array exclusion
    // matters because JSON.stringify would drop a non-index key.
    const notice = clampedRelaxedNotice(toolName, args, context);
    if (notice && typeof result === 'object' && result !== null && !Array.isArray(result)) {
      (result as Record<string, unknown>).owner_override_not_applied = notice;
    }

    // email-aside-leak-no-channel-scope — `override_notice` (createMeeting.ts,
    // sourced from planMeeting.ts's overrideNotice) is a second-person aside
    // written FOR THE OWNER ("this books over your optional standup") and can
    // embed another private meeting's SUBJECT or an attendee's busy status.
    // Every email turn's reply IS the client-forwardable text (systemPrompt.ts's
    // emailReplySection, gh#175a removed the owner-only FOR-YOU/cut-line split
    // entirely) — there is no owner-facing side channel on that leg for such a
    // note to land in instead, so if left on the payload it has nowhere to go
    // but into the text the owner forwards verbatim to the external. Strip
    // here, the one point every direct op returns through (same chokepoint as
    // the notice attached just above), rather than gate each handler's attach
    // site individually. Rule 10: when the audience is unclear, return less.
    // (`_attendee_busy_note`, moveMeeting.ts's twin of this note, is NOT
    // stripped here — move_meeting is absent from CHANNEL_TOOL_CLAMP.email
    // (registry.ts), so it structurally can never reach an email-leg result;
    // deleting a key that can never be present was dead code.)
    if (context.channel === 'email' && typeof result === 'object' && result !== null && !Array.isArray(result)) {
      delete (result as Record<string, unknown>).override_notice;

      // Same class of leak, find_available_slots' side: the owner-trade-off note
      // family (_over_optional_note / _attendee_conflicts_note /
      // _no_all_attendee_free_note / _recovery_note,
      // findAvailableSlots.ts:1696-1744) is second-person prose for the owner
      // PLUS the raw per-slot data it narrates — a non-private meeting's
      // subject (`over_optional`) and a colleague's email + busy reason
      // (`attendee_conflicts`). Stripping only the notes would still leave that
      // data sitting in the model's context on a leg whose entire reply is
      // forwarded verbatim to an external party, so both the notes AND the
      // fields they describe are removed here — the same chokepoint, extended.
      // (`_attendee_busy_colleague_note`, findAvailableSlots.ts:1708, is NOT
      // stripped here — it's gated on `mustBe`, which requires
      // `!isOwnerInitiatedSearch`; the email leg is always
      // `senderRole:'owner'` so `isOwnerInitiatedSearch` is always true and the
      // key can never be present on this leg — deleting it was dead code.)
      const r = result as Record<string, unknown>;
      delete r._over_optional_note;
      delete r._attendee_conflicts_note;
      delete r._no_all_attendee_free_note;
      delete r._recovery_note;
      // `attendee_status` (findAvailableSlots.ts's colleague-path / flexible-
      // requester annotation, ~line 1496) is the same shape of fact — an
      // internal colleague's email + free/busy status per slot — and reaches
      // an owner-initiated email turn whenever ignore_attendee_availability or
      // a granted relaxed override is set, same as the fields above.
      if (Array.isArray(r.slots)) {
        for (const s of r.slots as Array<Record<string, unknown>>) {
          delete s.over_optional;
          delete s.attendee_conflicts;
          delete s.attendee_status;
        }
      }
      // email-siblings-not-stripped-results-branch — the SAME leak, the
      // candidate_validation branch's shape (findAvailableSlots.ts:835-885, taken
      // when the caller checks specific proposed times rather than searching):
      // no top-level `slots`, so the walk above never reaches it. Each
      // `results[]` item's `broken_rule` is the RAW per-attendee reason string
      // (`outside_attendee_work_hours:<email>` / `attendee_busy_collision:<email>`,
      // findAvailableSlots.ts:824-825) and `attendee_hours_note` spells out that
      // same colleague's stated working hours verbatim (findAvailableSlots.ts:826-834,
      // 140-142) — both left in place for the owner's own view; `broken_rule_label`
      // is the clean, human, name-free equivalent and stays. `travelers`
      // (findAvailableSlots.ts:1513-1519, top-level — not nested in `slots`, so the
      // per-slot walk above never reached it either) is a colleague's email + travel
      // location, same shape of fact as `attendee_status`.
      if (Array.isArray(r.results)) {
        for (const item of r.results as Array<Record<string, unknown>>) {
          delete item.broken_rule;
          delete item.attendee_hours_note;
        }
      }
      delete r.travelers;
      // Same family, main-branch sibling (findAvailableSlots.ts:1745-1747): a
      // second-person aside attached when no slot survived attendee filtering
      // ("these are his OWN open times — I could not confirm the other
      // attendee(s) yet"). NOT stripped here — it's gated on
      // `usedColleagueOwnerOnly`, itself only ever set from
      // `colleagueOwnerOnlySlots` (findAvailableSlots.ts:1086), which requires
      // `!isOwnerInitiatedSearch` — always false on the email leg
      // (senderRole:'owner' → isOwnerInitiatedSearch true) — so the key can
      // never be present here; deleting it was dead code.

      // email-siblings-not-stripped-results-branch — attendeeCheckWarnings'
      // output (unresolved_attendee_emails / _attendee_email_warning /
      // attendees_not_checked / _attendee_not_checked_warning) is the same
      // class of leak: an internal colleague's raw email address, or a notice
      // naming them. It rides BOTH attendeeCheckWarnings call sites
      // (findAvailableSlots.ts:868 the candidate_validation branch, :950 the
      // main slots pass) — both spread it at the TOP LEVEL of the result, so
      // one delete here closes both branches at once.
      //
      // email-colleague-freebusy-failure-has-no-signal — `attendees_not_checked`
      // /`_attendee_not_checked_warning` carry TWO facts bundled together: WHO
      // failed to check (identity — must be stripped, same as every field
      // above) and WHETHER a free/busy read failed at all (an honesty signal
      // about the slots themselves, owed to whoever the reply goes to). Capture
      // the second fact before the identity-carrying keys are deleted, and
      // reattach it name-free — this is the ONLY leg whose reply is forwarded
      // to an external client verbatim, so silence here reads as "confirmed
      // free for everyone" when a colleague's calendar was never read.
      const freeBusyReadFailed = Array.isArray(r.attendees_not_checked) && r.attendees_not_checked.length > 0;
      delete r.unresolved_attendee_emails;
      delete r._attendee_email_warning;
      delete r.attendees_not_checked;
      delete r._attendee_not_checked_warning;
      if (freeBusyReadFailed) {
        r._unverified_availability_notice =
          "One or more attendees' calendars could not be read for this window, so these times are not confirmed free for everyone — say so plainly rather than presenting them as fully checked.";
      }

      // email-leg-payload-strips-attendee-identifying-fields — day_summary
      // (attached whole at findAvailableSlots.ts:1692) carries the same two
      // facts per DAY that are already stripped per-slot/per-result above:
      // `blocked_by[].email` is a raw internal colleague address
      // (findAvailableSlots.ts:661) and `attendee_hours_note` is that
      // colleague's verbatim stated working hours (findAvailableSlots.ts:927).
      // Neither is caught by the walks above — they live one level further
      // out, on r.day_summary[] rather than r.results[] / r.slots[].
      if (Array.isArray(r.day_summary)) {
        for (const day of r.day_summary as Array<Record<string, unknown>>) {
          delete day.blocked_by;
          delete day.attendee_hours_note;
        }
      }
    }
    return result;
  }

  private async dispatch(
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
