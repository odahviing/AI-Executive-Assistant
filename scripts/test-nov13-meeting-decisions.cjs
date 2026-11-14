const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planner } = require('./test-dina-owner-roster.cjs');
const { createMoveHarness } = require('./test-yael-meeting-selection.cjs');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), ts = require('typescript'), vm = require('node:vm');
const section = process.argv.includes('--section') ? process.argv[process.argv.indexOf('--section') + 1] : undefined;
function check(area, name, run) { if (!section || area === section) test(name, run); }
const external = 'guest@outside.test';
const unresolved = (emails, diag) => { diag.unresolved = emails.filter(e => e === external); return Object.fromEntries(emails.map(e => [e, []])); };
function move(options = {}, args = {}, fixture = {}) {
  const p = planner(options);
  return createMoveHarness({ owner: true, respectRelaxed: true, plan: p.plan, ...fixture,
    args: { new_start:p.input.slotStartIso, new_end:p.input.slotEndIso, ...args } });
}
check('authority','conditional busy has no write even with relaxed',async () => {
  for (const relaxed of [false,true]) {
    const h = move({peerBusy:true},{require_attendee_availability:true,relaxed});
    assert.equal((await h.run()).success,false); assert.equal(h.state.writes.length,0);
  }
});
check('authority','conditional unknown has no write',async () => {
  const h = move({freebusy:()=>{throw Error('provider unavailable');}},{require_attendee_availability:true});
  assert.equal((await h.run()).success,false); assert.equal(h.state.writes.length,0);
});
check('authority','free conditional move succeeds',async () => {
  const h=move({},{require_attendee_availability:true}); assert.equal((await h.run()).success,true); assert.equal(h.state.writes.length,1);
});
check('authority','ordinary move and scoped explicit yes retain distinct outcomes',async () => {
  for (const relaxed of [false,true]) {
    const h=move({peerBusy:true},{relaxed}); const r=await h.run(); assert.equal(r.success,true);
    assert.equal(r.attendee_conflict_disposition, relaxed?'accepted_override':'move_notice');
  }
});

const subject='Yael & Idan - Weekly';
function lunch(options = {}, span = ['12:00','12:25']) {
  const date='2026-10-13', zone='Asia/Jerusalem', at=t=>date+'T'+t+':00+03:00';
  return createMoveHarness({owner:true,roster:[],block:{name:'lunch',duration_minutes:25,preferred_start:'11:30',preferred_end:'13:30'},
    args:{new_start:at('12:15'),new_end:at('12:55')},events:[{id:'oct11',type:'singleInstance',subject,attendees:[],
      start:{dateTime:at(span[0]),timeZone:zone},end:{dateTime:at(span[1]),timeZone:zone}}],...options});
}
check('floating','explicit resize writes and returns forty minutes once',async () => {
  const h=lunch({mutable:true}); const r=await h.run(); assert.equal(r.success,true);
  const minutes=(s,e)=>(Date.parse(e)-Date.parse(s))/60000;
  assert.equal(minutes(h.events[0].start.dateTime,h.events[0].end.dateTime),40);
  assert.equal(minutes(r.booked_start,r.booked_end),40); assert.equal(h.state.activities.length,1);
  const again=await h.run(); assert.equal(again.unchanged,true); assert.equal(h.state.writes.length,1);
});
check('floating','floating readback unknown or drift does not announce success or repeat',async () => {
  for(const flag of ['readbackUnavailable','endDrift','patchFailure']){
    const h=lunch({[flag]:true}); const r=await h.run(); assert.equal(r.success,false);
    assert.equal(h.state.closed.length,0); assert.ok(h.state.writes.length<=1);
  }
});
check('floating','response lost after floating write reconciled once',async () => {
  const h=lunch({patchAcceptedResponseLost:true});const r=await h.run();assert.equal(r.success,true);assert.equal(h.state.writes.length,1);assert.equal(h.state.closed.length,1);
});
check('floating','omitted end preserves existing twenty-five minutes',async () => {
  const h=lunch(); const r=await h.run({new_end:undefined}); assert.equal(r.success,true);
  assert.equal((Date.parse(r.booked_end)-Date.parse(r.booked_start))/60000,25);
});

function warnings(unresolvedAttendees, attendeesNotChecked=[]) {
  const file='src/skills/meetings/ops/handlers/findAvailableSlots.ts';
  const rev=process.argv.indexOf('--revision');
  const source=rev<0?fs.readFileSync(path.join(__dirname,'..',file),'utf8'):cp.execFileSync('git',['show',process.argv[rev+1]+':'+file],{encoding:'utf8'});
  const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const def=parsed.statements.find(n=>n.name?.text==='attendeeCheckWarnings');
  const code=ts.transpileModule(def.getText()+'\nmodule.exports=attendeeCheckWarnings',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};vm.runInNewContext(code,{module,logger:{warn(){}},enrichUnresolvedInternal:emails=>emails});return module.exports({userEmail:'owner@example.test',ownerFirstName:'Owner',unresolvedAttendees,attendeesNotChecked,logSuffix:''});
}
check('coverage','external provider refusal is named in search',()=> {
  const r=warnings([external]);assert.deepEqual(Array.from(r.attendeeNotCheckedWarning?.attendees_not_checked??[]),[external]);assert.equal(r.attendeeEmailWarning,undefined);
});
check('coverage','external provider refusal travels with booked outcome',async()=>{
  const h=planner({freebusy:unresolved});h.input.participants.push({email:external}); const r=await h.plan();
  assert.equal(r.action,'book');assert.equal(r.availabilityUnconfirmed,true);assert.match(r.overrideNotice,/guest/);
});
check('coverage','external busy stays distinct from an unread calendar',async()=>{
  const h=planner({freebusy:emails=>Object.fromEntries(emails.map(e=>[e,e===external?[{start:'2026-10-13T11:00:00+03:00',end:'2026-10-13T11:40:00+03:00',status:'busy'}]:[]]))});
  h.input.participants.push({email:external});const r=await h.plan();assert.equal(r.availabilityUnconfirmed,false);assert.match(r.overrideNotice,/guest/);
});
check('coverage','known internal bad mailbox keeps its own warning',()=> {
  const r=warnings(['missing@example.test']);assert.ok(r.attendeeEmailWarning);assert.equal(r.attendeeNotCheckedWarning,undefined);
});
check('coverage','checked free attendee produces no warning',async()=>{
  const h=planner();const r=await h.plan();assert.equal(r.availabilityUnconfirmed,false);assert.equal(r.overrideNotice,undefined);
});

// Execute the real create-to-planner adapter expression. The only substituted
// inputs are the already normalized booking request and runtime SkillContext.
function createAdapter() {
  const file='src/skills/meetings/ops/handlers/createMeeting.ts', rev=process.argv.indexOf('--revision');
  const source=rev<0?fs.readFileSync(path.join(__dirname,'..',file),'utf8'):cp.execFileSync('git',['show',process.argv[rev+1]+':'+file],{encoding:'utf8'});
  const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true), matches=[];
  function visit(n) {
    if (ts.isCallExpression(n)&&n.expression.getText(parsed)==='planInputFromBookingRequest') matches.push(n.getText(parsed));
    ts.forEachChild(n,visit);
  }
  visit(parsed); assert.equal(matches.length,1);
  return new Function('planInputFromBookingRequest','bookingRequest','context','return '+matches[0]);
}
const buildCreateInput=createAdapter();
const title='Customer success with Ayalla', people=['elinor@example.test','ayalla@example.test'];
const scope={subject:title,attendeeEmails:[...people].reverse()};
async function fresh(options={}) {
  const h=planner({peerBusy:options.busy!==false,ownerConflict:options.ownerRule});
  const context={authority:'owner',senderRole:'owner',interactive:true,surface:'owner_dm',profile:h.input.profile,
    ordinaryCreateAfterOtherMeeting:scope,...options.context};
  const req={intent:'new_booking',initiator:context.senderRole,participants:(options.people??people).map(email=>({email})),
    subject:options.title??title,slotStartIso:h.input.slotStartIso,slotEndIso:h.input.slotEndIso,
    context:{surface:context.surface,channel:'slack'},relaxed:options.relaxed!==false};
  const result=await h.plan(buildCreateInput(h.adapt,req,context));
  return {result,rules:h.state.rules};
}
check('fresh','new titled second meeting with changed roster refuses forged relaxed',async()=>{
  const {result}=await fresh();assert.equal(result.action,'confirm_override');assert.match(result.attendeeBusyLabel,/elinor/);assert.match(result.attendeeBusyLabel,/ayalla/);
});
check('fresh','scope cannot grant an exception when model requested no override',async()=>{
  const {result}=await fresh({relaxed:false});assert.equal(result.action,'confirm_override');
});
check('fresh','same-action yes and explicit current wider waiver retain ordinary authority',async()=>{
  const {result}=await fresh({context:{ordinaryCreateAfterOtherMeeting:undefined}});assert.equal(result.action,'book');assert.equal(result.attendeeConflictDisposition,'accepted_override');
});
check('fresh','an inexact title or roster does not apply a different action receipt',async()=>{
  for(const options of [{title:'Another meeting'},{people:[people[0]]},{people:[...people,'extra@example.test']}])assert.equal((await fresh(options)).result.action,'book');
});
check('fresh','approved replay retains decided action and naked room input cannot grant',async()=>{
  const replay=await fresh({context:{interactive:false,approvedBookingAttendeeEmails:people}});assert.equal(replay.result.action,'book');
  const room=await fresh({context:{senderRole:'colleague',surface:'room'},relaxed:false});assert.equal(room.result.attendeeConflictDisposition,undefined);
});
check('fresh','clear attendees do not prevent an independent owner-day override',async()=>{
  const {result,rules}=await fresh({busy:false,ownerRule:true});assert.equal(result.action,'book');assert.equal(rules[0].allowRelaxed,true);assert.match(result.overrideNotice,/double-books/);
});

async function readProvider(emails, diag, uppercase=true) {
  const file='src/connectors/graph/calendarReads.ts', rev=process.argv.indexOf('--revision');
  const source=rev<0?fs.readFileSync(path.join(__dirname,'..',file),'utf8'):cp.execFileSync('git',['show',process.argv[rev+1]+':'+file],{encoding:'utf8'});
  const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const code=parsed.statements.filter(n=>['getFreeBusyImpl','parseGraphFreeBusySlot'].includes(n.name?.text)).map(n=>n.getText(parsed)).join('\n');
  const api={async post(){return {value:emails.map(email=>({scheduleId:uppercase?email.toUpperCase():email,scheduleItems:[{start:{dateTime:'2026-10-13T08:00:00Z'},end:{dateTime:'2026-10-13T08:40:00Z'},status:'busy'}]}))};}};
  const mod={exports:{}};vm.runInNewContext(ts.transpileModule(code+'\nmodule.exports=getFreeBusyImpl',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:mod,exports:mod.exports,getClient:()=>({api:()=>api}),DateTime:require('luxon').DateTime});
  const r=await mod.exports('owner@example.test',emails,'2026-10-13T08:00Z','2026-10-13T08:40Z','UTC',40);Object.assign(diag,{unresolved:r.unresolved,notChecked:r.notChecked});return r.result;
}
for (const owner of [true,false]) {
  const role=owner?'owner':'colleague';
  check('authority',role+' conditional shared-room busy or unknown destination stays private',async()=>{
    for(const unknown of [false,true]) {
      const h=move({freebusy:unknown?()=>{throw Error('unavailable')}:readProvider},{require_attendee_availability:true,confirm_attendee_conflict:true},{owner,room:true,sameSeries:true});
      h.ctx.context.senderRole='colleague';h.ctx.context.authority=role;h.ctx.context.surface='room';
      const r=await h.run();assert.equal(r.success,false);assert.equal(h.state.writes.length,0);
      assert.doesNotMatch(JSON.stringify(r),/yael@example\.test|yael is busy/i);
    }
  });
  check('authority',role+' conditional shared room can move an available event',async()=>{
    const h=move({},{require_attendee_availability:true},{owner,room:true,sameSeries:true});
    h.ctx.context.senderRole='colleague';h.ctx.context.authority=role;h.ctx.context.surface='room';
    assert.equal((await h.run()).success,true);assert.equal(h.state.writes.length,1);
  });
}
check('authority','colleague conditional beats a simultaneous busy confirmation',async()=>{
  const h=move({},{require_attendee_availability:true,confirm_attendee_conflict:true},{owner:false,sameSeries:true,attendeeBusy:true});
  assert.equal((await h.run()).success,false);assert.equal(h.state.writes.length,0);
});
check('authority','conditional owner DM mixed case provider busy prevents write',async()=>{
  const h=move({freebusy:readProvider},{require_attendee_availability:true});assert.equal((await h.run()).success,false);assert.equal(h.state.writes.length,0);
});
check('coverage','provider mixed-case external busy read reaches create verdict',async()=>{
  const h=planner({freebusy:readProvider});h.input.intent='new_booking';h.input.participants=[{email:external}];
  const r=await h.plan();assert.equal(r.action,'confirm_override');assert.match(r.attendeeBusyLabel,/guest/);
});
check('coverage','provider canonical case preserves external conflict',async()=>{
  const h=planner({freebusy:(emails,diag)=>readProvider(emails,diag,false)});h.input.intent='new_booking';h.input.participants=[{email:external}];
  assert.equal((await h.plan()).action,'confirm_override');
});
check('fresh','scoped fresh create sees mixed case busy provider response',async()=>{
  const h=planner({freebusy:readProvider});h.input.intent='new_booking';h.input.allowRelaxed=true;
  h.input.ordinaryCreateAfterOtherMeeting={subject:h.input.subject,attendeeEmails:['yael@example.test']};
  assert.equal((await h.plan()).action,'confirm_override');
});
check('floating','start-only with incomplete probe uses identified forty-minute day row',async()=>{
  const h=lunch({liveStart:'invalid'},['12:00','12:40']);const r=await h.run({new_end:undefined});assert.equal(r.success,true);assert.equal((Date.parse(r.booked_end)-Date.parse(r.booked_start))/60000,40);
});
check('floating','start-only with no readable original interval withholds write',async()=>{
  const h=lunch({liveStart:'invalid'},['bad','bad']);const r=await h.run({new_end:undefined});assert.equal(r.success,false);assert.equal(h.state.writes.length,0);
});
