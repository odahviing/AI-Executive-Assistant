// Actual Slack eligibility -> messaging -> Connection adapter; SDK calls are
// isolated fixtures. Connected cases reuse the actual outreach/timer harness.
// SLACK_SEND_BEFORE_ROOT points to a preserved src/connections/slack snapshot.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const beforeRoot = process.env.SLACK_SEND_BEFORE_ROOT;
const compiled = new Map();
const log = { __esModule: true, default: { warn() {}, info() {}, debug() {}, error() {} } };
function load(rel, deps, globals = {}) {
  const source = beforeRoot && ['messaging.ts', 'index.ts'].some(f => rel === 'src/connections/slack/' + f)
    ? path.resolve(beforeRoot, rel) : path.join(root, rel);
  if (!compiled.has(source)) compiled.set(source, ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
  const m = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + compiled.get(source) + '\n})', { Buffer, ...globals }, { filename: rel })(n => {
    assert.ok(Object.hasOwn(deps, n), 'Unexpected dependency ' + n); return deps[n];
  }, m, m.exports);
  return m.exports;
}
function harness(surface, mode = 'success') {
  const calls = { posts: [], opens: [], uploads: [], joins: [], infos: [] };
  let currentMode = mode;
  const channelId = surface === 'dm' ? 'DROOM' : surface === 'mpim' ? 'GROOM' : 'CROOM';
  const app = { client: {
    auth: { test: async () => { if (currentMode === 'auth-failed') throw Error('timeout'); return { ok: true, team_id: 'TINTERNAL' }; } },
    users: { info: async ({ user }) => {
      if (currentMode === 'user-failed'
        || (['broadcast-unknown-then-refused', 'broadcast-success-then-refused'].includes(currentMode) && user === 'USECOND')
        || (currentMode === 'broadcast-refused-then-unknown' && user === 'UCOLLEAGUE')) throw Error('missing_scope');
      return { ok: true, user: { team_id: currentMode === 'external-user' ? 'TEXTERNAL' : 'TINTERNAL' } };
    } },
    conversations: {
      open: async p => { calls.opens.push(p); if (currentMode === 'open-failed') throw Error('ratelimited'); return currentMode === 'open-empty' ? {} : { channel: { id: channelId } }; },
      info: async p => {
        calls.infos.push(p);
        if (currentMode === 'info-failed' || (currentMode === 'join-info-failed' && calls.posts.length)) throw Error('missing_scope');
        return { ok: true, channel: { id: channelId,
          ...(surface === 'dm' ? { is_im: true, user: calls.opens.at(-1)?.users ?? 'UCOLLEAGUE' } : surface === 'mpim' ? { is_mpim: true } : { is_channel: true }),
          ...(currentMode === 'unknown-sharing' ? {} : { is_ext_shared: currentMode === 'external-room' }),
          is_private: currentMode === 'private-refused',
        } };
      },
      join: async p => { calls.joins.push(p); if (currentMode === 'join-failed') throw Error('missing_scope'); return { ok: true }; },
    },
    chat: { postMessage: async p => {
      calls.posts.push(p);
      if (['post-failed', 'broadcast-unknown-then-refused', 'broadcast-refused-then-unknown'].includes(currentMode)) throw Error('socket reset');
      if (currentMode === 'channel-missing') throw { data: { error: 'channel_not_found' } };
      if (['private-refused', 'join-info-failed', 'join-failed', 'join-success', 'retry-failed'].includes(currentMode) && calls.posts.length === 1) throw { data: { error: 'not_in_channel' } };
      if (currentMode === 'retry-failed') throw Error('socket reset after retry');
      return { ok: true, ts: '100.000002' };
    } },
    files: { uploadV2: async p => { calls.uploads.push(p); if (currentMode === 'upload-failed') throw Error('upload timeout'); return { ok: true }; } },
  } };
  const eligibility = load('src/connections/slack/eligibility.ts', { '../../utils/logger': log });
  const messaging = load('src/connections/slack/messaging.ts', { '../../utils/logger': log, './eligibility': eligibility }, {
    fetch: async () => ({ ok: currentMode !== 'download-failed', status: 503, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }),
  });
  const adapter = load('src/connections/slack/index.ts', {
    '../../utils/logger': log, './messaging': messaging, './eligibility': eligibility,
    './formatting': { formatForSlack: x => x }, '../../db': { searchPeopleMemory: () => [] },
  });
  const conn = adapter.createSlackConnection(app, 'fixture-token', { user: { slack_user_id: 'UOWNER' } });
  const send = (opts) => surface === 'dm' ? conn.sendDirect('UCOLLEAGUE', 'Approved message', opts)
    : surface === 'mpim' ? conn.sendGroupConversation(['UCOLLEAGUE', 'USECOND'], 'Approved message', opts)
      : conn.postToChannel(channelId, 'Approved message', opts);
  return { calls, conn, send, recover: () => { currentMode = 'success'; } };
}

for (const surface of ['dm', 'mpim', 'channel']) {
  const failures = ['info-failed', 'external-room', ...(surface === 'channel' ? ['unknown-sharing'] : ['auth-failed', 'user-failed', 'external-user', 'open-failed', 'open-empty'])];
  for (const mode of failures) test(`regression ${surface} ${mode}: no delivery attempt`, async () => {
    const h = harness(surface, mode), r = await h.send();
    assert.equal(h.calls.posts.length, 0); assert.equal(h.calls.uploads.length, 0);
    assert.equal(r.ok, false); assert.equal(r.reason, 'not_attempted');
  });
  test(`preserved ${surface} success: one post and same thread`, async () => {
    const h = harness(surface), r = await h.send({ threadTs: '100.000001', unfurl: false });
    assert.equal(r.ok, true); assert.equal(r.ref, surface === 'dm' ? 'DROOM' : surface === 'mpim' ? 'GROOM' : 'CROOM');
    assert.equal(h.calls.posts.length, 1); assert.equal(h.calls.posts[0].thread_ts, '100.000001');
  });
  test(`preserved ${surface} post exception stays uncertain`, async () => {
    const h = harness(surface, 'post-failed'), r = await h.send();
    assert.equal(h.calls.posts.length, 1); assert.equal(r.reason, 'error');
  });
}
for (const [mode, reason, count] of [
  ['private-refused', 'not_in_channel_private', 1], ['channel-missing', 'channel_not_found', 1],
  ['join-info-failed', 'error', 1], ['join-failed', 'error', 1], ['retry-failed', 'error', 2],
]) test(`preserved channel ${mode}`, async () => {
  const h = harness('channel', mode), r = await h.send(); assert.equal(r.reason, reason); assert.equal(h.calls.posts.length, count);
});
test('preserved channel public join retries successfully', async () => {
  const h = harness('channel', 'join-success'), r = await h.send(); assert.equal(r.ok, true); assert.equal(h.calls.posts.length, 2); assert.equal(h.calls.joins.length, 1);
});
for (const surface of ['dm', 'channel']) for (const mode of ['success', 'upload-failed', 'download-failed']) test(`preserved ${surface} media ${mode}: text remains delivered`, async () => {
  const h = harness(surface, mode), r = await h.send({ attachments: [{ sourceUrl: 'fixture://file', filename: 'fixture.txt' }] });
  assert.equal(r.ok, true); assert.equal(r.attachments_failed, mode === 'success' ? undefined : 1); assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.uploads.length, mode === 'download-failed' ? 0 : 1);
  if (h.calls.uploads.length) assert.equal(h.calls.uploads[0].thread_ts, '100.000002');
});
test('regression broadcast later preflight cannot erase earlier send uncertainty', async () => {
  const h = harness('dm', 'broadcast-unknown-then-refused');
  const r = await h.conn.sendBroadcast(['UCOLLEAGUE', 'USECOND'], 'Notice');
  assert.equal(h.calls.posts.length, 1); assert.equal(r.reason, 'error');
});
test('regression broadcast all preflight refusals means no attempt', async () => {
  const h = harness('dm', 'user-failed'), r = await h.conn.sendBroadcast(['UCOLLEAGUE', 'USECOND'], 'Notice');
  assert.equal(h.calls.posts.length, 0); assert.equal(r.reason, 'not_attempted');
});
test('preserved broadcast success and empty recipient refusal', async () => {
  const h = harness('dm'); assert.equal((await h.conn.sendBroadcast(['UCOLLEAGUE'], 'Notice')).ok, true);
  assert.equal((await h.conn.sendBroadcast([], 'Notice')).reason, 'no_recipients'); assert.equal(h.calls.posts.length, 1);
});
test('preserved broadcast partial success remains success', async () => {
  const h = harness('dm', 'broadcast-success-then-refused');
  assert.equal((await h.conn.sendBroadcast(['UCOLLEAGUE', 'USECOND'], 'Notice')).ok, true); assert.equal(h.calls.posts.length, 1);
});
test('preserved broadcast final uncertain send dominates initial refusal', async () => {
  const h = harness('dm', 'broadcast-refused-then-unknown');
  assert.equal((await h.conn.sendBroadcast(['UCOLLEAGUE', 'USECOND'], 'Notice')).reason, 'error'); assert.equal(h.calls.posts.length, 1);
});
test('preserved MPIM empty participants never opens or posts', async () => {
  const h = harness('mpim'); assert.equal((await h.conn.sendGroupConversation([], 'Notice')).reason, 'user_not_found');
  assert.equal(h.calls.opens.length, 0); assert.equal(h.calls.posts.length, 0);
});

// Load the existing harness without registering its separate tests. Its outreach,
// people store, jobs bridge and timer are actual code; request row persistence,
// closeRequest and the Connection registry are isolated fixtures (not live DB).
function outreachFixture() {
  const m = { exports: {} };
  vm.runInNewContext('(function(require,module,exports,__dirname){' + fs.readFileSync(path.join(__dirname, 'test-outreach-recipient-timezone.cjs'), 'utf8') + '\nmodule.exports={harness,CHRIS,SUN_EVENING,BOSTON_MON_START};})',
    { console, process, Buffer, Date, Map, Set, Promise, Error, JSON, setTimeout })(n => n === 'node:test' ? { test() {}, afterEach() {} } : require(n), m, m.exports, __dirname);
  return m.exports;
}
const outreach = outreachFixture();
for (const [surface, mode, kind] of [
  ['dm', 'open-failed', 'regression'], ['dm', 'info-failed', 'regression'], ['channel', 'info-failed', 'regression'],
  ['dm', 'external-user', 'preserved'], ['channel', 'private-refused', 'preserved'],
  ['dm', 'post-failed', 'preserved'], ['channel', 'post-failed', 'preserved'], ['dm', 'success', 'preserved'],
]) test(`${kind} connected ${surface} ${mode}: held copy lifecycle through restart`, async () => {
  const slack = harness(surface, mode);
  // The fixture's async Connection send assimilates the thenable on invocation,
  // so actual Slack runs inside the outreach send, including the restarted timer.
  const actualSend = { then(resolve, reject) { slack.send().then(resolve, reject); } };
  const connected = outreach.harness({ person: outreach.CHRIS, sendResults: [actualSend, actualSend] });
  connected.setNow(outreach.SUN_EVENING);
  await connected.tool({ await_reply: false });
  const heldId = connected.row().id;
  const result = await connected.tool({ await_reply: false, send_now: true, ...(surface === 'channel' ? { channel_id: 'CROOM' } : {}) });
  const uncertain = mode === 'post-failed', success = mode === 'success';
  if (!uncertain && !success) {
    assert.equal(result.scheduled_copy_kept, true); assert.equal(result.delivery_unconfirmed, undefined);
    assert.match(result._must_reply_with, /Nothing reached.*still stands/);
    assert.equal(connected.rowById(heldId).next_check_handler, 'send_scheduled_outreach');
    assert.equal(connected.rowById(heldId).next_check_at, outreach.BOSTON_MON_START);
    slack.recover();
    connected.restart(); connected.setNow(outreach.BOSTON_MON_START); await connected.fire(heldId);
    assert.equal(connected.rowById(heldId).state, 'resolved');
  } else {
    assert.equal(connected.rowById(heldId).state, 'cancelled'); assert.equal(connected.rowById(heldId).next_check_handler, null);
    if (uncertain) { assert.equal(result.delivery_unconfirmed, true); assert.match(result._must_reply_with, /may have reached/); }
    else assert.equal(result.sent, true);
  }
  const sends = connected.sends.length;
  connected.restart(); connected.setNow('2026-09-28T13:00:00Z'); await connected.sweep();
  assert.equal(connected.sends.length, sends);
});

for (const surface of ['dm', 'channel']) for (const outcome of ['recover', 'exhaust', 'uncertain']) test(`${outcome === 'uncertain' ? 'preserved' : 'regression'} scheduled ${surface} ${outcome}: bounded retry and terminal state`, async () => {
  const slack = harness(surface, outcome === 'uncertain' ? 'post-failed' : 'info-failed');
  const actualSend = { then(resolve, reject) { slack.send().then(resolve, reject); } };
  const h = outreach.harness({ person: outreach.CHRIS, sendResults: outcome === 'uncertain' ? [actualSend] : [actualSend, actualSend, actualSend] });
  h.setNow(outreach.SUN_EVENING);
  await h.tool({ await_reply: false, ...(surface === 'channel' ? { channel_id: 'CROOM' } : {}) });
  const heldId = h.row().id;
  h.setNow(outreach.BOSTON_MON_START); await h.fire(heldId);
  if (outcome !== 'uncertain') {
    assert.equal(slack.calls.posts.length, 0);
    assert.equal(h.rowById(heldId).next_check_handler, 'send_scheduled_outreach');
    assert.ok(h.rowById(heldId).next_check_at);
    if (outcome === 'recover') slack.recover();
    h.restart(); h.setNow(h.rowById(heldId).next_check_at); await h.fire(heldId);
    if (outcome === 'exhaust') {
      h.restart(); h.setNow(h.rowById(heldId).next_check_at); await h.fire(heldId);
      assert.equal(h.rowById(heldId).state, 'cancelled'); assert.equal(slack.calls.posts.length, 0);
      assert.ok(h.sends.some(x => x.id === 'DOWNER' && /Nothing went out/.test(x.body)));
    } else { assert.equal(h.rowById(heldId).state, 'resolved'); assert.equal(slack.calls.posts.length, 1); }
  } else { assert.equal(h.rowById(heldId).state, 'cancelled'); assert.equal(slack.calls.posts.length, 1); }
  assert.equal(h.rowById(heldId).next_check_handler, null);
  const sends = h.sends.length;
  h.restart(); h.setNow('2026-09-28T13:00:00Z'); await h.sweep(); assert.equal(h.sends.length, sends);
});
