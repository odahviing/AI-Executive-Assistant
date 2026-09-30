const fs=require('fs'),path=require('path'),Module=require('module'),{test}=require('node:test'),assert=require('assert/strict'),{DateTime}=require('luxon');
const filename=path.join(__dirname,'test-weekday-hours-joint.cjs'),m=new Module(filename,module);m.filename=filename;m.paths=module.paths;
m._compile(fs.readFileSync(filename,'utf8').split('const person=')[0]+'\nmodule.exports=m.exports;',filename);
const person={slack_id:'UALEX',email:'alex@example.com',name:'Alex',timezone:'America/New_York',profile_json:JSON.stringify({working_hours_structured:{workdays:['Monday','Tuesday','Wednesday','Thursday','Friday'],hoursStart:'09:00',hoursEnd:'17:00',dayOverrides:{Monday:{hoursStart:'08:00',hoursEnd:'14:00'}}},_set_by:{working_hours_structured:'owner'}})};
function fits(h,start,end){const a=h.load('src/utils/attendeeAvailability.ts'),entry=a.loadAttendeeAvailabilityForPerson(h.load('src/db/people.ts').getPersonMemory('UALEX'),'UTC');return a.attendeeWorkSegmentsBetween(entry,DateTime.fromISO(start),DateTime.fromISO(end))[0].fitsWorkHours;}
for(const [label,patch,initial] of [
 ['reversed day',{dayOverrides:{Tuesday:{hoursStart:'22:00',hoursEnd:'02:00'}}},person],
 ['equal day',{dayOverrides:{Tuesday:{hoursStart:'10:00',hoursEnd:'10:00'}}},person],
 ['reversed default',{hoursStart:'22:00',hoursEnd:'02:00'},person],
 ['equal default',{hoursStart:'10:00',hoursEnd:'10:00'},person],
 ['partial inherited default',{hoursStart:'18:00'},person],
 ['partial regional default',{hoursStart:'18:00'},{...person,profile_json:'{}'}],
])test('reject '+label+' without write or false success',async()=>{const h=m.exports([initial]);const original=h.load('src/db/people.ts').getPersonMemory('UALEX').profile_json;await assert.rejects(h.tool('Alex','UALEX',{working_hours_structured:patch}));assert.equal(h.load('src/db/people.ts').getPersonMemory('UALEX').profile_json,original);assert.equal(fits(h,'2026-10-06T10:00:00-04:00','2026-10-06T10:25:00-04:00'),true);h.sqlite.close();});
for(const [start,end] of [['00:00','00:01'],['23:58','23:59'],['10:00','16:00']])test('valid same-day '+start+'-'+end+' reaches interval and preserves siblings',async()=>{const h=m.exports([person]);const r=await h.tool('Alex','UALEX',{working_hours_structured:{dayOverrides:{Tuesday:{hoursStart:start,hoursEnd:end}}}});assert.equal(r.scheduling_hours.in_force,true);assert.equal(fits(h,`2026-10-06T${start}:00-04:00`,`2026-10-06T${end}:00-04:00`),true);assert.equal(fits(h,'2026-10-05T08:00:00-04:00','2026-10-05T08:25:00-04:00'),true);h.sqlite.close();});
test('lower authority still refuses before replacing owner window',async()=>{const h=m.exports([person]);const r=await h.tool('Alex','UALEX',{working_hours_structured:{hoursStart:'22:00',hoursEnd:'02:00'}},'colleague');assert.equal(r.scheduling_hours.in_force,false);assert.equal(fits(h,'2026-10-06T10:00:00-04:00','2026-10-06T10:25:00-04:00'),true);h.sqlite.close();});
