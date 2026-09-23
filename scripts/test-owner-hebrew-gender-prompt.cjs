// Real buildSystemPromptParts + real people.ts (authoritativeGender,
// formatPeopleMemoryForPrompt) with isolated fixtures: no DB file, no network,
// no model call. Proves the prompt INPUTS for Hebrew gendered address only;
// whether the model obeys them is not exercised here.
// Before run: OWNER_GENDER_PROMPT_SOURCE=<dir holding a preserved src/core/orchestrator/systemPrompt.ts>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const luxon = require('luxon');
const { DateTime } = luxon;
const root = path.resolve(__dirname, '..');
const beforeDir = process.env.OWNER_GENDER_PROMPT_SOURCE;
const noop = () => {};
let rows = [];
let ownerRow = null;
let realDb = null;
const modules = new Map();

function sourceFor(rel) {
  const prior = beforeDir && rel === 'src/core/orchestrator/systemPrompt.ts' ? path.join(root, beforeDir, rel) : null;
  return fs.readFileSync(prior && fs.existsSync(prior) ? prior : path.join(root, rel), 'utf8');
}

function load(rel) {
  if (modules.has(rel)) return modules.get(rel).exports;
  const mod = { exports: {} };
  modules.set(rel, mod);
  const js = ts.transpileModule(sourceFor(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mocks = {
    'src/skills/registry': { getActiveSkills: () => [], getSkillTools: () => [] },
    'src/utils/skillPreferences': { formatSystemPromptPreferenceBlocks: () => '' },
    'src/utils/logger': { __esModule: true, default: { info: noop, warn: noop, debug: noop, error: noop } },
    'src/db/requests': { getAwaitingOwnerRequests: () => [], getOpenRequestsForThread: () => [], getUnrelayedTerminalRequestForThread: () => null },
    'src/core/requests/types': { parseDetails: () => null },
    'src/core/assistantSelf': { formatAssistantSelfForPrompt: () => '' },
    'src/memory/peopleMemory': { formatPeopleCatalogSync: () => '', readPersonMemorySync: () => '' },
    'src/utils/effectiveToday': { getEffectiveToday: p => DateTime.now().setZone(p.user.timezone).startOf('day') },
    'src/connections/registry': { listConnections: () => [] },
    'src/db/client': { getDb: () => realDb ?? ({ prepare: () => ({ all: () => rows, get: () => undefined }) }) },
    'src/db/socialSubjects': { getActiveSubjectsForPerson: () => [], getRecentTopicBeats: () => [] },
    'src/db/engagementRank': { isCurrentRankOwnerAuthored: () => false },
    'src/llm/client': { getAnthropicClient: () => { throw new Error('Unexpected model call'); } },
    'src/llm/models': {},
    'src/config': { config: {} },
    'src/config/userProfile': { getTenantWorkdaysForTimezone: () => undefined },
  };
  function req(spec) {
    if (spec === 'luxon') return luxon;
    const resolved = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) : spec;
    if (resolved === 'src/db') return {
      ...load('src/db/people.ts'),
      formatPreferencesCatalog: () => '',
      formatThreadPeopleBlock: () => '',
      getPersonMemory: id => realDb
        ? realDb.prepare('SELECT * FROM people_memory WHERE slack_id = ?').get(id) ?? null
        : (id === 'UOWNER' ? ownerRow : null),
    };
    if (Object.hasOwn(mocks, resolved)) return mocks[resolved];
    for (const real of ['src/memory/resolveAttendeeEmails', 'src/utils/timezoneConvert', 'src/utils/locationTz', 'src/utils/timezoneValidator', 'src/utils/workingHoursDefault']) {
      if (resolved === real) return load(real + '.ts');
    }
    throw new Error(`Unexpected dependency: ${resolved}`);
  }
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { Date, console, Set, Map }, { filename: rel })(req, mod, mod.exports);
  return mod.exports;
}

const profile = {
  user: { name: 'Owner Example', role: 'Founder', email: 'owner@example.test', slack_user_id: 'UOWNER', timezone: 'Asia/Jerusalem', language: 'en' },
  assistant: { name: 'Maelle', persona: 'A warm and concise professional teammate.' },
  schedule: { office_days: { days: ['Sunday'] }, home_days: { days: ['Monday'] }, day_boundary_hour: '00:00' },
  skills: { social: false },
  channels: {},
};
const person = o => ({ person_id: o.slack_id, kind: 'internal', timezone: 'Asia/Jerusalem', timezone_set_by: 'person',
  notes: '[]', profile_json: '{}', interaction_log: '[]', last_seen: new Date().toISOString(), ...o });
const build = (role = 'owner', senderId = role === 'owner' ? 'UOWNER' : 'UCOLL') =>
  load('src/core/orchestrator/systemPrompt.ts').buildSystemPromptParts(
    profile, role, role === 'owner' ? 'Owner Example' : 'Colleague', false, undefined, false, false, undefined, senderId);

const cases = [
  ['OHG-R01', 'regression', 'owner-confirmed male reaches the owner-turn prompt with his slack_id', () => {
    ownerRow = person({ slack_id: 'UOWNER', name: 'Owner Example', gender: 'male', gender_set_by: 'owner', gender_confirmed: 1 });
    rows = [];
    assert.match(build().dynamic, /Owner Example \(slack_id: UOWNER\), gender: male/);
  }],
  ['OHG-R02', 'regression', 'the incident store state (male, set_by auto) renders as unknown, never guessed', () => {
    ownerRow = person({ slack_id: 'UOWNER', name: 'Owner Example', gender: 'male', gender_set_by: 'auto', gender_confirmed: 0 });
    rows = [];
    const d = build().dynamic;
    assert.match(d, /Owner Example \(slack_id: UOWNER\), gender: unknown/);
    assert.doesNotMatch(d, /gender: male/);
  }],
  ['OHG-R03', 'regression', 'static rule points the owner at his own line and makes a correction call confirm_gender for him too', () => {
    const s = build().static;
    assert.match(s, /HEBREW GENDERED FORMS — apply by the gender field of whoever you address or mention \(Owner's own is under WHAT YOU KNOW\)/);
    assert.match(s, /When they answer, volunteer or correct you \(Owner included\), call confirm_gender\(slack_id, gender\) to lock it\./);
  }],
  ['OHG-R04', 'regression', 'join: owner states his gender -> real confirmPersonGenderById(owner) lifts the auto row -> next owner turn renders male', () => {
    const Sqlite = require('better-sqlite3');
    realDb = new Sqlite(':memory:');
    try {
      realDb.exec(`CREATE TABLE people_memory (person_id TEXT PRIMARY KEY, slack_id TEXT, name TEXT, kind TEXT, gender TEXT,
        gender_set_by TEXT, gender_confirmed INTEGER, updated_at TEXT, last_seen TEXT)`);
      realDb.prepare(`INSERT INTO people_memory VALUES ('p_owner','UOWNER','Owner Example','internal','male','auto',0,NULL,datetime('now'))`).run();
      assert.match(build().dynamic, /\(slack_id: UOWNER\), gender: unknown/);
      assert.equal(load('src/db/people.ts').confirmPersonGenderById('p_owner', 'male', 'owner'), 'applied');
      assert.match(build().dynamic, /Owner Example \(slack_id: UOWNER\), gender: male/);
    } finally { realDb.close(); realDb = null; }
  }],
  ['OHG-P01', 'preserved', 'female-addressee control: a person-confirmed female colleague still renders gender: female', () => {
    ownerRow = person({ slack_id: 'UOWNER', name: 'Owner Example', gender: 'male', gender_set_by: 'owner', gender_confirmed: 1 });
    rows = [person({ slack_id: 'UFEM', name: 'Noa Example', gender: 'female', gender_set_by: 'person', gender_confirmed: 1 })];
    assert.match(build().dynamic, /Noa Example \(.*gender: female/);
  }],
  ['OHG-P02', 'preserved', 'an auto-guessed contact still reads unknown and the neutral-Hebrew rule is intact', () => {
    rows = [person({ slack_id: 'UAUTO', name: 'Dana Example', gender: 'female', gender_set_by: 'auto', gender_confirmed: 0 })];
    const p = build();
    assert.match(p.dynamic, /Dana Example \(.*gender: unknown/);
    assert.match(p.static, /gender: unknown\/unconfirmed → write gender-NEUTRALLY, never default to masculine/);
    assert.match(p.static, /Gender already set → use it\. Never re-ask\./);
  }],
  ['OHG-P03', 'preserved', 'colleague turn: no owner-knowledge block, no owner slack_id line', () => {
    ownerRow = person({ slack_id: 'UOWNER', name: 'Owner Example', gender: 'male', gender_set_by: 'owner', gender_confirmed: 1 });
    rows = [];
    const d = build('colleague').dynamic;
    assert.doesNotMatch(d, /WHAT YOU KNOW ABOUT|slack_id: UOWNER/);
  }],
  ['OHG-P04', 'preserved', 'owner row missing from the store renders unknown, no throw', () => {
    ownerRow = null; rows = [];
    const d = build().dynamic;
    assert.match(d, /WHAT YOU KNOW ABOUT OWNER EXAMPLE/);
    assert.doesNotMatch(d, /gender: (male|female)/);
  }],
];

let passed = 0, failed = 0;
for (const [id, kind, name, fn] of cases) {
  try { fn(); passed++; console.log(`ok ${id} [${kind}] ${name}`); }
  catch (e) { failed++; console.log(`not ok ${id} [${kind}] ${name}\n  ${String(e.message).split('\n')[0]}`); }
}
ownerRow = null; rows = [];
const sized = build();
console.log(`prompt chars (owner DM, empty store): static ${sized.static.length}, dynamic ${sized.dynamic.length}`);
console.log(`${passed} passed; ${failed} failed`);
process.exit(failed ? 1 : 0);
