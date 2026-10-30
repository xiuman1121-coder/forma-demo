import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Budget} from '../backend/core.mjs';
import {runAgent} from '../backend/agent.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cropDecision={stage:'execute',operation:'crop_grid',allowedEffects:['read','local_image','save_draft']};

for(const kind of ['upload','asset'])test(`裁切单张选中${kind==='upload'?'上传图':'画布作品'}：工具只允许真实 ID，空参数由后端绑定`,async t=>{
 if(process.platform!=='darwin')return t.skip('裁切依赖 macOS CoreGraphics');
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-crop-tool-'));
 try{
  mkdirSync(path.join(dir,'media'));const filename=randomUUID()+'.png';copyFileSync(path.join(base,'dist/assets/a.png'),path.join(dir,'media',filename));
  const id='selected-image',url='/media/'+filename;
  const upload={id,kind:'image',label:'原图',url};
  const asset={id,title:'画布原图',versions:[{image:url,layer:{text:''}}]};
  const project={uploads:kind==='upload'?[upload]:[],assets:kind==='asset'?[asset]:[],messages:[],jobs:[]};
  const job={id:'crop',text:'把所选图片切成九宫格',selection:[id],usage:[],routingDecision:cropDecision,plan:{items:[]}};
  let calls=0;
  const fetcher=async(url,options)=>{
   assert.match(url,/bigmodel/);calls++;
   const body=JSON.parse(options.body),tool=body.tools.find(t=>t.function.name==='crop_image');
   assert.deepEqual(tool.function.parameters.properties.asset_id.enum,[id]);
   assert.equal(body.tools.some(t=>t.function.name==='create_image'||t.function.name==='edit_image'),false);
   return {ok:true,json:async()=>({choices:[{message:calls===1?{tool_calls:[{id:'crop-call',function:{name:'crop_image',arguments:JSON.stringify({asset_id:'',rows:3,cols:3})}}]}:{content:'已完成本地裁切。'}}],usage:{prompt_tokens:1,completion_tokens:1}})};
  };
  await runAgent({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),100),dataDir:dir,emit:()=>{},persist:()=>{},fetcher});
  assert.equal(calls,2);assert.equal(project.assets.length,kind==='asset'?10:9);
  assert.equal(job.plan.items.length,9);assert.ok(job.plan.items.every(item=>item.referenceIds[0]===id));
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('多张选中图片不得猜测裁切对象，也不得调用生图模型',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-crop-multi-'));
 try{
  mkdirSync(path.join(dir,'media'));copyFileSync(path.join(base,'dist/assets/a.png'),path.join(dir,'media','source.png'));
  const project={uploads:['first','second'].map(id=>({id,kind:'image',url:'/media/source.png'})),assets:[],messages:[],jobs:[]};
  const job={id:'crop-multi',text:'切九宫格',selection:['first','second'],usage:[],routingDecision:cropDecision,plan:{items:[]}};
  let calls=0;const errors=[];
  const fetcher=async(url,options)=>{
   assert.match(url,/bigmodel/);calls++;
   const body=JSON.parse(options.body),crop=body.tools.find(t=>t.function.name==='crop_image');
   assert.deepEqual(crop.function.parameters.properties.asset_id.enum,['first','second']);
   return {ok:true,json:async()=>({choices:[{message:calls===1?{tool_calls:[{id:'crop-call',function:{name:'crop_image',arguments:JSON.stringify({asset_id:'first',rows:3,cols:3})}}]}:{content:'请只选择要裁切的那一张图片。'}}],usage:{prompt_tokens:1,completion_tokens:1}})};
  };
  await runAgent({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),100),dataDir:dir,emit:()=>{},persist:()=>{},fetcher,trace:(stage,event)=>{if(stage==='agent_tool_result')errors.push(event)}});
  assert.equal(project.assets.length,0);assert.equal(job.plan.items.length,0);assert.equal(calls,2);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
