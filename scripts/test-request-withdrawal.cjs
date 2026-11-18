// Execute the real locked withdrawal branch; only persistence/transport are fixtures.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),ts=require('typescript');
const root='src/core/orchestrator/';
const row={id:'req_own',kind:'approval',subkind:'policy_exception',state:'awaiting_owner',
 owner_user_id:'UOWNER',requester_slack_id:'UPEER',origin_channel:'DPEER',origin_thread_ts:'thread',
 details_json:JSON.stringify({deferred_action:{tool:'create_meeting',args:{}}})};
function predicate(){
 const exports={};const code=ts.transpileModule(fs.readFileSync(root+'requesterMeetingState.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('exports','require',code)(exports,name=>name==='../requests/types'?{parseDetails:r=>JSON.parse(r.details_json??'{}')}:{});return exports.canWithdrawOwnRequest;
}
async function run(change={},inputChange={}){
 const source=fs.readFileSync(process.env.WITHDRAW_BEFORE_PATH||root+'index.ts','utf8');
 const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);let branch,guard='';
 function visit(n){if(ts.isIfStatement(n)&&n.expression.getText(ast)==='withdrawalId')branch=n.getText(ast);
  if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)==='assertTurnActive'))guard=n.getText(ast);
  ts.forEachChild(n,visit)}visit(ast);assert.ok(branch);
 const state={row:{...row,...change},closed:[],writes:[],locked:[]};
 const deps={
  '../requests/resolver':{withRequestLock:async(id,fn)=>{state.locked.push(id);await inputChange.beforeLock?.();return fn();}},
  '../../db/requests':{getRequest:()=>state.row},
  '../requests/closeRequest':{closeRequest:value=>{state.closed.push(value);inputChange.onClose?.(value);state.row.state=value.state;return {ok:true};}},
  './requesterMeetingState':{canWithdrawOwnRequest:predicate()},
 };
 const code=ts.transpileModule('async function execute(){'+guard+branch+'}\nmodule.exports=execute;',
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 new Function('require','module','withdrawalId','profile','input','threadTs','localizedFallback','__importStar','meetingRequest',code)(
  name=>{assert.ok(deps[name],name);return deps[name]},module,row.id,{user:{slack_user_id:'UOWNER'}},
  {userId:'UPEER',channelId:'DPEER',userMessage:'Cancel my request',onWriteExecuted:n=>state.writes.push(n),...inputChange},
  'thread',(_,choices)=>choices.en,value=>value,inputChange.meetingRequest);
 state.reply=await module.exports();return state;
}
for(const subkind of ['policy_exception','freeform'])test(`requester withdraws own pending ${subkind} without calendar execution`,async()=>{
 const state=await run({subkind});assert.equal(state.closed.length,1);assert.equal(state.row.state,'cancelled');
 assert.deepEqual(state.writes,['withdraw_request']);assert.deepEqual(state.locked,['req_own']);
 assert.match(state.reply.toolSummaries[0],/withdraw_request OK/);
 assert.match(state.reply.reply,/request/);
});
test('legacy organizer attendance withdrawal remains supported',async()=>{
 const state=await run({subkind:'freeform',details_json:'{"organizer_invitation":true}'});assert.equal(state.closed.length,1);
});
for(const change of [{state:'in_flight'},{state:'resolved'},{state:'cancelled'},{state:'awaiting_colleague'},
 {owner_user_id:'UOTHER'},{requester_slack_id:'UOTHER'},{origin_channel:'DOTHER'},{origin_thread_ts:'other'},
 {kind:'outreach'}])test('withdrawal refuses non-owned or non-pending request '+JSON.stringify(change),async()=>{
 const state=await run(change);assert.equal(state.closed.length,0);assert.equal(state.reply,undefined);assert.deepEqual(state.writes,[]);
});
test('room and owner identity cannot use requester withdrawal',async()=>{
 for(const [change,input] of [[{origin_channel:'CROOM'},{channelId:'CROOM'}],[{requester_slack_id:'UOWNER'},{userId:'UOWNER'}]]){
  const state=await run(change,input);assert.equal(state.closed.length,0);
 }
});
test('a repeated withdrawal cannot run again after closure',async()=>{
 const first=await run();const second=await run(first.row);assert.equal(second.closed.length,0);assert.equal(second.reply,undefined);
});
for(const active of ['marketing','linkedin'])test('withdrawal is bound to the selected conversation request: '+active,async()=>{
 const state=await run({details_json:JSON.stringify({meeting_request_id:'linkedin'})},{meetingRequest:{requestId:active}});
 assert.equal(state.closed.length,active==='linkedin'?1:0);
});

test('superseded withdrawal waiting on the request lock cannot close work',async()=>{
 const controller=new AbortController(),closed=[],writes=[];
 await assert.rejects(run({}, {signal:controller.signal,beforeLock:async()=>{await Promise.resolve();controller.abort();},
  onClose:value=>closed.push(value),onWriteExecuted:name=>writes.push(name)}),{name:'AbortError'});
 assert.deepEqual(closed,[]);assert.deepEqual(writes,[]);
});
