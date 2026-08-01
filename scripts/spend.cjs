#!/usr/bin/env node
/**
 * spend — read the Claude Code transcripts for this project and report where the
 * tokens actually went.
 *
 * `ledger-stats` made the backlog answerable in one command. Nothing did that for
 * cost, so every "did that change help?" started with an hour of throwaway scripting
 * in a scratchpad that dies with the session. This is that tool, kept.
 *
 * What it measures, and why the split is the point rather than the total:
 *   • AGENTS vs CHAT. Measured 2026-07-24→29: agents 43%, chat 57%. Every cost
 *     optimisation so far has been aimed at the agents. Know which half you are
 *     working on before you start.
 *   • PER RUN, not per calendar day. A chat window spans days; a run is the unit
 *     of work. Whole runs came in at $44–$224 while the six-day total was ~$9.4k,
 *     i.e. the runs were ~11% of it. The conversation around the runs is the bill.
 *   • HOW A DISPATCH LANDED. `--day` prints every agent with whether it came from
 *     the engine or a hand dispatch, and which tier it actually ran on. The tier
 *     is meant to live on the charter frontmatter; this is how you check it does.
 *   • TURNS. Cache reads are the bill and they scale with turn count, because
 *     every turn re-reads the whole accumulated context. Cost per turn is roughly
 *     flat within a window, so a one-word reply costs about what an analysis does.
 *
 * TWO BUGS THIS SCRIPT EXISTS TO NOT REPEAT, both hit while measuring by hand:
 *   1. Attributing spend by file MTIME. A session resumed today can hold messages
 *      from last week; mtime put $1.4k of 07-14→21 work onto 07-28. Every record
 *      is bucketed by ITS OWN timestamp.
 *   2. Walking only `subagents/workflows/`. Hand-dispatched agents live one level
 *      up in `subagents/` and were missed, reading the agent side 3.7x low.
 *
 * The dollar figures are LIST prices applied to measured token counts — on a
 * subscription they are not literal charges. The token counts and the ratios
 * between them are exact; treat the $ as a common yardstick.
 *
 * Read-only. Never writes.
 *
 * Usage:
 *   node scripts/spend.cjs                     # the split, by day (last 7 days)
 *   node scripts/spend.cjs --since 2026-07-24
 *   node scripts/spend.cjs --runs              # cost per workflow run
 *   node scripts/spend.cjs --agents            # per agent type, with tier
 *   node scripts/spend.cjs --chats             # per chat window
 *   node scripts/spend.cjs --day 2026-07-28    # one day: every agent, how dispatched
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

// $ per million tokens, by tier. Update if the published rates move — and if you
// do, say so here, because every number this script prints depends on it.
const PRICE = {
  opus: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
}
// Unknown model ids fall to sonnet rather than throwing: a new model should not
// take the whole report down, but it must not silently price as the dearest tier.
const tierOf = (m) => (/opus/i.test(m) ? 'opus' : /haiku/i.test(m) ? 'haiku' : 'sonnet')

// Agent names change, and every rename splits that lane in two. ONE map, read by
// every mode: the old dispatch name -> the charter that exists now. Under `--day`
// an unmapped name silently dropped nine dispatches out of the tier check (X106);
// under `--agents` it printed $1281 of `meeting` beside $91 of `matchmaker` and
// called them different agents, so no row showed what a lane had ever cost (X113).
// ADD A ROW HERE AT EVERY RENAME — `--day` names anything it does not know, with
// the dispatch count, which is the prompt to come back to this list.
const RENAMED = new Map([
  ['shepherd', 'registrar'],
  ['transporter', 'slacker'],
  ['verifier', 'bouncer'],
  ['examiner', 'bouncer'],
  ['scout', 'usher'],
  ['meeting', 'matchmaker'],
  ['requests', 'registrar'],
  ['guard', 'gatekeeper'],
  ['people', 'profiler'],
  ['context', 'instructor'],
  ['slack', 'slacker'],
  ['outer', 'outrider'],
])
const canon = (t) => RENAMED.get(t) || t
// Generic dispatch types: no `.claude/agents/*.md`, and the engine sets their tier
// per call on purpose. Never judged against a charter, never folded into a lane.
const GENERIC = new Set(['workflow-subagent', 'general-purpose'])

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const val = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)
const ONE_DAY = val('--day', null)
const SINCE = ONE_DAY || val('--since', daysAgo(7))
const UNTIL = ONE_DAY || '9999'

// Transcripts live under ~/.claude/projects/<cwd with : and \ and / turned into ->
const ROOT =
  val('--root', null) ||
  path.join(os.homedir(), '.claude', 'projects', process.cwd().replace(/[:\\/]/g, '-'))

if (!fs.existsSync(ROOT)) {
  console.error(`\nNo transcript directory at:\n  ${ROOT}\n`)
  console.error(`Run this from the repo root, or pass --root <dir>.`)
  console.error(`Reporting $0 because the path was wrong is exactly the failure this`)
  console.error(`script is supposed to catch, so it refuses instead.\n`)
  process.exit(1)
}

// ---------------------------------------------------------------- read
const priceOf = (tier, u) => {
  const p = PRICE[tier]
  return (
    ((u.input_tokens || 0) * p.in +
      (u.output_tokens || 0) * p.out +
      (u.cache_creation_input_tokens || 0) * p.cacheWrite +
      (u.cache_read_input_tokens || 0) * p.cacheRead) /
    1e6
  )
}

/** Every usage-bearing record in one transcript, bucketed by its OWN timestamp. */
function* records(file) {
  let txt
  try {
    txt = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const m = o.message || o
    const u = m.usage || o.usage
    const model = m.model || o.model || 'unknown'
    const ts = o.timestamp || m.timestamp
    if (!u || !ts) continue
    if (model === '<synthetic>') continue // harness placeholders, no real usage
    const day = String(ts).slice(0, 10)
    if (day < SINCE || day > UNTIL) continue
    yield { ts, day, tier: tierOf(model), model, usage: u }
  }
}

const blank = () => ({ turns: 0, in: 0, out: 0, cacheWrite: 0, cacheRead: 0, cost: 0 })
const accum = (a, r) => {
  a.turns++
  a.in += r.usage.input_tokens || 0
  a.out += r.usage.output_tokens || 0
  a.cacheWrite += r.usage.cache_creation_input_tokens || 0
  a.cacheRead += r.usage.cache_read_input_tokens || 0
  a.cost += priceOf(r.tier, r.usage)
  return a
}

/** One agent transcript → its type, tier, span and totals. */
function readAgent(file, how) {
  let type = '?'
  try {
    type = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || '?'
  } catch {}
  const t = blank()
  const tiers = new Set()
  let lo = null
  let hi = null
  for (const r of records(file)) {
    accum(t, r)
    tiers.add(r.tier)
    if (!lo || r.ts < lo) lo = r.ts
    if (!hi || r.ts > hi) hi = r.ts
  }
  return t.turns ? { ...t, type, how, tiers: [...tiers], lo, hi, day: lo.slice(0, 10) } : null
}

const agents = [] // every agent, engine-dispatched or hand-dispatched
const runs = new Map() // runId -> {id, session, lo, hi}
const chats = [] // main chat windows

for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  // main chat window
  if (e.isFile() && /\.jsonl$/.test(e.name)) {
    const sid = e.name.slice(0, 8)
    const t = blank()
    const byDay = new Map()
    const days = new Set()
    const perTurn = []
    for (const r of records(path.join(ROOT, e.name))) {
      accum(t, r)
      days.add(r.day)
      if (!byDay.has(r.day)) byDay.set(r.day, blank())
      accum(byDay.get(r.day), r)
      perTurn.push({ ts: r.ts, cost: priceOf(r.tier, r.usage) })
    }
    if (t.turns) chats.push({ session: sid, ...t, days: [...days].sort(), byDay, perTurn })
    continue
  }
  if (!e.isDirectory()) continue
  const sid = e.name.slice(0, 8)
  const sub = path.join(ROOT, e.name, 'subagents')
  if (!fs.existsSync(sub)) continue

  // BUG 2 GUARD: hand-dispatched agents live here, one level above workflows/
  for (const f of fs.readdirSync(sub)) {
    if (!/^agent-.*\.jsonl$/.test(f)) continue
    const a = readAgent(path.join(sub, f), 'hand')
    if (a) agents.push({ ...a, session: sid, run: null })
  }
  const wfDir = path.join(sub, 'workflows')
  if (!fs.existsSync(wfDir)) continue
  for (const id of fs.readdirSync(wfDir)) {
    let files = []
    try {
      files = fs.readdirSync(path.join(wfDir, id)).filter((f) => /^agent-.*\.jsonl$/.test(f))
    } catch {
      continue
    }
    // X69 · DID THIS RUN DIE. A run whose usher is killed leaves a journal holding
    // one `started` line and no `result`, and it appeared on NO surface —
    // wf_e2f12e7c-6d6 ran on 2026-07-30, died, cost $1.19, and nothing in
    // report.md, state.json or ledger.jsonl records that a run began at all. The
    // journal already holds the answer; it just had no reader. `started` without a
    // matching `result` is the whole derivation.
    let dead = 0
    let begunN = 0
    try {
      const lines = fs.readFileSync(path.join(wfDir, id, 'journal.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim())
      const done = new Set()
      const begun = new Set()
      for (const l of lines) {
        let j = null
        try { j = JSON.parse(l) } catch { continue }
        if (!j || !j.agentId) continue
        if (j.type === 'result') done.add(j.agentId)
        else if (j.type === 'started') begun.add(j.agentId)
      }
      begunN = begun.size
      dead = [...begun].filter((a) => !done.has(a)).length
    } catch {
      dead = 0
    }
    for (const f of files) {
      const a = readAgent(path.join(wfDir, id, f), 'engine')
      if (!a) continue
      agents.push({ ...a, session: sid, run: id })
      const r = runs.get(id) || { id, session: sid, lo: a.lo, hi: a.hi, dead, begun: begunN }
      if (a.lo < r.lo) r.lo = a.lo
      if (a.hi > r.hi) r.hi = a.hi
      r.dead = dead
      r.begun = begunN
      runs.set(id, r)
    }
  }
}

// A hand dispatch inside a run's window belongs to that run.
for (const a of agents) {
  if (a.run) continue
  for (const r of runs.values())
    if (r.session === a.session && a.lo >= r.lo && a.lo <= r.hi) {
      a.run = r.id
      break
    }
}

// ---------------------------------------------------------------- format
const k = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k')
const usd = (n) => '$' + (n >= 1000 ? n.toFixed(0) : n < 10 ? n.toFixed(2) : n.toFixed(0))
const pad = (s, n) => String(s).padEnd(n)
const lp = (s, n) => String(s).padStart(n)
const rule = (n) => '-'.repeat(n)
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0)
const mins = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000)

const agentCost = sum(agents, (a) => a.cost)
const chatCost = sum(chats, (c) => c.cost)
const TOTAL = agentCost + chatCost
const scope = ONE_DAY ? ONE_DAY : `${SINCE} →`

console.log(`\nspend — ${agents.length} agents · ${chats.length} chat windows · ${scope}`)
if (!TOTAL) {
  console.log(`\nNothing in range. Widen it with --since, or check --root.\n`)
  process.exit(0)
}

// ---- --day: every agent, how it was dispatched, what tier it landed on ----
if (ONE_DAY) {
  console.log(`\nEvery agent on ${ONE_DAY} — the tier should come from the charter,`)
  console.log(`so an engine row and a hand row for the same agent must MATCH.\n`)
  console.log(`${pad('how', 8)}${pad('agent', 18)}${pad('tier', 9)}${lp('turns', 7)}${lp('cost', 9)}`)
  console.log(rule(51))
  for (const a of agents.sort((x, y) => y.cost - x.cost))
    console.log(`${pad(a.how, 8)}${pad(a.type.slice(0, 17), 18)}${pad(a.tiers.join('+'), 9)}${lp(a.turns, 7)}${lp(usd(a.cost), 9)}`)
  console.log(rule(51))

  // X39 · The check that matters: OBSERVED tier against the tier the charter
  // DECLARES. It used to compare two dispatch paths to each other, which is not
  // the claim the line makes — "no dispatch path is overriding the charter" is
  // about the charter, and the charter was never read. For any agent dispatched
  // by exactly ONE path the comparison had a single member, agreed with itself,
  // and reported a consistency it never tested: on 2026-07-29 it printed
  // "consistent for all 10 chartered agents" while `architect.md` declared
  // `sonnet` and all three architect runs that day were opus. A check that
  // cannot fail on known-bad input is not a check.
  //
  // Only agents that HAVE a charter can be checked. `workflow-subagent` and
  // `general-purpose` are generic — no `.claude/agents/*.md`, so no single source
  // of truth to violate, and the engine sets their tier per call on purpose
  // (haiku for intake, opus for recon). Warning on those would fire every run and
  // train everyone to ignore the one case that matters.
  //
  // An agent with NO `model:` line inherits the session default, so absent means
  // NOT CHECKED and is reported as such — never silently counted as agreeing,
  // which would be this same failure one layer along.
  const declared = new Map()
  let charterDir = true
  try {
    const dir = path.join(process.cwd(), '.claude', 'agents')
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000)
      const m = head.match(/^model:\s*(\S+)/m)
      declared.set(f.slice(0, -3), m ? tierOf(m[1]) : null)
    }
  } catch {
    charterDir = false
  }
  // X106 · A RENAME MUST NOT NARROW THIS CHECK IN SILENCE — that is X39's own rule
  // one step along. X39 fixed "no `model:` line" (absent means NOT CHECKED, never
  // silently counted as agreeing) and left "no FILE" dropping a whole agent on a
  // bare `continue`. Renames make that fire: on 2026-07-31 nine dispatches —
  // 3 shepherd, 3 transporter, 3 verifier — were skipped while the day printed
  // "Every dispatch matched its charter's declared tier".
  //
  // TWO HALVES, and each covers the other's failure. The `RENAMED` map above
  // checks a renamed agent against the charter it actually has now, so those nine
  // are judged rather than counted. The NAMED BUCKET below catches whatever the
  // map does not know — an unmapped rename shows up by name with its dispatch
  // count, which is the prompt to add it. Map alone rots at the next rename;
  // naming alone leaves the dispatches unchecked forever. The two generic types
  // are excluded EXPLICITLY, not by falling through the same `continue`.
  const off = []
  const unchecked = new Set()
  const checked = new Set()
  const unchartered = new Map()
  const viaRename = new Set()
  for (const a of agents) {
    const type = canon(a.type)
    if (!declared.has(type)) {
      if (!GENERIC.has(a.type)) unchartered.set(a.type, (unchartered.get(a.type) || 0) + 1)
      continue
    }
    const want = declared.get(type)
    if (!want) {
      unchecked.add(type)
      continue
    }
    if (type !== a.type) viaRename.add(`${a.type} -> ${type}`)
    checked.add(type)
    for (const t of a.tiers) if (t !== want) off.push({ type: a.type, want, got: t, turns: a.turns, cost: a.cost })
  }
  if (!charterDir) console.log(`\n(no .claude/agents found — the tier check did NOT run)`)
  else if (off.length)
    console.log(
      `\n!! OFF CHARTER — ${off.length} dispatch(es) ran on a tier their charter does not declare:\n` +
        off.map((o) => `     ${o.type}: charter says ${o.want}, ran ${o.got} (${o.turns} turns, ${usd(o.cost)})`).join('\n')
    )
  else
    console.log(`\nEvery dispatch matched its charter's declared tier — ${checked.size} chartered\nagent(s) checked against their own \`model:\` line.`)
  if (viaRename.size) console.log(`   checked through a rename (its dispatches predate the current name): ${[...viaRename].join(', ')}`)
  if (unchecked.size)
    console.log(`   NOT CHECKED (no \`model:\` in the charter, so it inherits the session default): ${[...unchecked].join(', ')}`)
  if (unchartered.size)
    console.log(
      `   NOT CHECKED (no \`.claude/agents/<type>.md\` under this name or any rename this script knows) — ${sum([...unchartered.values()], (n) => n)} dispatch(es): ${[...unchartered.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t} x${n}`)
        .join(', ')}\n   If one of those is a renamed agent, add it to RENAMED above and it is judged instead of counted.`
    )
  console.log('')
  process.exit(0)
}

// ---- --runs ----
if (flag('--runs')) {
  console.log(`\nCost per run. A run is the unit of work; a chat window is not.`)
  console.log(`"chat" is the driving turns while the run was LIVE — usually small,`)
  console.log(`which is the finding: the conversation around a run outweighs it.\n`)
  console.log(`${pad('started', 15)}${pad('run', 16)}${lp('ag', 4)}${lp('mins', 6)}${lp('agent $', 9)}${lp('chat $', 8)}${lp('TOTAL', 9)}`)
  console.log(rule(67))
  const list = [...runs.values()].sort((a, b) => a.lo.localeCompare(b.lo))
  let tA = 0
  let tC = 0
  for (const r of list) {
    const mine = agents.filter((a) => a.run === r.id)
    if (!mine.length) continue
    const ac = sum(mine, (a) => a.cost)
    const cc = sum(
      chats.filter((c) => c.session === r.session),
      (c) => sum(c.perTurn.filter((t) => t.ts >= r.lo && t.ts <= r.hi), (t) => t.cost)
    )
    tA += ac
    tC += cc
    console.log(
      `${pad(r.lo.slice(5, 16).replace('T', ' '), 15)}${pad(r.id.slice(0, 15), 16)}${lp(mine.length, 4)}${lp(mins(r.lo, r.hi), 6)}${lp(usd(ac), 9)}${lp(usd(cc), 8)}${lp(usd(ac + cc), 9)}${
        r.dead ? (r.dead === r.begun ? `  ! DIED — produced nothing` : `  ! ${r.dead} of ${r.begun} agent(s) never returned`) : ''
      }`
    )
  }
  console.log(rule(67))
  console.log(`${pad('ALL RUNS', 41)}${lp(usd(tA), 9)}${lp(usd(tC), 8)}${lp(usd(tA + tC), 9)}`)
  const loose = agents.filter((a) => !a.run)
  // X69 · a dead run is money spent and work not done, so it is named here rather
  // than left to be spotted as an odd-looking row. Nothing else in the framework
  // records that a run began and never came back.
  const withDead = [...runs.values()].filter((r) => r.dead && agents.some((a) => a.run === r.id))
  const totalDeath = withDead.filter((r) => r.dead === r.begun)
  if (totalDeath.length)
    console.log(
      `\n${totalDeath.length} run(s) DIED WHOLE — every agent started and none returned, so the run produced no result and appears on NO other surface (not report.md, not state.json, not the ledger): ${totalDeath
        .map((r) => `${r.id} (${r.lo.slice(0, 16).replace('T', ' ')}, ${usd(sum(agents.filter((a) => a.run === r.id), (a) => a.cost))})`)
        .join(', ')}`
    )
  const partial = withDead.filter((r) => r.dead !== r.begun)
  if (partial.length)
    console.log(
      `${totalDeath.length ? '' : '\n'}${partial.length} run(s) LOST AN AGENT but returned: ${partial.map((r) => `${r.id} ${r.dead}/${r.begun}`).join(', ')}. ` +
        `A lane that never returned is work paid for and not done — check its rows reached the report.`
    )
  console.log(
    `\n${loose.length} agent(s) outside any run window: ${usd(sum(loose, (a) => a.cost))}` +
      `\nRuns are ${((tA + tC) / TOTAL * 100).toFixed(0)}% of the ${usd(TOTAL)} spent in this window.\n`
  )
  process.exit(0)
}

// ---- --agents ----
if (flag('--agents')) {
  // X113 · GROUP BY THE NAME THE LANE CARRIES NOW, not by the name on the dispatch.
  // Raw grouping made this table useless for exactly the question it is for — what
  // has a lane ever cost — because a rename started a second row: 2026-07-20→08-01
  // printed `meeting` $1281 / `guard` $1081 beside a `matchmaker` row of $91, and
  // `registrar`, `bouncer` and `slacker` had no row at all under their own names.
  // The merge is NAMED per row (`incl.`) rather than done quietly: a table that
  // folds rows together without saying so is a worse defect than the split was.
  const by = new Map()
  for (const a of agents) {
    const type = canon(a.type)
    if (!by.has(type)) by.set(type, { n: 0, turns: 0, cost: 0, cacheRead: 0, tiers: new Set(), hand: 0, was: new Set() })
    const g = by.get(type)
    g.n++
    g.turns += a.turns
    g.cost += a.cost
    g.cacheRead += a.cacheRead
    if (a.how === 'hand') g.hand++
    if (type !== a.type) g.was.add(a.type)
    for (const t of a.tiers) g.tiers.add(t)
  }
  console.log(`\nPer agent type, under the name the lane carries NOW — \`incl.\` names the`)
  console.log(`older names folded in. Watch t/run: a cheaper tier that explores more can`)
  console.log(`give the saving back in turns, because turns are what cache reads bill.\n`)
  console.log(`${pad('agent', 18)}${lp('runs', 5)}${lp('hand', 5)}${lp('turns', 7)}${lp('t/run', 7)}${lp('cache-rd', 10)}${lp('cost', 9)}${lp('$/run', 8)}  tier`)
  console.log(rule(83))
  for (const [n, g] of [...by.entries()].sort((a, b) => b[1].cost - a[1].cost))
    console.log(
      `${pad(n.slice(0, 17), 18)}${lp(g.n, 5)}${lp(g.hand, 5)}${lp(g.turns, 7)}${lp((g.turns / g.n).toFixed(0), 7)}${lp(k(g.cacheRead), 10)}${lp(usd(g.cost), 9)}${lp(usd(g.cost / g.n), 8)}  ${[...g.tiers].join('+')}${
        g.was.size ? `  incl. ${[...g.was].sort().join(', ')}` : ''
      }`
    )
  console.log('')
  process.exit(0)
}

// ---- --chats ----
if (flag('--chats')) {
  console.log(`\nPer chat window. $/turn is near-flat inside a window, so turn COUNT is`)
  console.log(`the lever, not what any given turn does. ctx/turn falling = a compaction.\n`)
  console.log(`${pad('session', 10)}${lp('turns', 7)}${lp('output', 8)}${lp('cache-rd', 10)}${lp('ctx/turn', 10)}${lp('cost', 9)}${lp('$/turn', 8)}  days`)
  console.log(rule(84))
  for (const c of chats.sort((a, b) => b.cost - a.cost))
    console.log(
      `${pad(c.session, 10)}${lp(c.turns, 7)}${lp(k(c.out), 8)}${lp(k(c.cacheRead), 10)}${lp(k(c.cacheRead / c.turns), 10)}${lp(usd(c.cost), 9)}${lp('$' + (c.cost / c.turns).toFixed(2), 8)}  ${c.days.length} (${c.days[0]}→${c.days[c.days.length - 1]})`
    )
  console.log('')
  process.exit(0)
}

// ---- default: the split, by day ----
const days = new Map()
for (const a of agents) {
  if (!days.has(a.day)) days.set(a.day, { agent: 0, chat: 0, agents: 0, aTurns: 0, cTurns: 0 })
  const d = days.get(a.day)
  d.agent += a.cost
  d.agents++
  d.aTurns += a.turns
}
for (const c of chats)
  for (const [day, t] of c.byDay) {
    if (!days.has(day)) days.set(day, { agent: 0, chat: 0, agents: 0, aTurns: 0, cTurns: 0 })
    const d = days.get(day)
    d.chat += t.cost
    d.cTurns += t.turns
  }

console.log(`\n${pad('day', 12)}${lp('agents', 7)}${lp('ag turns', 9)}${lp('agent $', 9)}${lp('chat turns', 11)}${lp('chat $', 9)}${lp('TOTAL', 9)}${lp('ag%', 6)}`)
console.log(rule(72))
for (const [day, d] of [...days.entries()].sort()) {
  const t = d.agent + d.chat
  console.log(
    `${pad(day, 12)}${lp(d.agents, 7)}${lp(d.aTurns, 9)}${lp(usd(d.agent), 9)}${lp(d.cTurns, 11)}${lp(usd(d.chat), 9)}${lp(usd(t), 9)}${lp(Math.round((d.agent / t) * 100) + '%', 6)}`
  )
}
console.log(rule(72))
console.log(
  `${pad('TOTAL', 12)}${lp(agents.length, 7)}${lp(sum(agents, (a) => a.turns), 9)}${lp(usd(agentCost), 9)}${lp(sum(chats, (c) => c.turns), 11)}${lp(usd(chatCost), 9)}${lp(usd(TOTAL), 9)}${lp(Math.round((agentCost / TOTAL) * 100) + '%', 6)}`
)

const nDays = days.size || 1
console.log(`\n  agents  ${lp(usd(agentCost), 9)}  ${lp(((agentCost / TOTAL) * 100).toFixed(0) + '%', 5)}`)
console.log(`  chat    ${lp(usd(chatCost), 9)}  ${lp(((chatCost / TOTAL) * 100).toFixed(0) + '%', 5)}`)
console.log(`  per day ${lp(usd(TOTAL / nDays), 9)}  across ${nDays} day(s)`)
console.log(`\n  --runs · --agents · --chats · --day <date> for the breakdowns\n`)
