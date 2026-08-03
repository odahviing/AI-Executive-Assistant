/**
 * Owner-says-done scanner — LLM-only (v2.7.0 spine).
 *
 * Reads open `requests` (the spine). When the owner's free-text message says
 * "done / dropped / handled" about one of them, closes via `closeRequest`.
 *
 * Per owner direction (v2.6.5): no keyword pre-filter. LLM-only is the gate.
 * Conservative SYSTEM_PROMPT keeps false positives near zero. Empty open-items
 * → no LLM call (cost bound).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { MODEL_HAIKU } from '../llm/models';
import type { UserProfile } from '../config/userProfile';
import { getOpenScannerItems } from '../db/requests';
import { closeRequest } from '../core/requests/closeRequest';
import { parseDetails, type RequestRow } from '../core/requests/types';
import logger from './logger';
import { logLlmUsage } from './usageLog';
import { parseFirstJsonObject } from './extractJson';

interface ScannerResult {
  scanned: boolean;
  closedItems: Array<{ id: string; kind: string; reason: string }>;
}

const SYSTEM_PROMPT = `You scan an owner message for closure signals against a list of open tracked requests.

Your job: identify which requests (if any) the owner just told the assistant are DONE / DROPPED / HANDLED / NO LONGER NEEDED.

Be conservative. ONLY mark a request closed if:
  - The owner's message clearly references it (by name, colleague, topic, or unambiguous context)
  - AND the message clearly signals closure ("done", "drop it", "I handled it", "no need anymore", "cancel that", etc.)

Do NOT close requests based on:
  - Vague affirmations ("ok", "yes", "thanks") — those are conversation flow, not closure signals
  - Discussion / questions about the request ("how's the X coord going?") — that's interest, not closure
  - Future-tense plans ("I'll handle it tomorrow") — that's not done yet
  - Generic positive statements ("good", "looks good") — context-dependent, default skip

When in doubt, return EMPTY closed_items. False positives close real work; false negatives leave a row open for tomorrow's brief to surface again — second chance.

Output strict JSON, no markdown:
{ "closed_items": [ { "id": "...", "reason": "<short — what owner said>" } ] }

If nothing closes: { "closed_items": [] }`;

// Generic words common to many request subjects — not distinctive enough to
// anchor a closure on their own. Was English-only even after the tokenizer
// below was widened to admit every script (hebrew-stopwords-english-only,
// verify finding) — a subject like "פגישה עם דני" (Hebrew "meeting with
// Danny") had "פגישה" (meeting) survive as a "distinctive" token, so any
// owner message that happened to mention ANY meeting in Hebrew could anchor
// a closure on this one. Covers the same generic-scheduling-vocabulary
// categories as the English set, in the other languages Maelle is documented
// to support (Hebrew, Russian, Spanish) — add here, not a parallel list, when
// a new language needs the same words.
const SUBJECT_STOPWORDS = new Set([
  // English
  'meeting', 'meet', 'call', 'coordinating', 'coordinate', 'coordination', 'sync',
  'with', 'about', 'quick', 'demo', 'intro', 'chat', 'session', 'follow', 'followup',
  'reschedule', 'booking', 'request', 'event', 'time', 'catch', 'the', 'and', 'for',
  // Hebrew
  'פגישה', 'פגישת', 'שיחה', 'שיחת', 'סנכרון', 'תיאום', 'מהיר', 'מהירה',
  'היכרות', 'מפגש', 'מעקב', 'קביעה', 'הזמנה', 'בקשה', 'אירוע',
  // Russian
  'встреча', 'встречи', 'звонок', 'координация', 'синхронизация', 'синк', 'демо',
  'быстрый', 'быстрая', 'быстро', 'знакомство', 'сессия', 'перенос', 'перенести',
  'бронирование', 'бронь', 'запрос', 'событие', 'время',
  // Spanish
  'reunión', 'reunion', 'llamada', 'coordinación', 'coordinacion', 'sobre', 'acerca',
  'rápido', 'rapido', 'rápida', 'rapida', 'introducción', 'introduccion', 'sesión',
  'sesion', 'seguimiento', 'reprogramar', 'reagendar', 'reserva', 'reservación',
  'reservacion', 'solicitud', 'evento', 'tiempo', 'para',
]);

/**
 * Deterministic backstop for the LLM scanner (the Eli false-close fix). The
 * model sometimes matches a GENERIC closure ("just cancel the event") to a
 * NAMED request it doesn't actually reference — e.g. the owner's "cancel the
 * event" meant a different meeting, but the scanner closed the Eli coord. The
 * prompt already forbids this, but the model ignored it under load, so we
 * enforce it in code: only let a closure through when the owner's message
 * actually names the request's counterpart OR carries a distinctive token from
 * its subject. Fails SAFE — a blocked-but-legit closure just leaves the row for
 * tomorrow's brief to resurface (the scanner's own preferred failure mode).
 *
 * Exported (v4.4.x, GH#169/#176) — resolve_approval's cross-thread bare-ack
 * anchor gate (tasks/skill.ts) reuses this SAME referent check as its
 * unanchored-but-named fallback, rather than growing a second, looser copy.
 * That caller grounds it on the owner's own literal turn text (never a tool
 * argument the model authors itself) — see the comment at its call site.
 *
 * GH#169 — the length>=4-and-not-a-stopword subject filter let NOTHING through
 * for a subject like "ANF OH meeting": "anf"/"oh" are too short, "meeting" is a
 * stopword — so an owner saying "ANF already done" could never reference it,
 * no matter how explicitly he named it. Short (3-char) tokens now also count
 * when they're rendered ALL-CAPS in the ORIGINAL subject — an acronym/code
 * ("ANF", "CEO") — while ordinary short words stay excluded because a real
 * subject virtually never capitalizes "the"/"and"/"for" as a whole word.
 *
 * GH#169 revisit (owner ruling 2026-08-0x) — every match below is now a WHOLE
 * WORD, not a plain substring: `msg.includes(t)` matched "app" inside
 * "appointment", so a 3-char ALL-CAPS token like "APP" (from a subject like
 * "APP launch") bound to any message that merely contained the word
 * "appointment". hasWholeWordMatch checks the characters either side of the
 * match aren't letters/digits, using Unicode letter/number classes (not the
 * ASCII-only \b) so this stays correct for Hebrew/Russian/etc. subjects and
 * names too, not just English ones.
 *
 * hebrew-definite-article-breaks-whole-word-match (verify finding) — that
 * boundary test assumes every language separates two words with a delimiter.
 * Hebrew doesn't: the definite article and a handful of one-letter
 * prepositions/conjunctions (ה/ו/ב/כ/ל/מ/ש — "the/and/in/as/to/from/that")
 * attach directly onto the next word with no space at all, e.g. "הפגישה"
 * ("the meeting") is one token, not two. Searching for needle "פגישה" inside
 * it found a real match, but the character right before it ("ה") is a letter,
 * so the plain boundary test rejected it — the natural way to reference an
 * approval with the definite article could never match. `leftOk` below now
 * also treats "one of those single proclitic letters, itself preceded by a
 * real boundary" as a valid left edge. Suffix side is untouched: Hebrew
 * proclitics only ever prefix a word, they never attach after one.
 */
// One-letter Hebrew proclitics that prefix directly onto a word with no
// separator (the definite article ה plus the standard set of one-letter
// prepositions/conjunctions — traditionally grouped as the מש"ה וכל"ב letters).
const HEBREW_PROCLITICS = new Set(['ה', 'ו', 'ב', 'כ', 'ל', 'מ', 'ש']);

function hasWholeWordMatch(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const isWordChar = (ch: string) => ch !== '' && /[\p{L}\p{N}]/u.test(ch);
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? haystack[idx - 1] : '';
    const beforeBefore = idx > 1 ? haystack[idx - 2] : '';
    const after = idx + needle.length < haystack.length ? haystack[idx + needle.length] : '';
    const leftOk = !isWordChar(before)
      || (HEBREW_PROCLITICS.has(before) && !isWordChar(beforeBefore));
    if (leftOk && !isWordChar(after)) return true;
    from = idx + 1;
  }
}

export function messageReferencesRequest(message: string, row: RequestRow): boolean {
  const msg = ` ${message.toLowerCase()} `;
  const det = parseDetails<Record<string, unknown>>(row) ?? {};
  const counterpart = String(row.target_name || row.requester_name || (det.requester_name as string | undefined) || '');
  const first = counterpart.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (first.length >= 3 && hasWholeWordMatch(msg, first)) return true;
  const rawSubject = String(row.subject ?? '');
  // hebrew-subject-token-match-dead — was ASCII-only ([^A-Za-z0-9]+), which
  // treats every character of a non-Latin subject (Hebrew, Russian, ...) as a
  // delimiter, splitting the whole subject into zero tokens. \p{L}\p{N} is the
  // same Unicode-aware word-boundary class hasWholeWordMatch above already
  // uses, so a subject in any script now tokenizes correctly.
  const rawTokens = rawSubject.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens = rawTokens
    .map(raw => raw.toLowerCase())
    .filter((lower, i) => {
      if (SUBJECT_STOPWORDS.has(lower)) return false;
      if (lower.length >= 4) return true;
      const raw = rawTokens[i];
      // 3-char acronym/code exception: ALL-CAPS in the original text and not
      // purely numeric ("ANF" yes, a bare "123" no).
      return lower.length === 3 && raw === raw.toUpperCase() && /[A-Za-z]/.test(raw);
    });
  if (tokens.some(t => hasWholeWordMatch(msg, t))) return true;
  return false;
}

export async function closeLoopOnOwnerHandled(params: {
  profile: UserProfile;
  ownerMessage: string;
}): Promise<ScannerResult> {
  const result: ScannerResult = { scanned: false, closedItems: [] };
  if (!params.ownerMessage || params.ownerMessage.length < 3) return result;

  const open = getOpenScannerItems(params.profile.user.slack_user_id);
  if (open.length === 0) return result;
  result.scanned = true;

  let closedIds: Array<{ id: string; reason: string }> = [];
  try {
    const client = getAnthropicClient();
    const userPrompt = [
      `Owner just said: "${params.ownerMessage.slice(0, 800)}"`,
      ``,
      `Open tracked requests (${open.length}):`,
      ...open.slice(0, 25).map(r => {
        const det = parseDetails<Record<string, unknown>>(r) ?? {};
        const counterpart = r.target_name || r.requester_name || (det.requester_name as string | undefined) || '';
        const cp = counterpart ? ` [counterpart: ${counterpart}]` : '';
        const kindLabel = r.subkind ? `${r.kind}/${r.subkind}` : r.kind;
        return `  - id=${r.id} (${kindLabel}, ${r.state}): ${r.subject}${cp}`;
      }),
      ``,
      `Which requests did the owner just close? JSON only.`,
    ].join('\n');

    const resp = await client.messages.create({
      // v4.0.x (PERF-3) — Haiku, not Sonnet: the last Sonnet straggler in the guard
      // set. Safety is model-independent — the conservative SYSTEM_PROMPT + the
      // deterministic messageReferencesRequest backstop (below) + fail-open all hold,
      // and a missed close just resurfaces in tomorrow's brief (safe miss either way).
      model: MODEL_HAIKU,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    logLlmUsage('close_loop', MODEL_HAIKU, resp);
    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();
    // v3.8.x — shared balanced-object extractor (strips fences + tolerates trailing
    // prose), same as the gate stack. Raw JSON.parse threw on trailing prose → the
    // catch fired → no close (an owner-handled request lingered open). null → skip.
    const parsed = parseFirstJsonObject<{ closed_items?: Array<{ id?: string; reason?: string }> }>(text);
    if (parsed && Array.isArray(parsed.closed_items)) {
      closedIds = parsed.closed_items
        .filter(c => typeof c.id === 'string' && c.id.length > 0)
        .map(c => ({ id: c.id as string, reason: typeof c.reason === 'string' ? c.reason : '' }));
    }
  } catch (err) {
    logger.warn('closeLoopOnOwnerHandled: LLM pass failed — fail-open', {
      err: String(err).slice(0, 300),
    });
    return result;
  }

  if (closedIds.length === 0) return result;

  const idToRow = new Map<string, RequestRow>(open.map(r => [r.id, r]));
  for (const { id, reason } of closedIds) {
    const row = idToRow.get(id);
    if (!row) {
      logger.warn('closeLoopOnOwnerHandled: LLM returned unknown id — skipping', { id });
      continue;
    }
    // Deterministic referent backstop (Eli false-close fix). Refuse to close a
    // request the owner's message doesn't actually reference by counterpart or
    // a distinctive subject token. Safe direction: leave it open for the brief.
    if (!messageReferencesRequest(params.ownerMessage, row)) {
      logger.info('closeLoopOnOwnerHandled: LLM matched a request the message does not reference by name/topic — refusing close (safe)', {
        id, kind: row.kind, subject: row.subject,
        counterpart: row.target_name ?? row.requester_name ?? null,
        reason: reason.slice(0, 80),
      });
      continue;
    }
    try {
      closeRequest({
        id,
        state: 'cancelled',
        closureReason: `owner_said_done: ${reason.slice(0, 120)}`,
        closedBy: 'scanner',
      });
      result.closedItems.push({ id, kind: row.kind, reason });
      logger.info('closeLoopOnOwnerHandled: closed request', {
        id, kind: row.kind, reason: reason.slice(0, 100),
      });
    } catch (err) {
      logger.warn('closeLoopOnOwnerHandled: closeRequest threw — skipping', {
        id, err: String(err).slice(0, 200),
      });
    }
  }
  return result;
}
