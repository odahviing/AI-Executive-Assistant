// Actual stored-person loader, full finder, recipient deadline floor and owner
// reminder helpers. MATCHMAKER_SNAPSHOT optionally overlays preserved source.
const {test,afterEach}=require('node:test'),assert=require('node:assert/strict');
const {DateTime,Settings}=require('luxon'),{harness}=require('./test-timezone-owner-decisions.cjs');
afterEach(()=>Settings.now=()=>Date.parse('2026-09-11T00:00Z'));
const iso=x=>DateTime.fromISO(x).toUTC().toISO();
for(const c of [
 {name:'fall first occurrence remains configured work',start:'2026-11-01T01:30:00-04:00',end:'2026-11-01T01:45:00-04:00',sh:'01:30',eh:'01:45'},
 {name:'fall second occurrence is equally configured work',start:'2026-11-01T01:30:00-05:00',end:'2026-11-01T01:45:00-05:00',sh:'01:30',eh:'01:45'},
 {name:'spring nonexistent boundary skips forward to matching real minutes',start:'2027-03-14T03:00:00-04:00',end:'2027-03-14T03:15:00-04:00',sh:'02:30',eh:'03:15'},
 {name:'ordinary configured window remains unchanged',start:'2026-11-02T01:30:00-05:00',end:'2026-11-02T01:45:00-05:00',sh:'01:30',eh:'01:45'},
 {name:'fixed hours frame admits repeated hour despite physical Tokyo zone',start:'2026-11-01T01:30:00-05:00',end:'2026-11-01T01:45:00-05:00',sh:'01:30',eh:'01:45',physical:'Asia/Tokyo',fixed:'America/New_York'},
])test(c.name,async()=>{
 const h=harness({ownerZone:'UTC',person:{timezone:c.physical??'America/New_York'},travel:null,hours:{hoursStart:c.sh,hoursEnd:c.eh,...(c.fixed?{timezone:c.fixed}:{})}});
 assert.equal((await h.find(c.start,c.end)).length,1);
 const intervals=h.availability.attendeeWorkIntervalsBetween(h.entries()[0],DateTime.fromISO(c.start),DateTime.fromISO(c.end));
 assert.deepEqual(Array.from(intervals,x=>[x.start.toUTC().toISO(),x.end.toUTC().toISO()]),[[iso(c.start),iso(c.end)]]);
 assert.equal(h.load('src/utils/responseDeadline.ts').colleagueWorkTimeBaseFromNow('UTC',Date.parse(c.start),{slackId:'person',ownerTimezone:'UTC'}),iso(c.start));
});
test('fold configured gap stays off hours and intervals retain both separate occurrences',async()=>{
 const h=harness({ownerZone:'UTC',person:{timezone:'America/New_York'},travel:null,hours:{hoursStart:'01:30',hoursEnd:'01:45'}});
 assert.equal((await h.find('2026-11-01T01:45:00-04:00','2026-11-01T01:00:00-05:00')).length,0);
 const intervals=h.availability.attendeeWorkIntervalsBetween(h.entries()[0],DateTime.fromISO('2026-11-01T00:00:00-04:00'),DateTime.fromISO('2026-11-02T00:00:00-05:00'));
 assert.deepEqual(Array.from(intervals,x=>[x.start.toUTC().toISO(),x.end.toUTC().toISO()]),[['2026-11-01T05:30:00.000Z','2026-11-01T05:45:00.000Z'],['2026-11-01T06:30:00.000Z','2026-11-01T06:45:00.000Z']]);
});
test('wholly nonexistent configured window creates no shifted work interval',async()=>{
 const h=harness({ownerZone:'UTC',person:{timezone:'America/New_York'},travel:null,hours:{hoursStart:'02:10',hoursEnd:'02:45'}});
 assert.equal((await h.find('2027-03-14T03:10:00-04:00','2027-03-14T03:25:00-04:00')).length,0);
 assert.equal(h.availability.attendeeWorkIntervalsBetween(h.entries()[0],DateTime.fromISO('2027-03-14T00:00:00-05:00'),DateTime.fromISO('2027-03-15T00:00:00-04:00')).length,0);
});
for(const c of [{name:'fold second occurrence',now:'2026-11-01T01:20:00-05:00',start:'2026-11-01T01:30:00-05:00',end:'2026-11-01T01:45:00-05:00',window:'01:30-01:45'},{name:'spring nonexistent boundary',now:'2027-03-14T01:59:00-05:00',start:'2027-03-14T03:00:00-04:00',end:'2027-03-14T03:15:00-04:00',window:'02:30-03:15'}])test('owner finder and reminder agree at '+c.name,async()=>{
 const h=harness({ownerZone:'America/New_York',person:{timezone:'UTC'},travel:null,hours:{hoursStart:'00:00',hoursEnd:'24:00'}});
 for(const day of Object.keys(h.profile.schedule.work_hours))h.profile.schedule.work_hours[day]=[c.window];
 assert.equal((await h.find(c.start,c.end)).length,1);
 Settings.now=()=>Date.parse(c.now);
 assert.equal(h.load('src/utils/workHours.ts').nextOwnerWorkdayStart(h.profile),iso(c.start));
});
