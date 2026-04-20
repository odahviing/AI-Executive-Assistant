#!/usr/bin/env node
/**
 * Auto-triage a Bug issue using the Claude Agent SDK.
 *
 * v1.8.2 — PROPOSE-ONLY flow. The agent never edits files directly; it always
 * writes a plan as an issue comment and labels the issue `Proposed`. The owner
 * reviews, then labels `Approved` (triggers auto-build.mjs) or `Revise` (re-runs
 * this script against the full comment history).
 *
 * Invoked by .github/workflows/auto-triage-bug.yml on:
 *   - issue opened with `Bug` label
 *   - `Bug` label added to an existing issue
 *   - `Revise` label added to an issue (re-plan with owner's feedback)
 *
 * What this script does:
 *   1. Reads issue title + body + all prior comments
 *   2. Downloads every image embedded in the body/comments to /tmp/triage-images/
 *   3. Invokes the agent with no pre-injected codebase context — forces it to
 *      investigate from scratch (anti-recency-bias)
 *   4. Agent outputs strict-JSON classification + plan; never edits files
 *   5. Posts plan as a comment, labels `Proposed` (or auto-closes NOT_A_BUG)
 *   6. Removes `Revise` label if present
 *
 * Critical change from v1: there is no SIMPLE auto-fix path. Every real bug
 * gets a plan the owner must approve. Cost: 1 extra click per bug. Benefit:
 * no more wrong auto-fixes shipping unsupervised.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const REPO         = process.env.REPO;
const GH_TOKEN     = process.env.GH_TOKEN;

if (!ISSUE_NUMBER || !REPO || !process.env.ANTHROPIC_API_KEY) {
  console.error('Missing required env: ISSUE_NUMBER, REPO, ANTHROPIC_API_KEY');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

function ghComment(body) {
  const r = spawnSync('gh', ['issue', 'comment', ISSUE_NUMBER, '--repo', REPO, '--body-file', '-'], {
    input: body,
    encoding: 'utf8',
  });
  if (r.status !== 0) console.error('gh comment failed:', r.stderr);
}

function ghLabel(...labels) {
  for (const l of labels) {
    spawnSync('gh', ['issue', 'edit', ISSUE_NUMBER, '--repo', REPO, '--add-label', l], { encoding: 'utf8' });
  }
}

function ghRemoveLabel(label) {
  spawnSync('gh', ['issue', 'edit', ISSUE_NUMBER, '--repo', REPO, '--remove-label', label], { encoding: 'utf8' });
}

function ghClose(reason = 'completed') {
  spawnSync('gh', ['issue', 'close', ISSUE_NUMBER, '--repo', REPO, '--reason', reason], { encoding: 'utf8' });
}

// ── Read the issue + comments ────────────────────────────────────────────────

const issue = JSON.parse(sh(
  `gh issue view ${ISSUE_NUMBER} --repo ${REPO} --json title,body,labels,author,number,url,comments`,
));

console.log(`Triaging issue #${issue.number}: "${issue.title}"`);
const isRevise = issue.labels.some(l => l.name === 'Revise');
if (isRevise) console.log('REVISE mode — re-planning with full comment history');

// ── Download images referenced in the issue + comments ───────────────────────

const IMG_DIR = join(tmpdir(), `triage-${ISSUE_NUMBER}`);
mkdirSync(IMG_DIR, { recursive: true });

// Catches both GitHub user-attachments URLs and the older user-images CDN
const IMG_URL_RE = /https:\/\/(?:github\.com\/user-attachments\/assets|user-images\.githubusercontent\.com)\/[^\s)"'\]<>]+/g;

const allText = [
  issue.body || '',
  ...(issue.comments || []).map(c => c.body || ''),
].join('\n\n');

const imageUrls = Array.from(new Set(allText.match(IMG_URL_RE) || []));
const downloadedImages = []; // { url, path }

async function downloadImage(url, idx) {
  const res = await fetch(url, {
    headers: GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {},
    redirect: 'follow',
  });
  if (!res.ok) {
    console.warn(`  Failed to fetch ${url}: ${res.status}`);
    return null;
  }
  // Best-effort extension from Content-Type
  const ct = res.headers.get('content-type') || '';
  let ext = 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
  else if (ct.includes('gif')) ext = 'gif';
  else if (ct.includes('webp')) ext = 'webp';
  const buf = Buffer.from(await res.arrayBuffer());
  const path = join(IMG_DIR, `img-${idx}.${ext}`);
  writeFileSync(path, buf);
  console.log(`  Downloaded ${url} → ${path} (${buf.length} bytes)`);
  return { url, path };
}

if (imageUrls.length > 0) {
  console.log(`Found ${imageUrls.length} image(s) in issue + comments. Downloading...`);
  for (let i = 0; i < imageUrls.length; i++) {
    const r = await downloadImage(imageUrls[i], i);
    if (r) downloadedImages.push(r);
  }
} else {
  console.log('No images in issue.');
}

// ── Load repository architecture reference ───────────────────────────────────
// Restored in v1.8.4 after the v1.8.2 over-correction. These files describe
// how the project is structured — reference material for WHERE to look, not
// heuristic hints for WHAT caused the bug. Anti-pattern-matching rules in
// the system prompt still apply.
function loadMemoryFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return `(could not read ${path} — investigate the repo structure yourself)`;
  }
}
const memoryOverview     = loadMemoryFile('.claude/memory/project_overview.md');
const memoryArchitecture = loadMemoryFile('.claude/memory/project_architecture.md');

// ── Build agent prompt ───────────────────────────────────────────────────────

const systemPrompt = `You are an automated bug-triage agent for the Maelle codebase. A Bug-labeled issue was filed. Your job: investigate, then PROPOSE A PLAN. You never edit files.

REPOSITORY ARCHITECTURE (reference material — describes how this project is built and where things live; use it to know WHERE to look, not WHAT the bug is):

--- project_overview.md ---

${memoryOverview}

--- project_architecture.md ---

${memoryArchitecture}

--- end reference ---

IMPORTANT about the files above: they describe recent changes / wave summaries / version history. Do NOT use those narratives to guess the bug's cause. The bug comes from evidence you gather for THIS specific issue — the reported symptoms, attached images, and actual code you read. Pattern-matching the bug to a recent changelog entry is a known failure mode.

RULES:

1. NEVER edit any file. You have Read/Grep/Glob only for code. No Edit, no Write, no Bash git.
2. Always propose a plan as your output. The owner reviews the plan and labels "Approved" to trigger the build phase. You do NOT build.
3. Investigate the codebase BEFORE forming a hypothesis. Do NOT pattern-match on the architecture reference above, on recent changelog entries, or on the latest version's headline feature — a real failure mode (the auto-triage shipped a bad fix in v1.8.0 because it associated a language bug with the fresh VOICE LANGUAGE OVERRIDE feature; the bug was actually about text chat). Anchor your diagnosis in code you have actually read for this specific issue.
4. If the issue has images (screenshots), READ THEM via the Read tool on the paths listed under "ATTACHED IMAGES" below. Screenshots are usually the single most important evidence — a text-chat bug looks very different from a voice-chat bug in a screenshot. Do not classify without inspecting images present.
5. Your root cause must name specific code: a file path and an approximate line or function. "A fix in the prompt" is not grounded. "The LANGUAGE rule at systemPrompt.ts:292-296 does not hold under prior-turn pressure" is grounded.
6. If the cause relies on a single keyword match (e.g., "Hebrew" → voice), confirm with a second independent signal (the screenshot, a specific code path, a reproducer). Missing confirmation → lower your confidence and flag the uncertainty in the plan.
7. Honor the Maelle-is-a-human-EA principle: any fix that makes Maelle sound more robotic, more tool-like, or less human fails the test even if it is technically correct. If a proposed fix adds prompt text that feels machine-framed ("the system requires", "threshold not cleared", "force the slot"), flag it as a concern.
8. Classification:
   - NOT_A_BUG: pipeline tests ("confirm you can read this repo"), usage questions, feature requests mislabeled, already-fixed, invalid/nonsensical reports, duplicates. No plan needed.
   - BUG: a real defect. You write a plan, classify internal complexity (simple/medium/complex) as metadata, and the owner decides.
9. If uncertain about the cause, classify BUG + complex + say so in the plan. Do not guess. The owner can ask you to dig more via the Revise label.

OUTPUT FORMAT (your final message — strict JSON only, no prose preamble, no code fences):

{
  "classification": "NOT_A_BUG" | "BUG",
  "complexity": "simple" | "medium" | "complex",
  "confidence": "high" | "medium" | "low",
  "summary": "One paragraph: what the bug is, what the cause is, grounded in code you read. For NOT_A_BUG: why it isn't a real defect.",
  "root_cause": "File path + line/function + mechanism. E.g. 'src/core/orchestrator/systemPrompt.ts:292-296 — LANGUAGE rule buries the no-inertia clause mid-sentence; Sonnet drifts under conversational pressure'. Empty string for NOT_A_BUG.",
  "files_likely_affected": ["src/path/to/file.ts"],
  "plan": "Owner-facing plan in markdown. Required for BUG. Structure: what, why, how, risks. Omit or empty for NOT_A_BUG.",
  "uncertainty": "If confidence is medium or low, name exactly what you're unsure about. Empty string if high confidence."
}`;

const attachedImages = downloadedImages.length > 0
  ? `\nATTACHED IMAGES (use the Read tool on each path to view — these are almost always critical evidence):\n${downloadedImages.map((img, i) => `  ${i + 1}. ${img.path}  (original URL: ${img.url})`).join('\n')}\n`
  : '\nNo images attached to this issue.\n';

const commentHistory = (issue.comments && issue.comments.length > 0)
  ? `\nPRIOR COMMENTS ON THIS ISSUE (chronological, oldest first):\n\n${issue.comments.map(c => `— ${c.author?.login || 'unknown'} @ ${c.createdAt || '?'}:\n${c.body}\n`).join('\n')}\n`
  : '\n(No prior comments.)\n';

const reviseNote = isRevise
  ? '\nTHIS IS A REVISE REQUEST: You already proposed a plan earlier (see PRIOR COMMENTS above). The owner wants you to reconsider based on their feedback in those comments. Read the feedback carefully and write a NEW plan that addresses their concerns. Do not simply restate the old plan.\n'
  : '';

const userPrompt = `Issue #${issue.number}: "${issue.title}"

URL: ${issue.url}
Reported by: ${issue.author.login}
Labels: ${issue.labels.map(l => l.name).join(', ')}

BUG REPORT BODY:

${issue.body || '(empty body)'}
${attachedImages}${commentHistory}${reviseNote}

Investigate the codebase (use Grep/Glob/Read — start by figuring out what subsystem this touches, then read the actual code). Inspect every attached image with the Read tool before diagnosing. Produce your structured JSON output as specified. Remember: you cannot edit files; you can only propose a plan.`;

// ── Run the agent ────────────────────────────────────────────────────────────

console.log('Invoking Claude Agent SDK...');

let lastTextResult = '';

try {
  for await (const event of query({
    prompt: userPrompt,
    options: {
      systemPrompt,
      model: 'claude-sonnet-4-6',
      permissionMode: 'default',    // no edits allowed; we don't grant Edit/Write
      allowedTools: ['Read', 'Grep', 'Glob'],
    },
  })) {
    if (event.type === 'result') {
      lastTextResult = event.result || '';
    }
  }
} catch (err) {
  console.error('Agent run failed:', err);
  ghComment(`🤖 Auto-triage hit an internal error and could not investigate this bug. Owner: please review manually.\n\n\`\`\`\n${String(err).slice(0, 1000)}\n\`\`\``);
  ghLabel('Triaged');
  process.exit(0);
}

console.log('Agent finished. Final result length:', lastTextResult.length);

// ── Parse the agent's output ─────────────────────────────────────────────────

function extractJson(raw) {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  if (!cleaned.startsWith('{')) {
    const m = cleaned.match(/\{[\s\S]*"classification"[\s\S]*\}/);
    if (m) cleaned = m[0];
  }
  return JSON.parse(cleaned);
}

let verdict;
try {
  verdict = extractJson(lastTextResult);
} catch (err) {
  console.error('Could not parse agent output as JSON:', err);
  ghComment(`🤖 Auto-triage finished but its output was not parseable. Raw output below for owner review:\n\n${lastTextResult.slice(0, 4000)}`);
  ghLabel('Triaged');
  process.exit(0);
}

console.log(`Verdict: ${verdict.classification} | complexity=${verdict.complexity} | confidence=${verdict.confidence}`);

// ── Sanity-check pass (anti-recency-bias guardrail) ──────────────────────────
// A tiny Sonnet call asks: "does your plan's cause actually match the reported
// symptoms?" This catches off-topic fixes like 60546e8 (voice fix proposed for
// a text-chat bug). Fails open on API error.

let sanityWarning = null;
if (verdict.classification === 'BUG' && verdict.summary && verdict.root_cause) {
  try {
    const anthropic = new Anthropic();
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: 'You are a sanity-checker for bug triage. Given a reported bug and a proposed root cause, judge whether the cause plausibly explains the symptoms. Be strict — catch off-topic fixes. Strict JSON only, no preamble.',
      messages: [{
        role: 'user',
        content: `REPORTED BUG:
Title: ${issue.title}
Body: ${(issue.body || '').slice(0, 2000)}
${downloadedImages.length > 0 ? `[${downloadedImages.length} image(s) attached — the triage agent inspected them; you cannot]` : ''}

PROPOSED ROOT CAUSE:
${verdict.root_cause}

PROPOSED SUMMARY:
${verdict.summary}

Does this cause plausibly match the symptoms? Watch for:
- Off-topic: the cause is about a different feature than the bug describes
- Keyword match: the cause pattern-matched a word in the bug instead of the actual problem
- Overreach: the cause is real but doesn't explain the specific symptom reported

Output strict JSON only:
{
  "match": "yes" | "no" | "uncertain",
  "reason": "one sentence"
}`,
      }],
    });
    const text = res.content.find(b => b.type === 'text')?.text || '';
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const parsed = JSON.parse(cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned);
    if (parsed.match !== 'yes') {
      sanityWarning = `⚠️ **Sanity-check warning:** ${parsed.reason || '(no reason given)'} (verdict: ${parsed.match})`;
      console.log('Sanity check flagged:', parsed);
    } else {
      console.log('Sanity check passed.');
    }
  } catch (err) {
    console.warn('Sanity check failed (fails open):', String(err).slice(0, 200));
  }
}

// ── NOT_A_BUG — auto-close ───────────────────────────────────────────────────

if (verdict.classification === 'NOT_A_BUG') {
  ghComment(`🤖 **Auto-triage: not a bug — closing**

${verdict.summary || 'Agent determined this issue does not describe a real defect.'}

---

*Closed automatically. If this was wrong, reopen the issue and I'll investigate again.*`);
  ghLabel('Triaged');
  ghClose('not planned');
  console.log('NOT_A_BUG — closed with not-planned.');
  process.exit(0);
}

// ── BUG — post plan comment, label Proposed ──────────────────────────────────

const confidenceBadge = verdict.confidence === 'high' ? '✅ high confidence'
                     : verdict.confidence === 'medium' ? '🟡 medium confidence'
                     : '🔴 low confidence';

const uncertaintyBlock = verdict.uncertainty
  ? `\n**Uncertain about:** ${verdict.uncertainty}\n`
  : '';

const sanityBlock = sanityWarning ? `\n${sanityWarning}\n` : '';

const imagesBlock = downloadedImages.length > 0
  ? `\n*Inspected ${downloadedImages.length} attached image(s).*`
  : '';

const commentBody = `🤖 **Auto-triage: plan proposed**

**Classification:** BUG (${verdict.complexity}) · ${confidenceBadge}${imagesBlock}
${sanityBlock}${uncertaintyBlock}
**Summary:** ${verdict.summary || '(none)'}

**Root cause:** ${verdict.root_cause || '(not identified — see plan)'}

**Files likely affected:** ${(verdict.files_likely_affected || []).map(f => `\`${f}\``).join(', ') || '(tbd)'}

---

## Plan

<!-- PLAN START -->
${verdict.plan || '(no plan written)'}
<!-- PLAN END -->

---

**Next step:** label this issue \`Approved\` to build, or \`Revise\` with a comment to re-plan.`;

ghComment(commentBody);
ghLabel('Proposed');
if (isRevise) ghRemoveLabel('Revise');

console.log('Posted plan comment. Labeled Proposed. Waiting for owner decision.');
