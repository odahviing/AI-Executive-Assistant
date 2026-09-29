const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm'), path = require('path'), ts = require('typescript');
const source = process.env.PEOPLE_LANGUAGE_SOURCE || path.join(__dirname, '../src/db/people.ts');
const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
const mocks = { './client': {}, 'luxon': require('luxon'), '../utils/logger': {}, './socialSubjects': {}, './engagementRank': {}, '../memory/resolveAttendeeEmails': {} };
vm.runInNewContext('(function(require,module,exports){' + compiled + '\n})', { Date, Set, Map })(id => { assert.ok(Object.hasOwn(mocks,id),id); return mocks[id]; }, mod, mod.exports);
const resolve = mod.exports.resolveOutboundLanguageForPerson;
const person = preference => ({ profile_json: JSON.stringify({ language_preference: preference }) });
for (const [name, tag, expected] of [['German','de-DE','de'],['Spanish','es-ES','es'],['Arabic','ar-SA','ar'],['Russian','ru-RU','ru'],['English','en-US','en'],['Hebrew','he-IL','he']]) {
  test(`stored ${name} and ${tag} resolve to ${expected}`, () => { assert.equal(resolve(person(name)),expected); assert.equal(resolve(person(tag)),expected); });
}
test('control unknown remains null; unrecognized known preference survives',()=>{ assert.equal(resolve(null),null);assert.equal(resolve(person('')),null);assert.equal(resolve(person('French')),'french'); });
test('control explicit preference outranks recent inbound and stale inbound stays unknown',()=>{const recent=new Date().toISOString().slice(0,19).replace('T',' ');assert.equal(resolve({...person('Hebrew'),last_inbound_lang:'en',last_inbound_lang_at:recent}),'he');assert.equal(resolve({...person(''),last_inbound_lang:'ar',last_inbound_lang_at:recent}),'ar');assert.equal(resolve({...person(''),last_inbound_lang:'en',last_inbound_lang_at:'2000-01-01 00:00:00'}),null);});
