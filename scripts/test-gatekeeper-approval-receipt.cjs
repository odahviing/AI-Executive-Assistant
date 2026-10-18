// Real summaries and output/checker modules; controlled model outputs prove
// receipt transport and guard routing, never semantic model obedience.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),{test}=require('node:test');
function fixture(flag=false){const file=path.resolve('scripts/test-gatekeeper-join-summary-action.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));let s=fs.readFileSync(file,'utf8').split('for(const [id,extra]')[0];if(flag)s=s.replace('if(human){',"if(req.tools?.[0]?.input_schema?.properties?.verdict){return {stop_reason:'tool_use',content:[{type:'tool_use',name:'verdict',input:{verdict:'keep'}}]};}if(human){").replace('{claimed_action:false,action_type:null,action_summary:null,target_name:null}',"{claimed_action:true,action_type:'message',claim_specifics_mismatch:false,action_summary:'Fixture flags a notification claim',target_name:'Unrelated Person'}");m._compile(s+'\nmodule.exports={harness,ctx,profile};',file);return m.exports;}
const {harness,ctx,profile}=fixture(),{harness:flagHarness}=fixture(true);
const base={ok:true,state:'cancelled',effect:'rejected; linked work cancelled'};
const summary=(h,r)=>h.turn.summarizeToolCall('resolve_approval',{approval_id:'req_fixture'},r,profile.user.timezone);
const owner={senderId:'UOWNER',role:'owner'};
for(const outcome of ['sent','failed','no_requester',undefined,'unexpected'])for(const kind of ['reject','replay','noop','unresolved','error','coordinated'])test(`receipt-${kind}-${String(outcome)}`,()=>{
 const h=harness(),r={...base,requester_notify_outcome:outcome,...({replay:{action_summary:'Moved the meeting.'},noop:{effect:'approved (no replay)'},unresolved:{ok:false,reason:'already terminal'},error:{ok:false,error:'unavailable'},coordinated:{outcomes:[],remaining:[]}}[kind]??{})},s=summary(h,r);
 const expected=outcome==='sent'?'sent — requester notified (relay confirmed)':outcome==='failed'?'failed — requester NOT notified':outcome==='no_requester'?'no_requester — no requester to notify':'unknown — requester delivery not confirmed';
 assert.ok(s.includes('[resolve_approval requester notification: '+expected),s);assert.ok(!s.includes('mutated=message'));
 if(r.ok===false)assert.ok(!s.includes('resolve_approval OK'));if(kind==='noop')assert.ok(s.includes('NO calendar change'));if(kind==='replay')assert.ok(s.includes('replayed the approved action'));
});
for(const history of [false,true])for(const outcome of ['sent','failed','no_requester',undefined])test(`checker-${history?'restart-history':'current'}-${String(outcome)}`,async()=>{
 const h=harness(),s=summary(h,{...base,requester_notify_outcome:outcome}),extra=history?{...owner,result:{toolSummaries:[]},history:[{role:'assistant',content:s+'\nPrevious response.'}]}:owner;
 await h.gates.runOutputGates('The decision is recorded; this is the requester notification status.',ctx(s,extra));
 const prompts=h.calls.filter(c=>!c.tools).map(c=>c.messages[0].content);
 assert.ok(prompts.some(p=>p.includes((history?'(earlier turn) ':'')+'[resolve_approval requester notification:')),JSON.stringify(prompts));
 assert.ok(prompts.some(p=>p.includes('missing receipt do NOT confirm delivery')));
});
test('preserved-failed-delivery-is-notified-false',()=>{const s=summary(harness(),{...base,requester_notify_outcome:'failed'});assert.ok(s.includes('requester NOT notified'));assert.ok(!s.includes('mutated=message'));});
test('preserved-noop-cannot-ground-calendar-write',()=>{const s=summary(harness(),{...base,effect:'approved (no replay)'});assert.ok(s.includes('NO calendar change'));assert.ok(!s.includes('mutated=book'));});
for(const outcome of ['sent','failed','no_requester',undefined])test('preserved-no-blanket-message-shield-'+String(outcome),async()=>{const h=flagHarness(),s=summary(h,{...base,requester_notify_outcome:outcome});await h.gates.runOutputGates('I sent Unrelated Person a different message.',ctx(s,owner));assert.ok(h.calls.some(c=>c.tools?.[0]?.input_schema?.properties?.verdict),'flagged unrelated recipient must reach existing rewrite');});
test('preserved-non-approval-summary-identical',()=>{assert.equal(harness().turn.summarizeToolCall('create_task',{}, {success:true},profile.user.timezone),'[create_task] mutated=task');});
