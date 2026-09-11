// Actual production modules and AST-selected handler normalization branches.
// No app bootstrap, model call, live database, Graph call or runtime write.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
const luxon = require('luxon');
const { DateTime, Settings } = luxon;
const arg = process.argv.indexOf('--source-root');
const root = arg < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[arg + 1]);
const logger = { info() {}, warn() {}, debug() {}, error() {} };
const zone = 'Asia/Jerusalem';
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
function compile(source, bindings = {}, deps = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new vm.Script(js).runInNewContext({ module, exports: module.exports, ...bindings,
    require(id) { if (id in deps) return deps[id]; throw Error(`Unexpected dependency: ${id}`); } });
  return module.exports;
}
const load = (f, deps, bindings) => compile(read(f), bindings, deps);
function ast(f) { return ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true); }
function collect(node, predicate) {
  const found = [];
  function walk(n) { if (predicate(n)) found.push(n); ts.forEachChild(n, walk); }
  walk(node); return found;
}
function only(nodes, label) { assert.equal(nodes.length, 1, label); return nodes[0]; }
function names(n) { return ts.isVariableStatement(n) ? n.declarationList.declarations.map(d=>d.name.getText()) : []; }
function harness() {
  let rows = {};
  const profile = { user: { timezone: zone, slack_user_id: 'owner', name: 'Owner Example', email: 'owner@example.test' },
    schedule: { work_hours: Object.fromEntries(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(d=>[d,['09:00-17:00']])),
      office_days: { days: ['Monday','Wednesday'] }, home_days: { days: ['Sunday','Tuesday','Thursday'] } },
    meetings: { buffer_minutes: 0 } };
  const wh = load('src/utils/workHours.ts', { luxon, '../db/scheduleOverrides': {
    getScheduleOverride(_id, date) { return rows[date] ?? null; },
  } });
  const tz = load('src/utils/timezoneConvert.ts', { luxon });
  const travel = load('src/utils/workingElsewhere.ts', { luxon, './workHours':wh, './logger':logger,
    '../db/scheduleOverrides': { listScheduleOverrides() { return Object.entries(rows).map(([date,r])=>({date,...r})); } } });
  const resolver = load('src/utils/weTimeResolver.ts', { luxon, './timezoneConvert':tz, './workHours':wh, './workingElsewhere':travel });
  const patches = [];
  let metadata = { isAllDay: false, type: 'singleInstance' };
  const metadataReads = [];
  const mutations = load('src/connectors/graph/calendarMutations.ts', { luxon, '../../utils/logger':logger,
    '../../db': { auditLog() {} }, '../../config/userProfile': { getProfileByEmail:()=>profile },
    './graphClient': { getClient:()=>({ api:()=>({patch:async p=>patches.push(p),
      select(fields) { assert.equal(fields,'isAllDay,type'); metadataReads.push(fields); return this; },
      async get() { if(metadata instanceof Error) throw metadata; return metadata; },
      async post(p) { patches.push(p); return {id:'fixture'}; } }) }) },
    './calendarReads': {}, './calendarCache': { invalidateCalendarCache() {} } });
  const outcome = load('src/utils/verifyScheduledOutcome.ts', { luxon, './workHours':wh,
    './floatingBlocks': { getFloatingBlocks:()=>[] } });
  const context = { profile };
  async function normalizeHandler(kind, args) {
    const file = `src/skills/meetings/ops/handlers/${kind === 'create' ? 'createMeeting' : 'moveMeeting'}.ts`;
    const tree = ast(file);
    const marker = kind === 'create' ? 'tripDisplay' : 'moveTripDisplay';
    const decl = only(collect(tree,n=>names(n).includes(marker)), marker);
    const statements = decl.parent.statements;
    const index = statements.indexOf(decl);
    const branch = statements[index + 1];
    assert(ts.isIfStatement(branch));
    const deps = { '../../../../utils/workingElsewhere':travel };
    return compile(`export async function run() { ${decl.getText()}\n${branch.getText()}\nreturn {args,display:${marker}}; }`,
      { args, context, timezone:zone, logger, ...resolver }, deps).run();
  }
  async function clipSearch(args, predecessorEnd) {
    const tree = ast('src/skills/meetings/ops/handlers/findAvailableSlots.ts');
    const decl = only(collect(tree,n=>names(n).includes('effectiveSearchFrom')), 'search from');
    const statements = decl.parent.statements;
    const start = statements.indexOf(decl);
    const afterId = statements.findIndex((n,i)=>i>start && names(n).includes('mustBeAfterId'));
    assert(afterId > start && ts.isIfStatement(statements[afterId+1]));
    const body = statements.slice(start,afterId+2).map(n=>n.getText()).join('\n');
    return compile(`export async function run() { ${body}\nreturn effectiveSearchFrom; }`,
      {args:{time_window_is_hard:true,...args}, context, timezone:zone, userEmail:profile.user.email, DateTime, logger, ...tz, ...resolver,
        getCalendarEvents:async()=>[{id:'predecessor',end:{dateTime:predecessorEnd,timeZone:zone}}] }).run();
  }
  return { profile, wh, tz, travel, resolver, mutations, patches, metadataReads, outcome, normalizeHandler, clipSearch,
    metadata(value) { metadata=value; },
    rows(value) { rows=value; } };
}
function freeze(iso) { const ms=DateTime.fromISO(iso).toMillis(); Settings.now=()=>ms; }
function instant(iso) { return DateTime.fromISO(iso, {setZone:true}); }
function graphInstant(pair) { return DateTime.fromISO(pair.dateTime,{zone:pair.timeZone}).toMillis(); }

test('owner contact timing follows western trip through home midnight', () => {
  const h=harness(); h.rows({'2026-09-15':{timezone:'America/New_York',windows:['09:00-18:00'],isWorkday:true}});
  assert.equal(h.wh.isWithinOwnerWorkHours(h.profile,instant('2026-09-16T00:30:00+03:00')),true);
});
test('next contact window includes previous western trip date', () => {
  const h=harness(); h.rows({'2026-09-15':{timezone:'America/New_York',windows:['19:00-21:00'],isWorkday:true}});
  freeze('2026-09-16T00:30:00+03:00');
  try { assert.equal(h.wh.nextOwnerWorkdayStart(h.profile),'2026-09-15T23:00:00.000Z'); }
  finally { Settings.now=()=>Date.now(); }
});
test('next contact window compares eastern next-day instant before home late window', () => {
  const h=harness(); h.rows({'2026-09-17':{timezone:'Pacific/Auckland',windows:['07:00-17:00'],isWorkday:true}});
  h.profile.schedule.work_hours.Wednesday=['23:00-23:59']; freeze('2026-09-16T21:00:00+03:00');
  try { assert.equal(h.wh.nextOwnerWorkdayStart(h.profile),'2026-09-16T19:00:00.000Z'); }
  finally { Settings.now=()=>Date.now(); }
});
test('home contact timing and explicit home override remain authoritative', () => {
  const h=harness(); freeze('2026-09-16T08:30:00+03:00');
  try {
    assert.equal(h.wh.nextOwnerWorkdayStart(h.profile),'2026-09-16T06:00:00.000Z');
    assert.equal(h.wh.isWithinOwnerWorkHours(h.profile,instant('2026-09-16T12:00:00+03:00')),true);
    h.rows({'2026-09-15':{timezone:'America/New_York',windows:['19:00-21:00'],isWorkday:true},'2026-09-16':{isWorkday:false}});
    assert.equal(h.wh.isWithinOwnerWorkHours(h.profile,instant('2026-09-16T03:00:00+03:00')),false);
  } finally { Settings.now=()=>Date.now(); }
});
test('DST spring explicit interval cannot fit a window ending before its wall-clock end', () => {
  const h=harness(); const span=h.wh.slotDayMinutes(instant('2027-03-14T01:30:00-05:00').setZone('America/New_York'),instant('2027-03-14T03:30:00-04:00').setZone('America/New_York'));
  assert.equal(span.endMin,210); assert.equal(span.endMin<=180,false);
});
test('DST fall explicit interval fits a 00-02 window while retaining repeated-hour span', () => {
  const h=harness(); const span=h.wh.slotDayMinutes(instant('2026-11-01T01:30:00-04:00').setZone('America/New_York'),instant('2026-11-01T01:30:00-05:00').setZone('America/New_York'));
  assert(span.startMin>=0 && span.endMin<=120);
  assert.equal(span.startMin,60); assert.equal(span.endMin,120);
});
test('normal duration midnight and explicit same-offset DST controls', () => {
  const h=harness();
  assert.equal(h.wh.slotDayMinutes(instant('2026-09-16T23:30:00+03:00'),instant('2026-09-17T00:10:00+03:00')).endMin,1450);
  assert.equal(h.wh.slotDayMinutes(instant('2026-11-01T03:00:00-05:00'),instant('2026-11-01T03:30:00-05:00')).endMin,210);
});
test('create and move bare travel clocks use stated date then reach exact Graph wall clock', async () => {
  const h=harness(); h.rows({'2026-09-15':{timezone:'America/New_York',isWorkday:true},'2026-09-16':{timezone:'America/Los_Angeles',isWorkday:true}});
  for(const kind of ['create','move']) {
    const args=kind==='create'?{start:'2026-09-16T01:00:00',end:'2026-09-16T01:30:00'}:{new_start:'2026-09-16T01:00:00',new_end:'2026-09-16T01:30:00'};
    const got=await h.normalizeHandler(kind,args);
    const start=args.start??args.new_start; const end=args.end??args.new_end;
    assert.equal(start,'2026-09-16T11:00:00.000+03:00'); assert.equal(got.display.tz,'America/Los_Angeles');
    await h.mutations.updateMeeting({userEmail:h.profile.user.email,meetingId:'fixture',timezone:zone,start,end});
    assert.equal(graphInstant(h.patches.at(-1).start),instant('2026-09-16T11:00:00+03:00').toMillis());
  }
});
test('stated home and explicit numeric offsets remain exact through handler and Graph', async () => {
  const h=harness(); h.rows({'2026-09-16':{timezone:'America/New_York',isWorkday:true}});
  for(const args of [{start:'2026-09-16T17:15:00',end:'2026-09-16T17:45:00',stated_zone:'home'},
    {start:'2026-09-16T17:15:00+03:00',end:'2026-09-16T17:45:00+03:00'}]) {
    await h.normalizeHandler('create',args);
    await h.mutations.updateMeeting({userEmail:h.profile.user.email,meetingId:'fixture',timezone:zone,start:args.start,end:args.end});
    assert.equal(graphInstant(h.patches.at(-1).start),instant('2026-09-16T17:15:00+03:00').toMillis());
  }
});
test('search predecessor never widens a converted foreign-clock lower bound', async () => {
  const h=harness(); const start=await h.clipSearch({search_from:'2026-09-16T09:00:00',search_to:'2026-09-16T10:00:00',search_window_timezone:'America/New_York',must_be_after_event_id:'predecessor'},'2026-09-16T14:00:00');
  assert.equal(DateTime.fromISO(start).toMillis(),DateTime.fromISO('2026-09-16T16:00:00+03:00').toMillis());
});
test('search predecessor still raises a lower bound when actually later', async () => {
  const h=harness(); const start=await h.clipSearch({search_from:'2026-09-16T09:00:00',search_to:'2026-09-16T11:00:00',search_window_timezone:'America/New_York',must_be_after_event_id:'predecessor'},'2026-09-16T17:00:00');
  assert.equal(DateTime.fromISO(start).toMillis(),DateTime.fromISO('2026-09-16T17:00:00+03:00').toMillis());
});
test('outcome verification uses meeting-date travel hours after home midnight', () => {
  const h=harness(); h.rows({'2026-09-15':{timezone:'America/New_York',windows:['09:00-18:00'],isWorkday:true}});
  const event={id:'fixture',subject:'Audit meeting',start:{dateTime:'2026-09-16T00:00:00',timeZone:zone},end:{dateTime:'2026-09-16T00:30:00',timeZone:zone},showAs:'busy'};
  assert.equal(h.outcome.verifyScheduledOutcome({proposedSlots:['2026-09-16T00:00:00+03:00'],subjectKeyword:'Audit meeting'},[event],h.profile).status,'booked_compliant');
});
test('outcome verification home compliant and outside-hours controls', () => {
  const h=harness();
  for(const [hour,status] of [['12','booked_compliant'],['22','booked_conflict']]) {
    const event={id:'fixture',subject:'Audit meeting',start:{dateTime:`2026-09-16T${hour}:00:00`,timeZone:zone},end:{dateTime:`2026-09-16T${hour}:30:00`,timeZone:zone},showAs:'busy'};
    assert.equal(h.outcome.verifyScheduledOutcome({proposedSlots:[`2026-09-16T${hour}:00:00+03:00`],subjectKeyword:'Audit meeting'},[event],h.profile).status,status);
  }
});

function personHarness({ hoursMissing=false, noZone=false, manualZone }={}) {
  const person={person_id:'p1',slack_id:'U1',email:'person@example.test',timezone:'America/New_York'};
  const hours={workdays:['Monday','Tuesday','Wednesday','Thursday','Friday'],hoursStart:'09:00',hoursEnd:'17:00'};
  if(noZone) delete person.timezone;
  if(manualZone) hours.timezone=manualZone;
  const entries=load('src/utils/attendeeAvailability.ts', {luxon,'./logger':logger,
    './workHours':harness().wh,
    './timezoneConvert':load('src/utils/timezoneConvert.ts',{luxon}),
    '../db': {searchPeopleMemory:()=>[person],getEffectiveTimezoneById:()=>({timezone:person.timezone}),
      getTravelRecordById:()=>({from:'2026-09-14',until:'2026-09-18',location:'Israel'})},
    './workingHoursDefault':{getEffectiveWorkingHours:()=>hoursMissing?null:hours,defaultWorkingHoursForTz:()=>hours},
    './locationTz':{inferTimezoneFromStateStatic:()=>zone} });
  return {person,entries};
}
test('known person without derived-hours cache keeps permanent and dated travel zones', () => {
  const {person,entries}=personHarness({hoursMissing:true});
  const result=entries.loadAttendeeAvailabilityForEmails([person.email],'owner@example.test',zone);
  assert(result?.length===1); assert.equal(result[0].homeTimezone,'America/New_York');
  assert.equal(entries.attendeeTzForDay(result[0],'2026-09-16'),zone);
  assert.equal(entries.attendeeTzForDay(result[0],'2026-09-21'),'America/New_York');
});
test('email adapter preserves stored hours, owner exclusion and travel return', () => {
  const {person,entries}=personHarness();
  const result=entries.loadAttendeeAvailabilityForEmails(['owner@example.test',person.email],'owner@example.test',zone);
  assert.equal(result.length,1); assert.equal(result[0].hoursStart,'09:00');
  assert.equal(entries.attendeeTzForDay(result[0],'2026-09-14'),zone);
  assert.equal(entries.attendeeTzForDay(result[0],'2026-09-18'),zone);
  assert.equal(entries.attendeeTzForDay(result[0],'2026-09-19'),'America/New_York');
});
test('Slack-only person adapter reads the same dated travel and manual hours', () => {
  const {person,entries}=personHarness(); delete person.email;
  assert.equal(typeof entries.loadAttendeeAvailabilityForPerson,'function');
  const result=entries.loadAttendeeAvailabilityForPerson(person,zone);
  assert.equal(result.email,''); assert.equal(result.homeTimezone,'America/New_York');
  assert.equal(result.hoursEnd,'17:00'); assert.equal(entries.attendeeTzForDay(result,'2026-09-16'),zone);
});

test('Graph preserves both explicit occurrences of the owner repeated hour', async () => {
  const h=harness();
  for(const offset of ['+03:00','+02:00']) {
    const start=`2026-10-25T01:15:00${offset}`; const end=`2026-10-25T01:45:00${offset}`;
    await h.mutations.updateMeeting({userEmail:h.profile.user.email,meetingId:'fixture',timezone:zone,start,end,isAllDay:false});
    assert.equal(graphInstant(h.patches.at(-1).start),instant(start).toMillis());
    assert.equal(graphInstant(h.patches.at(-1).end),instant(end).toMillis());
  }
  assert.notDeepEqual(h.patches[0].start,h.patches[1].start);
});
test('Graph all-day create and known all-day update retain local midnight dates', async () => {
  const h=harness();
  await h.mutations.createMeeting({userEmail:h.profile.user.email,timezone:zone,subject:'Away',attendees:[],start:'2026-10-25T00:00:00+03:00',end:'2026-10-26T00:00:00+02:00',isAllDay:true});
  assert.equal(h.patches[0].start.dateTime,'2026-10-25T00:00:00'); assert.equal(h.patches[0].start.timeZone,zone);
  assert.equal(h.patches[0].end.dateTime,'2026-10-26T00:00:00');
  await h.mutations.updateMeeting({userEmail:h.profile.user.email,meetingId:'fixture',timezone:zone,start:'2026-10-25T00:00:00+03:00',end:'2026-10-26T00:00:00+02:00',isAllDay:true,eventType:'singleInstance'});
  assert.equal(h.patches[1].start.dateTime,'2026-10-25T00:00:00'); assert.equal(h.patches[1].start.timeZone,zone);
  assert.equal(h.metadataReads.length,0);
});
test('Graph unknown all-day metadata is read and missing or failed reads cannot write', async () => {
  const h=harness(); const params={userEmail:h.profile.user.email,meetingId:'fixture',timezone:zone,start:'2026-10-25T00:00:00+03:00',end:'2026-10-26T00:00:00+02:00'};
  h.metadata({isAllDay:true,type:'singleInstance'}); await h.mutations.updateMeeting(params);
  assert.equal(h.metadataReads.length,1); assert.equal(h.patches[0].start.timeZone,zone);
  for(const value of [undefined,{}, {isAllDay:true}, Object.assign(new Error('not found'),{statusCode:404}),new Error('offline')]) {
    h.metadata(value); await assert.rejects(()=>h.mutations.updateMeeting(params));
    assert.equal(h.patches.length,1);
  }
});
test('metadata-only Graph update needs no all-day read', async () => {
  const h=harness(); h.metadata(new Error('must not read'));
  await h.mutations.updateMeeting({userEmail:h.profile.user.email,meetingId:'fixture',timezone:zone,subject:'Rename'});
  assert.equal(h.metadataReads.length,0); assert.equal(h.patches[0].subject,'Rename');
});
function helperFunction(name) {
  return only(collect(ast('src/skills/meetings/ops/helpers.ts'),n=>ts.isFunctionDeclaration(n)&&n.name?.text===name),name).getText();
}
test('colleague synthetic off-hours matches trip work hours crossing home midnight', () => {
  const h=harness(); h.rows({'2026-09-15':{timezone:'America/New_York',windows:['09:00-18:00'],isWorkday:true}});
  const fn=compile(helperFunction('buildOutOfHoursBusy'),{DateTime},{'../../../utils/workHours':h.wh}).buildOutOfHoursBusy;
  const blocks=fn('2026-09-16','2026-09-16',h.profile,zone);
  const at=instant('2026-09-16T00:30:00+03:00').toMillis();
  assert.equal(blocks.some(b=>instant(b.start).toMillis()<=at&&instant(b.end).toMillis()>at),false);
});
test('colleague synthetic off-hours honors home work windows and real night boundaries', () => {
  const h=harness(); const fn=compile(helperFunction('buildOutOfHoursBusy'),{DateTime},{'../../../utils/workHours':h.wh}).buildOutOfHoursBusy;
  const blocks=fn('2026-09-16','2026-09-16',h.profile,zone);
  const blocked=clock=>blocks.some(b=>instant(b.start).toMillis()<=instant(clock).toMillis()&&instant(b.end).toMillis()>instant(clock).toMillis());
  assert.equal(blocked('2026-09-16T12:00:00+03:00'),false); assert.equal(blocked('2026-09-16T03:00:00+03:00'),true);
});
async function holdVerdict(start) {
  const tree=ast('src/skills/meetings/ops/handlers/calendarReads.ts');
  const decl=only(collect(tree,n=>names(n).includes('wasOffered')),'hold offer declaration');
  const statements=decl.parent.statements; const i=statements.indexOf(decl);
  const startIndex=statements.findIndex((n,j)=>j<i && names(n).includes('holderSlackId'));
  assert(startIndex>=0&&ts.isIfStatement(statements[i+1]));
  const stashTree=ast('src/utils/offeredSlotsStash.ts');
  const shared=only(collect(stashTree,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='wasOfferedSlot'),'exact offer function');
  const getOfferedSlots=()=>[{startIso:'2026-09-16T17:25:00+03:00'}];
  const exact=compile(shared.getText(),{getLiveEntry:()=>({slots:getOfferedSlots()}),Date}).wasOfferedSlot;
  return compile(`export async function run(){${statements.slice(startIndex,i+2).map(n=>n.getText()).join('\n')} return {success:true};}`,
    {context:{channelId:'D',threadTs:'t',userId:'U'},startIso:start,Date},
    {'../../../../utils/offeredSlotsStash':{getOfferedSlots,wasOfferedSlot:exact}}).run();
}
test('hold rejects near-match while preserving exact instant in another offset',async()=>{
  assert.equal((await holdVerdict('2026-09-16T17:25:30+03:00')).error,'slot_not_offered');
});
test('hold accepts exact offer and equivalent offset representation',async()=>{
  assert.equal((await holdVerdict('2026-09-16T17:25:00+03:00')).success,true);
  assert.equal((await holdVerdict('2026-09-16T14:25:00Z')).success,true);
});
function vacatedResults(newEnd) {
  const fn=compile(helperFunction('computeVacatedSlot'),{DateTime}).computeVacatedSlot;
  const calls=collect(ast('src/skills/meetings/ops/handlers/moveMeeting.ts'),n=>ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='computeVacatedSlot');
  assert.equal(calls.length,2);
  const args={new_start:'2026-09-17T15:00:00+03:00',new_end:newEnd};
  return calls.map(call=>compile(`export const result=${call.getText()};`,{computeVacatedSlot:fn,DateTime,timezone:zone,
    preMoveStartIso:'2026-09-16T10:00:00+03:00',preMoveEndIso:'2026-09-16T11:00:00+03:00',args,effectiveStart:args.new_start,effectiveEnd:args.new_end}).result);
}
test('duration-changing move reports original freed end on both return branches',()=>{
  for(const v of vacatedResults('2026-09-17T15:30:00+03:00')) assert.equal(v.end,'2026-09-16T11:00:00.000+03:00');
});
test('same-duration move keeps the established freed interval',()=>{
  for(const v of vacatedResults('2026-09-17T16:00:00+03:00')) assert.equal(v.end,'2026-09-16T11:00:00.000+03:00');
});

test('manual named-zone work window survives missing physical zone and travel',()=>{
  for(const noZone of [false,true]) {
    const {person,entries}=personHarness({noZone,manualZone:'America/Los_Angeles'});
    const e=entries.loadAttendeeAvailabilityForEmails([person.email],'owner@example.test',zone)[0];
    assert.equal(e.workingHoursTimezone,'America/Los_Angeles');
    assert.equal(entries.attendeeTzForDay(e,'2026-09-16'),zone);
    assert.equal(e.hoursStart,'09:00');
    if(noZone) assert.equal(e.assumed,true);
  }
});

test('search display resolves attendee zone for each offered date, explicit display stays fixed',()=>{
  const tree=ast('src/skills/meetings/ops/handlers/findAvailableSlots.ts');
  const decl=only(collect(tree,n=>names(n).includes('presentTzForOutput')),'presentation function');
  const siblings=decl.parent.statements; const i=siblings.indexOf(decl);
  const entry={timezone:'America/New_York',homeTimezone:'Europe/London',travelWindow:{from:'2026-09-14',until:'2026-09-18',timezone:'America/New_York'}};
  const {entries}=personHarness();
  const run=args=>{
    const pick=compile(`${siblings[i-1].getText()}\n${decl.getText()}\nexport const pick=presentTzForOutput;`,
      {args,timezone:zone,attendeeAvailability:[entry],DateTime,singleAttendeePresentationZone:entries.singleAttendeePresentationZone}).pick;
    return typeof pick==='function'?pick:()=>pick;
  };
  assert.equal(run({})('2026-09-21T16:00:00+03:00'),'Europe/London');
  assert.equal(run({})('2026-09-16T16:00:00+03:00'),'America/New_York');
  const fixed=run({present_in_timezone:'Asia/Tokyo'});
  assert.equal(fixed('2026-09-16T16:00:00+03:00'),'Asia/Tokyo');
  assert.equal(fixed('2026-09-21T16:00:00+03:00'),'Asia/Tokyo');
});

test('clock-only handler summaries render canonical instant in owner frame',()=>{
  const format=compile(helperFunction('formatIsoTime'),{DateTime}).formatIsoTime;
  assert.equal(format('2026-09-16T14:15:00Z',zone),'17:15');
  assert.equal(format('2026-09-16T17:25:00+03:00',zone),'17:25');
});

function searchBand(params,start,end) {
  const tree=ast('src/connectors/graph/findAvailableSlots.ts');
  const decl=only(collect(tree,n=>names(n).includes('bandFromMin')),'band init');
  const list=decl.parent.statements; const i=list.indexOf(decl);
  const guard=only(collect(tree,n=>ts.isIfStatement(n)&&n.expression.getText()==='bandFromMin >= 0'),'band guard');
  const cursorDt=instant(start).setZone(params.timezone),slotEndLocal=instant(end).setZone(params.timezone);
  const fn=compile(`export function run(){${list.slice(i,i+4).map(n=>n.getText()).join('\n')} ${guard.getText()} return {kind:'accept'};}`,
    {params,DateTime,cursorDt,slotEndLocal,slotTotalMin:cursorDt.hour*60+cursorDt.minute,
      slotEndMin:cursorDt.hour*60+cursorDt.minute+params.durationMinutes,slotDayMinutes:harness().wh.slotDayMinutes}).run;
  return fn().kind;
}

test('hard foreign daily band stays 09-10 across noncoincident DST transitions with attendees',()=>{
  const params={timezone:zone,searchFrom:'2026-10-23T16:00:00+03:00',searchTo:'2026-11-02T17:00:00+02:00',durationMinutes:30,
    attendeeAvailability:[{}],requestedTimeWindow:{from:'2026-10-23T09:00:00',to:'2026-11-02T10:00:00',timezone:'America/New_York'}};
  assert.equal(searchBand(params,'2026-10-26T09:00:00-04:00','2026-10-26T09:30:00-04:00'),'accept');
  assert.equal(searchBand(params,'2026-10-26T10:00:00-04:00','2026-10-26T10:30:00-04:00'),'reject');
  assert.equal(searchBand({...params,attendeeAvailability:undefined},'2026-10-26T09:00:00-04:00','2026-10-26T09:30:00-04:00'),'accept');
  assert.equal(searchBand(params,'2026-11-02T09:00:00-05:00','2026-11-02T09:30:00-05:00'),'accept');
});

test('soft public search expands timed bounds while hard and predecessor constraints stay exact',async()=>{
  const h=harness();
  assert.equal(await h.clipSearch({search_from:'2026-09-16T10:00:00',search_to:'2026-09-16T15:30:00',time_window_is_hard:false},''),'2026-09-16T00:00:00.000+03:00');
  assert.equal(DateTime.fromISO(await h.clipSearch({search_from:'2026-09-16T10:00:00',search_to:'2026-09-16T15:30:00',time_window_is_hard:true},'')).toMillis(),DateTime.fromISO('2026-09-16T10:00:00',{zone}).toMillis());
  const params={timezone:zone,searchFrom:'2026-09-16T10:00:00',searchTo:'2026-09-18T15:30:00',durationMinutes:30,requestedTimeWindow:null};
  assert.equal(searchBand(params,'2026-09-17T21:00:00+03:00','2026-09-17T21:30:00+03:00'),'accept');
});

test('requested midnight-wrapping band rejects an interval running past its next-day end',()=>{
  const params={timezone:zone,searchFrom:'2026-09-16T22:00:00',searchTo:'2026-09-19T01:00:00',durationMinutes:180,
    requestedTimeWindow:{from:'2026-09-16T22:00:00',to:'2026-09-19T01:00:00',timezone:zone}};
  assert.equal(searchBand(params,'2026-09-17T23:00:00+03:00','2026-09-18T02:00:00+03:00'),'reject');
  assert.equal(searchBand({...params,durationMinutes:90},'2026-09-17T23:00:00+03:00','2026-09-18T00:30:00+03:00'),'accept');
});

function attendeeHoursVerdict(params,start) {
  const tree=ast('src/connectors/graph/findAvailableSlots.ts');
  const branch=only(collect(tree,n=>ts.isIfStatement(n)&&n.expression.getText()==='params.attendeeAvailability && params.attendeeAvailability.length > 0'),'attendee hours branch');
  const {entries}=personHarness(); const cursorDt=instant(start).setZone(zone);
  return compile(`export function run(){const keepAttendeeConflicts=params.relaxed||params.tagAttendeeConflicts; const attendeeConflicts=[]; ${branch.getText()} return {kind:'accept',attendeeConflicts};}`,
    {params,DateTime,cursorDt,cursor:cursorDt.toJSDate(),slotEnd:cursorDt.plus({minutes:30}).toJSDate(),slotDayMinutes:harness().wh.slotDayMinutes,
      attendeeWorkSegmentsBetween:entries.attendeeWorkSegmentsBetween,attendeeTzForDay:entries.attendeeTzForDay,tzTempDifferingForDay:entries.tzTempDifferingForDay}).run();
}

test('M17 general relaxed and busy-tag offers keep hours; exact named requested slot can annotate',()=>{
  const entry={email:'person@example.test',timezone:'America/New_York',workdays:['Wednesday'],hoursStart:'09:00',hoursEnd:'17:00'};
  for(const flags of [{relaxed:true},{tagAttendeeConflicts:true}]) {
    assert.equal(attendeeHoursVerdict({...flags,attendeeAvailability:[entry]},'2026-09-16T12:00:00+03:00').kind,'reject');
    assert.equal(attendeeHoursVerdict({...flags,attendeeAvailability:[entry]},'2026-09-16T16:00:00+03:00').kind,'accept');
    const exact=attendeeHoursVerdict({...flags,allowAttendeeOffHours:true,attendeeAvailability:[entry]},'2026-09-16T12:00:00+03:00');
    assert.equal(exact.kind,'accept'); assert.equal(exact.attendeeConflicts[0].reason,'off_hours');
  }
  const fixed={...entry,workingHoursTimezone:'Asia/Jerusalem'};
  assert.equal(attendeeHoursVerdict({attendeeAvailability:[fixed]},'2026-09-16T12:00:00+03:00').kind,'accept');
});

test('trip date resolution supports opposite sides of the date line in both directions',()=>{
  const h=harness(); h.profile.user.timezone='Pacific/Kiritimati';
  h.rows({'2026-09-14':{timezone:'Pacific/Honolulu',windows:['22:00-23:59'],isWorkday:true}});
  const western=instant('2026-09-16T00:30:00+14:00');
  // Honolulu is UTC-10 (exactly 24 hours), while GMT+12 is the supported
  // UTC-12 IANA zone needed to exercise a two-date difference.
  h.rows({'2026-09-14':{timezone:'Etc/GMT+12',windows:['22:00-23:59'],isWorkday:true}});
  assert.equal(h.wh.getEffectiveWorkDayForInstant(western.toISO(),h.profile).timezone,'Etc/GMT+12');
  assert.equal(h.wh.isWithinOwnerWorkHours(h.profile,western),true);
  h.profile.user.timezone='Etc/GMT+12';
  h.rows({'2026-09-18':{timezone:'Pacific/Kiritimati',windows:['00:00-02:00'],isWorkday:true}});
  assert.equal(h.wh.getEffectiveWorkDayForInstant('2026-09-16T23:30:00-12:00',h.profile).timezone,'Pacific/Kiritimati');
});

test('dual clock displays different local dates and interval-end rollover',()=>{
  const h=harness(); const away={isAway:true,effectiveTz:'America/New_York',location:''};
  const rendered=h.resolver.renderWeDualClock('2026-09-16T00:30:00+03:00',away,zone,{endIso:'2026-09-16T01:00:00+03:00'});
  assert.match(rendered,/Tue 15 Sep 17:30/); assert.match(rendered,/Wed 16 Sep 00:30/);
  const home=h.resolver.renderWeDualClock('2026-09-16T23:30:00+03:00',{isAway:false,effectiveTz:zone,location:''},zone,{endIso:'2026-09-17T00:30:00+03:00'});
  assert.match(home,/Thu 17 Sep 00:30/);
});

test('empty calendar audit context uses the requested local day and renders UTC instants locally',()=>{
  const tree=ast('src/skills/meetings/ops/handlers/calendarReads.ts');
  const decl=only(collect(tree,n=>names(n).includes('windowStartMs')),'audit start');
  const list=decl.parent.statements; const i=list.indexOf(decl);
  const fmt=only(collect(tree,n=>names(n).includes('fmt')&&n.getText().includes('cancelled')),'audit formatter');
  const code=`${list.slice(i,i+3).map(n=>n.getText()).join('\n')} ${fmt.getText()} export {inWindow,fmt};`;
  const f=compile(code,{args:{start_date:'2026-09-16',end_date:'2026-09-16'},timezone:zone,DateTime,Date});
  const entry=iso=>({timestamp:'2026-09-15T20:00:00Z',details:{subject:'fixture',event_start_iso:iso}});
  assert.equal(f.inWindow(entry('2026-09-16T00:15:00+03:00')),true);
  assert.equal(f.inWindow(entry('2026-09-17T00:00:00+03:00')),false);
  assert.match(f.fmt('created',entry('2026-09-16T14:15:00Z')),/17:15/);
});

test('room free-busy check anchors an accepted bare booking clock in owner timezone',async()=>{
  const fn=load('src/utils/meetingRoomAvailability.ts',{luxon,'./logger':logger,
    '../connectors/graph/calendar':{getFreeBusyForDecision:async()=>({'room@example.test':[{start:'2026-09-16T14:00:00Z',end:'2026-09-16T15:00:00Z',status:'busy'}]})}}).checkMeetingRoomAvailability;
  const profile={user:{timezone:zone,email:'owner@example.test'},meetings:{room_email:'room@example.test'}};
  assert.equal((await fn({profile,startIso:'2026-09-16T17:00:00',endIso:'2026-09-16T17:30:00',participantCount:6})).kind,'room_busy_too_big');
  assert.equal((await fn({profile,startIso:'2026-09-16T18:00:00+03:00',endIso:'2026-09-16T18:30:00+03:00',participantCount:6})).kind,'room_free');
});

test('real candidate_slots and preferred_slot producers preserve exact times and scope off-hours opt-in',()=>{
  const tree=ast('src/skills/meetings/ops/handlers/findAvailableSlots.ts');
  const args={candidate_slots:[{start:'2026-09-16T05:25:00'}],preferred_slot:'2026-09-16T05:25:00',duration_minutes:30,search_window_timezone:'America/New_York'};
  const normalized=only(collect(tree,n=>names(n).includes('normalized')&&n.getText().includes('candidates')),'candidate producer');
  const preferred=only(collect(tree,n=>names(n).includes('preferredSlot')),'preferred producer');
  const raw=only(collect(tree,n=>names(n).includes('rawPreferredSlot')),'preferred raw');
  const tz=harness().tz;
  const resolve=only(collect(tree,n=>names(n).includes('resolveRequestedClock')),'shared requested clock');
  const p=compile(`${resolve.getText()} ${normalized.getText()} ${raw.getText()} ${preferred.getText()} export {normalized,preferredSlot};`,
    {args,context:{profile:harness().profile},candidates:args.candidate_slots,durationMin:args.duration_minutes,searchWindowTz:args.search_window_timezone,timezone:zone,DateTime,...tz,...harness().resolver});
  assert.equal(p.normalized[0].start,'2026-09-16T12:25:00.000+03:00');
  assert.equal(p.preferredSlot,p.normalized[0].start);
  const calls=collect(tree,n=>ts.isCallExpression(n)&&n.expression.getText()==='findAvailableSlots'&&ts.isObjectLiteralExpression(n.arguments[0]));
  for(const call of calls) {
    const obj=call.arguments[0];
    const props=obj.properties.filter(n=>['searchFrom','searchTo','relaxed','allowAttendeeOffHours'].includes(n.name?.getText()));
    const cfg=compile(`export const cfg={${props.map(n=>n.getText()).join(',')}};`,
      {cand:p.normalized[0],preferredSlot:p.preferredSlot,prefEndIso:p.normalized[0].end,relaxedGranted:true,
       effectiveSearchFrom:'2026-09-16T00:00:00+03:00',effectiveSearchTo:'2026-09-17T23:59:59+03:00'}).cfg;
    const exact=obj.properties.some(n=>n.name?.getText()==='searchFrom'&&['cand.start','preferredSlot'].includes(n.initializer?.getText()));
    assert.equal(cfg.allowAttendeeOffHours===true,exact);
    if(exact) assert.equal(cfg.searchFrom,'2026-09-16T12:25:00.000+03:00');
  }
});

test('synthetic work intervals switch at eastern trip midnight inside the home day',()=>{
  const h=harness(); h.rows({'2026-09-17':{timezone:'Pacific/Kiritimati',windows:['09:00-17:00'],isWorkday:true}});
  const fn=compile(helperFunction('buildOutOfHoursBusy'),{DateTime},{'../../../utils/workHours':h.wh}).buildOutOfHoursBusy;
  const blocks=fn('2026-09-16','2026-09-16',h.profile,zone);
  const at=instant('2026-09-16T14:00:00+03:00').toMillis();
  assert.equal(h.wh.isWithinOwnerWorkHours(h.profile,instant('2026-09-16T14:00:00+03:00')),false);
  assert.equal(blocks.some(b=>instant(b.start).toMillis()<=at&&instant(b.end).toMillis()>at),true);
});

test('shared Graph time mutation blocks a series master even after a failed caller preflight',async()=>{
  const h=harness(); h.metadata({isAllDay:false,type:'seriesMaster'});
  const params={userEmail:h.profile.user.email,meetingId:'fixture',timezone:zone,start:'2026-11-01T01:15:00-04:00',end:'2026-11-01T01:45:00-04:00'};
  await assert.rejects(()=>h.mutations.updateMeeting(params),/series master/);
  assert.equal(h.patches.length,0);
  await assert.rejects(()=>h.mutations.updateMeeting({...params,isAllDay:false,eventType:'seriesMaster'}),/series master/);
  assert.equal(h.metadataReads.length,1); assert.equal(h.patches.length,0);
});

test('known occurrence metadata preserves exact timed instant; metadata-only master edit stays allowed',async()=>{
  const h=harness(); h.metadata(new Error('known fact should avoid read'));
  for(const eventType of ['singleInstance','occurrence','exception']) {
    const start='2026-11-01T01:15:00-05:00';
    await h.mutations.updateMeeting({userEmail:h.profile.user.email,meetingId:'fixture',timezone:zone,start,end:'2026-11-01T01:45:00-05:00',isAllDay:false,eventType});
    assert.equal(graphInstant(h.patches.at(-1).start),instant(start).toMillis());
  }
  await h.mutations.updateMeeting({userEmail:h.profile.user.email,meetingId:'fixture',timezone:zone,subject:'Rename',eventType:'seriesMaster'});
  assert.equal(h.metadataReads.length,0); assert.equal(h.patches.at(-1).subject,'Rename');
});
