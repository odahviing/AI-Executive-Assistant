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
import logger from './logger';

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

function buildLookup(timezone: string): Map<string, number> {
  // Maps "MM-DD" → Luxon weekday (1=Mon..7=Sun) across today + 14 days.
  // MM-DD is enough because the LLM won't reference dates outside this
  // horizon in a single reply in practice.
  const today = DateTime.now().setZone(timezone).startOf('day');
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

export function verifyDates(draft: string, timezone: string): DateVerifyResult {
  const mismatches: DateMismatch[] = [];
  if (!draft || draft.length < 6) return { ok: true, mismatches };

  let lookup: Map<string, number>;
  try {
    lookup = buildLookup(timezone);
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
