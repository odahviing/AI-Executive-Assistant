const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const prefix = 'artifacts/workshop-verification/meeting-reschedule-20261014/handyman/a2';
let fixture = fs.readFileSync(path.join(__dirname, 'test-orchestrator-coda-workstate.cjs'), 'utf8').split("\ntest('regression:")[0];
const anchor = "const filename = relative === 'src/core/orchestrator/index.ts' && process.env.CODA_WORK_BEFORE_DIR\n      ? path.resolve(process.env.CODA_WORK_BEFORE_DIR, 'index.before.ts') : path.join(root, relative);";
fixture = fixture.replaceAll('\r\n', '\n');
assert.ok(fixture.includes(anchor));
fixture = fixture.replace(anchor, `const filename = ${before} && ['src/core/orchestrator/index.ts','src/core/orchestrator/turnHelpers.ts'].includes(relative) ? path.join(root, '${prefix}/before', relative) : path.join(root, relative);`);
const moduleFixture = { exports: {} };
new Function('require','module','__dirname', `${fixture}\nmodule.exports = {run};`)(require, moduleFixture, __dirname);
const { run } = moduleFixture.exports;
const targets = [
  { meeting_id: 'event-elinor', new_start: '2026-10-14T13:30:00+03:00', new_end: '2026-10-14T14:10:00+03:00' },
  { meeting_id: 'event-lori', new_start: '2026-10-14T14:15:00+03:00', new_end: '2026-10-14T14:55:00+03:00' },
];
const child = (i, more = {}) => ({ ...targets[i], success: true, meetingId: targets[i].meeting_id, booked_start: targets[i].new_start, booked_end: targets[i].new_end, ...more });
const pair = outcomes => ({ success: true, outcomes });
const step = (name,args,result) => ({name,args,result});
const move = result => step('move_meeting', { coordinated_moves: targets }, result);
const search = (ids = targets.map(t => t.meeting_id)) => step('find_available_slots', { moving_event_ids: ids }, { slots: targets.map(t => ({start:t.new_start,end:t.new_end})) });
function reader() {
  const filename = path.join(root, before ? `${prefix}/before/src/core/orchestrator/turnHelpers.ts` : 'src/core/orchestrator/turnHelpers.ts');
  const exports = {}, logger = { info(){},warn(){},error(){} };
  const deps = { luxon: { DateTime }, '../../llm/client': {getAnthropicClient:()=>({})}, '../../utils/usageLog':{logLlmUsage(){}}, '../../utils/logger':logger, '../../utils/attendeeAvailability':{ATTENDEE_REASON_PREFIXES:[]} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText, {exports, require:id=>{assert.ok(id in deps,id);return deps[id];},Date,Set,Map});
  return exports.mutationOutcome;
}
test('confirmed singular write retains desired-state success', () => { const r=reader()(child(0));assert.equal(r.ok,true);assert.equal(r.eventId,targets[0].meeting_id); });
for(const [label,flags] of [['unchanged',{unchanged:true}],['lost-response observed',{_calendar_verification:'desired_state_observed',_write_response_lost:true}],['replay observed',{_calendar_verification:'desired_state_observed'}]]) {
  test(`${label} confirms state without asserting a causal mutation`,()=>{const r=reader()(child(0,flags));assert.equal(r.ok,true);assert.equal(r.changed,false);});
}
test('unconfirmed verification cannot be rescued by event identity',()=>{const r=reader()({meetingId:'event-elinor',_calendar_verification:'unavailable'});assert.equal(r.ok,false);});
test('complete coordinated result confirms all children without fabricating aggregate ID',()=>{const r=reader()(pair([child(0),child(1)]));assert.equal(r.ok,true);assert.equal(r.eventId,undefined);});
test('partial aggregate retains causal child evidence without claiming full completion',()=>{const r=reader()({success:false,error:'coordinated_move_incomplete',outcomes:[child(0),child(1,{success:false,error:'unavailable'})]});assert.equal(r.ok,false);assert.equal(r.changed,true);});
test('empty or incomplete aggregate success cannot invent completion',()=>{for(const result of [pair([]),pair([child(0),child(1,{success:false})]),{...pair([child(0)]),remaining:[targets[1]]}])assert.equal(reader()(result).ok,false);});
test('explicit failure and unavailable result remain unconfirmed',()=>{for(const value of [null,{}, {success:false,error:'unavailable'}, {needs_confirmation:true}])assert.equal(reader()(value).ok,false);});
test('real loop emits each child ID and full actual interval for a complete pair',async()=>{const h=await run([move(pair([child(0),child(1)]))]);const records=h.result.mutationActions;assert.equal(records.length,2);for(let i=0;i<2;i++){assert.equal(records[i].eventId,targets[i].meeting_id);assert.equal(records[i].start,targets[i].new_start);assert.equal(records[i].end,targets[i].new_end);assert.equal(records[i].changed,true);assert.equal(records[i].operationComplete,true);}assert.equal(records[0].operationId,records[1].operationId);});
test('complete pair resolves each identified pending search',async()=>{const h=await run([search(),move(pair([child(0),child(1)]))]);assert.ok(h.result.socialCoda);});
test('partial pair retains failed child identity and does not close the pending plan',async()=>{const h=await run([search(),move({success:false,error:'coordinated_move_incomplete',outcomes:[child(0),child(1,{success:false,error:'move_did_not_land',_calendar_verification:'unavailable'})]})]);const records=h.result.mutationActions;assert.equal(records.length,2);assert.equal(records[0].ok,true);assert.equal(records[1].ok,false);assert.equal(records[1].eventId,targets[1].meeting_id);assert.ok(records.every(r=>r.operationComplete===false));assert.equal(h.result.bookingOccurred,false);assert.ok(!h.result.socialCoda);});
test('unattempted remaining step is distinct from confirmed and failed outcomes',async()=>{const h=await run([move({success:false,error:'coordinated_move_incomplete',outcomes:[child(0,{success:false,error:'unavailable'})],remaining:[targets[1]]})]);const records=h.result.mutationActions;assert.equal(records.length,2);assert.equal(records[1].reason,'not_attempted');assert.equal(records[1].ok,false);assert.equal(records[1].changed,false);});
test('retry only unfinished exact step resolves partial pending plan',async()=>{const h=await run([search(),move({success:false,error:'coordinated_move_incomplete',outcomes:[child(0),child(1,{success:false,error:'unavailable'})]}),step('move_meeting',targets[1],child(1))]);assert.ok(h.result.socialCoda);assert.equal(h.executions.length,3);});
test('complete observed pair resolves desired work without claiming writes',async()=>{const h=await run([search(),move(pair([child(0,{unchanged:true}),child(1,{_calendar_verification:'desired_state_observed'})]))]);assert.ok(h.result.socialCoda);assert.ok(h.result.mutationActions.every(r=>r.ok && r.changed===false && r.operationComplete===true));});
test('approval replay child results use same event accounting',async()=>{const h=await run([step('resolve_approval',{approval_id:'req-fixture',decision:'approve'},{ok:true,effect:'action replayed',outcomes:[child(0,{unchanged:true}),child(1)]})]);assert.equal(h.result.mutationActions.length,2);assert.equal(h.result.mutationActions[0].changed,false);assert.equal(h.result.mutationActions[1].changed,true);});
test('unrelated pending event survives another completed pair',async()=>{const h=await run([search(['event-third']),move(pair([child(0),child(1)]))]);assert.ok(!h.result.socialCoda);});
test('single original move retains normal completion',async()=>{const h=await run([step('move_meeting',targets[0],child(0))]);assert.equal(h.result.mutationActions.length,1);assert.equal(h.result.mutationActions[0].ok,true);assert.ok(h.result.socialCoda);});
test('owner room keeps outcome metadata without a private social coda',async()=>{const h=await run([move(pair([child(0),child(1)]))],{role:'owner',room:true});assert.equal(h.result.mutationActions.length,2);assert.ok(!h.result.socialCoda);});
test('fresh invocation reads observed pair without duplicating execution accounting',async()=>{const one=await run([move(pair([child(0),child(1)]))]);const next=await run([move(pair([child(0,{unchanged:true}),child(1,{unchanged:true})]))]);assert.equal(one.result.mutationActions.length,2);assert.equal(next.result.mutationActions.length,2);assert.ok(next.result.mutationActions.every(r=>r.changed===false));});
