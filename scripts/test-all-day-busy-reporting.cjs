// Actual analyzer + Graph finder/checkSlot; external calendar/DB I/O isolated.
// The handler's empty-result closure is evaluated with its actual finder output.
// node --test scripts/test-all-day-busy-reporting.cjs [--source-root SNAPSHOT]
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const assert=require('node:assert/strict'),{test}=require('node:test');
const {harness}=require('./test-timezone-owner-interval.cjs');
const rootArg=process.argv.indexOf('--source-root');
const root=rootArg<0?path.resolve(__dirname,'..'):path.resolve(process.argv[rootArg+1]);
const zone='Asia/Jerusalem', date='2026-10-22';
const person=(address,name)=>({emailAddress:{address,name}});
const event=(extra={})=>({id:'meeting',subject:'Work meeting',showAs:'busy',isAllDay:false,isCancelled:false,sensitivity:'normal',categories:[],start:{dateTime:date+'T11:00:00',timeZone:zone},end:{dateTime:date+'T11:40:00',timeZone:zone},attendees:[person('peer@example.test','Peer')],organizer:person('peer@example.test','Peer'),...extra});
const block=(extra={})=>event({id:'block',subject:'Idan, Vacation day',isAllDay:true,start:{dateTime:date+'T00:00:00',timeZone:zone},end:{dateTime:'2026-10-23T00:00:00',timeZone:zone},...extra});
function setup(events,offline=false){
 const h=harness({}, {realAvailability:true,extraMocks:{
  'src/connectors/graph/calendarReads.ts':{getFreeBusyForDecision:async()=>({}),getOwnerEventsForDecision:async()=>{if(offline)throw Error('calendar unavailable');return events;},isOutageShaped:()=>false,CalendarOfflineError:Error},
  'src/utils/displaySubject.ts':{displaySubject:(e,p,viewer,email)=>viewer==='owner'?e.subject:(email===null||e.sensitivity==='private'?'[Private]':e.subject),isEventPrivate:e=>e.sensitivity==='private'},
  'src/db.ts':{searchPeopleMemory:()=>[],listSchedulingContacts:()=>[]},
 }});
 h.profile.categories=[];
 const analyze=(viewer='owner',viewerEmail)=>{const m=h.load('src/skills/meetings/ops/analysis.ts');return m.analyzeCalendar(m.processCalendarEvents(events,h.profile.user.email,h.profile.user.name,zone,h.profile,viewer,viewerEmail),date,date,h.profile)[0];};
 const search=async(from=date+'T00:00:00',until=date+'T23:59:00',extra={})=>{const diagnosticsOut={};const slots=await h.find(from,until,{durationMinutes:25,diagnosticsOut,...extra});return {slots,diagnosticsOut};};
 return {...h,analyze,search};
}
function emptyResult(summary){
 const file=path.join(root,'src/skills/meetings/ops/handlers/findAvailableSlots.ts');
 const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);let expression;
 function walk(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='emptySearchResult')expression=n.initializer.getText(tree);ts.forEachChild(n,walk);}walk(tree);assert.ok(expression);
 const js=ts.transpileModule('module.exports = '+expression,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const mod={exports:{}};
 vm.runInNewContext(js,{module:mod,exports:mod.exports,groundAttendeeHours:()=>{},isOwnerInitiatedSearch:false,attendeeEmailWarning:undefined,attendeeNotCheckedWarning:undefined,colleagueSoftBlockHint:undefined,movingEventIdMismatchWarning:undefined,tzGroundingFields:{}});
 return mod.exports(summary);
}
test('regression analysis reports Busy overlap and zero free time without declaring vacation',()=>{
 const a=setup([block(),event()]).analyze();assert.ok(a.issues.some(i=>i.type==='overlap'));assert.equal(a.stats.freeMinInWorkHours,0);assert.equal(a.outOfOfficeAllDay,undefined);assert.ok(a.issues.some(i=>i.suggestedFix?.includes('before changing')));
});
test('regression foreign-organizer named Busy remains owner occupancy',()=>{
 const a=setup([block({subject:'Yael - reservation'}),event()]).analyze();assert.ok(a.events.some(e=>e.id==='block'&&e._eventType==='mine'));assert.equal(a.stats.freeMinInWorkHours,0);
});
test('regression multi-day Busy covers later days and respects exclusive end',()=>{
 const b=block({start:{dateTime:'2026-10-20T00:00:00',timeZone:zone}});assert.ok(setup([b,event()]).analyze().issues.some(i=>i.type==='overlap'));
 const ended=block({start:{dateTime:'2026-10-20T00:00:00',timeZone:zone},end:{dateTime:date+'T00:00:00',timeZone:zone}});assert.ok(!setup([ended,event()]).analyze().issues.some(i=>i.type==='overlap'));
});
for(const showAs of ['free','workingElsewhere'])test('control nonoccupying '+showAs+' marker',async()=>{
 const h=setup([block({showAs}),event()]);assert.ok(!h.analyze().issues.some(i=>i.type==='overlap'));const r=await h.search(date+'T13:00:00',date+'T14:00:00');assert.ok(r.slots.length>0);assert.ok(!r.diagnosticsOut.daySummary?.[0]?.owner_all_day_busy);
});
test('control cancelled block and genuine OOF keep distinct semantics',()=>{
 assert.ok(!setup([block({isCancelled:true}),event()]).analyze().issues.some(i=>i.type==='overlap'));
 const a=setup([block({showAs:'oof'}),event()]).analyze();assert.equal(a.outOfOfficeAllDay,true);assert.ok(a.issues.some(i=>i.type==='oof_with_meetings'));
});
test('control shared-room analysis preserves subject masking',()=>{
 const a=setup([block({subject:'SECRET',sensitivity:'private'}),event()]).analyze('other',null);assert.ok(!JSON.stringify(a).includes('SECRET'));
});
test('control personal and solo commitments remain intentional without changes',()=>{
 for(const meeting of [event({sensitivity:'private'}),event({attendees:[]})])assert.ok(!setup([block(),meeting]).analyze().issues.some(i=>i.type==='overlap'));
});
test('regression full-day Busy reason survives attendee hours and reaches empty-result decision',async()=>{
 const h=setup([block()]);const week=Object.fromEntries(['Monday','Tuesday','Wednesday','Thursday','Friday'].map(d=>[d,{hoursStart:'09:00',hoursEnd:'18:00'}]));
 const r=await h.search(undefined,undefined,{attendeeAvailability:[{email:'peer@example.test',timezone:zone,week,assumed:true}]});assert.equal(r.slots.length,0);
 assert.equal(r.diagnosticsOut.daySummary[0].owner_all_day_busy,true);
 const out=emptyResult(r.diagnosticsOut.daySummary);assert.match(out._scheduling_decision_note,/all-day commitment/);assert.doesNotMatch(out._scheduling_decision_note,/Ask the requester to choose/);
 assert.ok(!JSON.stringify(r.diagnosticsOut.daySummary).includes('Vacation'));
});
test('control ordinary hours-only failure retains bounded-hours choice',()=>{
 const out=emptyResult([{date,accepted:0,top_reasons:['outside_attendee_work_hours']}]);assert.match(out._scheduling_decision_note,/Ask the requester to choose/);
});
test('control unavailable calendar cannot report an empty calendar as healthy',async()=>{await assert.rejects(setup([],true).search(),/calendar unavailable/);});
