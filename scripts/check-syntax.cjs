#!/usr/bin/env node
/**
 * check-syntax — the ONLY real syntax check for the framework's own files.
 *
 * WHY THIS EXISTS (A28). `node --check .claude/workflows/bugger.js` exits 0 on a
 * file with a deliberate `const x = {,}` in it. Node v20 sees ESM syntax in a
 * `.js` file and declines to parse it as a script rather than parsing it as a
 * module — so the check reports success having verified nothing. Identical bytes
 * exit 1 as `.mjs`. Every "syntax verified" claim made about either engine before
 * 2026-07-30 was that no-op, and `.mjs` is not the fix either: the engines use
 * top-level `return`, which is illegal in a real module.
 *
 * WHAT THIS DOES INSTEAD. The Workflow tool runs an engine as an async function
 * BODY — that is why `export const meta`, top-level `await` and top-level
 * `return` all coexist in one file and no standard parser accepts the
 * combination. So this compiles each file the same way: the source is wrapped in
 * an async arrow and handed to `vm.compileFunction`, which PARSES without
 * running a line. The `export ` keywords are blanked to spaces of equal length,
 * so every line number and every column after line 1 is the file's own — a
 * failure prints the real `file:line`.
 *
 * Deliberately SLOPPY mode, not strict: the Workflow tool and CommonJS both run
 * these files non-strict, and matching the real runtime is the point. A parse
 * that is stricter than the runtime invents failures.
 *
 * THE CANARY IS THE POINT, and it runs per file, not once. A28's lesson is that
 * whether a check is real depends on the file's own shape, so for every file
 * checked this appends a known-broken line to the SAME bytes and requires the
 * parse to FAIL. If a canary ever passes, this script exits 2 and says the check
 * itself is broken — the one failure mode that otherwise looks exactly like
 * success.
 *
 * Usage:
 *   node scripts/check-syntax.cjs                  # the framework's own files
 *   node scripts/check-syntax.cjs path/to/file.js  # any file, same method
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
// The default set is the framework surface the architect owns — the two live
// engines, the audit engine, and the three tools. Anything else, name it.
const DEFAULT = [
  '.claude/workflows/bugger.js',
  '.claude/workflows/feature.js',
  '.claude/workflows/charter-audit.js',
  'scripts/ledger-stats.cjs',
  'scripts/spend.cjs',
  'scripts/architect-file.cjs',
]

const blank = (m) => ' '.repeat(m.length)
// Blanked, never deleted: a removed line shifts every line number below it and
// the error message then points at the wrong code.
const neutralise = (src) =>
  src
    .replace(/^#!.*/, blank)
    .replace(/^export default /gm, blank)
    .replace(/^export (?=(?:const|let|var|function|async|class)\b)/gm, blank)

const parse = (src, filename) => {
  try {
    vm.compileFunction(`return (async () => {${neutralise(src)}\n})()`, [], { filename })
    return null
  } catch (e) {
    return e
  }
}

const CANARY = '\nconst __canary_must_not_parse = {,}\n'
const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const files = (targets.length ? targets : DEFAULT).map((f) => (path.isAbsolute(f) ? f : path.join(ROOT, f)))

let failed = 0
let blind = 0
console.log('')
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  if (!fs.existsSync(file)) {
    console.error(`MISSING  ${rel}`)
    failed += 1
    continue
  }
  const src = fs.readFileSync(file, 'utf8')
  const err = parse(src, file)
  const canary = parse(src + CANARY, file)
  if (!canary) {
    console.error(`BLIND    ${rel} — the canary PARSED. This check is not checking anything.`)
    blind += 1
    continue
  }
  if (err) {
    console.error(`FAIL     ${rel}`)
    console.error(String(err.stack).split('\n').slice(0, 4).join('\n'))
    failed += 1
  } else {
    console.log(`ok       ${rel}  (canary caught: ${canary.message})`)
  }
}

if (blind) {
  console.error(`\n${blind} file(s) could not be checked AT ALL — the canary parsed clean, so a real`)
  console.error(`syntax error in them would also parse clean. Fix this script before trusting it.\n`)
  process.exit(2)
}
if (failed) {
  console.error(`\n${failed} of ${files.length} file(s) FAILED to parse. Nothing was executed.\n`)
  process.exit(1)
}
console.log(`\n${files.length} file(s) parse, and each one's canary failed as it must.`)
console.log(`Do NOT use \`node --check\` on a workflow engine — it exits 0 without parsing (A28).\n`)
