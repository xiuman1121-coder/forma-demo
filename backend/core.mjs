import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export function readEnv(file){const out={};if(existsSync(file))for(const line of readFileSync(file,'utf8').split(/\r?\n/)){if(!line.trim()||line.trim().startsWith('#'))continue;const at=line.indexOf('=');if(at>0)out[line.slice(0,at).trim()]=line.slice(at+1).trim().replace(/^['"]|['"]$/g,'')}return out}
export function writeJSON(file,value){mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});renameSync(file+'.tmp',file)}
export function readJSON(file,fallback){return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):fallback}
export class Budget {
 constructor(file,limitFen=100){this.file=file;this.limitFen=Math.min(8000,Math.max(0,Math.floor(Number(limitFen)||0)));this.entries=readJSON(file,[])}
 snapshot(){const usedFen=this.entries.filter(e=>e.status!=='released').reduce((s,e)=>s+e.fen,0);return {limitFen:this.limitFen,usedFen,remainingFen:Math.max(0,this.limitFen-usedFen),entries:this.entries}}
 reserve(jobId,fen=12,taskLimitFen=Infinity){if(!Number.isSafeInteger(fen)||fen<=0)throw Error('预算金额无效');if(this.snapshot().remainingFen<fen)throw Error('已达到本阶段预算上限，未发送生图请求。');const taskUsed=this.entries.filter(e=>e.jobId===jobId&&e.status!=='released').reduce((sum,e)=>sum+e.fen,0);if(taskUsed+fen>taskLimitFen)throw Error('本任务调用预算已达到上限，未发送付费请求。');const entry={id:randomUUID(),jobId,fen,status:'reserved',at:new Date().toISOString()};this.entries.push(entry);writeJSON(this.file,this.entries);return entry.id}
 finish(id,status){const e=this.entries.find(e=>e.id===id);if(e){e.status=status;writeJSON(this.file,this.entries)}}
}
export function validateLayer(input){const l={...input};if(typeof l.text!=='string'||l.text.length>300)throw Error('文字长度需在 300 字以内');for(const [k,lo,hi] of [['x',0,90],['y',0,95],['size',12,160]]){if(!Number.isFinite(l[k])||l[k]<lo||l[k]>hi)throw Error('文字位置或字号超出范围')}if(!/^#[0-9a-f]{6}$/i.test(l.color))throw Error('颜色格式无效');return {text:l.text,x:l.x,y:l.y,size:l.size,color:l.color}}
export function versionAsset(asset,changes){asset.versions.push(structuredClone({...asset.versions.at(-1),...changes,at:new Date().toISOString()}));if(asset.versions.length>100)asset.versions.shift()}
