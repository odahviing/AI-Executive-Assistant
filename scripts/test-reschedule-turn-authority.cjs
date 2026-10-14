// Executes real classifier normalization, turn-context construction and dispatch.
// Reuses the explicit isolated dependency fixtures from existing boundary/cache
// suites; no model calls, database access, calendar writes or outbound messages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const prefix = 'artifacts/workshop-verification/meeting-reschedule-20261014/handyman';
const source = rel => fs.readFileSync(path.join(root, before && ['src/core/orchestrator/buildTurnContext.ts', 'src/core/orchestrator/index.ts', 'src/core/social/classifyTurn.ts'].includes(rel) ? `${prefix}/before/${rel}` : rel), 'utf8');
function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length, 2, `fixture anchor must occur once: ${from.slice(0, 70)}`);
  return text.replace(from, to);
}
function fixtureFactory(file, boundary, edits) {
  let text = fs.readFileSync(path.join(root, file), 'utf8').split(boundary)[0];
  for (const [from, to] of edits) text = replaceOnce(text, from, to);
  const module = { exports: {} };
  new Function('require', 'module', '__dirname', `${text}\nmodule.exports = fixture;`)(require, module, __dirname);
  return module.exports;
}
const contextFixture = fixtureFactory('scripts/test-turn-context-boundaries.cjs', "\ntest('room framing", [
  ["const prefix = 'artifacts/workshop-verification/slack-audit-20260919/handyman';", `const prefix = '${prefix}';`],
  ['`${prefix}/before/buildTurnContext.ts`', '`${prefix}/before/src/core/orchestrator/buildTurnContext.ts`'],
  ['skills: { summary: true }', 'skills: { summary: true, social: true }'],
  ['return { scope: { scopes: state.scopes }', "if (state.throwClassifier) throw new Error('classifier unavailable'); return { intent: state.intent, meetingAction: state.meetingAction, scope: { scopes: state.scopes }"],
  ["noDirective: () => ({ mode: 'none' })", "chooseSocialDirective: () => ({ mode: 'none' }), noDirective: () => ({ mode: 'none' })"],
  ["return [{ name: 'update_my_preferences' }];", "return ['move_meeting','update_meeting','delete_meeting','create_meeting','resolve_approval','create_approval','message_colleague','find_available_slots','get_calendar','list_pending_approvals'].map(name => ({ name }));"],
  ["WRITE_TOOLS: new Set(['update_my_preferences'])", "WRITE_TOOLS: new Set(['move_meeting','update_meeting','delete_meeting','create_meeting','resolve_approval','create_approval','message_colleague'])"],
  ['const state = { classified:', "const state = { intent: { kind: 'task', conversation_state: 'open' }, classified:"],
]);
const loopFixture = fixtureFactory('scripts/test-tool-cache-scope.cjs', '\nfor (const [label, overrides]', [
  ["const evidence = 'artifacts/workshop-verification/v5-readiness-20260923/handyman/attempt1';", `const evidence = '${prefix}';`],
  ["const cachePath = before ? `${evidence}/before/src/utils/toolCallCache.ts` : 'src/utils/toolCallCache.ts';", "const cachePath = 'src/utils/toolCallCache.ts';"],
  ['let currentStep;', 'let contextOverride = {}; let currentStep;'],
  ["WRITE_TOOLS: new Set(['update_my_preferences', 'message_colleague'])", "WRITE_TOOLS: new Set(['update_my_preferences', 'message_colleague', 'move_meeting', 'resolve_approval'])"],
  ['resolvedMeetingAttendees: [], availabilityPrecheckToolSummaries: [],', 'resolvedMeetingAttendees: [], availabilityPrecheckToolSummaries: [], ...contextOverride,'],
  ['dir, prefs, profile, cache, statuses,', 'setContext(value) { contextOverride = value; }, dir, prefs, profile, cache, statuses,'],
]);
const negative = { kind: 'social', conversation_state: 'open', social: { direction: 'reaction', sentiment: 'negative' } };
const proposal = [{ role: 'assistant', content: 'Elinor 13:30–14:10 and Lori 14:15–14:55. I will show options before moving anything.' }];
function names(r) { return r.tools.map(t => t.name); }
async function assertBlocked(t, options = {}) {
  const f = contextFixture(t);
  f.state.intent = options.intent ?? negative;
  f.state.meetingAction = options.meetingAction;
  if (options.socialOff) f.profile.skills.social = false;
  const r = await f.run({ conversationHistory: proposal, userMessage: options.message ?? 'You are not helping', ...options.input });
  assert.ok(names(r).includes('find_available_slots'), 'discovery remains available');
  assert.ok(!names(r).includes('move_meeting'), 'calendar writes withheld');
  assert.ok(!names(r).includes('resolve_approval'), 'no approval replay initiated by dissatisfaction');
  return r;
}
test('negative reaction after nonwriting promise withholds writes', async t => { await assertBlocked(t); });
test('latest assistant proposal and trailing promise reach existing classifier in full', async t => {
  const f = contextFixture(t);
  const content = 'Explanation. '.repeat(100) + 'I will present the real options before moving anything.';
  await f.run({ conversationHistory: [{ role: 'assistant', content }], userMessage: 'You are not helping' });
  const context = f.state.classified[0].recentContext;
  t.diagnostic(JSON.stringify({ instrument: 'actual buildTurnContext classifier argument', recentContextCharacters: context.length, recentContextUtf8Bytes: Buffer.byteLength(context), inputTokens: 'unavailable' }));
  assert.equal(context, `Maelle: ${content}`);
});
test('oversized latest reply retains trailing commitment inside bounded context', async t => {
  const f = contextFixture(t);
  const content = 'x'.repeat(9000) + 'Wait for agreement before moving anything.';
  await f.run({ conversationHistory: [{ role: 'assistant', content }] });
  const context = f.state.classified[0].recentContext;
  assert.ok(context.endsWith('Wait for agreement before moving anything.'));
  assert.ok(context.includes('[...middle omitted...]')); assert.ok(context.length < 8100);
});
test('owner room negative reaction withholds actions and preserves privacy', async t => {
  const r = await assertBlocked(t, { input: { senderRole: 'colleague', authority: 'owner', isMpim: true, isOwnerInGroup: true, surface: 'room' } });
  assert.ok(!r.prompt.includes('OWNER-DB-SECRET'));
});
test('colleague negative reaction does not initiate a meeting mutation', async t => {
  await assertBlocked(t, { input: { senderRole: 'colleague', authority: 'colleague', userId: 'UACTIVE' } });
});
for (const [language, message] of [['English','Can I push Lori later to have time?'], ['Hebrew','אפשר לדחות קצת את לורי?'], ['Russian','Можно перенести встречу с Лори?'], ['Spanish','¿Puedo retrasar la reunión con Lori?']]) {
  test(`${language} semantic exploration preserves reads and blocks writes with social disabled`, async t => {
    await assertBlocked(t, { message, intent: { kind: 'task', conversation_state: 'open' }, meetingAction: 'explore', socialOff: true });
  });
}
test('non-Slack exploration uses existing participant classification when social is disabled', async t => {
  await assertBlocked(t, { intent: { kind: 'task' }, meetingAction: 'explore', socialOff: true, input: { channel: 'email' } });
});
for (const [label, intent, meetingAction, message] of [
  ['explicit original move', { kind: 'task' }, 'execute', 'Move Elinor to 13:30'],
  ['accepted exact pair', { kind: 'task' }, 'execute', 'Yes, move both to those times'],
  ['positive acceptance', { kind: 'social', social: { direction: 'reaction', sentiment: 'positive' } }, undefined, 'That works, thanks'],
  ['bare yes', { kind: 'other' }, undefined, 'yes'],
  ['mixed frustration and explicit move', { kind: 'task', social: negative.social }, 'execute', 'You are not helping. Move both to those times.'],
]) test(`${label} retains actions after proposal`, async t => {
  const f = contextFixture(t); f.state.intent = intent; f.state.meetingAction = meetingAction;
  const r = await f.run({ conversationHistory: proposal, userMessage: message });
  assert.ok(names(r).includes('move_meeting'));
  assert.ok(names(r).includes('resolve_approval'));
});
test('completed mutation acknowledgement still blocks repeat but preserves approval replay', async t => {
  const f = contextFixture(t); f.state.intent = { kind: 'other' };
  const r = await f.run({ conversationHistory: [{ role: 'assistant', content: '[move_meeting OK] Done.' }] });
  assert.ok(!names(r).includes('move_meeting')); assert.ok(names(r).includes('resolve_approval'));
});
test('approval creation then acceptance retains resolver', async t => {
  const f = contextFixture(t); f.state.intent = { kind: 'other' };
  const r = await f.run({ conversationHistory: [{ role: 'assistant', content: '[create_approval OK] Approve?' }] });
  assert.ok(names(r).includes('resolve_approval'));
});
test('explicit owner room action retains authority while private payload stays absent', async t => {
  const f = contextFixture(t); f.state.meetingAction = 'execute';
  const r = await f.run({ senderRole: 'colleague', authority: 'owner', isMpim: true, isOwnerInGroup: true, surface: 'room' });
  assert.ok(names(r).includes('move_meeting')); assert.ok(!r.prompt.includes('OWNER-DB-SECRET'));
});
test('legitimate colleague instruction retains existing permitted action surface', async t => {
  const f = contextFixture(t); f.state.meetingAction = 'execute';
  const r = await f.run({ senderRole: 'colleague', authority: 'colleague', userId: 'UACTIVE' });
  assert.ok(names(r).includes('create_meeting'));
});
test('unavailable classifier keeps existing behavior without claiming authority established', async t => {
  const f = contextFixture(t); f.state.throwClassifier = true;
  const r = await f.run(); assert.ok(names(r).includes('move_meeting'));
});
test('prose-only rewrite cannot acquire mutation tools', async t => {
  const f = contextFixture(t); const r = await f.run({ proseOnly: true });
  assert.ok(!names(r).includes('move_meeting'));
});
test('real context boundary rejects invented write at real executor before side effects', async t => {
  const c = contextFixture(t); c.state.intent = negative;
  const r = await c.run({ conversationHistory: proposal });
  const f = loopFixture(t); f.setContext({ blockedWriteTools: r.blockedWriteTools });
  const result = await f.call({ meeting_id: 'event-lori', new_start: '2026-10-14T14:15:00+03:00' }, {}, 'move_meeting');
  assert.equal(result.reason, 'turn_is_read_only'); assert.equal(f.executions(), 0); assert.equal(f.writeBoundary(), 0);
  assert.ok(f.output().toolSummaries.some(s => s.includes('FAILED')));
  assert.equal(f.output().mutationActions?.filter(a => a.ok).length ?? 0, 0);
});
test('real context accepted pair reaches actual dispatcher unchanged', async t => {
  const c = contextFixture(t); c.state.meetingAction = 'execute';
  const r = await c.run({ conversationHistory: proposal });
  const f = loopFixture(t); f.setContext({ blockedWriteTools: r.blockedWriteTools });
  await f.call({ meeting_id: 'event-lori' }, {}, 'move_meeting'); assert.equal(f.executions(), 1);
  assert.equal(f.writeBoundary(), 1);
});
test('exploration rejects resolver replay and repeat attempts before cache or write callbacks', async t => {
  const c = contextFixture(t); c.state.meetingAction = 'explore';
  const r = await c.run({ conversationHistory: proposal });
  const f = loopFixture(t); f.setContext({ blockedWriteTools: r.blockedWriteTools });
  for (let n = 0; n < 2; n++) {
    const result = await f.call({ approval_id: 'req_fixture', decision: 'approve' }, {}, 'resolve_approval');
    assert.equal(result.reason, 'turn_is_read_only');
  }
  assert.equal(f.executions(), 0); assert.equal(f.writeBoundary(), 0);
});
test('exploration still executes discovery and does not manufacture confirmed mutation', async t => {
  const c = contextFixture(t); c.state.meetingAction = 'explore';
  const r = await c.run(); const f = loopFixture(t); f.setContext({ blockedWriteTools: r.blockedWriteTools });
  await f.call({ date: '2026-10-14' }, {}, 'find_available_slots');
  assert.equal(f.executions(), 1); assert.equal(f.writeBoundary(), 0);
});
test('scheduled/background run does not inherit interactive exploration state', async t => {
  const c = contextFixture(t); c.state.meetingAction = 'explore';
  const r = await c.run({ interactive: false });
  assert.ok(names(r).includes('move_meeting')); assert.equal(r.socialClassification, null);
});
function classifier(raw, fail = false) {
  let calls = 0, request;
  const anthropic = { messages: { create: async input => { calls++; request = input; if (fail) throw new Error('unavailable'); return { content: [{ type: 'tool_use', name: 'classify_turn', input: raw }], usage: {} }; } } };
  const exports = {};
  const logger = { info() {}, warn() {} };
  const deps = { '../../utils/logger': logger, '../../utils/usageLog': { logLlmUsage() {} }, '../../db/socialSubjects': { FIXED_CATEGORIES: [] }, '../../llm/models': { HAIKU: { model: 'fixture' } } };
  vm.runInNewContext(ts.transpileModule(source('src/core/social/classifyTurn.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, { exports, require: id => { assert.ok(id in deps, id); return deps[id]; } });
  return { calls: () => calls, request: () => request, run: (overrides = {}) => exports.classifyTurn({ anthropic, message: 'Can I push Lori slightly later to have time?', profile: { user: { name: 'Owner' }, assistant: { name: 'Maelle' }, skills: {} }, needIntent: false, needScopes: false, needMeetingPeople: true, ...overrides }) };
}
test('existing participant call parses exploration independent of social intent flag', async () => {
  const f = classifier({ meeting_action: 'explore', meeting_people: ['Lori'] }); const r = await f.run();
  assert.equal(r.meetingAction, 'explore'); assert.equal(f.calls(), 1);
  assert.ok(f.request().tools[0].input_schema.properties.meeting_action);
});
test('missing invalid and failed classifier action remains unknown', async () => {
  for (const [raw, fail] of [[{},false], [{ meeting_action: 'authorized' }, false], [{ meeting_action: 'explore' }, true]]) {
    const r = await classifier(raw, fail).run(); assert.equal(r.meetingAction, undefined);
  }
});
test('bare acceptance keeps existing zero-call shortcut; no semantic guarantee inferred', async () => {
  const f = classifier({ meeting_action: 'explore' }); const r = await f.run({ message: 'yes', recentContext: proposal[0].content });
  assert.equal(f.calls(), 0); assert.equal(r.meetingAction, undefined);
});
test('representative existing-call prompt size is measured without live model use', async t => {
  const f = classifier({ meeting_action: 'explore' });
  await f.run({ needIntent: true, needScopes: true, recentContext: proposal[0].content });
  const request = f.request();
  t.diagnostic(JSON.stringify({ instrument: 'Buffer.byteLength on actual classifier request with fixture profile/context', systemCharacters: request.system.length, systemUtf8Bytes: Buffer.byteLength(request.system), toolsUtf8Bytes: Buffer.byteLength(JSON.stringify(request.tools)), maxOutputTokens: request.max_tokens, inputTokens: 'unavailable', latency: 'unavailable (mocked provider)', dollars: 'unavailable (no paid call)' }));
});
