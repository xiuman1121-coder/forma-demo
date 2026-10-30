import {randomUUID} from 'node:crypto';

const ratios=new Set(['auto','1:1','4:3','3:4','16:9','9:16','3:2','2:3']);
const now=()=>new Date().toISOString();

export function createPendingAction(project,task,job,revision,proposal){
 if(!task||!revision||!proposal||proposal.action_type!=='edit_image')throw Error('待执行提议无效');
 const target=project.assets.find(asset=>asset.id===proposal.target_asset_id);
 if(!target||!(task.delivered||[]).some(entry=>entry.assetId===target.id))throw Error('待执行提议的目标作品不存在或不属于当前任务');
 if(!ratios.has(proposal.aspect_ratio))throw Error('待执行提议的画幅比例无效');
 const direction=String(proposal.direction_content||'').trim();
 const options=Array.isArray(proposal.direction_options)?proposal.direction_options.map(value=>String(value||'').trim()).filter(Boolean).slice(0,5):[];
 if(!direction&&options.length<2)throw Error('待执行提议缺少确定方向或候选方向');
 const action={id:randomUUID(),action_type:'edit_image',target_asset_id:target.id,direction_content:direction,aspect_ratio:proposal.aspect_ratio,source_revision_id:revision.id,status:'pending',direction_options:direction?[]:options,task_id:task.id,source_job_id:job.id,execution_job_id:null,result_asset_id:null,created_at:now(),updated_at:now()};
 task.pendingActions??=[];
 for(const older of task.pendingActions)if(older.status==='pending'){older.status='failed';older.failure_reason='superseded';older.updated_at=now()}
 task.pendingActions.push(action);task.updatedAt=now();return action;
}

export function resolvePendingAction(project,id){
 for(const task of project.creativeTasks||[]){const action=(task.pendingActions||[]).find(item=>item.id===id);if(action)return {task,action}}
 return {task:null,action:null};
}

export function validatePendingAction(project,task,action){
 if(!task||!action||action.task_id!==task.id)return 'unknown_pending_action';
 if(action.status!=='pending')return 'pending_action_not_available';
 if(!action.direction_content||action.direction_options?.length)return 'direction_unresolved';
 if(!task.revisions?.some(item=>item.id===action.source_revision_id&&['analysis','design'].includes(item.kind)))return 'source_revision_missing';
 if(!project.assets?.some(item=>item.id===action.target_asset_id))return 'target_asset_missing';
 if(!(task.delivered||[]).some(item=>item.assetId===action.target_asset_id))return 'target_asset_not_in_task';
 if(!ratios.has(action.aspect_ratio))return 'aspect_ratio_invalid';
 return null;
}

export function transitionPendingAction(action,status,jobId,{resultAssetId=null,reason=null}={}){
 if(status==='executing'){
  if(action.status!=='pending')return false;
  action.status='executing';action.execution_job_id=jobId;
 }else{
  if(action.status!=='executing'||action.execution_job_id!==jobId)return false;
  if(!['completed','failed'].includes(status))return false;
  action.status=status;action.result_asset_id=resultAssetId;action.failure_reason=reason;
 }
 action.updated_at=now();return true;
}
