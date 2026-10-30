import {chmodSync,mkdirSync,readdirSync,readFileSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';

const RETENTION_MS=7*24*60*60*1000;
const MAX_RECORD_BYTES=2*1024*1024;
const MAX_EVENTS=300;
const disabled=()=>{};

export function debugTraceEnabled(env={}){
 return String(env.FORMA_DEBUG_TRACE??process.env.FORMA_DEBUG_TRACE??'').toLowerCase()==='1';
}

export function createDebugTrace({dataDir,jobId,projectId,env={}}){
 if(!debugTraceEnabled(env))return disabled;
 const dir=path.join(dataDir,'debug-traces');
 try{
  mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
  const now=Date.now();
  for(const name of readdirSync(dir)){
   if(!/^[a-f0-9-]+\.json$/.test(name))continue;
   const file=path.join(dir,name);
   try{if(now-statSync(file).mtimeMs>RETENTION_MS)unlinkSync(file)}catch{}
  }
 }catch{return disabled}
 const file=path.join(dir,`${jobId}.json`);
 const secrets=[env.ZHIPU_API_KEY,env.ARK_API_KEY,env.OPENAI_API_KEY,process.env.ZHIPU_API_KEY,process.env.ARK_API_KEY,process.env.OPENAI_API_KEY].filter(value=>typeof value==='string'&&value.length>3);
 const cleanString=value=>{
  let text=String(value);
  for(const secret of secrets)text=text.split(secret).join('[REDACTED_SECRET]');
  return text.replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gi,'[IMAGE_BASE64_REDACTED]')
   .replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]')
   .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g,'[REDACTED_SECRET]');
 };
 const scrub=(value,depth=0)=>{
  if(depth>12)return '[DEPTH_LIMIT]';
  if(typeof value==='string')return cleanString(value);
  if(Array.isArray(value))return value.map(item=>scrub(item,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[
   key,/(authorization|api.?key|secret|b64_json|access.?token)/i.test(key)?'[REDACTED_SECRET]':scrub(item,depth+1)
  ]));
  return value;
 };
 const record={version:1,jobId,projectId,createdAt:new Date().toISOString(),retentionDays:7,events:[]};
 const write=()=>{const bytes=Buffer.from(JSON.stringify(record,null,2));if(bytes.length>MAX_RECORD_BYTES)return false;writeFileSync(file,bytes,{mode:0o600});chmodSync(file,0o600);return true};
 try{write()}catch{return disabled}
 return (stage,detail={})=>{
  try{
   if(record.events.length>=MAX_EVENTS)return;
   const entry={stage,at:new Date().toISOString(),...scrub(detail)};
   record.events.push(entry);
   if(!write()){
    record.events.pop();record.events.push({stage:'trace_limit',at:new Date().toISOString(),reason:'2 MiB file limit'});
    write();
   }
  }catch{/* Diagnostics must never change task execution. */}
 };
}

export function readDebugTrace(file){return JSON.parse(readFileSync(file,'utf8'))}
