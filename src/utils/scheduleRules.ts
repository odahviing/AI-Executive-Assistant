/**
 * scheduleRules (v2.7.0) — single source of truth for "is this slot OK to book?"
 *
 * Replaces the duplicate rule-application logic spread across:
 *   - find_available_slots (slot loop)
 *   - create_meeting Guards A+B
 *   - move_meeting rule-check
 *   - coordinate_meeting slot loop
 *
 * Each of those used to apply slightly different subsets of the same rules.
 * Now they all call `checkSlot(...)` and get one consistent verdict + label.
 *
 * Rules checked, in EVALUATION order. First violation wins (caller gets ONE
 * label). Note (8) is evaluated SECOND, not eighth — see "OCCUPANCY vs RULES":
 *   0. in_the_past                — the slot start is already in the past
 *   8. owner_busy_collision       — a REAL commitment holds the slot. Promoted
 *                                   ahead of every soft rule: "is he already on
 *                                   something?" is a fact about the calendar,
 *                                   never a consequence of which rule tripped
 *                                   first. Rule number kept at 8 so the
 *                                   cross-file "rule 8" references still read.
 *   0b. within_lead_time          — inside the caller's booking lead time
 *                                   (bookingLeadTimeHours: owner vs colleague)
 *   1. vacation_or_off_day        — Friday/Saturday for Idan's profile.
 *                                   THE ONE RULE WITH NO allow_relaxed GATE —
 *                                   see the note under the ladder.
 *   2. category_day_type          — category requires office_days but slot is home day
 *   3. category_per_day           — at-limit for this category on this day
 *   4. category_per_week          — at-limit for this category this ISO week
 *   5. outside_working_hours      — slot falls outside ALL of the day's work_hours
 *                                   windows (multi-window aware)
 *                                   (bypassed when allow_relaxed = true)
 *   6. floating_block_overlap     — lunch / focus block conflict in profile.meetings.floating_blocks
 *                                   (bypassed when allow_relaxed = true)
 *   7. travel_buffer_collision    — category.requires_travel_buffer & adjacent meeting too tight
 *                                   (see (8) — the collision itself was already
 *                                    reported, so this only sees ADJACENT events)
 *   9. focus_time_floor           — booking would drop the day below the configured
 *                                   length-based free-time floor (bypassed when
 *                                   allow_relaxed = true OR isFloatingBlock = true)
 *
 * NOTE on rule (1) and allow_relaxed — 0, 0b, 2–4, 5, 6, 7, 8 and 9 all bypass
 * under `allowRelaxed`; rule (1) alone does not. Owner 2026-07-26, asked
 * directly: LEAVE IT — its current behaviour is what he wants. What it does:
 *   • OWNER path — `passes:false` is not a refusal (#127): planMeeting turns it
 *     into a one-step heads-up and books, so the effect is "an off day is the
 *     one fact he is re-told even after overriding everything else". The
 *     double-book notice rides ALONGSIDE it (planMeeting.ts) instead of being
 *     suppressed by the same `passes:false`.
 *   • COLLEAGUE path — NO combination reaches here with `relaxed:true` and
 *     `initiator:'colleague'`, and as of P22 (v4.2.x) that is enforced by
 *     construction, not by inspection: `bookingRequest.grantRelaxed` is the ONE
 *     function that turns `args.relaxed` into an override, it grants only on
 *     `senderRole === 'owner'` (the authenticated sender, post-clamp), and every
 *     path — normalized or not — reads it. So `allowRelaxed` implies the owner,
 *     still true after v4.4.x (#154): a rule-bend from the AUTHENTICATED owner
 *     on a clamped surface (MPIM/channel) does NOT grant `allowRelaxed` either
 *     — it routes to `escalate_approval` instead (`relaxedReason:
 *     'owner_room_bend'`, planMeeting.ts), never to a self-grant. Authority
 *     decides how a bend is HANDLED, never which rules apply.
 *   • SEARCH — unaffected either way: the walker's own workday gate skips
 *     off-days before checkSlot is ever called, relaxed or not, so the two
 *     cannot disagree (M2).
 *
 * NOTE on between-meeting buffer (v2.7.1) — the 5-min buffer is NOT enforced
 * as a collision rule. The allowed durations (10/25/40/55) and aligned starts
 * (:00/:15/:30/:45) already bake in 5 min of trailing gap by design. A 55-min
 * meeting starting where another ends is fine — connected back-to-back is the
 * preferred shape, not a violation. (Prior wave had rule (9)
 * `owner_buffer_collision`; deleted v2.7.1.)
 *
 * ── THE UNCONDITIONAL FACTS (v4.1.x — M3; ordering fixed v4.2.x) ────────────
 * Two things are computed BEFORE the ladder and reported on EVERY verdict,
 * whichever rule ended up returning: the slot's OCCUPANCY and whether it sits
 * inside the day's work band. Both are facts about the slot rather than
 * consequences of which rule tripped first, so no consumer has to infer one from
 * the label it happened to get — the pattern that produced both bugs below.
 *
 * (a) `level` — the M3 booking tier, from a single scan of the owner's events:
 *   free       — nothing holds this slot
 *   optional   — a TIMED workingElsewhere event holds it (join-if-free, soft)
 *   unfiltered — a real commitment holds it
 * Pre-fix, the tier existed ONLY inside the slot walker (which re-derived it
 * from the same events), so a named-time create_meeting booking straight over
 * an optional standup produced no annotation at all. The walker now READS this
 * instead of re-deriving it.
 *
 * THE SCAN RUNS FIRST, AND ITS COLLISION OUTRANKS THE SOFT RULES. v4.1.x put
 * the scan at rule 8's position and returned on the first violation, so every
 * earlier return (0/0b/1/2-4/5/6/7) carried NO occupancy AND reported a soft
 * rule while a hard commitment sat on the slot:
 *   • owner, 14:15, real 15:00 meeting, "book 20 min with Alex at 3" → rule 0b
 *     fired first, so the one-step owner book-through (planMeeting #127) said
 *     "heads up, that's too soon" and never mentioned the double-booking;
 *   • the colleague pre-check treated the same slot as `within_lead_time`, i.e.
 *     "NOT a hard conflict and it's Idan's to override", across a 4h window;
 *   • check_join_availability had to carry a PRIVATE second occupancy scan to
 *     answer "is he busy?" at all — a second validator, which is the M2 bug.
 * Now: scan → rule 0 (a past slot is past, whatever holds it) → the hard
 * collision → then the soft ladder. `level` is ALWAYS present, so no caller can
 * claim a slot is clear without having looked (M11).
 *
 * (b) `outsideWorkHours` — the slot does not fit inside ANY of the day's
 * effective work windows (an off day has none, so it is true there too). Rule 5
 * is the rule that REPORTS it; this field is the fact, present even when a
 * higher-ranked rule reported instead.
 *
 * P25 — the day narration needs the fact, not the label. `find_available_slots`
 * walks every quarter-hour in the window, so on any full-day search most
 * rejections are simply "that hour isn't in his day"; the per-day reason summary
 * therefore treats `outside_owner_work_hours` as noise and reports what blocked
 * the IN-HOURS slots. That filter keyed on the LABEL, which worked only while
 * rule 5 was the first rule an out-of-hours slot could fail. Hoisting the hard
 * collision above the soft ladder (above) broke it: an out-of-hours slot that is
 * ALSO occupied now returns `owner_busy_collision`, which is not noise, so a
 * 20:30 dinner outranked the real in-hours blocker — narrated as "he's already
 * busy then" for a window his working day doesn't even cover
 * (logs/maelle-2026-07-26.log 06:59:36, window 20:30–23:59 on 2026-08-30:
 * `{outside_owner_work_hours: 10, owner_busy_collision: 2}`, both examples 20:30
 * and 20:45). The walker now reads THIS and files those rejections under the
 * noise label, so the ladder keeps its hard-first order (a real commitment is
 * never softened into "his to override") while the day narration recovers the
 * in-hours truth. One work-hours decision still, taken here: the walker's own
 * `slotTotalMin` is computed in the SEARCH timezone, which differs from the
 * day's effective zone on an away override, so re-deriving it out there would be
 * a second answer that can disagree (M2).
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import type { CalendarEvent } from '../connectors/graph/calendar';
import { checkCategorySlot, getProfileCategoryByName } from './categoryRules';
import { displaySubject, PRIVATE_MASK, type SubjectViewer } from './displaySubject';
import { blockAppliesOnDay, getFloatingBlocks, isFloatingBlockEvent } from './floatingBlocks';
import { getEffectiveWorkDayForInstant, slotDayMinutes, type EffectiveWorkDay } from './workHours';

export type RuleViolationKind =
  | 'in_the_past'
  | 'within_lead_time'
  | 'vacation_or_off_day'
  | 'category_day_type'
  | 'category_per_day'
  | 'category_per_week'
  | 'outside_working_hours'
  | 'floating_block_overlap'
  | 'travel_buffer_collision'
  | 'owner_busy_collision'
  | 'attendee_busy_collision'
  | 'focus_time_floor';

/** M3 booking level — what already holds the slot, independent of the rules. */
export type BookingLevel = 'free' | 'optional' | 'unfiltered';

// ── v3.1.2 (C) — Shared daily-focus-time helper ─────────────────────────────
//
// Single source of truth for "how much quality free time does this day have."
// "Quality" = contiguous chunks of at least `thinking_time_min_chunk_minutes`
// (the profile setting); a 10-min gap between two meetings is breathing room,
// not focus time, and doesn't count. This same math powers two surfaces:
//
//   - find_available_slots — per-slot loop rejects slots that would drop the
//     day under the configured length-based free-time floor
//     (requiredFreeMinutesForWorkDay). v3.1.2 (C) — the search path consumes
//     this floor only transitively, by routing through checkSlot rule (9).
//   - checkSlot rule (9) — write-path validation. Pre-fix the floor was
//     enforced ONLY at search time, so a named-time create_meeting /
//     move_meeting / coord pick could book on a packed day that
//     find_available_slots would have refused. Owner direction (3.1.2):
//     ONE check, both surfaces. Relaxed-mode bypass preserved — explicit
//     owner override is the approval, same as every other soft rule.
//
// Pure function: no DB, no profile, easy to test.
export function computeDayQualityFreeMinutes(params: {
  dayDate: string;           // YYYY-MM-DD
  timezone: string;          // IANA
  workStart: string;         // 'HH:MM'
  workEnd: string;           // 'HH:MM'
  busyBlocks: Array<{ start: Date; end: Date }>;
  minChunkMinutes: number;
}): number {
  const { dayDate, timezone, workStart, workEnd, busyBlocks, minChunkMinutes } = params;
  const dayStartMs = DateTime.fromISO(`${dayDate}T${workStart}`, { zone: timezone }).toMillis();
  const dayEndMs   = DateTime.fromISO(`${dayDate}T${workEnd}`,   { zone: timezone }).toMillis();

  const dayBusy = busyBlocks
    .filter(b => b.start.getTime() < dayEndMs && b.end.getTime() > dayStartMs)
    .map(b => ({
      start: Math.max(b.start.getTime(), dayStartMs),
      end:   Math.min(b.end.getTime(), dayEndMs),
    }))
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const block of dayBusy) {
    if (merged.length > 0 && block.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, block.end);
    } else {
      merged.push({ ...block });
    }
  }

  let totalFreeMin = 0;
  let prev = dayStartMs;
  for (const block of merged) {
    const gapMin = (block.start - prev) / 60_000;
    if (gapMin >= minChunkMinutes) totalFreeMin += gapMin;
    prev = block.end;
  }
  const finalGapMin = (dayEndMs - prev) / 60_000;
  if (finalGapMin >= minChunkMinutes) totalFreeMin += finalGapMin;

  return totalFreeMin;
}

export interface RuleCheckInput {
  profile: UserProfile;
  slotStartIso: string;             // inclusive
  slotEndIso: string;               // exclusive
  category: string | null;
  events: CalendarEvent[];          // owner's events covering at least slot's week
  excludeEventIds?: string[];       // for move: drop the moving event from collision detection
  allowRelaxed?: boolean;           // owner override mode — bypass soft rules
  /**
   * Floating-block booking path (lunch / focus / gym / etc). When true, rule 8
   * (owner_busy_collision) is skipped — floating blocks are SIGNALS that
   * coexist with meetings in Outlook, not competing slots. Owner direction:
   * Outlook doesn't refuse overlapping events; we shouldn't either when
   * booking a floating block. The overlap surfaces elsewhere (check_calendar_health
   * double_booking issues, or the book_floating_block caller can read overlapping
   * events from the result and offer to move them).
   */
  isFloatingBlock?: boolean;
  /**
   * v3.7.x (#143) — the slot date's effective work context (yaml base + per-date
   * override, resolved by getEffectiveWorkDay). When present, rules 1/5/9 read the
   * day's workday-ness, windows, LOCATION, and TIMEZONE from it — so an away
   * override day validates against its stated hours in its own zone. When ABSENT,
   * checkSlot resolves it itself from the slot's date, so a caller that doesn't
   * thread it still gets override-correct rules. find_available_slots passes the
   * SAME effectiveDay it walked with, so search and book can never disagree.
   */
  effectiveDay?: EffectiveWorkDay;
  /**
   * v4.1.x (M12) — WHO the produced `violation_label` is for. The label embeds
   * the colliding meeting's subject, and on a COLLEAGUE-initiated create_meeting
   * that label travels back as `violation_label` + `suggested_ask_text`, i.e.
   * straight into a colleague turn's model context. Scoped at the producer, so
   * a subject the owner marked private never enters that context at all. Default
   * (omitted) is the safe one: mask.
   */
  viewer?: SubjectViewer;
  /**
   * v4.4.9 (#154) — the requesting colleague's own email (via
   * `viewerEmailFor`), threaded alongside `viewer` so the occupancy scan's
   * subject can apply the attendee-aware test: a colleague who isn't on the
   * conflicting/optional event never sees its subject, private or not.
   * Omitted → `displaySubject`'s old private-flag-only behaviour (an owner
   * viewer, or a caller that hasn't resolved a specific colleague's identity).
   */
  viewerEmail?: string | null;
  /**
   * v4.1.x (M2) — booking lead time in hours for THIS caller
   * (bookingLeadTimeHours: owner vs colleague). Pre-fix this rule lived ONLY in
   * the slot walker, so a colleague naming "3pm today" at 2pm was rejected by
   * the search yet accepted by create_meeting and by the colleague pre-check.
   * 0 / omitted → no lead-time floor beyond rule 0. Bypassed under allowRelaxed.
   */
  leadTimeHours?: number;
  /**
   * v4.1.x (M2) — explicit travel padding in minutes for this call (the search's
   * `travel_buffer_minutes` arg). Omitted → resolved from the category flag +
   * profile.meetings.travel_buffer_minutes via travelBufferMinutesFor. Pre-fix
   * checkSlot hardcoded 30 and ignored the caller's value entirely.
   */
  travelBufferMinutes?: number;
}

export interface RuleCheckResult {
  passes: boolean;
  violation_kind?: RuleViolationKind;
  violation_label?: string;          // short human phrase suitable for an approval ask_text
  /**
   * M3 tier of the slot — what holds it. Orthogonal to passes/violation, and
   * ALWAYS present: the scan is unconditional and runs before the rule ladder,
   * so there is no verdict for which "we didn't look" is the honest answer.
   * (It used to be optional, absent on every early return — which is exactly
   * how a slot the owner was already committed on came back labelled "too
   * soon" with no tier at all.)
   */
  level: BookingLevel;
  /**
   * The slot does not fit inside ANY of the day's effective work windows (an off
   * day has none). Computed unconditionally alongside `level` — rule 5 is what
   * REPORTS it, this is the fact, so it is present even when a higher-ranked rule
   * returned first. `find_available_slots` reads it to file that rejection under
   * the day-narration noise label instead of inferring out-of-hours-ness from the
   * label it received (P25 — see the header's UNCONDITIONAL FACTS note).
   */
  outsideWorkHours?: true;
  /** level==='optional' — the optional-join event's viewer-scoped subject. */
  overOptional?: string;
  /**
   * level==='unfiltered' — the real commitment sitting on this slot, so the
   * caller can say WHAT it is booking over and whether other people are on it
   * (M3: booking over a real commitment is never the same as breaking a soft
   * own-day rule). Subject is viewer-scoped.
   */
  overCommitment?: {
    /** #165b — the actual colliding event's id, so a caller naming "the meeting
     * that's already there" (e.g. steering toward update_meeting/add_attendees
     * instead of a duplicate create_meeting) points at the SAME event this
     * occupancy scan found, not a second, differently-matched guess. */
    id: string;
    subject: string;
    attendeeCount: number;
    window: string;
    /**
     * The commitment is an all-day OUT OF OFFICE, i.e. the whole day is
     * gone, not this hour. Same tier and same rank (it is still a real
     * commitment); a structured fact rather than a new violation kind, so no
     * consumer that branches on `owner_busy_collision` silently stops firing.
     * Callers that say WHY use it to avoid "he's booked then" on a vacation day.
     */
    allDayOutOfOffice?: true;
    /**
     * gh#165-d — the commitment occupies the WHOLE day, whether or not Outlook
     * marked it `showAs: 'oof'`. Distinct from `allDayOutOfOffice` on purpose:
     * most synced PTO / day-off blocks carry no OOF status at all (a plain
     * all-day `busy`), so a caller that needs "is this an all-day thing" (to
     * suppress a nonsensical "add attendees to it" steer) must not depend on
     * the narrower OOF-only signal. `allDayOutOfOffice` stays OOF-only because
     * IT drives a "he's out of office" CLAIM (M11) — a held all-day block
     * (conference / offsite) is not that, and saying so would be a confident
     * wrong reason. Set from the same `ev.isAllDay` read that produces
     * `window` below — never re-derive by string-matching `window`.
     */
    isAllDay?: true;
    /**
     * gh#200 — set only when `allDayOutOfOffice` is true AND the span reaches
     * past the day being checked: the LAST day the underlying OOF event
     * covers, ALREADY FORMATTED ("Friday 29 Aug") by THIS validator — the one
     * producer (gh#200 dedup, v2). Every consumer (this file's own
     * violation_label below, check_join_availability, availabilityPreCheck's
     * ledger + narration) quotes it verbatim; none may re-derive it from a raw
     * date with a second DateTime.fromISO/.toFormat call. Lets a caller say
     * "away through Aug 29" once instead of re-deriving "away that whole day"
     * for every separate day a colleague proposes inside a known away period —
     * the actual gh#200 incident (a ~20-day away period, re-explained fresh,
     * day after day, with no end ever named). Computed via `computeOofSpan`
     * off this SAME event — never a second span derivation.
     */
    allDayOutOfOfficeUntilDisplay?: string;
  };
}

/**
 * bookingLeadTimeHours — THE single source for "how far ahead may this caller
 * book". Was a literal `1` at four find_available_slots call sites and a bare
 * `min_slot_buffer_hours` read at a fifth, with NO equivalent on the write path
 * at all. Search, checkSlot rule 0b and the colleague pre-check all read it here.
 */
export function bookingLeadTimeHours(
  profile: UserProfile,
  role: 'owner' | 'colleague',
): number {
  return role === 'owner'
    ? (profile.meetings.owner_min_slot_buffer_hours ?? 1)
    : (profile.meetings.min_slot_buffer_hours ?? 4);
}

/**
 * THE lead-time predicate. checkSlot rule 0b is THE caller for every search and
 * every write, so the label's rank comes from the one ladder — below a real
 * commitment, above the soft own-day rules. The slot walker calls it only
 * on its no-UserProfile fallback path, which never reaches checkSlot.
 */
export function isWithinBookingLeadTime(
  slotStartMs: number,
  leadTimeHours: number | undefined,
): boolean {
  if (!leadTimeHours || leadTimeHours <= 0) return false;
  return slotStartMs < Date.now() + leadTimeHours * 60 * 60 * 1000;
}

/**
 * travelBufferMinutesFor — THE single source for travel padding. An explicit
 * caller value wins; otherwise a category flagged `requires_travel_buffer` gets
 * the configured length; otherwise 0. Replaces the literal 30 in rule 7 AND the
 * duplicate category lookup + literal 30 in the slot walker.
 */
export function travelBufferMinutesFor(
  profile: UserProfile,
  category: string | null | undefined,
  explicitMinutes?: number,
): number {
  if (typeof explicitMinutes === 'number' && explicitMinutes > 0) return explicitMinutes;
  const cat = getProfileCategoryByName(profile, category ?? null);
  return cat?.requires_travel_buffer === true
    ? (profile.meetings.travel_buffer_minutes ?? 30)
    : 0;
}

/**
 * offeredSlotCount — THE single source for "how many options do we offer"
 * (M6). Also the per-day candidate cap in the slot walker, so one viable day
 * can fill the whole offer instead of being culled to 4 before the spreader
 * ever sees it. Profile-less callers (degenerate no-profile search) get the
 * same default rather than a second literal.
 */
export function offeredSlotCount(profile?: UserProfile): number {
  return profile?.meetings?.offered_slot_count ?? 8;
}

/**
 * requiredFreeMinutesForWorkDay — THE single source of truth for "how much free
 * time a work day should have," derived from that day's TOTAL work-window
 * minutes (morning + night shift summed). Length-based: 1 free hour per
 * `workHoursPerFreeHour` hours worked, rounded UP to the next 15-minute step.
 *
 * bug 1.13 — replaces the old fixed free_time_per_office/home_day_hours that
 * was read independently in analyze_calendar, checkSlot rule 9, and the
 * calendar-health sweep (three copies, drift-prone). The RATIO stays per-owner
 * config (de-tenant: v3.2.x deliberately moved free-time off a hardcoded value
 * so one owner's focus theory isn't imposed on every tenant) — unset / ≤0 →
 * 0 min, i.e. no floor imposed.
 *
 *   ratio 4:  4h day → 60m · 6h → 90m · 8h → 120m · 12h → 180m
 *             2.5h → 37.5 → ceil-15 → 45m · 3h → 45m
 */
export function requiredFreeMinutesForWorkDay(
  workTotalMin: number,
  workHoursPerFreeHour: number | undefined,
): number {
  if (!workHoursPerFreeHour || workHoursPerFreeHour <= 0) return 0;
  if (!(workTotalMin > 0)) return 0;
  return Math.ceil((workTotalMin / workHoursPerFreeHour) / 15) * 15;
}

/**
 * occupancyRoleOf — THE single answer to "does this event hold the owner's
 * time, and how hard?". One predicate, so the occupancy scan (rule 8) and the
 * travel-buffer scan (rule 7) can never disagree about what counts.
 *
 *   ignore     — cancelled, a free-show (FYI / "Not Me"), a floating block
 *                (lunch / gym slides; rule 6 owns the "no room to shift" case),
 *                or an ALL-DAY workingElsewhere marker (P32, below)
 *   optional   — a TIMED workingElsewhere event: join-if-free, skippable (M3)
 *   commitment — everything else, INCLUDING an all-day busy / oof
 *
 * P32 — an ALL-DAY `workingElsewhere` event is NOT a commitment. It used to be,
 * and the SAME search said the opposite one screen away: the walker's own
 * owner-event pass skips it explicitly ("an all-day Working Elsewhere marker is
 * NOT a block", findAvailableSlots.ts) and its free/busy pass skips every
 * `workingElsewhere` status, so the walker held the day open while this predicate
 * made checkSlot reject all 40 of its slots as `owner_busy_collision` — one
 * decision, two answers, which is the M2 bug regardless of which answer is right.
 * The right one is the walker's, on the merits: the full-day WE travel spine was
 * DELETED in 4.0.0 (M14) and away days are per-date `owner_schedule_overrides`
 * (#143) carrying their own hours and zone, so what is left on the calendar is a
 * marker for a day he is WORKING, just elsewhere. Blocking it would refuse every
 * booking on a WFH-marked day with "you're already busy" — a false reason for a
 * total refusal (M11). `optional` would be wrong too: that tier means a skippable
 * MEETING, and it would tag every slot of the day "you'd skip it".
 *
 * Rule 7 used to skip none of these — only `isCancelled` + excludeEventIds —
 * which is a 4.2.0 regression: the walker's owner-side travel padding moved
 * into this rule, and the walker's version read `allBusy`, where free-shows
 * were already filtered and floating blocks carved out. So the rule padded
 * against events the search never padded against, and search and book stopped
 * agreeing on which `Outside` slots exist.
 *
 * This CHANGES THE OFFERED SLOT SET, not just the labels. The live case is
 * LUNCH: a 25-min elastic block used to force a `travel_buffer_collision` on
 * every `Outside` slot within the buffer either side of it, so a 30-min buffer
 * erased the hour around lunch from the offer. Same for a free-show FYI and a
 * timed optional-join. Now none of the three pad — matching `allBusy`.
 *
 * What it does NOT restore, despite the shape of the old failure: an ALL-DAY
 * real commitment (busy / oof) still blocks its whole day. It just
 * reports honestly now — the occupancy scan sees it first and returns
 * `owner_busy_collision`, so rule 7 is never reached and nobody is told about
 * an "adjacent meeting at 00:00". The all-day events this predicate calls
 * `ignore` (a free-show marker, a floating-block-named all-day, an all-day WE)
 * DO become bookable again: they overlap every slot on their day, so under the
 * old skip list one of them cost the entire day.
 */
export type OccupancyRole = 'ignore' | 'optional' | 'commitment';

/**
 * isAllDayOutOfOffice — THE predicate for "his own calendar says he is OUT for
 * this whole day". Owner 2026-07-26: *"it doesn't [need] the
 * owner_schedule_overrides. my calendar really block OOO for that entire day,
 * it should be blocked anyway"* — the fact lives on the calendar and is honoured
 * from there, with no per-date override required.
 *
 * `oof` only, deliberately:
 *   • all-day `busy`            — far likelier a hold, a conference block or an
 *                                 imported travel row than a day off. Calling a
 *                                 held day "he's out" is a confident wrong reason.
 *   • all-day `workingElsewhere`— explicitly NOT this: it is a WORKING day, just
 *                                 elsewhere. `occupancyRoleOf` agrees now (P32) —
 *                                 it `ignore`s the marker instead of blocking the
 *                                 day, so the two no longer contradict.
 *   • `free` / cancelled        — not a block at all.
 *
 * It does NOT change bookability — `occupancyRoleOf` already calls an all-day
 * OOF a `commitment`, so every slot on the day collides. What it changes is what
 * is SAID: a day off reported as forty separate "already busy" hits narrates as
 * "fully booked", which is a false reason for a true refusal (M11).
 *
 * P29 — takes the three fields it actually reads, not `CalendarEvent`, so
 * `analyzeCalendar`'s ProcessedEvent (Graph events already parsed for narration)
 * calls THIS instead of carrying an inline copy of the same three-way test. Two
 * copies that agree today are one edit away from disagreeing about whether the
 * owner is away, and each would tell a different surface.
 */
export function isAllDayOutOfOffice(ev: {
  isCancelled?: boolean;
  isAllDay?: boolean;
  showAs?: string;
}): boolean {
  if (ev.isCancelled) return false;
  if (!ev.isAllDay) return false;
  return ev.showAs === 'oof';
}

/**
 * gh#200 — the [start, endExclusive) calendar-date span a single all-day OOF
 * event covers, in the OWNER's timezone. One event IS one span (a 20-day away
 * period is one Graph event with a start and a far-off end, not 20 separate
 * events), so this is deliberately NOT a merge across events — just the one
 * event's own start+duration turned into calendar dates.
 *
 * Shared so `analyzeCalendar`'s day-loop bucketing and `checkSlot`'s own
 * "away through" label (both gh#200) compute the SAME span off the SAME
 * inputs instead of two copies that could disagree about where an away
 * period ends. Takes an owner-local start DATE (not a raw Graph timestamp) so
 * either caller can feed it from whatever shape it already parsed the event
 * into — `analyzeCalendar`'s `ProcessedEvent._localDate`/`_durationMin`
 * (Graph timestamps deliberately stripped upstream) or `checkSlot`'s raw
 * `CalendarEvent` converted to owner-local at the call site.
 */
export interface OofSpan {
  eventId: string;
  startDate: string;          // yyyy-MM-dd, owner tz
  endDateExclusive: string;   // yyyy-MM-dd, owner tz — first day NOT covered
}

export function computeOofSpan(
  eventId: string,
  startDateOwnerLocal: string,
  durationMin: number,
  ownerTz: string,
): OofSpan {
  return {
    eventId,
    startDate: startDateOwnerLocal,
    endDateExclusive: DateTime.fromISO(startDateOwnerLocal, { zone: ownerTz })
      .plus({ minutes: durationMin })
      .toFormat('yyyy-MM-dd'),
  };
}

/**
 * two-duplicate-away-span-format-producers (2026-08-14) — the
 * display-formatting half of an OOF span, extracted so `checkSlot` (below)
 * and the search-path walker (`graph/findAvailableSlots.ts`) call this ONE
 * function for the "away through <date>" string instead of each re-deriving
 * the identical 4-step recipe by hand (endExclusive → minus 1 day →
 * yyyy-MM-dd → multi-day test → toFormat). `computeOofSpan`'s own shared seam
 * stopped one step short of here — both pipelines still formatted the span's
 * display string independently. Returns undefined for a single-day span:
 * there's nothing extra to say beyond "he's out that day".
 */
export function formatOofUntilDisplay(span: OofSpan, ownerTz: string): string | undefined {
  const lastDayInclusive = DateTime.fromISO(span.endDateExclusive, { zone: ownerTz })
    .minus({ days: 1 })
    .toFormat('yyyy-MM-dd');
  if (lastDayInclusive <= span.startDate) return undefined;
  return DateTime.fromISO(lastDayInclusive, { zone: ownerTz }).toFormat('EEEE d MMM');
}

export function occupancyRoleOf(
  ev: CalendarEvent,
  floatingBlockDefs: ReturnType<typeof getFloatingBlocks>,
): OccupancyRole {
  if (ev.isCancelled) return 'ignore';
  if (ev.showAs === 'free') return 'ignore';   // only 'free' is a non-collision; 'tentative' falls through to 'commitment' below and DOES collide
  // v3.6.4 — a TIMED workingElsewhere event is an OPTIONAL-join (join only if
  // free), NOT a hard commitment. This one classification is what lets the slot
  // finder TAG a slot over it as WE-soft instead of dropping it, and lets a
  // booking sit over it with no conflict flag.
  if (!ev.isAllDay && ev.showAs === 'workingElsewhere') return 'optional';
  // P32 — an ALL-DAY WE marker is a working day elsewhere, not a commitment and
  // not a skippable meeting. Ignored, which is what the walker always did.
  if (ev.showAs === 'workingElsewhere') return 'ignore';
  // A movable floating block (lunch / focus / gym) is NOT a hard collision:
  // rule 6 already validated it can still fit elsewhere in its window, and
  // `rebalanceFloatingBlocksAfterMutation` slides it after the write commits.
  if (floatingBlockDefs.some(b => isFloatingBlockEvent(ev, b))) return 'ignore';
  return 'commitment';
}

export function checkSlot(input: RuleCheckInput): RuleCheckResult {
  const { profile } = input;
  const tz = profile.user.timezone;
  // Anchor a ZONELESS slot in the owner's home tz, not the server's local tz
  // (the normalizeForGraph drift class — a naive "10:00" was read in the
  // travel-zone server clock → wrong work-hours verdict). `setZone:true` still
  // respects an explicit offset on a search-emitted slot.
  const slotStart = DateTime.fromISO(input.slotStartIso, { zone: tz, setZone: true }).setZone(tz);
  const slotEnd = DateTime.fromISO(input.slotEndIso, { zone: tz, setZone: true }).setZone(tz);
  const excludeSet = new Set(input.excludeEventIds ?? []);
  const dayName = slotStart.toFormat('EEEE');
  // v3.7.x (#143) — the slot date's effective work context: threaded by the
  // search (so search + book agree) or self-resolved from the slot's home-tz
  // date. Rules 1/5/9 read workday-ness, windows, location + timezone from it.
  const effectiveDay = input.effectiveDay ?? getEffectiveWorkDayForInstant(input.slotStartIso, profile);
  const viewer: SubjectViewer = input.viewer ?? 'other';
  // v4.4.9 (#154) — see the field doc on RuleCheckInput.viewerEmail.
  const viewerEmail = input.viewerEmail;
  const ownerFirst = profile.user.name.split(' ')[0];
  // M11 — WHO reads the label this validator produces. The owner reads his own
  // heads-up (planMeeting's one-step `overrideNotice`), a colleague reads about
  // him. Pre-fix every label was third person, so the lead-time rule told Idan
  // "Idan needs at least 1h notice for a new booking".
  const ownerReads = viewer === 'owner';
  const who = ownerReads ? 'you' : ownerFirst;
  const whose = ownerReads ? 'your' : `${ownerFirst}'s`;

  // ── (b) WORK-BAND FIT (rule 5's data) — unconditional, BEFORE the ladder ──
  // The arithmetic rule 5 reports on, computed once so it can be reported as a
  // FACT on every verdict (P25 — see the header). Windows come from the effective
  // day, and the slot's minute-of-day is evaluated in the day's EFFECTIVE
  // timezone: for an away override ("Boston 9-5 EST") the windows are stated in
  // that zone, so the instant is converted there before the fit check. No
  // override → effectiveTz is the home tz → identical to reading the home clock.
  // start + duration so a slot ending past midnight does NOT wrap to a small
  // minute-of-day and spuriously fit a daytime window.
  const workWindows = effectiveDay.windows;
  const slotStartEff = slotStart.setZone(effectiveDay.timezone);
  const slotEndEff = slotEnd.setZone(effectiveDay.timezone);
  const { startMin: slotStartMin, endMin: slotEndMin } = slotDayMinutes(slotStartEff, slotEndEff);
  const fitsWorkWindow = workWindows.some(w => slotStartMin >= w.startMin && slotEndMin <= w.endMin);

  // ── OCCUPANCY SCAN (rule 8's data) — unconditional, BEFORE the ladder ────
  // ONE scan answers two questions that used to be answered in two places:
  //   (a) the M3 LEVEL of this slot — free / optional / unfiltered. The slot
  //       walker used to re-derive the optional tier itself from the same
  //       events (its own `softOccupied` pass) while the write path derived
  //       nothing at all, which is why a named-time booking straight over the
  //       owner's optional standup came back indistinguishable from booking a
  //       genuinely free slot. The walker now reads `overOptional` from here.
  //   (b) the owner_busy_collision violation, returned just below rule 0.
  // Hoisted above the ladder because it costs nothing (a loop over events the
  // caller already fetched — no I/O) and because leaving it at position 8 meant
  // seven rules could short-circuit ahead of it and hand the caller a verdict
  // with no tier and a soft reason for a hard conflict.
  const floatingBlockDefs = getFloatingBlocks(profile);
  const ownerEmailLower = profile.user.email.toLowerCase();
  let level: BookingLevel = 'free';
  let overOptional: string | undefined;
  let overCommitment: RuleCheckResult['overCommitment'];
  for (const ev of input.events) {
    if (excludeSet.has(ev.id)) continue;
    const role = occupancyRoleOf(ev, floatingBlockDefs);
    if (role === 'ignore') continue;
    const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
    const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' });
    if (!(evStart < slotEnd && evEnd > slotStart)) continue;
    if (role === 'optional') {
      if (level === 'free') {
        level = 'optional';
        {
          const subj = displaySubject(ev, profile, viewer, viewerEmail);
          overOptional = (subj && subj !== PRIVATE_MASK) ? subj : 'an optional meeting';
        }
      }
      continue;
    }
    // A real commitment. Highest tier wins — stop looking.
    level = 'unfiltered';
    overOptional = undefined;
    {
      const commitSubj = displaySubject(ev, profile, viewer, viewerEmail);
      const isOof = isAllDayOutOfOffice(ev);
      // gh#200 — when the OOF is a MULTI-day span, the last day it covers
      // (inclusive), off the SAME `computeOofSpan` analyzeCalendar uses — so a
      // caller can say "away through Aug 29" once instead of re-explaining
      // "away that whole day" for every day a colleague proposes inside a
      // known away period. Unset for a single-day OOF: nothing extra to say.
      // Formatted ONCE, via `formatOofUntilDisplay` (two-duplicate-away-span-
      // format-producers) — the SAME function the search-path walker
      // (graph/findAvailableSlots.ts) calls, so the two pipelines can no
      // longer disagree about the display string. Every consumer of the
      // result (this file's own violation_label below, check_join_availability,
      // availabilityPreCheck's ledger + narration) quotes it verbatim and
      // never re-derives via its own DateTime.fromISO.
      let allDayOutOfOfficeUntilDisplay: string | undefined;
      if (isOof) {
        const span = computeOofSpan(
          ev.id,
          evStart.setZone(tz).toFormat('yyyy-MM-dd'),
          evEnd.diff(evStart, 'minutes').minutes,
          tz,
        );
        allDayOutOfOfficeUntilDisplay = formatOofUntilDisplay(span, tz);
      }
      overCommitment = {
        id: ev.id,
        subject: (commitSubj && commitSubj !== PRIVATE_MASK) ? commitSubj : 'meeting',
        attendeeCount: (ev.attendees ?? []).filter(
          a => (a?.emailAddress?.address ?? '').toLowerCase() !== ownerEmailLower,
        ).length,
        // An all-day block (vacation / OOF / conference) has no clock window —
        // rendering it as "00:00–00:00" reads like a zero-length meeting. It only
        // became visible here once the scan started reporting all-day commitments
        // ahead of the work-hours rule.
        window: ev.isAllDay
          ? 'all day'
          : `${evStart.setZone(tz).toFormat('HH:mm')}–${evEnd.setZone(tz).toFormat('HH:mm')}`,
        ...(isOof ? { allDayOutOfOffice: true as const } : {}),
        ...(allDayOutOfOfficeUntilDisplay ? { allDayOutOfOfficeUntilDisplay } : {}),
        ...(ev.isAllDay ? { isAllDay: true as const } : {}),
      };
    }
    break;
  }
  // The unconditional facts, spread into EVERY return below — including the ones
  // a higher-ranked rule produces. A verdict for which "we didn't look" is the
  // honest answer does not exist.
  const slotFacts = {
    level,
    ...(overOptional ? { overOptional } : {}),
    ...(overCommitment ? { overCommitment } : {}),
    ...(fitsWorkWindow ? {} : { outsideWorkHours: true as const }),
  };

  // ── (0) in the past ─────────────────────────────────────────────────────
  // Never silently book a slot that has already started — a past / earlier-today
  // time is almost always a typo (a "book at 9am" when it's 2pm). planMeeting
  // turns this into a ONE-TIME clarify ("did you mean later today?"), and the
  // owner's "yes/force" comes back allowRelaxed → this bypasses so the confirm
  // loop terminates (he CAN log a past meeting if he insists). find_available_slots
  // enforces the fuller booking lead-time for OFFERED slots; this is the
  // write-path floor that named-time create/move was missing.
  if (!input.allowRelaxed && slotStart.toMillis() < DateTime.now().toMillis()) {
    return {
      passes: false,
      violation_kind: 'in_the_past',
      violation_label: 'that time has already passed',
      ...slotFacts,
    };
  }

  // ── (8) owner busy collision — the HARD truth, ahead of the soft rules ──
  // Position, not the check itself, is the fix. "Is he already committed?" is a
  // fact about the calendar; reporting a soft rule instead — because it happens
  // to sit earlier in the ladder — is a confident WRONG reason (M11) and, on
  // the owner's one-step book-through, books a double-booking he was never told
  // about (M3). Every consumer that already branches on `owner_busy_collision`
  // (the join tool, the colleague pre-check's escalatable set, the approval
  // re-derive, planMeeting) now gets the truthful verdict with no change of
  // its own — which is the point: one validator, one answer.
  // Two carve-outs skip the VIOLATION but NOT the scan — the level is still
  // reported above so the caller can annotate:
  //   • `allowRelaxed: true` — owner explicit override after a flag. Regular
  //     create_meeting still flags overlaps the first time so Maelle doesn't
  //     silently double-book a meeting with attendees.
  //   • `isFloatingBlock: true` — focus / lunch / gym blocks are SIGNALS that
  //     coexist with meetings by design; never block them on owner_busy.
  if (!input.allowRelaxed && !input.isFloatingBlock && overCommitment) {
    return {
      passes: false,
      violation_kind: 'owner_busy_collision',
      // An all-day OOF is the same hard collision, but it is a day OFF, not
      // a clash: "already busy at this time" invites "then what about 30 min
      // later", which has the same answer all day. gh#200 — when the span
      // reaches past this one day, name the real end ("away through Fri 29
      // Aug") instead of just this day, so a colleague proposing several
      // different days inside the same away period is told the whole window
      // once instead of a fresh day-scoped "out of office" for each one.
      violation_label: overCommitment.allDayOutOfOffice
        ? overCommitment.allDayOutOfOfficeUntilDisplay
          ? `${ownerReads ? "you're" : `${ownerFirst} is`} away through ${overCommitment.allDayOutOfOfficeUntilDisplay} ("${overCommitment.subject}")`
          : `${ownerReads ? "you're" : `${ownerFirst} is`} out of office all day on ${slotStart.toFormat('EEEE d MMM')} ("${overCommitment.subject}")`
        : `${ownerReads ? "you're" : `${ownerFirst} is`} already busy at this time ("${overCommitment.subject}" ${overCommitment.window})`,
      ...slotFacts,
    };
  }

  // ── (0b) booking lead time ──────────────────────────────────────────────
  // v4.1.x (M2) — the owner's "how much notice do I need" floor. This lived
  // ONLY inside the slot walker (`minBufferHours`), so search and book gave
  // DIFFERENT answers for the same slot: the search dropped a colleague's
  // "3pm today" asked at 2pm as `within_lead_time`, while the colleague
  // pre-check and create_meeting both accepted it — silently defeating the
  // 4-hour colleague lead time. Now it is a real rule here, keyed on the
  // caller's role via bookingLeadTimeHours, and the walker READS it from here.
  // Instant-only comparison (no zone inference — M13 forbids the server clock
  // for zones, not for "what time is it now").
  if (!input.allowRelaxed && isWithinBookingLeadTime(slotStart.toMillis(), input.leadTimeHours)) {
    return {
      passes: false,
      violation_kind: 'within_lead_time',
      violation_label: `that's too soon — ${who} need${ownerReads ? '' : 's'} at least ${input.leadTimeHours}h notice for a new booking`,
      ...slotFacts,
    };
  }

  // ── (1) vacation / off day ──────────────────────────────────────────────
  // v3.7.x (#143) — via the effective day, so a per-date "off" override and a
  // normally-off yaml day read the same. No override → identical to the old
  // office/home name check.
  if (!effectiveDay.isWorkday) {
    return {
      passes: false,
      violation_kind: 'vacation_or_off_day',
      violation_label: effectiveDay.hasOverride
        ? `${who} ha${ownerReads ? 've' : 's'} ${slotStart.toFormat('EEEE d MMM')} off`
        : `${dayName} isn't one of ${whose} working days`,
      ...slotFacts,
    };
  }

  // ── (2-4) category rules ────────────────────────────────────────────────
  // Bypassed under allowRelaxed — owner override is total (rule 11); the search
  // path likewise skips category in relaxed mode, so the two stay aligned.
  if (!input.allowRelaxed) {
    const catCheck = checkCategorySlot({
      slotStart,
      slotEnd,
      categoryName: input.category,
      events: input.events,
      profile,
      excludeEventId: input.excludeEventIds?.[0],  // checkCategorySlot supports single exclude
    });
    if (!catCheck.allowed) {
      const map: Record<string, RuleViolationKind> = {
        day_type: 'category_day_type',
        per_day: 'category_per_day',
        per_week: 'category_per_week',
      };
      return {
        passes: false,
        violation_kind: map[catCheck.rule_broken!] ?? 'category_day_type',
        violation_label: catCheck.human_explanation ?? `${input.category} category rule violated`,
        ...slotFacts,
      };
    }
  }

  // ── (5) working hours ───────────────────────────────────────────────────
  // v2.8.1 — multi-window aware. Slot must fit fully inside ANY of the
  // owner's work-hour windows for the day (e.g. Tuesday split into
  // 09:00-15:30 + 21:30-23:59 — a 21:45-22:10 slot is valid).
  // v3.7.x (#143) — windows + the zone-correct fit are computed ONCE above the
  // ladder (`fitsWorkWindow`), so the rule that reports the violation and the fact
  // every verdict carries can never be two different answers. This branch is the
  // REPORT half only.
  if (!input.allowRelaxed && !fitsWorkWindow) {
    const windowsLabel = workWindows.length === 0
      ? '(no work hours configured for this day)'
      : workWindows.map(w => `${String(Math.floor(w.startMin/60)).padStart(2,'0')}:${String(w.startMin%60).padStart(2,'0')}–${String(Math.floor(w.endMin/60)).padStart(2,'0')}:${String(w.endMin%60).padStart(2,'0')}`).join(', ');
    const zoneNote = effectiveDay.isAway ? ` (${effectiveDay.timezone})` : '';
    return {
      passes: false,
      violation_kind: 'outside_working_hours',
      violation_label: `Slot ${slotStartEff.toFormat('HH:mm')}–${slotEndEff.toFormat('HH:mm')}${zoneNote} is outside working hours (${windowsLabel})`,
      ...slotFacts,
    };
  }

  // ── (6) floating block overlap — MOVABILITY CHECK ───────────────────────
  // v2.7.0 — floating blocks (lunch, coffee, focus) live in a preferred
  // window WIDER than their duration. Lunch is 25min inside an 11:30-13:30
  // (120min) window — the block can shift. A new slot inside the window is
  // a problem ONLY when accommodating it leaves no contiguous free segment
  // ≥ block.duration_minutes elsewhere in the window.
  //
  // Algorithm per block:
  //   1. Bound the window to today (slotStart's day).
  //   2. Collect busy intervals inside the window from input.events
  //      (excluding excludeEventIds + cancelled + free-shows).
  //   3. Add the proposed slot to the busy set (clipped to the window).
  //   4. Compute the union of busy intervals; compute the FREE intervals
  //      that remain inside the window.
  //   5. If max(free interval length) >= block.duration_minutes → pass.
  //      Otherwise: fail with a label naming the block.
  // v3.7.x (#143) — skip on an override day: no floating blocks live there, so
  // there's no lunch/gym window to protect (and a normal meeting isn't blocked
  // for a block that won't be booked that day).
  if (!input.allowRelaxed && !effectiveDay.hasOverride) {
    for (const block of floatingBlockDefs) {
      // v4.1.x — honor the block's DAY SCOPE. This rule read the raw yaml list
      // and ignored `block.days`, so a Thursday-only coffee block constrained
      // Monday bookings — while every OTHER floating-block surface (rebalance,
      // calendar-health, check_join_availability) went through blockAppliesOnDay
      // and correctly skipped it. Same predicate everywhere now, which is what
      // lets the join tool stop carrying its own copy of this check.
      if (!blockAppliesOnDay(block, dayName, profile)) continue;
      const [psH, psM] = block.preferred_start.split(':').map(Number);
      const [peH, peM] = block.preferred_end.split(':').map(Number);
      const windowStart = slotStart.set({ hour: psH, minute: psM, second: 0, millisecond: 0 });
      const windowEnd = slotStart.set({ hour: peH, minute: peM, second: 0, millisecond: 0 });
      // If the proposed slot doesn't overlap the window at all, no concern.
      if (slotEnd <= windowStart || slotStart >= windowEnd) continue;
      // v3.1.5 (Bug 1) — the proposed slot IS a floating block (book_floating_block
      // → planMeeting with isFloatingBlock=true), and it sits inside THIS block's
      // window → it's THIS block being booked. Don't check whether the block can
      // "still fit elsewhere" after placing itself — that's circular
      // self-rejection (placing 25-min lunch in the only gap, then failing
      // because lunch can't ALSO fit). findAlignedSlotForBlock already validated
      // the placement. Other blocks (different windows) are still checked, so
      // booking lunch can't silently squeeze out a separate gym/coffee block.
      if (input.isFloatingBlock && slotStart >= windowStart && slotEnd <= windowEnd) continue;

      const blockDurationMin = block.duration_minutes ?? 25;

      // Collect busy intervals inside the window (today only).
      const busyInWindow: Array<{ start: number; end: number }> = [];
      for (const ev of input.events) {
        if (ev.isCancelled) continue;
        if (excludeSet.has(ev.id)) continue;
        if (ev.showAs === 'free') continue;
        // v3.6.4 — a timed optional-join (WE-soft) yields to a floating block:
        // the owner drops the optional to keep lunch, so it never occupies the
        // window for feasibility. Keeps this rule consistent with the search /
        // health pools that also treat timed-WE as reclaimable free time.
        // P32 — the ALL-DAY marker yields too. It occupies no clock time at all, so
        // leaving it in filled the whole lunch window and would have turned every
        // slot on a WFH-marked day into `floating_block_overlap` the moment the
        // occupancy scan stopped masking it with a collision.
        if (ev.showAs === 'workingElsewhere') continue;
        const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
        const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' });
        // Skip if event doesn't overlap the window.
        if (evEnd <= windowStart || evStart >= windowEnd) continue;
        // Skip if this IS the floating block itself (subject matches the
        // block's name — lunch / coffee / etc). It will shift, not collide.
        const subj = (ev.subject ?? '').toLowerCase();
        const blockName = block.name.toLowerCase();
        if (subj.includes(blockName)) continue;
        busyInWindow.push({
          start: Math.max(evStart.toMillis(), windowStart.toMillis()),
          end: Math.min(evEnd.toMillis(), windowEnd.toMillis()),
        });
      }
      // Add the proposed slot, clipped to the window.
      busyInWindow.push({
        start: Math.max(slotStart.toMillis(), windowStart.toMillis()),
        end: Math.min(slotEnd.toMillis(), windowEnd.toMillis()),
      });

      // Merge overlapping intervals.
      busyInWindow.sort((a, b) => a.start - b.start);
      const merged: Array<{ start: number; end: number }> = [];
      for (const iv of busyInWindow) {
        const last = merged[merged.length - 1];
        if (last && iv.start <= last.end) {
          last.end = Math.max(last.end, iv.end);
        } else {
          merged.push({ ...iv });
        }
      }

      // Compute longest free contiguous segment inside the window.
      let longestFreeMs = 0;
      let cursor = windowStart.toMillis();
      const winEndMs = windowEnd.toMillis();
      for (const busy of merged) {
        if (busy.start > cursor) {
          longestFreeMs = Math.max(longestFreeMs, busy.start - cursor);
        }
        cursor = Math.max(cursor, busy.end);
      }
      if (cursor < winEndMs) {
        longestFreeMs = Math.max(longestFreeMs, winEndMs - cursor);
      }
      const longestFreeMin = Math.floor(longestFreeMs / 60_000);

      if (longestFreeMin < blockDurationMin) {
        return {
          passes: false,
          violation_kind: 'floating_block_overlap',
          violation_label: `Booking this would leave no room for ${whose} ${block.name} (${blockDurationMin}min needed in ${block.preferred_start}–${block.preferred_end} window; only ${longestFreeMin}min free after this slot)`,
          ...slotFacts,
        };
      }
    }
  }

  // ── (7) travel buffer ───────────────────────────────────────────────────
  // Bypassed under allowRelaxed — owner override is total (rule 11), and the
  // search loop likewise skips its buffer check in relaxed mode, so the two
  // stay aligned (a relaxed owner search must still return the slot).
  // v4.1.x (M2) — length resolved by the ONE helper: the caller's explicit
  // travel_buffer_minutes wins, else the category flag draws the configured
  // length. Pre-fix this was a hardcoded 30 that ignored the caller entirely,
  // so a `travel_buffer_minutes: 60` search dropped slots the write path then
  // happily booked.
  const bufMin = travelBufferMinutesFor(profile, input.category, input.travelBufferMinutes);
  if (bufMin > 0 && !input.allowRelaxed) {
    const beforeWindowStart = slotStart.minus({ minutes: bufMin });
    const afterWindowEnd = slotEnd.plus({ minutes: bufMin });
    for (const ev of input.events) {
      if (excludeSet.has(ev.id)) continue;
      // Only a real commitment can cost him travel time — the SAME classifier
      // the occupancy scan uses, so the two can't drift (a free-show FYI, a
      // skippable optional-join and an elastic lunch block all used to count,
      // and lunch alone erased the buffer-width band around it from every
      // Outside offer).
      if (occupancyRoleOf(ev, floatingBlockDefs) !== 'commitment') continue;
      // All-day commitments have no travel geometry. An all-day event that
      // overlaps THIS slot can't reach here at all (the scan saw it and rule 8
      // returned), so what this skips is the one remaining shape: a NEIGHBOURING
      // day's all-day event pulled into the buffer window by a slot near
      // midnight — "adjacent meeting at 00:00", which is a midnight boundary,
      // not a commute.
      if (ev.isAllDay) continue;
      const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
      const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' });
      if (evStart < afterWindowEnd && evEnd > beforeWindowStart) {
        // Any event overlapping the buffer window collides — no same-venue exemption.
        return {
          passes: false,
          violation_kind: 'travel_buffer_collision',
          violation_label: `${input.category ?? 'this meeting'} needs ${bufMin}min travel buffer on each side; adjacent meeting at ${evStart.setZone(tz).toFormat('HH:mm')} too close`,
          ...slotFacts,
        };
      }
    }
  }

  // v2.7.1 — rule (9) owner_buffer_collision deleted. The 5-min between-meeting
  // buffer is baked into the standard durations (10/25/40/55) at aligned
  // starts (:00/:15/:30/:45). Connected back-to-backs are fine; a separate
  // collision check duplicated the work and incorrectly rejected slots like
  // 17:00 directly after a meeting ending 17:00.

  // ── (9) daily focus-time floor (v3.1.2 C) ────────────────────────────────
  // The length-based daily-free-time floor (requiredFreeMinutesForWorkDay) used to live ONLY in
  // find_available_slots — so a named-time create_meeting / move_meeting /
  // coord pick would book on a packed day that the search path would have
  // refused. Now enforced here too via the shared computeDayQualityFreeMinutes
  // helper. Bypassed when allowRelaxed=true (explicit owner override IS the
  // approval) and when isFloatingBlock=true (focus/lunch/gym blocks are
  // signals that coexist with meetings; the math already ignores showAs=free
  // anyway, but skip to match the rest of the relaxed semantics).
  if (!input.allowRelaxed && !input.isFloatingBlock) {
    // v3.7.x (#143) — office/home via the effective day; an away day (elsewhere)
    // skips the focus floor (a trip day isn't held to the home focus-time theory).
    // The window + total come from effectiveDay.windows, so a per-date hours
    // override ("Tuesday 9-3") is measured against the overridden hours, and the
    // free-time math runs in the effective timezone. No override → identical to the
    // old yaml-window floor. Same source of truth as analyze_calendar +
    // calendar-health, so search, book, and review can never disagree.
    if (effectiveDay.location === 'office' || effectiveDay.location === 'home') {
      let workTotalMinForFloor = 0;
      for (const w of effectiveDay.windows) workTotalMinForFloor += (w.endMin - w.startMin);
      const requiredMin = requiredFreeMinutesForWorkDay(workTotalMinForFloor, profile.meetings.work_hours_per_free_hour);
      if (requiredMin > 0 && effectiveDay.windows.length > 0) {
        const minChunk = profile.meetings.thinking_time_min_chunk_minutes ?? 30;
        // Build busyBlocks from this day's events, minus excluded ids.
        // showAs='free' events don't block focus time; isAllDay doesn't either
        // (vacation markers etc.); a timed optional-join (WE-soft) is reclaimable
        // free time and is skipped too (matches the search + calendar-health
        // pools). Parse zone-aware (Graph dateTime is bare wall-clock + .timeZone)
        // so an off-owner-TZ host doesn't skew the blocks.
        const busyBlocks: Array<{ start: Date; end: Date }> = [];
        for (const ev of input.events) {
          if (ev.isCancelled) continue;
          if (excludeSet.has(ev.id)) continue;
          if (ev.showAs === 'free') continue;
          if (!ev.isAllDay && ev.showAs === 'workingElsewhere') continue;
          if (ev.isAllDay) continue;
          busyBlocks.push({
            start: DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).toJSDate(),
            end: DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' }).toJSDate(),
          });
        }
        // Add the proposed slot itself — checking what's left after booking.
        busyBlocks.push({ start: slotStart.toJSDate(), end: slotEnd.toJSDate() });
        // Union window bounds (earliest start … latest end) across the day's
        // effective windows, formatted for the free-time helper.
        let earliestMin = 24 * 60;
        let latestMin = 0;
        for (const w of effectiveDay.windows) {
          if (w.startMin < earliestMin) earliestMin = w.startMin;
          if (w.endMin > latestMin) latestMin = w.endMin;
        }
        const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const dayDate = slotStart.setZone(effectiveDay.timezone).toFormat('yyyy-MM-dd');
        const dayFreeMin = computeDayQualityFreeMinutes({
          dayDate,
          timezone: effectiveDay.timezone,
          workStart: hhmm(earliestMin),
          workEnd: hhmm(Math.min(latestMin, 1439)),
          busyBlocks,
          minChunkMinutes: minChunk,
        });
        if (dayFreeMin < requiredMin) {
          return {
            passes: false,
            violation_kind: 'focus_time_floor',
            violation_label: `Booking this leaves ${who} with ${Math.round(dayFreeMin)} min of free time on ${dayName} — below the ${requiredMin}-min floor for a ${workTotalMinForFloor}-min work day.`,
            ...slotFacts,
          };
        }
      }
    }
  }

  return { passes: true, ...slotFacts };
}
