#!/usr/bin/env node
/**
 * check-design-door — the fixture for the framer's DESIGN door.
 *
 * A13: a change that alters behaviour ships with a BEFORE/AFTER proof, and BOTH
 * halves are required — it must FIRE ON THE BAD INPUT and STAY SILENT ON THE GOOD
 * ONE. A check that goes off on the healthy path is the one mistake this framework
 * is written against, so every assertion below is stated in both directions.
 *
 * The bouncer is the wrong instrument for this and the cleaner is detect-only on
 * `.claude/`: a framework edit fails by DOING NOTHING while reporting success, and
 * neither holds a rule for that. This file is that gap closed.
 *
 * HOW IT RUNS THE ENGINE. `feature.js` is not a module — the Workflow tool
 * compiles it as an async function BODY with `args`, `agent`, `parallel`, `log`
 * and `phase` in scope, which is why top-level `return` and `export const meta`
 * coexist in it and no standard parser accepts the pair. So this compiles it the
 * SAME way (`vm.compileFunction`, the method `check-syntax.cjs` proved is the only
 * honest one) and drives it with stubbed dispatches. No agent is spawned, no token
 * is spent, and the assertions are about what the engine DID with what came back.
 *
 * Usage:  node scripts/check-design-door.cjs
 * Exit 0  every assertion holds, in both directions.
 * Exit 1  at least one failed — the message names which and what it saw.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ENGINE = path.join(ROOT, '.claude', 'workflows', 'feature.js')
const CLUSTERER = path.join(__dirname, 'design-cluster.cjs')
const LEDGER = path.join(ROOT, '.claude', 'agent-loop', 'ledger.jsonl')
const STATS = path.join(__dirname, 'ledger-stats.cjs')
// X172 · the phantom-candidate file matcher, required directly rather than
// re-implemented — `ledger-stats.cjs` stops before touching argv/the ledger
// when `require.main !== module`, so this is the one live function, not a copy.
const { citesReleaseFile } = require(STATS)

let failed = 0
let passed = 0
const ok = (name, cond, saw) => {
  if (cond) {
    passed += 1
    console.log(`  ok    ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${saw === undefined ? '' : `\n        saw: ${typeof saw === 'string' ? saw.slice(0, 400) : JSON.stringify(saw).slice(0, 400)}`}`)
  }
}
const section = (s) => console.log(`\n${s}`)

// ── the engine harness ──────────────────────────────────────────────────────
const blank = (m) => ' '.repeat(m.length)
const neutralise = (src) =>
  src
    .replace(/^#!.*/, blank)
    .replace(/^export default /gm, blank)
    .replace(/^export (?=(?:const|let|var|function|async|class)\b)/gm, blank)
const SRC = fs.readFileSync(ENGINE, 'utf8')
const compiled = vm.compileFunction(`return (async () => {${neutralise(SRC)}\n})()`, ['args', 'agent', 'parallel', 'log', 'phase'], { filename: ENGINE })

// X182 · the SECOND engine, compiled the same way, for the outcome-trace
// mechanism's bugger.js half. This file started as "the fixture for the
// framer's DESIGN door" and has since grown to cover the whole build engine's
// mechanics shared by both (the bounce round, the owner gate) — a second
// harness FILE for one mechanism both engines carry is the two-copies-drift
// failure A9 exists to prevent, so it lives here instead.
const ENGINE_BUGGER = path.join(ROOT, '.claude', 'workflows', 'bugger.js')
const SRC_BUGGER = fs.readFileSync(ENGINE_BUGGER, 'utf8')
const compiledBugger = vm.compileFunction(`return (async () => {${neutralise(SRC_BUGGER)}\n})()`, ['args', 'agent', 'parallel', 'log', 'phase'], { filename: ENGINE_BUGGER })

/** Run a compiled engine with canned dispatch results. Returns {out, err, calls, logs}. */
const makeRunner = (compiledFn) => async (args, canned) => {
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
    const out = await compiledFn(args, agent, parallel, (m) => logs.push(String(m)), (p) => phases.push(p))
    return { out, err: null, calls, logs, phases }
  } catch (e) {
    return { out: null, err: e, calls, logs, phases }
  }
}
const run = makeRunner(compiled)
const runBugger = makeRunner(compiledBugger)
const called = (calls, label) => calls.filter((c) => c.label === label || c.label.startsWith(label))
const promptOf = (calls, label) => (called(calls, label)[0] || {}).prompt || ''
// X151-fix (X159) · PHASE, never a label prefix, for "did a dispatch of THIS
// KIND happen at all" — a label is a display string with no contract behind
// it (X151 just proved that by renaming every one), `opts.phase` is the one
// thing the engine and this fixture cannot disagree about without a real
// dispatch mistake. Exact labels stay below ONLY where a SPECIFIC dispatch's
// identity matters (which lane, the repair call vs the main one) and every
// such label is now a value the real engine can actually produce.
const calledPhase = (calls, phase) => calls.filter((c) => c.opts && c.opts.phase === phase)
const promptOfPhase = (calls, phase) => (calledPhase(calls, phase)[0] || {}).prompt || ''
// X177 · Intake folded into Recon — the item-listing dispatch (`framer:backlog`)
// now ALSO carries phase:'Recon', so counting or reading by phase alone can no
// longer tell the listing call apart from the per-item UNDERSTOOD dispatch.
// Exclude it by label, the one thing that still distinguishes them.
const reconOnly = (calls) => calledPhase(calls, 'Recon').filter((c) => c.label !== 'framer:backlog')
const promptOfRecon = (calls) => (reconOnly(calls)[0] || {}).prompt || ''

// ── canned dispatch results ─────────────────────────────────────────────────
const INTAKE = { items: [{ ref: '#154', title: 'Owner authority across chat surfaces', priority: 'High', asks: 'decide which surfaces clamp the owner and what the clamp governs' }] }
const RECON = {
  ref: '#154',
  todayBehaviour: 'processMessage.ts:139 clamps the owner on three surfaces',
  wantedBehaviour: 'the clamp governs visibility, not authority',
  gap: 'one seam, five lanes patched around it',
  alreadyExists: false,
  openQuestions: ['does a clamped channel turn get scoped person data?'],
  surfaces: ['MPIM', 'channel'],
  options: [
    { route: 'one authority resolver every surface reads', cost: 'slackmaster + gatekeeper, ~120 lines', why: 'the only route that closes all nine' },
    { route: 'per-surface flag on SkillContext', cost: 'three lanes, plumbing', why: 'rejected: a surface added later misses it' },
  ],
  recommendation: 'the resolver — the per-surface flag is what produced nine refs',
}
const GOOD_PIECE = {
  id: 'p1',
  ref: '#154',
  lane: 'slackmaster',
  requirement: 'the owner keeps his authority wherever he types',
  whatChanges: 'src/connectors/slack/app/processMessage.ts:139 — the clamp seam moves behind a resolver; reuses grantRelaxed at ops.ts:88',
  connection: 'called by buildTurnContext; must not bypass the gatekeeper output gate',
  expectation: 'every surface can read one authority verdict; nobody re-derives senderRole',
  whyThisLane: 'owns Slack end to end',
  dependsOn: [],
  productDecision: 'the clamp governs visibility only',
  risk: 'a surface added later must call the resolver',
}
const GOOD_PLAN = { pieces: [GOOD_PIECE], sharedPiece: 'slackmaster — src/connections/types.ts', blockingQuestions: ['scoped person data on a clamped channel turn?'], notWorthBuilding: [] }
const BAD_PLAN = { pieces: [{ ...GOOD_PIECE, connection: '   ', expectation: '' }], sharedPiece: '', blockingQuestions: [], notWorthBuilding: [] }
const REPAIRED = { pieces: [{ id: 'p1', connection: GOOD_PIECE.connection, expectation: GOOD_PIECE.expectation }], sharedPiece: 'slackmaster — src/connections/types.ts', blockingQuestions: [] }
const STILL_BAD = { pieces: [{ id: 'p1', connection: '', expectation: '' }], sharedPiece: '', blockingQuestions: [] }
// BUILD 1 + BUILD 2 · the decompose-check canned responses. `GOOD_REACHABLE` is
// what a clean plan gets back — reachable, no pattern — and is folded into every
// `GOOD`-keyed run below so the new dispatch behaves exactly like the rest of a
// healthy wave rather than relying on the harness's null-fallback.
const GOOD_REACHABLE = { reachability: [{ id: 'p1', reachable: true, blockingGate: '' }], census: [] }
const BAD_REACHABLE = { reachability: [{ id: 'p1', reachable: false, blockingGate: 'src/connectors/slack/app/createMeeting.ts:462' }], census: [] }
// X151-fix (X159) · exact keys, matching the real labels feature.js emits
// today: `framer:backlog`, `framer:<ref>`, bare `framer` for decompose,
// `framer:contract` for the repair round, and a bare lane name for a build
// dispatch. `framer` is a PREFIX of the other three `framer:...` labels, so
// this only works because `run()`'s matcher checks every key for an EXACT
// match before it ever tries `startsWith` — every label the engine can
// produce has its own exact entry here, so that fallback is never reached.
const GOOD = { 'framer:backlog': INTAKE, 'framer:#154': RECON, framer: GOOD_PLAN, 'framer:decomposeCheck': GOOD_REACHABLE }

// The real cluster, from the real script, against the real ledger. Deriving it
// here instead would be a second definition of the clustering rule.
const CLUSTER_ARGS = JSON.parse(execFileSync(process.execPath, [CLUSTERER, 'gh#154', '--json'], { encoding: 'utf8' }))
// N is DERIVED, never literal. gh#154 held 9 refs from 5 lanes when this was
// written and a tenth conversion onto it is a legitimate act — a fixture that
// red-lines on one would be a check firing on the healthy path, which is the
// mistake A13 exists to prevent. The floor is asserted, the exact count is not.
const N = CLUSTER_ARGS.cluster.refs.length
const LANES = CLUSTER_ARGS.cluster.lanes.length

const main = async () => {
  section(`1 · A ${N}-REF CLUSTER PRODUCES ONE ITEM  (the design door)`)
  const d = await run({ ...CLUSTER_ARGS }, GOOD)
  ok('no throw', !d.err, d.err && d.err.message)
  ok(`gh#154 still holds at least 9 refs from at least 5 lanes (found ${N} from ${LANES})`, N >= 9 && LANES >= 5, { refs: N, lanes: LANES })
  ok(`ONE recon dispatch, not ${N}`, reconOnly(d.calls).length === 1, d.calls.map((c) => c.label))
  ok('ONE item in the return', d.out && d.out.items && d.out.items.length === 1, d.out && d.out.items)
  ok(`all ${N} refs reached the recon prompt`, CLUSTER_ARGS.cluster.refs.every((r) => promptOfRecon(d.calls).includes(r.ref)), promptOfRecon(d.calls).length)
  ok('recon was told not to patch per row', /Do NOT design a patch per row/.test(promptOfRecon(d.calls)))
  ok('design block records what it absorbed', d.out && d.out.design && d.out.design.absorbs.length === N, d.out && d.out.design)
  ok('the join-back command is on the return', d.out && d.out.design && /design-cluster\.cjs gh#154 --decide/.test(d.out.design.joinBack), d.out && d.out.design && d.out.design.joinBack)

  section('2 · A `refs:` INVOCATION IS UNCHANGED  (silent on the good path)')
  const r = await run({ mode: 'plan', refs: ['#154'] }, GOOD)
  ok('no throw', !r.err, r.err && r.err.message)
  ok('the intake prompt is BYTE-IDENTICAL to the design run', promptOf(r.calls, 'framer:backlog') === promptOf(d.calls, 'framer:backlog'))
  ok('the intake dispatch options are identical', JSON.stringify(r.calls[0].opts) === JSON.stringify(d.calls[0].opts), r.calls[0].opts)
  ok('NO cluster block in the recon prompt', !/BUG ROWS ARE WAITING/.test(promptOfRecon(r.calls)))
  ok('`design` is null', r.out && r.out.design === null, r.out && r.out.design)
  ok('same dispatch count as the design run', r.calls.length === d.calls.length, { refs: r.calls.length, design: d.calls.length })

  section('3 · A PLAN PASS FILES NOTHING AND BUILDS NOTHING')
  ok('no dispatch mentions `gh issue create`', !d.calls.some((c) => /gh issue create/.test(c.prompt)))
  // X151-fix (X159) · PHASE, not the label prefix — a label is display text
  // (X151 renamed every one of these to a bare lane name), `opts.phase` is
  // the actual claim "no lane build/context/verify dispatch happened here".
  ok('no build dispatch', !d.calls.some((c) => c.opts && (c.opts.phase === 'Build' || c.opts.phase === 'Context')), d.calls.map((c) => `${c.label}[${c.opts && c.opts.phase}]`))
  ok('no verify dispatch', !d.calls.some((c) => c.opts && c.opts.phase === 'Verify'), d.calls.map((c) => `${c.label}[${c.opts && c.opts.phase}]`))
  ok('mode is plan', d.out && d.out.mode === 'plan')
  ok('needsTicket is EMPTY on the design path (the ticket exists)', d.out && Array.isArray(d.out.needsTicket) && d.out.needsTicket.length === 0, d.out && d.out.needsTicket)
  ok('the return says nothing is filed here', d.out && /IS ALREADY FILED, so nothing is filed here/.test(d.out.next))

  section('4 · THE TWO NEW FIELDS ARE REQUIRED  (fires on the bad input)')
  const bad = await run({ mode: 'plan', refs: ['#154'] }, { ...GOOD, framer: BAD_PLAN, 'framer:contract': REPAIRED })
  ok('the repair round FIRED', called(bad.calls, 'framer:contract').length === 1, bad.calls.map((c) => c.label))
  ok('the repair was sent only the incomplete piece', /"id": "p1"/.test(promptOf(bad.calls, 'framer:contract')))
  ok('blank fields were named to the repair', /BLANK FIELDS/.test(promptOf(bad.calls, 'framer:contract')))
  ok('the blank connection was filled', bad.out && bad.out.pieces[0].connection === GOOD_PIECE.connection, bad.out && bad.out.pieces[0].connection)
  ok('the blank expectation was filled', bad.out && bad.out.pieces[0].expectation === GOOD_PIECE.expectation, bad.out && bad.out.pieces[0].expectation)
  ok('the blank sharedPiece was filled', bad.out && bad.out.sharedPiece === GOOD_PLAN.sharedPiece, bad.out && bad.out.sharedPiece)
  ok('contract reports 0 blank, 1 repaired', bad.out && bad.out.contract.blank === 0 && bad.out.contract.repaired === 1, bad.out && bad.out.contract)
  ok('the loud log line fired', bad.logs.some((l) => /Contract incomplete/.test(l)), bad.logs)

  section('4b · A REPAIR THAT DOES NOT FIX IT STOPS THE PLAN')
  const worse = await run({ mode: 'plan', refs: ['#154'] }, { ...GOOD, framer: BAD_PLAN, 'framer:contract': STILL_BAD })
  ok('contract reports the surviving gap', worse.out && worse.out.contract.blank === 1, worse.out && worse.out.contract)
  ok('`next` opens with STOP', worse.out && /^STOP:/.test(worse.out.next), worse.out && worse.out.next.slice(0, 60))
  ok('the still-incomplete log fired', worse.logs.some((l) => /CONTRACT STILL INCOMPLETE/.test(l)), worse.logs)
  ok('sharedPiece blank is reported, not hidden', worse.out && worse.out.contract.sharedPiece === '(BLANK)', worse.out && worse.out.contract)

  section('5 · A COMPLETE CONTRACT COSTS NOTHING EXTRA  (silent on the good input)')
  ok('NO repair dispatch on a complete plan', called(d.calls, 'framer:contract').length === 0, d.calls.map((c) => c.label))
  ok('contract reports 0 blank, 0 repaired', d.out && d.out.contract.blank === 0 && d.out.contract.repaired === 0, d.out && d.out.contract)
  ok('sharedPiece reaches the return as its own field', d.out && d.out.sharedPiece === GOOD_PLAN.sharedPiece, d.out && d.out.sharedPiece)
  ok('`next` does NOT open with STOP', d.out && !/^STOP:/.test(d.out.next))

  section('6 · THE CONTRACT REACHES THE BUILDER  (or the fields are decoration)')
  const b = await run({ mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece, verify: false }, { slackmaster: { results: [{ id: 'p1', verdict: 'built' }] } })
  ok('no throw', !b.err, b.err && b.err.message)
  ok('the SEAM is in the build prompt', /WHAT IT MUST NOT BYPASS: called by buildTurnContext/.test(promptOf(b.calls, 'slackmaster')), promptOf(b.calls, 'slackmaster').slice(0, 200))
  ok('the EXPECTATION is in the build prompt', /ENTITLED TO ASSUME OF THIS ONE ONCE IT LANDS: every surface/.test(promptOf(b.calls, 'slackmaster')))
  ok('the contract is stated as binding', /those are the contract and they are binding/i.test(promptOf(b.calls, 'slackmaster')))
  ok('sharedPiece is named to the lane', /WHO WRITES THE SHARED CODE: slackmaster/.test(promptOf(b.calls, 'slackmaster')))
  // X168/X177 · a single, ordinary dispatch is silent on the good path: the
  // count is there, no `dep:`/`owner:` prefix is.
  ok('the label carries its item count and no prefix', b.calls.some((c) => c.label === 'slackmaster(1)'), b.calls.map((c) => c.label))
  const b2 = await run({ mode: 'build', pieces: [GOOD_PIECE], sharedPiece: 'none', verify: false }, { slackmaster: { results: [{ id: 'p1', verdict: 'built' }] } })
  ok('`none` adds no shared-code line', !/WHO WRITES THE SHARED CODE/.test(promptOf(b2.calls, 'slackmaster')))

  section('7 · needsTicket CARRIES THE FINISHED BODY, NOT THE ASK')
  const desc = await run(
    { mode: 'plan', items: [{ title: 'Owner authority across chat surfaces', asks: 'decide what the clamp governs', priority: 'High' }] },
    { 'framer:new-1': { ...RECON, ref: 'new-1' }, framer: { ...GOOD_PLAN, pieces: [{ ...GOOD_PIECE, ref: 'new-1' }] } },
  )
  ok('no throw', !desc.err, desc.err && desc.err.message)
  ok('no intake dispatch on a described item', called(desc.calls, 'framer:backlog').length === 0, desc.calls.map((c) => c.label))
  ok('ONE ticket, not one per ref', desc.out && desc.out.needsTicket.length === 1, desc.out && desc.out.needsTicket.length)
  const body = desc.out && desc.out.needsTicket[0] ? desc.out.needsTicket[0].body : ''
  for (const [what, re] of [
    ['his words', /\*\*His words:\*\* decide what the clamp governs/],
    ['what breaks today', /## What breaks today\nprocessMessage\.ts:139/],
    ['the options WITH costs', /1\. \*\*one authority resolver every surface reads\*\* — slackmaster \+ gatekeeper/],
    ['the recommendation', /## Recommendation\nthe resolver/],
    ['the contract, per piece', /- connection: called by buildTurnContext/],
    ['the expectation', /- expectation: every surface can read/],
    ['who writes the shared code', /\*\*Who writes the shared code:\*\* slackmaster — src\/connections\/types\.ts/],
    ['what to settle first', /## Settle before building/],
  ])
    ok(`body carries ${what}`, re.test(body), body)
  ok('labels are Improvement + High', desc.out && JSON.stringify(desc.out.needsTicket[0].labels) === '["Improvement","High"]', desc.out && desc.out.needsTicket[0].labels)
  ok('the caller is told to use the body VERBATIM', desc.out && /VERBATIM — it is the finished ticket, not ingredients/.test(desc.out.next), desc.out && desc.out.next.slice(0, 300))
  ok('still nothing filed', !desc.calls.some((c) => /gh issue create/.test(c.prompt)))
  const noPri = await run({ mode: 'plan', items: [{ title: 't', asks: 'a' }] }, { 'framer:new-1': { ...RECON, ref: 'new-1' }, framer: { ...GOOD_PLAN, pieces: [] } })
  ok('an unlabelled item gets Improvement and NO invented priority', noPri.out && JSON.stringify(noPri.out.needsTicket[0].labels) === '["Improvement"]', noPri.out && noPri.out.needsTicket[0].labels)
  ok('and it is NAMED as needing one', noPri.out && noPri.out.needsPriority.length === 1, noPri.out && noPri.out.needsPriority)
  const feat = await run({ mode: 'plan', items: [{ title: 't', asks: 'a', priority: 'Next' }] }, { 'framer:new-1': { ...RECON, ref: 'new-1' }, framer: { ...GOOD_PLAN, pieces: [] } })
  ok('a Feature-axis word takes the Feature track', feat.out && JSON.stringify(feat.out.needsTicket[0].labels) === '["Feature","Next"]', feat.out && feat.out.needsTicket[0].labels)

  section('8 · THE SHAPE GUARDS REFUSE, AND ONLY ON A WRONG SHAPE')
  const guards = [
    ['design + sweep', { mode: 'plan', design: 'gh#154', sweep: true }, /ONE design item by definition/],
    ['design + items', { mode: 'plan', design: 'gh#154', items: [{ title: 't', asks: 'a' }] }, /Pass one or the other, never both/],
    ['a cluster keyed on another issue', { mode: 'plan', design: 'gh#154', cluster: { ref: 'gh#155', refs: [] } }, /another item's history/],
    ['refs that exclude the design', { mode: 'plan', design: 'gh#154', refs: ['#160'] }, /does not include args.design/],
    ['a design ref that is not a number', { mode: 'plan', design: 'the permission thing' }, /not a GitHub issue number/],
    ['a cluster passed as an array', { mode: 'plan', design: 'gh#154', cluster: [] }, /not object/],
  ]
  for (const [name, args, re] of guards) {
    const g = await run(args, GOOD)
    ok(`refuses ${name}`, !!g.err && re.test(g.err.message), g.err ? g.err.message : '(no throw)')
    ok(`  …and dispatched nothing`, g.calls.length === 0, g.calls.map((c) => c.label))
  }
  const twoItems = await run(
    { mode: 'plan', design: 'gh#154' },
    { 'framer:backlog': { items: [INTAKE.items[0], { ref: '#155', title: 'other', priority: 'Low', asks: 'x' }] }, 'framer:#154': RECON, framer: GOOD_PLAN },
  )
  ok('refuses a design run that intake fanned out to two items', !!twoItems.err && /one design item, and intake returned 2/.test(twoItems.err.message), twoItems.err && twoItems.err.message)
  ok('  …before any recon', reconOnly(twoItems.calls).length === 0, twoItems.calls.map((c) => c.label))
  const bare = await run({ mode: 'plan', design: 'gh#154' }, GOOD)
  ok('a design run with NO cluster is allowed (a first-time design item)', !bare.err && bare.out.design.absorbs.length === 0, bare.err ? bare.err.message : bare.out.design)
  ok('  …and says the cluster was not passed', bare.logs.some((l) => /No cluster passed/.test(l)), bare.logs)

  section('9 · THE JOIN-BACK — against a COPY of the ledger, never the live one')
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'design-door-')), 'ledger.jsonl')
  // STRIP any join-back gh#154 ALREADY carries in the LIVE ledger before copying.
  // This section tests the WRITE path itself and must stay provable even after
  // the real wave is decided for real — which it now is, dated 2026-08-05. Without
  // this the fixture depends on gh#154 staying forever undecided in production, and
  // it silently goes stale the day he actually rules on it: a checker whose
  // correctness depends on a SINGLE production ref never reaching its natural next
  // state is exactly the "reads live ledger state, cannot tell the code broke from
  // the world moving" fragility this file's own docstring warns a framework
  // checker against. Any OTHER `converted`/`gh#154` row is kept — only the rows
  // that already carry the join-back mark are dropped, so the copy reflects
  // "converted, not yet decided" regardless of what the live ledger has since done.
  const DECIDED_MARK = 'DESIGN SETTLED for gh#154'
  const undecidedLines = fs
    .readFileSync(LEDGER, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((l) => {
      try {
        return !String(JSON.parse(l).note || '').includes(DECIDED_MARK)
      } catch {
        return true
      }
    })
  fs.writeFileSync(tmp, undecidedLines.join('\n') + '\n')
  const before = undecidedLines.length
  const out1 = execFileSync(process.execPath, [CLUSTERER, 'gh#154', '--decide', 'one authority resolver', '--ledger', tmp], { encoding: 'utf8' })
  const rowsAfter = fs.readFileSync(tmp, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  const appended = rowsAfter.slice(before)
  ok(`appended exactly one row per ref (${N})`, appended.length === N, appended.length)
  ok('every appended row is still `converted`', appended.every((x) => x.verdict === 'converted'), appended.map((x) => x.verdict))
  ok('every appended row carries the decision as a verb', appended.every((x) => x.recommend === 'build — one authority resolver'), appended.map((x) => x.recommend))
  ok('every appended row still names its destination', appended.every((x) => /gh#154/.test(x.note)))
  ok('the refs match the cluster exactly', JSON.stringify(appended.map((x) => x.ref).sort()) === JSON.stringify(CLUSTER_ARGS.cluster.refs.map((x) => x.ref).sort()))
  ok('it said what it wrote', out1.includes(`Join-back appended — ${N} row(s)`), out1)
  const out2 = execFileSync(process.execPath, [CLUSTERER, 'gh#154', '--decide', 'one authority resolver', '--ledger', tmp], { encoding: 'utf8' })
  ok('a second call appends NOTHING (idempotent)', fs.readFileSync(tmp, 'utf8').split(/\r?\n/).filter(Boolean).length === rowsAfter.length, out2)
  ok('  …and says so', /already carry the join-back/.test(out2), out2)
  const reread = JSON.parse(execFileSync(process.execPath, [CLUSTERER, 'gh#154', '--json', '--ledger', tmp], { encoding: 'utf8' }))
  ok('the cluster still reads N, not 2N (collapse by ref)', reread.cluster.refs.length === N, reread.cluster.refs.length)
  ok('and the re-read now shows the decision', reread.cluster.refs.every((x) => /DESIGN SETTLED/.test(x.note)))
  // An empty `--decide` must EXIT 1 and write nothing: a join-back row that names
  // no design records that a decision happened and not which one, which is the
  // recommendation-shaped-hole this whole mechanism exists to fill.
  const linesBefore = fs.readFileSync(tmp, 'utf8').split(/\r?\n/).filter(Boolean).length
  let emptyRefused = false
  let emptyMsg = ''
  try {
    execFileSync(process.execPath, [CLUSTERER, 'gh#154', '--decide', '', '--ledger', tmp], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    emptyRefused = true
    emptyMsg = String((e && e.stderr) || '')
  }
  ok('an empty --decide EXITS 1', emptyRefused, emptyMsg)
  ok('  …and says why', /records nothing/.test(emptyMsg), emptyMsg)
  ok('  …and wrote nothing', fs.readFileSync(tmp, 'utf8').split(/\r?\n/).filter(Boolean).length === linesBefore)

  section('10 · THE ROWS DO NOT REOPEN — against the LIVE ledger, read-only')
  const openOut = execFileSync(process.execPath, [STATS, '--open'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  // EXACT MATCH ON THE ROW ID, never a substring of the whole output. `--open`
  // deliberately prints every ref it COLLAPSED ("shown so a WRONG collapse is
  // visible"), so a substring search finds all nine there and reads as a leak —
  // and `B157-c` is a prefix of another ledger row's ref, so a loose match is
  // wrong twice. An OPEN row is the one whose ref is bracketed.
  //
  // X168-fix · the label was `[A-Z][A-Z\- ]*?` — letters, hyphens and spaces
  // only — which is every label EXCEPT `DEFERRED`'s, which has printed
  // `DEFERRED <date> · DUE NEXT RUN`/`OVERDUE — N run(s) since` since X23
  // (ledger-stats.cjs:1420, unchanged by this wave). A digit, a `·` or a `(`
  // between the label and the bracket silently dropped that row from the
  // count on ANY ledger whose open set includes a deferral — this was latent
  // until tonight's live ledger happened to carry one. Only the LEADING "2
  // spaces then a non-space" is the real row-header marker (every
  // continuation line — rootCause, recommend, re-read — indents 10 spaces,
  // per ledger-stats.cjs's own `console.log('          ...')` calls), so that
  // is what a row line is; the label text between it and the bracket can be
  // anything. Non-greedy `.*?` takes the FIRST bracket on the line, which is
  // the ref — never a coincidental `[` later in a truncated finding string.
  const openRefs = new Set([...openOut.matchAll(/^ {2}\S.*?\[([^\]]+)\]/gm)].map((m) => m[1]))
  const claimedOpen = Number((openOut.match(/^OPEN — (\d+) row/m) || [])[1] || 0)
  ok(`the reader's own open count and its bracketed rows agree (${openRefs.size} of ${claimedOpen})`, openRefs.size === claimedOpen && claimedOpen > 0, { parsed: openRefs.size, claimed: claimedOpen })
  const leaked = CLUSTER_ARGS.cluster.refs.map((x) => x.ref).filter((ref) => openRefs.has(ref))
  ok(`none of the ${N} absorbed refs is an OPEN row`, leaked.length === 0, leaked)
  ok('`converted` is in the reader\'s CLOSED set', /const CLOSED = new Set\(\[[^\]]*'converted'/.test(fs.readFileSync(STATS, 'utf8')))
  console.log(`        (so a row appended with verdict \`converted\` stays hidden — both halves of the claim)`)

  // ── THE BOUNCE ROUND — build-mode Verify, stolen from bugger.js (X137/X143) ──
  const BUILT_ONCE = {
    results: [{ id: 'p1', verdict: 'built', filesTouched: ['src/connectors/slack/app/processMessage.ts'], traced: 'the resolver call site', notes: 'moved the clamp behind grantRelaxed' }],
  }
  const OVERTURN_ONCE = {
    results: [{ id: 'p1', verdict: 'needs-owner-decision', notes: 'expectation not met — gatekeeper still re-derives senderRole on its own' }],
    discoveries: [],
    ticketCoverage: [],
    verifiedClean: [],
  }
  const REBUILT_OK = {
    results: [{ id: 'p1', verdict: 'built', filesTouched: ['src/connectors/slack/app/processMessage.ts', 'src/connections/gatekeeper.ts'], notes: 'gatekeeper now reads the resolver' }],
  }
  const RECHECK_OK = { results: [{ id: 'p1', verdict: 'built' }], discoveries: [], verifiedClean: [] }

  section('11 · THE BOUNCE ROUND — an unmet `expectation` sends a piece back ONCE  (fires on the bad input)')
  const bounce = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece },
    { slackmaster: BUILT_ONCE, 'bouncer:wave(1)': OVERTURN_ONCE, 'rebuild:slackmaster(1)': REBUILT_OK, 'bouncer:recheck(1)': RECHECK_OK },
  )
  ok('no throw', !bounce.err, bounce.err && bounce.err.message)
  ok('no separate Bounce phase box (X151-parity — it lives inside Verify)', !bounce.phases.includes('Bounce'), bounce.phases)
  // X168 · the rebuild label now carries the count of pieces bounced back —
  // exact match, not startsWith, so a label that DROPPED the count would fail
  // this the same way it would fail the canned-response lookup for real.
  ok('the rebuild dispatch FIRED, under Verify, carrying its count', calledPhase(bounce.calls, 'Verify').some((c) => c.label === 'rebuild:slackmaster(1)'), bounce.calls.map((c) => `${c.label}[${c.opts && c.opts.phase}]`))
  ok('the mandatory re-check FIRED', called(bounce.calls, 'bouncer:recheck(1)').length === 1, bounce.calls.map((c) => c.label))
  ok(
    'no bare lane label appears under Verify (X151-parity)',
    !calledPhase(bounce.calls, 'Verify').some((c) => c.label === 'slackmaster' || c.label === 'instructor'),
    calledPhase(bounce.calls, 'Verify').map((c) => c.label),
  )
  ok('the rebuild payload carries what the bouncer refused', /expectation not met/.test(promptOf(bounce.calls, 'rebuild:slackmaster')), promptOf(bounce.calls, 'rebuild:slackmaster').slice(0, 400))
  ok('the rebuild payload says it cannot be sent back again', /cannot be sent back again/.test(promptOf(bounce.calls, 'rebuild:slackmaster')))
  ok('the piece cleared — final verdict is built', bounce.out && bounce.out.results.find((r) => r.id === 'p1').verdict === 'built', bounce.out && bounce.out.results)
  ok('the row carries its bounce count', bounce.out && bounce.out.results.find((r) => r.id === 'p1').bounces === 1, bounce.out && bounce.out.results)
  ok(
    'manifest.bounce: 1 eligible, 1 bounced, 1 cleared, 0 to owner',
    bounce.out && bounce.out.manifest.bounce.eligible === 1 && bounce.out.manifest.bounce.bounced === 1 && bounce.out.manifest.bounce.cleared === 1 && bounce.out.manifest.bounce.toOwner === 0,
    bounce.out && bounce.out.manifest.bounce,
  )
  ok('manifest.bounce.recheckRan is true', bounce.out && bounce.out.manifest.bounce.recheckRan === true)
  ok('no needsOwner in the final counts', bounce.out && bounce.out.counts.needsOwner === 0, bounce.out && bounce.out.counts)

  section('12 · A CLEAN WAVE NEVER BOUNCES  (silent on the good input)')
  const clean = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece },
    { slackmaster: BUILT_ONCE, 'bouncer:wave(1)': { results: [{ id: 'p1', verdict: 'built' }], discoveries: [], ticketCoverage: [], verifiedClean: ["p1 delivers its own expectation"] } },
  )
  ok('no throw', !clean.err, clean.err && clean.err.message)
  ok('NO rebuild dispatch on a clean wave', !clean.calls.some((c) => String(c.label).startsWith('rebuild:')), clean.calls.map((c) => c.label))
  ok('NO re-check dispatch on a clean wave', !clean.calls.some((c) => String(c.label).startsWith('bouncer:recheck')), clean.calls.map((c) => c.label))
  ok(
    'manifest.bounce: 0 eligible, 0 bounced',
    clean.out && clean.out.manifest.bounce.eligible === 0 && clean.out.manifest.bounce.bounced === 0,
    clean.out && clean.out.manifest.bounce,
  )
  ok('the bounce block is present with explicit zeros, never omitted', clean.out && clean.out.manifest.bounce && typeof clean.out.manifest.bounce.eligible === 'number', clean.out && clean.out.manifest.bounce)

  section("13 · THE BOUNCE LIMIT — a piece already bounced once goes straight to the owner, never a third attempt")
  const atLimit = await run(
    { mode: 'build', pieces: [{ ...GOOD_PIECE, bounces: 1 }], sharedPiece: GOOD_PLAN.sharedPiece },
    { slackmaster: BUILT_ONCE, 'bouncer:wave(1)': OVERTURN_ONCE },
  )
  ok('no throw', !atLimit.err, atLimit.err && atLimit.err.message)
  ok('NO rebuild dispatch — already at the limit', !atLimit.calls.some((c) => String(c.label).startsWith('rebuild:')), atLimit.calls.map((c) => c.label))
  ok('NO re-check dispatch either', !atLimit.calls.some((c) => String(c.label).startsWith('bouncer:recheck')), atLimit.calls.map((c) => c.label))
  ok(
    'manifest.bounce: 1 eligible, 0 bounced, 1 at the limit',
    atLimit.out && atLimit.out.manifest.bounce.eligible === 1 && atLimit.out.manifest.bounce.bounced === 0 && atLimit.out.manifest.bounce.notBouncedAtLimit === 1,
    atLimit.out && atLimit.out.manifest.bounce,
  )
  ok('the piece goes to the owner', atLimit.out && atLimit.out.results.find((r) => r.id === 'p1').verdict === 'needs-owner-decision', atLimit.out && atLimit.out.results)
  ok('the at-limit warning fired', atLimit.out && atLimit.out.warnings.some((w) => /ALREADY used their one bounce/.test(w)), atLimit.out && atLimit.out.warnings)

  section('14 · BUILD 1 — REACHABILITY  (fires on the bad input, silent on the good one)')
  const reachBad = await run({ mode: 'plan', refs: ['#154'] }, { ...GOOD, 'framer:decomposeCheck': BAD_REACHABLE })
  ok('no throw', !reachBad.err, reachBad.err && reachBad.err.message)
  ok('the decompose-check dispatch fired under Decompose', calledPhase(reachBad.calls, 'Decompose').some((c) => c.label === 'framer:decomposeCheck'), calledPhase(reachBad.calls, 'Decompose').map((c) => c.label))
  ok('contract reports 1 unreachable', reachBad.out && reachBad.out.contract.unreachable === 1, reachBad.out && reachBad.out.contract)
  ok('the piece is FLAGGED, never dropped', reachBad.out && reachBad.out.pieces.length === 1 && reachBad.out.pieces[0].unreachable === true, reachBad.out && reachBad.out.pieces)
  ok('the blocking gate is named on the piece', reachBad.out && reachBad.out.pieces[0].blockingGate === BAD_REACHABLE.reachability[0].blockingGate, reachBad.out && reachBad.out.pieces[0].blockingGate)
  ok('`next` opens with STOP naming the gate', reachBad.out && /^STOP: 1 piece\(s\) name a route a pre-existing gate makes unreachable/.test(reachBad.out.next), reachBad.out && reachBad.out.next.slice(0, 140))
  ok('the loud UNREACHABLE log line fired', reachBad.logs.some((l) => /UNREACHABLE/.test(l)), reachBad.logs)
  ok(
    'it never reaches a lane — plan mode dispatches no Build/Context/Verify regardless',
    !reachBad.calls.some((c) => c.opts && ['Build', 'Context', 'Verify'].includes(c.opts.phase)),
    reachBad.calls.map((c) => `${c.label}[${c.opts && c.opts.phase}]`),
  )
  const reachGood = await run({ mode: 'plan', refs: ['#154'] }, GOOD)
  ok('a reachable piece reports 0 unreachable', reachGood.out && reachGood.out.contract.unreachable === 0, reachGood.out && reachGood.out.contract)
  ok('the piece carries no `unreachable` flag', reachGood.out && !reachGood.out.pieces[0].unreachable, reachGood.out && reachGood.out.pieces[0])
  ok('`next` does NOT open with a reachability STOP', reachGood.out && !/^STOP: \d+ piece\(s\) name a route/.test(reachGood.out.next))
  ok('no UNREACHABLE log line on a clean plan', !reachGood.logs.some((l) => /UNREACHABLE/.test(l)))
  // `null`, not a deleted key: `run()`'s matcher tries EXACT match first, but
  // deleting the key would fall through to the `startsWith('framer')` branch and
  // hit the bare `framer` (Decompose) entry instead — the exact collision X159's
  // own comment warns about. An exact key mapped to `null` simulates "the
  // dispatch died" (agent() really does return null after a subagent's retries
  // exhaust) without ever reaching that fallback.
  const GOOD_NO_CHECK = { ...GOOD, 'framer:decomposeCheck': null }
  const noCheck = await run({ mode: 'plan', refs: ['#154'] }, GOOD_NO_CHECK)
  ok('a dead decompose-check dispatch WARNS, never blocks', noCheck.out && !/^STOP:/.test(noCheck.out.next), noCheck.out && noCheck.out.next.slice(0, 80))
  ok('  …and says so', noCheck.logs.some((l) => /DECOMPOSE CHECK DID NOT RUN/.test(l)), noCheck.logs)
  ok('  …and contract.checked is false', noCheck.out && noCheck.out.contract.checked === false, noCheck.out && noCheck.out.contract)

  section('15 · BUILD 2 — THE CENSUS  (fires when a piece names a pattern, silent when none do)')
  const PATTERN_PIECE = { ...GOOD_PIECE, id: 'p2', patternQuery: 'senderRole' }
  const PATTERN_PLAN = { pieces: [PATTERN_PIECE], sharedPiece: GOOD_PLAN.sharedPiece, blockingQuestions: [], notWorthBuilding: [] }
  const CENSUS_RESULT = {
    reachability: [{ id: 'p2', reachable: true, blockingGate: '' }],
    census: [
      {
        query: 'senderRole',
        sites: [
          { file: 'src/connectors/slack/app/processMessage.ts', lane: 'slackmaster' },
          { file: 'src/connections/gatekeeper.ts', lane: 'gatekeeper' },
          { file: 'src/skills/meetings.ts', lane: 'matchmaker' },
        ],
      },
    ],
  }
  const withPattern = await run({ mode: 'plan', refs: ['#154'] }, { ...GOOD, framer: PATTERN_PLAN, 'framer:decomposeCheck': CENSUS_RESULT })
  ok('no throw', !withPattern.err, withPattern.err && withPattern.err.message)
  ok('the census dispatch was told the query', /senderRole/.test(promptOf(withPattern.calls, 'framer:decomposeCheck')), promptOf(withPattern.calls, 'framer:decomposeCheck').slice(0, 300))
  const p2 = withPattern.out && withPattern.out.pieces.find((p) => p.id === 'p2')
  ok('the piece carries a `census` field', !!(p2 && p2.census), p2)
  ok('it names the total across ALL lanes, not just its own', p2 && /has 3 site\(s\) across 3 lane\(s\)/.test(p2.census), p2 && p2.census)
  ok('it says which of the total are THIS piece\'s own', p2 && /1 of them are yours/.test(p2.census), p2 && p2.census)
  ok('it names the piece as unfinished until its own share is closed', p2 && /not done until all 1 are closed/.test(p2.census), p2 && p2.census)
  ok('the Census log line fired', withPattern.logs.some((l) => /Census: 1 pattern\(s\) — "senderRole":3/.test(l)), withPattern.logs)
  const noPattern = await run({ mode: 'plan', refs: ['#154'] }, GOOD)
  ok('no piece named a pattern → no `census` field anywhere', !noPattern.out.pieces.some((p) => p.census), noPattern.out.pieces)
  ok('the dispatch was told no pattern was named', /No piece named a pattern/.test(promptOf(noPattern.calls, 'framer:decomposeCheck')))
  ok('no Census log line on a plan with no pattern', !noPattern.logs.some((l) => /^Census:/.test(l)))
  // The count reaches a ticket body (survives into whatever engine builds it next
  // — bugger.js has never heard of `expectation`, but it reads an issue's prose).
  const descPattern = await run(
    { mode: 'plan', items: [{ title: 'Owner authority across chat surfaces', asks: 'decide what the clamp governs', priority: 'High' }] },
    { 'framer:new-1': { ...RECON, ref: 'new-1' }, framer: { ...PATTERN_PLAN, pieces: [{ ...PATTERN_PIECE, ref: 'new-1' }] }, 'framer:decomposeCheck': CENSUS_RESULT },
  )
  const ticketBody = descPattern.out && descPattern.out.needsTicket[0] ? descPattern.out.needsTicket[0].body : ''
  ok('the ticket body carries the census line', /- census: pattern "senderRole" has 3 site\(s\)/.test(ticketBody), ticketBody)
  // And it reaches the LANE at build time — its own files, but the total.
  const censusBuild = await run(
    { mode: 'build', pieces: [{ ...GOOD_PIECE, census: p2.census }], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    { slackmaster: { results: [{ id: 'p1', verdict: 'built' }] } },
  )
  ok('the CENSUS line reaches the build prompt', /CENSUS: pattern "senderRole" has 3 site\(s\)/.test(promptOf(censusBuild.calls, 'slackmaster')), promptOf(censusBuild.calls, 'slackmaster').slice(0, 300))

  section('16 · A SECOND DISPATCH OF THE SAME LANE SAYS WHY  (fires on the bad input, silent on the good one)')
  // 16a — the WAVE split: two pieces, same lane, the second `dependsOn` the
  // first. Both land in the SAME `Build` box (feature.js sets `phase('Build')`
  // once, outside the wave loop) — this is his exact example: "if we have two
  // matchmaker in the same stage". Distinct exact canned keys so each wave's
  // response is provably matched by ITS OWN label, not a lucky startsWith.
  const waveSplit = await run(
    { mode: 'build', pieces: [{ ...GOOD_PIECE, id: 'p1' }, { ...GOOD_PIECE, id: 'p2', dependsOn: ['p1'] }], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    { 'slackmaster(1)': { results: [{ id: 'p1', verdict: 'built' }] }, 'dep:slackmaster(1)': { results: [{ id: 'p2', verdict: 'built' }] } },
  )
  ok('no throw', !waveSplit.err, waveSplit.err && waveSplit.err.message)
  const waveLabels = calledPhase(waveSplit.calls, 'Build').map((c) => c.label)
  ok('slackmaster dispatched twice in the SAME Build box', waveLabels.filter((l) => l.includes('slackmaster')).length === 2, waveLabels)
  ok('the FIRST dispatch carries its count, no prefix', waveLabels.includes('slackmaster(1)'), waveLabels)
  ok('the SECOND — same lane, this run — says WHY, as a PREFIX', waveLabels.includes('dep:slackmaster(1)'), waveLabels)
  ok('both waves actually landed (the labels were matched, not guessed)', waveSplit.out && waveSplit.out.results.filter((r) => r.verdict === 'built').length === 2, waveSplit.out && waveSplit.out.results)

  // 16b — the ASK round: slackmaster asks gatekeeper for something, gatekeeper
  // builds it, slackmaster is RESUMED. gatekeeper's dispatch is its lane's
  // FIRST this run (no marker) even though it happens in a later round;
  // slackmaster's resume is its SECOND (marked) even though the mechanism is
  // "resumed", not "asked" — proving the marker reads off the lane, not off
  // which of the two dependency mechanisms produced the repeat.
  const askRound = await run(
    { mode: 'build', pieces: [{ ...GOOD_PIECE, id: 'p1' }], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    {
      'slackmaster(1)': { results: [{ id: 'p1', verdict: 'needs-dependency', dependencyAgent: 'gatekeeper', dependencyAsk: 'add the seam', fix: 'nothing yet' }] },
      'gatekeeper(1)': { results: [{ id: 'p1>dep', verdict: 'built', fix: 'added the seam' }] },
      'dep:slackmaster(1)': { results: [{ id: 'p1', verdict: 'built' }] },
    },
  )
  ok('no throw', !askRound.err, askRound.err && askRound.err.message)
  const askLabels = calledPhase(askRound.calls, 'Build').map((c) => c.label)
  ok('the lane ASKED for the first time carries no prefix', askLabels.includes('gatekeeper(1)'), askLabels)
  ok('the originator RESUMED in a later round IS marked — same lane, second dispatch', askLabels.includes('dep:slackmaster(1)'), askLabels)
  ok('the resume actually ran — final verdict is built, not still needs-dependency', askRound.out && askRound.out.results.some((r) => r.id === 'p1' && r.verdict === 'built'), askRound.out && askRound.out.results)

  // ── BUILD 1 · THE WAVE'S OWN SPEC MUST RESOLVE BEFORE THE WAVE IS DONE ──────
  const GOOD_PIECE2 = { ...GOOD_PIECE, id: 'p2', lane: 'matchmaker' }

  section("17 · OWNERGATE — a piece needing the owner's own decision keeps the WHOLE WAVE unfinished  (fires on the bad input)")
  const gate = await run(
    { mode: 'build', pieces: [GOOD_PIECE, GOOD_PIECE2], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    {
      'slackmaster(1)': { results: [{ id: 'p1', verdict: 'built', filesTouched: ['a.ts'] }] },
      'matchmaker(1)': { results: [{ id: 'p2', verdict: 'needs-owner-decision', notes: 'is the widened scope safe — needs his call' }] },
    },
  )
  ok('no throw', !gate.err, gate.err && gate.err.message)
  ok('the wave reports itself NOT complete', gate.out && gate.out.manifest.ownSpec.complete === false, gate.out && gate.out.manifest.ownSpec)
  ok('ownSpec.needsRuling counts exactly the one piece', gate.out && gate.out.manifest.ownSpec.needsRuling === 1, gate.out && gate.out.manifest.ownSpec)
  ok('needsOwnerRuling holds exactly p2', gate.out && gate.out.needsOwnerRuling.length === 1 && gate.out.needsOwnerRuling[0].id === 'p2', gate.out && gate.out.needsOwnerRuling)
  const ruled = gate.out && gate.out.needsOwnerRuling[0]
  ok('the FULL contract travels — connection', ruled && ruled.connection === GOOD_PIECE.connection, ruled)
  ok('the FULL contract travels — expectation', ruled && ruled.expectation === GOOD_PIECE.expectation, ruled)
  ok('the FULL contract travels — whatChanges', ruled && ruled.whatChanges === GOOD_PIECE.whatChanges, ruled)
  ok('the FULL contract travels — lane and ref', ruled && ruled.lane === 'matchmaker' && ruled.ref === GOOD_PIECE.ref, ruled)
  ok('the reason it stopped travels too', ruled && /is the widened scope safe/.test(ruled.notes), ruled)
  ok('it is flagged `awaitingOwner`, same gate as a deferred dependency ask', ruled && ruled.awaitingOwner === true, ruled)
  ok('`resume` is NOT null', gate.out && gate.out.resume !== null, gate.out && gate.out.resume)
  ok('resume.pieces carries both ids', gate.out && gate.out.resume.pieces.map((p) => p.id).sort().join(',') === 'p1,p2', gate.out && gate.out.resume.pieces)
  const resumeP1 = gate.out && gate.out.resume.pieces.find((p) => p.id === 'p1')
  ok('the UNTOUCHED piece (p1) is BYTE-IDENTICAL to what was approved — the cache-hit guarantee', JSON.stringify(resumeP1) === JSON.stringify(GOOD_PIECE), resumeP1)
  const resumeP2 = gate.out && gate.out.resume.pieces.find((p) => p.id === 'p2')
  ok('the RULED piece (p2) carries `awaitingOwner` inside resume.pieces too', resumeP2 && resumeP2.awaitingOwner === true, resumeP2)
  ok('the OwnerGate warning fired, NAMING bugger.js as the wrong door', gate.out && gate.out.warnings.some((w) => /THIS WAVE IS NOT DONE/.test(w) && /NOT bugger\.js WORK/.test(w)), gate.out && gate.out.warnings)
  ok('the warning names resumeFromRunId as the re-entry mechanism', gate.out && gate.out.warnings.some((w) => /resumeFromRunId/.test(w)), gate.out && gate.out.warnings)
  ok('the OwnerGate log line fired with the right split', gate.logs.some((l) => /OwnerGate: 1 piece\(s\) stayed as THIS WAVE'S OWN BUSINESS/.test(l) && /0 unrelated discovery/.test(l)), gate.logs)

  const gateCharter = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    { slackmaster: { results: [{ id: 'p1', verdict: 'blocked-charter', notes: 'no charter route to this' }] } },
  )
  ok('`blocked-charter` gates the wave the SAME way `needs-owner-decision` does', gateCharter.out && gateCharter.out.manifest.ownSpec.complete === false && gateCharter.out.needsOwnerRuling.length === 1, gateCharter.out && gateCharter.out.manifest.ownSpec)

  section('18 · A FULLY-RESOLVED WAVE REPORTS COMPLETE — no OwnerGate warning, no resume  (silent on the good input)')
  const clean2 = await run(
    { mode: 'build', pieces: [GOOD_PIECE, GOOD_PIECE2], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    { 'slackmaster(1)': { results: [{ id: 'p1', verdict: 'built' }] }, 'matchmaker(1)': { results: [{ id: 'p2', verdict: 'built' }] } },
  )
  ok('no throw', !clean2.err, clean2.err && clean2.err.message)
  ok('the wave reports itself complete', clean2.out && clean2.out.manifest.ownSpec.complete === true, clean2.out && clean2.out.manifest.ownSpec)
  ok('needsOwnerRuling is empty', clean2.out && clean2.out.needsOwnerRuling.length === 0, clean2.out && clean2.out.needsOwnerRuling)
  ok('resume is null — nothing to re-enter', clean2.out && clean2.out.resume === null, clean2.out && clean2.out.resume)
  ok('NO OwnerGate warning on a clean wave', !clean2.out.warnings.some((w) => /THIS WAVE IS NOT DONE/.test(w)), clean2.out.warnings)
  ok('the OwnerGate log line still fires, reading zero', clean2.logs.some((l) => /OwnerGate: 0 piece\(s\) stayed as THIS WAVE'S OWN BUSINESS/.test(l)), clean2.logs)

  section("19 · RESUMING A RULED PIECE — `_ownerRuled` reaches the lane as his ruling, not a fresh question")
  const resumed2 = await run(
    { mode: 'build', pieces: [{ ...GOOD_PIECE, _ownerRuled: { askedBecause: 'is the widened scope safe', hisRuling: 'yes — ship it as designed' } }], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    { 'owner:slackmaster(1)': { results: [{ id: 'p1', verdict: 'built' }] } },
  )
  ok('no throw', !resumed2.err, resumed2.err && resumed2.err.message)
  // X177 · the resume is labelled `owner:`, not a bare lane name or `dep:` —
  // it is neither this lane's first dispatch nor a cross-lane ask, it is a
  // rebuild because HE ruled.
  ok('the dispatch is labelled owner:, not dep: or bare', resumed2.calls.some((c) => c.label === 'owner:slackmaster(1)'), resumed2.calls.map((c) => c.label))
  ok('the lane is told this is a ruling, not a new question', /owner has now ruled/.test(promptOf(resumed2.calls, 'owner:slackmaster')), promptOf(resumed2.calls, 'owner:slackmaster').slice(0, 400))
  ok('the question that was asked reaches the lane', /is the widened scope safe/.test(promptOf(resumed2.calls, 'owner:slackmaster')))
  ok('his actual ruling reaches the lane', /yes — ship it as designed/.test(promptOf(resumed2.calls, 'owner:slackmaster')))
  ok('a wave with no `_ownerRuled` pieces gets NONE of this text', !/owner has now ruled/.test(promptOf(d.calls, 'slackmaster')), promptOf(d.calls, 'slackmaster'))
  ok('the resumed piece completes the wave', resumed2.out && resumed2.out.manifest.ownSpec.complete === true, resumed2.out && resumed2.out.manifest.ownSpec)

  section('20 · A CROSS-LANE ASK THE VERIFY RAISES ALSO KEEPS THE WAVE OPEN, AND STAYS OUT OF bugger.js')
  const askOut = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece },
    {
      slackmaster: BUILT_ONCE,
      'bouncer:wave(1)': {
        results: [{ id: 'p1', verdict: 'built', dependencyAgent: 'gatekeeper', dependencyAsk: 'add the seam gatekeeper-side too', notes: 'p1 itself is fine' }],
        discoveries: [],
        ticketCoverage: [],
        verifiedClean: [],
      },
    },
  )
  ok('no throw', !askOut.err, askOut.err && askOut.err.message)
  ok('NOT an overturn — p1 stays built, no bounce dispatched', !askOut.calls.some((c) => String(c.label).startsWith('rebuild:')), askOut.calls.map((c) => c.label))
  ok('the wave is NOT complete — a cross-lane ask is still unrouted', askOut.out && askOut.out.manifest.ownSpec.complete === false, askOut.out && askOut.out.manifest.ownSpec)
  ok('ownSpec.deferredDepAsks counts it', askOut.out && askOut.out.manifest.ownSpec.deferredDepAsks === 1, askOut.out && askOut.out.manifest.ownSpec)
  ok('the ask is shaped for resume.pieces, not args.issues', askOut.out && askOut.out.resume && askOut.out.resume.pieces.some((p) => p.id === 'p1>dep' && p.lane === 'gatekeeper' && p.awaitingOwner === true), askOut.out && askOut.out.resume)

  section('21 · A DEPENDENCY THAT NEVER LANDS ALSO KEEPS THE WAVE OPEN  (fires on the bad input)')
  const stuck = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    { slackmaster: { results: [{ id: 'p1', verdict: 'needs-dependency', dependencyAgent: 'nonexistent-lane', dependencyAsk: 'a lane that does not exist' }] } },
  )
  ok('no throw', !stuck.err, stuck.err && stuck.err.message)
  ok('the piece stays needs-dependency, never satisfied', stuck.out && stuck.out.results.find((r) => r.id === 'p1').verdict === 'needs-dependency', stuck.out && stuck.out.results)
  ok('ownSpec.stillBlocked counts it', stuck.out && stuck.out.manifest.ownSpec.stillBlocked === 1, stuck.out && stuck.out.manifest.ownSpec)
  ok('the wave is NOT complete', stuck.out && stuck.out.manifest.ownSpec.complete === false, stuck.out && stuck.out.manifest.ownSpec)
  ok('the pre-existing stuck-dependency warning also fires', stuck.out && stuck.out.warnings.some((w) => /still blocked on a dependency/.test(w)), stuck.out && stuck.out.warnings)

  section('22 · A DEPENDENCY THAT DOES LAND CLEARS stillBlocked  (silent on the good input)')
  const unstuck = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    {
      'slackmaster(1)': { results: [{ id: 'p1', verdict: 'needs-dependency', dependencyAgent: 'gatekeeper', dependencyAsk: 'add the seam' }] },
      'gatekeeper(1)': { results: [{ id: 'p1>dep', verdict: 'built', fix: 'added the seam' }] },
      'dep:slackmaster(1)': { results: [{ id: 'p1', verdict: 'built' }] },
    },
  )
  ok('no throw', !unstuck.err, unstuck.err && unstuck.err.message)
  ok('ownSpec.stillBlocked is 0 once the dependency resolves', unstuck.out && unstuck.out.manifest.ownSpec.stillBlocked === 0, unstuck.out && unstuck.out.manifest.ownSpec)
  ok('the wave completes', unstuck.out && unstuck.out.manifest.ownSpec.complete === true, unstuck.out && unstuck.out.manifest.ownSpec)

  // ── X177 · THE OWNER GATE MOVES — BEFORE VERIFY, NEVER AFTER ────────────────
  section('23 · A PIECE NEEDING THE OWNER STOPS THE WAVE BEFORE VERIFY EVER DISPATCHES  (fires on the bad input)')
  const preGate = await run(
    { mode: 'build', pieces: [GOOD_PIECE, GOOD_PIECE2], sharedPiece: GOOD_PLAN.sharedPiece },
    {
      'slackmaster(1)': { results: [{ id: 'p1', verdict: 'built', filesTouched: ['a.ts'] }] },
      'matchmaker(1)': { results: [{ id: 'p2', verdict: 'needs-owner-decision', notes: 'is the widened scope safe' }] },
    },
  )
  ok('no throw', !preGate.err, preGate.err && preGate.err.message)
  ok('NO bouncer call at all — the wave never reaches Verify', !preGate.calls.some((c) => String(c.label).startsWith('bouncer:')), preGate.calls.map((c) => c.label))
  ok('the `phase(\'Verify\')` announcement itself never fires', !preGate.phases.includes('Verify'), preGate.phases)
  ok('the manifest says verify did not run', preGate.out && preGate.out.manifest.verify.ran === false, preGate.out && preGate.out.manifest.verify)
  ok(
    'NO false "VERIFY DID NOT RUN" alarm — the OwnerGate warning explains it instead',
    preGate.out && !preGate.out.warnings.some((w) => /THE VERIFY DID NOT RUN/.test(w)),
    preGate.out && preGate.out.warnings,
  )
  ok(
    'the wave still reports itself incomplete, needing his ruling',
    preGate.out && preGate.out.manifest.ownSpec.complete === false && preGate.out.manifest.ownSpec.needsRuling === 1,
    preGate.out && preGate.out.manifest.ownSpec,
  )
  ok('the OwnerGate log line names the stop', preGate.logs.some((l) => /STOPPING BEFORE VERIFY/.test(l)), preGate.logs)

  const noGate = await run(
    { mode: 'build', pieces: [GOOD_PIECE, GOOD_PIECE2], sharedPiece: GOOD_PLAN.sharedPiece },
    {
      'slackmaster(1)': { results: [{ id: 'p1', verdict: 'built', filesTouched: ['a.ts'] }] },
      'matchmaker(1)': { results: [{ id: 'p2', verdict: 'built', filesTouched: ['b.ts'] }] },
      'bouncer:wave(2)': { results: [{ id: 'p1', verdict: 'built' }, { id: 'p2', verdict: 'built' }], discoveries: [], ticketCoverage: [], verifiedClean: [] },
    },
  )
  ok('no throw', !noGate.err, noGate.err && noGate.err.message)
  ok('a CLEAN wave (nobody needs the owner) still dispatches the bouncer — silent on the good path', noGate.calls.some((c) => c.label === 'bouncer:wave(2)'), noGate.calls.map((c) => c.label))
  ok('Verify DOES fire here', noGate.phases.includes('Verify'), noGate.phases)

  section("24 · A RULING REACHES THE BOUNCER MARKED AS GOVERNING  (fires forward, silent in reverse)")
  const RULED_PIECE = {
    ...GOOD_PIECE,
    _ownerRuled: { askedBecause: 'is the widened scope safe', hisRuling: 'yes — ship it as designed, even though it widens the seam beyond what whatChanges describes' },
  }
  const ruledVerify = await run(
    { mode: 'build', pieces: [RULED_PIECE], sharedPiece: GOOD_PLAN.sharedPiece },
    {
      'owner:slackmaster(1)': { results: [{ id: 'p1', verdict: 'built', filesTouched: ['a.ts'] }] },
      'bouncer:wave(1)': { results: [{ id: 'p1', verdict: 'built' }], discoveries: [], ticketCoverage: [], verifiedClean: [] },
    },
  )
  ok('no throw', !ruledVerify.err, ruledVerify.err && ruledVerify.err.message)
  ok('the resumed build dispatch is labelled owner:', ruledVerify.calls.some((c) => c.label === 'owner:slackmaster(1)'), ruledVerify.calls.map((c) => c.label))
  ok('the bouncer payload carries the ORIGINAL plan text', /processMessage\.ts:139/.test(promptOf(ruledVerify.calls, 'bouncer:wave')), promptOf(ruledVerify.calls, 'bouncer:wave').slice(0, 900))
  ok('the bouncer payload ALSO carries his ruling', /yes — ship it as designed/.test(promptOf(ruledVerify.calls, 'bouncer:wave')))
  ok('the ruling is marked as GOVERNING over the original plan text', /IS THE SPEC/.test(promptOf(ruledVerify.calls, 'bouncer:wave')))
  ok('the piece is not overturned for departing from the superseded plan', ruledVerify.out && ruledVerify.out.results.find((r) => r.id === 'p1').verdict === 'built', ruledVerify.out && ruledVerify.out.results)

  ok(
    'a wave with NO rulings gets an UNCHANGED bouncer payload — no `_ownerRuled` key, no governing note',
    !/_ownerRuled/.test(promptOf(bounce.calls, 'bouncer:wave')) && !/IS THE SPEC/.test(promptOf(bounce.calls, 'bouncer:wave')),
    promptOf(bounce.calls, 'bouncer:wave').slice(0, 400),
  )

  section('25 · PHANTOM-CANDIDATE FILE MATCH — full path, never a basename  (fires on the bad input, silent on the good one)')
  // The exact 4.5.1 false positive: a citation and a touched file share a
  // basename (`calendarReads.ts`) but live under different directories. This
  // must NOT match — that guess is precisely what flagged
  // `colleague-subject-permissive-half-not-built` as resolved by a wrap that
  // never touched the file its rootCause actually named.
  ok(
    'a same-BASENAME, different-path pair does NOT match',
    citesReleaseFile(['src/skills/meetings/ops/handlers/calendarReads.ts'], ['src/connectors/graph/calendarReads.ts']) === false,
  )
  // A genuine same-path citation must still fire — the fix must not have
  // overcorrected into never matching anything.
  ok(
    'an EXACT same-path citation still matches',
    citesReleaseFile(['src/connectors/graph/calendarReads.ts'], ['src/connectors/graph/calendarReads.ts', 'src/other/file.ts']) === true,
  )
  // A bare filename with no directory is never guessed into a match either —
  // that guess is the same failure shape, just on the citation side instead
  // of the release-file side.
  ok(
    'a bare filename citation (no directory) matches nothing, even against a same-named touched file',
    citesReleaseFile(['calendarReads.ts'], ['src/connectors/graph/calendarReads.ts']) === false,
  )
  // Two files, one of which genuinely matches — proves the fix does not just
  // return false unconditionally.
  ok(
    'a mixed citation list matches on the one genuine full-path hit',
    citesReleaseFile(['src/skills/meetings/ops/handlers/calendarReads.ts', 'src/connectors/graph/calendarReads.ts'], ['src/connectors/graph/calendarReads.ts']) === true,
  )

  // ══════════════════════════════════════════════════════════════════════════
  // X182 · QUESTION 1 — THE OUTCOME TRACE. His ruling made it "the whole pass
  // now"; 1b got a real engine mechanism the same week and Q1 stayed prose
  // only. Both directions, both engines — a check that fires on a healthy
  // wave gets learned into noise exactly as fast as one that never fires at
  // all.
  // ══════════════════════════════════════════════════════════════════════════
  section('26 · QUESTION 1 (X182) — FEATURE.JS, AN OMITTED TRACE READS AS UNTRACED  (fires on the bad input)')
  const untracedFeature = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece },
    {
      slackmaster: { results: [{ id: 'p1', verdict: 'built', filesTouched: ['a.ts'] }] },
      'bouncer:wave(1)': { results: [{ id: 'p1', verdict: 'built' }], discoveries: [], ticketCoverage: [], verifiedClean: [] }, // outcomeTraces OMITTED
    },
  )
  ok('no throw', !untracedFeature.err, untracedFeature.err && untracedFeature.err.message)
  ok(
    'question 1 is handed to the bouncer, naming the piece\'s own requirement',
    /QUESTION 1 —/.test(promptOf(untracedFeature.calls, 'bouncer:wave')) && promptOf(untracedFeature.calls, 'bouncer:wave').includes(GOOD_PIECE.requirement),
    promptOf(untracedFeature.calls, 'bouncer:wave').slice(0, 900),
  )
  ok('manifest.outcome.candidates is the ENGINE\'S OWN count, 1', untracedFeature.out && untracedFeature.out.manifest.outcome.candidates === 1, untracedFeature.out && untracedFeature.out.manifest.outcome)
  ok('an OMITTED outcomeTraces reads as untraced:1, never a silent zero', untracedFeature.out && untracedFeature.out.manifest.outcome.untraced === 1, untracedFeature.out && untracedFeature.out.manifest.outcome)
  ok('QUESTION 1 IS UNCOVERED fires', untracedFeature.out && untracedFeature.out.warnings.some((w) => /QUESTION 1 IS UNCOVERED/.test(w)), untracedFeature.out && untracedFeature.out.warnings)

  section('27 · QUESTION 1 (X182) — FEATURE.JS, A FULLY TRACED WAVE STAYS SILENT  (silent on the good one)')
  const tracedFeature = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece },
    {
      slackmaster: { results: [{ id: 'p1', verdict: 'built', filesTouched: ['a.ts'] }] },
      'bouncer:wave(1)': {
        results: [{ id: 'p1', verdict: 'built' }],
        discoveries: [],
        ticketCoverage: [],
        verifiedClean: [],
        outcomeTraces: [{ id: 'p1', verdict: 'traced', evidence: 'a.ts:12' }],
      },
    },
  )
  ok('no throw', !tracedFeature.err, tracedFeature.err && tracedFeature.err.message)
  ok('a fully traced wave has untraced:0', tracedFeature.out && tracedFeature.out.manifest.outcome.untraced === 0, tracedFeature.out && tracedFeature.out.manifest.outcome)
  ok('QUESTION 1 IS UNCOVERED does NOT fire on the healthy path', tracedFeature.out && !tracedFeature.out.warnings.some((w) => /QUESTION 1 IS UNCOVERED/.test(w)), tracedFeature.out && tracedFeature.out.warnings)

  const noSymptomFeature = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece },
    {
      slackmaster: { results: [{ id: 'p1', verdict: 'built', filesTouched: ['a.ts'] }] },
      'bouncer:wave(1)': {
        results: [{ id: 'p1', verdict: 'built' }],
        discoveries: [],
        ticketCoverage: [],
        verifiedClean: [],
        // B2's own carve-out — an explicit, named exemption, never a silent skip.
        outcomeTraces: [{ id: 'p1', verdict: 'no-symptom', notes: 'pure scaffolding another piece depends on — no behavioural outcome of its own' }],
      },
    },
  )
  ok('an HONEST no-symptom acknowledgment ALSO clears the candidate — B2\'s carve-out, not a loophole', noSymptomFeature.out && noSymptomFeature.out.manifest.outcome.untraced === 0, noSymptomFeature.out && noSymptomFeature.out.manifest.outcome)
  ok('no warning on the honest no-symptom wave — this is the failure the phantom check made tonight, avoided here', noSymptomFeature.out && !noSymptomFeature.out.warnings.some((w) => /QUESTION 1 IS UNCOVERED/.test(w)), noSymptomFeature.out && noSymptomFeature.out.warnings)

  section('28 · QUESTION 1 (X182) — BUGGER.JS, THE SAME MECHANISM, THE SAME TWO DIRECTIONS')
  const BUG_ISSUE = { id: 'b1', symptom: 'the reminder fires twice', lane: 'slackmaster', severity: 'high', clarity: 'clear', source: 'github' }
  const untracedBugger = await runBugger(
    { issues: [BUG_ISSUE] },
    {
      'slackmaster(1)': { results: [{ id: 'b1', verdict: 'built', filesTouched: ['src/x.ts'] }] },
      'bouncer:wave(1)': { results: [{ id: 'b1', verdict: 'built' }], discoveries: [], ticketCoverage: [], verifiedClean: [] }, // outcomeTraces OMITTED
    },
  )
  ok('no throw', !untracedBugger.err, untracedBugger.err && untracedBugger.err.message)
  ok(
    'question 1 is handed to the bouncer, naming the row\'s own symptom',
    /QUESTION 1 —/.test(promptOf(untracedBugger.calls, 'bouncer:wave')) && promptOf(untracedBugger.calls, 'bouncer:wave').includes(BUG_ISSUE.symptom),
    promptOf(untracedBugger.calls, 'bouncer:wave').slice(0, 900),
  )
  ok('manifest.outcome.candidates is the ENGINE\'S OWN count, 1  (fires on the bad input)', untracedBugger.out && untracedBugger.out.manifest.outcome.candidates === 1, untracedBugger.out && untracedBugger.out.manifest.outcome)
  ok('an OMITTED outcomeTraces reads as untraced:1, never a silent zero', untracedBugger.out && untracedBugger.out.manifest.outcome.untraced === 1, untracedBugger.out && untracedBugger.out.manifest.outcome)
  ok('QUESTION 1 IS UNCOVERED fires', untracedBugger.out && untracedBugger.out.warnings.some((w) => /QUESTION 1 IS UNCOVERED/.test(w)), untracedBugger.out && untracedBugger.out.warnings)

  const tracedBugger = await runBugger(
    { issues: [BUG_ISSUE] },
    {
      'slackmaster(1)': { results: [{ id: 'b1', verdict: 'built', filesTouched: ['src/x.ts'] }] },
      'bouncer:wave(1)': {
        results: [{ id: 'b1', verdict: 'built' }],
        discoveries: [],
        ticketCoverage: [],
        verifiedClean: [],
        outcomeTraces: [{ id: 'b1', verdict: 'traced', evidence: 'src/x.ts:44' }],
      },
    },
  )
  ok('a fully traced wave has untraced:0  (silent on the good one)', tracedBugger.out && tracedBugger.out.manifest.outcome.untraced === 0, tracedBugger.out && tracedBugger.out.manifest.outcome)
  ok('QUESTION 1 IS UNCOVERED does NOT fire on the healthy path', tracedBugger.out && !tracedBugger.out.warnings.some((w) => /QUESTION 1 IS UNCOVERED/.test(w)), tracedBugger.out && tracedBugger.out.warnings)

  const noSymptomBugger = await runBugger(
    { issues: [BUG_ISSUE] },
    {
      'slackmaster(1)': { results: [{ id: 'b1', verdict: 'built', filesTouched: ['src/x.ts'] }] },
      'bouncer:wave(1)': {
        results: [{ id: 'b1', verdict: 'built' }],
        discoveries: [],
        ticketCoverage: [],
        verifiedClean: [],
        outcomeTraces: [{ id: 'b1', verdict: 'no-symptom', notes: 'one-line comment correction, no behavioural symptom' }],
      },
    },
  )
  ok('an HONEST no-symptom acknowledgment ALSO clears the candidate — B2\'s carve-out, not a loophole', noSymptomBugger.out && noSymptomBugger.out.manifest.outcome.untraced === 0, noSymptomBugger.out && noSymptomBugger.out.manifest.outcome)
  ok('no warning on the honest no-symptom wave', noSymptomBugger.out && !noSymptomBugger.out.warnings.some((w) => /QUESTION 1 IS UNCOVERED/.test(w)), noSymptomBugger.out && noSymptomBugger.out.warnings)

  // ══════════════════════════════════════════════════════════════════════════
  // THE WORKSHOP (2026-08-07) — W1-W12 moved from eight hand-copied "Shared
  // charter" blocks into ONE source, `.claude/WORKSHOP.md`, that every lane
  // charter now reads FIRST and must fail closed against. Two independent
  // things can each fail silently: a charter could still carry (or regrow) a
  // duplicated copy, or a lane could build without ever reading the source and
  // nothing downstream would show it. Both get a fixture — the first is a
  // static read, the second drives the real engines.
  // ══════════════════════════════════════════════════════════════════════════
  section('29 · THE WORKSHOP FILE — ONE SOURCE, W1 THROUGH W12, NOTHING DUPLICATED  (fires on the bad input, silent on the good one)')
  const WORKSHOP_FILE = path.join(ROOT, '.claude', 'WORKSHOP.md')
  const workshopSrc = fs.readFileSync(WORKSHOP_FILE, 'utf8')
  ok('WORKSHOP.md exists and is non-trivial', workshopSrc.length > 2000, workshopSrc.length)
  const workshopTags = [...workshopSrc.matchAll(/^- \*\*W([0-9]+) ·/gm)].map((m) => Number(m[1])).sort((a, b) => a - b)
  ok('WORKSHOP.md carries exactly W1 through W12, no gaps, no repeats', JSON.stringify(workshopTags) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), workshopTags)

  // A charter is WORKSHOP-CLEAN when it (a) carries no duplicate of the old
  // block — the "## Shared charter" heading every copy used to open with —
  // (b) tells the agent to read WORKSHOP.md and STOP if it cannot, and (c) its
  // return contract proves the read happened. Tested against a synthetic GOOD
  // and two BAD strings BEFORE trusting the regex against the real files —
  // that is what makes this a fixture rather than a read of the files alone.
  const workshopChecks = (text) => ({
    noDuplicateBlock: !/^## Shared charter/m.test(text),
    readsFirst: /\.claude\/WORKSHOP\.md/.test(text) && /STOP/.test(text),
    provesRead: /workshopRead/.test(text),
  })
  const GOOD_CHARTER_TEXT = '## Read the Workshop rules first\n\nread `.claude/WORKSHOP.md`. If you cannot, STOP.\n\nevery result sets `workshopRead: true`.'
  const BAD_CHARTER_NO_POINTER = '## Some other heading\n\nthis charter mentions none of it.'
  const BAD_CHARTER_DUPLICATE = '## Shared charter — every Maelle agent follows this\n\n1. Deep solution, never a patch...'
  const goodCheck = workshopChecks(GOOD_CHARTER_TEXT)
  ok('the checker PASSES a synthetic clean charter on all three tests', goodCheck.noDuplicateBlock && goodCheck.readsFirst && goodCheck.provesRead, goodCheck)
  const badNoPointer = workshopChecks(BAD_CHARTER_NO_POINTER)
  ok('the checker FAILS a charter with no Workshop pointer at all', !badNoPointer.readsFirst && !badNoPointer.provesRead, badNoPointer)
  const badDuplicate = workshopChecks(BAD_CHARTER_DUPLICATE)
  ok('the checker FAILS a charter that still carries the duplicated block', !badDuplicate.noDuplicateBlock, badDuplicate)

  const BUILDER_LANES = ['matchmaker', 'registrar', 'gatekeeper', 'librarian', 'instructor', 'slackmaster', 'diplomat', 'handyman']
  for (const lane of BUILDER_LANES) {
    const text = fs.readFileSync(path.join(ROOT, '.claude', 'agents', `${lane}.md`), 'utf8')
    const c = workshopChecks(text)
    ok(`${lane}.md carries no duplicated Shared-charter block`, c.noDuplicateBlock)
    ok(`${lane}.md reads WORKSHOP.md first and fails closed`, c.readsFirst)
    ok(`${lane}.md's return contract proves the read`, c.provesRead)
  }

  section('30 · WORKSHOP READ FAILURE — feature.js WARNS LOUDLY  (fires on the bad input, silent on the good one)')
  const unreadBuild = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    { slackmaster: { results: [{ id: 'p1', verdict: 'built', workshopRead: false }] } },
  )
  ok('no throw', !unreadBuild.err, unreadBuild.err && unreadBuild.err.message)
  ok(
    'WORKSHOP NOT READ fires, naming the piece',
    unreadBuild.out && unreadBuild.out.warnings.some((w) => /WORKSHOP NOT READ/.test(w) && w.includes('p1')),
    unreadBuild.out && unreadBuild.out.warnings,
  )
  const readBuild = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    { slackmaster: { results: [{ id: 'p1', verdict: 'built', workshopRead: true }] } },
  )
  ok('no throw', !readBuild.err, readBuild.err && readBuild.err.message)
  ok('no WORKSHOP warning on a clean read', readBuild.out && !readBuild.out.warnings.some((w) => /WORKSHOP NOT READ/.test(w)), readBuild.out && readBuild.out.warnings)
  ok(
    'a result that never mentions workshopRead is NOT flagged (schema enforces required; this fixture cannot fake that layer)',
    clean.out && !clean.out.warnings.some((w) => /WORKSHOP NOT READ/.test(w)),
    clean.out && clean.out.warnings,
  )

  section('31 · WORKSHOP READ FAILURE — bugger.js, THE SAME MECHANISM  (fires on the bad input, silent on the good one)')
  const unreadBugger = await runBugger({ issues: [BUG_ISSUE] }, { 'slackmaster(1)': { results: [{ id: 'b1', verdict: 'built', workshopRead: false }] } })
  ok('no throw', !unreadBugger.err, unreadBugger.err && unreadBugger.err.message)
  ok(
    'WORKSHOP NOT READ fires, naming the row',
    unreadBugger.out && unreadBugger.out.warnings.some((w) => /WORKSHOP NOT READ/.test(w) && w.includes('b1')),
    unreadBugger.out && unreadBugger.out.warnings,
  )
  const readBugger = await runBugger({ issues: [BUG_ISSUE] }, { 'slackmaster(1)': { results: [{ id: 'b1', verdict: 'built', workshopRead: true }] } })
  ok('no throw', !readBugger.err, readBugger.err && readBugger.err.message)
  ok('no WORKSHOP warning on a clean read', readBugger.out && !readBugger.out.warnings.some((w) => /WORKSHOP NOT READ/.test(w)), readBugger.out && readBugger.out.warnings)

  // ══════════════════════════════════════════════════════════════════════════
  // MEASURED OBSERVABLE (2026-08-06) — o#227/o#228/o#229: three repairs each
  // built exactly what their brief specified and delivered none of the outcome
  // it existed for, because no brief ever asked the lane to check the change
  // against LIVE data. Both engines gained an `observable` field, a dispatch
  // note demanding it, and an engine-derived MISSING count — tested the same
  // two directions as every other mechanism in this file, and independent of
  // `verify` because the discipline belongs to the lane's own dispatch.
  // ══════════════════════════════════════════════════════════════════════════
  section('32 · MEASURED OBSERVABLE — FEATURE.JS, A CLOSE WITH NO REAL-DATA CHECK WARNS  (fires on the bad input)')
  const noObsFeature = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    { slackmaster: { results: [{ id: 'p1', verdict: 'built', filesTouched: ['a.ts'] }] } }, // observable OMITTED
  )
  ok('no throw', !noObsFeature.err, noObsFeature.err && noObsFeature.err.message)
  ok(
    'the dispatch BRIEF itself carries the observable discipline',
    /BEFORE YOU RETURN `built`/.test(promptOf(noObsFeature.calls, 'slackmaster')),
    promptOf(noObsFeature.calls, 'slackmaster').slice(0, 400),
  )
  ok("manifest.observable.closed is the ENGINE'S OWN count, 1", noObsFeature.out && noObsFeature.out.manifest.observable.closed === 1, noObsFeature.out && noObsFeature.out.manifest.observable)
  ok('an OMITTED observable reads as missing:1, never a silent zero', noObsFeature.out && noObsFeature.out.manifest.observable.missing === 1, noObsFeature.out && noObsFeature.out.manifest.observable)
  ok(
    'MEASURED OBSERVABLE MISSING fires, naming the piece',
    noObsFeature.out && noObsFeature.out.warnings.some((w) => /MEASURED OBSERVABLE MISSING/.test(w) && w.includes('p1')),
    noObsFeature.out && noObsFeature.out.warnings,
  )

  section('33 · MEASURED OBSERVABLE — FEATURE.JS, A REAL CHECK STAYS SILENT  (silent on the good one)')
  const withObsFeature = await run(
    { mode: 'build', pieces: [GOOD_PIECE], sharedPiece: GOOD_PLAN.sharedPiece, verify: false },
    {
      slackmaster: {
        results: [{ id: 'p1', verdict: 'built', filesTouched: ['a.ts'], observable: 'queried engagement_rank_log for owner_directive/manual — both codes now appear on live rows' }],
      },
    },
  )
  ok('no throw', !withObsFeature.err, withObsFeature.err && withObsFeature.err.message)
  ok('a named real-data check reads as checked: missing 0', withObsFeature.out && withObsFeature.out.manifest.observable.missing === 0, withObsFeature.out && withObsFeature.out.manifest.observable)
  ok(
    'MEASURED OBSERVABLE MISSING does NOT fire on the healthy path',
    withObsFeature.out && !withObsFeature.out.warnings.some((w) => /MEASURED OBSERVABLE MISSING/.test(w)),
    withObsFeature.out && withObsFeature.out.warnings,
  )

  section('34 · MEASURED OBSERVABLE — BUGGER.JS, THE SAME MECHANISM, THE SAME TWO DIRECTIONS')
  const noObsBugger = await runBugger({ issues: [BUG_ISSUE], verify: false }, { 'slackmaster(1)': { results: [{ id: 'b1', verdict: 'built', filesTouched: ['src/x.ts'] }] } })
  ok('no throw', !noObsBugger.err, noObsBugger.err && noObsBugger.err.message)
  ok(
    'the dispatch BRIEF itself carries the observable discipline  (fires on the bad input)',
    /BEFORE YOU RETURN `built`/.test(promptOf(noObsBugger.calls, 'slackmaster')),
    promptOf(noObsBugger.calls, 'slackmaster').slice(0, 400),
  )
  ok("manifest.observable.closed is the ENGINE'S OWN count, 1", noObsBugger.out && noObsBugger.out.manifest.observable.closed === 1, noObsBugger.out && noObsBugger.out.manifest.observable)
  ok('an OMITTED observable reads as missing:1, never a silent zero', noObsBugger.out && noObsBugger.out.manifest.observable.missing === 1, noObsBugger.out && noObsBugger.out.manifest.observable)
  ok(
    'MEASURED OBSERVABLE MISSING fires, naming the row',
    noObsBugger.out && noObsBugger.out.warnings.some((w) => /MEASURED OBSERVABLE MISSING/.test(w) && w.includes('b1')),
    noObsBugger.out && noObsBugger.out.warnings,
  )
  const withObsBugger = await runBugger(
    { issues: [BUG_ISSUE], verify: false },
    { 'slackmaster(1)': { results: [{ id: 'b1', verdict: 'built', filesTouched: ['src/x.ts'], observable: 'grepped maelle-2026-08-06.log — the reminder no longer fires twice on 6 real occurrences' }] } },
  )
  ok('no throw', !withObsBugger.err, withObsBugger.err && withObsBugger.err.message)
  ok('a named real-data check reads as checked: missing 0  (silent on the good one)', withObsBugger.out && withObsBugger.out.manifest.observable.missing === 0, withObsBugger.out && withObsBugger.out.manifest.observable)
  ok(
    'MEASURED OBSERVABLE MISSING does NOT fire on the healthy path',
    withObsBugger.out && !withObsBugger.out.warnings.some((w) => /MEASURED OBSERVABLE MISSING/.test(w)),
    withObsBugger.out && withObsBugger.out.warnings,
  )

  // ══════════════════════════════════════════════════════════════════════════
  // X186/X187/X188 — `ledger-stats.cjs --already-built`, the SCOPED query that
  // replaced hand-deriving `alreadyBuilt` from the whole ledger. Two facts have
  // to hold at once, proven against a CONTROLLED temp ledger (never the live
  // one) but the REAL, live git history — the same "against a copy" discipline
  // section 9 already uses, extended to git because the mechanism's whole
  // point is checking real wrap-commit dates: (1) a candidate is DROPPED once
  // either its own `state` says `wrapped` or a real wrap has landed since its
  // `date`, and (2) an entry that survives keeps its FULL shape — this is the
  // literal X188 regression, so it is asserted field-by-field, not just by count.
  // ══════════════════════════════════════════════════════════════════════════
  section('35 · `--already-built` — DROPS what shipped, KEEPS the rest with its full shape  (fires on the bad input, silent on the good one)')
  const abTmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'already-built-')), 'ledger.jsonl')
  // DERIVED, never literal — same discipline N/LANES already use above, for the
  // same reason. This was hardcoded '2026-08-09' ("a real wrap DID land on
  // 2026-08-09") and broke the moment the NEXT real wrap shipped (4.5.3,
  // 2026-08-10): the row correctly got swept as "a wrap landed after it", and
  // that correct behaviour read as a test failure because the fixture's own
  // premise had gone stale, not because the mechanism under test broke.
  const latestWrapDate = (() => {
    try {
      const log = execFileSync('git', ['-C', ROOT, 'log', '--format=%ad|%s', '--date=short'], { encoding: 'utf8' })
      const dates = log
        .split(/\r?\n/)
        .filter(Boolean)
        .filter((l) => /^\d{4}-\d{2}-\d{2}\|\d+\.\d+\.\d+(?![\w.])/.test(l))
        .map((l) => l.split('|')[0])
      return dates[0] || '2026-08-09' // git log is newest-first; [0] is the latest wrap
    } catch {
      return '2026-08-09' // no git history available — best-effort fallback, matches the old literal
    }
  })()
  const abRows = [
    // A wrap has landed many times since 2026-04-01 (the real repo's own history
    // starts 2026-04-20) — this row carries no wrap-companion of its own, so it
    // proves fact 2 (swept by a LATER wrap) alone, with no help from fact 1.
    { date: '2026-04-01', runId: 'test', lane: 'matchmaker', ref: 'fix-old-1', finding: 'old symptom one', rootCause: 'src/fake/path.ts:1', invariant: 'inv-old', verdict: 'built', state: 'built' },
    // No wrap will land after 2099 (this assertion is safe until then). Proves
    // the mechanism does not blindly drop everything, AND is the shape-fidelity
    // row: ref/symptom/rootCause/invariant/state must all survive verbatim.
    { date: '2099-01-01', runId: 'test', lane: 'matchmaker', ref: 'fix-future-1', finding: 'future symptom needing dedup', rootCause: 'src/fake/future.ts:2', invariant: 'inv-future', verdict: 'built', state: 'built' },
    // Both rows are dated in the future, so fact 2 (a wrap since) cannot fire on
    // EITHER — only fact 1 (the row's OWN latest state is `wrapped`) can explain
    // this one being dropped, isolating that half of the check.
    { date: '2099-02-01', runId: 'test', lane: 'gatekeeper', ref: 'fix-explicit-wrap', finding: 'explicit wrap symptom', rootCause: 'src/fake/wrapped.ts:3', verdict: 'built', state: 'built' },
    { date: '2099-02-02', runId: 'wrap-test', lane: 'gatekeeper', ref: 'fix-explicit-wrap', verdict: 'wrapped', state: 'wrapped', note: 'shipped in test' },
    // Dated on the ACTUAL latest real wrap day (derived above) — same-day is
    // NOT "after" (day-granularity, strict `>`), so this must survive. Proves the
    // check leans toward KEEPING on a same-day ambiguity, never toward dropping.
    { date: latestWrapDate, runId: 'test', lane: 'librarian', ref: 'fix-sameday', finding: 'same-day symptom', rootCause: 'src/fake/sameday.ts:4', verdict: 'built', state: 'built' },
    // No `ref` at all — must be silently ignored, never crash and never appear.
    { date: '2099-03-01', runId: 'test', lane: 'handyman', finding: 'refless symptom', verdict: 'built', state: 'built' },
    // Not a `built` verdict at all — excluded regardless of any date.
    { date: '2099-04-01', runId: 'test', lane: 'instructor', ref: 'fix-declined', finding: 'declined symptom', verdict: 'declined', state: 'declined' },
  ]
  fs.writeFileSync(abTmp, abRows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const abJson = JSON.parse(execFileSync(process.execPath, [STATS, '--already-built', '--json', '--ledger', abTmp], { encoding: 'utf8' }))
  const abByRef = new Map(abJson.map((r) => [r.ref, r]))
  ok('swept by a LATER wrap is dropped (fact 2 alone)', !abByRef.has('fix-old-1'), abJson.map((r) => r.ref))
  ok('an explicit `state:wrapped` companion is dropped (fact 1 alone, both dates future)', !abByRef.has('fix-explicit-wrap'), abJson.map((r) => r.ref))
  ok('not a `built` verdict — excluded regardless of date', !abByRef.has('fix-declined'), abJson.map((r) => r.ref))
  ok('no throw and no crash on a ref-less row; it never appears', abJson.every((r) => r.ref), abJson)
  ok('genuinely still open (no wrap after it) survives', abByRef.has('fix-future-1'), abJson.map((r) => r.ref))
  ok('same-day wrap is NOT "after" — leans toward KEEPING, never dropping', abByRef.has('fix-sameday'), abJson.map((r) => r.ref))
  const kept = abByRef.get('fix-future-1')
  ok('  …ref survives verbatim', kept && kept.ref === 'fix-future-1', kept)
  ok('  …symptom survives verbatim (E12 tier 3)', kept && kept.symptom === 'future symptom needing dedup', kept)
  ok('  …rootCause survives verbatim (E12 tier 2)', kept && kept.rootCause === 'src/fake/future.ts:2', kept)
  ok('  …invariant survives verbatim — X188 dropped exactly this field', kept && kept.invariant === 'inv-future', kept)
  ok('  …state survives verbatim', kept && kept.state === 'built', kept)
  ok('exactly the two genuinely-open refs reached the payload, nothing else', abJson.length === 2, abJson.map((r) => r.ref))
  const abText = execFileSync(process.execPath, [STATS, '--already-built', '--ledger', abTmp], { encoding: 'utf8' })
  ok('the human view reports the same count as the JSON view', new RegExp(`ALREADY-BUILT — ${abJson.length} of `).test(abText), abText.slice(0, 80))
  // `fix-explicit-wrap` never reaches the console-named drop list — it never
  // becomes a CANDIDATE at all (its collapsed verdict is already `wrapped`),
  // which is the same distinction the code makes: fact 1 resolves at the
  // ledger's own bookkeeping, fact 2 is what the printed list names by ref.
  ok('the human view names what fact 2 dropped, not just a count', /fix-old-1/.test(abText), abText)
}

main().then(
  () => {
    console.log(failed ? `\n${failed} FAILED, ${passed} passed.\n` : `\n${passed} assertions hold, in both directions — fires on the bad input, silent on the good one.\n`)
    process.exit(failed ? 1 : 0)
  },
  (e) => {
    console.error(`\nThe fixture itself threw — that is a failure, not a pass:\n${e && e.stack}\n`)
    process.exit(1)
  },
)
