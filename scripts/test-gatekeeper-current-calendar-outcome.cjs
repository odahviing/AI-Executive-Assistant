// Real calendar result summaries and checker/gate modules; synthetic semantic flags.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),{test}=require('node:test');
const file=path.resolve('scripts/test-gatekeeper-booking-claim.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const s=fs.readFileSync(file,'utf8').split('const draft=')[0].replace("req.messages[0].content.includes('You audit a draft reply an executive assistant')",'true');m._compile(s+'\nmodule.exports={harness,ctx,profile};',file);const {harness,ctx,profile}=m.exports;
const draft='I booked it for you as requested.';
const claim={claimed_action:true,action_type:'book',target_name:null,claim_specifics_mismatch:false};
const tools=['create_meeting','move_meeting','update_meeting','delete_meeting','book_floating_block'];
const audiences=[['colleague',{}],['owner',{senderId:'UOWNER',role:'owner'}]];
const receipt=(h,tool,result)=>h.turn.summarizeToolCall(tool,{subject:'Meeting'},result,profile.user.timezone);
for(const tool of tools)for(const [audience,extra] of audiences){
 for(const [state,result] of [['failed',{error:'unavailable'}],['unknown',{status:'pending'}]])test(`${tool}-${state}-${audience}-supersedes-prior-success`,async()=>{
 const h=harness({claim}),prior=receipt(h,'create_meeting',{success:true,event_id:'old',action_summary:'Booked old meeting'}),current=receipt(h,tool,result);assert.ok(!current.includes('mutated=book'),current);const out=await h.gates.runOutputGates(draft,ctx(current,{...extra,history:[{role:'assistant',content:prior,toolSummaries:[prior]}]}));if(audience==='owner') assert.ok(h.calls.some(c=>c.tools?.[0]?.input_schema?.properties?.verdict),'owner unsupported claim must reach existing veto rewrite'); else assert.notEqual(out,draft,`${current} must not borrow ${prior}`);
 });
 test(`${tool}-${audience}-legitimate-recap`,async()=>{const h=harness({claim}),prior=receipt(h,tool,{success:true,event_id:'old',action_summary:'Completed meeting operation'});assert.ok(prior.includes('mutated=book'),prior);assert.equal(await h.gates.runOutputGates(draft,ctx('',{...extra,result:{toolSummaries:[]},history:[{role:'assistant',content:prior,toolSummaries:[prior]}]})),draft);});
}
