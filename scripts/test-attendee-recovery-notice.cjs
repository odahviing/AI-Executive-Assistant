// Exercise the production recovery closure with captured calendar IO.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

const file=path.join(__dirname,'../src/skills/meetings/ops/handlers/findAvailableSlots.ts');
const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
let recovery;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source)==='recoverAttendeeBlockedSlots') recovery=node.initializer.getText(source);
  ts.forEachChild(node,visit);
}
visit(source);
assert.ok(recovery,'production recovery closure found');
const js=ts.transpileModule('const recover='+recovery+'; recover;',{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
for (const audience of ['owner_tagged','colleague_owner_only']) {
  for (const leadHours of [0.5,4]) test(`${audience} preserves the caller's ${leadHours} hour booking notice`,async()=>{
    let captured;
    const scope={findAvailableSlots:async args=>{captured=args;return [];},
      userEmail:'owner@example.invalid',timezone:'UTC',args:{duration_minutes:25},
      attendeeEmails:['peer@example.invalid'],attendeeAvailability:[],
      effectiveSearchFrom:'2026-12-01',effectiveSearchTo:'2026-12-01',requestedTimeWindow:undefined,
      mode:'either',leadHours,viewer:'colleague',viewerEmail:'peer@example.invalid',
      context:{profile:{}},excludeEventIdsForSearch:undefined,attendeeRecoveryDiagnostics:{},
      bookingLeadTimeHours:()=>0.5};
    const recover=vm.runInNewContext(js,scope);
    await recover(audience);
    assert.equal(captured.minBufferHours,leadHours);
    assert.equal(captured.relaxed,false);
    assert.equal(captured.tagAttendeeConflicts,true);
    assert.equal(captured.autoExpand,false);
  });
}
