#!/usr/bin/env node
/**
 * architect-file — file a FRAMEWORK finding for the architect agent.
 *
 * Any chat that hits a problem in the framework itself — an engine that did
 * nothing while reporting success, a manifest that lied, a skill instruction
 * that contradicts the code — files it here instead of telling the owner and
 * hoping he relays it. He is not a message bus.
 *
 * This is for the FRAMEWORK, never for Maelle. A Maelle bug is a GitHub issue
 * or a report row and belongs to a lane. If your finding is about scheduling,
 * timezones, guards, email or anything a user experiences, you are in the wrong
 * script.
 *
 * Why a script rather than "append a JSON line":
 *   • It assigns the next A-number, so two chats filing at once cannot collide.
 *   • It REFUSES a row with no evidence. The bug ledger has the scout as a
 *     filter; this ledger has none, so the only defence against it filling with
 *     half-formed notes is that a bad row cannot be created in the first place.
 *   • One shape, so `ledger-stats` can read it.
 *
 * Append-only. Never rewrites an existing row.
 *
 * Usage:
 *   node scripts/architect-file.cjs \
 *     --finding "the manifest reports plumbing health, not yield" \
 *     --evidence "wf_33541300-121: misroutedLanes 0 and waveFilesNamed 1 while 1 of 4 findings was dispatchable" \
 *     --target both-engines \
 *     --source "product chat" \
 *     [--note "fix shape: a yield line"]
 *
 *   node scripts/architect-file.cjs --targets     # list valid targets
 */
const fs = require('fs')
const path = require('path')

const LEDGER = path.join(__dirname, '..', '.claude', 'agent-loop', 'architect-ledger.jsonl')

const TARGETS = [
  'bugger.js',
  'feature.js',
  'charter-audit.js',
  'both-engines',
  'SKILL.md',
  'SESSION_STARTER.md',
  'charter',
  'ledger',
  'scripts',
  'state',
  'process',
]

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}

if (argv.includes('--targets')) {
  console.log(`\nValid --target values:\n  ${TARGETS.join('\n  ')}\n`)
  process.exit(0)
}

const finding = argOf('--finding')
const evidence = argOf('--evidence')
const target = argOf('--target')
const source = argOf('--source') || 'unnamed chat'
const note = argOf('--note') || ''

const die = (msg, extra) => {
  console.error(`\nREFUSED — ${msg}\n`)
  if (extra) console.error(`${extra}\n`)
  process.exit(1)
}

if (!finding) die('no --finding.', 'One sentence: what is wrong. Not a topic — a defect.')
if (finding.length < 25) die(`--finding is ${finding.length} chars.`, 'Too short to act on. State the defect, not the area.')
if (!target) die('no --target.', `One of:\n  ${TARGETS.join('\n  ')}`)
if (!TARGETS.includes(target)) die(`--target "${target}" is not a known target.`, `One of:\n  ${TARGETS.join('\n  ')}`)
if (!evidence) die('no --evidence.', 'A framework finding without evidence is a hunch, and the architect has no scout to filter it.')
if (evidence.length < 30) die(`--evidence is ${evidence.length} chars.`, 'Cite the thing you actually saw.')

// Evidence must POINT somewhere. The owner is exempt: when he reports a problem,
// his account IS the evidence and demanding a file:line from him is nonsense.
const POINTS_SOMEWHERE = /(:\d+)|(\bwf_[a-z0-9-]+)|(\.(?:js|cjs|ts|md|log|jsonl|json|yaml)\b)|(\bnode |\bgit |\bnpm )/i
if (!/owner/i.test(source) && !POINTS_SOMEWHERE.test(evidence)) {
  die(
    'that --evidence does not point at anything checkable.',
    `It needs at least one of: a \`file:line\`, a run id (\`wf_…\`), a filename, or the command you ran.\n` +
      `The architect must be able to re-derive your finding rather than take it on trust.\n` +
      `If you are the owner reporting what you saw, pass --source owner.`
  )
}

// ---- read what exists, assign the next id, check for an obvious re-file ----
let rows = []
if (fs.existsSync(LEDGER)) {
  rows = fs
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
}

const maxId = rows.reduce((n, r) => {
  const m = String(r.id || '').match(/^A(\d+)$/)
  return m ? Math.max(n, Number(m[1])) : n
}, 0)
const id = `A${maxId + 1}`

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
const head = norm(finding).slice(0, 45)
const clash = rows.find((r) => r.verdict !== 'built' && r.verdict !== 'declined' && norm(r.finding).slice(0, 45) === head)
if (clash) {
  console.error(`\nREFUSED — this looks like a re-file of ${clash.id} (still ${clash.verdict}):\n`)
  console.error(`  ${clash.id}: ${String(clash.finding).slice(0, 140)}\n`)
  console.error(`If it is genuinely new, say what is different in --finding. If it is the same problem`)
  console.error(`recurring with new information, that belongs on ${clash.id} — hand it to the owner to add.\n`)
  process.exit(1)
}

const row = {
  id,
  date: new Date().toISOString().slice(0, 10),
  source,
  target,
  finding,
  evidence,
  verdict: 'open',
  note,
}

fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n')

console.log(`\nFiled ${id} — target ${target}, from ${source}\n`)
console.log(`  finding : ${finding}`)
console.log(`  evidence: ${evidence}`)
if (note) console.log(`  note    : ${note}`)
console.log(`\nIt is OPEN. The architect reads its own ledger, triages, and proposes —`)
console.log(`nothing gets built off this row until the owner approves it.\n`)
