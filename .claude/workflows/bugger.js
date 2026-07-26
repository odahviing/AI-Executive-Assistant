export const meta = {
  name: 'bugger',
  description:
    'Bugger — Maelle bug loop. Intake (open GitHub Bug issues + a 24h chat-quality review) -> lightweight atomic triage/routing -> build via the code lanes in parallel, then context last -> chain dependencies (ping-pong) -> optional guard-verify -> return a structured report. Builds in the working tree; NEVER commits (the owner wraps). The Manager invokes this and writes the results to disk.',
  phases: [
    { title: 'Intake' },
    { title: 'Triage' },
    { title: 'Locate' },
    { title: 'Build' },
    { title: 'Context' },
    { title: 'Verify' },
  ],
}

// ---- args (all optional; the Manager passes them) ----
const A = args || {}
const SOURCES = A.sources || ['github', 'logs'] // the one 19:00 run does BOTH; manual runs too
const SINCE = A.sinceIso || 'the last run' // watermark for the log review
const CAP = typeof A.capBuilds === 'number' ? A.capBuilds : 100 // severity-first build cap per run
// A pre-triaged list — the door from `report.md` back INTO the builder. Without
// it the parked items had no path in at all: intake reads GitHub and the logs,
// and neither can see the report. The owner would have had to re-file 30 issues
// by hand to act on his own review, which makes the review pointless.
// These are already lane-assigned, so intake and triage are skipped entirely —
// paying to re-derive routing he has already approved is pure waste.
const PRESET = Array.isArray(A.issues) && A.issues.length ? A.issues : null
// Symptoms already built and sitting UNCOMMITTED. Builds never deploy, so
// production keeps emitting the same tape every night and each unattended run
// re-finds bugs the previous one already fixed. The lane catches it and returns
// `already-fixed`, but only after a full dispatch — so tell triage up front.
const ALREADY_BUILT = Array.isArray(A.alreadyBuilt) ? A.alreadyBuilt : []
// COLLECT mode — find and record, build nothing. **Explicit opt-in only.**
// Building every night the owner is away IS the product: he leaves, the loop
// fixes, and the work is waiting for approval when he opens his laptop. An
// earlier version of this flag switched on automatically after two unreviewed
// nights "to save tokens" — which meant a three-day absence produced one night
// of fixes and two nights of homework, converting finished work back into a
// to-do list. Never select it from a timer or a staleness heuristic. Use it
// only when the owner asks for findings without work.
const MODE = A.mode === 'collect' ? 'collect' : 'full'
const VERIFY = A.verify !== false // guard-verify each built fix unless explicitly off
const CODE_LANES = ['meeting', 'requests', 'guard', 'people', 'slack', 'outer'] // run in parallel; context runs LAST, separately
const EFFORT = { meeting: 'xhigh', context: 'xhigh', slack: 'xhigh', requests: 'xhigh', outer: 'high', people: 'high', guard: 'high' } // reasoning effort per lane (owner-set)

// ---- schemas (force structured returns) ----
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['github', 'logs'] },
          ref: { type: 'string', description: 'github issue #, or a cited transcript moment' },
          symptom: { type: 'string' },
          evidence: { type: 'string', description: 'file:line or a quoted transcript moment — REQUIRED' },
          clarity: { type: 'string', enum: ['clear', 'ambiguous'] },
        },
        required: ['source', 'ref', 'symptom', 'evidence', 'clarity'],
      },
    },
  },
  required: ['findings'],
}

const ATOMIC = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          symptom: { type: 'string' },
          lane: { type: 'string', enum: ['meeting', 'requests', 'guard', 'context', 'people', 'slack', 'outer'] },
          whyHypothesis: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string' },
          clarity: { type: 'string', enum: ['clear', 'ambiguous'] },
        },
        required: ['id', 'symptom', 'lane', 'severity', 'clarity'],
      },
    },
  },
  required: ['issues'],
}

const VERDICTS = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: {
            type: 'string',
            enum: ['built', 'needs-dependency', 'blocked-charter', 'needs-owner-decision', 'already-fixed'],
          },
          rootCause: { type: 'string', description: 'file:line — proven, not guessed' },
          fix: { type: 'string', description: 'files touched, +/- lines, plain English' },
          // Forwarded to the verify so it spends its budget on what you did NOT
          // cover. Without it the verifier re-derives ground you already walked.
          traced: {
            type: 'string',
            description:
              'the scenarios you paper-traced and the ones you deliberately did NOT, one line each. Be honest about the gaps — an uncovered case named here gets checked by the verifier; one you quietly omit gets checked by nobody.',
          },
          dependencyAgent: { type: 'string', enum: ['meeting', 'requests', 'guard', 'context', 'people', 'slack', 'outer', ''] },
          dependencyAsk: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['id', 'verdict'],
      },
    },
  },
  required: ['results'],
}

// The verify returns its verdicts AND what it settled, so the next run can be
// told not to re-audit it. Nothing else persists that: the report is emptied at
// wrap, so today every pass starts from zero on ground an earlier one proved.
const VERIFY_OUT = {
  type: 'object',
  properties: {
    results: VERDICTS.properties.results,
    verifiedClean: {
      type: 'array',
      items: { type: 'string' },
      description:
        'what you PROVED correct and would not spend budget on again — one specific claim per line, each naming the file/behaviour and why it holds. Not "the meeting lane is fine": "checkSlot rule ordering is verdict-preserving — reordering a first-violation-wins ladder cannot change passes". Only claims you actually established; a false entry here silences a future check.',
    },
  },
  required: ['results'],
}

const LOCATED = {
  type: 'object',
  properties: {
    located: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'number' },
          excerpt: { type: 'string', description: 'the cited line with ~30 lines either side, verbatim' },
          neighbours: { type: 'string', description: 'who calls this / what it calls — names and file:line only, no prose' },
          notFound: { type: 'boolean', description: 'true if the citation does not resolve — say so, never guess a location' },
        },
        required: ['id'],
      },
    },
  },
  required: ['located'],
}

// ---- helpers ----
// `_where` is a STARTING POINT, never a substitute for reading the code. The
// framing below is load-bearing: an excerpt is a snapshot, the tree moves under
// it, and Shared rule 6 (never build on a claim you have not verified) applies to
// it exactly as it does to a hand-off from another lane. What the Locate pass
// removes is the SEARCH, not the reading.
const WHERE_NOTE =
  `\n\nSome issues carry \`_where\` — the cited location resolved for you, with an excerpt and its immediate neighbours. ` +
  `That is a STARTING POINT, not the truth: it is a snapshot taken before this dispatch, another lane may have moved the code since, ` +
  `and the citation itself came from triage and can be wrong. **Open the file and read it.** Per Shared rule 6, re-derive the defect from ` +
  `the code on disk before you build on it — if \`_where\` disagrees with what you find, the file wins and say so in your notes. ` +
  `What this saves you is hunting for the location, not verifying it.`

const dispatch = (lane, issues) =>
  agent(
    `You are dispatched a batch of atomic issues in your lane. For EACH: prove the root cause from code + logs (cite file:line), build the deep fix within your charter, run \`npm run typecheck\`, paper-trace to 100%. If unsure, do NOT build — return the right escalation verdict. Return one verdict per issue per your return contract.${issues.some((i) => i._where) ? WHERE_NOTE : ''}\nISSUES:\n${JSON.stringify(issues, null, 2)}`,
    { label: `build:${lane}`, phase: lane === 'context' ? 'Context' : 'Build', agentType: lane, effort: EFFORT[lane], schema: VERDICTS },
  )

const depAsksFor = (lane, rs) =>
  rs
    .filter((r) => r.verdict === 'needs-dependency' && r.dependencyAgent === lane)
    .map((r) => ({ id: `${r.id}>dep`, symptom: r.dependencyAsk, lane, severity: 'high', clarity: 'clear', from: r.id }))

// ---- 1. Intake (sources in parallel) — SKIPPED entirely for a preset list ----
let findings = []
let allIssues = []
if (PRESET) {
  log(`Preset: ${PRESET.length} pre-triaged issue(s) from the owner's review — skipping intake and triage.`)
  allIssues = PRESET
} else {
phase('Intake')
const intake = await parallel(
  SOURCES.map((src) => () => {
    if (src === 'github') {
      return agent(
        'Run ONLY this one command: `gh issue list --label Bug --state open --json number,title,body,labels` (read-only). Do NOT orient, read other files, or explore — just this command. SKIP any issue already labeled `Agent`. Return each remaining open bug as a finding {source:"github", ref:"#<number>", symptom:<title>, evidence:<body / any file:line it names>, clarity:"clear"}. If the list is empty, return {findings:[]} immediately.',
        { label: 'intake:github', phase: 'Intake', effort: 'low', model: 'haiku', schema: FINDINGS },
      )
    }
    return agent(
      `Review Maelle's conversations since ${SINCE} from logs/maelle-<today>.log (read-only). WORK CHEAP-FIRST — do NOT full-read every conversation.\n**0. ACTIVITY CHECK, BEFORE ANYTHING ELSE.** Count \`Orchestrator invoked\` events since ${SINCE}. If there are ZERO, she handled no turns — return {findings:[]} immediately and stop. Do not read further, do not scan, do not reason about it. Count that event specifically: \`Catch-up: scanning DMs\` is an idle heartbeat that fires whether or not anyone spoke, and reading it as activity is what made a zero-finding run cost 124k.\n1. Grep the log for HARD trouble signals (language-neutral): error/exception lines, guard fires (claimChecker/humanGate/dateVerifier/securityGate flagged or rewrote), "truncated at max_tokens", tool retries/failures, findAvailableSlots rejection breakdowns, approval-escalation misfires, abnormally long threads.\n2. Scan shallowly for SOFT signals that leave no error: a reply that doesn't match what was asked, an attendee/time/detail that silently changed between turns, a confidently-worded answer on a partial result.\n3. DEEP-read (full turns) ONLY the conversations that tripped step 1 or looked off in step 2.\nJudge those on four lenses: (1) was it good, (2) did the person get what they wanted, (3) did it feel human / make sense, (4) did the process work.\nVERY HARD BAR: surface a finding ONLY if it is an OBVIOUS, CLEAR bug, and you MUST cite the exact transcript moment as evidence. If not certain, set clarity:"ambiguous" (owner decides; never auto-fixed). Never invent issues from good chats. Return findings {source:"logs", ref, symptom, evidence:<quoted moment>, clarity}.`,
      { label: 'intake:logs', phase: 'Intake', effort: 'medium', model: 'sonnet', schema: FINDINGS },
    )
  }),
)
findings = intake.filter(Boolean).flatMap((r) => (r && r.findings) || [])
log(`Intake: ${findings.length} raw findings from ${SOURCES.join(' + ')}`)

// ---- 2. Triage: split into atomic issues + route (lightweight; the lane agent does the deep work) ----
phase('Triage')
const triaged = await agent(
  `Split these findings into ATOMIC issues and route each to a lane (meeting / requests / guard / context / people / slack / outer — \`context\` owns everything Maelle is TOLD (system prompt, tool descriptions, learned prefs) and runs LAST; \`requests\` owns the async work-item spine: approvals, outreach, reminders, follow-ups, timers/expiry and the requester close-loop; \`people\` owns identity, the person store, people memory and social; \`slack\` owns the transport — inbound routing, threading, DM/MPIM/channel behavior, authority-by-authenticated-sender, dedup/catch-up, the delivery pipeline; use \`other\` only for a subsystem NO lane owns: news, brief, routines, Graph plumbing, core orchestrator, DB, health, config, scripts). LIGHTWEIGHT only — id, symptom, lane, a why-hypothesis, severity, and carry clarity forward. Do NOT build the plan or prove the root cause; that is the lane agent's job.\nMERGE same-root issues: if two issues would be fixed by the SAME change / at the same place, emit ONE issue routed to the lane that owns the real fix. **When a GitHub issue and a log finding describe the same event, they are the same issue — merge them, and keep BOTH halves: the owner's own words are the ask (they carry his product judgment about what SHOULD have happened, which the transcript cannot), and the log moment is the evidence (it carries the proof, which his issue may not). Never let the merge drop his framing in favour of a bare symptom** — a lane handed "Maelle booked Friday" builds something different from one handed "Maelle booked Friday without asking me, and she should always ask before an off-day booking". NEVER split a flow defect into "the bug" + "a missing backstop guard for it" — that is ONE bug; route it to the flow lane (meeting / requests / people / slack / context / other). Only raise a GUARD-lane issue when a guard itself misfires, leaks, or is wrong — never as a backstop for a flow defect (the flow fix IS the fix).\n${
    ALREADY_BUILT.length
      ? `\n**ALREADY FIXED IN THE WORKING TREE, awaiting the owner's commit.** Builds are never deployed, so production keeps emitting the same symptom every night and the log review re-finds it. If a finding below is one of these, **DROP it** — do not emit an issue for it. Only keep it if the evidence shows something genuinely different from what was already fixed, and say what differs.\n${ALREADY_BUILT.map((s) => `  • ${s}`).join('\n')}\n`
      : ''
  }\nFINDINGS:\n${JSON.stringify(findings, null, 2)}`,
  { label: 'triage', phase: 'Triage', effort: 'low', model: 'sonnet', schema: ATOMIC },
)
allIssues = (triaged && triaged.issues) || []
}

// Ambiguous findings are shown to the owner, NEVER auto-built.
const flagged = allIssues.filter((i) => i.clarity === 'ambiguous')
let buildable = allIssues.filter((i) => i.clarity === 'clear')

// Severity-first cap so a heavy day cannot overrun the window; the rest is reported as pending.
const RANK = { high: 0, medium: 1, low: 2 }
buildable.sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3))
const pending = buildable.slice(CAP)
buildable = buildable.slice(0, CAP)
if (pending.length) log(`Cap ${CAP}: ${pending.length} lower-severity issues deferred to next run.`)
log(`Triage: ${buildable.length} clear to build, ${flagged.length} flagged for owner, ${pending.length} pending.`)
buildable.forEach((i) => log(`  • build [${i.lane}/${i.severity}] ${i.id} — ${(i.symptom || '').slice(0, 90)}`))
flagged.forEach((i) => log(`  • flagged-for-owner ${i.id} — ${(i.symptom || '').slice(0, 90)}`))

// ---- 2c. COLLECT mode stops here — found and recorded, nothing built ----
// Reached ONLY when the owner explicitly asked for findings without work. The
// default is and must stay `full`: he is away, so the fixes should exist by the
// time he is back. See the MODE comment above for why this must never be
// selected automatically.
if (MODE === 'collect') {
  log(`Collect mode: ${buildable.length} issue(s) recorded, ${flagged.length} flagged. NOTHING built — the owner batches these when he is back.`)
  return {
    mode: 'collect',
    counts: { findings: findings.length, atomic: allIssues.length, built: 0, needsOwner: 0, flagged: flagged.length, pending: 0 },
    results: [],
    collected: buildable, // pass straight back as `args.issues` to build them
    flagged,
    pending: [],
    verifiedClean: [],
  }
}

// ---- 2b. Locate — resolve the cited file:line ONCE, cheaply, for everyone ----
// Every builder used to open with the same hunt: grep, read a 1,400-line file,
// read the wrong one, find the thing, then read it properly. Six lanes each
// paying that discovery tax for locations triage already knew — measured at
// ~5,300 lines across the five files the scheduling lanes keep re-reading, and
// most of it re-read by several agents in the same run.
//
// One cheap pass resolves them all. This removes the SEARCH; the builder still
// reads and verifies (see WHERE_NOTE) — an excerpt that were trusted blind would
// just be the relay bug at framework scale.
//
// Skipped entirely when nothing carries a file citation (a pure log-review night),
// so it never costs anything on a run it cannot help.
const CITES_FILE = /[\w./-]+\.(?:ts|tsx|js|cjs|mjs|json|md|ya?ml)(?::\d+)?/i
const cited = buildable.filter((i) => CITES_FILE.test(i.evidence || ''))
if (cited.length) {
  phase('Locate')
  const loc = await agent(
    `Resolve each cited code location to an excerpt. **Read-only — change nothing, and do NOT diagnose, judge or fix anything.** You are a lookup pass, not a reviewer.\n\n` +
      `For each issue below, its \`evidence\` names a file (sometimes with a line). Open that file and return the cited line with **~30 lines either side, verbatim**, plus a \`neighbours\` string naming what calls it and what it calls — names and \`file:line\` only, no prose or opinion.\n\n` +
      `If a citation does not resolve — wrong path, line past the end of the file, or the code plainly is not what the evidence describes — set \`notFound: true\` and move on. **Never guess a location or substitute one you think is more likely**; a wrong excerpt sends a builder to the wrong place with false confidence, which is worse than sending it nowhere.\n\n` +
      `Work cheap: one targeted read per citation. Do not explore the codebase, do not follow interesting threads, do not read files nothing cited.\n\n` +
      `ISSUES:\n${JSON.stringify(cited.map((i) => ({ id: i.id, evidence: i.evidence, symptom: i.symptom })), null, 2)}`,
    { label: `locate(${cited.length})`, phase: 'Locate', effort: 'low', model: 'haiku', schema: LOCATED },
  )
  const found = new Map(((loc && loc.located) || []).filter((x) => x && x.id && !x.notFound && x.excerpt).map((x) => [x.id, x]))
  if (found.size) buildable = buildable.map((i) => (found.has(i.id) ? { ...i, _where: found.get(i.id) } : i))
  log(`Locate: ${found.size}/${cited.length} citation(s) resolved${found.size < cited.length ? ' — the rest the lanes will find themselves' : ''}.`)
}

// ---- 3. Build — code lanes in parallel (disjoint files, safe to run together) ----
phase('Build')
const codeOut = await parallel(
  CODE_LANES.map((lane) => () => {
    const b = buildable.filter((i) => i.lane === lane)
    return b.length ? dispatch(lane, b).then((r) => (r && r.results) || []) : null
  }),
)
let results = codeOut.filter(Boolean).flat()

// ---- 4. Context — LAST: its own issues + dependency asks raised by the code lanes ----
phase('Context')
const toContext = buildable.filter((i) => i.lane === 'context').concat(depAsksFor('context', results))
if (toContext.length) {
  const cr = await dispatch('context', toContext)
  results = results.concat((cr && cr.results) || [])
}

// ---- 4b. Close the loop on dependencies — BOTH directions, one bounded pass ----
// Two things happen here, and (b) used to not happen at all:
//   (a) a dependency context raised BACK to a code lane (rare).
//   (b) the ORIGINATING lane is re-dispatched to FINISH its own issue now that the
//       thing it was waiting on exists. Without this, A's issue sat at
//       `needs-dependency` forever: B built exactly what A asked for and nobody
//       ever told A, so the owner read a half-done wave as blocked. That is a
//       correctness hole, not just a wasted round trip.
// Both are batched per lane — one dispatch per lane, never one per issue — and the
// resume carries what the dependency lane ACTUALLY DID, so the originator spends
// its turn finishing rather than re-discovering.
const satisfied = new Map() // originating issue id -> the dependency result that closed it
for (const r of results) {
  if (r.verdict === 'built' && typeof r.id === 'string' && r.id.endsWith('>dep')) {
    satisfied.set(r.id.slice(0, -'>dep'.length), r)
  }
}
const resumes = results
  .filter((r) => r.verdict === 'needs-dependency' && satisfied.has(r.id))
  .map((r) => {
    const dep = satisfied.get(r.id)
    const orig = buildable.find((i) => i.id === r.id) || {}
    return {
      ...orig,
      id: r.id,
      lane: orig.lane || '',
      symptom: orig.symptom || r.notes || '',
      severity: orig.severity || 'high',
      clarity: 'clear',
      _dependencyResolved: {
        youAsked: `${r.dependencyAgent}: ${r.dependencyAsk || ''}`,
        theyDelivered: dep.fix || dep.notes || 'see the working tree',
        rootCause: dep.rootCause || '',
      },
    }
  })
const tail = CODE_LANES.flatMap((lane) => depAsksFor(lane, results))
if (tail.length || resumes.length) {
  phase('Build')
  if (resumes.length) log(`Dependencies closed: resuming ${resumes.length} originating issue(s) to finish.`)
  const round2 = await parallel(
    CODE_LANES.map((lane) => () => {
      const fresh = tail.filter((i) => i.lane === lane)
      const back = resumes.filter((i) => i.lane === lane)
      if (!fresh.length && !back.length) return null
      const note = back.length
        ? `\n\nSome of these carry \`_dependencyResolved\` — that issue is NOT new. You returned \`needs-dependency\` on it earlier in this run and the lane you named has now built what you asked for. FINISH your own fix. Per Shared rule 6, RE-DERIVE their change from the code before you build on it — do not trust the summary in the payload.`
        : ''
      return agent(
        `You are dispatched a batch of atomic issues in your lane. For EACH: prove the root cause from code + logs (cite file:line), build the deep fix within your charter, run \`npm run typecheck\`, paper-trace to 100%. If unsure, do NOT build — return the right escalation verdict. Return one verdict per issue per your return contract.${note}\nISSUES:\n${JSON.stringify([...fresh, ...back], null, 2)}`,
        { label: `build:${lane}${back.length ? ':resume' : ''}`, phase: 'Build', agentType: lane, effort: EFFORT[lane], schema: VERDICTS },
      ).then((r) => (r && r.results) || [])
    }),
  )
  const round2Results = round2.filter(Boolean).flat()
  // A resumed issue REPLACES its earlier needs-dependency row — same id, new verdict.
  const resumedIds = new Set(resumes.map((i) => i.id))
  const replaced = new Set(round2Results.filter((r) => resumedIds.has(r.id)).map((r) => r.id))
  results = results.filter((r) => !replaced.has(r.id)).concat(round2Results)
}

// ---- 5. Verify — ONE adversarial pass over the COMBINED diff, never one per fix ----
// This used to fan out N per-fix verifies. That shape is both more expensive and
// strictly blinder: a per-fix pass cannot see the only defect class that actually
// needs a verifier — two lanes whose fixes are each correct alone and wrong
// together. Every cross-lane defect this framework has caught came from a
// combined-diff pass (the 4.2.0 wrap; the 2026-07-26 checkSlot wave, where a
// combined pass caught a regression a fix had introduced ONE ROUND earlier).
// None came from a per-fix one. Going from N calls to 1 also pays for a stronger
// model on the single highest-judgment step in the loop — so `model` is omitted
// here deliberately, to inherit the session model rather than drop to sonnet.
phase('Verify')
let verified = results
let verifiedClean = []
if (VERIFY) {
  const built = results.filter((r) => r.verdict === 'built')
  if (built.length) {
    // Two things are forwarded so nothing is derived twice:
    //   • each fix's own `traced` — what the builder already walked, so the
    //     verifier attacks the GAPS instead of re-covering covered ground.
    //   • `priorClean` — what earlier verifies proved, carried in by the Manager
    //     from the report. Without it every pass re-audits settled ground.
    // Both are leads, not truth: a builder's coverage claim and a past pass's
    // conclusion are exactly the kind of relay Shared rule 6 exists for, and the
    // prompt says so. Spot-check cheaply; spend the budget on what is NOT there.
    const priorClean = Array.isArray(A.priorClean) ? A.priorClean : []
    const check = await agent(
      `Adversarially verify this wave's COMBINED change before the owner wraps it. **Findings only — build nothing, edit nothing, commit nothing.**\n\n` +
        `Calibrate to ONE question: **is this safe to ship to real people?** Not "what could be better." A finding that makes Maelle lie, leak, or take a wrong action counts. A finding that makes the code nicer does not.\n\n` +
        `**Attack the seams first — that is why this is one pass and not ${built.length}.** Each fix below was already built and self-checked by the lane that owns it, so re-litigating one in isolation is wasted effort. What no lane could see is the interaction: two fixes that are each correct alone and wrong together, a shared helper one lane changed and another depends on, a contract altered on one side of a seam only, or a fix whose own change introduced a regression a later fix then built on.\n\n` +
        `**Each fix carries \`traced\` — the scenarios its builder already walked. Do not re-run those. Go at what is missing from that list**, and at anything the builder named as deliberately uncovered. If a \`traced\` claim looks wrong, spot-check that one cheaply and say so; do not re-derive the whole set on suspicion.\n\n` +
        (priorClean.length
          ? `**ALREADY PROVEN by earlier verify passes — do NOT re-audit these.** They are excluded so your budget goes somewhere new. If the current diff genuinely invalidates one, say which and why; otherwise treat it as settled:\n${priorClean.map((c) => `  • ${c}`).join('\n')}\n\n`
          : '') +
        `Read the ACTUAL diff (\`git diff\`, \`git status\`) — verify against the code on disk, never against the summaries below. Those summaries are the lanes' own claims about their work; treat them as leads. Confirm \`npx tsc --noEmit\` is green.\n\n` +
        `**Budget: keep this under ~60 tool calls.** If the diff is too large to cover at that depth, say so and name what you did NOT cover rather than thinning every check to nothing. An honest gap beats uniform shallowness.\n\n` +
        `Return one row per issue id: \`built\` if that fix holds in combination with all the others, otherwise \`needs-owner-decision\` with notes saying precisely what breaks and how. If a fix is fine alone but broken by another, flag the one that should change and say why.\n\n` +
        `Also return \`verifiedClean\`: what you PROVED and would not spend budget on again. The next run is told not to re-check it, so put nothing there you did not actually establish — a false entry silences a future check permanently.\n\n` +
        `FIXES IN THIS WAVE:\n${JSON.stringify(built, null, 2)}`,
      { label: `verify:wave(${built.length})`, phase: 'Verify', agentType: 'guard', effort: 'xhigh', schema: VERIFY_OUT },
    )
    verifiedClean = (check && check.verifiedClean) || []
    const overturned = new Map(
      ((check && check.results) || [])
        .filter((x) => x.verdict && x.verdict !== 'built')
        .map((x) => [x.id, x.notes || '']),
    )
    verified = results.map((r) =>
      overturned.has(r.id)
        ? {
            ...r,
            verdict: 'needs-owner-decision',
            notes: `${r.notes || ''} [wave-verify overturned: ${overturned.get(r.id)}]`.trim(),
          }
        : r,
    )
  }
}

// ---- return the structured report; the Manager persists it (workflow scripts have no filesystem) ----
return {
  counts: {
    findings: findings.length,
    atomic: allIssues.length,
    built: verified.filter((r) => r.verdict === 'built').length,
    needsOwner: verified.filter((r) => r.verdict === 'needs-owner-decision' || r.verdict === 'blocked-charter').length,
    flagged: flagged.length,
    pending: pending.length,
  },
  results: verified,
  flagged,
  pending,
  // Persist under "Verified clean" in report.md and pass straight back as
  // `priorClean` next run. It is the only thing that stops each verify starting
  // from zero on ground an earlier one already proved.
  verifiedClean,
}
