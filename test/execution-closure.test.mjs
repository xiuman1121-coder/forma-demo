import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Budget} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const image=readFileSync(path.join(base,'dist/assets/a.png'));
const assetId='11111111-1111-4111-8111-111111111111';
const original='/media/22222222-2222-4222-8222-222222222222.png';
const item=(targetAssetId=null)=>({id:'plan-item',order:1,purpose:'产品视觉',sellingPoint:'',visualDirection:'清晰',referenceIds:[],targetAssetId,status:'pending',assetId:null,error:null});
const asset=()=>({id:assetId,title:'产品主图',versions:[{image:original,layer:{text:'',x:8,y:12,size:56,color:'#ffffff'}}],source:{referenceIds:[]}});
const reply=message=>({ok:true,json:async()=>({choices:[{message}]})});
const toolCall=(name,args)=>({tool_calls:[{id:'call-1',function:{name,arguments:JSON.stringify(args)}}]});

async function setup({edit=false,text='请生成产品图片',selected=edit?[assetId]:[],fetcher,deleteOnResult=false,planned=true}={}){
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-closure-'));mkdirSync(path.join(dir,'media'));writeFileSync(path.join(dir,original.slice(1)),image);
 const project={brief:'',messages:[],uploads:[],assets:edit?[asset()]:[],jobs:[]};
 const job={id:'job-1',text,selection:selected,usage:[],events:[],plan:planned?{version:1,mode:edit?'edit':'generate',items:[item(edit?assetId:null)]}:null};
 const entries=[];const emit=(type,message,detail={})=>{job.events.push({type,message,...detail});if(deleteOnResult&&type==='result'&&detail.tool==='create_image')unlinkSync(path.join(dir,detail.result.image.slice(1)))};
 const run=()=>runTask({project,job,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,emit,persist:()=>{},fetcher,audit:(type,detail)=>entries.push({type,...detail})});
 return {dir,project,job,entries,run,close:()=>rmSync(dir,{recursive:true,force:true})};
}

test('明确要求改图但 LLM 两次只回复文字：受限纠正后失败且不调用生图',async()=>{
 let calls=0;const ctx=await setup({edit:true,fetcher:async url=>{if(url.includes('volces'))calls++;return reply({content:'我已经修改好了。'})}});
 try{const answer=await ctx.run();assert.equal(calls,0);assert.equal(ctx.job.plan.items[0].status,'failed');assert.match(answer,/未完成/);assert.equal(ctx.entries.filter(e=>e.type==='tool_missing').length,1)}finally{ctx.close()}
});

test('选中作品修改：模型给出别的 ID 时拒绝，不静默改写目标',async()=>{
 let imageCalls=0;const ctx=await setup({edit:true,fetcher:async(url,opt)=>{if(url.includes('volces')){imageCalls++;return {ok:true,json:async()=>({data:[{b64_json:image.toString('base64')}]})}}const body=JSON.parse(opt.body);return reply(body.messages.some(m=>m.role==='tool')?{content:'已完成'}:toolCall('edit_image',{asset_id:'wrong-id',prompt:'改成浅蓝色背景',reference_ids:[],text_mode:'none',text_content:[]}))}});
 ctx.project.assets[0].versions[0].layer.text='旧作品的可编辑字层';
 try{await ctx.run();assert.equal(imageCalls,0);assert.equal(ctx.project.assets.length,1);assert.equal(ctx.project.assets[0].versions.length,1);assert.equal(ctx.project.assets[0].versions[0].layer.text,'旧作品的可编辑字层');assert.match(ctx.job.plan.items[0].error,/目标不一致/)}finally{ctx.close()}
});

test('未选作品且项目有多个候选：询问用户，不默认最新作品',async()=>{
 let imageCalls=0;const ctx=await setup({edit:true,planned:false,selected:[],text:'请修改图片背景',fetcher:async url=>{if(url.includes('volces'))imageCalls++;return reply({content:JSON.stringify({mode:'edit',items:[{purpose:'改背景',referenceIds:[],targetAssetId:null}]})})}});
 ctx.project.assets.push({...asset(),id:'33333333-3333-4333-8333-333333333333',title:'另一张'});
 try{assert.match(await ctx.run(),/选择要修改的作品/);assert.equal(imageCalls,0);assert.equal(ctx.job.needsInput,'target_asset')}finally{ctx.close()}
});

test('图像工具返回失败：计划项失败并记录工具错误',async()=>{
 const ctx=await setup({fetcher:async(url,opt)=>url.includes('volces')?{ok:false,status:500,json:async()=>({error:{message:'mock failure'}})}:reply(toolCall('create_image',{prompt:'一张产品图',title:'主图',reference_ids:[],text_mode:'none',text_content:[]}))});
 try{await ctx.run();assert.equal(ctx.job.plan.items[0].status,'failed');assert.ok(ctx.entries.some(e=>e.type==='tool_failed'&&e.tool==='create_image'))}finally{ctx.close()}
});

test('规划为修改时拒绝模型误选新图工具，不发送付费请求',async()=>{
 let imageCalls=0;const ctx=await setup({edit:true,fetcher:async url=>{if(url.includes('volces'))imageCalls++;return reply(toolCall('create_image',{prompt:'错误的新图调用',title:'误建作品',reference_ids:[],text_mode:'none',text_content:[]}))}});
 try{await ctx.run();assert.equal(imageCalls,0);assert.equal(ctx.project.assets.length,1);assert.equal(ctx.project.assets[0].versions.length,1);assert.equal(ctx.job.plan.items[0].status,'failed')}finally{ctx.close()}
});

test('普通对话不能绕过任务类型调用付费生图',async()=>{
 let imageCalls=0;const ctx=await setup({planned:false,text:'解释一下这张产品图可以怎么优化',fetcher:async(url,opt)=>{if(url.includes('volces'))imageCalls++;const body=JSON.parse(opt.body);return reply(body.tools?toolCall('create_image',{prompt:'误调用',title:'误建',reference_ids:[],text_mode:'none',text_content:[]}):{content:'{"mode":"conversation"}'})}});
 try{await assert.rejects(ctx.run(),/普通对话不能执行付费生图工具/);assert.equal(imageCalls,0);assert.equal(ctx.project.assets.length,0);assert.equal(ctx.job.taskType,'conversation')}finally{ctx.close()}
});

test('用户明确先不要生图时直接分析图片，不请求 JSON 规划或付费生图',async()=>{
 const uploadId='77777777-7777-4777-8777-777777777777';let calls=0,imageCalls=0;
 const ctx=await setup({planned:false,selected:[uploadId],text:'我想为运动水杯制作 Amazon Listing 图片。请先不要生成图片，分析可见特征和待确认卖点。',fetcher:async(url,opt)=>{
  if(url.includes('volces')){imageCalls++;throw Error('不应调用图像模型')}
  calls++;const body=JSON.parse(opt.body);if(!body.tools)return reply({content:JSON.stringify({decision:{goal:'分析运动水杯',operation:'read',relation:'new',responseType:'analysis',reason:'暂不生图'},mode:'conversation'})});assert.ok(body.tools.every(t=>!['create_image','edit_image','edit_text'].includes(t.function.name)));
  assert.ok(body.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='image_url')));
  return reply({content:'从图中可见透明杯身、白色杯盖和提手，产品整体以清爽运动风格为主。容量、防漏性能、材质认证和保温能力无法仅从照片确认，需要你提供真实规格；规划 Listing 卖点时应先使用可观察到的外观特征。'});
 }});
 ctx.project.uploads.push({id:uploadId,kind:'image',role:'product',label:'运动水杯',url:original});
 try{const answer=await ctx.run();assert.match(answer,/容量、防漏性能.*无法仅从照片确认/);assert.equal(ctx.job.taskType,'conversation');assert.equal(calls,2);assert.equal(imageCalls,0);assert.equal(ctx.project.assets.length,0)}finally{ctx.close()}
});

test('上传风格参考图要求再延展两张：归为新图任务并逐张交付',async()=>{
 const uploadId='44444444-4444-4444-8444-444444444444';let imageCalls=0;
 const ctx=await setup({planned:false,selected:[uploadId],text:'这个是我的电商视觉图，提取一下这里面的风格特征，延展出来多两张图。',fetcher:async(url,opt)=>{
  if(url.includes('volces')){imageCalls++;return {ok:true,json:async()=>({data:[{b64_json:image.toString('base64')}]})}}
  const body=JSON.parse(opt.body);
  if(!body.tools)return reply({content:JSON.stringify({mode:'generate',styleAnalysis:{palette:'米色与暖棕',lighting:'柔和暖光',mood:'安静自然',material:'哑光石材',sourceScene:'浴室台面',productIdentity:'棕色玻璃瓶、黑色泵头、米色标签',composition:'原图为产品近景',preserve:'色光与产品外观',avoidCopy:'不重复原图机位'},items:[{purpose:'风格延展图一',visualDirection:'提取参考图的材质与光线',newScene:'窗边书桌',newCamera:'侧面中景',newComposition:'产品置于窗边木桌，背景是开阔窗景与留白',referenceIds:[uploadId],targetAssetId:null},{purpose:'风格延展图二',visualDirection:'在同一风格下换构图',newScene:'卧室床头',newCamera:'俯拍近景',newComposition:'产品置于床头柜，与书本形成对角线构图',referenceIds:[uploadId],targetAssetId:null}]})});
  return reply(body.messages.some(m=>m.role==='tool')?{content:'已保存'}:toolCall('create_image',{prompt:'沿用上传图的视觉语言，创作新的独立画面',title:'风格延展',reference_ids:[uploadId],text_mode:'none',text_content:[]}));
 }});
 ctx.project.uploads.push({id:uploadId,kind:'image',role:'style',label:'电商视觉图',url:original});
 try{await ctx.run();assert.equal(ctx.job.taskType,'generate');assert.equal(ctx.job.plan.items.length,2);assert.equal(ctx.job.delivery.delivered,2);assert.equal(imageCalls,2);assert.equal(ctx.project.assets.length,2);assert.ok(ctx.project.assets.every(a=>a.source.referenceIds.includes(uploadId)));assert.ok(ctx.entries.some(e=>e.type==='image_request'&&e.prompt.includes('必须保持的产品外观事实')))}finally{ctx.close()}
});

test('风格延展未分析风格或规划新构图时不发送付费生图请求',async()=>{
 const uploadId='55555555-5555-4555-8555-555555555555';let imageCalls=0;
 const ctx=await setup({planned:false,selected:[uploadId],text:'分析这张图的视觉风格，然后延展两张新图',fetcher:async url=>{if(url.includes('volces'))imageCalls++;return reply({content:JSON.stringify({mode:'generate',items:[{purpose:'延展一',referenceIds:[uploadId]},{purpose:'延展二',referenceIds:[uploadId]}]})})}});
 ctx.project.uploads.push({id:uploadId,kind:'image',role:'style',label:'风格图',url:original});
 try{await assert.rejects(ctx.run(),/风格延展计划未明确保留的产品结构/);assert.equal(imageCalls,0);assert.equal(ctx.project.assets.length,0)}finally{ctx.close()}
});

test('原场景微调计划先被拒绝并只重规划一次，生图 Prompt 保留 Agent 设计与产品结构',async()=>{
 const uploadId='66666666-6666-4666-8666-666666666666';let planningCalls=0,imageCalls=0;
 const baseStyle={palette:'暖橙与米白',lighting:'左侧柔和自然光',mood:'中世纪复古',material:'木质格栅',sourceScene:'客厅',productIdentity:'红色边柜，上方开放层，下方双门格栅，黑色细腿'};
 const first={mode:'generate',styleAnalysis:baseStyle,items:[{purpose:'电商主图',newScene:'客厅',newCamera:'略偏右',newComposition:'植物与沙发位置微调',referenceIds:[uploadId]}]};
 const corrected={mode:'generate',styleAnalysis:baseStyle,items:[{purpose:'电商主图',newScene:'明亮玄关',newCamera:'正面远景',newComposition:'边柜置于独立玄关墙前，人物与窗框形成新的空间层次',referenceIds:[uploadId]}]};
 const ctx=await setup({planned:false,selected:[uploadId],text:'提取这个产品图的视觉风格，延展一张新的电商主图',fetcher:async(url,opt)=>{
  if(url.includes('volces')){imageCalls++;return {ok:true,json:async()=>({data:[{b64_json:image.toString('base64')}]})}}
  const body=JSON.parse(opt.body);if(!body.tools)return reply({content:JSON.stringify(++planningCalls===1?first:corrected)});
  return reply(body.messages.some(m=>m.role==='tool')?{content:'已保存'}:toolCall('create_image',{prompt:'明亮玄关，边柜置于独立墙前，正面远景。',title:'边柜主图',reference_ids:[uploadId],text_mode:'none',text_content:[]}));
 }});
 ctx.project.uploads.push({id:uploadId,kind:'image',role:'product',label:'边柜图',url:original});
 try{await ctx.run();assert.equal(planningCalls,2);assert.equal(imageCalls,1);assert.ok(ctx.entries.some(e=>e.type==='plan_rejected'));const prompt=ctx.entries.find(e=>e.type==='image_request').prompt;assert.match(prompt,/上方开放层，下方双门格栅/);assert.ok(prompt.startsWith('明亮玄关，边柜置于独立墙前，正面远景。'));assert.doesNotMatch(prompt,/原客厅植物和沙发略微调整/)}finally{ctx.close()}
});

test('工具返回成功但图片文件丢失：交付检查失败',async()=>{
 const ctx=await setup({deleteOnResult:true,fetcher:async(url,opt)=>url.includes('volces')?{ok:true,json:async()=>({data:[{b64_json:image.toString('base64')}]})}:reply(JSON.parse(opt.body).messages.some(m=>m.role==='tool')?{content:'完成'}:toolCall('create_image',{prompt:'一张产品图',title:'主图',reference_ids:[],text_mode:'none',text_content:[]}))});
 try{await ctx.run();assert.equal(ctx.job.plan.items[0].status,'failed');assert.match(ctx.job.plan.items[0].error,/可读取的图片文件/);assert.equal(ctx.project.assets.length,0)}finally{ctx.close()}
});

test('正常新图：记录实际 Prompt、作品 ID、版本和未验收质量状态',async()=>{
 const ctx=await setup({fetcher:async(url,opt)=>url.includes('volces')?{ok:true,json:async()=>({data:[{b64_json:image.toString('base64')}]})}:reply(JSON.parse(opt.body).messages.some(m=>m.role==='tool')?{content:'完成'}:toolCall('create_image',{prompt:'干净的白底产品主图',title:'主图',reference_ids:[],text_mode:'none',text_content:[]}))});
 try{await ctx.run();assert.equal(ctx.job.technicalStatus,'completed');assert.equal(ctx.job.delivery.quality,'not_evaluated');assert.equal(ctx.project.assets[0].versions.length,1);assert.match(ctx.entries.find(e=>e.type==='image_request').prompt,/干净的白底产品主图/);assert.equal(ctx.entries.find(e=>e.type==='image_saved').version,1)}finally{ctx.close()}
});

test('Case 1：先分析三张图，模型只声称调用 create_image 时纠正并交付分析',async()=>{
 const text='第一张是必须保留外观的产品图，另外两张只是风格参考。请提取参考图的色彩、光线、材质、氛围和构图语言，并说明哪些元素可以借鉴，哪些具体场景和构图不应该直接复制。先不要生成图片。';
 let calls=0,imageCalls=0;
 const ctx=await setup({planned:false,text,fetcher:async(url,opt)=>{
  if(url.includes('volces')){imageCalls++;throw Error('不应生图')}
  calls++;const body=JSON.parse(opt.body);if(!body.tools)return reply({content:JSON.stringify({decision:{goal:'分析三张图',operation:'read',relation:'new',responseType:'analysis',reason:'用户明确先分析'},mode:'conversation'})});assert.ok(body.tools.every(t=>!['create_image','edit_image'].includes(t.function.name)));
  return reply({content:calls===2?'我将调用 create_image 函数，参数使用产品参考图 ID。':'产品图中可观察到棕色玻璃瓶、黑色泵头与米色标签，这些产品特征应保留。风格参考可借鉴暖棕与米白色彩、柔和侧光、天然石材质感及安静疗愈的氛围；原图中的台面道具位置、植物摆放和正面近景构图不应直接复制。'});
 }});
 try{const answer=await ctx.run();assert.match(answer,/柔和侧光/);assert.doesNotMatch(answer,/调用 create_image/);assert.equal(calls,3);assert.equal(imageCalls,0);assert.ok(ctx.entries.some(e=>e.type==='analysis_incomplete'))}finally{ctx.close()}
});

test('Case 2：先列约束和实现思路，工具承诺不能冒充分析交付',async()=>{
 const text='我要设计一张三栏电商功能展示图：开放格放书籍、柜门打开后放餐具、柜顶放花瓶绿植。保持商品颜色木纹结构。标题 Versatile Storage Solution，标签 Open Shelf、Enclosed Cabinet、Spacious Top。请先不要生成图片，完整列出你理解到的设计约束，并解释准备如何实现。';
 let calls=0,imageCalls=0;
 const ctx=await setup({planned:false,text,fetcher:async url=>{
  if(url.includes('volces')){imageCalls++;throw Error('不应生图')}
  calls++;if(calls===1)return reply({content:JSON.stringify({decision:{goal:'列出三栏设计约束',operation:'read',relation:'new',responseType:'analysis',reason:'用户要求先分析'},mode:'conversation'})});return reply({content:calls===2?'我已经理解，接下来我将调用 create_image 来生成这张图。':'设计约束是保留红色柜体的颜色、木纹、开放格、双门结构和比例。实现上，左栏展示开放格与书籍，中栏展示开门后的餐具收纳，右栏展示柜顶花瓶和绿植；三栏要有统一自然光。标题和三个英文标签必须分别排版并避开商品，无法确认的柜内隔板结构应先标注待核实。'});
 }});
 try{const answer=await ctx.run();assert.match(answer,/左栏展示开放格/);assert.match(answer,/无法确认/);assert.equal(calls,3);assert.equal(imageCalls,0)}finally{ctx.close()}
});

test('Case 3：功能图最终生图 Prompt 原样保留 Agent 的三栏、道具、标题和标签',async()=>{
 const uploadId='88888888-8888-4888-8888-888888888888';let imageCalls=0;
 const text='请制作一张 1:1 电商功能展示图。左栏展示开放格并摆放浅色书籍；中栏展示打开柜门后的封闭储物空间并摆放白色陶瓷餐具；右栏展示柜顶和浅色花瓶、绿植。保持原商品颜色、木纹、结构和比例。标题为 Versatile Storage Solution，三个功能标签分别为 Open Shelf、Enclosed Cabinet、Spacious Top。文字不能遮挡商品。';
 const ctx=await setup({planned:false,text,selected:[uploadId],fetcher:async(url,opt)=>{
  if(url.includes('volces')){imageCalls++;return {ok:true,json:async()=>({data:[{b64_json:image.toString('base64')}]})}}
  const body=JSON.parse(opt.body);
  if(!body.tools)return reply({content:JSON.stringify({mode:'generate',styleAnalysis:{palette:'橙红和奶油色',lighting:'柔和自然光',mood:'温暖',sourceScene:'黑色背景',productIdentity:'橙红色双门格栅柜，有开放格和黑色细腿'},items:[{purpose:'三栏功能信息图',sellingPoint:'三种储物功能',visualDirection:'温暖现代家居',newScene:'客厅',newCamera:'平视',newComposition:'三栏功能对比',referenceIds:[uploadId]}]})});
  return reply(body.messages.some(m=>m.role==='tool')?{content:'已保存'}:toolCall('create_image',{prompt:'制作 1:1 功能信息图。左栏放浅色书籍；中栏放白色陶瓷餐具；右栏放浅色花瓶与绿植。保持商品颜色、木纹、结构和比例。标题 Versatile Storage Solution；标签 Open Shelf、Enclosed Cabinet、Spacious Top。',title:'功能信息图',reference_ids:[uploadId],aspect_ratio:'1:1',text_mode:'model_render',text_content:[{role:'标题',text:'Versatile Storage Solution',layout:'顶部居中，避开柜体'},{role:'功能标签',text:'Open Shelf',layout:'左栏上方'},{role:'功能标签',text:'Enclosed Cabinet',layout:'中栏上方'},{role:'功能标签',text:'Spacious Top',layout:'右栏上方'}]}));
 }});
 ctx.project.uploads.push({id:uploadId,kind:'image',role:'product',label:'红色边柜',url:original});
 try{await ctx.run();const sent=ctx.entries.find(e=>e.type==='image_request').prompt;for(const value of ['浅色书籍','白色陶瓷餐具','浅色花瓶','绿植','颜色','木纹','结构','比例','Versatile Storage Solution','Open Shelf','Enclosed Cabinet','Spacious Top'])assert.ok(sent.includes(value),value);assert.ok(sent.startsWith('制作 1:1 功能信息图。'));assert.equal(imageCalls,1)}finally{ctx.close()}
});
