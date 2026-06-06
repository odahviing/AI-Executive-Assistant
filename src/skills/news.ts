/**
 * News skill (v3.2.6) — personalized, calendar-aware, GROUNDED news.
 *
 * Two callers, one core (`gatherNews`):
 *   - the on-demand `news` tool (chat: "what's the latest on Acme?"), and
 *   - the morning brief (`tasks/briefs.ts`), which calls gatherNews
 *     programmatically and folds the result into an "Updates" section.
 *
 * It is NOT a crawler. It points the existing grounded-research engine
 * (`runResearch`, skills/general.ts) at the owner's taught interests + the
 * companies of the people on today's calendar, steered by liked/disliked
 * domains, deduped topic-level against a rolling 7-day seen-log.
 *
 * Layer discipline (per the spec):
 *   - CODE (here): goal assembly + cap, per-goal timeout, domain-filter
 *     plumbing, seen-log read/write/prune, fail-open. gatherNews NEVER throws.
 *   - PROMPT (getSystemPromptSection): what's worth surfacing, the
 *     "already covered?" call, tone, citation. No enforcement.
 *   - LEARNED MEMORY: news.md (topics + preferred/blocked domains), taught via
 *     update_my_preferences(skill='news'). The seen-log MD is code-maintained.
 *
 * Multi-tenant by construction: no hardcoded topic/source/locale; a fresh user
 * with an empty news.md and no marked meetings produces an empty bundle.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import { promises as fs, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { getAnthropicClient } from '../llm/client';
import { tavilySearch, type DomainFilterOpts } from './general';
import { readSkillPreferences, formatSkillPreferencesBlock } from '../utils/skillPreferences';
import logger from '../utils/logger';

const NEWS_MODEL = 'claude-haiku-4-5-20251001';

// Cost controls (code constants — tune after measuring).
const NEWS_GOAL_CAP = 4;               // max research goals per gather
const NEWS_MORNING_RECENCY_DAYS = 2;   // daily brief: only the freshest, so no "history"
const NEWS_ONDEMAND_RECENCY_DAYS = 7;  // on-demand "catch me up": up to a week, aligned with the dedup window
const NEWS_PER_GOAL_TIMEOUT_MS = 12_000; // a goal slower than this is dropped
const SEEN_LOG_DAYS = 7;               // rolling dedup window (also the MAX article age we surface)

// ── Shared bundle shapes (mirror runResearch's return) ──────────────────────
export interface NewsSource { title?: string; url: string; snippet?: string; published?: string }
export interface NewsReading { url: string; title?: string; content: string }
export interface NewsBundle { goals: string[]; readings: NewsReading[]; sources: NewsSource[] }

export interface GatherNewsOpts {
  /** Company/org names of people on today's calendar (derived fresh, never stored). */
  meetingCompanies?: string[];
  /** Narrow to a single topic (the on-demand tool path). */
  topic?: string;
  /** Recency window in days; defaults to the morning edition window. */
  recencyDays?: number;
}

const EMPTY_BUNDLE: NewsBundle = { goals: [], readings: [], sources: [] };

// ── news.md parsing ─────────────────────────────────────────────────────────
// The file is owner-taught free text. CODE reads only the clearly-delimited
// source-steer lines; the rest is the interest corpus the goal planner reads.

interface ParsedNewsPrefs { interestsText: string; includeDomains: string[]; excludeDomains: string[] }

/** A domain off a "Preferred/Blocked sources:" line. Strips scheme/www/path. */
function normalizeDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].trim();
  // a bare domain has at least one dot and no spaces
  if (!d.includes('.') || /\s/.test(d)) return null;
  return d;
}

function splitDomainList(rest: string): string[] {
  return rest
    .split(/[,;]/)
    .map(normalizeDomain)
    .filter((d): d is string => !!d);
}

/**
 * Parse news.md into the interest corpus + domain steer. Source lines look like:
 *   Preferred sources: theinformation.com, stratechery.com
 *   Blocked sources: tabloid.example
 * Everything else is the free-text interest corpus the goal planner reads.
 */
export function parseNewsPrefs(md: string): ParsedNewsPrefs {
  const includeDomains: string[] = [];
  const excludeDomains: string[] = [];
  const interestLines: string[] = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*[-*]?\s*(preferred|liked|blocked|ignored|excluded)\s+sources?\s*:\s*(.*)$/i);
    if (m) {
      const kind = m[1].toLowerCase();
      const domains = splitDomainList(m[2]);
      if (kind === 'preferred' || kind === 'liked') includeDomains.push(...domains);
      else excludeDomains.push(...domains);
      continue;
    }
    interestLines.push(line);
  }
  const dedupe = (a: string[]) => [...new Set(a)];
  return {
    interestsText: interestLines.join('\n').trim(),
    includeDomains: dedupe(includeDomains),
    excludeDomains: dedupe(excludeDomains),
  };
}

// ── Goal planning ────────────────────────────────────────────────────────────
// One Haiku call turns the free-text interest corpus + today's meeting companies
// into a capped set of concrete search goals, honoring "skip/ignore" instructions
// the owner wrote in the file. Fail-open: on any error, fall back to a
// deterministic line/company extraction so the gather still runs.

async function planNewsGoals(
  interestsText: string,
  meetingCompanies: string[],
  cap: number,
): Promise<string[]> {
  const companiesLine = meetingCompanies.length > 0
    ? `\nCompanies of people on today's calendar (prioritize — these are timely): ${meetingCompanies.join(', ')}.`
    : '';
  if (!interestsText && meetingCompanies.length === 0) return [];

  const prompt = `You plan a personalized morning NEWS brief for an executive assistant.

OWNER'S STANDING NEWS INTERESTS (free text he taught — may include "skip X" / "ignore Y" instructions):
${interestsText || '(none)'}
${companiesLine}

Output STRICT JSON only: {"goals": ["...", "..."]}
- Up to ${cap} concise, concrete web-search goals for TODAY's news (e.g. "EU AI Act enforcement news", "Acme Corp funding and product news").
- HONOR any skip/ignore instruction — never produce a goal for an excluded topic.
- Prefer the meeting companies (timely) and the owner's top interests.
- Describe the TOPIC, not a task. No more than ${cap} goals.`;

  try {
    const res = await getAnthropicClient().messages.create({
      model: NEWS_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = ((res.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]) as { goals?: unknown };
      const goals = Array.isArray(parsed.goals)
        ? parsed.goals.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map(g => g.trim())
        : [];
      if (goals.length > 0) return goals.slice(0, cap);
    }
  } catch (err) {
    logger.warn('news — goal planning failed, using deterministic fallback', { err: String(err).slice(0, 160) });
  }

  // Deterministic fallback: company goals + interest bullet lines, capped.
  const companyGoals = meetingCompanies.map(c => `${c} company news`);
  const interestGoals = interestsText
    .split('\n')
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(l => l.length > 0 && !/^skip\b|^ignore\b/i.test(l));
  return [...new Set([...companyGoals, ...interestGoals])].slice(0, cap);
}

// ── Per-goal lightweight search (efficiency) ─────────────────────────────────
// v3.2.6 cost fix: ONE Tavily news search per goal — no per-goal query
// expansion (that was a Haiku call per goal) and NO full-article extraction
// (3 tavilyExtract calls per goal). A morning news section writes from
// headlines + snippets; deep reads are overkill and were the source of the
// "100+ requests per ask" blow-up. Net: ~1 call/goal instead of ~8.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    const t = setTimeout(() => resolve(null), ms);
    if (typeof t.unref === 'function') t.unref();
    p.then(
      v => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

interface TavilyLite { results?: Array<{ title?: string; content?: string; url?: string; published_date?: string }> }

async function searchGoal(goal: string, recency: number, steer: DomainFilterOpts): Promise<NewsSource[]> {
  const run = async (opts: DomainFilterOpts): Promise<NewsSource[]> => {
    const r = await withTimeout(
      tavilySearch(goal, 'advanced', recency, opts) as Promise<TavilyLite>,
      NEWS_PER_GOAL_TIMEOUT_MS,
    );
    if (!r) return [];
    return (r.results ?? [])
      .filter(it => !!it.url)
      .map(it => ({
        title: it.title,
        url: it.url as string,
        snippet: (it.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
        published: it.published_date,
      }));
  };
  let sources = await run(steer);
  // Over-narrow guard: an include-filter that returned nothing → re-run this one
  // goal unfiltered so a too-tight source pin never blanks the topic.
  if ((steer.includeDomains?.length ?? 0) > 0 && sources.length === 0) {
    sources = await run({ excludeDomains: steer.excludeDomains });
  }
  return sources;
}

/**
 * The shared news core. Assembles goals, runs ONE lightweight grounded search
 * per goal (best-effort, timed-out, dropped on failure), and returns a deduped
 * bundle. NEVER throws — returns an empty bundle on total failure.
 */
export async function gatherNews(profile: UserProfile, opts: GatherNewsOpts = {}): Promise<NewsBundle> {
  try {
    const recency = opts.recencyDays ?? NEWS_MORNING_RECENCY_DAYS;
    const prefs = parseNewsPrefs(readSkillPreferences(profile, 'news'));
    const steer: DomainFilterOpts = {
      includeDomains: prefs.includeDomains.length ? prefs.includeDomains : undefined,
      excludeDomains: prefs.excludeDomains.length ? prefs.excludeDomains : undefined,
    };

    // Goal set: a narrowed topic short-circuits the planner; otherwise plan from
    // the interest corpus + today's meeting companies.
    let goals: string[];
    if (opts.topic && opts.topic.trim()) {
      goals = [opts.topic.trim()];
    } else {
      goals = await planNewsGoals(prefs.interestsText, opts.meetingCompanies ?? [], NEWS_GOAL_CAP);
    }
    if (goals.length === 0) {
      logger.info('news — no goals (empty interests + no meeting companies); empty bundle');
      return { ...EMPTY_BUNDLE };
    }

    // One search per goal, in parallel (cap is small). A goal that errors/times
    // out resolves to [] and is dropped.
    const perGoal = await Promise.all(goals.map(g => searchGoal(g, recency, steer)));

    const sources: NewsSource[] = [];
    const seenUrl = new Set<string>();
    for (const list of perGoal) {
      for (const s of list) {
        if (!s.url || seenUrl.has(s.url)) continue;
        seenUrl.add(s.url);
        sources.push(s);
      }
    }

    logger.info('news — gather done', { goals: goals.length, sources: sources.length });
    // readings stays empty — the compose writes from snippets (cost fix).
    return { goals, sources, readings: [] };
  } catch (err) {
    logger.warn('news — gatherNews failed, returning empty bundle', { err: String(err).slice(0, 200) });
    return { ...EMPTY_BUNDLE };
  }
}

// ── Rolling 7-day seen-log (topic-level dedup) ───────────────────────────────
// One MD file per owner: a dated section per day, each a handful of one-line
// summaries. The compose injects the last 7 days with a "do not repeat" rule;
// the write prunes any day older than 7 days. This is the ONLY new persistent
// state, and it's MD (owner's call) — no migration.

function seenLogPath(profile: UserProfile): string {
  const firstName = profile.user.name.split(' ')[0].toLowerCase();
  return path.resolve(process.cwd(), 'config', 'users', `${firstName}_news_seen.md`);
}

function todayStamp(): string {
  // Local date is fine here — the log is the owner's, day-granular.
  return new Date().toISOString().slice(0, 10);
}

/** The last `SEEN_LOG_DAYS` of the seen-log, for the compose dedup rule. Returns
 *  '' when none. (The file is pruned on write, so we return it as-is.) */
export function readSeenLog(profile: UserProfile): string {
  try {
    const file = seenLogPath(profile);
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8').trim();
  } catch (err) {
    logger.warn('news — seen-log read failed', { err: String(err).slice(0, 160) });
    return '';
  }
}

/** Parse "## YYYY-MM-DD\n<lines>" sections; drop any older than the window. */
function pruneSeenLog(md: string, keepFromDate: string): string {
  const out: string[] = [];
  let keepCurrent = true;
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s*(\d{4}-\d{2}-\d{2})\s*$/);
    if (h) {
      keepCurrent = h[1] >= keepFromDate; // lexical compare works for ISO dates
      if (keepCurrent) out.push(line);
      continue;
    }
    if (keepCurrent) out.push(line);
  }
  return out.join('\n').trim();
}

/** Turn a gathered bundle into one-line seen-log entries via a cheap Haiku pass.
 *  Fail-open: on error, fall back to listing source titles + domains. */
async function summarizeBundleForSeenLog(bundle: NewsBundle): Promise<string[]> {
  const material = bundle.sources.slice(0, 8).map(s => {
    let domain = '';
    try { domain = new URL(s.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    return `- ${s.title ?? s.url}${s.snippet ? ` — ${s.snippet}` : ''} [${domain}]`;
  }).join('\n');
  if (!material) return [];

  try {
    const res = await getAnthropicClient().messages.create({
      model: NEWS_MODEL,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `These news items were just surfaced to the owner. Write a SHORT topic-level log so we don't repeat the same story (even from another outlet) over the next week.

ITEMS:
${material}

Output one line per distinct STORY (cluster outlets covering the same story into one line), format exactly:
• <topic/headline> — <one-line gist> [<source domain>]
No preamble, max 6 lines.`,
      }],
    });
    const text = ((res.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('•') || l.startsWith('-'));
    if (lines.length > 0) return lines.map(l => l.replace(/^[-•]\s*/, '• '));
  } catch (err) {
    logger.warn('news — seen-log summarize failed, using titles', { err: String(err).slice(0, 160) });
  }
  // Fallback: raw titles.
  return bundle.sources.slice(0, 6).map(s => {
    let domain = '';
    try { domain = new URL(s.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    return `• ${s.title ?? s.url} [${domain}]`;
  });
}

/** Drop near-duplicate bullet lines from the merged log (keeping the first of
 *  each). Without this, running news several times a day piled up the same story
 *  under slightly different wording — bloating the log AND degrading the
 *  topic-match dedup at compose time. Token-set Jaccard ≥ 0.6 counts as the same
 *  story (same heuristic as skillPreferences). Headers + blanks pass through. */
function dedupeSeenLogBullets(md: string): string {
  const norm = (s: string) =>
    s.toLowerCase().replace(/^[-•]\s*/, '').replace(/\[[^\]]*\]\s*$/, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const keptTokenSets: Set<string>[] = [];
  const out: string[] = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('•')) { out.push(line); continue; }
    const tokens = new Set(norm(t).split(' ').filter(Boolean));
    if (tokens.size === 0) { out.push(line); continue; }
    let dup = false;
    for (const prev of keptTokenSets) {
      const inter = [...tokens].filter(x => prev.has(x)).length;
      const union = new Set([...tokens, ...prev]).size;
      if (union > 0 && inter / union >= 0.6) { dup = true; break; }
    }
    if (dup) continue;
    keptTokenSets.push(tokens);
    out.push(line);
  }
  return out.join('\n').trim();
}

/** Append today's surfaced items to the seen-log and prune days >7d old.
 *  Fire-and-forget by callers. Non-fatal on any error. */
export async function writeSeenLog(profile: UserProfile, bundle: NewsBundle): Promise<void> {
  if (!bundle.sources.length) return;
  try {
    const lines = await summarizeBundleForSeenLog(bundle);
    if (lines.length === 0) return;

    const file = seenLogPath(profile);
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const prior = existsSync(file) ? readFileSync(file, 'utf8') : '';

    const today = todayStamp();
    // keepFrom = today minus (SEEN_LOG_DAYS - 1) days
    const from = new Date();
    from.setDate(from.getDate() - (SEEN_LOG_DAYS - 1));
    const keepFrom = from.toISOString().slice(0, 10);

    const pruned = pruneSeenLog(prior, keepFrom);
    // Merge into today's section if it already exists, else prepend a new one.
    let next: string;
    if (pruned.includes(`## ${today}`)) {
      next = pruned.replace(`## ${today}`, `## ${today}\n${lines.join('\n')}`);
    } else {
      const todaySection = `## ${today}\n${lines.join('\n')}`;
      next = pruned ? `${todaySection}\n\n${pruned}` : todaySection;
    }
    // Collapse near-duplicate stories (re-runs in the same day, same story
    // across outlets) so the log stays clean and the dedup context stays sharp.
    next = dedupeSeenLogBullets(next);

    await fs.writeFile(file, `${next.trim()}\n`, 'utf8');
    logger.info('news — seen-log written', { added: lines.length });
  } catch (err) {
    logger.warn('news — seen-log write failed', { err: String(err).slice(0, 160) });
  }
}

/** Shared compose-time block: the seen-log + the dedup rule. '' when empty. */
export function formatSeenLogBlock(profile: UserProfile): string {
  const log = readSeenLog(profile);
  if (!log) return '';
  return [
    '',
    'ALREADY COVERED (last 7 days) — do NOT repeat a story already covered here, even from a different outlet. Only surface genuinely NEW developments:',
    log,
  ].join('\n');
}

// ── The skill ────────────────────────────────────────────────────────────────

export class NewsSkill implements Skill {
  id = 'news' as const;
  name = 'News';
  description = 'Personalized, calendar-aware, grounded news — an on-demand tool plus the morning brief\'s Updates section.';

  getTools(_profile: UserProfile): Anthropic.Tool[] {
    return [
      {
        name: 'news',
        description: `Personalized, GROUNDED news. Use this — not web_search — when the owner asks "what's the latest / any news on X", "anything new with <company/topic>", or wants his news refreshed.

What it does: builds search goals from his taught interests (+ an optional topic you pass), steers to his preferred/blocked sources, runs real grounded research, and returns the SOURCES + their content. It also respects the rolling 7-day "already covered" log so it doesn't hand you stale repeats.

Then YOU: write GROUNDED in what it returns and CITE the source links. NEVER assert a current-events fact that isn't in the returned sources; if it comes back empty, say you couldn't find a source rather than writing from memory.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            topic: {
              type: 'string',
              description: 'Optional. Narrow to a single topic/company (e.g. "Acme Corp" or "EU AI Act"). Omit to pull his standing interests.',
            },
          },
          required: [],
        },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    if (toolName !== 'news') return null;
    const topic = (args.topic as string | undefined)?.trim() || undefined;
    const bundle = await gatherNews(context.profile, { topic, recencyDays: NEWS_ONDEMAND_RECENCY_DAYS });
    // Fire-and-forget: log what we surfaced so the next ask/brief dedupes it.
    void writeSeenLog(context.profile, bundle).catch(() => { /* non-fatal */ });
    return {
      goals: bundle.goals,
      sources: bundle.sources,
      note: bundle.sources.length === 0
        ? 'No fresh sources came back. Say so plainly in one short line — matter-of-fact, NOT an apology, NOT a long explanation — and move on. Do not fabricate.'
        : 'Write GROUNDED in these sources and CITE each with a Slack hyperlink <url|short label> (NOT a bare URL, NOT [link] followed by the URL). Keep it tight: a few bullets, the genuinely new items only. Skip anything older than 7 days or already in the "already covered" log. Do not assert any current-events fact not present here.',
    };
  }

  getSystemPromptSection(profile: UserProfile, scopes?: string[], isOwner?: boolean): string {
    // News is owner-facing; colleagues have no news tool.
    if (!isOwner) return '';
    const firstName = profile.user.name.split(' ')[0];

    // ALWAYS-ON for the owner (cheap, a few lines): the teach-routing rule. This
    // is the load-bearing fix for "I describe my news topics → she deep-researches
    // and saves nothing." A config message can scope anywhere (knowledge/general/
    // news), so the routing rule must NOT depend on the classifier picking 'news'.
    const routing = `NEWS ROUTING (read before acting on anything news-related):
- When ${firstName} tells you what his news should COVER — topics, areas, companies to track, sources to prefer/avoid — even when worded as a request ("for my news, I want updates on X", "I want to know about Y", "include these companies: …", "track Z", "stop covering crypto", "I like stratechery.com") — that is CONFIGURING his news report, NOT a request to fetch news now. SAVE it in ONE call: when he gives several topics at once, write them as a single list and call update_my_preferences(skill='news', mode='replace', text='<the full list, his words>') ONCE. To add ONE new area later to an existing set, call it once with mode='add'. The tool is idempotent and dedupes — call it AT MOST ONCE per teach; never re-save the same topics or re-issue the save across steps. Then confirm what you saved in one line and ask if he wants a scan now. Do NOT run web_research/deep research and do NOT call news() to "answer" a configuration message — saving is the whole job.
- To actually SHOW him news he asks for ("what's the latest on X", "catch me up"), the tool is news() — NEVER web_research for his news report.`;

    // Scope-gate only the heavier guidance + seen-log so a non-news turn stays cheap.
    const inPlay = !scopes || scopes.includes('general') || scopes.includes('news');
    if (!inPlay) return routing;

    const prefs = formatSkillPreferencesBlock(profile, 'news', { label: 'NEWS' });
    const seenLog = formatSeenLogBlock(profile);
    return `${routing}

NEWS
- news(topic?) — grounded, cited news for ${firstName}. Pass a topic to narrow; omit it to use his standing interests + today's meetings. Call it ONCE per ask — it covers multiple topics; do NOT call it separately per company. It returns real SOURCES — write GROUNDED and CITE each with a Slack hyperlink <url|short label> (never a bare URL, never "[link]" + the URL). Keep it TIGHT: a few bullets, only genuinely NEW items, nothing older than 7 days. NEVER assert a current-events fact not in the returned bundle; if it returns nothing, say so in one plain line — no apology, no long explanation.
- Source steer + interests live in his news.md (taught via update_my_preferences). Keep "Preferred sources:" / "Blocked sources:" lines clearly delimited so the engine can read the domains.${seenLog}${prefs}`.trim();
  }
}
