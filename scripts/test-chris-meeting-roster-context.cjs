// Real classifier parser and turn-context producer; provider outputs are isolated
// fixtures. These checks prove provenance and propagation, not LLM judgment.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
let fixtureSource=fs.readFileSync(path.join(__dirname,'test-turn-context-boundaries.cjs'),'utf8')
 .replace("const prefix = 'artifacts/workshop-verification/slack-audit-20260919/handyman';","const prefix = 'artifacts/workshop-verification/chris-build-20261103/handyman';")
 .replace('function fixture(t) {','function fixture(t, extraMocks = {}) {')
 .replace('  const modules = new Map();','  Object.assign(mocks, extraMocks);\n  const modules = new Map();');
const fixtureModule={exports:{}};
vm.runInNewContext('(function(require,module,exports,__dirname){'+fixtureSource+'\nmodule.exports={fixture};})',{console,process,Date,Map,Set,Buffer})(name=>name==='node:test'?{test(){}}:require(require.resolve(name,{paths:[__dirname]})),fixtureModule,fixtureModule.exports,__dirname);
const logger={__esModule:true,default:{info(){},warn(){},error(){}}};
const deps={'../../utils/logger':logger,'../../utils/usageLog':{logLlmUsage(){}},'../../db/socialSubjects':{FIXED_CATEGORIES:[]},'../../llm/models':require('./load-test-models.cjs')};
const classifier={exports:{}};
const code=ts.transpileModule(fs.readFileSync(path.join(root,process.argv.includes('--before')?'artifacts/workshop-verification/chris-build-20261103/handyman/before/classifyTurn.ts':'src/core/social/classifyTurn.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
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
const canonical = groups => JSON.parse(JSON.stringify(groups));
const groups = rosters => rosters.map(emails => ({ emails, unresolvedNames: [] }));
test('separate meeting rosters survive existing classifier and context producer',async t=>{
 const f=setup(t,{meeting_people:['Adam','Paul','Scott'],meeting_people_groups:[['Adam'],['Paul'],['Scott']]});
 const r=await f.run({userMessage:'Find separate meetings with Adam, Paul and Scott.'});
 assert.deepEqual(canonical(r.resolvedMeetingAttendeeGroups),groups([['adam@example.test'],['paul@example.test'],['scott@example.test']]));
 assert.equal(f.requests.length,1);
 const schema=f.requests[0].tools[0].input_schema;
 assert.ok(schema.required.includes('meeting_people_groups'));
 assert.equal(schema.properties.meeting_people_groups.items.items.type,'string');
});
test('legacy single meeting retains known omitted attendees',async t=>{
 const f=setup(t,{meeting_people:['Adam','Paul']});
 const r=await f.run({userMessage:'Find a meeting with Adam and Paul.'});
 assert.deepEqual(Array.from(r.resolvedMeetingAttendees),['adam@example.test','paul@example.test']);
 assert.equal(r.resolvedMeetingAttendeeGroups,undefined);
});
for(const [name,groups] of [['incomplete',[['Adam']]],['uncertain',[]],['malformed',[7]]]) test(name+' grouping retains known roster but marks scope ambiguous',async t=>{
 const f=setup(t,{meeting_people:['Adam','Paul'],meeting_people_groups:groups});
 const r=await f.run({userMessage:'Find meetings with Adam and Paul.'});
 assert.deepEqual(Array.from(r.resolvedMeetingAttendees),['adam@example.test','paul@example.test']);
 assert.deepEqual(canonical(r.resolvedMeetingAttendeeGroups),[]);
});
test('group membership cannot bypass raw-message provenance',async t=>{
 const f=setup(t,{meeting_people:['Adam','Secret'],meeting_people_groups:[['Adam','Secret']]});
 const r=await f.run({userMessage:'Room roster: Secret. Meet Adam.',rawUserMessage:'Meet Adam.',isMpim:true,surface:'room'});
 assert.deepEqual(canonical(r.resolvedMeetingAttendeeGroups),groups([['adam@example.test']]));
 assert.ok(!r.resolvedMeetingAttendees.includes('secret@example.test'));
});
test('private continuation retains grouping and current-message precheck scope',async t=>{
 const f=setup(t,{meeting_people:[],meeting_continuation:true,context_meeting_people:[{name:'Einav',sourceMessageIndex:0},{name:'Oran',sourceMessageIndex:0}],meeting_people_groups:[['Einav'],['Oran']]});
 const r=await f.run({userMessage:'What about Wednesday?',conversationHistory:history,userId:'UACTIVE',senderRole:'colleague',authority:'colleague',surface:'colleague_dm'});
 assert.deepEqual(canonical(r.resolvedMeetingAttendeeGroups),groups([['einav@example.test'],['oran@example.test']]));
 assert.equal(f.prechecks[0].namedAttendeeEmails.length,0);
});
test('unassigned email header preserves full roster and marks multiple groups ambiguous',async t=>{
 const f=setup(t,{meeting_people:['Adam','Paul'],meeting_people_groups:[['Adam'],['Paul']]});
 const r=await f.run({userMessage:'Meet Adam and separately Paul.',extractedAttendeeEmails:['guest@external.test']});
 assert.ok(r.resolvedMeetingAttendees.includes('guest@external.test'));
 assert.deepEqual(canonical(r.resolvedMeetingAttendeeGroups),[]);
});
test('single group retains forwarded header attendee protection',async t=>{
 const f=setup(t,{meeting_people:['Adam'],meeting_people_groups:[['Adam']]});
 const r=await f.run({userMessage:'Meet Adam.',extractedAttendeeEmails:['guest@external.test']});
 assert.deepEqual(canonical(r.resolvedMeetingAttendeeGroups),groups([['adam@example.test','guest@external.test']]));
});



for (const [name, message, raw, isolated, calls] of [
  ['greeting', 'hello', {}, true, 0],
  ['closing', 'thans', { kind: 'other', conversation_state: 'closing', standalone_courtesy: true, meeting_action: 'none' }, true, 1],
  ['decision', 'yes', {}, false, 0],
  ['mixed task', 'thanks, book time with Einav', { standalone_courtesy: true, meeting_action: 'execute' }, false, 1],
  ['absent signal', 'please check that', {}, false, 1],
]) test('classified private DM: ' + name, async t => {
  const f = setup(t, raw);
  const r = await f.run({ userMessage: message, rawUserMessage: message, conversationHistory: history,
    senderRole: 'colleague', authority: 'colleague', surface: 'colleague_dm' });
  assert.equal(f.requests.length, calls);
  assert.equal(r.messages.some(m => m.content === history[1].content), !isolated);
  if (isolated) {
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].content, message);
    assert.equal(r.tools.length, 0);
    assert.equal(f.prechecks.length, 0);
  }
});