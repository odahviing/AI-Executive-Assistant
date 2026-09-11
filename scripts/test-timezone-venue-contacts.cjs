// Actual find_venue -> discovery parser -> hours filter and person-contact payload checks.
// Network/model effects are fixtures. Optional before snapshots are evidence-only;
// the normal node --test command runs from a clean checkout without artifacts.
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {DateTime,Settings,IANAZone}=require('luxon');
const root=path.resolve(__dirname,'..'),snapshot=process.env.LIBRARIAN_SNAPSHOT,compiled=new Map();
const actual=new Set(['src/db/people.ts','src/utils/venueSearch.ts','src/skills/venue.ts','src/utils/locationTz.ts','src/utils/timezoneValidator.ts','src/utils/workingHoursDefault.ts']);
let now=Date.parse('2026-09-15T02:00:00Z');
class Clock extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
Settings.now=()=>now;
function harness(options={}){
 now=Date.parse(options.now||'2026-09-15T02:00:00Z');
 const person={person_id:'p_colleague',slack_id:'UCOLLEAGUE',kind:'internal',name:'Colleague',timezone:'America/New_York',timezone_set_by:'person',notes:'[]',profile_json:'{}',interaction_log:'[]',...options.person};
 const candidates=options.candidates??[{name:'Fixture Cafe',opening_hours_by_day:options.hours}];
 const profile={user:{slack_user_id:'UOWNER',name:'Owner',timezone:options.zone||'Asia/Jerusalem'}};
 const noop=()=>{},modules=new Map();let searches=0,compositions=0;
 const mocks={
  'src/config.ts':{config:{}},
  'src/db/client.ts':{getDb:()=>({prepare:sql=>({all:()=>[person]})})},
  'src/db/socialSubjects.ts':{},'src/db/engagementRank.ts':{},'src/config/userProfile.ts':{getTenantWorkdaysForTimezone:()=>undefined},
  'src/db/venues.ts':{findVenuesByCriteria:()=>[],countHiddenVenues:()=>0},
  'src/llm/client.ts':{getAnthropicClient:()=>({messages:{create:async()=>{compositions++;return {content:[{type:'text',text:JSON.stringify({candidates})}]};}}})},
  'src/llm/models.ts':{},'src/skills/general.ts':{tavilySearch:async()=>{searches++;return {answer:'Fixture source with explicitly supplied opening hours'};},TAVILY_SEARCH_LIVE_TURN_TIMEOUT_MS:1000},
  'src/utils/locationResolver.ts':{resolveVenueLocation:async()=>({resolved:false})},
  'src/utils/logger.ts':{__esModule:true,default:{info:noop,debug:noop,warn:noop,error:noop}},
 };
 function load(rel){
  if(Object.hasOwn(mocks,rel))return mocks[rel];if(modules.has(rel))return modules.get(rel).exports;
  if(!actual.has(rel))throw Error('Unexpected module '+rel);
  if(!compiled.has(rel)){
   const prior=snapshot?path.join(root,snapshot,rel):null;
   const source=fs.readFileSync(prior&&fs.existsSync(prior)?prior:path.join(root,rel),'utf8');
   compiled.set(rel,ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
  }
  const mod={exports:{}};modules.set(rel,mod);
  const req=s=>s==='luxon'?{DateTime,IANAZone}:s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):require(s);
  vm.runInNewContext('(function(require,module,exports){'+compiled.get(rel)+'\n})',{Date:Clock,console,Set,Map},{filename:rel})(req,mod,mod.exports);return mod.exports;
 }
 return {person,profile,load,searches:()=>searches,compositions:()=>compositions,
  venue:meeting_time=>new(load('src/skills/venue.ts').VenueSkill)().executeToolCall('find_venue',{name_hint:'Fixture Cafe',meeting_time},{profile,senderRole:'owner',userId:'UOWNER'}),
  contacts:(zone=profile.user.timezone,includeSocial=false)=>{const f=load('src/db/people.ts').formatPeopleMemoryForPrompt;return snapshot?f('UOWNER',undefined,includeSocial):f('UOWNER',zone,undefined,includeSocial);},
 };
}
test('find_venue accepts bare supplied-zone open clock through real discovery parser',async()=>{const h=harness({zone:'America/New_York',hours:{Monday:['08:30-09:30']}});const r=await h.venue('2026-09-14T09:00:00');assert.equal(r.options.length,1);assert.equal(r.options[0].hours_status,'open');assert.equal(h.searches(),1);assert.equal(h.compositions(),1);});
test('find_venue filters bare supplied-zone closed clock instead of host-shifted open time',async()=>{const h=harness({zone:'America/New_York',hours:{Monday:['08:30-09:30']}});const r=await h.venue('2026-09-14T13:00:00');assert.equal(r.options.length,0);});
test('find_venue explicit offset is the same instant rendered in supplied zone',async()=>{const h=harness({zone:'America/New_York',hours:{Monday:['08:30-09:30']}});const r=await h.venue('2026-09-14T16:00:00+03:00');assert.equal(r.options[0].hours_status,'open');});
test('find_venue explicit-offset closed control remains filtered',async()=>{const h=harness({zone:'America/New_York',hours:{Monday:['08:30-09:30']}});const r=await h.venue('2026-09-14T18:00:00+03:00');assert.equal(r.options.length,0);});
test('find_venue bare clock retains previous-day overnight opening range',async()=>{const h=harness({zone:'Asia/Tokyo',hours:{Friday:['22:00-02:00']}});const r=await h.venue('2026-09-19T01:00:00');assert.equal(r.options[0]?.hours_status,'open');});
test('find_venue explicit instant crossing local midnight uses local weekday',async()=>{const h=harness({zone:'Asia/Tokyo',hours:{Saturday:['00:00-02:00']}});const r=await h.venue('2026-09-18T16:00:00Z');assert.equal(r.options[0]?.hours_status,'open');});
test('find_venue missing hours stays unknown and visible',async()=>{const h=harness();const r=await h.venue('2026-09-14T09:00:00');assert.equal(r.options[0].hours_status,'unknown');});
test('find_venue invalid meeting time stays unknown and visible',async()=>{const h=harness({hours:{Monday:['08:30-09:30']}});const r=await h.venue('invalid');assert.equal(r.options[0].hours_status,'unknown');});
const trip=(from,until)=>JSON.stringify({location:'Tokyo',from,until});
test('contact travel starts on positive-offset destination date before UTC date',()=>{const h=harness({now:'2026-09-14T22:00:00Z',zone:'Asia/Jerusalem',person:{currently_traveling:trip('2026-09-15','2026-09-18')}});assert.match(h.contacts(),/currently in Tokyo/);assert.doesNotMatch(h.contacts(),/upcoming travel/);});
test('contact eastern destination trip has ended despite earlier western owner date',()=>{const h=harness({now:'2026-09-15T02:00:00Z',zone:'America/Los_Angeles',person:{currently_traveling:trip('2026-09-12','2026-09-14')}});assert.doesNotMatch(h.contacts(),/currently in|upcoming travel/);assert.equal(h.compositions(),0);});
test('contact eastern destination trip is current before western owner date begins',()=>{const h=harness({now:'2026-09-15T02:00:00Z',zone:'America/Los_Angeles',person:{currently_traveling:trip('2026-09-15','2026-09-18')}});assert.match(h.contacts(),/currently in Tokyo until 2026-09-18/);assert.doesNotMatch(h.contacts(),/upcoming travel/);assert.equal(h.compositions(),0);});
test('contact past trip disappears when positive-offset destination date has returned',()=>{const h=harness({now:'2026-09-14T22:00:00Z',zone:'Asia/Jerusalem',person:{currently_traveling:trip('2026-09-12','2026-09-14')}});assert.doesNotMatch(h.contacts(),/currently in|upcoming travel/);});
test('contact UTC home day preserves existing current tag',()=>{const h=harness({zone:'UTC',person:{currently_traveling:trip('2026-09-15','2026-09-18')}});assert.match(h.contacts(),/currently in Tokyo/);});
test('contact future and past controls remain scoped on ordinary daytime',()=>{const h=harness({now:'2026-09-14T12:00:00Z',zone:'Asia/Jerusalem',person:{currently_traveling:trip('2026-09-16','2026-09-18')}});assert.match(h.contacts(),/upcoming travel/);const p=harness({now:'2026-09-14T12:00:00Z',zone:'Asia/Jerusalem',person:{currently_traveling:trip('2026-09-10','2026-09-12')}});assert.doesNotMatch(p.contacts(),/currently in|upcoming travel/);});
test('contact no trip preserves stored permanent timezone without travel claim',()=>{const h=harness({zone:'America/Los_Angeles'});assert.match(h.contacts(),/tz: America\/New_York/);assert.doesNotMatch(h.contacts(),/currently in|upcoming travel/);});
test('contact destination-frame travel change preserves UTC social-day annotation',()=>{const h=harness({now:'2026-09-15T02:00:00Z',zone:'America/Los_Angeles',person:{last_social_at:'2026-09-15T01:00:00Z',currently_traveling:trip('2026-09-12','2026-09-14')}});assert.match(h.contacts(undefined,true),/last social: 2026-09-15 \(today\)/);});
