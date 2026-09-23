const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const file = before ? 'artifacts/workshop-verification/v5-readiness-20260923/handyman/attempt1/before/src/db/client.ts' : 'src/db/client.ts';
function fixture() {
  const tree = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const nodes = tree.statements.filter(n => ts.isFunctionDeclaration(n) && ['getDb','recentAuditEntries'].includes(n.name?.text)
    || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(tree) === 'db'));
  let failure = 'schema', opens = 0, initializations = 0;
  const handles = [];
  const module = { exports: {} };
  const context = { exports: module.exports, path, config: { DB_PATH: '/fixture/database.db' }, fs: { existsSync: () => true },
    logger: { info() {}, error() {} },
    Database: function() {
      if (failure === 'open') throw Error('open unavailable');
      opens++;
      const handle = { closed: false, initialized: false, close() { this.closed = true; }, pragma() {
        if (failure === 'pragma') throw Error('pragma unavailable');
        return [{ name: 'last_social_capture_unknown_at' }];
      }, exec() {}, prepare() { assert.equal(this.initialized, true, 'consumer must receive initialized handle'); return { all: () => [] }; } };
      handles.push(handle); return handle;
    },
    initSchema(db) { initializations++; if (failure === 'schema') throw Error('schema unavailable'); db.initialized = true; },
  };
  for (const name of ['runV207ConsolidateRequests','runPersonStoreMigration','runDedupePeopleByEmail','runSocialProvenanceBackfill','runCalendarIssuesAxisMigration','runPurgeWorkShapedSocialSubjects','runSocialCategoryScoreRebase']) context[name] = () => {};
  vm.runInNewContext(ts.transpileModule(nodes.map(n => n.getText(tree)).join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { ...module.exports, handles, failure(value) { failure = value; }, counts: () => ({ opens, initializations }) };
}
test('schema failure must not publish half-initialized handle on retry', () => {
  const f = fixture();
  assert.throws(() => f.getDb(), /schema unavailable/);
  assert.throws(() => f.getDb(), /schema unavailable/);
  assert.equal(f.counts().initializations, 2);
});
test('failed initialization releases SQLite handle', () => {
  const f = fixture();
  assert.throws(() => f.getDb());
  assert.equal(f.handles[0].closed, true);
});
test('later caller recovers after unavailable schema initialization', () => {
  const f = fixture();
  assert.throws(() => f.getDb());
  f.failure(undefined);
  const rows = f.recentAuditEntries({ ownerUserId: 'U_OWNER', action: 'fixture' });
  assert.equal(rows.length, 0);
  assert.equal(f.counts().opens, 2);
});
test('pragma failure releases handle and retries initialization', () => {
  const f = fixture(); f.failure('pragma');
  assert.throws(() => f.getDb());
  assert.equal(f.handles[0].closed, true);
  f.failure(undefined);
  assert.equal(f.getDb().initialized, true);
});
test('successful initialization remains one singleton', () => {
  const f = fixture(); f.failure(undefined);
  assert.equal(f.getDb(), f.getDb());
  assert.equal(f.counts().initializations, 1);
});
test('constructor failure can retry without a stale cached handle', () => {
  const f = fixture(); f.failure('open');
  assert.throws(() => f.getDb(), /open unavailable/);
  f.failure(undefined);
  assert.equal(f.getDb().initialized, true);
});
