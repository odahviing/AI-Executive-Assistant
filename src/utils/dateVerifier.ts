/**
 * Date verifier (v1.6.6) — code-level guard against wrong weekday/date pairs
 * in Maelle's replies.
 *
 * The system prompt already carries a 14-day DATE LOOKUP table and a rule
 * telling the model to verify day+date before writing. In practice, during
 * long multi-day reasoning (weekly reviews, option reports) the model
 * sometimes still writes "Sunday 20 Apr" when the table says Sunday is 19
 * Apr. A wrong weekday+date pair destroys trust faster than almost any
 * other mistake.
 *
 * What this module does:
 *   1. Given the owner's timezone, build the same 14-day lookup the prompt
 *      has (today + 14 days). Key = date string "yyyy-MM-dd", value = weekday.
 *   2. Scan a draft reply for "Weekday N Mon [Year]" patterns — English and
 *      a few common Hebrew weekday variants.
 *   3. For each pair found, resolve N/Mon against the lookup (we match by
 *      month+day-of-month; year is implied). If the stated weekday doesn't
 *      match the lookup's weekday for that date, flag a mismatch.
 *   4. Return a structured result: list of mismatches, or empty.
 *
 * The caller decides what to do with mismatches — typically: re-invoke the
 * orchestrator with a corrective nudge listing the wrong pairs and the
 * correct day for each date. Fails OPEN on any parse error.
 */

import { DateTime } from 'luxon';
import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import logger from './logger';
import { config } from '../config';
import type { UserProfile } from '../config/userProfile';
import { getEffectiveToday } from './effectiveToday';

const MONTHS_EN: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAYS_EN: Record<string, number> = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 7, sun: 7,
};

// Hebrew weekday names → Luxon 1-7 (Mon-Sun)
const WEEKDAYS_HE: Record<string, number> = {
  'שני':     1,
  'שלישי':   2,
  'רביעי':   3,
  'חמישי':   4,
  'שישי':    5,
  'שבת':     6,
  'ראשון':   7,
  'א':       7,  // יום א' = Sunday
  'ב':       1,  // יום ב' = Monday
  'ג':       2,
  'ד':       3,
  'ה':       4,
  'ו':       5,
};

const MONTHS_HE: Record<string, number> = {
  'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'אפריל': 4,
  'מאי': 5, 'יוני': 6, 'יולי': 7, 'אוגוסט': 8,
  'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12,
};

export interface DateMismatch {
  writtenWeekday: string;  // as it appeared in the text
  writtenDate: string;     // "DD Mon" as it appeared
  correctWeekday: string;  // what it should have been per the lookup
  date: string;            // yyyy-MM-dd resolved
}

export interface DateVerifyResult {
  ok: boolean;
  mismatches: DateMismatch[];
}

function buildLookup(profile: UserProfile): Map<string, number> {
  // Maps "MM-DD" → Luxon weekday (1=Mon..7=Sun) across today + 14 days.
  // MM-DD is enough because the LLM won't reference dates outside this
  // horizon in a single reply in practice.
  // Anchor uses getEffectiveToday so the late-night shift matches the
  // prompt's DATE LOOKUP table.
  const today = getEffectiveToday(profile);
  const map = new Map<string, number>();
  for (let i = 0; i < 14; i++) {
    const d = today.plus({ days: i });
    map.set(d.toFormat('MM-dd'), d.weekday);
    // Also register the year+month+day combo for absolute disambiguation.
    map.set(d.toFormat('yyyy-MM-dd'), d.weekday);
  }
  return map;
}

function weekdayName(weekday: number, style: 'en' | 'he'): string {
  if (style === 'he') {
    const lut: Record<number, string> = { 1: 'שני', 2: 'שלישי', 3: 'רביעי', 4: 'חמישי', 5: 'שישי', 6: 'שבת', 7: 'ראשון' };
    return lut[weekday] ?? '';
  }
  const lut: Record<number, string> = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };
  return lut[weekday] ?? '';
}

export async function verifyDates(draft: string, profile: UserProfile, userMessage?: string): Promise<DateVerifyResult> {
  const mismatches: DateMismatch[] = [];
  if (!draft || draft.length < 6) return { ok: true, mismatches };

  let lookup: Map<string, number>;
  try {
    lookup = buildLookup(profile);
  } catch (err) {
    logger.warn('dateVerifier: could not build lookup — failing open', { err: String(err) });
    return { ok: true, mismatches };
  }

  // Pattern A (English): "Weekday[,] N Mon [Year]?" — handles "Sunday 20 Apr",
  // "Sunday, 20 April 2026", "Sun 20 Apr". Allow "the" and ordinal suffixes.
  const enRe = /\b(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)[,\s]+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b(?:\s+(\d{4}))?/gi;

  let m: RegExpExecArray | null;
  while ((m = enRe.exec(draft)) !== null) {
    const wdText = m[1];
    const dayNum = parseInt(m[2], 10);
    const monText = m[3];
    const writtenWd = WEEKDAYS_EN[wdText.toLowerCase()];
    const monthNum = MONTHS_EN[monText.toLowerCase()];
    if (!writtenWd || !monthNum) continue;
    const key = `${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const correctWd = lookup.get(key);
    if (!correctWd) continue;  // date outside the 14-day window
    if (correctWd !== writtenWd) {
      mismatches.push({
        writtenWeekday: wdText,
        writtenDate: `${dayNum} ${monText}`,
        correctWeekday: weekdayName(correctWd, 'en'),
        date: key,
      });
    }
  }

  // Pattern B (Hebrew): "יום X DD בYYY" — e.g. "יום ראשון 19 באפריל"
  const heRe = /יום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|א|ב|ג|ד|ה|ו)[׳']?[\s,]+(\d{1,2})\s+ב?(ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)/g;
  while ((m = heRe.exec(draft)) !== null) {
    const wdText = m[1];
    const dayNum = parseInt(m[2], 10);
    const monText = m[3];
    const writtenWd = WEEKDAYS_HE[wdText];
    const monthNum = MONTHS_HE[monText];
    if (!writtenWd || !monthNum) continue;
    const key = `${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const correctWd = lookup.get(key);
    if (!correctWd) continue;
    if (correctWd !== writtenWd) {
      mismatches.push({
        writtenWeekday: `יום ${wdText}`,
        writtenDate: `${dayNum} ב${monText}`,
        correctWeekday: `יום ${weekdayName(correctWd, 'he')}`,
        date: key,
      });
    }
  }

  // The LLM bare-weekday context pass was REMOVED. It repeatedly hallucinated a
  // target date for a bare weekday that had no anchor and REWROTE correct
  // weekdays — Thursday→Monday then Thursday→Friday on the UNIC booking (the
  // corrupted text was even persisted to history, so a confirming "ok" risked
  // a wrong-day booking), and earlier the Michal mis-delete. It was also
  // language-coupled (needed per-language anchor/weekday lists, which leak the
  // tenant's language). Only the DETERMINISTIC weekday+date pair checks above
  // run now — they never guess a date, so they can't corrupt a correct one.
  if (mismatches.length > 0) {
    logger.warn('dateVerifier: weekday/date mismatches in draft', { mismatches });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Build a short corrective nudge for the retry path. */
export function buildDateCorrectionNudge(mismatches: DateMismatch[]): string {
  const lines = mismatches.map(m =>
    `- "${m.writtenWeekday} ${m.writtenDate}" is wrong. ${m.date} is actually ${m.correctWeekday}.`
  );
  return `Your previous draft had wrong weekday/date pairs:
${lines.join('\n')}
Use the DATE LOOKUP table at the top of your system prompt for every weekday+date pair. Rewrite the reply with correct dates.`;
}

/**
 * v3.1.5 (Bug 4) — cheap date-correction rewrite. Replaces the old remedy of
 * re-invoking the WHOLE orchestrator (which re-sent the ~46K cached prefix +
 * all tool defs + history and re-ran the tool loop — ~30s on a long report).
 *
 * This is a single tool-less Sonnet call: it gets ONLY the draft + the exact
 * corrections, and re-renders the prose. No tools, no orchestrator prefix, no
 * calendar re-fetch — fewer tokens than the original turn, ~1-2s. Because it
 * re-renders (rather than blindly swapping a weekday token), it also fixes the
 * grouped-report case correctly: if events sat under a wrong day header, they
 * move under the right one. Fails open (returns null) — caller keeps the
 * deterministic token-rewrite as the final safety net.
 */
export async function rewriteWithCorrectDates(
  draft: string,
  mismatches: DateMismatch[],
  _profile: UserProfile,
): Promise<string | null> {
  if (mismatches.length === 0) return null;
  const corrections = mismatches
    .map(m => `- "${m.writtenWeekday} ${m.writtenDate}" → ${m.date} is actually ${m.correctWeekday}.`)
    .join('\n');
  const prompt = `You are fixing wrong weekday/date labels in a message that was ALREADY written and sent for review. Do NOT change anything except what the corrections require.

Corrections (authoritative — these dates are correct):
${corrections}

Rules:
- Fix every wrong weekday/date pair to match the corrections.
- Keep all other content identical: event names, times, locations, wording, structure, emoji, formatting.
- If events are grouped under a day header that was mislabeled, keep each event under the date it actually belongs to (correct the header AND make sure the events under it are the ones for that real date — don't strand events under the wrong day).
- Output ONLY the corrected message text. No preamble, no explanation, no code fences.

Message to correct:
${draft}`;

  try {
    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (resp.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined)?.text ?? '';
    const out = text.trim().replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    return out.length > 0 ? out : null;
  } catch (err) {
    logger.warn('rewriteWithCorrectDates threw — caller falls back to deterministic correction', {
      err: String(err).slice(0, 200),
    });
    return null;
  }
}
