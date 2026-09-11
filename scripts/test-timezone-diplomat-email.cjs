const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const {DateTime, Settings, IANAZone} = require('luxon'), Database = require('better-sqlite3');
// Actual email producer/store regressions, with optional preserved-source replay.
const root = path.resolve(__dirname, '..');
const actual = new Set([
  'src/connectors/email/inbound.ts',
  'src/connections/email/ownerAddresses.ts',
  'src/connectors/email/htmlToText.ts',
  'src/db/people.ts',
  'src/utils/attendeeAvailability.ts',
  'src/utils/locationTz.ts',
  'src/utils/workingHoursDefault.ts',
  'src/utils/timezoneValidator.ts',
  'src/utils/timezoneConvert.ts',
  'src/utils/workHours.ts',
]);
const compiled = new Map();
let now;
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
Settings.now = () => now;

function harness(options = {}) {
  now = Date.parse(options.now || '2026-09-11T12:00:00Z');
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE people_memory(person_id TEXT PRIMARY KEY,slack_id TEXT UNIQUE,name TEXT,email TEXT,kind TEXT,source TEXT,timezone TEXT,timezone_set_by TEXT,state TEXT,state_set_by TEXT,name_set_by TEXT,name_he TEXT,name_he_set_by TEXT,gender TEXT,gender_set_by TEXT,gender_confirmed INTEGER DEFAULT 0,profile_json TEXT,working_hours_auto TEXT,currently_traveling TEXT,timezone_temp TEXT,last_seen TEXT,updated_at TEXT);`);
  sqlite.exec('ALTER TABLE people_memory ADD COLUMN email_set_by TEXT');
  const row = {person_id:'external_fixture',slack_id:null,name:'External',email:'external@other.example',kind:'external',timezone:'Europe/London',timezone_set_by:'person',profile_json:'{}',working_hours_auto:JSON.stringify({workdays:['Monday','Tuesday','Wednesday','Thursday','Friday'],hoursStart:'09:00',hoursEnd:'17:00'}),...options.person};
  sqlite.prepare(`INSERT INTO people_memory(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(k=>'@'+k).join(',')})`).run(row);
  const profile = {user:{name:'Owner',slack_user_id:'UOWNER',email:'owner@example.com',timezone:options.ownerTimezone || 'Asia/Jerusalem'},assistant:{name:'Maelle',email:'assistant@example.com'},channels:{email:{enabled:true,mailbox:'assistant@example.com',owner_aliases:['alias@example.com']}}};
  const message = {id:'mail_fixture',conversationId:'chain_fixture',from:options.sender || profile.user.email,replyTo:[],subject:'fixture',bodyContentType:'text',body:'Forwarded fixture',uniqueBodyContentType:'text',uniqueBody:options.uniqueBody || ''};
  const counts = {extract:0,orchestrator:0,gate:0}, sends=[],notifications=[],history=[],logs=[],modules=new Map();
  let handler;
  const noop=()=>{};
  const hints = options.hints ?? [{email:row.email,statedTimezone:options.statedTimezone || 'Tokyo'}];
  const connection = {sendDirect:async (...args)=>{sends.push(args); return options.sendFailure ? {ok:false,reason:'fixture failure'} : {ok:true};}};
  const mocks = {
    'src/config.ts':{config:{}},
    'src/llm/client.ts':{getAnthropicClient:()=>{throw Error('Unexpected model call');}}, 'src/llm/models.ts':{},
    'src/db/client.ts':{getDb:()=>sqlite}, 'src/db/socialSubjects.ts':{}, 'src/db/engagementRank.ts':{},
    'src/db/scheduleOverrides.ts':{getScheduleOverride:()=>null},
    'src/config/userProfile.ts':{getTenantWorkdaysForTimezone:()=>undefined},
    'src/utils/logger.ts':{__esModule:true,default:{info:(...a)=>logs.push(a),warn:noop,error:noop,debug:noop}},
    'src/connectors/graph/mailInboundRegistry.ts':{registerMailInbound:(_id,fn)=>{handler=fn;}},
    'src/connections/email.ts':{createEmailConnection:()=>connection},
    'src/connections/registry.ts':{registerConnection:noop,getConnection:()=>options.noSlack ? undefined : {sendDirect:async(...a)=>{notifications.push(a);return {ok:true};}}},
    'src/utils/offeredSlotsStash.ts':{EMAIL_KEY_PREFIX:'email:'},
    'src/memory/recordBooking.ts':{isNonHumanAttendee:()=>false},
    'src/connectors/email/extractParticipants.ts':{extractForwardedParticipants:async()=>{counts.extract++;if(options.extractFailure)throw Error('fixture extraction failure');return {participants:[row.email],timezoneHints:hints};}},
    'src/core/orchestrator.ts':{runOrchestrator:async input=>{counts.orchestrator++;assert.equal(input.channel,'email');assert.deepEqual(Array.from(input.extractedAttendeeEmails),[row.email]);return {reply:'Fixture reply'};}},
    'src/utils/guards/runOutputGates.ts':{runOutputGates:async(reply,args)=>{counts.gate++;assert.equal(args.transport,'email');return reply;}},
  };
  function load(rel) {
    if(rel==='src/db.ts'){const people=load('src/db/people.ts');return {...people,getTravelRecordById:(...args)=>{const result=people.getTravelRecordById(...args);if(options.removeBeforeTravelWrite)sqlite.prepare('DELETE FROM people_memory WHERE person_id=?').run(row.person_id);return result;},getConversationHistory:()=>[],appendToConversation:(...args)=>history.push(args)};}
    if(Object.hasOwn(mocks,rel))return mocks[rel];
    if(modules.has(rel))return modules.get(rel).exports;
    if(!actual.has(rel))throw Error('Unhandled module '+rel);
    if(!compiled.has(rel)) {
      const saved=process.env.DIPLOMAT_SNAPSHOT&&path.join(root,process.env.DIPLOMAT_SNAPSHOT,rel);
      const source = fs.readFileSync(saved&&fs.existsSync(saved)?saved:path.join(root,rel),'utf8');
      compiled.set(rel,ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
    }
    const mod={exports:{}};modules.set(rel,mod);
    const req=s=>s==='luxon'?{DateTime,Settings,IANAZone}:s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):require(s);
    vm.runInNewContext('(function(require,module,exports){'+compiled.get(rel)+'\n})',{Date:Clock,console,Set,Map,Buffer,setTimeout},{filename:rel})(req,mod,mod.exports);
    return mod.exports;
  }
  load('src/connectors/email/inbound.ts').startEmailChannel(profile);
  const person=()=>sqlite.prepare('SELECT * FROM people_memory WHERE person_id=?').get(row.person_id);
  const travel=()=>JSON.parse(person().currently_traveling || 'null');
  const onDay=day=>{const a=load('src/utils/attendeeAvailability.ts');const entries=a.loadAttendeeAvailabilityForEmails([row.email],profile.user.email,profile.user.timezone);assert.equal(entries.length,1);return a.attendeeTzForDay(entries[0],day);};
  return {run:()=>handler(profile,message),person,travel,onDay,counts,sends,notifications,history,logs,load,sqlite,setNow:instant=>{now=Date.parse(instant);}};
}

test('western destination final day survives UTC midnight without hint overwrite',async()=>{
 const trip={location:'Boston',from:'2026-09-09',until:'2026-09-14',source:'person'};
 const h=harness({now:'2026-09-15T02:00Z',ownerTimezone:'America/Los_Angeles',person:{currently_traveling:JSON.stringify(trip)}});
 await h.run();assert.deepEqual(h.travel(),trip);assert.equal(h.onDay('2026-09-14'),'America/New_York');assert.equal(h.onDay('2026-09-15'),'Europe/London');
});
test('eastern owner date cannot expire an active western destination trip',async()=>{
 const h=harness({now:'2026-09-14T22:00Z',person:{currently_traveling:JSON.stringify({location:'Boston',from:'2026-09-09',until:'2026-09-14',source:'person'})}});
 await h.run();assert.deepEqual(h.travel(),{location:'Boston',from:'2026-09-09',until:'2026-09-14',source:'person'});assert.equal(h.onDay('2026-09-14T22:00:00Z'),'America/New_York');assert.equal(h.notifications.length,0);
});
test('western owner new window starts on destination day and returns home after existing plus14 bound',async()=>{
 const h=harness({now:'2026-09-15T02:00Z',ownerTimezone:'America/Los_Angeles'});await h.run();
 assert.deepEqual(h.travel(),{location:'Tokyo',from:'2026-09-15',until:'2026-09-29',source:'auto'});assert.equal(h.onDay('2026-09-14'),'Europe/London');assert.equal(h.onDay('2026-09-15'),'Asia/Tokyo');assert.equal(h.onDay('2026-09-29'),'Asia/Tokyo');assert.equal(h.onDay('2026-09-30'),'Europe/London');assert.equal(h.person().timezone,'Europe/London');
});
test('eastern destination new window starts before UTC midnight',async()=>{
 const h=harness({now:'2026-09-14T22:00Z'});await h.run();assert.deepEqual(h.travel(),{location:'Tokyo',from:'2026-09-15',until:'2026-09-29',source:'auto'});assert.equal(h.onDay('2026-09-14'),'Europe/London');assert.equal(h.onDay('2026-09-15'),'Asia/Tokyo');
});
test('legitimate matching-calendar hint preserves permanent base and bounded travel',async()=>{
 const h=harness();await h.run();assert.deepEqual(h.travel(),{location:'Tokyo',from:'2026-09-11',until:'2026-09-25',source:'auto'});assert.equal(h.person().timezone,'Europe/London');assert.equal(h.onDay('2026-09-11'),'Asia/Tokyo');assert.deepEqual(h.counts,{extract:1,orchestrator:1,gate:1});assert.equal(h.history.length,2);assert.equal(h.notifications.length,0);
});
test('future trip stays protected even before departure',async()=>{
 const trip={location:'Boston',from:'2026-09-20',until:'2026-09-25',source:'owner'};const h=harness({person:{currently_traveling:JSON.stringify(trip)}});await h.run();assert.deepEqual(h.travel(),trip);assert.equal(h.onDay('2026-09-19'),'Europe/London');assert.equal(h.onDay('2026-09-20'),'America/New_York');
});
test('active trip stays protected on ordinary matching-calendar day',async()=>{
 const trip={location:'Boston',from:'2026-09-10',until:'2026-09-15',source:'person'};const h=harness({person:{currently_traveling:JSON.stringify(trip)}});await h.run();assert.deepEqual(h.travel(),trip);assert.equal(h.onDay('2026-09-11'),'America/New_York');
});
test('expired trip can be replaced on ordinary matching-calendar day',async()=>{
 const h=harness({person:{currently_traveling:JSON.stringify({location:'Boston',from:'2026-09-01',until:'2026-09-10'})}});await h.run();assert.deepEqual(h.travel(),{location:'Tokyo',from:'2026-09-11',until:'2026-09-25',source:'auto'});
});
test('owner unique timezone correction remains permanent owner tier',async()=>{
 const h=harness({uniqueBody:'Tokyo'});await h.run();assert.equal(h.person().timezone,'Asia/Tokyo');assert.equal(h.person().timezone_set_by,'owner');assert.equal(h.travel(),null);
});
test('empty permanent base receives first stated zone at auto tier',async()=>{
 const h=harness({person:{timezone:null,timezone_set_by:null}});await h.run();assert.equal(h.person().timezone,'Asia/Tokyo');assert.equal(h.person().timezone_set_by,'auto');assert.equal(h.travel(),null);
});
test('unresolved hint adds no travel and missing zone retains owner fallback',async()=>{
 const h=harness({statedTimezone:'Unmapped Place',person:{timezone:null,timezone_set_by:null}});await h.run();assert.equal(h.travel(),null);assert.equal(h.person().timezone,null);assert.equal(h.onDay('2026-09-11'),'Asia/Jerusalem');assert.deepEqual(h.counts,{extract:1,orchestrator:1,gate:1});
});
test('non-owner sender remains silent before extraction or writes',async()=>{
 const h=harness({sender:'outsider@example.net'});await h.run();assert.equal(h.travel(),null);assert.deepEqual(h.counts,{extract:0,orchestrator:0,gate:0});assert.equal(h.sends.length,0);assert.equal(h.notifications.length,0);assert.equal(h.history.length,0);
});
test('configured owner alias uses same travel path',async()=>{
 const h=harness({sender:'alias@example.com'});await h.run();assert.equal(h.travel().location,'Tokyo');assert.equal(h.sends[0][0],'alias@example.com');
});
test('failed reply preserves single travel write but records no phantom history',async()=>{
 const h=harness({sendFailure:true});await assert.rejects(h.run(),/Email reply send failed/);assert.equal(h.travel().location,'Tokyo');assert.equal(h.history.length,0);assert.equal(h.notifications.length,1);
});
test('authorized handler failure with no slack remains thrown without travel mutation',async()=>{
 const h=harness({extractFailure:true,noSlack:true});await assert.rejects(h.run(),/fixture extraction failure/);assert.equal(h.travel(),null);assert.equal(h.sends.length,0);assert.equal(h.history.length,0);
});
test('later owner reforward cannot extend an existing inferred window',async()=>{
 const h=harness();await h.run();const first=h.travel();h.setNow('2026-09-12T12:00Z');await h.run();assert.deepEqual(h.travel(),first);assert.equal(h.sends.length,2);
});
test('email source remains automatic when an owner forwards another persons hint',async()=>{const h=harness();await h.run();assert.equal(h.travel().source,'auto');assert.equal(h.person().timezone_set_by,'person');assert.deepEqual(h.counts,{extract:1,orchestrator:1,gate:1});assert.equal(h.notifications.length,0);});
test('email protected known source ranks retain future trip windows',async()=>{for(const source of ['owner','person','auto']){const trip={location:'Boston',from:'2026-09-20',until:'2026-09-25',source},h=harness({person:{currently_traveling:JSON.stringify(trip)}});await h.run();assert.deepEqual(h.travel(),trip);assert.equal(h.notifications.length,0);assert.equal(h.sends.length,1);assert.equal(h.sends[0][1],'Fixture reply');}});
test('email expired eastern destination allows new auto trip before UTC midnight',async()=>{const h=harness({now:'2026-09-14T22:00Z',ownerTimezone:'America/Los_Angeles',person:{currently_traveling:JSON.stringify({location:'Tokyo',from:'2026-09-01',until:'2026-09-14',source:'owner'})},statedTimezone:'Boston'});await h.run();assert.deepEqual(h.travel(),{location:'Boston',from:'2026-09-14',until:'2026-09-28',source:'auto'});});
test('email disposable legacy travel is replaced without confirmation or extra message',async()=>{for(const legacy of ['{legacy',JSON.stringify({location:'Boston',from:'2026-09-20',until:'2026-09-25'})]){const h=harness({person:{currently_traveling:legacy}});await h.run();assert.deepEqual(h.travel(),{location:'Tokyo',from:'2026-09-11',until:'2026-09-25',source:'auto'});assert.ok(h.logs.some(([message,data])=>message.includes('resolved as a bounded travel override')&&data.outcome==='applied'));assert.equal(h.notifications.length,0);assert.equal(h.sends.length,1);assert.equal(h.sends[0][1],'Fixture reply');}});
test('email missing person at write does not claim saved trip or open a question',async()=>{const h=harness({removeBeforeTravelWrite:true});await h.run();assert.equal(h.person(),undefined);assert.ok(h.logs.some(([message,data])=>message.includes('stated timezone hint not saved')&&data.outcome==='no_person'));assert.equal(h.logs.some(([message])=>message.includes('resolved as a bounded travel override')),false);assert.equal(h.notifications.length,0);assert.equal(h.sends[0][1],'Fixture reply');});
