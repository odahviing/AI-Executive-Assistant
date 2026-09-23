// Real stateMachine.ts (directiveForPersonSocial + formatDirectiveForPromptBlock)
// with its store imports stubbed: no DB, no network, no model call. Proves the
// SOCIAL DIRECTIVE text a reply turn receives; the model's obedience to it is
// not exercised here.
// Before run: SOCIAL_DIRECTIVE_SOURCE=<dir holding a preserved src/core/social/stateMachine.ts>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const rel = 'src/core/social/stateMachine.ts';
const before = process.env.SOCIAL_DIRECTIVE_SOURCE ? path.join(root, process.env.SOCIAL_DIRECTIVE_SOURCE, rel) : null;
const src = fs.readFileSync(before && fs.existsSync(before) ? before : path.join(root, rel), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const noop = () => {};
const mod = { exports: {} };
const req = spec => {
  if (spec === '../../utils/logger') return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
  if (spec === '../../db/socialSubjects') return { FIXED_CATEGORIES: [], MAX_ACTIVE_CATEGORIES_PER_PERSON: 3 };
  if (spec === '../../db/people') return { hasUnknownSocialCaptureAfter: () => false };
  throw new Error(`Unexpected dependency: ${spec}`);
};
vm.runInNewContext(js, { exports: mod.exports, module: mod, require: req, Date, Math }, { filename: rel });
const sm = mod.exports;

const cls = (social, state = 'open') => ({ kind: 'social', conversation_state: state, social });
// The live Simon turn (2026-09-20 13:16:44Z): social/share/neutral, category news, open.
const simon = sm.formatDirectiveForPromptBlock(sm.directiveForPersonSocial({ classification: cls({ direction: 'share', sentiment: 'neutral', category_hint: 'news' }) }));
const closing = sm.formatDirectiveForPromptBlock(sm.directiveForPersonSocial({ classification: cls({ direction: 'reaction', sentiment: 'neutral', category_hint: 'news' }, 'closing') }));
const negative = sm.formatDirectiveForPromptBlock(sm.directiveForPersonSocial({ classification: cls({ direction: 'share', sentiment: 'negative', category_hint: 'health' }) }));

const cases = [
  ['SDW-R01', 'regression', 'engage rule names a promise to update later as not progress', () => {
    assert.match(simon, /Mode: engage/);
    assert.match(simon, /"Good to know" or "wow cool" alone is not progress, nor is a promise to update them later/);
  }],
  ['SDW-R02', 'regression', 'engage rule points at a specific detail from what Maelle shared earlier', () => {
    assert.match(simon, /PROGRESS the subject in THIS reply — react to what they said with something specific \(a detail from what you shared earlier is ideal\)/);
  }],
  ['SDW-R03', 'regression', 'ABOVE ALL line ends social turns on the substance, naming the "I\'ll flag it your way" closer', () => {
    assert.match(simon, /IS the response: end on it, not a service closer \("let me know if you need anything", "I'll flag it your way"\)/);
  }],
  ['SDW-P01', 'preserved', 'closing turn keeps acknowledge-and-stop with no follow-up question', () => {
    assert.match(closing, /this is a closing turn\. Acknowledge briefly what they just said, then let the goodbye stand — no follow-up question/);
    assert.doesNotMatch(closing, /PROGRESS the subject in THIS reply/);
  }],
  ['SDW-P02', 'preserved', 'follow-up question stays one option among several (not mandatory); subject closes when THEY close it', () => {
    assert.match(simon, /share back, or ask a follow-up that gives/);
    assert.match(simon, /until THEY close it/);
  }],
  ['SDW-P03', 'preserved', 'negative sentiment keeps its commiserate tone cue', () => {
    assert.match(negative, /Tone: commiserate, light empathy; no solutions unless asked/);
  }],
  ['SDW-P04', 'preserved', 'no directive -> no block (task/none turns untouched)', () => {
    assert.equal(sm.formatDirectiveForPromptBlock(sm.noDirective()), '');
  }],
];

let passed = 0, failed = 0;
for (const [id, kind, name, fn] of cases) {
  try { fn(); passed++; console.log(`ok ${id} [${kind}] ${name}`); }
  catch (e) { failed++; console.log(`not ok ${id} [${kind}] ${name}\n  ${String(e.message).split('\n')[0]}`); }
}
console.log(`block chars (Simon engage turn): ${simon.length}`);
console.log(`${passed} passed; ${failed} failed`);
process.exit(failed ? 1 : 0);
