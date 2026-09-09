/**
 * Every human-facing sentence a scheduling REJECTION turns into: the owner-rule
 * label (`humanizeViolationLabel`), the per-attendee conflict line
 * (`attendeeConflictLine`), and the colleague-path attendee-conflict refusal
 * built from them (`attendeeConflictRefusal`). One file so search and the two
 * booking doors can't describe the same fact differently.
 */
import { getPersonByEmail } from '../../../db';
import type { AttendeeConflictTag, SearchRejectLabel, SearchRejectReason } from '../../../connectors/graph/findAvailableSlots';
import { ATTENDEE_REASON_PREFIXES } from '../../../utils/attendeeAvailability';

/**
 * ONE phrase per `SearchRejectLabel` (connectors/graph/findAvailableSlots.ts)
 * — a `Record`, not a `switch`, so adding a label there without adding an
 * entry HERE is a compile error (a missing key) instead of a silent
 * "unknown" at runtime, and a typo'd/removed key is caught the same way
 * (Record<K,V> rejects both extra and missing keys). This is the exhaustive
 * half of search-path-reject-labels-have-no-declaration-anywhere: every
 * OTHER reader of this vocabulary (turnHelpers.ts, createMeeting.ts,
 * moveMeeting.ts, ops/handlers/findAvailableSlots.ts) only needs a curated
 * SUBSET and stays a Set/comparison; this one has to say something about
 * EVERY member, so it's the one place exhaustiveness is actually load-bearing.
 *
 * `oofUntilDisplay` (gh#200) — the away span's real end, ALREADY FORMATTED
 * ("Friday 29 Aug") by its own producer (checkSlot's
 * overCommitment.allDayOutOfOfficeUntilDisplay, or the search walker's
 * day_summary.oof_until_display) — quoted verbatim, never re-derived here.
 * Only `owner_out_of_office` reads it; every other reason ignores it.
 */
const SEARCH_REJECT_PHRASES: Record<SearchRejectLabel, (ownerFirst: string, oofUntilDisplay?: string) => string> = {
  outside_owner_work_hours: (ownerFirst) => `outside ${ownerFirst}'s work hours`,
  within_lead_time: (ownerFirst) => `too soon — ${ownerFirst} needs more notice than that`,
  in_the_past: () => `that time has already passed`,
  wrong_day_type: (ownerFirst) => `not the right kind of day for that (${ownerFirst} is not in the office then)`,
  outside_requested_window: () => `outside the time window that was asked for`,
  travel_buffer_collision: () => `no room for travel time around it`,
  vacation_or_off_day: (ownerFirst) => `${ownerFirst} is off that day`,
  // The search's day-level verdict when his own calendar carries an all-day
  // out-of-office. Distinct from owner_busy_collision on purpose: "the whole
  // day is gone" and "that hour clashes" invite completely different next
  // moves from the person reading it. gh#200 — when the away span reaches
  // past this one day, name its real, already-formatted end instead of a
  // fresh day-scoped "that whole day" — same phrasing convention as
  // hardBlockClassPhrase's own all-day branch (availabilityGate.ts), so the
  // two never disagree about the wording.
  owner_out_of_office: (ownerFirst, oofUntilDisplay) => oofUntilDisplay
    ? `${ownerFirst} is away through ${oofUntilDisplay}`
    : `${ownerFirst} is out of office that whole day`,
  // Adjectival, like every other label here — "That time is X" is the
  // template several callers plug this into (createMeeting.ts), and a verb
  // phrase there read as "That time is conflicts with..." (owner report,
  // 2026-07-30).
  owner_busy_collision: (ownerFirst) => `in conflict with another meeting on ${ownerFirst}'s calendar`,
  overlaps_meeting_being_moved: () => `overlaps the meeting being moved`,
  focus_time_office: (ownerFirst) => `would leave ${ownerFirst} under the free-time floor (office day)`,
  focus_time_home: (ownerFirst) => `would leave ${ownerFirst} under the free-time floor (home day)`,
  floating_block_no_room: (ownerFirst) => `would leave no room for one of ${ownerFirst}'s daily blocks (lunch / break / etc.)`,
  category_day_type: () => `wrong day type for this category (e.g. office-only category on a home day)`,
  category_per_day: (ownerFirst) => `over ${ownerFirst}'s per-day limit for this category`,
  category_per_week: (ownerFirst) => `over ${ownerFirst}'s per-week limit for this category`,
};

/**
 * The ATTENDEE-scoped half — a DIFFERENT closed vocabulary
 * (`ATTENDEE_REASON_PREFIXES`, utils/attendeeAvailability.ts), kept as its
 * own exhaustive Record so a third prefix declared there also forces an
 * entry here, independent of `SEARCH_REJECT_PHRASES` above.
 */
const ATTENDEE_REJECT_PHRASES: Record<(typeof ATTENDEE_REASON_PREFIXES)[number], string> = {
  outside_attendee_work_hours: `outside the attendee's working hours`,
  attendee_busy_collision: `an attendee is already booked then`,
};

function asSearchRejectLabel(kind: string | undefined): SearchRejectLabel | undefined {
  return kind !== undefined && Object.prototype.hasOwnProperty.call(SEARCH_REJECT_PHRASES, kind)
    ? (kind as SearchRejectLabel)
    : undefined;
}

function asAttendeePrefix(kind: string | undefined): (typeof ATTENDEE_REASON_PREFIXES)[number] | undefined {
  return kind !== undefined && (ATTENDEE_REASON_PREFIXES as readonly string[]).includes(kind)
    ? (kind as (typeof ATTENDEE_REASON_PREFIXES)[number])
    : undefined;
}

/**
 * Human one-phrase label for a checkSlot/search rejection reason. v2.6.1 —
 * Sonnet pastes it verbatim into create_approval(policy_exception).ask_text so
 * the owner sees "outside your work hours" not a rule code. v2.7.1 — no
 * owner_buffer_collision label (connected back-to-backs are fine). Extracted
 * (v3.7.x) from three identical inline copies in ops.ts.
 *
 * Parameter tightened to `SearchRejectReason` (was bare `string`) —
 * search-path-reject-labels-have-no-declaration-anywhere: every call site
 * (createMeeting.ts, moveMeeting.ts, ops/handlers/findAvailableSlots.ts) now
 * passes a value typed against the same declared vocabulary instead of an
 * untyped string. The legacy `owner_busy_or_buffer_collision` alias is
 * DROPPED (2026-09-07): grepped, it had no producer left anywhere in the
 * codebase, so removing it changes nothing reachable (W5).
 */
export function humanizeViolationLabel(reason: SearchRejectReason | undefined, ownerFirst: string, oofUntilDisplay?: string): string {
  // The walker tags per-attendee rejections as `<reason>:<email>` so day_summary
  // can attribute blame. Strip the suffix (structured string, not natural
  // language) — otherwise every attendee-blamed reason humanized to "unknown",
  // which is exactly the mechanical non-answer M9 forbids.
  const kind = typeof reason === 'string' && reason.includes(':') ? reason.split(':')[0] : reason;
  const searchLabel = asSearchRejectLabel(kind);
  if (searchLabel) return SEARCH_REJECT_PHRASES[searchLabel](ownerFirst, oofUntilDisplay);
  const attendeePrefix = asAttendeePrefix(kind);
  if (attendeePrefix) return ATTENDEE_REJECT_PHRASES[attendeePrefix];
  return 'unknown';
}

/**
 * scanner-relay-first-person-attendee-status (2026-08-30) — viewer-bound,
 * pre-rendered prose for ONE `attendee_conflicts` entry. The perspective is
 * deterministic — does the entry's email match the authenticated person Maelle
 * is replying to? — so it is bound HERE in code, the same pattern as
 * `presentation_local` / `broken_rule_label` / the M13 dual-clock strings:
 * second person for the recipient's own calendar, third person BY NAME for
 * anyone else's, never "I" (a colleague reading about her OWN calendar once got
 * "I show tentative then", as if it were Maelle's).
 *
 * Lives here, next to the owner-rule labels, because THREE surfaces need the
 * identical sentence (2026-09-06): find_available_slots' per-slot `line`, and
 * the create_meeting / move_meeting colleague-path Guards' "just FYI" (below).
 * It was private to the search handler, so the Guards hand-wrote a shorter
 * paraphrase that had already lost the `tzTempDiffering` hedge.
 *
 * `viewerEmail` is null/undefined off the 1:1 colleague-DM surface (owner DM,
 * room, email leg), so those always render third person — correct for the
 * owner and for a room (multiple readers); the email leg strips the field
 * entirely before the model sees it (ops.ts's email scrub).
 */
export function attendeeFirstName(email: string): string {
  const stored = getPersonByEmail(email)?.name?.trim();
  return stored ? stored.split(/\s+/)[0] : email;
}

export function attendeeConflictLine(
  conflict: AttendeeConflictTag,
  viewerEmail: string | null | undefined,
): string {
  const you = !!viewerEmail && conflict.email.toLowerCase() === viewerEmail;
  const name = attendeeFirstName(conflict.email);
  if (conflict.reason === 'off_hours') {
    // The assumed-hours hedge (o#213 / #M3): a guessed default is never
    // narrated as fact — the hedge ships inside the line itself.
    if (conflict.assumed === true) {
      return you
        ? 'probably outside your working hours then — though I\'m not certain of your actual schedule'
        : `probably outside ${name}'s working hours then — though I'm not certain of their actual schedule`;
    }
    // v4.8.x (o#262/o#265, owner ruling 2026-08-31) — a real stored profile
    // exists but a differing, TTL'd auto-tier reading currently exists —
    // surface the assumption rather than asserting the exclusion as settled
    // fact. Attribute by `source` (2026-09-01, capturepass-haiku-zone dep) —
    // the reading can now come from a chat mention, never hard-code "Slack".
    if (conflict.tzTempDiffering) {
      const t = conflict.tzTempDiffering;
      const readingClause = t.source === 'chat'
        ? (you ? `you mentioned ${t.tempZone} in a recent chat` : `they mentioned ${t.tempZone} in a recent chat`)
        : (you ? `Slack currently shows you on ${t.tempZone}` : `Slack currently shows them on ${t.tempZone}`);
      return you
        ? `probably outside your working hours then, assuming your usual zone — ${readingClause} (through ${t.expiresAt}), flag me if that's changed`
        : `probably outside ${name}'s working hours then, assuming their usual zone — ${readingClause} (through ${t.expiresAt}), flag me if that's changed`;
    }
    return you ? 'that\'s outside your working hours' : `that's outside ${name}'s working hours`;
  }
  if (conflict.reason === 'travel_buffer') {
    // Free DURING the slot, but boxed in by something adjacent and this
    // category needs travel time either side — say that, not "busy then",
    // which would be false (M9).
    return you
      ? 'you have something right up against that time, and this one needs travel time either side'
      : `${name} has something right up against that time, and this one needs travel time either side`;
  }
  return you ? 'you\'re busy then' : `${name}'s busy then`;
}

/**
 * Join the per-attendee clauses into one sentence. Maelle BUILDS this string,
 * she never parses it (W4 is about reading language, not writing it). The comma
 * before "and" earns its place: these are clauses, not names — "outside Dana's
 * working hours, and Erez's busy then" reads as two facts, without it as one.
 */
function joinClauses(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * THE colleague-path attendee-conflict refusal — ONE implementation, both
 * doors (create_meeting's Guard B and move_meeting's colleague-path guard),
 * and the ONE place the ruling behind it is written down.
 *
 * 2026-09-06 owner ruling, verbatim: "she can just tell yael 'just fyi erez is
 * block' and if yael saying book, she book ... just make sure yael knows".
 * So an ATTENDEE conflict is never an owner-rule violation and never escalates
 * to him: the requester is TOLD and decides. "Make sure Yael knows" means knows
 * about EVERYONE blocked — this sentence names every attendee the slot doesn't
 * work for, because a first blocked attendee masking a second is the failure
 * the ruling names, with a true sentence in front of it (overturn, 2026-09-06).
 * Completeness is guaranteed upstream, not here: both Guards walk the slot in
 * `tagAttendeeConflicts` mode, where no attendee-side check can drop a slot and
 * `attendee_conflicts` is therefore the whole list (findAvailableSlots.ts).
 *
 * WHICH of the two properties this is. The overturn allowed either "the FYI
 * names everyone blocked" or "the confirm is scoped to the people named"; this
 * is the first, because the second needs the named set to travel back on the
 * confirm, and the only two places to put it are the tool schema (skills/
 * meetings.ts — the instructor lane's) or a new per-thread persisted stash (an
 * owner sign-off, W12.3). What the first buys instead: the confirm doesn't skip
 * the check, it re-runs the identical one, so the retry books over exactly the
 * people this same call named for these args. RESIDUAL, stated honestly: the
 * retry re-runs the check against whatever args and calendar state actually
 * exist at THAT moment, not a replay of the first call's findings — so ANY
 * drift between the FYI and the confirm (a changed time, a changed duration,
 * an attendee added or removed, or simply the calendar changing in between)
 * can make the confirm book over a DIFFERENT set of people than the ones this
 * sentence named, not only the added-attendee case. That's why the `_note`
 * below tells the model to re-call with the SAME args, and why every
 * book-over is logged with the ACTUAL emails it went over (M18) rather than
 * the ones this refusal named.
 *
 * `broken_rule_label` is deliberately ABSENT from this payload: it is the sole
 * field the static RULE-COMPLIANCE REFUSAL block (skills/meetings.ts) keys on
 * to steer `create_approval`, and this refusal must never reach the owner.
 * Nothing reads it on the `attendee_conflict` shape — the requester-facing
 * sentence is `message` / `_attendee_busy_note`, and the grounding marker
 * (core/orchestrator/turnHelpers.ts's attendeeCheckSource) keys on
 * `_attendee_busy_note`. Deleting the trigger, not adding a fourth prompt
 * instruction to ignore it.
 */
export interface AttendeeConflictRefusal {
  success: false;
  error: 'attendee_conflict';
  /** v3.2.5 end-of-turn coda guard (orchestrator/index.ts) — a question is
   *  open this turn; don't let a social line ride on top of it. */
  needs_confirmation: true;
  broken_rule: 'attendee_unavailable';
  _attendee_busy_note: string;
  message: string;
  _note: string;
}

export function attendeeConflictRefusal(
  conflicts: AttendeeConflictTag[],
  viewerEmail: string | null | undefined,
  action: 'book' | 'move',
): AttendeeConflictRefusal {
  const lines = conflicts.map(c => attendeeConflictLine(c, viewerEmail));
  const humanReason = joinClauses(lines);
  const tool = action === 'book' ? 'create_meeting' : 'move_meeting';
  return {
    success: false,
    error: 'attendee_conflict',
    needs_confirmation: true,
    broken_rule: 'attendee_unavailable',
    _attendee_busy_note: humanReason,
    message: `Just FYI — ${humanReason}. Want me to ${action} it anyway?`,
    _note: `This is the REQUESTER's call, not the owner's — do NOT call create_approval for this. Tell them plainly${conflicts.length > 1 ? `, naming ALL ${conflicts.length} people above` : ''}, and if they say to ${action} it anyway, re-call ${tool} with the SAME args plus confirm_attendee_conflict:true. SAME args matters: the confirm ${action}s through exactly the conflicts this call just named.`,
  };
}

/**
 * bookedOverAttendeesNote — the human sentence for a booking/move that
 * actually went through OVER an attendee conflict the requester confirmed
 * (M18), for the SUCCESS return's own `_attendee_busy_note`.
 *
 * confirm-success-return-does-not-name-who-was-booked-over (2026-09-09) —
 * `bookedOverAttendees` (createMeeting.ts) / the confirmed-conflict list
 * (moveMeeting.ts) reached only the per-attendee post-booking DMs; the
 * SUCCESS return itself carried no `_attendee_busy_note`, so
 * `attendeeCheckSource` (core/orchestrator/turnHelpers.ts) found no
 * attendee_check marker for a confirmed book-over turn — if the retry's args
 * drifted from the ones the FYI named (a changed time, a changed duration, an
 * added attendee, or the calendar moving between the FYI and the confirm),
 * nothing downstream could tell. Reuses `attendeeConflictLine` + the same
 * `joinClauses` as `attendeeConflictRefusal` above, so the success note can
 * never say something different from what the requester was originally told.
 */
export function bookedOverAttendeesNote(
  conflicts: AttendeeConflictTag[],
  viewerEmail: string | null | undefined,
): string {
  return joinClauses(conflicts.map(c => attendeeConflictLine(c, viewerEmail)));
}
