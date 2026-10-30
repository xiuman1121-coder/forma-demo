import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildRoutingContext,decisionFromPlanning,permitsPaidImage,parsePlanningJSON} from '../backend/routing.mjs';

const message=(operation,mode='conversation',extra={})=>({content:JSON.stringify({decision:{goal:'电商视觉',operation,relation:'new',reason:'Mock 语义判断',...extra},mode,items:[]})});

test('Planning 的结构化操作决定权限，文字分析不能授权生图',()=>{
 const read=decisionFromPlanning(message('read')).decision;
 assert.equal(read.operation,'read');assert.equal(permitsPaidImage(read),false);
 const draft=decisionFromPlanning(message('draft')).decision;
 assert.equal(draft.allowedEffects.includes('save_draft'),true);assert.equal(permitsPaidImage(draft),false);
 const generate=decisionFromPlanning(message('generate','generate')).decision;
 assert.equal(permitsPaidImage(generate),true);
 assert.throws(()=>decisionFromPlanning(message('generate','generate',{relation:'unresolved'})),/不明确/);
});

test('规划 JSON 只恢复无冲突的拆分结果；非法正文不能授予执行权限',()=>{
 const plan={decision:{goal:'修改方案',operation:'revise',relation:'continue',reason:'用户要求修改'}};
 assert.equal(decisionFromPlanning({content:`${JSON.stringify(plan)}, ${JSON.stringify({mode:'conversation'})}`}).decision.operation,'revise');
 assert.equal(parsePlanningJSON('```json\n'+JSON.stringify({...plan,mode:'conversation'})+'\n```').mode,'conversation');
 for(const raw of ['{"decision":','{"mode":"conversation"}, {"mode":"generate"}','{"mode":"generate"} trailing'])assert.throws(()=>parsePlanningJSON(raw),error=>error.code==='PLANNING_JSON_INVALID');
});

test('Task Context 不从聊天文字猜出已确认方案',()=>{
 const project={uploads:[{id:'product-1',role:'product',label:'水杯'}],assets:[],messages:[{role:'assistant',text:'建议做三张图'}]};
 const context=buildRoutingContext({project,job:{text:'按照刚才方案生成',selection:['product-1']}});
 assert.equal(context.taskContext,null);
 assert.deepEqual(context.selectedMaterials,[{id:'product-1',kind:'upload',role:'product',label:'水杯'}]);
 assert.equal(context.continuedPlan,null);
});
