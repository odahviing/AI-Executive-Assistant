// Actual SQL request scoping and complete output gates; model verdict is controlled.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),{test}=require('node:test');
const file=path.resolve('scripts/test-gatekeeper-owner-decision-scope.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file,'utf8').split('for(const threadTs')[0]+'\nmodule.exports={fixture,baseRow};',file);
const {fixture,baseRow}=m.exports;
const receipt={request_id:'req_weekly',state:'resolved',effect:'approve_replay_unconfirmed',requester_notice:'action_unconfirmed',requester_notify_outcome:'sent'};
const row={...baseRow,id:receipt.request_id,subject:'Daniel weekly',outcome_json:JSON.stringify({approved:true,replayed:'update_meeting',verified:false})};
for(const delivered of [true,false])test('a false approval verdict preserves the actual recorded decision and unconfirmed change: '+delivered,async()=>{
 const h=fixture({rows:[row],claim:{claimed_action:true,action_type:'permission_granted',claim_quote:'I recorded your approval.'}});
 try{
 const reply=await h.run({result:{toolSummaries:['[resolve_approval — owner approval recorded; action attempted, completion UNCONFIRMED]'],approvalOutcomes:[{...receipt,requester_notify_outcome:delivered?'sent':'failed'}]}},'I recorded your approval. The change is unconfirmed.');
 assert.match(reply,/Your approval for “Daniel weekly” was recorded/);assert.match(reply,/couldn.t verify the change/);
 assert.equal(reply.includes('I told the requester'),delivered);assert.doesNotMatch(reply,/I don.t have confirmed information/);
 }finally{h.close()}
});
for(const [name,extra]of [['different outcome',{result:{toolSummaries:[],approvalOutcomes:[{...receipt,request_id:'req_other'}]}}],['different surface',{channelId:'DOTHER',result:{toolSummaries:[],approvalOutcomes:[receipt]}}]])test('an unrelated unconfirmed action cannot supply the owner fallback: '+name,async()=>{
 const h=fixture({rows:[row],claim:{claimed_action:true,action_type:'permission_granted',claim_quote:'Idan approved.'}});
 try{const reply=await h.run(extra,'Idan approved.');assert.ok(!reply.includes('Daniel weekly'));}finally{h.close()}
});
