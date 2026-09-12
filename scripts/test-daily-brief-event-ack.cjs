// Actual brief + actual events.ts selection/acknowledgement, isolated SQLite only.
// Fixture loader pattern follows existing Librarian/Bouncer module harnesses.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {test,after}=require('node:test');
const root=path.resolve(__dirname,'..');
const db=new Database(':memory:');db.exec('CREATE TABLE events (id TEXT,owner_user_id TEXT,seen INTEGER,created_at TEXT,title TEXT)');
after(()=>db.close());
const eventModule={exports:{}};
const eventCode=ts.transpileModule(fs.readFileSync(path.join(root,'src/db/events.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInThisContext('(function(require,module,exports){'+eventCode+'\n})')(s=>{if(s==='./client')return {getDb:()=>db};throw Error(s)},eventModule,eventModule.exports);
let source=fs.readFileSync(path.join(root,'scripts/test-librarian-action-outcomes.cjs'),'utf8');source=source.slice(0,source.indexOf('function person('))+source.slice(source.indexOf('function brief('),source.indexOf('for (const [label, options]'));
source=source.replace("const source = revision ?", "const source = relative === 'src/tasks/briefs.ts' && process.env.BRIEF_SOURCE_FIXTURE ? fs.readFileSync(process.env.BRIEF_SOURCE_FIXTURE, 'utf8') : revision ?");
source=source.replace('markEventsSeen: () => effects.seen++',"markEventsSeen: owner => require('fixture-events').markEventsSeen(owner)");
source+='\nmodule.exports={brief};';const out={exports:{}};
vm.runInThisContext('(function(require,module,exports,__dirname){'+source+'\n})')(s=>s==='fixture-events'?eventModule.exports:require(s),out,out.exports,__dirname);
function reset(){db.prepare('DELETE FROM events').run();for(const [id,owner,seen]of [['unshown','UOWNER',0],['other','UOTHER',0],['already_seen','UOWNER',1]])db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(id,owner,seen,'2026-09-12T00:00:00Z','UNIQUE_'+id);}
const ids=owner=>eventModule.exports.getUnseenEvents(owner).map(x=>x.id);
for(const force of [false,true])test('uncollected-event-survives-'+(force?'requested':'scheduled')+'-delivery',async()=>{reset();const h=out.exports.brief();await h.run(force);assert.equal(h.effects.posts.length,1);assert.ok(!h.effects.posts[0][1].includes('UNIQUE_unshown'));assert.deepEqual(ids('UOWNER'),['unshown']);assert.deepEqual(ids('UOTHER'),['other']);assert.equal(h.effects.surfaced,1);assert.equal(h.effects.closures,1);});
test('control-refused-delivery-preserves-unseen-events',async()=>{reset();const h=out.exports.brief({sendFails:true});await assert.rejects(h.run());assert.deepEqual(ids('UOWNER'),['unshown']);assert.equal(h.effects.surfaced+h.effects.closures,0);});
test('control-real-reader-acknowledges-only-owner-consumed-events',()=>{reset();const selected=eventModule.exports.getUnseenEvents('UOWNER');assert.deepEqual(selected.map(x=>x.id),['unshown']);eventModule.exports.markEventsSeen('UOWNER');assert.deepEqual(ids('UOWNER'),[]);assert.deepEqual(ids('UOTHER'),['other']);});
