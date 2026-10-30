import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,statSync,utimesSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server.mjs';
import {createDebugTrace} from '../backend/debug-trace.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture=readFileSync(path.join(base,'dist/assets/a.png')).toString('base64');

test('Debug Trace 默认关闭；开启后隐藏密钥和图片数据，限制权限并清理旧文件',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-trace-unit-'));
 try{
  createDebugTrace({dataDir:dir,jobId:'disabled',projectId:'p',env:{FORMA_DEBUG_TRACE:'0'}})('test',{secret:'x'});
  assert.equal(existsSync(path.join(dir,'debug-traces')),false);
  const traceDir=path.join(dir,'debug-traces');mkdirSync(traceDir);
  const old=path.join(traceDir,'00000000-0000-0000-0000-000000000000.json');writeFileSync(old,'{}');const stale=new Date(Date.now()-9*24*60*60*1000);utimesSync(old,stale,stale);
  const trace=createDebugTrace({dataDir:dir,jobId:'enabled',projectId:'p',env:{FORMA_DEBUG_TRACE:'1',ZHIPU_API_KEY:'secret-glm-key',ARK_API_KEY:'secret-image-key'}});
  trace('input',{Authorization:'Bearer secret-glm-key',content:`data:image/png;base64,${fixture}`,prompt:'secret-image-key',tool:{function:{arguments:JSON.stringify({image:`data:image/png;base64,${fixture}`})}}});
  const file=path.join(traceDir,'enabled.json'),raw=readFileSync(file,'utf8');
  assert.equal(existsSync(old),false);assert.equal(statSync(traceDir).mode&0o777,0o700);assert.equal(statSync(file).mode&0o777,0o600);
  assert.ok(raw.includes('IMAGE_BASE64_REDACTED'));assert.ok(!raw.includes(fixture));assert.ok(!raw.includes('secret-glm-key'));assert.ok(!raw.includes('secret-image-key'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});

async function scenario(enabled,port){
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-trace-flow-'));
 const calls=[];
 const fetcher=async(url,options)=>{
  const payload=JSON.parse(options.body);calls.push({provider:url.includes('bigmodel')?'glm':'seedream',model:payload.model,prompt:payload.prompt||null});
  if(url.includes('bigmodel')){
   if(!payload.tools)return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({decision:{goal:'制作商品主图',operation:'generate',relation:'new',reason:'用户要求现在制作一张'},mode:'generate',items:[{purpose:'商品主图',sellingPoint:'展示产品',visualDirection:'干净背景',referenceIds:[]}]})}}],usage:{total_tokens:9}})};
   return {ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'call-1',function:{name:'create_image',arguments:JSON.stringify({prompt:'清晰的电商产品图',title:'商品主图',reference_ids:[],text_mode:'none',text_content:[]})}}]}}],usage:{total_tokens:10}})};
  }
  return {ok:true,status:200,json:async()=>({data:[{b64_json:fixture}]})};
 };
 const server=createApp({base,dataDir:dir,port,env:{FORMA_DEBUG_TRACE:enabled?'1':'0',ZHIPU_API_KEY:'mock-glm-secret',ARK_API_KEY:'mock-image-secret'},fetcher});
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const api=async(route,data)=>{const response=await fetch(`http://127.0.0.1:${port}/api/${route}`,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});return response.json()};
 try{
  const upload=await api('upload',{label:'产品.png',data:`data:image/png;base64,${fixture}`});
  await api('run',{text:'请为这个产品制作一张电商主图',selection:[upload.uploadedId],requestId:'trace-regression'});
  let state;for(let i=0;i<100;i++){state=await api('state');if(state.project.jobs.at(-1)?.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10))}
  const job=state.project.jobs.at(-1),traceDir=path.join(dir,'debug-traces');
  const trace=enabled?JSON.parse(readFileSync(path.join(traceDir,`${job.id}.json`),'utf8')):null;
  assert.equal(existsSync(traceDir),enabled);
  return {status:job.status,delivery:job.delivery,assets:state.project.assets.length,calls,trace,rawTrace:enabled?readFileSync(path.join(traceDir,`${job.id}.json`),'utf8'):null};
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})}
}

test('Mock 主流程的 Trace 串起七站且不改变调用顺序、Prompt 或交付结果',async()=>{
 const off=await scenario(false,4217),on=await scenario(true,4218);
 assert.equal(on.status,'completed');assert.equal(on.status,off.status);assert.deepEqual(on.delivery,off.delivery);assert.equal(on.assets,off.assets);assert.deepEqual(on.calls,off.calls);
 const stages=on.trace.events.map(event=>event.stage);
 for(const stage of ['routing','planning_input','planning_output','validation_result','routing_final','agent_input','agent_tool_call','prompt_assembly','seedream_request','seedream_result','file_check','task_finished'])assert.ok(stages.includes(stage),stage);
 const itemId=on.trace.events.find(event=>event.stage==='validation_result').processedPlan.items[0].id;
 assert.ok(on.trace.events.filter(event=>['agent_tool_call','prompt_assembly','seedream_result','file_check'].includes(event.stage)).every(event=>event.planItemId===itemId));
 assert.ok(on.trace.events.find(event=>event.stage==='planning_input').messages[0].content.includes('设计交付规划器'));
 assert.ok(on.trace.events.find(event=>event.stage==='agent_input').availableTools.some(tool=>tool.function.name==='create_image'));
 const handoff=on.trace.events.find(event=>event.stage==='prompt_assembly');
 assert.equal(handoff.textMode,'none');
 assert.ok(handoff.afterPrompt.startsWith(handoff.beforePrompt));
 assert.ok(!on.rawTrace.includes(fixture));assert.ok(!on.rawTrace.includes('mock-glm-secret'));assert.ok(!on.rawTrace.includes('mock-image-secret'));
});
