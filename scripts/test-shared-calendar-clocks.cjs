// Real colleague-read branch and timezone renderer, isolated calendar and identity data.
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),{test}=require('node:test'),{DateTime}=require('luxon');
const file='src/skills/meetings/ops/handlers/calendarReads.ts';
const source=fs.readFileSync(process.env.SHARED_CALENDAR_BEFORE??file,'utf8');
const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
const hits=[];function visit(n){if(ts.isIfStatement(n)&&n.expression.getText(tree)==='isSharedSurface')hits.push(n);ts.forEachChild(n,visit);}visit(tree);
assert.equal(hits.length,1);
const code=ts.transpileModule('async function run(){'+hits[0].getText(tree)+'}\nexports.run=run;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const clocks={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/utils/timezoneConvert.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:clocks.exports,require:n=>{assert.equal(n,'luxon');return {DateTime}}});
async function run(person={email:'reader@example.test',timezone:'Asia/Jerusalem'}, travelZone){
 const rawEvents=[{id:'shared',subject:'Weekly',attendees:[{emailAddress:{address:'reader@example.test'}}],_localDate:'2026-11-12',_localStartTime:'04:30'},
 {id:'private',subject:'PRIVATE SECRET',attendees:[],_localDate:'2026-11-12',_localStartTime:'07:00'},
 {id:'all-day',subject:'Shared holiday',isAllDay:true,attendees:[{emailAddress:{address:'reader@example.test'}}]}];
 const exports={},context={userId:'U_READER',profile:{user:{name:'Owner'}}};
 vm.runInNewContext(code,{exports,DateTime,isSharedSurface:true,context,rawEvents,userEmail:'owner@example.test',timezone:'America/New_York',
  getPersonMemory:()=>person,processCalendarEvents:events=>events.map(e=>({...e})),
  require:n=>{if(n.endsWith('/timezoneConvert'))return clocks.exports;if(n.endsWith('/attendeeAvailability'))return {loadAttendeeAvailabilityForPerson:p=>p,attendeeTzForDay:p=>travelZone??p.timezone??'America/New_York'};throw Error(n);}});
 return exports.run();
}
test('shared event shows its actual requester-local clock while private events stay absent',async()=>{
 const r=await run();assert.equal(r._colleague_view,true);assert.equal(r.events.length,2);
 assert.equal(r.events[0].presentation_local,'Thu 12 Nov 11:30 GMT+2');assert.ok(!JSON.stringify(r).includes('PRIVATE SECRET'));
 assert.equal(r.events[1].presentation_local,undefined);
});
test('dated requester travel controls the displayed clock',async()=>{const r=await run(undefined,'Europe/London');assert.equal(r.events[0].presentation_local,'Thu 12 Nov 09:30 GMT');});
test('unknown requester has no shared events or private clocks',async()=>{const r=await run(null);assert.deepEqual(Array.from(r.events),[]);});
