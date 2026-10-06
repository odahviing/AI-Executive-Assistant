// Executes the real ops handler, finder, validator and owner-hours helpers.
// Shared Garage controls run too, preserving the previously reviewed path.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {run}=require('./test-garage-recovery-summary.cjs');
const {Settings,DateTime}=require('luxon');
test('unspecified timing ends after next two owner workdays, skipping weekend',async()=>{
 if(process.env.GARAGE_BEFORE && !process.env.WINDOW_CHILD){
  const child=require('node:child_process').spawnSync(process.execPath,['--test','--test-name-pattern=unspecified timing',__filename],{env:{...process.env,WINDOW_CHILD:'1'},timeout:15000,encoding:'utf8'});
  assert.equal(child.status,0,child.error?.message??child.stdout);return;
 }
 Settings.now=()=>Date.parse('2026-10-08T07:00:00Z');
 const {calls}=await run({clean:true,argsOverride:{search_from:undefined,search_to:undefined}});
 const first=calls.searches[0];
 assert.equal(DateTime.fromISO(first.searchFrom).toISODate(),'2026-10-08');
 assert.equal(DateTime.fromISO(first.searchTo).toISODate(),'2026-10-12');
 assert.equal(first.autoExpand,false);
});
test('explicit long flexible interval never expands to obtain more options',async()=>{
 const {calls}=await run({clean:true,argsOverride:{search_from:'2026-10-11',search_to:'2026-10-22'}});
 assert.ok(calls.searches.length);
 for(const call of calls.searches){assert.equal(call.autoExpand,false);assert.equal(DateTime.fromISO(call.searchTo).toISODate(),'2026-10-22');}
});
test('explicit hard clock interval retains exact supplied deadline',async()=>{
 const {calls}=await run({clean:true,argsOverride:{search_from:'2026-10-08T10:00:00+03:00',search_to:'2026-10-12T11:00:00+03:00',time_window_is_hard:true}});
 assert.equal(DateTime.fromISO(calls.searches[0].searchFrom).toMillis(),DateTime.fromISO('2026-10-08T10:00:00+03:00').toMillis());
 assert.equal(calls.searches[0].searchTo,'2026-10-12T11:00:00+03:00');
});
const {harness}=require('./test-timezone-owner-interval.cjs');
test('default window honors dated offday and destination timezone hours',()=>{
 Settings.now=()=>Date.parse('2026-10-08T07:00:00Z');
 const h=harness({'2026-10-09':{isWorkday:false},'2026-10-11':{isWorkday:true,timezone:'America/New_York',windows:['09:00-17:00']}});
 const window=h.load('src/utils/workHours.ts').defaultMeetingSearchWindow(h.profile);
 assert.equal(DateTime.fromISO(window.to,{setZone:true}).toISODate(),'2026-10-11');
 assert.equal(DateTime.fromISO(window.to,{setZone:true}).offset,-240);
});
test('no configured future workdays fails without inventing a working window',()=>{
 const h=harness();h.profile.schedule.work_hours={};h.profile.schedule.office_days.days=[];
 assert.throws(()=>h.load('src/utils/workHours.ts').defaultMeetingSearchWindow(h.profile),/No two future owner working days/);
});
