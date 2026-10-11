const { test, after } = require('node:test')
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..'), before = process.argv.indexOf('--before-dir')
const source = before < 0 ? repo : path.resolve(process.argv[before + 1])
const fixtureParent = fs.realpathSync(repo)
const roots = []
after(async () => { for (const root of roots) { assert.equal(path.dirname(fs.realpathSync(root)), fixtureParent); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) } })
function fixture(text = 'Reviewed implementation\n') {
  const root = fs.mkdtempSync(path.join(fixtureParent, '.architect-shipped-')); roots.push(root)
  const loop = path.join(root, '.claude/agent-loop'); fs.mkdirSync(loop, { recursive: true }); fs.mkdirSync(path.join(root, 'scripts'))
  for (const file of ['architect-file.cjs', 'workshop-verification.cjs', 'workshop-intake.cjs', 'ledger-stats.cjs', 'ledger-file.cjs']) fs.copyFileSync(path.join(file === 'architect-file.cjs' ? source : repo, 'scripts', file), path.join(root, 'scripts', file))
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8' })
  const ok = r => { assert.equal(r.status, 0, r.stderr + r.stdout); return r }
  const git = (...args) => ok(run('git', args)).stdout.trim()
  git('init', '--quiet'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture'); git('config', 'core.autocrlf', 'false')
  const json = (name, value) => { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(value)); return file }
  const cli = (name, ...args) => run(process.execPath, [path.join(root, 'scripts', name), ...args])
  const arch = (...args) => cli('architect-file.cjs', '--session', 'architect', ...args)
  const native = () => JSON.parse(ok(cli('ledger-stats.cjs', '--architect', '--json')).stdout)
  const evidence = attemptId => ({ version: 1, attemptId, builder: 'builder', changeKind: 'prose-only', exception: 'Isolated lifecycle fixture.', files: ['fixture.md'], regressions: [], boundaries: { changedGuards: [], paths: [] } })
  const review = (attemptId, verdict = 'pass') => ({ attemptId, reviewer: 'independent', trace: 'Executed fixture trace', verdict, reason: 'Independent lifecycle fixture.', outcome: verdict === 'pass' ? 'traced' : 'refuted', inventoryComplete: true, guardsComplete: true, scope: 'behavioral', findings: verdict === 'pass' ? [] : ['failed'], reviewedPaths: [], checks: [] })
  fs.writeFileSync(path.join(root, 'fixture.md'), text)
  json('.claude/agent-loop/state.json', { lastRun: { status: 'complete' }, inFlight: [] })
  fs.writeFileSync(path.join(loop, 'ledger.jsonl'), '')
  fs.writeFileSync(path.join(loop, 'architect-ledger.jsonl'), JSON.stringify({ id: 'X1', verdict: 'open', finding: 'Concrete framework lifecycle fixture.', target: 'scripts', evidence: 'fixture.md:1' }) + '\n')
  ok(cli('ledger-file.cjs', '--capture-file', json('capture.json', { id: 'owner-capture', ref: 'alpha', type: 'bug', finding: 'Owner reports an unrelated product defect.', attachments: [] })))
  const build = id => ok(arch('--implementation', 'X1', '--evidence-file', json('build.json', evidence(id))))
  const check = (id, verdict = 'pass') => arch('--review', 'X1', '--review-file', json('review.json', review(id, verdict)))
  build('a1'); ok(check('a1'))
  const commit = (version = '1.2.3', content = text) => { fs.writeFileSync(path.join(root, 'fixture.md'), content); git('add', 'fixture.md'); git('commit', '--quiet', '--allow-empty', '-m', version + ': Fixture release'); return git('rev-parse', 'HEAD') }
  const sha = commit()
  const wrap = (...extra) => arch('--wrap-companion', 'X1', '--attempt-id', 'a1', '--version', '1.2.3', '--sha', sha, ...extra)
  return { root, loop, json, cli, arch, native, git, ok, build, check, wrap, sha, commit, evidence, review }
}
test('shipped pass remains historical after shared-file edits; report and native reader agree', () => {
  const f = fixture(); f.ok(f.wrap()); fs.writeFileSync(path.join(f.root, 'fixture.md'), 'Later substantive change')
  assert.equal(f.native().open, 0); assert.equal(f.native().items[0].verdict, 'wrapped')
  f.ok(f.cli('ledger-file.cjs', '--sync-report')); assert.doesNotMatch(fs.readFileSync(path.join(f.loop, 'report.md'), 'utf8'), /X1/)
})
test('unwrapped pass still becomes stale after shared-file edits', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, 'fixture.md'), 'Later substantive change')
  assert.equal(f.native().open, 1); assert.equal(f.native().items[0].verdict, 'verification-unproven')
})
test('historical exact release may be recorded after current source changes', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, 'fixture.md'), 'Later substantive change'); f.ok(f.wrap()); assert.equal(f.native().open, 0)
})
test('mixed CRLF and LF review bytes normalize only after exact recorded hash proof', () => {
  const f = fixture('first\r\nsecond\n'); const sha = f.commit('1.2.3', 'first\nsecond\n')
  fs.mkdirSync(path.join(f.root, 'preserved')); fs.writeFileSync(path.join(f.root, 'preserved/fixture.md'), 'first\r\nsecond\n')
  f.ok(f.arch('--wrap-companion', 'X1', '--attempt-id', 'a1', '--version', '1.2.3', '--sha', sha, '--snapshot-root', path.join(f.root, 'preserved')))
  assert.equal(f.native().items[0].release.files[0].normalization, 'crlf-to-lf')
  fs.writeFileSync(path.join(f.root, 'fixture.md'), 'Later change'); fs.unlinkSync(path.join(f.root, 'preserved/fixture.md'))
  f.ok(f.arch('--wrap-companion', 'X1', '--attempt-id', 'a1', '--version', '1.2.3', '--sha', sha))
})
test('normalization refuses substantive release differences', () => {
  const f = fixture('first\r\nsecond\n'); const sha = f.commit('1.2.3', 'first\nCHANGED\n')
  fs.writeFileSync(path.join(f.root, 'fixture.md'), 'first\r\nsecond\n')
  assert.notEqual(f.arch('--wrap-companion', 'X1', '--attempt-id', 'a1', '--version', '1.2.3', '--sha', sha).status, 0)
})
test('normalization refuses bytes not proven by the recorded review hash', () => {
  const f = fixture('first\r\nsecond\n'); const sha = f.commit('1.2.3', 'first\nsecond\n')
  assert.notEqual(f.arch('--wrap-companion', 'X1', '--attempt-id', 'a1', '--version', '1.2.3', '--sha', sha).status, 0)
})
for (const variant of ['attempt', 'version', 'sha', 'bookkeeping']) test(`release refuses mismatched ${variant}`, () => {
  const f = fixture(); let sha = f.sha, version = '1.2.3', attempt = 'a1'
  if (variant === 'attempt') attempt = 'a0'
  if (variant === 'version') version = '1.2.4'
  if (variant === 'sha') sha = 'deadbeef'
  if (variant === 'bookkeeping') { f.git('commit', '--quiet', '--allow-empty', '-m', '1.2.3 bookkeeping: fixture'); sha = f.git('rev-parse', 'HEAD') }
  assert.notEqual(f.arch('--wrap-companion', 'X1', '--attempt-id', attempt, '--version', version, '--sha', sha).status, 0)
})
test('new attempt reopens shipped work without erasing the earlier companion', () => {
  const f = fixture(); f.ok(f.wrap()); const history = fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8')
  f.build('a2'); assert.equal(f.native().open, 1); assert.equal(f.native().items[0].verdict, 'implemented'); assert.notEqual(f.wrap().status, 0)
  assert.ok(fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8').startsWith(history))
})
test('failed independent review reopens shipped work and blocks companion replay', () => {
  const f = fixture(); f.ok(f.wrap()); f.ok(f.check('a1', 'fail')); assert.equal(f.native().open, 1); assert.notEqual(f.wrap().status, 0)
})
test('identical retry is append-once, including recovery from report failure', () => {
  const f = fixture(); const report = path.join(f.loop, 'report.md'); fs.unlinkSync(report); fs.mkdirSync(report)
  assert.notEqual(f.wrap().status, 0); const history = fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8')
  fs.rmdirSync(report); f.ok(f.wrap()); assert.equal(fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8'), history); assert.equal(f.native().open, 0)
})
test('live run cannot append release metadata', () => {
  const f = fixture(); f.json('.claude/agent-loop/state.json', { lastRun: { status: 'running' }, inFlight: [] }); assert.notEqual(f.wrap().status, 0)
})
test('release cannot replace a previous release binding', () => {
  const f = fixture(); f.ok(f.wrap()); const sha = f.commit('1.2.4')
  assert.notEqual(f.arch('--wrap-companion', 'X1', '--attempt-id', 'a1', '--version', '1.2.4', '--sha', sha).status, 0)
})

const runningWrap = { lastRun: { id: 'wrap-2026-10-11-fixture', status: 'running' }, inFlight: [] }
const setWrap = f => f.json('.claude/agent-loop/state.json', runningWrap)
const wrapReview = (f, review = f.review('a1'), runId = runningWrap.lastRun.id) => f.arch('--review', 'X1', '--review-file', f.json('wrap-review.json', review), ...(runId === null ? [] : ['--runId', runId]))
for (const operation of ['implementation', 'review', 'companion']) test(`current wrap records validated ${operation} metadata without releasing lock`, () => {
  const f = fixture(); if (operation === 'review') f.build('a2'); setWrap(f)
  const result = operation === 'implementation'
    ? f.arch('--implementation', 'X1', '--evidence-file', f.json('repair.json', f.evidence('a2')), '--runId', runningWrap.lastRun.id)
    : operation === 'review' ? wrapReview(f, f.review('a2')) : f.wrap('--runId', runningWrap.lastRun.id)
  f.ok(result)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.loop, 'state.json'))), runningWrap)
  assert.equal(f.native().items[0].verdict, operation === 'implementation' ? 'implemented' : operation === 'review' ? 'verified' : 'wrapped')
})
test('wrap review retry after report failure appends once and preserves the running identity', () => {
  const f = fixture(); setWrap(f)
  const report = path.join(f.loop, 'report.md'); fs.unlinkSync(report); fs.mkdirSync(report)
  assert.notEqual(wrapReview(f, f.review('a1', 'fail')).status, 0)
  const history = fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8')
  fs.rmdirSync(report); f.ok(wrapReview(f, f.review('a1', 'fail')))
  assert.equal(fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8'), history)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.loop, 'state.json'))), runningWrap)
})
for (const variant of ['missing-id', 'wrong-id', 'engine', 'stopped', 'in-flight', 'missing-in-flight', 'malformed-in-flight']) test(`wrap metadata rejects ${variant} without append`, () => {
  const f = fixture(), state = structuredClone(runningWrap)
  if (variant === 'engine') state.lastRun.id = 'wf_abcd-1234'
  if (variant === 'stopped') state.lastRun.status = 'stopped'
  if (variant === 'in-flight') state.inFlight = [{ ref: 'X1' }]
  if (variant === 'missing-in-flight') delete state.inFlight
  if (variant === 'malformed-in-flight') state.inFlight = {}
  f.json('.claude/agent-loop/state.json', state)
  const history = fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8')
  assert.notEqual(wrapReview(f, f.review('a1'), variant === 'missing-id' ? null : variant === 'wrong-id' ? 'wrap-other' : state.lastRun.id).status, 0)
  assert.equal(fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8'), history)
})
for (const variant of ['attempt', 'self-review', 'invalid-pass', 'stale-snapshot', 'invalid-implementation']) test(`wrap metadata retains ${variant} validation`, () => {
  const f = fixture(); setWrap(f)
  const review = f.review('a1')
  if (variant === 'attempt') review.attemptId = 'a0'
  if (variant === 'self-review') review.reviewer = 'builder'
  if (variant === 'invalid-pass') review.inventoryComplete = false
  if (variant === 'stale-snapshot') fs.writeFileSync(path.join(f.root, 'fixture.md'), 'changed')
  const history = fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8')
  const result = variant === 'invalid-implementation'
    ? f.arch('--implementation', 'X1', '--evidence-file', f.json('invalid.json', { attemptId: 'a2' }), '--runId', runningWrap.lastRun.id)
    : wrapReview(f, review)
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8'), history)
})
for (const when of ['lock', 'preappend']) for (const changed of ['state', 'ledger']) test(`wrap ${changed} race at ${when} rejects stale metadata`, () => {
  const f = fixture(); setWrap(f)
  const preload = path.join(f.root, 'race.cjs')
  const history = fs.readFileSync(path.join(f.loop, 'architect-ledger.jsonl'), 'utf8')
  fs.writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');
const loop=${JSON.stringify(f.loop)}, changed=${JSON.stringify(changed)}, when=${JSON.stringify(when)};
const open=fs.openSync,read=fs.readFileSync; let changedOnce=false,stateReads=0;
function mutate(){if(changedOnce)return;changedOnce=true;if(changed==='state')fs.writeFileSync(path.join(loop,'state.json'),JSON.stringify({lastRun:{id:'wrap-other',status:'running'},inFlight:[]}));else fs.appendFileSync(path.join(loop,'architect-ledger.jsonl'),JSON.stringify({id:'X1',verdict:'verification-failed',note:'concurrent writer'})+'\\n');}
fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(when==='lock'&&String(file).endsWith('architect-ledger.jsonl.lock'))mutate();return fd;};
fs.readFileSync=function(file,...args){if(String(file)===path.join(loop,'state.json')&&++stateReads===3&&when==='preappend')mutate();return read.call(this,file,...args);};`)
  const result = spawnSync(process.execPath, ['--require', preload, path.join(f.root,'scripts/architect-file.cjs'), '--session','architect','--review','X1','--review-file',f.json('race-review.json',f.review('a1','fail')),'--runId',runningWrap.lastRun.id],{cwd:f.root,encoding:'utf8'})
  assert.notEqual(result.status, 0, result.stdout)
  assert.equal(fs.existsSync(path.join(f.loop,'architect-ledger.jsonl.lock')), false)
  if (result.stderr.includes('live run must be resolved')) {
    assert.equal(fs.readFileSync(path.join(f.loop,'architect-ledger.jsonl'),'utf8'), history)
    return
  }
  assert.match(result.stderr, /run state or Architect ledger changed/)
  assert.doesNotMatch(fs.readFileSync(path.join(f.loop,'architect-ledger.jsonl'),'utf8'), /race-review/)
  const last=JSON.parse(fs.readFileSync(path.join(f.loop,'architect-ledger.jsonl'),'utf8').trim().split(/\r?\n/).at(-1))
  assert.equal(last.verdict, changed==='ledger'?'verification-failed':'verified')
  if(changed==='ledger')assert.equal(last.note,'concurrent writer')
})
