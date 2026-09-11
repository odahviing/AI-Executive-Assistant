// Actual person loader -> interval helper -> complete Graph finder, plus actual
// create/move/search normalization branches -> resolver. External I/O is fixture.
// Optional snapshot overlays only changed sources; normal run is Git-runnable.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const {test}=require('node:test'),luxon=require('luxon'),{DateTime,Settings}=luxon;
const root=path.resolve(__dirname,'..'),snapshot=process.env.MATCHMAKER_SNAPSHOT;
const read=rel=>fs.readFileSync(snapshot&&fs.existsSync(path.join(root,snapshot,rel))?path.join(root,snapshot,rel):path.join(root,rel),'utf8');
const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const noop=()=>{};
Settings.now=()=>Date.parse('2026-09-11T00:00:00Z');
function compile(source,bindings={},deps={}) {
 const mod={exports:{}};
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext('(function(require,module,exports){'+js+'\n})',{DateTime,console,...bindings})
  (s=>{if(Object.hasOwn(deps,s))return deps[s];throw Error('Unexpected dependency '+s);},mod,mod.exports);
 return mod.exports;
}
function nodes(tree,predicate){const found=[];function walk(n){if(predicate(n))found.push(n);ts.forEachChild(n,walk);}walk(tree);return found;}
function named(n,name){return ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText()===name);}
function one(xs){assert.equal(xs.length,1);return xs[0];}
function harness(options={}) {
 const modules=new Map(),warnings=[];
 const profile={user:{name:'Owner Example',email:'owner@example.test',slack_user_id:'UOWNER',timezone:options.ownerZone??'Asia/Jerusalem'},schedule:{work_hours:Object.fromEntries(weekdays.map(d=>[d,['00:00-23:59']])),office_days:{days:weekdays},home_days:{days:[]}},meetings:{buffer_minutes:0,allowed_durations:[25,55],categories:[]}};
 const person={person_id:'p1',email:'person@example.test',timezone:'Asia/Jerusalem',...options.person};
 const travel=options.travel===undefined?{from:'2026-09-14',until:'2026-09-14',location:'America/New_York'}:options.travel;
 const hours={workdays:weekdays,hoursStart:'09:00',hoursEnd:'18:00',...options.hours};
 const people=[person,...(options.otherPeople??[])];
 const db={getPersonMemory:()=>person,searchPeopleMemory:email=>people.filter(p=>p.email===email),getTravelRecordById:()=>travel,getEffectiveTimezoneById:id=>({timezone:people.find(p=>p.person_id===id)?.timezone})};
 const mocks={
  'src/db/requests.ts':{getRequest:()=>undefined},
  'src/db.ts':db,'src/db/people.ts':db,
  'src/db/scheduleOverrides.ts':{getScheduleOverride:(_,date)=>options.rows?.[date]??null,listScheduleOverrides:()=>[]},
  'src/utils/logger.ts':{__esModule:true,default:{info:noop,warn:(...a)=>warnings.push(a),error:noop,debug:noop}},
  'src/utils/workingHoursDefault.ts':{getEffectiveWorkingHours:()=>hours,defaultWorkingHoursForTz:()=>hours},
  'src/utils/locationTz.ts':{inferTimezoneFromStateStatic:location=>location},
  'src/core/requests/types.ts':{PROMOTE_TIMEZONE_TEMP_TOOL:'promote_timezone_temp'},
  'src/utils/categoryRules.ts':{checkCategorySlot:()=>({allowed:true}),getProfileCategoryByName:()=>null},
  'src/utils/displaySubject.ts':{displaySubject:()=>'',PRIVATE_MASK:'private'},
  'src/utils/floatingBlocks.ts':{getFloatingBlocks:()=>[],blockAppliesOnDay:()=>false,isFloatingBlockEvent:()=>false},
  'src/utils/calendarDensity.ts':{prefersDensePacking:()=>false,densityConfigFromProfile:()=>({})},
  'src/connectors/graph/calendarReads.ts':{getFreeBusyForDecision:async()=>({}),getOwnerEventsForDecision:async()=>[],isOutageShaped:()=>false,CalendarOfflineError:Error},
 };
 function load(rel){
  if(mocks[rel])return mocks[rel];if(modules.has(rel))return modules.get(rel).exports;
  const mod={exports:{}};modules.set(rel,mod);
  const js=ts.transpileModule(read(rel),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const req=s=>s==='luxon'?luxon:s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):(()=>{throw Error('Unexpected module '+s);})();
  vm.runInNewContext('(function(require,module,exports){'+js+'\n})',{Date,console,Set,Map,Buffer,setTimeout,Intl},{filename:rel})(req,mod,mod.exports);return mod.exports;
 }
 const availability=load('src/utils/attendeeAvailability.ts'),resolver=load('src/utils/weTimeResolver.ts');
 const entries=()=>availability.loadAttendeeAvailabilityForEmails([person.email],profile.user.email,profile.user.timezone);
 const find=(start,end,flags={})=>load('src/connectors/graph/findAvailableSlots.ts').findAvailableSlots({userEmail:profile.user.email,timezone:profile.user.timezone,profile,durationMinutes:DateTime.fromISO(end).diff(DateTime.fromISO(start),'minutes').minutes,searchFrom:start,searchTo:end,autoExpand:false,requestedTimeWindow:null,minBufferHours:0,attendeeAvailability:entries(),...flags});
 async function handler(kind,args,context={}) {
  const rel=`src/skills/meetings/ops/handlers/${kind==='create'?'createMeeting':'moveMeeting'}.ts`;
  const tree=ts.createSourceFile(rel,read(rel),ts.ScriptTarget.Latest,true),marker=kind==='create'?'tripDisplay':'moveTripDisplay';
  const decl=one(nodes(tree,n=>named(n,marker))),siblings=decl.parent.statements,index=siblings.indexOf(decl);
  return compile(`export async function run(){${decl.getText()}\n${siblings[index+1].getText()}\nreturn {args};}`,
   {args,context:{profile,...context},timezone:profile.user.timezone,logger:mocks['src/utils/logger.ts'].default,...resolver},
   {'../../../../utils/workingElsewhere':load('src/utils/workingElsewhere.ts')}).run();
 }
 function search(args,mode='candidate') {
  const rel='src/skills/meetings/ops/handlers/findAvailableSlots.ts',tree=ts.createSourceFile(rel,read(rel),ts.ScriptTarget.Latest,true);
  const clock=nodes(tree,n=>named(n,'resolveRequestedClock'));
  const decl=one(nodes(tree,n=>named(n,mode==='candidate'?'normalized':'preferredSlot')&&(mode!=='candidate'||n.getText().includes('candidates'))));
  const raw=mode==='preferred'?one(nodes(tree,n=>named(n,'rawPreferredSlot'))).getText():'';
  try {return compile(`${clock[0]?.getText()??''}\n${raw}\n${decl.getText()}\nexport const result=${mode==='candidate'?'normalized':'preferredSlot'};`,
   {args,context:{profile},candidates:args.candidate_slots,durationMin:25,searchWindowTz:args.search_window_timezone??'',timezone:profile.user.timezone,DateTime,...load('src/utils/timezoneConvert.ts'),...resolver}).result;
  }catch(err){if(err.code==='stated_time_clarification')return err.toToolResult();throw err;}
 }
 function searchWindow(args) {
  const rel='src/skills/meetings/ops/handlers/findAvailableSlots.ts',tree=ts.createSourceFile(rel,read(rel),ts.ScriptTarget.Latest,true);
  const from=one(nodes(tree,n=>named(n,'effectiveSearchFrom'))),siblings=from.parent.statements,index=siblings.indexOf(from),last=siblings.findIndex((n,i)=>i>index&&named(n,'mustBeAfterId'));
  const body=siblings.slice(index,last).map(n=>n.getText()).join('\n');
  const code=`export function run(){try {${body}\nreturn {start:effectiveSearchFrom,end:effectiveSearchTo,zone:searchWindowTz};}catch(err){if(err.code==='stated_time_clarification')return err.toToolResult();throw err;}}`;
  return compile(code,{args,context:{profile},timezone:profile.user.timezone,DateTime,logger:mocks['src/utils/logger.ts'].default,...load('src/utils/timezoneConvert.ts'),...resolver}).run();
 }
 function grounding(date) {
  const rel='src/skills/meetings/ops/handlers/findAvailableSlots.ts',tree=ts.createSourceFile(rel,read(rel),ts.ScriptTarget.Latest,true);
  const fn=one(nodes(tree,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='attendeeHoursGroundingNotes'));
  return compile(fn.getText()+'\nexport {attendeeHoursGroundingNotes};',{DateTime,...load('src/utils/timezoneConvert.ts')},{'../../../../utils/attendeeAvailability':availability})
   .attendeeHoursGroundingNotes([{email:person.email,slots_blocked:1}],date,entries(),profile.user.timezone,'Owner');
 }
 return {profile,person,load,availability,entries,find,handler,search,searchWindow,grounding,resolver,warnings};
}

if (require.main === module) {
test('trip starts and ends in destination calendar rather than owner day',()=>{
 const h=harness(),entry=h.entries()[0];
 assert.equal(h.availability.attendeeTzForDay(entry,'2026-09-14T02:00:00+03:00'),'Asia/Jerusalem');
 assert.equal(h.availability.attendeeTzForDay(entry,'2026-09-15T02:00:00+03:00'),'America/New_York');
 assert.equal(h.availability.attendeeTzForDay(entry,'2026-09-15T07:00:00+03:00'),'Asia/Jerusalem');
});
test('real loader finder rejects western trip departure before destination day starts',async()=>{
 const h=harness({hours:{hoursStart:'19:00',hoursEnd:'23:00'}});
 assert.equal((await h.find('2026-09-14T03:00:00+03:00','2026-09-14T03:25:00+03:00')).length,0);
});
test('real loader finder accepts final trip evening beyond owner midnight',async()=>{
 const h=harness();
 assert.equal((await h.find('2026-09-15T00:15:00+03:00','2026-09-15T00:40:00+03:00')).length,1);
});
test('real loader finder rejects entire interval at eastern destination return midnight',async()=>{
 const h=harness({travel:{from:'2026-09-14',until:'2026-09-14',location:'Asia/Tokyo'},hours:{hoursStart:'20:00',hoursEnd:'24:00'}});
 assert.equal((await h.find('2026-09-14T17:45:00+03:00','2026-09-14T18:10:00+03:00')).length,0);
});
test('fixed stated work frame survives travel return; M17 exact annotation remains available',async()=>{
 const h=harness({travel:{from:'2026-09-14',until:'2026-09-14',location:'Asia/Tokyo'},hours:{hoursStart:'20:00',hoursEnd:'24:00',timezone:'Asia/Jerusalem'}});
 assert.equal((await h.find('2026-09-14T20:00:00+03:00','2026-09-14T20:25:00+03:00')).length,1);
 const normal=harness();
 assert.equal((await normal.find('2026-09-14T10:00:00+03:00','2026-09-14T10:25:00+03:00',{relaxed:true,tagAttendeeConflicts:true})).length,0);
 assert.equal((await normal.find('2026-09-14T10:00:00+03:00','2026-09-14T10:25:00+03:00',{relaxed:true,tagAttendeeConflicts:true,allowAttendeeOffHours:true})).length,1);
});
test('original Q1 owner-midnight span is legitimate under destination calendar ruling',async()=>{
 const h=harness();assert.equal((await h.find('2026-09-14T23:45:00+03:00','2026-09-15T00:10:00+03:00')).length,1);
});
test('full interval can cross destination return when every segment remains within stated hours',async()=>{
 const h=harness({travel:{from:'2026-09-14',until:'2026-09-14',location:'Asia/Tokyo'},hours:{hoursStart:'00:00',hoursEnd:'24:00'}});
 assert.equal((await h.find('2026-09-14T17:45:00+03:00','2026-09-14T18:10:00+03:00')).length,1);
});
test('written presentation uses same final-trip instant as availability',()=>{
 const h=harness();const display=h.availability.presentationLocalFieldFor([h.person.email],'2026-09-15T00:15:00+03:00',h.profile.user.email,h.profile.user.timezone);
 assert.match(display.presentation_local,/Mon 14 Sep 17:15 EDT/);
});
test('day grounding reports actual work intervals including prior destination date',()=>{
 const h=harness(),notes=h.grounding('2026-09-15');
 assert.ok(notes.some(n=>n.includes('Mon 14 Sep 17:00')&&n.includes('Tue 15 Sep 00:00')));
});
test('booking planner remote-mode travel read uses same destination date as finder',()=>{
 const h=harness(),rel='src/skills/meetings/planMeeting.ts',tree=ts.createSourceFile(rel,read(rel),ts.ScriptTarget.Latest,true);
 const day=one(nodes(tree,n=>named(n,'meetingIsoDate'))),travel=one(nodes(tree,n=>named(n,'travelForMeetingDay')));
 const record={from:'2026-09-14',until:'2026-09-14',location:'America/New_York'};
 for(const [slotStartIso,expected] of [['2026-09-14T02:00:00+03:00',false],['2026-09-15T00:15:00+03:00',true]]) {
  const result=compile(`${day.getText()}\n${travel.getText()}\nexport const result=travelForMeetingDay('p1');`,
   {DateTime,input:{slotStartIso},profile:h.profile,getTravelRecordById:(_id,date)=>date&&date>record.until?null:record,inferTimezoneFromStateStatic:x=>x}).result;
  assert.equal(!!result,expected);
 }
});
for(const kind of ['create','move'])for(const [reason,start] of [['nonexistent_local_time','2027-03-14T02:30:00'],['ambiguous_local_time','2026-11-01T01:30:00']])test(`${kind} requested ${reason} returns clarification before mutation`,async()=>{
 const h=harness();
 for(const context of [{authority:'owner',surface:'owner_dm'},{authority:'owner',surface:'room'},{authority:'colleague',surface:'colleague_dm'},{authority:'colleague',surface:'room'}]) {
  const args={stated_zone:'America/New_York',attendees:[]};args[kind==='create'?'start':'new_start']=start;
  const result=await h.handler(kind,args,context);assert.equal(result.error,'stated_time_clarification');assert.equal(result.reason,reason);
  assert.equal(args[kind==='create'?'start':'new_start'],start,'bare clock not mutated to guessed instant');
 }
});
test('candidate and preferred requested DST fold use same clarification; explicit slots remain exact',()=>{
 const h=harness(),args={candidate_slots:[{start:'2026-11-01T01:30:00'}],preferred_slot:'2026-11-01T01:30:00',search_window_timezone:'America/New_York'};
 for(const mode of ['candidate','preferred'])assert.equal(h.search(args,mode).reason,'ambiguous_local_time');
 const exact={...args,candidate_slots:[{start:'2026-11-01T01:30:00-05:00'}],preferred_slot:'2026-11-01T01:30:00-05:00'};
 assert.equal(DateTime.fromISO(h.search(exact)[0].start).toUTC().toISO(),'2026-11-01T06:30:00.000Z');
 assert.equal(DateTime.fromISO(h.search(exact,'preferred')).toUTC().toISO(),'2026-11-01T06:30:00.000Z');
});
test('hard requested boundary clarifies a fold; broad soft window on same date does not ask',()=>{
 const h=harness(),args={search_from:'2026-11-01T01:30:00',search_to:'2026-11-01T02:30:00',search_window_timezone:'America/New_York'};
 assert.equal(h.searchWindow({...args,time_window_is_hard:true}).reason,'ambiguous_local_time');
 assert.equal(h.searchWindow({...args,time_window_is_hard:false}).error,undefined);
});
test('soft search resolves raw CST from person context without an incidental DST clock choice',()=>{
 const h=harness({person:{timezone:'Asia/Shanghai'},travel:null});
 const args={search_from:'2026-11-01T01:30:00',search_to:'2026-11-01T02:30:00',search_window_timezone:'CST',attendee_emails:[h.person.email],time_window_is_hard:false};
 assert.equal(h.searchWindow(args).zone,'Asia/Shanghai');
 assert.equal(h.searchWindow({...args,attendee_emails:['unknown@example.test']}).reason,'ambiguous_timezone');
});
test('contextual CST China and IST India are selected from actual stored participants',async()=>{
 for(const [abbr,tz,hour] of [['CST','Asia/Shanghai',4],['IST','Asia/Kolkata',6]]) {
  const h=harness({person:{timezone:tz},travel:null});
  const args={start:'2026-09-16T12:00:00',stated_zone:abbr,attendees:[{email:h.person.email}]};
  const result=await h.handler('create',args);assert.equal(result.error,undefined);
  assert.equal(DateTime.fromISO(result.args.start).toUTC().hour,hour);
 }
});
test('unresolved raw abbreviation clarifies; email retains M12 home fallback',async()=>{
 const h=harness({person:{timezone:'Europe/London'}});
 const args={start:'2026-09-16T12:00:00',stated_zone:'CST',attendees:[{email:h.person.email}]};
 assert.equal((await h.handler('create',{...args})).reason,'ambiguous_timezone');
 const email=await h.handler('create',{...args},{channel:'email'});
 assert.equal(DateTime.fromISO(email.args.start).setZone(h.profile.user.timezone).hour,12);
});
test('conflicting and unknown participant context never selects a timezone from only one person',async()=>{
 const h=harness({travel:null,person:{timezone:'Asia/Kolkata'},otherPeople:[{person_id:'p2',email:'second@example.test',timezone:'Asia/Jerusalem'}]});
 for(const email of ['second@example.test','unknown@example.test']) {
  const result=await h.handler('create',{start:'2026-09-16T12:00:00',stated_zone:'IST',attendees:[{email:h.person.email},{email}]});
  assert.equal(result.reason,'ambiguous_timezone');
 }
});
test('ordinary clocks, explicit fold offsets and owner home context remain valid',async()=>{
 const h=harness();
 for(const kind of ['create','move'])for(const value of ['2026-11-01T01:30:00-04:00','2026-11-01T01:30:00-05:00','2026-11-01T12:30:00']) {
  const key=kind==='create'?'start':'new_start';const result=await h.handler(kind,{[key]:value,stated_zone:'America/New_York'});
  assert.equal(result.error,undefined);if(/[+-]\d{2}:\d{2}$/.test(value))assert.equal(result.args[key],value);
 }
 const own=await h.handler('create',{start:'2026-09-16T12:00:00',stated_zone:'IST',attendees:[]});assert.equal(own.error,undefined);
 assert.equal(DateTime.fromISO(own.args.start).setZone(h.profile.user.timezone).hour,12);
});
test('read-only uncertain-write verifier reports unresolved historical clock without asking or guessing',async()=>{
 const h=harness(),rel='src/connectors/graph/calendarReads.ts',tree=ts.createSourceFile(rel,read(rel),ts.ScriptTarget.Latest,true);
 const fn=one(nodes(tree,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='verifyApprovedCalendarAction'));
 const event={id:'e1',subject:'Sync',isCancelled:false,isAllDay:false,attendees:[],start:{dateTime:'2026-11-01T05:30:00Z',timeZone:'UTC'},end:{dateTime:'2026-11-01T05:55:00Z',timeZone:'UTC'}};
 const client={api(){return this;},header(){return this;},select(){return this;},get:async()=>event};
 const verify=compile(fn.getText(),{DateTime,getClient:()=>client},{'../../utils/weTimeResolver':h.resolver,'../../utils/timezoneConvert':h.load('src/utils/timezoneConvert.ts')}).verifyApprovedCalendarAction;
 const args={start:'2026-11-01T01:30:00',end:'2026-11-01T01:55:00',stated_zone:'America/New_York',subject:'Sync',attendees:[]};
 const result=await verify({userEmail:h.profile.user.email,tool:'create_meeting',args,eventId:'e1',profile:h.profile});
 assert.equal(result.status,'unavailable');assert.equal(result.reason,'approved_timezone_not_fixed');
 const exact=await verify({userEmail:h.profile.user.email,tool:'create_meeting',args:{...args,start:'2026-11-01T01:30:00-04:00',end:'2026-11-01T01:55:00-04:00'},eventId:'e1',profile:h.profile});
 assert.equal(exact.status,'desired_state_observed');
});
}
module.exports={harness};
