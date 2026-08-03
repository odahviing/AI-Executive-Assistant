#!/usr/bin/env node
/**
 * design-cluster — the framer's DESIGN door, and the join-back that closes it.
 *
 * `converted` is not an escape hatch, it is a waiting room. Measured 2026-08-03 on
 * `.claude/agent-loop/ledger.jsonl`: 13 rows have ever been `converted`, and NINE
 * of them are the same design question — `gh#154`, "owner authority across chat
 * surfaces" — absorbed from five lanes over eight days and never designed once.
 * Every one of those rows was closed specifically to AVOID a partial fix, so the
 * design is what unblocks all nine. Nothing surfaced them as one item.
 *
 * CLUSTERING IS BY `converted` DESTINATION AND NOTHING ELSE. Tested against
 * gh#154's nine: destination partitions all 13 rows cleanly (gh#154 → 9,
 * gh#155 → 2, unrouted → 2), while `invariant` splits one question into three and
 * misses five, and `rootCause` has seven distinct values across those nine.
 * ONE design item = ONE destination = one recon + one plan, never nine.
 *
 * TWO MODES, and only the second one writes:
 *
 *   node scripts/design-cluster.cjs gh#154
 *     READ. Prints the cluster and the `args` block to paste into
 *     `Workflow({scriptPath:'.claude/workflows/feature.js', args:{…}})`.
 *
 *   node scripts/design-cluster.cjs gh#154 --decide "<the design he chose>"
 *     WRITE, and only after he has ruled. Appends ONE row per ref carrying
 *     `recommend: "build — <the design>"` UNDER its existing `converted` verdict.
 *     The symptom rows must NOT reopen: `converted` is in `ledger-stats`'s CLOSED
 *     set, so `--open` still hides all nine, and `grep 154 ledger.jsonl` now shows
 *     the decision beside every one of them. Idempotent — a second call appends
 *     nothing and says so.
 *
 * WHY A SCRIPT AND NOT ENGINE CODE: a workflow runs under `vm.compileFunction`
 * with `agent`/`parallel`/`log`/`phase` and no `require`, so an engine physically
 * cannot read the ledger. The alternative was an agent dispatch to grep a file,
 * which is a model doing arithmetic. This is deterministic, costs one node start,
 * and is checkable in one command (A11).
 *
 * WHY NOT IN `ledger-stats.cjs`: that file's contract, in its own header, is
 * "Read-only. Never writes." The join-back writes. A reader that sometimes writes
 * is the surface-carrying-the-other-one's-job defect.
 */

const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const decide = argOf('--decide')
const runId = argOf('--run')
// `--ledger` so the fixture can prove the JOIN-BACK against a copy. A write path
// that can only be exercised against the live ledger is a write path nobody tests,
// and `ledger-stats.cjs --report <path>` set this precedent already.
const LEDGER = argOf('--ledger') || path.join(__dirname, '..', '.claude', 'agent-loop', 'ledger.jsonl')
// `--json` prints the args block ALONE, for a caller that pipes rather than reads.
const jsonOnly = argv.includes('--json')
const target = argv.find((a) => !a.startsWith('--') && a !== decide && a !== runId && a !== argOf('--ledger'))

if (!target) {
  console.error('\nUsage: node scripts/design-cluster.cjs gh#154 [--json] [--decide "<the design he chose>"] [--run <id>] [--ledger <path>]')
  console.error('  bare      — print the cluster and the args block for feature.js')
  console.error('  --json    — print ONLY the args block')
  console.error('  --decide  — append the join-back row on every ref, AFTER he has ruled\n')
  process.exit(1)
}
if (argv.includes('--decide') && !decide) {
  console.error('\n--decide was passed with no text. The row records WHICH design he chose; an empty one records nothing.\n')
  process.exit(1)
}
if (!fs.existsSync(LEDGER)) {
  console.error(`\nNo ledger at ${LEDGER}\n`)
  process.exit(1)
}

// `gh#154` = `#154` = `154`. The ledger genuinely holds all three spellings —
// `ledger-stats.cjs:965` normalises the same three for the same reason.
const N = String(target).trim().toLowerCase().replace(/^(?:gh)?#/, '')
if (!/^\d+$/.test(N)) {
  console.error(`\n"${target}" is not a GitHub issue number. A design cluster is keyed on the ref a \`converted\` row was routed TO — \`gh#154\`, \`#154\` or \`154\`.\n`)
  process.exit(1)
}
const REF = `gh#${N}`

// The destination as it is actually written in a `note`: `→ gh#154`, `-> gh#154`,
// `park to #154`, and the comment URL `issues/154#issuecomment-…`. `(?!\d)` is
// load-bearing — without it `#154` matches `#1548`.
const NAMES = new RegExp(String.raw`(?:(?:gh)?#${N}(?!\d)|issues/${N}(?!\d))`, 'i')

const rows = []
const unparseable = []
fs.readFileSync(LEDGER, 'utf8')
  .split(/\r?\n/)
  .forEach((line, i) => {
    const t = line.trim()
    if (!t) return
    try {
      rows.push({ _line: i + 1, ...JSON.parse(t) })
    } catch {
      unparseable.push(i + 1)
    }
  })
if (unparseable.length) console.error(`! ${unparseable.length} unparseable ledger line(s): ${unparseable.slice(0, 10).join(', ')}\n`)

// COLLAPSE BY REF, latest wins, fields merged. The ledger is append-only, so one
// symptom legitimately has several rows — and the join-back below adds one more to
// every ref it touches. Without this, running `--decide` once would make the next
// read report 18 rows for 9 symptoms: the count-that-is-wrong failure inside the
// thing that exists to produce the count.
const converted = rows.filter((r) => r.verdict === 'converted' && NAMES.test(String(r.note || '')))
const byRef = new Map()
for (const r of converted) {
  const k = String(r.ref || `(no ref, line ${r._line})`)
  byRef.set(k, { ...(byRef.get(k) || {}), ...r })
}
const cluster = [...byRef.values()].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
const lanes = [...new Set(cluster.map((r) => r.lane).filter(Boolean))]
const dates = cluster.map((r) => String(r.date || '')).filter(Boolean).sort()
const span = dates.length
  ? { first: dates[0], last: dates[dates.length - 1], days: Math.round((new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000) + 1 }
  : { first: null, last: null, days: 0 }

// The ONE payload, built once and printed by whichever mode asked for it. A
// `--json` block that is assembled separately from the one a human reads is two
// definitions of the cluster, which is the drift this file exists to prevent.
const ARGS = {
  mode: 'plan',
  design: REF,
  ...(cluster.length
    ? {
        cluster: {
          ref: REF,
          lanes,
          span,
          refs: cluster.map((r) => ({
            ref: r.ref || '',
            lane: r.lane || '',
            date: r.date || '',
            finding: r.finding || '',
            rootCause: r.rootCause || '',
            note: r.note || '',
          })),
        },
      }
    : {}),
}
if (jsonOnly && !decide) {
  console.log(JSON.stringify(ARGS, null, 2))
  process.exit(0)
}

console.log(`\n${REF} — ${cluster.length} \`converted\` row(s) name it · ${lanes.length} lane(s)${span.first ? ` · ${span.first}..${span.last} (${span.days} day(s))` : ''}`)
if (!cluster.length) {
  // NOT an error. A design item nobody has converted onto yet is a legitimate
  // first run — it absorbs nothing, and the plan pass is unchanged.
  console.log(`\nNo \`converted\` row names ${REF}, so this design item absorbs nothing. That is a valid state: plan it as an ordinary ref.`)
  console.log(`\nARGS — paste into Workflow({scriptPath:'.claude/workflows/feature.js', args: … })\n`)
  console.log(JSON.stringify(ARGS, null, 2))
  console.log('')
  process.exit(0)
}
for (const r of cluster) {
  console.log(`  ${String(r.date || '?').padEnd(11)} ${String(r.lane || '?').padEnd(12)} ${String(r.ref || '(no ref)').slice(0, 52)}`)
  console.log(`              ${String(r.finding || '').slice(0, 104)}`)
  if (r.rootCause) console.log(`              root: ${String(r.rootCause).slice(0, 98)}`)
  if (r.recommend) console.log(`              recommend: ${String(r.recommend).slice(0, 92)}`)
}

// ── THE JOIN-BACK ───────────────────────────────────────────────────────────
// The nine symptom rows stay `converted` and MUST NOT REOPEN. Their state is
// correct — they left the bug track. What was missing is the other half: the
// answer, written beside each of them, so `grep 154 ledger.jsonl` shows the
// design next to every symptom it closes instead of nine dead ends.
if (decide) {
  const MARK = `DESIGN SETTLED for ${REF}`
  const already = cluster.filter((r) => String(r.note || '').includes(MARK))
  const todo = cluster.filter((r) => !String(r.note || '').includes(MARK))
  if (!todo.length) {
    console.log(`\nAll ${cluster.length} ref(s) already carry the join-back for ${REF}. Nothing appended.\n`)
    process.exit(0)
  }
  const today = new Date().toISOString().slice(0, 10)
  const lines = todo.map((r) =>
    JSON.stringify({
      date: today,
      runId: runId || `design-${REF.replace('#', '')}`,
      lane: r.lane || '',
      source: 'owner',
      ref: r.ref || '',
      finding: r.finding || '',
      rootCause: r.rootCause || '',
      verdict: 'converted', // UNCHANGED. The row left the bug track and stays left.
      recommend: `build — ${decide}`,
      state: r.state || 'open',
      // `ledger-stats` errors on a `converted` row whose `note` names no
      // destination, so the destination is repeated here, not replaced.
      note: `${MARK}: ${decide} — this row stays \`converted\`; the design is built under ${REF}, never as a patch here. Original routing: ${String(r.note || '').slice(0, 120)}`,
    }),
  )
  fs.appendFileSync(LEDGER, lines.join('\n') + '\n')
  console.log(`\nJoin-back appended — ${todo.length} row(s)${already.length ? `, ${already.length} already carried it` : ''}:`)
  for (const r of todo) console.log(`  ${String(r.ref || '(no ref)').slice(0, 56)}  recommend: build — ${decide.slice(0, 60)}`)
  console.log(`\nEvery row is still \`converted\`, so \`ledger-stats --open\` hides all ${cluster.length}. Check with:`)
  console.log(`  node scripts/ledger-stats.cjs --open`)
  console.log(`  node scripts/design-cluster.cjs ${REF}\n`)
  process.exit(0)
}

console.log(
  `\nONE design item, not ${cluster.length}. Every row above was closed to AVOID a partial fix, so a per-ref patch is the one shape that is wrong here.`,
)
console.log(`\nARGS — paste into Workflow({scriptPath:'.claude/workflows/feature.js', args: … })\n`)
console.log(JSON.stringify(ARGS, null, 2))
console.log(`\nAfter he rules, record it on all ${cluster.length}:`)
console.log(`  node scripts/design-cluster.cjs ${REF} --decide "<the design he chose>"\n`)
