// Actual preflight branches, including production metadata reader. Isolated
// Graph GET and downstream write sentinel; no calendar/network side effects.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const arg = process.argv.indexOf('--source-root');
const sourceRoot = arg < 0 ? root : path.resolve(process.argv[arg + 1]);
function read(file) { const candidate = path.join(sourceRoot,file); return fs.readFileSync(fs.existsSync(candidate) ? candidate : path.join(root,file),'utf8'); }
function nodes(file,predicate) { const out=[]; const src=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true); (function visit(n){ if(predicate(n))out.push(n); ts.forEachChild(n,visit); })(src); return out; }
function one(xs) { assert.equal(xs.length,1,'unique production AST anchor'); return xs[0]; }
function compile(src,bindings,deps={}) { const module={exports:{}}; const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText; vm.runInNewContext(js,{...bindings,module,exports:module.exports,require:id=>{if(id in deps)return deps[id];throw Error('Unexpected '+id);}}); return module.exports; }
const reader=one(nodes('src/connectors/graph/calendarReads.ts',n=>ts.isFunctionDeclaration(n)&&n.name?.text==='getEventType')).getText().replace('export ','');
const logger={warn(){},info(){}};
async function run(tool,{type='singleInstance',subject='Fixture',failure,invalid=false,viewer='owner'}={}) {
  let writes=0;
  const getEventType=compile(reader+'\nmodule.exports=getEventType;',{
    getClient:()=>({api:()=>({select(){return this;},async get(){if(failure)throw failure;return invalid?{}:{type,subject,attendees:[]};}})}),
    eventPartAsInstant:()=>undefined,
  });
  const file=tool==='delete'?'src/skills/meetings/ops/handlers/calendarReads.ts':'src/skills/meetings/ops/handlers/moveMeeting.ts';
  const branch=one(nodes(file,n=>ts.isTryStatement(n)&&n.catchClause?.getText().includes(`${tool}_meeting recurring-preflight failed`)));
  const code=tool==='move'?branch.parent.getText():branch.getText();
  const fn=compile(`module.exports=async function(){
    let updateProbeSubject,preDeleteStartIso,preDeleteSubject,preDeleteSubjectMasked,preDeleteAttendeeEmails=[],preMoveStartIso,preMoveEndIso,preMoveIsAllDay,preMoveEventType,preMoveSubject;
    ${code}
    await write(); return {wrote:true};
  };`,{
    args:{meeting_id:'id',meeting_subject:'Fixture'},meetingId:'id',userEmail:'owner@example.test',
    context:{profile:{},threadTs:'thread'},logger,displaySubject:p=>viewer==='owner'?p.subject:'[Private]',subjectViewerFor:()=>viewer,viewerEmailFor:()=>undefined,
    subjectsPlausiblyMatch:(a,b)=>a===b,write:async()=>{writes++;},
  },{'../../../../connectors/graph/calendar':{getEventType},'../../../../utils/threadEventLedger':{forgetThreadEvent(){}}});
  try { return {result:await fn(),writes}; } catch(error) {return {error,writes};}
}
let passed=0,failed=0;
async function check(name,fn){try{await fn();passed++;console.log('ok '+name);}catch(e){failed++;console.log('not ok '+name+': '+e.message);}}
(async()=>{
  for(const tool of ['update','move','delete']){
    await check('regression '+tool+'-failed-get-no-write',async()=>{const r=await run(tool,{failure:Object.assign(Error('read unavailable'),{statusCode:503})});assert.equal(r.writes,0);assert.ok(r.error);});
    await check('regression '+tool+'-missing-type-no-write',async()=>{const r=await run(tool,{invalid:true});assert.equal(r.writes,0);assert.ok(r.error);});
    await check('preserved '+tool+'-series-refused-private',async()=>{const r=await run(tool,{type:'seriesMaster',viewer:'other'});assert.equal(r.writes,0);assert.equal(r.result?.error,'recurring_series_master');assert.equal(r.result?.meeting_subject,'[Private]');});
    await check('preserved '+tool+'-single-instance-writes',async()=>assert.equal((await run(tool)).writes,1));
    await check('preserved '+tool+'-occurrence-writes',async()=>assert.equal((await run(tool,{type:'occurrence'})).writes,1));
    await check('preserved '+tool+'-exception-writes',async()=>assert.equal((await run(tool,{type:'exception'})).writes,1));
    await check('preserved '+tool+'-wrong-subject-no-write',async()=>{const r=await run(tool,{subject:'Different'});assert.equal(r.writes,0);assert.equal(r.result?.error,'meeting_id_subject_mismatch');});
  }
  await check('preserved delete-404-not-new-cancellation',async()=>{const r=await run('delete',{failure:Object.assign(Error('absent'),{statusCode:404})});assert.equal(r.writes,0);assert.equal(r.result?.error,'event_not_found');});
  console.log(`${passed} passed; ${failed} failed`);process.exitCode=failed?1:0;
})();
