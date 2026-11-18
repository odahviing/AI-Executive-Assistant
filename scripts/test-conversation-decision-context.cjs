const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),{test}=require('node:test');
const file=path.resolve('scripts/test-turn-context-boundaries.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
let fixtureSource=fs.readFileSync(file,'utf8').split("test('room framing")[0];
if(process.env.DECISION_CONTEXT_BEFORE_ROOT)fixtureSource=fixtureSource.replace("fs.readFileSync(path.join(root, file), 'utf8')","fs.readFileSync(fs.existsSync(path.join(process.env.DECISION_CONTEXT_BEFORE_ROOT,file))?path.join(process.env.DECISION_CONTEXT_BEFORE_ROOT,file):path.join(root,file),'utf8')");
m._compile(fixtureSource+'\nmodule.exports={fixture};',file);
const {fixture}=m.exports;

test('a source-bound appointment partition repairs a flattened continuing roster',async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.state.meetingPeople=['Scott','Adam','Paul'];
 f.state.requestUpdate={relation:'continue',batch:true};
 f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:true,confirmedAppointmentGroups:true,meetingPeopleGroups:[['Scott'],['Adam'],['Paul']]};
 const previous={ownerId:'UOWNER',requesterId:'UOWNER',channelId:'D1',threadTs:'T1',requestId:'three',original:'Scott at 11, Adam at 3:30, Paul at 4:30',updates:[],batch:false,participantGroups:[['Scott','Adam','Paul']]};
 const r=await f.run({userMessage:previous.original,typedUserMessage:previous.original,priorMeetingState:previous});
 assert.deepEqual(JSON.parse(JSON.stringify(r.meetingRequest.participantGroups)),[['Scott'],['Adam'],['Paul']]);
 assert.equal(r.meetingRequest.batch,true);
});

test('one quoted day gives search and required-day checks the same absolute date',async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];
 f.state.requestUpdate={relation:'new',searchDay:{date:'2030-12-03',quote:'on Tuesday'},dayChange:{date:'tomorrow',quote:'Tuesday'}};
 const r=await f.run({userMessage:'Book on Tuesday',typedUserMessage:'Book on Tuesday'});
 assert.equal(r.meetingRequest.searchDay.date,'2030-12-03');
 assert.equal(r.meetingRequest.requiredDay.date,'2030-12-03');
});

test('different quoted days retain their own search and required-date meanings',async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];
 f.state.requestUpdate={relation:'new',searchDay:{date:'2030-12-03',quote:'Tuesday'},dayChange:{date:'2030-12-05',quote:'Thursday'}};
 const r=await f.run({userMessage:'Check Tuesday, with Thursday required for the booking',typedUserMessage:'Check Tuesday, with Thursday required for the booking'});
 assert.equal(r.meetingRequest.searchDay.date,'2030-12-03');
 assert.equal(r.meetingRequest.requiredDay.date,'2030-12-05');
});

for(const confirmed of [true,false])test('an instructed correction can reconcile the same confirmed invitation: '+confirmed,async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.state.toolNames=['create_meeting','move_meeting','update_meeting'];
 f.state.requestUpdate={relation:'continue'};
 f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:true,meetingAction:'execute',calendarOperations:[{operation:'create',quote:'Book it at the time I asked for.'}]};
 const previous={ownerId:'UOWNER',requesterId:'UOWNER',channelId:'D1',threadTs:'T1',requestId:'adam',original:'Book Adam at 15:40',updates:[],batch:false,hasConfirmedBooking:confirmed};
 const r=await f.run({userMessage:'Book it at the time I asked for.',typedUserMessage:'Book it at the time I asked for.',conversationHistory:[{role:'assistant',content:confirmed?'Booked at 15:45.':'Not booked.',toolSummaries:[],meetingRequest:previous}]});
 assert.equal(r.tools.some(tool=>tool.name==='move_meeting'),confirmed);assert.equal(r.tools.some(tool=>tool.name==='update_meeting'),confirmed);
});
test('an unanswered question survives an intervening reply and remains available to classify the answer',async t=>{
 const f=fixture(t),question='Which category should I give the PHP2Shell debrief?';
 const earlier='The other calendar findings were checked. '.repeat(12)+question;
 await f.run({userMessage:'php2shell - meeting',typedUserMessage:'php2shell - meeting',conversationHistory:[{role:'assistant',content:earlier},{role:'user',content:'Shorten the PPC meeting; leave the other weeklies.'},{role:'assistant',content:'PPC now ends at 16:00. The weeklies stay as they are.'}]});
 assert.ok(f.state.classified[0].meetingContextMessages.some(row=>row.content.includes(question)));
});
test('an earlier human condition survives the next question before the owner accepts',async t=>{
 const f=fixture(t),condition='Only if the other attendees are free.';
 await f.run({userMessage:'Yes',typedUserMessage:'Yes',conversationHistory:[{role:'user',content:'The title and participants are already established. '.repeat(8)+condition},{role:'assistant',content:'I found Tuesday at 11:00. Shall I book it?'}]});
 assert.ok(f.state.classified[0].meetingContextMessages.some(row=>row.content.includes(condition)));
});
test('the immediate complete question is still available',async t=>{
 const f=fixture(t),question='Which category should I give the debrief?';
 await f.run({userMessage:'Meeting',typedUserMessage:'Meeting',conversationHistory:[{role:'assistant',content:question}]});
 assert.equal(f.state.classified[0].meetingContextMessages.at(-1).content,question);
});
for(const [clock,blocked]of [['16:45',true],['09:15',true],['09:45',false]])test('a clock-only reply identifies one offered day before booking: '+clock,async t=>{
 const f=fixture(t);f.profile.user.timezone='America/New_York';f.state.scopes=['meetings'];
 f.state.toolNames=['create_meeting','find_available_slots'];f.state.requestUpdate={relation:'new'};
 f.state.classifierExtras={meetingAction:'execute',calendarOperations:[{operation:'create',quote:clock}]};
 f.state.offeredSlots=[['2030-12-03T09:15:00-05:00','Tuesday 09:15'],['2030-12-05T09:15:00-05:00','Thursday 09:15'],['2030-12-05T09:45:00-05:00','Thursday 09:45']].map(([startIso,display])=>({startIso,display}));
 const r=await f.run({userMessage:clock,rawUserMessage:clock,typedUserMessage:clock});
 assert.equal(r.tools.some(tool=>tool.name==='create_meeting'),!blocked);
 if(blocked)assert.ok(r.prompt.includes('Ask which day'));
});
for(const selection of ['sunday','ppc','untrusted'])test('returning to an earlier request restores its own terms: '+selection,async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.state.requestUpdate={relation:'continue'};
 const base={ownerId:'UOWNER',requesterId:'UOWNER',threadTs:'T1',channelId:'D1',updates:[],batch:false};
 const sunday={...base,requestId:'sunday',original:'Book Branding on Sunday with Tal',duration:{minutes:40,quote:'40 minutes'},searchDay:{date:'2030-12-01',zone:'UTC',quote:'Sunday'}};
 const ppc={...base,requestId:'ppc',original:'Move the PPC meeting to Wednesday',existingMeeting:{sourceQuote:'PPC meeting'},searchDay:{date:'2030-12-04',zone:'UTC',quote:'Wednesday'}};
 f.state.classifierExtras={selectedRequestId:selection,meetingContinuation:true,participantsUnchanged:true,meetingAction:'execute',calendarOperations:[{operation:'create',quote:'Book the Sunday meeting'}]};
 const r=await f.run({userMessage:'Book the Sunday meeting',rawUserMessage:'Book the Sunday meeting',typedUserMessage:'Book the Sunday meeting',conversationHistory:[{role:'assistant',content:'Sunday Branding is unbooked.',toolSummaries:[],meetingRequest:sunday},{role:'assistant',content:'PPC needs the owner to identify the event.',toolSummaries:[],meetingRequest:ppc}]});
 assert.equal(r.meetingRequest.requestId,selection==='sunday'?'sunday':'ppc');
 if(selection==='sunday'){assert.equal(f.state.classified[0].recentMeetingRequests.length,2);assert.equal(r.meetingRequest.existingMeeting,undefined);assert.equal(r.meetingRequest.duration.minutes,40);assert.equal(r.meetingRequest.searchDay.date,'2030-12-01');}
});

test('adding a named attendee to an existing request keeps the supplied inbox through context construction',async t=>{
 const f=fixture(t);f.state.scopes=['meetings'];f.state.meetingPeople=['Leor','Joshua','joshua@example.test'];
 f.state.requestUpdate={relation:'continue'};
 const quote='Joshua <joshua@example.test>';
 f.state.classifierExtras={meetingContinuation:true,participantsUnchanged:false,meetingPeopleGroups:[['Leor','Joshua']],participantCorrections:[{group:0,from:'Joshua',to:'joshua@example.test',quote}]};
 const previous={ownerId:'UOWNER',requesterId:'UOWNER',channelId:'D1',threadTs:'T1',requestId:'interview',original:'Interview with Leor',updates:[],batch:false,participantGroups:[['Leor']]};
 const text='Add '+quote+' to the interview with Leor';
 const r=await f.run({userMessage:text,typedUserMessage:text,priorMeetingState:previous});
 assert.deepEqual(JSON.parse(JSON.stringify(r.meetingRequest.participantGroups)),[['Leor','joshua@example.test']]);
 assert.ok(r.meetingRequest.participantBindings.some(p=>p.name==='Joshua'&&p.identifier==='joshua@example.test'));
});
