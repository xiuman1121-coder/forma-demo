import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Budget} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';

const response=message=>({ok:true,json:async()=>({choices:[{message}]})});

test('Planning 判为只读时，Agent 无法调用付费生图工具',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-read-gate-'));
 const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[]};
 const job={id:'j',text:'先分析这张产品图，不要生图',selection:[],usage:[],events:[]};
 let planningCalls=0,agentCalls=0,imageCalls=0;
 const fetcher=async(url,options)=>{
  if(url.includes('volces')){imageCalls++;throw Error('只读任务不应调用生图')}
  const body=JSON.parse(options.body);
  if(!body.tools){planningCalls++;return response({content:JSON.stringify({decision:{goal:'分析产品图',operation:'read',relation:'new',responseType:'analysis',reason:'本轮只分析'},mode:'conversation'})})}
  agentCalls++;assert.ok(body.tools.every(tool=>!['create_image','edit_image'].includes(tool.function.name)));
  return response({content:'这张产品图应该先核对商品的颜色、结构与可见标签，再区分照片能直接证明的外观特征和需要商家提供规格才能确认的功能卖点。当前资料不足以确认容量、材料认证或防漏性能，建议补充这些真实参数后再组织主图文案；本轮只交付分析，不生成图片。'});
 };
 try{
  const answer=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});
  assert.match(answer,/不生成图片/);assert.equal(job.taskType,'conversation');assert.equal(planningCalls,1);assert.equal(agentCalls,1);assert.equal(imageCalls,0);assert.equal(project.assets.length,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
