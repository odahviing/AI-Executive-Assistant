// One-shot measurement: how big is buildSystemPrompt for owner-DM, colleague-DM, MPIM?
// Token estimate uses chars / 3.6 (rough Claude-en average). For exact tokens,
// pipe the text into Anthropic's count_tokens API — the relative numbers here
// are accurate enough for sizing decisions.

import { loadAllProfiles } from '../src/config/userProfile';
import { buildSystemPrompt } from '../src/core/orchestrator/systemPrompt';
import { buildSkillsPromptSection, getActiveSkills } from '../src/skills/registry';
import { formatPreferencesForPrompt, formatPeopleMemoryForPrompt } from '../src/db';
import { formatPeopleCatalogSync } from '../src/memory/peopleMemory';
import { getPendingApprovalsForOwner } from '../src/db/approvals';

const profileMap = loadAllProfiles();
const profile = [...profileMap.values()][0];
if (!profile) { console.error('no profile loaded'); process.exit(1); }

const EST = (s: string) => Math.round(s.length / 3.6);
const PAD = (s: string | number, n: number) => String(s).padStart(n);

function header(label: string) {
  console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`);
}

function row(label: string, txt: string) {
  console.log(`${label.padEnd(48)} chars: ${PAD(txt.length, 6)}  est tokens: ${PAD(EST(txt), 6)}`);
}

const ownerFull = buildSystemPrompt(profile, 'owner');
const colleagueFull = buildSystemPrompt(profile, 'colleague', 'Sarah');
const mpimFull = buildSystemPrompt(profile, 'colleague', 'Sarah', true);

header(`PROFILE: ${profile.user.name} (${profile.user.slack_user_id})`);
console.log(`active skills: ${getActiveSkills(profile).map(s => s.name).join(', ')}`);

header('TOTAL SYSTEM PROMPT BY CHANNEL');
row('owner DM', ownerFull);
row('colleague DM', colleagueFull);
row('owner-in-group (MPIM)', mpimFull);

header('OWNER DM — DYNAMIC vs STATIC SPLIT (cacheable boundary)');
const skillsSection = buildSkillsPromptSection(profile);
const ownerStatic = skillsSection;
const ownerDynamic = ownerFull.replace(skillsSection, '').trimEnd();
row('dynamic (orchestrator/systemPrompt.ts)', ownerDynamic);
row('static (all skill sections)', ownerStatic);

header('PER-SKILL SECTION SIZE');
for (const skill of getActiveSkills(profile)) {
  try {
    const sec = skill.getSystemPromptSection(profile);
    if (sec) row(skill.name, sec);
  } catch (err) {
    console.log(`${skill.name}: ERR ${String(err)}`);
  }
}

header('OWNER-DM DYNAMIC PROMPT — SECTION BREAKDOWN');
const headings: Array<[string, string]> = [
  ['Header (name/now/timeOfDay)', 'You are '],
  ['DATE LOOKUP', 'DATE LOOKUP'],
  ['WEEK BOUNDARIES', 'WEEK BOUNDARIES'],
  ['LATE NIGHT RULE', 'LATE NIGHT RULE'],
  ['WHAT YOU KNOW ABOUT (prefs+people+catalog)', 'WHAT YOU KNOW ABOUT'],
  ['PENDING APPROVALS', 'PENDING APPROVALS'],
  ['IDENTITY', '\nIDENTITY\n'],
  ['PERSONA BOUNDARY', 'PERSONA BOUNDARY'],
  ['NEVER SOUND LIKE A MACHINE', 'NEVER SOUND LIKE A MACHINE'],
  ['SOCIAL LAYER', 'SOCIAL LAYER'],
  ['LANGUAGE — CURRENT TURN WINS', 'LANGUAGE — CURRENT TURN WINS'],
  ['LANGUAGE OF ARTIFACTS', 'LANGUAGE OF ARTIFACTS'],
  ['STORED PROFILE IS A DEFAULT', 'STORED PROFILE IS A DEFAULT'],
  ['NO INTERNAL DELIBERATION', 'NO INTERNAL DELIBERATION'],
  ['HEBREW OUTPUT', 'HEBREW OUTPUT'],
  ['HEBREW GENDERED FORMS', 'HEBREW GENDERED FORMS'],
  ['SKILLS & CHANNELS', 'SKILLS & CHANNELS'],
  ['EVENT CATEGORIES', 'EVENT CATEGORIES'],
  ['AUTHORIZATION', '\nAUTHORIZATION\n'],
  ['TONE', '\nTONE:'],
  ['SLACK FORMATTING', 'SLACK FORMATTING'],
  ['PUNCTUATION', '\nPUNCTUATION'],
  ['INTERNALS STAY INSIDE YOUR HEAD', 'INTERNALS STAY INSIDE YOUR HEAD'],
  ['CALENDAR ISSUES', 'CALENDAR ISSUES:'],
  ['THREAD MEMORY', 'THREAD MEMORY:'],
  ['OWNERSHIP', 'OWNERSHIP:'],
  ['CHANNELS YOU CAN REACH', 'CHANNELS YOU CAN REACH'],
  ['CALENDAR INVITES vs YOUR OWN', 'CALENDAR INVITES vs YOUR OWN'],
  ['HONESTY RULES', 'HONESTY RULES'],
  ['CONTENT CREATION', 'CONTENT CREATION'],
  ['VOICE / VISION / LEARNING / CORE PERSON', '\nVOICE\n'],
];

const offsets: Array<{ name: string; pos: number }> = [];
for (const [name, needle] of headings) {
  const i = ownerDynamic.indexOf(needle);
  if (i >= 0) offsets.push({ name, pos: i });
}
offsets.sort((a, b) => a.pos - b.pos);
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i].pos;
  const end = i + 1 < offsets.length ? offsets[i + 1].pos : ownerDynamic.length;
  const slice = ownerDynamic.slice(start, end);
  row(offsets[i].name, slice);
}

header('WHAT YOU KNOW ABOUT block — sub-decomposition');
const personaActive = (profile.skills as any)?.persona === true;
const prefs = formatPreferencesForPrompt(profile.user.slack_user_id) || '';
const people = formatPeopleMemoryForPrompt(profile.user.slack_user_id, undefined, personaActive) || '';
const catalog = formatPeopleCatalogSync(profile) || '';
const approvals = getPendingApprovalsForOwner(profile.user.slack_user_id);
row('preferences (formatPreferencesForPrompt)', prefs);
row('people memory (formatPeopleMemoryForPrompt)', people);
row('people catalog (formatPeopleCatalogSync)', catalog);
console.log(`pending approvals count: ${approvals.length}`);

console.log('');
