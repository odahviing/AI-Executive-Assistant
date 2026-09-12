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
  'src/utils/skillPreferences.ts':{},
  'src/utils/resolveSlackId.ts':{SLACK_ID_RE:/^U[A-Z]+$/,resolveSlackId:id=>({slack_id:id||undefined,was_hallucinated:false})},

 };
 function load(rel){
  if(rel==='src/db.ts')return {...load('src/db/people.ts'),getDb:()=>sqlite,getPersonSocialSummary:()=>({live:[],dead:[]})};
  if(Object.hasOwn(mocks,rel))return mocks[rel];if(modules.has(rel))return modules.get(rel).exports;
  if(!actual.has(rel))throw Error('Unhandled actual module '+rel);
  if(!compiled.has(rel)){
   const source=before?cp.execFileSync('git',['show',baseline+':'+rel],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,rel),'utf8');
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
const line=(roster,name)=>{const l=roster.split('\n').find(l=>l.startsWith(name+' ('));assert.ok(l,'roster line for '+name);return l;};
const PEOPLE=[
 {slack_id:'UALEX',name:'Alex Wiggins',email:'alex.w@example.com',timezone:'America/New_York',timezone_set_by:'person',state:'Boston',profile_json:stated(MF,'08:00','17:00'),working_hours_auto:auto(MF,'09:00','17:00')},
 {slack_id:'ULORI',name:'Lori Sarsfield',timezone:'America/New_York',timezone_set_by:'owner',profile_json:stated(MF,'07:00','16:00','America/New_York',{working_hours:'East Coast, Wed/Fri 7am-4pm',response_speed:'fast'}),working_hours_auto:auto(MF,'09:00','17:00')},
 {slack_id:'UISAAC',name:'Isaac Levy',timezone:'Asia/Jerusalem',timezone_set_by:'person',profile_json:stated(['Monday','Thursday'],'09:00','17:00',null,{working_hours:'Mon and Thu only'}),working_hours_auto:auto(ST,'09:00','18:00'),notes:JSON.stringify([{date:'2026-05-26',note:"Isaac's availability is restricted to Monday and Thursday"}])},
 {slack_id:'UMAAYAN',name:'Maayan Cohen',timezone:'Asia/Jerusalem',timezone_set_by:'person',profile_json:stated(ST,'10:00','20:00'),working_hours_auto:auto(ST,'09:00','18:00')},
 {slack_id:'UDAN',name:'Dan Beauregard',timezone:'America/New_York',timezone_set_by:'auto',working_hours_auto:auto(MF,'09:00','17:00')},
 {slack_id:'UEREZ',name:'Erez Hodis'},
 {slack_id:null,name:'Kevin External',email:'kevin@ext.example',timezone:'Europe/London',timezone_set_by:'owner',working_hours_auto:auto(MF,'09:00','17:00')},
 {slack_id:null,name:'Sharon Nameonly',timezone:'America/New_York',timezone_set_by:'owner',state:'Boston',working_hours_auto:auto(MF,'09:00','17:00')},
];

test('HV-roster-stated: owner roster renders a stated window at a glance, never the prose',()=>{const r=harness(PEOPLE).roster();
 const alex=line(r,'Alex Wiggins');assert.match(alex,/, hours: Mon–Fri 08:00–17:00, email:/);assert.doesNotMatch(alex,/tz default/);
 const lori=line(r,'Lori Sarsfield');assert.match(lori,/, hours: Mon–Fri 07:00–16:00 America\/New_York,/);assert.doesNotMatch(lori,/East Coast|Wed\/Fri/);
 assert.match(line(r,'Maayan Cohen'),/, hours: Sun–Thu 10:00–20:00,/);});
test('HV-roster-default: owner roster marks the timezone default as not stated',()=>{const r=harness(PEOPLE).roster();
 assert.match(line(r,'Dan Beauregard'),/, hours: Mon–Fri 09:00–17:00 \(tz default, not stated\),/);
 assert.match(line(r,'Kevin External'),/external — no Slack account.*, hours: Mon–Fri 09:00–17:00 \(tz default, not stated\),/);});
test('HV-roster-social-off: the slim social-off roster line carries the same window',()=>{const h=harness(PEOPLE);assert.match(line(h.roster(undefined,true),'Alex Wiggins'),/hours: Mon–Fri 08:00–17:00/);assert.match(line(h.roster(new Set(['UALEX']),true),'Alex Wiggins'),/hours: Mon–Fri 08:00–17:00/);});
test('HV-memory-effective: get_person_memory returns the effective window with its zone and provenance',async()=>{const h=harness(PEOPLE);
 const a=await h.memory('Alex Wiggins');assert.equal(a.found,true);assert.equal(a.working_hours.source,'manual');assert.equal(a.working_hours.workdays.join(','),MF.join(','));assert.equal(a.working_hours.hoursStart,'08:00');assert.equal(a.working_hours.hoursEnd,'17:00');assert.equal(a.working_hours.timezone,'America/New_York');assert.equal(a.timezone,'America/New_York');assert.equal(a.timezone_set_by,'person');assert.equal(a.state,'Boston');
 const d=await h.memory('Dan Beauregard');assert.equal(d.working_hours.source,'auto');assert.match(d.working_hours.note,/default for their timezone/);assert.equal(d.timezone_set_by,'auto');});
test('HV-memory-note-rank: get_person_memory ranks the stated window above a stale free-text note',async()=>{const i=await harness(PEOPLE).memory('Isaac Levy');
 assert.equal(i.working_hours.source,'manual');assert.equal(i.working_hours.window,'Mon/Thu 09:00–17:00 Asia/Jerusalem');assert.match(i.working_hours.note,/outranks any hours mentioned in notes/);assert.equal(i.notes.length,1);});
test('HV-correction-next-turn: a correction the owner just made is what the store reads back next turn',async()=>{const h=harness(PEOPLE);
 const w=await h.tool('Isaac Levy','UISAAC',{working_hours_structured:{workdays:MF,hoursStart:'09:00',hoursEnd:'19:00'}});assert.equal(w.scheduling_hours.in_force,true);
 const l=line(h.roster(undefined,true),'Isaac Levy');assert.match(l,/, hours: Mon–Fri 09:00–19:00,/);assert.doesNotMatch(l,/Mon\/Thu|Monday and Thursday/);assert.match(h.roster(undefined,true),/1 note on file/);
 const m=await h.memory('Isaac Levy');assert.equal(m.working_hours.window,'Mon–Fri 09:00–19:00 Asia/Jerusalem');});
test('HV-memory-facts-only: get_person_memory finds a person who has only scheduling facts on file',async()=>{const s=await harness(PEOPLE).memory('Sharon Nameonly');assert.equal(s.found,true);assert.equal(s.timezone,'America/New_York');assert.equal(s.state,'Boston');assert.equal(s.working_hours.source,'auto');});
test('HV-control-no-hours: a contact with no timezone and no hours renders unchanged',()=>{const l=line(harness(PEOPLE).roster(),'Erez Hodis');assert.doesNotMatch(l,/hours:|tz:/);assert.match(l,/^Erez Hodis \(slack_id: UEREZ, gender: unknown, language_pref: unknown/);});
test('HV-control-colleague-surfaces: colleague-path blocks still carry no working hours',()=>{const p=harness(PEOPLE).load('src/db/people.ts');
 const thread=p.formatThreadPeopleBlock('UALEX',['ULORI'],'UOWNER');assert.match(thread,/Alex Wiggins/);assert.match(thread,/Lori Sarsfield/);assert.doesNotMatch(thread,/hours|08:00|07:00/);
 const work=p.buildPersonWorkContextBlock('ULORI');assert.match(work,/responds: fast/);assert.doesNotMatch(work,/hours|07:00|East Coast/);});
test('HV-control-colleague-refused: colleague-path get_person_memory stays refused',async()=>{const r=await harness(PEOPLE).memory('Alex Wiggins','colleague');assert.equal(r.error,'not_permitted');});
test('HV-control-unknown: an unknown person still reports no memory',async()=>{const r=await harness(PEOPLE).memory('Nobody Known');assert.equal(r.found,false);});
test('HV-control-write-echo: update_person_profile still echoes the in-force window after a write',async()=>{const w=await harness(PEOPLE).tool('Alex Wiggins','UALEX',{working_hours_structured:{workdays:MF,hoursStart:'07:00',hoursEnd:'15:00',timezone:'America/Los_Angeles'}});
 assert.equal(w.scheduling_hours.in_force,true);assert.equal(w.scheduling_hours.timezone,'America/Los_Angeles');assert.match(w._note,/Mon.*Fri 07:00–15:00 America\/Los_Angeles/);});
test('HV-control-prose-only: a prose-only hours write still reports scheduling unchanged',async()=>{const w=await harness(PEOPLE).tool('Dan Beauregard','UDAN',{working_hours:'mornings only'});assert.equal(w.scheduling_hours.in_force,false);assert.equal(w.scheduling_hours.stored_as,'note');assert.equal(w.scheduling_hours.scheduling_uses.source,'auto');});
test('HV-measure-25: roster size measured on a 25-contact fixture (5 no-tz, 10 default, 10 stated)',()=>{
 const many=Array.from({length:25},(_,i)=>{const k=i%5,name=`Contact ${String(i).padStart(2,'0')} Surname`,id='UCONTACT'+String.fromCharCode(65+i);
  if(k===0)return {slack_id:id,name};
  if(k<3)return {slack_id:id,name,timezone:'America/New_York',timezone_set_by:'auto',working_hours_auto:auto(MF,'09:00','17:00')};
  return {slack_id:id,name,timezone:'Asia/Jerusalem',timezone_set_by:'person',state:'Tel Aviv',profile_json:stated(ST,'09:00','18:00'),working_hours_auto:auto(ST,'09:00','18:00')};});
 const r=harness(many).roster();const lines=r.split('\n').filter(l=>/^Contact \d\d Surname \(/.test(l));assert.equal(lines.length,25);
 console.log(`# roster_chars=${r.length} roster_lines=${lines.length} mode=${before?'before':'after'}`);});
