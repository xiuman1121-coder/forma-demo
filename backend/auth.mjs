import {createHmac,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';

const SESSION_SECONDS=12*60*60;
const safeEqual=(a,b)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right)};
const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function hashPassword(password){const salt=randomBytes(16).toString('hex');return `scrypt:${salt}:${scryptSync(password,salt,64).toString('hex')}`}

export function createAuth(env={}){
 const email=String(env.FORMA_LOGIN_EMAIL||'').trim().toLowerCase();
 const hash=String(env.FORMA_LOGIN_PASSWORD_HASH||'');
 const secret=String(env.FORMA_SESSION_SECRET||'');
 const enabled=Boolean(email&&/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash)&&secret.length>=32);
 const [,,salt,digest]=hash.match(/^(scrypt):([a-f0-9]{32}):([a-f0-9]{128})$/)||[];
 const signature=payload=>createHmac('sha256',secret).update(payload).digest('base64url');
 const cookieName='forma_session';
 const verify=req=>{
  if(!enabled)return false;
  const token=(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  const [payload,mac,...rest]=String(token||'').split('.');
  if(!payload||!mac||rest.length||!safeEqual(mac,signature(payload)))return false;
  const [expiry,user]=Buffer.from(payload,'base64url').toString('utf8').split(':');
  return Number.isSafeInteger(Number(expiry))&&Number(expiry)>Date.now()&&user===email;
 };
 const checkPassword=(submittedEmail,password)=>{
  const candidate=scryptSync(String(password),salt||'0'.repeat(32),64).toString('hex');
  return enabled&&safeEqual(String(submittedEmail).trim().toLowerCase(),email)&&safeEqual(candidate,digest);
 };
 const issue=(secure)=>{
  const payload=Buffer.from(`${Date.now()+SESSION_SECONDS*1000}:${email}`).toString('base64url');
  return `${cookieName}=${payload}.${signature(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure?'; Secure':''}`;
 };
 const clear=(secure)=>`${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure?'; Secure':''}`;
 return {enabled,verify,checkPassword,issue,clear};
}

export function loginPage(error=''){
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 Forma</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8f4;color:#283127;font:16px system-ui,sans-serif}main{box-sizing:border-box;width:min(420px,calc(100vw - 36px));padding:40px;background:white;border:1px solid #dce4d4;border-radius:22px}h1{margin:0 0 28px;font-size:30px}label{display:block;margin:18px 0 8px}input{box-sizing:border-box;width:100%;padding:14px;border:1px solid #bdc9b5;border-radius:10px;font:inherit}button{margin-top:26px;width:100%;padding:14px;border:0;border-radius:10px;background:#293b2b;color:white;font:inherit;cursor:pointer}.error{color:#a33}</style></head><body><main><h1>登录 Forma</h1>${error?`<p class="error" role="alert">${escapeHtml(error)}</p>`:''}<form method="post" action="/login"><label for="email">邮箱</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">登录</button></form></main></body></html>`;
}
