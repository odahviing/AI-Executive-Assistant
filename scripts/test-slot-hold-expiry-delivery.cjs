// Actual expiry -> SQLite terminal state -> Slack messaging. No live writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const sourceRoot = process.env.HOLD_EXPIRY_SOURCE_ROOT || root;
const profile = { user: { slack_user_id: 'UOWNER', timezone: 'UTC' } };
const actual = new Set(['src/core/background.ts', 'src/db/slotHolds.ts', 'src/connections/slack/messaging.ts', 'src/connections/slack/eligibility.ts', 'src/connectors/slack/threadHistory.ts']);
function harness(t, options = {}) {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE slot_holds (
    id TEXT PRIMARY KEY, owner_user_id TEXT, holder_slack_id TEXT, holder_name TEXT,
    subject TEXT, start_iso TEXT, end_iso TEXT, origin_channel TEXT, origin_thread_ts TEXT,
    reason TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT,
    closure_reason TEXT, closed_at TEXT)`);
  const posts = [], delivered = [], logs = [], calls = [], modules = new Map();
  const userFor = channel => channel === 'DOWNER' ? 'UOWNER' : 'UCOLLEAGUE';
  const dmFor = user => user === 'UOWNER' ? 'DOWNER' : 'DCOLLEAGUE';
  const app = { client: {
    auth: { test: async () => ({ ok: true, team_id: 'TLOCAL' }) },
    users: { info: async ({ user }) => ({ ok: true, user: { id: user, team_id: options.external ? 'TREMOTE' : 'TLOCAL' } }) },
    conversations: {
      open: async ({ users }) => {
        calls.push(['open', users]);
        if (options.openFails) throw Error('unavailable');
        return { ok: true, channel: { id: dmFor(users) } };
      },
      info: async ({ channel }) => {
        if (options.metadataFails) throw Error('metadata unavailable');
        return { ok: true, channel: { is_im: true, user: userFor(channel) } };
      },
    },
    chat: { postMessage: async p => {
      posts.push(p);
      // Parent timestamps belong to exactly one channel in this fixture.
      const parentChannel = { '100.000001': 'DCOLLEAGUE', '200.000001': 'DOWNER', '900.000001': 'CROOM', '800.000001': 'GROOM' }[p.thread_ts];
      if (p.thread_ts && parentChannel !== p.channel) throw Error('thread_not_found');
      if (options.postFails) throw Error('post unavailable');
      delivered.push(p);
      if (options.unknownCompletion) throw Error('response lost after accepted post');
      return { ok: true, ts: '300.000001' };
    } },
  } };
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => logs.push([level, ...args])]));
  const connection = {
    sendDirect: (id, text, opts) => {
      if (options.sendThrows) throw Error('connection unavailable');
      return load('src/connections/slack/messaging.ts').sendDM(app, 'fixture', id, text, opts);
    },
    ...(!options.resolverMissing && { resolveDirectChannelId: id => {
      calls.push(['resolve', id]);
      if (options.resolverThrows) return Promise.reject(Error('resolver unavailable'));
      if (options.resolverNull) return Promise.resolve(null);
      return load('src/connections/slack/messaging.ts').resolveDmChannelId(app, 'fixture', id);
    } }),
  };
  const mocks = {
    'src/tasks/runner.ts': {}, 'src/tasks/routineMaterializer.ts': {}, 'src/tasks/crons.ts': {},
    'src/tasks/dispatchers/routine.ts': { stopInterruptedRoutineTasks: async () => {} },
    'src/utils/logger.ts': logger, 'src/db/client.ts': { getDb: () => sqlite },
    'src/connections/registry.ts': { getConnection: () => options.connectionMissing ? null : connection },
  };
  function load(rel) {
    if (Object.hasOwn(mocks, rel)) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel);
    assert.ok(actual.has(rel), `unexpected dependency ${rel}`);
    const frozen = path.join(sourceRoot, rel);
    const file = fs.existsSync(frozen) ? frozen : path.join(root, rel);
    const extra = rel === 'src/core/background.ts' ? '\nexport { sweepExpiredSlotHolds };' : '';
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8') + extra, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const exports = {}; modules.set(rel, exports);
    vm.runInNewContext(code, { exports, require: n => n === 'luxon' ? require(n) : load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), n)) + '.ts'), console }, { filename: rel });
    return exports;
  }
  function hold(overrides = {}) {
    return load('src/db/slotHolds.ts').createSlotHold({ ownerUserId: 'UOWNER', holderSlackId: 'UCOLLEAGUE', holderName: 'Colleague', subject: 'Planning', startIso: '2099-01-01T12:00:00Z', endIso: '2099-01-01T13:00:00Z', expiresAt: '2000-01-01T00:00:00Z', originChannel: 'DCOLLEAGUE', originThreadTs: '100.000001', ...overrides });
  }
  const sweep = () => load('src/core/background.ts').sweepExpiredSlotHolds(options.profileMissing ? new Map() : new Map([['UOWNER', profile]]));
  const row = id => sqlite.prepare('SELECT * FROM slot_holds WHERE id = ?').get(id);
  return { hold, sweep, row, posts, delivered, logs, calls };
}
async function expiredOnce(h, hold) {
  await h.sweep();
  assert.equal(h.row(hold.id).status, 'expired');
  assert.equal(h.row(hold.id).closure_reason, 'expired');
  assert.ok(h.row(hold.id).closed_at);
  const count = h.posts.length;
  await h.sweep(); // terminal row prevents repeated notifications after restart/tick
  assert.equal(h.posts.length, count);
}
for (const [name, originChannel, originThreadTs] of [
  ['public-room', 'CROOM', '900.000001'], ['group-dm', 'GROOM', '800.000001'],
  ['other-person-dm', 'DOWNER', '200.000001'], ['missing-channel', null, '900.000001'],
]) test(`${name}: expiry privately delivers without a foreign parent`, async t => {
  const h = harness(t), hold = h.hold({ originChannel, originThreadTs });
  await expiredOnce(h, hold);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.posts[0].channel, 'DCOLLEAGUE');
  assert.equal(h.posts[0].thread_ts, undefined);
});
for (const [name, holderSlackId, originChannel, originThreadTs] of [
  ['colleague', 'UCOLLEAGUE', 'DCOLLEAGUE', '100.000001'], ['owner', 'UOWNER', 'DOWNER', '200.000001'],
]) test(`${name}: genuine recipient-DM parent is retained`, async t => {
  const h = harness(t), hold = h.hold({ holderSlackId, originChannel, originThreadTs });
  await expiredOnce(h, hold);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.posts[0].channel, originChannel);
  assert.equal(h.posts[0].thread_ts, originThreadTs);
});
test('missing-origin: existing top-level private delivery is preserved', async t => {
  const h = harness(t), hold = h.hold({ originChannel: null, originThreadTs: null });
  await expiredOnce(h, hold);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.posts[0].channel, 'DCOLLEAGUE');
  assert.equal(h.posts[0].thread_ts, undefined);
  assert.equal(h.calls.filter(c => c[0] === 'resolve').length, 0);
});
for (const option of ['resolverMissing', 'resolverNull', 'resolverThrows']) test(`${option}: unknown parent ownership falls back to private top-level`, async t => {
  const h = harness(t, { [option]: true }), hold = h.hold();
  await expiredOnce(h, hold);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.posts[0].thread_ts, undefined);
});
for (const option of ['postFails', 'openFails', 'metadataFails', 'sendThrows', 'external']) test(`${option}: failed notice stays terminal with no public fallback or retry`, async t => {
  const h = harness(t, { [option]: true }), hold = h.hold();
  await expiredOnce(h, hold);
  assert.equal(h.delivered.length, 0);
  assert.ok(h.posts.every(p => p.channel === 'DCOLLEAGUE'));
});
test('explicit send failure is recorded against the expired hold', async t => {
  const h = harness(t, { postFails: true }), hold = h.hold();
  await expiredOnce(h, hold);
  assert.ok(h.logs.some(l => l[1] === 'sweepExpiredSlotHolds — holder DM failed (hold already released)' && l[2].id === hold.id));
});
test('unknown completion never repeats a potentially accepted private notice', async t => {
  const h = harness(t, { unknownCompletion: true }), hold = h.hold();
  await expiredOnce(h, hold);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.posts.length, 1);
});
for (const [name, options, overrides] of [
  ['owner-parked', {}, { holderSlackId: null }], ['past-slot', {}, { startIso: '2000-01-01T00:00:00Z' }],
  ['missing-profile', { profileMissing: true }, {}], ['missing-connection', { connectionMissing: true }, {}],
]) test(`${name}: silent release remains terminal`, async t => {
  const h = harness(t, options), hold = h.hold(overrides);
  await expiredOnce(h, hold);
  assert.equal(h.posts.length, 0);
});
test('not-due: an active hold stays active and sends nothing', async t => {
  const h = harness(t), hold = h.hold({ expiresAt: '2099-01-01T00:00:00Z' });
  await h.sweep();
  assert.equal(h.row(hold.id).status, 'active');
  assert.equal(h.posts.length, 0);
});
