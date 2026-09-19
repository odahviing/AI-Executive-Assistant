/* Shared calendar-listing prompt integration for profile-aware floating blocks.
 * CALENDAR_LISTING_SOURCE_FIXTURE selects the preserved wording for before proof.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const sourceFile = process.env.CALENDAR_LISTING_SOURCE_FIXTURE
  || path.join(root, 'src/utils/calendarListingFormat.ts');
const source = fs.readFileSync(sourceFile, 'utf8');
const js = ts.transpileModule(source, {
  fileName: sourceFile,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(`(function(module,exports){${js}\n})`, {}, { filename: sourceFile })(mod, mod.exports);
const rule = mod.exports.calendarListingFormatRule('Owner');
console.log(JSON.stringify({ calendarListingRuleChars: rule.length }));

test('fixed floating meetings remain listed while movable personal blocks are omitted', () => {
  assert.match(rule, /omit when `fixed` is absent\/false/i);
  assert.match(rule, /when `fixed=true`, list it like any other meeting/i);
  assert.match(rule, /another person makes it fixed/i);
  assert.doesNotMatch(rule, /Skip events tagged `is_floating_block`/);
});

test('the same listing rule remains injected into brief and meetings prompts', () => {
  const brief = fs.readFileSync(path.join(root, 'src/tasks/briefs.ts'), 'utf8');
  const meetings = fs.readFileSync(path.join(root, 'src/skills/meetings.ts'), 'utf8');
  assert.equal((brief.match(/calendarListingFormatRule\(firstName\)/g) || []).length, 1);
  assert.equal((meetings.match(/calendarListingFormatRule\(firstName\)/g) || []).length, 1);
});

test('brief calendar normalization forwards the full floating marker unchanged', () => {
  const brief = fs.readFileSync(path.join(root, 'src/tasks/briefs.ts'), 'utf8');
  assert.match(brief, /is_floating_block:\s*e\.is_floating_block/);
});
