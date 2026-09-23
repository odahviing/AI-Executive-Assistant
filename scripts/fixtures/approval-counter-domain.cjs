// Read-only domain probe: real planMeeting/location signals/checkSlot/location
// resolver, production create-handler location expression, real Graph mutation
// serialization. Classifier and calendar/people I/O are fixtures. No live calls.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const req=n=>require(require.resolve(n,{paths:[path.join(root,'scripts')]}));
const ts=req('typescript'),luxon=req('luxon');
let src=fs.readFileSync(path.join(root,'scripts/test-inperson-home-day-colleague.cjs'),'utf8');
src=src.slice(0,src.indexOf('// ── AST helpers'))+'\nmodule.exports={load,profile,logger};';
const base={exports:{}};
vm.runInThisContext('(function(require,module,exports,__dirname,process){'+src+'\n})')(req,base,base.exports,path.join(root,'scripts'),{argv:[]});
const {load,profile,logger}=base.exports;
profile.meetings.office_location={short_label:'Idan Office',full_label:'Idan Office',meeting_room_label:'Meeting Room'};
function compile(file,deps){const m={exports:{}};const js=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;vm.runInNewContext(js,{module:m,exports:m.exports,console,require:n=>{if(n in deps)return deps[n];throw Error('Unexpected dependency '+n);}});return m.exports;}
const work=load('src/utils/workHours.ts');
const location=compile('src/utils/resolveLocation.ts',{'./workHours':work});
const plan=compile('src/skills/meetings/planMeeting.ts',{
  luxon,'../../utils/logger':{default:logger,__esModule:true},'../../utils/resolveLocation':location,'../../utils/workHours':work,
  '../../utils/scheduleRules':load('src/utils/scheduleRules.ts'),
  '../../connectors/graph/calendar':{getOwnerEventsForDecision:async()=>[],getFreeBusyForDecision:async()=>({}),findAvailableSlots:async()=>[]},
  '../../utils/attendeeAvailability':{loadAttendeeAvailabilityForEmails:()=>[]},
  '../../utils/displaySubject':{subjectViewerFor:()=> 'owner'},'../../utils/weTimeResolver':{profileDualClock:()=> 'Tuesday13:45'},
  './nearbyAlternatives':{},'./detectCategory':{detectCategory:async()=>({category:'Meeting',reason:'fixture classifier: internal meeting'})},
  './findMeetingOwner':{findMeetingOwner:async()=>({ownerIsOrganizer:true})},
  '../../db/people':{getTravelRecordById:()=>null,getEffectiveTimezoneById:()=>({timezone:'Asia/Jerusalem'}),personIdForSlackId:()=>null,searchPeopleMemory:()=>[]},
  '../../db/venues':{isCompanyLocation:()=>true},'../../utils/locationTz':{inferTimezoneFromStateStatic:()=>undefined},
});
const writes=[];
const mutations=compile('src/connectors/graph/calendarMutations.ts',{
  luxon,'../../utils/logger':{default:logger,__esModule:true},'../../db':{auditLog(){}},'../../config/userProfile':{getProfileByEmail:()=>profile},
  './calendarReads':{},'./calendarCache':{invalidateCalendarCache(){}},
  './graphClient':{getClient:()=>({api:url=>({async post(body){writes.push({method:'POST',url,body});return{id:'fixture'};},async patch(body){writes.push({method:'PATCH',url,body});}})})},
});
function createLocation(parts){const file=fs.readFileSync(path.join(root,'src/skills/meetings/ops/handlers/createMeeting.ts'),'utf8');const tree=ts.createSourceFile('create.ts',file,ts.ScriptTarget.Latest,true),hits=[];(function walk(n){if(ts.isPropertyAssignment(n)&&n.name.getText()==='location'&&n.initializer.getText().includes('resolvedLocationParts.join'))hits.push(n);ts.forEachChild(n,walk);})(tree);assert.equal(hits.length,1);const js=ts.transpileModule('module.exports='+hits[0].initializer.getText(),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;const m={exports:{}};vm.runInNewContext(js,{module:m,resolvedLocationParts:parts,require:()=>({scrubInternalLeakage:x=>x})});return m.exports;}
async function probe(name,args,intent='new_booking'){
 const decision=await plan.planMeeting({profile,intent,initiator:'owner',subject:'EmblemHealth scanner report',slotStartIso:'2026-09-22T13:45:00+03:00',slotEndIso:'2026-09-22T14:10:00+03:00',participants:[{email:'elan.h@reflectiz.com'},{email:'rita.k@reflectiz.com'}],isOnlineHint:args.is_online,locationHint:args.location,allowRelaxed:true,viewer:'owner',preloadedEvents:[],...(intent==='move'?{existingEventId:'fixture',existingEventLocation:'Idan Office',existingEventIsOnline:true,priorSlotStartIso:'2026-09-22T12:30:00+03:00',existingEventCategories:['Meeting']}:{})});
 assert.equal(decision.action,'book');
 const params={userEmail:profile.user.email,timezone:profile.user.timezone,subject:'EmblemHealth scanner report',start:'2026-09-22T13:45:00+03:00',end:'2026-09-22T14:10:00+03:00',attendees:[{email:'elan.h@reflectiz.com'},{email:'rita.k@reflectiz.com'}],isOnline:decision.isOnline,location:createLocation(decision.location?[decision.location]:[])};
 if(intent==='move')await mutations.updateMeeting({...params,meetingId:'fixture',isAllDay:false,eventType:'singleInstance'});else await mutations.createMeeting(params);
 const payload=writes.at(-1).body;console.log(JSON.stringify({name,args,decision:{location:decision.location,isOnline:decision.isOnline,reasoning:decision.reasoning},graph:payload}));return payload;
}
async function probeUpdate(args){
 const file=fs.readFileSync(path.join(root,'src/skills/meetings/ops/handlers/moveMeeting.ts'),'utf8');
 const tree=ts.createSourceFile('move.ts',file,ts.ScriptTarget.Latest,true),nodes=[];
 (function walk(n){if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>['venueChangeRequested','explicitLocation','explicitIsOnline','patchLocation','patchIsOnline'].includes(d.name.getText())))nodes.push(n);ts.forEachChild(n,walk);})(tree);
 assert.equal(nodes.length,5);
 const m={exports:{}};const js=ts.transpileModule(nodes.map(n=>n.getText()).join('\n')+'\nmodule.exports={patchLocation,patchIsOnline};',{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(js,{module:m,args,newLocationFromShape:undefined,newIsOnlineFromShape:undefined});
 await mutations.updateMeeting({userEmail:profile.user.email,timezone:profile.user.timezone,meetingId:'fixture',location:m.exports.patchLocation,isOnline:m.exports.patchIsOnline});
 console.log(JSON.stringify({name:'update explicit override',args,graph:writes.at(-1).body}));return writes.at(-1).body;
}

module.exports={probe};
