#!/usr/bin/env node
/**
 * run-history-file — the WRITER for `.claude/agent-loop/run-history.jsonl`,
 * a run's OWN liveness trail, separate from the ledger and from `report.md`.
 *
 * WHY THIS EXISTS. `report.md` and `ledger.jsonl` both record what a run FOUND —
 * neither records whether the run itself made it to the end. A run that dies
 * between "dispatched to the engine" and "report written" leaves no trace at
 * all: no ledger row (the engine never returned), no report line (step 4 never
 * ran), nothing but a cron log a human has to open by hand. This file is the
 * three-point trail that lets `run-manager-cron.ps1` (and any future reader)
 * answer "did this run die, and where" without re-deriving it from prose.
 *
 * Same doctrine as `ledger-file.cjs`: refuse loudly on bad input, append-only,
 * closed enum for every value, unknown flag refused rather than ignored. Full
 * ISO timestamp on every row (not day-only) — same-day runs need sub-day
 * ordering, which a `YYYY-MM-DD` stamp cannot give the cron wrapper's window
 * join.
 *
 * THE THREE STAMPS (Manager-side, one per Workflow-invoked run):
 *   node scripts/run-history-file.cjs --runId wf_abc123-def --stamp triggered --trigger user
 *   node scripts/run-history-file.cjs --runId wf_abc123-def --stamp results-in
 *   node scripts/run-history-file.cjs --runId wf_abc123-def --stamp report-written \
 *     --headline "<the exact report.md 4-line header, verbatim>" --pendingOwner 3
 *
 * THE FAILURE PATH (wrapper-side, only when nothing ever completed):
 *   node scripts/run-history-file.cjs --failed --trigger cron --exitcode 1 \
 *     --note "died after: results-in"
 *
 * `--targets` prints the closed set of valid `--stamp` and `--trigger` values.
 *
 * Read-only: nothing yet queries this file structurally (the cron wrapper
 * reads it directly, since its own join is a wall-clock window, not a lookup
 * this script is positioned to answer generically). This script only appends.
 */
const fs = require('fs')
const path = require('path')

const HISTORY = path.join(__dirname, '..', '.claude', 'agent-loop', 'run-history.jsonl')

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const flag = (name) => argv.includes(name)

const die = (msg, extra) => {
  console.error(`\nREFUSED — ${msg}\n`)
  if (extra) console.error(`${extra}\n`)
  process.exit(1)
}

const KNOWN_STAMPS = new Set(['triggered', 'results-in', 'report-written'])
const KNOWN_TRIGGERS = new Set(['cron', 'user'])

const KNOWN_FLAGS = new Set([
  '--targets',
  '--runId', '--stamp', '--trigger', '--headline', '--pendingOwner', '--note',
  '--failed', '--exitcode',
])
for (const tok of argv) {
  if (tok.startsWith('--') && !KNOWN_FLAGS.has(tok))
    die(`unrecognized flag "${tok}".`, `Known flags: ${[...KNOWN_FLAGS].sort().join(', ')}\nAn unrecognized flag is refused, not silently ignored.`)
}

if (flag('--targets') || argv.length === 0) {
  console.log(`\nStamps (--stamp): ${[...KNOWN_STAMPS].join(', ')}`)
  console.log(`Triggers (--trigger): ${[...KNOWN_TRIGGERS].join(', ')}`)
  console.log(`\nSee the file header for the exact command shape of each mode.\n`)
  process.exit(0)
}

const nowIso = () => new Date().toISOString()

// Same shape as ledger-file.cjs and architect-file.cjs's own run-id checks —
// a malformed id written now is unreadable by every future join against it.
const RUNID_RE = /^wf_[0-9a-f]{4,}-[0-9a-f]{2,}$/i
const isNonNegInt = (s) => /^\d+$/.test(String(s))
const isInt = (s) => /^-?\d+$/.test(String(s))

const append = (obj) => {
  fs.appendFileSync(HISTORY, JSON.stringify(obj) + '\n')
}

// ── the failure path — wrapper-side, only when nothing ever completed ───────
if (flag('--failed')) {
  if (argOf('--runId') || argOf('--stamp')) die('--failed does not take --runId or --stamp.', 'A failed row has no run to attach to — that is the whole point (the run never produced one, or never finished the trail it started). State the diagnosis in --note instead.')
  const trigger = argOf('--trigger')
  const exitcode = argOf('--exitcode')
  const note = argOf('--note')
  if (!trigger) die('no --trigger.', `One of: ${[...KNOWN_TRIGGERS].join(', ')}`)
  if (!KNOWN_TRIGGERS.has(trigger)) die(`--trigger "${trigger}" is not known.`, `One of: ${[...KNOWN_TRIGGERS].join(', ')}`)
  if (exitcode === null) die('no --exitcode.', 'The process exit code the wrapper observed — an integer, e.g. 1. Use 0 only if the process exited clean yet still never reached report-written (also a bug worth recording).')
  if (!isInt(exitcode)) die(`--exitcode "${exitcode}" is not an integer.`, 'Pass the raw exit code, e.g. $LASTEXITCODE — not a description of it.')
  if (!note || note.trim().length < 5) die(note ? `--note is ${note.trim().length} chars.` : 'no --note.', 'Say what stage the run got to before it died, e.g. "died after: results-in" or "died after: never triggered" — this is what a human reads six months from now with no other trail.')
  const row = { ts: nowIso(), failed: true, trigger, exitcode: Number(exitcode), note }
  append(row)
  console.log(`\nAppended — FAILED run (trigger=${trigger}, exitcode=${exitcode}) at ${row.ts}\n  note: ${note}\n`)
  process.exit(0)
}

// ── the three progressive stamps — Manager-side, on a live Workflow run ─────
if (flag('--exitcode')) die('--exitcode is only valid with --failed.', 'A stamped row records progress on a run, not its death.')

const runId = argOf('--runId')
const stamp = argOf('--stamp')
const trigger = argOf('--trigger')
const headline = argOf('--headline')
const pendingOwnerRaw = argOf('--pendingOwner')
const note = argOf('--note')

if (!runId) die('no --runId.', 'The id the Workflow call returned, e.g. wf_abc12345-def.')
if (!RUNID_RE.test(runId)) die(`--runId "${runId}" does not look like a real run id.`, 'Expected shape: wf_<hex>-<hex>, e.g. wf_abc12345-def. A malformed id is refused, not silently recorded — it would be unjoinable later.')
if (!stamp) die('no --stamp.', `One of: ${[...KNOWN_STAMPS].join(', ')}`)
if (!KNOWN_STAMPS.has(stamp)) die(`--stamp "${stamp}" is not known.`, `One of: ${[...KNOWN_STAMPS].join(', ')}`)

if (trigger && !KNOWN_TRIGGERS.has(trigger)) die(`--trigger "${trigger}" is not known.`, `One of: ${[...KNOWN_TRIGGERS].join(', ')}`)

if (stamp === 'triggered') {
  if (!trigger) die('a "triggered" stamp needs --trigger.', `One of: ${[...KNOWN_TRIGGERS].join(', ')} — this is the ONLY stamp where the trigger is known, so it is required here, not derivable later.`)
  if (headline || pendingOwnerRaw) die('a "triggered" stamp takes no --headline or --pendingOwner.', 'Neither exists yet at trigger time — those belong to the terminal "report-written" stamp only.')
}

if (stamp === 'results-in') {
  if (headline || pendingOwnerRaw) die('a "results-in" stamp takes no --headline or --pendingOwner.', 'The report has not been written yet at this seam — those belong to the terminal "report-written" stamp only.')
}

if (stamp === 'report-written') {
  if (!headline || headline.trim().length < 20) die(headline ? `--headline is ${headline.trim().length} chars.` : 'no --headline.', 'The exact report.md 4-line header block, verbatim — no recompute, no summary of it.')
  if (pendingOwnerRaw === null) die('no --pendingOwner.', 'The report\'s own "N rows await you" count, as an integer — e.g. 3.')
  if (!isNonNegInt(pendingOwnerRaw)) die(`--pendingOwner "${pendingOwnerRaw}" is not a non-negative integer.`, 'Pass the bare number the report states, e.g. 3 or 0.')
}

const row = { ts: nowIso(), runId, stamp }
if (trigger) row.trigger = trigger
if (stamp === 'report-written') {
  row.headline = headline
  row.pendingOwner = Number(pendingOwnerRaw)
}
if (note) row.note = note

append(row)
console.log(`\nAppended — ${runId} [${stamp}] at ${row.ts}${trigger ? ` · trigger=${trigger}` : ''}${stamp === 'report-written' ? ` · pendingOwner=${row.pendingOwner}` : ''}\n`)
