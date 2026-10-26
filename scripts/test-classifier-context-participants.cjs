// Run: node --test scripts/test-classifier-context-participants.cjs
// Baseline replay: node scripts/test-classifier-context-participants.cjs --before
//
// Captures the real classifyTurn system prompt through an isolated Anthropic
// client. Exercises source validation and captures continuation guidance;
// neither proves that a live model will classify continuation correctly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');

const repo = path.resolve(__dirname, '..');
const revisionAt = process.argv.indexOf('--source-revision');
const sourceRevision = revisionAt >= 0 ? process.argv[revisionAt + 1] : null;

function source(rel) {
  if (process.argv.includes('--before')) return fs.readFileSync(path.join(repo, 'artifacts/workshop-verification/opportunities-20261026/librarian/classifyTurn.before.ts'), 'utf8');
  if (sourceRevision) return cp.execFileSync('git', ['show', `${sourceRevision}:${rel}`], { cwd: repo, encoding: 'utf8' });
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

function loadClassifier() {
  const rel = 'src/core/social/classifyTurn.ts';
  const code = ts.transpileModule(source(rel), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: path.join(repo, rel),
  }).outputText;
  const noop = () => {};
  const deps = {
    '../../utils/logger': { __esModule: true, default: { info: noop, warn: noop, error: noop } },
    '../../utils/usageLog': { logLlmUsage: noop },
    '../../db/socialSubjects': { FIXED_CATEGORIES: ['work', 'personal'] },
    '../../llm/models': require('./load-test-models.cjs'),
  };
  const isolatedRequire = name => {
    assert.ok(Object.hasOwn(deps, name), `unexpected classifyTurn dependency: ${name}`);
    return deps[name];
  };
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { filename: rel })(isolatedRequire, module, module.exports);
  return module.exports.classifyTurn;
}


const profile = {user:{name:'Owner Example'},assistant:{name:'Maelle'},skills:{}};
async function run(raw, extra = {}) {
  let captured; let calls = 0;
  const result = await loadClassifier()({
    anthropic:{messages:{create:async request => { calls++; captured=request; return {content:[{type:'tool_use',input:raw}],usage:{}}; }}},
    message:'What about Thursday afternoon?', profile,needIntent:false,needScopes:false,needMeetingPeople:true,
    meetingContextMessages:[{role:'user',content:'Find time with Dana and Lev'},{role:'assistant',content:'Perhaps add Sara'}],
    recentContext:'DUPLICATE CONTEXT MUST NOT APPEAR', ...extra,
  });
  return { result:JSON.parse(JSON.stringify(result)), captured, calls };
}
test('grounded historical roster survives continuation as separate sourced entries', async()=>{
  const {result,captured,calls}=await run({meeting_people:[],meeting_continuation:true,context_meeting_people:[{name:'Dana',sourceMessageIndex:0},{name:'Lev',sourceMessageIndex:0}]});
  assert.deepEqual(result.contextMeetingPeople,[{name:'Dana',sourceMessageIndex:0},{name:'Lev',sourceMessageIndex:0}]);
  assert.deepEqual(result.meetingPeople,[]); assert.equal(calls,1);
  assert.ok(!captured.system.includes('DUPLICATE CONTEXT'));
  assert.ok(captured.system.includes('[0] user: Find time with Dana and Lev'));
  assert.ok(captured.system.includes('Replace Lev with Sara'));
});
test('assistant, missing, negative, fractional and fabricated source entries are rejected',async()=>{
  const {result}=await run({meeting_continuation:true,context_meeting_people:[{name:'Sara',sourceMessageIndex:1},{name:'Dana',sourceMessageIndex:20},{name:'Dana',sourceMessageIndex:-1},{name:'Dana',sourceMessageIndex:0.5},{name:'Nobody',sourceMessageIndex:0},null]});
  assert.deepEqual(result.contextMeetingPeople,[]);
});
test('false, absent or malformed continuation fails closed',async()=>{
  for(const flag of [false,undefined,'true']) {
    const {result}=await run({meeting_continuation:flag,context_meeting_people:[{name:'Dana',sourceMessageIndex:0}]});
    assert.deepEqual(result.contextMeetingPeople,[]);
  }
});
test('current explicit names remain independent legitimate path',async()=>{
  const {result}=await run({meeting_people:['Sara'],meeting_continuation:false});
  assert.deepEqual(result.meetingPeople,['Sara']);
});
test('no supplied authenticated context cannot admit historical names',async()=>{
  const {result,captured}=await run({meeting_continuation:true,context_meeting_people:[{name:'Dana',sourceMessageIndex:0}]},{meetingContextMessages:undefined});
  assert.deepEqual(result.contextMeetingPeople,[]);
  assert.equal(captured.tools[0].input_schema.properties.context_meeting_people,undefined);
});
test('unicode exact-copy sources are preserved',async()=>{
  const {result}=await run({meeting_continuation:true,context_meeting_people:[{name:'עינב',sourceMessageIndex:0}]},{meetingContextMessages:[{role:'user',content:'פגישה עם עינב'}]});
  assert.deepEqual(result.contextMeetingPeople,[{name:'עינב',sourceMessageIndex:0}]);
});
test('unavailable classifier leaves explicit default and no historical roster',async()=>{
  const {result}=await run({}, {anthropic:{messages:{create:async()=>{throw new Error('fixture unavailable');}}}});
  assert.deepEqual(result.meetingPeople,[]);
  assert.deepEqual(result.contextMeetingPeople ?? [],[]);
});
test('owner and colleague extraction share source validation without persisted carryover',async()=>{
  for(const senderRole of ['owner','colleague']) {
    const accepted=await run({meeting_continuation:true,context_meeting_people:[{name:'Dana',sourceMessageIndex:0}]},{senderRole});
    assert.equal(accepted.result.contextMeetingPeople.length,1);
    const next=await run({meeting_people:['Sara']},{senderRole});
    assert.deepEqual(next.result.contextMeetingPeople,[]);
    assert.deepEqual(next.result.meetingPeople,['Sara']);
  }
});
