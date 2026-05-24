/**
 * Strict IANA timezone validation (v3.0.2).
 *
 * Why this exists: luxon's `IANAZone.isValidZone` accepts ambiguous
 * abbreviations like `"IST"` (resolves to Asia/Kolkata — Indian Standard Time),
 * `"CST"` (Asia/Shanghai — China), `"PST"` etc. These are wrong roughly
 * always for our use — `"IST"` written by Sonnet for an Israel-based contact
 * silently produces a +5:30 offset and surfaces as "his 15:15 IST" in
 * cross-TZ slot rendering.
 *
 * Real IANA zones either contain a slash (`Asia/Jerusalem`, `America/New_York`)
 * or are exactly `UTC` / `GMT`. Anything else is rejected as ambiguous.
 *
 * Wire this into every write path that takes a TZ string from an LLM
 * (update_person_profile, working_hours_structured.timezone, state→tz
 * derivation Sonnet fallback). Slack profile pulls and Graph mailbox info
 * supply proper IANA already and pass through fine.
 */
import { IANAZone } from 'luxon';

/** True iff `tz` is a non-ambiguous IANA zone. */
export function isStrictIana(tz: string | undefined | null): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  const trimmed = tz.trim();
  if (!trimmed) return false;
  if (!IANAZone.isValidZone(trimmed)) return false;
  if (trimmed === 'UTC' || trimmed === 'GMT') return true;
  return trimmed.includes('/');
}

/**
 * Throws-style validator for callers that want an explicit error message.
 * Returns the trimmed valid TZ on success, throws on rejection.
 */
export function assertStrictIana(tz: string, label = 'timezone'): string {
  const trimmed = tz.trim();
  if (!isStrictIana(trimmed)) {
    throw new Error(
      `'${tz}' is not a valid IANA ${label}. Use a Region/City form like 'Asia/Jerusalem', 'America/New_York', 'Europe/London' — never abbreviations like 'IST', 'PST', 'CST' (those are ambiguous).`,
    );
  }
  return trimmed;
}
