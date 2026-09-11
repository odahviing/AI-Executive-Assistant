// Actual resolver/replay + actual registered Slack callback/owner delivery helper.
// SRA_SOURCE_ROOT selects pre-bounce transport files; resolver stays current.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {test,afterEach}=require('node:test');
function prefix(file){const source=fs.readFileSync(path.join(__dirname,file),'utf8').split('\nafterEach(')[0];return new Function('require','__dirname',source+'\nreturn {harness,profile};')(require,__dirname);}
const approval=prefix('test-approval-replay-identity.cjs'),slack=prefix('test-slack-approval-reactions.cjs'),all=[];
afterEach(()=>{for(const h of all.splice(0))assert.deepEqual(h.unexpected||h.effects.unexpected,[]);});
for(const [id,options,attempts] of [
  ['attempted-uncheckable',{toolResult:{error:'approved_action_unconfirmed'},row:{owner_dm_channel:'DOWNER',owner_dm_thread_ts:'owner.daily'}},1],
  ['pre-dispatch-private-anchor',{tool:'message_colleague',row:{owner_dm_channel:'DOWNER',owner_dm_thread_ts:null}},0],
])test(`B02 joint ${id}: Slack delivers actual resolver outcome without adding a check/retry promise`,async()=>{
  const h=approval.harness(options);let resolved;
  const s=slack.harness({row:h.row(),resolve:async(_id,decision,ctx)=>resolved=await h.resolve(decision,{...ctx,profile:approval.profile})});
  all.push(h,s);await s.react();
  assert.equal(resolved.ok,false);assert.equal(h.effects.executes.length,attempts);
  assert.equal(s.effects.posts.length,1);
  assert.equal(s.effects.posts[0].text,`For "${h.row().subject}" (${h.row().id}): ${resolved.reason}`);
  assert.equal(s.effects.history[0][2].content,s.effects.posts[0].text);
});
test('B02 joint confirmed approval preserves ordinary success memory without recovery post',async()=>{
  const h=approval.harness({row:{owner_dm_channel:'DOWNER',owner_dm_thread_ts:'owner.daily'}});
  const s=slack.harness({row:h.row(),resolve:(_id,decision,ctx)=>h.resolve(decision,{...ctx,profile:approval.profile})});
  all.push(h,s);await s.react();assert.equal(h.row().state,'resolved');
  assert.equal(s.effects.posts.length,0);assert.equal(s.effects.history.length,1);
});
