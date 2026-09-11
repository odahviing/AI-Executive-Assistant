// Full production modules: dated hours -> checkSlot -> finder/outcome/precheck/nearby.
// Only external I/O, category/floating rules unrelated to these fixtures, and final
// spread selection are fixtures. No model/network/database calls or runtime writes.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const {test}=require('node:test'),luxon=require('luxon'),{DateTime,Settings}=luxon;
const arg=process.argv.indexOf('--source-root');
const root=arg<0?path.resolve(__dirname,'..'):path.resolve(process.argv[arg+1]);
Settings.now=()=>Date.parse('2026-09-11T00:00:00Z');
class Clock extends Date {constructor(...args){super(...(args.length?args:[Settings.now()]));}static now(){return Settings.now();}}
const noop=()=>{},home='Asia/Jerusalem';
const trip={'2026-09-14':{timezone:'America/New_York',windows:['09:00-23:59'],isWorkday:true}};
const blocked={...trip,'2026-09-15':{isWorkday:false}};
const start='2026-09-14T23:45:00+03:00',end='2026-09-15T00:10:00+03:00';
function harness(rows={},options={}){
 const modules=new Map(),warnings=[],calls={searches:[],offers:[]};
 const profile={user:{name:'Owner Example',email:'owner@example.test',slack_user_id:'UOWNER',timezone:home},schedule:{work_hours:Object.fromEntries(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(d=>[d,['09:00-23:59']])),office_days:{days:['Monday','Tuesday']},home_days:{days:[]}},meetings:{buffer_minutes:0,allowed_durations:[25,55],categories:[]}};
 const mocks={
  'src/db/scheduleOverrides.ts':{getScheduleOverride:(_,d)=>rows[d]??null,listScheduleOverrides:()=>Object.entries(rows).map(([date,row])=>({date,...row}))},
  'src/utils/logger.ts':{default:{info:noop,warn:(...a)=>warnings.push(a),error:noop,debug:noop},__esModule:true},
  'src/core/requests/types.ts':{PROMOTE_TIMEZONE_TEMP_TOOL:'promote_timezone_temp'},
  'src/utils/categoryRules.ts':{checkCategorySlot:()=>({allowed:true}),getProfileCategoryByName:()=>null},
  'src/utils/displaySubject.ts':{displaySubject:()=>'',PRIVATE_MASK:'private'},
  'src/db/people.ts':{personIdForSlackId:()=>null,searchPeopleMemory:()=>[],getTravelRecordById:()=>null,getEffectiveTimezoneById:()=>({})},
  'src/db/venues.ts':{getVenueTravelTimeMinutes:()=>null,isCompanyLocation:()=>false},
  'src/utils/locationTz.ts':{inferTimezoneFromStateStatic:()=>null},
  'src/utils/resolveLocation.ts':{resolveLocation:()=>({kind:'resolved',isOnline:true,location:'fixture online',reasoning:'fixture'}),isPhoneLocationString:()=>false},
  'src/skills/meetings/detectCategory.ts':{detectCategory:async()=>({category:null,reason:'fixture'})},
  'src/skills/meetings/findMeetingOwner.ts':{findMeetingOwner:async()=>({ownerIsOrganizer:true})},
  'src/utils/floatingBlocks.ts':{getFloatingBlocks:()=>[],blockAppliesOnDay:()=>false,isFloatingBlockEvent:()=>false},
  'src/utils/calendarDensity.ts':{prefersDensePacking:()=>false,densityConfigFromProfile:()=>({})},
  'src/connectors/graph/calendarReads.ts':{getFreeBusyForDecision:async()=>({}),getOwnerEventsForDecision:async()=>{if(options.offline)throw Error('fixture calendar unavailable');return [];},isOutageShaped:()=>false,CalendarOfflineError:Error},
  'src/llm/client.ts':{getAnthropicClient:()=>({messages:{create:async()=>({content:[{type:'tool_use',name:'normalize_slots',input:{slots:options.slots??[{wall_clock:'2026-09-14T23:45',stated_timezone:home,duration_minutes:25}]}}]})}})},
  'src/llm/models.ts':{MODEL_HAIKU:'existing-call-fixture'},'src/utils/usageLog.ts':{logLlmUsage:noop},
  'src/utils/availabilityGate.ts':{armsHardFloor:k=>k==='vacation_or_off_day',forgetHardBlockedSlot:noop,recordHardBlockedSlot:noop,hardBlockClassPhrase:()=> 'unavailable'},
  'src/utils/attendeeAvailability.ts':{attendeeTzForDay:e=>e.timezone},
  'src/utils/offeredSlotsStash.ts':{getOfferedSlots:()=>[],recordOfferedSlots:a=>calls.offers.push(a)},
 };
 function load(rel){
  if(rel==='src/connectors/graph/calendar.ts')return {...mocks['src/connectors/graph/calendarReads.ts'],
   findAvailableSlots:async a=>{calls.searches.push(a);return load('src/connectors/graph/findAvailableSlots.ts').findAvailableSlots(a);},
   pickSpreadSlots:slots=>slots.map(s=>s.start),slotLocalDay:(s,tz)=>DateTime.fromISO(s.start).setZone(tz).toISODate()};
  if(mocks[rel])return mocks[rel];if(modules.has(rel))return modules.get(rel).exports;
  const source=fs.readFileSync(path.join(root,rel),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod={exports:{}};modules.set(rel,mod);
  const req=s=>s==='luxon'?luxon:s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):(()=>{throw Error('Unexpected module '+s);})();
  vm.runInNewContext('(function(require,module,exports){'+js+'\n})',{Date:Clock,console,Set,Map,Buffer,setTimeout,clearTimeout},{filename:rel})(req,mod,mod.exports);return mod.exports;
 }
 const check=(s=start,e=end,extra={})=>load('src/utils/scheduleRules.ts').checkSlot({profile,slotStartIso:s,slotEndIso:e,events:[],category:null,...extra});
 const find=(s=start,e=end,extra={})=>load('src/connectors/graph/findAvailableSlots.ts').findAvailableSlots({userEmail:profile.user.email,timezone:home,profile,durationMinutes:DateTime.fromISO(e).diff(DateTime.fromISO(s),'minutes').minutes,searchFrom:s,searchTo:e,autoExpand:false,requestedTimeWindow:null,minBufferHours:0,...extra});
 const outcome=(s=start,e=end)=>load('src/utils/verifyScheduledOutcome.ts').verifyScheduledOutcome({subjectKeyword:'Sync',proposedSlots:[s]},[{id:'fixture',subject:'Sync',start:{dateTime:s,timeZone:home},end:{dateTime:e,timeZone:home}}],profile);
 return {profile,load,check,find,outcome,rows,calls,warnings};
}
module.exports={harness,blocked,trip,start,end};
if(require.main===module){
test('whole interval rejects return blackout in strict and relaxed checkSlot, with accurate facts',()=>{
 const h=harness(blocked);
 for(const allowRelaxed of [false,true]){const result=h.check(start,end,{allowRelaxed});assert.equal(result.passes,false);assert.equal(result.violation_kind,'vacation_or_off_day');assert.equal(result.outsideWorkHours,true);assert.match(result.violation_label,/Tuesday 15 Sep/);}
});
test('actual finder and outcome reject return blackout with requested bands and exact relaxed path',async()=>{
 const h=harness(blocked);
 for(const extra of [{},{relaxed:true},{requestedTimeWindow:{from:'16:00',to:'18:00',timezone:'America/New_York'}}])assert.equal((await h.find(start,end,extra)).length,0);
 assert.equal(h.outcome().status,'booked_conflict');
});
test('middle off day is checked even when both endpoint dates are allowed',()=>{
 const h=harness(blocked),s='2026-09-14T23:45:00+03:00',e='2026-09-16T10:00:00+03:00';
 assert.equal(h.check(s,e,{allowRelaxed:true}).violation_kind,'vacation_or_off_day');
 assert.equal(h.outcome(s,e).status,'booked_conflict');
});
test('return to a working home date uses its own narrower hours; owner hours relaxation remains',async()=>{
 const h=harness({...trip,'2026-09-15':{isWorkday:true,windows:['09:00-17:00']}});
 assert.equal(h.check().violation_kind,'outside_working_hours');assert.equal(h.check(start,end,{allowRelaxed:true}).passes,true);
 assert.equal((await h.find()).length,0);assert.equal((await h.find(start,end,{relaxed:true})).length,1);
 assert.equal(h.outcome().status,'booked_conflict');
});
test('exact midnight end and ordinary within-trip interval remain legitimate',async()=>{
 const h=harness(blocked);
 for(const [s,e] of [['2026-09-14T23:35:00+03:00','2026-09-15T00:00:00+03:00'],['2026-09-14T23:00:00+03:00','2026-09-14T23:25:00+03:00']]){
  assert.equal(h.check(s,e).passes,true);assert.equal((await h.find(s,e)).length,1);assert.equal(h.outcome(s,e).status,'booked_compliant');
 }
});
test('crossing home midnight remains allowed while the same dated trip still owns both sides',async()=>{
 const h=harness(trip);assert.equal(h.check().passes,true);assert.equal((await h.find()).length,1);assert.equal(h.outcome().status,'booked_compliant');
});
test('eastern travel cannot override an explicit home off date',async()=>{
 const h=harness({'2026-09-14':{isWorkday:false},'2026-09-15':{timezone:'Asia/Tokyo',windows:['00:00-05:00'],isWorkday:true}});
 const s='2026-09-14T19:00:00+03:00',e='2026-09-14T19:25:00+03:00';
 assert.equal(h.check(s,e).violation_kind,'vacation_or_off_day');assert.equal((await h.find(s,e)).length,0);
});
test('explicit spring and repeated fall intervals retain visited-clock membership',()=>{
 for(const [d,s,e] of [['2027-03-14','2027-03-14T01:30:00-05:00','2027-03-14T03:30:00-04:00'],['2026-11-01','2026-11-01T01:30:00-04:00','2026-11-01T01:30:00-05:00']]){
  const h=harness({[d]:{timezone:'America/New_York',windows:['00:00-05:00'],isWorkday:true}});
  assert.equal(h.check(s,e).passes,true);assert.equal(h.outcome(s,e).status,'booked_compliant');
 }
});
test('availability intervals and validation agree at explicit off-day boundaries',()=>{
 const h=harness(blocked),wh=h.load('src/utils/workHours.ts');
 const intervals=wh.ownerWorkIntervalsBetween(DateTime.fromISO(start),DateTime.fromISO(end),h.profile);
 assert.equal(intervals.length,1);assert.equal(intervals[0].end.toMillis(),DateTime.fromISO('2026-09-15T00:00:00+03:00').toMillis());
 assert.equal(h.check().passes,false);
});
test('full precheck uses real validator and real nearby search after return rejection',async()=>{
 const h=harness(blocked),result=await h.load('src/utils/availabilityPreCheck.ts').precheckAvailability({message:'2026-09-14 23:45?',profile:h.profile,durationMinutes:25});
 assert.equal(result.ran,true,JSON.stringify(h.warnings));assert.equal(result.verdicts[0].bookable,false);assert.equal(result.verdicts[0].rejection_reason,'vacation_or_off_day');
 assert.ok(h.calls.searches.length>0,'blocked precheck actually invoked nearby finder');
 const nearby=await h.load('src/skills/meetings/nearbyAlternatives.ts').findNearbyAlternatives({profile:h.profile,anchorDays:['2026-09-14'],durationMin:25,initiator:'colleague'});
 assert.ok(nearby.onAnchorDays.length>0,'legitimate nearby alternatives retained');
 for(const s of [...nearby.onAnchorDays,...nearby.beyond])assert.equal(h.check(s.start,s.end).passes,true);
 assert.ok([...nearby.onAnchorDays,...nearby.beyond].every(s=>!(DateTime.fromISO(s.start)<DateTime.fromISO('2026-09-15T00:00:00+03:00')&&DateTime.fromISO(s.end)>DateTime.fromISO('2026-09-15T00:00:00+03:00'))));
});
test('full precheck gap probes and unavailable calendar preserve truthful outcomes',async()=>{
 const h=harness(blocked,{slots:[{wall_clock:'2026-09-14T23:45',stated_timezone:home,gap_query:true}]});
 const result=await h.load('src/utils/availabilityPreCheck.ts').precheckAvailability({message:'2026-09-14 23:45?',profile:h.profile});
 assert.equal(result.ran,true,JSON.stringify(h.warnings));assert.equal(result.verdicts[0].maxFreeMinutes,null);
 const offline=harness(blocked,{offline:true});
 const blind=await offline.load('src/utils/availabilityPreCheck.ts').precheckAvailability({message:'2026-09-14 23:45?',profile:offline.profile});assert.equal(blind.ran,false);
});
test('full booking and move plans surface blackout; explicit owner request retains one-step notice',async()=>{
 const h=harness(blocked),plan=h.load('src/skills/meetings/planMeeting.ts').planMeeting;
 for(const intent of ['new_booking','move'])for(const initiator of ['colleague','owner']){
  const input={profile:h.profile,intent,initiator,participants:[],subject:'Sync',slotStartIso:start,slotEndIso:end,durationMin:25,preloadedEvents:[],...(intent==='move'?{existingEventId:'fixture'}:{})};
  const result=await plan(input);
  if(initiator==='owner'){assert.equal(result.action,'book');assert.match(result.overrideNotice,/Tuesday 15 Sep/);}
  else {assert.notEqual(result.action,'book');assert.match(result.violationLabel,/Tuesday 15 Sep/);}
  const valid=await plan({...input,slotStartIso:'2026-09-14T23:00:00+03:00',slotEndIso:'2026-09-14T23:25:00+03:00'});
  assert.equal(valid.action,'book');assert.equal(valid.overrideNotice,undefined);
 }
});
}
