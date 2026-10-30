import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,mkdirSync,rmSync,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cropGrid} from '../backend/crop.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

for(const [rows,cols] of [[3,3],[2,4]])test(`本地裁切 ${rows}×${cols} 产生正确尺寸且覆盖完整原图`,async t=>{
 if(process.platform!=='darwin')return t.skip('此本地裁切实现依赖 macOS CoreGraphics');
 const dir=mkdtempSync(path.join(os.tmpdir(),'forma-crop-test-'));
 try{
  mkdirSync(path.join(dir,'media'));
  const name=randomUUID()+'.png';
  copyFileSync(path.join(base,'dist/assets/a.png'),path.join(dir,'media',name));
  const tiles=await cropGrid({dataDir:dir,url:'/media/'+name,rows,cols});
  assert.equal(tiles.length,rows*cols);
  assert.equal(new Set(tiles.map(tile=>tile.url)).size,rows*cols);
  const dimensions=(file)=>{
   const output=execFileSync('sips',['-g','pixelWidth','-g','pixelHeight',file],{encoding:'utf8'});
   return [Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]),Number(output.match(/pixelHeight:\s*(\d+)/)?.[1])];
  };
  const [width,height]=dimensions(path.join(dir,'media',name));
  for(const tile of tiles){
   const file=path.join(dir,tile.url.slice(1));
   assert.ok(statSync(file).size>100);
   assert.deepEqual(dimensions(file),[tile.width,tile.height]);
   assert.equal(tile.width,Math.floor(tile.col*width/cols)-Math.floor((tile.col-1)*width/cols));
   assert.equal(tile.height,Math.floor(tile.row*height/rows)-Math.floor((tile.row-1)*height/rows));
  }
  assert.equal(tiles.filter(tile=>tile.row===1).reduce((sum,tile)=>sum+tile.width,0),width);
  assert.equal(tiles.filter(tile=>tile.col===1).reduce((sum,tile)=>sum+tile.height,0),height);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
