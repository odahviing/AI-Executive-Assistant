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
  notes?: string;                // e.g. "kosher Italian at the gas station"
}

const anthropic = getAnthropicClient();

export async function searchVenueCandidates(params: {
  area?: string;
  type?: string;
  typeTags?: string[];
  partySize?: number;
  language?: 'en' | 'he';
  maxResults?: number;
}): Promise<VenueCandidate[]> {
  const max = Math.min(Math.max(params.maxResults ?? 3, 1), 5);
  const queryParts: string[] = [];
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
      "notes": "popular branch by the marina, opens 7am"
    }
  ]
}

Rules:
- If no candidates match, return { "candidates": [] }.
- Only include fields you found in the snippets — omit absent ones.
- "type" should be a single token from: coffee, restaurant, pub, park, bar, hotel, office, other.
- "type_tags" are refinements: kosher, italian, vegan, sushi, sports-bar, etc.
- "notes" is one short sentence of distinguishing colour — what makes this venue stand out vs the others.`;

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
 * Case-1: owner names a venue. Resolve to canonical address.
 * Wraps the existing resolveVenueLocation helper; adds the venue-skill output
 * shape so the find_venue tool surface stays uniform between cases.
 */
export async function resolveVenueByName(
  nameHint: string,
  areaHint?: string,
  language: 'en' | 'he' = 'en',
): Promise<VenueCandidate | null> {
  const resolved = await resolveVenueLocation(nameHint, language, {
    cityHint: areaHint,
    countryHint: 'Israel',
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
