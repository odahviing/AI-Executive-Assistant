/**
 * Every human-facing sentence a scheduling REJECTION turns into: the owner-rule
 * label (`humanizeViolationLabel`), the per-attendee conflict line
 * (`attendeeConflictLine`), and the colleague-path attendee-conflict refusal
 * built from them (`attendeeConflictRefusal`). One file so search and the two
 * booking doors can't describe the same fact differently.
 */
import { getPersonByEmail } from '../../../db';
import type { AttendeeConflictTag } from '../../../connectors/graph/findAvailableSlots';

/**
 * Human one-phrase label for a checkSlot/search rejection reason. v2.6.1 —
 * Sonnet pastes it verbatim into create_approval(policy_exception).ask_text so
 * the owner sees "outside your work hours" not a rule code. v2.7.1 — no
 * owner_buffer_collision label (connected back-to-backs are fine). Extracted
 * (v3.7.x) from three identical inline copies in ops.ts.
 *
 * `oofUntilDisplay` (gh#200) — the away span's real end, ALREADY FORMATTED
 * ("Friday 29 Aug") by its own producer (checkSlot's
 * overCommitment.allDayOutOfOfficeUntilDisplay, or the search walker's
 * day_summary.oof_until_display) — quoted verbatim, never re-derived here.
 * Only the `owner_out_of_office` case reads it; every other reason ignores it.
 */
export function humanizeViolationLabel(reason: string | undefined, ownerFirst: string, oofUntilDisplay?: string): string {
  // The walker tags per-attendee rejections as `<reason>:<email>` so day_summary
  // can attribute blame. Strip the suffix (structured string, not natural
  // language) — otherwise every attendee-blamed reason humanized to "unknown",
  // which is exactly the mechanical non-answer M9 forbids.
  const kind = typeof reason === 'string' && reason.includes(':') ? reason.split(':')[0] : reason;
  switch (kind) {
    case 'outside_owner_work_hours': return `outside ${ownerFirst}'s work hours`;
    case 'outside_attendee_work_hours': return `outside the attendee's working hours`;
    case 'attendee_busy_collision': return `an attendee is already booked then`;
    case 'within_lead_time': return `too soon — ${ownerFirst} needs more notice than that`;
    case 'in_the_past': return `that time has already passed`;
    case 'wrong_day_type': return `not the right kind of day for that (${ownerFirst} is not in the office then)`;
    case 'outside_requested_window': return `outside the time window that was asked for`;
    case 'travel_buffer_collision': return `no room for travel time around it`;
    case 'vacation_or_off_day': return `${ownerFirst} is off that day`;
    // The search's day-level verdict when his own calendar carries an
    // all-day out-of-office. Distinct from owner_busy_collision on purpose: "the
    // whole day is gone" and "that hour clashes" invite completely different
    // next moves from the person reading it.
    // gh#200 — when the away span reaches past this one day, name its real,
    // already-formatted end instead of a fresh day-scoped "that whole day" —
    // same phrasing convention as hardBlockClassPhrase's own all-day branch
    // (availabilityGate.ts), so the two never disagree about the wording.
    case 'owner_out_of_office': return oofUntilDisplay
      ? `${ownerFirst} is away through ${oofUntilDisplay}`
      : `${ownerFirst} is out of office that whole day`;
    // Adjectival, like every other label here — "That time is X" is the
    // template several callers plug this into (createMeeting.ts), and a verb
    // phrase there read as "That time is conflicts with..." (owner report,
    // 2026-07-30).
    case 'owner_busy_collision': return `in conflict with another meeting on ${ownerFirst}'s calendar`;
    // legacy label name kept as alias in case any older diagnostics path still emits it
    case 'owner_busy_or_buffer_collision': return `in conflict with another meeting on ${ownerFirst}'s calendar`;
    case 'overlaps_meeting_being_moved': return `overlaps the meeting being moved`;
    case 'focus_time_office': return `would leave ${ownerFirst} under the free-time floor (office day)`;
    case 'focus_time_home': return `would leave ${ownerFirst} under the free-time floor (home day)`;
    case 'floating_block_no_room': return `would leave no room for one of ${ownerFirst}'s daily blocks (lunch / break / etc.)`;
    case 'category_day_type': return `wrong day type for this category (e.g. office-only category on a home day)`;
    case 'category_per_day': return `over ${ownerFirst}'s per-day limit for this category`;
    case 'category_per_week': return `over ${ownerFirst}'s per-week limit for this category`;
    default: return 'unknown';
  }
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
 * people this same call named for these args. RESIDUAL, stated honestly: if the
 * retry ALSO adds an attendee who wasn't in the first call, that person's
 * conflict rides the same confirm unnamed — which is why the `_note` below
 * tells the model to re-call with the SAME args, and why every book-over is
 * logged with the emails it went over (M18).
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
