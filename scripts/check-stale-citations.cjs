#!/usr/bin/env node
/**
 * check-stale-citations — the fixture for the `stale-mechanism-comment` /
 * `stale-line-citation` recurrence class, currently a 31x historical pattern
 * (`node scripts/ledger-stats.cjs --by-invariant` — invariant
 * `stale-mechanism-comment`), 2 of them the identical identity twice — a
 * `processMessage.ts` clamp-line citation re-drifted after being fixed once
 * already.
 *
 * THE SHAPE. A comment cites `some/file.ts:NNN` (or `NNN-MMM`, or a
 * comma-list of either) as where a behaviour lives. A later edit to that
 * file — in the SAME wave or a different one — shifts its line numbers, and
 * the citation goes stale. Caught so far only by luck (a bouncer noticing
 * during an unrelated pass, twice on the same identity). This is that luck,
 * automated.
 *
 * TWO TIERS OF COVERAGE, stated plainly rather than overclaimed:
 *   STRONG — the citation names a symbol also declared in the target file
 *     (a nearby identifier that matches a function/const/class/type/interface
 *     declaration there). It passes if EITHER: the cited line/range itself
 *     literally contains that identifier in the target file today (a citation
 *     to a genuine USE site — a call, an assignment — not just the
 *     declaration), OR the symbol's OWN declaration line is within TOLERANCE
 *     of the cited anchor. Only when neither holds is it drift, flagged.
 *     (Before this, only the declaration-distance half existed, so a citation
 *     correctly naming a call site far from its own declaration — `cleanReply`
 *     declared at one line, cited 40+ lines later at the exact line it's
 *     actually called — was flagged STALE on a citation that was never wrong;
 *     see `gatekeeper.md`'s `cleanReply` citation, X199.)
 *   WEAK — no such symbol is found near the citation. All this can prove is
 *     that the cited line(s) still exist in the file (catches a citation
 *     pointing past EOF after a deletion). A citation that merely points at
 *     the WRONG still-valid line inside a file with no named symbol is
 *     invisible to this tier — said once here, not re-argued per finding.
 *
 * SCOPE, and the argued choice: WAVE-DIFF-SCOPED by default. A full-repo pass
 * is not more correct, it is more expensive for the same signal — the failure
 * this exists to catch is a LINE SHIFT, which only happens to a file that was
 * just edited. So the default reports only citations whose TARGET file is one
 * this session touched (working tree vs HEAD, plus untracked adds) — this
 * catches BOTH a self-citation inside the touched file AND an inbound
 * citation from anywhere else in the repo that names the touched file, which
 * is the exact miss `wave-comment-edits-broke-stale-line-citations`'s own
 * bouncer pass recorded: its repair grepped one needle (a single file/line
 * pattern) and could not see drift its OWN wave had already introduced in
 * three other files. `--all` runs the same check with
 * no target filter, for a periodic full sweep — real signal, not a
 * hypothetical, when run that way (see this file's own commit for a report).
 *
 * COMMENT-GATED, not string-gated: a match only counts if its own line, once
 * trimmed, starts with a comment marker (`//`, `/*`, `*`) — or the file is
 * `.md`, where the whole file is prose. A search for a trailing same-line
 * comment after code (a citation preceded by real code on the same line)
 * found zero cases anywhere in `src/`, so this is not a guess: it is the one
 * shape the codebase already uses, and it is what keeps a fixture's own
 * canned test string (a `file.ts:NNN`-shaped value inside a quoted object
 * literal, `check-design-door.cjs`) from being misread as a real citation.
 *
 * RESOLUTION. A citation with a `/` in it is matched against the repo file
 * list by suffix. A bare filename (`app.ts`) is matched by basename; where
 * more than one file in the repo shares that basename (11 do, for
 * `index.ts`), this reports UNRESOLVED rather than guess — a same-directory
 * preference was tried and produced a real false positive (a bare `index.ts`
 * citation resolved to a 154-line co-located file when it meant a 1454-line
 * one elsewhere), so proximity is not treated as evidence.
 *
 * NOT SCANNED AS A SOURCE: `CHANGELOG.md` and `.claude/*HANDOFF*.md`. Both
 * are dated, point-in-time records — a changelog entry says where a bug WAS
 * at the release it shipped in, a handoff says where something stood on the
 * day it was written, and neither claims to track HEAD. Flagging those would
 * not be a real defect, it would be the tool crying wolf at the one place
 * "stale" is the design, and that is the exact failure A10 is written
 * against (a check firing on its own healthy path).
 *
 * Usage:
 *   node scripts/check-stale-citations.cjs           # wave-diff-scoped (wrap-time default)
 *   node scripts/check-stale-citations.cjs --all     # whole repo, for a periodic sweep
 * Exit 0  no citation whose target this run checked is provably stale.
 * Exit 1  at least one is — named, with the citing line and the reason.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const EXT = 'ts|tsx|js|jsx|cjs|mjs|md'
const SCAN_EXT = new Set(EXT.split('|').map((e) => `.${e}`))
// How far a named symbol's OWN declaration may drift from the cited line
// before it counts as stale. Wide enough that a comment citing a statement a
// few lines into a function body (not the function's own opening line) is
// not a false alarm; narrow enough that "still somewhere in a 2000-line
// file" does not pass as "near".
const TOLERANCE = 25
// Dated, point-in-time records — see the header. Excluded as CITING sources
// only; they still resolve fine as a citation TARGET if anything ever points
// into one (rare, and not this file's concern either way).
const NOT_A_LIVE_SOURCE = /(^|\/)CHANGELOG\.md$|HANDOFF.*\.md$/i

// stderr is IGNORED, not inherited — on this repo's own working tree, plain
// `git diff`/`git ls-files` print CRLF/LF autocrlf warnings on stderr for
// files this check has no reason to care about, and those would otherwise
// interleave into this tool's own output.
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean)

const argv = process.argv.slice(2)
const ALL = argv.includes('--all')

// ── the repo file index — cheap here (280 scannable files today; git ls-files
// itself proves it), so this always builds the FULL index and only the
// REPORTING is scope-filtered. Building two different indexes for the two
// modes would be a second definition of "what files exist" (A9). ──────────
const tracked = git(['ls-files'])
const untracked = git(['ls-files', '--others', '--exclude-standard'])
const allFiles = [...new Set([...tracked, ...untracked])].filter((f) => SCAN_EXT.has(path.extname(f)))

const basenameIndex = new Map()
for (const f of allFiles) {
  const b = path.basename(f)
  if (!basenameIndex.has(b)) basenameIndex.set(b, [])
  basenameIndex.get(b).push(f)
}

// The touched set for `--diff` (default): working tree vs HEAD covers both
// staged and unstaged edits in one comparison, plus untracked new files —
// exactly "what this session changed", nothing this check has to guess at.
let touched = null
if (!ALL) {
  let modified = []
  try {
    modified = git(['diff', '--name-only', 'HEAD'])
  } catch {
    // No HEAD yet (a brand-new repo) — fall back to nothing touched, same as
    // a clean tree: the diff-scoped report is legitimately empty.
    modified = []
  }
  touched = new Set([...modified, ...untracked].map((f) => f.replace(/\\/g, '/')))
}

// ── the citation regex ──────────────────────────────────────────────────────
// `(?<![\w./-])` — do not start mid-path or mid-word. The file group allows
// any number of `component/` prefixes before the final `name.ext`, so a bare
// filename and a full relative path both match as ONE capture. The number
// group accepts a single line, a range (`-`), or a comma-list of either
// (e.g. two lines, or several ranges) — every shape actually in use, per a
// scan of this repo's own comments.
const CITATION_RE = new RegExp(String.raw`(?<![\w./-])((?:[\w-]+/)*[\w-]+\.(?:${EXT})):(\d+(?:\s*[-,]\s*\d+)*)`, 'g')

const parseLineSpec = (spec) =>
  spec
    .split(',')
    .map((part) => part.trim().match(/^(\d+)(?:-(\d+))?$/))
    .filter(Boolean)
    .map((m) => ({ start: Number(m[1]), end: m[2] ? Number(m[2]) : Number(m[1]) }))

const isCommentLine = (line, ext) => ext === '.md' || /^\s*(\/\/|\/\*|\*)/.test(line)

// ── declared-symbol extraction, memoized per target file — many citations
// share a hot target (`processMessage.ts`, `runOutputGates.ts`), so this is
// computed once per file, not once per citation. `.md` targets get none: a
// heading is not a symbol a `const`/`function` regex can find, and guessing
// would be the same false-confidence this file exists to avoid. ──────────
const SYMBOL_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/,
  // loose method/property shorthand inside a class or object literal
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/,
]
const symbolCache = new Map()
const declaredSymbols = (file, absPath) => {
  if (symbolCache.has(file)) return symbolCache.get(file)
  let map = new Map() // symbol -> [1-based declaration lines]
  if (path.extname(file) !== '.md' && fs.existsSync(absPath)) {
    const lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/)
    lines.forEach((line, idx) => {
      for (const re of SYMBOL_PATTERNS) {
        const m = line.match(re)
        if (m) {
          const name = m[1]
          if (!map.has(name)) map.set(name, [])
          map.get(name).push(idx + 1)
          break
        }
      }
    })
  }
  symbolCache.set(file, map)
  return map
}

// A SEPARATE regex object from `CITATION_RE` (same pattern), used only for
// stripping — sharing the scanning loop's own `.exec`-driven instance here
// would clobber ITS `lastIndex` mid-scan.
const CITATION_STRIP_RE = new RegExp(CITATION_RE.source, 'g')
// A candidate identifier only counts as a NAMED SYMBOL, never a coincidental
// word, when it is shaped like code rather than prose: this codebase's own
// convention for naming a symbol in a comment is backticks (`` `role` ``), and
// failing that, a multi-hump identifier (`getSenderRole`, `isOwnerInChannel`,
// `NextCheckHandler`) or a SCREAMING_CONST is not a word English prose would
// otherwise produce. A plain lowercase single-case word — "details", "closed",
// "handler", "mailbox", "tick", "text" — is exactly the shape of ordinary
// prose that happens to coincide with SOME identifier somewhere in a large
// file; measured against the real repo, admitting those produced the large
// majority of false "drift" this file's first pass reported.
const CODE_SHAPED = /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$|^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$|^[A-Z][A-Z0-9_]{3,}$/
// CHARACTER window, not a line window — measured against this repo's own
// citations: every real "names its symbol inline" case (`getRequestsForBrief
// (…:395)`, `(…:744, \`delivered\` still false)`) sits within 32 characters
// of the citation, while a false one (a DIFFERENT function name mentioned 94
// characters later, in the next clause of the same long sentence, with no
// connection to this specific citation) sits well outside it. A line-based
// window caught both; this catches only the first.
const WINDOW_CHARS = 60
const contextIdentifiers = (text, matchStart, matchEnd) => {
  const rawWindow = text.slice(Math.max(0, matchStart - WINDOW_CHARS), matchStart) + ' ' + text.slice(matchEnd, matchEnd + WINDOW_CHARS)
  const backticked = new Set([...rawWindow.matchAll(/`([A-Za-z_$][\w$]*)`/g)].map((m) => m[1]))
  // Strip every citation-shaped substring before the general scan. Otherwise
  // the match's OWN filename stem is "found nearby" by construction on every
  // citation, and — because this codebase's own convention is a file
  // exporting a same-named top-level function (a handler file exporting the
  // handler of the same name) — it then "matches" that function's OWN
  // declaration line as if it were the cited symbol, when the citation is
  // really about some other line deep inside that same file.
  const window = rawWindow.replace(CITATION_STRIP_RE, ' ')
  const words = new Set((window.match(/[A-Za-z_$][\w$]*/g) || []).filter((w) => w.length >= 4))
  return [...words].filter((w) => backticked.has(w) || CODE_SHAPED.test(w))
}

// ── resolve a citation's target string to a repo-relative path ─────────────
const resolveTarget = (citation, citingFile) => {
  const norm = citation.replace(/\\/g, '/')
  if (norm.includes('/')) {
    const exact = allFiles.filter((f) => f === norm || f.endsWith('/' + norm))
    if (exact.length === 1) return { file: exact[0], reason: null }
    if (exact.length > 1) return { file: null, reason: `ambiguous (${exact.length} paths match "${norm}")` }
    return { file: null, reason: `no repo file ends with "${norm}"` }
  }
  const candidates = basenameIndex.get(norm) || []
  if (candidates.length === 0) return { file: null, reason: `no repo file named "${norm}"` }
  if (candidates.length === 1) return { file: candidates[0], reason: null }
  // NO same-directory guess. It was tried and it produced a real false
  // positive: a citation of bare `index.ts` from `src/tasks/skill.ts`
  // resolved to the co-located `src/tasks/index.ts` (154 lines — an instant
  // "past EOF" flag) when the citation was actually about
  // `src/core/orchestrator/index.ts` (1454 lines, and it is the one that
  // actually contains the cited symbol). Proximity is not evidence; an
  // ambiguous bare filename is reported as UNRESOLVED, never guessed at —
  // the exact rule this file's own header states and the one case that
  // skipped it broke.
  return { file: null, reason: `ambiguous (${candidates.length} files named "${norm}": ${candidates.join(', ')})` }
}

// ── the scan ─────────────────────────────────────────────────────────────
const findings = [] // { citingFile, citingLine, citation, target, reason }
const unresolved = []
const weak = []

for (const citingFile of allFiles) {
  if (NOT_A_LIVE_SOURCE.test(citingFile)) continue
  const absPath = path.join(ROOT, citingFile)
  if (!fs.existsSync(absPath)) continue
  const ext = path.extname(citingFile)
  const text = fs.readFileSync(absPath, 'utf8')
  const lines = text.split(/\r?\n/)
  let m
  CITATION_RE.lastIndex = 0
  while ((m = CITATION_RE.exec(text))) {
    const [, citation, spec] = m
    // Which line is this match on? Cheap enough at 280 files: count newlines
    // before the match index.
    const before = text.slice(0, m.index)
    const lineIdx = before.split(/\r?\n/).length - 1
    const line = lines[lineIdx] || ''
    if (!isCommentLine(line, ext)) continue
    // A citation into itself at its OWN line ("this file, line N") is not a
    // cross-file claim; still worth checking (self-citations drift too, and
    // `stale-clamp-line-citations` regressed inside its OWN file's history)
    // so no special-case here — resolution treats it like any other target.
    const { file: target, reason } = resolveTarget(citation, citingFile)
    if (!target) {
      unresolved.push({ citingFile, citingLine: lineIdx + 1, citation, reason })
      continue
    }
    if (touched && !touched.has(target) && !touched.has(citingFile)) continue
    const pairs = parseLineSpec(spec)
    if (!pairs.length) continue
    const targetAbs = path.join(ROOT, target)
    const targetLines = fs.existsSync(targetAbs) ? fs.readFileSync(targetAbs, 'utf8').split(/\r?\n/) : []
    const targetLineCount = targetLines.length
    const maxCited = Math.max(...pairs.map((p) => p.end))
    if (maxCited > targetLineCount) {
      findings.push({ citingFile, citingLine: lineIdx + 1, citation: `${citation}:${spec}`, target, reason: `points past EOF — ${target} has ${targetLineCount} line(s), citation reaches ${maxCited}` })
      continue
    }
    const symbols = declaredSymbols(target, targetAbs)
    const ctx = contextIdentifiers(text, m.index, m.index + m[0].length)
    const anchor = pairs[0].start
    // A symbol declared many times in its own file (a common parameter name
    // like `context` re-declared in every function signature) carries no
    // positional signal at all — "found somewhere among 40 sites" is not
    // "found near the cited line", it is noise shaped like a match. Only a
    // symbol with a SMALL number of declarations (a real top-level function,
    // const or class — realistically 1, or a couple for overloads) is a
    // reliable anchor.
    const MAX_DECLS = 3
    // The target's OWN file-stem (a same-named top-level export, per the
    // convention noted above) is excluded even when it slips past the
    // citation-stripping above — e.g. prose mentioning "runOutputGates
    // routes X" two lines before a DIFFERENT citation into the same file at
    // a specific statement. The generic mention of the file/module's own
    // name is not evidence that IT is the symbol the citation is about.
    const fileStem = path.basename(target).replace(/\.[^.]+$/, '').toLowerCase()
    const matchedSymbols = ctx.filter((id) => id.toLowerCase() !== fileStem && symbols.has(id) && symbols.get(id).length <= MAX_DECLS)
    if (!matchedSymbols.length) {
      weak.push({ citingFile, citingLine: lineIdx + 1, citation: `${citation}:${spec}`, target })
      continue
    }
    // X199 · a citation can legitimately name a USE site (a call, an
    // assignment) far from the symbol's OWN declaration — that is not drift,
    // it is the citation doing its job. So this passes on EITHER signal:
    // the cited line/range itself literally contains the identifier today
    // (proof the citation still points at a real occurrence of it), or the
    // declaration-proximity check that already existed. Only a citation
    // matching NEITHER is drift.
    const citedRangeHasSymbol = (id) => {
      const re = new RegExp(`(?<![\\w$])${id.replace(/\$/g, '\\$')}(?![\\w$])`)
      return pairs.some((p) => {
        for (let ln = p.start; ln <= p.end; ln++) if (re.test(targetLines[ln - 1] || '')) return true
        return false
      })
    }
    const withinTolerance = matchedSymbols.some(
      (id) => citedRangeHasSymbol(id) || symbols.get(id).some((decLine) => Math.abs(decLine - anchor) <= TOLERANCE),
    )
    if (!withinTolerance) {
      const nearest = matchedSymbols
        .map((id) => ({ id, lines: symbols.get(id) }))
        .map(({ id, lines: ls }) => ({ id, line: ls.reduce((a, b) => (Math.abs(b - anchor) < Math.abs(a - anchor) ? b : a)) }))
      findings.push({
        citingFile,
        citingLine: lineIdx + 1,
        citation: `${citation}:${spec}`,
        target,
        reason: `names ${nearest.map((n) => `"${n.id}" (now at ${target}:${n.line})`).join(', ')} — ${TOLERANCE}+ line(s) from the cited anchor ${anchor}`,
      })
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────
console.log(`\ncheck-stale-citations — ${ALL ? 'FULL REPO' : 'wave-diff-scoped'} (${allFiles.length} file(s) scanned${touched ? `, ${touched.size} touched` : ''})\n`)

if (findings.length) {
  console.error(`STALE — ${findings.length} citation(s) provably wrong:\n`)
  for (const f of findings) console.error(`  ${f.citingFile}:${f.citingLine}  cites ${f.citation}\n    ${f.reason}\n`)
}
console.log(`  ${findings.length} stale, ${weak.length} weak-checked (no symbol named — range exists, position unverified), ${unresolved.length} unresolved target(s)`)
if (weak.length) console.log(`  (weak coverage is real but partial — a citation to a still-valid line at the WRONG spot in its file is invisible to this tier)`)
if (unresolved.length && process.env.VERBOSE) {
  console.log('\n  unresolved:')
  for (const u of unresolved) console.log(`    ${u.citingFile}:${u.citingLine}  "${u.citation}" — ${u.reason}`)
}

if (findings.length) {
  console.error(`\n${findings.length} stale citation(s). Fix the cited line/range (or the comment's claim) before shipping.\n`)
  process.exit(1)
}
console.log(`\nNo provably stale citation among what this run checked.\n`)
process.exit(0)
