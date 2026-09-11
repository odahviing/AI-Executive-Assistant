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
  const timers = [], posts = [], history = [], stamps = [], subjectRaises = [], mirrors = [], unexpected = [], logs = [];
  const replies = new Map(), charged = new Set();
  let composeCalls = 0, gateCalls = 0;
  const timer = (fn, delay) => { const t = { fn, delay, cancelled: false, unref() {} }; timers.push(t); return t; };
  const logger = Object.fromEntries(['info','warn','error','debug'].map(k => [k, (...args) => logs.push(args)]));
  function load(name, deps, dir = 'src/connectors/slack') {
    const file = before ? path.resolve(before, `${name}.before.ts`) : path.join(root, dir, `${name}.ts`);
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
    '../../db/socialSubjects': { countAssistantInitiationsTodayForPerson: () => 0, lastAssistantInitiatedAt: () => null, getCategoryByLabel: () => null, markSubjectRaised: id => subjectRaises.push(id) },
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
  const mod = load('postReply', {
    '../../utils/logger': logger,
    '../../db': { appendToConversation: (...args) => history.push(args) },
    '../../connections/slack/formatting': { formatForSlack: text => options.emptyFormat && text === 'Social question?' ? '' : text },
    '../../connections/slack/messaging': { setAssistantStatus: async () => {} },
    '../../config': { config: { OPENAI_API_KEY: 'fixture-only' } },
    '../../voice': { shouldRespondWithAudio: p => p.inputWasVoice, textToSpeech: async () => 'audio', sendAudioMessage: async () => {} },
    '../../utils/guards/runOutputGates': {
      runDeliberationGuard: async text => text, runOutputGates: async text => text,
      runCodaGates: async () => { gateCalls++; if (options.gatePause) await options.gatePause.promise; if (options.gateThrows) throw Error('gate unavailable'); return { ship: !options.gateDrop }; },
    },
    './inboundQueue': queue, '../../utils/threadActivity': threadActivity,
    '../../core/social/generateCoda': { composeSocialCoda: async () => {
      composeCalls++; if (options.composePause) await options.composePause.promise;
      if (options.composeThrows) throw Error('compose unavailable');
      return options.composeNull ? null : { text: 'Social question?', historyContent: 'Social question?\n[internal provenance]' };
    } },
    '../../core/social/stateMachine': socialState,
    '../../core/social/logEngagement': socialAccounting,
    '../../utils/shadowNotify': { shadowNotify: async (profile, entry) => mirrors.push(entry) },
  });
  async function reply(overrides = {}) {
    const person = overrides.senderId ?? 'U_OWNER';
    await mod.postOrchestratorReply({
      app: { client: { reactions: { add: async () => {} } } },
      profile: { user: { slack_user_id: 'U_OWNER', timezone: 'UTC' }, assistant: { slack: { bot_token: 'fixture' } } },
      result: { reply: 'Work answer ready.', socialCoda: { personSlackId: person, directive: { mode: 'raise_new', categoryLabel: 'music' } } },
      say: async msg => { posts.push(msg); if (msg.text === 'Social question?' && options.sendThrows) throw Error('timeout after acceptance'); return { ts: String(posts.length) }; },
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
  return { reply, fire, inbound, count, posts, history, stamps, subjectRaises, mirrors, charged, replies, logs, get composeCalls() { return composeCalls; }, get gateCalls() { return gateCalls; } };
}

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
test('preserved: timeout retains pre-send accounting and omits history receipt', async () => {
  const h = harness({ sendThrows: true }); await h.reply(); await h.fire('coda'); assert.equal(h.count(), 1); assert.equal(h.stamps.length, 1); assert.equal(h.history.length, 1);
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
  await h.reply({ threadTs: 'T2' }); await h.fire('coda'); assert.equal(h.count(), 1); assert.equal(h.stamps.length, 1);
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
test('regression: failed stamp on continue neither sends nor raises subject', async () => {
  const h = harness({ stampFails: true }); await h.reply({ result: { reply: 'Work answer', socialCoda: { personSlackId: 'U_OWNER', subjectId: 'S1', directive: { mode: 'continue' } } } });
  await h.fire('coda'); assert.equal(h.count(), 0); assert.deepEqual(h.subjectRaises, []);
});
