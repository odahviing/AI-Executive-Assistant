// Isolated actual-module audit: no live YAML, database or outbound services.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const weekdays = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
function profile(zone = 'America/New_York') {
  return { user: { name:'Alice Smith', email:'alice@company.com', timezone:zone, slack_user_id:'UOWNER' },
    assistant:{ name:'Maelle', slack:{bot_token:'xoxb-fixture',app_token:'xapp-fixture',signing_secret:'fixture-secret'} },
    schedule:{ office_days:{days:['Monday','Tuesday','Thursday']}, home_days:{days:['Wednesday','Friday']},
      work_hours:{Monday:['09:00-17:00'],Tuesday:['09:00-17:00'],Wednesday:['08:00-17:00'],Thursday:['09:00-17:00'],Friday:['08:00-17:00']},
      timezone_preferences:{local_participants:'Prefer Israel morning',remote_participants:'Prefer US morning'} } };
}
function load(file, mocks) {
  const module = {exports:{}};
  const source = fs.readFileSync(path.join(root,file),'utf8');
  const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{process:{cwd:()=>'/fixture',env:{}},console})(name => {
    if (Object.hasOwn(mocks,name)) return mocks[name];
    if (['path','zod','js-yaml','luxon'].includes(name)) return require(name);
    throw Error(`Unexpected dependency ${name}`);
  },module,module.exports);
  return module.exports;
}
function fixture(input=profile()) {
  let current = input;
  const exports=load('src/config/userProfile.ts',{fs:{existsSync:()=>true,readFileSync:()=>JSON.stringify(current),readdirSync:()=>['owner.yaml']},'../utils/logger':{info(){},error(){}}});
  return {...exports, replace:value=>{current=value;}};
}
test('exact Boston canonical hours, office/home classification and priority text survive loader',()=>{
  const p=fixture().loadUserProfile('owner');
  assert.deepEqual(JSON.parse(JSON.stringify(p.schedule.work_hours)),profile().schedule.work_hours);
  assert.equal(p.schedule.work_hours.Saturday,undefined);
  assert.equal(p.schedule.work_hours.Sunday,undefined);
  assert.equal(p.schedule.timezone_preferences.local_participants,'Prefer Israel morning');
});
test('legacy Boston hours normalize and old input fields disappear',()=>{
  const input=profile(); delete input.schedule.work_hours;
  Object.assign(input.schedule.office_days,{hours_start:'09:00',hours_end:'17:00'});
  Object.assign(input.schedule.home_days,{hours_start:'08:00',hours_end:'17:00'});
  const p=fixture(input).loadUserProfile('owner');
  assert.equal(p.schedule.work_hours.Wednesday[0],'08:00-17:00');
  assert.equal(p.schedule.office_days.hours_start,undefined);
});
test('same process cache keeps old profile; new process fixture applies later edit',()=>{
  const f=fixture(), first=f.loadUserProfile('owner'), edited=profile();
  edited.schedule.work_hours.Wednesday=['10:00-16:00']; f.replace(edited);
  assert.equal(f.loadAllProfiles().get('owner'),first);
  assert.equal(f.getProfileByEmail('ALICE@company.com'),first);
  assert.equal(fixture(edited).loadUserProfile('owner').schedule.work_hours.Wednesday[0],'10:00-16:00');
});
test('no effective date mechanism: unrecognized future metadata is stripped; Boston applies immediately',()=>{
  const input=profile(); input.schedule.effective_from='2026-11-03';
  const p=fixture(input).loadUserProfile('owner');
  assert.equal(p.schedule.effective_from,undefined);
  assert.equal(p.user.timezone,'America/New_York');
  // Neither Nov2 nor Nov3 changes the loaded value: loader has no date input.
  for (const day of ['2026-11-02','2026-11-03']) assert.equal(DateTime.fromISO(day,{zone:p.user.timezone}).zoneName,'America/New_York');
});
test('missing work hours fail explicitly',()=>{
  const input=profile(); delete input.schedule.work_hours;
  assert.throws(()=>fixture(input).loadUserProfile('owner'),/no work_hours/);
});
test('routine Boston workdays skip weekends and accept later weekday edits',()=>{
  const c=load('src/tasks/crons.ts',{'../db':{},'../utils/logger':{}});
  const start=DateTime.fromISO('2026-11-06T18:00',{zone:'America/New_York'});
  assert.equal(c.computeNextRunAt('weekdays','07:30',null,'America/New_York',start,weekdays),'2026-11-09T12:30:00.000Z');
  assert.equal(c.computeNextRunAt('weekdays','07:30',null,'America/New_York',start,['Tuesday']),'2026-11-10T12:30:00.000Z');
});
