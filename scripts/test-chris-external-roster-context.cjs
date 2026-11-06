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
  return {content:[{type:'tool_use',input:{kind:'task',conversation_state:'open',scopes:['meetings'],meeting_action:'explore',...raw}}]};
 }}};
 const f=fixtureModule.exports.fixture(t,{...extraMocks,'src/core/social/classifyTurn.ts':classifier.exports,'src/llm/client.ts':{getAnthropicClient:()=>anthropic},'src/utils/availabilityPreCheck.ts':{precheckAvailability:async p=>{prechecks.push(p);return {ran:false,verdicts:[]};}}});
 return {...f,requests,prechecks};
}
const canonical=x=>JSON.parse(JSON.stringify(x));
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

