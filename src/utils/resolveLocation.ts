/**
 * resolveLocation (v2.8.2 rewrite) — single source of truth for "where does
 * this meeting happen?"
 *
 * Deterministic decision tree. Categories no longer influence location.
 * The tree, top-down:
 *
 *   0. PRESERVE (move intent only):
 *      intent='move' + day-type didn't flip + no owner hint
 *      → return preserve_existing. Caller leaves location/isOnline alone.
 *
 *   1. OWNER-EXPLICIT HINT:
 *      ownerLocationHint OR ownerIsOnlineHint set → respect.
 *
 *   2. TRAVEL OVERRIDE:
 *      Any participant remote/traveling → online; caller patches the location
 *      field with the Teams join URL after Graph createEvent.
 *
 *   3. OFFICE DAY:
 *      a. External attendee + known-different TZ
 *         → online; teams URL as location (post-create patch).
 *      b. External attendee + same TZ OR unknown TZ
 *         → ask_owner_online_or_physical. Caller refuses + asks owner.
 *      c. Internal-only, count ≥4
 *         → meeting_room_label + addRoomEmail + isOnline=true
 *         (Teams link goes in body, not location).
 *      d. Internal-only, count ≤3
 *         → short_label + isOnline=true
 *         (Teams link goes in body, not location).
 *
 *   4. HOME DAY:
 *      a. External attendee → online; teams URL as location (post-create patch).
 *      b. Internal-only → "Huddle", isOnline=false.
 *
 *   5. NON-WORK DAY (Fri/Sat for an Israeli profile, etc.):
 *      Resolve location anyway — the BOOK decision in planMeeting handles the
 *      OOF refusal. Default to online; teams URL as location.
 *
 * Output flavors:
 *   - resolved          : caller stamps location/isOnline directly, plus an
 *                         optional addRoomEmail flag that ops.ts acts on.
 *   - preserve_existing : caller leaves existing event location/isOnline as-is.
 *   - ask_owner         : caller refuses + relays the suggested ask.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { getEffectiveWorkDayForInstant } from './workHours';

export interface ResolveLocationInput {
  profile: UserProfile;
  startIso: string;
  intent: 'new_booking' | 'move' | 'cancel';

  // Detected category (from detectCategory) — drives the no-stamp skip when
  // the category is flagged `no_default_location: true` (Logistic / floating
  // blocks) or `sets_sensitivity_private: true` (Private / personal events).
  category?: string | null;

  // Party shape
  participantCount: number;                 // total including owner + externals
  hasExternalAttendee: boolean;

  // TZ signal for office+external case (path 3a vs 3b)
  externalAttendeeInDifferentTz?: boolean;  // undefined = unknown → ask path

  // Travel state
  anyParticipantRemote?: boolean;

  // Owner-explicit hints (Sonnet passes these via tool args)
  ownerLocationHint?: string;
  ownerIsOnlineHint?: boolean;

  // v3.2.6 (RC4) — who's driving this booking. On the COLLEAGUE path a bare
  // `is_online=true` is Sonnet-derived, not a real request (the colleague
  // asked for a normal meeting; nobody asked for online). We don't let it
  // force an online-only meeting — it falls through to the day-type tree
  // (office on an office day, online on a home/remote day). On owner-path (or
  // when unset, for back-compat) the hint is honored as before. A genuine
  // remote signal still wins regardless via `anyParticipantRemote` / the
  // different-TZ branches below.
  initiatorRole?: 'owner' | 'colleague';

  // Move-only inputs (drive the preserve path)
  priorStartIso?: string;
  existingLocation?: string;
  existingIsOnline?: boolean;
}

export type LocationVerdict =
  | {
      kind: 'resolved';
      isOnline: boolean;
      location: string;
      addRoomEmail?: boolean;          // ops.ts adds profile.meetings.room_email as optional attendee
      reasoning: string;
    }
  | { kind: 'preserve_existing'; isOnline: boolean; location: string; reasoning: string }
  | { kind: 'ask_owner_online_or_physical'; suggestedAskText: string; reasoning: string }
  | {
      // Categories flagged `no_default_location` (Logistic / floating blocks)
      // or `sets_sensitivity_private` (Private / personal events). Caller
      // passes location='' + isOnline=false; no Teams URL patch, no room
      // email. Sonnet decides whether to ask owner (prompt rule handles the
      // Private case — "where should this private event be?").
      kind: 'skip_stamp';
      reasoning: string;
    };

const HUDDLE_LABEL = 'Huddle';

export function resolveLocation(input: ResolveLocationInput): LocationVerdict {
  const { profile } = input;
  const tz = profile.user.timezone;
  const dt = DateTime.fromISO(input.startIso).setZone(tz);
  // v3.7.x (#143) — day type from the effective work day (yaml base + per-date
  // override), so an "office Tuesday" / "home Friday" override drives the location
  // stamp. No override → identical to the office_days/home_days name check. An
  // away day resolves as neither → falls through to the online default (5).
  const effectiveDay = getEffectiveWorkDayForInstant(input.startIso, profile);
  const isOfficeDay = effectiveDay.location === 'office';
  const isHomeDay = effectiveDay.location === 'home';

  // ── (0) PRESERVE on move when day-type didn't flip and no owner hint ────
  const hasOwnerHint =
    (input.ownerLocationHint && input.ownerLocationHint.trim().length > 0) ||
    input.ownerIsOnlineHint !== undefined;

  if (
    input.intent === 'move' &&
    !hasOwnerHint &&
    input.priorStartIso &&
    input.existingLocation !== undefined &&
    input.existingIsOnline !== undefined
  ) {
    // v3.7.x (#143) — compare EFFECTIVE day types (override-aware), so a move
    // between two days whose override day-type matches still preserves.
    const priorEff = getEffectiveWorkDayForInstant(input.priorStartIso, profile);
    if (priorEff.location === effectiveDay.location) {
      return {
        kind: 'preserve_existing',
        isOnline: input.existingIsOnline,
        location: input.existingLocation,
        reasoning: `move within same day-type (${effectiveDay.location}) — preserving existing location`,
      };
    }
  }

  // ── (1) OWNER-EXPLICIT HINT ─────────────────────────────────────────────
  if (input.ownerLocationHint && input.ownerLocationHint.trim().length > 0) {
    const loc = input.ownerLocationHint.trim();
    const isPhone = /^\+?\d[\d\s\-().]{5,}$/.test(loc);
    if (isPhone) {
      return { kind: 'resolved', isOnline: false, location: loc, reasoning: 'owner-explicit phone location' };
    }
    return {
      kind: 'resolved',
      isOnline: input.ownerIsOnlineHint === true,
      location: loc,
      reasoning: 'owner-explicit location string',
    };
  }
  // Owner explicit is_online=true with no location → online, teams URL as location.
  // v3.2.6 (RC4) — only honored when the OWNER is driving (or role unset,
  // back-compat). On colleague-path this flag is Sonnet-derived with no real
  // request behind it, so we DON'T force online-only here — fall through to the
  // day-type tree (internal + same-TZ + office-day → office with a Teams backup
  // link, never Teams-as-location). A real remote signal still forces online
  // via anyParticipantRemote / the different-TZ branches.
  if (input.ownerIsOnlineHint === true && input.initiatorRole !== 'colleague') {
    return {
      kind: 'resolved',
      isOnline: true,
      location: '',      reasoning: 'owner-explicit is_online=true → Teams URL as location',
    };
  }
  // Owner explicit is_online=false with no location → physical, but we still
  // need to decide WHICH physical label. Fall through to day-type defaults,
  // forcing isOnline=false at the resolved branch.
  const ownerForcedPhysical = input.ownerIsOnlineHint === false;

  // ── (1.5) CATEGORY-DRIVEN SKIP ──────────────────────────────────────────
  // Categories flagged `no_default_location: true` (Logistic / floating
  // blocks) OR `sets_sensitivity_private: true` (Private / personal) skip
  // the auto-stamp entirely. The event lands with no location and no Teams
  // link. For Private, the prompt rule tells Sonnet to ask the owner where
  // the event should be before booking. Owner-explicit hints (path 1 above)
  // override this skip — that's where "I'm meeting Amazia at my home" wins
  // over the Huddle / no-stamp default.
  if (input.category) {
    const cat = (profile.categories ?? []).find(c => c.name === input.category);
    if (cat && (cat.no_default_location === true || cat.sets_sensitivity_private === true)) {
      return {
        kind: 'skip_stamp',
        reasoning: `category ${cat.name} flagged ${cat.no_default_location ? 'no_default_location' : 'sets_sensitivity_private'} — no auto-stamp`,
      };
    }
  }

  // ── (2) TRAVEL OVERRIDE ─────────────────────────────────────────────────
  if (input.anyParticipantRemote && !ownerForcedPhysical) {
    return {
      kind: 'resolved',
      isOnline: true,
      location: '',      reasoning: 'participant traveling/remote — online with Teams URL as location',
    };
  }

  const officeLoc = profile.meetings.office_location;
  const firstName = profile.user.name.split(' ')[0];
  const shortLabel = officeLoc?.short_label || `${firstName} Office`;
  const meetingRoomLabel = officeLoc?.meeting_room_label || 'Meeting Room';
  const fullLabel = officeLoc?.full_label || shortLabel;

  // ── (3) OFFICE DAY ──────────────────────────────────────────────────────
  if (isOfficeDay) {
    if (input.hasExternalAttendee) {
      // (3a) Known-different TZ → online auto.
      if (input.externalAttendeeInDifferentTz === true) {
        if (ownerForcedPhysical) {
          // Owner said in-person — respect, stamp the full address.
          return {
            kind: 'resolved',
            isOnline: false,
            location: fullLabel,
            reasoning: 'office day + external (different TZ) + owner forced physical',
          };
        }
        return {
          kind: 'resolved',
          isOnline: true,
          location: '',          reasoning: 'office day + external in different TZ → online (Teams URL as location)',
        };
      }
      // (3b) Owner forced physical → stamp full address, no ask needed.
      if (ownerForcedPhysical) {
        return {
          kind: 'resolved',
          isOnline: false,
          location: fullLabel,
          reasoning: 'office day + external + owner forced physical',
        };
      }
      // Same TZ OR unknown TZ AND no owner hint.
      // v3.2.6 (RC4 follow-up) — on the COLLEAGUE path, don't raise an
      // "online or physical?" approval to the owner: that's friction for a
      // booking a colleague is driving, and it was a regression from RC4
      // (which stopped honoring the online hint on colleague-path, sending
      // external office-day meetings here instead of just booking online).
      // An external guest with unknown/same TZ defaults to ONLINE (Teams) —
      // the safe no-assumption default; no approval. Owner-path still asks,
      // so the owner gets to decide his own external meetings.
      if (input.initiatorRole === 'colleague') {
        return {
          kind: 'resolved',
          isOnline: true,
          location: '',          reasoning: 'office day + external (colleague-path) → default online, no owner approval',
        };
      }
      return {
        kind: 'ask_owner_online_or_physical',
        suggestedAskText: `Office day with an external guest — online or physical at ${fullLabel}?`,
        reasoning: input.externalAttendeeInDifferentTz === false
          ? 'office day + external in same TZ → must ask owner'
          : 'office day + external with unknown TZ → must ask owner',
      };
    }
    // Internal-only on office day.
    if (input.participantCount >= 4) {
      // (3c) Big internal → Meeting Room + room_email + Teams in body.
      return {
        kind: 'resolved',
        isOnline: !ownerForcedPhysical,
        location: meetingRoomLabel,
        addRoomEmail: true,
        reasoning: `office day + internal ≥4 → ${meetingRoomLabel} (+ room email, Teams backup in body)`,
      };
    }
    // (3d) Small internal → short_label + Teams in body.
    return {
      kind: 'resolved',
      isOnline: !ownerForcedPhysical,
      location: shortLabel,
      reasoning: `office day + internal ≤3 → ${shortLabel} (Teams backup in body)`,
    };
  }

  // ── (4) HOME DAY ────────────────────────────────────────────────────────
  if (isHomeDay) {
    if (input.hasExternalAttendee && !ownerForcedPhysical) {
      // (4a) External on home day → online; Teams URL as location.
      return {
        kind: 'resolved',
        isOnline: true,
        location: '',        reasoning: 'home day + external → online (Teams URL as location)',
      };
    }
    if (input.hasExternalAttendee && ownerForcedPhysical) {
      // Owner forced physical with an external on a home day — owner is
      // probably hosting at home. Stamp short_label as best-effort label;
      // owner-explicit text hint is the proper channel for "my home".
      return {
        kind: 'resolved',
        isOnline: false,
        location: shortLabel,
        reasoning: 'home day + external + owner forced physical (fallback to short label)',
      };
    }
    // (4b) Internal-only on home day → Huddle.
    return {
      kind: 'resolved',
      isOnline: false,
      location: HUDDLE_LABEL,
      reasoning: 'home day + internal-only → Huddle',
    };
  }

  // ── (5) NON-WORK DAY ────────────────────────────────────────────────────
  // OOF refusal is the booking layer's job, not location's. Just pick a
  // sensible default so the event has SOMETHING if it does get booked.
  if (ownerForcedPhysical) {
    return {
      kind: 'resolved',
      isOnline: false,
      location: shortLabel,
      reasoning: 'non-work day + owner forced physical (fallback to short label)',
    };
  }
  return {
    kind: 'resolved',
    isOnline: true,
    location: '',    reasoning: 'non-work day → default online (Teams URL as location)',
  };
}
