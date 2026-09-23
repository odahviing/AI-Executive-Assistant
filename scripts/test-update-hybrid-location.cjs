// Production update venue-selection statements → actual Graph PATCH builder.
// No network, DB, model call or application bootstrap.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript'),luxon=require('luxon');
const root=path.resolve(__dirname,'..'),idx=process.argv.indexOf('--source-root'),snapshot=idx<0?root:path.resolve(process.argv[idx+1]);
const read=file=>fs.readFileSync(fs.existsSync(path.join(snapshot,file))?path.join(snapshot,file):path.join(root,file),'utf8');
function compile(src,globals={},deps={}){const m={exports:{}};vm.runInNewContext(ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{...globals,module:m,exports:m.exports,require:n=>{if(n in deps)return deps[n];throw Error(n);}});return m.exports;}
const tree=ts.createSourceFile('move.ts',read('src/skills/meetings/ops/handlers/moveMeeting.ts'),ts.ScriptTarget.Latest,true),nodes=[];
(function walk(n){if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>['venueChangeRequested','explicitLocation','explicitIsOnline','patchLocation','patchIsOnline'].includes(d.name.getText())))nodes.push(n);ts.forEachChild(n,walk);})(tree);assert.equal(nodes.length,5);
const writes=[];
const mutations=compile(read('src/connectors/graph/calendarMutations.ts'),{}, {
 luxon,'../../utils/logger':{default:{info(){},warn(){},error(){}},__esModule:true},'../../db':{auditLog(){}},'../../config/userProfile':{getProfileByEmail:()=>({user:{slack_user_id:'owner'}})},'./calendarReads':{},'./calendarCache':{invalidateCalendarCache(){}},'./graphClient':{getClient:()=>({api:()=>({async patch(body){writes.push(body);},async post(body){writes.push(body);return{id:'fixture'};}})})},
});
async function update(args,shape={}){const fields=compile(nodes.map(n=>n.getText()).join('\n')+'\nmodule.exports={patchLocation,patchIsOnline};',{args,newLocationFromShape:shape.location,newIsOnlineFromShape:shape.online});await mutations.updateMeeting({userEmail:'owner@example.test',timezone:'UTC',meetingId:'fixture',location:fields.patchLocation,isOnline:fields.patchIsOnline});return writes.at(-1);}
let passed=0,failed=0;
async function check(name,fn){try{await fn();passed++;console.log('ok '+name);}catch(e){failed++;console.log('not ok '+name+': '+e.message);}}
(async()=>{
 await check('regression explicit-hybrid-keeps-venue',async()=>{const p=await update({location:'Boardroom',is_online:true});assert.equal(p.location.displayName,'Boardroom');assert.equal(p.isOnlineMeeting,true);});
 await check('preserved canonical-remote-clears-venue',async()=>{const p=await update({location:'Microsoft Teams',is_online:true});assert.equal(p.location.displayName,'');assert.equal(p.isOnlineMeeting,true);});
 await check('preserved physical-false-keeps-venue',async()=>{const p=await update({location:'Boardroom',is_online:false});assert.equal(p.location.displayName,'Boardroom');assert.equal(p.isOnlineMeeting,false);});
 await check('preserved time-only-does-not-patch-modality',async()=>assert.deepEqual(JSON.parse(JSON.stringify(await update({}))),{}));
 await check('preserved derived-hybrid-keeps-venue',async()=>{const p=await update({is_online:true},{location:'Meeting Room',online:true});assert.equal(p.location.displayName,'Meeting Room');assert.equal(p.isOnlineMeeting,true);});
 await check('preserved explicit-location-only-keeps-online-unchanged',async()=>{const p=await update({location:'Boardroom'});assert.equal(p.location.displayName,'Boardroom');assert.equal(p.isOnlineMeeting,undefined);});
 await check('preserved online-without-venue-clears',async()=>assert.equal((await update({is_online:true})).location.displayName,''));
 await check('preserved create-remote-sentinel-remains-native',async()=>{await mutations.createMeeting({userEmail:'owner@example.test',timezone:'UTC',subject:'Fixture',start:'2026-09-24T10:00:00Z',end:'2026-09-24T10:25:00Z',attendees:[],isOnline:true,location:'Microsoft Teams'});assert.equal(writes.at(-1).location,undefined);assert.equal(writes.at(-1).isOnlineMeeting,true);});
 console.log(`${passed} passed; ${failed} failed`);process.exitCode=failed?1:0;
})();
