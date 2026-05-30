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

  // v1.8.5 — LLM-based context verifier. Catches bare-weekday misreferences
  // that slip past the weekday+date regex patterns above. Fires only if:
  //   - the draft contains a bare weekday (cheap regex pre-gate, no LLM if not)
  //   - no weekday+date mismatch already found (if the regex caught it, LLM
  //     doesn't need to redo the work)
  //   - userMessage is present (gives the classifier context to judge against)
  //
  // Runs on Sonnet (per owner's call — not Haiku). Cost is one small call per
  // reply that happens to contain a weekday, which is a small fraction of
  // replies. Fails open on any error.
  const bareWeekdayRe = /\b(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\b/i;
  const draftHasBareWeekday = bareWeekdayRe.test(draft);
  if (draftHasBareWeekday && mismatches.length === 0 && userMessage && userMessage.length > 0) {
    try {
      const contextMismatches = await verifyBareWeekdayContext({
        draft,
        userMessage,
        profile,
      });
      for (const cm of contextMismatches) mismatches.push(cm);
    } catch (err) {
      logger.warn('dateVerifier: LLM context pass failed — skipping', { err: String(err) });
    }
  }

  if (mismatches.length > 0) {
    logger.warn('dateVerifier: weekday/date mismatches in draft', { mismatches });
  }
  return { ok: mismatches.length === 0, mismatches };
}

// ── v1.8.5 LLM context verifier ─────────────────────────────────────────────
// Sonnet classifier: given the user's message, Maelle's draft, and a 14-day
// lookup anchored on today, identify any bare weekday in the draft that's
// contextually wrong. Judgment on phrasing; determinism stays in the regex
// checks above. Strict JSON output, fails open on parse errors.
async function verifyBareWeekdayContext(params: {
  draft: string;
  userMessage: string;
  profile: UserProfile;
}): Promise<DateMismatch[]> {
  // Anchor on effective-today so the lookup matches the prompt's DATE LOOKUP
  // (post late-night shift). Without this, the classifier sees a different
  // "Today" / "Tomorrow" than the model wrote against and flags correct
  // answers as mismatches.
  const today = getEffectiveToday(params.profile);
  const lookupLines = Array.from({ length: 14 }, (_, i) => {
    const d = today.plus({ days: i });
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toFormat('EEE d MMM');
    return `${label} (${d.toFormat('EEEE')}): ${d.toFormat('yyyy-MM-dd')}`;
  }).join('\n');

  const prompt = `You are a weekday-consistency checker for a calendar assistant's reply draft. Output strict JSON only, no prose, no fences.

USER'S MESSAGE:
${params.userMessage}

ASSISTANT'S DRAFT REPLY:
${params.draft}

DATE LOOKUP (today and next 13 days in the user's timezone):
${lookupLines}

Task: find any bare weekday reference in the draft (e.g. "Monday's calendar", "on Monday", "this Monday", "Monday morning") that is CONTEXTUALLY WRONG given the user's message + the date lookup.

Rules for judging:
- If the user's message refers to a day relative to now (today / tomorrow / this afternoon / at 3pm / tonight / in an hour / later / EOD / now), the reply's weekday must match the ACTUAL weekday for that day.
- If the user explicitly named a weekday (e.g. "on Friday") and the reply uses the same weekday, that's fine.
- A future-facing weekday far from now ("I'll ping you Monday" when today is Sunday) is NOT wrong — it refers to the next Monday, not a mismatched today.
- Only flag mismatches where the weekday clearly refers to the day the user is asking about.
- DO NOT flag a weekday that's already QUALIFIED BY A DATE next to it ("Tuesday 19 May", "Friday, June 7th", "Mon 20 Apr") — those are weekday+date pairs and a separate deterministic check handles them. If the weekday has a calendar date right next to it, it's NOT a bare weekday for the purposes of this task. Skip it.

Output:
{
  "mismatches": [
    {
      "written_weekday": "Monday",
      "draft_excerpt": "Monday's calendar",
      "correct_weekday": "Sunday",
      "target_date": "2026-04-19"
    }
  ]
}

Empty array if everything is consistent. Keep output minimal.`;

  const anthropic = getAnthropicClient();
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (resp.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined)?.text ?? '';
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  const parsed = JSON.parse(jsonMatch[0]) as {
    mismatches?: Array<{
      written_weekday: string;
      draft_excerpt?: string;
      correct_weekday: string;
      target_date: string;
    }>;
  };
  if (!parsed.mismatches || parsed.mismatches.length === 0) return [];

  // v2.8.6 — defensive post-filter. The LLM sometimes flags weekdays that
  // are already qualified by a date right next to them (e.g. "Tuesday 19
  // May"). Those are weekday+date pairs — the regex pass at the top of
  // verifyDates already validates them. If the regex didn't fire a
  // mismatch for THIS draft, any LLM mismatch on a qualified weekday is
  // almost certainly a hallucination (root of the 2026-05-18 Michal
  // incident: draft said "from Tuesday 19 May" which is correct; LLM
  // returned correctWeekday=Monday; the spurious retry that followed
  // deleted the wrong meeting).
  const dateAdjacentRe = /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

  return parsed.mismatches
    .filter(mm => mm.written_weekday && mm.correct_weekday && mm.written_weekday !== mm.correct_weekday)
    .filter(mm => {
      // Drop the mismatch when the excerpt clearly carries a date next to
      // the weekday — that's not a bare weekday. The regex pass owns that
      // case and would have caught any real mismatch.
      if (mm.draft_excerpt && dateAdjacentRe.test(mm.draft_excerpt)) {
        logger.info('dateVerifier: dropping LLM mismatch on qualified weekday (date adjacent)', {
          excerpt: mm.draft_excerpt, llmCorrectWeekday: mm.correct_weekday,
        });
        return false;
      }
      return true;
    })
    .map(mm => ({
      writtenWeekday: mm.written_weekday,
      writtenDate: mm.draft_excerpt ? `(${mm.draft_excerpt})` : '(bare weekday)',
      correctWeekday: mm.correct_weekday,
      date: mm.target_date || '',
    }));
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
