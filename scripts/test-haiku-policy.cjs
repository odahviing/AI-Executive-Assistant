const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('assert');
const cp=require('child_process');
const arg=process.argv.indexOf('--source-revision');
const revision=arg<0?null:process.argv[arg+1];
function read(file){return revision?cp.execFileSync('git',['show',revision+':'+file],{encoding:'utf8'}):fs.readFileSync(file,'utf8');}
function load(file,mocks={}){const exp={};const js=ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;vm.runInNewContext(js,{exports:exp,require:id=>mocks[id]||require(id),console});return exp;}
const models=load('src/llm/models.ts');
const mod=load('src/core/threadActions/index.ts',{'../../llm/models':models,'../../db':{},'../../utils/logger':{default:{info(){},warn(){}}},'../../utils/usageLog':{logLlmUsage(){}}});
let passed=0,failed=0;async function test(id,fn){try{await fn();console.log('PASS '+id);passed++;}catch(e){console.log('FAIL '+id+' '+e.message);failed++;}}
(async()=>{await test('haiku-explicit-no-thinking',()=>assert.equal(models.HAIKU?.thinking.type,'disabled'));await test('sonnet5.5-model',()=>assert.equal(models.MODEL_SONNET,'claude-sonnet-5-5'));await test('sonnet5.5-policy',()=>assert.equal(models.SONNET.thinking.type,'between_tools'));await test('haiku5.5-model',()=>assert.equal(models.MODEL_HAIKU,'claude-haiku-5-5'));let request;
const args={mentionText:'קבע פגישה',threadContext:'',profile:{assistant:{name:'Maelle'}},anthropic:{messages:{create:async p=>{request=p;return {content:[{type:'tool_use',input:{action:'book'}}]};}}}};
await test('thread-classification-preserved',async()=>assert.equal(await mod.classifyThreadAction(args),'book'));
await test('thread-request-no-thinking',()=>assert.equal(request.thinking?.type,'disabled'));
await test('thread-forced-tool-preserved',()=>assert.equal(request.tool_choice.name,'classify_thread_action'));
await test('empty-mention-no-call',async()=>assert.equal(await mod.classifyThreadAction({...args,mentionText:' '}),'unclear'));
await test('dependency-failure-preserved',async()=>assert.equal(await mod.classifyThreadAction({...args,anthropic:{messages:{create:async()=>{throw Error('offline')}}}}),'other'));
await test('owner-presence-reject',()=>assert.equal(mod.ownerPostedInThread([{user:'colleague'}],'owner'),false));
await test('owner-presence-accept',()=>assert.equal(mod.ownerPostedInThread([{user:'owner'}],'owner'),true));
console.log(JSON.stringify({passed,failed}));process.exitCode=failed?1:0;})();

