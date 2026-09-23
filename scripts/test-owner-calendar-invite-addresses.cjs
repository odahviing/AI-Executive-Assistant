/*
 * danny-replacement-invite-address-20260920 — the owner's own get_calendar
 * payload carries the invitation's addresses (organizer + attendee emails), so
 * a task anchored on an existing invite never asks him for an address the
 * event already holds. Every non-owner viewer gets exactly what it got before.
 *
 * Compiles the production src/skills/meetings/ops/analysis.ts; only its
 * logger / db / displaySubject / floatingBlocks boundaries are stubbed.
 *
 * node scripts/test-owner-calendar-invite-addresses.cjs [--source-root SNAPSHOT]
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const luxon = require('luxon');

const rootArg = process.argv.indexOf('--source-root');
const sourceRoot = rootArg < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[rootArg + 1]);
const file = path.join(sourceRoot, 'src/skills/meetings/ops/analysis.ts');

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const isPrivate = ev => ev.sensitivity === 'private' || ev.sensitivity === 'personal';
const stubs = {
  luxon,
  '../../../utils/logger': { default: logger, ...logger },
  '../../../utils/displaySubject': {
    displaySubject: (ev, _p, viewer) => (viewer === 'owner' || !isPrivate(ev)) ? ev.subject : '[Private]',
    isEventPrivate: ev => isPrivate(ev),
  },
  '../../../db': { searchPeopleMemory: () => [] },
  '../../../utils/floatingBlocks': {
    getFloatingBlocks: () => [], isFloatingBlockEvent: () => false, hasOtherHumanAttendee: () => false,
  },
};
const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const mod = { exports: {} };
vm.runInContext(out, vm.createContext({
  module: mod, exports: mod.exports, console,
  require: n => { if (n in stubs) return stubs[n]; throw Error(`FORBIDDEN module: ${n}`); },
}), { filename: 'analysis.ts' });
const { processCalendarEvents } = mod.exports;

const OWNER = 'idan@reflectiz.com';
const profile = { user: { name: 'Idan Cohen', email: OWNER }, categories: [], meetings: {} };
const person = (name, address) => ({ emailAddress: { name, address } });
const ev = (over) => ({
  id: 'evt', subject: 'עידן נס ציונה בוסטון', isAllDay: false, isCancelled: false, showAs: 'tentative',
  sensitivity: 'normal', isOnlineMeeting: false, categories: [],
  start: { dateTime: '2026-09-22T08:15:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-09-22T09:15:00.0000000', timeZone: 'UTC' },
  organizer: person('Danny Scheyer', 'dannys@globus-intr.co.il'),
  attendees: [person('Idan Cohen', OWNER), person('Danny Scheyer', 'dannys@globus-intr.co.il')],
  ...over,
});
const run = (events, viewer) => processCalendarEvents(events, OWNER, 'Idan Cohen', 'Asia/Jerusalem', profile, viewer);

let passed = 0, failed = 0;
function check(kind, name, fn) {
  try { fn(); passed++; console.log(`ok ${kind} ${name}`); }
  catch (e) { failed++; console.log(`not ok ${kind} ${name} — ${e.message}`); }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };

check('regression', 'owner-sees-external-organizer-address', () => {
  const [e] = run([ev({})], 'owner');
  eq(e.organizer, { name: 'Danny Scheyer', email: 'dannys@globus-intr.co.il' }, 'organizer');
});
check('regression', 'owner-sees-attendee-addresses-without-himself', () => {
  const [e] = run([ev({ attendees: [person('Idan Cohen', OWNER), person('Danny Scheyer', 'dannys@globus-intr.co.il'), person('Rita K', 'rita.k@reflectiz.com')] })], 'owner');
  eq(e.attendee_emails, ['dannys@globus-intr.co.il', 'rita.k@reflectiz.com'], 'attendee_emails');
});
check('regression', 'owner-private-event-still-carries-addresses', () => {
  const [e] = run([ev({ sensitivity: 'private' })], 'owner');
  eq(e.organizer?.email, 'dannys@globus-intr.co.il', 'organizer email');
});
check('regression', 'owner-attendee-addresses-capped-like-names', () => {
  const many = Array.from({ length: 12 }, (_, i) => person(`P${i}`, `p${i}@example.com`));
  const [e] = run([ev({ attendees: many })], 'owner');
  eq([e.attendees.length, e.attendee_emails.length], [10, 10], 'caps');
});
check('preserved', 'start-instant-unchanged', () => {
  const [e] = run([ev({})], 'owner');
  eq([e._localDate, e._localStartTime, e._localEndTime], ['2026-09-22', '11:15', '12:15'], 'local times');
});
check('preserved', 'owner-organized-event-has-no-organizer-field', () => {
  const [e] = run([ev({ organizer: person('Idan Cohen', OWNER) })], 'owner');
  eq(e.organizer, undefined, 'organizer');
});
check('preserved', 'non-owner-viewer-gets-no-addresses', () => {
  const [e] = run([ev({})], 'other');
  eq([e.organizer, e.attendee_emails], [undefined, undefined], 'addresses');
  eq(e.attendees, ['Danny Scheyer'], 'names unchanged');
});
check('preserved', 'default-viewer-gets-no-addresses', () => {
  const [e] = processCalendarEvents([ev({})], OWNER, 'Idan Cohen', 'Asia/Jerusalem', profile);
  eq([e.organizer, e.attendee_emails], [undefined, undefined], 'addresses');
});
check('preserved', 'non-owner-private-event-hides-names-and-addresses', () => {
  const [e] = run([ev({ sensitivity: 'private' })], 'other');
  eq([e.subject, e.attendees, e.organizer, e.attendee_emails], ['[Private]', undefined, undefined, undefined], 'masked');
});
check('preserved', 'owner-attendee-names-unchanged', () => {
  const [e] = run([ev({})], 'owner');
  eq(e.attendees, ['Danny Scheyer'], 'names');
});

console.log(`${passed} passed; ${failed} failed`);
process.exit(failed ? 1 : 0);
