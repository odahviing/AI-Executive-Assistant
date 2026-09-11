// Real orchestrator tool loop, outcome readers and ack classifier; isolated I/O.
// CODA_WORK_BEFORE_DIR selects the preserved orchestrator for fail-before replay.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const compiled = new Map();
const start = '2026-09-16T18:00:00+03:00', end = '2026-09-16T18:25:00+03:00';
const booking = { subject: 'Top Talk with Paul', start, end, attendees: [{ name: 'Paul', email: 'paul.k@reflectiz.com' }], category: 'Meeting' };
const success = { success: true, meetingId: 'event-paul', booked_start: start, booked_end: end };
const step = (name, args, result) => ({ name, args, result });
const create = (args = booking, result = success) => step('create_meeting', args, result);
const search = (args = { attendee_emails: ['paul.k@reflectiz.com'] }, result = { slots: [{ start, end }] }) => step('find_available_slots', args, result);
async function run(steps, options = {}) {
  const unexpected = [], executions = [], logs = [];
  let modelCalls = 0, classifierCalls = 0, pickerCalls = 0;
  const profile = { user: { name: 'Owner Person', slack_user_id: 'U_OWNER', timezone: 'Asia/Jerusalem' }, assistant: {} };
  const logger = Object.fromEntries(['info','warn','error','debug'].map(k => [k, (...args) => logs.push(args)]));
  function load(relative, deps) {
    const filename = relative === 'src/core/orchestrator/index.ts' && process.env.CODA_WORK_BEFORE_DIR
      ? path.resolve(process.env.CODA_WORK_BEFORE_DIR, 'index.before.ts') : path.join(root, relative);
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText);
    const exports = {};
    vm.runInNewContext(compiled.get(filename), { exports, require: name => {
      if (Object.hasOwn(deps, name)) return deps[name];
      unexpected.push(name); throw Error(`Forbidden dependency ${name}`);
    }, Date, Map, Set, structuredClone }, { filename });
    return exports;
  }
  const anthropic = { messages: { create: async () => { classifierCalls++; throw Error('Classifier must stay cheap'); } } };
  const classifier = load('src/core/social/classifyTurn.ts', {
    '../../utils/logger': logger, '../../utils/usageLog': { logLlmUsage() {} },
    '../../db/socialSubjects': { FIXED_CATEGORIES: [] }, '../../llm/models': { MODEL_HAIKU: 'fixture' },
  });
  const helpers = load('src/core/orchestrator/turnHelpers.ts', {
    'luxon': { DateTime }, '../../llm/client': { getAnthropicClient: () => anthropic },
    '../../utils/usageLog': { logLlmUsage() {} }, '../../utils/logger': logger,
    '../../utils/attendeeAvailability': { ATTENDEE_REASON_PREFIXES: [] },
  });
  let intent = { kind: options.kind ?? 'task', conversation_state: 'closing' };
  if (options.ack) intent = (await classifier.classifyTurn({ anthropic, message: options.ack, profile, needIntent: true, needScopes: true })).intent;
  if (intent.kind === 'social') intent.social = { sentiment: 'positive' };
  const deps = {
    'node:util': require('node:util'), 'luxon': { DateTime }, '../../utils/logger': logger,
    '../../utils/detectMessageLanguage': { detectMessageLanguage: () => 'English' },
    '../../skills/registry': { WRITE_TOOLS: new Set(['create_meeting','move_meeting','update_meeting','delete_meeting']),
      executeSkillTool: async (name, args, context) => {
        const next = steps[executions.length];
        assert.equal(name, next.name); executions.push({ name, args, context });
        return structuredClone(next.result);
      } },
    '../../db': { auditLog() {}, recordSocialMoment() {} },
    './turnHelpers': { ...helpers, callClaude: async () => {
      const next = steps[modelCalls++];
      return { stop_reason: next ? 'tool_use' : 'end_turn', content: next
        ? [{ type: 'tool_use', id: `tool-${modelCalls}`, name: next.name, input: structuredClone(next.args) }]
        : [{ type: 'text', text: options.reply ?? 'Booked successfully.' }] };
    } },
    './buildTurnContext': { buildTurnContext: async () => ({ messages: [], systemBlocks: [], tools: [], model: 'fixture', maxTokens: 100,
      turnSenderRole: options.role ?? 'colleague', turnPersonSlackId: options.role === 'owner' ? 'U_OWNER' : 'U_PERSON',
      socialActive: options.socialActive ?? true, socialClassification: intent, resolvedMeetingAttendees: [],
      availabilityPrecheckToolSummaries: [] }) },
    '../../utils/turnCache': { withTurnCache: fn => fn() },
    '../../utils/rateLimit': { checkAndRecord: () => ({ allowed: true }) },
    '../../utils/toolCallCache': { lookupRecentToolCall: () => null, recordToolCall() {} },
    '../../utils/offeredSlotsStash': { clearOfferedSlots() {} },
    '../../utils/threadEventLedger': { recordThreadEvent() {}, recordViewedThreadEvents() {}, forgetThreadEvent() {} },
    '../requests/maybeOpenInFlightMeetingRequest': { maybeOpenInFlightMeetingRequest() {} },
    '../requests/colleagueOofReengage': { maybeTrackColleagueOofDeadEnd: async () => {} },
    '../../utils/closeLoopOnOwnerHandled': { closeLoopOnOwnerHandled: async () => ({ scanned: false }) },
    '../social/logEngagement': { adjustRankFromColleagueResponse() {} },
    '../social/stateMachine': { directiveForProactiveSlot: () => {
      pickerCalls++; if (options.pickerUnavailable) throw Error('store unavailable');
      return { mode: 'raise_new', categoryLabel: 'music' };
    } },
  };
  const orchestrator = load('src/core/orchestrator/index.ts', deps);
  const role = options.role ?? 'colleague';
  const result = await orchestrator.runOrchestrator({ userMessage: options.ack ?? 'Book the meeting', conversationHistory: [],
    threadTs: 'T1', channelId: 'D1', userId: role === 'owner' ? 'U_OWNER' : 'U_PERSON', senderRole: role,
    channel: 'slack', authority: role, surface: options.room ? 'room' : `${role}_dm`, profile,
    isChannel: options.room, isMpim: options.mpim });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unexpected, []); assert.equal(executions.length, steps.length);
  assert.equal(classifierCalls, 0); assert.equal(modelCalls, steps.length + 1);
  return { result, pickerCalls, executions, logs };
}
async function coda(steps, expected, options) {
  const h = await run(steps, options);
  assert.equal(Boolean(h.result.socialCoda), expected);
  return h;
}
test('regression: offered slot then booking resolves work', () => coda([search(), create()], true));
test('regression: bare offered slots then booking resolves work', () => coda([search(undefined, [{ start, end }]), create()], true));
test('regression: offered slot for identified event then move resolves work', () => coda([
  search({ attendee_emails: ['paul.k@reflectiz.com'], moving_event_ids: ['event-paul'] }),
  step('move_meeting', { meeting_id: 'event-paul', new_start: start }, success),
], true));
test('regression: identified move with handler auto-filled attendees resolves work', () => coda([
  search({ moving_event_ids: ['event-paul'] }),
  step('move_meeting', { meeting_id: 'event-paul', new_start: start }, success),
], true));
test('regression: Sharon efficiency counter then confirmed original booking resolves work', () => coda([
  create(booking, { success: false, error: 'efficiency_counter', counter_offer: { requested_start: '2026-09-16T18:00', suggested_start: '2026-09-16T17:30' }, _deferred_action_hint: { tool: 'create_meeting', args: booking } }),
  create({ ...booking, keep_requested_time: true }),
], true));
test('regression: failed mutation then identical successful retry resolves work', () => coda([
  step('move_meeting', { meeting_id: 'event-paul', new_start: start }, { success: false, error: 'timeout' }),
  step('move_meeting', { meeting_id: 'event-paul', new_start: start }, success),
], true));
test('regression: cheap yes acknowledgement with completed booking earns coda', () => coda([create()], true, { ack: 'yes' }));
test('regression: cheap Hebrew acknowledgement with completed booking earns coda', () => coda([create()], true, { ack: 'כן' }));
test('regression: failed update mutation stays pending', () => coda([step('update_meeting', { meeting_id: 'event-paul' }, {})], false));
test('preserved: direct successful booking earns coda', () => coda([create()], true));
test('preserved: owner direct successful booking earns coda', () => coda([create()], true, { role: 'owner' }));
test('preserved: ack-only without executed work stays quiet', () => coda([], false, { ack: 'yes' }));
test('preserved: social continuation with memory work stays quiet', () => coda([step('note_about_person', { person_slack_id: 'U_PERSON', note: 'Music' }, { success: true })], false, { kind: 'social' }));
test('preserved: unrelated pending meeting survives another successful booking', () => coda([
  create({ ...booking, start: '2026-09-17T18:00:00+03:00' }, { success: false, error: 'busy' }), create(),
], false));
test('preserved: unrelated failed read survives successful booking', () => coda([step('get_calendar', {}, { error: 'unavailable' }), create()], false));
test('preserved: same tool different event remains pending', () => coda([
  step('move_meeting', { meeting_id: 'other-event', new_start: start }, { success: false }),
  step('move_meeting', { meeting_id: 'event-paul', new_start: start }, success),
], false));
test('preserved: offered move for different event remains pending', () => coda([
  search({ attendee_emails: ['paul.k@reflectiz.com'], moving_event_ids: ['other-event'] }),
  step('move_meeting', { meeting_id: 'event-paul', new_start: start }, success),
], false));
test('regression: new booking cannot clear identified pending move', () => coda([
  search({ attendee_emails: ['paul.k@reflectiz.com'], moving_event_ids: ['other-event'] }), create(),
], false));
test('preserved: one completed move cannot clear a multi-event search', () => coda([
  search({ attendee_emails: ['paul.k@reflectiz.com'], moving_event_ids: ['event-paul', 'other-event'] }),
  step('move_meeting', { meeting_id: 'event-paul', new_start: start }, success),
], false));
test('regression: every identified move completed resolves a multi-event search', () => coda([
  search({ attendee_emails: ['paul.k@reflectiz.com'], moving_event_ids: ['event-paul', 'other-event'] }),
  step('move_meeting', { meeting_id: 'event-paul', new_start: start }, success),
  step('move_meeting', { meeting_id: 'other-event', new_start: start }, { ...success, meetingId: 'other-event' }),
], true));
test('preserved: failed second move leaves multi-event search pending', () => coda([
  search({ attendee_emails: ['paul.k@reflectiz.com'], moving_event_ids: ['event-paul', 'other-event'] }),
  step('move_meeting', { meeting_id: 'event-paul', new_start: start }, success),
  step('move_meeting', { meeting_id: 'other-event', new_start: start }, { success: false, error: 'busy' }),
], false));
test('preserved: malformed move identity cannot become a new-booking search', () => coda([
  search({ attendee_emails: ['paul.k@reflectiz.com'], moving_event_ids: 'event-paul' }), create(),
], false));
test('preserved: failed mutation stays pending', () => coda([create(booking, { success: false, error: 'busy' })], false));
test('preserved: unresolved search stays pending', () => coda([search()], false));
test('preserved: empty search remains pending after unrelated booking', () => coda([search(undefined, []), create()], false));
test('preserved: different attendee search remains pending', () => coda([search({ attendee_emails: ['other@example.com'] }), create()], false));
test('preserved: unavailable attendee identity leaves search pending', () => coda([search({}), create()], false));
test('preserved: different offered instant stays pending', () => coda([search(undefined, { slots: [{ start: '2026-09-17T18:00:00+03:00', end }] }), create()], false));
test('preserved: current unresolved question suppresses coda', () => coda([create()], false, { reply: 'Booked. Which other meeting should move?' }));
test('preserved: room privacy suppresses personal coda', () => coda([create()], false, { room: true }));
test('preserved: MPIM privacy suppresses personal coda', () => coda([create()], false, { mpim: true }));
test('preserved: inactive social remains quiet', () => coda([create()], false, { socialActive: false }));
test('preserved: unavailable social store remains quiet', () => coda([create()], false, { pickerUnavailable: true }));
test('preserved limitation: declined semantic prose guard remains unchanged', () => coda([create()], true, { reply: 'Booked. Let me know if you want the other weekly moved too.' }));
