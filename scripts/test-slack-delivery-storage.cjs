const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const Database = require('better-sqlite3');
const before = process.argv.includes('--before');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maelle-delivery-'));
let db = new Database(path.join(dir, 'fixture.db'));
db.pragma('foreign_keys=ON');
function load(source, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports, require:n => deps[n] || require(n), setTimeout:()=>0});
  return exports;
}
const oldSource = before ? cp.execFileSync('git',['show','461de5d:src/connectors/slack/processedDedup.ts'],{encoding:'utf8'}) : null;
const sourceFile = process.argv.includes('--before-a2')
  ? '../artifacts/workshop-verification/approved-four-20261007/handyman/slackDelivery.a1.ts'
  : '../src/db/slackDelivery.ts';
const api = before ? null : load(fs.readFileSync(path.join(__dirname,sourceFile),'utf8'), {'./client':{getDb:()=>db}});
if(api) api.initSlackDeliverySchema(db);
let passed=0, failed=0;
function test(name, fn) {try{fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
const claim = (ids, profileId='owner', channelId='D1') => api.beginSlackDelivery({profileId,channelId,inboundTs:ids,now:100,nextCheckAt:200});
test('same-process duplicate remains blocked',()=>{
  if(before){const old=load(oldSource);assert.equal(old.markProcessed('1'),true);assert.equal(old.markProcessed('1'),false);}
  else {assert.ok(claim(['1']));assert.equal(claim(['1']),null);}
});
test('restart retains delivery exclusion',()=>{
  if(before){load(oldSource).markProcessed('2');assert.equal(load(oldSource).markProcessed('2'),false);}
  else {claim(['2']);db.close();db=new Database(path.join(dir,'fixture.db'));assert.equal(claim(['2']),null);}
});
test('merged all-or-nothing claim and profile/channel isolation',()=>{
  assert.equal(claim(['fresh','1']),null);assert.equal(api.getSlackDelivery('owner','D1','fresh'),null);
  assert.ok(claim(['1'],'other'));assert.ok(claim(['1'],'owner','C1'));
});
test('failure retry replaces only explicit failed attempt and stale CAS cannot resolve replacement',()=>{
  const a=claim(['3','4']);assert.equal(api.resolveSlackDelivery({...a,expectedStatus:'sending',status:'failed',now:110}),true);
  const b=claim(['3','4']);assert.notEqual(a.attemptId,b.attemptId);
  assert.equal(api.resolveSlackDelivery({...a,expectedStatus:'sending',status:'confirmed',messageTs:'reply'}),false);
  assert.equal(api.resolveSlackDelivery({...b,expectedStatus:'sending',status:'confirmed',messageTs:'reply'}),true);
  assert.equal(api.getSlackDelivery('owner','D1','4').status,'confirmed');assert.equal(claim(['4']),null);
});
test('stale sending becomes unknown and due work survives indefinitely without replay',()=>{
  const a=claim(['5','6']);const due=api.listDueSlackDeliveries('owner',300);
  assert.ok(due.some(x=>x.attemptId===a.attemptId&&x.status==='unknown'));assert.equal(claim(['5']),null);
  assert.equal(api.postponeSlackDelivery('owner','D1',a.attemptId,500,300),true);
  assert.equal(api.listDueSlackDeliveries('owner',400).some(x=>x.attemptId===a.attemptId),false);
  assert.ok(api.listDueSlackDeliveries('owner',99999999).some(x=>x.attemptId===a.attemptId));
  assert.equal(api.resolveSlackDelivery({...a,expectedStatus:'unknown',status:'confirmed',messageTs:'exact',now:100000000}),true);
  assert.equal(api.postponeSlackDelivery('owner','D1',a.attemptId,100000002,100000001),false);
});
test('confirmed transport without outbound timestamp persists null and blocks replay',()=>{
  const a=claim(['audio','audio-merged']);
  assert.equal(api.resolveSlackDelivery({...a,expectedStatus:'sending',status:'confirmed',now:120}),true);
  assert.equal(api.getSlackDelivery('owner','D1','audio-merged').messageTs,null);
  assert.equal(api.getSlackDelivery('owner','D1','audio').status,'confirmed');
  assert.equal(claim(['audio']),null);
});
test('unconfirmed transport stays unknown without inferred success',()=>{
  const a=claim(['uncertain-audio']);
  assert.equal(api.resolveSlackDelivery({...a,expectedStatus:'sending',status:'unknown',nextCheckAt:200,now:120}),true);
  api.listDueSlackDeliveries('owner',300);
  assert.equal(api.getSlackDelivery('owner','D1','uncertain-audio').status,'unknown');
  assert.equal(claim(['uncertain-audio']),null);
});
test('validation and unavailable persistence fail closed',()=>{
  assert.ok(api, 'durable storage API must exist');
  assert.throws(()=>claim([]));assert.throws(()=>api.resolveSlackDelivery({profileId:'owner',channelId:'D1',attemptId:'missing',expectedStatus:'sending',status:'unknown'}));
  db.close();assert.throws(()=>claim(['unavailable']));db=new Database(path.join(dir,'fixture.db'));
});
db.close();
const tempRoot = path.resolve(os.tmpdir());
const cleanupTarget = path.resolve(dir);
assert.equal(path.dirname(cleanupTarget), tempRoot, 'cleanup stays directly beneath intended temp parent');
assert.ok(path.basename(cleanupTarget).startsWith('maelle-delivery-'), 'cleanup names only this fixture');
fs.rmSync(cleanupTarget,{recursive:true});
console.log(JSON.stringify({before,passed,failed}));process.exitCode=failed?1:0;

