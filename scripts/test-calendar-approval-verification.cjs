// Isolated real Graph read module; never opens a DB, network, or mutation API.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'artifacts/workshop-verification/approval-audit-20260911');
const before = process.argv.includes('--before');
const source = before ? path.join(dir, 'calendar-verification-before/calendarReads.ts') : path.join(root, 'src/connectors/graph/calendarReads.ts');
const profile = { user: { email: 'owner@example.com', timezone: 'Asia/Jerusalem' }, meetings: { floating_blocks: [{ name: 'lunch', default_subject: 'Lunch', preferred_start: '12:00', preferred_end: '14:00', duration_minutes: 30 }] } };
const base = { id: 'exact/id+=', subject: 'Approved', start: { dateTime: '2026-09-11T09:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-11T09:30:00', timeZone: 'UTC' }, isCancelled: false, isAllDay: false, attendees: [], location: { displayName: 'Office' }, isOnlineMeeting: false, categories: ['Meeting'] };
const args = { meeting_id: base.id, new_start: '2026-09-11T12:00:00+03:00', new_end: '2026-09-11T12:30:00+03:00' };
const results = [];
function harness(event = base, error) {
  const calls = [];
  const client = { api(url) { calls.push(['GET', url]); return { header() { return this; }, select() { return this; }, async get() { if (error) throw error; return event; } }; } };
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const m = { exports: {} }; cache.set(filename, m);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const req = spec => {
      if (spec === 'luxon') return require(spec);
      if (spec.endsWith('/logger')) return { __esModule: true, default: { info() {}, warn() {}, error() {} } };
      if (spec === './graphClient') return { getClient: () => client };
      if (spec.endsWith('/floatingBlocks')) return { getFloatingBlocks: p => p.meetings.floating_blocks };
      if (spec.endsWith('/timezoneConvert') || spec.endsWith('/weTimeResolver')) return load(path.join(root, 'src/utils', `${path.basename(spec)}.ts`));
      throw Error(`Forbidden dependency: ${spec}`);
    };
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(req, m, m.exports);
    return m.exports;
  }
  const mod = load(source);
  return { calls, async verify(input) {
    if (mod.verifyApprovedCalendarAction) return mod.verifyApprovedCalendarAction({ userEmail: profile.user.email, profile, tool: 'move_meeting', args, ...input });
    // Baseline exercises the existing exported post-write verifier for its
    // actual move/delete domain. New operation comparisons have no predecessor.
    const i = { tool: 'move_meeting', args, ...input };
    if (i.tool === 'delete_meeting') return { status: await mod.verifyEventDeleted(profile.user.email, i.args.meeting_id) ? 'desired_state_observed' : 'different_state_observed' };
    if (i.tool !== 'move_meeting') throw Error('Approved action verifier absent before repair');
    const r = await mod.verifyEventMoved(profile.user.email, i.args.meeting_id, i.args.new_start, profile.user.timezone);
    return { status: r.ok ? 'desired_state_observed' : 'different_state_observed' };
  } };
}
async function test(id, expected, input = {}, event = base, error, verify) {
  try {
    const h = harness(event, error), r = await h.verify(input);
    assert.equal(r.status, expected);
    if (!before) { assert.ok(h.calls.length <= 1); assert.ok(h.calls.every(c => c[0] === 'GET')); }
    if (verify) verify(r, h);
    results.push({ id, status: 'pass' });
  } catch (e) { results.push({ id, status: 'fail', error: e.message }); }
}
(async () => {
  await test('move-equivalent-offset-instant', 'desired_state_observed');
  await test('move-distinct-instant', 'different_state_observed', {}, { ...base, start: { dateTime: '2026-09-11T08:00:00', timeZone: 'UTC' } });
  await test('move-30-second-drift', 'different_state_observed', {}, { ...base, start: { dateTime: '2026-09-11T09:00:30', timeZone: 'UTC' } });
  await test('move-end-mismatch', 'different_state_observed', {}, { ...base, end: { dateTime: '2026-09-11T10:00:00', timeZone: 'UTC' } });
  await test('move-invalid-date', 'unavailable', {}, { ...base, start: { dateTime: 'broken', timeZone: 'UTC' } });
  for (const code of [401, 403, 429, 500]) await test(`read-error-${code}`, 'unavailable', {}, base, { statusCode: code });
  await test('move-404', 'different_state_observed', {}, base, { statusCode: 404 });
  await test('delete-404', 'desired_state_observed', { tool: 'delete_meeting' }, base, { statusCode: 404 });
  await test('delete-present', 'different_state_observed', { tool: 'delete_meeting' });
  await test('delete-malformed-id', 'unavailable', { tool: 'delete_meeting' }, base, { code: 'ErrorInvalidIdMalformed', statusCode: 400 });
  await test('delete-auth-overrides-service-code', 'unavailable', { tool: 'delete_meeting' }, base, { code: 'ErrorItemNotFound', statusCode: 403 });
  await test('cancelled-event', 'different_state_observed', {}, { ...base, isCancelled: true });
  await test('missing-event-id', 'unavailable', { args: { ...args, meeting_id: undefined } });
  await test('conflicting-event-id', 'unavailable', { eventId: 'other' });
  await test('mismatched-response-id', 'unavailable', {}, { ...base, id: 'other' });
  await test('missing-approved-end', 'unavailable', { args: { ...args, new_end: undefined } });
  await test('bare-unfixed-timezone', 'unavailable', { args: { ...args, new_start: '2026-09-11T12:00:00' } });
  await test('explicit-home-timezone', 'desired_state_observed', { args: { ...args, new_start: '2026-09-11T12:00:00', stated_zone: 'home' } });
  await test('unrelated-tool', 'unavailable', { tool: 'send_email' });
  await test('wrong-mailbox', 'unavailable', { userEmail: 'other@example.com' });
  await test('missing-cancellation-state', 'unavailable', {}, { ...base, isCancelled: undefined });
  await test('invalid-approved-zone', 'unavailable', { args: { ...args, stated_zone: 'invalid-zone' } });
  await test('update-location-match', 'desired_state_observed', { tool: 'update_meeting', args: { meeting_id: base.id, location: 'Office' } });
  await test('update-location-mismatch', 'different_state_observed', { tool: 'update_meeting', args: { meeting_id: base.id, location: 'Other' } });
  await test('update-empty-intent', 'unavailable', { tool: 'update_meeting', args: { meeting_id: base.id } });
  await test('update-name-only-attendee', 'unavailable', { tool: 'update_meeting', args: { meeting_id: base.id, add_attendees: [{ name: 'Someone' }] } });
  await test('update-add-remove', 'desired_state_observed', { tool: 'update_meeting', args: { meeting_id: base.id, add_attendees: [{ email: 'A@example.com' }], remove_attendees: ['b@example.com'] } }, { ...base, attendees: [{ emailAddress: { address: 'a@example.com' }, type: 'required' }] });
  await test('update-optional-mismatch', 'different_state_observed', { tool: 'update_meeting', args: { meeting_id: base.id, add_attendees: [{ email: 'a@example.com', optional: true }] } }, { ...base, attendees: [{ emailAddress: { address: 'a@example.com' }, type: 'required' }] });
  await test('update-remove-still-present', 'different_state_observed', { tool: 'update_meeting', args: { meeting_id: base.id, remove_attendees: ['a@example.com'] } }, { ...base, attendees: [{ emailAddress: { address: 'a@example.com' }, type: 'required' }] });
  for (const [field, accepted, rejected, event] of [
    ['new_subject', 'Approved', 'Other', base], ['category', 'Meeting', 'Other', base],
    ['is_online', false, true, base], ['body', '<p>approved</p>', '<p>other</p>', { ...base, body: { content: '<p>approved</p>' } }],
    ['sensitivity', 'private', 'normal', { ...base, sensitivity: 'private' }],
    ['is_all_day', false, true, base],
  ]) {
    await test(`field-${field}-match`, 'desired_state_observed', { tool: 'update_meeting', args: { meeting_id: base.id, [field]: accepted } }, event);
    await test(`field-${field}-mismatch`, 'different_state_observed', { tool: 'update_meeting', args: { meeting_id: base.id, [field]: rejected } }, event);
  }
  const create = { tool: 'create_meeting', eventId: base.id, args: { subject: base.subject, start: args.new_start, end: args.new_end, attendees: [] } };
  await test('create-exact-match', 'desired_state_observed', create);
  await test('create-subject-mismatch', 'different_state_observed', create, { ...base, subject: 'Unapproved' });
  await test('create-extra-attendee', 'different_state_observed', create, { ...base, attendees: [{ emailAddress: { address: 'extra@example.com' }, type: 'required' }] });
  await test('create-no-id-no-search', 'unavailable', { ...create, eventId: undefined });
  const floating = { tool: 'book_floating_block', eventId: base.id, args: { block_name: 'lunch', date: '2026-09-11' } };
  await test('floating-inside-window', 'desired_state_observed', floating, { ...base, subject: 'Lunch' });
  await test('floating-outside-window', 'different_state_observed', floating, { ...base, subject: 'Lunch', start: { dateTime: '2026-09-11T11:45:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-11T12:15:00', timeZone: 'UTC' } });
  await test('floating-explicit-time', 'desired_state_observed', { ...floating, args: { ...floating.args, start_time: '12:00' } }, { ...base, subject: 'Lunch' });
  await test('floating-explicit-time-mismatch', 'different_state_observed', { ...floating, args: { ...floating.args, start_time: '12:15' } }, { ...base, subject: 'Lunch' });
  await test('floating-wrong-duration', 'different_state_observed', floating, { ...base, subject: 'Lunch', end: { dateTime: '2026-09-11T09:45:00', timeZone: 'UTC' } });
  await test('floating-unknown-block', 'unavailable', { ...floating, args: { ...floating.args, block_name: 'unknown' } });
  await test('observation-not-provenance-and-no-disclosure', 'desired_state_observed', {}, base, undefined, (r, h) => {
    assert.match(r.result.action_summary, /does not establish/);
    assert.equal(r.result._calendar_verification, 'desired_state_observed');
    assert.equal(r.result.subject, undefined); assert.equal(r.result.body, undefined);
    assert.equal(h.calls[0][1], '/users/owner%40example.com/events/exact%2Fid%2B%3D');
  });
  const output = { before, source, passed: results.filter(r => r.status === 'pass').length, failed: results.filter(r => r.status === 'fail').length, results };
  fs.writeFileSync(path.join(dir, `calendar-verification-${before ? 'before' : 'after'}.json`), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = output.failed ? 1 : 0;
})();
