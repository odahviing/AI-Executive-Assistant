/* Real coordinator lifecycle consumer; existing request/job/Connection doubles.
 * Optional MAELLE_SPINE_SOURCE_ROOT overlays preserved pre-a2 coordinator only.
 * No provider calls or production state. */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const filename=path.join(__dirname,'test-oof-request-handoff.cjs');
const fixtureModule=new Module(filename,module);fixtureModule.filename=filename;fixtureModule.paths=module.paths;
fixtureModule._compile(fs.readFileSync(filename,'utf8').split("test('R-F2-07")[0]+'\nmodule.exports=fixture;',filename);
const fixture=fixtureModule.exports;
const group=(complete,observed=false)=>[
 {tool:'move_meeting',eventId:'first',ok:true,changed:!observed,operationId:'call_pair',operationComplete:complete},
 {tool:'move_meeting',eventId:'second',ok:complete,changed:complete&&!observed,operationId:'call_pair',operationComplete:complete,reason:complete?undefined:'unconfirmed'},
];
test('O01 partial pair retains linked request and timer, sends no completion',async()=>{
 const h=fixture();await h.finish({mutationActions:group(false),bookingOccurred:false});assert.equal(h.row.state,'awaiting_colleague');assert.ok(h.row.next_check_at);assert.equal(h.effects.updates.length,0);assert.equal(h.effects.sends.length,0);assert.equal(h.effects.events.length,0);
});
test('O02 preserved complete pair closes linked lifecycle and owner notice exactly once',async()=>{
 const h=fixture();await h.finish({mutationActions:group(true)});await h.finish({mutationActions:group(true)});assert.equal(h.row.state,'resolved');assert.equal(h.row.next_check_handler,null);assert.equal(h.effects.sends.length,1);assert.equal(h.effects.events.length,1);assert.match(h.effects.sends[0].body,/acted on it directly/);
});
test('O03 complete observed pair closes without causal mutation claim',async()=>{
 const h=fixture();await h.finish({mutationActions:group(true,true)});assert.equal(h.row.state,'resolved');assert.equal(h.effects.sends.length,1);assert.match(h.effects.sends[0].body,/calendar state is confirmed/);assert.ok(!h.effects.events[0].detail.includes('acted on it'));
});
test('O04 preserved independent successful action is not vetoed by incomplete pair',async()=>{
 const h=fixture();await h.finish({mutationActions:[...group(false),{tool:'create_meeting',eventId:'independent',ok:true,changed:true}],bookingOccurred:true});assert.equal(h.row.state,'resolved');assert.equal(h.effects.sends.length,1);assert.equal(h.effects.events.length,1);
});
test('O05 partial pair cannot borrow a bare booking flag to claim completion',async()=>{
 const h=fixture();await h.finish({mutationActions:group(false),bookingOccurred:true});assert.equal(h.row.state,'awaiting_colleague');assert.equal(h.effects.sends.length,0);assert.ok(h.row.next_check_at);
});
test('O06 preserved independent legacy booking fallback closes with no action tape',async()=>{
 const h=fixture();await h.finish({bookingOccurred:true});assert.equal(h.row.state,'resolved');assert.equal(h.effects.sends.length,1);
});
test('O07 fresh approval transfers incomplete pair to existing tracked work without duplicate owner notice',async()=>{
 const h=fixture({freshApproval:true});await h.finish({mutationActions:group(false)});assert.equal(h.row.state,'resolved');assert.equal(h.effects.sends.length,0);assert.equal(h.effects.events.length,1);assert.match(h.effects.events[0].detail,/fresh approval/);
});
test('O08 singular no-op/reconciled desired state closes without a write claim',async()=>{
 const h=fixture();await h.finish({mutationActions:[{tool:'move_meeting',ok:true,changed:false,eventId:'first'}]});assert.equal(h.row.state,'resolved');assert.match(h.effects.sends[0].body,/calendar state is confirmed/);
});
test('O09 preserved unrelated failed action does not veto completed coordinated group',async()=>{
 const h=fixture();await h.finish({mutationActions:[{tool:'delete_meeting',ok:false,changed:false},...group(true)]});assert.equal(h.row.state,'resolved');assert.equal(h.effects.sends.length,1);
});
