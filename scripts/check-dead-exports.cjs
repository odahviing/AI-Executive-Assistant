#!/usr/bin/env node
/**
 * check-dead-exports — the cleaner's static, deterministic floor under its own
 * judgment sweep. Same relationship the golden-path battery has to the
 * bouncer: a mechanical check that cannot go quiet under attention pressure
 * the way an LLM reading the whole of `src/` can.
 *
 * WHY THIS EXISTS. Two unscoped Cleaner sweeps (2026-08-03, 2026-08-28) each
 * reported "zero dead files/exports found" over full `src/`. A same-night
 * re-check with a naive 40-line script claimed to find four (`buildSystemPrompt`,
 * `initMailAuth`, `openDM`, `resolveConsequenceTravel`). Re-verifying all four
 * against HEAD here found NONE of them actually dead — one has a real external
 * caller the naive script's `src/`-only scope couldn't see
 * (`scripts/measure-prompts.cjs`, `scripts/_dump-prompts.cjs` both call
 * `buildSystemPrompt` — an ALREADY-DOCUMENTED false positive, see
 * `.claude/V4_AUDIT_HANDOFF.md:26`), and three are called from within their
 * OWN declaring file — alive code, just an unnecessary `export` keyword (the
 * exact "162 over-exported symbols... low value, not worth churn" class that
 * same doc already ruled on at line 108). So the 2026-08-28 "zero dead
 * exports" claim held up; what was wrong tonight was a THIRD script, built
 * without the two blind spots below designed out. This file is that fix,
 * kept as a standing tool rather than a one-off.
 *
 * WHAT COUNTS AS DEAD, exactly. A top-level `export`ed declaration in
 * `src/**\/*.ts` whose identifier occurs NOWHERE ELSE — not one more time in
 * its own declaring file (a real internal caller means the FUNCTION is alive,
 * only the `export` is surplus — that is the over-exported bucket below, never
 * "dead"), and not once in any other file this scan reads. Two blind spots
 * this fixes relative to tonight's naive script:
 *   1. SCOPE — the search corpus is `src/`, `scripts/`, `config/`, `.claude/`,
 *      every `*.md` and every `*.yaml`/`*.yml` in the repo (C5's own mandate),
 *      not `src/` alone. A tool called only from `scripts/` is not dead.
 *   2. SAME-FILE CALLERS COUNT. `export function foo(){}` called later in the
 *      SAME file by another function in that file is a live call. Only the
 *      declaration line itself is not evidence of use.
 *
 * WHAT THIS DOES NOT COVER (named, not built, per A9 — no manufactured
 * heuristic without a demonstrated need): "uncalled methods" on a class/object
 * (dynamic `this.foo()` dispatch defeats a text search the same way tool
 * names do) and "literals duplicated across N files" (a real, different check
 * — see ledger ref `search-path-reject-labels-have-no-declaration-anywhere`,
 * 2026-09-07, found by an LLM sweep, not a script). Both are left for a future
 * pass if a real, provable miss demonstrates one is needed; bolting on an
 * unproven heuristic now would just add a second unreliable check next to a
 * reliable one.
 *
 * THE TWO REPORTED BUCKETS, and only one of them is a "finding":
 *   DEAD          — zero occurrences anywhere outside the declaration line.
 *                    Provable (C1), behaviour-preserving to delete (C2).
 *                    This is what fails the check (exit 1).
 *   OVER-EXPORTED — used one or more times in its OWN file, never elsewhere.
 *                    Informational only. NEVER exits 1, NEVER a deletion
 *                    candidate — matches the already-standing "not worth
 *                    churn" ruling. Reported so the count doesn't vanish, not
 *                    so it gets acted on.
 * A name shared by more than one `src/` declaration is flagged AMBIGUOUS and
 * excluded from DEAD (a bare-identifier search cannot tell which declaration a
 * distant call belongs to — the same shape of caution `check-stale-citations.
 * cjs` uses for an ambiguous bare filename). This can only cause a MISS
 * (understating dead code), never a false DEAD claim — the safe direction
 * when the action on a DEAD verdict is deletion.
 *
 * EXCEPTIONS. Two kinds, both reasoned and both visible in this file:
 *   - STRUCTURAL: an identifier ending in `ForTests` — deliberate test seams
 *     (C5's own "Leave alone" category; `_resetForTests`,
 *     `_clearToolCallCacheForTests` are today's two, kept dead-but-intentional
 *     since 2026-07-21).
 *   - NAMED: EXPORT_ALLOWLIST below — a specific symbol the cleaner (or a
 *     prior audit) already judged a deliberate keep despite looking dead.
 *     Add an entry here, with a reason, rather than leaving a real DEAD
 *     finding unexplained or silently re-flagging it forever.
 *
 * WATERMARK GATE. This is the independent check `manager/SKILL.md`'s cleaner
 * entry now runs itself before advancing `state.lastCleanSha` on an unscoped
 * sweep — not a step the cleaner narrates having done, a script the
 * dispatching chat re-runs and reads the exit code of. Exit 0 required.
 *
 * Usage: node scripts/check-dead-exports.cjs [--verbose]
 * Exit 0  zero un-allowlisted DEAD exports.
 * Exit 1  at least one — named, with file:line.
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const VERBOSE = process.argv.includes('--verbose')

// ── named exceptions — a real, reasoned keep, never a silent skip ──────────
// Each entry: the exact identifier AND the file it's declared in (both, so a
// future unrelated symbol that happens to share a name is never accidentally
// covered by someone else's reason).
const EXPORT_ALLOWLIST = [
  {
    symbol: 'getWhatsAppClient',
    file: 'src/connectors/whatsapp.ts',
    reason: 'Dormant by design — deliberate forward scaffolding for the WhatsApp project, owner-confirmed and already judged a correct keep by a prior Cleaner run (see .claude/V4_AUDIT_HANDOFF.md:108). Not dead; not yet wired up. NOTE: today it also survives because that same handoff doc mentions the identifier by name (an incidental second shield, not this mechanism) — this entry is what keeps it green the day that doc is cleaned up or rewritten.',
  },
]
const allowlistKey = (symbol, file) => `${file}::${symbol}`
const ALLOWLIST_MAP = new Map(EXPORT_ALLOWLIST.map((e) => [allowlistKey(e.symbol, e.file), e.reason]))

// Structural exception — C5's "deliberate test seams" category. A naming
// convention, not a per-symbol judgment call, so it needs no ledger entry.
const isTestSeam = (name) => /ForTests$/.test(name)

// ── the search corpus — walk the real filesystem, not `git ls-files` ───────
// idan.yaml (config/users/) is gitignored (real credentials) but still a
// legitimate place a symbol name could be read from, and C5 names `config/`
// explicitly — so this reads what's actually on disk, the same as the `Grep`
// tool does, rather than what git tracks.
// `worktrees` — `.claude/worktrees/<agent-id>/` is a FULL git-worktree clone
// of the repo (35MB, 7 live copies measured 2026-09-07), one per in-flight
// agent dispatch. Scanning it double/triple/quadruple-counts every file and
// can reflect an abandoned or mid-edit branch instead of HEAD — the exact
// "answer arithmetic on live/uncertain ground" this tool exists to avoid.
// Caught by dogfooding this script on itself: `initMailAuth` showed 19
// external uses before this exclusion, all but one of them the same file
// copied three times under `worktrees/`.
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'k8s', 'logs', 'data', 'build', 'coverage', 'worktrees'])
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.md', '.yaml', '.yml'])
const DECL_EXT = new Set(['.ts', '.tsx'])
const DECL_DIR = 'src'

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, out)
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(abs)
  }
}
const allFiles = []
walk(ROOT, allFiles)

// ── per-file token-count index, built once ──────────────────────────────────
// A plain identifier tokenizer, not a comment/string-aware one — deliberately,
// per C5: "grep the identifier AND THE BARE STRING", which means a mention
// inside a comment, a doc, or a quoted string all count as evidence of life.
const TOKEN_RE = /[A-Za-z_$][\w$]*/g
const fileTokenCounts = new Map() // absPath -> Map<token, count>
const fileText = new Map()
function tokenCountsFor(absPath) {
  if (fileTokenCounts.has(absPath)) return fileTokenCounts.get(absPath)
  const text = fs.readFileSync(absPath, 'utf8')
  fileText.set(absPath, text)
  const counts = new Map()
  let m
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(text))) counts.set(m[0], (counts.get(m[0]) || 0) + 1)
  fileTokenCounts.set(absPath, counts)
  return counts
}
for (const f of allFiles) tokenCountsFor(f)

// ── declaration scan — top-level `export`ed symbols in src/**/*.ts only ────
// Column-zero anchored: this is specifically MODULE-level exports, not a
// class member or object-literal method (which is not a JS `export` and has
// no analogous "nothing imports this" question).
const DECL_PATTERNS = [
  /^export\s+async\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^export\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^export\s+interface\s+([A-Za-z_$][\w$]*)/,
  /^export\s+type\s+([A-Za-z_$][\w$]*)/,
  /^export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
]
// `export default ...` is skipped on purpose — an importer can bind a default
// export to any local name, so a bare-identifier search proves nothing about
// whether it's used. `export { x } from`/`export *` (re-export barrels) are
// skipped too, same reason as check-stale-citations' ambiguity handling:
// guessing is worse than not checking.
const SKIP_RE = /^export\s+default\b|^export\s*\{|^export\s*\*/

const declarations = [] // { name, file (repo-relative), absPath, line }
for (const abs of allFiles) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/')
  if (!rel.startsWith(DECL_DIR + '/') || !DECL_EXT.has(path.extname(rel))) continue
  const text = fileText.get(abs) ?? fs.readFileSync(abs, 'utf8')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, idx) => {
    if (SKIP_RE.test(line)) return
    for (const re of DECL_PATTERNS) {
      const m = line.match(re)
      if (m) {
        declarations.push({ name: m[1], file: rel, absPath: abs, line: idx + 1 })
        break
      }
    }
  })
}

// Name -> declaring file(s), to catch the AMBIGUOUS case (same identifier
// exported from more than one file — a bare-text search can't attribute a
// distant usage to the right one, so neither is called DEAD).
const declsByName = new Map()
for (const d of declarations) {
  if (!declsByName.has(d.name)) declsByName.set(d.name, [])
  declsByName.get(d.name).push(d)
}

// ── classify each declaration ────────────────────────────────────────────
const dead = []
const overExported = []
const ambiguous = []
const allowlisted = []
const testSeams = []

for (const d of declarations) {
  if (isTestSeam(d.name)) {
    testSeams.push(d)
    continue
  }
  const allowReason = ALLOWLIST_MAP.get(allowlistKey(d.name, d.file))
  if (allowReason) {
    allowlisted.push({ ...d, reason: allowReason })
    continue
  }
  const sameNameDecls = declsByName.get(d.name)
  const isAmbiguousName = sameNameDecls.length > 1

  let inFileUses = 0
  let externalUses = 0
  for (const abs of allFiles) {
    const counts = tokenCountsFor(abs)
    const c = counts.get(d.name) || 0
    if (!c) continue
    if (abs === d.absPath) inFileUses += c
    else externalUses += c
  }
  inFileUses -= 1 // the declaration line's own occurrence

  if (externalUses > 0) continue // alive — not a finding at all
  if (isAmbiguousName) {
    ambiguous.push({ ...d, sharedWith: sameNameDecls.filter((o) => o !== d).map((o) => `${o.file}:${o.line}`) })
    continue
  }
  if (inFileUses > 0) overExported.push(d)
  else dead.push(d)
}

// ── report ──────────────────────────────────────────────────────────────
console.log(`\ncheck-dead-exports — ${allFiles.length} file(s) scanned, ${declarations.length} top-level export(s) found in ${DECL_DIR}/`)

if (dead.length) {
  console.error(`\nDEAD — ${dead.length} export(s) with zero references anywhere outside their own declaration line:\n`)
  for (const d of dead) console.error(`  ${d.file}:${d.line}  ${d.name}`)
}
console.log(`\n  ${dead.length} dead, ${overExported.length} over-exported (used in-file only — not a finding, not acted on), ${ambiguous.length} ambiguous (name shared across files, skipped), ${allowlisted.length} allowlisted, ${testSeams.length} test-seam-excluded`)

if (VERBOSE) {
  if (overExported.length) {
    console.log('\n  over-exported (informational only):')
    for (const d of overExported) console.log(`    ${d.file}:${d.line}  ${d.name}`)
  }
  if (ambiguous.length) {
    console.log('\n  ambiguous (skipped — cannot attribute a bare-text match to one declaration):')
    for (const d of ambiguous) console.log(`    ${d.file}:${d.line}  ${d.name}  (also declared: ${d.sharedWith.join(', ')})`)
  }
  if (allowlisted.length) {
    console.log('\n  allowlisted:')
    for (const d of allowlisted) console.log(`    ${d.file}:${d.line}  ${d.name}  — ${d.reason}`)
  }
}

if (dead.length) {
  console.error(`\n${dead.length} dead export(s). Confirm against HEAD (not a stale snapshot) then delete, or add a reasoned EXPORT_ALLOWLIST entry in this file if it's a deliberate keep.\n`)
  process.exit(1)
}
console.log('\nNo unexplained dead export among what this run checked.\n')
process.exit(0)
