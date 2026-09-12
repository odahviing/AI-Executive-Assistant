// Runner behavior in isolated fixtures; no repository suite recursion or live writes.
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = fs.mkdtempSync(path.join(__dirname, '..', '.workshop-release-'));
const runner = require('./workshop-release.cjs');
after(() => { const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(path.join(__dirname, '..'))); assert.ok(path.basename(resolved).startsWith('.workshop-release-')); fs.rmSync(resolved, { recursive: true, force: true }); });
const run = async (name, body, options = {}) => { fs.writeFileSync(path.join(root, name), body); return runner.execute([name], { root, timeout: 2000, ...options }); };
test('failed assertion blocks release while legitimate assertion remains executable', async () => {
  const r = await run('red.cjs', "const {test}=require('node:test'),a=require('node:assert/strict');test('legitimate',()=>a.equal(1,1));test('regression',()=>a.equal(1,2));");
  assert.deepEqual(runner.testResult(r), { passed: 1, failed: 1, skipped: 0, ok: false });
});
test('actual all-green TAP execution passes', async () => { const r = await run('green.cjs', "require('node:test')('legitimate',()=>require('node:assert/strict').equal(1,1));"); assert.equal(runner.testResult(r).ok, true); });
test('no-op and skipped suites never masquerade as pass', async () => {
  for (const body of ['', "require('node:test').skip('unexecuted',()=>{});"]) assert.equal(runner.testResult(await run('noop.cjs', body)).ok, false);
});
test('timeout terminates hung execution and fails closed', async () => { const r = await run('hang.cjs', 'setInterval(()=>{},1000)', { timeout: 100 }); assert.equal(r.timedOut, true); assert.equal(runner.testResult(r).ok, false); });
test('inventory includes new suites and expands timezone aggregate without duplicates', () => {
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['test-new.cjs', 'test-timezone-new.cjs', 'test-timezone-regressions.cjs', 'not-a-test.cjs']) fs.writeFileSync(path.join(root, 'scripts', f), '');
  const plan = runner.plan(runner.inventory(root)); assert.equal(plan.length, 4); assert.equal(new Set(plan.map(x => x.file + x.zone)).size, 4); assert.ok(plan.every(x => !x.file.endsWith('test-timezone-regressions.cjs')));
});
test('changed, added and deleted files invalidate exact release snapshot', () => { assert.deepEqual(runner.changedFiles([{file:'a',sha256:'1'},{file:'b',sha256:'2'}],[{file:'a',sha256:'3'},{file:'c',sha256:'4'}]),['a','b','c']); assert.deepEqual(runner.changedFiles([{file:'a',sha256:'1'}],[{file:'a',sha256:'1'}]),[]); });
test('CLI snapshot check rejects red and stale results and preserves valid checkpoint', () => {
  // Run the real CLI check in this repository; it only reads source and this report.
  const repo = path.resolve(__dirname, '..'), report = path.join(root, 'checkpoint.json'), snapshot = runner.sourceSnapshot(repo), inventory = runner.inventory(repo);
  fs.writeFileSync(path.join(root,'fixture.log'),'fixture output');fs.writeFileSync(path.join(root,'fixture-tsc.log'),'');
  const hash=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
  const base = { status:'passed', snapshot, inventory, checks:runner.plan(inventory).map(c=>({...c,ok:true,exitCode:0,passed:1,failed:0,skipped:0,timedOut:false,overflow:false,error:'',output:'fixture.log',outputSha256:hash('fixture.log')})),typecheck:{exitCode:0,timedOut:false,overflow:false,error:'',output:'fixture-tsc.log',outputSha256:hash('fixture-tsc.log')} };
  const check = value => { fs.writeFileSync(report, JSON.stringify(value)); return cp.spawnSync(process.execPath, ['scripts/workshop-release.cjs', '--check', report], {cwd:repo,encoding:'utf8'}); };
  assert.equal(check(base).status,0);
  assert.equal(check({...base,status:'blocked'}).status,1);
  assert.equal(check({...base,snapshot:[]}).status,1);
  assert.equal(check({...base,checks:base.checks.slice(1)}).status,1);
  assert.equal(check({...base,checks:base.checks.map((c,i)=>i?c:{...c,failed:1})}).status,1);
  assert.equal(check({...base,typecheck:{...base.typecheck,exitCode:2}}).status,1);
  fs.renameSync(path.join(root,'fixture.log'),path.join(root,'preserved-fixture.log'));assert.equal(check(base).status,1);
  fs.writeFileSync(path.join(root,'fixture.log'),'tampered output');assert.equal(check(base).status,1);
  fs.renameSync(path.join(root,'preserved-fixture.log'),path.join(root,'fixture.log'));assert.equal(check(base).status,0);
});
