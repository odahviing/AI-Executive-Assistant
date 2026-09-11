/* Actual replay, resolver, creation and acceptance modules; isolated DB/transport/domain effects.
 * node --test scripts/test-approval-replay-identity.cjs
 * MAELLE_APPROVAL_SOURCE_ROOT selects preserved pre-repair modules, without modifying the worktree.
 */
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const sourceRoot = process.env.MAELLE_APPROVAL_SOURCE_ROOT || root;
const changed = new Set(['src/tasks/skill.ts', 'src/core/requests/deferredActionReplay.ts', 'src/core/requests/resolver.ts', 'src/core/requests/types.ts', 'src/core/approvals/approvalCallbacks.ts']);
const actual = new Set([...changed, 'src/core/requests/types.ts', 'src/core/approvals/approvalCallbacks.ts', 'src/utils/textScrubber.ts']);
const compiled = new Map(), harnesses = [];
const clone = value => JSON.parse(JSON.stringify(value));
const profile = { user: { name: 'Owner Example', slack_user_id: 'UOWNER', timezone: 'UTC' }, assistant: { name: 'Maelle' } };
const meetingTools = ['create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting', 'book_floating_block'];
function harness(options = {}) {
  const effects = { executes: [], creates: [], closes: [], sends: [], ownerPosts: [], keys: [], candidates: [], judges: [], warnings: [], promotions: [] };
  const unexpected = [], pending = [], modules = new Map();
  const details = { deferred_action: { tool: options.tool || 'create_meeting', args: { subject: 'Approved sync', start: '2026-09-20T12:00:00Z', end: '2026-09-20T12:30:00Z', new_start: '2026-09-20T12:00:00Z', new_end: '2026-09-20T12:30:00Z', meeting_id: 'event-1', person_id: 'person-1', expected_value: 'UTC' } }, ...options.details };
  let row = { id: 'req_1234567890123_abcde', kind: 'approval', subkind: 'policy_exception', state: 'awaiting_owner', owner_user_id: 'UOWNER', initiated_by_role: 'colleague', requester_slack_id: 'UPAUL', requester_name: 'Paul', subject: 'Approved sync', origin_channel: 'DPAUL', origin_thread_ts: 'origin.1', details_json: JSON.stringify(details), ...options.row };
  let priorRow = options.prior;
  const update = (id, data) => { assert.equal(id, row.id); row = { ...row, ...data, ...(data.details ? { details_json: JSON.stringify(data.details) } : {}) }; for(const [key,column] of Object.entries({ownerDmChannel:'owner_dm_channel',ownerDmThreadTs:'owner_dm_thread_ts',terminalDmMsgTs:'terminal_dm_msg_ts',nextCheckAt:'next_check_at',nextCheckHandler:'next_check_handler'}))if(Object.hasOwn(data,key))row[column]=data[key]; };
  const execute = async (tool, args, context) => {
    effects.executes.push(clone({ tool, args, context }));
    if (options.throwTool) throw new Error('isolated executor failure');
    return Object.hasOwn(options, 'toolResult') ? options.toolResult : { success: true, meetingId: 'event-1', booked_start: args.start };
  };
  const connection = { sendDirect: async (id, body, opts) => { effects.sends.push({ id, body, opts }); return { ok: true }; }, postToChannel: async (id, body, opts) => { effects.sends.push({ id, body, opts }); return { ok: true }; } };
  const mocks = {
    'src/db/requests.ts': {
      getRequest: id => priorRow?.id === id ? priorRow : row, updateRequest: update, getAwaitingOwnerRequests: () => [row], isKnownRequestThreadAnchor: () => false,
      getRequestByIdempotencyKey: () => options.idempotent ? row : null, getRecentOutreachOwnerThread: () => null,
      buildIdempotencyKey: args => { effects.keys.push(clone(args)); return 'isolated-key'; },
      createRequest: args => { effects.creates.push(clone(args)); if(args.parentRequestId)priorRow=clone(row); row = { ...row, id:args.parentRequestId?'req_1234567890124_repeat':row.id,parent_request_id:args.parentRequestId, state: args.state, subkind: args.subkind, requester_slack_id: args.requesterSlackId ?? null, requester_name: args.requesterName ?? null, origin_channel: args.originChannel, origin_thread_ts: args.originThreadTs, origin_is_mpim: args.originIsMpim ? 1 : 0, details_json: JSON.stringify(args.details) }; return row; },
    },
    'src/core/requests/closeRequest.ts': { closeRequest: args => { effects.closes.push(clone(args)); row = { ...row, state: args.state }; } },
    'src/core/requests/logActivity.ts': { logActivity() {} },
    'src/core/requests/requesterRelay.ts': { isRequesterSendUnconfirmed:r=>r.reason==='error', recordRequesterRelayFailure(){}, completeRequesterRelay:row=>update(row.id,{requesterNotifiedAt:new Date().toISOString()}), relayClosureToRequester:async({compose})=>{effects.sends.push({id:'UPAUL',body:compose({lang:options.lang||'en',hi:'Hey Paul',ownerFirst:'Owner',subject:'Approved sync'})});return true;}, usableRelaySubject: x => typeof x === 'string' ? x : '', requesterRelayLanguage: () => options.lang || 'en' },
    'src/db/conversations.ts': { appendToConversation() {}, getConversationHistory: () => [] },
    'src/db/people.ts': { getPersonMemory: id => options.noPerson ? undefined : { name: id === 'UPAUL' ? 'Paul' : 'Other', timezone: 'UTC', timezone_set_by: 'person' }, promoteTimezoneTempById: (...args) => { effects.promotions.push(args); return options.promotion || 'applied'; } },
    'src/db/client.ts': { getDb: () => ({ prepare: () => ({ all: (...args) => { effects.candidates.push(args); return options.semanticRepeat ? [row] : []; } }) }) },
    'src/db/jobs.ts': { createOutreachJob() {} },
    'src/connections/registry.ts': { getConnection: () => options.noConnection ? undefined : connection },
    'src/skills/meetings/ops.ts': { SchedulingSkill: class { constructor() { if (!options.noExecutor) this.executeToolCall = execute; } } },
    'src/skills/calendarHealth.ts': { CalendarHealthSkill: class { constructor() { if (!options.noExecutor) this.executeToolCall = execute; } } },
    // Dispatcher admission/outcome matrix is tested independently against the real registry.
    'src/skills/registry.ts': { executeApprovedSkillTool: async (tool,args,context) => {
      if(options.noExecutor)return {status:'failed',result:{error:'replay_executor_unavailable'}};
      if(![...meetingTools,'message_colleague','note_about_self'].includes(tool))return {status:'failed',result:{error:'unsupported_replay_tool'}};
      const result=await execute(tool,args,context);
      const positive=result&&typeof result==='object'&&!Array.isArray(result)&&!result.error&&result.ok!==false&&result.success!==false;
      return {status:positive&&result.scheduled===true&&result.jobId?'tracked':positive&&(result.success===true||result.ok===true||result.saved===true)?'completed':'failed',result:result||{}};
    } },
    'src/utils/shadowNotify.ts': { shadowNotify: async () => {} },
    'src/connectors/graph/calendarReads.ts': { verifyApprovedCalendarAction:async()=>options.verification||{status:'unavailable',reason:'No authoritative read can establish this outcome.'} },
    'src/utils/ownerDailyThread.ts': { postOwnerDecision: async args => { effects.ownerPosts.push(args.text); return { ok: !options.ownerPostFail, channel: 'DOWNER', threadTs: 'owner.daily', ts: 'owner.1' }; } },
    'src/utils/workHours.ts': { workTimeBaseFromNow: () => '2026-09-10T00:00:00Z', addWorkdays: () => '2026-09-14T00:00:00Z' },
    'src/utils/weTimeResolver.ts': {}, 'src/utils/workingElsewhere.ts': { getTravelContextForInstant: () => undefined },
    'src/utils/logger.ts': { __esModule: true, default: { info() {}, error() {}, warn: (...args) => effects.warnings.push(args) } },
    'src/utils/resolveSlackId.ts': { resolveSlackId: id => ({ slack_id: id, was_hallucinated: false }) },
    'src/llm/models.ts': { MODEL_HAIKU: 'isolated-model' },
    'src/llm/client.ts': { getAnthropicClient: () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: '' }] }) } }) },
    'src/utils/usageLog.ts': { logLlmUsage() {} }, 'src/tasks/briefs.ts': {}, 'src/utils/requestDedup.ts': {judgeRequestDedup:async args=>{effects.judges.push(args);return {match:'existing',existing_id:row.id};}}, 'src/utils/closeLoopOnOwnerHandled.ts': {},
    'src/db.ts': { getPendingRequestCountForColleague: () => 0 },
  };
  function load(relative) {
    if (Object.hasOwn(mocks, relative)) return mocks[relative];
    if (modules.has(relative)) return modules.get(relative).exports;
    if (!actual.has(relative)) { unexpected.push(relative); throw new Error(`Blocked module ${relative}`); }
    const filename = path.join(changed.has(relative) ? sourceRoot : root, relative);
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
    const module = { exports: {} }; modules.set(relative, module);
    const isolatedRequire = spec => {
      if (spec === 'luxon') return { DateTime };
      if (spec === 'node:util' || spec === 'node:async_hooks') return require(spec);
      if (!spec.startsWith('.')) { unexpected.push(spec); throw new Error(`Blocked external ${spec}`); }
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec)) + '.ts');
    };
    const run = vm.runInNewContext(`(function(require,module,exports){${compiled.get(filename)}\n})`, { Date, Set, Map, setImmediate: callback => pending.push(callback), console: undefined }, { filename });
    run(isolatedRequire, module, module.exports); return module.exports;
  }
  const replay = load('src/core/requests/deferredActionReplay.ts');
  const resolver = load('src/core/requests/resolver.ts');
  const skill = load('src/tasks/skill.ts');
  const context = extra => ({ profile, userId: 'UPAUL', authority: 'colleague', senderRole: 'colleague', surface: 'colleague_dm', channelId: 'DPAUL', threadTs: 'origin.1', ...extra });
  const h = { effects, unexpected, row: () => row, update,
    lock: work => resolver.withRequestLock(row.id, work),
    task: (action, args = {}) => new skill.TasksSkill().executeToolCall('update_task', { task_id: row.id, action, ...args }, context({ userId: 'UOWNER', authority: 'owner', senderRole: 'owner', surface: 'owner_dm' })),
    replay: (extra = {}) => replay.runDeferredAction({ ownerUserId: 'UOWNER', profile, tool: options.tool || 'create_meeting', args: details.deferred_action.args, requestId: row.id, originChannel: row.origin_channel, originThreadTs: row.origin_thread_ts, surface: 'colleague_dm', ...extra }),
    resolve: (verdict = { verdict: 'approve' }, ctx = {}) => resolver.resolveRequest(row.id, verdict, { profile, ...ctx }),
    create: (payload = {}, ctx = {}, args = {}) => new skill.TasksSkill().executeToolCall('create_approval', { kind: 'unknown_person', payload: typeof payload === 'string' ? payload : { missing_fields: ['email'], ...payload }, ask_text: 'Review a person request', expires_in_hours: 1, ...args }, context(ctx)),
    createDirect: ctx => skill.createApprovalRequest({ kind: 'unknown_person', payload: { missing_fields: ['email'] }, ask_text: 'Review a person request', expires_in_hours: 1 }, context(ctx)),
    accept: (userId, data) => new skill.TasksSkill().executeToolCall('resolve_approval', { approval_id: row.id, verdict: 'approve', ...(data ? { data } : {}) }, context({ userId, threadTs: 'owner.1' })),
    flush: async () => { for (const callback of pending.splice(0)) await callback(); },
  };
  harnesses.push(h); return h;
}
afterEach(() => { for (const h of harnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'all dependencies explicitly isolated, including swallowed exceptions'); });
for(const surface of ['colleague_dm','room'])test('audit R6 cancel to private message decision on '+surface,async()=>{
  const h=harness({tool:'delete_meeting',row:{owner_dm_channel:'DOWNER',owner_dm_thread_ts:'owner.daily',origin_is_mpim:surface==='room'?1:0,origin_channel:surface==='room'?'CROOM':'DPAUL'},toolResult:{ok:true,private_raw:'PRIVATE_RESULT_SENTINEL'}});
  const r=await h.resolve({verdict:'approve',data:{tool:'message_colleague',args:{colleague_slack_id:'UTHIRD',message:'Owner chosen message'}}});
  assert.equal(r.ok,true);assert.equal(h.effects.executes[0].tool,'message_colleague');assert.equal(h.effects.executes[0].context.channelId,'DOWNER');assert.equal(h.effects.executes[0].context.surface,'owner_dm');assert.equal(JSON.parse(h.row().details_json).deferred_action.tool,'message_colleague');assert.doesNotMatch(JSON.stringify(h.effects.sends),/PRIVATE_RESULT_SENTINEL|Owner chosen message/);
});
test('audit R6 unavailable private anchor does not execute generic owner action',async()=>{
  const h=harness();const r=await h.resolve({verdict:'approve',data:{tool:'message_colleague',args:{message:'Private'}}});assert.equal(r.ok,false);assert.equal(h.row().state,'awaiting_owner');assert.equal(h.effects.executes.length,0);assert.equal(h.effects.sends.length,0);
});
test('audit R6 tracked scheduled action never announces completion',async()=>{
  const h=harness({row:{owner_dm_channel:'DOWNER',owner_dm_thread_ts:'owner.daily'},toolResult:{scheduled:true,jobId:'out_followup'}});
  const r=await h.resolve({verdict:'approve',data:{tool:'message_colleague',args:{message:'Later'}}});assert.equal(r.ok,true);assert.match(r.effect,/not completed/);assert.match(h.effects.sends[0].body,/has not completed/);
});
test('audit R6 malformed chosen action remains pending',async()=>{
  const h=harness();const r=await h.resolve({verdict:'approve',data:{tool:'message_colleague',args:[]}});assert.equal(r.ok,false);assert.equal(h.effects.executes.length,0);
});
test('audit A07 failed correction delivery invalidates previous reaction anchor and retries',async()=>{
  const h=harness({idempotent:true,ownerPostFail:true,row:{owner_dm_channel:'DOWNER',owner_dm_thread_ts:'owner.daily',terminal_dm_msg_ts:'old.ask'}});
  const r=await h.create({subject:'Changed ask'});assert.equal(h.row().owner_dm_channel,null);assert.equal(h.row().terminal_dm_msg_ts,null);assert.equal(h.row().next_check_handler,'approval_reminder');assert.equal(r.owner_notified,false);
});
test('audit A03 lifecycle queue waits and rereads before resolving',async()=>{
  const h=harness();let release;const gate=new Promise(r=>release=r);const holder=h.lock(async()=>gate);const deciding=h.resolve();h.update(h.row().id,{state:'expired'});release();await holder;const r=await deciding;assert.equal(r.ok,false);assert.equal(h.effects.executes.length,0);
});
for(const lang of ['en','he'])test('audit owner ruling declined repeat asks requester before owner '+lang,async()=>{
  const h=harness({lang,idempotent:true,details:{deferred_action:undefined},row:{state:'cancelled',closed_by:'owner',description:'Review a person request'}});
  const r=await h.create({subject:'Approved sync'});assert.equal(r.awaiting_requester_confirmation,true);assert.equal(h.row().state,'awaiting_colleague');assert.equal(h.effects.ownerPosts.length,0);assert.equal(h.effects.sends.length,1);assert.ok(h.row().parent_request_id);assert.match(h.effects.sends[0].body,lang==='he'?/האם לפנות אליו שוב/:/Should I go to him/);
  const confirmed=await h.resolve({verdict:'approve'},{resolvedByColleague:true,resolvingUserId:'UPAUL'});assert.equal(confirmed.state,'awaiting_owner');assert.equal(h.effects.executes.length,0);assert.equal(h.effects.ownerPosts.length,1);assert.match(h.effects.ownerPosts[0],/prior refusal/);
});
test('audit owner ruling unconfirmed repeat never executes for another actor',async()=>{
  const h=harness({details:{deferred_action:undefined},row:{state:'awaiting_colleague',parent_request_id:'req_prior'},prior:{id:'req_prior',kind:'approval',state:'cancelled',closed_by:'owner'}});
  const r=await h.resolve({verdict:'approve'},{resolvedByColleague:true,resolvingUserId:'UOTHER'});assert.equal(r.ok,false);assert.equal(h.effects.executes.length,0);assert.equal(h.effects.ownerPosts.length,0);
});
test('audit owner ruling requester can decline to re-escalate',async()=>{
  const h=harness({details:{deferred_action:undefined},row:{state:'awaiting_colleague',parent_request_id:'req_prior'},prior:{id:'req_prior',kind:'approval',state:'cancelled',closed_by:'owner'}});
  const r=await h.resolve({verdict:'reject'},{resolvedByColleague:true,resolvingUserId:'UPAUL'});assert.equal(r.state,'cancelled');assert.equal(h.effects.ownerPosts.length,0);assert.equal(h.effects.executes.length,0);
});
test('audit owner ruling uncertainty safely checks calendar but never repeats mutation',async()=>{
  const h=harness({toolResult:{error:'approved_action_unconfirmed'},verification:{status:'desired_state_observed',result:{meetingId:'event-1',_calendar_verification:'desired_state_observed',action_summary:'Requested state observed; provenance unknown.'}}});
  const r=await h.resolve();assert.equal(r.ok,true);assert.equal(h.effects.executes.length,1);assert.match(r.action_summary,/provenance unknown/);
});
test('audit owner ruling unavailable verification reports uncertainty without check promise',async()=>{
  const h=harness({toolResult:{error:'approved_action_unconfirmed'}});const r=await h.resolve();assert.equal(r.ok,false);assert.match(r.reason,/not sure it worked/);assert.match(r.reason,/no further automatic check/);assert.equal(h.effects.executes.length,1);assert.equal(h.effects.sends.length,1);assert.equal(r.state,'resolved');
});
test('audit owner ruling recorded uncertainty prevents blind replay',async()=>{
  const h=harness({row:{outcome_json:JSON.stringify({approved:true,replayed:'create_meeting',verified:false})}});const r=await h.resolve();assert.equal(r.ok,false);assert.equal(h.effects.executes.length,0);assert.match(r.reason,/not repeated/);
});

for (const tool of meetingTools) {
  for (const [label, options] of [
    ['missing connection', { noConnection: true }], ['missing executor', { noExecutor: true }],
    ['undefined result', { toolResult: undefined }], ['null result', { toolResult: null }],
    ['scalar result', { toolResult: true }], ['empty result', { toolResult: {} }], ['array result', { toolResult: [] }],
    ['structured error', { toolResult: { error: 'blocked' } }], ['success false', { toolResult: { success: false } }], ['ok false', { toolResult: { ok: false } }],
    ['contradictory result', { toolResult: { success: true, ok: false } }], ['thrown error', { throwTool: true }],
  ]) test(`Z12 ${tool}: ${label} reports honest unsuccessful outcome`, async () => {
    const h = harness({ tool, ...options });
    const result = await h.resolve();
    const unconfirmed = ['undefined result','null result','scalar result','empty result','array result'].includes(label);
    assert.equal(result.ok, false); assert.equal(h.row().state, unconfirmed ? 'resolved' : 'awaiting_owner');
    assert.equal(h.effects.closes.length, unconfirmed ? 1 : 0); assert.equal(h.effects.sends.length, unconfirmed ? 1 : 0);
    if (unconfirmed) assert.match(result.reason, /not sure it worked/);
    assert.equal(result.booked, undefined);
  });
  for (const surface of ['owner_dm', 'colleague_dm', 'room']) test(`Z12 ${tool}: confirmed success on ${surface}`, async () => {
    const h = harness({ tool, row: { origin_channel: surface === 'room' ? 'CROOM' : 'DPAUL', origin_is_mpim: surface === 'room' ? 1 : 0, ...(surface === 'owner_dm' ? { requester_slack_id: null, initiated_by_role: 'owner' } : {}) }, toolResult: tool === 'book_floating_block' ? { ok: true, created: false, already_existed: true } : { success: true, meetingId: 'event-1', idempotent: true } });
    const result = await h.resolve();
    assert.equal(result.ok, true); assert.equal(h.row().state, 'resolved'); assert.equal(h.effects.closes.length, 1);
    assert.equal(h.effects.executes[0].context.authority, 'owner'); assert.equal(h.effects.executes[0].context.surface, surface);
    assert.equal(h.effects.executes[0].context.isMpim, surface === 'room');
    assert.equal(h.effects.sends.length, surface === 'owner_dm' ? 0 : 1);
  });
}
test('Z12 unsupported direct replay throws', async () => { await assert.rejects(harness().replay({ tool: 'unknown' })); });
for (const outcome of ['applied', 'already_set', 'stale_streak', 'refused_lower_authority', 'no_value', 'no_person']) test(`Z12 timezone ${outcome} without Slack`, async () => {
  const h = harness({ tool: 'promote_timezone_temp', noConnection: true, promotion: outcome, row: { requester_slack_id: null } });
  const result = await h.resolve(); const success = ['applied', 'already_set'].includes(outcome);
  assert.equal(result.ok, success); assert.equal(h.effects.closes.length, success ? 1 : 0); assert.equal(h.effects.promotions.length, 1);
});
test('Z12 timezone missing arguments refuses before write', async () => {
  const h = harness({ tool: 'promote_timezone_temp' }); await assert.rejects(h.replay({ args: {} })); assert.equal(h.effects.promotions.length, 0);
});
for (const [tool, error, effect] of [['create_meeting', 'possible_reschedule', 'approve_replay_possible_reschedule'], ['delete_meeting', 'event_not_found', 'approve_replay_event_not_found']]) test(`Z12 ${error} sentinel retains resolver recovery`, async () => {
  const h = harness({ tool, toolResult: { error, existing_meeting_id: 'event-original' } });
  const result = await h.resolve(); assert.equal(result.ok, false); assert.equal(result.effect, effect); assert.equal(h.effects.closes.length, 0);
});
test('Z12 colleague accepted counter with unavailable executor returns to owner', async () => {
  const h = harness({ noExecutor: true, row: { state: 'awaiting_colleague' }, details: { amended_by: 'owner', amend_round: 1, counter: { start: '2026-09-20T12:00:00Z' } } });
  const result = await h.resolve({ verdict: 'approve' }, { resolvedByColleague: true, resolvingUserId: 'UPAUL' });
  assert.equal(result.ok, false); assert.equal(result.effect, 'approve_needs_owner_recovery'); assert.equal(h.row().state, 'awaiting_owner');
  assert.equal(h.effects.closes.length, 0); assert.equal(h.effects.sends.length, 0); assert.equal(h.effects.ownerPosts.length, 1);
  assert.equal(JSON.parse(h.row().details_json).amend_round, 1);
});
for (const failed of [true, false]) test(`Z12 reject side effect ${failed ? 'failure logs without claiming action' : 'success preserves rejection'}`, async () => {
  const h = harness({ noConnection: failed, details: { callbacks: { on_reject: { tool: 'delete_meeting', args: { meeting_id: 'event-1' } } } } });
  const result = await h.resolve({ verdict: 'reject', reason: 'Declined' }); await h.flush();
  assert.equal(result.ok, true); assert.equal(h.row().state, 'cancelled'); assert.equal(result.booked, undefined);
  assert.equal(h.effects.warnings.some(args => args[0] === 'on_reject replay threw — non-fatal'), failed);
});

for (const surface of ['colleague_dm', 'room']) for (const claimed of ['UOTHER', 'UOWNER', 'UPAUL', undefined]) test(`Z22 ${surface} claimed ${claimed}: authenticated requester controls creation`, async () => {
  const h = harness();
  const result = await h.create({ requester_slack_id: claimed, requester_name: 'Forged Other', subject: 'Review person' }, { surface, channelId: surface === 'room' ? 'CROOM' : 'DPAUL' });
  assert.equal(result.ok, true); assert.equal(h.row().requester_slack_id, 'UPAUL'); assert.equal(h.row().requester_name, 'Paul');
  assert.equal(JSON.parse(h.row().details_json).requester_slack_id, 'UPAUL');
  assert.equal(h.effects.keys[0].requesterSlackId, 'UPAUL'); assert.equal(h.effects.candidates[0][1], 'UPAUL');
});
for (const surface of ['colleague_dm', 'room']) test(`Z22 legitimate ${surface} requester without model identity`, async () => {
  const h = harness(); const result = await h.create({}, { surface });
  assert.equal(result.ok, true); assert.equal(h.row().requester_slack_id, 'UPAUL'); assert.equal(h.row().requester_name, 'Paul');
});
test('Z22 unavailable connection preserves tracked authenticated request', async () => {
  const h = harness({ noConnection: true }); const result = await h.create({});
  assert.equal(result.ok, true); assert.equal(h.row().requester_slack_id, 'UPAUL'); assert.equal(h.effects.ownerPosts.length, 0);
});
for (const userId of [undefined, '', ' ']) test(`Z22 missing authenticated identity ${JSON.stringify(userId)} refuses creation`, async () => {
  const h = harness(); const result = await h.create({ requester_slack_id: 'UOTHER' }, { userId });
  assert.equal(result.error, 'not_permitted'); assert.equal(h.effects.creates.length, 0); assert.equal(h.effects.ownerPosts.length, 0);
});
for (const surface of ['owner_dm', 'room']) test(`Z22 owner internal ${surface} has no colleague requester`, async () => {
  const h = harness(); await h.create({}, { userId: 'UOWNER', authority: 'owner', senderRole: surface === 'room' ? 'colleague' : 'owner', surface });
  assert.equal(h.row().requester_slack_id, null);
});
test('Z22 owner can nominate a colleague recipient', async () => {
  const h = harness(); await h.create({ requester_slack_id: 'UOTHER', requester_name: 'Other' }, { userId: 'UOWNER', authority: 'owner', senderRole: 'owner', surface: 'owner_dm' });
  assert.equal(h.row().requester_slack_id, 'UOTHER'); assert.equal(h.row().requester_name, 'Other');
});
test('Z22 direct primitive preserves owner room identity used by calendar callers', async () => {
  const h = harness(); const result = await h.createDirect({ userId: 'UOWNER', authority: 'owner', senderRole: 'colleague', surface: 'room' });
  assert.equal(result.ok, true); assert.equal(h.row().requester_slack_id, null); assert.equal(h.row().origin_is_mpim, 1);
});
test('Z22 clamped owner is not minted as colleague or allowed forged recipient', async () => {
  const h = harness(); await h.create({ requester_slack_id: 'UOTHER' }, { userId: 'UOWNER', authority: 'colleague', surface: 'room' });
  assert.equal(h.row().requester_slack_id, null);
});
test('Z22 unknown authenticated person stays authenticated without forged display name', async () => {
  const h = harness({ noPerson: true }); await h.create({ requester_slack_id: 'UOTHER', requester_name: 'Forged' });
  assert.equal(h.row().requester_slack_id, 'UPAUL'); assert.equal(h.row().requester_name, null);
});
test('Z22 string payload follows the same authenticated identity binding', async () => {
  const h = harness(); const result = await h.create(JSON.stringify({ requester_slack_id: 'UOTHER', missing_fields: ['email'] })); assert.equal(result.ok, true); assert.equal(h.row().requester_slack_id, 'UPAUL');
});
test('Z22 creation to counter acceptance rejects impostor and preserves original requester', async () => {
  const h = harness(); await h.create({ requester_slack_id: 'UOTHER' });
  h.update(h.row().id, { state: 'awaiting_colleague', details: { ...JSON.parse(h.row().details_json), amended_by: 'owner', counter: { text: 'Owner decision' }, amend_round: 1 } });
  assert.equal((await h.accept('UOTHER')).error, 'not_permitted'); assert.equal(h.effects.closes.length, 0);
  assert.equal((await h.accept('UPAUL', { force_new: true })).ok, false); assert.equal(h.effects.closes.length, 0);
  assert.equal((await h.accept('UPAUL')).ok, true); assert.equal(h.effects.closes.length, 1);
  assert.equal(h.effects.sends[0].id, 'UPAUL');
});


test('audit A07 changed callback alone reposts the current decision',async()=>{
 const h=harness({idempotent:true,row:{subject:'Review person',description:'Review a person request'},details:{missing_fields:['email']}});
 await h.create({subject:'Review person',callbacks:{on_approve:{tool:'delete_meeting',args:{meeting_id:'fresh-event'}}}});
 assert.equal(h.effects.ownerPosts.length,1);
});
test('audit A07 correction replaces stale callback and old counter',async()=>{
 const h=harness({idempotent:true,details:{callbacks:{on_approve:{tool:'move_meeting',args:{meeting_id:'old-event',new_start:'2026-09-20T12:00:00Z'}}},counter:{new_start:'2026-09-20T16:00:00Z'},amend_round:1}});
 await h.create({subject:'Review person',deferred_action:{tool:'create_meeting',args:{subject:'Corrected',start:'2026-09-21T12:00:00Z',end:'2026-09-21T12:30:00Z'}}});
 await h.resolve();
 assert.equal(h.effects.executes[0].tool,'create_meeting');assert.equal(h.effects.executes[0].args.start,'2026-09-21T12:00:00Z');
});
test('audit A08 owner task cancel closes requester loop',async()=>{
 const h=harness();await h.task('cancel');assert.equal(h.row().state,'cancelled');assert.equal(h.effects.sends.length,1);
});
test('audit A08 generic task edit cannot silently rewrite an approval',async()=>{
 const h=harness();const result=await h.task('edit',{title:'Changed approval'});assert.equal(result.error,'approval_requires_decision_tool');assert.notEqual(h.row().subject,'Changed approval');
});
test('audit A10 initial unavailable approval delivery has a prompt retry',async()=>{
 const h=harness({noConnection:true});const result=await h.create();assert.equal(result.ok,true);assert.equal(result.owner_notified,false);assert.equal(h.row().nextCheckHandler,'approval_reminder');assert.ok(Date.parse(h.row().nextCheckAt)<=Date.now()+301000);
});
test('audit A10 legitimate successful approval reports delivery',async()=>{
 const h=harness();const result=await h.create();assert.equal(result.owner_notified,true);assert.equal(h.effects.ownerPosts.length,1);
});
