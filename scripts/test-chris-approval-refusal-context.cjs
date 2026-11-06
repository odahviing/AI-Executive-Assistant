const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test');
const filename=path.join(__dirname,'test-skill-context-interactive.cjs');
let src=fs.readFileSync(filename,'utf8').split('for (const [name, extra, expected]')[0].replace('next.inspect?.(context);','next.inspect?.(context,args);');
if(process.argv.includes('--before'))src=src.replace("if (process.env.HANDYMAN_BEFORE && relative === orchestratorPath)","if (relative === orchestratorPath)").replace("fs.readFileSync(process.env.HANDYMAN_BEFORE, 'utf8')","fs.readFileSync(path.join(root,'artifacts/workshop-verification/chris-build-20261103/handyman-approval/before/index.ts'),'utf8')");
const mod={exports:{}};vm.runInNewContext(src+'\nmodule.exports=run;', {require:require('node:module').createRequire(filename),module:mod,exports:mod.exports,__dirname,process,console,structuredClone});
const run=mod.exports;
const action={tool:'create_meeting',args:{subject:'Adam',start:'2026-11-16T15:40:00'}};
const refused={ok:false,violation_label:'Free-time floor',_deferred_action_hint:action};
test('actual refusal bound to auto-attached action, then consumed once',async()=>{
 await run([{name:'create_meeting',args:action.args,result:refused},
  {name:'create_approval',args:{kind:'policy_exception',payload:{}},result:{ok:true},inspect(c,a){assert.deepEqual(JSON.parse(JSON.stringify(c.approvalRefusalReason)),{action,reason:'Free-time floor'});assert.deepEqual(JSON.parse(JSON.stringify(a.payload.deferred_action)),action);}},
  {name:'create_approval',args:{kind:'policy_exception',payload:{}},result:{ok:true},inspect(c){assert.equal(c.approvalRefusalReason,undefined);}}]);
});
test('model-supplied unrelated action cannot inherit actual refusal',async()=>{
 await run([{name:'create_meeting',args:action.args,result:refused},{name:'create_approval',args:{kind:'policy_exception',payload:{deferred_action:{...action,args:{...action.args,subject:'Paul'}},honest_hard_reason:'model guess'}},result:{ok:true},inspect(c){assert.equal(c.approvalRefusalReason,undefined);}}]);
});
test('model payload alone creates no trusted refusal evidence',async()=>{
 await run([{name:'create_approval',args:{kind:'policy_exception',payload:{deferred_action:action,honest_hard_reason:'model guess'}},result:{ok:true},inspect(c){assert.equal(c.approvalRefusalReason,undefined);}}]);
});
test('refusal with no actual label cannot reuse prior label',async()=>{
 await run([{name:'create_meeting',args:action.args,result:refused},{name:'create_meeting',args:{...action.args,subject:'Paul'},result:{ok:false,_deferred_action_hint:{...action,args:{...action.args,subject:'Paul'}}}},{name:'create_approval',args:{kind:'policy_exception',payload:{}},result:{ok:true},inspect(c){assert.equal(c.approvalRefusalReason,undefined);}}]);
});

