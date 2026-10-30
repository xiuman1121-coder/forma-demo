import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {comparePlanning} from '../backend/planning-compare.mjs';
import {proxyFetch} from '../backend/proxy-fetch.mjs';

const plan={mode:'generate',styleAnalysis:null,items:[{purpose:'主图',sellingPoint:'',visualDirection:'暖光',newScene:'客厅',newCamera:'平视',newComposition:'柜体居中',referenceIds:['image-1'],targetAssetId:null}]};
async function fixture(run){
 const dataDir=mkdtempSync(path.join(os.tmpdir(),'forma-compare-'));
 try{
  mkdirSync(path.join(dataDir,'media'));
  writeFileSync(path.join(dataDir,'media','input.png'),Buffer.from('mock-image-pixels'));
  const project={id:'project-1',brief:'红色边柜',uploads:[{id:'image-1',kind:'image',label:'边柜',role:'product',url:'/media/input.png'}],assets:[],jobs:[],messages:[]};
  const job={id:'job-1',text:'设计三栏功能图',selection:['image-1']};
  await run({dataDir,project,job});
 }finally{rmSync(dataDir,{recursive:true,force:true})}
}
test('GLM 与 GPT 使用同一份 Planning Prompt、需求和图片，结果记录不含密钥或 base64',async()=>fixture(async context=>{
 const calls=[];
 const fetcher=async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body),authorization:options.headers.Authorization});
  return url.includes('openai.com')
   ?{ok:true,json:async()=>({id:'response-1',status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(plan)}]}],usage:{input_tokens:20,output_tokens:30}})}
   :{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:30}})};
 };
 const env={ZHIPU_API_KEY:'glm-secret',OPENAI_API_KEY:'openai-secret',OPENAI_PLANNING_MODEL:'gpt-test'};
 const glm=await comparePlanning({provider:'glm',...context,env,fetcher,now:()=>100});
 const gpt=await comparePlanning({provider:'gpt',...context,env,fetcher,now:()=>100});
 assert.equal(calls.length,2);
 assert.equal(calls[0].body.messages[0].content,calls[1].body.input[0].content[0].text);
 assert.equal(calls[0].body.messages[1].content[0].text,calls[1].body.input[1].content[0].text);
 assert.equal(calls[0].body.messages[1].content[2].image_url.url,calls[1].body.input[1].content[2].image_url);
 assert.equal(calls[1].body.text.format.strict,true);
 assert.equal(calls[1].body.store,false);
 assert.deepEqual(glm.plan,gpt.plan);
 assert.deepEqual(glm.input,gpt.input);
 assert.equal(gpt.usage.output_tokens,30);
 assert.equal(glm.rawReply,JSON.stringify(plan));
 assert.ok(!JSON.stringify(gpt).includes('openai-secret'));
 assert.ok(!JSON.stringify(glm).includes('glm-secret'));
 assert.ok(!JSON.stringify(gpt).includes('base64'));
}));

test('无密钥或未指定 GPT 型号时，在网络调用前停止',async()=>fixture(async context=>{
 let calls=0;
 const fetcher=async()=>{calls++;throw Error('不应调用网络')};
 await assert.rejects(comparePlanning({provider:'gpt',...context,env:{},fetcher}),/OPENAI_API_KEY/);
 await assert.rejects(comparePlanning({provider:'gpt',...context,env:{OPENAI_API_KEY:'mock'},fetcher}),/OPENAI_PLANNING_MODEL/);
 assert.equal(calls,0);
}));

test('无效 JSON 与 HTTP 失败有清晰状态，且不自动重试',async()=>fixture(async context=>{
 let calls=0;
 const invalid=await comparePlanning({provider:'glm',...context,env:{ZHIPU_API_KEY:'mock'},fetcher:async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:'{invalid'}}],usage:{total_tokens:5}})}}});
 assert.equal(invalid.plan,null);
 assert.match(invalid.parseError,/JSON/);
 assert.equal(calls,1);
 await assert.rejects(comparePlanning({provider:'gpt',...context,env:{OPENAI_API_KEY:'mock',OPENAI_PLANNING_MODEL:'test'},fetcher:async()=>{calls++;return {ok:false,status:429,json:async()=>({error:{code:'insufficient_quota',message:'private detail'}})}}}),/HTTP 429 \(insufficient_quota\)/);
 assert.equal(calls,2);
}));

test('独立入口的网络适配器通过私有管道发送请求头与图片数据',async()=>{
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  assert.equal(req.headers.authorization,'Bearer mock-secret');
  assert.deepEqual(JSON.parse(body),{image:'base64-test'});
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const response=await proxyFetch(`http://127.0.0.1:${server.address().port}/test`,{method:'POST',headers:{Authorization:'Bearer mock-secret','Content-Type':'application/json'},body:JSON.stringify({image:'base64-test'})});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
