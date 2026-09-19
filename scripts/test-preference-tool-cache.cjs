// Real orchestrator/cache -> actual assistant handler -> isolated preference files.
// Only model, unrelated skills/services and turn-context setup are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const evidence = 'artifacts/workshop-verification/memory-slack-20260919/handyman';
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const cachePath = before ? `${evidence}/before/toolCallCache.ts` : 'src/utils/toolCallCache.ts';
const loopPath = before ? `${evidence}/before/orchestrator.ts` : 'src/core/orchestrator/index.ts';
const helpersPath = before ? `${evidence}/before/turnHelpers.ts` : 'src/core/orchestrator/turnHelpers.ts';
const registryPath = before ? `${evidence}/before/registry.ts` : 'src/skills/registry.ts';

function compile(text, deps, filename, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    exports, Date, Map, Set, structuredClone, Buffer,
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name];
      throw new Error(`Unexpected dependency ${name} in ${filename}`);
    }, ...globals,
  }, { filename });
  return exports;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maelle-preference-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prefs = compile(source('src/utils/skillPreferences.ts'), {
    fs, path, crypto: require('node:crypto'), './logger': logger,
  }, 'skillPreferences.ts', { process: { cwd: () => dir } });
  let now = Date.now();
  const cache = compile(source(cachePath) + '\nexport const cacheSizeForFixture = () => cache.size;', {
    crypto: require('node:crypto'), './logger': logger,
  }, cachePath, { Date: { now: () => now } });
  const tree = ts.createSourceFile('assistant.ts', source('src/core/assistant.ts'), ts.ScriptTarget.Latest, true);
  let method;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === 'executeToolCall') method = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(method);
  const handler = compile(`export class Handler { ${method} }`, {}, 'assistant-handler.ts', {
    ...prefs, logger,
  });
  const assistant = new handler.Handler();
  const registryTree = ts.createSourceFile(registryPath, source(registryPath), ts.ScriptTarget.Latest, true);
  const approvedNodes = registryTree.statements.filter(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'executeApprovedSkillTool'
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(registryTree) === 'WRITE_TOOLS'));
  assert.equal(approvedNodes.length, 2);
  let approvedExecutions = 0;
  const approved = compile(approvedNodes.map(n => n.getText(registryTree)).join('\n'), {}, 'approved-wrapper.ts', {
    executeSkillTool: async (...args) => { approvedExecutions++; return assistant.executeToolCall(...args); },
  });
  const helpers = compile(source(helpersPath), {
    luxon: { DateTime }, '../../llm/client': { getAnthropicClient: () => ({}) },
    '../../utils/usageLog': { logLlmUsage() {} }, '../../utils/logger': logger,
    '../../utils/attendeeAvailability': { ATTENDEE_REASON_PREFIXES: [] },
  }, helpersPath);
  const status = compile(source('src/utils/toolStatusText.ts'), {}, 'toolStatusText.ts');
  const profile = { user: { name: 'Fixture Owner', slack_user_id: 'U_OWNER', email: 'owner@example.test', timezone: 'Asia/Jerusalem' }, assistant: { slack: { bot_token: 'fixture' } } };
  let currentStep;
  let modelCall;
  let execution = 0;
  let delivered;
  let output;
  let writeBoundary = 0;
  const statuses = [];
  let nextOtherResult = { ok: true };
  const orchestrator = compile(source(loopPath), {
    'node:util': require('node:util'), luxon: { DateTime }, '../../utils/logger': logger,
    '../../utils/detectMessageLanguage': { detectMessageLanguage: () => 'English' },
    '../../skills/registry': {
      WRITE_TOOLS: new Set(['update_my_preferences', 'message_colleague']),
      executeSkillTool: async (name, args, context) => {
        execution++;
        return name === 'update_my_preferences' ? assistant.executeToolCall(name, args, context) : structuredClone(nextOtherResult);
      },
    },
    '../../db': { auditLog() {}, recordSocialMoment() {} },
    './turnHelpers': {
      ...helpers,
      callClaude: async params => {
        if (modelCall++ === 0) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-1', name: currentStep.name, input: currentStep.args }] };
        // Capture the payload actually returned to the model, including cache hits.
        const results = params.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result');
        delivered = JSON.parse(results.at(-1).content);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixture done.' }] };
      },
    },
    './buildTurnContext': { buildTurnContext: async input => ({
      messages: [], systemBlocks: [], tools: [], model: 'fixture', maxTokens: 100,
      turnSenderRole: input.senderRole, turnPersonSlackId: input.userId, socialActive: false,
      socialClassification: { kind: 'task', conversation_state: 'closing' },
      resolvedMeetingAttendees: [], availabilityPrecheckToolSummaries: [],
    }) },
    '../../utils/turnCache': { withTurnCache: fn => fn() },
    '../../utils/rateLimit': { checkAndRecord: () => ({ allowed: true }) },
    '../../utils/toolCallCache': cache,
    '../../utils/toolStatusText': status,
    '../../connections/slack/messaging': { setAssistantStatus: async (_app, _token, input) => statuses.push(input.status) },
    '../../utils/offeredSlotsStash': { clearOfferedSlots() {} },
    '../../utils/threadEventLedger': { recordThreadEvent() {}, recordViewedThreadEvents() {}, forgetThreadEvent() {} },
    '../requests/maybeOpenInFlightMeetingRequest': { maybeOpenInFlightMeetingRequest() {} },
    '../requests/colleagueOofReengage': { maybeTrackColleagueOofDeadEnd: async () => {} },
    '../../utils/closeLoopOnOwnerHandled': { closeLoopOnOwnerHandled: async () => ({ scanned: false }) },
    '../social/logEngagement': { adjustRankFromColleagueResponse() {} },
    '../social/stateMachine': { directiveForProactiveSlot: () => ({ mode: 'none' }) },
  }, loopPath);
  return {
    dir, prefs, profile, cache, statuses, executions: () => execution,
    writeBoundary: () => writeBoundary, output: () => output,
    approvedExecutions: () => approvedExecutions,
    approved: args => approved.executeApprovedSkillTool('update_my_preferences', args, {
      userId: 'U_OWNER', authority: 'owner', senderRole: 'owner', surface: 'owner_dm', channel: 'slack',
      channelId: 'D1', threadTs: 'T1', profile,
    }),
    advance(ms) { now += ms; },
    otherResult(value) { nextOtherResult = value; },
    snapshot: () => prefs.readSkillPreferencesSnapshot(profile, 'summary'),
    async call(args, overrides = {}, name = 'update_my_preferences') {
      currentStep = { args, name }; modelCall = 0; delivered = undefined;
      output = await orchestrator.runOrchestrator({
        userMessage: 'Fixture preference edit', conversationHistory: [], threadTs: 'T1', channelId: 'D1',
        userId: 'U_OWNER', senderRole: 'owner', authority: 'owner', surface: 'owner_dm', channel: 'slack', profile,
        app: {}, onWriteExecuted: () => writeBoundary++,
        ...overrides,
      });
      assert.ok(delivered, 'tool result returned to model');
      return delivered;
    },
  };
}
const read = { skill: 'summary', mode: 'read' };
const add = text => ({ skill: 'summary', mode: 'add', text });
const replace = (text, expected_revision) => ({ skill: 'summary', mode: 'replace', text, expected_revision });

test('fresh read observes intervening replacement and revision', async t => {
  const f = fixture(t);
  const first = await f.call(read);
  await f.call(replace('Keep concise.', first.revision));
  const current = await f.call(read);
  assert.equal(current.text, 'Keep concise.');
  assert.notEqual(current.revision, first.revision);
});
test('replayed replace reports conflict after intervening write', async t => {
  const f = fixture(t);
  const first = await f.call(read);
  const request = replace('Keep concise.', first.revision);
  const saved = await f.call(request);
  await f.call(replace('Keep full context.', saved.revision));
  const replay = await f.call(request);
  assert.equal(replay.error, 'revision_conflict');
  assert.equal(replay.current.text, 'Keep full context.');
  assert.equal(f.snapshot().text, 'Keep full context.');
});
test('add after intervening replacement executes instead of replaying saved success', async t => {
  const f = fixture(t);
  const saved = await f.call(add('Use bullets.'));
  await f.call(replace('', saved.revision));
  await f.call(add('Use bullets.'));
  assert.equal(f.snapshot().text.trim(), '- Use bullets.');
});
for (const [label, overrides] of [
  ['colleague', { authority: 'colleague', senderRole: 'colleague', userId: 'U_OTHER', surface: 'colleague_dm' }],
  ['owner room', { surface: 'room', channelId: 'C1' }],
]) {
  for (const [mode, args] of [['read', read], ['write', add('Private preference.')]]) {
    test(`${label} cannot replay owner ${mode} success`, async t => {
      const f = fixture(t);
      await f.call(add('Private preference.'));
      await f.call(args);
      const denied = await f.call(args, overrides);
      assert.equal(denied.error, 'not_permitted');
      assert.equal(denied.text, undefined);
      assert.equal(f.snapshot().text.trim(), '- Private preference.');
    });
  }
}
test('unavailable storage is observed after a successful read', async t => {
  const f = fixture(t);
  await f.call(add('Original.'));
  await f.call(read);
  const file = path.join(f.dir, 'config/users/fixture_prefs/summary.md');
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.equal((await f.call(read)).error, 'read_failed');
});
test('legitimate owner read and replace succeed', async t => {
  const f = fixture(t);
  const initial = await f.call(read);
  const saved = await f.call(replace('Full current text.', initial.revision));
  assert.equal(saved.ok, true);
  assert.equal(f.snapshot().text, 'Full current text.');
});
test('identical add retry remains idempotent in store', async t => {
  const f = fixture(t);
  await f.call(add('Use bullets.'));
  assert.equal((await f.call(add('Use bullets.'))).ok, true);
  assert.equal(f.snapshot().text.trim(), '- Use bullets.');
});
test('replace retry after cache reset remains idempotent in store', async t => {
  const f = fixture(t);
  const initial = await f.call(read);
  const request = replace('Complete document.', initial.revision);
  await f.call(request);
  f.cache._clearToolCallCacheForTests();
  const retry = await f.call(request);
  assert.equal(retry.ok, true);
  assert.equal(retry.unchanged, true);
  assert.equal(f.snapshot().text, 'Complete document.');
});
test('unrelated successful tool calls remain cached by canonical args', async t => {
  const f = fixture(t);
  await f.call({ recipient: 'U_OTHER', text: 'hello' }, {}, 'message_colleague');
  await f.call({ text: 'hello', recipient: 'U_OTHER' }, {}, 'message_colleague');
  assert.equal(f.executions(), 1);
});
test('unrelated failed tool result can retry successfully', async t => {
  const f = fixture(t);
  f.otherResult({ error: 'unavailable' });
  assert.equal((await f.call({}, {}, 'get_calendar')).error, 'unavailable');
  f.otherResult({ events: [] });
  assert.ok(Array.isArray((await f.call({}, {}, 'get_calendar')).events));
  assert.equal(f.executions(), 2);
});
test('preference results are never retained in the general cache', async t => {
  const f = fixture(t);
  await f.call(read);
  await f.call(add('Private preference.'));
  assert.equal(f.cache.cacheSizeForFixture(), 0);
});
test('unrelated read tool retains five second TTL', async t => {
  const f = fixture(t);
  await f.call({}, {}, 'get_calendar');
  f.advance(4999);
  await f.call({}, {}, 'get_calendar');
  assert.equal(f.executions(), 1);
  f.advance(1);
  await f.call({}, {}, 'get_calendar');
  assert.equal(f.executions(), 2);
});
test('unrelated write tool retains sixty second TTL', async t => {
  const f = fixture(t);
  await f.call({}, {}, 'message_colleague');
  f.advance(59999);
  await f.call({}, {}, 'message_colleague');
  assert.equal(f.executions(), 1);
  f.advance(1);
  await f.call({}, {}, 'message_colleague');
  assert.equal(f.executions(), 2);
});
test('preference read does not cross the write side effect boundary', async t => {
  const f = fixture(t);
  await f.call({ ...read, mode: ' read ' });
  assert.equal(f.writeBoundary(), 0);
});
test('preference read reports reading status instead of saving', async t => {
  const f = fixture(t);
  await f.call(read);
  assert.equal(f.statuses.at(-1), 'Reading your preferences');
});
test('preference read cannot establish a mutation claim', async t => {
  const f = fixture(t);
  await f.call(read);
  assert.ok(f.output().toolSummaries.every(line => !line.includes('mutated=')));
});
test('preference write keeps mutation marker boundary and saving status', async t => {
  const f = fixture(t);
  await f.call(add('Use bullets.'));
  assert.equal(f.writeBoundary(), 1);
  assert.equal(f.statuses.at(-1), 'Noting that for next time');
  assert.ok(f.output().toolSummaries.some(line => line.includes('mutated=other')));
});
test('approved action read cannot consume confirmation as completed mutation', async t => {
  const f = fixture(t);
  const result = await f.approved({ ...read, mode: ' read ' });
  assert.equal(result.status, 'failed');
  assert.equal(result.result.error, 'unsupported_approved_action');
  assert.equal(f.approvedExecutions(), 0);
});
test('approved preference write still completes and persists', async t => {
  const f = fixture(t);
  const result = await f.approved(add('Use bullets.'));
  assert.equal(result.status, 'completed');
  assert.equal(f.approvedExecutions(), 1);
  assert.equal(f.snapshot().text.trim(), '- Use bullets.');
});
