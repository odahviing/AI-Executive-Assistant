import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext, ChannelId } from './types';
import type { UserProfile } from '../config/userProfile';
import { config } from '../config';
import { getAnthropicClient } from '../llm/client';
import { MODEL_HAIKU } from '../llm/models';
import logger from '../utils/logger';
import { extractFirstJsonObject } from '../utils/extractJson';

const RESEARCH_PLAN_MODEL = MODEL_HAIKU;

// ── External web-search response shapes ──────────────────────────────────────
// Minimal-surface interfaces — only the fields we actually read. Provider
// shapes are owned by the vendor; a shape change at one provider degrades to
// undefined fields rather than runtime crashes.
interface TavilySearchResult {
  title?: string;
  content?: string;
  url?: string;
  published_date?: string;
}
interface TavilySearchResponse {
  answer?: string | null;
  results?: TavilySearchResult[];
}
interface BraveSearchResult {
  title?: string;
  description?: string;
  url?: string;
  age?: string;
}
interface BraveSearchResponse {
  summary?: { answer?: string | null };
  web?: { results?: BraveSearchResult[] };
}
interface DuckDuckGoTopic {
  Text?: string;
}
interface DuckDuckGoResponse {
  AbstractText?: string;
  Answer?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  RelatedTopics?: DuckDuckGoTopic[];
}
interface TavilyExtractPage {
  url?: string;
  raw_content?: string;
  text?: string;
  images?: string[];
}
interface TavilyExtractResponse {
  results?: TavilyExtractPage[];
}

/**
 * Search skill (v3.1.7 — rebuilt as the one home for all outbound research).
 *
 * Three tools, two altitudes:
 *   - web_search / web_extract — primitives for a quick one-off fact or to read
 *     a specific URL.
 *   - research — the GROUNDED loop for current-events + content creation
 *     (LinkedIn posts, articles, summaries, suggestions). It plans focused
 *     searches, fetches + reads REAL sources, and returns them so whatever the
 *     model writes is grounded and citable. This replaces the old blind
 *     researchPreCheck that searched the task text and let content be written
 *     from training memory with no source.
 *
 * Framework: PLAN (turn the goal into focused queries) → GATHER (search,
 * recency-bounded) → READ (extract the top sources) → return {sources,
 * readings} → the model SYNTHESIZES + CITES from what came back. Sources travel
 * with the answer, so "what's your link?" is always answerable.
 */
export class SearchSkill implements Skill {
  id = 'search' as const;
  name = 'Search';
  description = 'Web lookups + grounded research — quick facts, plus sourced research for current events and content (articles, summaries, suggestions).';

  getTools(_profile: UserProfile): Anthropic.Tool[] {
    return [
      {
        name: 'web_search',
        description: `Search the web for real-time or current information.
Use this for:
- Today's weather in any city
- Current exchange rates or stock prices
- Recent news or current events
- Whether today/tomorrow is a public holiday somewhere
- Background on a company, person, or topic
- Any fact that may have changed recently

For questions you can answer from your own knowledge (history, general concepts), answer directly — no search needed.
Keep queries specific and targeted.

FRESHNESS: when the question is about recent news / latest updates / "what happened this week" / "something from the last N days", ALWAYS set time_range_days. Without it, search engines rank by relevance and often return popular-but-old articles. Rules of thumb:
- "This week" / "last few days" → time_range_days: 7
- "Recent" / "latest" / "last couple weeks" → time_range_days: 14
- "This month" / "recently" → time_range_days: 30
- "News" / "what's going on with X" → time_range_days: 14 default unless obviously older
Only omit time_range_days for evergreen questions (company background, general concepts, historical facts).`,
        input_schema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'The search query. Be specific. e.g. "weather Tel Aviv today", "USD ILS exchange rate", "[company] industry news"',
            },
            time_range_days: {
              type: 'number',
              description: 'Optional. Only return results from the last N days. Use for news / recent queries to avoid stale popular articles. Omit for evergreen topics.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'web_extract',
        description: `Extract content from a specific URL / web page.
Use this when you need to READ the actual content of a page — articles, blog posts, LinkedIn profiles, company pages, product pages, etc.
Unlike web_search (which searches the web), this tool fetches and extracts the text from a given URL.

Use this for:
- Reading an article or blog post the user shared
- Extracting content from a company website or LinkedIn page
- Getting the text from any URL the user provides
- Researching a specific page's content

Note: Some pages may block extraction (login-required, bot-protected — LinkedIn especially). If extraction fails you got NO content from that page: fall back to web_search about the topic, and NEVER describe or propose anything as if you'd read it — don't invent a title, date, or detail you didn't actually extract.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            url: {
              type: 'string',
              description: 'The full URL to extract content from. e.g. "https://www.linkedin.com/company/acme-corp"',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'web_research',
        description: `Grounded, sourced web research. Use this — NOT web_search — whenever you'll WRITE or PROPOSE something based on current events, or the owner asks you to research / look into / explore a topic to produce content (a LinkedIn post, article, summary, suggestion, briefing).

What it does in one call: plans focused searches from your goal, fetches REAL sources, reads the top articles, and returns the sources + their content.

Then YOU: write GROUNDED in what it returns and CITE the source URLs (include the link in your output). NEVER state a current-events fact — a statistic, "this week", a named incident/campaign, a company event — that isn't in the returned sources. If research comes back empty, tell the owner you couldn't find a source instead of writing it from memory. The whole point is that every claim has a link behind it.

For a quick one-off fact (weather, exchange rate, is today a holiday), use web_search instead — web_research is for when sourcing + grounding matter.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            goal: {
              type: 'string',
              description: 'What you actually need to find out, in plain terms — e.g. "this week\'s notable web supply-chain / third-party-script security incidents" or "recent funding + product news for Acme Corp". Describe the TOPIC, not your task ("write a post about…").',
            },
            recency_days: {
              type: 'number',
              description: 'Optional. For current-events goals, restrict to the last N days (7 = this week, 14 = recent, 30 = this month). Omit for evergreen topics.',
            },
          },
          required: ['goal'],
        },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<unknown | null> {
    if (toolName === 'web_research') {
      const goal = (args.goal as string | undefined)?.trim();
      if (!goal) return { error: 'empty_goal' };
      const recency = typeof args.recency_days === 'number' ? args.recency_days : undefined;
      return await runResearch(goal, recency);
    }

    if (toolName === 'web_extract') {
      const url = args.url as string;
      logger.info('Web extract', { url });
      try {
        return await tavilyExtract(url);
      } catch (err) {
        logger.warn('Web extract failed', { url, err: String(err) });
        return { error: `Could not extract content from ${url}. The page may require login or block bots. Try web_search about the topic instead.` };
      }
    }

    if (toolName !== 'web_search') return null;

    const query = args.query as string;
    const timeRangeDays = typeof args.time_range_days === 'number' ? args.time_range_days : undefined;
    logger.info('Web search', { query, timeRangeDays });

    try {
      if (config.TAVILY_API_KEY) {
        const result = await tavilySearch(query, 'advanced', timeRangeDays);
        const hasContent = (result as any).answer || ((result as any).results?.length ?? 0) > 0;
        if (hasContent) return result;
        logger.info('Tavily returned empty — falling back to DuckDuckGo', { query });
        return await duckduckgoSearch(query);
      } else if (config.BRAVE_SEARCH_API_KEY) {
        return await braveSearch(query);
      } else {
        return await duckduckgoSearch(query);
      }
    } catch (err) {
      logger.warn('Web search failed', { query, err: String(err) });
      return { error: 'Search unavailable right now. Answer from your knowledge if possible.' };
    }
  }

  getSystemPromptSection(profile: UserProfile, scopes?: string[], isOwner?: boolean, channel?: ChannelId): string {
    const units = profile.user.units !== 'imperial'
      ? 'Always use metric units (°C, km, kg, etc.) — never Fahrenheit or imperial.'
      : 'Always use imperial units (°F, miles, lbs, etc.) — never Celsius or metric.';
    // #20 class — never teach a tool this request doesn't ship. `web_research`
    // is 'knowledge'-scope only (registry.ts:194) and is NOT colleague-allowed,
    // so on a colleague turn (the dispatch chokepoint refuses it outright)
    // and on any out-of-scope owner turn this paragraph was ~375 tokens
    // teaching a capability the request omits. Derived from the tools
    // actually shipped for this role + scope + CHANNEL — same source of truth
    // the chokepoint uses — so it can't drift when the scope map, the
    // allowlist, or a channel clamp moves. gh#24 row 121: this call used to
    // omit `channel` (silently defaulting to 'slack', unclamped), so on a
    // clamped channel (email) it could still teach web_research even though
    // the real shipped tools for that turn never include it — the twin at
    // systemPrompt.ts's shippedToolNames threads channel correctly; this one
    // now matches it. `web_search` is ALWAYS_ON, so the section itself always
    // stands.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSkillTools } = require('./registry') as typeof import('./registry');
    const shipsResearch = getSkillTools(profile, isOwner === false ? 'colleague' : 'owner', scopes, channel)
      .some(t => t.name === 'web_research');
    const researchLine = shipsResearch
      ? `\n- web_research(goal) — use this whenever you'll WRITE or PROPOSE from current events (a LinkedIn post, article, summary, suggestion, briefing) or the owner asks you to research / look into / explore a topic. It returns real SOURCES + their content. Write GROUNDED in what it returns and CITE the links in your output. NEVER state a current-events fact — a stat, "this week", a named incident/campaign — that isn't in the returned sources; if it finds nothing, say you couldn't find a source rather than writing from memory. When you PROPOSE angles / post ideas, each must be SELF-CONTAINED — the specific item, its concrete details (what it is, when, why it's relevant now), and the source link — so the owner can say "draft that" without asking "which one?". If you can't substantiate an angle (source blocked or empty, no real details), DROP it — never float a bare reference like "post about the webinar". One fewer idea beats one he can't act on. Combine with the knowledge base for our voice/positioning when drafting.`
      : '';
    return `
SEARCH & RESEARCH
- web_search — a quick one-off fact (weather, exchange rate, is today a holiday, a single current detail). Answer stable knowledge (history, geography, concepts) directly, no search.${researchLine}

${units}

ANSWER ONLY WHAT WAS ASKED. One focused answer, then stop.
Keep answers short and conversational — this is office chat, not a report.
Never use bullet points or headers for simple factual answers.
`.trim();
  }
}

// ── Grounded research loop (v3.1.7) ─────────────────────────────────────────
//
// PLAN → GATHER → READ → return {sources, readings}. One call returns real,
// citable material so whatever the model writes next is grounded. Self-
// contained; fails soft (a step that throws degrades, never crashes the turn).

interface ResearchSource { title?: string; url: string; snippet?: string; published?: string }

/** PLAN — turn a fuzzy goal into 2–4 focused, searchable queries (+ recency).
 *  Haiku; falls back to the raw goal on any failure so research still runs. */
async function planResearchQueries(goal: string): Promise<{ queries: string[]; recencyDays?: number }> {
  const prompt = `You plan web searches for an executive assistant's research tool.

GOAL: "${goal}"

Output STRICT JSON only: {"queries": ["...","..."], "recency_days": <number or null>}
- 2-4 focused, specific search queries that will surface REAL primary sources (news articles, reports). Extract the actual searchable TOPIC — do NOT echo task framing like "write a post about" or "2-3 angles".
- recency_days: if the goal is about recent/current events ("this week", "latest", breaking, news), set 7-30; otherwise null (evergreen).`;
  try {
    const res = await getAnthropicClient().messages.create({
      model: RESEARCH_PLAN_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = ((res.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const m = extractFirstJsonObject(text);
    if (m) {
      const parsed = JSON.parse(m) as { queries?: unknown; recency_days?: unknown };
      const queries = Array.isArray(parsed.queries)
        ? parsed.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, 4)
        : [];
      const recencyDays = typeof parsed.recency_days === 'number' ? parsed.recency_days : undefined;
      if (queries.length > 0) return { queries, recencyDays };
    }
  } catch (err) {
    logger.warn('research — query planning failed, using raw goal', { err: String(err).slice(0, 160) });
  }
  return { queries: [goal] };
}

/** The grounded research bundle the model writes from. */
export async function runResearch(goal: string, recencyOverride?: number, opts?: DomainFilterOpts): Promise<object> {
  logger.info('research — start', { goal: goal.slice(0, 120), recencyOverride });
  const plan = await planResearchQueries(goal);
  const recency = recencyOverride ?? plan.recencyDays;

  // GATHER — search each planned query, dedupe sources by URL.
  const sources: ResearchSource[] = [];
  const seen = new Set<string>();
  for (const q of plan.queries) {
    try {
      const r = await tavilySearch(q, 'advanced', recency, opts) as {
        results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
      };
      for (const item of r.results ?? []) {
        const url = item.url;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        sources.push({
          title: item.title,
          url,
          snippet: (item.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
          published: item.published_date,
        });
      }
    } catch (err) {
      logger.warn('research — a search query failed, continuing', { q, err: String(err).slice(0, 120) });
    }
  }

  // READ — pull the full text of the top sources so facts come from the
  // article, not a snippet (and definitely not memory). `sources` below is
  // derived from `readings`, not this candidate list — a source whose
  // extraction failed is dropped from both, so the model can never cite one
  // it never actually read (gh#192).
  const READ_LIMIT = 3;
  const readings: Array<{ url: string; title?: string; content: string }> = [];
  for (const s of sources.slice(0, READ_LIMIT)) {
    try {
      const ext = await tavilyExtract(s.url) as { content?: string };
      if (ext.content && ext.content.trim().length > 0) {
        readings.push({ url: s.url, title: s.title, content: ext.content.slice(0, 4000) });
      }
    } catch { /* page blocked extraction — dropped, not carried by a snippet */ }
  }

  // The sources shown/cited to the model must match what was actually read —
  // pull metadata (snippet, published date) back from the candidate list for
  // each URL that made it into `readings`, preserving readings' order.
  const readSources = readings
    .map(r => sources.find(s => s.url === r.url))
    .filter((s): s is ResearchSource => s !== undefined);

  logger.info('research — done', { goal: goal.slice(0, 80), queries: plan.queries.length, sources: readSources.length, readings: readings.length });

  return {
    goal,
    queries_used: plan.queries,
    recency_days: recency ?? null,
    sources: readSources,
    readings,
    note: readSources.length === 0
      ? 'NO web sources found. Do NOT fabricate facts — tell the owner you could not find a source and offer to try again.'
      : 'Write GROUNDED in these sources and CITE the URLs in your output. Do not assert any current-events fact not present here.',
  };
}

// ── Search implementations ────────────────────────────────────────────────────

/** Optional domain steer for grounded research (news skill). Backward-compatible:
 *  omit and the request body is byte-identical to the pre-existing behavior. */
export interface DomainFilterOpts { includeDomains?: string[]; excludeDomains?: string[]; maxResults?: number }

export async function tavilySearch(
  query: string,
  depth: 'basic' | 'advanced' = 'advanced',
  timeRangeDays?: number,
  opts?: DomainFilterOpts,
): Promise<object> {
  // v1.8.8 — when caller passes timeRangeDays, use Tavily's news topic + days
  // filter so recency is enforced. Otherwise general-topic search (no date
  // constraint) for evergreen lookups.
  const body: Record<string, unknown> = {
    api_key: config.TAVILY_API_KEY,
    query,
    search_depth: depth,
    // v3.3.x — news passes a wider maxResults (it shows up to 7/day over a
    // multi-day window, deduped, so it needs a deep candidate pool). Other
    // callers (web_search/web_research) omit opts → unchanged at 8.
    max_results: Math.min(Math.max(opts?.maxResults ?? 8, 1), 20),
    include_answer: true,
  };
  if (typeof timeRangeDays === 'number' && timeRangeDays > 0) {
    body.topic = 'news';
    body.days = Math.min(Math.max(Math.round(timeRangeDays), 1), 365);
  }
  // v3.2.6 — source steer (news skill). Only added when present, so the
  // web_research / web_search paths (no opts) send the same body as before.
  if (opts?.includeDomains && opts.includeDomains.length > 0) {
    body.include_domains = opts.includeDomains;
  }
  if (opts?.excludeDomains && opts.excludeDomains.length > 0) {
    body.exclude_domains = opts.excludeDomains;
  }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    // v3.3.1 (M-6) — transient provider errors (rate-limit / 5xx) are WARN, not
    // ERROR. News fires one search per goal in parallel; on a Tavily outage every
    // goal would log a full error → N error lines per brief. Downgrade the
    // transient class so an outage is one warn-per-goal, not an error storm. A
    // genuine 4xx (bad key / malformed request) stays ERROR. Throw is unchanged —
    // callers (runResearch / news searchGoal) still fail open.
    const transient = res.status === 429 || res.status >= 500;
    logger[transient ? 'warn' : 'error']('Tavily API error', { status: res.status, body: errBody.slice(0, 300) });
    throw new Error(`Tavily HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as TavilySearchResponse;
  logger.info('Tavily result', { query, answer: !!data.answer, count: data.results?.length ?? 0 });

  return {
    answer: data.answer ?? null,
    // Return up to the requested cap (news asks for ~15); default 6 keeps the
    // web_search/web_research payloads small as before.
    results: (data.results ?? []).slice(0, opts?.maxResults ?? 6).map(r => ({
      title: r.title,
      content: r.content,
      url: r.url,
      published_date: r.published_date,
    })),
    query,
  };
}

export async function braveSearch(query: string): Promise<object> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&summary=1`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': config.BRAVE_SEARCH_API_KEY,
    },
  });

  if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);

  const data = await res.json() as BraveSearchResponse;
  const results = (data.web?.results ?? []).slice(0, 6).map(r => ({
    title: r.title,
    description: r.description,
    url: r.url,
    age: r.age,
  }));

  return { summary: data.summary?.answer ?? null, results, query };
}

export async function duckduckgoSearch(query: string): Promise<object> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Maelle-Assistant/1.0' } });

  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);

  const data = await res.json() as DuckDuckGoResponse;

  return {
    abstract: data.AbstractText || null,
    answer: data.Answer || null,
    source: data.AbstractSource || null,
    url: data.AbstractURL || null,
    related: (data.RelatedTopics ?? []).slice(0, 3).map(t => t.Text).filter(Boolean),
    note: 'Using DuckDuckGo instant answers (limited). Add TAVILY_API_KEY to .env for full web search.',
  };
}

// ── URL content extraction ───────────────────────────────────────────────────

export async function tavilyExtract(url: string): Promise<object> {
  if (!config.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY required for web_extract');
  }

  // extract_depth: advanced handles JS-heavy SPAs and content behind client-side
  // rendering (common on JS-heavy marketing sites). basic mode returned empty
  // content for those pages during KB recovery (2026-04-20).
  const res = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.TAVILY_API_KEY,
      urls: [url],
      extract_depth: 'advanced',
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    logger.error('Tavily extract error', { status: res.status, body: errBody.slice(0, 300) });
    throw new Error(`Tavily extract HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as TavilyExtractResponse;
  const results = data.results ?? [];

  if (results.length === 0) {
    return { error: 'No content could be extracted from this URL.', url };
  }

  const page = results[0];
  // Truncate very long pages to avoid blowing up context
  const rawText: string = page.raw_content ?? page.text ?? '';
  const content = rawText.length > 8000 ? rawText.slice(0, 8000) + '\n\n[Content truncated — page was very long]' : rawText;

  return {
    url: page.url ?? url,
    content,
    images: (page.images ?? []).slice(0, 5),
  };
}
