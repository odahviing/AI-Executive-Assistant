// Real SQLite + full getDb startup/schema, reopen and old-code rollback.
// No production DB/network/transport. --before uses captured pre-change startup.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test'),ts=require('typescript');
const Database=require('better-sqlite3');
const root=path.resolve(__dirname,'..'),before=process.argv.includes('--before');
const baseline='artifacts/workshop-verification/opportunities-20261026/handyman/slack-store/before/client.ts';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maelle-catchup-')),file=path.join(dir,'fixture.db');
 let db;
 t.after(()=>{if(db?.open)db.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('maelle-catchup-'));fs.rmSync(dir,{recursive:true,force:true});});
 function boot(old=before){
  if(db?.open)db.close();const cache=new Map();
  const load=rel=>{
   if(cache.has(rel))return cache.get(rel).exports;
   const mod={exports:{}};cache.set(rel,mod);
   const source=fs.readFileSync(path.join(root,old&&rel==='src/db/client.ts'?baseline:rel),'utf8');
   const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
   const req=name=>{
    if(name==='../config')return {config:{DB_PATH:file}};
    if(name==='../config/userProfile')return {loadAllProfiles:()=>[]};
    if(name==='../utils/logger')return {__esModule:true,default:{info(){},warn(){},error(){}}};
    if(name.startsWith('./migrations/'))return new Proxy({},{get:()=>()=>{}});
    if(name.startsWith('.'))return load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),name))+'.ts');
    return require(name);
   };
   vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{console,Date,Map,Set,Buffer,process})(req,mod,mod.exports);return mod.exports;
  };
  db=load('src/db/client.ts').getDb();return {api:load('src/db/slackCatchup.ts'),delivery:load('src/db/slackDelivery.ts'),db};
 }
 return {boot,get db(){return db}};
}
const row=(extra={})=>({profileId:'UOWNER',channelId:'DPEER',sinceMs:1000,nextCheckAt:5000,...extra});
test('CONTROL existing conversation and delivery data survive additive startup and rollback',t=>{
 const f=fixture(t);let h=f.boot(true);
 h.db.prepare("INSERT INTO conversation_threads(thread_ts,channel_id,context) VALUES('T1','DPEER','[]')").run();
 const attempt=h.delivery.beginSlackDelivery({profileId:'UOWNER',channelId:'DPEER',inboundTs:['1.000001'],now:100,nextCheckAt:5000});
 h=f.boot();assert.equal(h.db.prepare('SELECT context FROM conversation_threads WHERE thread_ts=?').get('T1').context,'[]');
 assert.equal(h.delivery.getSlackDelivery('UOWNER','DPEER','1.000001').attemptId,attempt.attemptId);
 h=f.boot(true);assert.equal(h.db.prepare('SELECT count(*) AS n FROM conversation_threads').get().n,1);
});
test('REGRESSION restart retains earliest unscanned cursor and next retry',t=>{
 const f=fixture(t);let h=f.boot();h.api.deferSlackCatchupRetry(row());h=f.boot();
 assert.deepEqual(JSON.parse(JSON.stringify(h.api.listSlackCatchupRetries('UOWNER'))),[row()]);
});
test('REGRESSION later global watermark cannot advance unresolved cursor or shorten cooldown',t=>{
 const f=fixture(t),h=f.boot();h.api.deferSlackCatchupRetry(row());
 const latest=h.api.deferSlackCatchupRetry(row({sinceMs:3000,nextCheckAt:4000}));assert.equal(latest.sinceMs,1000);assert.equal(latest.nextCheckAt,5000);
 const older=h.api.deferSlackCatchupRetry(row({sinceMs:500,nextCheckAt:6000}));assert.equal(older.sinceMs,500);assert.equal(older.nextCheckAt,6000);
});
test('REGRESSION authenticated profile and conversation scopes stay independent',t=>{
 const h=fixture(t).boot();for(const r of [row(),row({profileId:'UOTHER'}),row({channelId:'GROOM'})])h.api.deferSlackCatchupRetry(r);
 assert.equal(h.api.listSlackCatchupRetries('UOWNER').length,2);assert.equal(h.api.listSlackCatchupRetries('UOTHER').length,1);
 assert.equal(h.api.clearSlackCatchupRetry(row()),true);assert.equal(h.api.listSlackCatchupRetries('UOTHER').length,1);
});
test('REGRESSION stale completion cannot clear a newly deferred interval',t=>{
 const h=fixture(t).boot();const original=h.api.deferSlackCatchupRetry(row());
 const newer=h.api.deferSlackCatchupRetry(row({sinceMs:500,nextCheckAt:6000}));assert.equal(h.api.clearSlackCatchupRetry(original),false);
 assert.equal(h.api.clearSlackCatchupRetry(newer),true);assert.equal(h.api.clearSlackCatchupRetry(newer),false);assert.equal(h.api.listSlackCatchupRetries('UOWNER').length,0);
});
test('REGRESSION old-code rollback and upgrade retain unresolved work',t=>{
 const f=fixture(t);let h=f.boot();h.api.deferSlackCatchupRetry(row());h=f.boot(true);h=f.boot();
 assert.equal(h.api.listSlackCatchupRetries('UOWNER')[0].sinceMs,1000);
});
test('REGRESSION database failure is observable and cannot fabricate completion',t=>{
 const h=fixture(t).boot();h.api.deferSlackCatchupRetry(row());
 h.db.exec("CREATE TRIGGER fail_retry BEFORE UPDATE ON slack_catchup_retries BEGIN SELECT RAISE(ABORT,'fixture store unavailable'); END");
 assert.throws(()=>h.api.deferSlackCatchupRetry(row({sinceMs:500,nextCheckAt:6000})),/fixture store unavailable/);
 assert.equal(h.api.listSlackCatchupRetries('UOWNER')[0].sinceMs,1000);
 h.db.exec("CREATE TRIGGER fail_clear BEFORE DELETE ON slack_catchup_retries BEGIN SELECT RAISE(ABORT,'fixture clear unavailable'); END");
 assert.throws(()=>h.api.clearSlackCatchupRetry(row()),/fixture clear unavailable/);assert.equal(h.api.listSlackCatchupRetries('UOWNER').length,1);
});
test('REGRESSION cursors never synthesize delivery receipts or duplicate rows',t=>{
 const h=fixture(t).boot();h.api.deferSlackCatchupRetry(row());h.api.deferSlackCatchupRetry(row());
 assert.equal(h.api.listSlackCatchupRetries('UOWNER').length,1);
 assert.equal(h.db.prepare('SELECT count(*) AS n FROM slack_delivery_attempts').get().n,0);assert.equal(h.db.prepare('SELECT count(*) AS n FROM slack_delivery_inbound').get().n,0);
});
test('CONTROL invalid scope/timestamps cannot mutate persisted work',t=>{
 const h=fixture(t).boot();for(const r of [row({profileId:''}),row({channelId:''}),row({sinceMs:-1}),row({nextCheckAt:NaN}),row({sinceMs:1.5})])assert.throws(()=>h.api.deferSlackCatchupRetry(r));
});
test('REGRESSION durable commits reject nested transaction and restore synchronous mode',t=>{
 const h=fixture(t).boot();h.db.pragma('synchronous=NORMAL');
 h.api.deferSlackCatchupRetry(row());assert.equal(h.db.pragma('synchronous',{simple:true}),1);
 assert.throws(()=>h.db.transaction(()=>h.api.deferSlackCatchupRetry(row()))(),/independent durable transaction/);
 assert.equal(h.db.pragma('synchronous',{simple:true}),1);
});
