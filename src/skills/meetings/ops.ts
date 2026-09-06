/**
 * Meetings-skill direct-ops dispatcher (internal; not a loadable skill).
 *
 * The direct calendar operations (`get_calendar`, `create_meeting`,
 * `move_meeting`, `delete_meeting`, `update_meeting`, `get_free_busy`,
 * `find_available_slots`, `analyze_calendar`, ...) live in ./ops/handlers/*
 * (extracted v3.7.x); `executeToolCall` below is a thin dispatcher plus the
 * email-leg result scrub. The pure helpers `processCalendarEvents` /
 * `analyzeCalendar` live in ./ops/analysis and are re-exported below for
 * their consumers (tasks/briefs.ts, core/orchestrator/buildTurnContext.ts);
 * the task runner's `calendar_fix` dispatcher is a retired no-op
 * (tasks/dispatchers/calendarFix.ts) and consumes neither.
 *
 * It exposes a class (`SchedulingSkill`) that conforms to the Skill interface
 * ONLY because `MeetingsSkill` instantiates it and delegates `executeToolCall`
 * for direct-ops tool names. Its `getTools` and `getSystemPromptSection` are
 * never consulted — `MeetingsSkill` owns both — so keeping them would be dead
 * code. They are intentionally absent.
 *
 * NOT registered in `skills/registry.ts` — internal helper, not a togglable
 * skill.
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
  handleRevertAction,
  handleSetWorkScheduleOverride,
  handleGetWorkScheduleOverrides,
  handleAnalyzeCalendar,
  handleGetFreeBusy,
  handleDeleteMeeting,
} from './ops/handlers/calendarReads';
import type { OpCtx } from './ops/handlers/context';
import { grantRelaxed } from './bookingRequest';

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
    // gh#154-R3 (2026-08-06) — computed ONCE here, for find_available_slots only,
    // and threaded into the handler via OpCtx.relaxedGrant (context.ts) so
    // `handleFindAvailableSlots`'s own internal `grantRelaxed(args, context)`
    // call (resolved near the top of that handler — needed mid-search for the real
    // rule-bypass decision, not just this disclosure) reads the SAME result
    // instead of calling it a second time and logging its decision twice.
    const relaxedGrant = toolName === 'find_available_slots' ? grantRelaxed(args, context) : undefined;
    const result = await this.dispatch(toolName, args, context, relaxedGrant);

    // o#222 / G1 (2026-08-06, owner ruling: "stay quiet ... its long strange
    // that she explains other people why I cant meet with them") — a
    // room-clamped rule-bend on find_available_slots (relaxedReason ===
    // 'owner_room_bend') used to attach `owner_override_not_applied`, a
    // notice telling Sonnet to say plainly in the room that his override
    // didn't land. That is exactly the room-narration the owner ruled out:
    // explaining HIS constraints to the other people in the chat while he is
    // sitting right there. Removed — no field, no narration.
    //
    // No replacement owner-facing signal is needed on this path, unlike
    // create_meeting/move_meeting's room-bend case (createMeeting.ts:1084,
    // moveMeeting.ts:1234): those call createApprovalRequest and the owner
    // learns the outcome through his own private approval DM thread, so the
    // room can stay silent AND he still finds out. find_available_slots is
    // read-only — no booking is pending and nothing needs his sign-off — so
    // there is no decision to deliver to him at all. The STRICT results
    // returned here are honest on their own (real, rule-compliant slots);
    // presenting them without commentary misleads no one. If he wants the
    // override actually applied he asks in a genuine 1:1 DM (owner_direct,
    // granted immediately) or calls create_meeting/move_meeting with
    // relaxed=true, which already routes correctly and quietly.

    // email-aside-leak-no-channel-scope — `override_notice` (createMeeting.ts,
    // sourced from planMeeting.ts's overrideNotice) is a second-person aside
    // written FOR THE OWNER ("this books over your optional standup") and can
    // embed another private meeting's SUBJECT or an attendee's busy status.
    // Every email turn's reply IS the client-forwardable text (systemPrompt.ts's
    // emailReplySection, gh#175a removed the owner-only FOR-YOU/cut-line split
    // entirely) — there is no owner-facing side channel on that leg for such a
    // note to land in instead, so if left on the payload it has nowhere to go
    // but into the text the owner forwards verbatim to the external. Strip
    // here, the one point every direct op returns through, rather than gate
    // each handler's attach site individually. Rule 10: when the audience is
    // unclear, return less.
    // gh#4.8.7 attendee-signal-dropped-on-create-refusal — `_attendee_busy_note`
    // used to be move_meeting-only, and move_meeting is absent from
    // CHANNEL_TOOL_CLAMP.email (registry.ts), so stripping it here was
    // previously dead code (a key that could never be present). It is no
    // longer dead: create_meeting's FAILED confirm_override return now also
    // carries it (createMeeting.ts, sourced from planMeeting's
    // `attendeeBusyLabel`) — the same "who's busy" prose as `override_notice`
    // above, and create_meeting IS one of the four email-leg tools. Strip it
    // here too, same reasoning, same chokepoint.
    if (context.channel === 'email' && typeof result === 'object' && result !== null && !Array.isArray(result)) {
      delete (result as Record<string, unknown>).override_notice;
      delete (result as Record<string, unknown>)._attendee_busy_note;
      // floating-block-impact-preflight (2026-08-27) — same class of leak as
      // `override_notice` just above: second-person owner admin narration
      // ("this leaves no room for your lunch") that has no owner-facing side
      // channel on the email leg — the whole reply is the client-forwardable
      // text. Strip here rather than gate the attach site in createMeeting.ts.
      delete (result as Record<string, unknown>).floating_block_impact;

      // Same class of leak, find_available_slots' side: the owner-trade-off note
      // family (_over_optional_note / _attendee_conflicts_note /
      // _no_all_attendee_free_note / _recovery_note,
      // findAvailableSlots.ts's result-wrapper block) is second-person prose for the owner
      // PLUS the raw per-slot data it narrates — a non-private meeting's
      // subject (`over_optional`) and a colleague's email + busy reason
      // (`attendee_conflicts`). Stripping only the notes would still leave that
      // data sitting in the model's context on a leg whose entire reply is
      // forwarded verbatim to an external party, so both the notes AND the
      // fields they describe are removed here — the same chokepoint, extended.
      // (`_attendee_busy_colleague_note`, same block, is NOT
      // stripped here — it's gated on `mustBe`, which requires
      // `!isOwnerInitiatedSearch`; the email leg is always
      // `senderRole:'owner'` so `isOwnerInitiatedSearch` is always true and the
      // key can never be present on this leg — deleting it was dead code.)
      const r = result as Record<string, unknown>;
      delete r._over_optional_note;
      delete r._attendee_conflicts_note;
      delete r._no_all_attendee_free_note;
      delete r._recovery_note;
      // pre-wrap-4.8.2-bouncer — `_attendee_email_note` (createMeeting.ts) names
      // a colleague's resolved directory address plus the model-supplied one it
      // overrode, and instructs stating the real address in the reply — the
      // same shape of leak as `_attendee_conflicts_note` above, on the one leg
      // whose whole reply is forwarded verbatim to an external.
      delete r._attendee_email_note;
      // pre-wrap-4.8.2-bouncer — `_travel_buffer_note` (findAvailableSlots.ts)
      // is owner-scheduling-mechanics prose ("screened with an N-minute travel
      // buffer against Idan's real commitments") with no owner-facing side
      // channel on this leg, same class as `_over_optional_note` above.
      delete r._travel_buffer_note;
      // scanner-relay-first-person-attendee-status — `_attendee_status_note`
      // teaches quoting the per-entry `line` of a field this same scrub
      // deletes just below; a note pointing at a stripped field would only
      // mislead, so it goes with it.
      delete r._attendee_status_note;
      // `attendee_status` (findAvailableSlots.ts's colleague-path / flexible-
      // requester annotation — the block that builds the per-slot
      // `attendee_status` entries) is the same shape of fact — an
      // internal colleague's email + free/busy status per slot — and reaches
      // an owner-initiated email turn whenever ignore_attendee_availability or
      // a granted relaxed override is set, same as the fields above.
      // `less_preferred_label` (#Ayala-3, findAvailableSlots.ts, same subject
      // as `over_optional` pre-rendered into a quotable string) carries the
      // identical leak and is stripped alongside it — deleting `over_optional`
      // alone would leave the same subject text sitting one field over.
      if (Array.isArray(r.slots)) {
        for (const s of r.slots as Array<Record<string, unknown>>) {
          delete s.over_optional;
          delete s.less_preferred_label;
          delete s.attendee_conflicts;
          delete s.attendee_status;
        }
      }
      // email-siblings-not-stripped-results-branch — the SAME leak, the
      // candidate_validation branch's shape (findAvailableSlots.ts, taken
      // when the caller checks specific proposed times rather than searching):
      // no top-level `slots`, so the walk above never reaches it. Each
      // `results[]` item's `broken_rule` is the RAW per-attendee reason string
      // (`outside_attendee_work_hours:<email>` / `attendee_busy_collision:<email>`)
      // and `attendee_hours_note` spells out that same colleague's stated
      // working hours verbatim (attendeeHoursGroundingNotes) — both left in
      // place for the owner's own view; `broken_rule_label`
      // is the clean, human, name-free equivalent and stays. `travelers`
      // (top-level — not nested in `slots`, so the
      // per-slot walk above never reached it either) is a colleague's email + travel
      // location, same shape of fact as `attendee_status`.
      if (Array.isArray(r.results)) {
        for (const item of r.results as Array<Record<string, unknown>>) {
          delete item.broken_rule;
          delete item.attendee_hours_note;
        }
      }
      delete r.travelers;
      // Same family, main-branch sibling (`_attendee_unverified_note`): a
      // second-person aside attached when no slot survived attendee filtering
      // ("these are his OWN open times — I could not confirm the other
      // attendee(s) yet"). NOT stripped here — it's gated on
      // `usedColleagueOwnerOnly`, itself only ever set from
      // `colleagueOwnerOnlySlots`, which requires
      // `!isOwnerInitiatedSearch` — always false on the email leg
      // (senderRole:'owner' → isOwnerInitiatedSearch true) — so the key can
      // never be present here; deleting it was dead code.

      // email-siblings-not-stripped-results-branch — attendeeCheckWarnings'
      // output (unresolved_attendee_emails / _attendee_email_warning /
      // attendees_not_checked / _attendee_not_checked_warning) is the same
      // class of leak: an internal colleague's raw email address, or a notice
      // naming them. It rides BOTH attendeeCheckWarnings call sites
      // (the candidate_validation branch and the main slots pass)
      // — both spread it at the TOP LEVEL of the result, so
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
      // v4.4.x — `unresolved_attendee_emails` carries the SAME honesty gap as
      // `attendees_not_checked`: its own warning text says outright "their
      // availability was NOT checked (a nonexistent mailbox reads as fully
      // free)" (attendeeCheckWarnings), yet this flag used to key off
      // `attendees_not_checked` alone — a search whose ONLY trigger was an
      // unresolved address (attendees_not_checked empty) silently fell through
      // with no notice, reading as fully verified on the one leg forwarded
      // to an external client verbatim.
      const freeBusyReadFailed =
        (Array.isArray(r.attendees_not_checked) && r.attendees_not_checked.length > 0)
        || (Array.isArray(r.unresolved_attendee_emails) && r.unresolved_attendee_emails.length > 0);
      delete r.unresolved_attendee_emails;
      delete r._attendee_email_warning;
      delete r.attendees_not_checked;
      delete r._attendee_not_checked_warning;
      if (freeBusyReadFailed) {
        r._unverified_availability_notice =
          "One or more attendees' calendars could not be read for this window, so these times are not confirmed free for everyone — say so plainly rather than presenting them as fully checked.";
      }

      // email-leg-payload-strips-attendee-identifying-fields — day_summary
      // (attached whole in the result-wrapper block) carries the same two
      // facts per DAY that are already stripped per-slot/per-result above:
      // `blocked_by[].email` is a raw internal colleague address and
      // `attendee_hours_note` is that colleague's verbatim stated working
      // hours (attendeeHoursGroundingNotes).
      // Neither is caught by the walks above — they live one level further
      // out, on r.day_summary[] rather than r.results[] / r.slots[].
      // slots-returned-turn-carries-no-attendee-rejection-reason (2026-09-06)
      // — `attendee_partial_conflicts` is `blocked_by`'s twin for a day that
      // DID yield slots ({email, slots_blocked}, same per-attendee split, same
      // raw address), so it is stripped with it. Without this the field would
      // be the one attendee-identifying key on the payload that survives this
      // leg — and it would also reach the persisted tool-summary line
      // (turnHelpers' `attendee_partial=`), which renders from the
      // POST-scrub result, so this one delete closes both.
      if (Array.isArray(r.day_summary)) {
        for (const day of r.day_summary as Array<Record<string, unknown>>) {
          delete day.blocked_by;
          delete day.attendee_partial_conflicts;
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
    relaxedGrant?: OpCtx['relaxedGrant'],
  ): Promise<unknown | null> {
    const { email: userEmail, timezone } = context.profile.user;
    const opCtx: OpCtx = { context, userEmail, timezone, relaxedGrant };

    switch (toolName) {
      case 'hold_slot':
        return handleHoldSlot(args, opCtx);
      case 'get_calendar':
        return handleGetCalendar(args, opCtx);

      // gh#52 (52-U4b) — tool name unchanged (registered in meetings.ts, Instructor's
      // wording); the handler behind it is now the general revert dispatch, not
      // auto-move-only. See handleRevertAction's own header for the rename.
      case 'revert_last_auto_move':
        return handleRevertAction(args, opCtx);
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
