// Execute the actual complete turn builder with the boundary suite's isolated loader.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
let harness = fs.readFileSync(path.join(__dirname, 'test-turn-context-boundaries.cjs'), 'utf8').split("test('room framing")[0];
harness = harness.replace("'artifacts/workshop-verification/slack-audit-20260919/handyman'", "'artifacts/workshop-verification/owner-rulings-20260929/handyman'")
  .replace('`${prefix}/before/buildTurnContext.ts`', '`${prefix}/before/src/core/orchestrator/buildTurnContext.ts`')
  .replace("'src/utils/skillPreferences.ts']);", "'src/utils/skillPreferences.ts', 'src/utils/detectMessageLanguage.ts']);")
  .replace("    'src/utils/detectMessageLanguage.ts': { detectMessageLanguage: () => null },", "    'src/db/people.ts': { setLastInboundLang: (id, code) => { state.stamped = code; } },");
const fixture = vm.runInNewContext(`(function(require,__dirname,process){${harness}\nreturn fixture;})`, { Buffer })(require, __dirname, process);
const cases = [
  ['voice Hebrew short', '[Voice message]: כן', [], 'Hebrew', 'he', 'regression'],
  ['voice Russian short', '[Voice message]: да', [], 'Russian', 'ru', 'regression'],
  ['voice Arabic short', '[Voice message]: نعم', [], 'Arabic', 'ar', 'regression'],
  ['voice Spanish', '[Voice message]: Buenos días', [], 'Latin-script', 'en', 'regression'],
  ['voice contentless history', '[Voice message]: 11:15', [{ role: 'user', content: 'שלום לך' }], 'Hebrew', undefined, 'regression'],
  ['text contentless voice history', '👍', [{ role: 'user', content: '[Voice message]: да' }, { role: 'assistant', content: 'שלום לך' }], 'Russian', undefined, 'regression'],
  ['voice unavailable history', '[Voice message]: 👍', [], null, undefined, 'preserved'],
  ['text Hebrew', 'שלום לך', [], 'Hebrew', 'he', 'preserved'],
  ['text Spanish overrides Hebrew history', 'Buenos días', [{ role: 'user', content: 'שלום לך' }], 'Latin-script', 'en', 'preserved'],
  ['short Latin signal', 'ok', [{ role: 'user', content: 'שלום לך' }], 'Latin-script', 'en', 'preserved'],
  ['text contentless history', '11:15', [{ role: 'user', content: 'שלום לך' }], 'Hebrew', undefined, 'preserved'],
];
for (const [id, userMessage, conversationHistory, expected, stamped, kind] of cases) {
  for (const surface of ['owner', 'colleague', 'room']) test(`${id} ${surface} [${id === 'voice unavailable history' && surface !== 'owner' ? 'regression' : kind}]`, async t => {
    const f = fixture(t);
    const r = await f.run({ userMessage, conversationHistory, voiceInput: userMessage.startsWith('[Voice message]'),
      ...(surface === 'owner' ? {} : { senderRole: 'colleague', userId: 'UACTIVE', authority: 'colleague', surface: surface === 'room' ? 'room' : 'colleague_dm', isChannel: surface === 'room' }),
    });
    const directive = r.prompt.split('\n').find(line => line.startsWith('LANGUAGE (this turn):'));
    if (expected) assert.ok(directive?.includes(expected), `Expected ${expected}, got ${directive}`);
    else assert.equal(directive, undefined);
    assert.equal(f.state.stamped, surface === 'owner' ? undefined : stamped);
    assert.equal(r.messages.at(-1).content, userMessage, 'transport/audio marker and transcript retained');
  });
}
