// Joined contract, not a model-obedience test. Current owner input and pending
// identity reach the real prompt. The replacement callback is explicitly chosen
// by this fixture. Its actual outreach result crosses executor, lifecycle, task
// result, canonical summary and checker boundaries without a fabricated receipt.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),before=process.argv.includes('--joint-before');
const captures=[],out=process.env.ORAN_JOINT_CAPTURE;
function loadFixture(file,source,exports,processOverride=process){const m={exports:{}},baseRequire=createRequire(path.join(__dirname,file));const req=Object.assign(name=>name==='node:test'?{test(){}}:baseRequire(name),{resolve:baseRequire.resolve});vm.runInNewContext('(function(require,module,exports,__dirname){'+source+'\nmodule.exports={'+exports+'};})',{console,process:processOverride,Date,Map,Set,Buffer,setTimeout,clearTimeout,setImmediate})(req,m,m.exports,__dirname);return m.exports;}
let replay=fs.readFileSync(path.join(__dirname,'test-approved-outreach-uncertainty.cjs'),'utf8').split('const action =')[0];
replay=replay.replace("process.argv.includes('--before')","process.argv.includes('--joint-before')");
const taskHook="fixtureSource = fixtureSource.replace(hook,";
assert.equal(replay.split(taskHook).length,2);
replay=replay.replace(taskHook,"fixtureSource = fixtureSource.replace('tools:()=>', `taskResolve:(args)=>new(load('src/tasks/skill.ts').TasksSkill)().executeToolCall('resolve_approval',args,{profile,userId:'OWNER',authority:'owner',senderRole:'owner',surface:'owner_dm',channel:'slack',channelId:'DOWNER',threadTs:'owner.root'}),tools:()=>`);\n"+taskHook);
const processForReplay={...process,env:{...process.env,...(before?{MAELLE_BOUNCE_SOURCE_ROOT:path.join(root,'artifacts/workshop-verification/minor-5.2.0/registrar/before')}:{})}};
const {approved,harness}=loadFixture('test-approved-outreach-uncertainty.cjs',replay,'approved,harness',processForReplay);
const {fixture:outreach}=require('./fixtures/outreach-original-request.cjs');
const {fixture:gate}=loadFixture('test-gatekeeper-owner-decision-scope.cjs',fs.readFileSync(path.join(__dirname,'test-gatekeeper-owner-decision-scope.cjs'),'utf8'),'fixture');
let context=fs.readFileSync(path.join(__dirname,'test-turn-context-boundaries.cjs'),'utf8').replace("const before = process.argv.includes('--before');",'const before = false;').replace('getAwaitingOwnerRequests: () => []','getAwaitingOwnerRequests: () => state.pending || []').replace('parseDetails: () => null','parseDetails: r => r.details || null');
const {fixture:prompt}=loadFixture('test-turn-context-boundaries.cjs',context,'fixture');
const registration='https://registration.example.test/webinar',published='https://post.example.test/published';
const current=`Published post ${published} — send this to the requester.`;
const oldQuestion=`Draft a post for tomorrow; registration is ${registration}`;
for(const mode of ['success','failed','unknown','throw','wrong-payload'])test('joined current artifact '+mode,async t=>{
 const p=prompt(t);p.state.pending=[{id:'req_current',kind:'approval',subkind:'freeform',subject:'Oran post',created_at:'2026-09-19 09:00:00',details:{question:oldQuestion}}];
 const input=await p.run({userMessage:current});
 assert.equal(input.messages.at(-1).content,current);assert.ok(input.prompt.includes(registration));
 assert.ok(input.prompt.includes('take the action and content from the current owner decision'));
 // Controlled semantic selection. Deliberately wrong selection is also tested:
 // successful transport must not be reported as content verification.
 const message=mode==='wrong-payload'?`Publish tomorrow; register at ${published}`:`Published post: ${published}\nWebinar registration: ${registration}`;
 const action={tool:'message_colleague',args:{colleague_slack_id:'COLLEAGUE',colleague_name:'Oran',message,await_reply:false}};
 const args={approval_id:'req_current',verdict:'approve',data:action};
 const outbound=outreach({mode:mode==='wrong-payload'?'success':mode});t.after(()=>outbound.db.close());
 let producer,normalized;
 const execute=approved(async(tool,selected,ctx)=>{assert.equal(tool,'message_colleague');producer=await outbound.tool(selected,ctx);return producer;});
 const h=harness({execute:async(...a)=>normalized=await execute(...a),row:{subkind:'freeform',subject:'Oran post',requester_name:'Oran',details_json:JSON.stringify({question:oldQuestion}),created_at:'2026-10-19 11:03:53'}});
 const result=await h.taskResolve(args);
 assert.equal(outbound.effects.sends.length,1);assert.equal(outbound.effects.sends[0].body,message);
 assert.deepEqual(JSON.parse(JSON.stringify(h.effects.executes[0].args)),{...action.args,_fulfilling_request_id:'req_current'});
 assert.deepEqual(JSON.parse(h.row().details_json).deferred_action,action);
 const unconfirmed=['unknown','throw'].includes(mode),failed=mode==='failed';
 if(unconfirmed){assert.equal(producer.delivery_unconfirmed,true);assert.equal(normalized.result.error,'approved_action_unconfirmed');assert.equal(result.ok,false);assert.equal(result.effect,'approve_replay_unconfirmed');assert.equal(h.row().state,'resolved');assert.equal(h.row().closure_reason,'approved_action_attempted_unconfirmed');assert.equal(result.action_summary,undefined);assert.ok(h.effects.owner.length>0,'owner hears uncertainty');}
 else if(failed){assert.equal(normalized.result.error,'not_attempted');assert.equal(result.ok,false);assert.equal(result.requester_notified,false);assert.equal(h.row().state,'awaiting_owner');assert.equal(h.effects.sends.length,0);}
 else {assert.equal(producer.sent,true);assert.equal(result.ok,true);assert.equal(result.requester_notified,true);assert.equal(result.action_summary,'Message delivered to Oran.');assert.ok(h.row().requester_notified_at);assert.equal(h.effects.sends.length,0,'confirmed action itself closes requester loop');}
 // Both the exact persisted current row and unrelated same-day approval enter
 // the real SQL query. Only the current actual task result enters its summary.
 const claim=failed||unconfirmed?{claimed_action:true,action_type:'message',target_name:'Oran',claim_specifics_mismatch:false}:{claimed_action:false,action_type:null};
 const g=gate({rows:[h.row(),{id:'req_unrelated',owner_user_id:'OWNER',owner_dm_thread_ts:'owner.root',subject:'Unrelated approved ask'}],claim});
 try{
  const summary=g.turn.summarizeToolCall('resolve_approval',args,result,'UTC');
  const draft=failed||unconfirmed?'The request is recorded. I sent it to Oran.':'Message delivered to Oran.';
  const reply=await g.run({profile:outbound.profile,senderId:'OWNER',threadTs:'owner.root',userMessage:current,result:{toolSummaries:[summary]}},draft);
  assert.equal(g.queries[0][2],'DOWNER');
  const truth=g.contexts().find(s=>s.includes('AUTHORITATIVE REQUEST OUTCOMES'));
  assert.ok(truth.includes('Oran post'));assert.ok(truth.includes('Unrelated approved ask'));assert.ok(truth.includes('"completionConfirmed":false'));assert.ok(!truth.includes(message),'private callback not projected');
  if(failed||unconfirmed){assert.ok(!summary.includes('mutated='));assert.equal(reply,'The request is recorded.','unrelated approval cannot shield current failure');}
  else assert.equal(reply,draft);
  captures.push({mode,input:input.messages.at(-1),oldQuestion,controlledAction:action,producer,normalized,result,summary,requestRow:h.row(),outreachRows:outbound.rows(),requesterNotices:h.effects.sends,ownerNotices:h.effects.owner,checkerContext:truth,reply});
 }finally{g.close();if(out)fs.writeFileSync(out,JSON.stringify(captures,null,2));}
 if(failed){outbound.options.mode='success';await h.taskResolve(args);assert.equal(outbound.effects.sends.length,2,'definite non-attempt permits explicit retry');}
 else {await h.taskResolve(args);await h.sweep();const restarted=harness({row:JSON.parse(JSON.stringify(h.row())),execute});await restarted.taskResolve(args);await restarted.sweep();restarted.check();assert.equal(outbound.effects.sends.length,1,'terminal state prevents replay after restart');assert.equal(h.effects.sends.length,unconfirmed?1:0,'no second requester close-loop');}
 h.check();assert.deepEqual(outbound.effects.unexpected,[]);
});
