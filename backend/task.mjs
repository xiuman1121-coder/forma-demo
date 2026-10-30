import {randomUUID,createHash} from 'node:crypto';
import {existsSync,statSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {runAgent} from './agent.mjs';
import {imageReserveFen} from './pricing.mjs';
import {buildRoutingContext,decisionFromPlanning,permitsPaidImage,parsePlanningJSON,authorizeTaskDecision,permitsEffect,requireEffect} from './routing.mjs';
import {ensureCreativeTasks,taskSnapshot,resolveCreativeTask,inheritTaskSelection,createCreativeTask,recordTaskRevision,confirmTaskRevision,approvalForRevision,approvalForTextRevision,applyTaskMaterialRoles,syncTaskDelivery,resolveExecutionRevision} from './task-context.mjs';
import {buildContextSnapshot,resolveSnapshotReference} from './context-snapshot.mjs';
import {clarifyPlanReference,revisionLabel,directionOptions} from './plan-reference.mjs';
import {createPendingAction,resolvePendingAction,validatePendingAction,transitionPendingAction} from './pending-action.mjs';

export const TASK_IMAGE_LIMIT=4;
export const TASK_BUDGET_FEN=80;
const trim=(value,max=160)=>String(value||'').trim().slice(0,max);
function tracePlanValidation(trace,message,job,plan,retry=false){
 try{
  const raw=String(message?.content||'').replace(/^```(?:json)?\s*|\s*```$/g,'').trim();
  const parsed=parsePlanningJSON(raw),limits={purpose:100,sellingPoint:200,visualDirection:300,newComposition:300,newScene:160,newCamera:160,referenceIds:3};
  trace('validation_result',{retry,rawPlan:message?.content||null,processedPlan:plan,modeOverride:null,fieldLimits:limits,fieldTruncation:plan.items.map((item,index)=>({planItemId:item.id,sourceIndex:index,fields:Object.keys(limits).filter(key=>key!=='referenceIds'&&String(parsed.items?.[index]?.[key]||'').length>String(item[key]||'').length),referenceIds:(parsed.items?.[index]?.referenceIds?.length||0)>(item.referenceIds?.length||0)}))});
 }catch{/* Trace inspection must not affect validation. */}
}
const styleExtension=text=>/(风格|视觉特征|视觉语言)/.test(text||'')&&/(延展|拓展|衍生)/.test(text||'');
const imageExists=(dataDir,url)=>typeof url==='string'&&/^\/media\/[a-f0-9-]+\.(png|jpg|webp)$/.test(url)&&existsSync(path.join(dataDir,url.slice(1)))&&statSync(path.join(dataDir,url.slice(1))).size>100;
const imageHash=(dataDir,url)=>imageExists(dataDir,url)?createHash('sha256').update(readFileSync(path.join(dataDir,url.slice(1)))).digest('hex'):null;
function exactDuplicateFlags(project,item,asset,dataDir){
 const hash=imageHash(dataDir,asset.versions.at(-1)?.image);if(!hash)return [];
 const flags=[];
 for(const id of item.referenceIds||[]){const source=project.uploads.find(u=>u.id===id)||project.assets.find(a=>a.id===id);if(source&&imageHash(dataDir,source.url||source.versions?.at(-1)?.image)===hash){flags.push('exact_copy_of_reference');break}}
 for(const other of project.assets){if(other.id!==asset.id&&imageHash(dataDir,other.versions.at(-1)?.image)===hash){flags.push('exact_duplicate_of_existing_work');break}}
 return flags;
}
class TargetRequiredError extends Error{constructor(){super('请先在画布中选择要修改的作品，再发送修改要求。');this.code='TARGET_REQUIRED'}}

export function deliveryStatus(job){
 const items=job.plan?.items||[];
 const delivered=items.filter(item=>item.status==='completed'&&item.assetId).length;
 return {planned:items.length,delivered,pending:items.filter(item=>item.status==='pending').length,failed:items.filter(item=>item.status==='failed').length,quality:'not_evaluated'};
}

function parsePlan(message,job,project){
 const parsed=parsePlanningJSON(message?.content);
 if(!['conversation','images','generate','edit'].includes(parsed.mode))throw Error('交付计划类型无效');
 const mode=parsed.decision?.operation&&parsed.decision.operation!=='none'?parsed.decision.operation:(parsed.mode==='images'?(parsed.items?.some(i=>i.targetAssetId)?'edit':'generate'):parsed.mode);
 if(mode==='conversation')return {version:1,revisionOf:null,createdAt:new Date().toISOString(),mode,items:[]};
 if(!Array.isArray(parsed.items)||!parsed.items.length||parsed.items.length>24)throw Error('交付计划数量无效');
 const selected=new Set(job.selection||[]);
 for(const id of [...selected])for(const inherited of project.assets.find(a=>a.id===id)?.source?.referenceIds||[])selected.add(inherited);
 const available=new Set([...selected].filter(id=>project.uploads.some(u=>u.id===id)||project.assets.some(a=>a.id===id)));
 const productIds=(project.uploads||[]).filter(u=>u.role==='product'&&(job.selection||[]).includes(u.id)).map(u=>u.id);
 const selectedAssets=project.assets.filter(a=>selected.has(a.id));
 const resolveTarget=item=>{if(mode!=='edit')return null;if(selectedAssets.length===1)return selectedAssets[0].id;if(selectedAssets.length>1){if(selectedAssets.some(a=>a.id===item.targetAssetId))return item.targetAssetId;throw new TargetRequiredError()}const taskAssets=job.taskContext?.delivered||[];if(item.targetAssetId&&taskAssets.some(entry=>entry.assetId===item.targetAssetId)&&project.assets.some(a=>a.id===item.targetAssetId))return item.targetAssetId;const matches=project.assets.filter(a=>a.title&&job.text.includes(a.title));if(matches.length===1)return matches[0].id;if(project.assets.length===1&&/(这张|刚才|上一张|已有|原图|原作品)/.test(job.text))return project.assets[0].id;throw new TargetRequiredError()};
 const styleAnalysis=parsed.styleAnalysis&&typeof parsed.styleAnalysis==='object'?Object.fromEntries(['palette','lighting','mood','material','composition','preserve','avoidCopy','sourceScene','productIdentity'].map(key=>[key,trim(parsed.styleAnalysis[key],360)])):null;
 const items=parsed.items.map((item,index)=>({id:randomUUID(),order:index+1,purpose:trim(item.purpose,100)||`作品 ${index+1}`,sellingPoint:trim(item.sellingPoint,200),visualDirection:trim(item.visualDirection,300),newComposition:trim(item.newComposition,300),newScene:trim(item.newScene,160),newCamera:trim(item.newCamera,160),referenceIds:[...new Set([...productIds,...(Array.isArray(item.referenceIds)?item.referenceIds:job.selection||[])].filter(id=>available.has(id)))].slice(0,3),targetAssetId:resolveTarget(item),status:'pending',assetId:null,error:null}));
 if(styleExtension(job.text)&&mode==='generate'){
  const weak=items.some(item=>!item.newComposition||!item.newScene||!item.newCamera||/(微调|略微|略有变化|位置调整|偏右|偏左|原有基础)/.test(item.newComposition));
  const sameScene=items.some(item=>styleAnalysis?.sourceScene&&item.newScene===styleAnalysis.sourceScene);
  const samePlan=new Set(items.map(item=>`${item.newScene}|${item.newCamera}|${item.newComposition}`)).size!==items.length;
  const wrongPurpose=/(主图)/.test(job.text)&&items.some(item=>/(细节|特写)/.test(item.purpose)&&!/(整体|全貌)/.test(item.purpose));
  if(!styleAnalysis?.palette||!styleAnalysis?.lighting||!styleAnalysis?.mood||!styleAnalysis?.productIdentity||!styleAnalysis?.sourceScene||weak||sameScene||samePlan||wrongPurpose){const error=Error('风格延展计划未明确保留的产品结构，或只是微调原场景；已停止，未调用生图模型。');error.code='STYLE_PLAN_INVALID';throw error}
 }
 const quantity=String(job.text||'').match(/(?:生成|制作|设计|延展|拓展|衍生|做|出|要|需要|多|再).{0,18}?([1-9]|[一二两三四五六七八九两])\s*张/);
 const count=quantity?({'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}[quantity[1]]||Number(quantity[1])):null;
 if(count&&items.length!==count)throw Error(`交付计划数量与用户要求不符：要求 ${count} 张，规划了 ${items.length} 张。未调用生图模型。`);
 return {version:1,revisionOf:null,createdAt:new Date().toISOString(),mode,styleAnalysis,items};
}

// A continuation may reuse a plan created after an earlier upload was selected.
// Recover only the upload IDs explicitly bound by that plan's routing decision,
// and verify them against the source turn rather than trusting arbitrary model IDs.
export function bindSourceUploads(project,job,decision,plan,trace=()=>{}){
 const jobs=project.jobs||[];
 let sourceId=decision?.sourceJobId||plan?.revisionOf||null;
 let source=null;
 const visited=new Set();
 const sourceSelection=new Set();
 while(sourceId&&!visited.has(sourceId)){
  visited.add(sourceId);
  const candidate=jobs.find(entry=>entry.id===sourceId);
  if(!candidate)break;
  for(const id of candidate.selection||[])sourceSelection.add(id);
  if(!source&&candidate.routingDecision?.materialRoles?.productIds?.length)source=candidate;
  sourceId=candidate.routingDecision?.sourceJobId||candidate.plan?.revisionOf||null;
 }
 const roleIds=decision?.materialRoles?.productIds?.length?decision.materialRoles.productIds:source?.routingDecision?.materialRoles?.productIds||[];
 const sourceTurn=jobs.find(entry=>entry.id===decision?.sourceJobId);
 const bound=roleIds.filter(id=>sourceSelection.has(id)&&project.uploads.some(upload=>upload.id===id));
 if(!bound.length)return;
 job.selection=[...new Set([...(job.selection||[]),...bound])];
 if(plan?.items)for(const item of plan.items)if(!item.referenceIds?.length)item.referenceIds=[...bound].slice(0,3);
 trace('source_uploads_bound',{sourceJobId:source?.id||sourceTurn?.id||null,ids:bound,continuedPlan:!!plan});
}

function imageReferenceExists(project,dataDir,id){
 const upload=project.uploads.find(entry=>entry.id===id);
 const asset=project.assets.find(entry=>entry.id===id);
 if(upload?.kind==='document'||!upload&&!asset)return false;
 const url=upload?.url||asset?.versions?.at(-1)?.image;
 if(typeof url!=='string'||!/^\/(media|assets)\/[a-zA-Z0-9.-]+$/.test(url))return false;
 const file=url.startsWith('/media/')?path.join(dataDir,url.slice(1)):path.join(dataDir,'..','dist',url.slice(1));
 return existsSync(file)&&statSync(file).size>100;
}

export function validateImageExecutionContext(project,child,item,dataDir){
 const selected=new Set(child.selection||[]);
 const required=[...(item.referenceIds||[]),...(item.targetAssetId?[item.targetAssetId]:[])];
 for(const id of required){
  if(!selected.has(id))throw Error('交付计划引用的素材未进入最终执行素材，图片未生成。');
  if(!imageReferenceExists(project,dataDir,id))throw Error('交付计划引用的图片文件不存在或不可读取，图片未生成。');
 }
 for(const id of selected){
  const upload=project.uploads.find(entry=>entry.id===id);
  if(upload?.kind==='document')continue;
  if(!imageReferenceExists(project,dataDir,id))throw Error('最终执行素材中的图片文件不存在或不可读取，图片未生成。');
 }
}

export function revisePlan(previous,changes=[],revisionOf=null){
 if(!previous||!Array.isArray(previous.items))throw Error('没有可修订的计划');
 const updates=new Map(changes.map(change=>[change.id,change]));
 return {version:(previous.version||1)+1,revisionOf,createdAt:new Date().toISOString(),mode:previous.mode,sourceId:previous.sourceId,styleAnalysis:previous.styleAnalysis||null,items:previous.items.map(item=>{
  if(item.status==='completed')return structuredClone(item);
  const change=updates.get(item.id)||{};
  return {...item,purpose:trim(change.purpose??item.purpose,100),sellingPoint:trim(change.sellingPoint??item.sellingPoint,200),visualDirection:trim(change.visualDirection??item.visualDirection,300),referenceIds:Array.isArray(change.referenceIds)?change.referenceIds.slice(0,3):item.referenceIds,status:'pending',error:null,startedAt:null};
 })};
}

export function buildPlanningInput({project,job,dataDir,repairReason='',contextSnapshot=buildContextSnapshot(project,job)}){
 const related=resolveCreativeTask(project,{selection:job.selection,relation:'continue'});
 const inherited=related.task?inheritTaskSelection(project,job,related.task):{selection:job.selection||[],source:'none'};
 const selected=new Set(inherited.selection);
 for(const id of [...selected])for(const inherited of project.assets.find(a=>a.id===id)?.source?.referenceIds||[])selected.add(inherited);
 const candidateContext=buildRoutingContext({project,job});
 const brief=taskSnapshot(related.task)?.latestDesignRevision?.content||(!ensureCreativeTasks(project).length?project.brief||'':'');
 const current={contextSnapshot,brief,selection:[...selected],selectionSource:inherited.source,relatedTask:taskSnapshot(related.task),planChoices:(related.task?.revisions||[]).filter(r=>['analysis','design'].includes(r.kind)).slice(-20).map(r=>({revisionId:r.id,label:revisionLabel(r),sourceJobId:r.jobId,status:r.status})),directionChoices:directionOptions(related.task),uploads:(project.uploads||[]).map(u=>({id:u.id,label:u.label,role:u.role||'reference'})),assets:(project.assets||[]).map(a=>({id:a.id,title:a.title,source:a.source||null})),routingContext:candidateContext};
 const prompt='你是设计交付规划器。只返回 JSON，不调用工具。先根据本轮需求和 contextSnapshot 判断用户现在要完成什么，而不是把未来想做的图片当作本轮执行。decision 只输出 {goal,operation,relation,taskId,sourceJobId,sourceRevisionId,pendingActionId,reason,blockingQuestion,approval,materialRoles,responseType}，不要输出 stage 或 allowedEffects；权限由程序根据 operation 推导。operation 只能是 read（只读查询/讨论/分析）、draft（首次制定并保存正式方案草案）、revise（修改并保存已有方案）、confirm（明确确认既有方案）、generate（立即新建图片）、edit（立即修改画布作品）、crop_grid（原图等分裁切）、clarify（完成本轮确实缺少必要信息）。read 的 responseType 可为 analysis、plan 或 answer，表示本轮文本交付种类，不授予写权限。relation 为 new、continue、revise、unresolved。引用 recentTurns 的分析或方案时返回其真实 sourceJobId；引用正式任务时返回真实 taskId。按已有方案生成图片时，sourceRevisionId 必须是本轮实际采用的设计修订 ID；从 relatedTask.designRevisions 中选，已确认方案用 confirmedRevision.id，最新修改方案用 latestDesignRevision.id，不得只让下游猜最新版本。没有正式任务不代表找不到上一轮分析。多个候选且无法确定时 clarify 并给 blockingQuestion，不得猜测 ID。用户提供新产品图并借用上一轮构图时，新产品图是本轮商品，旧图只是构图参考，不要继承旧商品身份。只有本轮明确要求执行图片才用 generate/edit；用户只要求分析、讨论或探索可能性时用 read；明确要求制定一套可继续修改或确认的方案时用 draft；已有正式方案的内容修改用 revise，包括调整计划中的场景、背景、构图或文案；只有用户明确要求现在生成或编辑图片，或用户明确接受上一轮结构化待执行提议时才用 generate/edit。没有已生成的画布作品时不能用 edit 修改方案。draft 只创建草案，不表示用户已确认，也不允许生图；Planning 只判断本轮操作，具体分析由后续 Agent 回答。用户要求九宫格/3x3 裁切时用 crop_grid，不得当作生图。mode 必须是 conversation、generate 或 edit；裁切和文本任务用 conversation。确认既有方案须提供本轮原话证据及准确 revisionId；普通生成不等于确认。图片任务的 items 必须遵守本轮数量与素材 ID。图片任务返回 {"decision":{...},"mode":"generate或edit","styleAnalysis":{"palette":"","lighting":"","mood":"","material":"","sourceScene":"原图实际场景","productIdentity":"只列可观察到的产品颜色、柜体/瓶体结构、门/层板/把手/腿等不可改变的外观事实","preserve":"产品外观与抽象风格","avoidCopy":"不得沿用的原图场景道具与构图"},"items":[{"purpose":"图片用途","sellingPoint":"核心卖点或留空","visualDirection":"视觉方向","newScene":"与原图明显不同的具体场景","newCamera":"明确的新景别和机位","newComposition":"新构图、主体与道具的关系，不允许微调原图","referenceIds":["真实素材ID"],"targetAssetId":null}]}。风格延展必须先把产品身份与可迁移的色光氛围分开：准确保留产品结构、比例、颜色；不能把原图的植物、沙发、台面和机位复制到新场景。逐张提供真正不同的场景与镜头，不允许“略偏右”“植物位置微调”“去掉文字”这种弱变化。用户要主图就规划展示完整产品的主图，不把细节特写冒充主图。若参考图只有合成图，应只写可见产品事实，不编造。按用户明确数量规划，不能多也不能少；未明确数量时依据需求合理规划。修改已有作品才填 targetAssetId。不要因本轮最多执行4张删减完整计划。referenceIds 只能来自 selection。不要声称已生成。';
 const contextContract='任务状态字段：若用户在本轮明确批准已有方案并要求按它执行，在 decision.approval 返回 {"intent":"confirm_existing_revision","revisionId":"relatedTask.latestRevision.id","quote":"从本轮用户原文逐字复制的批准短句"}。quote 必须是用户这轮实际说出的批准语句，不能引用历史或模型回复；普通直接生成、仅沿用参考、继续制作但未批准具体方案时 approval=null。此证据与 confirmPreviousPlan 分开填写，不能只依赖该布尔值。若没有可批准的已有设计方案，approval=null。另在 decision.materialRoles 返回 {"productIds":["作为这次核心商品的上传素材ID"],"styleIds":["只用于借鉴风格的上传素材ID"]}；依据本轮需求、图片及素材角色判断，不能将所有参考图片都视为商品。只从当前 selection 选择真实上传 ID，不确定的素材不填。';
 const pendingActionContract='待执行提议规则：contextSnapshot.pendingActions 是 Agent 上轮以确定字段保存的动作。若本轮用户的简短同意（例如 ok、好的）语义上接受其中一条唯一的 pending 提议，decision 必须返回 operation=edit、relation=continue、pendingActionId=该提议真实 ID、taskId=该提议 task_id、sourceRevisionId=该提议 source_revision_id、sourceJobId=该提议 source_job_id，mode=edit；items 只含一张，targetAssetId 必须等于提议 target_asset_id，visualDirection 采用提议 direction_content。后端会再用提议的原始参数覆盖模型规划字段。若提议 direction_content 为空或方向有多个未选定，返回 clarify，明确列出候选画面关键词，不得暗选。无有效 pending 提议时，简短同意只可按普通草案确认判断，不得自行授权生图。';
 const imageContent=[...new Set([...selected,...contextSnapshot.historicalVisualIds])].flatMap(id=>{const upload=project.uploads.find(u=>u.id===id);const asset=project.assets.find(a=>a.id===id);if(upload?.kind==='document')return [{type:'text',text:`参考文件 ID=${id}，${upload.label}\n${String(upload.text||'').slice(0,6000)}`}];const url=upload?.previewUrl||upload?.url||asset?.versions.at(-1)?.image;if(!url)return [];const file=path.join(dataDir,url.slice(1));if(!existsSync(file))return [];const ext=path.extname(file);return [{type:'text',text:`${selected.has(id)?'本轮素材':'历史视觉参考（不可当作本轮产品或生图素材）'} ID=${id}，角色=${upload?.role||'reference'}`},{type:'image_url',image_url:{url:`data:image/${ext==='.jpg'?'jpeg':ext.slice(1)};base64,${readFileSync(file).toString('base64')}`}}]});
 return {messages:[{role:'system',content:prompt+'\n'+contextContract+'\n'+pendingActionContract+'\n方案版本与方案内部选项是不同编号空间。“方案一”“前面那个方案”等指代须结合对话顺序和方案内容理解；若可能指向不同版本或同一版本内的选项，必须 clarify。用户明确点名方向字母（如方向 D）且 directionChoices 中只有一个匹配时直接采用，不因其来源早于 recentTurns 而澄清；sourceJobId 与 sourceRevisionId 应取 directionChoices 对应的真实 ID。澄清问题引用候选方向的场景、主体、构图等画面关键词，不引用“做一下方案”“有没有别的方案”等历史用户原话。用户明确指出最早、最新或具体场景且只有一个候选时可直接选。普通“按某方案制作”不是对草稿的明确确认，approval 应为 null。\n同一项目的 recentTurns 含历史对话与 sourceJobId。用户指代上一轮分析时可引用对应 sourceJobId；没有 creativeTask 不等于没有上一轮分析。产品素材与风格参考须分开，当前新产品不得继承旧产品图片。最终输出必须且只能是一个 JSON 对象；不要使用代码围栏，不要在 JSON 前后附加分析正文、解释或给用户的话。文本分析与设计建议由后续 Agent 交付。'},{role:'user',content:[{type:'text',text:JSON.stringify(current)+'\n用户需求：'+job.text+(repairReason?'\n上一版计划被执行门禁拒绝，必须修正：'+repairReason:'')},...imageContent]}],selectedIds:[...selected],relatedTaskId:related.task?.id||null,selectionSource:inherited.source,briefSource:related.task?.revisions?.length?'task_revision':brief?'legacy_project':'none',historyCount:contextSnapshot.recentTurns.length};
}

async function requestPlan({project,job,env,budget,dataDir,fetcher,emit,signal,repairReason='',confirmationTask=null,contextOperationTask=null,contextSnapshot=buildContextSnapshot(project,job),trace=()=>{}}){
 const input=contextOperationTask?{
  messages:[{role:'system',content:'你是 Forma 的任务操作判断器。区分本轮对现有方案的操作：read 只读核对，revise 修改并保存新草案，confirm 明确批准现有草案但不生图；stage 独立表示 discuss 或 plan。本轮禁止图片执行。只返回 JSON：{"decision":{"goal":"","stage":"discuss|plan","operation":"read|revise|confirm","relation":"continue","allowedEffects":["read"]或["read","save_draft"],"reason":"","approval":null或{"intent":"confirm_existing_revision","revisionId":"现有草案ID","quote":"本轮用户原文中的明确批准短句"}},"mode":"conversation"}。查询、解释、复述、核对现有内容为 discuss/read；只有用户要求改变方案内容并保存新版本才是 plan/revise。confirm 必须有当前用户原话和准确草案 ID；普通讨论或模糊同意的 approval=null。混合或不明确请求不得授予 save_draft。不能因为回答里有分析文字就授予写权限。'} ,{role:'user',content:JSON.stringify({request:job.text,contextSnapshot,taskId:contextOperationTask.id,latestRevision:taskSnapshot(contextOperationTask).latestRevision,confirmedRevisionId:contextOperationTask.confirmedRevisionId||null})}],
  relatedTaskId:contextOperationTask.id,selectionSource:'task_operation',briefSource:'task_revision'
 }:confirmationTask?{
  messages:[{role:'system',content:'你是 Forma 的任务状态判断器。本轮只判断用户是否明确确认已有设计方案，不规划或执行图片。只返回 JSON：{"decision":{"goal":"","stage":"plan","operation":"confirm","relation":"continue","allowedEffects":["read"],"reason":"","approval":{"intent":"confirm_existing_revision","revisionId":"修订ID","quote":"本轮用户原文中明确确认该方案的连续短句"}},"mode":"conversation"}。若用户仅模糊同意、讨论或修改方案，approval 必须为 null。revisionId 必须等于所给草案 ID；不得把模型草案自行视为用户确认。'}, {role:'user',content:JSON.stringify({request:job.text,contextSnapshot,taskId:confirmationTask.id,draftRevision:taskSnapshot(confirmationTask).latestRevision,constraints:confirmationTask.constraints})}],
  relatedTaskId:confirmationTask.id,selectionSource:'confirmation_task',briefSource:'task_revision'
 }:buildPlanningInput({project,job,dataDir,repairReason,contextSnapshot});
 const {messages,relatedTaskId,selectionSource,briefSource,historyCount=0}=input;
 if(repairReason&&!messages.some(message=>typeof message.content==='string'&&message.content.includes(repairReason)))messages.push({role:'user',content:`上一版输出需要修正：${repairReason}。只返回一个完整、合法的 JSON 对象，不要附加正文。`});
 const payload={model:'glm-5.3-flash',messages,max_tokens:8192,reasoning_effort:'low',thinking:{type:'enabled',clear_thinking:false},stream:false};
 trace('planning_input',{purpose:contextOperationTask?'task_operation':confirmationTask?'text_confirmation':'delivery_plan',retry:!!repairReason,repairReason,model:payload.model,parameters:{max_tokens:payload.max_tokens,reasoning_effort:payload.reasoning_effort,thinking:payload.thinking,stream:payload.stream},messages,contextSources:{briefSource,currentUserText:true,historyMessages:historyCount||contextSnapshot.recentTurns.length,sourceJobIds:contextSnapshot.recentTurns.map(t=>t.sourceJobId),selectedIds:job.selection||[],relatedTaskId,selectionSource,uploadMetadataCount:project.uploads?.length||0,assetMetadataCount:project.assets?.length||0}});
 const request=()=>fetcher('https://open.bigmodel.cn/api/paas/v4/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${env.ZHIPU_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
 let response;
 for(let attempt=1;attempt<=2;attempt++){
  const reservation=budget.reserve(job.id,5,TASK_BUDGET_FEN);
  try{response=await request();budget.finish(reservation,response.ok?'estimated':'uncertain');break}
  catch(error){budget.finish(reservation,'uncertain');if(signal?.aborted)throw error;const timedOut=error?.name==='TimeoutError'||error?.name==='AbortError';trace('planning_request_failed',{attempt,timedOut,error:String(error?.message||error).slice(0,200)});if(!timedOut||attempt===2)throw Error(timedOut?'规划服务连续超时，本轮没有调用生图。请稍后重试。':error.message);emit('planning','规划服务响应超时，正在重试一次')}
 }
 if(!response.ok){const error=await response.json().catch(()=>({}));trace('planning_provider_error',{model:payload.model,status:response.status,error});throw Error(`规划服务请求失败（HTTP ${response.status}）`)}
 let data;
 try{data=await response.json()}catch{throw Error('规划服务响应不是合法 JSON，本轮未保存方案或调用生图。')}
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('规划服务响应结构无效，本轮未保存方案或调用生图。');
 trace('planning_output',{model:payload.model,rawMessage:data.choices?.[0]?.message||null,usage:data.usage||null});job.usage.push({model:payload.model,...data.usage});return data.choices?.[0]?.message;
}

export async function runTask({project,job,env,budget,dataDir,emit,persist,fetcher=fetch,signal,audit=()=>{},trace=()=>{}}){
 const check=()=>{if(job.cancelled||signal?.aborted)throw Error('任务已停止，已完成的结果已保存。')};
 ensureCreativeTasks(project);
 const contextSnapshot=buildContextSnapshot(project,job);
 trace('context_snapshot',{projectId:contextSnapshot.projectId,jobId:job.id,sourceJobIds:contextSnapshot.recentTurns.map(t=>t.sourceJobId),taskIds:contextSnapshot.taskCandidates.map(t=>t.id),selectedIds:contextSnapshot.current.selectedIds,truncated:contextSnapshot.truncated});
 const routingContext=buildRoutingContext({project,job});
 let decision=null;
 let plan=job.plan;
 let pendingExecution=null;
 if(plan)bindSourceUploads(project,job,null,plan,trace);
 trace('routing',{rules:{continuedPlan:!!job.plan},candidateMode:plan?.mode||'planning_glm',selection:job.selection||[],context:routingContext});
 if(plan)trace('validation_reused_plan',{source:'continue_plan',version:plan.version,revisionOf:plan.revisionOf||null,processedPlan:plan});
 if(plan)decision={version:1,goal:trim(job.text,300),stage:'execute',operation:plan.mode==='edit'?'edit':plan.mode==='crop_grid'?'crop_grid':'generate',relation:'continue',allowedEffects:plan.mode==='crop_grid'?['read','local_image']:['read','paid_image'],source:'continued_plan',reason:'显式继续已有交付计划'};
 if(!plan){
  emit('planning','整理交付计划');
  let planMessage=await requestPlan({project,job,env,budget,dataDir,fetcher,emit,signal,contextSnapshot,trace});check();
  try{
   let result;
   try{result=decisionFromPlanning(planMessage,{onRecovery:details=>trace('planning_output_format_recovered',details)})}
   catch(error){
    if(error.code!=='PLANNING_JSON_INVALID')throw error;
    trace('validation_failed',{rawPlan:planMessage?.content||null,code:error.code,error:error.message,retryEligible:true});
    emit('planning','规划格式有误，正在重新整理');
    planMessage=await requestPlan({project,job,env,budget,dataDir,fetcher,emit,signal,repairReason:'上一版不是合法 JSON。请检查所有字符串中的英文双引号是否已转义，特别是商品名称或文案中的引号；保持原本的用户意图和操作，不得新增生图授权',contextSnapshot,trace});check();
    result=decisionFromPlanning(planMessage,{onRecovery:details=>trace('planning_output_format_recovered',details)});
    trace('planning_json_retry_succeeded',{operation:result.decision.operation});
   }
   decision=result.decision;
   if(decision.pendingActionId){
    const resolved=resolvePendingAction(project,decision.pendingActionId);
    const invalid=validatePendingAction(project,resolved.task,resolved.action);
    if(invalid==='direction_unresolved')return `请先选定要重做的方向：${resolved.action.direction_options.join('，')}。本轮没有生成图片。`;
    if(invalid)return '上一轮待执行提议已失效或已经处理，本轮没有生成图片。请重新说明要修改哪张作品。';
    if(decision.operation!=='edit'||decision.taskId!==resolved.task.id||decision.sourceRevisionId!==resolved.action.source_revision_id||decision.sourceJobId!==resolved.action.source_job_id)return '待执行提议与本轮操作或来源不一致，本轮没有生成图片。';
    pendingExecution=resolved;
   }
   if(['generate','edit','confirm'].includes(decision.operation)){
    const target=resolveCreativeTask(project,{selection:job.selection,taskId:decision.taskId,relation:'continue'}).task;
    const ambiguity=clarifyPlanReference(target,job.text);
    if(ambiguity){trace('plan_reference_ambiguous',{taskId:target.id,sourceRevisionId:decision.sourceRevisionId||null,reason:ambiguity.reason});return ambiguity.question;}
   }
   const sourceReference=resolveSnapshotReference(contextSnapshot,decision);
   if(!sourceReference.ok){decision={...decision,stage:'clarify',operation:'read',blockingQuestion:'我找不到你指的那一轮方案。请指出对应消息或重新发来方案。',reason:sourceReference.reason};}
   trace('context_reference',{sourceJobId:decision.sourceJobId||null,found:!!sourceReference.turn,relatedTaskId:decision.taskId||null});
   if(['continue','revise'].includes(decision.relation)&&decision.stage!=='clarify'){
    const resolved=resolveCreativeTask(project,{selection:job.selection,taskId:decision.taskId,relation:decision.relation});
    trace('task_relation',{relation:decision.relation,taskId:resolved.task?.id||null,source:resolved.reason,candidates:routingContext.taskCandidates});
    if(!resolved.task&&!job.plan&&!sourceReference.turn){decision={...decision,stage:'clarify',operation:'none',allowedEffects:['read'],blockingQuestion:'你想继续哪个创作任务或哪张作品？请在画布中选择对应素材。',reason:`无法唯一关联创作任务：${resolved.reason}`};}
    else if(resolved.task){job.creativeTaskId=resolved.task.id;job.taskContext=taskSnapshot(resolved.task);const inherited=inheritTaskSelection(project,job,resolved.task);job.selection=inherited.selection;trace('task_context_bound',{taskId:resolved.task.id,source:resolved.reason,selectionSource:inherited.source,selectedIds:job.selection,revisionVersion:job.taskContext.latestRevision?.version||null,confirmedRevisionId:job.taskContext.confirmedRevisionId});}
   }
   if(decision.stage==='execute')bindSourceUploads(project,job,decision,null,trace);
   if(decision.stage==='execute'){
    if(decision.operation==='crop_grid'&&decision.allowedEffects.includes('local_image'))plan={version:1,revisionOf:null,createdAt:new Date().toISOString(),mode:'crop_grid',items:[]};
    else{if(!permitsPaidImage(decision))throw Error('本轮没有付费生图权限，未发送生图请求。');if(pendingExecution){const action=pendingExecution.action;const referenceIds=[...new Set([...(pendingExecution.task.productIds||[]),...(pendingExecution.task.referenceIds||[])])].filter(id=>project.uploads.some(upload=>upload.id===id)).slice(0,3);plan={version:1,revisionOf:null,createdAt:new Date().toISOString(),mode:'edit',sourceRevisionId:action.source_revision_id,pendingActionId:action.id,items:[{id:randomUUID(),order:1,purpose:'按已确认方向重做作品',sellingPoint:'',visualDirection:action.direction_content,newComposition:action.direction_content,newScene:'',newCamera:'',referenceIds,targetAssetId:action.target_asset_id,aspectRatio:action.aspect_ratio,status:'pending',assetId:null,error:null}]};trace('pending_action_plan_bound',{id:action.id,targetAssetId:action.target_asset_id,sourceRevisionId:action.source_revision_id})}else{plan=parsePlan(planMessage,job,project);tracePlanValidation(trace,planMessage,job,plan)}if(plan.mode!==decision.operation)throw Error('Routing 决策与交付计划类型冲突，未发送生图请求。')}
   }else plan={version:1,revisionOf:null,createdAt:new Date().toISOString(),mode:'conversation',items:[]};
  }catch(error){
   trace('validation_failed',{rawPlan:planMessage?.content||null,code:error.code||null,error:error.message,retryEligible:error.code==='STYLE_PLAN_INVALID'});
   if(error.code==='STYLE_PLAN_INVALID'){
    audit('plan_rejected',{reason:error.message,phase:'before_image_request'});
    emit('planning','延展计划只微调原图，正在要求重新规划');
    const repaired=await requestPlan({project,job,env,budget,dataDir,fetcher,emit,signal,repairReason:error.message,contextSnapshot,trace});check();
    try{plan=parsePlan(repaired,job,project);tracePlanValidation(trace,repaired,job,plan,true)}catch(retryError){trace('validation_failed',{retry:true,rawPlan:repaired?.content||null,code:retryError.code||null,error:retryError.message});throw retryError}
   }
   else {
   if(error.code==='TARGET_REQUIRED'){
    const boundTask=job.creativeTaskId?ensureCreativeTasks(project).find(task=>task.id===job.creativeTaskId):null;
    const hasDesign=boundTask?.revisions?.some(revision=>['analysis','design'].includes(revision.kind));
    if(hasDesign&&!boundTask.delivered?.length){
     emit('planning','没有可编辑作品，正在核对是否要修改方案');
     const retry=await requestPlan({project,job,env,budget,dataDir,fetcher,emit,signal,contextSnapshot,trace,repairReason:`上一判断为 edit，但当前创作任务 ${boundTask.id} 只有方案修订，没有已生成的画布作品，无法执行 edit。重新依据本轮原话判断：若要修改方案，返回 revise 和 mode=conversation；若只是讨论，返回 read；若仍需明确用户是改方案还是要新做图，返回 clarify。不得再次返回 edit 或自行授予生图权限。`});check();
     try{
      const reconsidered=decisionFromPlanning(retry,{onRecovery:details=>trace('planning_output_format_recovered',details)}).decision;
      const reference=resolveSnapshotReference(contextSnapshot,reconsidered);
      if(reference.ok&&['read','revise'].includes(reconsidered.operation)&&['continue','revise'].includes(reconsidered.relation)&&(!reconsidered.taskId||reconsidered.taskId===boundTask.id)){
       decision={...reconsidered,taskId:boundTask.id};plan={version:1,revisionOf:null,createdAt:new Date().toISOString(),mode:'conversation',items:[]};trace('operation_reconsidered',{reason:'edit_target_missing',taskId:boundTask.id,operation:decision.operation});
      }else{trace('operation_reconsidered',{reason:'edit_target_missing',taskId:boundTask.id,operation:reconsidered.operation,result:'clarify'});return '当前只有已保存的方案，没有可编辑的画布作品。你是想修改方案，还是现在生成新图？方案状态未改变。'}
     }catch(retryError){trace('operation_reconsidered',{reason:'edit_target_missing',taskId:boundTask.id,result:'invalid',error:retryError.message});return '当前只有已保存的方案，没有可编辑的画布作品。请说明是修改方案，还是现在生成新图；方案状态未改变。'}
    }else{job.taskType='edit';job.needsInput='target_asset';job.technicalStatus='pending';audit('target_ambiguous',{taskType:'edit',selectedIds:job.selection||[],availableAssetIds:project.assets.map(a=>a.id)});persist();return error.message}
   }
   else throw error;
   }
  }
 }
 if(decision.operation==='confirm'&&decision.stage!=='execute'){
  const resolved=resolveCreativeTask(project,{selection:job.selection,taskId:decision.taskId,relation:'continue'});
  if(!resolved.task)return '无法唯一确定要确认的创作任务。请选中对应素材或作品；方案状态未改变。';
  const approval=approvalForTextRevision(decision,job.text,resolved.task);
  trace('task_approval_check',{taskId:resolved.task.id,...approval,source:decision.source});
  if(!approval.approved)return '没有确认到针对现有方案草案的明确批准；方案状态未改变。';
  const authorized=authorizeTaskDecision(decision,{confirmedApproval:true});requireEffect(authorized,'confirm_revision');
  confirmTaskRevision(resolved.task,approval.revisionId);resolved.task.lastJobId=job.id;project.activeCreativeTaskId=resolved.task.id;
  job.creativeTaskId=resolved.task.id;job.taskContext=taskSnapshot(resolved.task);job.routingDecision=authorized;
  job.plan={version:1,revisionOf:null,createdAt:new Date().toISOString(),mode:'conversation',items:[]};job.taskType='conversation';job.technicalStatus='not_applicable';job.delivery=deliveryStatus(job);
  trace('routing_decision',{decision:authorized});trace('task_revision_confirmed',{taskId:resolved.task.id,revisionId:approval.revisionId,source:'verified_text_approval'});persist();
  return `已将当前方案 v${job.taskContext.confirmedRevision.version} 确认为最终版本。本轮没有生成图片。`;
 }
 if(decision.stage==='clarify'){
  job.routingDecision=decision;job.plan={version:1,revisionOf:null,createdAt:new Date().toISOString(),mode:'conversation',items:[]};
  job.taskType='conversation';job.technicalStatus='not_applicable';job.clarificationQuestion=decision.blockingQuestion;
  trace('clarification_delivered',{source:'planning',question:decision.blockingQuestion});persist();
  return decision.blockingQuestion;
 }
 let creativeTask=job.creativeTaskId?ensureCreativeTasks(project).find(task=>task.id===job.creativeTaskId):null;
 if(!creativeTask&&job.plan?.revisionOf){const old=project.jobs?.find(previous=>previous.id===job.plan.revisionOf);creativeTask=ensureCreativeTasks(project).find(task=>task.id===old?.creativeTaskId)||null;}
 decision=authorizeTaskDecision(decision);
 if(decision.authorizationSource==='denied_by_code_contract')return '本轮意图或执行权限不明确，请说明是查询、修改方案、确认方案，还是生成图片；当前没有修改任务或调用图像工具。';
 if(decision.operation==='draft'&&creativeTask)return '已找到现有创作任务；如要改动已有方案，请说明要修改的内容。本轮没有创建新方案。';
 if(creativeTask&&decision.operation==='generate'){
  const source=resolveExecutionRevision(creativeTask,{sourceRevisionId:decision.sourceRevisionId||plan?.sourceRevisionId,sourceJobId:decision.sourceJobId});
  if(!source.revision&&source.reason!=='no_design_revision'){
   trace('execution_revision_rejected',{taskId:creativeTask.id,sourceRevisionId:decision.sourceRevisionId||plan?.sourceRevisionId||null,reason:source.reason});
   return '当前有多个方案版本，无法确定本轮要按哪一版生成。请指定已确认版本或最新修改版；本轮没有调用生图。';
  }
  if(source.revision){job.executionRevision=structuredClone(source.revision);job.executionRevisionId=source.revision.id;plan.sourceRevisionId=source.revision.id;trace('execution_revision_bound',{taskId:creativeTask.id,revisionId:source.revision.id,version:source.revision.version,status:source.revision.status,source:source.reason});}
 }
 if(!creativeTask&&decision.operation!=='draft'&&decision.stage!=='clarify'&&(permitsEffect(decision,'save_draft')||permitsEffect(decision,'paid_image')||permitsEffect(decision,'local_image'))){requireEffect(decision,permitsEffect(decision,'save_draft')?'save_draft':'paid_image');creativeTask=createCreativeTask(project,job);trace('task_created',{taskId:creativeTask.id,sourceIds:creativeTask.sourceIds});}
 if(creativeTask&&(permitsEffect(decision,'save_draft')||permitsEffect(decision,'paid_image')||permitsEffect(decision,'local_image'))){requireEffect(decision,'save_draft');job.creativeTaskId=creativeTask.id;job.taskContext=taskSnapshot(creativeTask);project.activeCreativeTaskId=creativeTask.id;creativeTask.lastJobId=job.id;creativeTask.updatedAt=new Date().toISOString();creativeTask.sourceIds=[...new Set([...creativeTask.sourceIds,...job.selection])];const materialBinding=applyTaskMaterialRoles(project,creativeTask,job.selection,decision.materialRoles);trace('task_material_roles',{taskId:creativeTask.id,...materialBinding});creativeTask.constraints=[...new Set([...creativeTask.constraints,trim(job.text,3000)])].slice(-12);if(plan?.styleAnalysis?.productIdentity)creativeTask.productIdentity=plan.styleAnalysis.productIdentity;trace('task_state',{taskId:creativeTask.id,status:creativeTask.status,sourceIds:creativeTask.sourceIds,revisionVersion:creativeTask.revisions?.at(-1)?.version||null});persist();}
 if(pendingExecution){const {action,task}=pendingExecution;if(!transitionPendingAction(action,'executing',job.id))return '待执行提议已被其他任务处理，本轮没有生成图片。';job.pendingActionId=action.id;job.executionRevision=structuredClone(task.revisions.find(revision=>revision.id===action.source_revision_id));job.executionRevision.content=action.direction_content;job.executionRevisionId=action.source_revision_id;persist();trace('pending_action_executing',{id:action.id,jobId:job.id})}
 job.routingDecision=decision;job.imageExecutionProhibited=!permitsPaidImage(decision);trace('routing_decision',{decision});job.plan=plan;job.taskType=plan.mode|| (plan.items.some(i=>i.targetAssetId)?'edit':plan.items.length?'generate':'conversation');trace('routing_final',{mode:job.taskType,decisionStage:decision.stage,allowedEffects:decision.allowedEffects,source:decision.source,planItemIds:plan.items.map(item=>item.id)});job.delivery=deliveryStatus(job);job.technicalStatus=plan.items.length?'pending':'not_applicable';audit('plan_saved',{taskType:job.taskType,version:plan.version,styleAnalysis:plan.styleAnalysis||null,items:plan.items.map(({id,order,purpose,sellingPoint,visualDirection,newComposition,referenceIds,targetAssetId})=>({id,order,purpose,sellingPoint,visualDirection,newComposition,referenceIds,targetAssetId}))});persist();emit('plan','交付计划已保存',{version:plan.version,items:plan.items.map(({id,order,purpose,sellingPoint,visualDirection,newComposition,referenceIds,targetAssetId})=>({id,order,purpose,sellingPoint,visualDirection,newComposition,referenceIds,targetAssetId}))});
 if(creativeTask&&plan.items.length){requireEffect(decision,'save_draft');const approval=approvalForRevision(decision,job.text,creativeTask);trace('task_approval_check',{taskId:creativeTask.id,...approval,modelFlag:decision.confirmPreviousPlan||false});if(approval.approved){const confirmation=authorizeTaskDecision(decision,{confirmedApproval:true});requireEffect(confirmation,'confirm_revision');confirmTaskRevision(creativeTask,approval.revisionId);const confirmed=creativeTask.revisions.find(item=>item.id===approval.revisionId);trace('task_revision_confirmed',{taskId:creativeTask.id,revisionId:confirmed.id,version:confirmed.version,source:'verified_user_quote'})}const revision=recordTaskRevision(creativeTask,{job,text:plan.items.map(item=>`${item.order}. ${item.purpose}：${item.visualDirection}`).join('\n'),kind:'execution_plan',plan});trace('task_revision',{taskId:creativeTask.id,revisionId:revision.id,version:revision.version,status:revision.status,kind:revision.kind});persist()}
 if(!plan.items.length){job.textDeliverable=decision.stage!=='clarify'&&decision.stage==='plan';job.clarificationQuestion=decision.stage==='clarify'?decision.blockingQuestion:null;trace('text_delivery_contract',{stage:decision.stage,required:job.textDeliverable,clarificationQuestion:job.clarificationQuestion});const answer=await runAgent({project,job,contextSnapshot,env,budget,dataDir,emit,persist,fetcher,signal,audit,trace});if(plan.mode==='crop_grid'){job.delivery=deliveryStatus(job);if(!job.delivery.delivered)throw Error('模型未调用 crop_image，图片未裁切。');job.technicalStatus='completed';if(creativeTask)syncTaskDelivery(creativeTask,job);persist();return `已将原图等分裁成 ${job.delivery.delivered} 张独立图片并保存到画布。未调用生图模型。`}if(decision.operation==='draft'){requireEffect(decision,'save_draft');check();creativeTask=createCreativeTask(project,job);trace('task_created',{taskId:creativeTask.id,sourceIds:creativeTask.sourceIds});const materialBinding=applyTaskMaterialRoles(project,creativeTask,job.selection,decision.materialRoles);trace('task_material_roles',{taskId:creativeTask.id,...materialBinding});creativeTask.constraints=[trim(job.text,3000)];job.taskContext=taskSnapshot(creativeTask)}if(creativeTask&&permitsEffect(decision,'save_draft')){requireEffect(decision,'save_draft');const revision=recordTaskRevision(creativeTask,{job,text:answer,kind:decision.stage==='plan'?'design':'analysis'});if(job.pendingActionProposal){const pending=createPendingAction(project,creativeTask,job,revision,job.pendingActionProposal);job.pendingActionId=pending.id;trace('pending_action_created',{id:pending.id,taskId:creativeTask.id,targetAssetId:pending.target_asset_id,sourceRevisionId:revision.id})}job.taskContext=taskSnapshot(creativeTask);trace('task_revision',{taskId:creativeTask.id,revisionId:revision.id,version:revision.version,status:revision.status,kind:revision.kind});persist()}return answer}
 let note='';let attempts=0;
 for(const item of plan.items){
  check();
  if(item.status==='completed')continue;
  if(attempts>=TASK_IMAGE_LIMIT){note='本轮已达到最多 4 张图片的执行上限。';break}
  const reserveFen=imageReserveFen(env);
  if((budget.entries||[]).filter(e=>e.jobId===job.id&&e.status!=='released').reduce((sum,e)=>sum+e.fen,0)+reserveFen>TASK_BUDGET_FEN||budget.snapshot().remainingFen<reserveFen){note='本轮或总预算不足，剩余计划已保留。';break}
  attempts++;item.status='running';item.startedAt=new Date().toISOString();audit('plan_item_running',{planItemId:item.id,targetAssetId:item.targetAssetId,referenceIds:item.referenceIds});persist();emit('plan_item',`正在制作 ${item.order}/${plan.items.length}：${item.purpose}`,{itemId:item.id,status:'running'});
  const style=plan.styleAnalysis?`\n风格分析（只迁移抽象特征）：${JSON.stringify(plan.styleAnalysis)}`:'';
  const child={...job,originalText:item.aspectRatio?`最终画幅 ${item.aspectRatio}`:job.text,text:`用户原始需求：${job.text}\n本张作品用途：${item.purpose}\n核心卖点：${item.sellingPoint||'按真实产品信息呈现'}\n视觉方向：${item.visualDirection}${style}\n相对参考图必须变化的画面：${item.newComposition||'构图、机位和场景叙事应有明显变化，不复刻参考图'}\n${item.aspectRatio?`最终画幅比例：${item.aspectRatio}。` : ''}请只处理这一张图片，保留用户明确指定的画面和文字要求。`,selection:[...(item.targetAssetId?[item.targetAssetId]:[]),...(item.referenceIds.length?item.referenceIds:job.selection)],planItem:{id:item.id,purpose:item.purpose,sellingPoint:item.sellingPoint,visualDirection:item.visualDirection,newComposition:item.newComposition,newScene:item.newScene,newCamera:item.newCamera,styleAnalysis:plan.styleAnalysis,styleExtension:styleExtension(job.text),targetAssetId:item.targetAssetId},taskLimitFen:TASK_BUDGET_FEN,usage:job.usage};
  if(job.executionRevision){child.taskContext={...job.taskContext,latestRevision:job.executionRevision,latestDesignRevision:job.executionRevision,designRevisions:[job.executionRevision],constraints:[],confirmedRevision:job.executionRevision.status==='confirmed'?job.executionRevision:null};}
  const itemEmit=(type,text,detail={})=>emit(type,text,{...detail,planItemId:item.id});
  try{
   validateImageExecutionContext(project,child,item,dataDir);
   const boundSnapshot=buildContextSnapshot(project,child);
   const executionSnapshot=job.executionRevision?{...boundSnapshot,recentTurns:[],taskCandidates:[],confirmedPlans:[]}:boundSnapshot;
   trace('execution_context_ready',{planItemId:item.id,selectedIds:executionSnapshot.current.selectedIds,referenceIds:item.referenceIds,targetAssetId:item.targetAssetId||null,sourceRevisionId:job.executionRevisionId||null});
   await runAgent({project,job:child,contextSnapshot:executionSnapshot,env,budget,dataDir,emit:itemEmit,persist,fetcher,signal,audit,trace});check();
   const asset=project.assets.find(a=>a.source?.jobId===job.id&&a.source?.planItemId===item.id&&(!item.targetAssetId||a.source?.parentAssetId===item.targetAssetId));
   if(!asset||!imageExists(dataDir,asset.versions.at(-1)?.image))throw Error('本张未交付可读取的图片文件');
   item.assetId=asset.id;item.status='completed';item.completedAt=new Date().toISOString();item.technicalCheck='file_present';item.quality='not_evaluated';item.qualityFlags=exactDuplicateFlags(project,item,asset,dataDir);trace('file_check',{planItemId:item.id,assetId:asset.id,image:asset.versions.at(-1)?.image,result:'file_present',qualityFlags:item.qualityFlags});
   if(item.qualityFlags.length){job.qualityStatus='review_required';audit('quality_review_required',{planItemId:item.id,flags:item.qualityFlags})}
   audit('plan_item_completed',{planItemId:item.id,assetId:asset.id,version:asset.versions.length,image:asset.versions.at(-1)?.image,quality:'not_evaluated',qualityFlags:item.qualityFlags});emit('plan_item',`已保存：${item.purpose}`,{itemId:item.id,status:'completed',assetId:asset.id,qualityFlags:item.qualityFlags});
  }catch(error){
   check();const saved=project.assets.find(a=>a.source?.jobId===job.id&&a.source?.planItemId===item.id&&(!item.targetAssetId||a.source?.parentAssetId===item.targetAssetId));
   const validSaved=!!saved&&imageExists(dataDir,saved.versions.at(-1)?.image);
   if(validSaved){trace('file_check',{planItemId:item.id,assetId:saved.id,image:saved.versions.at(-1)?.image,result:'file_present_after_later_error',error:error.message});item.assetId=saved.id;item.status='completed';item.technicalCheck='file_present';item.quality='not_evaluated';item.warning=trim(error.message,300);emit('plan_item',`图片已保存，后续步骤中断：${item.purpose}`,{itemId:item.id,status:'completed',assetId:saved.id,warning:item.warning})}
   else{trace('file_check',{planItemId:item.id,assetId:saved?.id||null,image:saved?.versions.at(-1)?.image||null,result:'failed',error:error.message});if(saved&&!imageExists(dataDir,saved.versions.at(-1)?.image))project.assets.splice(project.assets.indexOf(saved),1);item.status='failed';item.error=trim(error.message,300);audit('plan_item_failed',{planItemId:item.id,error:item.error});emit('plan_item',`未完成：${item.purpose}`,{itemId:item.id,status:'failed',reason:item.error})}
   note=`第 ${item.order} 张${validSaved?'已保存但后续步骤中断':'未完成'}：${trim(error.message,300)}`;persist();break;
  }
  job.delivery=deliveryStatus(job);persist();
 }
 job.delivery=deliveryStatus(job);job.technicalStatus=job.delivery.delivered===job.delivery.planned?'completed':job.delivery.delivered?'partial':attempts===0?'pending':'failed';persist();
 if(job.pendingActionId){const {action}=resolvePendingAction(project,job.pendingActionId);if(action){const resultAssetId=plan.items.find(item=>item.status==='completed')?.assetId||null;transitionPendingAction(action,resultAssetId?'completed':'failed',job.id,{resultAssetId,reason:resultAssetId?null:note||'image_not_delivered'});persist()}}
 if(creativeTask){syncTaskDelivery(creativeTask,job);trace('task_state',{taskId:creativeTask.id,status:creativeTask.status,delivered:creativeTask.delivered});persist()}
 const {delivered,planned}=job.delivery;
 if(delivered===planned)return `图片已放到画布。请看一下画面和文字是否符合预期。${note||''}`;
 if(!delivered)return `这次还没有图片放到画布。${note||''}你可以稍后继续。`;
 return `${delivered} 张图片已放到画布。${note||''}还有 ${planned-delivered} 张未完成，可以稍后继续。请看一下已完成图片的画面和文字是否符合预期。`;
}
