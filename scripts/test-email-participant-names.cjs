const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const {DateTime, Settings, IANAZone} = require('luxon'), Database = require('better-sqlite3');
// Forwarded-header display names (L11): real extractor parse, real inbound mint, real people store.
// Haiku, Graph, the orchestrator and the output gates are explicit mocks.
const root = path.resolve(__dirname, '..');
const actual = new Set([
  'src/connectors/email/inbound.ts',
  'src/connectors/email/extractParticipants.ts',
  'src/connections/email/ownerAddresses.ts',
  'src/connectors/email/htmlToText.ts',
  'src/db/people.ts',
  'src/memory/resolveAttendeeEmails.ts',
  'src/utils/attendeeAvailability.ts',
  'src/utils/locationTz.ts',
  'src/utils/workingHoursDefault.ts',
  'src/utils/timezoneValidator.ts',
  'src/utils/timezoneConvert.ts',
  'src/utils/workHours.ts',
]);
const compiled = new Map();
const now = Date.parse('2026-09-12T09:00:00Z');
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
Settings.now = () => now;

const HEADER = 'Nikki Hardee <nhardee@kevel.com>';
const NOTE = 'Can you find us a slot next week?';
const BODY = [NOTE, '', '---------- Forwarded message ---------', `From: ${HEADER}`, 'Date: Thu, 10 Sep 2026 15:02', 'Subject: Kevel / Reflectiz', 'To: Idan Cohen <owner@example.com>', '', 'Hi Idan, happy to talk whenever suits.'].join('\n');
const NIKKI = {email:'nhardee@kevel.com', name:'Nikki Hardee'};
const OWNER_ON_HEADER = {email:'owner@example.com', name:'Idan Cohen'};

function harness(options = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE people_memory(person_id TEXT PRIMARY KEY,slack_id TEXT UNIQUE,name TEXT,email TEXT,kind TEXT,source TEXT,timezone TEXT,timezone_set_by TEXT,state TEXT,state_set_by TEXT,name_set_by TEXT,name_he TEXT,name_he_set_by TEXT,gender TEXT,gender_set_by TEXT,gender_confirmed INTEGER DEFAULT 0,profile_json TEXT,working_hours_auto TEXT,currently_traveling TEXT,timezone_temp TEXT,last_seen TEXT,updated_at TEXT);`);
  sqlite.exec('ALTER TABLE people_memory ADD COLUMN email_set_by TEXT');
  for (const seed of options.seed || []) {
    const row = {slack_id:null,kind:'external',profile_json:'{}',last_seen:'2026-09-01T00:00:00Z',...seed};
    sqlite.prepare(`INSERT INTO people_memory(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(k=>'@'+k).join(',')})`).run(row);
  }
  const profile = {user:{name:'Owner',slack_user_id:'UOWNER',email:'owner@example.com',timezone:'Asia/Jerusalem'},assistant:{name:'Maelle',email:'assistant@example.com'},channels:{email:{enabled:true,mailbox:'assistant@example.com',owner_aliases:['alias@example.com']}}};
  const message = {id:'mail_fixture',conversationId:'chain_fixture',from:options.sender || profile.user.email,replyTo:[],subject:'Fw: Kevel / Reflectiz',bodyContentType:'text',body:BODY,uniqueBodyContentType:'text',uniqueBody:NOTE};
  const people = options.people ?? [NIKKI, OWNER_ON_HEADER];
  const counts = {haiku:0,orchestrator:0,gate:0}, mints=[], sends=[], notifications=[], history=[], haikuCalls=[], orchestratorInputs=[], modules=new Map();
  let handler;
  const noop=()=>{};
  // Values built inside the vm realm carry foreign prototypes, which strict
  // deep-equality rejects; normalize at every capture point.
  const plain=v=>JSON.parse(JSON.stringify(v));
  // Schema-compliant Haiku stand-in: `tool_choice:{type:'tool'}` makes the real
  // reply conform to whatever input_schema the module sent, so the fake answers
  // in that shape — pairs when the module asks for objects, bare addresses when
  // it asks for strings. It proves the requested schema, the parse and the mint;
  // never the model's own reading of the header.
  const anthropic = {messages:{create:async params=>{
    counts.haiku++; haikuCalls.push(params);
    const items = params.tools[0].input_schema.properties.participants.items;
    const participants = items.type==='object' ? people.map(p=>({...p})) : people.map(p=>p.email);
    return {content:[{type:'tool_use',name:'extract_participants',input:{participants,attendee_timezones:[]}}],usage:{}};
  }}};
  const connection = {sendDirect:async (...args)=>{sends.push(args); return {ok:true};}};
  const mocks = {
    'src/config.ts':{config:{}},
    'src/llm/client.ts':{getAnthropicClient:()=>anthropic}, 'src/llm/models.ts':{MODEL_HAIKU:'haiku-fixture'}, 'src/utils/usageLog.ts':{logLlmUsage:noop},
    'src/db/client.ts':{getDb:()=>sqlite}, 'src/db/socialSubjects.ts':{}, 'src/db/engagementRank.ts':{},
    'src/db/scheduleOverrides.ts':{getScheduleOverride:()=>null},
    'src/config/userProfile.ts':{getTenantWorkdaysForTimezone:()=>undefined},
    'src/utils/logger.ts':{__esModule:true,default:{info:noop,warn:noop,error:noop,debug:noop}},
    'src/connectors/graph/mailInboundRegistry.ts':{registerMailInbound:(_id,fn)=>{handler=fn;}},
    'src/connections/email.ts':{createEmailConnection:()=>connection},
    'src/connections/registry.ts':{registerConnection:noop,getConnection:()=>({sendDirect:async(...a)=>{notifications.push(a);return {ok:true};}})},
    'src/utils/offeredSlotsStash.ts':{EMAIL_KEY_PREFIX:'email:'},
    'src/memory/recordBooking.ts':{isNonHumanAttendee:()=>false},
    'src/core/orchestrator.ts':{runOrchestrator:async input=>{counts.orchestrator++;orchestratorInputs.push({...input,extractedAttendeeEmails:Array.from(input.extractedAttendeeEmails)});assert.equal(input.channel,'email');return {reply:'Fixture reply'};}},
    'src/utils/guards/runOutputGates.ts':{runOutputGates:async(reply,args)=>{counts.gate++;assert.equal(args.transport,'email');return reply;}},
  };
  function load(rel) {
    if(rel==='src/db.ts'){const people=load('src/db/people.ts');return {...people,resolvePerson:input=>{mints.push(plain(input));return people.resolvePerson(input);},getConversationHistory:()=>[],appendToConversation:(...args)=>history.push(args)};}
    if(Object.hasOwn(mocks,rel))return mocks[rel];
    if(modules.has(rel))return modules.get(rel).exports;
    if(!actual.has(rel))throw Error('Unhandled module '+rel);
    if(!compiled.has(rel)) {
      const saved=process.env.DIPLOMAT_SNAPSHOT&&path.join(root,process.env.DIPLOMAT_SNAPSHOT,rel);
      const source = fs.readFileSync(saved&&fs.existsSync(saved)?saved:path.join(root,rel),'utf8');
      compiled.set(rel,ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
    }
    const mod={exports:{}};modules.set(rel,mod);
    const req=s=>s==='luxon'?{DateTime,Settings,IANAZone}:s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):require(s);
    vm.runInNewContext('(function(require,module,exports){'+compiled.get(rel)+'\n})',{Date:Clock,console,Set,Map,Buffer,setTimeout},{filename:rel})(req,mod,mod.exports);
    return mod.exports;
  }
  load('src/connectors/email/inbound.ts').startEmailChannel(profile);
  const rows=()=>sqlite.prepare('SELECT person_id,name,email,kind,name_set_by FROM people_memory ORDER BY rowid').all();
  return {run:()=>handler(profile,message),rows,counts,mints,sends,notifications,history,haikuCalls,orchestratorInputs,load};
}

test('forwarded display name reaches the mint call and names the fresh row',async()=>{
 const h=harness();await h.run();
 assert.deepEqual(h.mints,[{email:NIKKI.email,name:NIKKI.name,ownerDomain:'example.com'}]);
 assert.deepEqual(h.rows().map(r=>({name:r.name,email:r.email,kind:r.kind})),[{name:'Nikki Hardee',email:NIKKI.email,kind:'external'}]);
 assert.deepEqual(h.orchestratorInputs[0].extractedAttendeeEmails,[NIKKI.email]);
 assert.ok(h.orchestratorInputs[0].userMessage.includes(`Nikki Hardee <${NIKKI.email}>`));
 assert.deepEqual(h.counts,{haiku:1,orchestrator:1,gate:1});assert.equal(h.sends.length,1);assert.equal(h.notifications.length,0);assert.equal(h.history.length,2);
});
test('extractor requests and returns name and address pairs from the top header',async()=>{
 const h=harness();const result=await h.load('src/connectors/email/extractParticipants.ts').extractForwardedParticipants(BODY);
 assert.deepEqual(JSON.parse(JSON.stringify(result.participants)),[NIKKI,OWNER_ON_HEADER]);assert.deepEqual(Array.from(result.timezoneHints),[]);
 const items=h.haikuCalls[0].tools[0].input_schema.properties.participants.items;
 assert.equal(items.type,'object');assert.deepEqual(Object.keys(items.properties).sort(),['email','name']);assert.deepEqual(Array.from(items.required),['email']);
 assert.ok(h.haikuCalls[0].messages[0].content.includes(HEADER));
});
test('existing row known only by name binds the address instead of minting a duplicate',async()=>{
 const h=harness({seed:[{person_id:'p_nikki',name:'Nikki Hardee',email:null}]});await h.run();
 assert.deepEqual(h.rows().map(r=>({person_id:r.person_id,name:r.name,email:r.email})),[{person_id:'p_nikki',name:'Nikki Hardee',email:NIKKI.email}]);
});
test('bare address header still mints a row and reaches the attendee route',async()=>{
 const h=harness({people:[{email:'lyz@partner.example'}]});await h.run();
 assert.equal(h.mints.length,1);assert.equal(h.mints[0].email,'lyz@partner.example');assert.ok(!h.mints[0].name);
 assert.equal(h.rows().length,1);assert.equal(h.rows()[0].email,'lyz@partner.example');
 assert.deepEqual(h.orchestratorInputs[0].extractedAttendeeEmails,['lyz@partner.example']);assert.equal(h.sends.length,1);
});
test('address-shaped display name is never used as a name',async()=>{
 const h=harness({people:[{email:NIKKI.email,name:NIKKI.email}]});await h.run();
 assert.equal(h.mints.length,1);assert.ok(!h.mints[0].name);assert.equal(h.rows().length,1);
});
test('malformed participant entry is dropped and the valid one still mints',async()=>{
 const h=harness({people:[{name:'Ghost'},{email:'not-an-address',name:'Nobody'},NIKKI]});await h.run();
 assert.equal(h.mints.length,1);assert.equal(h.mints[0].email,NIKKI.email);assert.deepEqual(h.orchestratorInputs[0].extractedAttendeeEmails,[NIKKI.email]);
});
test('existing row under the same address keeps its owner-set name',async()=>{
 const h=harness({seed:[{person_id:'p_nikki',name:'Nikki H.',email:NIKKI.email,name_set_by:'owner'}]});await h.run();
 assert.deepEqual(h.rows().map(r=>({person_id:r.person_id,name:r.name,email:r.email,name_set_by:r.name_set_by})),[{person_id:'p_nikki',name:'Nikki H.',email:NIKKI.email,name_set_by:'owner'}]);
 assert.equal(h.mints.length,1);
});
test('owner address on the forwarded header is filtered, never minted',async()=>{
 const h=harness({people:[OWNER_ON_HEADER,{email:'alias@example.com',name:'Owner Alias'},{email:'assistant@example.com',name:'Maelle'}]});await h.run();
 assert.equal(h.mints.length,0);assert.equal(h.rows().length,0);assert.deepEqual(h.orchestratorInputs[0].extractedAttendeeEmails,[]);assert.equal(h.sends.length,1);
});
test('non-owner sender remains silent before extraction or any mint',async()=>{
 const h=harness({sender:'outsider@example.net'});await h.run();
 assert.deepEqual(h.counts,{haiku:0,orchestrator:0,gate:0});assert.equal(h.mints.length,0);assert.equal(h.rows().length,0);assert.equal(h.sends.length,0);assert.equal(h.notifications.length,0);assert.equal(h.history.length,0);
});
