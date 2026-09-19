// Real preference persistence and prompt assembly, isolated filesystem/profile.
// PREFERENCE_BEFORE_REV loads preserved git source without modifying the checkout.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maelle-preference-safety-'));
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
  return { dir, prefs, profile, faults, file, seed, revision, write, prompt, reloadPreferences: () => { modules.delete('src/utils/skillPreferences.ts'); return load('src/utils/skillPreferences.ts'); }, setActive: ids => { active = ids; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function scenario(name, run) { test(name, async () => { const f = fixture(); try { await run(f); } finally { f.cleanup(); } }); }

scenario('read exposes full brief text even when absent from chat scope', f => {
  f.seed('brief', '- Greet warmly\n- Keep icons 🙂\n');
  assert.doesNotMatch(f.prompt('owner', ['meetings']).static, /Greet warmly/);
  const read = f.prefs.readSkillPreferencesSnapshot(f.profile, 'brief');
  assert.equal(read.ok, true); assert.equal(read.text, '- Greet warmly\n- Keep icons 🙂\n'); assert.equal(read.revision, f.revision('brief'));
});
scenario('replacement without a revision cannot erase unseen lines', async f => {
  f.seed('brief', '- Keep icons\n- Add spacing\n');
  const result = await f.write('brief', 'replace', '- Greet warmly');
  assert.equal(result.ok, false); assert.equal(result.error, 'revision_required');
  assert.equal(fs.readFileSync(f.file('brief'), 'utf8'), '- Keep icons\n- Add spacing\n');
});
scenario('stale replacement preserves a concurrently appended preference', async f => {
  f.seed('brief', '- Keep icons\n'); const rev = f.revision('brief');
  await f.write('brief', 'add', 'Space paragraphs generously');
  const result = await f.write('brief', 'replace', '- Greet warmly', rev);
  assert.equal(result.ok, false); assert.equal(result.error, 'revision_conflict'); assert.match(result.current.text, /Space paragraphs/);
});
scenario('concurrent replacements allow one winner and return current state to loser', async f => {
  f.seed('brief', '- Keep icons\n'); const rev = f.revision('brief');
  const results = await Promise.all([f.write('brief', 'replace', '- Greeting A', rev), f.write('brief', 'replace', '- Greeting B', rev)]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.filter(r => r.error === 'revision_conflict').length, 1);
});
scenario('empty replacement can remove the final preference', async f => {
  f.seed('brief', '- Keep icons\n');
  const result = await f.write('brief', 'replace', '', f.revision('brief'));
  assert.equal(result.ok, true); assert.equal(f.prefs.readSkillPreferences(f.profile, 'brief'), '');
});
scenario('replacement retry retains the original recovery backup', async f => {
  f.seed('brief', '- Before\n'); const rev = f.revision('brief');
  await f.write('brief', 'replace', '- After', rev);
  const result = await f.write('brief', 'replace', '- After', rev);
  assert.equal(result.ok, true); assert.equal(fs.readFileSync(f.file('brief') + '.bak', 'utf8'), '- Before\n');
});
scenario('valid replacement preserves unrelated text and arbitrary multilingual formatting', async f => {
  f.seed('brief', '- Keep icons 🙂\n- Espacios entre párrafos\n');
  const text = '- Keep icons 🙂\n- Espacios entre párrafos\n- ברכה קצרה';
  const result = await f.write('brief', 'replace', text, f.revision('brief'));
  assert.equal(result.ok, true); assert.equal(f.prefs.readSkillPreferences(f.profile, 'brief'), text);
});
scenario('replace preserves exact indentation blank lines emoji and trailing bytes', async f => {
  f.seed('brief', '- Old\n');
  const text = '  פתיחה 🙂\n\n| item | rule |\n| --- | --- |\n\n';
  const result = await f.write('brief', 'replace', text, f.revision('brief'));
  assert.equal(result.ok, true); assert.equal(fs.readFileSync(f.file('brief'), 'utf8'), text);
});
scenario('concurrent append and exact retry preserve each independent instruction', async f => {
  await Promise.all([f.write('brief', 'add', 'Greet warmly'), f.write('brief', 'add', 'Separate paragraphs')]);
  const result = await f.write('brief', 'add', 'Greet warmly');
  assert.equal(result.duplicate, true); assert.equal(f.prefs.readSkillPreferences(f.profile, 'brief').split('\n').length, 2);
});
scenario('rename failure leaves durable content intact and retry can complete', async f => {
  f.seed('brief', '- Original\n'); const rev = f.revision('brief'); f.faults.rename = true;
  assert.equal((await f.write('brief', 'replace', '- Updated', rev)).ok, false);
  assert.equal(fs.readFileSync(f.file('brief'), 'utf8'), '- Original\n');
  f.faults.rename = false; assert.equal((await f.write('brief', 'replace', '- Updated', rev)).ok, true);
});
scenario('unavailable read is an error rather than an empty editable document', async f => {
  f.seed('brief', '- Original\n'); f.faults.read = true;
  assert.equal(f.prefs.readSkillPreferencesSnapshot(f.profile, 'brief').error, 'read_failed');
  assert.equal((await f.write('brief', 'replace', '- Updated', 'guessed')).ok, false);
  assert.equal(fs.readFileSync(f.file('brief'), 'utf8'), '- Original\n');
});
scenario('fresh empty snapshot supports first replacement with a durable content revision', async f => {
  const read = f.prefs.readSkillPreferencesSnapshot(f.profile, 'brief');
  assert.equal(read.ok, true); assert.equal(read.exists, false); assert.equal(read.text, '');
  const result = await f.write('brief', 'replace', '- First instruction', read.revision);
  assert.equal(result.ok, true); assert.equal(result.created, true);
  // Persisted bytes are sufficient for any later process to derive the revision;
  // revision safety has no volatile token registry or additional stored shape.
  assert.equal(result.revision, f.revision('brief'));
  assert.equal(f.reloadPreferences().readSkillPreferencesSnapshot(f.profile, 'brief').revision, result.revision);
});
scenario('invalid skill and over-limit append leave stored content intact', async f => {
  f.seed('brief', '- Original\n');
  assert.equal((await f.write('../escape', 'add', 'Bad')).ok, false);
  assert.equal((await f.write('brief', 'add', 'x'.repeat(17000))).error, 'too_large');
  assert.equal(fs.readFileSync(f.file('brief'), 'utf8'), '- Original\n');
});
scenario('owner prompt receives scoped text exactly once and after defaults', f => {
  f.seed('general', 'GENERAL_PRIVATE_MARKER'); f.seed('meetings', 'MEETINGS_PRIVATE_MARKER'); f.seed('summary', 'SUMMARY_PRIVATE_MARKER');
  const p = f.prompt('owner', ['meetings']);
  assert.equal(p.static.split('GENERAL_PRIVATE_MARKER').length - 1, 1);
  assert.equal(p.static.split('MEETINGS_PRIVATE_MARKER').length - 1, 1);
  assert.doesNotMatch(p.static, /SUMMARY_PRIVATE_MARKER/); assert.ok(p.static.indexOf('MEETINGS_PRIVATE_MARKER') > p.static.indexOf('DEFAULT_meetings'));
  assert.match(p.static, /UNLESS a hard rule or safety guard blocks it/); assert.match(p.dynamic, /PRIVATE_CATALOG_FIXTURE/);
});
scenario('colleague and clamped owner shared prompts omit all private preference payloads', f => {
  f.seed('general', 'GENERAL_PRIVATE_MARKER'); f.seed('meetings', 'MEETINGS_PRIVATE_MARKER');
  for (const [surface, authority] of [['dm', 'colleague'], ['mpim', 'colleague'], ['mpim', 'owner'], ['room', 'owner'], ['room', undefined]]) {
    const p = f.prompt('colleague', undefined, surface, authority);
    assert.doesNotMatch(p.static + p.dynamic, /PRIVATE_MARKER|PRIVATE_CATALOG_FIXTURE/);
  }
});
scenario('fresh reads change the next cacheable prefix without stale text', async f => {
  f.seed('meetings', 'OLD_PRIVATE_MARKER'); const p1 = f.prompt('owner', ['meetings']);
  await f.write('meetings', 'replace', 'NEW_PRIVATE_MARKER', f.revision('meetings'));
  const p2 = f.prompt('owner', ['meetings']);
  assert.notEqual(p1.static, p2.static); assert.match(p2.static, /NEW_PRIVATE_MARKER/); assert.doesNotMatch(p2.static, /OLD_PRIVATE_MARKER/);
});
scenario('disabled skill and fresh owner do not receive another area preferences', f => {
  assert.doesNotMatch(f.prompt().static, /he taught these/);
  f.seed('summary', 'SUMMARY_PRIVATE_MARKER'); f.setActive(['meetings']);
  assert.doesNotMatch(f.prompt('owner', ['general']).static, /SUMMARY_PRIVATE_MARKER/);
});

// Explicitly documents the deferred migration hazard, without certifying isolation.
if (process.env.PREFERENCE_COLLISION_DIAGNOSTIC === '1') scenario('diagnostic: same-first-name profiles currently alias the private directory', f => {
  f.seed('general', 'FIRST_OWNER_PRIVATE');
  const secondOwner = { ...f.profile, user: { ...f.profile.user, name: 'Alex Jones', slack_user_id: 'UOTHER' } };
  assert.equal(f.prefs.readSkillPreferences(secondOwner, 'general'), 'FIRST_OWNER_PRIVATE');
});
