#!/usr/bin/env node
// One local release execution: discovered regressions + typecheck. Golden30 and
// independent review retain their separate contracts. No boot, deploy or ledger write.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { snapshot } = require('./workshop-verification.cjs');
const verification = require('./workshop-verification.cjs');
const zones = ['UTC', 'Asia/Jerusalem', 'America/Los_Angeles'];
function inventory(root) {
  return fs.readdirSync(path.join(root, 'scripts')).filter(f => /^test-.*\.cjs$/.test(f)).sort();
}
function plan(files) {
  return files.filter(f => f !== 'test-timezone-regressions.cjs').flatMap(file =>
    (file.startsWith('test-timezone-') ? zones : ['UTC']).map(zone => ({ file: `scripts/${file}`, zone })));
}
function sourceSnapshot(root) {
  const r = cp.spawnSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z', '--', 'src', 'scripts', 'config', 'package.json', 'package-lock.json', 'tsconfig.json', '.claude/workflows'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw Error(`Cannot inventory release source: ${r.stderr}`);
  return snapshot([...new Set(r.stdout.split('\0').filter(Boolean))].sort(), root);
}
function changedFiles(before, after) {
  const a = new Map(before.map(s => [s.file, s.sha256])), b = new Map(after.map(s => [s.file, s.sha256]));
  return [...new Set([...a.keys(), ...b.keys()])].filter(f => !a.has(f) || !b.has(f) || a.get(f) !== b.get(f));
}
function execute(args, { root, env = {}, timeout = 180000, output }) {
  return new Promise(resolve => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT; // Each child emits its own TAP, not the parent's binary test protocol.
    const child = cp.spawn(process.execPath, args, { cwd: root, env: childEnv, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, overflow = false, error = '';
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') { cp.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); child.kill('SIGKILL'); }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    for (const [stream, key] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', chunk => {
      if (stdout.length + stderr.length > 16 * 1024 * 1024) { overflow = true; stop(); return; }
      if (key === 'out') stdout += chunk; else stderr += chunk;
    });
    child.on('error', e => { error = e.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (output) fs.writeFileSync(output, stdout + stderr, { flag: 'wx' });
      resolve({ exitCode: code, signal, timedOut, overflow, error, stdout, stderr });
    });
  });
}
function testResult(run) {
  // TAP owns counts for node:test; older assertion harnesses print JSON or totals.
  const tap = /^# tests (\d+)\r?$/m.test(run.stdout);
  const number = pattern => +(run.stdout.match(pattern)?.[1] || 0);
  const passed = tap ? number(/^# pass (\d+)/m) : number(/"passed":\s*(\d+)/) || number(/^(\d+) passed/m);
  const failed = tap ? number(/^# fail (\d+)/m) : number(/"failed":\s*(\d+)/) || number(/^\d+ passed; (\d+) failed/m);
  const skipped = tap ? number(/^# skipped (\d+)/m) + number(/^# todo (\d+)/m) : 0;
  return { passed, failed, skipped, ok: run.exitCode === 0 && !run.timedOut && !run.overflow && !run.error && passed > 0 && failed === 0 && skipped === 0 };
}
function checkpointResult(report, root, evidenceRoot) {
  const errors = [], files = inventory(root), expected = plan(files);
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const keys = checks.map(c => `${c.file}\0${c.zone}`);
  if (JSON.stringify(report.inventory) !== JSON.stringify(files)) errors.push('release inventory changed or missing');
  if (!expected.length || checks.length !== expected.length || new Set(keys).size !== expected.length || expected.some(c => !keys.includes(`${c.file}\0${c.zone}`))) errors.push('execution inventory incomplete or duplicated');
  for (const c of checks) if (c.ok !== true || c.exitCode !== 0 || !Number.isInteger(c.passed) || c.passed < 1 || c.failed !== 0 || c.skipped !== 0 || c.timedOut !== false || c.overflow !== false || c.error !== '' || !c.output) errors.push(`execution failed or incomplete: ${c.file} ${c.zone}`);
  const t = report.typecheck;
  if (!t || t.exitCode !== 0 || t.timedOut !== false || t.overflow !== false || t.error !== '' || !t.output) errors.push('typecheck failed or incomplete');
  for (const c of [...checks, ...(t ? [t] : [])]) {
    try {
      if (!evidenceRoot || !c.output || path.basename(c.output) !== c.output || !/^[a-f0-9]{64}$/.test(c.outputSha256) || !fs.lstatSync(path.join(evidenceRoot, c.output)).isFile() || snapshot([c.output], evidenceRoot)[0].sha256 !== c.outputSha256) throw Error('missing or changed output');
    } catch { errors.push(`retained output missing, unreadable or changed: ${c.output || '(absent)'}`); }
  }
  const changed = changedFiles(Array.isArray(report.snapshot) ? report.snapshot : [], sourceSnapshot(root));
  if (changed.length) errors.push('executable source snapshot changed');
  return { ok: errors.length === 0, errors, changed };
}
// A read-only draft: native ledger-file remains the writer and final validator.
// Explicit refs select release scope; prose in report.md is never interpreted as a ruling.
function bookkeepingPlan(refs, version, root) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw Error('Explicit release version required');
  if (!Array.isArray(refs) || !refs.length || refs.some(r => typeof r !== 'string' || !r.trim() || r.startsWith('--')) || new Set(refs.map(verification.normRef)).size !== refs.length) throw Error('Refs must be a nonempty array of distinct ledger refs');
  const ledger = '.claude/agent-loop/ledger.jsonl', report = '.claude/agent-loop/report.md';
  const rows = verification.readRows(path.join(root, ledger));
  const latest = verification.collapseRows(rows).latest;
  const selected = refs.map(ref => {
    const row = latest.find(r => verification.normRef(r.ref) === verification.normRef(ref));
    if (!row) throw Error(`Missing ledger ref: ${ref}`);
    return row;
  });
  const reviews = [], dispositions = [], blockers = [];
  for (const row of selected) {
    const lastEvent = rows.findLast(r => verification.normRef(r.ref) === verification.normRef(row.ref) && (r.verdict || r.state === 'partial'));
    const alreadyRecorded = lastEvent?.runId === `wrap-${version}`;
    if (row.verdict === 'verified') {
      const errors = [...verification.checkReview(row.evidence, row.review), ...verification.snapshotErrors(row, root)];
      if (errors.length) { blockers.push({ ref: row.ref, errors }); continue; }
      const file = `artifacts/workshop-verification/wrap-${version}/bookkeeping/review-${reviews.length + 1}.json`;
      reviews.push({ ref: row.ref, attemptId: row.evidence.attemptId, file, review: row.review,
        alreadyRecorded,
        argv: alreadyRecorded ? null : ['scripts/ledger-file.cjs', '--review', '--ref', row.ref, '--runId', `wrap-${version}`, '--review-file', file] });
    } else if (row.evidence || ['built', 'implemented', 'verification-failed', 'verification-unproven', 'wrapped'].includes(row.verdict)) {
      blockers.push({ ref: row.ref, errors: [`Current status ${row.verdict} is not a shipping independent pass`] });
    } else {
      const argv = ['scripts/ledger-file.cjs', '--ref', row.ref, '--runId', `wrap-${version}`];
      for (const key of ['verdict', 'invariant', 'finding', 'recommend', 'lane', 'source', 'rootCause', 'note']) if (row[key]) argv.push(`--${key}`, String(row[key]));
      dispositions.push({ ref: row.ref, current: row, alreadyRecorded, argv: alreadyRecorded ? null : argv });
    }
  }
  return { version, refs, status: blockers.length ? 'blocked' : 'draft', blockers,
    counts: { selectedRefs: selected.length, reviewAppends: reviews.filter(r => r.argv).length, dispositionDrafts: dispositions.filter(r => r.argv).length,
      alreadyRecorded: [...reviews, ...dispositions].filter(r => r.alreadyRecorded).length,
      implementationRefs: selected.filter(r => reviews.some(v => v.ref === r.ref) && !r.verificationOf).length },
    inputs: snapshot([ledger, report, ...new Set(selected.flatMap(r => r.evidence?.files || []))], root),
    report: fs.readFileSync(path.join(root, report), 'utf8'), reviews, dispositions, releaseSha: null,
    remaining: 'Reconcile EVERY report disposition and selected release scope; preserve owner words and recommendations. Materialize each reviews[].review at its file path, then use argv arrays with the native writer (cwd repo). Disposition argv are drafts, not writer validation. Recheck this plan before the first append; regenerate after any append or retry. Companions require actual shipping commit evidence at WRAP_UP step 12; this draft authorizes no commit, GitHub action, report reset or release claim.' };
}
function checkBookkeeping(draft, root) {
  const current = bookkeepingPlan(draft.refs, draft.version, root);
  return { status: current.status !== 'blocked' && JSON.stringify(current) === JSON.stringify(draft) ? 'current-draft' : 'blocked', blockers: current.blockers };
}
function goldenSnapshot(root) {
  return [...sourceSnapshot(root), ...snapshot(['.claude/GOLDEN_PATHS.md'], root)];
}
function goldenResult(report, root, evidenceRoot) {
  const errors = [], ids = Array.from({ length: 30 }, (_, i) => `Z${i + 1}`);
  const catalog = [...fs.readFileSync(path.join(root, '.claude/GOLDEN_PATHS.md'), 'utf8').matchAll(/^- \*\*(Z\d+)\b/gm)].map(m => m[1]);
  const traces = Array.isArray(report.goldenTraces) ? report.goldenTraces : [];
  if (JSON.stringify(catalog) !== JSON.stringify(ids)) errors.push('Golden catalog is not the fixed Z1-Z30 inventory');
  if (report.itemsInFile !== 30 || traces.length !== 30 || new Set(traces.map(t => t?.id)).size !== 30 || ids.some(id => !traces.some(t => t?.id === id))) errors.push('Golden results missing, duplicated or outside Z1-Z30');
  if (traces.some(t => !['pass', 'stale-anchor'].includes(t?.verdict) || typeof t?.evidence !== 'string' || !t.evidence.trim())) errors.push('Golden verdict failed/unknown or item evidence missing');
  const recorded = Array.isArray(report.snapshot) ? report.snapshot : [], current = goldenSnapshot(root);
  if (recorded.length !== current.length || new Set(recorded.map(s => s.file)).size !== current.length || current.some(s => !s.sha256) || changedFiles(recorded, current).length) errors.push('Golden reviewed source snapshot missing or changed');
  try {
    if (!evidenceRoot || typeof report.output !== 'string' || path.basename(report.output) !== report.output || !/^[a-f0-9]{64}$/.test(report.outputSha256) || !fs.lstatSync(path.join(evidenceRoot, report.output)).isFile() || !fs.statSync(path.join(evidenceRoot, report.output)).size || snapshot([report.output], evidenceRoot)[0].sha256 !== report.outputSha256) throw Error('missing or changed output');
    const returned = JSON.parse(fs.readFileSync(path.join(evidenceRoot, report.output), 'utf8'));
    if (returned.itemsInFile !== report.itemsInFile || JSON.stringify(returned.goldenTraces) !== JSON.stringify(report.goldenTraces)) throw Error('results differ from reviewer output');
  } catch { errors.push('Golden retained reviewer output missing, empty or changed'); }
  return { status: errors.length ? 'blocked' : 'current', errors, answered: traces.length,
    passed: traces.filter(t => t?.verdict === 'pass').length, staleAnchors: traces.filter(t => t?.verdict === 'stale-anchor').length };
}
async function main() {
  const root = path.resolve(__dirname, '..'), args = process.argv.slice(2);
  if (args[0] === '--golden-snapshot' && args.length === 1) {
    console.log(JSON.stringify(goldenSnapshot(root), null, 2)); return;
  }
  if (args[0] === '--golden-report' && args.length === 3) {
    const file = path.resolve(args[2]), returned = JSON.parse(fs.readFileSync(file, 'utf8'));
    const report = { itemsInFile: returned.itemsInFile, goldenTraces: returned.goldenTraces,
      snapshot: JSON.parse(fs.readFileSync(args[1], 'utf8')), output: path.basename(file), outputSha256: snapshot([file], root)[0].sha256 };
    const result = goldenResult(report, root, path.dirname(file));
    if (result.status === 'blocked') throw Error(result.errors.join('; '));
    console.log(JSON.stringify(report, null, 2)); return;
  }
  if (args[0] === '--check-golden' && args.length === 2) {
    const file = path.resolve(args[1]), result = goldenResult(JSON.parse(fs.readFileSync(file, 'utf8')), root, path.dirname(file));
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'blocked' ? 1 : 0; return;
  }
  if (args[0] === '--bookkeeping-plan' && args.length === 4 && args[2] === '--version') {
    const result = bookkeepingPlan(JSON.parse(fs.readFileSync(args[1], 'utf8')), args[3], root);
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'blocked' ? 1 : 0; return;
  }
  if (args[0] === '--check-bookkeeping' && args.length === 2) {
    const result = checkBookkeeping(JSON.parse(fs.readFileSync(args[1], 'utf8')), root);
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'blocked' ? 1 : 0; return;
  }
  if (args[0] === '--check' && args.length === 2) {
    const report = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const result = checkpointResult(report, root, path.dirname(path.resolve(args[1]))), ok = report.status === 'passed' && result.ok;
    console.log(JSON.stringify({ status: ok ? 'current' : 'blocked', previousStatus: report.status, changed: result.changed, errors: result.errors }, null, 2));
    process.exitCode = ok ? 0 : 1; return;
  }
  if (args.length && !(args.length === 2 && args[0] === '--out')) throw Error('Usage: workshop-release.cjs [--out NEW_DIRECTORY | --check REPORT.json | --bookkeeping-plan REFS.json --version VERSION | --check-bookkeeping PLAN.json | --golden-snapshot | --golden-report SNAPSHOT.json RETURN.json | --check-golden REPORT.json]');
  const out = path.resolve(args[1] || path.join(root, 'artifacts/workshop-verification/releases', new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(out); // Refuse to overwrite a prior attempt, including its logs.
  const before = sourceSnapshot(root), files = inventory(root), entries = plan(files);
  const report = { version: 1, startedAt: new Date().toISOString(), status: 'running', inventory: files, aggregate: 'test-timezone-regressions.cjs is expanded into its timezone children; never run twice', snapshot: before, checks: [] };
  fs.writeFileSync(path.join(out, 'started.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  try {
    for (const [i, entry] of entries.entries()) {
      const logfile = `${String(i + 1).padStart(3, '0')}-${path.basename(entry.file)}-${entry.zone.replaceAll('/', '_')}.log`;
      const run = await execute([entry.file], { root, env: { TZ: entry.zone, WORKSHOP_TEST_OUTPUT_DIR: out }, output: path.join(out, logfile) });
      const result = testResult(run);
      report.checks.push({ ...entry, ...result, exitCode: run.exitCode, timedOut: run.timedOut, signal: run.signal, error: run.error, overflow: run.overflow, output: logfile, outputSha256: snapshot([logfile], out)[0].sha256 });
      console.log(`${result.ok ? 'PASS' : 'FAIL'} ${entry.file} ${entry.zone}: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`);
    }
    const typecheck = await execute(['node_modules/typescript/bin/tsc', '--noEmit'], { root, output: path.join(out, 'typecheck.log') });
    report.typecheck = { exitCode: typecheck.exitCode, timedOut: typecheck.timedOut, error: typecheck.error, overflow: typecheck.overflow, output: 'typecheck.log', outputSha256: snapshot(['typecheck.log'], out)[0].sha256 };
    const result = checkpointResult(report, root, out);
    report.changed = result.changed;
    report.errors = result.errors;
    report.status = result.ok ? 'passed' : 'blocked';
  } catch (e) { report.status = 'blocked'; report.error = e.message; }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(`Release execution ${report.status}: ${report.checks.filter(c => c.ok).length}/${entries.length} suite/zone executions; ${path.join(out, 'report.json')}`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { inventory, plan, sourceSnapshot, changedFiles, execute, testResult, checkpointResult, bookkeepingPlan, checkBookkeeping, goldenSnapshot, goldenResult };
