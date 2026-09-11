/**
 * moveMeeting — extracted VERBATIM (v3.7.x, pass B) from the 'update_meeting' + 'move_meeting' case bodies of
 * SchedulingSkill.executeToolCall in ../../ops.ts. No logic changes: the case
 * bodies are byte-for-byte identical; only relative import/require paths were
 * deepened by two levels for the ops/handlers/ location, and the free
 * variables (context, userEmail, timezone) are threaded via OpCtx.
 */
import logger from '../../../../utils/logger';
import { DateTime } from 'luxon';

import { formatIsoTime, computeVacatedSlot, openQuestionsField, alternativesNote, recordProposedAlternatives, subjectsPlausiblyMatch, resolveActivityTargetIdentity, HANDLER_ERROR_CODE } from '../../ops/helpers';
import { humanizeViolationLabel, attendeeConflictRefusal, bookedOverAttendeesNote } from '../../ops/violationLabels';
import {
  getCalendarEvents,
  findSameSubjectSiblings,
  getEventForAttendeeUpdate,
  updateMeeting,
  type AttendeeConflictTag,
  type SearchRejectReason,
  firstRejectReason,
  CalendarOfflineError,
} from '../../../../connectors/graph/calendar';
import {
  auditLog,
  getPersonMemory,
} from '../../../../db';
import { checkSlot, type RuleViolationKind } from '../../../../utils/scheduleRules';
import { grantRelaxed, emailStatedByHuman } from '../../bookingRequest';
import { closeMeetingArtifacts } from '../../../../utils/closeMeetingArtifacts';
import { resolveStatedInstant, renderWeDualClock, statedZoneFromArgs, statedClockPersonContext, StatedTimeClarificationError } from '../../../../utils/weTimeResolver';
import { presentationLocalFieldFor } from '../../../../utils/attendeeAvailability';
import { checkIntendedWeekday } from '../../../../utils/weekdayGuard';
import { alignNearestQuarter } from '../../../../utils/calendarDensity';
import { displaySubject, subjectViewerFor, viewerEmailFor, isEventPrivate } from '../../../../utils/displaySubject';
import { createApprovalRequest } from '../../../../tasks/skill';
import { logActivity } from '../../../../core/requests/logActivity';
import type { OpCtx } from './context';

/**
 * seriesKeyOf — the series identity of a Graph event, or undefined when the
 * event isn't part of a recurring series at all. A seriesMaster's own id IS
 * the series key (occurrences reference it via seriesMasterId); an
 * occurrence/exception carries seriesMasterId directly; a singleInstance has
 * neither and returns undefined (never treated as "same series" as anything).
 */
function seriesKeyOf(ev: { type?: string; seriesMasterId?: string; id: string }): string | undefined {
  if (ev.type === 'seriesMaster') return ev.id;
  if ((ev.type === 'occurrence' || ev.type === 'exception') && ev.seriesMasterId) return ev.seriesMasterId;
  return undefined;
}

/**
 * notOrganizerRefusal — THE "he's an attendee, not the organizer" refusal for
 * the move path, one spelling for the two places that can reach that verdict:
 * handleMoveMeeting's own ownership gate (its findMeetingOwner call) and
 * planMeeting's `refuse_not_owners` further down. Same fact, same words, so
 * the two can never drift into two different refusals (M1).
 *
 * `organizerEmail` is REQUIRED, and that is the whole point: findMeetingOwner
 * fail-CLOSES — a Graph organizer read that failed (stale / hallucinated id,
 * transient 4xx) returns ownerIsOrganizer=false with a NULL organizer, which
 * is not evidence about who organizes the meeting. Neither caller may reach
 * this without a resolved organizer, so this text can never claim someone
 * organized a meeting nobody was able to look up.
 */
function notOrganizerRefusal(opts: {
  subject: unknown;
  ownerFullName: string;
  organizerName: string | null;
  organizerEmail: string;
}): Record<string, unknown> {
  const ownerFirst = opts.ownerFullName.split(' ')[0];
  const orgName = opts.organizerName ?? opts.organizerEmail;
  return {
    error: 'not_organizer',
    meeting_subject: opts.subject,
    organizer_name: orgName,
    organizer_email: opts.organizerEmail,
    message: `Can't move "${opts.subject}" — ${orgName} organized that one, not ${ownerFirst}. The organizer is the only one who can shift the time. Want me to flag it to ${ownerFirst} so he can ping them, or skip?`,
  };
}

/**
 * checkSameSubjectCollision — same-subject-collision disambiguation guard,
 * shared by update_meeting and move_meeting, BOTH unconditional (2026-09-07 —
 * update_meeting used to gate this on attendeeChangeRequested; widened, see
 * the call site for why). Originally
 * elie-eli-name-confusion-noy-addition-unclear-confirmation (2026-08-09) on
 * the update path only; ported to move_meeting 2026-08-14, then extracted
 * here (bouncer, same night) so one rule has one spelling.
 *
 * Every gate downstream (organizer check, requester-controls, the mutation
 * itself) trusts args.meeting_id verbatim, but on a colleague's bare
 * subject reference ("add X to the meeting" / "move the sync to 3pm"),
 * meeting_id was resolved by the MODEL matching whatever get_calendar
 * returned against subject text — no code-owned check that the match was
 * unique. Two independent live events sharing an identical subject (created
 * minutes apart, for different attendee sets — Maayan's brand-new
 * "Offensive Hub Technical Q&A" vs. Elie's pre-existing meeting of the same
 * name) are indistinguishable to it.
 *
 * Mirrors findReschedulableSibling's create-path principle — match WHO, not
 * just WHAT — but for lookup: when another live event shares the identical
 * subject, resolve which one the ASKER actually means via the SAME
 * per-meeting signal the requester-controls gate downstream already trusts
 * (requests.requester_slack_id) plus raw attendee membership, then either
 * silently correct meeting_id (exactly one match) or refuse and ask instead
 * of guessing (zero or multiple matches). Owner-path is exempt — he can see
 * his own calendar and disambiguate himself.
 *
 * bouncer bounce (2026-08-14) — the ported move_meeting copy had no
 * series-membership filter: calendarView (findSameSubjectSiblings' source)
 * expands a recurring series into ONE EVENT PER OCCURRENCE, all sharing the
 * master's subject, so every "move/update our weekly" from a colleague found
 * every other occurrence of the SAME series as an "ambiguous" sibling and
 * refused every time — exactly the flow move_meeting's own tool description
 * sells. Fixed via seriesKeyOf: a sibling sharing the CHOSEN event's series
 * identity is the same recurring commitment, not a different meeting that
 * happens to share a subject, and is dropped before the ambiguity check.
 * Only genuinely different meetings (a different series, or a one-off) still
 * count. Fixes update_meeting's identical, previously-unexercised exposure
 * (narrower attendeeChangeRequested gate meant it was never hit) at the same
 * time — one fix, both call sites.
 */
async function checkSameSubjectCollision(
  args: Record<string, unknown>,
  ctx: OpCtx,
  opts: { toolName: 'update_meeting' | 'move_meeting'; actionPhrase: string },
): Promise<Record<string, unknown> | null> {
  const { context, userEmail, timezone } = ctx;
  if (!(context.authority !== 'owner' && typeof args.meeting_id === 'string' && typeof args.meeting_subject === 'string')) {
    return null;
  }
  try {
    const { findMeetingOwner } = await import('../../findMeetingOwner');
    const { getEventType } = await import('../../../../connectors/graph/calendar');
    const chosenProbe = await getEventType(userEmail, args.meeting_id);
    const subjectForMatch = (chosenProbe?.subject ?? (args.meeting_subject as string)).trim().toLowerCase();
    if (!chosenProbe?.startDateTime || !subjectForMatch) return null;
    const chosenSeriesKey = seriesKeyOf({ type: chosenProbe.type, seriesMasterId: chosenProbe.seriesMasterId, id: args.meeting_id });
    const askerEmail = getPersonMemory(context.userId)?.email?.toLowerCase();
    const siblings = await findSameSubjectSiblings({
      userEmail, subject: subjectForMatch, anchorIso: chosenProbe.startDateTime, timezone,
    });
    const others = siblings.filter(s => {
      if (s.id === args.meeting_id) return false;
      // Another occurrence of the SAME recurring series as the chosen
      // event — not a different meeting, just calendarView's expansion.
      // Never ambiguous.
      const sSeriesKey = seriesKeyOf(s);
      if (chosenSeriesKey && sSeriesKey && sSeriesKey === chosenSeriesKey) return false;
      const attendeeEmails = (s.attendees ?? []).map(a => (a.emailAddress?.address ?? '').toLowerCase());
      const askerIsOn = !!askerEmail && attendeeEmails.includes(askerEmail);
      // M10 — a private sibling a colleague isn't on is invisible to
      // them either way; never let it surface (as a redirect target
      // or in the ambiguous list) just because the subject collided.
      if (isEventPrivate({ sensitivity: s.sensitivity, categories: s.categories }, context.profile) && !askerIsOn) return false;
      return true;
    });
    if (others.length === 0) return null;
    type Candidate = { id: string; startIso: string; startTz?: string; attendeeEmails: string[] };
    const candidates: Candidate[] = [
      {
        id: args.meeting_id,
        startIso: chosenProbe.startDateTime,
        attendeeEmails: (chosenProbe.attendees ?? [])
          .map(a => (a?.emailAddress?.address ?? '').toLowerCase())
          .filter(Boolean),
      },
      ...others.map(s => ({
        id: s.id,
        startIso: s.start.dateTime,
        startTz: s.start.timeZone,
        attendeeEmails: (s.attendees ?? []).map(a => (a.emailAddress?.address ?? '').toLowerCase()),
      })),
    ];
    const askerId = context.userId;
    const matches: Candidate[] = [];
    for (const c of candidates) {
      let isMatch = !!askerEmail && c.attendeeEmails.includes(askerEmail);
      if (!isMatch) {
        try {
          const info = await findMeetingOwner({
            ownerUserId: context.profile.user.slack_user_id, ownerEmail: userEmail, eventId: c.id,
          });
          isMatch = !!info.requesterSlackId && info.requesterSlackId === askerId;
        } catch (err) {
          logger.warn(`${opts.toolName} — same-subject collision, findMeetingOwner threw for a candidate`, {
            candidateId: c.id, err: String(err).slice(0, 160),
          });
        }
      }
      if (isMatch) matches.push(c);
    }
    if (matches.length === 1) {
      if (matches[0].id !== args.meeting_id) {
        logger.info(`${opts.toolName} — same-subject collision, redirected to the event the asker actually requested/attends`, {
          askedFor: args.meeting_id, redirectedTo: matches[0].id, subject: subjectForMatch,
        });
        args.meeting_id = matches[0].id;
      }
      // else: matches[0] IS the chosen event — already correct despite the
      // sibling; no-op.
      return null;
    }
    const fmt = (c: Candidate): string =>
      DateTime.fromISO(c.startIso, { zone: c.startTz ?? timezone }).setZone(timezone).toFormat('EEE d MMM HH:mm');
    logger.info(`${opts.toolName} — same-subject collision, ambiguous — refusing to guess`, {
      meetingId: args.meeting_id, subject: subjectForMatch,
      candidateIds: candidates.map(c => c.id), matchCount: matches.length,
    });
    return {
      success: false,
      error: 'ambiguous_meeting_subject',
      meeting_subject: args.meeting_subject,
      candidates: candidates.map(c => ({ meeting_id: c.id, when: fmt(c) })),
      message: `There's more than one meeting called "${args.meeting_subject}" — one on ${candidates.map(fmt).join(', another on ')}. Ask which one they mean before ${opts.actionPhrase}; don't guess.`,
    };
  } catch (err) {
    logger.warn(`${opts.toolName} — same-subject collision check threw, proceeding with given meeting_id`, { err: String(err).slice(0, 160) });
    return null;
  }
}

/** The post-PATCH shape of the event, as `colleagueUpdateRuleGate` must judge it. */
interface PendingUpdate {
  /** The event as it stands BEFORE the PATCH. Loaded lazily — see the gate. */
  existing: Awaited<ReturnType<typeof getEventForAttendeeUpdate>> | undefined;
  /** The category this edit WRITES. undefined = the edit doesn't touch the category. */
  categoryOverride: string | undefined;
  /** EXACTLY the `location` the updateMeeting call will send. undefined = untouched. */
  patchLocation: string | undefined;
  /** EXACTLY the `isOnline` the updateMeeting call will send. undefined = untouched. */
  patchIsOnline: boolean | undefined;
  /** The venue re-resolve pushed the room mailbox onto the invite. */
  roomEmailAdded: boolean;
  /** Post-edit participant count INCLUDING the owner (what the room check sizes on). */
  participantCount: number | undefined;
}

/**
 * colleagueUpdateRuleGate — THE rule re-validation for a colleague's
 * `update_meeting`, scoped to what the edit actually puts at risk.
 *
 * WHY THIS EXISTS (owner ruling, 2026-09-07). Asked whether a colleague's
 * update on his calendar should shadow-DM him, he said: *"i don't want to know
 * abuot it, as long as its not breaking my rules"*. Silence, ON A CONDITION —
 * and the condition was false: `handleUpdateMeeting` called neither `checkSlot`
 * nor `planMeeting`, so once the requester-identity gate above passed, every
 * field went into one raw Graph PATCH with no rule logic anywhere behind it. A
 * requester could re-tag a meeting past a category cap, drop it onto a day the
 * category isn't allowed on, or plant a venue inside another meeting's travel
 * buffer, and nothing looked. So the fix he asked for is ENFORCEMENT, not
 * notification — there is deliberately NO DM here; an ESCALATION is how he
 * hears about it, and only when a rule would actually break.
 *
 * WHY NOT JUST CALL planMeeting, the way `move_meeting` does. A move changes
 * WHEN — the input nearly every rule is about — so re-running the whole cascade
 * is exactly right there. An update usually changes none of it, and a full
 * re-validation would refuse a colleague's harmless rename because the meeting
 * was already over a cap, already off-hours, or already double-booked when it
 * was booked. Breaking edits that are fine today is worse than the gap being
 * closed. So the check FOLLOWS THE CHANGE, not the tool:
 *
 *   nothing touched but the subject → nothing checked, no Graph read at all
 *   the category changes            → that category's day_type + per_day + per_week
 *   the venue changes               → the travel buffer around the (unchanged) slot
 *   the room mailbox gets invited   → the room is actually free
 *
 * `checkSlot`'s `onlyKinds` (scheduleRules.ts) is what makes that precise
 * rather than approximate: the rule ladder short-circuits on its first
 * violation, so without it a pre-existing `within_lead_time` or
 * `owner_busy_collision` on the meeting's own slot would mask the category
 * verdict the edit actually needs. It is still THE one validator (M1) — the
 * scope narrows which rules REPORT, never how any of them decides.
 *
 * WHAT IS DELIBERATELY NOT CHECKED, and why (each of these is a rule the edit
 * cannot change the answer to, so re-imposing it would only refuse edits that
 * are fine): the slot's own working-hours / off-day / lead-time / focus-floor /
 * floating-block verdicts, and `owner_busy_collision` — the time isn't moving.
 * An ADDED attendee's own busy time isn't checked either: busy is never a hard
 * blocker (M16), the requester adding them is the one who decides, and the
 * meeting isn't moving to accommodate them.
 *
 * OWNER PATH IS UNTOUCHED (M8) — the caller gates on
 * `context.authority !== 'owner'`. His override is total; this closes the
 * colleague hole only.
 */
async function colleagueUpdateRuleGate(
  args: Record<string, unknown>,
  ctx: OpCtx,
  pending: PendingUpdate,
): Promise<{ refusal?: Record<string, unknown>; roomSmallLabel?: string }> {
  const { context, userEmail } = ctx;
  const profile = context.profile;
  const ownerFirst = profile.user.name.split(' ')[0];
  const meetingId = args.meeting_id as string;
  const askerFirst = getPersonMemory(context.userId)?.name?.split(/\s+/)[0] ?? 'They';

  // Cheapest possible exit, and the one that keeps a bare rename free: decided
  // from the args + the shape re-eval's own outputs, with NO Graph read. A
  // rename (or an attendee add that didn't move the category or the venue)
  // touches no rule input, so nothing below runs — not the event load, not the
  // week fetch, not a free/busy probe.
  // `categoryOverride`, NOT `args.category`: the category that reaches the PATCH
  // is just as often the shape re-eval's own `detectCategory` verdict (a 5th
  // internal attendee re-tags the meeting with no `category` arg anywhere in the
  // call) — reading the arg alone would have exited here and skipped the cap
  // check on the exact edit this gate was built for.
  const touchesRuleInputs =
    pending.categoryOverride !== undefined
    || pending.patchLocation !== undefined
    || pending.patchIsOnline !== undefined
    || pending.roomEmailAdded;
  if (!touchesRuleInputs) return {};

  // The shape re-eval already loaded the event when it ran. Since 2026-09-09 an
  // explicit `location` string enters that branch too, so the ONLY edit that
  // still reaches this line with nothing loaded is a bare category-only one
  // (`category` alone — no attendee change, no `is_online`, no `location`);
  // load it here for that case. (A bare rename never gets this far: it touches
  // no rule input and returned above.)
  let existing = pending.existing;
  if (!existing) {
    try {
      existing = (await getEventForAttendeeUpdate(userEmail, meetingId)) ?? undefined;
    } catch (err) {
      if (err instanceof CalendarOfflineError) throw err;
      logger.warn('update_meeting colleague gate — event load threw', { err: String(err).slice(0, 200) });
    }
  }

  // Same "which category is this event in" read the shape re-eval above uses
  // (`existing.categories[0]`) — not a second notion of it (M1).
  const existingCategory = existing?.categories?.[0] ?? null;
  const effectiveCategory = pending.categoryOverride ?? existingCategory;
  const norm = (c: string | null | undefined): string => (c ?? '').trim().toLowerCase();
  const categoryChanged =
    pending.categoryOverride !== undefined && norm(pending.categoryOverride) !== norm(existingCategory);
  const postLocation = (pending.patchLocation ?? existing?.location ?? '').trim();
  const locationChanged =
    (pending.patchLocation !== undefined && pending.patchLocation.trim() !== (existing?.location ?? '').trim())
    || (pending.patchIsOnline !== undefined && pending.patchIsOnline !== existing?.isOnline);

  const riskKinds = new Set<RuleViolationKind>();
  if (categoryChanged) {
    // The three rules that are FUNCTIONS OF THE CATEGORY. All of them live only
    // inside checkSlot, which update_meeting never called — so re-tagging a
    // meeting (a 5th internal attendee flips it, or `category` is passed
    // outright) walked straight past the owner's own caps and day-type.
    riskKinds.add('category_day_type');
    riskKinds.add('category_per_day');
    riskKinds.add('category_per_week');
  }
  // Rule 7 reads the CATEGORY's travel flag and the venue's catalog time, so
  // either side changing re-opens it. One carve-out: a post-edit meeting with
  // no physical location at all (pure Teams) has no commute — an edit that
  // takes the venue AWAY strictly removes travel need and must never be the
  // thing that refuses.
  if ((categoryChanged || locationChanged) && postLocation !== '') {
    riskKinds.add('travel_buffer_collision');
  }

  if (riskKinds.size === 0 && !pending.roomEmailAdded) return {};

  // Past this point something IS at risk, so an unreadable slot is "can't
  // check", never "nothing to check" — same stance as move_meeting's own
  // colleague gate: the owner decides rather than the edit going through blind.
  if (!existing?.startIso || !existing?.endIso) {
    logger.warn('update_meeting colleague gate — could not read the meeting\'s own slot, escalating', {
      meetingId, requester: context.userId, riskKinds: [...riskKinds],
    });
    return {
      refusal: {
        needs_owner_approval: true,
        reason: 'rule_check_failed',
        meeting_subject: args.meeting_subject,
        message: `I couldn't read "${args.meeting_subject}" well enough to check that change against ${ownerFirst}'s rules. Raise create_approval(kind=policy_exception) so he can decide.`,
        _deferred_action_hint: { tool: 'update_meeting', args: { ...args } },
      },
    };
  }

  try {
    if (riskKinds.size > 0) {
      // gh#203-3/203-5 — the venue-sourced travel number, through the SAME
      // catalog lookup planMeeting uses on create/move, so one venue's stated
      // travel time means the same thing on all three paths.
      //
      // ONE deliberate difference from planMeeting's gate, which also requires
      // `!isOnline`: there it reads a FRESH location verdict, where an explicit
      // physical venue always comes back isOnline=false, so the clause only ever
      // excluded the hybrid room-plus-Teams shape — which `isCompanyLocation`
      // below excludes anyway. Here `isOnline` is the EVENT's existing flag, and
      // an explicit `location` edit doesn't clear it: a meeting that still
      // carries a Teams link would have skipped the lookup and been padded with
      // the category default instead of the venue's real (possibly larger)
      // travel time — under-padding the one check this is for. Physicality is
      // decided by the location string, which is what the other two clauses
      // already test.
      let venueTravelMinutes: number | undefined;
      if ((profile.skills as Record<string, unknown> | undefined)?.venue === true
          && postLocation.length > 0) {
        const { isPhoneLocationString } = await import('../../../../utils/resolveLocation');
        const { getVenueTravelTimeMinutes, isCompanyLocation } = await import('../../../../db/venues');
        if (!isPhoneLocationString(postLocation)
            && !isCompanyLocation(postLocation, profile.meetings.office_location ?? {})) {
          venueTravelMinutes = getVenueTravelTimeMinutes(profile.user.slack_user_id, postLocation) ?? undefined;
        }
      }
      // THE validator, and THE two-week window planMeeting validates against
      // (loadEventsForCheck) — the per-WEEK category count needs the whole week,
      // and a second hand-rolled window here is how the two would disagree.
      const { loadEventsForCheck } = await import('../../planMeeting');
      const events = await loadEventsForCheck(profile, existing.startIso);
      const verdict = checkSlot({
        profile,
        slotStartIso: existing.startIso,
        slotEndIso: existing.endIso,
        category: effectiveCategory,
        events,
        // The meeting being edited must never count against its own caps or
        // collide with itself — it is already on the calendar (same reason
        // move_meeting excludes it, moveMeeting.ts's own search call).
        excludeEventIds: [meetingId],
        onlyKinds: riskKinds,
        travelBufferMinutes: venueTravelMinutes,
        // M10 — the label can embed a neighbouring meeting's subject and, for a
        // cap, the owner's own arithmetic. Scoped at the producer for the
        // colleague who is reading it.
        viewer: subjectViewerFor(context),
        viewerEmail: viewerEmailFor(context),
      });
      if (!verdict.passes) {
        const label = verdict.violation_label ?? 'it breaks one of his scheduling rules';
        logger.info('update_meeting colleague gate refused — edit breaks an owner rule', {
          meetingId, requester: context.userId,
          risk: [...riskKinds],
          broken_rule: verdict.violation_kind,
          category_before: existingCategory, category_after: effectiveCategory,
          location_changed: locationChanged,
        });
        return {
          refusal: {
            needs_owner_approval: true,
            reason: HANDLER_ERROR_CODE.NOT_RULE_COMPLIANT,
            broken_rule: verdict.violation_kind ?? 'unknown',
            // M9 — the REAL reason, straight off the validator that produced it,
            // never re-worded here. Quoted verbatim into the ask so the owner
            // (and then the requester) sees the same sentence.
            broken_rule_label: label,
            meeting_subject: args.meeting_subject,
            message: `${askerFirst} asked to change "${args.meeting_subject}", but that change breaks one of ${ownerFirst}'s scheduling rules. ${label} I can't do it on my own — call create_approval(kind=policy_exception) and pass that reason in ask_text so ${ownerFirst} knows what he's deciding.`,
            _deferred_action_hint: { tool: 'update_meeting', args: { ...args } },
          },
        };
      }
    }

    // ── The room, when the venue re-resolve just invited it ────────────────
    // Same three outcomes planMeeting applies on create/move (its
    // `addRoomEmail` block) — never reached from update before, so a venue
    // change quietly booked a room somebody else already had.
    if (pending.roomEmailAdded) {
      const { checkMeetingRoomAvailability } = await import('../../../../utils/meetingRoomAvailability');
      const roomVerdict = await checkMeetingRoomAvailability({
        profile,
        startIso: existing.startIso,
        endIso: existing.endIso,
        participantCount: pending.participantCount ?? 0,
      });
      if (roomVerdict.kind === 'room_busy_small_fits') {
        logger.info('update_meeting colleague gate — meeting room busy, falling back to the small room', {
          meetingId, smallLabel: roomVerdict.smallLabel, participantCount: pending.participantCount,
        });
        return { roomSmallLabel: roomVerdict.smallLabel };
      }
      if (roomVerdict.kind === 'room_busy_too_big') {
        logger.info('update_meeting colleague gate refused — meeting room busy + group too large', {
          meetingId, requester: context.userId, participantCount: pending.participantCount,
        });
        return {
          refusal: {
            needs_owner_approval: true,
            reason: HANDLER_ERROR_CODE.MEETING_ROOM_UNAVAILABLE_LARGE_MEETING,
            meeting_subject: args.meeting_subject,
            suggested_ask_text: roomVerdict.suggestedAskText,
            message: `${askerFirst} asked to move "${args.meeting_subject}" into the meeting room, but it's taken then and the group is too big for the small room. Raise create_approval(kind=policy_exception) so ${ownerFirst} decides — push the time, trim the list, or grab space some other way.`,
            _deferred_action_hint: { tool: 'update_meeting', args: { ...args } },
          },
        };
      }
    }
  } catch (err) {
    // Same stance as move_meeting's colleague gate: an unreadable calendar is
    // not a "couldn't verify, he decides" — it goes out as offline at the tool
    // surface and nothing is written. Any other fault escalates rather than
    // letting an unvalidated edit through.
    if (err instanceof CalendarOfflineError) throw err;
    logger.warn('update_meeting colleague gate threw — escalating to approval', { err: String(err).slice(0, 200) });
    return {
      refusal: {
        needs_owner_approval: true,
        reason: 'rule_check_failed',
        meeting_subject: args.meeting_subject,
        message: `I couldn't verify whether that change fits ${ownerFirst}'s rules right now. Raise create_approval(kind=policy_exception) so he can decide.`,
        _deferred_action_hint: { tool: 'update_meeting', args: { ...args } },
      },
    };
  }

  return {};
}

export async function handleUpdateMeeting(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;

        // elie-eli-name-confusion-noy-addition-unclear-confirmation (2026-08-09)
        // — same-subject-collision guard for the update-by-name path.
        // Widened to UNCONDITIONAL 2026-09-07 (Fable finding): this used to
        // be gated to attendeeChangeRequested (add/remove attendees only) —
        // that was the field that exposed the ORIGINAL incident, never a
        // claim that a rename/relocate/recategorize on an ambiguous
        // meeting_id was safe. gh#154-W1's requester-controls gate further
        // down is unconditional for EVERY field, so a colleague's bare
        // "rename our Q&A" with two live "Q&A"s used to skip this check
        // entirely, stamp `_deferred_action_hint` on the WRONG meeting_id,
        // and get approved by the owner — whose replay runs with
        // authority:'owner', which this very check exempts from
        // disambiguation (see its header: "he can see his own calendar"),
        // so nothing downstream ever caught the mismatch either. Running
        // this unconditionally on the colleague-authority first pass catches
        // the ambiguity before a corrupted hint can be stamped at all — same
        // shape as move_meeting's own unconditional call below. Shared via
        // checkSameSubjectCollision above (extracted 2026-08-14) — see that
        // function's header for the full rationale, including the
        // series-membership fix.
        {
          const collision = await checkSameSubjectCollision(args, ctx, { toolName: 'update_meeting', actionPhrase: 'making the change' });
          if (collision) return collision;
        }

        // v2.7.0 — ownership via findMeetingOwner, fetched ONCE and reused by
        // BOTH the attendee-only (not_organizer) guard directly below and the
        // requester-controls gate further down. gh#154-W1 bounce (2026-08-06): the
        // two gates used to each call findMeetingOwner separately with the
        // identical {ownerUserId, ownerEmail, eventId} — two Graph
        // getEventOrganizer round trips per colleague update_meeting call.
        // One lookup, shared result.
        let ownerInfo: import('../../findMeetingOwner').MeetingOwnerInfo | undefined;
        try {
          const { findMeetingOwner } = await import('../../findMeetingOwner');
          ownerInfo = await findMeetingOwner({
            ownerUserId: context.profile.user.slack_user_id,
            ownerEmail: userEmail,
            eventId: args.meeting_id as string,
          });
        } catch (err) {
          logger.warn('update_meeting — findMeetingOwner threw', { err: String(err) });
        }

        // v2.1.4 — attendee-only guard. If the event's organizer is not the
        // owner, the owner is an ATTENDEE on someone else's meeting. Graph
        // rejects PATCH from non-organizers, but the error message is unhelpful;
        // refuse early with a clear human message so Maelle doesn't offer a fake
        // "I'll add the location" then silently fail.
        if (ownerInfo && !ownerInfo.ownerIsOrganizer && ownerInfo.organizerEmail) {
          const ownerFirst = context.profile.user.name.split(' ')[0];
          const orgName = ownerInfo.organizerName ?? ownerInfo.organizerEmail;
          logger.info('update_meeting refused — owner is attendee, not organizer', {
            meetingId: args.meeting_id, organizer: ownerInfo.organizerEmail,
          });
          return {
            error: 'not_organizer',
            meeting_subject: args.meeting_subject,
            organizer_name: orgName,
            organizer_email: ownerInfo.organizerEmail,
            message: `Can't change "${args.meeting_subject}" — ${orgName} organized that one, not ${ownerFirst}. Only the organizer can change the subject, location, or body. Want me to flag it to ${ownerFirst}?`,
          };
        }

        // v1.8.8 — block series-level mutations on recurring meetings. If the
        // event is a seriesMaster, updating it would change every occurrence,
        // which is almost never what the owner wants. Refuse and hand back
        // control. Occurrences (single firings of a recurring series) and
        // exceptions (already-customized single firings) are allowed — Graph
        // creates/modifies an exception for that instance on PATCH.
        // gh#wrong-event-moved-move-meeting (2026-08-12) — same probe now also
        // refuses BEFORE the PATCH below when the id resolves to a REAL
        // subject that doesn't plausibly match the CLAIMED args.meeting_subject
        // — Maelle's own id-resolution mistake (a prior search/read handed back
        // the wrong id), not the colleague-disambiguation case
        // findSameSubjectSiblings guards above (gated to colleague-path only,
        // for the DIFFERENT failure mode of two live events sharing one
        // subject). Unconditional — every authority. `updateProbeSubject` feeds
        // the success narration below (already MASKED — see below) so it
        // never echoes an unverified OR unmasked claim.
        // (bouncer objection 3, 2026-08-12) — FAIL-OPEN, stated plainly: if the
        // probe throws (transient Graph fault), BOTH the seriesMaster refusal
        // AND the wrong-event subject-mismatch guard are skipped for this
        // call, not just the seriesMaster check — `updateProbeSubject` stays
        // undefined and the success narration falls back to narrating the
        // caller's unverified `args.meeting_subject` claim, i.e. the exact
        // original incident behavior for this one call. Accepted trade-off
        // (failing closed on every transient read error has its own cost:
        // every update_meeting would refuse whenever Graph blips) — not
        // silent; see the catch below.
        let updateProbeSubject: string | undefined;
        try {
          const { getEventType } = await import('../../../../connectors/graph/calendar');
          const probe = await getEventType(userEmail, args.meeting_id as string);
          // o#216 (bouncer fix, 2026-08-12) — mask the probed subject ONCE, off
          // the raw Graph value, before it reaches ANY caller-facing payload
          // below: the seriesMaster refusal, the mismatch refusal, and
          // `updateProbeSubject` (→ the success narration) all share this one
          // masked value now, instead of each shipping (or, pre-fix, two of
          // three shipping) a private meeting's real title to whoever
          // triggered this call — update_meeting is colleague-allowed, and the
          // owner-organizer gate above this probe passes for the owner's own
          // private recurring series too.
          // gh#154-W5/gh#154-R4 (2026-08-06) — room-tightening lives inside
          // viewerEmailFor now (surface==='room' → null); call directly —
          // a blanket ?? null here also masked the email leg's subjects.
          const maskedProbeSubject = probe
            ? displaySubject(
                { subject: probe.subject, sensitivity: probe.sensitivity, categories: probe.categories, organizer: probe.organizer, attendees: probe.attendees },
                context.profile,
                subjectViewerFor(context),
                viewerEmailFor(context),
              )
            : undefined;
          if (probe?.type === 'seriesMaster') {
            logger.info('update_meeting refused on recurring seriesMaster', {
              meetingId: args.meeting_id,
              subject: probe.subject,
            });
            return {
              error: 'recurring_series_master',
              meeting_subject: maskedProbeSubject,
              message: `"${maskedProbeSubject}" is a recurring series. Updating the series here would change every occurrence — that's not safe to do automatically. The owner should update the series directly in the calendar. For a SINGLE occurrence, call update_meeting with that occurrence's meeting_id (get it from get_calendar for that specific date) — the system will create an exception for that one date only.`,
            };
          }
          if (probe?.subject && typeof args.meeting_subject === 'string'
              && !subjectsPlausiblyMatch(args.meeting_subject, probe.subject)) {
            logger.warn('update_meeting — meeting_id resolved to a subject that does not match the claim, refusing to guess', {
              meetingId: args.meeting_id, claimedSubject: args.meeting_subject, actualSubject: probe.subject,
            });
            return {
              success: false,
              error: 'meeting_id_subject_mismatch',
              meeting_subject: args.meeting_subject,
              // o#216 (bouncer fix) — masked, not the raw probe.subject: this
              // refusal is exactly as colleague/room-reachable as the
              // seriesMaster refusal above, which already masks.
              actual_subject: maskedProbeSubject,
              message: `The id given for "${args.meeting_subject}" actually points to a different event on the calendar ("${maskedProbeSubject}") — I won't change the wrong meeting. Re-read the calendar (get_calendar) to find the real id for "${args.meeting_subject}" and retry.`,
            };
          }
          updateProbeSubject = maskedProbeSubject;
        } catch (err) {
          // Fail-open — see the comment above this try block. Both the
          // seriesMaster check AND the wrong-event subject-mismatch guard are
          // skipped for this call, not just the recurring-series check.
          logger.warn('update_meeting recurring-preflight failed — proceeding (seriesMaster check AND wrong-event subject-mismatch guard both skipped for this call)', { err: String(err) });
        }

        // gh#154-W1 (2026-08-06) — requester-controls gate, moved OUT of the
        // attendee/venue-change conditional below and made UNCONDITIONAL for
        // every colleague-path update_meeting call. Previously this only ran
        // when `hasAttendeeChange || venueChangeRequested` was true, so a
        // call carrying just new_subject / category / location satisfied
        // neither predicate and reached the Graph write untouched — a
        // colleague holding a leaked event id (e.g. from create_meeting's
        // conflict steer — createMeeting.ts's `existing_event_id`) could
        // rename, relocate or re-categorize a private meeting they cannot
        // see and aren't on. Mirrors move_meeting's own unconditional
        // colleague gate below (`context.authority !== 'owner'` block):
        // whoever REQUESTED a meeting controls it; any other colleague is
        // routed to the owner's approval instead, for ANY field, not just
        // attendees.
        if (context.authority !== 'owner') {
          const ownerFirst = context.profile.user.name.split(' ')[0];
          // Reuse the ownerInfo fetched once above (same event, same call) —
          // no second findMeetingOwner round trip. A failed fetch above
          // (ownerInfo undefined) is treated as non-requester, same as the
          // old per-gate catch did.
          const isRequester = !!ownerInfo && ownerInfo.requesterSlackId === context.userId;
          if (!isRequester) {
            logger.info('update_meeting — non-requester colleague update → escalate', {
              meetingId: args.meeting_id,
              requester: context.userId,
              fields: Object.keys(args).filter(k => k !== 'meeting_id' && k !== 'meeting_subject'),
            });
            return {
              error: 'colleague_not_requester',
              meeting_subject: args.meeting_subject,
              // v3.7.x #2.1b — framing seed. NOT "only <owner> can change" (which
              // reads as "he must do it himself"): this change needs his sign-off, so
              // it's being SENT to him to approve. Requester-facing wording is #2.1a
              // (prompt chat); this is just the tool text that seeds it.
              message: `Changing "${args.meeting_subject}" needs ${ownerFirst}'s sign-off, so I'll send it to him to approve. Call create_approval(kind=policy_exception) with a short ask_text (what's changing and who's asking), and I'll apply the change the moment he approves.`,
              // v3.7.x #2.1b — replay path. Stamp the update_meeting deferred_action
              // (mirrors the create_meeting rule-violation branches) so owner-approve
              // REPLAYS the exact edit instead of resolving with nothing to apply.
              // Spread the RAW args verbatim (mirrors move_meeting's
              // `{ tool: 'move_meeting', args: { ...args } }` shape) — replay
              // always executes with senderRole:'owner' (deferredActionReplay.ts),
              // so this same gate is skipped on replay and the attendee
              // resolution / shape logic below runs exactly as it would on a
              // first-pass owner call.
              _deferred_action_hint: { tool: 'update_meeting', args: { ...args } },
            };
          }
        }

        // v2.9.1 — attendee add/remove path. When `add_attendees` or
        // `remove_attendees` is non-empty
        // we (a) gate colleague-path to whoever REQUESTED this specific
        // meeting (v3.1.4 — per-meeting, not a blanket colleague
        // permission; a non-requester colleague is routed to the owner's
        // approval instead, see meetings.ts:482/495/508), (b) load the
        // existing event, (c) compute the new attendee list, (d) re-evaluate
        // category + location ONLY when the change is shape-affecting
        // (internal-only ↔ has-external, or count crossing 4↔5),
        // (e) on the colleague path, re-check the owner's rules for whatever
        // (d) actually changed — `colleagueUpdateRuleGate` above, and
        // (f) call updateMeeting with the merged shape.
        const rawAdd = (args.add_attendees as Array<{ name?: string; email?: string; optional?: boolean }> | undefined) ?? [];
        const rawRemove = (args.remove_attendees as string[] | undefined) ?? [];
        const hasAttendeeChange = rawAdd.length > 0 || rawRemove.length > 0;
        // v3.7.x (#A) — the owner is changing the venue/online-ness ("make it the
        // meeting room", "in person") WITHOUT naming an explicit venue string. We
        // recompute the venue via resolveLocation (the SAME source create uses) and
        // trust its full verdict — instead of the old apply that left the location
        // untouched (2026-07-15 "changed to meeting room but the location didn't
        // change") and stripped the Teams link. An explicit `location` string still
        // wins (venueChangeRequested is false when one is given).
        const venueChangeRequested =
          typeof args.is_online === 'boolean'
          && !(typeof args.location === 'string' && (args.location as string).trim());
        // explicit-location-string-never-re-detects-the-category (2026-09-09)
        // — a bare `location` string (no is_online flag, no attendee change)
        // used to skip the whole shape-re-eval block below entirely, so an
        // online meeting could be re-pointed at a physical venue while
        // detectCategory never ran: the event kept its stale (online)
        // category, which carries no travel-buffer flag, so
        // colleagueUpdateRuleGate's rule 7 check silently found nothing to
        // enforce (travelBufferMinutesFor falls back to the STALE category's
        // own 0-minute default whenever the venue isn't in the catalog).
        // On that path the block does exactly ONE thing more than before — it
        // re-runs detectCategory with the new venue as its hint (gated further
        // down on the string genuinely differing from what's on the event).
        // It does NOT ship the attendee array (see `mergedAttendees` below) and
        // does NOT run resolveLocation (see `rePlaceVenue` below): the explicit
        // string is the venue, and the event's own online-ness is left alone.
        const explicitLocationRequested = typeof args.location === 'string' && !!(args.location as string).trim();
        let mergedAttendees: Array<{ name?: string; email: string; optional?: boolean }> | undefined;
        let newCategoryFromShape: string | undefined;
        let newLocationFromShape: string | undefined;
        let newIsOnlineFromShape: boolean | undefined;
        // 2026-09-07 — the three facts the colleague rule gate below needs from
        // this branch when it runs. Hoisted rather than re-read: the gate loads
        // the event itself ONLY on the one path that skips this branch entirely
        // AND still touches a rule input — a bare category-only edit (no
        // attendee change, no is_online flag, no explicit location) — so no
        // colleague update ever costs two reads of the same event.
        let existingEvent: Awaited<ReturnType<typeof getEventForAttendeeUpdate>> | undefined;
        let roomEmailAdded = false;
        let postEditParticipantCount: number | undefined;
        // jim-douglass follow-up (2026-08-30) — divergences between a supplied
        // address and the one actually invited (directory override, or a
        // human-stated address kept over a stale row), narrated on the success
        // return so a redirected invite is never silent. `resolvedAddedEmails`
        // carries the RESOLVED add-list for `added_attendees` — the raw
        // model-supplied addresses would misreport what was actually invited.
        const attendeeEmailNotes: string[] = [];
        let resolvedAddedEmails: string[] | undefined;

        if (hasAttendeeChange || venueChangeRequested || explicitLocationRequested) {
          // v3.1.4 — resolve name-only adds to emails from the directory
          // BEFORE the missing-email filter, via the shared resolver every
          // booking path uses. Without this, "add Eli Feldman" (no email) gets
          // dropped → attendee_missing_email → Maelle asks the colleague for an
          // email she already has on file.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { resolveAttendeeEmail } = require('../../../../memory/resolveAttendeeEmails') as
            typeof import('../../../../memory/resolveAttendeeEmails');
          const addList = rawAdd
            .map(a => {
              // jim-douglass-fabricated-email-across-repeat-bookings (2026-08-30) —
              // same rule as create's buildParticipants (bookingRequest.ts): when a
              // name is present the directory lookup ALWAYS runs (email:'' forces
              // it past the valid-email early return) and a confident, unambiguous
              // whole-name match overrides whatever email the model typed; no
              // match / ambiguous → the supplied email stands. Pre-fix this add
              // path trusted any syntactically-valid model email outright — the
              // exact fabrication hole the incident hit on create.
              //
              // Adversarial-review follow-up (same day): ONE escape hatch, the
              // same tie-break as create's — an address a human actually typed
              // in this conversation (emailStatedByHuman) outranks a differing
              // stored row; a fabricated address never appears in human text,
              // so it still loses. Either divergence is narrated via
              // attendeeEmailNotes on the success return.
              const supplied = (a.email ?? '').trim().toLowerCase();
              const hasName = !!a.name?.trim();
              const resolved = resolveAttendeeEmail({ name: a.name, email: hasName ? '' : supplied });
              let email = resolved.email || (supplied.includes('@') ? supplied : '');
              if (hasName && resolved.email && supplied.includes('@') && resolved.email !== supplied) {
                if (emailStatedByHuman(supplied, context)) {
                  email = supplied;
                  logger.info('update_meeting add_attendees — human-stated email kept over a differing directory row', {
                    name: a.name, stated: supplied, directory: resolved.email,
                  });
                  attendeeEmailNotes.push(
                    `${a.name ?? supplied} is invited at ${supplied} (the address stated in this conversation). The directory has a different address on file (${resolved.email}) — if that stored address is stale, say so and it should be corrected.`,
                  );
                } else {
                  logger.info('update_meeting add_attendees — directory match overrode the model-supplied email', {
                    name: a.name, supplied, resolved: resolved.email,
                  });
                  attendeeEmailNotes.push(
                    `${a.name ?? resolved.email} is invited at ${resolved.email} (the address on file), NOT at ${supplied}. If ${supplied} is actually the right address, the requester must state it explicitly and the invite will be corrected.`,
                  );
                }
              }
              return { name: resolved.name, email, optional: a.optional === true };
            })
            .filter(a => a.email.includes('@'));
          resolvedAddedEmails = addList.map(a => a.email);
          const removeList = rawRemove
            .map(e => (e ?? '').trim().toLowerCase())
            .filter(e => e.includes('@'));

          if (addList.length === 0 && rawAdd.length > 0) {
            return {
              error: HANDLER_ERROR_CODE.ATTENDEE_MISSING_EMAIL,
              meeting_subject: args.meeting_subject,
              message: `Can't add attendees without emails — at least one entry in add_attendees had no email. Pass each as { email: "...", name: "..." }.`,
            };
          }

          // Load existing event for current attendees + shape signals.
          const existing = await getEventForAttendeeUpdate(userEmail, args.meeting_id as string);
          if (!existing) {
            // Named from the flags that opened this block, not from the
            // add/remove path it used to serve alone: since 2026-09-09 a
            // location-only edit reaches here too, and "to update its
            // attendees" was a false account of what that call attempted.
            const attempted = [
              ...(hasAttendeeChange ? ['its attendees'] : []),
              ...((venueChangeRequested || explicitLocationRequested) ? ['its location'] : []),
            ].join(' and ');
            return {
              error: 'event_load_failed',
              meeting_subject: args.meeting_subject,
              message: `Couldn't load "${args.meeting_subject}" to update ${attempted}. The event may have been cancelled or moved.`,
            };
          }
          existingEvent = existing;

          // Typo'd internal attendee guard — mirrors create_meeting's probe
          // (createMeeting.ts) verbatim: a nonexistent @company mailbox
          // returns no busy data → reads as fully free → the update ships
          // with a phantom attendee who never gets the invite. Only the
          // addresses actually being ADDED this call are probed (existing
          // attendees were already verified when they were originally
          // invited); external addresses are skipped (Graph never has their
          // data), and the room mailbox is excluded.
          try {
            const ownerDomainLower = userEmail.includes('@') ? userEmail.split('@')[1].toLowerCase() : '';
            const roomLower = (context.profile.meetings.room_email ?? '').toLowerCase().trim();
            const internalAddedEmails = addList
              .map(a => a.email.toLowerCase())
              .filter(e => e && ownerDomainLower && e.endsWith('@' + ownerDomainLower) && e !== roomLower);
            if (internalAddedEmails.length > 0 && existing.startIso && existing.endIso) {
              const { getFreeBusyForDecision } = await import('../../../../connectors/graph/calendar');
              const { enrichUnresolvedInternal } = await import('../../ops/analysis');
              const fbDiag: { unresolved?: string[] } = {};
              await getFreeBusyForDecision(userEmail, internalAddedEmails, existing.startIso, existing.endIso, timezone, fbDiag);
              const unresolvedInternal = (fbDiag.unresolved ?? []).filter(e => e.endsWith('@' + ownerDomainLower));
              if (unresolvedInternal.length > 0) {
                const entries = enrichUnresolvedInternal(unresolvedInternal, ownerDomainLower);
                logger.warn('update_meeting — unresolved internal attendee email(s) in add_attendees, refusing to add a phantom', { entries });
                return {
                  success: false,
                  error: 'unresolved_attendee',
                  unresolved_attendee_emails: entries,
                  message: 'One or more attendee addresses don\'t exist in the company directory — adding them would invite someone who never gets it (a nonexistent mailbox reads as fully free). Most likely a wrong address: use did_you_mean if shown, or find the person via find_slack_user, then retry with the corrected address. Do NOT say they were added until the address resolves.',
                };
              }
            }
          } catch (err) {
            logger.warn('update_meeting — unresolved-attendee pre-check threw, proceeding', { err: String(err).slice(0, 200) });
          }

          // Build the merged list: keep all existing not in removeList,
          // then append adds not already present. Dedupe by lowercase email.
          const removeSet = new Set(removeList);
          const merged = new Map<string, { name?: string; email: string; optional?: boolean }>();
          for (const a of existing.attendees) {
            if (removeSet.has(a.email)) continue;
            merged.set(a.email, a);
          }
          for (const a of addList) {
            if (removeSet.has(a.email)) continue;  // a remove + add in same call: removed wins
            if (!merged.has(a.email)) merged.set(a.email, a);
          }
          const attendeesAfterEdit = [...merged.values()];
          // The roster ships to Graph ONLY when this edit changes it (an
          // add/remove) or re-places the venue (which may add the room mailbox).
          // Never on a bare explicit-`location` edit: Graph replaces the WHOLE
          // array on an attendees PATCH (calendarMutations.ts updateMeeting),
          // and the read-back in getEventForAttendeeUpdate maps every non-
          // 'optional' type — including the room's 'resource' — to
          // optional:false, so an unchanged roster would be re-sent with the
          // room mailbox as 'required'. `attendeesAfterEdit` still feeds the
          // shape signals and detectCategory below on every path.
          mergedAttendees = (hasAttendeeChange || venueChangeRequested) ? attendeesAfterEdit : undefined;

          // Shape change detection — same signals resolveLocation reads:
          // (a) has-external flipped, (b) participant count crossed 4↔5.
          const ownerEmailLc = context.profile.user.email.toLowerCase();
          const ownerDomain = ownerEmailLc.includes('@') ? ownerEmailLc.split('@')[1] : '';
          const wasExternal = existing.attendees.some(a =>
            ownerDomain && a.email.endsWith('@' + ownerDomain) ? false : a.email !== ownerEmailLc
          );
          const isExternalNow = attendeesAfterEdit.some(a =>
            ownerDomain && a.email.endsWith('@' + ownerDomain) ? false : a.email !== ownerEmailLc
          );
          // Count includes owner (resolveLocation reads total participantCount).
          const oldCount = existing.attendees.some(a => a.email === ownerEmailLc)
            ? existing.attendees.length
            : existing.attendees.length + 1;
          const newCount = attendeesAfterEdit.some(a => a.email === ownerEmailLc)
            ? attendeesAfterEdit.length
            : attendeesAfterEdit.length + 1;
          const crossedThreshold = (oldCount <= 3 && newCount >= 4)
            || (oldCount >= 4 && newCount <= 3)
            || (oldCount <= 4 && newCount >= 5)
            || (oldCount >= 5 && newCount <= 4);
          const shapeChanged = (wasExternal !== isExternalNow) || crossedThreshold;
          postEditParticipantCount = newCount;

          // explicit-location-string-never-re-detects-the-category — the
          // other half of the fix above: entering the outer block isn't
          // enough on its own, since THIS is the condition that actually
          // fires detectCategory. Gated on a REAL difference from what's on
          // the event (not just "a location arg was passed") so a resend of
          // the same venue string doesn't cost a needless re-classify.
          const explicitLocationChanged = typeof args.location === 'string'
            && (args.location as string).trim() !== (existing.location ?? '').trim();
          // Only a roster-moved shape or an `is_online` venue change re-PLACES
          // the meeting (resolveLocation + the trip-day override). A bare
          // explicit `location` re-classifies only — see the comment at the
          // resolveLocation call.
          const rePlaceVenue = shapeChanged || venueChangeRequested;

          if ((rePlaceVenue || explicitLocationChanged) && existing.startIso) {
            logger.info('update_meeting — shape / venue / explicit location changed, re-evaluating category', {
              meetingId: args.meeting_id,
              wasExternal, isExternalNow,
              oldCount, newCount,
              explicitLocationChanged,
              rePlaceVenue,
            });
            try {
              const { detectCategory } = await import('../../detectCategory');
              const { resolveLocation } = await import('../../../../utils/resolveLocation');
              const catResult = await detectCategory({
                profile: context.profile,
                // 2026-09-07 — the subject this edit is LEAVING BEHIND, when
                // the same call renames it. This read `args.meeting_subject`
                // (the old, caller-CLAIMED title), so a combined
                // "rename it to Simon interview and add Simon" classified off
                // the stale name and came back with the pre-rename category —
                // the classifier's single strongest signal, silently withheld.
                subject: ((args.new_subject as string | undefined)?.trim() || (args.meeting_subject as string)),
                attendees: attendeesAfterEdit,
                isRecurring: false,
                // Same gap as planMeeting's category detection (create_meeting's
                // onsite request read as "Meeting" instead of "Physical" because
                // the classifier never saw the location the caller gave) — this
                // re-evaluation has the same blind spot when an explicit venue
                // string came in on THIS call.
                locationHint: typeof args.location === 'string' ? args.location : undefined,
              });
              const newCategory = catResult.category;
              const oldCategory = existing.categories[0] ?? null;

              if (newCategory && newCategory !== oldCategory) {
                newCategoryFromShape = newCategory;
              }

              // Attendee-shape change re-evaluation: intent='new_booking'
              // (NOT 'move') and omit priorStartIso so resolveLocation
              // doesn't take the preserve_existing path. With intent='move' +
              // priorStartIso and an unchanged day-type, resolveLocation
              // would short-circuit to preserve_existing and the location
              // would never be re-stamped — which lost Teams URLs on
              // home-day internal→has-external transitions. Existing-state
              // fields stay populated for downstream callers but don't
              // gate the verdict.
              //
              // Skipped on a bare explicit-`location` edit (`rePlaceVenue`
              // false): the string itself is the venue that ships
              // (`patchLocation` below), and resolveLocation's isOnline verdict
              // is a function of day type + has-external + head-count — none of
              // which changed — never of the string. Letting it through here
              // would strip the Teams link from a still-internal meeting on a
              // home day for no reason the owner asked for; his ruling is that a
              // physical venue coexists with the join link (resolveLocation.ts,
              // path 3c). The event's own isOnline stays untouched on this path.
              const loc = rePlaceVenue
                ? resolveLocation({
                  profile: context.profile,
                  startIso: existing.startIso,
                  intent: 'new_booking',
                  category: newCategory ?? oldCategory ?? undefined,
                  participantCount: newCount,
                  hasExternalAttendee: isExternalNow,
                  existingLocation: existing.location,
                  existingIsOnline: existing.isOnline,
                })
                : undefined;
              if (loc?.kind === 'resolved') {
                if (venueChangeRequested) {
                  // Venue change → apply the FULL verdict verbatim (trust
                  // resolveLocation), NOT gated on "differs from existing": the
                  // owner is explicitly re-placing the meeting. isOnline follows the
                  // verdict (a 4+ Meeting Room always keeps Teams), never the raw
                  // is_online flag (which was the misread of "meeting room"). And the
                  // room mailbox is auto-added (optional), like the create path — so
                  // "change to meeting room" also lands meeting@… without a re-ask.
                  newLocationFromShape = loc.location;
                  newIsOnlineFromShape = loc.isOnline;
                  const roomEmail = (context.profile.meetings.room_email ?? '').toLowerCase().trim();
                  if (loc.addRoomEmail && roomEmail && mergedAttendees
                      && !mergedAttendees.some(a => a.email.toLowerCase() === roomEmail)) {
                    mergedAttendees.push({ email: roomEmail, optional: true });
                    // 2026-09-07 — flagged for the colleague rule gate below,
                    // which is where the room's own free/busy is actually
                    // checked (create/move do it in planMeeting; this push had
                    // no check behind it at all).
                    roomEmailAdded = true;
                  }
                } else {
                  if (loc.location !== existing.location) newLocationFromShape = loc.location;
                  if (loc.isOnline !== existing.isOnline) newIsOnlineFromShape = loc.isOnline;
                }
              }
              // v3.4.2 (travel context) — when the meeting's day is a trip day,
              // an onsite (internal, not remote-forced) meeting's location is the
              // TRIP place, not the home day-type default (Huddle/Teams) the
              // re-eval above produced. This is the placeholder-update path —
              // adding people to a Boston-week meeting came back "Huddle" because
              // the re-eval was travel-blind. Mirrors create/move. No-op off-trip,
              // and skipped on a bare explicit-`location` edit for the same reason
              // resolveLocation is above — the string is the venue, isOnline stays.
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getTravelContextForInstant } = require('../../../../utils/workingElsewhere') as
                  typeof import('../../../../utils/workingElsewhere');
                const tctx = getTravelContextForInstant(existing.startIso, context.profile);
                if (rePlaceVenue && tctx.isAway && tctx.location && isExternalNow === false) {
                  newLocationFromShape = tctx.location;
                  newIsOnlineFromShape = false;
                  logger.info('update_meeting — trip day, location → trip place', { location: tctx.location });
                }
              } catch (err) {
                logger.warn('update_meeting — travel-context location override threw', { err: String(err).slice(0, 160) });
              }
              // preserve_existing / ask_owner / room_unavailable — leave the
              // event's location alone. Category change still applies if any.
            } catch (err) {
              logger.warn('update_meeting — shape re-evaluation threw, applying attendee change without category/location update', {
                err: String(err).slice(0, 200),
              });
            }
          }
        }

        // v3.5.x — explicit location / is_online change ("update the location to
        // The Bosworth"). Graph's updateMeeting already supports it; this exposes
        // it on the tool. An explicit arg WINS over the shape-derived location
        // (which fires on an attendee add/remove that moved the shape, or on an
        // `is_online` venue change — an explicit `location` string alone, since
        // 2026-09-09, re-runs detectCategory but never resolveLocation, so there
        // is no derived venue or online-ness on that path at all). Both omitted →
        // undefined → the event's CURRENT location is preserved (a
        // subject/attendee change never wipes the venue).
        const explicitLocation = typeof args.location === 'string' && (args.location as string).trim()
          ? (args.location as string).trim()
          : undefined;
        const explicitIsOnline = typeof args.is_online === 'boolean' ? (args.is_online as boolean) : undefined;
        // v3.7.x (#A) — on a venue change TRUST the derived verdict (location +
        // online-ness from resolveLocation); the raw is_online flag no longer wins
        // (it was the misread), and a physical venue coexists with the Teams link.
        // Otherwise unchanged: an explicit `location` still wins, is_online=true
        // with no venue is still Teams-as-location, and omitting both preserves.
        //
        // 2026-09-07 — resolved into these two values ONCE, ahead of the write,
        // because the colleague rule gate below has to judge EXACTLY what the
        // PATCH will send. Re-deriving the same ternaries at the gate is how a
        // gate ends up blessing a different venue than the one that ships.
        let patchLocation: string | undefined = venueChangeRequested
          ? (newLocationFromShape ?? (explicitIsOnline === true ? '' : undefined))
          : (explicitIsOnline === true ? '' : (explicitLocation ?? newLocationFromShape));
        const patchIsOnline: boolean | undefined = venueChangeRequested
          ? (newIsOnlineFromShape ?? explicitIsOnline)
          : (explicitIsOnline ?? newIsOnlineFromShape);
        const patchCategory: string | undefined =
          (typeof args.category === 'string' && args.category.trim() ? args.category.trim() : undefined)
          ?? newCategoryFromShape;

        // 2026-09-07 — owner-direct venue change's room heads-up (see the
        // `else if` below). Declared here, in scope for the success return
        // far below, same shape as `attendeeEmailNotes`.
        let ownerRoomBusyNotice: string | undefined;

        // ── The owner's rules, re-checked for what this edit actually risks ──
        // Colleague path only — his own edits are his call (M8). See
        // `colleagueUpdateRuleGate` for the ruling behind this and for the list
        // of rules it deliberately does NOT re-impose.
        if (context.authority !== 'owner') {
          const gate = await colleagueUpdateRuleGate(args, ctx, {
            existing: existingEvent,
            categoryOverride: patchCategory,
            patchLocation,
            patchIsOnline,
            roomEmailAdded,
            participantCount: postEditParticipantCount,
          });
          if (gate.refusal) return gate.refusal;
          if (gate.roomSmallLabel) {
            // Room taken but the group fits the small space — planMeeting's
            // `room_busy_small_fits` outcome, applied here: swap the label and
            // drop the room mailbox again so nothing double-books the room.
            // `newLocationFromShape` too, so the narration below states the
            // venue that actually shipped.
            patchLocation = gate.roomSmallLabel;
            newLocationFromShape = gate.roomSmallLabel;
            const roomEmailLc = (context.profile.meetings.room_email ?? '').toLowerCase().trim();
            if (mergedAttendees && roomEmailLc) {
              mergedAttendees = mergedAttendees.filter(a => a.email.toLowerCase() !== roomEmailLc);
            }
          }
        } else if (roomEmailAdded && existingEvent?.startIso && existingEvent?.endIso) {
          // Owner-direct venue change — same probe, NO gate. Owner ruling
          // (2026-09-07): "well if it can check if room is free great its the
          // same busy/free as all other" — his override is total (M8), and
          // nothing here blocks him; it's a heads-up so he can decide, exactly
          // like every other availability check on his own booking (M8/M9/M16).
          //
          // Sharpened the SAME day, after the first pass here auto-swapped
          // the small-room label on his behalf: "it should be as other
          // people — when i want to book with yael maelle telling me heads up
          // yeal is busy, then i can decide or not." The model is the
          // ATTENDEE-busy heads-up, and it applies to the room too — so ALL
          // THREE outcomes now degrade to notice-and-proceed, never a silent
          // substitution: free → say nothing, room invited (unchanged); busy +
          // small group → tell him plainly the room's taken AND that the
          // small room is free, but do NOT rewrite the location — the venue
          // text stays exactly what he asked for, and he says "use the small
          // one" / "leave it" on his own next turn; busy + 6+
          // (`room_busy_too_big`) has no fallback to name, so it's the same
          // notice-and-proceed without one. Neither is an approval shape —
          // there's no one else to ask when he's the one acting (M8). Both
          // still drop the busy mailbox from the invite either way — inviting
          // a resource that's already busy would just get it declined, which
          // is a Graph-mailbox mechanic, not a decision being made for him.
          try {
            const { checkMeetingRoomAvailability } = await import('../../../../utils/meetingRoomAvailability');
            const roomVerdict = await checkMeetingRoomAvailability({
              profile: context.profile,
              startIso: existingEvent.startIso,
              endIso: existingEvent.endIso,
              participantCount: postEditParticipantCount ?? 0,
            });
            const roomEmailLc = (context.profile.meetings.room_email ?? '').toLowerCase().trim();
            if (roomVerdict.kind === 'room_busy_small_fits') {
              if (mergedAttendees && roomEmailLc) {
                mergedAttendees = mergedAttendees.filter(a => a.email.toLowerCase() !== roomEmailLc);
              }
              ownerRoomBusyNotice = `the meeting room is already taken then; ${roomVerdict.smallLabel} is free if he'd rather use that instead — updated without inviting the room or changing the location`;
              logger.info('update_meeting owner room check — room busy, small room free (notice only, no auto-swap)', {
                meetingId: args.meeting_id, smallLabel: roomVerdict.smallLabel, participantCount: postEditParticipantCount,
              });
            } else if (roomVerdict.kind === 'room_busy_too_big') {
              if (mergedAttendees && roomEmailLc) {
                mergedAttendees = mergedAttendees.filter(a => a.email.toLowerCase() !== roomEmailLc);
              }
              ownerRoomBusyNotice = 'the meeting room is already taken then and the group is too big for the small room — he\'ll need to grab space himself if he still wants it there';
              logger.info('update_meeting owner room check — room busy + group too large, proceeding without the room', {
                meetingId: args.meeting_id, participantCount: postEditParticipantCount,
              });
            }
          } catch (err) {
            // Fail open — same stance as planMeeting's own room check: an
            // unreadable room calendar proceeds with the invite as resolved;
            // Outlook will tell him if it actually conflicts.
            logger.warn('update_meeting owner room check threw, proceeding', { err: String(err).slice(0, 200) });
          }
        }

        await updateMeeting({
          userEmail,
          timezone,
          meetingId:  args.meeting_id  as string,
          subject:    args.new_subject as string | undefined,  // subjects allow " - " (owner direction)
          categories: patchCategory ? [patchCategory] : undefined,
          attendees: mergedAttendees,
          location: patchLocation,
          isOnline: patchIsOnline,
        });
        await closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'updated',
          subject: (args.new_subject as string | undefined) ?? (args.meeting_subject as string | undefined),
          bookingThreadTs: context.threadTs,
          fulfillingRequestId: args._fulfilling_request_id as string | undefined,
        });
        auditLog({
          ownerUserId: context.profile.user.slack_user_id,
          action: 'update_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          details: {
            subject: args.meeting_subject,
            category: args.category,
            new_subject: args.new_subject,
            // jim-douglass follow-up (2026-08-30) — RESOLVED addresses actually
            // invited, not the raw model-supplied ones (the directory or a
            // human-stated address may have overridden above). Mirrors the
            // success return's `added_attendees` (below); this sibling was
            // missed when that fix landed — an audit row that names an address
            // that was never actually invited.
            added_attendees: resolvedAddedEmails ?? rawAdd.map(a => a.email).filter(Boolean),
            removed_attendees: (args.remove_attendees as string[] | undefined),
            shape_recategorized: newCategoryFromShape ?? null,
            shape_relocated: newLocationFromShape ?? null,
          },
          outcome: 'success',
        });
        const updateChanges: string[] = [];
        if (args.new_subject) updateChanges.push(`renamed to '${args.new_subject}'`);
        if (args.category) updateChanges.push(`category set to ${args.category}`);
        if (rawAdd.length > 0) {
          // v3.7.2 — carry the EMAIL, not just a display name. A room mailbox's
          // name ("Meeting Room") reads as a VENUE, so the old summary "added Meeting
          // Room" was indistinguishable from a location change — the claim-checker
          // couldn't match it to a draft's "added meeting@…" and inverted a TRUE add
          // into "not added yet, confirm the address" (2026-07-15 Offensive Hub).
          const names = rawAdd
            .map(a => (a.email && a.name ? `${a.name} (${a.email})` : (a.email || a.name)))
            .filter(Boolean) as string[];
          updateChanges.push(`added ${names.join(', ')}`);
        }
        if (rawRemove.length > 0) {
          updateChanges.push(`removed ${rawRemove.join(', ')}`);
        }
        // Not "(attendee shape changed)": since 2026-09-09 an explicit venue
        // string re-classifies too, and the summary feeds the claim-checker.
        if (newCategoryFromShape) updateChanges.push(`category re-tagged ${newCategoryFromShape} (re-classified after the attendee/venue change)`);
        // v3.6.x — narrate EXPLICIT location / online changes too (not just the
        // shape-derived one), so action_summary — and therefore the claim-checker
        // — can verify a "moved to X" / "switched to online" claim instead of
        // seeing no evidence and flagging a done change as not-done. Explicit
        // wins over shape (matches the apply at updateMeeting above).
        if (explicitLocation) updateChanges.push(`location set to "${explicitLocation}"`);
        else if (newLocationFromShape !== undefined) updateChanges.push(`location updated to "${newLocationFromShape}"`);
        // v3.7.x (#A) — narrate the APPLIED online-ness, not the raw flag. On a venue
        // change the derived verdict wins (a Meeting Room keeps Teams → isOnline=true),
        // so a raw is_online=false must NOT read as "switched to in-person" — it's
        // hybrid (room + Teams), and the location line already states the venue.
        const summaryIsOnline = venueChangeRequested ? (newIsOnlineFromShape ?? explicitIsOnline) : explicitIsOnline;
        if (summaryIsOnline === false) updateChanges.push('switched to in-person');
        else if (explicitIsOnline === true) updateChanges.push('switched to online');
        // gh#wrong-event-moved-move-meeting (2026-08-12) — narrate off the
        // PROBED real subject, not the caller's claim: updateProbeSubject is
        // only ever set once the plausibility check above has already passed
        // (or the probe genuinely couldn't run, in which case the claim is all
        // there is). Prevents a misresolved event from ever narrating as if
        // the claimed meeting was the one actually touched.
        // o#216 (bouncer fix) — updateProbeSubject is already MASKED (see the
        // probe block above), so this narration — update_meeting is
        // colleague-allowed — can never render a private meeting's real title.
        const updatedSubject = (updateProbeSubject ?? args.meeting_subject) as string | undefined;
        return {
          success: true,
          updated: updatedSubject,
          category: args.category ?? newCategoryFromShape ?? null,
          new_subject: args.new_subject ?? null,
          // jim-douglass follow-up (2026-08-30) — the RESOLVED addresses
          // actually invited, not the raw model-supplied ones (which the
          // directory may have overridden above).
          added_attendees: resolvedAddedEmails ?? rawAdd.map(a => a.email).filter(Boolean),
          removed_attendees: rawRemove,
          // v1.8.3 — past-tense summary for owner-visible reply. Issue #26 bug 1.
          action_summary: `Updated '${updatedSubject}'${updateChanges.length > 0 ? ': ' + updateChanges.join(', ') : ''}.`,
          ...(attendeeEmailNotes.length > 0
            ? { _attendee_email_note: `Attendee address resolution differed from the tool input — state the actual invited address(es) in the reply, never silently: ${attendeeEmailNotes.join(' ')}` }
            : {}),
          // 2026-09-07 — owner-direct venue change, room busy (either
          // fallback size). Notice, not a gate (M8) — say it plainly (M9)
          // rather than silently inviting a mailbox that will decline, or
          // silently rewriting the venue for him. Rides the SAME channel as
          // the attendee-busy heads-up (`_attendee_busy_note`, used elsewhere
          // in this file and in create_meeting) rather than a parallel field:
          // his ruling was "it should be as other people" — same mechanism,
          // tell him, he decides — and that channel already legitimately
          // carries non-attendee content (planMeeting's joined
          // `overrideNotice`, which this same file's move_meeting success
          // return surfaces through this identical field, can itself be a
          // room clash). A second field would just be invisible to the same
          // grounding the first already gets (turnHelpers.ts's
          // attendeeCheckSource only recognises `_attendee_busy_note` /
          // `override_notice` by name).
          ...(ownerRoomBusyNotice
            ? { _attendee_busy_note: `Heads up — ${ownerRoomBusyNotice}. His call is total — say it plainly, don't re-ask permission.` }
            : {}),
        };
}

export async function handleMoveMeeting(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
  // confirm-success-return-does-not-name-who-was-booked-over (2026-09-09) —
  // set by the colleague-path attendee-conflict Guard below on a confirmed
  // move-over; read by the SUCCESS return far below to carry the same
  // `_attendee_busy_note` marker create_meeting's success path now does.
  let bookedOverAttendees: AttendeeConflictTag[] = [];
        // move-meeting-bare-subject-lookup-same-ambiguity-class (2026-08-14) —
        // move_meeting's own same-subject-collision guard. Unconditional for
        // colleague-path — move has no optional field to gate on; every
        // colleague move resolves a meeting_id off a bare reference. (Was
        // also the only unconditional one until 2026-09-07, when
        // update_meeting's own gate widened to match — see its call site.)
        // Shared with update_meeting via checkSameSubjectCollision above
        // (extracted 2026-08-14) — see that function's header for the full
        // rationale, including the series-membership fix for a recurring
        // "move our weekly".
        {
          const collision = await checkSameSubjectCollision(args, ctx, { toolName: 'move_meeting', actionPhrase: 'moving it' });
          if (collision) return collision;
        }

        // v3.5.x (WE time spine) — the SAME single resolver as create_meeting (see
        // its block for the full rationale). On a WE day a BARE new_start the owner
        // typed is trip-LOCAL; a zone he named (`stated_zone`/start_timezone) wins;
        // an offset-tagged new_start is a fixed instant, left as-is. moveTripDisplay
        // is kept only for the dual-clock narration.
        let moveTripDisplay: { tz: string; location: string } | null = null;
        if (typeof args.new_start === 'string') {
          try {
            const { getTravelContextForInstant } = await import('../../../../utils/workingElsewhere');
            let travel = getTravelContextForInstant(args.new_start, context.profile);
            const statedZone = statedZoneFromArgs(args);
            const resolved = resolveStatedInstant({
              startIso: args.new_start,
              endIso: typeof args.new_end === 'string' ? args.new_end : undefined,
              statedZone, travel, homeTz: timezone, profile: context.profile,
              emailRoute: context.channel === 'email',
              ...(['CST', 'IST'].includes(statedZone?.toUpperCase() ?? '') ? { personTimezone: statedClockPersonContext(args, context.profile, args.new_start) } : {}),
            });
            travel = getTravelContextForInstant(resolved.startIso, context.profile);
            if (travel.isAway) moveTripDisplay = { tz: travel.effectiveTz, location: travel.location };
            if (resolved.reinterpreted) {
              logger.info('move_meeting — stated time resolved to canonical instant', {
                statedZone: statedZone ?? '(none)', sourceZone: resolved.sourceZone,
                newStartWas: args.new_start, newStartNow: resolved.startIso, isAway: travel.isAway,
              });
            }
            args.new_start = resolved.startIso;
            if (resolved.endIso) args.new_end = resolved.endIso;
          } catch (err) {
            if (err instanceof StatedTimeClarificationError) return err.toToolResult();
            logger.warn('move_meeting — WE time resolve threw, using time as-is', { err: String(err).slice(0, 160) });
          }
        }
        // #135c / v1.8.8 / gh#wrong-event-moved-move-meeting (2026-08-12) — ONE
        // unconditional probe of the moving event, run BEFORE any colleague-path
        // business logic and well before the Graph PATCH at the bottom of this
        // function. Three jobs off the single fetch: (a) refuse a seriesMaster
        // move (v1.8.8 — moving the series here would shift every occurrence),
        // (b) refuse when the id resolves to a REAL subject that does not
        // plausibly match the CLAIMED args.meeting_subject — the
        // wrong-event-moved root cause: a prior search (find_available_slots)
        // handed back an id for a DIFFERENT event ("Donnie Time", a personal
        // block) than the one being searched for ("Yael & Idan Weekly"), and
        // nothing before this checked the id and the claim described the same
        // meeting before the PATCH mutated the wrong one and Maelle narrated it
        // as a success regardless. Unconditional — every authority; this is
        // Maelle's OWN id-resolution mistake, not the colleague-disambiguation
        // case findSameSubjectSiblings guards elsewhere in this file (gated to
        // colleague-path only, for the different failure mode of two live
        // events sharing one subject). (c) derives new_end from the existing
        // duration when the model omitted it (#135c) — one fetch instead of
        // two. preMoveStartIso/preMoveEndIso/preMoveSubject feed the
        // success narration and the audit/history rows further down.
        // preMoveSubject is already MASKED (see below) so that narration can
        // never render a private meeting's real title.
        // (bouncer objection 3, 2026-08-12) — FAIL-OPEN, stated plainly: if
        // the probe throws (transient Graph fault), BOTH the seriesMaster
        // refusal AND the wrong-event subject-mismatch guard are skipped for
        // this call, not just the seriesMaster check — preMoveSubject stays
        // undefined and `movedSubject` further down falls back to narrating
        // the caller's unverified args.meeting_subject claim, i.e. the exact
        // original incident behavior for this one call. Accepted trade-off
        // (failing closed on every transient read error has its own cost:
        // every move_meeting would refuse whenever Graph blips) — not
        // silent; see the catch below.
        let preMoveStartIso: string | undefined;
        let preMoveEndIso: string | undefined;
        let preMoveIsAllDay: boolean | undefined;
        let preMoveEventType: string | undefined;
        let preMoveSubject: string | undefined;
        // revert-intent-and-single-step-undo-scope, piece 4 (2026-08-12) —
        // the moving event's own roster, captured off the SEPARATE
        // getEventForAttendeeUpdate probe below (moveAttendees, planMeeting's
        // own fetch — no extra Graph call) into this outer scope so the
        // logActivity call far below can resolve a target identity from it.
        let preMoveAttendeeEmails: string[] = [];
        {
          let moveProbe: Awaited<ReturnType<typeof import('../../../../connectors/graph/calendar').getEventType>> | undefined;
          try {
            const { getEventType } = await import('../../../../connectors/graph/calendar');
            moveProbe = await getEventType(userEmail, args.meeting_id as string);
          } catch (err) {
            logger.warn('move_meeting recurring-preflight failed — proceeding (seriesMaster check AND wrong-event subject-mismatch guard both skipped for this call)', { err: String(err) });
          }
          // o#216 (bouncer fix, 2026-08-12) — mask the probed subject ONCE, off
          // the raw Graph value, before it reaches ANY caller-facing payload
          // below: the seriesMaster refusal, the mismatch refusal, and
          // preMoveSubject (→ the success narration) all share this one masked
          // value now — move_meeting is colleague-allowed, and pre-fix only the
          // seriesMaster branch masked; the mismatch refusal and the success
          // narration shipped the raw title.
          // gh#154-W5/gh#154-R4 (2026-08-06) — room-tightening lives inside
          // viewerEmailFor now (surface==='room' → null); call directly —
          // a blanket ?? null here also masked the email leg's subjects.
          const maskedMoveProbeSubject = moveProbe
            ? displaySubject(
                { subject: moveProbe.subject, sensitivity: moveProbe.sensitivity, categories: moveProbe.categories, organizer: moveProbe.organizer, attendees: moveProbe.attendees },
                context.profile,
                subjectViewerFor(context),
                viewerEmailFor(context),
              )
            : undefined;
          if (moveProbe?.type === 'seriesMaster') {
            logger.info('move_meeting refused on recurring seriesMaster', {
              meetingId: args.meeting_id,
              subject: moveProbe.subject,
            });
            return {
              error: 'recurring_series_master',
              meeting_subject: maskedMoveProbeSubject,
              message: `"${maskedMoveProbeSubject}" is a recurring series. Moving the series here would shift every occurrence — the owner should do series-level moves directly in the calendar. For a SINGLE occurrence, call move_meeting with that occurrence's meeting_id from get_calendar for that specific date; Graph will create an exception for that one.`,
            };
          }
          if (moveProbe?.subject && typeof args.meeting_subject === 'string'
              && !subjectsPlausiblyMatch(args.meeting_subject, moveProbe.subject)) {
            logger.warn('move_meeting — meeting_id resolved to a subject that does not match the claim, refusing to guess', {
              meetingId: args.meeting_id, claimedSubject: args.meeting_subject, actualSubject: moveProbe.subject,
            });
            return {
              success: false,
              error: 'meeting_id_subject_mismatch',
              meeting_subject: args.meeting_subject,
              // o#216 (bouncer fix) — masked, not the raw moveProbe.subject:
              // this refusal is exactly as colleague/room-reachable as the
              // seriesMaster refusal above, which already masks.
              actual_subject: maskedMoveProbeSubject,
              message: `The id given for "${args.meeting_subject}" actually points to a different event on the calendar ("${maskedMoveProbeSubject}") — I won't move the wrong meeting. Re-read the calendar (get_calendar) to find the real id for "${args.meeting_subject}" and retry.`,
            };
          }
          preMoveStartIso = moveProbe?.startDateTime;
          preMoveEndIso = moveProbe?.endDateTime;
          preMoveIsAllDay = moveProbe?.isAllDay;
          preMoveEventType = moveProbe?.type;
          preMoveSubject = maskedMoveProbeSubject;
        }
        // #135c — pure reschedule keeps the meeting's length. When the model
        // omits new_end (it should, on a plain "move it to Thursday 11:00"),
        // derive it from the moving event's existing duration read just above —
        // so the model never has to supply (or re-ask the owner for) a length
        // it already knows. 30-min fallback when the probe above didn't
        // resolve start/end (unreadable / threw).
        if ((typeof args.new_end !== 'string' || (args.new_end as string).length === 0) && typeof args.new_start === 'string') {
          let durMin = 30;
          if (preMoveStartIso && preMoveEndIso) {
            const s0 = DateTime.fromISO(preMoveStartIso, { zone: timezone });
            const e0 = DateTime.fromISO(preMoveEndIso, { zone: timezone });
            if (s0.isValid && e0.isValid && e0.toMillis() > s0.toMillis()) durMin = Math.round(e0.diff(s0, 'minutes').minutes);
          }
          args.new_end = DateTime.fromISO(args.new_start as string, { zone: timezone }).plus({ minutes: durMin }).toISO() ?? (args.new_start as string);
          logger.info('move_meeting — derived new_end from existing duration (new_end omitted)', {
            meetingId: args.meeting_id, durMin, new_end: args.new_end,
          });
        }

        // v2.2.1 — colleague-path rule-compliance gate. When an inbound colleague
        // DM asks Maelle to move an existing meeting, she can do it autonomously
        // IF the new slot fits the owner's rules (work hours, work days, buffers,
        // floating blocks, no conflicts). If the new slot breaks a rule, the tool
        // refuses and signals needs_owner_approval WITH a _deferred_action_hint —
        // Sonnet raises create_approval(kind=policy_exception), the orchestrator
        // stamps the deferred move, and owner-approve replays it. Owner-path callers
        // skip this check (owner override IS the approval).
        //
        // o#221/o#223 — gated on AUTHORITY, not senderRole. senderRole reads
        // 'colleague' both for a genuine colleague AND for the AUTHENTICATED
        // owner clamped into a room (processMessage.ts:123), so this whole
        // "can this asker move THIS meeting" gate — built for a colleague's
        // own move request — used to fire for the owner's move-in-room too.
        // He is never a required Graph attendee of his own meetings
        // (createMeeting.ts strips the owner from the attendee list) and is
        // rarely his own meeting's "requester", so the gate fell through to
        // requester_move_needs_owner — asking him to raise an approval to
        // himself. Worse, it returned before planMove (below) ever ran, so
        // the ownerRoomBend-aware escalate_approval path built for exactly
        // this case (planMeeting.ts's PlanMeetingInput.ownerRoomBend) never
        // executed either. Same fix as resolve_approval's authority gate
        // (tasks/skill.ts:2019): the owner keeps his move authority on every
        // surface (M8); only a genuine colleague needs this membership/rule
        // check.
        if (context.authority !== 'owner') {
          // v3.5.x — colleague-requested move gate (replaces the v3.1.4
          // requester-controls gate). Maelle organizes every meeting, so the old
          // "is the asker the REQUESTER?" test resolved to the owner ~every time
          // and escalated EVERY colleague move (Ysrael's clean 15:30→14:00 still
          // pinged the owner). Right axis: a colleague may move a meeting on their
          // own ONLY IF (1) they're a REQUIRED attendee, (2) every OTHER required
          // attendee is free at the new slot, (3) it fits the owner's rules. Else
          // escalate with the SPECIFIC reason. Owner-path skips this whole block —
          // owner override IS the approval (he can move over anyone).
          const ownerFirst = context.profile.user.name.split(' ')[0];
          const ownerEmailLc = userEmail.toLowerCase();

          // Load the meeting's REQUIRED attendees once — reused for the membership
          // check (step 1) AND the other-attendee free/busy check (step 2). Same
          // Graph helper update_meeting uses.
          let requiredAttendees: Array<{ name?: string; email: string }> = [];
          let attendeesLoaded = false;
          try {
            const ev = await getEventForAttendeeUpdate(userEmail, args.meeting_id as string);
            if (ev) {
              requiredAttendees = (ev.attendees ?? [])
                .filter(a => !a.optional)
                .map(a => ({ name: a.name, email: a.email.toLowerCase() }));
              attendeesLoaded = true;
            }
          } catch (err) {
            logger.warn('move_meeting colleague gate — attendee load threw', { err: String(err).slice(0, 200) });
          }

          // Resolve the asker's email/name (the invite lists emails; match the
          // asker's slack_id → email via people_memory).
          let askerEmail: string | undefined;
          let askerName: string | undefined;
          try {
            const { getPersonMemory } = await import('../../../../db/people');
            const pm = getPersonMemory(context.userId);
            askerEmail = pm?.email?.toLowerCase() || undefined;
            askerName = pm?.name || undefined;
          } catch (_) { /* treated as non-member below */ }
          const askerFirst = askerName?.split(/\s+/)[0] ?? 'they';

          // Couldn't read the invite → don't guess; let the owner decide.
          if (!attendeesLoaded) {
            return {
              needs_owner_approval: true,
              reason: 'attendee_check_failed',
              meeting_subject: args.meeting_subject,
              requested_start: args.new_start,
              requested_end: args.new_end,
              message: `I couldn't read who's on "${args.meeting_subject}" to check whether ${askerFirst} can move it. Raise create_approval(kind=policy_exception) so ${ownerFirst} decides.`,
              // #2.1b / Approval-A — stamp the deferred move so owner-approve REPLAYS it
              // (policy_exception-gated auto-attach). Without this the approval applied nothing.
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
            };
          }

          // Step 1 — the asker must be a REQUIRED attendee of the meeting.
          const askerIsRequired = !!askerEmail && requiredAttendees.some(a => a.email === askerEmail);
          if (!askerIsRequired) {
            // v3.7.x (#141) — a non-attendee can still act on a meeting THEY
            // REQUESTED (booked through Maelle): route it to the owner's approval,
            // exactly like a cancel does ("if you can ask to book it, you can ask
            // to move it"). A non-attendee who did NOT request it gets a clean
            // decline — never a leak about the owner's calendar, never bothering
            // him with someone else's meeting. This is the #141 fix: move becomes
            // consistent with cancel instead of an inconsistent flat refusal.
            let askerIsRequester = false;
            try {
              const { findMeetingOwner } = await import('../../findMeetingOwner');
              const mo = await findMeetingOwner({
                ownerUserId: context.profile.user.slack_user_id,
                ownerEmail: userEmail,
                eventId: args.meeting_id as string,
              });
              askerIsRequester = !!mo.requesterSlackId && mo.requesterSlackId === context.userId;
            } catch (err) {
              logger.warn('move_meeting — requester lookup threw', { err: String(err).slice(0, 160) });
            }
            if (!askerIsRequester) {
              logger.info('move_meeting — asker is neither attendee nor requester → clean decline', {
                meetingId: args.meeting_id, asker: context.userId,
              });
              return {
                success: false,
                error: 'not_your_meeting',
                message: `That's not a meeting you're in or one you set up, so I can't move it for you — best to ask ${ownerFirst} directly.`,
              };
            }
            logger.info('move_meeting — asker is the requester (not an attendee) → escalate to owner approval', {
              meetingId: args.meeting_id, asker: context.userId,
            });
            return {
              needs_owner_approval: true,
              reason: 'requester_move_needs_owner',
              meeting_subject: args.meeting_subject,
              requested_start: args.new_start,
              requested_end: args.new_end,
              message: `${askerName ?? 'They'} asked to move "${args.meeting_subject}", which they set up with ${ownerFirst}. Raise create_approval(kind=policy_exception) so ${ownerFirst} confirms the new time.`,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
            };
          }
          // Step 1.5 — every OTHER required attendee must be INTERNAL so we can
          // actually verify their availability. An external attendee (client /
          // partner, different domain) can't be read cross-tenant — getFreeBusy
          // returns an empty (= "free all week") result for them, so step 2 would
          // pass them blindly. Moving a meeting that involves outside people is
          // high-stakes, so we never auto-move it: escalate to the owner with the
          // external attendee named.
          const ownerDomain = ownerEmailLc.includes('@') ? ownerEmailLc.split('@')[1] : '';
          const externalRequired = requiredAttendees.filter(a =>
            a.email !== ownerEmailLc
            && a.email !== askerEmail
            && (!ownerDomain || !a.email.endsWith('@' + ownerDomain)));
          if (externalRequired.length > 0) {
            const names = externalRequired.map(a => a.name?.split(/\s+/)[0] ?? a.email).join(', ');
            logger.info('move_meeting — external required attendee(s), availability unverifiable → escalate', {
              meetingId: args.meeting_id, external: externalRequired.map(a => a.email),
            });
            return {
              needs_owner_approval: true,
              reason: 'external_attendee_unverifiable',
              meeting_subject: args.meeting_subject,
              requested_start: args.new_start,
              requested_end: args.new_end,
              message: `${askerName ?? 'They'} asked to move "${args.meeting_subject}", but it has external attendee(s) whose availability I can't check (${names}) — moving a meeting with outside people needs ${ownerFirst}. Raise create_approval(kind=policy_exception) and note the external attendee(s).`,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
            };
          }

          const newStart = args.new_start as string | undefined;
          const newEnd = args.new_end as string | undefined;
          if (newStart && newEnd) {
            try {
              const startDt = DateTime.fromISO(newStart, { zone: timezone });
              const endDt = DateTime.fromISO(newEnd, { zone: timezone });
              if (startDt.isValid && endDt.isValid) {
                const durationMin = Math.max(5, Math.round((endDt.toMillis() - startDt.toMillis()) / 60_000));
                const { findAvailableSlots } = await import('../../../../connectors/graph/calendar');
                const startMs = startDt.toMillis();
                // v2.6.1 — pass exact requested window. See the parallel comment
                // in create_meeting Guard B for the full reasoning (±60s padding
                // lands the cursor outside work-hours boundaries by one minute,
                // and the slot is never tested).
                const fromIso = startDt.toUTC().toISO();
                const toIso = endDt.toUTC().toISO();
                let validSlots: Array<{ start: string; attendee_conflicts?: AttendeeConflictTag[] }> = [];
                const diagnostics: { rejectedCounts?: Partial<Record<SearchRejectReason, number>>; rejectedExamples?: Partial<Record<SearchRejectReason, string[]>> } = {};
                // v3.5.x (step 2) — check the OTHER required attendees too: everyone
                // required EXCEPT the owner (checked via userEmail) and the asker (whose
                // own busy doesn't block their own request). attendeeCheckParams passes
                // their busy + work-hours/tz, so the walker can tag WHO the new time
                // doesn't work for.
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { attendeeCheckParams } = require('../../../../utils/attendeeAvailability') as
                  typeof import('../../../../utils/attendeeAvailability');
                // 2026-09-06 owner ruling — an ATTENDEE conflict is the
                // REQUESTER's call, never an owner escalation; the ruling and
                // the refusal shape are written down ONCE, in
                // ops/violationLabels.ts's `attendeeConflictRefusal`. The list
                // below is the full one on EVERY call including the confirm
                // retry: `tagAttendeeConflicts` keeps the slot and tags EVERY
                // blocked attendee, so the confirm changes exactly one thing —
                // we move anyway — and never what gets checked. Emptying it on
                // the retry (as this first shipped) told the requester about one
                // person and then moved over everyone.
                const attendeeConflictConfirmed = args.confirm_attendee_conflict === true;
                const moveCheckAttendees = requiredAttendees
                  .map(a => a.email)
                  .filter(e => e !== ownerEmailLc && e !== askerEmail);
                // move-check-attendee-no-stated-zone-must-not-be-skipped
                // (2026-09-06, owner ruling) — pass the owner's TZ as the #M3
                // fallback, exactly as find_available_slots does
                // (findAvailableSlots.ts:935). Without a fallback,
                // loadAttendeeAvailabilityForEmails silently `continue`s past
                // any attendee with no stored people_memory timezone
                // (attendeeAvailability.ts:200-201) — dropped from the
                // work-hours clip entirely, so an off-hours move went through
                // unflagged. The `assumed` flag that fallback sets rides out on
                // the conflict tag itself (findAvailableSlots.ts), so the
                // sentence the requester hears hedges an assumed zone without
                // this handler re-reading the availability list.
                if (fromIso && toIso) {
                  validSlots = await findAvailableSlots({
                    userEmail,
                    timezone,
                    durationMinutes: durationMin,
                    ...attendeeCheckParams(moveCheckAttendees, userEmail, timezone),
                    // Attendee conflicts TAG, never drop (rule 6 / M16): the
                    // slot comes back carrying everyone it doesn't work for, so
                    // a missing slot means an OWNER rule and nothing else.
                    tagAttendeeConflicts: true,
                    allowAttendeeOffHours: true, // exact requested move, not a general offer
                    searchFrom: fromIso,
                    searchTo: toIso,
                    profile: context.profile,
                    // v2.6 — pass category so move_meeting colleague-path also
                    // enforces day_type / per_day / per_week limits at
                    // the destination. findAvailableSlots widens its event
                    // fetch when category is set so day/week counts are
                    // accurate.
                    category: args.category as string | undefined,
                    // move-meeting-counts-the-moving-event-against-its-own-per-day-cap
                    // (2026-09-01) — the event being moved must never count
                    // against its own destination-day cap: a same-day move
                    // read 3 as 4 and was refused with `category_per_day` for
                    // a count that never actually changed. Owner ruling:
                    // unconditional, not same-day-only — a cross-day move also
                    // vacates its old day, same as autoMove.ts already assumes
                    // at its four `excludeEventIds: [movable.id]` call sites.
                    excludeEventIds: [args.meeting_id as string],
                    diagnosticsOut: diagnostics,
                    // v3.0.6 — single-slot validation; see the parallel comment
                    // in create_meeting Guard B. Auto-expand would re-query the
                    // calendar at widening ranges for slots that get discarded
                    // (matches checks ±60s of newStart). Disable.
                    autoExpand: false,
                  });
                }
                const matched = validSlots.find(s => Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000);
                // The new time is rule-clean for the OWNER but doesn't work for
                // one or more of the other attendees. TAG mode guarantees this
                // list is everyone (findAvailableSlots.ts), so the requester
                // hears about ALL of them in one sentence — and the confirm
                // retry re-runs the identical check, so what it moves over is
                // what she was told (see attendeeConflictRefusal's doc for the
                // one residual case).
                const attendeeConflicts = matched?.attendee_conflicts ?? [];
                if (matched && attendeeConflicts.length > 0) {
                  if (!attendeeConflictConfirmed) {
                    logger.info('move_meeting colleague-path — attendee conflict surfaced to requester, no owner escalation', {
                      meetingId: args.meeting_id, newStart, newEnd, requester: context.userId,
                      blocked: attendeeConflicts.map(c => `${c.email}:${c.reason}`),
                    });
                    return {
                      ...attendeeConflictRefusal(attendeeConflicts, viewerEmailFor(context), 'move'),
                      meeting_subject: args.meeting_subject,
                      requested_start: newStart,
                      requested_end: newEnd,
                    };
                  }
                  // confirm-success-return-does-not-name-who-was-booked-over —
                  // carried to the SUCCESS return's own `_attendee_busy_note`
                  // at the bottom of this handler, not just this log line.
                  bookedOverAttendees = attendeeConflicts;
                  // M18 — the requester's confirmed move-over, named and queryable.
                  logger.info('move_meeting colleague-path — moving over attendee conflicts the requester confirmed', {
                    meetingId: args.meeting_id, newStart, newEnd, requester: context.userId,
                    blocked: attendeeConflicts.map(c => `${c.email}:${c.reason}`),
                  });
                }
                if (!matched) {
                  // Surface the SPECIFIC blocker so the approval tells the
                  // owner — and, downstream, the requester — exactly why. Every
                  // reason reaching here is an OWNER-rule violation: in TAG mode
                  // no attendee-side check can drop a slot, so an attendee-scoped
                  // reason can't appear in these diagnostics.
                  // THE shared humanizer (ops/violationLabels). This was the last
                  // inline copy of the switch: it never learned the six reasons
                  // 4.2.0 added, so a Friday target, a past target and a
                  // travel-buffer rejection all humanized to 'unknown' and the
                  // colleague was told "it doesn't pass his scheduling rules and I
                  // can't tell which one" — the mechanical non-answer M9 forbids.
                  const labelFor = (reason: SearchRejectReason | undefined): string =>
                    humanizeViolationLabel(reason, ownerFirst);
                  const brokenRule = firstRejectReason(diagnostics.rejectedCounts);
                  const reasonCode = HANDLER_ERROR_CODE.NOT_RULE_COMPLIANT;
                  const humanReason = labelFor(brokenRule);
                  logger.info('move_meeting colleague-path refused — new slot blocked', {
                    meetingId: args.meeting_id, newStart, newEnd, requester: context.userId,
                    broken_rule: brokenRule ?? 'unknown', reason_code: reasonCode, human_reason: humanReason,
                  });
                  return {
                    needs_owner_approval: true,
                    reason: reasonCode,
                    broken_rule: brokenRule ?? 'unknown',
                    broken_rule_label: humanReason,
                    meeting_subject: args.meeting_subject,
                    requested_start: newStart,
                    requested_end: newEnd,
                    message: humanReason === 'unknown'
                      ? `${askerName ?? 'They'} asked to move "${args.meeting_subject}" to that time, but it doesn't pass ${ownerFirst}'s scheduling rules and I can't tell which one. Call create_approval(kind=policy_exception) and let him decide.`
                      : `${askerName ?? 'They'} asked to move "${args.meeting_subject}" to that time, but ${humanReason}. I can't do it on my own — call create_approval(kind=policy_exception) and pass "${humanReason}" in ask_text so ${ownerFirst} knows what he's deciding.`,
                    _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
                  };
                }
              }
            } catch (err) {
              // An unreadable calendar is not a "couldn't verify, he decides"
              // case: the owner would be approving a move nobody can validate.
              // Falls through to the offline refusal at the tool surface.
              if (err instanceof CalendarOfflineError) throw err;
              logger.warn('move_meeting colleague-path rule check threw — escalating to approval', { err: String(err) });
              return {
                needs_owner_approval: true,
                reason: 'rule_check_failed',
                meeting_subject: args.meeting_subject,
                requested_start: newStart,
                requested_end: newEnd,
                message: `I couldn't verify whether that slot fits ${context.profile.user.name.split(' ')[0]}'s rules right now. Raise create_approval(kind=policy_exception) so he can decide.`,
                _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              };
            }
          }
        }

        // v2.1.4 — same attendee-only guard as update_meeting.
        // v2.7.0 — ownership check via findMeetingOwner (requests + Graph).
        // When owner isn't organizer, refuse politely. No DM, no
        // propose-reschedule — just tell the asker it's not the owner's to move.
        // OT-4 (bouncer fix, gh#52) — this same findMeetingOwner call already
        // resolves "who this meeting is with" (the original requester if
        // booked through Maelle, else the organizer backfilled to a slack_id)
        // — captured here for the logActivity call below, rather than a new
        // lookup or a guess among possibly-many attendees. Excludes the owner's
        // own id (his solo/self-organized meetings have no single "other
        // colleague" and stay null, honestly).
        let meetingConcernsSlackId: string | undefined;
        // revert-intent-and-single-step-undo-scope, piece 4 (2026-08-12) — the
        // display name paired with meetingConcernsSlackId, when findMeetingOwner
        // resolved one; feeds resolveActivityTargetIdentity's `preferred` below
        // so the more precise requester-resolution signal is never overridden
        // by a weaker roster guess.
        let meetingConcernsName: string | undefined;
        try {
          const { findMeetingOwner } = await import('../../findMeetingOwner');
          const ownerInfo = await findMeetingOwner({
            ownerUserId: context.profile.user.slack_user_id,
            ownerEmail: userEmail,
            eventId: args.meeting_id as string,
          });
          if (ownerInfo.requesterSlackId && ownerInfo.requesterSlackId !== context.profile.user.slack_user_id) {
            meetingConcernsSlackId = ownerInfo.requesterSlackId;
            meetingConcernsName = ownerInfo.requesterName ?? undefined;
          }
          if (!ownerInfo.ownerIsOrganizer && ownerInfo.organizerEmail) {
            logger.info('move_meeting refused — owner is attendee, not organizer', {
              meetingId: args.meeting_id, organizer: ownerInfo.organizerEmail,
            });
            return notOrganizerRefusal({
              subject: args.meeting_subject,
              ownerFullName: context.profile.user.name,
              organizerName: ownerInfo.organizerName,
              organizerEmail: ownerInfo.organizerEmail,
            });
          }
        } catch (err) {
          logger.warn('move_meeting ownership lookup threw — proceeding', { err: String(err) });
        }

        // v3.1.8 — capture the meeting's OLD start so the success result can
        // report the VACATED slot (the time that just opened up). Lets a
        // follow-up "move X into the freed slot" resolve without Maelle
        // re-asking what time the moved meeting used to be at.
        // #52 (M1) — pre-state for the audit row. getEventType normalizes
        // Graph's separate wall-clock+zone pair into offset-bearing instants at
        // the read boundary, so every consumer below shares one interpretation.
        // gh#wrong-event-moved-move-meeting (2026-08-12) — this used to be its
        // own probe + seriesMaster check, run AFTER the colleague-path gate and
        // ownership lookup above. It's now folded into the single unconditional
        // probe near the top of this function (before ANY of that business
        // logic runs on what might be the wrong event) — preMoveStartIso/
        // preMoveEndIso/preMoveSubject are already populated from it.

        // v2.3.1 (#61) — deterministic floating-block alignment. When the
        // meeting being moved is a floating block (lunch, coffee, etc.), don't
        // trust args.new_start verbatim — Sonnet keeps doing time math in
        // chat and getting it wrong (window check, buffer, alignment). Run
        // findBlockDestination with args.new_start as a HINT to compute
        // the correct slot; if no in-window slot fits, refuse with a clear
        // pointer to policy_exception (deferred_action move_meeting). Owner-
        // directed moves no longer ask permission for in-window adjustments
        // — code computes the right answer once.
        // #135b — weekday/date sanity (shared with create_meeting). Refuse a move
        // whose resolved new_start weekday contradicts the weekday the owner named
        // ("return it to Thursday" that resolved to a Friday — the wrong-day
        // write), handing back the corrected same-week date to retry with.
        {
          const wk = checkIntendedWeekday(args.new_start as string | undefined, args.intended_weekday as number | undefined, timezone);
          if (!wk.ok) {
            const namedName = DateTime.fromISO(wk.correctedStartIso, { zone: timezone }).toFormat('EEEE');
            const resolvedName = DateTime.fromISO(args.new_start as string, { zone: timezone }).toFormat('EEEE');
            const correctedDate = DateTime.fromISO(wk.correctedStartIso, { zone: timezone }).toFormat('yyyy-MM-dd');
            logger.warn('move_meeting — weekday/date mismatch, refusing wrong-day write', {
              namedWeekday: wk.namedWeekday, resolved: wk.resolvedDate, corrected: wk.correctedStartIso,
            });
            return {
              success: false,
              error: 'weekday_date_mismatch',
              meeting_subject: args.meeting_subject,
              corrected_start: wk.correctedStartIso,
              message: `new_start resolves to ${wk.resolvedDate} (a ${resolvedName}), but this was described as a ${namedName}. The ${namedName} of that week is ${correctedDate}. Re-issue move_meeting with new_start=${wk.correctedStartIso} (same time, corrected day). If a DIFFERENT week was actually meant, resolve the right ${namedName} from the date list and retry — never move to the mismatched day.`,
            };
          }
        }

        let effectiveStart = args.new_start as string;
        let effectiveEnd   = args.new_end   as string;
        // WE-fallback-surfacing parity (2026-08-28 bouncer finding) — the
        // colleague-path block-snap below is the third of three surfaces
        // that thread `usedWorkingElsewhereFallback` (check_join_availability
        // in meetings.ts and rebalanceFloatingBlocks' own shadowNotify are
        // the other two); this used to only `logger.info` it, never telling
        // a human. Set when the destination search below only found a slot
        // against a WE block, read at the final success return.
        let moveUsedWorkingElsewhereFallback = false;
        // Grid-align an off-grid move target unless the owner named it exactly
        // OR this conversation's scheduling tool offered that exact instant.
        // A later approval binds to structured offer state; it must not turn an
        // approved 17:25 into 17:30. Floating blocks still use their own window
        // placement below.
        const offeredStart = context.channelId
          ? (await import('../../../../utils/offeredSlotsStash')).wasOfferedSlot(context.channelId, context.threadTs, effectiveStart)
          : false;
        if (!args.start_is_explicit && !offeredStart && typeof effectiveStart === 'string') {
          const sDt = DateTime.fromISO(effectiveStart, { zone: timezone });
          if (sDt.isValid) {
            const alignedMs = alignNearestQuarter(sDt.toMillis(), timezone);
            if (alignedMs !== sDt.toMillis()) {
              const delta = alignedMs - sDt.toMillis();
              effectiveStart = DateTime.fromMillis(alignedMs, { zone: timezone }).toISO() ?? effectiveStart;
              const eDt = DateTime.fromISO(effectiveEnd, { zone: timezone });
              if (eDt.isValid) effectiveEnd = DateTime.fromMillis(eDt.toMillis() + delta, { zone: timezone }).toISO() ?? effectiveEnd;
              logger.info('move_meeting — snapped off-grid start to quarter grid', { from: sDt.toISO(), to: effectiveStart });
            }
          }
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fb = require('../../../../utils/floatingBlocks') as typeof import('../../../../utils/floatingBlocks');
          const blocks = fb.getFloatingBlocks(context.profile);
          // Identify whether the meeting being moved is a floating block. We
          // need its current event to match against blocks. Cheap probe via
          // the day's events using args.new_start as the day target.
          const newStartDt = DateTime.fromISO(args.new_start as string, { zone: timezone });
          if (newStartDt.isValid) {
            const dayStr = newStartDt.toFormat('yyyy-MM-dd');
            const dayEvents = await getCalendarEvents(userEmail, dayStr, dayStr, timezone);
            const movingEvent = dayEvents.find(e => e.id === args.meeting_id);
            const matchedBlock = movingEvent ? blocks.find(b => fb.isFloatingBlockEvent(movingEvent, b)) : null;
            if (matchedBlock) {
              // v3.4.2 — preserve the MOVING EVENT's own duration. Pre-fix
              // a move re-derived the end from the block CONFIG (duration_minutes,
              // e.g. 25), so moving an owner-stretched 40-min lunch silently reset
              // it to 25. Read the event's actual span; fall back to config only
              // if the event's times don't parse. effectiveBlock carries it so the
              // placement search (findBlockDestination) also sizes for the real
              // duration.
              const movingDurationMin = (() => {
                try {
                  const s = DateTime.fromISO(movingEvent!.start.dateTime, { zone: movingEvent!.start.timeZone ?? 'utc' });
                  const e = DateTime.fromISO(movingEvent!.end.dateTime, { zone: movingEvent!.end.timeZone ?? 'utc' });
                  if (s.isValid && e.isValid && e.toMillis() > s.toMillis()) {
                    return Math.round(e.diff(s, 'minutes').minutes);
                  }
                } catch { /* fall through to config */ }
                return matchedBlock.duration_minutes;
              })();
              const effectiveBlock = movingDurationMin !== matchedBlock.duration_minutes
                ? { ...matchedBlock, duration_minutes: movingDurationMin }
                : matchedBlock;
              // Window bounds, needed by the owner-path in-window check below.
              // Exclude the floating block itself (it's about to move).
              const wStart = fb.windowMsForDay(dayStr, matchedBlock.preferred_start, timezone);
              const wEnd   = fb.windowMsForDay(dayStr, matchedBlock.preferred_end,   timezone);
              // v3.0.2 — floating-block math is buffer-free; meeting durations carry the spacing.

              // v2.3.2 (3A) — owner-explicit hint respects target as-is. Don't
              // snap to a different slot, don't refuse on conflict. Out-of-window
              // is NOT refused either: owner override is total and one-step
              // (rules 1, 6, 11) — moving his own lunch to 16:00 is his call, so
              // we move it and add a heads-up rather than bouncing for a
              // confirm_outside_window re-ask.
              // v4.1.x — STRICT (post-clamp) owner path. The name was already
              // `isOwnerPath` but the definition was the loose one, which now
              // collides head-on with the canonical split: `isOwnerPath` is
              // `senderRole === 'owner'` (authority + data scope AFTER the MPIM
              // clamp); identity-only attribution is `isOwnerTyping`. This branch
              // grants the TOTAL one-step override — it honors the owner's target
              // as-is and moves a floating block outside its window with no
              // confirm — so it is authority, not identity, and the MPIM clamp
              // exists precisely so owner-level authority is never exercised in a
              // room colleagues share. Owner-in-MPIM now takes the colleague
              // branch below (aligned placement inside the window), and his real
              // override still reaches him through the approval flow.
              const isOwnerPath = context.senderRole === 'owner';
              if (isOwnerPath) {
                // v3.1.8 — snap the hint to the quarter grid. The general
                // snap above is bypassed on the floating-block path because this
                // branch overwrites effectiveStart with the raw hint, so a "right
                // after" landing at :40 would book lunch at :40 instead of the
                // owner's quarter convention (:45). Redo the snap here; honor an
                // exact owner-given time (start_is_explicit) as-is.
                const alignedMs = args.start_is_explicit
                  ? newStartDt.toMillis()
                  : alignNearestQuarter(newStartDt.toMillis(), timezone);
                const hintStartDt = DateTime.fromMillis(alignedMs, { zone: timezone });
                const hintStartMs = hintStartDt.toMillis();
                const hintEndMs = hintStartMs + movingDurationMin * 60 * 1000;
                const inWindow = hintStartMs >= wStart && hintEndMs <= wEnd;
                effectiveStart = hintStartDt.toISO()!;
                effectiveEnd = hintStartDt
                  .plus({ minutes: movingDurationMin })
                  .toISO()!;
                logger.info(inWindow
                  ? 'move_meeting (owner) — floating block in-window, using hint as-is'
                  : 'move_meeting (owner) — floating block out-of-window, one-step owner override', {
                  meetingId: args.meeting_id, block: matchedBlock.name, hint: args.new_start,
                  window: `${matchedBlock.preferred_start}-${matchedBlock.preferred_end}`,
                  outOfWindow: !inWindow,
                });
                const windowNote = inWindow
                  ? ''
                  : ` (outside its usual ${matchedBlock.preferred_start}–${matchedBlock.preferred_end} window — moved as asked).`;
                // Skip the colleague-path findBlockDestination branch below.
                return await updateMeeting({
                  userEmail, timezone,
                  meetingId: args.meeting_id as string,
                  start: effectiveStart, end: effectiveEnd,
                  isAllDay: preMoveIsAllDay,
                  eventType: preMoveEventType,
                }).then(async () => {
                  await closeMeetingArtifacts({
                    ownerUserId: context.profile.user.slack_user_id,
                    meetingId: args.meeting_id as string,
                    reason: 'moved',
                    subject: args.meeting_subject as string | undefined,
                    bookingThreadTs: context.threadTs,
                    fulfillingRequestId: args._fulfilling_request_id as string | undefined,
                    // v4.2.x (option C) — the instant this write landed on, post-snap
                    // (the quarter-grid alignment just above). Unlike the main move
                    // path this branch has no `verifyEventMoved` read-back, so the
                    // claim it supports is "Graph accepted this PATCH", not "the
                    // calendar reads back this time". Harmless here and not worth a
                    // second Graph round-trip: the branch only fires for a FLOATING
                    // BLOCK, a block has no attendees, and every writer of
                    // `ctx.proposed_start` is a notice to an attendee
                    // (skills/meetingReschedule.ts ← calendarHealth/autoMove.ts, whose
                    // solo-event guard refuses an event with no non-owner attendee) —
                    // so no open notice can reference a block's event id and step 2a
                    // finds nothing to correct.
                    newStartIso: effectiveStart,
                    newEndIso: effectiveEnd,
                  });
                  // v3.2.1 (#120 / 120b) — return the vacated slot here too. The
                  // floating-block move (e.g. lunch) is exactly the case where
                  // the owner moves a block to FREE its slot for another meeting;
                  // without this the freed-slot info was dropped.
                  const vacated = computeVacatedSlot(preMoveStartIso, preMoveEndIso, timezone);
                  return {
                    success: true,
                    action_summary: `Moved ${matchedBlock.name} to ${formatIsoTime(effectiveStart, timezone)}.${windowNote}`,
                    // #1.5 — surface the POST-snap booked instant on the floating-block
                    // owner-move path too (lunch is the canonical case). Without it
                    // mutationActions falls back to the pre-snap input arg and the reply
                    // narrates a time the block never landed on (the 11:10-vs-11:15 bug).
                    booked_start: effectiveStart,
                    booked_end: effectiveEnd,
                    ...(vacated ? { vacated } : {}),
                  };
                });
              }

              // Colleague-path — keep existing alignment + conflict guard.
              // Destination search (owner ruling 2026-08-28): this picks WHERE
              // the block lands, not a single-slot capacity check — two-pass
              // finder, a genuinely free slot preferred over a WE-tagged one.
              const { aligned: alignedMs, usedWorkingElsewhereFallback } = fb.findBlockDestination(
                dayEvents, effectiveBlock, dayStr, timezone, new Set([args.meeting_id as string]),
              );
              if (alignedMs === null) {
                logger.info('move_meeting refused — no in-window slot for floating block', {
                  meetingId: args.meeting_id, block: matchedBlock.name, hint: args.new_start,
                });
                return {
                  success: false,
                  error: 'no_in_window_slot',
                  message: `No room in the ${matchedBlock.preferred_start}–${matchedBlock.preferred_end} window for ${matchedBlock.name} after that hint. To move it OUTSIDE the window, raise create_approval(kind='policy_exception') with deferred_action={ tool: 'move_meeting', args: { meeting_id, new_start, confirm_outside_window: true } }.`,
                };
              }
              const alignedDt = DateTime.fromMillis(alignedMs).setZone(timezone);
              const alignedEndDt = alignedDt.plus({ minutes: movingDurationMin });
              const alignedStartIso = alignedDt.toISO()!;
              const alignedEndIso   = alignedEndDt.toISO()!;
              if (alignedStartIso !== effectiveStart) {
                logger.info('move_meeting — floating block snapped to aligned slot', {
                  meetingId: args.meeting_id, block: matchedBlock.name,
                  hint: args.new_start, snapped: alignedStartIso,
                  usedWorkingElsewhereFallback,
                });
              }
              if (usedWorkingElsewhereFallback) moveUsedWorkingElsewhereFallback = true;
              effectiveStart = alignedStartIso;
              effectiveEnd   = alignedEndIso;
            }
          }
        } catch (err) {
          logger.warn('move_meeting floating-block alignment threw — proceeding with caller args', {
            err: String(err).slice(0, 200),
          });
        }

        // v2.7.0 — route the move through planMeeting so location + category
        // re-resolve when the day-type flips (office↔home). Only
        // re-detect category when location-relevant attributes change; same-
        // day-type moves keep the existing category. resolveLocation always
        // runs so the Graph PATCH can update location + isOnline.
        let movePlanLocation: string | undefined;
        let movePlanIsOnline: boolean | undefined;
        let movePlanCategories: string[] | undefined;
        let movePlanPreserveExisting = false;
        let movePlanOverrideNotice: string | undefined;   // #A — attendee-busy heads-up, surfaced on the move result
        try {
          const { planMeeting: planMove } = await import('../../planMeeting');
          // #B (2026-07-19) — fetch the moving event BY ID, not via a ±1-day window
          // around the DESTINATION. A >1-day move never found the source event in that
          // window → movingEvent=undefined → empty participants + no priorStart →
          // planMeeting re-detected the category from the owner alone (Meeting →
          // Logistic) and cleared the location ("Intro with Maya", Mon→Thu). The by-id
          // fetch returns the exact shape at any distance (and gives fix A its attendees).
          const movingEvent = await getEventForAttendeeUpdate(userEmail, args.meeting_id as string);
          // log-movemeeting-refuse-not-owners-unhandled (2026-08-31) — the source
          // event could not be READ. getEventForAttendeeUpdate returns null for
          // both causes (an id that doesn't resolve — the live incident passed the
          // literal string "MISSING_ID" — and a transient Graph read error) and
          // never throws, and this result used to go unchecked. Everything after
          // it then ran blind: planMeeting planned with no attendees, no prior
          // slot and no categories (the degraded plan #B below exists to prevent),
          // its ownership lookup fail-closed to `refuse_not_owners` on a null
          // organizer, and the move fell through to the Graph PATCH, which threw a
          // raw ErrorInvalidIdMalformed at the model (2026-08-31T09:06:52Z).
          // A move is a WRITE: an unreadable source event is refused cleanly and
          // retryably, never written blind — the same policy the planMeeting catch
          // at the bottom of this block states for a plan that didn't complete.
          if (!movingEvent) {
            logger.warn('move_meeting — source event unreadable, refusing (no blind write)', {
              meetingId: args.meeting_id, newStart: effectiveStart,
            });
            return {
              success: false,
              error: 'event_load_failed',
              meeting_subject: args.meeting_subject,
              message: `Couldn't load "${args.meeting_subject}" from the calendar — that meeting id didn't resolve, so nothing was changed. Re-read the day with get_calendar and retry the move with the id it returns.`,
            };
          }
          const priorStartIso = movingEvent.startIso;
          // v2.8.5 — prior END lets planMeeting's freebusy overlap exclude the source
          // event when an attendee's calendar still shows it (a 13:00→13:15 nudge
          // otherwise trips confirm_override on the very meeting being moved).
          const priorEndIso = movingEvent.endIso;
          const existingCats = movingEvent.categories;
          const existingLocation = movingEvent.location;
          const existingIsOnline = movingEvent.isOnline;
          const moveAttendees = movingEvent.attendees;
          preMoveAttendeeEmails = moveAttendees.map(a => a.email).filter(Boolean);
          // v4.4.x (#154) — resolved ONCE; both allowRelaxed and ownerRoomBend
          // below read this same grant so they can never disagree.
          const moveRelaxedGrant = grantRelaxed(args, context);
          const movePlan = await planMove({
            profile: context.profile,
            intent: 'move',
            initiator: context.senderRole === 'colleague' ? 'colleague' : 'owner',
            slotStartIso: effectiveStart,
            slotEndIso: effectiveEnd,
            subject: args.meeting_subject as string | undefined,
            participants: moveAttendees.map(a => ({
              email: a.email,
              name: a.name,
            })),
            existingEventId: args.meeting_id as string,
            existingEventCategories: existingCats,
            existingEventLocation: existingLocation,
            existingEventIsOnline: existingIsOnline,
            priorSlotStartIso: priorStartIso,
            priorSlotEndIso: priorEndIso,
            // v2.8.2 — owner-explicit hints flow through on move too. Without
            // these, an owner-explicit "move it to 3pm in person" loses the
            // physical signal and resolveLocation defaults to day-type rules.
            locationHint: args.location as string | undefined,
            isOnlineHint: typeof args.is_online === 'boolean' ? args.is_online : undefined,
            // (v4.2.x) — THE grant, not a local read of args.relaxed. This
            // line used to be `args.relaxed === true` with no sender check, the
            // only site in the codebase that set allowRelaxed without one — so
            // the invariant "allowRelaxed implies the owner" (scheduleRules.ts,
            // rule-1 note) was true in the comment and false here. Inert in
            // practice (the colleague gate above validates the destination
            // STRICTLY and returns needs_owner_approval before this call), but
            // an invariant with a live counter-example is not an invariant.
            allowRelaxed: moveRelaxedGrant.relaxed,
            // v4.4.x (#154) — see the field doc on PlanMeetingInput.ownerRoomBend.
            ownerRoomBend: moveRelaxedGrant.relaxedReason === 'owner_room_bend',
            // v4.1.x (M10) — the owner alone sees the real subject of whatever
            // he'd be colliding with; a colleague-path move never does.
            viewer: subjectViewerFor(context),
            // v4.4.9 (#154) — the attendee-aware half of that same mask.
            // gh#154-W5/gh#154-R4 (2026-08-06) — room-tightening lives inside
            // viewerEmailFor now; call it directly (no blanket ?? null).
            viewerEmail: viewerEmailFor(context),
          });
          logger.info('move_meeting — planMeeting verdict', {
            action: movePlan.action, meetingId: args.meeting_id,
            priorStart: priorStartIso, newStart: effectiveStart,
            reasoning: 'reasoning' in movePlan ? movePlan.reasoning : undefined,
          });
          // Owner is an attendee, not the organizer. Pre-fix this action fell
          // through every action-specific `if` below and reached the Graph
          // mutation unguarded. It is answered here ONLY when the organizer
          // actually resolved: planMeeting's findMeetingOwner fail-CLOSES, so a
          // failed organizer read returns this same action with a NULL organizer
          // — "the lookup broke" is not "someone else organized it", and saying
          // so about the owner's own meeting would be a confident false claim.
          // Unresolved says only that, and says it as a RETRYABLE error rather
          // than a verdict: this action means planMeeting returned before the
          // rules pipeline ever ran, so falling through would PATCH the calendar
          // with a destination nothing validated — the degrade the catch at the
          // bottom of this block refuses for the same reason. (The unreadable-id
          // case that produced this in the live incident is already refused at
          // the source-event load above; what reaches here is a Graph organizer
          // read that blipped on an event that otherwise reads fine.)
          if (movePlan.action === 'refuse_not_owners') {
            if (movePlan.organizerEmail) {
              logger.info('move_meeting refused — planMeeting resolved owner as attendee, not organizer', {
                meetingId: args.meeting_id, organizer: movePlan.organizerEmail,
              });
              return notOrganizerRefusal({
                subject: args.meeting_subject,
                ownerFullName: context.profile.user.name,
                organizerName: movePlan.organizerName,
                organizerEmail: movePlan.organizerEmail,
              });
            }
            logger.warn('move_meeting — refuse_not_owners with an UNRESOLVED organizer (Graph organizer read failed); refusing without claiming anything about who organized it', {
              meetingId: args.meeting_id,
            });
            return {
              success: false,
              error: 'ownership_unverified',
              meeting_subject: args.meeting_subject,
              message: `Couldn't check who organizes "${args.meeting_subject}" — the calendar lookup didn't come back, so I left the meeting exactly as it was. Try the move again in a moment; if it keeps failing, re-read the day with get_calendar and retry with the id it returns.`,
            };
          }
          // v3.2.x (#8) — colleague reschedule onto a soft-rule-breaking slot:
          // offer nearby rule-compliant alternatives before escalating.
          if (movePlan.action === 'propose_alternative') {
            // Same as create_meeting's branch: an alternative that gets said
            // out loud is an offered slot, so it binds and can be held.
            recordProposedAlternatives({
              channelId: context.channelId,
              threadTs: context.threadTs,
              timezone,
              alternatives: movePlan.alternatives,
              widenedAlternatives: movePlan.widenedAlternatives,
            });
            return {
              success: false,
              error: 'soft_rule_offer_alternatives',
              meeting_subject: args.meeting_subject,
              violation_label: movePlan.violationLabel,
              // See the parallel return in create_meeting. The day they
              // asked for and the widening stay in separate fields so the reply
              // can name which is which.
              requested_day: movePlan.requestedDay,
              alternatives_on_requested_day: movePlan.alternatives,
              alternatives_other_days: movePlan.widenedAlternatives,
              suggested_ask_text: movePlan.suggestedAskText,
              ...openQuestionsField(movePlan.openQuestions),
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: `The requested new time breaks one of the owner's soft rules. Do NOT escalate yet. ${alternativesNote(movePlan.requestedDay, movePlan.alternatives.length, movePlan.widenedAlternatives.length)} If the colleague INSISTS on the original time, or none of these work, THEN call create_approval(kind=policy_exception) with suggested_ask_text so the owner decides.`,
            };
          }
          if (movePlan.action === 'confirm_override' || movePlan.action === 'escalate_approval') {
            // v4.4.x (#154) / o#223>dep — see the parallel branch in
            // createMeeting.ts: a ROOM rule-bend must reach the owner's
            // private approval thread deterministically, not depend on
            // Sonnet placing the create_approval follow-up. Raise it here via
            // the same primitive the create_approval TOOL calls.
            if (movePlan.action === 'escalate_approval' && moveRelaxedGrant.relaxedReason === 'owner_room_bend') {
              const approval = await createApprovalRequest({
                kind: 'policy_exception',
                payload: {
                  rule: movePlan.violationLabel,
                  context: `${context.profile.user.name.split(' ')[0]} asked to move this meeting to this exact slot anyway from a room, bending one of his own scheduling rules — needs his sign-off in DM, not a room self-grant.`,
                  subject: args.meeting_subject,
                  deferred_action: { tool: 'move_meeting', args: { ...args } },
                },
                ask_text: movePlan.suggestedAskText,
              }, context) as { ok?: boolean; error?: string; reason?: string; approval_id?: string };
              if (approval.ok) {
                logger.info('move_meeting — ownerRoomBend escalated to create_approval directly (code path)', {
                  approvalId: approval.approval_id, meetingId: args.meeting_id,
                });
                return {
                  success: false,
                  error: 'escalated_to_owner',
                  meeting_subject: args.meeting_subject,
                  violation_label: movePlan.violationLabel,
                  approval_id: approval.approval_id,
                  category: movePlan.category,
                  // gh#154-R11 (owner ruling, verbatim: "she dont need to write in
                  // the room ... she doesnt need to write anything. its
                  // person to person ... still will get back after hour and
                  // approved.") — meta-instruction for the model, NEVER a
                  // sentence to say. The approval is already raised in code
                  // above; the room must not learn a rule was bent or that
                  // anything is pending.
                  _note: `Already escalated to ${context.profile.user.name.split(' ')[0]}'s private approval DM in code — do NOT call create_approval yourself for this. Do NOT tell this room that anything was escalated, sent for approval, needs sign-off, or bent a rule — no process narration at all. Reply with something ordinary that mentions none of this (or nothing further this turn); the resolver posts the outcome back in this thread once he responds, on his own time.`,
                };
              }
              logger.warn('move_meeting — ownerRoomBend direct create_approval call refused', {
                error: approval.error, reason: approval.reason, meetingId: args.meeting_id,
              });
              return {
                success: false,
                error: approval.error ?? 'internal_error',
                meeting_subject: args.meeting_subject,
                violation_label: movePlan.violationLabel,
                // gh#154-W4 (2026-08-06) — the SAME silence rule as the success
                // branch above applies here too: whether the private-DM raise
                // SUCCEEDED or — here — FAILED internally, the room must
                // never learn a rule-bend was even attempted. `approval.reason`
                // is written to instruct the MODEL on a retry (gateApprovalAsk),
                // never to be read aloud, so it does NOT belong in a spoken
                // `message`. Falling through to the generic (non-room-bend)
                // escalate_approval return below would be wrong here — that
                // path is written for a genuine colleague ask, where saying
                // "I'll check with him" is the correct, expected answer (M7);
                // this is the owner bending his own rule from a room, where
                // he must never learn it was even tried, success or failure.
                _note: `Raising this in ${context.profile.user.name.split(' ')[0]}'s private approval DM failed internally — do NOT call create_approval yourself for this, and do NOT tell this room that anything was escalated, sent for approval, needs sign-off, bent a rule, or failed — no process narration at all. Reply with something ordinary that mentions none of this (or nothing further this turn); try the request again in a bit.`,
              };
            }
            return {
              success: false,
              error: 'rule_violation',
              meeting_subject: args.meeting_subject,
              violation_label: movePlan.violationLabel,
              suggested_ask_text: movePlan.suggestedAskText,
              ...openQuestionsField(movePlan.openQuestions),
              category: movePlan.category,
              // v2.7.2 — deferred_action_hint for resolver replay on approve.
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: movePlan.action === 'escalate_approval'
                ? 'Move violates a scheduling rule. Use create_approval(kind=policy_exception) with suggested_ask_text.'
                // v3.2.1 (#120a — one mechanism) — owner-path soft-rule override
                // flows through the SAME persisted approval path as the colleague
                // escalate, instead of the fragile "ask, then re-issue relaxed
                // next turn" path (Sonnet can drop that re-issue → the meeting
                // silently never moves). If the owner ALREADY authorized the
                // override in THIS message, retry move_meeting now with
                // relaxed=true. OTHERWISE call
                // create_approval(kind=policy_exception) — the orchestrator
                // stamps the deferred move, so the override PERSISTS and the
                // owner's later "yes" replays it deterministically.
                : 'Move violates a soft scheduling rule. If the owner ALREADY authorized overriding it in THIS message (e.g. "do it anyway", "I\'ll handle the conflict"), retry move_meeting now with relaxed=true. Otherwise call create_approval(kind=policy_exception) with suggested_ask_text — this PERSISTS the override (the orchestrator stamps the deferred move) so the owner\'s later "yes" replays it on its own. Do NOT ask and then rely on re-issuing the move yourself next turn — that pending action gets lost.',
            };
          }
          // v2.8.2 — ask_location_mode on move (rare — external attendee,
          // same/unknown TZ, and the move flips into office day). Refuse +
          // surface the ask.
          if (movePlan.action === 'ask_location_mode') {
            return {
              success: false,
              error: HANDLER_ERROR_CODE.LOCATION_MODE_UNSPECIFIED,
              meeting_subject: args.meeting_subject,
              suggested_ask_text: movePlan.suggestedAskText,
              ...openQuestionsField(movePlan.openQuestions),
              category: movePlan.category,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: 'Move lands on an office day with external attendee in same/unknown timezone. Ask the owner online vs physical, then re-call move_meeting with either is_online=true or location=<full office address>.',
            };
          }
          // v2.8.2 — meeting room busy + ≥6 people on the move target slot.
          if (movePlan.action === 'room_unavailable_large') {
            return {
              success: false,
              error: HANDLER_ERROR_CODE.MEETING_ROOM_UNAVAILABLE_LARGE_MEETING,
              meeting_subject: args.meeting_subject,
              suggested_ask_text: movePlan.suggestedAskText,
              ...openQuestionsField(movePlan.openQuestions),
              category: movePlan.category,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: 'Move target time has the Meeting Room taken and the group is too large for the small-room fallback. Ask the owner whether to push the time, trim attendees, or pick another day.',
            };
          }
          if (movePlan.action === 'book') {
            movePlanPreserveExisting = movePlan.preserveExisting === true;
            movePlanOverrideNotice = movePlan.overrideNotice;   // #A — "who's busy" heads-up, surfaced on the result below
            // (v2.8.2) preserveExisting: leave location/isOnline undefined so the
            // Graph PATCH doesn't touch them. Re-stamping the BiWeekly's "Huddle"
            // with the office address on every move is exactly what we're killing.
            if (!movePlanPreserveExisting) {
              movePlanLocation = movePlan.location;
              movePlanIsOnline = movePlan.isOnline;
            }
            if (movePlan.category) {
              // Preserve any non-yaml-category labels already on the event
              // (rare but possible), then add the canonical category once.
              const profileCatNames = new Set((context.profile.categories ?? []).map(c => c.name.toLowerCase()));
              const preserved = existingCats.filter(c => !profileCatNames.has(c.toLowerCase()));
              movePlanCategories = [...preserved, movePlan.category];
            }
          }
        } catch (err) {
          // A move is a write: whatever the reason planMeeting failed —
          // CalendarOfflineError (his calendar is genuinely unreadable,
          // handled by the offline refusal upstream) or anything else (a
          // real validation exception) — the destination was never checked
          // against his rules, so "proceed with a time-only move" is never a
          // safe degrade. Rethrow unconditionally instead of swallowing:
          // CalendarOfflineError is caught by withCalendarOfflineRefusal
          // (meetings.ts) into the clean "calendar unreachable" answer; any
          // other error surfaces as a genuine tool failure (registry.ts's
          // generic catch) rather than a silent unvalidated write. Mirrors
          // create_meeting's own planMeeting call (createMeeting.ts), which
          // has no catch here at all and fails closed the same way — one
          // spine, one behavior (M1).
          if (!(err instanceof CalendarOfflineError)) {
            logger.error('move_meeting — planMeeting threw, refusing the move (no unvalidated write)', {
              err: String(err).slice(0, 200), meetingId: args.meeting_id,
            });
          }
          throw err;
        }

        // #30 — hold-conflict gate on MOVE (mirror of the create gate). Never
        // move a meeting onto a slot tentatively held for SOMEONE ELSE. Owner →
        // confirm once (override_hold:true on retry → move + release + DM holder).
        // Colleague → route to the owner's approval. The mover's OWN hold proceeds.
        {
          const { getActiveHoldOverlapping } = await import('../../../../db/slotHolds');
          const conflictHold = getActiveHoldOverlapping(
            context.profile.user.slack_user_id, effectiveStart, effectiveEnd,
          );
          if (conflictHold && conflictHold.holder_slack_id !== context.userId) {
            if (context.senderRole === 'owner') {
              if (args.override_hold !== true) {
                return {
                  success: false,
                  error: 'slot_on_hold',
                  meeting_subject: args.meeting_subject,
                  hold_id: conflictHold.id,
                  holder_name: conflictHold.holder_name,
                  message: `${conflictHold.holder_name} asked to reserve ${formatIsoTime(effectiveStart, timezone)}${conflictHold.reason ? ` (${conflictHold.reason})` : ''}. Move "${args.meeting_subject}" over it anyway? On your yes I'll move it and let ${conflictHold.holder_name} know the hold was released.`,
                  _deferred_action_hint: { tool: 'move_meeting', args: { ...args, override_hold: true } },
                  _note: 'Surface to the owner. If he says move it anyway, retry move_meeting with override_hold:true — that moves it, releases the hold, and DMs the holder.',
                };
              }
              // owner + override_hold:true → fall through and move; release fires on success.
            } else {
              // Colleague moving onto ANOTHER colleague's hold — never silently.
              // `override_hold: true` is REQUIRED, not decoration, for the exact
              // reason createMeeting.ts's mirror gate spells out: replay runs as
              // the OWNER (deferredActionReplay.ts, senderRole:'owner'), so a bare
              // `{...args}` lands on the owner-confirm branch two lines up and
              // returns success:false — the request sticks in awaiting_owner and
              // create_approval's own no_verified_deviation gate (tasks/skill.ts)
              // refuses every re-raise attempt with "do the action instead", which
              // just re-enters this same gate forever. Without this hint the
              // orchestrator (core/orchestrator/index.ts) has nothing to stamp as
              // payload.deferred_action, so the request never actually reaches the
              // owner. Missing until 2026-09-07 — this branch was never given the
              // hint the create-path sibling above (and createMeeting.ts's own
              // mirror) always had.
              return {
                success: false,
                error: 'slot_held_needs_owner_approval',
                meeting_subject: args.meeting_subject,
                hold_id: conflictHold.id,
                message: `That time is tentatively held for someone else — don't move it there, and don't reveal who holds it. Raise create_approval(kind=policy_exception) with this slot so ${context.profile.user.name.split(' ')[0]} decides; tell the colleague warmly you're checking.`,
                _deferred_action_hint: { tool: 'move_meeting', args: { ...args, override_hold: true } },
              };
            }
          }
        }

        await updateMeeting({
          userEmail,
          timezone,
          meetingId: args.meeting_id as string,
          start: effectiveStart,
          end: effectiveEnd,
          isAllDay: preMoveIsAllDay,
          eventType: preMoveEventType,
          // v2.7.0 — pass-through location/isOnline/categories from the
          // planMeeting verdict. Undefined values leave the existing fields
          // untouched on Graph's side. v2.8.2 — preserveExisting keeps both
          // undefined so a move within the same day-type doesn't overwrite owner
          // conventions like "Huddle".
          location: movePlanLocation,
          isOnline: movePlanIsOnline,
          categories: movePlanCategories,
        });

        // v3.6.x — the post-move Teams-URL-as-location patch was REMOVED (same
        // root as the create path): overwriting the online meeting's location with
        // the raw joinUrl broke Outlook's native Teams rendering. isOnlineMeeting
        // stays true through the move, so Graph keeps the toggle / Join button /
        // "Microsoft Teams Meeting" label — nothing to stamp.

        // v2.2.5 (#54) — post-move verification. Graph PATCH can return 200 OK
        // without the change landing (sync delays, race conditions). Re-read
        // the event by id and confirm the start matches the requested move
        // target. Fail-fast: if verify fails, skip the closeMeetingArtifacts
        // cascade, audit success log, shadow notify, and rebalance — none of
        // those should fire on a move that didn't actually happen.
        {
          const { verifyEventMoved } = await import('../../../../connectors/graph/calendar');
          // v2.3.1 — verify against the EFFECTIVE start (post-snap for
          // floating blocks), not the original args.new_start hint.
          const verify = await verifyEventMoved(userEmail, args.meeting_id as string, effectiveStart, timezone);
          if (!verify.ok) {
            logger.warn('move_meeting verify failed — Graph accepted PATCH but readback drifted', {
              meetingId: args.meeting_id, reason: verify.reason,
              expected: 'expected' in verify ? verify.expected : undefined,
              got: 'got' in verify ? verify.got : undefined,
            });
            const subject = args.meeting_subject as string;
            const message = verify.reason === 'not_found'
              ? `I tried to move '${subject}' but couldn't find it on the calendar afterward — the move may not have landed. Want me to investigate?`
              : `I tried to move '${subject}' to ${verify.expected} but the calendar still shows it at ${verify.got}. Graph accepted the change but didn't apply it — want me to retry?`;
            return {
              success: false,
              error: verify.reason === 'not_found' ? 'moved_but_missing' : 'move_did_not_land',
              message,
            };
          }
        }

        await closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'moved',
          subject: args.meeting_subject as string | undefined,
          bookingThreadTs: context.threadTs,
          fulfillingRequestId: args._fulfilling_request_id as string | undefined,
          // v4.2.x (option C) — the instant this move ACTUALLY landed on, which is
          // the only kind of time a correction to a human may quote. `effectiveStart`
          // is post-snap (grid alignment + floating-block realignment above, not the
          // raw `args.new_start` hint) and this line is past the `verifyEventMoved`
          // read-back, which fail-fast-returns above when Graph accepted the PATCH
          // without applying it — so the value handed on is one the calendar holds.
          // The comparison, the once-per-event-per-day cap and the DM are the
          // requests lane's (utils/closeMeetingArtifacts.ts, step 2a); this is only
          // the fact it needs, and absent it that step is a no-op by construction.
          newStartIso: effectiveStart,
          newEndIso: effectiveEnd,
        });
        // v4.2.x — WHEN HE CHANGES AN AUTOFIX, THAT IS THE DECISION (owner
        // 2026-07-26: "if i change the auto fix, don't change it again").
        //
        // 2026-07-13: active mode moved Ysrael's weekly to Tue 12:45 and DM'd him
        // (04:35:18, audit_log 7548); the owner moved it back to today 13:30 through
        // THIS handler (04:51:38, audit_log 7556 — action `move_meeting`, actor the
        // owner, NOT `revert_last_auto_move`); at 10:01:20 the next sweep moved it
        // to Tue 12:45 again and sent a byte-identical second DM (audit_log 7594 —
        // same event id on all three writes). An autonomous action repeated
        // something he had explicitly undone, and messaged a colleague twice.
        //
        // The durable "if I said no, it's no" record lived ONLY on the explicit
        // tool: `revert_last_auto_move` writes a terminal dismissal
        // (handlers/calendarReads.ts) and was its only caller. The conversational
        // undo — what he actually does — wrote nothing, leaving one protection:
        // `getRecentlyAutoMovedEventIds`' 12h window, timed from MY move instead of
        // HIS decision (undo it 13h after the autofix and the next sweep re-does
        // it), off a record whose write is explicitly best-effort. So his decision
        // is now recorded where every mover already looks — `getSuppressedEventIds`,
        // read by the double-booking pair scan, the dead-gap scan and all three
        // defrag paths (calendarHealth/handlers/checkHealth.ts) — which is what
        // makes it hold "regardless of which detector would fire next".
        //
        // BOUNDED, because it is INFERRED from an action rather than stated
        // (OWNER_UNDO_SUPPRESSION_HOURS): after the window a genuinely different,
        // later problem on the same event is detected, tracked and narrated again.
        // Keyed on the event HE touched — never its peer (that meeting he did not
        // touch), and never an autofix he left alone: the trigger is the recent
        // auto-move record for THIS id. Owner-authenticated senderRole only, never a
        // claim in a message; a colleague's move already answers to its own
        // rule-compliance gate above. (The floating-block owner-move branch earlier
        // in this handler needs none of this: blocks are rebalanced, never
        // auto-moved — calendarHealth/autoMove.ts — so no block id can be in the
        // record set.)
        if (context.senderRole === 'owner') {
          try {
            const movedId = args.meeting_id as string;
            const ownerUserId = context.profile.user.slack_user_id;
            const { getRecentlyAutoMovedEventIds } = await import('../../../../db/requests');
            if (getRecentlyAutoMovedEventIds(ownerUserId).has(movedId)) {
              const { dismissOverlapIssue, OWNER_UNDO_SUPPRESSION_HOURS } =
                await import('../../../../db/calendarIssues');
              const windowEndMs = Date.now() + OWNER_UNDO_SUPPRESSION_HOURS * 60 * 60 * 1000;
              const eventEndMs = DateTime.fromISO(effectiveEnd, { zone: timezone }).toMillis();
              dismissOverlapIssue({
                ownerUserId,
                eventId: movedId,
                eventDate: DateTime.fromISO(effectiveStart, { zone: timezone }).toFormat('yyyy-MM-dd'),
                eventEndMs: Math.min(eventEndMs, windowEndMs),
                notes: `owner moved this himself after an autofix moved it — leave it alone for ${OWNER_UNDO_SUPPRESSION_HOURS}h`,
              });
              logger.info('move_meeting — owner changed a recent autofix; autofix suppressed for this event', {
                meetingId: movedId, suppressionHours: OWNER_UNDO_SUPPRESSION_HOURS,
                until: new Date(Math.min(eventEndMs, windowEndMs)).toISOString(),
              });
            }
          } catch (err) {
            logger.warn('move_meeting — autofix-suppression write threw, move already landed', {
              err: String(err).slice(0, 160),
            });
          }
        }
        // #30 — the move landed on this slot, so release any hold overlapping it
        // (overlap, not exact-start: a move target may not begin exactly at the
        // held slot). If held by someone ELSE (owner moved over it via
        // override_hold), DM that holder; the mover's own hold releases silently.
        try {
          const sh = await import('../../../../db/slotHolds');
          const overlapHold = sh.getActiveHoldOverlapping(
            context.profile.user.slack_user_id, effectiveStart, effectiveEnd,
          );
          if (overlapHold) {
            sh.releaseSlotHold(overlapHold.id, 'slot_taken_by_move');
            if (overlapHold.holder_slack_id && overlapHold.holder_slack_id !== context.userId) {
              try {
                const { getConnection } = await import('../../../../connections/registry');
                const conn = getConnection(context.profile.user.slack_user_id, 'slack');
                if (conn) {
                  await conn.sendDirect(
                    overlapHold.holder_slack_id,
                    `Quick heads up — ${context.profile.user.name.split(' ')[0]} ended up taking ${formatIsoTime(effectiveStart, timezone)}, so I've released the hold I had for you there. Happy to find you another time whenever.`,
                    overlapHold.origin_thread_ts ? { threadTs: overlapHold.origin_thread_ts } : undefined,
                  );
                }
              } catch (dmErr) {
                logger.warn('move_meeting — hold-release DM failed (hold already released)', { err: String(dmErr).slice(0, 150) });
              }
            }
          }
        } catch (err) {
          logger.warn('move_meeting — slot-hold release threw, continuing', { err: String(err).slice(0, 150) });
        }
        auditLog({
          ownerUserId: context.profile.user.slack_user_id,
          action: 'move_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          // #52 (M1) — record where it WAS, not only where it went; the probe
          // is already in hand from the recurring-preflight above (zero extra
          // Graph calls). Both ISO values are offset-bearing at their source.
          details: {
            subject: args.meeting_subject,
            new_start: args.new_start,
            new_end: args.new_end,
            original_start: preMoveStartIso,
            original_end: preMoveEndIso,
          },
          outcome: 'success',
        });

        // gh#52 (52-U3) — undo/history record for this move, past the
        // verifyEventMoved read-back above (verify.ok already confirmed the
        // write landed) — never recorded on a PATCH Graph accepted but didn't
        // apply. Reuses the SAME pre-state (preMoveStartIso/preMoveEndIso/
        // start/end) already captured for the auditLog just above — no second
        // probe. `new_start`/`new_end` are the EFFECTIVE (post-snap, verified)
        // instant, not the raw args.new_start hint, so a future revert targets
        // where the meeting actually landed. subkind is the literal tool name
        // (matches ACTIVITY_REVERTIBILITY's keying in activityRevertibility.ts)
        // so a later revert dispatch can look it up directly off this row.
        // revert-intent-and-single-step-undo-scope, piece 4 (2026-08-12) —
        // meetingConcernsSlackId (the resolved requester) wins when present;
        // otherwise resolve against preMoveAttendeeEmails (already fetched
        // above to act on this event — no extra Graph call) via
        // people_memory, so a move with no provable "requester" still
        // captures whichever attendee is resolvable, not only the
        // requester-resolution path.
        const moveTargetIdentity = resolveActivityTargetIdentity({
          attendeeEmails: preMoveAttendeeEmails,
          ownerEmail: userEmail,
          preferred: { targetSlackId: meetingConcernsSlackId, targetName: meetingConcernsName },
        });
        logActivity({
          ownerUserId: context.profile.user.slack_user_id,
          kind: 'follow_up',
          subkind: 'move_meeting',
          subject: `Moved '${args.meeting_subject}'`,
          outcomeJson: {
            event_id: args.meeting_id,
            original_start: preMoveStartIso,
            original_end: preMoveEndIso,
            new_start: effectiveStart,
            new_end: effectiveEnd,
          },
          initiatedBy: context.userId,
          initiatedByRole: context.senderRole,
          originThreadTs: context.threadTs,
          originChannel: context.channelId,
          targetSlackId: moveTargetIdentity.targetSlackId,
          targetName: moveTargetIdentity.targetName,
        });

        // v2.2.1 — colleague-path inbound reschedule: shadow-DM the owner so he
        // sees the move happen even when he wasn't in the approval loop.
        // v2.3.2 — threaded under the colleague conversation key so all
        // shadows from this thread group together in the owner's DM.
        // Skip the OWNER clamped to colleague-context in an MPIM/channel — he
        // moved it himself and was present; no self-shadow.
        if (context.senderRole === 'colleague' && context.userId !== context.profile.user.slack_user_id) {
          try {
            const { shadowNotify } = await import('../../../../utils/shadowNotify');
            const { getPersonMemory } = await import('../../../../db');
            const requesterRow = getPersonMemory(context.userId);
            const requesterName = requesterRow?.name ?? 'a colleague';
            const whenLocal = DateTime.fromISO(args.new_start as string, { zone: timezone });
            const whenLabel = whenLocal.isValid
              ? whenLocal.toFormat('EEE d MMM HH:mm')
              : formatIsoTime(args.new_start as string, timezone);
            await shadowNotify(context.profile, {
              channel: context.channelId,
              threadTs: context.threadTs,
              action: 'Reschedule auto-accepted',
              detail: `${requesterName} asked to move "${args.meeting_subject}" — rule-compliant, moved to ${whenLabel}.`,
              conversationKey: context.threadTs,
              conversationHeader: `Conversation with ${requesterName}`,
            });
          } catch (err) {
            logger.warn('shadowNotify after colleague reschedule failed — continuing', { err: String(err) });
          }
        }

        // v2.2.3 (scenario 8 row 7) — post-mutation floating-block rebalance.
        // The new meeting time may have landed on top of lunch (or any
        // configured floating block). Try to slide the block elsewhere in its
        // window. If no in-window slot fits, leave it overlapping and ping
        // the owner (the bumping-out-of-window decision still belongs to him,
        // via the policy_exception approval flow).
        // v3.1.8 — the VACATED slot (where the meeting WAS) lets a follow-up
        // "move X into the freed slot" resolve from this turn instead of Maelle
        // re-asking the old time. v3.2.1 — shared helper (see top of file); the
        // floating-block early return uses the same one. Computed BEFORE the
        // rebalance so it can gate reclaim detection to the slot this move
        // actually freed.
        const vacated = computeVacatedSlot(preMoveStartIso, preMoveEndIso, timezone);
        // 1.4 (diagnostic) — the freed-slot narration once said 11:00 when the moved
        // occurrence was at 14:00. Log the pre-move start (from getEventType) and the
        // computed vacated so a recurrence shows whether getEventType returned the
        // series base time vs the occurrence's real start (i.e. is the bug here or
        // in the narration). Remove once diagnosed.
        logger.info('move_meeting — vacated slot computed', {
          meetingId: args.meeting_id,
          preMoveStartIso,
          newStart: args.new_start,
          vacated,
        });

        // v3.2.x (Tier 1) — capture the rebalance return so a displaced
        // floating block whose window this move just freed can be OFFERED back
        // (reclaimable_block), same propose-only pattern as `vacated`. The freed
        // range (the meeting's OLD slot) gates the offer to a relevant move.
        let reclaimable: import('../../../../utils/rebalanceFloatingBlocks').ReclaimableBlock[] = [];
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { rebalanceFloatingBlocksAfterMutation } = require('../../../../utils/rebalanceFloatingBlocks') as
            typeof import('../../../../utils/rebalanceFloatingBlocks');
          const rebal = await rebalanceFloatingBlocksAfterMutation({
            profile: context.profile,
            affectedSlotIso: effectiveStart,
            ownerSlackId: context.profile.user.slack_user_id,
            ...(vacated ? { freedRangeIso: { start: vacated.start, end: vacated.end } } : {}),
          });
          reclaimable = rebal?.reclaimable ?? [];
        } catch (err) {
          logger.warn('rebalance after move_meeting threw — continuing', { err: String(err).slice(0, 200) });
        }

        // gh#wrong-event-moved-move-meeting (2026-08-12) — narrate off the
        // PROBED real subject, not the caller's claim: preMoveSubject is only
        // ever set once the plausibility check earlier in this function has
        // already passed (or the probe genuinely couldn't run, in which case
        // the claim is all there is). Prevents a misresolved event from ever
        // narrating as if the claimed meeting was the one actually moved.
        // o#216 (bouncer fix) — preMoveSubject is already MASKED (see the
        // probe block above), so `moved` and `action_summary` below —
        // move_meeting is colleague-allowed — can never render a private
        // meeting's real title.
        const movedSubject = (preMoveSubject ?? args.meeting_subject) as string | undefined;
        // confirm-success-return-does-not-name-who-was-booked-over
        // (2026-09-09) — merge the requester-confirmed attendee book-over
        // (`bookedOverAttendees`, set at the colleague-path Guard above) with
        // planMeeting's own owner-side heads-up (`movePlanOverrideNotice`).
        // The two are independent triggers (one colleague-path, one the
        // owner's own slot) that could in principle both fire on the same
        // move — state both rather than the old code silently keeping only
        // whichever one happened to be written into this single field.
        const attendeeBusyNoteParts: string[] = [];
        if (bookedOverAttendees.length > 0) {
          attendeeBusyNoteParts.push(`Moved over a conflict the requester confirmed — ${bookedOverAttendeesNote(bookedOverAttendees, viewerEmailFor(context))}. Say plainly what the clash is at the new time; they already said to go ahead, don't re-ask.`);
        }
        if (movePlanOverrideNotice) {
          attendeeBusyNoteParts.push(`Heads up — ${movePlanOverrideNotice}. Moved anyway (your call is total); say plainly what the clash is at the new time and offer to check with them or pick another slot — don't re-ask permission.`);
        }
        const attendeeBusyNote = attendeeBusyNoteParts.length > 0 ? attendeeBusyNoteParts.join(' ') : undefined;
        // 2026-09-09 — the moved-to instant in the ATTENDEE's zone, same key and
        // helper as create_meeting's success returns (see the booked return in
        // createMeeting.ts for the incident) — the roster is `preMoveAttendeeEmails`,
        // the event's own attendees, unchanged by a move. No single zone → no key.
        // The floating-block owner-move return earlier in this handler carries no
        // field: a block has no attendees, so there is no zone to render.
        if (context.channelId) {
          try {
            const { clearOfferedSlots } = await import('../../../../utils/offeredSlotsStash');
            clearOfferedSlots(context.channelId, context.threadTs);
          } catch { /* non-fatal */ }
        }
        return {
          success: true,
          moved: movedSubject,
          ...presentationLocalFieldFor(preMoveAttendeeEmails, effectiveStart, userEmail, timezone),
          // #1.5 — the ACTUAL booked time after exact-offer preservation or grid
          // cleanup. Narration and mutationActions reflect where it truly landed.
          new_start: effectiveStart,
          new_end: effectiveEnd,
          booked_start: effectiveStart,
          booked_end: effectiveEnd,
          // v3.1.8 — the slot that just opened up (old time of the moved meeting).
          ...(vacated ? { vacated } : {}),
          // v3.2.x — a displaced floating block this move could bring home.
          // PROPOSE-ONLY: surface it; the reply offers ("…frees 12:30 — want
          // lunch back there?"). Not auto-moved (may be owner-pinned).
          ...(reclaimable.length ? { reclaimable_block: reclaimable[0] } : {}),
          // #A (2026-07-19) — non-blocking attendee-busy heads-up. The move already went
          // through (owner override is total), but a colleague-requested move can re-land
          // on a time that attendee is busy — surface it so Maelle flags it, never re-asks.
          // This notice was computed by planMeeting but DROPPED here before the fix.
          // v4.1.x (M2) — the same channel now also carries the booking LEVEL:
          // "this books over your optional <X>" / "this double-books you over
          // <Y> with 2 people on it". Same one-time flag, never a re-ask.
          ...(attendeeBusyNote ? { _attendee_busy_note: attendeeBusyNote } : {}),
          // v1.8.3 — past-tense summary the reply quotes verbatim. Issue #26 bug 1:
          // without this, Sonnet could re-read the calendar post-move and narrate
          // the new time as a fresh discovery ("already at 12:30, nothing to change")
          // instead of acknowledging her own action.
          action_summary: `Moved '${movedSubject}' to ${renderWeDualClock(effectiveStart, { isAway: !!moveTripDisplay, effectiveTz: moveTripDisplay?.tz ?? timezone, location: moveTripDisplay?.location ?? '' }, timezone, { endIso: effectiveEnd })}.${moveUsedWorkingElsewhereFallback ? ' (No fully clear gap in the window — it now sits against a Working-Elsewhere block.)' : ''}`,
          ...(moveTripDisplay ? { _trip_note: 'Travel day — state the moved time from `action_summary` VERBATIM (both clocks, correctly labelled); do not recompute it.' } : {}),
        };
}
