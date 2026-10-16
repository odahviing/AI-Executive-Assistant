// Actual handler, SQL request handoff and isolated effects from the maintained Registrar fixture.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {test}=require('node:test'),assert=require('node:assert/strict');
const filename=path.join(__dirname,'test-owner-reschedule-rulings.cjs');
const fixtureModule=new Module(filename,module);fixtureModule.filename=filename;fixtureModule.paths=module.paths;
fixtureModule._compile(fs.readFileSync(filename,'utf8').split("test('FYI confirmed delivery")[0]+'\nmodule.exports=fixture;',filename);
const fixture=fixtureModule.exports;
test('counter without authoritative date must preserve next-week reply for owner decision',async()=>{
 const h=fixture({active:true});h.ask();await h.reply();
 assert.equal(h.effects.moves,0,'HH:MM must not invent the proposed date');
 assert.equal(h.approvals().length,1);
 assert.deepEqual(JSON.parse(h.approvals()[0].details_json).open_options,['Maybe 09:15 next week; owner should choose the date']);
 h.restart();await h.reply();assert.equal(h.effects.moves,0);assert.equal(h.approvals().length,1);
 assert.equal(h.job().reply_text,'Maybe 09:15 next week; owner should choose the date');
 assert.deepEqual(JSON.parse(h.approvals()[0].details_json).open_options,[h.job().reply_text]);
});
test('legitimate passive counter already preserves unknown terms in tracked approval',async()=>{
 const h=fixture();h.ask();await h.reply();assert.equal(h.effects.moves,0);assert.equal(h.approvals().length,1);
 assert.equal(h.job().reply_text,'Maybe 09:15 next week; owner should choose the date');
 assert.deepEqual(JSON.parse(h.approvals()[0].details_json).open_options,[h.job().reply_text]);
});
test('legitimate acceptance retains exact proposed interval and terminal retry protection',async()=>{
 const h=fixture({active:true,status:'approved'});h.ask();await h.reply();assert.equal(h.effects.moves,1);assert.equal(h.approvals().length,0);
 assert.equal(h.effects.moveArgs[0].start,'2026-12-01T09:00:00Z');
 assert.equal(h.effects.moveArgs[0].end,'2026-12-01T09:30:00Z');
 assert.equal(h.effects.moveArgs[0].meetingId,'meeting-1');
 h.restart();await h.reply();assert.equal(h.effects.moves,1);
});
