#!/usr/bin/env node
// Focused real-engine readiness controls; synthetic agent replies, no live dispatch.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const zlib = require('node:zlib')
const { makeRunner, neutralise, GOOD_PIECE, GOOD_PLAN } = require('./check-design-door.cjs')
const repo = path.resolve(__dirname, '..')
const before = process.argv.includes('--before')
const captured = before ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(repo, 'scripts/fixtures/workshop-release-before.json.gz')))) : null
const runner = name => makeRunner(vm.compileFunction(`return (async () => {${neutralise(before ? captured[name] : fs.readFileSync(path.join(repo, '.claude/workflows', name + '.js'), 'utf8'))}\n})()`, ['args', 'agent', 'parallel', 'log', 'phase']))
const bugger = runner('bugger'), feature = runner('feature')
const ids = [...fs.readFileSync(path.join(repo, '.claude/GOLDEN_PATHS.md'), 'utf8').matchAll(/^- \*\*(Z\d+)\b/gm)].map(m => m[1])
assert.deepEqual(ids, Array.from({ length: 30 }, (_, i) => 'Z' + (i + 1)), 'fixed release catalog is the actual Golden30 inventory')
const issue = { id: 'b1', lane: 'slackmaster', symptom: 'Bounded fixture defect', evidence: 'src/x.ts:1', clarity: 'clear', source: 'owner', severity: 'medium' }
const response = (selected = ids, count = selected.length) => ({ itemsInFile: count, goldenTraces: selected.map(id => ({ id, verdict: 'pass', evidence: 'fixture:1' })) })
const run = async (release, golden = response()) => {
  const r = await bugger({ issues: [issue], releaseCheckpoint: release }, {
    'slackmaster(1)': { results: [{ id: 'b1', verdict: 'built', workshopRead: true, filesTouched: ['src/x.ts'] }] },
    'bouncer:wave': { results: [{ id: 'b1', verdict: 'built' }], discoveries: [], ticketCoverage: [], verifiedClean: [] },
    traces: golden,
  })
  assert.equal(r.err, null); return r
}
test('ordinary bugger package is independently ready while release remains pending', async () => {
  const r = await run(false)
  assert.equal(r.out.verification.packageReady, true)
  assert.equal(r.out.verification.wrapReady, false)
  assert.equal(r.out.manifest.golden.ran, false)
})
test('feature package readiness does not imply its external release checkpoint ran', async () => {
  const r = await feature({ mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece }, {
    slackmaster: { results: [{ id: 'p1', verdict: 'built', filesTouched: ['src/x.ts'] }] },
    'bouncer:wave': { results: [{ id: 'p1', verdict: 'built' }], discoveries: [], ticketCoverage: [], verifiedClean: [] },
  })
  assert.equal(r.err, null)
  assert.equal(r.out.verification.packageReady, true)
  assert.equal(r.out.verification.wrapReady, false)
})
test('actual complete Golden30 inventory preserves release readiness', async () => {
  const r = await run(true)
  assert.equal(r.out.verification.wrapReady, true)
  assert.equal(r.out.manifest.golden.answered, 30)
})
test('self-reported two-item battery cannot pass as Golden30', async () => {
  assert.equal((await run(true, response(['Z1', 'Z2']))).out.verification.wrapReady, false)
})
test('thirty unique answers with an invented ID cannot hide a missing catalog item', async () => {
  assert.equal((await run(true, response([...ids.slice(0, 29), 'Z31']))).out.verification.wrapReady, false)
})
test('duplicate and incomplete answers remain rejected', async () => {
  assert.equal((await run(true, response([...ids.slice(0, 29), 'Z1']))).out.verification.wrapReady, false)
  assert.equal((await run(true, response(ids.slice(0, 29), 30))).out.verification.wrapReady, false)
})
test('missing or failed release checks remain rejected', async () => {
  assert.equal((await run(true, null)).out.verification.wrapReady, false)
  const fail = response(); fail.goldenTraces[0].verdict = 'fail'; fail.goldenTraces[0].lane = 'slackmaster'
  assert.equal((await run(true, fail)).out.verification.wrapReady, false)
})
