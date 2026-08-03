import { DateTime } from 'luxon';
import logger from '../../utils/logger';
import { getClient } from './graphClient';
import type { CalendarEvent, FreeBusySlot, VerifyResult } from './calendarTypes';

/**
 * Single chokepoint for parsing Graph getSchedule's scheduleItems.
 * Graph returns dateTimes as UTC wall-clock strings WITHOUT an explicit
 * offset suffix, regardless of the timeZone field set in the request.
 * We parse as UTC, re-zone to the caller's requested zone, and emit an
 * ISO string that includes the offset — so the TZ context is encoded
 * in the data itself, not lost in transit.
 */
export function parseGraphFreeBusySlot(item: any, requestedTz: string): FreeBusySlot {
  const start = DateTime.fromISO(item.start.dateTime, { zone: 'utc' })
    .setZone(requestedTz);
  const end = DateTime.fromISO(item.end.dateTime, { zone: 'utc' })
    .setZone(requestedTz);
  return {
    start: start.isValid ? start.toISO()! : item.start.dateTime,
    end: end.isValid ? end.toISO()! : item.end.dateTime,
    status: item.status,
    _timezone: requestedTz,
  };
}

// ── Calendar reads ────────────────────────────────────────────────────────────

// ── Date helpers ──────────────────────────────────────────────────────────────


/**
 * Graph calendarView: startDateTime/endDateTime are ALWAYS interpreted as UTC
 * unless they include an explicit timezone offset. The Prefer header only changes
 * how RETURNED event times are formatted — it does NOT affect the query window.
 *
 * Fix: use Luxon to produce a full ISO string with offset, e.g. "2025-04-14T00:00:00+03:00"
 * so Graph uses the correct local midnight, not UTC midnight.
 */
// The yyyy-MM-dd prefix of a date/ISO string. Guards a missing/blank arg:
// an undefined start_date/end_date reaching here used to crash the WHOLE
// calendar query (`undefined.split('T')` → TypeError, surfaced to the owner as
// "trouble pulling up the calendar", 2026-07-13). A missing date now degrades
// to "today" in the mailbox zone instead of throwing — so every caller of
// getCalendarEvents / getFreeBusy is protected at this one chokepoint, not
// per-handler.
function datePart(dateStr: string | undefined | null, timezone: string): string {
  if (!dateStr || !dateStr.trim()) return DateTime.now().setZone(timezone).toISODate()!;
  return dateStr.split('T')[0];
}

function toStartOfDayLocal(dateStr: string | undefined | null, timezone: string): string {
  // Convert to UTC so the value ends in Z — passing +HH:00 in a query param encodes + as space
  return DateTime.fromISO(`${datePart(dateStr, timezone)}T00:00:00`, { zone: timezone })
    .toUTC()
    .toISO({ suppressMilliseconds: true })!;
}

function toEndOfDayLocal(dateStr: string | undefined | null, timezone: string): string {
  return DateTime.fromISO(`${datePart(dateStr, timezone)}T23:59:59`, { zone: timezone })
    .toUTC()
    .toISO({ suppressMilliseconds: true })!;
}

export type SpreadSlot = {
  start: string;
  disturbs_floating_block?: boolean;
  over_optional?: string;
};

// A slot's start read in the caller's zone. The ISO itself is offset-bearing
// (the walker emits `cursorLocal.toISO()`), so the instant never depends on the
// server clock — only the rendering zone does (M13).
//
// It used to consult a per-slot `away_tz` override. That field had NO producer
// anywhere in the tree — the walker never emitted it — and round 3 carried it
// into the newly-shared type along with a docstring about trip-tz days, which
// described behaviour that could not occur. Deleted rather than implemented:
// away days are per-date schedule overrides now (#143) and are walked in their
// own zone, so a slot's emitted ISO already carries the right offset.
function slotZonedStart(slot: SpreadSlot, timezone: string): DateTime {
  return DateTime.fromISO(slot.start).setZone(timezone);
}

/**
 * The local day a slot belongs to, in the caller's zone.
 *
 * Exported because "which day is this slot on" is asked in two places: the
 * spreader's own grouping, and the caller that has to say which picks landed on
 * the day the requester actually named. One definition, so the split and
 * the pick order can never disagree about what "Thursday" means.
 */
export function slotLocalDay(slot: SpreadSlot, timezone: string): string {
  return slotZonedStart(slot, timezone).toFormat('yyyy-MM-dd');
}

/**
 * Spread rules:
 *   • At most `count` total — the caller's offered-slot budget
 *     (profile.meetings.offered_slot_count via offeredSlotCount). REQUIRED:
 *     the old `count = 5` default was a second, silent bound competing with
 *     the config (M6).
 *   • ≥1h gap between same-day picks (relaxed on the final fill pass)
 *   • Day-diversity first — one pick per day per round, then depth
 *
 * Day walk order — `anchorMode` decides, and the two modes are genuinely
 * different products, which is why the argument exists instead of a default
 * that quietly serves one caller badly:
 *   • 'first_round' (default) — the MOVE shape. The anchor day picks FIRST in
 *     each round, then the rest chronologically, but every day still gets at
 *     most one pick per round. Diversity is the point: the meeting is being
 *     moved, so "the day it currently sits on" is a preference, never the ask.
 *   • 'exhaustive' — the REQUESTED-DAY shape (owner 2026-07-26: "if he
 *     asked thursday, its thursday"). The anchor day is drained through the
 *     FULL tier ladder — gapped, then optional-tier, then relaxed-gap — up to
 *     the whole budget, before any other day is considered at all. Other days
 *     only appear once the requested day is exhausted or empty, and the caller
 *     is expected to present them as an explicit widening (use `slotLocalDay`
 *     to split the return).
 *   • No `anchorDay` → pure chronological, both modes identical.
 *
 * Within each day: walk the day's candidates chronologically, taking each one
 * that clears the ≥1h gap (and the duration non-overlap guard) against every
 * already-chosen slot.
 *
 * Returns 1 or 2 slots if that's all the candidate list yields — caller's
 * search window may legitimately be narrow (e.g. owner asked "today between
 * 14:00 and 17:00"). Don't widen silently; just return what's there.
 *
 * Output: chronological regardless of internal day walk order.
 */
export function pickSpreadSlots(
  slots: SpreadSlot[],
  timezone: string,
  count: number,
  anchorDay?: string,
  // When set, no two returned slots start within `durationMinutes` of each
  // other (a later start landing inside an earlier slot is never a useful
  // option). Omitted → no overlap guard.
  durationMinutes?: number,
  anchorMode: 'first_round' | 'exhaustive' = 'first_round',
): string[] {
  const MIN_GAP_HOURS = 1;

  const chosen: string[] = [];
  const chosenDts: DateTime[] = [];
  // Identity dedupe. The gap / duration guards already reject a re-pick of an
  // already-chosen start in every tier that HAS a guard — but the relaxed-gap
  // tier runs with neither when `durationMinutes` is omitted, and the
  // 'exhaustive' pre-pass deliberately walks the anchor day twice (once alone,
  // once inside the full pool). One Set makes a duplicate impossible either way.
  const chosenStarts = new Set<string>();

  // Fill `chosen` (up to `count`) from ONE tier of candidates, round-robin by
  // day: round 1 takes the first viable slot from EACH day (maximize distinct
  // days), round 2 a second from each (≥1h from that day's prior pick, no
  // overlapping start), and so on. Diversity first, then depth. Respects the
  // ≥1h / duration gap against slots ALREADY chosen (by an earlier tier), so a
  // later tier never lands on top of an earlier-tier pick. This is the SINGLE
  // spreader for the regular, Working-Elsewhere-travel, and optional-join paths.
  const fillFrom = (pool: typeof slots, relaxGap = false) => {
    if (chosen.length >= count || pool.length === 0) return;
    // Group candidates by their local day in the caller's zone.
    const byDay = new Map<string, Array<{ start: string; dt: DateTime; disturbs: boolean }>>();
    for (const s of pool) {
      const dt = slotZonedStart(s, timezone);
      const day = dt.toFormat('yyyy-MM-dd');
      let bucket = byDay.get(day);
      if (!bucket) { bucket = []; byDay.set(day, bucket); }
      bucket.push({ start: s.start, dt, disturbs: s.disturbs_floating_block === true });
    }
    // v3.2.6 (RC1) — within each day, prefer slots that DON'T disturb a floating
    // block (lunch). Stable sort keeps chronological order inside each group.
    for (const bucket of byDay.values()) {
      bucket.sort((a, b) => (a.disturbs ? 1 : 0) - (b.disturbs ? 1 : 0));
    }
    const allDays = [...byDay.keys()].sort();
    const dayOrder = (anchorDay && byDay.has(anchorDay))
      ? [anchorDay, ...allDays.filter(d => d !== anchorDay)]
      : allDays;
    const cursor = new Map<string, number>();   // next unscanned index per day
    let progressed = true;
    while (chosen.length < count && progressed) {
      progressed = false;
      for (const day of dayOrder) {
        if (chosen.length >= count) break;
        const bucket = byDay.get(day)!;
        let i = cursor.get(day) ?? 0;
        for (; i < bucket.length; i++) {
          const { start, dt } = bucket[i];
          if (chosenStarts.has(start)) continue;
          // ≥1h from anything already chosen. Only same-day picks can ever be
          // <1h away (cross-day diffs are far larger), so scanning the whole set
          // is safe and cheap.
          if (!relaxGap && chosenDts.some(c => Math.abs(dt.diff(c, 'hours').hours) < MIN_GAP_HOURS)) continue;
          if (durationMinutes && durationMinutes > 0
            && chosenDts.some(c => Math.abs(dt.diff(c, 'minutes').minutes) < durationMinutes)) continue;
          chosen.push(start);
          chosenStarts.add(start);
          chosenDts.push(dt);
          i++;                       // consume this slot before recording the cursor
          progressed = true;
          break;                     // one pick per day per round
        }
        cursor.set(day, i);
      }
    }
  };

  // v3.6.4 — TIER: clean slots FIRST. An optional-join (WE-soft) slot never
  // surfaces while clean slots satisfy the spread; only if the clean tier comes
  // up short do we complete the quota from WE-soft (each tagged "over your
  // optional …"). Explicit priority: clean › book-over-optional (M3). (The
  // relaxed recovery — break a real rule — is a separate, lower tier upstream.)
  //
  // #Ayala (2026-07-23) — the third pass is the RELAXED FILL. The ≥1h spread gap
  // is right for diverse options across a week, but when the only clean slots
  // are clustered in one narrow band (e.g. the single ET-afternoon window
  // overlapping the owner's day for two ET attendees), it strands real openings
  // and returns just ONE. If the spread came up short, fill the rest from the
  // same clean slots WITHOUT the 1h gap — the durationMinutes non-overlap guard
  // still blocks overlapping starts, so these stay genuine, bookable options
  // (21:15 + 21:45, not just 21:15).
  const runTiers = (pool: SpreadSlot[]) => {
    fillFrom(pool.filter(s => !s.over_optional));
    fillFrom(pool.filter(s => !!s.over_optional));
    if (chosen.length < count) fillFrom(pool.filter(s => !s.over_optional), true);
  };

  // 'exhaustive' runs the SAME ladder over the requested day alone first,
  // so that day is filled to the budget (including the relaxed-gap depth) before
  // any other day is looked at. Not a second spreader: one ladder, run over a
  // narrower pool. When the anchor day has nothing, both passes see the same
  // pool and the behaviour is identical to 'first_round'.
  if (anchorDay && anchorMode === 'exhaustive') {
    runTiers(slots.filter(s => slotLocalDay(s, timezone) === anchorDay));
  }
  runTiers(slots);

  // Output chronological regardless of round-robin order.
  chosen.sort((a, b) => DateTime.fromISO(a).toMillis() - DateTime.fromISO(b).toMillis());
  return chosen;
}

/**
 * How fresh a calendar read has to be. THREE states, because the old boolean
 * could not express the one that matters: a read whose answer becomes a
 * COMMITMENT must never be served from the cross-turn warm copy, yet it must
 * still dedupe inside a single turn.
 *
 *   'cached' — a warm cross-turn copy (≤ CALENDAR_CACHE_TTL_SECONDS) is fine.
 *              Reading the calendar OUT: get_calendar, analyze_calendar, brief,
 *              news, the turn context, narration. Nothing is decided from it.
 *   'live'   — never the cross-turn copy. Per-turn memo, then Graph. EVERY read
 *              a scheduling decision rests on — reached through
 *              `getOwnerEventsForDecision` / `getFreeBusyForDecision`, never by
 *              a call site remembering a flag. A proposal is a commitment:
 *              offering a slot that was taken three minutes ago is the failure
 *              this state exists to remove, and no tool wording can substitute.
 *   'force'  — neither cache. "Go and look" (get_calendar's force_refresh), and
 *              the one internal retry that must escape a memoized rejection.
 */
export type ReadFreshness = 'cached' | 'live' | 'force';

export async function getCalendarEvents(
  userEmail: string,
  startDate: string,
  endDate: string,
  timezone: string = 'UTC',
  freshness: ReadFreshness = 'cached',
): Promise<CalendarEvent[]> {
  // Key on the window Graph is ACTUALLY asked for, not on the strings the caller
  // happened to write. calendarView is always queried as whole local days, so
  // '2026-07-28', '2026-07-28T10:00:00' and '2026-07-28T23:59:00.000+03:00' are
  // ONE query — and used to be three cache entries. That was not merely waste, it
  // broke invalidation in both directions: get_calendar's forced refresh
  // repopulated its own spelling while the slot finder went on reading a
  // different entry (logs/maelle-2026-07-27.log:553 fetched 12 events for exactly
  // the window :488 had fetched 11 from; the finder's next pass at :559 still
  // answered from the 11-event copy, a byte-identical rejection breakdown), and
  // one day could hold several disagreeing copies at once. One window, one entry.
  // The normalization has to happen HERE rather than inside the impl: the key and
  // the query must be derived from the same pair.
  const cleanStart = toStartOfDayLocal(startDate, timezone);
  const cleanEnd = toEndOfDayLocal(endDate, timezone);
  const cacheKey = `getCalendarEvents|${userEmail}|${cleanStart}|${cleanEnd}|${timezone}`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cache = require('./calendarCache') as typeof import('./calendarCache');

  // v3.2.x (#121) — cross-turn cache (default 300s TTL, write-invalidated).
  // 'force' → straight to Graph, then repopulate so the warm copy is fresh.
  if (freshness === 'force') {
    const data = await getCalendarEventsImpl(userEmail, cleanStart, cleanEnd, timezone);
    cache.setCachedEvents(cacheKey, data);
    return data;
  }
  if (freshness === 'cached') {
    const cached = cache.getCachedEvents<CalendarEvent[]>(cacheKey);
    if (cached) return cached;
  }

  // v2.4.3 (A3) — per-turn memoization: concurrent or repeat callers within ONE
  // turn share a single in-flight fetch. This is the only layer a 'live' read may
  // use, and it is the scope where "the calendar isn't moving under her" is
  // actually true. It also repopulates the cross-turn copy, so the readers that
  // ARE allowed a warm one get the fresher data. Outside a turn (background
  // tasks) memoize bypasses and just fetches.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { memoize } = require('../../utils/turnCache') as typeof import('../../utils/turnCache');
  return memoize(cacheKey, async () => {
    const data = await getCalendarEventsImpl(userEmail, cleanStart, cleanEnd, timezone);
    cache.setCachedEvents(cacheKey, data);
    return data;
  });
}

/**
 * Owner, 2026-07-26: "refuse all booking 'idan calendar is offline'".
 *
 * Thrown when the owner's own calendar cannot be read at all. It is NOT
 * "he's busy" and it is NOT "nothing fits" — it means Maelle is blind, and a
 * blind scheduler must refuse rather than guess. The whole reason it is a typed
 * error and not a `[]` is that an empty event list is indistinguishable from a
 * completely free calendar: every rule in checkSlot then passes, every slot
 * reads open, and the search / booking paths hand back confident nonsense.
 */
export class CalendarOfflineError extends Error {
  constructor(public readonly detail: string) {
    super(`Owner calendar unreadable: ${detail}`);
    this.name = 'CalendarOfflineError';
  }
}

/**
 * isOutageShaped — THE taxonomy behind "his calendar is offline". A POSITIVE
 * predicate: a fault becomes `CalendarOfflineError` only when it is evidence
 * that the transport or the service is down. Everything else keeps its own
 * honest failure and travels up unchanged.
 *
 * The outage refusal shipped the wrapper without one, so
 * `getOwnerEventsForDecision` and the slot walker wrapped whatever they caught.
 * That turned a 403 `ErrorAccessDenied`
 * on the owner's own calendarView (a tenant-consent problem), a 404 from a wrong
 * `profile.user.email`, a 400 from a malformed window, and our own TypeErrors all
 * into "I can't reach his calendar right now — try again shortly": advice that
 * cannot help, for a cause that is wrong. A wrong reason misleads the very
 * decision it exists to inform (M11), and none of those four get better on a
 * retry.
 *
 * IN — the fault is in the pipe or the service:
 *   • HTTP 5xx            — Graph itself failed.
 *   • HTTP 429            — throttled; "try again shortly" is literally the fix.
 *   • HTTP 408            — the request timed out in transit.
 *   • a transport errno   — ECONNRESET / ENOTFOUND / undici UND_ERR_* etc.,
 *                           found ANYWHERE in the `cause` chain. Keyed on the
 *                           errno, never on the wrapper's class name: node's
 *                           fetch surfaces a dead socket as `TypeError: fetch
 *                           failed` with the real code on `.cause`, and the
 *                           evidence is the code, not the constructor.
 *
 * OUT — deliberate calls on the ambiguous middle:
 *   • 401 — credentials, not weather. A retry with the same client credentials
 *           fails identically; telling him to wait hides a config break.
 *   • 400 / 403 / 404 / every other 4xx — we asked for something wrong, or we
 *           are not allowed to ask. Deterministic; #137's lesson is that a
 *           same-params retry cannot fix a malformed request.
 *   • a plain Error with NO status and NO errno — unknown provenance is not
 *           evidence of an outage. Withholding the claim is the safe default;
 *           the original error still propagates, so nothing is swallowed.
 *   • GraphPermissionError / CalendarOfflineError — already typed and already
 *           carry their own true message.
 */
const TRANSPORT_ERRNOS = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EPIPE', 'EPROTO',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

export function isOutageShaped(err: unknown): boolean {
  if (err instanceof GraphPermissionError || err instanceof CalendarOfflineError) return false;
  // Walk the cause chain (bounded) — the HTTP status or the errno may sit on a
  // wrapper OR on what wrapped it.
  let node: any = err;
  for (let depth = 0; node && typeof node === 'object' && depth < 5; depth++) {
    const status = typeof node.statusCode === 'number' ? node.statusCode
      : typeof node.status === 'number' ? node.status
      : typeof node.code === 'number' ? node.code
      : undefined;
    if (status !== undefined) {
      if (status >= 500 && status <= 599) return true;
      if (status === 429 || status === 408) return true;
      return false;   // any other explicit HTTP status is a decided, non-outage answer
    }
    if (typeof node.code === 'string' && TRANSPORT_ERRNOS.has(node.code)) return true;
    if (typeof node.errno === 'string' && TRANSPORT_ERRNOS.has(node.errno)) return true;
    node = node.cause;
  }
  return false;
}

/**
 * THE owner-event read behind every scheduling decision — the slot walker's
 * per-candidate rule pass, planMeeting's pre-book check,
 * check_join_availability's "can he make it" verdict, the calendar-health scan
 * and the floating-block ops. All of them feed checkSlot.
 *
 * ALWAYS 'live' (see ReadFreshness), and that is the whole reason this is a
 * function rather than a flag: "this read backs a commitment" is a property of
 * the read, not something five call sites have to remember. Pre-fix it took
 * getCalendarEvents' default, so every proposal and every pre-book validation
 * could be answered from a copy up to CALENDAR_CACHE_TTL_SECONDS old — a slot
 * taken three minutes earlier was still offered, "can you check again?" could not
 * check anything (the finder re-ran across three turns and re-served the
 * identical stale answer — logs/maelle-2026-07-27.log:512 vs :559), and not even
 * a forced get_calendar could reach it. The per-turn memo still dedupes repeat
 * reads inside one turn, so this costs at most one Graph round-trip per turn.
 *
 * One retry, one place. `createMeeting`'s Guard B already learned (#137) that a
 * transient Graph fault must not masquerade as a rule violation; the inverse —
 * a fault masquerading as a CLEAR CALENDAR — had no protection anywhere: the two
 * scheduling call sites caught, logged and returned `[]`. Now a blip gets exactly
 * one fresh retry and a real outage throws.
 *
 * The retry passes 'force' deliberately: the per-turn memo caches the REJECTED
 * promise under the plain key (turnCache.memoize stores the promise, not the
 * value), so a second 'live' call inside one turn would hand back the same
 * failure without ever touching Graph — a retry that cannot retry. The forced
 * path skips both caches and repopulates the warm copy on success, so every later
 * read in the turn sees the recovered data instead of the poisoned memo entry.
 *
 * Both the retry AND the offline verdict are gated on `isOutageShaped`: a
 * deterministic fault (403 consent, 404 wrong mailbox, 400 bad window, our own
 * TypeError) is neither retried — the same call fails the same way — nor
 * relabelled as weather. It propagates untouched, keeping its own true reason.
 */
export async function getOwnerEventsForDecision(
  userEmail: string,
  startDate: string,
  endDate: string,
  timezone: string,
): Promise<CalendarEvent[]> {
  try {
    return await getCalendarEvents(userEmail, startDate, endDate, timezone, 'live');
  } catch (firstErr) {
    if (!isOutageShaped(firstErr)) {
      logger.error('owner-calendar read failed with a NON-outage fault — surfacing it as-is, no retry', {
        userEmail, startDate, endDate, err: String(firstErr).slice(0, 300),
      });
      throw firstErr;
    }
    logger.warn('owner-calendar read failed — one fresh retry before declaring it offline', {
      userEmail, startDate, endDate, err: String(firstErr).slice(0, 200),
    });
    try {
      return await getCalendarEvents(userEmail, startDate, endDate, timezone, 'force');
    } catch (secondErr) {
      if (!isOutageShaped(secondErr)) {
        logger.error('owner-calendar retry failed with a NON-outage fault — surfacing it as-is', {
          userEmail, startDate, endDate, err: String(secondErr).slice(0, 300),
        });
        throw secondErr;
      }
      logger.error('owner-calendar read failed twice — treating the calendar as OFFLINE', {
        userEmail, startDate, endDate, err: String(secondErr).slice(0, 300),
      });
      throw new CalendarOfflineError(String(secondErr).slice(0, 300));
    }
  }
}

/**
 * findDuplicateEvent — the ONE idempotency primitive. Returns the owner's
 * existing event whose subject (trim + lowercase) matches and whose start is
 * within `toleranceMs` of the requested start, else undefined. Callers own
 * their own short-circuit shape — only the fetch + match lives here.
 *
 * Why: date-verifier / claim-checker retries re-run the whole orchestrator on a
 * new turn, and a direct create_meeting can race a coord book. Graph is the
 * source of truth — query it before creating so a re-attempt of an
 * already-booked meeting returns the existing id instead of a duplicate.
 *
 * Naming the real conflicting event behind an owner_busy_collision refusal is
 * a DIFFERENT job (see createMeeting.ts's use of diagnostics.conflictingEvent,
 * sourced from checkSlot's own overCommitment) — this function only ever
 * matches on subject + start-proximity, for idempotency.
 */
export async function findDuplicateEvent(
  userEmail: string,
  subject: string,
  startIso: string,
  timezone: string,
  toleranceMs = 2 * 60 * 1000,
): Promise<CalendarEvent | undefined> {
  const startDt = DateTime.fromISO(startIso, { zone: timezone });
  if (!startDt.isValid) return undefined;
  const wantSubject = subject.trim().toLowerCase();
  const startMs = startDt.toMillis();
  const probeDate = startDt.toFormat('yyyy-MM-dd');
  const events = await getCalendarEvents(userEmail, probeDate, probeDate, timezone);
  return events.find(ev => {
    if (ev.isCancelled) return false;
    if ((ev.subject ?? '').trim().toLowerCase() !== wantSubject) return false;
    const evStartMs = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).toMillis();
    return Math.abs(evStartMs - startMs) <= toleranceMs;
  });
}

/**
 * findReschedulableSibling (v3.6.x) — the create-vs-move slop guard's finder. A
 * sibling of findDuplicateEvent (idempotency), widened for the reschedule case:
 * returns an existing owner event that looks like the SAME meeting as the one
 * about to be created — same subject (trim+lowercase) AND ≥1 shared non-owner
 * attendee — within a ~3-week window around the requested start, EXCLUDING
 * the requested instant itself (that exact-time case is findDuplicateEvent's
 * job). Time-INDEPENDENT by design: a reschedule lands on a different day/time,
 * so we match WHO + WHAT, never WHEN. Structured fields only — no NL match, so
 * it's language-neutral. Returns the sibling nearest the requested start (the
 * occurrence the owner most likely means to move), else undefined.
 *
 * Caller uses it as surface-and-ask, NOT a block: offer move_meeting on this id,
 * and still book a genuine second meeting on force_new — so a legit second 1:1
 * with the same person stays bookable (the false-fire that kept the older
 * description-only fix soft). Catches "move X" → create_meeting duplicating a
 * live series (the 2026-07-05 Simon double-book across two days).
 */
export async function findReschedulableSibling(params: {
  userEmail: string;
  ownerEmail: string;
  subject: string;
  attendeeEmails: string[];
  startIso: string;
  timezone: string;
}): Promise<CalendarEvent | undefined> {
  const startDt = DateTime.fromISO(params.startIso, { zone: params.timezone });
  const wantSubject = params.subject.trim().toLowerCase();
  if (!startDt.isValid || !wantSubject) return undefined;
  const ownerLower = params.ownerEmail.toLowerCase();
  const wantAttendees = new Set(
    params.attendeeEmails.map(e => e.toLowerCase()).filter(e => e && e !== ownerLower),
  );
  if (wantAttendees.size === 0) return undefined;  // need a shared attendee to be confident
  const startMs = startDt.toMillis();
  // ~3-week window: 1 week back + 2 weeks forward. Forward-weighted because the
  // occurrence being rescheduled is usually the upcoming one, and covers a
  // biweekly series' next instance; wide enough for the common same-week move,
  // bounded to keep this one extra fetch cheap.
  const from = startDt.minus({ days: 7 }).toFormat('yyyy-MM-dd');
  const to = startDt.plus({ days: 14 }).toFormat('yyyy-MM-dd');
  const events = await getCalendarEvents(params.userEmail, from, to, params.timezone);
  const evMsOf = (ev: CalendarEvent): number =>
    DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).toMillis();
  const matches = events.filter(ev => {
    if (ev.isCancelled) return false;
    if ((ev.subject ?? '').trim().toLowerCase() !== wantSubject) return false;
    if (Math.abs(evMsOf(ev) - startMs) <= 2 * 60 * 1000) return false;  // exact-time = idempotency's job
    return (ev.attendees ?? []).some(a => wantAttendees.has((a.emailAddress?.address ?? '').toLowerCase()));
  });
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => Math.abs(evMsOf(a) - startMs) - Math.abs(evMsOf(b) - startMs));
  return matches[0];
}

// `cleanStart` / `cleanEnd` are already the normalized full-day window (see
// getCalendarEvents — the key and the query come from the same pair, so they can
// never describe different windows).
async function getCalendarEventsImpl(
  userEmail: string,
  cleanStart: string,
  cleanEnd: string,
  timezone: string,
): Promise<CalendarEvent[]> {
  const client = getClient();

  logger.info('Querying calendar', { userEmail, start: cleanStart, end: cleanEnd });

  // v2.1.6 — follow @odata.nextLink until exhausted (or a sane hard cap).
  // Previous single-shot `.query({$top: 100})` silently truncated at 100
  // events, leading to bugs like "the series doesn't seem to have instances
  // beyond Jun 11" when the series in fact ran through July — Graph returned
  // the first 100 chronologically, the LLM saw no nextLink handling, and the
  // narration described a false terminal boundary. Hard cap of 1000 prevents
  // runaway queries on accidentally-enormous ranges while comfortably
  // covering realistic multi-month calendar views.
  const HARD_CAP = 1000;
  try {
    const events: CalendarEvent[] = [];
    let request: any = client
      .api(`/users/${userEmail}/calendarView`)
      .header('Prefer', `outlook.timezone="${timezone}"`)
      .query({
        startDateTime: cleanStart,
        endDateTime: cleanEnd,
        $select: 'id,subject,start,end,isAllDay,importance,showAs,sensitivity,categories,organizer,attendees,isCancelled,isOnlineMeeting,onlineMeetingUrl,location,bodyPreview,type,seriesMasterId',
        $orderby: 'start/dateTime',
        $top: 100,
      });

    while (request && events.length < HARD_CAP) {
      const response: any = await request.get();
      const page: CalendarEvent[] = response.value ?? [];
      events.push(...page);
      const nextLink: string | undefined = response['@odata.nextLink'];
      if (!nextLink) break;
      // Graph SDK accepts the full nextLink as an api() URL. The cursor
      // preserves the QUERY (filter/select/orderby) but NOT request HEADERS.
      // v2.3.1 (#63) — re-attach Prefer so subsequent pages also come
      // back in the owner's timezone instead of defaulting to UTC.
      request = client.api(nextLink).header('Prefer', `outlook.timezone="${timezone}"`);
    }

    const truncated = events.length >= HARD_CAP;
    logger.info('Calendar events fetched', {
      count: events.length,
      start: cleanStart,
      end: cleanEnd,
      truncated,
    });
    if (truncated) {
      logger.warn('Calendar fetch hit HARD_CAP — result may be incomplete', {
        userEmail, start: cleanStart, end: cleanEnd, cap: HARD_CAP,
      });
    }
    return events;
  } catch (err) {
    logger.error('Failed to fetch calendar events', { err, userEmail, start: cleanStart, end: cleanEnd });
    throw err;
  }
}

export class GraphPermissionError extends Error {
  constructor(public readonly operation: string, public readonly detail: string) {
    super(`Graph permission denied for "${operation}": ${detail}`);
    this.name = 'GraphPermissionError';
  }
}

/**
 * The ONE wording for "nobody's availability was read in this window" — shared by
 * getFreeBusy's pre-flight branches and Graph's own window rejection inside
 * getFreeBusyImpl, so two routes to the same outcome can never describe it
 * differently. Returns the address list the caller must report as unchecked.
 */
function logNothingChecked(
  why: string, startDate: string, endDate: string, emails: string[],
): string[] {
  logger.warn(`getFreeBusy — ${why}; NO availability was read for anyone in this window`, {
    startDate, endDate, emails,
  });
  return emails.map(e => e.toLowerCase());
}

/**
 * One free/busy answer, whole: the busy blocks per address, the addresses Graph
 * could not RESOLVE, and the addresses nobody was able to ASK about. The three
 * travel together because they are one answer — a caller handed `{}` without
 * knowing which of the three it is reads it as "everyone is free", which is P15's
 * entire lesson. Keeping them in one cache entry also means the `unresolved` list
 * can no longer be evicted independently of the data it describes.
 */
type FbRead = {
  result: Record<string, FreeBusySlot[]>;
  unresolved: string[];
  notChecked: string[];
};

/**
 * Graph's own getSchedule ceiling (62 days), stated ONCE and in ONE unit —
 * absolute minutes, the same unit the window is measured in. Two spellings of the
 * same limit is what the DST fixed point was: the test counted absolute minutes
 * and the clamp counted calendar days.
 */
const MAX_FREEBUSY_WINDOW_MINUTES = 62 * 24 * 60;

export async function getFreeBusy(
  callerEmail: string,
  emails: string[],
  startDate: string,
  endDate: string,
  timezone: string,
  freshness: ReadFreshness = 'cached',
  // v3.3.7 (#124h) — optional by-reference diagnostics.
  //
  // `unresolved` — addresses Graph ANSWERED about and could not resolve to a
  // mailbox (per-schedule `error` entry, or address missing from the response).
  // Pre-fix this was silently dropped, so a guessed/typo'd internal address read
  // as FULLY FREE — the "elinor.avny@" slots were offered without ever checking
  // the real Elinor.
  //
  // `notChecked` — P15 (v4.2.x). Addresses NOBODY asked Graph about, because the
  // request could not be made at all (the two branches below, and the
  // ErrorInvalidTimeInterval catch). Deliberately a SECOND list, not folded into
  // `unresolved`: the consequence is the same ("no data — do not read as free")
  // but the REASON is opposite, and `unresolved`'s consumers state that reason out
  // loud ("these addresses do NOT exist in the company directory", create_meeting
  // / find_available_slots). Saying that about a live mailbox because the window
  // was malformed is a confidently wrong reason, which is the M11 failure this fix
  // exists to remove — not a smaller version of it.
  diagnostics?: { unresolved?: string[]; notChecked?: string[] },
): Promise<Record<string, FreeBusySlot[]>> {
  // v2.7.6 — guard against invalid time windows that crash Graph's
  // getSchedule with ErrorInvalidTimeInterval. Graph requires
  // startTime < endTime AND a window between 1 hour and 62 days. Pre-fix,
  // the auto-expand loop in findAvailableSlots could produce equal or
  // inverted windows on edge cases (off-by-one when search_from was at the
  // boundary of an iteration).
  //
  // P15 (v4.2.x) — every branch here used to `return {}`, and `{}` is
  // indistinguishable from "asked about everyone, nobody is busy". So a
  // malformed window read as "the whole company is free", which is the single
  // most dangerous wrong answer this function can give. Two different problems
  // were hiding under one fail-open, and they get two different treatments:
  //   • an INSTANT (start === end) is not malformed at all — see below;
  //   • a genuinely unanswerable window still returns without throwing (a throw
  //     here is what #137 was: a deterministic 400 dressed up as a conflict and
  //     mis-escalated to an approval, and it would also kill the slot walker
  //     mid-loop), but it now reports every requested address in
  //     `diagnostics.notChecked`, so a caller can say "I could not check" instead
  //     of "they are free".
  const parsedStart = DateTime.fromISO(startDate, { zone: timezone });
  let parsedEnd = DateTime.fromISO(endDate, { zone: timezone });
  // The end that is actually QUERIED. Two pre-flight repairs move it in place — the
  // whole-day widening below and the 62-day clamp further down — and everything
  // downstream reads this one variable: the cache key, the log lines and the POST.
  // The window we decided on and the window Graph is asked about cannot drift.
  let queryEnd = endDate;
  // The pre-flight branches below answer directly, so they write `diagnostics`
  // themselves. Graph's own window rejection cannot: it happens inside the
  // MEMOIZED fetch, where a side-effect write would leave a second caller in the
  // same turn holding `{}` with no notChecked list — i.e. reading it as "everyone
  // is free", the exact P15 failure. That one returns the list instead, and the
  // single exit at the bottom applies it.
  const nothingChecked = (why: string): Record<string, FreeBusySlot[]> => {
    const notChecked = logNothingChecked(why, startDate, queryEnd, emails);
    if (diagnostics) diagnostics.notChecked = notChecked;
    return {};
  };
  if (!parsedStart.isValid || !parsedEnd.isValid) {
    return nothingChecked('unparseable date param');
  }
  // v4.2.x — A DATE-ONLY `endDate` MEANS THE END OF THAT DAY, not its first
  // instant. "Is she free Thursday" is what a model turns into
  // start_date === end_date === '2026-07-30' — and correctly so: the tool asks for
  // "a date range in ISO 8601" (skills/meetings.ts), so a bare date is the
  // schema-shaped answer. Both parsed to 00:00, which made the pair an INSTANT: the
  // branch below widened it to 00:00–01:00 and kept only the blocks covering
  // midnight, so a fully-booked day came back as everyone free — and with
  // `notChecked` EMPTY, because a read did happen, of the wrong moment. The same
  // off-by-a-day silently truncated every multi-day date-only range ('07-30' →
  // '07-31' read the 30th only).
  //
  // v4.2.2 — the same whole-day question has a SECOND spelling, and the date-only
  // regex above only recognized the first. `'2026-07-30T00:00:00'` for both start and end
  // is what "a date range in ISO 8601" invites a model to write: it failed the
  // date-only test, fell to the instant branch, and asked Graph about 00:00–01:00,
  // so a day booked solid 09:00–18:00 came back FREE with `notChecked` empty — the
  // failure above reached by a different route. So the recognizer is on the INSTANT
  // now, not on the spelling: start === end AND that instant is midnight IN THE
  // CALLER'S ZONE (`timezone`, never the server's — M13) is a whole day however it
  // was typed. A REAL instant carries a time and is not midnight
  // (availabilityPreCheck normalizing "יש משהו אחרי 17:00?" to one moment is
  // untouched, still the instant branch); '…T00:00:00Z' is 03:00 in Jerusalem, a
  // genuine instant there, and keeps that reading.
  //
  // WIDENED, not refused. A whole-day question wearing an instant's shape needs
  // answering (P15's own reasoning) and this one can be answered exactly: the
  // window IS that day, so nothing is invented, and `notChecked`'s claim — "the
  // window could not be queried" — would simply be false. Widened IN PLACE, not by
  // re-entry: nothing above this line depends on the end, every branch below reads
  // `parsedEnd`, and a self-call that re-derives its own argument is the exact
  // shape of the 62-day bug fixed further down. An inverted date-only pair still
  // lands on `nothingChecked` below — widening its end only makes it more inverted.
  // Tested on the ISO date shape — a structured string, never prose.
  const endIsWholeDay = /^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())
    || (parsedEnd.toMillis() === parsedStart.toMillis()
      && parsedEnd.toMillis() === parsedEnd.startOf('day').toMillis());
  if (endIsWholeDay) {
    parsedEnd = parsedEnd.endOf('day');
    queryEnd = parsedEnd.toISO()!;
  }
  let windowMinutes = parsedEnd.diff(parsedStart, 'minutes').minutes;
  // P15 — an INSTANT, i.e. start === end. This is the branch with all the real
  // traffic: availabilityPreCheck normalizes a colleague's "יש משהו אחרי 17:00?"
  // to a single instant with no end and calls straight through, so a
  // zero-length window arrived four times per turn and every attendee came back
  // "free" (logs/maelle-2026-07-20.log, `windowMinutes: 0`, startDate ===
  // endDate, 8 hits that day alone). It is a perfectly well-formed question —
  // "what holds this moment?" — that Graph simply cannot be asked directly, so
  // ask the smallest window Graph does accept and filter the answer back down to
  // the blocks that genuinely cover the instant. Nothing is invented: the
  // meeting length is not guessed (there is no meeting), and a block that merely
  // starts later inside the widened hour is dropped, so no false "busy" either.
  // A block ENDING exactly at the instant is not a conflict (back-to-back is the
  // preferred shape, M7), hence `start <= t < end`.
  if (parsedEnd.toMillis() === parsedStart.toMillis()) {
    const widenedEnd = parsedStart.plus({ minutes: 60 }).toISO()!;
    const wide = await getFreeBusy(callerEmail, emails, startDate, widenedEnd, timezone, freshness, diagnostics);
    const instantMs = parsedStart.toMillis();
    const atInstant: Record<string, FreeBusySlot[]> = {};
    // Iterate the RESULT's keys, not `emails`: "checked, free" must stay an empty
    // array and "Graph never answered for this address" must stay an absent key,
    // exactly as the normal path leaves them.
    for (const [email, slots] of Object.entries(wide)) {
      atInstant[email] = slots.filter(s => {
        const sStart = DateTime.fromISO(s.start).toMillis();
        const sEnd = DateTime.fromISO(s.end).toMillis();
        return sStart <= instantMs && instantMs < sEnd;
      });
    }
    return atInstant;
  }
  if (windowMinutes < 0) {
    // Genuinely malformed — an inverted window has no instant reading and no
    // repair: there is no way to tell whether the start or the end is the typo.
    return nothingChecked('inverted window (end before start)');
  }
  if (windowMinutes > MAX_FREEBUSY_WINDOW_MINUTES) {
    // The limit and the clamp have to be ONE arithmetic. `windowMinutes` is
    // ABSOLUTE (`diff`), while the clamp was `plus({ days: 62 })` — CALENDAR days,
    // which hold the wall clock across a DST transition. A clamped window
    // containing a fall-back is therefore 89,340 real minutes against an 89,280
    // limit: still over — and the clamp, re-derived from the UNCHANGED start, comes
    // out byte-identical, so the old recursion re-entered on the same window
    // forever. Synchronously, so the stack died with a RangeError behind a flood of
    // warn lines rather than hanging. Measured, not reasoned: start
    // 2026-09-01T09:00 → end 2026-12-31T17:00 in Asia/Jerusalem clamps to
    // 2026-11-02T09:00+02:00 = 89,340 min, then to the identical value again. Live
    // for START dates 2026-08-24 … 2026-10-24 there, every year, and on its own
    // dates in every tenant zone with a fall-back; reachable from get_free_busy
    // with any model-supplied range and from find_available_slots, which chunks
    // nothing and rethrows non-outage faults, so it took the whole tool down.
    //
    // Clamping in MINUTES makes end − start exactly the ceiling by construction,
    // and narrowing in place removes the re-entry altogether — which is also what
    // retires #124h here: that recursion had to remember to forward `freshness` and
    // `diagnostics` (it once didn't, and a typo'd attendee inside a long window
    // reported as resolved-and-free), and now there is nothing to forward them to.
    // And the ceiling is TWO windows, not one: "62 days" in Graph's language is
    // calendar days, "89,280 minutes" in ours is absolute, and across a transition
    // those differ by an hour in opposite directions. So clamp to whichever is
    // TIGHTER and both readings hold at once — never more than 62 calendar days for
    // Graph, never more than the limit we just tested for ourselves. Off a
    // transition the two are the same instant, so this is byte-identical to the old
    // clamp everywhere except the window that was broken.
    const byCalendar = parsedStart.plus({ days: 62 });
    const byMinutes = parsedStart.plus({ minutes: MAX_FREEBUSY_WINDOW_MINUTES });
    const clampedEnd = byCalendar.toMillis() <= byMinutes.toMillis() ? byCalendar : byMinutes;
    parsedEnd = clampedEnd;
    queryEnd = parsedEnd.toISO()!;
    logger.warn('getFreeBusy — window > 62 days, clamping to the 62-day ceiling', {
      startDate, requestedEnd: endDate, requestedWindowMinutes: windowMinutes,
      clampedEnd: queryEnd,
    });
    windowMinutes = parsedEnd.diff(parsedStart, 'minutes').minutes;
  }

  // v3.2.x (#121) — cross-turn free/busy cache (others' calendars change like
  // ours → same write-invalidation + TTL). Key on the sorted attendee set + the
  // RESOLVED window instants, not the caller's spelling: '2026-07-28T10:00:00'
  // and '2026-07-28T10:00:00.000+03:00' are one question asked twice, and
  // planMeeting's pre-book check and create_meeting's phantom-attendee probe do
  // ask it in different spellings inside a single turn.
  const fbKey = `getFreeBusy|${[...emails].map(e => e.toLowerCase()).sort().join(',')}`
    + `|${parsedStart.toMillis()}|${parsedEnd.toMillis()}|${timezone}`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fbCache = require('./calendarCache') as typeof import('./calendarCache');
  if (freshness === 'cached') {
    const hit = fbCache.getCachedFreeBusy<FbRead>(fbKey);
    if (hit) {
      if (diagnostics) {
        diagnostics.unresolved = hit.unresolved;
        // P15 — only a SUCCESSFUL read is ever cached, so a hit means everyone in
        // this window was checked. Stated rather than left undefined: a caller
        // reusing one diagnostics object across windows must not inherit a
        // previous window's "not checked" and refuse to trust good data.
        diagnostics.notChecked = [];
      }
      return hit.result;
    }
  }

  // Per-turn memo — the layer a 'live' read IS allowed, and the one this function
  // never had. Dropping the cross-turn copy for decision reads without it would
  // double the getSchedule POSTs on every booking: create_meeting's
  // phantom-attendee probe and planMeeting's pre-book check ask the same question
  // microseconds apart and relied on the warm copy to share one call. 'force'
  // skips it too — a retry has to be able to escape a memoized rejection.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { memoize } = require('../../utils/turnCache') as typeof import('../../utils/turnCache');
  const runRead = () => getFreeBusyImpl(callerEmail, emails, startDate, queryEnd, timezone, windowMinutes);
  const read = freshness === 'force' ? await runRead() : await memoize(fbKey, runRead);
  // ONE exit, so `unresolved` / `notChecked` land identically whether this caller
  // made the call or is sharing another caller's memoized one.
  if (diagnostics) {
    diagnostics.unresolved = read.unresolved;
    diagnostics.notChecked = read.notChecked;
  }
  // A window Graph refused says nothing about anyone's calendar — never keep that
  // warm. A 'live' read DOES repopulate, so the readers that are allowed a warm
  // copy get the fresher data.
  if (read.notChecked.length === 0) fbCache.setCachedFreeBusy(fbKey, read);
  return read.result;
}

/**
 * THE free/busy read behind a scheduling decision — the slot walker's own
 * availability pass, planMeeting's pre-book attendee check, create_meeting's
 * phantom-attendee probe, the offered-slot annotation and the meeting-room check.
 * Always 'live' (see ReadFreshness), for the same reason
 * `getOwnerEventsForDecision` is: freshness belongs to the read, not to five call
 * sites' memory. One of them used to set it by hand and only for override/replay
 * (planMeeting's `allowRelaxed`), which meant every ORDINARY booking annotated
 * "Simon is busy then" — or said nothing at all — off a copy up to
 * CALENDAR_CACHE_TTL_SECONDS old.
 */
export function getFreeBusyForDecision(
  callerEmail: string,
  emails: string[],
  startDate: string,
  endDate: string,
  timezone: string,
  diagnostics?: { unresolved?: string[]; notChecked?: string[] },
): Promise<Record<string, FreeBusySlot[]>> {
  return getFreeBusy(callerEmail, emails, startDate, endDate, timezone, 'live', diagnostics);
}

/**
 * The raw getSchedule POST. Mirrors getCalendarEventsImpl: the exported
 * getFreeBusy owns window resolution, freshness and diagnostics; this owns the
 * call and the shape of the answer. `windowMinutes` is handed in rather than
 * recomputed, so the interval derivation cannot disagree with the window the
 * caller already validated.
 */
async function getFreeBusyImpl(
  callerEmail: string,
  emails: string[],
  startDate: string,
  endDate: string,
  timezone: string,
  windowMinutes: number,
): Promise<FbRead> {
  const client = getClient();
  try {
    // v3.7.x (#137) — availabilityViewInterval must be < the requested window or
    // Graph 400s with ErrorInvalidMergedFreeBusyInterval. A single-slot
    // verification window (colleague-path Guard B / move-check) for a SHORT
    // meeting (e.g. a 10-min slot) is narrower than the hardcoded 15, which failed
    // DETERMINISTICALLY and mis-escalated a rule-COMPLIANT booking to a
    // policy_exception approval (#137 — a same-params retry can't fix a malformed
    // request). Derive a valid interval for short windows; windows ≥16 min keep 15
    // (no behavior change — scheduleItems, the busy blocks we actually read, are
    // returned regardless of the view interval).
    const availabilityViewInterval = windowMinutes >= 16
      ? 15
      : Math.max(5, Math.floor(windowMinutes) - 1);
    const response = await client.api(`/users/${callerEmail}/calendar/getSchedule`).post({
      schedules: emails,
      startTime: { dateTime: startDate, timeZone: timezone },
      endTime: { dateTime: endDate, timeZone: timezone },
      availabilityViewInterval,
    });

    const result: Record<string, FreeBusySlot[]> = {};
    const unresolved: string[] = [];
    for (const schedule of response.value || []) {
      // v3.3.7 (#124h) — Graph marks a non-existent / unresolvable address
      // with a per-schedule `error` object instead of scheduleItems. Surface
      // it; an empty array here is indistinguishable from "free all week".
      if (schedule.error) {
        unresolved.push(String(schedule.scheduleId ?? '').toLowerCase());
        result[schedule.scheduleId] = [];
        continue;
      }
      result[schedule.scheduleId] = (schedule.scheduleItems || []).map((item: any) =>
        parseGraphFreeBusySlot(item, timezone),
      );
    }
    // Belt-and-suspenders: an address Graph dropped from the response entirely.
    for (const e of emails) {
      const lower = e.toLowerCase();
      const present = Object.keys(result).some(k => k.toLowerCase() === lower);
      if (!present && !unresolved.includes(lower)) unresolved.push(lower);
    }
    return { result, unresolved, notChecked: [] };
  } catch (err: any) {
    logger.error('Failed to fetch free/busy', { err, emails });

    // 403 / ErrorAccessDenied means the Azure app lacks Calendars.Read application
    // permission (admin consent required in the company tenant).
    // Surface this as a typed error so callers can give a useful message.
    if (err?.statusCode === 403 || err?.code === 'ErrorAccessDenied') {
      throw new GraphPermissionError(
        'getFreeBusy',
        'The Azure app does not have Calendars.Read permission to query other users\' availability. ' +
        'A tenant admin needs to grant Calendars.Read application permission in Azure AD.',
      );
    }
    // Graph rejected the window. Still returns rather than throwing: the slot
    // finder iterates windows and a throw here killed the whole search, and #137
    // is the standing lesson that a deterministic 400 must never be dressed up as
    // a scheduling verdict. P15 — but it reports every requested address as NOT
    // CHECKED, because that is what happened. Before, this was the third path by
    // which a malformed request read as "they are all free"; the difference matters
    // most here, since a caller can retry a window it now knows was never read.
    //
    // A2 — BOTH window rejections, one branch. `ErrorInvalidMergedFreeBusyInterval`
    // is the OTHER way this call can be refused for its window: Graph's minimum
    // availabilityViewInterval is 5 min AND the interval must be under the window,
    // so a 1–5 minute window has no valid interval at all and the derivation above
    // floors at 5 and gets a 400. Nothing to prevent — no real meeting is under 10
    // minutes and widening a caller's window would invent a question nobody asked —
    // so it gets P15's treatment rather than a third path: no throw, everyone
    // reported unchecked, the caller free to say "I could not check" and retry a
    // sane window. It failed CLOSED before (uncaught → up through the walker's
    // non-outage rethrow → a raw Graph code in her context), which is why there is
    // no log evidence of a wrong answer from it; the fix is the wording and the
    // `notChecked` list, not the safety.
    const windowRejection = ['ErrorInvalidTimeInterval', 'ErrorInvalidMergedFreeBusyInterval']
      .find(code => err?.code === code || err?.body?.includes?.(code));
    if (windowRejection) {
      return {
        result: {},
        unresolved: [],
        notChecked: logNothingChecked(
          `Graph rejected the window (${windowRejection})`, startDate, endDate, emails,
        ),
      };
    }
    throw err;
  }
}

/**
 * v1.8.8 — cheap probe to check whether an event is part of a recurring
 * series. Returns { type, subject, seriesMasterId? } from a lightweight
 * GET. Used by update_meeting and move_meeting to block changes to the
 * series root while allowing single-occurrence edits.
 */
/**
 * v2.1.4 — find the next occurrence of a recurring series after a given
 * ISO timestamp. Used by active-mode move-coord to cap the slot search so
 * Maelle doesn't propose moving a weekly meeting into a date where the
 * NEXT weekly instance already lives (would duplicate the cadence).
 *
 * Query Graph's `/events/{seriesMasterId}/instances` endpoint — returns
 * expanded occurrences of the series within a date range. Pick the first
 * one with a start strictly after `afterIso`.
 *
 * Returns null when:
 *   - the series has no more occurrences after `afterIso` (end of series)
 *   - the Graph call fails (fail-open — caller treats as "no cap")
 *   - seriesMasterId is empty
 *
 * Lookahead window: 60 days. Weekly / biweekly always fit; a monthly
 * cadence would fit twice; yearly recurrences fall outside — accept that
 * trade-off, a yearly event uncapped is rare and the safer cap is fine.
 */
export async function getNextSeriesOccurrenceAfter(
  userEmail: string,
  seriesMasterId: string,
  afterIso: string,
): Promise<string | null> {
  if (!seriesMasterId) return null;
  try {
    const client = getClient();
    const afterDt = DateTime.fromISO(afterIso).toUTC();
    const startQueryIso = afterDt.plus({ minutes: 1 }).toISO()!;
    const endQueryIso = afterDt.plus({ days: 60 }).toISO()!;
    const resp = await client
      .api(`/users/${userEmail}/events/${seriesMasterId}/instances`)
      .query({ startDateTime: startQueryIso, endDateTime: endQueryIso })
      .select('id,start,isCancelled')
      .top(5)
      .get();
    const items: Array<{ id: string; start?: { dateTime: string; timeZone: string }; isCancelled?: boolean }>
      = resp?.value ?? [];
    for (const inst of items) {
      if (inst.isCancelled) continue;
      if (!inst.start?.dateTime) continue;
      // Graph returns instance start in the series' original timezone; normalise to UTC.
      const instStartIso = DateTime
        .fromISO(inst.start.dateTime, { zone: inst.start.timeZone ?? 'utc' })
        .toUTC()
        .toISO()!;
      if (instStartIso > afterIso) return instStartIso;
    }
    return null;
  } catch (err) {
    logger.warn('getNextSeriesOccurrenceAfter — failed, returning null (fail-open)', {
      seriesMasterId, err: String(err).slice(0, 200),
    });
    return null;
  }
}

/**
 * v2.1.4 — who organized a calendar event? Used by update_meeting /
 * move_meeting guards to refuse mutations on meetings the owner didn't
 * organize (Graph would reject the PATCH anyway, but we fail early with a
 * human error message + avoid Maelle narrating a fake success).
 *
 * Returns null when the Graph call fails — caller treats as "unknown, allow".
 */
export async function getEventOrganizer(
  userEmail: string,
  meetingId: string,
): Promise<{ name?: string; address: string } | null> {
  try {
    const client = getClient();
    const event = await client
      .api(`/users/${userEmail}/events/${meetingId}`)
      .select('id,organizer')
      .get();
    const addr = event?.organizer?.emailAddress?.address;
    if (!addr) return null;
    return {
      name: event.organizer.emailAddress.name,
      address: String(addr).toLowerCase(),
    };
  } catch (err) {
    logger.warn('getEventOrganizer — failed, returning null (fail-open)', {
      meetingId, err: String(err).slice(0, 200),
    });
    return null;
  }
}

/**
 * v3.5.x — single GET of one event's END instant (resolved to `timezone`) + its
 * subject. ONE lookup-by-id, no calendarView range-probe. Two callers:
 *   - create_meeting `start_at_event_end_id` — anchor "X after my flight/meeting"
 *     deterministically (start = this end; no model clock-arithmetic, nothing to ask).
 *   - the must_be_after_event_id ordering guard — refuse a start before this end.
 * Returns null when the event can't be loaded (deleted / permission / bad id);
 * callers treat null as "skip the check / refuse the anchor."
 */
export async function getEventEndInstant(
  userEmail: string,
  eventId: string,
  timezone: string,
): Promise<{ end: DateTime; subject: string; sensitivity?: string; categories?: string[] } | null> {
  try {
    const client = getClient();
    const event = await client
      .api(`/users/${userEmail}/events/${eventId}`)
      .header('Prefer', `outlook.timezone="${timezone}"`)
      // o#178 — sensitivity + categories ride along with subject so a caller
      // that surfaces this subject to a colleague (the must_be_after_event_id
      // ordering refusal) can mask it through displaySubject instead of
      // shipping the raw Graph subject of a private predecessor meeting.
      .select('id,subject,end,sensitivity,categories')
      .get();
    const endIso = event?.end?.dateTime;
    if (!endIso) return null;
    const dt = DateTime.fromISO(endIso, { zone: event.end.timeZone ?? timezone }).setZone(timezone);
    if (!dt.isValid) return null;
    return { end: dt, subject: event.subject ?? 'unknown', sensitivity: event.sensitivity, categories: event.categories };
  } catch (err) {
    logger.warn('getEventEndInstant — failed, returning null', {
      eventId, err: String(err).slice(0, 200),
    });
    return null;
  }
}

/**
 * v2.9.1 — load just enough event detail for an attendee-update flow:
 * existing attendees (so the handler can compute the new list), start/end
 * (so location resolution can re-evaluate day-type), categories, location,
 * isOnline. Single GET, no calendarView pagination.
 *
 * Returns null when the event cannot be loaded (deleted, permission, etc.).
 * Caller treats null as "refuse the update with a clear message."
 */
export async function getEventForAttendeeUpdate(
  userEmail: string,
  meetingId: string,
): Promise<{
  attendees: Array<{ name?: string; email: string; optional?: boolean }>;
  startIso?: string;
  endIso?: string;
  startTimeZone?: string;
  categories: string[];
  location?: string;
  isOnline?: boolean;
} | null> {
  try {
    const client = getClient();
    const event: any = await client
      .api(`/users/${userEmail}/events/${meetingId}`)
      .select('id,start,end,attendees,categories,location,isOnlineMeeting')
      .get();
    if (!event) return null;
    const attendees = ((event.attendees as any[]) ?? [])
      .filter(a => a?.emailAddress?.address)
      .map(a => ({
        name: a.emailAddress?.name as string | undefined,
        email: String(a.emailAddress.address).toLowerCase(),
        optional: a.type === 'optional',
      }));
    return {
      attendees,
      startIso: event.start?.dateTime,
      endIso: event.end?.dateTime,
      startTimeZone: event.start?.timeZone,
      categories: (event.categories as string[]) ?? [],
      location: event.location?.displayName as string | undefined,
      isOnline: event.isOnlineMeeting as boolean | undefined,
    };
  } catch (err) {
    logger.warn('getEventForAttendeeUpdate — failed', {
      meetingId, err: String(err).slice(0, 200),
    });
    return null;
  }
}

export async function getEventType(userEmail: string, meetingId: string): Promise<{
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  subject?: string;
  seriesMasterId?: string;
  // v2.8.5 — also surface start so callers (notably delete_meeting's audit
  // log) can record WHICH DAY was affected, enabling active-mode to detect
  // "owner just deleted this floating block — don't re-book it" later.
  startDateTime?: string;
  startTimeZone?: string;
  // v3.4.x (#135c) — also surface end so a pure move (new_end omitted) can
  // preserve the meeting's existing duration without forcing the model to
  // supply (or re-ask for) a length it already knows.
  endDateTime?: string;
  endTimeZone?: string;
}> {
  const client = getClient();
  const event = await client
    .api(`/users/${userEmail}/events/${meetingId}`)
    .select('id,type,subject,seriesMasterId,start,end')
    .get();
  return {
    type: event?.type,
    subject: event?.subject,
    seriesMasterId: event?.seriesMasterId,
    startDateTime: event?.start?.dateTime,
    startTimeZone: event?.start?.timeZone,
    endDateTime: event?.end?.dateTime,
    endTimeZone: event?.end?.timeZone,
  };
}

/**
 * v2.1.6 — post-delete verification. Returns true when Graph confirms the
 * event is no longer retrievable (HTTP 404 on GET), false when it's still
 * there despite the delete call returning success. Any other error is
 * treated as "unknown / assume still present" so the caller narrates
 * honestly rather than falsely confirming a delete. Mirrors the spirit of
 * `create_meeting`'s pre-check (same trust-but-verify principle for
 * calendar-mutating ops).
 */
export async function verifyEventDeleted(
  userEmail: string,
  meetingId: string,
): Promise<boolean> {
  const client = getClient();
  try {
    await client.api(`/users/${userEmail}/events/${meetingId}`).get();
    // Event still exists — delete did NOT land.
    return false;
  } catch (err: any) {
    const code = err?.statusCode ?? err?.code;
    if (code === 404 || code === 'ErrorItemNotFound') return true;
    logger.warn('verifyEventDeleted: unexpected error, assuming NOT deleted', {
      meetingId, code, message: err?.message,
    });
    return false;
  }
}

// v2.2.5 (#54) — post-create / post-move verification. Mirrors the spirit of
// verifyEventDeleted: re-read the event from Graph after a write to confirm it
// actually landed at the requested time. Microsoft Graph occasionally returns
// 200 OK on writes that don't take effect (sync delays, lost writes, race
// conditions). With the new action tape pinning successful mutations into the
// owner system prompt, a silent failure would make Maelle assert "I moved X"
// against the owner's pushback. These verifiers turn that into honest
// `success:false` so the tape never lists a write that didn't land.
//
// Tolerance: ±60s on start. Graph normalizes ISO formats (Z vs offset) and
// occasional truncation of milliseconds; tighter than 60s produces false
// drifts. Subject drift is intentionally NOT checked — Outlook normalizes
// whitespace/emojis/quote styles, that's a separate problem class, not a
// silent-write failure.

const VERIFY_TOLERANCE_MS = 60_000;

async function verifyEventStartMatches(
  userEmail: string,
  meetingId: string,
  expectedStartIso: string,
  expectedTimezone: string,
): Promise<VerifyResult> {
  const client = getClient();
  let evt: { start?: { dateTime: string; timeZone?: string } };
  try {
    evt = await client.api(`/users/${userEmail}/events/${meetingId}`).get();
  } catch (err: any) {
    const code = err?.statusCode ?? err?.code;
    if (code === 404 || code === 'ErrorItemNotFound') {
      return { ok: false, reason: 'not_found' };
    }
    // Network blip / auth blip / unknown error: treat as unknown and return ok
    // to avoid false-positive failures. The honest move is to NOT block on
    // verifier errors — let downstream layers (claim-checker, brief) catch
    // anything that's actually wrong.
    logger.warn('verifyEventStartMatches: readback threw, assuming OK', {
      meetingId, code, message: err?.message,
    });
    return { ok: true };
  }
  if (!evt?.start?.dateTime) {
    return { ok: false, reason: 'not_found' };
  }
  const got = DateTime.fromISO(evt.start.dateTime, { zone: evt.start.timeZone ?? 'utc' });
  const expected = DateTime.fromISO(expectedStartIso, { zone: expectedTimezone });
  if (!got.isValid || !expected.isValid) {
    logger.warn('verifyEventStartMatches: invalid datetime, assuming OK', {
      meetingId, gotRaw: evt.start.dateTime, expectedRaw: expectedStartIso,
    });
    return { ok: true };
  }
  const diff = Math.abs(got.toMillis() - expected.toMillis());
  if (diff <= VERIFY_TOLERANCE_MS) return { ok: true };
  return {
    ok: false,
    reason: 'start_drift',
    got: got.setZone(expectedTimezone).toFormat("EEE d MMM 'at' HH:mm"),
    expected: expected.toFormat("EEE d MMM 'at' HH:mm"),
  };
}

export async function verifyEventCreated(
  userEmail: string,
  meetingId: string,
  expectedStartIso: string,
  expectedTimezone: string,
): Promise<VerifyResult> {
  return verifyEventStartMatches(userEmail, meetingId, expectedStartIso, expectedTimezone);
}

export async function verifyEventMoved(
  userEmail: string,
  meetingId: string,
  expectedStartIso: string,
  expectedTimezone: string,
): Promise<VerifyResult> {
  return verifyEventStartMatches(userEmail, meetingId, expectedStartIso, expectedTimezone);
}
