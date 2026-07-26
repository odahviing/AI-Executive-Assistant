/**
 * planMeeting (v2.7.0) — the pipeline orchestrator.
 *
 * One function. Every scheduling intent flows through it. Inputs are
 * structured (no Sonnet free-text inside). Output is one of 6 plan actions
 * that tools execute:
 *
 *   book                  — go ahead, create/move/delete on Graph
 *   find_slots            — caller should run findAvailableSlots & return options
 *   confirm_override      — owner-initiated, rule failed → ask owner for relaxed override
 *   escalate_approval     — colleague-initiated, rule failed → create_approval(kind=policy_exception)
 *   decline_as_attendee   — owner-attendee cancel asked → decline his copy on Graph;
 *                           Outlook's own decline response tells the organizer (no Slack DM)
 *   refuse_not_owners     — owner-attendee move asked → polite refuse, no DM (per D4)
 *
 * Pipeline (strict order):
 *   1. LOAD STATE          day type, working hours, existing event metadata
 *   2. DETECT CATEGORY     (new bookings) OR USE EXISTING (existing events)
 *                          For moves: re-detect only when day type changed (per Q2)
 *   3. RESOLVE LOCATION    via utils/resolveLocation
 *   4. CHECK RULES         via utils/scheduleRules
 *   5. DECIDE ACTION       branches on initiator + ownership + rule result
 *
 * ── ONE ROUND, NOT FOUR (v4.1.x — M4) ───────────────────────────────────────
 * Steps 3–5 used to `return` on the FIRST gate that needed input, which made
 * the pipeline single-question-per-call by construction: the location question
 * returned before the rule check had run, which returned before the
 * attendee-busy check, which returned before the room check. The owner answered
 * "online or physical?" and only THEN heard "Anna is busy then, book anyway?".
 * Now every gate that CAN be evaluated is evaluated, the open questions are
 * accumulated, and ONE action carries all of them (`openQuestions`, and the
 * same text joined into `suggestedAskText`). Booking proceeds only when none is
 * open. Gates that genuinely depend on an earlier answer (the meeting-room
 * check needs a resolved location) are skipped, not guessed.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../../config/userProfile';
import { getOwnerEventsForDecision, getFreeBusy, findAvailableSlots, pickSpreadSlots, slotLocalDay, type CalendarEvent } from '../../connectors/graph/calendar';
import { resolveLocation, type LocationVerdict } from '../../utils/resolveLocation';
import { bookingLeadTimeHours, checkSlot, offeredSlotCount, type RuleCheckResult } from '../../utils/scheduleRules';
import { getEffectiveWorkDay } from '../../utils/workHours';
import type { SubjectViewer } from '../../utils/displaySubject';
import { renderWeDualClock } from '../../utils/weTimeResolver';
import { getTravelContextForInstant } from '../../utils/workingElsewhere';
import { detectCategory } from './detectCategory';
import { findMeetingOwner, type MeetingOwnerInfo } from './findMeetingOwner';
import { getCurrentTravel, searchPeopleMemory } from '../../db/people';
import logger from '../../utils/logger';
import type { BookingRequest } from './bookingRequest';

// ── Input shapes ────────────────────────────────────────────────────────────

export type IntentKind = 'new_booking' | 'move' | 'cancel' | 'find_slots';

export interface PlanParticipant {
  email?: string;
  name?: string;
  slack_id?: string;
  just_invite?: boolean;
  isOwner?: boolean;     // v2.9 — set true by normalizeBookingRequest for owner row
}

export interface PlanMeetingInput {
  profile: UserProfile;
  intent: IntentKind;
  initiator: 'owner' | 'colleague';
  // v4.2.x — `initiatorSlackId` is gone with the decline-relay branch (#147):
  // comparing the asker's slack id to the organizer's was only ever used to
  // decide whether to DM the organizer, and nothing DMs on a cancel now. The
  // asker's ROLE (`initiator` above) is what the rules actually key on.

  // Time
  slotStartIso?: string;
  slotEndIso?: string;
  durationMin?: number;

  // Subject + body for category detection (and Graph metadata)
  subject?: string;
  body?: string;
  isRecurring?: boolean;

  // Participants — v2.9: handlers route through normalizeBookingRequest,
  // which always includes the owner (with isOwner=true). Legacy coord
  // callers that build PlanMeetingInput directly may still omit the owner
  // — planMeeting handles both shapes.
  participants: PlanParticipant[];

  // Owner-explicit hints
  locationHint?: string;
  isOnlineHint?: boolean;
  // v4.0.x — the caller's requested category (create_meeting's args.category).
  // A HINT the classifier reconciles, NOT an override: detectCategory honors it
  // when plausible and overrides it when it clearly doesn't fit (the Sonnet-5
  // "Outside" on an online call). The reconciled verdict is what gets written.
  categoryHint?: string | null;

  // Existing-event reference (move/cancel)
  existingEventId?: string;
  existingEventCategories?: string[];
  existingEventLocation?: string;
  existingEventIsOnline?: boolean;     // for move preserve-location path

  // Move-specific: prior slot for comparison (decides if category needs re-detect
  // AND drives the location preserve path)
  priorSlotStartIso?: string;
  // v2.8.5 — prior slot END for the freebusy-overlap exclusion (see v2.8.5
  // changelog entry for the move 13:00 → 13:15 self-overlap case).
  priorSlotEndIso?: string;

  // Owner-explicit override (e.g. "yes book it even though it breaks the rule").
  // v2.9: normalizeBookingRequest gates this — handlers should NEVER set this
  // directly from `args.relaxed`. The normalizer's `relaxed` post-gate value
  // is the authoritative input.
  allowRelaxed?: boolean;

  // Floating-block booking path (lunch / focus / gym). Skips the owner_busy_collision
  // rule — floating blocks are signals, not competing time. See scheduleRules.checkSlot.
  isFloatingBlock?: boolean;

  // Optional pre-fetched calendar (saves a Graph call when caller already has it)
  preloadedEvents?: CalendarEvent[];

  /**
   * v4.1.x (M12) — WHO will read the strings this plan produces. checkSlot's
   * owner_busy label embeds the colliding meeting's subject, and on a
   * COLLEAGUE-initiated create_meeting that label is handed back as
   * `violation_label` + `suggested_ask_text` — straight into a colleague turn's
   * model context. Scoped here, at the producer. Omitted → masked.
   */
  viewer?: SubjectViewer;
}

/**
 * v2.9.0 — adapter: map a normalized BookingRequest into the PlanMeetingInput
 * shape that planMeeting consumes internally. Single-call site at the top of
 * each migrated handler. Phase B will flip planMeeting's internals to read
 * BookingRequest directly; for now this keeps the change surgical.
 */
export function planInputFromBookingRequest(
  req: BookingRequest,
  profile: UserProfile,
  extra?: { preloadedEvents?: CalendarEvent[] },
): PlanMeetingInput {
  return {
    profile,
    intent: req.intent,
    initiator: req.initiator,
    slotStartIso: req.slotStartIso,
    slotEndIso: req.slotEndIso,
    durationMin: req.durationMin,
    subject: req.subject,
    body: req.body,
    isRecurring: req.isRecurring,
    participants: req.participants.map(p => ({
      email: p.email || undefined,
      name: p.name,
      slack_id: p.slack_id,
      just_invite: p.just_invite,
      isOwner: p.isOwner,
    })),
    locationHint: req.locationHint,
    isOnlineHint: req.isOnlineHint,
    categoryHint: req.category ?? null,
    existingEventId: req.existingEventId,
    existingEventCategories: req.existingEventCategories,
    existingEventLocation: req.existingEventLocation,
    existingEventIsOnline: req.existingEventIsOnline,
    priorSlotStartIso: req.priorSlotStartIso,
    priorSlotEndIso: req.priorSlotEndIso,
    allowRelaxed: req.relaxed,
    isFloatingBlock: req.isFloatingBlock,
    preloadedEvents: extra?.preloadedEvents,
    // Owner alone → he sees everything (M12). Owner in an MPIM is NOT alone:
    // colleagues read that transcript, so it masks like any colleague turn —
    // the same posture as the isOwnerDm gate on get_calendar's audit context.
    viewer: req.initiator === 'owner' && !req.context.isMpim ? 'owner' : 'other',
  };
}

// ── Plan output ─────────────────────────────────────────────────────────────

/**
 * M4 — every question this booking still needs answered, in one list. The
 * action kind is the highest-precedence gate (so existing handler branches keep
 * working); `openQuestions` is the complete set, and `suggestedAskText` is that
 * same set joined for a single message. Length 1 is the common case.
 */
export type PlanOpenQuestions = string[];

export type PlanAction =
  | {
      action: 'book';
      isOnline: boolean;
      location: string;
      addRoomEmail?: boolean;          // ops.ts adds profile.meetings.room_email as optional attendee
      preserveExisting?: boolean;      // ops.ts leaves the existing event's location/isOnline alone (move case)
      category: string | null;
      reasoning: string;
      overrideNotice?: string;   // #127 — owner booked through a soft own-day rule; surface this heads-up, never re-ask
      /**
       * M3 — the booking LEVEL this write lands on. 'free' is the preferred
       * place to book; 'optional' means it sits over a skippable
       * Working-Elsewhere commitment; 'unfiltered' means it sits over a real
       * commitment. Pre-fix the write path had no notion of the tier at all, so
       * booking straight over the owner's optional standup was indistinguishable
       * from booking a genuinely free slot in what Maelle said back.
       */
      level?: 'free' | 'optional' | 'unfiltered';
    }
  | { action: 'find_slots'; category: string | null; reasoning: string }
  | { action: 'confirm_override'; violationLabel: string; suggestedAskText: string; openQuestions: PlanOpenQuestions; category: string | null }
  | { action: 'escalate_approval'; violationLabel: string; suggestedAskText: string; openQuestions: PlanOpenQuestions; category: string | null }
  /**
   * D3 — two lists, never one. `alternatives` is what exists on the day the
   * requester named; `widenedAlternatives` is what only exists if the search is
   * widened past it. `requestedDay` (yyyy-MM-dd) names the day both are measured
   * against. `alternatives` empty + `widenedAlternatives` non-empty is the exact
   * shape of "nothing on Thursday — want me to look further out?", and it is a
   * shape the caller cannot flatten by accident.
   */
  | { action: 'propose_alternative'; violationLabel: string; suggestedAskText: string; openQuestions: PlanOpenQuestions; alternatives: Array<{ start: string; end: string; label: string }>; widenedAlternatives: Array<{ start: string; end: string; label: string }>; requestedDay: string; category: string | null }
  | { action: 'decline_as_attendee'; organizerName: string | null; organizerEmail: string | null }
  | { action: 'refuse_not_owners'; organizerName: string | null; organizerEmail: string | null }
  | { action: 'ask_location_mode'; suggestedAskText: string; openQuestions: PlanOpenQuestions; category: string | null; reasoning: string }
  | { action: 'room_unavailable_large'; suggestedAskText: string; openQuestions: PlanOpenQuestions; category: string | null; reasoning: string };

// ── Entry ───────────────────────────────────────────────────────────────────

export async function planMeeting(input: PlanMeetingInput): Promise<PlanAction> {
  const { profile, intent, initiator } = input;
  const ownerEmail = profile.user.email;

  // v2.9.0 — normalize participants invariant: owner is ALWAYS in the list
  // with isOwner=true. Callers built via normalizeBookingRequest already
  // satisfy this; legacy callers (coord/booking, deferred-replay paths) may
  // not. Inject here once so downstream code can rely on the invariant
  // without repeating the check. nonOwnerParticipants is a convenience for
  // the few places that explicitly need "everyone except the owner".
  const hasOwner = input.participants.some(p => p.isOwner === true || (p.email ?? '').toLowerCase() === ownerEmail.toLowerCase());
  const participants: PlanParticipant[] = hasOwner
    ? input.participants
    : [{ email: ownerEmail, isOwner: true }, ...input.participants];
  const nonOwnerParticipants = participants.filter(p => !p.isOwner);

  // ── Cancel / move on an existing event → ownership matters FIRST ────────
  if ((intent === 'cancel' || intent === 'move') && input.existingEventId) {
    const ownerInfo = await findMeetingOwner({
      ownerUserId: profile.user.slack_user_id,
      ownerEmail,
      eventId: input.existingEventId,
    });
    logger.info('planMeeting — ownership resolved', {
      intent, eventId: input.existingEventId, ownerInfo,
    });

    // Owner is attendee, not organizer:
    if (!ownerInfo.ownerIsOrganizer) {
      if (intent === 'move') {
        // Per D4 — just refuse, no DM.
        return {
          action: 'refuse_not_owners',
          organizerName: ownerInfo.organizerName,
          organizerEmail: ownerInfo.organizerEmail,
        };
      }
      // intent === 'cancel' → ONE outcome, whoever asked: decline the owner's
      // own copy. v4.2.x (#147) collapsed what used to be two branches (asker-is-
      // the-organizer → silent decline; anyone else → decline + a Slack DM to the
      // organizer). They only ever differed by that DM, and the DM is gone: the
      // organizer's notice is Outlook's own decline response, sent by
      // `declineMeeting` on the Graph call itself. So there is nothing left to
      // branch on, and `askerIsOwnerOfMeeting` (plus its `participantEmail`
      // helper) went with it.
      return {
        action: 'decline_as_attendee',
        organizerName: ownerInfo.organizerName,
        organizerEmail: ownerInfo.organizerEmail,
      };
    }
    // Owner IS organizer → fall through to normal pipeline (book = delete/move on Graph).
  }

  // ── Owner state (load preferences — per D1, load first) ─────────────────
  // Travel state lookup
  const ownerTravel = getCurrentTravel(profile.user.slack_user_id);
  let anyParticipantRemote = !!ownerTravel;
  for (const p of nonOwnerParticipants) {
    if (anyParticipantRemote) break;
    if (p.slack_id) {
      const travel = getCurrentTravel(p.slack_id);
      if (travel) { anyParticipantRemote = true; break; }
    }
    // #M5 (2026-07-23) — a cross-TZ INTERNAL attendee (a colleague whose home zone
    // differs from the owner's, not just travelers) makes this a de-facto remote
    // meeting → online, not the office-day default. Mirrors the external-different-TZ
    // path. Only fires on a KNOWN different TZ; a no-TZ attendee (assumed owner-frame
    // per #M3) correctly stays local. Fail-open.
    const pEmail = (p.email ?? '').trim().toLowerCase();
    if (pEmail) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { searchPeopleMemory } = require('../../db/people') as typeof import('../../db/people');
        const m = searchPeopleMemory(pEmail).find(x => (x.email ?? '').toLowerCase() === pEmail);
        if (m?.timezone && m.timezone !== profile.user.timezone) anyParticipantRemote = true;
      } catch { /* fail-open — no cross-TZ signal */ }
    }
  }

  // ── Detect category ─────────────────────────────────────────────────────
  let category: string | null = null;
  let categoryReason = '';
  if (intent === 'cancel') {
    // Category doesn't matter for cancel — skip detection.
  } else if (intent === 'move') {
    // Per Q2: re-detect only when location changed (day type flipped).
    const dayChanged = input.priorSlotStartIso && input.slotStartIso
      ? sameDayType(profile, input.priorSlotStartIso, input.slotStartIso) === false
      : true;  // unknown → conservative re-detect
    if (dayChanged) {
      const det = await detectCategory({
        profile,
        subject: input.subject ?? '(no subject)',
        body: input.body,
        attendees: participants,
        isRecurring: input.isRecurring,
        requestedCategory: input.categoryHint,
      });
      category = det.category;
      categoryReason = det.reason + ' (re-detected on move; day type changed)';
    } else if (input.existingEventCategories && input.existingEventCategories.length > 0) {
      // Trust the existing categorization.
      category = pickCanonicalCategory(profile, input.existingEventCategories);
      categoryReason = 'kept existing category (move same day type)';
    }
  } else {
    // new_booking / find_slots — always detect when subject is present OR
    // there's at least one non-owner participant (a solo owner block with
    // no subject can default through resolveLocation without category).
    if (input.subject || nonOwnerParticipants.length > 0) {
      const det = await detectCategory({
        profile,
        subject: input.subject ?? '(no subject)',
        body: input.body,
        attendees: participants,
        isRecurring: input.isRecurring,
        requestedCategory: input.categoryHint,
      });
      category = det.category;
      categoryReason = det.reason;
    }
  }

  // ── find_slots path: skip rule/location decision per-slot, return early ─
  if (intent === 'find_slots') {
    return {
      action: 'find_slots',
      category,
      reasoning: `category=${category ?? 'none'} (${categoryReason}); caller should run findAvailableSlots with these rules applied`,
    };
  }

  // ── M4 gate accumulator ─────────────────────────────────────────────────
  // Each gate is a question this booking still needs answered. They are
  // COLLECTED, not returned one at a time (see the header note). `whenText` is
  // the ONE clock renderer for every user-facing time string below — M14: the
  // dual clock is quoted verbatim, never re-derived. Pre-fix these strings were
  // formatted with a bare `.toFormat("EEEE 'at' HH:mm")` pinned to the owner's
  // HOME zone, so on an away-override day the ask stated one hour while the
  // violation_label travelling in the same payload (rendered by checkSlot in
  // the day's EFFECTIVE zone, with a zone note) stated another.
  const gates: Array<{ kind: 'location' | 'rule' | 'attendee_busy' | 'room'; ask: string }> = [];
  // WHO reads the clock this renders, on the SAME signal checkSlot frames its
  // violation_label with — the two strings sit side by side in the rule ask
  // below, so they must address the same person. Off-trip the dual clock is a
  // single person-free clock and this changes nothing; on a trip day the
  // owner-facing branch is hardcoded second person ("11:00 EDT where you are
  // now / 15:00 your home time"), which is what a colleague was being told
  // about someone else's trip. Unknown viewer → named (the colleague-safe
  // reading), never "you".
  const clockReader = input.viewer === 'owner' ? {} : { ownerName: profile.user.name.split(' ')[0] };
  const whenText = (startIso: string, endIso?: string): string =>
    renderWeDualClock(startIso, getTravelContextForInstant(startIso, profile), profile.user.timezone,
      { endIso, ...clockReader });

  // ── Resolve location ────────────────────────────────────────────────────
  let locationVerdict: LocationVerdict | null = null;
  // #127 — when the OWNER books through a soft own-day rule (focus floor, work
  // hours/days, lunch/floating, buffer, his own busy-collision), we record the
  // heads-up here and fall through to the book return — one step, no re-ask —
  // instead of bouncing a confirm_override (which cost him a 2nd/3rd "yes").
  let ownerOverrideNotice: string | undefined;
  // Set when the owner overrides (relaxed) onto a slot where an internal
  // attendee is busy — booked anyway (rule 6: availability never blocks), but
  // surfaced so the owner is TOLD who's busy (rule 7), never silently.
  let attendeeBusyNotice: string | undefined;
  // Set when the owner overrides onto a slot where the big meeting room is taken
  // and the group's too large for the small-room fallback — booked without the
  // room (not double-booked), with a heads-up so he grabs space himself.
  let roomBusyNotice: string | undefined;
  // M3 — set when the write lands on a slot held by a skippable Working-Elsewhere
  // commitment (level 'optional'): the owner must be told he's booking over it,
  // not handed a confirmation that reads identical to a genuinely free slot.
  let optionalLevelNotice: string | undefined;
  // M3 — set when the write lands on a REAL commitment (level 'unfiltered') and
  // proceeds anyway (owner override / approved replay). Distinct from a soft
  // own-day rule: it names WHAT is being double-booked and whether other people
  // are on it.
  let unfilteredLevelNotice: string | undefined;
  let bookingLevel: 'free' | 'optional' | 'unfiltered' | undefined;
  let locationAskReasoning: string | undefined;
  // Colleague-path rule break: the label, and the nearby rule-compliant options
  // to offer before escalating (#8). Both feed the single combined return.
  let ruleViolationLabel: string | undefined;
  let attendeeBusyLabel: string | undefined;
  // D3 — the two sets are kept APART all the way to the caller. Options on the
  // day the requester actually named are the answer; anything on a later day is
  // a widening he has to be offered as a widening, not slipped into one list.
  let ruleAlternatives: Array<{ start: string; end: string; label: string }> = [];
  let widenedAlternatives: Array<{ start: string; end: string; label: string }> = [];
  let alternativesRequestedDay = '';
  let roomAskText: string | undefined;
  if (input.slotStartIso) {
    const ownerDomain = ownerEmail.split('@')[1].toLowerCase();
    const externalEmails: string[] = [];
    for (const p of nonOwnerParticipants) {
      const e = (p.email ?? '').toLowerCase();
      if (e && !e.endsWith('@' + ownerDomain)) externalEmails.push(e);
    }
    const hasExternal = externalEmails.length > 0;
    // Decide if ANY external attendee is in a known-different TZ. Lookup is
    // best-effort: people_memory exact-email match → row.timezone (IANA). If
    // any external is known-different from owner's TZ, fire the auto-online
    // path (3a). If all externals are same-TZ → ask. If any external TZ is
    // unknown AND no external is known-different → ask.
    let externalAttendeeInDifferentTz: boolean | undefined = undefined;
    if (hasExternal) {
      const ownerTz = profile.user.timezone;
      let anyDifferent = false;
      let anyUnknown = false;
      for (const email of externalEmails) {
        const matches = searchPeopleMemory(email);
        const exact = matches.find(m => (m.email ?? '').toLowerCase() === email);
        const tz = exact?.timezone;
        if (!tz) { anyUnknown = true; continue; }
        if (tz !== ownerTz) { anyDifferent = true; break; }
      }
      if (anyDifferent) externalAttendeeInDifferentTz = true;
      else if (anyUnknown) externalAttendeeInDifferentTz = undefined; // unknown → ask
      else externalAttendeeInDifferentTz = false;                      // all same → ask
    }
    locationVerdict = resolveLocation({
      profile,
      startIso: input.slotStartIso,
      // find_slots early-returns above; by here intent is new_booking | move | cancel.
      intent: intent as 'new_booking' | 'move' | 'cancel',
      category,                              // v2.8.2 — drives Logistic / Private skip-stamp
      participantCount: participants.length,  // owner is already in the list (v2.9 invariant)
      hasExternalAttendee: hasExternal,
      externalAttendeeInDifferentTz,
      anyParticipantRemote,
      ownerLocationHint: input.locationHint,
      ownerIsOnlineHint: input.isOnlineHint,
      initiatorRole: input.initiator,  // v3.2.6 (RC4) — gate baseless colleague-path online
      priorStartIso: input.priorSlotStartIso,
      existingLocation: input.existingEventLocation,
      existingIsOnline: input.existingEventIsOnline,
    });
    // (v2.8.2) ask_owner_online_or_physical: caller must ask, never auto-pick.
    // Owner-path AND colleague-path both surface the question; colleague-path
    // routes through create_approval so Sonnet doesn't try to resolve it locally.
    // v4.1.x (M4) — recorded as a GATE and the pipeline keeps going, so the
    // rule check and the attendee free/busy check run in the SAME call and
    // their questions ride out with this one.
    if (locationVerdict.kind === 'ask_owner_online_or_physical') {
      gates.push({ kind: 'location', ask: locationVerdict.suggestedAskText });
      locationAskReasoning = locationVerdict.reasoning;
    }
  }

  // ── Check rules ─────────────────────────────────────────────────────────
  if (input.slotStartIso && input.slotEndIso) {
    const events = input.preloadedEvents ?? await loadEventsForCheck(profile, input.slotStartIso);

    // v3.7.x (#143) — Working-Elsewhere is no longer a separate relax+confirm
    // branch. An away day is a per-date override carrying a timezone: checkSlot
    // validates the slot against the stated hours IN that zone (via effectiveDay)
    // and it books DIRECTLY — there is no forced approval or trip-time confirm just
    // because he's away (the stated hours removed the reason for it). weTimeResolver
    // still renders the dual-clock on the booked confirmation.
    const ruleResult = checkSlot({
      profile,
      slotStartIso: input.slotStartIso,
      slotEndIso: input.slotEndIso,
      category,
      events,
      excludeEventIds: input.existingEventId ? [input.existingEventId] : [],
      allowRelaxed: !!input.allowRelaxed,
      isFloatingBlock: !!input.isFloatingBlock,
      // v4.1.x (M2) — the booking lead time is now a real rule in THE validator,
      // keyed on who is asking, so the write path enforces the same floor the
      // search does. Pre-fix a colleague naming "3pm today" at 2pm was refused
      // by find_available_slots and accepted by create_meeting.
      leadTimeHours: bookingLeadTimeHours(profile, initiator),
      // v4.1.x (M12) — the owner_busy label embeds the colliding subject.
      viewer: input.viewer,
    });
    // M3 — the tier this slot sits on, whatever the rule verdict was.
    bookingLevel = ruleResult.level;
    if (!input.isFloatingBlock && ruleResult.level === 'optional' && ruleResult.overOptional) {
      // Bookable, no approval — but never silently. A floating block booking is
      // exempt: blocks coexist with meetings by design.
      optionalLevelNotice = `this books over your optional "${ruleResult.overOptional}" — you'd skip it; it stays on the calendar`;
    }
    if (!input.isFloatingBlock && ruleResult.overCommitment) {
      // THE double-booking notice, on every path that reaches a write. Booking
      // over a real commitment is M3's Unfiltered tier — say WHAT is being
      // double-booked and who else is on it, not just "a rule".
      //
      // The gate used to be `ruleResult.passes`, i.e. "only when the owner-busy
      // rule was BYPASSED (explicit override / approved replay)". That silenced
      // it on the one relaxed path that still fails: rule 1
      // (vacation_or_off_day) is the only rule in the ladder with no
      // allowRelaxed gate (scheduleRules.ts, rule 1 — see its ladder note), so a
      // relaxed owner booking on a Friday returns passes:false with the
      // collision sitting right there on
      // `overCommitment` — and the owner heard "you have Friday 31 Jul off" and
      // NOT that he was booking over a real meeting. A soft rule masking a hard
      // commitment, the exact failure the validator's reorder exists to kill,
      // surviving on one condition. The SOFT tier just above never had a passes
      // gate either, so the skippable tier announced itself on failures while
      // the hard one stayed silent — backwards.
      // When the collision IS the reported violation, this notice REPLACES the
      // rule label (see the owner branch below) rather than sitting beside it:
      // one fact, one sentence, the more complete wording of the two.
      const c = ruleResult.overCommitment;
      const withWhom = c.attendeeCount > 0
        ? ` with ${c.attendeeCount} other ${c.attendeeCount === 1 ? 'person' : 'people'} on it`
        : '';
      unfilteredLevelNotice = `this double-books you over "${c.subject}" (${c.window})${withWhom}`;
    }

    if (!ruleResult.passes && ruleResult.violation_kind === 'in_the_past') {
      // A past / earlier-today time is almost always a typo, not an override —
      // so it is NOT one-step-booked (that would book into the past) and NOT
      // offered alternatives as if it were a soft conflict. Flag ONCE, for both
      // owner and colleague: "that time's passed — did you mean later?" The
      // owner's "yes / I meant it" retry comes back allowRelaxed, which checkSlot
      // then lets through (he can log a past meeting if he truly insists).
      const askText = `That time has already passed — did you mean later today, or a different day?`;
      return {
        action: 'confirm_override',
        violationLabel: 'that time has already passed',
        suggestedAskText: askText,
        openQuestions: [askText],
        category,
      };
    }

    if (!ruleResult.passes && initiator === 'owner') {
      // #127 — owner override is total and ONE-STEP. A broken own-day rule on a
      // slot the owner explicitly asked to book is not a question: record the
      // heads-up and FALL THROUGH to the book return so Maelle books it and says
      // "Booked — heads up, <rule>", instead of a blocking confirm_override that
      // cost a 2nd/3rd "yes". The attendee-busy gate below still confirms once —
      // double-booking a COLLEAGUE imposes on someone else, not just his own day.
      //
      // Because he IS booked either way, these notices are the only thing
      // standing between him and a silent double-booking — which is exactly what
      // a mis-ranked violation cost: v4.1.x put the lead-time rule ahead of the
      // occupancy scan, so "book 20 min with Alex at 3" at 14:15, on top of a
      // real 15:00 meeting, booked and said "heads up, that's too soon". The
      // validator now ranks the hard collision above every soft rule.
      //
      // A reported collision is NOT re-stated here: `unfilteredLevelNotice`
      // above already carries that same fact with the attendee count the label
      // doesn't have, and both would ride the one `overrideNotice` string — the
      // owner reading the same heads-up twice in one sentence (M9). Suppressing
      // it can never leave him with nothing: `owner_busy_collision` is only
      // returned when `overCommitment` is set and isFloatingBlock is false,
      // which is exactly the condition that set that notice.
      if (ruleResult.violation_kind !== 'owner_busy_collision') {
        ownerOverrideNotice = ruleResult.violation_label ?? 'a scheduling rule';
      }
    } else if (!ruleResult.passes) {
      ruleViolationLabel = ruleResult.violation_label ?? 'rule violated';
      const label = ruleViolationLabel;
      const subj = input.subject ?? 'this meeting';
      // M14 — the ONE dual-clock renderer. This string used to be formatted in
      // the owner's HOME zone with no zone label, while the `label` beside it
      // was rendered by checkSlot in the day's EFFECTIVE zone: on a trip day the
      // same message carried two different clocks for one instant.
      const askText = `Heads up — booking "${subj}" at ${whenText(input.slotStartIso, input.slotEndIso)} would break a rule: ${label}. Want to override?`;
      gates.push({ kind: 'rule', ask: askText });
      // v3.2.x (#8) — colleague proposed a slot that breaks a rule. Instead of
      // jumping straight to owner approval (colleague waits), offer NEARBY
      // rule-compliant alternatives first — the requested day, then forward —
      // via the SAME findAvailableSlots the booking flow uses (so they're
      // genuinely bookable). Whether the original time is a hard MUST is decided
      // AFTER, by the colleague's reply: if they insist (or none of these work),
      // Sonnet routes to create_approval. No regex, no extra planMeeting input.
      // Only when nothing nearby fits do we escalate straight away.
      // Skipped when the LOCATION question is also open: that gate takes
      // precedence in the combined return (an approval replayed with an
      // unresolved location just re-asks), so alternatives computed here would
      // be discarded — a Graph round-trip for nothing. The combined ask still
      // tells the colleague the rule is broken; the options come next round.
      if (!gates.some(g => g.kind === 'location')) try {
        const tzAlt = profile.user.timezone;
        const reqDay = DateTime.fromISO(input.slotStartIso, { zone: tzAlt });
        const durMin = input.durationMin
          ?? Math.max(15, Math.round(DateTime.fromISO(input.slotEndIso).diff(DateTime.fromISO(input.slotStartIso), 'minutes').minutes));
        const dayIso = reqDay.toFormat('yyyy-MM-dd');
        // How far forward "nearby" reaches, counted in days the owner actually
        // WORKS — resolved through getEffectiveWorkDay, the same accessor the
        // walker gates each cursor on (findAvailableSlots.ts:720) and the same
        // one checkSlot rule 1 reads, so this can never reach for a day the
        // search will refuse to walk.
        //
        // It used to be `+1 / +2 CALENDAR days`, which on Idan's Sun–Thu week is
        // Friday and Saturday for every THURSDAY request: the walker skipped
        // every cursor on both, the forward pass returned nothing, and a
        // colleague whose Thursday time broke a rule got escalate_approval — no
        // options at all — while the owner slept. It survived that long only
        // because the window was zero-width and autoExpand silently widened both
        // passes by +7d; closing that hole (correctly) exposed it.
        const FORWARD_WORKDAYS = 2;
        let lastDay = reqDay;
        for (let i = 1, found = 0; i <= 14 && found < FORWARD_WORKDAYS; i++) {
          const d = reqDay.plus({ days: i });
          if (!getEffectiveWorkDay(d.toFormat('yyyy-MM-dd'), profile).isWorkday) continue;
          lastDay = d;
          found++;
        }
        // ONE search across [requested day … last forward workday], then THE
        // spreader in its 'exhaustive' anchor mode. Two hand-sliced passes ("2
        // same-day + 1 later") were a second copy of what pickSpreadSlots does
        // better: the ≥1h gap keeps the options distinct and the budget is the
        // configured offered_slot_count (M6) instead of two literals. One search
        // also means one Graph round-trip instead of two.
        //
        // D3 — 'exhaustive', not the default. The default anchor mode is
        // day-diversity round-robin (the MOVE shape): the anchor picks first in
        // each round but every other day still takes one per round, so a budget
        // of 8 over Thu/Sun/Mon hands a colleague who asked for THURSDAY roughly
        // 3 Thu / 3 Sun / 2 Mon — five of his eight options on days he did not
        // ask about, two of them across a weekend. Owner's call: "if he asked
        // thursday, its thursday. if no options you can suggest to wide the
        // search and offer more.. but thursday ask is thursday." So the
        // requested day is filled to the budget first, later days only surface
        // once it is exhausted or empty, and they travel back in their OWN list
        // so the answer can name them as a widening.
        //
        // An alternative has to clear the SAME bars the requested slot was
        // measured against — otherwise Maelle refuses a time and then offers
        // something worse. Pre-fix this call carried only email/tz/duration/profile:
        //   • no `minBufferHours` → the walker's lead-time pre-filter AND
        //     checkSlot rule 0b were both off, so a colleague refused at 10:00
        //     for "12:00, you need 4h notice" was offered 10:30 and 11:00 —
        //     both SOONER, both looping straight back into the same refusal;
        //   • no `category` → the alternatives could break the very per-day /
        //     day-type cap the request broke (and the walker skips its
        //     week-widened event fetch, so the cap can't even be counted);
        //   • no `excludeEventIds` on a move → the meeting being moved blocks
        //     every slot around its own current time.
        const candidates = await findAvailableSlots({
          userEmail: profile.user.email,
          timezone: tzAlt,
          durationMinutes: durMin,
          profile,
          minBufferHours: bookingLeadTimeHours(profile, initiator),
          ...(category ? { category } : {}),
          ...(input.existingEventId ? { excludeEventIds: [input.existingEventId] } : {}),
          searchFrom: `${dayIso}T00:00:00`,
          searchTo: `${lastDay.toFormat('yyyy-MM-dd')}T23:59:59`,
          // Real day bounds (a bare `yyyy-MM-dd` on both ends is a ZERO-WIDTH
          // window — both resolve to 00:00 local — so `cursor + duration <=
          // searchEnd` never ran once), and the window stays where this caller
          // put it: "nearby" is the whole point of the offer, so no autoExpand.
          autoExpand: false,
        });
        const byStart = new Map(candidates.map(s => [s.start, s]));
        const picks = pickSpreadSlots(candidates, tzAlt, offeredSlotCount(profile), dayIso, durMin, 'exhaustive')
          .map(start => byStart.get(start))
          .filter((s): s is NonNullable<typeof s> => !!s);
        if (picks.length > 0) {
          const asAlternative = (s: (typeof picks)[number]) => ({
            start: s.start,
            end: s.end,
            // M14 — alternative labels quote the same dual clock as everything
            // else in this payload, so a trip-day option can't read home-only.
            label: whenText(s.start, s.end),
          });
          // slotLocalDay is the spreader's OWN day predicate — the same one that
          // decided the anchor pass — so the split can never disagree with the
          // pick order (a trip-day slot is classified by its trip day in both).
          alternativesRequestedDay = dayIso;
          ruleAlternatives = picks.filter(s => slotLocalDay(s, tzAlt) === dayIso).map(asAlternative);
          widenedAlternatives = picks.filter(s => slotLocalDay(s, tzAlt) !== dayIso).map(asAlternative);
          logger.info('planMeeting — colleague soft-rule slot, offering nearby alternatives', {
            label, requested: input.slotStartIso, requestedDay: dayIso,
            onRequestedDay: ruleAlternatives.length, widened: widenedAlternatives.length,
            searchTo: lastDay.toFormat('yyyy-MM-dd'), candidates: candidates.length,
          });
        }
      } catch (err) {
        logger.warn('planMeeting — alternative search threw, falling back to escalate_approval', {
          err: String(err).slice(0, 200),
        });
      }
    }

    // ── Owner-initiated: check internal-attendee freebusy (v2.7.1) ─────────
    // When the OWNER books/moves a meeting with internal attendees, confirm
    // they're free at the slot. Availability is a HELPER, never a blocker
    // (rule 6): on the FIRST pass we flag ONCE (confirm_override); once the
    // owner overrides (allowRelaxed), we DON'T re-ask and we DON'T silently
    // drop it — we book and ATTACH a heads-up naming who's busy (rule 7), so
    // the owner is always told. This also covers the policy_exception replay
    // (which runs with allowRelaxed): it books, and the owner hears who was busy
    // even if the original approval ask was about a different rule.
    //
    // Colleague-initiated path is NOT checked here. Slot finder already
    // annotates colleague-facing results with per-attendee status.
    if (initiator === 'owner' && nonOwnerParticipants.length > 0) {
      const ownerDomainLower = ownerEmail.split('@')[1].toLowerCase();
      const internalEmails: string[] = [];
      for (const p of nonOwnerParticipants) {
        const e = (p.email ?? '').toLowerCase();
        if (!e) continue;
        if (e.endsWith('@' + ownerDomainLower)) internalEmails.push(e);
      }
      if (internalEmails.length > 0) {
        try {
          // P15 — `notChecked` = the read never happened for this window. It used
          // to come back as `{}`, `fb[email] ?? []` read it as "free", and the
          // booking went through with no heads-up at all: the ONE place that tells
          // the owner "Simon is busy then" silently said nothing. Handled as a
          // NOTICE, not a block — an unread calendar is not evidence of a clash
          // either, and turning it into a confirm round would be #137 in reverse
          // (and would cost an M4 round on every Graph hiccup).
          const fbDiag: { notChecked?: string[] } = {};
          const fb = await getFreeBusy(
            ownerEmail, internalEmails,
            input.slotStartIso, input.slotEndIso,
            profile.user.timezone,
            input.allowRelaxed === true,   // override/replay reads fresh — never annotate a stale "busy"
            fbDiag,
          );
          const notChecked = fbDiag.notChecked ?? [];
          const slotStart = DateTime.fromISO(input.slotStartIso, { zone: profile.user.timezone, setZone: true });
          const slotEnd = DateTime.fromISO(input.slotEndIso, { zone: profile.user.timezone, setZone: true });
          // v2.8.5 — pre-compute prior-event window for source-event exclusion.
          // When intent==='move' and we have both prior bounds, busy windows
          // matching that exact span on attendee calendars are the meeting
          // being moved (still on their calendar until the move commits).
          // Skip them so the overlap check doesn't flag the source event as
          // a conflict with its own move target.
          const priorStart = input.priorSlotStartIso ? DateTime.fromISO(input.priorSlotStartIso, { zone: profile.user.timezone, setZone: true }) : null;
          const priorEnd = input.priorSlotEndIso ? DateTime.fromISO(input.priorSlotEndIso, { zone: profile.user.timezone, setZone: true }) : null;
          const hasPriorWindow = !!(priorStart && priorEnd);
          const busyAttendees: string[] = [];
          for (const email of internalEmails) {
            const slots = fb[email] ?? [];
            const overlap = slots.some(s => {
              if (s.status === 'free') return false;
              const sStart = DateTime.fromISO(s.start, { zone: (s as any)._timezone ?? 'utc' });
              const sEnd = DateTime.fromISO(s.end, { zone: (s as any)._timezone ?? 'utc' });
              // Skip the moving event's prior window. Allow a 60-second
              // tolerance per side for clock drift / TZ formatting noise.
              if (hasPriorWindow
                && Math.abs(sStart.diff(priorStart!, 'seconds').seconds) < 60
                && Math.abs(sEnd.diff(priorEnd!, 'seconds').seconds) < 60
              ) {
                return false;
              }
              return sStart < slotEnd && sEnd > slotStart;
            });
            if (overlap) busyAttendees.push(email);
          }
          if (busyAttendees.length > 0) {
            // Pretty-name each busy attendee via people_memory where possible.
            const names = busyAttendees.map(email => {
              try {
                const memMatches = (require('../../db/people') as typeof import('../../db/people'))
                  .searchPeopleMemory(email.split('@')[0]);
                const m = (memMatches ?? []).find((x: any) => x.email?.toLowerCase() === email);
                return m?.name?.split(' ')[0] ?? email.split('@')[0];
              } catch { return email.split('@')[0]; }
            });
            const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
            const label = `${who} ${names.length === 1 ? 'is' : 'are'} busy at this time`;
            logger.info('planMeeting — attendee busy collision', {
              busyAttendees, slot: input.slotStartIso, overridden: input.allowRelaxed === true,
            });
            if (input.allowRelaxed || intent === 'move') {
              // Owner override, approved-replay, OR any MOVE: book anyway and TELL him.
              // #A (2026-07-19) — a MOVE never blocks on an attendee conflict (owner's
              // rule: "book me 5 double meetings, but FLAG it"). A colleague-requested
              // move can re-land on a time that attendee is busy ("Intro with Maya");
              // surface it as a heads-up, don't cost a confirm. Fresh BOOKS still confirm
              // once below.
              attendeeBusyNotice = label;
            } else {
              // First-pass BOOK — flag ONCE; owner's "book anyway" comes back relaxed.
              // M4 — recorded as a gate, so if the location question is also open
              // it goes out in the SAME message instead of a second round.
              // M14 — one dual clock, quoted, never re-derived per string.
              const subj = input.subject ?? 'this meeting';
              const askText = `Heads up — ${who} ${names.length === 1 ? 'is' : 'are'} on another meeting at ${whenText(input.slotStartIso, input.slotEndIso)}. Book "${subj}" anyway, or pick a different time?`;
              attendeeBusyLabel = label;
              gates.push({ kind: 'attendee_busy', ask: askText });
            }
          } else if (notChecked.length > 0) {
            // P15 — nobody's calendar was read, so there is nothing to say about a
            // clash, and saying nothing is what made this a bug: the booking went
            // out looking verified. Rides the SAME notice channel a busy attendee
            // uses on the override/move path, so it books and the owner hears the
            // truth — "I couldn't check" — rather than a silence that reads as
            // "everyone's free" (M11).
            const who = notChecked.map(e => e.split('@')[0]).join(', ');
            logger.warn('planMeeting — attendee free/busy was never read for this slot', {
              notChecked, slot: input.slotStartIso,
            });
            attendeeBusyNotice = `I couldn't check ${who}'s availability for this time — their calendar didn't come back, so this isn't confirmed on their side`;
          }
        } catch (err) {
          // Permission errors (Calendars.Read) or transient Graph failures —
          // fail open. The owner-side rule check has already passed; trust
          // owner's judgment on the attendee side rather than block.
          logger.warn('planMeeting — attendee freebusy check threw, proceeding', {
            err: String(err).slice(0, 200), attendees: internalEmails,
          });
        }
      }
    }
  }

  // ── Book ────────────────────────────────────────────────────────────────
  // location/online + flags from the location verdict.
  let isOnline: boolean;
  let location: string;
  let addRoomEmail: boolean | undefined;
  let preserveExisting: boolean | undefined;
  if (locationVerdict && locationVerdict.kind === 'resolved') {
    isOnline = locationVerdict.isOnline;
    location = locationVerdict.location;
    addRoomEmail = locationVerdict.addRoomEmail;
  } else if (locationVerdict && locationVerdict.kind === 'preserve_existing') {
    isOnline = locationVerdict.isOnline;
    location = locationVerdict.location;
    preserveExisting = true;
  } else if (locationVerdict && locationVerdict.kind === 'skip_stamp') {
    // Logistic / Private category — no auto-stamp. Empty location, not online.
    isOnline = false;
    location = '';
  } else {
    // cancel intent (no slot) or unreachable fallback — default online
    isOnline = true;
    location = '';
  }

  // ── Meeting room availability ───────────────────────────────────────────
  // When the verdict pointed at the big Meeting Room (office day + internal
  // ≥4), check the room mailbox is actually free. Three outcomes:
  //   - free: proceed as-is.
  //   - busy + ≤5 people: swap to small-room label, drop the room mailbox.
  //   - busy + ≥6 people: refuse, surface ask to owner.
  // The ONE gate that genuinely depends on an earlier answer: it needs a
  // resolved location (addRoomEmail comes from the location verdict), so when
  // the location question is still open it is skipped rather than guessed.
  if (addRoomEmail && input.slotStartIso && input.slotEndIso) {
    try {
      const { checkMeetingRoomAvailability } = await import('../../utils/meetingRoomAvailability');
      const verdict = await checkMeetingRoomAvailability({
        profile,
        startIso: input.slotStartIso,
        endIso: input.slotEndIso,
        participantCount: participants.length,
      });
      if (verdict.kind === 'room_busy_small_fits') {
        location = verdict.smallLabel;
        addRoomEmail = false;
        logger.info('planMeeting — meeting room busy, falling back to small room label', {
          slot: input.slotStartIso, smallLabel: verdict.smallLabel,
          participantCount: participants.length,
        });
      } else if (verdict.kind === 'room_busy_too_big') {
        if (input.allowRelaxed) {
          // Owner override — a busy room is a HELPER signal, never a hard
          // blocker (rules 6/11). Book anyway; drop the busy room mailbox so we
          // don't double-book the room, and TELL him it's taken (rule 7) so he
          // can grab space himself. Was a hard refuse even under override — the
          // one availability check that still blocked the owner.
          addRoomEmail = false;
          roomBusyNotice = 'the meeting room is taken and the group is large — booked without it, you\'ll need to grab space';
          logger.info('planMeeting — meeting room busy + too large, owner override → booking without the room', {
            slot: input.slotStartIso, participantCount: participants.length,
          });
        } else {
          logger.info('planMeeting — meeting room busy + group too large for fallback', {
            slot: input.slotStartIso, participantCount: participants.length,
          });
          roomAskText = verdict.suggestedAskText;
          gates.push({ kind: 'room', ask: verdict.suggestedAskText });
        }
      }
    } catch (err) {
      // Fail open: if anything throws, proceed with the original verdict.
      logger.warn('planMeeting — meeting room availability check threw, proceeding', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // ── ONE combined ask (M4) ───────────────────────────────────────────────
  // Every gate that could be evaluated has been. If any is open, return a
  // SINGLE action carrying ALL of the questions — the action KIND is the
  // highest-precedence gate so existing handler branches are unchanged, and
  // `openQuestions` is the complete set for the handler to relay in one message.
  //
  // Precedence — location first on purpose: it is a prerequisite for a
  // well-formed booking (an approval replayed with an unresolved location just
  // re-asks), so its handler note is the one that should drive the retry.
  if (gates.length > 0) {
    const openQuestions = gates.map(g => g.ask);
    const suggestedAskText = openQuestions.join(' ');
    logger.info('planMeeting — returning combined ask', {
      gates: gates.map(g => g.kind), count: gates.length, intent, initiator,
    });
    if (gates.some(g => g.kind === 'location')) {
      return {
        action: 'ask_location_mode',
        suggestedAskText,
        openQuestions,
        category,
        reasoning: locationAskReasoning ?? 'location mode unresolved',
      };
    }
    if (ruleViolationLabel) {
      // Colleague-path rule break (the owner's is a one-step notice, never a
      // gate). Nearby compliant options first; escalate only if none fit —
      // "none" means neither the requested day NOR the widening produced one.
      return (ruleAlternatives.length + widenedAlternatives.length) > 0
        ? {
            action: 'propose_alternative',
            violationLabel: ruleViolationLabel,
            suggestedAskText,
            openQuestions,
            alternatives: ruleAlternatives,
            widenedAlternatives,
            requestedDay: alternativesRequestedDay,
            category,
          }
        : {
            action: 'escalate_approval',
            violationLabel: ruleViolationLabel,
            suggestedAskText,
            openQuestions,
            category,
          };
    }
    if (roomAskText) {
      return {
        action: 'room_unavailable_large',
        suggestedAskText,
        openQuestions,
        category,
        reasoning: 'meeting room mailbox busy and ≥6 people — small fallback not viable',
      };
    }
    return {
      action: 'confirm_override',
      violationLabel: attendeeBusyLabel ?? 'needs your confirmation',
      suggestedAskText,
      openQuestions,
      category,
    };
  }

  return {
    action: 'book',
    isOnline,
    location,
    addRoomEmail,
    preserveExisting,
    category,
    level: bookingLevel,
    reasoning: `category=${category ?? 'none'} (${categoryReason}); location=${locationVerdict?.reasoning ?? 'n/a'}; level=${bookingLevel ?? 'n/a'}`,
    // M3 — the level notices ride the SAME heads-up channel as #127's rule
    // notice, so "booked over your optional standup" and "this double-books you
    // over X with 2 people on it" reach the owner instead of a confirmation
    // that reads identical to booking a genuinely free slot.
    overrideNotice: [ownerOverrideNotice, unfilteredLevelNotice, optionalLevelNotice, attendeeBusyNotice, roomBusyNotice]
      .filter(Boolean).join('; ') || undefined,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// D4 — no catch, deliberately. This is the event set checkSlot validates the
// booking against; returning `[]` on a Graph fault told the validator the owner
// had nothing on his calendar, so every rule passed and the write went straight
// over whatever was really there. A read that fails now throws
// CalendarOfflineError (one retry already spent inside), the tool surface turns
// it into "his calendar is offline", and nothing is booked on a guess.
async function loadEventsForCheck(profile: UserProfile, slotStartIso: string): Promise<CalendarEvent[]> {
  const tz = profile.user.timezone;
  const start = DateTime.fromISO(slotStartIso, { zone: tz, setZone: true }).setZone(tz).startOf('week');
  const end = start.plus({ weeks: 2 });
  return getOwnerEventsForDecision(profile.user.email, start.toFormat('yyyy-MM-dd'), end.toFormat('yyyy-MM-dd'), tz);
}

function sameDayType(profile: UserProfile, isoA: string, isoB: string): boolean {
  const tz = profile.user.timezone;
  const dayA = DateTime.fromISO(isoA, { zone: tz, setZone: true }).setZone(tz).toFormat('EEEE');
  const dayB = DateTime.fromISO(isoB, { zone: tz, setZone: true }).setZone(tz).toFormat('EEEE');
  const office = profile.schedule.office_days.days as string[];
  const home = profile.schedule.home_days.days as string[];
  const typeOf = (d: string): 'office' | 'home' | 'off' =>
    office.includes(d) ? 'office' : home.includes(d) ? 'home' : 'off';
  return typeOf(dayA) === typeOf(dayB);
}

function pickCanonicalCategory(profile: UserProfile, raw: string[]): string | null {
  const cats = profile.categories ?? [];
  const lowered = raw.map(s => s.toLowerCase());
  for (const c of cats) {
    if (lowered.includes(c.name.toLowerCase())) return c.name;
  }
  return null;
}

