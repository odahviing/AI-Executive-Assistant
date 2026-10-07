// Real crons and briefs modules with SQLite fixtures.
// No production database, connection, model or background job is invoked.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('typescript'),Database=require('better-sqlite3');
const {DateTime,Settings}=require('luxon');
const root=path.resolve(__dirname,'..');
const before=process.env.BRIEFING_BEFORE_DIR;
const quiet={info(){},warn(){},error(){}};
const profile={user:{slack_user_id:'OWNER',timezone:'Asia/Jerusalem'},schedule:{office_days:{days:['Sunday','Monday']},home_days:{days:['Tuesday']},work_hours:{Sunday:['08:15-17:00'],Monday:['07:45-17:00']}}};
function source(file){return fs.readFileSync(before?path.join(before,path.basename(file).replace('.ts','.before.ts')):path.join(root,file),'utf8');}
function evaluate(code,deps,extra={}){const exports={};vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports,require:n=>{assert.ok(Object.hasOwn(deps,n),'unmocked '+n);return deps[n];},Date,...extra});return exports;}
function fixture(options={}){
 const db=new Database(':memory:');
 db.exec(`CREATE TABLE routines(id TEXT PRIMARY KEY,owner_user_id TEXT,owner_channel TEXT,title TEXT,prompt TEXT,schedule_type TEXT,schedule_time TEXT,schedule_day TEXT,status TEXT,next_run_at TEXT,last_run_at TEXT,last_result TEXT,run_count INTEGER,is_system INTEGER,never_stale INTEGER,notify_on_skip INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE user_preferences(id TEXT PRIMARY KEY,user_id TEXT,category TEXT,key TEXT,value TEXT,source TEXT,created_at TEXT,updated_at TEXT,UNIQUE(user_id,key));`);
 if(options.legacy!==undefined)db.prepare('INSERT INTO user_preferences(id,user_id,category,key,value,source) VALUES(?,?,?,?,?,?)').run('pref','OWNER','general','briefing_time',options.legacy,'user_taught');
 if(options.routine!==false)db.prepare(`INSERT INTO routines(id,owner_user_id,owner_channel,title,prompt,schedule_type,schedule_time,schedule_day,status,next_run_at,is_system) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('system_briefing_OWNER','OWNER','DOWNER','Morning Briefing','__system_briefing__',options.type||'weekly',options.time||'11:20',options.day||'Monday',options.status||'active',options.next||'2026-10-05T08:20:00.000Z',1);
 const preferences=()=>db.prepare('SELECT * FROM user_preferences WHERE user_id=?').all('OWNER');
 let crons;
 const briefSource=source('src/tasks/briefs.ts');
 const ast=ts.createSourceFile('briefs.ts',briefSource,ts.ScriptTarget.Latest,true);
 const briefDeps=Object.fromEntries(ast.statements.filter(ts.isImportDeclaration).map(n=>[n.moduleSpecifier.text,new Proxy({}, {get:(_t,k)=>{if(k==='__esModule')return false;return ()=>{throw Error('Unrelated brief dependency called: '+n.moduleSpecifier.text+'.'+String(k));};}})]));
 Object.assign(briefDeps,{'luxon':{DateTime},'../db':{getDb:()=>db,getPreferences:preferences},'../utils/logger':quiet,'../skills/news':{NEWS_PER_GOAL_TIMEOUT_MS:12000},'./crons':{getBriefingRoutineHourMin:p=>crons.getBriefingRoutineHourMin(p)}});
 const briefs=evaluate(briefSource,briefDeps);
 crons=evaluate(source('src/tasks/crons.ts'),{'luxon':{DateTime},'../db':{getDb:()=>{if(options.unavailable)throw Error('database unavailable');return db;}},'../utils/logger':quiet,'./briefs':briefs,'../db/preferences':{savePreference:p=>db.prepare('UPDATE user_preferences SET value=? WHERE user_id=? AND key=?').run(p.value,p.userId,p.key)}});
 return {db,crons,read:()=>Array.from(briefs.getBriefingHourMin(profile)),row:()=>db.prepare('SELECT * FROM routines WHERE id=?').get('system_briefing_OWNER'),legacy:preferences,ensure:()=>crons.ensureBriefingCron(profile),edit:args=>new crons.CronsSkill().executeToolCall('manage_routine',{action:'update',routine_id:'system_briefing_OWNER',...args},{profile})};
}
let passed=0,failed=0;
async function check(id,fn){try{await fn();console.log('PASS '+id);passed++;}catch(e){console.log('FAIL '+id+': '+e.message);failed++;}}
(async()=>{
 Settings.now=()=>Date.parse('2026-10-04T00:00:00Z');
 await check('existing routine wins legacy conflict across restart',()=>{const h=fixture({legacy:'07:30'});h.ensure();h.ensure();assert.equal(h.row().schedule_time,'11:20');assert.deepEqual(h.read(),[11,20]);assert.equal(h.legacy()[0].value,'07:30');});
 await check('owner edit persists without preference double write',async()=>{const h=fixture({legacy:'07:30'});assert.equal((await h.edit({schedule_time:'13:15'})).updated,true);assert.equal(h.legacy()[0].value,'07:30');h.ensure();assert.equal(h.row().schedule_time,'13:15');assert.deepEqual(h.read(),[13,15]);});
 await check('no preference row needed for restart',async()=>{const h=fixture();await h.edit({schedule_time:'12:05'});h.ensure();assert.equal(h.row().schedule_time,'12:05');assert.deepEqual(h.read(),[12,5]);});
 await check('multi-time cadence and earliest brief clock preserved',()=>{const h=fixture({time:'15:00,08:00',type:'daily'});h.ensure();assert.equal(h.row().schedule_time,'15:00,08:00');assert.deepEqual(h.read(),[8,0]);});
 await check('retired malformed legacy is never a runtime schedule source',()=>{const h=fixture({routine:false,legacy:'after 25:99'});h.ensure();assert.equal(h.row().schedule_time,'07:45');assert.equal(h.legacy()[0].value,'after 25:99');});
 await check('malformed existing schedule refuses overwrite',()=>{const h=fixture({time:'25:99',legacy:'07:30'});assert.throws(h.ensure,/Invalid persisted/);assert.equal(h.row().schedule_time,'25:99');assert.equal(h.legacy()[0].value,'07:30');});
 await check('verified routine survives legacy retirement',()=>{const h=fixture({time:'11:20',legacy:'11:20'});h.ensure();assert.equal(h.row().schedule_time,'11:20');assert.equal(h.row().is_system,1);h.db.prepare('DELETE FROM user_preferences WHERE user_id=? AND key=?').run('OWNER','briefing_time');h.ensure();assert.equal(h.row().schedule_time,'11:20');assert.deepEqual(h.read(),[11,20]);});
 await check('retired legacy cannot seed a new routine',()=>{const h=fixture({routine:false,legacy:'07:30'});h.ensure();assert.equal(h.row().schedule_time,'07:45');assert.equal(h.row().schedule_type,'weekdays');assert.equal(h.legacy()[0].value,'07:30');h.ensure();assert.equal(h.db.prepare('SELECT count(*) n FROM routines').get().n,1);});
 await check('new routine uses earliest profile start',()=>{const h=fixture({routine:false});h.ensure();assert.equal(h.row().schedule_time,'07:45');assert.deepEqual(h.read(),[7,45]);});
 for(const status of ['paused','deleted'])await check(status+' routine remains stopped',()=>{const h=fixture({status,time:'07:30',legacy:'07:30'});h.ensure();assert.equal(h.row().status,status);assert.equal(h.row().schedule_type,'weekly');assert.equal(h.row().schedule_day,'Monday');});
 await check('matching schedule keeps overdue cursor for materializer',()=>{const h=fixture({time:'07:30',legacy:'07:30',next:'2026-10-01T04:30:00.000Z'});h.ensure();assert.equal(h.row().next_run_at,'2026-10-01T04:30:00.000Z');});
 await check('future cursor refresh uses profile timezone and stored weekly day',()=>{const h=fixture({time:'07:30',legacy:'07:30',next:'2026-10-05T07:30:00.000Z'});h.ensure();assert.equal(h.row().next_run_at,'2026-10-05T04:30:00.000Z');assert.equal(h.row().schedule_day,'Monday');});
 await check('failed routine insertion retains legacy for retry',()=>{const h=fixture({routine:false,legacy:'07:30'});h.db.exec("CREATE TRIGGER refuse BEFORE INSERT ON routines BEGIN SELECT RAISE(ABORT,'storage failure'); END");assert.throws(h.ensure,/storage failure/);assert.equal(h.legacy()[0].value,'07:30');h.db.exec('DROP TRIGGER refuse');h.ensure();assert.equal(h.row().schedule_time,'07:45');});
 await check('unavailable database fails visibly',()=>{const h=fixture({unavailable:true});assert.throws(h.ensure,/database unavailable/);});
 await check('invalid owner edit leaves routine unchanged',async()=>{const h=fixture();assert.ok((await h.edit({schedule_time:'25:30'})).error);assert.equal(h.row().schedule_time,'11:20');});
 Settings.now=()=>Date.now();console.log(`${passed} passed; ${failed} failed`);process.exitCode=failed?1:0;
})();

