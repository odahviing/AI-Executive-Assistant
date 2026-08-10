#!/usr/bin/env node
/**
 * check-dispatch-coverage — gh#197.
 *
 * Nothing confirmed a builder dispatch actually produced a ledger row.
 * SlackMaster was hand-dispatched three times on 2026-08-10 — real turns,
 * real cost, real shipped code, confirmed via `spend.cjs` — and none of the
 * three left a row in `ledger.jsonl`; the only trace of its work survived as
 * a sentence inside a DIFFERENT lane's row for the same fix. This compares
 * `spend.cjs`'s own record of what actually ran against `ledger.jsonl`'s
 * record of what was reported, per builder lane per day, and names any
 * lane-day that was dispatched with real work and left NO row behind.
 *
 * SCOPE — the 8 builder lanes only: matchmaker, registrar, gatekeeper,
 * profiler, instructor, slackmaster, diplomat, handyman. Every one shares the
 * same return contract — a verdict per piece, on every dispatch — which is
 * what makes "zero rows" checkable without guessing at intent. Non-builders
 * run different cadences and are not this check's claim: architect writes to
 * a SEPARATE ledger entirely (`architect-ledger.jsonl`); editor mostly routes
 * rather than verdicts; bouncer's job is verifying another lane's row, not
 * minting its own on every pass; cleaner is a periodic sweep, not a per-day
 * cadence. Widening this to those lanes is a real question and not a
 * mechanical one — it stays open rather than guessed at here.
 *
 * NEVER AUTO-FILES. A missing row still needs a real rootCause, which only a
 * person (or a deliberate backfill, citing the actual diff) can supply — this
 * only says WHERE to look, the same discipline `--wrap`'s phantom-candidate
 * check already follows for the opposite direction.
 *
 * Usage:
 *   node scripts/check-dispatch-coverage.cjs                    # last 7 days (spend.cjs's own default)
 *   node scripts/check-dispatch-coverage.cjs --since 2026-08-01
 *   node scripts/check-dispatch-coverage.cjs --day 2026-08-10
 * Exit 0  every dispatched builder-day has at least one matching ledger row.
 * Exit 1  at least one does not — named, with turns/cost, so it is never silent.
 */
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SPEND = path.join(__dirname, 'spend.cjs')
const LEDGER = path.join(ROOT, '.claude', 'agent-loop', 'ledger.jsonl')

// Same 8 names `ledger-file.cjs`'s KNOWN_LANES carries for builders — not
// re-derived from it, because that set also lists non-builders this check
// deliberately excludes (see header).
const BUILDERS = new Set(['matchmaker', 'registrar', 'gatekeeper', 'profiler', 'instructor', 'slackmaster', 'diplomat', 'handyman'])

const argv = process.argv.slice(2)
const argOf = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}
const since = argOf('--since')
const day = argOf('--day')

const spendArgs = [SPEND, '--dispatches', '--json']
if (day) spendArgs.push('--day', day)
else if (since) spendArgs.push('--since', since)

let dispatches
try {
  dispatches = JSON.parse(execFileSync(process.execPath, spendArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
} catch (e) {
  console.error(`\nCould not read the dispatch list from spend.cjs: ${e.message}\n`)
  process.exit(1)
}

const builderDispatches = dispatches.filter((d) => BUILDERS.has(d.type) && d.turns > 0)
if (!builderDispatches.length) {
  console.log(`\ncheck-dispatch-coverage — no builder dispatches in range. Nothing to check.\n`)
  process.exit(0)
}

const rows = fs.existsSync(LEDGER)
  ? fs
      .readFileSync(LEDGER, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  : []

// (lane, day) is COVERED the moment the ledger holds any row naming that lane
// on that day, whatever its verdict — a `blocked-charter` or
// `needs-owner-decision` row is exactly as much "this dispatch was reported"
// as a `built` one. Only an entirely absent lane-day is the gap this exists
// to name.
const covered = new Set()
for (const r of rows) {
  if (!r.lane || !r.date) continue
  covered.add(`${r.lane}|${r.date}`)
}

const byKey = new Map()
for (const d of builderDispatches) {
  const key = `${d.type}|${d.day}`
  if (!byKey.has(key)) byKey.set(key, { lane: d.type, day: d.day, n: 0, turns: 0, cost: 0 })
  const g = byKey.get(key)
  g.n++
  g.turns += d.turns
  g.cost += d.cost
}

const missing = [...byKey.values()].filter((g) => !covered.has(`${g.lane}|${g.day}`))

if (missing.length) {
  console.error(`\nREFUSED — ${missing.length} builder lane-day(s) were dispatched with real work and left NO ledger row:\n`)
  for (const m of missing.sort((a, b) => b.cost - a.cost))
    console.error(`  ${m.day}  ${m.lane.padEnd(12)} ${m.n} dispatch(es), ${m.turns} turns, $${m.cost.toFixed(2)} — no row for this lane on this day in ledger.jsonl`)
  console.error(`\nBackfill each with scripts/ledger-file.cjs (cite the real diff, mark it as a backfill) before calling this wave or wrap done.\n`)
  process.exit(1)
}

console.log(`\ncheck-dispatch-coverage — ${builderDispatches.length} builder dispatch(es) across ${byKey.size} lane-day(s) checked. Every one has a matching ledger row.\n`)
process.exit(0)
