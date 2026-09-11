/* Isolated executable regressions: real tool handler/resolver/counter merge, mocked effects.
 * Run: node --test scripts/test-counter-acceptance.cjs
 * To replay a saved pre-repair resolver/skill: set MAELLE_COUNTER_SOURCE_ROOT to its root.
 * Only the explicitly listed TypeScript modules may load; no Maelle boot, DB or network.
 */
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime } = require('luxon');

const root = path.resolve(__dirname, '..');
const sourceRoot = process.env.MAELLE_COUNTER_SOURCE_ROOT || root;
const actual = new Set([
  'src/tasks/skill.ts', 'src/core/requests/resolver.ts',
  'src/core/requests/types.ts', 'src/core/approvals/approvalCallbacks.ts',
  'src/utils/textScrubber.ts',
]);
const compiled = new Map();
const harnesses = [];
const clone = value => JSON.parse(JSON.stringify(value));
const start = '2026-09-10T17:15:00+03:00';
const end = '2026-09-10T17:40:00+03:00';
const profile = { user: { name: 'Idan Cohen', slack_user_id: 'UOWNER', timezone: 'Asia/Jerusalem' }, assistant: { name: 'Maelle' } };

function harness(options = {}) {
  const effects = { replay: [], writes: [], closes: [], activity: [], sends: [], history: [], shadows: [], outbound: [], ownerPosts: [] };
  const unexpected = [];
  const prompts = [];
  const details = {
    deferred_action: { tool: options.tool || 'create_meeting', args: { subject: 'Paul sync', start: '2026-09-10T16:00:00+03:00', end: '2026-09-10T16:25:00+03:00', is_online: false, location: 'Approved office', ...options.actionArgs } },
    counter: options.counter === undefined ? { start, end } : options.counter,
    amended_by: 'owner', amend_round: 1,
    ...options.details,
  };
  if (options.noCallback) delete details.deferred_action;
  let row = {
    id: 'req_1789043787265_8z6jc', kind: 'approval', subkind: 'policy_exception',
    state: 'awaiting_colleague', owner_user_id: 'UOWNER', requester_slack_id: 'UPAUL',
    requester_name: 'Paul', subject: 'Paul sync', origin_channel: 'DPAUL',
    origin_thread_ts: '1789043787.000001', terminal_dm_msg_ts: 'owner.anchor',
    expires_at: '2026-09-15T00:00:00Z', details_json: JSON.stringify(details), ...options.row,
  };
  let reads = 0;
  const update = (id, data) => {
    assert.equal(id, row.id);
    effects.writes.push(clone(data));
    row = {
      ...row, ...data,
      ...(data.details ? { details_json: JSON.stringify(data.details) } : {}),
      ...(data.requesterNotifiedAt ? { requester_notified_at: data.requesterNotifiedAt } : {}),
      ...(data.terminalDmMsgTs ? { terminal_dm_msg_ts: data.terminalDmMsgTs } : {}),
      ...(data.ownerDmThreadTs ? { owner_dm_thread_ts: data.ownerDmThreadTs } : {}),
      ...(data.ownerDmChannel ? { owner_dm_channel: data.ownerDmChannel } : {}),
    };
  };
  const modules = new Map();
  const mocks = {
    'src/db/requests.ts': {
      getRequest: () => { reads += 1; if (options.onRead) row = options.onRead(row, reads); return row; },
      updateRequest: update,
      getAwaitingOwnerRequests: () => [row],
      isKnownRequestThreadAnchor: () => false,
    },
    'src/core/requests/closeRequest.ts': { closeRequest: args => { effects.closes.push(clone(args)); row = { ...row, state: args.state }; } },
    'src/core/requests/deferredActionReplay.ts': {
      ReplayToolError: class ReplayToolError extends Error { constructor(message, sentinel) { super(message); this.sentinel = sentinel; } },
      runDeferredAction: async args => {
        effects.replay.push(clone(args));
        if (options.replayError && effects.replay.length <= (options.replayErrorCalls || Infinity)) {
          if (options.closeDuringReplay) row = { ...row, state: 'resolved' };
          throw new mocks['src/core/requests/deferredActionReplay.ts'].ReplayToolError(options.replayErrorMessage || 'simulated replay refusal', options.replayError);
        }
        return { meetingId: 'approved-event', booked_start: args.args.start || args.args.new_start };
      },
    },
    'src/core/requests/logActivity.ts': { logActivity: data => effects.activity.push(clone(data)) },
    'src/core/requests/requesterRelay.ts': { usableRelaySubject: text => typeof text === 'string' ? text : '', requesterRelayLanguage: () => options.lang || 'en' },
    'src/db/conversations.ts': { appendToConversation: (...args) => effects.history.push(clone(args)), getConversationHistory: () => [] },
    'src/db/people.ts': { getPersonMemory: () => ({ timezone: options.requesterZone || 'America/Los_Angeles', timezone_set_by: options.zoneSetBy || 'person' }) },
    'src/db/jobs.ts': { createOutreachJob: args => effects.outbound.push(clone(args)) },
    'src/connections/registry.ts': { getConnection: () => ({
      sendDirect: async (id, body, opts) => { effects.sends.push({ id, body, opts }); return { ok: !options.sendFail, ref: 'DPAUL' }; },
      postToChannel: async (id, body, opts) => { effects.sends.push({ id, body, opts }); return { ok: true }; },
    }) },
    'src/utils/shadowNotify.ts': { shadowNotify: async (...args) => effects.shadows.push(clone(args)) },
    'src/utils/ownerDailyThread.ts': { postOwnerDecision: async args => { effects.ownerPosts.push(args.text); return { ok: true, channel: 'DOWNER', threadTs: 'owner.daily', ts: 'owner.next' }; } },
    'src/utils/workHours.ts': { workTimeBaseFromNow: () => '2026-09-10T00:00:00Z', addWorkdays: () => '2026-09-14T00:00:00Z' },
    'src/utils/weTimeResolver.ts': {},
    'src/utils/workingElsewhere.ts': { getTravelContextForInstant: () => undefined },
    'src/utils/logger.ts': { __esModule: true, default: { info() {}, warn() {}, error() {} } },
    'src/llm/models.ts': { MODEL_HAIKU: 'test-only' },
    'src/llm/client.ts': { getAnthropicClient: () => ({ messages: { create: async prompt => {
      prompts.push(clone(prompt));
      return { content: [{ type: 'text', text: options.compose ? options.compose(prompt) : '' }] };
    } } }) },
    'src/utils/usageLog.ts': {}, 'src/tasks/briefs.ts': {}, 'src/utils/requestDedup.ts': {},
    'src/utils/closeLoopOnOwnerHandled.ts': {}, 'src/db.ts': {},
  };
  function load(relative) {
    if (Object.hasOwn(mocks, relative)) return mocks[relative];
    if (modules.has(relative)) return modules.get(relative).exports;
    if (!actual.has(relative)) { unexpected.push(relative); throw new Error(`Blocked module: ${relative}`); }
    const useSnapshot = ['src/tasks/skill.ts', 'src/core/requests/resolver.ts'].includes(relative);
    const filename = path.join(useSnapshot ? sourceRoot : root, relative);
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText);
    const module = { exports: {} };
    modules.set(relative, module);
    const isolatedRequire = spec => {
      if (spec === 'luxon') return { DateTime };
      if (!spec.startsWith('.')) { unexpected.push(spec); throw new Error(`Blocked external module: ${spec}`); }
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec)) + '.ts');
    };
    // No process, timers, filesystem, native require, or network in the module context.
    const run = vm.runInNewContext(`(function(require,module,exports){${compiled.get(filename)}\n})`, { Date, Set, Map, console: undefined }, { filename });
    run(isolatedRequire, module, module.exports);
    return module.exports;
  }
  const resolver = load('src/core/requests/resolver.ts');
  const { TasksSkill } = load('src/tasks/skill.ts');
  const context = (extra = {}) => ({
    profile, userId: 'UPAUL', authority: 'colleague', senderRole: 'colleague', surface: 'dm',
    channelId: 'DPAUL', threadTs: 'owner.anchor', messagedColleaguesOkThisTurn: new Set(['UPAUL']), ...extra,
  });
  const h = {
    effects, unexpected, prompts, resolver, row: () => row,
    call: (args = {}, ctx = {}) => new TasksSkill().executeToolCall('resolve_approval', { approval_id: row.id, verdict: 'approve', ...args }, context(ctx)),
    resolve: (verdict, ctx = {}) => resolver.resolveRequest(row.id, verdict, { profile, resolvedByColleague: true, resolvingUserId: 'UPAUL', alreadyMessagedRequesterIds: new Set(['UPAUL']), ...ctx }),
    relay: (data, reason) => resolver.notifyRequesterOfDecision(row, 'amend', data, reason, { profile }),
  };
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'all dependencies must be explicitly isolated, even inside caught failures');
});
function assertNoEffects(h) {
  for (const [name, calls] of Object.entries(h.effects)) assert.equal(calls.length, 0, `${name} must not run`);
}

test('Paul Yes replays only the stored owner 17:15–17:40 counter, once', async () => {
  const h = harness();
  const result = await h.call();
  assert.equal(result.ok, true);
  assert.equal(result.start, start);
  assert.equal(h.effects.replay.length, 1);
  assert.equal(h.effects.replay[0].args.start, start);
  assert.equal(h.effects.replay[0].args.end, end);
  assert.equal(h.effects.replay[0].args.relaxed, true);
  assert.equal(h.effects.closes.length, 1);
});
test('an explicit empty colleague approve.data still accepts the stored counter', async () => {
  const h = harness();
  assert.equal((await h.call({ data: {} })).ok, true);
  assert.equal(h.effects.replay[0].args.location, 'Approved office');
});

const forged = [
  ['location', { location: 'Forged office' }],
  ['online mode', { is_online: true }],
  ['force new', { force_new: true }],
  ['arbitrary existing meeting move', { move_existing_meeting_id: 'unrelated-owner-event' }],
  ['fill missing move time', { new_start: '2026-09-11T03:00:00Z', new_end: '2026-09-11T04:00:00Z' }, { tool: 'move_meeting', counter: {}, actionArgs: { meeting_id: 'approved-event', start: undefined, end: undefined } }],
  ['fresh delete target', { fresh_meeting_id: 'unrelated-owner-event' }, { tool: 'delete_meeting', counter: {}, actionArgs: { meeting_id: 'approved-event' } }],
  ['pretend already gone', { confirmed_gone: true }, { tool: 'delete_meeting', counter: {}, actionArgs: { meeting_id: 'approved-event' } }],
  ['future owner-only field', { future_override: { delete_all: true } }],
  ['pure approval outcome data', { private_owner_fact: 'forged' }, { noCallback: true }],
  ['malformed array', [{ force_new: true }]],
  ['malformed scalar', 'force new'],
];
for (const [label, data, options] of forged) {
  test(`colleague cannot change ${label} through the real tool/resolver boundary`, async () => {
    const h = harness(options);
    const result = await h.call({ data });
    assert.equal(result.ok, false);
    assertNoEffects(h);
    assert.equal(h.row().state, 'awaiting_colleague');
  });
}
test('resolver itself refuses colleague approve.data before effects', async () => {
  const h = harness();
  assert.equal((await h.resolve({ verdict: 'approve', data: { force_new: true } })).ok, false);
  assertNoEffects(h);
});

for (const [label, ctx, row] of [
  ['wrong authenticated identity', { userId: 'UOTHER' }],
  ['missing authenticated identity', { userId: undefined }],
  ['blank authenticated identity', { userId: ' ' }],
  ['missing stored requester', {}, { requester_slack_id: null }],
  ['blank stored requester', {}, { requester_slack_id: ' ' }],
  ['whitespace identity mismatch', { userId: 'UPAUL ' }],
  ['wrong kind', {}, { kind: 'outreach' }],
  ['awaiting owner', {}, { state: 'awaiting_owner' }],
  ['terminal request', {}, { state: 'resolved' }],
]) {
  test(`tool fails closed for ${label}`, async () => {
    const h = harness({ row });
    assert.equal((await h.call({}, ctx)).error, 'not_permitted');
    assertNoEffects(h);
  });
}
for (const [label, row] of [
  ['state', { state: 'awaiting_owner' }], ['kind', { kind: 'outreach' }],
  ['requester', { requester_slack_id: 'UOTHER' }],
]) {
  test(`resolver revalidates ${label} after the tool probe and inside its queue`, async () => {
    const h = harness({ onRead: (rowBefore, read) => read === 2 ? { ...rowBefore, ...row } : rowBefore });
    assert.equal((await h.call()).ok, false);
    assertNoEffects(h);
  });
}
test('direct colleague resolver call without authenticated identity fails closed', async () => {
  const h = harness();
  assert.equal((await h.resolve({ verdict: 'approve' }, { resolvingUserId: undefined })).ok, false);
  assertNoEffects(h);
});

for (const [label, data, options] of forged.slice(0, 7)) {
  test(`owner retains ${label} recovery`, async () => {
    const h = harness({ ...options, row: { state: 'awaiting_owner' } });
    const result = await h.call({ data }, { authority: 'owner', userId: 'UOWNER', senderRole: 'colleague', surface: 'room' });
    assert.equal(result.ok, true);
    if (data.confirmed_gone) { assert.equal(h.effects.replay.length, 0); assert.equal(h.effects.closes[0].outcomeJson.already_gone, true); }
    else {
      const replay = h.effects.replay[0];
      if (data.location) assert.equal(replay.args.location, data.location);
      if (data.is_online !== undefined) assert.equal(replay.args.is_online, data.is_online);
      if (data.force_new) assert.equal(replay.args.force_new, true);
      if (data.move_existing_meeting_id) { assert.equal(replay.tool, 'move_meeting'); assert.equal(replay.args.meeting_id, data.move_existing_meeting_id); }
      if (data.new_start) { assert.equal(replay.args.new_start, data.new_start); assert.equal(replay.args.new_end, data.new_end); }
      if (data.fresh_meeting_id) assert.equal(replay.args.meeting_id, data.fresh_meeting_id);
    }
  });
}
for (const verdict of ['reject', 'amend']) {
  test(`Paul ${verdict} returns the decision to the owner without privileged replay`, async () => {
    const h = harness();
    const counter = { start: '2026-09-11T18:00:00+03:00', location: 'Paul proposal' };
    const result = await h.call({ verdict, counter, reason: 'That does not work for me' });
    assert.equal(result.ok, true);
    assert.equal(h.row().state, 'awaiting_owner');
    assert.equal(h.effects.replay.length, 0);
    assert.equal(h.effects.closes.length, 0);
    assert.equal(h.effects.ownerPosts.length, 1);
    if (verdict === 'amend') assert.deepEqual(JSON.parse(h.row().details_json).counter, counter);
  });
}

const localClock = 'Thursday 10 Sep, 07:15 PDT';
const sourceClock = 'Thursday 10 Sep, 17:15 UTC+3';
const dualClock = `${localClock} / ${sourceClock}`;
for (const [label, reason] of [
  ['original ambiguous rationale', '17:15 works for me'],
  ['explicit dual labels', '07:15 your time / 17:15 mine'],
  ['explicit third zone', '10:15 New York time is best'],
]) {
  test(`relay preserves ${label} as an attributed quote beside structured clocks`, async () => {
    const h = harness();
    assert.equal(await h.relay({ start }, reason), 'sent');
    const text = h.effects.sends[0].body;
    assert.ok(text.includes(dualClock), text);
    assert.ok(text.includes(`Idan's original wording: “${reason}”`), text);
    assert.ok(!text.includes('Any clock times'), text);
  });
}
test('nested counter instants use the same structured dual-clock renderer', async () => {
  const h = harness();
  await h.relay({ options: [{ when: start }] }, '07:15 your time / 17:15 mine');
  assert.ok(h.effects.sends[0].body.includes(dualClock));
});
test('same-zone counter keeps one labeled clock', async () => {
  const h = harness({ requesterZone: 'Asia/Jerusalem' });
  await h.relay({ start }, undefined);
  const text = h.effects.sends[0].body;
  assert.ok(text.includes('17:15 GMT+3'), text);
  assert.ok(!text.includes(' / '), text);
  assert.ok(!text.includes('original wording'), text);
});
test('counter without rationale still renders both structured clocks', async () => {
  const h = harness();
  await h.relay({ start }, undefined);
  assert.ok(h.effects.sends[0].body.includes(dualClock));
  assert.ok(!h.effects.sends[0].body.includes('original wording'));
});
test('a question plus concrete counter keeps quote and canonical clocks', async () => {
  const h = harness();
  const reason = '07:15 your time / 17:15 mine';
  await h.relay({ text: 'Does that work?', start }, reason);
  assert.ok(h.effects.sends[0].body.includes('Does that work?'));
  assert.ok(h.effects.sends[0].body.includes(dualClock));
  assert.ok(h.effects.sends[0].body.includes(`Idan's original wording: “${reason}”`));
});
test('successful composer preserves structured values and cannot reinterpret the unsubmitted owner quote', async () => {
  const reason = '07:15 your time / 17:15 mine';
  const h = harness({ compose: () => `Idan suggests ${dualClock}. Does that work?` });
  await h.relay({ start }, reason);
  assert.equal(h.effects.sends[0].body, `Idan suggests ${dualClock}. Does that work?\nIdan's original wording: “${reason}”`);
  assert.ok(!JSON.stringify(h.prompts).includes(reason));
});
test('composer dropping either structured clock is rejected by the existing pin guard', async () => {
  const h = harness({ compose: () => `Idan suggests ${localClock}. Does that work?` });
  await h.relay({ start }, undefined);
  assert.ok(h.effects.sends[0].body.includes(dualClock));
});
test('Hebrew rationale retains its explicit timezone labels verbatim', async () => {
  const h = harness({ lang: 'he' });
  const reason = '07:15 אצלך / 17:15 אצלי';
  await h.relay({ start }, reason);
  assert.ok(h.effects.sends[0].body.includes(`הניסוח המקורי של Idan: “${reason}”`));
  assert.ok(!h.effects.sends[0].body.includes('כל שעה בניסוח'));
});
test('unstructured rationale is also attributed without inventing a clock', async () => {
  const h = harness();
  await h.relay({ duration_min: 25 }, '07:15 your time / 17:15 mine');
  assert.ok(h.effects.sends[0].body.includes("Idan's original wording: “07:15 your time / 17:15 mine”"));
});
test('rejected data can be retried with an empty acceptance and replays only once', async () => {
  const h = harness();
  assert.equal((await h.call({ data: { force_new: true } })).ok, false);
  assertNoEffects(h);
  assert.equal((await h.call({ data: {} })).ok, true);
  assert.equal(h.effects.replay.length, 1);
  assert.equal(h.effects.replay[0].args.force_new, undefined);
});
test('empty pure yes/no acceptance closes with empty outcome data', async () => {
  const h = harness({ noCallback: true });
  assert.equal((await h.call({ data: {} })).ok, true);
  assert.equal(h.effects.replay.length, 0);
  assert.deepEqual(h.effects.closes[0].outcomeJson.data, {});
});
test('colleague amend cannot invoke the stored run_with_amend owner shortcut', async () => {
  const h = harness({ details: { callbacks: { on_amend: { mode: 'run_with_amend' } } } });
  assert.equal((await h.call({ verdict: 'amend', counter: { location: 'Proposed office' } })).ok, true);
  assert.equal(h.effects.replay.length, 0);
  assert.equal(h.row().state, 'awaiting_owner');
  assert.equal(h.effects.ownerPosts.length, 1);
});
test('owner reject on awaiting_colleague closes rather than bouncing back', async () => {
  const h = harness();
  assert.equal((await h.call({ verdict: 'reject', reason: 'Already handled' }, { authority: 'owner', userId: 'UOWNER' })).ok, true);
  assert.equal(h.row().state, 'cancelled');
  assert.equal(h.effects.replay.length, 0);
  assert.equal(h.effects.ownerPosts.length, 0);
});
test('two concurrent Paul acceptances perform only one replay and closure', async () => {
  const h = harness();
  const results = await Promise.all([h.call(), h.call()]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(h.effects.replay.length, 1);
  assert.equal(h.effects.closes.length, 1);
});
for (const data of [[], 0, false]) {
  test(`malformed colleague data ${JSON.stringify(data)} is not treated as an empty object`, async () => {
    const h = harness();
    assert.equal((await h.call({ data })).ok, false);
    assertNoEffects(h);
  });
}
test('auto-guessed requester zone falls back to the owner zone', async () => {
  const h = harness({ zoneSetBy: 'auto' });
  await h.relay({ start }, undefined);
  assert.ok(h.effects.sends[0].body.includes('17:15 GMT+3'));
  assert.ok(!h.effects.sends[0].body.includes('07:15'));
});
test('unresolvable requester zone retains the structured ISO fallback and owner quote', async () => {
  const h = harness({ requesterZone: 'Invalid/Zone' });
  await h.relay({ start }, '17:15 works for me');
  assert.ok(h.effects.sends[0].body.includes(start));
  assert.ok(h.effects.sends[0].body.includes("Idan's original wording: “17:15 works for me”"));
});
test('dual-clock counter preserves both dates across midnight', async () => {
  const h = harness();
  await h.relay({ start: '2026-09-11T00:15:00+03:00' }, undefined);
  assert.ok(h.effects.sends[0].body.includes('Thursday 10 Sep, 14:15 PDT / Friday 11 Sep, 00:15 UTC+3'));
});
test('UTC source is labeled UTC without claiming it is the owner local clock', async () => {
  const h = harness();
  await h.relay({ start: '2026-09-10T14:15:00Z' }, '17:15 mine');
  assert.ok(h.effects.sends[0].body.includes('Thursday 10 Sep, 07:15 PDT / Thursday 10 Sep, 14:15 UTC'));
  assert.ok(h.effects.sends[0].body.includes("Idan's original wording: “17:15 mine”"));
});
test('a verbatim reason duplicated in counter prose ships once and stays outside the composer', async () => {
  const reason = '07:15 your time / 17:15 mine';
  const h = harness({ compose: () => `Idan suggests ${dualClock}. Does that work?` });
  await h.relay({ start, reason }, reason);
  assert.equal(h.effects.sends[0].body.split(reason).length - 1, 1);
  assert.ok(!JSON.stringify(h.prompts).includes(reason));
});
test('a duplicated question remains a single attributed question', async () => {
  const text = 'Would 07:15 your time / 17:15 mine work?';
  const h = harness();
  await h.relay({ start, text }, text);
  assert.equal(h.effects.sends[0].body.split(text).length - 1, 1);
  assert.ok(h.effects.sends[0].body.includes(`Idan asked: ${text}`));
});
test('composer failure preserves the deterministic clocks and attributed rationale', async () => {
  const h = harness({ compose: () => { throw new Error('simulated composer failure'); } });
  await h.relay({ start }, '07:15 your time / 17:15 mine');
  assert.ok(h.effects.sends[0].body.includes(dualClock));
  assert.ok(h.effects.sends[0].body.includes("Idan's original wording: “07:15 your time / 17:15 mine”"));
});

const replayFailures = [
  ['possible reschedule', { error: 'possible_reschedule', existing_meeting_id: 'private-owner-event', existing_subject: 'Owner private subject', existing_when: 'tomorrow' }, 'create_meeting', 'move_existing_meeting_id'],
  ['stale deletion target', { error: 'event_not_found' }, 'delete_meeting', 'fresh_meeting_id'],
  ['unclassified tool error', { error: 'location_mode_unspecified' }, 'create_meeting', 'simulated replay refusal'],
];
for (const [label, replayError, tool, ownerRecovery] of replayFailures) {
  test(`failed replay ${label} goes back to owner without leaking recovery data or spending a counter round`, async () => {
    const h = harness({ replayError, tool, actionArgs: { meeting_id: 'approved-event' } });
    const before = h.row().details_json;
    const result = await h.call();
    assert.equal(result.ok, false);
    assert.equal(result.state, 'awaiting_owner');
    assert.equal(h.row().state, 'awaiting_owner');
    assert.equal(h.row().details_json, before);
    assert.equal(h.effects.closes.length, 0);
    assert.equal(h.effects.ownerPosts.length, 1);
    assert.equal(h.prompts.length, 0, 'failure handback must not add an LLM call');
    assert.ok(h.effects.ownerPosts[0].includes('accepted'));
    assert.ok(h.effects.ownerPosts[0].includes(ownerRecovery));
    if (tool === 'create_meeting') assert.ok(h.effects.ownerPosts[0].includes('17:15'), h.effects.ownerPosts[0]);
    for (const secret of ['private-owner-event', 'Owner private subject', 'move_existing_meeting_id', 'fresh_meeting_id', 'confirmed_gone', 'force_new', 'simulated replay refusal']) {
      assert.ok(!JSON.stringify(result).includes(secret), JSON.stringify(result));
    }
  });
}
test('failed replay retry cannot replay or notify the owner a second time from the colleague path', async () => {
  const h = harness({ replayError: replayFailures[0][1] });
  await h.call();
  assert.equal((await h.call()).error, 'not_permitted');
  assert.equal(h.effects.replay.length, 1);
  assert.equal(h.effects.ownerPosts.length, 1);
});
test('failed replay hands the unchanged accepted counter to owner recovery', async () => {
  const h = harness({ replayError: replayFailures[0][1], replayErrorCalls: 1 });
  await h.call();
  const result = await h.call({ data: { force_new: true } }, { authority: 'owner', userId: 'UOWNER', threadTs: 'owner.next' });
  assert.equal(result.ok, true);
  assert.equal(h.effects.replay.length, 2);
  assert.equal(h.effects.replay[1].args.start, start);
  assert.equal(h.effects.replay[1].args.end, end);
  assert.equal(h.effects.replay[1].args.force_new, true);
  assert.equal(JSON.parse(h.row().details_json).amend_round, 1);
  assert.equal(h.effects.ownerPosts.length, 1);
});
for (const [label, replayError, tool, ownerRecovery] of replayFailures) {
  test(`owner replay errors preserve ${label} recovery instructions`, async () => {
    const h = harness({ replayError, tool, row: { state: 'awaiting_owner' } });
    const result = await h.call({}, { authority: 'owner', userId: 'UOWNER' });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'awaiting_owner');
    assert.ok(result.reason.includes(ownerRecovery));
    assert.equal(h.prompts.length, 0, 'existing owner replay error path has zero LLM calls');
    assert.equal(h.effects.ownerPosts.length, 0);
    assert.equal(h.effects.closes.length, 0);
  });
}
test('committed action with failed requester notification stays resolved without retry or owner bounce', async () => {
  const h = harness({ sendFail: true });
  const result = await h.call({}, { messagedColleaguesOkThisTurn: new Set() });
  assert.equal(result.ok, true);
  assert.equal(result.requester_notify_outcome, 'failed');
  assert.equal(h.row().state, 'resolved');
  assert.equal(h.effects.ownerPosts.length, 0);
  assert.equal((await h.call()).error, 'not_permitted');
  assert.equal(h.effects.replay.length, 1);
});
test('failed replay never reopens a request already closed during the attempt', async () => {
  const h = harness({ replayError: replayFailures[0][1], closeDuringReplay: true });
  const result = await h.call();
  assert.equal(result.ok, false);
  assert.equal(result.state, 'resolved');
  assert.equal(h.row().state, 'resolved');
  assert.equal(h.effects.ownerPosts.length, 0);
  assert.equal(h.effects.writes.length, 0);
  assert.ok(!JSON.stringify(result).includes('private-owner-event'));
});
for (const kind of ['outreach', 'social_outreach', 'reminder', 'follow_up', 'research']) {
  for (const resolvedByColleague of [false, undefined]) {
    test(`shared resolver preserves ${kind} callers with colleague flag ${String(resolvedByColleague)}`, async () => {
      const h = harness({ row: { kind, state: 'awaiting_owner' }, noCallback: true });
      const data = { owner_payload: 'unchanged' };
      const result = await h.resolve({ verdict: 'approve', data }, { resolvedByColleague, resolvingUserId: undefined });
      assert.equal(result.ok, true);
      assert.equal(h.row().state, 'resolved');
      assert.equal(h.effects.closes.length, 1);
      assert.deepEqual(h.effects.closes[0].outcomeJson.data, data);
      assert.equal(h.effects.replay.length, 0);
    });
  }
}
