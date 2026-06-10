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
import { getCalendarEvents } from '../connectors/graph/calendar';
import { checkSlot, type RuleViolationKind } from './scheduleRules';
import { getAnthropicClient } from '../llm/client';
import { logLlmUsage } from './usageLog';
import logger from './logger';

// ── Detection regex ────────────────────────────────────────────────────────

// Time pattern — HH:MM (24-hour, with optional leading zero).
const TIME_PATTERN = /\b(\d{1,2}):(\d{2})\b/g;

// Date pattern — two 1-2 digit components + optional year. Day/month ORDER is
// resolved in extractDates (value-based, then owner-locale tiebreaker) — the
// regex itself is order-agnostic. The hours/minutes pattern collides with the
// d/m pair if the year is missing — guarded by the month<=12 check downstream.
const DATE_PATTERN = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g;

// Question markers — both English and Hebrew. Cheap union test.
const QUESTION_PATTERN =
  /\b(is\s+\w+\s+(?:free|available)|works?\s+for|can\s+\w+\s+do|free\s+at|available\s+at|(?:is|are|will)\s+(?:he|she|they|you))|פנוי|פנויה|פנים|זמין|מתאים|מתאימה|יש\s+זמן|אפשר/i;

// v3.1.2 (#116) — TZ-cue trigger. Only when one of these appears do we
// pay the Haiku normalization cost; otherwise the cheap regex extraction
// stands (and is correct, since bare "12:00" with no TZ context means
// owner-local). The Haiku call canonicalizes a multi-TZ message ("12:00
// Boston (your 19:00)") into one UTC-anchored instant per slot, killing
// the dual-extraction bug that fed two contradictory verdicts to Sonnet.
// Triggers: 3+ char TZ abbreviation, common city/country TZ words, an
// explicit owner-local parenthetical ("(your H:MM)" / "his time" / etc.).
const TZ_CUE_PATTERN = new RegExp(
  [
    // TZ abbreviations (word-bounded)
    '\\b(PST|PDT|EST|EDT|CST|CDT|MST|MDT|AKST|AKDT|HST|HDT|UTC|GMT|BST|CET|CEST|EET|EEST|IST|IDT|JST|KST|AEST|AEDT|ACST|ACDT|AWST|NZST|NZDT|CT|ET|PT|MT)\\b',
    // City/country TZ hints (case-insensitive). Keep this conservative to
    // avoid false positives — only well-known time-anchor words.
    '\\b(Boston|New\\s+York|NYC|Manhattan|Los\\s+Angeles|San\\s+Francisco|Chicago|Denver|Seattle|Atlanta|Miami|Toronto|Vancouver|London|Paris|Berlin|Madrid|Rome|Amsterdam|Dublin|Lisbon|Stockholm|Helsinki|Athens|Istanbul|Moscow|Tel\\s+Aviv|Jerusalem|Dubai|Mumbai|Delhi|Bangalore|Hong\\s+Kong|Singapore|Tokyo|Seoul|Beijing|Shanghai|Sydney|Melbourne|Auckland)\\b',
    // Explicit owner-local parenthetical — "(your 19:00)" / "(Idan\'s 19:00)" / "his time" / "my time"
    '\\(\\s*(your|his|her|their|my)[^)]*\\d{1,2}:\\d{2}',
    '\\b(your|his|her|my)\\s+time\\b',
  ].join('|'),
  'i',
);

interface NormalizedInstant {
  /** UTC instant ISO string with offset (or Z). */
  instant_iso: string;
  /**
   * v3.3.7 (#125a) — the meeting length the colleague named, when they named
   * one ("11:00-11:15" → 15, "חצי שעה" → 30, "for 45 min" → 45). Absent when
   * only a start time was given. The verdict snaps it to allowed_durations
   * exactly like create_meeting would, so verdict and booking agree.
   */
  duration_minutes?: number;
}

/**
 * v3.1.2 (#116) — Haiku-side normalization of a multi-TZ availability message.
 *
 * Why: the colleague might write "12:00 Boston (your 19:00) or 13:00 Boston
 * (20:00 your)". The cheap regex extracts every HH:MM in sight — both the
 * Boston number AND the parenthesized owner-local number — and tests each
 * as if it were owner-local, producing contradictory verdicts (the 12:00
 * test is for owner-local 12:00, NOT for Boston 12:00 = owner 19:00). We
 * push the TZ math to Haiku: feed the message + owner TZ + today's date,
 * get back one UTC-anchored instant per slot the colleague actually
 * proposed. Then we test the instants directly — one verdict per slot.
 *
 * Falls open: any throw / non-JSON / empty list → caller falls back to the
 * regex path (still better than nothing for the no-TZ case).
 */
async function normalizeAvailabilityInstantsWithHaiku(
  message: string,
  profile: UserProfile,
  recentThread?: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<NormalizedInstant[]> {
  const anthropic = getAnthropicClient();
  const ownerFirst = profile.user.name.split(' ')[0];
  const tz = profile.user.timezone;
  const now = DateTime.now().setZone(tz);
  const today = now.toFormat('yyyy-MM-dd');
  const todayWeekday = now.toFormat('EEEE');
  const ownerOffset = now.toFormat('ZZ');

  // v3.3.7 (#125b) — thread context. The DAY a time refers to often lives in
  // an EARLIER message ("מחר יש לי סינק ב-17:00" … next message: "13:00/13:30
  // לא פנוי?"). Without it, time-only asks fell back to TODAY and the verdict
  // was computed for the wrong day (the false "13:30 works" told to Yael).
  const threadBlock = (recentThread ?? [])
    .slice(-4)
    .map(m => `${m.role === 'assistant' ? 'YOU' : 'COLLEAGUE'}: ${m.content.slice(0, 400)}`)
    .join('\n');

  const systemPrompt = `You normalize specific time slots from a colleague's availability question into UTC-anchored ISO instants.

OWNER context:
- Name: ${ownerFirst}
- Timezone: ${tz} (current offset ${ownerOffset})
- Today's date: ${today} (${todayWeekday})
${threadBlock ? `\nRECENT THREAD (older → newer; for resolving which DAY the times refer to):\n${threadBlock}\n` : ''}
The colleague is proposing specific meeting times. They may state each slot in their OWN timezone (e.g. "12:00 Boston") with an explicit owner-local pair in parentheses (e.g. "(your 19:00)") or without. Your job: for each distinct slot the colleague proposed, output ONE ISO instant — the canonical moment in time, with offset.

RULES:
- One entry per slot the colleague actually proposed (not one per number in the message).
- When the colleague named a meeting LENGTH — a range ("11:00-11:15" → start 11:00, duration_minutes 15) or an explicit duration ("for 20 min", "חצי שעה" → 30) — include duration_minutes. Omit it when only a start time was given.
- Resolve relative day words in ANY language — "tomorrow"/"מחר", weekday names ("Tuesday"/"ביום שלישי"), "next week" — against today's date above.
- When a time carries NO day in the current message, use the day under discussion in the RECENT THREAD (e.g. the colleague said "tomorrow at 17:00" a message earlier, then asks "13:00/13:30?" — those are TOMORROW). Only when no day reference exists anywhere, assume today.
- When the message gives both a foreign time AND an explicit owner-local "(your X:Y)" pair for the SAME slot, prefer the owner-local — it's the most reliable anchor.
- When only a foreign TZ is given, map the named place/abbreviation to the right IANA zone and compute the instant for the named date.
- When no TZ is given for a time, treat it as ${tz} (owner-local).
- ISO format with offset, e.g. "2026-06-09T19:00:00+03:00" — never bare wall-clock.
- If the message contains no specific slot proposals, return an empty list.

Output EXACTLY ONE call to normalize_instants.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      system: systemPrompt,
      tools: [{
        name: 'normalize_instants',
        description: 'Output one UTC-anchored ISO instant per slot the colleague proposed.',
        input_schema: {
          type: 'object' as const,
          properties: {
            instants: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  instant_iso: { type: 'string', description: 'ISO 8601 with offset, e.g. 2026-06-09T19:00:00+03:00' },
                  duration_minutes: { type: 'number', description: 'Meeting length in minutes, ONLY when the colleague named one (a range like 11:00-11:15, or "for 20 min"). Omit otherwise.' },
                },
                required: ['instant_iso'],
              },
            },
          },
          required: ['instants'],
        },
      }],
      tool_choice: { type: 'tool', name: 'normalize_instants' },
      messages: [{ role: 'user', content: message.slice(0, 4000) }],
    });
    logLlmUsage('availability_tz_normalize', 'claude-haiku-4-5-20251001', resp);
    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const raw = toolUse?.input as { instants?: Array<{ instant_iso?: string; duration_minutes?: number }> } | undefined;
    const out: NormalizedInstant[] = [];
    for (const entry of raw?.instants ?? []) {
      if (typeof entry?.instant_iso !== 'string') continue;
      const dt = DateTime.fromISO(entry.instant_iso, { setZone: true });
      if (!dt.isValid) continue;
      const dur = typeof entry.duration_minutes === 'number' && entry.duration_minutes >= 5 && entry.duration_minutes <= 480
        ? entry.duration_minutes
        : undefined;
      out.push({ instant_iso: dt.toISO()!, ...(dur ? { duration_minutes: dur } : {}) });
    }
    return out;
  } catch (err) {
    logger.warn('availabilityPreCheck — Haiku normalize threw, falling back to regex', {
      err: String(err).slice(0, 200),
    });
    return [];
  }
}

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
  // v3.3.7 (#125b) — last few thread messages so the Haiku normalizer can
  // resolve WHICH DAY a bare time refers to ("מחר" said a message earlier).
  recentThread?: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<AvailabilityPreCheckResult> {
  const empty: AvailabilityPreCheckResult = { ran: false, verdicts: [], promptBlock: '' };

  if (!params.message || params.message.trim().length === 0) return empty;

  // Cheap pre-filter: must have BOTH a question marker AND a time pattern.
  // Without time, there's nothing specific to verify; without a question,
  // it's not an availability ask.
  if (!QUESTION_PATTERN.test(params.message)) return empty;

  const tz = params.profile.user.timezone;
  const today = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
  const durationMinutes = params.durationMinutes ?? params.profile.meetings.allowed_durations[1] ?? 25;

  // v3.1.2 (#116) — multi-TZ path. If the message contains a TZ cue (named
  // place / abbreviation / explicit owner-local parenthetical), Haiku
  // canonicalizes the proposed slots into UTC-anchored instants and we
  // test those directly. Eliminates the dual-extraction bug where regex
  // pulled both the foreign and owner-local numbers and tested each as if
  // it were owner-local. Empty Haiku result → fall through to the regex
  // path (still useful for the no-TZ case).
  // v3.3.7 (#125b) — Haiku is now the PRIMARY extraction path whenever the
  // message carries a time at all (was TZ-cue-only). The regex path can't
  // resolve relative day words ("מחר" in a prior message), so it resolved
  // time-only asks to TODAY — the wrong-day "13:30 works" verdict (#125).
  // Regex stays below as the fail-open fallback when Haiku errors/returns
  // empty. Cost-bounded: one Haiku call, only on question-marked colleague
  // messages that contain a time pattern.
  let pairs: Pair[] = [];
  if (TZ_CUE_PATTERN.test(params.message) || extractTimes(params.message).length > 0) {
    const instants = await normalizeAvailabilityInstantsWithHaiku(params.message, params.profile, params.recentThread);
    if (instants.length > 0) {
      const seen = new Set<string>();
      for (const inst of instants) {
        const dt = DateTime.fromISO(inst.instant_iso).setZone(tz);
        if (!dt.isValid) continue;
        const date = dt.toFormat('yyyy-MM-dd');
        const time = dt.toFormat('HH:mm');
        const key = `${date}T${time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ date, time, ...(inst.duration_minutes ? { durationMin: inst.duration_minutes } : {}) });
      }
      logger.info('availabilityPreCheck — Haiku normalized instants', {
        instant_count: instants.length, pair_count: pairs.length,
      });
    }
  }

  // Regex fallback path. Runs when no TZ cue OR when Haiku returned empty.
  // The owner-local assumption is correct in the no-TZ case (a colleague
  // writing "2pm" without TZ context means owner-local).
  if (pairs.length === 0) {
    const times = extractTimes(params.message);
    if (times.length === 0) return empty;
    // Owner locale order for ambiguous DD/MM vs MM/DD: Americas → month-first,
    // everywhere else → day-first. Heuristic (fails open — the real slot search
    // re-interprets on Sonnet's reading anyway), no new profile field needed.
    const monthFirst = /^America\//.test(tz);
    const dateMatches = extractDates(params.message, tz, monthFirst);
    pairs = pairTimesWithDates(params.message, times, dateMatches, today);
    if (pairs.length === 0) return empty;
  }

  const verdicts: SlotVerdict[] = [];

  // v3.3.7 (#125a) — verdicts now come from `checkSlot`, the SAME validator
  // the booking path runs on a named time (planMeeting). The previous
  // per-pair narrow findAvailableSlots had two faithfulness holes:
  //   (a) autoExpand silently widened the ±1-min window to a 7-day search;
  //   (b) the focus-time floor computed against WINDOW-scoped busy — a
  //       ~27-min window can't see the rest of the day, so the floor never
  //       fired and a floor-blocked slot read as BOOKABLE... which the
  //       booking flow then refused (the "13:30 works" → walk-back class).
  // checkSlot evaluates against the slot's full WEEK of events (one
  // per-turn-memoized fetch per week), exactly like write-time validation —
  // verdict and booking can no longer disagree.
  const allowedDurations = params.profile.meetings.allowed_durations ?? [25];
  const eventsByWeek = new Map<string, import('../connectors/graph/calendar').CalendarEvent[]>();
  for (const pair of pairs.slice(0, 6)) {  // cap at 6 to bound cost
    try {
      const startDt = DateTime.fromISO(`${pair.date}T${pair.time}`, { zone: tz });
      if (!startDt.isValid) continue;
      // Duration: the asked length when the colleague named one, snapped to
      // allowed_durations exactly like create_meeting snaps (nearest). An
      // "11:00-11:15" ask checks 11:00+10min — the same meeting booking
      // would create — instead of a phantom default-25 window.
      const askedMin = pair.durationMin ?? durationMinutes;
      const snappedMin = allowedDurations.reduce(
        (best, d) => (Math.abs(d - askedMin) < Math.abs(best - askedMin) ? d : best),
        allowedDurations[0],
      );
      const endDt = startDt.plus({ minutes: snappedMin });
      const weekKey = startDt.startOf('week').toFormat('yyyy-MM-dd');
      let events = eventsByWeek.get(weekKey);
      if (!events) {
        events = await getCalendarEvents(
          params.profile.user.email,
          startDt.startOf('week').toFormat("yyyy-MM-dd'T'00:00:00"),
          startDt.endOf('week').toFormat("yyyy-MM-dd'T'23:59:59"),
          tz,
        );
        eventsByWeek.set(weekKey, events);
      }
      const check = checkSlot({
        profile: params.profile,
        slotStartIso: startDt.toISO()!,
        slotEndIso: endDt.toISO()!,
        category: null,
        events,
      });
      if (check.passes) {
        verdicts.push({ date: pair.date, time: pair.time, bookable: true });
      } else {
        verdicts.push({
          date: pair.date,
          time: pair.time,
          bookable: false,
          rejection_reason: (check.violation_kind as RuleViolationKind | undefined) ?? 'unknown',
        });
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

function extractDates(text: string, tz: string, monthFirst: boolean): DateMatch[] {
  const out: DateMatch[] = [];
  for (const m of text.matchAll(DATE_PATTERN)) {
    // v3.2.x de-tenant — don't hardcode DD/MM (Israeli/EU). Disambiguate by
    // value first (a component >12 can't be a month), then fall back to the
    // owner's locale order for the genuinely ambiguous case (e.g. "6/2" =
    // June 2 for a month-first owner, 6 Feb for a day-first owner).
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    let d: number, mo: number;
    if (a > 12 && b <= 12) { d = a; mo = b; }
    else if (b > 12 && a <= 12) { d = b; mo = a; }
    else if (monthFirst) { mo = a; d = b; }
    else { d = a; mo = b; }
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

interface Pair { date: string; time: string; durationMin?: number }

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
    // v3.3.x — precheckAvailability runs ONLY on the colleague path
    // (orchestrator/index.ts gate). Never surface the rule name to a colleague —
    // "focus_time_office" / "lunch" etc. leaks the owner's schedule mechanics.
    // v3.3.7 (#125a) — but DO distinguish soft (owner-relaxable day-load
    // protections) from hard (real meetings / work hours): a soft block is
    // "his day is loaded" + escalatable, not a flat refusal. Kinds are
    // checkSlot's RuleViolationKind values (verdicts run checkSlot now).
    const SOFT: string[] = ['focus_time_floor', 'floating_block_overlap'];
    const isSoft = !!v.rejection_reason && SOFT.includes(v.rejection_reason);
    if (isSoft) {
      return `  - ${when}: NOT CLEAN (soft) — his day is loaded around then, not a hard conflict. If the colleague INSISTS on this exact time, raise create_approval(kind=policy_exception) with it so he decides — don't refuse outright, don't book.`;
    }
    return `  - ${when}: NOT BOOKABLE`;
  });
  return `## AVAILABILITY CHECK (rule-aware, deterministic)

I pre-checked the times in this colleague's question against ${profile.user.name.split(' ')[0]}'s real scheduling rules (work hours, buffer, focus blocks, category limits). Use these verdicts in your reply — do NOT eyeball get_calendar and disagree:

${lines.join('\n')}

If a slot is NOT BOOKABLE, say so honestly ("he's booked then" / "that doesn't work"). If it's NOT CLEAN (soft), say his day is too loaded around then — and if the colleague pushes for that exact time, escalate via create_approval(kind=policy_exception) instead of refusing. If it's BOOKABLE, you can confirm. The verdicts above are what \`find_available_slots\` would return — the same source of truth the actual booking flow uses, so your answer here will match what happens at booking time.`;
}
