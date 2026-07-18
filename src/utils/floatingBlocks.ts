/**
 * Floating blocks (v2.1).
 *
 * Single source of truth for "protected N-minute periods that can live
 * anywhere in a defined window". Lunch is the canonical example today —
 * but the concept is general: coffee break, thinking time, gym window,
 * daily writing hour, etc. All of these are elastic within their window
 * and requiring approval only to move OUTSIDE it.
 *
 * This module exposes:
 *   - FloatingBlock shape
 *   - getFloatingBlocks(profile) → list of blocks (lunch auto-promoted)
 *   - isFloatingBlockEvent(event, block) → does a calendar event match?
 *   - detectFloatingBlockEventInWindow(events, block, date, tz) → find the
 *       event on this day that corresponds to this block, if any
 *
 * The rest of the system (findAvailableSlots, book_floating_block,
 * check_join_availability) should ask THIS module whether a calendar event
 * is a floating block and should be treated as elastic — never hardcode
 * "lunch" again.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import logger from './logger';
import { findDeadGaps, type DensityConfig } from './calendarDensity';

export type WeekDay =
  | 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday'
  | 'Thursday' | 'Friday' | 'Saturday';

export interface FloatingBlock {
  name: string;
  preferred_start: string;   // "HH:MM"
  preferred_end: string;     // "HH:MM"
  duration_minutes: number;
  can_skip: boolean;
  /**
   * Days this block applies to. When omitted, the block applies to every
   * work day in the profile (office_days + home_days union). Use to scope
   * "Thursday coffee break" (['Thursday']) or "lunch every day except Tue"
   * (['Sunday','Monday','Wednesday','Thursday']).
   */
  days?: WeekDay[];
  match_subject_regex?: string;
  match_category?: string;
  default_subject?: string;
  default_category?: string;
  /**
   * Default placement preference within the preferred window. Honored by
   * the rebalance sweep when overlap forces a re-placement, and by the
   * initial book_floating_block call when no explicit prefer_position arg
   * is passed. Omitting → 'earliest_in_window'.
   */
  prefer_position?: 'earliest_in_window' | 'latest_in_window';
}

/**
 * Returns every floating block configured for this profile.
 *
 * v2.4.1 — single source. `schedule.lunch` legacy field was removed and
 * floating_blocks moved from `schedule.` to `meetings.` (floating blocks are
 * events that happen during the day, not part of the day-framework). All
 * blocks (lunch / coffee / gym / prayer / etc) live under
 * `meetings.floating_blocks` uniformly.
 */
export function getFloatingBlocks(profile: UserProfile): FloatingBlock[] {
  return (profile.meetings.floating_blocks ?? []) as FloatingBlock[];
}

/**
 * Synthetic event_id for a MISSING floating-block gap.
 *
 * A gap (the block isn't on the calendar that day) has no real Graph event,
 * so `calendar_issues` rows of class `missing_floating_block` use a
 * deterministic surrogate id: `{NNN}-{MMDDYYYY}-{HHMM}` where NNN is the
 * 1-based index of the block in `meetings.floating_blocks` and HHMM is its
 * preferred_start (owner-local).
 *
 * SINGLE SOURCE OF TRUTH (v3.1.7 / #119). Four call sites derive this id —
 * the detector (mints it when writing the cluster row), the preemptive-approve
 * path, the delete→dismiss path, and the detection-time suppression check. Any
 * divergence in the formula = no suppression match = the gap re-surfaces or
 * re-books, so it MUST live in one place. (Previously duplicated inline in
 * calendarHealth.ts at the detector + approve sites with a "drift = no
 * suppression" warning comment.)
 *
 * Index resolution mirrors the detector: an unconfigured/auto-promoted block
 * (e.g. lunch not listed explicitly) falls back to index 0 rather than
 * failing, so the id still matches what detection mints. Returns null only
 * when the date is unparseable.
 */
export function floatingBlockSyntheticEventId(
  profile: UserProfile,
  blockName: string,
  dateIso: string,            // YYYY-MM-DD (owner-local)
  timezone: string,
): { eventId: string; eventEndMs: number } | null {
  const fbs = (profile.meetings.floating_blocks ?? []) as FloatingBlock[];
  const idx = Math.max(0, fbs.findIndex(b => b.name === blockName));
  const block = fbs[idx];
  const start = block?.preferred_start ?? '00:00';
  const end = block?.preferred_end ?? '23:59';
  const dt = DateTime.fromISO(dateIso, { zone: timezone });
  if (!dt.isValid) return null;
  const mmddyyyy = `${String(dt.month).padStart(2, '0')}${String(dt.day).padStart(2, '0')}${dt.year}`;
  const hhmm = start.replace(':', '');
  const eventId = `${String(idx + 1).padStart(3, '0')}-${mmddyyyy}-${hhmm}`;
  const endDt = DateTime.fromISO(`${dateIso}T${end}`, { zone: timezone });
  const eventEndMs = endDt.isValid ? endDt.toMillis() : dt.endOf('day').toMillis();
  return { eventId, eventEndMs };
}

/**
 * Does this block apply on the given day-of-week?
 *
 * - `block.days` explicitly set → day must be in the list.
 * - `block.days` omitted → applies on every work day in the profile
 *   (office_days + home_days).
 *
 * Callers pass `dayName` as "Monday"/"Tuesday"/... (Luxon's EEEE format).
 */
export function blockAppliesOnDay(
  block: FloatingBlock,
  dayName: string,
  profile: UserProfile,
): boolean {
  if (block.days && block.days.length > 0) {
    return block.days.includes(dayName as WeekDay);
  }
  const workDays = new Set<string>([
    ...(profile.schedule.office_days.days as string[]),
    ...(profile.schedule.home_days.days as string[]),
  ]);
  return workDays.has(dayName);
}

/**
 * Does this calendar event look like THIS floating block?
 * Matches on subject regex OR category, generously (either is enough).
 */
export function isFloatingBlockEvent(
  event: { subject?: string | null; categories?: unknown },
  block: FloatingBlock,
): boolean {
  const subject = String(event.subject ?? '').toLowerCase();
  const categories: string[] = Array.isArray(event.categories) ? (event.categories as string[]) : [];

  // Subject regex match
  if (block.match_subject_regex) {
    try {
      if (new RegExp(block.match_subject_regex, 'i').test(subject)) return true;
    } catch { /* bad regex → fall through */ }
  } else if (subject.includes(block.name.replace(/_/g, ' ').toLowerCase())) {
    return true;  // default: subject contains block name
  }

  // Category match
  if (block.match_category && categories.includes(block.match_category)) return true;

  // Default: category equal to name with first letter capitalized
  const defaultCat = block.name.charAt(0).toUpperCase() + block.name.slice(1).replace(/_/g, ' ');
  if (categories.includes(defaultCat)) return true;

  return false;
}

/**
 * Parse "HH:MM" on a given date in a given timezone → millis.
 */
export function windowMsForDay(
  dayDate: string,
  hhmm: string,
  timezone: string,
): number {
  return DateTime.fromISO(`${dayDate}T${hhmm}`, { zone: timezone }).toMillis();
}

/**
 * Round a millis timestamp UP to the next quarter-hour in the given timezone.
 * Shared with book_floating_block so the same alignment logic applies everywhere.
 */
export function alignUpQuarter(ms: number, timezone: string): number {
  const dt = DateTime.fromMillis(ms).setZone(timezone);
  const minute = dt.minute;
  const remainder = minute % 15;
  if (remainder === 0 && dt.second === 0 && dt.millisecond === 0) return ms;
  const bumpMin = 15 - remainder;
  return dt
    .plus({ minutes: bumpMin })
    .set({ second: 0, millisecond: 0 })
    .toMillis();
}

/**
 * Round a millis timestamp to the NEAREST quarter-hour in the given timezone.
 * Half rounds up (8 min → next quarter). Used by override paths that accept
 * a free-form HH:MM from the owner and need to snap to the standard
 * :00/:15/:30/:45 grid the rest of the system assumes.
 */
export function alignNearestQuarter(ms: number, timezone: string): number {
  const dt = DateTime.fromMillis(ms).setZone(timezone);
  const minute = dt.minute;
  const remainder = minute % 15;
  if (remainder === 0 && dt.second === 0 && dt.millisecond === 0) return ms;
  // Round half up: remainder >= 8 → next quarter, else previous quarter.
  if (remainder >= 8) {
    return dt
      .plus({ minutes: 15 - remainder })
      .set({ second: 0, millisecond: 0 })
      .toMillis();
  }
  return dt
    .minus({ minutes: remainder })
    .set({ second: 0, millisecond: 0 })
    .toMillis();
}

/**
 * Round a millis timestamp DOWN to the previous quarter-hour in the given
 * timezone. Mirror of alignUpQuarter — used by abut_before to snap the
 * lunch start backwards to the latest aligned tick that still abuts.
 */
export function alignDownQuarter(ms: number, timezone: string): number {
  const dt = DateTime.fromMillis(ms).setZone(timezone);
  const minute = dt.minute;
  const remainder = minute % 15;
  if (remainder === 0 && dt.second === 0 && dt.millisecond === 0) return ms;
  return dt
    .minus({ minutes: remainder })
    .set({ second: 0, millisecond: 0 })
    .toMillis();
}

// v3.0.2 — buffer parameter removed. Floating blocks are personal time,
// not meeting-vs-meeting spacing. The 10/25/40/55 meeting durations
// already create natural 5-min gaps when stacked, so a separate buffer
// here was double-counting. Owner direction: "the buffer is maintained
// by booking meeting of 10/25/40/55." Per-meeting buffer rules still
// apply elsewhere (scheduleRules) — this is solely about whether a
// floating block can abut a meeting. Yes, it can.
export function findAlignedSlotForBlock(
  block: FloatingBlock,
  dayDate: string,
  timezone: string,
  busyInWindow: Array<{ start: number; end: number }>,
): number | null {
  const windowStart = windowMsForDay(dayDate, block.preferred_start, timezone);
  const windowEnd = windowMsForDay(dayDate, block.preferred_end, timezone);
  // DST spring-forward creates an invalid local time (the clock jumps
  // 02:00 → 03:00, so a block "02:00-04:00" has an unresolvable start).
  // Luxon's DateTime returns invalid for such times and toMillis() yields
  // NaN. NaN propagates silently through comparisons (every test returns
  // false), so the loop below would produce wrong results without explicit
  // failure. Guard up front: return null with a log so the caller surfaces
  // "no slot" rather than booking against garbage.
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    logger.warn('findAlignedSlotForBlock: invalid window (likely DST gap)', {
      block: block.name, dayDate, timezone,
      preferred_start: block.preferred_start, preferred_end: block.preferred_end,
    });
    return null;
  }
  const durationMs = block.duration_minutes * 60 * 1000;

  // Merge overlapping busy blocks
  const sorted = [...busyInWindow].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const b of sorted) {
    if (merged.length > 0 && b.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, b.end);
    } else {
      merged.push({ ...b });
    }
  }

  let prev = windowStart;
  for (let i = 0; i <= merged.length; i++) {
    const isTrailingGap = i === merged.length;
    const gapEnd = isTrailingGap ? windowEnd : merged[i].start;
    if (gapEnd <= prev) {
      if (!isTrailingGap) prev = merged[i].end;
      continue;
    }
    // Buffer removed — block may start right at the end of the previous
    // busy block (after quarter-hour alignment).
    const aligned = alignUpQuarter(prev, timezone);
    if (
      aligned < gapEnd &&
      aligned + durationMs <= gapEnd &&
      aligned + durationMs <= windowEnd
    ) {
      return aligned;
    }
    if (!isTrailingGap) prev = merged[i].end;
  }
  return null;
}

/** Mirror of findAlignedSlotForBlock that scans gaps right-to-left and
 * returns the LATEST aligned slot that fits — the start of the rightmost
 * legal placement. Used by `prefer_position: 'latest_in_window'`.
 * v3.0.2 — buffer parameter removed, same rationale as findAlignedSlotForBlock. */
export function findLatestAlignedSlotForBlock(
  block: FloatingBlock,
  dayDate: string,
  timezone: string,
  busyInWindow: Array<{ start: number; end: number }>,
): number | null {
  const windowStart = windowMsForDay(dayDate, block.preferred_start, timezone);
  const windowEnd = windowMsForDay(dayDate, block.preferred_end, timezone);
  const durationMs = block.duration_minutes * 60 * 1000;

  const sorted = [...busyInWindow].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const b of sorted) {
    if (merged.length > 0 && b.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, b.end);
    } else {
      merged.push({ ...b });
    }
  }

  // Scan right-to-left across gaps. Gap N is [merged[N-1].end, merged[N].start]
  // (or the trailing gap [last.end, windowEnd] when N === merged.length).
  // v3.0.2 — buffer removed; floating blocks may abut meetings freely.
  let next = windowEnd;
  for (let i = merged.length; i >= 0; i--) {
    const isLeadingGap = i === 0;
    const gapStart = isLeadingGap ? windowStart : merged[i - 1].end;
    if (gapStart >= next) {
      if (!isLeadingGap) next = merged[i - 1].start;
      continue;
    }
    const latestStart = next - durationMs;
    const aligned = alignDownQuarter(latestStart, timezone);
    if (
      aligned >= gapStart &&
      aligned >= windowStart &&
      aligned + durationMs <= next
    ) {
      return aligned;
    }
    if (!isLeadingGap) next = merged[i - 1].start;
  }
  return null;
}

/**
 * #133b — dense-mode consolidation target for an existing floating block.
 *
 * A floating block (lunch) placed so it leaves a DEAD sliver (buffer < gap <
 * minBreak — 6–29 min for Idan) on a side fragments the owner's free time into
 * unfocusable minutes instead of one real break. Because the block is elastic
 * within its window, the cheap fix is to SLIDE THE BLOCK (no attendees, no
 * cross-TZ) to abut a neighbour so the leftover coalesces into a single
 * ≥ minBreak break — or to drop the block into a gap it fits exactly.
 *
 * Returns the aligned start (ms) the block should move to, or null when moving
 * it wouldn't STRICTLY reduce the day's dead-gap minutes (already optimal, or
 * the gap simply can't be made clean). PURE — candidates come from the existing
 * window-aware finders, so they're already aligned, in-window, and
 * non-overlapping; the caller validates nothing further.
 *
 * `commitments` = the day's real meetings + any OTHER floating block (ms), NOT
 * this block. Only the two window extremes (earliest / latest aligned fit) are
 * scored: for a single gap the dead-minimising placement always abuts a
 * neighbour, so an extreme dominates any middle placement. `prefer_position`
 * breaks a tie (default earliest). The guard is one-directional — a missed
 * clever move just means "no move"; it can never make the day worse.
 */
export function findConsolidatingSlotForBlock(
  block: FloatingBlock,
  dayDate: string,
  timezone: string,
  commitments: Array<{ start: number; end: number }>,
  cfg: DensityConfig,
  currentBlockStartMs: number,
): number | null {
  const windowStart = windowMsForDay(dayDate, block.preferred_start, timezone);
  const windowEnd = windowMsForDay(dayDate, block.preferred_end, timezone);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return null;
  const durationMs = block.duration_minutes * 60 * 1000;

  const busyInWindow = commitments
    .map(m => ({ start: Math.max(m.start, windowStart), end: Math.min(m.end, windowEnd) }))
    .filter(m => m.end > m.start);

  const earliest = findAlignedSlotForBlock(block, dayDate, timezone, busyInWindow);
  const latest = findLatestAlignedSlotForBlock(block, dayDate, timezone, busyInWindow);

  // Total dead-gap minutes on the day with the block placed at `startMs`. The
  // meeting-to-meeting dead gaps are constant across placements, so comparing
  // this figure isolates the block-adjacent change.
  const deadMinutesFor = (startMs: number): number =>
    findDeadGaps([...commitments, { start: startMs, end: startMs + durationMs }], cfg)
      .reduce((sum, g) => sum + g.gapMinutes, 0);

  const currentDead = deadMinutesFor(currentBlockStartMs);

  // Honour prefer_position on a tie by trying the preferred extreme first.
  const order = block.prefer_position === 'latest_in_window'
    ? [latest, earliest]
    : [earliest, latest];
  let best: number | null = null;
  let bestDead = Infinity;
  for (const cand of order) {
    if (cand === null) continue;
    const d = deadMinutesFor(cand);
    if (d < bestDead) { bestDead = d; best = cand; }
  }

  if (best === null) return null;
  if (bestDead >= currentDead) return null;                          // no strict improvement — leave it
  if (Math.abs(best - currentBlockStartMs) < 60 * 1000) return null; // effectively the same slot
  return best;
}

/**
 * Positional slot picker — translates a human positional intent ("right
 * before Yossi", "right after Yossi", "latest spot in the window") into a
 * concrete aligned slot.
 *
 * Returns either { ms } on success, or { error, detail } on failure where
 * `error` is one of:
 *   - 'anchor_required'           — abut_* without anchor_event
 *   - 'anchor_outside_window'     — abut math lands outside the block window
 *   - 'anchor_conflicts_busy'     — the abutted slot collides with another busy block
 *   - 'no_room'                   — earliest/latest scan found no fit
 *
 * abut_* slots abut the anchor directly — no buffer is applied (v3.0.2).
 * Meeting durations (10/25/40/55) carry their own spacing; a separate
 * buffer here was double-counting. Quarter-hour alignment still enforced.
 */
export type PreferPosition = 'earliest' | 'latest_in_window' | 'abut_before' | 'abut_after';

export interface AnchorEvent {
  start: number;  // ms
  end: number;    // ms
}

// v3.0.2 — bufferMinutes parameter removed across the positional API. Same
// rationale as findAlignedSlotForBlock: meeting durations (10/25/40/55) carry
// the spacing; a separate buffer on floating-block math was double-counting.
export function findPositionalSlotForBlock(
  block: FloatingBlock,
  dayDate: string,
  timezone: string,
  busyInWindow: Array<{ start: number; end: number }>,
  preferPosition: PreferPosition,
  anchor?: AnchorEvent,
): { ms: number } | { error: string; detail: string } {
  const windowStart = windowMsForDay(dayDate, block.preferred_start, timezone);
  const windowEnd = windowMsForDay(dayDate, block.preferred_end, timezone);
  const durationMs = block.duration_minutes * 60 * 1000;

  if (preferPosition === 'earliest') {
    const ms = findAlignedSlotForBlock(block, dayDate, timezone, busyInWindow);
    if (ms === null) return { error: 'no_room', detail: 'No aligned slot found in any gap (earliest scan).' };
    return { ms };
  }

  if (preferPosition === 'latest_in_window') {
    const ms = findLatestAlignedSlotForBlock(block, dayDate, timezone, busyInWindow);
    if (ms === null) return { error: 'no_room', detail: 'No aligned slot found in any gap (latest scan).' };
    return { ms };
  }

  // abut_before / abut_after — anchor required.
  if (!anchor) {
    return { error: 'anchor_required', detail: `prefer_position '${preferPosition}' requires anchor_event_id.` };
  }

  if (preferPosition === 'abut_before') {
    // Block must end at or before anchor.start. Snap aligned-down so the
    // start is the latest aligned quarter-hour that still abuts.
    const rawStart = anchor.start - durationMs;
    const aligned = alignDownQuarter(rawStart, timezone);
    if (aligned < windowStart) {
      return {
        error: 'anchor_outside_window',
        detail: `abut_before lands at ${msToHHMM(aligned, timezone)}, before the window opens at ${block.preferred_start}.`,
      };
    }
    if (aligned + durationMs > windowEnd) {
      return {
        error: 'anchor_outside_window',
        detail: `abut_before lands at ${msToHHMM(aligned, timezone)}-${msToHHMM(aligned + durationMs, timezone)}, ending after the window closes at ${block.preferred_end}.`,
      };
    }
    // Conflict check — the abutted slot mustn't collide with any busy block
    // OTHER than the anchor itself.
    const conflict = busyInWindow.find(b => {
      if (b.start === anchor.start && b.end === anchor.end) return false;
      const claimEnd = aligned + durationMs;
      return b.start < claimEnd && b.end > aligned;
    });
    if (conflict) {
      return {
        error: 'anchor_conflicts_busy',
        detail: `abut_before would land at ${msToHHMM(aligned, timezone)}-${msToHHMM(aligned + durationMs, timezone)}, conflicting with a busy block at ${msToHHMM(conflict.start, timezone)}-${msToHHMM(conflict.end, timezone)}.`,
      };
    }
    return { ms: aligned };
  }

  if (preferPosition === 'abut_after') {
    // Block must start at or after anchor.end. Snap aligned-up.
    const aligned = alignUpQuarter(anchor.end, timezone);
    if (aligned < windowStart) {
      return {
        error: 'anchor_outside_window',
        detail: `abut_after lands at ${msToHHMM(aligned, timezone)}, before the window opens at ${block.preferred_start}.`,
      };
    }
    if (aligned + durationMs > windowEnd) {
      return {
        error: 'anchor_outside_window',
        detail: `abut_after lands at ${msToHHMM(aligned, timezone)}-${msToHHMM(aligned + durationMs, timezone)}, ending after the window closes at ${block.preferred_end}.`,
      };
    }
    const conflict = busyInWindow.find(b => {
      if (b.start === anchor.start && b.end === anchor.end) return false;
      const claimEnd = aligned + durationMs;
      return b.start < claimEnd && b.end > aligned;
    });
    if (conflict) {
      return {
        error: 'anchor_conflicts_busy',
        detail: `abut_after would land at ${msToHHMM(aligned, timezone)}-${msToHHMM(aligned + durationMs, timezone)}, conflicting with a busy block at ${msToHHMM(conflict.start, timezone)}-${msToHHMM(conflict.end, timezone)}.`,
      };
    }
    return { ms: aligned };
  }

  return { error: 'unknown_position', detail: `Unknown prefer_position: ${preferPosition}` };
}

function msToHHMM(ms: number, timezone: string): string {
  return DateTime.fromMillis(ms).setZone(timezone).toFormat('HH:mm');
}
