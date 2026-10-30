import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Budget} from '../backend/core.mjs';
import {buildContextSnapshot,resolveSnapshotReference} from '../backend/context-snapshot.mjs';

test('历史方案超出近期对话窗口后仍可由任务与修订 ID 定位',()=>{
 const task={id:'task',revisions:[{id:'design-d',jobId:'old-plan',kind:'design',version:2,status:'draft',content:'方向 D：正俯拍洗护桌面'}]};
 const messages=[{jobId:'old-plan',role:'user',text:'有没有别的方案？'},{jobId:'old-plan',role:'assistant',text:'方向 D：正俯拍洗护桌面'}];
 for(let index=0;index<8;index++)messages.push({jobId:`later-${index}`,role:'user',text:'后来的一轮'}, {jobId:`later-${index}`,role:'assistant',text:'已处理'});
 const snapshot=buildContextSnapshot({id:'p',messages,uploads:[],assets:[],creativeTasks:[task]}, {id:'current',text:'做方向 D',selection:[]});
 assert.ok(!snapshot.recentTurns.some(turn=>turn.sourceJobId==='old-plan'));
 assert.equal(resolveSnapshotReference(snapshot,{taskId:'task',sourceRevisionId:'design-d',sourceJobId:'old-plan'}).ok,true);
 assert.equal(resolveSnapshotReference(snapshot,{taskId:'task',sourceRevisionId:'wrong',sourceJobId:'old-plan'}).ok,false);
});
import {decisionFromPlanning,authorizeTaskDecision,permitsPaidImage,parsePlanningJSON} from '../backend/routing.mjs';
import {runTask} from '../backend/task.mjs';
import {resolveCreativeTask} from '../backend/task-context.mjs';

const answer='这款耳机适合采用自然光与简洁背景。主体应位于画面中心偏下，保留真实外观和比例。若借用上一轮的斜向构图，只迁移画面节奏和光线关系，不把旧香水、旧品牌或道具当作本轮产品。可将耳机以四分之三侧面朝向镜头，在画面左下形成视觉锚点，右上保留环境留白；光线从右上方进入，展示耳罩和头梁的层次。拍摄前仍需核实产品材质和颜色，不能凭参考照片编造卖点。';
const response=content=>({ok:true,status:200,json:async()=>({choices:[{message:{content}}],usage:{prompt_tokens:10,completion_tokens:20}})});

test('同一 Context 快照同时进入 Planning 与 Agent，上一轮分析通过 sourceJobId 关联新产品',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-context-contract-'));
 try{
  mkdirSync(path.join(dir,'media'));const image='/media/11111111-1111-4111-8111-111111111111.png';writeFileSync(path.join(dir,image.slice(1)),readFileSync(path.join(import.meta.dirname,'..','dist','assets','a.png')));
  const project={id:'project-1',brief:'',messages:[{role:'user',text:'分析这张香水图的斜向构图',jobId:'earlier',attachments:[{id:'bottle'}]},{role:'assistant',text:'香水瓶位于左下，窗光从右上进入，构图形成斜向节奏。',jobId:'earlier'}],uploads:[{id:'bottle',role:'product',label:'香水图',url:image},{id:'headphone',role:'product',label:'耳机图',url:image}],assets:[],jobs:[],creativeTasks:[]};
  const job={id:'current',text:'沿用上一轮构图，把产品换成这副耳机，先分析方案。',selection:['headphone'],usage:[]};
  project.jobs.push(job);project.messages.push({role:'user',text:job.text,jobId:job.id,attachments:[{id:'headphone'}]});
  const calls=[],traces=[];
  const fetcher=async(url,options)=>{
   assert.ok(!url.includes('volces'));
   const payload=JSON.parse(options.body);calls.push(payload);
   if(!payload.tools)return response(JSON.stringify({decision:{goal:'耳机视觉分析',operation:'read',responseType:'analysis',relation:'continue',sourceJobId:'earlier',reason:'引用上一轮构图'},mode:'conversation'}));
   return response(answer);
  };
  const text=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{},trace:(stage,payload)=>traces.push({stage,...payload})});
  assert.match(text,/斜向构图/);assert.equal(calls.length,2);assert.equal(project.creativeTasks.length,0);
  assert.equal(calls[0].reasoning_effort,'low');assert.equal(calls[1].reasoning_effort,undefined);
  assert.equal(traces.find(event=>event.stage==='planning_input').parameters.reasoning_effort,'low');
  const planning=JSON.stringify(calls[0].messages),agent=JSON.stringify(calls[1].messages);
  assert.match(planning,/earlier/);assert.match(agent,/earlier/);assert.match(planning,/香水瓶位于左下/);assert.match(agent,/香水瓶位于左下/);
  assert.equal(calls[0].messages[1].content.filter(c=>c.type==='image_url').length,2);assert.equal(calls[1].messages.at(-1).content.filter(c=>c.type==='image_url').length,2);
  assert.match(agent,/历史视觉参考/);assert.ok(!job.selection.includes('bottle'));
  assert.equal(job.routingDecision.operation,'read');assert.equal(job.routingDecision.allowedEffects.includes('paid_image'),false);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Context 严格隔离项目，产品素材与历史风格素材保留真实角色',()=>{
 const project={id:'p1',messages:[{role:'user',text:'参考旧图的柔和光线',jobId:'old',attachments:[{id:'style'}]},{role:'assistant',text:'仅迁移光线，不迁移产品。',jobId:'old'}],uploads:[{id:'style',role:'style',label:'风格图'},{id:'new',role:'product',label:'本轮产品'}],assets:[],creativeTasks:[]};
 const snapshot=buildContextSnapshot(project,{id:'next',text:'给这个新品设计方案',selection:['new']});
 assert.deepEqual(snapshot.current.selectedIds,['new']);assert.equal(snapshot.current.selectedMaterials[0].role,'product');assert.deepEqual(snapshot.recentTurns[0].materialIds,['style']);
 assert.equal(buildContextSnapshot({...project,id:'p2',messages:[]},{id:'next',text:'查询',selection:[]}).recentTurns.length,0);
});

test('模型提供矛盾权限字段也不能自行授权；代码只根据操作推导',()=>{
 const read=decisionFromPlanning({content:JSON.stringify({decision:{operation:'read',responseType:'analysis',relation:'new',stage:'execute',allowedEffects:['paid_image']},mode:'conversation'})}).decision;
 assert.equal(read.stage,'plan');assert.deepEqual(read.allowedEffects,['read']);assert.equal(permitsPaidImage(read),false);
 const generation=decisionFromPlanning({content:JSON.stringify({decision:{operation:'generate',relation:'new',stage:'plan',allowedEffects:['read']},mode:'generate',items:[{purpose:'主图'}]})}).decision;
 assert.equal(generation.stage,'execute');assert.equal(permitsPaidImage(generation),true);
 assert.deepEqual(authorizeTaskDecision({...read,operation:'revise',stage:'discuss'}).allowedEffects,['read']);
 const draft=decisionFromPlanning({content:JSON.stringify({decision:{operation:'draft',relation:'new',responseType:'plan',allowedEffects:['paid_image']},mode:'conversation'})}).decision;
 assert.equal(draft.operation,'draft');assert.deepEqual(draft.allowedEffects,['read','save_draft']);assert.equal(permitsPaidImage(draft),false);
 const recovered=[];const bareRevise=decisionFromPlanning({content:JSON.stringify({goal:'修改已有方案',operation:'revise',relation:'revise',taskId:'task-1',responseType:'plan'})},{onRecovery:detail=>recovered.push(detail)}).decision;
 assert.equal(bareRevise.operation,'revise');assert.deepEqual(bareRevise.allowedEffects,['read','save_draft','save_brief']);assert.equal(recovered[0].kind,'text_decision_without_envelope');
 assert.throws(()=>decisionFromPlanning({content:JSON.stringify({operation:'generate',relation:'new',items:[{purpose:'主图'}]})}),/交付计划类型无效/);
 const legacy=decisionFromPlanning({content:JSON.stringify({mode:'generate',items:[{purpose:'主图'}]})}).decision;
 assert.equal(legacy.source,'legacy_plan');assert.equal(legacy.operation,'generate');assert.equal(permitsPaidImage(legacy),true);
});

test('首次制定方案在 Agent 交付后保存 v1，随后可独立确认；只读分析不建任务',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-contract-draft-'));
 try{
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[]};
  const budget=new Budget(path.join(dir,'budget.json'),1000);
  const draftJob={id:'draft-job',text:'请为耳机制定一套淘宝主图视觉方案。',selection:[],usage:[]};let calls=0;
  const draftFetcher=async(url,options)=>{calls++;assert.ok(!url.includes('volces'));const payload=JSON.parse(options.body);if(!payload.tools)return response(JSON.stringify({decision:{operation:'draft',relation:'new',responseType:'plan',allowedEffects:['paid_image']},mode:'conversation'}));assert.ok(!payload.tools.some(tool=>['save_brief','create_image','edit_image'].includes(tool.function.name)));assert.equal(project.creativeTasks.length,0);return response(answer)};
  const reply=await runTask({project,job:draftJob,env:{ZHIPU_API_KEY:'mock'},budget,dataDir:dir,fetcher:draftFetcher,emit:()=>{},persist:()=>{}});
  assert.equal(reply,answer);assert.equal(calls,2);assert.equal(project.creativeTasks.length,1);assert.equal(project.creativeTasks[0].revisions.length,1);assert.equal(project.creativeTasks[0].revisions[0].kind,'design');assert.equal(project.creativeTasks[0].revisions[0].status,'draft');assert.equal(project.creativeTasks[0].revisions[0].content,answer);assert.equal(project.brief,'');
  const task=project.creativeTasks[0],revision=task.revisions[0];
  const confirmJob={id:'confirm-job',text:'我确认采用这版方案，不生成图片。',selection:[],usage:[]};
  const confirmFetcher=async(url,options)=>{assert.ok(!url.includes('volces'));assert.ok(!JSON.parse(options.body).tools);return response(JSON.stringify({decision:{operation:'confirm',relation:'continue',taskId:task.id,approval:{intent:'confirm_existing_revision',revisionId:revision.id,quote:'我确认采用这版方案'}},mode:'conversation'}))};
  const receipt=await runTask({project,job:confirmJob,env:{ZHIPU_API_KEY:'mock'},budget,dataDir:dir,fetcher:confirmFetcher,emit:()=>{},persist:()=>{}});
  assert.match(receipt,/最终版本/);assert.equal(task.confirmedRevisionId,revision.id);assert.equal(revision.status,'confirmed');assert.equal(task.revisions.length,1);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('首次方案未交付时，不创建任务、修订或项目摘要',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-contract-draft-fail-'));
 try{
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[]};
  const job={id:'draft-fail',text:'请制定一套耳机视觉方案。',selection:[],usage:[]};
  const fetcher=async(url,options)=>{assert.ok(!url.includes('volces'));return response(JSON.parse(options.body).tools?'好的，稍后提供方案。':JSON.stringify({decision:{operation:'draft',relation:'new',responseType:'plan'},mode:'conversation'}))};
  await assert.rejects(runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}}),/文本任务未实际交付/);
  assert.equal(project.creativeTasks.length,0);assert.equal(project.activeCreativeTaskId,null);assert.equal(project.brief,'');assert.equal(job.creativeTaskId,undefined);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Planning 商品名中的未转义引号导致 JSON 无效时仅重试一次，成功后才保存草案',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-planning-json-retry-'));
 try{
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[]};
  const job={id:'draft-retry',text:'帮我为这件衣服设计一套淘宝主图的视觉方案',selection:[],usage:[]};
  const calls=[],traces=[];
  const fetcher=async(url,options)=>{
   assert.match(url,/bigmodel/);const payload=JSON.parse(options.body);calls.push(payload);
   if(payload.tools)return response(answer);
   if(calls.length===1)return response('{"decision":{"goal":"为"So Far"衣服制定方案","operation":"draft"}}');
   assert.match(JSON.stringify(payload.messages),/英文双引号是否已转义/);
   return response(JSON.stringify({decision:{goal:'为 So Far 衣服制定方案',operation:'draft',relation:'new',responseType:'plan'},mode:'conversation'}));
  };
  const reply=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{},trace:(stage,payload)=>traces.push({stage,...payload})});
  assert.equal(reply,answer);assert.equal(calls.length,3);assert.equal(project.creativeTasks.length,1);
  assert.equal(project.creativeTasks[0].revisions[0].status,'draft');assert.equal(project.assets.length,0);
  assert.equal(traces.filter(event=>event.stage==='planning_input').length,2);
  assert.equal(traces.find(event=>event.stage==='planning_json_retry_succeeded')?.operation,'draft');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Planning JSON 连续无效时只重试一次，且不保存或调用图像工具',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-planning-json-retry-fail-'));
 try{
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[]};
  const job={id:'draft-retry-fail',text:'帮我制定一套淘宝主图视觉方案',selection:[],usage:[]};
  let calls=0;
  const fetcher=async(url,options)=>{calls++;assert.match(url,/bigmodel/);assert.equal(JSON.parse(options.body).tools,undefined);return response('{"decision":')};
  await assert.rejects(runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}}),error=>error.code==='PLANNING_JSON_INVALID');
  assert.equal(calls,2);assert.equal(project.creativeTasks.length,0);assert.equal(project.assets.length,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Planning 服务响应本身不是 JSON 时清楚报错且不写任务',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-planning-response-json-'));
 try{
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[]};
  const job={id:'bad-provider-json',text:'制定主图方案',selection:[],usage:[]};
  let calls=0;
  const fetcher=async url=>{calls++;assert.match(url,/bigmodel/);return {ok:true,json:async()=>{throw SyntaxError('Unexpected token')}}};
  await assert.rejects(runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}}),/规划服务响应不是合法 JSON/);
  assert.equal(calls,1);assert.equal(project.creativeTasks.length,0);assert.equal(project.assets.length,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Planning 在只读 JSON 后多写正文时仅恢复决策，正文仍由 Agent 交付',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-planning-extra-text-'));
 try{
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[]};
  const job={id:'analysis-job',text:'分析这张图的构图方案',selection:[],usage:[]};
  const decision={decision:{goal:'分析构图',operation:'read',relation:'new',responseType:'analysis'},mode:'conversation'};
  const calls=[],traces=[];
  const fetcher=async(url,options)=>{
   assert.match(url,/bigmodel/);const body=JSON.parse(options.body);calls.push(body);
   if(!body.tools)return response(JSON.stringify(decision)+'\n\n## 模型多写的分析\n这段不能直接交付用户。');
   return response(answer);
  };
  const reply=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{},trace:(stage,payload)=>traces.push({stage,...payload})});
  assert.equal(reply,answer);assert.equal(calls.length,2);assert.equal(project.assets.length,0);
  assert.equal(job.routingDecision.operation,'read');assert.deepEqual(job.routingDecision.allowedEffects,['read']);
  assert.equal(traces.find(event=>event.stage==='planning_output_format_recovered')?.kind,'read_json_with_trailing_text');
  assert.throws(()=>parsePlanningJSON(JSON.stringify({decision:{operation:'generate'},mode:'generate'})+'\n\n## 多余正文'),error=>error.code==='PLANNING_JSON_INVALID');
  assert.throws(()=>parsePlanningJSON('{"decision":\n\n## 无效正文'),error=>error.code==='PLANNING_JSON_INVALID');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('新产品借用旧构图时不绑定旧商品任务；错误历史 ID 不允许猜测',()=>{
 const project={uploads:[{id:'bottle',role:'product'},{id:'headphone',role:'product'}],creativeTasks:[{id:'bottle-task',sourceIds:['bottle'],delivered:[]}]};
 assert.equal(resolveCreativeTask(project,{taskId:'bottle-task',selection:['headphone'],relation:'continue'}).reason,'new_product_conflicts_with_task');
 assert.equal(resolveCreativeTask(project,{taskId:'bottle-task',selection:['bottle'],relation:'continue'}).task.id,'bottle-task');
 const snapshot=buildContextSnapshot({...project,id:'p',messages:[]},{id:'new-job',text:'沿用上一轮',selection:['headphone']});
 assert.ok(!snapshot.recentTurns.some(t=>t.sourceJobId==='fabricated'));
});

test('新契约确认现有 v2 只改变确认状态，不进入 Agent 或 Seedream',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-contract-confirm-'));
 try{
  const task={id:'task-1',sourceIds:[],productIds:[],referenceIds:[],constraints:[],revisions:[{id:'v2',version:2,kind:'design',status:'draft',content:'海边白色建筑与清晨自然光'}],confirmedRevisionId:null,status:'draft',delivered:[]};
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[task]};
  const job={id:'job-confirm',text:'我确认采用这版方案，请保存为最终版本，不生成图片。',selection:[],usage:[]};let calls=0;
  const fetcher=async(url,options)=>{calls++;assert.ok(!url.includes('volces'));assert.ok(!JSON.parse(options.body).tools);return response(JSON.stringify({decision:{goal:'确认方案',operation:'confirm',relation:'continue',taskId:'task-1',approval:{intent:'confirm_existing_revision',revisionId:'v2',quote:'我确认采用这版方案'}},mode:'conversation'}))};
  const receipt=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});
  assert.match(receipt,/最终版本/);assert.equal(calls,1);assert.equal(task.confirmedRevisionId,'v2');assert.equal(task.revisions.length,1);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Planning 服务失败或引用不存在的历史时，不写任务且不调用图片模型',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-contract-failure-'));
 try{
  const makeProject=()=>({id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[]});
  const makeJob=id=>({id,text:'沿用上一轮构图做一张图',selection:[],usage:[]});
  let calls=0;const unavailable=async url=>{calls++;assert.ok(!url.includes('volces'));return {ok:false,status:429,json:async()=>({error:{code:'rate_limit'}})}};
  const first=makeProject();await assert.rejects(runTask({project:first,job:makeJob('fail'),env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget-1.json'),1000),dataDir:dir,fetcher:unavailable,emit:()=>{},persist:()=>{}}),/HTTP 429/);
  assert.equal(calls,1);assert.equal(first.creativeTasks.length,0);assert.equal(first.assets.length,0);
  const second=makeProject();let modelCalls=0;
  const invented=async url=>{modelCalls++;assert.ok(!url.includes('volces'));if(modelCalls===1)return response(JSON.stringify({decision:{operation:'generate',relation:'continue',sourceJobId:'invented'},mode:'generate',items:[{purpose:'主图',visualDirection:'简洁构图'}]}));return response('请指出你想沿用哪一轮的构图方案？')};
  const result=await runTask({project:second,job:makeJob('invented'),env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget-2.json'),1000),dataDir:dir,fetcher:invented,emit:()=>{},persist:()=>{}});
  assert.match(result,/那一轮方案/);assert.equal(second.creativeTasks.length,0);assert.equal(second.assets.length,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('真实方案修改创建草案，但模型返回的付费权限字段不能触发生图',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-contract-revise-'));
 try{
  const task={id:'task-1',sourceIds:[],productIds:[],referenceIds:[],constraints:[],revisions:[{id:'v1',version:1,kind:'design',status:'confirmed',content:'室内场景'}],confirmedRevisionId:'v1',status:'confirmed',delivered:[]};
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[task]};
  const job={id:'job-revise',text:'把方案改为海边白色建筑，穿深蓝牛仔裤，清晨自然光；先只给方案，不生成图片。',selection:[],usage:[]};let calls=0;
  const fetcher=async(url,options)=>{
   assert.ok(!url.includes('volces'));calls++;
   const payload=JSON.parse(options.body);
   if(!payload.tools)return response(JSON.stringify({goal:'修改现有方案',operation:'revise',relation:'revise',taskId:'task-1',responseType:'plan',allowedEffects:['paid_image']}));
   return response('更新后的方案：选在海边白色建筑前拍摄，清晨自然光从侧面照亮主体。模特搭配深蓝牛仔裤，与建筑的白色形成明确层次。保持产品外观、颜色和比例不变，背景建筑只提供氛围，不遮挡商品。构图采用全身平视机位，主体位于中央略偏左，右侧留出天空和建筑线条。');
  };
  await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});
  assert.equal(calls,2);assert.equal(task.revisions.length,2);assert.equal(task.revisions[1].status,'draft');assert.equal(task.confirmedRevisionId,'v1');assert.equal(job.routingDecision.allowedEffects.includes('paid_image'),false);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('误判为编辑图片但任务只有已确认方案时，重新判定并保存 v2，不调用生图',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-reconsider-edit-'));
 try{
  const task={id:'task-1',sourceIds:[],productIds:[],referenceIds:[],constraints:['首次方案'],revisions:[{id:'v1',version:1,kind:'design',status:'confirmed',content:'奶油色耳机主图方案'}],confirmedRevisionId:'v1',status:'confirmed',delivered:[],lastJobId:'old-job'};
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[task]};
  const job={id:'revision-job',text:'把背景改成深色，文案换成久戴不闷。',selection:[],usage:[]};const calls=[],traces=[];
  const fetcher=async(url,options)=>{assert.ok(!url.includes('volces'));const body=JSON.parse(options.body);calls.push(body);
   if(body.tools)return response('新版方案改用深色背景，以柔和侧光勾勒奶油色耳机轮廓。主文案调整为「久戴不闷」，放在主体右侧留白区。构图保持耳机完整可见，控制背景与产品的明度差，文字以独立排版层呈现；产品外观、颜色和比例均沿用已确认版本。');
   if(calls.length===1)return response(JSON.stringify({decision:{operation:'edit',relation:'continue',taskId:task.id},mode:'edit',items:[{purpose:'修改主图',visualDirection:'深色背景'}]}));
   return response(JSON.stringify({decision:{operation:'revise',relation:'revise',taskId:task.id,responseType:'plan'},mode:'conversation'}));
  };
  await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{},trace:(stage,payload)=>traces.push({stage,...payload})});
  assert.equal(calls.length,3);assert.equal(calls.filter(call=>call.tools).length,1);assert.equal(task.revisions.length,2);assert.equal(task.revisions[1].version,2);assert.equal(task.revisions[1].status,'draft');assert.equal(task.confirmedRevisionId,'v1');assert.equal(task.revisions[0].status,'confirmed');assert.equal(task.status,'draft');assert.equal(project.assets.length,0);assert.equal(job.routingDecision.operation,'revise');assert.ok(!job.routingDecision.allowedEffects.includes('paid_image'));assert.ok(traces.some(event=>event.stage==='operation_reconsidered'&&event.operation==='revise'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('无画布作品且重新判定仍要求图片编辑时，澄清而不写状态',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-reconsider-ambiguous-'));
 try{
  const task={id:'task-1',sourceIds:[],productIds:[],referenceIds:[],constraints:[],revisions:[{id:'v1',version:1,kind:'design',status:'confirmed',content:'原方案'}],confirmedRevisionId:'v1',status:'confirmed',delivered:[],lastJobId:'old-job'};
  const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[task]};
  const job={id:'ambiguous-job',text:'再改一下',selection:[],usage:[]};let calls=0;
  const fetcher=async(url,options)=>{calls++;assert.ok(!url.includes('volces'));assert.ok(!JSON.parse(options.body).tools);return response(JSON.stringify({decision:{operation:'edit',relation:'continue',taskId:task.id},mode:'edit',items:[{purpose:'修改图片',visualDirection:'调整背景'}]}))};
  const reply=await runTask({project,job,env:{ZHIPU_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});
  assert.match(reply,/修改方案.*生成新图/);assert.equal(calls,2);assert.equal(task.revisions.length,1);assert.equal(task.status,'confirmed');assert.equal(task.confirmedRevisionId,'v1');assert.equal(task.lastJobId,'old-job');assert.equal(project.brief,'');assert.equal(project.assets.length,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
