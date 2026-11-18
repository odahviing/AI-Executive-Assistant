const fs=require('fs'),path=require('path'),Module=require('module'),assert=require('node:assert/strict'),{test}=require('node:test');
const scripts=path.join(process.cwd(),'scripts');
function load(file,cut,tail,transform=x=>x){const p=path.join(scripts,file),m=new Module(p,module);m.filename=p;m.paths=Module._nodeModulePaths(scripts);m._compile(transform(fs.readFileSync(p,'utf8').split(cut)[0])+tail,p);return m.exports;}
const {harness,profile}=load('test-gatekeeper-join-summary-action.cjs','for(const [id,extra]','\nmodule.exports={harness,profile};');
const {fixture}=load('test-turn-context-boundaries.cjs',"test('room framing",'\nmodule.exports={fixture};',s=>{const a=s.indexOf('for(const operations'),b=s.indexOf('function fixture');return a>=0?s.slice(0,a)+s.slice(b):s;});
test('refusal retains the checked human reason for the next turn and checker',()=>{
 const summary=harness().turn.summarizeToolCall('create_meeting',{subject:'Weekly'},{success:false,error:'rule_violation',violation_label:'Daniel and Einav are busy',_attendee_busy_note:'Daniel and Einav are busy'},profile.user.timezone);
 assert.match(summary,/Daniel and Einav are busy/);assert.doesNotMatch(summary,/mutated=/);
});
test('approval identity does not spread an outbound message body into history',()=>{
 const summary=harness().turn.summarizeToolCall('resolve_approval',{}, {ok:true,request_context:{subject:'Post',requester:{name:'Oran',email:'oran@example.test'},action:{tool:'message_colleague',args:{colleague_name:'Oran',message:'PRIVATE CALLBACK BODY'}}}},profile.user.timezone);
 assert.match(summary,/Oran/);assert.doesNotMatch(summary,/PRIVATE CALLBACK BODY/);
});
test('a writing followup does not inject old calendar listings or a calendar instruction',async t=>{
 const f=fixture(t);f.state.classifierExtras={scope:{scopes:['knowledge'],source:'classifier'},calendarOperations:[]};
 f.state.viewedEvents=[{eventId:'event-private-long',subject:'Old appointment that is not the writing task',dateIso:'2026-11-16'}];
 const r=await f.run({userMessage:'Where did the three points in your draft come from?',typedUserMessage:'Where did the three points in your draft come from?'});
 const prompt=r.systemBlocks.map(b=>b.text).join('\n');
 assert.doesNotMatch(prompt,/Old appointment that is not the writing task/);assert.doesNotMatch(prompt,/Current direct calendar instructions/);
});
