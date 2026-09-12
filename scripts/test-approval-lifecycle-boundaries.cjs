const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {DateTime}=require('luxon'),Database=require('better-sqlite3');
const root=path.resolve(__dirname,'..'),source=process.env.MAELLE_SPINE_SOURCE_ROOT||root;
function compile(file,mocks){mocks['../core/requests/activityRevertibility']={ACTIVITY_REVERTIBILITY:{}};const m={exports:{}},code=ts.transpileModule(fs.readFileSync(path.join(source,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Date,Set,Map})(name=>{if(Object.hasOwn(mocks,name))return mocks[name];throw Error('Unmocked '+name);},m,m.exports);return m.exports;}
const log={__esModule:true,default:{warn(){},info(){},error(){}}};
for(const method of ['getOpenRequestsForOwner','getAwaitingOwnerRequests','getRequestsForBrief','getOpenScannerItems'])test('repeat approval remains visible in '+method,()=>{
 const db=new Database(':memory:');try{
 db.exec("CREATE TABLE requests(id TEXT,owner_user_id TEXT,parent_request_id TEXT,kind TEXT,state TEXT,last_surfaced_at TEXT,informed INTEGER,created_at TEXT,updated_at TEXT)");
 const put=db.prepare("INSERT INTO requests VALUES(?,?,'old_refusal',?,'awaiting_owner',NULL,1,datetime('now'),datetime('now'))");put.run('repeat','OWNER','approval');put.run('child','OWNER','outreach');put.run('other','OTHER','approval');
 const requests=compile('src/db/requests.ts',{crypto:require('node:crypto'),luxon:{DateTime},'./client':{getDb:()=>db},'../core/requests/types':{APPROVAL_SUBKINDS:[]},'../core/requests/activityRevertibility':{},'../utils/logger':log});
 assert.deepEqual(requests[method]('OWNER','2099-01-01T00:00:00Z').map(r=>r.id),['repeat']);
 }finally{db.close();}
});
test('legitimate top-level approval remains visible to owner',()=>{
 const db=new Database(':memory:');try{db.exec("CREATE TABLE requests(id TEXT,owner_user_id TEXT,parent_request_id TEXT,kind TEXT,state TEXT,created_at TEXT);INSERT INTO requests VALUES('top','OWNER',NULL,'approval','awaiting_owner','2026-09-11')");const requests=compile('src/db/requests.ts',{crypto:require('node:crypto'),luxon:{DateTime},'./client':{getDb:()=>db},'../core/requests/types':{},'../core/requests/activityRevertibility':{},'../utils/logger':log});assert.equal(requests.getAwaitingOwnerRequests('OWNER')[0].id,'top');}finally{db.close();}
});
for(const scenario of ['terminal','changed','legitimate'])test('owner-handled scanner '+scenario+' snapshot',async()=>{
 const row={id:'req_scan',kind:'approval',state:'awaiting_owner',owner_user_id:'OWNER',subject:'QBR review',target_name:'Paul',updated_at:'same-second',details_json:'{}'};let fresh=row,closed=0,relayed=0;
 const create=async()=>{if(scenario==='terminal')fresh={...row,state:'resolved'};if(scenario==='changed')fresh={...row,subject:'Private changed ask'};return {content:[{type:'text',text:JSON.stringify({closed_items:[{id:row.id,reason:'owner handled'}]})}]};};
 const scanner=compile('src/utils/closeLoopOnOwnerHandled.ts',{'@anthropic-ai/sdk':{},'../llm/client':{getAnthropicClient:()=>({messages:{create}})},'../llm/models':{},'../db/requests':{getOpenScannerItems:()=>[row],getRequest:()=>fresh},'../core/requests/closeRequest':{closeRequest:()=>closed++},'../core/requests/resolver':{notifyRequesterOfDecision:async()=>relayed++,withRequestLock:async(id,work)=>work()},'../core/requests/types':{parseDetails:r=>JSON.parse(r.details_json)},'./logger':log,'./usageLog':{logLlmUsage(){}},'./extractJson':{parseFirstJsonObject:JSON.parse}});
 await scanner.closeLoopOnOwnerHandled({profile:{user:{slack_user_id:'OWNER'}},ownerMessage:'I handled QBR review with Paul'});assert.equal(closed,scenario==='legitimate'?1:0);assert.equal(relayed,scenario==='legitimate'?1:0);
});
for(const kind of ['reschedule','oof'])for(const nudged of [false,true])test('R4 '+kind+' checking '+(nudged?'after sole nudge preserves expiry':'first reply keeps one reask'),async()=>{
 const row={id:'req_follow',state:'awaiting_colleague',phase:nudged?'outreach:nudged':'outreach:awaiting_reply',next_check_at:'2026-10-01T00:00:00Z',next_check_handler:'outreach_expiry'};
 const prefix=kind==='reschedule'?'../':'../../',m={'@anthropic-ai/sdk':{},luxon:{DateTime}};
 const put=(file,value)=>m[prefix+file]=value;
 put('llm/client',{getAnthropicClient:()=>({messages:{create:async()=>({content:[{type:'text',text:'{"status":"checking"}'}]})}})});put('llm/models',{});
 put('db/requests',{getRequest:()=>row,updateRequest:(id,p)=>{if(p.nextCheckAt!==undefined)row.next_check_at=p.nextCheckAt;if(p.nextCheckHandler!==undefined)row.next_check_handler=p.nextCheckHandler;if(p.phase!==undefined)row.phase=p.phase;}});
 put('db/jobs',{updateOutreachJob(){}});put('db',{appendToConversation(){}});put('db/people',{});put('utils/attendeeAvailability',{loadAttendeeAvailabilityForPerson:(person,fallback)=>({timezone:person?.timezone||fallback}),attendeeTzForDay:entry=>entry.timezone});put('connectors/graph/calendar',{});put('connectors/graph/calendarReads',{});put('utils/responseDeadline',{});put('utils/scheduleRules',{});put('utils/shadowNotify',{});put('utils/extractJson',{extractFirstJsonObject:x=>x});put('utils/logger',log);
 put('connections/registry',{getConnection:()=>({postToChannel:async()=>({ok:true}),sendDirect:async()=>({ok:true})})});m['./logActivity']={};m['./closeRequest']={};m['./types']={};
 const clocks=compile('src/utils/timezoneConvert.ts',{luxon:{DateTime}});put('utils/timezoneConvert',clocks);put('utils/weTimeResolver',compile('src/utils/weTimeResolver.ts',{luxon:{DateTime},'./timezoneConvert':clocks}));
 const file=kind==='reschedule'?'src/skills/meetingReschedule.ts':'src/core/requests/colleagueOofReengage.ts';const mod=compile(file,m);
 const job={id:'out_test',request_id:row.id,intent:kind==='reschedule'?'meeting_reschedule':'oof_reengage',colleague_name:'Paul',colleague_slack_id:'UPAUL',owner_channel:'DOWNER',context_json:JSON.stringify({meeting_id:'event',meeting_subject:'Meeting',proposed_start:'2026-09-20T10:00:00Z',proposed_end:'2026-09-20T11:00:00Z'})};
 await mod[kind==='reschedule'?'handleRescheduleReply':'handleOofReengageReply']({}, {job,replyText:'בודק',profile:{user:{slack_user_id:'OWNER',name:'Owner',timezone:'UTC'},assistant:{name:'Maelle'}},bot_token:'fixture'});
 assert.equal(row.next_check_handler,nudged?'outreach_expiry':kind==='reschedule'?'reschedule_reask':'oof_reengage_reask');if(nudged)assert.equal(row.next_check_at,'2026-10-01T00:00:00Z');
});
