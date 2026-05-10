/**
 * Availability pre-check (v2.6.5).
 *
 * Background — colleague-path bug: when Yael asked "is Idan free at 12:30
 * 11.5 or 16:00 11.5?", Sonnet eyeballed `get_calendar` events and answered
 * "✅ 12:30 free, ❌ 16:00 busy". Later when Yael picked 12:30, the booking
 * flow ran `find_available_slots` (rule-aware: applies buffer, focus blocks,
 * work hours, categories) and got 0 candidates. SAME calendar data,
 * DIFFERENT verdict — the eyeball check missed buffer collisions / focus-
 * time conflicts that the rule-aware check catches.
 *
 * Fix: when a colleague-path inbound message contains specific time/date
 * patterns AND an availability-question marker, run `find_available_slots`
 * deterministically for each (date, time) pair BEFORE Sonnet answers.
 * Inject the rule-aware verdicts into the system prompt for that turn so
 * Sonnet's "free/busy" narration matches what the booking flow will accept.
 *
 * Best-effort detector — fails open. If we miss a pattern, current behavior
 * stands (Sonnet eyeballs whatever tool she chooses). When we catch one, we
 * upgrade Sonnet's context with deterministic data.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { findAvailableSlots } from '../connectors/graph/calendar';
import logger from './logger';

// ── Detection regex ────────────────────────────────────────────────────────

// Time pattern — HH:MM (24-hour, with optional leading zero).
const TIME_PATTERN = /\b(\d{1,2}):(\d{2})\b/g;

// Date pattern — DD.MM[.YYYY] or DD/MM[/YYYY] (Israeli/EU format). The hours/
// minutes pattern collides with DD/MM if the year is missing — we anchor on
// month being <= 12 to disambiguate.
const DATE_PATTERN = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g;

// Question markers — both English and Hebrew. Cheap union test.
const QUESTION_PATTERN =
  /\b(is\s+\w+\s+(?:free|available)|works?\s+for|can\s+\w+\s+do|free\s+at|available\s+at|(?:is|are|will)\s+(?:he|she|they|you))|פנוי|פנויה|פנים|זמין|מתאים|מתאימה|יש\s+זמן|אפשר/i;

// ── Public API ──────────────────────────────────────────────────────────────

interface SlotVerdict {
  date: string;        // YYYY-MM-DD
  time: string;        // HH:MM
  bookable: boolean;
  rejection_reason?: string;
}

export interface AvailabilityPreCheckResult {
  /** True when at least one slot was tested. */
  ran: boolean;
  /** Per-slot verdicts for the system prompt block. Empty when ran=false. */
  verdicts: SlotVerdict[];
  /**
   * Pre-rendered prompt block, ready to inject. Empty string when no
   * verdicts to share. Owner reads this in the system prompt before
   * answering.
   */
  promptBlock: string;
}

/**
 * Detect (date, time) pairs in a colleague-path message and run
 * `find_available_slots` for each with a narrow window. Returns a result
 * object with verdicts + a pre-rendered prompt block.
 *
 * Fails open: if anything throws, returns `{ ran: false, ... }`. The main
 * orchestrator path is unaffected.
 */
export async function precheckAvailability(params: {
  message: string;
  profile: UserProfile;
  durationMinutes?: number;  // default 25 (from profile.meetings.allowed_durations[1])
}): Promise<AvailabilityPreCheckResult> {
  const empty: AvailabilityPreCheckResult = { ran: false, verdicts: [], promptBlock: '' };

  if (!params.message || params.message.trim().length === 0) return empty;

  // Cheap pre-filter: must have BOTH a question marker AND a time pattern.
  // Without time, there's nothing specific to verify; without a question,
  // it's not an availability ask.
  if (!QUESTION_PATTERN.test(params.message)) return empty;

  const times = extractTimes(params.message);
  if (times.length === 0) return empty;

  // Extract dates. If none, assume "today" for all times. If multiple dates,
  // pair each time with its nearest preceding date in the message.
  const dateMatches = extractDates(params.message, params.profile.user.timezone);
  const tz = params.profile.user.timezone;
  const today = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');

  const pairs = pairTimesWithDates(params.message, times, dateMatches, today);
  if (pairs.length === 0) return empty;

  const durationMinutes = params.durationMinutes ?? params.profile.meetings.allowed_durations[1] ?? 25;
  const verdicts: SlotVerdict[] = [];

  for (const pair of pairs.slice(0, 6)) {  // cap at 6 to bound cost
    try {
      const startDt = DateTime.fromISO(`${pair.date}T${pair.time}`, { zone: tz });
      if (!startDt.isValid) continue;
      const startMs = startDt.toMillis();
      const fromIso = DateTime.fromMillis(startMs - 60_000).toUTC().toISO();
      const toIso = DateTime.fromMillis(startMs + durationMinutes * 60_000 + 60_000).toUTC().toISO();
      if (!fromIso || !toIso) continue;

      const diagnostics: { rejectedCounts: Record<string, number> } = { rejectedCounts: {} };
      const slots = await findAvailableSlots({
        userEmail: params.profile.user.email,
        timezone: tz,
        durationMinutes,
        attendeeEmails: [params.profile.user.email],
        searchFrom: fromIso,
        searchTo: toIso,
        profile: params.profile,
        diagnosticsOut: diagnostics,
      });
      const matched = slots.some(s =>
        Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000,
      );
      if (matched) {
        verdicts.push({ date: pair.date, time: pair.time, bookable: true });
      } else {
        const fired = Object.keys(diagnostics.rejectedCounts ?? {});
        const reason = fired[0] ?? 'unknown';
        verdicts.push({ date: pair.date, time: pair.time, bookable: false, rejection_reason: reason });
      }
    } catch (err) {
      // Single-slot failure shouldn't break the rest; log and skip.
      logger.debug('availabilityPreCheck — single slot threw', {
        date: pair.date, time: pair.time, err: String(err).slice(0, 200),
      });
    }
  }

  if (verdicts.length === 0) return empty;

  const promptBlock = renderPromptBlock(verdicts, params.profile);
  logger.info('availabilityPreCheck — verdicts injected', {
    count: verdicts.length,
    bookable: verdicts.filter(v => v.bookable).length,
    notBookable: verdicts.filter(v => !v.bookable).length,
  });
  return { ran: true, verdicts, promptBlock };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractTimes(text: string): Array<{ hour: number; minute: number; index: number }> {
  const out: Array<{ hour: number; minute: number; index: number }> = [];
  for (const m of text.matchAll(TIME_PATTERN)) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) continue;
    out.push({ hour: h, minute: min, index: m.index ?? 0 });
  }
  return out;
}

interface DateMatch { date: string; index: number }

function extractDates(text: string, tz: string): DateMatch[] {
  const out: DateMatch[] = [];
  for (const m of text.matchAll(DATE_PATTERN)) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    let year: number;
    if (m[3]) {
      const y = parseInt(m[3], 10);
      year = y < 100 ? 2000 + y : y;
    } else {
      // No year — assume current year, but if the date is more than ~2 weeks
      // in the past relative to today, roll to next year (e.g. December
      // referencing January).
      const now = DateTime.now().setZone(tz);
      const candidate = DateTime.fromObject({ year: now.year, month: mo, day: d }, { zone: tz });
      year = candidate.isValid && candidate.diff(now.minus({ days: 14 })).milliseconds < 0
        ? now.year + 1
        : now.year;
    }
    const dt = DateTime.fromObject({ year, month: mo, day: d }, { zone: tz });
    if (!dt.isValid) continue;
    out.push({ date: dt.toFormat('yyyy-MM-dd'), index: m.index ?? 0 });
  }
  return out;
}

interface Pair { date: string; time: string }

function pairTimesWithDates(
  _text: string,
  times: Array<{ hour: number; minute: number; index: number }>,
  dates: DateMatch[],
  fallbackDate: string,
): Pair[] {
  const out: Pair[] = [];
  for (const t of times) {
    // Find the nearest preceding date in the message; fall back to fallbackDate.
    let matchedDate = fallbackDate;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const d of dates) {
      if (d.index <= t.index) {
        const dist = t.index - d.index;
        if (dist < bestDistance) {
          bestDistance = dist;
          matchedDate = d.date;
        }
      }
    }
    out.push({
      date: matchedDate,
      time: `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`,
    });
  }
  // Dedupe identical pairs.
  const seen = new Set<string>();
  return out.filter(p => {
    const key = `${p.date}T${p.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderPromptBlock(verdicts: SlotVerdict[], profile: UserProfile): string {
  const tz = profile.user.timezone;
  const fmt = (date: string, time: string): string => {
    const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
    if (!dt.isValid) return `${date} ${time}`;
    return dt.toFormat("EEEE d MMM 'at' HH:mm");
  };
  const lines = verdicts.map(v => {
    const when = fmt(v.date, v.time);
    if (v.bookable) return `  - ${when}: BOOKABLE per ${profile.user.name.split(' ')[0]}'s rules`;
    const reason = v.rejection_reason && v.rejection_reason !== 'unknown'
      ? ` (rule violated: ${v.rejection_reason})`
      : '';
    return `  - ${when}: NOT BOOKABLE${reason}`;
  });
  return `## AVAILABILITY CHECK (rule-aware, deterministic)

I pre-checked the times in this colleague's question against ${profile.user.name.split(' ')[0]}'s real scheduling rules (work hours, buffer, focus blocks, category limits). Use these verdicts in your reply — do NOT eyeball get_calendar and disagree:

${lines.join('\n')}

If a slot is NOT BOOKABLE, say so honestly. If it's BOOKABLE, you can confirm. The verdicts above are what \`find_available_slots\` would return — the same source of truth the actual booking flow uses, so your answer here will match what happens at booking time.`;
}
