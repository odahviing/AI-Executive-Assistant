/**
 * Nearby compliant alternatives (v4.2.x) — THE one "that time doesn't work, here
 * is one that does" computation, and the point-check's use of it.
 *
 * ── WHY THIS FILE EXISTS (M2) ───────────────────────────────────────────────
 * Three surfaces answer the same question — "can this named time hold a
 * meeting?" — and all three run the SAME validator (`checkSlot`):
 *
 *   1. the booking path            planMeeting → propose_alternative
 *   2. the search, given a time    find_available_slots + preferred_slot
 *   3. the point-check             availabilityPreCheck (colleague path)
 *
 * (1) and (2) both answer a failing time with ALTERNATIVES: planMeeting ran its
 * own nearby search and returned `propose_alternative`; the search re-checks the
 * preferred slot and tells the drafter to name the real reason and then "offer the
 * alternatives in `slots`". (3) answered with the verdict alone and stopped.
 *
 * That divergence is the 2026-07-27 incident. Three client-call times were
 * proposed in an MPIM, all three came back `bookable:false` (log :187), and the
 * drafting context held not one bookable instant — so the only move left was to
 * ask permission to look: "want me to pull other options that week instead, or
 * should I lock in Tuesday or Wednesday anyway?". The owner's answer was "all
 * those dates are booked and I didn't know it, where is my options?" — and he is
 * right twice over: M2, because one decision gave two answers depending on which
 * surface asked it, and M4, because a question whose answer is always yes is a
 * wasted round, not service.
 *
 * So the computation lives once, here, and both callers get the same instants
 * from the same search. `findNearbyAlternatives` is planMeeting's own block moved
 * out with ONE generalization — it takes the set of days the asker named rather
 * than a single day, because a point-check turn routinely carries three.
 *
 * ── WHY CODE AND NOT PROSE ──────────────────────────────────────────────────
 * A prompt line can only ask the model to call a tool, and the incident already
 * shows what that is worth: she knew the tool existed (she offered to run it) and
 * still shipped a question instead of options. More decisively, alternatives have
 * to clear the same bars the refused slot was measured against — the same lead
 * time, the same category cap, the same commitments — which is a computation, not
 * a judgment. Prose here only RENDERS instants this file already computed, the
 * way the point-check's own verdict block renders verdicts it already computed.
 *
 * ── WHAT THIS BLOCK DOES NOT DECIDE ─────────────────────────────────────────
 * It adds options. It does NOT rule on what happens to the times that failed —
 * those are decided per slot, by the point-check's own verdict lines, which split
 * a HARD calendar fact (never push through it) from an owner-overridable rule
 * (his call, escalate on insist, #128). The first draft of this block closed with
 * "do NOT ask which of the blocked times to push through", which was wrong twice:
 * it restated a rule the hard-block line and the output-time floor already own,
 * and — sitting last, in the strongest position — it suppressed the ESCALATION
 * the SOFT line mandates, quietly narrowing #128's scope on the one surface that
 * had no business touching it. The booking path has always offered alternatives
 * to the soft tier AND kept the escalation ("Do NOT escalate yet… if they INSIST,
 * THEN create_approval" — createMeeting.ts:854, moveMeeting.ts:1151), so both
 * belong here too. The closing text now defers to those lines explicitly instead
 * of competing with them, and this file holds no copy of the tier split.
 *
 * ── HONESTY BAR ─────────────────────────────────────────────────────────────
 * The block this file renders makes NO claim about the proposals. It cannot: the
 * point-check emits one verdict per slot it actually TESTED — a slot whose
 * `checkSlot` throws pushes none (availabilityPreCheck.ts, the catch), and pairs
 * are capped — so "none of the three work" is a sentence nobody here is entitled
 * to. The verdict lines above it already enumerate exactly the tested slots and
 * nothing else; this block adds times that DO work and explicitly forbids
 * counting the ones that don't.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../../config/userProfile';
import {
  findAvailableSlots,
  pickSpreadSlots,
  slotLocalDay,
} from '../../connectors/graph/calendar';
import { bookingLeadTimeHours, offeredSlotCount } from '../../utils/scheduleRules';
import { getEffectiveWorkDay } from '../../utils/workHours';
import { profileDualClock } from '../../utils/weTimeResolver';
import type { SubjectViewer } from '../../utils/displaySubject';
import logger from '../../utils/logger';

/** How far past the last day the asker named "nearby" reaches, counted in days
 *  the owner actually WORKS (never calendar days — see the walk below). */
const FORWARD_WORKDAYS = 2;

export interface NearbyAlternative {
  start: string;
  end: string;
  /** The dual clock, rendered ONCE by the producer (M14) — quote it verbatim. */
  label: string;
  /**
   * M3 — set when this slot is only free because a SKIPPABLE Working-Elsewhere
   * commitment is treated as optional. It is bookable, but it is the fallback
   * tier: Free first, Optional only when there is no Free. Carried so a narrating
   * surface can order and mark it; `checkSlot` masks a private subject before it
   * can reach this string (findAvailableSlots.ts — viewer default is the
   * colleague-safe one, and this search never overrides it) and, since v4.4.9
   * (#154), masks it just the same for a non-attendee colleague even when it
   * ISN'T private, via `viewerEmail` above.
   */
  overOptional?: string;
}

export interface NearbyAlternativesResult {
  /** The days the asker named, normalized + sorted. */
  anchorDays: string[];
  /** Picks landing ON one of those days. */
  onAnchorDays: NearbyAlternative[];
  /** Picks past them — present as an explicit widening, never as the ask. */
  beyond: NearbyAlternative[];
}

/**
 * Rule-compliant options at or just after the day(s) the asker named.
 *
 * Every parameter that constrains the search is REQUIRED to be passed by the
 * caller rather than defaulted here, because each one is a way for an
 * alternative to be worse than the time it replaces:
 *   • `initiator` → the booking lead time. Without it a colleague refused at
 *     10:00 for "12:00 needs 4h notice" was offered 10:30 and 11:00 — both
 *     SOONER, both looping straight back into the same refusal.
 *   • `category`  → the per-day / day-type cap. Without it the alternatives can
 *     break the very cap the request broke (and the walker skips its week-widened
 *     event fetch, so the cap cannot even be counted).
 *   • `excludeEventIds` → on a move, the meeting being moved otherwise blocks
 *     every slot around its own current time.
 *
 * Never throws: a Graph failure returns an empty result and the caller falls back
 * to whatever it does with no alternatives.
 */
export async function findNearbyAlternatives(params: {
  profile: UserProfile;
  /** yyyy-MM-dd, one per day the asker named. At least one. */
  anchorDays: string[];
  durationMin: number;
  initiator: 'owner' | 'colleague';
  category?: string | null;
  excludeEventIds?: string[];
  /** FRAMING of the rendered label only — never forwarded to the search. */
  viewer?: SubjectViewer;
  /**
   * v4.4.9 (#154) — UNLIKE `viewer` above, this DOES reach the search: it's
   * the attendee-aware half of the mask on `over_optional`'s subject (a
   * non-attendee colleague must never see it, private or not), and that mask
   * is applied at the producer (checkSlot), not in this file's rendering.
   */
  viewerEmail?: string | null;
}): Promise<NearbyAlternativesResult> {
  const { profile, durationMin, initiator } = params;
  const tz = profile.user.timezone;
  const empty: NearbyAlternativesResult = { anchorDays: [], onAnchorDays: [], beyond: [] };

  const anchorDays = [...new Set(params.anchorDays)]
    .filter(d => DateTime.fromISO(d, { zone: tz }).isValid)
    .sort();
  if (anchorDays.length === 0 || !(durationMin > 0)) return empty;

  try {
    const firstDay = anchorDays[0];
    const lastNamed = DateTime.fromISO(anchorDays[anchorDays.length - 1], { zone: tz });

    // The forward reach is counted in WORKDAYS, resolved through
    // getEffectiveWorkDay — the same accessor the walker gates each cursor on and
    // the same one checkSlot rule 1 reads — so this can never reach for a day the
    // search will refuse to walk. It used to be "+1 / +2 CALENDAR days", which on
    // a Sun–Thu week is Friday and Saturday for every THURSDAY request: the
    // walker skipped every cursor on both and the forward pass returned nothing.
    let lastDay = lastNamed;
    for (let i = 1, found = 0; i <= 14 && found < FORWARD_WORKDAYS; i++) {
      const d = lastNamed.plus({ days: i });
      if (!getEffectiveWorkDay(d.toFormat('yyyy-MM-dd'), profile).isWorkday) continue;
      lastDay = d;
      found++;
    }

    // ONE search across [first named day … last forward workday], then THE
    // spreader. Real day bounds on both ends (a bare `yyyy-MM-dd` twice is a
    // ZERO-WIDTH window — both resolve to 00:00 local — so `cursor + duration <=
    // searchEnd` never runs once), and the window stays where we put it: "nearby"
    // is the whole point of the offer, so no autoExpand.
    const candidates = await findAvailableSlots({
      userEmail: profile.user.email,
      timezone: tz,
      durationMinutes: durationMin,
      profile,
      minBufferHours: bookingLeadTimeHours(profile, initiator),
      ...(params.category ? { category: params.category } : {}),
      ...(params.excludeEventIds && params.excludeEventIds.length > 0
        ? { excludeEventIds: params.excludeEventIds }
        : {}),
      searchFrom: `${firstDay}T00:00:00`,
      searchTo: `${lastDay.toFormat('yyyy-MM-dd')}T23:59:59`,
      autoExpand: false,
      // v4.4.9 (#154) — see the field doc above: `viewer` itself stays
      // colleague-safe by default (never forwarded), but this attendee-aware
      // half still needs to reach checkSlot so `over_optional` masks correctly
      // for a non-attendee colleague.
      viewerEmail: params.viewerEmail,
    });

    // Anchor mode follows how many days were actually named, and the two cases
    // are genuinely different products:
    //   • ONE named day → 'exhaustive' on it (owner 2026-07-26: "if he asked
    //     thursday, its thursday"). That day is drained to the budget through the
    //     full tier ladder before any other day is considered.
    //   • SEVERAL named days → no single day is "the" ask, so day-diversity
    //     round-robin across the whole window. Draining the earliest to the
    //     budget would answer "options that week" with Tuesday five times.
    const budget = offeredSlotCount(profile);
    const picks = anchorDays.length === 1
      ? pickSpreadSlots(candidates, tz, budget, firstDay, durationMin, 'exhaustive')
      : pickSpreadSlots(candidates, tz, budget, undefined, durationMin, 'first_round');

    const byStart = new Map(candidates.map(s => [s.start, s]));
    const whenText = profileDualClock(profile, params.viewer);
    const anchorSet = new Set(anchorDays);
    const onAnchorDays: NearbyAlternative[] = [];
    const beyond: NearbyAlternative[] = [];
    for (const start of picks) {
      const slot = byStart.get(start);
      if (!slot) continue;
      const alt: NearbyAlternative = {
        start: slot.start,
        end: slot.end,
        label: whenText(slot.start, slot.end),
        ...(slot.over_optional ? { overOptional: slot.over_optional } : {}),
      };
      // slotLocalDay is the spreader's OWN day predicate — the same one that
      // decided the pick order — so the split can never disagree with it (a
      // trip-day slot is classified by its trip day in both).
      if (anchorSet.has(slotLocalDay(slot, tz))) onAnchorDays.push(alt);
      else beyond.push(alt);
    }

    logger.info('findNearbyAlternatives — searched', {
      anchorDays, durationMin, initiator,
      category: params.category ?? null,
      searchTo: lastDay.toFormat('yyyy-MM-dd'),
      candidates: candidates.length,
      onAnchorDays: onAnchorDays.length,
      beyond: beyond.length,
    });
    return { anchorDays, onAnchorDays, beyond };
  } catch (err) {
    logger.warn('findNearbyAlternatives — search threw; no alternatives', {
      err: String(err).slice(0, 200),
    });
    return empty;
  }
}

// ── The point-check's use of it ──────────────────────────────────────────────

/** The subset of a point-check verdict this needs. Structural on purpose — it
 *  reads three fields and nothing else, so the producer's shape can grow without
 *  reaching in here. */
interface TestedSlot {
  date: string;   // YYYY-MM-DD
  time: string;   // HH:MM
  bookable: boolean;
}

/**
 * The point-check's alternatives block: "" unless EVERY slot the point-check
 * tested this turn came back not-bookable and the search found something.
 *
 * The predicate lives here, not at the call site, so the trigger and the
 * computation cannot drift apart — and note what it deliberately is NOT: it is
 * "every TESTED slot", never "every proposed slot". One bookable verdict anywhere
 * stands the whole thing down, because then the drafter already has something to
 * offer and a second list would only compete with it.
 *
 * Fires at most once per turn and costs one Graph round-trip, on the one shape of
 * turn where the drafter otherwise has nothing — a rare turn, and the expensive
 * one.
 */
export async function blockedSlotAlternativesBlock(params: {
  profile: UserProfile;
  /** Every verdict the point-check produced this turn — TESTED slots only. */
  verdicts: TestedSlot[];
  /** The meeting length the point-check validated, so the options are the length
   *  that was actually asked for (a 60-min client call is not answered with 25s). */
  durationMinutes: number;
  /** The category the point-check enforced, so an alternative cannot break the
   *  same cap the proposal broke. */
  category?: string | null;
  /** Whose booking lead time the point-check held. */
  initiator: 'owner' | 'colleague';
  /** For binding a pick back to its exact instant — omit and nothing is stashed. */
  channelId?: string;
  threadTs?: string;
}): Promise<string> {
  const { profile, verdicts } = params;
  if (verdicts.length === 0) return '';
  if (verdicts.some(v => v.bookable)) return '';

  const result = await findNearbyAlternatives({
    profile,
    anchorDays: verdicts.map(v => v.date),
    durationMin: params.durationMinutes,
    initiator: params.initiator,
    category: params.category ?? null,
    // The point-check is the colleague surface; the label takes the named
    // third-person framing, and the search keeps its colleague-safe default.
    viewer: 'other',
  });
  const total = result.onAnchorDays.length + result.beyond.length;
  if (total === 0) {
    logger.info('blockedSlotAlternativesBlock — every tested slot blocked, but the search found no alternative either', {
      tested: verdicts.length, anchorDays: result.anchorDays,
    });
    return '';
  }

  // These times are about to be said aloud, so a pick from either list has to
  // bind to its exact instant on the next turn. ONE recorder, shared with
  // planMeeting's propose_alternative — including its deliberate omission of
  // searchFingerprint, for the same reason: these came from a nearby-search, not
  // from a requester-shaped find_available_slots call.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { recordProposedAlternatives } = require('./ops/helpers') as
    typeof import('./ops/helpers');
  recordProposedAlternatives({
    channelId: params.channelId,
    threadTs: params.threadTs,
    timezone: profile.user.timezone,
    alternatives: result.onAnchorDays,
    widenedAlternatives: result.beyond,
  });

  logger.info('blockedSlotAlternativesBlock — injected alternatives for an all-blocked point-check', {
    tested: verdicts.length,
    onAnchorDays: result.onAnchorDays.length,
    beyond: result.beyond.length,
  });

  const ownerFirst = profile.user.name.split(' ')[0];
  // M3 — Free before Optional, in the narration too. `pickSpreadSlots` already
  // orders the clean tier first; the note carries the priority to the reader
  // without naming the mechanism behind it (colleague surface — never a rule
  // name, never the blocking event).
  const line = (a: NearbyAlternative): string =>
    `  - ${a.label}${a.overOptional ? ' — take this one only if the others do not work' : ''}`;
  const sections = [
    result.onAnchorDays.length > 0 ? result.onAnchorDays.map(line).join('\n') : '',
    result.beyond.length > 0
      ? `  Further out, if none of the above suit:\n${result.beyond.map(line).join('\n')}`
      : '',
  ].filter(Boolean);

  return `## TIMES THAT DO WORK (deterministic — the same search the booking flow runs)

Not one of the times I checked above came back bookable, so I ran the real search rather than leave you with nothing to offer. Every time below is genuinely bookable for ${ownerFirst} right now — same rules, same validator, and none of them sits on anything he is committed to:

${sections.join('\n')}

OFFER THESE TIMES IN THIS REPLY. Do NOT ask whether to go and look for other options — the looking is already done, and asking spends a round on an answer that is always yes. Quote each time exactly as written above; do not re-derive, re-word or convert it.
What to do about the times that did NOT work is decided by their OWN lines above, one by one — follow each line, including where it tells you the time is ${ownerFirst}'s to override and to raise it for his decision if they want that exact slot. This list changes none of that; it only means you are never left with nothing to offer.
Never state or imply a COUNT of what did not work ("none of your three", "all of them are booked", "your whole week"): the lines above cover the times I TESTED, which is not necessarily every time mentioned in this thread.`;
}
