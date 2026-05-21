/**
 * venueSearch (v2.9) — Tavily-backed discovery for the `venue` skill.
 *
 * Two modes:
 *   - searchByCriteria({ area, type, ... }) — Case-2 flow: owner says "find a
 *     kosher restaurant in Tel Aviv", we surface 3 candidates.
 *   - resolveByName(nameHint, areaHint?) — Case-1 flow: owner names a venue
 *     ("Coffee Landwer Ness Ziona"), we resolve to canonical name + address.
 *     Wraps the existing resolveVenueLocation helper.
 *
 * Sonnet parses Tavily search results into structured candidates. No cache —
 * venue lookups are rare relative to scheduling, and stale addresses are
 * worse than a fresh Tavily call.
 *
 * Future migration to Google Places API: tracked at #96. When swapped, this
 * file's exports stay the same shape; only the implementation changes.
 */

import { getAnthropicClient } from '../llm/client';
import { tavilySearch } from '../skills/general';
import { resolveVenueLocation } from './locationResolver';
import { resolveModelId } from '../llm/modelId';
import logger from './logger';

export interface VenueCandidate {
  name: string;
  branch_name?: string;
  address?: string;
  area_tags?: string[];          // ['Tel Aviv', 'Sarona']
  type?: string;                 // 'coffee' | 'restaurant' | 'pub' | etc.
  type_tags?: string[];          // ['kosher', 'italian']
  phone?: string;
  reservation_url?: string;
  /**
   * Opening hours per weekday when known. Each value is one or more
   * "HH:MM-HH:MM" ranges (overnight ranges allowed, e.g. "22:00-02:00"
   * means open from 22:00 until 02:00 the next day). Day names match
   * Luxon's `EEEE` format: Monday / Tuesday / ... / Sunday.
   * Absent days mean closed.
   */
  opening_hours_by_day?: Partial<Record<Weekday, string[]>>;
  notes?: string;                // e.g. "kosher Italian at the gas station"
}

export type Weekday = 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';

export type HoursStatus = 'open' | 'closed' | 'unknown';

/**
 * Deterministic "is this venue open at this time?" check. Returns:
 *   'open'    — meeting_time falls inside at least one of the day's ranges
 *   'closed'  — meeting_time is outside every range for that day (or the
 *               day has no ranges at all in the parsed hours)
 *   'unknown' — opening_hours_by_day not provided, or meeting_time invalid
 *
 * Handles overnight ranges: "22:00-02:00" on Friday means a meeting at
 * 23:30 Friday is OPEN; a meeting at 01:00 Saturday is also OPEN under the
 * Friday range. Caller asks once per (venue, slot) so overlapping evaluation
 * is implicit.
 */
export function evaluateVenueHours(params: {
  openingHoursByDay?: Partial<Record<Weekday, string[]>>;
  meetingTimeIso?: string;
  timezone: string;
}): HoursStatus {
  if (!params.openingHoursByDay || !params.meetingTimeIso) return 'unknown';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DateTime } = require('luxon') as typeof import('luxon');
  const dt = DateTime.fromISO(params.meetingTimeIso).setZone(params.timezone);
  if (!dt.isValid) return 'unknown';
  const minutes = dt.hour * 60 + dt.minute;
  const day = dt.toFormat('EEEE') as Weekday;
  const ranges = params.openingHoursByDay[day] ?? [];
  if (insideAnyRange(minutes, ranges)) return 'open';
  // Check the PREVIOUS day's overnight ranges — e.g. Friday 22:00-02:00
  // covers Saturday 01:00.
  const prevDay = dt.minus({ days: 1 }).toFormat('EEEE') as Weekday;
  const prevRanges = (params.openingHoursByDay[prevDay] ?? []).filter(isOvernight);
  if (insideAnyOvernightRange(minutes, prevRanges)) return 'open';
  // No ranges for today AND no overnight carryover → closed.
  return 'closed';
}

function parseHHMM(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < 0 || h > 24 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function insideAnyRange(minutes: number, ranges: string[]): boolean {
  for (const r of ranges) {
    const [a, b] = r.split('-').map(s => s.trim());
    const start = parseHHMM(a);
    const end = parseHHMM(b);
    if (start === null || end === null) continue;
    if (end > start) {
      if (minutes >= start && minutes < end) return true;
    } else {
      // Overnight (e.g. "22:00-02:00") — handled via previous-day carryover.
      // For today's range, only the 22:00→24:00 portion applies.
      if (minutes >= start) return true;
    }
  }
  return false;
}

function isOvernight(r: string): boolean {
  const [a, b] = r.split('-').map(s => s.trim());
  const start = parseHHMM(a);
  const end = parseHHMM(b);
  return start !== null && end !== null && end <= start;
}

function insideAnyOvernightRange(minutes: number, overnightRanges: string[]): boolean {
  // Caller passes only overnight ranges from the PREVIOUS day. The 00:00→end
  // portion applies to today's morning.
  for (const r of overnightRanges) {
    const [, b] = r.split('-').map(s => s.trim());
    const end = parseHHMM(b);
    if (end === null) continue;
    if (minutes < end) return true;
  }
  return false;
}

export async function searchVenueCandidates(params: {
  area?: string;
  type?: string;
  typeTags?: string[];
  partySize?: number;
  language?: 'en' | 'he';
  maxResults?: number;
  /**
   * Optional named-venue query. When set, dominates the search string so
   * Case-1 (owner names a specific venue) returns rich candidate data —
   * phone, reservation_url, hours — that the bare-name resolver path
   * couldn't surface. Case-2 callers (area+type discovery) leave this
   * unset.
   */
  nameQuery?: string;
}): Promise<VenueCandidate[]> {
  // Lazy client capture — re-reads getAnthropicClient() per call so a
  // runtime LLM_PROVIDER flip (Anthropic ↔ Vertex via env var) is picked up
  // without restart. Pre-fix the module-level `const anthropic = ...` froze
  // the boot-time client forever.
  const anthropic = getAnthropicClient();
  const max = Math.min(Math.max(params.maxResults ?? 3, 1), 5);
  const queryParts: string[] = [];
  if (params.nameQuery) queryParts.push(params.nameQuery);
  if (params.type) queryParts.push(params.type);
  if (params.typeTags && params.typeTags.length > 0) queryParts.push(...params.typeTags);
  if (params.area) queryParts.push(params.area);
  queryParts.push('address');
  queryParts.push('phone');
  const query = queryParts.join(' ');
  if (query.trim().length === 0) {
    logger.warn('searchVenueCandidates — empty query, returning no candidates');
    return [];
  }

  let searchResult: { answer?: string | null; results?: Array<{ title?: string; content?: string; url?: string }> };
  try {
    searchResult = await tavilySearch(query, 'advanced') as typeof searchResult;
  } catch (err) {
    logger.warn('searchVenueCandidates — Tavily search failed', {
      query, err: String(err).slice(0, 200),
    });
    return [];
  }

  const tavilySnippets = (searchResult.results ?? [])
    .slice(0, 10)
    .map((r, i) => `[${i + 1}] ${r.title ?? ''}\n${r.content ?? ''}\n${r.url ?? ''}`)
    .join('\n\n---\n\n');

  if (tavilySnippets.length === 0 && !searchResult.answer) {
    return [];
  }

  const sys = `You parse Tavily web-search results into structured venue candidates.

For the input search results, return up to ${max} candidates that match the criteria.

Criteria:
${params.area ? `- Area: ${params.area}` : ''}
${params.type ? `- Type: ${params.type}` : ''}
${params.typeTags && params.typeTags.length > 0 ? `- Tags: ${params.typeTags.join(', ')}` : ''}

Output ONLY valid JSON, no commentary:
{
  "candidates": [
    {
      "name": "Coffee Landwer",
      "branch_name": "Ness Ziona main",            // optional, for chains
      "address": "HaShayetet St 4, Ness Ziona",
      "area_tags": ["Ness Ziona", "Central Israel"],
      "type": "coffee",
      "type_tags": ["cafe", "casual"],
      "phone": "+972-...",
      "reservation_url": "https://...",            // if found
      "opening_hours_by_day": {                    // OPTIONAL — only when snippets show hours
        "Sunday":    ["07:00-23:00"],
        "Monday":    ["07:00-23:00"],
        "Tuesday":   ["07:00-23:00"],
        "Wednesday": ["07:00-23:00"],
        "Thursday":  ["07:00-23:00"],
        "Friday":    ["07:00-15:00"],
        "Saturday":  []                            // empty array = closed Saturday
      },
      "notes": "popular branch by the marina"
    }
  ]
}

Rules:
- If no candidates match, return { "candidates": [] }.
- Only include fields you found in the snippets — omit absent ones.
- "type" should be a single token from: coffee, restaurant, pub, park, bar, hotel, office, other.
- "type_tags" are refinements: kosher, italian, vegan, sushi, sports-bar, etc.
- "notes" is one short sentence of distinguishing colour — what makes this venue stand out vs the others. Do NOT mention hours in notes — hours go in opening_hours_by_day or are omitted.
- "opening_hours_by_day" is OPTIONAL. Only include it when the snippets clearly state per-day hours. Day names must be Monday/Tuesday/...; each value is an array of "HH:MM-HH:MM" ranges (24h). Overnight ranges like "22:00-02:00" are allowed. Missing day = unknown; empty array = closed that day. Never invent hours.`;

  const userMsg = `Search query: "${query}"
${searchResult.answer ? `Tavily summary: ${searchResult.answer}\n\n` : ''}Top results:\n\n${tavilySnippets}`;

  try {
    const response = await anthropic.messages.create({
      model: resolveModelId('claude-sonnet-4-6'),
      max_tokens: 1500,
      system: sys,
      messages: [{ role: 'user', content: userMsg }],
    });
    const txt = response.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    // Strip markdown code fences if Sonnet added them
    const cleaned = txt.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const candidates: VenueCandidate[] = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    return candidates.slice(0, max);
  } catch (err) {
    logger.warn('searchVenueCandidates — Sonnet parse failed, returning empty list', {
      err: String(err).slice(0, 200),
    });
    return [];
  }
}

/**
 * Map common timezones to a country name for venue-search country hints.
 * Falls back to undefined for TZs we don't recognize — search is performed
 * without a country filter rather than guessing.
 */
const TZ_TO_COUNTRY: Record<string, string> = {
  'Asia/Jerusalem': 'Israel',
};
function countryFromTimezone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  return TZ_TO_COUNTRY[tz];
}

/**
 * Case-1: owner names a venue. Resolve to a rich VenueCandidate.
 *
 * Pipeline:
 *  1. Tavily + Sonnet via searchVenueCandidates with nameQuery=nameHint.
 *     Returns a full VenueCandidate with phone / reservation_url / hours
 *     when the snippets carry them — matches the find_venue tool's
 *     promised return shape that the prior path was breaking.
 *  2. Fallback to the lighter locationResolver if step 1 returns nothing —
 *     guarantees at least name + address when Tavily had no hit but the
 *     resolver could disambiguate via cityHint/countryHint.
 */
export async function resolveVenueByName(
  nameHint: string,
  areaHint?: string,
  language: 'en' | 'he' = 'en',
  ownerTimezone?: string,
): Promise<VenueCandidate | null> {
  // Step 1 — focused search via Tavily+Sonnet for rich data.
  try {
    const candidates = await searchVenueCandidates({
      nameQuery: nameHint,
      area: areaHint,
      maxResults: 1,
      language,
    });
    if (candidates.length > 0) {
      const first = candidates[0];
      return {
        ...first,
        area_tags: first.area_tags && first.area_tags.length > 0
          ? first.area_tags
          : (areaHint ? [areaHint] : []),
      };
    }
  } catch (err) {
    logger.warn('resolveVenueByName — searchVenueCandidates threw, falling back to locationResolver', {
      err: String(err).slice(0, 200), nameHint,
    });
  }

  // Step 2 — fallback to the lighter resolver. Still returns name+address
  // when the heavier path turned up empty.
  const resolved = await resolveVenueLocation(nameHint, language, {
    cityHint: areaHint,
    countryHint: countryFromTimezone(ownerTimezone),
  });
  if (!resolved.resolved) {
    return null;
  }
  return {
    name: resolved.name,
    address: resolved.address,
    area_tags: areaHint ? [areaHint] : [],
  };
}
