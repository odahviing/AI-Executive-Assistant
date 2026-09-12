// Actual executeSkillTool (src/skills/registry.ts) → actual Connection registry
// (src/connections/registry.ts) → actual SlackConnection (src/connections/slack/
// index.ts) in a vm sandbox. Proves the dispatch chokepoint hands a Connection
// the turn's surface (SkillContext.surface, #154) and that find_slack_user's
// projection then shapes its payload by it. Core modules, optional skills, the
// people store, the Slack client and the logger are fixtures; no model, network
// or database is touched.
// CONNECTION_TOOL_SCOPE_BEFORE=1 replays src/skills/registry.ts from the baseline
// commit (the two-argument call shape); every other file is read from the tree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const baseline = 'edd243330307d5dd025e8dc4f7770da24aab16c3';
const before = process.env.CONNECTION_TOOL_SCOPE_BEFORE === '1';
const replayed = 'src/skills/registry.ts';
const actual = new Set([replayed, 'src/connections/registry.ts', 'src/connections/slack/index.ts']);
const compiled = new Map();
const OWNER = 'UOWNER001', COLLEAGUE = 'UCOLL0001';
const PROFILE = {
  user: { name: 'Idan Owner', slack_user_id: OWNER, email: 'idan@example.com', timezone: 'Asia/Jerusalem' },
  assistant: { name: 'Maelle' }, skills: {}, advanced: {},
};
// One people_memory row with everything a room must not see: tz (auto-inferred), city, email.
const PAUL = { person_id: 'p_UPAUL0001', slack_id: 'UPAUL0001', name: 'Paul Fixture', email: 'paul@example.com', timezone: 'Europe/London', timezone_set_by: 'auto', state: 'London' };
const FULL = { slack_id: 'UPAUL0001', name: 'Paul Fixture', tz_iana: 'Europe/London', tz_note: 'Guessed, not confirmed — confirm before presenting their local time as fact.', state: 'London', email: 'paul@example.com' };
const IDENTITY = ['name', 'slack_id'];
// Each turn as the transport front door resolves it (#154): senderRole is the
// data clamp (colleague on any room surface, owner included), authority the
// action gate, surface where the turn happens.
const TURNS = {
  owner_dm: { userId: OWNER, senderRole: 'owner', authority: 'owner', surface: 'owner_dm', channelId: 'DOWNER' },
  colleague_dm: { userId: COLLEAGUE, senderRole: 'colleague', authority: 'colleague', surface: 'colleague_dm', channelId: 'DCOLL' },
  room: { userId: COLLEAGUE, senderRole: 'colleague', authority: 'colleague', surface: 'room', channelId: 'CROOM' },
  owner_in_room: { userId: OWNER, senderRole: 'colleague', authority: 'owner', surface: 'room', channelId: 'CROOM' },
};
const keys = o => Object.keys(o).filter(k => o[k] !== undefined).sort();
// Sandbox-realm objects carry that realm's prototypes; compare as plain data.
const plain = x => JSON.parse(JSON.stringify(x));

function compile(rel) {
  if (!compiled.has(rel)) {
    const source = before && rel === replayed
      ? cp.execFileSync('git', ['show', `${baseline}:${rel}`], { cwd: root, encoding: 'utf8' })
      : fs.readFileSync(path.join(root, rel), 'utf8');
    compiled.set(rel, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
  }
  return compiled.get(rel);
}

function harness(options = {}) {
  const logs = [], scopes = [], unexpected = [], modules = new Map();
  const logger = { __esModule: true, default: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(k => [k, (...a) => logs.push([k, ...a])])) };
  class Passive { executeToolCall() { return Promise.resolve(null); } getTools() { return []; } }
  // The always-on memory module answers exactly one tool, so the dispatch order
  // (core modules before the Connection) is observable.
  class Core extends Passive { executeToolCall(tool) { return Promise.resolve(tool === 'get_person_memory' ? { handled: 'core' } : null); } }
  const optional = { 'src/skills/meetings.ts': 'MeetingsSkill', 'src/skills/general.ts': 'SearchSkill', 'src/skills/calendarHealth.ts': 'CalendarHealthSkill', 'src/skills/summary.ts': 'SummarySkill', 'src/skills/knowledge.ts': 'KnowledgeBaseSkill', 'src/skills/social.ts': 'SocialSkill', 'src/skills/venue.ts': 'VenueSkill', 'src/skills/news.ts': 'NewsSkill' };
  const app = { client: { users: { list: async () => ({ members: [], response_metadata: {} }) } } };
  const mocks = {
    'src/utils/logger.ts': logger,
    'src/core/assistant.ts': { AssistantSkill: Core },
    'src/skills/outreach.ts': { OutreachCoreSkill: Passive },
    'src/tasks/skill.ts': { TasksSkill: Passive },
    'src/tasks/crons.ts': { CronsSkill: Passive },
    'src/utils/textScrubber.ts': { registerToolNames() {} },
    'src/db/index.ts': { searchPeopleMemory: () => [PAUL] },
    'src/connections/slack/messaging.ts': { findChannelByName: async (_app, _token, name) => [{ id: 'C0GENERAL', name }] },
    'src/connections/slack/formatting.ts': { formatForSlack: t => t },
  };
  const resolve = target => [target + '.ts', target + '/index.ts'].find(c => Object.hasOwn(mocks, c) || Object.hasOwn(optional, c) || actual.has(c)) ?? target + '.ts';
  function load(rel) {
    if (Object.hasOwn(mocks, rel)) return mocks[rel];
    if (Object.hasOwn(optional, rel)) return { [optional[rel]]: Passive };
    if (modules.has(rel)) return modules.get(rel).exports;
    if (!actual.has(rel)) { unexpected.push(rel); throw Error(`Forbidden dependency ${rel}`); }
    const mod = { exports: {} };
    modules.set(rel, mod);
    const req = s => s.startsWith('.') ? load(resolve(path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)))) : require(s);
    vm.runInNewContext('(function(require,module,exports){' + compile(rel) + '\n})', { console, process, Set, Map, Buffer, Date, setTimeout, setImmediate, Promise, Error }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  const connection = options.connection === 'spy'
    ? { id: 'slack', executeToolCall: async (_tool, _args, scope) => { scopes.push(scope); return options.spyResult === undefined ? { ok: true } : options.spyResult; } }
    : options.connection === 'none'
      ? { id: 'slack' }
      : load('src/connections/slack/index.ts').createSlackConnection(app, 'xoxb-fixture', PROFILE);
  load('src/connections/registry.ts').registerConnection(OWNER, connection);
  const run = (tool, args, turn) => load(replayed).executeSkillTool(tool, args, { profile: PROFILE, threadTs: '1.1', channel: 'slack', ...TURNS[turn] });
  return { run, scopes, logs, unexpected };
}

// ── the chokepoint hands the Connection the turn's surface ───────────────────
for (const turn of ['owner_dm', 'colleague_dm', 'room']) test(`regression: executeSkillTool hands the Connection the ${turn} surface`, async () => {
  const h = harness({ connection: 'spy' });
  const r = await h.run('find_slack_user', { name: 'paul' }, turn);
  assert.deepEqual(plain(r), { ok: true });
  assert.deepEqual(plain(h.scopes), [{ surface: turn }]);
  assert.deepEqual(h.unexpected, []);
});

// ── the Slack projection then shapes the payload by that surface ─────────────
test('regression: owner DM turn receives the full directory shape through the chokepoint', async () => {
  const h = harness();
  const r = await h.run('find_slack_user', { name: 'paul' }, 'owner_dm');
  assert.equal(r.source, 'people_memory');
  assert.deepEqual(plain(r.matches[0]), FULL);
  assert.deepEqual(h.unexpected, []);
});
test('regression: colleague DM turn keeps today\'s third-party shape through the chokepoint', async () => {
  const h = harness();
  const r = await h.run('find_slack_user', { name: 'paul' }, 'colleague_dm');
  assert.deepEqual(plain(r.matches[0]), FULL);
});
test('preserved: colleague room turn receives identity only through the chokepoint', async () => {
  const h = harness();
  const r = await h.run('find_slack_user', { name: 'paul' }, 'room');
  assert.equal(r.count, 1);
  assert.deepEqual(keys(r.matches[0]), IDENTITY);
});
test('preserved: owner in a room receives identity only through the chokepoint', async () => {
  const h = harness();
  const r = await h.run('find_slack_user', { name: 'paul' }, 'owner_in_room');
  assert.equal(r.count, 1);
  assert.deepEqual(keys(r.matches[0]), IDENTITY);
});

// ── nothing else about the fall-through changed ──────────────────────────────
test('preserved: find_slack_channel answers the same with a scope in hand', async () => {
  const h = harness();
  const r = await h.run('find_slack_channel', { name: 'general' }, 'owner_dm');
  assert.deepEqual(plain(r), { channels: [{ id: 'C0GENERAL', name: 'general' }], count: 1 });
});
test('preserved: a core-module tool is answered before the Connection is consulted', async () => {
  const h = harness({ connection: 'spy' });
  const r = await h.run('get_person_memory', { name: 'paul' }, 'owner_dm');
  assert.deepEqual(plain(r), { handled: 'core' });
  assert.deepEqual(h.scopes, []);
});
test('preserved: a Connection that returns null falls through to the no-handler error', async () => {
  const h = harness({ connection: 'spy', spyResult: null });
  const r = await h.run('find_slack_user', { name: 'paul' }, 'owner_dm');
  assert.match(r.error, /No active skill handles tool: find_slack_user/);
  assert.equal(h.scopes.length, 1);
});
test('preserved: a Connection without executeToolCall yields the no-handler error', async () => {
  const h = harness({ connection: 'none' });
  const r = await h.run('find_slack_user', { name: 'paul' }, 'owner_dm');
  assert.match(r.error, /No active skill handles tool: find_slack_user/);
});
