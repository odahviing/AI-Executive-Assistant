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
function nextWorkingHourStart(timezone: string, window: WorkWindow): DateTime {
  let dt = DateTime.now().setZone(timezone);

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

/** How long a colleague has to reply before an outreach expires (R5 — a reminder, not a chase). */
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
