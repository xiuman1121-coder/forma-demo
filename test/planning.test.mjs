import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture=readFileSync(path.join(base,'dist/assets/a.png')).toString('base64');
const otherFixture=readFileSync(path.join(base,'dist/assets/b.png')).toString('base64');
const reply=message=>({ok:true,json:async()=>({choices:[{message}],usage:{total_tokens:10}})});
let nextPort=4400;

async function scenario({count,requestedCount=count,failAt,transportFailAt,continueRemaining=false,reserveFen,foreignRef=false,preSpendFen=0,imageDelays=[],text}){
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-plan-'));
 if(preSpendFen)writeFileSync(path.join(dir,'budget.json'),JSON.stringify([{id:'old',jobId:'old',fen:preSpendFen,status:'estimated'}]));
 let imageCalls=0,imageInFlight=0,maxImageInFlight=0,foreignId=null;const requests=[];
 const fetcher=async(url,opt)=>{
  const body=JSON.parse(opt.body);requests.push({url,body});
  if(url.includes('bigmodel')){
   if(!body.tools)return reply({content:JSON.stringify({mode:'images',items:Array.from({length:count},(_,index)=>({purpose:`第 ${index+1} 张 · ${['主图','卖点','功能','场景'][index%4]}`,sellingPoint:`卖点 ${index+1}`,visualDirection:'干净的电商摄影',referenceIds:foreignId?[foreignId]:[]}))})});
   const toolMessages=body.messages.filter(m=>m.role==='tool');
   if(toolMessages.length)return reply({content:'这一张已完成。'});
   const context=JSON.parse(body.messages.findLast(m=>m.role==='user').content[0].text.split('\n用户需求：')[0]);
   return reply({tool_calls:[{id:'image',function:{name:'create_image',arguments:JSON.stringify({title:context.planItem.purpose,prompt:`设计 ${context.planItem.purpose}`,reference_ids:context.selection,text_mode:'none',text_content:[]})}}]});
  }
  imageCalls++;const callNumber=imageCalls;imageInFlight++;maxImageInFlight=Math.max(maxImageInFlight,imageInFlight);
  if(imageDelays[callNumber-1])await new Promise(resolve=>setTimeout(resolve,imageDelays[callNumber-1]));
  imageInFlight--;
  if(callNumber===transportFailAt)throw new TypeError('fetch failed',{cause:Object.assign(new Error('other side closed'),{code:'UND_ERR_SOCKET'})});
  if(callNumber===failAt)return {ok:false,status:500,json:async()=>({error:{message:'mock image failure'}})};
  return {ok:true,json:async()=>({data:[{b64_json:fixture}]})};
 };
 const port=nextPort++;
 const server=createApp({base,dataDir:dir,port,env:{ZHIPU_API_KEY:'mock-secret',ARK_API_KEY:'mock-secret',ARK_IMAGE_RESERVE_FEN:reserveFen,FORMA_DEBUG_TRACE:transportFailAt?'1':'0'},fetcher});
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const api=async(route,payload)=>{const response=await fetch(origin+'/api/'+route,payload?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{});return {status:response.status,data:await response.json()}};
 try{
  const upload=(await api('upload',{label:'产品.png',data:'data:image/png;base64,'+fixture})).data;
  const id=upload.uploadedId;
  const roleResult=await api('role',{id,role:'product'});assert.equal(roleResult.status,200,JSON.stringify(roleResult.data));assert.equal(roleResult.data.project.uploads[0].role,'product');
  if(foreignRef)foreignId=(await api('upload',{label:'不应使用的其他素材.png',data:'data:image/png;base64,'+otherFixture})).data.uploadedId;
  await api('run',{text:text||`请制作 ${requestedCount} 张电商图片`,selection:[id],requestId:'suite'});
  let state;
  for(let i=0;i<100;i++){state=(await api('state')).data;if(state.project.jobs.at(-1)?.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10))}
  if(continueRemaining){const firstJob=state.project.jobs.at(-1);await api('continue-plan',{jobId:firstJob.id,requestId:'resume'});for(let i=0;i<100;i++){state=(await api('state')).data;if(state.project.jobs.at(-1)?.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10))}}
  const trace=transportFailAt?JSON.parse(readFileSync(path.join(dir,'debug-traces',state.project.jobs.at(-1).id+'.json'))):null;
  return {state,imageCalls,maxImageInFlight,requests,id,trace};
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})}
}

test('规划器多规划一张时在任何付费生图前失败，避免用户要求两张却制作三张',async()=>{
 const {state,imageCalls}=await scenario({count:3,requestedCount:2});
 assert.equal(state.project.jobs.at(-1).status,'failed');
 assert.match(state.project.jobs.at(-1).error,/数量与用户要求不符/);
 assert.equal(imageCalls,0);
});

test('多图交付完整规划五张，单轮只执行四张，剩余计划保留且视觉质量未验收',async()=>{
 const {state,imageCalls,requests,id}=await scenario({count:5});const job=state.project.jobs.at(-1);
 assert.equal(job.status,'partial');assert.equal(job.plan.version,1);assert.equal(job.plan.items.length,5);
 assert.deepEqual(job.plan.items.map(i=>i.status),['completed','completed','completed','completed','pending']);
 assert.equal(job.delivery.delivered,4);assert.equal(job.delivery.quality,'not_evaluated');assert.equal(imageCalls,4);
 assert.equal(state.project.assets.length,4);assert.ok(state.project.assets.every(a=>a.source.jobId===job.id&&a.source.referenceIds.includes(id)));
 assert.ok(state.project.assets.every(a=>a.versions[0].image.startsWith('/media/')));
 assert.equal(state.budget.usedFen,73);assert.ok(!JSON.stringify(job.events).includes('mock-secret'));
 assert.ok(!JSON.stringify(job.events).includes('base64'));
 assert.equal(requests.filter(r=>r.url.includes('volces')).length,4);
});

test('并发中的第二张失败后保留已在途的作品，不启动第四张或自动重试',async()=>{
 const {state,imageCalls,maxImageInFlight}=await scenario({count:4,failAt:2,imageDelays:[5,25,40]});const job=state.project.jobs.at(-1);
 assert.equal(job.status,'partial');assert.deepEqual(job.plan.items.map(i=>i.status),['completed','failed','completed','pending']);
 assert.equal(job.delivery.delivered,2);assert.equal(state.project.assets.length,2);assert.equal(imageCalls,3);assert.equal(maxImageInFlight,2);
 assert.match(job.plan.items[1].error,/HTTP 500/);
});

test('两张并发生成，后完成的首图仍按计划顺序放到画布',async()=>{
 const {state,imageCalls,maxImageInFlight}=await scenario({count:4,imageDelays:[35,5,10,5]});const job=state.project.jobs.at(-1);
 assert.equal(job.status,'completed');assert.equal(imageCalls,4);assert.equal(maxImageInFlight,2);
 assert.deepEqual(state.project.assets.map(asset=>asset.source.planOrder),[1,2,3,4]);
 assert.deepEqual(state.project.assets.map(asset=>asset.x),[80,510,940,1370]);
});

test('要求下一张参考上一张结果时仍逐张执行',async()=>{
 const {state,maxImageInFlight}=await scenario({count:3,text:'请制作 3 张电商图片，后一张要参考上一张的生成结果',imageDelays:[20,20,20]});
 assert.equal(state.project.jobs.at(-1).status,'completed');
 assert.equal(maxImageInFlight,1);
});

test('生图连接断开时记录底层错误码，已在途的另一张仍可保存',async()=>{
 const {state,trace}=await scenario({count:2,transportFailAt:1,imageDelays:[5,20]});
 assert.equal(state.project.jobs.at(-1).status,'partial');
 assert.equal(state.project.assets.length,1);
 const failure=trace.events.find(event=>event.stage==='seedream_transport_failure');
 assert.equal(failure.details[0].message,'fetch failed');
 assert.equal(failure.details[1].code,'UND_ERR_SOCKET');
 assert.ok(failure.elapsedMs>=0);
});

test('用户主动继续剩余图片时，计划升版，已完成作品保留',async()=>{
 const {state,imageCalls}=await scenario({count:5,continueRemaining:true});const [first,second]=state.project.jobs;
 assert.equal(first.status,'partial');assert.equal(second.status,'completed');assert.equal(second.plan.version,2);assert.equal(second.plan.revisionOf,first.id);
 assert.equal(second.plan.items.filter(i=>i.status==='completed').length,5);assert.equal(second.plan.items[0].assetId,first.plan.items[0].assetId);
 assert.equal(state.project.assets.length,5);assert.equal(imageCalls,5);
});

test('提高供应商单张预留价后，模型调用与生图共同计费，达到 ¥0.80 任务上限后停止',async()=>{
 const {state,imageCalls}=await scenario({count:4,reserveFen:25});const job=state.project.jobs.at(-1);
 assert.equal(job.status,'partial');assert.equal(job.delivery.delivered,2);assert.equal(imageCalls,2);
 assert.ok(state.budget.usedFen<=80);assert.deepEqual(job.plan.items.map(i=>i.status),['completed','completed','pending','pending']);
});

test('规划器返回本轮未选的项目图片 ID 时，执行层剔除该素材',async()=>{
 const {state,requests,id}=await scenario({count:1,foreignRef:true});const item=state.project.jobs.at(-1).plan.items[0];
 assert.deepEqual(item.referenceIds,[id]);assert.equal(requests.find(r=>r.url.includes('volces')).body.image.length,1);
});

test('总预算不足且尚未调用生图时，计划保持待执行而非失败',async()=>{
	 const {state,imageCalls}=await scenario({count:2,preSpendFen:7995});const job=state.project.jobs.at(-1);
 assert.equal(job.status,'pending');assert.equal(job.delivery.delivered,0);assert.equal(imageCalls,0);
 assert.deepEqual(job.plan.items.map(i=>i.status),['pending','pending']);
});

test('服务重启后保留已结束的待执行计划，并将中断中的计划项恢复为待执行',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-restart-'));
 const item=id=>({id,purpose:id,status:'pending',assetId:null});
 const completedPending={id:'deferred',status:'pending',finishedAt:'2026-10-09T00:00:00Z',plan:{version:1,items:[item('a')]}};
 const interrupted={id:'interrupted',status:'running',plan:{version:1,items:[{...item('b'),status:'running'}]}};
 writeFileSync(path.join(dir,'project.json'),JSON.stringify({id:'project',brief:'',messages:[],uploads:[],assets:[],jobs:[completedPending,interrupted]}));
 const server=createApp({base,dataDir:dir,port:4197,env:{}});await new Promise(resolve=>server.listen(4197,'127.0.0.1',resolve));
 try{const state=await (await fetch('http://127.0.0.1:4197/api/state')).json();assert.equal(state.project.jobs[0].status,'pending');assert.equal(state.project.jobs[1].status,'failed');assert.equal(state.project.jobs[1].plan.items[0].status,'pending')}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})}
});
