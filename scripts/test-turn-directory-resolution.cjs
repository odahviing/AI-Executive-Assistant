// Whole turn builder + real stored-name resolver + actual Connection directory.
// Existing strict turn fixture isolates unrelated services; provider replies are fake.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
function compile(file, mocks) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})(name => {
    assert.ok(Object.hasOwn(mocks, name), `declared dependency ${file}: ${name}`); return mocks[name];
  }, mod, mod.exports);
  return mod.exports;
}
let fixtureSource = fs.readFileSync(path.join(__dirname, 'test-turn-context-boundaries.cjs'), 'utf8');
fixtureSource = fixtureSource.replace("const prefix = 'artifacts/workshop-verification/slack-audit-20260919/handyman';", "const prefix = 'artifacts/workshop-verification/minor-5.2.0/handyman/identity';")
  .replace('function fixture(t) {', 'function fixture(t, extraMocks = {}) {')
  .replace('  const modules = new Map();', '  Object.assign(mocks, extraMocks);\n  const modules = new Map();');
const fixtureModule = { exports: {} };
vm.runInNewContext('(function(require,module,exports,__dirname){' + fixtureSource + '\nmodule.exports={fixture};})',
  { console, process, Date, Map, Set, Buffer })(name => name === 'node:test' ? { test() {} } : require(require.resolve(name, { paths: [__dirname] })),
  fixtureModule, fixtureModule.exports, __dirname);
const logger = { __esModule: true, default: { info() {}, warn() {}, error() {} } };
const rows = [
  { slack_id: 'UDANIEL01', name: 'Daniel One', email: 'daniel.one@example.test' },
  { slack_id: 'UDANIEL02', name: 'Daniel Two', email: 'daniel.two@example.test' },
  { name: 'Daniel External', email: 'daniel@external.test' },
];
function setup(t, options = {}) {
  const memoryRows = options.rows || rows;
  const memory = { searchPeopleMemory: () => memoryRows, getPersonByEmail: email => memoryRows.find(r => r.email === email) };
  const resolver = compile('src/memory/resolveAttendeeEmails.ts', { '../db/people': memory, '../utils/logger': logger });
  const calls = [];
  const connectionModule = compile('src/connections/slack/index.ts', {
    './messaging': {}, './formatting': {}, './eligibility': {}, '../../db': memory, '../../utils/logger': logger,
  });
  const connection = connectionModule.createSlackConnection({ client: { users: {
    info: async ({ user }) => {
      calls.push(user); if (options.unavailable) throw Error('provider unavailable');
      return { ok: true, user: { deleted: options.ambiguous ? false : user === 'UDANIEL02' } };
    }, list: async () => ({ ok: true, members: [] }),
  } } }, 'fixture', { user: { email: 'owner@example.test' } });
  const lookups = [];
  const f = fixtureModule.exports.fixture(t, {
    'src/memory/resolveAttendeeEmails.ts': resolver,
    'src/connections/registry.ts': { listConnections: () => [], getConnection: () => options.absent ? null : {
      executeToolCall: (...args) => { lookups.push(args); return connection.executeToolCall(...args); },
    } },
  });
  f.state.meetingPeople = [options.name || 'Daniel'];
  return { ...f, calls, lookups };
}
for (const role of ['owner', 'colleague']) for (const participation of ['optional', 'required']) {
  test(`current ${role} ${participation} participant resolves before generation without becoming mandatory`, async t => {
    const f = setup(t); const r = await f.run({ userMessage: `Schedule with Daniel as ${participation}.`,
      senderRole: role, authority: role, userId: role === 'owner' ? 'UOWNER' : 'UACTIVE', surface: role === 'owner' ? 'owner_dm' : 'colleague_dm' });
    assert.equal(f.lookups.length, 1); assert.equal(f.calls.length, 2);
    assert.ok(r.prompt.includes('Daniel One <daniel.one@example.test>'));
    assert.ok(!r.prompt.includes('NOT matched to an internal colleague: Daniel'));
    assert.equal(r.resolvedMeetingAttendees.length, 0, 'contact identity cannot decide required participation');
    assert.equal(f.lookups[0][2].surface, role === 'owner' ? 'owner_dm' : 'colleague_dm');
  });
}
test('genuine two active people remain ambiguous', async t => {
  const f = setup(t, { ambiguous: true }); const r = await f.run({ userMessage: 'Schedule with Daniel.' });
  assert.equal(r.resolvedMeetingAttendees.length, 0);
  assert.ok(r.prompt.includes('NOT matched to an internal colleague: Daniel'));
  assert.ok(!r.prompt.includes('Daniel One <daniel.one@example.test>'));
});

for(const identifier of ['טל <mailto:tal@outside.test|tal@outside.test>','tal@outside.test'])
test('a human-specified external mailbox stays in its own meeting roster: '+identifier,async t=>{
 const f=setup(t,{rows:[],name:identifier});f.state.scopes=['meetings'];
 f.state.requestUpdate={relation:'new'};f.state.classifierExtras={meetingAction:'execute',meetingPeopleGroups:[[identifier]]};
 const text='Arrange the meeting with '+identifier;
 const result=await f.run({userMessage:text,rawUserMessage:text,typedUserMessage:text});
 assert.deepEqual(Array.from(result.resolvedMeetingAttendeeGroups[0].emails),['tal@outside.test']);
 assert.deepEqual(Array.from(result.resolvedMeetingAttendeeGroups[0].unresolvedNames),[]);
 assert.equal(f.lookups.length,0,'a supplied mailbox is not an unknown name to look up');
 const next='Same participants, next week';f.state.meetingPeople=[];f.state.requestUpdate={relation:'continue'};
 f.state.classifierExtras={meetingAction:'explore',meetingContinuation:true,participantsUnchanged:true,meetingPeopleGroups:result.meetingRequest.participantGroups};
 const continued=await f.run({userMessage:next,rawUserMessage:next,typedUserMessage:next,conversationHistory:[{role:'assistant',content:'Looking for a time.',toolSummaries:[],meetingRequest:result.meetingRequest}]});
 assert.deepEqual(Array.from(continued.resolvedMeetingAttendeeGroups[0].emails),['tal@outside.test']);
});
test('group labels bind to the explicit mailbox attached to that same human label',async t=>{
 const identifier='טל <mailto:tal@outside.test|different@display.test>';
 const f=setup(t,{rows:[rows[0]],name:identifier});f.state.scopes=['meetings'];f.state.meetingPeople=['Daniel One',identifier];
 f.state.requestUpdate={relation:'new'};f.state.classifierExtras={meetingAction:'execute',meetingPeopleGroups:[['Daniel One','טל']]};
 const text='Meet Daniel One and '+identifier;const r=await f.run({userMessage:text,rawUserMessage:text,typedUserMessage:text});
 assert.equal(r.resolvedMeetingAttendeeGroups.length,1);assert.deepEqual(Array.from(r.resolvedMeetingAttendeeGroups[0].emails).sort(),['daniel.one@example.test','tal@outside.test']);
 assert.ok(!r.resolvedMeetingAttendees.includes('different@display.test'));
});
test('the same label on two mailboxes remains ambiguous rather than choosing an address',async t=>{
 const names=['Tal <mailto:first@outside.test|first@outside.test>','Tal <mailto:second@outside.test|second@outside.test>'];
 const f=setup(t,{rows:[],name:names[0]});f.state.scopes=['meetings'];f.state.meetingPeople=names;
 f.state.requestUpdate={relation:'new'};f.state.classifierExtras={meetingAction:'execute',meetingPeopleGroups:[['Tal']]};
 const text=names.join(' and ');const r=await f.run({userMessage:text,rawUserMessage:text,typedUserMessage:text});
 assert.equal(r.resolvedMeetingAttendeeGroups.length,0);
});
for (const option of ['unavailable', 'absent']) test(`${option} directory does not invent a resolved contact`, async t => {
  const f = setup(t, { [option]: true }); const r = await f.run({ userMessage: 'Schedule with Daniel.' });
  assert.equal(r.resolvedMeetingAttendees.length, 0); assert.ok(r.prompt.includes('NOT matched to an internal colleague: Daniel'));
  assert.ok(!r.prompt.includes('Daniel One <daniel.one@example.test>'));
});
test('substring candidate never binds as whole-name person', async t => {
  const f = setup(t, { name: 'Dan', rows: [rows[0]] }); const r = await f.run({ userMessage: 'Schedule with Dan.' });
  assert.equal(r.resolvedMeetingAttendees.length, 0); assert.ok(!r.prompt.includes('Daniel One <daniel.one@example.test>'));
});
test('external contact without a workspace identity never becomes a directory member', async t => {
  const f = setup(t, { rows: [{ ...rows[0], slack_id:undefined, email: 'daniel@external.test' }] });
  const r = await f.run({ userMessage: 'Schedule with Daniel.' });
  assert.equal(r.resolvedMeetingAttendees.length, 0); assert.ok(!r.prompt.includes('<daniel@external.test>'));
});
test('room projection never exposes the directory contact email', async t => {
  const f = setup(t); const r = await f.run({ userMessage: 'Schedule with Daniel.', isChannel: true,
    senderRole: 'colleague', authority: 'colleague', userId: 'UACTIVE', surface: 'room' });
  assert.equal(r.resolvedMeetingAttendees.length, 0); assert.ok(!r.prompt.includes('daniel.one@example.test'));
});
test('history-only name fails current raw-message gate before any lookup', async t => {
  const f = setup(t); const r = await f.run({ userMessage: 'Schedule with Daniel.', rawUserMessage: 'Show my options.' });
  assert.equal(f.lookups.length, 0); assert.equal(r.resolvedMeetingAttendees.length, 0);
});
test('existing unambiguous stored required participant keeps its search union', async t => {
  const f = setup(t, { rows: [rows[0]] }); const r = await f.run({ userMessage: 'Schedule with Daniel.' });
  assert.equal(f.lookups.length, 0); assert.ok(r.resolvedMeetingAttendees.includes('daniel.one@example.test'));
});
test('repeat read checks current eligibility again without durable mutations', async t => {
  const f = setup(t); const input = { userMessage: 'Schedule with Daniel.' };
  await f.run(input); await f.run(input);
  assert.equal(f.lookups.length, 2); assert.equal(f.calls.length, 4);
});

test('corrected external address stays bound to its name through later roster reconstruction',async t=>{
 const f=setup(t,{rows:[rows[0],{slack_id:'UALEX001',name:'Alex Other',email:'alex@wrong.test'}]});
 const names=['Alex','Daniel One'];f.state.meetingPeople=names;f.state.requestUpdate={relation:'new'};f.state.classifierExtras={meetingPeopleGroups:[names]};
 const first='Meet with Alex and Daniel One';const a=await f.run({userMessage:first,typedUserMessage:first,rawUserMessage:first});
 const correction='Use alex@external.test for Alex';f.state.meetingPeople=['Alex'];f.state.requestUpdate={relation:'continue'};
 f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:true,meetingPeopleGroups:[names],participantCorrections:[{group:0,from:'Alex',to:'alex@external.test',quote:correction}]};
 const history=[{role:'user',content:first},{role:'assistant',content:'Which address for Alex?',toolSummaries:[],meetingRequest:a.meetingRequest}];
 const b=await f.run({userMessage:correction,typedUserMessage:correction,rawUserMessage:correction,conversationHistory:history});
 assert.ok(b.resolvedMeetingAttendees.includes('alex@external.test'));assert.ok(b.resolvedMeetingAttendees.includes('daniel.one@example.test'));
 assert.ok(b.meetingRequest.participantBindings.some(x=>x.name==='Alex'&&x.identifier==='alex@external.test'));
 const follow='Why did you omit Alex?';f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:false,meetingPeopleGroups:[names]};
 const next=[...history,{role:'user',content:correction},{role:'assistant',content:'Address corrected.',toolSummaries:[],meetingRequest:b.meetingRequest}];
 const c=await f.run({userMessage:follow,typedUserMessage:follow,rawUserMessage:follow,conversationHistory:next});
 assert.deepEqual([...c.resolvedMeetingAttendees].sort(),['alex@external.test','daniel.one@example.test']);
 assert.ok(!c.prompt.includes('Alex Other'));
 f.state.requestUpdate={relation:'new'};f.state.classifierExtras={meetingPeopleGroups:[['Alex']]};
 const d=await f.run({userMessage:'Meet Alex',typedUserMessage:'Meet Alex',rawUserMessage:'Meet Alex',conversationHistory:next});
 assert.equal(d.meetingRequest.participantBindings.length,0);
});

for(const unchanged of [false,true])test('one unassigned address cannot erase a separately verified participant correction: '+unchanged,async t=>{
 const f=setup(t,{rows:[rows[0]]}),names=['Tal','Alex','Daniel One'];
 f.state.meetingPeople=names;f.state.requestUpdate={relation:'new'};f.state.classifierExtras={meetingPeopleGroups:[names]};
 const first='Meet Tal, Alex and Daniel One';
 const a=await f.run({userMessage:first,typedUserMessage:first,rawUserMessage:first});
 const next='Tal <mailto:tal@outside.test|tal@outside.test>\nhello@outside.test';f.state.meetingPeople=next.split('\n');f.state.requestUpdate={relation:'continue'};
 f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:unchanged,meetingPeopleGroups:[names],
  participantCorrections:[{group:0,from:'Tal',to:'tal@outside.test',quote:'Tal <mailto:tal@outside.test|tal@outside.test>'}]};
 const history=[{role:'user',content:first},{role:'assistant',content:'Which emails for Tal and Alex?',toolSummaries:[],meetingRequest:a.meetingRequest}];
 const b=await f.run({userMessage:next,typedUserMessage:next,rawUserMessage:next,conversationHistory:history});
 assert.ok(b.meetingRequest.participantBindings.some(x=>x.name==='Tal'&&x.identifier==='tal@outside.test'));
 assert.deepEqual(Array.from(b.meetingRequest.participantGroups[0]),['tal@outside.test','Alex','Daniel One']);
 assert.deepEqual(Array.from(b.resolvedMeetingAttendeeGroups),[],'the unassigned address still prevents a guessed combined roster');
 assert.ok(b.prompt.includes('Human-supplied participant identities'));
 f.state.meetingPeople=[];
 f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:true,meetingPeopleGroups:[names]};
 const waiting='Please remember the correct addresses';
 const c=await f.run({userMessage:waiting,typedUserMessage:waiting,rawUserMessage:waiting,
  conversationHistory:[...history,{role:'user',content:next},{role:'assistant',content:'Which person uses hello@outside.test?',toolSummaries:[],meetingRequest:JSON.parse(JSON.stringify(b.meetingRequest))}]});
 assert.deepEqual(Array.from(c.resolvedMeetingAttendeeGroups),[],'a later vague followup cannot forget the unassigned address and restore the directory namesake');
 f.state.meetingPeople=['hello@outside.test'];
 f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:true,meetingPeopleGroups:[names],
  participantCorrections:[{group:0,from:'Alex',to:'hello@outside.test',quote:'Alex is hello@outside.test'}]};
 const answer='Alex is hello@outside.test';
 const d=await f.run({userMessage:answer,typedUserMessage:answer,rawUserMessage:answer,
  conversationHistory:[...history,{role:'user',content:next},{role:'assistant',content:'Which person uses hello@outside.test?',toolSummaries:[],meetingRequest:JSON.parse(JSON.stringify(c.meetingRequest))}]});
 assert.equal(d.resolvedMeetingAttendeeGroups.length,1);
 assert.ok(d.resolvedMeetingAttendeeGroups[0].emails.includes('hello@outside.test'));
 f.state.meetingPeople=next.split('\n');
 f.state.classifierExtras.participantCorrections=[{group:0,from:'Tal',to:'intruder@outside.test',quote:'not present'}];
 const bad=await f.run({userMessage:next,typedUserMessage:next,rawUserMessage:next,conversationHistory:history});
 assert.ok(!bad.meetingRequest.participantBindings.some(x=>x.identifier==='intruder@outside.test'));
 assert.ok(bad.meetingRequest.participantGroups[0].includes('tal@outside.test'),'the explicit Tal label still binds the legitimate mailbox despite a separate fabricated correction');
});

test('a continuing multi-meeting request retains separate rosters while one meeting is discussed',async t=>{
 const f=setup(t,{rows:[rows[0],{slack_id:'UPAUL001',name:'Paul',email:'paul@example.test'},{slack_id:'UADAM001',name:'Adam',email:'adam@example.test'}]});
 const groups=[['Daniel One'],['Paul'],['Adam']];
 f.state.meetingPeople=groups.flat();f.state.requestUpdate={relation:'new'};f.state.classifierExtras={meetingPeopleGroups:groups};
 const first='Book separate meetings with Daniel One, Paul and Adam';
 const a=await f.run({userMessage:first,typedUserMessage:first,rawUserMessage:first});
 assert.equal(a.meetingRequest.batch,true,'the proven partition determines batch state');
 f.state.meetingPeople=['Adam'];f.state.requestUpdate={relation:'continue'};f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:false,meetingPeopleGroups:[['Adam']]};
 const history=[{role:'user',content:first},{role:'assistant',content:'Which time for Adam?',toolSummaries:[],meetingRequest:a.meetingRequest}];
 const next='Adam at 15:40';const b=await f.run({userMessage:next,typedUserMessage:next,rawUserMessage:next,conversationHistory:history});
 assert.deepEqual(JSON.parse(JSON.stringify(b.meetingRequest.participantGroups)),groups);
 assert.equal(b.resolvedMeetingAttendeeGroups.length,3,'Paul cannot inherit Adams roster on the next turn');
 f.state.meetingPeople=['Adam','Paul'];f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:false,meetingPeopleGroups:[['Adam','Paul']]};
 const mixed='Adam and Paul';const c=await f.run({userMessage:mixed,typedUserMessage:mixed,rawUserMessage:mixed,conversationHistory:history});
 assert.equal(c.resolvedMeetingAttendeeGroups.length,0,'a combined partition cannot silently merge two appointments');
});

for(const role of ['owner','colleague'])test('optional role survives continuation and can become required: '+role,async t=>{
 const f=setup(t,{rows:[rows[0]]});const opts={senderRole:role,authority:role,surface:role==='owner'?'owner_dm':'colleague_dm',userId:role==='owner'?'UOWNER':'UACTIVE'};
 const msg='Meet Daniel One; Daniel One is optional';f.state.meetingPeople=['Daniel One'];f.state.requestUpdate={relation:'new'};f.state.classifierExtras={meetingPeopleGroups:[['Daniel One']],participantRoles:[{name:'Daniel One',role:'optional',quote:'Daniel One is optional'}]};
 const a=await f.run({...opts,userMessage:msg,typedUserMessage:msg,rawUserMessage:msg});
 assert.deepEqual([...a.resolvedOptionalAttendees],['daniel.one@example.test']);assert.ok(a.resolvedMeetingAttendees.includes('daniel.one@example.test'),'optional guest stays in invitation roster');
 const history=[{role:'user',content:msg},{role:'assistant',content:'Which day?',meetingRequest:a.meetingRequest,toolSummaries:[]}];
 f.state.meetingPeople=[];f.state.requestUpdate={relation:'continue'};f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:true,meetingPeopleGroups:[['Daniel One']]};
 const b=await f.run({...opts,userMessage:'Thursday',typedUserMessage:'Thursday',rawUserMessage:'Thursday',conversationHistory:history});assert.deepEqual([...b.resolvedOptionalAttendees],['daniel.one@example.test']);
 f.state.meetingPeople=['Daniel One'];f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:true,meetingPeopleGroups:[['Daniel One']],participantRoles:[{name:'Daniel One',role:'required',quote:'Daniel One must attend'}]};
 const c=await f.run({...opts,userMessage:'Daniel One must attend',typedUserMessage:'Daniel One must attend',rawUserMessage:'Daniel One must attend',conversationHistory:[...history,{role:'user',content:'Thursday'},{role:'assistant',content:'Checking Thursday',meetingRequest:b.meetingRequest,toolSummaries:[]}]});assert.equal(c.resolvedOptionalAttendees.length,0);assert.ok(c.resolvedMeetingAttendees.includes('daniel.one@example.test'));
});

for(const labelled of [false,true])for(const omitSecond of [false,true])test('multiple mailboxes require a literal name mapping, not the order of an earlier question: '+labelled+' omitted='+omitSecond,async t=>{
 const f=setup(t,{rows:[rows[0]]}),names=['Tal','Alex','Daniel One'];
 f.state.meetingPeople=names;f.state.requestUpdate={relation:'new'};f.state.classifierExtras={meetingPeopleGroups:[names]};
 const first='Meet Tal, Alex and Daniel One',a=await f.run({userMessage:first,typedUserMessage:first,rawUserMessage:first});
 const q1=(labelled?'Tal ':'')+'<mailto:tal@outside.test|tal@outside.test>',q2=(labelled?'Alex ':'')+'<mailto:hello@outside.test|hello@outside.test>',text=q1+'\n'+q2;
 f.state.meetingPeople=omitSecond&&!labelled?[q1]:[q1,q2];f.state.requestUpdate={relation:'continue'};f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:true,meetingPeopleGroups:[names],participantCorrections:[{group:0,from:'Tal',to:'tal@outside.test',quote:q1},{group:0,from:labelled?'Alex':'Daniel One',to:'hello@outside.test',quote:q2}]};
 const r=await f.run({userMessage:text,typedUserMessage:text,rawUserMessage:text,conversationHistory:[{role:'user',content:first},{role:'assistant',content:'Which Tal and which Daniel?',toolSummaries:[],meetingRequest:a.meetingRequest}]});
 if(labelled){assert.ok(r.meetingRequest.participantBindings.some(b=>b.name==='Alex'&&b.identifier==='hello@outside.test'));assert.equal(r.resolvedMeetingAttendeeGroups.length,1);}
 else{assert.ok(!r.meetingRequest.participantBindings.some(b=>b.name==='Daniel One'&&b.identifier==='hello@outside.test'));assert.ok(r.meetingRequest.participantBindings.some(b=>b.name==='hello@outside.test'));assert.equal(r.resolvedMeetingAttendeeGroups.length,0);}
});
