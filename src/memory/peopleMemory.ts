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
import { promises as fs, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
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

/**
 * Normalize a person name into a filename slug.
 *
 * v3.2.0 — this is now the LEGACY key. Md files are keyed by `person_id`
 * (collision-proof: two people with the same first+last name get distinct
 * files). `slugifyName` is retained only to locate a person's pre-migration
 * file so it can be renamed on first touch (see `migrateLegacyMdIfNeeded`).
 */
export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'unknown';
}

/**
 * v3.2.0 — migrate a person's md file from the legacy name-slug filename to
 * the collision-proof `person_id` filename, lazily, on first write/read. If
 * the person_id file already exists, no-op. If only the legacy file exists,
 * rename it so its history carries over. Non-fatal on any fs error.
 */
async function migrateLegacyMdIfNeeded(root: string, personId: string, displayName: string): Promise<void> {
  try {
    const target = path.resolve(root, `${personId}.md`);
    if (!target.startsWith(root) || existsSync(target)) return;
    const legacySlug = slugifyName(displayName);
    if (!legacySlug || legacySlug === personId) return;
    const legacy = path.resolve(root, `${legacySlug}.md`);
    if (legacy.startsWith(root) && existsSync(legacy)) {
      await fs.rename(legacy, target);
      logger.info('person memory — migrated legacy md filename to person_id', {
        from: `${legacySlug}.md`, to: `${personId}.md`,
      });
    }
  } catch { /* non-fatal — write/read proceeds against person_id */ }
}

function ensureDir(dir: string): Promise<void> {
  return fs.mkdir(dir, { recursive: true }).then(() => undefined);
}

/** Split a person file into its h2 sections (header + raw body). */
function parseSections(md: string): { header: string; body: string }[] {
  const out: { header: string; body: string[] }[] = [];
  let current: { header: string; body: string[] } | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      if (current) out.push(current);
      current = { header: h2[1], body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) out.push(current);
  return out.map(s => ({ header: s.header, body: s.body.join('\n').trim() }));
}

/** Parse h2 headers that have non-empty content under them. */
function extractNonEmptySections(md: string): string[] {
  return parseSections(md).filter(s => s.body.length > 0).map(s => s.header);
}

// A generated history bullet: "- [2026-06-16] Booked …". Structured, generated
// by code (recordBooking / capturePass) — never natural language, so matching it
// is language-independent.
const DATED_BULLET = /^-\s*\[(\d{4}-\d{2}-\d{2})\]/;

/** Union `incoming`'s sections into `base`, line-deduped. Sections made purely
 *  of dated bullets are re-sorted by date so a merged history reads in order. */
function mergeMarkdownSections(base: string, incoming: string): string {
  let out = base;
  for (const section of parseSections(incoming)) {
    if (!section.body) continue;
    const existing = parseSections(out).find(s => s.header.toLowerCase() === section.header.toLowerCase())?.body ?? '';
    const kept = existing.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0);
    const have = new Set(kept.map(l => l.trim()));
    const added = section.body.split(/\r?\n/).map(l => l.trimEnd())
      .filter(l => l.trim().length > 0 && !have.has(l.trim()));
    if (added.length === 0) continue;
    let lines = [...kept, ...added];
    if (lines.every(l => DATED_BULLET.test(l.trim()))) {
      lines = lines.sort((a, b) => DATED_BULLET.exec(a.trim())![1].localeCompare(DATED_BULLET.exec(b.trim())![1]));
    }
    out = upsertSection(out, section.header, lines.join('\n'));
  }
  return out;
}

/**
 * v4.0.4 — fold one person's md file into another's, called by
 * `db/people.mergePersonRows` right after two rows for one human collapse.
 *
 * Without this the loser's `<person_id>.md` is ORPHANED: nothing in the DB
 * points at it any more, but `formatPeopleCatalogSync` reads the DIRECTORY, so
 * the file keeps rendering as a second "Luke Joas" in the prompt catalog — the
 * duplicate we just removed, resurrected one layer up.
 *
 * Profile-independent on purpose (the db layer has no UserProfile): md files are
 * keyed ONLY by person_id, so every `config/users/*_people` directory is swept —
 * which is also what makes it correct multi-tenant.
 *
 * `survivorName` re-titles the file's `# <Display Name>` line ONLY when the file
 * arrives by rename (its h1 is then the merged-away row's name, and the catalog
 * renders h1, so it would show a name the DB no longer knows). A survivor file
 * that already existed keeps its own h1 — that line is the documented
 * owner-editable display override.
 */
export function mergePersonMdFiles(survivorId: string, loserId: string, survivorName?: string): void {
  if (!survivorId || !loserId || survivorId === loserId) return;
  // Both ids are internal surrogates, never user input — belt-and-braces anyway.
  if (/[\\/\0]|\.\./.test(survivorId + loserId)) return;

  const usersRoot = path.resolve(process.cwd(), 'config', 'users');
  let entries: string[];
  try { entries = readdirSync(usersRoot); } catch { return; }

  for (const entry of entries) {
    if (!entry.endsWith('_people')) continue;
    const root = path.resolve(usersRoot, entry);
    const loserPath = path.resolve(root, `${loserId}.md`);
    const survivorPath = path.resolve(root, `${survivorId}.md`);
    if (!loserPath.startsWith(root) || !survivorPath.startsWith(root)) continue;
    if (!existsSync(loserPath)) continue;
    try {
      if (!existsSync(survivorPath)) {
        renameSync(loserPath, survivorPath);
        const name = (survivorName ?? '').trim();
        if (name) {
          const md = readFileSync(survivorPath, 'utf-8');
          if (extractDisplayName(md) !== name) {
            writeFileSync(survivorPath, md.replace(/^#\s+.*$/m, `# ${name}`), 'utf-8');
          }
        }
        logger.info('person memory — md file re-keyed to the surviving person', {
          dir: entry, from: `${loserId}.md`, to: `${survivorId}.md`,
        });
        continue;
      }
      const survivorMd = readFileSync(survivorPath, 'utf-8');
      const mergedMd = mergeMarkdownSections(survivorMd, readFileSync(loserPath, 'utf-8'));
      if (mergedMd !== survivorMd) writeFileSync(survivorPath, mergedMd, 'utf-8');
      unlinkSync(loserPath);
      logger.info('person memory — md files merged', { dir: entry, survivorId, loserId });
    } catch (err) {
      logger.warn('person memory — md merge failed, both files left in place', {
        dir: entry, survivorId, loserId, err: String(err).slice(0, 200),
      });
    }
  }
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
  const root = rootForProfile(profile);

  // 1. The query is already a file key (person_id or a legacy slug) with a file.
  const direct = safeResolve(root, query);
  if (direct && existsSync(direct)) return query;

  // 2. Resolve through the DB to a person_id (no create — this is a lookup).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require('../db') as typeof import('../db');
    const SLACK_ID_RE = /^[UW][A-Z0-9]{6,}$/;
    let row = SLACK_ID_RE.test(query) ? db.getPersonMemory(query) : null;
    if (!row) {
      const matches = db.searchPeopleMemory(query);
      const exact = matches.filter(m => m.name.toLowerCase() === query.trim().toLowerCase());
      row = exact[0] ?? (matches.length === 1 ? matches[0] : null);
    }
    if (row?.person_id) return row.person_id;
  } catch { /* fall through to file-name resolution */ }

  // 3. Legacy fallback — match an existing file by name-slug / display name.
  const files = await listPersonFiles(profile);
  if (files.length === 0) return null;
  const q = query.trim().toLowerCase();
  const qSlug = slugifyName(query);
  const f = files.find(f =>
    f.slug === qSlug
    || f.displayName.toLowerCase() === q
    || f.slug.startsWith(qSlug)
    || f.displayName.toLowerCase().split(/\s+/)[0] === q,
  );
  return f ? f.slug : null;
}

/**
 * Read a person's md file by `person_id`. Returns null when none exists.
 * v3.2.0 — `legacyName` enables reading a not-yet-migrated file still under
 * its old name-slug filename (the rename happens on next write).
 */
export async function readPersonMemory(profile: UserProfile, personId: string, legacyName?: string): Promise<string | null> {
  const root = rootForProfile(profile);
  const candidates = [safeResolve(root, personId)];
  if (legacyName) candidates.push(safeResolve(root, slugifyName(legacyName)));
  for (const full of candidates) {
    if (!full) continue;
    try {
      const stat = await fs.stat(full);
      if (stat.size > MAX_FILE_BYTES) {
        logger.warn('person memory file too large — truncating read', { personId, bytes: stat.size });
      }
      const content = await fs.readFile(full, 'utf-8');
      return content.slice(0, MAX_FILE_BYTES);
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
  }
  return null;
}

/**
 * v2.9.3 (#103) — sync variant of readPersonMemory used by the system-
 * prompt builder (which assembles synchronously). Same shape as the async
 * version; never throws — fs failures return null.
 */
export function readPersonMemorySync(profile: UserProfile, personId: string, legacyName?: string): string | null {
  const root = rootForProfile(profile);
  const candidates = [safeResolve(root, personId)];
  if (legacyName) candidates.push(safeResolve(root, slugifyName(legacyName)));
  for (const full of candidates) {
    if (!full) continue;
    try {
      const stat = statSync(full);
      if (stat.size > MAX_FILE_BYTES) {
        logger.warn('person memory file too large — truncating read', { personId, bytes: stat.size });
      }
      return readFileSync(full, 'utf-8').slice(0, MAX_FILE_BYTES);
    } catch { /* try next candidate */ }
  }
  return null;
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
  personId: string;
  displayName: string;
  section: string;
  text: string;
}): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const { profile, personId, displayName, section, text } = params;
  if (!personId) return { ok: false, error: 'empty_person_id' };
  if (!section.trim()) return { ok: false, error: 'empty_section' };

  const root = rootForProfile(profile);
  const full = safeResolve(root, personId);
  if (!full) return { ok: false, error: 'invalid_person_id' };

  await ensureDir(root);
  // v3.2.0 — carry over a pre-migration file (named by name-slug) before writing.
  await migrateLegacyMdIfNeeded(root, personId, displayName);

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
  logger.info('Person memory section written', { personId, section, created });
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
  files.sort((a, b) => a.displayName.localeCompare(b.displayName));

  // v3.2.0 — files are keyed by person_id now; surface the human display name
  // as the handle (get_person_memory resolves name → person_id via the DB).
  // When two people share a display name, disambiguate with a short id suffix
  // so the handle stays unique.
  const nameCounts = new Map<string, number>();
  for (const f of files) {
    const k = f.displayName.toLowerCase();
    nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1);
  }
  const ownerName = profile.user.name.toLowerCase();
  const lines = files.map(f => {
    const ownerTag = f.displayName.toLowerCase() === ownerName ? ' — you' : '';
    const dupTag = (nameCounts.get(f.displayName.toLowerCase()) ?? 0) > 1 ? ` #${f.slug.slice(-4)}` : '';
    const sectionHint = f.sections.length > 0 ? ` [${f.sections.join(', ')}]` : ' [empty]';
    return `- ${f.displayName}${dupTag}${ownerTag}${sectionHint}`;
  });
  return [
    'PEOPLE NOTES (markdown files, one per person — call get_person_memory(<name>) to load full content):',
    ...lines,
    '',
    'Use update_person_memory(<name>, <section>, <text>) whenever you learn a durable fact about someone — where they live, where they work, working hours, communication style, anything that helps you be a better assistant to them. One-off social moments go through note_about_person / note_about_self as before. Empty-until-real-fact — no file exists until you write the first real fact.',
  ].join('\n');
}
