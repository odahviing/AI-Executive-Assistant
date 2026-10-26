// Actual catch-up + eligibility + SQLite retry store; isolated Slack and clocks.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test'),ts=require('typescript'),Database=require('better-sqlite3');
const root=path.resolve(__dirname,'..');
if(process.argv.includes('--before'))process.env.SLACK_BOUNDARY_SOURCE_ROOT=path.join(root,'artifacts/workshop-verification/opportunities-20261026/slackmaster/before');
const {harness}=require('./test-slack-thread-boundaries.cjs');
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maelle-catchup-integration-')),file=path.join(dir,'test.db');let db,now=1000000;
 const clock=class extends Date{static now(){return now;}};
 function boot(){
  if(db?.open)db.close();db=new Database(file);const cache=new Map();
  function load(rel){if(cache.has(rel))return cache.get(rel);const out={};cache.set(rel,out);
   const code=ts.transpileModule(fs.readFileSync(path.join(root,rel),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
   vm.runInNewContext(code,{exports:out,require:n=>n==='./client'?{getDb:()=>db}:n.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),n))+'.ts'):require(n),Date:clock});return out;
  }
  const api=load('src/db/slackCatchup.ts');api.initSlackCatchupSchema(db);return api;
 }
 let store=boot();
 t.after(()=>{if(db?.open)db.close();assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('maelle-catchup-integration-'));fs.rmSync(dir,{recursive:true,force:true});});
 function make(extra={}){
  const h=harness({clock,catchupStore:store,...options,...extra});h.handlers();return h;
 }
 const scan=(h,since=50000)=>h.load('src/core/background.ts').catchUpMissedMessages(h.app,h.ctx.profile,'DOWNER',since,true);
 return {make,scan,get store(){return store},get db(){return db},advance(ms=3600001){now+=ms},restart(){store=boot();},rows(){return store.listSlackCatchupRetries('UOWNER')},due(channel){db.prepare('UPDATE slack_catchup_retries SET nextCheckAt=0 WHERE channelId=?').run(channel)}};
}
const question={user:'UCOLLEAGUE',ts:'100.000001',text:'Question'};
function unread(channel='DCOLLEAGUE'){return {list:[{id:channel,is_im:true}],history:p=>({ok:true,messages:p.channel===channel?[question]:[]}),replies:()=>({ok:true,messages:[question]})};}
test('retry-cooldown',async t=>{const f=fixture(t),h=f.make(unread());let calls=0;const info=h.client.conversations.info;h.client.conversations.info=async p=>{if(p.channel==='DCOLLEAGUE'){calls++;throw Error('channel_not_found')}return info(p)};await f.scan(h);await f.scan(h,120000);assert.equal(calls,1);assert.equal(f.rows()[0].sinceMs,50000);assert.equal(h.received.length,0);});
test('retry-restart-omitted',async t=>{const f=fixture(t),h=f.make(unread());const info=h.client.conversations.info;h.client.conversations.info=async p=>{if(p.channel==='DCOLLEAGUE')throw Error('channel_not_found');return info(p)};await f.scan(h);f.restart();const next=f.make({...unread(),list:[]});await f.scan(next,200000);assert.equal(next.received.length,0);f.advance();await f.scan(next,200000);assert.equal(next.received.length,1);assert.equal(next.received[0].channelId,'DCOLLEAGUE');assert.equal(f.rows()[0].sinceMs,50000);});
test('retry-live-fresh',async t=>{const f=fixture(t),h=f.make(unread());const info=h.client.conversations.info;let unavailable=true;h.client.conversations.info=async p=>{if(p.channel==='DCOLLEAGUE'&&unavailable)throw Error('channel_not_found');return info(p)};await f.scan(h);unavailable=false;assert.ok(await h.load('src/connections/slack/eligibility.ts').readInternalSlackConversation(h.client,'fixture','DCOLLEAGUE','UCOLLEAGUE'));h.channels.DCOLLEAGUE.is_ext_shared=true;assert.equal(await h.load('src/connections/slack/eligibility.ts').readInternalSlackConversation(h.client,'fixture','DCOLLEAGUE','UCOLLEAGUE'),null);});
for(const channel of ['DOWNER','DCOLLEAGUE','GROOM','CROOM'])test('control-fresh-'+channel,async t=>{const f=fixture(t),h=f.make({list:[{id:channel,is_im:channel.startsWith('D'),is_mpim:channel==='GROOM',is_member:true}]});await f.scan(h);assert.equal(f.rows().length,0);assert.ok(h.calls.some(c=>c[0]==='history'&&c[1].channel===channel));});
test('retry-fresh-room-rejection',async t=>{const f=fixture(t);f.store.deferSlackCatchupRetry({profileId:'UOWNER',channelId:'CSHARED',sinceMs:50000,nextCheckAt:0});const h=f.make();await f.scan(h);assert.ok(h.calls.some(c=>c[0]==='info'&&c[1]==='CSHARED'));assert.equal(h.calls.some(c=>c[0]==='history'&&c[1].channel==='CSHARED'),false);assert.equal(f.rows().length,1);});
for(const phase of ['history','replies'])test('retry-partial-'+phase,async t=>{const f=fixture(t),h=f.make({...unread(),[phase]:p=>({ok:true,messages:[question],has_more:true})});await f.scan(h);assert.equal(f.rows().some(r=>r.channelId==='DCOLLEAGUE'),true);assert.equal(h.received.length,0);});
for(const phase of ['history','replies'])test('retry-malformed-'+phase,async t=>{const f=fixture(t),h=f.make({...unread(),[phase]:()=>({ok:true})});await f.scan(h);assert.equal(f.rows().some(r=>r.channelId==='DCOLLEAGUE'),true);assert.equal(h.received.length,0);});
test('retry-replay-unknown-and-confirmed',async t=>{const f=fixture(t),h=f.make(unread());h.load('src/connectors/slack/inboundReplayRegistry.ts').registerInboundReplay('UOWNER',async()=>{throw Error('unknown replay')});await f.scan(h);assert.equal(f.rows().length,1);f.advance();const next=f.make(unread());await f.scan(next,200000);assert.equal(next.received.length,1);assert.equal(f.rows().length,1);f.advance();next.client.conversations.replies=async()=>({ok:true,messages:[question,{user:'UBOT',bot_id:'B',ts:'101.000001',text:'Confirmed answer'}]});await f.scan(next,300000);assert.equal(f.rows().length,0);assert.equal(next.received.length,1);});
test('retry-store-unavailable',async t=>{const f=fixture(t),h=f.make({...unread(),catchupStore:{...f.store,deferSlackCatchupRetry(){throw Error('disk unavailable')}}});await assert.rejects(f.scan(h),/disk unavailable/);assert.equal(h.calls.some(c=>c[0]==='history'),false);});
test('retry-list-unavailable',async t=>{const f=fixture(t);f.store.deferSlackCatchupRetry({profileId:'UOWNER',channelId:'DCOLLEAGUE',sinceMs:50000,nextCheckAt:0});const h=f.make(unread());h.client.conversations.list=async()=>{throw Error('list unavailable')};await f.scan(h,200000);assert.equal(h.received.length,1);assert.equal(f.rows().length,1);});
for(const channel of ['GROOM','CROOM'])test('retry-omitted-'+channel,async t=>{const f=fixture(t);f.store.deferSlackCatchupRetry({profileId:'UOWNER',channelId:channel,sinceMs:50000,nextCheckAt:0});const message={...question,text:'<@UBOT> Question'};const h=f.make({history:p=>({ok:true,messages:p.channel===channel?[message]:[]}),replies:()=>({ok:true,messages:[message]})});await f.scan(h,200000);assert.equal(h.received.length,1);assert.equal(h.received[0].isMpim,channel==='GROOM');assert.equal(h.received[0].isChannel,channel==='CROOM');});
test('control-first-boot-no-backlog',async t=>{const f=fixture(t),h=f.make(unread());await h.load('src/core/background.ts').catchUpMissedMessages(h.app,h.ctx.profile,'DOWNER');assert.equal(h.received.length,0);assert.equal(f.rows().length,0);});
test('retry-healthy-cadence',async t=>{const f=fixture(t),h=f.make(unread());await f.scan(h);assert.equal(f.rows()[0].nextCheckAt,1600000);});
