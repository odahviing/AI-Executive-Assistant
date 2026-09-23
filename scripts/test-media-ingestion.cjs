// Actual image guard/ingestion/vision and voice modules; model/network/SDK are isolated fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const prefix = 'artifacts/workshop-verification/full-review-20260919/slackmaster';
const before = process.argv.includes('--before');
const actual = ['src/utils/imageGuard.ts', 'src/vision/index.ts', 'src/voice/index.ts', 'src/connectors/slack/app/fileIngestion.ts', 'src/connectors/slack/app/handlers.ts'];
if (before) for (const rel of [...actual, 'src/connectors/slack/postReply.ts']) {
  const dest = path.join(root, prefix, 'before', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, execFileSync('git', ['show', `e760080:${rel}`], { cwd: root }));
}
const results = [];
async function check(id, fn) {
  try { await fn(); results.push({ id, result: 'pass' }); }
  catch (error) { results.push({ id, result: 'fail', error: error.message }); }
}
function fixture() {
  const state = { verdict: '{"suspicious":false}', modelError: false, imageType: 'image/png', imageSize: 3,
    http: 200, networkError: false, posts: [], shadows: [], turns: [], files: new Map(), forms: [],
    convertError: false, partialConversion: false, whisperError: false, downloads: [], jobs: [], seen: new Set(), conversionPaths: [] };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const disk = {
    writeFileSync(p, b) { state.files.set(p, Buffer.from(b)); },
    readFileSync(p) { if (!state.files.has(p)) throw Error(`ENOENT ${p}`); return state.files.get(p); },
    statSync(p) { return { size: disk.readFileSync(p).length }; },
    unlinkSync(p) { if (!state.files.delete(p)) throw Error('ENOENT'); },
    createReadStream(p) { return { readBytes: () => Buffer.from(disk.readFileSync(p)) }; },
  };
  class Form {
    constructor() { this.fields = {}; state.forms.push(this); }
    append(k, v, opts) { this.fields[k] = v; if (opts) this.fileOptions = opts; }
    getBuffer() { return this.fields.file; }
    getHeaders() { return {}; }
  }
  const mocks = {
    'src/llm/client.ts': { getAnthropicClient: () => ({ messages: { create: async () => {
      if (state.modelError) throw Error('unavailable');
      return { content: [{ type: 'text', text: state.verdict }] };
    } } }) },
    'src/llm/models.ts': { SONNET: { model: 'fixture' }, MODEL_HAIKU: 'fixture' },
    'src/utils/logger.ts': { __esModule: true, default: logger },
    'src/utils/usageLog.ts': { logLlmUsage() {} },
    'src/utils/shadowNotify.ts': { shadowNotify: async (_, input) => { state.shadows.push(input); } },
    'src/utils/attendeeScope.ts': { getOwnerDomain: () => 'example.test' },
    'src/connectors/slack/app/helpers.ts': { isOverloadError: () => false, is1on1DM: id => id.startsWith('D') },
    'src/core/threadActions.ts': {}, 'src/db.ts': {},
    'src/connectors/slack/inboundReplayRegistry.ts': { registerInboundReplay: (_id, fn) => { state.replay = fn; } },
    'src/connectors/slack/processedDedup.ts': { markProcessed: id => { if (state.seen.has(id)) return false; state.seen.add(id); return true; } },
    'src/connections/slack/eligibility.ts': { readInternalSlackConversation: async () => true },
    'src/connectors/slack/threadHistory.ts': {},
    'src/config.ts': { config: { OPENAI_API_KEY: 'fixture' } },
  };
  const external = {
    fs: disk, path, os: { tmpdir: () => '/fixture' }, 'form-data': Form,
    'ffmpeg-static': '/fixture/ffmpeg', openai: class {},
    child_process: { execFile(_bin, args, options, callback) {
      if (typeof options === 'function') callback = options;
      const child = new EventEmitter();
      state.conversionPaths.push([args[1], args.at(-1)]);
      if (!state.convertError || state.partialConversion) disk.writeFileSync(args.at(-1), disk.readFileSync(args[1]));
      queueMicrotask(() => { callback(state.convertError ? Error('conversion failed') : null, '', ''); child.emit('close'); });
      return child;
    } },
    https: { request(_opts, callback) {
      const req = new EventEmitter();
      req.write = b => { req.bytes = Buffer.from(b); };
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = state.whisperError ? 500 : 200;
        callback(res); res.emit('data', state.whisperError ? 'failed' : req.bytes.toString()); res.emit('end');
      });
      return req;
    } },
  };
  const modules = new Map();
  function load(rel) {
    if (mocks[rel]) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel).exports;
    assert.ok(actual.includes(rel), `unexpected module ${rel}`);
    const mod = { exports: {} }; modules.set(rel, mod);
    const file = before ? `${prefix}/before/${rel}` : rel;
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    function req(spec) {
      if (!spec.startsWith('.')) return external[spec] || require(spec);
      const p = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      return load(actual.includes(`${p}/index.ts`) ? `${p}/index.ts` : `${p}.ts`);
    }
    const FixedDate = class extends Date { static now() { return 1000; } };
    const fetch = async (url, opts) => {
      state.downloads.push({ url, opts });
      if (state.networkError) throw Error('network failed');
      const audio = String(url).startsWith('audio:');
      const bytes = audio ? Buffer.from(String(url).slice(6)) : Buffer.alloc(state.imageSize, 1);
      return { ok: state.http === 200, status: state.http, statusText: 'fixture',
        headers: { get: () => audio ? 'audio/webm' : state.imageType },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {
      Buffer, AbortController, Date: FixedDate, fetch, setTimeout, clearTimeout, setImmediate: fn => state.jobs.push(fn),
    }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  const ctx = { profile: { user: { email: 'owner@example.test', slack_user_id: 'UOWNER' }, assistant: { slack: { bot_token: 'fixture' } } },
    app: { client: { users: { info: async () => ({ user: { profile: { email: 'peer@example.test' } } }) } } },
    getSenderRole: id => id === 'UOWNER' ? 'owner' : 'colleague',
    resolveSlackMentions: async text => text,
    processMessage: async p => { state.turns.push(p); if (state.processError) throw Error('downstream failed'); } };
  ctx.app.message = fn => { state.dm = fn; };
  ctx.app.client.chat = { postMessage: async p => { state.posts.push(p); if (state.postError) throw Error('post failed'); } };
  ctx.scanAndPrepareImage = p => load('src/connectors/slack/app/fileIngestion.ts').scanAndPrepareImage(ctx, p);
  ctx.processImageFileShare = p => load('src/connectors/slack/app/fileIngestion.ts').processImageFileShare(ctx, p);
  async function ingest(role = 'colleague', replay = false, channel = 'D1', postFails = false) {
    const client = { chat: { postMessage: async p => { state.posts.push(p); if (postFails) throw Error('post failed'); } } };
    await load('src/connectors/slack/app/fileIngestion.ts').processImageFileShare(ctx, {
      files: [{ url_private: 'image:test', mimetype: 'image/png' }], message: { user: role === 'owner' ? 'UOWNER' : 'UPEER', text: 'מה כתוב כאן?' },
      channelId: channel, ts: 'T1', threadTs: 'T1', client, isMpim: channel === 'G1', degradeOnDownloadFailure: replay,
    });
    await Promise.resolve(); await Promise.resolve();
  }
  async function dm(overrides = {}) {
    load('src/connectors/slack/app/handlers.ts').registerDmHandler(ctx);
    const message = { user: 'UOWNER', channel: 'D1', ts: 'T1', thread_ts: 'P1', subtype: 'file_share', files: [{ mimetype: 'audio/webm', url_private: 'audio:שלום' }], ...overrides };
    await state.dm({ message, client: ctx.app.client });
    while (state.jobs.length) await state.jobs.shift()();
  }
  return { state, load, ctx, ingest, dm, config: mocks['src/config.ts'].config };
}
async function main() {
  for (const [id, verdict] of Object.entries({ object: '{}', missing: '{"reason":"ok"}', string: '{"suspicious":"false"}',
    number: '{"suspicious":0}', array: '[]', scalar: 'false' })) {
    await check(`malformed-${id}-refused`, async () => {
      const f = fixture(); f.state.verdict = verdict; await f.ingest();
      assert.equal(f.state.turns.length, 0); assert.equal(f.state.shadows.length, 0); assert.equal(f.state.posts.length, 1);
    });
  }
  for (const [id, verdict] of [['json-error', 'garbage'], ['null', 'null'], ['suspicious', '{"suspicious":true}']]) {
    await check(`${id}-colleague-refused`, async () => { const f = fixture(); f.state.verdict = verdict; await f.ingest(); assert.equal(f.state.turns.length, 0); assert.equal(f.state.posts.length, 1); });
  }
  for (const [id, verdict] of [['clean', '{"suspicious":false}'], ['fenced', '```json\n{"suspicious":false}\n```']]) {
    await check(`${id}-colleague-image-caption-preserved`, async () => {
      const f = fixture(); f.state.verdict = verdict; await f.ingest();
      assert.equal(f.state.turns.length, 1); assert.equal(f.state.turns[0].text, 'מה כתוב כאן?');
      assert.equal(f.state.turns[0].images[0].source.data, Buffer.alloc(3, 1).toString('base64'));
      assert.equal(f.state.shadows.length, 1); assert.equal(f.state.posts.length, 0);
    });
  }
  for (const [id, verdict] of [['malformed', '{}'], ['suspicious', '{"suspicious":true}']]) {
    for (const channel of ['D1', 'G1']) await check(`owner-${id}-${channel}-proceeds`, async () => {
      const f = fixture(); f.state.verdict = verdict; await f.ingest('owner', false, channel);
      assert.equal(f.state.turns.length, 1); assert.equal(f.state.turns[0].channelId, channel); assert.equal(f.state.posts.length, 0);
    });
  }
  await check('api-unavailable-colleague-refused', async () => { const f = fixture(); f.state.modelError = true; await f.ingest(); assert.equal(f.state.turns.length, 0); });
  await check('api-unavailable-owner-proceeds', async () => { const f = fixture(); f.state.modelError = true; await f.ingest('owner'); assert.equal(f.state.turns.length, 1); });
  await check('refusal-delivery-failure-still-drops', async () => { const f = fixture(); f.state.verdict = '{}'; await f.ingest('colleague', false, 'D1', true); assert.equal(f.state.turns.length, 0); });
  await check('replay-malformed-does-not-degrade', async () => { const f = fixture(); f.state.verdict = '{}'; await f.ingest('colleague', true); assert.equal(f.state.turns.length, 0); });
  await check('replay-fetch-failure-degrades-caption', async () => { const f = fixture(); f.state.http = 403; await f.ingest('colleague', true); assert.equal(f.state.turns.length, 1); assert.equal(f.state.turns[0].images.length, 0); });
  await check('live-fetch-failure-aborts', async () => { const f = fixture(); f.state.http = 403; await f.ingest(); assert.equal(f.state.turns.length, 0); });
  await check('retry-gets-new-verdict', async () => {
    const f = fixture(); f.state.verdict = '{}'; await f.ingest(); assert.equal(f.state.turns.length, 0);
    f.state.verdict = '{"suspicious":false}'; await f.ingest(); assert.equal(f.state.turns.length, 1);
  });
  for (const verdict of ['{}', '{"suspicious":false}']) await check(`channel-batch-${verdict === '{}' ? 'malformed' : 'clean'}`, async () => {
    const f = fixture(); f.state.verdict = verdict;
    const out = await f.load('src/connectors/slack/app/fileIngestion.ts').downloadAndScanImageBatch([{ url_private: 'image:test', mimetype: 'image/png' }], {
      botToken: 'fixture', senderId: 'UPEER', senderRole: 'colleague', channelId: 'C1', threadTs: 'T1',
      post: async p => f.state.posts.push(p), scanAndPrepareImage: f.ctx.scanAndPrepareImage, stopOnDownloadFailure: false,
    });
    assert.equal(out.images.length, verdict === '{}' ? 0 : 1); assert.equal(out.hadSecurityRefusal, verdict === '{}');
  });
  for (const [id, setup, expected] of [
    ['unsupported', () => {}, 'unsupported_type'], ['oversize', s => { s.imageSize = 5 * 1024 * 1024 + 1; }, 'too_large'],
    ['http', s => { s.http = 403; }, 'download_failed'], ['wrong-content', s => { s.imageType = 'text/html'; }, 'download_failed'],
    ['network', s => { s.networkError = true; }, 'download_failed'],
  ]) await check(`image-download-${id}`, async () => {
    const f = fixture(); setup(f.state); const out = await f.load('src/vision/index.ts').downloadSlackImage('image:test', 'fixture', id === 'unsupported' ? 'image/tiff' : 'image/png'); assert.equal(out.error, expected);
  });
  await check('description-unavailable-is-null', async () => { const f = fixture(); f.state.modelError = true; assert.equal(await f.load('src/vision/index.ts').describeImage({ type: 'image' }), null); });
  await check('transcript-source-language-and-format', async () => {
    const f = fixture(); const text = await f.load('src/voice/index.ts').transcribeSlackAudio('audio:  שלום  ', 'fixture', 'he', 'audio/mp4');
    assert.equal(text, 'שלום'); assert.equal(f.state.forms[0].fields.language, 'he'); assert.equal(f.state.forms[0].fileOptions.filename, 'audio.wav'); assert.equal(f.state.files.size, 0);
  });
  await check('transcript-conversion-fallback', async () => {
    const f = fixture(); f.state.convertError = true; assert.equal(await f.load('src/voice/index.ts').transcribeSlackAudio('audio:Hola', 'fixture', undefined, 'audio/mp4'), 'Hola'); assert.equal(f.state.forms[0].fileOptions.filename, 'audio.mp4'); assert.equal(f.state.files.size, 0);
  });
  await check('transcript-partial-conversion-cleanup', async () => {
    const f = fixture(); f.state.convertError = true; f.state.partialConversion = true;
    await f.load('src/voice/index.ts').transcribeSlackAudio('audio:Hola', 'fixture', undefined, 'audio/mp4'); assert.equal(f.state.files.size, 0);
  });
  await check('transcript-whisper-failure-cleanup', async () => {
    const f = fixture(); f.state.whisperError = true;
    await assert.rejects(f.load('src/voice/index.ts').transcribeSlackAudio('audio:Hello', 'fixture'), /Whisper 500/); assert.equal(f.state.files.size, 0);
  });
  await check('wav-source-output-distinct', async () => {
    const f = fixture(); await f.load('src/voice/index.ts').transcribeSlackAudio('audio:Hello', 'fixture', undefined, 'audio/wav');
    assert.notEqual(f.state.conversionPaths[0][0], f.state.conversionPaths[0][1]);
  });
  await check('concurrent-transcripts-isolated', async () => {
    const f = fixture(); const voice = f.load('src/voice/index.ts');
    const texts = await Promise.all([voice.transcribeSlackAudio('audio:OWNER-PRIVATE', 'fixture'), voice.transcribeSlackAudio('audio:PEER-PUBLIC', 'fixture')]);
    assert.deepEqual(texts, ['OWNER-PRIVATE', 'PEER-PUBLIC']); assert.equal(f.state.files.size, 0);
  });
  await check('concurrent-audio-delivery-isolated', async () => {
    const f = fixture(); const voice = f.load('src/voice/index.ts'); const calls = [];
    let release; const barrier = new Promise(resolve => { release = resolve; });
    const app = { client: { files: { uploadV2: async p => {
      calls.push(p); if (calls.length === 2) release(); await barrier;
      p.received = Buffer.isBuffer(p.file) ? p.file.toString() : p.file.readBytes().toString();
    } } } };
    await Promise.all(['OWNER-PRIVATE', 'PEER-PUBLIC'].map((text, i) => voice.sendAudioMessage({ app, botToken: 'fixture', channelId: `D${i}`, threadTs: `T${i}`, audioBuffer: Buffer.from(text) })));
    assert.deepEqual(calls.map(c => c.received), ['OWNER-PRIVATE', 'PEER-PUBLIC']);
    assert.deepEqual(calls.map(c => c.thread_ts), ['T0', 'T1']); assert.equal(f.state.files.size, 0);
  });
  await check('single-audio-upload-preserved', async () => {
    const f = fixture(); let received;
    await f.load('src/voice/index.ts').sendAudioMessage({ app: { client: { files: { uploadV2: async p => { received = Buffer.isBuffer(p.file) ? p.file.toString() : p.file.readBytes().toString(); assert.equal(p.filename, 'custom.mp3'); } } } }, botToken: 'fixture', channelId: 'D1', threadTs: 'T1', filename: 'custom.mp3', audioBuffer: Buffer.from('hello') });
    assert.equal(received, 'hello'); assert.equal(f.state.files.size, 0);
  });
  await check('audio-upload-failure-propagates', async () => {
    const f = fixture(); await assert.rejects(f.load('src/voice/index.ts').sendAudioMessage({ app: { client: { files: { uploadV2: async () => { throw Error('upload failed'); } } } }, botToken: 'fixture', channelId: 'D1', audioBuffer: Buffer.from('hello') }), /upload failed/); assert.equal(f.state.files.size, 0);
  });
  await check('audio-short-voice-only', async () => {
    const f = fixture(); const voice = f.load('src/voice/index.ts');
    assert.equal(voice.shouldRespondWithAudio({ inputWasVoice: true, responseText: 'Hello' }), true);
    assert.equal(voice.shouldRespondWithAudio({ inputWasVoice: false, responseText: 'Hello' }), false);
    assert.equal(voice.shouldRespondWithAudio({ inputWasVoice: true, responseText: Array(76).fill('word').join(' ') }), false);
  });
  for (const role of ['UOWNER', 'UPEER']) {
    for (const failure of ['missing-key', 'download', 'whisper', 'empty']) await check(`dm-${role}-${failure}-notifies`, async () => {
      const f = fixture(); if (failure === 'missing-key') f.config.OPENAI_API_KEY = '';
      if (failure === 'download') f.state.networkError = true;
      if (failure === 'whisper') f.state.whisperError = true;
      await f.dm({ user: role, files: [{ mimetype: 'audio/webm', url_private: failure === 'empty' ? 'audio: ' : 'audio:Hello' }] });
      assert.equal(f.state.turns.length, 0); assert.equal(f.state.posts.length, 1); assert.equal(f.state.posts[0].thread_ts, 'P1');
    });
  }
  await check('dm-success-transcript-context', async () => { const f = fixture(); await f.dm(); assert.equal(f.state.turns[0].text, '[Voice message]: שלום'); assert.equal(f.state.turns[0].voiceInput, true); assert.equal(f.state.turns[0].threadTs, 'P1'); assert.equal(f.state.posts.length, 0); });
  await check('dm-single-character-transcript-preserved', async () => { const f = fixture(); await f.dm({ files: [{ mimetype: 'audio/webm', url_private: 'audio:好' }] }); assert.equal(f.state.turns[0]?.text, '[Voice message]: 好'); });
  await check('dm-failure-reconnect-dedup', async () => { const f = fixture(); f.state.networkError = true; await f.dm(); await f.dm(); assert.equal(f.state.posts.length, 1); });
  await check('dm-failure-notification-unavailable', async () => { const f = fixture(); f.state.networkError = true; f.state.postError = true; await f.dm(); assert.equal(f.state.posts.length, 1); assert.equal(f.state.turns.length, 0); });
  await check('dm-downstream-failure-not-mislabeled-transcription', async () => { const f = fixture(); f.state.processError = true; await f.dm(); assert.equal(f.state.turns.length, 1); assert.equal(f.state.posts.length, 0); });
  for (const variant of ['failure', 'empty', 'caption', 'success', 'single-character']) await check(`replay-audio-${variant}`, async () => {
    const f = fixture(); f.state.networkError = variant === 'failure' || variant === 'caption';
    f.load('src/connectors/slack/app/handlers.ts').registerInboundReplayHandler(f.ctx);
    await f.state.replay({ message: { user: 'UOWNER', ts: 'T1', text: variant === 'caption' ? 'Please help' : '',
      files: [{ mimetype: 'audio/webm', url_private: `audio:${variant === 'empty' ? ' ' : variant === 'single-character' ? '好' : 'Hola'}` }] }, channelId: 'D1', postThreadTs: 'P1' });
    if (variant === 'failure' || variant === 'empty') { assert.equal(f.state.turns.length, 0); assert.equal(f.state.posts.length, 1); assert.equal(f.state.posts[0].thread_ts, 'P1'); }
    else { assert.equal(f.state.turns.length, 1); assert.equal(f.state.posts.length, 0); assert.equal(f.state.turns[0].text, variant === 'caption' ? 'Please help' : `[Voice message]: ${variant === 'single-character' ? '好' : 'Hola'}`); }
  });
  // Execute the actual private final delivery branch with actual audio uploader.
  // Unrelated postReply guards are outside this fixture (covered by prior Slack audit).
  for (const variant of ['success', 'tts-failure', 'upload-failure', 'text-failure', 'callback-failure']) await check(`reply-${variant}`, async () => {
    const f = fixture(); const voice = f.load('src/voice/index.ts');
    const rel = 'src/connectors/slack/postReply.ts';
    const source = fs.readFileSync(path.join(root, before ? `${prefix}/before/${rel}` : rel), 'utf8');
    const ast = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'sendReply');
    assert.ok(fn); const code = ts.transpileModule(`export ${fn.getText(ast)}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} }; const posts = [], uploads = [], delivered = [];
    vm.runInNewContext(code, { exports: mod.exports, config: f.config, logger: { warn() {}, debug() {}, error() {} },
      shouldRespondWithAudio: voice.shouldRespondWithAudio, sendAudioMessage: voice.sendAudioMessage,
      textToSpeech: async () => { if (variant === 'tts-failure' || variant === 'text-failure') throw Error('TTS failed'); return Buffer.from('spoken reply'); },
      require: name => { assert.equal(name, '../../utils/threadActivity'); return { recordMaelleMessage() {} }; },
    });
    const run = mod.exports.sendReply({ app: { client: { files: { uploadV2: async p => { uploads.push(p); if (variant.includes('failure') && variant !== 'callback-failure') throw Error('upload failed'); } } } },
      botToken: 'fixture', channelId: 'D1', threadTs: 'P1', voiceInput: true, cleanReply: 'reply',
      say: async p => { posts.push(p); if (variant === 'text-failure') throw Error('text failed'); return { ok: true, ts: 'A1' }; },
      onDelivered: () => { delivered.push(true); if (variant === 'callback-failure') throw Error('callback failed'); },
    });
    if (['text-failure', 'callback-failure'].includes(variant)) await assert.rejects(run); else assert.equal(await run,variant!=='upload-failure');
    assert.equal(posts.length, ['tts-failure', 'text-failure'].includes(variant) ? 1 : 0);
    assert.equal(delivered.length, ['upload-failure', 'text-failure'].includes(variant) ? 0 : 1);
    if (posts.length) assert.equal(posts[0].thread_ts, 'P1');
    if (uploads.length) assert.equal(uploads[0].thread_ts, 'P1');
  });
  const report = { mode: before ? 'before' : 'after', revision: before ? 'e760080' : 'working-tree',
    passed: results.filter(x => x.result === 'pass').length, failed: results.filter(x => x.result === 'fail').length, cases: results };
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.failed ? 1 : 0;
}
main().catch(err => { console.error(err); process.exitCode = 1; });
