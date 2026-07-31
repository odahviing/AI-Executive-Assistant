import { DateTime } from 'luxon';
import logger from '../../utils/logger';
import type { UserProfile } from '../../config/userProfile';
import { slotDayMinutes } from '../../utils/workHours';
import { scoreSlotDensity, densityConfigFromProfile, prefersDensePacking } from '../../utils/calendarDensity';
import type { MeetingMode, CalendarEvent } from './calendarTypes';
import { getFreeBusyForDecision, getOwnerEventsForDecision, CalendarOfflineError, isOutageShaped } from './calendarReads';
import type { RuleCheckResult } from '../../utils/scheduleRules';

/**
 * ONE offered-slot shape. Was written out inline three times (the return type,
 * the accumulator, the per-day buckets), so adding a field meant editing three
 * literals and the walker could push a field the signature didn't promise.
 */
type SlotCandidate = {
  start: string;
  end: string;
  day_type?: 'office' | 'home' | 'other';
  disturbs_floating_block?: boolean;
  over_optional?: string;
  /**
   * The owner-rule this slot BREAKS, in his own words — set only on a `relaxed`
   * search, which is the only pass that returns a rule-breaking slot at all.
   * Quoted verbatim from `checkSlot`'s own `violation_label` (never re-derived),
   * so what the model narrates is what the validator decided. Owner-viewer only:
   * these labels name his mechanisms ("below the 120-min floor"), which a
   * colleague must never see.
   */
  broken_rule_label?: string;
  attendee_conflicts?: Array<{ email: string; reason: 'busy' | 'off_hours' }>;
};

// ── Slot-rule helpers ────────────────────────────────────────────────────────

export async function findAvailableSlots(params: {
  userEmail: string;
  timezone: string;
  durationMinutes: number;
  searchFrom: string;
  searchTo: string;
  preferMorning?: boolean;
  workDays?: string[];
  workHoursStart?: string;
  workHoursEnd?: string;
  extendedHours?: boolean;
  minBufferHours?: number;
  profile?: UserProfile;
  // v1.6.4 — mode determines which days are valid + travel buffer
  meetingMode?: MeetingMode;       // default 'either' (back-compat)
  travelBufferMinutes?: number;    // custom mode only; padded on both sides
  // v1.6.4 — auto-expand search until we have ≥3 slots or hit maxSearchDays
  autoExpand?: boolean;            // default true
  maxSearchDays?: number;          // default 21
  // v3.7.x (#133 fix) — align the walk's FIRST cursor UP to the :00/:15/:30/:45
  // grid. OPT-IN (default off): the shared walker is ALSO a single-slot VALIDATOR
  // (create/move colleague Guard B, candidate_slots, counter auto-accept) that must
  // test the EXACT — possibly off-grid — named start; aligning there made the walk
  // return 0 → false "unavailable" / false escalation. Only the defrag (off-grid
  // keptEnd, wants the aligned back-to-back start) passes true.
  gridAlignStart?: boolean;
  // v2.2.3 (#43) — opt-in deeper search. By default we only filter slots
  // against the OWNER's busy time + each attendee's working window (cheap, no
  // assumptions about which of the attendee's meetings are movable). When the
  // recipient explicitly opts in to "find a time I'm free," pass their email
  // here to also subtract their busy time from the candidate pool.
  attendeeBusyEmails?: string[];
  // v2.2.3 (#43) — per-attendee working windows. Slots that fall outside ANY
  // listed attendee's workdays / hoursStart..hoursEnd (in their own TZ) are
  // dropped before Graph cost. Empty / omitted → no clipping.
  attendeeAvailability?: Array<{
    email: string;
    timezone: string;          // IANA (now-resolved — travel TZ only while a trip is active today)
    workdays: Array<'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday'>;
    hoursStart: string;        // 'HH:MM'
    hoursEnd: string;
    // v3.3.8 — per-day travel resolution (see utils/attendeeAvailability.ts).
    // The clip resolves the attendee's TZ for the candidate's DAY: inside
    // travelWindow [from, until] → its timezone; outside → homeTimezone.
    homeTimezone?: string;     // stored profile IANA
    travelWindow?: { from: string; until: string; timezone: string; location: string };
  }>;
  // Rule 6 — attendee free/busy is a HELPER, never a blocker. When true, a slot
  // where an attendee is busy / off-hours is KEPT and TAGGED (attendee_conflicts)
  // instead of dropped — WITHOUT relaxing any of the OWNER's own rules (his
  // work-hours, own busy, focus floor, floating blocks all still apply via
  // checkSlot). This is the decoupled half of `relaxed`: `relaxed` tags attendee
  // conflicts too, but as part of a TOTAL owner-rule override (rule 11); this
  // flag tags them while the owner's day stays strict — so the owner-path
  // backstop can surface "his genuinely open times + who can't make each" when
  // no slot is clean for everyone. Requires attendeeBusyEmails/attendeeAvailability
  // to be passed (that's what populates the conflict data). No effect otherwise.
  tagAttendeeConflicts?: boolean;
  // Owner-override "show me everything" mode. It bends the owner's SOFT rules
  // only — it can never surface a slot a real commitment already holds. See the
  // proposal guard below the checkSlot call: `allowRelaxed` waives rule 8 for the
  // WRITE path (his informed one-step book-through), and the search does not
  // inherit that waiver. When true:
  //   - skips focus-time protection (free_time_per_office/home_day_hours)
  //   - skips floating-block feasibility check (lunch/coffee/etc. windows)
  //   - on owner-path with attendees: drops the attendee busy filter
  //   - on owner-path with attendees: drops the attendee work-hours clip
  //     (caller controls both via `attendeeBusyEmails`/`attendeeAvailability`
  //     — owner override lands by passing `undefined` for both)
  //
  // Does NOT inherently widen the owner's own hours. The 07:00–22:00
  // widening comes from the CALLER passing `workHoursStart/End='07:00'/'22:00'`
  // (currently gated on `extendedHours`, not `relaxed`). A relaxed-only
  // call without explicit widening still reads per-day work_hours via
  // `getOwnerWorkHoursForDay` and UNIONS them with the default 09:00–18:00
  // widened range.
  // ALWAYS keeps the 5-min buffer between meetings (sacred).
  // Day type (work day vs day off) is also still respected.
  // Caller is expected to narrate to the owner that these slots break their
  // soft rules ("outside your focus protection / lunch window / normal hours").
  relaxed?: boolean;
  // Relax the owner's soft DAY-LOAD rules without extending his working DAY.
  // Opt-in, and exactly one caller sets it: find_available_slots' automatic
  // relaxed recovery, which exists to surface "13:00 lands on your lunch —
  // anyway?" and must never answer "how about 02:00".
  //
  // It used to be a post-filter in the handler that re-derived the day's windows
  // (getEffectiveWorkDay + isSlotInWorkHours) and dropped out-of-hours slots
  // AFTER this function had already spent its per-day budget on them — so a
  // recovery whose top-ranked candidates were all nocturnal returned NOTHING
  // (logs/maelle-2026-07-26.log 06:59:36: `relaxedAccepted: 8` → `kept: 0`).
  // Now the decision is here, above the cap, reading the validator's own
  // `outsideWorkHours` fact rather than a second copy of the window arithmetic
  // (which, computed in the SEARCH zone instead of the day's effective zone,
  // could disagree with checkSlot on an away day — M2).
  keepWorkHours?: boolean;
  // v4.1.x (M12) — WHO the returned annotations are for. The only annotation
  // that carries free text is `over_optional` (the optional-join event's
  // subject), and find_available_slots is colleague-allowed, so a private
  // optional event would otherwise name itself to a colleague. Threaded into
  // checkSlot, which does the masking at the producer. Default (omitted) masks.
  viewer?: import('../../utils/displaySubject').SubjectViewer;
  // v2.4.1 — events to treat as "the meeting(s) being moved." Each id is
  // matched against the owner's calendar events for the search range and
  // produces TWO behaviors:
  //   1) The event's time range is SUBTRACTED from the owner's busy pool —
  //      so other candidate slots aren't blocked by a meeting that's about
  //      to move away. (Same pattern as floating-block subtraction.)
  //   2) The event's time range is FORBIDDEN as a candidate — so the slot
  //      finder never offers the original time (or any overlap with it) as
  //      a "move target". 11:00 + 10:45 are both excluded when moving an
  //      11:00-11:45 meeting because they're not really moves.
  // Pass when validating ("can we move it to 10:30?") or discovering ("what
  // are options to move it?") a move. Omit for new bookings.
  excludeEventIds?: string[];
  // v3.8.x — defrag exemption for behavior 2 above. When true, the moving
  // event is still SUBTRACTED from busy (behavior 1) but its original slot is
  // NOT added to the forbidden-zone list (behavior 2 is skipped). Calendar-
  // health defrag needs this: a pull/push closes a 6–29 min dead gap by moving
  // the meeting LESS than its own duration, so the back-to-back target always
  // overlaps the meeting's current slot — and that target is a specific computed
  // abut, not an offered alternative, so "don't offer the original back" must
  // not reject it. Omit (default false) for user-facing move discovery.
  allowMovingEventOverlap?: boolean;
  // v2.6 — category scheduling rules. When set, the slot loop applies the
  // category's rules (day_type, per_day, per_week limits) and filters out
  // slots that would violate them. When omitted, no category enforcement
  // (today's behavior). The arg is the category NAME (must match a
  // profile.categories[].name); resolution + rule lookup happens via
  // utils/categoryRules.ts.
  category?: string;
  // v2.6.1 — optional diagnostics output. When passed, the function
  // populates this object by reference with the same per-rule rejection
  // counts + examples it logs at the end of the search. Lets a CALLER
  // (notably the colleague-path Guard B narrow check) read WHY a specific
  // slot was rejected without parsing log lines. Owner direction:
  // findAvailableSlots stays the single source of truth for rule logic;
  // diagnostics ride on the same call. No return-shape change so existing
  // callers are unaffected.
  diagnosticsOut?: {
    rejectedCounts?: Record<string, number>;
    rejectedExamples?: Record<string, string[]>;
    /**
     * Per-day summary across the search window. One entry per workday touched
     * by the slot walker (off-workweek days like Friday/Saturday are omitted).
     * `accepted` is the count of slots that survived all rules for that day;
     * `top_reasons` is the top 2 distinct rejection reasons ordered by count,
     * empty when the day accepted ≥1 slot. Used by Sonnet to narrate honestly
     * when the user asks "why no Monday?" — instead of fabricating.
     */
    daySummary?: Array<{
      date: string;
      accepted: number;
      top_reasons: string[];
      /**
       * Per-attendee blame for this day. Populated when one or more attendees'
       * busy time blocked slots. Empty when the blockers were all owner-side
       * (owner_busy / focus_time / etc). Lets Sonnet narrate "Isaac blocked
       * 8 slots on Monday, that's where it dies" instead of "fully booked."
       */
      blocked_by?: Array<{ email: string; slots_blocked: number }>;
    }>;
    // v3.3.7 (#124h) — attendee addresses Graph could not resolve to a mailbox
    // (their "busy" was empty by nonexistence, not by freedom). Owner email
    // excluded. Caller decides how to warn (ops.ts flags owner-domain ones).
    unresolvedAttendees?: string[];
    // P15 (v4.2.x) — attendees whose free/busy was never READ for this window:
    // the request was malformed or Graph rejected it, so their "busy" was empty
    // because nobody asked. Owner email excluded. Same "don't call them free"
    // consequence as `unresolvedAttendees`, opposite cause — a bad address is the
    // model's to correct, a bad window is not.
    attendeesNotChecked?: string[];
    // #165b — the actual event behind the FIRST `owner_busy_collision` this
    // search hits, straight from checkSlot's own occupancy scan (viewer-scoped
    // subject already applied). Lets a single-candidate caller (the colleague-
    // path narrow check) name the real conflicting meeting without a second,
    // differently-matched lookup that can point at the wrong event.
    // gh#165-d — carried structurally off verdict.overCommitment (never
    // string-matched from `window`), so a caller can tell "the whole day is
    // gone" from "this hour clashes" without re-deriving the fact.
    conflictingEvent?: { id: string; subject: string; allDayOutOfOffice?: true; isAllDay?: true };
  };
}): Promise<SlotCandidate[]> {
  const meetingMode: MeetingMode = params.meetingMode ?? 'either';
  const autoExpand = params.autoExpand !== false;
  const maxSearchDays = params.maxSearchDays ?? 21;
  // v2.5.4 — category-driven travel buffer: the buffer FACT belongs to the
  // category ("if it's Outside, we need buffer"), the LENGTH is config.
  // v4.1.x (M2) — resolved by travelBufferMinutesFor, the SAME helper checkSlot
  // uses, so search and book can never pad by different amounts (pre-fix the
  // walker honored any caller value while checkSlot hardcoded 30).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { travelBufferMinutesFor, offeredSlotCount: offeredCountFor, isWithinBookingLeadTime } =
    require('../../utils/scheduleRules') as typeof import('../../utils/scheduleRules');
  const effectiveTravelBufferMinutes = params.profile
    ? travelBufferMinutesFor(params.profile, params.category ?? null, params.travelBufferMinutes)
    : (params.travelBufferMinutes ?? 0);
  const travelBufferMs = effectiveTravelBufferMinutes * 60 * 1000;
  // v2.2.3 (#43) — owner-only by default for the busy filter. Don't assume
  // we can / should move attendee meetings. Their work-window clips below.
  // Opt-in deeper search: caller passes attendeeBusyEmails after recipient
  // says "yes look at my calendar."
  const busyFilterEmails = [params.userEmail, ...(params.attendeeBusyEmails ?? [])];

  // v1.6.4 — auto-expand loop. Start with the caller's window; if we find
  // fewer than 3 candidates (empirically the point at which pickSpreadSlots
  // can't produce a useful spread), extend searchTo by +7 days and try
  // again, up to maxSearchDays total. Stops early once we have ≥3.
  const initialFrom = DateTime.fromISO(params.searchFrom, { zone: params.timezone });
  const initialTo = DateTime.fromISO(params.searchTo, { zone: params.timezone });
  const absoluteCap = initialFrom.plus({ days: maxSearchDays });
  let currentTo = initialTo;

  let candidates: SlotCandidate[] = [];

  while (true) {
    candidates = [];
    const windowFrom = params.searchFrom;
    const windowTo = currentTo.toISO()!;

    const fbDiag: { unresolved?: string[]; notChecked?: string[] } = {};
    // D4 — this call always carries the OWNER's own row (busyFilterEmails is
    // [owner, ...attendees]) and getSchedule is one POST for all of them: a
    // per-person failure comes back as a per-schedule `error` entry, so a THROW
    // here means the whole read died, the owner's busy time with it. It already
    // failed closed — it just failed closed as a raw error string with a Graph
    // code in it, which the model then had to improvise around. Same blind spot,
    // same typed refusal as the events read, so the two halves of "I can't see
    // his calendar" can't produce two different answers.
    //
    // Only an OUTAGE-SHAPED fault (5xx / 429 / 408 / a transport errno) is that
    // blind spot — `isOutageShaped` is the ONE taxonomy, shared with the events
    // read, so the two halves of "I can't see his calendar" can't disagree about
    // what counts. Everything deterministic keeps its own honest failure and
    // travels up unchanged: GraphPermissionError (his calendar reads fine, only
    // OTHER people's are denied), a 403 on his own, and — the case that made this
    // a bug — a 400 on a MALFORMED WINDOW. A model-supplied candidate window
    // narrower than the availabilityViewInterval 400s deterministically
    // (`ErrorInvalidMergedFreeBusyInterval`, see getFreeBusy's #137 note); wrapping
    // that as an outage told a colleague the whole calendar was unreachable
    // because one candidate slot was 3 minutes wide. Malformed input is never
    // infrastructure.
    let busyMap: Record<string, import('./calendarTypes').FreeBusySlot[]>;
    try {
      busyMap = await getFreeBusyForDecision(params.userEmail, busyFilterEmails, windowFrom, windowTo, params.timezone, fbDiag);
    } catch (err) {
      if (!isOutageShaped(err)) throw err;
      logger.error('findAvailableSlots — owner free/busy read failed; treating the calendar as OFFLINE', {
        userEmail: params.userEmail, windowFrom, windowTo, err: String(err).slice(0, 300),
      });
      throw new CalendarOfflineError(String(err).slice(0, 300));
    }
    if (params.diagnosticsOut) {
      const ownerLower = params.userEmail.toLowerCase();
      params.diagnosticsOut.unresolvedAttendees = (fbDiag.unresolved ?? []).filter(e => e !== ownerLower);
      // P15 — a read that never happened, kept SEPARATE from "Graph says this
      // mailbox doesn't exist". Both mean "no data, don't call them free", but the
      // handler states the reason out loud, and telling the owner an address is a
      // typo when the window was malformed is the M11 failure in a smaller font.
      params.diagnosticsOut.attendeesNotChecked = (fbDiag.notChecked ?? []).filter(e => e !== ownerLower);
    }

    // FreeBusySlot.start/end now carry an explicit IANA offset (set by
    // parseGraphFreeBusySlot inside getFreeBusy). Luxon honors that offset
    // when parsing, so .toJSDate() yields the correct absolute moment
    // regardless of the second-arg zone hint. Historical context: Graph's
    // getSchedule returns wall-clock-as-UTC without any offset; we used to
    // parse with { zone: 'utc' } to compensate, which broke the moment
    // anyone changed the call site without knowing the convention. The
    // chokepoint helper makes the convention live in the data, not the
    // reader.
    // Tag each busy interval with the email it came from so rule-8 rejections
    // can distinguish owner-vs-attendee blame. Owner direction (2026-05-15):
    // "did Maelle go only for me, or the other?" — pre-fix every busy hit was
    // labeled owner_busy_collision even when an attendee's calendar was the
    // real blocker. Now attendee blocks get `attendee_busy_collision:<email>`
    // and surface per-attendee in day_summary.blocked_by.
    const ownerEmailLower = params.userEmail.toLowerCase();
    const allBusy: Array<{ start: Date; end: Date; email: string }> = [];
    for (const [emailKey, slots] of Object.entries(busyMap)) {
      const email = emailKey.toLowerCase();
      for (const slot of slots) {
        // 'workingElsewhere' is NOT a hard block. A timed WE event is a
        // soft/optional-join event (v3.6.4) — tiered by checkSlot as level
        // 'optional' (subject on `overOptional`) and avoided-if-possible, never
        // hard-blocked. An all-day WE status simply isn't busy; away days now
        // come from the per-date schedule override (#143) and are walked
        // normally with that day's effective windows + tz.
        if (slot.status !== 'free' && slot.status !== 'workingElsewhere') {
          allBusy.push({
            start: DateTime.fromISO(slot.start).toJSDate(),
            end:   DateTime.fromISO(slot.end).toJSDate(),
            email,
          });
        }
      }
    }

    const searchEnd = DateTime.fromISO(windowTo, { zone: params.timezone }).toJSDate();
    const durationMs = params.durationMinutes * 60 * 1000;
    const step = 15 * 60 * 1000;

    // v1.6.4 — meetingMode steers which work days are valid.
    //   in_person → office_days only
    //   online    → office_days + home_days (all work days)
    //   either    → office_days + home_days, tagged so caller can narrate
    //   custom    → office_days + home_days + travel buffer padded
    const profile = params.profile;
    const officeDayNames = profile ? (profile.schedule.office_days.days as string[]) : [];
    const homeDayNames = profile ? (profile.schedule.home_days.days as string[]) : [];
    const defaultWorkDays: string[] =
      params.workDays ?? (profile
        ? (meetingMode === 'in_person' ? officeDayNames : [...officeDayNames, ...homeDayNames])
        : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
    const workDays = meetingMode === 'in_person' && profile
      ? officeDayNames                    // hard constraint: in-person = office only
      : defaultWorkDays;

    const [defaultStartHour, defaultStartMin] = (params.workHoursStart ?? '09:00').split(':').map(Number);
    const [defaultEndHour, defaultEndMin] = (params.workHoursEnd ?? '18:00').split(':').map(Number);

    // ── Profile-aware settings ────────────────────────────────────────────
    // v1.6.6 — no more "extra buffer around busy blocks" in the search.
    // The owner's allowed durations (10/25/40/55) already bake a 5-min
    // natural trailing buffer into every meeting Maelle books (e.g. a
    // 55-min meeting at 17:00 ends at 17:55, naturally leaving 5 min
    // before 18:00). Applying the profile buffer AGAIN in the isFree
    // check produced artefacts like "17:05" when the previous meeting
    // ended at 17:00 — wrong by design. Connected slots are fine.
    // The only additional padding we keep is travel buffer for custom mode
    // OR for categories with `requires_travel_buffer: true` (v2.5.4).
    const bufferMs = (meetingMode === 'custom' || effectiveTravelBufferMinutes > 0)
      ? travelBufferMs
      : 0;
    // Focus-time floor + per-day thinking-time threshold now live in checkSlot
    // (rule 9), evaluated per candidate via the single-validator call below.

    // v2.1 — floating-block feasibility. For every configured floating
    // block (lunch + any custom block, day-scoped via block.days), verify
    // that AFTER placing the proposed meeting here the block still has an
    // aligned, buffer-compliant slot somewhere in its window. Detected
    // calendar events that ARE a floating block are treated as elastic:
    // excluded from the busy-block pool for THAT block's feasibility
    // check (since Maelle can move them). The block-aware path replaces
    // the hardcoded lunch-only check below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fb = require('../../utils/floatingBlocks') as typeof import('../../utils/floatingBlocks');
    // v3.5 — ONE validator. The per-candidate owner-rule verdict comes from the
    // same checkSlot the booking path uses (fed the owner's CalendarEvents), so
    // search can never offer a slot the book path then refuses. Lazy-required to
    // match this file's idiom and sidestep the type-only cycle with scheduleRules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { checkSlot, isAllDayOutOfOffice } = require('../../utils/scheduleRules') as typeof import('../../utils/scheduleRules');
    // v3.7.x (#143) — the per-date effective work context, so the walker gates +
    // hours + tz come from the SAME accessor checkSlot validates against.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getEffectiveWorkDayForInstant: getEffectiveWorkDayForInstantCal } = require('../../utils/workHours') as typeof import('../../utils/workHours');
    const floatingBlocks = profile ? fb.getFloatingBlocks(profile) : [];
    // v3.0.2 — floating-block math is buffer-free; meeting durations carry the spacing.

    // v2.1 — fetch owner's own events for the search range so we can tell
    // WHICH busy slots are floating-block events (lunch, coffee break, etc).
    // getFreeBusy gives status-only, no subjects; to detect a block we need
    // subject/category. One fetch, cached for the whole slot walk.
    // v2.2.3 (scenario 9 row 7) — also used for the all-day-busy block
    // injection below, so fetch whenever a profile is available, not only
    // when floating blocks are configured.
    //
    // D4 — this read is NOT non-fatal, and used to be. It feeds checkSlot (the
    // ONE validator) on every candidate, so an empty list on failure meant every
    // slot was validated against an EMPTY CALENDAR and came back free — a Graph
    // fault rendered as a wide-open day. The `getFreeBusy` call at the top of
    // this same loop has always thrown on a real fault; this one swallowing was
    // the odd read out. Both now fail closed, one posture for the walker, and
    // `getOwnerEventsForDecision` owns the single retry.
    let ownerEventsForFb: CalendarEvent[] = [];
    if (profile) {
      // v2.6 — when a category is set, the rule-check needs to count
      // category occurrences across the FULL day (per_day) and FULL week
      // (per_week) containing each candidate slot. Narrow ±1min checks
      // (create_meeting / move_meeting rule-compliance) would otherwise
      // see 0 events and pass through any limit. Widen the fetch range
      // to cover at least the ISO week containing searchFrom..searchTo.
      // No-op when category is unset — preserves the cheap narrow fetch.
      // v3.7.x — cover the CURRENT (possibly autoExpand-widened) window via
      // currentTo, NOT the original params.searchTo. Pre-fix, when autoExpand
      // widened the search to later days, checkSlot's owner-busy / focus-floor /
      // floating-block rules still validated those expanded-day slots against
      // owner events that only covered the ORIGINAL window — so an autoExpanded
      // search silently ACCEPTED owner-busy slots on the later days (the auto-move
      // "landed on an already-busy slot" bug). No expansion → currentTo ===
      // params.searchTo → byte-identical fetch.
      const effTo = currentTo.toISO()!;
      let fetchFrom = params.searchFrom;
      let fetchTo = effTo;
      if (params.category) {
        const sfDt = DateTime.fromISO(params.searchFrom, { zone: params.timezone });
        const stDt = DateTime.fromISO(effTo, { zone: params.timezone });
        if (sfDt.isValid && stDt.isValid) {
          fetchFrom = sfDt.startOf('week').toISO()!;
          fetchTo = stDt.endOf('week').toISO()!;
        }
      }
      ownerEventsForFb = await getOwnerEventsForDecision(
        params.userEmail,
        fetchFrom,
        fetchTo,
        params.timezone,
      );
    }

    // v2.2.3 (scenario 9 row 7) — all-day busy events should block their
    // entire day. Owner direction:
    //   isAllDay && showAs === 'free'  → ignore (free all-day isn't busy; it's
    //                                     already filtered out earlier in this pass)
    //   isAllDay && showAs !== 'free'  → block the entire day
    // Graph getFreeBusy SHOULD return all-day busy as full-day busy intervals,
    // but this is the belt-and-suspenders pass — explicit + deterministic.
    // Pushing duplicate ranges into allBusy is idempotent (slot walker just
    // checks for overlap).
    if (ownerEventsForFb.length > 0) {
      for (const evt of ownerEventsForFb) {
        if (!evt.isAllDay) continue;
        if (evt.isCancelled) continue;
        if (evt.showAs === 'free') continue;  // PTO marked free / WFH "available" / etc
        // an all-day Working Elsewhere marker is NOT a block. The owner is
        // working, just somewhere else — leaving it out of allBusy keeps the day
        // open so the walk offers that day's effective windows. The owner's own
        // away days now come from the per-date schedule override (#143); there
        // is no separate tentative-availability path.
        if (evt.showAs === 'workingElsewhere') continue;
        // All-day busy / oof / tentative → full-day block.
        // Graph all-day events span midnight-to-midnight in their declared zone;
        // parse and treat as the whole local day.
        const dayStart = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' })
          .setZone(params.timezone).startOf('day').toJSDate();
        const dayEnd = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' })
          .setZone(params.timezone).endOf('day').toJSDate();
        allBusy.push({ start: dayStart, end: dayEnd, email: ownerEmailLower });
      }
    }

    // D6 — the dates his own calendar marks as an all-day OUT OF OFFICE. Built
    // once here from the same owner events checkSlot validates against, through
    // the one shared predicate, so "is he out that day" has exactly one answer in
    // the subsystem. Span-aware (a multi-day vacation covers every day it spans).
    const oofDayKeys = new Set<string>();
    for (const evt of ownerEventsForFb) {
      if (!isAllDayOutOfOffice(evt)) continue;
      const from = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' })
        .setZone(params.timezone).startOf('day');
      // Graph all-day end is EXCLUSIVE (midnight after the last covered day).
      const toExclusive = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' })
        .setZone(params.timezone).startOf('day');
      if (!from.isValid || !toExclusive.isValid) continue;
      for (let d = from; d < toExclusive; d = d.plus({ days: 1 })) {
        oofDayKeys.add(d.toFormat('yyyy-MM-dd'));
      }
    }

    // v3.6.4 — SOFT / OPTIONAL tier. A TIMED workingElsewhere event (e.g. a
    // daily standup the owner joins only if free) is not a hard block: it's
    // avoided when clean slots exist, but bookable-over as a fallback, and it
    // stays visible.
    // v4.1.x (M2/M3) — this walker used to re-derive that tier from a private
    // `softOccupied` pass over the same events the validator reads, so the
    // OPTIONAL level existed in search and nowhere else. It now comes back on
    // the checkSlot verdict (`overOptional`, already privacy-masked for the
    // caller), which is also what the write path annotates from. One derivation,
    // two surfaces.

    // v3.7.x (#143) — no all-day WE detection in search. An away day is a
    // per-date override (explicit tz + stated hours) resolved per-day by
    // getEffectiveWorkDay in the walk below, so it is walked like any other day in
    // its own zone. No marker/record away-day set, no separate tentative path.

    // v2.1 — remove floating-block time ranges from the base busy pool.
    // Without this, the isFree collision check below would reject any
    // slot that overlaps where lunch currently sits — even though lunch
    // is elastic and Maelle is allowed to move it within its window.
    // Collect block-event ranges and subtract from allBusy (exact-match
    // drop; we don't split partials since floating blocks don't overlap
    // other events by construction).
    // v3.2.6 (RC1) — hoisted to function scope so the per-slot tagging below
    // can flag candidates that overlap a floating block's CURRENT placement
    // (i.e. would force it to shift). Consumers prefer non-disturbing slots.
    const blockRanges: Array<{ start: number; end: number }> = [];
    if (floatingBlocks.length > 0 && ownerEventsForFb.length > 0) {
      for (const evt of ownerEventsForFb) {
        if (evt.isCancelled || evt.isAllDay || evt.showAs === 'free') continue;
        for (const block of floatingBlocks) {
          if (fb.isFloatingBlockEvent(
            { subject: evt.subject, categories: evt.categories },
            block,
          )) {
            const eStart = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' })
              .setZone(params.timezone).toMillis();
            const eEnd = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' })
              .setZone(params.timezone).toMillis();
            blockRanges.push({ start: eStart, end: eEnd });
            break;  // one block-match is enough to exclude this event
          }
        }
      }
    }

    // v3.3.7 (#124) — shared busy-carve. ONE mechanism for both subtraction
    // sites (floating blocks + moving events). The previous exact-match
    // splice (±1min on interval bounds) silently failed whenever Graph's
    // MERGED free/busy fused the event with an adjacent meeting — on a
    // packed day the event's bounds never match the merged interval, so
    // lunch stopped being elastic and a moving meeting kept blocking the
    // very slot it was vacating ("Michal is still there").
    //
    // carveRangeFromBusy trims/splits every overlapping busy interval, then
    // re-adds the owner's OTHER events that overlap the carved range (from
    // readdPool) — so a real meeting fused into the same merged interval is
    // never falsely freed. Duplicate/overlapping re-adds are fine: the slot
    // walker only checks overlap (idempotent, see all-day note above).
    // Attendee busy (email !== owner) is carved only for moving events
    // (includeAttendees=true): the moving meeting sits in their calendar
    // too, but we can't see their events to re-add — an attendee
    // double-booked inside that exact window is the accepted edge.
    const excludeIdSet = new Set(params.excludeEventIds ?? []);
    const readdPool: Array<{ start: number; end: number }> = [];
    for (const evt of ownerEventsForFb) {
      if (evt.isCancelled || evt.showAs === 'free' || evt.showAs === 'workingElsewhere') continue;
      if (excludeIdSet.has(evt.id)) continue;
      const isBlock = floatingBlocks.some(block => fb.isFloatingBlockEvent(
        { subject: evt.subject, categories: evt.categories },
        block,
      ));
      if (isBlock) continue;  // blocks are elastic — never re-add one
      const s = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' }).setZone(params.timezone);
      const e = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' }).setZone(params.timezone);
      // All-day busy blocks its whole local day (mirrors the v2.2.3 push above).
      readdPool.push(evt.isAllDay
        ? { start: s.startOf('day').toMillis(), end: e.endOf('day').toMillis() }
        : { start: s.toMillis(), end: e.toMillis() });
    }
    const carveRangeFromBusy = (rangeStart: number, rangeEnd: number, includeAttendees: boolean): void => {
      if (rangeEnd <= rangeStart) return;
      for (let i = allBusy.length - 1; i >= 0; i--) {
        const b = allBusy[i];
        if (!includeAttendees && b.email !== ownerEmailLower) continue;
        const bs = b.start.getTime();
        const be = b.end.getTime();
        if (bs >= rangeEnd || be <= rangeStart) continue;  // no overlap
        allBusy.splice(i, 1);
        if (bs < rangeStart) allBusy.push({ start: b.start, end: new Date(rangeStart), email: b.email });
        if (be > rangeEnd) allBusy.push({ start: new Date(rangeEnd), end: b.end, email: b.email });
      }
      for (const r of readdPool) {
        if (r.start < rangeEnd && r.end > rangeStart) {
          allBusy.push({ start: new Date(r.start), end: new Date(r.end), email: ownerEmailLower });
        }
      }
    };
    for (const r of blockRanges) {
      carveRangeFromBusy(r.start, r.end, false);
    }

    // v2.4.1 — moving-event subtraction + forbidden-zone build. When the
    // caller passes excludeEventIds (the meeting(s) being moved), each one
    // is carved out of the busy pool (so candidate slots aren't blocked by a
    // meeting that's leaving its current time anyway) AND added to a
    // forbidden-zones list (so the slot walker won't offer the original time
    // as a "move target"). Closes the "move 11:00 to 10:30" / "options to
    // move 11:00" cases that pre-v2.4.1 either over-rejected (treated the
    // meeting as a hard conflict with itself) or would have offered 11:00
    // back as a valid alternative.
    const movingEventForbiddenZones: Array<{ start: number; end: number }> = [];
    if (params.excludeEventIds && params.excludeEventIds.length > 0 && ownerEventsForFb.length > 0) {
      for (const evt of ownerEventsForFb) {
        if (!excludeIdSet.has(evt.id)) continue;
        if (evt.isCancelled || evt.showAs === 'free') continue;
        const eStart = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' })
          .setZone(params.timezone).toMillis();
        const eEnd = DateTime.fromISO(evt.end.dateTime, { zone: evt.end.timeZone ?? 'utc' })
          .setZone(params.timezone).toMillis();
        // Behavior 2 (forbid the original slot as a target) — skipped for
        // defrag moves, which deliberately abut a neighbour a few minutes off
        // the current slot. Behavior 1 (the busy-carve below) always runs.
        if (!params.allowMovingEventOverlap) {
          movingEventForbiddenZones.push({ start: eStart, end: eEnd });
        }
        // Carve from busy — shared helper, attendee intervals included (the
        // moving meeting exists in their calendars too).
        carveRangeFromBusy(eStart, eEnd, true);
      }
    }

    // Per-day work hours + day-type classifier (office / home / other).
    const classifyDay = (dayName: string): 'office' | 'home' | 'other' => {
      if (officeDayNames.includes(dayName)) return 'office';
      if (homeDayNames.includes(dayName)) return 'home';
      return 'other';
    };
    // Union helper — merges overlapping/adjacent ranges so a relaxed
    // override that widens the default window doesn't double-count free
    // time when the widened window overlaps a native work_hours window.
    const mergeRanges = (
      ranges: Array<{ startMin: number; endMin: number }>,
    ): Array<{ startMin: number; endMin: number }> => {
      if (ranges.length === 0) return [];
      const sorted = [...ranges].sort((a, b) => a.startMin - b.startMin);
      const out: Array<{ startMin: number; endMin: number }> = [{ ...sorted[0] }];
      for (let i = 1; i < sorted.length; i++) {
        const last = out[out.length - 1];
        const curr = sorted[i];
        if (curr.startMin <= last.endMin) {
          last.endMin = Math.max(last.endMin, curr.endMin);
        } else {
          out.push({ ...curr });
        }
      }
      return out;
    };

    // v2.8.1 — multi-window per-day work hours. Returns an ARRAY of ranges;
    // a slot is valid if it falls within any one of them. Splits on the
    // yaml `schedule.work_hours[dayName]` if defined; otherwise falls back
    // to legacy office_days/home_days hours.
    const getWorkHoursForDay = (eff: import('../../utils/workHours').EffectiveWorkDay | null): Array<{ startMin: number; endMin: number }> => {
      const widened = {
        startMin: defaultStartHour * 60 + defaultStartMin,
        endMin: defaultEndHour * 60 + defaultEndMin,
      };
      if (!profile || !eff) return [widened];
      // v3.7.x (#143) — native windows come from the effective day (yaml base +
      // per-date override), so the walker sees a per-date hours/away override
      // exactly as checkSlot validates it. `relaxed` / `extendedHours` still
      // UNION the widened default window with the day's native work_hours instead
      // of collapsing to the single widened window (owner "show me everything"),
      // preserving split-shift windows + adding widened coverage outside them.
      const native = eff.windows;
      if (params.extendedHours || params.relaxed) {
        return mergeRanges([widened, ...native]);
      }
      return native;
    };

    // v2.0.9 — walker collects ALL valid 15-min-stepped candidates per day
    // into dayBuckets. After the walker, per-day post-processing picks up to
    // MAX_PER_DAY with 30-min preferred spacing and 15-min fallback. Prior
    // chronological-slice(10) truncated the rest of the week whenever Sunday
    // had 10+ hits; hard-capping the walker at 4/day would also over-cluster
    // in 15-min increments. Two-stage approach gives both day-diversity AND
    // nice intra-day spacing ("10, 10:30, 11:30, 14:00" not "10, 10:15,
    // 10:30, 10:45").
    // v4.1.x (M6) — the cap was a literal 4, applied BEFORE pickSpreadSlots
    // ever saw the day, so a single wide window (a cross-TZ overlap band, or
    // "anytime Tuesday") could only ever yield 4 candidates from that day —
    // fewer than the 5 we then tried to offer, and a 5th viable slot was culled
    // pre-spread (the Ayala case). It is now the offered-slot count itself: the
    // most one day could ever legitimately contribute, so one viable day can
    // fill the whole offer and nothing viable is discarded before the spreader.
    // Keeping a cap (rather than dropping it) preserves the dense-packing
    // branch below, where WHICH slots survive expresses the density ranking.
    const MAX_PER_DAY = offeredCountFor(profile ?? undefined);
    const PREFERRED_GAP_MS = 30 * 60 * 1000;
    // #133 — efficient-calendar ranking. When the owner prefers dense packing,
    // each candidate is scored by how it sits among the owner's EXISTING
    // commitments (back-to-back / real break = good; a 6–29 min dead gap = bad).
    // The per-day pick below then keeps the most efficient slots (earliest-first
    // tiebreak), so pickSpreadSlots offers efficient options first. ownerBusyMs =
    // the owner's fixed commitments (floating blocks are already elastic-
    // subtracted from allBusy above, so we never pack against a lunch that slides).
    const packingDense = profile ? prefersDensePacking(profile.meetings) : false;
    const densityCfg = profile
      ? densityConfigFromProfile(profile.meetings)
      : { bufferMinutes: 5, minBreakMinutes: 30 };
    const ownerBusyMs: Array<{ start: number; end: number }> = packingDense
      ? allBusy
          .filter(b => b.email === ownerEmailLower)
          .map(b => ({ start: b.start.getTime(), end: b.end.getTime() }))
      : [];
    const dayBuckets: Map<string, Array<SlotCandidate & { density?: number }>> = new Map();

    // v2.3.6 (#71a) — diagnostic rejection counters. Helps debug "why was 17:45
    // rejected?" by showing the per-rule breakdown at the end of the search.
    // Each rejection point increments its bucket; we also track up to 5 example
    // rejected slots per reason for grepping in logs.
    const rejectedCounts: Record<string, number> = {};
    const rejectedExamples: Record<string, string[]> = {};
    // Per-day reason aggregation. Same trackReject feeds both global counts
    // and per-day. The per-day map drives the daySummary that's surfaced to
    // Sonnet via diagnosticsOut so she can narrate "Monday was fully booked"
    // instead of fabricating "Monday is a day off."
    const dayReasons = new Map<string, Map<string, number>>();
    // Map a checkSlot verdict to the search-path reject label so day_summary
    // narration is unchanged after the validator unification.
    const mapVerdictToRejectLabel = (kind: string | undefined, dayType: 'office' | 'home' | 'other'): string => {
      switch (kind) {
        // P13 (v4.2.x) — NOT folded into `within_lead_time` any more. They are not
        // the same fact: "too soon" is one of the owner's rules and he can waive
        // it, "already happened" is not and nobody can. Folding them put elapsed
        // times inside SOFT_REJECT_PREFIXES, and the colleague hint downstream
        // then described a time that had simply passed as held by "day-load
        // protections" and invited a policy_exception over it. The walker's own
        // past-floor above means checkSlot should never reach here with this
        // verdict (same predicate, same instant, one iteration earlier); the case
        // stays so that if it ever does, the reason handed onward is the true one.
        case 'in_the_past': return 'in_the_past';
        case 'within_lead_time': return 'within_lead_time';
        case 'outside_working_hours': return 'outside_owner_work_hours';
        case 'floating_block_overlap': return 'floating_block_no_room';
        case 'focus_time_floor': return dayType === 'home' ? 'focus_time_home' : 'focus_time_office';
        case 'travel_buffer_collision': return 'travel_buffer_collision';
        case 'category_day_type': return 'category_day_type';
        case 'category_per_day': return 'category_per_day';
        case 'category_per_week': return 'category_per_week';
        case 'vacation_or_off_day': return 'wrong_day_type';
        case 'owner_busy_collision':
        default: return 'owner_busy_collision';
      }
    };
    // gh#165-d — the ONE writer for diagnosticsOut.conflictingEvent, called from
    // both the STRICT-reject branch and the relaxed-pass branch below so a
    // caller's single-slot check gets the fact regardless of which one fired
    // (first hit wins; a spread search never reads this field). Carries the
    // structural all-day facts straight off verdict.overCommitment — never a
    // second, string-matched re-derivation.
    const stampConflictingEvent = (oc: NonNullable<RuleCheckResult['overCommitment']>) => {
      if (!params.diagnosticsOut || params.diagnosticsOut.conflictingEvent) return;
      params.diagnosticsOut.conflictingEvent = {
        id: oc.id,
        subject: oc.subject,
        ...(oc.allDayOutOfOffice ? { allDayOutOfOffice: true as const } : {}),
        ...(oc.isAllDay ? { isAllDay: true as const } : {}),
      };
    };
    // P25 — `outOfWorkHours` is the VALIDATOR's own fact about this slot
    // (`checkSlot(...).outsideWorkHours`), not a re-derivation out here. The global
    // `rejectedCounts` / `rejectedExamples` keep the true per-slot reason — the
    // single-window validation callers read `Object.keys(rejectedCounts)[0]` for
    // the reason they hand back, and that must stay the specific truth about the
    // one time asked about. Only the PER-DAY map files the rejection under the
    // noise label, because that map answers "why did this DAY yield nothing", and
    // an hour outside his working day was never a candidate to begin with. Before,
    // out-of-hours-ness was inferred from the label; the day a hard collision
    // started outranking rule 5, out-of-hours slots stopped being noise and a
    // 20:30 dinner became the reported reason a day was blocked.
    const trackReject = (reason: string, slotIso: string, outOfWorkHours = false) => {
      rejectedCounts[reason] = (rejectedCounts[reason] ?? 0) + 1;
      if (!rejectedExamples[reason]) rejectedExamples[reason] = [];
      if (rejectedExamples[reason].length < 5) rejectedExamples[reason].push(slotIso);
      const day = slotIso.slice(0, 10);  // yyyy-MM-dd prefix of ISO
      const dayReason = outOfWorkHours ? 'outside_owner_work_hours' : reason;
      let dayMap = dayReasons.get(day);
      if (!dayMap) { dayMap = new Map(); dayReasons.set(day, dayMap); }
      dayMap.set(dayReason, (dayMap.get(dayReason) ?? 0) + 1);
    };

    // All workweek days regardless of meetingMode filter — used to detect
    // when a workday was excluded specifically because of the requested mode
    // (e.g. Monday is a home day; meetingMode='in_person' excludes it). We
    // surface this as `wrong_day_type` in daySummary so Sonnet can narrate
    // "Monday is a home day, in-person needs an office day" instead of
    // fabricating "Monday is a day off."
    const allWorkweekDays: string[] = profile
      ? [...officeDayNames, ...homeDayNames]
      : workDays;

    // Per-day requested-time clamp (organizer / no-attendee case). The walker
    // honors search_from's time only as the cursor START — so a multi-day
    // "16:00-19:00" search returned LATER days at their morning. When NO
    // attendee is driving the work-hours clip (e.g. an organizer collecting
    // options with the requester dropped — the Yael case), the requested time
    // window is the only signal, so clamp EVERY day to its time-of-day band.
    // SKIPPED when attendees are present: their own work-hours already clip,
    // and a loose search-time band would over-constrain them (Alex's slots come
    // from his ET hours, not the literal Israel search times — clamping would
    // wrongly drop them). Full-day / inverted bands are no-ops.
    let bandFromMin = -1;
    let bandToMin = -1;
    let bandWraps = false;
    {
      const hasAttendeeClip = !!(params.attendeeAvailability && params.attendeeAvailability.length > 0);
      if (!hasAttendeeClip) {
        const bf = DateTime.fromISO(params.searchFrom, { zone: params.timezone });
        const bt = DateTime.fromISO(params.searchTo, { zone: params.timezone });
        if (bf.isValid && bt.isValid) {
          const fm = bf.hour * 60 + bf.minute;
          const tm = bt.hour * 60 + bt.minute;
          // #C (2026-07-23) — a real sub-day band, INCLUDING one that wraps past
          // midnight (e.g. 16:00→01:00, the endpoint-shift a foreign search-window
          // TZ produces). Before, `tm > fm` dropped the wrapping case → the per-day
          // clamp silently disabled → interior days re-offered owner-hours. Now keep
          // it and flag the wrap; the check honors [fm,24h)∪[0,tm]. Skip only a
          // genuine full-day band (00:00..~23:59).
          if (fm !== tm && !(fm === 0 && tm >= 23 * 60 + 59)) {
            bandFromMin = fm;
            bandToMin = tm;
            bandWraps = tm < fm;
          }
        }
      }
    }

    // v3.7.x (#133) — OPT-IN grid-align of the walk's FIRST cursor. When
    // gridAlignStart is set (the defrag), an OFF-GRID searchFrom (its back-to-back
    // keptEnd, e.g. 13:40 — a normal off-grid meeting END, since durations bake a
    // 5-min trailing buffer) is ceiled to the next quarter (13:45…) so candidates
    // are aligned, never 13:40. Default OFF because the same walker VALIDATES exact
    // single-slot windows (Guard B / candidate_slots / counter-accept), where
    // ceiling a narrow off-grid window past searchEnd returned 0 → false
    // "unavailable" / false escalation. Off = cursor starts EXACTLY at searchFrom
    // (aligned callers unaffected; validators test the exact start).
    let cursorDt0 = DateTime.fromISO(params.searchFrom, { zone: params.timezone });
    if (params.gridAlignStart) {
      const flooredQuarter = cursorDt0.startOf('hour').plus({ minutes: Math.floor(cursorDt0.minute / 15) * 15 });
      cursorDt0 = flooredQuarter < cursorDt0 ? flooredQuarter.plus({ minutes: 15 }) : flooredQuarter;
    }
    let cursor = cursorDt0.toJSDate();
    while (cursor.getTime() + durationMs <= searchEnd.getTime()) {
      const cursorDt = DateTime.fromJSDate(cursor).setZone(params.timezone);
      const dayName = cursorDt.toFormat('EEEE');
      const dayKey = cursorDt.toFormat('yyyy-MM-dd');
      // v3.7.x (#143) — the day's effective work context (yaml + per-date override).
      const effectiveDay = profile ? getEffectiveWorkDayForInstantCal(cursorDt.toISO()!, profile) : null;
      // Day type from the effective location (an override can flip office↔home or
      // mark an away day), else the yaml classifier for the no-profile path.
      const dayType: 'office' | 'home' | 'other' = effectiveDay
        ? (effectiveDay.location === 'office' ? 'office' : effectiveDay.location === 'home' ? 'home' : 'other')
        : classifyDay(dayName);

      // Workday gate. effectiveDay folds in per-date off/on overrides (profile
      // path); no-profile falls back to the yaml/meetingMode day-name set. No
      // override → byte-identical to the old name gate.
      const dayIsWorkday = effectiveDay ? effectiveDay.isWorkday : workDays.includes(dayName);
      if (!dayIsWorkday) {
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      // D6 (owner 2026-07-26: "my calendar really block OOO for that entire day,
      // it should be blocked anyway") — an all-day out-of-office on HIS OWN
      // calendar takes the day out, straight off the calendar, with no per-date
      // schedule override needed.
      //
      // This is a REASON fix, not a bookability one: `occupancyRoleOf` already
      // calls an all-day OOF a commitment, so checkSlot rejected every slot on
      // this day anyway. But it rejected them one at a time as
      // `owner_busy_collision`, so day_summary reported an OOO Thursday exactly
      // like a Thursday packed with meetings — Maelle told people he was "fully
      // booked" while he was on vacation, and a colleague could reasonably ask her
      // to try the following hour. Same verdict, true reason, and it AGREES with
      // checkSlot rather than competing with it: both refuse, and the one
      // predicate (`isAllDayOutOfOffice`) decides what counts as out. Placed above
      // the meeting-mode gate because "he's away" outranks "wrong kind of day".
      if (oofDayKeys.has(dayKey)) {
        trackReject('owner_out_of_office', cursorDt.toISO()!);
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      // meetingMode: in-person requires an office-type day; a home / away day in
      // in_person mode is a wrong-day-type exclusion (narrated in day_summary).
      if (effectiveDay && meetingMode === 'in_person' && dayType !== 'office') {
        if (allWorkweekDays.includes(dayName) && !dayReasons.has(dayKey)) {
          dayReasons.set(dayKey, new Map([['wrong_day_type', 1]]));
        }
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      const dayHours = getWorkHoursForDay(effectiveDay);
      const slotEnd = new Date(cursor.getTime() + durationMs);
      const cursorLocal = cursorDt;
      const slotEndLocal = DateTime.fromJSDate(slotEnd).setZone(params.timezone);
      const slotTotalMin = cursorDt.hour * 60 + cursorDt.minute;
      const slotEndMin = slotTotalMin + params.durationMinutes;

      // ── Search-only filters (not part of the owner-rule verdict) ──
      // Per-day requested-time clamp (organizer / no-attendee case) — honors the
      // requested window on EVERY day, not just the cursor's first.
      if (bandFromMin >= 0) {
        // #C — non-wrap: the slot must sit fully inside [from,to]. Wrap (from>to,
        // crosses midnight): in-band if it's in the evening part (start ≥ from) OR
        // the early-morning part (end ≤ to).
        const outOfBand = bandWraps
          ? (slotTotalMin < bandFromMin && slotEndMin > bandToMin)
          : (slotTotalMin < bandFromMin || slotEndMin > bandToMin);
        if (outOfBand) {
          trackReject('outside_requested_window', cursorDt.toISO()!);
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
      }
      // ── (a) THE PAST — a universal floor on the OFFER, not a rule ──────────
      // P13 (v4.2.x) — this floor used to apply only when `relaxed`; every other
      // search let past slots fall through to checkSlot, whose rule 0 returns
      // `in_the_past`, which `mapVerdictToRejectLabel` collapsed into
      // `within_lead_time`. `within_lead_time` is a SOFT_REJECT_PREFIX, so the
      // colleague hint (ops/handlers/findAvailableSlots) told a requester that
      // those times "were excluded by <owner>'s day-load protections rather than
      // by a real meeting" and invited him to raise a policy_exception over them.
      // The times in question had simply already happened. A search with
      // `search_from` at midnight on the current day (which is what a bare date
      // arg produces — logs/maelle-2026-07-20.log, `within_lead_time: 65` with
      // examples at 00:00/00:15/00:30/00:45/01:00 on a search run at 12:11) put
      // the whole elapsed morning into that claim. Nobody can override yesterday,
      // so offering the override is a false statement about the owner's rules AND
      // a wasted approval round-trip.
      //
      // Now: one floor, every caller, above every other reason — a time that has
      // gone is not an option to choose from, whatever else is true about it. It
      // sits here rather than as a `search_from` clamp so the skipped slots are
      // still COUNTED and labelled truthfully: a fully-elapsed window would
      // otherwise produce zero rejections, and the single-window validation
      // callers read `Object.keys(rejectedCounts)[0]` for their reason — an empty
      // map humanizes to 'unknown', the mechanical non-answer M11 forbids.
      // `in_the_past` is not a soft prefix and already humanizes to "that time has
      // already passed" (ops/violationLabels).
      if (cursor.getTime() < Date.now()) {
        trackReject('in_the_past', cursorDt.toISO()!);
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      // ── (b) NO PROFILE — the lead-time floor with nowhere else to live ─────
      // #128 / D5 (owner 2026-07-26: "we need to have priority of reasons") — for
      // every real caller the booking lead time is checkSlot rule 0b, decided
      // THERE, inside the validator's own ladder, where a real commitment (rule 8)
      // outranks it. It used to run out here ahead of checkSlot, deliberately —
      // "so the rejection is blamed on 'too soon'" — and that is what broke: a
      // same-day afternoon that was ALSO booked solid came back labelled
      // `within_lead_time` and got the same "merely protective" claim. Round 1
      // fixed the ranking inside checkSlot; a second, independent ranking out here
      // just re-opened it. One ladder now. The degenerate no-UserProfile caller
      // never reaches checkSlot at all, so its floor stays here.
      //
      // Side effect, checked and accepted: a same-day slot where an ATTENDEE is
      // also busy reports the attendee instead of "too soon", because the walker's
      // attendee pass still sits above checkSlot. Both are true and neither is in
      // SOFT_REJECT_PREFIXES, so neither can produce the "merely protective"
      // claim. The attendee pass was NOT hoisted below checkSlot with the lead
      // time: day_summary's per-attendee `blocked_by` attribution ("Isaac blocked
      // 8 slots on Monday") is built from those labels, and owner rules shadowing
      // them would silently empty it.
      if (!profile && isWithinBookingLeadTime(cursor.getTime(), params.minBufferHours)) {
        trackReject('within_lead_time', cursorDt.toISO()!);
        cursor = new Date(cursor.getTime() + step);
        continue;
      }
      // v2.4.1 — slots overlapping the meeting being moved are forbidden as move
      // targets (don't offer 11:00 back when moving the 11:00 meeting).
      if (movingEventForbiddenZones.length > 0) {
        const overlapsMovingEvent = movingEventForbiddenZones.some(zone =>
          cursor.getTime() < zone.end && slotEnd.getTime() > zone.start
        );
        if (overlapsMovingEvent) {
          trackReject('overlaps_meeting_being_moved', cursorDt.toISO()!);
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
      }

      // ── Attendee-side checks are HELPERS, not blockers (rule 6). Default:
      // REJECT conflicted slots so the owner is offered clean options. When the
      // caller opts into keeping them (`relaxed` = total owner override, rule 11;
      // or `tagAttendeeConflicts` = owner rules stay strict, attendee busy is a
      // helper only): KEEP the slot but TAG who's busy / off-hours so the owner
      // is TOLD (rule 7) — never silently dropped. The OWNER's busy is owned by
      // checkSlot below, off his CalendarEvents. ──
      const keepAttendeeConflicts = params.relaxed || params.tagAttendeeConflicts;
      const attendeeConflicts: Array<{ email: string; reason: 'busy' | 'off_hours' }> = [];
      {
        // v2.7.6 — attendee busy (free/busy pool), attributed by email.
        // v3.7.x (1.1/1.2) — TAG mode records EVERY conflicting attendee, not just
        // the first. `allBusy.find` stopped at one hit, so a second blocked
        // attendee on the same slot (e.g. an OOO teammate behind someone else's
        // meeting) went untagged → the owner-backstop narrated them "free" (the
        // Dan-OOO-shows-free bug) and a masked attendee flipped free↔blocked
        // between searches (the Lori/Monday contradiction). DROP mode still stops
        // at the first — one reason is enough to reject the slot.
        if (keepAttendeeConflicts) {
          const seenBusy = new Set<string>();
          for (const busy of allBusy) {
            if (busy.email === ownerEmailLower || seenBusy.has(busy.email)) continue;
            if (cursor.getTime() < busy.end.getTime() && slotEnd.getTime() > busy.start.getTime()) {
              seenBusy.add(busy.email);
              attendeeConflicts.push({ email: busy.email, reason: 'busy' });
            }
          }
        } else {
          const overlapsAttendee = allBusy.find(busy =>
            busy.email !== ownerEmailLower &&
            cursor.getTime() < busy.end.getTime() &&
            slotEnd.getTime() > busy.start.getTime()
          );
          if (overlapsAttendee) {
            trackReject(`attendee_busy_collision:${overlapsAttendee.email}`, cursorDt.toISO()!);
            cursor = new Date(cursor.getTime() + step);
            continue;
          }
        }
        // Travel buffer, ATTENDEE side only. v4.1.x (M2) — the OWNER side of
        // this padding is checkSlot rule 7 (fed the same effective minutes
        // below), so it is no longer applied twice with two different lengths.
        // What remains here is the half checkSlot cannot see: an ATTENDEE's
        // busy block too close to the slot. Same canonical label so day_summary
        // narration is unchanged.
        if (!params.relaxed) {
          const withinBuffer = bufferMs > 0 && allBusy.find(busy =>
            busy.email !== ownerEmailLower &&
            cursor.getTime() < busy.end.getTime() + bufferMs &&
            slotEnd.getTime() > busy.start.getTime() - bufferMs
          );
          if (withinBuffer) {
            trackReject('travel_buffer_collision', cursorDt.toISO()!);
            cursor = new Date(cursor.getTime() + step);
            continue;
          }
        }
        // #43 / #124 / Daniel — per-attendee work-window clip, own TZ with
        // per-day travel-window resolution.
        if (params.attendeeAvailability && params.attendeeAvailability.length > 0) {
          const candidateDayIso = cursorDt.toFormat('yyyy-MM-dd');
          const attendeeOutsideHours = (att: NonNullable<typeof params.attendeeAvailability>[number]): boolean => {
            try {
              const tw = att.travelWindow;
              const effTz = (tw && candidateDayIso >= tw.from && candidateDayIso <= tw.until)
                ? tw.timezone
                : (att.homeTimezone ?? att.timezone);
              const attStart = DateTime.fromJSDate(cursor).setZone(effTz);
              const attEnd = DateTime.fromJSDate(slotEnd).setZone(effTz);
              if (!attStart.isValid || !attEnd.isValid) return false;
              const attDay = attStart.toFormat('EEEE') as 'Sunday'|'Monday'|'Tuesday'|'Wednesday'|'Thursday'|'Friday'|'Saturday';
              if (!att.workdays.includes(attDay)) return true;
              const [shH, shM] = att.hoursStart.split(':').map(Number);
              const [ehH, ehM] = att.hoursEnd.split(':').map(Number);
              // start + duration — a slot crossing the attendee's midnight must
              // not wrap and look in-hours (same bug as owner-side checkSlot).
              const { startMin, endMin } = slotDayMinutes(attStart, attEnd);
              const winStart = shH * 60 + shM;
              const winEnd = ehH * 60 + ehM;
              return startMin < winStart || endMin > winEnd;
            } catch {
              return false;
            }
          };
          // v3.7.x (1.1/1.2) — TAG mode collects ALL off-hours attendees so a
          // second one isn't masked by the first; DROP mode stops at the first.
          if (keepAttendeeConflicts) {
            for (const att of params.attendeeAvailability) {
              if (!attendeeOutsideHours(att)) continue;
              if (attendeeConflicts.some(c => c.email === att.email)) continue;
              attendeeConflicts.push({ email: att.email, reason: 'off_hours' });
            }
          } else {
            const blockingAttendee = params.attendeeAvailability.find(attendeeOutsideHours);
            if (blockingAttendee) {
              trackReject(`outside_attendee_work_hours:${blockingAttendee.email}`, cursorDt.toISO()!);
              cursor = new Date(cursor.getTime() + step);
              continue;
            }
          }
        }
      }

      // ── Owner-rule verdict — THE single validator, shared with the booking
      // path. Work-hours (caller windows passed as override), vacation, category,
      // floating-block movability, travel buffer, owner-busy, and the daily
      // focus-time floor all live in checkSlot, fed the SAME owner CalendarEvents
      // the book path uses — so search can never offer a slot the book path then
      // refuses (the Eli + Isaac search-vs-book root). `allowRelaxed` (owner
      // override) bypasses checkSlot's SOFT owner rules; the two guards below keep
      // the hard ones — a real commitment and the day's bounds — out of the offer
      // whatever the caller asked for. ──
      let verdictOverOptional: string | undefined;
      let verdictBrokenRuleLabel: string | undefined;
      if (profile) {
        const slotCheckInput = {
          profile,
          slotStartIso: cursorLocal.toISO()!,
          slotEndIso: slotEndLocal.toISO()!,
          category: params.category ?? null,
          events: ownerEventsForFb,
          excludeEventIds: params.excludeEventIds,
          // v4.1.x (M2) — the booking lead time comes from the ONE validator now,
          // fed the caller's role-resolved hours, instead of a walker-only gate
          // the write path knew nothing about.
          leadTimeHours: params.minBufferHours,
          // v4.1.x (M2) — same padding the write path will apply, resolved once.
          travelBufferMinutes: effectiveTravelBufferMinutes,
          // v4.1.x (M12) — masks a private optional event's subject before it
          // can reach a colleague-facing `over_optional` tag.
          viewer: params.viewer,
          // v3.7.x (#143) — the SAME effective day the walker gated on, so search
          // and book evaluate work-hours / floor in the same windows + timezone.
          effectiveDay: effectiveDay ?? undefined,
        };
        const verdict = checkSlot({ ...slotCheckInput, allowRelaxed: params.relaxed });
        verdictOverOptional = verdict.overOptional;
        if (!verdict.passes) {
          trackReject(
            mapVerdictToRejectLabel(verdict.violation_kind, dayType),
            cursorDt.toISO()!,
            // P25 — the day narration counts in-hours slots only; which rule won on
            // an out-of-hours slot is irrelevant to "why was this day empty".
            verdict.outsideWorkHours === true,
          );
          // gh#165-d — a colleague's STRICT check (allowRelaxed:false) rejects
          // here whenever overCommitment is set (scheduleRules.ts rule 8), so
          // this is the ONLY branch a colleague's single-slot narrow-window call
          // (Guard B) ever reaches for a real clash. The relaxed-pass branch
          // below (verdict.passes===true) never fires for that caller, so before
          // this the field could never be populated on a strict rejection —
          // gh#165-b's add-attendees steer and any all-day-collision handling
          // downstream were both unreachable dead code.
          if (verdict.violation_kind === 'owner_busy_collision' && verdict.overCommitment) {
            stampConflictingEvent(verdict.overCommitment);
          }
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
        // ── A PROPOSAL IS NEVER A TIME HE IS ALREADY COMMITTED ON (M3, #142d) ──
        // `allowRelaxed` waives checkSlot rule 8 for the WRITE path — that waiver
        // is the owner's informed one-step book-through, where planMeeting turns
        // the same `overCommitment` into "booked, heads up, this double-books you
        // over X". The SEARCH must not inherit it: an offer carries no heads-up,
        // and a time he cannot attend is not an option to choose from. M3's
        // Unfiltered tier needs an approval, and a list of suggestions is not one.
        //
        // This reads the ONE validator's own occupancy fact. It REPLACES a
        // hand-rolled re-scan of the same events that dropped only slots held by
        // an EXTERNAL commitment (#142d, 2026-07-14) — a second derivation of
        // occupancy (its own showAs / all-day / overlap rules, none of them
        // `occupancyRoleOf`) and a carve-out that cost the owner two double-books
        // in one conversation: 2026-07-26 19:17Z, "Need 25 mins tomorrow with
        // Maayan" → strict 0 → the relaxed recovery offered 15:30 (his "Daniel &
        // Idan, Weekly", 15:30–15:55) and then 16:00 ("Daily Stand-up", 16:00–
        // 16:30) as "clean for both of you", because both are internal. The
        // carve-out was made when the surfaced conflict was still an owner "maybe";
        // his answer on 2026-07-26 was that a time he can't come to is not an
        // option. The DIRECT-book chain is untouched and still total: he names the
        // time, create_meeting books it, and says what it lands on.
        if (verdict.overCommitment) {
          trackReject('owner_busy_collision', cursorDt.toISO()!, verdict.outsideWorkHours === true);
          // #165b — first hit wins; a single-candidate caller has exactly one to
          // report, and a spread search never reads this field.
          stampConflictingEvent(verdict.overCommitment);
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
        // Relaxing a soft block is not extending his day (see `keepWorkHours`).
        if (params.keepWorkHours && verdict.outsideWorkHours) {
          trackReject('outside_owner_work_hours', cursorDt.toISO()!, true);
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
        // A relaxed pass is the only one that returns a rule-BREAKING slot, so it
        // is the only one that owes the owner which rule. Ask the SAME validator
        // the strict question and carry its sentence verbatim (M11/M14): pre-fix
        // the payload said nothing per slot and pointed the model at
        // `day_summary.top_reasons` — a per-DAY top-2 from the STRICT pass, which
        // on the 2026-07-26 Maayan search was ["outside_attendee_work_hours",
        // "attendee_busy_collision"] and said nothing about the offered slots at
        // all. The system prompt already promises this field exists
        // (skills/meetings.ts: "each returned slot carries broken_rule_label");
        // this is what makes that true. Owner-viewer only — the labels name his
        // mechanisms, and the colleague path has its own mechanism-free hint.
        if (params.relaxed && params.viewer === 'owner') {
          const strictVerdict = checkSlot({ ...slotCheckInput, allowRelaxed: false });
          if (!strictVerdict.passes) verdictBrokenRuleLabel = strictVerdict.violation_label;
        }
      } else {
        // No-profile fallback (degenerate callers with no UserProfile): only
        // the work-hours window + owner busy can be evaluated. Lead time was
        // applied by the pre-filter above, which is scoped to exactly this path.
        const inAnyWindow = dayHours.some(w => slotTotalMin >= w.startMin && slotEndMin <= w.endMin);
        if (!inAnyWindow) {
          trackReject('outside_owner_work_hours', cursorDt.toISO()!);
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
        const overlapsOwner = allBusy.find(busy =>
          busy.email === ownerEmailLower &&
          cursor.getTime() < busy.end.getTime() &&
          slotEnd.getTime() > busy.start.getTime()
        );
        if (overlapsOwner) {
          trackReject('owner_busy_collision', cursorDt.toISO()!);
          cursor = new Date(cursor.getTime() + step);
          continue;
        }
      }

      if (!dayBuckets.has(dayKey)) dayBuckets.set(dayKey, []);
      // v3.2.6 (RC1) — flag slots sitting on a floating block's CURRENT placement
      // (booking here forces it to shift; consumers prefer non-disturbing slots).
      const slotStartMs = cursor.getTime();
      const slotEndMs = slotEnd.getTime();
      const disturbsBlock = blockRanges.some(r => slotStartMs < r.end && slotEndMs > r.start);
      // v3.6.4 — this candidate is rule-clean (it passed checkSlot + owner-busy
      // above) but sits over a TIMED optional-join event → WE-soft. Tag it with
      // the subject; pickSpreadSlots deprioritizes it below clean slots and only
      // surfaces it to fill the spread. A slot that ALSO breaks a real rule never
      // reaches here (dropped above) — real rule wins, so WE-soft is strictly
      // above the relaxed tier and strictly below clean. The subject comes from
      // the validator's M3 level (v4.1.x), already masked for this caller.
      dayBuckets.get(dayKey)!.push({
        start: cursorLocal.toISO()!,   // local-zoned ISO with explicit offset (v2.4.2)
        end: slotEndLocal.toISO()!,
        day_type: dayType,
        disturbs_floating_block: disturbsBlock,
        ...(verdictOverOptional ? { over_optional: verdictOverOptional } : {}),
        ...(verdictBrokenRuleLabel ? { broken_rule_label: verdictBrokenRuleLabel } : {}),
        ...(attendeeConflicts.length ? { attendee_conflicts: attendeeConflicts } : {}),
        ...(packingDense ? { density: scoreSlotDensity(slotStartMs, slotEndMs, ownerBusyMs, densityCfg).score } : {}),
      });
      cursor = new Date(cursor.getTime() + step);
    }

    // v2.0.9 — per-day selection. For each day, pick up to MAX_PER_DAY with
    // PREFERRED_GAP (30 min) between picks; if that yields fewer than
    // MAX_PER_DAY, fill remaining from the unused list at 15-min spacing.
    // Owner preference: "10, 10:30, 11:30, 14:00" > "10, 10:15, 10:30, 10:45".
    for (const [, daySlots] of dayBuckets) {
      if (daySlots.length === 0) continue;
      // #133 — dense packing: keep the MOST EFFICIENT slots for the day (highest
      // density score), earliest-first as the tiebreak — instead of the variety-
      // spread pick. Clean slots still rank above WE-soft. pickSpreadSlots then
      // spreads the final offered set across days, so the owner sees efficient
      // options first (and, for cross-TZ, the earliest slot inside the overlap).
      if (packingDense) {
        const ranked = [...daySlots].sort((a, b) => {
          const soft = (a.over_optional ? 1 : 0) - (b.over_optional ? 1 : 0);
          if (soft !== 0) return soft;
          const d = (b.density ?? 0) - (a.density ?? 0);
          if (d !== 0) return d;
          return a.start.localeCompare(b.start);   // earlier better
        });
        const picked = ranked.slice(0, MAX_PER_DAY);
        picked.sort((a, b) => a.start.localeCompare(b.start));
        candidates.push(...picked);
        continue;
      }
      // v3.6.4 — sink WE-soft (optional-join) slots so the per-day cap keeps
      // CLEAN slots first and a clean slot is never dropped in favour of a soft
      // one. Stable sort → chronological order preserved within each tier.
      daySlots.sort((a, b) => (a.over_optional ? 1 : 0) - (b.over_optional ? 1 : 0));
      const picked: typeof daySlots = [daySlots[0]];
      let lastTime = new Date(daySlots[0].start).getTime();
      for (let i = 1; i < daySlots.length && picked.length < MAX_PER_DAY; i++) {
        const t = new Date(daySlots[i].start).getTime();
        if (t - lastTime >= PREFERRED_GAP_MS) {
          picked.push(daySlots[i]);
          lastTime = t;
        }
      }
      // Fallback: if we still have room, fill with anything we skipped (15-min
      // spacing allowed). Re-sort chronologically after to keep output tidy.
      if (picked.length < MAX_PER_DAY) {
        const pickedSet = new Set(picked.map(p => p.start));
        for (let i = 0; i < daySlots.length && picked.length < MAX_PER_DAY; i++) {
          if (!pickedSet.has(daySlots[i].start)) picked.push(daySlots[i]);
        }
        picked.sort((a, b) => a.start.localeCompare(b.start));
      }
      candidates.push(...picked);
    }

    // v3.7.x (#143) — the WE tentative away-TZ path is GONE. An away day is a
    // per-date override (explicit tz + stated hours); it is walked by the normal
    // loop above with its effectiveDay, so its slots are real (not tentative) and
    // computed in the away tz via checkSlot. No separate marker/offer-band path.

    // v2.3.6 (#71a) — diagnostic log for rejection reasons. When a slot
    // search returns fewer slots than expected (or zero), this log line
    // tells WHICH RULE rejected what. Grep `findAvailableSlots — rejection
    // breakdown` in maelle-YYYY-MM-DD.log to debug "why was 17:45 not
    // proposed?".
    if (Object.keys(rejectedCounts).length > 0) {
      logger.info('findAvailableSlots — rejection breakdown', {
        searchFrom: params.searchFrom,
        searchTo: currentTo.toISO(),
        durationMinutes: params.durationMinutes,
        relaxed: params.relaxed === true,
        candidatesAccepted: candidates.length,
        rejectedCounts,
        rejectedExamples,
      });
      // v2.6.1 — also surface to the caller via diagnosticsOut, if passed.
      // Used by colleague-path create_meeting Guard B to extract the
      // SPECIFIC rule that rejected a narrow-window slot, so the refusal
      // returned to Sonnet can name it (broken_rule_label) instead of
      // forcing Sonnet to guess. Last call wins on auto-expand reruns —
      // that's the loop's final verdict, which is what callers care about.
      if (params.diagnosticsOut) {
        params.diagnosticsOut.rejectedCounts = rejectedCounts;
        params.diagnosticsOut.rejectedExamples = rejectedExamples;

        // Per-day summary for Sonnet's narration. accepted=count of slots
        // surviving all rules per day; top_reasons=top 2 rejection causes when
        // accepted=0. `outside_owner_work_hours` is iteration noise (every
        // quarter-hour outside work hours gets tracked) — excluded from
        // top_reasons. P25 — every out-of-hours rejection now arrives under that one
        // label whatever rule reported it (see trackReject), so the filter matches
        // the fact instead of matching whichever rule happened to win. When a day
        // has NOTHING else (a window entirely outside his hours) the empty-ranking
        // fallback below still reports it, which is the day's true reason.
        const IRRELEVANT_FOR_DAY = new Set(['outside_owner_work_hours']);
        const acceptedPerDay = new Map<string, number>();
        for (const c of candidates) {
          const day = c.start.slice(0, 10);
          acceptedPerDay.set(day, (acceptedPerDay.get(day) ?? 0) + 1);
        }
        const allDays = new Set<string>([...acceptedPerDay.keys(), ...dayReasons.keys()]);
        const daySummary = [...allDays].sort().map(date => {
          const accepted = acceptedPerDay.get(date) ?? 0;
          let top_reasons: string[] = [];
          let blocked_by: Array<{ email: string; slots_blocked: number }> | undefined;
          if (accepted === 0) {
            const reasons = dayReasons.get(date);
            if (reasons) {
              // Split per-attendee labels (`attendee_busy_collision:<email>`
              // and `outside_attendee_work_hours:<email>`) out into the
              // blocked_by aggregate, and collapse them to the single canonical
              // label in top_reasons so output stays clean.
              const perAttendee = new Map<string, number>();
              const reasonCounts = new Map<string, number>();
              for (const [r, c] of reasons.entries()) {
                if (r.startsWith('attendee_busy_collision:')) {
                  const email = r.slice('attendee_busy_collision:'.length);
                  perAttendee.set(email, (perAttendee.get(email) ?? 0) + c);
                  reasonCounts.set('attendee_busy_collision',
                    (reasonCounts.get('attendee_busy_collision') ?? 0) + c);
                } else if (r.startsWith('outside_attendee_work_hours:')) {
                  const email = r.slice('outside_attendee_work_hours:'.length);
                  perAttendee.set(email, (perAttendee.get(email) ?? 0) + c);
                  reasonCounts.set('outside_attendee_work_hours',
                    (reasonCounts.get('outside_attendee_work_hours') ?? 0) + c);
                } else {
                  reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + c);
                }
              }
              const ranked = [...reasonCounts.entries()]
                .filter(([r]) => !IRRELEVANT_FOR_DAY.has(r))
                .sort((a, b) => b[1] - a[1])
                .map(([r]) => r);
              top_reasons = ranked.slice(0, 2);
              if (top_reasons.length === 0 && reasonCounts.size > 0) {
                const first = reasonCounts.keys().next().value;
                if (first) top_reasons = [first];
              }
              if (perAttendee.size > 0) {
                blocked_by = [...perAttendee.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([email, slots_blocked]) => ({ email, slots_blocked }));
              }
            }
          }
          return blocked_by
            ? { date, accepted, top_reasons, blocked_by }
            : { date, accepted, top_reasons };
        });
        params.diagnosticsOut.daySummary = daySummary;
      }
    }

    // v1.6.4 — enough? If yes, stop. Otherwise extend the window (but not
    // past the absolute cap) and try again.
    if (candidates.length >= 3 || !autoExpand) break;
    const nextTo = currentTo.plus({ days: 7 });
    if (nextTo.toMillis() > absoluteCap.toMillis()) {
      // Can't expand further — try one final pass at the cap, then stop.
      if (currentTo.toMillis() >= absoluteCap.toMillis()) break;
      currentTo = absoluteCap;
      continue;
    }
    currentTo = nextTo;
  }

  // pickSpreadSlots is the SINGLE spreader and bound — it round-robins by day
  // and returns at most `count`. Do NOT pre-truncate here: a CHRONOLOGICAL cap
  // (any size) lets one flooded early day dominate — a wide-open Sunday on a
  // trip week produced 41 Sunday candidates that filled the cap before Mon–Fri
  // were ever seen ("5 Sunday options"). The pool is bounded per DAY (MAX_PER_DAY
  // = the offered-slot count, so a day can fill the offer but not flood it) and
  // by the search window; only the spread picks reach the model.
  return candidates;
}
