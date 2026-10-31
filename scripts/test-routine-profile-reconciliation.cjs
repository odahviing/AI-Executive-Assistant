// Real schedule computation and SQLite reconciliation; no network or live state.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('typescript'),Database=require('better-sqlite3'),{DateTime,Settings}=require('luxon');
const root=path.resolve(__dirname,'..'),before=process.argv.includes('--before');
const base=before?path.join(root,'artifacts/workshop-verification/batch-20261029/handyman/before'):root;
function load(file,deps){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(base,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports:m.exports,require:n=>{assert.ok(n in deps,'unexpected import '+n);return deps[n];},Date});return m.exports;}
const profile={user:{slack_user_id:'OWNER',timezone:'America/New_York'},schedule:{office_days:{days:['Monday','Tuesday','Thursday']},home_days:{days:['Wednesday','Friday']}}};
function fixture(rows){
 const db=new Database(':memory:');db.exec('CREATE TABLE routines(id TEXT PRIMARY KEY,owner_user_id TEXT,status TEXT,title TEXT,schedule_type TEXT,schedule_time TEXT,schedule_day TEXT,next_run_at TEXT,updated_at TEXT); CREATE TABLE tasks(id TEXT, status TEXT); INSERT INTO tasks VALUES (\'interrupted\',\'in_progress\')');
 for(const [id,opts] of Object.entries(rows))db.prepare('INSERT INTO routines VALUES(?,?,?,?,?,?,?,?,?)').run(id,opts.owner||'OWNER',opts.status||'active',id,opts.type||'weekdays',opts.time||'13:00',opts.day||null,opts.next===undefined?'2026-11-01T11:00:00Z':opts.next,'untouched');
 const errors=[],log={info(){},warn(){},debug(){},error(...v){errors.push(v);}};
 const crons=load('src/tasks/crons.ts',{'luxon':{DateTime},'../db':{getDb:()=>db},'../utils/logger':log});
 const mat=load('src/tasks/routineMaterializer.ts',{'luxon':{DateTime},'../db':{getDb:()=>db},'./crons':crons,'./lateness':{},'./index':{},'../connections/registry':{},'../utils/logger':log});
 const background=load('src/core/background.ts',{'../tasks/runner':{},'../tasks/routineMaterializer':mat,'../tasks/crons':{ensureBriefingCron(){},updateBriefingCronChannel(){}},'../tasks/dispatchers/routine':{},'../utils/logger':log,'../connections/slack/eligibility':{},'../db/slackCatchup':{},'../connectors/slack/threadHistory':{},'../connectors/slack/deliveryAttempt':{},'../db/client':{getDb:()=>db},'../db/migrations/v2_9_3_calendar_health_twice_daily':{runV293CalendarHealthTwiceDaily(){}},'../db/socialSubjects':{ensureCategoriesSeeded(){}},'../db/engagementRank':{migrateLegacyEngagementLevel(){}},'../db':{getDb:()=>({prepare:()=>({run:()=>({changes:0})})})}});
 return {db,errors,boot:()=>background.initProfile({},profile,'DM'),row:id=>db.prepare('SELECT * FROM routines WHERE id=?').get(id),run:()=> (mat.reconcileRoutineSchedules||mat.backfillNullNextRunAt)(profile)};
}
const cases=[];function test(id,fn){cases.push({id,fn});}
test('profile-startup-reconciles-health',async()=>{const f=fixture({health:{}});try{await f.boot();assert.equal(f.row('health').next_run_at,'2026-10-30T17:00:00.000Z');await f.boot();assert.equal(f.errors.length,0);}finally{f.db.close();}});
test('boston-weekdays-future-cursor',()=>{const f=fixture({health:{}});try{assert.equal(f.run(),1);assert.equal(f.row('health').next_run_at,'2026-10-30T17:00:00.000Z');assert.equal(f.row('health').schedule_time,'13:00');assert.equal(f.run(),0);assert.equal(f.db.prepare('SELECT status FROM tasks').get().status,'in_progress');}finally{f.db.close();}});
test('invalid-cursor-repaired',()=>{const f=fixture({bad:{next:'invalid'}});try{f.run();assert.equal(f.row('bad').next_run_at,'2026-10-30T17:00:00.000Z');}finally{f.db.close();}});
test('missing-cursor-repaired',()=>{const f=fixture({missing:{next:null}});try{assert.equal(f.run(),1);assert.equal(f.row('missing').next_run_at,'2026-10-30T17:00:00.000Z');assert.equal(f.run(),0);}finally{f.db.close();}});
test('overdue-and-exact-now-retained',()=>{const f=fixture({overdue:{next:'2026-10-28T11:00:00Z'},due:{next:'2026-10-29T17:08:30Z'}});try{assert.equal(f.run(),0);assert.equal(f.row('overdue').next_run_at,'2026-10-28T11:00:00Z');assert.equal(f.row('due').updated_at,'untouched');}finally{f.db.close();}});
test('paused-deleted-other-owner-retained',()=>{const f=fixture({paused:{status:'paused'},deleted:{status:'deleted'},other:{owner:'OTHER'}});try{assert.equal(f.run(),0);for(const id of ['paused','deleted','other'])assert.equal(f.row(id).updated_at,'untouched');}finally{f.db.close();}});
test('correct-cursors-no-writes',()=>{const f=fixture({same:{next:'2026-10-30T17:00:00Z'}});try{assert.equal(f.run(),0);assert.equal(f.row('same').updated_at,'untouched');}finally{f.db.close();}});
for(const [id,opts,expected] of [
 ['daily-multitime',{type:'daily',time:'07:30,18:00'},'2026-10-29T22:00:00.000Z'],
 ['weekly-explicit-sunday',{type:'weekly',day:'Sunday'},'2026-11-01T18:00:00.000Z'],
 ['monthly-31-skip',{type:'monthly',day:'31',next:'2026-12-31T11:00:00Z'},'2026-10-31T17:00:00.000Z'],
])test(id,()=>{const f=fixture({r:opts});try{f.run();assert.equal(f.row('r').next_run_at,expected);assert.equal(f.row('r').schedule_day,opts.day||null);assert.equal(f.row('r').schedule_time,opts.time||'13:00');}finally{f.db.close();}});
test('failed-write-retries-without-side-effects',()=>{const f=fixture({r:{next:null}});try{f.db.exec("CREATE TRIGGER refuse BEFORE UPDATE ON routines BEGIN SELECT RAISE(ABORT,'unavailable'); END");assert.equal(f.run(),0);assert.equal(f.row('r').next_run_at,null);assert.equal(f.errors.length,1);f.db.exec('DROP TRIGGER refuse');assert.equal(f.run(),1);assert.equal(f.run(),0);}finally{f.db.close();}});
test('malformed-row-isolated',()=>{const f=fixture({bad:{time:'25:99'},good:{next:null}});try{f.run();assert.equal(f.row('bad').updated_at,'untouched');assert.equal(f.row('good').next_run_at,'2026-10-30T17:00:00.000Z');}finally{f.db.close();}});
(async()=>{Settings.now=()=>Date.parse('2026-10-29T17:08:30Z');
const results=[];for(const c of cases){try{await c.fn();results.push({id:c.id,status:'pass'});}catch(e){results.push({id:c.id,status:'fail',error:e.message});}}
Settings.now=()=>Date.now();const report={phase:before?'before':'after',passed:results.filter(c=>c.status==='pass').length,failed:results.filter(c=>c.status==='fail').length,cases:results};console.log(JSON.stringify(report,null,2));process.exitCode=report.failed?1:0;})();
