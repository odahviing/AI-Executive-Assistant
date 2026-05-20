/**
 * v2.9.3 — make the user-curated "Calendar health check" routine fire twice
 * a day (morning + midday) without creating a parallel system routine.
 *
 * Background: the calendar-health active-mode flow now does a periodic
 * floating-block rebalance sweep on top of its issue-fix loop. The sweep
 * catches Outlook-direct entries that don't trip the per-mutation
 * `rebalanceFloatingBlocksAfterMutation` hook. Once a day at 07:30 isn't
 * enough — a meeting added to Outlook at 10:00 sits on top of lunch all
 * day until tomorrow morning's run.
 *
 * Owner direction: same cron, not a new system routine. So we extend
 * `schedule_time` to accept comma-separated times (parsed in
 * `parseScheduleTimes` / `computeNextRunAt`) and migrate the existing row.
 *
 * Idempotency: we only update when `schedule_time` is exactly `"07:30"`
 * AND the title matches the calendar-health routine AND `is_system=0`.
 * After the update the column reads `"07:30,13:00"` (has a comma), so the
 * next run no-ops. If the owner later sets the routine back to a single
 * time, the migration will re-apply — accepted edge case; he can edit via
 * manage_routine without re-running this migration's exact starting state.
 */

import type Database from 'better-sqlite3';
import logger from '../../utils/logger';

// Inline replica of computeNextRunAt for the single-slot path — the
// migration runs before any other imports settle, and we want to avoid a
// circular dep on src/tasks/crons.ts. Same logic, same output shape.
import { DateTime } from 'luxon';

interface RoutineRow {
  id: string;
  owner_user_id: string;
  title: string;
  schedule_type: string;
  schedule_time: string;
  schedule_day: string | null;
  is_system: number;
  status: string;
}

const luxonDayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function nextRunAtForSlot(
  scheduleType: string,
  h: number,
  m: number,
  scheduleDay: string | null,
  timezone: string,
): string {
  const base = DateTime.now().setZone(timezone);
  const snap = (dt: DateTime) =>
    dt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  const nextDay = (dt: DateTime) => snap(dt).plus({ days: 1 });

  let candidate = snap(base);

  switch (scheduleType) {
    case 'daily': {
      if (candidate <= base) candidate = nextDay(base);
      break;
    }
    case 'weekdays': {
      // Migration runs at startup before profile is fully loaded; use the
      // standard Mon-Fri default. The materializer recomputes the next
      // firing using the profile's actual work-days on completion anyway.
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
      if (candidate <= base) candidate = nextDay(base);
      let guard = 0;
      while (!days.includes(luxonDayNames[candidate.weekday]) && guard++ < 7) {
        candidate = nextDay(candidate);
      }
      break;
    }
  }
  return candidate.toUTC().toISO()!;
}

export function runV293CalendarHealthTwiceDaily(db: Database.Database, ownerTimezone: string): void {
  const row = db.prepare(`
    SELECT * FROM routines
    WHERE title = 'Calendar health check'
      AND schedule_time = '07:30'
      AND is_system = 0
      AND status = 'active'
    LIMIT 1
  `).get() as RoutineRow | undefined;

  if (!row) return;  // already migrated, or routine doesn't exist on this DB

  const newScheduleTime = '07:30,13:00';
  // Compute next_run_at = min(next 07:30 firing, next 13:00 firing). The
  // multi-time logic in computeNextRunAt does this at runtime; for the
  // migration we precompute both and pick the earliest.
  const next0730 = nextRunAtForSlot(row.schedule_type, 7, 30, row.schedule_day, ownerTimezone);
  const next1300 = nextRunAtForSlot(row.schedule_type, 13, 0, row.schedule_day, ownerTimezone);
  const newNextRunAt = Date.parse(next0730) <= Date.parse(next1300) ? next0730 : next1300;

  db.prepare(`
    UPDATE routines
       SET schedule_time = ?,
           next_run_at   = ?,
           updated_at    = datetime('now')
     WHERE id = ?
  `).run(newScheduleTime, newNextRunAt, row.id);

  logger.info('v2.9.3 migration — calendar health twice-daily applied', {
    routineId: row.id,
    oldScheduleTime: '07:30',
    newScheduleTime,
    newNextRunAt,
  });
}
