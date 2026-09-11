// Run: node --test scripts/test-news-source-attribution.cjs
// Before-repair replay: set NEWS_SOURCE_FIXTURE to the preserved news.ts path.
// Loads the real, complete news module with a closed dependency allowlist.
// No application boot, DB, network, filesystem writes, or new production exports.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const sourcePath = process.env.NEWS_SOURCE_FIXTURE || path.resolve(__dirname, '../src/skills/news.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  fileName: sourcePath,
}).outputText;
const profile = { user: { name: 'News Test', company: 'Reflectiz', email: 'owner@reflectiz.com', timezone: 'UTC' } };
const statement = 'Reflectiz now gives teams timestamped evidence for every changed browser script and security control.';
const own = { url: 'https://reflectiz.com/update', content: statement };
const article = (url, content = 'Independent researchers evaluated Reflectiz alongside competing products.') => ({ url, content });

function harness(results, { plannedGoal = 'Reflectiz mentions', failSearch = false } = {}) {
  const unexpected = [];
  const warnings = [];
  const searches = [];
  let plans = 0;
  const forbidden = label => (...args) => {
    unexpected.push(label);
    throw new Error(`Forbidden side effect: ${label}`);
  };
  const dependencies = {
    fs: {
      existsSync: () => false,
      readFileSync: forbidden('readFileSync'),
      mkdirSync: forbidden('mkdirSync'),
      promises: new Proxy({}, { get: (_, name) => forbidden(`fs.promises.${String(name)}`) }),
    },
    path,
    luxon: { DateTime: { now: forbidden('DateTime.now') } },
    '../llm/client': { getAnthropicClient: () => ({ messages: { create: async () => {
      plans++;
      return { content: [{ text: JSON.stringify({ goals: [plannedGoal] }) }] };
    } } }) },
    '../llm/models': { MODEL_HAIKU: 'test-only' },
    './general': { tavilySearch: async (...args) => {
      searches.push(args);
      if (failSearch) throw new Error('Simulated search failure');
      return { results };
    } },
    '../utils/skillPreferences': { readSkillPreferences: () => '', formatSkillPreferencesBlock: forbidden('format preferences') },
    '../utils/logger': { info: () => {}, warn: (...args) => warnings.push(args) },
    '../utils/extractJson': { extractFirstJsonObject: text => text },
  };
  const sandbox = {
    exports: {}, URL, Intl, setTimeout, clearTimeout,
    process: { cwd: () => '/isolated-news-test' },
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      return forbidden(`require(${name})`)();
    },
  };
  vm.runInNewContext(compiled, sandbox, { filename: sourcePath });
  return {
    gather: async (opts = { topic: 'Reflectiz mentions' }, user = profile) => {
      const bundle = await sandbox.exports.gatherNews(user, opts);
      assert.deepEqual(unexpected, [], 'caught side effects must not be swallowed by gatherNews');
      assert.deepEqual(warnings, [], 'unexpected fail-open must not masquerade as filtering');
      return JSON.parse(JSON.stringify(bundle));
    },
    searches,
    plans: () => plans,
  };
}

async function check(results, expectedUrls, opts, user) {
  const h = harness(results);
  const bundle = await h.gather(opts, user);
  assert.deepEqual(bundle.sources.map(source => source.url), expectedUrls);
  assert.equal(h.searches.length, 1);
  return h;
}

test('incident URL: opaque Instagram is withheld without a self-published sibling', async () => {
  await check([article('https://www.instagram.com/p/Dc6XvaRDq-5/', statement)], []);
});

test('independent long article survives a complete short company quotation', async () => {
  const independent = article('https://daily.example/report',
    `Our reporters interviewed three auditors about changes in compliance practice. ${statement} Independent tests showed gaps in legacy controls. Analysts disagree about cost and adoption; competing vendors offer different tradeoffs for smaller teams.`);
  await check([own, independent], [independent.url]);
});

test('substantial copied snippet does not prove authorship on an identified external publisher', async () => {
  const copy = article('https://daily.example/company-statement', statement);
  await check([own, copy], [copy.url]);
});

test('substantial copied snippet at an opaque platform remains withheld', async () => {
  await check([own, article('https://instagram.com/p/copied-content', statement)], []);
});

test('independently worded company report remains eligible', async () => {
  const report = article('https://daily.example/review');
  await check([own, report], [report.url]);
});

const publishers = [
  ['own domain', 'https://reflectiz.com/news', false],
  ['own subdomain', 'https://blog.reflectiz.com/news', false],
  ['ordinary article slug', 'https://daily.example/tag/reflectiz', true],
  ['external directory', 'https://crunchbase.com/organization/reflectiz', true],
  ['own LinkedIn', 'https://linkedin.com/company/reflectiz/', false],
  ['external LinkedIn', 'https://linkedin.com/company/research-lab/', true],
  ['opaque LinkedIn post', 'https://linkedin.com/posts/reflectiz-activity-123/', false],
  ['own Instagram account', 'https://instagram.com/reflectiz/', false],
  ['external Instagram account', 'https://instagram.com/pclinkupstrategy/', true],
  ['external Instagram story', 'https://instagram.com/stories/researchlab/123/', true],
  ['opaque Instagram reel', 'https://instagram.com/reel/123/', false],
  ['own YouTube handle', 'https://youtube.com/@reflectiz/videos', false],
  ['external YouTube handle', 'https://youtube.com/@researchlab/videos', true],
  ['external YouTube user', 'https://youtube.com/user/researchlab', true],
  ['opaque YouTube channel', 'https://youtube.com/channel/UC12345', false],
  ['opaque YouTube video', 'https://youtube.com/watch?v=123', false],
  ['short YouTube URL', 'https://youtu.be/123', false],
  ['own X account', 'https://x.com/reflectiz/status/123', false],
  ['external X account', 'https://x.com/researchlab/status/123', true],
  ['opaque X status', 'https://x.com/i/status/123', false],
  ['external Facebook account', 'https://facebook.com/researchlab/posts/123', true],
  ['opaque Facebook share', 'https://facebook.com/share/123', false],
  ['own Medium handle', 'https://medium.com/@reflectiz/update', false],
  ['external Substack subdomain', 'https://researchlab.substack.com/p/update', true],
  ['own Substack subdomain', 'https://reflectiz.substack.com/p/update', false],
  ['external Reddit user', 'https://reddit.com/user/researchlab/comments/123', true],
  ['opaque Reddit community post', 'https://reddit.com/r/security/comments/123', false],
  ['external Threads handle', 'https://threads.net/@researchlab/post/123', true],
  ['external TikTok handle', 'https://tiktok.com/@researchlab/video/123', true],
  ['malformed URL', 'not-a-url', false],
];
for (const [name, url, eligible] of publishers) {
  test(`publisher attribution: ${name}`, async () => {
    await check([article(url)], eligible ? [url] : []);
  });
}

test('source without company mention is withheld even on an external domain', async () => {
  await check([article('https://daily.example/other', 'Browser security market report.')], []);
});

test('non-company goal preserves self, opaque and ungrounded results', async () => {
  const results = [own, article('https://instagram.com/p/123', 'General security market report.')];
  await check(results, results.map(result => result.url), { topic: 'browser security' });
});

for (const [company, content] of [
  ['אבטחה', 'חוקרים בדקו את אבטחה והשוו מוצרים נוספים בשוק.'],
  ['Защита', 'Исследователи сравнили Защита с другими продуктами.'],
  ['安全', '研究人员比较安全公司的产品和其他解决方案。'],
]) {
  test(`multilingual company mention: ${company}`, async () => {
    const result = article('https://daily.example/multilingual', content);
    await check([result], [result.url], { topic: company }, { user: { ...profile.user, company } });
  });
}

test('morning brief planner path applies the same filter', async () => {
  const report = article('https://daily.example/brief');
  const h = await check([own, report, article('https://instagram.com/p/123')], [report.url], { meetingCompanies: ['Reflectiz'] });
  assert.equal(h.plans(), 1);
});

test('on-demand topic bypasses planner and preserves recency', async () => {
  const h = await check([article('https://instagram.com/p/123')], [], { topic: 'Reflectiz mentions', recencyDays: 7 });
  assert.equal(h.plans(), 0);
  assert.equal(h.searches[0][2], 7);
});

test('failed search produces an empty bundle without new side effects', async () => {
  const h = harness([], { failSearch: true });
  assert.deepEqual((await h.gather()).sources, []);
});
