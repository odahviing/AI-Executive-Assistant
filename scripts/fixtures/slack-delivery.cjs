// Actual SQLite store and Slack delivery module with closed transport fixtures.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const Database=require('better-sqlite3');
const root=path.resolve(__dirname,'../..');
module.exports=function deliveryFixture(options={}) {
  const db=options.db||new Database(':memory:');
  const load=(file,deps)=>{
    const exports={};
    const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    vm.runInNewContext(code,{exports,require:name=>{if(name in deps)return deps[name];if(name==='crypto')return require('node:crypto');throw Error('Unexpected delivery dependency '+name);},console});
    return exports;
  };
  const api=load('src/db/slackDelivery.ts',{'./client':{getDb:()=>db}});
  api.initSlackDeliverySchema(db);
  const logs=[];
  const module=load('src/connectors/slack/deliveryAttempt.ts',{
    '../../db/slackDelivery':api,
    '../../connections/slack/eligibility':{readInternalSlackConversation:options.eligible||asyncTrue},
    './threadHistory':options.threadHistory||{readSlackThread:async()=>[]},
    '../../utils/logger':Object.fromEntries(['info','warn','error','debug'].map(k=>[k,(...args)=>logs.push([k,...args])])),
  });
  return {db,api,module,logs};
};
async function asyncTrue(){return true;}
