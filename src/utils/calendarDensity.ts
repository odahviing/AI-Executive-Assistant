/**
 * calendarDensity (v3.7.x, #133) — the "efficient calendar" gap model.
 *
 * Owner rule 13: a workday should be DENSE — meetings connected back-to-back,
 * free time consolidated into real breaks, and NO short unfocusable islands
 * between meetings. Every gap between two consecutive commitments should be
 * EITHER connective (≤ buffer, back-to-back) OR a real break (≥ minBreak). The
 * band strictly between the two — the DEAD ZONE — is what we kill.
 *
 * Thresholds are the owner's EXISTING knobs — no new numbers (owner direction):
 *   - buffer   = meetings.buffer_minutes (the baked-in back-to-back tolerance, 5)
 *   - minBreak = meetings.thinking_time_min_chunk_minutes (the smallest block
 *     that counts as focus / a real break — the SAME number the focus-floor
 *     already counts, 30). "If 30 min is my buffer, it's also the minimum gap."
 *
 * Everything is gated on meetings.packing_preference === 'dense' at each
 * consumer; a tenant on 'spread' (the default) sees none of this.
 *
 * Pure (deterministic given a timezone string — no DB / profile / Graph
 * lookups). Shared by the slot finder's ranking,
 * create_meeting's counter-offer, and calendar-health's defragment pass so the
 * three surfaces can never disagree on what "efficient" means (same discipline
 * as scheduleRules.checkSlot / computeDayQualityFreeMinutes).
 */

import { DateTime } from 'luxon';

export type GapKind = 'connective' | 'dead' | 'break';

export interface DensityConfig {
  bufferMinutes: number;    // gap ≤ this ⇒ connective (back-to-back)
  minBreakMinutes: number;  // gap ≥ this ⇒ a real break
}

export interface Interval {
  start: number;  // epoch ms, inclusive
  end: number;    // epoch ms, exclusive
}

/**
 * Classify a gap (in minutes) between two commitments.
 *   ≤ buffer            → connective (good — back-to-back)
 *   ≥ minBreak          → break      (good — real focus/lunch break)
 *   in between          → dead       (bad — the 6–29 min island we kill)
 */
export function classifyGap(gapMinutes: number, cfg: DensityConfig): GapKind {
  if (gapMinutes <= cfg.bufferMinutes) return 'connective';
  if (gapMinutes >= cfg.minBreakMinutes) return 'break';
  return 'dead';
}

export interface SlotDensity {
  score: number;                       // higher = more efficient (ranking key)
  createsDeadGap: boolean;             // opens a dead-zone gap on ≥1 side
  gapBeforeKind: GapKind | 'open';     // 'open' = no neighbour that side (day edge)
  gapAfterKind: GapKind | 'open';
}

// Per-side contribution: connective (tightest pack) > a real break > an open
// day edge; a dead gap is a hard penalty that dominates the sort so a
// dead-gap-creating slot always sinks below a clean one.
const SIDE_SCORE: Record<GapKind | 'open', number> = {
  connective: 2,
  break: 1,
  open: 0,
  dead: -4,
};

/**
 * Score how efficiently a candidate slot [slotStart, slotEnd) sits among the
 * day's existing commitments. Looks only at the IMMEDIATE neighbours — the
 * nearest commitment ending at/before the slot, and the nearest starting
 * at/after it.
 *
 * `commitments` = the owner's busy intervals for the day (existing meetings /
 * blocks), epoch ms, NOT including the candidate itself. Order-independent.
 */
export function scoreSlotDensity(
  slotStart: number,
  slotEnd: number,
  commitments: Interval[],
  cfg: DensityConfig,
): SlotDensity {
  let leftEnd = -Infinity;    // nearest commitment end at/before slotStart
  let rightStart = Infinity;  // nearest commitment start at/after slotEnd
  for (const c of commitments) {
    if (c.end <= slotStart && c.end > leftEnd) leftEnd = c.end;
    if (c.start >= slotEnd && c.start < rightStart) rightStart = c.start;
  }
  const beforeKind: GapKind | 'open' =
    leftEnd === -Infinity ? 'open' : classifyGap((slotStart - leftEnd) / 60000, cfg);
  const afterKind: GapKind | 'open' =
    rightStart === Infinity ? 'open' : classifyGap((rightStart - slotEnd) / 60000, cfg);

  return {
    score: SIDE_SCORE[beforeKind] + SIDE_SCORE[afterKind],
    createsDeadGap: beforeKind === 'dead' || afterKind === 'dead',
    gapBeforeKind: beforeKind,
    gapAfterKind: afterKind,
  };
}

/**
 * The dead-zone gaps that already exist on a day — used by calendar-health's
 * defragment pass. Walks the sorted commitments and returns each adjacent pair
 * whose gap falls in the dead band (buffer < gap < minBreak). `commitments`
 * are the owner's busy intervals for ONE day, epoch ms.
 */
export interface DeadGap {
  leftEnd: number;    // epoch ms — end of the earlier meeting
  rightStart: number; // epoch ms — start of the later meeting
  gapMinutes: number;
}

export function findDeadGaps(commitments: Interval[], cfg: DensityConfig): DeadGap[] {
  const sorted = [...commitments].sort((a, b) => a.start - b.start);
  const out: DeadGap[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const leftEnd = sorted[i].end;
    const rightStart = sorted[i + 1].start;
    if (rightStart <= leftEnd) continue;  // overlap / touching — not a gap
    const gapMin = (rightStart - leftEnd) / 60000;
    if (classifyGap(gapMin, cfg) === 'dead') {
      out.push({ leftEnd, rightStart, gapMinutes: gapMin });
    }
  }
  return out;
}

/**
 * Round a millis timestamp UP to the next :00/:15/:30/:45 quarter-hour in the
 * given timezone. THE single implementation of the owner's quarter grid rule —
 * lives here; floatingBlocks.ts imports and uses it internally but does not
 * re-export it. floatingBlocks.ts used to keep its own copy; a naive UTC-ms
 * version lived here instead until v4.4.x.
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
 * Round a millis timestamp DOWN to the previous :00/:15/:30/:45 quarter-hour
 * in the given timezone. Mirror of alignUpQuarter — moved here alongside it
 * (#188) so earlierConnectiveStart's later-side search doesn't need to reach
 * into floatingBlocks.ts (which itself imports FROM this module — that would
 * be circular). floatingBlocks.ts imports and uses it internally but does not
 * re-export it; it used to keep its own copy.
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

/**
 * Round a millis timestamp to the NEAREST :00/:15/:30/:45 quarter-hour in the
 * given timezone. Half rounds up (8 min → next quarter). Used by override
 * paths that accept a free-form HH:MM from the owner and need to snap to the
 * standard grid the rest of the system assumes. Moved here alongside
 * alignUpQuarter/alignDownQuarter (single implementation of the shared quarter-
 * grid rule). floatingBlocks.ts does not import or re-export this one; it
 * used to keep its own copy.
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
 * #133 / #188 counter-offer core. When a requested slot creates a dead gap,
 * find a connective start — an aligned start that packs the meeting back-to-
 * back (≤ buffer) with a neighbouring commitment. Searches BOTH sides
 * (mirrors findConsolidatingSlotForBlock, #133b): an EARLIER start that abuts
 * the nearest prior commitment's end, and a LATER start that abuts the
 * nearest next commitment's start — same scoring/rejection on each side
 * (scoreSlotDensity; reject if the candidate itself creates a dead gap, or
 * isn't strictly better than the requested slot's score). When both sides
 * produce a strictly-better candidate, the higher-scoring one wins; a tie
 * favours earlier (owner direction: earlier is always better, and for
 * cross-TZ the earliest slot inside the overlap is the precious one).
 * Returns the candidate start (ms), or null when the requested slot is
 * already efficient, there's nothing to abut on either side, the grid can't
 * make either side connective, or neither candidate is strictly better. The
 * CALLER must still validate the candidate against the owner's rules
 * (checkSlot) before offering it — this stays pure.
 */
export function earlierConnectiveStart(
  requestedStart: number,
  requestedEnd: number,
  commitments: Interval[],
  cfg: DensityConfig,
  timezone: string,
): number | null {
  const reqScore = scoreSlotDensity(requestedStart, requestedEnd, commitments, cfg);
  if (!reqScore.createsDeadGap) return null;          // already efficient — never nag
  const durationMs = requestedEnd - requestedStart;

  // EARLIER side — abut the nearest commitment ending at/before the request.
  let leftEnd = -Infinity;
  for (const c of commitments) if (c.end <= requestedStart && c.end > leftEnd) leftEnd = c.end;
  let earlier: { start: number; score: number } | null = null;
  if (leftEnd !== -Infinity) {
    const cand = alignUpQuarter(leftEnd, timezone);
    if (cand < requestedStart && (cand - leftEnd) / 60000 <= cfg.bufferMinutes) {
      const s = scoreSlotDensity(cand, cand + durationMs, commitments, cfg);
      if (!s.createsDeadGap && s.score > reqScore.score) earlier = { start: cand, score: s.score };
    }
  }

  // LATER side — mirror image: abut the nearest commitment starting at/after
  // the request's end. Align the START itself down to the nearest tick at/
  // before (rightStart − duration) — same construction as
  // findConsolidatingSlotForBlock's abutting candidates (floatingBlocks.ts,
  // `alignDownQuarter(c.start - durationMs, ...)`) — so the START lands on
  // the quarter grid even when duration isn't a multiple of 15 minutes;
  // aligning the END and subtracting duration would not guarantee that.
  let rightStart = Infinity;
  for (const c of commitments) if (c.start >= requestedEnd && c.start < rightStart) rightStart = c.start;
  let later: { start: number; score: number } | null = null;
  if (rightStart !== Infinity) {
    const cand = alignDownQuarter(rightStart - durationMs, timezone);
    if (cand > requestedStart && (rightStart - (cand + durationMs)) / 60000 <= cfg.bufferMinutes) {
      const s = scoreSlotDensity(cand, cand + durationMs, commitments, cfg);
      if (!s.createsDeadGap && s.score > reqScore.score) later = { start: cand, score: s.score };
    }
  }

  if (!earlier && !later) return null;
  if (!later) return earlier!.start;
  if (!earlier) return later.start;
  return later.score > earlier.score ? later.start : earlier.start;  // tie → earlier
}

/** Resolve the density thresholds from a profile's meetings config. */
export function densityConfigFromProfile(
  meetings: { buffer_minutes?: number; thinking_time_min_chunk_minutes?: number },
): DensityConfig {
  return {
    bufferMinutes: meetings.buffer_minutes ?? 5,
    minBreakMinutes: meetings.thinking_time_min_chunk_minutes ?? 30,
  };
}

/** True when the owner has opted into dense packing (default is 'spread'). */
export function prefersDensePacking(meetings: { packing_preference?: string }): boolean {
  return meetings.packing_preference === 'dense';
}
