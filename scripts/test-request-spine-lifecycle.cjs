/* Whole production modules, with isolated DB/transport/domain dependencies. No network. */
const assert=require('node:assert/strict'),{test,afterEach}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {DateTime}=require('luxon');
const root=path.resolve(__dirname,'..'),source=process.env.MAELLE_SPINE_SOURCE_ROOT||root;
const instances=[],cache=new Map();
const profile={user:{slack_user_id:'UOWNER',name:'Owner Example',timezone:'UTC'},assistant:{name:'Maelle'}};
const clone=x=>JSON.parse(JSON.stringify(x));
function harness(o={}){
 let row={id:'req_test',kind:'outreach',subkind:'meeting_reschedule',state:'awaiting_colleague',owner_user_id:'UOWNER',initiated_by:'UOWNER',requester_slack_id:'UPAUL',requester_name:'Paul',target_slack_id:'UPAUL',subject:'Meeting',origin_channel:'DPAUL',origin_thread_ts:'source.root',owner_dm_channel:'DOWNER',owner_dm_thread_ts:'owner.root',next_check_at:'2026-01-01T00:00:00Z',next_check_handler:'reschedule_reask',expires_at:'2026-12-01T00:00:00Z',details_json:'{}',...o.row};
 const effects={updates:[],closes:[],sends:[],inserts:[],creates:[],jobs:[],warnings:[],unexpected:[]},mods=new Map();
 const update=(id,p)=>{assert.equal(id,row.id);effects.updates.push(clone(p));const fields={state:'state',nextCheckAt:'next_check_at',nextCheckHandler:'next_check_handler',expiresAt:'expires_at',details:'details_json',requesterNotifiedAt:'requester_notified_at',ownerDmChannel:'owner_dm_channel',ownerDmThreadTs:'owner_dm_thread_ts',terminalDmMsgTs:'terminal_dm_msg_ts'};for(const [k,v]of Object.entries(p))if(fields[k])row[fields[k]]=k==='details'?JSON.stringify(v):v;};
 const conn={sendDirect:async(id,body,opts)=>{effects.sends.push({id,body,opts});return {ok:!o.sendFail,ts:'sent.ts',ref:'DOWNER'};},postToChannel:async(id,body,opts)=>{effects.sends.push({id,body,opts});return {ok:!o.sendFail,ts:'sent.ts',ref:id};}};
 const mocks={
  'src/db/requests.ts':{getDueRequests:()=>[clone(row)],getRequest:()=>row,updateRequest:update,getRequestByIdempotencyKey:()=>null,buildIdempotencyKey:()=> 'test-key',createRequest:p=>{effects.creates.push(p);if(o.bridgeFail)throw Error('fixture request insert failed');return {id:row.id};}},
  'src/core/requests/closeRequest.ts':{closeRequest:p=>{effects.closes.push(p);if(['resolved','cancelled','expired','logged'].includes(row.state))return {ok:true};row.state=p.state;row.next_check_at=null;row.next_check_handler=null;return {ok:true};}},
  'src/core/requests/resolver.ts':{withRequestLock:async(_id,work)=>work()},
  'src/core/requests/requesterRelay.ts':{relayClosureToRequester:async({compose})=>{if(o.noConnection)return false;effects.sends.push({id:'UPAUL',body:compose({lang:'en',hi:'Hey Paul',ownerFirst:'Owner',subject:'Meeting'})});return !o.sendFail;}},
  'src/db/jobs.ts':{getOutreachJobByRequestId:()=>o.noJob?null:{id:'out_test',intent:o.intent||'meeting_reschedule',colleague_slack_id:'UPAUL',colleague_name:'Paul',colleague_tz:'UTC'},createOutreachJob:()=> 'out_test',updateOutreachJob:(id,p)=>effects.jobs.push({id,...p}),getLinkedRequestIdForOutreach:()=>row.id},
  'src/db/client.ts':{getDb:()=>({transaction:work=>()=>{const n=effects.creates.length;try{return work();}catch(e){effects.creates.length=n;throw e;}},prepare:sql=>({run:(...args)=>{if(o.payloadFail)throw Error('fixture payload insert failed');effects.inserts.push({sql,args});},get:()=>null,all:()=>[]})})},
  'src/connections/registry.ts':{getConnection:()=>o.noConnection?undefined:conn},
  'src/utils/workHours.ts':{workTimeBaseFromNow:()=>{if(o.workHoursThrow)throw Error('fixture hours unavailable');return DateTime.now().toISO();},addWorkdays:()=>DateTime.now().plus({days:2}).toISO()},
  'src/utils/responseDeadline.ts':{isColleagueSendDeferred:()=>{if(o.gateThrow)throw Error('fixture gate failure');return {deferred:!!o.deferred,deferredTo:'2026-10-01T09:00:00Z'};},calcResponseDeadline:()=> '2026-10-02T09:00:00Z'},
  'src/db/people.ts':{findPersistentUnaskedTimezoneDivergences:()=>[],getPersonMemory:()=>({timezone:'UTC'}),markTimezoneTempAskedById(){}},
  'src/utils/ownerDailyThread.ts':{postOwnerDecision:async({text})=>{effects.sends.push({id:'UOWNER',body:text});return {ok:!o.sendFail,channel:'DOWNER',threadTs:'owner.root',ts:'owner.next'};}},
  'src/core/approvals/approvalCallbacks.ts':{composeOwnerAskText:async({askText})=>askText},
  'src/core/requests/logActivity.ts':{logActivity(){}},
  'src/llm/client.ts':{getAnthropicClient:()=>({messages:{create:async()=>({content:[]})}})},
  'src/llm/models.ts':{MODEL_HAIKU:'fixture'},
  'src/utils/scheduleRules.ts':{},'src/connectors/graph/calendarReads.ts':{},
  'src/utils/logger.ts':{__esModule:true,default:{info(){},debug(){},error(){},warn:(...a)=>effects.warnings.push(a)}},
 };
 if(o.actualJobs)delete mocks['src/db/jobs.ts'];
 function load(file){
  if(mocks[file])return mocks[file];if(mods.has(file))return mods.get(file).exports;
  if(!['src/core/requests/runner.ts','src/core/requests/colleagueOofReengage.ts','src/core/requests/types.ts','src/db/jobs.ts'].includes(file)){effects.unexpected.push(file);throw Error('unmocked '+file);}
  const filename=path.join(file==='src/core/requests/types.ts'?root:source,file);if(!cache.has(filename))cache.set(filename,ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
  const m={exports:{}};mods.set(file,m);vm.runInNewContext('(function(require,module,exports){'+cache.get(filename)+'\n})',{Date,Map,Set})(spec=>spec==='luxon'?{DateTime}:load(path.posix.normalize(path.posix.join(path.posix.dirname(file),spec))+'.ts'),m,m.exports);return m.exports;
 }
 const h={effects,row:()=>row,sweep:()=>load('src/core/requests/runner.ts').sweepDueRequests({profilesByUserId:new Map([['UOWNER',profile]])}),oof:()=>load('src/core/requests/colleagueOofReengage.ts').runOofReengageReask(row,profile),job:(extra={})=>load('src/db/jobs.ts').createOutreachJob({owner_user_id:'UOWNER',owner_channel:'DOWNER',colleague_slack_id:'UPAUL',colleague_name:'Paul',message:'Follow up',await_reply:1,reply_deadline:'2026-10-01T00:00:00Z',...extra})};instances.push(h);return h;
}
afterEach(()=>{for(const h of instances.splice(0))assert.deepEqual(h.effects.unexpected,[]);});
test('A03 unexpected handler failure closes honestly and reports both sides',async()=>{const h=harness({gateThrow:true});await h.sweep();assert.equal(h.row().state,'cancelled');assert.equal(h.effects.sends.length,2);assert.match(h.effects.sends[0].body,/failed|could not|couldn't/i);});
test('A03 unknown handler never leaves an open timerless request',async()=>{const h=harness({row:{next_check_handler:'invalid_handler'}});await h.sweep();assert.equal(h.row().state,'cancelled');assert.equal(h.effects.sends.length,2);});
for(const mode of ['reschedule','oof'])test('A03 '+mode+' missing connection retains expiry',async()=>{const h=harness({noConnection:true,intent:mode==='oof'?'oof_reengage':'meeting_reschedule'});await(mode==='oof'?h.oof():h.sweep());assert.equal(h.row().state,'awaiting_colleague');assert.equal(h.row().next_check_handler,'outreach_expiry');assert.ok(h.row().next_check_at);});
test('A03 legitimate reask sends once and arms expiry',async()=>{const h=harness();await h.sweep();assert.equal(h.effects.sends.length,1);assert.equal(h.row().next_check_handler,'outreach_expiry');});
test('A03 legitimate out-of-hours reask defers without sending',async()=>{const h=harness({deferred:true});await h.sweep();assert.equal(h.effects.sends.length,0);assert.equal(h.row().next_check_handler,'reschedule_reask');});
test('A09 failed request creation cannot produce payload-only outreach',()=>{const h=harness({actualJobs:true,bridgeFail:true});assert.throws(()=>h.job(),/fixture request insert failed/);assert.equal(h.effects.inserts.length,0);});
test('A09 legitimate outreach records request before payload',()=>{const h=harness({actualJobs:true});assert.ok(h.job());assert.equal(h.effects.creates.length,1);assert.equal(h.effects.inserts.length,1);});
test('A10 approval reminder without delivery anchor actually delivers ask',async()=>{const h=harness({row:{kind:'approval',state:'awaiting_owner',next_check_handler:'approval_reminder',owner_dm_channel:null,owner_dm_thread_ts:null}});await h.sweep();assert.equal(h.effects.sends.length,1);assert.equal(h.row().owner_dm_channel,'DOWNER');});
test('A10 legitimate expiry closes and tells both sides',async()=>{const h=harness({row:{kind:'approval',next_check_handler:'expiry'}});await h.sweep();assert.equal(h.row().state,'expired');assert.equal(h.effects.sends.length,2);});
test('A09 unsent fire-and-forget is pending until delivery confirmation',()=>{const h=harness({actualJobs:true});h.job({await_reply:0});assert.equal(h.effects.creates[0].state,'in_flight');assert.ok(h.effects.creates[0].nextCheckAt);});
test('A09 legitimate already-delivered fire-and-forget stays resolved',()=>{const h=harness({actualJobs:true});h.job({await_reply:0,sent_at:'2026-09-10T10:00:00Z'});assert.equal(h.effects.creates[0].state,'resolved');});
test('A09 payload insert failure rolls back spine creation',()=>{const h=harness({actualJobs:true,payloadFail:true});assert.throws(()=>h.job(),/payload insert failed/);assert.equal(h.effects.creates.length,0);});
test('A03 malformed reschedule payload closes and tells both waiting sides',async()=>{const h=harness({noJob:true});await h.sweep();assert.equal(h.row().state,'cancelled');assert.equal(h.effects.sends.length,2);});
test('A03 stale terminal timer cannot expire successful work',async()=>{const h=harness({row:{state:'resolved',next_check_handler:'expiry',kind:'approval'}});await h.sweep();assert.equal(h.row().state,'resolved');assert.equal(h.effects.sends.length,0);});
test('A03 future timer snapshot is not dispatched early',async()=>{const h=harness({row:{next_check_at:'2099-01-01T00:00:00Z',next_check_handler:'expiry'}});await h.sweep();assert.equal(h.row().state,'awaiting_colleague');assert.equal(h.effects.sends.length,0);});
test('A10 expiry tells owner even when alarm had no private anchor',async()=>{const h=harness({row:{kind:'approval',next_check_handler:'expiry',owner_dm_channel:null,owner_dm_thread_ts:null}});await h.sweep();assert.equal(h.effects.sends.length,2);assert.equal(h.effects.sends[0].id,'UOWNER');});
test('A07 expiry after counter gives direct-owner path',async()=>{const h=harness({row:{kind:'approval',next_check_handler:'expiry',details_json:JSON.stringify({amend_round:2})}});await h.sweep();assert.match(h.effects.sends[1].body,/contact Owner directly/);assert.doesNotMatch(h.effects.sends[0].body,/chase/);});
test('A09 scheduled missing connection retains existing bounded retry',async()=>{const h=harness({noConnection:true,row:{state:'in_flight',next_check_handler:'send_scheduled_outreach'}});await h.sweep();assert.equal(h.row().state,'in_flight');assert.equal(h.row().next_check_handler,'send_scheduled_outreach');assert.equal(JSON.parse(h.row().details_json).send_attempts,1);});
test('A09 scheduled confirmed delivery updates payload for reply consumers',async()=>{const h=harness({row:{state:'in_flight',next_check_handler:'send_scheduled_outreach'}});await h.sweep();assert.equal(h.row().state,'awaiting_colleague');assert.equal(h.effects.jobs.length,1);assert.equal(h.effects.jobs[0].dm_message_ts,'sent.ts');assert.ok(h.effects.jobs[0].sent_at);assert.equal(h.effects.sends.length,1);});
test('A09 outreach expiry without owner anchor still notifies owner',async()=>{const h=harness({row:{next_check_handler:'outreach_expiry',owner_dm_channel:null,owner_dm_thread_ts:null}});await h.sweep();assert.equal(h.row().state,'expired');assert.equal(h.effects.sends[0].id,'UOWNER');});
for(const mode of ['reschedule','oof'])test('R4 '+mode+' actual reminder records sole nudge',async()=>{const h=harness({intent:mode==='oof'?'oof_reengage':'meeting_reschedule'});await(mode==='oof'?h.oof():h.sweep());assert.equal(h.effects.updates.at(-1).phase,'outreach:nudged');assert.equal(h.effects.sends.length,1);});
