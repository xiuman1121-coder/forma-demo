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
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 Forma</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;grid-template-columns:minmax(330px,1fr) minmax(390px,1fr);background:#f8f7f3;color:#252820;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft Yahei",sans-serif;-webkit-font-smoothing:antialiased}.intro{display:flex;flex-direction:column;justify-content:space-between;padding:45px clamp(32px,6vw,100px);background:#efeee8;border-right:1px solid #dedfd6}.brand{font:italic 600 45px/.95 Georgia,serif;letter-spacing:-.075em}.story{max-width:540px}.eyebrow{color:#68765f;font-size:11px;font-weight:600;letter-spacing:.18em}.story h1{margin:26px 0 20px;font:400 clamp(42px,4.5vw,68px)/1.24 "Songti SC","STSong",Georgia,serif;letter-spacing:-.05em}.story p{max-width:420px;color:#697164;font-size:16px;line-height:1.85}.foot{color:#8a9084;font-size:11px;letter-spacing:.06em}.login-wrap{display:grid;place-items:center;padding:45px 28px}main{width:min(400px,100%)}main h2{margin:0 0 11px;font:400 37px/1.2 "Songti SC","STSong",Georgia,serif;letter-spacing:-.04em}main>p{margin:0 0 38px;color:#777e73;font-size:13px}label{display:block;margin:20px 0 8px;color:#505a4e;font-size:12px;font-weight:600}input{display:block;width:100%;height:48px;padding:12px 14px;border:1px solid #cfd4ca;border-radius:4px;background:#fffefa;color:#252820;font:inherit;outline:none}input:focus{border-color:#788b71;box-shadow:0 0 0 2px #b6c4ae55}button{margin-top:30px;width:100%;height:48px;border:0;border-radius:4px;background:#344131;color:white;font:600 14px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;cursor:pointer}button:hover{background:#4b5e45}.error{padding:10px 12px;border-left:2px solid #aa5d49;background:#f7eee9;color:#924d3b!important;font-size:13px}@media(max-width:760px){body{grid-template-columns:1fr}.intro{min-height:240px;padding:28px 24px}.brand{font-size:36px}.story h1{font-size:37px;margin:16px 0 8px}.story p{font-size:13px;margin:0}.foot{display:none}.login-wrap{padding:50px 24px;place-items:start center}main h2{font-size:32px}}</style></head><body><section class="intro"><div class="brand">forma</div><div class="story"><div class="eyebrow">CREATIVE WORKSPACE</div><h1>让产品的好，<br>被看见。</h1><p>从一张产品图开始，规划、制作并修改一套有方向的商品视觉。</p></div><div class="foot">FORMA / A SPACE FOR VISUAL IDEAS</div></section><section class="login-wrap"><main><h2>欢迎回来</h2><p>登录后继续你的项目与作品。</p>${error?`<p class="error" role="alert">${escapeHtml(error)}</p>`:''}<form method="post" action="/login"><label for="email">邮箱</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">进入 Forma</button></form></main></section></body></html>`;
}
