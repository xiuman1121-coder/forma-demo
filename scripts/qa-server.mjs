// Local browser regression fixture. No external requests or real credentials.
import {createApp} from '../server.mjs';
import {readFileSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dataDir=process.argv[3]||mkdtempSync(path.join(os.tmpdir(),'forma-browser-qa-'));
const result=message=>({ok:true,json:async()=>({choices:[{message}]})});
const fetcher=async(url,options)=>{
 const b=JSON.parse(options.body);
 if(url.includes('bigmodel')){
  await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,3500);options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('cancelled'))},{once:true})});
  const calls=b.messages.filter(m=>m.role==='tool');
  if(!calls.length){const context=JSON.parse(b.messages.findLast(m=>m.role==='user').content[0].text.split('\n用户需求：')[0]);return result({tool_calls:[{id:'create',function:{name:'create_image',arguments:JSON.stringify({title:'回归样本 · 运动水杯封面',prompt:'运动水杯社媒封面',reference_ids:context.selection.slice(0,1)})}}]})}
  if(calls.length===1)return result({tool_calls:[{id:'text',function:{name:'edit_text',arguments:JSON.stringify({asset_id:JSON.parse(calls[0].content).asset_id,text:'动起来，自在喝',x:8,y:75,size:64,color:'#ffffff'})}}]});
  return result({content:'回归样本已就绪。此处使用预置图片验证工作流，没有调用真实模型。'});
 }
 const source=process.argv[2];return {ok:true,json:async()=>({data:[{b64_json:readFileSync(source).toString('base64')}]})};
};
createApp({port:4174,dataDir,env:{ZHIPU_API_KEY:'test-only',ARK_API_KEY:'test-only'},fetcher}).listen(4174,'127.0.0.1',()=>console.log('Isolated QA: http://127.0.0.1:4174; data:',dataDir));
