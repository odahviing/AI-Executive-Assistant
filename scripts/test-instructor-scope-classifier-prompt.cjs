// Run: node --test scripts/test-instructor-scope-classifier-prompt.cjs
// Baseline replay: node scripts/test-instructor-scope-classifier-prompt.cjs --source-revision 63221e4
//
// Captures the real classifyTurn system prompt through an isolated Anthropic
// client. Assertions prove which scope guidance is presented to the existing
// classifier call; they do not prove that a model will obey it.
const { test, before } = require('node:test');
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

let captured;
before(async () => {
  const classifyTurn = loadClassifier();
  const anthropic = { messages: { create: async request => {
    captured = request;
    return { content: [{ type: 'tool_use', input: { scopes: ['general'] } }], usage: {} };
  } } };
  const result = await classifyTurn({
    anthropic,
    message: 'Please classify this referenced item for the appropriate tools.',
    profile: {
      user: { name: 'Owner Example' },
      assistant: { name: 'Maelle' },
      skills: { knowledge: true, summary: true, venue: true, news: true },
    },
    needIntent: false,
    needScopes: true,
  });
  assert.deepEqual(Array.from(result.scope.scopes), ['general']);
  assert.equal(result.scope.source, 'classifier');
  if (process.argv.includes('--metrics')) {
    console.log(`# prompt-metrics ${JSON.stringify({ systemPromptChars: captured.system.length })}`);
  }
});

test('compact scope contract preserves multilingual union and attachment intent',()=>{
 assert.match(captured.system,/meaning in any language or script/i);assert.match(captured.system,/all relevant scopes/i);
 assert.match(captured.system,/An attachment alone adds no scope/);assert.match(captured.system,/put its referenced item on the calendar selects meetings/);
 assert.match(captured.system,/tasks covers reminders, pending work, routines and briefings/);
 assert.match(captured.system,/meetings includes scheduling, availability, moves, holds, cancellations and categorizing an event/);
 assert.match(captured.system,/A short answer inherits the work it answers/);
});

test('the existing classifier call and scope schema remain unchanged', () => {
  assert.equal(captured.model, require('./load-test-models.cjs').HAIKU.model);
  assert.equal(captured.tools.length, 1);
  assert.equal(captured.tools[0].name, 'classify_turn');
  const scopes = captured.tools[0].input_schema.properties.scopes;
  assert.deepEqual(Array.from(scopes.items.enum), ['meetings', 'calendar', 'people', 'tasks', 'knowledge', 'summary', 'venue', 'news', 'general']);
});
