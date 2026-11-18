// Actual buildTurnContext + systemPrompt + preference-store integration.
// Classifier, directory, DB, transport and unrelated services are isolated fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime } = require('luxon');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const prefix = 'artifacts/workshop-verification/slack-audit-20260919/handyman';
const actual = new Set(['src/utils/schedulingClockReply.ts','src/core/orchestrator/ownerSchedulingPrompt.ts','src/core/orchestrator/colleagueSchedulingPrompt.ts','src/core/orchestrator/buildTurnContext.ts', 'src/core/orchestrator/systemPrompt.ts', 'src/utils/skillPreferences.ts']);
const names = { UOWNER: 'Owner Example', UACTIVE: 'Active Person', UIDLE: 'Idle Roommate' };

function fixture(t) {
  const disk = fs.mkdtempSync(path.join(os.tmpdir(), 'maelle-context-boundary-'));
  t.after(() => fs.rmSync(disk, { recursive: true, force: true }));
  const profile = {
    user: { name: 'Owner Example', slack_user_id: 'UOWNER', email: 'owner@example.test', timezone: 'UTC', language: 'en' },
    assistant: { name: 'Maelle', persona: 'Fixture' }, skills: { summary: true },
    meetings: {allowed_durations:[10,25,40,55],default_meeting_duration:25},
    behavior: { intent_aware_tools: true },
    schedule: { office_days: { days: ['Monday'] }, home_days: { days: [] }, day_boundary_hour: 4 },
  };
  const state = { classified: [], meetingPeople: [], scopes: ['summary'], resolverCalls: [], toolCalls: [], unexpected: [] };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const person = id => ({ name: names[id], slack_id: id, person_id: id, email: `${id.toLowerCase()}@example.test`, timezone: 'UTC' });
  const mocks = {
    'src/utils/logger.ts': { __esModule: true, default: logger },
    'src/llm/client.ts': { getAnthropicClient: () => ({}) },
    'src/llm/models.ts': { MODEL_SONNET: 'fixture' },
    'src/core/social/classifyTurn.ts': { classifyTurn: async input => { state.classified.push(input); return { scope: { scopes: state.scopes }, meetingPeople: state.meetingPeople, freeTimeInquiry: false, standaloneCourtesy: state.standaloneCourtesy,requestUpdate:state.requestUpdate,ownerOutreachQuote:state.ownerOutreachQuote,...state.classifierExtras }; } },
    'src/core/social/stateMachine.ts': { noDirective: () => ({ mode: 'none' }), chooseSocialDirective: () => ({ mode: 'none' }), formatDirectiveForPromptBlock: () => '' },
    'src/skills/registry.ts': {
      getActiveSkills: () => [{ id: 'summary', name: 'summary', getSystemPromptSection: () => '' }],
      getSkillTools: (...args) => { state.toolCalls.push(args); return (state.toolNames??['update_my_preferences']).map(name=>({name})); },
      WRITE_TOOLS: new Set(['update_my_preferences','message_colleague','manage_calendar_issue','create_meeting','resolve_approval']),
    },
    'src/db.ts': {
      formatPreferencesCatalog: () => 'OWNER-DB-SECRET', formatPeopleMemoryForPrompt: () => 'OWNER-PEOPLE-SECRET',
      formatThreadPeopleBlock: () => 'COLLEAGUE-CONTACT', getPersonMemory: person,
      authoritativeGender: () => 'unknown', // fixture rows carry no gender; real people.ts reads that as unknown
      buildPersonWorkContextBlock: () => 'COLLEAGUE-WORK-SECRET', buildSocialContextBlock: () => 'COLLEAGUE-SOCIAL-SECRET',
      getSummarySessionByThread: () => null, getOutreachLifecycle: () => null,
      getDb: () => ({ prepare: () => ({ all: () => [] }) }),
    },
    'src/db/requests.ts': {
      getAwaitingOwnerRequests: () => state.pending ?? [], getOpenRequestsForThread: () => [], getUnrelayedTerminalRequestForThread: () => null,
      getMeetingsRequestedBy: () => [],
    },
    'src/core/requests/types.ts': { parseDetails: row => row?.details_json ? JSON.parse(row.details_json) : null },
    'src/core/approvals/approvalCallbacks.ts': { extractCallbacks: details => ({on_approve:details?.deferred_action}),mergeAmendIntoApprove: action=>action },
    'src/utils/closeLoopOnOwnerHandled.ts': {getMatchingRequestReferences:(text,row)=>text.includes(row.subject)?[row.subject]:[]},
    'src/tasks.ts': { getActiveJobsForThread: () => ({ tasks: [], outreachJobs: [] }) },
    'src/core/orchestrator/turnHelpers.ts': { trimHistory: input => input, stampHistoryTime: text => text, extractActionTape: () => [] },
    'src/core/assistantSelf.ts': { formatAssistantSelfForPrompt: () => '' },
    'src/memory/peopleMemory.ts': { formatPeopleCatalogSync: () => 'OWNER-CATALOG-SECRET', readPersonMemorySync: () => 'SPEAKER-MEMORY-SECRET' },
    'src/utils/effectiveToday.ts': { getEffectiveToday: () => DateTime.utc(2026, 9, 19) },
    'src/utils/threadEventLedger.ts': { getThreadEvents: () => [], getViewedThreadEvents: () => state.viewedEvents??[], getActivePlanningWindow: () => null },
    'src/utils/detectMessageLanguage.ts': { detectMessageLanguage: () => null },
    'src/utils/offeredSlotsStash.ts': { getOfferedSlots: () => state.offeredSlots ?? [] },
    'src/db/slotHolds.ts': { MAX_HOLDS_PER_MEETING: 2, MAX_HOLDS_PER_HOLDER: 3, getActiveSlotHolds: () => [] },
    'src/core/orchestrator/requesterMeetingState.ts': { requesterMeetingState: () => ({approvals:[], holds:[]}) },
    'src/utils/workingElsewhere.ts': { detectOwnerAwayDaysInWindow: () => new Map() },
    'src/utils/availabilityPreCheck.ts': { precheckAvailability: async () => ({ ran: false, verdicts: [] }) },
    'src/utils/attendeeAvailability.ts': { loadAttendeeAvailabilityForPerson: async () => ({}) },
    'src/connections/registry.ts': { listConnections: () => [] },
    'src/memory/resolveAttendeeEmails.ts': { nameGenuinelyMatches:(full,email,name)=>[full,email].some(value=>value?.toLowerCase()===name.toLowerCase()), resolveNamedInternalAttendees: ({ names }) => {
      state.resolverCalls.push(names);
      return { resolved: names.map(name => ({ name, email: `${name.replaceAll(' ', '.').toLowerCase()}@example.test` })), unresolved: [] };
    } },
  };
  const modules = new Map();
  function load(rel) {
    if (mocks[rel]) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel).exports;
    if (!actual.has(rel)) { state.unexpected.push(rel); throw new Error(`Unexpected dependency: ${rel}`); }
    const file = process.env?.CONTEXT_SOURCE_ROOT && rel === 'src/core/orchestrator/buildTurnContext.ts'
      ? path.join(process.env.CONTEXT_SOURCE_ROOT,rel)
      : before && rel === 'src/core/orchestrator/buildTurnContext.ts' ? `${prefix}/before/buildTurnContext.ts` : rel;
    const mod = { exports: {} }; modules.set(rel, mod);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const req = spec => spec.startsWith('.') ? load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) + '.ts') : require(spec);
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Date, Set, Map, Buffer, Intl, process: { cwd: () => disk } }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  const prefsDir = path.join(disk, 'config/users/owner_prefs');
  fs.mkdirSync(prefsDir, { recursive: true });
  fs.writeFileSync(path.join(prefsDir, 'general.md'), 'OWNER-GENERAL-PREFERENCE');
  fs.writeFileSync(path.join(prefsDir, 'summary.md'), 'OWNER-SUMMARY-PREFERENCE');
  return { state, profile, async run(overrides = {}) {
    const result = await load('src/core/orchestrator/buildTurnContext.ts').buildTurnContext({
      userMessage: 'Please summarize this.', conversationHistory: [], threadTs: 'T1', channelId: 'D1',
      userId: 'UOWNER', senderRole: 'owner', authority: 'owner', surface: 'owner_dm', channel: 'slack', profile,
      ...overrides,
    });
    assert.deepEqual(state.unexpected, [], 'every fixture dependency explicitly declared');
    return { ...result, prompt: result.systemBlocks.map(b => b.text).join('\n') };
  } };
}

test('room framing cannot promote an idle member to deterministic meeting attendee', async t => {
  const f = fixture(t); f.state.meetingPeople = ['Idle Roommate'];
  const r = await f.run({ userMessage: '<<ROOM MEMBERS: Idle Roommate>>\nArrange a meeting for us.', rawUserMessage: 'Arrange a meeting for us.', isMpim: true, senderRole: 'colleague', authority: 'owner', surface: 'room', isOwnerInGroup: true, mpimMemberIds: ['UOWNER','UACTIVE','UIDLE'], threadParticipantIds: ['UOWNER','UACTIVE'] });
  assert.equal(r.resolvedMeetingAttendees.length, 0);
  assert.equal(f.state.resolverCalls.length, 0);
});

for(const operations of [['move'],['move','create']])test('colleague intent bounds each calendar operation '+operations.join(','),async t=>{
 const f=fixture(t),text='Move the planning event'+(operations.length>1?' and book the lunch':'');
 f.state.scopes=['meetings'];f.state.toolNames=['create_meeting','move_meeting','find_available_slots','create_approval'];
 f.state.classifierExtras={meetingAction:'execute',calendarOperations:operations.map(operation=>({operation,quote:text}))};
 const r=await f.run({userMessage:text,typedUserMessage:text,rawUserMessage:text,senderRole:'colleague',authority:'colleague',userId:'UACTIVE',surface:'colleague_dm'});
 assert.equal(r.tools.some(t=>t.name==='create_meeting'),operations.includes('create'));
 assert.equal(r.blockedWriteTools.has('create_meeting'),!operations.includes('create'));
 assert.ok(r.tools.some(t=>t.name==='move_meeting'));assert.ok(r.tools.some(t=>t.name==='create_approval'));
});

for(const scopes of [['knowledge','general'],['tasks'],['general']])test('private owner work uses current-task instructions without the unrelated skill manual: '+scopes,async t=>{
 const f=fixture(t);f.state.scopes=scopes;const r=await f.run({userMessage:'Please revise this draft and show it.',typedUserMessage:'Please revise this draft and show it.'});
 assert.ok(r.systemBlocks[0].text.includes('current work'));
 assert.ok(r.systemBlocks[0].text.length<14000);
 assert.ok(r.prompt.includes('OWNER-DB-SECRET'),'authorized owner facts remain available');
});

for(const attributed of [false,true])test('owner changes to a pending request retain its resolver '+attributed,async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.state.toolNames=['resolve_approval','create_meeting','find_available_slots'];
 const subject='Customer review with Alpha',text='Find a time ending before 17:00';
 f.state.pending=[{id:'req_alpha',kind:'approval',state:'awaiting_owner',owner_user_id:'UOWNER',subject,
  details_json:JSON.stringify({deferred_action:{tool:'create_meeting',args:{subject,start:'2026-11-19T17:00:00Z',end:'2026-11-19T17:55:00Z'}}})}];
 f.state.classifierExtras={meetingAction:'explore',participantsUnchanged:true,approvalDecisions:attributed?[{
  candidateIndex:0,disposition:'amend_or_search',instructionQuote:text,sourceMessageIndex:0,sourceQuote:subject}]:[]};
 const result=await f.run({userMessage:text,rawUserMessage:text,typedUserMessage:text,conversationHistory:[{role:'assistant',content:subject}]});
 assert.equal(result.tools.some(t=>t.name==='resolve_approval'),attributed);
 assert.equal(result.blockedWriteTools.has('resolve_approval'),!attributed);
 assert.equal(result.tools.some(t=>t.name==='create_meeting'),false,'a counter on tracked work grants no unrelated new invitation');
 assert.equal(result.tools.some(t=>t.name==='find_available_slots'),true);
});

test('the owner retains later observed event dates beyond the full-ID prompt selection',async t=>{
 const f=fixture(t);f.state.scopes=['calendar'];f.state.viewedEvents=Array.from({length:35},(_,i)=>({eventId:'long-id-'+i,subject:'Meeting '+i,dateIso:'2026-11-'+(i<20?'16':'18')}));
 const r=await f.run({userMessage:'Lunch before meeting 34'});assert.match(r.prompt,/2026-11-18: Meeting 34/);assert.ok(!r.prompt.includes('long-id-34'));
 const c=await f.run({userId:'UACTIVE',senderRole:'colleague',authority:'colleague',surface:'colleague_dm'});assert.ok(!c.prompt.includes('Meeting 34'));
});
test('explicitly named person outside current thread remains a legitimate requested attendee', async t => {
  const f = fixture(t); f.state.meetingPeople = ['Idle Roommate'];
  const r = await f.run({ userMessage: '<<ROOM MEMBERS: Idle Roommate>>\nInclude Idle Roommate.', rawUserMessage: 'Include Idle Roommate.' });
  assert.deepEqual(Array.from(r.resolvedMeetingAttendees), ['idle.roommate@example.test']);
});
test('non-Slack caller without raw field preserves named attendee resolution', async t => {
  const f = fixture(t); f.state.meetingPeople = ['Active Person'];
  const r = await f.run({ userMessage: 'Meet Active Person.', channel: 'email' });
  assert.deepEqual(Array.from(r.resolvedMeetingAttendees), ['active.person@example.test']);
});
test('observed thread roster reaches actual prompt without copying idle room members', async t => {
  const f = fixture(t);
  const r = await f.run({ isMpim: true, senderRole: 'colleague', authority: 'owner', surface: 'room', isOwnerInGroup: true, mpimMemberIds: ['UOWNER','UACTIVE','UIDLE'], threadParticipantIds: ['UOWNER','UACTIVE'] });
  const observed = r.prompt.split('\n').find(line => line.includes('OBSERVED THREAD PARTICIPANTS'));
  assert.ok(observed?.includes('Active Person'));
  assert.ok(!observed.includes('Idle Roommate'));
  assert.ok(r.prompt.includes('ROOM MEMBERS'));
  assert.ok(r.prompt.includes('Idle Roommate'));
});
test('owner DM gets freshly scoped private memory through real turn builder', async t => {
  const f = fixture(t); const r = await f.run();
  for (const sentinel of ['OWNER-GENERAL-PREFERENCE','OWNER-SUMMARY-PREFERENCE','OWNER-DB-SECRET','OWNER-PEOPLE-SECRET']) assert.ok(r.prompt.includes(sentinel), sentinel);
  // Base capabilities, intent-filtered tools and the final tool selection all
  // retain the authenticated private-owner scope.
  assert.equal(f.state.toolCalls.filter(args => args.length === 5).length, 3);
  assert.ok(f.state.toolCalls.filter(args => args.length === 5).every(args => args[1] === 'owner' && args[4] === 'owner'));
});

test('calendar instructions are selected even when intent-aware tool narrowing is disabled',async t=>{
 const f=fixture(t);f.profile.behavior.intent_aware_tools=false;
 f.state.classifierExtras={scope:{scopes:['calendar'],source:'classifier'},meetingAction:'none'};
 const r=await f.run({userMessage:'All meetings'});
 assert.equal(f.state.classified[0].needScopes,true);
 assert.ok(r.ownerSettings);
 assert.match(r.systemBlocks[0].text,/speaking privately with the calendar owner/);
 assert.ok(f.state.toolCalls.slice(-2).every(args=>args[2]===undefined),'actual tool selection and role capabilities remain unfiltered');
});
for(const scopes of [['summary'],['summary','general']])test('an unrelated current task leaves the scheduling prompt despite prior meeting state: '+scopes.join(','),async t=>{
 const f=fixture(t);f.state.classifierExtras={scope:{scopes,source:'classifier'}};
 f.state.requestUpdate={relation:'continue'};
 const prior={requestId:'r',ownerId:'UOWNER',requesterId:'UOWNER',channelId:'D1',threadTs:'T1',original:'Book a meeting',updates:[]};
 const text='Now summarize the interview';
 const r=await f.run({userMessage:text,typedUserMessage:text,rawUserMessage:text,
  conversationHistory:[{role:'assistant',content:'Meeting booked.',meetingRequest:prior,toolSummaries:[]}]});
 assert.equal(r.ownerSettings,undefined);
 assert.ok(r.prompt.includes('OWNER-SUMMARY-PREFERENCE'));
 assert.ok(!r.systemBlocks[0].text.includes('speaking privately with the calendar owner'));
});

test('accepting an open issue after a completed action permits issue resolution but not repeating the action',async t=>{
 const f=fixture(t); f.profile.skills.social=true; f.state.scopes=['calendar']; f.state.toolNames=['update_my_preferences','manage_calendar_issue'];
 f.state.classifierExtras={intent:{kind:'other',conversation_state:'open'},meetingAction:'none'};
 const r=await f.run({userMessage:'Its ok',typedUserMessage:'Its ok',rawUserMessage:'Its ok',conversationHistory:[
  {role:'assistant',content:'[update_my_preferences OK]\nThe preference was saved. The calendar overlap remains unresolved. Is it okay?'}]});
 assert.ok(r.tools.some(t=>t.name==='manage_calendar_issue'));
 assert.ok(!r.tools.some(t=>t.name==='update_my_preferences'));
});

test('image blocks and their caption reach the current core turn together', async t => {
  const f = fixture(t);
  const images = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture-pixels' } }];
  const r = await f.run({ userMessage: 'מה כתוב כאן?', images });
  const current = r.messages.at(-1);
  assert.equal(current.role, 'user');
  assert.equal(current.content[0].source.data, 'fixture-pixels');
  assert.equal(current.content[1].text, 'מה כתוב כאן?');
});

test('voice transcript remains source-language text in the core turn', async t => {
  const f = fixture(t);
  const r = await f.run({ userMessage: 'Проверь мой календарь на завтра.' });
  assert.equal(r.messages.at(-1).content, 'Проверь мой календарь на завтра.');
});
for (const [name, input] of [
  ['owner MPIM', { isMpim: true, isOwnerInGroup: true, userId: 'UOWNER', authority: 'owner' }],
  ['owner channel', { isChannel: true, userId: 'UOWNER', authority: 'owner' }],
  ['colleague MPIM', { isMpim: true, userId: 'UACTIVE', authority: 'colleague' }],
  ['colleague channel', { isChannel: true, userId: 'UACTIVE', authority: 'colleague' }],
]) {
  test(`${name} withholds private memory and preserves supplied authority`, async t => {
    const f = fixture(t); const r = await f.run({ ...input, senderRole: 'colleague', surface: 'room', channelId: 'C1' });
    for (const secret of ['OWNER-GENERAL-PREFERENCE','OWNER-SUMMARY-PREFERENCE','OWNER-DB-SECRET','OWNER-PEOPLE-SECRET','COLLEAGUE-WORK-SECRET','COLLEAGUE-SOCIAL-SECRET','SPEAKER-MEMORY-SECRET']) assert.ok(!r.prompt.includes(secret), secret);
    assert.ok(f.state.toolCalls.every(args => args[1] === 'colleague' && args[4] === input.authority));
  });
}
test('colleague DM retains own work and speaker memory while withholding owner preferences', async t => {
  const f = fixture(t); const r = await f.run({ userId: 'UACTIVE', senderRole: 'colleague', authority: 'colleague', surface: 'colleague_dm' });
  assert.ok(r.prompt.includes('COLLEAGUE-WORK-SECRET'));
  assert.ok(r.prompt.includes('SPEAKER-MEMORY-SECRET'));
  assert.ok(!r.prompt.includes('OWNER-GENERAL-PREFERENCE'));
});
test('room caller missing raw human text never treats framing as a named request', async t => {
  const f = fixture(t); f.state.meetingPeople = ['Idle Roommate'];
  const r = await f.run({ userMessage: '<<ROOM MEMBERS: Idle Roommate>>\nArrange a meeting.', isMpim: true, senderRole: 'colleague', surface: 'room' });
  assert.equal(r.resolvedMeetingAttendees.length, 0);
});
test('unavailable observed roster does not invent room members as thread participants', async t => {
  const f = fixture(t);
  const r = await f.run({ isMpim: true, senderRole: 'colleague', surface: 'room', userId: 'UACTIVE', authority: 'colleague', mpimMemberIds: ['UOWNER','UACTIVE','UIDLE'] });
  const observed = r.prompt.split('\n').find(line => line.includes('OBSERVED THREAD PARTICIPANTS'));
  assert.ok(observed?.includes('Active Person'));
  assert.ok(!observed.includes('Idle Roommate'));
});
test('real turn builder recalculates preference scope each turn', async t => {
  const f = fixture(t); const first = await f.run();
  assert.ok(first.prompt.includes('OWNER-SUMMARY-PREFERENCE'));
  f.state.scopes = ['meetings']; const second = await f.run({ userMessage: 'Find a meeting time.' });
  assert.ok(!second.prompt.includes('OWNER-SUMMARY-PREFERENCE'));
  assert.ok(second.prompt.includes('OWNER-GENERAL-PREFERENCE'));
});

for (const [name, message, positive, overrides, isolated] of [
  ['greeting', 'hello', true, {}, true],
  ['closing thanks', 'thans', true, { senderRole: 'colleague', authority: 'colleague', surface: 'colleague_dm' }, true],
  ['classifier unavailable', 'hello', undefined, {}, false],
  ['decision', 'yes', false, {}, false],
  ['mixed request', 'thanks, book it', false, {}, false],
  ['status question', 'is it booked?', false, {}, false],
  ['forced workflow', 'hello', true, { forceToolOnFirstTurn: { name: 'summary' } }, false],
  ['retry', 'thanks', true, { extraInstruction: 'Retry a failed read' }, false],
  ['attachment', 'hello', true, { images: [{ type: 'image' }] }, false],
  ['room', 'hello', true, { isChannel: true, surface: 'room' }, false],
]) test('courtesy context: ' + name, async t => {
  const f = fixture(t);
  f.state.standaloneCourtesy = positive;
  const r = await f.run({ userMessage: message, rawUserMessage: message,
    conversationHistory: [{ role: 'assistant', content: 'Historical booking detail', ts: '1' }], ...overrides });
  assert.equal(r.messages.some(m => m.content === 'Historical booking detail'), !isolated);
  if (isolated) {
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].content, message);
    assert.equal(r.tools.length, 0);
    assert.equal(f.state.toolCalls.length, 0);
    assert.doesNotMatch(r.prompt, /OWNER-DB-SECRET|Historical booking detail/);
  }
});

for (const [label,overrides,exposed] of [
 ['owner DM',{},true],
 ['colleague DM',{userId:'UACTIVE',senderRole:'colleague',authority:'colleague',surface:'colleague_dm'},false],
 ['owner room',{userId:'UOWNER',senderRole:'colleague',authority:'owner',surface:'room',isChannel:true,channelId:'C1'},false],
]) test(label+' scopes scheduling settings as private owner facts',async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.state.requestUpdate={relation:'new'};
 f.profile.meetings={packing_preference:'dense',office_location:{short_label:'PRIVATE-OFFICE'},room_email:'room@example.test',allowed_durations:[25,40]};
 const message='Find a meeting time.';
 const r=await f.run({userMessage:message,rawUserMessage:message,typedUserMessage:message,...overrides});
 assert.equal(r.prompt.includes('PRIVATE-OFFICE'),exposed);
 assert.equal(r.ownerSettings?.meeting_rules?.packing_preference,exposed?'dense':undefined);
 assert.equal(r.ownerSettings?.meeting_rules?.room_email,exposed?'room@example.test':undefined);
});
test('the explored day survives a clock-only follow-up and resets for another meeting',async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];
 f.profile.meetings={allowed_durations:[25,40]};
 f.state.requestUpdate={relation:'new',searchDay:{date:'2026-11-24',quote:'Tuesday 24.11'}};
 const first='What about Tuesday 24.11?';
 const a=await f.run({userMessage:first,rawUserMessage:first,typedUserMessage:first});
 assert.equal(a.meetingRequest.searchDay.date,'2026-11-24');assert.equal(a.meetingRequest.requiredDay,undefined);
 f.state.requestUpdate={relation:'continue'};
 const next='What about 16:00?';
 const history=[{role:'user',content:first},{role:'assistant',content:'What time on Tuesday?',toolSummaries:[],meetingRequest:a.meetingRequest}];
 const b=await f.run({userMessage:next,rawUserMessage:next,typedUserMessage:next,conversationHistory:history});
 assert.equal(b.meetingRequest.searchDay.date,'2026-11-24');assert.match(b.prompt,/Latest day the human is exploring/);
 f.state.requestUpdate={relation:'new'};
 const c=await f.run({userMessage:next,rawUserMessage:next,typedUserMessage:next,conversationHistory:history});
 assert.equal(c.meetingRequest.searchDay,undefined);
});
test('an owner bare clock is anchored to the owner zone before any calendar write',async t=>{
 const f=fixture(t);f.profile.user.timezone='America/New_York';
 const text='16:45';
 const r=await f.run({userMessage:text,rawUserMessage:text,typedUserMessage:text});
 assert.equal(r.exactRequestClock.clock,'16:45');assert.equal(r.exactRequestClock.zone,'America/New_York');
 const room=await f.run({userMessage:text,rawUserMessage:text,typedUserMessage:text,surface:'room',isChannel:true,channelId:'C1'});
 assert.equal(room.exactRequestClock,undefined);
});

for(const permitted of [false,true])test('separate owner outreach needs its own instruction: '+permitted,async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.state.requestUpdate={relation:'new'};
 f.state.toolNames=['find_available_slots','message_colleague'];
 const text=permitted?'Ask Alex which time works':'Find times with Alex';
 f.state.ownerOutreachQuote=permitted?text:undefined;
 const result=await f.run({userMessage:text,rawUserMessage:text,typedUserMessage:text});
 assert.equal(result.tools.some(tool=>tool.name==='message_colleague'),permitted);
 assert.equal(result.blockedWriteTools.has('message_colleague'),!permitted);
 assert.ok(result.supportedOperations.includes('message_colleague'));
});

for (const nextDay of ['flexible','2026-11-25']) test('a new requested search window supersedes a stale deadline '+nextDay,async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.profile.meetings={allowed_durations:[25,40]};
 const first='It must be Tuesday 24.11';f.state.requestUpdate={relation:'new',dayChange:{date:'2026-11-24',quote:first}};
 const a=await f.run({userMessage:first,rawUserMessage:first,typedUserMessage:first});assert.equal(a.meetingRequest.requiredDay.date,'2026-11-24');
 const next='Try a different window';f.state.requestUpdate={relation:'continue',searchDay:{date:nextDay,quote:next}};
 const history=[{role:'user',content:first},{role:'assistant',content:'Tuesday was checked.',toolSummaries:[],meetingRequest:a.meetingRequest}];
 const b=await f.run({userMessage:next,rawUserMessage:next,typedUserMessage:next,conversationHistory:history});assert.equal(b.meetingRequest.requiredDay,undefined);
 f.state.requestUpdate={relation:'continue',searchDay:{date:nextDay,quote:'invented source'}};
 const c=await f.run({userMessage:next,rawUserMessage:next,typedUserMessage:next,conversationHistory:history});assert.equal(c.meetingRequest.requiredDay.date,'2026-11-24');
});

for(const booked of [false,true])test('unfinished booking intent survives midnight; completed intent does not '+booked,async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.state.requestUpdate={relation:'continue'};
 const instruction={kind:'exact',text:'Book the planning meeting tomorrow at 13:30',localDate:'2000-01-01'};
 const prior={requestId:'r',ownerId:'UOWNER',requesterId:'UOWNER',channelId:'D1',threadTs:'T1',original:instruction.text,
  updates:[],bookingInstruction:instruction,hasConfirmedBooking:booked};
 const text='25 minutes, topic: planning';
 await f.run({userMessage:text,typedUserMessage:text,rawUserMessage:text,conversationHistory:[{role:'assistant',content:'The request is pending.',toolSummaries:[],meetingRequest:prior}]});
 assert.deepEqual(f.state.classified.at(-1).priorMeetingRequest.bookingInstruction,booked?undefined:instruction);
});

for(const booked of [false,true])test('planner receives durable request identity and prior booking evidence '+booked,async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.state.requestUpdate={relation:'continue'};
 const prior={requestId:'same-request',ownerId:'UOWNER',requesterId:'UOWNER',channelId:'D1',threadTs:'T1',original:'Book Alex',updates:[],hasConfirmedBooking:booked};
 const text='Include me too';const r=await f.run({userMessage:text,typedUserMessage:text,rawUserMessage:text,conversationHistory:[{role:'assistant',content:'The request is pending.',toolSummaries:[],meetingRequest:prior}]});
 assert.ok(r.prompt.includes('"meetingRequestId":"same-request"'));assert.ok(r.prompt.includes('"priorBookingConfirmed":'+booked));
});

for(const [text,booked,offered,allows] of [['16:45',false,true,true],['16:45?',false,true,false],['16:45',true,true,false],['16:45',false,false,false]])test('clock selection keeps a source-bound owner instruction '+JSON.stringify([text,booked,offered]),async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.state.toolNames=['create_meeting','message_colleague'];
 f.state.requestUpdate={relation:'continue'};f.state.classifierExtras={meetingAction:'explore',meetingContinuation:true};
 const prior={requestId:'r',ownerId:'UOWNER',requesterId:'UOWNER',channelId:'D1',threadTs:'T1',original:'Book Alex',updates:[],hasConfirmedBooking:booked};
 const r=await f.run({userMessage:text,typedUserMessage:text,rawUserMessage:text,conversationHistory:[{role:'assistant',content:'Which opening?',meetingRequest:prior,toolSummaries:offered?['[find_available_slots 2026-12-03 dur=25m → 2 slots]']:[]}]});
 assert.equal(r.tools.some(t=>t.name==='create_meeting'),allows);assert.equal(r.tools.some(t=>t.name==='message_colleague'),false);
 assert.equal(r.exactBookingRequested,allows);
});
