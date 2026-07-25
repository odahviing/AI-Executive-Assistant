/**
 * Pure module-level helpers extracted (v3.7.x) verbatim from ops.ts. No logic
 * changes — only relative import paths deepened by one level for the new
 * ops/ subdirectory. `buildOutOfHoursBusy` is live (used by the switch cases in
 * ops.ts); the other two feed action_summary / vacated-slot formatting.
 */
import { DateTime } from 'luxon';

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
