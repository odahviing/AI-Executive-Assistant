const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('typescript'),{test}=require('node:test'),{DateTime,Settings}=require('luxon');
Settings.now=()=>Date.parse('2026-09-30T12:00Z');
const base='artifacts/workshop-verification/approved-continuation-20261006/additions/matchmaker/block-payload',before=process.argv.includes('--before');
const read=f=>fs.readFileSync(before?`${base}/before/${f}`:f,'utf8');
function nodes(s,p){const a=[];function walk(n){if(p(n))a.push(n);ts.forEachChild(n,walk)}walk(s);return a;}
function compile(s,b={}){const m={exports:{}};vm.runInNewContext(ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:m,exports:m.exports,...b});return m.exports;}
const ds=ts.createSourceFile('d.ts',fs.readFileSync('src/utils/displaySubject.ts','utf8'),99,true);
const subjectViewerFor=compile(nodes(ds,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='subjectViewerFor')[0].getText(ds)+';module.exports=subjectViewerFor;');
const contexts={owner:{senderRole:'owner',surface:'owner_dm',channel:'slack'},colleague:{senderRole:'colleague',surface:'colleague_dm',channel:'slack'},room:{senderRole:'owner',surface:'room',channel:'slack'},email:{senderRole:'owner',surface:'owner_dm',channel:'email'},unknown:{senderRole:'owner'}};
const receipt='moved private therapy 11:30→11:45';
async function mutation(name,context,mode='confirmed'){
 const sf=ts.createSourceFile('m.ts',read(`src/skills/meetings/ops/handlers/${name}.ts`),99,true);
 const decl=nodes(sf,n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(sf)==='blocksMoved'))[0];
 const siblings=decl.parent.statements,idx=siblings.indexOf(decl),attempt=siblings[idx+1];assert.ok(ts.isTryStatement(attempt));
 const field=nodes(sf,n=>ts.isPropertyAssignment(n)&&n.name.getText(sf)==='blocks_moved'&&n.initializer.getText(sf)==='blocksMoved')[0];
 const date=nodes(sf,n=>ts.isPropertyAssignment(n)&&n.name.getText(sf)==='booked_start').at(-1);
 const out=compile('module.exports=async function(){'+decl.getText(sf)+attempt.getText(sf)+`return {${field.getText(sf)},${date.getText(sf)}}}`,{context:{...context,profile:{user:{slack_user_id:'owner'}}},args:{start:'2026-10-08T11:00:00+03:00'},effectiveStart:'2026-10-08T11:00:00+03:00',subjectViewerFor,logger:{warn(){}},require:()=>({rebalanceFloatingBlocksAfterMutation:async()=>{if(mode==='unavailable')throw Error('unavailable');return {moves:mode==='empty'?[]:[receipt]};}})});
 return out();
}
async function join(context,mode='confirmed'){
 const sf=ts.createSourceFile('m.ts',read('src/skills/meetings.ts'),99,true),branch=nodes(sf,n=>ts.isCaseClause(n)&&n.expression.getText(sf)==="'check_join_availability'")[0].statements[0].getText(sf);
 const zone='Asia/Jerusalem',events=['one','two'].slice(0,mode==='partial'?2:1).map(id=>({id,subject:'private therapy',showAs:'busy',start:{dateTime:'2026-10-08T11:00:00',timeZone:zone},end:{dateTime:'2026-10-08T11:30:00',timeZone:zone}}));let writes=0;
 const f=compile('module.exports=async function(args,context,profile)'+branch,{DateTime,subjectViewerFor,viewerEmailFor:()=>null,displaySubject:()=> 'a meeting',PRIVATE_MASK:'[Private]',renderClockInZone:()=> 'Thu 8 Oct11:00',checkSlot:()=>({passes:true}),occupancyRoleOf:()=> 'commitment',getOwnerEventsForDecision:async()=>events,logger:{info(){},warn(){}},updateMeeting:async()=>{if(mode==='failed')throw Error('unknown response');writes++;},require:n=>{
 if(n.includes('floatingBlocks'))return {getFloatingBlocks:()=>events.map(e=>({name:e.id,preferred_start:'09:00',preferred_end:'19:00'})),preserveFloatingSourceRanges:()=>[],blockAppliesOnDay:()=>true,windowMsForDay:(d,t,z)=>DateTime.fromISO(d+'T'+t,{zone:z}).toMillis(),isFloatingBlockEvent:(e,b)=>e.id===b.name,isMovableFloatingBlockEvent:()=>true,blockSizedToEvent:()=>({duration_minutes:30}),findBlockDestination:()=>({aligned:mode==='partial'&&writes?null:DateTime.fromISO('2026-10-08T11:45',{zone}).toMillis(),usedWorkingElsewhereFallback:true})};
 if(n.includes('rebalanceFloatingBlocks'))return {logRebalanceMoveActivity:()=>{if(mode==='activity-failed')throw Error('activity unavailable')}};
 if(n.includes('calendarIssues'))return {getSuppressedEventIds:()=>new Set()};throw Error(n);
 }});
 const out=await f({meeting_start:'2026-10-08T11:00:00',duration_min:30,subject:'Sync',requester_name:'Peer'},context,{user:{timezone:zone,name:'Owner',email:'owner@example.test'},behavior:{calendar_health_mode:'active'}});return {out,writes};
}
for(const name of ['createMeeting','moveMeeting'])for(const [who,ctx] of Object.entries(contexts))test(`${name} ${who} scopes confirmed receipt and retains actual date`,async()=>{const r=await mutation(name,ctx);assert.equal(r.blocks_moved[0],who==='owner'?receipt:'moved a calendar block');assert.equal(r.booked_start,'2026-10-08T11:00:00+03:00');});
for(const name of ['createMeeting','moveMeeting'])for(const mode of ['empty','unavailable'])test(`${name} ${mode} never fabricates receipt`,async()=>assert.equal((await mutation(name,contexts.owner,mode)).blocks_moved.length,0));
for(const [who,ctx] of Object.entries(contexts))for(const mode of ['confirmed','partial','activity-failed'])test(`join ${who} ${mode}`,async()=>{const {out,writes}=await join(ctx,mode);assert.equal(writes,1);assert.equal(out.blocks_moved.length,1);assert.equal(out.meeting_start,'2026-10-08T11:00:00.000+03:00');assert.equal(out.can_join,mode!=='partial');if(who==='owner')assert.match(out.blocks_moved[0],/moved one 11:00→11:45/);else{assert.equal(out.blocks_moved[0],'moved a calendar block');assert.ok(!/one|11:45|Working-Elsewhere/.test(out.message));}});
test('join failed or unknown write no confirmed receipt',async()=>{const {out,writes}=await join(contexts.owner,'failed');assert.equal(writes,0);assert.equal(out.blocks_moved,undefined);});
