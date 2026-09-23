// Actual approval merge/store/colleague accept/replay and domain planner + Graph
// serializer controls. No network, runtime model or production DB writes.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),out=process.env.MODALITY_TRACE_FILE;
const results=[];let passed=0,failed=0;
function fixture(file,cut,fields){let src=fs.readFileSync(path.join(root,file),'utf8');if(cut)src=src.slice(0,src.indexOf(cut));const m={exports:{}};const req=n=>n==='node:test'?{test(){},afterEach(){}}:require(require.resolve(n,{paths:[__dirname]}));req.resolve=require.resolve;vm.runInNewContext('(function(require,module,exports,__dirname){'+src+'\nmodule.exports={'+fields+'};})',{console,process,Buffer,Date,Map,Set,Promise,Error,JSON,setTimeout})(req,m,m.exports,path.dirname(path.join(root,file)));return m.exports;}
const {harness}=fixture('scripts/test-approval-replay-identity.cjs',null,'harness');
const domain=require('./fixtures/approval-counter-domain.cjs');
const updateDomain=fixture('scripts/test-update-hybrid-location.cjs','(async()=>','update');
// Loader for the same shared merge on nonmeeting controls (no lifecycle side effect).
const mergeFile=path.join(process.env.MAELLE_APPROVAL_SOURCE_ROOT||root,'src/core/approvals/approvalCallbacks.ts');
const mod={exports:{}};const code=ts.transpileModule(fs.readFileSync(mergeFile,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
vm.runInNewContext(code,{module:mod,exports:mod.exports,require:n=>n==='luxon'?require('luxon'):n.endsWith('weTimeResolver')?{resolveStatedInstant:p=>({startIso:p.startIso,endIso:p.endIso}),statedZoneFromArgs:()=>undefined,statedClockPersonContext:()=>undefined}:n.endsWith('logger')?{default:{warn(){}},__esModule:true}:{}});
async function check(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
(async()=>{
for(const tool of ['create_meeting','move_meeting','update_meeting']){
for(const c of [
{name:'explicit online without new venue',counter:{is_online:true},wantOnline:true,wantLocation:'Microsoft Teams',reg:true},
{name:'explicit online blank venue',counter:{is_online:true,location:'  '},wantOnline:true,wantLocation:'Microsoft Teams',reg:true},
{name:'time-only preserves physical',counter:{new_start:'2026-09-22T13:45:00Z',new_end:'2026-09-22T14:10:00Z'},wantOnline:false,wantLocation:'Idan Office'},
{name:'original-only true stays hybrid',originalOnline:true,counter:{subject:'Renamed'},wantOnline:true,wantLocation:'Idan Office'},
{name:'explicit false preserves physical',counter:{is_online:false},wantOnline:false,wantLocation:'Idan Office'},
{name:'explicit hybrid retains chosen venue',counter:{is_online:true,location:'Boardroom'},wantOnline:true,wantLocation:'Boardroom'},
{name:'explicit remote venue unchanged',counter:{is_online:true,location:'Microsoft Teams'},wantOnline:true,wantLocation:'Microsoft Teams'}
])await check(tool+' '+c.name,async()=>{
 const original={tool,args:{subject:'Approved sync',meeting_id:'event-1',start:'2026-09-22T12:30:00Z',end:'2026-09-22T12:55:00Z',new_start:'2026-09-22T12:30:00Z',new_end:'2026-09-22T12:55:00Z',is_online:c.originalOnline??false,location:'Idan Office',attendees:['colleague@example.com']}};
 const h=harness({tool,details:{deferred_action:original}});
 assert.equal((await h.resolve({verdict:'amend',counter:c.counter})).ok,true);const stored=JSON.parse(h.row().details_json).counter;assert.deepEqual(JSON.parse(JSON.stringify(stored)),c.counter);
 assert.equal((await h.accept('UPAUL')).ok,true);const replay=h.effects.executes[0].args;assert.equal(replay.is_online,c.wantOnline);assert.equal(replay.location,c.wantLocation);
 let graph;{
 graph=tool==='update_meeting'?await updateDomain.update(replay):await domain.probe(tool+' '+c.name,replay,tool==='move_meeting'?'move':'new_booking');assert.equal(graph.isOnlineMeeting,c.wantOnline);
 if(c.wantLocation==='Microsoft Teams')assert.ok(!graph.location?.displayName||graph.location.displayName==='Microsoft Teams');else assert.equal(graph.location.displayName,c.wantLocation);
 }
 results.push({case:tool+' '+c.name,stored,replay,graph,limit:tool==='update_meeting'?'Actual update venue statements and Graph PATCH serializer; surrounding handler I/O mocked.':'Actual plan/rules/location + Graph serialization; full domain handler lifecycle mocked.'});
});}
for(const tool of ['create_meeting','move_meeting','update_meeting'])await check(tool+' immediate run_with_amend canonicalizes remote',async()=>{
 const h=harness({tool,details:{deferred_action:{tool,args:{subject:'Sync',meeting_id:'event-1',start:'2026-09-22T12:30:00Z',end:'2026-09-22T12:55:00Z',new_start:'2026-09-22T12:30:00Z',new_end:'2026-09-22T12:55:00Z',is_online:false,location:'Idan Office'}},callbacks:{on_amend:{mode:'run_with_amend'}}}});
 assert.equal((await h.resolve({verdict:'amend',counter:{is_online:true}})).ok,true);assert.equal(h.effects.executes.length,1);assert.equal(h.effects.executes[0].args.location,'Microsoft Teams');assert.equal(h.effects.executes[0].args.is_online,true);
});
await check('nonmeeting counter retains arbitrary fields without remote normalization',()=>{const r=mod.exports.mergeAmendIntoApprove({tool:'message_colleague',args:{location:'Idan Office'}},{is_online:true},{user:{timezone:'UTC'}});assert.equal(r.args.location,'Idan Office');assert.equal(r.args.is_online,true);});
console.log(`${passed} passed; ${failed} failed`);if(out)fs.writeFileSync(out,JSON.stringify(results,null,2));process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
