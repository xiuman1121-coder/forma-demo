import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture=readFileSync(path.join(base,'dist/assets/a.png')).toString('base64');

test('项目库删除和撤销只影响目标项目，并保留创建时间与预算',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-project-library-'));
 const server=createApp({base,dataDir:dir,port:4192,env:{}});
 await new Promise(resolve=>server.listen(4192,'127.0.0.1',resolve));
 const api=async(route,payload)=>{
  const response=await fetch('http://127.0.0.1:4192/api/'+route,payload?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{});
  return {status:response.status,data:await response.json()};
 };
 try{
  let state=(await api('state')).data;
  const first=state.project.id;
  state=(await api('upload',{projectId:first,label:'第一张.png',data:'data:image/png;base64,'+fixture})).data;
  state=(await api('new',{projectId:first})).data;
  const second=state.project.id;
  assert.ok(state.project.createdAt);
  state=(await api('upload',{projectId:second,label:'第二张.png',data:'data:image/png;base64,'+fixture})).data;
  assert.deepEqual(new Set(state.projects.map(p=>p.id)),new Set([first,second]));
  assert.ok(state.projects.find(p=>p.id===second).createdAt);
  const beforeBudget=state.budget.usedFen;
  state=(await api('delete',{projectId:second,id:first})).data;
  assert.deepEqual(state.projects.map(p=>p.id),[second]);
  assert.equal(state.project.id,second);
  assert.equal('trash' in state.project,false);
  state=(await api('restore',{projectId:second,id:first})).data;
  assert.deepEqual(new Set(state.projects.map(p=>p.id)),new Set([first,second]));
  state=(await api('delete',{projectId:second,id:second})).data;
  assert.equal(state.project.id,first);
  assert.deepEqual(state.projects.map(p=>p.id),[first]);
  state=(await api('restore',{projectId:first,id:second})).data;
  assert.deepEqual(new Set(state.projects.map(p=>p.id)),new Set([first,second]));
  assert.equal(state.budget.usedFen,beforeBudget);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})}
});

test('新项目不继承创作任务，旧项目再次打开仍保留任务',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-project-task-isolation-'));
 const original={id:'old-project',brief:'',messages:[{role:'user',text:'旧项目'}],uploads:[],assets:[],jobs:[],creativeTasks:[{id:'old-task',revisions:[{id:'v1',status:'draft'}]}],activeCreativeTaskId:'old-task'};
 writeFileSync(path.join(dir,'project.json'),JSON.stringify(original));
 const server=createApp({base,dataDir:dir,port:4193,env:{}});await new Promise(resolve=>server.listen(4193,'127.0.0.1',resolve));
 const api=async(route,payload)=>{const response=await fetch('http://127.0.0.1:4193/api/'+route,payload?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{});return (await response.json()).project};
 try{
  const fresh=await api('new',{projectId:'old-project'});
  assert.deepEqual(fresh.creativeTasks,[]);assert.equal(fresh.activeCreativeTaskId,null);
  await api('upload',{projectId:fresh.id,label:'新项目.png',data:'data:image/png;base64,'+fixture});
  const reopened=await api('open',{id:'old-project'});
  assert.equal(reopened.activeCreativeTaskId,'old-task');assert.equal(reopened.creativeTasks[0].revisions[0].id,'v1');
  const again=await api('open',{id:fresh.id});assert.deepEqual(again.creativeTasks,[]);assert.equal(again.activeCreativeTaskId,null);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})}
});

test('打开旧项目不改变最近项目顺序，新对话时间决定排序',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-project-order-'));
 const project=(id,startedAt)=>({id,createdAt:'2026-10-01T00:00:00.000Z',brief:'',messages:[{role:'user',text:id}],uploads:[],assets:[],jobs:[{id:`job-${id}`,status:'completed',startedAt}]});
 writeFileSync(path.join(dir,'project.json'),JSON.stringify({...project('older','2026-10-02T00:00:00.000Z'),archived:[project('recent','2026-10-04T00:00:00.000Z'),project('middle','2026-10-03T00:00:00.000Z')]}));
 const server=createApp({base,dataDir:dir,port:4194,env:{ZHIPU_API_KEY:'test'},fetcher:async()=>{throw Error('mock offline')}});await new Promise(resolve=>server.listen(4194,'127.0.0.1',resolve));
 const api=async(route,payload)=>{const response=await fetch('http://127.0.0.1:4194/api/'+route,payload?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{});return response.json()};
 try{
  assert.deepEqual((await api('state')).projects.map(p=>p.id),['recent','middle','older']);
  assert.deepEqual((await api('open',{id:'middle'})).projects.map(p=>p.id),['recent','middle','older']);
  assert.deepEqual((await api('open',{id:'older'})).projects.map(p=>p.id),['recent','middle','older']);
  assert.deepEqual((await api('run',{projectId:'older',text:'新的对话',selection:[],requestId:'new-conversation'})).projects.map(p=>p.id),['older','recent','middle']);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})}
});
