// Actual tool-method capture only; no model obedience or live mutation claim.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('typescript'),assert=require('node:assert/strict');
const at=process.argv.indexOf('--source-file');
const file=at<0?path.join(__dirname,'../src/tasks/skill.ts'):path.resolve(process.argv[at+1]);
const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
const klass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='TasksSkill');
const method=klass.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='getTools');
const code=ts.transpileModule(`const APPROVAL_SUBKINDS=[]; class Captured { ${method.getText(ast)} } result=new Captured().getTools({user:{name:'Owner Example'}});`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const ctx={result:null};vm.runInNewContext(code,ctx);
const tool=JSON.parse(JSON.stringify(ctx.result)).find(t=>t.name==='resolve_approval');
const amend=tool.description.split('amend:')[1].split('\n\n')[0];
let passed=0,failed=0;
function check(id,fn){try{fn();passed++;console.log('ok '+id);}catch(e){failed++;console.log('not ok '+id+': '+e.message);}}
check('CT-R01 all explicit changed terms reach executable counter',()=>assert.match(amend,/changed terms \(time, participants, is_online, location\) and any question in counter/));
check('CT-R02 omitted terms preserve existing decision',()=>assert.match(amend,/omitted terms retain their stored values/));
check('CT-P01 question and deferral remain amend not reject',()=>{assert.match(amend,/counter or question/);assert.match(tool.description,/ask a question, defer, or negotiate remains open through amend/);});
check('CT-P02 colleague cannot silently amend by approve data',()=>assert.match(tool.description,/colleague can accept the stored counter without data; changing it requires the owner's decision/));
check('CT-P03 open conflict selection and unchanged duration remain',()=>{assert.match(amend,/open_options/);assert.match(amend,/counter.new_start and optional new_end/);assert.match(amend,/omitted terms retain their stored values/);});
check('CT-P04 existing schema and anchor controls remain',()=>{assert.deepEqual(tool.input_schema.properties.counter,{type:'object'});assert.deepEqual(tool.input_schema.required,['approval_id','verdict']);assert.match(tool.description,/explicit approval ID, bound thread or supplied contextual decision/);});
console.log('METRICS '+JSON.stringify({descriptionChars:tool.description.length,toolJsonChars:JSON.stringify(tool).length,tokenCount:'unavailable'}));
console.log(`${passed} passed; ${failed} failed`);process.exitCode=failed?1:0;
