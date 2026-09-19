// Actual production modules with isolated Graph/DB/notification fixtures; no live writes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const luxon = require('luxon');
const { DateTime, Settings } = luxon;
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'artifacts/workshop-verification/core-review-20260919/matchmaker-floating');
const before = process.argv.includes('--before');
const outputArg = process.argv.indexOf('--output-dir');
const outputDir = outputArg >= 0 ? path.resolve(process.argv[outputArg + 1]) : path.join(dir, 'current');
const results = [];
Settings.now = () => Date.parse('2026-09-19T10:00:00Z');
function source(file) { const old = path.join(dir, 'before', file); return fs.readFileSync(before && fs.existsSync(old) ? old : path.join(root, file), 'utf8'); }
function compile(code, req) {
  const m = { exports: {} };
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`)(req, m, m.exports);
  return m.exports;
}
const logger = { info() {}, warn() {}, error() {} };
const density = compile(source('src/utils/calendarDensity.ts'), n => { if (n === 'luxon') return luxon; throw Error(n); });
const floating = compile(source('src/utils/floatingBlocks.ts'), n => {
  if (n === 'luxon') return luxon;
  if (n === './logger') return { __esModule: true, default: logger };
  if (n === './calendarDensity') return density;
  throw Error(n);
});
const zone = 'Asia/Jerusalem', date = '2026-10-04';
const block = (name, start = '11:00', end = '14:00', duration = 30) => ({ name, preferred_start: start, preferred_end: end, duration_minutes: duration, can_skip: false });
const event = (name, start, end) => ({ id: name, subject: name, start: { dateTime: `${date}T${start}:00`, timeZone: zone }, end: { dateTime: `${date}T${end}:00`, timeZone: zone }, categories: [], showAs: 'busy', attendees: [], isCancelled: false, isAllDay: false });
const profile = blocks => ({ user: { email: 'owner@test.invalid', timezone: zone, slack_user_id: 'owner' }, meetings: { floating_blocks: blocks }, schedule: { office_days: { days: ['Sunday'] }, home_days: { days: [] } } });
function rebalanceHarness(opts = {}) {
  const writes = [], activities = [], shadows = [];
  const mod = compile(source('src/utils/rebalanceFloatingBlocks.ts'), n => {
    if (n === 'luxon') return luxon;
    if (n === '../db/calendarIssues') return {getSuppressedEventIds:()=>new Set(opts.suppressed ?? [])};
    if (n === './floatingBlocks') return floating;
    if (n === './calendarDensity') return density;
    if (n === './workHours') return { getEffectiveWorkDay: () => ({ hasOverride: !!opts.override }) };
    if (n === './logger') return { __esModule: true, default: logger };
    if (n === '../core/requests/logActivity') return { logActivity: row => activities.push(row) };
    if (n === './shadowNotify') return { shadowNotify: async (...args) => { shadows.push(args); if (opts.shadowError) throw Error('notification unavailable'); } };
    if (n === '../connectors/graph/calendar') return { getCalendarEvents: async () => { throw Error('unavailable calendar'); }, updateMeeting: async a => { writes.push(a); if (opts.failId === a.meetingId) throw Error('write rejected'); } };
    throw Error(`Unexpected dependency ${n}`);
  });
  return { ...mod, writes, activities, shadows };
}
const overlap = (a, b) => DateTime.fromISO(a.start).toMillis() < DateTime.fromISO(b.end).toMillis() && DateTime.fromISO(b.start).toMillis() < DateTime.fromISO(a.end).toMillis();
const run = (h, blocks, events, extra = {}) => h.rebalanceFloatingBlocksAfterMutation({ profile: profile(blocks), affectedSlotIso: `${date}T12:00:00+03:00`, ownerSlackId: 'owner', preloadedDayEvents: events, ...extra });
const dry = (h, blocks, events) => h.dryRunFloatingBlockRelocation({ profile: profile(blocks), candidateStartIso: `${date}T12:00:00+03:00`, candidateEndIso: `${date}T13:30:00+03:00`, preloadedDayEvents: events });
async function test(id, fn) { try { await fn(); results.push({ id, status: 'pass' }); } catch (e) { results.push({ id, status: 'fail', error: e.message }); } }
// Reuse the established full-handler fixture, not copied production branches.
// Redirect only the two preserved source files for the before run.
const baseHarness = fs.readFileSync(path.join(root, 'scripts/test-calendar-health-audit.cjs'), 'utf8').split('async function test(id, fn)')[0].replace("return { ok: true, created: true, start: '12:00', end: '12:30' };", "return Object.hasOwn(opts, 'bookResult') ? opts.bookResult : { ok: true, created: true, start: '12:00', end: '12:30' };");
const fixtureFs = { ...fs, readFileSync(file, ...args) { const rel = path.relative(root, file); const old = path.join(dir, 'before', rel); return fs.readFileSync(before && fs.existsSync(old) ? old : file, ...args); } };
const healthModule = { exports: {} };
vm.runInThisContext(`(function(require,module,exports,__dirname){${baseHarness}\nmodule.exports={harness,event};})`)(n => n === 'node:fs' ? fixtureFs : require(n), healthModule, healthModule.exports, __dirname);
const health = healthModule.exports;
(async () => {
  for (const count of [1, 2, 3]) {
    const names = ['lunch', 'coffee', 'focus'].slice(0, count);
    await test(`rebalance-${count}-objects-distinct-destinations`, async () => {
      const h = rebalanceHarness(), blocks = names.map(n => block(n));
      const events = names.map((n, i) => event(n, `12:${i * 30 === 0 ? '00' : '30'}`, i === 0 ? '12:30' : '13:00'));
      if (count === 3) events[2] = event('focus', '13:00', '13:30');
      const snapshot = JSON.stringify(events);
      const r = await run(h, blocks, [...events, event('meeting', '12:00', '13:30')]);
      assert.equal(r.moved, count);
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) assert.equal(overlap(h.writes[i], h.writes[j]), false, 'moved blocks must not overlap');
      assert.equal(JSON.stringify(events), snapshot, 'caller-owned snapshot unchanged');
      assert.equal(h.activities.length, count);
      assert.equal(h.activities[0].outcomeJson.original_start, `${date}T12:00:00`);
    });
    await test(`dry-run-${count}-objects-reserves-destinations`, async () => {
      const h = rebalanceHarness(), blocks = names.map(n => block(n));
      const events = names.map((n, i) => event(n, i === 0 ? '12:00' : i === 1 ? '12:30' : '13:00', i === 0 ? '12:30' : i === 1 ? '13:00' : '13:30'));
      const snapshot = JSON.stringify(events), impact = await dry(h, blocks, events);
      assert.equal(impact.length, count);
      assert.equal(impact.filter(i => i.relocatable).length, count);
      assert.equal(new Set(impact.map(i => i.newSlotIso)).size, count, 'dry run cannot promise the same space twice');
      assert.equal(JSON.stringify(events), snapshot);
      assert.equal(h.writes.length, 0);
    });
  }
  await test('competition-no-room-never-promises-second-destination', async () => {
    const h = rebalanceHarness(), blocks = ['lunch', 'coffee'].map(n => block(n, '11:00', '12:30'));
    const events = [event('lunch', '11:30', '12:00'), event('coffee', '12:00', '12:30'), event('meeting', '11:30', '12:30')];
    const r = await run(h, blocks, events); assert.equal(r.moved, 1); assert.equal(r.overlapping, 1);
  });
  await test('repeat-and-restart-do-not-oscillate', async () => {
    const blocks = ['lunch', 'coffee'].map(n => block(n)), events = [event('lunch', '12:00', '12:30'), event('coffee', '12:30', '13:00'), event('meeting', '12:00', '13:30')];
    const h = rebalanceHarness(); await run(h, blocks, events);
    const applied = events.map(e => { const w = h.writes.find(w => w.meetingId === e.id); return w ? { ...e, start: { dateTime: w.start, timeZone: zone }, end: { dateTime: w.end, timeZone: zone } } : e; });
    assert.equal((await run(rebalanceHarness(), blocks, applied)).moved, 0);
  });
  await test('unacknowledged-first-move-stops-stale-occupancy-writes', async () => {
    const h = rebalanceHarness({ failId: 'lunch' });
    const r = await run(h, ['lunch', 'coffee'].map(n => block(n)), [event('lunch', '12:00', '12:30'), event('coffee', '12:30', '13:00'), event('meeting', '12:00', '13:30')]);
    assert.equal(r.moved, 0); assert.equal(h.activities.length, 0); assert.equal(h.writes.length, 1);
  });
  await test('notification-failure-still-reserves-successful-write', async () => {
    const h = rebalanceHarness({ shadowError: true });
    const r = await run(h, ['lunch', 'coffee'].map(n => block(n)), [event('lunch', '12:00', '12:30'), event('coffee', '12:30', '13:00'), event('meeting', '12:00', '13:30')]);
    assert.equal(r.moved, 2); assert.equal(overlap(...h.writes), false);
  });
  await test('manual-outside-window-unchanged-control', async () => {
    const h = rebalanceHarness(); await run(h, [block('lunch')], [event('lunch', '15:00', '15:40'), event('meeting', '15:00', '16:00')]); assert.equal(h.writes.length, 0);
  });
  await test('override-day-unchanged-control', async () => {
    const h = rebalanceHarness({ override: true }); await run(h, [block('lunch')], [event('lunch', '12:00', '12:30'), event('meeting', '12:00', '13:00')]); assert.equal(h.writes.length, 0);
  });
  await test('calendar-unavailable-no-writes-control', async () => {
    const h = rebalanceHarness(); const r = await run(h, [block('lunch')], undefined); assert.equal(r.moved, 0); assert.equal(h.writes.length, 0);
  });
  for (const count of [1, 2, 3]) await test(`B3-final-date-only-${count}-additions-quiet-retains-evidence`, async () => {
    const h = health.harness({ blocks: ['lunch', 'coffee', 'focus'].slice(0, count).map(n => block(n)) });
    const r = await h.scan({ mode: 'active' }); assert.equal(r.vacuous, true); assert.equal(r.fixes_applied, count); assert.equal(r.internal_actions.length, count); assert.equal(r.issues.length, count); assert.match(r.summary_text, /Booked/);
  });
  await test('B3-earlier-date-additions-still-report', async () => {
    const h = health.harness({ blocks: [block('lunch')] }); const r = await h.scan({ mode: 'active', start_date: '2026-09-14', end_date: '2026-09-15' }); assert.equal(r.vacuous, false);
  });
  await test('B3-custom-boundary-final-date-quiet', async () => {
    const h = health.harness({ blocks: [block('lunch')] }); const r = await h.scan({ mode: 'active', start_date: '2026-09-17', end_date: '2026-09-17' }); assert.equal(r.vacuous, true);
  });
  await test('B3-passive-detection-still-report', async () => {
    const r = await health.harness({ blocks: [block('lunch')] }).scan(); assert.equal(r.vacuous, false); assert.equal(r.fixes_applied, 0);
  });
  await test('B3-rebalanced-existing-block-still-report', async () => {
    const r = await health.harness({ blocks: [block('lunch')], rebalanceResult: { moved: 1, movedBlockEventIds: ['existing'] } }).scan({ mode: 'active' }); assert.equal(r.vacuous, false);
  });
  await test('B3-real-issue-plus-horizon-addition-still-report', async () => {
    const r = await health.harness({ blocks: [block('lunch')], events: [health.event('a'), health.event('b')] }).scan({ mode: 'active' }); assert.equal(r.vacuous, false); assert.ok(r.issues.some(i => i.type === 'double_booking'));
  });
  await test('B3-active-outside-window-problem-still-report', async () => {
    const r = await health.harness({ blocks: [block('lunch')], rows: [{ id: 'ci', event_id: 'future', event_date: '2026-10-01', issue_class: 'missing_category', status: 'awaiting_owner' }] }).scan({ mode: 'active' }); assert.equal(r.vacuous, false);
  });
  await test('B3-read-failure-never-silent-success', async () => { await assert.rejects(health.harness({ readError: true }).scan({ mode: 'active' }), /unreadable/); });
  function rule6(blockDef, placed, slotEnd) {
    const sf = ts.createSourceFile('rules.ts', source('src/utils/scheduleRules.ts'), ts.ScriptTarget.Latest, true);
    let loop; const visit = n => { if (ts.isForOfStatement(n) && n.expression.getText(sf) === 'floatingBlockDefs') loop = n; ts.forEachChild(n, visit); }; visit(sf);
    const run = compile(`exports.run = function(d) { const {DateTime, blockAppliesOnDay, busyForBlockWindow, isFloatingBlockEvent, blockSizedToEvent, hasOtherHumanAttendee} = d.fb; const suppressedFloatingIds = new Set(); const { input, profile, floatingBlockDefs, slotStart, slotEnd, tz }=d; const dayName='Sunday', excludeSet=new Set(), whose='your', slotFacts={}; ${loop.getText(sf)} return { passes:true }; }`, () => { throw Error('unexpected dependency'); }).run;
    return run({ fb: { ...floating, DateTime }, input: { events: placed ? [placed] : [], isFloatingBlock: false }, profile: profile([blockDef]), floatingBlockDefs: [blockDef], slotStart: DateTime.fromISO(`${date}T11:00`, { zone }), slotEnd: DateTime.fromISO(`${date}T${slotEnd}`, { zone }), tz: zone });
  }
  await test('rule6-stretched-block-protects-real-duration', () => { assert.equal(rule6(block('lunch'), event('lunch', '11:00', '12:00'), '13:15').passes, false); });
  await test('rule6-shortened-block-uses-real-duration', () => { assert.equal(rule6(block('lunch'), event('lunch', '11:00', '11:15'), '13:40').passes, true); });
  await test('rule6-config-duration-when-missing-control', () => { assert.equal(rule6(block('lunch'), null, '13:15').passes, true); });
  await test('rule6-outside-window-owner-placement-control', () => { assert.equal(rule6(block('lunch'), event('lunch', '15:00', '16:00'), '14:00').passes, true); });
  async function joinMoves(names, opts = {}) {
    const src = source('src/skills/meetings.ts');
    const start = src.indexOf('const joinDayName =');
    const decision = src.indexOf('if (joinCheck.passes) {', start);
    const tail = src.indexOf('const movesLine =', decision);
    assert.ok(start > 0 && decision > start && tail > decision, 'join AST region anchors');
    const run = compile(`exports.run=async function(d) { const { DateTime, fb, profile, events, timezone, dayStr, meetingStartMs, meetingEndMs, evTime, floatingBlocks, logger, updateMeeting, userEmail }=d; const suppressedFloatingIds = new Set(); ${src.slice(start,decision)} ${src.slice(decision + 'if (joinCheck.passes) {'.length,tail)} return movesDone; }`, n => {
      if (n === '../utils/rebalanceFloatingBlocks') return { logRebalanceMoveActivity: (...args) => opts.activities?.push(args) };
      throw Error(`Unmocked join dependency ${n}`);
    }).run;
    const writes = [], activities = []; opts.activities = activities;
    const events = names.map((n, i) => event(n, i === 0 ? '12:00' : i === 1 ? '12:30' : '13:00', i === 0 ? '12:30' : i === 1 ? '13:00' : '13:30'));
    if (opts.pinned) events[0] = event(names[0], '13:15', '14:15');
    const p = profile(names.map(n => block(n))); p.behavior = { calendar_health_mode: opts.passive ? 'passive' : 'active' };
    const original = JSON.stringify(events);
    const moves = await run({ DateTime, fb: floating, profile:p, events, timezone:zone, dayStr:date, meetingStartMs:DateTime.fromISO(`${date}T12:00`, {zone}).toMillis(), meetingEndMs:DateTime.fromISO(`${date}T13:30`, {zone}).toMillis(), evTime:t=>DateTime.fromISO(t.dateTime,{zone:t.timeZone}), floatingBlocks:p.meetings.floating_blocks, logger, userEmail:p.user.email, updateMeeting: async w => { writes.push(w); if(w.meetingId===opts.failId) throw Error('write rejected'); } });
    assert.equal(JSON.stringify(events),original,'join does not mutate input snapshot');
    return {writes,moves,activities};
  }
  for (const count of [1,2,3]) await test(`join-${count}-objects-reserves-successful-destinations`,async()=>{ const r=await joinMoves(['lunch','coffee','focus'].slice(0,count)); assert.equal(r.writes.length,count); for(let i=0;i<count;i++)for(let j=i+1;j<count;j++)assert.equal(overlap(r.writes[i],r.writes[j]),false); });
  await test('join-unacknowledged-move-stops-stale-occupancy-writes',async()=>{ const r=await joinMoves(['lunch','coffee'],{failId:'lunch'}); assert.equal(r.moves.length,0); assert.equal(r.writes.length,1); });
  await test('join-owner-pinned-partial-window-overlap-never-moved',async()=>{ const r=await joinMoves(['lunch'],{pinned:true}); assert.equal(r.writes.length,0); });
  await test('join-passive-never-writes-control',async()=>{ const r=await joinMoves(['lunch','coffee'],{passive:true}); assert.equal(r.writes.length,0); });
  await test('join-successful-moves-have-activity-audit',async()=>{ const r=await joinMoves(['lunch']); assert.equal(r.activities.length,1); });
  function bookHarness(blocks, initial = [], opts = {}) {
    const state = structuredClone(initial), writes = [], activities = [];
    const p = profile(blocks); p.assistant = { name:'Assistant' }; p.user.name='Owner';
    const mod = compile(source('src/skills/calendarHealth/handlers/floatingBlockOps.ts'), n => {
      if(n==='luxon') return luxon;
      if(n.endsWith('/utils/floatingBlocks')) return floating;
      if(n.endsWith('/utils/calendarDensity')) return density;
      if(n.endsWith('/utils/workHours')) return { getEffectiveWorkDay:()=>({hasOverride:!!opts.override}) };
      if(n.endsWith('/utils/logger')) return {__esModule:true,default:logger};
      if(n.endsWith('/core/requests/logActivity')) return {logActivity:r=>activities.push(r)};
      if(n==='../classify') return {parseGraphDt:(iso,tz)=>DateTime.fromISO(iso,{zone:tz??'UTC'}).setZone(zone)};
      if(n.endsWith('/meetings/planMeeting')) return {planMeeting:async()=>({action:'book',isOnline:false,location:''})};
      if(n.endsWith('/graph/calendar')) return {CalendarOfflineError:class extends Error {}, getOwnerEventsForDecision:async()=>{if(opts.readError)throw Error('calendar unavailable'); return structuredClone(state);},createMeeting:async a=>{writes.push(a);if(opts.writeError)throw Error('write rejected');const e={id:`created-${writes.length}`,subject:a.subject,start:{dateTime:a.start,timeZone:zone},end:{dateTime:a.end,timeZone:zone},showAs:'busy',categories:a.categories??[]};state.push(e);return e;}};
      throw Error(`unmocked booking dependency ${n}`);
    });
    return {state,writes,activities,book:(name,args={})=>mod.handleBookFloatingBlock({date,block_name:name,...args},{profile:p,userEmail:p.user.email,timezone:zone,context:{profile:p,userId:'owner',senderRole:'owner'}})};
  }
  for(const count of [1,2,3]) await test(`initial-placement-${count}-objects-and-repeat-control`,async()=>{
    const names=['lunch','coffee','focus'].slice(0,count), h=bookHarness(names.map(n=>block(n)));
    for(const n of names) assert.equal((await h.book(n)).created,true);
    for(const n of names) assert.equal((await h.book(n)).created,false);
    assert.equal(h.writes.length,count);assert.equal(h.activities.length,count);
    for(let i=0;i<count;i++)for(let j=i+1;j<count;j++)assert.equal(overlap(h.writes[i],h.writes[j]),false);
  });
  await test('initial-placement-independent-windows-duration-control',async()=>{const h=bookHarness([block('lunch','11:00','12:00',30),block('coffee','14:00','15:00',15),block('focus','16:00','18:00',60)]);for(const n of ['lunch','coffee','focus'])assert.equal((await h.book(n)).created,true);assert.deepEqual(h.writes.map(w=>DateTime.fromISO(w.end).diff(DateTime.fromISO(w.start),'minutes').minutes),[30,15,60]);});
  await test('initial-placement-honors-day-scope-control',async()=>{const h=bookHarness([{...block('coffee'),days:['Monday']}]);assert.equal((await h.book('coffee')).error,'not_applicable_today');assert.equal(h.writes.length,0);});
  await test('initial-placement-WE-fallback-when-no-clear-gap',async()=>{const h=bookHarness([block('lunch')],[{...event('optional','11:00','14:00'),showAs:'workingElsewhere'}]);const r=await h.book('lunch');assert.equal(r.created,true);assert.equal(r.overlapping_events.length,1);});
  await test('initial-placement-clear-before-WE-control',async()=>{const h=bookHarness([block('lunch')],[{...event('optional','11:00','12:00'),showAs:'workingElsewhere'}]);const r=await h.book('lunch');assert.equal(r.start,'12:00');});
  await test('initial-placement-real-busy-never-overridden-control',async()=>{const h=bookHarness([block('lunch')],[event('meeting','11:00','14:00')]);assert.equal((await h.book('lunch')).error,'no_room');assert.equal(h.writes.length,0);});
  await test('initial-placement-owner-pin-prevents-duplicate-control',async()=>{const h=bookHarness([block('lunch')],[event('lunch','15:00','16:00')]);assert.equal((await h.book('lunch')).created,false);assert.equal(h.writes.length,0);});
  await test('initial-placement-write-failure-no-success-audit-control',async()=>{const h=bookHarness([block('lunch')],[],{writeError:true});assert.ok((await h.book('lunch')).error);assert.equal(h.activities.length,0);});
  await test('initial-placement-unavailable-calendar-prevents-write-control',async()=>{const h=bookHarness([block('lunch')],[],{readError:true});await assert.rejects(h.book('lunch'),/unavailable/);assert.equal(h.writes.length,0);});
  await test('dense-consolidation-reserves-destination-and-audits-control',async()=>{
    const h=rebalanceHarness(),p=profile([block('lunch')]);p.meetings.packing_preference='dense';
    const r=await h.rebalanceFloatingBlocksAfterMutation({profile:p,affectedSlotIso:`${date}T12:00:00+03:00`,ownerSlackId:'owner',consolidateDense:true,preloadedDayEvents:[event('morning','10:00','11:00'),event('lunch','11:15','11:45'),event('afternoon','12:00','13:00')]});
    assert.equal(r.moved,1);assert.equal(h.activities.length,1);assert.equal(h.activities[0].outcomeJson.original_start,`${date}T11:15:00`);
  });
  await test('B3-unknown-booking-result-remains-visible-control',async()=>{const r=await health.harness({blocks:[block('lunch')],bookResult:null}).scan({mode:'active'});assert.equal(r.vacuous,false);assert.equal(r.fixes_applied,0);assert.equal(r.internal_actions,undefined);});
  await test('B3-already-placed-result-not-counted-as-new-control',async()=>{const r=await health.harness({blocks:[block('lunch')],bookResult:{ok:true,created:false,already_existed:true}}).scan({mode:'active'});assert.equal(r.vacuous,false);assert.equal(r.fixes_applied,0);});
  await test('B3-failed-no-room-keeps-existing-silence-control',async()=>{const r=await health.harness({blocks:[block('lunch')],bookResult:{error:'no_room',message:'No room'}}).scan({mode:'active'});assert.equal(r.vacuous,true);assert.equal(r.fixes_applied,0);assert.equal(r.internal_actions,undefined);});
  await test('initial-placement-latest-WE-fallback',async()=>{const h=bookHarness([{...block('lunch'),prefer_position:'latest_in_window'}],[{...event('optional','11:00','14:00'),showAs:'workingElsewhere'}]);const r=await h.book('lunch');assert.equal(r.start,'13:30');assert.match(r.message,/Working Elsewhere/);});
  await test('initial-placement-anchor-WE-fallback',async()=>{const h=bookHarness([block('lunch')],[event('anchor','10:00','11:00'),{...event('optional','11:00','14:00'),showAs:'workingElsewhere'}]);const r=await h.book('lunch',{prefer_position:'abut_after',anchor_event_id:'anchor'});assert.equal(r.start,'11:00');});
  await test('initial-placement-invalid-anchor-preserved-control',async()=>{const h=bookHarness([block('lunch')],[event('anchor','14:00','15:00')]);const r=await h.book('lunch',{prefer_position:'abut_after',anchor_event_id:'anchor'});assert.equal(r.error,'anchor_outside_window');assert.equal(h.writes.length,0);});
  const report = { baseline: '63221e4', snapshot: before ? 'preserved before' : 'working tree', results, passed: results.filter(r => r.status === 'pass').length, failed: results.filter(r => r.status === 'fail').length };
  fs.mkdirSync(outputDir, {recursive:true});
  fs.writeFileSync(path.join(outputDir, before ? 'before-results.json' : 'after-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.failed ? 1 : 0;
})();
