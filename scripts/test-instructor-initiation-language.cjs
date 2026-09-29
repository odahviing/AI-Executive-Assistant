// Actual builder captures; assertions establish prompt inputs, not model obedience.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const before=process.argv.includes('--before');
const evidence=path.join(root,'artifacts/workshop-verification/wrap-5.0.1-20260929/repair/instructor');
const out=process.env.TEST_ARTIFACT_DIR||fs.mkdtempSync(path.join(require('node:os').tmpdir(),'maelle-initiation-prompt-'));
fs.mkdirSync(out,{recursive:true});
let passed=0,failed=0;
const check=(name,fn)=>{try{fn();passed++;console.log('ok '+name)}catch(e){failed++;console.log('not ok '+name+': '+e.message)}};
for(const lang of ['he','de']){
 const capture=path.join(out,`${before?'before':'after'}-${lang}.json`);
 const run=spawnSync(process.execPath,[path.join(__dirname,'test-instructor-v5-language.cjs'),'--source-root',before?path.join(evidence,'before'):root,'--owner-language',lang,'--capture',capture],{encoding:'utf8'});
 assert.equal(run.status,0,run.stdout+run.stderr);
 for(const [surface,p] of Object.entries(JSON.parse(fs.readFileSync(capture,'utf8')))){
  const id=lang+'/'+surface;
  console.log('METRICS '+id+' staticChars='+p.static.length);
  check(id+' unknown-initiation-English',()=>{assert.ok(p.static.includes('default to English if none'));assert.ok(!p.static.includes("default to Owner's language"));assert.ok(p.static.includes("ask_text in Owner's stored preferred language, or English if unknown."));});
  check(id+' known-preference-control',()=>assert.ok(p.static.includes('write THAT message in their `language_pref` if one is shown on their contact line')));
  check(id+' current-text-voice-control',()=>{assert.ok(p.static.includes("Reply in the language of THIS turn's message"));assert.ok(p.static.includes('Voice transcripts follow the same current-turn language rule.'));assert.ok(p.static.includes("mirror the sender's current-turn language only"));});
 }
}
console.log(JSON.stringify({passed,failed}));process.exitCode=failed?1:0;

