// Actual summary and final output pipeline, with independent controlled verdicts.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),{test}=require('node:test');
const file=path.resolve('scripts/test-gatekeeper-booking-claim.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file,'utf8').split("const draft=")[0]+'\nmodule.exports={harness,ctx,profile};',file);
const {harness,ctx,profile}=m.exports;
test('approved completed booking carries the same calendar mutation receipt as direct booking',()=>{
 const h=harness();const s=h.turn.summarizeToolCall('resolve_approval',{}, {ok:true,booked:true,action_summary:'Booked the meeting at 10:00.',requester_notify_outcome:'sent'},profile.user.timezone);
 assert.match(s,/mutated=book/);assert.match(s,/requester notified/);
 for(const r of [{ok:true,state:'resolved'},{ok:false,booked:true,error:'unconfirmed'},{ok:true,booked:false}])assert.doesNotMatch(h.turn.summarizeToolCall('resolve_approval',{},r,profile.user.timezone),/mutated=book/);
});
for(const [falseClause,rest]of [['Idan is free at 13:30. ','I sent him the approval request. I will update you when he answers.'],['עידן פנוי ב-13:30. ','שלחתי לעידן בקשת אישור. אעדכן כשיענה.']])test('calendar veto preserves a delivered approval in '+rest,async()=>{
 const h=harness({claim:{claimed_action:true,action_type:'ungrounded_slot_claim',claim_quote:falseClause.trim(),fact_subject:'owner'},
  factualVeto:{verdict:'rewrite',remove_clauses:[{sentence:0,quote:falseClause}],removal_verified:true}});
 const receipts=['[find_available_slots candidate_validation: 13:30 unavailable owner_available=false]', '[create_approval: kind=policy_exception] mutated=task notified=approval_owner'];
 const result=await h.gates.runOutputGates(falseClause+rest,ctx('',{result:{toolSummaries:receipts}}));
 assert.equal(result,rest);
 const veto=h.calls.find(c=>c.tools?.[0]?.input_schema?.properties?.remove_clauses);assert.ok(veto,'existing veto is deletion-only');
 assert.ok(veto.messages[0].content.includes(receipts[1]));
});

test('a false exclusivity modifier can be removed without losing the verified slot and next step',async()=>{
 const draft='מחר יש רק חלון אחד שבו כולם פנויים, באורך 40 דקות. רוצה שאקבע?';
 const h=harness({claim:{claimed_action:true,action_type:'ungrounded_slot_claim',claim_quote:'רק חלון אחד',fact_subject:'owner'},
  factualVeto:{verdict:'rewrite',remove_clauses:[{sentence:0,quote:'רק חלון אחד שבו',retain:'חלון שבו'}],removal_verified:true}});
 const result=await h.gates.runOutputGates(draft,ctx('',{result:{toolSummaries:['[find_available_slots 2026-10-22 dur=40m → 1 slots: 11:45]']}}));
 assert.equal(result,'מחר יש חלון שבו כולם פנויים, באורך 40 דקות. רוצה שאקבע?',JSON.stringify(h.calls.filter(c=>c.tools?.[0]?.input_schema?.properties?.remove_clauses).map(c=>c.messages[0].content.slice(-650))));
});
for(const retain of ['a meeting at 14:30','only two slots'])test('bounded calendar prose repair cannot insert or reorder new facts: '+retain,async()=>{
 const draft='There is only one slot at 11:45. Shall I book it?';
 const h=harness({claim:{claimed_action:true,action_type:'ungrounded_slot_claim',claim_quote:'only one slot',fact_subject:'owner'},
  factualVeto:{verdict:'rewrite',remove_clauses:[{sentence:0,quote:'only one slot',retain}],removal_verified:true}});
 const result=await h.gates.runOutputGates(draft,ctx('',{result:{toolSummaries:['[find_available_slots 2026-10-22 dur=40m → 1 slots: 11:45]']}}));
 assert.ok(!result.includes(retain));
});
