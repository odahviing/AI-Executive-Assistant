// Capture the real daily-brief composer prompt with isolated DB and model boundaries.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

let source = fs.readFileSync(path.join(__dirname, 'test-librarian-action-outcomes.cjs'), 'utf8');
source = source.slice(0, source.indexOf('function person('))
  + source.slice(source.indexOf('function brief('), source.indexOf('for (const [label, options]'));
source = source.replace(
  "const source = revision ?",
  "const source = relative === 'src/tasks/briefs.ts' && process.env.BRIEF_SOURCE_FIXTURE ? fs.readFileSync(process.env.BRIEF_SOURCE_FIXTURE, 'utf8') : revision ?",
);
source = source.replace(
  "const db = { prepare: () => ({ get: () => options.alreadySent ? { id: 1 } : undefined, all: () => [] }) };",
  "const db = { prepare: sql => ({ get: () => options.alreadySent ? { id: 1 } : undefined, all: () => /SELECT name, gender/.test(sql) ? (options.people || []) : [] }) };",
);
source = source.replace(
  "'src/core/requests/requesterRelay.ts': {}, 'src/db/people.ts': { getPersonByEmail: () => undefined },",
  "'src/core/requests/requesterRelay.ts': {}, 'src/db/people.ts': { getPersonByEmail: () => undefined, authoritativeGender: p => p.gender_confirmed || p.gender_set_by === 'person' || p.gender_set_by === 'owner' ? p.gender : 'unknown' },",
);
source = source.replace(
  "create: async () => { if(options.composeThrows)",
  "create: async input => { effects.logs.push(['compose', input]); if(options.composeThrows)",
);
source += '\nmodule.exports={brief};';

const fixture = { exports: {} };
vm.runInThisContext(`(function(require,module,exports,__dirname){${source}\n})`, { filename: __filename })(require, fixture, fixture.exports, __dirname);
const { brief } = fixture.exports;
const capturedSystem = harness => harness.effects.logs.find(entry => entry[0] === 'compose')?.[1]?.system || '';

test('DBR-P01: auto gender renders neutral pronoun input', async () => {
  const harness = brief({ people: [{ name: 'Alex Auto', gender: 'female', gender_set_by: 'auto', gender_confirmed: 0 }] });
  await harness.run();
  assert.match(capturedSystem(harness), /Alex Auto: they/);
  assert.doesNotMatch(capturedSystem(harness), /Alex Auto: she/);
});

for (const [id, row] of [
  ['DBR-P02: owner gender remains authoritative', { name: 'Olivia Owner', gender: 'female', gender_set_by: 'owner', gender_confirmed: 0 }],
  ['DBR-P03: person gender remains authoritative', { name: 'Peter Person', gender: 'male', gender_set_by: 'person', gender_confirmed: 0 }],
  ['DBR-P04: legacy confirmed gender remains authoritative', { name: 'Legacy Confirmed', gender: 'female', gender_set_by: null, gender_confirmed: 1 }],
]) test(id, async () => {
  const harness = brief({ people: [row] });
  await harness.run();
  const expected = row.gender === 'female' ? 'she' : 'he';
  assert.match(capturedSystem(harness), new RegExp(`${row.name}: ${expected}`));
});
