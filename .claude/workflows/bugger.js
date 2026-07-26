export const meta = {
  name: 'bugger',
  description:
    'Bugger — builds a set of atomic issues across SEVERAL lanes, with dependency hand-off and ONE combined verify. Pass `args.issues` (already lane-assigned, e.g. rows the owner approved from report.md) and it goes straight to work — intake and triage are SKIPPED. Only pass `args.sources` for the nightly discovery run, which is the sole case needing a GitHub pull or a 24h log review. For ONE lane whose items are already known, do NOT use this at all — dispatch that lane directly with the Agent tool; the pipeline buys nothing and costs a full intake. Core loop: rounds of [code lanes in parallel -> context last] until no dependency asks remain, then one adversarial verify over the combined diff. Builds in the working tree; NEVER commits (the owner wraps).',
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
// Bugs already FIXED but not yet in the running build. Production keeps
// emitting the same tape until a fix is deployed, so every unattended night the
// log review honestly re-finds work the previous run already did. The lane does
// catch it and return `already-fixed` — but only after a full dispatch, which is
// the whole cost of the bug paid again for no result.
//
// Read from `ledger.jsonl`, which is why each line carries a `ref` and a proven
// `rootCause`: prose alone makes this a fuzzy guess, a ref makes it a lookup.
// Shape: [{ref, symptom, rootCause, state}].
const ALREADY_BUILT = Array.isArray(A.alreadyBuilt) ? A.alreadyBuilt : []
const describeBuilt = (b) =>
  typeof b === 'string'
    ? `  • ${b}`
    : `  • ${b.ref ? `**ref ${b.ref}** — ` : ''}${b.symptom || '(no symptom)'}` +
      `${b.rootCause ? `\n      root cause already fixed at: ${b.rootCause}` : ''}` +
      `${b.state === 'awaiting-owner' ? `\n      **state: awaiting-owner — DROP any finding for this ref, even if more work looks available**` : ''}`
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
    // ── SELF-REPORT ─────────────────────────────────────────────────────────
    // Every silent failure this engine has had was a mechanism that did nothing
    // and looked like success: the watermark never filtered, the activity exit
    // never fired, the Agent label never matched, dependency asks vanished into
    // a `built` verdict. None was caught for weeks because nothing ever asserted
    // that a step had actually happened.
    //
    // So each step now REPORTS ITS OWN WORK as numbers, and the run manifest
    // prints them. A no-op stops being invisible and becomes a zero in a column
    // where a zero is obviously wrong. These are diagnostics, never inputs to a
    // decision — nothing branches on them.
    cutoffLine: {
      type: 'number',
      description: 'log-review only: the line number the review STARTED from, after converting the watermark to UTC. 1 means the filter did nothing — the failure being watched for.',
    },
    cutoffUtc: { type: 'string', description: 'log-review only: the UTC instant you actually compared against, so a timezone slip is visible' },
    turnsAfterCutoff: { type: 'number', description: 'log-review only: `Orchestrator invoked` events counted AFTER the cutoff (not in the whole file)' },
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
    // Self-report, same reason as FINDINGS above. `alreadyBuilt` was passed six
    // entries on 2026-07-26 and dropped none of the two that mattered, because
    // `gh#147` never string-matched `#147`. Nothing noticed, because nothing was
    // counting. Now the count is printed next to the number passed in.
    droppedAsAlreadyBuilt: {
      type: 'array',
      items: { type: 'string' },
      description: 'the ref or symptom of every finding you dropped because it is already fixed. Empty array if none — do NOT omit the field, an omission is indistinguishable from "the check did not run".',
    },
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
          // KIND is what drives cost, not count. 15-20 atomic items is a normal
          // night; ONE product-shaped item can dominate it — issue 41 cost 411k
          // across four lanes on 2026-07-26, and #147 arrived as a bug but was a
          // design change whose stated premise was false in the code.
          kind: {
            type: 'string',
            enum: ['atomic', 'needs-shaping'],
            description:
              "`atomic` = known root, ONE lane, one edit — dispatch it. `needs-shaping` = it touches TWO OR MORE lanes, or the fix is a product decision rather than a repair, or the issue's premise does not survive contact with the code. A `needs-shaping` item is NOT dispatched: it goes to the owner with a proposed shape so he rules before a lane spends anything. Dispatching one as a bug does not fail loudly — it ping-pongs across lanes, burns the night, and still ends up needing his judgement afterwards, which is the most expensive possible order.",
          },
          shapingQuestion: {
            type: 'string',
            description: 'needs-shaping only: the ONE thing the owner must decide, in a sentence he can answer. Plus what you checked in the code that the issue got wrong, if anything.',
          },
          evidence: { type: 'string' },
          clarity: { type: 'string', enum: ['clear', 'ambiguous'] },
        },
        required: ['id', 'symptom', 'lane', 'severity', 'clarity', 'kind'],
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

// A dependency ask is real work REGARDLESS of what the lane concluded about its
// own issue. This filter used to require `verdict === 'needs-dependency'`, which
// silently discarded any ask attached to a `built` verdict — and "I finished my
// part, and this adjacent piece belongs to another lane" is the COMMON case, not
// the rare one.
//
// Measured on run wf_6b869440-ef7: five asks were attached, ONE was dispatched.
// The four dropped included a dead-code deletion, a tool-tape rendering fix, a
// prompt-guidance gap that materially strengthened the fix it belonged to, and
// the verify's own prescription for a harm it had just proved. All four looked
// like success in the report because their parent issues said `built`.
const DISPATCHABLE_DEP = new Set(['built', 'needs-dependency', 'already-fixed'])
const hasAsk = (r) => r.dependencyAgent && String(r.dependencyAsk || '').trim().length > 0
const depAsksFor = (lane, rs) =>
  rs
    .filter((r) => hasAsk(r) && r.dependencyAgent === lane && DISPATCHABLE_DEP.has(r.verdict))
    .map((r) => ({ id: `${r.id}>dep`, symptom: r.dependencyAsk, lane, severity: 'high', clarity: 'clear', from: r.id, fromVerdict: r.verdict }))

// Asks the engine must NOT auto-dispatch: the parent verdict is itself waiting
// on the owner (`needs-owner-decision` / `blocked-charter`), so building the
// dependency could implement something he is about to decline. These are
// RETURNED rather than executed — which is the actual fix here. The bug was
// never that they went undispatched; it was that they went unmentioned.
const deferredDepAsks = (rs) =>
  rs
    .filter((r) => hasAsk(r) && !DISPATCHABLE_DEP.has(r.verdict))
    .map((r) => ({ from: r.id, fromVerdict: r.verdict, lane: r.dependencyAgent, ask: r.dependencyAsk }))

// ---- 1. Intake (sources in parallel) — SKIPPED entirely for a preset list ----
let findings = []
let allIssues = []
let triageDropped = []
let locateStats = { cited: 0, resolved: 0 }
if (PRESET) {
  log(`Preset: ${PRESET.length} pre-triaged issue(s) from the owner's review — skipping intake and triage.`)
  allIssues = PRESET
} else {
phase('Intake')
const intake = await parallel(
  SOURCES.map((src) => () => {
    if (src === 'github') {
      return agent(
        'Run ONLY this one command: `gh issue list --label Bug --state open --json number,title,body,labels` (read-only). Do NOT orient, read other files, or explore — just this command. Skip any issue labelled `Agent` **if you see one** — that label does not currently exist in this repo, so expect it never to match; de-duplication is handled downstream by the ledger, not here, so do NOT go looking for another way to filter. Return each remaining open bug as a finding {source:"github", ref:"#<number>", symptom:<title>, evidence:<body **plus any file:line the body names, quoted verbatim** — the triage and Locate passes downstream can only use a citation you actually carry through>, clarity:"clear"}. If the list is empty, return {findings:[]} immediately.',
        { label: 'intake:github', phase: 'Intake', effort: 'low', model: 'haiku', schema: FINDINGS },
      )
    }
    return agent(
      `Review Maelle's conversations from logs/maelle-<today>.log (read-only). WORK CHEAP-FIRST — do NOT full-read every conversation.\n\n` +
      `**0. ESTABLISH THE CUTOFF, MECHANICALLY, BEFORE READING ANYTHING.** The watermark is \`${SINCE}\`.\n` +
      `  a. **Convert it to UTC first.** The watermark carries a local offset (e.g. \`+0300\`); every log line is UTC with a \`Z\`. \`2026-07-26T18:22:00+0300\` is \`2026-07-26T15:22:00Z\`. **Comparing the two as text without converting is wrong and silently reviews the whole day** — that is a real bug this instruction exists to prevent, measured at ~430k wasted tokens on 2026-07-26 when an 18:22 watermark let 04:32Z lines through.\n` +
      `  b. Find the **line number** of the first entry whose \`"timestamp"\` is >= that UTC instant. Everything above it is ALREADY REVIEWED — it is not yours, and re-finding a bug from it produces a duplicate the owner has seen.\n` +
      `  c. **Every grep and every read you do from here on must be bounded to that line number onward** (e.g. \`tail -n +<line>\`, or check the timestamp of each hit and discard earlier ones). A finding you cannot tie to a line at or after the cutoff must be dropped, however real it looks.\n` +
      `  **Report all three in your return: \`cutoffLine\` (the line you started at), \`cutoffUtc\` (the instant you compared against), \`turnsAfterCutoff\`.** These are printed in the run manifest so a filter that did nothing is visible as \`startedAtLine: 1\`. Omitting them is treated as "the watermark cannot be verified".\n` +
        `  d. **ACTIVITY CHECK:** count \`Orchestrator invoked\` events **after the cutoff only**. If ZERO, she handled no turns since the last review — return {findings:[]} immediately and stop. Do not scan, do not reason further. Count that event specifically: \`Catch-up: scanning DMs\` is an idle heartbeat that fires whether or not anyone spoke, and reading it as activity is what made a zero-finding run cost 124k. Counting the whole file instead of the tail defeats this entirely — today's file holds 53 such events, so an unbounded count always looks busy.\n\n1. Grep the log for HARD trouble signals (language-neutral): error/exception lines, guard fires (claimChecker/humanGate/dateVerifier/securityGate flagged or rewrote), "truncated at max_tokens", tool retries/failures, findAvailableSlots rejection breakdowns, approval-escalation misfires, abnormally long threads.\n2. Scan shallowly for SOFT signals that leave no error: a reply that doesn't match what was asked, an attendee/time/detail that silently changed between turns, a confidently-worded answer on a partial result.\n3. DEEP-read (full turns) ONLY the conversations that tripped step 1 or looked off in step 2.\nJudge those on four lenses: (1) was it good, (2) did the person get what they wanted, (3) did it feel human / make sense, (4) did the process work.\nVERY HARD BAR: surface a finding ONLY if it is an OBVIOUS, CLEAR bug, and you MUST cite the exact transcript moment as evidence. If not certain, set clarity:"ambiguous" (owner decides; never auto-fixed). Never invent issues from good chats. Return findings {source:"logs", ref, symptom, evidence:<quoted moment>, clarity}.`,
      { label: 'intake:logs', phase: 'Intake', effort: 'medium', model: 'sonnet', schema: FINDINGS },
    )
  }),
)
// Capture the log review's self-report BEFORE the findings are flattened, so the
// manifest can show whether the watermark actually cut anything.
const logReport = intake.filter(Boolean).find((r) => r && typeof r.cutoffLine === 'number') || {}
findings = intake.filter(Boolean).flatMap((r) => (r && r.findings) || [])
log(`Intake: ${findings.length} raw findings from ${SOURCES.join(' + ')}`)

// ---- 2. Triage: split into atomic issues + route (lightweight; the lane agent does the deep work) ----
phase('Triage')
const triaged = await agent(
  `Split these findings into ATOMIC issues and route each to a lane (meeting / requests / guard / context / people / slack / outer — \`context\` owns everything Maelle is TOLD (system prompt, tool descriptions, learned prefs) and runs LAST; \`requests\` owns the async work-item spine: approvals, outreach, reminders, follow-ups, timers/expiry and the requester close-loop; \`people\` owns identity, the person store, people memory and social; \`slack\` owns the transport — inbound routing, threading, DM/MPIM/channel behavior, authority-by-authenticated-sender, dedup/catch-up, the delivery pipeline; use \`other\` only for a subsystem NO lane owns: news, brief, routines, Graph plumbing, core orchestrator, DB, health, config, scripts). LIGHTWEIGHT only — id, symptom, lane, a why-hypothesis, severity, and carry clarity forward. Do NOT build the plan or prove the root cause; that is the lane agent's job.\n**CLASSIFY \`kind\` on every issue — this is the single most consequential call you make.** \`atomic\` = known root, ONE lane, one edit; dispatch it, and fifteen of these is a normal night. \`needs-shaping\` = it touches TWO OR MORE lanes, OR the fix is a product decision rather than a repair, OR the issue's premise looks wrong against the code. A \`needs-shaping\` item is **NOT built** — it goes to the owner with a \`shapingQuestion\` he can answer in a sentence. **Err toward \`needs-shaping\` when unsure:** a wrongly-shaped item costs one question, a wrongly-dispatched one ping-pongs across lanes and burns the night before landing back on his desk anyway. Measured 2026-07-26: one such item cost 411k across four lanes, and another arrived as a bug whose stated premise was false in the code, so the fix was nothing like what the issue asked for.\nMERGE same-root issues: if two issues would be fixed by the SAME change / at the same place, emit ONE issue routed to the lane that owns the real fix. **When a GitHub issue and a log finding describe the same event, they are the same issue — merge them, and keep BOTH halves: the owner's own words are the ask (they carry his product judgment about what SHOULD have happened, which the transcript cannot), and the log moment is the evidence (it carries the proof, which his issue may not). Never let the merge drop his framing in favour of a bare symptom** — a lane handed "Maelle booked Friday" builds something different from one handed "Maelle booked Friday without asking me, and she should always ask before an off-day booking". NEVER split a flow defect into "the bug" + "a missing backstop guard for it" — that is ONE bug; route it to the flow lane (meeting / requests / people / slack / context / other). Only raise a GUARD-lane issue when a guard itself misfires, leaks, or is wrong — never as a backstop for a flow defect (the flow fix IS the fix).\n${
    ALREADY_BUILT.length
      ? `\n**ALREADY FIXED, not yet in the running build.** Production keeps emitting these symptoms until the owner deploys, so the log review honestly re-finds them every night. **DROP any finding that matches one of these — do not emit an issue for it.** Dispatching it costs a full lane turn to be told "already-fixed", which is the entire price of the bug paid again for nothing.\n\n` +
        `**(1) MATCH THE \`ref\` FIRST, and treat these as the SAME ref: \`#147\` = \`gh#147\` = \`147\`.** A GitHub finding's ref is bare (\`#147\`); the ledger stores it prefixed (\`gh#147\`). They are one issue. This exact-match step is the reliable one — do it before you think about the wording at all.\n\n` +
        `**(2) Then the root cause** — a finding whose evidence points into the same file:line as a \`rootCause\` below is the same bug.\n\n` +
        `**Report every ref you drop in \`droppedAsAlreadyBuilt\`, and return an empty array if you drop none.** Omitting the field is indistinguishable from never running this check, which is how the check silently failed before.\n\n` +
        `**(3) Then the same user-visible failure described differently.** A symptom reads differently every night, and — this is the trap — **you will naturally form your OWN hypothesis about the cause, which will not match the hypothesis in the entry below.** That difference is not evidence of a different bug. Judge by what the PERSON experienced, never by whether your theory matches theirs. On 2026-07-26 both #147 and #148 slipped through this way: triage re-derived a fresh (and reasonable) theory for each, decided they looked new, and each cost a full lane dispatch to be told "already-fixed".\n\n` +
        `Keep one only if it is genuinely a DIFFERENT failure that merely looks similar — and then say in \`whyHypothesis\` what distinguishes it from the entry it resembles, so a lane is not sent to re-fix a fix.\n\n` +
        `**Special case — an entry marked \`state: "awaiting-owner"\`: DROP the finding and do not emit an issue, even if you can see remaining work.** Its fix is built but the owner has not accepted it. Building more on top of a decision he may reverse compounds the problem instead of helping.\n${ALREADY_BUILT.map(describeBuilt).join('\n')}\n`
      : ''
  }\nFINDINGS:\n${JSON.stringify(findings, null, 2)}`,
  { label: 'triage', phase: 'Triage', effort: 'low', model: 'sonnet', schema: ATOMIC },
)
allIssues = (triaged && triaged.issues) || []
triageDropped = (triaged && triaged.droppedAsAlreadyBuilt) || []
}

// A lane name outside the known set means the issue matches no lane in the Build
// phase and no `context` pass either — it is silently dropped. That happened on
// 2026-07-25: triage emitted lane `general`, which does not exist. It was
// harmless only because that issue was flagged for the owner and never
// dispatched. Route the unknown to `outer` (the catch-all, by definition) and
// SAY SO, rather than losing the issue to a typo.
const KNOWN_LANES = new Set([...CODE_LANES, 'context'])
const misrouted = allIssues.filter((i) => !KNOWN_LANES.has(i.lane))
if (misrouted.length) {
  log(`! Triage emitted ${misrouted.length} unknown lane(s): ${misrouted.map((i) => `${i.id}→"${i.lane}"`).join(', ')} — re-routed to outer so they are not silently dropped.`)
  misrouted.forEach((i) => {
    i.notes = `[re-routed from unknown lane "${i.lane}"] ${i.notes || ''}`.trim()
    i.lane = 'outer'
  })
}

// Ambiguous findings are shown to the owner, NEVER auto-built.
// A `needs-shaping` item is NOT dispatched. It spans lanes, or its fix is a
// product call, or the issue's premise did not survive the code — so the owner
// rules on the SHAPE before a lane spends anything. Dispatching one as a bug
// does not fail loudly: it ping-pongs, burns the night, and still lands on his
// desk needing judgement, which is the most expensive possible order.
// A PRESET item is exempt — he has already approved that routing by naming it.
const needsShaping = PRESET ? [] : allIssues.filter((i) => i.kind === 'needs-shaping' && i.clarity === 'clear')
const flagged = allIssues.filter((i) => i.clarity === 'ambiguous')
let buildable = allIssues.filter((i) => i.clarity === 'clear' && !needsShaping.includes(i))
if (needsShaping.length) {
  log(`${needsShaping.length} item(s) need SHAPING before anyone builds — not dispatched:`)
  needsShaping.forEach((i) => log(`  ? ${i.id} [${i.lane}] ${i.shapingQuestion || i.symptom}`))
}

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
  locateStats = { cited: cited.length, resolved: found.size }
  log(`Locate: ${found.size}/${cited.length} citation(s) resolved${found.size < cited.length ? ' — the rest the lanes will find themselves' : ''}.`)
}

// ---- 3. THE BUILD LOOP — rounds until nothing is pending ------------------
// Replaces a fixed Build → Context → single-tail sequence, which capped
// dependency chains at DEPTH TWO: a lane raised an ask, the tail round built it,
// and if that lane raised a NEW ask nothing ever read it. With six asks already
// lost tonight to a filter, a silent depth limit is the next quiet loss waiting.
//
// Each round: every lane with pending work builds in parallel, `context` runs
// LAST within the round, then the asks and resumes that round produced become the
// next round's pending work. `feature.js` already proved this shape; bugger kept
// the older fixed one, so the two engines behaved differently for no reason.
//
// Ids encode depth and stay unique: `1` → `1>dep` → `1>dep>dep`. A RESUME reuses
// the original id (it replaces that row) and is tracked separately so it cannot
// re-fire forever.
const MAX_ROUNDS = 6
let results = []
let queue = buildable
const dispatchedIds = new Set()
const resumedIds = new Set()
let rounds = 0

while (queue.length && rounds < MAX_ROUNDS) {
  rounds += 1
  const codeWork = queue.filter((i) => i.lane !== 'context')
  const ctxWork = queue.filter((i) => i.lane === 'context')
  log(`Round ${rounds}: ${codeWork.length} code-lane + ${ctxWork.length} context item(s) — ${[...new Set(queue.map((i) => i.lane))].join(', ')}`)

  // Code lanes in parallel — disjoint files, safe together.
  if (codeWork.length) {
    phase('Build')
    const out = await parallel(
      CODE_LANES.map((lane) => () => {
        const b = codeWork.filter((i) => i.lane === lane)
        return b.length ? dispatch(lane, b).then((r) => (r && r.results) || []) : null
      }),
    )
    results = results.concat(out.filter(Boolean).flat())
  }

  // `context` LAST within the round — including asks the code lanes just raised
  // at it, so a prompt change lands in the same round as the code it describes.
  const ctxAsks = depAsksFor('context', results).filter((a) => !dispatchedIds.has(a.id))
  const toContext = ctxWork.concat(ctxAsks)
  if (toContext.length) {
    phase('Context')
    const cr = await dispatch('context', toContext)
    results = results.concat((cr && cr.results) || [])
    ctxAsks.forEach((a) => dispatchedIds.add(a.id))
  }
  queue.forEach((i) => dispatchedIds.add(i.id))

  // ── what this round produced becomes next round's pending work ──
  // (a) fresh asks aimed at a code lane, never dispatched before.
  const nextAsks = CODE_LANES.flatMap((lane) => depAsksFor(lane, results)).filter((a) => !dispatchedIds.has(a.id))

  // (b) originators whose dependency has now LANDED, re-dispatched to finish.
  // Without this an issue sat at `needs-dependency` forever: the other lane built
  // exactly what was asked and nobody ever told the originator, so a finished
  // wave read as blocked.
  const satisfied = new Map()
  for (const r of results) {
    if (r.verdict === 'built' && typeof r.id === 'string' && r.id.endsWith('>dep')) satisfied.set(r.id.slice(0, -'>dep'.length), r)
  }
  const resumes = results
    .filter((r) => r.verdict === 'needs-dependency' && satisfied.has(r.id) && !resumedIds.has(r.id))
    .map((r) => {
      const dep = satisfied.get(r.id)
      const orig = [...buildable, ...nextAsks].find((i) => i.id === r.id) || {}
      resumedIds.add(r.id)
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
  if (resumes.length) log(`  dependencies closed: ${resumes.length} originator(s) will finish next round`)

  // A resumed issue REPLACES its earlier needs-dependency row — same id.
  const replaced = new Set(resumes.map((i) => i.id))
  if (replaced.size) results = results.filter((r) => !(replaced.has(r.id) && r.verdict === 'needs-dependency'))

  queue = [...nextAsks, ...resumes].filter((i) => i.lane && (KNOWN_LANES.has(i.lane) || i.lane === 'context'))
}
// Silent truncation reads as "everything got done". If the cap stopped us with
// work still queued, that is a fact the owner must be told.
if (queue.length) {
  log(`! ROUND CAP: ${queue.length} item(s) still pending after ${MAX_ROUNDS} rounds — ${queue.map((i) => `${i.id}→${i.lane}`).join(', ')}. NOT built.`)
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
let verifyDepAsks = []
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
    // The verify's OWN dependency asks were being discarded here — the overturn
    // read only `verdict` and `notes`, so when the verifier said "this needs the
    // owner, and here is precisely what would fix it", the prescription was
    // thrown away and only the objection survived. That happened on
    // wf_6b869440-ef7 to the one finding that mattered most. The verify runs
    // last so its asks cannot be dispatched in this run — they must be reported.
    verifyDepAsks = ((check && check.results) || [])
      .filter((x) => hasAsk(x))
      .map((x) => ({ from: x.id, fromVerdict: x.verdict || 'verify', lane: x.dependencyAgent, ask: x.dependencyAsk, fromVerify: true }))
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

// ---- RUN MANIFEST — what each mechanism ACTUALLY did ---------------------
// Not decoration. Every silent failure this engine has had was a step that did
// nothing while the run reported success, and each one survived for weeks
// because no number was ever printed next to it. The manifest exists so a
// no-op shows up as a zero in a column where zero is obviously wrong, and
// `warnings` says so in words for the ones we already know the shape of.
//
// Nothing here is an input to any decision — it is purely a record.
const allDepAsks = verified.filter((r) => hasAsk(r)).length
const deferredNow = [...deferredDepAsks(verified), ...verifyDepAsks]
const manifest = {
  mode: MODE,
  preset: !!PRESET,
  logReview: PRESET
    ? 'skipped (preset issues)'
    : {
        watermarkGiven: SINCE,
        cutoffUtcUsed: logReport.cutoffUtc ?? '(not reported)',
        startedAtLine: logReport.cutoffLine ?? '(not reported)',
        turnsAfterCutoff: logReport.turnsAfterCutoff ?? '(not reported)',
      },
  alreadyBuilt: { passedIn: ALREADY_BUILT.length, droppedByTriage: triageDropped.length, dropped: triageDropped },
  locate: PRESET || !locateStats.cited ? 'no citations to resolve' : locateStats,
  lanesDispatched: [...new Set(verified.map((r) => (buildable.find((i) => i.id === r.id) || {}).lane).filter(Boolean))],
  misroutedLanes: misrouted.length,
  dependencyAsks: { attached: allDepAsks, routedAndBuilt: verified.filter((r) => String(r.id).endsWith('>dep')).length, deferredToOwner: deferredNow.length },
  verify: VERIFY ? { ran: true, overturned: results.filter((r, i) => r.verdict !== verified[i].verdict).length, verifiedCleanReturned: verifiedClean.length } : { ran: false },
}
// Known-shape sanity checks. These are the exact failures already paid for.
const warnings = []
if (!PRESET && logReport.cutoffLine === 1 && (findings.length || 0) > 0)
  warnings.push('LOG WATERMARK LOOKS INERT — review started at line 1, so it re-read the whole day. Check the UTC conversion; this cost ~430k on 2026-07-26.')
if (!PRESET && logReport.cutoffLine === undefined)
  warnings.push('Log review did not report a cutoff line, so its watermark cannot be verified. Treat any log finding as possibly already-reviewed.')
if (ALREADY_BUILT.length > 0 && triageDropped.length === 0)
  warnings.push(`alreadyBuilt passed ${ALREADY_BUILT.length} entries and triage dropped NONE — either genuinely all-new, or ref matching failed again (gh#147 vs #147).`)
if (verified.some((r) => r.verdict === 'already-fixed'))
  warnings.push('A lane returned `already-fixed` — a duplicate reached a full dispatch. alreadyBuilt should have caught it earlier and cheaper.')
if (misrouted.length) warnings.push(`${misrouted.length} issue(s) carried an unknown lane and were re-routed to outer.`)
if (deferredNow.length) warnings.push(`${deferredNow.length} dependency ask(s) were NOT dispatched and MUST be rendered in the report — an unreported ask is indistinguishable from one that never happened.`)
log(`Manifest — logCutoff:${manifest.logReview.startedAtLine ?? 'n/a'} alreadyBuilt:${triageDropped.length}/${ALREADY_BUILT.length} depAsks:${allDepAsks} deferred:${deferredNow.length} misrouted:${misrouted.length}`)
warnings.forEach((w) => log(`! ${w}`))

// ---- return the structured report; the Manager persists it (workflow scripts have no filesystem) ----
return {
  manifest,
  warnings,
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
  // Deliberately NOT built — the owner rules on the shape first. Render these in
  // the report as `pending owner` with the shapingQuestion, and dispatch whatever
  // he approves via `args.issues`, where the preset path exempts them.
  needsShaping,
  pending,
  // Persist under "Verified clean" in report.md and pass straight back as
  // `priorClean` next run. It is the only thing that stops each verify starting
  // from zero on ground an earlier one already proved.
  verifiedClean,
  // Dependency asks that were deliberately NOT dispatched, because their parent
  // verdict is waiting on the owner. **The Manager MUST render these in the
  // report** — every one is a lane naming specific work in another lane's files,
  // with a file:line. Dropping them silently is the bug this field exists to
  // close, and an unreported ask is indistinguishable from one that never
  // happened. Route the ones he approves via `args.issues` next run.
  deferredDepAsks: deferredNow,
}
