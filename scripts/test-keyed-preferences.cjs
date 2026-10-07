// Real preference persistence and prompt assembly, isolated filesystem/profile.
// PREFERENCE_BEFORE_REV loads preserved git source without modifying the checkout.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const ts = require('typescript');
const luxon = require('luxon');
const root = path.resolve(__dirname, '..');
const before = process.env.PREFERENCE_BEFORE_REV;
const noop = () => {};

function source(rel) {
  return before ? execFileSync('git', ['show', `${before}:${rel}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, rel), 'utf8');
}
function fixture() {
  // Preserve the actual atomic-rename path without Windows sandbox temp EPERM.
  const dir = fs.mkdtempSync(path.join(root, '.maelle-preference-safety-'));
  const cleanup=()=>{const target=path.resolve(dir);assert.equal(path.dirname(target),root);assert.ok(path.basename(target).startsWith('.maelle-preference-safety-'));fs.rmSync(target,{recursive:true,force:true});};
  const modules = new Map();
  const faults = { read: false, rename: false };
  const profile = {
    user: { name: 'Alex Smith', role: 'Founder', email: 'alex@example.test', slack_user_id: 'UOWNER', timezone: 'UTC', language: 'en' },
    assistant: { name: 'Maelle', persona: 'PERSONA_FIXTURE professional and concise.' },
    schedule: { office_days: { days: ['Monday'] }, home_days: { days: ['Tuesday'] }, day_boundary_hour: '00:00' },
    skills: { social: false }, channels: {},
  };
  let active = ['meetings', 'summary', 'knowledge', 'search', 'venue'];
  const file = (area, name = 'alex') => path.join(dir, 'config', 'users', `${name}_prefs`, `${area}.md`);
  function seed(area, text, name = 'alex') { fs.mkdirSync(path.dirname(file(area, name)), { recursive: true }); fs.writeFileSync(file(area, name), text); }
  const wrappedFs = {
    ...fs,
    readFileSync: (...args) => { if (faults.read && String(args[0]).startsWith(dir)) throw Object.assign(new Error('fixture unavailable'), { code: 'EACCES' }); return fs.readFileSync(...args); },
    promises: { ...fs.promises, rename: async (...args) => { if (faults.rename) throw new Error('fixture rename failed'); return fs.promises.rename(...args); } },
  };
  function load(rel) {
    if (modules.has(rel)) return modules.get(rel).exports;
    const mod = { exports: {} }; modules.set(rel, mod);
    const js = ts.transpileModule(source(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mocks = {
      'src/utils/logger': { __esModule: true, default: { info: noop, warn: noop, debug: noop, error: noop } },
      'src/skills/registry': { getActiveSkills: () => active.map(id => ({ id, name: id, getTools: () => [{ name: `tool_${id}` }], getSystemPromptSection: () => `DEFAULT_${id}` })), getSkillTools: () => active.map(id => ({ name: `tool_${id}` })) },
      'src/db': { formatPreferencesCatalog: () => 'PRIVATE_CATALOG_FIXTURE', formatPeopleMemoryForPrompt: () => '', formatThreadPeopleBlock: () => '', getPersonMemory: () => null },
      'src/db/requests': { getAwaitingOwnerRequests: () => [], getOpenRequestsForThread: () => [], getUnrelayedTerminalRequestForThread: () => null },
      'src/core/requests/types': { parseDetails: () => null },
      'src/core/assistantSelf': { formatAssistantSelfForPrompt: () => '' },
      'src/memory/peopleMemory': { formatPeopleCatalogSync: () => '', readPersonMemorySync: () => '' },
      'src/utils/effectiveToday': { getEffectiveToday: p => luxon.DateTime.now().setZone(p.user.timezone).startOf('day') },
      'src/connections/registry': { listConnections: () => [] },
    };
    function req(spec) {
      if (spec === 'fs') return wrappedFs;
      if (['path', 'crypto', 'luxon'].includes(spec)) return require(spec);
      const resolved = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) : spec;
      if (resolved === 'src/utils/skillPreferences') return load(resolved + '.ts');
      if (Object.hasOwn(mocks, resolved)) return mocks[resolved];
      throw new Error(`Unexpected dependency ${resolved}`);
    }
    vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { process: { cwd: () => dir }, Buffer, Date, console, Set, Map }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  const prefs = load('src/utils/skillPreferences.ts');
  // Adapter lets old writers receive the same revision and expose actual unsafe writes.
  const revision = area => crypto.createHash('sha256').update(fs.existsSync(file(area)) ? fs.readFileSync(file(area)) : '').digest('hex');
  const write = (area, mode, text, expectedRevision) => prefs.writeSkillPreferences(profile, area, mode, text, { expectedRevision });
  const prompt = (role = 'owner', scopes, surface = 'dm', authority = role) => load('src/core/orchestrator/systemPrompt.ts').buildSystemPromptParts(profile, role, role === 'owner' ? 'Alex' : 'Colleague', surface === 'mpim' && authority === 'owner', undefined, surface === 'mpim', surface === 'room', undefined, authority === 'owner' ? 'UOWNER' : 'UCOLLEAGUE', [], scopes, 'slack', authority);
  return { dir, prefs, profile, faults, file, seed, revision, write, prompt, reloadPreferences: () => { modules.delete('src/utils/skillPreferences.ts'); return load('src/utils/skillPreferences.ts'); }, setActive: ids => { active = ids; }, cleanup };
}
function scenario(name, run) { test(name, async () => { const f = fixture(); try { await run(f); } finally { f.cleanup(); } }); }

const entry = (key = 'tone', extra = {}) => ({ key, category: 'communication', source: 'user_taught', condition: null, value: 'Be concise', ...extra });
const fence = e => '```maelle-preference-v1\n' + JSON.stringify(e) + '\n```';
const read = f => f.prefs.readKeyedPreferences(f.profile);
const put = (f, e, skill = 'general', opts = {}) => f.prefs.writeKeyedPreference(f.profile, skill, e, { expectedRevision: read(f).revision, ...opts });

scenario('plain prose and scope remain preserved', async f => {
  f.seed('summary', 'ONLY_SUMMARY');
  assert.equal(f.prefs.readSkillPreferences(f.profile, 'summary'), 'ONLY_SUMMARY');
  assert.doesNotMatch(f.prompt('owner', ['meetings']).static, /ONLY_SUMMARY/);
  assert.doesNotMatch(f.prompt('colleague', ['summary']).static, /ONLY_SUMMARY/);
  assert.doesNotMatch(f.prompt('colleague', ['summary'], 'room').static, /ONLY_SUMMARY/);
});
scenario('whole-file stale revision refuses overwrite', async f => {
  f.seed('general', 'before'); const rev = f.revision('general');
  await f.write('general', 'add', 'Distinct new teaching');
  assert.equal((await f.write('general', 'replace', 'lost', rev)).error, 'revision_conflict');
});
scenario('keyed CRUD preserves prose bytes and survives restart', async f => {
  const prose = '  # Notes\r\nРусский עברית\r\n  \r\n'; f.seed('general', prose);
  assert.equal((await put(f, entry())).ok, true);
  assert.ok(fs.readFileSync(f.file('general'), 'utf8').startsWith(prose));
  assert.equal(f.reloadPreferences().readKeyedPreferences(f.profile).entries[0].key, 'tone');
  assert.equal((await put(f, entry('tone', { value: 'Use paragraphs' }))).ok, true);
  assert.equal((await f.prefs.forgetKeyedPreference(f.profile, 'tone', { expectedRevision: read(f).revision })).ok, true);
  assert.equal(fs.readFileSync(f.file('general'), 'utf8'), prose + '\n');
});
scenario('render values once with provenance and semantic condition', f => {
  f.seed('summary', fence(entry('a')) + '\n' + fence(entry('b', { source: 'inferred', category: 'summary_type_custom', condition: { summaryType: 'custom' }, value: 'Include decisions' })));
  const rendered = f.prefs.readSkillPreferences(f.profile, 'summary');
  assert.match(rendered, /Explicit: Be concise/); assert.match(rendered, /Inferred \(inferred\); apply when summary type is "custom": Include decisions/);
  assert.doesNotMatch(rendered, /maelle-preference|"category"/);
  assert.equal(rendered.split('Include decisions').length, 2);
});
scenario('owner-wide duplicate and malformed files refuse every mutation', async f => {
  f.seed('general', fence(entry())); f.seed('summary', fence(entry()));
  assert.equal(read(f).error, 'duplicate_key');
  assert.equal((await f.write('news', 'add', 'Safe new prose')).error, 'duplicate_key');
  f.seed('summary', '```maelle-preference-v1\ninvalid');
  assert.equal(read(f).error, 'malformed_preference');
  assert.equal((await f.write('general', 'replace', '', f.revision('general'))).error, 'malformed_preference');
});
scenario('import retries are idempotent and conflicts never overwrite', async f => {
  const rev = read(f).revision;
  assert.equal((await put(f, entry(), 'general', { expectedRevision: rev, importOnly: true })).ok, true);
  assert.equal((await put(f, entry(), 'general', { expectedRevision: rev, importOnly: true })).unchanged, true);
  assert.equal((await put(f, entry('tone', { value: 'Different' }), 'general', { importOnly: true })).error, 'import_conflict');
  assert.equal((await put(f, entry(), 'summary')).error, 'key_destination_conflict');
});
scenario('owner serialization makes concurrent stale write lose', async f => {
  const rev = read(f).revision;
  const results = await Promise.all([put(f, entry('a'), 'general', { expectedRevision: rev }), put(f, entry('b'), 'summary', { expectedRevision: rev })]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.filter(r => r.error === 'revision_conflict').length, 1);
});
scenario('unavailable reads and failed atomic save cannot report success', async f => {
  f.faults.read = true; assert.equal(read(f).error, 'read_failed'); f.faults.read = false;
  f.faults.rename = true; assert.equal((await put(f, entry())).error, 'write_failed');
  assert.equal(read(f).entries.length, 0); f.faults.rename = false; assert.equal((await put(f, entry())).ok, true);
});
scenario('limits and whole-file duplicate introduction refuse and retain state', async f => {
  assert.equal((await put(f, entry('huge', { value: 'a'.repeat(16384) }))).error, 'too_large');
  assert.equal((await put(f, entry())).ok, true);
  assert.equal((await f.write('summary', 'replace', fence(entry()), f.revision('summary'))).error, 'duplicate_key');
  assert.equal(read(f).entries.length, 1);
});

