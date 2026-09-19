// Actual KB ingest/read and venue discovery/filter modules; isolated filesystem,
// deterministic provider responses, no network, production database, or live model.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const snapshotArg = process.argv.indexOf('--snapshot');
const before = process.argv.includes('--before') || snapshotArg >= 0;
const snapshot = snapshotArg >= 0 ? path.resolve(process.argv[snapshotArg + 1]) : path.join(root, 'artifacts/workshop-verification/full-review-20260919/librarian/before');
const compiled = new Map();
function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maelle-kb-venue-'));
  const kb = path.join(dir, 'config/users/fixture_kb');
  fs.mkdirSync(kb, { recursive: true });
  for (const [id, body] of Object.entries(options.sections || {})) {
    fs.mkdirSync(path.dirname(path.join(kb, id + '.md')), { recursive: true });
    fs.writeFileSync(path.join(kb, id + '.md'), body);
  }
  const rows = (options.rows || []).map(r => ({ owner_user_id: 'UOWNER', area_tags: '["City"]', type_tags: '[]', rank: 2, ...r }));
  const queries = [], prompts = [];
  let calls = 0;
  const anthropic = { messages: { create: async request => {
    prompts.push(request); calls++;
    if (options.modelFails) throw Error('fixture provider unavailable');
    if (request.tools) return { content: [{ type: 'tool_use', input: {
      kind: 'knowledge_doc', confidence: 'high', action: options.action || 'create',
      section_id: options.sectionId || 'company/product', existing_match: options.existingMatch,
      title: 'Product', summary: 'Fixture summary', ...options.verdict,
    } }] };
    if (request.system) return { content: [{ type: 'text', text: JSON.stringify({ candidates: options.candidates || [{ name: 'Cafe' }] }) }] };
    return { content: [{ type: 'text', text: options.condensed || 'A grounded description of the product that contains more than fifty characters.' }] };
  } } };
  const noop = () => {};
  const mocks = {
    'src/llm/client.ts': { getAnthropicClient: () => anthropic },
    'src/llm/models.ts': {},
    'src/utils/logger.ts': { __esModule: true, default: { info: noop, warn: noop, error: noop } },
    'src/utils/resolveLocation.ts': { HUDDLE_LABEL: 'Huddle' },
    'src/utils/locationResolver.ts': { resolveVenueLocation: async () => ({ resolved: false }) },
    'src/utils/attendeeScope.ts': { getOwnerDomain: () => 'company.example' },
    'src/db/people.ts': { getPersonMemory: () => ({ email: options.senderEmail || 'person@company.example' }) },
    'src/skills/general.ts': {
      TAVILY_SEARCH_LIVE_TURN_TIMEOUT_MS: 1000,
      tavilyExtract: async () => options.extractFails ? { error: 'unreadable' } : { content: 'Source content suitable for a durable knowledge entry, sufficiently long for ingest.' },
      tavilySearch: async query => { queries.push(query); if (options.searchFails) throw Error('fixture unavailable'); return { answer: 'Fixture sourced venue result' }; },
    },
    'src/db/client.ts': { getDb: () => ({ prepare: sql => ({
      all: owner => rows.filter(r => r.owner_user_id === owner),
      get: (owner, name) => rows.find(r => r.owner_user_id === owner && r.name.toLowerCase() === name.toLowerCase()),
    }) }) },
  };
  const modules = new Map();
  function load(rel) {
    if (mocks[rel]) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel).exports;
    if (!['src/skills/knowledge.ts', 'src/skills/venue.ts', 'src/utils/venueSearch.ts', 'src/db/venues.ts'].includes(rel)) throw Error('Unexpected module ' + rel);
    if (!compiled.has(rel)) {
      const file = before && fs.existsSync(path.join(snapshot, rel)) ? path.join(snapshot, rel) : path.join(root, rel);
      compiled.set(rel, ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
    }
    const mod = { exports: {} }; modules.set(rel, mod);
    const req = s => s.startsWith('.') ? load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)) + '.ts') : require(s);
    vm.runInNewContext('(function(require,module,exports){' + compiled.get(rel) + '\n})', { process: { cwd: () => dir }, Buffer, console, Date, Set, Map }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  const profile = { user: { name: 'Fixture Owner', slack_user_id: 'UOWNER', timezone: 'UTC' } };
  const context = { profile, userId: 'UOWNER', senderRole: 'owner', channel: 'slack', ...options.context };
  return { dir, kb, queries, prompts, calls: () => calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    venue: args => new (load('src/skills/venue.ts').VenueSkill)().executeToolCall('find_venue', args, context),
    ingest: () => load('src/skills/knowledge.ts').ingestKnowledgeDoc({ profile, text: 'Full source content for a durable knowledge document over fifty characters.', sourceHint: 'https://source.example/doc', anthropic }),
    knowledge: args => new (load('src/skills/knowledge.ts').KnowledgeBaseSkill)().executeToolCall('manage_knowledge', args, context),
    prompt: owner => new (load('src/skills/knowledge.ts').KnowledgeBaseSkill)().getSystemPromptSection(profile, undefined, owner),
    lookup: (name, location) => load('src/db/venues.ts').findVenueByNameAndOwner('UOWNER', name, location),
  };
}
function check(name, options, fn) { test(name, async () => { const h = harness(options); try { await fn(h); } finally { h.cleanup(); } }); }
const named = { name_hint: 'Cafe', meeting_time: '2026-09-21T10:00:00Z' }; // Monday
check('V1 omitted weekday remains unknown and visible', { candidates: [{ name: 'Cafe', opening_hours_by_day: { Friday: ['08:00-16:00'] } }] }, async h => { const r = await h.venue(named); assert.equal(r.options[0]?.hours_status, 'unknown'); });
check('V1 explicit closed weekday remains excluded', { candidates: [{ name: 'Cafe', opening_hours_by_day: { Monday: [] } }] }, async h => assert.equal((await h.venue(named)).options.length, 0));
check('V1 explicit open weekday remains visible', { candidates: [{ name: 'Cafe', opening_hours_by_day: { Monday: ['08:00-16:00'] } }] }, async h => assert.equal((await h.venue(named)).options[0]?.hours_status, 'open'));
check('V1 overnight carryover remains open despite omitted day', { candidates: [{ name: 'Cafe', opening_hours_by_day: { Sunday: ['22:00-12:00'] } }] }, async h => assert.equal((await h.venue(named)).options[0]?.hours_status, 'open'));
check('V1 absent time keeps unknown', {}, async h => assert.equal((await h.venue({ name_hint: 'Cafe' })).options[0]?.hours_status, 'unknown'));
check('V2 named avoided venue never reenters through fresh results', { rows: [{ id: 'v1', name: 'Cafe', rank: 1 }] }, async h => { const r = await h.venue(named); assert.equal(r.options.length, 0); assert.equal(r.hidden_count, 1); });
check('V2 discovery avoided venue never reenters through fresh results', { rows: [{ id: 'v1', name: 'Cafe', rank: 1 }] }, async h => { const r = await h.venue({ area: 'City' }); assert.equal(r.options.length, 0); assert.equal(r.hidden_count, 1); });
check('V2 explicit include_hidden preserves stored rank', { rows: [{ id: 'v1', name: 'Cafe', rank: 1 }] }, async h => assert.equal((await h.venue({ ...named, include_hidden: true })).options[0].rank, 1));
check('V2 ordinary favorite catalog remains ranked', { rows: [{ id: 'v1', name: 'Cafe', rank: 3 }] }, async h => assert.equal((await h.venue(named)).options[0].rank, 3));
check('V2 unrelated fresh discovery remains available', { rows: [{ id: 'v1', name: 'Avoid', rank: 1 }] }, async h => assert.equal((await h.venue({ area: 'City' })).options[0].name, 'Cafe'));
check('V3 name plus area retains named query and ambiguity', { candidates: [{ name: 'Cafe North' }, { name: 'Cafe South' }] }, async h => { const r = await h.venue({ name_hint: 'Cafe', area: 'City' }); assert.match(h.queries[0], /Cafe/); assert.equal(r.ambiguity_flag, true); });
check('V3 area only discovery remains general', {}, async h => { const r = await h.venue({ area: 'City', type: 'coffee' }); assert.equal(r.options.length, 1); assert.match(h.queries[0], /City/); assert.equal(r.ambiguity_flag, false); });
check('V3 missing input rejects without provider calls', {}, async h => { assert.equal((await h.venue({})).error, 'missing_input'); assert.equal(h.calls(), 0); });
check('V3 unavailable search returns explicit no_match', { searchFails: true }, async h => assert.equal((await h.venue(named)).error, 'no_match'));
check('K1 oversized create is rejected and leaves no unreadable file', { condensed: 'א'.repeat(17000) }, async h => { assert.equal((await h.ingest()).kind, 'rejected'); assert.equal(fs.existsSync(path.join(h.kb, 'company/product.md')), false); });
check('K1 oversized sibling is rejected and leaves no file', { action: 'sibling', existingMatch: 'company/existing', condensed: 'a'.repeat(33000) }, async h => { assert.equal((await h.ingest()).kind, 'rejected'); assert.equal(fs.existsSync(path.join(h.kb, 'company/product_2.md')), false); });
check('K1 oversized merge preserves readable original on retry', { action: 'merge', existingMatch: 'company/product', sections: { 'company/product': 'p'.repeat(32000) }, condensed: 'u'.repeat(1000) }, async h => { assert.equal((await h.ingest()).kind, 'rejected'); assert.equal((await h.ingest()).kind, 'rejected'); const r = await h.knowledge({ action: 'get', section_id: 'company/product' }); assert.equal(r.ok, true); assert.equal(r.content.length, 32000); });
check('K1 ordinary create is readable through tool', {}, async h => { assert.equal((await h.ingest()).kind, 'created'); assert.equal((await h.knowledge({ action: 'get', section_id: 'company/product' })).ok, true); });
check('K1 ordinary sibling remains readable', { action: 'sibling', existingMatch: 'company/existing' }, async h => { const r = await h.ingest(); assert.equal(r.kind, 'sibling'); assert.equal((await h.knowledge({ action: 'get', section_id: r.sectionId })).ok, true); });
check('K1 ordinary merge retains old and new content', { action: 'merge', existingMatch: 'company/product', sections: { 'company/product': 'Prior original content' } }, async h => { assert.equal((await h.ingest()).kind, 'merged'); const r = await h.knowledge({ action: 'get', section_id: 'company/product' }); assert.match(r.content, /Prior original content/); assert.match(r.content, /grounded description/); });
check('K2 unreadable merge never forks a duplicate', { action: 'merge', existingMatch: 'company/product', sections: { 'company/product': 'p'.repeat(33000) } }, async h => { assert.equal((await h.ingest()).kind, 'rejected'); assert.equal(fs.existsSync(path.join(h.kb, 'company/product_2.md')), false); });
check('K2 missing merge target never silently becomes create', { action: 'merge', existingMatch: 'company/missing' }, async h => { assert.equal((await h.ingest()).kind, 'rejected'); assert.equal(fs.existsSync(path.join(h.kb, 'company/product.md')), false); });
check('K2 absent merge metadata is rejected', { action: 'merge' }, async h => assert.equal((await h.ingest()).kind, 'rejected'));
check('KB unavailable model leaves no storage', { modelFails: true }, async h => { assert.equal((await h.ingest()).reason, 'classifier_error'); assert.equal(fs.existsSync(path.join(h.kb, 'company/product.md')), false); });
check('KB URL ingestion surfaces oversize failure through actual tool', { condensed: 'a'.repeat(33000) }, async h => { const r = await h.knowledge({ action: 'ingest', url: 'https://source.example/doc' }); assert.equal(r.ok, false); assert.equal(r.reason, 'section_too_large'); });
check('KB unreadable extraction produces page_unreadable without model', { extractFails: true }, async h => { assert.equal((await h.knowledge({ action: 'ingest', url: 'https://source.example/doc' })).error, 'page_unreadable'); assert.equal(h.calls(), 0); });
check('KB internal colleague reads but cannot ingest', { context: { senderRole: 'colleague', userId: 'UCOLLEAGUE' }, sections: { 'company/product': 'Existing section' } }, async h => { assert.equal((await h.knowledge({ action: 'get', section_id: 'company/product' })).ok, true); assert.equal((await h.knowledge({ action: 'ingest', url: 'https://source.example/doc' })).error, 'kb_action_owner_only'); });
check('KB external colleague cannot read content or catalog', { context: { senderRole: 'colleague', userId: 'UEXTERNAL' }, senderEmail: 'external@other.example', sections: { 'company/product': 'Existing section' } }, async h => { assert.equal((await h.knowledge({ action: 'get', section_id: 'company/product' })).error, 'kb_external_blocked'); assert.equal((await h.knowledge({ action: 'get' })).error, 'kb_external_blocked'); });
check('K3 nonowner room and DM prompt excludes confidential catalog', { sections: { 'strategy/acquisition-secret': 'Confidential content' } }, async h => { assert.doesNotMatch(h.prompt(false), /acquisition-secret/); assert.doesNotMatch(h.prompt(undefined), /acquisition-secret/); });
check('K3 owner prompt retains catalog and excludes content', { sections: { 'strategy/acquisition-secret': 'Confidential content' } }, async h => { assert.match(h.prompt(true), /acquisition-secret/); assert.doesNotMatch(h.prompt(true), /Confidential content/); });
const north = { id: 'saved-north', name: 'Cafe', area_tags: '["North"]', address: '1 North Street', rank: 3 };
const south = { name: 'Cafe', area_tags: ['South'], address: '2 South Street', phone: '555-new' };
for (const mode of ['named', 'discovery']) {
  const args = mode === 'named' ? { name_hint: 'Cafe', area: 'South' } : { area: 'South' };
  check('R1 '+mode+' preserves requested fresh branch address maps and contact', { rows: [north], candidates: [south] }, async h => {
    const r = await h.venue(args); assert.equal(r.options.length, 1); const c = r.options[0];
    assert.equal(c.address, '2 South Street'); assert.equal(c.phone, '555-new'); assert.equal(c.rank, null); assert.equal(c.venue_id, null); assert.match(decodeURIComponent(c.maps_url), /2 South Street/);
  });
  check('R1 '+mode+' other branch avoid does not hide requested fresh branch', { rows: [{ ...north, rank: 1 }], candidates: [south] }, async h => {
    const r = await h.venue(args); assert.equal(r.options.length, 1); assert.equal(r.options[0].address, south.address); assert.equal(r.options[0].rank, null);
  });
}
check('R1 discovery dedup preserves different same-name branch', { rows: [north], candidates: [south] }, async h => {
  const r = await h.venue({ type: 'coffee', max_options: 3 }); assert.equal(r.options.length, 2); assert.equal(r.options[0].venue_id, 'saved-north'); assert.equal(r.options[1].address, south.address);
});
check('R1 discovery same-address canonical match remains deduplicated', { rows: [north], candidates: [{ ...south, address: north.address }] }, async h => {
  const r = await h.venue({ type: 'coffee', max_options: 3 }); assert.equal(r.options.length, 1); assert.equal(r.options[0].venue_id, 'saved-north');
});
check('R1 same-location avoided fresh venue stays hidden despite stale catalog area', { rows: [{ ...north, rank: 1, address: south.address }], candidates: [south] }, async h => {
  const r = await h.venue({ name_hint: 'Cafe', area: 'South' }); assert.equal(r.options.length, 0);
});
check('R1 known same-location fresh result preserves contact and stored rank', { rows: [{ ...north, address: south.address, phone: '555-old' }], candidates: [south] }, async h => {
  const r = await h.venue({ name_hint: 'Cafe', area: 'South', type_tags: ['kosher'] }); assert.equal(r.options[0].phone, '555-new'); assert.equal(r.options[0].rank, 3); assert.equal(r.options[0].venue_id, 'saved-north');
});
check('R1 include_hidden retains matched avoid rank and fresh contact', { rows: [{ ...north, address: south.address, rank: 1, phone: '555-old' }], candidates: [south] }, async h => {
  const r = await h.venue({ area: 'South', type_tags: ['kosher'], include_hidden: true }); assert.equal(r.options[0].rank, 1); assert.equal(r.options[0].phone, '555-new');
});
check('R1 composite saved location cannot replace another branch', { rows: [{ ...north, name: 'Cafe, 1 North Street', address: null }], candidates: [south] }, async h => {
  const r = await h.venue({ area: 'South' }); assert.equal(r.options[0].rank, null); assert.equal(r.options[0].address, south.address);
});
check('R1 explicit branch conflict cannot transfer preference when address missing', { rows: [{ ...north, address: null, branch_name: 'North' }], candidates: [{ ...south, address: undefined, branch_name: 'South' }] }, async h => {
  const r = await h.venue({ area: 'South' }); assert.equal(r.options[0].rank, null); assert.equal(r.options[0].branch_name, 'South');
});
check('R1 disjoint known area tags cannot transfer preference without address', { rows: [{ ...north, address: null, rank: 1 }], candidates: [{ ...south, address: undefined }] }, async h => {
  const r = await h.venue({ area: 'South' }); assert.equal(r.options.length, 1); assert.equal(r.options[0].rank, null);
});
check('R1 lookup checks later same-name row after first conflicting address', { rows: [north, { ...north, id: 'saved-south', address: south.address, area_tags: '["South"]', rank: 1 }] }, async h => {
  assert.equal(h.lookup('Cafe', { address: south.address, areaTags: south.area_tags }).id, 'saved-south');
});
check('R1 legacy name-only callers preserve canonical composite lookup', { rows: [{ ...north, name: 'Cafe, 1 North Street' }] }, async h => {
  assert.equal(h.lookup('Cafe').id, 'saved-north');
});
const compositeSouth = 'Cafe, 2 South Street, South';
for (const mode of ['named', 'discovery']) {
  const args = mode === 'named' ? { name_hint: compositeSouth, area: 'South' } : { area: 'South' };
  check('R2 '+mode+' exact composite saved avoid matches street-only fresh address', { rows: [{ id: 'avoided-south', name: compositeSouth, address: null, area_tags: '["South"]', rank: 1 }], candidates: [{ name: compositeSouth, address: '2 South Street', area_tags: ['South'] }] }, async h => {
    const r = await h.venue(args); assert.equal(r.options.length, 0); assert.equal(r.hidden_count, 1);
  });
}
check('R2 bare candidate same street and city retains saved composite avoid', { rows: [{ id: 'avoided-south', name: compositeSouth, address: null, area_tags: '["South"]', rank: 1 }], candidates: [south] }, async h => {
  assert.equal((await h.venue({ area: 'South' })).options.length, 0);
});
check('R2 explicit full address and street-only candidate are compatible', { rows: [{ ...north, address: '2 South Street, South', rank: 1, area_tags: '["South"]' }], candidates: [south] }, async h => {
  assert.equal((await h.venue({ area: 'South' })).options.length, 0);
});
check('R2 same street in a different named city remains a distinct branch', { rows: [{ ...north, name: 'Cafe, 2 Main Street, North', address: null }], candidates: [{ name: 'Cafe, 2 Main Street, South', address: '2 Main Street', area_tags: ['South'] }] }, async h => {
  const r = await h.venue({ area: 'South' }); assert.equal(r.options[0].rank, null); assert.equal(r.options[0].name, 'Cafe, 2 Main Street, South');
});
check('R2 partial street evidence cannot override conflicting known areas', { rows: [{ ...north, name: 'Cafe, 2 Main Street, North', address: null, rank: 1 }], candidates: [{ name: 'Cafe', address: '2 Main Street', area_tags: ['South'] }] }, async h => {
  const r = await h.venue({ area: 'South' }); assert.equal(r.options.length, 1); assert.equal(r.options[0].rank, null);
});
check('R2 address component prefix never means street-number prefix', { rows: [{ ...north, name: 'Cafe, 20 South Street, South', address: null, rank: 1 }], candidates: [south] }, async h => {
  const r = await h.venue({ area: 'South' }); assert.equal(r.options.length, 1); assert.equal(r.options[0].rank, null);
});
check('R2 multilingual comma-delimited address retains exact location rank', { rows: [{ id: 'he-cafe', name: 'קפה, הרצל 2, תל אביב', address: null, area_tags: '["תל אביב"]', rank: 1 }], candidates: [{ name: 'קפה', address: 'הרצל 2', area_tags: ['תל אביב'] }] }, async h => {
  assert.equal((await h.venue({ area: 'תל אביב' })).options.length, 0);
});
check('R2 explicit hidden composite keeps saved rank and fresh contact', { rows: [{ id: 'avoided-south', name: compositeSouth, address: null, area_tags: '["South"]', rank: 1 }], candidates: [south] }, async h => {
  const r = await h.venue({ area: 'South', type_tags: ['kosher'], include_hidden: true }); assert.equal(r.options[0].rank, 1); assert.equal(r.options[0].phone, '555-new');
});
// Whole stored/fresh representation matrix: explicit fields are authoritative;
// display-name suffix is an inferred address only when the field is missing.
const locationShapes = [
  { label: 'bare explicit', name: 'Cafe', address: '2 South Street' },
  { label: 'area label explicit', name: 'Cafe, South', address: '2 South Street' },
  { label: 'composite explicit', name: compositeSouth, address: '2 South Street' },
  { label: 'composite inferred', name: compositeSouth, address: null },
];
for (const stored of locationShapes) for (const fresh of locationShapes) for (const mode of ['named','discovery']) {
  const row = { id: 'avoided-south', name: stored.name, address: stored.address, area_tags: '["South"]', rank: 1 };
  const cand = { name: fresh.name, address: fresh.address ?? undefined, area_tags: ['South'], phone: '555-new' };
  const args = mode === 'named' ? { name_hint: fresh.name, area: 'South' } : { area: 'South' };
  check(`R3 ${mode} same place ${stored.label} to ${fresh.label} preserves avoid`, { rows: [row], candidates: [cand] }, async h => {
    assert.equal((await h.venue(args)).options.length, 0);
  });
}
for (const shape of locationShapes) for (const mode of ['named','discovery']) {
  const row = { id: 'avoided-north', name: shape.name.replaceAll('South','North'), address: shape.address?.replaceAll('South','North') ?? null, area_tags: '["North"]', rank: 1 };
  const cand = { name: 'Cafe, South', address: '2 South Street', area_tags: ['South'], phone: '555-new' };
  const args = mode === 'named' ? { name_hint: cand.name, area: 'South' } : { area: 'South' };
  check(`R3 ${mode} different place from ${shape.label} keeps fresh location`, { rows: [row], candidates: [cand] }, async h => {
    const r = await h.venue(args); assert.equal(r.options.length, 1); assert.equal(r.options[0].rank, null); assert.equal(r.options[0].address, '2 South Street'); assert.equal(r.options[0].phone, '555-new');
  });
}
check('R3 explicit address wins over stale or nonaddress display suffix', { rows: [{ ...north, name: 'Cafe, Old label', address: '2 South Street', rank: 1, area_tags: '["South"]' }], candidates: [{ ...south, name: 'Cafe, New label' }] }, async h => {
  assert.equal((await h.venue({ area: 'South' })).options.length, 0);
});
