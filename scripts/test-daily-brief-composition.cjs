// Execute the complete brief module with isolated dependencies; no network or real DB.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..');
// Reuse the audited module loader, with fixture selection and observable boundaries.
let source=fs.readFileSync(path.join(__dirname,'test-librarian-action-outcomes.cjs'),'utf8');
source=source.slice(0,source.indexOf('function person('))+source.slice(source.indexOf('function brief('),source.indexOf('for (const [label, options]'));
source=source.replace("const source = revision ?", "const source = relative === 'src/tasks/briefs.ts' && process.env.BRIEF_SOURCE_FIXTURE ? fs.readFileSync(process.env.BRIEF_SOURCE_FIXTURE, 'utf8') : revision ?");
source=source.replace('ts.transpileModule(source,', "ts.transpileModule(source + (relative === 'src/tasks/briefs.ts' ? '\\nexport { relativeTime };' : ''),");
source=source.replace('return { effects, row:', "return { relativeTime: (...args) => load('src/tasks/briefs.ts').relativeTime(...args), effects, row:");
source=source.replace("getRequestsForBrief: () => [row]", "getRequestsForBrief: () => options.empty ? [] : [row]");
source=source.replace("markRequestSurfaced: () => effects.surfaced++", "markRequestSurfaced: () => { if(options.surfaceWriteThrows) throw new Error('surface write unavailable'); effects.surfaced++; }");
source=source.replace("writeSeenLog: async () => effects.newsSeen++", "writeSeenLog: () => { if(options.newsSeenThrows) throw new Error('news seen unavailable'); effects.newsSeen++; return Promise.resolve(); }");
source=source.replace("getCalendarEvents: async () => []", "getCalendarEvents: async () => { if(options.calendarThrows) throw new Error('fixture calendar outage'); return options.calendar ? [{}] : []; }");
source=source.replace("'src/skills/meetings/ops.ts': {}", "'src/skills/meetings/ops.ts': { processCalendarEvents: () => { if(options.surfaceThrows) throw new Error('fixture normalization outage'); return [{ subject:'Calendar fixture', _localDate: DateTime.now().setZone('UTC').toISODate(), _localStartTime:'10:00', _localEndTime:'11:00', _eventType:'mine' }]; } }");
source=source.replace("getActiveSlotHolds: () => []", "getActiveSlotHolds: () => options.holds ? [{holder_name:'Hold fixture',start_iso:'2026-09-15T10:00:00Z'}] : []");
source=source.replace("getRecentlyFulfilledHolds: () => []", "getRecentlyFulfilledHolds: () => options.fulfilled ? [{holder_name:'Fulfilled fixture',start_iso:'2026-09-15T10:00:00Z'}] : []");
source=source.replace("news: !!options.news", "news: !!options.news, calendar: !!options.health");
source=source.replace("'src/utils/humanGate.ts':", "'src/skills/registry.ts': { executeSkillTool: async () => ({summary_text:'Health fixture',vacuous:false}) }, 'src/utils/humanGate.ts':");
source=source.replace("create: async () => { if(options.composeThrows)", "create: async input => { effects.logs.push(['compose', input]); if(options.composeThrows)");
source=source.replace("text:'Review your pending ask.'", "text: options.blank ? '  ' : 'Review your pending ask.'");
source+='\nmodule.exports={brief};';
const fixture={exports:{}};
vm.runInThisContext('(function(require,module,exports,__dirname){'+source+'\n})',{filename:__filename})(require,fixture,fixture.exports,__dirname);
const {brief}=fixture.exports;
const compose=h=>h.effects.logs.find(x=>x[0]==='compose')?.[1];
for(const [id,iso,zone,expected] of [
  ['future-tomorrow','2026-09-12T10:00:00Z','UTC','tomorrow'],
  ['future-dated','2026-09-15T10:00:00Z','UTC','Tuesday 15 Sep'],
  ['future-zone-boundary','2026-09-11T22:30:00Z','Asia/Jerusalem','tomorrow'],
  ['control-relative-today','2026-09-11T22:30:00Z','UTC','today'],
  ['control-relative-yesterday','2026-09-10T10:00:00Z','UTC','yesterday'],
  ['control-relative-two-days','2026-09-09T10:00:00Z','UTC','two days ago'],
  ['control-relative-three-days','2026-09-08T10:00:00Z','UTC','three days ago'],
  ['control-relative-old','2026-09-07T10:00:00Z','UTC','Monday'],
  ['control-relative-missing',null,'UTC','recently'],
])test(id,()=>{const {Settings}=require('luxon');const old=Settings.now;Settings.now=()=>Date.parse('2026-09-11T18:30:00Z');try{assert.equal(brief().relativeTime(iso,zone),expected);}finally{Settings.now=old;}});
test('health-only-compose-failure',async()=>{const h=brief({empty:true,health:true,composeThrows:true});await assert.rejects(h.run());assert.equal(h.effects.posts.length+h.effects.events.length,0);});
test('control-health-only-success',async()=>{const h=brief({empty:true,health:true});await h.run();assert.match(compose(h).messages[0].content,/Health fixture/);assert.equal(h.effects.posts.length,1);});
for(const failure of ['eventThrows','newsSeenThrows'])test('independent-bookkeeping-'+failure,async()=>{const h=brief({news:true,[failure]:true});await h.run();assert.equal(h.effects.posts.length,1);assert.equal(h.effects.surfaced,1);assert.equal(h.effects.closures,1);if(failure!=='newsSeenThrows')assert.equal(h.effects.newsSeen,1);});
test('control-surfacing-failure-prevents-closure',async()=>{const h=brief({surfaceWriteThrows:true});await h.run();assert.equal(h.effects.posts.length,1);assert.equal(h.effects.closures,0);});
test('control-news-only-compose-failure',async()=>{const h=brief({empty:true,news:true,composeThrows:true});await assert.rejects(h.run());assert.equal(h.effects.posts.length+h.effects.events.length+h.effects.newsSeen,0);});
test('control-news-only-success',async()=>{const h=brief({empty:true,news:true});await h.run();assert.match(compose(h).messages[0].content,/NEWS SOURCES/);assert.equal(h.effects.newsSeen,1);});
for(const kind of ['holds','fulfilled'])test('hold-only-'+kind,async()=>{const h=brief({empty:true,[kind]:true});await h.run();assert.match(compose(h)?.messages[0].content||'',/SLOT HOLDS/);assert.equal(h.effects.posts.length,1);});
for(const kind of ['calendarThrows','surfaceThrows'])test('calendar-unavailable-'+kind,async()=>{const h=brief({empty:true,calendar:kind==='surfaceThrows',[kind]:true});await h.run();assert.match(compose(h)?.messages[0].content||'',/calendar_unavailable/);assert.match(compose(h)?.system||'',/never infer an empty or free day/);});
test('calendar-outage-fallback',async()=>{const h=brief({empty:true,calendarThrows:true,composeThrows:true});await h.run();assert.match(h.effects.posts[0][1],/Calendar unavailable/);});
test('calendar-only-fallback',async()=>{const h=brief({empty:true,calendar:true,composeThrows:true});await h.run();assert.match(h.effects.posts[0][1],/10:00–11:00: Calendar fixture/);});
test('empty-model-uses-request-fallback',async()=>{const h=brief({blank:true});await h.run();assert.match(h.effects.posts[0][1],/Contact review/);assert.equal(h.effects.surfaced,1);});
for(const fail of ['blank','composeThrows'])test('unusable-hold-only-'+fail,async()=>{const h=brief({empty:true,holds:true,[fail]:true});await assert.rejects(h.run());assert.equal(h.effects.posts.length+h.effects.events.length+h.effects.surfaced,0);});
test('control-quiet-day',async()=>{const h=brief({empty:true});await h.run();assert.equal(compose(h),undefined);assert.equal(h.effects.posts[0][1],'☀️ All clear — nothing new today.');});
test('control-normal-request',async()=>{const h=brief();await h.run();assert.equal(h.effects.posts[0][1],'☀️ Review your pending ask.');assert.equal(h.effects.surfaced,1);});
test('control-refused-send',async()=>{const h=brief({sendFails:true});await assert.rejects(h.run());assert.equal(h.effects.events.length+h.effects.surfaced,0);});
test('control-daily-dedup',async()=>{const h=brief({alreadySent:true});await h.run(false);assert.equal(h.effects.posts.length,0);});
test('control-request-fallback',async()=>{const h=brief({composeThrows:true});await h.run();assert.match(h.effects.posts[0][1],/Contact review/);});
test('control-retry-after-compose-failure',async()=>{const options={empty:true,holds:true,blank:true};const h=brief(options);await assert.rejects(h.run());options.blank=false;await h.run();assert.equal(h.effects.posts.length,1);assert.equal(h.effects.events.length,1);});
