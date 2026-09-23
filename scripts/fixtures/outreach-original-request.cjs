// Actual outreach, SQL request/payload stores, closure, scheduled runner and
// resolver lock. Transport, people/time and unrelated services are fixtures.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const Database=require('better-sqlite3'),{DateTime}=require('luxon'),{AsyncLocalStorage}=require('node:async_hooks');
const root=path.resolve(__dirname,'../..'),source=process.env.OUTREACH_ORIGINAL_SOURCE_ROOT||root;
function fixture(o={}){
 const db=new Database(':memory:');
 const schema=fs.readFileSync(path.join(root,'src/db/client.ts'),'utf8');
 for(const name of ['requests','outreach_jobs'])db.exec(schema.match(new RegExp('CREATE TABLE IF NOT EXISTS '+name+' \\([\\s\\S]*?\\n    \\);'))[0]);
 db.exec('ALTER TABLE requests ADD COLUMN phase TEXT;ALTER TABLE requests ADD COLUMN requester_notified_at TEXT;CREATE TABLE audit_log(owner_user_id,action,source,actor,target,details,outcome);CREATE TABLE people_memory(slack_id,name,interaction_log)');
 for(const field of ['scheduled_at','conversation_json','intent','context_json','proposed_slots','subject_keyword','dm_message_ts','dm_channel_id','followup_closed_at','followup_close_reason','request_id'])db.exec('ALTER TABLE outreach_jobs ADD COLUMN '+field+' TEXT');
 const profile={user:{slack_user_id:'OWNER',name:'Owner',email:'owner@example.com',timezone:'UTC'},assistant:{name:'Maelle'}};
 const effects={sends:[],unexpected:[]};
 const send=async(id,body,opts)=>{effects.sends.push({id,body,opts});if(o.onSend)await o.onSend();if(o.mode==='throw')throw Error('unknown');return o.mode==='unknown'?{ok:false,reason:'error'}:o.mode==='failed'?{ok:false,reason:'not_attempted'}:{ok:true,ref:id.startsWith('C')?id:'DCOLLEAGUE',ts:'sent.1'};};
 const noop=()=>{};
 // Extract the actual lock and its private state, excluding resolver side effects.
 const resolver=fs.readFileSync(path.join(root,'src/core/requests/resolver.ts'),'utf8'),ast=ts.createSourceFile('resolver.ts',resolver,ts.ScriptTarget.Latest,true);
 const lockSource=ast.statements.filter(n=>(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>['resolveQueue','heldRequests','waitingRequests'].includes(d.name.getText())))||(ts.isFunctionDeclaration(n)&&['reachesRequest','withRequestLock'].includes(n.name?.getText()))).map(n=>n.getText()).join('\n');
 const compile=(text,deps={},globals={})=>{const m={exports:{}};vm.runInNewContext(ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{module:m,exports:m.exports,require:s=>deps[s]??require(s),...globals});return m.exports;};
 let lock=compile(lockSource,{}, {AsyncLocalStorage});
 const mocks={
  'src/db/client.ts':{getDb:()=>db},'src/db/conversations.ts':{getConversationHistory:()=>[],appendToConversation:noop},
  'src/db/people.ts':{getPersonMemory:()=>({name:'Colleague',timezone:'UTC'})},
  'src/core/requests/logActivity.ts':{logActivity:noop},'src/core/requests/activityRevertibility.ts':{ACTIVITY_REVERTIBILITY:{}},
  'src/core/requests/requesterRelay.ts':{relayClosureToRequester:async()=>true},'src/core/requests/colleagueOofReengage.ts':{},
  'src/tasks/briefs.ts':{},'src/utils/closeLoopOnOwnerHandled.ts':{},'src/utils/usageLog.ts':{},
  'src/core/approvals/approvalCallbacks.ts':{},'src/llm/client.ts':{},'src/llm/models.ts':{},
  'src/connections/registry.ts':{getConnection:()=>o.noConnection?undefined:{sendDirect:send,postToChannel:send}},
  'src/utils/ownerDailyThread.ts':{postOwnerDecision:async()=>({ok:true})},
  'src/utils/responseDeadline.ts':{calcResponseDeadline:()=>DateTime.now().plus({days:1}).toISO(),colleagueWorkTimeBaseFromNow:(_tz,n)=>new Date(n).toISOString(),isColleagueSendDeferred:()=>o.heldUntil?{deferred:true,deferredTo:o.heldUntil}:{deferred:false}},
  'src/utils/attendeeAvailability.ts':{},'src/utils/workHours.ts':{},'src/utils/timezoneConvert.ts':{},
  'src/utils/weTimeResolver.ts':{StatedTimeClarificationError:class extends Error{},resolveStatedInstant:p=>({startIso:p.startIso,endIso:p.endIso})},
  'src/utils/logger.ts':{__esModule:true,default:{info:noop,warn:noop,error:noop,debug:noop}},
  'src/utils/shadowNotify.ts':{shadowNotify:async()=>{}},'src/utils/threadActivity.ts':{reactActivityComplete:async()=>{}},
  'src/utils/resolveSlackId.ts':{resolveSlackId:id=>({slack_id:id})},
 };
 const modules=new Map(),actual=new Set(['src/skills/outreach.ts','src/db/jobs.ts','src/db/requests.ts','src/core/requests/closeRequest.ts','src/core/requests/types.ts','src/core/requests/runner.ts']);
 function load(file){
  if(file==='src/db.ts')return {...load('src/db/jobs.ts'),getPersonMemory:()=>({name:'Colleague'}),upsertPersonMemory:noop};
  if(file==='src/core/requests/resolver.ts')return lock;
  if(mocks[file])return mocks[file];if(modules.has(file))return modules.get(file).exports;if(!actual.has(file)){effects.unexpected.push(file);throw Error('unmocked '+file);}
  const filename=fs.existsSync(path.join(source,file))?path.join(source,file):path.join(root,file);
  const text=fs.readFileSync(filename,'utf8')+(file==='src/core/requests/runner.ts'?'\nexport { runSendScheduledOutreach };':'');
  const m={exports:{}};modules.set(file,m);vm.runInNewContext('(function(require,module,exports){'+ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+'\n})',{Date,Map,Set,Buffer,Promise,Error,JSON})(spec=>spec==='luxon'?{DateTime}:spec==='crypto'||spec.startsWith('node:')?require(spec):load(path.posix.normalize(path.posix.join(path.posix.dirname(file),spec))+'.ts'),m,m.exports);return m.exports;
 }
 const reqs=load('src/db/requests.ts'),jobs=load('src/db/jobs.ts');
 return {db,effects,profile,reqs,jobs,load,options:o,
  tool:(args={},ctx={})=>new (load('src/skills/outreach.ts').OutreachCoreSkill)().executeToolCall('message_colleague',{colleague_slack_id:'COLLEAGUE',colleague_name:'Colleague',message:'Original exact message',await_reply:false,...args},{profile,userId:'OWNER',authority:'owner',surface:'owner_dm',senderRole:'owner',channel:'slack',channelId:'DOWNER',threadTs:'owner.1',...ctx}),
  job:()=>db.prepare('SELECT * FROM outreach_jobs ORDER BY rowid DESC LIMIT 1').get(),rows:()=>db.prepare('SELECT * FROM requests ORDER BY rowid').all(),
  fire:id=>lock.withRequestLock(id,()=>load('src/core/requests/runner.ts').runSendScheduledOutreach(reqs.getRequest(id),profile)),
  restart:()=>{modules.clear();lock=compile(lockSource,{}, {AsyncLocalStorage});},
 };
}
module.exports={fixture};
