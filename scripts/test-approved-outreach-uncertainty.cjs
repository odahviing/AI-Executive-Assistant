// Actual outreach producer -> approved executor -> replay/resolver lifecycle.
// Only transport/DB services are isolated; the existing strict fixtures own imports.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture } = require('./fixtures/outreach-original-request.cjs');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const registryFile = before ? 'artifacts/workshop-verification/minor-5.2.0/handyman/before/registry.ts' : 'src/skills/registry.ts';
const tree = ts.createSourceFile(registryFile, fs.readFileSync(path.join(root, registryFile), 'utf8'), ts.ScriptTarget.Latest, true);
const nodes = tree.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'executeApprovedSkillTool'
  || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(tree) === 'WRITE_TOOLS'));
assert.equal(nodes.length, 2);
function approved(execute) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(nodes.map(n => n.getText(tree)).join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, executeSkillTool: execute, Set });
  return exports.executeApprovedSkillTool;
}
// Add an executor hook only to the existing fixture's mock registry boundary.
// Real resolver/replay/runner code and its closed loader stay intact.
const fixtureFile = path.join(__dirname, 'test-requester-relay-cap-resolver.cjs');
let fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const hook = "return o.execution||{status:'completed',result:{success:true,meetingId:'event'}};";
assert.equal(fixtureSource.split(hook).length, 2);
fixtureSource = fixtureSource.replace(hook, "return o.execute ? o.execute(tool,args,context) : o.execution||{status:'completed',result:{success:true,meetingId:'event'}};");
const moduleFixture = { exports: {} };
vm.runInNewContext('(function(require,module,exports,__dirname){' + fixtureSource + '\nmodule.exports={harness};})',
  { console, process, Date, Map, Set, Buffer, setTimeout, setImmediate })(
  name => name === 'node:test' ? { test() {} } : require(require.resolve(name, { paths: [__dirname] })),
  moduleFixture, moduleFixture.exports, __dirname);
const { harness } = moduleFixture.exports;
const action = { tool: 'message_colleague', args: { colleague_slack_id: 'COLLEAGUE', colleague_name: 'Colleague', message: 'Current owner artifact', await_reply: false } };
for (const room of [false, true]) for (const mode of ['unknown', 'throw', 'failed', 'success']) {
  test(`actual ${room ? 'channel' : 'DM'} ${mode} producer through approved replay`, async t => {
    const outbound = fixture({ mode }); t.after(() => outbound.db.close());
    let normalized;
    const execute = approved(async (_tool, args) => outbound.tool({ ...args, ...(room ? { channel_id: 'CROOM' } : {}) }));
    const h = harness({ execute: async (...args) => normalized = await execute(...args), row: {
      subkind: 'freeform', details_json: JSON.stringify({ question: 'Old draft ask', deferred_action: action }),
    } });
    const result = await h.resolve();
    assert.equal(outbound.effects.sends.length, 1);
    assert.deepEqual(outbound.effects.unexpected, []);
    if (mode === 'unknown' || mode === 'throw') {
      assert.equal(normalized.result.delivery_unconfirmed, true);
      assert.equal(normalized.result.error, 'approved_action_unconfirmed');
      assert.equal(normalized.result.execution_error, mode === 'throw' ? 'send_threw' : 'error');
      assert.equal(result.ok, false); assert.equal(result.effect, 'approve_replay_unconfirmed');
      assert.equal(h.row().state, 'resolved'); assert.equal(h.row().closure_reason, 'approved_action_attempted_unconfirmed');
      assert.equal(h.row().next_check_handler, null); assert.equal(result.action_summary, undefined);
      await h.resolve(); await h.sweep();
      const restarted = harness({ row: JSON.parse(JSON.stringify(h.row())), execute });
      await restarted.resolve(); await restarted.sweep(); restarted.check();
      assert.equal(outbound.effects.sends.length, 1, 'uncertain message never repeated');
    } else if (mode === 'failed') {
      assert.equal(normalized.result.error, 'not_attempted'); assert.equal(result.ok, false);
      assert.equal(h.row().state, 'awaiting_owner'); assert.equal(h.effects.sends.length, 0);
      outbound.options.mode = 'success'; await h.resolve(); assert.equal(outbound.effects.sends.length, 2);
    } else {
      assert.equal(normalized.status, 'completed'); assert.equal(result.ok, true);
      await h.resolve(); await h.sweep(); assert.equal(outbound.effects.sends.length, 1);
    }
    h.check();
  });
}
test('unavailable transport is definite failure before any send', async t => {
  const h = fixture({ noConnection: true }); t.after(() => h.db.close());
  const result = await approved(() => h.tool())('message_colleague', {}, {
    authority: 'owner', userId: 'OWNER', profile: h.profile, surface: 'owner_dm', channelId: 'DOWNER', threadTs: 'owner.1',
  });
  assert.equal(result.status, 'failed'); assert.notEqual(result.result.error, 'approved_action_unconfirmed');
  assert.equal(h.effects.sends.length, 0);
});
