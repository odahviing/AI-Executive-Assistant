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
 *   0. in_the_past                — the slot start is already in the past
 *   1. vacation_or_off_day        — Friday/Saturday for Idan's profile
 *   2. category_day_type          — category requires office_days but slot is home day
 *   3. category_per_day           — at-limit for this category on this day
 *   4. category_per_week          — at-limit for this category this ISO week
 *   5. outside_working_hours      — slot falls outside ALL of the day's work_hours
 *                                   windows (multi-window aware)
 *                                   (bypassed when allow_relaxed = true)
 *   6. floating_block_overlap     — lunch / focus block conflict in profile.meetings.floating_blocks
 *                                   (bypassed when allow_relaxed = true)
 *   7. travel_buffer_collision    — category.requires_travel_buffer & adjacent meeting too tight
 *   8. owner_busy_collision       — owner has a hard conflict (delegated to caller's getCalendarEvents)
 *                                   (bypassed when allow_relaxed = true OR isFloatingBlock = true —
 *                                    owner can override his own time; signals coexist with meetings)
 *   9. focus_time_floor           — booking would drop the day below the configured
 *                                   length-based free-time floor (bypassed when
 *                                   allow_relaxed = true OR isFloatingBlock = true)
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
import { getFloatingBlocks, isFloatingBlockEvent } from './floatingBlocks';
import { getEffectiveWorkDayForInstant, slotDayMinutes, type EffectiveWorkDay } from './workHours';

export type RuleViolationKind =
  | 'in_the_past'
  | 'vacation_or_off_day'
  | 'category_day_type'
  | 'category_per_day'
  | 'category_per_week'
  | 'outside_working_hours'
  | 'floating_block_overlap'
  | 'travel_buffer_collision'
  | 'owner_busy_collision'
  | 'attendee_busy_collision'
  | 'focus_time_floor';

// ── v3.1.2 (C) — Shared daily-focus-time helper ─────────────────────────────
//
// Single source of truth for "how much quality free time does this day have."
// "Quality" = contiguous chunks of at least `thinking_time_min_chunk_minutes`
// (the profile setting); a 10-min gap between two meetings is breathing room,
// not focus time, and doesn't count. This same math powers two surfaces:
//
//   - find_available_slots — per-slot loop rejects slots that would drop the
//     day under the configured length-based free-time floor
//     (requiredFreeMinutesForWorkDay). v3.1.2 (C) — the search path consumes
//     this floor only transitively, by routing through checkSlot rule (9).
//   - checkSlot rule (9) — write-path validation. Pre-fix the floor was
//     enforced ONLY at search time, so a named-time create_meeting /
//     move_meeting / coord pick could book on a packed day that
//     find_available_slots would have refused. Owner direction (3.1.2):
//     ONE check, both surfaces. Relaxed-mode bypass preserved — explicit
//     owner override is the approval, same as every other soft rule.
//
// Pure function: no DB, no profile, easy to test.
export function computeDayQualityFreeMinutes(params: {
  dayDate: string;           // YYYY-MM-DD
  timezone: string;          // IANA
  workStart: string;         // 'HH:MM'
  workEnd: string;           // 'HH:MM'
  busyBlocks: Array<{ start: Date; end: Date }>;
  minChunkMinutes: number;
}): number {
  const { dayDate, timezone, workStart, workEnd, busyBlocks, minChunkMinutes } = params;
  const dayStartMs = DateTime.fromISO(`${dayDate}T${workStart}`, { zone: timezone }).toMillis();
  const dayEndMs   = DateTime.fromISO(`${dayDate}T${workEnd}`,   { zone: timezone }).toMillis();

  const dayBusy = busyBlocks
    .filter(b => b.start.getTime() < dayEndMs && b.end.getTime() > dayStartMs)
    .map(b => ({
      start: Math.max(b.start.getTime(), dayStartMs),
      end:   Math.min(b.end.getTime(), dayEndMs),
    }))
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const block of dayBusy) {
    if (merged.length > 0 && block.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, block.end);
    } else {
      merged.push({ ...block });
    }
  }

  let totalFreeMin = 0;
  let prev = dayStartMs;
  for (const block of merged) {
    const gapMin = (block.start - prev) / 60_000;
    if (gapMin >= minChunkMinutes) totalFreeMin += gapMin;
    prev = block.end;
  }
  const finalGapMin = (dayEndMs - prev) / 60_000;
  if (finalGapMin >= minChunkMinutes) totalFreeMin += finalGapMin;

  return totalFreeMin;
}

export interface RuleCheckInput {
  profile: UserProfile;
  slotStartIso: string;             // inclusive
  slotEndIso: string;               // exclusive
  category: string | null;
  events: CalendarEvent[];          // owner's events covering at least slot's week
  excludeEventIds?: string[];       // for move: drop the moving event from collision detection
  allowRelaxed?: boolean;           // owner override mode — bypass soft rules
  /**
   * Floating-block booking path (lunch / focus / gym / etc). When true, rule 8
   * (owner_busy_collision) is skipped — floating blocks are SIGNALS that
   * coexist with meetings in Outlook, not competing slots. Owner direction:
   * Outlook doesn't refuse overlapping events; we shouldn't either when
   * booking a floating block. The overlap surfaces elsewhere (check_calendar_health
   * double_booking issues, or the book_floating_block caller can read overlapping
   * events from the result and offer to move them).
   */
  isFloatingBlock?: boolean;
  /**
   * v3.7.x (#143) — the slot date's effective work context (yaml base + per-date
   * override, resolved by getEffectiveWorkDay). When present, rules 1/5/9 read the
   * day's workday-ness, windows, LOCATION, and TIMEZONE from it — so an away
   * override day validates against its stated hours in its own zone. When ABSENT,
   * checkSlot resolves it itself from the slot's date, so a caller that doesn't
   * thread it still gets override-correct rules. find_available_slots passes the
   * SAME effectiveDay it walked with, so search and book can never disagree.
   */
  effectiveDay?: EffectiveWorkDay;
}

export interface RuleCheckResult {
  passes: boolean;
  violation_kind?: RuleViolationKind;
  violation_label?: string;          // short human phrase suitable for an approval ask_text
}

/**
 * requiredFreeMinutesForWorkDay — THE single source of truth for "how much free
 * time a work day should have," derived from that day's TOTAL work-window
 * minutes (morning + night shift summed). Length-based: 1 free hour per
 * `workHoursPerFreeHour` hours worked, rounded UP to the next 15-minute step.
 *
 * bug 1.13 — replaces the old fixed free_time_per_office/home_day_hours that
 * was read independently in analyze_calendar, checkSlot rule 9, and the
 * calendar-health sweep (three copies, drift-prone). The RATIO stays per-owner
 * config (de-tenant: v3.2.x deliberately moved free-time off a hardcoded value
 * so one owner's focus theory isn't imposed on every tenant) — unset / ≤0 →
 * 0 min, i.e. no floor imposed.
 *
 *   ratio 4:  4h day → 60m · 6h → 90m · 8h → 120m · 12h → 180m
 *             2.5h → 37.5 → ceil-15 → 45m · 3h → 45m
 */
export function requiredFreeMinutesForWorkDay(
  workTotalMin: number,
  workHoursPerFreeHour: number | undefined,
): number {
  if (!workHoursPerFreeHour || workHoursPerFreeHour <= 0) return 0;
  if (!(workTotalMin > 0)) return 0;
  return Math.ceil((workTotalMin / workHoursPerFreeHour) / 15) * 15;
}

export function checkSlot(input: RuleCheckInput): RuleCheckResult {
  const { profile } = input;
  const tz = profile.user.timezone;
  // Anchor a ZONELESS slot in the owner's home tz, not the server's local tz
  // (the normalizeForGraph drift class — a naive "10:00" was read in the
  // travel-zone server clock → wrong work-hours verdict). `setZone:true` still
  // respects an explicit offset on a search-emitted slot.
  const slotStart = DateTime.fromISO(input.slotStartIso, { zone: tz, setZone: true }).setZone(tz);
  const slotEnd = DateTime.fromISO(input.slotEndIso, { zone: tz, setZone: true }).setZone(tz);
  const excludeSet = new Set(input.excludeEventIds ?? []);
  const dayName = slotStart.toFormat('EEEE');
  // v3.7.x (#143) — the slot date's effective work context: threaded by the
  // search (so search + book agree) or self-resolved from the slot's home-tz
  // date. Rules 1/5/9 read workday-ness, windows, location + timezone from it.
  const effectiveDay = input.effectiveDay ?? getEffectiveWorkDayForInstant(input.slotStartIso, profile);

  // ── (0) in the past ─────────────────────────────────────────────────────
  // Never silently book a slot that has already started — a past / earlier-today
  // time is almost always a typo (a "book at 9am" when it's 2pm). planMeeting
  // turns this into a ONE-TIME clarify ("did you mean later today?"), and the
  // owner's "yes/force" comes back allowRelaxed → this bypasses so the confirm
  // loop terminates (he CAN log a past meeting if he insists). find_available_slots
  // enforces the fuller booking lead-time for OFFERED slots; this is the
  // write-path floor that named-time create/move was missing.
  if (!input.allowRelaxed && slotStart.toMillis() < DateTime.now().toMillis()) {
    return {
      passes: false,
      violation_kind: 'in_the_past',
      violation_label: 'that time has already passed',
    };
  }

  // ── (1) vacation / off day ──────────────────────────────────────────────
  // v3.7.x (#143) — via the effective day, so a per-date "off" override and a
  // normally-off yaml day read the same. No override → identical to the old
  // office/home name check.
  if (!effectiveDay.isWorkday) {
    const firstName = profile.user.name.split(' ')[0];
    return {
      passes: false,
      violation_kind: 'vacation_or_off_day',
      violation_label: effectiveDay.hasOverride
        ? `${firstName} has ${slotStart.toFormat('EEEE d MMM')} off`
        : `${dayName} isn't one of ${firstName}'s working days`,
    };
  }

  // ── (2-4) category rules ────────────────────────────────────────────────
  // Bypassed under allowRelaxed — owner override is total (rule 11); the search
  // path likewise skips category in relaxed mode, so the two stay aligned.
  if (!input.allowRelaxed) {
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
  }

  // ── (5) working hours ───────────────────────────────────────────────────
  // v2.8.1 — multi-window aware. Slot must fit fully inside ANY of the
  // owner's work-hour windows for the day (e.g. Tuesday split into
  // 09:00-15:30 + 21:30-23:59 — a 21:45-22:10 slot is valid).
  if (!input.allowRelaxed) {
    // v3.7.x (#143) — windows from the effective day, and the slot's minute-of-day
    // evaluated in the day's EFFECTIVE timezone. For an away override ("Boston 9-5
    // EST") the windows are stated in that zone, so the instant is converted there
    // before the fit check. No override → effectiveTz is the home tz → identical to
    // reading the home clock. start + duration so a slot ending past midnight does
    // NOT wrap to a small minute-of-day and spuriously fit a daytime window.
    const windows = effectiveDay.windows;
    const slotStartEff = slotStart.setZone(effectiveDay.timezone);
    const slotEndEff = slotEnd.setZone(effectiveDay.timezone);
    const { startMin: slotStartMin, endMin: slotEndMin } = slotDayMinutes(slotStartEff, slotEndEff);
    const fits = windows.some(w => slotStartMin >= w.startMin && slotEndMin <= w.endMin);
    if (!fits) {
      const windowsLabel = windows.length === 0
        ? '(no work hours configured for this day)'
        : windows.map(w => `${String(Math.floor(w.startMin/60)).padStart(2,'0')}:${String(w.startMin%60).padStart(2,'0')}–${String(Math.floor(w.endMin/60)).padStart(2,'0')}:${String(w.endMin%60).padStart(2,'0')}`).join(', ');
      const zoneNote = effectiveDay.isAway ? ` (${effectiveDay.timezone})` : '';
      return {
        passes: false,
        violation_kind: 'outside_working_hours',
        violation_label: `Slot ${slotStartEff.toFormat('HH:mm')}–${slotEndEff.toFormat('HH:mm')}${zoneNote} is outside working hours (${windowsLabel})`,
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
  // v3.7.x (#143) — skip on an override day: no floating blocks live there, so
  // there's no lunch/gym window to protect (and a normal meeting isn't blocked
  // for a block that won't be booked that day).
  if (!input.allowRelaxed && !effectiveDay.hasOverride) {
    const blocks = profile.meetings?.floating_blocks ?? [];
    for (const block of blocks) {
      const [psH, psM] = block.preferred_start.split(':').map(Number);
      const [peH, peM] = block.preferred_end.split(':').map(Number);
      const windowStart = slotStart.set({ hour: psH, minute: psM, second: 0, millisecond: 0 });
      const windowEnd = slotStart.set({ hour: peH, minute: peM, second: 0, millisecond: 0 });
      // If the proposed slot doesn't overlap the window at all, no concern.
      if (slotEnd <= windowStart || slotStart >= windowEnd) continue;
      // v3.1.5 (Bug 1) — the proposed slot IS a floating block (book_floating_block
      // → planMeeting with isFloatingBlock=true), and it sits inside THIS block's
      // window → it's THIS block being booked. Don't check whether the block can
      // "still fit elsewhere" after placing itself — that's circular
      // self-rejection (placing 25-min lunch in the only gap, then failing
      // because lunch can't ALSO fit). findAlignedSlotForBlock already validated
      // the placement. Other blocks (different windows) are still checked, so
      // booking lunch can't silently squeeze out a separate gym/coffee block.
      if (input.isFloatingBlock && slotStart >= windowStart && slotEnd <= windowEnd) continue;

      const blockDurationMin = block.duration_minutes ?? 25;

      // Collect busy intervals inside the window (today only).
      const busyInWindow: Array<{ start: number; end: number }> = [];
      for (const ev of input.events) {
        if (ev.isCancelled) continue;
        if (excludeSet.has(ev.id)) continue;
        if ((ev as any).showAs === 'free') continue;
        // v3.6.4 — a timed optional-join (WE-soft) yields to a floating block:
        // the owner drops the optional to keep lunch, so it never occupies the
        // window for feasibility. Keeps this rule consistent with the search /
        // health pools that also treat timed-WE as reclaimable free time.
        if (!(ev as any).isAllDay && (ev as any).showAs === 'workingElsewhere') continue;
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
  // Bypassed under allowRelaxed — owner override is total (rule 11), and the
  // search loop likewise skips its buffer check in relaxed mode, so the two
  // stay aligned (a relaxed owner search must still return the slot).
  const cat = getProfileCategoryByName(profile, input.category);
  const needsTravelBuffer = cat?.requires_travel_buffer === true;
  if (needsTravelBuffer && !input.allowRelaxed) {
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
  // Owner direction: it's HIS calendar. Maelle can flag a conflict ONCE
  // (confirm_override path), but after he approves she just books. The owner
  // is allowed to double-book himself any time he wants. Two carve-outs:
  //   • `allowRelaxed: true` — owner explicit override after a flag.
  //   • `isFloatingBlock: true` — focus / lunch / gym blocks are SIGNALS that
  //     coexist with meetings by design; never block them on owner_busy.
  // Regular create_meeting still flags overlaps first time (allowRelaxed=false)
  // so Maelle doesn't silently double-book a meeting with attendees.
  if (!input.allowRelaxed && !input.isFloatingBlock) {
    // A movable floating block (lunch / focus / gym) is NOT a hard collision.
    // Rule 6 above already validated it can still fit elsewhere in its window,
    // and after the booking commits `rebalanceFloatingBlocksAfterMutation`
    // slides it automatically. Counting it as owner_busy here is what forced a
    // spurious confirm_override ("want me to move lunch?") on every named-time
    // booking that landed on the lunch slot — even though the block just shifts.
    // Skip floating-block events: rule 6 owns the genuine "no room to shift"
    // case (floating_block_overlap fires earlier), so no protection is lost.
    const floatingBlockDefs = getFloatingBlocks(profile);
    for (const ev of input.events) {
      if (ev.isCancelled) continue;
      if (excludeSet.has(ev.id)) continue;
      if ((ev as any).showAs === 'free') continue;  // free/tentative blocks don't collide
      // v3.6.4 — a TIMED workingElsewhere event is an OPTIONAL-join (join only
      // if free), NOT a hard commitment: it must never count as an owner-busy
      // collision. This is the single validator for search AND booking, so this
      // one skip is what lets the slot finder TAG a slot over it as WE-soft
      // (instead of dropping it) and lets a booking sit over it with no conflict
      // flag, leaving the optional event in place. All-day WE (travel) is the
      // spine's concern and is deliberately NOT skipped here.
      if (!(ev as any).isAllDay && (ev as any).showAs === 'workingElsewhere') continue;
      if (floatingBlockDefs.some(b => isFloatingBlockEvent(ev, b))) continue;
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
  }

  // v2.7.1 — rule (9) owner_buffer_collision deleted. The 5-min between-meeting
  // buffer is baked into the standard durations (10/25/40/55) at aligned
  // starts (:00/:15/:30/:45). Connected back-to-backs are fine; a separate
  // collision check duplicated the work and incorrectly rejected slots like
  // 17:00 directly after a meeting ending 17:00.

  // ── (9) daily focus-time floor (v3.1.2 C) ────────────────────────────────
  // The length-based daily-free-time floor (requiredFreeMinutesForWorkDay) used to live ONLY in
  // find_available_slots — so a named-time create_meeting / move_meeting /
  // coord pick would book on a packed day that the search path would have
  // refused. Now enforced here too via the shared computeDayQualityFreeMinutes
  // helper. Bypassed when allowRelaxed=true (explicit owner override IS the
  // approval) and when isFloatingBlock=true (focus/lunch/gym blocks are
  // signals that coexist with meetings; the math already ignores showAs=free
  // anyway, but skip to match the rest of the relaxed semantics).
  if (!input.allowRelaxed && !input.isFloatingBlock) {
    // v3.7.x (#143) — office/home via the effective day; an away day (elsewhere)
    // skips the focus floor (a trip day isn't held to the home focus-time theory).
    // The window + total come from effectiveDay.windows, so a per-date hours
    // override ("Tuesday 9-3") is measured against the overridden hours, and the
    // free-time math runs in the effective timezone. No override → identical to the
    // old yaml-window floor. Same source of truth as analyze_calendar +
    // calendar-health, so search, book, and review can never disagree.
    if (effectiveDay.location === 'office' || effectiveDay.location === 'home') {
      let workTotalMinForFloor = 0;
      for (const w of effectiveDay.windows) workTotalMinForFloor += (w.endMin - w.startMin);
      const requiredMin = requiredFreeMinutesForWorkDay(workTotalMinForFloor, profile.meetings.work_hours_per_free_hour);
      if (requiredMin > 0 && effectiveDay.windows.length > 0) {
        const minChunk = profile.meetings.thinking_time_min_chunk_minutes ?? 30;
        // Build busyBlocks from this day's events, minus excluded ids.
        // showAs='free' events don't block focus time; isAllDay doesn't either
        // (vacation markers etc.); a timed optional-join (WE-soft) is reclaimable
        // free time and is skipped too (matches the search + calendar-health
        // pools). Parse zone-aware (Graph dateTime is bare wall-clock + .timeZone)
        // so an off-owner-TZ host doesn't skew the blocks.
        const busyBlocks: Array<{ start: Date; end: Date }> = [];
        for (const ev of input.events) {
          if (ev.isCancelled) continue;
          if (excludeSet.has(ev.id)) continue;
          if ((ev as any).showAs === 'free') continue;
          if (!(ev as any).isAllDay && (ev as any).showAs === 'workingElsewhere') continue;
          if ((ev as any).isAllDay) continue;
          busyBlocks.push({
            start: DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).toJSDate(),
            end: DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' }).toJSDate(),
          });
        }
        // Add the proposed slot itself — checking what's left after booking.
        busyBlocks.push({ start: slotStart.toJSDate(), end: slotEnd.toJSDate() });
        // Union window bounds (earliest start … latest end) across the day's
        // effective windows, formatted for the free-time helper.
        let earliestMin = 24 * 60;
        let latestMin = 0;
        for (const w of effectiveDay.windows) {
          if (w.startMin < earliestMin) earliestMin = w.startMin;
          if (w.endMin > latestMin) latestMin = w.endMin;
        }
        const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const dayDate = slotStart.setZone(effectiveDay.timezone).toFormat('yyyy-MM-dd');
        const dayFreeMin = computeDayQualityFreeMinutes({
          dayDate,
          timezone: effectiveDay.timezone,
          workStart: hhmm(earliestMin),
          workEnd: hhmm(Math.min(latestMin, 1439)),
          busyBlocks,
          minChunkMinutes: minChunk,
        });
        if (dayFreeMin < requiredMin) {
          return {
            passes: false,
            violation_kind: 'focus_time_floor',
            violation_label: `Booking this leaves ${profile.user.name.split(' ')[0]} with ${Math.round(dayFreeMin)} min of free time on ${dayName} — below the ${requiredMin}-min floor for a ${workTotalMinForFloor}-min work day.`,
          };
        }
      }
    }
  }

  return { passes: true };
}
