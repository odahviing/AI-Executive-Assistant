// Replays the captured pre-review-gap sources; no live ledger writes.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..')
const captured = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/workshop-linked-before.json.gz'))))
const fixture = fs.mkdtempSync(path.join(repo, '.workshop-before-linked-'))
let status = 1
try {
  fs.mkdirSync(path.join(fixture, 'scripts'))
  fs.mkdirSync(path.join(fixture, '.claude/workflows'), { recursive: true })
  for (const file of ['ledger-file.cjs', 'ledger-stats.cjs', 'workshop-verification.cjs']) {
    const source = captured.files[file]
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), captured.sha256[file])
    fs.writeFileSync(path.join(fixture, 'scripts', file), source)
  }
  fs.copyFileSync(path.join(repo, 'scripts/test-workshop-verification.cjs'), path.join(fixture, 'scripts/test-workshop-verification.cjs'))
  for (const file of ['bugger.js', 'feature.js'])
    fs.copyFileSync(path.join(repo, '.claude/workflows', file), path.join(fixture, '.claude/workflows', file))
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/test-workshop-verification.cjs')], { cwd: fixture, encoding: 'utf8' })
  process.stdout.write(result.stdout); process.stderr.write(result.stderr)
  status = result.status ?? 1
} finally {
  const resolved = fs.realpathSync(fixture)
  assert.equal(path.dirname(resolved), fs.realpathSync(repo))
  assert.ok(path.basename(resolved).startsWith('.workshop-before-linked-'))
  fs.rmSync(resolved, { recursive: true, force: true })
}
process.exitCode = status
