/**
 * Research pre-check (v2.8.5).
 *
 * Standing owner principle: when the owner explicitly asks Maelle to EXPLORE
 * / RESEARCH / LOOK INTO a topic, she should reach OUTSIDE the company
 * knowledge base — not just synthesize from internal KB and her training.
 *
 * The article-gen flow this morning showed the gap concretely: the routine
 * pulled real web data, but the follow-up "give me article for 1" fired no
 * tools at all because Sonnet had context from the routine + her own
 * knowledge and didn't think to research further. The owner wanted fresh
 * outside data per draft.
 *
 * Fix shape: on owner-path messages matching an explicit explore/research
 * intent regex, run `web_search` deterministically BEFORE the main Sonnet
 * turn and inject the results as a prompt block. Sonnet drafts with the
 * fresh data already in context — no prompt rule needed to nudge her to
 * call the tool, because the call has already happened in code.
 *
 * Best-effort detector — fails open. Regex miss → block empty → normal
 * flow (Sonnet decides whether to web_search on her own). Tavily failure
 * → also fails open. The pre-check NEVER blocks the main turn.
 *
 * Sibling to `availabilityPreCheck.ts` — same shape, same trade-offs.
 */

import { tavilySearch } from '../skills/general';
import logger from './logger';

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Explicit explore/research intents. The capture group is the topic. Tuned
 * conservatively — we'd rather miss a borderline case than fire on every
 * "tell me how it went today". Each pattern requires a topic noun phrase of
 * at least 3 chars, capped at 80 to avoid grabbing the rest of the message.
 */
const INTENT_PATTERNS: RegExp[] = [
  /\b(?:explore|research|dig into|look into|find out about|find me info on|look up)\s+([^?.!\n,;]{3,80})/i,
  /\bwhat'?s\s+(?:new|happening|going on|the latest|recent)\s+(?:with|about|on|in)\s+([^?.!\n,;]{3,80})/i,
  /\btell me about\s+([^?.!\n,;]{3,80})/i,
];

/**
 * Strip filler words from the end of an extracted topic. The regex captures
 * are greedy at the end — "explore Magecart trends in 2026" → "Magecart
 * trends in 2026" is fine; "explore that" → "that" is junk.
 */
const JUNK_TOPICS = new Set([
  'that', 'this', 'it', 'them', 'those', 'these', 'something',
  'more', 'further', 'a bit', 'some more',
]);

function extractTopic(message: string): string | null {
  for (const pattern of INTENT_PATTERNS) {
    const m = message.match(pattern);
    if (m && m[1]) {
      const topic = m[1].trim().replace(/\s+/g, ' ');
      if (topic.length < 3) continue;
      if (JUNK_TOPICS.has(topic.toLowerCase())) continue;
      return topic;
    }
  }
  return null;
}

// ── Execution ──────────────────────────────────────────────────────────────

export interface ResearchPreCheckResult {
  ran: boolean;
  topic?: string;
  promptBlock?: string;
}

export async function precheckResearch(opts: {
  message: string;
}): Promise<ResearchPreCheckResult> {
  const topic = extractTopic(opts.message);
  if (!topic) return { ran: false };

  logger.info('researchPreCheck — explore intent detected, running web_search', { topic });

  try {
    const result = await tavilySearch(topic, 'advanced', 30) as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    const lines: string[] = [
      `FRESH WEB RESEARCH on "${topic}" (auto-fetched before this turn — use as source material; cite URLs where they sharpen your point):`,
    ];
    if (result?.answer) {
      lines.push('', `SUMMARY: ${result.answer.slice(0, 600)}`);
    }
    const items = (result?.results ?? []).slice(0, 5);
    if (items.length > 0) {
      lines.push('', 'TOP RESULTS:');
      for (const item of items) {
        const title = (item.title ?? '').slice(0, 120);
        const url = item.url ?? '';
        const snippet = (item.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
        lines.push(`• ${title} — ${url}`);
        if (snippet) lines.push(`  ${snippet}`);
      }
    }
    if (lines.length === 1) {
      // Search returned empty — nothing useful to inject.
      logger.info('researchPreCheck — search returned empty, skipping block', { topic });
      return { ran: false, topic };
    }
    return { ran: true, topic, promptBlock: lines.join('\n') };
  } catch (err) {
    logger.warn('researchPreCheck — search threw, failing open', {
      topic, err: String(err).slice(0, 200),
    });
    return { ran: false, topic };
  }
}
