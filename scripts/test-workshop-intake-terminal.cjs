// Direct canonical projection regressions against the preserved a4 preflight.
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path')
const at=process.argv.indexOf('--module'),v=require(at<0?'./workshop-verification.cjs':path.resolve(process.argv[at+1]))
for(const adopted of [false,true])for(const gate of ['deferred','needs-owner-decision'])for(const terminal of ['declined','converted','wrapped'])test(`${adopted?'adopted':'historical'} ${gate} then ${terminal} stays terminal`,()=>{
 const rows=[{ref:'a',verdict:'captured',...(adopted?{intake:{status:'captured'}}:{})},{ref:'a',verdict:gate},{ref:'a',verdict:terminal,...(terminal==='wrapped'?{state:'wrapped'}:{})}]
 const result=v.collapseRows(rows);assert.equal(result.open.length,0);assert.equal(result.closed[0].verdict,terminal)
})
test('unresolved adopted hold remains open',()=>assert.equal(v.collapseRows([{ref:'a',verdict:'captured',intake:{status:'captured'}},{ref:'a',verdict:'deferred'}]).open[0].verdict,'deferred'))
test('ordinary historical closure remains closed',()=>assert.equal(v.collapseRows([{ref:'a',verdict:'built'}]).closed.length,1))
