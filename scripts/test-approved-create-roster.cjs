/* Run only the real address-selection, approval-replay and Graph serialization
 * paths. The directory, registered executor's unrelated policy, Graph transport,
 * audit and cache are fixtures. No production reads or writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const luxon = require('luxon');
const { test } = require('node:test');

const repo = path.resolve(__dirname, '..');
const revision = process.argv[process.argv.indexOf('--source-revision') + 1];
const before = process.argv.includes('--source-revision');
const sourceRoot = process.env.MAELLE_APPROVAL_SOURCE_ROOT || repo;
const read = file => before
  ? cp.execFileSync('git', ['show', revision + ':' + file], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(sourceRoot, file), 'utf8');
const source = file => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
function one(tree, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(tree);
  assert.equal(found.length, 1);
  return found[0];
}
function compile(code, globals, imports) {
  const module = { exports: {} };
  const js = ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  }}).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, ...globals, require(id) {
    if (!Object.hasOwn(imports, id)) throw Error('Unexpected import ' + id);
    return imports[id];
  }});
  return module.exports;
}

const create = source('src/skills/meetings/ops/handlers/createMeeting.ts');
const booking = source('src/skills/meetings/bookingRequest.ts');
const handler = one(create, n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleCreateMeeting');
const approvedRosterGuard = handler.body.statements.find(n => ts.isIfStatement(n) &&
  n.expression.getText() === 'context.approvedBookingAttendeeEmails')?.getText() ?? '';
const resolveBlock = one(create, n => ts.isTryStatement(n) && n.catchClause?.getText().includes('email auto-fill threw'));
const missingBlock = one(create, n => ts.isVariableDeclaration(n) && n.name.getText() === 'missingEmail').parent.parent.parent;
const requestedRoom = one(create, n => ts.isIfStatement(n) && n.expression.getText().startsWith('args.add_room_email && roomEmail &&'));
const writeCall = one(create, n => ts.isCallExpression(n) && n.expression.getText() === 'createMeeting');
const planParticipants = one(booking, n => ts.isFunctionDeclaration(n) && n.name?.text === 'buildParticipants').getText();
const humanEmail = one(booking, n => ts.isFunctionDeclaration(n) && n.name?.text === 'emailStatedByHuman').getText();
const logger = { info() {}, warn() {}, error() {} };
const profile = { user: { name: 'Owner', email: 'owner@example.test', slack_user_id: 'UOWNER' }, assistant: { name: 'Assistant' } };
const roster = [
  { name: 'Alex', email: 'hello@external.test' }, { name: 'Tal', email: 'tal@gmail.test' },
  { name: 'Daniel', email: 'daniel@example.test' },
];
const named = { Alex: 'alex@example.test', Tal: 'tal@directory.test', Daniel: 'daniel@example.test' };
const plain = value => JSON.parse(JSON.stringify(value));
const addresses = people => people.map(p => p.email);
const allEmails = addresses(roster);

function harness({ ambiguous = false, postFails = false } = {}) {
  const posts = [];
  let plans = [];
  function searchPeopleMemory(name) {
    const key = Object.keys(named).find(entry => entry.toLowerCase() === name.trim().toLowerCase());
    if (!key) return [];
    return [{ name:key, email:named[key] }, ...(ambiguous ? [{ name:key, email:'another@example.test' }] : [])];
  }
  function findPersonByName(name) {
    const candidates = searchPeopleMemory(name);
    if (candidates.length === 1) return { status:'matched', match:candidates[0], candidates };
    return { status:candidates.length ? 'ambiguous' : 'not_found', match:null, candidates };
  }
  const contact = compile(read('src/memory/resolveAttendeeEmails.ts'), {}, {
    '../utils/logger': logger, '../db/people': { searchPeopleMemory, getPersonMemory() {} },
  });
  const plan = compile(humanEmail + '\n' + planParticipants + '\nmodule.exports = { buildParticipants, emailStatedByHuman };',
    { logger }, { '../../memory/resolveAttendeeEmails': contact });
  const graph = compile(read('src/connectors/graph/calendarMutations.ts'), {}, {
    luxon, '../../utils/logger': logger, '../../db': { auditLog() {} },
    '../../config/userProfile': { getProfileByEmail: () => profile },
    './calendarReads': {}, './calendarCache': { invalidateCalendarCache() {} },
    './graphClient': { getClient: () => ({ api: () => ({ post: async event => {
      posts.push(plain(event.attendees).map(a => a.emailAddress.address));
      if (postFails) throw Error('fixture Graph failed');
      return { id: 'fixture-event' };
    }}) }) },
  });
  const preflight = compile('module.exports = function(rawAttendees,context){const attendees=rawAttendees;\n'+
    approvedRosterGuard+'\n};', {}, {});
  const run = compile('module.exports = async function(args,context){const attendees=args.attendees; const attendeeEmailNotes=[];\n' +
    resolveBlock.getText() + '\n' + missingBlock.getText() + '\nconst roomEmail=context.profile.meetings?.room_email;\n' + requestedRoom.getText() + '\nreturn ' + writeCall.getText() + ';};',
    { logger, createMeeting: graph.createMeeting, HANDLER_ERROR_CODE: { ATTENDEE_MISSING_EMAIL: 'attendee_missing_email' },
      timezone: 'UTC', userEmail: profile.user.email, skipLocationField: true, resolvedLocationParts: [], effectiveIsOnline: true },
    { '../../../../memory/resolveAttendeeEmails': contact, '../../bookingRequest': plan,
      '../../../../utils/textScrubber': { scrubInternalLeakage: x => x } });
  async function execute(tool, args, context) {
    assert.equal(tool, 'create_meeting');
    const refusal = preflight(args.attendees, context);
    if (refusal) return { status: 'failed', result: refusal };
    const participants = await plan.buildParticipants(args.attendees, profile.user.email, context);
    plans = plain(participants).filter(p => !p.isOwner).map(p => p.email);
    const result = await run(args, context);
    return result.error ? { status: 'failed', result } : { status: 'completed', result: { success: true, meetingId: result.id } };
  }
  const replayImports = {
    '../../connections/registry': { getConnection: () => ({}) }, '../../utils/logger': logger,
    './types': { ORIGIN_SURFACE_REPLAY_TOOLS: ['create_meeting'] },
    '../../skills/registry': { executeApprovedSkillTool: execute },
  };
  const replay = compile(read('src/core/requests/deferredActionReplay.ts'), {}, replayImports);
  const args = attendees => ({ attendees: plain(attendees), subject: 'Approved joint meeting',
    start: '2026-11-18T15:00:00Z', end: '2026-11-18T15:40:00Z' });
  return { posts, plans: () => plans, findPersonByName,
    async dispatch(tool, args, context) { return (await execute(tool, args, { ...context, profile })).result; },
    approved(attendees, surface = 'owner_dm') { return replay.runDeferredAction({
      ownerUserId: 'UOWNER', profile, tool: 'create_meeting', verdict: 'approve', args: args(attendees), requestId: 'req_fixture',
      originChannel: surface === 'room' ? 'CROOM' : 'DFIXTURE', originThreadTs: '100.1', surface,
    }); },
    ordinary(attendees, context = {}, spoof = {}) { return execute('create_meeting', { ...args(attendees), ...spoof },
      { profile, senderRole: 'colleague', ...context }); },
  };
}

test('approved-plan-preserves-same-name-addresses', async () => {
  const h = harness(); await h.approved(roster); assert.deepEqual(h.plans(), allEmails);
});
test('approved-write-preserves-same-name-addresses', async () => {
  const h = harness(); await h.approved(roster, 'room'); assert.deepEqual(h.posts, [allEmails]);
});
test('amended-roster-restart-is-scoped-to-this-action', async () => {
  const h = harness();
  const amended = [{ name: 'Alex', email: 'alternate@external.test' }];
  await h.approved(amended); assert.deepEqual(h.posts, [addresses(amended)]);
  const fresh = harness(); await fresh.approved(roster); assert.deepEqual(fresh.posts, [allEmails]);
});
test('human-stated-current-address-and-history-win', async () => {
  const h = harness();
  await h.ordinary(roster, { currentUserMessage: 'hello@external.test',
    conversationHistory: [{ role: 'user', content: 'tal@gmail.test' }] });
  assert.deepEqual(h.posts, [allEmails]); assert.deepEqual(h.plans(), allEmails);
});
test('directory-corrects-untrusted-model-and-assistant-addresses', async () => {
  const h = harness();
  await h.ordinary(roster, { conversationHistory: [{ role: 'assistant', content: allEmails.join(' ') }] },
    { approvedBookingAttendeeEmails: allEmails, _fulfilling_request_id: 'req_untrusted' });
  const expected = Object.values(named); assert.deepEqual(h.posts, [expected]); assert.deepEqual(h.plans(), expected);
});
test('approved-unknown-external-and-directory-agreement', async () => {
  const h = harness(); const rows = [{ name: 'New person', email: 'new@outside.test' }, roster[2]];
  await h.approved(rows); assert.deepEqual(h.posts, [addresses(rows)]);
});
test('ambiguous-name-without-address-refuses-before-post', async () => {
  const h = harness({ ambiguous: true });
  await assert.rejects(h.approved([{ name: 'Alex' }]), /attendee_missing_email/); assert.deepEqual(h.posts, []);
});
test('known-name-only-original-lookup-still-works', async () => {
  const h = harness(); await h.approved([{ name: 'Daniel' }]); assert.deepEqual(h.posts, [[named.Daniel]]);
});
test('changed-explicit-recipient-is-refused-before-graph', async () => {
  const h = harness();
  const result = await h.ordinary([{ name: 'Alex', email: named.Alex }], { approvedBookingAttendeeEmails: [roster[0].email] });
  assert.equal(result.result.error, 'approved_attendee_mismatch'); assert.deepEqual(h.posts, []);
});
test('missing-approved-recipient-is-refused-before-graph', async () => {
  const h = harness();
  const result = await h.ordinary([roster[2]], { approvedBookingAttendeeEmails: allEmails });
  assert.equal(result.result.error, 'approved_attendee_mismatch'); assert.deepEqual(h.posts, []);
});
test('graph-failure-does-not-turn-into-completion-or-second-post', async () => {
  const h = harness({ postFails: true });
  await assert.rejects(h.approved([roster[2]]), /fixture Graph failed/); assert.deepEqual(h.posts, [[named.Daniel]]);
});

// Exercise the actual owner tool entry, callback storage and resolver before
// the same real planner/Graph fixture. The sender's words and tool args are
// independent inputs, as they are in the application.
const { harness: approvalHarness } = require('./fixtures/yael-lifecycle.cjs');
const original = { tool: 'create_meeting', args: { subject: 'Review with Alex',
  start: '2026-11-18T15:00:00Z', end: '2026-11-18T15:40:00Z', attendees: [roster[0]] } };
function ownerReplacement(booking, rows, message, { preflightUnavailable = false, prior = original.args.attendees, people = {} } = {}) {
  let attempts = 0;
  const priorAction = { ...original, args: { ...original.args, attendees: prior } };
  const approval = approvalHarness({ details: { deferred_action: priorAction }, row: { terminal_dm_msg_ts: 'owner.1' }, people, findPersonByName: booking.findPersonByName,
    execute: (tool, args, context) => {
      if (preflightUnavailable && ++attempts === 1) throw Error('fixture scheduling preflight unavailable');
      return booking.dispatch(tool, args, context);
    },
  });
  return { approval, run: (answer = message) => approval.resolveTool({ data: { tool: 'create_meeting', args: { ...original.args,
    subject: 'Replacement budget review', attendees: rows } } }, { threadTs: 'owner.1', currentUserMessage: answer, typedUserMessage: answer }) };
}
test('replacement-by-name-resolves-directory-in-planner-and-Graph', async () => {
  const booking = harness();
  const chosen = [{ name: 'Daniel' }];
  const change = ownerReplacement(booking, chosen, 'Replace Alex with Daniel.');
  checkHeld(await change.run(), booking, change.approval);
  assert.equal((await change.run('- Daniel')).ok, true);
  assert.deepEqual(booking.plans(), [named.Daniel]); assert.deepEqual(booking.posts, [[named.Daniel]]);
});
test('replacement-with-an-ambiguous-name-refuses-before-Graph-and-relay', async () => {
  const booking = harness({ ambiguous: true });
  const change = ownerReplacement(booking, [{ name: 'Tal' }], 'Use Tal instead.');
  checkHeld(await change.run(), booking, change.approval);
  assert.equal((await change.run('- Tal')).ok, false);
  assert.deepEqual(booking.posts, []); assert.equal(change.approval.row().state, 'awaiting_owner');
  assert.equal(change.approval.effects.sends.length, 0);
});
test('replacement-uses-owner-stated-address-and-keeps-other-approved-pair', async () => {
  const booking = harness({ ambiguous: true });
  const email = 'correct@outside.test';
  const change = ownerReplacement(booking, [roster[0], { name: 'Tal', email }], 'Tal <'+email+'>');
  assert.equal((await change.run()).ok, true);
  assert.deepEqual(booking.posts, [[roster[0].email, email]]);
});
test('replacement-cannot-reassign-approved-address-to-another-name', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [{ name: 'Daniel', email: roster[0].email }], 'Replace Alex with Daniel.');
  assert.equal((await change.run()).ok, false); assert.deepEqual(booking.posts, []);
});
test('replacement-by-name-retry-after-preflight-failure-uses-directory', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [{ name: 'Daniel' }], 'Use Daniel instead.',
    { preflightUnavailable: true });
  checkHeld(await change.run(), booking, change.approval);
  assert.equal((await change.run('- Daniel')).ok, false); assert.deepEqual(booking.posts, []);
  change.approval.restart();
  assert.equal((await change.approval.resolve()).ok, true); assert.deepEqual(booking.posts, [[named.Daniel]]);
});
test('approved-stored-counter-with-a-literal-address-reaches-Graph', async () => {
  const booking = harness();
  const changed = approvalHarness({ details: { deferred_action: original, counter: { attendees: [' New@External.test '] } },
    execute: booking.dispatch });
  assert.equal((await changed.resolve()).ok, true);
  assert.deepEqual(booking.plans(), ['new@external.test']);
  assert.deepEqual(booking.posts, [['new@external.test']]);
});
test('partial-change-preserves-shown-external-by-name-and-drops-omitted-person', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [{ name: 'Alex' }, { name: 'Daniel' }],
    'Keep Alex, remove Tal and add Daniel.', { prior: [roster[0], roster[1]] });
  assert.ok((await change.approval.preview()).includes(roster[0].email));
  checkHeld(await change.run(), booking, change.approval);
  checkHeld(await change.run('- Alex\n- Daniel'), booking, change.approval);
  const confirmed = 'Alex <'+roster[0].email+'>\nDaniel <'+named.Daniel+'>';
  assert.equal((await change.run(confirmed)).ok, true);
  assert.deepEqual(booking.plans(), [roster[0].email, named.Daniel]);
  assert.deepEqual(booking.posts, [[roster[0].email, named.Daniel]]);
});
test('partial-change-keeps-same-shown-inbox-after-unavailable-preflight-and-restart', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [{ name: 'Alex' }, { name: 'Daniel' }],
    'Keep Alex and add Daniel.', { preflightUnavailable: true });
  checkHeld(await change.run(), booking, change.approval);
  checkHeld(await change.run('- Alex\n- Daniel'), booking, change.approval);
  const confirmed = 'Alex <'+roster[0].email+'>\nDaniel <'+named.Daniel+'>';
  assert.equal((await change.run(confirmed)).ok, false); assert.deepEqual(booking.posts, []);
  change.approval.restart();
  assert.equal((await change.approval.resolve()).ok, true);
  assert.deepEqual(booking.posts, [[roster[0].email, named.Daniel]]);
});
test('name-only-with-competing-approved-inboxes-refuses-before-Graph', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [{ name: 'Alex' }], 'Keep Alex.', {
    prior: [roster[0], { name: 'Alex', email: 'also-alex@external.test' }],
  });
  assert.equal((await change.run()).ok, false);
  assert.deepEqual(booking.posts, []); assert.equal(change.approval.row().state, 'awaiting_owner');
  assert.equal(change.approval.effects.sends.length, 0);
});
for (const [label, identifier] of [['email', { email: 'different@external.test' }], ['Slack-ID', { slack_id: 'UOTHER123' }]]) {
  test('never-shown-'+label+'-on-previously-approved-name-requires-clarification', async () => {
    const booking = harness();
    const change = ownerReplacement(booking, [{ name: 'Alex', ...identifier }], 'Invite the other Alex.');
    assert.equal((await change.run()).ok, false); assert.deepEqual(booking.posts, []);
    assert.equal(change.approval.row().state, 'awaiting_owner');
  });
}
test('typed-different-inbox-for-same-name-replaces-the-approved-external', async () => {
  const booking = harness();
  const email = 'another-alex@outside.test';
  const change = ownerReplacement(booking, [{ name: 'Alex', email }], 'Alex <'+email+'>');
  assert.equal((await change.run()).ok, true);
  assert.deepEqual(booking.plans(), [email]); assert.deepEqual(booking.posts, [[email]]);
});
test('typed-verified-member-replaces-same-name-with-its-own-inbox', async () => {
  const booking = harness();
  const email = 'chosen-member@example.test';
  const change = ownerReplacement(booking, [{ name: 'Alex', slack_id: 'UOTHER123' }],
    '<@UOTHER123>', { people: { UOTHER123: { name: 'Alex Member', email } } });
  assert.equal((await change.run()).ok, true);
  assert.deepEqual(booking.plans(), [email]); assert.deepEqual(booking.posts, [[email]]);
});
test('unresolved-explicit-member-never-falls-back-to-a-same-name-person', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [{ name: 'Alex', slack_id: 'UMISSING1' }], '<@UMISSING1>');
  assert.equal((await change.run()).ok, false); assert.deepEqual(booking.posts, []);
  assert.equal(change.approval.row().state, 'awaiting_owner');
});

const newAlex = 'alex@newcompany.test';
function typedDecision(approval, data, literal) {
  return approval.resolveTool(data === undefined ? {} : { data: { tool: 'create_meeting', args: data } },
    { threadTs: 'owner.1', currentUserMessage: literal, typedUserMessage: literal });
}
function checkHeld(result, booking, approval) {
  assert.equal(result.ok, false);
  assert.equal(approval.row().state, 'awaiting_owner');
  assert.deepEqual(booking.posts, []);
  assert.equal(approval.effects.sends.length, 0);
}
for (const [form, callback] of [
  ['bare-approval', undefined], ['unchanged-callback', original.args],
  ['name-only-replacement', { ...original.args, attendees: [{ name: 'Alex' }] }],
  ['wrongly-echoed-other-inbox', { ...original.args, attendees: [{ name: 'Alex', email: 'third@external.test' }] }],
]) {
  test('prose-correction-omitted-from-'+form+'-never-invites-a-different-address', async () => {
    const booking = harness();
    const { approval } = ownerReplacement(booking, [], '');
    const result = await typedDecision(approval, callback, 'Replace the current invitee with Alex at '+newAlex+'.');
    if (result.ok) assert.deepEqual(booking.posts, [[newAlex]]);
    else checkHeld(result, booking, approval);
  });
}
for (const [label, literal, email] of [
  ['negated', 'Do not invite Alex at '+newAlex+'. Keep the original invitation.', newAlex],
  ['incidental', 'Support uses '+newAlex+'. That is unrelated to the meeting.', newAlex],
  ['multiple-candidates', 'Alex may be at '+newAlex+' or alex@second.test. I will check.', newAlex],
  ['missing-from-human-source', 'Use Daniel instead.', 'unshown@outside.test'],
]) {
  test('an-address-echoed-by-tool-but-'+label+'-stays-pending', async () => {
    const booking = harness();
    const { approval } = ownerReplacement(booking, [], '');
    const result = await typedDecision(approval, { ...original.args,
      attendees: [{ name: label === 'missing-from-human-source' ? 'Daniel' : 'Alex', email }] }, literal);
    checkHeld(result, booking, approval);
  });
}
test('one-named-address-change-in-group-keeps-the-other-approved-inbox', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [{ name: 'Alex', email: newAlex }, { name: 'Tal' }],
    'Alex <'+newAlex+'>', { prior: roster.slice(0, 2) });
  assert.equal((await change.run()).ok, true);
  assert.deepEqual(booking.plans(), [newAlex, roster[1].email]);
  assert.deepEqual(booking.posts, [[newAlex, roster[1].email]]);
});
test('tool-assigning-owner-selected-inbox-to-another-group-member-cannot-post-it-there', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [{ name: 'Alex' }, { name: 'Tal', email: newAlex }],
    'Alex <'+newAlex+'>', { prior: roster.slice(0, 2) });
  const result = await change.run();
  if (result.ok) assert.deepEqual(booking.posts, [[newAlex, roster[1].email]]);
  else checkHeld(result, booking, change.approval);
});
test('multiple-owner-named-inboxes-map-to-names-in-reversed-tool-order', async () => {
  const booking = harness();
  const newTal = 'tal@newcompany.test';
  const change = ownerReplacement(booking, [{ name: 'Tal', email: newTal }, { name: 'Alex', email: newAlex }],
    'Alex <'+newAlex+'>\nTal <'+newTal+'>', { prior: roster.slice(0, 2) });
  const result = await change.run();
  if (result.ok) assert.deepEqual(booking.posts, [[newTal, newAlex]]);
  else checkHeld(result, booking, change.approval);
});
test('confirmed-external-change-survives-scheduling-failure-and-restart', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [{ name: 'Alex', email: newAlex }],
    'Alex <'+newAlex+'>', { preflightUnavailable: true });
  assert.equal((await change.run()).ok, false);
  assert.deepEqual(booking.posts, []);
  change.approval.restart();
  assert.equal((await change.approval.resolve()).ok, true);
  assert.deepEqual(booking.posts, [[newAlex]]);
});
test('bare-yes-without-any-correction-invites-the-original-external', async () => {
  const booking = harness();
  const { approval } = ownerReplacement(booking, [], '');
  assert.equal((await typedDecision(approval, undefined, 'Yes')).ok, true);
  assert.deepEqual(booking.posts, [[roster[0].email]]);
});

for (const [label, typed, approved] of [
  ['typed-correction-with-mistaken-approve-classification', 'Use Alex at '+newAlex+' instead.', false],
  ['literal-yes-and-different-inbox-only-in-framing', 'Yes.', true],
  ['mistaken-approve-on-another-person-with-no-name-or-address', 'That is the wrong person. I meant the other one. I do not know their email.', false],
]) {
  test('short-form-'+label+'-through-resolver-and-Graph', async () => {
    const booking = harness({ ambiguous:true });
    const approval = approvalHarness({ details: { deferred_action: original }, findPersonByName: booking.findPersonByName,
      row: { requester_slack_id: 'UOWNER', terminal_dm_msg_ts: 'owner.1' }, execute: booking.dispatch });
    const helper = compile(read('src/utils/threadBoundApprovalAutoResolve.ts'), {}, {
      '../llm/client': { getAnthropicClient: () => ({ messages: { create: async () => ({
        content: [{ type: 'tool_use', input: { target: 1, verdict: 'approve' } }], }) } }) },
      '../llm/models': require('./fixtures/registrar-models.cjs'), './logger': logger,
      '../db/requests': { getAwaitingOwnerRequests: () => [approval.row()] },
      '../core/requests/types': { parseDetails: row => JSON.parse(row.details_json) },
      '../core/approvals/approvalCallbacks': { extractCallbacks: details => ({ on_approve: details.deferred_action }) },
      '../core/requests/resolver': { resolveRequest: (id, decision, context) => {
        assert.equal(id, approval.row().id);
        return approval.resolve(decision, context);
      } },
    });
    const result = await helper.tryAutoResolveThreadBoundApproval({ ownerUserId: 'UOWNER', threadTs: 'owner.1',
      profile, message: typed+'\n[Attached note: another@company.test]', typedUserMessage: typed });
    assert.deepEqual(booking.posts, approved ? [[roster[0].email]] : []);
    assert.equal(result.resolved, approved);
    if (!approved) {
      assert.equal(approval.row().state, 'awaiting_owner');
      assert.equal(result.boundHint.requestId, approval.row().id);
      assert.equal(approval.effects.sends.length, 0);
    }
  });
}

for (const [label, literal] of [['prior-free-prose', 'Use <@UOTHER123> instead.'], ['explicit-selection', '<@UOTHER123>']]) {
  test('typed-member-with-a-conflicting-third-tool-inbox-'+label+'-stays-pending', async () => {
    const booking = harness();
    const change = ownerReplacement(booking, [{ name: 'Alex', slack_id: 'UOTHER123', email: 'tool-guess@outside.test' }],
      literal, { people: { UOTHER123: { name: 'Alex Member', email: 'chosen-member@example.test' } } });
    checkHeld(await change.run(), booking, change.approval);
  });
}

test('an-unanswered-recipient-clarification-survives-restart-and-bare-yes', async () => {
  const booking = harness();
  const { approval } = ownerReplacement(booking, [], '');
  checkHeld(await typedDecision(approval, undefined, 'Use Alex at '+newAlex+' instead.'), booking, approval);
  approval.restart();
  checkHeld(await typedDecision(approval, undefined, 'Yes'), booking, approval);
  checkHeld(await typedDecision(approval, undefined, '- Alex'), booking, approval);
  assert.equal((await typedDecision(approval, undefined, 'Alex <'+newAlex+'>')).ok, true);
  assert.deepEqual(booking.posts, [[newAlex]]);
});

for (const [form, rows] of [
  ['other-person-omitted', [{ name: 'Alex', email: newAlex }]],
  ['other-person-present-by-name', [{ name: 'Alex', email: newAlex }, { name: 'Tal' }]],
  ['other-person-given-by-previous-email', [{ name: 'Alex', email: newAlex }, { email: roster[1].email }]],
  ['unexplained-addition', [{ name: 'Alex', email: newAlex }, { name: 'Tal' }, { name: 'Daniel' }]],
  ['unexplained-replacement', [{ name: 'Alex', email: newAlex }, { name: 'Daniel' }]],
  ['different-email-on-other-person', [{ name: 'Alex', email: newAlex }, { name: 'Tal', email: 'different@example.test' }]],
]) {
  test('single-owner-mailbox-correction-'+form+'-protects-the-rest-of-the-group', async () => {
    const booking = harness();
    const change = ownerReplacement(booking, rows, 'Alex <'+newAlex+'>', { prior: roster.slice(0, 2) });
    const result = await change.run();
    if (result.ok) {
      assert.deepEqual(booking.plans(), [newAlex, roster[1].email]);
      assert.deepEqual(booking.posts, [[newAlex, roster[1].email]]);
    } else checkHeld(result, booking, change.approval);
  });
}
test('single-owner-mailbox-correction-cold-retry-keeps-both-approved-people', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [{ name: 'Alex', email: newAlex }], 'Alex <'+newAlex+'>',
    { prior: roster.slice(0, 2), preflightUnavailable: true });
  assert.equal((await change.run()).ok, false);
  assert.deepEqual(booking.posts, []);
  change.approval.restart();
  const retry = await change.approval.resolve();
  if (retry.ok) assert.deepEqual(booking.posts, [[newAlex, roster[1].email]]);
  else checkHeld(retry, booking, change.approval);
});
test('explicit-full-roster-answer-after-clarification-can-remove-another-approved-person', async () => {
  const booking = harness();
  const change = ownerReplacement(booking, [], '', { prior: roster.slice(0, 2) });
  const newRows = { ...original.args, attendees: [{ name: 'Daniel', email: named.Daniel }] };
  checkHeld(await typedDecision(change.approval, newRows, 'Replace both attendees with Daniel at '+named.Daniel+'.'),
    booking, change.approval);
  change.approval.restart();
  assert.equal((await typedDecision(change.approval, newRows, 'Daniel <'+named.Daniel+'>')).ok, true);
  assert.deepEqual(booking.posts, [[named.Daniel]]);
});
test('bare-yes-on-intact-group-uses-every-originally-approved-inbox', async () => {
  const booking = harness();
  const { approval } = ownerReplacement(booking, [], '', { prior: roster });
  assert.equal((await typedDecision(approval, undefined, 'Yes')).ok, true);
  assert.deepEqual(booking.posts, [allEmails]);
});


for (const [form, rows] of [
  ['drop', [{ name: 'Alex' }]],
  ['substitute', [{ name:'Alex' }, { name:'Daniel' }]],
  ['add', [{ name:'Alex' }, { name:'Tal' }, { name:'Daniel' }]],
]) {
  test('simple-owner-yes-with-name-only-tool-'+form+'-cannot-change-group-membership', async () => {
    const booking = harness();
    const { approval } = ownerReplacement(booking, [], '', { prior:roster.slice(0, 2) });
    const result = await typedDecision(approval, { ...original.args, attendees:rows }, 'Yes');
    if (result.ok) assert.deepEqual(booking.posts, [[roster[0].email, roster[1].email]]);
    else checkHeld(result, booking, approval);
  });
}

for (const [shape, rows] of [
  ['no-override', undefined], ['name-without-address', [{ name:'Alex' }]], ['unchanged-callback', original.args.attendees],
]) {
  test('a-disputed-namesake-with-no-inbox-'+shape+'-stays-pending', async () => {
    const booking = harness({ ambiguous:true });
    const { approval } = ownerReplacement(booking, [], '');
    const spoken = 'That is the wrong Alex. Please invite the other Alex instead. I do not know his address.';
    const payload = rows ? { ...original.args, attendees:rows } : undefined;
    checkHeld(await typedDecision(approval, payload, spoken), booking, approval);
    approval.restart();
    checkHeld(await typedDecision(approval, undefined, 'Yes'), booking, approval);
    checkHeld(await typedDecision(approval, undefined, '- Alex'), booking, approval);
    assert.equal((await typedDecision(approval, undefined, 'Alex <'+newAlex+'>')).ok, true);
    assert.deepEqual(booking.posts, [[newAlex]]);
  });
}
for (const [label, person, email, message] of [
  ['one-different-directory-person', 'Alex', roster[0].email, 'El Alex de esa dirección no es la persona que quería invitar.'],
  ['external-without-a-directory-entry', 'Riley', 'riley@external.test', 'That is the wrong Riley. I need the other Riley.'],
]) {
  test('disputed-prior-name-'+label+'-cannot-select-the-shown-address', async () => {
    const booking=harness(), {approval}=ownerReplacement(booking, [], '', { prior:[{name:person,email}] });
    checkHeld(await typedDecision(approval, undefined, message), booking, approval);
  });
}
test('bare-yes-on-an-approved-external-still-works-with-two-directory-namesakes', async () => {
  const booking=harness({ambiguous:true}), {approval}=ownerReplacement(booking,[],'');
  assert.equal((await typedDecision(approval,undefined,'Yes')).ok,true);
  assert.deepEqual(booking.posts,[[roster[0].email]]);
});
for (const [form, answer, expected] of [
  ['one-complete-inbox','Daniel <'+named.Daniel+'>',[named.Daniel]],
  ['two-complete-inboxes','Tal <'+roster[1].email+'>\nDaniel <'+named.Daniel+'>',[roster[1].email,named.Daniel]],
  ['one-complete-name','- Daniel',[named.Daniel]],
]) {
  test('cold-answer-'+form+'-selects-complete-group-without-new-tool-arguments', async () => {
    const booking=harness(), {approval}=ownerReplacement(booking,[],'',{prior:roster.slice(0,2)});
    const proposal = { ...original.args, attendees:[{name:'Daniel'}] };
    checkHeld(await typedDecision(approval,proposal,'Please replace both invitees with Daniel.'),booking,approval);
    approval.restart();
    const result=await typedDecision(approval,undefined,answer);
    assert.equal(result.ok,true); assert.deepEqual(booking.plans(),expected); assert.deepEqual(booking.posts,[expected]);
  });
}
test('cold-complete-group-answer-with-ambiguous-new-name-does-not-replay-the-old-roster', async () => {
  const booking=harness({ambiguous:true}),{approval}=ownerReplacement(booking,[],'',{prior:roster.slice(0,2)});
  checkHeld(await typedDecision(approval,{...original.args,attendees:[{name:'Daniel'}]},'I want Daniel alone.'),booking,approval);
  approval.restart();
  checkHeld(await typedDecision(approval,undefined,'- Daniel'),booking,approval);
});


for (const [shape, data] of [
  ['bare', undefined], ['name-only', { ...original.args, attendees:[{name:'Alex'}] }],
]) {
  test('unnamed-alternate-person-without-any-verified-choice-'+shape+'-cannot-invite-prior-external', async () => {
    const booking=harness({ambiguous:true}), {approval}=ownerReplacement(booking,[],'');
    const decision = await typedDecision(approval,data,'That is the wrong person. I meant the other one. I do not know their email.');
    checkHeld(decision,booking,approval);
  });
}


test('cold-owner-group-answer-and-conflicting-explicit-tool-address-cannot-write-the-tool-address', async () => {
  const booking=harness(), {approval}=ownerReplacement(booking,[],'',{prior:roster.slice(0,2)});
  const names = { ...original.args, attendees:[{name:'Daniel'}] };
  checkHeld(await typedDecision(approval,names,'Please invite Daniel alone.'),booking,approval);
  approval.restart();
  const different = { ...original.args, attendees:[{name:'Daniel',email:'unrelated@outside.test'}] };
  const decision = await typedDecision(approval,different,'Daniel <'+named.Daniel+'>');
  if(decision.ok) assert.deepEqual(booking.posts,[[named.Daniel]]);
  else checkHeld(decision,booking,approval);
});


test('a-model-approve-cannot-turn-a-plain-owner-no-into-an-invitation', async () => {
  const booking=harness({ambiguous:true}), {approval}=ownerReplacement(booking,[],'');
  const result=await typedDecision(approval,undefined,'No.');
  assert.deepEqual(booking.posts, []);
  assert.equal(approval.effects.executes.length,0);
  assert.ok(!result.ok || approval.row().state === 'cancelled');
});


test('incorrect-approve-existing-attribution-with-verbatim-owner-rejection-cannot-invite-the-rejected-person', async () => {
  const booking=harness({ambiguous:true}), {approval}=ownerReplacement(booking,[],'');
  const literal='That is the wrong person. Please invite a different person instead.';
  const card=await approval.preview();
  const attributed={requestId:approval.row().id,requestDetailsJson:approval.row().details_json,
    action:approval.effectiveAction(),disposition:'approve_existing',sourceMessageIndex:0,
    sourceQuote:card,instructionQuote:literal};
  const result=await approval.resolveTool({}, {threadTs:'owner.1',currentUserMessage:literal,typedUserMessage:literal,
    conversationHistory:[{role:'assistant',content:card}],contextualApprovalDecisions:[attributed]});
  checkHeld(result,booking,approval);
});


const chosenNamesake = { name:'Alex Levin', email:'alex@design.example' };
const namedAnswer = '"Alex Levin" <'+chosenNamesake.email+'>';

test('cold-identity-clarification-accepts-new-full-name-and-mailbox-without-another-callback', async () => {
  const booking=harness({ambiguous:true}), {approval}=ownerReplacement(booking,[],'');
  const question=await typedDecision(approval,undefined,'That is the wrong Alex. I meant the other person.');
  checkHeld(question,booking,approval);
  assert.match(question.reason,/full name/i);
  approval.restart();
  const result=await typedDecision(approval,undefined,namedAnswer);
  assert.equal(result.ok,true);
  assert.deepEqual(approval.effectiveAction().args.attendees,[chosenNamesake]);
  assert.deepEqual(booking.plans(),[chosenNamesake.email]); assert.deepEqual(booking.posts,[[chosenNamesake.email]]);
});
test('explicit-new-full-name-survives-provider-unavailability-and-cold-retry', async () => {
  const booking=harness({ambiguous:true});
  const {approval}=ownerReplacement(booking,[],'',{preflightUnavailable:true});
  checkHeld(await typedDecision(approval,undefined,'I meant a different person.'),booking,approval);
  approval.restart();
  assert.equal((await typedDecision(approval,undefined,namedAnswer)).ok,false);
  assert.deepEqual(booking.posts,[]);
  assert.deepEqual(approval.effectiveAction().args.attendees,[chosenNamesake]);
  approval.restart();
  assert.equal((await approval.resolve()).ok,true);
  assert.deepEqual(booking.posts,[[chosenNamesake.email]]);
});
test('complete-named-answer-can-replace-Alex-and-keep-the-original-Tal-after-identity-clarification', async () => {
  const booking=harness({ambiguous:true}), {approval}=ownerReplacement(booking,[],'',{prior:roster.slice(0,2)});
  checkHeld(await typedDecision(approval,undefined,'That is the wrong Alex. I meant another Alex.'),booking,approval);
  approval.restart();
  const result=await typedDecision(approval,undefined,namedAnswer+'\nTal <'+roster[1].email+'>');
  assert.equal(result.ok,true);
  assert.deepEqual(booking.posts,[[chosenNamesake.email,roster[1].email]]);
});
test('one-new-named-inbox-cannot-silently-drop-the-other-approved-group-member', async () => {
  const booking=harness({ambiguous:true}), {approval}=ownerReplacement(booking,[],'',{prior:roster.slice(0,2)});
  checkHeld(await typedDecision(approval,undefined,'The attendee is the wrong Alex.'),booking,approval);
  approval.restart();
  const result=await typedDecision(approval,undefined,namedAnswer);
  if (result.ok) assert.deepEqual(booking.posts,[[chosenNamesake.email,roster[1].email]]);
  else checkHeld(result,booking,approval);
});
test('framed-new-full-name-and-conflicting-callback-cannot-select-another-mailbox', async () => {
  const booking=harness({ambiguous:true}),{approval}=ownerReplacement(booking,[],'');
  checkHeld(await typedDecision(approval,undefined,'That was a different person.'),booking,approval);
  approval.restart();
  checkHeld(await approval.resolveTool({}, {threadTs:'owner.1',currentUserMessage:namedAnswer,typedUserMessage:''}),booking,approval);
  const proposal={ ...original.args, attendees:[{name:'Alex Levin',email:'third@different.example'}] };
  checkHeld(await typedDecision(approval,proposal,namedAnswer),booking,approval);
});


test('converging name and recovered address serialize one Graph invitation row',async()=>{
  const h=harness(); await h.ordinary([{name:'Daniel'},{email:'Daniel@example.test'},{email:'guest@outside.test'}]);
  assert.deepEqual(h.posts,[['daniel@example.test','guest@outside.test']]);
});
test('padded first email is normalized in actual Graph POST', async()=>{
  const h=harness();await h.ordinary([{email:' Daniel@example.test '},{email:'daniel@example.test'},{email:'guest@outside.test'}]);
  assert.deepEqual(h.posts,[['daniel@example.test','guest@outside.test']]);
});
test('padded explicit room and requested resource serialize once',async()=>{
  const h=harness();await h.ordinary([{email:' Room@example.test '},{email:'guest@outside.test'}],
    {profile:{...profile,meetings:{room_email:'room@example.test'}}},{add_room_email:true});
  assert.deepEqual(h.posts,[['room@example.test','guest@outside.test']]);
});
