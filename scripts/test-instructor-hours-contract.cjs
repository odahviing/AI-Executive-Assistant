// A person's stored working hours must be readable by the model FROM THE STORE — on the owner
// roster line (formatPeopleMemoryForPrompt) and via get_person_memory — not only from the chat
// history of the turn that wrote them (2026-09-11 owner thread: ~20 sets of hours written, the
// ones older than the 20-message history window read back as "still unconfirmed").
// Actual src/*.ts transpiled in a vm sandbox over an in-memory SQLite; mocks only for I/O.
// LIBRARIAN_BEFORE=1 loads the actual modules from the preserved before revision.
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),cp=require('node:child_process');
const luxon=require('luxon'),Database=require('better-sqlite3');
const root=path.resolve(__dirname,'..'),baseline='13f50a4dbc23cf2c214112d61d508e536a2aa380',before=process.env.LIBRARIAN_BEFORE==='1',compiled=new Map();
const actual=new Set(['src/memory/resolveAttendeeEmails.ts','src/db/people.ts','src/core/assistant.ts','src/utils/resolvePersonTarget.ts','src/utils/workingHoursDefault.ts','src/utils/locationTz.ts','src/utils/timezoneValidator.ts']);
const WEEK=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],MF=WEEK.slice(1,6),ST=WEEK.slice(0,5);
const auto=(workdays,hoursStart,hoursEnd)=>JSON.stringify({workdays,hoursStart,hoursEnd});
const stated=(workdays,hoursStart,hoursEnd,timezone,extra={})=>JSON.stringify({...extra,working_hours_structured:{workdays,hoursStart,hoursEnd,...(timezone?{timezone}:{})}});
const COLS='person_id,slack_id,name,name_set_by,email,email_set_by,kind,source,org,is_vip,timezone,timezone_set_by,timezone_temp,state,state_set_by,name_he,name_he_set_by,gender,gender_set_by,gender_confirmed,last_inbound_lang,last_inbound_lang_at,profile_json,working_hours_auto,currently_traveling,notes,interaction_log,engagement_rank,proactive_pending,last_social_at,last_seen,created_at,updated_at'.split(',');
function harness(people){
 const sqlite=new Database(':memory:');
 sqlite.exec(`CREATE TABLE people_memory(${COLS.map(c=>c==='person_id'?'person_id TEXT PRIMARY KEY':c==='slack_id'?'slack_id TEXT UNIQUE':c+' TEXT').join(',')})`);
 const ins=sqlite.prepare(`INSERT INTO people_memory(${COLS.join(',')}) VALUES(${COLS.map(c=>'@'+c).join(',')})`);
 for(const p of people){
  const row=Object.fromEntries(COLS.map(c=>[c,null]));
  Object.assign(row,{person_id:'p_'+(p.slack_id||p.name.replace(/\W/g,'_')),kind:p.slack_id?'internal':'external',gender:'unknown',gender_confirmed:0,profile_json:'{}',notes:'[]',interaction_log:'[]',last_seen:new Date().toISOString()},p);
  ins.run(row);
 }
 const profile={user:{name:'Owner Example',slack_user_id:'UOWNER',email:'owner@example.com',timezone:'Asia/Jerusalem'},assistant:{name:'Maelle'}};
 const noop=()=>{},modules=new Map();
 const mocks={
  'src/db/client.ts':{getDb:()=>sqlite},'src/db/socialSubjects.ts':{},'src/db/engagementRank.ts':{isCurrentRankOwnerAuthored:()=>false},
  'src/config/userProfile.ts':{getTenantWorkdaysForTimezone:tz=>tz==='Asia/Jerusalem'?ST:undefined},
  'src/utils/logger.ts':{__esModule:true,default:{info:noop,debug:noop,warn:noop,error:noop}},
  'src/connections/registry.ts':{getConnection:()=>undefined},
  'src/memory/peopleMemory.ts':{syncPersonOperationalSections:async()=>true,readPersonMemory:async()=>null,writePersonSection:async()=>({ok:true}),resolvePersonSlug:async()=>null},
  'src/utils/skillPreferences.ts':{PREF_SKILLS:[]},
  'src/utils/resolveSlackId.ts':{SLACK_ID_RE:/^U[A-Z]+$/,resolveSlackId:id=>({slack_id:id||undefined,was_hallucinated:false})},

 };
 function load(rel){
  if(rel==='src/db.ts')return {...load('src/db/people.ts'),getDb:()=>sqlite,getPersonSocialSummary:()=>({live:[],dead:[]})};
  if(Object.hasOwn(mocks,rel))return mocks[rel];if(modules.has(rel))return modules.get(rel).exports;
  if(!actual.has(rel))throw Error('Unhandled actual module '+rel);
  if(!compiled.has(rel)){
   const saved = process.env.HOURS_BATCH_BEFORE && ({'src/db/people.ts':'people.before.ts','src/utils/workingHoursDefault.ts':'workingHoursDefault.before.ts'})[rel];
   const instructorSaved=process.env.INSTRUCTOR_BEFORE && rel==='src/core/assistant.ts';
   const source=instructorSaved?fs.readFileSync(path.join(root,'artifacts/workshop-verification/approved-four-20261007/instructor/hours/assistant.before.ts'),'utf8'):saved?fs.readFileSync(path.join(root,process.env.HOURS_BATCH_BEFORE,saved),'utf8'):before?cp.execFileSync('git',['show',baseline+':'+rel],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,rel),'utf8');
   compiled.set(rel,ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
  }
  const mod={exports:{}};modules.set(rel,mod);
  const req=s=>s==='luxon'?luxon:s==='@anthropic-ai/sdk'?{}:s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):require(s);
  vm.runInNewContext('(function(require,module,exports){'+compiled.get(rel)+'\n})',{Date,console,Set,Map,Buffer,setTimeout},{filename:rel})(req,mod,mod.exports);return mod.exports;
 }
 const ctx=role=>({profile,userId:role==='owner'?'UOWNER':'UALEX',senderRole:role,authority:role,surface:role==='owner'?'owner_dm':'colleague_dm',channelId:'DOWNER'});
 const skill=()=>new(load('src/core/assistant.ts').AssistantSkill)();
 return {load,sqlite,
  roster:(focus,social=false)=>load('src/db/people.ts').formatPeopleMemoryForPrompt('UOWNER','Asia/Jerusalem',focus,social),
  memory:(person,role='owner')=>skill().executeToolCall('get_person_memory',{person},ctx(role)),
  tool:(name,slackId,args,role='owner')=>skill().executeToolCall('update_person_profile',{colleague_name:name,colleague_slack_id:slackId,...args},ctx(role))};
}

const fixture=[{slack_id:'UALEX',name:'Alex',timezone:'America/New_York',profile_json:JSON.stringify({working_hours_structured:{week:Object.fromEntries(WEEK.map(d=>[d,MF.includes(d)?{hoursStart:'09:00',hoursEnd:'17:00'}:null])),source:'manual'},_set_by:{working_hours_structured:'owner'}})}];
test('accepted weekday patch renders shared effective hours and keeps default',async()=>{const h=harness(fixture);const r=await h.tool('Alex','UALEX',{working_hours_structured:{week:{Monday:{hoursStart:'08:00',hoursEnd:'14:00'}}}});assert.equal(r.scheduling_hours.in_force,true);assert.match(r.scheduling_hours.window,/Mon 08:00–14:00/);assert.equal(r.scheduling_hours.week.Tuesday.hoursStart,'09:00');});
test('authority refusal cannot confirm older manual hours as attempted write',async()=>{const r=await harness(fixture).tool('Alex','UALEX',{working_hours_structured:{week:{Tuesday:{hoursStart:'10:00',hoursEnd:'16:00'}}}},'colleague');assert.equal(r.scheduling_hours.in_force,false);assert.ok(r.not_saved.includes('working_hours_structured'));});
test('uniform legitimate accepted control',async()=>{const r=await harness(fixture).tool('Alex','UALEX',{working_hours_structured:{week:Object.fromEntries(MF.map(d=>[d,{hoursStart:'08:00',hoursEnd:'16:00'}]))}});assert.equal(r.scheduling_hours.in_force,true);});
test('retired prose refuses without private lookup or mutation and asks exact clocks',async()=>{const h=harness(fixture),p=h.load('src/db/people.ts'),before=p.getPersonMemory('UALEX').profile_json,prepare=h.sqlite.prepare;let queries=0;h.sqlite.prepare=function(...args){queries++;return prepare.apply(this,args)};const r=await h.tool('Alex','UALEX',{working_hours:'Tuesday nights'});assert.equal(r.updated,false);assert.equal(r.error,'retired_working_hours');assert.equal(queries,0);assert.match(r._note,/Ask for exact start and end clocks/);h.sqlite.prepare=prepare;assert.equal(p.getPersonMemory('UALEX').profile_json,before);});
test('invalid patch throws without successful feedback or stored mutation',async()=>{const h=harness(fixture);await assert.rejects(h.tool('Alex','UALEX',{working_hours_structured:{week:{Tuesday:{hoursStart:'night',hoursEnd:'late'}}}}));assert.equal(h.load('src/db/people.ts').getPersonMemory('UALEX').profile_json,fixture[0].profile_json);});
test('schema supports partial weekday patch and vague clarification guidance',()=>{const h=harness(fixture);const tools=new(h.load('src/core/assistant.ts').AssistantSkill)().getTools({user:{name:'Owner'}});const w=tools.find(t=>t.name==='update_person_profile').input_schema.properties.working_hours_structured;assert.ok(w.properties.week.properties.Tuesday);assert.equal(w.required,undefined);assert.match(w.description,/Ask for exact start and end clocks/);});

test('descriptor teaches recorded recurring week and preserves temporary path',()=>{const h=harness(fixture);const tools=new(h.load('src/core/assistant.ts').AssistantSkill)().getTools({user:{name:'Owner'}});const w=tools.find(t=>t.name==='update_person_profile').input_schema.properties.working_hours_structured;assert.match(w.description,/Recorded complete regular week/);assert.match(w.description,/defaults once/);assert.match(w.description,/null for a day off/);assert.match(w.description,/other days stay unchanged/);assert.match(w.description,/Omitted duration means recurring/);assert.match(w.description,/Temporary changes use the existing dated override tools/);assert.doesNotMatch(w.description,/dayOverrides/);});
test('vague write feedback teaches canonical partial week',async()=>{const r=await harness(fixture).tool('Alex','UALEX',{working_hours:'Tuesday nights'});assert.match(r._note,/working_hours_structured.week/);assert.match(r._note,/preserve unspecified days/);assert.match(r._note,/Omitted duration means recurring/);assert.match(r._note,/Temporary changes use the existing dated override tools/);});
test('automatic hours read reports initialized recorded week',async()=>{const automatic=JSON.parse(JSON.stringify(fixture));const p=JSON.parse(automatic[0].profile_json);p.working_hours_structured.source='auto';automatic[0].profile_json=JSON.stringify(p);const r=await harness(automatic).memory('Alex');assert.match(r.working_hours.note,/initialized from timezone defaults once/);assert.match(r.working_hours.note,/stays until edited/);});


