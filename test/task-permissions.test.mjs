import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Budget} from '../backend/core.mjs';
import {runAgent} from '../backend/agent.mjs';
import {authorizeTaskDecision,permitsEffect} from '../backend/routing.mjs';

const proposal=(operation,stage)=>({goal:'设计任务',operation,stage,relation:'continue',source:'planning_glm'});

test('操作权限由代码推导，模型的 allowedEffects 不能自行授权',()=>{
 const read=authorizeTaskDecision({...proposal('read','discuss'),allowedEffects:['paid_image','save_draft']});
 assert.deepEqual(read.allowedEffects,['read']);
 const revise=authorizeTaskDecision(proposal('revise','plan'));
 assert.equal(permitsEffect(revise,'save_draft'),true);assert.equal(permitsEffect(revise,'paid_image'),false);
 const unapproved=authorizeTaskDecision(proposal('confirm','plan'));
 assert.equal(permitsEffect(unapproved,'confirm_revision'),false);
 const approved=authorizeTaskDecision(proposal('confirm','plan'),{confirmedApproval:true});
 assert.equal(permitsEffect(approved,'confirm_revision'),true);
 const generate=authorizeTaskDecision(proposal('generate','execute'));
 assert.equal(permitsEffect(generate,'paid_image'),true);assert.equal(permitsEffect(generate,'asset_write'),true);
});

test('Agent 没有付费权限时不会请求 Seedream',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-unauthed-'));
 const project={id:'p',brief:'',messages:[],uploads:[],assets:[],jobs:[]};let imageCalls=0;
 const fetcher=async url=>{if(url.includes('volces')){imageCalls++;throw Error('不应调用图像服务')}return {ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'x',function:{name:'create_image',arguments:JSON.stringify({prompt:'生成一张产品图',title:'测试',reference_ids:[],text_mode:'none',text_content:[]})}}]}}]})}};
 try{await assert.rejects(()=>runAgent({project,job:{id:'j',text:'生成一张图',selection:[],usage:[]},env:{ZHIPU_API_KEY:'mock',ARK_API_KEY:'mock'},budget:new Budget(path.join(dir,'budget.json'),100),dataDir:dir,fetcher,emit:()=>{},persist:()=>{}}),/未调用图片工具|未获付费生图授权|文本任务未实际交付/);assert.equal(imageCalls,0)}
 finally{rmSync(dir,{recursive:true,force:true})}
});
