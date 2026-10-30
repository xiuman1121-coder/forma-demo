// P0 routing contract. taskContext is an explicit P1-A seam, not inferred history.
import {routingTaskCandidates} from './task-context.mjs';
export function buildRoutingContext({project,job,taskContext=null}){
 const taskCandidates=routingTaskCandidates(project,job.selection||[]);
 return {
  currentRequest:job.text,
  selectedIds:[...(job.selection||[])],
  selectedMaterials:(job.selection||[]).map(id=>{
   const upload=project.uploads.find(item=>item.id===id);
   if(upload)return {id,kind:'upload',role:upload.role||'reference',label:upload.label};
   const asset=project.assets.find(item=>item.id===id);
   return asset?{id,kind:'asset',title:asset.title,versionCount:asset.versions.length}:null;
  }).filter(Boolean),
  continuedPlan:job.plan?{version:job.plan.version,mode:job.plan.mode,revisionOf:job.plan.revisionOf||null}:null,
  taskContext,
  taskCandidates
 };
}

function leadingJsonEnd(raw){
 if(!raw.startsWith('{'))return -1;
 let depth=0,quoted=false,escaped=false;
 for(let i=0;i<raw.length;i++){
  const char=raw[i];
  if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue}
  if(char==='"'){quoted=true;continue}
  if(char==='{')depth++;
  else if(char==='}'&&--depth===0)return i+1;
 }
 return -1;
}

export function parsePlanningJSON(content,{onRecovery=()=>{}}={}){
 const raw=String(content||'').trim().replace(/^```(?:json)?\s*|\s*```$/g,'').trim();
 try{return JSON.parse(raw)}catch(originalError){
  try{
   const parts=JSON.parse(`[${raw}]`);
   if(parts.length<2||parts.length>3||parts.some(part=>!part||Array.isArray(part)||typeof part!=='object'))throw originalError;
   const merged={};
   for(const part of parts)for(const [key,value] of Object.entries(part)){
    if(Object.hasOwn(merged,key))throw originalError;
    merged[key]=value;
   }
   return merged;
  }catch{
   const end=leadingJsonEnd(raw);
   if(end>0){
    const suffix=raw.slice(end);
    if(/^\s*\n\s*\n[^\s{\[]/.test(suffix)){
     try{
      const parsed=JSON.parse(raw.slice(0,end));
      // Only a read decision may discard extra prose. Never derive write or image permission from a malformed response.
      if(parsed?.decision?.operation==='read'&&parsed.mode==='conversation'){
       onRecovery({kind:'read_json_with_trailing_text',discardedChars:suffix.length});
       return parsed;
      }
     }catch{}
    }
   }
   const error=Error('规划模型返回无效 JSON，未保存方案或调用生图；请重试。');error.code='PLANNING_JSON_INVALID';throw error;
  }
 }
}

export function decisionFromPlanning(message,{onRecovery}={}){
 let parsed=parsePlanningJSON(message?.content,{onRecovery});
 const textOperations=['read','draft','revise','confirm','clarify'];
 if(!parsed.decision&&parsed.mode===undefined&&textOperations.includes(parsed.operation)){
  parsed={decision:parsed,mode:'conversation'};
  onRecovery?.({kind:'text_decision_without_envelope'});
 }else if(parsed.decision&&parsed.mode===undefined&&textOperations.includes(parsed.decision.operation)){
  parsed={...parsed,mode:'conversation'};
  onRecovery?.({kind:'text_decision_without_mode'});
 }
 const proposed=parsed.decision;
 if(!proposed){
  // Existing GLM fixtures and older responses use mode only. Keep them executable,
  // but record the compatibility source so they are not mistaken for P0 decisions.
 const mode=parsed.mode==='images'?(parsed.items?.some(item=>item.targetAssetId)?'edit':'generate'):parsed.mode;
 if(!['conversation','generate','edit'].includes(mode))throw Error('交付计划类型无效');
  return {parsed,decision:authorizeTaskDecision({version:1,goal:'',stage:mode==='conversation'?'discuss':'execute',operation:mode==='conversation'?'read':mode,relation:'new',source:'legacy_plan',reason:'旧版 Planning 仅提供 mode，按操作推导权限'})};
 }
 const {goal='',stage:legacyStage,operation,relation='new',reason,blockingQuestion,taskId,sourceJobId,sourceRevisionId,pendingActionId,confirmPreviousPlan,approval,materialRoles,responseType}=proposed;
 if(!['none','read','draft','revise','confirm','generate','edit','crop_grid','clarify'].includes(operation)||!['new','continue','revise','unresolved'].includes(relation))throw Error('Routing 决策结构无效，未执行图像工具。');
 const normalizedOperation=operation==='none'?'read':operation;
 const stage=normalizedOperation==='clarify'?'clarify':['generate','edit','crop_grid'].includes(normalizedOperation)?'execute':['draft','revise','confirm'].includes(normalizedOperation)||responseType==='analysis'||responseType==='plan'||legacyStage==='plan'?'plan':'discuss';
 if(stage==='clarify'&&!String(blockingQuestion||'').trim())throw Error('澄清请求缺少具体问题，未执行图像工具。');
 if(stage==='execute'&&relation==='unresolved')throw Error('任务关联不明确，未执行图像工具。');
 const proposal={version:2,goal:String(goal).slice(0,300),stage,operation:normalizedOperation,relation,source:'planning_glm',reason:typeof reason==='string'?reason.slice(0,300):'',blockingQuestion:stage==='clarify'?String(blockingQuestion).slice(0,300):null,taskId:typeof taskId==='string'?taskId:null,sourceJobId:typeof sourceJobId==='string'?sourceJobId:null,sourceRevisionId:typeof sourceRevisionId==='string'?sourceRevisionId:null,pendingActionId:typeof pendingActionId==='string'?pendingActionId:null,confirmPreviousPlan:confirmPreviousPlan===true,approval:approval&&typeof approval==='object'?{intent:approval.intent,revisionId:approval.revisionId,quote:approval.quote}:null,materialRoles:materialRoles&&typeof materialRoles==='object'?{productIds:materialRoles.productIds,styleIds:materialRoles.styleIds}:null};
 const decision=normalizedOperation==='confirm'?{...proposal,allowedEffects:['read'],authorizationSource:'pending_confirmation'}:authorizeTaskDecision(proposal);
 return {parsed,decision};
}

export const permitsPaidImage=decision=>decision?.stage==='execute'&&decision.allowedEffects?.includes('paid_image')&&['generate','edit'].includes(decision.operation);

// The model proposes an operation and effects. This contract is the sole authority
// for task mutations and tools; stage alone never grants a write capability.
export function authorizeTaskDecision(proposal,{confirmedApproval=false}={}){
 const candidate=proposal?.operation==='none'?'read':proposal?.operation;
 const operation=confirmedApproval?'confirm':candidate;
 const effects=['read'];
 if(operation==='draft'&&proposal.stage==='plan')effects.push('save_draft');
 if(operation==='revise'&&proposal.stage==='plan')effects.push('save_draft','save_brief');
 if(operation==='confirm'&&confirmedApproval&&['plan','discuss','execute'].includes(proposal.stage))effects.push('confirm_revision');
 if(['generate','edit'].includes(operation)&&proposal.stage==='execute')effects.push('paid_image','save_draft','save_brief','asset_write');
 if(operation==='crop_grid'&&proposal.stage==='execute')effects.push('local_image','save_draft');
 const authorized=operation==='confirm'?effects.includes('confirm_revision'):operation==='read'||operation==='clarify'||operation==='draft'||operation==='revise'? !['draft','revise'].includes(operation)||effects.includes('save_draft'):operation==='crop_grid'?effects.includes('local_image'):effects.includes('paid_image');
 return {...proposal,operation:authorized?operation:'read',allowedEffects:authorized?effects:['read'],authorizationSource:authorized?'code_contract':'denied_by_code_contract'};
}

export function permitsEffect(decision,effect){return !!decision?.allowedEffects?.includes(effect)}
export function requireEffect(decision,effect){if(!permitsEffect(decision,effect))throw Error(`当前任务未授权 ${effect}，未修改项目数据或调用工具。`)}
