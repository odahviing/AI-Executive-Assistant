export const meta = {
  name: 'bugger',
  description:
    'Bugger — Maelle bug loop. Intake (open GitHub Bug issues + a 24h chat-quality review) -> lightweight atomic triage/routing -> build via the code lanes in parallel, then context last -> chain dependencies (ping-pong) -> optional guard-verify -> return a structured report. Builds in the working tree; NEVER commits (the owner wraps). The Manager invokes this and writes the results to disk.',
  phases: [
    { title: 'Intake' },
    { title: 'Triage' },
    { title: 'Build' },
    { title: 'Context' },
    { title: 'Verify' },
  ],
}

// ---- args (all optional; the Manager passes them) ----
const A = args || {}
const SOURCES = A.sources || ['github', 'logs'] // the one 19:00 run does BOTH; manual runs too
const SINCE = A.sinceIso || 'the last run' // watermark for the log review
const CAP = typeof A.capBuilds === 'number' ? A.capBuilds : 25 // severity-first build cap per run
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

// ---- helpers ----
const dispatch = (lane, issues) =>
  agent(
    `You are dispatched a batch of atomic issues in your lane. For EACH: prove the root cause from code + logs (cite file:line), build the deep fix within your charter, run \`npm run typecheck\`, paper-trace to 100%. If unsure, do NOT build — return the right escalation verdict. Return one verdict per issue per your return contract.\nISSUES:\n${JSON.stringify(issues, null, 2)}`,
    { label: `build:${lane}`, phase: lane === 'context' ? 'Context' : 'Build', agentType: lane, effort: EFFORT[lane], schema: VERDICTS },
  )

const depAsksFor = (lane, rs) =>
  rs
    .filter((r) => r.verdict === 'needs-dependency' && r.dependencyAgent === lane)
    .map((r) => ({ id: `${r.id}>dep`, symptom: r.dependencyAsk, lane, severity: 'high', clarity: 'clear', from: r.id }))

// ---- 1. Intake (sources in parallel) ----
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
      `Review Maelle's conversations since ${SINCE} from logs/maelle-<today>.log (read-only). WORK CHEAP-FIRST — do NOT full-read every conversation.\n1. Grep the log for HARD trouble signals (language-neutral): error/exception lines, guard fires (claimChecker/humanGate/dateVerifier/securityGate flagged or rewrote), "truncated at max_tokens", tool retries/failures, findAvailableSlots rejection breakdowns, approval-escalation misfires, abnormally long threads.\n2. Scan shallowly for SOFT signals that leave no error: a reply that doesn't match what was asked, an attendee/time/detail that silently changed between turns, a confidently-worded answer on a partial result.\n3. DEEP-read (full turns) ONLY the conversations that tripped step 1 or looked off in step 2.\nJudge those on four lenses: (1) was it good, (2) did the person get what they wanted, (3) did it feel human / make sense, (4) did the process work.\nVERY HARD BAR: surface a finding ONLY if it is an OBVIOUS, CLEAR bug, and you MUST cite the exact transcript moment as evidence. If not certain, set clarity:"ambiguous" (owner decides; never auto-fixed). Never invent issues from good chats. Return findings {source:"logs", ref, symptom, evidence:<quoted moment>, clarity}.`,
      { label: 'intake:logs', phase: 'Intake', effort: 'medium', model: 'sonnet', schema: FINDINGS },
    )
  }),
)
const findings = intake.filter(Boolean).flatMap((r) => (r && r.findings) || [])
log(`Intake: ${findings.length} raw findings from ${SOURCES.join(' + ')}`)

// ---- 2. Triage: split into atomic issues + route (lightweight; the lane agent does the deep work) ----
phase('Triage')
const triaged = await agent(
  `Split these findings into ATOMIC issues and route each to a lane (meeting / requests / guard / context / people / slack / outer — \`context\` owns everything Maelle is TOLD (system prompt, tool descriptions, learned prefs) and runs LAST; \`requests\` owns the async work-item spine: approvals, outreach, reminders, follow-ups, timers/expiry and the requester close-loop; \`people\` owns identity, the person store, people memory and social; \`slack\` owns the transport — inbound routing, threading, DM/MPIM/channel behavior, authority-by-authenticated-sender, dedup/catch-up, the delivery pipeline; use \`other\` only for a subsystem NO lane owns: news, brief, routines, Graph plumbing, core orchestrator, DB, health, config, scripts). LIGHTWEIGHT only — id, symptom, lane, a why-hypothesis, severity, and carry clarity forward. Do NOT build the plan or prove the root cause; that is the lane agent's job.\nMERGE same-root issues: if two issues would be fixed by the SAME change / at the same place, emit ONE issue routed to the lane that owns the real fix. NEVER split a flow defect into "the bug" + "a missing backstop guard for it" — that is ONE bug; route it to the flow lane (meeting / requests / people / slack / context / other). Only raise a GUARD-lane issue when a guard itself misfires, leaks, or is wrong — never as a backstop for a flow defect (the flow fix IS the fix).\nFINDINGS:\n${JSON.stringify(findings, null, 2)}`,
  { label: 'triage', phase: 'Triage', effort: 'low', model: 'sonnet', schema: ATOMIC },
)
const allIssues = (triaged && triaged.issues) || []

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

// ---- 4b. Tail — any dependency context raised back to a code lane (rare; one bounded pass) ----
const tail = CODE_LANES.flatMap((lane) => depAsksFor(lane, results))
if (tail.length) {
  phase('Build')
  const tailOut = await parallel(
    CODE_LANES.map((lane) => () => {
      const b = tail.filter((i) => i.lane === lane)
      return b.length ? dispatch(lane, b).then((r) => (r && r.results) || []) : null
    }),
  )
  results = results.concat(tailOut.filter(Boolean).flat())
}

// ---- 5. Verify (optional) — guard adversarially checks each BUILT fix before it counts as done ----
phase('Verify')
let verified = results
if (VERIFY) {
  const built = results.filter((r) => r.verdict === 'built')
  const checks = await parallel(
    built.map((r) => () =>
      agent(
        `Adversarially verify this BUILT fix against the code on disk: does it regress a correct behavior or bend a charter rule? Read the actual diff. Return results:[{id, verdict:"built" if it holds, otherwise "needs-owner-decision" with notes on why}].\nFIX:\n${JSON.stringify(r)}`,
        { label: `verify:${r.id}`, phase: 'Verify', agentType: 'guard', effort: EFFORT.guard, model: 'sonnet', schema: VERDICTS },
      ),
    ),
  )
  const overturned = new Set(
    checks
      .filter(Boolean)
      .flatMap((c) => (c.results || []).filter((x) => x.verdict !== 'built').map((x) => x.id)),
  )
  verified = results.map((r) =>
    overturned.has(r.id)
      ? { ...r, verdict: 'needs-owner-decision', notes: `${r.notes || ''} [guard-verify overturned]`.trim() }
      : r,
  )
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
}
