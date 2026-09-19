// Actual news tool -> orchestrator -> Slack postReply -> seen writer; closed I/O.
// NEWS_DELIVERY_BEFORE=1 replays preserved pre-delivery orchestrator/postReply.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const before = process.env.NEWS_DELIVERY_BEFORE === '1';
const evidence = 'artifacts/workshop-verification/news-20260919/delivery';
const captures = [];
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(options = {}) {
  const state = { searches: [], models: [], writes: [], posts: [], history: [], unexpected: [], cached: 0, delivered: 0, log: '' };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const profile = { user: { name: 'News Fixture', slack_user_id: 'U_OWNER', email: 'owner@example.test', timezone: 'UTC' }, assistant: { slack: { bot_token: 'fixture' } } };
  function load(rel, deps, globals = {}, instrument = text => text) {
    const replacement = before && ({ 'src/core/orchestrator/index.ts': 'index.ts', 'src/connectors/slack/postReply.ts': 'postReply.ts', 'src/tasks/dispatchers/routine.ts': 'routine.ts', 'src/core/requests/runner.ts': 'runner.ts', 'src/connectors/whatsapp.ts': 'whatsapp.ts' })[rel];
    const file = path.join(root, replacement ? `${evidence}/before/${replacement}` : rel);
    const code = ts.transpileModule(instrument(fs.readFileSync(file, 'utf8')), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, Date, URL, Intl, Set, Map, Buffer, structuredClone, setTimeout, clearTimeout,
      require: name => { if (Object.hasOwn(deps, name)) return deps[name]; state.unexpected.push(name); throw Error(`Forbidden dependency ${name}`); }, ...globals }, { filename: file });
    return exports;
  }
  const candidates = options.candidates ?? [
    { url: 'https://daily.example/report', title: 'SHOWN', content: 'Shown evidence' },
    { url: 'https://daily.example/unshown', title: 'UNSHOWN', content: 'Unshown evidence' },
  ];
  const news = load('src/skills/news.ts', {
    fs: { existsSync: () => !!state.log, mkdirSync() {}, readFileSync: () => state.log,
      promises: { writeFile: async (_p, text) => { if (options.writeFail) throw Error('disk full'); state.log = text; state.writes.push(text); } } },
    path, luxon: { DateTime }, '../llm/models': { MODEL_HAIKU: 'fixture' },
    '../llm/client': { getAnthropicClient: () => ({ messages: { create: async req => { state.models.push(req); return { content: [{ type: 'text', text: '- Shown story [daily.example]' }] }; } } }) },
    './general': { tavilySearch: async (...args) => { state.searches.push(args); return { results: candidates }; } },
    '../utils/skillPreferences': { readSkillPreferences: () => '', readSkillPreferencesSnapshot: () => ({ ok: true, text: '', revision: 'fixture', exists: false }), formatSkillPreferencesBlock: () => '' },
    '../utils/logger': logger, '../utils/extractJson': { extractFirstJsonObject: text => text },
  }, { process: { cwd: () => '/isolated-news-delivery' } });
  const helpers = load('src/core/orchestrator/turnHelpers.ts', {
    luxon: { DateTime }, '../../llm/client': { getAnthropicClient: () => ({}) }, '../../utils/usageLog': { logLlmUsage() {} },
    '../../utils/logger': logger, '../../utils/attendeeAvailability': { ATTENDEE_REASON_PREFIXES: [] },
  });
  const cache = load('src/utils/toolCallCache.ts', { crypto: require('node:crypto'), './logger': logger });
  const status = load('src/utils/toolStatusText.ts', {});
  let calls = 0, output, deliveredCallback;
  const steps = options.steps ?? [{ topic: 'Market news', preferred_domains: [], avoid_domains: [] }];
  const orchestrator = load('src/core/orchestrator/index.ts', {
    'node:util': require('node:util'), luxon: { DateTime }, '../../utils/logger': logger,
    '../../utils/detectMessageLanguage': { detectMessageLanguage: () => 'English' },
    '../../skills/registry': { WRITE_TOOLS: new Set(), executeSkillTool: (name, args, ctx) => options.toolError ? { error: 'unavailable' } : new news.NewsSkill().executeToolCall(name, args, ctx) },
    '../../db': { auditLog() {}, recordSocialMoment() {} },
    './turnHelpers': { ...helpers, callClaude: async () => { const args = steps[calls++]; return args
      ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tool-${calls}`, name: 'news', input: args }] }
      : { stop_reason: 'end_turn', content: [{ type: 'text', text: options.reply ?? '<https://daily.example/report|Report>' }] }; } },
    './buildTurnContext': { buildTurnContext: async input => ({ messages: [], systemBlocks: [], tools: [], model: 'fixture', maxTokens: 100,
      turnSenderRole: input.senderRole, turnPersonSlackId: input.userId, socialActive: false,
      socialClassification: { kind: 'task', conversation_state: 'closing' }, resolvedMeetingAttendees: [], availabilityPrecheckToolSummaries: [] }) },
    '../../utils/turnCache': { withTurnCache: fn => fn() }, '../../utils/rateLimit': { checkAndRecord: () => ({ allowed: true }) },
    '../../utils/toolCallCache': { ...cache, lookupRecentToolCall: p => { const hit = cache.lookupRecentToolCall(p); if (hit) state.cached++; return hit; } },
    '../../utils/toolStatusText': status, '../../connections/slack/messaging': { setAssistantStatus: async () => {} },
    '../../utils/offeredSlotsStash': { clearOfferedSlots() {} }, '../../utils/threadEventLedger': { recordThreadEvent() {}, recordViewedThreadEvents() {}, forgetThreadEvent() {} },
    '../requests/maybeOpenInFlightMeetingRequest': { maybeOpenInFlightMeetingRequest() {} }, '../requests/colleagueOofReengage': { maybeTrackColleagueOofDeadEnd: async () => {} },
    '../../utils/closeLoopOnOwnerHandled': { closeLoopOnOwnerHandled: async () => ({ scanned: false }) }, '../social/logEngagement': { adjustRankFromColleagueResponse() {} },
    '../social/stateMachine': { directiveForProactiveSlot: () => ({ mode: 'none' }) },
  });
  const post = load('src/connectors/slack/postReply.ts', {
    '../../utils/logger': logger, '../../db': { appendToConversation: (...args) => { state.history.push(args); if (options.historyFail) throw Error('history unavailable'); } },
    '../../connections/slack/formatting': { formatForSlack: text => text }, '../../connections/slack/messaging': { setAssistantStatus: async () => {} },
    '../../config': { config: { OPENAI_API_KEY: 'fixture' } },
    '../../voice': { shouldRespondWithAudio: p => p.inputWasVoice, textToSpeech: async () => 'audio', sendAudioMessage: async () => { if (options.audioFail) throw Error('audio failed'); } },
    '../../utils/guards/runOutputGates': { runDeliberationGuard: async text => text, runOutputGates: async text => options.rewrite ?? text, runCodaGates: async () => ({ ship: false }) },
    './inboundQueue': { getThreadInboundRevision: () => 0, isThreadActive: () => false },
    '../../utils/threadActivity': { getLastMaelleMessage: () => null, recordMaelleMessage() {} },
    '../../core/social/generateCoda': { composeSocialCoda: async () => null }, '../../core/social/stateMachine': { isSocialInitiationDue: () => false },
    '../../core/social/logEngagement': { recordCodaDelivered() {}, reserveCodaAttempt() {} },
    '../../utils/shadowNotify': { shadowNotify: async () => {} }, '../../skills/news': news,
  }, { captureDelivery: callback => { deliveredCallback = callback; } }, text => text.replace('  // Step 4.5', '  captureDelivery(onDelivered);\n  // Step 4.5'));
  return { state, profile, news, load, logger, output: () => output,
    async gather(overrides = {}) { output = await orchestrator.runOrchestrator({ userMessage: 'Show news', conversationHistory: [], threadTs: 'T1', channelId: 'D_OWNER',
      userId: 'U_OWNER', senderRole: 'owner', authority: 'owner', surface: 'owner_dm', channel: 'slack', profile, ...overrides }); await flush(); return output; },
    async deliver(overrides = {}) { await post.postOrchestratorReply({ app: { client: { reactions: { add: async () => ({ ok: true }) } } }, profile, result: output,
      say: async msg => { state.posts.push(msg); if (options.sendThrows) throw Error('unknown delivery'); if (options.sendRejects) return { ok: false }; if (options.sendUnknown) return undefined; return { ok: true, ts: '1.2' }; },
      role: 'owner', senderId: 'U_OWNER', channelId: 'D_OWNER', threadTs: 'T1', history: [], userMessage: 'Show news', onDelivered: () => state.delivered++, ...overrides }); await flush(); },
    async duplicateCallback() { deliveredCallback?.('<https://daily.example/report|Report>'); await flush(); },
    check() { assert.deepEqual(state.unexpected, []); },
  };
}
test('actual tool-to-delivery logs only final cited subset, never prelogs candidates', async () => {
  const f = fixture(); const out = await f.gather(); assert.equal(f.state.writes.length, 0); assert.equal(f.state.models.length, 0);
  assert.equal(out.newsBundle.sources.length, 2); await f.deliver(); assert.equal(f.state.writes.length, 1); assert.equal(f.state.models.length, 1);
  const prompt = JSON.stringify(f.state.models[0]); assert.ok(prompt.includes('SHOWN')); assert.ok(!prompt.includes('UNSHOWN'));
  await f.duplicateCallback(); assert.equal(f.state.writes.length, 1); assert.equal(f.state.delivered, 1); f.check(); captures.push({ name: 'shown-subset', ...f.state });
});
test('multiple real calls and cache hits combine into one delivered summary', async () => {
  const first = { topic: 'Market news', preferred_domains: [], avoid_domains: [] };
  const f = fixture({ steps: [first, first, { ...first, topic: 'Other news' }] });
  const out = await f.gather(); assert.equal(f.state.cached, 1); assert.equal(f.state.searches.length, 2); assert.equal(out.newsBundle.sources.length, 6);
  await f.deliver(); assert.equal(f.state.models.length, 1); assert.equal(f.state.writes.length, 1); assert.equal((JSON.stringify(f.state.models[0]).match(/SHOWN/g) ?? []).length, 1); f.check();
});
for (const [name, opts] of [['removed by output gate', { rewrite: 'No relevant report.' }], ['different article citation', { rewrite: '<https://daily.example/report-2|Other>' }], ['no URL', { reply: 'A short report.' }], ['empty reply', { reply: '' }]]) {
  test(`no seen write when ${name}`, async () => { const f = fixture(opts); await f.gather(); await f.deliver(); assert.equal(f.state.writes.length, 0); assert.equal(f.state.models.length, 0); f.check(); });
}
for (const [name, opts] of [['explicit rejection', { sendRejects: true }], ['unknown thrown outcome', { sendThrows: true }], ['unconfirmed response', { sendUnknown: true }]]) {
  test(`no seen write after ${name}`, async () => { const f = fixture(opts); await f.gather(); if (opts.sendUnknown) await f.deliver(); else await assert.rejects(f.deliver()); await flush(); assert.equal(f.state.writes.length, 0); assert.equal(f.state.models.length, 0); f.check(); });
}
test('post-gate changed citation chooses the delivered article', async () => {
  const f = fixture({ rewrite: '<https://daily.example/unshown|Different final source>' }); await f.gather(); await f.deliver();
  assert.equal(f.state.writes.length, 1); assert.ok(JSON.stringify(f.state.models[0]).includes('UNSHOWN')); assert.ok(!JSON.stringify(f.state.models[0]).includes('Shown evidence')); f.check();
});
test('long text uses actual same send path and confirms once', async () => { const f = fixture({ reply: 'Report text. '.repeat(500) + '<https://daily.example/report|Source>' }); await f.gather(); await f.deliver(); assert.equal(f.state.posts.length, 1); assert.equal(f.state.writes.length, 1); f.check(); });
for (const [name, overrides] of [['room', { surface: 'room', isChannel: true }], ['colleague', { authority: 'colleague', senderRole: 'colleague', userId: 'U_COLLEAGUE', surface: 'colleague_dm' }], ['email', { channel: 'email' }]]) {
  test(`orchestrator metadata withheld for ${name}`, async () => { const f = fixture(); const out = await f.gather(overrides); assert.equal(out.newsBundle, undefined); assert.equal(f.state.writes.length, 0); f.check(); });
}
test('WhatsApp owner turn carries the same ephemeral candidates', async () => { const f = fixture(); const out = await f.gather({ channel: 'whatsapp' }); assert.equal(out.newsBundle.sources.length, 2); assert.equal(f.state.writes.length, 0); f.check(); });
for (const [name, overrides] of [['MPIM', { isMpim: true }], ['channel', { isChannel: true }], ['colleague', { role: 'colleague', senderId: 'U_COLLEAGUE' }], ['mismatched authenticated sender', { senderId: 'U_OTHER' }]]) {
  test(`delivery refuses seen metadata on ${name}`, async () => { const f = fixture(); await f.gather(); await f.deliver(overrides); assert.equal(f.state.writes.length, 0); f.check(); });
}
test('tool failure has no candidate metadata', async () => { const f = fixture({ toolError: true }); assert.equal((await f.gather()).newsBundle, undefined); await f.deliver(); assert.equal(f.state.writes.length, 0); f.check(); });
test('audio lacks displayed citations; failed audio falling back to text records cited text', async () => {
  const audio = fixture(); await audio.gather(); await audio.deliver({ voiceInput: true }); assert.equal(audio.state.writes.length, 0); audio.check();
  const text = fixture({ audioFail: true }); await text.gather(); await text.deliver({ voiceInput: true }); assert.equal(text.state.writes.length, 1); text.check();
});
test('bookkeeping failure cannot retry successful delivery', async () => { const f = fixture({ writeFail: true }); await f.gather(); await f.deliver(); assert.equal(f.state.posts.length, 1); assert.equal(f.state.delivered, 1); assert.equal(f.state.writes.length, 0); f.check(); });
test('history bookkeeping failure still records confirmed news without a second post', async () => { const f = fixture({ historyFail: true }); await f.gather(); await assert.rejects(f.deliver()); await flush(); assert.equal(f.state.posts.length, 1); assert.equal(f.state.delivered, 1); assert.equal(f.state.writes.length, 1); f.check(); });
test('legitimate non-news reply preserves delivery without seen writes', async () => { const f = fixture({ steps: [], reply: 'Regular answer.' }); await f.gather(); await f.deliver(); assert.equal(f.state.posts.length, 1); assert.equal(f.state.history.length, 1); assert.equal(f.state.writes.length, 0); f.check(); });

function selectFunctions(names, extra = '') {
  return text => {
    const tree = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
    const selected = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
    assert.equal(selected.length, names.length);
    return selected.map(node => node.getText(tree)).join('\n') + `\n${extra}\nexport { ${names.join(', ')} };`;
  };
}
function formatting(f, transform = text => text) {
  return f.load('src/connections/slack/formatting.ts', { '../../utils/textScrubber': { scrubInternalLeakage: transform } });
}
for (const mode of ['edit', 'fresh', 'fallback', 'failed', 'unknown', 'silent', 'stripped', 'room', 'write-failure']) {
  test(`routine actual dispatcher ${mode}`, async () => {
    const f = fixture({ writeFail: mode === 'write-failure', ...(mode === 'silent' ? { reply: '' } : {}) });
    const fmt = formatting(f, text => mode === 'stripped' ? text.replace(/<https[^>]+>/g, '') : text);
    const routine = { id: 'r1', title: 'News', status: 'active', prompt: 'Show news', owner_channel: mode === 'room' ? 'C_ROOM' : 'D_OWNER', owner_user_id: 'U_OWNER', is_system: 0 };
    const sends = [], statuses = [];
    const conn = {
      postToChannel: async (_channel, text) => { sends.push(fmt.formatForSlack(text)); if (text === 'Working.') return mode === 'fresh' ? { ok: false } : { ok: true, ts: 'placeholder' }; return mode === 'failed' ? { ok: false } : mode === 'unknown' ? { ok: true } : { ok: true, ts: 'fresh' }; },
      updateMessage: async (_channel, _ts, text) => { sends.push(fmt.formatForSlack(text)); return ['fallback', 'failed', 'unknown'].includes(mode) ? { ok: false } : { ok: true }; }, deleteMessage: async () => ({ ok: true }),
    };
    const mod = f.load('src/tasks/dispatchers/routine.ts', {
      '../index': { completeTask: () => statuses.push('complete'), markTaskInformed() {}, updateTask: (_id, next) => statuses.push(next.status) },
      '../../db': { getDb: () => ({ prepare: () => ({ get: () => routine, run() {} }) }), appendToConversation() {} },
      '../../core/orchestrator': { runOrchestrator: input => f.gather(input) }, '../lateness': { assessLateness: () => ({ run: true }) }, '../briefs': { sendMorningBriefing: async () => {} },
      '../../utils/textScrubber': { scrubInternalLeakage: text => text }, '../../connections/registry': { getConnection: () => conn }, luxon: { DateTime }, '../../utils/logger': f.logger,
      '../../skills/news': f.news, '../../connections/slack/formatting': fmt,
    });
    await mod.dispatchRoutine({}, { id: 'task1', routine_id: 'r1' }, f.profile, {}); await flush();
    assert.equal(f.state.writes.length, ['edit', 'fresh', 'fallback'].includes(mode) ? 1 : 0);
    assert.ok(statuses.includes(mode === 'failed' ? 'failed' : 'complete'));
    assert.equal(statuses.includes('complete'), mode !== 'failed'); f.check();
  });
}
for (const mode of ['channel', 'dm', 'failed', 'unknown', 'throw', 'room', 'colleague', 'stripped', 'write-failure']) {
  test(`research actual run and tracked send ${mode}`, async () => {
    const f = fixture({ writeFail: mode === 'write-failure' });
    const fmt = formatting(f, text => mode === 'stripped' ? text.replace(/<https[^>]+>/g, '') : text);
    const sends = [], closures = [], updates = [];
    const send = async (_target, body) => { sends.push(fmt.formatForSlack(body)); if (mode === 'throw') throw Error('unknown send'); return mode === 'failed' ? { ok: false, reason: 'rejected' } : mode === 'unknown' ? undefined : { ok: true, ts: 'sent' }; };
    const globals = { logger: f.logger, getConnection: () => ({ sendDirect: send, postToChannel: send }), parseDetails: () => ({ message: 'Show news' }),
      deriveOriginSurface: () => mode === 'room' ? 'room' : mode === 'colleague' ? 'colleague_dm' : 'owner_dm', updateRequest: (...args) => updates.push(args), closeRequest: args => closures.push(args) };
    const mod = f.load('src/core/requests/runner.ts', { '../orchestrator': { runOrchestrator: input => f.gather(input) }, '../../skills/news': f.news, '../../connections/slack/formatting': fmt }, globals,
      selectFunctions(['runResearchRun', 'sendTracked'], 'const RESEARCH_ANSWER_STORE_CAP = 4000;'));
    const run = () => mod.runResearchRun({ id: 'req1', initiated_by: mode === 'colleague' ? 'U_OTHER' : 'U_OWNER', origin_channel: mode === 'dm' ? '' : mode === 'room' ? 'C_ROOM' : 'D_OWNER' }, f.profile, {});
    if (['failed', 'unknown', 'throw'].includes(mode)) { await assert.rejects(run()); assert.equal(closures.length, 0); assert.equal(updates.length, 1); }
    else { await run(); assert.equal(closures.length, 1); }
    await flush(); assert.equal(f.state.writes.length, ['channel', 'dm'].includes(mode) ? 1 : 0); assert.equal(sends.length, 1); f.check();
  });
}
for (const mode of ['text', 'unknown', 'throw', 'stranger', 'group', 'audio', 'audio-fallback', 'write-failure']) {
  test(`WhatsApp actual authenticated handler ${mode}`, async () => {
    const f = fixture({ writeFail: mode === 'write-failure' }); f.profile.user.whatsapp_phone = '12345';
    const replies = []; let runs = 0;
    const mod = f.load('src/connectors/whatsapp.ts', { '../skills/news': f.news, '../voice/fileTranscribe': { transcribeAudioFile: async () => 'Show news' } }, {
      logger: f.logger, config: { OPENAI_API_KEY: 'fixture' }, setTimeout: () => ({}),
      getConversationHistory: () => [], appendToConversation() {}, runOrchestrator: input => { runs++; return f.gather(input); },
      shouldRespondWithAudio: p => p.inputWasVoice, textToSpeech: async () => { if (mode === 'audio-fallback') throw Error('audio unavailable'); return Buffer.from('audio'); },
      fs: { writeFileSync() {}, unlinkSync() {} }, path, os: { tmpdir: () => '/isolated' }, MessageMedia: { fromFilePath: () => ({}) },
    }, selectFunctions(['handleWhatsAppMessage', 'normalizePhone', 'markProcessed', 'msgId'], 'const processedMsgIds = new Set(); const MSG_TTL_MS = 600000;'));
    const message = { id: { _serialized: 'inbound-id' }, from: mode === 'stranger' ? '99999@c.us' : mode === 'group' ? '12345@g.us' : '12345@c.us', fromMe: false,
      type: mode.startsWith('audio') ? 'ptt' : 'chat', body: 'Show news', react: async () => {}, downloadMedia: async () => ({ data: 'YQ==' }),
      reply: async text => { replies.push(text); if (mode === 'throw' && replies.length === 1) throw Error('unknown send'); return mode === 'unknown' ? undefined : { id: { _serialized: 'sent-id' } }; } };
    const client = { sendPresenceAvailable: async () => {}, sendMessage: async () => ({ id: { _serialized: 'audio-id' } }) };
    await mod.handleWhatsAppMessage(message, f.profile, client, '12345'); await flush();
    await mod.handleWhatsAppMessage(message, f.profile, client, '12345'); await flush();
    assert.equal(f.state.writes.length, ['text', 'audio-fallback'].includes(mode) ? 1 : 0);
    assert.equal(runs, ['stranger', 'group'].includes(mode) ? 0 : 1); f.check();
  });
}
process.on('exit', () => { if (process.env.NEWS_DELIVERY_CAPTURE) fs.writeFileSync(process.env.NEWS_DELIVERY_CAPTURE, JSON.stringify({ limitation: 'Isolated deterministic pipeline; model responses mocked. No live Slack, factual accuracy, or model obedience claim. Callback reference captured by test-only instrumentation; callback body unchanged.', captures }, null, 2)); });
