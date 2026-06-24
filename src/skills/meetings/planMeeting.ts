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
 *   decline_and_relay     — owner-attendee cancel asked → decline-on-owner-side + DM organizer
 *   refuse_not_owners     — owner-attendee move asked → polite refuse, no DM (per D4)
 *
 * Pipeline (strict order):
 *   1. LOAD STATE          day type, working hours, existing event metadata
 *   2. DETECT CATEGORY     (new bookings) OR USE EXISTING (existing events)
 *                          For moves: re-detect only when day type changed (per Q2)
 *   3. RESOLVE LOCATION    via utils/resolveLocation
 *   4. CHECK RULES         via utils/scheduleRules
 *   5. DECIDE ACTION       branches on initiator + ownership + rule result
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../../config/userProfile';
import { getCalendarEvents, getFreeBusy, findAvailableSlots, type CalendarEvent } from '../../connectors/graph/calendar';
import { resolveLocation, type LocationVerdict } from '../../utils/resolveLocation';
import { checkSlot, type RuleCheckResult } from '../../utils/scheduleRules';
import { detectCategory } from './detectCategory';
import { findMeetingOwner, type MeetingOwnerInfo } from './findMeetingOwner';
import { getCurrentTravel, getPersonMemory, searchPeopleMemory } from '../../db/people';
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
  initiatorSlackId: string;          // who's asking right now

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

  // #WE-spine — owner verified the working-elsewhere trip-time. Distinct from
  // allowRelaxed (which only relaxes RULES): this is the ONE signal that skips the
  // WE trip-time confirm, set on the owner's yes-retry — never proactively — so a
  // proactive relaxed can't silently book a wrong trip-time.
  weAcknowledged?: boolean;

  // Floating-block booking path (lunch / focus / gym). Skips the owner_busy_collision
  // rule — floating blocks are signals, not competing time. See scheduleRules.checkSlot.
  isFloatingBlock?: boolean;

  // Optional pre-fetched calendar (saves a Graph call when caller already has it)
  preloadedEvents?: CalendarEvent[];
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
    initiatorSlackId: req.initiatorSlackId,
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
    existingEventId: req.existingEventId,
    existingEventCategories: req.existingEventCategories,
    existingEventLocation: req.existingEventLocation,
    existingEventIsOnline: req.existingEventIsOnline,
    priorSlotStartIso: req.priorSlotStartIso,
    priorSlotEndIso: req.priorSlotEndIso,
    allowRelaxed: req.relaxed,
    weAcknowledged: req.weAcknowledged,
    isFloatingBlock: req.isFloatingBlock,
    preloadedEvents: extra?.preloadedEvents,
  };
}

// ── Plan output ─────────────────────────────────────────────────────────────

export type PlanAction =
  | {
      action: 'book';
      isOnline: boolean;
      location: string;
      addRoomEmail?: boolean;          // ops.ts adds profile.meetings.room_email as optional attendee
      teamsUrlAsLocation?: boolean;    // ops.ts patches location.displayName with onlineMeeting.joinUrl after create
      preserveExisting?: boolean;      // ops.ts leaves the existing event's location/isOnline alone (move case)
      category: string | null;
      reasoning: string;
      overrideNotice?: string;   // #127 — owner booked through a soft own-day rule; surface this heads-up, never re-ask
    }
  | { action: 'find_slots'; category: string | null; reasoning: string }
  | { action: 'confirm_override'; violationLabel: string; suggestedAskText: string; category: string | null }
  | { action: 'escalate_approval'; violationLabel: string; suggestedAskText: string; category: string | null }
  | { action: 'propose_alternative'; violationLabel: string; suggestedAskText: string; alternatives: Array<{ start: string; end: string; label: string }>; category: string | null }
  | { action: 'decline_and_relay'; organizerName: string | null; organizerEmail: string | null; organizerSlackId: string | null; suggestedDmText: string }
  | { action: 'refuse_not_owners'; organizerName: string | null; organizerEmail: string | null }
  | { action: 'ask_location_mode'; suggestedAskText: string; category: string | null; reasoning: string }
  | { action: 'room_unavailable_large'; suggestedAskText: string; category: string | null; reasoning: string };

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
      // intent === 'cancel'
      // Per D3: if asker == requester/organizer, JUST do it (decline owner side).
      const askerIsOwnerOfMeeting =
        (ownerInfo.requesterSlackId && input.initiatorSlackId === ownerInfo.requesterSlackId) ||
        (ownerInfo.organizerEmail && ownerEmail !== ownerInfo.organizerEmail
          && participantEmail(participants, input.initiatorSlackId, profile) === ownerInfo.organizerEmail);
      if (askerIsOwnerOfMeeting) {
        // Just decline on owner's side — the asker owns the meeting.
        return {
          action: 'book',
          isOnline: false, location: '', category: null,
          reasoning: 'asker is the meeting requester/organizer — decline owner side directly',
        };
      }
      // Asker != owner of meeting → decline-and-relay (per Q1=B for owner ask, D3 for colleague ask)
      const target = ownerInfo.organizerName ?? ownerInfo.organizerEmail ?? 'the organizer';
      const ownerFirst = profile.user.name.split(' ')[0];
      return {
        action: 'decline_and_relay',
        organizerName: ownerInfo.organizerName,
        organizerEmail: ownerInfo.organizerEmail,
        organizerSlackId: ownerInfo.requesterSlackId,
        suggestedDmText: `Hey${ownerInfo.organizerName ? ' ' + ownerInfo.organizerName.split(' ')[0] : ''} — ${ownerFirst} won't be able to make "${input.subject ?? 'the meeting'}" anymore. I've removed it from his side. If you'd like to cancel for everyone, just let me know.`,
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
      if (travel) anyParticipantRemote = true;
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
    if (locationVerdict.kind === 'ask_owner_online_or_physical') {
      return {
        action: 'ask_location_mode',
        suggestedAskText: locationVerdict.suggestedAskText,
        category,
        reasoning: locationVerdict.reasoning,
      };
    }
  }

  // ── Check rules ─────────────────────────────────────────────────────────
  if (input.slotStartIso && input.slotEndIso) {
    const events = input.preloadedEvents ?? await loadEventsForCheck(profile, input.slotStartIso);

    // #WE-spine — Working-Elsewhere routing: RELAX + APPROVE. On a day the owner
    // is travelling his home rules don't cleanly apply (different place + clock),
    // so we relax them and route the booking to his approval (colleague) / a
    // one-step dual-TZ confirm (owner) — never silently auto-book a trip-day slot
    // in the wrong clock. Resolved via the ONE resolver (marker + travel record)
    // so search and book agree on which days are WE. `allowRelaxed` (the owner
    // already confirmed, or an approved replay) falls through to book. No marker
    // and no covering travel record → isAway=false → no-op, byte-identical to a
    // normal day. The dual-TZ ask renders ONE instant in both zones (slotStartIso
    // is owner-zone after the write-path guess removal), so the owner sees e.g.
    // "11:00 Boston / 18:00 your time" and confirms the right moment.
    let onWorkingElsewhereDay = false;
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const we = require('../../utils/workingElsewhere') as typeof import('../../utils/workingElsewhere');
      const slotDate = DateTime.fromISO(input.slotStartIso, { zone: profile.user.timezone }).toFormat('yyyy-MM-dd');
      const travel = await we.resolveOwnerTravelContextForDate(slotDate, profile.user.slack_user_id, profile.user.timezone, events);
      if (travel.isAway) {
        onWorkingElsewhereDay = true;   // → relax the home rules in checkSlot below
        // CRITICAL: this trip-time confirm is DECOUPLED from `relaxed`. `relaxed`
        // overrides the RULES; it must NOT also skip the time check — else a
        // proactive relaxed=true ("don't check their time, just do it") silently
        // books a wrong trip-time (the Offensive-hub "02:15" crash, where the
        // model mis-resolved "after lunch" and relaxed skipped the confirm). The
        // ONLY skip is `weAcknowledged`, set on the owner's yes-retry (never
        // proactively); a colleague's owner-approved replay carries allowRelaxed,
        // which satisfies the skip on that path.
        const acknowledged = input.weAcknowledged === true
          || (initiator !== 'owner' && input.allowRelaxed === true);
        if (!acknowledged) {
          const ownerFirst = profile.user.name.split(' ')[0];
          const loc = travel.location ? ` (${travel.location})` : '';
          const instant = DateTime.fromISO(input.slotStartIso, { zone: profile.user.timezone });
          const awayClock = instant.setZone(travel.effectiveTz);   // same instant, where he is
          const sameTz = travel.effectiveTz === profile.user.timezone;
          const awayPart = `${awayClock.toFormat('HH:mm')} ${travel.location || 'there'}`;
          const whereDay = awayClock.toFormat('EEEE');   // the day where he physically is (decision #2)
          logger.info('planMeeting — working-elsewhere day, verify trip-time before book', {
            slotDate, location: travel.location, effectiveTz: travel.effectiveTz, initiator,
            relaxed: input.allowRelaxed === true,
          });
          if (initiator === 'owner') {
            const dual = sameTz ? instant.toFormat('HH:mm') : `${awayPart} / ${instant.toFormat('HH:mm')} your time`;
            return {
              action: 'confirm_override',
              violationLabel: `working elsewhere${loc}`,
              suggestedAskText: `You're working elsewhere${loc} on ${whereDay} — this slot is ${dual}. Confirm that's the time you want (your usual rules are relaxed there); on your yes, retry the SAME tool with we_acknowledged=true.`,
              category,
            };
          }
          const dual = sameTz ? instant.toFormat('HH:mm') : `${awayPart} / ${instant.toFormat('HH:mm')} ${ownerFirst}'s time`;
          return {
            action: 'escalate_approval',
            violationLabel: 'owner_working_elsewhere',
            suggestedAskText: `Heads up — ${ownerFirst} is working elsewhere${loc} on ${whereDay} (this slot is ${dual}), so I'd run it by him before booking. Want me to check with him?`,
            category,
          };
        }
      }
    }

    const ruleResult = checkSlot({
      profile,
      slotStartIso: input.slotStartIso,
      slotEndIso: input.slotEndIso,
      category,
      events,
      excludeEventIds: input.existingEventId ? [input.existingEventId] : [],
      // #WE-spine — a travel day relaxes the owner's home rules (they don't apply
      // in the trip place); the trip-time was already verified by the confirm above.
      allowRelaxed: !!input.allowRelaxed || onWorkingElsewhereDay,
      isFloatingBlock: !!input.isFloatingBlock,
    });

    if (!ruleResult.passes && ruleResult.violation_kind === 'in_the_past') {
      // A past / earlier-today time is almost always a typo, not an override —
      // so it is NOT one-step-booked (that would book into the past) and NOT
      // offered alternatives as if it were a soft conflict. Flag ONCE, for both
      // owner and colleague: "that time's passed — did you mean later?" The
      // owner's "yes / I meant it" retry comes back allowRelaxed, which checkSlot
      // then lets through (he can log a past meeting if he truly insists).
      const askText = `That time has already passed — did you mean later today, or a different day?`;
      return { action: 'confirm_override', violationLabel: 'that time has already passed', suggestedAskText: askText, category };
    }

    if (!ruleResult.passes && initiator === 'owner') {
      // #127 — owner override is total and ONE-STEP. A broken own-day rule on a
      // slot the owner explicitly asked to book is not a question: record the
      // heads-up and FALL THROUGH to the book return so Maelle books it and says
      // "Booked — heads up, <rule>", instead of a blocking confirm_override that
      // cost a 2nd/3rd "yes". The attendee-busy gate below still confirms once —
      // double-booking a COLLEAGUE imposes on someone else, not just his own day.
      ownerOverrideNotice = ruleResult.violation_label ?? 'a scheduling rule';
    } else if (!ruleResult.passes) {
      const label = ruleResult.violation_label ?? 'rule violated';
      const subj = input.subject ?? 'this meeting';
      const askText = `Heads up — booking "${subj}" at ${DateTime.fromISO(input.slotStartIso).setZone(profile.user.timezone).toFormat("EEEE 'at' HH:mm")} would break a rule: ${label}. Want to override?`;
      // v3.2.x (#8) — colleague proposed a slot that breaks a rule. Instead of
      // jumping straight to owner approval (colleague waits), offer NEARBY
      // rule-compliant alternatives first — 2 on the requested day + 1 after —
      // via the SAME findAvailableSlots the booking flow uses (so they're
      // genuinely bookable). Whether the original time is a hard MUST is decided
      // AFTER, by the colleague's reply: if they insist (or none of these work),
      // Sonnet routes to create_approval. No regex, no extra planMeeting input.
      // Only when nothing nearby fits do we escalate straight away.
      try {
        const tzAlt = profile.user.timezone;
        const reqDay = DateTime.fromISO(input.slotStartIso, { zone: tzAlt });
        const durMin = input.durationMin
          ?? Math.max(15, Math.round(DateTime.fromISO(input.slotEndIso).diff(DateTime.fromISO(input.slotStartIso), 'minutes').minutes));
        const attendeeEmails = nonOwnerParticipants
          .map(p => (p.email ?? '').trim())
          .filter((e): e is string => e.length > 0);
        const dayIso = reqDay.toFormat('yyyy-MM-dd');
        const after1 = reqDay.plus({ days: 1 }).toFormat('yyyy-MM-dd');
        const after2 = reqDay.plus({ days: 2 }).toFormat('yyyy-MM-dd');
        const base = { userEmail: profile.user.email, timezone: tzAlt, durationMinutes: durMin, attendeeEmails, profile };
        const sameDay = await findAvailableSlots({ ...base, searchFrom: dayIso, searchTo: dayIso });
        const later = await findAvailableSlots({ ...base, searchFrom: after1, searchTo: after2 });
        const picks = [...sameDay.slice(0, 2), ...later.slice(0, 1)];
        if (picks.length > 0) {
          const alternatives = picks.map(s => {
            const st = DateTime.fromISO(s.start).setZone(tzAlt);
            const en = DateTime.fromISO(s.end).setZone(tzAlt);
            return { start: s.start, end: s.end, label: `${st.toFormat('EEE d MMM HH:mm')}–${en.toFormat('HH:mm')}` };
          });
          logger.info('planMeeting — colleague soft-rule slot, offering nearby alternatives', {
            label, count: alternatives.length, requested: input.slotStartIso,
          });
          return { action: 'propose_alternative', violationLabel: label, suggestedAskText: askText, alternatives, category };
        }
      } catch (err) {
        logger.warn('planMeeting — alternative search threw, falling back to escalate_approval', {
          err: String(err).slice(0, 200),
        });
      }
      return { action: 'escalate_approval', violationLabel: label, suggestedAskText: askText, category };
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
          const fb = await getFreeBusy(
            ownerEmail, internalEmails,
            input.slotStartIso, input.slotEndIso,
            profile.user.timezone,
            input.allowRelaxed === true,   // override/replay reads fresh — never annotate a stale "busy"
          );
          const slotStart = DateTime.fromISO(input.slotStartIso);
          const slotEnd = DateTime.fromISO(input.slotEndIso);
          // v2.8.5 — pre-compute prior-event window for source-event exclusion.
          // When intent==='move' and we have both prior bounds, busy windows
          // matching that exact span on attendee calendars are the meeting
          // being moved (still on their calendar until the move commits).
          // Skip them so the overlap check doesn't flag the source event as
          // a conflict with its own move target.
          const priorStart = input.priorSlotStartIso ? DateTime.fromISO(input.priorSlotStartIso) : null;
          const priorEnd = input.priorSlotEndIso ? DateTime.fromISO(input.priorSlotEndIso) : null;
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
            if (input.allowRelaxed) {
              // Owner override (or approved-replay): book anyway, but TELL him.
              attendeeBusyNotice = label;
            } else {
              // First pass — flag ONCE; owner's "book anyway" comes back relaxed.
              const subj = input.subject ?? 'this meeting';
              const askText = `Heads up — ${who} ${names.length === 1 ? 'is' : 'are'} on another meeting at ${DateTime.fromISO(input.slotStartIso).setZone(profile.user.timezone).toFormat("EEEE 'at' HH:mm")}. Book "${subj}" anyway, or pick a different time?`;
              return { action: 'confirm_override', violationLabel: label, suggestedAskText: askText, category };
            }
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
  let teamsUrlAsLocation: boolean | undefined;
  let preserveExisting: boolean | undefined;
  if (locationVerdict && locationVerdict.kind === 'resolved') {
    isOnline = locationVerdict.isOnline;
    location = locationVerdict.location;
    addRoomEmail = locationVerdict.addRoomEmail;
    teamsUrlAsLocation = locationVerdict.teamsUrlAsLocation;
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
          return {
            action: 'room_unavailable_large',
            suggestedAskText: verdict.suggestedAskText,
            category,
            reasoning: 'meeting room mailbox busy and ≥6 people — small fallback not viable',
          };
        }
      }
    } catch (err) {
      // Fail open: if anything throws, proceed with the original verdict.
      logger.warn('planMeeting — meeting room availability check threw, proceeding', {
        err: String(err).slice(0, 200),
      });
    }
  }

  return {
    action: 'book',
    isOnline,
    location,
    addRoomEmail,
    teamsUrlAsLocation,
    preserveExisting,
    category,
    reasoning: `category=${category ?? 'none'} (${categoryReason}); location=${locationVerdict?.reasoning ?? 'n/a'}`,
    overrideNotice: [ownerOverrideNotice, attendeeBusyNotice, roomBusyNotice].filter(Boolean).join('; ') || undefined,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function loadEventsForCheck(profile: UserProfile, slotStartIso: string): Promise<CalendarEvent[]> {
  const tz = profile.user.timezone;
  const start = DateTime.fromISO(slotStartIso).setZone(tz).startOf('week');
  const end = start.plus({ weeks: 2 });
  try {
    return await getCalendarEvents(profile.user.email, start.toFormat('yyyy-MM-dd'), end.toFormat('yyyy-MM-dd'), tz);
  } catch (err) {
    logger.warn('planMeeting — loadEventsForCheck threw, returning empty list', {
      err: String(err).slice(0, 200),
    });
    return [];
  }
}

function sameDayType(profile: UserProfile, isoA: string, isoB: string): boolean {
  const tz = profile.user.timezone;
  const dayA = DateTime.fromISO(isoA).setZone(tz).toFormat('EEEE');
  const dayB = DateTime.fromISO(isoB).setZone(tz).toFormat('EEEE');
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

function participantEmail(parts: PlanParticipant[], slackId: string, profile: UserProfile): string | null {
  const found = parts.find(p => p.slack_id === slackId);
  if (found?.email) return found.email.toLowerCase();
  // owner case
  if (profile.user.slack_user_id === slackId) return profile.user.email.toLowerCase();
  // v2.7.0 — legacy-meeting fallback (e.g. Yael cancelling her own Calendly
  // meeting that wasn't booked via Maelle). participants[] is [] for
  // cancel/move intents, but the asker's slack_id resolves to an email
  // through people_memory. Lets us compare asker-email to organizer-email
  // so "asker IS organizer" detection works for legacy events too.
  try {
    const mem = getPersonMemory(slackId);
    if (mem?.email) return mem.email.toLowerCase();
  } catch {
    // fail open — null forces decline_and_relay which is the conservative outcome
  }
  return null;
}
