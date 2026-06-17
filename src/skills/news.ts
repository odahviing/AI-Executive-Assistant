/**
 * News skill (v3.2.6) — personalized, calendar-aware, GROUNDED news.
 *
 * Two callers, one core (`gatherNews`):
 *   - the on-demand `news` tool (chat: "what's the latest on Acme?"), and
 *   - the morning brief (`tasks/briefs.ts`), which calls gatherNews
 *     programmatically and folds the result into an "Updates" section.
 *
 * It is NOT a crawler. It points the grounded web-search engine
 * (`tavilySearch`, skills/general.ts) at the owner's taught interests + the
 * companies of the people on today's calendar, deduped topic-level against a
 * rolling 7-day seen-log.
 *
 * Layer discipline (per the spec):
 *   - CODE (here): goal assembly + cap, per-goal timeout, seen-log
 *     read/write/prune, fail-open. gatherNews NEVER throws. Code does NOT
 *     parse news.md for domain steer (removed v3.4.0 — the regex was an
 *     implicit format contract on owner free-text); Tavily runs unsteered.
 *   - PROMPT (getSystemPromptSection): what's worth surfacing, the
 *     "already covered?" call, tone, citation, and weighing any source
 *     preferences the owner wrote in news.md. No enforcement.
 *   - LEARNED MEMORY: news.md (free-text topics + source preferences), taught
 *     via update_my_preferences(skill='news'); the model reads it, code does
 *     not. The seen-log MD is code-maintained.
 *
 * Multi-tenant by construction: no hardcoded topic/source/locale; a fresh user
 * with an empty news.md and no marked meetings produces an empty bundle.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import { promises as fs, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import { getAnthropicClient } from '../llm/client';
import { tavilySearch, type DomainFilterOpts } from './general';
import { readSkillPreferences, formatSkillPreferencesBlock } from '../utils/skillPreferences';
import logger from '../utils/logger';
import { extractFirstJsonObject } from '../utils/extractJson';

const NEWS_MODEL = 'claude-haiku-4-5-20251001';

// Cost controls (code constants — tune after measuring).
const NEWS_GOAL_CAP = 4;               // max research goals per gather
const NEWS_MORNING_RECENCY_DAYS = 3;   // daily brief window — fresh. Re-pull MAY re-offer an
                                       // unshown article for up to ~3 days, but only while it
                                       // stays in Tavily's top results; a fast-moving topic can
                                       // push it out within a day (no hard resurface guarantee).
const NEWS_ONDEMAND_RECENCY_DAYS = 7;  // on-demand "catch me up": up to a week
const NEWS_ONDEMAND_LOG_CEILING = 7;   // on-demand seen-log cap — matches the "up to 7" surface ceiling
const NEWS_PER_GOAL_TIMEOUT_MS = 12_000; // a goal slower than this is dropped
const NEWS_MAX_RESULTS = 15;           // Tavily candidates per goal — deep pool so showing
                                       // up to 7/day over a 3-day window (deduped) doesn't run dry
const SEEN_LOG_DAYS = 7;               // rolling dedup window for SHOWN stories (don't-repeat)

// ── Shared bundle shapes (mirror runResearch's return) ──────────────────────
export interface NewsSource { title?: string; url: string; snippet?: string; published?: string }
export interface NewsBundle { goals: string[]; sources: NewsSource[] }

export interface GatherNewsOpts {
  /** Company/org names of people on today's calendar (derived fresh, never stored). */
  meetingCompanies?: string[];
  /** Narrow to a single topic (the on-demand tool path). */
  topic?: string;
  /** Recency window in days; defaults to the morning edition window. */
  recencyDays?: number;
}

const EMPTY_BUNDLE: NewsBundle = { goals: [], sources: [] };

// ── news.md parsing ─────────────────────────────────────────────────────────
// The file is owner-taught free text. The LLM reads it verbatim; code does
// NOT parse it.

interface ParsedNewsPrefs { interestsText: string }

/**
 * Owner free-text from news.md, passed verbatim into the LLM goal planner +
 * compose pass. A prior version regex'd `Preferred sources:` /
 * `Blocked sources:` lines into Tavily include/exclude_domains — that was an
 * implicit format contract on owner free-text (any other phrasing silently
 * dropped the steer) and a code-side parse of LLM-managed content, which
 * breaks the "LLM-only — code doesn't parse" architecture invariant for
 * skillPreferences. Now the full file becomes the interest corpus; Sonnet
 * reads any source preferences mentioned in it and weighs results in the
 * compose pass. Tavily runs unsteered.
 */
export function parseNewsPrefs(md: string): ParsedNewsPrefs {
  return { interestsText: md.trim() };
}

/**
 * Normalize a URL to host+path for shown-vs-gathered matching: lowercase host,
 * drop scheme, leading `www.`, query string, fragment, and a trailing slash.
 * So `https://www.x.com/a/?utm_source=rss` and `http://x.com/a` both reduce to
 * `x.com/a`. Pure string ops — no URL() parse (a malformed citation shouldn't
 * throw inside the seen-log writer).
 */
function normalizeUrl(u: string): string {
  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

// ── Goal planning ────────────────────────────────────────────────────────────
// One Haiku call turns the free-text interest corpus + today's meeting companies
// into a capped set of concrete search goals, honoring "skip/ignore" instructions
// the owner wrote in the file. Fail-open: on any error, fall back to a
// deterministic line/company extraction so the gather still runs.

// M-7 (v3.3.x) — domain steer is EMITTED by the LLM planner as structured
// output, never parsed out of the owner's free-text MD by code. news.md stays
// pure taste ("I follow web-security; prefer Stratechery, skip tabloids"); the
// planner translates that intent → bare hostnames we hand to Tavily. Code reads
// STRUCTURE from the LLM, not prose — so any phrasing works and the
// "code-doesn't-parse-the-MD" invariant (docs/AGENT_LOOP_INVARIANTS.md #7) holds.
interface NewsPlan { goals: string[]; preferredDomains: string[]; avoidDomains: string[] }
const DOMAIN_STEER_CAP = 8;

/** Sanitize a domain the PLANNER emitted (this is LLM structured output, NOT a
 *  free-text MD parse): bare hostname, lowercased, scheme/www/path stripped;
 *  dropped if it doesn't look like a domain. */
function cleanEmittedDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let d = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].trim();
  if (!d.includes('.') || /\s/.test(d)) return null;
  return d;
}
function cleanDomainList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const d = cleanEmittedDomain(x);
    if (d && !seen.has(d)) { seen.add(d); out.push(d); if (out.length >= DOMAIN_STEER_CAP) break; }
  }
  return out;
}

async function planNewsGoals(
  interestsText: string,
  meetingCompanies: string[],
  cap: number,
): Promise<NewsPlan> {
  const empty: NewsPlan = { goals: [], preferredDomains: [], avoidDomains: [] };
  const companiesLine = meetingCompanies.length > 0
    ? `\nCompanies of people on today's calendar (prioritize — these are timely): ${meetingCompanies.join(', ')}.`
    : '';
  if (!interestsText && meetingCompanies.length === 0) return empty;

  const prompt = `You plan a personalized morning NEWS brief for an executive assistant.

OWNER'S STANDING NEWS INTERESTS (free text he taught — may include "skip X" / "ignore Y" topic instructions AND source preferences like "I like Stratechery" / "skip tabloids"):
${interestsText || '(none)'}
${companiesLine}

Output STRICT JSON only: {"goals": ["...","..."], "preferred_domains": ["..."], "avoid_domains": ["..."]}
- goals: up to ${cap} concise, concrete web-search goals for TODAY's news (e.g. "EU AI Act enforcement news", "Acme Corp funding and product news"). HONOR any skip/ignore TOPIC instruction — never produce a goal for an excluded topic. Prefer the meeting companies (timely) + his top interests. Describe the TOPIC, not a task. No more than ${cap} goals.
- preferred_domains / avoid_domains: translate any SOURCE preference in his free text into bare hostnames (e.g. "I like Stratechery" → preferred_domains ["stratechery.com"]; "skip the Daily Mail / tabloids" → avoid_domains ["dailymail.co.uk"]). ONLY a domain he clearly named or unambiguously implied — never invent one. Bare hostnames only (no http://, no paths). Empty arrays when he expressed no source preference.`;

  try {
    const res = await getAnthropicClient().messages.create({
      model: NEWS_MODEL,
      max_tokens: 350,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = ((res.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const m = extractFirstJsonObject(text);
    if (m) {
      const parsed = JSON.parse(m) as { goals?: unknown; preferred_domains?: unknown; avoid_domains?: unknown };
      const goals = Array.isArray(parsed.goals)
        ? parsed.goals.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map(g => g.trim())
        : [];
      if (goals.length > 0) {
        return {
          goals: goals.slice(0, cap),
          preferredDomains: cleanDomainList(parsed.preferred_domains),
          avoidDomains: cleanDomainList(parsed.avoid_domains),
        };
      }
    }
  } catch (err) {
    logger.warn('news — goal planning failed, using deterministic fallback', { err: String(err).slice(0, 160) });
  }

  // Deterministic fallback: company goals + interest bullet lines, capped. No
  // domain steer in the fallback (deriving it needs the LLM; broad is safe).
  const companyGoals = meetingCompanies.map(c => `${c} company news`);
  const interestGoals = interestsText
    .split('\n')
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(l => l.length > 0 && !/^skip\b|^ignore\b/i.test(l));
  return { goals: [...new Set([...companyGoals, ...interestGoals])].slice(0, cap), preferredDomains: [], avoidDomains: [] };
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
  // M-7 (v3.3.x) — domain steer is back, but LLM-emitted (not parsed). Over-narrow
  // guard: if a preferred-domain (include) filter returns nothing for this goal,
  // retry once WITHOUT the include (keep any avoid/exclude) so a tight "prefer X"
  // never blanks a topic X had no news on today. Fail-open toward coverage.
  let sources = await run(steer);
  if ((steer.includeDomains?.length ?? 0) > 0 && sources.length === 0) {
    sources = await run({ excludeDomains: steer.excludeDomains, maxResults: steer.maxResults });
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

    // Goal set: a narrowed topic short-circuits the planner (the owner asked for
    // ONE thing — search it broad, the compose weighs sources). Otherwise the LLM
    // planner emits goals AND structured source steer (preferred/avoid domains)
    // from his free-text interests — code never parses the MD (M-7).
    let goals: string[];
    // Wide candidate net per goal so the daily 6-7 (deduped over the window)
    // doesn't run dry — see NEWS_MAX_RESULTS.
    let steer: DomainFilterOpts = { maxResults: NEWS_MAX_RESULTS };
    if (opts.topic && opts.topic.trim()) {
      goals = [opts.topic.trim()];
    } else {
      const plan = await planNewsGoals(prefs.interestsText, opts.meetingCompanies ?? [], NEWS_GOAL_CAP);
      goals = plan.goals;
      steer = {
        maxResults: NEWS_MAX_RESULTS,
        includeDomains: plan.preferredDomains.length ? plan.preferredDomains : undefined,
        excludeDomains: plan.avoidDomains.length ? plan.avoidDomains : undefined,
      };
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
    return { goals, sources };
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

function todayStamp(profile: UserProfile): string {
  // OWNER-LOCAL date. Pre-fix used UTC, which put west-of-UTC owners
  // (America/*) into next-UTC-day's seen-log section during their local
  // evening — the dedup window still slid day-by-day but offset wrong
  // relative to "today" as the owner experienced it.
  return DateTime.now().setZone(profile.user.timezone).toFormat('yyyy-MM-dd');
}

// Per-profile mutex for seen-log read+Haiku+write. Both the morning brief
// (via tasks/briefs.ts) and the on-demand `news(topic)` tool can call
// writeSeenLog within seconds of each other; without a lock they read the
// same prior file, each computes a different `next` (with their own Haiku
// summarize ~1-3s), and the slower-finishing one overwrites the faster's
// merge → silent loss of one day's entries. Key per-profile so multi-tenant
// stays parallel.
const seenLogMutexes = new Map<string, Promise<unknown>>();
async function withSeenLogLock<T>(profile: UserProfile, op: () => Promise<T>): Promise<T> {
  const key = seenLogPath(profile);
  const prev = (seenLogMutexes.get(key) ?? Promise.resolve()) as Promise<unknown>;
  const next = prev.then(() => op(), () => op());  // chain regardless of prior outcome
  seenLogMutexes.set(key, next);
  try {
    return await next;
  } finally {
    // Only clear the slot if it's still ours — a concurrent caller may have
    // already chained a new promise behind us.
    if (seenLogMutexes.get(key) === next) seenLogMutexes.delete(key);
  }
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
 *  `alreadyLogged` is the existing 7-day log — the pass SKIPS any story already
 *  in it (semantic topic-match, the same judgment the compose step makes). This
 *  is what catches "same story, different wording" that the token-Jaccard
 *  backstop misses. Fail-open: on error, fall back to listing source titles. */
async function summarizeBundleForSeenLog(bundle: NewsBundle, alreadyLogged: string): Promise<string[]> {
  const material = bundle.sources.slice(0, 8).map(s => {
    let domain = '';
    try { domain = new URL(s.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    return `- ${s.title ?? s.url}${s.snippet ? ` — ${s.snippet}` : ''} [${domain}]`;
  }).join('\n');
  if (!material) return [];

  const alreadyBlock = alreadyLogged.trim()
    ? `\nALREADY IN THE LOG (last 7 days) — do NOT re-log any story already covered here, even if worded differently or from a different outlet:\n${alreadyLogged.trim()}\n`
    : '';

  try {
    const res = await getAnthropicClient().messages.create({
      model: NEWS_MODEL,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `These news items were just surfaced to the owner. Write a SHORT topic-level log so we don't repeat the same story (even from another outlet) over the next week.

ITEMS:
${material}
${alreadyBlock}
Output one line per distinct STORY that is NOT already in the log above (cluster outlets covering the same story into one line), format exactly:
• <topic/headline> — <one-line gist> [<source domain>]
If every item is already logged, output nothing. No preamble, max 6 lines.`,
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

/** Append today's SHOWN items to the seen-log and prune days >7d old.
 *  Fire-and-forget by callers. Non-fatal on any error.
 *
 *  v3.3.x — `opts.briefText` is the posted brief. When given, we log ONLY the
 *  sources actually CITED in it (their url appears in the text), NOT the whole
 *  gathered bundle. This is the load-bearing fix for the re-pull model: the
 *  seen-log is a "don't repeat what he SAW" list, so a gathered-but-unshown
 *  article is NOT marked seen and resurfaces on tomorrow's re-pull (deduped vs
 *  what he did see) until shown or it ages out of the recency window. Without
 *  briefText (the on-demand pull path) we log the bundle as before — the owner
 *  engaged with that topic, so suppressing repeats of it is correct. */
export async function writeSeenLog(
  profile: UserProfile,
  bundle: NewsBundle,
  opts: { briefText?: string } = {},
): Promise<void> {
  if (!bundle.sources.length) return;
  // Shown-only filter (brief path): keep just the sources cited in the brief.
  let toLog = bundle;
  if (typeof opts.briefText === 'string') {
    const text = opts.briefText;
    // Match by NORMALIZED url, not exact substring. Sonnet cites with the
    // <url|label> Slack form and routinely trims a `?utm_…`, a trailing slash,
    // or http→https — exact `text.includes(s.url)` then misses a shown item,
    // so it's never logged and resurfaces tomorrow as a stale "new" story.
    // Normalize both sides to host+path and compare; keep exact-includes as a
    // fast first pass. (Machine URLs vs machine text — not owner free-text.)
    const textUrls = new Set(
      (text.match(/https?:\/\/[^\s<>|)\]]+/gi) ?? []).map(normalizeUrl),
    );
    const shown = bundle.sources.filter(s => {
      if (!s.url) return false;
      if (text.includes(s.url)) return true;
      return textUrls.has(normalizeUrl(s.url));
    });
    if (shown.length === 0) return; // nothing from this gather was shown → log nothing
    toLog = { ...bundle, sources: shown };
  }
  await withSeenLogLock(profile, async () => {
    try {
      const file = seenLogPath(profile);
      const dir = path.dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const prior = existsSync(file) ? readFileSync(file, 'utf8') : '';

      const today = todayStamp(profile);
      // keepFrom = today (owner-local) minus (SEEN_LOG_DAYS - 1) days
      const keepFrom = DateTime.now()
        .setZone(profile.user.timezone)
        .minus({ days: SEEN_LOG_DAYS - 1 })
        .toFormat('yyyy-MM-dd');

      const pruned = pruneSeenLog(prior, keepFrom);

      // Summarize ONLY the genuinely-new stories — the pass is shown the existing
      // 7-day log and skips anything already covered (semantic match, beats the
      // token-Jaccard backstop on differently-worded repeats). `toLog` is the
      // shown-only subset on the brief path (see the header note).
      const lines = await summarizeBundleForSeenLog(toLog, pruned);
      if (lines.length === 0) return;

      // Merge into today's section if it already exists, else prepend a new one.
      // v3.3.1 (M-5) — match the header as a LINE (anchored regex), not a literal
      // substring. A bullet whose gist happens to contain "## <today>" could
      // otherwise be matched by the old string .replace and corrupt the log.
      const todayHeaderRe = new RegExp(`^## ${today}\\s*$`, 'm');
      let next: string;
      if (todayHeaderRe.test(pruned)) {
        next = pruned.replace(todayHeaderRe, `## ${today}\n${lines.join('\n')}`);
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
  });
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

    // No-topic on-demand asks: derive today's meeting companies from the
    // owner's calendar (READ-ONLY) so the gather mirrors the morning-brief
    // shape. The system-prompt promised "today's meetings" — pre-fix this
    // path didn't compute them and the promise was empty. Skip when a
    // topic is explicit (Sonnet asked for one thing — give them one thing).
    let meetingCompanies: string[] | undefined;
    if (!topic) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getCalendarEvents } = require('../connectors/graph/calendar') as
          typeof import('../connectors/graph/calendar');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { extractMeetingCompaniesFromEvents } = require('../tasks/briefs') as
          typeof import('../tasks/briefs');
        const todayLocal = DateTime.now().setZone(context.profile.user.timezone).toFormat('yyyy-MM-dd');
        const events = await getCalendarEvents(
          context.profile.user.email,
          todayLocal,
          todayLocal,
          context.profile.user.timezone,
        );
        meetingCompanies = extractMeetingCompaniesFromEvents(events, context.profile);
      } catch (err) {
        logger.warn('news on-demand: meetingCompanies derivation failed — continuing without', {
          err: String(err).slice(0, 160),
        });
      }
    }

    const bundle = await gatherNews(context.profile, {
      topic,
      meetingCompanies,
      recencyDays: NEWS_ONDEMAND_RECENCY_DAYS,
    });
    // Fire-and-forget: log what we surfaced so the next ask/brief dedupes it.
    // The on-demand path can't pass briefText (Sonnet composes the reply AFTER
    // this tool returns), so we can't shown-filter precisely. Cap the logged
    // set to the same relevance ceiling Sonnet is told to surface (7) — logging
    // the full ≤15-item bundle would suppress unshown items for 7 days, the
    // inverse of the brief-path shown-only discipline.
    const ondemandToLog = { ...bundle, sources: bundle.sources.slice(0, NEWS_ONDEMAND_LOG_CEILING) };
    void writeSeenLog(context.profile, ondemandToLog).catch(() => { /* non-fatal */ });
    return {
      goals: bundle.goals,
      sources: bundle.sources,
      note: bundle.sources.length === 0
        ? 'No fresh sources came back. Say so plainly in one short line — matter-of-fact, NOT an apology, NOT a long explanation — and move on. Do not fabricate.'
        : 'Write GROUNDED in these sources and CITE each with a Slack hyperlink <url|short label> (NOT a bare URL, NOT [link] followed by the URL). RELEVANCE is the bar — surface only items genuinely relevant to him, up to 7; never pad to a count (1 good beats 5 fillers). Skip anything older than 7 days or already in the "already covered" log. Do not assert any current-events fact not present here.',
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
- Source steer + interests live in his news.md (taught via update_my_preferences). The whole file is owner free-text — when his preferences (preferred outlets, sources to skip, focus areas) appear there, weigh them at compose time. Code does NOT parse the file.${seenLog}${prefs}`.trim();
  }
}
