import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {Budget} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';
import {runAgent} from '../backend/agent.mjs';
import {requestedImageSize,imageDimensions,matchesRequestedRatio} from '../backend/image-size.mjs';

const source=readFileSync(new URL('../dist/assets/a.png',import.meta.url));
const assetId='11111111-1111-4111-8111-111111111111';
const uploadId='22222222-2222-4222-8222-222222222222';
const sourceUrl='/media/source.png';

test('明确 1:1 请求映射为固定正方形尺寸，并识别非方图',()=>{
 const request=requestedImageSize('帮我改成 1:1 比例，其他东西不要动');
 assert.deepEqual(request,{ratio:'1:1',size:'2048x2048'});
 assert.deepEqual(imageDimensions(source),{width:1536,height:1024});
 assert.equal(matchesRequestedRatio(source,request).ok,false);
});

test('新建方图：无字数组可省略，空参考图不自动补，比例单独传给 Seedream',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-new-ratio-'));
 try{
  mkdirSync(path.join(dir,'media'));
  writeFileSync(path.join(dir,sourceUrl.slice(1)),source);
  const squarePath=path.join(dir,'square.png');
  execFileSync('sips',['-s','format','png','-z','64','64',path.join(dir,sourceUrl.slice(1)),'--out',squarePath],{stdio:'ignore'});
  const square=readFileSync(squarePath);
  const project={uploads:[{id:uploadId,url:sourceUrl,label:'杯子图'}],assets:[],messages:[{role:'user',text:'做一张 1:1 杯子主图'}]};
  const job={id:'new-square',text:'做一张 1:1 杯子主图',selection:[uploadId],usage:[],routingDecision:{stage:'execute',operation:'generate',allowedEffects:['read','paid_image','asset_write']}};
  let imageCalls=0;
  const fetcher=async(url,options)=>{
   const body=JSON.parse(options.body);
   if(url.includes('bigmodel')){
    if(body.messages.some(message=>message.role==='tool'))return {ok:true,status:200,json:async()=>({choices:[{message:{content:'图片已保存。'}}],usage:{}})};
    const schema=body.tools.find(tool=>tool.function.name==='create_image').function.parameters;
    assert.deepEqual(schema.properties.aspect_ratio.enum,['1:1']);
    assert.ok(schema.required.includes('aspect_ratio'));
    assert.ok(!schema.required.includes('text_content'));
    assert.deepEqual(schema.properties.reference_ids.items.enum,[uploadId]);
    return {ok:true,status:200,json:async()=>({choices:[{message:{tool_calls:[{id:'new-image',function:{name:'create_image',arguments:JSON.stringify({prompt:'干净的杯子电商主图，杯子完整入画。',title:'杯子主图',reference_ids:[],aspect_ratio:'1:1',text_mode:'none'})}}]}}],usage:{}})};
   }
   imageCalls++;
   assert.equal(body.size,'2048x2048');
   assert.equal(body.image,undefined);
   return {ok:true,status:200,json:async()=>({data:[{b64_json:square.toString('base64')}]})};
  };
  await runAgent({project,job,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,emit:()=>{},persist:()=>{},fetcher});
  assert.equal(imageCalls,1);
  assert.equal(project.assets.length,1);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Agent 比例与用户要求冲突时不调用付费生图',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-wrong-ratio-'));
 try{
  const project={uploads:[],assets:[],messages:[{role:'user',text:'做一张 1:1 主图'}]};
  const job={id:'wrong-ratio',text:'做一张 1:1 主图',selection:[],usage:[],routingDecision:{stage:'execute',operation:'generate',allowedEffects:['read','paid_image','asset_write']}};
  let imageCalls=0;
  const fetcher=async url=>{
   if(!url.includes('bigmodel')){imageCalls++;throw Error('不应调用生图')}
   return {ok:true,status:200,json:async()=>({choices:[{message:{tool_calls:[{id:'wrong-ratio',function:{name:'create_image',arguments:JSON.stringify({prompt:'一张干净的商品主图',title:'主图',reference_ids:[],aspect_ratio:'3:4',text_mode:'none'})}}]}}],usage:{}})};
  };
  await assert.rejects(runAgent({project,job,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,emit:()=>{},persist:()=>{},fetcher}),/最终比例为 1:1/);
  assert.equal(imageCalls,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('ID 被误填为提示词时先纠正；正确指令用方图尺寸发送并验收',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-ratio-'));
 try{
  mkdirSync(path.join(dir,'media'));
  writeFileSync(path.join(dir,sourceUrl.slice(1)),source);
  const squarePath=path.join(dir,'square.png');
  execFileSync('sips',['-s','format','png','-z','64','64',path.join(dir,sourceUrl.slice(1)),'--out',squarePath],{stdio:'ignore'});
  const square=readFileSync(squarePath);
  const project={id:'project',brief:'',messages:[],uploads:[{id:uploadId,url:sourceUrl,label:'额外参考图'}],assets:[{id:assetId,title:'原图',versions:[{image:sourceUrl,layer:{text:''}}],source:{referenceIds:[]}}],jobs:[],creativeTasks:[]};
  const item={id:'item',order:1,purpose:'改为 1:1 方图',sellingPoint:'',visualDirection:'保留原图',referenceIds:[uploadId],targetAssetId:assetId,status:'pending',assetId:null,error:null};
  const job={id:'job',text:'帮我改成 1:1 比例的，其他东西不要动。',selection:[assetId,uploadId],usage:[],plan:{version:1,mode:'edit',items:[item]}};
  let glmCalls=0,imageCalls=0;
  const toolCall=prompt=>({tool_calls:[{id:'tool-'+glmCalls,function:{name:'edit_image',arguments:JSON.stringify({asset_id:assetId,prompt,reference_ids:[],aspect_ratio:'1:1',text_mode:'none',text_content:[]})}}]});
  const fetcher=async(url,options)=>{
   const body=JSON.parse(options.body);
   if(url.includes('volces')){
    imageCalls++;
    assert.equal(body.size,'2048x2048');
    assert.match(body.prompt,/1:1/);
    assert.match(body.prompt,/保留原图的产品、文字和排版/);
    return {ok:true,status:200,json:async()=>({data:[{b64_json:square.toString('base64')}]})};
  }
  glmCalls++;
  const editSchema=body.tools.find(tool=>tool.function.name==='edit_image')?.function.parameters.properties;
  assert.deepEqual(editSchema.asset_id.enum,[assetId]);
  assert.equal(editSchema.prompt.enum,undefined);
  assert.deepEqual(editSchema.reference_ids.items.enum,[uploadId]);
  assert.equal(editSchema.reference_ids.maxItems,2);
  assert.deepEqual(editSchema.aspect_ratio.enum,['1:1']);
  assert.ok(body.tools.find(tool=>tool.function.name==='edit_image').function.parameters.required.includes('aspect_ratio'));
  const message=glmCalls===1?toolCall(assetId):toolCall('把原图改为 1:1 方图，保留原图的产品、文字和排版，仅重新适配两侧留白。');
   return {ok:true,status:200,json:async()=>({choices:[{message}],usage:{}})};
  };
  const trace=[];
  await runTask({project,job,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,emit:()=>{},persist:()=>{},fetcher,trace:(stage,detail)=>trace.push({stage,...detail})});
  assert.equal(glmCalls,2);
  assert.equal(imageCalls,1);
  assert.equal(job.plan.items[0].status,'completed');
  assert.equal(project.assets.length,2);
  assert.equal(trace.find(entry=>entry.stage==='image_ratio_check')?.ok,true);
  assert.equal(trace.find(entry=>entry.stage==='seedream_request')?.referenceImageCount,1);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
