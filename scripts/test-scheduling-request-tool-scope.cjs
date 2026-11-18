const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const assert=require('node:assert/strict'),{test}=require('node:test');
const root=process.env.REQUEST_SCOPE_BEFORE_ROOT||path.resolve(__dirname,'..');
const file=path.join(root,'src/skills/registry.ts'),source=fs.readFileSync(file,'utf8');
const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
const names=new Set(['ALWAYS_ON_TOOLS','SCOPE_TO_TOOLS','CHANNEL_TOOL_CLAMP','COLLEAGUE_ALLOWED_TOOLS']);
const nodes=tree.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='filterToolsByScope'||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>names.has(d.name.getText(tree))));
const js=ts.transpileModule(nodes.map(n=>n.getText(tree)).join('\n')+'\nexports.filter=filterToolsByScope;exports.colleague=COLLEAGUE_ALLOWED_TOOLS;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const exportsOut={};vm.runInNewContext(js,{exports:exportsOut,logUnmappedToolOnce(){}});
const tools=['get_my_tasks','get_calendar','list_pending_approvals','update_task','create_meeting'].map(name=>({name}));
for(const scope of ['meetings','calendar'])test('owner scheduling can inspect tracked work: '+scope,()=>{
 const names=exportsOut.filter(tools,[scope]).map(t=>t.name);
 assert.ok(names.includes('get_my_tasks'));assert.ok(names.includes('list_pending_approvals'));
 assert.ok(!names.includes('update_task'),'status lookup does not add unrelated task writes');
});
test('unrelated topic does not add scheduling task history',()=>assert.ok(!exportsOut.filter(tools,['knowledge']).some(t=>t.name==='get_my_tasks')));
test('email transport still excludes owner work history',()=>assert.ok(!exportsOut.filter(tools,['meetings'],'email').some(t=>t.name==='get_my_tasks')));
test('colleague allowlist still excludes owner work history',()=>assert.ok(!exportsOut.colleague.has('get_my_tasks')));
