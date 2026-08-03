export const meta = {
  name: 'charter-audit',
  description:
    'Charter conformance audit — every lane agent checks whether the code it owns actually obeys its own charter today. Inspection ONLY: findings, never builds. Two valid outcomes per rule: the code violates the rule, OR the rule is wrong and the charter should be amended. The charters were written from product intent; the code predates them, so drift is expected and finding it is the point.',
  phases: [{ title: 'Audit' }],
}

const A = args || {}
// Agent names, renamed 2026-07-28. And note what the old list had: `'other'`,
// which was never an agent — the lane has always been `outer`, now `handyman`.
// So `agentType: 'other'` was dispatching to a type that does not exist, and
// this engine has never been able to audit the catch-all lane. Same class as
// triage emitting lane `general` on 2026-07-25: a name nobody checked.
const LANES = A.lanes || ['matchmaker', 'registrar', 'gatekeeper', 'profiler', 'instructor', 'slackmaster', 'diplomat', 'handyman']
const EFFORT = { matchmaker: 'xhigh', instructor: 'xhigh', slackmaster: 'high', diplomat: 'high', registrar: 'xhigh', handyman: 'high', profiler: 'high', gatekeeper: 'high', usher: 'xhigh', framer: 'xhigh', bouncer: 'xhigh' }
const UNKNOWN = LANES.filter((l) => !EFFORT[l])
if (UNKNOWN.length) throw new Error(`Unknown lane(s): ${UNKNOWN.join(', ')} — they have no effort setting and no agent, so they would dispatch to nothing.`)

const CONFORMANCE = {
  type: 'object',
  properties: {
    lane: { type: 'string' },
    rulesChecked: { type: 'number', description: 'how many of your own rules you actually verified' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: 'the rule tag + short name, e.g. "M2 · One meeting spine"' },
          verdict: {
            type: 'string',
            enum: ['code-violates', 'charter-wrong', 'cannot-verify'],
          },
          symptom: { type: 'string', description: 'what the code actually does instead' },
          evidence: { type: 'string', description: 'file:line — REQUIRED, no hand-waves' },
          impact: { type: 'string', description: 'what it costs in the real world; "none observed" is allowed' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          recommendation: { type: 'string', description: 'fix direction (NOT code), or the charter amendment you propose' },
        },
        required: ['rule', 'verdict', 'symptom', 'evidence', 'severity', 'recommendation'],
      },
    },
    compliant: { type: 'array', items: { type: 'string' }, description: 'rule tags verified as obeyed' },
  },
  required: ['lane', 'rulesChecked', 'findings', 'compliant'],
}

phase('Audit')
log(`Charter conformance audit — ${LANES.length} lanes, inspection only, nothing will be built.`)

const results = await parallel(
  LANES.map((lane) => () =>
    agent(
      `CHARTER CONFORMANCE AUDIT — inspection only. You will BUILD NOTHING.

Your charter's rules describe how your area is SUPPOSED to behave. They were written recently from the owner's product intent; the code predates them. Nobody has ever checked whether the code actually obeys them. That is your job today.

For EVERY numbered rule in your charter (not the shared charter — YOUR lane's rules), check the real code in the files you own and decide:

- **compliant** — the code obeys it. List the rule tag in \`compliant\`. No finding needed.
- **code-violates** — the code breaks the rule. Finding required: what it does instead, \`file:line\`, the real-world impact, and a fix DIRECTION (never code).
- **charter-wrong** — the code is right and the RULE is wrong, too strict, ambiguous, or unimplementable as written. Finding required, with the amendment you propose. **This is a first-class, valuable outcome — not a cop-out.** These charters are one day old; some rules will not survive contact with the code, and the owner needs to know which.
- **cannot-verify** — you could not determine it. Say what evidence would settle it.

HARD RULES:
- **Every finding cites \`file:line\`.** No "somewhere in the booking flow".
- **Do NOT edit any file. Do NOT run typecheck. Do NOT commit.** Reads only: code, \`git log\`, logs, \`node scripts/db-query.cjs\`.
- **Quality over quantity.** Four proven violations beat fifteen nitpicks. An honest "my lane is clean on 9 of 12 rules" is a good result.
- Do NOT audit another lane's files. If a violation of YOUR rule lives in someone else's code, report it as a finding and name the lane in \`recommendation\`.
- Report what IS, not what should be built. The owner decides what happens next.`,
      { label: `audit:${lane}`, phase: 'Audit', agentType: lane, effort: EFFORT[lane], schema: CONFORMANCE },
    ),
  ),
)

const ok = results.filter(Boolean)
const all = ok.flatMap((r) => (r.findings || []).map((f) => ({ ...f, lane: r.lane })))
ok.forEach((r) =>
  log(`  ${r.lane}: ${r.rulesChecked} rules checked · ${(r.compliant || []).length} compliant · ${(r.findings || []).length} findings`),
)

return {
  counts: {
    lanes: ok.length,
    rulesChecked: ok.reduce((n, r) => n + (r.rulesChecked || 0), 0),
    compliant: ok.reduce((n, r) => n + (r.compliant || []).length, 0),
    codeViolates: all.filter((f) => f.verdict === 'code-violates').length,
    charterWrong: all.filter((f) => f.verdict === 'charter-wrong').length,
    cannotVerify: all.filter((f) => f.verdict === 'cannot-verify').length,
  },
  findings: all,
  perLane: ok,
}
