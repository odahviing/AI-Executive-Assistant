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
 * The rest of the system (findAvailableSlots, book_lunch, check_join_
 * availability) should ask THIS module whether a calendar event is a
 * floating block and should be treated as elastic — never hardcode "lunch"
 * again.
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
 * Back-compat: `schedule.lunch` is auto-promoted to a FloatingBlock named
 * "lunch" so profiles that predate v2.1 keep working unchanged. If the
 * profile additionally defines `schedule.floating_blocks`, those are
 * appended. A custom block that re-declares name="lunch" overrides the
 * auto-promoted one.
 */
export function getFloatingBlocks(profile: UserProfile): FloatingBlock[] {
  const out: FloatingBlock[] = [];
  const byName = new Map<string, FloatingBlock>();

  // Auto-promote legacy lunch config
  if (profile.schedule.lunch) {
    const l = profile.schedule.lunch;
    const lunchBlock: FloatingBlock = {
      name: 'lunch',
      preferred_start: l.preferred_start,
      preferred_end: l.preferred_end,
      duration_minutes: l.duration_minutes,
      can_skip: l.can_skip,
      // Default matcher: literal block name with word boundaries (case-insensitive).
      // Owner can override via schedule.lunch.match_subject_regex /
      // schedule.lunch.match_category — e.g. to add Hebrew "ארוחת צהריים", or
      // to recognize "Dinner" / "Coffee" / a custom Outlook category.
      // `lunch` is only the back-compat name; the matching has always been
      // overridable, this just stops baking English+Hebrew defaults that
      // didn't generalize beyond the original profile.
      match_subject_regex: (l as { match_subject_regex?: string }).match_subject_regex ?? '\\blunch\\b',
      match_category: (l as { match_category?: string }).match_category ?? 'Lunch',
    };
    out.push(lunchBlock);
    byName.set(lunchBlock.name, lunchBlock);
  }

  // Append explicit floating_blocks
  const explicit = (profile.schedule as unknown as { floating_blocks?: FloatingBlock[] }).floating_blocks ?? [];
  for (const block of explicit) {
    if (byName.has(block.name)) {
      // Custom entry overrides the auto-promoted one with the same name.
      const idx = out.findIndex(b => b.name === block.name);
      out[idx] = block;
    } else {
      out.push(block);
    }
    byName.set(block.name, block);
  }
  return out;
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
 * Shared with book_lunch so the same alignment logic applies everywhere.
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
 * Used by book_lunch and by findAvailableSlots' feasibility check —
 * "after putting the proposed meeting here, can THIS block still be
 * placed somewhere legal?".
 */
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
