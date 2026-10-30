import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Budget} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';

test('Planning 超时只重试一次；成功后直接交付澄清，不调用生图',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-planning-timeout-'));try{
  const job={id:'timeout-one',text:'把图一的雾气去掉',selection:[],usage:[]};
  const project={id:'timeout-project',brief:'',messages:[],uploads:[],assets:[],jobs:[job],creativeTasks:[]};let calls=0;const events=[];
  const fetcher=async url=>{assert.ok(!url.includes('volces'));calls++;if(calls===1)throw new DOMException('timeout','TimeoutError');return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({decision:{operation:'clarify',relation:'unresolved',blockingQuestion:'请选中要去掉雾气的图一作品'},mode:'conversation'})}}]})}};
  const answer=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:(type,message)=>events.push({type,message}),persist:()=>{}});
  assert.equal(calls,2);assert.match(answer,/请选中/);assert.ok(events.some(event=>event.message.includes('重试一次')));
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Planning 两次超时后停止，不进入 Agent 或生图',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-planning-timeout-'));try{
  const job={id:'timeout-two',text:'把图一的雾气去掉',selection:[],usage:[]};
  const project={id:'timeout-project',brief:'',messages:[],uploads:[],assets:[],jobs:[job],creativeTasks:[]};let calls=0;
  const fetcher=async()=>{calls++;throw new DOMException('timeout','TimeoutError')};
  await assert.rejects(runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}}),/规划服务连续超时/);
  assert.equal(calls,2);assert.equal(project.assets.length,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
