const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),ts=require('typescript');
const at=process.argv.indexOf('--source-root'),root=at<0?path.resolve(__dirname,'..'):path.resolve(process.argv[at+1]);
const fixture=path.join(__dirname,'test-dina-owner-roster.cjs');
const mod={exports:{}};
const source=fs.readFileSync(fixture,'utf8').replace("root=path.resolve(__dirname,'..')",'root='+JSON.stringify(root));
vm.runInNewContext(source,{require:createRequire(fixture),module:mod,exports:mod.exports,__dirname,console,process});
const {planner}=mod.exports;
test('regression accepted busy override survives planner as settled disposition',async()=>{const h=planner({peerBusy:true});h.input.allowRelaxed=true;const r=await h.plan();assert.equal(r.action,'book');assert.equal(r.attendeeConflictDisposition,'accepted_override');assert.match(r.overrideNotice,/Accepted conflict override/);});
test('regression ordinary move collision remains informational, never claims consent',async()=>{const h=planner({peerBusy:true});const r=await h.plan();assert.equal(r.action,'book');assert.equal(r.attendeeConflictDisposition,'move_notice');assert.ok(!r.overrideNotice.includes('Accepted'));});
test('control fresh unapproved booking still asks once',async()=>{const h=planner({peerBusy:true});h.input.intent='new_booking';const r=await h.plan();assert.equal(r.action,'confirm_override');assert.match(r.attendeeBusyLabel,/busy/);});
test('control clean planner produces no invented accepted conflict',async()=>{const h=planner();const r=await h.plan();assert.equal(r.action,'book');assert.equal(r.attendeeConflictDisposition,undefined);assert.equal(r.overrideNotice,undefined);});
test('regression move success payload does not solicit redundant checking work',()=>{
 const file=fs.readFileSync(path.join(root,'src/skills/meetings/ops/handlers/moveMeeting.ts'),'utf8');
 const a=file.indexOf('        const attendeeBusyNoteParts: string[] = [];'),b=file.indexOf('        // 2026-09-09 — the moved-to instant',a);assert.ok(a>=0&&b>a);
 const module={exports:{}};vm.runInNewContext(ts.transpileModule('export function run(){'+file.slice(a,b)+'\nreturn attendeeBusyNote;}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,bookedOverAttendees:[],movePlanOverrideNotice:'Accepted conflict override: Chris is busy'});
 const note=module.exports.run();assert.ok(note.includes('Chris is busy'));assert.ok(!note.includes('offer to check'),note);assert.ok(note.includes('does not create'),note);
});
