// Actual loader, Graph finder, interval helper and deadline consumer; external I/O is isolated.
const path=require('node:path'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
if(process.argv.includes('--before')) process.env.MATCHMAKER_SNAPSHOT='artifacts/workshop-verification/weekly-windows-20261029/matchmaker/before';
const {test}=require('node:test'),assert=require('node:assert/strict'),{DateTime}=require('luxon');
const {harness}=require('./test-timezone-owner-decisions.cjs'),{regularWeek}=require('./fixtures/regular-week.cjs');
const split=[{hoursStart:'08:00',hoursEnd:'18:00'},{hoursStart:'20:30',hoursEnd:'22:30'}];
const fixture=(options={})=>harness({ownerZone:'America/New_York',person:{timezone:'Asia/Jerusalem'},travel:{from:'2026-10-01',until:'2026-11-30',location:'America/New_York'},hours:{week:regularWeek(['Monday','Tuesday','Wednesday','Thursday'],'08:00','18:00',{Tuesday:split}),timezone:'Asia/Jerusalem'},...options});
for(const date of ['2026-10-20','2026-10-27','2026-11-03'])for(const [name,start,end,n] of [
 ['day window','08:00','08:25',1],['day closing boundary','17:35','18:00',1],
 ['gap','19:00','19:25',0],['crosses gap','17:45','20:45',0],
 ['evening opening','20:30','20:55',1],['evening closing boundary','22:05','22:30',1],
 ['after evening','22:30','22:55',0],['before evening','20:15','20:40',0],
])test(`${date} fixed Jerusalem in Boston: ${name}`,async()=>{
 const a=DateTime.fromISO(`${date}T${start}`,{zone:'Asia/Jerusalem'}).toISO(),b=DateTime.fromISO(`${date}T${end}`,{zone:'Asia/Jerusalem'}).toISO();
 assert.equal((await fixture().find(a,b)).length,n);
});
test('actual intervals preserve two windows and the full gap',()=>{
 const h=fixture(),a=DateTime.fromISO('2026-11-03T00:00+02:00'),b=a.plus({days:1});
 assert.equal(JSON.stringify(h.availability.attendeeWorkIntervalsBetween(h.entries()[0],a,b).map(i=>[i.start.toFormat('HH:mm'),i.end.toFormat('HH:mm')])),JSON.stringify([['08:00','18:00'],['20:30','22:30']]));
});
test('recipient timer in gap waits for evening not next morning',()=>{
 const h=fixture();assert.equal(h.load('src/utils/responseDeadline.ts').colleagueWorkTimeBaseFromNow('UTC',Date.parse('2026-11-03T19:00+02:00'),{slackId:'p1',ownerTimezone:'UTC'}),'2026-11-03T18:30:00.000Z');
});
test('explicit named time allows off-hours; relaxed ordinary search does not',async()=>{
 const h=fixture(),a='2026-11-03T19:00+02:00',b='2026-11-03T19:25+02:00';
 assert.equal((await h.find(a,b,{relaxed:true,tagAttendeeConflicts:true})).length,0);
 assert.equal((await h.find(a,b,{relaxed:true,tagAttendeeConflicts:true,allowAttendeeOffHours:true})).length,1);
});
test('search without colleague clipping remains admitted control',async()=>{
 const h=harness({ownerZone:'UTC',person:{timezone:'UTC'},travel:null});
 // Empty attendee list legitimately bypasses colleague clipping before and after.
 assert.equal((await h.find('2026-11-03T10:00Z','2026-11-03T10:25Z',{attendeeAvailability:undefined})).length,1);
});
for(const offset of ['-04:00','-05:00'])test('split repeated DST hour '+offset,async()=>{
 const h=fixture({person:{timezone:'America/New_York'},travel:null,hours:{week:regularWeek(['Sunday'],'09:00','17:00',{Sunday:[{hoursStart:'01:30',hoursEnd:'01:45'},{hoursStart:'03:00',hoursEnd:'04:00'}]})}});
 assert.equal((await h.find('2026-11-01T01:30:00'+offset,'2026-11-01T01:45:00'+offset)).length,1);
 assert.equal((await h.find('2026-11-01T02:00:00-05:00','2026-11-01T02:25:00-05:00')).length,0);
});
test('spring nonexistent first window does not erase valid second window',()=>{
 const h=fixture({person:{timezone:'America/New_York'},travel:null,hours:{week:regularWeek(['Sunday'],'09:00','17:00',{Sunday:[{hoursStart:'02:10',hoursEnd:'02:45'},{hoursStart:'04:00',hoursEnd:'05:00'}]})}});
 const intervals=h.availability.attendeeWorkIntervalsBetween(h.entries()[0],DateTime.fromISO('2027-03-14T00:00-05:00'),DateTime.fromISO('2027-03-15T00:00-04:00'));
 assert.equal(intervals.length,1);assert.equal(intervals[0].start.toFormat('HH:mm'),'04:00');assert.equal(intervals[0].end.toFormat('HH:mm'),'05:00');
});
test('invalid interval control remains empty',()=>{
 const h=fixture();assert.equal(h.availability.attendeeWorkIntervalsBetween(h.entries()[0],DateTime.invalid('test'),DateTime.now()).length,0);
});
test('travel display authority unchanged control',()=>{
 const h=fixture();assert.equal(h.availability.attendeeTzForDay(h.entries()[0],'2026-11-03T19:00+02:00'),'America/New_York');
});
function override(entry,ov,authority='owner'){
 const rel='src/skills/meetings/ops/handlers/findAvailableSlots.ts',snap=process.env.MATCHMAKER_SNAPSHOT;
 const file=snap&&fs.existsSync(path.join(snap,rel))?path.join(snap,rel):rel;
 const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);let decl;
 function visit(n){if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText()==='attendeeHoursOverride'))decl=n;ts.forEachChild(n,visit);}visit(tree);
 const siblings=decl.parent.statements,code=decl.getText()+'\n'+siblings[siblings.indexOf(decl)+1].getText();
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{args:{attendee_hours:[ov]},attendeeAvailability:[entry],context:{authority,userId:'self'},isOwnerInitiatedSearch:authority==='owner',getPersonMemory:()=>({email:'self@example.test'}),logger:{info(){}}});return entry;
}
for(const [name,ov,want] of [
 ['earlier start',{start:'07:00'},[['07:00','18:00'],['20:30','22:30']]],
 ['later end',{end:'23:00'},[['08:00','18:00'],['20:30','23:00']]],
 ['start inside gap',{start:'19:00'},[['20:30','22:30']]],
 ['end inside gap',{end:'19:00'},[['08:00','18:00']]],
 ['complete explicit window',{start:'19:00',end:'20:00'},[['19:00','20:00']]],
])test(`one-search ${name} retains correct disjoint windows`,()=>{
 const e=fixture().entries()[0],original=JSON.stringify(e.week);override(e,{email:e.email,...ov});
 assert.equal(JSON.stringify(e.week.Tuesday.map(w=>[w.hoursStart,w.hoursEnd])),JSON.stringify(want));assert.equal(e.week.Saturday.length,0);
 assert.equal(JSON.stringify(fixture().entries()[0].week),original);
});
test('colleague cannot override another attendee control',()=>{
 const e=fixture().entries()[0],before=JSON.stringify(e.week);override(e,{email:e.email,start:'19:00',end:'20:00'},'colleague');assert.equal(JSON.stringify(e.week),before);
});
test('authenticated colleague can bound own explicit search',()=>{
 const e=fixture().entries()[0];e.email='self@example.test';override(e,{email:e.email,start:'19:00',end:'20:00'},'colleague');assert.equal(JSON.stringify(e.week.Tuesday),JSON.stringify([{hoursStart:'19:00',hoursEnd:'20:00'}]));
});
