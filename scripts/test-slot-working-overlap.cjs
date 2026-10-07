// Actual availability resolvers -> finder -> actual spread. All calendar and
// contact I/O isolated, explicit clocks/schedules, no external writes or LLM.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DateTime,Settings}=require('luxon');
const {harness}=require('./test-timezone-owner-interval.cjs');
Settings.now=()=>Date.parse('2026-10-01T00:00:00Z');
const all=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function person(id,tz,days=all,start='09:00',end='17:00',extra={}){
 return {person_id:id,email:id+'@example.test',timezone:tz,profile_json:JSON.stringify({working_hours_structured:{week:require('./fixtures/regular-week.cjs').regularWeek(days,start,end,extra.dayOverrides),source:'manual',...(extra.timezone?{timezone:extra.timezone}:{})}}),notes:'PRIVATE CONTACT NOTES'};
}
function fixture({contacts=[],ownerZone='Asia/Jerusalem',rows={},unavailable=false,dense=false}={}){
 const h=harness(rows,{realAvailability:true,realDensity:dense,extraMocks:{
  'src/db.ts':{listSchedulingContacts:()=>{if(unavailable)throw Error('contact store offline');return contacts;},getEffectiveTimezoneById:id=>({timezone:contacts.find(p=>p.person_id===id)?.timezone}),getTravelRecordById:id=>contacts.find(p=>p.person_id===id)?.travel??null},
  'src/utils/locationTz.ts':{inferTimezoneFromStateStatic:x=>x},
 }});
 h.profile.user.timezone=ownerZone;
 h.profile.schedule.work_hours=Object.fromEntries(all.map(d=>[d,['09:00-23:59']]));
 h.profile.meetings.offered_slot_count=8;
 h.profile.meetings.work_hours_per_free_hour=0;
 h.profile.meetings.packing_preference=dense?'dense':'spread';
 const a=h.load('src/utils/attendeeAvailability.ts');
 const entry=(tz,days=all,start='09:00',end='17:00',extra={})=>({email:'meeting@example.test',timezone:tz,homeTimezone:tz,week:require('./fixtures/regular-week.cjs').regularWeek(days,start,end),...extra});
 const search=async(from,to,attendee,extra={})=>h.load('src/connectors/graph/findAvailableSlots.ts').findAvailableSlots({userEmail:h.profile.user.email,timezone:ownerZone,profile:h.profile,durationMinutes:30,searchFrom:from,searchTo:to,autoExpand:false,minBufferHours:0,attendeeAvailability:[attendee],...extra});
 const pick=(slots,count=1)=>h.load('src/connectors/graph/calendarReads.ts').pickSpreadSlots(slots,ownerZone,count,undefined,30);
 return {...h,a,entry,search,pick};
}
test('US meeting keeps late less-shared candidates before day cap and selection',async()=>{
 const h=fixture({contacts:[person('israel','Asia/Jerusalem',['Sunday','Monday','Tuesday','Wednesday','Thursday'],'09:00','18:00')]});
 const slots=await h.search('2026-10-08T09:00:00+03:00','2026-10-08T23:59:00+03:00',h.entry('America/New_York',all,'09:00','17:00'));
 const chosen=slots.find(s=>s.start===h.pick(slots)[0]);
 assert.ok(DateTime.fromISO(chosen.start,{setZone:true}).hour>=18,JSON.stringify(slots));
 assert.equal(chosen.priority,'good');assert.equal(chosen.shared_overlap,0);
 const spread=h.pick(slots,8);assert.ok(spread.includes(slots.reduce((a,b)=>Date.parse(a.start)<Date.parse(b.start)?a:b).start),'earlier reasonable choice survives');
});
test('Friday preference emerges inside supplied interval, including external attendees',async()=>{
 const h=fixture({contacts:[person('israel','Asia/Jerusalem',['Sunday','Monday','Tuesday','Wednesday','Thursday'],'09:00','18:00')]});
 const slots=await h.search('2026-10-08T15:00:00+03:00','2026-10-09T18:00:00+03:00',h.entry('America/New_York',all,'09:00','11:00'));
 assert.equal(DateTime.fromISO(h.pick(slots)[0]).toISODate(),'2026-10-09');
 assert.ok(slots.every(s=>Date.parse(s.end)<=Date.parse('2026-10-09T18:00:00+03:00')));
});
test('Israeli meeting prefers Sunday or morning only when actual comparison hours permit',async()=>{
 const h=fixture({contacts:[person('us','America/New_York',['Monday','Tuesday','Wednesday','Thursday','Friday'])]});
 const slots=await h.search('2026-10-11T09:00:00+03:00','2026-10-12T18:00:00+03:00',h.entry('Asia/Jerusalem',all,'09:00','18:00'));
 assert.equal(DateTime.fromISO(h.pick(slots)[0]).toISODate(),'2026-10-11');
 const morning=slots.find(s=>s.start.includes('2026-10-12T09:00'));assert.equal(morning.shared_overlap,0);
});
test('Boston owner uses actual Israel overlap, not owner-country flags',async()=>{
 const h=fixture({ownerZone:'America/New_York',contacts:[person('israel','Asia/Jerusalem',all,'09:00','18:00')]});
 const slots=await h.search('2026-10-12T09:00:00-04:00','2026-10-12T17:00:00-04:00',h.entry('America/New_York'));
 assert.ok(DateTime.fromISO(h.pick(slots)[0],{setZone:true}).hour>=11);
});
test('per-day hours and Friday overrides reverse the apparent regional preference',async()=>{
 const h=fixture({contacts:[person('israel','Asia/Jerusalem',['Thursday','Friday'],'09:00','18:00',{dayOverrides:{Thursday:{hoursStart:'09:00',hoursEnd:'10:00'},Friday:{hoursStart:'15:00',hoursEnd:'18:00'}}})]});
 const slots=await h.search('2026-10-08T15:00:00+03:00','2026-10-09T18:00:00+03:00',h.entry('America/New_York',all,'09:00','11:00'));
 assert.equal(DateTime.fromISO(h.pick(slots)[0]).toISODate(),'2026-10-08');
});
test('all contacts beyond ten and Slack-only resolve; owner, attendee and unknown excluded without leaking rows',()=>{
 const contacts=Array.from({length:12},(_,i)=>person('p'+i,'Asia/Jerusalem'));
 contacts.push({...person('slack','America/New_York'),email:null,slack_id:'UPEER'});
 contacts.push({...person('owner','Asia/Jerusalem'),email:'owner@example.test',slack_id:'UOWNER'});
 contacts.push({...person('meeting','Asia/Jerusalem'),email:'meeting@example.test'});
 contacts.push({...person('unknown',null),timezone:null});
 const h=fixture({contacts});const entries=h.a.loadSchedulingComparisonAvailability(h.profile,[h.entry('Asia/Jerusalem')]);
 assert.equal(entries.length,13);assert.ok(!JSON.stringify(entries).includes('PRIVATE'));assert.ok(!JSON.stringify(entries).includes('owner@'));
});
test('travel and DST are resolved on each slot date including return boundary',()=>{
 const h=fixture({contacts:[{...person('traveler','Asia/Jerusalem'),travel:{location:'America/New_York',from:'2026-10-30',until:'2026-11-01'}}]});
 const entries=h.a.loadSchedulingComparisonAvailability(h.profile,[]);
 const intervals=h.a.schedulingComparisonIntervals(entries,DateTime.fromISO('2026-10-30T00:00Z'),DateTime.fromISO('2026-11-03T00:00Z'))[0];
 const firstOn=d=>intervals.find(i=>DateTime.fromMillis(i.start,{zone:'UTC'}).toISODate()===d);
 assert.equal(DateTime.fromMillis(firstOn('2026-10-30').start,{zone:'UTC'}).hour,13);
 assert.equal(DateTime.fromMillis(firstOn('2026-11-01').start,{zone:'UTC'}).hour,14);
 assert.equal(DateTime.fromMillis(firstOn('2026-11-02').start,{zone:'UTC'}).hour,7);
});
test('CONTROL unavailable cohort keeps validity and deterministic offers without claiming shared overlap',async()=>{
 const h=fixture({unavailable:true});const slots=await h.search('2026-10-08T09:00:00+03:00','2026-10-08T12:00:00+03:00',h.entry('Asia/Jerusalem'));
 assert.ok(slots.length);assert.ok(slots.every(s=>s.shared_overlap===undefined));assert.equal(h.pick(slots)[0],slots[0].start);
});
test('CONTROL tight explicit interval never reaches Friday or off-hours for ranking',async()=>{
 const h=fixture({contacts:[person('israel','Asia/Jerusalem',all,'09:00','18:00')]});
 const slots=await h.search('2026-10-08T16:00:00+03:00','2026-10-08T17:00:00+03:00',h.entry('America/New_York'));
 assert.ok(slots.length);assert.ok(slots.every(s=>Date.parse(s.end)<=Date.parse('2026-10-08T17:00:00+03:00')));
 const none=await h.search('2026-10-08T10:00:00+03:00','2026-10-08T11:00:00+03:00',h.entry('America/New_York'));assert.equal(none.length,0);
});
test('CONTROL optional and disturbed slots cannot outrank clean day quality',()=>{
 const h=fixture();const slots=[{start:'2026-10-08T10:00:00Z',priority:'good',shared_overlap:0,over_optional:'soft'},{start:'2026-10-08T11:00:00Z',priority:'medium',shared_overlap:1},{start:'2026-10-08T12:00:00Z',priority:'low',shared_overlap:0,disturbs_floating_block:true}];
 assert.equal(h.pick(slots)[0],slots[1].start);
});
test('dense day-quality score still protects against dead gaps before overlap preference',()=>{
 const h=fixture({dense:true});const score=h.load('src/utils/calendarDensity.ts').scoreSlotDensity;
 const ms=s=>Date.parse('2026-10-08T'+s+':00Z');
 const commitments=[{start:ms('09:00'),end:ms('09:30')},{start:ms('11:00'),end:ms('11:30')}];
 const cfg={bufferMinutes:5,minBreakMinutes:30};
 const bad=score(ms('09:45'),ms('10:15'),commitments,cfg),good=score(ms('09:30'),ms('10:00'),commitments,cfg);
 assert.ok(bad.createsDeadGap);assert.ok(!good.createsDeadGap);
 const slots=[{start:'2026-10-08T09:45:00Z',priority:'low',shared_overlap:0,density:bad.score},{start:'2026-10-08T09:30:00Z',priority:'medium',shared_overlap:1,density:good.score}];
 assert.equal(h.pick(slots)[0],slots[1].start);
});
const {run}=require('./test-garage-recovery-summary.cjs');
for(const role of ['owner','colleague'])test('integrated '+role+' handler presents priority before earlier alternatives without exposing contacts',async()=>{
 const {out,warnings}=await run({role,clean:true,contacts:[person('private-israel','Asia/Jerusalem',all,'09:00','18:00')],
  workHoursOverride:Object.fromEntries(all.map(d=>[d,['09:00-23:59']])),
  availabilityOverride:[{email:'peer@example.test',timezone:'America/New_York',week:require('./fixtures/regular-week.cjs').regularWeek(all)}],
  argsOverride:{search_from:'2026-10-08T16:00:00+03:00',search_to:'2026-10-08T23:59:00+03:00',time_window_is_hard:true},
 });
 const slots=Array.isArray(out)?out:out.slots;assert.ok(slots?.length,JSON.stringify(out));assert.equal(slots[0].priority,'good');
 assert.ok(DateTime.fromISO(slots[0].start,{setZone:true}).hour>=18);
 assert.ok(slots.some(s=>DateTime.fromISO(s.start,{setZone:true}).hour<18));
 assert.ok(!JSON.stringify(out).includes('PRIVATE CONTACT'));assert.ok(!JSON.stringify(out).includes('private-israel'));
 assert.ok(!JSON.stringify(out).includes('shared_overlap'));assert.ok(slots.every(s=>!Object.hasOwn(s,'shared_overlap')));
 assert.equal(warnings.length,0,JSON.stringify(warnings));
});
