/**
 * Category scheduling rules — single source of truth for "can this slot
 * be booked under this category?"
 *
 * v2.6 — extends categories from labels-only to rule-bearing primitives.
 * Each category in `profile.categories` can carry:
 *   - limits.per_day / limits.per_week  (max-count windows)
 *   - day_type ('office_days' | 'home_days' | 'any')
 *   - default_location / default_is_online / requires_travel_buffer
 *
 * Three exports:
 *   resolveCategoryByPriority — pick the FIRST matching category from a
 *     candidate list (yaml ORDER is priority)
 *   checkCategorySlot         — is this slot allowed for this category?
 *     fired at booking time by find_available_slots, create_meeting,
 *     move_meeting
 *   countCategoryOccurrences  — how many events of this category fall in
 *     a given window? (per-day / per-week count)
 *   findCategoryViolations    — report-only sweep of a whole range; fired
 *     by the daily calendar-health routine AND interactive analyze_calendar
 *
 * The helper is INTENTIONALLY agnostic to category names. It reads
 * profile.categories[] and applies whatever rules each entry carries.
 * Adding / renaming / reordering categories is a yaml-only change.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import type { CalendarEvent } from '../connectors/graph/calendar';
import logger from './logger';

export type CategoryRuleBroken =
  | 'day_type'
  | 'per_day'
  | 'per_week';

export interface CategoryCheckResult {
  allowed: boolean;
  rule_broken?: CategoryRuleBroken;
  rule_value?: number;       // limit.per_day = 2 → rule_value = 2
  current_count?: number;    // events already on the calendar in the window
  human_explanation?: string;
}

type ProfileCategory = NonNullable<UserProfile['categories']>[number];

/**
 * Walk the profile's categories list (in yaml ORDER) and return the
 * resolved category for an event with a given set of candidate names.
 * Earlier in the array = higher priority.
 *
 * @param candidateNames Categories the event matches (Graph categories
 *                       array, or Sonnet's classification candidates).
 * @returns The first matching profile category, or undefined when none
 *          of the candidates appear in the profile.
 */
export function resolveCategoryByPriority(
  profile: UserProfile,
  candidateNames: string[],
): ProfileCategory | undefined {
  const cats = profile.categories ?? [];
  if (cats.length === 0 || candidateNames.length === 0) return undefined;
  const candidateSet = new Set(candidateNames.map(n => n.toLowerCase()));
  for (const cat of cats) {
    if (candidateSet.has(cat.name.toLowerCase())) return cat;
  }
  return undefined;
}

/**
 * Look up a profile category by exact name (case-insensitive).
 * Returns undefined when the name doesn't appear in the profile.
 * Use this when the caller already knows the resolved category name
 * (e.g. Sonnet passed `category: 'Interview'` to create_meeting).
 */
export function getProfileCategoryByName(
  profile: UserProfile,
  name: string | undefined | null,
): ProfileCategory | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return (profile.categories ?? []).find(c => c.name.toLowerCase() === lower);
}

/**
 * Count how many events of a given category fall within a window.
 * Window is owner-TZ aligned (start-of-day for per-day, ISO week start
 * for per-week). Used for both rule-checks (find_available_slots,
 * create_meeting) and reports (analyze_calendar).
 *
 * Cancelled events and the proposed-slot itself (if `excludeEventId`
 * supplied) are excluded.
 */
export function countCategoryOccurrences(opts: {
  events: CalendarEvent[];
  categoryName: string;
  windowStart: DateTime;   // inclusive
  windowEnd: DateTime;     // exclusive
  excludeEventId?: string; // when checking a move, exclude the event being moved
}): number {
  const lowerCat = opts.categoryName.toLowerCase();
  let count = 0;
  for (const ev of opts.events) {
    if (ev.isCancelled) continue;
    if (opts.excludeEventId && ev.id === opts.excludeEventId) continue;
    const evCategories = ev.categories ?? [];
    if (!evCategories.some(c => c.toLowerCase() === lowerCat)) continue;
    // Event falls in window if its start < windowEnd AND end > windowStart.
    const startTz = ev.start.timeZone ?? 'utc';
    const endTz = ev.end.timeZone ?? 'utc';
    const evStart = DateTime.fromISO(ev.start.dateTime, { zone: startTz });
    const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: endTz });
    if (!evStart.isValid || !evEnd.isValid) continue;
    if (evStart < opts.windowEnd && evEnd > opts.windowStart) count++;
  }
  return count;
}

/**
 * Check whether a proposed slot is allowed under a category's rules.
 *
 * Three rule types checked, in this order:
 *   1. day_type  — proposed slot's weekday matches category's allowed days
 *   2. per_day   — slot's day count under limit
 *   3. per_week  — slot's ISO week count under limit
 *
 * The first failing rule short-circuits — caller gets ONE rule_broken
 * + a human_explanation suitable for an approval ask_text or a tool
 * result message.
 *
 * Returns { allowed: true } when the category isn't found in profile,
 * has no rules, or the slot passes — keeps callers simple. The
 * "no enforcement when category absent" semantics let owners run with
 * a partial categories list.
 */
export function checkCategorySlot(opts: {
  slotStart: DateTime;     // owner TZ
  slotEnd: DateTime;       // owner TZ
  categoryName: string | undefined | null;
  events: CalendarEvent[]; // owner's events covering at least the slot's week
  profile: UserProfile;
  excludeEventId?: string; // for move_meeting: exclude the event being moved
}): CategoryCheckResult {
  if (!opts.categoryName) return { allowed: true };
  const cat = getProfileCategoryByName(opts.profile, opts.categoryName);
  if (!cat) return { allowed: true };

  // ── Rule 1: day_type ────────────────────────────────────────────────────
  const dayType = cat.day_type ?? 'any';
  if (dayType !== 'any') {
    const dayName = opts.slotStart.toFormat('EEEE');
    const officeDays = opts.profile.schedule.office_days.days as string[];
    const homeDays = opts.profile.schedule.home_days.days as string[];
    const allowedDays = dayType === 'office_days' ? officeDays : homeDays;
    if (!allowedDays.includes(dayName)) {
      return {
        allowed: false,
        rule_broken: 'day_type',
        human_explanation: `${cat.name} can only be booked on ${dayType.replace('_', ' ')} (${allowedDays.join(', ')}); the proposed slot is on ${dayName}.`,
      };
    }
  }

  // ── Rule 2: per_day ─────────────────────────────────────────────────────
  const perDay = cat.limits?.per_day;
  if (perDay !== undefined && perDay >= 0) {
    const dayStart = opts.slotStart.startOf('day');
    const dayEnd = dayStart.plus({ days: 1 });
    const count = countCategoryOccurrences({
      events: opts.events,
      categoryName: cat.name,
      windowStart: dayStart,
      windowEnd: dayEnd,
      excludeEventId: opts.excludeEventId,
    });
    if (count >= perDay) {
      return {
        allowed: false,
        rule_broken: 'per_day',
        rule_value: perDay,
        current_count: count,
        human_explanation: `${cat.name} limit is ${perDay} per day; ${dayStart.toFormat('EEEE d MMMM')} already has ${count}.`,
      };
    }
  }

  // ── Rule 3: per_week ────────────────────────────────────────────────────
  const perWeek = cat.limits?.per_week;
  if (perWeek !== undefined && perWeek >= 0) {
    // Luxon weeks start Monday by default. ISO week semantics.
    const weekStart = opts.slotStart.startOf('week');
    const weekEnd = weekStart.plus({ weeks: 1 });
    const count = countCategoryOccurrences({
      events: opts.events,
      categoryName: cat.name,
      windowStart: weekStart,
      windowEnd: weekEnd,
      excludeEventId: opts.excludeEventId,
    });
    if (count >= perWeek) {
      return {
        allowed: false,
        rule_broken: 'per_week',
        rule_value: perWeek,
        current_count: count,
        human_explanation: `${cat.name} limit is ${perWeek} per week; the week of ${weekStart.toFormat('d MMMM')} already has ${count}.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Diagnostic helper — used by analyze_calendar / brief reports to surface
 * "Tuesday has 3 interviews, 1 over limit" style entries. Returns ALL
 * windows that exceed limits in the given event range.
 */
export interface CategoryViolation {
  category_name: string;
  rule_broken: 'per_day' | 'per_week';
  rule_value: number;
  current_count: number;
  window_label: string;       // "Tuesday 6 May" or "week of 5 May"
  window_start: string;       // ISO date
  event_ids: string[];        // events in this window for owner reference
}

export function findCategoryViolations(opts: {
  events: CalendarEvent[];
  profile: UserProfile;
  rangeStart: DateTime;       // owner-TZ start of analysis window
  rangeEnd: DateTime;         // owner-TZ end (exclusive)
}): CategoryViolation[] {
  const violations: CategoryViolation[] = [];
  const cats = opts.profile.categories ?? [];

  for (const cat of cats) {
    if (!cat.limits) continue;

    // per_day: walk each calendar day in the range
    if (cat.limits.per_day !== undefined) {
      let cursor = opts.rangeStart.startOf('day');
      while (cursor < opts.rangeEnd) {
        const dayEnd = cursor.plus({ days: 1 });
        const dayEvents = opts.events.filter(ev => {
          const evCategories = ev.categories ?? [];
          if (!evCategories.some(c => c.toLowerCase() === cat.name.toLowerCase())) return false;
          if (ev.isCancelled) return false;
          const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
          return evStart >= cursor && evStart < dayEnd;
        });
        if (dayEvents.length > cat.limits.per_day) {
          violations.push({
            category_name: cat.name,
            rule_broken: 'per_day',
            rule_value: cat.limits.per_day,
            current_count: dayEvents.length,
            window_label: cursor.toFormat('EEEE d MMMM'),
            window_start: cursor.toISODate() ?? '',
            event_ids: dayEvents.map(e => e.id),
          });
        }
        cursor = dayEnd;
      }
    }

    // per_week
    if (cat.limits.per_week !== undefined) {
      let cursor = opts.rangeStart.startOf('week');
      while (cursor < opts.rangeEnd) {
        const weekEnd = cursor.plus({ weeks: 1 });
        const weekEvents = opts.events.filter(ev => {
          const evCategories = ev.categories ?? [];
          if (!evCategories.some(c => c.toLowerCase() === cat.name.toLowerCase())) return false;
          if (ev.isCancelled) return false;
          const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
          return evStart >= cursor && evStart < weekEnd;
        });
        if (weekEvents.length > cat.limits.per_week) {
          violations.push({
            category_name: cat.name,
            rule_broken: 'per_week',
            rule_value: cat.limits.per_week,
            current_count: weekEvents.length,
            window_label: `week of ${cursor.toFormat('d MMMM')}`,
            window_start: cursor.toISODate() ?? '',
            event_ids: weekEvents.map(e => e.id),
          });
        }
        cursor = weekEnd;
      }
    }
  }

  if (violations.length > 0) {
    logger.info('findCategoryViolations — found', {
      count: violations.length,
      summary: violations.map(v => `${v.category_name} ${v.rule_broken}=${v.current_count}/${v.rule_value} on ${v.window_label}`),
    });
  }

  return violations;
}
