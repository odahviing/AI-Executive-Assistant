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
 * Pure — no DB / profile / Graph. Shared by the slot finder's ranking,
 * create_meeting's counter-offer, and calendar-health's defragment pass so the
 * three surfaces can never disagree on what "efficient" means (same discipline
 * as scheduleRules.checkSlot / computeDayQualityFreeMinutes).
 */

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

/** Align a ms timestamp UP to the next :00/:15/:30/:45 quarter grid point. */
function alignUpQuarter(ms: number): number {
  const q = 15 * 60000;
  return Math.ceil(ms / q) * q;
}

/**
 * #133 counter-offer core. When a requested slot creates a dead gap, find the
 * EARLIER connective start — the aligned start that packs the meeting back-to-
 * back (≤ buffer) with the nearest earlier commitment. Owner direction: earlier
 * is always better (and for cross-TZ, the earliest slot inside the overlap is
 * the precious one). Returns the candidate start (ms) or null when the requested
 * slot is already efficient, there's nothing earlier to abut, the grid can't make
 * it connective, or the earlier start isn't strictly better. The CALLER must
 * still validate the candidate against the owner's rules (checkSlot) before
 * offering it — this stays pure.
 */
export function earlierConnectiveStart(
  requestedStart: number,
  requestedEnd: number,
  commitments: Interval[],
  cfg: DensityConfig,
): number | null {
  const reqScore = scoreSlotDensity(requestedStart, requestedEnd, commitments, cfg);
  if (!reqScore.createsDeadGap) return null;          // already efficient — never nag
  const durationMs = requestedEnd - requestedStart;
  let leftEnd = -Infinity;                            // nearest commitment ending at/before the request
  for (const c of commitments) if (c.end <= requestedStart && c.end > leftEnd) leftEnd = c.end;
  if (leftEnd === -Infinity) return null;             // nothing earlier to pack against
  const candidate = alignUpQuarter(leftEnd);
  if (candidate >= requestedStart) return null;        // not actually earlier
  if ((candidate - leftEnd) / 60000 > cfg.bufferMinutes) return null;  // grid can't make it connective
  const candScore = scoreSlotDensity(candidate, candidate + durationMs, commitments, cfg);
  if (candScore.createsDeadGap || candScore.score <= reqScore.score) return null;  // not strictly better
  return candidate;
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
