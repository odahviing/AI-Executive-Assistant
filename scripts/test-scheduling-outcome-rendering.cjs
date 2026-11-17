const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies) {
  const source = fs.readFileSync(process.env.OUTCOME_BEFORE_ROOT ? path.join(process.env.OUTCOME_BEFORE_ROOT, file) : file, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { Date }, { filename: file })(
    name => {
      assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency ' + name);
      return dependencies[name];
    }, module, module.exports,
  );
  return module.exports;
}

const rendering = load('src/core/orchestrator/schedulingOptions.ts', { luxon: require('luxon') });
const evidence = [{ tool: 'find_available_slots', slots: [
  { start: '2026-11-19T10:15:00-05:00', end: '2026-11-19T10:40:00-05:00', presentation_local: 'Thu 19 Nov 17:15 GMT+2' },
  { start: '2026-11-19T10:45:00-05:00', end: '2026-11-19T11:10:00-05:00', presentation_local: 'Thu 19 Nov 17:45 GMT+2' },
] }];
const { options } = rendering.schedulingOptions(evidence, 'America/New_York', false);

test('a schema-valid introduction and options in one part retains the compact answer', () => {
  assert.equal(rendering.renderSchedulingParts([{ text: 'Two 25-minute openings.', options: [1] }], options),
    'Two 25-minute openings.\nThu 19 Nov (GMT+2) · 17:15, 17:45');
});

test('separate text and options retain the existing format', () => {
  assert.equal(rendering.renderSchedulingParts([{ text: 'אפשר ב־' }, { options: [1, 2] }], options),
    'אפשר ב־\nThu 19 Nov (GMT+2) · 17:15, 17:45');
});

test('invalid option identities and malformed fields produce no partially valid reply', () => {
  for (const parts of [[{ options: [99] }], [{ text: 5, options: [1] }], [{}], [{ options: [] }]]) {
    assert.equal(rendering.renderSchedulingParts(parts, options), undefined);
  }
});

test('reply composition accepts the actual combined text and options response', async () => {
  let request;
  const composer = load('src/core/orchestrator/composeSchedulingOutcome.ts', {
    luxon: require('luxon'),
    '../../llm/models': require('./load-test-models.cjs'),
    './turnHelpers': { callClaude: async value => {
      request = value;
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'offer_times',
        input: { parts: [{ text: 'Choose a 25-minute opening.', options: [1, 2] }] } }] };
    } },
    './schedulingOptions': rendering,
    '../../db/slotHolds': { MAX_HOLDS_PER_HOLDER: 3, MAX_HOLDS_PER_MEETING: 2 },
  });
  const result = await composer.composeSchedulingOutcome({
    message: 'What times are available?', history: [], receipts: [], draft: 'Long preliminary response.',
    evidence, readTools: [], remainingTools: [], availableOperations: ['find_available_slots'],
    supportedOperations: ['find_available_slots', 'create_meeting'], owner: 'Idan', ownerZone: 'America/New_York',
    isOwner: false, offeredSlotCount: 8, allowedDurations: [10, 25, 40, 55],
  });
  assert.equal(result.reply, 'Choose a 25-minute opening.\nThu 19 Nov (GMT+2) · 17:15, 17:45');
  assert.deepEqual(Array.from(request.tools, tool => tool.name), ['finish_turn', 'offer_times']);
  const data = JSON.parse(request.messages[0].content);
  assert.deepEqual(data.supportedOperations, ['find_available_slots', 'create_meeting']);
  assert.deepEqual(data.availableOperations, ['find_available_slots']);
});
