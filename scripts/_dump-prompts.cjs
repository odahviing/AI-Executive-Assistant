#!/usr/bin/env node
// One-off: dump static/dynamic owner-DM blocks + every owner tool to temp files,
// and print per-section / per-tool size tables. Read-only.
require('ts-node/register/transpile-only');
const fs = require('fs');
const path = require('path');
const REPO_ROOT = 'E:/Code/Maelle';
process.chdir(REPO_ROOT);
require('dotenv').config({ path: path.join(REPO_ROOT, '.env'), override: true });

const { loadUserProfile } = require(path.join(REPO_ROOT, 'src/config/userProfile.ts'));
const profile = loadUserProfile('idan');
const { buildSystemPromptParts } = require(path.join(REPO_ROOT, 'src/core/orchestrator/systemPrompt.ts'));
const { getSkillTools } = require(path.join(REPO_ROOT, 'src/skills/registry.ts'));

const parts = buildSystemPromptParts(profile, 'owner', profile.user.name, false, undefined, false, false, undefined);
const OUT = 'C:/Users/idanc/AppData/Local/Temp';
fs.writeFileSync(path.join(OUT, 'static.txt'), parts.static, 'utf8');
fs.writeFileSync(path.join(OUT, 'dynamic.txt'), parts.dynamic, 'utf8');

const tok = (s) => Math.round(s.length / 4);

// Split static into sections by ALL-CAPS headers / markdown headers.
function sectionize(text) {
  const lines = text.split('\n');
  const sections = [];
  let cur = { title: '(preamble)', body: [] };
  for (const ln of lines) {
    // Header heuristics: markdown ## , or a line that's mostly UPPERCASE words (>=2 caps words, <60 chars)
    const isMd = /^#{1,4}\s+\S/.test(ln);
    const caps = ln.trim();
    const isCaps = caps.length > 0 && caps.length < 70 && /^[A-Z0-9][A-Z0-9 ,/&'\-():]+$/.test(caps) && (caps.match(/[A-Z]{2,}/g)||[]).length >= 1 && caps === caps.toUpperCase();
    if (isMd || isCaps) {
      if (cur.body.join('\n').trim().length || cur.title !== '(preamble)') sections.push(cur);
      cur = { title: caps, body: [] };
    } else {
      cur.body.push(ln);
    }
  }
  sections.push(cur);
  return sections.map(s => ({ title: s.title, chars: (s.title + '\n' + s.body.join('\n')).length }));
}

console.log('=== STATIC block sections (chars / ~tokens) — total', parts.static.length, 'chars ~'+tok(parts.static)+' tok ===');
for (const s of sectionize(parts.static).sort((a,b)=>b.chars-a.chars)) {
  if (s.chars > 150) console.log(String(s.chars).padStart(7), ('~'+Math.round(s.chars/4)+'t').padStart(7), ' ', s.title.slice(0,64));
}

console.log('\n=== DYNAMIC block sections (chars / ~tokens) — total', parts.dynamic.length, 'chars ~'+tok(parts.dynamic)+' tok ===');
for (const s of sectionize(parts.dynamic).sort((a,b)=>b.chars-a.chars)) {
  if (s.chars > 100) console.log(String(s.chars).padStart(7), ('~'+Math.round(s.chars/4)+'t').padStart(7), ' ', s.title.slice(0,64));
}

const ownerTools = getSkillTools(profile, 'owner');
const colleagueTools = getSkillTools(profile, 'colleague');
const colleagueNames = new Set(colleagueTools.map(t=>t.name));
console.log('\n=== ALL owner tools (chars / ~tok / colleague-visible?) — total', ownerTools.length, 'tools,', JSON.stringify(ownerTools).length, 'chars ~'+tok(JSON.stringify(ownerTools))+'t ===');
const perTool = ownerTools.map(t => ({ name: t.name, chars: JSON.stringify(t).length, coll: colleagueNames.has(t.name) })).sort((a,b)=>b.chars-a.chars);
for (const t of perTool) console.log(String(t.chars).padStart(6), ('~'+Math.round(t.chars/4)+'t').padStart(6), t.coll?'C':' ', t.name);
const dump = ownerTools.map(t=>({name:t.name, description:t.description}));
fs.writeFileSync(path.join(OUT,'tools.json'), JSON.stringify(dump,null,2), 'utf8');

const scopeSets = [['general'], ['meetings'], ['coord','meetings'], ['tasks']];
console.log('\n=== Tools shipped per scope (owner) ===');
for (const s of scopeSets) {
  const ts = getSkillTools(profile, 'owner', s);
  const chars = JSON.stringify(ts).length;
  console.log(`  [${s.join(',').padEnd(16)}]  ${String(ts.length).padStart(2)} tools  ${String(chars).padStart(6)} chars  ~${Math.round(chars/4)}t`);
}

console.log('\n=== Static block per scope (owner) — coord prose lazy-load ===');
for (const s of [undefined, ['meetings'], ['coord','meetings']]) {
  const p = buildSystemPromptParts(profile, 'owner', profile.user.name, false, undefined, false, false, undefined, undefined, undefined, s);
  const hasCoord = p.static.includes('ROUTE 1 DETAILS');
  console.log(`  scopes=${(s||['undefined']).join(',').padEnd(16)}  static ${String(p.static.length).padStart(6)} chars ~${Math.round(p.static.length/4)}t  ROUTE1=${hasCoord ? 'YES' : 'no '}`);
}
console.log('\nWrote static.txt, dynamic.txt, tools.json to temp.');
