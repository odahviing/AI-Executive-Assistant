// Isolated execution of production routine scheduling/dispatch; no bot, network or live DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
const { DateTime } = require('luxon');
const before = process.argv.includes('--before');
const root = path.resolve(__dirname, '..');
const outputDir = process.env.ROUTINE_EVIDENCE_DIR;
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
function load(file, mocks) {
  const source = before ? cp.execFileSync('git', ['show', `e760080:${file}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, file), 'utf8');
  if (outputDir && before) {
    const dest = path.join(outputDir, 'before', file);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, source);
  }
  const m = new Module(path.join(root, file), module);
  m.filename = path.join(root, file); m.paths = module.paths;
  m.require = name => Object.hasOwn(mocks, name) ? mocks[name] : require(name);
  m._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, m.filename);
  return m.exports;
}
const profile = { user: { slack_user_id: 'U_OWNER', timezone: 'Asia/Jerusalem' }, schedule: { office_days: { days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'] }, home_days: { days: [] } } };
function fixture(opts = {}) {
  const state = { statuses: [], history: [], dbRuns: [], posts: [], deletes: [], invoked: 0 };
  const routine = { id: 'r1', owner_user_id: 'U_OWNER', owner_channel: 'D_OWNER', title: 'Weekly research', prompt: 'Research useful sources', status: 'active', schedule_type: 'daily', schedule_time: '07:30', is_system: 0, ...opts.routine };
  const db = { prepare(sql) { return { get() { return opts.missing ? undefined : routine; }, run(...args) { state.dbRuns.push({ sql, args }); } }; } };
  const conn = opts.noConnection ? undefined : {
    async postToChannel(channel, text) {
      state.posts.push({ channel, text });
      if (text === 'Working…') return opts.placeholder || { ok: true, ts: '100.1' };
      if (opts.sendThrows) throw Error('send threw');
      return opts.send || { ok: true, ts: '200.2' };
    },
    async updateMessage(channel, messageTs, text) { if (opts.updateThrows) throw Error('update threw'); return opts.update || { ok: true, ts: messageTs }; },
    async deleteMessage(channel, messageTs) { state.deletes.push(messageTs); return { ok: true }; },
    async sendDirect() { return { ok: true }; },
  };
  if (opts.noEdit && conn) delete conn.updateMessage;
  const { dispatchRoutine } = load('src/tasks/dispatchers/routine.ts', {
    '../index': { updateTask(id, patch) { state.statuses.push(patch.status); }, completeTask() { state.statuses.push('completed'); }, markTaskInformed() { state.statuses.push('informed'); } },
    '../../db': { getDb: () => db, appendToConversation(...args) { state.history.push(args); } },
    '../../core/orchestrator': { async runOrchestrator(input) { state.invoked++; state.input = input; if (opts.orchestratorThrows) throw Error('orchestrator failed'); return opts.result || { reply: 'A source-backed result' }; } },
    '../lateness': { assessLateness: () => opts.stale ? { run: false, reason: 'late', latenessMinutes: 300 } : { run: true } },
    '../briefs': { async sendMorningBriefing() { if (opts.briefThrows) throw Error('brief failed'); } },
    '../../utils/textScrubber': { scrubInternalLeakage: text => text },
    '../../connections/registry': { getConnection: () => conn },
    '../../utils/logger': silentLogger,
  });
  return { state, async run() { await dispatchRoutine({}, { id: 't1', routine_id: opts.noId ? null : 'r1', due_at: '2026-09-19T07:30:00Z' }, profile, {}); return state; } };
}
const cases = [];
function test(id, fn) { cases.push({ id, fn }); }
test('delivery-explicit-failure', async () => { const s = await fixture({ update: { ok: false }, send: { ok: false, reason: 'unavailable' } }).run(); assert.deepEqual(s.statuses, ['failed']); assert.equal(s.history.length, 0); });
test('delivery-no-connection', async () => { const s = await fixture({ noConnection: true }).run(); assert.deepEqual(s.statuses, ['failed']); assert.equal(s.invoked, 0); });
test('delivery-placeholder-failed-final-failed', async () => { const s = await fixture({ placeholder: { ok: false }, send: { ok: false, reason: 'blocked' } }).run(); assert.deepEqual(s.statuses, ['failed']); });
test('delivery-edit-success', async () => { const s = await fixture().run(); assert.deepEqual(s.statuses, ['completed', 'informed']); assert.equal(s.history[0][0], '100.1'); assert.equal(s.input.surface, 'owner_dm'); assert.equal(s.input.interactive, false); });
test('delivery-fallback-success', async () => { const s = await fixture({ update: { ok: false } }).run(); assert.deepEqual(s.statuses, ['completed', 'informed']); assert.equal(s.history[0][0], '200.2'); });
test('delivery-no-edit-fallback-success', async () => { const s = await fixture({ noEdit: true }).run(); assert.deepEqual(s.statuses, ['completed', 'informed']); });
test('delivery-ok-no-ts', async () => { const s = await fixture({ placeholder: { ok: false }, send: { ok: true } }).run(); assert.deepEqual(s.statuses, ['completed', 'informed']); assert.equal(s.history.length, 0); });
test('delivery-thrown-send', async () => { const s = await fixture({ update: { ok: false }, sendThrows: true }).run(); assert.deepEqual(s.statuses, ['failed']); });
test('delivery-thrown-orchestrator', async () => { const s = await fixture({ orchestratorThrows: true }).run(); assert.deepEqual(s.statuses, ['failed']); assert.equal(s.deletes.length, 1); });
test('delivery-silent', async () => { const s = await fixture({ result: { reply: '' } }).run(); assert.deepEqual(s.statuses, ['completed']); assert.equal(s.deletes.length, 1); });
test('delivery-vacuous-health-silent', async () => { const s = await fixture({ result: { reply: 'All clear', healthCheckVacuous: true } }).run(); assert.deepEqual(s.statuses, ['completed']); });
test('delivery-health-mutation-preserved', async () => { const s = await fixture({ result: { reply: 'Booked', healthCheckVacuous: true, bookingOccurred: true } }).run(); assert.deepEqual(s.statuses, ['completed', 'informed']); });
for (const status of ['paused', 'deleted']) test(`cancel-${status}`, async () => { const s = await fixture({ routine: { status } }).run(); assert.deepEqual(s.statuses, ['cancelled']); assert.equal(s.invoked, 0); });
test('dispatch-missing-routine', async () => assert.deepEqual((await fixture({ missing: true }).run()).statuses, ['failed']));
test('dispatch-missing-id', async () => assert.deepEqual((await fixture({ noId: true }).run()).statuses, ['failed']));
test('dispatch-stale', async () => assert.deepEqual((await fixture({ stale: true }).run()).statuses, ['stale']));
test('brief-success', async () => assert.deepEqual((await fixture({ routine: { is_system: 1, prompt: '__system_briefing__' } }).run()).statuses, ['completed', 'informed']));
test('brief-failure', async () => assert.deepEqual((await fixture({ routine: { is_system: 1, prompt: '__system_briefing__' }, briefThrows: true }).run()).statuses, ['failed']));
const crons = load('src/tasks/crons.ts', { '../db': { getDb() { throw Error('unexpected DB'); } }, '../utils/logger': silentLogger });
function cronToolFixture() {
  const writes = [];
  const routine = { id: 'r1', owner_user_id: 'U_OWNER', schedule_type: 'daily', schedule_time: '07:30', schedule_day: null, status: 'active', is_system: 0 };
  const db = { prepare(sql) { return { get() { return routine; }, run(...args) { writes.push({ sql, args }); } }; } };
  const { CronsSkill } = load('src/tasks/crons.ts', { '../db': { getDb: () => db }, '../utils/logger': silentLogger });
  return { writes, async call(args) { return new CronsSkill().executeToolCall('manage_routine', args, { profile, channelId: 'D_OWNER' }); } };
}
for (const [name, invalid] of [
  ['time-range', { schedule_time: '25:00' }], ['time-partial', { schedule_time: '07:30garbage' }],
  ['mixed-time', { schedule_time: '07:30,invalid' }], ['unknown-type', { schedule_type: 'sometimes' }],
  ['weekly-day', { schedule_type: 'weekly', schedule_day: 'Funday' }],
  ['monthly-day', { schedule_type: 'monthly', schedule_day: '32' }],
]) for (const action of ['create', 'update']) test(`schedule-reject-${action}-${name}`, async () => {
  const f = cronToolFixture();
  const result = await f.call({ action, routine_id: 'r1', title: 'News check', prompt: 'Fetch reports', schedule_type: 'daily', schedule_time: '07:30', ...invalid });
  assert.ok(result.error, JSON.stringify(result)); assert.equal(f.writes.length, 0);
});
test('schedule-valid-create', async () => { const f = cronToolFixture(); assert.equal((await f.call({ action: 'create', title: 'News check', prompt: 'Fetch reports', schedule_type: 'daily', schedule_time: '07:30,13:00' })).created, true); assert.equal(f.writes.length, 1); });
test('schedule-valid-update', async () => { const f = cronToolFixture(); assert.equal((await f.call({ action: 'update', routine_id: 'r1', schedule_time: '08:30' })).updated, true); assert.equal(f.writes.length, 1); });
test('dst-spring-next-day-clock', () => assert.equal(crons.computeNextRunAt('daily', '02:30', null, 'America/New_York', DateTime.fromISO('2026-03-08T12:00:00', { zone: 'America/New_York' })), '2026-03-09T06:30:00.000Z'));
test('dst-spring-weekday-clock', () => assert.equal(crons.computeNextRunAt('weekdays', '02:30', null, 'America/New_York', DateTime.fromISO('2026-03-08T12:00:00', { zone: 'America/New_York' })), '2026-03-09T06:30:00.000Z'));
test('daily-normal-clock', () => assert.equal(crons.computeNextRunAt('daily', '07:30', null, 'Asia/Jerusalem', DateTime.fromISO('2026-09-19T08:00:00', { zone: 'Asia/Jerusalem' })), '2026-09-20T04:30:00.000Z'));
test('multitime-next-slot', () => assert.equal(crons.computeNextRunAt('daily', '07:30,13:00', null, 'Asia/Jerusalem', DateTime.fromISO('2026-09-19T08:00:00', { zone: 'Asia/Jerusalem' })), '2026-09-19T10:00:00.000Z'));
test('workdays-owner-calendar', () => assert.equal(crons.computeNextRunAt('weekdays', '07:30', null, 'Asia/Jerusalem', DateTime.fromISO('2026-09-17T08:00:00', { zone: 'Asia/Jerusalem' }), profile.schedule.office_days.days), '2026-09-20T04:30:00.000Z'));
test('weekly-normal-clock', () => assert.equal(crons.computeNextRunAt('weekly', '07:30', 'Monday', 'UTC', DateTime.fromISO('2026-09-19T08:00:00Z')), '2026-09-21T07:30:00.000Z'));
test('monthly-normal-clock', () => assert.equal(crons.computeNextRunAt('monthly', '07:30', '15', 'UTC', DateTime.fromISO('2026-09-19T08:00:00Z')), '2026-10-15T07:30:00.000Z'));
test('brief-restart-retains-custom-weekly-cadence', () => {
  const day = DateTime.now().setZone(profile.user.timezone).weekdayLong;
  const next = crons.computeNextRunAt('weekly', '00:00', day, profile.user.timezone);
  const routine = { schedule_type: 'weekly', schedule_day: day, schedule_time: '00:00', next_run_at: next };
  let writes = 0;
  const module = load('src/tasks/crons.ts', { '../db': { getDb: () => ({ prepare() { return { get: () => routine, run() { writes++; } }; } }) }, './briefs': { getBriefingHourMin: () => [0, 0] }, '../utils/logger': silentLogger });
  module.ensureBriefingCron(profile);
  assert.equal(writes, 0);
});
const Database = require('better-sqlite3');
function materializerFixture(opts = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE routines(id TEXT, owner_user_id TEXT, owner_channel TEXT, title TEXT, prompt TEXT, schedule_type TEXT, schedule_time TEXT, schedule_day TEXT, status TEXT, next_run_at TEXT, updated_at TEXT, never_stale INTEGER, notify_on_skip INTEGER, is_system INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY, routine_id TEXT, due_at TEXT, owner_channel TEXT NOT NULL, status TEXT);
    CREATE UNIQUE INDEX firing ON tasks(routine_id,due_at);`);
  const due = DateTime.utc().minus({ hours: opts.dense ? 1440 : opts.old ? 72 : 1 }).toISO();
  const times = opts.dense ? Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:30`).join(',') : '07:30';
  db.prepare('INSERT INTO routines VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('r1','U_OWNER',opts.badConstraint ? null : 'D_OWNER','Report','Fetch','daily',times,null,'active',due,null,opts.neverStale ? 1 : 0,0,0);
  if (opts.duplicate) db.prepare("INSERT INTO tasks VALUES ('existing','r1',?,'D_OWNER','informed')").run(due);
  let count = 0;
  const materializer = load('src/tasks/routineMaterializer.ts', {
    '../db': { getDb: () => db }, './crons': crons,
    './lateness': { assessLateness({ routine, scheduledAtIso }) { return { run: routine.never_stale === 1 || Date.now() - Date.parse(scheduledAtIso) < 4 * 60 * 60 * 1000, latenessMinutes: 60 }; } },
    './index': { createTask(task) { const id = `t${++count}`; db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?)').run(id, task.routine_id, task.due_at, task.owner_channel, task.status); return id; } },
    '../connections/registry': { getConnection: () => undefined }, '../utils/logger': silentLogger,
  });
  return { db, due, run: () => materializer.materializeRoutineTasks(new Map([['owner', profile]])) };
}
test('materializer-nonduplicate-constraint-retains-cursor', async () => { const f = materializerFixture({ badConstraint: true }); try { await f.run(); assert.equal(f.db.prepare('SELECT next_run_at FROM routines').get().next_run_at, f.due); assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 0); } finally { f.db.close(); } });
test('materializer-duplicate-preserved', async () => { const f = materializerFixture({ duplicate: true }); try { await f.run(); assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 1); assert.ok(Date.parse(f.db.prepare('SELECT next_run_at FROM routines').get().next_run_at) > Date.now()); } finally { f.db.close(); } });
test('materializer-repeated-tick-once', async () => { const f = materializerFixture(); try { assert.equal(await f.run(), 1); assert.equal(await f.run(), 0); assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 1); } finally { f.db.close(); } });
test('materializer-never-stale-catches-latest-only', async () => { const f = materializerFixture({ old: true, neverStale: true }); try { await f.run(); assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 1); assert.ok(Date.parse(f.db.prepare('SELECT due_at FROM tasks').get().due_at) > Date.parse(f.due)); } finally { f.db.close(); } });
test('materializer-bounded-backlog-never-replays-old-chunks', async () => { const f = materializerFixture({ dense: true, neverStale: true }); try { await f.run(); await f.run(); await f.run(); assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 1); assert.ok(Date.now() - Date.parse(f.db.prepare('SELECT due_at FROM tasks').get().due_at) < 3600000); } finally { f.db.close(); } });
(async () => {
  const results = [];
  for (const c of cases) { try { await c.fn(); results.push({ id: c.id, status: 'pass' }); } catch (err) { results.push({ id: c.id, status: 'fail', error: err.message }); } }
  const report = { phase: before ? 'before' : 'after', beforeRevision: 'e760080', passed: results.filter(r => r.status === 'pass').length, failed: results.filter(r => r.status === 'fail').length, cases: results };
  console.log(JSON.stringify(report, null, 2));
  if (outputDir) { fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(path.join(outputDir, `${report.phase}.json`), JSON.stringify(report, null, 2)); }
  process.exitCode = report.failed ? 1 : 0;
})();
