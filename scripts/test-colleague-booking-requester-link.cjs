// The post-create hook, both production requester readers, and actual SQLite.
// Calendar, transport and the production database are never opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const revision = process.argv.includes('--source-revision')
  ? process.argv[process.argv.indexOf('--source-revision') + 1] : null;
function read(file) {
  return revision
    ? execFileSync('git', ['show', revision + ':' + file], { cwd: root, encoding: 'utf8' })
    : fs.readFileSync(path.join(root, file), 'utf8');
}
function compile(code, deps) {
  const module = { exports: {} };
  const js = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require(id) {
    assert.ok(Object.hasOwn(deps, id), 'Unexpected import ' + id);
    return deps[id];
  } });
  return module.exports;
}
const requestsCode = read('src/db/requests.ts');
const ownerCode = read('src/skills/meetings/findMeetingOwner.ts');
const createCode = read('src/skills/meetings/ops/handlers/createMeeting.ts');
const createTree = ts.createSourceFile('createMeeting.ts', createCode, ts.ScriptTarget.Latest, true);
const blocks = [];
(function visit(n) {
  if (ts.isIfStatement(n) && n.expression.getText() === 'requesterId && meetingId') blocks.push(n.getText());
  ts.forEachChild(n, visit);
})(createTree);
assert.equal(blocks.length, 1);
const hookCode = 'module.exports = (context, args, requesterId, requesterName, meetingId, logger) => {' + blocks[0] + '}';
const schema = read('src/db/client.ts').match(/CREATE TABLE IF NOT EXISTS requests \([\s\S]*?\n    \);/)[0];

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(schema);
  db.exec('ALTER TABLE requests ADD COLUMN phase TEXT; ALTER TABLE requests ADD COLUMN requester_notified_at TEXT; CREATE TABLE audit_log(owner_user_id, action, source, actor, target, details, outcome)');
  const warnings = [];
  const logger = { info() {}, warn(message, details) { warnings.push({ message, details }); } };
  const client = { getDb: () => db };
  const loadRequests = () => compile(requestsCode, {
    crypto: require('node:crypto'), luxon: require('luxon'), './client': client, './conversations': {},
    '../core/requests/types': { APPROVAL_SUBKINDS: [] }, '../core/requests/activityRevertibility': { ACTIVITY_REVERTIBILITY: {} }, '../utils/logger': logger,
  });
  const { findMeetingOwner } = compile(ownerCode, {
    '../../db/client': client, '../../db/people': { searchPeopleMemory: () => [] },
    '../../connectors/graph/calendar': { getEventOrganizer: async () => null }, '../../utils/logger': logger,
  });
  const reqs = loadRequests();
  const book = (eventId, requester = 'UCOL', subject = 'Weekly sync', owner = 'UOWNER') => {
    const hook = compile(hookCode, { '../../../../db/requests': loadRequests() });
    hook({ profile: { user: { slack_user_id: owner } } }, { subject }, requester || undefined, requester, eventId, logger);
  };
  const ownerOf = (eventId, ownerUserId = 'UOWNER') =>
    findMeetingOwner({ ownerUserId, ownerEmail: 'owner@example.test', eventId });
  const rows = () => db.prepare('SELECT * FROM requests ORDER BY rowid').all();
  return { db, warnings, reqs, book, ownerOf, rows };
}

test('separate same-title bookings retain their own exact case-sensitive event links', async t => {
  const h = fixture(t);
  h.book('Graph-A+1');
  h.book('Graph-a+1');
  assert.equal((await h.ownerOf('Graph-a+1')).requesterSlackId, 'UCOL');
  assert.equal((await h.ownerOf('Graph-A+1')).requesterSlackId, 'UCOL');
  assert.deepEqual(Array.from(h.reqs.getMeetingsRequestedBy('UOWNER', 'UCOL'), r => r.outcome_external_event_id).sort(), ['Graph-A+1', 'Graph-a+1']);
  assert.equal(h.warnings.length, 0);
});
test('fresh module retry with a renamed subject or changed claimant keeps the first requester', async t => {
  const h = fixture(t);
  h.book('one');
  const original = h.rows()[0];
  h.book('one', 'UOTHER', 'Renamed meeting');
  h.book('one');
  assert.deepEqual(h.rows(), [original]);
  assert.equal((await h.ownerOf('one')).requesterSlackId, 'UCOL');
  assert.equal(h.warnings.length, 0);
});
test('legacy cancelled link survives retry while new same-title booking is independently discoverable', t => {
  const h = fixture(t);
  h.book('old');
  const [original] = h.rows();
  const legacyKey = h.reqs.buildIdempotencyKey({ ownerUserId: 'UOWNER', requesterSlackId: 'UCOL', kind: 'follow_up', subject: original.subject });
  h.db.prepare('UPDATE requests SET idempotency_key = ? WHERE id = ?').run(legacyKey, original.id);
  h.reqs.cancelColleagueBookingRecordsForEvent('UOWNER', 'old');
  h.book('old', 'UOTHER', 'Renamed');
  h.book('new');
  assert.deepEqual(h.rows().map(r => [r.outcome_external_event_id, r.state]), [['old', 'cancelled'], ['new', 'resolved']]);
  assert.equal(h.reqs.getMeetingsRequestedBy('UOWNER', 'UOTHER').length, 0);
  assert.equal(h.reqs.getMeetingsRequestedBy('UOWNER', 'UCOL')[0].outcome_external_event_id, 'new');
  assert.equal(h.warnings.length, 0);
});
test('preserved owner boundary, single confirmed colleague link, and missing-identity guards', async t => {
  const h = fixture(t);
  h.book('event', 'UCOL');
  h.book('event', 'UOTHER', 'Weekly sync', 'UOWNER2');
  h.book('owner-created-event', null);
  h.book(null);
  assert.equal(h.rows().length, 2);
  assert.equal((await h.ownerOf('event')).requesterSlackId, 'UCOL');
  assert.equal((await h.ownerOf('event', 'UOWNER2')).requesterSlackId, 'UOTHER');
  assert.equal(h.rows()[0].next_check_at, null);
  assert.equal(h.warnings.length, 0);
});
test('preserved genuine storage failure warns after the confirmed booking', t => {
  const h = fixture(t);
  h.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT, 'fixture store failure'); END");
  h.book('confirmed');
  assert.equal(h.rows().length, 0);
  assert.match(h.warnings[0].details.err, /fixture store failure/);
});
test('preserved ordinary follow-up creation still rejects a duplicate subject identity', t => {
  const h = fixture(t);
  const input = { ownerUserId: 'UOWNER', initiatedBy: 'UOWNER', initiatedByRole: 'owner', kind: 'follow_up',
    subkind: 'other', subject: 'Weekly sync', state: 'in_flight', outcomeExternalEventId: 'event' };
  h.reqs.createRequest(input);
  assert.throws(() => h.reqs.createRequest({ ...input, outcomeExternalEventId: 'different' }), /UNIQUE constraint/);
});
