// Actual requests.ts SQL against isolated SQLite, no production DB or model.
// MAELLE_REQUEST_SOURCE_ROOT selects preserved baseline source for the same cases.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), Database = require('better-sqlite3');
const sourceRoot = process.env.MAELLE_REQUEST_SOURCE_ROOT || path.resolve(__dirname, '..');
const file = path.join(sourceRoot, 'src/db/requests.ts');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
function fixture(rows, legacy = false) {
  const db = new Database(':memory:');
  const fields = ['id', 'owner_user_id', 'origin_thread_ts', 'state', 'created_at', 'outcome_json',
    ...(legacy ? [] : ['owner_dm_channel', 'owner_dm_thread_ts', 'terminal_dm_msg_ts'])];
  db.exec(`CREATE TABLE requests (${fields.map(k => k + ' TEXT').join(', ')})`);
  const defaults = { owner_user_id: 'OWNER', origin_thread_ts: 'origin.1', state: 'resolved', created_at: '2026-10-19 11:03:53',
    outcome_json: '{"approved":true,"replayed":"message_colleague"}', owner_dm_channel: 'DOWNER', owner_dm_thread_ts: 'daily.1', terminal_dm_msg_ts: 'ask.1' };
  const insert = db.prepare(`INSERT INTO requests VALUES (${fields.map(() => '?').join(', ')})`);
  for (const row of rows) insert.run(...fields.map(k => ({ ...defaults, ...row })[k] ?? null));
  const m = { exports: {} };
  const mocks = { './client': { getDb: () => db }, crypto: require('node:crypto'), luxon: require('luxon'),
    './conversations': {}, '../core/requests/types': { APPROVAL_SUBKINDS: [] },
    '../core/requests/activityRevertibility': { ACTIVITY_REVERTIBILITY: {} },
    '../utils/logger': { __esModule: true, default: {} } };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})(name => {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name}`); return mocks[name];
  }, m, m.exports);
  return { db, query: (...args) => Array.from(m.exports.getRequestsForThread(...args)),
    ids: (...args) => Array.from(m.exports.getRequestsForThread(...args), row => row.id) };
}
function check(name, rows, run, legacy) {
  test(name, () => { const h = fixture(rows, legacy); try {
    const changes = h.db.prepare('SELECT total_changes() AS n').get().n;
    run(h);
    assert.equal(h.db.prepare('SELECT total_changes() AS n').get().n, changes, 'evidence reads cannot mutate requests');
  } finally { h.db.close(); } });
}
check('owner daily decision anchor returns the resolved approval', [{ id: 'approval' }], h => {
  const rows = h.query('OWNER', 'daily.1', 'DOWNER'); assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'approval'); assert.equal(JSON.parse(rows[0].outcome_json).approved, true);
});
check('specific owner approval message anchor returns the decision', [{ id: 'approval' }], h => {
  assert.deepEqual(h.ids('OWNER', 'ask.1', 'DOWNER'), ['approval']);
});
check('control no-scope origin behavior works with existing minimal DB fixture', [{ id: 'origin' },
  { id: 'other-thread', origin_thread_ts: 'elsewhere' }, { id: 'other-owner', owner_user_id: 'OTHER' },
  { id: 'activity', state: 'logged' }], h => {
  assert.deepEqual(h.ids('OWNER', 'origin.1'), ['origin']);
}, true);
check('control guessing exact owner daily or message thread without scope reveals nothing', [{ id: 'approval' }], h => {
  for (const scope of [undefined, '']) for (const thread of ['daily.1', 'ask.1']) assert.deepEqual(h.ids('OWNER', thread, scope), []);
});
check('control wrong channel cannot reveal either owner decision anchor', [{ id: 'approval' }], h => {
  for (const channel of ['DCOLLEAGUE', 'CROOM', ' DOWNER ', 'downer']) for (const thread of ['daily.1', 'ask.1'])
    assert.deepEqual(h.ids('OWNER', thread, channel), []);
});
check('control wrong owner cannot reveal decision from matching channel and thread', [{ id: 'approval' }], h => {
  for (const thread of ['daily.1', 'ask.1', 'origin.1']) assert.deepEqual(h.ids('OTHER', thread, 'DOWNER'), []);
});
check('control channel alone never selects guessed or arbitrary threads', [{ id: 'approval' }], h => {
  for (const thread of ['other.1', '', "daily.1' OR 1=1 --"]) assert.deepEqual(h.ids('OWNER', thread, 'DOWNER'), []);
});
check('control origin remains visible when optional owner channel does not match', [{ id: 'origin' }], h => {
  assert.deepEqual(h.ids('OWNER', 'origin.1', 'DIFFERENT'), ['origin']);
});
check('owner decision evidence retains all lifecycle outcomes but excludes logged activity',
  ['awaiting_owner', 'awaiting_colleague', 'in_flight', 'resolved', 'cancelled', 'expired', 'logged'].map((state, i) => ({ id: state, state, created_at: String(i) })), h => {
    assert.deepEqual(h.ids('OWNER', 'daily.1', 'DOWNER'), ['awaiting_owner', 'awaiting_colleague', 'in_flight', 'resolved', 'cancelled', 'expired']);
  });
check('control logged rows are excluded from origin and both scoped owner anchors', [{ id: 'activity', state: 'logged' }], h => {
  for (const thread of ['origin.1', 'daily.1', 'ask.1']) assert.deepEqual(h.ids('OWNER', thread, 'DOWNER'), []);
});
check('overlapping origin and owner anchor returns the row only once in creation order', [
  { id: 'second', origin_thread_ts: 'daily.1', created_at: '2' },
  { id: 'first', created_at: '1' }, { id: 'foreign', owner_user_id: 'OTHER', created_at: '0' }], h => {
  assert.deepEqual(h.ids('OWNER', 'daily.1', 'DOWNER'), ['first', 'second']);
});
check('control repeated terminal evidence reads preserve outcome and do not enqueue actions', [{ id: 'approval' }], h => {
  const before = h.query('OWNER', 'origin.1');
  h.query('OWNER', 'daily.1', 'DOWNER'); h.query('OWNER', 'daily.1', 'DOWNER');
  assert.deepEqual(h.query('OWNER', 'origin.1'), before);
});
check('control missing stored owner channel fails closed', [{ id: 'approval', owner_dm_channel: null }], h => {
  assert.deepEqual(h.ids('OWNER', 'daily.1', 'DOWNER'), []);
  assert.deepEqual(h.ids('OWNER', 'ask.1', 'DOWNER'), []);
});
test('control unavailable database surfaces an error rather than an empty success', () => {
  const h = fixture([{ id: 'approval' }]); h.db.close();
  assert.throws(() => h.query('OWNER', 'daily.1', 'DOWNER'), /not open/);
});
