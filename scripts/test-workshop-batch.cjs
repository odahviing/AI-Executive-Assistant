// Native writer integration, isolated adopted ledger, real projection and locks.
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(repo, '.workshop-batch-'));
const v = require('./workshop-verification.cjs');
fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, '.claude/agent-loop'), { recursive: true });
for (const f of ['ledger-file.cjs', 'workshop-verification.cjs', 'workshop-intake.cjs', 'architect-file.cjs']) fs.copyFileSync(f === 'ledger-file.cjs' && process.env.WORKSHOP_BEFORE_LEDGER || path.join(__dirname, f), path.join(root, 'scripts', f));
const ledger = path.join(root, '.claude/agent-loop/ledger.jsonl'), report = path.join(root, '.claude/agent-loop/report.md');
fs.writeFileSync(path.join(root, 'source.txt'), 'fixture source');
const evidence = { version: 1, attemptId: 'a1', builder: 'builder', changeKind: 'prose-only', exception: 'Writer fixture, not product verification', files: ['source.txt'], regressions: [], boundaries: { paths: [], changedGuards: [] } };
const review = { attemptId: 'a1', reviewer: 'bouncer', trace: 'fixture', verdict: 'pass', reason: 'fixture independent pass', outcome: 'traced', inventoryComplete: true, guardsComplete: true, findings: [], reviewedPaths: [], checks: [], scope: 'structural' };
fs.writeFileSync(path.join(root, 'review.json'), JSON.stringify(review));
function reset(n = 3) {
  fs.writeFileSync(ledger, Array.from({ length: n }, (_, i) => JSON.stringify({ ref: `fix-${i}`, verdict: 'implemented', evidence, snapshot: v.snapshot(evidence.files, root) })).join('\n') + '\n');
  fs.writeFileSync(report, '<!-- workshop-ledger-report-v1 -->\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'fixture source');
}
const commands = n => Array.from({ length: n }, (_, i) => ['--review', '--ref', `fix-${i}`, '--review-file', 'review.json', '--runId', 'review-wave']);
const cli = args => cp.spawnSync(process.execPath, ['scripts/ledger-file.cjs', ...args], { cwd: root, encoding: 'utf8' });
function batch(a) { fs.writeFileSync(path.join(root, 'batch.json'), JSON.stringify(a)); return cli(['--batch-file', 'batch.json']); }
const result = r => JSON.parse(r.stdout.trim().split('\n').at(-1));
after(async () => { const real = fs.realpathSync(root); assert.equal(path.dirname(real), fs.realpathSync(repo)); assert.ok(path.basename(real).startsWith('.workshop-batch-')); await fs.promises.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
test('single native review remains supported', () => { reset(); assert.equal(cli(commands(1)[0]).status, 0); assert.equal(v.readRows(ledger).length, 4); });
test('batch retains three independent rows and reconciles once', () => { reset(); const r = batch(commands(3)); assert.equal(r.status, 0, r.stderr); assert.deepEqual(result(r), { appended: 3, skipped: 0, reportReconciliations: 1 }); assert.equal(v.readRows(ledger).length, 6); assert.equal(require(path.join(root, 'scripts/workshop-intake.cjs')).reconcile(root).current, true); });
test('identical retry appends zero and repairs projection', () => { reset(); assert.equal(batch(commands(3)).status, 0); fs.writeFileSync(report, '<!-- workshop-ledger-report-v1 -->\nstale'); const r = batch(commands(3)); assert.equal(r.status, 0, r.stderr); assert.equal(result(r).appended, 0); assert.equal(v.readRows(ledger).length, 6); assert.equal(require(path.join(root, 'scripts/workshop-intake.cjs')).reconcile(root).current, true); });
test('later invalid review causes no partial append', () => { reset(); const before = fs.readFileSync(ledger, 'utf8'); const a = commands(3); a[2][2] = 'missing'; assert.equal(batch(a).status, 1); assert.equal(fs.readFileSync(ledger, 'utf8'), before); });
test('lock conflict refuses without stealing or writing', () => { reset(); fs.writeFileSync(ledger + '.lock', 'existing'); try { assert.equal(batch(commands(3)).status, 1); assert.equal(fs.readFileSync(ledger + '.lock', 'utf8'), 'existing'); assert.equal(v.readRows(ledger).length, 3); } finally { fs.unlinkSync(ledger + '.lock'); } });
test('malformed partial ledger is blocked on retry', () => { reset(); fs.appendFileSync(ledger, '{partial'); const before = fs.readFileSync(ledger, 'utf8'); assert.equal(batch(commands(3)).status, 1); assert.equal(fs.readFileSync(ledger, 'utf8'), before); });
test('stale reviewed source rejects replay', () => { reset(); assert.equal(batch(commands(3)).status, 0); fs.writeFileSync(path.join(root, 'source.txt'), 'changed'); assert.equal(batch(commands(3)).status, 1); fs.writeFileSync(path.join(root, 'source.txt'), 'fixture source'); });
test('wrong attempt or builder self-review blocks whole batch', () => { for (const bad of [{ ...review, attemptId: 'old' }, { ...review, reviewer: 'builder' }]) { reset(); fs.writeFileSync(path.join(root, 'bad.json'), JSON.stringify(bad)); const a = commands(3); a[2][4] = 'bad.json'; assert.equal(batch(a).status, 1); assert.equal(v.readRows(ledger).length, 3); } });
test('failure remains append-only and never silently replayed as pass', () => { reset(); fs.writeFileSync(path.join(root, 'fail.json'), JSON.stringify({ ...review, verdict: 'fail' })); const a = commands(1); a[0][4] = 'fail.json'; assert.equal(batch(a).status, 0); assert.equal(v.collapseRows(v.readRows(ledger)).latest[0].verdict, 'verification-failed'); });
test('bounded batch rejects empty duplicate refs and mixed phases', () => { reset(); for (const a of [[], [commands(1)[0], commands(1)[0]], [commands(1)[0], ['--wrap-companion', '--ref', 'fix-1']]]) assert.equal(batch(a).status, 1); });
test('projection failure after append retries without duplicate history', () => { reset(); fs.unlinkSync(report); fs.mkdirSync(report); const r = batch(commands(3)); assert.equal(r.status, 1); assert.equal(v.readRows(ledger).length, 6); fs.rmdirSync(report); fs.writeFileSync(report, '<!-- workshop-ledger-report-v1 -->\n'); const retry = batch(commands(3)); assert.equal(retry.status, 0, retry.stderr); assert.equal(result(retry).appended, 0); });
test('wrap companions remain separate and identical retry is idempotent', () => { reset(); assert.equal(batch(commands(3)).status, 0); const a = commands(3).map((_, i) => ['--wrap-companion', '--ref', `fix-${i}`, '--version', '1.2.3', '--sha', 'fixture-commit']); const r = batch(a); assert.equal(r.status, 0, r.stderr); assert.equal(result(r).appended, 3); const retry = batch(a); assert.equal(retry.status, 0, retry.stderr); assert.equal(result(retry).appended, 0); assert.equal(v.readRows(ledger).length, 9); });
test('same 15 reviews: serial versus batch timings and identical lifecycle', () => {
  const n = 15; reset(n); const start = performance.now(); for (const a of commands(n)) assert.equal(cli(a).status, 0); const serialMs = performance.now() - start; const serial = v.readRows(ledger);
  reset(n); const begin = performance.now(), r = batch(commands(n)); const batchMs = performance.now() - begin;
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(v.readRows(ledger), serial);
  console.log(JSON.stringify({ measurement: 'same 15 review appends; real native writer and adopted report', serialMs, batchMs, serialProcesses: 15, batchProcesses: 1, serialReconciliations: 15, batchReconciliations: result(r).reportReconciliations }));
});
