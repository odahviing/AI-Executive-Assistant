/**
 * People memory (v2.2.1) — per-person markdown files.
 *
 * Operational facts about people live here: residence, workplace, working
 * hours, communication style, how Maelle should talk to them. Same pattern as
 * KnowledgeBaseSkill (config/users/<owner>_kb/) — a cheap catalog is injected
 * into the prompt at every turn, and Maelle calls get_person_memory(<name>)
 * on demand when a turn needs the detail.
 *
 * Rationale:
 *   - Prompts don't bloat with every person's full profile.
 *   - Owner can read/edit files directly.
 *   - Owner is treated as "just another person" (idan.md) — no special path.
 *   - Empty-until-real-fact: no file materializes until a real fact lands.
 *
 * Split with SQLite:
 *   - Md files hold qualitative facts (where they live, how they work, what
 *     we've discussed) — LLM context.
 *   - people_memory rows still hold gender, timezone, engagement_rank,
 *     interaction_log, last_seen, email — fields that CODE paths read
 *     deterministically. Not context, state.
 */

import type { UserProfile } from '../config/userProfile';
import { promises as fs, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import logger from '../utils/logger';

const MAX_FILE_BYTES = 32 * 1024; // 32 KB per person — plenty, still bounded

const SECTION_TEMPLATE = [
  '## Residence',
  '',
  '## Workplace',
  '',
  '## Working hours',
  '',
  '## Communication style',
  '',
  '## What we\'ve discussed',
  '',
].join('\n');

export interface PersonFile {
  slug: string;          // "amazia-cohen"
  displayName: string;   // "Amazia Cohen"
  relPath: string;       // "amazia-cohen.md"
  sizeBytes: number;
  sections: string[];    // h2 headers actually present with content (empty headers excluded)
}

function rootForProfile(profile: UserProfile): string {
  const firstName = profile.user.name.split(' ')[0].toLowerCase();
  return path.resolve(process.cwd(), 'config', 'users', `${firstName}_people`);
}

/** Normalize a person name into a stable filename slug. */
export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'unknown';
}

function ensureDir(dir: string): Promise<void> {
  return fs.mkdir(dir, { recursive: true }).then(() => undefined);
}

/** Parse h2 headers that have non-empty content under them. */
function extractNonEmptySections(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const out: { header: string; hasContent: boolean }[] = [];
  let current: { header: string; hasContent: boolean } | null = null;
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      if (current) out.push(current);
      current = { header: h2[1], hasContent: false };
    } else if (current && line.trim().length > 0) {
      current.hasContent = true;
    }
  }
  if (current) out.push(current);
  return out.filter(s => s.hasContent).map(s => s.header);
}

/** List every people-memory file the owner has, with a short "what's in it" hint. */
export async function listPersonFiles(profile: UserProfile): Promise<PersonFile[]> {
  const root = rootForProfile(profile);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: PersonFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') continue;
    const full = path.join(root, entry.name);
    try {
      const stat = await fs.stat(full);
      const content = await fs.readFile(full, 'utf-8');
      const displayName = extractDisplayName(content) ?? entry.name.replace(/\.md$/, '');
      out.push({
        slug: entry.name.replace(/\.md$/, ''),
        displayName,
        relPath: entry.name,
        sizeBytes: stat.size,
        sections: extractNonEmptySections(content),
      });
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The first line convention: `# <Display Name>` at the top of each file.
 * Owner can override display by editing that line; slug stays immutable.
 */
function extractDisplayName(md: string): string | null {
  const first = md.split(/\r?\n/, 1)[0] ?? '';
  const m = /^#\s+(.+?)\s*$/.exec(first);
  return m ? m[1] : null;
}

function safeResolve(root: string, slug: string): string | null {
  if (!slug || slug.includes('..') || slug.startsWith('/') || slug.includes('\\') || slug.includes('\0')) {
    return null;
  }
  const full = path.resolve(root, `${slug}.md`);
  return full.startsWith(root) ? full : null;
}

/**
 * Resolve a user-supplied person string ("Amazia", "amazia-cohen", slack id,
 * first name) to an existing file slug. Best-effort — returns null if nothing
 * matches. Owner can always fall back to listing the catalog.
 */
export async function resolvePersonSlug(profile: UserProfile, query: string): Promise<string | null> {
  if (!query) return null;
  const files = await listPersonFiles(profile);
  if (files.length === 0) return null;

  const q = query.trim().toLowerCase();
  const qSlug = slugifyName(query);

  // Exact slug match
  const bySlug = files.find(f => f.slug === qSlug);
  if (bySlug) return bySlug.slug;

  // Exact display name match
  const byName = files.find(f => f.displayName.toLowerCase() === q);
  if (byName) return byName.slug;

  // Starts-with on slug or display first name
  const byPrefix = files.find(f =>
    f.slug.startsWith(qSlug) ||
    f.displayName.toLowerCase().split(/\s+/)[0] === q,
  );
  if (byPrefix) return byPrefix.slug;

  return null;
}

/** Read a person's md file. Returns null when the file doesn't exist. */
export async function readPersonMemory(profile: UserProfile, slug: string): Promise<string | null> {
  const root = rootForProfile(profile);
  const full = safeResolve(root, slug);
  if (!full) return null;
  try {
    const stat = await fs.stat(full);
    if (stat.size > MAX_FILE_BYTES) {
      logger.warn('person memory file too large — truncating read', { slug, bytes: stat.size });
    }
    const content = await fs.readFile(full, 'utf-8');
    return content.slice(0, MAX_FILE_BYTES);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write or replace a section in a person's md file. Creates the file from the
 * section template when it doesn't exist (first real fact — no earlier seed).
 *
 * `section` is the h2 header ("Residence", "Workplace", etc). If the header
 * already exists in the file, its body is REPLACED. Otherwise the section is
 * APPENDED to the end.
 *
 * `text` is the section body — plain markdown, as many lines as needed.
 */
export async function writePersonSection(params: {
  profile: UserProfile;
  slug: string;
  displayName: string;
  section: string;
  text: string;
}): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const { profile, slug, displayName, section, text } = params;
  if (!slug) return { ok: false, error: 'empty_slug' };
  if (!section.trim()) return { ok: false, error: 'empty_section' };

  const root = rootForProfile(profile);
  const full = safeResolve(root, slug);
  if (!full) return { ok: false, error: 'invalid_slug' };

  await ensureDir(root);

  let existing: string | null = null;
  try {
    existing = await fs.readFile(full, 'utf-8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return { ok: false, error: String(err) };
  }

  const created = existing === null;
  const base: string = created
    ? `# ${displayName}\n\n${SECTION_TEMPLATE}`
    : existing!;

  const updated = upsertSection(base, section.trim(), text.trimEnd());
  await fs.writeFile(full, updated, 'utf-8');
  logger.info('Person memory section written', { slug, section, created });
  return { ok: true, created };
}

function upsertSection(md: string, section: string, text: string): string {
  const lines = md.split(/\r?\n/);
  const headerPattern = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`, 'i');

  // Find existing section range
  let startIdx = -1;
  let endIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (headerPattern.test(lines[i])) {
      startIdx = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^##\s+/.test(lines[j])) { endIdx = j; break; }
      }
      break;
    }
  }

  if (startIdx === -1) {
    // Append new section at end, with blank line separator
    const trimmed = md.replace(/\s+$/, '');
    return `${trimmed}\n\n## ${section}\n${text ? `\n${text}\n` : '\n'}`;
  }

  // Replace body between startIdx+1 and endIdx
  const before = lines.slice(0, startIdx + 1);
  const after = lines.slice(endIdx);
  const body = text ? ['', text, ''] : [''];
  return [...before, ...body, ...after].join('\n');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sync variant of the catalog builder — used by the system-prompt builder
 * which is synchronous (same pattern as KnowledgeBaseSkill's KB catalog).
 * Never throws; returns empty string on any fs error.
 */
export function formatPeopleCatalogSync(profile: UserProfile): string {
  const root = rootForProfile(profile);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return '';
  }
  const files: PersonFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.md') || name === 'README.md') continue;
    const full = path.join(root, name);
    try {
      const stat = statSync(full);
      const content = readFileSync(full, 'utf-8');
      const displayName = extractDisplayName(content) ?? name.replace(/\.md$/, '');
      files.push({
        slug: name.replace(/\.md$/, ''),
        displayName,
        relPath: name,
        sizeBytes: stat.size,
        sections: extractNonEmptySections(content),
      });
    } catch { /* skip */ }
  }
  if (files.length === 0) return '';
  files.sort((a, b) => a.slug.localeCompare(b.slug));

  const ownerSlugs = new Set([slugifyName(profile.user.name), slugifyName(profile.user.name.split(' ')[0])]);
  const lines = files.map(f => {
    const ownerTag = ownerSlugs.has(f.slug) ? ' — you' : '';
    const sectionHint = f.sections.length > 0 ? ` [${f.sections.join(', ')}]` : ' [empty]';
    return `- ${f.slug} (${f.displayName}${ownerTag})${sectionHint}`;
  });
  return [
    'PEOPLE NOTES (markdown files, one per person — call get_person_memory(<slug-or-name>) to load full content):',
    ...lines,
    '',
    'Use update_person_memory(<slug-or-name>, <section>, <text>) whenever you learn a durable fact about someone — where they live, where they work, working hours, communication style, anything that helps you be a better assistant to them. One-off social moments go through note_about_person / note_about_self as before. Empty-until-real-fact — no file exists until you write the first real fact.',
  ].join('\n');
}
