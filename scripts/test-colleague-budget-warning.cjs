// Execute the actual orchestrator budget branch, limiter, shadow routing and
// Slack formatter; only transport/database I/O is replaced. No model calls.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
const silent = { info() {}, warn() {}, error() {}, debug() {} };
function load(file, deps, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: n => {
    if (Object.hasOwn(deps, n)) return deps[n];
    throw Error('Unexpected dependency ' + n);
  }, Date, ...globals }, { filename: file });
  return exports;
}
async function fixture(options = {}) {
  let now = 1000000;
  class Clock extends Date { static now() { return now; } }
  const limiter = load('src/utils/rateLimit.ts', { './logger': silent }, { Date: Clock, setInterval: () => ({ unref() {} }) });
  const scrubber = load('src/utils/textScrubber.ts', { luxon: require('luxon'), './logger': silent });
  const formatter = load('src/connections/slack/formatting.ts', { '../../utils/textScrubber': scrubber });
  const labels = load('src/utils/toolStatusText.ts', {});
  const sent = [], history = [];
  const connection = {
    postToChannel: async (channel, text) => {
      sent.push({ channel, text: formatter.formatForSlack(text) });
      return options.delivery === 'unknown' ? { ok: false, reason: 'unknown' } : { ok: true, ref: channel, ts: 'notice' };
    },
    sendDirect: async (user, text) => { sent.push({ user, text: formatter.formatForSlack(text) }); return { ok: false, reason: 'unknown' }; },
  };
  const shadow = load('src/utils/shadowNotify.ts', {
    '../connections/registry': { getConnection: () => options.unavailable ? undefined : connection },
    '../db/conversations': { appendToConversation: (...args) => history.push(args) }, './logger': silent,
    './ownerDailyThread': { getOrCreateOwnerDailyThread: async () => ({ channel: 'DOWNER', rootTs: 'daily' }) },
  });
  const source = fs.readFileSync(process.env.BUDGET_BEFORE_SOURCE || path.join(root, 'src/core/orchestrator/index.ts'), 'utf8');
  const start = source.indexOf('      // ── RATE LIMIT: colleague tool calls');
  const end = source.indexOf('      // v2.4.3 (A1)', start);
  assert.ok(start > 0 && end > start);
  const wrapped = 'exports.run = async function(input, profile, toolUse) { const threadTs=input.threadTs; const toolResults=[]; const toolCallSummaries=[]; let executed=0; for(const once of [1]) {' + source.slice(start, end) + 'executed++; } return {toolResults,toolCallSummaries,executed}; };';
  const code = ts.transpileModule(wrapped, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const deps = { '../../utils/rateLimit': limiter, '../../utils/shadowNotify': shadow, '../../utils/toolStatusText': labels };
  vm.runInNewContext(code, { exports, logger: silent, require: n => { assert.ok(deps[n], n); return deps[n]; } });
  const input = { userId: 'RITA', threadTs: 'THREAD', channelId: 'DRITA', senderName: 'Rita', senderRole: 'colleague', app: {}, ...options.input };
  const profile = { user: { name: 'Idan Owner', slack_user_id: 'OWNER' }, behavior: { v1_shadow_mode: true } };
  const run = () => exports.run(input, profile, { id: 'call', name: options.tool || 'create_meeting' });
  return { run, sent, history, advance: ms => { now += ms; }, fill: async () => { for (let i=0;i<10;i++) assert.equal((await run()).executed,1); } };
}
let passed=0, failed=0;
async function check(name, fn) { try { await fn(); console.log('PASS '+name); passed++; } catch(e) { console.log('FAIL '+name+': '+e.message); failed++; } }
(async () => {
  await check('readable blocked meeting reaches owner through scrubber', async () => { const h=await fixture(); await h.fill(); const r=await h.run(); assert.equal(r.executed,0); assert.match(h.sent[0].text,/Blocked action: "Setting up the meeting" \(not executed\)/); assert.doesNotMatch(h.sent[0].text,/create_meeting/); assert.equal(h.sent[0].channel,'DOWNER'); });
  await check('unmapped action has readable fallback', async () => { const h=await fixture({tool:'unknown_internal_tool'}); await h.fill(); await h.run(); assert.match(h.sent[0].text,/Blocked action: "Requested action"/); });
  await check('approval action uses owner label', async () => { const h=await fixture({tool:'create_approval'}); await h.fill(); await h.run(); assert.match(h.sent[0].text,/Blocked action: "Checking with Idan"/); });
  await check('ten calls accepted eleventh refused with failed summary', async () => { const h=await fixture(); await h.fill(); const r=await h.run(); assert.equal(r.executed,0); assert.match(r.toolCallSummaries[0],/FAILED/); assert.equal(JSON.parse(r.toolResults[0].content)._status,'deferred_to_owner'); });
  await check('owner bypass preserves legitimate execution', async () => { const h=await fixture({input:{senderRole:'owner'}}); await h.fill(); assert.equal((await h.run()).executed,1); assert.equal(h.sent.length,0); });
  await check('owner present room bypass preserved', async () => { const h=await fixture({input:{isOwnerInGroup:true,channelId:'ROOM'}}); await h.fill(); assert.equal((await h.run()).executed,1); assert.equal(h.sent.length,0); });
  await check('colleague room warning routes only to owner', async () => { const h=await fixture({input:{channelId:'ROOM'}}); await h.fill(); await h.run(); assert.equal(h.sent[0].channel,'DOWNER'); });
  await check('unavailable connection still refuses action', async () => { const h=await fixture({unavailable:true}); await h.fill(); assert.equal((await h.run()).executed,0); assert.equal(h.sent.length,0); });
  await check('unknown notice delivery never executes blocked action', async () => { const h=await fixture({delivery:'unknown'}); await h.fill(); assert.equal((await h.run()).executed,0); assert.equal(h.history.length,0); });
  await check('without Slack app still refuses without notice', async () => { const h=await fixture({input:{app:undefined}}); await h.fill(); assert.equal((await h.run()).executed,0); assert.equal(h.sent.length,0); });
  await check('window expiry restores execution', async () => { const h=await fixture(); await h.fill(); assert.equal((await h.run()).executed,0); h.advance(300000); assert.equal((await h.run()).executed,1); });
  await check('restart resets existing in-memory accounting', async () => { const h=await fixture(); await h.fill(); assert.equal((await h.run()).executed,0); const restarted=await fixture(); assert.equal((await restarted.run()).executed,1); });
  console.log(`${passed} passed; ${failed} failed`); process.exitCode=failed?1:0;
})();
