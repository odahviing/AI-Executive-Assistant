// Actual matcher module, isolated imports; preserved before module supplies
// boolean equivalence evidence for the existing task and scanner consumers.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), {test} = require('node:test'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
const beforePath = 'artifacts/workshop-verification/chris-paper-trace-20261103/registrar-reference/before/closeLoopOnOwnerHandled.ts';
function load(file) {
  const mod = {exports: {}};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})(name => name === '../core/requests/types' ? {parseDetails: r => JSON.parse(r.details_json || '{}')} : {}, mod, mod.exports);
  return mod.exports;
}
const before = load(beforePath);
const current = load(process.argv.includes('--before') ? beforePath : 'src/utils/closeLoopOnOwnerHandled.ts');
const row = (requester_name, subject = 'Coordination meeting', extra = {}) => ({requester_name, subject, details_json: '{}', ...extra});
const cases = [
  ['compound Anne-Marie', 'Anne-Marie is ready', row('Anne-Marie Smith'), true, ['anne-marie']],
  ['compound Jean-Luc', 'Jean-Luc is ready', row('Jean-Luc Smith'), true, ['jean-luc']],
  ['compound fragments excluded', 'Anne and Marie', row('Anne-Marie'), false, []],
  ['Hebrew prefix', 'לדניאל', row('דניאל'), true, ['דניאל']],
  ['Cyrillic', 'Александр готов', row('Александр'), true, ['александр']],
  ['punctuation', '(Adam), yes', row('Adam'), true, ['adam']],
  ['punctuated counterpart literal', "O'Neil is ready", row("O'Neil Smith"), true, ["o'neil"]],
  ['substring rejected', 'Adamant Pauline', row('Adam'), false, []],
  ['full subject', 'Idan, Chris and Adam', row('Chris Kelly', 'Idan, Chris and Adam'), true, ['chris', 'idan', 'adam']],
  ['full quote Adam', '"Lori & Idan, Weekly" ends at 15:40, just as the Adam meeting would start.', row('Chris Kelly', 'Idan, Chris and Adam'), true, ['idan', 'adam']],
  ['full quote shared Idan', '"Lori & Idan, Weekly" ends at 15:40, just as the Adam meeting would start.', row('Chris Kelly', 'Idan, Chris and Paul'), true, ['idan']],
  ['both compound and Paul compound', 'Anne-Marie and Paul', row('Anne-Marie'), true, ['anne-marie']],
  ['both compound and Paul Paul', 'Anne-Marie and Paul', row('Paul'), true, ['paul']],
  ['target precedence', 'Paul', row('Paul', '', {target_name: 'Adam'}), false, []],
  ['details fallback', 'Jean-Luc', row('', '', {details_json: '{"requester_name":"Jean-Luc"}'}), true, ['jean-luc']],
  ['acronym', 'ANF already done', row('', 'ANF OH meeting'), true, ['anf']],
  ['generic Hebrew prefix excluded', 'הפגישה', row('', 'הפגישה עם דני'), false, []],
  ['generic subject excluded', 'Coordination meeting', row(''), false, []],
];
for (const [name, message, request, expected, references] of cases) {
  test(name + ' preserves existing boolean', () => {
    assert.equal(before.messageReferencesRequest(message, request), expected);
    assert.equal(current.messageReferencesRequest(message, request), expected);
  });
  test(name + ' exposes matched literal references', () => {
    assert.deepEqual(Array.from(current.getMatchingRequestReferences(message, request)), references);
  });
}
test('existing boolean equivalence across all message/request combinations', () => {
  for (const [, message] of cases) for (const [, , request] of cases) {
    assert.equal(current.messageReferencesRequest(message, request), before.messageReferencesRequest(message, request));
  }
});
test('reference extraction preserves compounds, subject rules and deduplicates', () => {
  assert.deepEqual(Array.from(current.getRequestReferences(row('Anne-Marie Smith', 'Anne-Marie ANF coordination'))), ['anne-marie', 'anne', 'marie', 'anf']);
  assert.deepEqual(Array.from(current.getRequestReferences(row('Adam Smith', 'Adam Adam meeting'))), ['adam']);
});
