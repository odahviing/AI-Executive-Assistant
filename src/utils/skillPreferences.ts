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

// Allowlist of skill areas a preference file may target. Keeps the edit tool
// from writing arbitrary paths and keeps `skill` a stable, small vocabulary.
// 'general' is the cross-cutting voice/addressing file (injected into the base
// prompt area, not a single skill).
export const PREF_SKILLS = [
  'general',
  'calendar',
  'meetings',
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
): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const file = fileForSkill(profile, skill);
  if (!file) return { ok: false, error: 'invalid_skill' };
  const clean = text.trim();
  if (!clean) return { ok: false, error: 'empty_text' };

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
      next = prior ? `${prior}\n- ${line}` : `- ${line}`;
    }

    if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) {
      return { ok: false, error: 'too_large' };
    }
    await fs.writeFile(file, `${next}\n`, 'utf8');
    logger.info('skillPreferences write', { skill, mode, created: !existed });
    return { ok: true, created: !existed };
  } catch (err) {
    logger.warn('skillPreferences write failed', { skill, mode, err: String(err).slice(0, 160) });
    return { ok: false, error: 'write_failed' };
  }
}
