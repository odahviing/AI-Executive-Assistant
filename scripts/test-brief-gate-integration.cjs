// Complete brief producer + actual humanGate; only external I/O/model verdicts
// are controlled. Evidence transport and branch behavior, not model obedience.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test'),{DateTime}=require('luxon');
const {harness,verdict}=require('./test-gatekeeper-readiness.cjs');
let source=fs.readFileSync(path.join(__dirname,'test-librarian-action-outcomes.cjs'),'utf8');
source=source.slice(0,source.indexOf('function person('))+source.slice(source.indexOf('function brief('),source.indexOf('for (const [label, options]'));
function replace(from,to){assert.ok(source.includes(from),from);source=source.replace(from,to);}
replace('const source = revision ?',"const source = relative === 'src/tasks/briefs.ts' && process.env.BRIEF_GATE_SOURCE ? fs.readFileSync(process.env.BRIEF_GATE_SOURCE,'utf8') : revision ?");
replace("details_json: '{}' };","details_json: '{}' };\n  if(options.row) row={...row,...options.row};");
replace('getCalendarEvents: async () => []',"getCalendarEvents: async () => { if(options.calendarFails) throw Error('calendar unavailable'); return options.events || []; }");
replace("'src/skills/meetings/ops.ts': {}","'src/skills/meetings/ops.ts': { processCalendarEvents: events => events }");
replace('getActiveSlotHolds: () => []','getActiveSlotHolds: () => options.holds || []');
replace('markRequestSurfaced: () => effects.surfaced++','markRequestSurfaced: ids => effects.surfaced += ids.length');
replace("'src/utils/humanGate.ts': { runHumanGate: async () => ({ ok: true }) }","'src/utils/humanGate.ts': options.gate.human");
replace("create: async () => { if(options.composeThrows)","create: async input => { effects.logs.push(['compose',input]); if(options.composeThrows)");
replace("text:'Review your pending ask.'","text:options.draft || 'Review your pending ask.'");
replace('news: !!options.news','news: !!options.news, calendar: !!options.health');
replace("'src/utils/cleanupVanishedMeetingArtifacts.ts':", "'src/skills/registry.ts': { executeSkillTool: async () => ({summary_text:'Calendar checked: no conflicts.',vacuous:false}) }, 'src/utils/cleanupVanishedMeetingArtifacts.ts':");
source+='\nmodule.exports={brief};';
const mod={exports:{}};vm.runInThisContext('(function(require,module,exports,__dirname){'+source+'\n})',{filename:__filename})(require,mod,mod.exports,__dirname);
const event={id:'gartner-event',subject:'To Be Rescheduled: Reflectiz-Gartner//Sync',organizer:{name:'Invite author',email:'author@example.com'},_localDate:DateTime.now().toUTC().toISODate(),_localStartTime:'14:30',_localEndTime:'15:00',_eventType:'mine'};
const outreach={kind:'outreach',subkind:'meeting_reschedule',state:'awaiting_colleague',target_name:'Elan',details_json:JSON.stringify({message:'Move Triweekly to Wednesday?',await_reply:1,context_json:JSON.stringify({meeting_id:'elan-event',meeting_subject:'Elan & Idan - Triweekly'})})};
function fixture(options={},responses=[verdict(true)]){const gate=harness(responses),h=mod.exports.brief({...options,gate});return{...h,gate};}
const facts=h=>JSON.parse(JSON.parse(h.gate.calls[0].messages[0].content).briefingEvidence);
const posted=h=>h.effects.posts[0][1];
const stored=h=>h.effects.history[0][2].content;
test('regression complete producer passes exact invite and request identities to existing owner gate',async()=>{
 const h=fixture({events:[event],row:outreach});await h.run();const evidence=facts(h),cal=evidence.items.find(x=>x.kind==='calendar_today').events[0],request=evidence.items.find(x=>x.kind==='outreach');
 assert.equal(cal.event_id,'gartner-event');assert.equal(cal.subject,event.subject);assert.equal(cal.subject_source,'calendar_invite');assert.equal(cal.organizer.email,event.organizer.email);assert.equal(request.meeting_id,'elan-event');assert.equal(request.meeting_subject,'Elan & Idan - Triweekly');assert.equal(request.state,'awaiting_colleague');assert.equal(h.gate.calls.length,1);assert.equal(h.effects.closures,0);
});
test('regression existing hold producer and health facts reach the gate without invented recipient age',async()=>{
 const h=fixture({health:true,holds:[{holder_name:'Levana',start_iso:'2026-10-21T11:15:00Z',created_at:DateTime.now().minus({hours:16}).toUTC().toISO(),subject:'Interview',reason:'Waiting for confirmation'}]});await h.run();const evidence=facts(h);assert.ok(evidence.slotHoldsSummary.includes('held 16h'));assert.ok(evidence.slotHoldsSummary.includes('Levana'));assert.equal(evidence.healthSummary,'Calendar checked: no conflicts.');assert.ok(h.gate.calls[0].system.includes("reservation's age, not how long its candidate has had to respond"));
});
for(const [id,draft,rewrite] of [
 ['ongoing-work','Gartner at 14:30 is titled To Be Rescheduled. I am checking that now. Elan has not replied.','Gartner at 14:30 is titled To Be Rescheduled. Elan has not replied.'],
 ['hold-age','Holding Wednesday at 11:15 and 12:15. The candidate has not replied after 16 hours.','Holding Wednesday at 11:15 and 12:15 while we wait for confirmation.'],
])test('control actual gate correction alone posted and stored '+id,async()=>{const h=fixture({draft},[verdict(false,rewrite)]);await h.run();assert.equal(posted(h),'☀️ '+rewrite);assert.equal(stored(h),'[Morning brief posted]\n'+rewrite);assert.equal(h.effects.surfaced,1);assert.equal(h.effects.events.length,1);assert.equal(h.effects.closures,1);});
for(const draft of ['Elan has not replied to the Triweekly proposal.','The confirmation deadline is today at 17:00.','I can ask the organizer whether this needs a new time.'])test('control legitimate accepted draft preserved '+draft,async()=>{const h=fixture({draft,row:outreach});await h.run();assert.equal(posted(h),'☀️ '+draft);assert.equal(stored(h),'[Morning brief posted]\n'+draft);assert.equal(h.gate.calls.length,1);});
test('regression actual gate fact-drop retry retains producer evidence and corrected deadline',async()=>{const draft='Waiting for confirmation; deadline 17:00.',rewrite='Confirmation pending; deadline 17:00.',h=fixture({draft,events:[event],row:outreach},[verdict(false,'Waiting.'),verdict(false,rewrite)]);await h.run();assert.equal(h.gate.calls.length,2);assert.ok(h.gate.calls[1].messages[0].content.includes('gartner-event'));assert.ok(h.gate.calls[1].messages[0].content.includes('elan-event'));assert.equal(posted(h),'☀️ '+rewrite);assert.equal(stored(h),'[Morning brief posted]\n'+rewrite);});
for(const response of [new Error('unavailable'),{content:[]}])test('control unknown verdict retains existing owner safe miss '+String(response),async()=>{const h=fixture({draft:'Waiting for confirmation at 11:15.'},[response]);await h.run();assert.equal(posted(h),'☀️ Waiting for confirmation at 11:15.');assert.equal(h.effects.surfaced,1);});
for(const option of ['sendFails','sendThrows','noConnection'])test('control '+option+' prevents delivery bookkeeping',async()=>{const h=fixture({[option]:true},[verdict(false,'Contact review is pending.')]);await assert.rejects(h.run());assert.equal(h.effects.surfaced+h.effects.closures+h.effects.events.length+h.effects.history.length,0);});
test('control successful retry follows failed send; scheduled dedup never rechecks or posts',async()=>{const options={sendFails:true,gate:harness()},h=mod.exports.brief(options);await assert.rejects(h.run(false));options.sendFails=false;await h.run(false);assert.equal(h.effects.history.length,1);assert.equal(h.effects.surfaced,1);const calls=options.gate.calls.length;options.alreadySent=true;await h.run(false);assert.equal(options.gate.calls.length,calls);assert.equal(h.effects.posts.length,2);});
test('regression unavailable calendar reaches gate as unavailable while terminal request stays absent',async()=>{const h=fixture({calendarFails:true,row:{...outreach,state:'resolved'}});await h.run();const evidence=facts(h);assert.ok(evidence.items.some(x=>x.kind==='calendar_unavailable'));assert.equal(evidence.items.some(x=>x.kind==='outreach'),false);assert.equal(h.effects.surfaced,0);assert.equal(h.effects.closures,0);});
