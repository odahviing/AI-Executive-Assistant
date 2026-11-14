// A fresh booking uses two independent observations, provider busy and stored work hours.
const {test}=require('node:test'), assert=require('node:assert/strict');
const {fixture,email,peer,hours}=require('./test-nov13-second-scheduling.cjs');
test('fresh owner create with unavailable provider still asks about known outside hours',async()=>{
 const r=await fixture({roster:[email],availability:[hours(email,'15:00','18:00')],collected:{providerDown:true}}).plan();
 assert.equal(r.action,'confirm_override');assert.match(r.suggestedAskText,/working hours/);
});
test('relaxed move preserves both known hours conflict and unread provider facts',async()=>{
 const r=await fixture({roster:[email,peer],existing:true,availability:[hours(email,'15:00','18:00'),hours(peer,'09:00','18:00')],collected:{providerDown:true}}).plan({allowRelaxed:true});
 assert.equal(r.action,'book');assert.equal(r.hasConflict,true);assert.equal(r.availabilityUnconfirmed,true);assert.match(r.overrideNotice,/working hours/);assert.match(r.overrideNotice,/not confirmed|couldn.t establish/);
});
test('colleague conditional failure carries no private calendar or hours facts',async()=>{
 const r=await fixture({roster:[email],role:'colleague',surface:'room',availability:[hours(email,'15:00','18:00')],collected:{providerDown:true}}).plan({requireAttendeeAvailability:true});
 assert.equal(r.action,'attendee_condition_unmet');assert.doesNotMatch(r.suggestedAskText,/guest@|working hours/);
});
test('clear hours and unread calendar preserve ordinary book-with-uncertainty behavior',async()=>{
 const r=await fixture({roster:[email],availability:[hours(email,'09:00','18:00')],collected:{providerDown:true}}).plan();assert.equal(r.action,'book');assert.equal(r.hasConflict,false);assert.equal(r.availabilityUnconfirmed,true);
});
