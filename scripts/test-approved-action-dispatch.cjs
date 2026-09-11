// Isolated execution of the real approval dispatch modules. No network, DB or LLM.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const repairBefore = process.argv.includes('--repair-before');
const evidenceDir = path.join(root, 'artifacts/workshop-verification/approval-audit-20260911');
const baseline = path.join(evidenceDir, 'action-dispatch-before');
if (before) {
  for (const relative of ['src/skills/registry.ts', 'src/core/requests/deferredActionReplay.ts', 'src/core/requests/types.ts']) {
    const target = path.join(baseline, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, require('node:child_process').execFileSync('git', ['show', `3f2f17e:${relative}`], { cwd: root }));
  }
}
const profile = { user: { slack_user_id: 'UOWNER', email: 'owner@example.com' }, skills: {} };
const context = { profile, userId: 'UOWNER', authority: 'owner', senderRole: 'owner', surface: 'owner_dm', channel: 'slack', channelId: 'DOWNER', threadTs: '123.4' };
const compiled = new Map();
// Execute the real post-PATCH verification block, with only its Graph readback
// doubled. This checks the producer's actual sentinel branches without sending
// a mutation or recreating the return object in the test.
async function postMoveResult(reason) {
  const filename = path.join(root, 'src/skills/meetings/ops/handlers/moveMeeting.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  let block;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'verify'
      && node.initializer && ts.isAwaitExpression(node.initializer)
      && ts.isCallExpression(node.initializer.expression)
      && node.initializer.expression.expression.getText(ast) === 'verifyEventMoved') {
      block = node.parent.parent.parent;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(block && ts.isBlock(block), 'actual post-move readback branch located');
  const wrapped = `module.exports = async function(args,userEmail,effectiveStart,timezone,logger) ${block.getText(ast)}`;
  const code = ts.transpileModule(wrapped, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module){${code}\n})`, {}, { filename })(spec => {
    assert.equal(spec, '../../../../connectors/graph/calendar');
    return { verifyEventMoved: async () => ({ ok: false, reason, expected: '12:00', got: '10:00' }) };
  }, module);
  return module.exports({ meeting_id: 'event-one', meeting_subject: 'Private subject' }, 'owner@example.com', '2026-09-12T12:00:00Z', 'UTC', { warn() {} });
}
function harness(value, options = {}) {
  const calls = [], unexpected = [], verifications = [];
  const execute = async (tool, args, ctx) => {
    calls.push({ tool, args, ctx });
    if (options.cycle) throw Object.assign(new Error('cycle before work'), { code: 'request_lock_cycle' });
    if (options.throws) throw new Error('isolated tool failure');
    if (options.noExecutor) return null;
    return value;
  };
  class Core { constructor() { this.name = 'isolated core'; } executeToolCall(...args) { return options.route && options.route !== 'core' ? Promise.resolve(null) : execute(...args); } getTools() { return ['hold_slot', 'revert_last_auto_move', 'set_work_schedule_override', 'check_calendar_health', 'get_person_memory'].map(name => ({ name })); } }
  class Domain { executeToolCall(...args) { return options.route === 'connection' ? Promise.resolve(null) : execute(...args); } }
  class Passive { executeToolCall() { return Promise.resolve(null); } getTools() { return []; } }
  const logger = { __esModule: true, default: { info() {}, warn() {}, error() {}, debug() {} } };
  const mocks = {
    'src/utils/logger.ts': logger,
    'src/core/assistant.ts': { AssistantSkill: Core },
    'src/skills/outreach.ts': { OutreachCoreSkill: Passive },
    'src/tasks/skill.ts': { TasksSkill: Passive },
    'src/tasks/crons.ts': { CronsSkill: Passive },
    'src/connections/registry.ts': { getConnection: () => options.noConnection ? undefined : options.route === 'connection' ? { executeToolCall: execute } : {} },
    'src/utils/textScrubber.ts': { registerToolNames() {} },
    'src/db/requests.ts': { getRequest: () => options.approvalTarget ? { kind: 'approval' } : { kind: 'reminder' } },
    'src/skills/meetings/ops.ts': { SchedulingSkill: Core },
    'src/skills/calendarHealth.ts': { CalendarHealthSkill: Domain },
    'src/connectors/graph/calendarReads.ts': { verifyApprovedCalendarAction: async input => {
      verifications.push(input);
      return options.verification || { status: 'unavailable', reason: 'No authoritative readback available.' };
    } },
  };
  const actual = new Set(['src/skills/registry.ts', 'src/core/requests/deferredActionReplay.ts', 'src/core/requests/types.ts']);
  const modules = new Map();
  function load(relative) {
    if (mocks[relative]) return mocks[relative];
    if (modules.has(relative)) return modules.get(relative).exports;
    // Registry's optional profile skills are registered but never enabled in this fixture.
    const optional = { 'src/skills/meetings.ts': 'MeetingsSkill', 'src/skills/general.ts': 'SearchSkill', 'src/skills/summary.ts': 'SummarySkill', 'src/skills/knowledge.ts': 'KnowledgeBaseSkill', 'src/skills/social.ts': 'SocialSkill', 'src/skills/venue.ts': 'VenueSkill', 'src/skills/news.ts': 'NewsSkill' };
    if (optional[relative]) return { [optional[relative]]: Passive };
    if (!actual.has(relative)) { unexpected.push(relative); throw new Error(`Unexpected dependency: ${relative}`); }
    const filename = path.join(repairBefore && relative === 'src/skills/registry.ts'
      ? path.join(evidenceDir, 'action-dispatch-attempt2-before') : before ? baseline : root, relative);
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
    const module = { exports: {} }; modules.set(relative, module);
    const localRequire = spec => {
      if (spec === 'luxon') return { DateTime };
      if (!spec.startsWith('.')) { unexpected.push(spec); throw new Error(`Unexpected external: ${spec}`); }
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec)) + '.ts');
    };
    vm.runInNewContext(`(function(require,module,exports){${compiled.get(filename)}\n})`, { Date, Set, Map }, { filename })(localRequire, module, module.exports);
    return module.exports;
  }
  return { calls, unexpected, verifications, registry: () => load('src/skills/registry.ts'),
    replay: (tool, args, ctx = context) => load('src/core/requests/deferredActionReplay.ts').runDeferredAction({ ownerUserId: ctx.userId, profile, tool, args, requestId: 'req_test', originChannel: ctx.channelId, originThreadTs: ctx.threadTs, surface: ctx.surface }),
    async run(tool, args, ctx = context) {
    if (!before) return load('src/skills/registry.ts').executeApprovedSkillTool(tool, args, ctx);
    // This is the preserved real baseline replay entry point, not a recreated allowlist.
    try {
      const result = await load('src/core/requests/deferredActionReplay.ts').runDeferredAction({ ownerUserId: ctx.userId, profile, tool, args, requestId: 'req_test', originChannel: ctx.channelId, originThreadTs: ctx.threadTs, surface: ctx.surface });
      return { status: 'completed', result };
    } catch (err) {
      if (err.code === 'ENOENT' || String(err).includes('Unexpected')) throw err;
      return { status: 'failed', result: err.sentinel || { error: String(err) } };
    }
  } };
}
const contracts = [
  ['create_meeting', {}, { success: true, meetingId: 'event' }],
  ['move_meeting', {}, { success: true }],
  ['update_meeting', {}, { success: true }],
  ['delete_meeting', {}, { success: true }],
  ['book_floating_block', {}, { ok: true, created: true, event_id: 'event' }],
  ['hold_slot', { action: 'hold' }, { success: true, hold_id: 'hold1', expires_at: '2026-09-12T12:00:00Z' }, 'hold'],
  ['hold_slot', { action: 'release' }, { success: true, released: 1 }, 'release'],
  ['revert_last_auto_move', {}, { success: true, reverted: true }],
  ['set_work_schedule_override', { date_from: '2026-09-12' }, { success: true, dates: ['2026-09-12'] }, 'set'],
  ['set_work_schedule_override', { date_from: '2026-09-12', clear: true }, { success: true, dates: ['2026-09-12'], cleared: 1 }, 'clear'],
  ['check_calendar_health', { mode: 'active' }, { issues: [], count: 0, mode: 'active', fixes_applied: 0, summary: 'Calendar checked.' }, 'active'],
  ['check_calendar_health', { mode: 'passive' }, { issues: [], count: 0, mode: 'passive', fixes_applied: 0, summary: 'Calendar checked.' }, 'passive'],
  ['set_event_category', { event_id: 'event' }, { updated: true, event_id: 'event' }],
  ['message_colleague', {}, { ok: true, sent: true, jobId: 'job1' }],
  ['message_colleague', {}, { ok: true, posted_to_channel: 'CROOM', jobId: 'job1' }, 'channel'],
  ['message_colleague', {}, { scheduled: true, jobId: 'job1', scheduled_at: '2026-09-12T12:00:00Z', _status: 'scheduled_not_sent' }, 'scheduled', 'tracked'],
  ['create_task', {}, { created: true, task_id: 'req_new' }],
  ['create_approval', {}, { ok: true, created: true, approval_id: 'req_new', owner_notified: true }, 'new', 'tracked'],
  ['create_approval', {}, { ok: true, created: false, reused_existing: true, approval_id: 'req_new', owner_notified: true }, 'reused', 'tracked'],
  ['create_approval', {}, { ok: true, created: true, approval_id: 'req_new', owner_notified: false }, 'delivery-pending', 'tracked'],
  ['resolve_approval', { approval_id: 'req_other' }, { ok: true, request_id: 'req_other', state: 'resolved' }, 'different-resolved'],
  ['resolve_approval', { approval_id: 'req_other' }, { ok: true, request_id: 'req_other', state: 'awaiting_colleague' }, 'counter', 'tracked'],
  ['resolve_approval', { approval_id: 'req_other' }, { ok: true, request_id: 'req_other', state: 'cancelled' }, 'different-rejected'],
  ['resolve_approval', { approval_id: '#req_other' }, { ok: true, request_id: 'req_other', state: 'resolved', requester_notify_outcome: 'failed' }, 'relay-pending', 'tracked'],
  ['update_task', { action: 'edit', task_id: 'req_task' }, { updated: true, task_id: 'req_task' }, 'edit'],
  ['update_task', { action: 'cancel', task_id: 'req_task' }, { cancelled: true }, 'cancel'],
  ['update_task', { action: 'cancel', task_id: 'req_other' }, { ok: true, request_id: 'req_other', state: 'cancelled' }, 'other-approval-cancel'],
  ['manage_routine', { action: 'create' }, { created: true, routine_id: 'routine' }, 'create'],
  ['manage_routine', { action: 'update', routine_id: 'routine' }, { updated: true, routine_id: 'routine' }, 'update'],
  ['manage_routine', { action: 'delete' }, { deleted: true }, 'delete'],
  ['manage_routine', { action: 'list' }, { routines: [], count: 0 }, 'list'],
  ['manage_calendar_issue', { action: 'approve' }, { ok: true }, 'preemptive'],
  ['manage_calendar_issue', { action: 'approve', issue_id: 'ci_one' }, { updated: true, issue_id: 'ci_one', status: 'approved' }, 'approve'],
  ['manage_calendar_issue', { action: 'owner_done', issue_id: 'ci_one' }, { updated: true, issue_id: 'ci_one', status: 'resolved' }, 'done'],
  ['manage_calendar_issue', { action: 'owner_will_resolve', issue_id: 'ci_one' }, { updated: true, issue_id: 'ci_one', status: 'owner_side' }, 'owner-side'],
  ['manage_calendar_issue', { action: 'start_resolve', issue_id: 'ci_one' }, { updated: true, issue_id: 'ci_one', status: 'in_progress', request_id: 'req_new' }, 'start', 'tracked'],
  ['manage_calendar_issue', { action: 'list' }, { issues: [], count: 0 }, 'list'],
  ['share_summary', { recipients: [{ type: 'user', id_or_name: 'UONE' }] }, { ok: true, sent_to: [{ id: 'UONE' }], refused: [], send_failures: [] }],
  ['manage_knowledge', { action: 'ingest' }, { ok: true, kind: 'created', section_id: 'company' }, 'ingest'],
  ['manage_knowledge', { action: 'get' }, { ok: true, sections: [] }, 'get'],
  ['learn_summary_style', {}, { ok: true, saved: true }],
  ['update_summary_draft', {}, { ok: true, rendered: 'Updated summary' }],
  ['manage_preference', { action: 'set' }, { saved: true }, 'set'],
  ['manage_preference', { action: 'forget' }, { deleted: true }, 'forget'],
  ['manage_preference', { action: 'recall' }, { preferences: [], count: 0 }, 'recall'],
  ['note_about_person', {}, { saved: true }], ['note_about_self', {}, { saved: true }],
  ['log_interaction', {}, { logged: true }], ['confirm_gender', {}, { confirmed: true }],
  ['update_person_profile', {}, { updated: true }],
  ['update_my_preferences', {}, { ok: true }], ['update_person_memory', {}, { ok: true }],
  ['send_briefing_now', {}, { ok: true }],
];
const cases = [];
function add(id, tool, args, value, expected, options = {}, ctx = context, inspect) {
  cases.push({ id, async run() {
    const h = harness(value, options); const outcome = await h.run(tool, args, ctx);
    assert.equal(outcome.status, expected, JSON.stringify(outcome));
    if (expected !== 'failed') {
      assert.equal(h.calls.length, 1);
      assert.deepEqual(h.calls[0].args, args, 'stored arguments replayed literally');
      assert.equal(h.calls[0].ctx.surface, ctx.surface, 'origin surface retained');
      assert.deepEqual(outcome.result, value, 'domain outcome preserved');
    }
    if (inspect) inspect(outcome, h);
    assert.deepEqual(h.unexpected, [], 'all dependencies explicitly isolated');
  } });
}
for (const [tool, args, result, variant = 'main', status = 'completed'] of contracts) {
  const key = `${tool}-${variant}`;
  add(`${key}-success`, tool, args, result, status);
  for (const [name, invalid] of [['empty', {}], ['id-only', { id: 'unrelated' }], ['null', null], ['error', { ...result, error: 'blocked' }], ['false', { ...result, ok: false }], ['partial', { ...result, partial: true }]]) {
    add(`${key}-${name}`, tool, args, invalid, 'failed');
  }
}
add('knowledge-ambiguous', 'manage_knowledge', { action: 'ingest' }, { ok: true, kind: 'ambiguous', question: 'Which section?' }, 'failed');
add('profile-not-saved', 'update_person_profile', {}, { updated: true, not_saved: ['email'] }, 'failed', {}, context, (outcome) => assert.deepEqual(outcome.result.not_saved, ['email']));
add('summary-partial-send', 'share_summary', { recipients: [{}, {}] }, { ok: true, sent_to: [{}], refused: [], send_failures: [{ reason: 'unavailable' }] }, 'failed');
add('scheduled-without-job', 'message_colleague', {}, { scheduled: true, scheduled_at: '2026-09-12', _status: 'scheduled_not_sent' }, 'failed');
add('start-without-request', 'manage_calendar_issue', { action: 'start_resolve' }, { updated: true, status: 'in_progress' }, 'failed');
add('wrong-category-event', 'set_event_category', { event_id: 'event' }, { updated: true, event_id: 'other' }, 'failed');
add('unknown-calendar-action', 'manage_calendar_issue', { action: 'unknown', issue_id: 'ci_one' }, { updated: true, issue_id: 'ci_one' }, 'failed');
add('health-partial-fix', 'check_calendar_health', { mode: 'active' }, { issues: [{ fixed: false, fix_failed: true, fix_error: 'busy' }], count: 1, mode: 'active', fixes_applied: 0, summary: 'One fix failed.' }, 'failed');
add('schedule-truncated-range', 'set_work_schedule_override', { date_from: '2026-09-12', date_to: '2026-09-14' }, { success: true, dates: ['2026-09-12'] }, 'failed');
add('summary-empty-recipient-record', 'share_summary', { recipients: [{}] }, { ok: true, sent_to: [{}], refused: [], send_failures: [] }, 'failed');
add('executor-throw', 'create_meeting', {}, { success: true }, 'failed', { throws: true });
for (const route of ['core', 'active', 'connection']) add(`executor-${route}-throw-is-unconfirmed`, 'create_meeting', {}, {}, 'failed', { throws: true, route }, { ...context, profile: { ...profile, skills: { calendar: true } } }, (outcome) => {
  assert.equal(outcome.result.error, 'approved_action_unconfirmed');
  assert.equal(outcome.result.needs_verification, true);
});
for (const route of ['core', 'active', 'connection']) add(`executor-${route}-cycle-is-refusal`, 'create_meeting', {}, {}, 'failed', { cycle: true, route }, { ...context, profile: { ...profile, skills: { calendar: true } } }, (outcome) => {
  assert.equal(outcome.result.error, 'request_lock_cycle');
  assert.notEqual(outcome.result.needs_verification, true);
});
for (const error of ['moved_but_missing', 'move_did_not_land']) add(`post-move-${error}-is-unconfirmed`, 'move_meeting', {}, { success: false, error, message: 'Post-PATCH readback did not establish the requested state.' }, 'failed', {}, context, outcome => {
  assert.equal(outcome.result.error, 'approved_action_unconfirmed');
  assert.equal(outcome.result.execution_error, error);
});
for (const error of ['rule_violation', 'slot_on_hold', 'event_load_failed', 'ownership_unverified']) add(`pre-move-${error}-is-refusal`, 'move_meeting', {}, { success: false, error }, 'failed', {}, context, outcome => {
  assert.equal(outcome.result.error, error);
  assert.notEqual(outcome.result.needs_verification, true);
});
for (const reason of ['not_found', 'start_drift']) {
  for (const status of ['desired_state_observed', 'different_state_observed', 'unavailable']) cases.push({ id: `real-post-move-${reason}-${status}`, async run() {
    const result = await postMoveResult(reason);
    const h = harness(result, { verification: { status, result: { success: true, meetingId: 'event-one', _calendar_verification: status } } });
    const args = { meeting_id: 'event-one', new_start: '2026-09-12T12:00:00Z', new_end: '2026-09-12T13:00:00Z' };
    if (status === 'desired_state_observed') {
      const outcome = await h.replay('move_meeting', args);
      assert.equal(outcome._replay_status, 'completed');
    } else {
      await assert.rejects(h.replay('move_meeting', args), err => err.sentinel?.error === 'approved_action_unconfirmed');
    }
    assert.equal(h.calls.length, 1, 'one original execution, no repeated mutation');
    assert.equal(h.verifications.length, 1, 'actual replay reached safe read verifier');
    assert.equal(h.verifications[0].args.meeting_id, 'event-one');
    assert.deepEqual(h.unexpected, []);
  } });
}
cases.push({ id: 'pre-move-refusal-does-not-readback', async run() {
  const h = harness({ success: false, error: 'rule_violation' });
  await assert.rejects(h.replay('move_meeting', { meeting_id: 'event-one' }), err => err.sentinel?.error === 'rule_violation');
  assert.equal(h.verifications.length, 0);
  assert.equal(h.calls.length, 1);
} });
add('executor-unavailable', 'create_meeting', {}, null, 'failed', { noExecutor: true });
add('colleague-refused', 'create_meeting', {}, { success: true }, 'failed', {}, { ...context, authority: 'colleague', userId: 'UCOLLEAGUE' });
add('owner-id-mismatch', 'create_meeting', {}, { success: true }, 'failed', {}, { ...context, userId: 'UCOLLEAGUE' });
add('room-calendar-allowed', 'create_meeting', {}, { success: true }, 'completed', {}, { ...context, surface: 'room' });
add('colleague-dm-calendar-allowed', 'create_meeting', {}, { success: true }, 'completed', {}, { ...context, surface: 'colleague_dm' });
add('room-private-write-refused', 'update_person_memory', {}, { ok: true }, 'failed', {}, { ...context, surface: 'room' });
add('colleague-dm-private-write-refused', 'update_person_memory', {}, { ok: true }, 'failed', {}, { ...context, surface: 'colleague_dm' });
add('private-anchor-channel-missing', 'message_colleague', {}, { ok: true, sent: true, jobId: 'job1' }, 'failed', {}, { ...context, channelId: '' });
add('private-anchor-thread-missing', 'message_colleague', {}, { ok: true, sent: true, jobId: 'job1' }, 'failed', {}, { ...context, threadTs: '' });
add('channel-policy-refused', 'delete_meeting', {}, { success: true }, 'failed', {}, { ...context, channel: 'email' });
for (const tool of ['create_approval', 'resolve_approval', 'unknown_tool']) add(`${tool}-refused`, tool, {}, { ok: true }, 'failed');
add('approval-task-other-target-allowed', 'update_task', { action: 'cancel', task_id: 'req_other' }, { ok: true, request_id: 'req_other', state: 'cancelled' }, 'completed', { approvalTarget: true });
add('approval-already-closed-unexecuted', 'create_approval', {}, { ok: true, created: false, reused_existing: true, already_closed: true, approval_id: 'req_old' }, 'failed');
add('approval-result-other-id-refused', 'resolve_approval', { approval_id: 'req_other' }, { ok: true, request_id: 'req_wrong', state: 'resolved' }, 'failed');
cases.push({ id: 'catalog-room-colleague-floor-preserved', async run() {
  const registry = harness(null).registry();
  assert.deepEqual(Array.from(registry.getSkillTools(profile, 'colleague', undefined, 'slack', 'owner'), t => t.name), ['hold_slot']);
  assert.deepEqual(Array.from(registry.getSkillTools(profile, 'colleague', undefined, 'slack', 'colleague'), t => t.name), ['hold_slot']);
} });
cases.push({ id: 'catalog-owner-private-tools-preserved', async run() {
  const registry = harness(null).registry();
  assert.equal(registry.getSkillTools(profile, 'owner').length, 5);
} });
for (const tool of ['hold_slot', 'revert_last_auto_move', 'set_work_schedule_override', 'check_calendar_health']) cases.push({ id: `write-inventory-${tool}`, async run() {
  assert.equal(harness(null).registry().WRITE_TOOLS.has(tool), true);
} });
async function main() {
  const results = [];
  for (const c of cases) {
    try { await c.run(); results.push({ id: c.id, pass: true }); }
    catch (err) { results.push({ id: c.id, pass: false, reason: err.message }); }
  }
  const report = { phase: repairBefore ? 'repair-before' : before ? 'baseline' : 'after', beforeRevision: before ? '3f2f17e' : 'approval-audit-20260911-action-dispatch-1', passed: results.filter(x => x.pass).length, failed: results.filter(x => !x.pass).length, cases: results };
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, `action-dispatch-attempt2-${report.phase}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, cases: results.filter(x => !x.pass) }, null, 2));
  process.exitCode = report.failed ? 1 : 0;
}
main();
