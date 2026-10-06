// Actual person-memory modules over isolated SQLite/files; no live DB or model.
// PERSON_MEMORY_BEFORE=edd2433 runs the same cases against the preserved revision.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const cp = require('node:child_process'), ts = require('typescript'), Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..'), before = process.env.PERSON_MEMORY_BEFORE, compiled = new Map();
const cols = 'person_id,slack_id,name,name_set_by,email,email_set_by,kind,source,org,is_vip,timezone,timezone_set_by,timezone_temp,state,state_set_by,name_he,name_he_set_by,gender,gender_set_by,gender_confirmed,last_inbound_lang,last_inbound_lang_at,profile_json,working_hours_auto,currently_traveling,notes,interaction_log,engagement_rank,proactive_pending,last_social_at,last_initiated_at,last_social_capture_unknown_at,last_seen,created_at,updated_at'.split(',');
function harness(people = []) {
  const sqlite = new Database(':memory:'), disk = fs.mkdtempSync(path.join(os.tmpdir(), 'person-memory-'));
  fs.mkdirSync(path.join(disk,'config/users'),{recursive:true});
  sqlite.exec(`CREATE TABLE people_memory(${cols.map(c => c === 'person_id' ? c + ' TEXT PRIMARY KEY' : c === 'slack_id' ? c + ' TEXT UNIQUE' : c + (['gender_confirmed','engagement_rank','proactive_pending','is_vip'].includes(c)?' INTEGER':' TEXT')).join(',')})`);
  for (const person of people) {
    const p = Object.assign(Object.fromEntries(cols.map(c => [c, null])), {person_id:'p_' + (person.slack_id || person.name.replace(/\W/g,'')),kind:person.slack_id?'internal':'external',gender:'unknown',gender_confirmed:0,profile_json:'{}',notes:'[]',interaction_log:'[]',last_seen:'2020-01-01',created_at:'2020-01-01'}, person);
    sqlite.prepare(`INSERT INTO people_memory(${cols}) VALUES(${cols.map(c=>'@'+c)})`).run(p);
  }
  const profile={user:{name:'Owner Example',slack_user_id:'UOWNER99',email:'owner@example.com',timezone:'Asia/Jerusalem'},assistant:{name:'Maelle',email:'maelle@example.com'},meetings:{},skills:{social:true}};
  const messages=[], modules=new Map(), state={modelCalls:0,modelResult:'{}',threads:[],captured:[],failWrite:false};
  const noop=()=>{};
  const mocks={
    'src/db/client.ts':{getDb:()=>sqlite},
    'src/db/socialSubjects.ts':{FIXED_CATEGORIES:[],getActiveSubjectsForPerson:()=>[],getRecentTopicBeats:()=>[],threadHadSocialTurn:()=>false},
    'src/db/engagementRank.ts':{isCurrentRankOwnerAuthored:()=>false},
    'src/config/userProfile.ts':{getTenantWorkdaysForTimezone:()=>undefined},
    'src/config.ts':{config:{ANTHROPIC_API_KEY:'fixture'}},
    'src/llm/client.ts':{getAnthropicClient:()=>({messages:{create:async()=>{state.modelCalls++; return {content:[{type:'text',text:state.modelResult}]};}}})},
    'src/llm/models.ts':{},
    'src/utils/logger.ts':{__esModule:true,default:Object.fromEntries(['info','debug','warn','error'].map(k=>[k,(...args)=>messages.push([k,...args])]))},
    'src/connections/registry.ts':{getConnection:()=>state.unavailable?undefined:({resolveChannelCounterpart:async()=> 'UCHRIS99'})},
    'src/utils/skillPreferences.ts':{},
    'src/core/social/logEngagement.ts':{},
  };
  function load(rel){
    if(rel==='src/db.ts')return {...load('src/db/people.ts'),getDb:()=>sqlite,getPersonSocialSummary:()=>({live:[],dead:[]}),getEventsByActor:()=>[],findThreadsReadyForCapture:()=>state.threads,markThreadCaptured:id=>state.captured.push(id),getConversationHistory:()=>[{role:'user',content:'We discussed our project for tomorrow.',timestamp:new Date().toISOString()}]};
    if(Object.hasOwn(mocks,rel))return mocks[rel];
    if(modules.has(rel))return modules.get(rel).exports;
    if(!compiled.has(rel)){
      const snapshot = process.env.PERSON_MEMORY_SNAPSHOT && path.join(root,process.env.PERSON_MEMORY_SNAPSHOT,rel);
      let source = snapshot && fs.existsSync(snapshot) ? fs.readFileSync(snapshot,'utf8') : before ? cp.execFileSync('git',['show',before+':'+rel],{cwd:root,encoding:'utf8'}) : fs.readFileSync(path.join(root,rel),'utf8');
      if(rel==='src/memory/capturePass.ts')source+='\nexport const testCapture = { applyDelta, parseDelta };';
      compiled.set(rel,ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
    }
    const mod={exports:{}};modules.set(rel,mod);
    const req=s=>s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):s==='fs'?{...fs,promises:{...fs.promises,writeFile:async(...args)=>{if(state.failWrite)throw Error('fixture disk unavailable');return fs.promises.writeFile(...args);}}}:require(s);
    vm.runInNewContext('(function(require,module,exports){'+compiled.get(rel)+'\n})',{Date,console,Set,Map,Buffer,setTimeout,clearTimeout,process:{env:process.env,cwd:()=>disk}},{filename:rel})(req,mod,mod.exports);
    return mod.exports;
  }
  function ctx(authority='owner',surface=authority==='owner'?'owner_dm':'colleague_dm') {return {profile,authority,surface,senderRole:surface==='owner_dm'?'owner':'colleague',userId:authority==='owner'?'UOWNER99':'UCHRIS99',channel:'slack',channelId:'DFIXTURE'};}
  const tool=(name,args,authority,surface)=>new(load('src/core/assistant.ts').AssistantSkill)().executeToolCall(name,args,ctx(authority,surface));
  const p=()=>load('src/db/people.ts');
  return {sqlite,disk,profile,state,messages,load,ctx,tool,p,restart:()=>modules.clear(),file:id=>path.join(disk,'config/users/owner_people',id+'.md')};
}
const chris={slack_id:'UCHRIS99',name:'Christian Ray',email:'christian@example.com'};

module.exports={harness,chris};
