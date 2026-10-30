import {createHash} from 'node:crypto';
import {buildPlanningInput} from './task.mjs';

const string={type:'string'};
const styleProperties=Object.fromEntries(['palette','lighting','mood','material','sourceScene','productIdentity','preserve','avoidCopy'].map(key=>[key,string]));
const itemProperties={purpose:string,sellingPoint:string,visualDirection:string,newScene:string,newCamera:string,newComposition:string,referenceIds:{type:'array',items:string},targetAssetId:{type:['string','null']}};
export const planningSchema={
 type:'object',additionalProperties:false,required:['mode','styleAnalysis','items'],
 properties:{
  mode:{type:'string',enum:['conversation','generate','edit']},
  styleAnalysis:{anyOf:[{type:'object',additionalProperties:false,required:Object.keys(styleProperties),properties:styleProperties},{type:'null'}]},
  items:{type:'array',items:{type:'object',additionalProperties:false,required:Object.keys(itemProperties),properties:itemProperties}}
 }
};

const secretPattern=/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+)\b/g;
function scrub(value,secrets){
 if(typeof value==='string'){
  let cleaned=value.replace(secretPattern,'[redacted]').replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g,'[image data omitted]');
  for(const secret of secrets)if(secret)cleaned=cleaned.replaceAll(secret,'[redacted]');
  return cleaned;
 }
 if(Array.isArray(value))return value.map(item=>scrub(item,secrets));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(authorization|api.?key|b64_json)/i.test(key)).map(([key,item])=>[key,scrub(item,secrets)]));
 return value;
}
export function summarizePlanningInput({messages,selectedIds}){
 const content=messages[1].content;
 return {systemPromptSha256:createHash('sha256').update(messages[0].content).digest('hex'),userTextSha256:createHash('sha256').update(content[0].text).digest('hex'),selectedIds,imageInputs:content.filter(part=>part.type==='image_url').map(part=>({sha256:createHash('sha256').update(part.image_url.url).digest('hex')})),documentCount:content.filter(part=>part.type==='text').length-1};
}
function asOpenAIInput(messages){
 return messages.map(message=>message.role==='system'?{role:'system',content:[{type:'input_text',text:message.content}]}:{role:'user',content:message.content.map(part=>part.type==='text'?{type:'input_text',text:part.text}:{type:'input_image',image_url:part.image_url.url})});
}
function responseText(data){
 if(typeof data.output_text==='string'&&data.output_text)return data.output_text;
 return (data.output||[]).flatMap(item=>item.content||[]).filter(part=>part.type==='output_text').map(part=>part.text||'').join('');
}
export async function comparePlanning({provider,project,job,dataDir,env={},fetcher=fetch,now=()=>performance.now(),signal}){
 if(!['glm','gpt'].includes(provider))throw Error('provider 必须是 glm 或 gpt');
 const key=provider==='gpt'?env.OPENAI_API_KEY:env.ZHIPU_API_KEY;
 if(!key)throw Error(provider==='gpt'?'尚未配置 OPENAI_API_KEY':'尚未配置 ZHIPU_API_KEY');
 const model=provider==='gpt'?env.OPENAI_PLANNING_MODEL:'glm-4.6v-flash';
 if(!model)throw Error('请先配置 OPENAI_PLANNING_MODEL');
 const input=buildPlanningInput({project,job,dataDir});
 const body=provider==='glm'
  ?{model,messages:input.messages,max_tokens:2800,thinking:{type:'disabled'},stream:false}
  :{model,input:asOpenAIInput(input.messages),text:{format:{type:'json_schema',name:'forma_planning',strict:true,schema:planningSchema}},max_output_tokens:2800,store:false};
 const url=provider==='glm'?'https://open.bigmodel.cn/api/paas/v4/chat/completions':'https://api.openai.com/v1/responses';
 const started=now();
 const response=await fetcher(url,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal||AbortSignal.timeout(90000)});
 const durationMs=Math.round(now()-started);
 if(!response.ok){
  const failure=await response.json().catch(()=>({}));
  const code=String(failure?.error?.code||failure?.code||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);
  throw Error(`${provider} Planning HTTP ${response.status}${code?' ('+code+')':''}`);
 }
 const data=await response.json();
 const rawReply=provider==='glm'?String(data.choices?.[0]?.message?.content||''):responseText(data);
 const refusal=provider==='gpt'?(data.output||[]).flatMap(item=>item.content||[]).find(part=>part.type==='refusal')?.refusal:null;
 let plan=null,parseError=null;
 if(!rawReply)parseError=refusal?'模型拒绝回答':'模型未返回文字';
 else try{plan=JSON.parse(rawReply.replace(/^```(?:json)?\s*|\s*```$/g,'').trim())}catch{parseError='规划结果不是完整 JSON'}
 return scrub({provider,model,jobId:job.id,projectId:project.id,input:summarizePlanningInput(input),rawReply,plan,parseError,refusal:refusal||null,durationMs,usage:data.usage||null,responseId:data.id||null,finishReason:provider==='glm'?data.choices?.[0]?.finish_reason||null:data.status||null},[env.OPENAI_API_KEY,env.ZHIPU_API_KEY,env.ARK_API_KEY]);
}
