import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readEnv} from '../backend/core.mjs';
import {comparePlanning} from '../backend/planning-compare.mjs';
import {proxyFetch} from '../backend/proxy-fetch.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir=path.join(base,'.private');
const args=process.argv.slice(2);
const value=flag=>args[args.indexOf(flag)+1];
if(!args.includes('--allow-paid')||!['glm','gpt'].includes(value('--provider'))||!/^[a-f0-9-]{36}$/.test(value('--job-id')||'')){
 console.error('用法: node scripts/compare-planning.mjs --provider glm|gpt --job-id <UUID> --allow-paid');
 process.exitCode=2;
}else{
 const provider=value('--provider'),jobId=value('--job-id');
 try{
  const state=JSON.parse(readFileSync(path.join(dataDir,'project.json'),'utf8'));
  const project=[state,...(state.archived||[])].find(item=>item.jobs?.some(job=>job.id===jobId));
  if(!project)throw Error('找不到这个历史任务');
  const job=project.jobs.find(item=>item.id===jobId);
  const env={...readEnv(path.join(base,'.env.local')),...process.env};
  const result=await comparePlanning({provider,project,job,dataDir,env,fetcher:proxyFetch});
  const outputDir=path.join(dataDir,'planning-comparisons');
  mkdirSync(outputDir,{recursive:true,mode:0o700});
  const filename=`${jobId}-${provider}-${Date.now()}.json`;
  const target=path.join(outputDir,filename);
  writeFileSync(target,JSON.stringify(result,null,2),{mode:0o600});
  console.log(JSON.stringify({provider,model:result.model,jobId,durationMs:result.durationMs,usage:result.usage,parseError:result.parseError,output:target},null,2));
 }catch(error){console.error(error.message);process.exitCode=1}
}
