/**
 * Date verifier (v3.4 — Option C) — guard against wrong weekday/date pairs in
 * Maelle's replies, in ANY language, with no per-language name tables.
 *
 * The model occasionally writes a weekday that doesn't match the date during
 * multi-day prose (weekly reviews, day-named scheduling proposals): "Thursday
 * 11 June" when the 11th is a Wednesday, "יום חמישי 12 ביוני" when it isn't.
 * A wrong weekday+date pair destroys trust — and worse, an "ok" to a day-named
 * proposal can drive a wrong-day booking.
 *
 * DESIGN (language-agnostic, no hardcoded weekday/month tables):
 *   - An LLM (Haiku) ONLY EXTRACTS, in any language, the explicit "weekday +
 *     date" pairs literally present in the draft. It does NOT judge correctness
 *     and does NOT rewrite. It is forbidden from inventing a date for a bare
 *     weekday (the exact failure that got the old in-code LLM pass deleted) —
 *     it resolves a pair only to one of the concrete dates we hand it, else it
 *     drops the pair.
 *   - CODE owns the verdict: for each extracted pair, it looks the resolved ISO
 *     date up in the authoritative 14-day weekday lookup and flags a mismatch
 *     when the written weekday ≠ the real one.
 *   - CODE owns the fix (in the caller): a literal swap of the wrong weekday
 *     word inside the exact matched span (matchedText) — language-agnostic, and
 *     a no-op if the span isn't literally present in the draft.
 *
 * Three deterministic backstops keep a misread harmless: the swap fires only
 * when (a) the lookup actually disagrees, (b) the span literally exists in the
 * draft, and (c) it touches only the weekday word. The LLM cannot move the
 * verdict — it only reads.
 *
 * Gated on the presence of a day-of-month number, so pure-text / ack replies
 * never pay for the Haiku call. Fails OPEN on any error.
 */

import { DateTime } from 'luxon';
import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import logger from './logger';
import type { UserProfile } from '../config/userProfile';
import { getEffectiveToday } from './effectiveToday';
import { extractFirstJsonObject } from './extractJson';
import { logLlmUsage } from './usageLog';

const anthropic = getAnthropicClient();

// Universal fallback weekday names (Mon..Sun). Only used to label a correction
// when the extractor didn't return localized names — NOT a per-language table;
// the correct word is normally taken from the LLM's same-language rendering.
const WEEKDAY_EN_FALLBACK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface DateMismatch {
  writtenWeekday: string;  // exact weekday word as written — the token to swap out
  correctWeekday: string;  // correct weekday word, in the draft's own language/style
  date: string;            // ISO yyyy-MM-dd the pair referred to
  matchedText: string;     // the full weekday+date span exactly as written
}

export interface DateVerifyResult {
  ok: boolean;
  mismatches: DateMismatch[];
}

interface ExtractedPair {
  span: string;
  writtenWeekdayText: string;
  writtenWeekdayNum: number;   // 1=Mon..7=Sun — what the written word means
  isoDate: string | null;      // resolved to a provided date, or null (drop it)
}

function buildLookup(profile: UserProfile): { byIso: Map<string, number>; dates: DateTime[] } {
  // today + 14 days, anchored on getEffectiveToday so the late-night shift
  // matches the prompt's DATE LOOKUP table.
  const today = getEffectiveToday(profile);
  const byIso = new Map<string, number>();
  const dates: DateTime[] = [];
  for (let i = 0; i < 15; i++) {
    const d = today.plus({ days: i });
    byIso.set(d.toFormat('yyyy-MM-dd'), d.weekday);
    dates.push(d);
  }
  return { byIso, dates };
}

// Cheap gate: only worth an LLM call if the draft contains a standalone 1–2
// digit number (a possible day-of-month). No such number ⇒ no "weekday + Nth"
// pair is possible ⇒ skip the Haiku call entirely.
function hasDayNumber(text: string): boolean {
  return /\b\d{1,2}\b/.test(text);
}

async function extractWeekdayDatePairs(
  draft: string,
  dates: DateTime[],
): Promise<{ pairs: ExtractedPair[]; weekdayNames: string[] }> {
  const dateList = dates.map(d => d.toFormat('yyyy-MM-dd')).join(', ');
  const prompt = `You extract explicit "weekday + date" statements from a message. You do NOT judge whether they are correct, and you do NOT rewrite anything. Read only what is literally written, in ANY language.

VALID DATES (resolve every date to EXACTLY one of these ISO dates; if a written date is not clearly one of these, drop it):
${dateList}

MESSAGE:
"""
${draft}
"""

Find every place where a specific WEEKDAY word is stated together with a specific calendar DATE — e.g. "Thursday 11 June", "Tuesday the 5th", "Mon 9 Jun", "יום חמישי 12 ביוני", "jueves 24". For each, output:
- "span": the exact substring covering the weekday word AND the date, copied verbatim from the message.
- "writtenWeekdayText": the exact weekday word as written (e.g. "Thursday", "Thu", "יום חמישי").
- "writtenWeekdayNum": which day of week that word means — 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday, 7=Sunday.
- "isoDate": the date it refers to, resolved to one of the VALID DATES above. If the date isn't clearly one of those, OR if the weekday has NO explicit date written beside it, DROP the entry entirely.

CRITICAL: NEVER invent or guess a date for a weekday that has no explicit date next to it. A bare weekday with no date = no entry. Only output pairs where BOTH the weekday and its date are explicitly written.

Also output "weekdayNames": the 7 weekday names Monday→Sunday written in the SAME language and style they appear in the message (e.g. ["Monday",...,"Sunday"] or ["יום שני",...,"יום ראשון"]). If the message has no weekday words, return [].

Output STRICT JSON only, no prose, no code fences:
{"pairs":[{"span":"...","writtenWeekdayText":"...","writtenWeekdayNum":4,"isoDate":"2026-06-11"}],"weekdayNames":["...x7..."]}`;

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  logLlmUsage('date_verifier_extract', 'claude-haiku-4-5-20251001', resp);

  const raw = ((resp.content[0] as Anthropic.TextBlock)?.text ?? '').trim();
  const json = extractFirstJsonObject(raw) ?? raw;
  const parsed = JSON.parse(json) as { pairs?: unknown; weekdayNames?: unknown };

  const pairs: ExtractedPair[] = Array.isArray(parsed.pairs)
    ? (parsed.pairs as unknown[])
        .map((p): ExtractedPair => {
          const o = (p ?? {}) as Record<string, unknown>;
          return {
            span: typeof o.span === 'string' ? o.span : '',
            writtenWeekdayText: typeof o.writtenWeekdayText === 'string' ? o.writtenWeekdayText : '',
            writtenWeekdayNum: Number(o.writtenWeekdayNum),
            isoDate: typeof o.isoDate === 'string' ? o.isoDate : null,
          };
        })
        .filter(p => p.span && p.writtenWeekdayText && p.writtenWeekdayNum >= 1 && p.writtenWeekdayNum <= 7)
    : [];

  const weekdayNames: string[] = Array.isArray(parsed.weekdayNames)
    ? (parsed.weekdayNames as unknown[]).filter((n): n is string => typeof n === 'string')
    : [];

  return { pairs, weekdayNames };
}

export async function verifyDates(draft: string, profile: UserProfile, _userMessage?: string): Promise<DateVerifyResult> {
  const mismatches: DateMismatch[] = [];
  if (!draft || draft.length < 6) return { ok: true, mismatches };
  if (!hasDayNumber(draft)) return { ok: true, mismatches };  // no date-number ⇒ skip the LLM call

  let lookup: { byIso: Map<string, number>; dates: DateTime[] };
  try {
    lookup = buildLookup(profile);
  } catch (err) {
    logger.warn('dateVerifier: could not build lookup — failing open', { err: String(err) });
    return { ok: true, mismatches };
  }

  let extracted: { pairs: ExtractedPair[]; weekdayNames: string[] };
  try {
    extracted = await extractWeekdayDatePairs(draft, lookup.dates);
  } catch (err) {
    logger.warn('dateVerifier: extractor failed — failing open', { err: String(err).slice(0, 200) });
    return { ok: true, mismatches };
  }

  for (const pair of extracted.pairs) {
    if (!pair.isoDate) continue;
    const correctNum = lookup.byIso.get(pair.isoDate);
    if (!correctNum) continue;                            // date outside our window
    if (correctNum === pair.writtenWeekdayNum) continue;  // weekday is right — no action
    // Real mismatch. Correct name comes from the LLM's same-language rendering;
    // fall back to English only if it didn't provide one.
    const correctWeekday = extracted.weekdayNames[correctNum - 1] || WEEKDAY_EN_FALLBACK[correctNum - 1];
    if (!correctWeekday) continue;
    mismatches.push({
      writtenWeekday: pair.writtenWeekdayText,
      correctWeekday,
      date: pair.isoDate,
      matchedText: pair.span,
    });
  }

  if (mismatches.length > 0) {
    logger.warn('dateVerifier: weekday/date mismatches in draft', { mismatches });
  }
  return { ok: mismatches.length === 0, mismatches };
}
