// Brief composer: an unconfirmed-gender person is named, never a bare singular "them".
// Captures the real sendMorningBriefing system prompt through the isolated harness
// used by test-daily-brief-pronouns.cjs (no DB, no network, no model call).
// Before-repair replay: BRIEF_SOURCE_FIXTURE=<preserved briefs.ts> node scripts/test-brief-pronoun-naming.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
// The shared harness file registers node:test cases at load; this script only needs brief().
source = source.replace("const { test, afterEach } = require('node:test');", 'const test = () => {}, afterEach = () => {};');
source += '\nmodule.exports={brief,pending};';

const fixture = { exports: {} };
vm.runInThisContext(`(function(require,module,exports,__dirname){${source}\n})`, { filename: __filename })(require, fixture, fixture.exports, __dirname);
const { brief, pending } = fixture.exports;
const capturedSystem = h => h.effects.logs.find(e => e[0] === 'compose')?.[1]?.system || '';

const cases = [
  ['BPN-R01 regression: unconfirmed gender maps to "they" and the composer is told to repeat the name, not "them"', {
    people: [{ name: 'Einav Noy', gender: 'unknown', gender_set_by: null, gender_confirmed: 0 }],
  }, sys => /Einav Noy: they/.test(sys)
    && /maps to "they" or isn't in the map, repeat their name instead of any pronoun/.test(sys)],
  ['BPN-R02 regression: composer is told never to add a participant the item does not name', {
    people: [],
  }, sys => /never add a participant the data doesn't show/.test(sys)],
  ['BPN-P01 preserved: confirmed female stays "she" in the map', {
    people: [{ name: 'Dina Person', gender: 'female', gender_set_by: 'person', gender_confirmed: 1 }],
  }, sys => /Dina Person: she/.test(sys) && !/Dina Person: they/.test(sys)],
  ['BPN-P02 preserved: auto gender still renders neutral "they"', {
    people: [{ name: 'Alex Auto', gender: 'male', gender_set_by: 'auto', gender_confirmed: 0 }],
  }, sys => /Alex Auto: they/.test(sys) && !/Alex Auto: he\b/.test(sys)],
];

(async () => {
  let passed = 0; let failed = 0;
  for (const [name, options, check] of cases) {
    try {
      const h = brief(options);
      await h.run();
      const sys = capturedSystem(h);
      const blocked = pending.splice(0).flat();
      if (sys && check(sys) && blocked.length === 0) { passed++; console.log(`ok - ${name}`); }
      else { failed++; console.log(`not ok - ${name}`); }
    } catch (err) {
      failed++; console.log(`not ok - ${name} (${String(err).slice(0, 200)})`);
    }
  }
  console.log(`${passed} passed; ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
