import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Budget,writeJSON} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';

test('Planning 已给出方向选择问题时直接交付，不按问号检查或调用 Agent',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-clarify-'));
 try{
  const job={id:'clarify-job',text:'现在还能再重新改一下图二吗？',selection:[],usage:[]};
  const project={id:'clarify-project',brief:'',messages:[{role:'user',text:job.text,jobId:job.id}],uploads:[],assets:[],jobs:[job],creativeTasks:[]};
  let modelCalls=0;
  const fetcher=async(_url,options)=>{modelCalls++;assert.ok(!JSON.parse(options.body).tools,'澄清不应再次调用 Agent');return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({decision:{goal:'选择图二修正方向',operation:'clarify',relation:'unresolved',blockingQuestion:'可以重做图二。请选择浅色水磨石与柔和窗光，还是暖灰褐局部背景与柔和窗光。'},mode:'conversation'})}}]})}};
  const answer=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>writeJSON(path.join(dir,'project.json'),project)});
  assert.match(answer,/请选择浅色水磨石/);assert.equal(modelCalls,1);assert.equal(job.taskType,'conversation');assert.equal(job.plan.items.length,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
