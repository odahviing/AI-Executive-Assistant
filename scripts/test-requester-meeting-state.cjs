const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');

function fixture(rows=[],holds=[]){
  const file=path.join(__dirname,'../src/core/orchestrator/requesterMeetingState.ts');
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const deps={
    '../../db/requests':{getOpenRequestsForColleague:()=>rows},
    '../../db/slotHolds':{getActiveSlotHolds:()=>holds},
    '../requests/types':{parseDetails:row=>JSON.parse(row.details_json)},
    '../approvals/approvalCallbacks':{extractCallbacks:d=>d.callbacks??{on_approve:d.deferred_action}},
  };
  const exports={};
  new Function('exports','require',js)(exports,name=>{
    assert.ok(deps[name],name);
    return deps[name];
  });
  return exports.requesterMeetingState;
}
const request={
  owner_user_id:'UOWNER',requester_slack_id:'UPEER',origin_channel:'DPEER',origin_thread_ts:'thread',
  kind:'approval',state:'awaiting_owner',subject:'Interview',terminal_dm_msg_ts:'sent',
  details_json:JSON.stringify({deferred_action:{tool:'create_meeting',args:{start:'2026-12-01T15:00:00Z',end:'2026-12-01T15:25:00Z'}}}),
};
test('the requester sees the exact pending action and confirmed delivery',()=>{
  assert.deepEqual(fixture([request])('UOWNER','UPEER','DPEER','thread'),{
    approvals:[{subject:'Interview',operation:'create_meeting',state:'awaiting_owner',ownerNotificationDelivered:true,
      start:'2026-12-01T15:00:00Z',end:'2026-12-01T15:25:00Z'}],holds:[],
  });
});
test('counter terms replace the original pending time without claiming a booking',()=>{
  const details=JSON.parse(request.details_json);
  details.counter={new_start:'2026-12-02T15:00:00Z',new_end:'2026-12-02T15:25:00Z'};
  const result=fixture([{...request,state:'awaiting_colleague',terminal_dm_msg_ts:null,details_json:JSON.stringify(details)}])('UOWNER','UPEER','DPEER','thread');
  assert.equal(result.approvals[0].start,details.counter.new_start);
  assert.equal(result.approvals[0].state,'awaiting_colleague');
  assert.equal(result.approvals[0].ownerNotificationDelivered,false);
});
test('other people, owners, rooms, terminal requests and unrelated tasks are excluded',()=>{
  const changes=[{requester_slack_id:'UOTHER'},{owner_user_id:'UOTHER'},{kind:'task'},{state:'resolved'},
    {details_json:JSON.stringify({deferred_action:{tool:'send_email',args:{}}})}];
  const state=fixture(changes.map(change=>({...request,...change})));
  assert.deepEqual(state('UOWNER','UPEER','DPEER','thread'),{approvals:[],holds:[]});
  assert.equal(state('UOWNER','UOWNER','DOWNER','thread'),undefined);
  assert.equal(state('UOWNER','UPEER','CROOM','thread'),undefined);
});
test('holds follow the authenticated holder across conversations',()=>{
  const hold={holder_slack_id:'UPEER',origin_channel:'DPEER',origin_thread_ts:'thread',subject:'Interview',
    start_iso:'2026-12-01T15:00:00Z',end_iso:'2026-12-01T15:25:00Z',expires_at:'2026-11-30T15:00:00Z'};
  const state=fixture([],[hold,{...hold,holder_slack_id:'UOTHER'},{...hold,origin_thread_ts:'other'}]);
  assert.deepEqual(state('UOWNER','UPEER','DPEER','thread').holds,[{subject:hold.subject,start:hold.start_iso,end:hold.end_iso,expires:hold.expires_at},{subject:hold.subject,start:hold.start_iso,end:hold.end_iso,expires:hold.expires_at}]);
});


test('a requester can follow the same pending decision from a new private conversation',()=>{
  const state=fixture([{...request,origin_channel:'DOLDER',origin_thread_ts:'older'}]);
  assert.equal(state('UOWNER','UPEER','DPEER','thread').approvals.length,1);
});
