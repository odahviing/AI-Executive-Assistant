const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const source = process.env.IN_FLIGHT_BEFORE || path.resolve(__dirname, '../src/core/requests/maybeOpenInFlightMeetingRequest.ts');
const code = ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const eventId = 'AAMkAD' + 'a'.repeat(142);
function harness(existing = []) {
  const rows = [...existing], warnings = [], exports = {};
  const deps = {
    '../../utils/logger': { info() {}, warn: (...args) => warnings.push(args) },
    '../../db/requests': { createRequest: row => rows.push(row), buildIdempotencyKey: fields => JSON.stringify(fields), getRequestByIdempotencyKey: key => rows.find(row => row.idempotencyKey === key) },
  };
  vm.runInNewContext(code, { exports, Date, Set, require: name => { assert.ok(Object.hasOwn(deps, name), name); return deps[name]; } });
  const call = (overrides = {}) => exports.maybeOpenInFlightMeetingRequest({ ownerUserId: 'OWNER', initiatorSlackId: 'OWNER', initiatorRole: 'owner', threadTs: 'thread.1', channel: 'DOWNER', toolName: 'move_meeting', toolInput: { meeting_id: eventId, meeting_subject: 'Isaac planning' }, toolResult: { success: false, reason: 'not_organizer' }, ...overrides });
  return { rows, call, warnings };
}
for (const [id, result] of [['options', { slots: [{ start: '2026-11-08T10:00:00Z' }] }], ['empty', { slots: [] }], ['unknown', null]]) {
  test(`search-${id}: moving identities are search context, not committed work`, () => {
    const h = harness(); h.call({ toolName: 'find_available_slots', toolInput: { moving_event_ids: [eventId, eventId + 'b'] }, toolResult: result }); assert.equal(h.rows.length, 0);
  });
}
test('pure-search: ordinary exploration stays untracked', () => { const h = harness(); h.call({ toolName: 'find_available_slots', toolInput: {} }); assert.equal(h.rows.length, 0); });
test('failed-move: attempted mutation preserves identity label and bounded expiry', () => {
  const h = harness(); const now = Date.now(); h.call(); const row = h.rows[0]; assert.equal(h.rows.length, 1); assert.equal(row.state, 'in_flight'); assert.equal(row.subject, 'In flight: moving Isaac planning'); assert.equal(row.outcomeExternalEventId, eventId); assert.equal(row.details.meeting_id, eventId); assert.equal(row.nextCheckHandler, 'expiry'); assert.equal(row.nextCheckAt, row.expiresAt); assert.ok(Date.parse(row.expiresAt) >= now + 86400000); assert.equal(row.originChannel, 'DOWNER');
});
test('unknown-mutation: missing result remains tracked', () => { const h = harness(); h.call({ toolResult: null }); assert.equal(h.rows.length, 1); });
test('create-delete: incomplete committed operations remain tracked', () => { for (const toolName of ['create_meeting', 'delete_meeting']) { const h = harness(); h.call({ toolName }); assert.equal(h.rows.length, 1); } });
test('confirmed-mutation: success does not reopen completed work', () => { for (const toolName of ['create_meeting', 'move_meeting', 'delete_meeting']) { const h = harness(); h.call({ toolName, toolResult: { success: true } }); assert.equal(h.rows.length, 0); } const h = harness(); h.call({ toolName: 'delete_meeting', toolResult: { deleted: true } }); assert.equal(h.rows.length, 0); });
test('owner-pauses: explicit structured decisions stay in conversation', () => { for (const toolResult of [{ needs_confirmation: true }, { needs_owner_approval: true }, { suggested_ask_text: 'Choose' }, { _deferred_action_hint: {} }]) { const h = harness(); h.call({ toolResult }); assert.equal(h.rows.length, 0); } });
test('errors-and-placeholder: existing rejection protects against orphans', () => { const h = harness(); h.call({ toolResult: { error: 'Invalid Graph ID' } }); h.call({ toolInput: { meeting_id: 'placeholder' } }); assert.equal(h.rows.length, 0); });
test('colleague-room: existing role boundary remains closed', () => { const h = harness(); h.call({ initiatorRole: 'colleague', channel: 'CROOM' }); assert.equal(h.rows.length, 0); });
test('retry-restart-terminal: durable key prevents duplicates and resurrection', () => {
  const h = harness(); h.call(); h.call(); assert.equal(h.rows.length, 1);
  for (const state of ['in_flight', 'resolved', 'cancelled', 'expired']) { const next = harness([{ ...h.rows[0], state }]); next.call(); assert.equal(next.rows.length, 1); assert.equal(next.rows[0].state, state); }
});
test('search-does-not-disturb-existing-commitment', () => { const h = harness(); h.call(); h.call({ toolName: 'find_available_slots', toolInput: { moving_event_ids: [eventId] }, toolResult: { slots: [] } }); assert.equal(h.rows.length, 1); assert.equal(h.rows[0].details.triggering_tool, 'move_meeting'); });
