// Installed SDK wire contracts with a fake fetch only: no network or credentials.
const {test}=require('node:test'),assert=require('node:assert/strict');
const Anthropic=require('@anthropic-ai/sdk'),{AnthropicVertex}=require('@anthropic-ai/vertex-sdk');
const {SONNET,HAIKU}=require('./load-test-models.cjs');
for(const provider of ['direct','vertex'])for(const [name,policy] of [['sonnet',SONNET],['haiku',HAIKU]])test(`${provider}-${name}-wire-policy`,async()=>{
 let sent;
 const fetch=async(url,init)=>{sent={url:String(url),body:JSON.parse(init.body)};return new Response(JSON.stringify({id:'fixture',type:'message',role:'assistant',model:policy.model,content:[{type:'text',text:'READY'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});};
 const client=provider==='direct'?new Anthropic({apiKey:'synthetic-not-a-key',fetch,maxRetries:0}):new AnthropicVertex({authClient:{getRequestHeaders:async()=>new Headers({authorization:'Bearer synthetic-not-a-token'})},projectId:'synthetic-project',region:'global',fetch,maxRetries:0});
 const result=await client.messages.create({...policy,max_tokens:80,messages:[{role:'user',content:'Synthetic READY'}]});
 assert.equal(sent.body.thinking.type,policy.thinking.type);assert.equal(sent.body.max_tokens,80);assert.equal(result.content[0].text,'READY');
 if(provider==='vertex')assert.ok(sent.url.includes(policy.model));else assert.equal(sent.body.model,policy.model);
});

