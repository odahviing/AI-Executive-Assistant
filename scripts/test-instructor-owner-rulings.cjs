// Structural captures only; no model obedience or live scheduling claim.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),snapshotDir=path.join(root,'artifacts/workshop-verification/owner-rulings-20260929/instructor');
// Optional producer export; default runs never overwrite another test's evidence.
const dir=process.env.TEST_ARTIFACT_DIR?path.resolve(process.env.TEST_ARTIFACT_DIR):fs.mkdtempSync(path.join(require('node:os').tmpdir(),'maelle-test-instructor-owner-rulings-'));
fs.mkdirSync(dir,{recursive:true});
let passed=0,failed=0;const check=(name,fn)=>{try{fn();passed++;console.log('ok '+name)}catch(e){failed++;console.log('not ok '+name+': '+e.message)}};
const before=process.argv.includes('--before');const sourceRoot=before?path.join(snapshotDir,'before'):root;
const file=path.join(__dirname,'test-instructor-meetings-contract.cjs'),m={exports:{}};
vm.runInNewContext(fs.readFileSync(file,'utf8').split('const tools = skill.getTools(profile);')[0]+'\nmodule.exports={skill,profile};',{require:createRequire(file),module:m,exports:m.exports,__dirname,process:{argv:['node',file,'--source-root',sourceRoot]},console});
for(const [tz,pref] of [['America/New_York','15:00-19:00'],['Europe/Paris','09:00-11:00']]){
 const p=m.exports.profile;p.user.timezone=tz;p.schedule.timezone_preferences={local_participants:'morning',remote_participants:pref};
 const text=m.exports.skill.getSystemPromptSection(p,undefined,true,'slack');
 console.log('METRICS '+tz+' chars='+text.length);
 check(tz+' preference truth regression',()=>{assert.ok(!text.includes('it overlaps better with their working day'));assert.ok(text.includes('returned slot ranking and earlier reasonable alternatives'));assert.ok(text.includes('actual hours and day quality within the requested window'));});
 check(tz+' ranked preference and validity control',()=>{assert.ok(!text.includes(`lean toward ${pref} Owner's time`));assert.ok(!text.includes('lean toward morning'));assert.ok(text.includes('Never refuse on a soft preference alone'));assert.ok(text.includes('find_available_slots ALREADY clips'));const finder=m.exports.skill.getTools(p).find(t=>t.name==='find_available_slots');assert.match(finder.description,/relative preference after validity checks/);assert.match(finder.description,/no booking authority or additional availability assurance/);assert.match(finder.description,/conflict, unknown-calendar and approval annotations/);});
 fs.writeFileSync(path.join(dir,(before?'before':'after')+'-meetings-'+tz.replace('/','-')+'.txt'),text);
}
const capturePath=path.join(dir,(before?'before':'after')+'-capture.json');
const captureRun=require('node:child_process').spawnSync(process.execPath,[path.join(__dirname,'test-instructor-v5-language.cjs'),'--source-root',sourceRoot,'--capture',capturePath],{encoding:'utf8'});
if(captureRun.error)throw captureRun.error;
assert.equal(captureRun.status,0,captureRun.stdout+'\n'+captureRun.stderr);
const captures=JSON.parse(fs.readFileSync(capturePath,'utf8'));
assert.deepEqual(Object.keys(captures),['owner-dm','colleague-dm','owner-mpim','colleague-channel','owner-email']);
for(const [surface,p] of Object.entries(captures)){
 check(surface+' voice current-language regression',()=>{assert.ok(!p.static.includes('ONE exception'));assert.ok(p.static.includes('Voice transcripts follow the same current-turn language rule.'));});
 check(surface+' reply and initiation controls',()=>{assert.ok(p.static.includes('LANGUAGE — CURRENT TURN WINS'));assert.ok(p.static.includes('preferred language is for INITIATING outreach'));});
}
console.log(JSON.stringify({passed,failed}));process.exitCode=failed?1:0;
