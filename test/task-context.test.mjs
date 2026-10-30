import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Budget,writeJSON,readJSON} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';
import {buildPlanningInput} from '../backend/task.mjs';
import {resolveCreativeTask,approvalForRevision,applyTaskMaterialRoles} from '../backend/task-context.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const image=readFileSync(path.join(base,'dist/assets/a.png'));
const reply=message=>({ok:true,json:async()=>({choices:[{message}]})});
const explanation='这款浅蓝色上衣适合以米白与浅木色构建松弛的日常场景。优势是颜色柔和、印花简洁、宽松版型易于生活方式表达；局限是信息较少，面料和功能卖点不能仅凭图片断定。建议保留原产品颜色、版型与胸前印花，采用自然窗光和简洁构图，避免直接照搬参考图。';
const proposal='方案采用自然光充足的简约室内场景，以米白墙面和浅木色家具衬托产品。画面使用平视全身与局部细节两种构图，确保浅蓝色、宽松版型和胸前印花清晰可见；不添加未经确认的商品功能卖点。模特动作保持自然，家具只作背景，不遮挡衣服的肩线和印花。';

test('多轮分析、方案修订、确认生成和第二张修改继承同一任务',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-task-context-'));mkdirSync(path.join(dir,'media'));
 const productId='11111111-1111-4111-8111-111111111111',styleId='33333333-3333-4333-8333-333333333333',productUrl='/media/22222222-2222-4222-8222-222222222222.png';writeFileSync(path.join(dir,productUrl.slice(1)),image);
 const project={id:'project-a',brief:'',messages:[],uploads:[{id:productId,kind:'image',role:'reference',label:'浅蓝色上衣',url:productUrl},{id:styleId,kind:'image',role:'style',label:'视觉风格',url:productUrl}],assets:[],jobs:[],creativeTasks:[]};
 const budget=new Budget(path.join(dir,'budget.json'),1000);let current='',planningInputs=[],imageCalls=0;const traces=[];
 const fetcher=async(url,opt)=>{
  if(url.includes('volces')){imageCalls++;return {ok:true,status:200,json:async()=>({data:[{b64_json:image.toString('base64')}]})}}
  const payload=JSON.parse(opt.body);
  if(!payload.tools){planningInputs.push(payload);const id=project.creativeTasks[0]?.id;let decision,mode='conversation',items=[];
   if(current==='plan'||current==='revise'){decision={goal:'制定并修订上衣场景方案',operation:current==='plan'?'draft':'revise',relation:current==='plan'?'new':'revise',taskId:id,sourceJobId:current==='plan'?'job-analysis':null,materialRoles:{productIds:[productId],styleIds:[styleId]},reason:'延续当前产品任务'}}
   if(current==='generate'){decision={goal:'按照已讨论方案制作两张',stage:'execute',operation:'generate',relation:'continue',taskId:id,sourceRevisionId:project.creativeTasks[0].revisions.at(-1).id,confirmPreviousPlan:false,approval:{intent:'confirm_existing_revision',revisionId:project.creativeTasks[0].revisions.at(-1).id,quote:'我确认采用刚才方案'},allowedEffects:['read','paid_image'],reason:'用户确认此前方案'};mode='generate';items=[1,2].map(i=>({purpose:`第 ${i} 张场景图`,visualDirection:`场景 ${i}，保留产品特征`,referenceIds:[productId]}))}
   if(current==='edit'){decision={goal:'修改第二张',stage:'execute',operation:'edit',relation:'revise',taskId:id,allowedEffects:['read','paid_image'],reason:'第二张对应已交付项'};mode='edit';items=[{purpose:'修改第二张场景图',visualDirection:'仅调整背景',referenceIds:[productId],targetAssetId:project.creativeTasks[0].delivered.find(d=>d.order===2).assetId}]}
   return reply({content:JSON.stringify({decision,mode,items})});
  }
  if(current==='analysis')return reply({content:explanation});
  if(current==='plan'||current==='revise')return reply({content:proposal});
  if(payload.messages.some(m=>m.role==='tool'))return reply({content:'图片已保存。'});
  const item=JSON.parse(payload.messages.filter(m=>m.role==='user').at(-1).content[0].text.split('\n用户需求：')[0]).planItem;
  return reply({tool_calls:[{id:'image-'+imageCalls,function:{name:current==='edit'?'edit_image':'create_image',arguments:JSON.stringify(current==='edit'?{asset_id:item.targetAssetId,prompt:'保留上衣并调整第二张背景',reference_ids:[productId],text_mode:'none',text_content:[]}:{title:item.purpose,prompt:'浅蓝色上衣场景图',reference_ids:[productId],text_mode:'none',text_content:[]})}}]});
 };
 const run=async(kind,text,selection=[])=>{current=kind;const job={id:`job-${kind}`,text,selection:[...selection],explicitSelection:[...selection],usage:[]};project.jobs.push(job);project.messages.push({role:'user',text,jobId:job.id,attachments:selection.map(id=>project.uploads.find(u=>u.id===id)).filter(Boolean)});const answer=await runTask({project,job,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget,dataDir:dir,fetcher,emit:()=>{},persist:()=>writeJSON(path.join(dir,'project.json'),project),trace:(stage,detail)=>traces.push({jobId:job.id,stage,...detail})});project.messages.push({role:'assistant',text:answer,jobId:job.id});return job};
 try{
  const first=await run('analysis','先分析这件衣服的视觉特点，不要生图。',[productId,styleId]);assert.equal(project.creativeTasks.length,0);assert.equal(first.creativeTaskId,undefined);
  const drafted=await run('plan','请基于刚才分析制定生活方式场景方案。',[productId,styleId]);assert.equal(planningInputs.at(-1).messages[1].content.filter(c=>c.type==='image_url').length,2);assert.equal(project.creativeTasks[0].revisions.length,1);assert.deepEqual(project.creativeTasks[0].productIds,[productId]);assert.ok(!project.creativeTasks[0].productIds.includes(styleId));assert.ok(project.creativeTasks[0].referenceIds.includes(styleId));
  await run('revise','把方案调整得更松弛，再给我完整方案。');assert.equal(project.creativeTasks[0].revisions.at(-1).version,2);assert.equal(project.creativeTasks[0].confirmedRevisionId,null);
  const generated=await run('generate','我确认采用刚才方案，生成两张图片。');assert.equal(generated.creativeTaskId,drafted.creativeTaskId);assert.equal(imageCalls,2,JSON.stringify({delivery:generated.delivery,items:generated.plan?.items,traces:traces.filter(e=>e.jobId===generated.id).map(e=>e.stage)}));assert.equal(project.assets.length,2);assert.equal(project.creativeTasks[0].delivered.length,2);assert.equal(project.creativeTasks[0].revisions[1].status,'confirmed');assert.equal(project.creativeTasks[0].confirmedRevisionId,project.creativeTasks[0].revisions[1].id);assert.equal(project.creativeTasks[0].revisions[2].status,'draft');assert.equal(project.creativeTasks[0].revisions[2].kind,'execution_plan');
  const secondId=project.creativeTasks[0].delivered.find(d=>d.order===2).assetId;await run('edit','把第二张改一下，背景更浅。');assert.equal(imageCalls,3);assert.equal(project.assets.length,3);assert.equal(project.assets.find(a=>a.id===secondId).versions.length,1);assert.equal(project.assets.at(-1).source.parentAssetId,secondId);
  assert.ok(traces.some(e=>e.stage==='task_context_bound'&&e.taskId===drafted.creativeTaskId));assert.ok(traces.some(e=>e.stage==='task_revision_confirmed'));assert.ok(traces.some(e=>e.stage==='planning_input'&&e.contextSources?.relatedTaskId===drafted.creativeTaskId));
  const restored=readJSON(path.join(dir,'project.json'),{});assert.equal(restored.creativeTasks[0].confirmedRevisionId,project.creativeTasks[0].confirmedRevisionId);assert.equal(restored.creativeTasks[0].delivered.length,3);
  const input=buildPlanningInput({project:restored,job:{text:'继续这个方案',selection:[]},dataDir:dir});assert.equal(input.relatedTaskId,drafted.creativeTaskId);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('任务切换、多个候选澄清和旧项目数据兼容',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-task-switch-'));mkdirSync(path.join(dir,'media'));
 const ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
 const url='/media/22222222-2222-4222-8222-222222222222.png';writeFileSync(path.join(dir,url.slice(1)),image);
 const project={brief:'',messages:[],uploads:ids.map((id,i)=>({id,kind:'image',role:'product',label:i?'红色边柜':'浅蓝色上衣',url})),assets:[],jobs:[]};
 let imageCalls=0,current='',currentSelection=[];const fetcher=async(url,options)=>{if(url.includes('volces')){imageCalls++;throw Error('不应生图')}const payload=JSON.parse(options.body);if(!payload.tools)return reply({content:JSON.stringify(current.includes('刚才那个产品')?{decision:{goal:'定位任务',operation:'clarify',relation:'unresolved',blockingQuestion:'你想继续上衣还是边柜的创作任务？',reason:'多个候选'},mode:'conversation'}:{decision:{goal:'制定产品视觉方案',operation:'draft',relation:'new',materialRoles:{productIds:currentSelection,styleIds:[]},reason:'用户要求正式方案'},mode:'conversation'})});return reply({content:explanation})};
 const run=async(text,selection)=>{current=text;currentSelection=selection;const job={id:`job-${project.jobs.length}`,text,selection,usage:[]};project.jobs.push(job);project.messages.push({role:'user',text,jobId:job.id});const result=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget-'+job.id+'.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>writeJSON(path.join(dir,'project.json'),project)});project.messages.push({role:'assistant',text:result,jobId:job.id});return job};
 try{
  const first=await run('请为这件上衣制定正式视觉方案，不要生图。',[ids[0]]);
  const second=await run('请为这款边柜制定正式视觉方案，不要生图。',[ids[1]]);
  assert.equal(project.creativeTasks.length,2);assert.notEqual(first.creativeTaskId,second.creativeTaskId);
  const vague=await run('先别生图，帮我继续分析刚才那个产品。',[]);
  assert.equal(vague.routingDecision.stage,'clarify');assert.equal(vague.creativeTaskId,undefined);assert.equal(project.creativeTasks.length,2);assert.equal(imageCalls,0);
  const selected=resolveCreativeTask(project,{selection:[ids[0]],relation:'continue'});assert.equal(selected.task.id,first.creativeTaskId);
  const restored=readJSON(path.join(dir,'project.json'),{});const planning=buildPlanningInput({project:restored,job:{text:'沿用已讨论的方案',selection:[ids[1]]},dataDir:dir});assert.equal(planning.relatedTaskId,second.creativeTaskId);assert.deepEqual(planning.selectedIds,[ids[1]]);
  assert.equal(resolveCreativeTask(restored,{selection:[],relation:'continue'}).reason,'multiple_tasks');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('方案确认必须指向现有设计版并引用本轮用户原文，普通生成不确认',()=>{
 const revision={id:'revision-v2',version:2,kind:'design',status:'draft'};
 const task={revisions:[revision]};
 const base={stage:'execute',operation:'generate',relation:'continue',confirmPreviousPlan:true};
 assert.equal(approvalForRevision(base,'直接生成一张新图',task).approved,false);
 assert.equal(approvalForRevision({...base,approval:{intent:'confirm_existing_revision',revisionId:'revision-v2',quote:'我确认采用最新方案'}},'直接生成一张新图',task).approved,false);
 assert.equal(approvalForRevision({...base,approval:{intent:'confirm_existing_revision',revisionId:'other',quote:'我确认采用最新方案'}},'我确认采用最新方案，生成一张',task).approved,false);
 const accepted=approvalForRevision({...base,confirmPreviousPlan:false,approval:{intent:'confirm_existing_revision',revisionId:'revision-v2',quote:'我确认采用最新方案'}},'我确认采用最新方案，生成一张',task);
 assert.equal(accepted.approved,true);assert.equal(accepted.revisionId,'revision-v2');
 task.revisions.push({id:'execution-v3',version:3,kind:'execution_plan',status:'draft'});
 assert.equal(approvalForRevision(base,'我确认采用最新方案，生成一张',task).approved,false);
});

test('产品图与风格参考图在任务内区分，保持参考传图来源',()=>{
 const project={uploads:[{id:'shirt',role:'reference'},{id:'look',role:'style'},{id:'explicit-product',role:'product'},{id:'neutral',role:'reference'}]};
 const task={productIds:[],referenceIds:['shirt','look','neutral'],sourceIds:[]};
 const result=applyTaskMaterialRoles(project,task,['shirt','look','explicit-product','neutral'],{productIds:['shirt','look','not-selected'],styleIds:['look']});
 assert.deepEqual(result.productIds,['explicit-product','shirt']);assert.deepEqual(result.styleIds,['look']);
 assert.deepEqual(task.productIds,['explicit-product','shirt']);assert.ok(task.referenceIds.includes('look'));assert.ok(task.referenceIds.includes('shirt'));assert.ok(!task.productIds.includes('look'));assert.ok(!task.productIds.includes('neutral'));
});

test('修改方案的拆分 JSON 可保存修订且不获得生图权限；非法回复不写入 v2',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-plan-json-'));mkdirSync(path.join(dir,'media'));
 const productId='11111111-1111-4111-8111-111111111111';
 const project={id:'project-a',brief:'',messages:[],uploads:[{id:productId,kind:'image',role:'product',label:'浅蓝色上衣'}],assets:[],jobs:[],creativeTasks:[]};
 const budget=new Budget(path.join(dir,'budget.json'),1000);let current='valid',imageCalls=0;
 const fetcher=async(url,options)=>{
  if(url.includes('volces')){imageCalls++;throw Error('不应生图')}
  const payload=JSON.parse(options.body);
  if(payload.tools)return reply({content:explanation+'\n'+proposal});
  if(current==='invalid')return reply({content:'{"decision":'});
  const decision={goal:'修改海边视觉方案',stage:'plan',operation:project.creativeTasks.length?'revise':'draft',relation:project.creativeTasks.length?'revise':'new',taskId:project.creativeTasks[0]?.id||null,allowedEffects:['read','save_draft'],reason:'仅保存方案'};
  return reply({content:`${JSON.stringify({decision})}, ${JSON.stringify({mode:'conversation'})}`});
 };
 const run=async(text)=>{const job={id:`job-${project.jobs.length}`,text,selection:[],usage:[]};project.jobs.push(job);project.messages.push({role:'user',text,jobId:job.id});const result=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget,dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});project.messages.push({role:'assistant',text:result,jobId:job.id});return job};
 try{
  await run('制定上衣海边视觉方案。');const task=project.creativeTasks[0];assert.equal(task.revisions.length,1);
  current='invalid';await assert.rejects(()=>run('修改方案，保存但暂不执行。'),error=>error.code==='PLANNING_JSON_INVALID');assert.equal(task.revisions.length,1);
  current='valid';const revised=await run('调整成白色建筑与清晨自然光，保存最新方案。');
  assert.equal(revised.routingDecision.stage,'plan');assert.equal(revised.routingDecision.allowedEffects.includes('paid_image'),false);
  assert.equal(task.revisions.length,2);assert.equal(task.revisions[1].status,'draft');assert.equal(imageCalls,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
