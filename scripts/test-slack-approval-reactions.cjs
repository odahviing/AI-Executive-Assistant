// Execute the real registered reaction callback and owner delivery/history helper.
// External resolution, Slack and DB are isolated; no production writes or model calls.
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const revision = process.argv.find(arg => arg.startsWith('--revision='))?.split('=')[1];
const sourceRoot = process.env.SRA_SOURCE_ROOT || root;
const compiled = new Map(), harnesses = [];
const actual = new Set(['src/connectors/slack/app/handlers.ts', 'src/utils/ownerDailyThread.ts']);
const profile = { user: { slack_user_id: 'UOWNER', timezone: 'UTC' }, assistant: { name: 'Maelle' } };
function harness(options = {}) {
  const effects = { resolutions: [], posts: [], directs: [], history: [], logs: [], unexpected: [], followups: 0 };
  let callback;
  const row = { id: 'req_test', subject: 'Private meeting', owner_user_id: 'UOWNER', owner_dm_channel: 'DOWNER', owner_dm_thread_ts: 'daily.1', requester_slack_id: 'UCOLLEAGUE', requester_name: 'Colleague', requester_notified_at: '2026-09-11', ...options.row };
  const append = (...args) => { if (options.historyThrows) throw new Error('history unavailable'); effects.history.push(args); };
  const conn = {
    postToChannel: async (channel, text, opts) => { effects.posts.push({ channel, text, opts }); return options.postFails ? { ok: false, reason: 'post unavailable' } : { ok: true, ts: 'recovery.1' }; },
    sendDirect: async (user, text) => { effects.directs.push({ user, text }); return options.dmFails ? { ok: false, reason: 'DM unavailable' } : { ok: true, ref: 'DOWNER', ts: 'fallback.1' }; },
  };
  const mocks = {
    'src/config.ts': {}, 'src/llm/client.ts': {}, 'src/core/threadActions.ts': {}, 'src/voice.ts': {},
    'src/db.ts': { appendToConversation: append },
    'src/utils/logger.ts': { __esModule: true, default: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => effects.logs.push({ level, args })])) },
    'src/connectors/slack/inboundReplayRegistry.ts': {}, 'src/connectors/slack/processedDedup.ts': {},
    'src/connectors/slack/app/helpers.ts': {}, 'src/connectors/slack/app/fileIngestion.ts': {},
    'src/connectors/slack/recentOutboundContext.ts': { closeFollowupForMessageTs: () => { effects.followups++; return null; } },
    'src/db/requests.ts': { getRequestByTerminalMsgTs: () => options.noMatch ? null : row, getRequest: () => row },
    'src/core/requests/resolver.ts': { resolveRequest: async (...args) => { effects.resolutions.push(args); if (options.resolveThrows) throw new Error('isolated resolver unavailable'); return options.resolve ? options.resolve(...args) : options.result || { ok: true }; } },
    'src/connections/registry.ts': { getConnection: user => { assert.equal(user, 'UOWNER'); return options.noConnection ? null : conn; } },
    'src/db/conversations.ts': { appendToConversation: append },
    'src/utils/effectiveToday.ts': {}, 'src/db/client.ts': {},
  };
  const modules = new Map();
  function load(relative) {
    if (Object.hasOwn(mocks, relative)) return mocks[relative];
    if (modules.has(relative)) return modules.get(relative).exports;
    if (!actual.has(relative)) { effects.unexpected.push(relative); throw new Error(`Blocked module ${relative}`); }
    if (!compiled.has(relative)) {
      const source = revision ? execFileSync('git', ['show', `${revision}:${relative}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
      compiled.set(relative, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
    }
    const module = { exports: {} }; modules.set(relative, module);
    const req = spec => {
      if (spec === 'luxon') return require('luxon');
      if (!spec.startsWith('.')) { effects.unexpected.push(spec); throw new Error(`Blocked external ${spec}`); }
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec)) + '.ts');
    };
    vm.runInNewContext(`(function(require,module,exports){${compiled.get(relative)}\n})`, { Date, Set, Map }, { filename: relative })(req, module, module.exports);
    return module.exports;
  }
  const app = { event: (name, handler) => { assert.equal(name, 'reaction_added'); callback = handler; } };
  load('src/connectors/slack/app/handlers.ts').registerReactionHandler({ app, profile, botUserId: 'UBOT' });
  const h = { effects, react: (overrides = {}) => callback({ event: { item: { type: 'message', channel: 'DOWNER', ts: 'ask.1' }, user: 'UOWNER', reaction: 'white_check_mark', ...overrides }, client: {} }) };
  harnesses.push(h); return h;
}
afterEach(() => { for (const h of harnesses.splice(0)) assert.deepEqual(h.effects.unexpected, [], 'no swallowed unexpected dependency failures'); });

for (const [id, reason] of [
  ['possible-reschedule', 'Existing meeting needs a move or a separate booking decision.'],
  ['event-not-found', 'Verify whether the meeting still exists before retrying cancellation.'],
  ['executor-failure', 'Calendar action could not be confirmed.'],
  ['unsupported-action', 'This stored action cannot be executed automatically.'],
  ['terminal-race', 'The request is already closed; do not replay it.'],
]) test(`SRA-${id}: failed resolution is visible with recovery and thread history`, async () => {
  const h = harness({ result: { ok: false, reason } }); await h.react();
  assert.equal(h.effects.resolutions.length, 1); assert.equal(h.effects.posts.length, 1);
  assert.equal(h.effects.posts[0].channel, 'DOWNER'); assert.equal(h.effects.posts[0].opts.threadTs, 'daily.1');
  assert.ok(h.effects.posts[0].text.includes(reason)); assert.ok(h.effects.posts[0].text.includes('req_test'));
  assert.equal(h.effects.history.length, 1); assert.equal(h.effects.history[0][0], 'daily.1');
  assert.equal(h.effects.history[0][2].content, h.effects.posts[0].text);
});
test('SRA-thrown: resolver exception yields private uncertain-outcome feedback', async () => {
  const h = harness({ resolveThrows: true }); await h.react(); assert.equal(h.effects.posts.length, 1);
  assert.match(h.effects.posts[0].text, /outcome could not be confirmed/i);
  assert.doesNotMatch(h.effects.posts[0].text, /before retrying|before trying again|I can check/);
});
for (const [id,reason] of [
  ['attempted-unconfirmed', 'I tried to do it, but the outcome remains unconfirmed. No safe check is available and no further check is pending.'],
  ['pre-dispatch-refusal', 'The action was not attempted because the private owner anchor is unavailable.'],
]) test(`SRA-${id}: transport preserves resolver truth without inventing a check or retry`, async()=>{
  const h=harness({result:{ok:false,reason}}); await h.react();
  assert.equal(h.effects.posts[0]?.text,`For "Private meeting" (req_test): ${reason}`);
  assert.equal(h.effects.history[0]?.[2].content,h.effects.posts[0]?.text);
});
for (const [id, event, row] of [
  ['missing-user', { user: undefined }], ['empty-user', { user: '' }], ['colleague', { user: 'UCOLLEAGUE' }],
  ['foreign-profile', { user: 'UOTHER' }, { owner_user_id: 'UOTHER' }],
  ['channel', { item: { type: 'message', channel: 'CROOM', ts: 'ask.1' } }],
  ['mpim', { item: { type: 'message', channel: 'GROOM', ts: 'ask.1' } }],
  ['wrong-dm', { item: { type: 'message', channel: 'DOTHER', ts: 'ask.1' } }],
  ['missing-channel', { item: { type: 'message', ts: 'ask.1' } }],
  ['stored-room', { item: { type: 'message', channel: 'CROOM', ts: 'ask.1' } }, { owner_dm_channel: 'CROOM' }],
  ['missing-stored-dm', {}, { owner_dm_channel: null }],
]) test(`SRA-${id}: untrusted approval event has no resolution or disclosure`, async () => {
  const h = harness({ row, result: { ok: false, reason: 'private recovery' } }); await h.react(event);
  assert.equal(h.effects.resolutions.length, 0); assert.equal(h.effects.posts.length + h.effects.directs.length + h.effects.history.length, 0);
});
for (const reaction of ['white_check_mark', 'x']) test(`SRA-${reaction}: legitimate owner decision retains success history without duplicate delivery`, async () => {
  const h = harness(); await h.react({ reaction }); assert.equal(h.effects.resolutions.length, 1);
  assert.equal(h.effects.resolutions[0][1].verdict, reaction === 'x' ? 'reject' : 'approve');
  assert.equal(h.effects.resolutions[0][2].resolvedByColleague, false);
  assert.equal(h.effects.history.length, 1); assert.equal(h.effects.posts.length + h.effects.directs.length, 0);
});
for (const origin of ['dm', 'room']) for (const initiator of ['owner', 'colleague']) test(`SRA-${origin}-origin-${initiator}: private owner approval preserves origin context`, async () => {
  const h = harness({ row: { origin_channel: origin === 'room' ? 'CROOM' : 'DCOLLEAGUE', origin_is_mpim: origin === 'room' ? 1 : 0, initiated_by_role: initiator } });
  await h.react(); assert.equal(h.effects.resolutions.length, 1); assert.equal(h.effects.history.length, 1);
  assert.equal(h.effects.history[0][1], 'DOWNER'); assert.equal(h.effects.posts.length + h.effects.directs.length, 0);
});
for (const [id, options, event] of [['ambiguous', {}, { reaction: 'eyes' }], ['bot', {}, { user: 'UBOT' }], ['closed-or-unmatched', { noMatch: true }, {}], ['non-message', {}, { item: { type: 'file', ts: 'file.1' } }]]) test(`SRA-${id}: ignored reaction remains a no-op`, async () => {
  const h = harness(options); await h.react(event); assert.equal(h.effects.resolutions.length + h.effects.history.length + h.effects.posts.length, 0);
});
test('SRA-fallback: failed thread delivery uses private owner DM and records actual thread', async () => {
  const h = harness({ postFails: true, result: { ok: false, reason: 'check calendar' } }); await h.react();
  assert.equal(h.effects.directs.length, 1); assert.equal(h.effects.directs[0].user, 'UOWNER');
  assert.equal(h.effects.history.length, 1); assert.equal(h.effects.history[0][0], 'fallback.1');
});
test('SRA-unavailable: total delivery failure is logged without false success history', async () => {
  const h = harness({ postFails: true, dmFails: true, result: { ok: false, reason: 'check calendar' } }); await h.react();
  assert.equal(h.effects.directs.length, 1); assert.equal(h.effects.history.length, 0);
  assert.ok(h.effects.logs.some(x => x.level === 'error' && x.args[0] === 'reaction_added approval recovery delivery failed'));
});
test('SRA-no-connection: unavailable connection is surfaced in error log', async () => {
  const h = harness({ noConnection: true, result: { ok: false } }); await h.react();
  assert.equal(h.effects.posts.length + h.effects.directs.length + h.effects.history.length, 0);
  assert.ok(h.effects.logs.some(x => x.level === 'error' && x.args[0].includes('recovery unavailable')));
});
test('SRA-no-root: recovery threads under original ask when stored root is absent', async () => {
  const h = harness({ row: { owner_dm_thread_ts: null }, result: { ok: false } }); await h.react();
  assert.equal(h.effects.posts[0]?.opts.threadTs, 'ask.1');
});
test('SRA-history-unavailable: delivered recovery is not resent when history append fails', async () => {
  const h = harness({ historyThrows: true, result: { ok: false } }); await h.react();
  assert.equal(h.effects.posts.length, 1); assert.equal(h.effects.directs.length, 0);
});
