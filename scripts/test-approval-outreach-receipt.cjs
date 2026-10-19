// Real resolver/replay/closure/receipt/runner modules. Reuse the existing strict
// lifecycle fixture; only DB, transport, domain executor and model output are fake.
// MAELLE_BOUNCE_SOURCE_ROOT selects the preserved source snapshot.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const fixture = { exports: {} };
const fixtureSource = fs.readFileSync(path.join(__dirname, 'test-requester-relay-cap-resolver.cjs'), 'utf8');
vm.runInNewContext('(function(require,module,exports,__dirname){' + fixtureSource + '\nmodule.exports={harness};})',
  { console, process, Date, Map, Set, Buffer, setTimeout, setImmediate })(
  name => name === 'node:test' ? { test() {} } : require(require.resolve(name, { paths: [__dirname] })),
  fixture, fixture.exports, __dirname);
const { harness } = fixture.exports;
const action = (recipient = 'COLLEAGUE', message = 'Published post: https://lnkd.in/p/example') => ({
  tool: 'message_colleague', args: { colleague_slack_id: recipient, colleague_name: 'Paul', message, await_reply: false },
});
function setup(options = {}) {
  return harness({ ...options, execution: options.execution || { status: 'completed', result: { ok: true, sent: true } },
    row: { subkind: 'freeform', details_json: JSON.stringify({ question: 'Will you write the draft?', deferred_action: action() }), ...options.row } });
}
for (const room of [false, true]) test(`confirmed direct requester message is the sole close-loop (${room ? 'room' : 'dm'} origin)`, async () => {
  const h = setup({ row: { origin_is_mpim: room ? 1 : 0, origin_channel: room ? 'CROOM' : 'DPAUL' } });
  const r = await h.resolve();
  assert.equal(r.ok, true); assert.equal(h.effects.executes.length, 1);
  assert.equal(h.effects.sends.length, 0, 'no second decision notice');
  assert.ok(h.row().requester_notified_at); assert.equal(r.requester_notify_outcome, 'sent');
  assert.equal(r.action_summary, 'Message delivered to Paul.');
  assert.equal(h.row().next_check_handler, null); assert.equal(h.row().state, 'resolved');
  await h.resolve(); await h.sweep(); assert.equal(h.effects.executes.length, 1); assert.equal(h.effects.sends.length, 0);
  const restarted = setup({ row: JSON.parse(JSON.stringify(h.row())) });
  await restarted.resolve(); await restarted.sweep(); assert.equal(restarted.effects.executes.length, 0); assert.equal(restarted.effects.sends.length, 0);
  h.check(); restarted.check();
});
test('partial attachments retain text receipt and surface only partial completion', async () => {
  const h = setup({ execution: { status: 'completed', result: { ok: true, sent: true, attachments_failed: 2 } } });
  const r = await h.resolve(); assert.equal(h.effects.sends.length, 0); assert.ok(h.row().requester_notified_at);
  assert.match(r.action_summary, /2 attachment\(s\) failed/); assert.doesNotMatch(r.action_summary, /approved|published/); h.check();
});
test('delivery of wrong content establishes only delivery, never correctness or publishing', async () => {
  const bad = action('COLLEAGUE', 'Stale draft to publish tomorrow: Register here https://lnkd.in/p/example');
  const h = setup(); const r = await h.resolve({ verdict: 'approve', data: bad });
  assert.equal(h.effects.executes[0].args.message, bad.args.message, 'resolver cannot silently rewrite an explicit decision');
  assert.equal(r.action_summary, 'Message delivered to Paul.');
  assert.doesNotMatch(r.action_summary, /approved|published|correct|tomorrow/); assert.equal(h.effects.sends.length, 0); h.check();
});
test('control explicit current owner action and distinct link purposes survive exact replay', async () => {
  const current = action('COLLEAGUE', 'Already published: https://lnkd.in/p/example\nOriginal registration page: https://example.test/webinar');
  const h = setup(); const r = await h.resolve({ verdict: 'approve', data: current });
  assert.equal(r.ok, true); assert.equal(h.effects.executes[0].args.message, current.args.message);
  assert.equal(JSON.parse(h.row().details_json).deferred_action.args.message, current.args.message); h.check();
});
test('control different recipient still receives separate requester decision notice', async () => {
  const h = setup(); const r = await h.resolve({ verdict: 'approve', data: action('SOMEONE_ELSE', 'Private recipient content') });
  assert.equal(r.ok, true); assert.equal(h.effects.sends.length, 1); assert.equal(h.effects.sends[0].id, 'COLLEAGUE');
  assert.doesNotMatch(h.effects.sends[0].body, /Private recipient content/); assert.ok(h.row().requester_notified_at); h.check();
});
test('control scheduled message does not pretend requester received it', async () => {
  const h = setup({ execution: { status: 'tracked', result: { ok: true, scheduled: true, jobId: 'out_later' } } });
  const r = await h.resolve(); assert.equal(h.effects.sends.length, 1); assert.match(r.effect, /not completed/);
  assert.equal(r.action_summary, undefined); h.check();
});
test('control explicit send failure retains pending decision without successful notice', async () => {
  const h = setup({ execution: { status: 'failed', result: { ok: false, error: 'not_in_channel' } } });
  const r = await h.resolve(); assert.equal(r.ok, false); assert.equal(h.row().state, 'awaiting_owner');
  assert.equal(h.effects.sends.length, 0); assert.ok(!h.row().requester_notified_at); assert.equal(r.action_summary, undefined); h.check();
});
test('control unknown outcome is terminal, warns honestly and never repeats the action', async () => {
  const h = setup({ execution: { status: 'failed', result: { error: 'replay_unconfirmed' } } });
  const r = await h.resolve(); assert.equal(r.ok, false); assert.equal(h.row().state, 'resolved');
  assert.equal(r.action_summary, undefined); assert.match(r.reason, /not sure|unconfirmed/);
  await h.resolve(); assert.equal(h.effects.executes.length, 1); h.check();
});
test('control absent private execution surface never sends or claims delivery', async () => {
  const h = setup({ row: { owner_dm_channel: null, owner_dm_thread_ts: null } });
  const r = await h.resolve(); assert.equal(r.ok, false); assert.equal(h.effects.executes.length, 0);
  assert.equal(h.effects.sends.length, 0); assert.equal(r.action_summary, undefined); h.check();
});
test('control owner-only request owes no requester relay', async () => {
  const h = setup({ row: { requester_slack_id: null } }); const r = await h.resolve();
  assert.equal(r.ok, true); assert.equal(r.requester_notify_outcome, 'no_requester'); assert.equal(h.effects.sends.length, 0); h.check();
});
test('control colleague acceptance does not expose the owner execution summary', async () => {
  const h = setup({ row: { state: 'awaiting_colleague' } });
  const r = await h.resolve({ verdict: 'approve' }, { resolvedByColleague: true, resolvingUserId: 'COLLEAGUE' });
  assert.equal(r.ok, true); assert.equal(r.action_summary, undefined); h.check();
});
