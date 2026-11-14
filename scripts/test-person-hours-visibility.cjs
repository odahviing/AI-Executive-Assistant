// A person's stored working hours must be readable by the model FROM THE STORE — on the owner
// roster line (formatPeopleMemoryForPrompt) and via get_person_memory — not only from the chat
// history of the turn that wrote them (2026-09-11 owner thread: ~20 sets of hours written, the
// ones older than the 20-message history window read back as "still unconfirmed").
// Actual src/*.ts transpiled in a vm sandbox over an in-memory SQLite; mocks only for I/O.
// LIBRARIAN_BEFORE=1 loads the actual modules from the preserved before revision.
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),cp=require('node:child_process');
const luxon=require('luxon'),Database=require('better-sqlite3');
const sourceRevision = process.argv.includes('--source-revision') ? process.argv[process.argv.indexOf('--source-revision') + 1] : undefined;
const root=path.resolve(__dirname,'..'),baseline='13f50a4dbc23cf2c214112d61d508e536a2aa380',before=process.env.LIBRARIAN_BEFORE==='1',compiled=new Map();
const actual=new Set(['src/db/engagementRank.ts','src/memory/resolveAttendeeEmails.ts','src/db/people.ts','src/core/assistant.ts','src/utils/resolvePersonTarget.ts','src/utils/workingHoursDefault.ts','src/utils/locationTz.ts','src/utils/timezoneValidator.ts']);
const {regularWeek}=require('./fixtures/regular-week.cjs');
const WEEK=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],MF=WEEK.slice(1,6),ST=WEEK.slice(0,5);
const auto=(workdays,hoursStart,hoursEnd)=>JSON.stringify({workdays,hoursStart,hoursEnd});
const stated=(workdays,hoursStart,hoursEnd,timezone,extra={})=>JSON.stringify({...extra,working_hours_structured:{week:regularWeek(workdays,hoursStart,hoursEnd),source:'manual',...(timezone?{timezone}:{})}});
const COLS='person_id,slack_id,name,name_set_by,email,email_set_by,kind,source,org,is_vip,timezone,timezone_set_by,timezone_temp,state,state_set_by,name_he,name_he_set_by,gender,gender_set_by,gender_confirmed,last_inbound_lang,last_inbound_lang_at,profile_json,working_hours_auto,currently_traveling,notes,interaction_log,engagement_rank,proactive_pending,last_social_at,last_seen,created_at,updated_at'.split(',');
function harness(people){
 const sqlite=new Database(':memory:');
 sqlite.exec(`CREATE TABLE people_memory(${COLS.map(c=>c==='person_id'?'person_id TEXT PRIMARY KEY':c==='slack_id'?'slack_id TEXT UNIQUE':['engagement_rank','is_vip'].includes(c)?c+' INTEGER':c+' TEXT').join(',')})`);
 sqlite.exec('CREATE TABLE engagement_rank_log (id TEXT PRIMARY KEY, slack_id TEXT, delta INTEGER, new_rank INTEGER, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
 const ins=sqlite.prepare(`INSERT INTO people_memory(${COLS.join(',')}) VALUES(${COLS.map(c=>'@'+c).join(',')})`);
 for(const p of people){
  const row=Object.fromEntries(COLS.map(c=>[c,null]));
  Object.assign(row,{person_id:'p_'+(p.slack_id||p.name.replace(/\W/g,'_')),kind:p.slack_id?'internal':'external',gender:'unknown',gender_confirmed:0,profile_json:'{}',notes:'[]',interaction_log:'[]',last_seen:new Date().toISOString()},p);
  if(row.working_hours_auto && !JSON.parse(row.profile_json).working_hours_structured){const a=JSON.parse(row.working_hours_auto);row.profile_json=JSON.stringify({...JSON.parse(row.profile_json),working_hours_structured:{week:regularWeek(a.workdays,a.hoursStart,a.hoursEnd),source:'auto'}});row.working_hours_auto=null;}
  ins.run(row);
 }
 const profile={user:{name:'Owner Example',slack_user_id:'UOWNER',email:'owner@example.com',timezone:'Asia/Jerusalem'},assistant:{name:'Maelle'}};
 const noop=()=>{},modules=new Map();
 const mocks={
  'src/db/client.ts':{getDb:()=>sqlite},'src/db/socialSubjects.ts':{},
  'src/config/userProfile.ts':{getTenantWorkdaysForTimezone:tz=>tz==='Asia/Jerusalem'?ST:undefined},
  'src/utils/logger.ts':{__esModule:true,default:{info:noop,debug:noop,warn:noop,error:noop}},
  'src/connections/registry.ts':{getConnection:()=>undefined},
  'src/memory/peopleMemory.ts':{syncPersonOperationalSections:async()=>true,readPersonMemory:async()=>null,writePersonSection:async()=>({ok:true}),resolvePersonSlug:async()=>null},
  'src/utils/skillPreferences.ts':{},
  'src/utils/resolveSlackId.ts':{SLACK_ID_RE:/^U[A-Z]+$/,resolveSlackId:id=>({slack_id:id||undefined,was_hallucinated:false})},

 };
 function load(rel){
  if(rel==='src/db.ts')return {...load('src/db/people.ts'),...load('src/db/engagementRank.ts'),getDb:()=>sqlite,getPersonSocialSummary:()=>({live:[],dead:[]})};
  if(Object.hasOwn(mocks,rel))return mocks[rel];if(modules.has(rel))return modules.get(rel).exports;
  if(!actual.has(rel))throw Error('Unhandled actual module '+rel);
  if(!compiled.has(rel)){
   const saved = process.env.HOURS_BATCH_BEFORE && ({'src/db/people.ts':'people.before.ts','src/utils/workingHoursDefault.ts':'workingHoursDefault.before.ts'})[rel];
   const overlay = process.env.PROFILE_RECEIPT_SOURCE && path.join(root, process.env.PROFILE_RECEIPT_SOURCE, rel);
   const source=overlay && fs.existsSync(overlay) ? fs.readFileSync(overlay, 'utf8') : sourceRevision ? cp.execFileSync('git',['show',sourceRevision+':'+rel],{cwd:root,encoding:'utf8'}) : saved?fs.readFileSync(path.join(root,process.env.HOURS_BATCH_BEFORE,saved),'utf8'):before?cp.execFileSync('git',['show',baseline+':'+rel],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,rel),'utf8');
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
  tool:(name,slackId,args,role='owner',surface)=>skill().executeToolCall('update_person_profile',{colleague_name:name,colleague_slack_id:slackId,...args},{...ctx(role),...(surface ? {surface} : {})})};
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
 const alex=line(r,'Alex Wiggins');assert.match(alex,/, hours: Mon–Fri 08:00–17:00; Sun\/Sat off, email:/);assert.doesNotMatch(alex,/tz default/);
 const lori=line(r,'Lori Sarsfield');assert.match(lori,/, hours: Mon–Fri 07:00–16:00; Sun\/Sat off America\/New_York,/);assert.doesNotMatch(lori,/East Coast|Wed\/Fri/);
 assert.match(line(r,'Maayan Cohen'),/, hours: Sun–Thu 10:00–20:00; Fri–Sat off,/);});
test('HV-roster-default: owner roster marks the timezone default as not stated',()=>{const r=harness(PEOPLE).roster();
 assert.match(line(r,'Dan Beauregard'),/, hours: Mon–Fri 09:00–17:00; Sun\/Sat off \(tz default, not stated\),/);
 assert.match(line(r,'Kevin External'),/external — no Slack account.*, hours: Mon–Fri 09:00–17:00; Sun\/Sat off \(tz default, not stated\),/);});
test('HV-roster-social-off: the slim social-off roster line carries the same window',()=>{const h=harness(PEOPLE);assert.match(line(h.roster(undefined,true),'Alex Wiggins'),/hours: Mon–Fri 08:00–17:00/);assert.match(line(h.roster(new Set(['UALEX']),true),'Alex Wiggins'),/hours: Mon–Fri 08:00–17:00/);});
test('HV-memory-effective: get_person_memory returns the effective window with its zone and provenance',async()=>{const h=harness(PEOPLE);
 const a=await h.memory('Alex Wiggins');assert.equal(a.found,true);assert.equal(a.working_hours.source,'manual');assert.equal(Object.keys(a.working_hours.week).filter(d=>a.working_hours.week[d].length).join(','),MF.join(','));assert.equal(a.working_hours.week.Monday[0].hoursStart,'08:00');assert.equal(a.working_hours.week.Monday[0].hoursEnd,'17:00');assert.equal(a.working_hours.timezone,'America/New_York');assert.equal(a.timezone,'America/New_York');assert.equal(a.timezone_set_by,'person');assert.equal(a.state,'Boston');
 const d=await h.memory('Dan Beauregard');assert.equal(d.working_hours.source,'auto');assert.match(d.working_hours.note,/initialized from timezone defaults once/);assert.equal(d.timezone_set_by,'auto');});
test('HV-memory-note-rank: get_person_memory ranks the stated window above a stale free-text note',async()=>{const i=await harness(PEOPLE).memory('Isaac Levy');
 assert.equal(i.working_hours.source,'manual');assert.equal(i.working_hours.window,'Mon/Thu 09:00–17:00; Sun/Tue/Wed/Fri/Sat off Asia/Jerusalem');assert.match(i.working_hours.note,/outranks any hours mentioned in notes/);assert.equal(i.notes.length,1);});
test('HV-correction-next-turn: a correction the owner just made is what the store reads back next turn',async()=>{const h=harness(PEOPLE);
 const w=await h.tool('Isaac Levy','UISAAC',{working_hours_structured:{week:regularWeek(MF,'09:00','19:00')}});assert.equal(w.scheduling_hours.in_force,true);
 const l=line(h.roster(undefined,true),'Isaac Levy');assert.match(l,/, hours: Mon–Fri 09:00–19:00; Sun\/Sat off,/);assert.doesNotMatch(l,/Mon\/Thu|Monday and Thursday/);assert.match(h.roster(undefined,true),/1 note on file/);
 const m=await h.memory('Isaac Levy');assert.equal(m.working_hours.window,'Mon–Fri 09:00–19:00; Sun/Sat off Asia/Jerusalem');});
test('HV-memory-facts-only: get_person_memory finds a person who has only scheduling facts on file',async()=>{const s=await harness(PEOPLE).memory('Sharon Nameonly');assert.equal(s.found,true);assert.equal(s.timezone,'America/New_York');assert.equal(s.state,'Boston');assert.equal(s.working_hours.source,'auto');});
test('HV-control-no-hours: a contact with no timezone and no hours renders unchanged',()=>{const l=line(harness(PEOPLE).roster(),'Erez Hodis');assert.doesNotMatch(l,/hours:|tz:/);assert.match(l,/^Erez Hodis \(slack_id: UEREZ, gender: unknown, language_pref: unknown/);});
test('HV-control-colleague-surfaces: colleague-path blocks still carry no working hours',()=>{const p=harness(PEOPLE).load('src/db/people.ts');
 const thread=p.formatThreadPeopleBlock('UALEX',['ULORI'],'UOWNER');assert.match(thread,/Alex Wiggins/);assert.match(thread,/Lori Sarsfield/);assert.doesNotMatch(thread,/hours|08:00|07:00/);
 const work=p.buildPersonWorkContextBlock('ULORI');assert.match(work,/responds: fast/);assert.doesNotMatch(work,/hours|07:00|East Coast/);});
test('HV-control-colleague-refused: colleague-path get_person_memory stays refused',async()=>{const r=await harness(PEOPLE).memory('Alex Wiggins','colleague');assert.equal(r.error,'not_permitted');});
test('HV-control-unknown: an unknown person still reports no memory',async()=>{const r=await harness(PEOPLE).memory('Nobody Known');assert.equal(r.found,false);});
test('HV-control-write-echo: update_person_profile still echoes the in-force window after a write',async()=>{const w=await harness(PEOPLE).tool('Alex Wiggins','UALEX',{working_hours_structured:{week:regularWeek(MF,'07:00','15:00'),timezone:'America/Los_Angeles'}});
 assert.equal(w.scheduling_hours.in_force,true);assert.equal(w.scheduling_hours.timezone,'America/Los_Angeles');assert.match(w._note,/Mon.*Fri 07:00–15:00; Sun\/Sat off America\/Los_Angeles/);});
test('HV-control-prose-only: a prose-only hours write still reports scheduling unchanged',async()=>{const w=await harness(PEOPLE).tool('Dan Beauregard','UDAN',{working_hours:'mornings only'});assert.equal(w.updated,false);assert.equal(w.error,'retired_working_hours');});
test('HV-measure-25: roster size measured on a 25-contact fixture (5 no-tz, 10 default, 10 stated)',()=>{
 const many=Array.from({length:25},(_,i)=>{const k=i%5,name=`Contact ${String(i).padStart(2,'0')} Surname`,id='UCONTACT'+String.fromCharCode(65+i);
  if(k===0)return {slack_id:id,name};
  if(k<3)return {slack_id:id,name,timezone:'America/New_York',timezone_set_by:'auto',working_hours_auto:auto(MF,'09:00','17:00')};
  return {slack_id:id,name,timezone:'Asia/Jerusalem',timezone_set_by:'person',state:'Tel Aviv',profile_json:stated(ST,'09:00','18:00'),working_hours_auto:auto(ST,'09:00','18:00')};});
 const r=harness(many).roster();const lines=r.split('\n').filter(l=>/^Contact \d\d Surname \(/.test(l));assert.equal(lines.length,25);
 console.log(`# roster_chars=${r.length} roster_lines=${lines.length} mode=${before?'before':'after'}`);});

test('DH incremental owner windows preserve siblings and default after reload',()=>{
 const h=harness(PEOPLE),p=h.load('src/db/people.ts'),w=h.load('src/utils/workingHoursDefault.ts');
 p.updatePersonProfile('UALEX',{working_hours_structured:{week:{Monday:[{hoursStart:'08:00',hoursEnd:'14:00'}]}}},'owner');
 p.updatePersonProfile('UALEX',{working_hours_structured:{week:{Tuesday:[{hoursStart:'10:00',hoursEnd:'16:00'}]}}},'owner');
 const row=p.getPersonMemory('UALEX'),eff=w.getEffectiveWorkingHours(row);
 assert.equal(eff.week.Wednesday[0].hoursStart,'08:00'); assert.equal(eff.week.Wednesday[0].hoursEnd,'17:00');
 assert.equal(eff.week.Monday[0].hoursEnd,'14:00'); assert.equal(eff.week.Tuesday[0].hoursStart,'10:00');
 assert.ok(w.describeEffectiveWorkingHours(row).window.includes('Mon 08:00–14:00; Tue 10:00–16:00'));
 const replay=p.updatePersonProfile('UALEX',{working_hours_structured:{week:{Tuesday:[{hoursStart:'10:00',hoursEnd:'16:00'}]}}},'owner');
 assert.equal(w.getEffectiveWorkingHours(p.getPersonMemory('UALEX')).week.Monday[0].hoursEnd,'14:00');
});
test('DH day-only initial write uses region defaults and explicit non-default weekday',()=>{
 const h=harness(PEOPLE),p=h.load('src/db/people.ts'),w=h.load('src/utils/workingHoursDefault.ts');
 p.updatePersonProfile('UDAN',{working_hours_structured:{week:{Sunday:[{hoursStart:'10:00',hoursEnd:'16:00'}]}}},'person');
 const eff=w.getEffectiveWorkingHours(p.getPersonMemory('UDAN'));
 assert.equal(eff.source,'manual'); assert.equal(eff.week.Monday[0].hoursStart,'09:00'); assert.ok(eff.week.Sunday); assert.equal(eff.week.Sunday[0].hoursEnd,'16:00');
});
test('DH invalid weekday or clock cannot replace durable valid hours',()=>{
 const h=harness(PEOPLE),p=h.load('src/db/people.ts');
 for(const patch of [{week:{Tuesday:[{hoursStart:'late',hoursEnd:'16:00'}]}},{week:{Funday:[{hoursStart:'10:00',hoursEnd:'16:00'}]}}]) {
  const original=p.getPersonMemory('UALEX').profile_json;
  assert.throws(()=>p.updatePersonProfile('UALEX',{working_hours_structured:patch},'owner'));
  assert.equal(p.getPersonMemory('UALEX').profile_json,original);
 }
});
test('DH lower authority cannot amend owner day overrides; unknown timezone cannot invent default',()=>{
 const h=harness(PEOPLE),p=h.load('src/db/people.ts'),w=h.load('src/utils/workingHoursDefault.ts');
 p.updatePersonProfile('UALEX',{working_hours_structured:{week:{Tuesday:[{hoursStart:'10:00',hoursEnd:'16:00'}]}}},'owner');
 assert.equal(p.updatePersonProfile('UALEX',{working_hours_structured:{week:{Monday:[{hoursStart:'06:00',hoursEnd:'12:00'}]}}},'person').working_hours_structured,'refused_lower_authority');
 assert.equal(w.getEffectiveWorkingHours(p.getPersonMemory('UALEX')).week.Monday[0].hoursStart,'08:00');
 assert.throws(()=>p.updatePersonProfile('UEREZ',{working_hours_structured:{week:{Tuesday:[{hoursStart:'10:00',hoursEnd:'16:00'}]}}},'owner'));
 assert.equal(w.getEffectiveWorkingHours(p.getPersonMemory('UEREZ')),null);
});

const captureInfoLogs = h => {
  const entries = [];
  h.load('src/utils/logger.ts').default.info = (message, details) => entries.push({ message, ...details });
  return entries;
};

test('effective hours retry and lower-authority matching subset preserve the canonical week', async () => {
  const h = harness(PEOPLE);
  try {
    const p = h.load('src/db/people.ts');
    const changes = { working_hours_structured: { week: {
      Monday: [{ hoursStart: '08:00', hoursEnd: '12:00' }, { hoursStart: '14:00', hoursEnd: '19:00' }],
      Friday: [],
    }, timezone: 'Europe/London' } };
    const first = await h.tool('Alex Wiggins', 'UALEX', changes);
    assert.equal(first.updated, true);
    assert.equal(first._slot_results_now_stale, true);
    assert.match(first.scheduling_hours.window, /Mon 08:00–12:00, 14:00–19:00/);
    const original = p.getPersonMemory('UALEX').profile_json;
    const stored = JSON.parse(original).working_hours_structured;
    assert.deepEqual(stored.week.Tuesday, [{ hoursStart: '08:00', hoursEnd: '17:00' }]);
    assert.deepEqual(stored.week.Friday, []);
    assert.equal(stored.timezone, 'Europe/London');
    for (const role of ['owner', 'colleague']) {
      const result = await h.tool('Alex Wiggins', 'UALEX', {working_hours_structured: {week: {Friday: []}}}, role);
      assert.equal(result.updated, false);
      assert.ok(result.already_set.includes('working_hours_structured'));
      assert.equal(result.scheduling_hours.in_force, true);
      assert.equal(p.getPersonMemory('UALEX').profile_json, original);
    }
  } finally { h.sqlite.close(); }
});

test('a higher authority may promote the same schedule and a conflicting lower authority is refused', async () => {
  const h = harness(PEOPLE);
  try {
    const p = h.load('src/db/people.ts');
    const patch = {working_hours_structured: {week: {Monday: [{hoursStart: '08:00', hoursEnd: '17:00'}]}}};
    const promoted = await h.tool('Alex Wiggins', 'UALEX', patch);
    assert.equal(promoted.updated, true);
    const after = p.getPersonMemory('UALEX').profile_json;
    assert.equal(JSON.parse(after)._set_by.working_hours_structured, 'owner');
    const denied = await h.tool('Alex Wiggins', 'UALEX', {working_hours_structured: {week: {Monday: []}}}, 'colleague');
    assert.equal(denied.updated, false);
    assert.equal(denied.scheduling_hours.in_force, false);
    assert.ok(denied.not_saved.includes('working_hours_structured'));
    assert.equal(p.getPersonMemory('UALEX').profile_json, after);
  } finally { h.sqlite.close(); }
});

test('refused or already-set fields do not announce a changed scheduling constraint', async () => {
  const h = harness(PEOPLE);
  try {
    const messages = captureInfoLogs(h);
    await h.tool('Alex Wiggins', 'UALEX', {timezone: 'Europe/London'});
    for (const zone of ['America/New_York', 'Europe/London']) {
      messages.length = 0;
      const r = await h.tool('Alex Wiggins', 'UALEX', {timezone: zone}, 'colleague');
      assert.equal(r.updated, false);
      assert.equal(r._slot_results_now_stale, undefined);
      assert.doesNotMatch(r._note || '', /You updated slot-relevant fields/);
      const receipt = messages.find(entry => entry.message === 'Person profile write result');
      assert.ok(receipt);
      assert.ok(!receipt.fields.includes('timezone'));
      assert.equal(receipt.outcomes.timezone, zone === 'Europe/London' ? 'already_set' : 'refused_lower_authority');
    }
  } finally { h.sqlite.close(); }
});

test('external applied hours require a new search and a retry does not', async () => {
  const h = harness(PEOPLE);
  try {
    const patch = {working_hours_structured: {week: {Monday: [{hoursStart: '07:30', hoursEnd: '13:15'}]}}};
    const r = await h.tool('Kevin External', undefined, patch);
    assert.equal(r.updated, true);
    assert.equal(r._slot_results_now_stale, true);
    assert.ok(r.scheduling_hours.in_force);
    const retry = await h.tool('Kevin External', undefined, patch);
    assert.equal(retry.updated, false);
    assert.equal(retry._slot_results_now_stale, undefined);
  } finally { h.sqlite.close(); }
});

test('ordinary applied scheduling field and non-scheduling change remain distinct', async () => {
  const h = harness(PEOPLE);
  try {
    const r = await h.tool('Alex Wiggins', 'UALEX', {timezone: 'Europe/London'});
    assert.equal(r.updated, true);
    assert.equal(r._slot_results_now_stale, true);
    const other = await h.tool('Alex Wiggins', 'UALEX', {role_summary: 'Release coordinator'});
    assert.equal(other.updated, true);
    assert.equal(other._slot_results_now_stale, undefined);
  } finally { h.sqlite.close(); }
});

test('unknown or missing identity cannot report a changed schedule', async () => {
  const h = harness(PEOPLE);
  try {
    const absent = await h.tool('Missing Example', undefined, {timezone: 'Europe/London'});
    assert.equal(absent.error, 'unknown_colleague');
    assert.equal(absent._slot_results_now_stale, undefined);
    const store = h.load('src/db/people.ts');
    assert.deepEqual(Object.keys(store.updatePersonProfileById('p_absent', {working_hours_structured: {week: {Friday: []}}}, 'owner')), []);
  } finally { h.sqlite.close(); }
});

test('owner room mixed field outcomes retain only a confirmed scheduling change', async () => {
  const h = harness(PEOPLE);
  try {
    const messages = captureInfoLogs(h);
    const updated = await h.tool('Alex Wiggins', 'UALEX', {timezone: 'Europe/London', role_summary: 'Engineer'}, 'owner', 'room');
    assert.ok(updated._slot_results_now_stale);
    const mixed = await h.tool('Alex Wiggins', 'UALEX', {timezone: 'Europe/London', role_summary: 'Director'}, 'owner', 'room');
    assert.equal(mixed.updated, true);
    assert.ok(mixed.already_set.includes('timezone'));
    assert.equal(mixed._slot_results_now_stale, undefined);
    const receipt = messages.filter(entry => entry.message === 'Person profile write result').at(-1);
    assert.deepEqual(Array.from(receipt.fields), ['role_summary']);
    const hours = await h.tool('Alex Wiggins', 'UALEX', {working_hours_structured: {week: {Tuesday: []}}}, 'owner', 'room');
    assert.equal(hours.scheduling_hours.in_force, true);
  } finally { h.sqlite.close(); }
});

test('promoting timezone authority alone leaves the same scheduling inputs in force', async () => {
  const h = harness(PEOPLE);
  try {
    const result = await h.tool('Alex Wiggins', 'UALEX', {timezone: 'America/New_York'});
    assert.equal(result.updated, true);
    assert.equal(result._slot_results_now_stale, undefined);
    assert.equal(h.load('src/db/people.ts').getPersonMemory('UALEX').timezone_set_by, 'owner');
  } finally { h.sqlite.close(); }
});

test('dated visitor with a new fixed home frame invalidates earlier slots, and replay preserves them', async () => {
  const h = harness(PEOPLE);
  try {
    const travel = {location: 'London', from: '2026-12-01', until: '2026-12-10', source: 'owner'};
    h.sqlite.prepare('UPDATE people_memory SET currently_traveling=? WHERE person_id=?').run(JSON.stringify(travel), 'p_UALEX');
    const fixed = {working_hours_structured: {week: {Monday: [{hoursStart: '08:00',hoursEnd: '17:00'}]}, timezone: 'America/New_York'}};
    const result = await h.tool('Alex Wiggins', 'UALEX', fixed);
    assert.equal(result.updated, true);
    assert.equal(result._slot_results_now_stale, true);
    const row = h.load('src/db/people.ts').getPersonMemory('UALEX');
    assert.equal(JSON.parse(row.profile_json).working_hours_structured.timezone, 'America/New_York');
    assert.equal(JSON.parse(row.currently_traveling).location, 'London');
    const retry = await h.tool('Alex Wiggins', 'UALEX', fixed);
    assert.equal(retry.updated, false);
    assert.equal(retry._slot_results_now_stale, undefined);
  } finally { h.sqlite.close(); }
});

for (const [name, id, personId] of [['Alex Wiggins', 'UALEX', 'p_UALEX'], ['Kevin External', undefined, 'p_Kevin_External']]) {
  test('mixed invalid hours preserve and acknowledge accepted fields on ' + name, async () => {
    const h = harness(PEOPLE);
    try {
      const store = h.load('src/db/people.ts');
      const originalHours = JSON.parse(store.getPersonById(personId).profile_json).working_hours_structured;
      const patch = {timezone: 'Europe/Paris', role_summary: 'Director', working_hours_structured: {week: {Monday: [{hoursStart: '25:00',hoursEnd: '26:00'}]}}};
      const result = await h.tool(name, id, patch);
      assert.equal(result.updated, true);
      assert.equal(result._slot_results_now_stale, true);
      assert.deepEqual(Array.from(result.not_saved), ['working_hours_structured']);
      assert.equal(result.scheduling_hours.in_force, false);
      const row = store.getPersonById(personId);
      assert.equal(row.timezone, 'Europe/Paris');
      const stored = JSON.parse(row.profile_json);
      assert.equal(stored.role_summary, 'Director');
      assert.deepEqual(stored.working_hours_structured, originalHours);
      const retry = await h.tool(name, id, patch);
      assert.equal(retry.updated, false);
      assert.equal(retry._slot_results_now_stale, undefined);
      assert.ok(retry.already_set.includes('timezone'));
      assert.deepEqual(Array.from(retry.not_saved), ['working_hours_structured']);
    } finally { h.sqlite.close(); }
  });
}

test('single malformed hours still rejects without a changed stored schedule', async () => {
  const h = harness(PEOPLE);
  try {
    const store = h.load('src/db/people.ts'), original = store.getPersonMemory('UALEX').profile_json;
    await assert.rejects(h.tool('Alex Wiggins', 'UALEX', {working_hours_structured: {week: {Friday: [{hoursStart: 'invalid', hoursEnd: '16:00'}]}}}), /Invalid working hours/);
    assert.equal(store.getPersonMemory('UALEX').profile_json, original);
  } finally { h.sqlite.close(); }
});

for (const [name, slackId, personId] of [['Alex Wiggins', 'UALEX', 'p_UALEX'], ['Kevin External', undefined, 'p_Kevin_External']]) {
  test('VIP changes gate thread scheduling, repeated marks and clears do not: ' + name, async () => {
    const h = harness(PEOPLE);
    try {
      const logs = captureInfoLogs(h);
      const original = await h.tool(name, slackId, {vip: false});
      assert.equal(original.updated, false);
      assert.ok(original.already_set.includes('vip'));
      for (const vip of [true, false]) {
        const changed = await h.tool(name, slackId, {vip});
        assert.equal(changed.updated, true);
        assert.equal(changed._slot_results_now_stale, true);
        assert.equal(h.load('src/db/people.ts').getPersonById(personId).is_vip, Number(vip));
        const repeat = await h.tool(name, slackId, {vip});
        assert.equal(repeat.updated, false);
        assert.ok(repeat.already_set.includes('vip'));
        assert.equal(repeat._slot_results_now_stale, undefined);
        const receipt = logs.filter(entry => entry.message === 'Person profile write result').at(-1);
        assert.deepEqual(Array.from(receipt.fields), []);
        assert.equal(receipt.outcomes.vip, 'already_set');
      }
    } finally { h.sqlite.close(); }
  });
}

test('recording identical timezone defaults persists authority without making previous slots stale', async () => {
  for (const legacy of [false, true]) {
    const h = harness(PEOPLE);
    try {
      if (legacy) h.sqlite.prepare("UPDATE people_memory SET profile_json='{}' WHERE slack_id='UDAN'").run();
      const request = {working_hours_structured: {week: {Monday: [{hoursStart: '09:00', hoursEnd: '17:00'}]}}};
      const r = await h.tool('Dan Beauregard', 'UDAN', request);
      assert.equal(r.updated, true);
      assert.equal(r._slot_results_now_stale, undefined);
      assert.equal(r.scheduling_hours.source, 'manual');
      const row = h.load('src/db/people.ts').getPersonMemory('UDAN');
      assert.equal(JSON.parse(row.profile_json)._set_by.working_hours_structured, 'owner');
      const changed = await h.tool('Dan Beauregard', 'UDAN', {working_hours_structured: {week: {Monday: [{hoursStart: '09:00', hoursEnd: '19:00'}]}}});
      assert.equal(changed._slot_results_now_stale, true);
    } finally { h.sqlite.close(); }
  }
});

test('owner rank reports only changed rank and leaves slot constraints alone', async () => {
  const h = harness(PEOPLE);
  try {
    const first = await h.tool('Alex Wiggins','UALEX',{engagement_rank: 3});
    assert.equal(first.updated, true);
    assert.equal(first._slot_results_now_stale, undefined);
    const repeat = await h.tool('Alex Wiggins','UALEX',{engagement_rank: 4});
    assert.equal(repeat.updated, false);
    assert.ok(repeat.already_set.includes('engagement_rank'));
    assert.equal(repeat._slot_results_now_stale, undefined);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM engagement_rank_log').get().n, 1);
    const denied = await h.tool('Alex Wiggins','UALEX',{engagement_rank: 0, vip: true},'colleague');
    assert.equal(denied.updated, false);
    assert.equal(h.load('src/db/people.ts').getPersonMemory('UALEX').engagement_rank, 3);
  } finally { h.sqlite.close(); }
});
