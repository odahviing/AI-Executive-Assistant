const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function resolve(names,people){
 const mod={exports:{}},code=ts.transpileModule(fs.readFileSync('src/memory/resolveAttendeeEmails.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const deps={'../utils/logger':{default:{warn(){}}},'../db/people':{getPersonMemory:id=>people.find(p=>p.slack_id===id),searchPeopleMemory:()=>people,getPersonByEmail:email=>people.find(p=>p.email===email)}};
 vm.runInNewContext('(function(require,module,exports){'+code+'})')((id)=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports);
 return JSON.parse(JSON.stringify(mod.exports.resolveNamedInternalAttendees({names,ownerEmail:'owner@company.test'})));
}
const guest={name:'Gidon Pely',slack_id:'UV1C4UU00',email:'gidon.pely@gmail.com'};
test('literal workspace mention resolves its stored address across mail domains',()=>assert.deepEqual(resolve(['<@UV1C4UU00>'],[guest]),{resolved:[{name:guest.name,email:guest.email}],unresolved:[]}));
test('unambiguous workspace name uses the same identity as its mention',()=>assert.equal(resolve(['Gidon'],[guest]).resolved[0].email,guest.email));
test('another same-named workspace member remains ambiguous',()=>assert.deepEqual(resolve(['Gidon'],[guest,{name:'Gidon Other',slack_id:'U1234567',email:'other@company.test'}]).unresolved,['Gidon']));
test('unknown mention and substring matches do not guess a recipient',()=>{assert.equal(resolve(['<@U7654321>'],[guest]).resolved.length,0);assert.equal(resolve(['Gid'],[guest]).resolved.length,0)});
test('external-only name without workspace identity remains unresolved',()=>assert.deepEqual(resolve(['Gidon'],[{name:guest.name,email:guest.email}]).unresolved,['Gidon']));

test('a human-supplied external address resolves without guessing a directory identity',()=>{
 assert.deepEqual(resolve(['hello@partner.test'],[]),{resolved:[{name:'hello@partner.test',email:'hello@partner.test'}],unresolved:[]});
});

test('a complete directory mailbox spelling identifies the same uniquely stored person',()=>{
 const p={name:'Ayala Geni',email:'ayalla.g@company.test',slack_id:'U1234567'};
 assert.equal(resolve(['Ayalla'],[p]).resolved[0].email,p.email);
 assert.deepEqual(resolve(['Aya','g'],[p]).unresolved,['Aya','g']);
 assert.deepEqual(resolve(['Ayalla'],[p,{name:'Ayalla Other',email:'other@company.test',slack_id:'U7654321'}]).unresolved,['Ayalla']);
});
