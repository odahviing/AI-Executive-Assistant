// Entire actual modules with explicit isolated dependencies and the real central bundle.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),models=require('./fixtures/registrar-models.cjs');
function load(file,exportName,response,options={}){
 const payloads=[],usage=[],base=process.env.REGISTRAR_MODELS_BEFORE_ROOT;
 const sourcePath=base&&fs.existsSync(path.join(base,file))?path.join(base,file):path.join(root,file);
 let source=fs.readFileSync(sourcePath,'utf8');if(exportName)source+='\nexport { '+exportName+' };';
 const mocks={
  'llm/models':models,'llm/client':{getAnthropicClient:()=>({messages:{create:async p=>{payloads.push(p);if(options.failure)throw Error('fixture unavailable');return response;}}})},
  'utils/logger':{__esModule:true,default:{warn(){},info(){},debug(){},error(){}}},'utils/usageLog':{logLlmUsage:(...p)=>usage.push(p)},
  'utils/extractJson':{extractFirstJsonObject:s=>s,parseFirstJsonObject:JSON.parse},
  'db/requests':{getOpenScannerItems:()=>[{id:'req_fixture',kind:'approval',state:'awaiting_owner',subject:'Fixture request'}]},
  'core/requests/types':{parseDetails:()=>({})},
 };
 const dependencies=[];const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);for(const n of ast.statements)if(ts.isImportDeclaration(n))dependencies.push(n.moduleSpecifier.text);
 const mod={exports:{}};
 const req=s=>{if(s==='luxon')return require('luxon');if(s.startsWith('node:'))return require(s);const k=s.replace(/^(\.\.\/|\.\/)+/,'');if(Object.hasOwn(mocks,k))return mocks[k];if(k==='logger')return mocks['utils/logger'];if(k==='usageLog')return mocks['utils/usageLog'];if(k==='extractJson')return mocks['utils/extractJson'];assert.ok(dependencies.includes(s),'unexpected import '+s);return {};};
 vm.runInNewContext('(function(require,module,exports){'+ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+'\n})',{Date,Set,Map})(req,mod,mod.exports);
 return {module:mod.exports,payloads,usage};
}
const cases=[
 {name:'freeform',file:'src/tasks/skill.ts',fn:'classifyFreeformCalendarChange',args:['Move meeting','Fixture context','Meeting'],response:{content:[{type:'tool_use',input:{verdict:'calendar'}}]},expected:'calendar',fallback:'unsure',budget:20,tool:'classify'},
 {name:'OOF',file:'src/core/requests/colleagueOofReengage.ts',fn:'classifyOofReengageReply',args:[{subjectLabel:'Meeting',reply:'כן',colleagueName:'Colleague',assistantName:'Maelle',ownerName:'Owner'}],response:{content:[{type:'tool_use',input:{status:'yes'}}]},expected:'yes',fallback:'checking',budget:30,tool:'classify_reply'},
];
for(const c of cases){
 test('208 '+c.name+' payload retains disabled thinking, forced tool and budget',async()=>{const h=load(c.file,c.fn,c.response);assert.equal(await h.module[c.fn](...c.args),c.expected);assert.equal(h.payloads.length,1);const p=h.payloads[0];assert.equal(p.model,models.MODEL_HAIKU);assert.equal(p.thinking?.type,'disabled');assert.equal(p.max_tokens,c.budget);assert.equal(p.tool_choice.type,'tool');assert.equal(p.tool_choice.name,c.tool);if(c.name==='freeform')assert.equal(h.usage[0][1],models.MODEL_HAIKU);});
 test(c.name+' unavailable classifier retains conservative fallback',async()=>{const h=load(c.file,c.fn,c.response,{failure:true});assert.equal(await h.module[c.fn](...c.args),c.fallback);});
 test(c.name+' malformed output retains conservative fallback',async()=>{const h=load(c.file,c.fn,{content:[]});assert.equal(await h.module[c.fn](...c.args),c.fallback);});
}
test('208 scanner retains disabled thinking, budget and usage identity',async()=>{const h=load('src/utils/closeLoopOnOwnerHandled.ts',null,{content:[{type:'text',text:'{"closed_items":[]}'}]});const result=await h.module.closeLoopOnOwnerHandled({profile:{user:{slack_user_id:'OWNER'}},ownerMessage:'Fixture request handled'});assert.equal(result.scanned,true);assert.equal(h.payloads.length,1);assert.equal(h.payloads[0].thinking?.type,'disabled');assert.equal(h.payloads[0].max_tokens,400);assert.equal(h.usage[0][1],models.MODEL_HAIKU);assert.equal(result.closedItems.length,0);});
test('scanner unavailable classification closes nothing',async()=>{const h=load('src/utils/closeLoopOnOwnerHandled.ts',null,{}, {failure:true});const result=await h.module.closeLoopOnOwnerHandled({profile:{user:{slack_user_id:'OWNER'}},ownerMessage:'Fixture request handled'});assert.equal(result.closedItems.length,0);});
test('reschedule uses actual Sonnet policy with preserved response parsing',async()=>{const h=load('src/skills/meetingReschedule.ts','classifyRescheduleReply',{content:[{type:'text',text:'{"status":"checking"}'}]});const result=await h.module.classifyRescheduleReply({reply:'בודק'});assert.equal(result.status,'checking');assert.equal(h.payloads[0].model,models.MODEL_SONNET);assert.equal(h.payloads[0].thinking.type,'between_tools');assert.equal(h.payloads[0].max_tokens,200);assert.equal(h.payloads[0].tool_choice,undefined);});
test('dedup uses actual Sonnet policy and rejects unknown candidate id',async()=>{const h=load('src/utils/requestDedup.ts',null,{content:[{type:'text',text:'{"match":"existing","existing_id":"unseen"}'}]});const result=await h.module.judgeRequestDedup({proposed:{kind:'approval',subject:'Fixture'},candidates:[{id:'req_fixture',created_at:new Date().toISOString(),subject:'Fixture',kind:'approval',state:'awaiting_owner'}]});assert.equal(result.match,'new');assert.equal(h.payloads[0].model,models.MODEL_SONNET);assert.equal(h.payloads[0].thinking.type,'between_tools');assert.equal(h.payloads[0].max_tokens,250);assert.equal(h.payloads[0].tool_choice,undefined);});
