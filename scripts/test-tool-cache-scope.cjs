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
const evidence = 'artifacts/workshop-verification/v5-readiness-20260923/handyman/attempt1';
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const cachePath = before ? `${evidence}/before/src/utils/toolCallCache.ts` : 'src/utils/toolCallCache.ts';
const loopPath = before ? `${evidence}/before/src/core/orchestrator/index.ts` : 'src/core/orchestrator/index.ts';
const helpersPath = 'src/core/orchestrator/turnHelpers.ts';
const registryPath = 'src/skills/registry.ts';

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
  const dispatchNames = new Set(['COLLEAGUE_ALLOWED_TOOLS', 'OWNER_ROOM_ACTION_TOOLS', 'CHANNEL_TOOL_CLAMP']);
  const dispatchNodes = registryTree.statements.filter(node =>
    ts.isFunctionDeclaration(node) && ['executeSkillTool', 'executionFailure'].includes(node.name?.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => dispatchNames.has(d.name.getText(registryTree))));
  const dispatch = compile(dispatchNodes.map(n => n.getText(registryTree)).join('\n'), {}, 'registry-dispatch.ts', {
    logger, getActiveSkills: () => [], getConnection: () => undefined,
    CORE_MODULES: [{ name: 'fixture', executeToolCall: async (name, args, context) => {
      execution++;
      return structuredClone(nextOtherResult);
    } }],
  });
  const orchestrator = compile(source(loopPath), {
    'node:util': require('node:util'), luxon: { DateTime }, '../../utils/logger': logger,
    '../../utils/detectMessageLanguage': { detectMessageLanguage: () => 'English' },
    '../../skills/registry': {
      WRITE_TOOLS: new Set(['update_my_preferences', 'message_colleague']),
      executeSkillTool: dispatch.executeSkillTool,
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
for (const [label, overrides] of [
  ['colleague identity and scope', { userId: 'U_OTHER', authority: 'colleague', senderRole: 'colleague', surface: 'room' }],
  ['owner room data scope', { senderRole: 'colleague', surface: 'room' }],
  ['email channel clamp', { channel: 'email' }],
]) {
  test(`${label} cannot replay private owner result`, async t => {
    const f = fixture(t);
    f.otherResult({ private: 'owner-private-data' });
    await f.call({}, {}, 'manage_preference');
    const result = await f.call({}, overrides, 'manage_preference');
    assert.equal(result.error, 'not_permitted');
    assert.equal(result.private, undefined);
    assert.equal(f.executions(), 1);
  });
}
for (const [label, overrides] of [
  ['requester', { userId: 'U_OTHER' }],
  ['authority', { authority: 'colleague' }],
  ['data role', { senderRole: 'colleague' }],
  ['surface', { surface: 'room' }],
  ['channel id', { channelId: 'C_OTHER' }],
  ['transport', { channel: 'email' }],
  ['inbound connection', { inboundConnectionId: 'email' }],
  ['group owner presence', { isOwnerInGroup: true }],
  ['group membership', { mpimMemberIds: ['U_OTHER'] }],
]) {
  test(`changed ${label} dispatches fresh scoped read`, async t => {
    const f = fixture(t);
    f.otherResult({ name: 'first reader' });
    await f.call({}, {}, 'get_person_memory');
    f.otherResult({ name: 'second reader' });
    const result = await f.call({}, overrides, 'get_person_memory');
    // Registry may refuse the altered authority/data scope; either way it must not replay.
    assert.notEqual(result.name, 'first reader');
  });
}
test('same caller canonical arguments preserve dedup and TTL', async t => {
  const f = fixture(t);
  await f.call({ a: 1, b: 2 }, {}, 'get_person_memory');
  await f.call({ b: 2, a: 1 }, {}, 'get_person_memory');
  assert.equal(f.executions(), 1);
  f.advance(5000);
  await f.call({ a: 1, b: 2 }, {}, 'get_person_memory');
  assert.equal(f.executions(), 2);
});
test('write dedup preserved for same authenticated caller', async t => {
  const f = fixture(t);
  await f.call({}, {}, 'message_colleague');
  f.advance(59999);
  await f.call({}, {}, 'message_colleague');
  assert.equal(f.executions(), 1);
  f.advance(1);
  await f.call({}, {}, 'message_colleague');
  assert.equal(f.executions(), 2);
});
test('explicit unavailable and unknown results stay retryable', async t => {
  const f = fixture(t);
  for (const result of [{ error: 'unavailable' }, { error: 'send unknown', needs_verification: true }]) {
    f.otherResult(result);
    assert.equal((await f.call({}, {}, 'get_person_memory')).error, result.error);
  }
  f.otherResult({ found: true });
  assert.equal((await f.call({}, {}, 'get_person_memory')).found, true);
  assert.equal(f.executions(), 3);
});
test('process cache reset re-enters dispatch; no durable completion invented', async t => {
  const f = fixture(t);
  await f.call({}, {}, 'get_person_memory');
  f.cache._clearToolCallCacheForTests();
  await f.call({}, {}, 'get_person_memory');
  assert.equal(f.executions(), 2);
});
