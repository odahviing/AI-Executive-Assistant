/**
 * Resolve a venue mentioned in conversation to its official name + street
 * address in the target language. Used when an external invite goes out in
 * a different language than the source-of-mention venue (e.g. owner asks
 * "invite in English" but the venue was named in Hebrew).
 *
 * Calls the existing Tavily search infra. No cache by design — venue lookups
 * are rare relative to scheduling traffic, and the cost of a fresh Tavily
 * call (~1s, ~$0.001) is below the cost of a stale cached address.
 *
 * Returns `resolved: false` when the search yields no clear venue match.
 * Caller should ask the owner for the address rather than passing the
 * source-language string through.
 */

import { getAnthropicClient } from '../llm/client';
import { SONNET } from '../llm/models';
import { config } from '../config';
import { tavilySearch, TAVILY_SEARCH_LIVE_TURN_TIMEOUT_MS } from '../skills/general';
import logger from './logger';
import { extractFirstJsonObject } from './extractJson';

export interface ResolvedVenue {
  resolved: boolean;
  name: string;       // 'Cafe Landwer'
  address: string;    // '17 HaMarpe St, Nes Tziona'
  fullDisplay: string; // 'Cafe Landwer, 17 HaMarpe St, Nes Tziona' — pass to custom_location
}

interface ResolveOptions {
  cityHint?: string;       // 'Nes Tziona' — improves search precision
  countryHint?: string;    // 'Israel'
}

export async function resolveVenueLocation(
  input: string,
  targetLanguage: 'en' | 'he',
  opts: ResolveOptions = {},
): Promise<ResolvedVenue> {
  // Lazy per-call client — honors runtime LLM_PROVIDER flips. Pre-fix the
  // module captured the client at boot, so a provider switch (Anthropic →
  // Vertex) split-brained venue resolution: the venueSearch hot path picked
  // up the new provider while THIS fallback still used the boot-time one.
  const anthropic = getAnthropicClient();
  const fallback: ResolvedVenue = {
    resolved: false,
    name: input,
    address: '',
    fullDisplay: input,
  };
  if (!input || input.trim().length === 0) return fallback;

  const queryParts = [input];
  if (opts.cityHint) queryParts.push(opts.cityHint);
  if (opts.countryHint) queryParts.push(opts.countryHint);
  queryParts.push('address');
  const query = queryParts.join(' ');

  let searchResult: { answer?: string | null; results?: Array<{ title?: string; content?: string; url?: string }> };
  try {
    // Live turn (invite-translation path off createMeeting) — same bound as
    // any other synchronous tool_use dispatch (tavilysearch-also-unbounded
    // follow-up), not tavilySearch's generous non-live default.
    searchResult = await tavilySearch(query, 'advanced', undefined, undefined, TAVILY_SEARCH_LIVE_TURN_TIMEOUT_MS) as typeof searchResult;
  } catch (err) {
    logger.warn('resolveVenueLocation — Tavily search failed', {
      input, err: String(err).slice(0, 200),
    });
    return fallback;
  }

  const corpus = [
    searchResult.answer ?? '',
    ...(searchResult.results ?? []).slice(0, 4).map(r => `${r.title ?? ''} — ${r.content ?? ''}`),
  ].filter(Boolean).join('\n\n').slice(0, 4000);

  if (!corpus) return fallback;

  // Sonnet pass to extract structured venue data in target language.
  try {
    const prompt = `You are extracting a venue's official name and full street address from web search results.

Input the user mentioned: "${input}"
${opts.cityHint ? `City hint: ${opts.cityHint}` : ''}
${opts.countryHint ? `Country hint: ${opts.countryHint}` : ''}
Target language for output: ${targetLanguage === 'en' ? 'English' : 'Hebrew'}

Web search corpus:
"""
${corpus}
"""

Output STRICT JSON only — no prose, no markdown:
{
  "resolved": true | false,
  "name": "official venue name in target language, or empty string",
  "address": "street + city, in target language, or empty string"
}

Rules:
- "resolved" = true ONLY if the corpus clearly identifies one specific venue with a street address.
- If multiple venues match (e.g. a chain with several branches) and the city hint can't disambiguate, return resolved=false.
- If no street address is in the corpus, return resolved=false (don't guess).
- "name" must be in the target language. If the search results are in another language, transliterate or use the official English/Hebrew name.
- "address" must be in the target language. Include street name + number + city. No country, no zip.
- No quotation marks inside the values.`;

    const resp = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 256,
      system: prompt,
      messages: [{ role: 'user', content: 'Extract.' }],
    });

    const text = (resp.content[0] && resp.content[0].type === 'text') ? resp.content[0].text : '';
    const jsonMatch = extractFirstJsonObject(text);
    if (!jsonMatch) {
      logger.warn('resolveVenueLocation — Sonnet returned non-JSON', { input, preview: text.slice(0, 200) });
      return fallback;
    }
    const parsed = JSON.parse(jsonMatch) as { resolved?: boolean; name?: string; address?: string };
    if (!parsed.resolved || !parsed.name || !parsed.address) {
      return fallback;
    }
    const fullDisplay = `${parsed.name}, ${parsed.address}`;
    logger.info('resolveVenueLocation — resolved', { input, name: parsed.name, address: parsed.address });
    return {
      resolved: true,
      name: parsed.name,
      address: parsed.address,
      fullDisplay,
    };
  } catch (err) {
    logger.warn('resolveVenueLocation — Sonnet extraction threw', {
      input, err: String(err).slice(0, 200),
    });
    return fallback;
  }
}
