/* Actual replay, resolver, creation and acceptance modules; isolated DB/transport/domain effects.
 * node --test scripts/test-yael-request-lifecycle.cjs
 * MAELLE_APPROVAL_SOURCE_ROOT selects preserved pre-repair modules, without modifying the worktree.
 */
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '../..');
const sourceRoot = process.env.MAELLE_APPROVAL_SOURCE_ROOT || root;
const changed = new Set(['src/tasks/skill.ts', 'src/core/requests/deferredActionReplay.ts', 'src/core/requests/resolver.ts', 'src/core/requests/types.ts', 'src/core/approvals/approvalCallbacks.ts']);
const actual = new Set([...changed, 'src/core/requests/runner.ts', 'src/core/requests/closeRequest.ts', 'src/core/requests/requesterRelay.ts', 'src/utils/threadBoundApprovalAutoResolve.ts', 'src/core/requests/types.ts', 'src/core/approvals/approvalCallbacks.ts', 'src/utils/textScrubber.ts']);
const compiled = new Map(), harnesses = [];
const clone = value => JSON.parse(JSON.stringify(value));
const profile = { user: { name: 'Owner Example', slack_user_id: 'UOWNER', timezone: 'UTC' }, assistant: { name: 'Maelle' } };
const meetingTools = ['create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting', 'book_floating_block'];
function harness(options = {}) {
  // The fixture's September decisions must run before their September starts.
  class Clock extends Date { constructor(...a) { super(...(a.length ? a : [options.now ?? Date.parse('2026-09-10T00:00:00Z')])); } static now() { return options.now ?? Date.parse('2026-09-10T00:00:00Z'); } }
  // Module-local clock: Luxon must use the same instant as Date without
  // changing process-global Settings.now for other fixtures.
  class FixtureDateTime extends DateTime { static now() { return DateTime.fromMillis(Clock.now()); } }
  const effects = { executes: [], creates: [], closes: [], sends: [], ownerPosts: [], keys: [], candidates: [], judges: [], warnings: [], promotions: [] };
  const unexpected = [], pending = [], modules = new Map();
  const details = { deferred_action: { tool: options.tool || 'create_meeting', args: { subject: 'Approved sync', start: '2026-09-20T12:00:00Z', end: '2026-09-20T12:30:00Z', new_start: '2026-09-20T12:00:00Z', new_end: '2026-09-20T12:30:00Z', meeting_id: 'event-1', person_id: 'person-1', expected_value: 'UTC' } }, ...options.details };
  let row = { id: 'req_1234567890123_abcde', kind: 'approval', subkind: 'policy_exception', state: 'awaiting_owner', owner_user_id: 'UOWNER', initiated_by_role: 'colleague', requester_slack_id: 'UPAUL', requester_name: 'Paul', subject: 'Approved sync', origin_channel: 'DPAUL', origin_thread_ts: 'origin.1', details_json: JSON.stringify(details), ...options.row };
  let priorRow = options.prior;
  const update = (id, data) => { assert.equal(id, row.id); row = { ...row, ...data, ...(data.details ? { details_json: JSON.stringify(data.details) } : {}) }; for(const [key,column] of Object.entries({outcomeExternalEventId:'outcome_external_event_id',closedBy:'closed_by',requesterNotifiedAt:'requester_notified_at',outcomeJson:'outcome_json',expiresAt:'expires_at',ownerDmChannel:'owner_dm_channel',ownerDmThreadTs:'owner_dm_thread_ts',terminalDmMsgTs:'terminal_dm_msg_ts',nextCheckAt:'next_check_at',nextCheckHandler:'next_check_handler'}))if(Object.hasOwn(data,key))row[column]=key==='outcomeJson'?JSON.stringify(data[key]):data[key]; };
  const execute = async (tool, args, context) => {
    effects.executes.push(clone({ tool, args, context }));
    if(options.execute)return options.execute(tool,args,context);
    if (options.throwTool) throw new Error('isolated executor failure');
    return Object.hasOwn(options, 'toolResult') ? options.toolResult : { success: true, meetingId: 'event-1', booked_start: args.start };
  };
  const connection = { sendDirect: async (id, body, opts) => { effects.sends.push({ id, body, opts }); if(options.relayThrows)throw Error('provider timeout'); return options.relayOutcome || { ok: true }; }, postToChannel: async (id, body, opts) => { effects.sends.push({ id, body, opts }); if(options.relayThrows)throw Error('provider timeout'); return options.relayOutcome || { ok: true }; } };
  const mocks = {
    'src/db/requests.ts': {
      getDueRequests:()=>row.next_check_at?[row]:[],getLatestFreeformOwnerFlag:()=>null,getChildRequests:()=>[],getRequest: id => priorRow?.id === id ? priorRow : row, updateRequest: update, getAwaitingOwnerRequests: () => [row], isKnownRequestThreadAnchor: () => false,
      getRequestByIdempotencyKey: () => options.idempotent ? row : null, getRecentOutreachOwnerThread: () => null,
      buildIdempotencyKey: args => { effects.keys.push(clone(args)); return 'isolated-key'; },
      createRequest: args => { effects.creates.push(clone(args)); if(args.parentRequestId)priorRow=clone(row); row = { ...row, id:args.parentRequestId?'req_1234567890124_repeat':row.id,parent_request_id:args.parentRequestId, state: args.state, next_check_at:args.nextCheckAt,next_check_handler:args.nextCheckHandler,expires_at:args.expiresAt, subkind: args.subkind, requester_slack_id: args.requesterSlackId ?? null, requester_name: args.requesterName ?? null, origin_channel: args.originChannel, origin_thread_ts: args.originThreadTs, origin_is_mpim: args.originIsMpim ? 1 : 0, details_json: JSON.stringify(args.details) }; return row; },
    },
    'src/core/requests/closeRequest.ts': { closeRequest: args => { effects.closes.push(clone(args)); row = { ...row, state: args.state, outcome_json: JSON.stringify(args.outcomeJson || {}), outcome_external_event_id:args.outcomeExternalEventId };  } },
    'src/core/requests/logActivity.ts': { logActivity() {} },
    'src/core/requests/requesterRelay.ts': {recordOwnerNotificationOutcome(){}, relayNotice: require('./relay-copy.cjs').relayNotice, beginRequesterRelayAttempt:()=>true,requesterRelayStopped:()=>false,isRequesterSendUnconfirmed:r=>r.reason==='error', recordRequesterRelayFailure(){}, completeRequesterRelay:row=>update(row.id,{requesterNotifiedAt:new Date().toISOString()}), relayClosureToRequester:async({compose})=>{effects.sends.push({id:'UPAUL',body:compose({lang:options.lang||'en',hi:'Hey Paul',ownerFirst:'Owner',subject:'Approved sync'})});return true;}, usableRelaySubject: x => typeof x === 'string' ? x : '', requesterRelayLanguage: () => options.lang || 'en' },
    'src/db/conversations.ts': { appendToConversation() {}, getConversationHistory: () => [] },
    'src/utils/outboundTracker.ts': {recordOutbound(){}},
    'src/utils/responseDeadline.ts':{},'src/utils/timezoneConvert.ts':{},'src/core/requests/colleagueOofReengage.ts':{},
    'src/db/people.ts': {findPersistentUnaskedTimezoneDivergences:()=>[], resolveOutboundLanguageForPerson:()=>options.lang||null, getPersonMemory: id => options.noPerson ? undefined : { name: id === 'UPAUL' ? 'Paul' : 'Other', timezone: 'UTC', timezone_set_by: 'person' }, promoteTimezoneTempById: (...args) => { effects.promotions.push(args); return options.promotion || 'applied'; } },
    'src/db/client.ts': { getDb: () => ({ prepare: () => ({run:()=>{}, all: (...args) => { effects.candidates.push(args); return options.semanticRepeat ? [row] : []; } }) }) },
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
    'src/connectors/graph/calendar.ts':{verifyEventDeleted:async()=>false},
    'src/connectors/graph/calendarReads.ts': { verifyApprovedCalendarAction:async()=>options.verification||{status:'unavailable',reason:'No authoritative read can establish this outcome.'} },
    'src/utils/ownerDailyThread.ts': { postOwnerDecision: async args => { effects.ownerPosts.push(args.text); return { ok: !options.ownerPostFail, channel: 'DOWNER', threadTs: 'owner.daily', ts: 'owner.1' }; } },
    'src/utils/workHours.ts': { workTimeBaseFromNow: () => '2026-09-10T00:00:00Z', addWorkdays: () => '2026-09-14T00:00:00Z' },
    'src/utils/weTimeResolver.ts': { StatedTimeClarificationError: class extends Error {}, statedClockPersonContext: () => undefined, statedZoneFromArgs: args => args.stated_zone || args.start_timezone, resolveStatedInstant: input => ({ startIso: input.startIso, endIso: input.endIso }) },
    'src/utils/attendeeAvailability.ts': { loadAttendeeAvailabilityForPerson: (person, fallback) => ({ timezone: person?.timezone || fallback }), attendeeTzForDay: entry => entry.timezone },
    'src/utils/workingElsewhere.ts': { getTravelContextForInstant: () => undefined },
    'src/utils/logger.ts': { __esModule: true, default: { info() {}, error() {}, warn: (...args) => effects.warnings.push(args) } },
    'src/utils/resolveSlackId.ts': { resolveSlackId: id => ({ slack_id: id, was_hallucinated: false }) },
    'src/llm/models.ts': { MODEL_HAIKU: 'isolated-model' },
    'src/llm/client.ts': { getAnthropicClient: () => ({ messages: { create: async () => ({ content: [{ type: 'tool_use', input: { verdict: options.classification || 'unsure' } }] }) } }) },
    'src/utils/usageLog.ts': { logLlmUsage() {} }, 'src/tasks/briefs.ts': {}, 'src/utils/requestDedup.ts': {judgeRequestDedup:async args=>{effects.judges.push(args);return {match:'existing',existing_id:row.id,material_change:options.materialChange};}}, 'src/utils/closeLoopOnOwnerHandled.ts': {},
    'src/db.ts': { getPendingRequestCountForColleague: () => options.pendingCount || 0 },
  };
  // Execute the historical delivery helper as authored, with the same isolated
  // connection/row adapters. This lets before tests observe the logged defect.
  const ownerFile=path.join(sourceRoot,'src/utils/ownerDailyThread.ts');
  const ownerText=fs.readFileSync(fs.existsSync(ownerFile)?ownerFile:path.join(root,'src/utils/ownerDailyThread.ts'),'utf8');
  const ast=ts.createSourceFile('owner.ts',ownerText,ts.ScriptTarget.Latest,true);
  const flag=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='deliverAndRecordOwnerFlag');
  if(flag){
  const legacy={exports:{}};
  const legacyCode=ts.transpileModule(flag.getText(),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext('(function(require,module,exports){'+legacyCode+'\n})',{DateTime:FixtureDateTime,postOwnerDecision:mocks['src/utils/ownerDailyThread.ts'].postOwnerDecision,logger:mocks['src/utils/logger.ts'].default})(name=>load(path.posix.normalize(path.posix.join('src/utils',name))+'.ts'),legacy,legacy.exports);
  mocks['src/utils/ownerDailyThread.ts'].deliverAndRecordOwnerFlag=legacy.exports.deliverAndRecordOwnerFlag;
  }
  function load(relative) {
    if (Object.hasOwn(mocks, relative) && !['src/core/requests/requesterRelay.ts','src/core/requests/closeRequest.ts'].includes(relative)) return mocks[relative];
    if (modules.has(relative)) return modules.get(relative).exports;
    if (!actual.has(relative)) { unexpected.push(relative); throw new Error(`Blocked module ${relative}`); }
    const filename = path.join(changed.has(relative) ? sourceRoot : root, relative);
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
    const module = { exports: {} }; modules.set(relative, module);
    const isolatedRequire = spec => {
      if (spec === 'luxon') return { DateTime: FixtureDateTime };
      if (spec === 'node:util' || spec === 'node:async_hooks' || spec === 'node:crypto') return require(spec);
      if (!spec.startsWith('.')) { unexpected.push(spec); throw new Error(`Blocked external ${spec}`); }
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec)) + '.ts');
    };
    const run = vm.runInNewContext(`(function(require,module,exports){${compiled.get(filename)}\n})`, { Date: Clock, Set, Map, setImmediate: callback => pending.push(callback), console: undefined }, { filename });
    run(isolatedRequire, module, module.exports); return module.exports;
  }
  const replay = load('src/core/requests/deferredActionReplay.ts');
  const resolver = load('src/core/requests/resolver.ts');
  const skill = load('src/tasks/skill.ts');
  const context = extra => ({ profile, userId: 'UPAUL', authority: 'colleague', senderRole: 'colleague', surface: 'colleague_dm', channelId: 'DPAUL', threadTs: 'origin.1', ...extra });
  const h = { effects, unexpected, row: () => row, update,
    bound:()=>load('src/utils/threadBoundApprovalAutoResolve.ts').tryAutoResolveThreadBoundApproval({message:'yes',threadTs:'owner.1',ownerUserId:'UOWNER',profile}),
    lock: work => resolver.withRequestLock(row.id, work),
    task: (action, args = {}) => new skill.TasksSkill().executeToolCall('update_task', { task_id: row.id, action, ...args }, context({ userId: 'UOWNER', authority: 'owner', senderRole: 'owner', surface: 'owner_dm' })),
    replay: (extra = {}) => replay.runDeferredAction({ ownerUserId: 'UOWNER', profile, tool: options.tool || 'create_meeting', args: details.deferred_action.args, requestId: row.id, originChannel: row.origin_channel, originThreadTs: row.origin_thread_ts, surface: 'colleague_dm', ...extra }),
    restart:()=>modules.clear(),
    sweep:()=>load('src/core/requests/runner.ts').sweepDueRequests({profilesByUserId:new Map([['UOWNER',profile]])}),
    retryRelay:()=>load('src/core/requests/requesterRelay.ts').retryRequesterRelay(row,profile),
    resolve: (verdict = { verdict: 'approve' }, ctx = {}) => load('src/core/requests/resolver.ts').resolveRequest(row.id, verdict, { profile, ...ctx }),
    create: (payload = {}, ctx = {}, args = {}) => new skill.TasksSkill().executeToolCall('create_approval', { kind: 'unknown_person', payload: typeof payload === 'string' ? payload : { missing_fields: ['email'], ...payload }, ask_text: 'Review a person request', expires_in_hours: 1, ...args }, context(ctx)),
    createDirect: ctx => skill.createApprovalRequest({ kind: 'unknown_person', payload: { missing_fields: ['email'] }, ask_text: 'Review a person request', expires_in_hours: 1 }, context(ctx)),
    accept: (userId, data) => new skill.TasksSkill().executeToolCall('resolve_approval', { approval_id: row.id, verdict: 'approve', ...(data ? { data } : {}) }, context({ userId, threadTs: 'owner.1' })),
    flush: async () => { for (const callback of pending.splice(0)) await callback(); },
  };
  harnesses.push(h); return h;
}

module.exports={harness,profile};
