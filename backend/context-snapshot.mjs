import {routingTaskCandidates,taskSnapshot} from './task-context.mjs';

const short=(value,limit=3000)=>String(value||'').slice(0,limit);

// One immutable set of facts for both model calls in a job. No image bytes are stored here.
export function buildContextSnapshot(project,job,{turnLimit=6,charLimit=12000}={}){
 const selectedIds=(job.selection||[]).filter(id=>project.uploads?.some(u=>u.id===id)||project.assets?.some(a=>a.id===id));
 const selectedMaterials=selectedIds.map(id=>{
  const upload=project.uploads?.find(u=>u.id===id);
  if(upload)return {id,kind:'upload',role:upload.role||'reference',label:upload.label||''};
  const asset=project.assets?.find(a=>a.id===id);
  return {id,kind:'asset',role:'work',label:asset?.title||'',sourceJobId:asset?.source?.jobId||null};
 });
 const internal=new Set((project.jobs||[]).filter(j=>/^(initial-verification|verification-schema-fixed)/.test(j.requestId||'')).map(j=>j.id));
 const groups=new Map();
 for(const message of project.messages||[]){
  if(!message.jobId||message.jobId===job.id||internal.has(message.jobId))continue;
  if(!groups.has(message.jobId))groups.set(message.jobId,{sourceJobId:message.jobId,userText:'',assistantText:'',materialIds:[],materials:[]});
  const turn=groups.get(message.jobId);
  if(message.role==='user'){
   turn.userText=short(message.text);
   turn.materialIds=[...new Set((message.attachments||[]).map(a=>a.id).filter(Boolean))];
   turn.materials=turn.materialIds.map(id=>{
    const upload=project.uploads?.find(item=>item.id===id);
    if(upload)return {id,kind:'upload',role:upload.role||'reference',label:upload.label||''};
    const asset=project.assets?.find(item=>item.id===id);
    return asset?{id,kind:'asset',role:'work',label:asset.title||''}:null;
   }).filter(Boolean);
  }else if(message.role==='assistant')turn.assistantText=short(message.text);
 }
 const recentTurns=[...groups.values()].filter(t=>t.userText||t.assistantText).slice(-turnLimit);
 let remaining=charLimit;
 for(let i=recentTurns.length-1;i>=0;i--){
  for(const key of ['assistantText','userText']){const value=recentTurns[i][key];recentTurns[i][key]=short(value,Math.max(0,remaining));remaining-=recentTurns[i][key].length}
 }
 const tasks=routingTaskCandidates(project,selectedIds);
 const taskCandidates=(project.creativeTasks||[]).slice(-8).map(taskSnapshot);
 const historicalVisualIds=recentTurns.slice().reverse().flatMap(t=>t.materials||[]).filter(m=>m.kind==='upload'&&!selectedIds.includes(m.id)&&project.uploads?.some(u=>u.id===m.id&&u.kind!=='document')).slice(0,1).map(m=>m.id);
 const designReferences=(project.creativeTasks||[]).flatMap(task=>(task.revisions||[]).filter(revision=>['analysis','design'].includes(revision.kind)).map(revision=>({taskId:task.id,revisionId:revision.id,sourceJobId:revision.jobId,version:revision.version,status:revision.status})));
 const pendingActions=taskCandidates.flatMap(task=>(task.pendingActions||[]).map(action=>({...action,task_id:task.id}))).filter(action=>action.status==='pending');
 const snapshot={schemaVersion:1,projectId:project.id||null,jobId:job.id,current:{text:short(job.text,6000),selectedIds,selectedMaterials},recentTurns,historicalVisualIds,taskCandidates,designReferences,pendingActions,activeTaskId:project.activeCreativeTaskId||null,selectedTaskCandidates:tasks.selectionMatches,confirmedPlans:taskCandidates.filter(t=>t.confirmedRevision).map(t=>({taskId:t.id,revision:t.confirmedRevision})),truncated:remaining<=0};
 return Object.freeze(snapshot);
}

export function resolveSnapshotReference(snapshot,decision){
 const sourceJobId=decision?.sourceJobId;
 if(!sourceJobId)return {ok:true,turn:null};
 const turn=snapshot.recentTurns.find(t=>t.sourceJobId===sourceJobId);
 if(turn)return {ok:true,turn};
 // A saved design revision outlives the short recentTurns window. Validate both
 // IDs against the same task instead of rejecting a correct older reference.
 const revision=snapshot.designReferences?.find(item=>item.taskId===decision.taskId&&item.revisionId===decision.sourceRevisionId&&item.sourceJobId===sourceJobId);
 return revision?{ok:true,turn:null,revision}:{ok:false,reason:'unknown_source_job_id'};
}
