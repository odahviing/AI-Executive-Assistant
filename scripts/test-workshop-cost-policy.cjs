#!/usr/bin/env node
// Real compiled engine control flow with the existing synthetic dispatch harness.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const zlib = require('node:zlib')
const { makeRunner, neutralise, GOOD_PIECE, GOOD_PLAN } = require('./check-design-door.cjs')
const repo = path.resolve(__dirname, '..')
const before = process.argv.includes('--before')
const captured = before ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(repo, 'scripts/fixtures/workshop-cost-before.json.gz')))) : null
const source = name => before ? captured[name] : fs.readFileSync(path.join(repo, '.claude/workflows', name + '.js'), 'utf8')
const runner = name => makeRunner(vm.compileFunction(`return (async () => {${neutralise(source(name))}\n})()`, ['args', 'agent', 'parallel', 'log', 'phase']))
const bugger = runner('bugger'), feature = runner('feature')
const issue = { id: 'b1', lane: 'slackmaster', symptom: 'A bounded fixture defect', evidence: 'src/x.ts:1', clarity: 'clear', source: 'owner', severity: 'medium' }
const args = { issues: [issue] }
const canned = {
  'slackmaster(1)': { results: [{ id: 'b1', verdict: 'built', workshopRead: true, filesTouched: ['src/x.ts'], observable: 'Fixture result is now correct' }] },
  'bouncer:wave': { results: [{ id: 'b1', verdict: 'built' }], outcomeTraces: [{ id: 'b1', verdict: 'traced', evidence: 'src/x.ts:1' }], discoveries: [], ticketCoverage: [], verifiedClean: [] },
  traces: { itemsInFile: 30, goldenTraces: Array.from({ length: 30 }, (_, i) => ({ id: 'Z' + (i + 1), verdict: 'pass', evidence: 'fixture:1' })) },
}
const run = async (extra = {}, data = canned) => { const r = await bugger({ ...args, ...extra }, data); assert.equal(r.err, null); return r }
test('ordinary package runs one independent review and defers full Golden explicitly', async () => {
  const r = await run()
  assert.equal(r.calls.filter(c => c.opts.agentType === 'bouncer').length, 1)
  assert.equal(r.calls.filter(c => c.label === 'traces').length, 0)
  assert.equal(r.out.manifest.golden.ran, false)
  assert.equal(r.out.manifest.golden.passed, 0)
  assert.equal(r.out.manifest.golden.scope, 'release-checkpoint')
  assert.match(r.out.manifest.golden.notRunReason, /release checkpoint/)
})
test('explicit release checkpoint runs the full battery exactly once and keeps independent review', async () => {
  const r = await run({ releaseCheckpoint: true })
  assert.equal(r.calls.filter(c => c.label === 'traces').length, 1)
  assert.equal(r.calls.filter(c => c.opts.agentType === 'bouncer').length, 1)
  assert.equal(r.out.manifest.golden.ran, true)
  assert.equal(r.out.manifest.golden.answered, 30)
  assert.equal(r.out.verification.wrapReady, true)
})
for (const [name, response] of [
  ['missing', null],
  ['short', { itemsInFile: 2, goldenTraces: [{ id: 'Z1', verdict: 'pass', evidence: 'fixture:1' }] }],
  ['unknown verdict', { itemsInFile: 1, goldenTraces: [{ id: 'Z1', verdict: 'skipped', evidence: 'not checked' }] }],
]) test(`release ${name} battery cannot claim wrap readiness`, async () => {
  const r = await run({ releaseCheckpoint: true }, { ...canned, traces: response })
  assert.equal(r.out.verification.wrapReady, false)
})
test('release failure remains represented and blocks readiness', async () => {
  const r = await run({ releaseCheckpoint: true }, { ...canned, traces: { itemsInFile: 1, goldenTraces: [{ id: 'Z1', verdict: 'fail', lane: 'slackmaster', evidence: 'fixture:1' }] } })
  assert.deepEqual(r.out.manifest.golden.fails, ['Z1'])
  assert.equal(r.out.verification.wrapReady, false)
})
test('active Claude effort maps use medium or high, with high for sensitive lanes and reviewer', () => {
  for (const name of ['bugger', 'feature', 'charter-audit']) {
    const statement = source(name).match(/^const EFFORT = .+$/m)[0]
    const effort = vm.runInNewContext(statement + '\nEFFORT')
    for (const lane of ['matchmaker', 'registrar', 'gatekeeper', 'bouncer', 'framer']) assert.equal(effort[lane], 'high', name + ':' + lane)
    for (const lane of ['instructor', 'slackmaster', 'diplomat', 'handyman', 'librarian', 'editor']) assert.equal(effort[lane], 'medium', name + ':' + lane)
    assert.ok(Object.values(effort).every(x => ['medium', 'high'].includes(x)))
  }
})
test('feature package uses medium builder and high independent reviewer without full Golden', async () => {
  const r = await feature({ mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece }, {
    slackmaster: { results: [{ id: 'p1', verdict: 'built', filesTouched: ['src/x.ts'] }] },
    'bouncer:wave': { results: [{ id: 'p1', verdict: 'built' }], discoveries: [], ticketCoverage: [], verifiedClean: [] },
  })
  assert.equal(r.err, null)
  assert.equal(r.calls.find(c => c.opts.agentType === 'slackmaster').opts.effort, 'medium')
  assert.equal(r.calls.find(c => c.opts.agentType === 'bouncer').opts.effort, 'high')
  assert.equal(r.calls.filter(c => c.label === 'traces').length, 0)
  assert.equal(r.out.manifest.golden.ran, false)
})
test('Claude dispatches preserve provider-native selectors', async () => {
  const r = await run({ releaseCheckpoint: true })
  assert.ok(r.calls.every(c => !c.opts.model || ['sonnet', 'opus', 'fable', 'haiku'].includes(c.opts.model)))
})
test('Codex Manager defaults to Astra Light and routine subagents include independent review', () => {
  const config = fs.readFileSync(path.join(repo, '.codex/config.toml'), 'utf8')
  const policy = fs.readFileSync(path.join(repo, '.claude/WORKSHOP.md'), 'utf8')
  assert.match(config, /^model = "gpt-6-astra"$/m)
  assert.match(config, /^model_reasoning_effort = "low"$/m)
  assert.match(policy, /Manager \(UI: Astra Light\).*`gpt-6-astra`.*`low`/)
  assert.match(policy, /Routine subagents, including independent Bouncer.*`gpt-6-astra`.*`gpt-5\.6-sol`.*`low`.*`medium`/)
  assert.match(policy, /higher effort requires an explicit owner request/)
})
test('cost policy preserves refusal of an absent independent review', async () => {
  const r = await run({}, { ...canned, 'bouncer:wave': null })
  assert.equal(r.out.verification.wrapReady, false)
  assert.ok(r.out.verification.pending.includes('b1'))
})
