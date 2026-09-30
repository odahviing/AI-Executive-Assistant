const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime, Settings } = require('luxon');
Settings.now = () => Date.parse('2026-09-30T12:00:00Z');
const { test } = require('node:test');
const before = process.argv.includes('--before');
const file = before ? 'artifacts/workshop-verification/owner-batch-20260930/matchmaker/meetings.before.ts' : 'src/skills/meetings.ts';
const source = ts.createSourceFile(file, fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
let branch;
function visit(n) { if(ts.isCaseClause(n) && n.expression.getText(source)==="'check_join_availability'") branch=n.statements[0].getText(source); ts.forEachChild(n,visit); }
visit(source);
assert.ok(branch);
const renderer = ts.transpileModule(fs.readFileSync('src/utils/timezoneConvert.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const rendererModule={exports:{}};
vm.runInNewContext(renderer,{module:rendererModule,exports:rendererModule.exports,require});
const zone='Asia/Jerusalem';
async function run(kind='free', args={}, surface='colleague') {
 const start='2026-10-01T17:45:00';
 const event={id:'busy',subject:'Busy',start:{dateTime:kind==='partial'?'2026-10-01T18:05:00':start,timeZone:zone},end:{dateTime:'2026-10-01T18:15:00',timeZone:zone}};
 const events=['busy','partial','allday','rearrange'].includes(kind)?[{...event,isAllDay:kind==='allday'}]:[];
 const check={passes:kind==='free'||kind==='rearrange',overCommitment:events.length?{subject:'Busy'}:undefined,violation_kind:'outside_working_hours',violation_label:'Outside hours'};
 const code=ts.transpileModule('module.exports=async function(args,context,profile)'+branch,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const module={exports:{}};
 const bindings={module,exports:module.exports,DateTime,renderClockInZone:rendererModule.exports.renderClockInZone,subjectViewerFor:()=>surface,viewerEmailFor:()=>null,displaySubject:()=> 'a meeting',PRIVATE_MASK:'[Private]',checkSlot:()=>check,occupancyRoleOf:()=> 'commitment',getOwnerEventsForDecision:async()=>{if(kind==='offline')throw Error('offline');return events;},require:(name)=>{if(name.includes('floatingBlocks'))return {getFloatingBlocks:()=>kind==='rearrange'?[{name:'lunch',preferred_start:'09:00',preferred_end:'19:00'}]:[],preserveFloatingSourceRanges:()=>[],blockAppliesOnDay:()=>true,windowMsForDay:(d,t,z)=>DateTime.fromISO(d+'T'+t,{zone:z}).toMillis(),isFloatingBlockEvent:()=>true,isMovableFloatingBlockEvent:()=>true,blockSizedToEvent:()=>({duration_minutes:30}),findBlockDestination:()=>({aligned:null})};if(name.includes('rebalanceFloatingBlocks'))return {logRebalanceMoveActivity:()=>{throw Error('unexpected write');}};if(name.includes('calendarIssues'))return {getSuppressedEventIds:()=>new Set()};throw Error('Unexpected '+name);}};
 vm.runInNewContext(code,bindings);
 return module.exports({meeting_start:start,duration_min:30,subject:'Sync',requester_name:'Paul',...args},{},{user:{timezone:zone,name:'Idan',email:'owner@example.com'},behavior:{calendar_health_mode:kind==='rearrange'?'active':'passive'}});
}
for(const kind of ['free','partial','busy','allday','rule'])test('normalized clock on '+kind,async()=>{const r=await run(kind,{present_in_timezone:'America/New_York'});assert.equal(r.meeting_start,'2026-10-01T17:45:00.000+03:00');assert.equal(r.meeting_timezone,zone);assert.equal(r.presentation_local,'Thu 1 Oct 10:45 EDT');});
for(const [kind,value] of [['free',true],['partial','partial'],['busy',false],['allday',false],['rule','needs_approval']])test('legitimate verdict '+kind,async()=>assert.equal((await run(kind)).can_join,value));
test('explicit offset remains fixed instant',async()=>assert.equal((await run('free',{meeting_start:'2026-10-01T10:45:00-04:00',present_in_timezone:'America/New_York'})).presentation_local,'Thu 1 Oct 10:45 EDT'));
test('default owner clock is labeled',async()=>assert.equal((await run()).presentation_local,'Thu 1 Oct 17:45 GMT+3'));
test('invalid presentation zone does not report availability',async()=>{const r=await run('free',{present_in_timezone:'Invalid/Zone'});assert.ok(r.error);assert.equal(r.can_join,undefined);});
test('invalid instant legitimate rejection',async()=>assert.ok((await run('free',{meeting_start:'invalid'})).error));
test('unavailable dependency never reports availability',async()=>assert.rejects(run('offline'),/offline/));
test('room has same deterministic public clock',async()=>assert.equal((await run('free',{present_in_timezone:'America/New_York'},'room')).presentation_local,'Thu 1 Oct 10:45 EDT'));
test('retry has stable clock without persisted state',async()=>assert.equal((await run()).meeting_start,(await run()).meeting_start));

test('active rearrangement refusal retains checked clock',async()=>{const r=await run('rearrange',{present_in_timezone:'America/New_York'});assert.equal(r.can_join,false);assert.equal(r.needs_owner_decision,true);assert.equal(r.presentation_local,'Thu 1 Oct 10:45 EDT');});
test('owner has same deterministic clock',async()=>assert.equal((await run('free',{present_in_timezone:'America/New_York'},'owner')).presentation_local,'Thu 1 Oct 10:45 EDT'));
