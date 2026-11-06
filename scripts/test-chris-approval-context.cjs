// Real classifier parser and turn-context producer; provider outputs are isolated
// fixtures. These checks prove provenance and propagation, not LLM judgment.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
let fixtureSource=fs.readFileSync(path.join(__dirname,'test-turn-context-boundaries.cjs'),'utf8')
 .replace("const prefix = 'artifacts/workshop-verification/slack-audit-20260919/handyman';","const prefix = 'artifacts/workshop-verification/chris-build-20261103/handyman-approval';")
 .replace('function fixture(t) {','function fixture(t, extraMocks = {}) {')
 .replace('  const modules = new Map();','  Object.assign(mocks, extraMocks);\n  const modules = new Map();');
if(process.argv.includes('--trace-before')) fixtureSource=fixtureSource
 .replace("const before = process.argv.includes('--before');",'const before = true;')
 .replace('chris-build-20261103/handyman-approval','chris-paper-trace-20261103/repair');
if(process.argv.includes('--compound-before')) fixtureSource=fixtureSource
 .replace("const before = process.argv.includes('--before');",'const before = true;')
 .replace('chris-build-20261103/handyman-approval','chris-paper-trace-20261103/compound-repair');
const fixtureModule={exports:{}};
vm.runInNewContext('(function(require,module,exports,__dirname){'+fixtureSource+'\nmodule.exports={fixture};})',{console,process,Date,Map,Set,Buffer})(name=>name==='node:test'?{test(){}}:require(require.resolve(name,{paths:[__dirname]})),fixtureModule,fixtureModule.exports,__dirname);
const logger={__esModule:true,default:{info(){},warn(){},error(){}}};
const deps={'../../utils/logger':logger,'../../utils/usageLog':{logLlmUsage(){}},'../../db/socialSubjects':{FIXED_CATEGORIES:[]},'../../llm/models':require('./load-test-models.cjs')};
const classifier={exports:{}};
const code=ts.transpileModule(fs.readFileSync(path.join(root,process.argv.includes('--before')?'artifacts/workshop-verification/chris-build-20261103/handyman-approval/before/classifyTurn.ts':'src/core/social/classifyTurn.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{})(name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]},classifier,classifier.exports);
const history=[{role:'user',content:'Please find a meeting with Einav and Oran.',ts:'1'},{role:'assistant',content:'Which day works?',ts:'2'}];
function setup(t,raw, extraMocks={}){
 const requests=[],prechecks=[];
 const anthropic={messages:{create:async p=>{
  requests.push(p);
  return {content:[{type:'tool_use',input:{kind:'task',conversation_state:'open',scopes:['meetings'],meeting_action:'explore',...raw}}]};
 }}};
 const f=fixtureModule.exports.fixture(t,{...extraMocks,'src/core/social/classifyTurn.ts':classifier.exports,'src/llm/client.ts':{getAnthropicClient:()=>anthropic},'src/utils/availabilityPreCheck.ts':{precheckAvailability:async p=>{prechecks.push(p);return {ran:false,verdicts:[]};}}});
 return {...f,requests,prechecks};
}
const canonical = x => JSON.parse(JSON.stringify(x));
const matcher={exports:{}};
const matcherCode=ts.transpileModule(fs.readFileSync(path.join(root,'src/utils/closeLoopOnOwnerHandled.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
vm.runInNewContext('(function(require,module,exports){'+matcherCode+'\n})',{})(name=>name==='../core/requests/types'?{parseDetails:r=>JSON.parse(r.details_json)}:{},matcher,matcher.exports);
// Identity fields and full source reply are retained evidence; callbacks below
// are isolated action fixtures, not a claimed production database export.
const rows = ['Adam','Paul'].map((name,i)=>({id:'req_'+name,kind:'approval',state:'awaiting_owner',owner_user_id:'UOWNER',requester_name:'Chris Kelly',subject:'Idan, Chris and '+name,details_json:JSON.stringify({callbacks:{on_approve:{tool:'create_meeting',args:{subject:'Idan, Chris and '+name,start:i?'2026-11-16T16:30:00':'2026-11-16T15:40:00'}}}})}));
const log=fs.readFileSync(path.join(root,'artifacts/workshop-verification/chris-20261103/live-owner-window.txt'),'utf8').split(/\r?\n/);
const sourceReply=JSON.parse(log[88].slice(log[88].indexOf('{'))).replyPreview;
const adamQuote=sourceReply.slice(sourceReply.indexOf('"Lori'),sourceReply.indexOf(' Your last'));
assert.equal(adamQuote,'"Lori & Idan, Weekly" ends at 15:40, just as the Adam meeting would start.');
const conversation=[{role:'user',content:'Can you check these two requests?'},{role:'assistant',content:sourceReply}];
const message='make one before my meeting with michal and one after lori and then we should be ok';
const decision=(candidateIndex,disposition,sourceQuote)=>({candidateIndex,disposition,instructionQuote:message,sourceMessageIndex:1,sourceQuote});
const accepted=[decision(0,'approve_existing',adamQuote),decision(1,'amend_or_search','Paul')];
function approvalFixture(t,raw,options={}) { let pendingReads=0;
 return setup(t,{meeting_people:[],meeting_action:'execute',...raw},{
  'src/core/orchestrator/systemPrompt.ts':{buildSystemPromptParts:()=>({static:'',dynamic:''})},
  'src/db/requests.ts':{getAwaitingOwnerRequests:()=>options.unavailable && ++pendingReads===1?(()=>{throw Error('unavailable')})():options.rows??rows,getOpenRequestsForThread:()=>[],getUnrelayedTerminalRequestForThread:()=>null,getMeetingsRequestedBy:()=>[]},
  'src/core/requests/types.ts':{parseDetails:r=>JSON.parse(r.details_json)},
  'src/core/approvals/approvalCallbacks.ts':{extractCallbacks:d=>d?.callbacks??{},mergeAmendIntoApprove:(a,c)=>({...a,args:{...a.args,...c}})},
  'src/utils/closeLoopOnOwnerHandled.ts':matcher.exports,
 });
}
test('narrow unique literal quote remains legitimate before and after',async t=>{
 const f=approvalFixture(t,{approval_decisions:[decision(0,'approve_existing','ends at 15:40, just as the Adam meeting would start.')]});
 const r=await f.run({userMessage:message,conversationHistory:conversation});assert.equal(r.contextualApprovalDecisions?.[0]?.requestId,'req_Adam');
});
test('Paul amendment evidence never becomes approval',async t=>{
 const f=approvalFixture(t,{meeting_action:'explore',approval_decisions:[accepted[1]]});
 const r=await f.run({userMessage:message,conversationHistory:conversation});assert.deepEqual(canonical(r.contextualApprovalDecisions).map(d=>d.disposition),['amend_or_search']);
});
test('actual classifier and context preserve explicit pair decision with Paul amendment only',async t=>{
 const f=approvalFixture(t,{approval_decisions:accepted});
 const r=await f.run({userMessage:message,conversationHistory:conversation});
 console.log('classifier system characters='+f.requests[0].system.length+' schema characters='+JSON.stringify(f.requests[0].tools[0].input_schema).length);
 assert.deepEqual(canonical(r.contextualApprovalDecisions).map(x=>[x.requestId,x.disposition]),[['req_Adam','approve_existing'],['req_Paul','amend_or_search']]);
 assert.equal(r.contextualApprovalDecisions[0].requestDetailsJson,rows[0].details_json);
 assert.equal(r.contextualApprovalDecisions[0].action.args.start,'2026-11-16T15:40:00');
 assert.equal(f.requests.length,1);
 const schema=f.requests[0].tools[0].input_schema;assert.ok(schema.required.includes('approval_decisions'));
 assert.equal(schema.properties.approval_decisions.items.additionalProperties,false);

});
test('stored counter supplies actual effective action snapshot',async t=>{
 const changed=structuredClone(rows);const d=JSON.parse(changed[0].details_json);d.counter={start:'2026-11-16T15:50:00'};changed[0].details_json=JSON.stringify(d);
 const f=approvalFixture(t,{approval_decisions:accepted},{rows:changed});const r=await f.run({userMessage:message,conversationHistory:conversation});
 assert.equal(r.contextualApprovalDecisions[0].action.args.start,'2026-11-16T15:50:00');assert.equal(r.contextualApprovalDecisions[0].requestDetailsJson,changed[0].details_json);
});
test('bare yes with two pending requests remains unbound without classifier call',async t=>{
 const f=approvalFixture(t,{approval_decisions:accepted});const r=await f.run({userMessage:'yes',conversationHistory:conversation});
 assert.equal(r.contextualApprovalDecisions,undefined);assert.equal(f.requests.length,0);
});
for(const [label,raw] of [['unknown index',[{...accepted[0],candidateIndex:99}]],['invented instruction',[{...accepted[0],instructionQuote:'approve both'}]],['invented source',[{...accepted[0],sourceQuote:'invented Adam'}]],['duplicate',[accepted[0],accepted[0]]],['invalid disposition',[{...accepted[0],disposition:'approve'}]],['malformed','Adam']]) test(label+' produces no decision evidence',async t=>{
 const f=approvalFixture(t,{approval_decisions:raw});const r=await f.run({userMessage:message,conversationHistory:conversation});assert.ok(!r.contextualApprovalDecisions?.length);
});
for(const extra of [{surface:'room',isMpim:true},{surface:'colleague_dm',authority:'colleague',senderRole:'colleague',userId:'UACTIVE'},{channel:'email'},{interactive:false},{userId:'UACTIVE'}]) test('owner decision data withheld '+JSON.stringify(extra),async t=>{
 const f=approvalFixture(t,{approval_decisions:accepted});const r=await f.run({userMessage:message,conversationHistory:conversation,...extra});assert.ok(!r.contextualApprovalDecisions?.length);
 for(const req of f.requests) assert.ok(!req.system.includes('PENDING MEETING DECISIONS'));
});
test('unavailable pending source cannot create decision evidence',async t=>{const f=approvalFixture(t,{approval_decisions:accepted},{unavailable:true});const r=await f.run({userMessage:message,conversationHistory:conversation});assert.ok(!r.contextualApprovalDecisions?.length);});
test('shared quote cannot uniquely anchor either request',async t=>{const f=approvalFixture(t,{approval_decisions:[decision(0,'approve_existing',conversation[1].content)]});const r=await f.run({userMessage:message,conversationHistory:conversation});assert.ok(!r.contextualApprovalDecisions?.length);});


test('exploratory intent cannot authorize approve despite conflicting decision output',async t=>{const f=approvalFixture(t,{meeting_action:'explore',approval_decisions:accepted});const r=await f.run({userMessage:message,conversationHistory:conversation});assert.ok(!r.contextualApprovalDecisions?.some(x=>x.disposition==='approve_existing'));});
for(const quote of ['Idan','Chris','Idan and Chris','Adam and Paul']) test('actual matcher rejects non-distinctive or conflicting reference: '+quote,async t=>{
 const f=approvalFixture(t,{approval_decisions:[decision(0,'approve_existing',quote)]});
 const r=await f.run({userMessage:message,conversationHistory:[conversation[0],{role:'assistant',content:quote}]});
 assert.ok(!r.contextualApprovalDecisions?.length);
});
test('stale historical source cannot supply current contextual evidence',async t=>{
 const f=approvalFixture(t,{approval_decisions:[accepted[0]]});const r=await f.run({userMessage:message,conversationHistory:[conversation[0],{role:'assistant',content:'No current proposal.'}]});assert.ok(!r.contextualApprovalDecisions?.length);
});
for(const [label,subjects,quote] of [
 ['compound name',['Idan, Chris and Anne-Marie','Idan, Chris and Paul'],'Idan discussed Anne-Marie.'],
 ['Hebrew',['אידן כריס דניאל','אידן כריס מיכאל'],'אידן אישר לדניאל'],
 ['Cyrillic',['Идан Крис Александр','Идан Крис Михаил'],'Идан: Александр'],
]) test('language-neutral distinctive reference '+label,async t=>{
 const candidates=structuredClone(rows);candidates.forEach((r,i)=>r.subject=subjects[i]);
 const f=approvalFixture(t,{approval_decisions:[decision(0,'approve_existing',quote)]},{rows:candidates});
 const r=await f.run({userMessage:message,conversationHistory:[conversation[0],{role:'assistant',content:quote}]});
 assert.equal(r.contextualApprovalDecisions?.[0]?.requestId,'req_Adam');
});
for(const name of ['Anne-Marie','Jean-Luc','Anne–Marie',"O’Connor",'דניאל-כהן','Александр-Иван','.NET','Jean🙂']) {
 for(const selected of [0,1]) test('compound requester conflict preserves both candidates '+name+' selected '+selected,async t=>{
  const candidates=structuredClone(rows); candidates.forEach((r,i)=>{r.subject='Coordination meeting';r.requester_name=i?'Paul':name;const d=JSON.parse(r.details_json);d.callbacks.on_approve.args.subject=r.subject;r.details_json=JSON.stringify(d);});
  const quote='The meeting with '+name+',Paul follows Lori.';
  const f=approvalFixture(t,{approval_decisions:[decision(selected,'approve_existing',quote)]},{rows:candidates});
  const r=await f.run({userMessage:message,conversationHistory:[conversation[0],{role:'assistant',content:quote}]});assert.ok(!r.contextualApprovalDecisions?.length);
 });
 test('complete requester reference with generic subject '+name,async t=>{
  const candidates=structuredClone(rows);candidates.forEach((r,i)=>{r.subject='Coordination meeting';r.requester_name=i?'Paul':name;const d=JSON.parse(r.details_json);d.callbacks.on_approve.args.subject=r.subject;r.details_json=JSON.stringify(d);});
  const quote='The meeting with “'+name+'” follows Lori.';
  const f=approvalFixture(t,{approval_decisions:[decision(0,'approve_existing',quote)]},{rows:candidates});const r=await f.run({userMessage:message,conversationHistory:[conversation[0],{role:'assistant',content:quote}]});assert.equal(r.contextualApprovalDecisions?.[0]?.requestId,'req_Adam');
 });
}
test('punctuation joined shared and distinctive subject names remain attributable',async t=>{
 const quote='Idan,Adam';const f=approvalFixture(t,{approval_decisions:[decision(0,'approve_existing',quote)]});const r=await f.run({userMessage:message,conversationHistory:[conversation[0],{role:'assistant',content:quote}]});assert.equal(r.contextualApprovalDecisions?.[0]?.requestId,'req_Adam');
});
test('later competing requester survives long literal quote',async t=>{
 const candidates=structuredClone(rows);candidates.forEach((r,i)=>{r.subject='Coordination meeting';r.requester_name=i?'Paul':'Anne-Marie';});
 const quote='Anne-Marie '+('x,'.repeat(3000))+' Paul';const f=approvalFixture(t,{approval_decisions:[decision(1,'approve_existing',quote)]},{rows:candidates});const r=await f.run({userMessage:message,conversationHistory:[conversation[0],{role:'assistant',content:quote}]});assert.ok(!r.contextualApprovalDecisions?.length);
});
