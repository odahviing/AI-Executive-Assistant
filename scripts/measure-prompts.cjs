#!/usr/bin/env node
/**
 * Measure prompt sizes across the system.
 *
 * Loads the actual profile + invokes the real prompt builders, so the numbers
 * reflect what Sonnet sees at runtime. Tokens are approximated at ~4 chars/token
 * (Claude family rule-of-thumb). For the canonical owner-DM turn, this is the
 * combined system prompt sent on every turn.
 *
 * Usage: node scripts/measure-prompts.cjs [profileId]
 *   profileId defaults to 'idan'.
 */

require('ts-node/register/transpile-only');

const fs = require('fs');
const path = require('path');

// Anchor cwd to main repo so config/users/*.yaml + .env resolve correctly
// even when this script is invoked from a worktree.
const REPO_ROOT = path.resolve(__dirname, '..');
process.chdir(REPO_ROOT);
// override:true is needed when the shell has a stale (often empty) env var
// — dotenv default behavior preserves existing values.
require('dotenv').config({ path: path.join(REPO_ROOT, '.env'), override: true });

const profileId = process.argv[2] || 'idan';

// Load profile via the same path the orchestrator uses.
const { loadUserProfile } = require(path.join(__dirname, '..', 'src', 'config', 'userProfile.ts'));
const profile = loadUserProfile(profileId);
if (!profile) {
  console.error(`Profile "${profileId}" not found.`);
  process.exit(1);
}

const TOKENS_PER_CHAR = 1 / 4;
const fmt = (chars) => `${chars.toLocaleString().padStart(7)} chars  ~${Math.round(chars * TOKENS_PER_CHAR).toLocaleString().padStart(6)} tokens`;

const results = [];
const record = (name, perInvocation, mode, chars) => results.push({ name, perInvocation, mode, chars });

// ──────────────────────────────────────────────────────────────────────────
// 1. Main owner-DM system prompt (every owner turn)
// ──────────────────────────────────────────────────────────────────────────
const { buildSystemPrompt, buildSystemPromptParts } = require(path.join(__dirname, '..', 'src', 'core', 'orchestrator', 'systemPrompt.ts'));

const ownerDM = buildSystemPrompt(profile, 'owner', profile.user.name, false, undefined, false, false, undefined);
record('Owner DM — full system prompt', 'every owner turn', 'baseline', ownerDM.length);

const ownerDMParts = buildSystemPromptParts(profile, 'owner', profile.user.name, false, undefined, false, false, undefined);
record('  ↳ static (skills section, cacheable)', '', '', ownerDMParts.static.length);
record('  ↳ dynamic (prefs/people/date, not cached)', '', '', ownerDMParts.dynamic.length);

// ──────────────────────────────────────────────────────────────────────────
// 2. Colleague-DM system prompt
// ──────────────────────────────────────────────────────────────────────────
const colleagueDM = buildSystemPrompt(profile, 'colleague', 'Brett', false, undefined, false, false, undefined);
record('Colleague DM — full system prompt', 'every colleague turn', 'baseline', colleagueDM.length);

// ──────────────────────────────────────────────────────────────────────────
// 3. MPIM system prompt
// ──────────────────────────────────────────────────────────────────────────
const mpim = buildSystemPrompt(profile, 'colleague', 'Brett', true, undefined, true, false, undefined);
record('MPIM — full system prompt', 'every MPIM turn', 'baseline', mpim.length);

// ──────────────────────────────────────────────────────────────────────────
// 4. Tool descriptions (part of every Anthropic request alongside system prompt)
// ──────────────────────────────────────────────────────────────────────────
const { getSkillTools } = require(path.join(__dirname, '..', 'src', 'skills', 'registry.ts'));
const ownerTools = getSkillTools(profile, 'owner');
const ownerToolJson = JSON.stringify(ownerTools);
record('Owner tools — JSON.stringify of all tools', 'every owner turn', 'tools', ownerToolJson.length);

const colleagueTools = getSkillTools(profile, 'colleague');
const colleagueToolJson = JSON.stringify(colleagueTools);
record('Colleague tools — JSON.stringify of all tools', 'every colleague turn', 'tools', colleagueToolJson.length);

// Per-tool breakdown for owner (top 10 by size)
const perTool = ownerTools
  .map(t => ({ name: t.name, chars: JSON.stringify(t).length }))
  .sort((a, b) => b.chars - a.chars);

// ──────────────────────────────────────────────────────────────────────────
// 5. Gates and classifiers — these are ADDITIONAL Sonnet calls, not part of the main prompt
// ──────────────────────────────────────────────────────────────────────────
// Source-extract approach for these — they're not exported as pure strings.
const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function extractPrompt(src, marker) {
  // Find the SYSTEM_PROMPT or system prompt string. Heuristic: grab the
  // largest backtick block that contains the marker text.
  const matches = src.match(/`[\s\S]*?`/g) ?? [];
  let best = null;
  for (const m of matches) {
    if (m.includes(marker) && (!best || m.length > best.length)) best = m;
  }
  return best ? best.length : 0;
}

const gates = [
  // [name, file, marker phrase in the prompt string, when invoked]
  ['classifyOwnerIntent', 'src/core/social/classifyOwnerIntent.ts', 'classify', 'every owner turn (1 Sonnet call)'],
  ['briefIntent', 'src/core/briefIntent.ts', 'morning brief', 'every owner DM turn (1 Sonnet call)'],
  ['claimChecker', 'src/utils/claimChecker.ts', 'claim', 'after every owner draft (1 Sonnet call)'],
  ['humanGate', 'src/utils/humanGate.ts', 'human', 'after every owner/colleague draft (1 Sonnet call)'],
  ['securityGate', 'src/utils/securityGate.ts', 'security', 'after every colleague draft (1 Sonnet call, conditional)'],
  ['dateVerifier', 'src/utils/dateVerifier.ts', 'date', 'pre-mutation only (1 Sonnet call)'],
  ['coordGuard', 'src/utils/coordGuard.ts', 'coord', 'before coordinate_meeting (1 Sonnet call)'],
  ['addresseeGate', 'src/utils/addresseeGate.ts', 'addressee', 'colleague-path (1 Sonnet call)'],
  ['imageGuard', 'src/vision/imageGuard.ts', 'image', 'on image uploads (1 Sonnet call)'],
  ['taskContinuity', 'src/core/taskContinuity.ts', 'continuity', 'every owner turn (1 Sonnet call)'],
  ['autoCategorize (brief)', 'src/utils/autoCategorize.ts', 'categori', 'daily in brief generator (1 Sonnet batch call)'],
  ['compose_coda (social)', 'src/core/social/generateCoda.ts', 'coda', 'when coda eligible (1 Sonnet call)'],
  ['compose_ping (outreach tick)', 'src/tasks/dispatchers/socialOutreachTick.ts', 'ping', 'hourly cron when picking (1 Sonnet call)'],
  ['classifyFollowup (coord)', 'src/skills/meetings/coord/reply.ts', 'classify', 'on coord reply (1 Sonnet call)'],
  ['classify_document (KB)', 'src/skills/knowledge.ts', 'classify', 'on KB ingestion (1 Sonnet call)'],
  ['availabilityPreCheck', 'src/utils/availabilityPreCheck.ts', 'availab', 'colleague-path on (date,time) detect (1 Sonnet call)'],
  ['concision finalizer', 'src/connectors/slack/postReply.ts', 'concision', 'on long owner drafts (1 Sonnet call)'],
];

for (const [name, file, marker, when] of gates) {
  try {
    const src = readSrc(file);
    const chars = extractPrompt(src, marker);
    if (chars > 0) record(`Gate/classifier: ${name}`, when, 'sidecar', chars);
  } catch (_) { /* file may not exist */ }
}

// ──────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────
console.log('\n=== Prompt size measurement ===');
console.log(`Profile: ${profileId}`);
console.log(`Approximation: ${Math.round(1 / TOKENS_PER_CHAR)} chars ≈ 1 token (Claude rule-of-thumb)\n`);

console.log('── BASELINE: every-turn cost (system prompt + tools) ──');
const baseline = results.filter(r => r.mode === 'baseline' || r.mode === 'tools' || r.mode === '');
const maxName = Math.max(...baseline.map(r => r.name.length));
for (const r of baseline) {
  console.log(`  ${r.name.padEnd(maxName)}  ${fmt(r.chars)}${r.perInvocation ? '   (' + r.perInvocation + ')' : ''}`);
}
const ownerDMTotal = ownerDM.length + ownerToolJson.length;
console.log(`\n  ★ Total per owner turn (system prompt + tools): ${fmt(ownerDMTotal)}`);
console.log(`  ★ Total per colleague turn (system prompt + tools): ${fmt(colleagueDM.length + colleagueToolJson.length)}\n`);

console.log('── Top 10 tools by size (within owner-tools JSON) ──');
for (const t of perTool.slice(0, 10)) {
  console.log(`  ${t.name.padEnd(maxName)}  ${fmt(t.chars)}`);
}

console.log('\n── SIDECAR: separate Sonnet calls (NOT in main prompt) ──');
const sidecars = results.filter(r => r.mode === 'sidecar').sort((a, b) => b.chars - a.chars);
for (const r of sidecars) {
  console.log(`  ${r.name.padEnd(maxName)}  ${fmt(r.chars)}   (${r.perInvocation})`);
}

console.log('\nDone.');
