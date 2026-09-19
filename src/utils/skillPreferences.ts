/**
 * Per-skill owner preferences — free-text markdown, injected into the prompt
 * surface that owns each area (see PREF_INJECTION_SITE below).
 *
 * This is the STYLE layer, the deliberate opposite of the process layer:
 *   - Process layer (yaml + code + base prompt): general good practice, shipped
 *     to every tenant, enforced by code. Tenant-neutral.
 *   - Style layer (THIS): one MD file per skill under
 *     `config/users/<owner>_prefs/<skill>.md`. Free text, the owner's personal
 *     style, taught and edited entirely by chat (`update_my_preferences`). Never
 *     shipped — lives in the owner's private config dir. The LLM reads and
 *     honors it; code does not parse it. A second owner's dir is empty and fills
 *     with THEIR style.
 *
 * Cost discipline: a block rides along ONLY on turns where its area is already
 * in play (the same scope predicate the skill's own prose uses). A fresh owner
 * (no file) pays zero tokens.
 *
 * Mirrors the people-memory / KB md conventions (config/users/<owner>_*).
 */

import type { UserProfile } from '../config/userProfile';
import { promises as fs, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import logger from './logger';

const MAX_FILE_BYTES = 16 * 1024; // 16 KB per skill — plenty for free-text style

// Per-file write mutex. Preference calls bypass the tool cache so reads and
// revision conflicts remain fresh; retries are handled here. The lock keeps
// read/check/write atomic among in-process writers. Atomic rename also keeps
// prompt readers from seeing a partially written file.
const writeMutexes = new Map<string, Promise<unknown>>();
async function withWriteLock<T>(key: string, op: () => Promise<T>): Promise<T> {
  const prev = (writeMutexes.get(key) ?? Promise.resolve()) as Promise<unknown>;
  const next = prev.then(() => op(), () => op());
  writeMutexes.set(key, next);
  try {
    return await next;
  } finally {
    if (writeMutexes.get(key) === next) writeMutexes.delete(key);
  }
}

// Allowlist of skill areas a preference file may target. Keeps the edit tool
// from writing arbitrary paths and keeps `skill` a stable, small vocabulary.
// 'general' is the cross-cutting voice/addressing file (injected into the base
// prompt area, not a single skill).
export const PREF_SKILLS = [
  'general',
  'calendar',
  'meetings',
  'brief',
  'news',
  'summary',
  'social',
  'knowledge',
  'search',
  'venue',
] as const;
export type PrefSkill = (typeof PREF_SKILLS)[number];

export function isPrefSkill(s: string): s is PrefSkill {
  return (PREF_SKILLS as readonly string[]).includes(s);
}

/** Primary rendering site per area. Independent skill composers also read
 * their own file: summary draft/revision, news planning and briefing news. */
export type PrefInjectionSite =
  | 'system-prompt'   // rendered by buildSystemPromptParts (owner path, scope-gated)
  | 'skill-section'   // rendered inside that skill's own getSystemPromptSection
  | 'brief-compose';  // rendered in the daily-brief compose pass, not the turn prompt

/**
 * The primary reader for every writable area.
 *
 * A writable area with NO reader silently discards what the owner taught while
 * `update_my_preferences` still confirms it as saved — which is exactly what
 * happened to seven of these ten (the owner re-taught his news topics after the
 * first save landed in an unread `general.md`). `Record<PrefSkill, …>` makes the
 * omission a COMPILE error: you cannot add an area without naming who reads it.
 */
export const PREF_INJECTION_SITE: Record<PrefSkill, PrefInjectionSite> = {
  general:   'system-prompt',
  calendar:  'skill-section',   // src/skills/calendarHealth.ts
  meetings:  'system-prompt',
  brief:     'brief-compose',   // src/tasks/briefs.ts
  news:      'skill-section',   // src/skills/news.ts
  summary:   'system-prompt',
  social:    'system-prompt',
  knowledge: 'system-prompt',
  search:    'system-prompt',
  venue:     'system-prompt',
};

function rootForProfile(profile: UserProfile): string {
  const firstName = profile.user.name.split(' ')[0].toLowerCase();
  return path.resolve(process.cwd(), 'config', 'users', `${firstName}_prefs`);
}

function fileForSkill(profile: UserProfile, skill: string): string | null {
  const root = rootForProfile(profile);
  // Hard sanitize — only the allowlisted ids, lowercased, no path parts.
  const id = skill.trim().toLowerCase();
  if (!isPrefSkill(id)) return null;
  const target = path.resolve(root, `${id}.md`);
  if (!target.startsWith(root)) return null; // path-traversal guard
  return target;
}

/**
 * Read a skill's preference text (sync — used during prompt assembly).
 * Returns '' when no file exists or it's empty.
 */
export function readSkillPreferences(profile: UserProfile, skill: string): string {
  const result = readSkillPreferencesSnapshot(profile, skill);
  return result.ok ? result.text.trim() : '';
}

export interface SkillPreferencesSnapshot {
  text: string;
  revision: string;
  exists: boolean;
}

function snapshot(text: string, exists: boolean): SkillPreferencesSnapshot {
  return { text, revision: createHash('sha256').update(text).digest('hex'), exists };
}

/** An explicit editing read distinguishes unavailable storage from an empty file. */
export function readSkillPreferencesSnapshot(
  profile: UserProfile,
  skill: string,
): ({ ok: true } & SkillPreferencesSnapshot) | { ok: false; error: string } {
  const file = fileForSkill(profile, skill);
  if (!file) return { ok: false, error: 'invalid_skill' };
  try {
    return { ok: true, ...snapshot(readFileSync(file, 'utf8'), true) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, ...snapshot('', false) };
    logger.warn('skillPreferences read failed', { skill, err: String(err).slice(0, 160) });
    return { ok: false, error: 'read_failed' };
  }
}

/**
 * Format a skill's preferences as a prompt block, or '' when none exist.
 * Owner-path only — the caller gates on isOwner.
 */
export function formatSkillPreferencesBlock(
  profile: UserProfile,
  skill: string,
  opts: { label?: string } = {},
): string {
  const body = readSkillPreferences(profile, skill);
  if (!body) return '';
  const firstName = profile.user.name.split(' ')[0];
  const label = opts.label ?? skill.toUpperCase();
  return [
    '',
    '─────────────────────────────',
    `${firstName.toUpperCase()}'S ${label} PREFERENCES — he taught these; treat them as standing instructions.`,
    `Honor them over the defaults above when they conflict, UNLESS a hard rule or safety guard blocks it.`,
    body,
  ].join('\n');
}

/**
 * Every preference block the SYSTEM PROMPT is the reader for, concatenated.
 * Owner-path only — the caller gates on isOwner.
 *
 * Same cost discipline as a skill-section block: an area rides along only on a
 * turn where that area is already in play, using the exact predicate every
 * skill section uses for its own prose (`!scopes || 'general' || <area>`), and
 * only while that skill is enabled in the profile. `general` is the
 * cross-cutting voice/addressing file — no skill owns it, so it always renders.
 * A fresh owner (no files) pays zero.
 */
export function formatSystemPromptPreferenceBlocks(
  profile: UserProfile,
  scopes: string[] | undefined,
  activeSkillIds: ReadonlySet<string>,
): string {
  const blocks: string[] = [];
  for (const area of PREF_SKILLS) {
    if (PREF_INJECTION_SITE[area] !== 'system-prompt') continue;
    if (area !== 'general') {
      if (!activeSkillIds.has(area)) continue;
      if (scopes && !scopes.includes('general') && !scopes.includes(area)) continue;
    }
    const block = formatSkillPreferencesBlock(profile, area);
    if (block) blocks.push(block);
  }
  return blocks.join('\n');
}

/**
 * Write a skill's preferences. `add` appends one bullet line; `replace`
 * replaces the full list only against the revision read by the editor. Empty
 * replacement clears the list. Materializes the file on first successful write.
 */
export async function writeSkillPreferences(
  profile: UserProfile,
  skill: string,
  mode: 'add' | 'replace',
  text: string,
  options: { expectedRevision?: string } = {},
): Promise<
  { ok: true; created: boolean; revision: string; duplicate?: boolean; matchedLine?: string; unchanged?: boolean }
  | { ok: false; error: string; current?: SkillPreferencesSnapshot }
> {
  const file = fileForSkill(profile, skill);
  if (!file) return { ok: false, error: 'invalid_skill' };
  const clean = text.trim();
  if (!clean && mode === 'add') return { ok: false, error: 'empty_text' };

  // Serialize read+compute+write per-(profile, skill) so concurrent writes
  // (Sonnet retry double-fire, brief compose racing live update) don't clobber
  // each other. Plus an atomic rename below to make the on-disk swap a single
  // step rather than truncate-then-fill (a reader hitting mid-write otherwise
  // sees a partial file).
  return withWriteLock(file, async () => {
    try {
      let priorFull: string;
      let existed = true;
      try { priorFull = readFileSync(file, 'utf8'); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: 'read_failed' };
        priorFull = '';
        existed = false;
      }
      const current = snapshot(priorFull, existed);
      if (mode === 'replace') {
        if (!options.expectedRevision) return { ok: false, error: 'revision_required', current };
        // A retry after a successful write must not repeat the write or replace
        // the recovery backup. Equality is safe even when its revision is old.
        if (existed && current.text === text) return { ok: true, created: false, revision: current.revision, unchanged: true };
        if (options.expectedRevision !== current.revision) return { ok: false, error: 'revision_conflict', current };
      }

      let next: string;
      if (mode === 'replace') {
        next = text;
        // M-2 (v3.3) — back up before a destructive overwrite. `replace` blows
        // away the whole file; a misfired "full new list" (Sonnet passing a
        // single bullet) would otherwise wipe every preference with no recovery.
        // Best-effort single <file>.bak, restorable by hand.
        if (existed && priorFull.trim()) {
          try { await fs.writeFile(`${file}.bak`, priorFull, 'utf8'); }
          catch (e) { logger.warn('skillPreferences — .bak write failed', { skill, err: String(e).slice(0, 120) }); }
        }
      } else {
        const prior = priorFull.trimEnd();
        // normalize the new line to a single bullet
        const line = clean.replace(/^[-*]\s*/, '').trim();
        // Dedup (v3.x) — skip an append that's substantially the same as an
        // existing line, so re-teaching the same preference is idempotent and the
        // file (and the injected prompt) don't accumulate near-duplicates. Token-
        // set Jaccard ≥ 0.6 counts as a match. To CHANGE a pref, use mode='replace'.
        const norm = (s: string) =>
          s.toLowerCase().replace(/^[-*]\s*/, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
        const newTokens = new Set(norm(line).split(' ').filter(Boolean));
        if (newTokens.size > 0) {
          for (const pl of prior.split('\n')) {
            const t = pl.trim();
            // M-4 (v3.3) — compare against ANY existing content line, not only
            // '-' bullets (a prior `replace` may not have used dashes). Skip
            // blanks and markdown headers.
            if (!t || t.startsWith('#')) continue;
            const plTokens = new Set(norm(t).split(' ').filter(Boolean));
            if (plTokens.size === 0) continue;
            const inter = [...newTokens].filter(x => plTokens.has(x)).length;
            const union = new Set([...newTokens, ...plTokens]).size;
            if (union > 0 && inter / union >= 0.6) {
              logger.info('skillPreferences add — near-duplicate, not appended', {
                skill, similarity: Math.round((inter / union) * 100) / 100,
              });
              // M-5 (v3.3) — surface the matched line so the caller can offer a
              // REPLACE instead of silently dropping a refinement of it.
              return { ok: true, created: false, revision: current.revision, duplicate: true, matchedLine: t };
            }
          }
        }
        next = prior ? `${prior}\n- ${line}` : `- ${line}`;
      }

      if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) {
        return { ok: false, error: 'too_large' };
      }
      const root = rootForProfile(profile);
      if (!existsSync(root)) mkdirSync(root, { recursive: true });
      // Atomic write: stage to <file>.tmp then rename. fs.rename is atomic on
      // the same volume — a concurrent reader sees either the OLD file or the
      // FULL new file, never a half-written one.
      const tmp = `${file}.tmp`;
      const savedText = mode === 'replace' ? next : `${next}\n`;
      await fs.writeFile(tmp, savedText, 'utf8');
      await fs.rename(tmp, file);
      logger.info('skillPreferences write', { skill, mode, created: !existed });
      return { ok: true, created: !existed, revision: snapshot(savedText, true).revision };
    } catch (err) {
      logger.warn('skillPreferences write failed', { skill, mode, err: String(err).slice(0, 160) });
      return { ok: false, error: 'write_failed' };
    }
  });
}
