// Actual Graph walker + shared validators; fixture calendar/DB only. No live I/O.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./test-timezone-owner-interval.cjs');
const {Settings}=require('luxon');
Settings.now=()=>Date.parse('2026-11-03T14:00:00Z');
const start='2026-11-16T15:40:00-05:00',end='2026-11-16T16:35:00-05:00';
const peer='chris@example.test',other='adam@example.test';
function setup({busy=true,ownerBusy=false,floor=true,realCategory=false}={}){
 const events=ownerBusy?[{id:'private-owner-event',subject:'PRIVATE SENTINEL',sensitivity:'private',showAs:'busy',start:{dateTime:start},end:{dateTime:end},attendees:[]}]:[];
 const h=harness({}, {realAvailability:true,extraMocks:{
  ...(realCategory?{'src/utils/categoryRules.ts':null}:{}),
  'src/connectors/graph/calendarReads.ts':{getFreeBusyForDecision:async()=>busy?{[peer]:[{start,end,status:'busy'}],[other]:[{start,end,status:'busy'}]}:{},getOwnerEventsForDecision:async()=>events,isOutageShaped:()=>false,CalendarOfflineError:Error},
 }});
 h.profile.user.timezone='America/New_York';
 h.profile.schedule.work_hours={Monday:['09:00-17:00']};
 h.profile.meetings.work_hours_per_free_hour=floor?1:0;
 return {...h,run:async(extra={})=>{const diagnosticsOut={};const slots=await h.find(start,end,{timezone:'America/New_York',attendeeBusyEmails:[peer,other],diagnosticsOut,...extra});return {slots,diag:diagnosticsOut};}};
}
test('regression exact slot reports all busy attendees and independent owner focus floor',async()=>{
 const {slots,diag}=await setup().run();assert.equal(slots.length,0);
 for(const key of [`attendee_busy_collision:${peer}`,`attendee_busy_collision:${other}`,'focus_time_office'])assert.ok(Object.keys(diag.rejectedCounts??{}).includes(key),JSON.stringify(diag));
});
test('regression exact owner overlap never hides independent focus restriction or private details',async()=>{
 const {slots,diag}=await setup({ownerBusy:true}).run({viewer:'colleague'});assert.equal(slots.length,0);
 for(const key of ['owner_busy_collision','focus_time_office'])assert.ok(Object.keys(diag.rejectedCounts??{}).includes(key),JSON.stringify(diag));
 assert.ok(!JSON.stringify(diag).includes('PRIVATE SENTINEL'));
});
test('regression exact busy and offhours are independent attendee facts',async()=>{
 const {slots,diag}=await setup({floor:false}).run({attendeeAvailability:[{email:peer,timezone:'America/New_York',week:require('./fixtures/regular-week.cjs').regularWeek(['Monday'],'09:00','15:00')}]});
 assert.equal(slots.length,0);assert.ok(diag.rejectedCounts[`outside_attendee_work_hours:${peer}`],JSON.stringify(diag));
});
test('control clean exact slot remains available',async()=>{const {slots,diag}=await setup({busy:false,floor:false}).run();assert.equal(slots.length,1);assert.equal(Object.keys(diag.rejectedCounts??{}).length,0);});
test('control scoped busy consent does not waive owner floor',async()=>{const {slots,diag}=await setup().run({tagAttendeeConflicts:true});assert.equal(slots.length,0);assert.ok(diag.rejectedCounts.focus_time_office);});
test('control owner relaxed approval preserves annotations without weakening overlap exclusion',async()=>{const {slots}=await setup().run({relaxed:true,allowAttendeeOffHours:true,viewer:'owner'});assert.equal(slots.length,1);assert.equal(slots[0].attendee_conflicts.length,2);assert.equal((await setup({ownerBusy:true}).run({relaxed:true})).slots.length,0);});
const {run}=require('./test-garage-recovery-summary.cjs');
test('regression colleague candidate carries attendee reason and private owner approval requirement',async()=>{
 const {out}=await run({busy:true,role:'colleague',argsOverride:{candidate_slots:[{start:'2026-10-06T15:40:00+03:00'}],duration_minutes:55}});
 assert.equal(out.mode,'candidate_validation');const result=out.results[0];assert.equal(result.available,false);
 assert.equal(result.broken_rules,undefined);assert.equal(result.less_preferred_label,'requires owner approval');assert.ok(result.broken_rule_labels.some(x=>x.startsWith('attendee_busy_collision:')));assert.ok(!JSON.stringify(result).includes('focus_time_office'));
});
test('regression named preferred slot carries complete canonical diagnostics',async()=>{
 const {out}=await run({busy:true,argsOverride:{preferred_slot:'2026-10-06T15:40:00+03:00',duration_minutes:55}});
 const result=out.preferred_slot_status;assert.ok(result,JSON.stringify(out));assert.equal(result.available,false);assert.ok(result.broken_rules.includes('focus_time_office'));assert.ok(result.broken_rules.some(x=>x.startsWith('attendee_busy_collision:')));
});
test('control attendee-only conflict never becomes an owner approval',async()=>{
 const {out}=await run({busy:true,clean:true,role:'colleague',argsOverride:{candidate_slots:[{start:'2026-10-06T15:40:00+03:00'}],duration_minutes:55}});
 assert.equal(out.results[0].less_preferred_label,undefined);assert.ok(out.results[0].broken_rule.startsWith('attendee_busy_collision:'));
});
test('control email point diagnostics never disclose owner rule mechanics',async()=>{
 const {out}=await run({busy:true,role:'owner',contextOverride:{channel:'email'},argsOverride:{candidate_slots:[{start:'2026-10-06T15:40:00+03:00'}],duration_minutes:55}});
 const result=out.results[0];assert.equal(result.broken_rule_labels,undefined);assert.equal(result.broken_rules,undefined);assert.ok(!JSON.stringify(result).includes('focus_time_office'));
});
test('regression exact category diagnosis includes day type and both independent limits',async()=>{
 const h=setup({busy:false,floor:false,realCategory:true});h.profile.categories=[{name:'Weekly',day_type:'home_days',limits:{per_day:0,per_week:0}}];
 const {slots,diag}=await h.run({category:'Weekly'});assert.equal(slots.length,0);
 for(const reason of ['category_day_type','category_per_day','category_per_week'])assert.ok(diag.rejectedCounts[reason],JSON.stringify(diag));
});
test('control category-free or compliant slots remain available',async()=>{
 const h=setup({busy:false,floor:false,realCategory:true});h.profile.categories=[{name:'Weekly',day_type:'office_days',limits:{per_day:2,per_week:5}}];
 assert.equal((await h.run({category:'Weekly'})).slots.length,1);
 assert.equal((await h.run({category:null})).slots.length,1);
});
test('control room-clamped colleague path withholds private owner mechanics',async()=>{
 const {out}=await run({busy:true,role:'colleague',contextOverride:{surface:'room',isMpim:true},argsOverride:{candidate_slots:[{start:'2026-10-06T15:40:00+03:00'}],duration_minutes:55}});
 assert.equal(out.results[0].broken_rules,undefined);assert.ok(!JSON.stringify(out).includes('focus_time_office'));
});
test('control owner-approval alternatives without primary code retain private-label masking',async()=>{
 const {out}=await run({role:'colleague',mustBe:true});assert.ok(out.owner_approval_candidates.length);
 for(const candidate of out.owner_approval_candidates){assert.equal(candidate.broken_rule_label,undefined);assert.equal(candidate.broken_rules,undefined);}
});
test('control unavailable calendar never fabricates a complete verdict',async()=>{
 const h=harness({}, {offline:true});await assert.rejects(()=>h.find(start,end),/fixture calendar unavailable/);
});
