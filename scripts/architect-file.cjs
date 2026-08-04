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
 *   • It assigns the LOWEST FREE X-number, so two chats filing at once cannot
 *     collide and a number a merge freed comes back into use.
 *   • It REFUSES a row with no evidence. The bug ledger has the editor as a
 *     filter; this ledger has none, so the only defence against it filling with
 *     half-formed notes is that a bad row cannot be created in the first place.
 *   • One shape, so `ledger-stats` can read it.
 *
 * Append-only, with ONE mechanised exception. A completed row is TWO lines, the
 * filing and the closing, and `ledger-stats --architect` collapses them by id.
 * The exception is `--duplicate`, below: a merge REMOVES the absorbed row's lines
 * so its number is genuinely free, and copies its finding, evidence and analysis
 * onto the survivor so nothing is lost. Every other path only ever appends.
 *
 * ONE HISTORICAL EXCEPTION besides that: on 2026-07-31 the owner authorised a full
 * rewrite of every line to move this ledger's ids from `A` to `X` (row X75), so
 * that `A` means the architect's charter rules and nothing else. Ids, `amends`
 * fields and every citation were rewritten in place; the X75 row's own prose is
 * frozen because it narrates the rename.
 *
 * Usage:
 *   node scripts/architect-file.cjs --close X29 \
 *     --built "no new mode — bugger.js PRESET path already is it; SKILL.md routes rulings back through `build`"
 *
 *   node scripts/architect-file.cjs --close X22 --declined "his words: not worth the second index"
 *
 *   node scripts/architect-file.cjs --close X62 --refuted "mirrored the detector over all 74 rows: 4.51 flags per filing, not the 2.02 the row assumed"
 *
 *   node scripts/architect-file.cjs --close <the duplicate> --duplicate <the row that survives>
 *     A merge names no number here on purpose: a freed one is reused, so an example
 *     citing it would be pointing at different work within the week.
 *
 *   node scripts/architect-file.cjs --recheck X26 --checked "read architect.md frontmatter — still session-cached"
 *
 *   node scripts/architect-file.cjs \
 *     --finding "the manifest reports plumbing health, not yield" \
 *     --evidence "wf_33541300-121: misroutedLanes 0 and waveFilesNamed 1 while 1 of 4 findings was dispatchable" \
 *     --target both-engines \
 *     --source "product chat" \
 *     [--note "fix shape: a yield line"] \
 *     [--amends X8 | --amends none]
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
  'WRAP_UP.md',
  'charter',
  'ledger',
  'scripts',
  'state',
  'process',
]

// X10 · `refuted` closes a row the ARCHITECT disproved, and it is a third thing:
// `built` is work that shipped, `declined` is the owner ruling against it, and a
// withdrawal-on-measurement is neither. Until now it had to be written `--declined`,
// whose own die message says "give HIS reason" — so X62, refuted by a measurement
// that showed its premise false, is recorded in this ledger as if he had ruled on
// it. The charter tells the architect to expect to refute a fair share of the rows
// it is handed; a verdict it cannot write is a verdict that gets miswritten.
//
// X78 · THE ONE DEFINITION, and it lives with the WRITER because this file is the
// only thing that can mint a verdict. `ledger-stats --architect` kept a second copy
// and the two had already drifted — the reader also counted `duplicate`, a verdict
// no row carries because a merge DELETES the absorbed row instead of writing one,
// which is exactly why nobody noticed. It is exported and read there, so a new
// closing verdict is added here and both views move together.
const CLOSED = new Set(['built', 'declined', 'refuted'])
const stillOpen = (rs) => rs.filter((r) => !CLOSED.has(r.verdict)).length
module.exports = { CLOSED }
// Required by the reader for that set alone. Everything below is the CLI, and the
// filing path ends in `process.exit`, so a plain `require` of this file would kill
// its caller. Nothing above this line touches the ledger or `process.argv`.
if (require.main !== module) return

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}

if (argv.includes('--targets')) {
  console.log(`\nValid --target values:\n  ${TARGETS.join('\n  ')}\n`)
  process.exit(0)
}

// X163 · ONLY AN ARCHITECT SESSION FILES OR CLOSES A ROW HERE. His words,
// 2026-08-04: "I don't want other agents, or other chat to send messages to
// the framework. only here." Every path below this line is a WRITE — filing,
// closing, rechecking, merging — so the gate sits once, before any of them,
// rather than duplicated per path where a new write path could add itself
// without the check.
//
// This does not (and cannot, from a plain Node script) cryptographically prove
// which agent is calling it — it proves the caller DECLARED itself the
// architect. That is the honest claim to make: it stops the casual, silent
// case this ruling is actually about (a chat that hits a framework problem
// and files it without a second thought, the exact behaviour SESSION_STARTER.md
// used to invite), not a determined attempt to lie about who is calling.
if (argOf('--session') !== 'architect') {
  console.error(`\nREFUSED — missing --session architect.\n`)
  console.error(
    `Owner's ruling, 2026-08-04: "I don't want other agents, or other chat to send messages to the framework. only here." ` +
      `Filing and closing rows on this ledger is now architect-session-only. If you are running as the architect, re-invoke with ` +
      `--session architect. If you are not, do not file this yourself — hand the finding to the architect instead (or wait for the ` +
      `next architect session and give it to that chat directly).\n`,
  )
  process.exit(1)
}

const finding = argOf('--finding')
const evidence = argOf('--evidence')
const target = argOf('--target')
const source = argOf('--source') || 'unnamed chat'
const note = argOf('--note') || ''
const amends = argOf('--amends') || ''
const closeId = argOf('--close')
const built = argOf('--built')
const declined = argOf('--declined')
const refuted = argOf('--refuted')
const duplicate = argOf('--duplicate')
const recheckId = argOf('--recheck')
const checked = argOf('--checked')

const die = (msg, extra) => {
  console.error(`\nREFUSED — ${msg}\n`)
  if (extra) console.error(`${extra}\n`)
  process.exit(1)
}

// Evidence must POINT somewhere — for a filing, and for a closing row too. The
// owner is exempt on a FILING: when he reports a problem his account IS the
// evidence and demanding a file:line from him is nonsense. There is no exemption
// on a CLOSING: "it is done" with nothing to check is the row this ledger keeps
// producing.
const POINTS_SOMEWHERE = /(:\d+)|(\bwf_[a-z0-9-]+)|(\.(?:js|cjs|ts|md|log|jsonl|json|yaml)\b)|(\bnode |\bgit |\bnpm )/i

// ---- read what exists, collapsing each id to its LATEST state ---------------
// X41 · append-only means one id legitimately has several lines: the filing, then
// the closing. Every check below asks "what is this row's state NOW", so it reads
// the collapsed view — otherwise a built row still matches the OPEN clash check
// and every re-file is refused with "still open" about work that shipped. Same
// merge `ledger-stats --architect` does, for the same reason.
let rows = []
if (fs.existsSync(LEDGER)) {
  const latest = new Map()
  fs.readFileSync(LEDGER, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .forEach((l) => {
      let r = null
      try {
        r = JSON.parse(l)
      } catch {
        return
      }
      if (r && r.id) latest.set(r.id, { ...(latest.get(r.id) || {}), ...r })
    })
  rows = [...latest.values()]
}
// ---- the merge gate, as code ------------------------------------------------
// A merged row's number is only free once NOTHING still names it, because there
// is no tombstone to resolve a leftover reference and the minter below hands that
// number to the next filing. So this scans the places a row id is ever written —
// this ledger, the bug ledger, `report.md`, `state.json`, every charter, both
// engines, the Manager skill, SESSION_STARTER and every script — and the merge
// REFUSES while one remains. His gate, 2026-07-31, mechanised rather than
// remembered.
const REPO = path.join(__dirname, '..')
const SCAN_DIRS = [path.join(REPO, '.claude'), path.join(REPO, 'scripts')]
const SCANNABLE = /\.(md|js|cjs|mjs|json|jsonl|ts)$/
const SKIP_DIR = /^(node_modules|worktrees|\.git)$/
/** Every place `id` is still named, excluding its OWN lines in this ledger. */
const refsElsewhere = (id) => {
  const re = new RegExp(`\\b${id}\\b`)
  const out = []
  const scan = (file) => {
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((l, i) => {
        if (!re.test(l)) return
        if (file === LEDGER) {
          try {
            if (JSON.parse(l).id === id) return
          } catch {
            /* an unparseable ledger line still counts as a reference */
          }
        }
        out.push(`${path.relative(REPO, file).replace(/\\/g, '/')}:${i + 1}  ${l.trim().slice(0, 130)}`)
      })
  }
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIR.test(e.name)) walk(p)
      } else if (SCANNABLE.test(e.name)) scan(p)
    }
  }
  for (const d of SCAN_DIRS) if (fs.existsSync(d)) walk(d)
  return out
}
/** The absorbed row's whole substance, in one string, naming no dead number. */
const carryOver = (r) => {
  const bits = [
    `ABSORBED A DUPLICATE — a second row for this same defect, filed ${r.date || '(no date)'} by ${r.source || '(no source)'}, target ${
      r.target || '(no target)'
    }. Its number was freed for reuse, so it is named nowhere; its own words are kept here.`,
    `FINDING: ${r.finding || '(none)'}`,
    `EVIDENCE: ${r.evidence || '(none)'}`,
  ]
  if (String(r.note || '').trim()) bits.push(`NOTE: ${r.note}`)
  if (r.amends) bits.push(`IT AMENDED: ${r.amends}`)
  if (r.recheck) bits.push(`RE-READ: ${r.recheck}`)
  if (r.built) bits.push(`IT CLOSED built: ${r.built}`)
  if (r.declined) bits.push(`IT CLOSED declined: ${r.declined}`)
  if (r.refuted) bits.push(`IT CLOSED refuted: ${r.refuted}`)
  if (!r.built && !r.declined && !r.refuted) bits.push(`ITS STATE AT MERGE: ${r.verdict || 'open'}`)
  return bits.join(' · ')
}

// ── X41 · CLOSE A ROW. The ledger had no way to record that work was DONE ────
// X44 · and no way to record that the owner said NO. `--built` was the only
// closing, so the two `declined` rows in this ledger (X4, X13) were typed in by
// hand at migration and every decline since would have been too — which is the
// same hole one direction along: a ruling nobody can write down gets re-raised,
// and re-raising a decision he already made is the failure the whole ledger
// exists to stop. A decline takes `--declined "<his reason>"` and is deliberately
// NOT held to `POINTS_SOMEWHERE`: his ruling IS the evidence, exactly as it is on
// a filing, and demanding a file:line from a "no" is nonsense.
// Sixteen rows read `open` on 2026-07-30 with their mechanisms shipped, because
// nothing could write a completion — the 19 rows that read `built` had that value
// typed in by hand at migration. So `--open` counted finished work as live
// decisions, and every number built on it (the report headline, the decision
// budget, the confirmed-vs-re-read split) was computed off a set that was 84%
// done.
//
// It APPENDS. Rewriting the filing row would delete the finding, the evidence and
// the analysis that are the whole point of keeping a ledger.
//
// `--built` is REQUIRED and must point somewhere, because a completion with no
// evidence is worse than an open row: it closes the item here and leaves the
// proof nowhere. Name what shipped and WHERE.
if (closeId) {
  if (!rows.length) die('the ledger is empty — there is nothing to close.')
  const row = rows.find((r) => r.id === closeId)
  if (!row) die(`--close ${closeId} is not a row in this ledger.`, `Read it with: node scripts/ledger-stats.cjs --architect`)
  // A MERGE is exempt from this guard and nothing else is: a duplicate row is
  // removed whatever its state, and all four of the first merges were between rows
  // already built.
  if (!duplicate && CLOSED.has(row.verdict))
    die(
      `${closeId} is already ${row.verdict} (${row.date}).`,
      `It says: ${String(row.built || row.declined || row.refuted || row.note || '(no closing evidence recorded)').slice(0, 200)}\n` +
        `If the work has MOVED or come undone, that is a new finding — file it with --amends ${closeId}.`,
    )
  const flags = [built && '--built', declined && '--declined', refuted && '--refuted', duplicate && '--duplicate'].filter(Boolean)
  if (flags.length > 1)
    die(
      `--close takes ONE of --built, --declined, --refuted or --duplicate. Got ${flags.join(' and ')}.`,
      'Work that shipped is `built`. A ruling against it is `declined`. A row DISPROVED by measurement is `refuted`. A second row for one defect is `duplicate`. One row cannot be two of those.',
    )
  if (!flags.length)
    die(
      `no --built, no --declined, no --refuted and no --duplicate.`,
      'A build closing names what shipped and WHERE. A closing row with no evidence destroys the history this ledger exists for.\n' +
        'Cite the FILE AND THE THING — `bugger.js manifest.carry`, `SKILL.md the wrap step` — not only a line number.\n' +
        'A line drifts with the next edit: nineteen rows closed on 2026-07-30 went 9 lines stale the same hour, from one later edit above them.\n' +
        'If the OWNER ruled against it, that is `--declined "<his reason>"` — his words, no citation needed.\n' +
        'If YOU DISPROVED IT, that is `--refuted "<the measurement>"` — never `--declined`, which claims he ruled.\n' +
        'If it is a SECOND ROW FOR ONE DEFECT, that is `--duplicate <the row that survives>`.',
    )

  // ── X41 · A MERGE — the one path here that REMOVES a line ───────────────────
  // Two rows for one defect cost a triage slot every time the pile is read, and a
  // merged row's number is worth more free than occupied: his ceiling is about a
  // hundred live rows and the minter below fills the lowest gap, so a freed number
  // comes back into use instead of being left behind.
  //
  // NO TOMBSTONE — his call, 2026-07-31, and it is what makes the number genuinely
  // free. A `{id, verdict:'duplicate'}` stub would keep the id occupied AND point
  // at content that had moved, which is one number meaning two things — the exact
  // failure the A-to-X rename was done to kill.
  //
  // X41's objection to rewriting is ANSWERED, not ignored: rewriting a filing row
  // would delete the finding, the evidence and the analysis that are the whole
  // point of keeping a ledger, so `carryOver` copies all of it onto the survivor,
  // which is the row that now carries the defect. Nothing is lost but a number.
  //
  if (duplicate) {
    const survivor = rows.find((r) => r.id === duplicate)
    if (!survivor) die(`--duplicate ${duplicate} is not a row in this ledger.`, 'Name the row that SURVIVES — it keeps its number and gains this one\'s words.')
    if (duplicate === closeId) die('--duplicate names the same row as --close.', 'A row cannot absorb itself.')
    const hits = refsElsewhere(closeId)
    if (hits.length)
      die(
        `${closeId} is still named in ${hits.length} place(s), so its number is NOT free.`,
        hits.join('\n') +
          `\n\nRewrite every one of them to ${duplicate} first. There is no tombstone to resolve a leftover reference,\n` +
          `so one left behind will point at whatever is minted into ${closeId} next.\n` +
          `If a reference cannot be rewritten TRUTHFULLY, stop and say so — do not force it.`,
      )
    const carried = carryOver(row)
    if (new RegExp(`\\b${closeId}\\b`).test(carried))
      die(
        `the absorbed row's own text names ${closeId}, so copying it would re-create the reference this merge removes.`,
        'Rewrite that sentence in the row itself first, then re-run.',
      )
    const record = { id: duplicate, date: new Date().toISOString().slice(0, 10), duplicate: carried }
    const kept = fs
      .readFileSync(LEDGER, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .filter((l) => {
        try {
          return JSON.parse(l).id !== closeId
        } catch {
          return true
        }
      })
    fs.writeFileSync(LEDGER, kept.concat(JSON.stringify(record)).join('\n') + '\n')
    const openNow = stillOpen(rows.filter((r) => r.id !== closeId))
    console.log(`\nMerged ${closeId} into ${duplicate} — ${closeId} is GONE and its number is free\n`)
    console.log(`  absorbed : ${String(row.finding || '(no finding)').slice(0, 120)}`)
    console.log(`  survivor : ${duplicate} [${survivor.verdict || 'open'}] ${String(survivor.finding || '(no finding)').slice(0, 108)}`)
    console.log(`  kept     : ${carried.length} chars of the absorbed row's own words, on ${duplicate}'s \`duplicate\` line`)
    console.log(`\n${openNow} row(s) still open. The next filing takes the LOWEST free number, which may now be ${closeId.slice(1)}.\n`)
    process.exit(0)
  }

  if (built && built.length < 20) die(`--built is ${built.length} chars.`, 'Too short to check. Cite the file and the symbol, the command, or the commit.')
  if (built && !POINTS_SOMEWHERE.test(built))
    die(
      'that --built does not point at anything checkable.',
      `It needs at least one of: a \`file:line\`, a filename, a run id (\`wf_…\`), or the command that proves it.\n` +
        `"done" and "shipped" are not closings — the next reader must be able to open the thing you built.`,
    )
  if (declined && declined.length < 20)
    die(`--declined is ${declined.length} chars.`, 'Give his reason, not just "no". The next reader must be able to tell a decline from a deferral without asking him again.')
  // X10 · held to the SAME bar as `--built` and for the same reason. A decline is
  // exempt because his ruling is the evidence; a refutation has no such backing —
  // it is a claim that the row was wrong, and a claim nobody can re-derive is how
  // a real finding gets closed by an agent that simply could not reproduce it.
  if (refuted && refuted.length < 20) die(`--refuted is ${refuted.length} chars.`, 'State what you MEASURED and what it showed. "not real" is not a refutation.')
  if (refuted && !POINTS_SOMEWHERE.test(refuted))
    die(
      'that --refuted does not point at anything checkable.',
      `It needs at least one of: a \`file:line\`, a filename, a run id (\`wf_…\`), or the command that proves it.\n` +
        `The row claimed something about the code — name where you looked and what was there instead.`,
    )
  const today = new Date().toISOString().slice(0, 10)
  const closing = built
    ? { id: closeId, date: today, verdict: 'built', built }
    : refuted
      ? { id: closeId, date: today, verdict: 'refuted', refuted }
      : { id: closeId, date: today, verdict: 'declined', declined }
  fs.appendFileSync(LEDGER, JSON.stringify(closing) + '\n')
  const openNow = stillOpen(rows.map((r) => (r.id === closeId ? closing : r)))
  console.log(`\nClosed ${closeId} — ${closing.verdict}\n`)
  console.log(`  was    : ${String(row.finding || '(no finding)').slice(0, 120)}`)
  console.log(`  ${closing.verdict.padEnd(8)}: ${built || refuted || declined}`)
  console.log(`\n${openNow} row(s) still open. Check with: node scripts/ledger-stats.cjs --architect\n`)
  process.exit(0)
}

// ── X47 · RECORD THAT SOMEBODY LOOKED ────────────────────────────────────────
// X38 flags a row RE-READ when a commit touched the file it cites after the row
// was written. Nothing could record the answer "I opened it, it is still real",
// so a row re-read today was flagged again tomorrow and the re-read had to be
// paid again — which is what makes a nightly backlog pass unaffordable rather
// than cheap.
//
// It is the row's own DATE that the staleness check compares, so the confirmation
// is simply a later date: `{id, date, recheck}` and nothing else. NO verdict, on
// purpose — the reader merges by id, so omitting it keeps the row's real state
// (`open` stays open) instead of a confirmation quietly re-writing the verdict.
// `recheck` is what you read, so the next reader can tell a real look from a
// rubber stamp.
if (recheckId) {
  const row = rows.find((r) => r.id === recheckId)
  if (!row) die(`--recheck ${recheckId} is not a row in this ledger.`, `Read it with: node scripts/ledger-stats.cjs --architect`)
  if (CLOSED.has(row.verdict)) die(`${recheckId} is already ${row.verdict} (${row.date}).`, 'A closed row is not re-read. If the work has come undone, file it with --amends ' + recheckId + '.')
  if (!checked) die('no --checked.', 'Name what you OPENED. A confirmation nobody can check is worse than the stale flag it clears.')
  if (checked.length < 20) die(`--checked is ${checked.length} chars.`, 'Cite the file and the symbol you read, and what you found there.')
  if (!POINTS_SOMEWHERE.test(checked))
    die('that --checked does not point at anything.', 'Name the file you opened — `bugger.js the PRESET branch`, `SKILL.md the wrap step`. "still real" alone is a rubber stamp.')
  const confirm = { id: recheckId, date: new Date().toISOString().slice(0, 10), recheck: checked }
  fs.appendFileSync(LEDGER, JSON.stringify(confirm) + '\n')
  // X86 · it says STILL REAL, not "confirmed": this row was just re-read and is
  // still unfixed work, and `confirmed` is the word that made him read 38 open rows
  // as done. The stored line below is untouched — `{id, date, recheck}`, no verdict.
  console.log(`\nSTILL REAL — ${recheckId} re-read ${confirm.date}, verdict stays \`${row.verdict}\`\n`)
  console.log(`  finding : ${String(row.finding || '(no finding)').slice(0, 120)}`)
  console.log(`  checked : ${checked}`)
  console.log(`\nIt stays OPEN and will no longer print as RE-READ until the code it cites moves again.\n`)
  process.exit(0)
}

if (!finding) die('no --finding.', 'One sentence: what is wrong. Not a topic — a defect.')
if (finding.length < 25) die(`--finding is ${finding.length} chars.`, 'Too short to act on. State the defect, not the area.')
if (!target) die('no --target.', `One of:\n  ${TARGETS.join('\n  ')}`)
if (!TARGETS.includes(target)) die(`--target "${target}" is not a known target.`, `One of:\n  ${TARGETS.join('\n  ')}`)
if (!evidence) die('no --evidence.', 'A framework finding without evidence is a hunch, and the architect has no editor to filter it.')
if (evidence.length < 30) die(`--evidence is ${evidence.length} chars.`, 'Cite the thing you actually saw.')

if (!/owner/i.test(source) && !POINTS_SOMEWHERE.test(evidence)) {
  die(
    'that --evidence does not point at anything checkable.',
    `It needs at least one of: a \`file:line\`, a run id (\`wf_…\`), a filename, or the command you ran.\n` +
      `The architect must be able to re-derive your finding rather than take it on trust.\n` +
      `If you are the owner reporting what you saw, pass --source owner.`
  )
}

// ---- assign the next id, check for an obvious re-file ----
// X75 · the letter is X, and it is X so that it can never move again. `A` now
// means exactly one thing — the architect's own charter rules in
// `.claude/agents/architect.md` — and `F` was rejected because Foreman /
// Forecaster / Filter are all agents someone may want, while nothing will ever
// want X. The 2026-07-31 migration rewrote every id, every `amends` and every
// citation; the only text left on `A` in this ledger is a charter-rule citation.
//
// THE LOWEST FREE NUMBER, never the next one. His rule, 2026-07-31: merging
// duplicates releases ids and those gaps get filled, which is how this ledger
// stays around a hundred live rows instead of climbing forever. The minter is
// where that has to live — prose in two files would be remembered on some
// filings and not others.
const used = new Set(
  rows
    .map((r) => {
      const m = String(r.id || '').match(/^X(\d+)$/)
      return m ? Number(m[1]) : 0
    })
    .filter(Boolean),
)
let next = 1
while (used.has(next)) next += 1
const id = `X${next}`

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
const head = norm(finding).slice(0, 45)

// ── X40 · THE CLASH CHECK, both directions ──────────────────────────────────
// It used to skip `built` and `declined` rows entirely, which is exactly
// backwards for the most expensive mistake this ledger can hold. Re-filing an
// OPEN row wastes a triage slot. Re-filing a BUILT one sends a lane to build a
// mechanism that already exists — and it happened: X30 was filed on 2026-07-30
// claiming the verify's discovery routing did not exist, while X8 had shipped
// exactly that on 2026-07-27. The filer said nothing, because X8 was built. This
// ledger has no editor in front of it, so this check IS the filter, and its hole
// sat precisely where the framework's memory lives.
//
// An open clash still REFUSES — that is unchanged and it is right.
// A closed clash is usually an AMENDMENT: the mechanism exists and the policy on
// top of it is wrong, which is what X30 turned out to be. So it asks for the link
// instead of refusing outright, because refusing outright would lose real rows.
const openClash = rows.find((r) => !CLOSED.has(r.verdict) && norm(r.finding).slice(0, 45) === head)
if (openClash) {
  console.error(`\nREFUSED — this looks like a re-file of ${openClash.id} (still ${openClash.verdict}):\n`)
  console.error(`  ${openClash.id}: ${String(openClash.finding).slice(0, 140)}\n`)
  console.error(`If it is genuinely new, say what is different in --finding. If it is the same problem`)
  console.error(`recurring with new information, that belongs on ${openClash.id} — hand it to the owner to add.\n`)
  process.exit(1)
}

// TWO detectors, one destination. The 45-char head is exact and catches a
// near-verbatim re-file; it could never have caught X30 against X8, which share
// no opening at all. So the second detector is by DISTINCTIVE TERM: a word this
// ledger rarely uses, shared between the new finding and a closed row.
//
// X45 · the corpus is the closed row's `finding` + `note` + **`built`** — what
// shipped, not only what was wrong. The question this detector exists to answer is
// "does that mechanism already EXIST", and the sentence that describes the
// mechanism is the closing one; `built` did not exist as a field until 2026-07-30,
// so it could only ever match the complaint. MEASURED across all 43 rows: adding
// it leaves the flag rate identical at 87 total flags, and moves WHICH rows are
// named — X30's text now also reaches X41 and X11's stops matching X30 on
// `bugger/warned`. Same cost, better aim.
//
// `duplicate` joined the corpus on 2026-07-31 with the merge path above, and it is
// not optional: an absorbed row's finding and evidence live ONLY on its survivor
// now, so leaving the field out would make a merged defect re-fileable — the hole
// X40 and X61 closed, re-opened by the merge itself. MEASURED over all 74 rows:
// 334 flags against 324, 4.51 per filing against 4.38, and the same 68 filings
// refused once. It changes WHO gets named, not how often.
//
// X58 · BOTH THRESHOLDS ARE ABSOLUTE, on the owner's ruling 2026-07-31. The pair was
// `df <= 10% of rows` with `>= 2 shared`, and the relative half was the defect: `RARE`
// rose WITH the row count, so more words qualified as rare AND there were more rows to
// match them against, both pushing the same way. MEASURED by mirroring this detector
// over all 83 collapsed rows — the old pair fired **4.96 flags per filing and refused
// 90% of them**, which is a refusal carrying almost no information and a second run
// charged for nearly every filing. `RARE = 4` with `>= 3 shared` fires **0.16 per
// filing, refusing 13%**, and the amend-linked pairs still name each other (X82→X77,
// X58→X61).
//
// The old comment kept the loose pair because tightening "loses X8, the one case this
// detector was built for". That justification was already dead when it was written:
// X30's text stopped naming X8 somewhere between 42 rows and 59, when the linking term
// `next` grew past the rising `RARE`. The pair was priced for a catch it no longer made.
//
// OBSERVABLE: flags per filing, re-derivable by mirroring this block over the ledger.
const STOP = new Set(
  ('the a an and or of to in on for it its is are was were be been that this those these so no not but with as at by from into than then when where which who whom whose what while has have had do does did can could may might must shall should will would if else there their they them his her our your my me we us you i one two also only even just about after before over under again more most less least other another same such per via yet own too very'.split(
    ' ',
  )),
)
const terms = (s) => new Set((String(s || '').toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w)))
// One corpus function, used for the rarity count AND for the per-row match, so a
// word cannot be "rare" by one definition and matched by another.
const corpusOf = (r) => `${r.finding} ${r.note} ${r.built || ''} ${r.declined || ''} ${r.duplicate || ''}`
const df = new Map()
for (const r of rows) for (const w of terms(corpusOf(r))) df.set(w, (df.get(w) || 0) + 1)
const RARE = 4
const mine = [...terms(finding)].filter((w) => (df.get(w) || 0) <= RARE)
// X61 · OPEN ROWS ARE IN THIS POOL TOO. They used to be skipped outright, so an
// open row had exactly ONE detector — the 45-character exact head above — and a
// PARAPHRASE walked straight past it: X53 was open with "the report's id column
// carries ledger slugs instead of numbers…" and "the report id column carries
// ledger slugs instead of numbers so he cannot type a row id" filed clean as a
// new row. The cheap error and the expensive one had swapped protections; a
// closed row had two detectors and a live decision had one.
//
// Same REFUSED-ONCE treatment, not a hard refusal: a fuzzy match is a question,
// not a verdict, and refusing outright would lose real rows. Even at X58's tighter
// pair it stays a question. The output says which state each match is in, because the right answer
// differs — an open match usually belongs ON that row, a closed one is usually
// an amendment.
const related = []
for (const r of rows) {
  const theirs = terms(corpusOf(r))
  const shared = norm(r.finding).slice(0, 45) === head ? ['the same opening sentence'] : mine.filter((w) => theirs.has(w))
  if (shared.length >= 3 || shared[0] === 'the same opening sentence') related.push({ r, shared })
}
if (related.length && !amends) {
  const nOpen = related.filter(({ r }) => !CLOSED.has(r.verdict)).length
  console.error(`\nREFUSED ONCE — ${related.length} row(s) cover ground this finding names (${nOpen} still OPEN):\n`)
  for (const { r, shared } of related)
    console.error(`  ${r.id} [${CLOSED.has(r.verdict) ? r.verdict : 'OPEN'} ${r.date}] shares ${shared.slice(0, 4).join(', ')}\n     ${String(r.finding).slice(0, 130)}`)
  console.error(`\nAn OPEN match is usually the same live decision said differently — that belongs on`)
  console.error(`that row, not on a second one competing with it. A CLOSED match is usually an`)
  console.error(`AMENDMENT: the mechanism exists and the POLICY on top of it is wrong.`)
  console.error(`Read them, then re-run with ONE of:`)
  console.error(`  --amends <id>    it amends that row; the link is recorded and stays greppable`)
  console.error(`  --amends none    you read them and it is genuinely unrelated\n`)
  process.exit(1)
}
if (amends && amends !== 'none' && !rows.some((r) => r.id === amends)) die(`--amends ${amends} is not a row in this ledger.`, 'Pass an existing X-number, or `--amends none`.')

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
// A11 · an id names its parent. Recorded as a field rather than left in the
// terminal output, so the link survives the chat that noticed it.
if (amends && amends !== 'none') row.amends = amends

fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n')

console.log(`\nFiled ${id} — target ${target}, from ${source}\n`)
console.log(`  finding : ${finding}`)
console.log(`  evidence: ${evidence}`)
if (row.amends) console.log(`  amends  : ${row.amends}`)
if (note) console.log(`  note    : ${note}`)
console.log(`\nIt is OPEN. The architect reads its own ledger, triages, and proposes —`)
console.log(`nothing gets built off this row until the owner approves it.\n`)
console.log(`When it IS built, close it here — an open row that shipped is why this ledger read 19 open when 3 were:`)
console.log(`  node scripts/architect-file.cjs --close ${id} --built "<what shipped, with the file:line>"\n`)
