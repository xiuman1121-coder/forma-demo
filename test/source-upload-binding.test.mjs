import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {bindSourceUploads,validateImageExecutionContext} from '../backend/task.mjs';
import {buildContextSnapshot} from '../backend/context-snapshot.mjs';

const uploadId='uploaded-product';
const unrelatedId='unrelated-upload';
const project={uploads:[{id:uploadId},{id:unrelatedId}],assets:[],jobs:[
 {id:'analysis',selection:[uploadId],routingDecision:{materialRoles:{productIds:[uploadId]}}},
 {id:'text-follow-up',selection:[],routingDecision:{sourceJobId:'analysis',materialRoles:{productIds:[]}}},
 {id:'first-attempt',selection:[],routingDecision:{sourceJobId:'analysis',materialRoles:{productIds:[uploadId]}},plan:{revisionOf:null}},
 {id:'retry-one',selection:[],routingDecision:{sourceJobId:null},plan:{revisionOf:'first-attempt'}},
]};

test('binds product upload from referenced analysis before planning execution',()=>{
 const job={selection:[]};
 bindSourceUploads(project,job,{sourceJobId:'analysis',materialRoles:{productIds:[uploadId]}},null);
 assert.deepEqual(job.selection,[uploadId]);
});

test('repairs an existing failed plan through continuation chain',()=>{
 const plan={revisionOf:'retry-one',items:[{referenceIds:[]}]};
 const job={selection:[]};
 bindSourceUploads(project,job,null,plan);
 assert.deepEqual(job.selection,[uploadId]);
 assert.deepEqual(plan.items[0].referenceIds,[uploadId]);
});

test('binds an earlier product through an intervening text-only turn',()=>{
 const job={selection:[]};
 bindSourceUploads(project,job,{sourceJobId:'text-follow-up',materialRoles:{productIds:[]}},null);
 assert.deepEqual(job.selection,[uploadId]);
});

test('does not accept unrelated or fabricated material IDs',()=>{
 const job={selection:[]};
 bindSourceUploads(project,job,{sourceJobId:'analysis',materialRoles:{productIds:[unrelatedId,'invented']}},null);
 assert.deepEqual(job.selection,[]);
});

test('Agent execution snapshot reflects bound selection and rejects missing image files',()=>{
 const dataDir=mkdtempSync(path.join(tmpdir(),'forma-execution-context-'));
 try{
  mkdirSync(path.join(dataDir,'media'));
  writeFileSync(path.join(dataDir,'media','product.jpg'),Buffer.alloc(150,1));
  const executionProject={...project,uploads:[{id:uploadId,url:'/media/product.jpg',kind:'image'}],messages:[],creativeTasks:[]};
  const child={id:'execution',text:'制作商品图',selection:[uploadId]};
  const item={referenceIds:[uploadId],targetAssetId:null};
  assert.doesNotThrow(()=>validateImageExecutionContext(executionProject,child,item,dataDir));
  assert.deepEqual(buildContextSnapshot(executionProject,child).current.selectedIds,[uploadId]);
  assert.throws(()=>validateImageExecutionContext(executionProject,{...child,selection:[]},item,dataDir),/未进入最终执行素材/);
  rmSync(path.join(dataDir,'media','product.jpg'));
  assert.throws(()=>validateImageExecutionContext(executionProject,child,item,dataDir),/图片文件不存在/);
 }finally{rmSync(dataDir,{recursive:true,force:true})}
});
