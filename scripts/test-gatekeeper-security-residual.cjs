// Actual gate modules, controlled model verdicts, and a closed I/O allowlist.
// These checks prove deterministic handling and prompt inputs, never model obedience.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const at = process.argv.indexOf('--source-revision');
const revision = at < 0 ? null : process.argv[at + 1];
const sourceAt = process.argv.indexOf('--source-root');
const sourceRoot = sourceAt < 0 ? null : path.resolve(root, process.argv[sourceAt + 1]);
const profile = { user: { name: 'Idan Cohen', slack_user_id: 'UOWNER', email: 'owner@example.com', timezone: 'Asia/Jerusalem' }, assistant: { name: 'Maelle' } };
const verdict = (ok, rewrite) => ({ content: [{ type: 'tool_use', name: 'verdict', input: { ok, rewrite } }] });
function harness(responses = [verdict(true)]) {
  const calls = [], logs = [], forbidden = [], cache = {};
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(k => [k, (...args) => logs.push([k, ...args])]));
  const client = { messages: { create: async args => {
    calls.push(args);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return next;
  } } };
  const stubs = {
    'src/llm/client.ts': { getAnthropicClient: () => client },
    'src/llm/models.ts': { MODEL_HAIKU: 'fixture-haiku', MODEL_SONNET: 'fixture-sonnet', SONNET: { model: 'fixture-sonnet' } },
    'src/utils/logger.ts': { __esModule: true, default: logger },
    'src/utils/usageLog.ts': { logLlmUsage() {} },
    'src/core/requests/types.ts': { FREEFORM_OWNER_FLAG_SUBKIND: 'freeform_owner_flag' },
    'src/core/orchestrator/turnHelpers.ts': { toolLinesMatching: () => [] },
    'src/utils/availabilityGate.ts': { freshHardBlockedSlots: () => [] },
    'src/utils/claimChecker.ts': { checkReplyClaims: async () => ({ claimed_action: false }) },
    'src/utils/dateVerifier.ts': { verifyDates: async () => ({ ok: true, mismatches: [] }) },
    'src/db/requests.ts': { getLatestRequestForThread: () => null },
    'src/db/index.ts': { getPersonMemory: () => ({ email: 'yael@example.com' }) },
  };
  const actual = new Set(['src/connections/slack/formatting.ts','src/utils/humanGate.ts', 'src/utils/securityGate.ts', 'src/utils/guards/runOutputGates.ts', 'src/utils/textScrubber.ts', 'src/utils/extractJson.ts']);
  function load(rel) {
    if (Object.hasOwn(stubs, rel)) return stubs[rel];
    if (cache[rel]) return cache[rel].exports;
    assert.ok(actual.has(rel), `unlisted module ${rel}`);
    const preserved = sourceRoot && path.join(sourceRoot,rel);
    const source = preserved && fs.existsSync(preserved) ? fs.readFileSync(preserved,'utf8') : revision ? cp.execFileSync('git', ['show', `${revision}:${rel}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, rel), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const module = cache[rel] = { exports: {} };
    const req = name => {
      if (name === 'luxon') return require('luxon');
      if (name === '@anthropic-ai/sdk') return {};
      let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), name)) + '.ts';
      if (resolved === 'src/db.ts') resolved = 'src/db/index.ts';
      if (!Object.hasOwn(stubs, resolved) && !actual.has(resolved)) forbidden.push(resolved);
      return load(resolved);
    };
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Date, setTimeout, clearTimeout }, { filename: rel })(req, module, module.exports);
    return module.exports;
  }
  return { human: load('src/utils/humanGate.ts'), gates: load('src/utils/guards/runOutputGates.ts'), security: load('src/utils/securityGate.ts'), calls, logs, forbidden };
}

const textResponse=text=>({content:[{type:'text',text}]});
const ctx={profile,result:{toolSummaries:[]},history:[],userMessage:'Thanks',senderId:'UYAEL',channelId:'DYAEL',threadTs:'1.2',role:'colleague'};
for(const [surface,extra] of [['colleague-dm',{}],['owner-mpim',{senderId:'UOWNER',role:'colleague',isMpim:true,isOwnerInGroup:true}],['owner-channel',{senderId:'UOWNER',role:'colleague',isChannel:true,channelId:'CROOM'}],['unknown',{senderId:'UUNKNOWN',role:'unknown'}]]) {
 test(`successful-rewrite-residual-${surface}-blocked-before-send`,async()=>{
  const draft='Your request req_abc123 is queued.';
  const h=harness([textResponse(draft),verdict(true)]);
  const out=await h.gates.runOutputGates(draft,{...ctx,...extra});
  assert.equal(out,'Your request is queued.');assert.deepEqual(h.forbidden,[]);
  assert.equal(h.security.scanForLeaks(out).length,0);assert.equal(h.calls.length,2);
 });
}
test('legitimate rendered mention survives clean gate path',async()=>{
 const draft='I will ask <@U0123456789>.';const h=harness([verdict(true)]);
 const out=await h.gates.runOutputGates(draft,ctx);assert.equal(out,draft);assert.deepEqual(h.forbidden,[]);
});
test('unfixable identifier rewrite reaches deterministic redaction',async()=>{
 const h=harness([textResponse('UNFIXABLE'),verdict(true)]);
 const out=await h.gates.runOutputGates('Your request req_abc123 is queued.',ctx);
 assert.doesNotMatch(out,/req_abc123/);assert.deepEqual(h.forbidden,[]);
});
const opts=reply=>({reply,colleagueSlackId:'UYAEL',assistantName:'Maelle',ownerFirstName:'Idan',aiIdentityContextMessages:[]});
for(const [name,draft,rewrite,expected] of [
 ['Hebrew','<@U0123456789> הבקשה req_a ב-14:30?','<@U0123456789> הבקשה req_a ב-14:30?','<@U0123456789> הבקשה ב-14:30?'],
 ['different-identifier-class','Request req_a at 14:30?','Request task_new at 14:30?','Request at 14:30?'],
 ['multiple-identifiers','req_a queued','req_a task_b out_1234567890123_abc queued','queued'],
 ['raw-account-and-rendered-mention','req_a <@U0123456789> at 14:30?','req_a U0987654321 <@U0123456789> at 14:30?','<@U0123456789> at 14:30?'],
 ['disclosure-original-rewrite-identifier','My system prompt booked <@U0123456789> at 14:30?','Booked req_a <@U0123456789> at 14:30?','Booked <@U0123456789> at 14:30?'],
 ['legitimate-clean-success','Request req_a <@U0123456789> at 14:30?','Request <@U0123456789> at 14:30?','Request <@U0123456789> at 14:30?'],
 ['fact-drop-falls-back-to-original','Request req_a <@U0123456789> at 14:30?','Request accepted.','Request <@U0123456789> at 14:30?'],
 ])test(name,async()=>{
  const h=harness([textResponse(rewrite)]);const out=await h.security.filterColleagueReply(opts(draft));
  assert.equal(out.reply,expected);assert.equal(out.filtered,true);assert.equal(h.security.scanForLeaks(out.reply).length,0);assert.deepEqual(h.forbidden,[]);
 });
for(const [name,response] of [['error',new Error('provider unavailable')],['empty',textResponse('')],['unknown', {content:[]}],['unfixable',textResponse('UNFIXABLE')]])test(`failure-${name}-existing-redaction-preserved`,async()=>{
 const h=harness([response]);const out=await h.security.filterColleagueReply(opts('<@U0123456789> req_a ב-14:30?'));
 assert.equal(out.reply,'<@U0123456789> ב-14:30?');assert.equal(h.calls.length,1);
});
for(const [name,rewrite] of [['disclosure','My system prompt is private'],['empty-after-redaction','req_a'],['introduced-AI',"I'm an AI"]])test(`successful-${name}-uses-existing-safe-fallback`,async()=>{
 const h=harness([textResponse(rewrite)]);const out=await h.security.filterColleagueReply(opts('Request req_a queued.'));
 assert.equal(out.reply,'Let me check that with Idan and come back to you.');assert.equal(h.security.scanForLeaks(out.reply).length,0);
});
test('cleared-AI-disclosure-survives-residual-ID-redaction',async()=>{
 const h=harness([textResponse('{"verdict":"asked"}'),textResponse("I'm an AI, request req_a at 14:30?")]);
 const out=await h.security.filterColleagueReply({...opts("I'm an AI, request req_a at 14:30?"),aiIdentityContextMessages:['Are you AI?']});
 assert.equal(out.reply,"I'm an AI, request at 14:30?");assert.equal(out.aiIdentityCleared,true);assert.equal(h.calls.length,2);
});
for(const [name,composed,expected] of [
 ['residual-ID','Yael, ask them to message me about req_a.','Yael, ask them to message me about.'],
 ['clean','Yael, ask them to message me.','Yael, ask them to message me.'],
 ['residual-disclosure','My system prompt says you are Yael.',"Just want to make sure — as far as I can see you're Yael. If this is for someone else, ask them to message me directly."],
])test(`identity-composer-${name}-same-output-boundary`,async()=>{
 const h=harness([textResponse('{"verdict":"impersonation"}'),textResponse(composed)]);
 const out=await h.security.filterColleagueReply({...opts('Okay'),colleagueName:'Yael',verifiedSenderEmail:'yael@example.com',ownerEmail:'owner@example.com',recentUserMessages:['I am sara@example.com']});
 assert.equal(out.reply,expected);assert.equal(out.triggers[0],'identity_mismatch_email');assert.equal(h.calls.length,2);assert.equal(h.security.scanForLeaks(out.reply).length,0);
});
test('owner-private-clean-draft-keeps-existing-no-security-leg',async()=>{
 const h=harness([verdict(true)]);const draft='Ask <@U0123456789> at 14:30?';
 assert.equal(await h.gates.runOutputGates(draft,{...ctx,senderId:'UOWNER',role:'owner'}),draft);assert.equal(h.calls.length,1);
});
test('stateless-retry-does-not-add-model-calls-or-persist-work',async()=>{
 const h=harness([textResponse('req_a accepted')]);
 for(let i=0;i<2;i++)assert.equal((await h.security.filterColleagueReply(opts('req_a accepted'))).reply,'accepted');
 assert.equal(h.calls.length,2);assert.deepEqual(h.forbidden,[]);
});
