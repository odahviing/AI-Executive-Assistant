// Real tool/prompt captures only: no model calls; assertions do not prove obedience.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');
const prior=process.argv.includes('--chris-before');
const before='artifacts/workshop-verification/chris-build-20261103/instructor/before/';
function runFixture(file,source){const m={exports:{}};vm.runInNewContext('(function(require,module,exports,__dirname){'+source+'\n})',{console,process,Date,Map,Set,Buffer})(n=>n==='node:test'?{test(){}}:createRequire(path.join(__dirname,file))(n),m,m.exports,__dirname);return m.exports;}
let meetings=fs.readFileSync(path.join(__dirname,'test-instructor-image-booking-grounding.cjs'),'utf8').split('const tool = loadCreateMeetingTool();')[0];
meetings=meetings.replace("return fs.readFileSync(path.join(repo, rel), 'utf8');",`return fs.readFileSync(path.join(repo, ${JSON.stringify(prior?before:'')} + rel), 'utf8');`);
const create=runFixture('test-instructor-image-booking-grounding.cjs',meetings+'\nmodule.exports={tool:loadCreateMeetingTool()};').tool;
let context=fs.readFileSync(path.join(__dirname,'test-turn-context-boundaries.cjs'),'utf8');
if(prior)context=context.replace('fs.readFileSync(path.join(root, file)',`fs.readFileSync(path.join(root, file === 'src/core/orchestrator/systemPrompt.ts' ? ${JSON.stringify(before)} + file : file)`);
const {fixture}=runFixture('test-turn-context-boundaries.cjs',context+'\nmodule.exports={fixture};');
const ts=require('typescript');
const taskSource=fs.readFileSync(path.join(root,prior?before:'','src/tasks/skill.ts'),'utf8');
const ast=ts.createSourceFile('skill.ts',taskSource,ts.ScriptTarget.Latest,true);
const method=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='TasksSkill').members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='getTools');
const taskCtx={result:null};
vm.runInNewContext(ts.transpileModule(`const APPROVAL_SUBKINDS=[]; class Capture { ${method.getText(ast)} } result=new Capture().getTools({user:{name:'Owner Example'}});`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,taskCtx);
test('approval tool contracts match canonical composition and contextual acceptance',()=>{
  const resolve=taskCtx.result.find(t=>t.name==='resolve_approval');
  const approval=taskCtx.result.find(t=>t.name==='create_approval');
  assert.match(resolve.description,/attributed contextual decision accepting the existing action/);
  assert.match(resolve.description,/omit `data` \(or pass \{\}\)/);
  assert.match(resolve.description,/amend or search is not approval of the old action/);
  assert.match(approval.description,/Concrete timed meeting asks render the structured reason and action clock/);
});
test('exact accepted instant contract and generic after grid both reach create schema',()=>{
  assert.match(create.input_schema.properties.start_is_explicit.description,/independently accepted\/approved exact instant/);
  assert.match(create.input_schema.properties.start_is_explicit.description,/Generic "after X" alone uses the grid/);
  assert.match(create.input_schema.properties.start_at_event_end_id.description,/independently accepted exact boundary/);
});
test('CONTROL offered slot remains preserved and generic anchor grid remains forward',()=>{
  assert.match(create.input_schema.properties.start_is_explicit.description,/find_available_slots/);
  assert.match(create.input_schema.properties.start_at_event_end_id.description,/FORWARD/);
  assert.match(create.input_schema.properties.start_at_event_end_id.description,/:00\/:15\/:30\/:45/);
});
for(const [label,input] of [['owner',{}],['colleague',{senderRole:'colleague',authority:'colleague',userId:'UACTIVE',surface:'colleague_dm'}],['email',{channel:'email'}]])test(`${label} actual prompt distinguishes work, future tracking and override heads-up`,async t=>{
  const r=await fixture(t).run({...input,userMessage:'Please check this.'});
  assert.match(r.prompt,/For immediate checking or outreach, call the matching available tool this turn/);
  assert.match(r.prompt,/Promise future work only after a tool successfully records that work/);
  assert.match(r.prompt,/preference update or calendar mutation records only its own action/);
  assert.match(r.prompt,/Existing accepted conflict overrides need only the returned heads-up/);
  assert.match(r.prompt,/state the time the tool actually returned/);
});
