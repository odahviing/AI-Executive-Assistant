// Isolated actual health handlers. No network, production DB, LLM, or messages.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { DateTime, Settings } = require('luxon');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'artifacts/workshop-verification/calendar-health-20260912/matchmaker');
const before = process.argv.includes('--before');
Settings.now = () => DateTime.fromISO('2026-09-13T06:00:00Z').toMillis();
// Avoid recursive Settings.now inside fromISO.
const now = Date.parse('2026-09-13T06:00:00Z'); Settings.now = () => now;
const results = [];
const event = (id, start = '2026-09-14T10:00:00', end = '2026-09-14T11:00:00', zone = 'Asia/Jerusalem') => ({ id, subject: id, start: { dateTime: start, timeZone: zone }, end: { dateTime: end, timeZone: zone }, showAs: 'busy', isAllDay: false, isCancelled: false, attendees: [{ emailAddress: { address: 'peer@company.test', name: 'Peer' } }], categories: ['Meeting'] });
function harness(opts = {}) {
  const rows = (opts.rows ?? []).map(r => ({ ...r }));
  const requestRows = (opts.requestRows ?? []).map(r => ({ ...r }));
  const calls = [];
  const profile = { user: { name: 'Owner', email: 'owner@company.test', slack_user_id: 'owner', timezone: 'Asia/Jerusalem' }, behavior: { calendar_health_mode: 'passive' }, meetings: { floating_blocks: opts.blocks ?? [], protected: [], private_emails: [] }, schedule: { office_days: { days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'] }, home_days: { days: [] } }, categories: [{ name: 'Meeting', description: 'Work' }] };
  const active = () => rows.filter(r => ['awaiting_owner', 'in_progress', 'owner_side'].includes(r.status));
  const db = {
    getActiveCalendarIssues: active, getSuppressedEventIds: () => new Set(),
    getWaivedFloatingBlockEventIds: () => { if (opts.waiverError) throw Error('waiver unavailable'); return new Set(); },
    dayLevelIssueSyntheticId: (type, date) => `${type}:${date}`,
    buildClusters: (issues, dates) => issues.map(i => ({ ...i, event_date: dates.get(i.event_id) })),
    upsertCluster: (owner, c) => { let row = rows.find(r => r.event_id === c.event_id); if (row) { calls.push(['upsert', row.id]); return { action: 'update', row_id: row.id }; } row = { ...c, id: `ci_${c.event_id}`, status: 'awaiting_owner', issue_class: c.class }; rows.push(row); return { action: 'insert', row_id: row.id }; },
    markStaleResolved: (owner, touched, start, end) => { for (const r of active()) if (!touched.has(r.id) && r.event_date >= start && r.event_date <= end) r.status = 'resolved'; },
    updateCalendarIssueStatus: (id, status) => { calls.push(['status', id, status]); const row = rows.find(r => r.id === id); if (!row) return false; row.status = status; return true; },
    getPersonByEmail: () => ({ slack_id: 'peer', name: 'Peer' }),
    getCalendarIssueById: id => rows.find(r => r.id === id),
    attachRequestToIssue: (id, request) => { if (opts.attachError) throw Error('attach failed'); rows.find(r => r.id === id).request_id = request; },
    auditLog: () => {},
    getDb: () => ({ transaction: fn => () => { const savedRows = structuredClone(rows), savedRequests = structuredClone(requestRows); try { return fn(); } catch (e) { rows.splice(0, rows.length, ...savedRows); requestRows.splice(0, requestRows.length, ...savedRequests); throw e; } } }),
  };
  const requests = {
    getRecentlyAutoMovedEventIds: () => new Set(calls.filter(c => c[0] === 'close' && c[1].closureReason === 'auto_move_executed').map(() => 'movable')),
    getRequestsByExternalEventId: () => opts.pendingMove ? [{ subkind: 'auto_move' }] : [],
    createRequest: p => { calls.push(['request', p]); if (opts.recordError) throw Error('record unavailable'); const r = { id: `req_${requestRows.length}`, owner_user_id: p.ownerUserId, kind: p.kind, subkind: p.subkind, state: p.state, outcome_external_event_id: p.outcomeExternalEventId, details_json: JSON.stringify(p.details ?? {}), next_check_at: p.nextCheckAt, next_check_handler: p.nextCheckHandler, expires_at: p.expiresAt, idempotency_key: p.idempotencyKey, created_at: '2026-09-13 06:00:00' }; requestRows.push(r); return r; },
    getRequest: id => requestRows.find(r => r.id === id),
    getRequestByIdempotencyKey: key => requestRows.find(r => r.idempotency_key === key),
    updateRequest: (id, p) => Object.assign(requestRows.find(r => r.id === id), { next_check_at: p.nextCheckAt, next_check_handler: p.nextCheckHandler, expires_at: p.expiresAt }),
  };
  const cal = {
    getOwnerEventsForDecision: async () => { if (opts.readError) throw Error('calendar unreadable'); return opts.events ?? []; },
    getCalendarEvents: async (...args) => { calls.push(['read', ...args]); if (opts.readError) throw Error('calendar unreadable'); return opts.events ?? []; },
    updateMeeting: async p => { calls.push(['write', p]); if (opts.writeError) throw Error('write failed'); },
    verifyEventMoved: async () => opts.verify ?? { ok: true },
    verifyApprovedCalendarAction: async p => { calls.push(['verify', p]); return opts.strictVerify ?? { status: 'desired_state_observed' }; },
    findAvailableSlots: async p => { calls.push(['slots', p]); return opts.slots ?? []; },
  };
  const fb = { densityCommitments: () => [], getFloatingBlocks: p => p.meetings.floating_blocks, blockAppliesOnDay: () => true, isFloatingBlockEvent: (e, b) => e.subject === b.name, floatingBlockSyntheticEventId: (p, name, date) => ({ eventId: `${name}:${date}`, eventEndMs: Date.parse(`${date}T20:00Z`) }), windowMsForDay: (date, time, zone) => DateTime.fromISO(`${date}T${time}`, { zone }).toMillis() };
  const work = { computeHealthCheckWindow: () => ({ startDate: '2026-09-14', endDate: '2026-09-14' }), getEffectiveWorkDay: () => ({ windows: [{ startMin: 540, endMin: 1080 }], hasOverride: false }), formatMinuteOfDay: n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`, totalWorkMinutes: w => w.reduce((n, x) => n + x.endMin - x.startMin, 0) };
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const file = ['meetingProtection', 'attendeeScope'].includes(name) ? path.join(root, 'src/utils', `${name}.ts`) : before ? path.join(dir, 'before', `${name}.ts`) : path.join(root, 'src/skills/calendarHealth', ['checkHealth', 'categoryOps'].includes(name) ? 'handlers' : '', `${name}.ts`);
    const m = { exports: {} }; modules.set(name, m.exports);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const req = spec => {
      if (spec === 'luxon') return require(spec);
      if (spec.endsWith('/classify')) return load('classify');
      if (spec.endsWith('/autoMove')) return load('autoMove');
      if (spec.endsWith('/graph/calendar')) return cal;
      if (spec.endsWith('/logger')) return { __esModule: true, default: { info() {}, warn() {}, error() {} } };
      if (spec.endsWith('/db') || spec.endsWith('/db/calendarIssues')) return db;
      if (spec.endsWith('/db/requests')) return requests;
      if (spec.endsWith('/displaySubject')) return { displaySubject: e => e.subject };
      if (spec.endsWith('/workHours')) return work;
      if (spec.endsWith('/floatingBlocks')) return fb;
      if (spec.endsWith('/calendarDensity')) return { prefersDensePacking: () => !!opts.dense, densityConfigFromProfile: () => ({}), classifyGap: n => n > 5 && n < 30 ? 'dead' : 'break', scoreSlotDensity: () => ({ createsDeadGap: false }) };
      if (spec.endsWith('/meetingProtection')) return load('meetingProtection');
      if (spec === './attendeeScope') return load('attendeeScope');
      if (spec.endsWith('/db/jobs')) return { getOpenRescheduleOutreach: () => [] };
      if (spec.endsWith('/attendeeAvailability')) return { attendeeCheckParams: emails => ({ attendeeEmails: emails }) };
      if (spec.endsWith('/scheduleRules')) return { requiredFreeMinutesForWorkDay: () => 0 };
      if (spec.endsWith('/categoryRules')) return { findCategoryViolations: () => [] };
      if (spec.endsWith('/llm/client')) return { getAnthropicClient: () => { throw Error('Live LLM forbidden'); } };
      if (spec.endsWith('/llm/models')) return { SONNET: {} };
      if (spec.endsWith('/rebalanceFloatingBlocks')) return { rebalanceFloatingBlocksAfterMutation: async () => { calls.push(['rebalance']); return opts.rebalanceResult ?? ({ moved: 0, movedBlockEventIds: [] }); } };
      if (spec.endsWith('/closeMeetingArtifacts')) return { closeMeetingArtifacts: async () => { if (opts.cascadeError) throw Error('cascade unavailable'); return { correctedColleagueSlackIds: [] }; } };
      if (spec.endsWith('/closeRequest')) return { closeRequest: p => { calls.push(['close', p]); const r = requestRows.find(r => r.id === p.id); if (r) Object.assign(r, { state: p.state, next_check_at: null, next_check_handler: null }); return { ok: true }; } };
      if (spec.endsWith('/meetingReschedule')) return { notifyColleagueOfMove: async () => { calls.push(['notice']); if (opts.noticeError) throw Error('notice failed'); return !opts.noticeFalse; } };
      if (spec.endsWith('/shadowNotify')) return { shadowNotify: async () => {} };
      throw Error(`Forbidden/unmocked dependency: ${spec}`);
    };
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(req, m, m.exports);
    modules.set(name, m.exports); return m.exports;
  }
  const context = { profile, channelId: 'owner-dm', userId: 'owner', isOwner: true };
  return { load, rows, requestRows, calls, profile, manage: args => load('categoryOps').handleManageCalendarIssue(args, { context, profile, userEmail: profile.user.email, timezone: profile.user.timezone }), scan: args => load('checkHealth').handleCheckHealth(args ?? {}, { context, profile, userEmail: profile.user.email, timezone: profile.user.timezone, self: { executeToolCall: async (tool, args) => { calls.push(['book', args]); return { ok: true, created: true, start: '12:00', end: '12:30' }; } } }), async move() { const movable = event('movable'); const issue = { type: 'double_booking', date: '2026-09-14', description: 'clash' }; const internalActions = []; let error; try { await load('autoMove').executeInternalAutoMove({ movable, origStart: DateTime.fromISO('2026-09-14T10:00+03:00'), origEnd: DateTime.fromISO('2026-09-14T11:00+03:00'), durationMin: 60, newStartIso: '2026-09-14T12:00:00+03:00', participantsRaw: movable.attendees, conflictReason: 'clash', moveVerb: 'to clear clash', issue, userEmail: profile.user.email, ownerUserId: 'owner', timezone: profile.user.timezone, profile, context, internalActions }); } catch (e) { error = e; } return { issue, internalActions, error }; } };
}
async function test(id, fn) { try { await fn(); results.push({ id, status: 'pass' }); } catch (e) { results.push({ id, status: 'fail', error: e.message }); } }
(async () => {
  await test('two-missing-blocks-remain-distinct', async () => { const h = harness({ blocks: ['lunch', 'coffee'].map(name => ({ name, preferred_start: '12:00', preferred_end: '14:00', duration_minutes: 30 })) }); const r = await h.scan(); assert.equal(r.issues.length, 2); });
  await test('new-tracked-issue-id-returned-same-scan', async () => { const h = harness({ events: [{ ...event('uncategorized'), categories: [] }] }); const r = await h.scan(); assert.equal(r.activeTrackedIssues?.[0]?.id, 'ci_uncategorized'); });
  await test('stale-resolved-issue-not-returned', async () => { const h = harness({ rows: [{ id: 'old', event_id: 'gone', event_date: '2026-09-14', issue_class: 'missing_category', status: 'awaiting_owner' }] }); const r = await h.scan(); assert.equal(r.activeTrackedIssues?.length ?? 0, 0); });
  await test('unchanged-category-control', async () => { const h = harness({ events: [{ ...event('uncategorized'), categories: [] }], rows: [{ id: 'existing', event_id: 'uncategorized', event_date: '2026-09-14', issue_class: 'missing_category', status: 'awaiting_owner' }] }); const r = await h.scan(); assert.equal(r.issues[0].type, 'missing_category'); assert.equal(r.activeTrackedIssues[0].id, 'existing'); });
  await test('utc-instant-renders-owner-date', () => { const h = harness(); const d = h.load('classify').parseGraphDt('2026-09-13T22:30:00', 'UTC', 'Asia/Jerusalem'); assert.equal(d.toFormat('yyyy-MM-dd HH:mm'), '2026-09-14 01:30'); assert.equal(d.toMillis(), Date.parse('2026-09-13T22:30Z')); });
  await test('explicit-offset-preserves-instant', () => { const d = harness().load('classify').parseGraphDt('2026-09-14T10:00:00+03:00', 'UTC', 'Asia/Jerusalem'); assert.equal(d.toMillis(), Date.parse('2026-09-14T07:00Z')); });
  const row = { id: 'overlap', event_id: 'a', peer_event_id: 'b', event_date: '2026-09-14', issue_class: 'overlap', status: 'awaiting_owner' };
  await test('overlap-revalidation-live-read', async () => { const h = harness({ events: [event('a'), event('b')], rows: [row] }); assert.equal((await h.load('autoMove').revalidateActiveOverlapIssues(h.rows, 'owner', 'Asia/Jerusalem')).length, 1); assert.equal(h.calls.find(c => c[0] === 'read')[5], 'live'); });
  await test('invalid-overlap-time-keeps-issue', async () => { const h = harness({ events: [event('a', 'broken'), event('b')], rows: [row] }); assert.equal((await h.load('autoMove').revalidateActiveOverlapIssues(h.rows, 'owner', 'Asia/Jerusalem')).length, 1); assert.equal(h.calls.filter(c => c[0] === 'status').length, 0); });
  await test('separated-overlap-resolves-control', async () => { const h = harness({ events: [event('a'), event('b', '2026-09-14T12:00', '2026-09-14T13:00')], rows: [row] }); assert.equal((await h.load('autoMove').revalidateActiveOverlapIssues(h.rows, 'owner', 'Asia/Jerusalem')).length, 0); });
  await test('unreadable-overlap-keeps-control', async () => { const h = harness({ readError: true, rows: [row] }); assert.equal((await h.load('autoMove').revalidateActiveOverlapIssues(h.rows, 'owner', 'Asia/Jerusalem')).length, 1); });
  await test('waiver-read-failure-blocks-autobook', async () => { const h = harness({ waiverError: true, blocks: [{ name: 'lunch', preferred_start: '12:00', preferred_end: '14:00', duration_minutes: 30 }] }); await assert.rejects(h.scan({ mode: 'active' }), /waiver/); assert.equal(h.calls.filter(c => c[0] === 'book').length, 0); });
  await test('record-failure-prevents-move', async () => { const h = harness({ recordError: true }); await h.move(); assert.equal(h.calls.filter(c => c[0] === 'write').length, 0); });
  await test('notice-failure-retains-confirmed-move', async () => { const h = harness({ noticeError: true }); const r = await h.move(); assert.equal(r.issue.fixed, true); assert.equal(r.internalActions.length, 1); assert.ok(h.calls.some(c => c[0] === 'close' && c[1].closureReason === 'auto_move_executed')); assert.match(r.issue.fix_detail, /not.*notif|couldn.t.*notif/i); });
  await test('false-notice-result-never-claims-delivery', async () => { const h = harness({ noticeFalse: true }); const r = await h.move(); assert.equal(r.issue.fixed, true); assert.match(r.issue.fix_detail, /couldn.t confirm the notification/); assert.doesNotMatch(r.issue.fix_detail, /let Peer know/); });
  await test('cascade-failure-retains-confirmed-move', async () => { const h = harness({ cascadeError: true }); const r = await h.move(); assert.equal(r.issue.fixed, true); assert.ok(h.calls.some(c => c[0] === 'close' && c[1].closureReason === 'auto_move_executed')); });
  await test('pending-move-prevents-repeat', async () => { const h = harness({ pendingMove: true }); await h.move(); assert.equal(h.calls.filter(c => c[0] === 'write').length, 0); });
  await test('unavailable-readback-never-claims-success', async () => { const h = harness({ strictVerify: { status: 'unavailable', reason: 'read_failed' } }); const r = await h.move(); assert.notEqual(r.issue.fixed, true); assert.equal(h.calls.filter(c => c[0] === 'notice').length, 0); assert.equal(h.calls.filter(c => c[0] === 'close').length, 0); });
  await test('transport-throw-after-applied-recovers-with-safe-readback', async () => { const h = harness({ writeError: true }); const r = await h.move(); assert.equal(r.issue.fixed, true); assert.equal(h.calls.filter(c => c[0] === 'write').length, 1); assert.equal(h.calls.filter(c => c[0] === 'verify').length, 1); });
  await test('end-mismatch-never-claims-success', async () => { const h = harness({ strictVerify: { status: 'different_state_observed', reason: 'end_mismatch' } }); const r = await h.move(); assert.notEqual(r.issue.fixed, true); assert.equal(h.calls.filter(c => c[0] === 'notice').length, 0); });
  await test('successful-move-control', async () => { const h = harness(); const r = await h.move(); assert.equal(r.issue.fixed, true); assert.equal(h.calls.filter(c => c[0] === 'write').length, 1); assert.equal(h.calls.filter(c => c[0] === 'notice').length, 1); });
  const slot = { start: '2026-09-14T12:00:00+03:00', end: '2026-09-14T13:00:00+03:00' };
  await test('integrated-overlap-detect-move-notify-control', async () => { const h = harness({ events: [event('kept'), event('movable')], slots: [slot] }); const r = await h.scan({ mode: 'active' }); assert.equal(r.fixes_applied, 1); assert.equal(r.issues[0].fixed, true); assert.equal(h.calls.filter(c => c[0] === 'write').length, 1); assert.equal(h.calls.filter(c => c[0] === 'notice').length, 1); assert.ok(h.calls.find(c => c[0] === 'slots')[1].attendeeEmails.includes('peer@company.test')); });
  await test('integrated-protected-external-never-moves-control', async () => { const external = id => ({ ...event(id), attendees: [{ emailAddress: { address: 'outside@external.test' } }] }); const h = harness({ events: [external('a'), external('b')], slots: [slot] }); const r = await h.scan({ mode: 'active' }); assert.ok(r.issues.some(i => i.type === 'double_booking')); assert.equal(h.calls.filter(c => c[0] === 'write').length, 0); });
  await test('integrated-no-attendee-free-slot-never-moves-control', async () => { const h = harness({ events: [event('kept'), event('movable')] }); const r = await h.scan({ mode: 'active' }); assert.equal(h.calls.filter(c => c[0] === 'write').length, 0); assert.equal(r.issues[0].fix_failed, true); });
  await test('same-sweep-repeat-move-is-suppressed', async () => { const h = harness(); await h.move(); await h.move(); assert.equal(h.calls.filter(c => c[0] === 'write').length, 1); });
  await test('rebalance-only-summary-reports-action', async () => { const h = harness({ rebalanceResult: { moved: 1, movedBlockEventIds: ['block'] } }); const r = await h.scan({ mode: 'active' }); assert.match(r.summary_text, /Rebalanced 1/); assert.doesNotMatch(r.summary_text, /healthy/); });
  await test('uncertain-defrag-stays-visible-and-never-mirrors-write', async () => { const h = harness({ dense: true, events: [event('kept'), event('movable', '2026-09-14T11:15:00', '2026-09-14T12:15:00')], slots: [{ start: '2026-09-14T11:00:00+03:00', end: '2026-09-14T12:00:00+03:00' }], strictVerify: { status: 'unavailable', reason: 'read_failed' } }); const r = await h.scan({ mode: 'active' }); assert.equal(h.calls.filter(c => c[0] === 'write').length, 1); assert.equal(h.calls.filter(c => c[0] === 'rebalance').length, 0); assert.equal(r.issues[0].fix_unconfirmed, true); assert.match(r.summary_text, /couldn't verify/); });
  await test('two-active-block-fixes-control', async () => { const h = harness({ blocks: ['lunch', 'coffee'].map(name => ({ name, preferred_start: '12:00', preferred_end: '14:00', duration_minutes: 30 })) }); const r = await h.scan({ mode: 'active' }); assert.equal(r.fixes_applied, 2); assert.equal(h.calls.filter(c => c[0] === 'book').length, 2); });
  await test('read-failure-no-health-verdict-control', async () => { const h = harness({ readError: true }); await assert.rejects(h.scan(), /unreadable/); assert.equal(h.calls.filter(c => c[0] === 'write').length, 0); });
  const issue = { id: 'owned', owner_user_id: 'owner', event_id: 'meeting', event_date: '2026-09-14', issue_class: 'overlap', status: 'awaiting_owner' };
  await test('missing-issue-no-orphan', async () => { const h = harness(); const r = await h.manage({ action: 'start_resolve', issue_id: 'missing' }); assert.equal(r.error, 'not_found'); assert.equal(h.requestRows.length, 0); });
  await test('foreign-issue-no-write', async () => { const h = harness({ rows: [{ ...issue, owner_user_id: 'other' }] }); const r = await h.manage({ action: 'approve', issue_id: 'owned' }); assert.equal(r.error, 'not_found'); assert.equal(h.rows[0].status, 'awaiting_owner'); });
  await test('start-resolve-repeat-reuses-timed-request', async () => { const h = harness({ rows: [issue] }); const a = await h.manage({ action: 'start_resolve', issue_id: 'owned', notes: 'first' }); const b = await h.manage({ action: 'start_resolve', issue_id: 'owned', notes: 'changed' }); assert.equal(a.request_id, b.request_id); assert.equal(h.requestRows.length, 1); assert.equal(h.requestRows[0].next_check_at, '2026-09-14T06:00:00.000Z'); assert.equal(h.requestRows[0].next_check_handler, 'expiry'); });
  await test('failed-request-preserves-issue', async () => { const h = harness({ rows: [issue], recordError: true }); const r = await h.manage({ action: 'start_resolve', issue_id: 'owned' }); assert.equal(r.error, 'transition_failed'); assert.equal(h.rows[0].status, 'awaiting_owner'); });
  await test('failed-attach-rolls-back-request', async () => { const h = harness({ rows: [issue], attachError: true }); const r = await h.manage({ action: 'start_resolve', issue_id: 'owned' }); assert.equal(r.error, 'transition_failed'); assert.equal(h.requestRows.length, 0); assert.equal(h.rows[0].status, 'awaiting_owner'); });
  const tracker = { id: 'legacy', owner_user_id: 'owner', kind: 'follow_up', subkind: 'calendar_fix', state: 'in_flight', outcome_external_event_id: 'meeting', details_json: JSON.stringify({ calendar_issue_id: 'owned' }), created_at: '2026-09-12 06:00:00' };
  await test('same-event-other-issue-tracker-cannot-close', async () => { const h = harness({ rows: [{ ...issue, request_id: 'legacy' }], requestRows: [{ ...tracker, details_json: JSON.stringify({ calendar_issue_id: 'different' }) }] }); const r = await h.manage({ action: 'owner_done', issue_id: 'owned' }); assert.equal(r.error, 'transition_failed'); assert.equal(h.requestRows[0].state, 'in_flight'); assert.equal(h.rows[0].status, 'awaiting_owner'); });
  await test('legacy-timer-repaired-without-extension', async () => { const h = harness({ rows: [{ ...issue, request_id: 'legacy' }], requestRows: [tracker] }); const r = await h.manage({ action: 'start_resolve', issue_id: 'owned' }); assert.equal(r.request_id, 'legacy'); assert.equal(h.requestRows[0].next_check_at, '2026-09-13T06:00:00.000Z'); assert.equal(h.requestRows.length, 1); });
  await test('existing-timer-preserved', async () => { const t = { ...tracker, next_check_at: '2026-09-13T07:00:00.000Z', next_check_handler: 'expiry', expires_at: '2026-09-13T07:00:00.000Z' }; const h = harness({ rows: [{ ...issue, request_id: 'legacy' }], requestRows: [t] }); await h.manage({ action: 'start_resolve', issue_id: 'owned' }); assert.equal(h.requestRows[0].next_check_at, t.next_check_at); });
  for (const action of ['approve', 'owner_done', 'owner_will_resolve']) await test(`owner-${action}-closes-linked-work`, async () => { const h = harness({ rows: [{ ...issue, request_id: 'legacy' }], requestRows: [tracker] }); const r = await h.manage({ action, issue_id: 'owned' }); assert.equal(r.updated, true); assert.equal(h.requestRows[0].state, action === 'owner_done' ? 'resolved' : 'cancelled'); assert.equal(h.requestRows[0].next_check_at, null); });
  await test('terminal-issue-no-revival', async () => { const h = harness({ rows: [{ ...issue, status: 'approved' }] }); const r = await h.manage({ action: 'start_resolve', issue_id: 'owned' }); assert.equal(r.error, 'issue_closed'); assert.equal(h.requestRows.length, 0); });
  await test('legitimate-approve-control', async () => { const h = harness({ rows: [issue] }); const r = await h.manage({ action: 'approve', issue_id: 'owned' }); assert.equal(r.updated, true); assert.equal(h.rows[0].status, 'approved'); });
  const report = { snapshot: before ? 'preserved c3d042d source' : 'working tree', results, passed: results.filter(r => r.status === 'pass').length, failed: results.filter(r => r.status === 'fail').length };
  fs.writeFileSync(path.join(dir, before ? 'before-results.json' : 'after-results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.failed ? 1 : 0;
})();
