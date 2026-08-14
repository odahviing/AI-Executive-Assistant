import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext, ChannelId } from './types';
import type { UserProfile } from '../config/userProfile';
import { config } from '../config';
import { getAnthropicClient } from '../llm/client';
import { MODEL_HAIKU } from '../llm/models';
import logger from '../utils/logger';
import { extractFirstJsonObject } from '../utils/extractJson';

const RESEARCH_PLAN_MODEL = MODEL_HAIKU;

// gh#191 piece 3 — tavilyExtract had NO timeout; a hung page's fetch could
// block indefinitely. Per-call-site budgets, deliberately DIFFERENT: the
// research READ loop runs inline in a live turn (someone's waiting) so it
// gets a TIGHT budget; web_extract and KB-ingest are not time-critical
// (nobody's waiting synchronously) so they keep this GENEROUS default —
// they never pass a second argument, so they get it automatically.
const TAVILY_EXTRACT_DEFAULT_TIMEOUT_MS = 45_000;
const TAVILY_EXTRACT_RESEARCH_TIMEOUT_MS = 8_000;

// gh#191-3 follow-up (tavilysearch-also-unbounded) — tavilySearch had the same
// gap tavilyExtract had before gh#191 piece 3: no fetch timeout, on the same
// live research path, ONE STEP AHEAD of extract in the call chain (GATHER
// runs before READ).
//
// The split is by whether a live turn is BLOCKED on this exact call, not by
// which function happens to invoke it — every caller below except news is a
// synchronous tool_use dispatch (registry.ts's executeSkillTool has no outer
// timeout of its own), so "someone's waiting" applies to all of them:
//   - research GATHER (this file) and READ (tavilyExtract) — live turn.
//   - web_search tool (below) — live turn, same as GATHER/READ; a first pass
//     of this fix grouped it with news as "generous default" because it
//     doesn't sit inside runResearch, but it is dispatched the exact same
//     way and blocks the exact same reply.
//   - venue candidate search / venue name resolution (venueSearch.ts) and
//     venue-address location resolution (locationResolver.ts, used from the
//     booking flow) — also live turn; same correction.
//   - news gather (news.ts's searchGoal) is the one caller that is NOT
//     bounded by this default in practice: it already races tavilySearch
//     against its own NEWS_PER_GOAL_TIMEOUT_MS (12s) via withTimeout, and
//     briefs.ts derives NEWS_BRIEF_TIMEOUT_MS margins off that same number
//     (#166) — so it needs the DEFAULT to stay comfortably above 12s (this
//     fetch-level abort then only reaps an already-abandoned request rather
//     than ever winning the race itself). It is the only caller that
//     deliberately omits an explicit timeoutMs.
const TAVILY_SEARCH_DEFAULT_TIMEOUT_MS = 45_000;
export const TAVILY_SEARCH_LIVE_TURN_TIMEOUT_MS = 8_000;

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
        // Live turn — the model is blocked on this reply (registry.ts's
        // executeSkillTool has no outer timeout of its own), same as
        // runResearch's GATHER/READ below. Tight budget, not the generous
        // default.
        const result = await tavilySearch(query, 'advanced', timeRangeDays, undefined, TAVILY_SEARCH_LIVE_TURN_TIMEOUT_MS);
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

/** Token-set Jaccard similarity between two snippets. Local, read-only copy
 *  of the formula already inlined at utils/skillPreferences.ts:225-247 and
 *  skills/news.ts:434-456 — a third copy here rather than a shared helper,
 *  which is a separate, larger, currently-declined piece (gh#191). */
function snippetJaccard(a: string, b: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const aTokens = new Set(norm(a).split(' ').filter(Boolean));
  const bTokens = new Set(norm(b).split(' ').filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  const inter = [...aTokens].filter(x => bTokens.has(x)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union > 0 ? inter / union : 0;
}

/** Read-only instrumentation (gh#191 piece 2): pairwise snippet similarity
 *  over the FULL candidate pool — not just the 3 sources that get read — so
 *  whether reads are actually redundant on this system can be judged from
 *  real numbers before paying for deeper/wider reading. Nothing below reads
 *  this return value; it only ever reaches the log line. */
function poolSimilarityStats(pool: ResearchSource[]): {
  poolSize: number; maxSimilarity: number; medianSimilarity: number; clusters: Record<string, number>;
} {
  const n = pool.length;
  const sims: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const pairs: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = snippetJaccard(pool[i].snippet ?? '', pool[j].snippet ?? '');
      sims[i][j] = sim; sims[j][i] = sim;
      pairs.push(sim);
    }
  }
  const sorted = [...pairs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length === 0 ? 0 : (sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]);
  const max = sorted.length === 0 ? 0 : sorted[sorted.length - 1];

  // Single-linkage clustering at each cutoff: how many distinct groups the
  // pool collapses into once snippets at/above that similarity are merged. A
  // pool collapsing to 1-2 groups at 0.3 is highly redundant; one that stays
  // near `n` groups even at 0.3 is genuinely diverse.
  const clusterCount = (cutoff: number): number => {
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (sims[i][j] >= cutoff) {
          const ri = find(i), rj = find(j);
          if (ri !== rj) parent[ri] = rj;
        }
      }
    }
    return new Set(Array.from({ length: n }, (_, i) => find(i))).size;
  };

  return {
    poolSize: n,
    maxSimilarity: Math.round(max * 100) / 100,
    medianSimilarity: Math.round(median * 100) / 100,
    clusters: { '0.3': clusterCount(0.3), '0.4': clusterCount(0.4), '0.5': clusterCount(0.5), '0.6': clusterCount(0.6) },
  };
}

/** The grounded research bundle the model writes from. */
export async function runResearch(goal: string, recencyOverride?: number, opts?: DomainFilterOpts): Promise<object> {
  logger.info('research — start', { goal: goal.slice(0, 120), recencyOverride });
  const plan = await planResearchQueries(goal);
  const recency = recencyOverride ?? plan.recencyDays;

  // GATHER — search each planned query into its OWN bucket, dedupe by URL
  // across buckets. Buckets are interleaved round-robin below, BEFORE the
  // READ slice is taken — collecting into one flat list first (the old
  // shape) let query 1 alone fill the whole READ_LIMIT whenever it returned
  // >= 3 results, so the other 2-4 planned angles were never read at all
  // (gh#191). Query order carries no priority (owner's call) — round-robin,
  // never weighted toward query 1. A single-query plan (planner fallback)
  // makes the interleave a no-op, so the original one-query starve case can
  // still occur there — accepted, not built around (owner's call).
  const buckets: ResearchSource[][] = plan.queries.map(() => []);
  const originByUrl = new Map<string, number>();
  const seen = new Set<string>();
  for (let qi = 0; qi < plan.queries.length; qi++) {
    const q = plan.queries[qi];
    try {
      // Tight budget (gh#191-3 follow-up): this loop runs inline in a live
      // turn, same reasoning as READ's TAVILY_EXTRACT_RESEARCH_TIMEOUT_MS below.
      const r = await tavilySearch(q, 'advanced', recency, opts, TAVILY_SEARCH_LIVE_TURN_TIMEOUT_MS) as {
        results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
      };
      for (const item of r.results ?? []) {
        const url = item.url;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        originByUrl.set(url, qi);
        buckets[qi].push({
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
  const sources: ResearchSource[] = [];
  const maxBucketLen = Math.max(0, ...buckets.map(b => b.length));
  for (let i = 0; i < maxBucketLen; i++) {
    for (const bucket of buckets) {
      if (bucket[i]) sources.push(bucket[i]);
    }
  }

  // Read-only similarity instrumentation (gh#191 piece 2) over the FULL
  // candidate pool, before the READ slice below — see poolSimilarityStats.
  // Zero behavior change: nothing branches on this, it only reaches the log.
  const similarity = poolSimilarityStats(sources);

  // READ — pull the full text of the top sources so facts come from the
  // article, not a snippet (and definitely not memory). `sources` below is
  // derived from `readings`, not this candidate list — a source whose
  // extraction failed is dropped from both, so the model can never cite one
  // it never actually read (gh#192). Tight timeout (gh#191 piece 3): this
  // loop runs inline in a live turn — someone's waiting — so a hung page
  // must not hang the turn.
  const READ_LIMIT = 3;
  const readings: Array<{ url: string; title?: string; content: string }> = [];
  for (const s of sources.slice(0, READ_LIMIT)) {
    try {
      const ext = await tavilyExtract(s.url, TAVILY_EXTRACT_RESEARCH_TIMEOUT_MS) as { content?: string };
      if (ext.content && ext.content.trim().length > 0) {
        readings.push({ url: s.url, title: s.title, content: ext.content.slice(0, 4000) });
      }
    } catch { /* page blocked extraction or timed out — dropped, not carried by a snippet */ }
  }

  // The sources shown/cited to the model must match what was actually read —
  // pull metadata (snippet, published date) back from the candidate list for
  // each URL that made it into `readings`, preserving readings' order.
  const readSources = readings
    .map(r => sources.find(s => s.url === r.url))
    .filter((s): s is ResearchSource => s !== undefined);
  // Which planned query each of the READ sources actually came from — how
  // F191-1's fix is verified live without needing the fuller pool stats.
  const readOrigin = readSources.map(s => originByUrl.get(s.url) ?? -1);

  logger.info('research — done', {
    goal: goal.slice(0, 80),
    queries: plan.queries.length,
    sources: readSources.length,
    readings: readings.length,
    readOrigin,
    poolSize: similarity.poolSize,
    maxSimilarity: similarity.maxSimilarity,
    medianSimilarity: similarity.medianSimilarity,
    clusters: similarity.clusters,
  });

  return {
    goal,
    queries_used: plan.queries,
    recency_days: recency ?? null,
    sources: readSources,
    readings,
    note: readSources.length > 0
      ? 'Write GROUNDED in these sources and CITE the URLs in your output. Do not assert any current-events fact not present here.'
      : sources.length > 0
        ? 'Sources were found but could not be read (extraction failed or timed out). Do NOT claim none exist — tell the owner the pages could not be read right now and offer to try again.'
        : 'NO web sources found. Do NOT fabricate facts — tell the owner you could not find a source and offer to try again.',
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
  timeoutMs: number = TAVILY_SEARCH_DEFAULT_TIMEOUT_MS,
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
  // gh#191-3 follow-up — bounded via AbortSignal.timeout (Node 20 native),
  // same treatment as tavilyExtract: a hung server can't block the turn
  // that's waiting on it.
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

export async function tavilyExtract(url: string, timeoutMs: number = TAVILY_EXTRACT_DEFAULT_TIMEOUT_MS): Promise<object> {
  if (!config.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY required for web_extract');
  }

  // extract_depth: advanced handles JS-heavy SPAs and content behind client-side
  // rendering (common on JS-heavy marketing sites). basic mode returned empty
  // content for those pages during KB recovery (2026-04-20).
  // gh#191 — bounded via AbortSignal.timeout (Node 20 native); a caller-scoped
  // budget so a hung server can't block the turn that's waiting on it.
  const res = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.TAVILY_API_KEY,
      urls: [url],
      extract_depth: 'advanced',
    }),
    signal: AbortSignal.timeout(timeoutMs),
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
