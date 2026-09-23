// Actual profile initialization, task store, dispatcher registry and runner;
// real isolated SQLite, with unrelated domain handlers and external IO mocked.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),Database=require('better-sqlite3');
const root=path.resolve(__dirname,'..'),before=process.argv.includes('--before');
const source=rel=>{
 const file=path.join(root,'artifacts/workshop-verification/v5-readiness-20260923/handyman/summary-retirement1/before',rel);
 return fs.readFileSync(before&&fs.existsSync(file)?file:path.join(root,rel),'utf8');
};
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,owner_user_id TEXT,owner_channel TEXT,type TEXT,status TEXT,title TEXT,routine_id TEXT,context TEXT,due_at TEXT,updated_at TEXT,completed_at TEXT);
 CREATE TABLE requests(id TEXT PRIMARY KEY,state TEXT,next_check_handler TEXT);
 CREATE TABLE outreach_jobs(id TEXT PRIMARY KEY,sent_at TEXT,message TEXT);
 INSERT INTO requests VALUES('unrelated-queued','in_flight','send_scheduled_outreach');
 INSERT INTO outreach_jobs VALUES('existing-sent','2026-01-01','already sent conversation');`);
 const insert=db.prepare("INSERT INTO tasks(id,owner_user_id,owner_channel,type,status,title,context,due_at) VALUES(?,?,?, ?,?,'Fixture task','{}','2000-01-01')");
 for(const status of ['new','scheduled','in_progress','pending_owner','pending_colleague','completed','informed','failed','cancelled','stale'])insert.run('summary-'+status,'OWNER','C_SHARED','summary_action_followup',status);
 insert.run('other-owner','OTHER','D_OTHER','summary_action_followup','new');
 insert.run('routine','OWNER','DOWNER','routine','new');insert.run('calendar','OWNER','DOWNER','calendar_fix','new');
 const effects={sends:[],dispatches:[],errors:[],sweeps:0},modules=new Map();
 const logger={info(){},warn(...a){effects.errors.push(a);},error(...a){effects.errors.push(a);}};
 const profile={user:{slack_user_id:'OWNER',timezone:'UTC'}};
 const handler=async(_app,task)=>{effects.dispatches.push(task.type);load('src/tasks/index.ts').updateTask(task.id,{status:'completed'});};
 const mocks={
  'src/db.ts':{getDb:()=>db},'src/db/client.ts':{getDb:()=>db},'src/db/jobs.ts':{},
  'src/core/requests/runner.ts':{sweepDueRequests:async()=>{effects.sweeps++;}},
  'src/tasks/dispatchers/routine.ts':{dispatchRoutine:handler,stopInterruptedRoutineTasks:async()=>{}},
  'src/tasks/dispatchers/calendarFix.ts':{dispatchCalendarFix:handler},
  'src/tasks/dispatchers/summaryActionFollowup.ts':{dispatchSummaryActionFollowup:async(...args)=>{effects.sends.push('summary send');await handler(...args);}},
  'src/utils/logger.ts':{__esModule:true,default:logger},'src/utils/threadActivity.ts':{reactActivityComplete:async()=>{}},
  'src/tasks/routineMaterializer.ts':{backfillNullNextRunAt:()=>0},'src/tasks/crons.ts':{ensureBriefingCron(){},updateBriefingCronChannel(){}},
  'src/db/migrations/v2_9_3_calendar_health_twice_daily.ts':{runV293CalendarHealthTwiceDaily(){}},
  'src/db/socialSubjects.ts':{ensureCategoriesSeeded(){}},'src/db/engagementRank.ts':{migrateLegacyEngagementLevel(){}},
  'src/connections/registry.ts':{getConnection:()=>({postToChannel:async()=>{effects.sends.push('owner notice');return {ok:true};}})},
  'src/connections/slack/eligibility.ts':{},'src/connectors/slack/threadHistory.ts':{},
 };
 function load(rel){
  if(rel==='src/tasks/dispatchers.ts')rel='src/tasks/dispatchers/index.ts';
  if(mocks[rel])return mocks[rel];if(modules.has(rel))return modules.get(rel).exports;
  assert.ok(['src/core/background.ts','src/tasks/index.ts','src/tasks/runner.ts','src/tasks/dispatchers/index.ts'].includes(rel),'Unexpected module '+rel);
  const m={exports:{}};modules.set(rel,m);
  vm.runInNewContext('(function(require,module,exports){'+ts.transpileModule(source(rel),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+'\n})',{Date,Map,Set,Promise,setInterval(){}})(s=>s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):require(s),m,m.exports);
  return m.exports;
 }
 return {db,effects,load,boot:()=>load('src/core/background.ts').initProfile({},profile,'DOWNER'),run:()=>load('src/tasks/runner.ts').runDueTasks({},new Map([['OWNER',profile]])),status:id=>db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status};
}
for(const state of ['new','scheduled','in_progress','pending_owner','pending_colleague'])test('startup cancels retired summary '+state+' without sending',async t=>{
 const h=fixture(t);await h.boot();assert.equal(h.status('summary-'+state),'cancelled');assert.equal(h.effects.sends.length,0);
});
test('startup reentry preserves terminal history, owner scope and generic outreach',async t=>{
 const h=fixture(t);await h.boot();await h.boot();
 for(const state of ['completed','informed','failed','cancelled','stale'])assert.equal(h.status('summary-'+state),state);
 assert.equal(h.status('other-owner'),'new');
 assert.equal(h.db.prepare('SELECT next_check_handler FROM requests').get().next_check_handler,'send_scheduled_outreach');
 assert.equal(h.db.prepare('SELECT sent_at FROM outreach_jobs').get().sent_at,'2026-01-01');assert.equal(h.effects.sends.length,0);
});
test('actual registry and runner cannot dispatch retired summary; unrelated tasks still run',async t=>{
 const h=fixture(t);await h.boot();await h.run();await h.boot();await h.run();
 assert.equal(h.load('src/tasks/dispatchers/index.ts').DISPATCHERS.summary_action_followup,undefined);
 assert.deepEqual(h.effects.dispatches,['routine','calendar_fix']);assert.equal(h.effects.sends.length,0);
 assert.equal(h.status('routine'),'completed');assert.equal(h.status('calendar'),'completed');assert.equal(h.effects.sweeps,2);
});
test('failed retirement update is atomic and retry cancels without sending',async t=>{
 const h=fixture(t);h.db.exec("CREATE TRIGGER refuse_retirement BEFORE UPDATE ON tasks WHEN OLD.id='summary-in_progress' BEGIN SELECT RAISE(ABORT,'fixture unavailable database'); END;");
 await h.boot();assert.equal(h.status('summary-new'),'new');assert.equal(h.status('summary-in_progress'),'in_progress');
 assert.ok(h.effects.errors.some(a=>String(a[0]).includes('Summary action followup retirement')));
 h.db.exec('DROP TRIGGER refuse_retirement');await h.boot();assert.equal(h.status('summary-new'),'cancelled');assert.equal(h.status('summary-in_progress'),'cancelled');assert.equal(h.effects.sends.length,0);
});
test('removed dispatcher prevents sends even when startup retirement cannot write',async t=>{
 const h=fixture(t);h.db.exec("CREATE TRIGGER refuse_retirement BEFORE UPDATE ON tasks WHEN NEW.status='cancelled' AND OLD.type='summary_action_followup' BEGIN SELECT RAISE(ABORT,'fixture unavailable database'); END;");
 await h.boot();await h.run();assert.equal(h.effects.sends.length,0);assert.ok(!h.effects.dispatches.includes('summary_action_followup'));
});
