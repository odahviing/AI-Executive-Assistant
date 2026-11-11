// Exercises the real classifier parser, private Slack turn builder, orchestrator
// dispatch, and approval lifecycle. Only model responses, DB and effects are fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness } = require('./fixtures/yael-lifecycle.cjs');
const before = process.env.MAELLE_APPROVAL_SOURCE_ROOT;

// Reuse the isolated entry-point loaders and substitute their service boundaries.
function fixtureSource(name, end) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8').split(end)[0];
}
const loadClassifier = new Function('require', '__dirname',
  fixtureSource('test-classifier-context-participants.cjs', 'const profile =')
    .replace('path.join(repo, rel)', 'path.join(process.env.MAELLE_APPROVAL_SOURCE_ROOT || repo, rel)')
    + '\nreturn loadClassifier;')(require, __dirname);
const builderSource = fixtureSource('test-turn-context-boundaries.cjs', "test('room framing")
  .replace('const modules = new Map();', 'install(mocks); const modules = new Map();')
  .replace('path.join(root, file)', "path.join(beforeRoot && file.endsWith('/buildTurnContext.ts') ? beforeRoot : root, file)");
const dispatchSource = fixtureSource('test-skill-context-interactive.cjs', 'module.exports =')
  .replace('const orchestrator = compile', "deps['./buildTurnContext'] = { buildTurnContext }; const orchestrator = compile")
  .replace('return structuredClone(next.result);', 'return execute(args, context);')
  .replace('compile(read(orchestratorPath)', "compile(beforeRoot ? fs.readFileSync(path.join(beforeRoot, orchestratorPath), 'utf8') : read(orchestratorPath)");
const makeBuilder = new Function('require', '__dirname', 'install', 'beforeRoot', builderSource + '\nreturn fixture;');
const makeDispatch = new Function('require', '__dirname', 'buildTurnContext', 'execute', 'beforeRoot', dispatchSource + '\nreturn run;');
const action = { tool: 'create_meeting', args: { subject: 'Rebranding', start: '2026-11-18T10:00:00Z',
  end: '2026-11-18T10:40:00Z', attendees: [{ name: 'Alex', email: 'alex@example.test' }] } };

function setup(t, { text = 'Sí', quote = text, held = false, others = [], input = {}, row = {}, tool = action.tool } = {}) {
  const booking = harness({ details: { deferred_action: { ...action, tool },
    ...(held ? { missing_fields: ['booking_attendee_identity'] } : {}) },
    row: { owner_dm_channel: 'DOWNER', owner_dm_thread_ts: 'daily.1', terminal_dm_msg_ts: 'owner.1', ...row } });
  const classifyTurn = loadClassifier();
  const builder = makeBuilder(require, __dirname, mocks => {
    mocks['src/db/requests.ts'].getAwaitingOwnerRequests = () => [booking.row(), ...others.map(extra => ({ ...booking.row(), ...extra }))];
    mocks['src/core/requests/types.ts'].parseDetails = candidate => JSON.parse(candidate.details_json);
    mocks['src/core/approvals/approvalCallbacks.ts'] = { extractCallbacks: details => ({ on_approve: details.deferred_action }) };
    mocks['src/core/social/classifyTurn.ts'] = { classifyTurn };
    mocks['src/llm/client.ts'] = { getAnthropicClient: () => ({ messages: { create: async () => ({
      stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', name: 'classify_turn', input: {
        scopes: ['tasks'], meeting_action: 'execute', standalone_courtesy: false, approval_decisions: [],
        meeting_people: [], standalone_approval_quote: quote } }] }) } }) };
  }, before)(t);
  const turn = { profile: builder.profile, userId: 'UOWNER', channelId: 'DOWNER', threadTs: 'owner.1',
    userMessage: text, rawUserMessage: text, typedUserMessage: text, ...input };
  return { booking, async build() { return builder.run(turn); }, async resolve(toolArgs = {}) {
    let observed;
    const dispatch = makeDispatch(require, __dirname, params => builder.run(params), async (args, ctx) => {
      observed = await booking.resolveTool(args, ctx);
      return observed;
    }, before);
    await dispatch([{ name: 'resolve_approval', args: { approval_id: booking.row().id, verdict: 'approve', ...toolArgs } }], turn);
    return observed;
  } };
}

for (const text of ['Sí', 'Да', 'Ja', 'نعم', 'Yes, please.', 'Yes', 'כן']) {
  test('private owner reply replays the displayed booking once: ' + text, async t => {
    const { booking, resolve } = setup(t, { text, input: { extraInstruction: 'Resolve only the current thread request.' } });
    assert.equal((await resolve()).ok, true);
    assert.deepEqual(booking.effects.executes[0].args.attendees, action.args.attendees);
    assert.equal(booking.row().state, 'resolved');
    await resolve();
    assert.equal(booking.effects.executes.length, 1);
    assert.equal(booking.effects.sends.length, 1);
  });
}
test('held recipient question stays pending after a classified assent', async t => {
  const { booking, resolve } = setup(t, { held: true });
  assert.equal((await resolve()).effect, 'approve_needs_attendee_identity');
  assert.equal(booking.row().state, 'awaiting_owner');
  assert.equal(booking.effects.executes.length, 0);
  assert.equal(booking.effects.sends.length, 0);
});
test('plain assent cannot authorize replacement arguments from the model', async t => {
  const { booking, resolve } = setup(t);
  assert.equal((await resolve({ data: { tool: 'create_meeting', args: { ...action.args, subject: 'Changed' } } })).ok, false);
  assert.equal(booking.effects.executes.length, 0);
});
for (const [name, options] of [
  ['other thread', { input: { threadTs: 'different.1' } }],
  ['other DM', { row: { owner_dm_channel: 'DOTHER' } }],
  ['another decision in daily thread', { input: { threadTs: 'daily.1' }, others: [{ id: 'req_other', terminal_dm_msg_ts: 'other.1' }] }],
  ['other open question in thread', { others: [{ id: 'req_question', kind: 'outreach' }] }],
  ['non-create callback', { tool: 'move_meeting' }],
  ['missing literal', { input: { typedUserMessage: undefined } }],
  ['borrowed quote', { text: 'A different inbox please', quote: 'Sí', input: { conversationHistory: [{ role: 'user', content: 'Sí', ts: '0' }] } }],
  ['partial literal', { text: 'Sí, use a different inbox', quote: 'Sí' }],
  ['attachment enrichment', { input: { typedUserMessage: 'Read the attachment' } }],
  ['image', { input: { images: [{ type: 'image' }] } }],
  ['room', { input: { isChannel: true, surface: 'room' } }],
  ['wrong sender', { input: { userId: 'UACTIVE' } }],
  ['colleague', { input: { authority: 'colleague', senderRole: 'colleague', surface: 'colleague_dm' } }],
  ['email', { input: { channel: 'email' } }],
  ['synthetic', { input: { interactive: false } }],
]) test('withholds standalone authority for ' + name, async t => {
  assert.equal((await setup(t, options).build()).standaloneBookingApproval, undefined);
});
test('only the exact card binds despite unrelated pending requests', async t => {
  const others = Array.from({ length: 12 }, (_, i) => ({ id: 'req_' + i, terminal_dm_msg_ts: 'other.' + i }));
  const f = setup(t, { others });
  const result = await f.build();
  assert.deepEqual(JSON.parse(JSON.stringify(result.standaloneBookingApproval)), {
    requestId: f.booking.row().id, requestDetailsJson: f.booking.row().details_json, quote: 'Sí' });
  assert.equal(result.contextualApprovalDecisions, undefined);
});
