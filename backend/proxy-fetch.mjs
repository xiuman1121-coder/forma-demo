import {spawn} from 'node:child_process';

// Node's fetch does not use the desktop proxy in this runtime. Keep the
// Authorization header on a private pipe, never in process arguments.
export function proxyFetch(url,options={}){
 return new Promise((resolve,reject)=>{
  const child=spawn('curl',['--silent','--show-error','--max-time','95','--config','/dev/fd/3','--data-binary','@-','--write-out','\n__FORMA_HTTP_STATUS__:%{http_code}'],{stdio:['pipe','pipe','pipe','pipe']});
  let stdout='',stderr='',settled=false;
  const fail=error=>{if(settled)return;settled=true;reject(error)};
  const stop=()=>child.kill();
  if(options.signal){if(options.signal.aborted)stop();else options.signal.addEventListener('abort',stop,{once:true})}
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>stdout+=chunk);
  child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>stderr+=chunk);
  child.on('error',fail);
  child.on('close',code=>{
   options.signal?.removeEventListener('abort',stop);
   if(settled)return;
   if(options.signal?.aborted)return fail(Error('请求已取消'));
   if(code!==0)return fail(Error(`网络请求失败（curl ${code}）：${stderr.replace(/Bearer\s+\S+/g,'Bearer [redacted]').slice(0,180)}`));
   const match=stdout.match(/\n__FORMA_HTTP_STATUS__:(\d{3})$/);
   if(!match)return fail(Error('无法读取供应商响应状态'));
   const status=Number(match[1]),body=stdout.slice(0,match.index);
   settled=true;resolve({ok:status>=200&&status<300,status,json:async()=>JSON.parse(body)});
  });
  const quote=value=>String(value).replaceAll('\\','\\\\').replaceAll('"','\\"');
  const config=[`url = "${quote(url)}"`,`request = "${quote(options.method||'POST')}"`,...Object.entries(options.headers||{}).map(([key,value])=>`header = "${quote(key+': '+value)}"`)].join('\n')+'\n';
  child.stdio[3].end(config);
  child.stdin.end(options.body||'');
 });
}
