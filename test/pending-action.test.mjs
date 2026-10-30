import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Budget,readJSON,writeJSON} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';
import {buildContextSnapshot} from '../backend/context-snapshot.mjs';
import {approvalForTextRevision} from '../backend/task-context.mjs';
import {createPendingAction,validatePendingAction,transitionPendingAction} from '../backend/pending-action.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const image=readFileSync(path.join(base,'dist/assets/a.png'));
const response=message=>({ok:true,status:200,json:async()=>({choices:[{message}]})});
function fixture(){
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-pending-'));mkdirSync(path.join(dir,'media'));
 const url='/media/11111111-1111-4111-8111-111111111111.png';writeFileSync(path.join(dir,url.slice(1)),image);
 const asset={id:'asset-two',title:'图二',x:0,y:200,versions:[{image:url,layer:{text:'',x:5,y:5,size:50,color:'#000000'}}],source:{jobId:'source-job'}};
 const revision={id:'revision-two',version:2,kind:'design',status:'draft',jobId:'proposal-job',content:'方向一：浅色水磨石台面和柔和窗光。方向二：暖灰褐背景。'};
 const task={id:'task-one',status:'draft',revisions:[revision],delivered:[{assetId:asset.id,order:2,jobId:'source-job'}],productIds:[],referenceIds:[],sourceIds:[],constraints:[],pendingActions:[]};
 const project={id:'project-one',brief:'',messages:[{role:'user',text:'图二偏暗',jobId:'proposal-job'},{role:'assistant',text:'我推荐方向一。确认后只重做图二，画幅 1:1。',jobId:'proposal-job'}],uploads:[],assets:[asset],jobs:[{id:'proposal-job',creativeTaskId:task.id,status:'completed',selection:[]}],creativeTasks:[task],activeCreativeTaskId:task.id};
 return {dir,project,task,revision,asset};
}

test('简短同意由 Planning 判断，后端不按字数或关键词拒绝',()=>{
 const {dir,task}=fixture();try{const decision={stage:'plan',operation:'confirm',allowedEffects:['read'],approval:{intent:'confirm_existing_revision',revisionId:'revision-two',quote:'ok'}};assert.equal(approvalForTextRevision(decision,'ok',task).approved,true)}finally{rmSync(dir,{recursive:true,force:true})}
});

test('无提议、多方向和目标被删均不能触发生图',()=>{
 const {dir,project,task,revision,asset}=fixture();try{
  assert.equal(buildContextSnapshot(project,{id:'new-job',text:'ok',selection:[]}).pendingActions.length,0);
  const action=createPendingAction(project,task,{id:'proposal-job'},revision,{action_type:'edit_image',target_asset_id:asset.id,direction_content:'',direction_options:['浅色水磨石','暖灰褐背景'],aspect_ratio:'1:1'});
  assert.equal(validatePendingAction(project,task,action),'direction_unresolved');
  action.direction_content='浅色水磨石';action.direction_options=[];project.assets=[];
  assert.equal(validatePendingAction(project,task,action),'target_asset_missing');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('接受提议后只重做一次，状态及原作品在磁盘上保留',async()=>{
 const {dir,project,task,revision,asset}=fixture();try{
 const action=createPendingAction(project,task,{id:'proposal-job'},revision,{action_type:'edit_image',target_asset_id:asset.id,direction_content:'浅色水磨石台面，柔和窗光，保持瓶身与标签，图一不动',aspect_ratio:'1:1'});
  const squarePath=path.join(dir,'square.png');execFileSync('sips',['-s','format','png','-z','64','64',path.join(dir,asset.versions[0].image.slice(1)),'--out',squarePath],{stdio:'ignore'});const square=readFileSync(squarePath);
  const job={id:'execute-job',requestId:'request-one',text:'ok',selection:[],explicitSelection:[],status:'running',usage:[],events:[]};project.jobs.push(job);project.messages.push({role:'user',text:'ok',jobId:job.id});
  const budget=new Budget(path.join(dir,'budget.json'),1000);let imageCalls=0;
  const fetcher=async(url,options)=>{
   if(url.includes('volces')){imageCalls++;return {ok:true,status:200,json:async()=>({data:[{b64_json:square.toString('base64')}]})}}
   const payload=JSON.parse(options.body);
   if(!payload.tools)return response({content:JSON.stringify({decision:{goal:'按提议重做图二',operation:'edit',relation:'continue',taskId:task.id,sourceJobId:action.source_job_id,sourceRevisionId:revision.id,pendingActionId:action.id,approval:{intent:'accept_pending_action',revisionId:revision.id,quote:'ok'}},mode:'edit',items:[{purpose:'重做图二',targetAssetId:asset.id}]})});
   return response({tool_calls:[{id:'edit-call',function:{name:'edit_image',arguments:JSON.stringify({asset_id:asset.id,prompt:'浅色水磨石台面，柔和窗光，保持瓶身与标签',reference_ids:[],aspect_ratio:'1:1',text_mode:'none',text_content:[]})}}]});
  };
  const persist=()=>writeJSON(path.join(dir,'project.json'),project);
  const answer=await runTask({project,job,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget,dataDir:dir,fetcher,emit:()=>{},persist});
  assert.match(answer,/图片已放到画布/);assert.equal(imageCalls,1);assert.equal(project.assets.length,2);assert.equal(project.assets[0].id,asset.id);
  assert.equal(action.status,'completed');assert.equal(action.execution_job_id,job.id);assert.equal(readJSON(path.join(dir,'project.json'),{}).creativeTasks[0].pendingActions[0].status,'completed');
  assert.equal(transitionPendingAction(action,'executing','another-job'),false);assert.equal(validatePendingAction(project,task,action),'pending_action_not_available');
  const duplicate={id:'duplicate-job',requestId:'request-two',text:'ok',selection:[],explicitSelection:[],status:'running',usage:[],events:[]};project.jobs.push(duplicate);project.messages.push({role:'user',text:'ok',jobId:duplicate.id});
  assert.match(await runTask({project,job:duplicate,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget,dataDir:dir,fetcher,emit:()=>{},persist}),/没有生成图片/);
  assert.equal(imageCalls,1);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Agent 用结构化工具登记提议，修订落盘后绑定真实 ID',async()=>{
 const {dir,project,task,asset}=fixture();try{
  const job={id:'new-proposal-job',requestId:'proposal-request',text:'图二偏暗，给我一个修改方向，确认后重做图二',selection:[],explicitSelection:[],status:'running',usage:[],events:[]};project.jobs.push(job);project.messages.push({role:'user',text:job.text,jobId:job.id});
  let agentCalls=0;
  const fetcher=async(url,options)=>{
   const payload=JSON.parse(options.body);
   if(!payload.tools)return response({content:JSON.stringify({decision:{goal:'修订图二方案',operation:'revise',relation:'revise',taskId:task.id,sourceJobId:'proposal-job',sourceRevisionId:'revision-two'},mode:'conversation'})});
   agentCalls++;
   if(agentCalls===1){assert.ok(payload.tools.some(tool=>tool.function.name==='propose_pending_action'));return response({tool_calls:[{id:'proposal-call',function:{name:'propose_pending_action',arguments:JSON.stringify({action_type:'edit_image',target_asset_id:asset.id,direction_content:'浅色水磨石台面，柔和窗光',aspect_ratio:'1:1'})}}]})}
   return response({content:'图二建议改为浅色水磨石台面，背景使用米白灰泥墙和少量亚麻，光线改回柔和窗光。瓶身、黑色泵头和标签保持原样，主体仍占画面中心，画幅保持 1:1。这样与图一的明度和材质接近，但场景不会照抄原图。你确认后，我只重做图二，图一和旧图二都会保留。'});
  };
  await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>writeJSON(path.join(dir,'project.json'),project)});
  const action=task.pendingActions[0];assert.equal(action.target_asset_id,asset.id);assert.equal(action.aspect_ratio,'1:1');assert.equal(action.status,'pending');assert.equal(action.source_revision_id,task.revisions.at(-1).id);assert.equal(readJSON(path.join(dir,'project.json'),{}).creativeTasks[0].pendingActions[0].status,'pending');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
