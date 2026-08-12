/**
 * Pure module-level helpers extracted (v3.7.x) verbatim from ops.ts. No logic
 * changes — only relative import paths deepened by one level for the new
 * ops/ subdirectory. `buildOutOfHoursBusy` is live (used by the switch cases in
 * ops.ts); the other two feed action_summary / vacated-slot formatting.
 */
import { DateTime } from 'luxon';
import logger from '../../../utils/logger';
import { PRIVATE_MASK } from '../../../utils/displaySubject';

// Local alias for the profile type without adding another import — re-use the
// one imported below. Ts hoists type-only imports so this works.
type UserProfileType = import('../../../config/userProfile').UserProfile;

/**
 * v4.1.x (M4) — the plan's complete set of open questions, shaped for a tool
 * result. planMeeting now evaluates EVERY gate it can before returning, so a
 * booking that needs both a location decision and an attendee-conflict
 * acknowledgement carries both here instead of costing two round-trips. Emitted
 * only when there is more than one — a single question is already fully carried
 * by `suggested_ask_text`, and a one-element array would just be noise in the
 * payload. ONE helper, called from every gate-bearing return in create/move, so
 * the two handlers can't drift.
 */
export function openQuestionsField(
  openQuestions: string[] | undefined,
): { open_questions?: string[]; _ask_all_at_once?: string } {
  if (!openQuestions || openQuestions.length < 2) return {};
  return {
    open_questions: openQuestions,
    _ask_all_at_once: `This booking needs ${openQuestions.length} things answered. Ask them ALL in ONE message (open_questions lists them) and wait for one reply — do NOT ask them one at a time across separate turns. Once answered, re-call with every answer applied together.`,
  };
}

/**
 * Owner, 2026-07-26: "if he asked thursday, its thursday. if no options you
 * can suggest to wide the search and offer more.. but thursday ask is
 * thursday". The three shapes a proposed-alternatives payload can take, in the
 * order the reply must present them. The split lives in the DATA — two separate
 * arrays on the tool result, filled by planMeeting — and this only tells the
 * model what the two arrays mean, so a widening is never narrated as if it were
 * what the person asked for. ONE helper, both gate-bearing handlers, so
 * create and move cannot drift.
 */
export function alternativesNote(
  requestedDay: string,
  onRequestedDay: number,
  otherDays: number,
): string {
  if (onRequestedDay === 0) {
    return `Nothing on ${requestedDay} itself clears his rules — \`alternatives_on_requested_day\` is EMPTY. Say that plainly first ("nothing works on <that day>"), then OFFER to widen and present \`alternatives_other_days\` as exactly that: later days you looked at because their day had nothing. Do NOT present them as if they were what was asked for, and do NOT quietly drop the fact that their own day came up empty.`;
  }
  if (otherDays === 0) {
    return `\`alternatives_on_requested_day\` holds every option on ${requestedDay}, the day they asked for. Offer those and ask if one works.`;
  }
  return `Lead with \`alternatives_on_requested_day\` — those are on ${requestedDay}, the day they asked for, and they are the answer. \`alternatives_other_days\` is the widening: ${requestedDay} ran out at ${onRequestedDay} option${onRequestedDay === 1 ? '' : 's'}, so offer those separately and label them as other days ("...and if you can go later in the week, I also have..."). Two groups, never one merged list.`;
}

/**
 * Owner, 2026-07-26 (*"ok record"*) — a proposed alternative IS an offer, so
 * it goes into the same per-turn offered-slot stash the search path writes.
 *
 * `propose_alternative` never recorded, so times Maelle said out loud existed
 * only as prose: a colleague replying "the Sunday one works" hit
 * `slot_not_offered` on hold_slot (calendarReads.ts), and the next-turn binding
 * block — the thing that stops a bare "Sunday 11:00" being re-derived onto the
 * wrong week — had nothing to bind to. Nothing is HELD by this: no calendar
 * time is blocked and no new persistence is introduced; the stash is the
 * existing in-memory, TTL'd, per-conversation map.
 *
 * BOTH lists are recorded. They were both said aloud, so a pick from either has
 * to bind, and the requested-day / widened distinction is a narration split, not
 * a difference in whether the time was offered.
 *
 * `searchFingerprint` is deliberately omitted: these alternatives came from
 * planMeeting's own nearby-search, not from a requester-shaped
 * find_available_slots call. Omitting preserves whatever fingerprint a real
 * search left (offeredSlotsStash's preserve-on-omit), so the "give me another
 * option" exclusion keeps comparing like with like.
 *
 * ONE helper, both gate-bearing handlers, so create and move cannot drift.
 */
export function recordProposedAlternatives(params: {
  channelId?: string;
  threadTs?: string;
  timezone: string;
  alternatives: Array<{ start: string }>;
  widenedAlternatives: Array<{ start: string }>;
}): void {
  if (!params.channelId) return;
  const slots = [...params.alternatives, ...params.widenedAlternatives];
  if (slots.length === 0) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordOfferedSlots } = require('../../../utils/offeredSlotsStash') as
      typeof import('../../../utils/offeredSlotsStash');
    recordOfferedSlots({
      channelId: params.channelId,
      threadTs: params.threadTs,
      timezone: params.timezone,
      slots,
    });
  } catch (err) {
    logger.warn('recordProposedAlternatives — stash write failed, continuing', {
      err: String(err).slice(0, 150),
    });
  }
}

/**
 * gh#wrong-event-moved-move-meeting (2026-08-12) — the last check before a
 * move/update/delete PATCH lands on the WRONG event. `meeting_id` is resolved
 * upstream (a prior search, or the model's own read of the calendar); when
 * that resolution is wrong — find_available_slots handed back an id that
 * belonged to a DIFFERENT event ("Donnie Time", a personal block) than the
 * one it was searching for ("Yael & Idan Weekly") — nothing checked that the
 * id and the CLAIMED subject (`args.meeting_subject`, read off the SAME
 * calendar) describe the same meeting before the mutation. Deliberately
 * LENIENT — normalized equality, containment, or one shared non-trivial word
 * all pass — because the two strings are almost always the SAME string read
 * twice; the bar is only to catch a CLEAR mismatch (zero shared content),
 * never to second-guess a real rename or a punctuation/case difference (M4 —
 * don't manufacture a re-ask over a title that merely differs cosmetically).
 * Structural string normalization only (Unicode-aware, no meaning extraction)
 * — same class as the exact-match subject comparisons already used by
 * findDuplicateEvent / findSameSubjectSiblings, just widened to "plausible"
 * for a comparison that must never falsely refuse a real match.
 */
export function subjectsPlausiblyMatch(claimed: string, actual: string): boolean {
  // o#216 (bouncer fix, 2026-08-12) — a claimed subject that IS the privacy
  // mask literal is not a real claim to compare. On a room turn, the email
  // leg, or a non-attendee colleague DM, get_calendar itself only ever hands
  // back `[Private]` for a masked event (displaySubject.ts) — the caller
  // structurally cannot know the real title there, so comparing that mask
  // against the probe's real subject would always find zero shared content
  // and falsely refuse a legitimate move/update/cancel forever (the
  // refusal's own "re-read the calendar and retry" instruction returns the
  // same mask again — it can't self-heal). This also covers replay: a
  // room-origin approved action's `_deferred_action_hint` stores this same
  // masked claim verbatim, so without this check an owner-approved move
  // would refuse again at replay time. Other gates already own authority on
  // those surfaces — this guard has nothing meaningful to check when the
  // claim itself is only ever the mask.
  if (claimed.trim() === PRIVATE_MASK) return true;
  const norm = (s: string): string =>
    s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(claimed);
  const b = norm(actual);
  if (!a || !b) return true;  // nothing to compare against — don't block on missing data
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const wordsA = new Set(a.split(' ').filter(w => w.length >= 3));
  return b.split(' ').some(w => w.length >= 3 && wordsA.has(w));
}

/**
 * meeting-title-minimum-descriptiveness-required (2026-08-12) — owner ruling,
 * prompted by subjectsPlausiblyMatch's own short-token edge case above (a
 * title made only of initials/very-short words has no comparable content
 * left there and always reads as a mismatch). Rather than make the matcher
 * tolerate short titles, don't let one get BOOKED in the first place —
 * enforced at create_meeting (createMeeting.ts) only; this does not, and
 * cannot, rename an existing short-titled meeting already on the calendar.
 * Same Unicode-aware structural normalization as subjectsPlausiblyMatch —
 * meaning is never inspected, only shape.
 *  - empty/whitespace-only → not descriptive.
 *  - every token reduces to a single character ("J D", "J.D.K.") → initials-
 *    only, not descriptive, even if the combined length would otherwise clear
 *    the floor below (e.g. 3 single-letter initials).
 *  - fewer than 3 total letter/number characters once punctuation and
 *    whitespace are stripped → not descriptive (catches "JS", "Hi", "Q&A"'s
 *    stripped form "QA", etc).
 */
export function isDescriptiveSubject(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const tokens = trimmed
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.every(t => t.length === 1)) return false;  // initials-only
  const meaningfulChars = tokens.join('').length;
  return meaningfulChars >= 3;
}

/**
 * revert-intent-and-single-step-undo-scope, piece 4 (2026-08-12) — the
 * target identity a `logActivity` call attaches to a calendar mutation.
 * Owner ruling: whichever identifying signal a later revert-by-description
 * ask actually has (a name, a subject, conversational recency) should
 * already be on the row — broadens capture from "only a resolved REQUESTER"
 * (moveMeeting.ts's pre-existing findMeetingOwner-only signal) to "any
 * attendee already in scope at mutation time, resolved against
 * people_memory."
 *
 * `preferred` — a more precise signal already resolved by the caller (e.g.
 * findMeetingOwner's verified requester) — wins outright and is never
 * overridden by a weaker roster guess. Falls back to the first
 * `attendeeEmails` entry (in roster order, owner excluded) that resolves to
 * a people_memory row carrying a slack_id. Fail-soft, same posture as
 * logActivity itself: a lookup hiccup returns {} and never throws, so it can
 * never block the mutation it's attached to.
 *
 * bouncer fix (2026-08-12) — the roster fallback used to be its own
 * `searchPeopleMemory(email).find(exact match)` scan, which has no
 * preference between duplicate rows for the same human: `people_memory`
 * legitimately holds a calendar-sourced row (slack_id NULL) alongside a
 * later Slack-sourced row for the same email (the "Luke Joas bug", see
 * resolveAttendeeEmails.ts:195-203), and whichever came back first/most-
 * recently could be the NULL-slack_id one — silently abandoning capture for
 * an attendee who is in fact resolvable. `getPersonByEmail` is the
 * established fix for exactly this (already used the same way at
 * tasks/briefs.ts:18 and resolveAttendeeEmails.ts:174): its query orders by
 * `(slack_id IS NOT NULL) DESC` so the populated row always wins. Call it
 * directly instead of re-implementing the scan.
 *
 * Also: when `preferred` carries an id but no name (findMeetingOwner can
 * return a requester_slack_id with a NULL requester_name,
 * findMeetingOwner.ts:86-95), backfill the name from people_memory via the
 * slack_id rather than leaving the activity row nameless — the revert
 * tool's wording matches by name, so a resolvable-but-blank name is a
 * silent capture gap, not a genuine "no name available" case.
 */
export function resolveActivityTargetIdentity(params: {
  attendeeEmails: Array<string | undefined | null>;
  ownerEmail: string;
  preferred?: { targetSlackId?: string | null; targetName?: string | null };
}): { targetSlackId?: string; targetName?: string } {
  if (params.preferred?.targetSlackId) {
    const targetSlackId = params.preferred.targetSlackId;
    let targetName = params.preferred.targetName ?? undefined;
    if (!targetName) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { personIdForSlackId, getPersonById } = require('../../../db/people') as
          typeof import('../../../db/people');
        const personId = personIdForSlackId(targetSlackId);
        const person = personId ? getPersonById(personId) : null;
        targetName = person?.name ?? undefined;
      } catch (err) {
        logger.warn('resolveActivityTargetIdentity — name backfill lookup threw, leaving name unresolved', {
          err: String(err).slice(0, 160),
        });
      }
    }
    return { targetSlackId, targetName };
  }
  const ownerLower = params.ownerEmail.toLowerCase();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPersonByEmail } = require('../../../db/people') as typeof import('../../../db/people');
    for (const raw of params.attendeeEmails) {
      const email = (raw ?? '').toLowerCase().trim();
      if (!email || email === ownerLower) continue;
      const hit = getPersonByEmail(email);
      if (hit?.slack_id) {
        return { targetSlackId: hit.slack_id, targetName: hit.name ?? undefined };
      }
    }
  } catch (err) {
    logger.warn('resolveActivityTargetIdentity — people_memory lookup threw, leaving target unresolved', {
      err: String(err).slice(0, 160),
    });
  }
  return {};
}

// v1.8.3 — extract "HH:MM" from an ISO datetime string for action_summary
// formatting. Falls back to the raw string if the shape is unexpected.
export function formatIsoTime(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

// v3.2.1 (#120 / 120b) — the VACATED slot of a move: the window the meeting
// occupied BEFORE it moved, so a follow-up "move X into the freed slot"
// resolves from this turn instead of Maelle re-asking the old time. Window =
// old start + the moved duration. ONE helper, called from BOTH move return
// sites (the regular-meeting tail AND the floating-block early return) so the
// two paths can never drift apart — both must return `vacated`, otherwise
// moving lunch to free its slot drops the freed-slot info entirely.
export function computeVacatedSlot(
  preMoveStartIso: string | undefined,
  newStartIso: string | undefined,
  newEndIso: string | undefined,
  timezone: string,
): { start: string; end: string; label: string } | undefined {
  if (!preMoveStartIso) return undefined;
  const vs = DateTime.fromISO(preMoveStartIso, { zone: timezone });
  if (!vs.isValid) return undefined;
  const ns = newStartIso ? DateTime.fromISO(newStartIso, { zone: timezone }) : undefined;
  const ne = newEndIso ? DateTime.fromISO(newEndIso, { zone: timezone }) : undefined;
  const durMs = ns?.isValid && ne?.isValid ? ne.toMillis() - ns.toMillis() : 0;
  const ve = durMs > 0 ? vs.plus({ milliseconds: durMs }) : vs;
  return {
    start: vs.toISO() ?? preMoveStartIso,
    end: ve.toISO() ?? '',
    label: `${vs.toFormat('EEE d MMM HH:mm')}–${ve.toFormat('HH:mm')}`,
  };
}

// v2.1.5 — build synthetic busy blocks covering everything OUTSIDE the owner's
// work hours (and all-day busy for non-work days) across the given range. Used
// only for colleague-path get_free_busy calls so raw free gaps returned to
// Sonnet never include out-of-hours time. Rule enforcement in code — the LLM
// literally cannot narrate a 09:00 slot to a colleague when office day starts
// 10:30 because that window is no longer present as "free" in the data.
export function buildOutOfHoursBusy(
  startDate: string,
  endDate: string,
  profile: UserProfileType,
  timezone: string,
): Array<{ start: string; end: string; status: 'oof' }> {
  const blocks: Array<{ start: string; end: string; status: 'oof' }> = [];
  const rangeStart = DateTime.fromISO(startDate, { zone: timezone });
  const rangeEnd = DateTime.fromISO(endDate, { zone: timezone });
  if (!rangeStart.isValid || !rangeEnd.isValid) return blocks;
  // v3.7.x (#143) — per-date effective day: office/home identity + work-hour
  // windows come from a chat override when one exists for that date, else the
  // yaml base. So a day off / custom hours / office↔home override reshapes the
  // OOF blocks a colleague sees, consistent with find_available_slots.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getEffectiveWorkDay } = require('../../../utils/workHours') as
    typeof import('../../../utils/workHours');
  for (let d = rangeStart.startOf('day'); d <= rangeEnd; d = d.plus({ days: 1 })) {
    const eff = getEffectiveWorkDay(d.toFormat('yyyy-MM-dd'), profile);
    const dayStart = d.startOf('day');
    const dayEnd = d.endOf('day');
    if (!eff.isWorkday || eff.windows.length === 0) {
      // Non-work day (or an override day off / no windows) — block the whole day.
      blocks.push({
        start: dayStart.toISO() ?? `${d.toISODate()}T00:00:00`,
        end: dayEnd.toISO() ?? `${d.toISODate()}T23:59:59`,
        status: 'oof',
      });
      continue;
    }
    // v2.8.1 — build OOF blocks for every gap around the day's work-hour
    // windows: 00:00 → first window start, between windows, last window end →
    // 23:59. Multi-window aware (Tuesday "09:00-15:30" + "21:30-23:59" leaves
    // an OOF block 15:30-21:30 in the middle).
    const wins = eff.windows;
    // Morning block: 00:00 → first window start.
    if (wins[0].startMin > 0) {
      const morningEnd = dayStart.plus({ minutes: wins[0].startMin });
      blocks.push({
        start: dayStart.toISO() ?? `${d.toISODate()}T00:00:00`,
        end: morningEnd.toISO() ?? `${d.toISODate()}T00:00:00`,
        status: 'oof',
      });
    }
    // Between-windows gaps.
    for (let i = 0; i < wins.length - 1; i++) {
      const gapStart = dayStart.plus({ minutes: wins[i].endMin });
      const gapEnd = dayStart.plus({ minutes: wins[i + 1].startMin });
      blocks.push({
        start: gapStart.toISO() ?? `${d.toISODate()}T00:00:00`,
        end: gapEnd.toISO() ?? `${d.toISODate()}T00:00:00`,
        status: 'oof',
      });
    }
    // Evening block: last window end → end of day.
    const lastEnd = wins[wins.length - 1].endMin;
    if (lastEnd < 24 * 60) {
      const eveningStart = dayStart.plus({ minutes: lastEnd });
      blocks.push({
        start: eveningStart.toISO() ?? `${d.toISODate()}T00:00:00`,
        end: dayEnd.toISO() ?? `${d.toISODate()}T23:59:59`,
        status: 'oof',
      });
    }
  }
  return blocks;
}
