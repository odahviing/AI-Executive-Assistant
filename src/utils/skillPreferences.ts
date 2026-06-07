/**
 * Per-skill owner preferences — free-text markdown, injected at the bottom of
 * each skill's system-prompt section (v3.3 POC, calendar-health first).
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
 * Cost discipline: the block is appended to a skill's prompt section, which is
 * already scope-gated — so a skill's prefs ride along ONLY on turns where that
 * skill is already in the prompt. A fresh owner (no file) pays zero tokens.
 *
 * Mirrors the people-memory / KB md conventions (config/users/<owner>_*).
 */

import type { UserProfile } from '../config/userProfile';
import { promises as fs, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import logger from './logger';

const MAX_FILE_BYTES = 16 * 1024; // 16 KB per skill — plenty for free-text style

// Per-(profile, skill) write mutex. Sonnet sometimes double-fires a tool call
// on retry (the orchestrator's tool-call cache catches most, not all); also the
// morning brief composes its prompt while a live `update_my_preferences` may
// be writing. Without a lock, the read+compute+write is non-atomic and one
// write clobbers the other. Lock is also the boundary for the `<file>.tmp` →
// rename atomic-replace below.
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
  'summary',
  'social',
  'knowledge',
  'search',
  'venue',
  'news',
] as const;
export type PrefSkill = (typeof PREF_SKILLS)[number];

export function isPrefSkill(s: string): s is PrefSkill {
  return (PREF_SKILLS as readonly string[]).includes(s);
}

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
  try {
    const file = fileForSkill(profile, skill);
    if (!file || !existsSync(file)) return '';
    return readFileSync(file, 'utf8').trim();
  } catch (err) {
    logger.warn('skillPreferences read failed', { skill, err: String(err).slice(0, 160) });
    return '';
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
 * Write a skill's preferences. `add` appends one bullet line; `replace`
 * overwrites the whole file (used to edit or remove — Sonnet passes the full
 * new list). Materializes the dir + file on first write. Non-fatal on fs error.
 */
export async function writeSkillPreferences(
  profile: UserProfile,
  skill: string,
  mode: 'add' | 'replace',
  text: string,
): Promise<{ ok: true; created: boolean; duplicate?: boolean } | { ok: false; error: string }> {
  const file = fileForSkill(profile, skill);
  if (!file) return { ok: false, error: 'invalid_skill' };
  const clean = text.trim();
  if (!clean) return { ok: false, error: 'empty_text' };

  // Serialize read+compute+write per-(profile, skill) so concurrent writes
  // (Sonnet retry double-fire, brief compose racing live update) don't clobber
  // each other. Plus an atomic rename below to make the on-disk swap a single
  // step rather than truncate-then-fill (a reader hitting mid-write otherwise
  // sees a partial file).
  return withWriteLock(file, async () => {
    try {
      const root = rootForProfile(profile);
      if (!existsSync(root)) mkdirSync(root, { recursive: true });
      const existed = existsSync(file);

      let next: string;
      if (mode === 'replace') {
        next = clean;
      } else {
        const prior = existed ? readFileSync(file, 'utf8').trimEnd() : '';
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
            if (!pl.trim().startsWith('-')) continue;
            const plTokens = new Set(norm(pl).split(' ').filter(Boolean));
            if (plTokens.size === 0) continue;
            const inter = [...newTokens].filter(t => plTokens.has(t)).length;
            const union = new Set([...newTokens, ...plTokens]).size;
            if (union > 0 && inter / union >= 0.6) {
              logger.info('skillPreferences add — skipped near-duplicate', {
                skill, similarity: Math.round((inter / union) * 100) / 100,
              });
              return { ok: true, created: false, duplicate: true };
            }
          }
        }
        next = prior ? `${prior}\n- ${line}` : `- ${line}`;
      }

      if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) {
        return { ok: false, error: 'too_large' };
      }
      // Atomic write: stage to <file>.tmp then rename. fs.rename is atomic on
      // the same volume — a concurrent reader sees either the OLD file or the
      // FULL new file, never a half-written one.
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, `${next}\n`, 'utf8');
      await fs.rename(tmp, file);
      logger.info('skillPreferences write', { skill, mode, created: !existed });
      return { ok: true, created: !existed };
    } catch (err) {
      logger.warn('skillPreferences write failed', { skill, mode, err: String(err).slice(0, 160) });
      return { ok: false, error: 'write_failed' };
    }
  });
}
