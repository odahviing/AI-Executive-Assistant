// Real finder diagnostics and AST-selected production refusal branches. External
// I/O is supplied by the existing timezone harness; no calendar writer is called.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {DateTime}=require('luxon');
const {harness}=require('./test-timezone-owner-interval.cjs');
const root=path.resolve(__dirname,'..');
const read=rel=>{const before=process.env.SLOT_PRIORITY_BEFORE&&path.join(root,process.env.SLOT_PRIORITY_BEFORE,rel);return fs.readFileSync(before&&fs.existsSync(before)?before:path.join(root,rel),'utf8');};
function branch(kind){
 const rel=`src/skills/meetings/ops/handlers/${kind}Meeting.ts`,sf=ts.createSourceFile(rel,read(rel),ts.ScriptTarget.Latest,true),hits=[];
 const anchor=kind==='create'?'create_meeting colleague-path refused — slot breaks owner rules':'move_meeting colleague-path refused — new slot blocked';
 (function visit(n){if(ts.isIfStatement(n)&&n.expression.getText()==='!matched'&&n.getText().includes(anchor))hits.push(n);ts.forEachChild(n,visit);})(sf);
 assert.equal(hits.length,1,'unambiguous actual refusal branch');return hits[0].getText();
}
const start='2026-09-14T12:00:00+03:00',end='2026-09-14T12:25:00+03:00';
async function run(kind,{off=true,remote=false,remoteThrows=false,ordinary=false,matched=false}={}){
 const h=harness(off?{'2026-09-14':{isWorkday:false,note:'PRIVATE absence'}}:{},{extraMocks:{'src/utils/attendeeAvailability.ts':{ATTENDEE_REASON_PREFIXES:[],attendeeTzForDay:e=>e.timezone}}}),diagnostics={};
 const finder=h.load('src/connectors/graph/findAvailableSlots.ts');
 const slots=await h.find(start,end,{diagnosticsOut:diagnostics});
 if(off){assert.equal(slots.length,0);assert.ok(diagnostics.daySummary[0].top_reasons.includes('vacation_or_off_day'));}
 if(remote||ordinary)Object.assign(diagnostics,{rejectedCounts:{[remote?'wrong_day_type':'outside_working_hours']:1},daySummary:[]});
 let writes=0;
 const bindings={matched,diagnostics,context:{profile:h.profile,userId:'UCOLLEAGUE'},ownerFirst:'Owner',askerName:'Requester',
  args:{start,end,meeting_id:'Leadership',meeting_subject:'Existing meeting'},newStart:start,newEnd:end,
  firstRejectReason:finder.firstRejectReason,oofUntilDisplayFor:finder.oofUntilDisplayFor,
  humanizeViolationLabel:h.load('src/skills/meetings/ops/violationLabels.ts').humanizeViolationLabel,
  startDt:DateTime.fromISO(start),fromIso:start,toIso:end,startMs:Date.parse(start),DateTime,
  inPersonRequested:remote,CalendarOfflineError:class extends Error{},logger:{info(){},warn(){}},
  HANDLER_ERROR_CODE:{NOT_RULE_COMPLIANT:'not_rule_compliant'},
  runSlotCheck:async(_,mode,out)=>{if(remoteThrows)throw Error('fixture remote failure');return h.find(start,end,{diagnosticsOut:out});},
  write:()=>{writes++;return {success:true};}};
 const js=ts.transpileModule(`module.exports=async()=>{${branch(kind)};return write();}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod={exports:{}};vm.runInNewContext(js,{...bindings,module:mod});const out=await mod.exports();
 return {out,writes};
}
for(const kind of ['create','move']){
 test(`regression ${kind} actual off-day refusal retains authoritative reason and never writes`,async()=>{
  const x=await run(kind);assert.equal(x.writes,0);assert.equal(x.out.broken_rule,'vacation_or_off_day');assert.notEqual(x.out.broken_rule_label,'unknown');assert.doesNotMatch(JSON.stringify(x.out),/PRIVATE absence/);
 });
 test(`control ${kind} ordinary count keeps priority over absence fallback and refuses without write`,async()=>{
  const x=await run(kind,{ordinary:true});assert.equal(x.writes,0);assert.equal(x.out.broken_rule,'outside_working_hours');
 });
 test(`control ${kind} matched legitimate slot bypasses refusal`,async()=>{
  const x=await run(kind,{off:false,matched:true});assert.equal(x.writes,1);assert.equal(x.out.success,true);
 });
}
test('regression create remote retry uses its own authoritative off-day diagnostic without writing',async()=>{
 // Initial in-person rejection followed by a dated override observed on the
 // independent existing remote recheck. No cached initial reason substitutes it.
 const x=await run('create',{remote:true});assert.equal(x.writes,0);assert.equal(x.out.broken_rule,'wrong_day_type');assert.equal(x.out.remote_same_time.bookable,false);assert.equal(x.out.remote_same_time.broken_rule,'vacation_or_off_day');
});
test('control create remote clean result retains bookable option but does not book',async()=>{
 const x=await run('create',{off:false,remote:true});assert.equal(x.writes,0);assert.equal(x.out.remote_same_time.bookable,true);
});
test('control create remote unavailable retry retains original refusal and never writes',async()=>{
 const x=await run('create',{remote:true,remoteThrows:true});assert.equal(x.writes,0);assert.equal(x.out.broken_rule,'wrong_day_type');assert.equal(x.out.remote_same_time,undefined);
});
test('regression create transient retry discards stale off-day diagnostics before retry',async()=>{
 const rel='src/skills/meetings/ops/handlers/createMeeting.ts',sf=ts.createSourceFile(rel,read(rel),ts.ScriptTarget.Latest,true),hits=[];
 (function visit(n){if(ts.isTryStatement(n)&&n.catchClause?.getText().includes('delete diagnostics.conflictingEvent'))hits.push(n);ts.forEachChild(n,visit);})(sf);
 assert.equal(hits.length,1);let calls=0;const diagnostics={},mod={exports:{}};
 const body=`module.exports=async()=>{let validSlots;${hits[0].getText()};return validSlots;}`;
 vm.runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{module:mod,diagnostics,fromIso:start,toIso:end,requestedMode:undefined,CalendarOfflineError:class extends Error{},logger:{warn(){}},runSlotCheck:async()=>{
  if(++calls===1){diagnostics.daySummary=[{accepted:0,top_reasons:['vacation_or_off_day']}];throw Error('transient');}
  assert.equal(diagnostics.daySummary,undefined);return [{start,end}];
 }});
 assert.equal((await mod.exports()).length,1);assert.equal(calls,2);
});
