// Actual-module harness: filesystem fixtures + captured model requests; no live calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const before = process.env.MEMORY_CONSUMERS_BEFORE;
const tests = [];
const test = (name, run) => tests.push({ name, run });
const actual = new Set(['src/core/assistant.ts','src/utils/skillPreferences.ts','src/skills/summary.ts','src/skills/news.ts','src/tasks/briefs.ts','src/utils/extractJson.ts','src/skills/registry.ts']);
const compiled = new Map();
function harness() {
  const disk = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-consumer-'));
  const modules = new Map();
  const draft = {subject:'Project review',main_topic:'Project',attendees:[],paragraphs:['Owner final paragraph.'],action_items:[],is_external:false};
  const state = { requests:[], searches:[], reply:JSON.stringify(draft), failModel:false, failWrite:false, failRead:false, failRename:false, draft, dbPrefs:[{category:'summary',value:'DB-STYLE-CONTROL'}] };
  const profile = { user:{name:'Owner Example',slack_user_id:'UOWNER',email:'owner@example.com',timezone:'UTC',language:'en'},assistant:{name:'Maelle'},skills:{summary:true,news:true} };
  const logger = Object.fromEntries(['info','debug','warn','error'].map(k=>[k,()=>{}]));
  class UnusedCore { executeToolCall(){return null;} getTools(){return [];} }
  const mocks = {
    'src/utils/logger.ts':{__esModule:true,default:logger},
    'src/llm/client.ts':{getAnthropicClient:()=>({messages:{create:async request=>{state.requests.push(request);if(state.failModel)throw Error('fixture unavailable');return {content:[{type:'text',text:state.reply}]};}}})},
    'src/llm/models.ts':{SONNET:{model:'fixture'},MODEL_HAIKU:'fixture'},
    'src/db.ts':{getPreferences:()=>state.dbPrefs,getSummarySessionByThread:()=>({id:1,current_draft:JSON.stringify(state.draft)}),parseDraft:()=>state.draft,replaceSummaryDraft:(_thread,d)=>{state.draft=d;}},
    'src/skills/general.ts':{tavilySearch:async(...args)=>{state.searches.push(args);return {results:[]};}},
    'src/utils/calendarListingFormat.ts':{calendarListingFormatRule:()=>''},
    'src/skills/outreach.ts':{OutreachCoreSkill:UnusedCore},
    'src/tasks/skill.ts':{TasksSkill:UnusedCore},
    'src/tasks/crons.ts':{CronsSkill:UnusedCore},
    'src/connections/registry.ts':{getConnection:()=>undefined},
    'src/utils/textScrubber.ts':{registerToolNames:()=>{}},
  };
  function load(rel) {
    if(mocks[rel])return mocks[rel];
    if(!actual.has(rel))return {};
    if(modules.has(rel))return modules.get(rel).exports;
    if(!compiled.has(rel)) {
      let source = before ? cp.execFileSync('git',['show',before+':'+rel],{cwd:root,encoding:'utf8'}) : fs.readFileSync(path.join(root,rel),'utf8');
      if(rel==='src/skills/summary.ts')source+='\nexport const consumerTest = { draftSummaryFromTranscript, parseSummaryFromText };';
      if(rel==='src/tasks/briefs.ts')source+='\nexport const consumerTest = { generateBriefingText };';
      compiled.set(rel, ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
    }
    const mod={exports:{}};modules.set(rel,mod);
    const fixtureFs={...fs,readFileSync:(...args)=>{if(state.failRead)throw Object.assign(Error('unreadable'),{code:'EACCES'});return fs.readFileSync(...args);},promises:{...fs.promises,writeFile:async(...args)=>{if(state.failWrite)throw Error('disk full');return fs.promises.writeFile(...args);},rename:async(...args)=>{if(state.failRename)throw Error('rename unavailable');return fs.promises.rename(...args);}}};
    const req=s=>s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):s==='fs'?fixtureFs:require(s);
    vm.runInNewContext('(function(require,module,exports){'+compiled.get(rel)+'\n})',{Date,console,Set,Map,Buffer,Intl,URL,setTimeout,clearTimeout,process:{env:process.env,cwd:()=>disk}},{filename:rel})(req,mod,mod.exports);
    return mod.exports;
  }
  function seed(skill,text){const file=path.join(disk,'config/users/owner_prefs',skill+'.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;}
  const ctx=(authority='owner',surface='owner_dm')=>({profile,authority,surface,senderRole:surface==='owner_dm'?'owner':'colleague',userId:authority==='owner'?'UOWNER':'UCOLLEAGUE',channel:'slack',channelId:'DTEST',threadTs:'123.456'});
  const tool=(args,authority,surface)=>new(load('src/core/assistant.ts').AssistantSkill)().executeToolCall('update_my_preferences',args,ctx(authority,surface));
  return {state,profile,disk,load,seed,ctx,tool,restart:()=>modules.clear(),cleanup:()=>fs.rmSync(disk,{recursive:true,force:true})};
}
async function fixture(run){const h=harness();try{await run(h);}finally{h.cleanup();}}
const textOf = req => [req.system||'',...req.messages.map(m=>m.content)].join('\n');
test('L1 read preserves complete arbitrary text on a narrow-scope owner turn',()=>fixture(async h=>{
  const original='# A heading\n\nעברית — оставить формат\n\n| one | two |\n| --- | --- |\n';h.seed('summary',original);
  const r=await h.tool({skill:'summary',mode:'read'});assert.equal(r.ok,true);assert.equal(r.text,original);assert.ok(r.revision);assert.equal(r.exists,true);assert.equal(h.state.requests.length,0);
}));
test('L1 read edit replace preserves unrelated prose and restart retry',()=>fixture(async h=>{
  const original='# heading\n\nKeep this table.\n\nChange THIS.\n';const file=h.seed('summary',original);
  const read=await h.tool({skill:'summary',mode:'read'});const replacement=original.replace('THIS','THAT');
  const r=await h.tool({skill:'summary',mode:'replace',text:replacement,expected_revision:read.revision});assert.equal(r.ok,true);assert.equal(fs.readFileSync(file,'utf8'),replacement);
  h.restart();const retry=await h.tool({skill:'summary',mode:'replace',text:replacement,expected_revision:read.revision});assert.equal(retry.unchanged,true);
}));
test('L1 revision conflict refuses stale replacement and returns fresh text',()=>fixture(async h=>{
  const file=h.seed('summary','ORIGINAL\n');const old=await h.tool({skill:'summary',mode:'read'});fs.writeFileSync(file,'CONCURRENT\n');
  const r=await h.tool({skill:'summary',mode:'replace',text:'LOST',expected_revision:old.revision});assert.equal(r.error,'revision_conflict');assert.equal(r.current.text,'CONCURRENT\n');assert.equal(fs.readFileSync(file,'utf8'),'CONCURRENT\n');
}));
test('L1 missing revision refuses destructive replacement',()=>fixture(async h=>{
  const file=h.seed('summary','PRESERVE\n');const r=await h.tool({skill:'summary',mode:'replace',text:'LOSS'});assert.equal(r.error,'revision_required');assert.equal(fs.readFileSync(file,'utf8'),'PRESERVE\n');
}));
test('L1 empty replacement clears and fresh missing-file read is explicit',()=>fixture(async h=>{
  const file=h.seed('summary','CLEAR\n');const r=await h.tool({skill:'summary',mode:'read'});const cleared=await h.tool({skill:'summary',mode:'replace',text:'',expected_revision:r.revision});assert.equal(cleared.ok,true);assert.equal(fs.readFileSync(file,'utf8'),'');
  const missing=await h.tool({skill:'news',mode:'read'});assert.equal(missing.ok,true);assert.equal(missing.exists,false);assert.equal(missing.text,'');
}));
test('L1 unavailable read is an error, never an empty document',()=>fixture(async h=>{
  h.seed('summary','SECRET');h.state.failRead=true;const r=await h.tool({skill:'summary',mode:'read'});assert.equal(r.error,'read_failed');assert.equal(r.text,undefined);
}));
test('CONTROL preference owner/colleague and shared surface code gates',()=>fixture(async h=>{
  h.seed('summary','SECRET');for(const [authority,surface] of [['owner','room'],['colleague','room'],['colleague','colleague_dm']])for(const mode of ['read','add','replace']){const r=await h.tool({skill:'summary',mode,text:'forbidden'},authority,surface);assert.equal(r.error,'not_permitted');assert.ok(!JSON.stringify(r).includes('SECRET'));}assert.equal(h.state.requests.length,0);
}));
test('CONTROL add saved, duplicate harmless, invalid path refused, no model calls',()=>fixture(async h=>{
  const a=await h.tool({skill:'news',mode:'add',text:'I follow space exploration'});assert.equal(a.ok,true);
  const dup=await h.tool({skill:'news',mode:'add',text:'I follow space exploration'});assert.equal(dup.duplicate,true);
  assert.equal((await h.tool({skill:'../../elsewhere',mode:'add',text:'x'})).error,'invalid_skill');assert.equal(h.state.requests.length,0);
}));
test('CONTROL unavailable write preserves old file and retry succeeds',()=>fixture(async h=>{
  const file=h.seed('summary','old\n');h.state.failWrite=true;assert.equal((await h.tool({skill:'summary',mode:'add',text:'new instruction'})).error,'write_failed');assert.equal(fs.readFileSync(file,'utf8'),'old\n');h.state.failWrite=false;assert.equal((await h.tool({skill:'summary',mode:'add',text:'new instruction'})).ok,true);
}));
test('L1 failed atomic rename preserves prior document and retry succeeds',()=>fixture(async h=>{
  const file=h.seed('summary','old\n'),r=await h.tool({skill:'summary',mode:'read'});h.state.failRename=true;const args={skill:'summary',mode:'replace',text:'new\n',expected_revision:r.revision};assert.equal((await h.tool(args)).error,'write_failed');assert.equal(fs.readFileSync(file,'utf8'),'old\n');h.state.failRename=false;assert.equal((await h.tool(args)).ok,true);
}));
test('L2 transcript composer captures summary MD alongside DB style without extra calls',()=>fixture(async h=>{
  h.seed('summary','SUMMARY-MD-עברית');await h.load('src/skills/summary.ts').consumerTest.draftSummaryFromTranscript({transcript:'Transcript input',ownerUserId:'UOWNER',ownerName:'Owner',profile:h.profile});assert.equal(h.state.requests.length,1);const prompt=textOf(h.state.requests[0]);assert.ok(prompt.includes('SUMMARY-MD-עברית'));assert.ok(prompt.includes('DB-STYLE-CONTROL'));assert.ok(prompt.includes('Transcript input'));
}));
test('L2 revise composer captures summary MD in actual model request',()=>fixture(async h=>{
  h.seed('summary','SUMMARY-REVISION-RULE');const r=await h.load('src/skills/registry.ts').executeSkillTool('update_summary_draft',{instruction:'Use fewer paragraphs'},h.ctx());assert.equal(r.ok,true);assert.ok(textOf(h.state.requests[0]).includes('SUMMARY-REVISION-RULE'));assert.ok(textOf(h.state.requests[0]).includes('DB-STYLE-CONTROL'));
}));
test('CONTROL registry refuses private summary and preference reads for colleague and room',()=>fixture(async h=>{
  h.seed('summary','PRIVATE-SUMMARY-RULE');const registry=h.load('src/skills/registry.ts');for(const [authority,surface] of [['owner','room'],['colleague','colleague_dm'],['colleague','room']])for(const tool of ['update_summary_draft','update_my_preferences']){const r=await registry.executeSkillTool(tool,{instruction:'Read preferences',skill:'summary',mode:'read'},h.ctx(authority,surface));assert.equal(r.error,'not_permitted');}assert.equal(h.state.requests.length,0);
}));
test('CONTROL unavailable summary revision preserves prior draft and reports failure',()=>fixture(async h=>{
  const prior=JSON.stringify(h.state.draft);h.state.failModel=true;const r=await h.load('src/skills/registry.ts').executeSkillTool('update_summary_draft',{instruction:'Revise'},h.ctx());assert.equal(r.ok,false);assert.equal(r.reason,'update_failed');assert.equal(JSON.stringify(h.state.draft),prior);
}));
test('CONTROL untaught summary retains DB style and corrected text remains authoritative',()=>fixture(async h=>{
  const api=h.load('src/skills/summary.ts').consumerTest;await api.draftSummaryFromTranscript({transcript:'Transcript input',ownerUserId:'UOWNER',ownerName:'Owner',profile:h.profile});assert.ok(textOf(h.state.requests[0]).includes('DB-STYLE-CONTROL'));
  await api.parseSummaryFromText({summaryText:'EXACT OWNER PROSE',existing:h.state.draft,profile:h.profile});assert.ok(textOf(h.state.requests[1]).includes('EXACT OWNER PROSE'));assert.equal(h.state.requests.length,2);
}));
test('L3 grounded brief composer captures news MD and brief MD',()=>fixture(async h=>{
  h.seed('news','NEWS-PREFERENCE-русский');h.seed('brief','BRIEF-STYLE');await h.load('src/tasks/briefs.ts').consumerTest.generateBriefingText([],h.profile,{}, {goals:['fixture'],sources:[{url:'https://example.org/news',title:'Grounded fixture'}]});assert.equal(h.state.requests.length,1);const prompt=textOf(h.state.requests[0]);assert.ok(prompt.includes('NEWS-PREFERENCE-русский'));assert.ok(prompt.includes('BRIEF-STYLE'));assert.ok(prompt.includes('Grounded fixture'));
}));
test('CONTROL brief without grounded news omits news preferences; empty day adds no call',()=>fixture(async h=>{
  h.seed('news','NEWS-NOT-IN-PLAY');const gen=h.load('src/tasks/briefs.ts').consumerTest.generateBriefingText;await gen([{kind:'calendar_unavailable'}],h.profile);assert.ok(!textOf(h.state.requests[0]).includes('NEWS-NOT-IN-PLAY'));const prior=h.state.requests.length;assert.match(await gen([],h.profile),/All clear/);assert.equal(h.state.requests.length,prior);
}));
test('L4 explicit empty planner selection issues no excluded company search',()=>fixture(async h=>{
  h.seed('news','Do not cover Fixture Corp');h.state.reply='{"goals":[],"avoid_domains":["example.org"]}';await h.load('src/skills/news.ts').gatherNews(h.profile,{meetingCompanies:['Fixture Corp']});assert.equal(h.state.searches.length,0);assert.equal(h.state.requests.length,1);
}));
test('L4 unavailable planner does not interpret multilingual owner text',()=>fixture(async h=>{
  h.seed('news','אל תציג חדשות חברה\nНе показывай новости\nNo mostrar noticias');h.state.failModel=true;await h.load('src/skills/news.ts').gatherNews(h.profile,{meetingCompanies:['Excluded company']});assert.equal(h.state.searches.length,0);assert.equal(h.state.requests.length,1);
}));
test('L4 malformed planner output with standing text does not trigger prose search',()=>fixture(async h=>{
  h.seed('news','Do not search excluded topics');h.state.reply='{"goals":[null]}';await h.load('src/skills/news.ts').gatherNews(h.profile);assert.equal(h.state.searches.length,0);
}));
test('CONTROL untaught company fallback, explicit topic and valid planner remain usable',()=>fixture(async h=>{
  const news=h.load('src/skills/news.ts');h.state.failModel=true;await news.gatherNews(h.profile,{meetingCompanies:['Acme']});assert.equal(h.state.searches.length,1);
  const calls=h.state.requests.length;await news.gatherNews(h.profile,{topic:'Requested topic'});assert.equal(h.state.requests.length,calls);assert.equal(h.state.searches.length,2);
  h.seed('news','Space developments');h.state.failModel=false;h.state.reply='{"goals":["Space news"],"preferred_domains":["https://example.org/path"],"avoid_domains":[]}';await news.gatherNews(h.profile);assert.equal(h.state.searches.length,4); // existing preferred-source miss retries once broadly
}));
(async()=>{let passed=0;const results=[];for(const t of tests){try{await t.run();passed++;results.push({name:t.name,pass:true});console.log('PASS '+t.name);}catch(e){results.push({name:t.name,pass:false,error:e.message});console.error('FAIL '+t.name+'\n'+e.stack);}}const report={revision:before||'working-tree',passed,failed:tests.length-passed,cases:results};console.log(JSON.stringify(report,null,2));if(process.env.MEMORY_CONSUMERS_REPORT)fs.writeFileSync(process.env.MEMORY_CONSUMERS_REPORT,JSON.stringify(report,null,2));process.exitCode=report.failed?1:0;})();
