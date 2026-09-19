// Actual prompt builder; unrelated stores/tool registry are isolated fixtures.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const luxon = require('luxon');
const root = path.resolve(__dirname, '..');
const rel = 'src/core/orchestrator/systemPrompt.ts';
const before = process.env.THREAD_ROSTER_BEFORE;
const source = before ? cp.execFileSync('git', ['show', `${before}:${rel}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, rel), 'utf8');
const noop = () => {};
const people = Object.fromEntries([['UALICE', 'Alice Speaker'], ['UBOB', 'Bob Thread'], ['UCAROL', 'Carol Room']].map(([id, name]) => [id, { person_id: id, name, email: `${id}@private.test`, timezone: 'PRIVATE_TIMEZONE', city: 'PRIVATE_CITY', profile_json: '{}' }]));
const mocks = {
  'src/skills/registry': { getActiveSkills: () => [], getSkillTools: () => [] },
  'src/utils/skillPreferences': { formatSystemPromptPreferenceBlocks: () => 'OWNER_PREFS_PRIVATE' },
  'src/utils/logger': { __esModule: true, default: { info: noop, warn: noop, debug: noop, error: noop } },
  'src/db': { formatPreferencesCatalog: () => 'OWNER_CATALOG_PRIVATE', formatPeopleMemoryForPrompt: () => '', formatThreadPeopleBlock: () => 'DM_PEOPLE_CONTROL', getPersonMemory: id => people[id] ?? null },
  'src/db/requests': { getAwaitingOwnerRequests: () => [], getOpenRequestsForThread: () => [], getUnrelayedTerminalRequestForThread: () => null },
  'src/core/requests/types': { parseDetails: () => null },
  'src/core/assistantSelf': { formatAssistantSelfForPrompt: () => '' },
  'src/memory/peopleMemory': { formatPeopleCatalogSync: () => '', readPersonMemorySync: () => 'SPEAKER_MEMORY_PRIVATE' },
  'src/utils/effectiveToday': { getEffectiveToday: p => luxon.DateTime.now().setZone(p.user.timezone).startOf('day') },
  'src/connections/registry': { listConnections: () => [] },
};
const mod = { exports: {} };
function req(spec) {
  if (spec === 'luxon') return luxon;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
  if (Object.hasOwn(mocks, resolved)) return mocks[resolved];
  throw Error(`Unexpected dependency ${spec}`);
}
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { Date, console, Set, Map }, { filename: rel })(req, mod, mod.exports);
const profile = {
  user: { name: 'Owner Example', role: 'Founder', email: 'owner@example.test', slack_user_id: 'UOWNER', timezone: 'UTC', language: 'en' },
  assistant: { name: 'Maelle', persona: 'A professional teammate.' },
  schedule: { office_days: { days: ['Monday'] }, home_days: { days: ['Tuesday'] }, day_boundary_hour: '00:00' }, skills: { social: false }, channels: {},
};
function build({ role = 'colleague', surface = 'mpim', sender = 'UALICE', members = ['UALICE', 'UBOB', 'UCAROL'], participants, authority = 'colleague' } = {}) {
  return mod.exports.buildSystemPromptParts(profile, role, 'Fixture speaker', authority === 'owner' && surface === 'mpim', undefined, surface === 'mpim', surface === 'channel', 'thread-one', sender, members, undefined, 'slack', authority, participants);
}
function roster(prompt, label) { return prompt.dynamic.split('\n').find(line => line.startsWith(label)) ?? ''; }
if (process.env.THREAD_ROSTER_MEASURE === '1') {
  const p = build({ participants: ['UALICE', 'UBOB'] });
  console.log('PROMPT_MEASURE ' + JSON.stringify({ fixture: 'MPIM Alice/Bob thread, Carol room only', staticCharacters: p.static.length, dynamicCharacters: p.dynamic.length, utf8Bytes: Buffer.byteLength(p.static + p.dynamic) }));
}

test('MPIM full room roster is preserved separately from observed thread participants', () => {
  const p = build({ participants: ['UALICE', 'UBOB'] });
  assert.match(roster(p, 'ROOM MEMBERS:'), /Alice Speaker, Bob Thread, Carol Room/);
  assert.match(roster(p, 'OBSERVED THREAD PARTICIPANTS:'), /Alice Speaker, Bob Thread/);
  assert.doesNotMatch(roster(p, 'OBSERVED THREAD PARTICIPANTS:'), /Carol Room/);
  assert.doesNotMatch(p.dynamic, /PEOPLE IN THIS THREAD:.*Carol Room/);
});
test('missing thread observations retain only the authenticated speaker as observed', () => {
  const p = build();
  assert.match(roster(p, 'OBSERVED THREAD PARTICIPANTS:'), /Alice Speaker/);
  assert.doesNotMatch(roster(p, 'OBSERVED THREAD PARTICIPANTS:'), /Bob Thread|Carol Room/);
  assert.match(roster(p, 'ROOM MEMBERS:'), /Bob Thread|Carol Room/);
});
test('channel prompt uses observed speakers without requiring MPIM membership', () => {
  const p = build({ surface: 'channel', members: [], participants: ['UBOB', 'UALICE'] });
  assert.match(roster(p, 'OBSERVED THREAD PARTICIPANTS:'), /Bob Thread, Alice Speaker/);
  assert.equal(roster(p, 'ROOM MEMBERS:'), '');
});
test('owner contribution and repeated speaker IDs remain an accurate unique thread roster', () => {
  const p = build({ sender: 'UOWNER', authority: 'owner', participants: ['UBOB', 'UBOB', 'UOWNER'] });
  const line = roster(p, 'OBSERVED THREAD PARTICIPANTS:');
  assert.match(line, /Bob Thread, Owner Example/); assert.equal(line.split('Bob Thread').length - 1, 1);
  assert.doesNotMatch(line, /Carol Room/);
});
test('unknown observed identities never substitute unrelated room members', () => {
  const p = build({ sender: 'UUNKNOWN', participants: ['UUNKNOWN'] });
  assert.equal(roster(p, 'OBSERVED THREAD PARTICIPANTS:'), '');
  assert.match(roster(p, 'ROOM MEMBERS:'), /Carol Room/);
});
test('shared surface keeps names but withholds contact and private memory fields', () => {
  for (const surface of ['mpim', 'channel']) {
    const p = build({ surface, participants: ['UALICE', 'UBOB'] });
    assert.match(p.dynamic, /Alice Speaker/);
    assert.doesNotMatch(p.static + p.dynamic, /@private.test|PRIVATE_TIMEZONE|PRIVATE_CITY|OWNER_PREFS_PRIVATE|OWNER_CATALOG_PRIVATE|SPEAKER_MEMORY_PRIVATE|DM_PEOPLE_CONTROL/);
  }
});
test('colleague DM retains its existing contact and speaker memory path', () => {
  const p = build({ surface: 'dm', members: undefined });
  assert.match(p.dynamic, /DM_PEOPLE_CONTROL/); assert.match(p.dynamic, /UALICE@private.test/); assert.match(p.dynamic, /SPEAKER_MEMORY_PRIVATE/);
  assert.doesNotMatch(p.dynamic, /ROOM MEMBERS:|OBSERVED THREAD PARTICIPANTS:/);
});
test('owner DM retains private context without introducing a room roster', () => {
  const p = build({ surface: 'dm', role: 'owner', sender: 'UOWNER', authority: 'owner' });
  assert.match(p.static + p.dynamic, /OWNER_PREFS_PRIVATE|OWNER_CATALOG_PRIVATE/);
  assert.doesNotMatch(p.dynamic, /ROOM MEMBERS:|OBSERVED THREAD PARTICIPANTS:/);
});
