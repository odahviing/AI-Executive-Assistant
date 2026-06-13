/**
 * Per-turn message-language detection (v3.3.x — RC3).
 *
 * WHY: the reply-language rule is a STATIC line in the system prompt
 * ("CURRENT TURN WINS — reply in the language of this turn's message").
 * Static rules decay across a thread — Sonnet honors it on turn 1 and drifts
 * by turn 3, especially when Hebrew tool-results / memory files bleed into
 * context. The durable fix is to RE-STAMP the detected language into the
 * (uncached) dynamic prompt block every turn, so the directive can't fade.
 *
 * This detector is the cheap, deterministic half of that: it reads the
 * DOMINANT Unicode SCRIPT of the inbound message — no model call, no
 * dependency. It returns a language NAME only for the scripts that actually
 * cause drift in this product (Hebrew, Cyrillic→Russian, Arabic). For
 * Latin-script input it returns null on purpose: script can't tell English
 * from Spanish/French, and those don't suffer the tool-result bleed — so the
 * existing static CURRENT-TURN-WINS rule handles them fine.
 */

interface ScriptRange {
  name: string;
  test: (codePoint: number) => boolean;
}

// Letter ranges only (we count letters, not punctuation/whitespace/digits).
const SCRIPTS: ScriptRange[] = [
  { name: 'Hebrew', test: (c) => c >= 0x0590 && c <= 0x05ff },
  { name: 'Russian', test: (c) => c >= 0x0400 && c <= 0x04ff }, // Cyrillic
  { name: 'Arabic', test: (c) => (c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) },
];

const isLatinLetter = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/**
 * Returns the language name to reinforce for this turn, or null when the
 * message is Latin-script / too short / has no detectable letters (in which
 * case the static prompt rule governs and we inject nothing).
 *
 * A message counts as a script when ≥30% of its letters fall in that script —
 * so a mostly-Hebrew message with a stray English word still resolves to
 * Hebrew, while an English message naming one Hebrew word does not.
 */
export function detectMessageLanguage(text: string | null | undefined): string | null {
  if (!text) return null;

  // Strip non-language noise so it doesn't skew the dominant-script read:
  // Slack markup (<@U…>, <http…|label>), bare URLs, :emoji:, digits.
  const cleaned = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/:[a-z0-9_+-]+:/gi, ' ')
    .replace(/[0-9]+/g, ' ');

  const counts: Record<string, number> = {};
  let latin = 0;
  let letters = 0;

  for (const ch of cleaned) {
    const c = ch.codePointAt(0);
    if (c === undefined) continue;
    const script = SCRIPTS.find((s) => s.test(c));
    if (script) {
      counts[script.name] = (counts[script.name] ?? 0) + 1;
      letters++;
    } else if (isLatinLetter(c)) {
      latin++;
      letters++;
    }
  }

  if (letters < 2) return null; // too little signal to judge

  // First non-Latin script to clear the 30% threshold wins (SCRIPTS order =
  // priority).
  for (const s of SCRIPTS) {
    if ((counts[s.name] ?? 0) / letters >= 0.3) return s.name;
  }
  // v3.3.x — Latin is now a winner too, returned as the sentinel 'Latin'.
  // WHY: the per-turn re-stamp used to fire only for non-Latin scripts, so a
  // person with a stored non-Latin pref (or a Hebrew-heavy thread) who SWITCHES
  // to English got nothing to counter the stale language → Maelle kept replying
  // Hebrew to English (Ayala, 2026-06-12). Returning 'Latin' lets the caller
  // emit a "mirror this Latin message, don't drift to a non-Latin language"
  // directive — symmetric override. We don't name English-vs-Spanish (script
  // can't tell, and naming it wrong would mislabel Spanish-writing colleagues);
  // script level is enough to kill the drift.
  if (latin / letters >= 0.5) return 'Latin';
  return null;
}
