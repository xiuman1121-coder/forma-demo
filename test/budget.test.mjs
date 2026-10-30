import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Budget,validateLayer} from '../backend/core.mjs';
import {runAgent} from '../backend/agent.mjs';
const imageDecision={stage:'execute',operation:'generate',allowedEffects:['read','paid_image','asset_write','save_brief']};
test('总预算上限为 80 元，已有支出继续计入余额',()=>{const d=mkdtempSync(path.join(os.tmpdir(),'forma-cap-'));try{const f=path.join(d,'budget.json'),budget=new Budget(f,8000);assert.equal(budget.snapshot().limitFen,8000);const id=budget.reserve('old',12);budget.finish(id,'estimated');const restored=new Budget(f,8000);assert.equal(restored.snapshot().usedFen,12);assert.equal(restored.snapshot().remainingFen,7988);assert.equal(new Budget(f,9000).snapshot().limitFen,8000)}finally{rmSync(d,{recursive:true,force:true})}});
test('预算持久化，未确认费用仍占用余额，超额请求拒绝',()=>{const d=mkdtempSync(path.join(os.tmpdir(),'forma-'));try{const f=path.join(d,'budget.json'),b=new Budget(f,24);const id=b.reserve('a');b.finish(id,'uncertain');const restored=new Budget(f,24);restored.reserve('b');assert.equal(restored.snapshot().remainingFen,0);assert.throws(()=>restored.reserve('c'));assert.throws(()=>restored.reserve('c',-12))}finally{rmSync(d,{recursive:true})}});
test('同轮重复生图工具只发送一次供应商请求，失败不重试',async()=>{const d=mkdtempSync(path.join(os.tmpdir(),'forma-'));try{let brain=0,images=0;const call=i=>({id:String(i),type:'function',function:{name:'create_image',arguments:JSON.stringify({prompt:'test',title:'test',reference_ids:[],text_mode:'none',text_content:[],edit_asset_id:''})}});const fetcher=async url=>{if(url.includes('bigmodel'))return {ok:true,json:async()=>({choices:[{message:brain++===0?{tool_calls:[call(1),call(2)]}:{content:'done'}}]})};images++;return {ok:false,status:500,json:async()=>({})}};const budget=new Budget(path.join(d,'b.json'),100);await assert.rejects(runAgent({project:{uploads:[],assets:[],messages:[{role:'user',text:'test'}]},job:{id:'x',text:'test',usage:[],routingDecision:imageDecision},env:{ARK_API_KEY:'fake'},budget,dataDir:d,emit:()=>{},persist:()=>{},fetcher}),/HTTP 500/);assert.equal(images,1);assert.equal(budget.snapshot().usedFen,17)}finally{rmSync(d,{recursive:true})}});

test('生图工具参数不是合法 JSON 时不使用空参数兜底，也不发送付费请求',async()=>{
 const d=mkdtempSync(path.join(os.tmpdir(),'forma-tool-json-'));
 try{
  let imageCalls=0;
  const fetcher=async url=>{
   if(url.includes('volces')){imageCalls++;throw Error('不应发送生图请求')}
   return {ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'invalid',function:{name:'create_image',arguments:'{"prompt":"为"So Far"制作主图"}'}}]}}]})};
  };
  await assert.rejects(runAgent({project:{uploads:[],assets:[],messages:[{role:'user',text:'做一张主图'}]},job:{id:'invalid-tool-json',text:'做一张主图',usage:[],routingDecision:imageDecision},env:{ARK_API_KEY:'fake'},budget:new Budget(path.join(d,'budget.json'),100),dataDir:d,emit:()=>{},persist:()=>{},fetcher}),/工具参数不是合法 JSON/);
  assert.equal(imageCalls,0);
 }finally{rmSync(d,{recursive:true,force:true})}
});

test('Agent 服务响应本身不是 JSON 时不发送付费生图请求',async()=>{
 const d=mkdtempSync(path.join(os.tmpdir(),'forma-agent-response-json-'));
 try{
  let imageCalls=0;
  const fetcher=async url=>url.includes('volces')?(imageCalls++,Promise.reject(Error('不应发送生图请求'))):{ok:true,json:async()=>{throw SyntaxError('Unexpected token')}};
  await assert.rejects(runAgent({project:{uploads:[],assets:[],messages:[{role:'user',text:'做一张主图'}]},job:{id:'invalid-agent-response',text:'做一张主图',usage:[],routingDecision:imageDecision},env:{ARK_API_KEY:'fake'},budget:new Budget(path.join(d,'budget.json'),100),dataDir:d,emit:()=>{},persist:()=>{},fetcher}),/理解服务响应不是合法 JSON/);
  assert.equal(imageCalls,0);
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('文字层拒绝非法样式',()=>{assert.throws(()=>validateLayer({text:'x',x:0,y:0,size:50,color:'red;display:none'}))});
test('生图成功结果可被下一步文字工具引用并保留版本',async()=>{const d=mkdtempSync(path.join(os.tmpdir(),'forma-'));try{const project={uploads:[],assets:[],messages:[{role:'user',text:'test'}]};let n=0;const fetcher=async url=>{if(!url.includes('bigmodel'))return {ok:true,json:async()=>({data:[{b64_json:Buffer.alloc(120,137).toString('base64')}]})};const name=n===0?'create_image':'edit_text';const args=n===0?{prompt:'test',title:'test',reference_ids:[],text_mode:'none',text_content:[],edit_asset_id:''}:{asset_id:project.assets[0].id,text:'标题',x:8,y:12,size:56,color:'#ffffff'};return {ok:true,json:async()=>({choices:[{message:n++<2?{tool_calls:[{id:String(n),function:{name,arguments:JSON.stringify(args)}}]}:{content:'完成'}}]})}};await runAgent({project,job:{id:'x',text:'test',usage:[],routingDecision:imageDecision},env:{ARK_API_KEY:'fake'},budget:new Budget(path.join(d,'b.json'),100),dataDir:d,emit:()=>{},persist:()=>{},fetcher});assert.equal(project.assets.length,1);assert.equal(project.assets[0].versions.length,2);assert.equal(project.assets[0].versions[1].layer.text,'标题')}finally{rmSync(d,{recursive:true})}});
test('停止生图会中断等待，不接收晚到图片，预算预留保留',async()=>{const d=mkdtempSync(path.join(os.tmpdir(),'forma-'));try{const project={uploads:[],assets:[],messages:[{role:'user',text:'test'}]},job={id:'cancel-image',text:'test',usage:[],routingDecision:imageDecision},controller=new AbortController();let started;const imageStarted=new Promise(r=>started=r);const fetcher=async(url,options)=>{if(url.includes('bigmodel'))return {ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'a',function:{name:'create_image',arguments:JSON.stringify({prompt:'test',title:'test',reference_ids:[],text_mode:'none',text_content:[]})}}]}}]})};started();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))};const budget=new Budget(path.join(d,'b.json'),100);const running=runAgent({project,job,env:{ARK_API_KEY:'fake'},budget,dataDir:d,emit:()=>{},persist:()=>{},fetcher,signal:controller.signal});await imageStarted;job.cancelled=true;controller.abort();await assert.rejects(running,/停止/);assert.equal(project.assets.length,0);assert.equal(budget.snapshot().usedFen,17);assert.equal(budget.snapshot().entries.at(-1).status,'uncertain')}finally{rmSync(d,{recursive:true})}});
test('新视觉模型调用参数正确，HTTP 429 不自动切换备用模型',async()=>{const d=mkdtempSync(path.join(os.tmpdir(),'forma-model-'));try{const bodies=[];const fetcher=async(url,options)=>{assert.match(url,/bigmodel/);bodies.push(JSON.parse(options.body));return {ok:false,status:429,json:async()=>({error:{code:'1305',message:'访问量过大'}})}};const budget=new Budget(path.join(d,'b.json'),10),job={id:'model-check',text:'分析图片',selection:[],usage:[]};await assert.rejects(runAgent({project:{brief:'',uploads:[],assets:[],messages:[{role:'user',text:job.text}],jobs:[job]},job,env:{ZHIPU_API_KEY:'test'},budget,dataDir:d,emit:()=>{},persist:()=>{},fetcher}),/限流/);assert.equal(bodies.length,1);assert.equal(bodies[0].model,'glm-5.3-flash');assert.deepEqual(bodies[0].thinking,{type:'enabled',clear_thinking:false});assert.equal(bodies[0].max_tokens,8192);assert.equal(budget.snapshot().usedFen,5)}finally{rmSync(d,{recursive:true})}});

test('四张参考图可用于理解，但 Agent 超量和重复引用在付费前拒绝',async()=>{
 const d=mkdtempSync(path.join(os.tmpdir(),'forma-refs-'));
 try{
  mkdirSync(path.join(d,'media'));writeFileSync(path.join(d,'media','ref.jpg'),Buffer.alloc(120,137));
  const uploads=['a','b','c','d'].map(id=>({id,kind:'image',url:'/media/ref.jpg'}));
  const project={uploads,assets:[],messages:[{role:'user',text:'制作图片'}]};let brain=0,images=0;
  const fetcher=async(url,options)=>{
   const payload=JSON.parse(options.body);
   if(url.includes('bigmodel')){
    if(brain===0)assert.equal(payload.messages.at(-1).content.filter(c=>c.type==='image_url').length,4);
    return {ok:true,json:async()=>({choices:[{message:brain++===0?{tool_calls:[{id:'x',function:{name:'create_image',arguments:JSON.stringify({prompt:'test',title:'test',reference_ids:['a','b','c','d','a'],text_mode:'none',text_content:[]})}}]}:{content:'完成'}}]})};
   }
   images++;assert.equal(payload.image.length,3);return {ok:true,json:async()=>({data:[{b64_json:Buffer.alloc(120,137).toString('base64')}]})};
  };
  await assert.rejects(runAgent({project,job:{id:'refs',text:'制作图片',selection:['a','b','c','d'],usage:[],routingDecision:imageDecision},env:{ARK_API_KEY:'fake'},budget:new Budget(path.join(d,'b.json'),100),dataDir:d,emit:()=>{},persist:()=>{},fetcher}),/无效、重复或超量/);
  assert.equal(images,0);assert.equal(project.assets.length,0);
 }finally{rmSync(d,{recursive:true})}
});
test('模型遗漏生图指令时不由后端代写，也不发送付费生图请求',async()=>{
 const d=mkdtempSync(path.join(os.tmpdir(),'forma-repair-'));
 try{
  mkdirSync(path.join(d,'media'));writeFileSync(path.join(d,'media','product.jpg'),Buffer.alloc(120,137));
  const upload={id:'product',kind:'image',url:'/media/product.jpg'};
  const project={uploads:[upload],assets:[],messages:[{role:'user',text:'为我的产品制作电商主图'}]};
  const job={id:'repair',text:'为我的产品制作电商主图',selection:['product'],usage:[],routingDecision:imageDecision};
  let brain=0,images=0;const events=[];
  const fetcher=async(url,options)=>{
   if(url.includes('bigmodel'))return {ok:true,json:async()=>({choices:[{message:brain++===0?{tool_calls:[{id:'image',function:{name:'create_image',arguments:JSON.stringify({prompt:null,title:null,reference_ids:null,text_mode:'none',text_content:[]})}}]}:{content:'图片已生成'}}]})};
   images++;const payload=JSON.parse(options.body);assert.match(payload.prompt,/为我的产品制作电商主图/);assert.equal(payload.image.length,1);
   return {ok:true,json:async()=>({data:[{b64_json:Buffer.alloc(120,137).toString('base64')}]})};
  };
  await assert.rejects(runAgent({project,job,env:{ARK_API_KEY:'fake'},budget:new Budget(path.join(d,'b.json'),100),dataDir:d,emit:(...e)=>events.push(e),persist:()=>{},fetcher}),/未提供生图指令/);
  assert.equal(images,0);assert.equal(project.assets.length,0);
 }finally{rmSync(d,{recursive:true,force:true})}
});
