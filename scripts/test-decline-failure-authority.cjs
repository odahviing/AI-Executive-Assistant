const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const file='src/connectors/graph/calendarMutations.ts',source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.ES2022,true);
const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='declineMeeting');
const code=ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
async function decline(failure,retained=false){
 const actions=[],exports={};
 const env={exports,require:()=>({invalidateCalendarCache(){}}),logger:{warn(){}},getClient:()=>({api:url=>({post:async body=>{actions.push({url,body});if(failure)throw failure;},delete:async()=>actions.push({url,deleted:true})})}),verifyEventDeleted:async()=>!retained,deleteMeeting:async()=>{actions.push({cancel:true});return {cancellationSent:true}}};
 vm.runInNewContext(code,env,{filename:file});let result,error;
 try{result=await exports.declineMeeting('owner@example.test','occurrence',{comment:'Cannot attend this occurrence'});}catch(e){error=e;}
 return {actions,result,error};
}
for(const statusCode of [400,401,403,429,500,503])test('failed decline '+statusCode+' never cancels or deletes the meeting',async()=>{
 const err=Object.assign(Error('decline rejected'),{statusCode}),r=await decline(err);
 assert.equal(r.error,err);assert.equal(r.result,undefined);assert.equal(r.actions.length,1);assert.match(r.actions[0].url,/\/decline$/);
});
test('successful decline sends the response only to the organizer',async()=>{
 const r=await decline();assert.equal(r.error,undefined);assert.equal(r.result.notified,'organizer');assert.equal(r.actions.length,1);assert.equal(r.actions[0].body.SendResponse,true);
});
test('a retained copy is removed only after successful decline',async()=>{
 const r=await decline(undefined,true);assert.equal(r.result.notified,'organizer');assert.equal(r.actions.length,2);assert.equal(r.actions[1].deleted,true);assert.ok(!r.actions.some(x=>x.cancel));
});
