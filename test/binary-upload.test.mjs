import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createApp} from '../server.mjs';

test('二进制上传保留原图、预览图和去重，拒绝错误项目与格式',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'forma-binary-upload-'));
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const server=createApp({dataDir:dir,env:{},port});
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${port}`;
 const original=readFileSync(new URL('../dist/assets/a.png',import.meta.url));
 const preview=Buffer.from([255,216,255,217]);
 try{
  const state=await (await fetch(base+'/api/state')).json();
  const send=(projectId=state.project.id,type='image/png')=>fetch(base+'/api/upload-image',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Forma-Project-Id':projectId,'X-Forma-File-Name':encodeURIComponent('产品图.png'),'X-Forma-Image-Type':type,'X-Forma-Preview-Bytes':String(preview.length)},body:Buffer.concat([preview,original])});
  assert.equal((await send('wrong')).status,409);
  assert.equal((await send(state.project.id,'image/jpeg')).status,400);
  const first=await send();assert.equal(first.status,200);const result=await first.json();
  const upload=result.project.uploads.find(item=>item.id===result.uploadedId);
  assert.equal(upload.label,'产品图.png');
  assert.deepEqual(readFileSync(path.join(dir,upload.url.slice(1))),original);
  assert.deepEqual(readFileSync(path.join(dir,upload.previewUrl.slice(1))),preview);
  const second=await (await send()).json();
  assert.equal(second.uploadedId,result.uploadedId);
  assert.equal(second.project.uploads.length,1);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})}
});
