/**
 * Availability floor (v4.2.x) — the output-time gate that a slot the rule-aware
 * check ESTABLISHED as unavailable may never be described to anyone as workable.
 *
 * WHAT THIS GUARD IS FOR. A time that `checkSlot` has established as a HARD block
 * on the owner's calendar may not be described to anyone as workable. The failure it
 * exists to stop ends outside the system: a colleague told a taken slot is free
 * sends a real invite, and that is not undone by a correction three messages later.
 *
 * ⚠ ITS FOUNDING INCIDENT WAS MISREAD, and the record has to say so (v4.2.2). It was
 * built from the 2026-07-27 MPIM (logs :184-:215): three proposed slots, `bookable:0
 * notBookable:3` (:187), a draft telling the owner two of them were "tighter than
 * your usual, workable if you want to push through", then telling the colleague they
 * "work on his end" — who replied "I will send an invite". Read as three hard blocks
 * sold as workable. The thread record refutes it: the same reply renders the all-day
 * line verbatim for the third slot ("you're away that whole day") and uses the
 * point-check's own NOT CLEAN label for the other two ("not clean as-is"), so those
 * two were the OWNER-OVERRIDABLE tier — which this floor deliberately does not arm
 * (see HARD_FLOOR_KINDS) — and the drafter was faithful to all three lines. What
 * made it look otherwise is that `notBookable` summed both tiers; the point-check
 * now logs them apart. So this guard would NOT have fired on the incident it was
 * built for, and it was not supposed to.
 *
 * ⚠ AND ITS PRODUCTION RECORD IS 0 CATCHES, 4 FALSE FIRES — the first two on its
 * first day, both from bad INPUT rather than bad judgement, and both now closed
 * upstream:
 *   • :743 — rewrote an honest "ich halte mir 16:00 CET frei" into a false collision
 *     claim, off a ledger entry for 16:00 Israel when the colleague meant 16:00 CET
 *     (= 17:00, which was free). Closed: an undecided frame now arms nothing unless
 *     BOTH readings are HARD-blocked — `armsHardFloor`, this file's own tier, asked
 *     by availabilityPreCheck's ledger loop. That close first shipped asking
 *     `!bookable`, which is equally true of the overridable tier, so a mixed
 *     hard/soft pair still armed and this exact false fire kept a second door
 *     (closed v4.2.2).
 *   • :782 — cited "Monday 27 Jul at 00:00, that time has already passed" against a
 *     draft entirely about Monday 3 August; only the rewriter's keep-veto stopped it
 *     (:784). Closed: `in_the_past` no longer arms, and the ledger holds future
 *     instants only.
 *   • 2026-08-24T12:07:06Z / T12:07:12Z — two more, same shape: an owner-facing
 *     thread offering Sun 6 Sep 12:00/13:00, Mon 7 Sep 11:15/12:30, Tue 8 Sep
 *     9:15/11:30, Thu 10 Sep 10:30/14:00, and a Hebrew colleague-facing thread
 *     offering Mon 7.9 13:00/13:55 and Thu 10.9 14:30/15:25 — both flagged
 *     against the identical stale cross-thread hard block "Monday 7 Sep at
 *     11:30" from a DIFFERENT thread's ledger entry, even though neither
 *     draft's own offered instants are that collision. `detectAffirmedBlockedSlots`
 *     (this file, :561) over-matched once the same calendar day was mentioned
 *     rather than the specific instant offered. Both rewriter-vetoed ("keep")
 *     before shipping. Closed (o#260): a `presented_available` verdict is no
 *     longer trusted on the model's word alone — the report tool also returns
 *     the `quoted_span` it based the verdict on, and `quotedSpanNamesBlock`
 *     deterministically confirms that span names both the block's date AND
 *     its exact time (not just the shared day) before the verdict arms the
 *     rewriter; an unconfirmed span downgrades to `not_mentioned` (safe miss).
 * All four vetoes did their job, which is the G5 design working — but a destructive
 * rewriter with 0 catches and 4 false fires has not yet earned its active form (G6).
 * Whether it keeps that form, or should only ever rewrite to "I can't confirm that
 * time", is an open owner decision; this file states its own record so that decision
 * is made on data instead of on the story above.
 *
 * WHY no existing gate covers the class. `claimChecker` ran (:190) and passed correctly:
 * its inputs are `reply + toolSummaries + bookingOccurred` (claimChecker.ts:39-66)
 * and its ONE rule is "did the assistant claim to have DONE an external action".
 * "Wednesday works on his end" is not an action claim and no availability verdict
 * is anywhere in its context — it is structurally blind to this class, and making
 * it see it would give one guard two jobs and two remedies. The rest of the stack
 * is voice (humanGate), leak (securityGate) and weekday↔date (dateVerifier).
 * Nothing checked the reply against the calendar facts of the same turn.
 *
 * WHY this is a guard at all, and not a prompt fix (W3). The pre-check already
 * carries its verdicts UPSTREAM into the drafting context, which is where the
 * happy path belongs — and the same incident shows the limit of that: a verdict
 * injected as prose is a verdict the drafter can reinterpret. The floor is the
 * last resort behind it, not the mechanism: on a correct turn it is a no-op that
 * costs nothing (the stash is empty).
 *
 * SHAPE (G3/G4/G5/G8/G10):
 *   - Ground truth is DETERMINISTIC and pre-established: the entries come from
 *     `checkSlot` — the same validator the booking path runs — on that exact
 *     instant, recorded by availabilityPreCheck at the moment it computed them.
 *     Nothing here re-derives why a slot is blocked (the fabrication pattern).
 *   - Only a proven CALENDAR FACT arms the floor (HARD_FLOOR_KINDS below):
 *     already committed, a non-working day, in the past. The owner-overridable
 *     tier — outside his hours, day-load protection, category caps — is
 *     deliberately NOT armed: those are legitimately push-through-able and
 *     flattening one into a refusal would be the G5 corruption this guard exists
 *     to avoid.
 *   - Detection is an LLM (G8 — "works on his end" has no language-neutral
 *     pattern, and Maelle answers in Hebrew / Russian / Spanish too), gated
 *     behind a free structural pre-filter (is there a fresh established block at
 *     all?), read as STRUCTURED FIELDS ONLY (G4) — the detector's prose can
 *     never reach a reader.
 *   - The remedy is one tool-less, bounded, fact-preserving rewrite (G3). It
 *     cannot fire a tool, cannot persist anything, and fails OPEN at every step:
 *     any error, any empty or fact-dropping rewrite ships the original draft
 *     (G5 — a rare defect through, never a corrupted correct reply).
 *
 * REASON VISIBILITY — owner decision 2026-07-27, "reason by CLASS, in-thread, no
 * identifying detail". The narration states the CLASS of the blocker and nothing
 * that identifies the event: no subject, no attendees, no organizer, no client.
 * The class is read off the verdict's `violation_kind` — never recomputed here —
 * and when the class is not one we know, the honest output carries NO reason at
 * all (`hardBlockClassPhrase` returns null). Substituting an invented hard reason
 * for an invented soft one would be the same bug in a different coat.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { getAnthropicClient } from '../llm/client';
import { SONNET, MODEL_SONNET, MODEL_HAIKU } from '../llm/models';
import logger from './logger';
import { logLlmUsage } from './usageLog';
import { renderClockInZone } from './timezoneConvert';
import { extractTimes, extractDates } from './dateTimeExtract';

// ── The class vocabulary ────────────────────────────────────────────────────

/**
 * THE narration class for a hard block, derived from `checkSlot`'s
 * `violation_kind` — the verdict's own field, never a re-derivation at narration
 * time. Returns null when the class is unknown, and null means "say the time
 * doesn't work and give NO reason": the one thing worse than a missing reason is
 * a manufactured one.
 *
 * Shared by the pre-check's prompt block and this gate's rewriter on purpose —
 * one vocabulary, so the drafting context and the floor can never disagree about
 * what a blocked slot is allowed to say (G1/G2).
 */
export function hardBlockClassPhrase(
  kind: string | undefined,
  opts: {
    ownerFirst: string;
    allDayOutOfOffice?: boolean;
    /**
     * gh#200 — the away span's real end, already formatted by the producer
     * (e.g. "Friday 29 Aug") — same convention as HardBlockedSlot.display:
     * rendered once, quoted verbatim, never re-derived here. When present,
     * names the whole away period instead of just the one day being checked,
     * so a colleague proposing several different days inside it hears the
     * real end instead of a fresh day-scoped "away that whole day" each time.
     */
    allDayOutOfOfficeUntilDisplay?: string;
  },
): string | null {
  // The all-day case first: it is the same hard collision, but "busy at that
  // time" invites "an hour later then?", which has the same answer all day.
  if (opts.allDayOutOfOffice) {
    return opts.allDayOutOfOfficeUntilDisplay
      ? `${opts.ownerFirst} is away through ${opts.allDayOutOfOfficeUntilDisplay}`
      : `${opts.ownerFirst} is away that whole day`;
  }
  switch (kind) {
    case 'owner_busy_collision':
      return `it clashes with a meeting already on ${opts.ownerFirst}'s calendar`;
    case 'vacation_or_off_day':
      return `that isn't a working day for ${opts.ownerFirst}`;
    case 'in_the_past':
      return 'that time has already passed';
    default:
      return null;
  }
}

/**
 * The kinds that arm the destructive half. A CLOSED list of facts about the
 * calendar — the opposite of a growing exemption list: a kind that is not here
 * simply leaves the floor unarmed for that slot (a safe miss), which is the right
 * default for anything the owner can legitimately override, and for any kind added
 * later that nobody has classified yet.
 *
 * `in_the_past` was here and is REMOVED (v4.2.2). It is a fact, but it is the wrong
 * KIND of fact for this guard, and it is the only kind that manufactures itself:
 *   • Nothing it could catch is harmful. The floor exists to stop a taken slot being
 *     sold as free and booked over — and nobody books the past; the write path
 *     refuses it (scheduleRules checkSlot rule 0) and planMeeting turns it into a
 *     clarify. There is no external invite at the end of this one.
 *   • Every other kind needs a real collision on a real calendar to arise. This one
 *     arises from any date-resolution slip at all, because "already passed" is true
 *     of most of the timeline. On 2026-07-27 (log :757-:765) a point-check on "welche
 *     Zeit is wirklich frei bei Idan?" — a question naming no clock time — resolved
 *     to today at 00:00, which is trivially past, and that became an ESTABLISHED
 *     hard block. Sixteen minutes later the floor cited "Monday 27 Jul at 00:00,
 *     that time has already passed" against a draft entirely about Monday 3 August
 *     (:782), and only the rewriter's keep-veto stopped it (:784).
 * So the class contributed a stream of entries that could only ever be wrong
 * evidence, in exchange for catching nothing that matters. `hardBlockClassPhrase`
 * KEEPS its `in_the_past` case: the pre-check's own prompt block still renders that
 * verdict as a hard line, and telling the drafter "that time has already passed" is
 * both true and useful. Only the ARMING is withdrawn.
 */
const HARD_FLOOR_KINDS = new Set<string>([
  'owner_busy_collision',
  'vacation_or_off_day',
]);

/**
 * THE arming question — "is this `checkSlot` violation kind on the floor's hard
 * tier?" — asked in one place.
 *
 * Exported (v4.2.2) because the PRODUCER has to ask it too, and it was asking a
 * different one. availabilityPreCheck's ledger loop tested `!bookable`, which is
 * equally true of the owner-overridable tier, so both halves of that loop read a
 * tier this file does not use: a mixed hard/soft undecided pair satisfied its "both
 * readings blocked" exemption and armed the hard reading of a frame nobody had
 * decided (the :743 false refusal, straight back through the door that closed it),
 * and a fresh SOFT verdict over a stale hard entry neither recorded — the kind is
 * not in the set — nor forgot, because the reading still looked like a block. Two
 * predicates for one tier line IS the drift; one predicate, read by the place that
 * produces the knowledge and the place that stores it, is the fix.
 *
 * `undefined` is false, which is deliberate and load-bearing at both call sites: a
 * bookable verdict carries no kind, and an unclassified kind is exactly what should
 * leave the floor unarmed. Typed as a PREDICATE so the recorder's narrowing comes
 * from the same test that decides the tier, instead of a cast that could outlive it.
 */
export function armsHardFloor(kind: string | undefined): kind is string {
  return !!kind && HARD_FLOOR_KINDS.has(kind);
}

// ── The established-block ledger ────────────────────────────────────────────

export interface HardBlockedSlot {
  /** ISO instant, owner-local offset — the exact start `checkSlot` judged. */
  instantIso: string;
  /**
   * "Tuesday 11 Aug at 11:30" — the instant in the OWNER's clock, rendered once by
   * the producer, and owner-local ONLY (v4.2.2). The ledger is owner-keyed and
   * outlives the thread that filled it (see below), so a second clock for whichever
   * colleague happened to be asking at the time is simply wrong in every other
   * thread — and the rewriter is told to keep every number intact, so a stale one
   * would be echoed to the reader as a fact. The asker's own clock is added per
   * TURN, from `instantIso`, by `displayForAsker`.
   */
  display: string;
  /** checkSlot's violation_kind, carried verbatim. */
  kind: string;
  /** The class phrase for narration, or null = state no reason. */
  phrase: string | null;
  /**
   * The exact meeting length `checkSlot` was run at to establish this block —
   * the asked length (snapped to the profile's allowed durations) for a normal
   * ask, or the smallest allowed duration for a gap query's "nothing fits"
   * verdict. o#189: the live re-verification refuter (runOutputGates) must
   * re-probe at THIS length, not an unconditional smallest-allowed-duration —
   * a block a 50-minute ask trips over on a tail overlap is not reproduced by
   * a 25-minute probe, and the false-clear silently forgot a real fact.
   */
  durationMin: number;
  expiresAt: number;
}

/**
 * Keyed by OWNER, not by thread — deliberately. "Idan is committed at
 * 2026-08-11T11:30+03:00" is a fact about one calendar, equally true in every
 * thread that mentions that instant, which is exactly why the relay leg of the
 * incident needs it: turn 1 established the fact in the owner's own turn, and the
 * false statement went out on the NEXT turn, addressed to the colleague. A
 * thread-scoped ledger would have had nothing to say there.
 *
 * Bounded on both axes so it can never grow into state: a TTL and a small
 * per-owner cap.
 *
 * The TTL is set by how long a real coordination takes, because that is the whole
 * exposure window. In the incident the owner answered 2 minutes after the verdicts
 * were computed and the colleague answered 22 minutes after that — a 20-minute
 * window would already have expired before the reply that said "locked in" for a
 * slot he was committed on. 45 minutes covers a normal back-and-forth and is still
 * far short of "the calendar has drifted".
 *
 * INVALIDATION — the TTL is the LAST line, never the only one. An entry is a claim
 * about a live calendar, so anything that proves it wrong must remove it, and a
 * stale entry is not a missed catch but a FALSE REFUSAL — the one failure this guard
 * may not commit (G5). Six rules. Five are grounded in a fresh calendar read; rule 5
 * is not (see its own paragraph) and is a scope safeguard, not a calendar fact:
 *   1. A fresh verdict for that exact instant that is NOT a hard block deletes it —
 *      bookable, soft / owner-overridable, or a kind nobody has classified. Same
 *      validator, same calendar, milliseconds old: it is strictly better knowledge,
 *      and anything short of "still hard-blocked" makes the entry WRONG rather than
 *      merely old (the pre-check's own loop does this — availabilityPreCheck, via
 *      `armsHardFloor`). It read "a fresh `bookable` verdict" until v4.2.2, and that
 *      wording was also the implementation: the whole soft tier could neither
 *      refresh an entry nor clear one, so a hard block that had been downgraded to
 *      a soft one between two turns — someone drags the clash away in Outlook, no
 *      Maelle mutation, nothing else invalidates — stayed armed and refused a time
 *      that had become the owner's to give.
 *   2. A completed calendar mutation in the turn CLEARS the whole owner ledger. A
 *      move vacates one slot and occupies another, so no entry survives it —
 *      standing down for that one turn was not enough (see runOutputGates).
 *   3. A rewrite that lands forgets the instant it corrected (forgetHardBlockedSlot).
 *   4. v4.2.2 — a turn that cannot tell WHICH instant the asker meant (a bare clock
 *      from someone outside the owner's zone) forgets both candidates unless both are
 *      HARD-blocked. An entry is only useful if it is about the slot under discussion,
 *      and an undecided frame means nobody knows which of two that is. "Both blocked"
 *      is NOT enough, and was this rule's first shape: a hard reading paired with an
 *      overridable one is still an undecided frame, and arming the hard half of it is
 *      the :743 false refusal over again — with the escalation the soft reading was
 *      owed (#128) destroyed on the way. The test is `armsHardFloor` on every reading.
 *   5. v4.3.x (gh#158) — a turn that names someone OTHER than the owner bails out of
 *      this whole pre-check for the owner's own calendar (it has no third-party
 *      awareness at all — see the bail's own comment in availabilityPreCheck.ts) and
 *      forgets any stored instant the message ALSO names, via cost-free regex
 *      extraction (`forgetNamedInstantsFromHardBlockLedger`) — NEVER a fresh
 *      `checkSlot` call. This is the one rule not grounded in a calendar read: its
 *      job is scope, not evidence — a stale OWNER entry must not survive to be
 *      matched against a reply that is actually about a named colleague at the same
 *      clock time (the wrong-subject false rewrite gh#158 fixed). Safe by
 *      construction: it only ever deletes (`forgetHardBlockedSlot`), so a false hit
 *      can make the floor MISS, never fabricate a block — and if a later turn really
 *      is about the owner at that instant, its own `checkSlot` re-arms the ledger
 *      fresh, same as every other rule here.
 *   6. v4.4.x — immediately before the rewrite fires (runOutputGates), a live
 *      re-verification: fresh `checkSlot`, fresh calendar read, same instant, at the
 *      SAME duration the entry was established at (`durationMin` — o#189; an
 *      unconditional shortest-allowed-duration probe does not reproduce a block a
 *      longer ask tripped on a tail overlap). The other rules all invalidate off a
 *      read that happened to occur anyway; this is the one place the floor is a
 *      moment from ACTING, so it takes one more look first rather than trusting an
 *      entry that can be up to TTL_MS old. Anything that no longer arms the floor is
 *      dropped and forgotten WITHOUT a rewrite (a safe miss, never a corrected reply
 *      for a fact that stopped being true) — but a re-check that CANNOT run (a
 *      throw — Graph outage, etc.) is not evidence the slot cleared, so it is treated
 *      as still confirmed rather than silently forgotten (o#189: a throw is "could
 *      not check", never "proof it's clear").
 * Plus one bound that is not invalidation but membership: the ledger holds FUTURE
 * instants only (freshHardBlockedSlots), so an entry can never outlive the moment it
 * describes.
 *
 * What is left, now that rule 6 closes the "moved/cancelled by someone else, no
 * Maelle mutation" gap at the one moment it matters (immediately before the
 * rewrite): the narrow window between rule 6's live re-check and the rewrite
 * actually landing. The ledger DOES key on duration (`durationMin`, o#189) precisely
 * so rule 6's probe reproduces the length that was actually proposed rather than
 * disarming the real catch (a 60-minute ask refused by a tail overlap, then sold
 * as "11:30 works").
 */
const TTL_MS = 45 * 60 * 1000;
const MAX_PER_OWNER = 8;
const ledger = new Map<string, HardBlockedSlot[]>();

/**
 * Called by availabilityPreCheck the moment `checkSlot` returns a hard verdict —
 * so the gate reads a fact that was ESTABLISHED, never one it inferred. A kind
 * outside HARD_FLOOR_KINDS records nothing at all.
 */
export function recordHardBlockedSlot(params: {
  ownerEmail: string;
  ownerFirst: string;
  instantIso: string;
  display: string;
  kind: string | undefined;
  allDayOutOfOffice?: boolean;
  /** gh#200 — see hardBlockClassPhrase's own field doc. */
  allDayOutOfOfficeUntilDisplay?: string;
  /** The length `checkSlot` was run at to reach this verdict (see HardBlockedSlot). */
  durationMin: number;
}): void {
  if (!armsHardFloor(params.kind)) return;
  const key = params.ownerEmail.toLowerCase();
  const now = Date.now();
  const kept = (ledger.get(key) ?? []).filter(
    e => e.expiresAt > now && e.instantIso !== params.instantIso,
  );
  kept.push({
    instantIso: params.instantIso,
    display: params.display,
    kind: params.kind,
    phrase: hardBlockClassPhrase(params.kind, {
      ownerFirst: params.ownerFirst,
      allDayOutOfOffice: params.allDayOutOfOffice,
      allDayOutOfOfficeUntilDisplay: params.allDayOutOfOfficeUntilDisplay,
    }),
    durationMin: params.durationMin,
    expiresAt: now + TTL_MS,
  });
  ledger.set(key, kept.slice(-MAX_PER_OWNER));
}

/**
 * The still-valid established blocks for this owner. Free — no I/O, no LLM.
 *
 * "Valid" is two clocks, not one (v4.2.2): the entry must still be inside its TTL,
 * AND the instant it is about must still be in the FUTURE. The second half makes
 * "this ledger only ever holds bookable-in-principle instants" an invariant of the
 * ledger rather than a side effect of which kinds happen to arm it — so the
 * `in_the_past` removal above cannot be undone by a reordering of checkSlot's rule
 * ladder (a different file, another lane's), and a slot recorded at 15:50 for 16:00
 * stops being able to rewrite anything once 16:00 has gone by. An entry about a
 * moment that has passed can prevent no harm and is one more thing the detector can
 * mis-match a draft against.
 */
export function freshHardBlockedSlots(ownerEmail: string): HardBlockedSlot[] {
  const key = ownerEmail.toLowerCase();
  const now = Date.now();
  const fresh = (ledger.get(key) ?? []).filter(e => {
    if (e.expiresAt <= now) return false;
    // instantIso is written by the producer as a real offset-carrying ISO string;
    // an unparseable one (NaN) is not evidence of anything and drops out.
    const at = Date.parse(e.instantIso);
    return Number.isFinite(at) && at > now;
  });
  if (fresh.length === 0) ledger.delete(key);
  else ledger.set(key, fresh);
  return fresh;
}

/**
 * Drop one instant. Call sites (verified by grep), all cases of "this entry
 * is no longer the best knowledge":
 *   - availabilityPreCheck.ts:967 — a fresh verdict for that exact instant is NOT
 *     a hard block (invalidation rules 1 and 4 both resolve through this one line:
 *     "not every reading arms" is true whether there was one reading or two).
 *   - availabilityPreCheck.ts:1155 / :1161 — `forgetNamedInstantsFromHardBlockLedger`,
 *     the named-attendee bail's text-matched forget (invalidation rule 5) — a
 *     DIFFERENT mechanism from the two lines above: no `checkSlot` call, a scope
 *     safeguard rather than a calendar fact. Previously mis-cited here as rule 4;
 *     it is not — rule 4 is the undecided-frame case at :967, and this is its own
 *     rule, corrected 2026-08 (o#190).
 *   - runOutputGates.ts:1592 — the pre-rewrite live re-check found this instant no
 *     longer hard-blocked (invalidation rule 6); dropped WITHOUT a rewrite.
 *   - runOutputGates.ts:1618 — a rewrite landed on it (invalidation rule 3).
 * A caller adding another should update this list AND the ledger's own
 * INVALIDATION doc above in the same change — this file's own header undercounted
 * its callers once already.
 */
export function forgetHardBlockedSlot(ownerEmail: string, instantIso: string): void {
  const key = ownerEmail.toLowerCase();
  const kept = (ledger.get(key) ?? []).filter(e => e.instantIso !== instantIso);
  if (kept.length === 0) ledger.delete(key);
  else ledger.set(key, kept);
}

/**
 * Drop EVERY entry for this owner. Called when a calendar mutation completed in the
 * turn: a create/move/delete can free any recorded instant and not just the one it
 * touched, so nothing in the ledger is still known-good. The pre-check re-derives
 * from scratch on the next question, which is the only source that should be
 * trusted after the calendar moved under us.
 */
export function clearHardBlockedSlots(ownerEmail: string): void {
  ledger.delete(ownerEmail.toLowerCase());
}

/**
 * The entry as THIS turn's reader should see it: the stored owner-local rendering,
 * plus the SAME instant in the asker's own zone when they do not share the owner's.
 *
 * Per-TURN and not per-entry, because the two facts have different lifetimes. "Idan
 * is committed at that instant" is a fact about one calendar and is why the ledger is
 * keyed by owner and read across threads; "where they are" is a fact about whoever is
 * being answered right now. The producer used to bake the second clock into `display`,
 * so an entry established in a Brussels thread was listed to the detector — and handed
 * to the rewriter as a number to preserve — carrying a Brussels clock during a turn
 * with a colleague in Israel or New York.
 *
 * Computed from `instantIso` with the same helper the drafting context uses, so a
 * corrected reply names the moment in the clock the reader actually keeps instead of
 * introducing a third one. Degrades quietly in both directions that matter: no zone,
 * the owner's own zone, or an unusable zone (renderClockInZone returns '') all leave
 * the owner-local string exactly as stored.
 */
export function displayForAsker(
  slot: HardBlockedSlot,
  ownerTz: string,
  askerTz?: string,
): string {
  if (!askerTz || askerTz === ownerTz) return slot.display;
  const theirs = renderClockInZone(slot.instantIso, ownerTz, askerTz);
  return theirs ? `${slot.display} (= ${theirs} where they are)` : slot.display;
}

// ── Detection ───────────────────────────────────────────────────────────────

type SlotTreatment = 'presented_available' | 'presented_blocked' | 'not_mentioned';

/**
 * o#260 — deterministic confirmation that a detector-quoted span actually names
 * THIS block's date and time, rather than trusting the model's own claim of a
 * match. Reuses the SAME cost-free regex primitives availabilityPreCheck.ts
 * extracts date/time candidates with (G9 — one canonical definition in
 * dateTimeExtract.ts, imported here rather than hand-copied).
 *
 * TIME — exact HH:MM match against the block's owner-local hour/minute. This
 * alone rules out the proven failure mode (same day, different hour): the
 * two documented false fires each quoted a span naming the block's DAY but a
 * different clock time.
 *
 * DATE — when the span carries an explicit numeric date (7.9, 9/7, ...),
 * it must resolve to the block's exact calendar date. When it carries none
 * (a word-form date — "Monday 7 Sep", another language's month name — which a
 * numeric regex can't parse without becoming a language-specific rule, W4),
 * fall back to the language-neutral minimum: the bare day-of-month digit,
 * word-bounded. Combined with the exact time match above, day-of-month +
 * exact time is enough to rule out a same-day/different-time mismatch even
 * without resolving the month from a word.
 */
function quotedSpanNamesBlock(quotedSpan: string, block: HardBlockedSlot, ownerTz: string): boolean {
  // instantIso already carries the owner-local offset (see HardBlockedSlot's own
  // doc), but Luxon's default `fromISO` reads it into the PROCESS zone (UTC on the
  // VM — no TZ env var, no Settings.defaultZone) rather than the owner's, so
  // `.hour`/`.day` below silently read a different clock than the one the quoted
  // span and `block.display` actually name. Force ownerTz explicitly rather than
  // trusting the process default.
  const dt = DateTime.fromISO(block.instantIso, { zone: ownerTz });
  if (!dt.isValid) return false;

  const timeHit = extractTimes(quotedSpan).some(t => t.hour === dt.hour && t.minute === dt.minute);
  if (!timeHit) return false;

  const monthFirst = /^America\//.test(ownerTz);
  const dateMatches = extractDates(quotedSpan, ownerTz, monthFirst);
  if (dateMatches.length > 0) {
    return dateMatches.some(d => d.date === dt.toFormat('yyyy-MM-dd'));
  }
  // No numeric date in the span — language-neutral fallback: the bare
  // day-of-month digit, word-bounded so "7" doesn't match inside "17:30".
  return new RegExp(`(?<![\\d.])${dt.day}(?![\\d.])`).test(quotedSpan);
}

/**
 * Which of the established blocks does the draft present as available?
 *
 * Haiku + forced tool. The model NEVER supplies a time, a date or a reason — it
 * only classifies each of OUR instants into one of three enum values, and we read
 * nothing else (G4). So a hallucinated slot cannot enter the decision, and the
 * detector's prose cannot reach a reader.
 *
 * SCOPE — the exact listed instants, never a day. Since the point-check started
 * appending nearby ALTERNATIVES to the same prompt block (nearbyAlternatives), the
 * healthy draft is precisely the one that names a blocked slot AND a free slot in
 * the same breath, often an hour apart on the same day: "11:30 doesn't work, but
 * 14:00 is open". Reading that as "the draft says Tuesday works" would rewrite a
 * correct reply into a refusal of a slot that IS free — a worse bug than the one
 * this guard exists for. The instruction below says so explicitly, and the
 * rewriter's own keep-veto is the second layer.
 *
 * WHERE THE HARM LINE IS — being told a taken slot is free, not the word
 * "push". So a draft that STATES the clash and then asks whether to book over it
 * anyway is `presented_blocked`: that is the M2 one-step book-through, the owner is
 * entitled to override his own calendar, and rewriting his confirmation question
 * into a flat "that doesn't work" would put the guard in the flow's way (G5). The
 * distinction is not available deterministically at output time — the confirmation
 * turn carries no completed-mutation marker by design (turnHelpers.ts:141), and
 * re-deriving it from a list of calendar tool names is exactly the guessing G2
 * removed from the claim-checker's shield — so it is drawn where it is genuinely a
 * question of meaning: in the spec below. A hedge that never says the slot is taken
 * ("tighter than his usual, workable if you push through" — the 2026-07-27 wording)
 * stays `presented_available`.
 *
 * Fails open: any throw, any unusable output → empty list → the draft ships.
 *
 * o#260 — the model's own "MATCH THE DATE BEFORE THE TIME" instruction (below)
 * proved insufficient alone: two live false fires (2026-08-24, this file's own
 * header at :39-48) show it still flags a draft's offered time as matching a
 * block just because they share the same calendar DAY, not the same instant.
 * Rather than trust a "presented_available" verdict on the model's word alone,
 * the report tool also asks for the exact `quoted_span` the verdict is based
 * on, and `quotedSpanNamesBlock` deterministically confirms that span actually
 * names both the block's date AND its time before the verdict is trusted — a
 * verdict that can't be confirmed downgrades to `not_mentioned` (safe-miss,
 * G5), which directly targets the proven failure mode.
 */
export async function detectAffirmedBlockedSlots(
  draft: string,
  blocks: HardBlockedSlot[],
  ownerFirstName: string,
  ownerTz: string,
): Promise<HardBlockedSlot[]> {
  const listed = blocks.map((b, i) => `  ${i + 1}. ${b.display}`).join('\n');

  const prompt = `A deterministic calendar check has ALREADY established that each of these times is NOT available for ${ownerFirstName}. That is settled — you are not being asked to re-judge it.

TIMES ESTABLISHED AS NOT AVAILABLE:
${listed}

DRAFT MESSAGE (from ${ownerFirstName}'s assistant, may be to ${ownerFirstName} or to a colleague, in any language):
"""
${draft}
"""

For EACH numbered time above, report how the DRAFT treats it:
- "presented_available" — the draft tells the reader that time works, is free, is fine, is possible, is bookable, is doable if pushed ("tight but workable", "he can push through", "works on his end", "OK either way"), or presents it as the time now agreed / settled / locked in — WITHOUT telling them the time is taken.
- "presented_blocked" — the draft tells the reader that time does NOT work: he's busy then, he's away, it clashes with something, it's out. This INCLUDES a draft that states the clash and THEN asks whether to go ahead anyway ("that clashes with his 12:00 — want me to double-book it?", "he's booked then, override?"). The reader has been told the truth and is being asked to decide; that is an offer to override, not a claim that the time is free. A vague hedge is NOT this: "tight", "not clean", "not ideal", "tighter than his usual" never tell the reader the time is TAKEN, so a draft that only hedges and then offers the slot is "presented_available".
- "not_mentioned" — the draft does not refer to that time, or refers to it without saying whether it works (repeating the proposal, asking about it, naming the meeting's topic).

ONLY the exact times listed above are in scope. The draft will often ALSO offer OTHER times — a different hour on the same day, a nearby slot, another day — and those are DIFFERENT times, not these. If a listed time is 11:30 and the draft says "11:30 is out, but 14:00 that day is free", the listed 11:30 is "presented_blocked" and the 14:00 offer is irrelevant. If the draft only offers 14:00 and says nothing about 11:30 itself, the listed 11:30 is "not_mentioned". NEVER carry an offer of one time over to another, and never answer about a whole day when the listed entry is one clock time.

MATCH THE DATE BEFORE THE TIME. Every listed time carries its own weekday AND date. If the draft is not discussing that DATE, the entry is "not_mentioned" — full stop — no matter how much else looks similar. A shared weekday name is not a match: "Monday 27 Jul" and a draft about "Monday 3 August" are different days, so that entry is "not_mentioned". A shared clock number on another date is not a match either. Decide the day first; only if the draft is talking about that day do you judge how it treats that time.

Judge by MEANING, in whatever language the draft is written — Hebrew, Russian, Spanish, English. Tense and phrasing do not matter. A hedge is still "presented_available": "not clean but workable" tells the reader they can have it.

Whenever your treatment for a time is "presented_available" or "presented_blocked", also give \`quoted_span\`: the exact substring of the draft you are basing THAT judgment on for THAT specific numbered time. Quote only the part naming/discussing that time — not the whole message.

Report one entry per numbered time by calling the report tool.`;

  try {
    const resp = await getAnthropicClient().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 500,
      tools: [{
        name: 'report',
        description: 'Report, for each numbered time, how the draft treats it.',
        input_schema: {
          type: 'object' as const,
          properties: {
            slots: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'number', description: 'The number of the time from the list above.' },
                  treatment: {
                    type: 'string',
                    enum: ['presented_available', 'presented_blocked', 'not_mentioned'],
                  },
                  quoted_span: {
                    type: 'string',
                    description: 'Exact substring of the draft this judgment is based on. Required unless treatment is "not_mentioned".',
                  },
                },
                required: ['index', 'treatment'],
              },
            },
          },
          required: ['slots'],
        },
      }],
      tool_choice: { type: 'tool', name: 'report' },
      messages: [{ role: 'user', content: prompt }],
    });
    logLlmUsage('availability_floor_detect', MODEL_HAIKU, resp);
    const toolUse = resp.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
    const reported = (toolUse?.input as { slots?: Array<{ index?: number; treatment?: string; quoted_span?: string }> } | undefined)?.slots ?? [];
    const out: HardBlockedSlot[] = [];
    for (const entry of reported) {
      // Index must land on a slot WE listed; treatment must be the one enum value
      // that authorises an edit. Anything else is ignored — including an entry the
      // model invented, which can only ever be a no-op.
      const i = typeof entry?.index === 'number' ? entry.index - 1 : -1;
      const treatment = entry?.treatment as SlotTreatment | undefined;
      if (i < 0 || i >= blocks.length) continue;
      if (treatment !== 'presented_available') continue;
      // o#260 — don't trust the verdict on the model's word alone: confirm the
      // quoted span it's based on actually names THIS block's date AND time,
      // deterministically. Can't confirm → downgrade to not_mentioned (safe
      // miss) instead of arming a destructive rewrite off a same-day match.
      if (!entry.quoted_span || !quotedSpanNamesBlock(entry.quoted_span, blocks[i], ownerTz)) {
        logger.info('Availability floor — presented_available verdict could not be confirmed against its quoted span; downgraded to not_mentioned (safe miss)', {
          slotDisplay: blocks[i].display,
          quotedSpan: (entry.quoted_span ?? '(none)').slice(0, 200),
        });
        continue;
      }
      if (!out.includes(blocks[i])) out.push(blocks[i]);
    }
    return out;
  } catch (err) {
    logger.warn('Availability floor — detector threw; draft ships unchanged', {
      err: String(err).slice(0, 200),
    });
    return [];
  }
}

// ── Remedy ──────────────────────────────────────────────────────────────────

/**
 * One tool-less bounded rewrite. Sonnet, forced `verdict` tool — same shape as
 * rewriteOwningTheMiss, and for the same reason: only the structured fields can
 * become the reply, so the model's reasoning can never ship (G4).
 *
 * The rewriter gets the CLASS PHRASE and is forbidden to add any other reason,
 * which is what keeps the correction from becoming a second fabrication. When the
 * phrase is null it must say the time doesn't work and stop there.
 *
 * Returns null on keep, on an empty/meta message, on a rewrite that dropped a
 * load-bearing fact, or on any error — every one of those ships the original.
 */
export async function rewriteBlockedSlotClaim(opts: {
  draft: string;
  slots: HardBlockedSlot[];
  ownerFirstName: string;
}): Promise<string | null> {
  const facts = opts.slots
    .map(s => `  - ${s.display} — NOT available for ${opts.ownerFirstName}${s.phrase ? `; the only reason you may give: "${s.phrase}"` : '; NO reason is available — say it does not work and give none'}`)
    .join('\n');

  const prompt = `You are correcting a message an assistant already drafted for ${opts.ownerFirstName}. A deterministic calendar check established that the times below are NOT available, and the draft presents at least one of them as workable. Report your decision by calling the \`verdict\` tool — write no prose outside the tool call.

ESTABLISHED FACTS (settled — do not re-judge them):
${facts}

Call verdict="keep" (leave message empty) if the draft does NOT actually present any of those times as available — it says they don't work, or it only repeats what someone proposed, or it asks about them. Do not correct a draft that is already honest.

Call verdict="rewrite" when the draft does present one of them as workable, available, fine, possible, push-through-able, or as the time now agreed. Put the corrected message in \`message\`. The rewrite must:
- Say plainly that time does not work for ${opts.ownerFirstName}. Never "tight but workable", never "he can push through", never "works on his end", never "locked in".
- Give ONLY the reason listed above for that time, word for word in your own sentence — and where none is listed, give NO reason at all. Never invent, guess or embellish a reason. Never name a meeting, a subject, an attendee, an organizer or a client.
- Keep every other fact intact: the other times, every name, @mention, number, date, and every question the draft asks. If the draft asks something, your version asks the same thing.
- Keep any other time the draft treats correctly exactly as the draft treats it.
- Sound like a real person, in the SAME language as the draft. No system or error voice, no talk of checks, rules or tools.

SAFE-MISS — the hard rule. If you cannot tell that the draft presents one of those times as available, verdict="keep". Turning a correct reply into a wrong refusal is far worse than leaving a soft statement in place.

Draft:
${opts.draft}`;

  try {
    const resp = await getAnthropicClient().messages.create({
      ...SONNET,
      max_tokens: 700,
      tools: [{
        name: 'verdict',
        description: 'Report whether the draft presents an unavailable time as workable, and if so the corrected message.',
        input_schema: {
          type: 'object' as const,
          properties: {
            verdict: {
              type: 'string',
              enum: ['keep', 'rewrite'],
              description: '"keep" = the draft is already honest about those times. "rewrite" = it presents one of them as workable.',
            },
            message: {
              type: 'string',
              description: 'Only when verdict="rewrite": the corrected message. Omit for "keep".',
            },
          },
          required: ['verdict'],
        },
      }],
      tool_choice: { type: 'tool', name: 'verdict' },
      messages: [{ role: 'user', content: prompt }],
    });
    logLlmUsage('availability_floor_rewrite', MODEL_SONNET, resp);

    const toolUse = resp.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
    const input = (toolUse?.input ?? {}) as { verdict?: string; message?: string };
    if (input.verdict !== 'rewrite') {
      logger.info('Availability floor — rewriter kept the draft (judged it already honest about the blocked time)', {
        verdict: input.verdict ?? '(none)',
        draftPreview: opts.draft.slice(0, 200),
      });
      return null;
    }

    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (message.length === 0 || /\b(the draft|the check|established facts|verdict)\b/i.test(message)) {
      logger.warn('Availability floor — verdict=rewrite but the message is empty or meta; shipping the original draft', {
        messagePreview: message.slice(0, 160),
      });
      return null;
    }

    // The same deterministic veto humanGate and the deliberation guard use: an
    // @mention, clock time, numeric date or question the draft carried and the
    // rewrite does not means content was deleted, not corrected. One veto, reused.
    const { rewriteDroppedAFact } = await import('./humanGate');
    if (rewriteDroppedAFact(opts.draft, message)) {
      logger.warn('Availability floor — rewrite dropped a load-bearing fact; shipping the original draft', {
        before: opts.draft.length,
        after: message.length,
        rewritePreview: message.slice(0, 160),
      });
      return null;
    }
    return message;
  } catch (err) {
    logger.warn('Availability floor — rewriter threw; draft ships unchanged', {
      err: String(err).slice(0, 200),
    });
    return null;
  }
}
