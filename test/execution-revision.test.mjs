import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Budget} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';
import {resolveExecutionRevision} from '../backend/task-context.mjs';

const image=readFileSync(path.join(import.meta.dirname,'..','dist','assets','a.png'));
const response=message=>({ok:true,status:200,json:async()=>({choices:[{message}],usage:{prompt_tokens:10,completion_tokens:20}})});
const makeTask=()=>({id:'task-1',sourceIds:[],productIds:[],referenceIds:[],constraints:['浅色初稿','深色修改'],revisions:[
 {id:'revision-v1',jobId:'plan-v1',version:1,kind:'design',status:'confirmed',content:'V1_ONLY：首图奶油浅色背景。'},
 {id:'revision-v2',jobId:'plan-v2',version:2,kind:'design',status:'draft',content:'V2_ONLY：首图暖棕黑深色背景，文案久戴不闷。'}
 ],confirmedRevisionId:'revision-v1',status:'draft',delivered:[],lastJobId:'plan-v2'});

test('生成时锁定已确认 v1：Agent 和 Seedream 不接收 v2，执行计划记录来源版本',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-revision-pin-'));
 try{
  const task=makeTask(),project={id:'p',brief:'',messages:[{role:'user',jobId:'plan-v1',text:'制定浅色方案'},{role:'assistant',jobId:'plan-v1',text:'V1_ONLY：首图奶油浅色背景。'},{role:'user',jobId:'plan-v2',text:'修改为深色'},{role:'assistant',jobId:'plan-v2',text:'V2_ONLY：首图暖棕黑深色背景。'}],uploads:[],assets:[],jobs:[],creativeTasks:[task]};
  const job={id:'generate-v1',text:'按之前确认的版本生成一张主图。',selection:[],usage:[]};let imageCalls=0,agentCalls=0;const traces=[];
  const fetcher=async(url,options)=>{
   if(url.includes('volces')){imageCalls++;const body=JSON.parse(options.body);assert.match(body.prompt,/V1_ONLY/);assert.doesNotMatch(body.prompt,/V2_ONLY/);return {ok:true,status:200,json:async()=>({data:[{b64_json:image.toString('base64')}]})}}
   const body=JSON.parse(options.body);
   if(!body.tools)return response({content:JSON.stringify({decision:{operation:'generate',relation:'continue',taskId:task.id,sourceRevisionId:'revision-v1',sourceJobId:'plan-v1'},mode:'generate',items:[{purpose:'浅色首图',visualDirection:'V1_ONLY 奶油浅色背景',newScene:'奶油浅色棚拍背景',newCamera:'平视机位',newComposition:'耳机居中'}]})});
   agentCalls++;const serialized=JSON.stringify(body.messages);assert.match(serialized,/V1_ONLY/);assert.doesNotMatch(serialized,/V2_ONLY/);
   return response(body.messages.some(message=>message.role==='tool')?{content:'图片已保存。'}:{tool_calls:[{id:'create-1',function:{name:'create_image',arguments:JSON.stringify({prompt:'V1_ONLY 奶油浅色背景，耳机居中。',title:'浅色首图',reference_ids:[],text_mode:'none',text_content:[]})}}]});
  };
  await runTask({project,job,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{},trace:(stage,payload)=>traces.push({stage,...payload})});
  assert.equal(imageCalls,1);assert.ok(agentCalls>=1);assert.equal(job.executionRevisionId,'revision-v1');assert.equal(job.plan.sourceRevisionId,'revision-v1');assert.equal(task.revisions[2].plan.sourceRevisionId,'revision-v1');assert.equal(task.confirmedRevisionId,'revision-v1');assert.equal(task.revisions[1].status,'draft');assert.ok(traces.some(event=>event.stage==='execution_revision_bound'&&event.revisionId==='revision-v1'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('多版方案没有明确来源时，在生图前澄清且不创建执行计划',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-revision-ambiguous-'));
 try{
  const task=makeTask(),project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[task]};
  const job={id:'ambiguous',text:'按方案生成一张图。',selection:[],usage:[]};let calls=0;
  const fetcher=async(url)=>{calls++;assert.ok(!url.includes('volces'));return response({content:JSON.stringify({decision:{operation:'generate',relation:'continue',taskId:task.id},mode:'generate',items:[{purpose:'主图',visualDirection:'产品图'}]})})};
  const result=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});
  assert.match(result,/多个方案版本/);assert.equal(calls,1);assert.equal(task.revisions.length,2);assert.equal(task.lastJobId,'plan-v2');assert.equal(project.assets.length,0);
  assert.equal(resolveExecutionRevision(task,{sourceRevisionId:'revision-v1',sourceJobId:'plan-v2'}).reason,'source_reference_conflict');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('明确选择 v2 可用于执行但不自动确认 v2',()=>{
 const task=makeTask();const selection=resolveExecutionRevision(task,{sourceRevisionId:'revision-v2',sourceJobId:'plan-v2'});
 assert.equal(selection.revision.id,'revision-v2');assert.equal(selection.revision.status,'draft');assert.equal(task.confirmedRevisionId,'revision-v1');
});

test('模型把“方案一”误选为新版内部 A 时，后端先澄清且不确认、不生图',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-reference-guard-'));
 try{
  const task=makeTask();task.revisions[0].content='室内挂拍、低饱和留白主图';task.revisions[1].content='海边沙滩坐姿方案\n**A. 沙滩正面坐姿**\n**B. 背面看海**';
  task.revisions[1].request='改成海边沙滩，模特坐姿';
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[task]};
  const job={id:'ambiguous-one',text:'按前面的方案一制作吧',selection:[],usage:[]};let imageCalls=0;
  const fetcher=async(url)=>{if(url.includes('volces')){imageCalls++;throw Error('不应生图')}return response({content:JSON.stringify({decision:{operation:'generate',relation:'continue',taskId:task.id,sourceRevisionId:'revision-v2',sourceJobId:'plan-v2',approval:{intent:'confirm_existing_revision',revisionId:'revision-v2',quote:job.text}},mode:'generate',items:[{purpose:'海边图',visualDirection:'沙滩正面坐姿'}]})})};
  const answer=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});
  assert.match(answer,/室内挂拍/);assert.match(answer,/沙滩正面坐姿/);
  assert.equal(imageCalls,0);assert.equal(task.confirmedRevisionId,'revision-v1');assert.equal(task.revisions.length,2);assert.equal(project.assets.length,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('明确方向 D 的来源虽超出近期对话，仍可按保存的修订生成',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-old-direction-'));
 try{
  const task=makeTask();task.revisions[1].content='## 方向 A｜原料静物\n## 方向 B｜暗调玻璃\n## 方向 C｜手部入镜\n## 方向 D｜正俯拍平铺：洗护仪式桌面';
  const messages=[{role:'user',jobId:'plan-v2',text:'有没有别的方案？'},{role:'assistant',jobId:'plan-v2',text:task.revisions[1].content}];
  for(let i=0;i<8;i++)messages.push({role:'user',jobId:`later-${i}`,text:'继续讨论'}, {role:'assistant',jobId:`later-${i}`,text:'已回复'});
  const project={id:'p',brief:'',messages,uploads:[],assets:[],jobs:[],creativeTasks:[task]};
  const job={id:'direction-d',text:'帮我做前面方向 D 的图。',selection:[],usage:[]};let imageCalls=0;
  const fetcher=async(url,options)=>{
   if(url.includes('volces')){imageCalls++;return {ok:true,status:200,json:async()=>({data:[{b64_json:image.toString('base64')}]})}}
   const body=JSON.parse(options.body);
   if(!body.tools)return response({content:JSON.stringify({decision:{operation:'generate',relation:'continue',taskId:task.id,sourceJobId:'plan-v2',sourceRevisionId:'revision-v2',approval:null},mode:'generate',items:[{purpose:'正俯拍洗护桌面',visualDirection:'瓶身和天竺葵叶平铺',newScene:'亚麻桌面',newCamera:'正俯拍',newComposition:'瓶身旁有天竺葵叶',referenceIds:[]}]})});
   return response(body.messages.some(message=>message.role==='tool')?{content:'图片已保存。'}:{tool_calls:[{id:'create-d',function:{name:'create_image',arguments:JSON.stringify({prompt:'正俯拍洗护桌面',title:'方向 D',reference_ids:[],text_mode:'none',text_content:[]})}}]});
  };
  const answer=await runTask({project,job,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});
  assert.match(answer,/图片已放到画布/);assert.equal(imageCalls,1);assert.equal(project.assets.length,1);assert.equal(job.executionRevisionId,'revision-v2');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
