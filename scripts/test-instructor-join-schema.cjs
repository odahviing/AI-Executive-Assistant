const fs=require('fs'),ts=require('typescript'),vm=require('vm'),assert=require('assert/strict'),{test}=require('node:test');
const file=process.env.INSTRUCTOR_BEFORE?'artifacts/workshop-verification/owner-batch-20260930/instructor/meetings.before.ts':'src/skills/meetings.ts';
const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);let body;
function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(source)==='getTools')body=n.body.getText(source);ts.forEachChild(n,visit);}visit(source);
const js=ts.transpileModule('module.exports=function(profile)'+body,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;const m={exports:{}};vm.runInNewContext(js,{module:m,exports:m.exports});
const tool=m.exports({user:{name:'Owner'},categories:[],meetings:{allowed_durations:[30,60]}}).find(t=>t.name==='check_join_availability');
test('join schema exposes optional presentation zone and verbatim renderer guidance',()=>{assert.equal(tool.input_schema.properties.present_in_timezone.type,'string');assert.ok(!tool.input_schema.required.includes('present_in_timezone'));assert.match(tool.description,/Quote presentation_local verbatim/);});
test('join required inputs preserved',()=>assert.deepEqual(Array.from(tool.input_schema.required),['meeting_start','duration_min','subject','requester_name']));
console.log('schema_chars='+JSON.stringify(tool).length);


