/* Repair-attempt tests: whole lifecycle modules, explicit domain/DB/transport doubles.
 * MAELLE_BOUNCE_SOURCE_ROOT selects the frozen attempt-1 sources. No network/boot.
 */
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {DateTime}=require('luxon'),Database=require('better-sqlite3');
const root=path.resolve(__dirname,'..'),source=process.env.MAELLE_BOUNCE_SOURCE_ROOT||root,cache=new Map();
const profile={user:{slack_user_id:'OWNER',name:'Owner Example',timezone:'UTC'},assistant:{name:'Maelle'}};
const clone=x=>JSON.parse(JSON.stringify(x));
function harness(o={}){
 let row={id:'req_current',kind:'approval',subkind:'policy_exception',state:'awaiting_owner',owner_user_id:'OWNER',requester_slack_id:'COLLEAGUE',requester_name:'Paul',subject:'Approved sync',description:'Move approved sync',origin_channel:'DPAUL',origin_thread_ts:'requester.root',owner_dm_channel:'DOWNER',owner_dm_thread_ts:'owner.root',expires_at:'2026-12-01T00:00:00Z',next_check_handler:'expiry',next_check_at:'2026-01-01T00:00:00Z',details_json:JSON.stringify({deferred_action:{tool:'move_meeting',args:{meeting_id:'event',meeting_subject:'Approved sync',new_start:'2026-12-01T10:00:00Z',new_end:'2026-12-01T11:00:00Z'}}}),...o.row};
 const effects={executes:[],sends:[],owner:[],writes:[],history:[],outbound:[],unexpected:[],checks:0};
 let delivery=o.delivery||'sent';const mods=new Map();
 const fields={nextCheckAt:'next_check_at',nextCheckHandler:'next_check_handler',ownerDmChannel:'owner_dm_channel',ownerDmThreadTs:'owner_dm_thread_ts',terminalDmMsgTs:'terminal_dm_msg_ts',requesterNotifiedAt:'requester_notified_at',closureReason:'closure_reason',closedBy:'closed_by',closedAt:'closed_at',expiresAt:'expires_at'};
 const update=(id,p)=>{assert.equal(id,row.id);effects.writes.push(clone(p));for(const[k,v]of Object.entries(p))row[fields[k]||k]=k==='details'||k==='outcomeJson'?JSON.stringify(v):v;if(p.details)row.details_json=JSON.stringify(p.details);if(p.outcomeJson)row.outcome_json=JSON.stringify(p.outcomeJson);};
 const send=async(id,body,opts)=>{if(id==='DOWNER'){effects.owner.push(body);return {ok:true,ts:'notice.ts'};}effects.sends.push({id,body,opts});if(o.pauseSend)await o.pauseSend();if(delivery==='throw')throw Error('connection lost after post');return delivery==='failed'?{ok:false,reason:'not_in_channel'}:delivery==='unknown'?{ok:false,reason:'error'}:{ok:true,ref:'DPAUL',ts:'sent.ts'};};
 const conn={sendDirect:send,postToChannel:send};
 const db={getRequest:id=>id===row.id?row:o.parents?.[id]||null,getChildRequests:()=>[],getDueRequests:()=>[clone(row)],updateRequest:update,getAwaitingOwnerRequests:()=>[row],isKnownRequestThreadAnchor:()=>true,getRequestByIdempotencyKey:()=>null,buildIdempotencyKey:()=> 'fixture',createRequest:()=>row};
 const mocks={
  'src/utils/attendeeAvailability.ts':{loadAttendeeAvailabilityForPerson:(person,fallback)=>({timezone:person?.timezone||fallback}),attendeeTzForDay:entry=>entry.timezone},
  'src/db/requests.ts':db,'src/db/client.ts':{getDb:()=>({prepare:()=>({run(){},all:()=>[]})})},
  'src/db/conversations.ts':{appendToConversation:(...a)=>effects.history.push(a),getConversationHistory:()=>[]},
  'src/db/jobs.ts':{createOutreachJob:p=>effects.outbound.push(p),getOutreachJobByRequestId:()=>null},
  'src/db/people.ts':{getPersonMemory:()=>({timezone:'UTC'}),resolveOutboundLanguageForPerson:()=>o.lang||'en',findPersistentUnaskedTimezoneDivergences:()=>[]},
  'src/connections/registry.ts':{getConnection:()=>delivery==='absent'?undefined:conn},
  'src/utils/ownerDailyThread.ts':{getOrCreateOwnerDailyThread:async()=>({channel:'DOWNER',rootTs:'daily.root'}),postOwnerDecision:async({text})=>{effects.owner.push(text);return {ok:!o.ownerPostFail,channel:'DOWNER',threadTs:'owner.root',ts:'owner.msg'};}},
  'src/utils/workHours.ts':{workTimeBaseFromNow:()=>DateTime.now().toISO(),addWorkdays:()=>DateTime.now().plus({days:2}).toISO()},
  'src/utils/responseDeadline.ts':{},'src/utils/workingElsewhere.ts':{getTravelContextForInstant:()=>undefined},
  'src/core/requests/logActivity.ts':{logActivity(){}},'src/core/requests/colleagueOofReengage.ts':{},
  'src/utils/shadowNotify.ts':{shadowNotify:async()=>{}},
  'src/skills/registry.ts':{executeApprovedSkillTool:async(tool,args,context)=>{effects.executes.push({tool,args,context});return o.execution||{status:'completed',result:{success:true,meetingId:'event'}};}},
  'src/connectors/graph/calendarReads.ts':{verifyApprovedCalendarAction:async()=>{effects.checks++;return o.verification||{status:'unavailable',reason:'missing_exact_event_id'};}},
  'src/utils/logger.ts':{__esModule:true,default:{warn(){},info(){},error(){},debug(){}}},
  'src/llm/client.ts':{getAnthropicClient:()=>({messages:{create:async()=>({content:[{type:'text',text:''}]})}})},'src/llm/models.ts':{MODEL_HAIKU:'fixture'},'src/utils/usageLog.ts':{},'src/tasks/briefs.ts':{},'src/utils/requestDedup.ts':{},'src/utils/closeLoopOnOwnerHandled.ts':{},'src/db.ts':{},
 };
 const actual=new Set(['src/utils/timezoneConvert.ts','src/utils/weTimeResolver.ts','src/core/requests/resolver.ts','src/core/requests/deferredActionReplay.ts','src/core/requests/requesterRelay.ts','src/core/requests/closeRequest.ts','src/core/requests/runner.ts','src/core/requests/types.ts','src/core/approvals/approvalCallbacks.ts','src/tasks/skill.ts','src/utils/textScrubber.ts']);
 function load(file){if(Object.hasOwn(mocks,file))return mocks[file];if(mods.has(file))return mods.get(file).exports;if(!actual.has(file)){effects.unexpected.push(file);throw Error('Unmocked '+file);}const selected=path.join(source,file),name=fs.existsSync(selected)?selected:path.join(root,file);if(!cache.has(name))cache.set(name,ts.transpileModule(fs.readFileSync(name,'utf8'),{fileName:name,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);const m={exports:{}};mods.set(file,m);const req=spec=>{if(spec==='luxon')return {DateTime};if(['node:async_hooks','node:util','node:crypto'].includes(spec))return require(spec);if(!spec.startsWith('.')){effects.unexpected.push(spec);throw Error('Unmocked '+spec);}return load(path.posix.normalize(path.posix.join(path.posix.dirname(file),spec))+'.ts');};vm.runInNewContext('(function(require,module,exports){'+cache.get(name)+'\n})',{Date,Set,Map,setImmediate})(req,m,m.exports);return m.exports;}
 const resolver=load('src/core/requests/resolver.ts'),relay=load('src/core/requests/requesterRelay.ts'),runner=load('src/core/requests/runner.ts');
 return {notify:()=>resolver.notifyRequesterOfDecision(row,'reject',null,undefined,{profile}),effects,row:()=>row,update,setDelivery:x=>delivery=x,check:()=>assert.deepEqual(effects.unexpected,[]),lock:resolver.withRequestLock,
  resolve:(verdict={verdict:'approve'},ctx={})=>resolver.resolveRequest(row.id,verdict,{profile,...ctx}),
  sweep:()=>runner.sweepDueRequests({profilesByUserId:new Map([['OWNER',profile]])}),
  relay:body=>relay.relayClosureToRequester({row,profile,label:'fixture closure',compose:()=>body}),
  ask:()=>load('src/core/approvals/approvalCallbacks.ts').composeOwnerAskText({requestId:row.id,profile,askText:row.description,details:JSON.parse(row.details_json)}),
  tools:()=>new(load('src/tasks/skill.ts').TasksSkill)().getTools(profile),
 };
}
function due(h){h.update(h.row().id,{nextCheckAt:'2026-01-01T00:00:00Z'});}
test('resolver MPIM and fallback count two deliveries then final retry exhausts',async()=>{const h=harness({delivery:'failed',row:{origin_is_mpim:1,origin_channel:'CROOM'}});await h.resolve();assert.equal(h.effects.sends.length,2);assert.equal(JSON.parse(h.row().outcome_json).requester_relay.send_attempts,2);due(h);await h.sweep();assert.equal(h.effects.sends.length,3);assert.equal(h.effects.owner.length,1);assert.equal(h.row().next_check_handler,null);await h.notify();assert.equal(h.effects.sends.length,3);h.check();});
test('resolver cannot fallback after its third failed transport attempt',async()=>{const h=harness({delivery:'failed',row:{state:'resolved',origin_is_mpim:1,origin_channel:'CROOM',outcome_json:JSON.stringify({requester_relay:{body:'Original outcome',delivery:'failed',send_attempts:2}})}});await h.notify();assert.equal(h.effects.sends.length,1);assert.equal(JSON.parse(h.row().outcome_json).requester_relay.delivery,'exhausted');due(h);await h.sweep();assert.equal(h.effects.sends.length,1);assert.equal(h.effects.owner.length,1);h.check();});
test('control resolver unknown room outcome never falls back or repeats',async()=>{const h=harness({delivery:'unknown',row:{origin_is_mpim:1,origin_channel:'CROOM'}});await h.resolve();assert.equal(h.effects.sends.length,1);await h.sweep();assert.equal(h.effects.sends.length,1);assert.equal(JSON.parse(h.row().outcome_json).requester_relay.delivery,'unconfirmed');h.check();});
test('resolver direct reentry respects durable unknown outcome',async()=>{const h=harness({delivery:'unknown',row:{state:'resolved'}});await h.notify();await h.notify();assert.equal(h.effects.sends.length,1);h.check();});
test('control resolver confirmed delivery stamps once',async()=>{const h=harness();await h.resolve();assert.equal(h.effects.sends.length,1);assert.ok(h.row().requester_notified_at);await h.notify();assert.equal(h.effects.sends.length,1);h.check();});
for(const room of [false,true])test(`resolver ${room?'room':'dm'} reserves third attempt before transport`,async()=>{let release;const pending=new Promise(r=>release=r);const h=harness({delivery:'failed',pauseSend:()=>pending,row:{state:'resolved',origin_is_mpim:room?1:0,origin_channel:room?'CROOM':'DPAUL',outcome_json:JSON.stringify({requester_relay:{body:'Original outcome',delivery:'failed',send_attempts:2}})}});const send=h.notify();for(let i=0;i<20&&h.effects.sends.length===0;i++)await Promise.resolve();const stored=JSON.parse(h.row().outcome_json).requester_relay;release();await send;assert.equal(stored.delivery,'unconfirmed');assert.equal(stored.send_attempts,3);assert.equal(h.effects.sends.length,1);h.check();});
