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
const amend=tool.description.split('- amend:')[1].split('\n  - OPEN')[0];
let passed=0,failed=0;
function check(id,fn){try{fn();passed++;console.log('ok '+id);}catch(e){failed++;console.log('not ok '+id+': '+e.message);}}
check('CT-R01 all explicit changed terms reach executable counter',()=>assert.match(amend,/every explicitly changed term in `counter` \(time, `is_online`, `location`, attendees\)/));
check('CT-R02 omitted terms preserve existing decision',()=>assert.match(amend,/omitted terms retain the stored decision/));
check('CT-P01 question and deferral remain amend not reject',()=>{assert.match(amend,/plus any question\/message|alternative \/ question \/ message/);assert.match(amend,/Use amend WHENEVER the instruction is relay-a-question \/ ask-them \/ defer — NOT reject/);});
check('CT-P02 colleague cannot silently amend by approve data',()=>{assert.match(tool.description,/A colleague accepts the stored counter with approve and no data/);assert.match(tool.description,/proposed changes use amend and need the owner's decision/);});
check('CT-P03 open conflict selection and unchanged duration remain',()=>{assert.match(tool.description,/counter=\{"new_start":"<ISO>"\}/);assert.match(tool.description,/add `new_end` only to change the duration/);});
check('CT-P04 existing schema and anchor controls remain',()=>{assert.deepEqual(tool.input_schema.properties.counter,{type:'object'});assert.deepEqual(tool.input_schema.required,['approval_id','verdict']);assert.match(tool.description,/No anchor and several open → call list_pending_approvals/);});
console.log('METRICS '+JSON.stringify({descriptionChars:tool.description.length,toolJsonChars:JSON.stringify(tool).length,tokenCount:'unavailable'}));
console.log(`${passed} passed; ${failed} failed`);process.exitCode=failed?1:0;
