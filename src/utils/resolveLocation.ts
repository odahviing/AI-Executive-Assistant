/**
 * resolveLocation (v2.7.0) — single source of truth for "where does this
 * meeting happen?"
 *
 * Replaces the v2.6.x `determineSlotLocation` + `helperForcesOnline` +
 * `skipLocationField` mess in skills/meetings/ops.ts. One function, one
 * decision tree, one output: { isOnline, location, reasoning }.
 *
 * Priority chain (highest first):
 *   1. Owner-explicit hints (location string OR is_online boolean)
 *      → owner just said what they want, respect it.
 *   2. Travel state — any participant currently traveling / remote-only
 *      → force online with empty location (can't physically meet).
 *   3. Vacation / OOF day for owner
 *      → return refuse_book (caller should not book on this day).
 *   4. Category default — `default_location` + `default_is_online` flags.
 *      Per D1 owner direction: home day stays home day. A category that
 *      says "office" will conflict with home day → rule engine catches.
 *   5. Day-type defaults:
 *      - office_day + internal ≤3 → Reflectiz HQ (full address + parking)
 *      - office_day + internal >3 → "Meeting Room"
 *      - office_day + external    → Reflectiz HQ + Teams (hybrid)
 *      - home_day + internal      → Huddle, no Teams
 *      - home_day + external      → Teams only (per D2)
 *      - default                  → online (matches yaml owner direction "default is online")
 *
 * Output `isOnline=true` means Teams link is on the invite. Office-day
 * physical meetings ARE hybrid (Teams link + physical room).
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';

export interface ResolveLocationInput {
  profile: UserProfile;
  startIso: string;
  category: string | null;                  // detected category name (from yaml) or null
  participantCount: number;                 // total attendees including externals
  hasExternalAttendee: boolean;
  anyParticipantRemote?: boolean;           // someone traveling / remote-only

  ownerLocationHint?: string;               // what Sonnet passed via args.location
  ownerIsOnlineHint?: boolean;              // what Sonnet passed via args.is_online
}

export type LocationVerdict =
  | { kind: 'resolved'; isOnline: boolean; location: string; reasoning: string }
  | { kind: 'no_default_location_category'; reasoning: string }
  | { kind: 'refuse_vacation_or_oof'; reasoning: string };

export function resolveLocation(input: ResolveLocationInput): LocationVerdict {
  const { profile } = input;
  const ownerName = profile.user.name.split(' ')[0];
  const dt = DateTime.fromISO(input.startIso).setZone(profile.user.timezone);
  const dayName = dt.toFormat('EEEE');
  const isOfficeDay = (profile.schedule.office_days.days as string[]).includes(dayName);
  const isHomeDay = (profile.schedule.home_days.days as string[]).includes(dayName);
  const isVacationDay = !isOfficeDay && !isHomeDay;  // Fri/Sat etc.

  // ── (1) Owner-explicit hints ────────────────────────────────────────────
  // Sonnet passed both → trust both, with normalization for phone-as-location.
  if (input.ownerLocationHint && input.ownerLocationHint.trim().length > 0) {
    const loc = input.ownerLocationHint.trim();
    const isPhone = /^\+?\d[\d\s\-().]{5,}$/.test(loc);
    if (isPhone) {
      return { kind: 'resolved', isOnline: false, location: loc, reasoning: 'owner-explicit phone location' };
    }
    // Owner gave a physical location — respect, but also keep Teams link if owner said is_online=true
    return {
      kind: 'resolved',
      isOnline: input.ownerIsOnlineHint === true,
      location: loc,
      reasoning: 'owner-explicit location string',
    };
  }
  // Owner explicit is_online=false WITHOUT a location → don't auto-stamp office;
  // they may want to add it later.
  if (input.ownerIsOnlineHint === false) {
    return { kind: 'resolved', isOnline: false, location: '', reasoning: 'owner-explicit is_online=false, no location supplied' };
  }

  // ── (2) Travel / remote state ───────────────────────────────────────────
  if (input.anyParticipantRemote) {
    return { kind: 'resolved', isOnline: true, location: '', reasoning: 'someone traveling/remote — forced online' };
  }

  // ── (3) Vacation / OOF ──────────────────────────────────────────────────
  if (isVacationDay) {
    return { kind: 'refuse_vacation_or_oof', reasoning: `${dayName} is not a working day for ${ownerName}` };
  }

  // ── (4) Category-driven default ─────────────────────────────────────────
  // Categories carry { default_location, default_is_online, no_default_location }.
  // Per yaml schema: 'office' | 'online' | 'custom_required' | 'none'.
  if (input.category) {
    const cat = (profile.categories ?? []).find(c => c.name === input.category);
    if (cat) {
      if (cat.no_default_location) {
        return { kind: 'no_default_location_category', reasoning: `category ${cat.name} flagged no_default_location` };
      }
      if (cat.default_location === 'online') {
        return { kind: 'resolved', isOnline: true, location: '', reasoning: `category ${cat.name} default=online` };
      }
      if (cat.default_location === 'office') {
        const loc = formatOfficeLocation(profile);
        const isOnline = cat.default_is_online !== false;  // default hybrid
        return { kind: 'resolved', isOnline, location: loc, reasoning: `category ${cat.name} default=office (hybrid=${isOnline})` };
      }
      if (cat.default_location === 'custom_required') {
        // Caller must ask owner for venue — no auto-stamp.
        return { kind: 'resolved', isOnline: false, location: '', reasoning: `category ${cat.name} requires custom venue (caller must ask)` };
      }
      // default_location === 'none' or unset → fall through to day-type defaults
    }
  }

  // ── (5) Day-type defaults ───────────────────────────────────────────────
  if (isOfficeDay) {
    // Office day: address + Teams link (hybrid) for ≤3 internal; meeting room for big.
    const internalCount = input.participantCount - (input.hasExternalAttendee ? 1 : 0);
    if (!input.hasExternalAttendee && internalCount > 3) {
      return { kind: 'resolved', isOnline: true, location: 'Meeting Room', reasoning: 'office day, internal >3 people' };
    }
    return {
      kind: 'resolved',
      isOnline: true,
      location: formatOfficeLocation(profile),
      reasoning: input.hasExternalAttendee ? 'office day, external present (hybrid)' : 'office day, internal ≤3 (hybrid)',
    };
  }

  if (isHomeDay) {
    if (input.hasExternalAttendee) {
      // Per D2: external + home day → Teams only.
      return { kind: 'resolved', isOnline: true, location: '', reasoning: 'home day, external present (Teams only)' };
    }
    // Internal only on home day → Huddle (no Teams).
    return { kind: 'resolved', isOnline: false, location: 'Huddle', reasoning: 'home day, internal only (Huddle)' };
  }

  // Safety fallback (shouldn't reach — vacation handled above)
  return { kind: 'resolved', isOnline: true, location: '', reasoning: 'fallback: default online' };
}

function formatOfficeLocation(profile: UserProfile): string {
  const officeLoc = profile.meetings.office_location;
  if (!officeLoc) return `${profile.user.name.split(' ')[0]}'s Office`;
  const parts: string[] = [];
  if (officeLoc.label) parts.push(officeLoc.label);
  if (officeLoc.address) parts.push(officeLoc.address);
  if (officeLoc.parking) parts.push(`Parking: ${officeLoc.parking}`);
  return parts.join(' — ');
}
