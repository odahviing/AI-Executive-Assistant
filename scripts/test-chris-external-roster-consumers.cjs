// Actual classifier/context producer through search and extracted create roster branch.
// Resolver/provider/calendar I/O are fixtures; model semantic judgment is not tested.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {externalFixture}=require('./test-chris-external-roster-context.cjs');
const {run}=require('./test-garage-recovery-summary.cjs');
const {createRoster}=require('./test-chris-meeting-roster.cjs');
const adam='adam@example.test',external='external@client.test';
for(const [label,groups,explicit,expected] of [
 ['external only',[['External']],[external],[external]],
 ['separate internal and external',[['Adam'],['External']],[external],[external]],
 ['same mixed meeting recovers omitted internal',[['Adam','External']],[external],[adam,external]],
 ['separate internal choice',[['Adam'],['External']],[adam],[adam]],
 ['two external groups ambiguous',[['External'],['Unknown']],[external],null],
 ['mixed and external unknown selector ambiguous',[['Adam','Unknown'],['External']],[external],null],
 ['known plus unknown crossing groups ambiguous',[['Adam','Unknown'],['External']],[adam,external],null],
 ['known choice with other unresolved groups',[['Adam','Unknown'],['External']],[adam],[adam]],
 ]) test('producer to both consumers: '+label,async t=>{
  const f=externalFixture(t,groups),ctx=await f.run({userMessage:'Meet Adam, External and Unknown.'});
  const r=await run({clean:true,contextOverride:ctx,argsOverride:{attendee_emails:explicit}});
  const created=createRoster(explicit,ctx);
  if(expected===null){assert.equal(r.out.error,'ambiguous_meeting_roster');assert.equal(r.calls.searches.length,0);assert.equal(created.error,'ambiguous_meeting_roster');}
  else {assert.ok(r.calls.searches.length);for(const c of r.calls.searches)assert.deepEqual([...c.attendeeBusyEmails].sort(),[...expected].sort());assert.deepEqual(created.map(a=>a.email).sort(),[...expected].sort());}
 });
