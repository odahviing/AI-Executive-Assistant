// Reuse complete isolated health handler harness; run only explicitly named Boston cases.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');const {test}=require('node:test'),{createRequire}=require('node:module');
const file=path.join(__dirname,'test-calendar-health-audit.cjs'),m={exports:{}};
vm.runInNewContext(fs.readFileSync(file,'utf8').split('async function test(id, fn)')[0].replace("if (spec.endsWith('/workHours')) return work;","if (spec.endsWith('/workHours')) return actualWork;").replace('getOwnerEventsForDecision: async () => {','getOwnerEventsForDecision: async (...args) => { calls.push(["read", ...args]);')+'\nmodule.exports={harness};',{require:createRequire(file),module:m,exports:m.exports,__dirname,process,console,Date,Buffer,setTimeout,clearTimeout,actualWork:require('./test-timezone-owner-interval.cjs').harness().load('src/utils/workHours.ts')});
const {Settings}=require('luxon');Settings.now=()=>Date.parse('2026-11-03T03:30:00Z');
function h(opts={}){const h=m.exports.harness(opts);h.profile.user.timezone='America/New_York';h.profile.schedule.office_days.days=['Monday','Tuesday','Thursday'];h.profile.schedule.home_days.days=['Wednesday','Friday'];h.profile.schedule.work_hours={Monday:['09:00-17:00'],Tuesday:['09:00-17:00'],Wednesday:['08:00-17:00'],Thursday:['09:00-17:00'],Friday:['08:00-17:00']};return h;}
test('Boston health uses local date before UTC midnight crossover',async()=>{const x=h();await x.scan({days_ahead:1});const reads=x.calls.filter(c=>c[0]==='read');assert.ok(reads.length);assert.ok(JSON.stringify(reads).includes('2026-11-02'),JSON.stringify(reads));});
test('Boston health unavailable calendar throws and makes no calendar mutation',async()=>{const x=h({readError:true});await assert.rejects(x.scan({mode:'active'}),/unreadable/);assert.equal(x.calls.filter(c=>['write','book'].includes(c[0])).length,0);});
test('Boston passive floating scan retains missing object issue without mutation',async()=>{const x=h({blocks:[{name:'lunch',preferred_start:'12:00',preferred_end:'13:00',duration_minutes:30}]});const r=await x.scan({start_date:'2026-11-03',end_date:'2026-11-05'});assert.ok(r.issues.some(i=>i.type==='missing_floating_block'),JSON.stringify(r));assert.equal(x.calls.filter(c=>['write','book'].includes(c[0])).length,0);});



