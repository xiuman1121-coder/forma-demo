import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Budget} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';

const baseTask=id=>({id,sourceIds:['product'],productIds:['product'],referenceIds:[],constraints:['保持浅蓝色和印花'],revisions:[{id:'v1',version:1,kind:'analysis',status:'draft',content:'初版海边方案'},{id:'v2',version:2,kind:'design',status:'draft',content:'白色建筑，深蓝牛仔裤，清晨自然光'}],confirmedRevisionId:null,status:'draft',delivered:[]});
const reply=content=>({ok:true,json:async()=>({choices:[{message:{content}}]})});

test('无图确认 v2 只改变现有修订状态，返回简短回执，不进入 Agent 或生图',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-confirm-'));
 const task=baseTask('task-a'),project={brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[task],activeCreativeTaskId:task.id};
 const text='我确认采用刚才修改后的最新方案。请将这版方案作为最终确认版本保存下来，这一轮不要生成图片。';
 const job={id:'confirm-job',text,selection:[],usage:[]},traces=[];let calls=0;
 const fetcher=async(url,options)=>{calls++;assert.ok(!options.body.includes('"tools"'));return reply(JSON.stringify({decision:{goal:'确认现有方案',stage:'plan',operation:'confirm',relation:'continue',allowedEffects:['read'],reason:'用户明确批准',approval:{intent:'confirm_existing_revision',revisionId:'v2',quote:'我确认采用刚才修改后的最新方案'}},mode:'conversation'}))};
 try{
  const result=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{},trace:(stage,detail)=>traces.push({stage,...detail})});
  assert.match(result,/v2.*没有生成图片/);assert.equal(calls,1);assert.equal(task.revisions.length,2);
  assert.equal(task.revisions[1].status,'confirmed');assert.equal(task.confirmedRevisionId,'v2');assert.equal(task.status,'confirmed');assert.equal(project.brief,'');
  assert.ok(traces.some(e=>e.stage==='task_revision_confirmed'&&e.revisionId==='v2'));assert.ok(!traces.some(e=>e.stage==='agent_input'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('缺少草案、任务歧义、模糊同意和无效证据均不确认或写摘要',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-confirm-negative-'));
 let calls=0;const fetcher=async(url,options)=>{calls++;const body=JSON.parse(options.body);return body.tools?reply('没有可确认的方案。本轮没有确认或修改任何内容；请指出你想确认的具体方案。'):reply(JSON.stringify({decision:{goal:'',operation:'read',relation:'continue',reason:'未能明确确认',approval:null},mode:'conversation'}))};
 const run=async(project,text)=>runTask({project,job:{id:'job-'+calls,text,selection:[],usage:[]},env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});
 try{
  const ambiguous={brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[baseTask('a'),baseTask('b')]};
  assert.match(await run(ambiguous,'我确认采用最新方案，这轮不要生图。'),/哪个创作任务/);assert.equal(ambiguous.creativeTasks[0].confirmedRevisionId,null);
  const missing={brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[{...baseTask('single'),revisions:[]}]};
  assert.match(await run(missing,'我确认采用最新方案，这轮不要生图。'),/没有可确认/);
  const task=baseTask('single'),project={brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[task]};
  assert.match(await run(project,'好，同意，先不要生图。'),/没有确认/);assert.equal(task.confirmedRevisionId,null);assert.equal(task.revisions.length,2);assert.equal(project.brief,'');
  assert.match(await run(project,'我确认采用最新方案，先不要生图。'),/没有确认/);assert.equal(task.status,'draft');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
