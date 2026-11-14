const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMoveHarness } = require('./test-yael-meeting-selection.cjs');
const { harness: graph } = require('./test-timezone-owner-interval.cjs');
const { run: orchestrate } = require('./test-fallback-held-send-verb.cjs');
const { harness: slack } = require('./test-slack-voice-readiness.cjs');

const zone = 'Asia/Jerusalem';
const at = time => '2026-10-13T' + time + ':00+03:00';
const part = time => ({dateTime: at(time), timeZone: zone});

function scenario(mode, ordinary = false, outsideWindow = false) {
  const start = outsideWindow ? '14:15' : '12:15';
  const end = outsideWindow ? '14:55' : '12:55';
  const args = {meeting_id:'oct11',meeting_subject:'Lunch',new_start:at(start),new_end:at(end),start_is_explicit:true};
  const event = {id:'oct11',type:'singleInstance',subject:'Lunch',attendees:[],isCancelled:false,isAllDay:false,
    start:part(mode === 'unchanged' ? start : '12:00'),end:part(mode === 'unchanged' ? end : '12:25')};
  const operations = {patches:0,ours:0,other:0,reads:0};
  let move;
  const transport = {api(url) {
    assert.match(url,/\/events\/oct11$/);
    return {header(){return this;},select(){return this;},
      async get(){
        operations.reads++;
        if(mode === 'unknown') throw Error('read unavailable');
        return structuredClone(move.events[0]);
      },
      async patch(body){
        operations.patches++;
        if(mode === 'competing') {
          operations.other++;
          Object.assign(move.events[0],{start:part(start),end:part(end)});
        } else if(mode !== 'rejected') {
          operations.ours++;
          Object.assign(move.events[0],{start:body.start,end:body.end});
        }
        if(mode !== 'acknowledged') throw Error('write response unavailable');
      },
    };
  }};
  const h = graph({}, {extraMocks:{
    'src/connectors/graph/graphClient.ts':{getClient:()=>transport},
    'src/connectors/graph/calendarCache.ts':{invalidateCalendarCache(){}},
    'src/config/userProfile.ts':{getProfileByEmail:()=>({user:{slack_user_id:'OWNER'}})},
    'src/db.ts':{auditLog(){}},
  }});
  move = createMoveHarness({owner:true,roster:[],events:[event],args,
    block:ordinary ? undefined : {name:'lunch',duration_minutes:25,preferred_start:'11:30',preferred_end:'13:30'},
    calendar:{updateMeeting:h.load('src/connectors/graph/calendarMutations.ts').updateMeeting,
      verifyApprovedCalendarAction:h.load('src/connectors/graph/calendarReads.ts',true).verifyApprovedCalendarAction}});
  async function deliver() {
    let receipt;
    const turn = await orchestrate([{name:'move_meeting',args,execute:async()=>{receipt=await move.run();return receipt;}}],
      {details:true,text:'Move lunch to the requested interval.'});
    const channel = slack();
    await channel.post({profile:{...move.ctx.context.profile,assistant:{slack:{bot_token:"fixture"}}},result:turn,role:'owner',senderId:'UOWNER',channelId:'D1',threadTs:'1.1',
      history:[],userMessage:'Move lunch to the requested interval.',say:message=>channel.app.client.chat.postMessage(message),
      onDelivered:()=>{channel.s.delivered++;}});
    assert.equal(channel.s.delivered,1);
    assert.equal(channel.s.posts.length,1);
    assert.equal(channel.s.posts[0].text,turn.reply);
    return {receipt,turn,text:channel.s.posts[0].text};
  }
  return {move,operations,deliver};
}

function observed({receipt,turn,text}) {
  assert.equal(receipt.success,true);
  assert.equal(receipt._calendar_verification,'desired_state_observed');
  assert.equal(receipt._write_response_lost,true);
  assert.doesNotMatch(receipt.action_summary,/\bmoved\b|\bresized\b/i);
  assert.match(receipt.action_summary,/read.only|confirm/i);
  assert.match(turn.toolSummaries.join(' '),/OBSERVED/);
  assert.equal(turn.mutationActions[0].changed,false);
  assert.match(text,/already at the requested time/i);
}

for(const ordinary of [false,true]) {
  test((ordinary?'ordinary':'floating')+' acknowledged PATCH keeps causal receipt and delivery',async()=>{
    const h=scenario('acknowledged',ordinary);
    const {receipt,text,turn}=await h.deliver();
    assert.equal(receipt.success,true);
    assert.match(receipt.action_summary,/^Moved /);
    assert.equal(receipt._write_response_lost,undefined);
    assert.equal(turn.mutationActions[0].changed,true);
    assert.match(text,/moved the meeting/i);
    assert.equal(h.operations.ours,1);
  });
  test((ordinary?'ordinary':'floating')+' applied PATCH with lost response only confirms observed state',async()=>{
    const h=scenario('lost',ordinary);
    observed(await h.deliver());
    assert.equal(h.operations.ours,1);
    assert.equal(h.operations.patches,1);
  });
}
test('competing writer supplies the full interval without claiming our update or creating an undo action',async()=>{
  const h=scenario('competing');
  observed(await h.deliver());
  assert.equal(h.operations.ours,0);assert.equal(h.operations.other,1);assert.equal(h.move.state.activities.length,0);
});
test('lost response outside the usual window never leaks a moved-as-asked claim',async()=>{
  const h=scenario('lost',false,true);
  observed(await h.deliver());
});
test('already at requested interval avoids a PATCH and a causal Slack receipt',async()=>{
  const h=scenario('unchanged');
  const {receipt,text}=await h.deliver();
  assert.equal(receipt.unchanged,true);assert.equal(h.operations.patches,0);
  assert.match(text,/already at the requested time/i);
});
test('explicit retry after an observed outcome never replays the PATCH',async()=>{
  const h=scenario('competing');
  const first=await h.deliver();const retry=await h.deliver();
  assert.equal(first.turn.mutationActions[0].changed,false);assert.equal(retry.receipt.unchanged,true);
  assert.equal(h.operations.patches,1);assert.match(retry.text,/already at the requested time/i);
});
for(const [mode,status,reply] of [['rejected','different_state_observed',/didn.t go through/i],['unknown','unavailable',/couldn.t confirm whether/i]]){
  test(mode+' readback gets truthful final delivery without a second PATCH',async()=>{
    const h=scenario(mode);const {receipt,text}=await h.deliver();
    assert.equal(receipt.success,false);assert.equal(receipt._calendar_verification,status);assert.match(text,reply);
    assert.equal(h.operations.patches,1);assert.equal(h.move.state.activities.length,0);assert.equal(h.move.state.closed.length,0);
  });
}
