/**
 * Reply-deadline tz math — transport-agnostic.
 *
 * Extracted from connectors/slack/coordinator.ts (v3.3.x, audit T-1/M-19) so
 * CORE consumers (outreach skill, dispatchers) don't reach DOWN into a
 * Slack-bound connector for a pure date helper. No Slack dependency lives here —
 * just luxon. When the email/WhatsApp Connections come online they share this.
 */
import { DateTime } from 'luxon';
import { defaultWorkingHoursForTz, type WorkingHours } from './workingHoursDefault';

type WorkWindow = Pick<WorkingHours, 'workdays' | 'hoursStart' | 'hoursEnd'>;

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function isWorkDay(dt: DateTime, workdays: string[]): boolean {
  return workdays.includes(DAY_NAMES[dt.weekday]);
}

function setClock(dt: DateTime, hhmm: string): DateTime {
  const [hour, minute] = hhmm.split(':').map(Number);
  return dt.set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * Next "business hour start" ≥ now, using `window`'s workdays + hours
 * (Sun–Thu 09:00–18:00 for a tenant-matching zone, Mon–Fri 09:00–17:00
 * Western default elsewhere — see `defaultWorkingHoursForTz`). Used by
 * calcResponseDeadline so reply timers never fire during someone's night.
 */
function nextWorkingHourStart(timezone: string, window: WorkWindow, fromMs?: number): DateTime {
  let dt = DateTime.fromMillis(fromMs ?? Date.now()).setZone(timezone);

  for (let i = 0; i < 10; i++) {
    if (isWorkDay(dt, window.workdays)) {
      const start = setClock(dt, window.hoursStart);
      const end = setClock(dt, window.hoursEnd);
      if (dt < start) return start;
      if (dt < end) return dt;
    }
    dt = setClock(dt.plus({ days: 1 }), window.hoursStart);
  }
  return dt;
}

/**
 * Advance `start` by `hours` WORKING hours, using the same `window` as
 * `nextWorkingHourStart` — hours that fall outside it, and whole non-work
 * days, don't count against the budget. `start` must already be a
 * working-hour instant (feed it `nextWorkingHourStart`'s result) so the
 * first day's remaining window is measured correctly.
 *
 * Owner ruling (2026-08-12, Daniel Sharabi incident) — a Friday-afternoon
 * message must not quietly expire over the weekend: the old flat
 * `workStart.plus({ hours: N })` counted straight through nights and
 * weekends, so a colleague who replied same-business-day (~2.5h after a
 * 3-hour flat window) still got marked "never responded." Reusing the
 * day/hour walk `nextWorkingHourStart` already does (not a second weekday
 * reimplementation) fixes both: the flat-hours bug AND the weekend-swallow.
 */
function addWorkingHours(start: DateTime, hours: number, window: WorkWindow): DateTime {
  let remainingMin = hours * 60;
  let dt = start;

  // Cap generous enough for any sane deadline budget (24h ≈ 3 calendar days
  // at 8-11 working hours/day; 60 covers multi-week holidays defensively).
  for (let i = 0; i < 60 && remainingMin > 0; i++) {
    if (isWorkDay(dt, window.workdays)) {
      const windowStart = setClock(dt, window.hoursStart);
      const windowEnd = setClock(dt, window.hoursEnd);
      const cursor = dt < windowStart ? windowStart : dt > windowEnd ? windowEnd : dt;
      const availableMin = windowEnd.diff(cursor, 'minutes').minutes;
      if (availableMin > 0) {
        if (availableMin >= remainingMin) return cursor.plus({ minutes: remainingMin });
        remainingMin -= availableMin;
      }
    }
    dt = setClock(dt.plus({ days: 1 }), window.hoursStart);
  }
  return dt;
}

/** How long a colleague has to reply before an outreach expires (R4 — a reminder, not a chase). */
const RESPONSE_DEADLINE_WORKING_HOURS = 24;

/**
 * Reply deadline: 24 WORKING hours from now in the colleague's timezone —
 * non-working hours/days (nights, weekends) don't count against the budget.
 * Work days/hours come from `defaultWorkingHoursForTz` (already used by
 * `attendeeAvailability.ts` for the same "what are this timezone's business
 * hours" question) rather than a second, from-scratch Mon–Fri/9-5
 * assumption — a colleague in a Sun–Thu zone gets a Sun–Thu budget, not a
 * Western one that silently treats their Friday as a working day.
 * Shared with message_colleague and outreach_expiry task scheduling.
 */
export function calcResponseDeadline(colleagueTz: string): string {
  const window = defaultWorkingHoursForTz(colleagueTz);
  const workStart = nextWorkingHourStart(colleagueTz, window);
  return addWorkingHours(workStart, RESPONSE_DEADLINE_WORKING_HOURS, window).toUTC().toISO()!;
}

/**
 * Colleague-shaped analogue of workHours.ts's `workTimeBaseFromNow` — same
 * shape (NOW if already inside work hours, else the ISO of the next
 * work-time start), but keyed off a COLLEAGUE's own timezone-inferred
 * workweek+hours (`defaultWorkingHoursForTz`), never the owner's YAML
 * schedule. Owner ruling (o#245/o#246, 2026-08-19): a human agent can't
 * ignore work times — the owner's OR anyone else's — so every colleague-
 * facing proactive send (reengagement DMs, re-asks) must land inside the
 * RECIPIENT's own hours and workweek, which may differ from the owner's
 * (e.g. Sun-Thu vs Mon-Fri). Reuses `nextWorkingHourStart`, the exact
 * day/hour walk `calcResponseDeadline` above already runs for the same
 * colleague — no second implementation of "is this a workday for them."
 *
 * `fromMs` (registrar bounce fix, scheduled-first-outreach-send-not-gated-
 * to-recipient-hours, wf_29a0d866-021 round 2) — optional anchor instant,
 * defaulting to now. Callers gating an explicit future ask (a send_at the
 * colleague requested) must search forward from THAT instant, not from
 * "now": searching from now only catches an ask that's already overdue,
 * and silently lets a future instant that lands on the colleague's
 * non-work day/hour (e.g. a Saturday for a Sun-Thu workweek) pass through
 * unchanged — the exact defect this param exists to close.
 */
export function colleagueWorkTimeBaseFromNow(colleagueTz: string | null | undefined, fromMs?: number): string {
  const tz = colleagueTz || 'UTC';
  const window = defaultWorkingHoursForTz(tz);
  return nextWorkingHourStart(tz, window, fromMs).toUTC().toISO()!;
}

/** Slop against a timer tick firing a few ms early and deferring a whole
 * extra day over it — shared by every `isColleagueSendDeferred` call site. */
const COLLEAGUE_SEND_GATE_SLOP_MS = 60_000;

/**
 * single-implementation-of-a-shared-rule (2026-08-24,
 * colleague-work-hours-gate-duplicated-across-five-call-sites) — every
 * colleague-facing send TIMER (reschedule re-ask, OOF reengage send + its
 * own re-ask, the first fire of a scheduled outreach) must defer to the
 * colleague's own work hours (R4) before it actually sends. Until now each
 * of those 4 call sites hand-copied the same
 * `Date.parse(colleagueWorkTimeBaseFromNow(tz)) > Date.now() + 60_000`
 * comparison with its own literal slop constant — one place a fixed slop
 * value, or the comparison itself, could silently drift from the other
 * three. Callers still own their own rearm handler name and log copy
 * (those legitimately differ per timer); only the deferral verdict itself
 * is unified here.
 *
 * NOT used by outreach.ts's schedule-time floor (a different question —
 * "what instant should this scheduled send persist as", not "should this
 * currently-firing timer defer itself") — that call site already rides the
 * single `colleagueWorkTimeBaseFromNow` this wraps.
 */
export function isColleagueSendDeferred(
  colleagueTz: string | null | undefined,
): { deferred: false } | { deferred: true; deferredTo: string } {
  const deferredTo = colleagueWorkTimeBaseFromNow(colleagueTz);
  if (Date.parse(deferredTo) > Date.now() + COLLEAGUE_SEND_GATE_SLOP_MS) {
    return { deferred: true, deferredTo };
  }
  return { deferred: false };
}
