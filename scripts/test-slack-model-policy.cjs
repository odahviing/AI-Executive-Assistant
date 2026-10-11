// Execute the real Slack Haiku consumers with isolated model I/O.
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),cp=require('node:child_process');
const ix=process.argv.indexOf('--source-revision'),revision=ix<0?null:process.argv[ix+1];
const models=require('./load-test-models.cjs');
let request,answer='HUMAN',unavailable=false,passed=0,failed=0;
function load(file){const source=revision?cp.execFileSync('git',['show',`${revision}:${file}`],{encoding:'utf8'}):fs.readFileSync(file,'utf8');const exports={};const mocks={'../llm/models':models,'../llm/client':{getAnthropicClient:()=>({messages:{create:async p=>{request=p;if(unavailable)throw Error('offline');return {content:[{type:'text',text:answer}]};}}})},'../utils/usageLog':{logLlmUsage(){}},'../utils/logger':{default:{warn(){}}},'./logger':{default:{warn(){}}},'@anthropic-ai/sdk':{}};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>{assert.ok(n in mocks,n);return mocks[n];},Buffer});return exports;}
const addressee=load('src/utils/addresseeGate.ts'),vision=load('src/vision/index.ts');
async function check(id,fn){try{await fn();passed++;console.log('PASS '+id);}catch(e){failed++;console.log('FAIL '+id+' '+e.message);}}
(async()=>{
const args={text:'אפשר להזיז למחר?',botUserId:'UBOT',assistantName:'Maelle',ownerFirstName:'Owner'};
await check('human-classification-preserved',async()=>assert.equal(await addressee.classifyAddressee(args),'HUMAN'));
await check('addressee-explicit-disabled',()=>assert.equal(request.thinking?.type,'disabled'));
await check('addressee-budget-preserved',()=>assert.equal(request.max_tokens,12));
await check('explicit-bot-mention-no-call',async()=>{request=null;assert.equal(await addressee.classifyAddressee({...args,text:'<@UBOT>'}),'MAELLE');assert.equal(request,null);});
answer='MAELLE';await check('assistant-classification-preserved',async()=>assert.equal(await addressee.classifyAddressee(args),'MAELLE'));
answer='unknown';await check('ambiguous-preserved',async()=>assert.equal(await addressee.classifyAddressee(args),'AMBIGUOUS'));
unavailable=true;await check('addressee-unavailable-silent',async()=>assert.equal(await addressee.classifyAddressee(args),'AMBIGUOUS'));
unavailable=false;answer='Meeting tomorrow';await check('image-description-preserved',async()=>assert.equal(await vision.describeImage({type:'image'}),'Meeting tomorrow'));
await check('vision-explicit-disabled',()=>assert.equal(request.thinking?.type,'disabled'));
await check('vision-budget-preserved',()=>assert.equal(request.max_tokens,220));
answer='';await check('image-empty-null',async()=>assert.equal(await vision.describeImage({type:'image'}),null));
unavailable=true;await check('image-unavailable-null',async()=>assert.equal(await vision.describeImage({type:'image'}),null));
console.log(JSON.stringify({passed,failed}));process.exitCode=failed?1:0;
})();
