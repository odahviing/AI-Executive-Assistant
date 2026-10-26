// Real classifier parser and turn-context producer; provider outputs are isolated
// fixtures. These checks prove provenance and propagation, not LLM judgment.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
let fixtureSource=fs.readFileSync(path.join(__dirname,'test-turn-context-boundaries.cjs'),'utf8')
 .replace("const prefix = 'artifacts/workshop-verification/slack-audit-20260919/handyman';","const prefix = 'artifacts/workshop-verification/opportunities-20261026/handyman/continuity';")
 .replace('function fixture(t) {','function fixture(t, extraMocks = {}) {')
 .replace('  const modules = new Map();','  Object.assign(mocks, extraMocks);\n  const modules = new Map();');
const fixtureModule={exports:{}};
vm.runInNewContext('(function(require,module,exports,__dirname){'+fixtureSource+'\nmodule.exports={fixture};})',{console,process,Date,Map,Set,Buffer})(name=>name==='node:test'?{test(){}}:require(require.resolve(name,{paths:[__dirname]})),fixtureModule,fixtureModule.exports,__dirname);
const logger={__esModule:true,default:{info(){},warn(){},error(){}}};
const deps={'../../utils/logger':logger,'../../utils/usageLog':{logLlmUsage(){}},'../../db/socialSubjects':{FIXED_CATEGORIES:[]},'../../llm/models':require('./load-test-models.cjs')};
const classifier={exports:{}};
const code=ts.transpileModule(fs.readFileSync(path.join(root,'src/core/social/classifyTurn.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{})(name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]},classifier,classifier.exports);
const history=[{role:'user',content:'Please find a meeting with Einav and Oran.',ts:'1'},{role:'assistant',content:'Which day works?',ts:'2'}];
function setup(t,raw){
 const requests=[],prechecks=[];
 const anthropic={messages:{create:async p=>{
  requests.push(p);
  return {content:[{type:'tool_use',input:{kind:'task',conversation_state:'open',scopes:['meetings'],meeting_action:'explore',...raw}}]};
 }}};
 const f=fixtureModule.exports.fixture(t,{'src/core/social/classifyTurn.ts':classifier.exports,'src/llm/client.ts':{getAnthropicClient:()=>anthropic},'src/utils/availabilityPreCheck.ts':{precheckAvailability:async p=>{prechecks.push(p);return {ran:false,verdicts:[]};}}});
 return {...f,requests,prechecks};
}
const contextPeople=[{name:'Einav',sourceMessageIndex:0},{name:'Oran',sourceMessageIndex:0}];
for(const role of ['owner','colleague']) test(`${role} DM continuation retains full prior roster despite nameless day reply`,async t=>{
 const f=setup(t,{meeting_people:['Einav'],meeting_continuation:true,context_meeting_people:contextPeople});
 const r=await f.run({userMessage:'Wednesday all day is good',conversationHistory:history,senderRole:role,authority:role,userId:role==='owner'?'UOWNER':'UACTIVE',surface:role==='owner'?'owner_dm':'colleague_dm'});
 assert.deepEqual(Array.from(r.resolvedMeetingAttendees),['einav@example.test','oran@example.test']);
 assert.equal(f.requests.length,1,'no additional classifier call');
 if(role==='colleague') assert.equal(f.prechecks[0].namedAttendeeEmails.length,0,'history roster must not suppress current owner-calendar precheck');
 assert.ok(r.prompt.includes('einav@example.test'));assert.ok(r.prompt.includes('oran@example.test'));
});
for(const [name,raw,expected] of [
 ['new task',{meeting_people:['Levana'],meeting_continuation:false,context_meeting_people:contextPeople},['levana@example.test']],
 ['removed participant',{meeting_people:[],meeting_continuation:true,context_meeting_people:[contextPeople[1]]},['oran@example.test']],
 ['unavailable classification',{meeting_people:[]},[]],
 ['assistant source',{meeting_people:[],meeting_continuation:true,context_meeting_people:[{name:'Which',sourceMessageIndex:1}]},[]],
 ['invented person',{meeting_people:[],meeting_continuation:true,context_meeting_people:[{name:'Dana',sourceMessageIndex:0}]},[]],
 ['invalid source',{meeting_people:[],meeting_continuation:true,context_meeting_people:[{name:'Einav',sourceMessageIndex:99}]},[]],
 ]) test(`${name} respects classified roster and provenance`,async t=>{
 const f=setup(t,raw);const r=await f.run({userMessage:name==='new task'?'Arrange a new meeting with Levana.':'Please show the next options.',conversationHistory:history,senderRole:'colleague',authority:'colleague',userId:'UACTIVE',surface:'colleague_dm'});
 assert.deepEqual(Array.from(r.resolvedMeetingAttendees),expected);
 if(name==='new task') assert.deepEqual(Array.from(f.prechecks[0].namedAttendeeEmails),['levana@example.test'],'current explicit person still owns the precheck bail');
});
for(const overrides of [{isMpim:true,surface:'room'},{isChannel:true,surface:'room'},{channel:'email'},{surface:undefined}]) test(`history continuity withheld on ${JSON.stringify(overrides)}`,async t=>{
 const f=setup(t,{meeting_people:[],meeting_continuation:true,context_meeting_people:contextPeople});
 const r=await f.run({userMessage:'Wednesday all day is good',conversationHistory:history,...overrides});
 assert.equal(r.resolvedMeetingAttendees.length,0);
});
test('fresh/restarted conversation cannot resurrect absent source',async t=>{
 const f=setup(t,{meeting_people:[],meeting_continuation:true,context_meeting_people:contextPeople});
 const r=await f.run({userMessage:'Wednesday all day is good',conversationHistory:[]});assert.equal(r.resolvedMeetingAttendees.length,0);
});
test('actual scheduling handler unions core roster with partial model arguments before availability load',async t=>{
 const f=setup(t,{meeting_people:[],meeting_continuation:true,context_meeting_people:contextPeople});
 const turn=await f.run({userMessage:'Wednesday all day is good',conversationHistory:history});
 const handlerFile=path.join(__dirname,'test-email-mechanics-integration.cjs');
 let source=fs.readFileSync(handlerFile,'utf8').split("test('regression full handler")[0];
 source=source.replace('async function run({channel=', 'async function run({resolvedMeetingAttendees,channel=')
  .replace("const context={profile:h.profile,channel,",'const context={resolvedMeetingAttendees,profile:h.profile,channel,')
  .replace('const args={search_from:',"const args={attendee_emails:['oran@example.test'],search_from:")
  .replace('loadAttendeeAvailabilityForEmails:()=>[]','loadAttendeeAvailabilityForEmails:(emails)=>{observed.push(Array.from(emails));return [];}');
 const observed=[],mod={exports:{}};
 vm.runInNewContext(source+'\nmodule.exports=run;',{require:require('node:module').createRequire(handlerFile),module:mod,exports:mod.exports,__dirname,process,console,Date,Buffer,setTimeout,clearTimeout,observed});
 const result=await mod.exports({resolvedMeetingAttendees:Array.from(turn.resolvedMeetingAttendees),clean:true,relaxed:false});
 assert.equal(result.warnings.length,0,JSON.stringify(result.warnings));
 assert.ok(observed.some(emails=>emails.includes('einav@example.test')&&emails.includes('oran@example.test')),JSON.stringify(observed));
});
