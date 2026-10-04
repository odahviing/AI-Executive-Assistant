// Executes the real CLI in an isolated repository. --before-ref proves the gaps.
const { test, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const repo = path.join(__dirname, '..')
const root = fs.mkdtempSync(path.join(repo, '.workshop-intake-'))
assert.equal(spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' }).status, 0)
const arg = process.argv.indexOf('--before-ref')
const before = arg >= 0 ? process.argv[arg + 1] : null
const loop = path.join(root, '.claude/agent-loop')
fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
fs.mkdirSync(path.join(root, '.claude/agents'), { recursive: true })
for (const name of ['ledger-file.cjs', 'ledger-stats.cjs', 'workshop-verification.cjs', 'workshop-intake.cjs']) {
  const target = path.join(root, 'scripts', name)
  if (before && name !== 'workshop-intake.cjs') {
    const old = spawnSync('git', ['show', `${before}:scripts/${name}`], { cwd: repo, encoding: 'utf8' })
    assert.equal(old.status, 0, old.stderr); fs.writeFileSync(target, old.stdout)
  } else fs.copyFileSync(path.join(__dirname, name), target)
}
const ledger = path.join(loop, 'ledger.jsonl'), report = path.join(loop, 'report.md')
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const cli = (script, ...args) => spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8' })
const writer = (...args) => cli('ledger-file.cjs', ...args)
const stats = (...args) => cli('ledger-stats.cjs', ...args)
const json = (file, data) => { const p = path.join(root, file); fs.writeFileSync(p, JSON.stringify(data)); return p }
const rows = () => fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const setRows = data => fs.writeFileSync(ledger, data.map(JSON.stringify).join('\n') + '\n')
const ok = result => assert.equal(result.status, 0, result.stderr + result.stdout)
const bad = result => assert.notEqual(result.status, 0, result.stdout)
const capture = (extra = {}) => writer('--capture-file', json('capture.json', { id: 'message-1', ref: 'alpha', type: 'bug', finding: 'Owner says the expected notification was not delivered.', attachments: [], ...extra }))
const assessment = (extra = {}) => writer('--assess-file', json('assessment.json', { ref: 'alpha', status: 'ready', reason: 'Charter covers restoring the existing delivery guarantee.', lane: 'registrar', charter: { file: '.claude/agents/registrar.md', rule: 'R1 deliver accepted work', sha256: sha('R1 deliver accepted work') }, authorization: 'Owner: run the collected alpha bug.', ...extra }))
const plan = refs => stats('--batch-plan', json('plan.json', { refs, authorization: 'Owner: run the selected collected items.' }))
const view = () => { const r = stats('--intake'); ok(r); return JSON.parse(r.stdout) }
beforeEach(() => {
  // Exact fixture root checked before recursive reset; never touch the workspace.
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(repo))
  if (fs.existsSync(loop)) fs.rmSync(loop, { recursive: true, force: true })
  fs.mkdirSync(loop, { recursive: true }); setRows([])
  fs.writeFileSync(path.join(loop, 'state.json'), JSON.stringify({ lastRun: { status: 'complete' }, inFlight: [] }))
  fs.writeFileSync(path.join(root, '.claude/agents/registrar.md'), 'R1 deliver accepted work')
})
after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(repo)); fs.rmSync(root, { recursive: true, force: true }) })

test('capture synchronizes report, stays collected and preserves bug/suggestion distinction', () => {
  ok(capture()); ok(capture({ id: 'message-2', ref: 'suggestion', type: 'suggestion' }))
  assert.equal(rows().length, 2); assert.equal(view().counts.captured, 2); assert.equal(view().counts.decision, 0)
  assert.match(fs.readFileSync(report, 'utf8'), /suggestion/); ok(stats('--report'))
})
test('identical capture retry appends once and repairs stale report', () => {
  ok(capture()); fs.writeFileSync(report, 'stale')
  ok(capture()); assert.equal(rows().length, 1); ok(stats('--report'))
  bad(capture({ finding: 'Changed words cannot overwrite this message identity.' }))
})
test('first adoption cannot erase an unreconciled legacy report table', () => {
  const old = '| Lane · ref | What happened | Your options | Risk |\n|---|---|---|---|\n| registrar · old-ref | Existing owner report | Hold | Unknown |\n'
  fs.writeFileSync(report, old); bad(capture()); bad(writer('--sync-report'))
  assert.equal(rows().length, 0); assert.equal(fs.readFileSync(report, 'utf8'), old)
})
test('ledger success/report failure is loud; retry restores projection without duplication', () => {
  fs.mkdirSync(report)
  const failed = capture(); bad(failed); assert.match(failed.stderr, /append succeeded, report synchronization failed/)
  assert.equal(rows().length, 1); fs.rmdirSync(report)
  ok(capture()); assert.equal(rows().length, 1); ok(stats('--report'))
})
test('partial unreadable ledger refuses further append and keeps prior bytes', () => {
  fs.writeFileSync(ledger, '{"ref":'); const prior = fs.readFileSync(ledger)
  bad(capture()); assert.deepEqual(fs.readFileSync(ledger), prior)
})
test('writer lock and active run prevent competing capture/report writes', () => {
  fs.writeFileSync(`${ledger}.lock`, 'another writer'); bad(capture()); assert.equal(rows().length, 0)
  fs.unlinkSync(`${ledger}.lock`)
  fs.writeFileSync(path.join(loop, 'state.json'), JSON.stringify({ lastRun: { status: 'running' } }))
  bad(capture()); assert.equal(rows().length, 0)
})
test('proven same-item examples retain screenshots and first words, similarity never merges', () => {
  fs.writeFileSync(path.join(root, 'screen.png'), 'first screenshot bytes')
  ok(capture({ attachments: ['screen.png'] }))
  bad(capture({ id: 'message-2' }))
  ok(capture({ id: 'message-2', finding: 'Second example with different words.', sameItemEvidence: 'Same original request ID req_1 and failed delivery event.' }))
  ok(capture({ id: 'message-3', ref: 'distinct-root' }))
  const b = view(); assert.equal(b.items.length, 2); assert.equal(b.items.find(r => r.ref === 'alpha').examples, 2)
  const attachment = rows()[0].capture.attachments[0]
  fs.unlinkSync(path.join(root, 'screen.png'))
  assert.equal(fs.readFileSync(path.join(root, attachment.file), 'utf8'), 'first screenshot bytes')
  assert.match(b.items.find(r => r.ref === 'alpha').finding, /expected notification/)
  fs.writeFileSync(path.join(root, attachment.file), 'tampered')
  bad(stats('--report'))
})
test('missing screenshots and bundled identities refuse before creating an item', () => {
  bad(capture({ attachments: ['absent.png'] })); assert.equal(rows().length, 0)
  bad(capture({ ref: 'gh#12+gh#13' })); assert.equal(rows().length, 0)
})
test('held backlog and decline cannot become authorized through capture or recommendation', () => {
  setRows([{ ref: 'alpha', verdict: 'needs-owner-decision', finding: 'Existing held owner ruling.', recommend: 'build — tempting', note: 'Owner: hold this.' }])
  ok(capture({ sameItemEvidence: 'Same named held item alpha.' })); assert.equal(view().counts.held, 1)
  bad(assessment()); bad(plan(['alpha']))
  ok(assessment({ releaseHold: 'Owner explicitly releases alpha for this run.', releaseHoldFor: JSON.parse(stats('--intake', '--ref', 'alpha').stdout).items[0].dispositionToken, type: 'bug' }))
  ok(plan(['alpha']))
  ok(writer('--ref', 'alpha', '--source', 'owner', '--finding', 'Owner declined the proposed change explicitly.', '--verdict', 'declined', '--invariant', 'none', '--note', 'Owner: do not build.'))
  bad(capture({ id: 'new-example', sameItemEvidence: 'Same item.' })); bad(plan(['alpha'])); ok(stats('--report'))
})
test('charter-covered bug and suggestion group once per lane after explicit authorization', () => {
  ok(capture()); ok(capture({ id: 's', ref: 'suggestion', type: 'suggestion' }))
  bad(assessment({ authorization: '' })); ok(assessment()); ok(assessment({ ref: 'suggestion' }))
  const p = plan(['alpha', 'suggestion']); ok(p); const data = JSON.parse(p.stdout)
  assert.equal(data.batches.length, 1); assert.equal(data.included, 2); assert.equal(data.blocked.length, 0)
  bad(plan(['alpha', 'alpha'])); bad(plan(['alpha', 'absent']))
  fs.writeFileSync(path.join(root, '.claude/agents/registrar.md'), 'Changed charter')
  bad(plan(['alpha'])); assert.equal(view().counts.captured, 2)
})
test('only charter-uncovered decisions reach owner and cannot join ready batches', () => {
  ok(capture({ type: 'suggestion' }))
  bad(assessment({ status: 'decision', question: 'Which scope?' }))
  ok(assessment({ status: 'decision', question: 'Should external recipients be included?', uncovered: 'Charter covers owner-only delivery; external scope is a product choice.', recommend: 'defer — retain current recipients' }))
  assert.equal(view().counts.decision, 1); bad(plan(['alpha'])); ok(stats('--report'))
})
test('different lanes stay separate and in-flight work is excluded without losing refs', () => {
  ok(capture()); ok(assessment())
  fs.writeFileSync(path.join(root, '.claude/agents/librarian.md'), 'L1 knowledge scope')
  ok(capture({ id: 'second', ref: 'second-lane', type: 'suggestion' }))
  ok(assessment({ ref: 'second-lane', lane: 'librarian', charter: { file: '.claude/agents/librarian.md', rule: 'L1 knowledge scope', sha256: sha('L1 knowledge scope') } }))
  const p = plan(['alpha', 'second-lane']); ok(p); assert.equal(JSON.parse(p.stdout).batches.length, 2)
  fs.writeFileSync(path.join(loop, 'state.json'), JSON.stringify({ lastRun: { status: 'complete' }, inFlight: [{ ref: 'alpha' }] }))
  const blocked = plan(['alpha', 'second-lane']); bad(blocked); assert.equal(JSON.parse(blocked.stdout).included, 1)
  assert.equal(view().items.length, 2)
})
test('missing item, false verified claim and marker removal all fail report reconciliation', () => {
  ok(capture()); const valid = fs.readFileSync(report, 'utf8')
  for (const badReport of [valid.split('\n').filter(l => !l.includes('unassigned · alpha')).join('\n'), valid.replace('awaiting wrap (0)', 'awaiting wrap (1)'), '**0 rows await you**']) {
    fs.writeFileSync(report, badReport); bad(stats('--report')); ok(writer('--sync-report')); ok(stats('--report'))
  }
})
test('native independent review and release transitions refresh report without false closure', () => {
  ok(capture()); fs.writeFileSync(path.join(root, 'fixture.md'), 'Fixture documentation')
  const evidence = { version: 1, attemptId: 'attempt-1', builder: 'builder', changeKind: 'prose-only', exception: 'Fixture documents lifecycle mechanics only.', files: ['fixture.md'], regressions: [], boundaries: { changedGuards: [], paths: [] } }
  ok(writer('--ref', 'alpha', '--source', 'owner', '--finding', 'Documented the expected workshop capture lifecycle.', '--lane', 'registrar', '--verdict', 'built', '--rootCause', 'fixture.md:1', '--invariant', 'none', '--evidence-file', json('evidence.json', evidence)))
  assert.equal(view().counts.review, 1); bad(stats('--report'))
  const review = { verdict: 'pass', reviewer: 'independent-bouncer', trace: 'review-dispatch', reason: 'Inspected fixture documentation.', attemptId: 'attempt-1', outcome: 'traced', inventoryComplete: true, guardsComplete: true, findings: [], reviewedPaths: [], checks: [] }
  ok(writer('--review', '--ref', 'alpha', '--review-file', json('review.json', review)))
  assert.equal(view().verified.length, 1); assert.equal(view().items.length, 0); ok(stats('--report'))
  ok(writer('--wrap-companion', '--ref', 'alpha', '--version', '99.0.0', '--sha', 'real-sha-supplied-by-release'))
  assert.equal(view().verified.length, 0); ok(stats('--report'))
})
test('preserved ordinary verdict writer requires invariant and keeps legacy held work open', () => {
  bad(writer('--ref', 'legacy', '--source', 'owner', '--finding', 'An existing local defect needs a future assessment.', '--verdict', 'needs-owner-decision', '--note', 'Owner deferred this item.'))
  ok(writer('--ref', 'legacy', '--source', 'owner', '--finding', 'An existing local defect needs a future assessment.', '--verdict', 'needs-owner-decision', '--invariant', 'none', '--note', 'Owner deferred this item.'))
  const result = stats('--open', '--json'); ok(result); assert.equal(JSON.parse(result.stdout)[0].ref, 'legacy')
})
test('a real lane product question remains visible after an implementation without clearing review', () => {
  ok(capture()); fs.writeFileSync(path.join(root, 'fixture.md'), 'Fixture')
  const evidence = { version: 1, attemptId: 'question-attempt', builder: 'builder', changeKind: 'prose-only', exception: 'Only exercises lifecycle state.', files: ['fixture.md'], regressions: [], boundaries: { changedGuards: [], paths: [] } }
  ok(writer('--ref', 'alpha', '--source', 'owner', '--finding', 'A partial documented implementation still needs a decision.', '--verdict', 'built', '--rootCause', 'fixture.md:1', '--invariant', 'none', '--evidence-file', json('question-evidence.json', evidence)))
  bad(assessment())
  ok(writer('--ref', 'alpha', '--source', 'owner', '--finding', 'Lane proved a new product choice outside existing charter.', '--verdict', 'needs-owner-decision', '--invariant', 'none', '--recommend', 'defer — decide the external recipient scope'))
  ok(assessment({ status: 'decision', question: 'Include external recipients?', uncovered: 'Existing charter covers only owner delivery.', recommend: 'defer — retain current scope' }))
  assert.equal(view().counts.decision, 1); bad(stats('--verification')); bad(plan(['alpha']))
})
