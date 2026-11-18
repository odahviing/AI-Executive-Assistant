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
const revisionArg = process.argv.indexOf('--source-revision');
const revision = revisionArg < 0 ? undefined : process.argv[revisionArg + 1];
const repairRoot = process.env.HOLD_SELECTION_BEFORE_ROOT;
const readProduct = rel => repairRoot && fs.existsSync(path.join(repairRoot,rel))
  ? fs.readFileSync(path.join(repairRoot,rel),'utf8') : revision && rel.startsWith('src/')
  ? require('node:child_process').execFileSync('git', ['show', revision + ':' + rel], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, rel), 'utf8');
const source = rel => readProduct(before && ['src/core/orchestrator/buildTurnContext.ts', 'src/core/orchestrator/index.ts', 'src/core/social/classifyTurn.ts'].includes(rel) ? `${prefix}/before/${rel}` : rel);
function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length, 2, `fixture anchor must occur once: ${from.slice(0, 70)}`);
  return text.replace(from, to);
}
function fixtureFactory(file, boundary, edits) {
  let text = fs.readFileSync(path.join(root, file), 'utf8').split(boundary)[0];
  for (const [from, to] of edits) text = replaceOnce(text, from, to);
  const module = { exports: {} };
  new Function('require', 'module', '__dirname', 'readProduct', `${text}\nmodule.exports = fixture;`)(require, module, __dirname, readProduct);
  return module.exports;
}
const contextFixture = fixtureFactory('scripts/test-turn-context-boundaries.cjs', "\ntest('room framing", [
  ["const prefix = 'artifacts/workshop-verification/slack-audit-20260919/handyman';", `const prefix = '${prefix}';`],
  ['`${prefix}/before/buildTurnContext.ts`', '`${prefix}/before/src/core/orchestrator/buildTurnContext.ts`'],
  ['skills: { summary: true }', 'skills: { summary: true, social: true }'],
  ["fs.readFileSync(path.join(root, file), 'utf8')", 'readProduct(file)'],
  ['getOfferedSlots: () => state.offeredSlots ?? []', 'getOfferedSlots: () => state.offers ?? []'],
  ['({ ran: false, verdicts: [] })', '({ ran: false, verdicts: [], toolSummaryLines: [] })'],
  ['return { scope: { scopes: state.scopes }', "if (state.throwClassifier) throw new Error('classifier unavailable'); if (state.classifier) return state.classifier(input); return { intent: state.intent, meetingAction: state.meetingAction, selectedHoldCandidateIndices:state.holdIndices, scope: { scopes: state.scopes }"],
  ['loadAttendeeAvailabilityForPerson: async () => ({})', 'loadAttendeeAvailabilityForPerson: () => state.requesterZone ? {timezone:state.requesterZone} : undefined, attendeeKnownTimezoneForDay: entry => entry.timezone'],
  ["return (state.toolNames??['update_my_preferences']).map(name=>({name}));", `return ['hold_slot','move_meeting','update_meeting','delete_meeting','create_meeting','resolve_approval','create_approval','message_colleague','find_available_slots','get_calendar','list_pending_approvals']
    .concat(['update_person_profile','create_task'])
    .filter(name => !(state.omitHold && name === 'hold_slot'))
    .map(name => ({ name, input_schema: { type:'object', properties:{action:{type:'string',enum:['hold','release']},start_iso:{type:'string'}}, required:['action'] } }));`],
  ["WRITE_TOOLS: new Set(['update_my_preferences','message_colleague','manage_calendar_issue','create_meeting','resolve_approval'])", "WRITE_TOOLS: new Set(['hold_slot','move_meeting','update_meeting','delete_meeting','create_meeting','resolve_approval','create_approval','message_colleague','update_person_profile','create_task'])"],
  ['const state = { classified:', "const state = { intent: { kind: 'task', conversation_state: 'open' }, classified:"],
]);
const loopFixture = fixtureFactory('scripts/test-tool-cache-scope.cjs', '\nfor (const [label, overrides]', [
  ["assert.ok(delivered, 'tool result returned to model');", "if (!overrides.expectClarification) assert.ok(delivered, 'tool result returned to model');"],
  ["const evidence = 'artifacts/workshop-verification/v5-readiness-20260923/handyman/attempt1';", `const evidence = '${prefix}';`],
  ["const cachePath = before ? `${evidence}/before/src/utils/toolCallCache.ts` : 'src/utils/toolCallCache.ts';", "const cachePath = 'src/utils/toolCallCache.ts';"],
  ["const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');", 'const source = readProduct;'],
  ['let currentStep;', 'let contextOverride = {}; let currentStep; let fixtureHandler;'],
  ['return structuredClone(nextOtherResult);', 'return fixtureHandler ? fixtureHandler(name, args, context) : structuredClone(nextOtherResult);'],
  ["WRITE_TOOLS: new Set(['update_my_preferences', 'message_colleague'])", "WRITE_TOOLS: new Set(['hold_slot', 'create_meeting', 'create_approval', 'update_my_preferences', 'message_colleague', 'move_meeting', 'resolve_approval'])"],
  ["'../../db': { auditLog() {}, recordSocialMoment() {} },", "'../../db': { auditLog() {}, recordSocialMoment() {} }, '../../db/conversations': {currentRefusedBooking: (...args) => contextOverride.conversations.currentRefusedBooking(...args)}, '../../db/requests':{findRefusedBookingApproval: value=>contextOverride.conversations.findApproval(value)}, '../requests/resolver':{withRequestLock:async(key,work)=>work()},"],
  ['resolvedMeetingAttendees: [], availabilityPrecheckToolSummaries: [],', 'resolvedMeetingAttendees: [], availabilityPrecheckToolSummaries: [], ...contextOverride,'],
  ['dir, prefs, profile, cache, statuses,', 'setContext(value) { contextOverride = value; }, setHandler(fn) { fixtureHandler = fn; }, dir, prefs, profile, cache, statuses,'],
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
test('calendar exploration does not block requested contact hours or task writes', async t => {
  const f=contextFixture(t); f.state.meetingAction='explore';
  const r=await f.run({userMessage:'Extend her working hours on Tuesday and check when we can meet.'});
  assert.ok(names(r).includes('update_person_profile'));
  assert.ok(names(r).includes('create_task'));
  assert.ok(!names(r).includes('create_meeting'));
  assert.ok(!r.blockedWriteTools.has('update_person_profile'));
  assert.ok(r.blockedWriteTools.has('move_meeting'));
});

test('a question about an existing invitation uses the scheduling workflow without inventing a new request',async t=>{
 const f=contextFixture(t),message='Did the owner approve our existing invitation?';
 f.state.classifier=async()=>({scope:{scopes:['general']},intent:{kind:'task',conversation_state:'open'},meetingAction:'explore',
  existingStatusQuote:message,meetingPeople:[]});
 const result=await f.run({userMessage:message,rawUserMessage:message,typedUserMessage:message,userId:'UACTIVE',
  senderRole:'colleague',authority:'colleague',surface:'colleague_dm'});
 assert.equal(result.meetingRequest,undefined);
 assert.match(result.prompt,/An existing meeting must match the person/);
 assert.ok(result.tools.some(t=>t.name==='create_approval'),'the owner can answer a question about this existing event');
 assert.ok(!result.tools.some(t=>t.name==='create_meeting'),'a status question grants no new invitation');
});
for(const [label,input,intent] of [
  ['prose retry',{proseOnly:true},{kind:'task'}],
  ['negative reaction',{},negative],
])test(`${label} still blocks non-calendar writes`,async t=>{
  const f=contextFixture(t); f.state.intent=intent; f.state.meetingAction='explore';
  const r=await f.run(input);
  assert.ok(!names(r).includes('update_person_profile'));
  assert.ok(!names(r).includes('create_task'));
});
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
  const anthropic = { messages: { create: async input => { calls++; request = input; if (fail) throw new Error('unavailable'); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'classify_turn', input: raw }], usage: {} }; } } };
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
const colleague = { userId: 'UACTIVE', senderRole: 'colleague', authority: 'colleague', surface: 'colleague_dm' };

for(const [label,extra,allowed] of [['private request',{},true],['prose retry',{proseOnly:true},false],['shared room',{surface:'room',isMpim:true},false]])
test('an unresolved meeting question retains tracked owner consultation only on its authorized surface: '+label,async t=>{
 const f=contextFixture(t);
 f.state.classifier=async()=>({scope:{scopes:['meetings']},intent:{kind:'task',conversation_state:'open'},meetingAction:'explore',
  meetingPeople:[],requestUpdate:{relation:'new'},meetingContinuation:false});
 const text='Can anything internal be moved to make room for this meeting?';
 const r=await f.run({...colleague,...extra,userMessage:text,typedUserMessage:text});
 assert.equal(names(r).includes('create_approval'),allowed);
 assert.equal(names(r).includes('resolve_approval'),false);
 assert.equal(names(r).includes('move_meeting'),false);
 assert.equal(names(r).includes('create_meeting'),false);
});
const selectedStart = '2026-11-19T17:15:00+02:00';
const selectedEnd = '2026-11-19T17:40:00+02:00';
const offered = [
  { startIso: selectedStart, endIso:selectedEnd, display: 'Thursday 2026-11-19 17:15' },
  { startIso: '2026-11-19T17:45:00+02:00', endIso:'2026-11-19T18:10:00+02:00', display: 'Thursday 2026-11-19 17:45' },
];
async function selectedHold(t, { action = 'hold', offers = offered, omitHold, intent, indices = [0], ...input } = {}) {
  const f = contextFixture(t);
  f.state.meetingAction = action;
  f.state.holdIndices = indices;
  f.state.offers = offers;
  f.state.omitHold = omitHold;
  if (intent) f.state.intent = intent;
  const text = input.userMessage ?? 'תשמרי לי את 17:15 וברביעי אוכל להחזיר תשובה?';
  return f.run({ ...colleague, userMessage:text,typedUserMessage:text,
    conversationHistory: [{ role: 'assistant', toolSummaries:[], content: 'ביום חמישי יש חלונות של 25 דקות: 17:15, 17:45.' }], ...input });
}
test('selected internal hold ships one write with only the hold action', async t => {
  const r = await selectedHold(t);
  const hold = r.tools.find(tool => tool.name === 'hold_slot');
  assert.deepEqual(Array.from(hold.input_schema.properties.action.enum), ['hold']);
  assert.ok(hold.input_schema.properties.start_iso);
  assert.deepEqual(Array.from(hold.input_schema.required), ['action','start_iso','end_iso']);
  assert.ok(r.prompt.includes('end_iso ' + selectedEnd));
  assert.ok(names(r).includes('get_calendar'));
  for (const name of ['create_meeting','move_meeting','resolve_approval','message_colleague']) {
    assert.ok(!names(r).includes(name));
    assert.ok(r.blockedWriteTools.has(name));
  }
});
for (const [label, options] of [
  ['missing prior offer after restart', { offers: [] }],
  ['old start-only offer without a verified end', { offers:[{startIso:selectedStart,display:'17:15'}] }],
  ['disabled skill or channel clamp', { omitHold: true }],
  ['mixed room turn with owner identity', { userId: 'UOWNER', isMpim: true, surface: 'room' }],
  ['prose-only retry', { proseOnly: true }],
  ['negative feedback', { intent: negative }],
  ['status after confirmed invitation', { action: 'explore', userMessage: 'את שולחת לי זימון?' }],
  ['manual invitation report', { action: 'explore', userMessage: 'שלחתי' }],
  ['ambiguous Wednesday or Thursday', { action:'explore' }],
]) test('hold remains unavailable on ' + label, async t => {
  const r = await selectedHold(t, options);
  assert.ok(!names(r).includes('hold_slot') && r.blockedWriteTools.has('hold_slot'));
  assert.ok(!names(r).includes('create_meeting') && r.blockedWriteTools.has('create_meeting'));
  assert.ok(names(r).includes('find_available_slots'));
});
test('authenticated colleague in a room may hold an offer from that conversation', async t => {
  const r = await selectedHold(t, { surface:'room', channelId:'C1', isChannel:true });
  assert.ok(names(r).includes('hold_slot'));
  assert.ok(!names(r).includes('create_meeting'));
  assert.ok(!r.prompt.includes('OWNER-DB-SECRET'));
});
test('confirmed tentative-titled invitation follows ordinary invite path', async t => {
  const r = await selectedHold(t, { action:'execute', userMessage:'בחמישי תשמרי כרגע את הזימון שיהיה ביני לבין עידן' });
  assert.ok(names(r).includes('create_meeting') && !r.blockedWriteTools.has('create_meeting'));
});
test('invented release, missing operation, change of day, unrelated write all stop before dispatch', async t => {
  const r = await selectedHold(t);
  const f = loopFixture(t);
  f.setContext(r);
  for (const args of [{ action:'release', hold_id:'hold_other' }, { start_iso:selectedStart },
    { action:'hold', start_iso:'2026-11-18T17:15:00+02:00',end_iso:'2026-11-18T17:40:00+02:00' },
    { action:'hold', start_iso:selectedStart,end_iso:'2026-11-19T18:15:00+02:00' },
    { action:'hold', start_iso:selectedStart,end_iso:'2026-11-19T17:25:00+02:00' }]) {
    assert.equal((await f.call(args, colleague, 'hold_slot')).error, 'hold_not_authorized');
  }
  assert.equal((await f.call({}, colleague, 'create_meeting')).reason, 'outside_selected_hold');
  assert.equal(f.executions(), 0);
  assert.equal(f.writeBoundary(), 0);
});
function compileHoldModule(file, deps, globals = {}, declaration) {
  let code = readProduct(file);
  if (declaration) {
    const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    const found = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === declaration);
    assert.ok(found, declaration);
    code = found.getText(tree);
  }
  const exports = {};
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: id => { assert.ok(id in deps, id); return deps[id]; }, ...globals }, { filename:file });
  return exports;
}
test('a colleague can ask once about an unchanged refused booking without re-running the invitation', async t => {
  const db = new (require('better-sqlite3'))(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE conversation_threads(thread_ts TEXT PRIMARY KEY, channel_id TEXT, context TEXT, updated_at TEXT)');
  const conversations = compileHoldModule('src/db/conversations.ts', { './client': { getDb: () => db } });
  db.exec('CREATE TABLE requests(id TEXT, state TEXT, terminal_dm_msg_ts TEXT, details_json TEXT,kind TEXT,subkind TEXT,owner_user_id TEXT,requester_slack_id TEXT,origin_channel TEXT,origin_thread_ts TEXT,created_at TEXT)');
  const { findRefusedBookingApproval } = compileHoldModule('src/db/requests.ts', {'node:util':require('node:util')}, {getDb:()=>db,
    isDeepStrictEqual:require('node:util').isDeepStrictEqual}, 'findRefusedBookingApproval');
  conversations.findApproval = findRefusedBookingApproval;
  const loop = loopFixture(t);
  loop.profile.user.slack_user_id = 'UOWNER';
  const args = { subject: 'Yottaa sync', start: '2099-11-16T12:15:00-05:00', end: '2099-11-16T12:25:00-05:00',
    attendees: ['chris@example.test','lori@example.test','scott@example.test'] };
  const reason = 'The owner requires four hours of notice';
  const deferred = { tool: 'create_meeting', args };
  loop.otherResult({ success: false, error: 'soft_rule_offer_alternatives', violation_label: reason, _deferred_action_hint: deferred });
  await loop.call(args, colleague, 'create_meeting');
  const refusal = loop.output().refusedBooking;
  assert.ok(refusal, 'capture the actual refused operation');
  const delivered = (content, stored) => conversations.appendToConversation('T1','D1',
    { role: 'assistant', content, toolSummaries: [], refusedBooking: stored });
  delivered('12:15 breaks the notice rule. There are later alternatives.', refusal);
  const ask = 'I think he will make an exception, how about you ask him';
  async function turn(message, disposition, overrides = {}, quote = message) {
    const c = contextFixture(t);
    c.state.classifier = ({anthropic, ...input}) => classifier({kind:'task', conversation_state:'open', meeting_action:'explore',
      refused_booking_reply:disposition, approval_request_quote:quote}).run(input);
    return c.run({ ...colleague, userMessage:message, typedUserMessage:message,
      conversationHistory:conversations.getConversationHistory('T1'), ...overrides });
  }
  const discussion = await turn('perhaps he will allow this one', 'continue');
  assert.ok(discussion.blockedWriteTools.has('create_approval'));
  assert.equal(discussion.continuedRefusal.sourceToolId, refusal.sourceToolId);
  delivered('I have not asked him.', discussion.continuedRefusal);
  const followup = await turn(ask, 'ask_owner');
  assert.equal(followup.requestedException.sourceToolId, refusal.sourceToolId);
  assert.ok(!followup.blockedWriteTools.has('create_approval'));
  for (const name of ['create_meeting','move_meeting','resolve_approval','message_colleague','hold_slot']) assert.ok(followup.blockedWriteTools.has(name));
  const hebrew = 'תשאל אותו אם הוא מאשר את אותה הפגישה';
  assert.ok((await turn(hebrew, 'ask_owner')).requestedException);
  for (const [message, disposition, overrides, quote] of [
    ['no le preguntes', 'other'], ['he said “ask him”', 'other'], ['please ask about a different time', 'other'],
    [ask, 'ask_owner', {}, 'unrelated text'], [ask, 'ask_owner', {userId:'UIDLE'}],
    [ask, 'ask_owner', {channelId:'D_OTHER'}], [ask, 'ask_owner', {threadTs:'T_OTHER'}],
    [ask, 'ask_owner', {surface:'room', isMpim:true}], [ask, 'ask_owner', {proseOnly:true}],
    [ask, 'ask_owner', {conversationHistory:[{role:'assistant',content:'legacy text'}]}],
  ]) assert.equal((await turn(message, disposition, overrides, quote)).requestedException, undefined);

  loop.setContext({...followup, conversations});
  const sent = [];
  let failInsert = true;
  loop.setHandler((name, payload, context) => {
    sent.push(name);
    assert.equal(name, 'create_approval');
    assert.deepEqual(JSON.parse(JSON.stringify(payload.payload.deferred_action)), deferred);
    assert.equal(context.approvalRefusalReason.reason, reason);
    assert.equal(payload.payload.context, ask);
    if (failInsert) { failInsert = false; return { success:false, error:'db_temporarily_unavailable' }; }
    db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('req_example','awaiting_owner',null,
      JSON.stringify({deferred_action:deferred}),'approval','policy_exception','UOWNER','UACTIVE','D1','T1','2099-01-01');
    throw Error('response lost after request insertion');
  });
  // A later model-invented calendar write is rejected after the synthetic
  // approval returns, even when it is a different tool name.
  await loop.call(args, {...colleague,typedUserMessage:ask}, 'create_meeting');
  assert.deepEqual(sent, ['create_approval']);
  assert.ok(conversations.getConversationHistory('T1').at(-1).refusedBooking, 'definite pre-insert error preserved the receipt');
  assert.ok(loop.output().refusedBooking, 'retry evidence accompanies the actual outbound reply');
  delivered('I could not send the request.', loop.output().refusedBooking);
  loop.setContext({...await turn(ask,'ask_owner'),conversations});
  await loop.call(args, {...colleague,typedUserMessage:ask}, 'create_meeting');
  assert.deepEqual(sent, ['create_approval','create_approval']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM requests').get().n,1);
  assert.equal(conversations.getConversationHistory('T1').at(-1).refusedBooking, undefined);
  await loop.call({}, {...colleague,typedUserMessage:ask}, 'create_approval');
  assert.deepEqual(sent, ['create_approval','create_approval'], 'even stale pre-crash context recovers the existing row');
});
test('a concrete colleague booking automatically requests its verified exception once, including unconfirmed delivery', async t => {
  const text = 'Please book the Yottaa sync with Lori and Scott today at 12:15 to 12:25';
  const args = {subject:'Yottaa sync',start:'2099-11-16T12:15:00-05:00',end:'2099-11-16T12:25:00-05:00',
    attendees:[{email:'chris@example.test'},{email:'lori@example.test'},{email:'scott@example.test'}]};
  const reason = 'The owner requires four hours of notice';
  const c = contextFixture(t);
  c.state.classifier = ({anthropic,...input}) => classifier({kind:'task',meeting_action:'execute',
    meeting_people:[],exact_booking_quote:'today at 12:15 to 12:25'}).run(input);
  const context = await c.run({...colleague,userMessage:text,typedUserMessage:text});
  assert.equal(context.exactBookingRequested,true);
  for (const [waivable,additionalQuestion,notified] of [[true,false,true],[true,false,false],[false,false,false],[true,true,false]]) {
    const loop = loopFixture(t);
    const calls=[];
    loop.setContext({...context,messages:[],conversations:{findApproval:()=>undefined,currentRefusedBooking:()=>false}});
    loop.setHandler((tool, input) => {
      calls.push(tool);
      if(tool==='create_meeting') return {success:false,error:'soft_rule_offer_alternatives',owner_waivable_only:waivable,
        violation_label:reason,...(additionalQuestion?{open_questions:['choose location','rule']} : {}),
        _deferred_action_hint:{tool:'create_meeting',args}};
      assert.equal(tool,'create_approval');
      assert.equal(input.kind,'policy_exception'); assert.deepEqual(input.payload.deferred_action.args,args);
      return {ok:true,approval_id:'req_1',owner_notified:notified};
    });
    const receipt=await loop.call(args,{...colleague,userMessage:text,typedUserMessage:text},'create_meeting');
    assert.deepEqual(calls,waivable&&!additionalQuestion ? ['create_meeting','create_approval'] : ['create_meeting']);
    if (calls.length===2) assert.equal(receipt.owner_notified,notified);
  }
});
test('Thursday selection reaches real hold handler and SQLite once with its actual expiry', async t => {
  const db = new (require('better-sqlite3'))(':memory:');
  t.after(() => db.close());
  const schema = readProduct('src/db/client.ts');
  const end = 'idx_slot_holds_expiry ON slot_holds(status, expires_at);';
  db.exec(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS slot_holds'),schema.indexOf(end)+end.length));
  const DateTime = require('luxon').DateTime;
  const now = Date.parse('2026-11-15T09:52:30Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const holds = compileHoldModule('src/db/slotHolds.ts', { './client': { getDb:() => db } }, { Date:Clock });
  const registry = compileHoldModule('src/utils/offeredSlotsStash.ts', {
    luxon:{DateTime},'node:fs':require('node:fs'),'node:path':require('node:path'),'./logger':{},
  }, { Date:Clock, process });
  registry.recordOfferedSlots({ channelId:'D1', threadTs:'T1', timezone:'Asia/Jerusalem', slots:offered.map(s => ({ start:s.startIso,end:s.endIso })) });
  const hours = compileHoldModule('src/utils/workHours.ts',{}, {DateTime},'addWorkdays');
  const { handleHoldSlot } = compileHoldModule('src/skills/meetings/ops/handlers/calendarReads.ts', {
    '../../../../db/slotHolds': holds, '../../../../utils/workHours':hours,
    '../../../../utils/offeredSlotsStash':registry, '../../../../db':{getPersonMemory:()=>({name:'Requester'})},
  }, { DateTime, Date:Clock, getPersonMemory:()=>({name:'Requester'}) }, 'handleHoldSlot');
  const r = await selectedHold(t, { offers:registry.getOfferedSlots('D1','T1') });
  const f = loopFixture(t);
  f.profile.schedule = { office_days:{days:['Sunday','Monday','Tuesday','Wednesday','Thursday']},home_days:{days:[]} };
  f.setContext(r);
  f.setHandler((name,args,context) => { assert.equal(name,'hold_slot'); return handleHoldSlot(args,{context}); });
  const args = { action:'hold', start_iso:selectedStart, end_iso:selectedEnd };
  const result = await f.call(args, colleague, 'hold_slot');
  assert.equal(result.success,true,JSON.stringify(result));
  const row = db.prepare('SELECT * FROM slot_holds WHERE id=?').get(result.hold_id);
  assert.equal(row.start_iso,'2026-11-19T15:15:00.000Z');
  assert.equal(row.end_iso,'2026-11-19T15:40:00.000Z');
  assert.equal(row.holder_slack_id,colleague.userId);
  assert.equal(row.status,'active');
  assert.equal(row.expires_at,'2026-11-17T09:52:30.000Z');
  assert.equal(result.expires_at,row.expires_at);
  assert.equal(f.output().bookingOccurred,false);
  // Same turn authority cannot be reused for a retry or another offered time.
  assert.equal((await f.call(args,colleague,'hold_slot')).error,'hold_not_authorized');
  assert.equal((await f.call({...args,start_iso:offered[1].startIso},colleague,'hold_slot')).error,'hold_not_authorized');
  assert.equal(f.executions(),1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM slot_holds').get().n,1);
  // Rebuild the next turn from the offer; an intervening newer offer changes
  // its duration before dispatch. A cached success cannot bypass the handler.
  f.setContext(await selectedHold(t,{offers:registry.getOfferedSlots('D1','T1')}));
  registry.recordOfferedSlots({channelId:'D1',threadTs:'T1',timezone:'Asia/Jerusalem',
    slots:[{start:selectedStart,end:'2026-11-19T17:45:00+02:00'}]});
  assert.equal((await f.call(args,colleague,'hold_slot')).error,'slot_not_offered');
  assert.equal(f.executions(),2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM slot_holds').get().n,1);
});
for (const actions of [['execute','explore'], ['hold','execute']]) {
  test('join availability cache respects turn authority from ' + actions.join(' to '), async t => {
    const f = loopFixture(t);
    f.setHandler((name,args,context) => ({ name,calendarReadOnly:context.calendarReadOnly === true }));
    const args = { calendarReadOnly:false, start:selectedStart };
    for (const action of actions) {
      f.setContext(await selectedHold(t,{action}));
      const result = await f.call(args,colleague,'check_join_availability');
      assert.equal(result.calendarReadOnly,action !== 'execute');
    }
    assert.equal(f.executions(),2);
  });
}
for (const [label, result] of [
  ['explicit storage failure', { success:false, error:'storage_unavailable' }],
  ['unknown completion without a receipt', { state:'unknown' }],
]) test(label + ' cannot spend another offer or report a booking', async t => {
  const f = loopFixture(t);
  f.setContext(await selectedHold(t));
  f.otherResult(result);
  assert.deepEqual(await f.call({ action:'hold',start_iso:selectedStart,end_iso:selectedEnd },colleague,'hold_slot'),result);
  assert.equal((await f.call({ action:'hold',start_iso:offered[1].startIso,end_iso:selectedEnd },colleague,'hold_slot')).error,'hold_not_authorized');
  assert.equal(f.executions(),1);
  assert.equal(f.output().bookingOccurred,false);
});
const originalHoldText = 'אני צריכה שתשמרי לי טנטיבית כרגע, במידה והמועמד יעבור את ראיון הHR איתי נתקדם\nתשמרי לי את 17:15 וברביעי אוכל להחזיר תשובה?';
const deliveredOffer = 'ביום חמישי 19 בנובמבר יש חלונות של 25 דקות בשעון ישראל:\n17:15\n17:45';
const selection = (overrides={}) => ({ candidateIndex:0, selectedDate:'2026-11-19', offeredClock:'17:15',
  timeZone:'Asia/Jerusalem',offerZoneQuote:'שעון ישראל',selectionQuote:'17:15',...overrides });
async function verifiedSelection(t, options={}) {
  const f = contextFixture(t);
  f.profile.user.timezone='America/New_York';
  f.state.requesterZone=Object.prototype.hasOwnProperty.call(options,'requesterZone') ? options.requesterZone : 'Asia/Jerusalem';
  f.state.offers=options.offers ?? offered;
  let sent, classified;
  const reply = options.reply ?? deliveredOffer;
  const receipts = options.receipts ?? ['[find_available_slots private diagnostic: 18:30]'];
  const history = options.history ?? [{ role:'assistant',toolSummaries:receipts,
    content:receipts.length ? receipts.join(' ')+'\n'+reply : reply }];
  const message = options.message ?? originalHoldText;
  f.state.classifier=async input=>{
    sent=input;
    if(options.fail) throw Error('provider unavailable');
    const model=classifier({kind:'task',meeting_action:options.action ?? 'hold',meeting_people:[],
      selected_holds: options.pick===null ? undefined : options.pick ?? { mode:'single',selections:[selection()] }});
    const { anthropic,...params }=input;
    classified=await model.run(params);
    return classified;
  };
  const result=await f.run({...colleague,userMessage:message,rawUserMessage:message,typedUserMessage:message,
    conversationHistory:history,...options.input});
  return {result,sent,classified};
}
test('verified 17:15 rejects a first call for offered 17:45 before dispatch; exact interval remains available',async t=>{
  const {result,sent}=await verifiedSelection(t);
  assert.equal(sent.holdOfferText,deliveredOffer);
  assert.equal(sent.holdSelectionText,originalHoldText);
  assert.ok(sent.holdCandidates[0].display.includes('10:15 [America/New_York]'));
  assert.ok(sent.holdCandidates[0].localDisplays[0].includes('17:15 [Asia/Jerusalem]'));
  const f=loopFixture(t);
  f.setContext(result);
  const call=(slot)=>f.call({action:'hold',start_iso:slot.startIso,end_iso:slot.endIso},colleague,'hold_slot');
  assert.equal((await call(offered[1])).error,'hold_not_authorized');
  assert.equal(f.executions(),0); assert.equal(f.writeBoundary(),0);
  f.otherResult({success:true,hold_id:'chosen',expires_at:'2026-11-17T10:00:00Z'});
  assert.equal((await call(offered[0])).hold_id,'chosen');
  assert.equal(f.executions(),1); assert.equal(f.writeBoundary(),1);
});
for(const [name,options] of [
  ['provider cites a neighboring legitimate time',{pick:{mode:'single',selections:[selection({candidateIndex:1,offeredClock:'17:45',selectionQuote:'17:45'})]}}],
  ['missing structured selection',{pick:null}],
  ['no trusted delivery metadata',{history:[{role:'assistant',content:deliveredOffer}]}],
  ['mismatched receipt prefix',{history:[{role:'assistant',toolSummaries:['[trusted]'],content:deliveredOffer}]}],
  ['tool receipt is the only source of the chosen clock',{reply:'17:45 בלבד',receipts:['[hidden 17:15]']}],
  ['old offer superseded by another delivered response',{history:[{role:'assistant',toolSummaries:[],content:deliveredOffer},{role:'assistant',toolSummaries:[],content:'הראיון בוטל'}]}],
  ['mixed-sender room with only framing',{input:{surface:'room',isChannel:true,channelId:'C1',typedUserMessage:''}}],
  ['unknown requester timezone',{requesterZone:undefined}],
  ['same local clock on two offered days',{offers:[offered[0],{startIso:'2026-11-20T17:15:00+02:00',endIso:'2026-11-20T17:40:00+02:00',display:'Friday 17:15'}]}],
  ['classifier unavailable on a live offered selection',{fail:true}],
]) test('selected calendar interval withheld for '+name,async t=>{
  const {result}=await verifiedSelection(t,options);
  assert.ok(!names(result).includes('hold_slot')); assert.ok(result.blockedWriteTools.has('hold_slot'));
  assert.ok(!names(result).includes('create_meeting')); assert.ok(names(result).includes('find_available_slots'));
});
test('a delivered range end cannot authorize a different, unshown start from the search',async t=>{
  const reply = 'Thu 19 Nov 17:15–17:45';
  const {result} = await verifiedSelection(t,{reply,message:'Hold 17:45',pick:{mode:'single',selections:[
    selection({candidateIndex:1,selectionQuote:'17:45',offeredClock:'17:45',offerZoneQuote:''})]}});
  assert.ok(result.blockedWriteTools.has('hold_slot'));
});
test('a rechecked duration cannot silently replace the interval actually delivered',async t=>{
  const {result} = await verifiedSelection(t,{reply:'Thu 19 Nov 17:15–17:45',message:'Hold 17:15',
    pick:{mode:'single',selections:[selection({offerZoneQuote:''})]}});
  assert.ok(result.blockedWriteTools.has('hold_slot'));
});
test('a numbered pick counts delivered intervals once and retains the explicitly offered clock',async t=>{
  const {result} = await verifiedSelection(t,{reply:'Thu 19 Nov 09:15–09:40 CST\nThu 19 Nov 09:45–10:10 CST',
    message:'Hold option 2',requesterZone:'America/New_York',offers:offered.map(slot=>({...slot,presentationZone:'America/Chicago'})),
    pick:{mode:'single',selections:[selection({candidateIndex:1,selectionQuote:'2',offeredClock:'09:45',position:2,
      timeZone:'America/Chicago',offerZoneQuote:'CST'})]}});
  assert.deepEqual(Array.from(result.holdOnlyWindows.keys()),[Date.parse(offered[1].startIso)]);
});
test('a stale Thursday hold has a verified reoffer route and a status question grants no writes',async t=>{
  for (const message of ['Hold the slot we discussed for Thursday','Are you sending me an invite?']) {
    const {result} = await verifiedSelection(t,{message,action:'explore',offers:[]});
    assert.ok(result.blockedWriteTools.has('hold_slot'));
    assert.ok(result.blockedWriteTools.has('create_meeting'));
    assert.ok(names(result).includes('find_available_slots'));
    assert.match(result.prompt,/candidate_slots to recheck the discussed date, start and duration/);
    assert.match(result.prompt,/internal hold/);
    assert.match(result.prompt,/send an invitation when they authorize/);
  }
});
test('room reuses authenticated typed selection and delivered offer from this thread',async t=>{
  const {result,sent}=await verifiedSelection(t,{input:{channelId:'C1',isChannel:true,surface:'room',
    userMessage:'<<ROOM ROSTER: 17:45>>\n'+originalHoldText}});
  assert.equal(sent.holdSelectionText,originalHoldText);
  assert.equal(sent.holdOfferText,deliveredOffer);
  assert.deepEqual(Array.from(result.holdOnlyWindows.keys()),[Date.parse(selectedStart)]);
});
test('two independently selected intervals can each be held once without enabling invites',async t=>{
  const {result}=await verifiedSelection(t,{message:'תשמרי 17:15 ו-17:45',pick:{mode:'each',listLocale:'he',
    selections:[selection(),selection({candidateIndex:1,offeredClock:'17:45',selectionQuote:'17:45'})]}});
  assert.deepEqual(Array.from(result.holdOnlyWindows.keys()),offered.map(s=>Date.parse(s.startIso)));
  const f=loopFixture(t); f.setContext(result);
  f.otherResult({success:true,hold_id:'test',expires_at:'2026-11-17T10:00:00Z'});
  for (const slot of offered) {
    const args={action:'hold',start_iso:slot.startIso,end_iso:slot.endIso};
    assert.equal((await f.call(args,colleague,'hold_slot')).success,true);
    assert.equal((await f.call(args,colleague,'hold_slot')).error,'hold_not_authorized');
  }
  assert.equal(f.executions(),2);
  assert.equal((await f.call({},colleague,'create_meeting')).reason,'outside_selected_hold');
});
test('Hebrew free-form וגם requires clarification before either interval can be held',async t=>{
  const {result,classified}=await verifiedSelection(t,{message:'תשמרי 17:15 וגם 17:45',pick:{mode:'each',listLocale:'he',
    selections:[selection(),selection({candidateIndex:1,offeredClock:'17:45',selectionQuote:'17:45'})]}});
  assert.equal(classified.meetingAction,'explore');
  assert.ok(result.blockedWriteTools.has('hold_slot'));
  const f=loopFixture(t); f.setContext(result);
  for (const slot of offered) {
    const denial=await f.call({action:'hold',start_iso:slot.startIso,end_iso:slot.endIso},colleague,'hold_slot');
    assert.equal(denial.reason,'turn_is_read_only');
  }
  assert.equal(f.executions(),0); assert.equal(f.writeBoundary(),0);
});
test('explicit invite after offered slots reaches ordinary authenticated colleague dispatcher',async t=>{
  const {result}=await verifiedSelection(t,{action:'execute',message:'בחמישי שלחי כרגע זימון ביני לבין עידן'});
  const f=loopFixture(t); f.setContext(result);
  const args={subject:'Tentative',start:selectedStart,end:selectedEnd,attendees:['requester@example.test']};
  f.setHandler((name,payload,ctx)=>{
    assert.equal(name,'create_meeting'); assert.equal(ctx.userId,colleague.userId);
    assert.equal(ctx.authority,'colleague'); assert.deepEqual(payload,args);
    return {success:true,id:'mock-event',attendees:payload.attendees};
  });
  assert.equal((await f.call(args,colleague,'create_meeting')).id,'mock-event');
  assert.equal(f.executions(),1); assert.equal(f.output().bookingOccurred,true);
});

test('an ambiguous colleague clock is not permission to book the owner-clock reading', async t => {
  const receipt = '[availability_precheck 2026-10-29T13:30:00-04:00 America/New_York dur=25m: bookable | same clock read in Asia/Jerusalem: 2026-10-29T07:30:00-04:00 America/New_York dur=25m: not bookable]';
  const loop = loopFixture(t);
  loop.setContext({availabilityPrecheckToolSummaries:[receipt]});
  await loop.call({subject:'Meeting', start:'2026-10-29T13:30:00-04:00'}, {
    userId:'UACTIVE', senderRole:'colleague', authority:'colleague', surface:'colleague_dm',
    typedUserMessage:'Please book at 13:30', userMessage:'Please book at 13:30', expectClarification:true,
  }, 'create_meeting');
  assert.equal(loop.executions(), 0);
  assert.match(loop.output().reply,/13:30/);
  assert.deepEqual(Array.from(loop.output().toolSummaries), [receipt]);
});

test('a polite concrete booking and an availability question use distinct tool scopes', async t => {
  const book = 'Can you schedule the Yottaa sync from 12:15 to 12:25 today?';
  const lookup = 'Would 12:15 work for that meeting?';
  for (const [message,action,quote,authorized] of [
    [book,'book_exact',book,true],
    [lookup,'explore',undefined,false],
    [lookup,'book_exact','unrelated quoted instruction',false],
  ]) {
    const context = contextFixture(t);
    context.state.classifier = ({anthropic,...input}) => classifier({
      kind:'task',meeting_action:action,meeting_people:[],exact_booking_quote:quote,
    }).run(input);
    const result = await context.run({...colleague,userMessage:message,typedUserMessage:message});
    assert.equal(result.exactBookingRequested,authorized);
    assert.equal(names(result).includes('create_meeting'),authorized);
  }
});

test('a shared calendar read reports the viewer’s clock and never asserts a new invitation', () => {
  const {sharedMeetingRead} = compileHoldModule('src/skills/meetings/ops/offerReply.ts',{luxon:require('luxon')});
  const event={subject:'Tentative Slot',_localDate:'2026-11-19',_localStartTime:'10:15',_durationMin:30,isAllDay:false};
  const shown=sharedMeetingRead(event,'America/New_York','Asia/Jerusalem','Hebrew','עידן');
  assert.equal(shown.subject,event.subject);
  assert.match(shown.reply,/17:15–17:45/);
  assert.match(shown.reply,/לא שלחתי זימון חדש/);
  assert.equal(sharedMeetingRead({...event,_localDate:'2026-11-01',_localStartTime:'01:30'},'America/New_York','Asia/Jerusalem','Hebrew','עידן'),undefined);
  assert.equal(sharedMeetingRead({...event,isAllDay:true},'America/New_York',undefined,'English','Idan'),undefined);
});

test('a scheduling follow-up keeps only the same requester’s active duration', async t => {
  const context = contextFixture(t);
  const first = 'Find 10 minutes for Softcat';
  const next = 'Monday at 15:03';
  context.state.classifier = ({anthropic,...input}) => classifier({
    kind:'task',meeting_action:'explore',meeting_people:[],
    request_relation:input.message === first ? 'new' : 'continue',
    ...(input.message === first ? {request_duration:{minutes:10,quote:'10 minutes'}} : {}),
  }).run(input);
  const initial = await context.run({...colleague,userMessage:first,typedUserMessage:first});
  assert.equal(initial.meetingRequest.duration.minutes,10);
  const history = [{role:'assistant',content:'Which time?',toolSummaries:[],meetingRequest:initial.meetingRequest}];
  const follow = input => context.run({...colleague,userMessage:next,typedUserMessage:next,conversationHistory:history,...input});
  const same = await follow({});
  assert.equal(same.meetingRequest.original,first);
  assert.equal(same.meetingRequest.duration.minutes,10);
  assert.deepEqual(Array.from(same.meetingRequest.updates),[next]);
  assert.equal((await follow({conversationHistory:[{...history[0],meetingRequest:{...initial.meetingRequest,requesterId:'UOTHER'}}]})).meetingRequest?.duration,undefined);
  assert.equal((await follow({channelId:'DOTHER'})).meetingRequest?.duration,undefined);
});

test('a same-roster follow-up retains the requester in an established pair', async t => {
  const context=contextFixture(t),first='Find a meeting for me and Idan',next='Tuesday at 17:00';
  context.state.classifier=async input=>({intent:{kind:'task',conversation_state:'open'},scope:{scopes:['meetings']},
    meetingAction:'explore',meetingPeople:[],requestUpdate:{relation:input.message===first?'new':'continue'},
    requesterPair:input.message===first,participantsUnchanged:input.message===next,meetingContinuation:input.message===next});
  const initial=await context.run({...colleague,userMessage:first,typedUserMessage:first});
  assert.equal(initial.meetingRequest.requesterPair,true);
  initial.meetingRequest.existingMeeting={eventId:'verified-existing'};
  const history=[{role:'assistant',content:'Which day?',toolSummaries:[],meetingRequest:initial.meetingRequest}];
  const nextTurn=extra=>context.run({...colleague,userMessage:next,typedUserMessage:next,conversationHistory:history,...extra});
  assert.equal((await nextTurn({})).meetingRequest.requesterPair,true);
  assert.equal((await nextTurn({})).meetingRequest.existingMeeting?.eventId,'verified-existing');
  assert.notEqual((await nextTurn({channelId:'DOTHER'})).meetingRequest?.requesterPair,true);
  assert.equal((await nextTurn({channelId:'DOTHER'})).meetingRequest?.existingMeeting,undefined);
  context.state.classifier=async()=>({intent:{kind:'task',conversation_state:'open'},scope:{scopes:['meetings']},
    meetingAction:'explore',meetingPeople:[],requestUpdate:{relation:'continue'},requesterPair:false,participantsUnchanged:false,meetingContinuation:true});
  assert.equal((await nextTurn({})).meetingRequest.requesterPair,false);
  assert.equal((await nextTurn({})).meetingRequest.existingMeeting,undefined);
});

for (const [label,operations,allowed] of [
  ['rejected proposal',[],[]],
  ['move only',[{operation:'move',quote:'Move Elinor later'}],['move_meeting']],
  ['book only',[{operation:'create',quote:'Book Michal at noon'}],['create_meeting']],
  ['separate changes',[{operation:'move',quote:'Move Elinor later'},{operation:'create',quote:'Book Michal at noon'}],['move_meeting','create_meeting']],
  ['fabricated quote',[{operation:'create',quote:'not in the human message'}],[]],
])test('owner operation scope '+label,async t=>{
  const f=contextFixture(t),message=label==='rejected proposal'?'No, that is too early.':'Move Elinor later. Book Michal at noon.';
  f.state.classifier=({anthropic,...input})=>classifier({kind:'task',meeting_action:'execute',meeting_people:[],calendar_operations:operations}).run(input);
  const r=await f.run({userMessage:message,typedUserMessage:message});
  for(const tool of ['create_meeting','move_meeting','update_meeting','delete_meeting']) {
    assert.equal(names(r).includes(tool),allowed.includes(tool),tool);
    if(!allowed.includes(tool))assert.ok(r.blockedWriteTools.has(tool));
  }
  assert.ok(names(r).includes('find_available_slots'));
});
