// Structural capture of the actual builder. No app, DB, network or model calls.
// Replay: node scripts/test-instructor-v5-language.cjs --source-root <snapshot>
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { DateTime, Settings } = require('luxon');
const root = path.resolve(__dirname, '..');
const at = process.argv.indexOf('--source-root');
const sourceRoot = at < 0 ? root : path.resolve(root, process.argv[at + 1]);
const rel = 'src/core/orchestrator/systemPrompt.ts';
const noop = () => {};
const deps = {
  luxon: require('luxon'),
  '../../skills/registry': { getActiveSkills: () => [], getSkillTools: () => [] },
  '../../utils/skillPreferences': { formatSystemPromptPreferenceBlocks: () => '' },
  '../../utils/logger': { __esModule: true, default: { warn: noop } },
  '../../db': { formatPreferencesCatalog: () => '', formatPeopleMemoryForPrompt: () => '', formatThreadPeopleBlock: () => '', getPersonMemory: () => null, authoritativeGender: () => 'unknown' },
  '../../db/requests': { getAwaitingOwnerRequests: () => [], getOpenRequestsForThread: () => [], getUnrelayedTerminalRequestForThread: () => null },
  '../requests/types': { parseDetails: () => null },
  '../assistantSelf': { formatAssistantSelfForPrompt: () => 'ABOUT YOU\nYour name was chosen by the owner.' },
  '../../memory/peopleMemory': { formatPeopleCatalogSync: () => '', readPersonMemorySync: () => '' },
  '../../utils/effectiveToday': { getEffectiveToday: p => DateTime.now().setZone(p.user.timezone).startOf('day') },
  '../../connections/registry': { listConnections: () => [] },
};
const compiled = ts.transpileModule(fs.readFileSync(path.join(sourceRoot, rel), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Date, Set, Map })(name => {
  assert.ok(Object.hasOwn(deps, name), `Unexpected dependency: ${name}`);
  return deps[name];
}, mod, mod.exports);
const profile = {
  user: { name: 'Owner Example', role: 'Founder', slack_user_id: 'UOWNER', timezone: 'Asia/Jerusalem', language: 'en' },
  assistant: { name: 'Maelle', persona: 'Warm and concise.' },
  schedule: { office_days: { days: ['Sunday'] }, home_days: { days: ['Monday'] }, day_boundary_hour: '00:00' },
  skills: {}, channels: {},
};
Settings.now = () => Date.UTC(2026, 8, 24, 12);
const surfaces = [
  ['owner-dm', 'owner', false, false, 'slack', 'UOWNER'],
  ['colleague-dm', 'colleague', false, false, 'slack', 'UCOLL'],
  ['owner-mpim', 'colleague', true, false, 'slack', 'UOWNER'],
  ['colleague-channel', 'colleague', false, true, 'slack', 'UCOLL'],
  ['owner-email', 'owner', false, false, 'email', 'UOWNER'],
];
let passed = 0, failed = 0;
function check(id, kind, fn) {
  try { fn(); passed++; console.log(`ok ${id} [${kind}]`); }
  catch (err) { failed++; console.log(`not ok ${id} [${kind}] ${String(err.message).split('\n')[0]}`); }
}
const captures = {};
for (const [id, role, mpim, channel, transport, sender] of surfaces) {
  const p = mod.exports.buildSystemPromptParts(profile, role, 'Speaker', mpim && sender === 'UOWNER', undefined, mpim, channel, undefined, sender, [], undefined, transport, sender === 'UOWNER' ? 'owner' : 'colleague', []);
  captures[id] = p;
  console.log(`METRICS ${id} ${JSON.stringify({ staticChars: p.static.length, dynamicChars: p.dynamic.length, totalChars: p.static.length + p.dynamic.length, tokenHeuristic: 'chars/4 is not tokenizer usage', approximateTokens: Math.round((p.static.length + p.dynamic.length) / 4) })}`);
  check(`${id}-title-consistency`, 'regression', () => {
    assert.ok(p.static.includes('when you MENTION it in another language'));
    assert.ok(!p.static.includes('Meeting titles are proper nouns — keep original language'));
  });
  check(`${id}-brand-consistency`, 'regression', () => {
    assert.ok(p.static.includes('only a genuine brand/product noun (Teams, Salesforce) stays as-is'));
    assert.ok(!p.static.includes('No Latin letters inside non-Latin text.'));
  });
  check(`${id}-language-controls`, 'preserved', () => {
    assert.ok(p.static.includes('LANGUAGE — CURRENT TURN WINS'));
    assert.ok(p.static.includes('saved in English and STAYS English in Outlook'));
    assert.ok(p.static.includes('native spelling is on file'));
    assert.ok(p.static.includes('VERBATIM quotes can stay in the original language'));
  });
  check(`${id}-identity-controls`, 'preserved', () => {
    assert.ok(p.static.includes('answer honestly and warmly'));
    assert.ok(p.static.includes('Never claim to be human'));
    assert.ok(p.static.includes('ABOUT YOU'));
    assert.ok(p.static.includes('Never fabricate a backstory'));
  });
  check(`${id}-unsettled-gender`, 'preserved', () => {
    assert.ok(p.static.includes('gender: unknown/unconfirmed → write gender-NEUTRALLY'));
    assert.ok(p.static.includes('Gender already set → use it. Never re-ask.'));
  });
}
check('email-forwardable-only', 'preserved', () => assert.ok(captures['owner-email'].dynamic.includes('Compose ONLY this forwardable text')));
check('slack-no-email-guidance', 'preserved', () => assert.ok(!captures['owner-dm'].dynamic.includes('EMAIL REPLY —')));
check('owner-settings-explanation', 'preserved', () => assert.ok(captures['owner-dm'].static.includes('ANSWER it plainly in a sentence')));
check('colleague-no-owner-knowledge', 'preserved', () => assert.ok(!captures['colleague-dm'].dynamic.includes('WHAT YOU KNOW ABOUT OWNER')));
const captureAt = process.argv.indexOf('--capture');
if (captureAt >= 0) fs.writeFileSync(path.resolve(root, process.argv[captureAt + 1]), JSON.stringify(captures, null, 2));
Settings.now = () => Date.now();
console.log(`RESULT ${JSON.stringify({ passed, failed })}`);
process.exitCode = failed ? 1 : 0;
