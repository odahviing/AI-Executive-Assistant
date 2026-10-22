// Real local CLIs in disposable repositories. Golden replies and tsc are explicit
// fixtures: this proves orchestration/retention, never an actual independent review.
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const repo = path.resolve(__dirname, '..'), roots = [];
const v = require('./workshop-verification.cjs');
const measurements = {};
after(async () => {
  if (process.env.WORKSHOP_TEST_OUTPUT_DIR && Object.keys(measurements).length) fs.writeFileSync(path.join(process.env.WORKSHOP_TEST_OUTPUT_DIR, 'efficiency-measurements.json'), JSON.stringify(measurements, null, 2), { flag: 'wx' });
  for (const root of roots) {
    const real = fs.realpathSync(root);
    assert.equal(path.dirname(real), fs.realpathSync(repo));
    assert.ok(path.basename(real).startsWith('.workshop-preflight-'));
    await fs.promises.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(repo, '.workshop-preflight-')); roots.push(root);
  const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  for (const file of ['workshop-release.cjs', 'workshop-verification.cjs', 'ledger-stats.cjs']) write(`scripts/${file}`, fs.readFileSync(file === 'workshop-release.cjs' && process.env.WORKSHOP_BEFORE_RELEASE || path.join(__dirname, file), 'utf8'));
  write('.claude/GOLDEN_PATHS.md', fs.readFileSync(path.join(repo, '.claude/GOLDEN_PATHS.md'), 'utf8'));
  write('scripts/test-one.cjs', "console.log('2 passed; 0 failed')");
  write('scripts/test-two.cjs', "console.log('1 passed; 0 failed')");
  write('node_modules/typescript/bin/tsc', 'process.exit(0)');
  const evidence = { version: 1, attemptId: 'fixture-1', builder: 'fixture-builder', changeKind: 'prose-only', exception: 'Isolated orchestration fixture only', files: ['scripts/workshop-verification.cjs'], regressions: [], boundaries: { changedGuards: [], paths: [] } };
  const review = { attemptId: evidence.attemptId, reviewer: 'fixture-reviewer', trace: 'synthetic fixture reply', verdict: 'pass', reason: 'Fixture only', outcome: 'traced', inventoryComplete: true, guardsComplete: true, findings: [], reviewedPaths: [], checks: [], scope: 'structural' };
  const rows = [
    { ref: 'fixture-pass', verdict: 'verified', evidence, review, snapshot: v.snapshot(evidence.files, root) },
    { ref: 'fixture-decision', verdict: 'needs-owner-decision', note: 'Owner words preserved in full', recommend: 'Wait for owner ruling' },
  ];
  const resetLedger = () => write('.claude/agent-loop/ledger.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  resetLedger(); write('.claude/agent-loop/report.md', '# Fixture report\nOwner words preserved in full\n'); write('.claude/agent-loop/state.json', {});
  assert.equal(cp.spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const cli = (args, script = 'workshop-release.cjs') => cp.spawnSync(process.execPath, [`scripts/${script}`, ...args], { cwd: root, encoding: 'utf8' });
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const prepare = () => {
    const run = cli(['--out', 'checkpoint']); assert.equal(run.status, 0, run.stdout + run.stderr);
    const capture = cli(['--golden-snapshot']); assert.equal(capture.status, 0, capture.stderr); write('snapshot.json', capture.stdout);
    write('golden/return.json', { itemsInFile: 30, goldenTraces: Array.from({ length: 30 }, (_, i) => ({ id: `Z${i + 1}`, verdict: 'pass', evidence: 'synthetic fixture:1; no actual independent review claimed' })) });
    const golden = cli(['--golden-report', 'snapshot.json', 'golden/return.json']); assert.equal(golden.status, 0, golden.stderr); write('golden/report.json', golden.stdout);
    write('refs.json', rows.map(r => r.ref));
    const draft = cli(['--bookkeeping-plan', 'refs.json', '--version', '1.2.3']); assert.equal(draft.status, 0, draft.stderr); write('plan.json', draft.stdout);
  };
  const args = (out = 'preflight') => ['--preflight', '--check', 'checkpoint/report.json', '--check-golden', 'golden/report.json', '--check-bookkeeping', 'plan.json', '--out', out, '--summary'];
  const preserved = () => v.snapshot(['.claude/agent-loop/ledger.jsonl', '.claude/agent-loop/report.md', '.claude/agent-loop/state.json', 'plan.json', 'checkpoint/report.json', 'golden/report.json', 'golden/return.json'], root);
  return { root, write, read, rows, cli, prepare, args, preserved, resetLedger };
}
test('preserved standalone JSON producers and exact validations retain complete evidence without mutation', () => {
  const f = fixture(); f.prepare(); const before = f.preserved(), draft = f.read('plan.json');
  assert.equal(draft.report, '# Fixture report\nOwner words preserved in full\n');
  assert.equal(draft.dispositions[0].current.note, 'Owner words preserved in full');
  assert.deepEqual(draft.reviews[0].review, f.rows[0].review);
  for (const args of [['--check', 'checkpoint/report.json'], ['--check-golden', 'golden/report.json'], ['--check-bookkeeping', 'plan.json']]) { const r = f.cli(args); assert.equal(r.status, 0, r.stderr); assert.ok(JSON.parse(r.stdout).status); }
  assert.equal(f.cli(['--verification', '--json'], 'ledger-stats.cjs').status, 0);
  assert.deepEqual(f.preserved(), before);
});
test('summary execution reduces stdout while retaining every suite, typecheck and immutable report', () => {
  const f = fixture(), full = f.cli(['--out', 'full']), compact = f.cli(['--out', 'mini', '--summary']);
  assert.equal(full.status, 0, full.stderr); assert.equal(compact.status, 0, compact.stderr);
  const a = f.read('full/report.json'), b = f.read('mini/report.json');
  assert.deepEqual(a.checks, b.checks); assert.deepEqual(a.typecheck, b.typecheck); assert.deepEqual(a.snapshot, b.snapshot);
  for (const check of [...b.checks, b.typecheck]) assert.equal(fs.readFileSync(path.join(f.root, 'mini', check.output), 'utf8'), fs.readFileSync(path.join(f.root, 'full', check.output), 'utf8'));
  assert.equal(compact.stdout.trim().split(/\r?\n/).length, 1);
  assert.ok(Buffer.byteLength(compact.stdout) < Buffer.byteLength(full.stdout));
  const before = fs.readFileSync(path.join(f.root, 'mini/report.json'));
  assert.equal(f.cli(['--out', 'mini', '--summary']).status, 1); assert.deepEqual(fs.readFileSync(path.join(f.root, 'mini/report.json')), before);
  measurements.execution = { defaultStdoutBytes: Buffer.byteLength(full.stdout), summaryStdoutBytes: Buffer.byteLength(compact.stdout), defaultLines: full.stdout.trim().split(/\r?\n/).length, summaryLines: compact.stdout.trim().split(/\r?\n/).length, suiteExecutionsEach: b.checks.length, testPassesEach: b.checks.reduce((n, c) => n + c.passed, 0), typechecksEach: 1 };
});
test('summary failures retain suite diagnostics and typecheck errors with complete output locations', () => {
  const f = fixture(); f.write('scripts/test-one.cjs', "console.error('fixture assertion detail'); console.log('0 passed; 1 failed'); process.exitCode=1");
  f.write('node_modules/typescript/bin/tsc', "console.error('fixture TS123 diagnostic'); process.exitCode=2");
  const r = f.cli(['--out', 'failed', '--summary']); assert.equal(r.status, 1);
  const report = f.read('failed/report.json'); assert.equal(report.checks.length, 2);
  assert.match(r.stdout, /FAIL scripts\/test-one.cjs/); assert.match(r.stderr, /typecheck failed or incomplete/); assert.ok(r.stderr.includes(JSON.stringify(path.join(f.root, 'failed/typecheck.log'))));
  assert.match(fs.readFileSync(path.join(f.root, 'failed', report.checks[0].output), 'utf8'), /fixture assertion detail/);
  assert.match(fs.readFileSync(path.join(f.root, 'failed/typecheck.log'), 'utf8'), /TS123/);
});
test('summary refuses JSON producer commands instead of dropping the bookkeeping draft', () => {
  const f = fixture(); f.prepare(); const r = f.cli(['--bookkeeping-plan', 'refs.json', '--version', '1.2.3', '--summary']);
  assert.equal(r.status, 1); assert.match(r.stderr, /JSON producers retain their complete output/);
});
test('full preflight matches four standalone gates, retains evidence, retries read-only and uses one caller invocation', () => {
  const f = fixture(); f.prepare(); const before = f.preserved();
  const commands = [['--check', 'checkpoint/report.json'], ['--check-golden', 'golden/report.json'], ['--verification', '--json'], ['--check-bookkeeping', 'plan.json']];
  const standalone = commands.map((args, i) => f.cli(args, i === 2 ? 'ledger-stats.cjs' : 'workshop-release.cjs'));
  standalone.forEach(r => assert.equal(r.status, 0, r.stderr));
  const r = f.cli(f.args()); assert.equal(r.status, 0, r.stderr);
  const report = f.read('preflight/report.json'); assert.equal(report.scope, 'preflight'); assert.equal(report.status, 'passed');
  assert.deepEqual(report.checks.map(c => c.id), ['checkpoint', 'golden', 'verification', 'bookkeeping']);
  for (const [i, c] of report.checks.entries()) if (i === 2) assert.deepEqual(c.blockers, JSON.parse(standalone[i].stdout)); else {
    const { id, ...result } = c; assert.deepEqual(result, JSON.parse(standalone[i].stdout));
  }
  assert.equal(fs.readFileSync(path.join(f.root, 'preflight/verification.log'), 'utf8'), standalone[2].stdout + standalone[2].stderr);
  assert.match(r.stdout, /4\/4 checks/); assert.match(r.stdout, /no release authorization/);
  assert.equal(r.stdout.trim().split(/\r?\n/).length, 1);
  assert.equal(f.cli(f.args('retry')).status, 0); assert.deepEqual(f.preserved(), before);
  const oldReport = fs.readFileSync(path.join(f.root, 'preflight/report.json'));
  assert.equal(f.cli(f.args()).status, 1); assert.deepEqual(fs.readFileSync(path.join(f.root, 'preflight/report.json')), oldReport);
  measurements.preflight = { standaloneCallerInvocations: commands.length, batchedCallerInvocations: 1, standaloneNodeProcesses: 4, batchedNodeProcesses: 2, standaloneStdoutBytes: standalone.reduce((n, r) => n + Buffer.byteLength(r.stdout), 0), batchedStdoutBytes: Buffer.byteLength(r.stdout), coveredGates: report.checks.map(c => c.id), modelRoundTrips: 'not measured: the regression harness invokes CLIs directly; no model calls or token savings claimed' };
});
test('quick package preflight does not claim Golden or accept package evidence as full', () => {
  const f = fixture(); f.prepare(); f.write('suites.json', ['test-one.cjs']);
  assert.equal(f.cli(['--suites', 'suites.json', '--out', 'package']).status, 0);
  const quick = ['--preflight', '--check-package', 'package/report.json', '--check-bookkeeping', 'plan.json', '--out', 'quick', '--summary'];
  assert.equal(f.cli(quick).status, 0); const report = f.read('quick/report.json');
  assert.equal(report.checkpointScope, 'package'); assert.deepEqual(report.checks.map(c => c.id), ['checkpoint', 'verification', 'bookkeeping']);
  const wrong = f.args('wrong'); wrong[2] = 'package/report.json'; assert.equal(f.cli(wrong).status, 1); assert.equal(f.read('wrong/report.json').checks.length, 1);
  assert.equal(f.cli(['--check', 'quick/report.json']).status, 1);
});
test('checkpoint failure short-circuits later missing evidence and preserves actionable errors', () => {
  const f = fixture(); f.prepare(); const report = f.read('checkpoint/report.json'); report.checks[0].failed = 1; f.write('checkpoint/report.json', report);
  fs.unlinkSync(path.join(f.root, 'golden/report.json')); fs.unlinkSync(path.join(f.root, 'plan.json'));
  const r = f.cli(f.args()); assert.equal(r.status, 1); assert.match(r.stderr, /execution failed or incomplete: scripts\/test-one.cjs/);
  const result = f.read('preflight/report.json'); assert.deepEqual(result.checks.map(c => c.id), ['checkpoint']); assert.equal(fs.existsSync(path.join(f.root, 'preflight/verification.log')), false);
});
test('missing malformed partial stale and tampered checkpoint evidence all fail closed', () => {
  for (const kind of ['missing', 'malformed', 'partial', 'source', 'output']) {
    const f = fixture(); f.prepare();
    if (kind === 'missing') fs.unlinkSync(path.join(f.root, 'checkpoint/report.json'));
    if (kind === 'malformed') f.write('checkpoint/report.json', '{invalid');
    if (kind === 'partial') { const p = f.read('checkpoint/report.json'); p.checks.pop(); f.write('checkpoint/report.json', p); }
    if (kind === 'source') f.write('scripts/test-one.cjs', '// stale source');
    if (kind === 'output') f.write(`checkpoint/${f.read('checkpoint/report.json').checks[0].output}`, 'tampered log');
    const r = f.cli(f.args()); assert.equal(r.status, 1, kind); const p = f.read('preflight/report.json'); assert.equal(p.checks.length, 1); assert.equal(p.status, 'blocked');
  }
});
test('failed missing malformed and stale Golden evidence stop before ledger verification', () => {
  for (const kind of ['failed', 'missing', 'malformed', 'stale', 'output']) {
    const f = fixture(); f.prepare();
    if (kind === 'missing') fs.unlinkSync(path.join(f.root, 'golden/report.json'));
    if (kind === 'malformed') f.write('golden/report.json', 'null');
    if (kind === 'failed') { const g = f.read('golden/report.json'); g.goldenTraces[0].verdict = 'fail'; f.write('golden/report.json', g); }
    if (kind === 'stale') fs.appendFileSync(path.join(f.root, '.claude/GOLDEN_PATHS.md'), '\nchanged');
    if (kind === 'output') f.write('golden/return.json', '{}');
    const r = f.cli(f.args()); assert.equal(r.status, 1, kind); assert.deepEqual(f.read('preflight/report.json').checks.map(c => c.id), ['checkpoint', 'golden']);
    assert.equal(fs.existsSync(path.join(f.root, 'preflight/verification.log')), false);
  }
});
test('native verification failure and unavailable ledger stop before bookkeeping and retain ref diagnostics', () => {
  for (const kind of ['unreviewed', 'missing', 'malformed']) {
    const f = fixture(); f.prepare();
    if (kind === 'unreviewed') { f.rows[0].review.verdict = 'fail'; f.resetLedger(); }
    if (kind === 'missing') fs.unlinkSync(path.join(f.root, '.claude/agent-loop/ledger.jsonl'));
    if (kind === 'malformed') f.write('.claude/agent-loop/ledger.jsonl', '{invalid\n');
    const r = f.cli(f.args()); assert.equal(r.status, 1, kind); const p = f.read('preflight/report.json'); assert.equal(p.checks.at(-1).id, 'verification'); assert.equal(p.checks.length, 3);
    assert.ok(fs.readFileSync(path.join(f.root, 'preflight/verification.log'), 'utf8').length);
    if (kind === 'unreviewed') assert.match(r.stderr, /fixture-pass/); else assert.match(r.stderr, /VERIFICATION NOT ESTABLISHED/);
  }
});
test('large failed verification prints bounded diagnostics and preserves every blocker on disk', () => {
  const f = fixture(); f.prepare();
  const rows = Array.from({ length: 200 }, (_, i) => ({ ref: `unreviewed-${i}`, verdict: 'built' }));
  f.write('.claude/agent-loop/ledger.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const r = f.cli(f.args()); assert.equal(r.status, 1);
  const p = f.read('preflight/report.json'), failed = p.checks.at(-1);
  assert.equal(failed.id, 'verification'); assert.equal(failed.blockers.length, 200);
  const retained = fs.readFileSync(path.join(f.root, 'preflight/verification.log'), 'utf8'); assert.equal(JSON.parse(retained).length, 200);
  const diagnostic = JSON.parse(r.stderr);
  assert.equal(diagnostic.blockerCount, 200); assert.ok(diagnostic.omittedCharacters > 0);
  assert.equal(diagnostic.stdoutBytesRetained, Buffer.byteLength(retained));
  assert.ok(Buffer.byteLength(r.stderr) < 6000); assert.match(r.stderr, /unreviewed-0/); assert.equal(diagnostic.output, path.join(f.root, 'preflight/verification.log'));
  measurements.largeFailure = { blockersRetained: failed.blockers.length, fullLogBytes: Buffer.byteLength(retained), stderrBytes: Buffer.byteLength(r.stderr), omittedCharacters: diagnostic.omittedCharacters };
});
test('bookkeeping freshness missing and malformed drafts block with a valid restore', () => {
  const f = fixture(); f.prepare(); const original = fs.readFileSync(path.join(f.root, 'plan.json'), 'utf8');
  fs.appendFileSync(path.join(f.root, '.claude/agent-loop/report.md'), 'new owner ruling');
  let r = f.cli(f.args('stale')); assert.equal(r.status, 1); assert.match(r.stderr, /bookkeeping draft changed/);
  f.write('.claude/agent-loop/report.md', '# Fixture report\nOwner words preserved in full\n');
  fs.unlinkSync(path.join(f.root, 'plan.json')); assert.equal(f.cli(f.args('missing')).status, 1);
  f.write('plan.json', '{}'); assert.equal(f.cli(f.args('malformed')).status, 1);
  f.write('plan.json', original); assert.equal(f.cli(f.args('restored')).status, 0);
});
test('preflight rejects missing Golden, arbitrary commands, duplicate flags and write options before output creation', () => {
  const f = fixture(); f.prepare();
  for (const args of [
    ['--preflight', '--check', 'checkpoint/report.json', '--check-bookkeeping', 'plan.json', '--out', 'bad'],
    [...f.args('bad').slice(0, -1), '--commit'],
    [...f.args('bad').slice(0, -1), '--check-bookkeeping', 'plan.json'],
    ['--preflight', '--run', 'scripts/ledger-file.cjs', '--out', 'bad'],
  ]) assert.equal(f.cli(args).status, 1);
  assert.equal(fs.existsSync(path.join(f.root, 'bad')), false);
});
test('source change during a native check blocks the final result even when individual gates pass', () => {
  const f = fixture(), checker = path.join(f.root, 'scripts/ledger-stats.cjs');
  // Controlled outside-writer simulation at a check boundary; the native checker
  // below this prelude is intact and still executes its real verification gate.
  const original = fs.readFileSync(checker, 'utf8').replace(/^#![^\n]*\n/, '');
  f.write('scripts/ledger-stats.cjs', "require('node:fs').appendFileSync('scripts/test-one.cjs','\\n// simulated concurrent edit');\n" + original);
  f.prepare();
  const r = f.cli(f.args()); assert.equal(r.status, 1); const report = f.read('preflight/report.json');
  assert.equal(report.checks.length, 4); assert.ok(report.checks.every(c => c.status !== 'blocked'));
  assert.ok(report.changed.includes('scripts/test-one.cjs')); assert.match(r.stderr, /changed during validation/);
});
function changeOnVerificationExit(f, file) {
  const checker = path.join(f.root, 'scripts/ledger-stats.cjs'), original = fs.readFileSync(checker, 'utf8').replace(/^#![^\n]*\n/, '');
  // Simulate an outside edit after the real native verification gate has read
  // its inputs, without replacing its verdict or process exit semantics.
  f.write('scripts/ledger-stats.cjs', `process.on('exit', () => require('node:fs').appendFileSync(${JSON.stringify(file)}, '\\nchanged after native verification'));\n` + original);
}
test('retained suite, typecheck and Golden outputs changed during verification block final preflight', () => {
  for (const file of ['checkpoint/001-test-one.cjs-UTC.log', 'checkpoint/typecheck.log', 'golden/return.json']) {
    const f = fixture(); changeOnVerificationExit(f, file); f.prepare();
    const r = f.cli(f.args()), report = f.read('preflight/report.json');
    assert.equal(f.cli(file.startsWith('golden') ? ['--check-golden', 'golden/report.json'] : ['--check', 'checkpoint/report.json']).status, 1);
    assert.equal(r.status, 1, `preflight accepted mutated dependency ${file}`);
    assert.equal(report.status, 'blocked'); assert.equal(report.checks.length, 4);
    assert.ok(report.checks.every(c => c.status !== 'blocked'));
    assert.ok(report.changed.includes(file), `changed dependency missing: ${file}`);
  }
});
test('native reviewed prose outside selected bookkeeping scope is captured for the whole preflight', () => {
  const f = fixture(); f.write('reviewed-prose.md', 'native reviewed content');
  f.rows[0].evidence.files = ['reviewed-prose.md']; f.rows[0].snapshot = v.snapshot(f.rows[0].evidence.files, f.root); f.resetLedger();
  changeOnVerificationExit(f, 'reviewed-prose.md'); f.prepare();
  f.write('refs.json', ['fixture-decision']);
  const draft = f.cli(['--bookkeeping-plan', 'refs.json', '--version', '1.2.3']); assert.equal(draft.status, 0, draft.stderr); f.write('plan.json', draft.stdout);
  const r = f.cli(f.args()), report = f.read('preflight/report.json');
  assert.equal(f.cli(['--verification', '--json'], 'ledger-stats.cjs').status, 1);
  assert.equal(r.status, 1, 'preflight accepted changed native review dependency outside selected draft refs');
  assert.equal(report.checks.length, 4); assert.ok(report.checks.every(c => c.status !== 'blocked'));
  assert.ok(report.changed.includes('reviewed-prose.md'));
});
test('native content-addressed attachments retain valid control and reject post-verification mutation', () => {
  for (const kind of ['valid', 'evidenceRef', 'reviewRef']) {
    const f = fixture(); f.rows[0] = v.compactRow(f.rows[0], f.root); f.resetLedger();
    if (kind !== 'valid') changeOnVerificationExit(f, f.rows[0][kind].file);
    f.prepare();
    const r = f.cli(f.args()), report = f.read('preflight/report.json');
    assert.equal(r.status, kind === 'valid' ? 0 : 1, kind);
    if (kind !== 'valid') {
      assert.equal(report.checks.at(-1).id, 'bookkeeping');
      assert.match(r.stderr, /evidence hash mismatch/);
    }
  }
});
