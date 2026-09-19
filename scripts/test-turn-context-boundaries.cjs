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
const actual = new Set(['src/core/orchestrator/buildTurnContext.ts', 'src/core/orchestrator/systemPrompt.ts', 'src/utils/skillPreferences.ts']);
const names = { UOWNER: 'Owner Example', UACTIVE: 'Active Person', UIDLE: 'Idle Roommate' };
function fixture(t) {
  const disk = fs.mkdtempSync(path.join(os.tmpdir(), 'maelle-context-boundary-'));
  t.after(() => fs.rmSync(disk, { recursive: true, force: true }));
  const profile = {
    user: { name: 'Owner Example', slack_user_id: 'UOWNER', email: 'owner@example.test', timezone: 'UTC', language: 'en' },
    assistant: { name: 'Maelle', persona: 'Fixture' }, skills: { summary: true },
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
    'src/core/social/classifyTurn.ts': { classifyTurn: async input => { state.classified.push(input); return { scope: { scopes: state.scopes }, meetingPeople: state.meetingPeople, freeTimeInquiry: false }; } },
    'src/core/social/stateMachine.ts': { noDirective: () => ({ mode: 'none' }), formatDirectiveForPromptBlock: () => '' },
    'src/skills/registry.ts': {
      getActiveSkills: () => [{ id: 'summary', name: 'summary', getSystemPromptSection: () => '' }],
      getSkillTools: (...args) => { state.toolCalls.push(args); return [{ name: 'update_my_preferences' }]; },
      WRITE_TOOLS: new Set(['update_my_preferences']),
    },
    'src/db.ts': {
      formatPreferencesCatalog: () => 'OWNER-DB-SECRET', formatPeopleMemoryForPrompt: () => 'OWNER-PEOPLE-SECRET',
      formatThreadPeopleBlock: () => 'COLLEAGUE-CONTACT', getPersonMemory: person,
      buildPersonWorkContextBlock: () => 'COLLEAGUE-WORK-SECRET', buildSocialContextBlock: () => 'COLLEAGUE-SOCIAL-SECRET',
      getSummarySessionByThread: () => null, getOutreachLifecycle: () => null,
      getDb: () => ({ prepare: () => ({ all: () => [] }) }),
    },
    'src/db/requests.ts': {
      getAwaitingOwnerRequests: () => [], getOpenRequestsForThread: () => [], getUnrelayedTerminalRequestForThread: () => null,
      getMeetingsRequestedBy: () => [],
    },
    'src/core/requests/types.ts': { parseDetails: () => null },
    'src/tasks.ts': { getActiveJobsForThread: () => ({ tasks: [], outreachJobs: [] }) },
    'src/core/orchestrator/turnHelpers.ts': { trimHistory: input => input, stampHistoryTime: text => text, extractActionTape: () => [] },
    'src/core/assistantSelf.ts': { formatAssistantSelfForPrompt: () => '' },
    'src/memory/peopleMemory.ts': { formatPeopleCatalogSync: () => 'OWNER-CATALOG-SECRET', readPersonMemorySync: () => 'SPEAKER-MEMORY-SECRET' },
    'src/utils/effectiveToday.ts': { getEffectiveToday: () => DateTime.utc(2026, 9, 19) },
    'src/utils/threadEventLedger.ts': { getThreadEvents: () => [], getViewedThreadEvents: () => [], getActivePlanningWindow: () => null },
    'src/utils/detectMessageLanguage.ts': { detectMessageLanguage: () => null },
    'src/utils/offeredSlotsStash.ts': { getOfferedSlots: () => [] },
    'src/utils/workingElsewhere.ts': { detectOwnerAwayDaysInWindow: () => new Map() },
    'src/utils/availabilityPreCheck.ts': { precheckAvailability: async () => ({ ran: false, verdicts: [] }) },
    'src/utils/attendeeAvailability.ts': { loadAttendeeAvailabilityForPerson: async () => ({}) },
    'src/connections/registry.ts': { listConnections: () => [] },
    'src/memory/resolveAttendeeEmails.ts': { resolveNamedInternalAttendees: ({ names }) => {
      state.resolverCalls.push(names);
      return { resolved: names.map(name => ({ name, email: `${name.replaceAll(' ', '.').toLowerCase()}@example.test` })), unresolved: [] };
    } },
  };
  const modules = new Map();
  function load(rel) {
    if (mocks[rel]) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel).exports;
    if (!actual.has(rel)) { state.unexpected.push(rel); throw new Error(`Unexpected dependency: ${rel}`); }
    const file = before && rel === 'src/core/orchestrator/buildTurnContext.ts' ? `${prefix}/before/buildTurnContext.ts` : rel;
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
  assert.equal(f.state.toolCalls.filter(args => args.length === 5).length, 2);
  assert.ok(f.state.toolCalls.filter(args => args.length === 5).every(args => args[1] === 'owner' && args[4] === 'owner'));
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
