const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),{test}=require('node:test');
const file=path.resolve('scripts/test-classifier-context-participants.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file,'utf8').split('for(const [label,operation,quote,expected]')[0]+'\nmodule.exports={loadClassifier};',file);
for(const previous of [undefined,{original:'Move PPC',updates:[],participantGroups:[['Onn']]}])test('labelled mailbox in a new request reaches binding validation: '+!!previous,async()=>{
 const message='Book Branding with Einav and Tal <mailto:tal4980@gmail.com|tal4980@gmail.com>';
 const correction={group:0,from:'Tal',to:'tal4980@gmail.com',quote:'Tal <mailto:tal4980@gmail.com|tal4980@gmail.com>'};let captured;
 const result=await m.exports.loadClassifier()({profile:{user:{name:'Idan',timezone:'America/New_York'},assistant:{name:'Maelle'},skills:{}},message,senderRole:'owner',needIntent:false,needScopes:false,needMeetingPeople:true,meetingContextMessages:[],priorMeetingRequest:previous,anthropic:{messages:{create:async req=>{captured=req;return {stop_reason:'tool_use',content:[{type:'tool_use',name:'classify_turn',input:{meeting_action:'execute',request_relation:'new',meeting_people:['Einav','Tal','tal4980@gmail.com'],meeting_people_groups:[['Einav','Tal']],participant_corrections:[correction]}}]};}}}});
 assert.deepEqual(JSON.parse(JSON.stringify(result.participantCorrections)),[correction]);assert.ok(captured.tools[0].input_schema.required.includes('participant_corrections'));
});
test('a labelled new member of a continuing request retains the supplied mailbox',async()=>{
 const message='Add Joshua <joshua@example.test> to the interview with Leor';
 const correction={group:0,from:'Joshua',to:'joshua@example.test',quote:'Joshua <joshua@example.test>'};
 const result=await m.exports.loadClassifier()({profile:{user:{name:'Idan',timezone:'America/New_York'},assistant:{name:'Maelle'},skills:{}},message,senderRole:'owner',needIntent:false,needScopes:false,needMeetingPeople:true,meetingContextMessages:[],priorMeetingRequest:{original:'Interview with Leor',updates:[],participantGroups:[['Leor']]},anthropic:{messages:{create:async()=>({stop_reason:'tool_use',content:[{type:'tool_use',name:'classify_turn',input:{meeting_action:'execute',request_relation:'continue',meeting_people:['Leor','Joshua','joshua@example.test'],meeting_people_groups:[['Leor','Joshua']],participant_corrections:[correction]}}]})}}});
 assert.deepEqual(JSON.parse(JSON.stringify(result.participantCorrections)),[correction]);
});
test('a malformed correction quote cannot abort the entire classifier result',async()=>{
 const result=await m.exports.loadClassifier()({profile:{user:{name:'Idan',timezone:'America/New_York'},assistant:{name:'Maelle'},skills:{}},message:'Book Joshua <joshua@example.test>',senderRole:'owner',needIntent:false,needScopes:false,needMeetingPeople:true,meetingContextMessages:[],anthropic:{messages:{create:async()=>({stop_reason:'tool_use',content:[{type:'tool_use',name:'classify_turn',input:{meeting_action:'execute',request_relation:'new',meeting_people:['Joshua'],meeting_people_groups:[['Joshua']],participant_corrections:[{group:0,from:'Joshua',to:'joshua@example.test',quote:7}]}}]})}}});
 assert.equal(result.requestUpdate.relation,'new');assert.deepEqual(result.participantCorrections,[]);
});
