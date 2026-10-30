import {randomUUID} from 'node:crypto';

const now=()=>new Date().toISOString();
const uniq=values=>[...new Set((values||[]).filter(value=>typeof value==='string'))];
const compact=text=>String(text||'').trim().slice(0,3000);

export function ensureCreativeTasks(project){
 if(!Array.isArray(project.creativeTasks))project.creativeTasks=[];
 if(!project.activeCreativeTaskId)project.activeCreativeTaskId=null;
 return project.creativeTasks;
}

export function taskSnapshot(task){
 if(!task)return null;
 const designRevisions=(task.revisions||[]).filter(item=>['analysis','design'].includes(item.kind)).slice(-4);
 return {id:task.id,status:task.status,productIdentity:task.productIdentity||'',productIds:task.productIds||[],referenceIds:task.referenceIds||[],sourceIds:task.sourceIds||[],constraints:task.constraints||[],latestRevision:task.revisions?.findLast(item=>item.kind!=='readback')||null,latestDesignRevision:designRevisions.at(-1)||null,designRevisions,confirmedRevision:task.revisions?.find(item=>item.id===task.confirmedRevisionId)||null,confirmedRevisionId:task.confirmedRevisionId||null,delivered:task.delivered||[],pendingActions:(task.pendingActions||[]).filter(action=>action.status==='pending'),lastJobId:task.lastJobId||null};
}

export function resolveExecutionRevision(task,{sourceRevisionId=null,sourceJobId=null}={}){
 const designs=(task?.revisions||[]).filter(revision=>['analysis','design'].includes(revision.kind));
 if(!designs.length)return {revision:null,reason:'no_design_revision'};
 const explicit=sourceRevisionId?designs.find(revision=>revision.id===sourceRevisionId):null;
 if(sourceRevisionId&&!explicit)return {revision:null,reason:'unknown_source_revision'};
 const sourceMatches=sourceJobId?designs.filter(revision=>revision.jobId===sourceJobId):[];
 if(explicit&&sourceMatches.length&&sourceMatches.some(revision=>revision.id!==explicit.id))return {revision:null,reason:'source_reference_conflict'};
 if(explicit)return {revision:explicit,reason:'explicit_revision_id'};
 if(sourceMatches.length===1)return {revision:sourceMatches[0],reason:'source_job_id'};
 if(designs.length===1)return {revision:designs[0],reason:'single_design_revision'};
 return {revision:null,reason:'ambiguous_design_revision'};
}

export function routingTaskCandidates(project,selection=[]){
 const tasks=ensureCreativeTasks(project);
 const ids=new Set(selection);
 const matches=tasks.filter(task=>task.sourceIds?.some(id=>ids.has(id))||task.delivered?.some(item=>ids.has(item.assetId)));
 const candidates=ids.size?matches:tasks;
 return {candidates:candidates.slice(-8).map(taskSnapshot),selectionMatches:matches.map(task=>task.id),activeTaskId:project.activeCreativeTaskId||null};
}

export function resolveCreativeTask(project,{selection=[],taskId=null,relation='new'}={}){
 const tasks=ensureCreativeTasks(project),ids=new Set(selection);
 const matches=tasks.filter(task=>task.sourceIds?.some(id=>ids.has(id))||task.delivered?.some(item=>ids.has(item.assetId)));
 if(taskId){const task=tasks.find(item=>item.id===taskId);if(!task)return {task:null,reason:'unknown_task_id'};if(ids.size&&matches.length&&!matches.includes(task))return {task:null,reason:'selection_conflicts_with_task'};if((project.uploads||[]).some(upload=>ids.has(upload.id)&&upload.role==='product'&&!task.sourceIds?.includes(upload.id)))return {task:null,reason:'new_product_conflicts_with_task'};return {task,reason:'explicit_task_id'}}
 if(relation==='new')return {task:null,reason:'new_task'};
 if(matches.length===1)return {task:matches[0],reason:'selected_material'};
 if(matches.length>1)return {task:null,reason:'multiple_selected_tasks'};
 if(ids.size)return {task:null,reason:'new_selected_material'};
 if(tasks.length===1)return {task:tasks[0],reason:'single_task'};
 if(tasks.length>1)return {task:null,reason:'multiple_tasks'};
 return {task:null,reason:'no_task'};
}

export function inheritTaskSelection(project,job,task){
 if(!task)return {selection:job.selection||[],source:'current_selection'};
 const chosen=uniq(job.selection);
 const hasNewSource=chosen.some(id=>!task.sourceIds?.includes(id)&&!task.delivered?.some(item=>item.assetId===id));
 if(hasNewSource)return {selection:chosen,source:'current_selection_new_source'};
 const product=task.productIds||[],references=task.referenceIds||[];
 const inherited=uniq([...chosen,...product,...references]).filter(id=>project.uploads.some(item=>item.id===id)||project.assets.some(item=>item.id===id));
 return {selection:inherited,source:chosen.length?'explicit_plus_task':'task_inherited'};
}

export function createCreativeTask(project,job){
 const selection=uniq(job.selection),uploads=selection.map(id=>project.uploads.find(u=>u.id===id)).filter(Boolean);
 const task={id:randomUUID(),createdAt:now(),updatedAt:now(),status:'discussing',productIdentity:'',productIds:uploads.filter(u=>u.role==='product').map(u=>u.id),referenceIds:uploads.filter(u=>u.role!=='product').map(u=>u.id),sourceIds:selection,constraints:[],revisions:[],pendingActions:[],confirmedRevisionId:null,delivered:[],lastJobId:job.id};
 ensureCreativeTasks(project).push(task);project.activeCreativeTaskId=task.id;job.creativeTaskId=task.id;return task;
}

export function recordTaskRevision(task,{job,text,kind='analysis',plan=null}={}){
 const revision={id:randomUUID(),version:(task.revisions?.at(-1)?.version||0)+1,createdAt:now(),jobId:job.id,kind,status:'draft',request:compact(job.text),content:compact(text),plan:plan?structuredClone(plan):null};
 task.revisions??=[];task.revisions.push(revision);task.updatedAt=now();task.lastJobId=job.id;task.status='draft';return revision;
}

export function confirmTaskRevision(task,revisionId){
 const revision=task.revisions?.find(item=>item.id===revisionId);if(!revision)return false;
 revision.status='confirmed';revision.confirmedAt=now();task.confirmedRevisionId=revision.id;task.updatedAt=now();task.status='confirmed';return true;
}

export function approvalForRevision(decision,text,task){
 const revision=taskSnapshot(task)?.latestRevision,approval=decision?.approval;
 if(!revision||!['analysis','design'].includes(revision.kind))return {approved:false,reason:'no_design_revision'};
 if(decision.stage!=='execute'||!['continue','revise'].includes(decision.relation))return {approved:false,reason:'not_existing_task_execution'};
 const quote=typeof approval?.quote==='string'?approval.quote.trim():'';
 if(approval?.intent!=='confirm_existing_revision'||approval.revisionId!==revision.id||!quote||!String(text||'').includes(quote))return {approved:false,reason:'missing_verified_approval_evidence'};
 return {approved:true,revisionId:revision.id,quote};
}

export function approvalForTextRevision(decision,text,task){
 const revision=taskSnapshot(task)?.latestRevision,approval=decision?.approval;
 if(!revision||!['analysis','design'].includes(revision.kind)||revision.status!=='draft')return {approved:false,reason:'no_draft_design_revision'};
 if(!['plan','discuss'].includes(decision?.stage)||!['none','confirm'].includes(decision?.operation)||decision.allowedEffects?.includes('paid_image'))return {approved:false,reason:'not_text_confirmation'};
 const quote=typeof approval?.quote==='string'?approval.quote.trim():'';
 if(approval?.intent!=='confirm_existing_revision'||approval.revisionId!==revision.id||!quote||!String(text||'').includes(quote))return {approved:false,reason:'missing_verified_approval_evidence'};
 return {approved:true,revisionId:revision.id,quote};
}

export function applyTaskMaterialRoles(project,task,selection,materialRoles){
 if(!task)return {productIds:[],styleIds:[],source:'no_task'};
 const selected=new Set(selection||[]),uploads=(project.uploads||[]).filter(item=>selected.has(item.id));
 const allowed=new Set(uploads.filter(item=>item.role==='reference'||!item.role).map(item=>item.id));
 const productIds=new Set(uploads.filter(item=>item.role==='product').map(item=>item.id));
 const styleIds=new Set(uploads.filter(item=>item.role==='style').map(item=>item.id));
 for(const id of Array.isArray(materialRoles?.styleIds)?materialRoles.styleIds:[])if(allowed.has(id))styleIds.add(id);
 for(const id of Array.isArray(materialRoles?.productIds)?materialRoles.productIds:[])if(allowed.has(id)&&!styleIds.has(id))productIds.add(id);
 task.productIds=uniq([...(task.productIds||[]).filter(id=>!styleIds.has(id)),...productIds]);
 task.referenceIds=uniq([...task.referenceIds,...uploads.filter(item=>!productIds.has(item.id)).map(item=>item.id)]);
 task.sourceIds=uniq([...task.sourceIds,...uploads.map(item=>item.id)]);
 task.updatedAt=now();
 return {productIds:[...productIds],styleIds:[...styleIds],source:'upload_role_and_planning'};
}

export function syncTaskDelivery(task,job){
 task.delivered??=[];
 for(const item of job.plan?.items||[]){if(item.status!=='completed'||!item.assetId)continue;
  if(!task.delivered.some(entry=>entry.assetId===item.assetId&&entry.planItemId===item.id))task.delivered.push({assetId:item.assetId,planItemId:item.id,order:item.order,purpose:item.purpose,jobId:job.id});
 }
 task.status=job.technicalStatus==='partial'?'partial':job.technicalStatus==='failed'?'failed':job.delivery?.pending?'partial':'completed';task.updatedAt=now();task.lastJobId=job.id;
}
