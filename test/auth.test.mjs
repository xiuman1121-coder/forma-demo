import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {createApp} from '../server.mjs';
import {createAuth,hashPassword} from '../backend/auth.mjs';
import {Budget} from '../backend/core.mjs';

test('固定账号保护项目、接口和图片，且原有预算记录保留',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'forma-auth-'));
 const env={FORMA_LOGIN_EMAIL:'owner@example.com',FORMA_LOGIN_PASSWORD_HASH:hashPassword('correct horse battery staple'),FORMA_SESSION_SECRET:randomBytes(32).toString('hex')};
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const server=createApp({dataDir:dir,env,port});await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${port}`,headers={};
 try{
  assert.equal((await fetch(base+'/studio',{headers,redirect:'manual'})).headers.get('location'),'/login');
  assert.equal((await fetch(base+'/api/state',{headers})).status,401);
  assert.equal((await fetch(base+'/media/00000000-0000-0000-0000-000000000000.png',{headers})).status,401);
  const form=new URLSearchParams({email:'owner@example.com',password:'correct horse battery staple'});
  const response=await fetch(base+'/login',{method:'POST',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});
  assert.equal(response.status,303);const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/api/state',{headers:{...headers,Cookie:cookie}})).status,200);
  assert.equal((await fetch(base+'/api/state',{headers:{...headers,Cookie:cookie+'x'}})).status,401);
 }finally{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})}
});

test('预算可升至 80 元且保留旧消费记录',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'forma-budget-'));
 try{const file=path.join(dir,'budget.json');const old=new Budget(file,5000);old.reserve('old',12);const next=new Budget(file,8000);assert.equal(next.snapshot().limitFen,8000);assert.equal(next.snapshot().usedFen,12);assert.equal(next.snapshot().remainingFen,7988)}finally{rmSync(dir,{recursive:true,force:true})}
});

test('会话不能伪造，邮箱和密码都要正确',()=>{
 const env={FORMA_LOGIN_EMAIL:'owner@example.com',FORMA_LOGIN_PASSWORD_HASH:hashPassword('strong password'),FORMA_SESSION_SECRET:randomBytes(32).toString('hex')};
 const auth=createAuth(env);assert.equal(auth.checkPassword('owner@example.com','strong password'),true);assert.equal(auth.checkPassword('other@example.com','strong password'),false);assert.equal(auth.checkPassword('owner@example.com','wrong'),false);
 const cookie=auth.issue(true);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.equal(auth.verify({headers:{cookie:cookie.split(';')[0]}}),true);assert.equal(auth.verify({headers:{cookie:cookie.replace('=', '=x').split(';')[0]}}),false);
});
