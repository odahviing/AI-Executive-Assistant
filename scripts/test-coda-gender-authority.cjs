// Real Coda composer plus the actual pure authority functions from people.ts.
// Model, search, memory row I/O and claim checker are isolated fixtures.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const people=fs.readFileSync(path.join(root,'src/db/people.ts'),'utf8'),ast=ts.createSourceFile('people.ts',people,ts.ScriptTarget.Latest,true);
const authorityNodes=ast.statements.filter(n=>(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText()==='SET_BY_RANK'))||(ts.isFunctionDeclaration(n)&&['genderRank','authoritativeGender'].includes(n.name?.getText())));
assert.equal(authorityNodes.length,3,'actual authority dependency inventory');
const authority={exports:{}};vm.runInNewContext(compile(authorityNodes.map(n=>n.getText()).join('\n')),{module:authority,exports:authority.exports});
const source=process.env.CODA_GENDER_SOURCE||path.join(root,'src/core/social/generateCoda.ts'),code=compile(fs.readFileSync(source,'utf8'));
async function run(row,options={}) {
 const calls=[],reads=[],validator=[],warnings=[];
 const deps={
  '../../llm/client':{getAnthropicClient:()=>({messages:{create:async p=>{calls.push(p);return {content:[{type:'tool_use',input:{sentence:'שמעתי שיצא אלבום חדש.'}}]};}}})},
  '../../llm/models':{SONNET:{model:'fixture'}},'../../utils/usageLog':{logLlmUsage(){}},
  '../../utils/logger':{__esModule:true,default:{info(){},warn:(...a)=>warnings.push(a)}},
  '../../skills/general':{tavilySearch:async()=>({results:options.noGrounding?[]:[{title:'New album',url:'https://example.com/album',content:'A new album was released.'}]})},
  '../../db':{authoritativeGender:authority.exports.authoritativeGender,getPersonMemory:id=>{reads.push(id);if(options.readThrows)throw Error('fixture memory unavailable');return row;},getRecentChannelMessages:()=>[]},
  '../../db/socialSubjects':{getActiveSubjectsForPersonCategory:()=>[],getCategoryByLabel:()=>null,recordCategoryRaiseTried(){}},
  '../../utils/claimChecker':{checkReplyClaims:async p=>{validator.push(p);return {claimed_action:false};}},
 };
 const mod={exports:{}};vm.runInNewContext(code,{module:mod,exports:mod.exports,require:name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name];}});
 const output=await mod.exports.composeSocialCoda({directive:{mode:'raise_new',categoryLabel:'music'},personSlackId:'URECIPIENT',senderRole:options.role||'colleague',senderFirstName:'Recipient',language:options.language||'he'},{user:{slack_user_id:'UOWNER',name:'Owner'},assistant:{name:'Maelle'}});
 return {output,calls,reads,validator,warnings,prompt:calls[0]?.messages[0].content};
}
for(const [label,row,expected] of [
 ['owner authoritative female',{name:'Recipient',gender:'female',gender_set_by:'owner'},'female'],
 ['person authoritative male',{name:'Recipient',gender:'male',gender_set_by:'person'},'male'],
 ['legacy confirmation',{name:'Recipient',gender:'female',gender_set_by:'auto',gender_confirmed:1},'female'],
 ['automatic guess',{name:'Recipient',gender:'male',gender_set_by:'auto'},'unknown'],
 ['unattributed stored guess',{name:'Recipient',gender:'female'},'unknown'],
 ['explicit unknown',{name:'Recipient',gender:'unknown',gender_set_by:'owner'},'unknown'],
 ['missing row',null,'unknown'],
])test(label+' reaches existing Coda request through actual authority reader',async()=>{const h=await run(row);assert.ok(h.prompt.includes(`Recipient's authoritative gender: ${expected}.`));assert.equal(h.calls.length,1);assert.equal(h.validator.length,1);assert.ok(h.reads.every(id=>id==='URECIPIENT'));assert.ok(h.output);assert.ok(!JSON.stringify(h.output).includes('authoritative gender'));});
test('owner Coda uses person-of-turn authoritative gender',async()=>{const h=await run({name:'Recipient',gender:'female',gender_set_by:'person'},{role:'owner'});assert.match(h.prompt,/authoritative gender: female/);assert.ok(h.reads.every(id=>id==='URECIPIENT'));});
test('unavailable memory is explicit unknown without another model call',async()=>{const h=await run(null,{readThrows:true});assert.match(h.prompt,/authoritative gender: unknown/);assert.equal(h.calls.length,1);assert.ok(h.output);});
test('legitimate English Coda retains language and single composition call',async()=>{const h=await run({gender:'female',gender_set_by:'person'},{language:'en'});assert.match(h.prompt,/Write the coda in English/);assert.equal(h.calls.length,1);assert.ok(h.output);});
test('legitimate no-grounding path does not compose or validate',async()=>{const h=await run({gender:'male',gender_set_by:'owner'},{noGrounding:true});assert.equal(h.output,null);assert.equal(h.calls.length,0);assert.equal(h.validator.length,0);});
test('structural Hebrew guidance uses authoritative input or neutral forms',async()=>{const h=await run({gender:'female',gender_set_by:'auto'});assert.match(h.prompt,/authoritative gender: unknown/);assert.match(h.prompt,/if unknown, use neutral phrasing/);assert.match(h.prompt,/without masculine defaults or slash forms/);assert.match(h.prompt,/Hebrew throughout/);});
