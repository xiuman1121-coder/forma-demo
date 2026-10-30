if(!process.argv.includes('--allow-paid-verification'))throw Error('本脚本会请求生图接口；必须显式传入 --allow-paid-verification。');
// Explicit manual integration check. Real image request, deterministic tool instruction; not an LLM test.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readEnv,readJSON,writeJSON,Budget} from '../backend/core.mjs';
import {runAgent} from '../backend/agent.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url))),dataDir=path.join(base,'.private'),file=path.join(dataDir,'project.json');
const project=readJSON(file,{}),job={id:'image-corrected-check',text:'生图接口验证：温暖咖啡静物',selection:[],usage:[],events:[],status:'running'};
if(project.jobs.some(j=>j.id===job.id))throw Error('已运行过本验证，禁止重复付费调用');
project.jobs.push(job);const persist=()=>writeJSON(file,project);persist();let step=0;
const fetcher=async(url,options)=>{if(!url.includes('bigmodel'))return fetch(url,options);return {ok:true,json:async()=>({choices:[{message:step++===0?{tool_calls:[{id:'verification',type:'function',function:{name:'create_image',arguments:JSON.stringify({prompt:'Warm natural editorial photograph of a ceramic coffee cup on a wooden table, soft morning sunlight, quiet beige background, negative space in the upper half. No text, no logo.',title:'接口验证 · 晨间咖啡',reference_ids:[],edit_asset_id:''})}}]}:{content:'图片工具验证完成（固定测试指令，非模型规划）。'}}]})}};
try{const result=await runAgent({project,job,env:readEnv(path.join(base,'.env.local')),budget:new Budget(path.join(dataDir,'budget.json'),100),dataDir,persist,emit:(type,text)=>{job.events.push({type,text});persist()},fetcher});job.status=job.events.some(e=>e.type==='error')?'failed':'completed';console.log(job.status,JSON.stringify(job.events));}catch(e){job.status='failed';job.error=e.message;console.log(e.message)}finally{persist()}
