#!/usr/bin/env node
// Real CLI readers/writers in an isolated repository-shaped fixture; no live ledger writes.
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const beforeAt = process.argv.indexOf('--before-ref')
const beforeRef = beforeAt >= 0 ? process.argv[beforeAt + 1] : null
const runtimeAt = process.argv.indexOf('--runtime-ref')
const runtimeRef = runtimeAt >= 0 ? process.argv[runtimeAt + 1] : null
const baselineOnly = Boolean(beforeRef) || process.argv.includes('--baseline')
const root = fs.mkdtempSync(path.join(__dirname, '..', '.workshop-verification-'))
fs.mkdirSync(path.join(root, 'scripts'))
fs.mkdirSync(path.join(root, '.claude/agent-loop'), { recursive: true })
for (const file of ['ledger-stats.cjs', 'ledger-file.cjs', 'workshop-verification.cjs']) {
  if (beforeRef || runtimeRef) {
    if (beforeRef && file === 'workshop-verification.cjs') continue
    const old = spawnSync('git', ['show', `${beforeRef || runtimeRef}:scripts/${file}`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
    assert.equal(old.status, 0, old.stderr)
    fs.writeFileSync(path.join(root, 'scripts', file), old.stdout)
    continue
  }
  const source = path.join(__dirname, file)
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(root, 'scripts', file))
}
const ledger = path.join(root, '.claude/agent-loop/ledger.jsonl')
const row = (ref, verdict, extra = {}) => ({ date: '2026-09-10', ref, verdict, finding: 'A concrete regression in scripts/fixture.cjs:1', ...extra })
const setRows = rows => fs.writeFileSync(ledger, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
const cli = (script, ...args) => spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8' })
const open = () => { const r = cli('ledger-stats.cjs', '--open', '--json'); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout) }
after(() => {
  const resolved = fs.realpathSync(root)
  assert.equal(path.dirname(resolved), fs.realpathSync(path.join(__dirname, '..')))
  assert.ok(path.basename(resolved).startsWith('.workshop-verification-'))
  fs.rmSync(resolved, { recursive: true, force: true })
})

test('later overturn remains open after a historical build', () => {
  setRows([row('incident', 'built'), row('incident', 'needs-dependency')])
  assert.deepEqual(open().map(r => r.ref), ['incident'])
})
test('requeued repair survives an old built row', () => {
  setRows([row('incident', 'built'), row('incident', 'queued-next-run')])
  const r = cli('ledger-stats.cjs', '--queued', '--json')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).length, 1)
})
test('newer alias overturn supersedes an earlier normalized closure', () => {
  setRows([row('gh#147', 'built'), row('#147', 'needs-dependency')])
  assert.deepEqual(open().map(r => r.ref), ['#147'])
  assert.deepEqual(JSON.parse(cli('ledger-stats.cjs', '--closed-refs', '--json').stdout), [])
})
test('bare recheck preserves a legacy closure', () => {
  setRows([row('old', 'built'), { ref: 'old', date: '2026-09-10', recheck: 'metadata only' }])
  assert.equal(open().length, 0)
})
test('legacy wrapped history stays closed', () => {
  setRows([row('old', 'needs-dependency'), row('old', 'built'), row('old', 'wrapped', { state: 'wrapped' })])
  assert.equal(open().length, 0)
})
test('combined closure covers related refs without substring or sibling closure', () => {
  setRows([row('P2', 'needs-dependency'), row('P24', 'needs-dependency'), row('P25', 'needs-dependency'), row('P24+P25', 'built')])
  assert.deepEqual(open().map(r => r.ref), ['P2'])
  setRows([row('gh#41', 'needs-dependency'), row('gh#41-step5', 'needs-dependency'), row('gh#41-step1', 'built')])
  assert.deepEqual(open().map(r => r.ref), ['gh#41-step5'])
})
test('a later explicit parent reopen survives a legacy child closure', () => {
  setRows([row('gh#41-step1', 'built'), row('gh#41', 'needs-dependency')])
  assert.deepEqual(open().map(r => r.ref), ['gh#41'])
})
test('new build cannot be written without executed evidence', () => {
  setRows([])
  const r = cli('ledger-file.cjs', '--ref', 'new', '--lane', 'architect', '--source', 'owner', '--finding', 'A concrete deterministic defect in the ledger', '--verdict', 'built', '--rootCause', 'scripts/fixture.cjs:1', '--invariant', 'none')
  assert.equal(r.status, 1, r.stdout)
  assert.equal(fs.readFileSync(ledger, 'utf8').trim(), '')
})

if (!baselineOnly) {
const contract = require(path.join(root, 'scripts/workshop-verification.cjs'))
const product = path.join(root, 'fixture.cjs')
fs.writeFileSync(product, 'module.exports = value => value !== null\n')
const validEvidence = () => ({
  version: 1, attemptId: 'direct-fixture-attempt-1', builder: 'direct-builder-dispatch-1', changeKind: 'deterministic', files: [product], exception: '',
  regressions: [{ id: 'gate-suite', command: 'node fixture-test.cjs', beforeRevision: 'preserved-before-fixture', before: { exitCode: 1, passed: 1, failed: 1, output: 'null rejection assertion failed; valid value passed' }, after: { exitCode: 0, passed: 2, failed: 0, output: 'null rejected; valid value accepted' }, cases: [{ id: 'invalid', kind: 'regression', before: 'fail', after: 'pass', evidence: 'actual guard rejects null' }, { id: 'valid', kind: 'preserved', before: 'pass', after: 'pass', evidence: 'actual guard accepts ordinary value' }] }],
  boundaries: { inventoryCommand: 'rg guard fixture.cjs', changedGuards: ['guard'], paths: [
    { id: 'bad-path', producer: 'null producer', state: 'normalized null', consumer: 'guard', guard: 'guard', direction: 'reject', caseIds: ['invalid'], status: 'covered', evidence: 'fixture.cjs:1' },
    { id: 'good-path', producer: 'valid producer', state: 'ordinary value', consumer: 'guard', guard: 'guard', direction: 'accept', caseIds: ['valid'], status: 'covered', evidence: 'fixture.cjs:1' },
  ], surfaces: ['owner', 'colleague', 'dm', 'room', 'unavailable'].map(id => ({ id, status: 'not-applicable', pathIds: [], reason: 'This isolated ledger-tool fixture has no messaging/availability surface.' })) },
})
const validReview = () => ({ attemptId: 'direct-fixture-attempt-1', reviewer: 'independent-bouncer-dispatch', trace: 'actual-test-dispatch/turn-1', verdict: 'pass', reason: 'Fixture guard and legitimate producer independently traced; no live model claim.', outcome: 'traced', inventoryComplete: true, guardsComplete: true, findings: [], reviewedPaths: ['bad-path', 'good-path'], scope: 'behavioral', checks: [{ id: 'gate-suite', command: 'node fixture-test.cjs', exitCode: 0, passed: 2, failed: 0, output: '2 assertions passed' }] })
const implementations = [['writer/shared', contract]]
const vm = require('node:vm')
const blockOf = source => source.match(/\/\/ BEGIN WORKSHOP CONTRACT[\s\S]*?\/\/ END WORKSHOP CONTRACT/)[0]
const canonical = blockOf(fs.readFileSync(path.join(__dirname, 'workshop-verification.cjs'), 'utf8'))
for (const name of ['bugger', 'feature']) {
  const source = fs.readFileSync(path.join(__dirname, '..', '.claude/workflows', name + '.js'), 'utf8')
  const block = blockOf(source)
  test(`${name} embeds the exact canonical runtime contract`, () => assert.equal(block, canonical))
  implementations.push([name, vm.runInNewContext(block + '\nworkshopContract')])
}
const invalidEvidence = [
  ['missing evidence', () => null],
  ['missing executions', e => { e.regressions = [] }],
  ['paper-only before', e => { delete e.regressions[0].before.exitCode }],
  ['before did not fail', e => { e.regressions[0].before.exitCode = 0 }],
  ['after failed', e => { e.regressions[0].after.failed = 1 }],
  ['after not executed', e => { delete e.regressions[0].after.output }],
  ['preserved case missing', e => { e.regressions[0].cases.pop() }],
  ['invented count', e => { e.regressions[0].after.passed = 1 }],
  ['impossible preserved before count', e => { e.regressions[0].before.passed = 0 }],
  ['inventory absent', e => { e.boundaries.inventoryCommand = '' }],
  ['legitimate producer missing', e => { e.boundaries.paths.pop() }],
  ['consumer omitted', e => { e.boundaries.paths[0].consumer = '' }],
  ['boundary still missing', e => { e.boundaries.paths[0].status = 'missing' }],
  ['unknown case', e => { e.boundaries.paths[0].caseIds = ['invented'] }],
  ['surface omitted', e => { e.boundaries.surfaces.pop() }],
  ['empty exception', e => { e.changeKind = 'prompt-only'; e.exception = '' }],
]
for (const [label, runtime] of implementations) {
  test(`${label}: valid deterministic and mixed bounded evidence is accepted`, () => {
    const e = validEvidence()
    assert.equal(runtime.checkEvidence(e).length, 0)
    e.exception = 'Prompt capture proves stored ask reaches the model; interpreting that time remains unexercised model judgment.'
    assert.equal(runtime.checkReview(e, validReview()).length, 0)
    assert.equal(runtime.gateBuild({ id: 'a', verdict: 'built', evidence: e }).verdict, 'built')
    assert.equal(runtime.gateFinal({ id: 'a', verdict: 'built', evidence: e, review: validReview() }).verdict, 'built')
  })
  for (const [name, mutate] of invalidEvidence) test(`${label}: ${name} blocks handoff`, () => {
    let e = validEvidence(); const replacement = mutate(e); if (replacement === null) e = null
    assert.ok(runtime.checkEvidence(e).length)
    assert.equal(runtime.gateBuild({ verdict: 'built', evidence: e }).verdict, 'needs-dependency')
  })
  for (const [name, mutate] of [
    ['missing review', () => null], ['self-review', r => { r.reviewer = validEvidence().builder }],
    ['untraced dispatch', r => { r.trace = '' }], ['wrong attempt', r => { r.attemptId = 'earlier-attempt' }],
    ['failed review', r => { r.verdict = 'fail' }], ['unproven review', r => { r.verdict = 'unproven' }],
    ['untraced outcome', r => { r.outcome = 'no-symptom' }], ['incomplete inventory', r => { r.inventoryComplete = false }],
    ['unreviewed direction', r => { r.guardsComplete = false }], ['missing path review', r => { r.reviewedPaths.pop() }],
    ['unresolved finding', r => { r.findings = ['legitimate producer blocked'] }], ['missing re-execution', r => { r.checks = [] }],
    ['hidden failed execution', r => { r.checks.push({ id: 'another-suite', exitCode: 1, failed: 1 }) }],
  ]) test(`${label}: ${name} cannot clear a build`, () => {
    let r = validReview(); if (mutate(r) === null) r = null
    const e = validEvidence()
    assert.ok(runtime.checkReview(e, r).length)
    assert.equal(runtime.gateFinal({ verdict: 'built', evidence: e, review: r }).verdict, 'implemented')
    const reviews = new Map(), check = { results: [{ id: 'a', verdict: 'built', review: r }] }
    runtime.acceptReviews([{ id: 'a', verdict: 'built', evidence: e }], check, reviews)
    assert.equal(check.results[0].verdict, 'needs-owner-decision')
  })
  test(`${label}: honest prompt-only and prose-only exceptions require no invented regression`, () => {
    const e = validEvidence(); e.changeKind = 'prompt-only'; e.exception = 'Only prompt inputs checked; model obedience remains unproven.'; e.regressions = []
    e.boundaries.paths.forEach(p => { p.caseIds = [] })
    const r = validReview(); r.checks = []; r.scope = 'structural'
    assert.equal(runtime.checkReview(e, r).length, 0)
    r.scope = 'behavioral'; assert.ok(runtime.checkReview(e, r).length)
    e.changeKind = 'prose-only'; e.exception = 'Documentation-only citation correction.'; e.boundaries = { inventoryCommand: '', changedGuards: [], paths: [], surfaces: [] }; r.reviewedPaths = []
    assert.equal(runtime.checkReview(e, r).length, 0)
  })
}

const jsonFile = (name, value) => { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(value)); return file }
const writeBuild = (e = validEvidence()) => cli('ledger-file.cjs', '--ref', 'new', '--lane', 'architect', '--source', 'owner', '--finding', 'A concrete deterministic defect in the ledger', '--rootCause', 'scripts/fixture.cjs:1', '--verdict', 'built', '--invariant', 'none', '--runId', 'direct-real-dispatch', '--evidence-file', jsonFile('evidence.json', e))
const writeReview = (r = validReview()) => cli('ledger-file.cjs', '--review', '--ref', 'new', '--review-file', jsonFile('review.json', r))
const gate = (...args) => cli('ledger-stats.cjs', ...args)
const partialSync = (ownerDecision = false) => cli('ledger-file.cjs', '--gh-sync', '--ref', 'gh#24', '--version', '99.0.0', '--ghstate', 'partial', '--note', 'Released repairs; the remaining ticket feature stays open.', ...(ownerDecision ? ['--verdict', 'needs-owner-decision'] : ['--recommend', 'build the remaining feature']))

test('partial GitHub sync reopens legacy shipped ticket without inventing an implementation', () => {
  for (const ownerDecision of [false, true]) {
    setRows([row('gh#24', 'built', { date: '2026-07-28', state: 'built' }), row('gh#24', 'built', { date: '2026-07-29', state: 'wrapped' })])
    assert.equal(partialSync(ownerDecision).status, 0)
    assert.deepEqual(open().map(r => r.ref), ['gh#24'])
    const checked = gate('--verification')
    assert.equal(checked.status, 0, checked.stdout)
    for (const args of [['--report'], ['--wrap', '99.0.0']]) assert.match(gate(...args).stdout, /VERIFICATION — 0 blocking ref/)
  }
})

test('partial sync preserves current implementation and failed-review blockers', () => {
  for (const verdict of ['built', 'implemented', 'verification-failed', 'verification-unproven']) {
    setRows([row('gh#24', verdict, verdict === 'built' ? {} : { lifecycleVersion: 1, evidence: validEvidence() })])
    assert.equal(partialSync().status, 0)
    assert.equal(gate('--verification').status, 1, verdict)
  }
})

test('partial sync cannot hide an explicit reopening after historical shipment', () => {
  setRows([row('gh#24', 'built', { state: 'wrapped' }), row('gh#24', 'needs-dependency', { lifecycleVersion: 1 })])
  assert.equal(partialSync().status, 0)
  assert.equal(gate('--verification').status, 1)
})

test('partial sync preserves valid implementation evidence and still detects stale files', () => {
  setRows([row('gh#24', 'verified', { lifecycleVersion: 1, evidence: validEvidence(), review: validReview(), snapshot: contract.snapshot([product], root) })])
  assert.equal(partialSync().status, 0)
  assert.deepEqual(open().map(r => r.ref), ['gh#24'])
  assert.equal(gate('--verification').status, 0)
  fs.appendFileSync(product, '// stale during partial ticket sync\n')
  const checked = gate('--verification')
  assert.equal(checked.status, 1)
  assert.match(checked.stdout, /changed since reviewed/)
})

test('partial state on a lifecycle event is never treated as bookkeeping', () => {
  for (const extra of [{ lifecycleVersion: 1 }, { evidence: validEvidence() }, { review: { verdict: 'fail' } }]) {
    setRows([row('gh#24', 'built', { state: 'wrapped' }), { ref: 'gh#24', state: 'partial', runId: 'wrap-99.0.0', ...extra }])
    assert.equal(gate('--verification').status, 1)
  }
})
test('direct writer lifecycle: implementation → pass → fail → repair awaiting review → pass', () => {
  setRows([])
  assert.equal(writeBuild().status, 0)
  assert.equal(open()[0].verdict, 'implemented')
  assert.equal(gate('--verification').status, 1)
  assert.equal(writeReview().status, 0)
  assert.equal(open().length, 0)
  assert.equal(gate('--verification').status, 0)
  const failed = validReview(); failed.verdict = 'fail'; failed.findings = ['legitimate producer excluded']
  assert.equal(writeReview(failed).status, 0)
  assert.equal(open()[0].verdict, 'verification-failed')
  for (const args of [['--verification'], ['--report'], ['--wrap', '99.0.0']]) {
    const r = gate(...args); assert.equal(r.status, 1); assert.match(r.stdout, /VERIFICATION — 1 blocking ref/)
  }
  assert.deepEqual(JSON.parse(gate('--closed-refs', '--json').stdout), [])
  assert.deepEqual(JSON.parse(gate('--already-built', '--json').stdout), [])
  const e = validEvidence(); e.attemptId = 'direct-fixture-attempt-2'
  assert.equal(writeBuild(e).status, 0)
  assert.equal(open()[0].verdict, 'implemented')
  assert.equal(open()[0].review, undefined)
  assert.equal(writeReview().status, 1, 'earlier pass cannot clear repair')
  const r = validReview(); r.attemptId = e.attemptId
  assert.equal(writeReview(r).status, 0)
  assert.equal(gate('--verification').status, 0)
})
test('untraced and self-reviewed passes are refused without append', () => {
  setRows([]); assert.equal(writeBuild().status, 0)
  const before = fs.readFileSync(ledger, 'utf8')
  const r = validReview(); r.trace = ''
  assert.equal(writeReview(r).status, 1)
  r.trace = 'test-trace'; r.reviewer = validEvidence().builder
  assert.equal(writeReview(r).status, 1)
  assert.equal(fs.readFileSync(ledger, 'utf8'), before)
})
test('missing boundary evidence refuses writer before handoff', () => {
  setRows([]); const e = validEvidence(); e.boundaries.paths.pop()
  const r = writeBuild(e); assert.equal(r.status, 1); assert.match(r.stderr, /missing accept direction/)
  assert.equal(fs.readFileSync(ledger, 'utf8').trim(), '')
})
test('stale files invalidate independent verification and the open/closed readers', () => {
  setRows([]); assert.equal(writeBuild().status, 0); assert.equal(writeReview().status, 0)
  fs.appendFileSync(product, '// changed after review\n')
  assert.equal(gate('--verification').status, 1)
  assert.equal(open().length, 1)
  assert.equal(writeReview().status, 1)
  assert.deepEqual(JSON.parse(gate('--closed-refs', '--json').stdout), [])
})
test('legacy overturn can be persisted and rechecked without inventing evidence', () => {
  setRows([row('new', 'built')])
  const r = validReview(); r.verdict = 'fail'
  assert.equal(writeReview(r).status, 0)
  assert.equal(open()[0].verdict, 'verification-failed')
  assert.equal(cli('ledger-file.cjs', '--recheck', '--ref', 'new', '--note', 'Still a distinct open defect in scripts/fixture.cjs:1').status, 0)
  assert.equal(open()[0].verdict, 'verification-failed')
  assert.equal(writeReview().status, 1)
})
test('invalid raw verified/wrapped rows cannot bypass a missing independent review', () => {
  setRows([row('new', 'implemented', { evidence: validEvidence() }), row('new', 'verified')])
  assert.equal(open().length, 1); assert.equal(gate('--verification').status, 1)
  setRows([row('new', 'implemented', { evidence: validEvidence() }), row('new', 'wrapped', { state: 'wrapped' })])
  assert.equal(open().length, 1); assert.equal(gate('--verification').status, 1)
})
test('a related child closure cannot clear a newly implemented parent', () => {
  setRows([row('gh#41', 'implemented', { evidence: validEvidence() }), row('gh#41-step1', 'built')])
  assert.equal(open().length, 1)
})
test('wrap companion is refused until independently verified and then preserves history', () => {
  setRows([]); assert.equal(writeBuild().status, 0)
  const wrap = () => cli('ledger-file.cjs', '--wrap-companion', '--ref', 'new', '--version', '99.0.0', '--sha', 'test-sha-only')
  assert.equal(wrap().status, 1)
  assert.equal(writeReview().status, 0); assert.equal(wrap().status, 0)
  fs.appendFileSync(product, '// later release work\n')
  assert.equal(open().length, 0); assert.equal(gate('--verification').status, 0)
})
test('malformed ledger cannot establish verification', () => {
  fs.writeFileSync(ledger, '{broken-json}\n')
  assert.equal(gate('--verification').status, 1)
})
test('legacy wrapped corrections stay historical until an explicit current lifecycle event', () => {
  setRows([row('new', 'built'), row('new', 'needs-owner-decision', { state: 'wrapped' }), row('new', 'needs-owner-decision', { source: 'audit', note: 'Correction of old record; no current implementation.' })])
  assert.equal(open().length, 0)
  assert.equal(gate('--verification').status, 0)
  const r = validReview(); r.verdict = 'fail'
  assert.equal(writeReview(r).status, 0)
  assert.equal(open().length, 1)
  assert.equal(gate('--verification').status, 1)
})
test('new writer open verdict explicitly reopens a historical wrapped ref', () => {
  setRows([row('new', 'wrapped', { state: 'wrapped' })])
  const r = cli('ledger-file.cjs', '--ref', 'new', '--lane', 'architect', '--source', 'owner', '--finding', 'The previously wrapped behavior regressed again', '--verdict', 'needs-dependency', '--invariant', 'none')
  assert.equal(r.status, 0)
  assert.equal(open().length, 1)
})
test('ordinary --state cannot disguise a new open row as wrapped or closed', () => {
  for (const state of ['wrapped', 'closed']) {
    setRows([])
    const r = cli('ledger-file.cjs', '--ref', 'new', '--source', 'owner', '--finding', 'A deterministic defect requiring a repair', '--verdict', 'needs-dependency', '--invariant', 'none', '--state', state)
    assert.equal(r.status, 1)
    assert.equal(fs.readFileSync(ledger, 'utf8').trim(), '')
  }
})
test('explicit parent review clears only its named child without a duplicate implementation', () => {
  setRows([row('child', 'needs-dependency')]); assert.equal(writeBuild().status, 0)
  const review = validReview(); review.coveredRefs = ['new', 'child']
  assert.equal(writeReview(review).status, 0)
  const recordChild = r => cli('ledger-file.cjs', '--review', '--ref', 'child', '--from-ref', 'new', '--review-file', jsonFile('child-review.json', r))
  assert.equal(recordChild(validReview()).status, 1, 'a name/alias is not independent child coverage')
  assert.equal(recordChild(review).status, 0)
  assert.equal(open().length, 0)
  const all = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(all.filter(r => r.verdict === 'implemented').length, 1)
  assert.equal(all.at(-1).verificationOf, 'new')
  const fail = validReview(); fail.verdict = 'fail'; assert.equal(writeReview(fail).status, 0)
  assert.equal(recordChild(review).status, 1, 'failed parent cannot clear child')
  assert.equal(open().length, 2, 'linked child cannot keep a pass after its parent is overturned')
})
test('a later child reopen cannot replay an older parent pass', () => {
  setRows([row('child', 'needs-dependency')]); assert.equal(writeBuild().status, 0)
  const review = validReview(); review.coveredRefs = ['new', 'child']; assert.equal(writeReview(review).status, 0)
  fs.appendFileSync(ledger, JSON.stringify(row('child', 'needs-dependency', { lifecycleVersion: 1 })) + '\n')
  const linked = cli('ledger-file.cjs', '--review', '--ref', 'child', '--from-ref', 'new', '--review-file', jsonFile('older-review.json', review))
  assert.equal(linked.status, 1)
  assert.match(linked.stderr, /reopened after the parent review/)
})

test('linked closures remain dedup identities but do not inflate implementation reports', () => {
  setRows([row('child', 'needs-dependency')]); assert.equal(writeBuild().status, 0)
  const review = validReview(); review.coveredRefs = ['new', 'child']; assert.equal(writeReview(review).status, 0)
  assert.equal(cli('ledger-file.cjs', '--review', '--ref', 'child', '--from-ref', 'new', '--review-file', jsonFile('linked-review.json', review)).status, 0)
  assert.deepEqual(JSON.parse(gate('--already-built', '--json').stdout).map(r => r.ref).sort(), ['child', 'new'])
  const report = path.join(root, '.claude/agent-loop/report.md')
  fs.writeFileSync(report, 'Report fixture\n')
  const absent = gate('--report', report)
  assert.match(absent.stdout, /ledger holds 1 `built` row\(s\)/)
  fs.writeFileSync(report, '**Built and uncommitted (2):** `new` repair · `child` linked review\n')
  assert.match(gate('--report', report).stdout, /BUILT LIST names refs without current verified implementation: child/)
  fs.writeFileSync(report, '**Built and uncommitted (1):** `new` repair\n')
  assert.doesNotMatch(gate('--report', report).stdout, /BUILT LIST names refs without/)
})

test('a linked child can earn its own independent repair without retaining parent lineage', () => {
  setRows([row('child', 'needs-dependency')]); assert.equal(writeBuild().status, 0)
  const parentReview = validReview(); parentReview.coveredRefs = ['new', 'child']; assert.equal(writeReview(parentReview).status, 0)
  assert.equal(cli('ledger-file.cjs', '--review', '--ref', 'child', '--from-ref', 'new', '--review-file', jsonFile('parent-review.json', parentReview)).status, 0)
  const ownEvidence = validEvidence(); ownEvidence.attemptId = 'child-own-repair-2'
  assert.equal(cli('ledger-file.cjs', '--ref', 'child', '--lane', 'architect', '--source', 'owner', '--finding', 'A child-specific deterministic repair', '--rootCause', 'scripts/fixture.cjs:1', '--verdict', 'built', '--invariant', 'none', '--evidence-file', jsonFile('own-evidence.json', ownEvidence)).status, 0)
  assert.equal(open().find(r => r.ref === 'child').verificationOf, undefined)
  const ownReview = validReview(); ownReview.attemptId = ownEvidence.attemptId
  assert.equal(cli('ledger-file.cjs', '--review', '--ref', 'child', '--review-file', jsonFile('own-review.json', ownReview)).status, 0)
  assert.equal(gate('--verification').status, 0)
  assert.equal(open().length, 0)
  parentReview.verdict = 'fail'; assert.equal(writeReview(parentReview).status, 0)
  assert.deepEqual(open().map(r => r.ref), ['new'], 'an independent child repair survives its former parent overturn')
})

test('nested parent links are refused and cannot establish historical closure', () => {
  setRows([row('grandchild', 'needs-dependency'), row('child', 'needs-dependency')]); assert.equal(writeBuild().status, 0)
  const review = validReview(); review.coveredRefs = ['new', 'child', 'grandchild']; assert.equal(writeReview(review).status, 0)
  assert.equal(cli('ledger-file.cjs', '--review', '--ref', 'child', '--from-ref', 'new', '--review-file', jsonFile('parent-link.json', review)).status, 0)
  const nested = cli('ledger-file.cjs', '--review', '--ref', 'grandchild', '--from-ref', 'child', '--review-file', jsonFile('nested-link.json', review))
  assert.equal(nested.status, 1)
  assert.match(nested.stderr, /one parent level/)
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse)
  fs.appendFileSync(ledger, JSON.stringify({ ...rows.at(-1), ref: 'grandchild', verificationOf: 'child' }) + '\n')
  assert.deepEqual(open().map(r => r.ref), ['grandchild'], 'unsupported historical nested link is unproven before any parent failure')
  review.verdict = 'fail'; assert.equal(writeReview(review).status, 0)
  assert.deepEqual(open().map(r => r.ref).sort(), ['child', 'grandchild', 'new'])
})
}
