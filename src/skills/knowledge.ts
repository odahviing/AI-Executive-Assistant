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
 * Profile YAML key: `knowledge: true`. Default false. (Legacy alias `knowledge_base` still parses.)
 *
 * Dir layout (per-user, gitignored along with the rest of config/users/):
 *   config/users/<name>_kb/
 *     company/
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
 * Section ID = relative path without the `.md` (e.g. "company/product").
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
  id: string;          // e.g. "company/product"
  relPath: string;     // e.g. "company/product.md"
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

// ── Write side — ingest pipeline (v2.0.2) ───────────────────────────────────

/** Safe-path write, mkdir -p as needed. Rejects traversal / absolute paths. */
async function writeSection(profile: UserProfile, sectionId: string, content: string): Promise<void> {
  if (sectionId.includes('..') || sectionId.startsWith('/') || sectionId.includes('\\')) {
    throw new Error('invalid_section_id');
  }
  const root = kbRootForProfile(profile);
  const full = path.resolve(root, `${sectionId}.md`);
  if (!full.startsWith(root)) throw new Error('path_outside_kb');
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
}

async function sectionExists(profile: UserProfile, sectionId: string): Promise<boolean> {
  const root = kbRootForProfile(profile);
  const full = path.resolve(root, `${sectionId}.md`);
  if (!full.startsWith(root)) return false;
  try { await fs.stat(full); return true; } catch { return false; }
}

/** Pick a non-colliding sibling id: investors/fulcrum → investors/fulcrum_2. */
async function nextSiblingId(profile: UserProfile, baseId: string): Promise<string> {
  for (let n = 2; n < 50; n++) {
    const candidate = `${baseId}_${n}`;
    if (!(await sectionExists(profile, candidate))) return candidate;
  }
  return `${baseId}_${Date.now()}`;
}

export interface IngestResult {
  kind: 'created' | 'merged' | 'sibling' | 'ambiguous' | 'rejected';
  sectionId?: string;
  title?: string;
  summary?: string;
  mergedInto?: string;    // when kind=merged
  question?: string;      // when kind=ambiguous
  reason?: string;        // when kind=rejected
}

/**
 * Ingest a knowledge document into the owner's KB.
 *
 * Single Sonnet pass: classify (transcript/doc/other), propose section_id,
 * title, one-line summary, condensed markdown, and — if an existing section
 * looks like a match — whether to merge or file as sibling. Writes the file
 * and returns the result for the caller to narrate to the owner.
 *
 * Fails closed on low confidence (kind='ambiguous'): asks the owner rather
 * than misfiling.
 */
export async function ingestKnowledgeDoc(params: {
  profile: UserProfile;
  text: string;           // extracted text (raw)
  sourceHint: string;     // filename, URL, or "pasted text"
  ownerCaption?: string;  // text the owner typed alongside the upload, if any
  anthropic: import('@anthropic-ai/sdk').default;
}): Promise<IngestResult> {
  const trimmed = params.text.trim();
  if (trimmed.length < 50) {
    return { kind: 'rejected', reason: 'too_short' };
  }

  const existingSections = await listSections(params.profile);
  const catalog = existingSections.length > 0
    ? existingSections.map(s => `- ${s.id}`).join('\n')
    : '(KB is currently empty)';

  const sample = trimmed.length > 24000 ? trimmed.slice(0, 24000) + '\n\n[Truncated for classification — full text preserved for storage]' : trimmed;

  const prompt = `You are the knowledge librarian for ${params.profile.user.name}. A document arrived. Decide what to do with it.

EXISTING KB SECTIONS:
${catalog}

SOURCE: ${params.sourceHint}
${params.ownerCaption ? `OWNER SAID: "${params.ownerCaption.trim()}"` : ''}

CONTENT:
"""
${sample}
"""

Call the \`classify_document\` tool with your verdict. DO NOT include the condensed content here — only metadata. A separate call handles content.

GUIDANCE:
- kind=transcript: dialogue / multi-speaker / meeting recording. Caller routes to the summary flow.
- kind=other: receipts, random screenshots, personal stuff — not durable knowledge.
- kind=knowledge_doc: investor memos, product docs, customer research, team profiles, strategy docs, market research, contracts, company pages.
- action=merge when the content UPDATES or EXPANDS an existing section on the same topic.
- action=sibling when it's related-but-distinct (existing "investors/fulcrum" + a DIFFERENT investor → sibling named differently).
- action=create when no existing section is close enough.
- confidence=low when content is ambiguous — caller asks the owner rather than misfile.`;

  // Stage 1: classify + propose metadata. Small tool_use payload — no big
  // markdown strings, so no risk of the SDK hitting malformed JSON in the
  // streamed arg output (which was the v2.0.2 crash cause).
  let verdict: any;
  try {
    const resp = await params.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      tools: [{
        name: 'classify_document',
        description: 'Classify the document and propose where to file it. Metadata only — no content.',
        input_schema: {
          type: 'object' as const,
          properties: {
            kind: { type: 'string', enum: ['knowledge_doc', 'transcript', 'other'] },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            section_id: { type: 'string', description: 'snake_case/slug/path, nested with / allowed (e.g. "investors/fulcrum"). Only for knowledge_doc.' },
            title: { type: 'string', description: 'Short human title. Only for knowledge_doc.' },
            summary: { type: 'string', description: 'One line describing what the section covers.' },
            action: { type: 'string', enum: ['create', 'merge', 'sibling'] },
            existing_match: { type: 'string', description: 'section_id from catalog when action=merge|sibling, empty string otherwise' },
            reason: { type: 'string', description: 'For transcript/other/low-confidence: explain.' },
          },
          required: ['kind', 'confidence'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify_document' },
      messages: [{ role: 'user', content: prompt }],
    });
    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    if (!toolUse || !toolUse.input) {
      logger.warn('KB ingest — no tool_use block in classify response');
      return { kind: 'rejected', reason: 'classifier_error' };
    }
    verdict = toolUse.input;
  } catch (err) {
    logger.warn('KB ingest — classify call failed', { err: String(err).slice(0, 300) });
    return { kind: 'rejected', reason: 'classifier_error' };
  }

  if (verdict.kind === 'transcript') {
    logger.info('KB ingest — routed to transcript', { source: params.sourceHint, reason: verdict.reason });
    return { kind: 'rejected', reason: 'transcript' };
  }
  if (verdict.kind === 'other') {
    logger.info('KB ingest — classified other', { source: params.sourceHint, reason: verdict.reason });
    return { kind: 'rejected', reason: verdict.reason || 'not_knowledge' };
  }
  if (verdict.confidence === 'low') {
    return { kind: 'ambiguous', question: verdict.reason || 'Not sure where this fits — want to tell me?' };
  }

  const proposedId = String(verdict.section_id || '').trim().replace(/^\/+|\/+$/g, '');
  if (!proposedId || proposedId.includes('..')) {
    return { kind: 'rejected', reason: 'bad_section_id' };
  }

  const title = String(verdict.title || proposedId);
  const summary = String(verdict.summary || '');
  const action = verdict.action === 'merge' || verdict.action === 'sibling' ? verdict.action : 'create';
  const existingMatch = typeof verdict.existing_match === 'string' ? verdict.existing_match : null;

  // Stage 2: generate the condensed markdown as plain text (no JSON wrapping).
  // This avoids the SDK's SyntaxError on malformed tool_use arg JSON that the
  // one-call version hit whenever Sonnet emitted unescaped chars in a long
  // markdown string. Plain text output has no parse risk.
  const contentPrompt = `Write a condensed knowledge-base entry for the following document. Output RAW MARKDOWN ONLY — no JSON, no fences, no preamble.

FILE TITLE: ${title}
TOPIC SUMMARY: ${summary}
SOURCE: ${params.sourceHint}

SOURCE CONTENT:
"""
${sample}
"""

Write:
- A # heading with the title
- 2-6 paragraphs synthesizing the content (NOT a verbatim dump)
- Sub-sections where helpful
- A "## Source excerpts" section with verbatim snippets ONLY for numeric / contractual / quotable facts
- 500-2500 words typical

No JSON. No code fences around the output. Just markdown.`;

  let condensed: string;
  try {
    const resp = await params.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      messages: [{ role: 'user', content: contentPrompt }],
    });
    const firstBlock = resp.content[0];
    const raw = (firstBlock && firstBlock.type === 'text' ? firstBlock.text : '').trim();
    // Strip accidental ```markdown fences if Sonnet ignored the instruction
    condensed = raw.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  } catch (err) {
    logger.warn('KB ingest — content generation failed', { err: String(err).slice(0, 300) });
    return { kind: 'rejected', reason: 'content_generation_error' };
  }
  if (condensed.length < 50) {
    return { kind: 'rejected', reason: 'empty_condensed' };
  }

  if (action === 'merge' && existingMatch && await sectionExists(params.profile, existingMatch)) {
    const prior = await readSection(params.profile, existingMatch);
    if ('content' in prior) {
      const stamp = new Date().toISOString().slice(0, 10);
      const appended = `${prior.content.trimEnd()}\n\n---\n\n## Update (${stamp}) — ${title}\n\n${condensed}\n`;
      await writeSection(params.profile, existingMatch, appended);
      logger.info('KB ingest — merged into existing', { section: existingMatch, source: params.sourceHint });
      return { kind: 'merged', sectionId: existingMatch, title, summary, mergedInto: existingMatch };
    }
  }

  if (action === 'sibling' && existingMatch) {
    const siblingId = await nextSiblingId(params.profile, proposedId);
    const body = `# ${title}\n\n${summary ? `_${summary}_\n\n` : ''}${condensed}\n`;
    await writeSection(params.profile, siblingId, body);
    logger.info('KB ingest — sibling created', { section: siblingId, near: existingMatch, source: params.sourceHint });
    return { kind: 'sibling', sectionId: siblingId, title, summary };
  }

  const finalId = (await sectionExists(params.profile, proposedId))
    ? await nextSiblingId(params.profile, proposedId)
    : proposedId;
  const body = `# ${title}\n\n${summary ? `_${summary}_\n\n` : ''}${condensed}\n`;
  await writeSection(params.profile, finalId, body);
  logger.info('KB ingest — created', { section: finalId, source: params.sourceHint });
  return { kind: 'created', sectionId: finalId, title, summary };
}

// ── Skill ───────────────────────────────────────────────────────────────────

export class KnowledgeBaseSkill implements Skill {
  id = 'knowledge' as const;
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
        description: `Fetch the full content of one knowledge section by ID (e.g. "company/product", "team/leadership"). Use when:
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
              description: 'Section identifier from list_company_knowledge, e.g. "company/product"',
            },
          },
          required: ['section_id'],
        },
      },
      {
        name: 'ingest_knowledge_from_url',
        description: `Save a webpage into the owner's KB. Use when the owner asks you to remember / learn / file / save the contents of a URL — "save this page", "learn about this company", "file this under investors", etc. DO NOT use for one-off research (use web_extract for that). Only use when the owner clearly wants durable storage. Fetches the URL, condenses, files under an appropriate section, handles merge/sibling with existing sections automatically. Returns the filed section id + title so you can tell the owner where it landed.`,
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch and store' },
            owner_hint: { type: 'string', description: 'Optional — what the owner said alongside the URL ("save under investors", "this is our new competitor", etc.). Helps file it in the right place.' },
          },
          required: ['url'],
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

      case 'ingest_knowledge_from_url': {
        const url = String(args.url ?? '').trim();
        const hint = String(args.owner_hint ?? '').trim();
        if (!url) return { ok: false, error: 'missing_url' };
        try {
          const { tavilyExtract } = await import('./general');
          const extracted = await tavilyExtract(url) as { content?: string; url?: string; error?: string };
          if (!extracted.content || extracted.content.trim().length < 50) {
            return { ok: false, error: 'page_unreadable', url, detail: extracted.error || 'no content returned' };
          }
          const Anthropic = (await import('@anthropic-ai/sdk')).default;
          const anthropic = new Anthropic();
          const result = await ingestKnowledgeDoc({
            profile: context.profile,
            text: extracted.content,
            sourceHint: extracted.url || url,
            ownerCaption: hint || undefined,
            anthropic,
          });
          if (result.kind === 'rejected') {
            return { ok: false, error: 'rejected', reason: result.reason, url };
          }
          if (result.kind === 'ambiguous') {
            return { ok: true, kind: 'ambiguous', question: result.question, url };
          }
          return {
            ok: true,
            kind: result.kind,
            section_id: result.sectionId,
            title: result.title,
            summary: result.summary,
            merged_into: result.mergedInto,
            url: extracted.url || url,
          };
        } catch (err) {
          logger.warn('KB ingest_from_url failed', { err: String(err).slice(0, 300), url });
          return { ok: false, error: 'ingest_failed', detail: String(err).slice(0, 200), url };
        }
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
