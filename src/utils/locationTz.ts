/**
 * Location → IANA timezone derivation (v2.2.2, #46).
 *
 * Static map for common cases is the fast path (no API call). When the input
 * doesn't match anything in the map, fall back to a one-shot Sonnet lookup —
 * that catches the long tail (small cities, unusual phrasings) without a giant
 * static table.
 *
 * One-way only: state → timezone. The reverse isn't useful (knowing ET doesn't
 * tell us Boston vs NYC vs Atlanta).
 */

import { getAnthropicClient } from '../llm/client';
import { SONNET } from '../llm/models';
import { config } from '../config';
import logger from './logger';

const STATIC_MAP: Record<string, string> = {
  // Israel
  'israel':         'Asia/Jerusalem',
  'tel aviv':       'Asia/Jerusalem',
  'tel-aviv':       'Asia/Jerusalem',
  'tlv':            'Asia/Jerusalem',
  'jerusalem':      'Asia/Jerusalem',
  'haifa':          'Asia/Jerusalem',
  'herzliya':       'Asia/Jerusalem',
  'nes ziona':      'Asia/Jerusalem',
  // US Eastern
  'new york':       'America/New_York',
  'nyc':            'America/New_York',
  'boston':         'America/New_York',
  'atlanta':        'America/New_York',
  'miami':          'America/New_York',
  'eastern us':     'America/New_York',
  'us eastern':     'America/New_York',
  'et':             'America/New_York',
  // v4.3.0 (#24 row 129) — standard/daylight abbreviation pairs. A
  // correspondent writes whichever is currently in effect ("EST" in winter,
  // "EDT" in summer) and rarely knows which; both mean "that same US zone"
  // for our purposes (email extraction never needs DST precision, only the
  // IANA zone so luxon's own DST math takes over from there).
  'est':            'America/New_York',
  'edt':            'America/New_York',
  // US Central
  'chicago':        'America/Chicago',
  'austin':         'America/Chicago',
  'dallas':         'America/Chicago',
  'central us':     'America/Chicago',
  'ct':             'America/Chicago',
  // Deliberately NO 'cst'/'cdt' entry (added 2026-07-28, removed 2026-07-29
  // overturn): unlike EST/PST, "CST" is genuinely ambiguous — China Standard
  // Time (14h off America/Chicago) or Cuba Standard Time — and a bare
  // abbreviation gives this map nothing to disambiguate on. An unresolved
  // token falls through to the caller's existing no-signal fallback (the
  // owner's zone in attendeeAvailability.ts / inbound.ts), which is correct
  // for this case. Do not re-add without an actual disambiguation signal
  // (sender domain, explicit country, etc) — that would be a different,
  // bigger fix, not a map entry.
  // US Mountain
  'denver':         'America/Denver',
  'salt lake city': 'America/Denver',
  'mountain us':    'America/Denver',
  // Deliberately NO 'mst'/'mdt' entry — same reasoning as CST above; "MST"
  // collides with Myanmar Standard Time.
  // US Pacific
  'san francisco':  'America/Los_Angeles',
  'sf':             'America/Los_Angeles',
  'los angeles':    'America/Los_Angeles',
  'la':             'America/Los_Angeles',
  'seattle':        'America/Los_Angeles',
  'pacific':        'America/Los_Angeles',
  'pt':             'America/Los_Angeles',
  'pst':            'America/Los_Angeles',
  'pdt':            'America/Los_Angeles',
  // EU
  'london':         'Europe/London',
  'uk':             'Europe/London',
  'gmt':            'Europe/London',
  'paris':          'Europe/Paris',
  'berlin':         'Europe/Berlin',
  'amsterdam':      'Europe/Amsterdam',
  'madrid':         'Europe/Madrid',
  'rome':           'Europe/Rome',
  'cet':            'Europe/Berlin',
  // Asia
  'tokyo':          'Asia/Tokyo',
  'singapore':      'Asia/Singapore',
  'hong kong':      'Asia/Hong_Kong',
  'shanghai':       'Asia/Shanghai',
  'beijing':        'Asia/Shanghai',
  'mumbai':         'Asia/Kolkata',
  'bangalore':      'Asia/Kolkata',
  'india':          'Asia/Kolkata',
  // AU
  'sydney':         'Australia/Sydney',
  'melbourne':      'Australia/Melbourne',
};

/** Static-only lookup. Returns null on miss. Sync, no API. */
export function inferTimezoneFromStateStatic(state: string): string | null {
  if (!state) return null;
  const key = state.trim().toLowerCase();
  return STATIC_MAP[key] ?? null;
}

/**
 * Static map first, Sonnet fallback for the long tail. Returns null when even
 * Sonnet can't place the location. Use this when you have a free-text location
 * string and want an IANA zone you can store / pass to date math.
 */
export async function inferTimezoneFromState(state: string): Promise<string | null> {
  const fast = inferTimezoneFromStateStatic(state);
  if (fast) return fast;

  if (!config.ANTHROPIC_API_KEY) return null;

  try {
    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `Map this location to an IANA timezone. Reply with ONLY the IANA name (e.g. "America/New_York", "Europe/London", "Asia/Jerusalem") or "unknown" if you can't place it confidently.

Location: "${state}"`,
      }],
    });
    const raw = ((resp.content[0] as any)?.text ?? '').trim();
    if (!raw || raw.toLowerCase() === 'unknown') return null;
    // Sanity check: looks like an IANA name (Region/City)
    if (!/^[A-Z][A-Za-z_]+\/[A-Z][A-Za-z_]+/.test(raw)) {
      logger.debug('locationTz: Sonnet returned non-IANA shape', { state, raw });
      return null;
    }
    return raw;
  } catch (err) {
    logger.debug('locationTz: Sonnet lookup threw', { state, err: String(err).slice(0, 200) });
    return null;
  }
}
