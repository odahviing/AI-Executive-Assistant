// Actual stored-hours availability loader, full finder and recipient deadline modules.
// Store API is an honest fixture matching Librarian's tested effective-hours contract.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DateTime}=require('luxon'),{harness}=require('./test-timezone-owner-decisions.cjs');
const days=['Monday','Tuesday','Wednesday','Thursday','Friday'];
const overrides={Monday:{hoursStart:'08:00',hoursEnd:'14:00'},Tuesday:{hoursStart:'10:00',hoursEnd:'16:00'}};
const fixture=(extra={})=>harness({ownerZone:'UTC',person:{timezone:'UTC'},travel:null,hours:{workdays:days,hoursStart:'09:00',hoursEnd:'18:00',dayOverrides:overrides},...extra});
for(const c of [
 ['Monday new opening','2026-09-14T08:00Z','2026-09-14T08:25Z',1],
 ['Monday new closure','2026-09-14T14:00Z','2026-09-14T14:25Z',0],
 ['Tuesday later opening','2026-09-15T09:00Z','2026-09-15T09:25Z',0],
 ['Tuesday open control','2026-09-15T10:00Z','2026-09-15T10:25Z',1],
 ['Tuesday later closure','2026-09-15T16:00Z','2026-09-15T16:25Z',0],
 ['unspecified Wednesday default','2026-09-16T09:00Z','2026-09-16T09:25Z',1],
 ['default Wednesday closed control','2026-09-16T08:00Z','2026-09-16T08:25Z',0],
 ['weekend unchanged control','2026-09-19T10:00Z','2026-09-19T10:25Z',0],
 ['whole slot must fit closing','2026-09-14T13:45Z','2026-09-14T14:10Z',0],
])test(c[0],async()=>assert.equal((await fixture().find(c[1],c[2])).length,c[3]));
test('loader preserves weekday overrides',()=>assert.equal(fixture().entries()[0].dayOverrides.Monday.hoursStart,'08:00'));
test('explicit weekend workday accepted',async()=>{const h=fixture({hours:{workdays:[...days,'Sunday'],hoursStart:'09:00',hoursEnd:'18:00',dayOverrides:{Sunday:{hoursStart:'07:00',hoursEnd:'08:00'}}}});assert.equal((await h.find('2026-09-20T07:00Z','2026-09-20T07:25Z')).length,1);});
test('travel uses destination weekday and Monday window',async()=>{const h=fixture({person:{timezone:'Asia/Jerusalem'},travel:{from:'2026-09-14',until:'2026-09-14',location:'America/New_York'}});assert.equal((await h.find('2026-09-14T15:00:00+03:00','2026-09-14T15:25:00+03:00')).length,1);assert.equal((await h.find('2026-09-14T21:00:00+03:00','2026-09-14T21:25:00+03:00')).length,0);});
test('fixed hours zone keeps its weekday during travel',async()=>{const h=fixture({person:{timezone:'America/New_York'},travel:{from:'2026-09-14',until:'2026-09-14',location:'Asia/Tokyo'},hours:{workdays:days,hoursStart:'09:00',hoursEnd:'18:00',timezone:'UTC',dayOverrides:overrides}});assert.equal((await h.find('2026-09-14T08:00Z','2026-09-14T08:25Z')).length,1);});
for(const offset of ['-04:00','-05:00'])test('DST repeated Sunday override '+offset,async()=>{const h=fixture({person:{timezone:'America/New_York'},hours:{workdays:['Sunday'],hoursStart:'09:00',hoursEnd:'17:00',dayOverrides:{Sunday:{hoursStart:'01:30',hoursEnd:'01:45'}}}});const a='2026-11-01T01:30:00'+offset,b='2026-11-01T01:45:00'+offset;assert.equal((await h.find(a,b)).length,1);assert.equal(h.load('src/utils/responseDeadline.ts').colleagueWorkTimeBaseFromNow('UTC',Date.parse(a),{slackId:'p1',ownerTimezone:'UTC'}),DateTime.fromISO(a).toUTC().toISO());});
test('DST nonexistent weekday window not shifted',async()=>{const h=fixture({person:{timezone:'America/New_York'},hours:{workdays:['Sunday'],hoursStart:'09:00',hoursEnd:'17:00',dayOverrides:{Sunday:{hoursStart:'02:10',hoursEnd:'02:45'}}}});assert.equal(h.availability.attendeeWorkIntervalsBetween(h.entries()[0],DateTime.fromISO('2027-03-14T00:00:00-05:00'),DateTime.fromISO('2027-03-15T00:00:00-04:00')).length,0);});
test('recipient contact floor uses later Tuesday opening',()=>{const h=fixture();assert.equal(h.load('src/utils/responseDeadline.ts').colleagueWorkTimeBaseFromNow('UTC',Date.parse('2026-09-15T08:00Z'),{slackId:'p1',ownerTimezone:'UTC'}),'2026-09-15T10:00:00.000Z');});
test('24 business hour response deadline counts weekday durations',()=>{const h=fixture({hours:{workdays:days,hoursStart:'09:00',hoursEnd:'18:00',dayOverrides:{...overrides,Friday:{hoursStart:'12:00',hoursEnd:'13:00'}}}});assert.equal(h.load('src/utils/responseDeadline.ts').calcResponseDeadline('UTC',{slackId:'p1',ownerTimezone:'UTC'}),'2026-09-17T11:00:00.000Z');});
test('retry stable without persisted scheduling state',()=>{const h=fixture(),entry=h.entries()[0],a=DateTime.fromISO('2026-09-14T07:00Z'),b=DateTime.fromISO('2026-09-14T15:00Z');const intervals=()=>h.availability.attendeeWorkIntervalsBetween(entry,a,b).map(x=>x.start.toISO()+'/'+x.end.toISO()).join();assert.equal(intervals(),intervals());});
// The existing one-search attendee_hours bound must win over stored weekday bounds.
function override(entry,ov){
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
 const rel='src/skills/meetings/ops/handlers/findAvailableSlots.ts',snap=process.env.MATCHMAKER_SNAPSHOT;
 const file=snap&&fs.existsSync(path.join(snap,rel))?path.join(snap,rel):rel;
 const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);let decl;
 function visit(n){if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText()==='attendeeHoursOverride'))decl=n;ts.forEachChild(n,visit);}visit(tree);assert.ok(decl);
 const siblings=decl.parent.statements,code=decl.getText()+'\n'+siblings[siblings.indexOf(decl)+1].getText();
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{args:{attendee_hours:[ov]},attendeeAvailability:[entry],logger:{info(){}}});return entry;
}
test('one-search start override preserves weekday-specific end',()=>{const e=fixture().entries()[0];override(e,{email:e.email,start:'07:00'});assert.equal(e.dayOverrides.Monday.hoursStart,'07:00');assert.equal(e.dayOverrides.Monday.hoursEnd,'14:00');});
test('one-search end override preserves weekday-specific start',()=>{const e=fixture().entries()[0];override(e,{email:e.email,end:'19:00'});assert.equal(e.dayOverrides.Tuesday.hoursEnd,'19:00');assert.equal(e.dayOverrides.Tuesday.hoursStart,'10:00');});
test('one-search unknown person leaves existing window alone',()=>{const e=fixture().entries()[0];override(e,{email:'other@example.test',start:'07:00'});assert.equal(e.hoursStart,'09:00');});
