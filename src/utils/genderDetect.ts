import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { MODEL_HAIKU } from '../llm/models';
import { getPersonMemory, setCoreFieldWithProvenance } from '../db';
import type { PersonGender, CoreFieldSetBy } from '../db';
import { detectMessageLanguage } from './detectMessageLanguage';
import logger from './logger';

// ── Step 1: Pronouns ──────────────────────────────────────────────────────────

export function detectGenderFromPronouns(pronouns: string | undefined): PersonGender {
  if (!pronouns) return 'unknown';
  // Match whole tokens in the structured pronouns field: "she/her" contains
  // the substring "he/", which previously misread a woman's declaration.
  const tokens = pronouns.toLowerCase().split(/[\s/,]+/);
  const male = tokens.includes('he') || tokens.includes('him');
  const female = tokens.includes('she') || tokens.includes('her');
  if (male && !female) return 'male';
  if (female && !male) return 'female';
  return 'unknown';
}

// Photo and name inference are retired. Only a person's declarations are signals.

// Step 2: first-person morphology in the person's OWN message.

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
  // No ANTHROPIC_API_KEY-only guard here:
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
 * Slack pronouns and opt-in first-person Hebrew morphology are declarations,
 * recorded at person authority. Store provenance prevents either from
 * overwriting the owner's decision. Photo/name guesses are never made.
 * Morphology requires selfText from this exact person's live message and the
 * existing advanced.self_declared_gender_detection opt-in at the caller.
 * Without a declaration, gender remains unknown.
 *
 * Runs fire-and-forget in the background — never blocks message handling.
 * Known gender skips the model tiers; deterministic pronoun corrections still run.
 * This preserves the existing model-call gate.
 */
export async function detectAndSaveGender(params: {
  slackId: string;
  name: string;
  pronouns?: string;
  /** #51 — this slackId's OWN message text, passed only when the tenant has
   *  opted into `advanced.self_declared_gender_detection`. Omit entirely at
   *  call sites that aren't a live message from this exact person (directory
   *  lookups, @mention resolution of a THIRD party) — passing another
   *  person's text here would attribute their words to this slackId. */
  selfText?: string;
}): Promise<void> {
  const { slackId, name, pronouns, selfText } = params;

  const existing = getPersonMemory(slackId);
  // Deterministic declarations can correct an old guess without spending an
  // additional model call. Known values still skip morphology.
  const pronounGender = detectGenderFromPronouns(pronouns);
  if (existing?.gender && existing.gender !== 'unknown' && pronounGender === 'unknown') return;

  // Step 1 — pronouns. A Slack pronouns field is the person's OWN declaration,
  // so record it as 'person': it steers gendered forms and an 'auto' signal
  // can't clobber it (owner can still override).
  let gender = pronounGender;
  let setBy: CoreFieldSetBy = 'person';
  let source: 'pronouns' | 'self_declaration' = 'pronouns';

  // Existing opt-in morphology classifier: only the same person's own Hebrew
  // message can supply a declaration. No model call is added by photo removal.
  if (gender === 'unknown' && selfText && detectMessageLanguage(selfText) === 'Hebrew') {
    gender = await detectGenderFromSelfDeclaredMorphology(selfText, 'Hebrew');
    setBy = 'person';
    source = 'self_declaration';
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
