import http from 'node:http';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {Budget,readEnv,readJSON,writeJSON,validateLayer,versionAsset} from './backend/core.mjs';
import {runTask,deliveryStatus,revisePlan} from './backend/task.mjs';
import {createDebugTrace} from './backend/debug-trace.mjs';
import {ensureCreativeTasks} from './backend/task-context.mjs';
import {resolvePendingAction,transitionPendingAction} from './backend/pending-action.mjs';
import {zipFiles} from './backend/zip.mjs';
import {createAuth,loginPage} from './backend/auth.mjs';
const defaultBase=path.dirname(fileURLToPath(import.meta.url));
export function createApp({base=defaultBase,dataDir=path.join(base,'.private'),env=readEnv(path.join(base,'.env.local')),port=4173,fetcher=fetch}={}){
const root=path.join(base,'dist'),controllers=new Map();
mkdirSync(path.join(dataDir,'media'),{recursive:true});
const budget=new Budget(path.join(dataDir,'budget.json'),8000);
const auth=createAuth(env),publicOrigin=String(env.FORMA_PUBLIC_ORIGIN||'').replace(/\/$/,'');
if(publicOrigin&&(!publicOrigin.startsWith('https://')||!auth.enabled))throw Error('公网访问必须配置 HTTPS 地址、固定账号、密码哈希和会话密钥');
const loginAttempts=new Map();
const state=readJSON(path.join(dataDir,'project.json'),{brief:'',messages:[],uploads:[],assets:[],jobs:[]});
ensureCreativeTasks(state);
for(const job of state.jobs)if(job.status==='running'||job.status==='pending'&&!job.finishedAt){for(const item of job.plan?.items||[])if(item.status==='running')item.status='pending';job.delivery=deliveryStatus(job);job.status=job.delivery.delivered?'partial':'failed';job.error='服务重启，任务已停止。不会自动重试。';const task=state.creativeTasks.find(item=>item.id===job.creativeTaskId);if(task)task.status=job.status;if(job.pendingActionId){const {action}=resolvePendingAction(state,job.pendingActionId);if(action)transitionPendingAction(action,'failed',job.id,{reason:'server_restarted'})}}
state.id ||= randomUUID();state.archived ||= [];state.trash ||= [];
const persist=()=>writeJSON(path.join(dataDir,'project.json'),state);persist();
const timestamp=value=>{const parsed=Date.parse(value||'');return Number.isFinite(parsed)?parsed:0};
const lastConversationAt=project=>(project.jobs||[]).reduce((latest,job)=>Math.max(latest,timestamp(job.startedAt)),timestamp(project.createdAt));
const snapshot=()=>({project:Object.fromEntries(Object.entries(state).filter(([k])=>k!=='archived'&&k!=='trash')),projects:[state,...state.archived].filter(p=>p.messages?.length||p.uploads?.length||p.assets?.length).sort((a,b)=>lastConversationAt(b)-lastConversationAt(a)||a.id.localeCompare(b.id)).map(p=>({id:p.id,title:p.title||'未命名项目',cover:p.assets?.at(-1)?.versions.at(-1)?.image||p.uploads?.[0]?.url,createdAt:p.createdAt||p.jobs?.[0]?.startedAt||p.assets?.[0]?.versions?.[0]?.at||null})),budget:budget.snapshot(),configured:{brain:!!env.ZHIPU_API_KEY,image:!!env.ARK_API_KEY}});
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.zip':'application/zip'};
async function body(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>32*1024*1024)throw Error('文件过大，图片请小于 8 MB')}let parsed;try{parsed=JSON.parse(data||'{}')}catch{throw Error('请求 JSON 格式无效')}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('请求 JSON 必须是对象');return parsed}
return http.createServer(async(req,res)=>{
 const json=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj))};
 try{
  const allowedOrigins=[`http://127.0.0.1:${port}`,`http://localhost:${port}`,...(publicOrigin?[publicOrigin]:[])];
  if(!allowedOrigins.some(origin=>new URL(origin).host===req.headers.host))return json(403,{error:'访问域名不允许'});
  if(req.headers.origin&&!allowedOrigins.includes(req.headers.origin))return json(403,{error:'来源不允许'});
  const url=new URL(req.url,'http://localhost'),p=decodeURIComponent(url.pathname);
  const secure=Boolean(publicOrigin&&req.headers.host===new URL(publicOrigin).host);
  if(auth.enabled){
   if(p==='/login'&&req.method==='GET'){
    if(auth.verify(req)){res.writeHead(303,{Location:'/studio','Cache-Control':'no-store'});return res.end()}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(loginPage());
   }
   if(p==='/login'&&req.method==='POST'){
    if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')return json(415,{error:'表单格式无效'});
    let input='';for await(const chunk of req){input+=chunk;if(input.length>4096)return json(413,{error:'请求过大'})}
    const key=req.socket.remoteAddress||'unknown',now=Date.now();let attempts=(loginAttempts.get(key)||[]).filter(time=>now-time<15*60*1000);
    if(attempts.length>=8)return json(429,{error:'尝试次数过多，请稍后再试'});
    const form=new URLSearchParams(input);
    if(auth.checkPassword(form.get('email')||'',form.get('password')||'')){loginAttempts.delete(key);res.writeHead(303,{Location:'/studio','Set-Cookie':auth.issue(secure),'Cache-Control':'no-store'});return res.end()}
    attempts.push(now);loginAttempts.set(key,attempts);res.writeHead(401,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(loginPage('邮箱或密码不正确'));
   }
   if(!auth.verify(req)){
    if(p.startsWith('/api/')||p.startsWith('/media/'))return json(401,{error:'请先登录'});
    res.writeHead(303,{Location:'/login','Cache-Control':'no-store'});return res.end();
   }
   if(p==='/logout'&&req.method==='POST'){res.writeHead(303,{Location:'/login','Set-Cookie':auth.clear(secure),'Cache-Control':'no-store'});return res.end()}
  }
  if(p==='/api/state'&&req.method==='GET')return json(200,snapshot());
  if(p.startsWith('/api/')&&req.method==='POST'){
   if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:'需要 JSON'});
   const b=await body(req);if(b.projectId&&b.projectId!==state.id&&p!=='/api/open')return json(409,{error:'项目已切换，请刷新后重试'});const active=state.jobs.find(j=>j.status==='running');
   if(p==='/api/cancel'){
    if(active&&(!b.jobId||b.jobId===active.id)){active.cancelled=true;for(const item of active.plan?.items||[])if(item.status==='running')item.status='pending';active.delivery=deliveryStatus(active);active.status=active.delivery.delivered?'partial':'cancelled';active.finishedAt=new Date().toISOString();const task=state.creativeTasks.find(item=>item.id===active.creativeTaskId);if(task)task.status=active.status;controllers.get(active.id)?.abort();if(active.pendingActionId){const {action}=resolvePendingAction(state,active.pendingActionId);if(action)transitionPendingAction(action,'failed',active.id,{reason:'cancelled'})}state.messages.push({role:'assistant',text:active.delivery.delivered?`已停止，已保存 ${active.delivery.delivered}/${active.delivery.planned} 张作品。`:'已停止。你可以修改需求后继续。',jobId:active.id});persist()}
    return json(200,snapshot());
   }
   if(p==='/api/new'||p==='/api/open'){
    if(p==='/api/open'&&b.id===state.id)return json(200,snapshot());
    if(active)return json(409,{error:'请先等待当前创作完成'});
    const {archived,trash,...current}=state;
    const target=p==='/api/new'?{id:randomUUID(),createdAt:new Date().toISOString(),title:'',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[],activeCreativeTaskId:null}:archived.find(a=>a.id===b.id);
    if(!target)throw Error('项目不存在');
    const rest=archived.filter(a=>a.id!==target.id);if(current.messages.length||current.uploads.length||current.assets.length)rest.unshift(current);
    Object.assign(state,{creativeTasks:[],activeCreativeTaskId:null},target,{archived:rest,trash});ensureCreativeTasks(state);persist();return json(200,snapshot());
   }
   if(p==='/api/delete'){
    if(active)return json(409,{error:'请先等待当前创作完成'});
    const archived=state.archived.filter(a=>a.id!==b.id);
    const {archived:discardArchived,trash:discardTrash,...current}=state;
    const target=b.id===state.id?current:state.archived.find(a=>a.id===b.id);
    if(!target)return json(404,{error:'项目不存在'});
    const next=b.id===state.id?(archived.shift()||{id:randomUUID(),createdAt:new Date().toISOString(),title:'',brief:'',messages:[],uploads:[],assets:[],jobs:[],creativeTasks:[],activeCreativeTaskId:null}):current;
    state.trash.unshift({...structuredClone(target),deletedAt:new Date().toISOString()});
    Object.assign(state,{creativeTasks:[],activeCreativeTaskId:null},next,{archived,trash:state.trash});ensureCreativeTasks(state);persist();return json(200,{...snapshot(),deletedProjectId:b.id});
   }
   if(p==='/api/restore'){
    const target=state.trash.find(a=>a.id===b.id);if(!target)return json(404,{error:'待恢复项目不存在'});
    state.trash=state.trash.filter(a=>a.id!==b.id);const {deletedAt,...restored}=target;state.archived.unshift(restored);persist();return json(200,snapshot());
   }
   if(p==='/api/run'||p==='/api/continue-plan'){
    const previousPlan=p==='/api/continue-plan'?state.jobs.find(j=>j.id===b.jobId&&j.plan?.items?.some(i=>i.status!=='completed')):null;
    if(p==='/api/continue-plan'&&!previousPlan)throw Error('没有待继续的交付计划');
    if(previousPlan){b.text=previousPlan.text;b.selection=previousPlan.selection;b.requestId=b.requestId||randomUUID()}
    const previous=state.jobs.find(j=>j.requestId===b.requestId);if(previous)return json(200,snapshot());
    if(active)return json(409,{error:'请等待当前任务结束'});
    if(!env.ZHIPU_API_KEY)return json(400,{error:'尚未配置智谱 API Key'});
    if(typeof b.text!=='string'||!b.text.trim()||b.text.length>6000||typeof b.requestId!=='string')throw Error('需求格式无效');
    const supplied=Array.isArray(b.selection)?[...new Set(b.selection)]:[];
    if(supplied.some(id=>!state.uploads.some(u=>u.id===id)&&!state.assets.some(a=>a.id===id)))throw Error('参考素材不存在，请重新添加');
    const selection=supplied;
    const job={startedAt:new Date().toISOString(),id:randomUUID(),requestId:b.requestId,text:b.text,explicitSelection:[...selection],selection,status:'pending',events:[],usage:[],technicalStatus:'pending',qualityStatus:'not_evaluated'};
    if(previousPlan){job.plan=revisePlan(previousPlan.plan,[],previousPlan.id);job.creativeTaskId=previousPlan.creativeTaskId||null;}
    state.title ||= b.text.slice(0,24);state.messages.push({role:'user',text:previousPlan?'继续完成交付计划':b.text,jobId:job.id,attachments:previousPlan?[]:supplied.map(id=>state.uploads.find(u=>u.id===id)||{id,url:state.assets.find(a=>a.id===id).versions.at(-1).image,label:state.assets.find(a=>a.id===id).title})});state.jobs.push(job);persist();
    const auditFile=path.join(dataDir,'audit',`${job.id}.json`);
    mkdirSync(path.dirname(auditFile),{recursive:true,mode:0o700});
    const auditRecord={jobId:job.id,projectId:state.id,taskType:null,selectedIds:selection,startedAt:job.startedAt,entries:[]};
    const scrub=value=>{if(typeof value==='string')return value.replaceAll(env.ZHIPU_API_KEY||'__NO_ZHIPU_KEY__','[已隐藏]').replaceAll(env.ARK_API_KEY||'__NO_ARK_KEY__','[已隐藏]').replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g,'[图片数据已隐藏]');if(Array.isArray(value))return value.map(scrub);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(authorization|api.?key|b64_json)/i.test(key)).map(([key,item])=>[key,scrub(item)]));return value};
    const audit=(type,detail={})=>{auditRecord.entries.push({type,at:new Date().toISOString(),...scrub(detail)});writeJSON(auditFile,auditRecord)};
    const trace=createDebugTrace({dataDir,jobId:job.id,projectId:state.id,env});
    audit('task_started',{requestId:job.requestId});
    trace('task_started',{requestId:job.requestId,selection:job.selection,text:job.text,continuedPlanId:previousPlan?.id||null});
    const emit=(type,text,detail={})=>{job.events.push({type,text,...detail,at:new Date().toISOString()});persist()};
    const controller=new AbortController();controllers.set(job.id,controller);
    job.status='running';persist();
    runTask({project:state,job,env,budget,dataDir,emit,persist,fetcher,signal:controller.signal,audit,trace}).then(text=>{if(job.cancelled)return;job.delivery=deliveryStatus(job);state.messages.push({role:'assistant',text,jobId:job.id});job.status=job.needsInput?'pending':job.plan?.items.length?job.technicalStatus:'completed'}).catch(e=>{if(job.cancelled)return;job.delivery=deliveryStatus(job);const imageSaved=job.delivery.delivered||state.assets.some(asset=>asset.source?.jobId===job.id&&asset.versions.some(version=>typeof version.image==='string'&&version.image.startsWith('/media/')));job.status=imageSaved?'partial':'failed';job.technicalStatus=job.status;job.error=e.message;const task=state.creativeTasks.find(item=>item.id===job.creativeTaskId);if(task)task.status=job.status;if(job.pendingActionId){const {action}=resolvePendingAction(state,job.pendingActionId);if(action)transitionPendingAction(action,imageSaved?'completed':'failed',job.id,{resultAssetId:state.assets.find(asset=>asset.source?.jobId===job.id)?.id||null,reason:imageSaved?null:e.message})}state.messages.push({role:'assistant',text:imageSaved?job.delivery.planned?`部分作品已保存到画布，后续处理暂时中断。${job.delivery.delivered}/${job.delivery.planned} 张已交付。`:'图片已生成并保存，后续处理暂时中断。你可以在画布上查看或导出作品。':e.name==='TimeoutError'?'处理时间较长，本次已暂停。你可以稍后继续。':e.message,jobId:job.id})}).finally(()=>{job.finishedAt=new Date().toISOString();controllers.delete(job.id);audit('task_finished',{taskType:job.taskType||null,status:job.status,technicalStatus:job.technicalStatus,delivery:job.delivery,error:job.error||null});trace('task_finished',{status:job.status,technicalStatus:job.technicalStatus,creativeTaskId:job.creativeTaskId||null,delivery:job.delivery,error:job.error||null,usage:job.usage});persist()});
    return json(202,snapshot());
   }
   if(p==='/api/export'){
    const asset=state.assets.find(a=>a.id===b.id);if(!asset)throw Error('作品不存在');
    if(typeof b.data!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.data))throw Error('导出格式无效');
    const bytes=Buffer.from(b.data.split(',')[1],'base64');if(bytes.length>24*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('导出文件无效');
    const name=randomUUID()+'.png';writeFileSync(path.join(dataDir,'media',name),bytes,{mode:0o600});return json(200,{url:'/media/'+name+'?download=1'});
   }
   if(p==='/api/export-selection'){
    if(!Array.isArray(b.files)||b.files.length<2||b.files.length>30)throw Error('请选择 2 至 30 张作品下载');
    const seen=new Set(),files=[];let totalBytes=0;
    for(const item of b.files){
     if(!item||!state.assets.some(a=>a.id===item.id)||seen.has(item.id))throw Error('所选作品无效');seen.add(item.id);
     const match=typeof item.url==='string'&&item.url.match(/^\/media\/([a-f0-9-]+\.png)\?download=1$/);if(!match)throw Error('导出图片无效');
     const name=String(item.name||'').slice(0,120);if(!name.endsWith('.png')||/[\\/\0]/.test(name))throw Error('下载文件名无效');
     const data=readFileSync(path.join(dataDir,'media',match[1]));totalBytes+=data.length;if(totalBytes>120*1024*1024)throw Error('所选图片过大，请分批下载');files.push({name,data});
    }
    const bytes=Buffer.from(await zipFiles(files).arrayBuffer()),name=randomUUID()+'.zip';writeFileSync(path.join(dataDir,'media',name),bytes,{mode:0o600});return json(200,{url:'/media/'+name+'?download=1'});
   }
   if(active)return json(409,{error:'任务执行中，请稍后编辑'});
   if(p==='/api/upload'&&b.kind==='document'){
    if(typeof b.text!=='string'||b.text.length>30000||!b.text.trim())throw Error('文字文件需在 3 万字以内');
    if(!/\.(txt|md)$/i.test(b.label||''))throw Error('支持 TXT、Markdown 文字文件');
    const hash=createHash('sha256').update(b.text).digest('hex');const existing=state.uploads.find(u=>u.hash===hash);
    const upload=existing||{id:randomUUID(),kind:'document',label:String(b.label).slice(0,120),text:b.text,hash};if(!existing)state.uploads.push(upload);persist();return json(200,{...snapshot(),uploadedId:upload.id});
   }else if(p==='/api/role'){
    const upload=state.uploads.find(u=>u.id===b.id&&u.kind==='image');if(!upload)throw Error('图片素材不存在');
    if(!['product','style','reference'].includes(b.role))throw Error('素材角色无效');
    upload.role=b.role;persist();return json(200,snapshot());
   }else if(p==='/api/upload'){
    const m=typeof b.data==='string'&&b.data.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);if(!m)throw Error('只支持 PNG、JPG、WebP');
    const bytes=Buffer.from(m[2],'base64');if(bytes.length>8*1024*1024||bytes.length<12)throw Error('图片大小无效');
    const valid=m[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):m[1]==='jpeg'?bytes[0]===255&&bytes[1]===216:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';if(!valid)throw Error('图片格式无效');
    const hash=createHash('sha256').update(bytes).digest('hex');const existing=state.uploads.find(u=>u.hash===hash||u.url&&createHash('sha256').update(readFileSync(path.join(dataDir,u.url.slice(1)))).digest('hex')===hash);if(existing){persist();return json(200,{...snapshot(),uploadedId:existing.id})}
    const name=randomUUID()+'.'+(m[1]==='jpeg'?'jpg':m[1]);writeFileSync(path.join(dataDir,'media',name),bytes,{mode:0o600});const upload={id:randomUUID(),kind:'image',hash,label:String(b.label||'参考图').slice(0,120),role:['product','style','reference'].includes(b.role)?b.role:'reference',url:'/media/'+name};
    if(typeof b.preview==='string'&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(b.preview)){const previewBytes=Buffer.from(b.preview.split(',')[1],'base64');if(previewBytes.length<1024*1024&&previewBytes[0]===255&&previewBytes[1]===216){const previewName=randomUUID()+'.jpg';writeFileSync(path.join(dataDir,'media',previewName),previewBytes,{mode:0o600});upload.previewUrl='/media/'+previewName}}
    state.uploads.push(upload);persist();return json(200,{...snapshot(),uploadedId:upload.id});
   }else if(p==='/api/edit'){
    const a=state.assets.find(a=>a.id===b.id);if(!a)throw Error('作品不存在');
    if(b.layer)versionAsset(a,{layer:validateLayer(b.layer)});
    if(b.position){if(!Number.isFinite(b.position.x)||!Number.isFinite(b.position.y))throw Error('位置无效');a.x=Math.max(0,Math.min(10000,b.position.x));a.y=Math.max(0,Math.min(10000,b.position.y))}
    if(Number.isInteger(b.restore)){if(!a.versions[b.restore])throw Error('版本不存在');versionAsset(a,a.versions[b.restore])}
   }else return json(404,{error:'接口不存在'});
   persist();return json(200,snapshot());
  }
  if(req.method!=='GET')return json(405,{error:'不支持的方法'});
  let target;
  if(/^\/media\/[a-f0-9-]+\.(png|jpg|webp|zip)$/.test(p))target=path.join(dataDir,p.slice(1));
  else {target=path.resolve(root,'.'+p);if(!target.startsWith(root+path.sep)&&target!==root)return json(403,{error:'路径不允许'});if(p.split('/').some(s=>s.startsWith('.')))return json(403,{error:'路径不允许'});if(p==='/studio'||p==='/')target=path.join(root,'studio.html');else if(!path.extname(p))target=path.join(root,'index.html')}
  const bytes=readFileSync(target);res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store',...(url.searchParams.has('download')?{'Content-Disposition':`attachment; filename=forma-design${path.extname(target)}`}:{})});res.end(bytes);
 }catch(e){json(400,{error:e.code==='ENOENT'?'文件不存在':e.message})}
});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const env=readEnv(path.join(defaultBase,'.env.local'));
 createApp({env}).listen(4173,'127.0.0.1',()=>console.log('Forma: http://127.0.0.1:4173/studio'));
}
