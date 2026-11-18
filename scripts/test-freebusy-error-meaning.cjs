// Execute the actual Graph response decoder. The wire response is isolated;
// calendar access failure must not manufacture a nonexistent recipient.
const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('node:assert/strict'),{test}=require('node:test');
const source=fs.readFileSync((process.env.FREEBUSY_BEFORE_ROOT?process.env.FREEBUSY_BEFORE_ROOT+'/':'')+'src/connectors/graph/calendarReads.ts','utf8');
const ast=ts.createSourceFile('calendarReads.ts',source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='getFreeBusyImpl');
assert.ok(fn);
async function read(response){
 const module={exports:{}};
 const js=ts.transpileModule(fn.getText()+'\nmodule.exports=getFreeBusyImpl;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module,exports:module.exports,getClient:()=>({api:()=>({post:async()=>response})}),
  logger:{error(){}},parseGraphFreeBusySlot:x=>x});
 return JSON.parse(JSON.stringify(await module.exports('owner@example.test',['peer@example.test'],'2026-11-17T14:00:00','2026-11-17T14:25:00','UTC',25)));
}
for(const responseCode of ['ErrorAccessDenied','5006','ErrorInternalServerError','new_unknown_code'])test(responseCode+' means availability unknown, not invalid recipient',async()=>{
 const r=await read({value:[{scheduleId:'peer@example.test',error:{responseCode}}]});assert.deepEqual(r.unresolved,[]);assert.deepEqual(r.notChecked,['peer@example.test']);assert.equal(r.result['peer@example.test'],undefined);
});
test('a silently omitted schedule is unchecked rather than a nonexistent mailbox',async()=>{const r=await read({value:[]});assert.deepEqual(r.unresolved,[]);assert.deepEqual(r.notChecked,['peer@example.test']);});
for(const responseCode of ['5001','ErrorMailRecipientNotFound','ErrorNonExistentMailbox','ErrorInvalidSmtpAddress'])test('confirmed recipient error remains unresolved: '+responseCode,async()=>{
 const r=await read({value:[{scheduleId:'peer@example.test',error:{responseCode}}]});assert.deepEqual(r.unresolved,['peer@example.test']);assert.deepEqual(r.notChecked,[]);
});
test('a successful empty calendar remains free and a busy calendar keeps its intervals',async()=>{
 for(const scheduleItems of [[],[{start:'2026-11-17T14:00:00Z',end:'2026-11-17T14:25:00Z',status:'busy'}]]){const r=await read({value:[{scheduleId:'peer@example.test',scheduleItems}]});assert.deepEqual(r.unresolved,[]);assert.deepEqual(r.notChecked,[]);assert.deepEqual(r.result['peer@example.test'],scheduleItems);}
});
