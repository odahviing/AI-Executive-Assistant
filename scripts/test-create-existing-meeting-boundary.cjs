// Entire real create handler. The early boundary must refuse before any read or write.
const fs=require('fs'),path=require('path'),vm=require('vm'),ts=require('typescript'),assert=require('node:assert/strict'),{test}=require('node:test');
const file=path.join(__dirname,'../src/skills/meetings/ops/handlers/createMeeting.ts');
const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
const fn=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='handleCreateMeeting');
function handler(){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fn.getText(tree),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {module,exports:module.exports,viewerEmailFor:()=>undefined,isDescriptiveSubject:s=>typeof s==='string'&&s.length>3,logger:{warn(){}}});return module.exports.handleCreateMeeting;}
for(const authority of ['owner','colleague'])for(const id of [undefined,'verified-event'])test('an existing '+authority+' request cannot create a second invitation: '+id,async()=>{
 const result=await handler()({subject:'Known existing meeting'},{context:{authority,requestExistingMeeting:true,requestMovingEventId:id},timezone:'UTC'});
 assert.equal(result.error,'existing_meeting_requires_move');assert.equal(result.existing_event_id,id);
});
for(const context of [{},{requestExistingMeeting:true,approvedBookingAttendeeEmails:[]}])test('ordinary new creation and exact approved creation reach normal validation: '+JSON.stringify(context),async()=>{
 const result=await handler()({subject:''},{context:{...context,profile:{user:{slack_user_id:'OWNER'}}},timezone:'UTC'});
 assert.notEqual(result.error,'existing_meeting_requires_move');
});
