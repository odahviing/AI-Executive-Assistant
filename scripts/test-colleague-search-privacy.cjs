const fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module'),assert=require('node:assert/strict');
const file=path.join(__dirname,'test-email-mechanics-integration.cjs');
let prefix=fs.readFileSync(file,'utf8').split("test('regression")[0];
prefix=prefix.replace('relaxed=true}={}',"relaxed=true,role='owner',surface='dm',mustBe=false}={}")
 .replace("senderRole:'owner'","senderRole:role,surface")
 .replace('meeting_mode:\'online\',relaxed,','meeting_mode:\'online\',relaxed,must_be:mustBe,');
const mod={exports:{}};vm.runInNewContext(prefix+'\nmodule.exports={run};',{require:createRequire(file),module:mod,__dirname,process,console,Date,Buffer,setTimeout,clearTimeout});
const {run}=mod.exports;
const boundaryFile=path.join(__dirname,'test-email-scheduling-mechanics.cjs'),bm={exports:{}};
vm.runInNewContext(fs.readFileSync(boundaryFile,'utf8').split("for(const shape")[0]+'\nmodule.exports={boundary};',{require:createRequire(boundaryFile),module:bm,__dirname,process,console,structuredClone,Date,Buffer,setTimeout,clearTimeout});
const {boundary}=bm.exports; let passed=0,failed=0;
async function check(kind,id,fn){try{await fn();passed++;console.log('ok '+kind+' '+id)}catch(e){failed++;console.log('not ok '+kind+' '+id+': '+e.stack)}}
(async()=>{
for(const surface of ['dm','room'])await check('regression','colleague-'+surface+'-approval-private',async()=>{const {out,warnings}=await run({channel:'slack',role:'colleague',surface,relaxed:false,mustBe:true});assert.equal(warnings.length,0,JSON.stringify(warnings));assert.ok(out.owner_approval_candidates.length);assert.equal(out.slots.length,0);assert.ok(out.owner_approval_candidates.every(c=>c.broken_rules===undefined));assert.ok(!JSON.stringify(out).includes('focus'));assert.match(out._must_be_owner_approval_note,/policy_exception/);});
await check('regression','colleague-candidate-private',async()=>{const {out}=await run({channel:'slack',role:'colleague',candidate:true,relaxed:false});assert.equal(out.results[0].available,false);assert.equal(out.results[0].broken_rule_label,undefined);assert.equal(out.results[0].less_preferred_label,'requires owner approval');});
await check('preserved','owner-diagnostics',async()=>{const {out}=await run({channel:'slack'});assert.ok(out[0].broken_rules.includes('focus_time_floor'));});
await check('preserved','clean-colleague-option',async()=>{const {out}=await run({channel:'slack',role:'colleague',clean:true,relaxed:false});const slots=Array.isArray(out)?out:out.slots;assert.equal(slots.length,1);assert.equal(slots[0].start,'2026-09-14T12:00:00.000+03:00');});
await check('preserved','unavailable-no-false-offer',async()=>{await assert.rejects(()=>run({channel:'slack',role:'colleague',offline:true}),/fixture calendar unavailable/)});
await check('regression','soft-hint-withheld',async()=>{const {out}=await run({channel:'slack',role:'colleague',relaxed:false});assert.ok(out._colleague_soft_block_hint);assert.ok(!JSON.stringify(out).includes('protections'));});
await check('preserved','remote-clean-alternative-and-priority',async()=>{const value={slots:[],owner_approval_candidates:[{start:'a',end:'b',label:'Tuesday 10:00',broken_rules:['in_person_on_home_day']},{start:'c',end:'d',label:'Tuesday 11:00',broken_rules:['in_person_on_home_day','focus_time_floor']}],_must_be_owner_approval_note:'Tuesday 10:00 online meeting with no approval'};const out=await boundary(value,'slack','colleague');assert.deepEqual(out.owner_approval_candidates.map(c=>c.start),['a','c']);assert.match(out._must_be_owner_approval_note,/Tuesday 10:00/);assert.ok(!out._must_be_owner_approval_note.includes('Tuesday 11:00'));});
await check('preserved','attendee-hard-failure-stays-hard',async()=>{const value={results:[{available:false,broken_rule:'outside_attendee_work_hours:peer@example.test',broken_rule_label:'Peer is outside working hours'}]};assert.deepEqual(await boundary(value,'slack','colleague'),value);});
await check('preserved','null-unavailable-and-non-search-untouched',async()=>{assert.equal(await boundary(null,'slack','colleague'),null);const value={success:false,error:'calendar_unavailable'};assert.deepEqual(await boundary(value,'slack','colleague'),value);assert.deepEqual(await boundary({success:true},'slack','colleague','dm','create_meeting'),{success:true});});
await check('regression','unknown-role-withholds-policy-and-retry-idempotent',async()=>{const value={results:[{available:false,broken_rule:'focus_time_office',broken_rule_label:'focus'}],preferred_slot_status:{available:false,broken_rule:'focus_time_office',broken_rule_label:'focus',_note:'focus'}};const out=await boundary(value,'slack','unknown');assert.ok(!JSON.stringify(out).includes('focus'));assert.deepEqual(await boundary(out,'slack','unknown'),out);});
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
})();


