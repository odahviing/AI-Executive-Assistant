// Real on-disk SQLite, instrumented only to observe pragmas/transaction bounds.
// FULL configuration and reopen are tested; this does not simulate power loss.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const before = process.argv.includes('--before');
const root = path.resolve(__dirname,'..');
const source = before ? 'artifacts/workshop-verification/approved-four-20261007/handyman/slackDelivery.a2.ts' : 'src/db/slackDelivery.ts';
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'maelle-durability-'));
const filename = path.join(dir,'fixture.db');
let db = new Database(filename), events = [], throwCallback = false;
const observe = stage => events.push({stage,synchronous:db.pragma('synchronous',{simple:true}),inTransaction:db.inTransaction});
const handle = new Proxy({}, {get(_target, key) {
  if(key==='transaction') return fn => {
    const run = db.transaction(()=>{observe('callback');return fn();});
    return {immediate:()=>{observe('before-begin');try{return run.immediate();}finally{observe('after-commit-or-rollback');}}};
  };
  const value=db[key];return typeof value==='function'?value.bind(db):value;
}});
const output = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,source),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
  {exports:output,require:name=>name==='./client'?{getDb:()=>handle}:name==='crypto'?{randomUUID(){observe('uuid-callback');if(throwCallback)throw Error('fixture callback throw');return crypto.randomUUID();}}:require(name)});
const api=output;
db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');db.pragma('synchronous=NORMAL');api.initSlackDeliverySchema(db);
let passed=0,failed=0;
function test(name,fn){try{events=[];fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}finally{throwCallback=false;if(db.inTransaction)db.exec('ROLLBACK');db.pragma('synchronous=NORMAL');}}
const claim = id => api.beginSlackDelivery({profileId:'owner',channelId:'D1',inboundTs:[id,id+'-merged'],now:100,nextCheckAt:200});
function fullCommit(){assert.ok(events.some(e=>e.stage==='callback'&&e.inTransaction),'actual transaction callback observed');assert.ok(events.some(e=>e.stage==='after-commit-or-rollback'&&!e.inTransaction),'commit/rollback completed before restore');assert.ok(events.every(e=>e.synchronous===2),JSON.stringify(events));assert.equal(db.pragma('synchronous',{simple:true}),1);}
test('claim commits at FULL then restores NORMAL and survives disk reopen',()=>{
  const a=claim('durable');fullCommit();db.close();db=new Database(filename);
  assert.equal(api.getSlackDelivery('owner','D1','durable-merged').attemptId,a.attemptId);
});
test('confirmed failed unknown and stale CAS resolutions commit at FULL and restore NORMAL',()=>{
  for(const status of ['confirmed','failed','unknown']) {
    const a=claim('resolve-'+status);events=[];
    assert.equal(api.resolveSlackDelivery({...a,expectedStatus:'sending',status,nextCheckAt:300,now:150}),true);fullCommit();
    events=[];assert.equal(api.resolveSlackDelivery({...a,expectedStatus:'sending',status:'failed',now:150}),false);fullCommit();
    db.close();db=new Database(filename);db.pragma('synchronous=NORMAL');
    assert.equal(api.getSlackDelivery('owner','D1','resolve-'+status).status,status);
  }
});
test('blocked claim restores NORMAL after FULL no-op transaction',()=>{
  claim('blocked');events=[];assert.equal(claim('blocked'),null);fullCommit();
});
test('SQL error rolls back all members and restores NORMAL after FULL rollback',()=>{
  db.exec("CREATE TRIGGER fixture_abort BEFORE INSERT ON slack_delivery_inbound WHEN NEW.inboundTs='sql-error' BEGIN SELECT RAISE(ABORT,'fixture SQL failure'); END");
  const count=db.prepare('SELECT count(*) n FROM slack_delivery_attempts').get().n;
  try {assert.throws(()=>claim('sql-error'),/fixture SQL failure/);fullCommit();
    assert.equal(db.prepare('SELECT count(*) n FROM slack_delivery_attempts').get().n,count);
    assert.equal(api.getSlackDelivery('owner','D1','sql-error'),null);
  } finally {db.exec('DROP TRIGGER fixture_abort');}
  const a=claim('sql-resolution');events=[];
  db.exec("CREATE TRIGGER fixture_abort_update BEFORE UPDATE ON slack_delivery_attempts BEGIN SELECT RAISE(ABORT,'fixture resolution failure'); END");
  try {assert.throws(()=>api.resolveSlackDelivery({...a,expectedStatus:'sending',status:'confirmed'}),/fixture resolution failure/);fullCommit();
    assert.equal(api.getSlackDelivery('owner','D1','sql-resolution').status,'sending');
  } finally {db.exec('DROP TRIGGER fixture_abort_update');}
});
test('callback throw restores NORMAL after FULL rollback',()=>{
  throwCallback=true;assert.throws(()=>claim('throw'),/fixture callback throw/);fullCommit();
  assert.equal(api.getSlackDelivery('owner','D1','throw'),null);
});
test('nested claims and resolutions reject without changing the outer transaction',()=>{
  const a=claim('outer-resolution');db.exec('BEGIN');
  assert.throws(()=>claim('nested'),/independent durable transaction/);
  assert.throws(()=>api.resolveSlackDelivery({...a,expectedStatus:'sending',status:'failed'}),/independent durable transaction/);
  assert.equal(db.inTransaction,true);assert.equal(db.pragma('synchronous',{simple:true}),1);
  assert.equal(api.getSlackDelivery('owner','D1','outer-resolution').status,'sending');
  assert.equal(api.getSlackDelivery('owner','D1','nested'),null);db.exec('ROLLBACK');
});
test('each original synchronous policy is restored unchanged',()=>{
  for(const setting of [0,1,2,3]){db.pragma('synchronous='+setting);claim('policy-'+setting);assert.equal(db.pragma('synchronous',{simple:true}),setting);}
});
db.close();const target=path.resolve(dir),parent=path.resolve(os.tmpdir());
assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('maelle-durability-'));
fs.rmSync(target,{recursive:true});console.log(JSON.stringify({before,passed,failed,scope:'SQLite FULL commit configuration and disk reopen; no physical power-cut simulation'}));process.exitCode=failed?1:0;
