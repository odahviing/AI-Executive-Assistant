/* Owner ruling: unanswered awaiting-owner requests auto-cancel after two
 * DELIVERED briefs. A composed or refused brief must not advance the count.
 * BRIEF_SOURCE_FIXTURE selects a preserved before revision for proof.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, afterEach } = require('node:test');

let source = fs.readFileSync(path.join(__dirname, 'test-brief-stale-closure.cjs'), 'utf8').split('\nafterEach(')[0];
const ownerPost = "if(id==='DOWNER'){effects.owner.push({id,body,opts});if(options.duringOwnerPost) row=options.duringOwnerPost(row);return {ok:true,ts:'brief.1'};}";
const ownerPostWithFailure = "if(id==='DOWNER'){effects.owner.push({id,body,opts});if(options.duringOwnerPost) row=options.duringOwnerPost(row);if(options.ownerSendFails)return {ok:false,reason:'channel_not_found'};return {ok:true,ts:'brief.1'};}";
assert.equal(source.split(ownerPost).length, 2, 'single owner delivery fixture boundary');
source = source.replace(ownerPost, ownerPostWithFailure);
const { harness } = new Function('require', '__dirname', `${source}\nreturn { harness };`)(require, __dirname);
const harnesses = [];
const make = options => {
  const h = harness(options);
  harnesses.push(h);
  return h;
};

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    assert.deepEqual(h.unexpected, [], 'unexpected dependencies must not pass silently');
  }
});

test('second delivered brief auto-cancels an unanswered approval', async () => {
  const h = make({ row: { surfaced_count: 1 } });
  await h.run();
  assert.equal(h.row().surfaced_count, 2);
  assert.equal(h.row().state, 'cancelled');
  assert.equal(h.row().closure_reason, 'surfaced_threshold');
  assert.equal(h.effects.requester.length, 1);
});

test('refused second brief does not increment or auto-cancel', async () => {
  const options = { ownerSendFails: true, row: { surfaced_count: 1 } };
  const h = make(options);
  await assert.rejects(h.run(), /Morning briefing delivery failed/);
  assert.equal(h.row().surfaced_count, 1);
  assert.equal(h.row().state, 'awaiting_owner');
  assert.equal(h.effects.requester.length, 0);
  options.ownerSendFails = false;
  await h.run();
  assert.equal(h.row().surfaced_count, 2);
  assert.equal(h.row().state, 'cancelled');
  assert.equal(h.effects.requester.length, 1);
});

test('first delivered brief remains open and records one appearance', async () => {
  const h = make({ row: { surfaced_count: 0 } });
  await h.run();
  assert.equal(h.row().surfaced_count, 1);
  assert.equal(h.row().state, 'awaiting_owner');
  assert.equal(h.effects.requester.length, 0);
});

test('non-owner-wait states never auto-cancel at the same count', async () => {
  const h = make({ row: { surfaced_count: 1, state: 'awaiting_colleague' } });
  await h.run();
  assert.equal(h.row().surfaced_count, 2);
  assert.equal(h.row().state, 'awaiting_colleague');
  assert.equal(h.effects.requester.length, 0);
});

test('second delivered brief closes a room-origin request in its original thread', async () => {
  const h = make({ row: { surfaced_count: 1, origin_is_mpim: 1, origin_channel: 'CROOM' } });
  await h.run();
  assert.equal(h.row().state, 'cancelled');
  assert.equal(h.effects.requester.length, 1);
  assert.equal(h.effects.requester[0].id, 'CROOM');
  assert.equal(h.effects.requester[0].opts.threadTs, 'origin.1');
});
