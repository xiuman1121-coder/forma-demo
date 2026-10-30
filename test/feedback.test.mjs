import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const first=readFileSync(path.join(base,'dist/assets/a.png')).toString('base64');
const second=readFileSync(path.join(base,'dist/assets/b.png')).toString('base64');

test('完整反馈回合：上传参考图、生成、改图另存作品并导出',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-feedback-'));
 let imageCalls=0,brainCalls=0,editInputCount=0,secondProjectId=null;
 const fetcher=async(url,opt)=>{
  const body=JSON.parse(opt.body);
  if(url.includes('bigmodel')){
   brainCalls++;
   const user=body.messages.filter(m=>m.role==='user').at(-1);
   if(secondProjectId){const context=JSON.parse(user.content[0].text.split('\n用户需求：')[0]);assert.deepEqual(context.assets,[]);assert.equal(context.uploads.length,1);assert.ok(user.content.filter(c=>c.type==='image_url').length>=1);assert.ok(!JSON.stringify(body.messages).includes('浅蓝色背景'))}
   const feedback=JSON.stringify(user.content).includes('浅蓝色背景');
   if(!body.tools){const context=JSON.parse(user.content[0].text.split('\n用户需求：')[0]);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({decision:{goal:feedback?'修改背景':'生成主图',operation:feedback?'edit':'generate',relation:feedback?'continue':'new',reason:'用户明确要求图片'},mode:feedback?'edit':'generate',items:[{purpose:feedback?'修改背景':'产品主图',visualDirection:feedback?'浅蓝色背景':'产品主图',referenceIds:feedback?[]:[context.selection[0]],targetAssetId:feedback?context.assets[0].id:null}]})}}]})}};
   if(feedback){
    assert.equal(user.content.filter(c=>c.type==='image_url').length,body.tools?2:1);
    const context=JSON.parse(user.content[0].text.split('\n用户需求：')[0]);
    const assetId=context.assets[0].id;
    const completed=body.messages.some(m=>m.role==='tool');
    return {ok:true,json:async()=>({choices:[{message:completed?{content:'已把背景改为浅蓝色。'}:{tool_calls:[{id:'edit',function:{name:'edit_image',arguments:JSON.stringify({asset_id:assetId,prompt:'将背景改为浅蓝色，保持水杯外观',reference_ids:[],text_mode:'none',text_content:[]})}}]}}]})};
   }
   const completed=body.messages.some(m=>m.role==='tool');
   return {ok:true,json:async()=>({choices:[{message:completed?{content:'首图已生成。'}:{tool_calls:[{id:'create',function:{name:'create_image',arguments:JSON.stringify({prompt:'用产品图制作主图',title:'产品主图',reference_ids:[],text_mode:'none',text_content:[]})}}]}}]})};
  }
  imageCalls++;
  assert.equal(body.watermark,false);
  if(imageCalls===2){editInputCount=body.image.length;assert.equal(body.image.length,1)}
  return {ok:true,json:async()=>({data:[{b64_json:imageCalls===1?first:second}]})};
 };
 const server=createApp({base,dataDir:dir,port:4189,env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},fetcher});
 await new Promise(resolve=>server.listen(4189,'127.0.0.1',resolve));
 const api=async(route,payload)=>{const response=await fetch('http://127.0.0.1:4189/api/'+route,payload?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{});return {status:response.status,data:await response.json()}};
 const finished=async()=>{for(let i=0;i<100;i++){const s=(await api('state')).data;if(s.project.jobs.at(-1)?.status!=='running')return s;await new Promise(r=>setTimeout(r,10))}throw Error('测试任务超时')};
 try{
  let state=(await api('state')).data;
  const uploaded=(await api('upload',{projectId:state.project.id,label:'产品图.png',data:'data:image/png;base64,'+first})).data;
  assert.equal(uploaded.project.uploads.length,1);
  assert.equal((await api('run',{projectId:state.project.id,text:'请根据产品图制作电商主图',selection:[uploaded.uploadedId],requestId:'initial'})).status,202);
  state=await finished();assert.equal(state.project.jobs.at(-1).status,'completed',state.project.jobs.at(-1).error);assert.equal(state.project.assets.length,1);
  const asset=state.project.assets[0];assert.equal(asset.versions.length,1);
  assert.equal((await api('run',{projectId:state.project.id,text:'把刚才这张图改为浅蓝色背景，保持水杯不变',selection:[],requestId:'feedback'})).status,202);
  state=await finished();assert.equal(state.project.jobs.at(-1).status,'completed',state.project.jobs.at(-1).error);assert.equal(state.project.assets.length,2);
  assert.equal(state.project.assets[0].versions.length,1);assert.equal(state.project.assets[1].versions.length,1);assert.notEqual(state.project.assets[0].versions[0].image,state.project.assets[1].versions[0].image);assert.equal(state.project.assets[1].source.parentAssetId,asset.id);
  const auditFile=path.join(dir,'audit',`${state.project.jobs.at(-1).id}.json`);const audit=JSON.parse(readFileSync(auditFile,'utf8'));
  assert.equal(statSync(auditFile).mode&0o777,0o600);assert.ok(audit.entries.some(e=>e.type==='image_request'&&e.prompt.includes('将背景改为浅蓝色，保持水杯外观')));assert.ok(audit.entries.some(e=>e.type==='task_finished'&&e.status==='completed'));
  assert.ok(!JSON.stringify(state).includes('将背景改为浅蓝色，保持水杯外观'));
  assert.equal(imageCalls,2);assert.equal(editInputCount,1);assert.ok(brainCalls>=4);
  assert.deepEqual(state.project.jobs.at(-1).explicitSelection,[]);
  assert.equal(state.project.jobs.at(-1).plan.items[0].targetAssetId,asset.id);
  assert.deepEqual(state.project.messages.at(-2).attachments,[]);
  const exported=await api('export',{projectId:state.project.id,id:asset.id,data:'data:image/png;base64,'+second});assert.equal(exported.status,200);
  const downloaded=await fetch('http://127.0.0.1:4189'+exported.data.url);assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-disposition'),/attachment/);
  const firstProjectId=state.project.id;
  state=(await api('new',{projectId:firstProjectId})).data;secondProjectId=state.project.id;
  assert.notEqual(secondProjectId,firstProjectId);assert.equal(state.project.messages.length,0);assert.equal(state.project.assets.length,0);assert.equal(state.project.uploads.length,0);
  const cabinet=(await api('upload',{projectId:secondProjectId,label:'红色柜子.png',data:'data:image/png;base64,'+second})).data;
  assert.equal((await api('run',{projectId:secondProjectId,text:'为红色柜子制作亚马逊图片',selection:[cabinet.uploadedId],requestId:'second-project'})).status,202);
  state=await finished();assert.equal(state.project.jobs.at(-1).status,'completed');assert.equal(state.project.messages.length,2);assert.equal(state.project.messages[0].attachments.length,1);assert.equal(state.project.messages[0].attachments[0].id,cabinet.uploadedId);assert.equal(state.project.assets.length,1);
  const secondAssetId=state.project.assets[0].id;
  state=(await api('open',{id:firstProjectId})).data;assert.equal(state.project.assets[0].id,asset.id);assert.equal(state.project.assets[0].versions.length,1);assert.equal(state.project.assets.length,2);assert.equal(state.project.messages.length,4);
  state=(await api('open',{id:secondProjectId})).data;assert.equal(state.project.assets[0].id,secondAssetId);assert.equal(state.project.messages.length,2);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})}
});
