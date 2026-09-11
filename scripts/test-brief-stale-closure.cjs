/* Actual complete brief, requester-relay and closeRequest modules. No app boot or external effects.
 * node --test scripts/test-brief-stale-closure.cjs
 * BRIEF_SOURCE_FIXTURE selects a byte-preserved baseline briefs.ts for before execution.
 */
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const actual = new Set(['src/tasks/briefs.ts','src/core/requests/requesterRelay.ts','src/core/requests/closeRequest.ts','src/core/requests/types.ts']);
const compiled = new Map(), harnesses = [];
const clone = x => JSON.parse(JSON.stringify(x));
const profile = { user:{ slack_user_id:'UOWNER', name:'Owner Example', email:'owner@example.test', timezone:'UTC', language:'en' }, assistant:{name:'Maelle'}, skills:{news:false,calendar:false} };
function harness(options={}) {
  let row = { id:'req_stale_1', owner_user_id:'UOWNER', kind:'approval', subkind:'unknown_person', state:'awaiting_owner', surfaced_count:2, informed:0, subject:'Contact review', requester_slack_id:'UPERSON', requester_name:'Person Example', origin_channel:'DPERSON', origin_thread_ts:'origin.1', origin_is_mpim:0, details_json:'{}', ...options.row };
  const effects = { requester:[], owner:[], updates:[], warnings:[], logs:[], audit:[], history:[], outreach:[] }, unexpected=[], modules=new Map();
  let freshReads=0;
  const db={prepare:sql=>({get:()=>undefined,all:()=>[],run:args=>effects.audit.push(args)})};
  const update=(id,data)=>{assert.equal(id,row.id);effects.updates.push(clone(data));row={...row,...data,...(data.requesterNotifiedAt ? {requester_notified_at:data.requesterNotifiedAt}:{}),...(data.closureReason?{closure_reason:data.closureReason}:{})};for(const [key,column]of Object.entries({outcomeJson:'outcome_json',nextCheckAt:'next_check_at',nextCheckHandler:'next_check_handler'}))if(Object.hasOwn(data,key))row[column]=key==='outcomeJson'?JSON.stringify(data[key]):data[key];};
  const send=async(type,id,body,opts)=>{
    effects.requester.push({type,id,body,opts,stateAtSend:row.state});
    if(options.pendingSend) await options.pendingSend;
    if(options.sendThrows) throw new Error('isolated send failure');
    return {ok:!options.sendFails,reason:options.sendFails?(options.sendReason||'channel_not_found'):undefined};
  };
  const connection={
    postToChannel:async(id,body,opts)=>{if(id==='DOWNER'){effects.owner.push({id,body,opts});if(options.duringOwnerPost) row=options.duringOwnerPost(row);return {ok:true,ts:'brief.1'};}return send('room',id,body,opts);},
    sendDirect:(id,body,opts)=>send('dm',id,body,opts),
  };
  const mocks={
    'src/db.ts':{getDb:()=>db,getPreferences:()=>[],markEventsSeen(){},appendToConversation(){},logEvent(){}},
    'src/db/client.ts':{getDb:()=>db},
    'src/db/conversations.ts':{appendToConversation:(...args)=>effects.history.push(args)},
    'src/db/jobs.ts':{createOutreachJob:args=>effects.outreach.push(args)},
    // Serial standalone cases use an immediate boundary; joint B05 injects
    // the SAME real resolver FIFO already holding the approved mutation.
    'src/core/requests/resolver.ts':{withRequestLock:(id,work)=>options.withRequestLock?options.withRequestLock(id,work):work()},
    'src/db/requests.ts':{
      getRequestsForBrief:()=>[clone(row)],todayStartUtcIso:()=> '2026-09-11T00:00:00Z',
      markRequestSurfaced:()=>{row={...row,surfaced_count:row.surfaced_count+1};},
      getRequest:()=>{freshReads++;if(options.missingRow||options.disappearsAtClose&&freshReads===2)return undefined;if(options.terminalAtClose&&freshReads===2)row={...row,state:'resolved'};return row;},getChildRequests:()=>[],updateRequest:update,
    },
    'src/db/people.ts':{getPersonByEmail:()=>undefined,getPersonMemory:()=>({}),resolveOutboundLanguageForPerson:()=>options.lang||'en'},
    // The unavailable case is the requester relay AFTER a confirmed owner
    // brief. No owner delivery must never surface or close an unseen request.
    'src/connections/registry.ts':{getConnection:()=>options.noConnection&&effects.owner.length>0?undefined:connection},
    'src/connectors/graph/calendar.ts':{getCalendarEvents:async()=>[]},
    'src/utils/skillPreferences.ts':{formatSkillPreferencesBlock:()=>''},
    'src/skills/news.ts':{formatSeenLogBlock:()=>'',NEWS_PER_GOAL_TIMEOUT_MS:1},
    'src/skills/meetings/ops.ts':{}, 'src/utils/verifyScheduledOutcome.ts':{},
    'src/utils/logger.ts':{__esModule:true,default:{info:(...args)=>effects.logs.push(args),warn:(...args)=>effects.warnings.push(args),error:(...args)=>effects.warnings.push(args)}},
    'src/utils/calendarListingFormat.ts':{calendarListingFormatRule:()=>''},
    'src/utils/cleanupVanishedMeetingArtifacts.ts':{cleanupVanishedMeetingArtifacts:async()=>{}},
    'src/db/slotHolds.ts':{getActiveSlotHolds:()=>[],getRecentlyFulfilledHolds:()=>[]},
    'src/utils/humanGate.ts':{runHumanGate:async()=>({ok:true})},
    'src/llm/client.ts':{getAnthropicClient:()=>({messages:{create:async()=>({content:[{type:'text',text:'Review your pending ask.'}]})}})},
    'src/llm/models.ts':{SONNET:{}},
  };
  function load(relative){
    if(Object.hasOwn(mocks,relative))return mocks[relative];
    if(modules.has(relative))return modules.get(relative).exports;
    if(!actual.has(relative)){unexpected.push(relative);throw new Error(`Blocked module: ${relative}`);}
    const filename=relative==='src/tasks/briefs.ts'&&process.env.BRIEF_SOURCE_FIXTURE?process.env.BRIEF_SOURCE_FIXTURE:relative==='src/core/requests/requesterRelay.ts'&&process.env.BRIEF_RELAY_SOURCE_FIXTURE?process.env.BRIEF_RELAY_SOURCE_FIXTURE:path.join(root,relative);
    if(!compiled.has(filename))compiled.set(filename,ts.transpileModule(fs.readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
    const module={exports:{}};modules.set(relative,module);
    const requireIsolated=spec=>{
      if(spec==='luxon')return {DateTime};
      if(!spec.startsWith('.')){unexpected.push(spec);throw new Error(`Blocked external: ${spec}`);}
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative),spec))+'.ts');
    };
    const run=vm.runInNewContext(`(function(require,module,exports){${compiled.get(filename)}\n})`,{Date,Set,Map,Intl},{filename});
    run(requireIsolated,module,module.exports);return module.exports;
  }
  const brief=load('src/tasks/briefs.ts');
  const relay=load('src/core/requests/requesterRelay.ts');
  const h={effects,unexpected,row:()=>row,run:()=>brief.sendMorningBriefing({},profile,'DOWNER',true,'brief.thread'),relayAgain:()=>relay.relayClosureToRequester({row,profile,label:'test subsequent path',compose:()=> 'duplicate'}),retry:()=>relay.retryRequesterRelay(row,profile),recover:()=>{options.sendFails=false;options.sendThrows=false;options.noConnection=false;}};
  harnesses.push(h);return h;
}
afterEach(()=>{for(const h of harnesses.splice(0))assert.deepEqual(h.unexpected,[],'caught unexpected dependencies must not pass silently');});
test('stale approval closes through the spine then confirms requester delivery',async()=>{
  const h=harness();await h.run();
  assert.equal(h.row().state,'cancelled');assert.equal(h.row().closure_reason,'surfaced_threshold');
  assert.equal(h.effects.requester.length,1);assert.equal(h.effects.requester[0].stateAtSend,'cancelled');
  assert.ok(h.row().requester_notified_at);assert.equal(h.effects.requester[0].opts.threadTs,'origin.1');
});
test('subsequent canonical closure path does not duplicate a confirmed brief relay',async()=>{
  const h=harness();await h.run();await h.relayAgain();assert.equal(h.effects.requester.length,1);
});
test('Hebrew requester receives shared Hebrew closure copy',async()=>{
  const h=harness({lang:'he'});await h.run();assert.match(h.effects.requester[0].body,/^היי Person/);assert.ok(h.row().requester_notified_at);
});
test('English requester keeps truthful no-owner-response copy',async()=>{
  const h=harness();await h.run();assert.match(h.effects.requester[0].body,/I couldn't get a read from Owner on Contact review/);assert.equal(h.row().state,'cancelled');
});
test('room requester retains originating thread',async()=>{
  const h=harness({row:{origin_is_mpim:1,origin_channel:'CROOM'}});await h.run();
  assert.equal(h.effects.requester[0].id,'CROOM');assert.equal(h.effects.requester[0].opts.threadTs,'origin.1');
});
test('internal approval question is replaced by canonical safe subject fallback',async()=>{
  const h=harness({row:{subject:'Can Owner share private contact details?'}});await h.run();
  assert.ok(!h.effects.requester[0].body.includes('private contact'));assert.match(h.effects.requester[0].body,/on that ask/);
});
test('brief waits for closure send result before completing',async()=>{
  let release;const pendingSend=new Promise(r=>{release=r;});const h=harness({pendingSend});let done=false;
  const task=h.run().then(()=>{done=true;});
  for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(h.effects.requester.length,1);assert.equal(done,false);
  release();await task;assert.ok(h.row().requester_notified_at);
});
for(const [label,options]of [['soft failure',{sendFails:true}],['thrown failure',{sendThrows:true}],['missing connection',{noConnection:true}]])test(`${label} leaves delivery unstamped and records failure`,async()=>{
  const h=harness(options);await h.run();assert.equal(h.row().state,'cancelled');assert.equal(h.row().requester_notified_at,undefined);
  assert.ok(h.effects.warnings.some(([message])=>message.startsWith('briefs stale requester loop-close')));
});
for(const [label,row]of [['owner self',{requester_slack_id:'UOWNER'}],['no requester',{requester_slack_id:null}],['already notified',{requester_notified_at:'prior-send'}]])test(`${label} closes without external relay`,async()=>{
  const h=harness({row});await h.run();assert.equal(h.row().state,'cancelled');assert.equal(h.effects.requester.length,0);
});
for(const state of ['awaiting_colleague','in_flight','resolved','cancelled','expired'])test(`state changed during brief to ${state} is not auto-parked or misreported`,async()=>{
  const h=harness({duringOwnerPost:row=>({...row,state})});await h.run();assert.equal(h.row().state,state);assert.equal(h.effects.requester.length,0);
  assert.equal(h.effects.logs.find(([message])=>message==='Morning briefing sent (AI-generated)')[1].auto_parked,0);
});
test('missing fresh row is not reported as auto-parked',async()=>{
  const h=harness({missingRow:true});await h.run();assert.equal(h.effects.requester.length,0);
  assert.equal(h.effects.logs.find(([message])=>message==='Morning briefing sent (AI-generated)')[1].auto_parked,0);
});
for(const [label,options]of [['disappeared',{disappearsAtClose:true}],['already terminal',{terminalAtClose:true}]])test(`closure result ${label} does not send a false stale outcome`,async()=>{
  const h=harness(options);await h.run();assert.equal(h.effects.requester.length,0);
  assert.equal(h.effects.logs.find(([message])=>message==='Morning briefing sent (AI-generated)')[1].auto_parked,0);
});
test('other stale request kinds retain their closure and requester loop',async()=>{
  const h=harness({row:{kind:'reminder'}});await h.run();assert.equal(h.row().state,'cancelled');assert.equal(h.effects.requester.length,1);
});
for(const [label,row]of [['below threshold',{surfaced_count:1}],['waiting on colleague',{state:'awaiting_colleague'}],['scheduled work',{state:'in_flight'}]])test(`${label} remains open without cleanup`,async()=>{
  const h=harness({row});await h.run();assert.equal(h.effects.requester.length,0);assert.equal(h.row().state,row.state||'awaiting_owner');
});
