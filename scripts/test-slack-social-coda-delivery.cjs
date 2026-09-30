// Actual postReply + inboundQueue + social cadence/accounting, manual timers and closed I/O.
// SLACK_CODA_BEFORE_DIR replays the preserved pre-repair modules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const before = process.env.SLACK_CODA_BEFORE_DIR;
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const timers = [], posts = [], history = [], stamps = [], subjectRaises = [], categoryRaises = [], mirrors = [], unexpected = [], logs = [];
  const replies = new Map(), charged = new Set();
  let composeCalls = 0, gateCalls = 0;
  const timer = (fn, delay) => { const t = { fn, delay, cancelled: false, unref() {} }; timers.push(t); return t; };
  const logger = Object.fromEntries(['info','warn','error','debug'].map(k => [k, (...args) => logs.push(args)]));
  function load(name, deps, dir = 'src/connectors/slack') {
    const boundedBefore = process.env.SLACK_BOUNDARY_SOURCE_ROOT && path.join(process.env.SLACK_BOUNDARY_SOURCE_ROOT, dir, `${name}.ts`);
    const beforeFile = before && path.resolve(before, `${name}.before.ts`);
    const file = beforeFile && fs.existsSync(beforeFile) ? beforeFile : boundedBefore && fs.existsSync(boundedBefore) ? boundedBefore : path.join(root, dir, `${name}.ts`);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, require: name => {
      if (Object.hasOwn(deps, name)) return deps[name];
      unexpected.push(name); throw Error(`Forbidden dependency ${name}`);
    }, setTimeout: timer, clearTimeout: t => { t.cancelled = true; }, AbortController, console }, { filename: file });
    return exports;
  }
  const queue = load('inboundQueue', { '../../utils/logger': logger });
  const socialDependencies = {
    '../../utils/logger': logger,
    '../../db/socialSubjects': {
      countAssistantInitiationsTodayForPerson: () => 0,
      lastAssistantInitiatedAt: () => null,
      getCategoryByLabel: label => ({ id: `CAT_${label}` }),
      markSubjectRaised: id => subjectRaises.push(id),
      markCategoryRaised: input => categoryRaises.push(input),
    },
    '../../db/engagementRank': { getEngagementRank: () => 3 },
    '../../db': { getPersonMemory: person => { if (options.cadenceThrows) throw Error('cadence unavailable'); return { last_initiated_at: charged.has(person) ? new Date().toISOString() : null }; } },
    '../../db/people': { recordSocialMoment: person => { stamps.push({ personSlackId: person }); if (options.stampFails) return false; charged.add(person); return true; } },
  };
  const socialState = load('stateMachine', socialDependencies, 'src/core/social');
  const socialAccounting = load('logEngagement', socialDependencies, 'src/core/social');
  const threadActivity = {
    getLastMaelleMessage: thread => { if (options.activityThrows) throw Error('activity unavailable'); return replies.get(thread) ?? null; },
    recordMaelleMessage: (thread, channel, messageTs) => replies.set(thread, { messageTs }),
  };
  const composerPrompts = [];
  const realComposer = options.realComposer ? load('generateCoda', {
    '../../llm/client': { getAnthropicClient: () => ({ messages: { create: async args => {
      composerPrompts.push(args.messages[0].content);
      return { content: [{ type: 'tool_use', input: { sentence: options.emptySentence ? '' : 'Social question?' } }] };
    } } }) },
    '../../llm/models': { SONNET: { model: 'fixture' } },
    '../../utils/usageLog': { logLlmUsage() {} }, '../../utils/logger': logger,
    '../../skills/general': { tavilySearch: async () => ({ results: [{ title: 'New album', content: 'An artist released a new album.', url: 'https://example.com/album' }] }) },
    '../../db': { authoritativeGender: () => 'unknown', getPersonMemory: () => ({ name: 'Recipient' }), getRecentChannelMessages: () => [] },
    '../../db/socialSubjects': { getActiveSubjectsForPersonCategory: () => [], getCategoryByLabel: () => null, recordCategoryRaiseTried() {} },
    '../../utils/claimChecker': { checkReplyClaims: async () => ({ claimed_action: false }) },
  }, 'src/core/social') : null;
  const mod = load('postReply', {
    '../../utils/logger': logger,
    '../../db': { appendToConversation: (...args) => history.push(args) },
    '../../connections/slack/formatting': { formatForSlack: text => options.emptyFormat && text === 'Social question?' ? '' : text },
    '../../connections/slack/messaging': { setAssistantStatus: async () => {} },
    '../../config': { config: { OPENAI_API_KEY: 'fixture-only' } },
    '../../voice': { shouldRespondWithAudio: p => p.inputWasVoice, textToSpeech: async () => 'audio', sendAudioMessage: async () => { if (options.audioUnknown) throw Error('unknown audio delivery'); } },
    '../../utils/guards/runOutputGates': {
      runDeliberationGuard: async text => text, runOutputGates: async text => { if (options.workGatePause) await options.workGatePause.promise; return options.gatedReply ?? text; },
      runCodaGates: async () => { gateCalls++; if (options.gatePause) await options.gatePause.promise; if (options.gateThrows) throw Error('gate unavailable'); return { ship: !options.gateDrop }; },
    },
    './inboundQueue': queue, '../../utils/threadActivity': threadActivity,
    '../../core/social/generateCoda': { composeSocialCoda: async (coda, profile, deliveredWorkReply) => {
      if (options.expectedDelivered !== undefined) assert.equal(deliveredWorkReply, options.expectedDelivered);
      composeCalls++; if (options.composePause) await options.composePause.promise;
      if (realComposer) return realComposer.composeSocialCoda(coda, profile, deliveredWorkReply);
      if (options.composeThrows) throw Error('compose unavailable');
      return options.composeNull ? null : { text: 'Social question?', historyContent: 'Social question?\n[internal provenance]' };
    } },
    '../../core/social/stateMachine': socialState,
    '../../core/social/logEngagement': socialAccounting,
    '../../utils/shadowNotify': { shadowNotify: async (profile, entry) => mirrors.push(entry) },
    '../../db/jobs': { getAutoMoveRequestIdForOutreachThread: () => null },
  });
  async function reply(overrides = {}) {
    const person = overrides.senderId ?? 'U_OWNER';
    await mod.postOrchestratorReply({
      app: { client: { reactions: { add: async () => {} } } },
      profile: { user: { name: 'Owner', slack_user_id: 'U_OWNER', timezone: 'UTC' }, assistant: { name: 'Maelle', slack: { bot_token: 'fixture' } } },
      result: { reply: 'Work answer ready.', socialCoda: { personSlackId: person, directive: { mode: 'raise_new', categoryLabel: 'music' } } },
      say: async msg => {
        posts.push(msg);
        if (msg.text === 'Work answer ready.' && options.workSendThrows) throw Error('unknown work delivery');
        if (msg.text === 'Work answer ready.' && options.workSendRejects) return { ok: false, error: 'rejected' };
        if (msg.text === 'Social question?' && options.sendThrows) throw Error('timeout after acceptance');
        if (msg.text === 'Social question?' && options.sendExplicitFailure) return { ok: false, error: 'fixture_failure' };
        if (msg.text === 'Social question?' && options.sendReturnsVoid) return undefined;
        return { ok: true, ts: String(posts.length) };
      },
      role: 'owner', senderId: person, channelId: 'D_OWNER', threadTs: 'T1', history: [], userMessage: 'Hello', ...overrides,
    });
  }
  async function fire(delay) {
    const pending = timers.filter(t => !t.cancelled && (delay === 'coda' ? t.delay >= 5000 : t.delay === 1500));
    for (const t of pending) { t.cancelled = true; t.fn(); }
    await flush();
  }
  function inbound(overrides = {}) {
    queue.enqueueMessage({ channelId: 'D_OWNER', threadTs: 'T1', isOneOnOneDm: true, text: 'Follow-up', senderId: 'U_OWNER', meta: {}, runner: async () => {}, ...overrides });
  }
  function count() { assert.deepEqual(unexpected, []); return posts.filter(p => p.text === 'Social question?').length; }
  return { reply, fire, inbound, count, posts, history, stamps, subjectRaises, categoryRaises, mirrors, charged, replies, logs, composerPrompts, get composeCalls() { return composeCalls; }, get gateCalls() { return gateCalls; } };
}

for (const mode of ['workSendThrows', 'workSendRejects']) {
  test(`thread delivery: ${mode} leaves no phantom assistant answer`, async () => {
    const h = harness({ [mode]: true }); let delivered = false;
    await assert.rejects(h.reply({ onDelivered: () => { delivered = true; } }));
    assert.equal(delivered, false);
    assert.equal(h.history.length, 0);
    await h.fire('coda'); assert.equal(h.composeCalls, 0);
  });
}
test('thread delivery: superseded reply during gates cannot send or persist', async () => {
  const pause = deferred(); const h = harness({ workGatePause: pause }); let superseded = false;
  const reply = h.reply({ onBeforeDelivery: () => { if (superseded) throw Error('aborted_for_merge'); } });
  await flush(); superseded = true; pause.resolve();
  await assert.rejects(reply, /aborted_for_merge/);
  assert.equal(h.posts.length, 0); assert.equal(h.history.length, 0);
});
test('thread delivery control: confirmed reply records gated answer once', async () => {
  const h = harness(); let delivered = 0;
  await h.reply({ onDelivered: () => { delivered++; } });
  assert.equal(delivered, 1); assert.equal(h.history.length, 1);
  assert.ok(h.history[0][2].content.includes('Work answer ready.'));
});

for (const phase of ['compose', 'gate']) {
  for (const kind of ['pending', 'completed-ack', 'completed-audio', 'completed-new-thread', 'failed-turn']) {
    test(`regression: ${kind} arriving during ${phase} cancels stale coda`, async () => {
      const pause = deferred(); const h = harness({ [`${phase}Pause`]: pause });
      await h.reply(); await h.fire('coda');
      assert.equal(phase === 'compose' ? h.composeCalls : h.gateCalls, 1);
      h.inbound({ threadTs: kind === 'completed-new-thread' ? 'T2' : 'T1', runner: async () => {
        if (kind === 'failed-turn') throw Error('runner failure');
        if (kind === 'completed-ack') await h.reply({ userMessageTs: 'U2', result: { reply: 'Done' } });
        if (kind === 'completed-audio') await h.reply({ voiceInput: true, result: { reply: 'Follow-up audio answer' } });
        if (kind === 'completed-new-thread') await h.reply({ threadTs: 'T2', result: { reply: 'New topic answer' } });
      } });
      if (kind !== 'pending') await h.fire('queue');
      pause.resolve(); await flush();
      assert.equal(h.count(), 0); assert.equal(h.stamps.length, 0);
      if (phase === 'compose') assert.equal(h.gateCalls, 0, 'cancel before spending the output gate');
      assert.equal(h.mirrors.filter(x => x.action === 'Social coda').length, 0);
    });
  }
}
test('regression: completed inbound during beat cancels even without text reply', async () => {
  const h = harness(); await h.reply(); h.inbound(); await h.fire('queue'); await h.fire('coda');
  assert.equal(h.count(), 0); assert.equal(h.composeCalls, 0);
});
test('regression: overlapping timers claim only one daily coda', async () => {
  const pause = deferred(); const h = harness({ gatePause: pause });
  await h.reply(); await h.reply({ threadTs: 'T2' }); await h.fire('coda');
  assert.equal(h.gateCalls, 2); pause.resolve(); await flush();
  assert.equal(h.count(), 1); assert.equal(h.stamps.length, 1);
});
test('regression: failed stamp prevents unaccounted send', async () => {
  const h = harness({ stampFails: true }); await h.reply(); await h.fire('coda'); assert.equal(h.count(), 0);
});
test('regression: pending directive rechecks already spent daily eligibility', async () => {
  const h = harness(); await h.reply(); h.charged.add('U_OWNER'); await h.fire('coda'); assert.equal(h.count(), 0);
});
test('preserved: quiet owner DM posts in same thread and stores provenance internally', async () => {
  const h = harness(); await h.reply(); await h.fire('coda'); assert.equal(h.count(), 1);
  assert.equal(h.stamps.length, 1); assert.equal(h.history.at(-1)[2].content, 'Social question?\n[internal provenance]');
  assert.equal(h.categoryRaises.length, 1);
  assert.equal(h.posts.at(-1).thread_ts, 'T1'); assert.equal(h.posts.at(-1).unfurl_links, false);
  assert.equal(h.mirrors.length, 0);
});
test('preserved: colleague DM mirrors only delivered wire sentence', async () => {
  const h = harness(); await h.reply({ role: 'colleague', senderId: 'U_COLLEAGUE' }); await h.fire('coda');
  assert.equal(h.count(), 1); const mirror = h.mirrors.find(x => x.action === 'Social coda');
  assert.ok(mirror); assert.ok(!mirror.detail.includes('internal provenance'));
});
for (const surface of ['isMpim', 'isChannel']) test(`preserved: ${surface} never schedules private coda`, async () => {
  const h = harness(); await h.reply({ [surface]: true }); await h.fire('coda'); assert.equal(h.count(), 0); assert.equal(h.composeCalls, 0);
});
for (const option of ['composeNull','composeThrows','gateDrop','gateThrows','emptyFormat','activityThrows']) test(`preserved: ${option} drops without charging`, async () => {
  const h = harness({ [option]: true }); await h.reply(); await h.fire('coda'); assert.equal(h.count(), 0); assert.equal(h.stamps.length, 0);
});
test('preserved: pending inbound before timer drops before composition', async () => {
  const h = harness(); await h.reply(); h.inbound(); await h.fire('coda'); assert.equal(h.count(), 0); assert.equal(h.composeCalls, 0);
});
test('regression: rejected send keeps attempt cap without recording category delivery', async () => {
  const h = harness({ sendThrows: true }); await h.reply(); await h.fire('coda');
  assert.equal(h.count(), 1); assert.equal(h.stamps.length, 1); assert.equal(h.categoryRaises.length, 0);
  assert.equal(h.history.length, 1); assert.equal(h.mirrors.length, 0);
});
test('regression: explicit unsuccessful acknowledgement is not recorded as delivery', async () => {
  const h = harness({ sendExplicitFailure: true }); await h.reply(); await h.fire('coda');
  assert.equal(h.count(), 1); assert.equal(h.stamps.length, 1); assert.equal(h.categoryRaises.length, 0);
  assert.equal(h.history.length, 1); assert.equal(h.mirrors.length, 0);
});
test('preserved: resolved catch-up wrapper without response body confirms delivery', async () => {
  const h = harness({ sendReturnsVoid: true }); await h.reply(); await h.fire('coda');
  assert.equal(h.count(), 1); assert.equal(h.stamps.length, 1); assert.equal(h.categoryRaises.length, 1);
  assert.equal(h.history.length, 2);
});
test('preserved: different people can both receive codas', async () => {
  const h = harness(); await h.reply(); await h.reply({ senderId: 'U_OTHER', channelId: 'D_OTHER', threadTs: 'T2' }); await h.fire('coda'); assert.equal(h.count(), 2);
});
for (const mode of ['ack', 'audio']) test(`preserved: ${mode} delivered reply schedules its coda`, async () => {
  const h = harness(); await h.reply(mode === 'ack' ? { userMessageTs: 'U1', result: { reply: 'Done', socialCoda: { personSlackId: 'U_OWNER', directive: { mode: 'raise_new' } } } } : { voiceInput: true });
  await h.fire('coda'); assert.equal(h.count(), 1);
});
test('regression: cadence read unavailable fails closed', async () => {
  const h = harness({ cadenceThrows: true }); await h.reply(); await h.fire('coda'); assert.equal(h.count(), 0); assert.equal(h.stamps.length, 0);
});
test('regression: timeout accounting suppresses another pending attempt', async () => {
  const h = harness({ sendThrows: true }); await h.reply(); await h.fire('coda');
  await h.reply({ threadTs: 'T2' }); await h.fire('coda'); assert.equal(h.count(), 1); assert.equal(h.stamps.length, 1); assert.equal(h.categoryRaises.length, 0);
});
test('preserved: coda dropped before accounting can be retried on a later quiet reply', async () => {
  const options = { gateDrop: true }; const h = harness(options); await h.reply(); await h.fire('coda');
  assert.equal(h.count(), 0); options.gateDrop = false; await h.reply(); await h.fire('coda'); assert.equal(h.count(), 1);
});
test('preserved: failed work reply cannot schedule a coda', async () => {
  const h = harness(); await assert.rejects(h.reply({ say: async () => { throw Error('work reply rejected'); } }));
  await h.fire('coda'); assert.equal(h.composeCalls, 0); assert.equal(h.stamps.length, 0);
});
test('preserved: another recorded reply invalidates the old trailer', async () => {
  const h = harness(); await h.reply(); h.replies.set('T1', { messageTs: 'new-reply' }); await h.fire('coda'); assert.equal(h.count(), 0);
});
test('preserved: inbound in another DM does not cancel this recipient', async () => {
  const h = harness(); await h.reply(); h.inbound({ channelId: 'D_OTHER', senderId: 'U_OTHER' }); await h.fire('coda'); assert.equal(h.count(), 1);
});
test('preserved: continue coda retains subject raise accounting', async () => {
  const h = harness(); await h.reply({ result: { reply: 'Work answer', socialCoda: { personSlackId: 'U_OWNER', subjectId: 'S1', directive: { mode: 'continue' } } } });
  await h.fire('coda'); assert.equal(h.count(), 1); assert.deepEqual(h.subjectRaises, ['S1']);
});
test('regression: rejected continue coda does not start subject silence accounting', async () => {
  const h = harness({ sendThrows: true }); await h.reply({ result: { reply: 'Work answer', socialCoda: { personSlackId: 'U_OWNER', subjectId: 'S1', directive: { mode: 'continue' } } } });
  await h.fire('coda'); assert.equal(h.count(), 1); assert.equal(h.stamps.length, 1); assert.deepEqual(h.subjectRaises, []);
});
test('regression: failed stamp on continue neither sends nor raises subject', async () => {
  const h = harness({ stampFails: true }); await h.reply({ result: { reply: 'Work answer', socialCoda: { personSlackId: 'U_OWNER', subjectId: 'S1', directive: { mode: 'continue' } } } });
  await h.fire('coda'); assert.equal(h.count(), 0); assert.deepEqual(h.subjectRaises, []);
});

for (const mode of ['text', 'audio', 'ack']) test(`delivered context: ${mode} passes only final gated work reply`, async () => {
  const gated = mode === 'ack' ? 'Done' : 'Safe final work answer.';
  const h = harness({ gatedReply: gated, expectedDelivered: gated });
  await h.reply({ role: 'colleague', senderId: 'U_COLLEAGUE', voiceInput: mode === 'audio', userMessageTs: mode === 'ack' ? 'U1' : undefined,
    result: { reply: 'PRIVATE RAW DRAFT', socialCoda: { personSlackId: 'U_COLLEAGUE', directive: { mode: 'raise_new' } } } });
  await h.fire('coda'); assert.equal(h.count(), 1, 'composer received final context and emitted coda');
  assert.ok(!JSON.stringify(h.mirrors).includes('PRIVATE RAW DRAFT'));
});
for (const mode of ['audio', 'text']) test(`delivered context: unknown ${mode} delivery never invokes composer`, async () => {
  const h = harness({ audioUnknown: mode === 'audio' });
  await h.reply(mode === 'audio' ? { voiceInput: true } : { say: async () => undefined });
  await h.fire('coda'); assert.equal(h.composeCalls, 0); assert.equal(h.stamps.length, 0);
});

for (const mode of ['text', 'audio', 'ack']) test(`integrated real composer: ${mode} captures gated reply and preserves completed-work coda`, async () => {
  const gated = mode === 'ack' ? 'Done' : 'Booked the meeting.';
  const h = harness({ realComposer: true, gatedReply: gated });
  await h.reply({ voiceInput: mode === 'audio', userMessageTs: mode === 'ack' ? 'U1' : undefined });
  await h.fire('coda');
  assert.equal(h.composerPrompts.length, 1);
  assert.ok(h.composerPrompts[0].includes(JSON.stringify(gated)));
  assert.ok(!h.composerPrompts[0].includes('Work answer ready.'));
  assert.equal(h.count(), 1); assert.equal(h.categoryRaises.length, 1);
});
test('integrated real composer: empty semantic verdict stays silent without delivery charge', async () => {
  const h = harness({ realComposer: true, gatedReply: 'Chris has a conflict; check with him before adding him.', emptySentence: true });
  await h.reply(); await h.fire('coda');
  assert.equal(h.composerPrompts.length, 1);
  assert.ok(h.composerPrompts[0].includes('A statement can leave work unresolved without a question mark'));
  assert.ok(h.composerPrompts[0].includes('A shared first name is not evidence'));
  assert.equal(h.count(), 0); assert.equal(h.stamps.length, 0); assert.equal(h.categoryRaises.length, 0);
});
