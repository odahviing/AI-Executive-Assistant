#!/usr/bin/env node
/**
 * Auto-triage a Bug issue using the Claude Agent SDK.
 *
 * Invoked by .github/workflows/auto-triage-bug.yml when a Bug-labeled issue
 * opens. The agent investigates the codebase, classifies the bug, and either
 * (a) fixes it directly when the change is small + safe, or
 * (b) writes a plan as an issue comment when the change is too big or
 *     requires owner judgment.
 *
 * SAFETY FLOORS (enforced by THIS SCRIPT, not the agent):
 *   - Auto-commit only when ALL of: agent classified SIMPLE, edits are
 *     <= 50 lines added+removed, edits touch a single file, npm typecheck
 *     passes after the edits.
 *   - Any failure → revert all working-tree changes, comment the agent's
 *     plan on the issue, label `auto-triaged`, leave issue OPEN for owner.
 *   - Bot's own commits don't re-trigger (workflow runs on ISSUES, not pushes).
 *   - Same issue won't re-trigger (`auto-triaged` label is the dedupe gate
 *     in the workflow's `if`).
 *
 * The agent's allowed tools are deliberately narrow: Read/Grep/Glob/Edit/Write
 * for codebase work + Bash for `npm run typecheck`. No git access from inside
 * the agent — commits + pushes are this script's job, after the agent finishes.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const REPO         = process.env.REPO;

if (!ISSUE_NUMBER || !REPO || !process.env.ANTHROPIC_API_KEY) {
  console.error('Missing required env: ISSUE_NUMBER, REPO, ANTHROPIC_API_KEY');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

function ghComment(body) {
  // gh expects body via --body-file when content has special chars; use stdin.
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

function ghClose() {
  spawnSync('gh', ['issue', 'close', ISSUE_NUMBER, '--repo', REPO], { encoding: 'utf8' });
}

// ── Read the issue ──────────────────────────────────────────────────────────

const issue = JSON.parse(sh(
  `gh issue view ${ISSUE_NUMBER} --repo ${REPO} --json title,body,labels,author,number,url`,
));

console.log(`Auto-triaging issue #${issue.number}: "${issue.title}"`);

// ── Build agent prompt ──────────────────────────────────────────────────────

let sessionStarter = '';
try {
  sessionStarter = readFileSync('.claude/SESSION_STARTER.md', 'utf8');
} catch { /* OK if missing */ }

const systemPrompt = `You are an automated bug-triage agent for the Maelle codebase. You run in GitHub Actions whenever a Bug-labeled issue is filed. Your job is to investigate, classify, and either fix-or-plan.

REPOSITORY CONTEXT (from .claude/SESSION_STARTER.md):

${sessionStarter || '(SESSION_STARTER.md not found — investigate the repo structure yourself before fixing anything)'}

YOUR DECISION TREE (apply STRICTLY):

1. Read the bug. Investigate the codebase using Read / Grep / Glob to find the actual cause.

2. Classify:
   - SIMPLE: cause is clear, fix touches ONE file, total diff <= 50 lines added+removed,
     no architectural decisions, no judgment about UX/tone/policy needed.
   - MEDIUM: cause is clear but the fix is bigger (multiple files, >50 lines, or touches
     prompts/persona/skill behavior).
   - COMPLEX: cause is unclear, requires architecture changes, or genuinely needs the
     owner's judgment (e.g. "should we deprecate X?").

3. If SIMPLE:
   - Make the edit using Edit/Write.
   - Run \`npm run typecheck\` via Bash. If it fails, REVERT mentally (the runner script will
     wipe your changes anyway) and write a PLAN instead.
   - Otherwise, your final response MUST be a structured summary so the runner can commit.

4. If MEDIUM or COMPLEX:
   - Do NOT edit any files. Investigate, then write a PLAN.
   - The plan should describe: root cause, proposed fix, files affected, risks, anything the
     owner needs to decide.

CRITICAL CONSTRAINTS:
- NEVER edit: .claude/, memory files (anywhere), CHANGELOG.md, README.md, package.json,
  config/users/ (real owner data — gitignored anyway). These are owner-curated.
- NEVER edit: .github/ (your own workflow), scripts/auto-triage-*.mjs (your own script).
- NEVER attempt git operations directly. The runner handles all git.
- Honesty rule (from Maelle's standing principles): if you're not sure, classify as MEDIUM
  or COMPLEX. Don't guess.

OUTPUT FORMAT (your final message — strict JSON ONLY, no prose preamble, no fences):

{
  "classification": "SIMPLE" | "MEDIUM" | "COMPLEX",
  "summary": "One paragraph: what the bug is, what the cause is, what you did or what should be done.",
  "files_changed": ["src/path/to/file.ts"],   // empty array if no edits
  "plan": "Owner-facing plan in markdown. Required for MEDIUM/COMPLEX. Optional for SIMPLE (a brief 'what changed' note)."
}

If you're uncertain at any step → classify higher (MEDIUM not SIMPLE; COMPLEX not MEDIUM). Cost of a wrong auto-fix is high; cost of a missed plan is just one extra owner review.`;

const userPrompt = `Issue #${issue.number}: "${issue.title}"

URL: ${issue.url}
Reported by: ${issue.author.login}
Labels: ${issue.labels.map(l => l.name).join(', ')}

BUG REPORT BODY:

${issue.body || '(empty body)'}

Investigate the codebase, classify, and produce your structured JSON output as specified.`;

// ── Run the agent ──────────────────────────────────────────────────────────

console.log('Invoking Claude Agent SDK...');

let lastTextResult = '';

try {
  for await (const event of query({
    prompt: userPrompt,
    options: {
      systemPrompt,
      model: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',   // auto-accept Edit/Write; Bash still prompts unless allowed
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      // Bash is allowed because the agent needs `npm run typecheck`.
      // The script's safety floors (typecheck pass + size cap) are the real guard,
      // not tool permissions.
    },
  })) {
    if (event.type === 'result') {
      lastTextResult = event.result || '';
    }
  }
} catch (err) {
  console.error('Agent run failed:', err);
  ghComment(`🤖 Auto-triage hit an internal error and could not investigate this bug. Owner: please review manually.\n\n\`\`\`\n${String(err).slice(0, 1000)}\n\`\`\``);
  ghLabel('auto-triaged');
  process.exit(0);
}

console.log('Agent finished. Final result length:', lastTextResult.length);

// ── Parse the agent's structured output ────────────────────────────────────

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
  ghLabel('auto-triaged');
  process.exit(0);
}

console.log('Verdict:', verdict.classification);

// ── Inspect what the agent actually changed ────────────────────────────────

const changedFiles = sh('git diff --name-only').split('\n').filter(Boolean);
const stat = sh('git diff --shortstat || echo ""');

// Parse "X files changed, Y insertions(+), Z deletions(-)"
const insMatch = stat.match(/(\d+)\s+insertion/);
const delMatch = stat.match(/(\d+)\s+deletion/);
const totalLines = (parseInt(insMatch?.[1] ?? '0', 10)) + (parseInt(delMatch?.[1] ?? '0', 10));

console.log(`Changed files: ${changedFiles.length} | total lines changed: ${totalLines}`);

// ── Apply safety floors + decide outcome ────────────────────────────────────

function postPlanAndExit(reason, planText) {
  // Wipe any working-tree changes the agent left behind
  if (changedFiles.length > 0) {
    sh('git checkout -- .');
  }
  const body = `🤖 **Auto-triage: needs owner review**

**Reason:** ${reason}

**Summary:** ${verdict.summary || '(none)'}

**Plan:**

${planText || verdict.plan || '(no plan written)'}

---

*Agent classified this as: \`${verdict.classification}\`. Files the agent considered: ${(verdict.files_changed ?? []).map(f => `\`${f}\``).join(', ') || 'none'}*`;
  ghComment(body);
  ghLabel('auto-triaged');
  process.exit(0);
}

if (verdict.classification !== 'SIMPLE') {
  postPlanAndExit(
    verdict.classification === 'COMPLEX'
      ? 'Agent classified this as COMPLEX (architecture / judgment required).'
      : 'Agent classified this as MEDIUM (multi-file or significant change).',
    verdict.plan,
  );
}

// SIMPLE path — verify size + typecheck before committing
if (changedFiles.length === 0) {
  postPlanAndExit('Agent classified as SIMPLE but made no file edits. Posting analysis only.', verdict.plan || verdict.summary);
}

if (changedFiles.length > 1) {
  postPlanAndExit(`Agent's edit touched ${changedFiles.length} files (cap: 1). Reverting and posting plan.`, verdict.plan);
}

if (totalLines > 50) {
  postPlanAndExit(`Agent's edit changed ${totalLines} lines (cap: 50). Reverting and posting plan.`, verdict.plan);
}

// Forbidden paths check (defense-in-depth — system prompt also forbids these)
const FORBIDDEN_PREFIXES = ['.claude/', '.github/', 'memory/', 'CHANGELOG.md', 'README.md', 'package.json', 'config/users/', 'scripts/auto-triage'];
const forbiddenHit = changedFiles.find(f => FORBIDDEN_PREFIXES.some(p => f.startsWith(p) || f === p));
if (forbiddenHit) {
  postPlanAndExit(`Agent edited a forbidden path (\`${forbiddenHit}\`). Reverting.`, verdict.plan);
}

// Typecheck
console.log('Running typecheck...');
const tc = spawnSync('npm', ['run', 'typecheck'], { encoding: 'utf8' });
if (tc.status !== 0) {
  postPlanAndExit('Typecheck failed after the agent\'s edit. Reverting.', `Typecheck output:\n\`\`\`\n${(tc.stdout + tc.stderr).slice(-2000)}\n\`\`\`\n\n${verdict.plan ?? ''}`);
}

console.log('Typecheck passed. Committing + pushing.');

// ── Commit + push ──────────────────────────────────────────────────────────

const filesList = changedFiles.join(', ');
const commitMessage = `auto-fix: ${issue.title}

Fixes #${issue.number}

${verdict.summary || ''}

Files: ${filesList}
Lines changed: ${totalLines}

🤖 Generated by auto-triage GitHub Action.
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`;

sh('git add -A');
sh(`git commit -m ${JSON.stringify(commitMessage)}`);
sh('git push');
const sha = sh('git rev-parse HEAD');

console.log(`Committed ${sha}`);

ghComment(`🤖 **Auto-fixed in commit ${sha.slice(0, 7)}**

${verdict.summary || ''}

**File:** \`${filesList}\` (${totalLines} lines changed)

${verdict.plan ? `**What changed:**\n${verdict.plan}` : ''}

---

*Review at home. Revert with \`git revert ${sha.slice(0, 7)}\` if anything's off.*`);
ghLabel('auto-triaged');
ghClose();

console.log('Done.');
