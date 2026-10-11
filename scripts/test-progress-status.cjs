// Execute the actual status-hook branches with isolated transport dependencies.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ri=process.argv.indexOf('--source-revision'),revision=ri<0?null:process.argv[ri+1];
const results=[];
for(const file of ['src/core/orchestrator/buildTurnContext.ts','src/core/orchestrator/index.ts']){
 const source=revision?cp.execFileSync('git',['show',`${revision}:${file}`],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,file),'utf8');
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),hooks=[];
 function visit(n){if(ts.isIfStatement(n)&&n.expression.getText(ast).includes('input.app')&&n.thenStatement.getText(ast).includes('setAssistantStatus'))hooks.push(n);ts.forEachChild(n,visit);}visit(ast);assert.equal(hooks.length,1);
 const hook=ts.transpileModule(hooks[0].getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const [name,extra,expected] of [['scheduled',{interactive:false},0],['owner-existing',{},1],['colleague-existing',{senderRole:'colleague'},1],['room-existing',{surface:'room',isChannel:true},1],['missing-transport',{app:null},0],['unavailable-status',{unavailable:true},0]]){
  const id=`${file.includes('buildTurn')?'initial':'tool'}-${name}`,calls=[];
  const profile={user:{name:'Synthetic Owner'},assistant:{slack:{bot_token:'fixture'}}};
  const input={app:{},channelId:'D_SYNTHETIC',threadTs:extra.interactive===false?'routine_r1_1':'111.222',profile,...extra};
  try{vm.runInNewContext(hook,{input,profile,preferenceRead:false,toolUse:{name:'check_calendar_health'},require(name){if(name.endsWith('messaging')){if(extra.unavailable)throw Error('fixture unavailable');return {setAssistantStatus:async(...args)=>calls.push(args[2])};}if(name.endsWith('toolStatusText'))return {statusForTool:()=> 'Checking calendar'};throw Error(`Unexpected dependency ${name}`);}});assert.equal(calls.length,expected);if(expected)assert.equal(calls[0].threadTs,'111.222');results.push({id,status:'pass'});}catch(e){results.push({id,status:'fail',error:e.message});}
 }
}
console.log(JSON.stringify({beforeRevision:revision,passed:results.filter(x=>x.status==='pass').length,failed:results.filter(x=>x.status==='fail').length,cases:results},null,2));process.exitCode=results.some(x=>x.status==='fail')?1:0;
