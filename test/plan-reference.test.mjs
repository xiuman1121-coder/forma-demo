import test from 'node:test';
import assert from 'node:assert/strict';
import {clarifyPlanReference,revisionLabel,directionOptions} from '../backend/plan-reference.mjs';

const task={revisions:[
 {id:'one',kind:'design',version:1,request:'帮我设计一套淘宝主图视觉方案',content:'# 雾霾蓝 T 恤主图视觉方案\n室内挂拍、低饱和留白，浅色墙面。'},
 {id:'two',kind:'design',version:2,request:'把背景改成海边沙滩，模特换成坐姿。',content:'## 海边坐姿构图提案\n**A. 沙滩坐姿正面**：模特面向镜头。\n**B. 背面看海**：模特背向镜头。'}
]};

test('方案编号与内部 A/B 选项冲突时引用内容澄清',()=>{
 const result=clarifyPlanReference(task,'按前面的方案一制作吧');
 assert.equal(result.reason,'ambiguous_plan_reference');
 assert.match(result.question,/室内、挂拍/);
 assert.match(result.question,/沙滩坐姿正面/);
 assert.doesNotMatch(result.question,/revisionId|v1|v2/);
 assert.ok(revisionLabel(task.revisions[0]).includes('雾霾蓝'));
});

test('明确的方向 D 直接定位；模糊方向列真实画面而非引用历史问句',()=>{
 const directions={revisions:[
  {id:'first',kind:'design',version:1,request:'做一下这个产品的电商主图方案。',content:'**主图 1｜首图：极简白底标准图**'},
  {id:'alternatives',kind:'design',version:2,request:'有没有别的方案？',content:'## 方向 A｜原料静物：成分可视化（暖调植物派）\n## 方向 B｜暗调玻璃：琥珀透光感（明暗反差派）\n## 方向 C｜使用仪式：手部入镜（人文派）\n## 方向 D｜正俯拍平铺：洗护仪式桌面（构图派）'}
 ]};
 assert.equal(directionOptions(directions).length,4);
 assert.equal(clarifyPlanReference(directions,'帮我做前面方向 D 的图。'),null);
 const result=clarifyPlanReference(directions,'帮我做前面那个方向的图。');
 assert.match(result.question,/原料静物/);assert.match(result.question,/暗调玻璃/);assert.match(result.question,/手部入镜/);assert.match(result.question,/洗护仪式桌面/);
 assert.doesNotMatch(result.question,/做一下这个产品|有没有别的方案/);
});

test('模糊的前述方案需澄清，明确场景或时间可以直接指向一版',()=>{
 assert.ok(clarifyPlanReference(task,'按前面那个方案做'));
 assert.equal(clarifyPlanReference(task,'刚才那个方案之前的方案'),null);
 assert.equal(clarifyPlanReference(task,'按海边沙滩那个方案做'),null);
 assert.equal(clarifyPlanReference(task,'按最初的方案做'),null);
 assert.equal(clarifyPlanReference(task,'按最前面的方案做'),null);
 assert.equal(clarifyPlanReference(task,'按刚才的方案做'),null);
});

test('只有一版或普通请求不被拦截',()=>{
 assert.equal(clarifyPlanReference({revisions:task.revisions.slice(0,1)},'方案一制作'),null);
 assert.equal(clarifyPlanReference(task,'设计一张新的淘宝主图'),null);
});
