// Actual complete modules with closed I/O boundaries. Optional snapshot is only for before replay.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),snapshot=process.env.LIBRARIAN_HAIKU_SNAPSHOT;
const profile={user:{slack_user_id:'OWNER',name:'Owner Example'},assistant:{name:'Maelle'}};
function harness(file,extra=''){
 const calls=[],marks=[],warnings=[];let response={content:[{type:'text',text:'{}'}]},offline=false;
 const client={messages:{create:async request=>{calls.push(request);if(offline)throw Error('fixture offline');return response;}}};
 const person={person_id:'person',name:'Person',profile_json:'{}',notes:'[]'};
 const logger=Object.fromEntries(['warn','error','debug','info'].map(k=>[k,(...x)=>warnings.push(x)]));
 const db={findThreadsReadyForCapture:()=>[{thread_ts:'thread',channel_id:'DM'}],markThreadCaptured:t=>marks.push(t),getConversationHistory:()=>[{role:'user',content:'We discussed a project for tomorrow.'}],getPersonMemory:()=>person};
 const subjects={FIXED_CATEGORIES:['music'],getActiveSubjectsForPerson:()=>[],getAllSubjectsForPerson:()=>[],getRecentTopicBeats:()=>[],threadHadSocialTurn:()=>false};
 const modelSource=fs.readFileSync(path.join(root,'src/llm/models.ts'),'utf8');const models={exports:{}};vm.runInNewContext(ts.transpileModule(modelSource,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:models.exports});
 const deps={
 '../config':{config:{ANTHROPIC_API_KEY:'fixture'}},'../llm/client':{getAnthropicClient:()=>client},'../llm/models':models.exports,'../../llm/models':models.exports,
 '../utils/logger':logger,'../../utils/logger':logger,'./logger':logger,'../utils/extractJson':{extractFirstJsonObject:t=>t},
 '../connections/registry':{getConnection:()=>({resolveChannelCounterpart:async()=> 'PERSON'})},'../db':db,
 './peopleMemory':{readPersonMemory:async()=>''},'../core/assistantSelf':{selfSlackId:()=> 'SELF'},'../utils/timezoneValidator':{},
 '../db/socialSubjects':subjects,'../../db/socialSubjects':subjects,'../../utils/usageLog':{logLlmUsage(){}},
 './detectMessageLanguage':{},'./general':{},'../utils/skillPreferences':{},
 fs:{promises:{},existsSync:()=>false},path, luxon:require('luxon'),
 'node:http':{request(){throw Error('network forbidden')}},'node:https':{request(){throw Error('network forbidden')}},'node:dns':{},'node:net':require('node:net'),'ipaddr.js':require('ipaddr.js'),'cheerio':require('cheerio'),
 };
 const location=snapshot?path.join(root,snapshot,file):path.join(root,file),mod={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(location,'utf8')+extra,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports:mod.exports,require:id=>{assert.ok(Object.hasOwn(deps,id),'unmocked '+id);return deps[id];},URL,Date,Buffer,process:{cwd:()=>'/fixture'},setTimeout,clearTimeout});
 return {mod:mod.exports,client,calls,marks,warnings,setText:t=>{response={content:[{type:'text',text:t}]};},setResponse:r=>{response=r;},fail:()=>{offline=true;}};
}
const cases=[
 ['general-plan','src/skills/general.ts','\nexport const testEntry=planResearchQueries;',200,async h=>{h.setText('{"queries":["specific query"]}');return h.mod.testEntry('research subject');},r=>assert.equal(r.queries[0],'specific query')],
 ['news-plan','src/skills/news.ts','\nexport const testEntry=planNewsGoals;',350,async h=>{h.setText('{"goals":["specific goal"]}');return h.mod.testEntry('technology',[],4);},r=>assert.equal(r.goals[0],'specific goal')],
 ['news-covered','src/skills/news.ts','\nexport const testEntry=classifyAlreadyCovered;',300,async h=>{h.setText('[0]');return h.mod.testEntry([{url:'https://example.com',title:'Story'}],'previous');},r=>assert.equal(r.covered.length,1)],
 ['news-seen','src/skills/news.ts','\nexport const testEntry=summarizeBundleForSeenLog;',400,async h=>{h.setText('• Story — new result');return h.mod.testEntry({sources:[{url:'https://example.com',title:'Story'}]},'');},r=>assert.equal(r[0],'• Story — new result')],
 ['capture-profile','src/memory/capturePass.ts','',800,h=>h.mod.runCapturePass(profile),()=>{}],
 ['capture-self','src/memory/capturePass.ts','\nexport const testEntry=runSelfCapture;',1000,h=>h.mod.testEntry(profile,h.client,'thread','Owner',null),()=>{}],
 ['capture-subject','src/memory/capturePass.ts','\nexport const testEntry=runSubjectReconciliation;',3000,async h=>{h.setText('{"decisions":[]}');return h.mod.testEntry(profile,h.client,'thread','PERSON','Person','Owner',null);},()=>{}],
 ['gender','src/utils/genderDetect.ts','',8,async h=>{h.setText('female');return h.mod.detectGenderFromSelfDeclaredMorphology('אני ממש שמחה לדבר על הפרויקט','Hebrew');},r=>assert.equal(r,'female')],
 ['classify-turn','src/core/social/classifyTurn.ts','',250,async h=>{h.setResponse({content:[{type:'tool_use',input:{kind:'task',scopes:['meetings']}}]});return h.mod.classifyTurn({anthropic:h.client,message:'Please schedule a meeting with the team',profile,needIntent:true,needScopes:true});},r=>assert.equal(r.intent.kind,'task')],
];
for(const [id,file,extra,budget,invoke,check] of cases){
 test(id+' explicit disabled payload',async()=>{const h=harness(file,extra);await invoke(h);const request=h.calls.find(r=>r.max_tokens===budget);assert.ok(request,'actual expected call reached');assert.equal(request.model,'claude-haiku-5-5');assert.equal(request.thinking?.type,'disabled');});
 test(id+' legitimate result and unchanged budget',async()=>{const h=harness(file,extra);check(await invoke(h));assert.ok(h.calls.some(r=>r.max_tokens===budget));if(id==='classify-turn')assert.equal(h.calls[0].tool_choice.name,'classify_turn');});
 test(id+' unavailable provider remains contained',async()=>{const h=harness(file,extra);h.fail();await invoke(h);assert.ok(h.calls.some(r=>r.max_tokens===budget));});
}
