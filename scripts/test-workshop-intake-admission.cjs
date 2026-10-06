const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..'), at = process.argv.indexOf('--before-dir'), source = at < 0 ? repo : path.resolve(process.argv[at + 1])
const root = fs.mkdtempSync(path.join(repo, '.workshop-admission-')), loop = path.join(root, '.claude/agent-loop')
fs.mkdirSync(path.join(root, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(root, '.claude/agents'), { recursive: true })
assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0)
for (const file of ['ledger-file.cjs', 'ledger-stats.cjs', 'workshop-intake.cjs', 'workshop-verification.cjs', 'architect-file.cjs']) fs.copyFileSync(path.join(source, 'scripts', file), path.join(root, 'scripts', file))
const sha = text => crypto.createHash('sha256').update(text).digest('hex')
const cli = (file, ...args) => spawnSync(process.execPath, [path.join(root, 'scripts', file), ...args], { cwd: root, encoding: 'utf8' })
const json = (name, value) => { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(value)); return file }
const ok = r => assert.equal(r.status, 0, r.stderr + r.stdout)
const bad = r => assert.notEqual(r.status, 0, r.stdout)
const write = (...args) => cli('ledger-file.cjs', ...args)
const stats = (...args) => cli('ledger-stats.cjs', ...args)
const capture = () => { const r = write('--capture-file', json('capture.json', { id: 'first', ref: 'alpha', type: 'bug', finding: 'Owner reports the missing delivery.', attachments: [] })); ok(r) }
const assessment = extra => ({ ref: 'alpha', status: 'ready', type: 'bug', reason: 'Restore existing R1 delivery rule.', lane: 'registrar', charter: { file: '.claude/agents/registrar.md', rule: 'R1 delivery', sha256: sha('R1 delivery') }, authorization: 'Owner: run alpha.', ...extra })
const assess = input => write('--assess-file', json('assess.json', input))
const hold = (note = 'Owner: hold alpha now; do not build.') => write('--ref', 'alpha', '--source', 'owner', '--finding', 'Owner placed an explicit hold on the collected work.', '--verdict', 'deferred', '--invariant', 'none', '--note', note)
const item = () => { const r = stats('--intake', '--ref', 'alpha'); ok(r); return JSON.parse(r.stdout).items[0] }
const plan = (refs, allowFresh = false) => { const r = stats('--batch-plan', json('plan.json', { refs, allowFresh, authorization: 'Owner authorized this selected run.' })); return { result: r, data: JSON.parse(r.stdout || '{}') } }
const issue = extra => ({ id: 'alpha', source: 'owner', lane: 'registrar', clarity: 'clear', kind: 'atomic', severity: 'medium', symptom: 'Delivery is missing', evidence: 'fixture:1', ...extra })
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
async function engine(name, args, editor = {}) {
  const body = fs.readFileSync(path.join(source, '.claude/workflows', name + '.js'), 'utf8').replace('export const meta', 'const meta')
  const calls = [], prompts = []
  const agent = async (prompt, opts) => { calls.push(opts.label); prompts.push(prompt); if (opts.label === 'editor') return { issues: [], findingsSeen: 0, matchedOpenBacklog: [], backlogReread: [], backlogSeen: 0, backlogNoCite: 0, ...editor }; throw new Error('LANE_REACHED') }
  let error
  try { await new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)(args, agent, async jobs => Promise.all(jobs.map(j => j())), () => {}, () => {}) } catch (e) { error = e.message }
  return { calls, prompts, error, lane: calls.some(c => c !== 'editor') }
}
beforeEach(() => {
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(repo))
  if (fs.existsSync(loop)) fs.rmSync(loop, { recursive: true, force: true })
  fs.mkdirSync(loop, { recursive: true }); fs.writeFileSync(path.join(loop, 'ledger.jsonl'), '')
  fs.writeFileSync(path.join(loop, 'state.json'), JSON.stringify({ lastRun: { status: 'complete' }, inFlight: [] }))
  fs.writeFileSync(path.join(root, '.claude/agents/registrar.md'), 'R1 delivery')
})
after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(repo)); fs.rmSync(root, { recursive: true, force: true }) })

test('latest native hold rejects stale ready replay and displays the owner words', () => {
  capture(); const ready = assessment(); ok(assess(ready)); ok(hold())
  bad(assess(ready)); assert.equal(item().status, 'held')
  assert.match(fs.readFileSync(path.join(loop, 'report.md'), 'utf8'), /hold alpha now; do not build/)
})
test('a release names the exact current hold; an older release cannot clear a later one', () => {
  capture(); ok(assess(assessment())); ok(hold())
  const released = assessment({ releaseHold: 'Owner now releases alpha.', releaseHoldFor: item().dispositionToken })
  ok(assess(released)); ok(hold('Owner: hold alpha again.'))
  bad(assess(released)); assert.equal(item().status, 'held')
  ok(assess({ ...released, releaseHoldFor: item().dispositionToken })); assert.equal(item().status, 'ready')
})
test('new native product question stays visible without a second assessment call', () => {
  capture(); ok(assess(assessment()))
  ok(write('--ref', 'alpha', '--source', 'owner', '--lane', 'registrar', '--finding', 'Should external recipients receive these notifications?', '--verdict', 'needs-owner-decision', '--invariant', 'none', '--note', 'Owner must choose external versus owner-only recipients.', '--recommend', 'defer — retain owner-only scope'))
  assert.equal(item().status, 'decision'); assert.match(fs.readFileSync(path.join(loop, 'report.md'), 'utf8'), /external versus owner-only/)
  bad(plan(['alpha']).result)
})
for (const route of ['editor', 'preset', 'queue', 'backlog', 'match']) test(`captured item cannot reach a lane through ${route}`, async () => {
  capture(); const p = plan(['alpha']); bad(p.result)
  let args = { sources: ['backlog'], intakeAdmission: p.data.intakeAdmission }, response = { issues: [issue()] }
  if (route === 'preset') args = { issues: [issue()], intakeAdmission: p.data.intakeAdmission }
  if (route === 'queue') { args.pendingOverflow = [issue()]; response = { issues: [] } }
  if (route === 'backlog') response = { issues: [], backlogReread: [{ ref: 'alpha', state: 'still-real', lane: 'registrar', recommend: 'build — restore delivery', evidence: 'fixture:1' }] }
  if (route === 'match') response = { issues: [issue({ id: 'new-log-ref', source: 'logs', matchesOpenBacklog: 'alpha' })] }
  const r = await engine('bugger', args, response); assert.equal(r.lane, false, JSON.stringify(r)); assert.match(r.error, /INTAKE ADMISSION BLOCKED/)
})
for (const state of ['held', 'stale-charter', 'unselected', 'declined']) test(`${state} ready-looking input is blocked at the actual engine boundary`, async () => {
  capture(); ok(assess(assessment()))
  if (state === 'held') ok(hold())
  if (state === 'stale-charter') fs.writeFileSync(path.join(root, '.claude/agents/registrar.md'), 'R2 changed rule')
  if (state === 'declined') ok(write('--ref', 'alpha', '--source', 'owner', '--finding', 'Owner declined this correction for the product.', '--verdict', 'declined', '--invariant', 'none', '--note', 'Do not build.'))
  const p = plan(state === 'unselected' ? [] : ['alpha'], true)
  const r = await engine('bugger', { issues: [issue()], intakeAdmission: p.data.intakeAdmission })
  assert.equal(r.lane, false, JSON.stringify(r)); assert.match(r.error, /INTAKE ADMISSION BLOCKED/)
})
test('missing native admission cannot dispatch the original owner-capture probe', async () => {
  const r = await engine('bugger', { sources: ['backlog'] }, { issues: [issue()] })
  assert.equal(r.lane, false, JSON.stringify(r)); assert.match(r.error, /INTAKE ADMISSION BLOCKED/)
})
test('authorized native capture assessment plan reaches its preset lane', async () => {
  capture(); ok(assess(assessment())); const p = plan(['alpha']); ok(p.result)
  const r = await engine('bugger', { issues: [issue()], intakeAdmission: p.data.intakeAdmission })
  assert.equal(r.lane, true, JSON.stringify(r)); assert.equal(r.error, 'LANE_REACHED')
})
for (const source of ['logs', 'github']) test(`authorized fresh ${source} findings reach a lane without per-bug owner approval`, async () => {
  const admission = { version: 1, authorization: 'Existing explicit owner full-source run.', allowFresh: true, entries: [] }
  const r = await engine('bugger', { sources: [source], intakeAdmission: admission }, { issues: [issue({ id: 'fresh', source })] })
  assert.equal(r.lane, true, JSON.stringify(r)); assert.equal(r.error, 'LANE_REACHED')
})
test('native full-source plan supplies fresh admission under the same owner run authorization', async () => {
  const p = plan([], true); ok(p.result)
  const r = await engine('bugger', { sources: ['github'], intakeAdmission: p.data.intakeAdmission }, { issues: [issue({ id: 'fresh', source: 'github' })] })
  assert.equal(r.lane, true, JSON.stringify(r))
})
for (const held of [false, true]) test(`feature pieces use the native selection: ${held ? 'held denied' : 'authorized accepted'}`, async () => {
  capture(); ok(assess(assessment())); if (held) ok(hold())
  const p = plan(['alpha'])
  const piece = { id: 'alpha', ref: 'alpha', lane: 'registrar', requirement: 'Restore delivery', whatChanges: 'Existing fixture delivery', connection: 'Existing handler', expectation: 'Same delivery', whyThisLane: 'R1', dependsOn: [], productDecision: 'Existing charter', risk: 'Fixture', patternQuery: 'none' }
  const r = await engine('feature', { mode: 'build', pieces: [piece], sharedPiece: 'none', intakeAdmission: p.data.intakeAdmission })
  assert.equal(r.lane, !held, JSON.stringify(r)); if (held) assert.match(r.error, /INTAKE ADMISSION BLOCKED/)
})
test('duplicate evidence preserves a native hold and never restores the old ready reason', () => {
  capture(); ok(assess(assessment())); ok(hold())
  ok(write('--capture-file', json('example.json', { id: 'second', ref: 'alpha', type: 'bug', finding: 'Another exact example of the same request.', sameItemEvidence: 'Same request req_1 and event identity.', attachments: [] })))
  assert.equal(item().status, 'held'); assert.match(fs.readFileSync(path.join(loop, 'report.md'), 'utf8'), /hold alpha now/)
})

// a2 independent probes, asserted as the intended behavior plus sibling and
// complete native lifecycle controls. Original failing probes remain artifacts.
const piece = (id = 'alpha', dependsOn = []) => ({ id, ref: id, lane: 'registrar', requirement: 'Restore delivery', whatChanges: 'Existing delivery', connection: 'Existing handler', expectation: 'Delivery restored', whyThisLane: 'R1', dependsOn, productDecision: 'Existing charter', risk: 'Fixture', patternQuery: 'none' })
const buildEvidence = (attemptId = 'resume-attempt') => {
  fs.writeFileSync(path.join(root, 'fixture.md'), 'Fixture implementation')
  return { version: 1, attemptId, builder: 'lane', changeKind: 'prose-only', exception: 'Fixture exercises persisted lifecycle only.', files: ['fixture.md'], regressions: [], boundaries: { changedGuards: [], paths: [] } }
}
const build = (attemptId = 'resume-attempt') => ok(write('--ref', 'alpha', '--source', 'owner', '--lane', 'registrar', '--finding', 'Built piece awaiting joint completion', '--verdict', 'built', '--rootCause', 'fixture.md:1', '--invariant', 'none', '--evidence-file', json('build.json', buildEvidence(attemptId))))
const dependency = (note = 'Live database operation remains unverified; access alone is insufficient.') => write('--ref', 'alpha', '--source', 'owner', '--lane', 'registrar', '--finding', 'Existing authorized correction awaits its dependency.', '--verdict', 'needs-dependency', '--invariant', 'none', '--note', note)
test('execution dependency supersedes ready authorization in report and both engine admission paths', async () => {
  capture(); ok(assess(assessment())); ok(dependency())
  assert.equal(item().status, 'blocked'); assert.match(item().currentReason, /database operation/)
  assert.match(fs.readFileSync(path.join(loop, 'report.md'), 'utf8'), /database operation/)
  const p = plan(['alpha']); bad(p.result); assert.equal(p.data.blocked[0].status, 'blocked')
  for (const name of ['bugger', 'feature']) {
    const r = await engine(name, name === 'bugger' ? { issues: [issue()], intakeAdmission: p.data.intakeAdmission } : { mode: 'build', pieces: [piece()], intakeAdmission: p.data.intakeAdmission })
    assert.equal(r.lane, false); assert.match(r.error, /INTAKE ADMISSION BLOCKED/)
  }
})
test('dependency reassessment retains authorization but stale ready replay cannot clear it', () => {
  capture(); const ready = assessment(); ok(assess(ready)); ok(dependency()); bad(assess(ready))
  const resolution = assessment({ dispositionToken: item().dispositionToken, reason: 'Receiving lane verified the required operation; evidence fixture:1.' })
  ok(assess(resolution)); ok(plan(['alpha']).result)
  ok(assess(resolution)); ok(plan(['alpha']).result)
  ok(dependency('A newer dependency is unavailable.')); bad(assess(resolution)); assert.equal(item().status, 'blocked')
})
test('answered owner question remains durable through a later technical dependency', () => {
  capture(); ok(assess(assessment({ status: 'decision', question: 'Which recipients?', uncovered: 'Recipient scope not covered.', recommend: 'Owner only.' })))
  const q = item(); ok(assess(assessment({ ownerRuled: { questionToken: q.questionToken, askedBecause: q.ownerQuestion, hisRuling: 'Owner only.' } })))
  const ruling = item().rulingToken; ok(dependency())
  assert.equal(item().status, 'blocked'); assert.equal(item().rulingToken, ruling); assert.equal(item().intake.authorization, 'Owner: run alpha.')
})
for (const name of ['bugger', 'feature']) for (const verdict of ['built', 'needs-owner-decision']) test(`${name} actual verification return preserves ${verdict === 'built' ? 'technical failure without owner question' : 'genuine new owner question'}`, async () => {
  capture(); ok(assess(assessment())); const p = plan(['alpha']); ok(p.result)
  const body = fs.readFileSync(path.join(source, '.claude/workflows', name + '.js'), 'utf8').replace('export const meta', 'const meta')
  const agent = async (prompt, opts) => opts.agentType === 'bouncer'
    ? { results: [{ id: 'alpha', verdict, notes: verdict === 'built' ? 'Claimed pass without review evidence.' : 'New representation choice: include external recipients?' }] }
    : { results: [{ id: 'alpha', lane: 'registrar', verdict: 'built', evidence: buildEvidence(), notes: 'Fixture implementation.', rootCause: 'fixture.md:1', workshopRead: true }] }
  const args = name === 'bugger' ? { issues: [issue({ bounces: 2 })], golden: false } : { mode: 'build', pieces: [{ ...piece(), bounces: 1 }], sharedPiece: 'none' }
  const result = await new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)({ ...args, intakeAdmission: p.data.intakeAdmission }, agent, async jobs => Promise.all(jobs.map(j => j())), () => {}, () => {})
  assert.equal(result.results.find(r => r.id === 'alpha').verdict, verdict === 'built' ? 'needs-dependency' : 'needs-owner-decision')
  assert.equal(result.verification.packageReady, false)
  const returned = result.results.find(r => r.id === 'alpha')
  ok(write('--ref', 'alpha', '--source', 'verify', '--lane', 'registrar', '--finding', 'Verification returned an unresolved result.', '--verdict', returned.verdict, '--invariant', 'none', '--note', returned.notes))
  assert.equal(item().status, verdict === 'built' ? 'blocked' : 'decision')
})
const continuationPlan = (attemptId = 'resume-attempt', refs = ['alpha']) => {
  const result = stats('--batch-plan', json('resume.json', { refs, resume: [{ ref: 'alpha', attemptId }], authorization: 'Resume the existing authorized wave.' }))
  return { result, data: JSON.parse(result.stdout || '{}') }
}
for (const mode of ['technical', 'genuine', 'mixed']) test(`feature continuation warning and resume distinguish ${mode} unresolved work`, async () => {
  capture(); ok(assess(assessment()))
  const ids = mode === 'mixed' ? ['alpha', 'beta'] : ['alpha']
  if (mode === 'mixed') {
    ok(write('--capture-file', json('beta.json', { id: 'beta', ref: 'beta', type: 'bug', finding: 'Separate authorized correction.', attachments: [] })))
    ok(assess(assessment({ ref: 'beta' })))
  }
  const p = plan(ids); ok(p.result)
  const body = fs.readFileSync(path.join(source, '.claude/workflows/feature.js'), 'utf8').replace('export const meta', 'const meta')
  const agent = async (prompt, opts) => opts.agentType === 'bouncer'
    ? { results: ids.map(id => ({ id, verdict: mode === 'genuine' || id === 'beta' ? 'needs-owner-decision' : 'built', notes: 'Actual uncovered recipient choice or missing independent evidence.' })) }
    : { results: ids.map(id => ({ id, lane: 'registrar', verdict: 'built', evidence: buildEvidence(id), notes: 'Fixture built.', rootCause: 'fixture.md:1', workshopRead: true })) }
  const result = await new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)({ mode: 'build', pieces: ids.map(id => ({ ...piece(id), bounces: 1 })), sharedPiece: 'none', intakeAdmission: p.data.intakeAdmission }, agent, async jobs => Promise.all(jobs.map(j => j())), () => {}, () => {})
  const warning = result.warnings.find(w => w.startsWith('THIS WAVE IS NOT DONE'))
  assert.ok(result.resume); assert.deepEqual(result.resume.pieces.map(p => p.id).sort(), ids)
  if (mode === 'technical') { assert.doesNotMatch(warning, /Record the owner's answer|questionToken/); assert.match(warning, /existing authorization/); assert.equal(result.needsOwnerRuling.length, 0); assert.equal(result.resume.pieces[0].awaitingOwner, undefined) }
  if (mode === 'genuine') { assert.match(warning, /OWNER ANSWERS REQUIRED — alpha/); assert.match(warning, /questionToken/); assert.equal(result.resume.pieces[0].awaitingOwner, true) }
  if (mode === 'mixed') { assert.match(warning, /OWNER ANSWERS REQUIRED — beta/); assert.match(warning, /TECHNICAL CONTINUATION — alpha/); assert.equal(result.resume.pieces.find(p => p.id === 'alpha').awaitingOwner, undefined); assert.equal(result.resume.pieces.find(p => p.id === 'beta').awaitingOwner, true) }
})
const githubHold = (ref = 'gh#12') => {
  ok(write('--capture-file', json('ticket.json', { id: 'ticket', ref, type: 'bug', finding: 'Owner holds this scope.', attachments: [] })))
  ok(write('--ref', ref, '--source', 'owner', '--finding', 'Owner holds this scope.', '--verdict', 'deferred', '--invariant', 'none', '--note', 'Owner: not this scope now.'))
}
for (const id of ['12-a', '#12-a', 'gh#12-a', '12_step1', '12+34', 'gh#12/gh#34', 'gh#12-availability-asserted-unsearched', 'gh#12 I1']) test(`held ticket cannot escape through structured complaint or alias ${id}`, async () => {
  githubHold(); const p = plan([], true); ok(p.result)
  const r = await engine('bugger', { sources: ['github'], intakeAdmission: p.data.intakeAdmission }, { issues: [issue({ id, source: 'github' })] })
  assert.equal(r.lane, false, JSON.stringify(r)); assert.match(r.error, /INTAKE ADMISSION BLOCKED/)
})
test('held complaint leaves a distinct sibling and different numbered ticket available', async () => {
  githubHold('gh#12-a'); const p = plan([], true); ok(p.result)
  for (const id of ['12-b', '112-a']) {
    const r = await engine('bugger', { sources: ['github'], intakeAdmission: p.data.intakeAdmission }, { issues: [issue({ id, source: 'github' })] })
    assert.equal(r.lane, true, JSON.stringify(r))
  }
})
test('implemented feature continuation obtains exact native admission without resetting its lifecycle', async () => {
  capture(); ok(assess(assessment())); build()
  bad(assess(assessment())); const p = continuationPlan(); ok(p.result)
  assert.equal(p.data.intakeAdmission.entries.find(e => e.ref === 'alpha').status, 'continuation')
  const r = await engine('feature', { mode: 'build', pieces: [piece()], sharedPiece: 'none', intakeAdmission: p.data.intakeAdmission })
  assert.equal(r.lane, true, JSON.stringify(r)); assert.equal(item().status, 'review')
})
for (const change of ['hold', 'decision', 'charter', 'snapshot', 'attempt']) test(`continuation refuses newer ${change} without changing recorded implementation`, async () => {
  capture(); ok(assess(assessment())); build()
  if (change === 'hold') ok(hold())
  if (change === 'decision') ok(write('--ref', 'alpha', '--source', 'owner', '--lane', 'registrar', '--finding', 'A real product question remains.', '--verdict', 'needs-owner-decision', '--invariant', 'none', '--note', 'Which recipient scope?', '--recommend', 'defer — retain existing scope'))
  if (change === 'charter') fs.writeFileSync(path.join(root, '.claude/agents/registrar.md'), 'R2 changed')
  if (change === 'snapshot') fs.writeFileSync(path.join(root, 'fixture.md'), 'Changed implementation')
  if (change === 'attempt') build('newer-attempt')
  const p = continuationPlan(); bad(p.result)
  const r = await engine('feature', { mode: 'build', pieces: [piece()], intakeAdmission: p.data.intakeAdmission })
  assert.equal(r.lane, false, JSON.stringify(r))
})
const reviewFixture = (attemptId, verdict = 'pass') => ({ attemptId, reviewer: 'independent-reviewer', trace: 'Fixture independent trace', verdict, reason: verdict === 'pass' ? 'Fixture checked.' : 'Fixture integration failed.', outcome: verdict === 'pass' ? 'traced' : 'refuted', inventoryComplete: true, guardsComplete: true, scope: 'behavioral', findings: verdict === 'pass' ? [] : ['fixture defect'], reviewedPaths: [], checks: [{ id: 'fixture-check', command: 'fixture', exitCode: 0, passed: 1, failed: 0, output: 'fixture output' }] })
test('failed review continuation preserves the failure; verified continuation preserves current review', async () => {
  capture(); ok(assess(assessment())); build()
  for (const verdict of ['fail', 'pass']) {
    const r = write('--review', '--review-file', json('review.json', reviewFixture('resume-attempt', verdict)), '--ref', 'alpha'); ok(r)
    const p = continuationPlan(); ok(p.result)
    assert.equal(p.data.intakeAdmission.entries.find(e => e.ref === 'alpha').review.verdict, verdict)
    assert.equal((await engine('feature', { mode: 'build', pieces: [piece()], intakeAdmission: p.data.intakeAdmission })).lane, true)
  }
})
test('feature continuation runs full dependency order beside a newly authorized piece', async () => {
  capture(); ok(assess(assessment())); build()
  ok(write('--capture-file', json('beta.json', { id: 'beta', ref: 'beta', type: 'suggestion', finding: 'Explicitly approved adjacent piece.', attachments: [] })))
  ok(assess(assessment({ ref: 'beta', type: 'suggestion' })))
  const p = continuationPlan('resume-attempt', ['alpha', 'beta']); ok(p.result)
  const body = fs.readFileSync(path.join(source, '.claude/workflows/feature.js'), 'utf8').replace('export const meta', 'const meta')
  const seen = []
  const agent = async (prompt, opts) => {
    if (opts.agentType === 'bouncer') return { results: [] }
    const pcs = JSON.parse(prompt.split('FULL PAYLOAD:\n').at(-1)); seen.push(...pcs.map(p => p.id))
    return { results: pcs.map(p => ({ id: p.id, lane: p.lane, verdict: 'already-fixed', notes: 'Fixture confirmed', rootCause: 'fixture.md:1', observable: 'fixture', workshopRead: true })) }
  }
  const result = await new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)({ mode: 'build', pieces: [piece('beta', ['alpha']), piece()], sharedPiece: 'none', verify: false, intakeAdmission: p.data.intakeAdmission }, agent, async jobs => Promise.all(jobs.map(j => j())), () => {}, () => {})
  assert.deepEqual(seen.slice(0, 2), ['alpha', 'beta']); assert.ok(result)
})

const architect = (...args) => cli('architect-file.cjs', '--session', 'architect', ...args)
const architectRows = () => JSON.parse(stats('--architect', '--json').stdout)
const seedArchitect = () => fs.writeFileSync(path.join(loop, 'architect-ledger.jsonl'), JSON.stringify({ id: 'X1', date: '2026-09-01', verdict: 'built', target: 'scripts', finding: 'Previously reported framework implementation', evidence: 'fixture.md:1', built: 'Historical shipped implementation fixture.md:1' }) + '\n')
test('native Architect historical closure stays closed without lifecycle correction', () => {
  seedArchitect(); const r = stats('--architect'); ok(r); assert.match(r.stdout, /0 open.*1 closed/)
})
test('native Architect implementation and failed review stay open in reader and report; pass closes only current attempt', () => {
  capture(); seedArchitect(); const history = fs.readFileSync(path.join(loop, 'architect-ledger.jsonl'), 'utf8')
  const evidence = buildEvidence('architect-a1')
  ok(architect('--implementation', 'X1', '--evidence-file', json('arch-evidence.json', evidence)))
  assert.equal(architectRows().open, 1); assert.match(fs.readFileSync(path.join(loop, 'report.md'), 'utf8'), /X1.*implemented.*awaiting independent review/)
  const failed = reviewFixture('architect-a1', 'fail')
  ok(architect('--review', 'X1', '--review-file', json('arch-review.json', failed)))
  assert.equal(architectRows().open, 1); assert.match(fs.readFileSync(path.join(loop, 'report.md'), 'utf8'), /X1.*verification-failed/)
  ok(architect('--implementation', 'X1', '--evidence-file', json('arch-evidence.json', evidence)))
  assert.equal(architectRows().items[0].verdict, 'verification-failed')
  bad(architect('--close', 'X1', '--built', 'Done in fixture.md:1 without review'))
  bad(architect('--review', 'X1', '--review-file', json('wrong-review.json', reviewFixture('old-attempt'))))
  ok(architect('--review', 'X1', '--review-file', json('arch-pass.json', reviewFixture('architect-a1'))))
  assert.equal(architectRows().open, 0); assert.doesNotMatch(fs.readFileSync(path.join(loop, 'report.md'), 'utf8'), /Framework work/)
  fs.writeFileSync(path.join(root, 'fixture.md'), 'Changed after independent pass')
  assert.equal(architectRows().open, 1); assert.equal(architectRows().items[0].verdict, 'verification-unproven')
  ok(write('--sync-report')); assert.match(fs.readFileSync(path.join(loop, 'report.md'), 'utf8'), /X1.*verification-unproven/)
  assert.ok(fs.readFileSync(path.join(loop, 'architect-ledger.jsonl'), 'utf8').startsWith(history))
})
test('Architect ledger-success/report-failure retries once without losing failed-review state', () => {
  capture(); seedArchitect(); const e = json('arch.json', buildEvidence('arch-partial'))
  const report = path.join(loop, 'report.md'); fs.unlinkSync(report); fs.mkdirSync(report)
  bad(architect('--implementation', 'X1', '--evidence-file', e))
  const before = fs.readFileSync(path.join(loop, 'architect-ledger.jsonl'), 'utf8')
  fs.rmdirSync(report); ok(architect('--implementation', 'X1', '--evidence-file', e))
  assert.equal(fs.readFileSync(path.join(loop, 'architect-ledger.jsonl'), 'utf8'), before)
  assert.match(fs.readFileSync(report, 'utf8'), /X1.*implemented/)
})
test('native historical failed-attempt import preserves exact snapshot and rejects a claimed pass', () => {
  capture(); seedArchitect(); const e = buildEvidence('historical-failure')
  const snapshot = { attemptId: e.attemptId, files: [{ file: 'fixture.md', sha256: sha('Original reviewed source') }] }
  const args = ['--implementation', 'X1', '--evidence-file', json('historic.json', e), '--snapshot-file', json('historic-snapshot.json', snapshot)]
  bad(architect(...args, '--review-file', json('bad-import.json', reviewFixture(e.attemptId))))
  ok(architect(...args, '--review-file', json('fail-import.json', reviewFixture(e.attemptId, 'fail'))))
  const current = architectRows(); assert.equal(current.open, 1); assert.deepEqual(current.items[0].snapshot, snapshot.files)
  const history = fs.readFileSync(path.join(loop, 'architect-ledger.jsonl'), 'utf8')
  ok(architect(...args, '--review-file', json('fail-import.json', reviewFixture(e.attemptId, 'fail'))))
  assert.equal(fs.readFileSync(path.join(loop, 'architect-ledger.jsonl'), 'utf8'), history)
})

// a4: owner authority is projected independently of implementation/review.
const question = (words = 'Should external recipients be included?', verdict = 'needs-owner-decision') => ok(write('--ref', 'alpha', '--source', 'owner', '--lane', 'registrar', '--finding', 'A product choice is needed to complete the approved work.', '--verdict', verdict, '--invariant', 'none', '--note', words, '--recommend', 'defer — wait for recipient scope'))
const answerInput = (hisRuling = 'Keep this owner-only and finish the approved wave.', extra = {}) => {
  const r = item()
  return assessment({ reason: 'Owner answered the current scope question.', ...(r.evidence ? { attemptId: r.evidence.attemptId } : {}), ownerRuled: { questionToken: r.questionToken, askedBecause: r.ownerQuestion, hisRuling, ...(r.rulingToken ? { supersedes: r.rulingToken } : {}) }, ...extra })
}
test('a3 independent reproduction: implemented question answer admits actual owner-ruled feature resume', async () => {
  capture(); ok(assess(assessment())); build(); const original = item().evidence
  question(); const answer = answerInput(); ok(assess(answer))
  assert.deepEqual(item().evidence, original); assert.equal(item().status, 'review')
  const p = continuationPlan(); ok(p.result)
  const r = await engine('feature', { mode: 'build', pieces: [{ ...piece(), _ownerRuled: { askedBecause: answer.ownerRuled.askedBecause, hisRuling: answer.ownerRuled.hisRuling } }], intakeAdmission: p.data.intakeAdmission })
  assert.equal(r.lane, true, JSON.stringify(r)); assert.match(r.calls[0], /^owner:registrar/)
})
for (const verdict of ['needs-owner-decision', 'blocked-charter']) test(`plain native ${verdict} retains charter authorization and admits its first answered build`, async () => {
  capture(); ok(assess(assessment())); question(undefined, verdict)
  assert.equal(item().status, 'decision'); assert.equal(item().intake.authorization, 'Owner: run alpha.')
  bad(assess(assessment())); ok(assess(answerInput()))
  const p = plan(['alpha']); ok(p.result)
  const r = await engine('bugger', { issues: [issue()], intakeAdmission: p.data.intakeAdmission })
  assert.equal(r.lane, true, JSON.stringify(r)); assert.match(r.prompts[0], /Keep this owner-only and finish/)
})
test('native answer retry is idempotent; revised answer rejects older payload in both engines', async () => {
  capture(); ok(assess(assessment())); build(); question()
  const first = answerInput(); ok(assess(first)); const history = fs.readFileSync(path.join(loop, 'ledger.jsonl'), 'utf8')
  ok(assess(first)); assert.equal(fs.readFileSync(path.join(loop, 'ledger.jsonl'), 'utf8'), history)
  const revised = answerInput('Include only explicitly selected external recipients.'); ok(assess(revised)); bad(assess(first))
  const p = continuationPlan(); ok(p.result)
  for (const name of ['bugger', 'feature']) {
    const old = { askedBecause: first.ownerRuled.askedBecause, hisRuling: first.ownerRuled.hisRuling }
    const args = name === 'bugger' ? { issues: [issue({ _ownerRuled: old })] } : { mode: 'build', pieces: [{ ...piece(), _ownerRuled: old }] }
    assert.equal((await engine(name, { ...args, intakeAdmission: p.data.intakeAdmission })).lane, false)
    const currentArgs = name === 'bugger' ? { issues: [issue()] } : { mode: 'build', pieces: [piece()] }
    assert.equal((await engine(name, { ...currentArgs, intakeAdmission: p.data.intakeAdmission })).lane, true)
  }
})
test('later question invalidates earlier answer even with identical question words', async () => {
  capture(); ok(assess(assessment())); build(); question(); const first = answerInput(); ok(assess(first)); question()
  assert.equal(item().status, 'decision'); bad(assess(first)); bad(continuationPlan().result)
  ok(assess(answerInput())); ok(continuationPlan().result)
})
test('hold release preserves a separate unanswered question and never erases implementation', () => {
  capture(); ok(assess(assessment())); build(); question(); ok(hold())
  const attempt = item().evidence.attemptId; bad(assess(answerInput()))
  const release = assessment({ releaseHold: 'Owner: release this hold; answer separately.', releaseHoldFor: item().dispositionToken })
  bad(assess(release)) // unresolved question is not an answer
  ok(assess(answerInput(undefined, release)))
  assert.equal(item().evidence.attemptId, attempt); ok(continuationPlan().result)
  ok(hold('Owner: hold again after answering.')); bad(assess(release)); bad(continuationPlan().result)
})
test('implemented hold releases through metadata without resetting its exact attempt', () => {
  capture(); ok(assess(assessment())); build(); ok(hold())
  ok(assess(assessment({ releaseHold: 'Owner releases this exact hold.', releaseHoldFor: item().dispositionToken })))
  assert.equal(item().evidence.attemptId, 'resume-attempt'); ok(continuationPlan().result)
})
test('later unanswered gate cannot be overwritten by a builder or pre-answer review pass', () => {
  capture(); ok(assess(assessment())); build(); question()
  const pass = json('oldpass.json', reviewFixture('resume-attempt'))
  bad(write('--review', '--ref', 'alpha', '--review-file', pass))
  bad(write('--ref', 'alpha', '--source', 'owner', '--lane', 'registrar', '--finding', 'Attempted unauthorized continuation.', '--verdict', 'built', '--rootCause', 'fixture.md:1', '--invariant', 'none', '--evidence-file', json('unauthorized.json', buildEvidence('next'))))
  ok(assess(answerInput())); bad(write('--review', '--ref', 'alpha', '--review-file', pass))
  ok(write('--review', '--ref', 'alpha', '--review-file', json('boundpass.json', { ...reviewFixture('resume-attempt'), ownerRulingToken: item().rulingToken })))
  assert.equal(item().verdict, 'verified')
})
test('revised answer after a pass invalidates that pass; re-review does not fabricate a build', () => {
  capture(); ok(assess(assessment())); build(); question(); ok(assess(answerInput()))
  const current = item(); ok(write('--review', '--ref', 'alpha', '--review-file', json('pass.json', { ...reviewFixture('resume-attempt'), ownerRulingToken: current.rulingToken })))
  ok(assess(answerInput('Use the revised owner-only recipient list.')))
  assert.equal(item().verdict, 'verification-unproven'); assert.equal(item().evidence.attemptId, 'resume-attempt')
  bad(write('--review', '--ref', 'alpha', '--review-file', path.join(root, 'pass.json')))
})
test('fresh repaired attempt retains owner words and invalidates stale attempt admission', () => {
  capture(); ok(assess(assessment())); build(); question(); ok(assess(answerInput())); build('repaired-attempt')
  bad(continuationPlan().result); const p = continuationPlan('repaired-attempt'); ok(p.result)
  assert.match(p.data.intakeAdmission.entries[0].ownerRuled.hisRuling, /owner-only/)
  ok(write('--review', '--ref', 'alpha', '--review-file', json('newpass.json', reviewFixture('repaired-attempt'))))
})
for (const terminal of ['declined', 'converted', 'wrapped']) test(`answered continuation cannot reopen ${terminal} terminal work`, async () => {
  capture(); ok(assess(assessment())); build(); question(); const answer = answerInput(); ok(assess(answer))
  if (terminal === 'wrapped') {
    ok(write('--review', '--ref', 'alpha', '--review-file', json('terminalpass.json', { ...reviewFixture('resume-attempt'), ownerRulingToken: item().rulingToken })))
    ok(write('--wrap-companion', '--ref', 'alpha', '--version', '1.2.3', '--sha', 'fixture-sha'))
  } else ok(write('--ref', 'alpha', '--source', 'owner', '--finding', 'Owner closes this product work.', '--verdict', terminal, '--invariant', 'none', '--note', terminal === 'converted' ? 'Moved to → gh#999' : 'Owner declined this work.'))
  bad(assess(answer)); const p = continuationPlan(); bad(p.result)
  assert.equal((await engine('feature', { mode: 'build', pieces: [piece()], intakeAdmission: p.data.intakeAdmission })).lane, false)
})
test('answer survives report failure/retry and a retained duplicate without reopening a later hold', () => {
  capture(); ok(assess(assessment())); build(); question(); const answer = answerInput()
  const report = path.join(loop, 'report.md'); fs.unlinkSync(report); fs.mkdirSync(report)
  bad(assess(answer)); const history = fs.readFileSync(path.join(loop, 'ledger.jsonl'), 'utf8')
  fs.rmdirSync(report); ok(assess(answer)); assert.equal(fs.readFileSync(path.join(loop, 'ledger.jsonl'), 'utf8'), history)
  ok(write('--capture-file', json('answer-example.json', { id: 'answer-example', ref: 'alpha', type: 'bug', finding: 'Same exact request again.', sameItemEvidence: 'Same req_1.', attachments: [] })))
  ok(continuationPlan().result); ok(hold()); bad(assess(answer)); assert.equal(item().status, 'held')
})
test('owner-resolved partial feature resumes in dependency order; a held sibling stops the whole selected package', async () => {
  capture(); ok(assess(assessment())); build(); question(); ok(assess(answerInput()))
  ok(write('--capture-file', json('dependent.json', { id: 'dependent', ref: 'beta', type: 'suggestion', finding: 'Approved dependent delivery piece.', attachments: [] })))
  ok(assess(assessment({ ref: 'beta', type: 'suggestion' })))
  const p = continuationPlan('resume-attempt', ['alpha', 'beta']); ok(p.result)
  const body = fs.readFileSync(path.join(source, '.claude/workflows/feature.js'), 'utf8').replace('export const meta', 'const meta'), seen = []
  const agent = async (prompt, opts) => {
    if (opts.agentType === 'bouncer') return { results: [] }
    const pcs = JSON.parse(prompt.split('FULL PAYLOAD:\n').at(-1)); seen.push(...pcs)
    return { results: pcs.map(p => ({ id: p.id, lane: p.lane, verdict: 'already-fixed', notes: 'Fixture confirmed', rootCause: 'fixture.md:1', observable: 'fixture', workshopRead: true })) }
  }
  await new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)({ mode: 'build', pieces: [piece('beta', ['alpha']), piece()], sharedPiece: 'none', verify: false, intakeAdmission: p.data.intakeAdmission }, agent, async jobs => Promise.all(jobs.map(j => j())), () => {}, () => {})
  assert.deepEqual(seen.slice(0, 2).map(p => p.id), ['alpha', 'beta']); assert.match(seen[0]._ownerRuled.hisRuling, /owner-only/)
  ok(write('--ref', 'beta', '--source', 'owner', '--finding', 'Owner holds the dependent piece.', '--verdict', 'deferred', '--invariant', 'none', '--note', 'Hold beta now.'))
  const blocked = continuationPlan('resume-attempt', ['alpha', 'beta']); bad(blocked.result)
  assert.equal((await engine('feature', { mode: 'build', pieces: [piece(), piece('beta', ['alpha'])], intakeAdmission: blocked.data.intakeAdmission })).lane, false)
})
for (const changed of ['charter', 'source', 'attempt']) test(`answered continuation still rejects changed ${changed}`, () => {
  capture(); ok(assess(assessment())); build(); question(); ok(assess(answerInput()))
  if (changed === 'charter') fs.writeFileSync(path.join(root, '.claude/agents/registrar.md'), 'R2 revised charter')
  if (changed === 'source') fs.writeFileSync(path.join(root, 'fixture.md'), 'Changed implementation')
  if (changed === 'attempt') build('new-attempt')
  bad(continuationPlan().result)
})
test('native question and answer do not silently release an explicit legacy hold', () => {
  fs.writeFileSync(path.join(loop, 'ledger.jsonl'), JSON.stringify({ ref: 'alpha', source: 'owner', verdict: 'deferred', note: 'Owner holds this legacy work.' }) + '\n')
  // Another captured ref adopts the board; the legacy hold itself stays intact.
  ok(write('--capture-file', json('other.json', { id: 'other', ref: 'other', type: 'bug', finding: 'Another collection-only item.', attachments: [] })))
  question(); assert.equal(item().status, 'held'); bad(assess(answerInput()))
  ok(assess(answerInput(undefined, { releaseHold: 'Owner explicitly releases alpha.', releaseHoldFor: item().dispositionToken })))
  ok(plan(['alpha']).result)
})
test('historical unadopted closure is not reopened by an earlier hold when another ref adopts intake', () => {
  fs.writeFileSync(path.join(loop, 'ledger.jsonl'), [
    { ref: 'old-ref', verdict: 'deferred', note: 'Historical hold.' },
    { ref: 'old-ref', verdict: 'built', finding: 'Historical completed work.' },
    { ref: 'old-ref', verdict: 'wrapped', state: 'wrapped', runId: 'wrap-1.0.0' }
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  capture()
  const result = stats('--intake'); ok(result)
  assert.deepEqual(JSON.parse(result.stdout).items.map(r => r.ref), ['alpha'])
  ok(stats('--report'))
})
for (const gate of ['hold', 'question']) for (const terminal of ['declined', 'converted']) test(`${terminal} closes adopted ${gate} scope instead of stranding it open`, () => {
  capture(); ok(assess(assessment())); if (gate === 'hold') ok(hold()); else question()
  ok(write('--ref', 'alpha', '--source', 'owner', '--finding', 'Owner closed this product work.', '--verdict', terminal, '--invariant', 'none', '--note', terminal === 'converted' ? 'Moved to → gh#999' : 'Owner declined this work.'))
  const report = stats('--intake'); ok(report); assert.equal(JSON.parse(report.stdout).items.length, 0)
  assert.equal(item().verdict, terminal); bad(plan(['alpha']).result); bad(assess(assessment()))
  bad(write('--ref', 'alpha', '--source', 'owner', '--finding', 'A new question must not disappear under a terminal ref.', '--verdict', 'needs-owner-decision', '--invariant', 'none', '--note', 'Which new scope?'))
  ok(stats('--report'))
})
test('terminal disposition closes owner scope but does not pretend its unreviewed implementation is verified', () => {
  capture(); ok(assess(assessment())); build(); question()
  ok(write('--ref', 'alpha', '--source', 'owner', '--finding', 'Owner declined further implementation.', '--verdict', 'declined', '--invariant', 'none', '--note', 'Owner declined this work.'))
  assert.equal(JSON.parse(stats('--intake').stdout).items.length, 0)
  bad(stats('--verification')); bad(continuationPlan().result)
})
