/**
 * KnowledgeBaseSkill (v1.7.4) — togglable, file-based knowledge for Maelle.
 *
 * Purpose: give Maelle real depth on the company / domain without bloating
 * every prompt. Owner drops markdown files into `config/users/<name>_kb/`
 * (auto-discovered), Maelle pulls them on demand via `get_company_knowledge`
 * when a meeting / question / summary needs context.
 *
 * What's always loaded (when skill is active): a SHORT catalog listing
 * available section paths (~80 tokens). What's loaded on demand: the actual
 * markdown file content (~500-1500 words per section, fetched only when called).
 *
 * Profile YAML key: `knowledge_base: true`. Default false.
 *
 * Dir layout (per-user, gitignored along with the rest of config/users/):
 *   config/users/<name>_kb/
 *     reflectiz/
 *       product.md
 *       customers.md
 *       market.md
 *       use_cases.md
 *       voice.md
 *     team/
 *       leadership.md
 *       culture.md
 *     README.md            ← optional, owner can describe their own structure
 *
 * Section ID = relative path without the `.md` (e.g. "reflectiz/product").
 * Auto-discovered on every tool call (cheap — small file count, owner edits
 * propagate immediately, no restart needed).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import { promises as fs } from 'fs';
import path from 'path';
import logger from '../utils/logger';

// Hard cap so a runaway large file doesn't dump 50k tokens into the prompt.
const MAX_SECTION_BYTES = 32 * 1024; // 32 KB ≈ ~6-8k tokens worst case

function kbRootForProfile(profile: UserProfile): string {
  // Map profile.user.name first-token to the kb dir name so it matches the
  // owner's profile yaml filename convention (idan.yaml → idan_kb).
  const firstName = profile.user.name.split(' ')[0].toLowerCase();
  return path.resolve(process.cwd(), 'config', 'users', `${firstName}_kb`);
}

interface KbSection {
  id: string;          // "reflectiz/product"
  relPath: string;     // "reflectiz/product.md"
  size: number;        // bytes
}

/** Walk the kb dir recursively, return all .md files as section descriptors. */
async function listSections(profile: UserProfile): Promise<KbSection[]> {
  const root = kbRootForProfile(profile);
  const out: KbSection[] = [];

  async function walk(dir: string, relPrefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir doesn't exist — empty KB
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
        try {
          const stat = await fs.stat(full);
          out.push({
            id: rel.replace(/\.md$/, ''),
            relPath: rel,
            size: stat.size,
          });
        } catch { /* skip */ }
      }
    }
  }

  await walk(root, '');
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Read a section by id, with safe-path enforcement (no `..` escape). */
async function readSection(profile: UserProfile, sectionId: string): Promise<{ content: string; bytes: number } | { error: string }> {
  // Reject path traversal attempts
  if (sectionId.includes('..') || sectionId.startsWith('/') || sectionId.includes('\\')) {
    return { error: 'invalid_section_id' };
  }
  const root = kbRootForProfile(profile);
  const full = path.resolve(root, `${sectionId}.md`);
  // Belt-and-suspenders: ensure the resolved path is still inside the root
  if (!full.startsWith(root)) {
    return { error: 'path_outside_kb' };
  }
  try {
    const stat = await fs.stat(full);
    if (stat.size > MAX_SECTION_BYTES) {
      return { error: `section_too_large: ${stat.size} bytes (max ${MAX_SECTION_BYTES})` };
    }
    const content = await fs.readFile(full, 'utf-8');
    return { content, bytes: stat.size };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { error: 'section_not_found' };
    return { error: String(err) };
  }
}

/**
 * Public helper for SummarySkill: given a meeting subject + transcript opening,
 * ask Sonnet which sections (if any) would help ground the summary, then return
 * the concatenated content. Returns empty string when KB is empty / nothing
 * relevant / Sonnet errored. Fail-open by design.
 *
 * Lives here (not in summary.ts) so the cross-skill import is clearly one-way:
 * SummarySkill depends on KB, never the reverse.
 */
export async function selectRelevantKbForMeeting(params: {
  profile: UserProfile;
  meetingSubject: string;
  transcriptOpening: string;
  anthropic: import('@anthropic-ai/sdk').default;
}): Promise<string> {
  const sections = await listSections(params.profile);
  if (sections.length === 0) return '';

  const catalog = sections.map(s => `- ${s.id} (${Math.round(s.size / 100) / 10} KB)`).join('\n');

  const prompt = `OUTPUT FORMAT: a single line of JSON, nothing else. Start with { end with }.
{"sections": ["section_id_1", "section_id_2"]}

You're picking which company knowledge sections would help the assistant write a SHARP summary of the meeting below. Pick 0-3 sections — only ones that would clearly add context. If none would help (e.g. interview meetings, personal scheduling), return {"sections": []}.

AVAILABLE SECTIONS:
${catalog}

MEETING SUBJECT: "${params.meetingSubject}"
TRANSCRIPT OPENING (first ~1000 chars):
"""
${params.transcriptOpening.slice(0, 1000)}
"""

Output ONLY the JSON.`;

  try {
    const resp = await params.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });
    const firstBlock = resp.content[0];
    const raw = (firstBlock && firstBlock.type === 'text' ? firstBlock.text : '').trim();
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    if (!cleaned.startsWith('{')) {
      const m = cleaned.match(/\{[^{}]*"sections"[^{}]*\}/);
      if (m) cleaned = m[0];
    }
    const parsed = JSON.parse(cleaned) as { sections?: unknown };
    const picked = Array.isArray(parsed.sections)
      ? (parsed.sections as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];

    if (picked.length === 0) {
      logger.info('KB selector — no sections relevant to this meeting', {
        subject: params.meetingSubject.slice(0, 80),
        availableCount: sections.length,
      });
      return '';
    }

    const fetched: string[] = [];
    for (const id of picked) {
      const r = await readSection(params.profile, id);
      if ('content' in r) {
        fetched.push(`### KB section: ${id}\n${r.content.trim()}`);
      } else {
        logger.info('KB selector — picked section unreadable', { id, error: r.error });
      }
    }

    if (fetched.length === 0) return '';

    logger.info('KB selector — sections fetched for meeting', {
      subject: params.meetingSubject.slice(0, 80),
      sections: picked,
    });
    return `\n\nCOMPANY KNOWLEDGE (relevant to this meeting):\n${fetched.join('\n\n')}\n`;
  } catch (err) {
    logger.warn('KB selector — failed, proceeding without KB', { err: String(err) });
    return '';
  }
}

// ── Skill ───────────────────────────────────────────────────────────────────

export class KnowledgeBaseSkill implements Skill {
  id = 'knowledge_base' as const;
  name = 'Knowledge Base';
  description = 'Owner-curated knowledge files (company, product, team, domain) that Maelle pulls on demand for richer context in meetings, summaries, research, and chat.';

  getTools(_profile: UserProfile): Anthropic.Tool[] {
    return [
      {
        name: 'list_company_knowledge',
        description: `List all available knowledge sections in the owner's KB. Returns section IDs you can pass to get_company_knowledge. Cheap — call any time you're not sure what's available before a meeting summary, research task, or deeper company question.`,
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'get_company_knowledge',
        description: `Fetch the full content of one knowledge section by ID (e.g. "reflectiz/product", "team/leadership"). Use when:
- Owner asks something specific about the company / product / team
- You're drafting a summary for a product/strategy/customer/competitive meeting
- Doing research that needs grounding in real company facts
- Answering "what do you know about X" with real depth

Don't pull every section by default — just the ones relevant to the current task. Section content is freeform markdown; use it as background, don't quote verbatim large chunks.`,
        input_schema: {
          type: 'object',
          properties: {
            section_id: {
              type: 'string',
              description: 'Section identifier from list_company_knowledge, e.g. "reflectiz/product"',
            },
          },
          required: ['section_id'],
        },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    switch (toolName) {
      case 'list_company_knowledge': {
        const sections = await listSections(context.profile);
        return {
          ok: true,
          count: sections.length,
          sections: sections.map(s => ({ id: s.id, size_bytes: s.size })),
          _note: sections.length === 0
            ? 'KB is empty. Tell the owner there\'s no knowledge base content yet — they can add markdown files under config/users/<name>_kb/.'
            : 'These are the sections available. Call get_company_knowledge(section_id) to fetch any relevant section.',
        };
      }

      case 'get_company_knowledge': {
        const sectionId = String(args.section_id ?? '').trim();
        if (!sectionId) return { ok: false, error: 'missing_section_id' };
        const r = await readSection(context.profile, sectionId);
        if ('error' in r) {
          logger.info('KB section read failed', { sectionId, error: r.error });
          return { ok: false, error: r.error, section_id: sectionId };
        }
        logger.info('KB section read', { sectionId, bytes: r.bytes });
        return {
          ok: true,
          section_id: sectionId,
          content: r.content,
          bytes: r.bytes,
        };
      }

      default:
        return null;
    }
  }

  getSystemPromptSection(profile: UserProfile): string {
    // Lightweight catalog rendered inline so Sonnet sees what's available without
    // having to call list_company_knowledge first. Cheap — we re-read the dir
    // listing on every prompt build (small filesystem op, fresh as the owner edits).
    // We don't fetch CONTENT here — only IDs. Content fetched on demand via tool.
    let catalogLine: string;
    try {
      // Synchronous-ish version for prompt build path. We can't `await` here in
      // a sync function, so use the simpler sync fs API for the catalog only.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fsSync = require('fs') as typeof import('fs');
      const root = kbRootForProfile(profile);
      const collected: string[] = [];

      function walkSync(dir: string, relPrefix: string): void {
        let entries: import('fs').Dirent[];
        try {
          entries = fsSync.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
          if (e.isDirectory()) walkSync(path.join(dir, e.name), rel);
          else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') {
            collected.push(rel.replace(/\.md$/, ''));
          }
        }
      }
      walkSync(root, '');
      collected.sort();
      catalogLine = collected.length > 0
        ? collected.join(', ')
        : '(empty — owner has not added any knowledge files yet)';
    } catch {
      catalogLine = '(catalog unavailable)';
    }

    const ownerFirst = profile.user.name.split(' ')[0];
    return `## KNOWLEDGE BASE

${ownerFirst} maintains a small library of markdown knowledge files (company, product, team, domain). Catalog of available sections:
  ${catalogLine}

When to pull a section (call get_company_knowledge):
- ${ownerFirst} asks something specific about the company, product, customers, market, team
- You're drafting a meeting summary touching product/strategy/customers/competitors
- Research tasks that need real company grounding
- "What do you know about X" — pull the relevant section before answering

Don't auto-pull on every turn. Pull only what's relevant. Use the content as BACKGROUND — synthesize, don't quote large chunks. Sections are freeform markdown; treat them as the ${ownerFirst}-curated source of truth for what they say about the company.

If the catalog is empty: don't pretend you have depth. Tell ${ownerFirst} the KB is empty and what kind of files would help.`;
  }
}
