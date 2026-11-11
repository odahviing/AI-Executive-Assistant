const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./test-slack-thread-boundaries.cjs');

const file = { name: 'notes-from-editor@example.test.txt', mimetype: 'text/plain' };
const body = 'Meeting notes for reader@example.test';
const voice = { mimetype: 'audio/webm', url_private: 'fixture:recording' };
const firstTs = '100.000001';

function setup(autoResolve = false) {
  const h = harness({ actualProcessor: true, autoResolve });
  Object.assign(h.load('src/connectors/slack/app/fileIngestion.ts'), {
    isSlackDocFile: f => f.mimetype === 'text/plain',
    isSlackImageFile: () => false,
    extractSlackDocText: async () => ({ ok: true, text: body, truncated: false }),
    downloadAndScanImageBatch: async () => ({ images: [], imageUrls: [] }),
  });
  h.load('src/config.ts').config.OPENAI_API_KEY = 'fixture';
  h.load('src/voice.ts').transcribeSlackAudio = async () => 'Recorded by narrator@example.test';
  return h;
}

// The preceding implementation supplied rawUserMessage for both purposes.
const literalInput = turn => turn.typedUserMessage ?? turn.rawUserMessage;

test('ordinary owner text preserves the explicit address', async () => {
  const h = setup();
  const text = 'Contact editor@example.test';
  await h.event('dm', { text });
  await h.fire();
  assert.equal(literalInput(h.runs[0]), text);
  assert.equal(h.runs[0].userMessage, text);
});

for (const caption of ['', 'Read the notes', 'Discuss with editor@example.test']) {
  test(`owner DM document limits literal input to caption "${caption}" and preserves its full text in history`, async () => {
    const h = setup();
    const event = { text: caption, subtype: 'file_share', files: [file] };
    await h.event('dm', event);
    await h.event('dm', event);
    await h.fire();
    assert.equal(h.runs.length, 1);
    assert.equal(h.posts.length, 1);
    const turn = h.runs[0];
    const expected = (caption || '[Owner uploaded a file with no caption.]') +
      '\n\n[Attached file: ' + file.name + ']\n' + body;
    assert.equal(turn.userMessage, expected);
    assert.equal(h.db.get(firstTs)[0].content, expected);
    assert.equal(literalInput(turn), caption);
  });
}

test('unreadable document emits its existing notice without starting a turn', async () => {
  const h = setup();
  h.load('src/connectors/slack/app/fileIngestion.ts').extractSlackDocText =
    async () => ({ ok: false, reason: 'download' });
  await h.event('dm', { text: '', subtype: 'file_share', files: [file] });
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].text, /Couldn't open/);
  assert.equal(h.received.length, 0);
});

for (const replay of [false, true]) {
  for (const caption of ['', 'Filed by editor@example.test']) {
    test(`${replay ? 'replayed' : 'live'} voice preserves its transcript and literal caption "${caption}"`, async () => {
      const h = setup();
      const message = { user: 'UOWNER', ts: firstTs, text: caption, subtype: 'file_share', files: [voice] };
      if (replay) {
        h.handlers();
        await h.load('src/connectors/slack/inboundReplayRegistry.ts').getInboundReplay('UOWNER')({
          message, channelId: 'DOWNER', postThreadTs: firstTs, source: 'dm',
        });
        await h.drain();
      } else {
        await h.event('dm', message);
      }
      await h.fire();
      assert.equal(h.runs[0].userMessage, '[Voice message]: Recorded by narrator@example.test');
      assert.equal(h.runs[0].rawUserMessage, h.runs[0].userMessage);
      assert.equal(literalInput(h.runs[0]), caption);
    });
  }
}

test('channel mention keeps file and resolved names available with native event text separately', async () => {
  const h = setup();
  h.ctx.resolveSlackMentions = async text => text.replace('<@UEDITOR>', 'Editor (slack_id: UEDITOR)');
  const text = '<@UBOT> share the notes with <@UEDITOR>';
  await h.event('app_mention', { text, files: [file] });
  await h.fire();
  const turn = h.runs[0];
  assert.ok(turn.userMessage.includes(file.name));
  assert.ok(turn.userMessage.includes(body));
  assert.ok(turn.rawUserMessage.includes('Editor (slack_id: UEDITOR)'));
  assert.equal(literalInput(turn), text);
});

test('merged same-sender messages retain the literal fragments including a document caption', async () => {
  const h = setup();
  await h.event('dm', { text: 'Read the notes', subtype: 'file_share', files: [file] });
  await h.event('dm', { ts: '101.000001', text: 'Ask editor@example.test' });
  await h.fire();
  assert.equal(h.runs.length, 1);
  assert.ok(h.runs[0].userMessage.includes(body));
  assert.equal(literalInput(h.runs[0]), 'Read the notes\n\nAsk editor@example.test');
});

test('merged MPIM turns have no single-sender literal authority', async () => {
  const h = setup(true);
  await h.event('app_mention', { channel: 'GROOM', user: 'UCOLLEAGUE', text: '<@UBOT> contact editor@example.test' });
  await h.event('app_mention', { channel: 'GROOM', thread_ts: firstTs, ts: '101.000001', text: '<@UBOT> hello' });
  await h.fire();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].authority, 'colleague');
  assert.equal(h.resolutions.length, 0);
  assert.ok(h.runs[0].userMessage.includes('editor@example.test'));
  assert.equal(literalInput(h.runs[0]), '');
});

for (const [kind, attachment, caption, content] of [
  ['document', file, 'Yes', body],
  ['uncaptioned document', file, '', body],
  ['voice', voice, '', 'Recorded by narrator@example.test'],
]) {
  test(`thread-bound shortcut carries literal and classifier inputs for ${kind}`, async () => {
    const h = setup(true);
    const calls = [];
    h.load('src/utils/threadBoundApprovalAutoResolve.ts').tryAutoResolveThreadBoundApproval = async args => {
      calls.push(args);
      return { resolved: false };
    };
    await h.event('dm', { text: caption, subtype: 'file_share', files: [attachment] });
    await h.fire();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].message.includes(content));
    assert.equal(calls[0].typedUserMessage, caption);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].typedUserMessage, caption);
  });
}

test('ordinary owner Yes continues through the actual bound approval helper once', async () => {
  const h = setup(true);
  await h.event('dm', { text: 'Yes' });
  await h.fire();
  assert.equal(h.resolutions.length, 1);
  assert.equal(h.runs.length, 0);
  assert.ok(h.calls.some(([kind, args]) => kind === 'react' && args.name === 'white_check_mark'));
});
