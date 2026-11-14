const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,at}=require('./test-nov13-second-scheduling.cjs');
for(const [label,bounds] of [['dates',{search_from:'2026-10-05',search_to:'2026-10-05'}],['soft clocks',{search_from:'2026-10-05T09:00',search_to:'2026-10-05T16:00'}],['hard clock',{time_window_is_hard:true,search_from:at('09:00'),search_to:at('11:55')}]]){
 test(label+' ends before predecessor and cannot create a later-day offer',async()=>{
   const f=fixture(),r=await f.search({...bounds,must_be_after_event_id:'anchor'});assert.ok(!r.slots?.length&&!r.length);assert.ok(!f.collected.offers?.length);
 });
}
test('preferred meeting ending outside an anchored hard deadline is unavailable',async()=>{
 const f=fixture(),r=await f.search({search_from:at('09:00'),search_to:at('14:00'),time_window_is_hard:true,must_be_after_event_id:'anchor',preferred_slot:at('13:50')});
 assert.equal(r.preferred_slot_status.available,false);assert.ok(!f.collected.offers.some(s=>Date.parse(s.start)===Date.parse(at('13:50'))));
});
test('explicit candidates on later date cannot escape an anchored requested date',async()=>{
 const f=fixture(),r=await f.search({search_from:'2026-10-06',search_to:'2026-10-06',must_be_after_event_id:'anchor',candidate_slots:[{start:at('12:00')},{start:'2026-10-07T12:00:00+03:00'}]});
 assert.deepEqual(Array.from(r.results,v=>v.available),[true,false]);assert.equal(f.collected.offers.length,1);
});
test('legitimate zero-width point after the predecessor still tests its exact start',async()=>{
 const f=fixture(),r=await f.search({search_from:at('13:00'),search_to:at('13:00'),time_window_is_hard:true,must_be_after_event_id:'anchor',candidate_slots:[{start:at('13:00')}]});assert.equal(r.results[0].available,true);
});
test('after-anchor named time before the requested lower date is unavailable',async()=>{
 const f=fixture(),r=await f.search({search_from:'2026-10-07',search_to:'2026-10-08',must_be_after_event_id:'anchor',candidate_slots:[{start:at('13:00')}]});
 assert.equal(r.results[0].available,false);assert.ok(!f.collected.offers?.length);
});
test('inverted anchored requested dates cannot extend the upper date',async()=>{
 const f=fixture(),r=await f.search({search_from:'2026-10-07',search_to:'2026-10-05',must_be_after_event_id:'anchor'});
 assert.ok(!r.slots?.length&&!r.length);assert.ok(!f.collected.offers?.length);
});
