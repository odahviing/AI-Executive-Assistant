import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { SONNET, MODEL_HAIKU } from '../llm/models';
import { config } from '../config';
import { getPersonMemory, setCoreFieldWithProvenance } from '../db';
import type { PersonGender, CoreFieldSetBy } from '../db';
import { detectMessageLanguage } from './detectMessageLanguage';
import logger from './logger';

// ── Step 1: Pronouns ──────────────────────────────────────────────────────────

export function detectGenderFromPronouns(pronouns: string | undefined): PersonGender {
  if (!pronouns) return 'unknown';
  const p = pronouns.toLowerCase();
  if (p.includes('he/') || p.startsWith('he ') || p === 'he' || p.includes('/him')) return 'male';
  if (p.includes('she/') || p.startsWith('she ') || p === 'she' || p.includes('/her')) return 'female';
  return 'unknown';
}

// ── Step 2: Profile image via Claude vision ───────────────────────────────────

async function fetchImageAsBase64(
  url: string,
  botToken?: string,
): Promise<{ data: string; mediaType: string } | null> {
  try {
    const headers: Record<string, string> = {};
    // Slack CDN URLs sometimes need the bot token as Bearer auth
    if (botToken && url.includes('slack')) {
      headers['Authorization'] = `Bearer ${botToken}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const data = Buffer.from(buf).toString('base64');
    const ct = res.headers.get('content-type') || 'image/jpeg';
    const mediaType = ct.split(';')[0].trim();
    return { data, mediaType };
  } catch {
    return null;
  }
}

async function detectGenderFromImage(
  imageUrl: string,
  name: string,
  botToken?: string,
): Promise<PersonGender> {
  if (!config.ANTHROPIC_API_KEY) return 'unknown';

  const image = await fetchImageAsBase64(imageUrl, botToken);
  if (!image) return 'unknown';

  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 5,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType as any, data: image.data },
          },
          {
            type: 'text',
            text: `Profile photo of "${name}". Reply with ONLY one word: male, female, or unknown.`,
          },
        ],
      }],
    });

    const answer = ((response.content[0] as any)?.text ?? '').toLowerCase().trim();
    if (answer === 'male')   return 'male';
    if (answer === 'female') return 'female';
    return 'unknown';
  } catch (err) {
    logger.debug('Gender image detection failed', { name, err: String(err) });
    return 'unknown';
  }
}

// v3.5.x — the name-based LLM gender guess was REMOVED. It mis-cast a female
// "Daniel" as male and shipped masculine Hebrew before any real signal existed
// (2026-06-29). Guessing gender from a name is unsafe in any language; we now
// rely only on a self-declaration (pronouns) or a weak image signal, and stay
// 'unknown' otherwise (the reply goes gender-neutral; ask only if unavoidable).

// ── Step 3: first-person morphology in the person's OWN message (#51) ────────

// Slack renders a quoted/forwarded line with a leading "> " — strip those
// lines before judging self-declaration. This is a STRUCTURAL strip (Slack
// markup, language-independent), not natural-language processing, so doing
// it with a regex ahead of the classifier doesn't violate the no-regex-on-
// meaning rule. A first-person form the author is only QUOTING or relaying
// from someone else is not a self-declaration.
function stripQuotedLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim();
}

// Below this, a message is too short to carry a first-person pronoun PLUS a
// gendered verb/adjective ("אני שמח" is 7 characters) — skip the call rather
// than spend a Haiku round-trip judging noise like "היי" or an empty
// quote-stripped remainder.
const MIN_SELF_DECLARATION_CHARS = 6;

/**
 * Judge whether the AUTHOR's own first-person words reveal the AUTHOR's own
 * gender through grammatical morphology (Hebrew: "אני שמח" male / "אני שמחה"
 * female). Deliberately narrower than a general gender guess:
 *   - Only FIRST-person forms count. Second-person reveals the ADDRESSEE's
 *     gender (usually the owner or Maelle on a colleague's message — not the
 *     author); third-person reveals a mentioned party's gender. A detector
 *     with no slot for WHOSE gender it returned is the tombstoned Daniel bug
 *     (see the removed name-guess above) with a new input source.
 *   - Quoted/relayed first-person text does not count (caller strips
 *     structural quote lines; the prompt also tells the model to ignore
 *     quoted spans it can still see, e.g. inline quotation marks).
 * `language` is the human-readable name to reinforce for the classifier —
 * this function is NOT Hebrew-hardcoded (Arabic and Russian are also
 * gendered and also detected by detectMessageLanguage); only today's CALLER
 * gates on Hebrew specifically (see detectAndSaveGender below).
 */
export async function detectGenderFromSelfDeclaredMorphology(
  text: string,
  language: string,
): Promise<PersonGender> {
  // No ANTHROPIC_API_KEY-only guard here (unlike detectGenderFromImage above):
  // that check assumes Anthropic-direct and would silently no-op this tier
  // under LLM_PROVIDER=vertex, where the key is legitimately blank and
  // getAnthropicClient() routes to Vertex instead. The try/catch below
  // already fails safe to 'unknown' if the client can't be built or the call
  // errors, on either provider.
  const cleaned = stripQuotedLines(text);
  if (cleaned.length < MIN_SELF_DECLARATION_CHARS) return 'unknown';

  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 8,
      system:
        `This message is written in ${language}, a language that grammatically inflects verbs and adjectives ` +
        `by gender. Decide ONLY whether the AUTHOR reveals their OWN gender through a first-person gendered ` +
        `verb or adjective (Hebrew example: "אני שמח" = male author, "אני שמחה" = female author). ` +
        `Do NOT use: second-person forms (they reveal the ADDRESSEE's gender, not the author's), third-person ` +
        `forms (they reveal a mentioned person's gender, not the author's), or any first-person wording that is ` +
        `the author quoting or relaying someone else's words rather than speaking for themselves. ` +
        `If the author's own gender is not unambiguously revealed by their own first-person words, reply unknown. ` +
        `Reply with exactly one word: male, female, or unknown.`,
      messages: [{ role: 'user', content: cleaned }],
    });
    const answer = ((response.content[0] as Anthropic.TextBlock)?.text ?? '').trim().toLowerCase();
    if (answer.startsWith('male')) return 'male';
    if (answer.startsWith('female')) return 'female';
    return 'unknown';
  } catch (err) {
    logger.debug('Self-declared gender morphology detection failed', { err: String(err) });
    return 'unknown';
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Detect and persist gender for a workspace contact.
 *
 * Priority (each tier is a tentative auto-detection — NEVER overrides a
 * gender_confirmed=1 row, enforced in people.ts). Ordered strongest-and-
 * cheapest first, so a stronger 'person'-tier signal is never pre-empted by
 * the weaker 'auto' photo guess just because the photo happened to be checked
 * first:
 *   1. Slack pronouns field   → self-declaration → recorded as 'person' (steers)
 *   2. First-person Hebrew    → a self-declaration in the person's OWN message
 *      morphology (#51)         ("אני שמח"/"אני שמחה") → recorded as 'person',
 *                               same authority as pronouns. Opt-in
 *                               (`advanced.self_declared_gender_detection`,
 *                               default off) and only lit when the CALLER
 *                               passes `selfText` — that must be this same
 *                               slackId's own message, never a colleague's
 *                               directory profile text or someone else's words.
 *   3. Profile photo vision   → a weak guess, tried LAST → recorded as 'auto'
 *                               (does NOT steer gendered forms until confirmed
 *                               — people.ts).
 *   4. Stays 'unknown'        → reply stays gender-neutral; ask only if a gendered
 *                               form is unavoidable. We NEVER guess from the name.
 *
 * Runs fire-and-forget in the background — never blocks message handling.
 * Skips entirely if gender is already known (confirmed or not) — this is also
 * what caps step 2's cost at one Haiku call per person ever, not per turn.
 */
export async function detectAndSaveGender(params: {
  slackId: string;
  name: string;
  pronouns?: string;
  imageUrl?: string;
  botToken?: string;
  /** #51 — this slackId's OWN message text, passed only when the tenant has
   *  opted into `advanced.self_declared_gender_detection`. Omit entirely at
   *  call sites that aren't a live message from this exact person (directory
   *  lookups, @mention resolution of a THIRD party) — passing another
   *  person's text here would attribute their words to this slackId. */
  selfText?: string;
}): Promise<void> {
  const { slackId, name, pronouns, imageUrl, botToken, selfText } = params;

  // Skip if we already have a value — a tentative guess is still better than
  // nothing and can be overwritten on the NEXT strong signal via the normal
  // upsert paths. A confirmed value is also skipped here (can't be overridden
  // by auto-detection regardless).
  const existing = getPersonMemory(slackId);
  if (existing?.gender && existing.gender !== 'unknown') return;

  // Step 1 — pronouns. A Slack pronouns field is the person's OWN declaration,
  // so record it as 'person': it steers gendered forms and an 'auto' signal
  // can't clobber it (owner can still override).
  let gender = detectGenderFromPronouns(pronouns);
  let setBy: CoreFieldSetBy = 'person';
  let source: 'pronouns' | 'image' | 'self_declaration' = 'pronouns';

  // Step 2 — first-person Hebrew morphology self-declaration (#51). Tried
  // BEFORE the photo guess below — it's a self-declaration at the same
  // 'person' authority as pronouns, so a weaker 'auto' photo read must never
  // pre-empt it just by being checked first. Gated deterministically (zero
  // model calls) on detectMessageLanguage returning 'Hebrew' before the one
  // Haiku call this can spend. Hebrew-only for now —
  // detectGenderFromSelfDeclaredMorphology itself is language-generic, this
  // gate is the only Hebrew-specific line, so widening to Arabic/Russian
  // later is a one-line change here, not a signature change there.
  //
  // "The person can always override their own value" (owner decision) is NOT
  // this function re-firing — the skip-if-known guard above means this whole
  // pass only ever runs once per person. The override path is the explicit
  // `confirm_gender` tool (assistant.ts → confirmPersonGenderById), which
  // writes through setCoreFieldWithProvenanceById directly. That rank check
  // only refuses a write when the incoming rank is STRICTLY LOWER than the
  // current one (people.ts:407-420), so a person's own later correction —
  // arriving at the same 'person' rank as whatever is already stored — always
  // lands; verified in the store, no change needed there.
  if (gender === 'unknown' && selfText && detectMessageLanguage(selfText) === 'Hebrew') {
    gender = await detectGenderFromSelfDeclaredMorphology(selfText, 'Hebrew');
    setBy = 'person';
    source = 'self_declaration';
  }

  // Step 3 — profile image. A guess, not a declaration → 'auto', and tried
  // LAST — only when neither pronouns nor a self-declaration resolved it.
  // Under the people.ts render gate an 'auto' gender does NOT steer Hebrew
  // forms until confirmed, so a wrong photo read can't reproduce the
  // masculine-default bug.
  if (gender === 'unknown' && imageUrl) {
    gender = await detectGenderFromImage(imageUrl, name, botToken);
    setBy = 'auto';
    source = 'image';
  }

  if (gender !== 'unknown') {
    const outcome = setCoreFieldWithProvenance(slackId, 'gender', gender, setBy);
    logger.debug('Gender saved', {
      slackId, name, gender, setBy, source, outcome,
      // Evidence for the triggering phrase — auditable if a self-declared
      // read turns out wrong (#51).
      ...(source === 'self_declaration' ? { evidence: selfText!.slice(0, 200) } : {}),
    });
  }
}
