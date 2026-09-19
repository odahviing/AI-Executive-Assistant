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
    '../../llm/models': { MODEL_HAIKU: 'fixture-haiku' },
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

test('scope selection is explicitly meaning-based across languages and scripts', () => {
  assert.match(captured.system, /Classify by meaning in any language or script/i);
  assert.match(captured.system, /not literal examples/i);
});

test('explicit attachment-origin calendar placement selects meetings', () => {
  assert.match(captured.system, /put the referenced item on the calendar/i);
  assert.match(captured.system, /\['meetings'\]/);
  assert.match(captured.system, /details are in the attachment/i);
});

test('a non-calendar image request stays general', () => {
  assert.match(captured.system, /An attachment alone adds no scope/i);
  assert.match(captured.system, /summarize this image/i);
  assert.match(captured.system, /\['general'\]/);
});

test('reminders stay in the tasks scope', () => {
  assert.match(captured.system, /tasks\s+— task list \/ reminders \/ routines \/ briefing/i);
  assert.match(captured.system, /"remind me at 4"/i);
});

test('ordinary direct booking remains meetings', () => {
  assert.match(captured.system, /direct booking lives here/i);
  assert.match(captured.system, /Book Mon 10:30 with Yael[^\n]+\['meetings'\]/i);
});

test('task-list and routine examples remain tasks', () => {
  assert.match(captured.system, /"what's pending\?"/i);
  assert.match(captured.system, /"show my tasks"/i);
  assert.match(captured.system, /"set up a daily routine"/i);
});

test('multi-purpose turns retain union guidance', () => {
  assert.match(captured.system, /Default to UNION when the message could touch multiple things/i);
  assert.match(captured.system, /What's pending\? Also any conflicts next week[^\n]+\['tasks', 'meetings'\]/i);
});

test('the existing classifier call and scope schema remain unchanged', () => {
  assert.equal(captured.model, 'fixture-haiku');
  assert.equal(captured.tools.length, 1);
  assert.equal(captured.tools[0].name, 'classify_turn');
  const scopes = captured.tools[0].input_schema.properties.scopes;
  assert.deepEqual(Array.from(scopes.items.enum), ['meetings', 'calendar', 'people', 'tasks', 'knowledge', 'summary', 'venue', 'news', 'general']);
});
