/**
 * weekdayGuard (#135b) — deterministic weekday-vs-resolved-date sanity check.
 *
 * The F2 "wrong-week / wrong-day" class: the owner names a weekday ("move it
 * back to Thursday"), the model resolves it to a date, and sometimes resolves
 * to the WRONG date — e.g. "Thursday" written as Friday 26 Jun. There was no
 * code backstop comparing the named weekday to the resolved date, so the wrong
 * day got written.
 *
 * This is the one shared check `create_meeting` and `move_meeting` both call
 * (one function, two call sites — not duplicated logic). It compares NUMBERS,
 * not words, so it is language-agnostic (Maelle is multi-lingual): the model
 * passes the named weekday as 1=Monday … 7=Sunday (luxon's `weekday`), and we
 * compare it to the resolved start's weekday. On a mismatch we hand back the
 * corrected date — the SAME weekday within the resolved week — so the model can
 * re-issue in the same turn without bouncing back to the owner.
 */
import { DateTime } from 'luxon';

export interface WeekdayMismatch {
  ok: false;
  namedWeekday: number;       // 1=Mon … 7=Sun, as supplied
  resolvedWeekday: number;    // what the resolved start actually is
  resolvedDate: string;       // yyyy-MM-dd of the resolved start
  correctedStartIso: string;  // same clock time, weekday corrected within the resolved ISO week
}

/**
 * Returns `{ ok: true }` when there's nothing to check (no weekday named, out
 * of range, or unparseable start — fail OPEN, never block on our own
 * uncertainty) or when the weekday matches. Returns a `WeekdayMismatch` only
 * when the model named a weekday that contradicts the date it resolved.
 */
export function checkIntendedWeekday(
  startIso: string | undefined,
  intendedWeekday: number | undefined,
  timezone: string,
): { ok: true } | WeekdayMismatch {
  if (!intendedWeekday || intendedWeekday < 1 || intendedWeekday > 7) return { ok: true };
  if (!startIso) return { ok: true };
  const dt = DateTime.fromISO(startIso, { zone: timezone });
  if (!dt.isValid) return { ok: true };
  if (dt.weekday === intendedWeekday) return { ok: true };
  // Correct to the NEAREST date matching the intended weekday, keeping the clock
  // time. luxon `set({ weekday })` moves within the ISO week (Mon=1…Sun=7), so
  // Sunday (ISO 7, the LAST ISO day) always lands at the END of the ISO week —
  // for a Sun-start owner (Idan, Sun–Thu) that overshoots ~5 days forward (next
  // week) instead of the ~2 days back that was meant (#audit 2026-07-21). Nearest
  // match is week-start-agnostic and matches ISO `set` for the common ±1 mis-resolve.
  let delta = intendedWeekday - dt.weekday;   // -6..6
  if (delta > 3) delta -= 7;                  // >3 forward → go back instead
  if (delta < -3) delta += 7;                 // >3 back → go forward instead
  const corrected = dt.plus({ days: delta });
  return {
    ok: false,
    namedWeekday: intendedWeekday,
    resolvedWeekday: dt.weekday,
    resolvedDate: dt.toFormat('yyyy-MM-dd'),
    correctedStartIso: corrected.toISO() ?? startIso,
  };
}
