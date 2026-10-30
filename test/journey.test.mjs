import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture=readFileSync(path.join(base,'dist/assets/a.png')).toString('base64');
const response=m=>({ok:true,json:async()=>({choices:[{message:m}]})});
test('用户旅程：附件去重与传递、同项目返回、单击取消、晚到响应隔离、重新提交及作品保存',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-journey-'));let mode='blocked',pending=[],requests=[],imageCalls=0;
 const fetcher=async(url,opt)=>{const b=JSON.parse(opt.body);requests.push({url,b,signal:opt.signal});if(url.includes('bigmodel')){
  if(mode==='blocked')return new Promise(resolve=>pending.push(resolve)); // deliberately ignore abort to test stale response guard
  if(!b.tools){const selectedId=b.messages.at(-1).content[0].text.match(/"selection":\["([^"]+)"/)[1];return response({content:JSON.stringify({decision:{goal:'制作水杯封面',operation:'generate',relation:'new',reason:'用户明确要求生成'},mode:'generate',items:[{purpose:'水杯封面',visualDirection:'产品封面',referenceIds:[selectedId],targetAssetId:null}]})})}
  const completed=b.messages.filter(m=>m.role==='tool');if(!completed.length)return response({tool_calls:[{id:'image',function:{name:'create_image',arguments:JSON.stringify({prompt:'保持水杯外观，制作小红书封面',title:'水杯封面',reference_ids:[b.messages.at(-1).content[0].text.match(/"selection":\["([^"]+)"/)[1]],text_mode:'model_render',text_content:[{role:'标题',text:'随时出发',layout:'画面上方，避开水杯主体'}]})}}]});
  if(mode==='partial'&&completed.length)return {ok:false,status:429,json:async()=>({error:{code:'1305',message:'当前访问量过大'}})};
  if(completed.length===1)return response({content:'封面已完成。'});
  return response({content:'封面已完成。'});
 }imageCalls++;return {ok:true,json:async()=>({data:[{b64_json:fixture}]})}};
 const server=createApp({base,dataDir:dir,port:4187,env:{ZHIPU_API_KEY:'test',ARK_API_KEY:'test'},fetcher});await new Promise(r=>server.listen(4187,'127.0.0.1',r));
 const api=async(p,b)=>{const r=await fetch('http://127.0.0.1:4187/api/'+p,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{});return {status:r.status,data:await r.json()}};
 try{
  let x=(await api('state')).data;const id=x.project.id;
  const upload={label:'PRO 产品图.png',data:'data:image/png;base64,'+fixture};const a=(await api('upload',upload)).data;const again=(await api('upload',upload)).data;assert.equal(again.project.uploads.length,1);assert.equal(a.uploadedId,again.uploadedId);
  const doc=(await api('upload',{kind:'document',label:'brief.md',text:'20–30 岁城市年轻人，制作运动水杯小红书社媒内容。'})).data;
  const selection=[a.uploadedId,doc.uploadedId];await api('run',{text:'请做水杯小红书封面',selection,requestId:'cancel-me'});
  const same=await api('open',{id});assert.equal(same.status,200);assert.equal(same.data.project.jobs.at(-1).status,'running');assert.equal(same.data.project.messages.at(-1).attachments.length,2);
  const request=requests[0];assert.equal(request.b.messages.at(-1).content.filter(c=>c.type==='image_url').length,1);assert.ok(request.b.messages.at(-1).content.some(c=>c.text?.includes('20–30')));
  const start=Date.now();const cancelled=(await api('cancel',{jobId:same.data.project.jobs.at(-1).id})).data;assert.ok(Date.now()-start<500);assert.equal(cancelled.project.jobs.at(-1).status,'cancelled');assert.ok(request.signal.aborted);await api('cancel',{});assert.equal((await api('state')).data.project.messages.filter(m=>m.text.startsWith('已停止')).length,1);
  const next=(await api('new',{})).data;assert.notEqual(next.project.id,id);pending[0](response({tool_calls:[{id:'late',function:{name:'save_brief',arguments:'{"summary":"不能写入新项目"}'}}]}));await new Promise(r=>setTimeout(r,20));assert.equal((await api('state')).data.project.brief,'');assert.equal(imageCalls,0);
  await api('open',{id});mode='success';await api('run',{text:'继续制作封面，并添加标题“随时出发”',selection,requestId:'success'});
  for(let i=0;i<50;i++){x=(await api('state')).data;if(x.project.jobs.at(-1).status!=='running')break;await new Promise(r=>setTimeout(r,10))}
  assert.equal(x.project.jobs.at(-1).status,'completed');assert.equal(imageCalls,1);assert.equal(x.project.assets.length,1);assert.equal(x.project.assets[0].versions.at(-1).layer.text,'');assert.ok(requests.find(r=>r.url.includes('volces')).b.prompt.includes('随时出发'));
  assert.equal(requests.find(r=>r.url.includes('volces')).b.image.length,1);
  const asset=x.project.assets[0];assert.equal((await fetch('http://127.0.0.1:4187'+asset.versions[0].image)).status,200);
  await api('run',{text:'继续制作封面',selection,requestId:'success'});assert.equal(imageCalls,1);
  const exported=await api('export',{id:asset.id,data:'data:image/png;base64,'+fixture});assert.equal(exported.status,200);const file=await fetch('http://127.0.0.1:4187'+exported.data.url);assert.match(file.headers.get('content-disposition'),/attachment/);assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'),fixture);
  mode='partial';await api('run',{text:'生成图片后限流案例',selection,requestId:'partial'});
  for(let i=0;i<50;i++){x=(await api('state')).data;if(x.project.jobs.at(-1).status!=='running')break;await new Promise(r=>setTimeout(r,10))}
  assert.equal(x.project.jobs.at(-1).status,'completed');assert.equal(imageCalls,2);assert.equal(x.project.assets.length,2);assert.match(x.project.messages.at(-1).text,/图片已放到画布/);assert.ok(x.budget.usedFen>0);
  assert.equal((await api('run',{text:'坏素材',selection:['missing'],requestId:'bad'})).status,400);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true})}
});
