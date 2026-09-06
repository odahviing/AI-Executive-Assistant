import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { getAnthropicClient } from '../../llm/client';
import { logLlmUsage } from '../../utils/usageLog';
import logger from '../../utils/logger';
import { ATTENDEE_REASON_PREFIXES } from '../../utils/attendeeAvailability';

const anthropic = getAnthropicClient();

/**
 * Wraps anthropic.messages.create with a single retry on 429 rate-limit errors.
 * Reads the retry-after header so we wait exactly as long as the API needs.
 */
async function callClaude(
  params: Anthropic.MessageCreateParamsNonStreaming,
  retriesLeft = 1,
): Promise<Anthropic.Message> {
  try {
    const resp = await anthropic.messages.create(params) as Anthropic.Message;
    // v3.0.6 — usage logging. This wrapper is the main orchestrator loop's
    // sole API path, so one log here captures every iteration of every turn
    // — the dominant Sonnet cost. Tagged 'orchestrator'.
    logLlmUsage('orchestrator', String(params.model), resp);
    return resp;
  } catch (err: any) {
    if (err?.status === 429 && retriesLeft > 0) {
      const retryAfter = parseInt(err?.headers?.['retry-after'] ?? '30', 10);
      const waitMs = Math.min(retryAfter * 1000, 120_000); // cap at 2 min
      logger.warn('Rate limited — waiting before retry', { waitMs, retryAfter });
      await new Promise(r => setTimeout(r, waitMs));
      return callClaude(params, retriesLeft - 1);
    }
    throw err;
  }
}

/**
 * Trims conversation history to fit within token budget before sending to the API.
 * Keeps the most recent messages up to maxMessages count and maxChars total.
 * Always preserves the final user message (current turn).
 */
function trimHistory(
  messages: Anthropic.MessageParam[],
  maxChars = 12_000,
  maxMessages = 20,
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const current = messages[messages.length - 1];         // always keep current turn
  const history = messages.slice(0, -1).slice(-maxMessages); // cap message count

  // Walk backwards, accumulate until we hit char limit
  let total = 0;
  const kept: Anthropic.MessageParam[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const len = typeof history[i].content === 'string'
      ? (history[i].content as string).length
      : JSON.stringify(history[i].content).length;
    if (total + len > maxChars && kept.length >= 2) break; // always keep ≥2 for context
    total += len;
    kept.unshift(history[i]);
  }

  return [...kept, current];
}

// v2.2.5 — outcome-aware summary for mutation tools. The claim-checker reads
// these summaries to decide if a reply's success language is honest. Without
// outcome info, a failed move_meeting looked the same as a successful one and
// "all done" got waved through. Now mutations emit OK or FAILED so the checker
// can flag false-success drafts.
function mutationOutcome(result: unknown): { ok: boolean; reason?: string; eventId?: string } {
  if (result == null || typeof result !== 'object') return { ok: false, reason: 'no_result' };
  const r = result as Record<string, unknown>;
  // Common positive shapes: { success: true, ... }, { ok: true, ... }, { meetingId: ... }, { id: ... }
  // Common negative shapes: { success: false, error: '...' }, { ok: false, reason: '...' }, { warning: '...', needs_confirmation: true }
  if (r.success === false) return { ok: false, reason: typeof r.error === 'string' ? r.error : 'tool_returned_false' };
  if (r.ok === false) return { ok: false, reason: typeof r.reason === 'string' ? r.reason : 'tool_returned_false' };
  if (r.needs_confirmation === true) return { ok: false, reason: typeof r.warning === 'string' ? r.warning : 'needs_confirmation' };
  if (r.needs_owner_approval === true) return { ok: false, reason: typeof r.reason === 'string' ? r.reason : 'needs_owner_approval' };
  if (r.success === true || r.ok === true || typeof r.meetingId === 'string' || typeof r.id === 'string' || typeof r.event_id === 'string') {
    const eventId = (r.meetingId ?? r.id ?? r.event_id) as string | undefined;
    return { ok: true, eventId };
  }
  // No clear shape — be conservative, treat as not-confirmed-success.
  return { ok: false, reason: 'unclear_result' };
}

/**
 * v4.1.x (G2) — THE mutation marker. Which tools change state, and in which
 * domain, is knowledge that belongs HERE: this is the one place that holds the
 * tool name and its result at the same time, so it is the only place that can say
 * "a real state change happened" instead of guessing it later from a string.
 *
 * Before this, the claim-checker's false-positive shield re-derived the same fact
 * downstream by matching tool NAMES out of the rendered summary text — four
 * action_type branches over a 5-tool, a 2-tool and a 14-tool alternation, each
 * grown after a distinct incident, and every new mutating tool had to be
 * remembered in it or it would produce a false phantom-action flag (G1). The
 * shield now reads ONE field. Name-matching is gone from the guard entirely.
 *
 * The domain vocabulary is deliberately the claim-checker's own `action_type`
 * enum, so the shield is a single `includes('mutated=' + action_type)`. Membership
 * is exactly the set the old alternations covered — this change moves WHERE the
 * list lives, it does not change WHICH tools count.
 */
type MutationDomain = 'book' | 'task' | 'message' | 'other';
const MUTATION_DOMAIN: Record<string, MutationDomain> = {
  // calendar mutations → the claim-checker's 'book' class
  create_meeting: 'book', move_meeting: 'book', update_meeting: 'book',
  delete_meeting: 'book', book_floating_block: 'book',
  // work items raised for someone
  create_task: 'task', create_approval: 'task',
  // an outbound DM actually queued
  message_colleague: 'message',
  // the memory / preference / routine / knowledge write family
  update_my_preferences: 'other', manage_preference: 'other',
  note_about_person: 'other', note_about_self: 'other', log_interaction: 'other',
  confirm_gender: 'other', update_person_profile: 'other', update_person_memory: 'other',
  manage_routine: 'other', manage_calendar_issue: 'other', update_task: 'other',
  update_summary_draft: 'other', manage_knowledge: 'other', resolve_approval: 'other',
  // gh#200 (200b) — a per-date work-schedule override (day off / custom hours /
  // office-home flip / travel timezone). NOT 'book': it never creates, moves, or
  // deletes a calendar EVENT, so the calendar-mutation branch's outcome reader
  // (mutationOutcome, shaped for meetingId/needs_confirmation/needs_owner_approval)
  // does not apply to its result shape ({success, dates, off?, hours?, ...}).
  // It sits with the memory/preference/routine family above — a schedule-adjacent
  // STATE write, not a meeting booking — which is also what the claim-checker's
  // own action_type rubric would call it (its "book" examples are all
  // create/move/update/delete meeting + book_floating_block by name).
  set_work_schedule_override: 'other',
};

/**
 * The domain this call actually mutated, or null when nothing changed.
 *
 * Only an OK outcome earns a marker — the same convention the tool log already
 * uses (`[<tool> OK …]` vs `[<tool> FAILED …]`, #137b). A failed mutation means she
 * did NOT act, so it must not back a "done" claim: the old shield matched the tool
 * NAME and so suppressed the honesty rewrite even on `[create_meeting FAILED: …]`.
 */
function mutationDomain(toolName: string, result: unknown): MutationDomain | null {
  const domain = MUTATION_DOMAIN[toolName];
  if (!domain) return null;
  if (result == null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  // Any explicit negative — a thrown/refused call, or a skill's own no-op verdict
  // (resolve_approval's `{ok:false}`) — changed nothing.
  if (typeof r.error === 'string') return null;
  if (r.ok === false || r.success === false) return null;
  // Calendar mutations carry a rich outcome (needs_confirmation / needs_owner_approval
  // / unclear shapes are all NOT a completed write) — reuse the one reader for it.
  if (domain === 'book' && !mutationOutcome(result).ok) return null;
  return domain;
}

/**
 * notification-claim-retracted-no-backing-tool (2026-09-06) — a calendar
 * mutation NOTIFIES people by itself: cancelling an event Outlook-cancels it to
 * every attendee, declining one sends the organizer a decline
 * (calendarReads.ts:1367-1373). The handler already records WHICH real
 * notification went out in a structured enum, `notified_via`
 * ('outlook_decline_to_organizer' / 'outlook_cancellation_to_attendees' /
 * 'nobody' / unconfirmed) — derived from the Graph call's own outcome, never
 * from an intention.
 *
 * The claim-checker types "Outlook sent Julia the decline" as a MESSAGE claim,
 * but delete_meeting stamps only `mutated=book`, so the shield
 * (runOutputGates.ts:995) found nothing backing it and the honesty rewriter made
 * Maelle retract a TRUE statement. A mutation that demonstrably delivered a
 * notification backs a notification claim, so it carries the message marker too
 * — read off the tool's own confirmed-delivery enum (G2/G3: deterministic
 * trigger, not a guess from prose), and only for the two values that mean a
 * notice actually went out. 'nobody' and the unconfirmed shape back nothing,
 * exactly as before.
 */
function deliveredNotification(result: unknown): boolean {
  if (result == null || typeof result !== 'object') return false;
  const via = (result as { notified_via?: unknown }).notified_via;
  return via === 'outlook_decline_to_organizer' || via === 'outlook_cancellation_to_attendees';
}

/**
 * check-claimed-that-never-ran (2026-09-06, bounce 2) — THE attendee-check
 * marker: the read-side sibling of `mutated=<domain>` above, stamped for the
 * same reason (G2). Whether a call actually evaluated a third party's working
 * hours or busy time is a fact only this spot — tool name + result together —
 * can state, so the claim-checker's shield (runOutputGates.ts, the
 * matchingToolAlreadyRan block) reads ONE token, `attendee_check=`, in this
 * turn's tape and in prior turns' persisted rows, instead of re-deriving it
 * from prose. The line's own text (the busy note, `unavailable (outside the
 * attendee's working hours: <email>)`, `attendee_partial=`, the refusal label)
 * still says WHAT the check found and about whom; the marker only says that
 * one happened. The value names the source, for a log reader:
 *   slots   — find_available_slots rejected a candidate or quarter-hours on an
 *             attendee reason (`attendee_busy_collision:<email>` /
 *             `outside_attendee_work_hours:<email>`, or their per-day tallies
 *             `blocked_by` / `attendee_partial_conflicts`, which exist only
 *             for those two reasons — findAvailableSlots.ts:1617-1630).
 *   refused — a calendar mutation the colleague-path guard refused with
 *             reason `attendee_unavailable` (moveMeeting.ts:1214).
 *   noted   — a create/move carrying planMeeting's heads-up (`_attendee_busy_note`
 *             / `override_notice`), whether the write went through OR was
 *             refused as a `rule_violation` confirm-ask (createMeeting.ts:1287-1289
 *             sets the note on the FAILED attendee-collision gate same as the OK
 *             booked-through path does — checked regardless of outcome). That
 *             notice is planMeeting's JOINED overrideNotice (planMeeting.ts:1261),
 *             so it can also carry a non-attendee heads-up (a level notice, a room
 *             clash); stamping on presence errs toward GROUNDING, the G5-safe
 *             direction, and the checker still reads the note's text for what
 *             it actually says. A structured busy/hours field on the result
 *             would make this exact; until one exists, presence.
 *   memory  — get_person_memory read a person's notes (which hold their
 *             stated hours); a `found:false` miss (assistant.ts:865-871, no
 *             `error` field) grounds nothing.
 * Tools that describe the OWNER's own availability (get_calendar,
 * check_join_availability, the `[availability_precheck …]` lines) never carry
 * it: the class this grounds is a finding about someone else.
 */
function attendeeCheckSource(toolName: string, result: unknown): 'slots' | 'refused' | 'noted' | 'memory' | null {
  if (result == null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const isAttendeeReason = (reason: unknown): boolean =>
    typeof reason === 'string'
    && ATTENDEE_REASON_PREFIXES.some(p => reason === p || reason.startsWith(`${p}:`));
  const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
  switch (toolName) {
    case 'find_available_slots': {
      if (r.mode === 'candidate_validation') {
        const results = Array.isArray(r.results) ? (r.results as Array<{ broken_rule?: unknown }>) : [];
        return results.some(x => isAttendeeReason(x.broken_rule)) ? 'slots' : null;
      }
      const days = Array.isArray(r.day_summary)
        ? (r.day_summary as Array<{ top_reasons?: unknown; blocked_by?: unknown; attendee_partial_conflicts?: unknown }>)
        : [];
      const hit = days.some(d => nonEmpty(d.blocked_by) || nonEmpty(d.attendee_partial_conflicts)
        || (Array.isArray(d.top_reasons) && d.top_reasons.some(isAttendeeReason)));
      return hit ? 'slots' : null;
    }
    case 'create_meeting':
    case 'move_meeting':
    case 'update_meeting': {
      // gh#4.8.7 attendee-signal-dropped-on-create-refusal — a FAILED
      // create/move (the confirm_override attendee-collision gate,
      // createMeeting.ts:1287-1289) carries `_attendee_busy_note` /
      // `override_notice` same as an OK booked-through write does; the old
      // `!outcome.ok` early return exited before ever looking at it, so that
      // FAILED turn produced NO attendee_check source at all. Check the note
      // regardless of outcome; only the distinct colleague-path refusal shape
      // (`needs_owner_approval` + `reason: 'attendee_unavailable'`,
      // moveMeeting.ts:1216-1228, which never carries this note) still maps
      // to 'refused'.
      const outcome = mutationOutcome(result);
      if (!outcome.ok && outcome.reason === 'attendee_unavailable') return 'refused';
      return (typeof r._attendee_busy_note === 'string' || typeof r.override_notice === 'string') ? 'noted' : null;
    }
    case 'get_person_memory':
      // check-claimed-that-never-ran (2026-09-06) — the miss shape
      // (assistant.ts:865-871) is `{found:false, person, message}`, no
      // `error` field, so it fell through to 'memory' as though a lookup had
      // actually found something to ground a claim against.
      return (typeof r.error === 'string' || r.found === false) ? null : 'memory';
    default:
      return null;
  }
}

function summarizeToolCall(toolName: string, input: Record<string, unknown>, result: unknown): string {
  const summary = renderToolSummary(toolName, input, result);
  const domain = mutationDomain(toolName, result);
  // Stamped OUTSIDE the tool's bracket on purpose: MUTATION_OK_RE below lifts the
  // bracketed span verbatim into the pinned action tape, so keeping the marker out
  // of it leaves that prompt block byte-identical to before. The marker still rides
  // along everywhere it needs to — the summaries are persisted to conversation
  // history joined verbatim (postReply Step 1b), which is exactly what the shield
  // reads for both this turn and prior turns.
  // A mutation can carry TWO domains when it also delivered a notification (see
  // deliveredNotification above) — space-joined, which is what the shield's
  // `includes('mutated=' + action_type)` already reads either way.
  const domains = domain
    ? (domain !== 'message' && deliveredNotification(result) ? [domain, 'message' as const] : [domain])
    : [];
  // `attendee_check=<source>` rides the same outside-the-bracket slot (see
  // attendeeCheckSource above) — the shield's `includes('attendee_check=')`
  // reads it the same way, this turn and from persisted prior rows.
  const attendeeCheck = attendeeCheckSource(toolName, result);
  const markers = [
    ...domains.map(d => `mutated=${d}`),
    ...(attendeeCheck ? [`attendee_check=${attendeeCheck}`] : []),
  ];
  return markers.length ? `${summary} ${markers.join(' ')}` : summary;
}

/**
 * v4.1.x — the tool-log line for an INTERNAL action: a mutation a skill performed
 * inside its own run (active-mode calendar health rebooking lunch, or auto-moving a
 * meeting) rather than as its own top-level tool call. The orchestrator surfaces
 * these onto the same tape so the claim-checker can see them.
 *
 * It lives HERE, beside summarizeToolCall, because it is the SAME surface and has to
 * carry the same marker — and when it didn't, it broke exactly the reply it exists to
 * protect. The retired name-matching alternation happened to match these lines on the
 * tool name (`[book_floating_block (via …`, `[move_meeting (via …`), so moving the
 * shield onto the carried marker silently dropped both paths: with
 * calendar_health_mode "active" (config/users/idan.yaml:228), "how's my calendar
 * today?" auto-rebooks lunch, and Maelle's TRUE "I put lunch back at 12:30" would be
 * flagged as a phantom action and sent to rewriteOwningTheMiss.
 *
 * No outcome gate here, unlike a real tool call: an internal action is only ever
 * emitted AFTER its mutation succeeded (checkHealth.ts:836 gates on `ok && created`;
 * autoMove.ts:273 pushes once the move and its notifications have landed), so the
 * entry's existence IS the confirmation. Reusing MUTATION_DOMAIN keeps coverage
 * identical to the tool path — set_event_category and rebalance_floating_blocks are
 * not in it, and were not in the old alternations either, so they stay unmarked.
 */
function summarizeInternalAction(tool: string, viaTool: string, detail?: string): string {
  const line = `[${tool} (via ${viaTool}): ${detail ?? ''}]`;
  const domain = MUTATION_DOMAIN[tool];
  return domain ? `${line} mutated=${domain}` : line;
}

/**
 * Build a compact one-line summary of a tool call for conversation history.
 * This lets Claude know what it did on previous turns without storing the full JSON.
 */
function renderToolSummary(toolName: string, input: Record<string, unknown>, result: unknown): string {
  try {
    // createmeeting-failed-summary-drops-counter-offer-reason (2026-09-04) — a
    // soft counter-proposal (create_meeting's efficiency_counter path,
    // createMeeting.ts:1464-1478) carries a real, specific `counter_offer.reason`
    // the tool itself computed — not a black-box failure. The generic FAILED
    // branch below kept only the short error CODE ('efficiency_counter'), so a
    // checker-visible summary could never back the very explanation the tool
    // supplied, and a true claim ("packs it back to back with what's after")
    // read as invented and got rewritten into a generic question. Read
    // generically off the `counter_offer` shape (not by tool name) so any tool
    // that returns this same structure is covered, not just this one call site
    // (G2: carry the tool's own reason, don't drop it before the checker sees it).
    if (result && typeof result === 'object') {
      const co = (result as { counter_offer?: { suggested_start?: unknown; reason?: unknown } }).counter_offer;
      if (co && typeof co.reason === 'string') {
        const suggested = typeof co.suggested_start === 'string' ? ` suggested=${co.suggested_start}` : '';
        const reason = co.reason.replace(/\s+/g, ' ').trim().slice(0, 160);
        return `[${toolName} FAILED: counter-offer${suggested} — ${reason}]`;
      }
    }
    // v3.0.5 — generic FAILED detection. registry.ts wraps every thrown
    // tool call in `{ error: 'Tool "X" failed: <reason>' }`, and skills also
    // return `{ error: ... }` for non-thrown refusals. Surface both as
    // `[<tool> FAILED: <reason>]` BEFORE the per-tool cases — otherwise a
    // throw-from-message_colleague would render as `[message_colleague: Yael]`
    // and the claim-checker shield treats it as success (silent-fail bug:
    // outreach DM never sent, draft "Sent the message" sneaks past the
    // checker because the tool is "in toolSummaries").
    if (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string') {
      const reason = String((result as { error: string }).error).replace(/\s+/g, ' ').trim().slice(0, 80);
      return `[${toolName} FAILED: ${reason}]`;
    }
    switch (toolName) {
      case 'analyze_calendar': {
        // gatekeeper-offday-hedge-recurs-on-date-range (2026-08-30) — the
        // handler (calendarReads.ts's handleAnalyzeCalendar) returns the bare
        // `DayAnalysis[]` array ONLY when there's nothing else to attach; the
        // moment a Working Elsewhere note applies to the range, it wraps the
        // SAME array in `{ day_analysis: [...], ...weNote }` — the exact
        // bare-vs-wrapped split `get_calendar` below already had to handle
        // (v4.4.x). Reading only the bare-array case silently zeroed both
        // `totalIssues` AND (new below) every day-off/OOF date whenever the
        // range also carried a WE note.
        const days: any[] = Array.isArray(result) ? result
          : (result && typeof result === 'object' && Array.isArray((result as any).day_analysis)) ? (result as any).day_analysis
          : [];
        const totalIssues = days.reduce((n: number, d: any) => n + (d.issues?.length ?? 0), 0);
        // a RANGE ask ("am I off next week?") can land on THIS tool rather
        // than find_available_slots, and this line carried only a day COUNT —
        // so a true "you're off Mon–Wed" statement had nothing in TOOL
        // ACTIVITY to match and got hedged as invented. Surface each day's
        // real day-off/OOF status here too, from the per-day DayAnalysis
        // fields (`dayType`, `outOfOfficeAllDay` —
        // skills/meetings/ops/analysis.ts:284,303) claimChecker's owner_fact
        // mode is written to treat as ground truth. Sibling of the
        // `off_days=` marker find_available_slots emits below; same bug.
        const dayOffDates = days.filter((d: any) => d.dayType === 'day_off').map((d: any) => d.date);
        const oofDates = days.filter((d: any) => d.outOfOfficeAllDay === true).map((d: any) => d.date);
        const dayOffPart = dayOffDates.length ? ` day_off=${dayOffDates.join(',')}` : '';
        const oofPart = oofDates.length ? ` owner_out_of_office=${oofDates.join(',')}` : '';
        return `[analyze_calendar ${input.start_date}→${input.end_date}: ${days.length} days, ${totalIssues} issues${dayOffPart}${oofPart}]`;
      }
      case 'get_calendar': {
        // v4.4.x — get_calendar returns a bare array only when it has nothing else
        // to say. The moment it needs to attach a note (WE day, optional-join
        // event, colleague-scoped view, audit context), the handler wraps the SAME
        // list in `{ events: [...], ... }` (calendarReads.ts ~297, ~312) — and that
        // shape still carries real events. Reading only the bare-array case here
        // silently summarized every one of those turns as "0 events", which is a
        // false absence fed straight into conversation history for the NEXT turn.
        const events = Array.isArray(result) ? result
          : (result && typeof result === 'object' && Array.isArray((result as any).events)) ? (result as any).events
          : [];
        return `[get_calendar ${input.start_date}→${input.end_date}: ${events.length} events]`;
      }
      case 'find_available_slots': {
        // v3.0.3 — enrich the summary with the actual slot list returned,
        // not just the input duration. Pre-fix the compact string was
        // `[find_available_slots: duration_minutes=N]` — claim-checker
        // couldn't verify specific time claims in the draft because the
        // summary carried no slot data.
        //
        // proposed-slot-not-grounded-in-search-result (2026-08-24) — list
        // EVERY slot the tool actually returned, not a hardcoded top-5. The
        // handler already bounds this list itself (pickSpreadSlots /
        // pickSpreadMustBe, capped at `offeredSlotCount(profile)` — default 8,
        // owner-configurable) — a SECOND, independent cap of 5 here silently
        // dropped up to 3 real, Sonnet-visible candidates from the one place
        // the slot-grounding check (claimChecker's 'slot_grounding' mode)
        // reads its ground truth. A draft that correctly named the 6th/7th/8th
        // offered slot would have read as "not in the list" and been corrected
        // into a false refusal of a genuinely available time — G2 (this log
        // must carry the truth, not a guess) and G5 (a guard must never
        // corrupt a correct reply) both required removing the second cap.
        // bounce-fix (2026-08-26) — carry `presentation_local`
        // (src/skills/meetings/ops/handlers/findAvailableSlots.ts, e.g. "Thu
        // 4 Sep 08:00 EDT") when the tool
        // attached one. Without it, this line has ONLY the owner-local
        // HH:MM with the UTC offset already sliced off — the slot-grounding
        // and owner-fact prompts both ask the model to judge a
        // "timezone-equivalent restatement" against ground truth that
        // carries no timezone info at all, so a correct "08:00 ET" claim
        // could not actually be verified, only guessed at (worst case,
        // incorrectly rewritten into a wrong bare owner-clock number).
        const fmt = (s: { start?: string; end?: string; presentation_local?: string }) => {
          if (!s.start) return '?';
          const t = String(s.start).slice(11, 16);  // 'HH:MM'
          const d = String(s.start).slice(0, 10);   // 'YYYY-MM-DD'
          const base = s.end ? `${d} ${t}-${String(s.end).slice(11, 16)}` : `${d} ${t}`;
          return s.presentation_local ? `${base} [local: ${s.presentation_local}]` : base;
        };
        // check-claimed-that-never-ran (2026-09-06, bounce) — `broken_rule_label`
        // is the HUMANIZED phrase, and for the two attendee-scoped reasons it is
        // deliberately NAME-FREE ("outside the attendee's working hours",
        // violationLabels.ts:22-23). The raw `broken_rule` beside it carries the
        // blamed person as a `<reason>:<email>` suffix
        // (findAvailableSlots.ts:1253) — a structured string, not natural
        // language. Surface that email, so a checker reading this line can tell
        // WHOSE hours/busy time blocked the candidate instead of only THAT
        // someone's did: a true "10:15 is outside Erez's hours" narration was
        // otherwise unverifiable against a line that never named Erez (G2).
        const blamedParty = (v: { broken_rule?: string }) =>
          typeof v.broken_rule === 'string' && v.broken_rule.includes(':')
            ? v.broken_rule.slice(v.broken_rule.indexOf(':') + 1).slice(0, 60)
            : '';
        const verdictWord = (v: { available?: boolean; broken_rule?: string; broken_rule_label?: string }) =>
          v.available
            ? 'available'
            : `unavailable${v.broken_rule_label ? ` (${v.broken_rule_label}${blamedParty(v) ? `: ${blamedParty(v)}` : ''})` : ''}`;

        // bounce-fix finding 1 (2026-08-24) — candidate_validation is a
        // SEPARATE shape with no `slots` key at all
        // (findAvailableSlots.ts:1181-1190): `{ mode:'candidate_validation',
        // duration_minutes, candidates_checked, results:[{start,end,
        // available,...}] }`. Falling through to the slots-array path below
        // always read length 0 and rendered "0 slots" even when every named
        // candidate came back available=true — this is the tool's own
        // documented preferred mode for "does 15:45 or 16:15 work?"
        // (meetings.ts:230), so high-frequency, not an edge case. Render
        // each candidate's own real verdict instead so the slot-grounding
        // check (and the claim-checker generally) has real ground truth.
        if (result && typeof result === 'object' && (result as any).mode === 'candidate_validation') {
          const results: Array<{ start?: string; end?: string; available?: boolean; broken_rule?: string; broken_rule_label?: string }> =
            Array.isArray((result as any).results) ? (result as any).results : [];
          const durCV = (result as any).duration_minutes ?? (input as any).duration_minutes;
          const parts = results.map(r => `${fmt(r)} ${verdictWord(r)}`);
          return `[find_available_slots candidate_validation dur=${durCV}m: ${parts.join(', ')}]`;
        }

        const slots: Array<{ start?: string; end?: string }> =
          Array.isArray(result) ? result :
          (result && typeof result === 'object' && Array.isArray((result as any).slots)) ? (result as any).slots :
          [];
        const slotList = slots.map(fmt).join(', ');
        const dur = (input as any).duration_minutes;
        const from = (input as any).search_from;
        const to = (input as any).search_to;
        const window = from && to ? ` ${String(from).slice(0, 16)}→${String(to).slice(0, 16)}` : '';
        // bounce-fix finding 2 (2026-08-24) — `preferred_slot_status` is a
        // tool-confirmed available (or unavailable, with its real reason)
        // instant that is DELIBERATELY excluded from `slots` itself
        // (findAvailableSlots.ts:1744-1763, attached at :2062) — the handler
        // tells Sonnet to "treat it as available and offer it alongside
        // `slots`; never imply it's blocked, and never stay silent about
        // it." Rendering only `slots` made this confirmed instant invisible
        // to the slot-grounding ground truth — worst case, if it were the
        // ONLY available time, a guaranteed false "nothing found".
        const preferredStatus = (result && typeof result === 'object') ? (result as any).preferred_slot_status : undefined;
        const preferredPart = (preferredStatus && typeof preferredStatus === 'object' && typeof preferredStatus.start === 'string')
          ? `; preferred ${fmt(preferredStatus)} ${verdictWord(preferredStatus)}`
          : '';
        // gatekeeper-offday-hedge-recurs-on-date-range (2026-08-30) —
        // day_summary used to be read ONLY inside the `slots.length === 0`
        // branch below. A RANGE ask ("any time next week?") where the owner is
        // off Mon–Wed but free Thu–Fri comes back WITH slots, so that branch
        // never ran and the line carried nothing at all about the three off
        // days — a true "he's off Monday through Wednesday" sentence then had
        // no ground truth in TOOL ACTIVITY and claimChecker's owner_fact mode
        // hedged it into a false "you're inventing that". The handler attaches
        // day_summary on the WITH-slots return too
        // (skills/meetings/ops/handlers/findAvailableSlots.ts:2170, alongside
        // the zero-slot returns at :1514/:1581/:1615), so read it once here for
        // both branches.
        const daySummary: Array<{ date?: string; accepted?: number; top_reasons?: string[]; oof_until_display?: string; attendee_partial_conflicts?: Array<{ email?: string; slots_blocked?: number }> }> =
          (result && typeof result === 'object' && Array.isArray((result as any).day_summary))
            ? (result as any).day_summary
            : [];
        // WHOLE-day off only. `vacation_or_off_day` is a genuine day-level
        // skip: the `{ kind: 'day_skip', dayKey, reason: 'vacation_or_off_day' }`
        // verdict, returned from evaluateCursor's workday-gate branch in
        // connectors/graph/findAvailableSlots.ts, lands in the per-day reason map once per day.
        // `owner_out_of_office` is NOT that shape — it is a per-slot
        // `reject` outcome (:998) routed through `trackReject` (:878), which
        // still lands in `dayReasons` (same reason recorded for every slot
        // in the day, since `oofDayKeys.has(dayKey)` holds for the whole
        // day), just via the per-slot path rather than a single day-level
        // write. Either way `top_reasons` only fills when the day accepted
        // zero slots (:1534). A merely BUSY day must never render here —
        // that would ground a false "he's off that day", the exact
        // corruption this line exists to prevent (G2/G5).
        const WHOLE_DAY_OFF_REASONS = new Set(['vacation_or_off_day', 'owner_out_of_office']);
        const offDayParts = daySummary
          .filter(d => typeof d.date === 'string' && d.accepted === 0
            && (d.top_reasons ?? []).some(r => WHOLE_DAY_OFF_REASONS.has(r)))
          .map(d => {
            const reason = (d.top_reasons ?? []).find(r => WHOLE_DAY_OFF_REASONS.has(r));
            return `${d.date}(${reason}${d.oof_until_display ? ` until ${d.oof_until_display}` : ''})`;
          });
        const offDaysPart = offDayParts.length ? ` off_days=${offDayParts.join(',')}` : '';
        // slots-returned-turn-carries-no-attendee-rejection-reason (2026-09-06)
        // — a day can yield slots (accepted > 0, so it's invisible to
        // offDaysPart/reasonPart above, both gated to accepted===0) while ALSO
        // having quarter-hours an attendee couldn't make.
        // `attendee_partial_conflicts` (findAvailableSlots.ts's DaySummaryEntry)
        // carries exactly that per-attendee tally for the partially-rejected
        // case. Render it here so a true "Erez can't make some of today's
        // options" has ground truth in TOOL ACTIVITY on a WITH-slots turn,
        // same as offDaysPart does for whole-day-off — without this,
        // claimChecker's invented_third_party_fact rule has nothing to check
        // that true sentence against.
        const attendeePartialParts = daySummary
          .filter(d => typeof d.date === 'string' && Array.isArray(d.attendee_partial_conflicts) && d.attendee_partial_conflicts.length > 0)
          .map(d => {
            const byAttendee = (d.attendee_partial_conflicts ?? [])
              .map(a => `${a.email}:${a.slots_blocked}`)
              .join('+');
            return `${d.date}(${byAttendee})`;
          });
        const attendeePartialPart = attendeePartialParts.length ? ` attendee_partial=${attendeePartialParts.join(',')}` : '';
        if (slots.length === 0) {
          // gh#chris-kelley-oof-block-a — a zero-result day_summary (the
          // rejection reason for EVERY date, e.g. owner_out_of_office) used
          // to be dropped here: only slot count reached the summary, so
          // claimChecker's owner_fact mode had nothing in TOOL ACTIVITY to
          // ground a true "he's away" statement against and hedged it into
          // a false-sounding non-answer. Surface the top reason (+ the OOF
          // span end, already formatted by the walker) when present. Kept
          // alongside `off_days` above: this aggregate also covers reasons
          // that are NOT a whole-day off (attendee_busy_collision, …).
          let reasonPart = '';
          if (daySummary.length > 0) {
            const reasonCounts = new Map<string, number>();
            let oofUntil: string | undefined;
            for (const day of daySummary) {
              for (const r of day.top_reasons ?? []) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
              if (!oofUntil && day.oof_until_display) oofUntil = day.oof_until_display;
            }
            const topReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            if (topReason) {
              reasonPart = ` reason=${topReason}${oofUntil ? ` (until ${oofUntil})` : ''}`;
            }
          }
          return `[find_available_slots${window} dur=${dur}m: 0 slots${reasonPart}${offDaysPart}${preferredPart}]`;
        }
        return `[find_available_slots${window} dur=${dur}m → ${slots.length} slots: ${slotList}${offDaysPart}${attendeePartialPart}${preferredPart}]`;
      }
      case 'check_join_availability': {
        // proposed-slot-not-grounded-in-search-result (2026-08-24) — this tool
        // had NO dedicated case; it fell through to the generic `default`
        // below, which renders only the FIRST input key (`meeting_start`) and
        // never the actual verdict. So the claim-checker's slot-grounding
        // check had zero ground truth for this tool's outcome — a colleague
        // could be told "he can join" with nothing in the tool log to confirm
        // or refute it. Render the checked instant AND the real `can_join`
        // verdict (meetings.ts's own field: true / 'partial' / false /
        // 'needs_approval') so a "he's free then" claim can be verified the
        // same way a find_available_slots claim can.
        const meetingStart = typeof input.meeting_start === 'string' ? input.meeting_start : '';
        const when = meetingStart ? `${meetingStart.slice(0, 10)} ${meetingStart.slice(11, 16)}` : '?';
        const canJoin = (result && typeof result === 'object') ? (result as { can_join?: unknown }).can_join : undefined;
        return `[check_join_availability ${when}: can_join=${String(canJoin ?? 'unknown')}]`;
      }
      case 'find_slack_user':
        return `[find_slack_user: "${input.name}"]`;
      case 'message_colleague':
        return `[message_colleague: ${(input as any).colleague_name}]`;
      // v2.2.5 — mutation tools: read the outcome so the claim-checker sees
      // FAILED vs OK rather than just "the call ran."
      case 'create_meeting':
      case 'move_meeting':
      case 'update_meeting':
      case 'delete_meeting':
      case 'book_floating_block': {
        const outcome = mutationOutcome(result);
        const idPart = outcome.ok && outcome.eventId ? ` event_id=${String(outcome.eventId).slice(0, 16)}…` : '';

        // v3.6.x, generalized 2026-09-06 (delete-meeting-notified-via-dropped-
        // from-summary) — every handler in this group computes its own
        // post-change action_summary prose: update_meeting's changed-fields
        // list, delete_meeting's notified_via sentence ("Outlook sent Julia
        // the decline…"), create/move_meeting's booked/moved line. Read it
        // generically off the RESULT SHAPE for ANY OK outcome here, not by
        // tool name — the update_meeting-only check used to drop a fact a
        // handler had already derived (delete_meeting's own notification
        // sentence) down to a bare subject, leaving claim-checker with no
        // ground truth for a true notified-X claim, which it then flagged as
        // an unbacked phantom action and had Maelle retract twice (G2: the
        // log carries what HAPPENED, not the stale label used to find the
        // meeting).
        // check-claimed-that-never-ran (2026-09-06) — move_meeting's
        // `_attendee_busy_note` and create_meeting's `override_notice` carry
        // a real "who's busy / whose hours this breaks" heads-up (planMeeting's
        // own overrideNotice, moveMeeting.ts:2228 / createMeeting.ts:2126) that
        // was NEVER folded into `action_summary` — Sonnet sees it (it reads the
        // raw tool result), but the claim-checker only ever reads THIS compact
        // log, so a TRUE "that lands on Erez's busy time"/"outside Yael's hours"
        // narration had no ground truth here and risked being flagged as an
        // invented third-party finding. Surfaced generically, by field, not by
        // tool name — same reasoning as the action_summary generalization above.
        const attendeeBusyNote = [
          (result as { _attendee_busy_note?: unknown })._attendee_busy_note,
          (result as { override_notice?: unknown }).override_notice,
        ].find(v => typeof v === 'string') as string | undefined;
        const busyNotePart = attendeeBusyNote ? ` [${attendeeBusyNote.replace(/\s+/g, ' ').trim().slice(0, 160)}]` : '';

        if (outcome.ok && typeof (result as { action_summary?: unknown }).action_summary === 'string') {
          const changes = (result as { action_summary: string }).action_summary.replace(/\s+/g, ' ').trim().slice(0, 220);
          // v3.7.x — surface the structured added-attendee EMAILS beside the
          // prose (update_meeting's shape only — harmless no-op elsewhere).
          // action_summary renders an added attendee by DISPLAY NAME ("added
          // Meeting Room"); a draft that names the EMAIL ("added meeting@…") then
          // can't be matched against the summary and the checker inverted a TRUE
          // add. The email is already in the tool result (added_attendees) — carry
          // it into the log the checker reads so a claim in EITHER form matches
          // (G2: carry the truth, don't make the checker guess a name↔email bridge).
          const addedEmails = Array.isArray((result as { added_attendees?: unknown }).added_attendees)
            ? ((result as { added_attendees: unknown[] }).added_attendees.filter(e => typeof e === 'string') as string[])
            : [];
          const addedPart = addedEmails.length ? ` [added: ${addedEmails.join(', ')}]` : '';
          return changes
            ? `[${toolName} OK — ${changes}${addedPart}${busyNotePart}${idPart}]`
            : `[${toolName} OK ${String((input as any).new_subject ?? (input as any).meeting_subject ?? '').slice(0, 40)}${addedPart}${busyNotePart}${idPart}]`;
        }

        // v3.4.2 (NEW-1) — NEVER fall back to meeting_id here. It was rendered
        // sliced to 40 chars with NO ellipsis, so the pinned action-tape summary
        // (e.g. `[update_meeting OK AAMkADVmMjY1…40chars]`) looked like a COMPLETE
        // id — Sonnet copied it back as meeting_id on the next edit → Graph
        // "ErrorInvalidIdMalformed: The Id is invalid" + a forced re-fetch/retry
        // (the Boston-thread failures). Use the human-readable subject instead;
        // the full canonical id reaches Sonnet via get_calendar / the just-booked
        // event injection, never a truncated summary.
        const subj = (input as any).subject ?? (input as any).meeting_subject ?? (input as any).new_start ?? (input as any).date ?? '';
        const subjPart = subj ? ` ${String(subj).slice(0, 40)}` : '';
        if (outcome.ok) {
          return `[${toolName} OK${subjPart}${busyNotePart}${idPart}]`;
        }
        // check-claimed-that-never-ran (2026-09-06, bounce) — a refused
        // calendar mutation carries a `broken_rule_label` the handler already
        // humanized WITH the blocking person's name ("it's outside Erez's
        // working hours" / "Yael isn't free then", moveMeeting.ts:1183-1198,
        // createMeeting's parallel guard). `outcome.reason` alone is the bare
        // code (`attendee_unavailable`), so the one line a checker can read
        // said an attendee blocked it but never which one — the same G2 gap as
        // the candidate_validation line above. Carry the handler's own phrase.
        const brokenLabel = (result && typeof result === 'object'
          && typeof (result as { broken_rule_label?: unknown }).broken_rule_label === 'string')
          ? ` (${(result as { broken_rule_label: string }).broken_rule_label.replace(/\s+/g, ' ').trim().slice(0, 100)})`
          : '';
        return `[${toolName} FAILED${subjPart}${outcome.reason ? `: ${outcome.reason.slice(0, 60)}` : ''}${brokenLabel}]`;
      }
      case 'set_event_category': {
        // Pure mutation (no read mode) → a non-error result IS success. Emit an
        // explicit OK marker so the claim-checker can confirm a "Done / updated
        // / categorized" claim. The generic `default` below carried NO outcome
        // marker, so legit category updates ("All 7 updated to Weekly") were
        // flagged as unverifiable and rewritten (GH 2026-06-17 over-fire).
        // FAILED is already handled by the generic error check at the top.
        const cat = (input as any).category ?? (input as any).category_id ?? (input as any).label ?? '';
        return `[set_event_category OK${cat ? ` ${String(cat).slice(0, 40)}` : ''}]`;
      }
      case 'resolve_approval': {
        // v3.7.x — CARRY THE REPLAY OUTCOME so the claim-checker
        // can tell a real mutation-replay from a decision-only approve. The
        // DURABLE signal (approval chat's contract) is `action_summary`: a
        // deferred_action that replayed returns it (+ `booked` for a booking
        // tool); a freeform / callback-less approve applies NOTHING and returns an
        // explicit no-replay effect ('approved (no replay)' / 'approved — no
        // action to replay …'). The default summarizer showed only
        // `[resolve_approval: approval_id=…]`, outcome-blind, so a false "added /
        // booked X" after a no-op approve passed on the tool name alone (Maayan
        // add-attendees, 2026-07-19). Emit an UNAMBIGUOUS marker: the no-op branch
        // must never contain the word "replay" (the resolver's own 'no action to
        // replay' would otherwise read to the checker as a replay). Only the
        // EXPLICIT no-op is marked "NO calendar change"; an unknown resolve shape
        // (reject / amend / expired) stays neutral so the checker never
        // manufactures a flag off it (G5 safe-miss).
        const r = result as { ok?: boolean; state?: string; effect?: string; action_summary?: string; booked?: boolean; reason?: string };
        if (r.ok === false) {
          return `[resolve_approval — not resolved${typeof r.reason === 'string' ? `: ${r.reason.slice(0, 60)}` : ''}]`;
        }
        const effect = typeof r.effect === 'string' ? r.effect.toLowerCase() : '';
        const replayed = (typeof r.action_summary === 'string' && r.action_summary.trim().length > 0)
          || r.booked === true || effect.includes('action replayed');
        if (replayed) {
          const summ = typeof r.action_summary === 'string' && r.action_summary.trim().length
            ? `: ${r.action_summary.replace(/\s+/g, ' ').trim().slice(0, 120)}` : '';
          return `[resolve_approval OK — replayed the approved action${summ}]`;
        }
        if (effect.includes('no replay') || effect.includes('no action to replay')) {
          return `[resolve_approval OK — decision recorded, NO calendar change]`;
        }
        return `[resolve_approval OK — ${r.effect ?? r.state ?? 'resolved'}]`;
      }
      case 'set_work_schedule_override': {
        // gh#200 (200b) — before this case, the generic `default` below rendered
        // ONLY the first input key (`date_from=...`), so a 17-day range wrote
        // correctly (handler logged `wrote {count:17}`) but the claim-checker
        // couldn't see the range, the day count, or the off/hours/clear intent —
        // it had nothing to verify "marked off from today through Aug 29"
        // against, and flagged the TRUE claim as unconfirmed (false positive,
        // unnecessary rewrite cycle). Render the tool's own result fields
        // (calendarReads.ts handleSetWorkScheduleOverride) instead of guessing
        // from input (G2) — EXCEPT `note` (see below). FAILED (owner_only /
        // bad_date / bad_range / nothing_to_set) is already handled by the
        // generic error-string check at the top of this function — those are
        // all `{ error: '<code>' }`.
        //
        // gh#200 (recheck, 200b) — a note-ONLY override is a legal success on
        // its own (calendarReads.ts:684 lets `note` alone satisfy
        // `nothing_to_set`), but `note` isn't in the handler's success result
        // (calendarReads.ts:710-718 — only handleGetWorkScheduleOverrides
        // echoes it back, :737), so this case rendered an EMPTY detail for a
        // real success. `note` is the one field safe to read from `input`
        // instead of `result`: the handler persists it unchanged (only a
        // `.trim()`, calendarReads.ts:678,699) with no validation branch that
        // can drop or alter it the way hours/off can — once `success:true`
        // confirms the write, `input.note` IS the persisted value, not a guess.
        const r = result as {
          dates?: unknown; cleared?: number;
          off?: boolean; hours?: unknown; location?: string; timezone?: string;
        };
        const dates = Array.isArray(r.dates) ? (r.dates as string[]) : [];
        const range = dates.length > 1
          ? `${dates[0]}→${dates[dates.length - 1]} (${dates.length}d)`
          : (dates[0] ?? '');
        if (typeof r.cleared === 'number') {
          return `[set_work_schedule_override OK — cleared ${range}]`;
        }
        const parts: string[] = [];
        if (r.off) parts.push('off=true');
        if (Array.isArray(r.hours) && r.hours.length) parts.push(`hours=${(r.hours as string[]).join(',')}`);
        if (r.location) parts.push(`location=${r.location}`);
        if (r.timezone) parts.push(`tz=${r.timezone}`);
        const note = typeof input.note === 'string' ? input.note.trim() : '';
        if (note) parts.push(`note="${note.replace(/\s+/g, ' ').slice(0, 80)}"`);
        const detail = parts.length ? `: ${parts.join(' ')}` : '';
        return `[set_work_schedule_override OK — ${range}${detail}]`;
      }
      default: {
        // Generic: just tool name + first key-value
        const firstKey = Object.keys(input)[0];
        const firstVal = firstKey ? String(input[firstKey]).slice(0, 40) : '';
        return `[${toolName}${firstKey ? `: ${firstKey}=${firstVal}` : ''}]`;
      }
    }
  } catch {
    return `[${toolName}]`;
  }
}

// v2.2.5 — Action tape. Scans the assistant turns in this thread's conversation
// history for successful mutation tool summaries (the `[<tool> OK ...]` markers
// emitted by summarizeToolCall above) and pins them at the top of the system
// prompt as a fact block. Replaces the prompt-rule attempts (RULE 2e in
// systemPrompt.ts and the calendarHealth "RULE 2e principle" reference) which
// kept rotting — Sonnet ignores rules but can't ignore pinned data.
//
// Failed mutations (`[<tool> FAILED ...]`) are intentionally excluded — only
// confirmed successes belong on the tape. The closing line acknowledges the
// tool-trust gap (Graph can return OK on a write that didn't actually land):
// when the owner pushes back, Maelle re-checks instead of insisting.
const MUTATION_OK_RE = /\[(?:create_meeting|move_meeting|update_meeting|delete_meeting|book_floating_block) OK[^\]]*\]/g;

function extractActionTape(history: Array<{ role: 'user' | 'assistant'; content: string }>): string[] {
  const out: string[] = [];
  for (const msg of history) {
    if (msg.role !== 'assistant') continue;
    const matches = msg.content.match(MUTATION_OK_RE);
    if (matches) out.push(...matches);
  }
  return out.slice(-20);
}

// #131 — stamp each PRIOR user message with the absolute time it was sent, in
// owner-local time, so the model anchors relative words ("tomorrow", "today")
// to WHEN they were said, not to the current turn's "now". Without this a
// message read a day later re-resolves "tomorrow" against the new today (Dina's
// Sunday "tomorrow"=Monday silently became Tuesday on Monday). Slack gives a `ts`
// on every message; the system prompt's "now" still anchors the live turn, so we
// stamp history only. Fails open to the raw content on any bad/absent ts.
function stampHistoryTime(content: string, ts: string | undefined, tz: string): string {
  if (!ts) return content;
  const secs = parseFloat(ts);
  if (!Number.isFinite(secs)) return content;
  try {
    const when = DateTime.fromSeconds(secs).setZone(tz);
    if (!when.isValid) return content;
    return `[${when.toFormat('EEE d MMM, HH:mm')}] ${content}`;
  } catch {
    return content;
  }
}

export {
  callClaude,
  trimHistory,
  mutationOutcome,
  summarizeToolCall,
  summarizeInternalAction,
  extractActionTape,
  stampHistoryTime,
};
