/**
 * scheduleRules (v2.7.0) — single source of truth for "is this slot OK to book?"
 *
 * Replaces the duplicate rule-application logic spread across:
 *   - find_available_slots (slot loop)
 *   - create_meeting Guards A+B
 *   - move_meeting rule-check
 *   - coordinate_meeting slot loop
 *
 * Each of those used to apply slightly different subsets of the same rules.
 * Now they all call `checkSlot(...)` and get one consistent verdict + label.
 *
 * Rules checked, in order. First violation wins (caller gets ONE label):
 *   1. vacation_or_off_day        — Friday/Saturday for Idan's profile
 *   2. category_day_type          — category requires office_days but slot is home day
 *   3. category_per_day           — at-limit for this category on this day
 *   4. category_per_week          — at-limit for this category this ISO week
 *   5. outside_working_hours      — slot starts before hours_start or ends after hours_end
 *                                   (bypassed when allow_relaxed = true)
 *   6. floating_block_overlap     — lunch / focus block conflict in profile.meetings.floating_blocks
 *                                   (bypassed when allow_relaxed = true)
 *   7. travel_buffer_collision    — category.requires_travel_buffer & adjacent meeting too tight
 *   8. owner_busy_collision       — owner has a hard conflict (delegated to caller's getCalendarEvents)
 *
 * NOTE on between-meeting buffer (v2.7.1) — the 5-min buffer is NOT enforced
 * as a collision rule. The allowed durations (10/25/40/55) and aligned starts
 * (:00/:15/:30/:45) already bake in 5 min of trailing gap by design. A 55-min
 * meeting starting where another ends is fine — connected back-to-back is the
 * preferred shape, not a violation. (Prior wave had rule (9)
 * `owner_buffer_collision`; deleted v2.7.1.)
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import type { CalendarEvent } from '../connectors/graph/calendar';
import { checkCategorySlot, getProfileCategoryByName } from './categoryRules';

export type RuleViolationKind =
  | 'vacation_or_off_day'
  | 'category_day_type'
  | 'category_per_day'
  | 'category_per_week'
  | 'outside_working_hours'
  | 'floating_block_overlap'
  | 'travel_buffer_collision'
  | 'owner_busy_collision'
  | 'attendee_busy_collision';

export interface RuleCheckInput {
  profile: UserProfile;
  slotStartIso: string;             // inclusive
  slotEndIso: string;               // exclusive
  category: string | null;
  events: CalendarEvent[];          // owner's events covering at least slot's week
  excludeEventIds?: string[];       // for move: drop the moving event from collision detection
  allowRelaxed?: boolean;           // owner override mode — bypass soft rules
}

export interface RuleCheckResult {
  passes: boolean;
  violation_kind?: RuleViolationKind;
  violation_label?: string;          // short human phrase suitable for an approval ask_text
}

export function checkSlot(input: RuleCheckInput): RuleCheckResult {
  const { profile } = input;
  const tz = profile.user.timezone;
  const slotStart = DateTime.fromISO(input.slotStartIso).setZone(tz);
  const slotEnd = DateTime.fromISO(input.slotEndIso).setZone(tz);
  const excludeSet = new Set(input.excludeEventIds ?? []);
  const dayName = slotStart.toFormat('EEEE');

  // ── (1) vacation / off day ──────────────────────────────────────────────
  const officeDays = profile.schedule.office_days.days as string[];
  const homeDays = profile.schedule.home_days.days as string[];
  if (!officeDays.includes(dayName) && !homeDays.includes(dayName)) {
    return {
      passes: false,
      violation_kind: 'vacation_or_off_day',
      violation_label: `${dayName} isn't one of ${profile.user.name.split(' ')[0]}'s working days`,
    };
  }

  // ── (2-4) category rules ────────────────────────────────────────────────
  const catCheck = checkCategorySlot({
    slotStart,
    slotEnd,
    categoryName: input.category,
    events: input.events,
    profile,
    excludeEventId: input.excludeEventIds?.[0],  // checkCategorySlot supports single exclude
  });
  if (!catCheck.allowed) {
    const map: Record<string, RuleViolationKind> = {
      day_type: 'category_day_type',
      per_day: 'category_per_day',
      per_week: 'category_per_week',
    };
    return {
      passes: false,
      violation_kind: map[catCheck.rule_broken!] ?? 'category_day_type',
      violation_label: catCheck.human_explanation ?? `${input.category} category rule violated`,
    };
  }

  // ── (5) working hours ───────────────────────────────────────────────────
  // Day-specific hours: office_days vs home_days carry independent ranges.
  if (!input.allowRelaxed) {
    const sched = officeDays.includes(dayName) ? profile.schedule.office_days : profile.schedule.home_days;
    const [hsH, hsM] = (sched.hours_start as string).split(':').map(Number);
    const [heH, heM] = (sched.hours_end as string).split(':').map(Number);
    const windowStart = slotStart.set({ hour: hsH, minute: hsM, second: 0, millisecond: 0 });
    const windowEnd = slotStart.set({ hour: heH, minute: heM, second: 0, millisecond: 0 });
    if (slotStart < windowStart || slotEnd > windowEnd) {
      return {
        passes: false,
        violation_kind: 'outside_working_hours',
        violation_label: `Slot ${slotStart.toFormat('HH:mm')}–${slotEnd.toFormat('HH:mm')} is outside working hours (${sched.hours_start}–${sched.hours_end})`,
      };
    }
  }

  // ── (6) floating block overlap — MOVABILITY CHECK ───────────────────────
  // v2.7.0 — floating blocks (lunch, coffee, focus) live in a preferred
  // window WIDER than their duration. Lunch is 25min inside an 11:30-13:30
  // (120min) window — the block can shift. A new slot inside the window is
  // a problem ONLY when accommodating it leaves no contiguous free segment
  // ≥ block.duration_minutes elsewhere in the window.
  //
  // Algorithm per block:
  //   1. Bound the window to today (slotStart's day).
  //   2. Collect busy intervals inside the window from input.events
  //      (excluding excludeEventIds + cancelled + free-shows).
  //   3. Add the proposed slot to the busy set (clipped to the window).
  //   4. Compute the union of busy intervals; compute the FREE intervals
  //      that remain inside the window.
  //   5. If max(free interval length) >= block.duration_minutes → pass.
  //      Otherwise: fail with a label naming the block.
  if (!input.allowRelaxed) {
    const blocks = profile.meetings?.floating_blocks ?? [];
    for (const block of blocks) {
      const [psH, psM] = block.preferred_start.split(':').map(Number);
      const [peH, peM] = block.preferred_end.split(':').map(Number);
      const windowStart = slotStart.set({ hour: psH, minute: psM, second: 0, millisecond: 0 });
      const windowEnd = slotStart.set({ hour: peH, minute: peM, second: 0, millisecond: 0 });
      // If the proposed slot doesn't overlap the window at all, no concern.
      if (slotEnd <= windowStart || slotStart >= windowEnd) continue;

      const blockDurationMin = block.duration_minutes ?? 25;

      // Collect busy intervals inside the window (today only).
      const busyInWindow: Array<{ start: number; end: number }> = [];
      for (const ev of input.events) {
        if (ev.isCancelled) continue;
        if (excludeSet.has(ev.id)) continue;
        if ((ev as any).showAs === 'free') continue;
        const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
        const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' });
        // Skip if event doesn't overlap the window.
        if (evEnd <= windowStart || evStart >= windowEnd) continue;
        // Skip if this IS the floating block itself (subject matches the
        // block's name — lunch / coffee / etc). It will shift, not collide.
        const subj = (ev.subject ?? '').toLowerCase();
        const blockName = block.name.toLowerCase();
        if (subj.includes(blockName)) continue;
        busyInWindow.push({
          start: Math.max(evStart.toMillis(), windowStart.toMillis()),
          end: Math.min(evEnd.toMillis(), windowEnd.toMillis()),
        });
      }
      // Add the proposed slot, clipped to the window.
      busyInWindow.push({
        start: Math.max(slotStart.toMillis(), windowStart.toMillis()),
        end: Math.min(slotEnd.toMillis(), windowEnd.toMillis()),
      });

      // Merge overlapping intervals.
      busyInWindow.sort((a, b) => a.start - b.start);
      const merged: Array<{ start: number; end: number }> = [];
      for (const iv of busyInWindow) {
        const last = merged[merged.length - 1];
        if (last && iv.start <= last.end) {
          last.end = Math.max(last.end, iv.end);
        } else {
          merged.push({ ...iv });
        }
      }

      // Compute longest free contiguous segment inside the window.
      let longestFreeMs = 0;
      let cursor = windowStart.toMillis();
      const winEndMs = windowEnd.toMillis();
      for (const busy of merged) {
        if (busy.start > cursor) {
          longestFreeMs = Math.max(longestFreeMs, busy.start - cursor);
        }
        cursor = Math.max(cursor, busy.end);
      }
      if (cursor < winEndMs) {
        longestFreeMs = Math.max(longestFreeMs, winEndMs - cursor);
      }
      const longestFreeMin = Math.floor(longestFreeMs / 60_000);

      if (longestFreeMin < blockDurationMin) {
        return {
          passes: false,
          violation_kind: 'floating_block_overlap',
          violation_label: `Booking this would leave no room for ${profile.user.name.split(' ')[0]}'s ${block.name} (${blockDurationMin}min needed in ${block.preferred_start}–${block.preferred_end} window; only ${longestFreeMin}min free after this slot)`,
        };
      }
    }
  }

  // ── (7) travel buffer ───────────────────────────────────────────────────
  const cat = getProfileCategoryByName(profile, input.category);
  const needsTravelBuffer = cat?.requires_travel_buffer === true;
  if (needsTravelBuffer) {
    // No dedicated travel_buffer_minutes field in the schema — default 30min
    // per side for any category flagged requires_travel_buffer.
    const bufMin = 30;
    const beforeWindowStart = slotStart.minus({ minutes: bufMin });
    const afterWindowEnd = slotEnd.plus({ minutes: bufMin });
    for (const ev of input.events) {
      if (ev.isCancelled) continue;
      if (excludeSet.has(ev.id)) continue;
      const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
      const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' });
      if (evStart < afterWindowEnd && evEnd > beforeWindowStart) {
        // Only collide if the touching event isn't ALSO at the same external venue.
        return {
          passes: false,
          violation_kind: 'travel_buffer_collision',
          violation_label: `${input.category} needs ${bufMin}min travel buffer on each side; adjacent meeting at ${evStart.setZone(tz).toFormat('HH:mm')} too close`,
        };
      }
    }
  }

  // ── (8) hard busy collision ─────────────────────────────────────────────
  for (const ev of input.events) {
    if (ev.isCancelled) continue;
    if (excludeSet.has(ev.id)) continue;
    if ((ev as any).showAs === 'free') continue;  // free/tentative blocks don't collide
    const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
    const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' });
    if (evStart < slotEnd && evEnd > slotStart) {
      return {
        passes: false,
        violation_kind: 'owner_busy_collision',
        violation_label: `${profile.user.name.split(' ')[0]} is already busy at this time ("${ev.subject ?? 'meeting'}" ${evStart.setZone(tz).toFormat('HH:mm')}–${evEnd.setZone(tz).toFormat('HH:mm')})`,
      };
    }
  }

  // v2.7.1 — rule (9) owner_buffer_collision deleted. The 5-min between-meeting
  // buffer is baked into the standard durations (10/25/40/55) at aligned
  // starts (:00/:15/:30/:45). Connected back-to-backs are fine; a separate
  // collision check duplicated the work and incorrectly rejected slots like
  // 17:00 directly after a meeting ending 17:00.

  return { passes: true };
}
