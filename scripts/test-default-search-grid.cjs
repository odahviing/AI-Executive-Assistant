// Real tool dispatch -> handler -> finder -> validator -> spreader. Calendar I/O
// is isolated; no live calls or writes. SLOT_PRIORITY_BEFORE loads retained code.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DateTime,Settings}=require('luxon');
const {run}=require('./test-garage-recovery-summary.cjs');
const {harness}=require('./test-timezone-owner-interval.cjs');
const incident='2026-10-18T11:33:11.890+03:00';
const noDates={search_from:undefined,search_to:undefined,duration_minutes:10};
const clock=iso=>{Settings.now=()=>Date.parse(iso);};
const starts=out=>Array.from(Array.isArray(out)?out:out.slots??[],s=>s.start);
const grid=s=>{const d=DateTime.fromISO(s);return d.minute%15===0&&d.second===0&&d.millisecond===0;};
for(const role of ['owner','colleague'])for(const packing of ['dense','spread'])test(`default ${role} ${packing} arbitrary clock returns eight aligned offers across five dates`,async()=>{
 clock(incident);
 const {out,calls}=await run({clean:true,role,realDensity:true,meetingsOverride:{packing_preference:packing,offered_slot_count:8},argsOverride:noDates});
 assert.equal(out.slots.length,8);assert.ok(starts(out).every(grid),JSON.stringify(starts(out)));
 assert.equal(new Set(starts(out).map(s=>s.slice(0,10))).size,5);
 assert.equal(DateTime.fromISO(calls.searches[0].searchFrom).toMillis(),Date.parse('2026-10-18T11:45:00+03:00'));
 assert.equal(DateTime.fromISO(calls.searches[0].searchTo).setZone('Asia/Jerusalem').toISODate(),'2026-10-22');
 assert.ok(starts(out).every(s=>Date.parse(s)>=Date.parse(incident)));assert.ok(calls.searches.every(s=>s.autoExpand===false));
});
test('CONTROL explicit hard off-grid start survives handler and exact validation',async()=>{
 clock(incident);const start='2026-10-19T15:03:00+03:00',end='2026-10-19T15:13:00+03:00';
 const {out,h}=await run({clean:true,realDensity:true,argsOverride:{search_from:start,search_to:end,time_window_is_hard:true,duration_minutes:10}});
 assert.deepEqual(starts(out).map(Date.parse),[Date.parse(start)],JSON.stringify(out));assert.equal((await h.find(start,end)).length,1);assert.equal(h.check(start,end).passes,true);
});
test('CONTROL explicit two-date range is never widened to satisfy five-date preference',async()=>{
 clock(incident);const {out,calls}=await run({clean:true,realDensity:true,argsOverride:{search_from:'2026-10-19',search_to:'2026-10-20',duration_minutes:10}});
 assert.equal(out.slots.length,8);assert.equal(new Set(starts(out).map(s=>s.slice(0,10))).size,2);
 assert.ok(calls.searches.every(s=>DateTime.fromISO(s.searchTo).setZone('Asia/Jerusalem').toISODate()==='2026-10-20'&&!s.autoExpand));
});
test('CONTROL dense explicit connective off-grid edge remains valid',async()=>{
 clock(incident);const start='2026-10-19T12:10:00+03:00',end='2026-10-19T12:20:00+03:00';
 const {out}=await run({clean:true,realDensity:true,meetingsOverride:{packing_preference:'dense'},ownerBusy:[{start:'2026-10-19T11:00:00+03:00',end:start,status:'busy'}],argsOverride:{search_from:start,search_to:end,duration_minutes:10,time_window_is_hard:true}});
 assert.deepEqual(starts(out).map(Date.parse),[Date.parse(start)],JSON.stringify(out));
});
test('default dense offers keep connective quarter-hour choices before dead gaps',async()=>{
 clock(incident);const ownerBusy=Array.from({length:5},(_,i)=>({start:`2026-10-${18+i}T14:00:00+03:00`,end:`2026-10-${18+i}T14:30:00+03:00`,status:'busy'}));
 const {out}=await run({clean:true,realDensity:true,ownerBusy,meetingsOverride:{packing_preference:'dense',buffer_minutes:5},argsOverride:{...noDates,duration_minutes:25}});
 assert.equal(out.slots.length,8);assert.equal(new Set(starts(out).map(s=>s.slice(0,10))).size,5);
 for(let day=18;day<=22;day++)assert.ok(starts(out).some(s=>s.startsWith(`2026-10-${day}T13:30`)||s.startsWith(`2026-10-${day}T14:30`)),JSON.stringify(starts(out)));
});
for(const [now,last]of [['2026-10-18T08:03:11+03:00','2026-10-22'],['2026-10-18T17:59:59+03:00','2026-10-25'],['2026-10-18T18:00:00+03:00','2026-10-25'],['2026-10-23T12:33:11+03:00','2026-10-29']])test(`default horizon counts only remaining working dates at ${now}`,async()=>{
 clock(now);const {calls}=await run({clean:true,realDensity:true,argsOverride:noDates});assert.equal(DateTime.fromISO(calls.searches[0].searchTo).setZone('Asia/Jerusalem').toISODate(),last);
});
test('default horizon skips dated offdays and retains destination endpoint zone',async()=>{
 clock(incident);const {calls}=await run({clean:true,realDensity:true,argsOverride:noDates,overrideRows:{'2026-10-19':{isWorkday:false},'2026-10-25':{isWorkday:true,timezone:'America/New_York',windows:['09:00-17:00']}}});
 const end=DateTime.fromISO(calls.searches[0].searchTo,{setZone:true});assert.equal(end.toISODate(),'2026-10-25');assert.equal(end.offset,-240);
});
for(const now of ['2026-11-01T01:33:11.890-04:00','2026-11-01T01:33:11.890-05:00','2027-03-14T01:59:59.990-05:00'])test(`Boston DST default clock remains forward and quarter-aligned ${now}`,async()=>{
 clock(now);const h=harness({}, {realDensity:true});h.profile.user.timezone='America/New_York';
 h.profile.schedule.work_hours=Object.fromEntries(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(d=>[d,['00:00-23:59']]));
 const win=h.load('src/utils/workHours.ts').defaultMeetingSearchWindow(h.profile);
 assert.ok(grid(win.from));assert.ok(Date.parse(win.from)>=Date.parse(now));assert.ok(Date.parse(win.from)-Date.parse(now)<15*60000);
 const slots=await h.find(win.from,DateTime.fromISO(win.from).plus({minutes:30}).toISO(),{timezone:'America/New_York',durationMinutes:10});assert.ok(slots.length);assert.ok(slots.every(s=>grid(s.start)));
});
test('CONTROL default unavailable calendar rejects and retry deterministically recomputes offers',async()=>{
 clock(incident);await assert.rejects(()=>run({offline:true,realDensity:true,argsOverride:noDates}),/fixture calendar unavailable/);
 const options={clean:true,realDensity:true,argsOverride:noDates};assert.deepEqual(starts((await run(options)).out),starts((await run(options)).out));
});
test('CONTROL default unknown attendee stays disclosed without fabricated certainty',async()=>{
 clock(incident);const {out}=await run({clean:true,unknown:true,realDensity:true,argsOverride:noDates});assert.ok(out.slots.length);assert.ok(out.attendees_not_checked.includes('peer@example.test'));
});
