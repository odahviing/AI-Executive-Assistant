const fs=require('fs'),cp=require('child_process'),path=require('path');
const root=process.cwd(), supplied=process.argv[2]||'.gitignore';
const output=path.join(root,'artifacts/workshop-verification/maintenance-run-20261011/handyman');
fs.mkdirSync(output,{recursive:true});
const dir=fs.mkdtempSync(path.join(output,'ignore-fixture-'));
cp.execFileSync('git',['init','-q',dir]);fs.copyFileSync(supplied,path.join(dir,'.gitignore'));
const cases=[['regression-evidence','artifacts/regression-yael-20261007/report.json',true],['bookkeeping-directory','.workshop-bookkeeping-123/log.json',true],['bookkeeping-file','.workshop-bookkeeping-123.json',true],['durable-fixture','scripts/fixtures/regression-yael/test.json',false],['unrelated-artifact','artifacts/design/source.json',false],['existing-evidence','artifacts/workshop-verification/test.json',true]];
let passed=0,failed=0;for(const [id,file,want] of cases){fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),'preserved');const r=cp.spawnSync('git',['check-ignore','--quiet','--',file],{cwd:dir});const ok=(r.status===0)===want;console.log(`${ok?'PASS':'FAIL'} ${id}`);ok?passed++:failed++;if(fs.readFileSync(path.join(dir,file),'utf8')!=='preserved')throw Error('data modified');}
console.log(JSON.stringify({passed,failed,fixture:dir}));process.exitCode=failed?1:0;

