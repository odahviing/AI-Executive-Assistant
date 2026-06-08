/**
 * Robust extraction of the FIRST balanced JSON object from LLM text output.
 *
 * Replaces the fragile `text.match(/\{[\s\S]*\}/)` pattern that was copy-pasted
 * across ~12 LLM-output parsers (humanGate, securityGate, claimChecker,
 * dateVerifier, capturePass, …). That greedy regex grabs from the first `{`
 * to the LAST `}`, so the moment the model appends a second object or trailing
 * prose, the captured substring is invalid and `JSON.parse` throws with
 * "Unexpected non-whitespace character after JSON at position N" — silently
 * disabling the gate (most fail open). Observed repeatedly (humanGate +
 * dateVerifier, 2026-06-07).
 *
 * This walks the string and returns the first COMPLETE top-level `{…}` object,
 * brace-balanced and string-aware (braces inside string literals don't count).
 * Trailing content after that object is ignored. Returns null if there's no
 * balanced object.
 *
 * Strips a leading ```json / ``` fence first (common wrapper).
 */
export function extractFirstJsonObject(text: string): string | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Convenience: extract + parse the first balanced object. Returns the parsed
 * value, or null on no-object / parse failure (caller decides the fail-open
 * behavior — usually return [] / null / a safe default).
 */
export function parseFirstJsonObject<T = unknown>(text: string): T | null {
  const obj = extractFirstJsonObject(text);
  if (obj === null) return null;
  try {
    return JSON.parse(obj) as T;
  } catch {
    return null;
  }
}
