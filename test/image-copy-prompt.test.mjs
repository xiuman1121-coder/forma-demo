import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildImagePrompt} from '../backend/prompt.mjs';
import {validateImageTextArgs} from '../backend/agent.mjs';
import {Budget} from '../backend/core.mjs';
import {runTask} from '../backend/task.mjs';

test('Agent 指令完整保留，后端只附加产品事实',()=>{
 const prompt='海边晨光，产品居中。主标题「晨间的温柔洁净」置于左上。';
 const result=buildImagePrompt({modelPrompt:prompt,productIdentity:'琥珀色瓶身，黑色泵头'});
 assert.ok(result.startsWith(prompt));
 assert.match(result,/必须保持的产品外观事实：琥珀色瓶身，黑色泵头/);
 assert.doesNotMatch(result,/本轮没有要执行的图片文案|本轮唯一执行方案/);
});

test('空指令和超长指令在生图前失败，不由后端代写或截断',()=>{
 assert.throws(()=>buildImagePrompt({modelPrompt:'  '}),/未提供生图指令/);
 assert.throws(()=>buildImagePrompt({modelPrompt:'a'.repeat(6001)}),/指令过长/);
});

test('有字模式须给出原句与排版，两处自然语言不必逐字重复',()=>{
 assert.throws(()=>validateImageTextArgs({text_mode:'model_render',text_content:[],prompt:'耳机主图'}),/缺少具体文案/);
 assert.throws(()=>validateImageTextArgs({text_mode:'none',text_content:[{role:'标题',text:'轻盈聆听',layout:'左上方'}],prompt:'耳机主图'}),/无字模式/);
 const intent=validateImageTextArgs({text_mode:'model_render',text_content:[{role:'主标题',text:'慵懒的周日清晨',layout:'画面上方偏右，距顶边约10%画面高度，不与瓶身和纸盒重叠'}],prompt:'主标题「慵懒的周日清晨」放在画面上方偏右，距顶边约 10%，不与瓶身、纸盒重叠'});
 assert.equal(intent.content[0].text,'慵懒的周日清晨');
 const finalPrompt=buildImagePrompt({modelPrompt:'主标题「慵懒的周日清晨」放在画面上方偏右，距顶边约 10%，不与瓶身、纸盒重叠',textIntent:intent});
 assert.match(finalPrompt,/距顶边约10%画面高度/);
 assert.match(finalPrompt,/主标题「慵懒的周日清晨」/);
});

test('无字模式漏传空文案数组时按无字处理，有字模式仍须提供文案',()=>{
 const args={text_mode:'none',prompt:'1:1 杯子主图，不添加额外文字'};
 assert.deepEqual(validateImageTextArgs(args),{mode:'none',content:[]});
 assert.deepEqual(args.text_content,[]);
 assert.throws(()=>validateImageTextArgs({text_mode:'model_render',prompt:'1:1 杯子主图'}),/未明确文字生成方式/);
 assert.throws(()=>validateImageTextArgs({text_mode:'none',text_content:[{role:'标题',text:'新品',layout:'左上'}]}),/不能同时提供图片文案/);
});

test('已选方案的讨论稿不注入 Seedream，Agent 文案与构图保持原样',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-image-handoff-'));
 try{
  const sourceRevision={id:'revision-1',version:1,status:'confirmed',jobId:'plan-1',kind:'design',content:'方案 A：海边。方案 B：室内。待确认：选 A 还是 B？'};
  const task={id:'task-1',sourceIds:[],productIds:[],referenceIds:[],constraints:[],revisions:[sourceRevision],confirmedRevisionId:sourceRevision.id,status:'confirmed',delivered:[],lastJobId:'plan-1',productIdentity:'奶油白耳机'};
  const project={id:'project-1',brief:'',messages:[{role:'user',jobId:'plan-1',text:'制定方案'},{role:'assistant',jobId:'plan-1',text:sourceRevision.content}],uploads:[],assets:[],jobs:[],creativeTasks:[task]};
  const job={id:'make-image',text:'按已确认方案生成一张图。',selection:[],usage:[]};
  const image=readFileSync(path.join(import.meta.dirname,'..','dist','assets','a.png'));
  const agentPrompt='一张海边晨光耳机主图，主标题「轻盈聆听」左上方左对齐，避开耳机，产品居中。';
  let imageCalls=0;
  const fetcher=async(url,options)=>{
   const body=JSON.parse(options.body);
   if(url.includes('volces')){
    imageCalls++;
    assert.ok(body.prompt.startsWith(agentPrompt));
    assert.match(body.prompt,/奶油白耳机/);
    assert.doesNotMatch(body.prompt,/方案 B|待确认|本轮唯一执行方案|不要凭空生成标题/);
    return {ok:true,status:200,json:async()=>({data:[{b64_json:image.toString('base64')}]})};
   }
   if(!body.tools)return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({decision:{operation:'generate',relation:'continue',taskId:task.id,sourceRevisionId:sourceRevision.id,sourceJobId:'plan-1'},mode:'generate',items:[{purpose:'海边耳机主图',visualDirection:'海边晨光',newScene:'海边',newCamera:'平视',newComposition:'耳机居中'}]})}}],usage:{}})};
   return {ok:true,status:200,json:async()=>({choices:[{message:{tool_calls:[{id:'create-1',function:{name:'create_image',arguments:JSON.stringify({prompt:agentPrompt,title:'耳机',reference_ids:[],text_mode:'model_render',text_content:[{role:'主标题',text:'轻盈聆听',layout:'左上方左对齐，避开耳机'}]})}}]}}],usage:{}})};
  };
  await runTask({project,job,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),1000),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}});
  assert.equal(imageCalls,1);
  assert.equal(project.assets.length,1);
  assert.equal(project.assets[0].source.textIntent.mode,'model_render');
  assert.equal(project.assets[0].source.textIntent.content[0].text,'轻盈聆听');
  assert.equal(project.assets[0].versions.at(-1).layer.text,'');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
