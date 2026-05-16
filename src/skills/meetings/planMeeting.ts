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
import { getCalendarEvents, getFreeBusy, type CalendarEvent } from '../../connectors/graph/calendar';
import { resolveLocation, type LocationVerdict } from '../../utils/resolveLocation';
import { checkSlot, type RuleCheckResult } from '../../utils/scheduleRules';
import { detectCategory } from './detectCategory';
import { findMeetingOwner, type MeetingOwnerInfo } from './findMeetingOwner';
import { getCurrentTravel, getPersonMemory, searchPeopleMemory } from '../../db/people';
import logger from '../../utils/logger';

// ── Input shapes ────────────────────────────────────────────────────────────

export type IntentKind = 'new_booking' | 'move' | 'cancel' | 'find_slots';

export interface PlanParticipant {
  email?: string;
  name?: string;
  slack_id?: string;
  just_invite?: boolean;
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

  // Participants
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

  // Owner-explicit override (e.g. "yes book it even though it breaks the rule")
  allowRelaxed?: boolean;

  // Floating-block booking path (lunch / focus / gym). Skips the owner_busy_collision
  // rule — floating blocks are signals, not competing time. See scheduleRules.checkSlot.
  isFloatingBlock?: boolean;

  // Optional pre-fetched calendar (saves a Graph call when caller already has it)
  preloadedEvents?: CalendarEvent[];
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
    }
  | { action: 'find_slots'; category: string | null; reasoning: string }
  | { action: 'confirm_override'; violationLabel: string; suggestedAskText: string; category: string | null }
  | { action: 'escalate_approval'; violationLabel: string; suggestedAskText: string; category: string | null }
  | { action: 'decline_and_relay'; organizerName: string | null; organizerEmail: string | null; organizerSlackId: string | null; suggestedDmText: string }
  | { action: 'refuse_not_owners'; organizerName: string | null; organizerEmail: string | null }
  | { action: 'ask_location_mode'; suggestedAskText: string; category: string | null; reasoning: string }
  | { action: 'room_unavailable_large'; suggestedAskText: string; category: string | null; reasoning: string };

// ── Entry ───────────────────────────────────────────────────────────────────

export async function planMeeting(input: PlanMeetingInput): Promise<PlanAction> {
  const { profile, intent, initiator } = input;
  const ownerEmail = profile.user.email;

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
          && participantEmail(input.participants, input.initiatorSlackId, profile) === ownerInfo.organizerEmail);
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
  for (const p of input.participants) {
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
        attendees: input.participants,
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
    // new_booking / find_slots — always detect
    if (input.subject || input.participants.length > 0) {
      const det = await detectCategory({
        profile,
        subject: input.subject ?? '(no subject)',
        body: input.body,
        attendees: input.participants,
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
  if (input.slotStartIso) {
    const ownerDomain = ownerEmail.split('@')[1].toLowerCase();
    const externalEmails: string[] = [];
    for (const p of input.participants) {
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
      participantCount: input.participants.length + 1,  // +1 for owner
      hasExternalAttendee: hasExternal,
      externalAttendeeInDifferentTz,
      anyParticipantRemote,
      ownerLocationHint: input.locationHint,
      ownerIsOnlineHint: input.isOnlineHint,
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
    const ruleResult = checkSlot({
      profile,
      slotStartIso: input.slotStartIso,
      slotEndIso: input.slotEndIso,
      category,
      events,
      excludeEventIds: input.existingEventId ? [input.existingEventId] : [],
      allowRelaxed: !!input.allowRelaxed,
      isFloatingBlock: !!input.isFloatingBlock,
    });

    if (!ruleResult.passes) {
      const label = ruleResult.violation_label ?? 'rule violated';
      const ownerFirst = profile.user.name.split(' ')[0];
      const subj = input.subject ?? 'this meeting';
      const askText = `Heads up — booking "${subj}" at ${DateTime.fromISO(input.slotStartIso).setZone(profile.user.timezone).toFormat("EEEE 'at' HH:mm")} would break a rule: ${label}. Want to override?`;
      if (initiator === 'owner') {
        return { action: 'confirm_override', violationLabel: label, suggestedAskText: askText, category };
      }
      return { action: 'escalate_approval', violationLabel: label, suggestedAskText: askText, category };
    }

    // ── Owner-initiated: check internal-attendee freebusy (v2.7.1) ─────────
    // Design intent: when the OWNER asks Maelle to book / move a meeting that
    // has internal attendees, planMeeting must confirm those attendees are
    // free at the chosen slot. Otherwise the meeting silently lands on top
    // of someone's existing time. Override path stays open — owner can say
    // "do it anyway" and the retry with allowRelaxed bypasses the check.
    //
    // Colleague-initiated path is NOT checked here. Slot finder
    // (annotateSlotsWithAttendeeStatus) already annotates colleague-facing
    // results with per-attendee status — that's annotation, not a block.
    if (initiator === 'owner' && !input.allowRelaxed && input.participants.length > 0) {
      const ownerDomainLower = ownerEmail.split('@')[1].toLowerCase();
      const internalEmails: string[] = [];
      for (const p of input.participants) {
        const e = (p.email ?? '').toLowerCase();
        if (!e) continue;
        if (e === ownerEmail.toLowerCase()) continue;       // skip owner himself
        if (e.endsWith('@' + ownerDomainLower)) internalEmails.push(e);
      }
      if (internalEmails.length > 0) {
        try {
          const fb = await getFreeBusy(
            ownerEmail, internalEmails,
            input.slotStartIso, input.slotEndIso,
            profile.user.timezone,
          );
          const slotStart = DateTime.fromISO(input.slotStartIso);
          const slotEnd = DateTime.fromISO(input.slotEndIso);
          const busyAttendees: string[] = [];
          for (const email of internalEmails) {
            const slots = fb[email] ?? [];
            const overlap = slots.some(s => {
              if (s.status === 'free') return false;
              const sStart = DateTime.fromISO(s.start, { zone: (s as any)._timezone ?? 'utc' });
              const sEnd = DateTime.fromISO(s.end, { zone: (s as any)._timezone ?? 'utc' });
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
            const subj = input.subject ?? 'this meeting';
            const askText = `Heads up — ${who} ${names.length === 1 ? 'is' : 'are'} on another meeting at ${DateTime.fromISO(input.slotStartIso).setZone(profile.user.timezone).toFormat("EEEE 'at' HH:mm")}. Book "${subj}" anyway, or pick a different time?`;
            logger.info('planMeeting — attendee busy collision', {
              busyAttendees, slot: input.slotStartIso,
            });
            return { action: 'confirm_override', violationLabel: label, suggestedAskText: askText, category };
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
        participantCount: input.participants.length + 1,
      });
      if (verdict.kind === 'room_busy_small_fits') {
        location = verdict.smallLabel;
        addRoomEmail = false;
        logger.info('planMeeting — meeting room busy, falling back to small room label', {
          slot: input.slotStartIso, smallLabel: verdict.smallLabel,
          participantCount: input.participants.length + 1,
        });
      } else if (verdict.kind === 'room_busy_too_big') {
        logger.info('planMeeting — meeting room busy + group too large for fallback', {
          slot: input.slotStartIso, participantCount: input.participants.length + 1,
        });
        return {
          action: 'room_unavailable_large',
          suggestedAskText: verdict.suggestedAskText,
          category,
          reasoning: 'meeting room mailbox busy and ≥6 people — small fallback not viable',
        };
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
