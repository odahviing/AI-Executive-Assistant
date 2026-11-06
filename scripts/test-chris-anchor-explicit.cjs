// Actual create anchor branch and actual quarter alignment; fixture calendar read.
// No write path, network, live DB or model execution.
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),{DateTime}=require('luxon');
const arg=process.argv.indexOf('--source-root'),root=arg<0?path.resolve(__dirname,'..'):path.resolve(process.argv[arg+1]);
function ast(file){return ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true);}
function collect(node,pred){const hits=[];function visit(n){if(pred(n))hits.push(n);ts.forEachChild(n,visit);}visit(node);return hits;}
const tree=ast('src/skills/meetings/ops/handlers/createMeeting.ts');
const anchors=collect(tree,n=>ts.isVariableDeclaration(n)&&n.name.getText()==='anchorId');assert.equal(anchors.length,1);
const block=anchors[0].parent.parent.parent;assert.ok(ts.isBlock(block));
const align=ast('src/utils/calendarDensity.ts').statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='alignUpQuarter');assert.ok(align);
async function run(extra={},anchorEnd='2026-11-16T15:40:00-05:00'){
 const args={start_at_event_end_id:'lori-event',duration_minutes:55,...extra};let reads=0;
 const module={exports:{}};
 const source=align.getText()+'\nexport async function run(){'+block.getText()+'\nreturn args;}';
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,DateTime,args,timezone:'America/New_York',userEmail:'owner@example.test',logger:{info(){}},getEventEndInstant:async()=>{reads++;return anchorEnd?{end:DateTime.fromISO(anchorEnd,{setZone:true}),subject:'Lori'}:null;}});
 return {result:JSON.parse(JSON.stringify(await module.exports.run())),reads};
}
test('regression independently accepted exact anchor preserves loaded15:40 with true flag',async()=>{const {result}=await run({start_is_explicit:true});assert.equal(Date.parse(result.start),Date.parse('2026-11-16T15:40:00-05:00'));assert.equal(Date.parse(result.end),Date.parse('2026-11-16T16:35:00-05:00'));});
for(const flag of [undefined,false])test('control ordinary anchor still snaps forward '+String(flag),async()=>{const {result}=await run({start_is_explicit:flag});assert.equal(Date.parse(result.start),Date.parse('2026-11-16T15:45:00-05:00'));assert.equal(Date.parse(result.end),Date.parse('2026-11-16T16:40:00-05:00'));});
test('control aligned anchor remains unchanged',async()=>{const {result}=await run({},'2026-11-16T16:00:00-05:00');assert.equal(Date.parse(result.start),Date.parse('2026-11-16T16:00:00-05:00'));});
test('control unavailable anchor refuses without fabricating a start',async()=>{const {result,reads}=await run({start_is_explicit:true},null);assert.equal(result.error,'anchor_event_not_found');assert.equal(result.success,false);assert.equal(reads,1);});
test('control missing duration refuses before calendar read',async()=>{const {result,reads}=await run({duration_minutes:0,start_is_explicit:true});assert.equal(result.error,'anchor_needs_duration');assert.equal(reads,0);});
