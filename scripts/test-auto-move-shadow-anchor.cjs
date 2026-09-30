// Actual shadowNotify + requests SQL; transport/history isolated, no live sends.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module');
const { test } = require('node:test'), assert = require('node:assert/strict'), ts = require('typescript');
const filename = path.join(__dirname, 'test-owner-reschedule-rulings.cjs');
const fixtureModule = new Module(filename, module);
fixtureModule.filename = filename; fixtureModule.paths = module.paths;
fixtureModule._compile(fs.readFileSync(filename, 'utf8').split("test('FYI confirmed delivery")[0] + '\nmodule.exports=fixture;', filename);
const root = path.resolve(__dirname, '..');
const source = process.env.MAELLE_SHADOW_SOURCE_ROOT || root;
const shadowFile = path.join(source, 'src/utils/shadowNotify.ts');
const javascript = ts.transpileModule(fs.readFileSync(shadowFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
function fixture(o = {}) {
  const h = fixtureModule.exports(), sends = [], posts = [], history = [], logs = [];
  h.profile.behavior.v1_shadow_mode = !o.disabled;
  const result = (configured, fallback) => { if (configured instanceof Error) throw configured; return configured || fallback; };
  const conn = {
    resolveDirectChannelId: async () => o.noOwnerDm ? null : 'DOWNER',
    sendDirect: async (id, text, opts) => { sends.push({ id, text, opts }); return result(o.send, { ok: true, ref: 'DOWNER', ts: `root.${sends.length}` }); },
    postToChannel: async (id, text, opts) => { posts.push({ id, text, opts }); return result(o.post, { ok: true, ts: `reply.${posts.length}` }); },
  };
  const dependencies = {
    '../connections/registry': { getConnection: () => o.noConnection ? null : conn },
    '../db/requests': h.reqs,
    '../db/conversations': { appendToConversation: (...args) => { history.push(args); if (o.historyFails) throw Error('history unavailable'); } },
    './ownerDailyThread': { getOrCreateOwnerDailyThread: async () => ({ channel: 'DOWNER', rootTs: 'daily' }) },
    './logger': { __esModule: true, default: { warn: (...x) => logs.push(x), info: (...x) => logs.push(x) } },
  };
  let notify;
  const restart = () => {
    const m = { exports: {} };
    vm.runInNewContext('(function(require,module,exports){' + javascript + '\n})', {})(
      name => { assert.ok(dependencies[name], `unexpected dependency ${name}`); return dependencies[name]; }, m, m.exports);
    notify = m.exports.shadowNotify;
  };
  restart();
  const move = (extra = {}) => h.reqs.createRequest({ ownerUserId: 'OWNER', initiatedBy: 'OWNER', initiatedByRole: 'system', kind: 'follow_up', subkind: 'auto_move', subject: 'Move', state: 'resolved', outcomeExternalEventId: 'meeting', idempotencyKey: require('node:crypto').randomUUID(), ...extra });
  const call = (id, isRoot = false, extra = {}) => notify(h.profile, { channel: 'DCOLLEAGUE', threadTs: 'colleague', action: isRoot ? 'Auto-fixed' : 'Conversation', detail: 'Owner-private move detail', conversationKey: isRoot ? id : 'colleague', autoMoveRequestId: id, autoMoveRoot: isRoot, ...extra });
  return { h, o, sends, posts, history, logs, move, call, restart, notify: p => notify(h.profile, p) };
}
test('two moves persist two owner roots and first related followups after restart', async () => {
  const f = fixture(), a = f.move(), b = f.move();
  await f.call(a.id, true); await f.call(b.id, true); f.restart();
  await f.call(a.id); await f.call(b.id);
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.posts.map(x => [x.id, x.opts.threadTs]), [['DOWNER', 'root.1'], ['DOWNER', 'root.2']]);
  assert.equal(f.h.reqs.getRequest(a.id).owner_dm_thread_ts, 'root.1');
  assert.equal(f.h.reqs.getRequest(b.id).owner_dm_thread_ts, 'root.2');
  assert.deepEqual(f.history.map(x => x[0]), ['root.1', 'root.2', 'root.1', 'root.2']);
});
test('confirmed root retry after restart never posts again; terminal request remains terminal', async () => {
  const f = fixture(), m = f.move(); await f.call(m.id, true); f.restart(); await f.call(m.id, true);
  assert.equal(f.sends.length, 1); assert.equal(f.posts.length, 0); assert.equal(f.h.reqs.getRequest(m.id).state, 'resolved');
});
for (const send of [{ ok: false, reason: 'not_attempted' }, { ok: false, reason: 'error' }, { ok: true }, { ok: true, ref: 'DCOLLEAGUE', ts: 'bad' }, new Error('unknown')]) {
  test('failed or unknown root creates no durable anchor and no automatic retry: ' + JSON.stringify(send), async () => {
    const f = fixture({ send }), m = f.move(); await f.call(m.id, true);
    assert.equal(f.sends.length, 1); assert.equal(f.posts.length, 0);
    assert.equal(f.h.reqs.getRequest(m.id).owner_dm_thread_ts, null); assert.equal(f.history.length, 0);
  });
}
for (const post of [{ ok: false, reason: 'error' }, { ok: false, reason: 'not_attempted' }, new Error('unknown')]) {
  test('failed followup never retries as fresh root: ' + JSON.stringify(post), async () => {
    const f = fixture({ post }), m = f.move(); await f.call(m.id, true); f.restart(); await f.call(m.id);
    assert.equal(f.sends.length, 1); assert.equal(f.posts.length, 1); assert.equal(f.history.length, 1);
  });
}
for (const option of ['noConnection', 'noOwnerDm', 'disabled']) test('root unavailable/disabled is not attempted: ' + option, async () => {
  const f = fixture({ [option]: true }), m = f.move(); await f.call(m.id, true);
  assert.equal(f.sends.length + f.posts.length, 0); assert.equal(f.h.reqs.getRequest(m.id).owner_dm_thread_ts, null);
});
test('preserved unrelated conversation uses original root and followup path', async () => {
  const f = fixture(), p = { channel: 'ROOM', conversationKey: 'unrelated', action: 'Conversation', detail: 'hello' };
  await f.notify(p); await f.notify(p);
  assert.equal(f.sends.length, 1); assert.equal(f.posts[0].opts.threadTs, 'root.1'); assert.equal(f.posts[0].id, 'DOWNER');
});
test('preserved unkeyed room shadow uses owner daily thread', async () => {
  const f = fixture(); await f.notify({ channel: 'ROOM', threadTs: 'room', action: 'Action', detail: 'Private' });
  assert.equal(f.sends.length, 0); assert.equal(f.posts[0].id, 'DOWNER'); assert.equal(f.posts[0].opts.threadTs, 'daily');
});
test('wrong owner/kind/system role cannot create a move root', async () => {
  for (const extra of [{ ownerUserId: 'OTHER' }, { kind: 'reminder' }, { initiatedByRole: 'colleague' }]) {
    const f = fixture(), m = f.move(extra); await f.call(m.id, true);
    assert.equal(f.sends.length + f.posts.length, 0); assert.equal(f.h.reqs.getRequest(m.id).owner_dm_thread_ts, null);
  }
});
test('stored colleague/MPIM/channel pair is never trusted as owner destination', async () => {
  for (const destination of ['DCOLLEAGUE', 'GMPIM', 'CROOM']) {
    const f = fixture(), m = f.move({ ownerDmChannel: destination, ownerDmThreadTs: 'unsafe' }); await f.call(m.id);
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0].id, 'OWNER'); assert.equal(f.posts.length, 0);
  }
});
test('missing root followup retains owner visibility without persisting a guessed move root', async () => {
  const f = fixture(), m = f.move(); await f.call(m.id);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].id, 'OWNER'); assert.equal(f.h.reqs.getRequest(m.id).owner_dm_thread_ts, null);
});
test('attachments and owner history survive root/followup; history failure never retries', async () => {
  const f = fixture({ historyFails: true }), m = f.move(), attachments = [{ sourceUrl: 'https://files.slack.com/image' }];
  await f.call(m.id, true); await f.call(m.id, false, { attachments });
  assert.equal(f.sends.length, 1); assert.equal(f.posts.length, 1); assert.deepEqual(f.posts[0].opts.attachments, attachments); assert.equal(f.history.length, 2);
});
test('persist failure after root send never retries or guesses a durable anchor', async () => {
  const f = fixture(), m = f.move(); f.h.db.exec("CREATE TRIGGER fail_anchor BEFORE UPDATE OF owner_dm_thread_ts ON requests BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await f.call(m.id, true); assert.equal(f.sends.length, 1); assert.equal(f.posts.length, 0); assert.equal(f.h.reqs.getRequest(m.id).owner_dm_thread_ts, null);
});
