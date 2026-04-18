#!/usr/bin/env node
/**
 * Auto-build a bug fix from an Approved plan.
 *
 * v1.8.2 — fires from .github/workflows/auto-build.yml when the `Approved`
 * label is added to a Bug-labeled issue. The owner already reviewed the plan
 * the triage agent wrote (see Proposed flow in auto-triage-bug.mjs).
 *
 * This script:
 *   1. Reads the issue + all comments
 *   2. Finds the LATEST plan comment (last auto-triage comment with "## Plan")
 *   3. Collects owner follow-up comments posted after that plan
 *   4. Writes a consolidated plan block into the issue BODY (under "## Approved plan")
 *   5. Invokes the agent with the plan + follow-ups, asks it to implement
 *   6. Safety floors: typecheck must pass, size cap (200 lines), path allowlist
 *   7. Commits + pushes under "Maelle Auto-Triage" author
 *   8. Closes the issue with a fixed-in-SHA comment
 *
 * On any failure (typecheck fails, size exceeded, forbidden path edited): revert
 * all working-tree changes, comment the failure reason, remove the Approved
 * label, add `Failed` label, leave the issue OPEN for owner review.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync, spawnSync } from 'node:child_process';

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
  const r = spawnSync('gh', ['issue', 'comment', ISSUE_NUMBER, '--repo', REPO, '--body-file', '-'], {
    input: body, encoding: 'utf8',
  });
  if (r.status !== 0) console.error('gh comment failed:', r.stderr);
}

function ghEditBody(newBody) {
  const r = spawnSync('gh', ['issue', 'edit', ISSUE_NUMBER, '--repo', REPO, '--body-file', '-'], {
    input: newBody, encoding: 'utf8',
  });
  if (r.status !== 0) console.error('gh edit body failed:', r.stderr);
}

function ghLabel(...labels) {
  for (const l of labels) {
    spawnSync('gh', ['issue', 'edit', ISSUE_NUMBER, '--repo', REPO, '--add-label', l], { encoding: 'utf8' });
  }
}

function ghRemoveLabel(label) {
  spawnSync('gh', ['issue', 'edit', ISSUE_NUMBER, '--repo', REPO, '--remove-label', label], { encoding: 'utf8' });
}

function ghClose() {
  spawnSync('gh', ['issue', 'close', ISSUE_NUMBER, '--repo', REPO, '--reason', 'completed'], { encoding: 'utf8' });
}

function bailOpen(reason, detail = '') {
  console.error('BUILD ABORTED:', reason);
  try { sh('git checkout -- .'); } catch {}
  ghComment(`🤖 **Auto-build aborted**

**Reason:** ${reason}

${detail ? `\`\`\`\n${detail.slice(0, 2000)}\n\`\`\`` : ''}

---

The \`Approved\` label has been removed. Review the plan, adjust, or implement manually.`);
  ghRemoveLabel('Approved');
  ghLabel('Failed');
  process.exit(0);
}

// ── Read the issue ────────────────────────────────────────────────────────────

const issue = JSON.parse(sh(
  `gh issue view ${ISSUE_NUMBER} --repo ${REPO} --json title,body,labels,author,number,url,comments`,
));

console.log(`Building fix for issue #${issue.number}: "${issue.title}"`);

// ── Find the latest plan comment ─────────────────────────────────────────────
// Triage comments are authored by the bot (github-actions). The plan comment
// contains the string "## Plan". Take the LAST such comment — if the owner
// triggered Revise, there may be multiple; the most recent is canonical.

const planMarker = '## Plan';
const triageComments = (issue.comments || []).filter(c =>
  (c.body || '').includes(planMarker) && (c.body || '').includes('🤖')
);

if (triageComments.length === 0) {
  bailOpen('No triage plan comment found on this issue — cannot build without a plan.');
}

const latestPlanComment = triageComments[triageComments.length - 1];
const latestPlanIdx = (issue.comments || []).findIndex(c => c === latestPlanComment);

// Extract just the plan section from that comment
const planStart = latestPlanComment.body.indexOf(planMarker);
const planEnd = latestPlanComment.body.indexOf('---', planStart + planMarker.length);
const extractedPlan = planStart >= 0
  ? latestPlanComment.body.slice(planStart, planEnd > 0 ? planEnd : undefined).trim()
  : latestPlanComment.body;

// Follow-up comments posted AFTER the latest plan (excluding bot comments and label-event comments)
const followUps = (issue.comments || []).slice(latestPlanIdx + 1).filter(c => {
  const author = c.author?.login || '';
  return !author.includes('github-actions') && !author.includes('auto-triage');
});

console.log(`Using plan from comment ${latestPlanComment.author?.login || '?'} @ ${latestPlanComment.createdAt || '?'}`);
console.log(`Follow-up comments: ${followUps.length}`);

// ── Write the approved plan into the issue body ──────────────────────────────

const approvedPlanBlock = `

---

## Approved plan (locked by auto-build)

${extractedPlan.replace(/^## Plan\s*/, '')}

${followUps.length > 0 ? `### Owner follow-up before build\n\n${followUps.map(c => `> ${(c.body || '').replace(/\n/g, '\n> ')}`).join('\n\n')}\n` : ''}

*Built from comment by ${latestPlanComment.author?.login || '?'} at ${latestPlanComment.createdAt || '?'}. Commit below.*
`;

const newBody = (issue.body || '') + approvedPlanBlock;
ghEditBody(newBody);
console.log('Plan written into issue body.');

// ── Build the agent prompt ───────────────────────────────────────────────────

const systemPrompt = `You are an automated bug-fix agent for the Maelle codebase. The owner has reviewed and APPROVED a plan for a bug fix. Your job: implement it.

RULES:

1. IMPLEMENT the plan exactly. If the plan is ambiguous or wrong, STOP and explain (set classification=ABORT in your output). Do not improvise a different fix.
2. Run \`npm run typecheck\` after every meaningful edit. Must pass before you finish.
3. Do NOT edit: .claude/, memory/ (any memory files), CHANGELOG.md, README.md, package.json, config/users/, .github/, scripts/auto-triage-*.mjs, scripts/auto-build.mjs, scripts/deploy-watcher.mjs. These are owner-curated.
4. Keep the diff minimal. Do not refactor surrounding code. Do not add "while you're here" improvements.
5. No comments explaining what the code does. Only add a comment for non-obvious WHY (hidden constraint, workaround).

OUTPUT FORMAT (your final message — strict JSON only, no prose, no fences):

{
  "status": "DONE" | "ABORT",
  "summary": "One paragraph: what you changed and why it fixes the bug.",
  "files_changed": ["src/path/to/file.ts"],
  "reason_for_abort": "If status=ABORT, explain why you couldn't implement the plan. Empty otherwise."
}

If status=ABORT, the runner will revert all your edits, post your reason as a comment, and leave the issue open for the owner.`;

const userPrompt = `Issue #${issue.number}: "${issue.title}"

URL: ${issue.url}

ORIGINAL BUG REPORT:

${issue.body || '(empty body)'}

APPROVED PLAN (what you must implement):

${extractedPlan}

${followUps.length > 0 ? `
OWNER FOLLOW-UP GUIDANCE (posted after the plan, before approval — honor these refinements):

${followUps.map(c => `— ${c.author?.login || '?'}: ${c.body}`).join('\n\n')}
` : ''}

Implement the plan. Run typecheck. Output strict JSON.`;

// ── Run the agent ────────────────────────────────────────────────────────────

console.log('Invoking agent to build...');

let lastTextResult = '';

try {
  for await (const event of query({
    prompt: userPrompt,
    options: {
      systemPrompt,
      model: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    },
  })) {
    if (event.type === 'result') {
      lastTextResult = event.result || '';
    }
  }
} catch (err) {
  bailOpen('Agent run failed.', String(err));
}

console.log('Agent finished. Result length:', lastTextResult.length);

// ── Parse output ─────────────────────────────────────────────────────────────

function extractJson(raw) {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  if (!cleaned.startsWith('{')) {
    const m = cleaned.match(/\{[\s\S]*"status"[\s\S]*\}/);
    if (m) cleaned = m[0];
  }
  return JSON.parse(cleaned);
}

let verdict;
try {
  verdict = extractJson(lastTextResult);
} catch (err) {
  bailOpen('Agent output was not parseable JSON.', lastTextResult);
}

if (verdict.status === 'ABORT') {
  bailOpen(`Agent aborted: ${verdict.reason_for_abort || '(no reason given)'}`);
}

// ── Inspect diff ─────────────────────────────────────────────────────────────

const changedFiles = sh('git diff --name-only').split('\n').filter(Boolean);
const stat = sh('git diff --shortstat || echo ""');
const insMatch = stat.match(/(\d+)\s+insertion/);
const delMatch = stat.match(/(\d+)\s+deletion/);
const totalLines = (parseInt(insMatch?.[1] ?? '0', 10)) + (parseInt(delMatch?.[1] ?? '0', 10));

console.log(`Changed files: ${changedFiles.length} | lines changed: ${totalLines}`);

if (changedFiles.length === 0) {
  bailOpen('Agent reported DONE but made no file edits.');
}

// ── Safety floors ────────────────────────────────────────────────────────────

const SIZE_CAP = 200; // higher than v1's 50 since plan was pre-approved
if (totalLines > SIZE_CAP) {
  bailOpen(`Diff is ${totalLines} lines (cap: ${SIZE_CAP}). Plan may have been larger than expected — review manually.`);
}

const FORBIDDEN = ['.claude/', '.github/', 'memory/', 'CHANGELOG.md', 'README.md', 'package.json', 'config/users/', 'scripts/auto-triage', 'scripts/auto-build', 'scripts/deploy-watcher'];
const forbiddenHit = changedFiles.find(f => FORBIDDEN.some(p => f.startsWith(p) || f === p));
if (forbiddenHit) {
  bailOpen(`Agent edited forbidden path: \`${forbiddenHit}\``);
}

// ── Typecheck ────────────────────────────────────────────────────────────────

console.log('Running typecheck...');
const tc = spawnSync('npm', ['run', 'typecheck'], { encoding: 'utf8' });
if (tc.status !== 0) {
  bailOpen('Typecheck failed after build.', (tc.stdout + tc.stderr));
}

// ── Commit + push ────────────────────────────────────────────────────────────

console.log('Typecheck passed. Committing + pushing.');

const filesList = changedFiles.join(', ');
const commitMessage = `auto-fix(approved): ${issue.title}

Fixes #${issue.number}

${verdict.summary || ''}

Files: ${filesList}
Lines changed: ${totalLines}
Plan: approved by ${followUps.length > 0 ? 'owner (with follow-up)' : 'owner'} before build

🤖 Generated by auto-build GitHub Action.
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`;

sh('git add -A');
sh(`git commit -m ${JSON.stringify(commitMessage)}`);
sh('git push');
const sha = sh('git rev-parse HEAD');

console.log(`Committed ${sha}`);

ghComment(`🤖 **Auto-built in commit ${sha.slice(0, 7)}**

${verdict.summary || ''}

**Files:** \`${filesList}\` (${totalLines} lines changed)

---

Laptop deploy watcher will pick this up within 5 minutes and restart Maelle. Revert with \`git revert ${sha.slice(0, 7)}\` if needed.`);

ghRemoveLabel('Approved');
ghRemoveLabel('Proposed');
ghLabel('Triaged');
ghClose();

console.log('Build complete.');
