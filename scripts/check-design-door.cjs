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

/** Run the engine with canned dispatch results. Returns {out, err, calls, logs}. */
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
// X151-fix (X159) · exact keys, matching the real labels feature.js emits
// today: `framer:backlog`, `framer:<ref>`, bare `framer` for decompose,
// `framer:contract` for the repair round, and a bare lane name for a build
// dispatch. `framer` is a PREFIX of the other three `framer:...` labels, so
// this only works because `run()`'s matcher checks every key for an EXACT
// match before it ever tries `startsWith` — every label the engine can
// produce has its own exact entry here, so that fallback is never reached.
const GOOD = { 'framer:backlog': INTAKE, 'framer:#154': RECON, framer: GOOD_PLAN }

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
  ok(`ONE recon dispatch, not ${N}`, calledPhase(d.calls, 'Recon').length === 1, d.calls.map((c) => c.label))
  ok('ONE item in the return', d.out && d.out.items && d.out.items.length === 1, d.out && d.out.items)
  ok(`all ${N} refs reached the recon prompt`, CLUSTER_ARGS.cluster.refs.every((r) => promptOfPhase(d.calls, 'Recon').includes(r.ref)), promptOfPhase(d.calls, 'Recon').length)
  ok('recon was told not to patch per row', /Do NOT design a patch per row/.test(promptOfPhase(d.calls, 'Recon')))
  ok('design block records what it absorbed', d.out && d.out.design && d.out.design.absorbs.length === N, d.out && d.out.design)
  ok('the join-back command is on the return', d.out && d.out.design && /design-cluster\.cjs gh#154 --decide/.test(d.out.design.joinBack), d.out && d.out.design && d.out.design.joinBack)

  section('2 · A `refs:` INVOCATION IS UNCHANGED  (silent on the good path)')
  const r = await run({ mode: 'plan', refs: ['#154'] }, GOOD)
  ok('no throw', !r.err, r.err && r.err.message)
  ok('the intake prompt is BYTE-IDENTICAL to the design run', promptOfPhase(r.calls, 'Intake') === promptOfPhase(d.calls, 'Intake'))
  ok('the intake dispatch options are identical', JSON.stringify(r.calls[0].opts) === JSON.stringify(d.calls[0].opts), r.calls[0].opts)
  ok('NO cluster block in the recon prompt', !/BUG ROWS ARE WAITING/.test(promptOfPhase(r.calls, 'Recon')))
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
  const b2 = await run({ mode: 'build', pieces: [GOOD_PIECE], sharedPiece: 'none', verify: false }, { slackmaster: { results: [{ id: 'p1', verdict: 'built' }] } })
  ok('`none` adds no shared-code line', !/WHO WRITES THE SHARED CODE/.test(promptOf(b2.calls, 'slackmaster')))

  section('7 · needsTicket CARRIES THE FINISHED BODY, NOT THE ASK')
  const desc = await run(
    { mode: 'plan', items: [{ title: 'Owner authority across chat surfaces', asks: 'decide what the clamp governs', priority: 'High' }] },
    { 'framer:new-1': { ...RECON, ref: 'new-1' }, framer: { ...GOOD_PLAN, pieces: [{ ...GOOD_PIECE, ref: 'new-1' }] } },
  )
  ok('no throw', !desc.err, desc.err && desc.err.message)
  ok('no intake dispatch on a described item', calledPhase(desc.calls, 'Intake').length === 0, desc.calls.map((c) => c.label))
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
  ok('  …before any recon', calledPhase(twoItems.calls, 'Recon').length === 0, twoItems.calls.map((c) => c.label))
  const bare = await run({ mode: 'plan', design: 'gh#154' }, GOOD)
  ok('a design run with NO cluster is allowed (a first-time design item)', !bare.err && bare.out.design.absorbs.length === 0, bare.err ? bare.err.message : bare.out.design)
  ok('  …and says the cluster was not passed', bare.logs.some((l) => /No cluster passed/.test(l)), bare.logs)

  section('9 · THE JOIN-BACK — against a COPY of the ledger, never the live one')
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'design-door-')), 'ledger.jsonl')
  fs.copyFileSync(LEDGER, tmp)
  const before = fs.readFileSync(tmp, 'utf8').split(/\r?\n/).filter(Boolean).length
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
  const openRefs = new Set([...openOut.matchAll(/^ {2}[A-Z][A-Z\- ]*?\[([^\]]+)\]/gm)].map((m) => m[1]))
  const claimedOpen = Number((openOut.match(/^OPEN — (\d+) row/m) || [])[1] || 0)
  ok(`the reader's own open count and its bracketed rows agree (${openRefs.size} of ${claimedOpen})`, openRefs.size === claimedOpen && claimedOpen > 0, { parsed: openRefs.size, claimed: claimedOpen })
  const leaked = CLUSTER_ARGS.cluster.refs.map((x) => x.ref).filter((ref) => openRefs.has(ref))
  ok(`none of the ${N} absorbed refs is an OPEN row`, leaked.length === 0, leaked)
  ok('`converted` is in the reader\'s CLOSED set', /const CLOSED = new Set\(\[[^\]]*'converted'/.test(fs.readFileSync(STATS, 'utf8')))
  console.log(`        (so a row appended with verdict \`converted\` stays hidden — both halves of the claim)`)
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
