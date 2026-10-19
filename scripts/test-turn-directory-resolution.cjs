// Whole turn builder + real stored-name resolver + actual Connection directory.
// Existing strict turn fixture isolates unrelated services; provider replies are fake.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
function compile(file, mocks) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})(name => {
    assert.ok(Object.hasOwn(mocks, name), `declared dependency ${file}: ${name}`); return mocks[name];
  }, mod, mod.exports);
  return mod.exports;
}
let fixtureSource = fs.readFileSync(path.join(__dirname, 'test-turn-context-boundaries.cjs'), 'utf8');
fixtureSource = fixtureSource.replace("const prefix = 'artifacts/workshop-verification/slack-audit-20260919/handyman';", "const prefix = 'artifacts/workshop-verification/minor-5.2.0/handyman/identity';")
  .replace('function fixture(t) {', 'function fixture(t, extraMocks = {}) {')
  .replace('  const modules = new Map();', '  Object.assign(mocks, extraMocks);\n  const modules = new Map();');
const fixtureModule = { exports: {} };
vm.runInNewContext('(function(require,module,exports,__dirname){' + fixtureSource + '\nmodule.exports={fixture};})',
  { console, process, Date, Map, Set, Buffer })(name => name === 'node:test' ? { test() {} } : require(require.resolve(name, { paths: [__dirname] })),
  fixtureModule, fixtureModule.exports, __dirname);
const logger = { __esModule: true, default: { info() {}, warn() {}, error() {} } };
const rows = [
  { slack_id: 'UDANIEL01', name: 'Daniel One', email: 'daniel.one@example.test' },
  { slack_id: 'UDANIEL02', name: 'Daniel Two', email: 'daniel.two@example.test' },
  { name: 'Daniel External', email: 'daniel@external.test' },
];
function setup(t, options = {}) {
  const memoryRows = options.rows || rows;
  const memory = { searchPeopleMemory: () => memoryRows, getPersonByEmail: email => memoryRows.find(r => r.email === email) };
  const resolver = compile('src/memory/resolveAttendeeEmails.ts', { '../db/people': memory, '../utils/logger': logger });
  const calls = [];
  const connectionModule = compile('src/connections/slack/index.ts', {
    './messaging': {}, './formatting': {}, './eligibility': {}, '../../db': memory, '../../utils/logger': logger,
  });
  const connection = connectionModule.createSlackConnection({ client: { users: {
    info: async ({ user }) => {
      calls.push(user); if (options.unavailable) throw Error('provider unavailable');
      return { ok: true, user: { deleted: options.ambiguous ? false : user === 'UDANIEL02' } };
    }, list: async () => ({ ok: true, members: [] }),
  } } }, 'fixture', { user: { email: 'owner@example.test' } });
  const lookups = [];
  const f = fixtureModule.exports.fixture(t, {
    'src/memory/resolveAttendeeEmails.ts': resolver,
    'src/connections/registry.ts': { listConnections: () => [], getConnection: () => options.absent ? null : {
      executeToolCall: (...args) => { lookups.push(args); return connection.executeToolCall(...args); },
    } },
  });
  f.state.meetingPeople = [options.name || 'Daniel'];
  return { ...f, calls, lookups };
}
for (const role of ['owner', 'colleague']) for (const participation of ['optional', 'required']) {
  test(`current ${role} ${participation} participant resolves before generation without becoming mandatory`, async t => {
    const f = setup(t); const r = await f.run({ userMessage: `Schedule with Daniel as ${participation}.`,
      senderRole: role, authority: role, userId: role === 'owner' ? 'UOWNER' : 'UACTIVE', surface: role === 'owner' ? 'owner_dm' : 'colleague_dm' });
    assert.equal(f.lookups.length, 1); assert.equal(f.calls.length, 2);
    assert.ok(r.prompt.includes('Daniel One <daniel.one@example.test>'));
    assert.ok(!r.prompt.includes('NOT matched to an internal colleague: Daniel'));
    assert.equal(r.resolvedMeetingAttendees.length, 0, 'contact identity cannot decide required participation');
    assert.equal(f.lookups[0][2].surface, role === 'owner' ? 'owner_dm' : 'colleague_dm');
  });
}
test('genuine two active people remain ambiguous', async t => {
  const f = setup(t, { ambiguous: true }); const r = await f.run({ userMessage: 'Schedule with Daniel.' });
  assert.equal(r.resolvedMeetingAttendees.length, 0);
  assert.ok(r.prompt.includes('NOT matched to an internal colleague: Daniel'));
  assert.ok(!r.prompt.includes('Daniel One <daniel.one@example.test>'));
});
for (const option of ['unavailable', 'absent']) test(`${option} directory does not invent a resolved contact`, async t => {
  const f = setup(t, { [option]: true }); const r = await f.run({ userMessage: 'Schedule with Daniel.' });
  assert.equal(r.resolvedMeetingAttendees.length, 0); assert.ok(r.prompt.includes('NOT matched to an internal colleague: Daniel'));
  assert.ok(!r.prompt.includes('Daniel One <daniel.one@example.test>'));
});
test('substring candidate never binds as whole-name person', async t => {
  const f = setup(t, { name: 'Dan', rows: [rows[0]] }); const r = await f.run({ userMessage: 'Schedule with Dan.' });
  assert.equal(r.resolvedMeetingAttendees.length, 0); assert.ok(!r.prompt.includes('Daniel One <daniel.one@example.test>'));
});
test('external contact never becomes internal directory identity', async t => {
  const f = setup(t, { rows: [{ ...rows[0], email: 'daniel@external.test' }] });
  const r = await f.run({ userMessage: 'Schedule with Daniel.' });
  assert.equal(r.resolvedMeetingAttendees.length, 0); assert.ok(!r.prompt.includes('<daniel@external.test>'));
});
test('room projection never exposes the directory contact email', async t => {
  const f = setup(t); const r = await f.run({ userMessage: 'Schedule with Daniel.', isChannel: true,
    senderRole: 'colleague', authority: 'colleague', userId: 'UACTIVE', surface: 'room' });
  assert.equal(r.resolvedMeetingAttendees.length, 0); assert.ok(!r.prompt.includes('daniel.one@example.test'));
});
test('history-only name fails current raw-message gate before any lookup', async t => {
  const f = setup(t); const r = await f.run({ userMessage: 'Schedule with Daniel.', rawUserMessage: 'Show my options.' });
  assert.equal(f.lookups.length, 0); assert.equal(r.resolvedMeetingAttendees.length, 0);
});
test('existing unambiguous stored required participant keeps its search union', async t => {
  const f = setup(t, { rows: [rows[0]] }); const r = await f.run({ userMessage: 'Schedule with Daniel.' });
  assert.equal(f.lookups.length, 0); assert.ok(r.resolvedMeetingAttendees.includes('daniel.one@example.test'));
});
test('repeat read checks current eligibility again without durable mutations', async t => {
  const f = setup(t); const input = { userMessage: 'Schedule with Daniel.' };
  await f.run(input); await f.run(input);
  assert.equal(f.lookups.length, 2); assert.equal(f.calls.length, 4);
});
