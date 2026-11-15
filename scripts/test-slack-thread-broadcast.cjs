const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./test-slack-thread-boundaries.cjs');
const deliveryFixture = require('./fixtures/slack-delivery.cjs');

// Anonymized conversations.replies shape; live delivery adds a channel envelope.
const root = {
  type: 'message', subtype: 'assistant_app_thread', user: 'UBOT', ts: '10.000001',
  thread_ts: '10.000001', text: 'Nested parent content', reply_count: 1, latest_reply: '100.000001',
};
const reply = {
  type: 'message', subtype: 'thread_broadcast', ts: '100.000001', thread_ts: root.ts,
  user: 'UCOLLEAGUE', text: 'Thursday works', root, client_msg_id: 'fixture-message',
};
const dm = { ...reply, channel: 'DCOLLEAGUE', channel_type: 'im' };

function assertTurn(h, message) {
  assert.equal(h.received.length, 1);
  const [turn] = h.received;
  assert.equal(turn.senderId, message.user);
  assert.equal(turn.channelId, message.channel);
  assert.equal(turn.ts, message.ts);
  assert.equal(turn.threadTs, message.thread_ts);
  assert.equal(turn.typedText, message.text);
}

function recovery(channel, message = reply, options = {}) {
  const list = [{ id: channel, is_im: channel.startsWith('D'), is_mpim: channel === 'GROOM', is_member: true }];
  const h = harness({
    list,
    history: p => ({ ok: true, messages: p.channel === channel ? [message, root] : [] }),
    replies: p => {
      assert.equal(p.channel, channel);
      assert.equal(p.ts, root.ts);
      const participants = channel === 'CROOM' ? [{ user: 'UOWNER', ts: '20.000001', text: 'Earlier remark' }] : [];
      return { ok: true, messages: [root, ...participants, message] };
    },
    ...options,
  });
  h.handlers();
  return h;
}

async function scan(h) {
  await h.load('src/core/background.ts').catchUpMissedMessages(h.app, h.ctx.profile, 'DOWNER', 50000);
  await h.drain();
}

for (const [kind, channel, user, subtype] of [
  ['dm', 'DCOLLEAGUE', 'UCOLLEAGUE', 'thread_broadcast'],
  ['dm', 'DOWNER', 'UOWNER', 'thread_broadcast'],
  ['message', 'GROOM', 'UCOLLEAGUE', 'thread_broadcast'],
  ['message', 'CMODERN', 'UCOLLEAGUE', 'thread_broadcast'],
  ['app_mention', 'CROOM', 'UCOLLEAGUE', 'thread_broadcast'],
  ['dm', 'DCOLLEAGUE', 'UCOLLEAGUE', undefined],
]) {
  test(`live ${kind} ${channel} ${subtype || 'ordinary'} uses the author, text, and original thread`, async () => {
    const h = harness({ replies: () => ({ ok: true, messages: [{ user: 'UOWNER', ts: '20.000001' }] }) });
    const message = { ...reply, channel, user, subtype, channel_type: channel.startsWith('D') ? 'im' : channel === 'GROOM' ? 'mpim' : 'channel' };
    if (kind === 'app_mention') message.text = '<@UBOT> Thursday works';
    await h.event(kind, message);
    assertTurn(h, message);
    assert.equal(h.received[0].isMpim, ['GROOM', 'CMODERN'].includes(channel));
  });
}

test('DM broadcast reaches one queued answer under its parent', async () => {
  const h = harness({ actualProcessor: true });
  const ownerReply = { ...dm, channel: 'DOWNER', user: 'UOWNER' };
  await h.event('dm', ownerReply);
  await h.event('dm', { ...ownerReply, subtype: undefined, root: undefined });
  await h.fire();
  assertTurn(h, ownerReply);
  assert.equal(h.runs.length, 1);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].thread_ts, root.ts);
});

test('MPIM broadcast addressed to another person stays quiet', async () => {
  const h = harness({ actualProcessor: true, addressee: 'HUMAN' });
  await h.event('message', { ...reply, channel: 'GROOM', channel_type: 'mpim' });
  assert.equal(h.classifications.length, 1);
  assert.equal(h.runs.length, 0);
  assert.equal(h.posts.length, 0);
});

test('channel broadcast needs a current mention even when the root mentions Maelle', async () => {
  const h = harness();
  await h.event('message', { ...reply, channel: 'CROOM', channel_type: 'channel', root: { ...root, text: '<@UBOT>' } });
  assert.equal(h.received.length, 0);
});

test('mentioned colleague channel broadcast needs owner participation live and in recovery', async () => {
  const message = { ...reply, channel: 'CROOM', text: '<@UBOT> Please schedule' };
  const h = recovery('CROOM', message, { replies: () => ({ ok: true, messages: [root, message] }) });
  await h.event('app_mention', message);
  await scan(h);
  assert.equal(h.received.length, 0);
});

test('channel colleague broadcast with unavailable thread participants stays quiet', async () => {
  const h = harness({ replies: () => { throw Error('unavailable'); } });
  await h.event('app_mention', { ...reply, channel: 'CROOM', text: '<@UBOT> Please schedule' });
  assert.equal(h.received.length, 0);
});

for (const [label, fields] of Object.entries({
  bot: { bot_id: 'BOTHER' }, botProfile: { bot_profile: { id: 'BOTHER' } }, ownBot: { user: 'UBOT' },
  app: { app_id: 'AOTHER' }, hidden: { hidden: true }, empty: { text: ' ' },
  missingParent: { thread_ts: undefined }, selfParent: { thread_ts: reply.ts },
  invalidParent: { thread_ts: 'invalid' }, media: { files: [{ mimetype: 'image/png' }] },
})) {
  test(`broadcast ${label} withheld on DM, MPIM and mention delivery`, async () => {
    for (const [kind, channel] of [['dm', 'DCOLLEAGUE'], ['message', 'GROOM'], ['app_mention', 'CROOM']]) {
      const h = harness({ replies: () => ({ ok: true, messages: [{ user: 'UOWNER', ts: '20.000001' }] }) });
      await h.event(kind, { ...reply, channel, text: '<@UBOT> question', ...fields });
      assert.equal(h.received.length, 0, kind);
    }
  });
}

test('system edit and nested author do not enter DM or MPIM processing', async () => {
  for (const [kind, channel] of [['dm', 'DCOLLEAGUE'], ['message', 'GROOM']]) {
    const h = harness();
    await h.event(kind, { ...reply, channel, subtype: 'message_changed' });
    assert.equal(h.received.length, 0);
  }
});

test('unavailable or external conversation metadata withholds live broadcast', async () => {
  for (const [options, channel] of [[{ infoFails: true }, 'DCOLLEAGUE'], [{}, 'DEXTERNAL'], [{}, 'GSHARED']]) {
    const h = harness(options);
    await h.event(channel.startsWith('D') ? 'dm' : 'message', { ...reply, channel });
    assert.equal(h.received.length, 0);
  }
});

for (const [channel, text] of [['DCOLLEAGUE', 'Thursday works'], ['GROOM', 'Thursday works'], ['CROOM', '<@UBOT> Thursday works']]) {
  test(`recovery ${channel} uses one canonical root for broadcast and parent history rows`, async () => {
    const message = { ...reply, text, channel };
    const h = recovery(channel, message);
    await scan(h);
    assertTurn(h, message);
    assert.equal(h.calls.filter(c => c[0] === 'replies').length, 1);
    assert.equal(!!h.received[0].isChannel, channel === 'CROOM');
    assert.equal(!!h.received[0].isMpim, channel === 'GROOM');
  });
}

for (const order of ['live-first', 'recovery-first']) {
  test(`${order} and socket redelivery yield one broadcast turn`, async () => {
    const h = recovery(dm.channel);
    if (order === 'live-first') await h.event('dm', dm);
    await scan(h);
    await h.event('dm', dm);
    assertTurn(h, dm);
  });
}

test('recovery withholds unmentioned channel replies, cross-thread rows and unavailable history', async () => {
  for (const [channel, message, options] of [
    ['CROOM', reply, {}],
    ['DCOLLEAGUE', { ...reply, thread_ts: '20.000001' }, { history: () => ({ ok: true, messages: [root] }) }],
    ['DCOLLEAGUE', reply, { replies: () => ({ ok: true, messages: [root, reply], has_more: true }) }],
    ['DCOLLEAGUE', { ...reply, bot_id: 'BOTHER' }, {}],
  ]) {
    const h = recovery(channel, message, options);
    await scan(h);
    assert.equal(h.received.length, 0);
  }
});

test('recovery leaves an acknowledged or answered broadcast closed', async () => {
  for (const rows of [
    [root, { ...reply, reactions: [{ name: '+1', users: ['UBOT'] }] }],
    [root, reply, { ts: '101.000001', bot_id: 'BBOT', user: 'UBOT', text: 'Confirmed' }],
  ]) {
    const h = recovery(dm.channel, reply, { replies: () => ({ ok: true, messages: rows }) });
    await scan(h);
    assert.equal(h.received.length, 0);
  }
});

for (const status of ['unknown', 'confirmed', 'failed']) {
  test(`restart with ${status} delivery uses the original reply timestamp`, async t => {
    const delivery = deliveryFixture();
    t.after(() => delivery.db.close());
    const input = { profileId: 'UOWNER', channelId: dm.channel, threadTs: root.ts, inboundTs: [dm.ts] };
    const claim = delivery.api.beginSlackDelivery({ ...input, nextCheckAt: Date.now() + 600000 });
    delivery.api.resolveSlackDelivery({ ...input, attemptId: claim.attemptId, expectedStatus: 'sending', status, nextCheckAt: Date.now() + 600000 });
    const h = recovery(dm.channel, reply, { delivery });
    await scan(h);
    await h.event('dm', dm);
    if (status === 'failed') assertTurn(h, dm);
    else assert.equal(h.received.length, 0);
  });
}
