const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(repo, '.workshop-timezone-'));
fs.mkdirSync(path.join(root, 'scripts'));
for (const file of ['workshop-release.cjs', 'workshop-verification.cjs']) fs.copyFileSync(path.join(__dirname, file), path.join(root, 'scripts', file));
fs.copyFileSync(process.env.WORKSHOP_BEFORE_TIMEZONE || path.join(__dirname, 'test-timezone-regressions.cjs'), path.join(root, 'scripts/test-timezone-regressions.cjs'));
const counts = { spine:41, 'owner-interval':12, 'owner-decisions':22, 'configured-dst':9, 'context-authority':7, 'people-summary':50, 'venue-contacts':16, 'prompt-people':4, 'slot-narration':4, 'registrar-deadline':38, 'approval-interval':37, 'gatekeeper-precheck':42, 'gatekeeper-reverify':10, 'diplomat-email':21 };
function child(name, count, extra = '') {
  const body = name === 'gatekeeper-precheck'
    ? `require('node:assert/strict').equal(1,1);console.log('${count} passed; 0 failed');`
    : `const {test}=require('node:test'),a=require('node:assert/strict');for(let i=0;i<${count};i++)test(String(i),()=>a.equal(1,1));`;
  fs.writeFileSync(path.join(root, 'scripts', `test-timezone-${name}.cjs`), body + extra);
}
function reset() {
  for (const f of fs.readdirSync(path.join(root, 'scripts'))) if (f.startsWith('test-timezone-') && f !== 'test-timezone-regressions.cjs') fs.unlinkSync(path.join(root, 'scripts', f));
  for (const [name, count] of Object.entries(counts)) child(name, count);
}
function run() {
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  return cp.spawnSync(process.execPath, ['scripts/test-timezone-regressions.cjs'], {cwd:root,encoding:'utf8',env,timeout:60000});
}
after(async () => { const real = fs.realpathSync(root); assert.equal(path.dirname(real), fs.realpathSync(repo)); assert.ok(path.basename(real).startsWith('.workshop-timezone-')); await fs.promises.rm(real, {recursive:true,force:true,maxRetries:8,retryDelay:100}); });
test('legitimate legacy children run exactly once in all three zones', () => {
  reset(); const r = run(); assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(r.stdout.split('\n').filter(l=>l.startsWith('ok - ')).length,42);
  for(const zone of ['UTC','Asia/Jerusalem','America/Los_Angeles']) assert.equal(r.stdout.split('\n').filter(l=>l.includes(` ${zone}:`)).length,14);
});
test('assertion count changes do not fail green child suites', () => {
  reset(); child('people-summary',37); child('prompt-people',7); child('registrar-deadline',48); child('diplomat-email',32);
  const r=run(); assert.equal(r.status,0,r.stdout+r.stderr);
});
test('newly discovered child failures propagate in all zones', () => {
  reset(); child('new',1,"test('bad',()=>a.equal(1,2));");
  const r=run(); assert.equal(r.status,1,r.stdout+r.stderr); assert.equal((r.stdout.match(/^not ok - .*test-timezone-new.cjs/gm)||[]).length,3);
});
test('existing child assertion failure remains fatal', () => {
  reset(); child('spine',41,"test('bad',()=>a.equal(1,2));"); assert.equal(run().status,1);
});
test('empty child execution remains fatal', () => {
  reset(); fs.writeFileSync(path.join(root,'scripts/test-timezone-spine.cjs'),''); assert.equal(run().status,1);
});
test('skipped and todo assertions cannot pass as a complete child', () => {
  reset(); child('spine',41,"test.skip('skipped',()=>{});test.todo('todo');"); assert.equal(run().status,1);
});
test('empty timezone inventory cannot pass', () => {
  reset(); for(const name of Object.keys(counts)) fs.unlinkSync(path.join(root,'scripts',`test-timezone-${name}.cjs`)); assert.equal(run().status,1);
});
