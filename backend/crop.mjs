import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,mkdirSync,statSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const exec=promisify(execFile);
async function imageSize(file,signal){
 if(process.platform==='darwin'){
  const {stdout}=await exec('sips',['-g','pixelWidth','-g','pixelHeight',file],{signal});
  return [Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]),Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1])];
 }
 const {stdout}=await exec('python3',['-c','from PIL import Image; import sys; print(*Image.open(sys.argv[1]).size)',file],{signal});
 return stdout.trim().split(/\s+/).map(Number);
}
export async function cropGrid({dataDir,url,rows=3,cols=3,signal}){
 if(!Number.isInteger(rows)||!Number.isInteger(cols)||rows<1||cols<1||rows*cols>24)throw Error('裁切行列数无效。');
 if(!['darwin','linux'].includes(process.platform))throw Error('当前环境缺少本地裁图工具，未调用生图模型。');
 if(!/^\/media\/[a-f0-9-]+\.(png|jpg|webp)$/.test(url||''))throw Error('请选择一张已上传的九宫格图片。');
 const input=path.join(dataDir,url.slice(1));
 if(!existsSync(input))throw Error('原图文件不存在。');
 const [width,height]=await imageSize(input,signal);
 if(!width||!height||width<cols||height<rows)throw Error('无法读取或裁切图片尺寸。');
 const mediaDir=path.join(dataDir,'media');mkdirSync(mediaDir,{recursive:true});
 const results=[];
 try{
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
   const x0=Math.floor(col*width/cols),x1=Math.floor((col+1)*width/cols);
   const y0=Math.floor(row*height/rows),y1=Math.floor((row+1)*height/rows);
   const filename=randomUUID()+'.png',output=path.join(mediaDir,filename);
   results.push({url:'/media/'+filename,row:row+1,col:col+1,width:x1-x0,height:y1-y0});
  }
  const script=fileURLToPath(new URL(process.platform==='darwin'?'./crop.swift':'./crop.py',import.meta.url));
  await exec(process.platform==='darwin'?'swift':'python3',[script,input,String(rows),String(cols),...results.map(result=>path.join(dataDir,result.url.slice(1)))],{signal});
  for(const result of results){
   const output=path.join(dataDir,result.url.slice(1));
   if(!existsSync(output)||statSync(output).size<100)throw Error('裁切文件未成功保存。');
   const [actualWidth,actualHeight]=await imageSize(output,signal);
   if(actualWidth!==result.width||actualHeight!==result.height)throw Error(`第 ${result.row} 行第 ${result.col} 列裁切尺寸不正确。`);
  }
  return results;
 }catch(error){for(const result of results)try{unlinkSync(path.join(dataDir,result.url.slice(1)))}catch{};throw error}
}
