import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import { config } from '../config';
import logger from '../utils/logger';

/**
 * Search Skill
 * Quick web lookups — weather, news, exchange rates, holidays, current events.
 * Available to both owner and colleagues.
 * For deep multi-step research and content creation, see the Research skill (owner-only).
 */
export class SearchSkill implements Skill {
  id = 'search' as const;
  name = 'Search';
  description = 'Real-time web lookups — weather, news, exchange rates, holidays, current events.';

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
              description: 'The search query. Be specific. e.g. "weather Tel Aviv today", "USD ILS exchange rate", "Reflectiz cybersecurity news"',
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

Note: Some pages may block extraction (login-required, bot-protected). If extraction fails, fall back to web_search about the topic.`,
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
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<unknown | null> {
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

  getSystemPromptSection(profile: UserProfile): string {
    const units = profile.user.units !== 'imperial'
      ? 'Always use metric units (°C, km, kg, etc.) — never Fahrenheit or imperial.'
      : 'Always use imperial units (°F, miles, lbs, etc.) — never Celsius or metric.';
    return `
SEARCH
You can look up any real-time information using web_search: weather, news, exchange rates, holidays, current events, company info, recent facts.

For stable knowledge (history, geography, general concepts), answer directly — no search needed.

${units}

ANSWER ONLY WHAT WAS ASKED. One focused answer, then stop.
Keep answers short and conversational — this is office chat, not a report.
Never use bullet points or headers for simple factual answers.
`.trim();
  }
}

// ── Search implementations ────────────────────────────────────────────────────

export async function tavilySearch(
  query: string,
  depth: 'basic' | 'advanced' = 'advanced',
  timeRangeDays?: number,
): Promise<object> {
  // v1.8.8 — when caller passes timeRangeDays, use Tavily's news topic + days
  // filter so recency is enforced. Otherwise general-topic search (no date
  // constraint) for evergreen lookups.
  const body: Record<string, unknown> = {
    api_key: config.TAVILY_API_KEY,
    query,
    search_depth: depth,
    max_results: 8,
    include_answer: true,
  };
  if (typeof timeRangeDays === 'number' && timeRangeDays > 0) {
    body.topic = 'news';
    body.days = Math.min(Math.max(Math.round(timeRangeDays), 1), 365);
  }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    logger.error('Tavily API error', { status: res.status, body: errBody.slice(0, 300) });
    throw new Error(`Tavily HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  logger.info('Tavily result', { query, answer: !!data.answer, count: data.results?.length ?? 0 });

  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).slice(0, 6).map((r: any) => ({
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

  const data = await res.json() as any;
  const results = (data.web?.results ?? []).slice(0, 6).map((r: any) => ({
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

  const data = await res.json() as any;

  return {
    abstract: data.AbstractText || null,
    answer: data.Answer || null,
    source: data.AbstractSource || null,
    url: data.AbstractURL || null,
    related: (data.RelatedTopics ?? []).slice(0, 3).map((t: any) => t.Text).filter(Boolean),
    note: 'Using DuckDuckGo instant answers (limited). Add TAVILY_API_KEY to .env for full web search.',
  };
}

// ── URL content extraction ───────────────────────────────────────────────────

export async function tavilyExtract(url: string): Promise<object> {
  if (!config.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY required for web_extract');
  }

  const res = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.TAVILY_API_KEY,
      urls: [url],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    logger.error('Tavily extract error', { status: res.status, body: errBody.slice(0, 300) });
    throw new Error(`Tavily extract HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as any;
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
