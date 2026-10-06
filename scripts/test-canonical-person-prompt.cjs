// Actual prompt caller + canonical reader over the shared isolated SQLite fixture.
// PERSON_MEMORY_SNAPSHOT selects preserved caller sources; no network/model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), luxon = require('luxon');
const { harness, chris } = require('./person-memory-test-harness.cjs');
const root = path.resolve(__dirname, '..');
const rel = 'src/core/orchestrator/systemPrompt.ts';
const prior = process.env.PERSON_MEMORY_SNAPSHOT && path.join(root, process.env.PERSON_MEMORY_SNAPSHOT, rel);
const code = ts.transpileModule(fs.readFileSync(prior && fs.existsSync(prior) ? prior : path.join(root, rel), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function fixture() {
  const h = harness([chris, { slack_id: 'UOTHER99', name: 'Unrelated Contact' }]);
  h.profile.schedule = { office_days: { days: ['Monday'] }, home_days: { days: ['Tuesday'] }, day_boundary_hour: '00:00' };
  h.profile.channels = {};
  h.p().appendPersonNoteById('p_UCHRIS99', 'PERSON SHARED NOTE', 'person');
  h.p().appendPersonNoteById('p_UCHRIS99', 'OWNER PRIVATE NOTE', 'owner');
  const row = h.p().getPersonById('p_UCHRIS99');
  h.sqlite.prepare('UPDATE people_memory SET notes=? WHERE person_id=?').run(JSON.stringify([
    ...JSON.parse(row.notes), { date: '', note: 'UNKNOWN AUTHOR NOTE' },
  ]), row.person_id);
  h.p().updatePersonProfile(chris.slack_id, { role_summary: 'Confirmed engineer' }, 'person');
  const noop = () => {};
  let spoof = false;
  const mocks = {
    '../../skills/registry': { getActiveSkills: () => [], getSkillTools: () => [] },
    '../../utils/skillPreferences': { formatSystemPromptPreferenceBlocks: () => '' },
    '../../utils/logger': { __esModule: true, default: { info: noop, warn: noop, debug: noop, error: noop } },
    '../../db': { ...h.p(), formatPreferencesCatalog: () => '', formatPeopleMemoryForPrompt: () => '', formatThreadPeopleBlock: () => '',
      getPersonMemory: id => spoof ? h.p().getPersonById('p_UCHRIS99') : h.p().getPersonMemory(id) },
    '../../db/requests': { getAwaitingOwnerRequests: () => [], getOpenRequestsForThread: () => [], getUnrelayedTerminalRequestForThread: () => null },
    '../requests/types': { parseDetails: () => null },
    '../assistantSelf': { formatAssistantSelfForPrompt: () => '' },
    '../../memory/peopleMemory': h.load('src/memory/peopleMemory.ts'),
    '../../utils/effectiveToday': { getEffectiveToday: () => luxon.DateTime.fromISO('2026-10-06', { zone: 'Asia/Jerusalem' }) },
    '../../connections/registry': { listConnections: () => [] },
    luxon,
  };
  const mod = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Date, console, Set, Map }, { filename: rel })(
    name => { if (!(name in mocks)) throw Error('Unexpected dependency: ' + name); return mocks[name]; }, mod, mod.exports);
  const prompt = (sender = chris.slack_id, role = 'colleague', mpim = false, channel = false) => {
    const result = mod.exports.buildSystemPromptParts(h.profile, role, 'Speaker', false, undefined, mpim, channel, undefined, sender);
    return result.static + result.dynamic;
  };
  return { h, prompt, spoof: () => { spoof = true; } };
}

test('authenticated colleague DM receives canonical shared facts and history after restart', () => {
  const { h, prompt } = fixture();
  h.p().appendPersonInteractionById('p_UCHRIS99', { type: 'coordination', summary: 'Canonical work exchange' });
  for (let i = 0; i < 2; i++) {
    const content = prompt();
    assert.match(content, /PERSON SHARED NOTE/);
    assert.match(content, /Confirmed engineer/);
    assert.match(content, /Canonical work exchange/);
    assert.doesNotMatch(content, /OWNER PRIVATE NOTE|UNKNOWN AUTHOR NOTE|Unrelated Contact/);
    h.restart();
  }
});

test('owner catalog and owner read use canonical identities and retain private notes', async () => {
  const { h, prompt } = fixture();
  assert.match(prompt('UOWNER99', 'owner'), /Christian Ray \[p_UCHRIS99\]/);
  const result = await h.tool('get_person_memory', { person: chris.name });
  assert.match(JSON.stringify(result), /OWNER PRIVATE NOTE/);
  assert.match(JSON.stringify(result), /UNKNOWN AUTHOR NOTE/);
});

test('room, missing identity and mismatched identity never receive the self view', () => {
  const { prompt, spoof } = fixture();
  for (const text of [prompt(chris.slack_id, 'colleague', true), prompt(chris.slack_id, 'colleague', false, true),
    prompt('UOWNER99', 'colleague', true), prompt('UOWNER99', 'colleague', false, true)]) {
    assert.doesNotMatch(text, /PERSON SHARED NOTE|OWNER PRIVATE NOTE|UNKNOWN AUTHOR NOTE/);
  }
  assert.doesNotMatch(prompt(''), /PERSON SHARED NOTE|OWNER PRIVATE NOTE|UNKNOWN AUTHOR NOTE/);
  spoof();
  assert.doesNotMatch(prompt('UOTHER99'), /PERSON SHARED NOTE|OWNER PRIVATE NOTE|UNKNOWN AUTHOR NOTE/);
});

test('unavailable canonical DB fails visibly without stale file context', () => {
  const { h, prompt } = fixture();
  h.sqlite.close();
  assert.throws(() => prompt());
});

test('native tool schema retires section writer and retains canonical writers', () => {
  const { h, prompt } = fixture();
  h.load('src/utils/skillPreferences.ts').PREF_SKILLS = ['general'];
  const tools = new (h.load('src/core/assistant.ts').AssistantSkill)().getTools(h.profile);
  assert.ok(tools.some(t => t.name === 'update_person_profile'));
  assert.ok(tools.some(t => t.name === 'log_interaction'));
  assert.ok(tools.some(t => t.name === 'get_person_memory'));
  assert.ok(!tools.some(t => t.name === 'update_person_memory'));
  assert.doesNotMatch(JSON.stringify(tools) + prompt('UOWNER99', 'owner'), /update_person_memory|mirror_synced|their markdown notes/);
});
