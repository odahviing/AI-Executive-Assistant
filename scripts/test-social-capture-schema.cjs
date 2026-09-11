// Actual getDb/initSchema plus actual person-store rebuild, isolated SQLite.
// Unrelated historic migrations are closed stubs; filesystem backup writes captured.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Sqlite = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
function boot(db) {
  const backups = [], errors = [];
  const fakeFs = { existsSync: () => true, mkdirSync() {}, writeFileSync: (filename, text) => backups.push({ filename, text }) };
  const logger = { info() {}, warn() {}, error: (...args) => errors.push(args) };
  function load(relative, deps) {
    const filename = relative === 'src/db/client.ts' && process.env.CODA_WORK_BEFORE_DIR
      ? path.resolve(process.env.CODA_WORK_BEFORE_DIR, 'client.before.ts') : path.join(root, relative);
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    vm.runInNewContext(code, { exports, require: spec => {
      assert.ok(Object.hasOwn(deps, spec), `Unexpected ${spec}`); return deps[spec];
    } }, { filename });
    return exports;
  }
  const personMigration = load('src/db/migrations/v3_2_0_person_store.ts', { fs: fakeFs, path, '../../utils/logger': logger });
  const deps = { 'better-sqlite3': function Database() { return db; }, fs: fakeFs, path,
    '../config': { config: { DB_PATH: ':memory:' } }, '../utils/logger': logger,
    '../config/userProfile': { loadAllProfiles: () => [] }, './migrations/v3_2_0_person_store': personMigration };
  for (const [file, fn] of [
    ['v2_0_7_consolidate_requests','runV207ConsolidateRequests'],['v4_0_4_dedupe_people_email','runDedupePeopleByEmail'],
    ['v4_4_9_social_provenance_backfill','runSocialProvenanceBackfill'],['v4_5_3_calendar_issues_axis','runCalendarIssuesAxisMigration'],
    ['v4_5_9_purge_work_subjects','runPurgeWorkShapedSocialSubjects'],['v4_5_9_social_category_scores','runSocialCategoryScoreRebase'],
  ]) deps[`./migrations/${file}`] = { [fn]() {} };
  const client = load('src/db/client.ts', deps);
  assert.equal(client.getDb(), db); assert.equal(client.getDb(), db);
  assert.deepEqual(errors, []);
  return backups;
}
const column = db => db.pragma('table_info(people_memory)').find(c => c.name === 'last_social_capture_unknown_at');
test('regression: fresh schema adds nullable unknown watermark after real person rebuild', () => {
  const db = new Sqlite(':memory:'); try {
    const backups = boot(db); assert.equal(backups.length, 1);
    assert.equal(column(db)?.type, 'TEXT'); assert.equal(column(db)?.notnull, 0);
    db.prepare('INSERT INTO people_memory(person_id,slack_id,name) VALUES (?,?,?)').run('p_owner','U_OWNER','Owner');
    assert.equal(db.prepare('SELECT last_social_capture_unknown_at FROM people_memory').get().last_social_capture_unknown_at, null);
  } finally { db.close(); }
});
test('regression: existing migrated rows gain unknown watermark without data loss', () => {
  const db = new Sqlite(':memory:'); try {
    db.exec("CREATE TABLE people_memory(person_id TEXT PRIMARY KEY, slack_id TEXT UNIQUE, name TEXT NOT NULL, notes TEXT DEFAULT '[]', last_seen TEXT, created_at TEXT, updated_at TEXT); INSERT INTO people_memory VALUES('p_person','U_PERSON','Person','[\"retained note\"]','2026-09-01','2025-01-01','2026-09-01')");
    const before = db.prepare('SELECT * FROM people_memory').get(); boot(db);
    const after = db.prepare('SELECT * FROM people_memory').get();
    for (const [key,value] of Object.entries(before)) assert.equal(after[key], value);
    assert.equal(after.last_social_capture_unknown_at, null);
  } finally { db.close(); }
});
test('preserved: existing watermark survives repeated boots and legacy person migration is idempotent', () => {
  const db = new Sqlite(':memory:'); try {
    boot(db);
    if (!column(db)) db.exec('ALTER TABLE people_memory ADD COLUMN last_social_capture_unknown_at TEXT');
    db.prepare('INSERT INTO people_memory(person_id,slack_id,name,last_social_capture_unknown_at) VALUES (?,?,?,?)').run('p_person','U_PERSON','Person','2026-09-11T10:00:00Z');
    const before = db.prepare('SELECT * FROM people_memory').all();
    assert.equal(boot(db).length, 0); assert.equal(boot(db).length, 0);
    const after = db.prepare('SELECT * FROM people_memory').all();
    assert.equal(after.length, before.length);
    // Other legacy ALTERs can add columns after the fixed-list person rebuild;
    // this migration must preserve every existing value, including its watermark.
    for (const [key, value] of Object.entries(before[0])) assert.equal(after[0][key], value);
    assert.equal(db.pragma('table_info(people_memory)').filter(c => c.name === 'last_social_capture_unknown_at').length, 1);
  } finally { db.close(); }
});
test('preserved: reversal removes only new watermark column and keeps person data', () => {
  const db = new Sqlite(':memory:'); try {
    boot(db);
    if (!column(db)) db.exec('ALTER TABLE people_memory ADD COLUMN last_social_capture_unknown_at TEXT');
    db.prepare('INSERT INTO people_memory(person_id,slack_id,name,notes) VALUES (?,?,?,?)').run('p_person','U_PERSON','Person','["retained"]');
    const { last_social_capture_unknown_at, ...before } = db.prepare('SELECT * FROM people_memory').get();
    db.exec('ALTER TABLE people_memory DROP COLUMN last_social_capture_unknown_at');
    assert.deepEqual(db.prepare('SELECT * FROM people_memory').get(), before);
  } finally { db.close(); }
});
