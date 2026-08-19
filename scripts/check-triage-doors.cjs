#!/usr/bin/env node
/**
 * check-triage-doors — the A10 fixture for bugger.js's two triage mechanisms
 * added 2026-08-16 under the "fourth kind" (architect.md A4, 2026-08-16 ruling):
 *
 *   1. A REGRESSION reinstatement — an `alreadyBuilt` match whose identity is
 *      marked [REGRESSION] by `ledger-stats --index` (surfaced on the shape by
 *      `--already-built --json`'s `regression` field) is reinstated as a fresh
 *      issue instead of silently dropped, at every door it can be matched at:
 *      the editor's own triage (`droppedAsAlreadyBuilt`) and the preset door.
 *   2. The PRESET/PASTE DOOR SCREEN — `args.issues` used to skip the
 *      `alreadyBuilt`/`openKnown` check entirely (only `state.pendingOverflow`
 *      was checked), so a raw paste and an owner-approved report row —
 *      structurally identical on arrival — both could re-dispatch an
 *      already-fixed symptom. Now screened the same way the queue already was.
 *
 * A10: both halves are required — FIRES on the bad input, STAYS SILENT on the
 * good one. Every section below states which half it is.
 *
 * HOW IT RUNS THE ENGINE — same method as check-design-door.cjs (X182's own
 * comment explains why: `bugger.js` is not a module, the Workflow tool compiles
 * it as an async function BODY with `args`/`agent`/`parallel`/`log`/`phase` in
 * scope). Compiled here directly rather than importing that file's internals,
 * since nothing there is exported — duplicating the ~15-line compile step is
 * cheaper and clearer than reaching into an unrelated, differently-scoped
 * fixture file (that one is named and organised around the framer's design
 * door; these two mechanisms are bugger.js-only and share nothing with it).
 *
 * Usage:  node scripts/check-triage-doors.cjs
 * Exit 0  every assertion holds, in both directions.
 * Exit 1  at least one failed — the message names which and what it saw.
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const ENGINE = path.join(ROOT, '.claude', 'workflows', 'bugger.js')

let failed = 0
let passed = 0
const ok = (name, cond, saw) => {
  if (cond) {
    passed += 1
    console.log(`  ok    ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${saw === undefined ? '' : `\n        saw: ${typeof saw === 'string' ? saw.slice(0, 500) : JSON.stringify(saw).slice(0, 500)}`}`)
  }
}
const section = (s) => console.log(`\n${s}`)

// ── the engine harness — vm.compileFunction, same method A10 mandates ───────
const blank = (m) => ' '.repeat(m.length)
const neutralise = (src) =>
  src
    .replace(/^#!.*/, blank)
    .replace(/^export default /gm, blank)
    .replace(/^export (?=(?:const|let|var|function|async|class)\b)/gm, blank)
const SRC = fs.readFileSync(ENGINE, 'utf8')
const compiled = vm.compileFunction(`return (async () => {${neutralise(SRC)}\n})()`, ['args', 'agent', 'parallel', 'log', 'phase'], { filename: ENGINE })

const run = async (args, canned) => {
  const calls = []
  const logs = []
  const phases = []
  const agent = async (prompt, opts) => {
    calls.push({ label: (opts && opts.label) || '(no label)', prompt, opts: opts || {} })
    const key = Object.keys(canned).find((k) => (opts && opts.label) === k) || Object.keys(canned).find((k) => String((opts && opts.label) || '').startsWith(k))
    return key ? canned[key] : null
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  try {
    const out = await compiled(args, agent, parallel, (m) => logs.push(String(m)), (p) => phases.push(p))
    return { out, err: null, calls, logs, phases }
  } catch (e) {
    return { out: null, err: e, calls, logs, phases }
  }
}
const promptOf = (calls, label) => (calls.find((c) => c.label === label || c.label.startsWith(label)) || {}).prompt || ''

const main = async () => {
  // ════════════════════════════════════════════════════════════════════════
  section('1 · EDITOR TRIAGE — a REGRESSION match is reinstated, not dropped  (fires on the bad input)')
  // ════════════════════════════════════════════════════════════════════════
  const REGRESSED_ENTRY = { ref: 'gh#900', symptom: 'the regressed symptom', rootCause: 'src/skills/meetings.ts:100', invariant: 'regressed-rule', state: 'built', lane: 'matchmaker', regression: true }
  const SETTLED_ENTRY = { ref: 'gh#910', symptom: 'the settled symptom', rootCause: 'scripts/foo.cjs:10', invariant: 'settled-rule', state: 'built', lane: 'handyman', regression: false }

  const editorDroppedBoth = { issues: [], droppedAsAlreadyBuilt: ['gh#900', 'gh#910'], findingsSeen: 2 }
  const regressed = await run(
    { sources: ['github'], alreadyBuilt: [REGRESSED_ENTRY, SETTLED_ENTRY], verify: false },
    { editor: editorDroppedBoth, 'matchmaker(1)': { results: [{ id: 'gh#900>regression', verdict: 'built', filesTouched: ['src/skills/meetings.ts'] }] } },
  )
  ok('no throw', !regressed.err, regressed.err && regressed.err.message)
  ok('a matchmaker dispatch fired for the reinstated issue', regressed.calls.some((c) => c.label === 'matchmaker(1)'), regressed.calls.map((c) => c.label))
  ok('the dispatch prompt carries the reinstated id', /gh#900>regression/.test(promptOf(regressed.calls, 'matchmaker(1)')), promptOf(regressed.calls, 'matchmaker(1)').slice(0, 400))
  ok('the dispatch prompt reframes it as WHY-did-the-fix-not-hold, not what-is-the-root-cause', /WHY it did not hold/.test(promptOf(regressed.calls, 'matchmaker(1)')), promptOf(regressed.calls, 'matchmaker(1)').slice(0, 600))
  ok('the prior rootCause travels forward', /src\/skills\/meetings\.ts:100/.test(promptOf(regressed.calls, 'matchmaker(1)')))
  ok('the REGRESSION_NOTE fired (source:"regression" is present)', /source: "regression"/.test(promptOf(regressed.calls, 'matchmaker(1)')))
  ok('the reinstated issue reached `built`', regressed.out && regressed.out.results.some((r) => r.id === 'gh#900>regression' && r.verdict === 'built'), regressed.out && regressed.out.results)
  ok('the engine log names the reinstatement', regressed.logs.some((l) => /Regression: 1 `alreadyBuilt` match/.test(l)), regressed.logs)

  // ════════════════════════════════════════════════════════════════════════
  section('2 · EDITOR TRIAGE — a SETTLED match stays dropped, exactly as before  (silent on the good input)')
  // ════════════════════════════════════════════════════════════════════════
  ok('NO dispatch was raised for the settled ref (no handyman(1) call)', !regressed.calls.some((c) => c.label === 'handyman(1)'), regressed.calls.map((c) => c.label))
  ok('the settled ref never appears in the final results', regressed.out && !regressed.out.results.some((r) => String(r.id).includes('gh#910')), regressed.out && regressed.out.results)
  // A run with NO regression-flagged entries behaves identically to before this change existed.
  const onlySettled = await run({ sources: ['github'], alreadyBuilt: [SETTLED_ENTRY], verify: false }, { editor: { issues: [], droppedAsAlreadyBuilt: ['gh#910'], findingsSeen: 1 } })
  ok('no throw', !onlySettled.err, onlySettled.err && onlySettled.err.message)
  ok('no lane dispatch at all — nothing to build', !onlySettled.calls.some((c) => c.opts && (c.opts.phase === 'Build' || c.opts.phase === 'Context')), onlySettled.calls.map((c) => c.label))
  ok('no Regression log line fires when nothing is flagged', !onlySettled.logs.some((l) => /^Regression:/.test(l)), onlySettled.logs)

  // ════════════════════════════════════════════════════════════════════════
  section('3 · PRESET DOOR — a raw paste matching `alreadyBuilt` is DROPPED, not dispatched  (fires on the bad input)')
  // ════════════════════════════════════════════════════════════════════════
  const rawPasteSettled = { id: 'gh#910', lane: 'handyman', severity: 'medium', clarity: 'clear', symptom: 'the settled symptom, pasted directly' }
  const presetSettled = await run({ issues: [rawPasteSettled], alreadyBuilt: [SETTLED_ENTRY], verify: false }, {})
  ok('no throw', !presetSettled.err, presetSettled.err && presetSettled.err.message)
  ok('NO dispatch reached handyman — the match was screened before it could burn a turn', !presetSettled.calls.some((c) => c.opts && c.opts.phase === 'Build'), presetSettled.calls.map((c) => c.label))
  ok('a warning names the dropped preset item', presetSettled.out && presetSettled.out.warnings && presetSettled.out.warnings.some((w) => /preset item.*alreadyBuilt.*DROPPED/.test(w) && w.includes('gh#910')), presetSettled.out && presetSettled.out.warnings)

  section('4 · PRESET DOOR — an UNMATCHED raw paste dispatches exactly as before  (silent on the good input)')
  const rawPasteNew = { id: 'gh#999', lane: 'handyman', severity: 'medium', clarity: 'clear', symptom: 'a brand-new symptom nobody has seen' }
  const presetClean = await run({ issues: [rawPasteNew], alreadyBuilt: [SETTLED_ENTRY], verify: false }, { 'handyman(1)': { results: [{ id: 'gh#999', verdict: 'built', filesTouched: ['scripts/x.cjs'] }] } })
  ok('no throw', !presetClean.err, presetClean.err && presetClean.err.message)
  ok('the dispatch fired normally', presetClean.calls.some((c) => c.label === 'handyman(1)'), presetClean.calls.map((c) => c.label))
  ok('NO alreadyBuilt warning on a genuinely new preset item', !(presetClean.out && presetClean.out.warnings && presetClean.out.warnings.some((w) => /preset item.*alreadyBuilt/.test(w))), presetClean.out && presetClean.out.warnings)
  ok('the prompt was NOT touched by the regression note', !/source: "regression"/.test(promptOf(presetClean.calls, 'handyman(1)')))

  section('5 · PRESET DOOR — a REGRESSION match is kept and reframed, never dropped  (fires on the bad input, in the other direction)')
  const rawPasteRegressed = { id: 'gh#900', lane: 'matchmaker', severity: 'high', clarity: 'clear', symptom: 'the regressed symptom, pasted directly' }
  const presetRegression = await run(
    { issues: [rawPasteRegressed], alreadyBuilt: [REGRESSED_ENTRY], verify: false },
    { 'matchmaker(1)': { results: [{ id: 'gh#900', verdict: 'built', filesTouched: ['src/skills/meetings.ts'] }] } },
  )
  ok('no throw', !presetRegression.err, presetRegression.err && presetRegression.err.message)
  ok('the dispatch FIRED — a regression match is never silently dropped', presetRegression.calls.some((c) => c.label === 'matchmaker(1)'), presetRegression.calls.map((c) => c.label))
  ok('the prompt carries the regression framing on the pasted item itself', /REGRESSION — matches alreadyBuilt ref gh#900/.test(promptOf(presetRegression.calls, 'matchmaker(1)')), promptOf(presetRegression.calls, 'matchmaker(1)').slice(0, 500))
  ok('no DROP warning was raised for it', !(presetRegression.out && presetRegression.out.warnings && presetRegression.out.warnings.some((w) => /DROPPED/.test(w) && w.includes('gh#900'))), presetRegression.out && presetRegression.out.warnings)
  ok('a log line names it kept, reframed', presetRegression.logs.some((l) => /Preset: 1 item\(s\) match an `alreadyBuilt` ref flagged \[REGRESSION\]/.test(l)), presetRegression.logs)

  section("6 · PRESET DOOR — a match on `openKnown` (parked) is KEPT, never dropped, but NAMED  (his own act overrides a decline)")
  const rawPasteDeclined = { id: 'gh#800', lane: 'gatekeeper', severity: 'medium', clarity: 'clear', symptom: 'he is asking for this again, directly' }
  const presetParked = await run(
    { issues: [rawPasteDeclined], openKnown: [{ ref: 'gh#800', symptom: 'declined before', state: 'declined' }], verify: false },
    { 'gatekeeper(1)': { results: [{ id: 'gh#800', verdict: 'built', filesTouched: ['src/connections/gatekeeper.ts'] }] } },
  )
  ok('no throw', !presetParked.err, presetParked.err && presetParked.err.message)
  ok('the dispatch STILL fired — naming it directly overrides the decline', presetParked.calls.some((c) => c.label === 'gatekeeper(1)'), presetParked.calls.map((c) => c.label))
  ok('a warning NAMES the override, distinct from a drop', presetParked.out && presetParked.out.warnings && presetParked.out.warnings.some((w) => /openKnown.*KEPT, not dropped/.test(w) && w.includes('gh#800')), presetParked.out && presetParked.out.warnings)

  console.log(`\n${passed} ok, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main()
