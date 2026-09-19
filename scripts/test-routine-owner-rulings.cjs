// Actual startup → routine terminalization, isolated SQLite and Connection; no bot/network.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript'), Database = require('better-sqlite3');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'artifacts/workshop-verification/full-review-20260919/handyman/owner-rulings');
const before = process.argv.includes('--before');
function load(file, mocks, globals = {}) {
  const preserved = path.join(evidence, 'before', file);
  const source = fs.readFileSync(before && fs.existsSync(preserved) ? preserved : path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Date, Map, Set, ...globals }, { filename: file })(name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), m, m.exports);
  return m.exports;
}
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const crons = load('src/tasks/crons.ts', { '../db': {}, '../utils/logger': logger });
const cases = [];
function test(id, fn) { cases.push({ id, fn }); }
for (const [id, from, day, expected] of [
  ['skip-february-31','2026-01-31T08:00:00Z','31','2026-03-31T07:30:00.000Z'],
  ['skip-april-31','2026-04-01T08:00:00Z','31','2026-05-31T07:30:00.000Z'],
  ['skip-nonleap-february-29','2026-02-01T08:00:00Z','29','2026-03-29T07:30:00.000Z'],
  ['preserve-leap-february-29','2028-02-01T08:00:00Z','29','2028-02-29T07:30:00.000Z'],
  ['preserve-month-start','2026-09-19T08:00:00Z','1','2026-10-01T07:30:00.000Z'],
  ['preserve-year-rollover','2026-12-31T08:00:00Z','31','2027-01-31T07:30:00.000Z'],
]) test(id, () => assert.equal(crons.computeNextRunAt('monthly', '07:30', day, 'UTC', DateTime.fromISO(from)), expected));
test('monthly-multitime-last-valid-day', () => assert.equal(crons.computeNextRunAt('monthly','07:30,13:00','31','UTC',DateTime.fromISO('2026-01-31T08:00:00Z')), '2026-01-31T13:00:00.000Z'));
test('monthly-timezone-skip', () => assert.equal(crons.computeNextRunAt('monthly','07:30','31','Asia/Jerusalem',DateTime.fromISO('2026-04-01T08:00:00Z')), '2026-05-31T04:30:00.000Z'));
for (const day of ['32','invalid']) test(`monthly-invalid-persisted-day-${day}-fails-bounded`, () => assert.throws(() => crons.computeNextRunAt('monthly','07:30',day,'UTC',DateTime.fromISO('2026-04-01T08:00:00Z'))));
function fixture(opts = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks(id TEXT,owner_user_id TEXT,type TEXT,status TEXT,title TEXT,routine_id TEXT,updated_at TEXT,due_at TEXT);
    CREATE TABLE routines(id TEXT,owner_user_id TEXT,next_run_at TEXT,status TEXT,last_result TEXT,updated_at TEXT);
    INSERT INTO routines VALUES ('r1','OWNER','2099-01-01T07:30:00Z','active','old',NULL);
    INSERT INTO tasks VALUES ('interrupted','OWNER','routine','in_progress','Research','r1',NULL,'2026-01-01');
    INSERT INTO tasks VALUES ('other-owner','OTHER','routine','in_progress','Other','r-other',NULL,'2026-01-01');
    INSERT INTO tasks VALUES ('fresh','OWNER','routine','new','Upcoming','r1',NULL,'2099-01-01');
    INSERT INTO tasks VALUES ('finished','OWNER','routine','informed','Finished','r1',NULL,'2026-01-01');
    INSERT INTO tasks VALUES ('other-type','OWNER','calendar_fix','in_progress','Fix',NULL,NULL,'2026-01-01');`);
  if (opts.none) db.prepare("UPDATE tasks SET status='completed' WHERE id='interrupted'").run();
  if (opts.orphan) db.prepare("UPDATE tasks SET routine_id='missing' WHERE id='interrupted'").run();
  const state = { sends: [], errors: [], intervals: [], orchestrator: 0 };
  const log = { ...logger, error(...args) { state.errors.push(args); }, warn(...args) { state.errors.push(args); } };
  const conn = opts.absent ? undefined : { async sendDirect(owner, text) {
    state.sends.push({ owner, text, statusAtSend: db.prepare("SELECT status FROM tasks WHERE id='interrupted'").get().status });
    if (opts.throws) throw Error('transport outcome unknown');
    return opts.rejected ? { ok: false, reason: 'blocked' } : { ok: true, ts: '1.1' };
  } };
  const routine = load('src/tasks/dispatchers/routine.ts', {
    '../index': { updateTask() { throw Error('Unexpected dispatcher execution'); } }, '../../db': { getDb: () => db },
    '../../core/orchestrator': { async runOrchestrator() { state.orchestrator++; } }, '../lateness': {}, '../briefs': {},
    '../../utils/textScrubber': {}, '../../connections/registry': { getConnection: () => conn }, '../../utils/logger': log,
  });
  const background = load('src/core/background.ts', {
    '../tasks/runner': {}, '../tasks/routineMaterializer': {}, '../tasks/crons': {}, '../tasks/dispatchers/routine': routine,
    '../utils/logger': log, '../connections/slack/eligibility': {}, '../connectors/slack/threadHistory': {},
  }, { setInterval(fn, delay) { state.intervals.push({ fn, delay }); } });
  return { db, state, async boot() { background.startBackgroundTimer([], new Map([['owner', { user: { slack_user_id: 'OWNER' } }]])); await new Promise(resolve => setImmediate(resolve)); } };
}
test('startup-stops-interrupted-and-reports-uncertainty', async () => { const f = fixture(); try {
  await f.boot();
  assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='interrupted'").get().status, 'failed');
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.sends[0].statusAtSend, 'failed');
  assert.equal(f.state.sends[0].owner, 'OWNER'); assert.match(f.state.sends[0].text, /already|unknown|uncertain/);
  assert.match(f.state.sends[0].text, /won't replay|not replay/); assert.equal(f.state.orchestrator, 0);
  assert.equal(f.db.prepare('SELECT next_run_at FROM routines').get().next_run_at, '2099-01-01T07:30:00Z');
  assert.match(f.db.prepare('SELECT last_result FROM routines').get().last_result, /Interrupted/);
} finally { f.db.close(); } });
for (const failure of ['absent','rejected','throws']) test(`startup-notification-${failure}-never-replays`, async () => { const f = fixture({ [failure]: true }); try {
  await f.boot(); await f.boot();
  assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='interrupted'").get().status, 'failed');
  assert.equal(f.state.orchestrator, 0); assert.equal(f.state.sends.length, failure === 'absent' ? 0 : 1);
  assert.ok(f.state.errors.some(e => String(e[0]).includes('notification')));
  assert.equal(f.db.prepare('SELECT next_run_at FROM routines').get().next_run_at, '2099-01-01T07:30:00Z');
} finally { f.db.close(); } });
test('startup-second-boot-no-repeat-notice', async () => { const f = fixture(); try { await f.boot(); await f.boot(); assert.equal(f.state.sends.length, 1); } finally { f.db.close(); } });
test('startup-orphan-task-still-stops-and-reports', async () => { const f = fixture({ orphan: true }); try { await f.boot(); assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='interrupted'").get().status,'failed'); assert.equal(f.state.sends.length,1); } finally { f.db.close(); } });
test('startup-preserves-other-owner-type-and-terminal-work', async () => { const f = fixture(); try { await f.boot(); for (const [id,status] of [['other-owner','in_progress'],['other-type','in_progress'],['fresh','new'],['finished','informed']]) assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,status); } finally { f.db.close(); } });
test('startup-no-interrupted-work-no-notice', async () => { const f = fixture({ none: true }); try { await f.boot(); assert.equal(f.state.sends.length,0); assert.equal(f.state.intervals.length,2); } finally { f.db.close(); } });
test('next-scheduled-task-still-executes-without-replaying-interrupted-task', async () => { const f = fixture(); try {
  await f.boot();
  f.db.prepare("UPDATE tasks SET due_at='2026-01-01' WHERE id='fresh'").run();
  const taskApi = load('src/tasks/index.ts', { '../db': { getDb: () => f.db }, '../db/jobs': {}, '../utils/threadActivity': {}, './dispatchers': {}, '../utils/logger': logger });
  const dispatched = [];
  const runner = load('src/tasks/runner.ts', { './index': taskApi, './dispatchers': { DISPATCHERS: { routine: async (app, task) => { dispatched.push(task.id); taskApi.updateTask(task.id, { status: 'completed' }); } } }, '../core/requests/runner': { sweepDueRequests: async () => {} }, '../connections/registry': {}, '../utils/logger': logger });
  await runner.runDueTasks({}, new Map([['owner', { user: { slack_user_id: 'OWNER' } }]]));
  assert.deepEqual(dispatched, ['fresh']);
  assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='fresh'").get().status, 'completed');
} finally { f.db.close(); } });
(async () => {
  const results = [];
  for (const c of cases) { try { await c.fn(); results.push({ id:c.id,status:'pass' }); } catch(e) { results.push({ id:c.id,status:'fail',error:e.message }); } }
  const report={ phase:before?'before':'after', passed:results.filter(r=>r.status==='pass').length,failed:results.filter(r=>r.status==='fail').length,cases:results };
  console.log(JSON.stringify(report,null,2));
  if(process.env.ROUTINE_RULING_EVIDENCE==='1') fs.writeFileSync(path.join(evidence,`${report.phase}.json`),JSON.stringify(report,null,2));
  process.exitCode=report.failed?1:0;
})();
