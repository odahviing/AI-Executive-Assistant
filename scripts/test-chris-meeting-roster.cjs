// Real search handler and AST-selected create normalization; fixture I/O only.
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {run}=require('./test-garage-recovery-summary.cjs');
const at=process.argv.indexOf('--source-root'),root=at<0?path.resolve(__dirname,'..'):path.resolve(process.argv[at+1]);
const chris='chris@example.test',paul='paul@example.test',adam='adam@example.test',scott='scott@example.test';
const flat=[chris,paul,adam,scott],groups=[[chris,paul],[chris,adam],[chris,scott]].map(emails=>({emails,unresolvedNames:[]}));
const context={resolvedMeetingAttendees:flat,resolvedMeetingAttendeeGroups:groups};
test('regression Paul search excludes unrelated Adam and Scott while recovering Chris',async()=>{
 const r=await run({clean:true,contextOverride:context,argsOverride:{attendee_emails:[paul]}});
 assert.ok(r.calls.searches.length);for(const call of r.calls.searches)assert.deepEqual([...call.attendeeBusyEmails].sort(),[chris,paul].sort());
});
test('regression ambiguous shared attendee refuses before calendar disclosure',async()=>{
 const r=await run({clean:true,contextOverride:context,argsOverride:{attendee_emails:[chris]}});assert.equal(r.out.error,'ambiguous_meeting_roster');assert.equal(r.calls.searches.length,0);
});
test('regression incomplete producer grouping refuses rather than flattening',async()=>{
 const r=await run({clean:true,contextOverride:{...context,resolvedMeetingAttendeeGroups:[]},argsOverride:{attendee_emails:[paul]}});assert.equal(r.out.error,'ambiguous_meeting_roster');assert.equal(r.calls.searches.length,0);
});
test('control single-meeting known attendee cannot be dropped by partial args',async()=>{
 const r=await run({clean:true,contextOverride:{resolvedMeetingAttendees:[paul,chris],resolvedMeetingAttendeeGroups:[{emails:[paul,chris],unresolvedNames:[]}]},argsOverride:{attendee_emails:[paul]}});assert.ok(r.calls.searches.length);assert.ok(r.calls.searches.every(c=>c.attendeeBusyEmails.includes(chris)));
});
function createRoster(emails,ctx=context){
 const f=fs.readFileSync(path.join(root,'src/skills/meetings/ops/handlers/createMeeting.ts'),'utf8');
 const start=f.indexOf('        const callerNamedAnAttendee ='),end=f.indexOf('        // v4.3.x (gh#165-a / relay-invite gap)',start);assert.ok(start>=0&&end>start);
 const hf=ts.createSourceFile('helpers.ts',fs.readFileSync(path.join(root,'src/skills/meetings/ops/helpers.ts'),'utf8'),ts.ScriptTarget.Latest,true);
 const helper=hf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='meetingScopedAttendees')?.getText()??'';
 const code=helper+'\nexport function run(){'+f.slice(start,end)+'\nreturn attendees;}';
 const module={exports:{}};
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,context:ctx,userEmail:'owner@example.test',getPersonMemory:()=>({email:chris}),attendees:emails.map(email=>({email})),args:{},logger:{info(){}}});
 return JSON.parse(JSON.stringify(module.exports.run()));
}
test('regression create uses the selected meeting roster',()=>{assert.deepEqual(createRoster([paul]).map(a=>a.email).sort(),[paul,chris].sort());});
test('regression create ambiguous roster writes no invite',()=>{assert.equal(createRoster([chris]).error,'ambiguous_meeting_roster');});
test('control create solo block does not acquire any turn attendee',()=>{assert.deepEqual(createRoster([]),[]);});
test('control legacy single roster still recovers missing attendee',()=>{assert.deepEqual(createRoster([paul],{resolvedMeetingAttendees:[paul,chris]}).map(a=>a.email).sort(),[paul,chris].sort());});
module.exports={createRoster};
