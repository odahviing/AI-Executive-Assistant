// Actual reminder -> closure -> durable requester relay -> SQL due selection -> restart sweep.
// Transport/domain calls are isolated; no production data, messages, or model calls.
const {test,afterEach}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const Database=require('better-sqlite3'),{DateTime}=require('luxon');
const root=process.cwd(),source=process.env.MAELLE_SPINE_SOURCE_ROOT||root,live=[];
const profile={user:{slack_user_id:'OWNER',name:'Owner Example',timezone:'UTC'},assistant:{name:'Maelle'}};
function harness(o={}){
 const db=new Database(':memory:');live.push(db);
 db.exec(fs.readFileSync(path.join(root,'src/db/client.ts'),'utf8').match(/CREATE TABLE IF NOT EXISTS requests \([\s\S]*?\n    \);/)[0]);
 db.exec('ALTER TABLE requests ADD COLUMN phase TEXT; ALTER TABLE requests ADD COLUMN requester_notified_at TEXT; CREATE TABLE audit_log(owner_user_id,action,source,actor,target,details,outcome)');
 const initial={id:'req_logged',owner_user_id:'OWNER',initiated_by:'COLLEAGUE',initiated_by_role:'colleague',kind:'reminder',subject:'Send report',state:'in_flight',requester_slack_id:'COLLEAGUE',requester_name:'Requester',origin_channel:o.room?'ROOM':'DM',origin_thread_ts:'origin.1',origin_is_mpim:o.room?1:0,next_check_at:'2020-01-01T00:00:00Z',next_check_handler:'reminder_fire',details_json:'{}',...o.row};
 const keys=Object.keys(initial);db.prepare(`INSERT INTO requests (${keys.join(',')}) VALUES (${keys.map(k=>'@'+k).join(',')})`).run(initial);
 let mode=o.mode||'failed',connection=!o.noConnection,modules=new Map();const effects={owner:[],requester:[],unexpected:[],researchRuns:0,researchContexts:[]};
 const send=async(id,body,opts)=>{if(id==='OWNER'||id==='DOWNER'){effects.owner.push({id,body,opts});if(o.disconnectAfterDelivery)connection=false;if(o.ownerMode==='throw')throw Error('owner receipt unknown');return o.ownerMode==='failed'?{ok:false,reason:'not_in_channel'}:o.ownerMode==='unknown'?{ok:false,reason:'error'}:{ok:true,ts:'owner.1'};}effects.requester.push({id,body,opts});if(o.pauseSend)await o.pauseSend();if(mode==='throw')throw Error('unknown delivery');return mode==='ok'?{ok:true,ts:'requester.1'}:{ok:false,reason:mode==='unknown'?'error':'not_in_channel'};};
 const mocks={
 'src/db/client.ts':{getDb:()=>db},'src/db/conversations.ts':{getConversationHistory:()=>[],appendToConversation(){}},
 'src/db/people.ts':{findPersistentUnaskedTimezoneDivergences:()=>[],getPersonMemory:()=>({name:'Verified Requester'}),resolveOutboundLanguageForPerson:()=> 'en'},
 'src/connections/registry.ts':{getConnection:()=>connection?{sendDirect:send,postToChannel:send}:undefined},
 'src/core/orchestrator.ts':{runOrchestrator:async input=>{effects.researchRuns++;effects.researchContexts.push(input);if(o.researchThrows)throw Error('research unavailable');return {reply:o.emptyResearch?'':'Preserved research result'};}},
 'src/core/requests/resolver.ts':{withRequestLock:async(_id,fn)=>fn()},
 'src/core/requests/logActivity.ts':{logActivity(){}},'src/core/requests/colleagueOofReengage.ts':{},
 'src/core/requests/activityRevertibility.ts':{ACTIVITY_REVERTIBILITY:{}},
 'src/db/jobs.ts':{createOutreachJob:()=> 'out_history'},
 'src/utils/logger.ts':{__esModule:true,default:{info(){},warn(){},error(){},debug(){}}},
 'src/utils/workHours.ts':{},'src/utils/responseDeadline.ts':{},'src/utils/attendeeAvailability.ts':{},
 'src/utils/ownerDailyThread.ts':{postOwnerDecision:async({text})=>send('OWNER',text),getOrCreateOwnerDailyThread:async()=>o.noDaily?null:{channel:'DOWNER',rootTs:'daily.root'}},'src/core/approvals/approvalCallbacks.ts':{},
 };
 function load(file){if(mocks[file])return mocks[file];if(modules.has(file))return modules.get(file).exports;
 const allowed=['src/db/requests.ts','src/core/requests/types.ts','src/core/requests/closeRequest.ts','src/core/requests/requesterRelay.ts','src/core/requests/runner.ts','src/utils/timezoneConvert.ts','src/utils/weTimeResolver.ts'];
 if(!allowed.includes(file)){effects.unexpected.push(file);throw Error('unmocked '+file);}const chosen=fs.existsSync(path.join(source,file))?source:root;
 const code=ts.transpileModule(fs.readFileSync(path.join(chosen,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,m={exports:{}};modules.set(file,m);
 vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Date,Map,Set})(name=>name==='luxon'?{DateTime}:name==='crypto'?require('node:crypto'):load(path.posix.normalize(path.posix.join(path.posix.dirname(file),name))+'.ts'),m,m.exports);return m.exports;
 }
 const get=()=>load('src/db/requests.ts').getRequest(initial.id);
 return {db,effects,get,recent:()=>load('src/db/requests.ts').getRecentActivityForOwner('OWNER',20),sweep:()=>load('src/core/requests/runner.ts').sweepDueRequests({profilesByUserId:new Map([['OWNER',profile]])}),due:()=>load('src/db/requests.ts').getDueRequests(),relay:()=>load('src/core/requests/requesterRelay.ts').relayClosureToRequester({row:get(),profile,label:'fixture',compose:()=> 'Exact outcome'}),restart:(newMode=mode,newConnection=connection)=>{mode=newMode;connection=newConnection;modules=new Map();db.prepare("UPDATE requests SET next_check_at='2020-01-01T00:00:00Z' WHERE next_check_handler='requester_relay_retry'").run();},recover:()=>{mode='ok';connection=true;modules=new Map();db.prepare("UPDATE requests SET next_check_at='2020-01-01T00:00:00Z' WHERE next_check_handler='requester_relay_retry'").run();}};
}
afterEach(()=>{for(const db of live.splice(0))db.close();});
test('restart boundary third requester dispatch is durably non-replayable',async()=>{
 let release;const pending=new Promise(r=>release=r);const h=harness({pauseSend:()=>pending,row:{state:'resolved',outcome_json:JSON.stringify({requester_relay:{body:'Exact outcome',delivery:'failed',send_attempts:2}}),next_check_handler:'requester_relay_retry'}});
 const work=h.relay();await Promise.resolve();
 const persisted=JSON.parse(h.get().outcome_json).requester_relay;
 release();await work;
 assert.equal(persisted.delivery,'unconfirmed','process interruption during transport must retain uncertainty, not retryable failed');
});
test('concurrent third requester dispatch cannot exceed total cap',async()=>{
 const h=harness({row:{state:'resolved',outcome_json:JSON.stringify({requester_relay:{body:'Exact outcome',delivery:'failed',send_attempts:2}})}});
 await Promise.all([h.relay(),h.relay()]);assert.equal(h.effects.requester.length,1,'one remaining transport opportunity');
});
test('concurrent exhausted sweeps claim one owner notification before thread lookup',async()=>{const h=harness({row:{state:'resolved',next_check_handler:'requester_relay_retry',outcome_json:JSON.stringify({requester_relay:{body:'Exact outcome',delivery:'exhausted',send_attempts:3}})}});await Promise.all([h.sweep(),h.sweep()]);assert.equal(h.effects.owner.length,1);assert.equal(h.effects.requester.length,0);});
test('control definite third failure exhausts after reserved dispatch settles',async()=>{const h=harness({row:{state:'resolved',outcome_json:JSON.stringify({requester_relay:{body:'Exact outcome',delivery:'failed',send_attempts:2}})}});await h.relay();assert.equal(h.effects.requester.length,1);assert.equal(JSON.parse(h.get().outcome_json).requester_relay.delivery,'exhausted');});
test('control confirmed third delivery stamps and clears outstanding copy',async()=>{const h=harness({mode:'ok',row:{state:'resolved',outcome_json:JSON.stringify({requester_relay:{body:'Exact outcome',delivery:'failed',send_attempts:2}})}});await h.relay();assert.ok(h.get().requester_notified_at);assert.equal(JSON.parse(h.get().outcome_json).requester_relay,undefined);});
test('restart during third dispatch does not retry from SQL due selection',async()=>{let release;const pending=new Promise(r=>release=r);const h=harness({pauseSend:()=>pending,row:{state:'resolved',outcome_json:JSON.stringify({requester_relay:{body:'Exact outcome',delivery:'failed',send_attempts:2}}),next_check_handler:'requester_relay_retry'}});const work=h.relay();await Promise.resolve();h.restart();const sweep=h.sweep();await Promise.resolve();const calls=h.effects.requester.length;const handler=h.get().next_check_handler;release();await Promise.all([work,sweep]);assert.equal(calls,1);assert.equal(handler,null);});
