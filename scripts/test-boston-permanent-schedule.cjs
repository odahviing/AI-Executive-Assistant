// Boston permanent-home audit: synthetic hours only; real scheduling modules, isolated I/O.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DateTime}=require('luxon');
const {harness}=require('./test-timezone-owner-interval.cjs');
const {harness:attendeeHarness}=require('./test-timezone-owner-decisions.cjs');
const hours={Monday:['09:00-17:00'],Tuesday:['09:00-17:00'],Wednesday:['08:00-17:00'],Thursday:['09:00-17:00'],Friday:['08:00-17:00']};
function configure(h){h.profile.user.timezone='America/New_York';h.profile.meetings.physical_meetings_require_office_day=true;h.profile.schedule.work_hours=structuredClone(hours);h.profile.schedule.office_days.days=['Monday','Tuesday','Thursday'];h.profile.schedule.home_days.days=['Wednesday','Friday'];return h;}
const local=(date,time)=>DateTime.fromISO(`${date}T${time}`,{zone:'America/New_York'}).toISO();
for(const [date,day] of [['2026-11-09','Monday'],['2026-11-03','Tuesday'],['2026-11-04','Wednesday'],['2026-11-05','Thursday'],['2026-11-06','Friday']]){
 test(`${day}: actual finder, validator and booking plan agree on early/late boundaries`,async()=>{
  const h=configure(harness()),[first,last]=hours[day][0].split('-');
  const cases=[[local(date,first),true],[DateTime.fromISO(local(date,last)).minus({minutes:25}).toISO(),true],[DateTime.fromISO(local(date,first)).minus({minutes:25}).toISO(),false],[DateTime.fromISO(local(date,last)).minus({minutes:10}).toISO(),false]];
  for(const [s,ok] of cases){const e=DateTime.fromISO(s).plus({minutes:25}).toISO();assert.equal(h.check(s,e).passes,ok);assert.equal((await h.find(s,e,{timezone:h.profile.user.timezone})).length,ok?1:0);
   for(const initiator of ['owner','colleague']){const p=await h.load('src/skills/meetings/planMeeting.ts').planMeeting({profile:h.profile,intent:'new_booking',initiator,participants:[],subject:'Fixture',slotStartIso:s,slotEndIso:e,durationMin:25,preloadedEvents:[]});assert.equal(p.action==='book',ok||initiator==='owner');}
  }
 });
}
for(const date of ['2026-11-07','2026-11-08'])test(`${date}: US weekend closed, owner explicit override remains`,async()=>{const h=configure(harness()),s=local(date,'10:00'),e=local(date,'10:25');assert.equal(h.check(s,e).passes,false);assert.equal((await h.find(s,e,{timezone:h.profile.user.timezone})).length,0);const p=await h.load('src/skills/meetings/planMeeting.ts').planMeeting({profile:h.profile,intent:'new_booking',initiator:'owner',participants:[],subject:'Fixture',slotStartIso:s,slotEndIso:e,durationMin:25,preloadedEvents:[]});assert.equal(p.action,'book');});
for(const [date,diff] of [['2026-10-19',7],['2026-10-26',6],['2026-11-02',7],['2027-03-15',6],['2027-03-29',7]])test(`${date}: Israel counterpart and US/IL DST mismatch use instant math (${diff}h)`,async()=>{const h=configure(attendeeHarness({ownerZone:'America/New_York',person:{timezone:'Asia/Jerusalem'},travel:null,hours:{workdays:['Sunday','Monday','Tuesday','Wednesday','Thursday'],hoursStart:'09:00',hoursEnd:'18:00'}}));const s=local(date,'10:00'),e=local(date,'10:25');assert.equal(DateTime.fromISO(s).setZone('Asia/Jerusalem').hour,10+diff);assert.equal((await h.find(s,e)).length,1);const late=local(date,'16:00');assert.equal((await h.find(late,DateTime.fromISO(late).plus({minutes:25}).toISO())).length,0);});
test('Friday US owner available but Israel attendee weekend remains unavailable',async()=>{const h=configure(attendeeHarness({ownerZone:'America/New_York',person:{timezone:'Asia/Jerusalem'},travel:null,hours:{workdays:['Sunday','Monday','Tuesday','Wednesday','Thursday'],hoursStart:'09:00',hoursEnd:'18:00'}}));assert.equal((await h.find(local('2026-10-09','09:00'),local('2026-10-09','09:25'))).length,0);});
test('dated travel override beats permanent Boston home hours',async()=>{const h=configure(harness({'2026-10-05':{timezone:'Asia/Jerusalem',windows:['09:00-12:00'],isWorkday:true}}));const s='2026-10-05T09:00:00+03:00',e='2026-10-05T09:25:00+03:00';assert.equal(h.check(s,e).passes,true);assert.equal((await h.find(s,e,{timezone:h.profile.user.timezone})).length,1);});

test('subsequent synthetic daily hours edit immediately changes validator and finder',async()=>{const h=configure(harness()),s=local('2026-11-04','08:00'),e=local('2026-11-04','08:25');assert.equal(h.check(s,e).passes,true);h.profile.schedule.work_hours.Wednesday=['10:00-17:00'];assert.equal(h.check(s,e).passes,false);assert.equal((await h.find(s,e,{timezone:h.profile.user.timezone})).length,0);});
test('home Wednesday rejects in-person while office Tuesday accepts',()=>{const h=configure(harness());assert.equal(h.check(local('2026-11-04','10:00'),local('2026-11-04','10:25'),{inPersonRequested:true}).violation_kind,'in_person_on_home_day');assert.equal(h.check(local('2026-11-03','10:00'),local('2026-11-03','10:25'),{inPersonRequested:true}).passes,true);});

