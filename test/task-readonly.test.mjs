import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Budget} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';
import {taskSnapshot} from '../backend/task-context.mjs';

const task=()=>({id:'task-1',status:'confirmed',sourceIds:[],productIds:[],referenceIds:[],constraints:['保留 T 恤外观'],revisions:[{id:'v1',version:1,kind:'analysis',status:'draft',content:'海边方案'},{id:'v2',version:2,kind:'design',status:'confirmed',content:'海边白色建筑、深蓝牛仔裤、清晨柔和自然光'}],confirmedRevisionId:'v2',delivered:[],lastJobId:'older-job'});
const reply=content=>({ok:true,json:async()=>({choices:[{message:{content}}]})});

test('只读回执不覆盖已确认的设计修订',()=>{
 const existing=task();existing.revisions.push({id:'v3',version:3,kind:'readback',status:'informational',content:'对 v2 的核对回执'});
 assert.equal(taskSnapshot(existing).latestRevision.id,'v2');assert.equal(existing.revisions.length,3);
});

test('Planning 只读判断后，Agent 回答但不修改任务或项目摘要',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-readonly-'));
 const existing=task(),project={id:'p',brief:'原摘要',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[existing],activeCreativeTaskId:existing.id};
 const before=structuredClone(existing),job={id:'read-job',text:'请分析已确认方案的场景、穿搭和光线是否适合这款产品；不修改方案，也不要生成图片。',selection:[],usage:[],events:[]};
 let planningCalls=0,agentCalls=0,imageCalls=0;
 const fetcher=async(url,options)=>{
  if(url.includes('volces')){imageCalls++;throw Error('不应调用生图')}
  const body=JSON.parse(options.body);
  if(!body.tools){planningCalls++;return reply(JSON.stringify({decision:{goal:'核对已有方案',operation:'read',relation:'continue',taskId:existing.id,responseType:'analysis',reason:'只读分析'},mode:'conversation'}))}
  agentCalls++;assert.ok(body.tools.every(t=>!['create_image','edit_image','save_brief'].includes(t.function.name)));
  return reply('已确认方案是海边白色建筑、深蓝牛仔裤和清晨柔和自然光。场景与浅蓝色 T 恤的清爽感一致，但仍需检查印花是否足够清楚、主体与背景是否有足够对比。照片只能支持这些视觉判断，不能据此推断面料功能或其他未经确认的卖点。本轮只是核对，没有修改设计方案，也没有生成图片。');
 };
 try{
  const answer=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});
  assert.match(answer,/海边白色建筑/);assert.equal(planningCalls,1);assert.equal(agentCalls,1);assert.equal(imageCalls,0);
  assert.deepEqual(existing,before);assert.equal(project.brief,'原摘要');assert.equal(project.assets.length,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
