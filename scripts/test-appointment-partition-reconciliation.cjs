const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),{test}=require('node:test');
const file=path.resolve('scripts/test-classifier-context-participants.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file,'utf8').split('for(const [label,operation,quote,expected]')[0]+'\nmodule.exports={loadClassifier};',file);
const message='Book three meetings: Scott at 11, Adam at 3:30, Paul at 4:30';
const good=[{participants:['Scott'],quote:'Scott at 11'},{participants:['Adam'],quote:'Adam at 3:30'},{participants:['Paul'],quote:'Paul at 4:30'}];
for(const [label,appointments,expected] of [
 ['source-bound appointments',good,true],
 ['fabricated recipient',[...good,{participants:['Alex'],quote:'Scott at 11'}],false],
 ['unbound phrase',good.map(a=>({...a,quote:a.quote+' fabricated'})),false],
 ['malformed participants',[{participants:null,quote:'Scott at 11'},good[1]],false],
]) test('operation routing reconciles '+label,async()=>{
 let calls=0;
 const result=await m.exports.loadClassifier()({profile:{user:{name:'Idan',timezone:'America/New_York'},assistant:{name:'Maelle'},skills:{}},message,senderRole:'colleague',needIntent:false,needScopes:false,needMeetingPeople:true,meetingContextMessages:[],anthropic:{messages:{create:async req=>({stop_reason:'tool_use',content:[{type:'tool_use',name:req.tools[0].name,input:(++calls,({...{meeting_action:'execute',request_relation:'new',meeting_people:['Scott','Adam','Paul'],meeting_people_groups:[['Scott','Adam','Paul']]},meeting_request_route:{route:'E',request_relation:'new',instruction:message,appointments}}))}]})}}});
 assert.equal(calls,1,'one existing classifier call, without a second interpreter');
 assert.equal(result.confirmedAppointmentGroups,expected);
 assert.equal(result.requestUpdate.batch,expected);
 assert.deepEqual(JSON.parse(JSON.stringify(result.meetingPeopleGroups)),expected?[['Scott'],['Adam'],['Paul']]:[['Scott','Adam','Paul']]);
});
