import {readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashPassword} from '../backend/auth.mjs';

if(!process.stdin.isTTY)throw Error('请在交互终端运行，避免密码进入命令历史');
function ask(label,{hidden=false}={}){
 return new Promise((resolve,reject)=>{
  let value='';process.stdout.write(label);process.stdin.resume();process.stdin.setRawMode(true);
  const done=(error)=>{process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value)};
  const onData=chunk=>{for(const char of chunk.toString('utf8')){
   if(char==='\r'||char==='\n')return done();
   if(char==='\u0003')return done(Error('已取消'));
   if(char==='\u007f'){value=value.slice(0,-1);if(!hidden)process.stdout.write('\b \b');continue}
   if(char>=' '){value+=char;if(!hidden)process.stdout.write(char)}
  }};process.stdin.on('data',onData);
 });
}
const email=(await ask('登录邮箱：')).trim().toLowerCase();
if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('邮箱格式无效');
const password=await ask('登录密码（输入不显示）：',{hidden:true});
if(password.length<12)throw Error('密码至少 12 个字符');
const confirmation=await ask('再次输入密码：',{hidden:true});
if(password!==confirmation)throw Error('两次密码不一致');
const file=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','.env.local');
let contents=existsSync(file)?readFileSync(file,'utf8'):'';
const values={FORMA_LOGIN_EMAIL:email,FORMA_LOGIN_PASSWORD_HASH:hashPassword(password),FORMA_SESSION_SECRET:randomBytes(32).toString('hex')};
for(const [key,value] of Object.entries(values)){
 const line=`${key}=${value}`;
 contents=new RegExp(`^${key}=.*$`,'m').test(contents)?contents.replace(new RegExp(`^${key}=.*$`,'m'),line):contents.replace(/\s*$/,'')+'\n'+line+'\n';
}
writeFileSync(file,contents,{mode:0o600});chmodSync(file,0o600);
console.log('固定账号已写入 .env.local。重启服务后登录生效。');
