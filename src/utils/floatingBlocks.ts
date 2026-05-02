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
 * Given a set of busy blocks within a floating-block window, find the
 * earliest quarter-hour-aligned slot that fits `block.duration_minutes`
 * with `bufferMinutes` padding before (when preceded by another meeting)
 * and after (when followed by another meeting).
 *
 * Returns null if no aligned slot fits the whole duration.
 *
 * Used by book_floating_block and by findAvailableSlots' feasibility check —
 * "after putting the proposed meeting here, can THIS block still be
 * placed somewhere legal?".
 */
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

export function findAlignedSlotForBlock(
  block: FloatingBlock,
  dayDate: string,
  timezone: string,
  busyInWindow: Array<{ start: number; end: number }>,
  bufferMinutes: number,
): number | null {
  const windowStart = windowMsForDay(dayDate, block.preferred_start, timezone);
  const windowEnd = windowMsForDay(dayDate, block.preferred_end, timezone);
  const durationMs = block.duration_minutes * 60 * 1000;
  const bufferMs = bufferMinutes * 60 * 1000;

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
    const hasPrevBlock = i > 0;
    const earliest = hasPrevBlock ? prev + bufferMs : prev;
    const aligned = alignUpQuarter(earliest, timezone);
    const postBuffer = isTrailingGap ? 0 : bufferMs;
    if (
      aligned < gapEnd &&
      aligned + durationMs + postBuffer <= gapEnd &&
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
 * legal placement. Used by `prefer_position: 'latest_in_window'`. */
export function findLatestAlignedSlotForBlock(
  block: FloatingBlock,
  dayDate: string,
  timezone: string,
  busyInWindow: Array<{ start: number; end: number }>,
  bufferMinutes: number,
): number | null {
  const windowStart = windowMsForDay(dayDate, block.preferred_start, timezone);
  const windowEnd = windowMsForDay(dayDate, block.preferred_end, timezone);
  const durationMs = block.duration_minutes * 60 * 1000;
  const bufferMs = bufferMinutes * 60 * 1000;

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
  let next = windowEnd;
  for (let i = merged.length; i >= 0; i--) {
    const isLeadingGap = i === 0;
    const gapStart = isLeadingGap ? windowStart : merged[i - 1].end;
    if (gapStart >= next) {
      if (!isLeadingGap) next = merged[i - 1].start;
      continue;
    }
    const hasNextBlock = i < merged.length;
    const latestEnd = hasNextBlock ? next - bufferMs : next;
    const latestStart = latestEnd - durationMs;
    const aligned = alignDownQuarter(latestStart, timezone);
    const preBuffer = isLeadingGap ? 0 : bufferMs;
    if (
      aligned >= gapStart + preBuffer &&
      aligned >= windowStart &&
      aligned + durationMs <= latestEnd
    ) {
      return aligned;
    }
    if (!isLeadingGap) next = merged[i - 1].start;
  }
  return null;
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
 * Buffer rule for abut_*: the configured buffer is applied between the
 * abutted slot and the anchor (so "abut_before Yossi at 12:45" with
 * 5-min buffer + 25-min lunch lands at 12:15-12:40, not 12:20-12:45).
 */
export type PreferPosition = 'earliest' | 'latest_in_window' | 'abut_before' | 'abut_after';

export interface AnchorEvent {
  start: number;  // ms
  end: number;    // ms
}

export function findPositionalSlotForBlock(
  block: FloatingBlock,
  dayDate: string,
  timezone: string,
  busyInWindow: Array<{ start: number; end: number }>,
  bufferMinutes: number,
  preferPosition: PreferPosition,
  anchor?: AnchorEvent,
): { ms: number } | { error: string; detail: string } {
  const windowStart = windowMsForDay(dayDate, block.preferred_start, timezone);
  const windowEnd = windowMsForDay(dayDate, block.preferred_end, timezone);
  const durationMs = block.duration_minutes * 60 * 1000;
  const bufferMs = bufferMinutes * 60 * 1000;

  if (preferPosition === 'earliest') {
    const ms = findAlignedSlotForBlock(block, dayDate, timezone, busyInWindow, bufferMinutes);
    if (ms === null) return { error: 'no_room', detail: 'No aligned slot found in any gap (earliest scan).' };
    return { ms };
  }

  if (preferPosition === 'latest_in_window') {
    const ms = findLatestAlignedSlotForBlock(block, dayDate, timezone, busyInWindow, bufferMinutes);
    if (ms === null) return { error: 'no_room', detail: 'No aligned slot found in any gap (latest scan).' };
    return { ms };
  }

  // abut_before / abut_after — anchor required.
  if (!anchor) {
    return { error: 'anchor_required', detail: `prefer_position '${preferPosition}' requires anchor_event_id.` };
  }

  if (preferPosition === 'abut_before') {
    // Lunch must end at or before (anchor.start - buffer). Snap aligned-down
    // so the start is the latest aligned quarter-hour that still abuts.
    const latestEnd = anchor.start - bufferMs;
    const rawStart = latestEnd - durationMs;
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
    // OTHER than the anchor itself. Buffer applies on the trailing side
    // (already encoded by latestEnd subtraction); on the leading side, buffer
    // applies if there's a busy block ending close to this slot's start.
    const conflict = busyInWindow.find(b => {
      if (b.start === anchor.start && b.end === anchor.end) return false;
      // The slot occupies [aligned, aligned + duration]; with a leading buffer
      // it claims [aligned - buffer, aligned + duration].
      const claimStart = aligned - bufferMs;
      const claimEnd = aligned + durationMs;
      return b.start < claimEnd && b.end > claimStart;
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
    // Lunch must start at or after (anchor.end + buffer). Snap aligned-up.
    const earliestStart = anchor.end + bufferMs;
    const aligned = alignUpQuarter(earliestStart, timezone);
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
      const claimStart = aligned;
      const claimEnd = aligned + durationMs + bufferMs;
      return b.start < claimEnd && b.end > claimStart;
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
