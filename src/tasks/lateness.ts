/**
 * Lateness policy for routine-materialized tasks (v1.5.1).
 *
 * The old "90-min circular distance" wall-clock check is gone. Instead: when
 * the task runner picks up a routine task, we check how late it is relative
 * to its cadence — if past the threshold, mark the task 'stale' and skip it
 * silently (the next firing will run on time).
 *
 * Thresholds (per the design approval):
 *   Sub-daily (e.g. every few hours): skip if late at all
 *   Daily: run if ≤ 4h late, else skip
 *   Every 2–6 days: run if ≤ 24h late, else skip
 *   Weekly (7–29 days): run if ≤ 48h late, else skip
 *   Monthly (30+ days): run if ≤ 7 days late, else skip
 *
 * Override: routines with `never_stale=1` ignore all thresholds — always run
 * at next opportunity no matter how delayed. Used for things that HAVE to
 * happen even late.
 */

import type { Routine } from './crons';

export type LatenessVerdict =
  | { run: true; latenessMinutes: number }
  | { run: false; reason: string; latenessMinutes: number };

function cadenceIntervalDays(r: Routine): number {
  switch (r.schedule_type) {
    case 'daily':
    case 'weekdays':
      return 1;
    case 'weekly':
      return 7;
    case 'monthly':
      return 30;
    default:
      return 1;
  }
}

/**
 * Returns the late-skip threshold in minutes for a given routine cadence.
 * `null` means "always skip if late at all" (sub-daily policy).
 */
function latenessThresholdMinutes(r: Routine): number | null {
  const days = cadenceIntervalDays(r);
  if (days < 1) return null;          // sub-daily → skip if late
  if (days === 1) return 4 * 60;      // daily → 4h
  if (days <= 6) return 24 * 60;      // every 2–6 days → 24h
  if (days <= 29) return 48 * 60;     // weekly-ish → 48h
  return 7 * 24 * 60;                 // monthly+ → 1 week
}

export function assessLateness(opts: {
  routine: Routine;
  scheduledAtIso: string;
  now?: Date;
}): LatenessVerdict {
  const now = opts.now ?? new Date();
  const scheduled = new Date(opts.scheduledAtIso).getTime();
  const latenessMinutes = Math.max(0, Math.round((now.getTime() - scheduled) / 60000));

  // Override flag — always run
  if ((opts.routine as any).never_stale === 1) {
    return { run: true, latenessMinutes };
  }

  const threshold = latenessThresholdMinutes(opts.routine);
  if (threshold === null) {
    // Sub-daily — if we're late at all (past scheduled), just skip and let
    // the next firing run. "Late at all" means > one 5-min tick, i.e. ~5 min.
    if (latenessMinutes > 5) {
      return { run: false, reason: `sub-daily routine > 5min late`, latenessMinutes };
    }
    return { run: true, latenessMinutes };
  }

  if (latenessMinutes > threshold) {
    const hours = Math.round(latenessMinutes / 60);
    return {
      run: false,
      reason: `${hours}h late exceeds ${Math.round(threshold / 60)}h threshold for ${opts.routine.schedule_type} cadence`,
      latenessMinutes,
    };
  }
  return { run: true, latenessMinutes };
}
