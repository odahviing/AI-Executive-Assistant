// Real classifier parser and turn-context producer; provider outputs are isolated
// fixtures. These checks prove provenance and propagation, not LLM judgment.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
let fixtureSource=fs.readFileSync(path.join(__dirname,'test-turn-context-boundaries.cjs'),'utf8')
 .replace("const prefix = 'artifacts/workshop-verification/slack-audit-20260919/handyman';","const prefix = 'artifacts/workshop-verification/chris-build-20261103/handyman-roster-repair1';")
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
function setup(t,raw, extraMocks={}){
 const requests=[],prechecks=[];
 const anthropic={messages:{create:async p=>{
  requests.push(p);
  return {stop_reason:'tool_use',content:[{type:'tool_use',name:'classify_turn',input:{kind:'task',conversation_state:'open',scopes:['meetings'],meeting_action:'explore',...raw}}]};
 }}};
 const f=fixtureModule.exports.fixture(t,{...extraMocks,'src/core/social/classifyTurn.ts':classifier.exports,'src/llm/client.ts':{getAnthropicClient:()=>anthropic},'src/utils/availabilityPreCheck.ts':{precheckAvailability:async p=>{prechecks.push(p);return {ran:false,verdicts:[]};}}});
 return {...f,requests,prechecks};
}
const canonical=x=>JSON.parse(JSON.stringify(x));

test('human roster keeps a labelled Slack mention and punctuated mailbox labels',async t=>{
 const people=['me <@UABCDEFG>','Adalio - <mailto:guest@outside.test|guest@outside.test>','Jim <mailto:jim@outside.test|jim@outside.test>'];
 const f=setup(t,{meeting_people:people,meeting_people_groups:[['<@UABCDEFG>','Adalio','Jim']],request_relation:'new'}, {
  'src/memory/resolveAttendeeEmails.ts':{
   resolveNamedInternalAttendees:({names})=>({resolved:names.filter(n=>n==='<@UABCDEFG>').map(()=>({name:'Active Person',email:'active@example.test'})),unresolved:names.filter(n=>n!=='<@UABCDEFG>')}),nameGenuinelyMatches:()=>false},
 });
 const r=await f.run({userMessage:'Book lunch with '+people.join(', ')});
 assert.deepEqual(canonical(r.resolvedMeetingAttendeeGroups),[{emails:['active@example.test','guest@outside.test','jim@outside.test'],unresolvedNames:[]}]);
});

test('two Slack identities in one extracted label remain unresolved',async t=>{
 const literal='<@UABCDEFG> <@UOTHERID>';
 const f=setup(t,{meeting_people:[literal],meeting_people_groups:[[literal]]},{
  'src/memory/resolveAttendeeEmails.ts':{resolveNamedInternalAttendees:({names})=>({resolved:[],unresolved:names}),nameGenuinelyMatches:()=>false},
 });
 const r=await f.run({userMessage:'Meet '+literal});
 assert.deepEqual(canonical(r.resolvedMeetingAttendeeGroups),[{emails:[],unresolvedNames:[literal]}]);
});

for(const [label,message,people,rosters,expected] of [
 ['bare Slack ID','Meet <@UABCDEFG>.',['<@UABCDEFG>'],[['UABCDEFG']],['active@example.test']],
 ['owner name in another alphabet','Meet עידן and Guest.',['עידן','Guest'],[['Idan','Guest']],[]],
 ['owner alone is not an extra appointment','Meet Idan with Adam, and separately with Paul.',['Idan','Adam','Paul'],[['Idan'],['Adam'],['Paul']],['adam@example.test','paul@example.test']],
])test('roster representation: '+label,async t=>{
 const owner=name=>['Idan','עידן'].includes(name);
 const resolver=({names})=>({resolved:names.flatMap(name=>name==='<@UABCDEFG>'?[{name:'Active Person',email:'active@example.test'}]:['Adam','Paul'].includes(name)?[{name,email:name.toLowerCase()+'@example.test'}]:[]),unresolved:names.filter(name=>!owner(name)&&!['<@UABCDEFG>','Adam','Paul'].includes(name))});
 const f=setup(t,{meeting_people:people,meeting_people_groups:rosters},{'src/memory/resolveAttendeeEmails.ts':{resolveNamedInternalAttendees:resolver,nameGenuinelyMatches:(full,email,name)=>owner(full)&&owner(name)}});
 f.profile.user.name='Idan';f.profile.user.name_he='עידן';
 const r=await f.run({userMessage:message});
 assert.deepEqual(Array.from(r.resolvedMeetingAttendeeGroups.flatMap(g=>g.emails)),expected);
 assert.equal(r.resolvedMeetingAttendeeGroups.length,label==='owner alone is not an extra appointment'?2:1);
 if(label==='owner name in another alphabet')assert.deepEqual(Array.from(r.resolvedMeetingAttendeeGroups[0].unresolvedNames),['Guest']);
});
function externalFixture(t,groups) {
 const resolver=({names})=>({resolved:names.filter(name=>name==='Adam').map(name=>({name,email:'adam@example.test'})),unresolved:names.filter(name=>name!=='Adam')});
 return setup(t,{meeting_people:groups.flat(),meeting_people_groups:groups},{
  'src/memory/resolveAttendeeEmails.ts':{resolveNamedInternalAttendees:resolver,nameGenuinelyMatches:()=>false},
  'src/connections/registry.ts':{listConnections:()=>[],getConnection:()=>undefined},
 });
}
for(const [label,groups,expected] of [
 ['external-only',[['External']],[{emails:[],unresolvedNames:['External']}]],
 ['internal and separate external',[['Adam'],['External']],[{emails:['adam@example.test'],unresolvedNames:[]},{emails:[],unresolvedNames:['External']}]],
 ['internal plus external in same meeting',[['Adam','External']],[{emails:['adam@example.test'],unresolvedNames:['External']}]],
 ['multiple external meetings',[['External'],['Unknown']],[{emails:[],unresolvedNames:['External']},{emails:[],unresolvedNames:['Unknown']}]],
 ['mixed and external separate',[['Adam','Unknown'],['External']],[{emails:['adam@example.test'],unresolvedNames:['Unknown']},{emails:[],unresolvedNames:['External']}]],
 ]) test(label+' preserves membership through actual producer',async t=>{
 const f=externalFixture(t,groups);const r=await f.run({userMessage:'Meet Adam, External and Unknown.'});
 assert.deepEqual(canonical(r.resolvedMeetingAttendeeGroups),expected);
 assert.deepEqual(Array.from(r.resolvedMeetingAttendees),groups.flat().includes('Adam')?['adam@example.test']:[]);
 });
test('legitimate known attendee remains in flat identity inventory',async t=>{
 const f=externalFixture(t,[['Adam']]);
 // Existing identity inventory stays intact alongside richer meeting scopes.

 const r=await f.run({userMessage:'Meet Adam.'});assert.deepEqual(Array.from(r.resolvedMeetingAttendees),['adam@example.test']);
});
test('room framing cannot introduce an external group',async t=>{
 const f=externalFixture(t,[['Adam'],['External']]);const r=await f.run({userMessage:'Room members External. Meet Adam.',rawUserMessage:'Meet Adam.',isMpim:true,surface:'room'});
 assert.deepEqual(canonical(r.resolvedMeetingAttendeeGroups),[{emails:['adam@example.test'],unresolvedNames:[]}]);
});
module.exports={externalFixture};

test('continuation reuses grounded search spelling and fresh directory identity without repeating the question',async t=>{
 const raw={meeting_people:['עינב'],meeting_people_groups:[['עינב']],directory_spellings:[{name:'עינב',spelling:'Einav'}],request_relation:'new'};
 const calls=[];let email='einav@example.test';
 const f=setup(t,raw,{
  'src/memory/resolveAttendeeEmails.ts':{resolveNamedInternalAttendees:({names})=>({resolved:[],unresolved:[...names]}),nameGenuinelyMatches:(full,address,name)=>full===name},
  'src/connections/registry.ts':{listConnections:()=>[],getConnection:()=>({executeToolCall:async(name,args)=>{calls.push(args.name);return {matches:args.name==='Einav'?[{name:'Einav',email}]:[]};}})},
 });
 const message='Meet עינב.';
 f.profile.meetings={allowed_durations:[25,40],default_meeting_duration:25};
 const first=await f.run({userMessage:message,rawUserMessage:message,typedUserMessage:message});
 assert.deepEqual(Array.from(first.resolvedMeetingAttendees),['einav@example.test']);
 assert.ok(first.prompt.includes('einav@example.test'));
 Object.assign(raw,{meeting_people:[],meeting_people_groups:[],directory_spellings:[],request_relation:'continue',meeting_continuation:true,participants_unchanged:true});
 email='einav.new@example.test';
 const next=await f.run({userMessage:'40 minutes.',rawUserMessage:'40 minutes.',typedUserMessage:'40 minutes.',conversationHistory:[{role:'user',content:message},{role:'assistant',content:'What duration?',toolSummaries:[],meetingRequest:first.meetingRequest}]});
 assert.deepEqual(Array.from(next.resolvedMeetingAttendees),['einav.new@example.test']);
 assert.ok(next.participantContext.includes('einav.new@example.test'));
 assert.deepEqual(canonical(next.meetingRequest.directorySpellings),[{name:'עינב',spelling:'Einav'}]);
 assert.equal(calls.filter(name=>name==='Einav').length,2,'fresh directory verification on each turn');
 Object.assign(raw,{meeting_people:['Other'],meeting_people_groups:[['Other']],request_relation:'new',meeting_continuation:false,participants_unchanged:false});
 const other=await f.run({userMessage:'Meet Other.',typedUserMessage:'Meet Other.',conversationHistory:[{role:'assistant',content:'Ready.',toolSummaries:[],meetingRequest:next.meetingRequest}]});
 assert.deepEqual(canonical(other.meetingRequest.directorySpellings),[]);
 assert.ok(!other.participantContext?.includes('einav.new@example.test'));
});

