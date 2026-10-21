/* ===== هدرهای امنیتی (روی همه‌ی پاسخ‌ها) ===== */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin'
};
/* CSP محافظه‌کارانه: کلیک‌جکینگ، تزریق <base>/<object> و ارسال فرم به بیرون را می‌بندد.
   (script-src عمداً نیامده چون برنامه اسکریپت inline زیاد دارد.) */
const HTML_CSP = "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'";
function secure(res, isHtml) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v);
  if (isHtml || /text\/html/i.test(h.get('content-type') || '')) h.set('Content-Security-Policy', HTML_CSP);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/* ===== دسترسی به /data/ =====
   فقط فایل‌های فهرست‌شده در DATA_RULES قابل دریافت‌اند (فایل‌های کامل pricelist-*.json هیچ‌وقت سرو نمی‌شوند).
   کاربر واردشده: تکه‌های «سال × دفترچه» با سقف روزانه/هفتگی (تعداد فایل‌های متفاوت).
   کاربر دمو (کوکی cplDemo=1): نسخه‌ی کوچک‌شده از /demo-data/ (ساخته‌شده با tools/make-data.py).
   فقط manifest های PWA عمومی‌اند. */
const PUBLIC_DATA_RE = /^\/data\/manifest(?:-light)?\.json$/;
const DATA_RULES = {
  index: /^\/data\/shard-index\.json$/,
  adj: /^\/data\/adjustment-index-v\d+\.json$/,
  shard: /^\/data\/(shard-\d{4}-\d{2,3}\.json)$/,
  analysis: /^\/data\/(analysis-\d{4}-[a-z]+-v\d+\.json)$/,
  pdf: /^\/data\/chapter-intro-[A-Za-z0-9_.-]*-chapter_(\d{2})\.pdf$/
};
const DAY_MS = 86400000;
const DEFAULT_DAY_LIMIT = 40, DEFAULT_WEEK_LIMIT = 100;
function safeDecode(p) { try { return decodeURIComponent(p); } catch { return p; } }
function isDataPath(pathname) {
  const n = safeDecode(pathname).replace(/\/{2,}/g, '/').toLowerCase();
  return n === '/data' || n.startsWith('/data/');
}

/* ---- سقف دریافت: تعداد تکه‌های «متفاوت» در روز و در ۷ روز ---- */
async function quotaCheck(env, user, name) {
  if (isUnlimitedAdmin(user)) return null;
  const day = Math.floor(Date.now() / DAY_MS);
  const dayLimit = Number(env.SHARD_DAY_LIMIT) || DEFAULT_DAY_LIMIT, weekLimit = Number(env.SHARD_WEEK_LIMIT) || DEFAULT_WEEK_LIMIT;
  const have = await env.DB.prepare('SELECT 1 AS x FROM data_access WHERE user_id=? AND day=? AND shard=?').bind(user.id, day, name).first();
  if (have) return null; /* همین تکه امروز قبلاً گرفته شده: دوباره شمرده نمی‌شود */
  const d = await env.DB.prepare('SELECT COUNT(*) AS n FROM data_access WHERE user_id=? AND day=?').bind(user.id, day).first();
  if (Number(d?.n || 0) >= dayLimit) return 'سقف دریافت داده‌ی امروز تمام شد. فردا دوباره امتحان کنید یا با مدیر تماس بگیرید.';
  const inWeek = await env.DB.prepare('SELECT 1 AS x FROM data_access WHERE user_id=? AND day>? AND shard=? LIMIT 1').bind(user.id, day - 7, name).first();
  if (!inWeek) {
    const w = await env.DB.prepare('SELECT COUNT(DISTINCT shard) AS n FROM data_access WHERE user_id=? AND day>?').bind(user.id, day - 7).first();
    if (Number(w?.n || 0) >= weekLimit) return 'سقف دریافت داده‌ی این هفته تمام شد. با مدیر تماس بگیرید.';
  }
  await env.DB.prepare('INSERT OR IGNORE INTO data_access(user_id,day,shard) VALUES(?,?,?)').bind(user.id, day, name).run();
  return null;
}

async function dataGate(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
  const p = url.pathname;
  if (PUBLIC_DATA_RE.test(p)) {
    const r = await env.ASSETS.fetch(request);
    const h = new Headers(r.headers); h.set('Cache-Control', 'no-cache, must-revalidate, max-age=0');
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
  }
  const priv = (r, extra) => {
    const h = new Headers(r.headers);
    h.set('Cache-Control', 'private, no-cache'); h.set('Vary', 'Cookie');
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
  };
  const notFound = () => json({ error: 'پیدا نشد.' }, 404, { 'Cache-Control': 'no-store' });
  let user = null;
  try { user = await userFrom(request, env); } catch { user = null; }
  if (user) {
    if (user.sub_expired) return json({ error: SUB_EXPIRED_DATA_MSG, expired: true }, 403, { 'Cache-Control': 'no-store', 'Vary': 'Cookie' });
    if (DATA_RULES.index.test(p) || DATA_RULES.adj.test(p) || DATA_RULES.pdf.test(p)) {
      const r = await env.ASSETS.fetch(request);
      return r.ok ? priv(r) : notFound();
    }
    const m = p.match(DATA_RULES.shard) || p.match(DATA_RULES.analysis);
    if (m) {
      const r = await env.ASSETS.fetch(request);
      if (!r.ok) return notFound();
      const deny = await quotaCheck(env, user, m[1]);
      if (deny) return json({ error: deny }, 429, { 'Cache-Control': 'no-store', 'Vary': 'Cookie' });
      return priv(r);
    }
    return notFound();
  }
  const demo = /(?:^|;\s*)cplDemo=1(?:;|$)/.test(request.headers.get('Cookie') || '');
  if (demo) {
    if (DATA_RULES.index.test(p) || DATA_RULES.adj.test(p) || DATA_RULES.shard.test(p) || DATA_RULES.analysis.test(p)) {
      const r = await env.ASSETS.fetch(new Request(new URL('/demo-data/' + p.slice('/data/'.length), url), request));
      if (r.ok) return priv(r);
    }
    const pm = p.match(DATA_RULES.pdf);
    if (pm && Number(pm[1]) >= 1 && Number(pm[1]) <= 7) {
      const r = await env.ASSETS.fetch(request);
      if (r.ok) return priv(r);
    }
  }
  return json({ error: 'ابتدا وارد حساب کاربری شوید.' }, 401, { 'Cache-Control': 'no-store', 'Vary': 'Cookie' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let res;
    if (url.pathname.startsWith('/api/')) res = await api(request, env, url);
    else if (isDataPath(url.pathname)) res = await dataGate(request, env, url);
    else res = await staticRoute(request, env, url);
    return secure(res, url.pathname === '/' || url.pathname === '/index.html');
  }
};

async function staticRoute(request, env, url) {
  // Never let an old browser/service-worker cache bypass the current app.
  // Always serve the latest index for the root and index.html.
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // نکته: برای '/' همان درخواست اصلی را به ASSETS می‌دهیم. اگر '/index.html' را بخواهیم، Cloudflare به '/' ریدایرکت می‌کند و حلقه‌ی ریدایرکت می‌شود.
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    h.set('Pragma', 'no-cache');
    h.set('Expires', '0');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
  const res = await env.ASSETS.fetch(request);
  const h = new Headers(res.headers);
  if (url.pathname === '/sw.js') {
    h.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  } else if (/\.(?:ttf|woff2?)$/i.test(url.pathname)) {
    // فونت‌ها: کش یک‌هفته‌ای تا با هر رفرش (مخصوصاً نت کند) دوباره اعتبارسنجی نشوند و فونت دیر نیاید. اگر فایل فونت عوض شد، نامش را هم عوض کنید.
    h.set('Cache-Control', 'public, max-age=604800');
  } else if (/^\/(?:Icon\/)?(manifest[^/]*\.json|browserconfig\.xml|favicon\.ico|apple-touch-icon[^/]*\.png|hh-[^/]+\.(png|ico))$/.test(url.pathname)) {
    // App icons / manifest: always revalidate so a replaced icon is never stuck in an old cache.
    h.set('Cache-Control', 'no-cache, must-revalidate, max-age=0');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const json = (data, status=200, extra={}) => new Response(JSON.stringify(data), {
  status, headers: {'content-type':'application/json; charset=utf-8', ...extra}
});
const enc = new TextEncoder();
function b64u(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function rand(n=32){const a=new Uint8Array(n);crypto.getRandomValues(a);return b64u(a);}
async function sha256(s){const b=await crypto.subtle.digest('SHA-256',enc.encode(s));return b64u(new Uint8Array(b));}
async function hashPassword(password,salt){
  const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(salt),iterations:100000,hash:'SHA-256'},key,256);
  return b64u(new Uint8Array(bits));
}
function cookie(name,value,maxAge=2592000){return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;}
function getSession(request){return (request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('sid='))?.slice(4)||'';}
function fromB64u(str){str=String(str).replace(/-/g,'+').replace(/_/g,'/');while(str.length%4)str+='=';const bin=atob(str);const a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a;}
let schemaReady=null;
let projectAnalysisSchemaReady=null;
async function ensureProjectAnalysisSchema(env){
  if(projectAnalysisSchemaReady) return projectAnalysisSchemaReady;
  projectAnalysisSchemaReady=(async()=>{
    const have=new Set(((await env.DB.prepare(`SELECT name FROM pragma_table_info('projects')`).all()).results||[]).map(x=>x.name));
    if(!have.has('analysis_data')){
      try{await env.DB.prepare(`ALTER TABLE projects ADD COLUMN analysis_data TEXT DEFAULT '{}'`).run();}
      catch(e){if(!/duplicate column|already exists/i.test(e.message||'')) throw e;}
    }
  })().catch(e=>{projectAnalysisSchemaReady=null;throw e});
  return projectAnalysisSchemaReady;
}
async function ensureLicenseSchema(env){
  if(schemaReady) return schemaReady;
  schemaReady=(async()=>{
    const alters=[
      `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`,
      `ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE users ADD COLUMN device_id TEXT`,
      `ALTER TABLE users ADD COLUMN last_login INTEGER`,
      `ALTER TABLE users ADD COLUMN max_devices INTEGER DEFAULT 1`,
      `ALTER TABLE users ADD COLUMN device_ids TEXT DEFAULT '[]'`,
      `ALTER TABLE users ADD COLUMN password_enc TEXT`,
      `ALTER TABLE users ADD COLUMN expires_at INTEGER`,
      `ALTER TABLE users ADD COLUMN starts_at INTEGER`,
      `ALTER TABLE users ADD COLUMN notes TEXT`,
      `ALTER TABLE users ADD COLUMN perms TEXT`
    ];
    const have=new Set(((await env.DB.prepare(`SELECT name FROM pragma_table_info('users')`).all()).results||[]).map(x=>x.name));
    for(const sql of alters){const col=sql.match(/ADD COLUMN (\w+)/)[1];if(have.has(col))continue;try{await env.DB.prepare(sql).run()}catch(e){if(!/duplicate column|already exists/i.test(e.message||'')) throw e;}}
    const sHave=new Set(((await env.DB.prepare(`SELECT name FROM pragma_table_info('sessions')`).all()).results||[]).map(x=>x.name));
    if(!sHave.has('device_id')){try{await env.DB.prepare(`ALTER TABLE sessions ADD COLUMN device_id TEXT`).run();}catch(e){if(!/duplicate column|already exists/i.test(e.message||'')) throw e;}}
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_attempts(k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS data_access(user_id TEXT NOT NULL, day INTEGER NOT NULL, shard TEXT NOT NULL, PRIMARY KEY(user_id,day,shard))`).run();
    /* رمزهای قابل‌بازیابی قدیمی (password_enc) برای همیشه پاک می‌شوند */
    await env.DB.prepare(`UPDATE users SET password_enc=NULL WHERE password_enc IS NOT NULL`).run();
    const admin=await env.DB.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).first();
    if(!admin){const first=await env.DB.prepare(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`).first();if(first) await env.DB.prepare(`UPDATE users SET role='admin' WHERE id=?`).bind(first.id).run();}
    const amir=await env.DB.prepare(`SELECT id FROM users WHERE LOWER(name)='amir' OR LOWER(code)='amir' LIMIT 1`).first(); if(amir) await env.DB.prepare(`UPDATE users SET role='admin',device_id=NULL,max_devices=0,device_ids='[]' WHERE id=? AND (role IS NOT 'admin' OR device_id IS NOT NULL OR max_devices IS NOT 0 OR device_ids IS NOT '[]')`).bind(amir.id).run();
  })().catch(e=>{schemaReady=null;throw e});
  return schemaReady;
}
async function isAdmin(user,env){await ensureLicenseSchema(env); const r=await env.DB.prepare(`SELECT role FROM users WHERE id=?`).bind(user.id).first();return r?.role==='admin'}
function deviceFrom(body){return String(body?.deviceId||'').trim().slice(0,180)}
function isUnlimitedAdmin(u){return String(u?.role||'').toLowerCase()==='admin' || String(u?.name||'').trim().toLowerCase()==='amir' || String(u?.code||'').trim().toLowerCase()==='amir'}

/* ---- اشتراک: starts_at = شروع، expires_at = پایان (هر دو میلی‌ثانیه). expires_at خالی = بدون محدودیت. مدیر (admin) همیشه نامحدود است.
   starts_at خالی = از روز ساخت حساب. روزها به وقت تهران (UTC+3:30) حساب می‌شوند؛
   expires_at لحظه‌ی «آغاز روز بعد از آخرین روز اشتراک» است (آخرین روز = expires_at - 1). ---- */
/* دسترسی بخش‌ها: perms = آرایه‌ی JSON از کلیدهای مجاز؛ خالی (null) = همه‌ی بخش‌ها. مدیر همیشه همه را دارد. */
const PERM_KEYS=['st','mn','price','cmp','base'];
function parsePerms(v,u){
  if(u&&isUnlimitedAdmin(u)) return null;
  if(v==null||v==='') return null;
  try{const a=JSON.parse(v);return Array.isArray(a)?a.filter(k=>PERM_KEYS.includes(k)):null}catch{return null}
}
function cleanPerms(a){
  if(!Array.isArray(a)) return null;
  const k=[...new Set(a.filter(x=>PERM_KEYS.includes(x)))];
  return k.length===PERM_KEYS.length?null:JSON.stringify(k);
}
const TEHRAN_OFFSET=12600000, SUB_WARN_DAYS=7;
const SUB_EXPIRED_MSG='اشتراک شما به پایان رسیده است. برای تمدید با مدیر تماس بگیرید.';
/* اشتراک تمام‌شده: ورود، دیدن پروژه‌ها و گزارش‌گیری آزاد است؛ ایجاد/ویرایش/ذخیره/حذف و داده‌های پایه بسته است */
const SUB_EXPIRED_WRITE_MSG='اشتراک شما به پایان رسیده است؛ فقط امکان مشاهده و گزارش‌گیری دارید.\nبرای تمدید با مدیر تماس بگیرید.\nSiadati7@gmail.com';
const SUB_EXPIRED_DATA_MSG='اشتراک شما به پایان رسیده است و بخش داده‌های پایه بسته است.\nبرای تمدید با مدیر تماس بگیرید.\nSiadati7@gmail.com';
function dayStart(ts){return Math.floor((Number(ts)+TEHRAN_OFFSET)/DAY_MS)*DAY_MS-TEHRAN_OFFSET} /* ۰۰:۰۰ تهرانِ همان روز */
function ymdToTs(v){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v??'').trim());if(!m)return null;const y=+m[1],mo=+m[2],d=+m[3];const t=Date.UTC(y,mo-1,d),c=new Date(t);if(c.getUTCFullYear()!==y||c.getUTCMonth()!==mo-1||c.getUTCDate()!==d)return null;return t-TEHRAN_OFFSET} /* 'YYYY-MM-DD' میلادی → ۰۰:۰۰ تهران */
function fmtFa(ts){try{return new Date(ts).toLocaleDateString('fa-IR',{timeZone:'Asia/Tehran'})}catch{return ''}}
function addMonths(ts,n){const d=new Date(Number(ts)+TEHRAN_OFFSET);const day=d.getUTCDate();d.setUTCMonth(d.getUTCMonth()+n);if(d.getUTCDate()<day)d.setUTCDate(0);return d.getTime()-TEHRAN_OFFSET}
function parseMonths(v){const n=Number(v);return Number.isFinite(n)&&n>=1&&n<=240?Math.floor(n):0}
function subExpired(u){return !isUnlimitedAdmin(u)&&u&&u.expires_at!=null&&Number(u.expires_at)<=Date.now()}
function subNotStarted(u){return !isUnlimitedAdmin(u)&&u&&u.starts_at!=null&&Number(u.starts_at)>Date.now()}
function subBlockMsg(u){
  if(subNotStarted(u)) return 'اشتراک شما از تاریخ '+fmtFa(u.starts_at)+' شروع می‌شود.';
  if(subExpired(u)) return 'اشتراک شما در تاریخ '+fmtFa(Number(u.expires_at)-1)+' به پایان رسیده است. برای تمدید با مدیر تماس بگیرید.';
  return '';
}
/* اطلاعات اشتراک برای نمایش به کاربر (و هشدار یک هفته‌ی آخر) */
function subInfo(u){
  if(!u||isUnlimitedAdmin(u)) return {unlimited:true};
  const now=Date.now();
  const s=u.starts_at!=null?Number(u.starts_at):(u.created_at!=null?dayStart(Number(u.created_at)):null);
  if(u.expires_at==null) return {unlimited:true,starts_at:s};
  const e=Number(u.expires_at), days=Math.max(0,Math.ceil((e-now)/DAY_MS));
  return {unlimited:false,starts_at:s,expires_at:e,last_day:e-1,days_left:days,warn:days>0&&days<=SUB_WARN_DAYS,expired:e<=now,now};
}

async function userFrom(request,env){
  const sid=getSession(request); if(!sid) return null;
  await ensureLicenseSchema(env);
  const h=await sha256(sid);
  const row=await env.DB.prepare(`SELECT u.id,u.code,u.name,u.role,u.expires_at,u.starts_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND COALESCE(u.active,1)<>0`).bind(h,Date.now()).first();
  if(!row) return null;
  if(subNotStarted(row)) return null; /* هنوز شروع نشده: دسترسی بسته */
  row.sub_expired=subExpired(row); /* تمام‌شده: فقط‌خواندنی (در api و dataGate اعمال می‌شود) */
  return row;
}
/* نشست معتبر ولی اشتراک بسته (تمام‌شده / هنوز شروع‌نشده)؟ برای نمایش پیام درست به‌جای «وارد شوید» */
async function sessionSubBlock(request,env){
  const sid=getSession(request); if(!sid) return null;
  const h=await sha256(sid);
  const row=await env.DB.prepare(`SELECT u.role,u.name,u.code,u.expires_at,u.starts_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND COALESCE(u.active,1)<>0`).bind(h,Date.now()).first();
  if(!row) return null;
  if(subNotStarted(row)) return {pending:true,error:subBlockMsg(row),starts_at:Number(row.starts_at)};
  return null;
}
const RL_WINDOW=900000; /* ۱۵ دقیقه */
async function rlCheck(env,keys){
  const now=Date.now();
  for(const [k,limit] of keys){
    const r=await env.DB.prepare('SELECT n,reset_at FROM login_attempts WHERE k=?').bind(k).first();
    if(r && r.reset_at>now && r.n>=limit) return Math.ceil((r.reset_at-now)/1000);
  }
  return 0;
}
async function rlFail(env,keys){
  const now=Date.now();
  await env.DB.batch(keys.map(([k])=>env.DB.prepare('INSERT INTO login_attempts(k,n,reset_at) VALUES(?,1,?) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN reset_at<=? THEN 1 ELSE n+1 END, reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END').bind(k,now+RL_WINDOW,now,now,now+RL_WINDOW)));
}
async function api(request,env,url){
  await ensureLicenseSchema(env);
  if(request.method==='OPTIONS') return new Response(null,{status:204});
  try{
    if(url.pathname==='/api/register' && request.method==='POST'){
      const body=await request.json(); const password=String(body.password||''); const name=String(body.name||'').trim().slice(0,80); const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first(); if(Number(count?.n||0)>0) return json({error:'ساخت کاربر فقط از پنل مدیریت انجام می‌شود.'},403);
      if(password.length<6) return json({error:'رمز عبور باید حداقل ۶ کاراکتر باشد.'},400);
      let code='';
      for(let i=0;i<20;i++){code='A7-'+rand(5).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,7); if(code.length<5) continue; const ex=await env.DB.prepare('SELECT id FROM users WHERE code=?').bind(code).first(); if(!ex) break;}
      const salt=rand(16), pass=await hashPassword(password,salt), id=crypto.randomUUID();
      await env.DB.prepare('INSERT INTO users(id,code,name,password_hash,password_salt,created_at,role,active,device_id,last_login) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,code,name||'مدیر',pass,salt,Date.now(),'admin',1,deviceFrom(body),Date.now()).run();
      const sid=rand(32), sh=await sha256(sid);
      await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(sh,id,Date.now()+2592000000).run();
      return json({ok:true,code,name:name||'کاربر' },200,{'Set-Cookie':cookie('sid',sid)});
    }
    if(url.pathname==='/api/login' && request.method==='POST'){
      const body=await request.json(); const login=String(body.code||'').trim().slice(0,120); const password=String(body.password||'').slice(0,200); const deviceId=deviceFrom(body);
      const ip=request.headers.get('CF-Connecting-IP')||'unknown', lk=login.toLowerCase();
      const rlKeys=[['u:'+ip+':'+lk,8],['a:'+lk,30],['ip:'+ip,40]];
      const wait=await rlCheck(env,rlKeys);
      if(wait) return json({error:'تعداد تلاش‌های ناموفق زیاد است. حدود '+Math.max(1,Math.ceil(wait/60))+' دقیقه بعد دوباره تلاش کنید.'},429,{'Retry-After':String(wait)});
      const bad=async()=>{await rlFail(env,rlKeys);return json({error:'کد کاربری یا رمز عبور اشتباه است.'},401);};
      let u=await env.DB.prepare('SELECT * FROM users WHERE LOWER(code)=LOWER(?) LIMIT 1').bind(login).first();
      // نام کاربری/نام نمایشی نیز نسبت به حروف بزرگ و کوچک حساس نیست.
      if(!u && login){
        const matches=await env.DB.prepare('SELECT * FROM users WHERE LOWER(name)=LOWER(?) LIMIT 2').bind(login).all();
        const rows=matches.results||[];
        if(rows.length===1) u=rows[0];
      }
      if(!u){await hashPassword(password,'x'.repeat(16)); return bad();} /* هم‌زمان‌سازی زمان پاسخ تا وجود/عدم وجود کاربر لو نرود */
      const pass=await hashPassword(password,u.password_salt); if(pass!==u.password_hash) return bad();
      if(Number(u.active)===0) return json({error:'این کاربر غیرفعال شده است.'},403);
      if(subNotStarted(u)) return json({error:subBlockMsg(u),pending:true,starts_at:Number(u.starts_at)},403);
      const unlimited=isUnlimitedAdmin(u);
      if(!unlimited){
        if(!deviceId) return json({error:'شناسه دستگاه ارسال نشد؛ صفحه را رفرش کنید و دوباره وارد شوید.'},400);
        let ids=[]; try{ids=JSON.parse(u.device_ids||'[]')}catch{}
        if(!ids.length && u.device_id) ids=[u.device_id];
        if(!ids.includes(deviceId) && ids.length>=Math.max(1,Number(u.max_devices||1))) return json({error:'ظرفیت دستگاه این حساب تکمیل است. از مدیر بخواهید ظرفیت را افزایش دهد یا دستگاه قبلی را آزاد کند.'},403);
        if(!ids.includes(deviceId)) ids.push(deviceId);
        await env.DB.prepare('UPDATE users SET device_id=?,device_ids=?,last_login=? WHERE id=?').bind(ids[0]||null,JSON.stringify(ids),Date.now(),u.id).run();
        /* هر دستگاه فقط یک نشست فعال دارد */
        await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND device_id=?').bind(u.id,deviceId).run();
      } else await env.DB.prepare('UPDATE users SET last_login=? WHERE id=?').bind(Date.now(),u.id).run();
      await env.DB.prepare('DELETE FROM login_attempts WHERE k=?').bind(rlKeys[0][0]).run();
      await env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()).run();
      await env.DB.prepare('DELETE FROM login_attempts WHERE reset_at<?').bind(Date.now()).run();
      await env.DB.prepare('DELETE FROM data_access WHERE day<?').bind(Math.floor(Date.now()/DAY_MS)-30).run();
      const sid=rand(32), sh=await sha256(sid);
      await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,device_id) VALUES(?,?,?,?)').bind(sh,u.id,Date.now()+2592000000,unlimited?null:deviceId).run();
      return json({ok:true,code:u.code,name:u.name,role:u.role||'user',perms:parsePerms(u.perms,u),sub:subInfo(u)},200,{'Set-Cookie':cookie('sid',sid)});
    }
    const user=await userFrom(request,env);
    if(url.pathname==='/api/me' && request.method==='GET'){ if(!user){ const blk=await sessionSubBlock(request,env); if(blk) return json({ok:false,...blk},401); return json({ok:false,error:'ابتدا وارد حساب کاربری شوید.'},401); } const full=await env.DB.prepare('SELECT id,code,name,role,active,last_login,expires_at,starts_at,created_at,perms FROM users WHERE id=?').bind(user.id).first(); if(full) full.perms=parsePerms(full.perms,full); return full?json({ok:true,user:full,sub:subInfo(full)},200,{'Cache-Control':'no-store'}):json({ok:false},401); }
    if(url.pathname==='/api/logout' && request.method==='POST'){
      const sid=getSession(request); let deviceId=''; try{const body=await request.json(); deviceId=deviceFrom(body)}catch{}
      if(sid){
        const sh=await sha256(sid);
        const sess=await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash=?').bind(sh).first();
        if(sess?.user_id && deviceId){
          const u=await env.DB.prepare('SELECT role,device_id,device_ids FROM users WHERE id=?').bind(sess.user_id).first();
          if(u && !isUnlimitedAdmin(u)){
            let ids=[]; try{ids=JSON.parse(u.device_ids||'[]')}catch{}
            if(!ids.length && u.device_id) ids=[u.device_id];
            ids=ids.filter(x=>String(x)!==String(deviceId));
            await env.DB.prepare('UPDATE users SET device_id=?,device_ids=? WHERE id=?').bind(ids[0]||null,JSON.stringify(ids),sess.user_id).run();
          }
        }
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(sh).run();
      }
      return json({ok:true},200,{'Set-Cookie':cookie('sid','',0)});
    }
    if(!user){ const blk=await sessionSubBlock(request,env); if(blk) return json(blk,401); return json({error:'ابتدا وارد حساب کاربری شوید.'},401); }
    if(user.sub_expired){
      const p=url.pathname, m=request.method;
      const readOk=m==='GET'&&(p==='/api/projects'||/^\/api\/projects\/[^/]+(\/analysis)?$/.test(p));
      if(!readOk&&p!=='/api/me/password') return json({error:SUB_EXPIRED_WRITE_MSG,expired:true},403);
    }
    if(url.pathname==='/api/me/password' && request.method==='PUT'){
      const body=await request.json(); const password=String(body.password||'');
      if(password.length<6) return json({error:'رمز عبور باید حداقل ۶ کاراکتر باشد.'},400);
      const salt=rand(16), pass=await hashPassword(password,salt);
      await env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,password_enc=NULL WHERE id=?').bind(pass,salt,user.id).run();
      /* نشست‌های دیگر این کاربر بسته می‌شود؛ نشست فعلی می‌ماند */
      const cur=await sha256(getSession(request));
      await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(user.id,cur).run();
      return json({ok:true});
    }
    if(url.pathname==='/api/admin/usage' && request.method==='GET'){
      if(!(await isAdmin(user,env))) return json({error:'دسترسی مدیر لازم است.'},403);
      const day=Math.floor(Date.now()/DAY_MS);
      const rows=await env.DB.prepare('SELECT u.name AS name,u.code AS code,(SELECT COUNT(*) FROM data_access a WHERE a.user_id=u.id AND a.day=?) AS today,(SELECT COUNT(DISTINCT a.shard) FROM data_access a WHERE a.user_id=u.id AND a.day>?) AS week FROM users u ORDER BY week DESC').bind(day,day-7).all();
      return json({limits:{day:Number(env.SHARD_DAY_LIMIT)||DEFAULT_DAY_LIMIT,week:Number(env.SHARD_WEEK_LIMIT)||DEFAULT_WEEK_LIMIT},users:rows.results||[]});
    }
    if(url.pathname==='/api/admin/users' && request.method==='GET'){
      if(!(await isAdmin(user,env))) return json({error:'دسترسی مدیر لازم است.'},403);
      /* رمز کاربران دیگر قابل نمایش نیست (فقط هش ذخیره می‌شود). برای کاربر رمز تازه تعیین کن. */
      const rows=await env.DB.prepare('SELECT id,code,name,role,active,device_id,device_ids,max_devices,last_login,created_at,expires_at,starts_at,notes,perms FROM users ORDER BY created_at ASC').all();
      return json({users:(rows.results||[]).map(r=>({...r,perms:parsePerms(r.perms,r)}))});
    }
    if(url.pathname==='/api/admin/users' && request.method==='POST'){
      if(!(await isAdmin(user,env))) return json({error:'دسترسی مدیر لازم است.'},403);
      const body=await request.json(); const name=String(body.name||'کاربر').trim().slice(0,80); const password=String(body.password||'');
      if(password.length<6) return json({error:'رمز عبور باید حداقل ۶ کاراکتر باشد.'},400);
      let code=''; for(let i=0;i<30;i++){code='A7-'+rand(6).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8); if(!(await env.DB.prepare('SELECT id FROM users WHERE code=?').bind(code).first())) break;}
      const id=crypto.randomUUID(),salt=rand(16),pass=await hashPassword(password,salt);
      /* تاریخ شروع (YYYY-MM-DD میلادی)؛ خالی = امروز. مدت اشتراک از تاریخ شروع حساب می‌شود. ماه خالی = بدون محدودیت زمانی */
      let startsAt=dayStart(Date.now());
      if(body.start!==undefined&&body.start!==null&&body.start!==''){startsAt=ymdToTs(body.start); if(startsAt==null) return json({error:'تاریخ شروع نامعتبر است.'},400);}
      const months=parseMonths(body.months); let expiresAt=months?addMonths(startsAt,months):null;
      if(body.end!==undefined&&body.end!==null&&body.end!==''){const et=ymdToTs(body.end); if(et==null) return json({error:'تاریخ پایان نامعتبر است.'},400); expiresAt=et+DAY_MS;}
      if(expiresAt!=null&&expiresAt<=startsAt) return json({error:'تاریخ پایان باید بعد از تاریخ شروع باشد.'},400);
      await env.DB.prepare('INSERT INTO users(id,code,name,password_hash,password_salt,created_at,role,active,device_id,last_login,expires_at,starts_at,notes,perms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,code,name,pass,salt,Date.now(),'user',1,null,null,expiresAt,startsAt,String(body.notes||'').trim().slice(0,2000)||null,cleanPerms(body.perms)).run();
      return json({ok:true,id,code,name,starts_at:startsAt,expires_at:expiresAt});
    }
    const editMatch=url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if(editMatch && request.method==='DELETE'){
      if(!(await isAdmin(user,env))) return json({error:'دسترسی مدیر لازم است.'},403);
      const id=editMatch[1];
      if(id===user.id) return json({error:'نمی‌توانید حساب خودتان را حذف کنید.'},400);
      const target=await env.DB.prepare('SELECT id,role,name,code FROM users WHERE id=?').bind(id).first();
      if(!target) return json({error:'کاربر پیدا نشد.'},404);
      if(isUnlimitedAdmin(target)) return json({error:'حساب مدیر قابل حذف نیست.'},403);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
        env.DB.prepare('DELETE FROM projects WHERE user_id=?').bind(id),
        env.DB.prepare('DELETE FROM users WHERE id=?').bind(id)
      ]);
      return json({ok:true});
    }
    if(editMatch && request.method==='PUT'){
      if(!(await isAdmin(user,env))) return json({error:'دسترسی مدیر لازم است.'},403);
      const id=editMatch[1], target=await env.DB.prepare('SELECT id,role,name,code,max_devices,expires_at,starts_at,created_at FROM users WHERE id=?').bind(id).first();
      if(!target) return json({error:'کاربر پیدا نشد.'},404);
      const b=await request.json();
      const name=String(b.name??target.name).trim().slice(0,80);
      const password=String(b.password||'');
      if(!name) return json({error:'نام کاربر نمی‌تواند خالی باشد.'},400);
      if(password && password.length<6) return json({error:'رمز عبور باید حداقل ۶ کاراکتر باشد.'},400);
      let maxDevices=Number.isFinite(Number(b.max_devices))?Math.max(1,Math.min(9999,Math.floor(Number(b.max_devices)))):Number(target.max_devices||1);
      if(password){const salt=rand(16),pass=await hashPassword(password,salt); await env.DB.prepare('UPDATE users SET name=?,password_hash=?,password_salt=?,max_devices=?,password_enc=NULL WHERE id=?').bind(name,pass,salt,maxDevices,id).run();
        /* با تغییر رمز توسط مدیر، همه‌ی نشست‌های قبلی آن کاربر بسته می‌شود (به‌جز نشست خود مدیر) */
        if(id===user.id) await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(id,await sha256(getSession(request))).run();
        else await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();}
      else await env.DB.prepare('UPDATE users SET name=?,max_devices=? WHERE id=?').bind(name,maxDevices,id).run();
      if(b.perms!==undefined&&!isUnlimitedAdmin(target)) await env.DB.prepare('UPDATE users SET perms=? WHERE id=?').bind(cleanPerms(b.perms),id).run();
      if(b.notes!==undefined) await env.DB.prepare('UPDATE users SET notes=? WHERE id=?').bind(String(b.notes||'').trim().slice(0,2000)||null,id).run();
      if(name.toLowerCase()==='amir') await env.DB.prepare("UPDATE users SET role='admin',device_id=NULL,max_devices=0,device_ids='[]' WHERE id=?").bind(id).run();
      /* اشتراک (برای مدیر اعمال نمی‌شود):
         start = تاریخ شروع (YYYY-MM-DD میلادی؛ خالی = از روز ساخت حساب)
         end   = آخرین روز اشتراک (YYYY-MM-DD) — هر کاربری (حتی نامحدود) را محدود می‌کند
         months = تمدید: از پایان اشتراک فعلی (اگر هنوز تمام نشده)، وگرنه از امروز/تاریخ شروع
         clear_expiry = حذف محدودیت (نامحدود) */
      let newStart=target.starts_at, newExp=target.expires_at;
      if(!isUnlimitedAdmin(target)){
        if(b.start!==undefined){
          if(b.start===null||b.start==='') newStart=null;
          else{const t=ymdToTs(b.start); if(t==null) return json({error:'تاریخ شروع نامعتبر است.'},400); newStart=t;}
        }
        if(b.clear_expiry===true) newExp=null;
        else if(b.end!==undefined&&b.end!==null&&b.end!==''){
          const t=ymdToTs(b.end); if(t==null) return json({error:'تاریخ پایان نامعتبر است.'},400); newExp=t+DAY_MS;
        }
        else if(b.months!==undefined&&b.months!==null&&b.months!==''){
          const m=parseMonths(b.months); if(!m) return json({error:'تعداد ماه باید عددی بین ۱ تا ۲۴۰ باشد.'},400);
          const base=Math.max(dayStart(Date.now()),Number(newStart)||0,Number(target.expires_at)||0); newExp=addMonths(base,m);
        }
        const effStart=newStart!=null?Number(newStart):dayStart(Number(target.created_at)||Date.now());
        if(newExp!=null&&Number(newExp)<=effStart) return json({error:'تاریخ پایان باید بعد از تاریخ شروع باشد.'},400);
        if(newExp!==target.expires_at||newStart!==target.starts_at) await env.DB.prepare('UPDATE users SET expires_at=?,starts_at=? WHERE id=?').bind(newExp,newStart,id).run();
      }
      return json({ok:true,max_devices:maxDevices,starts_at:newStart,expires_at:newExp});
    }
    const am=url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(active|device)$/);
    if(am){
      if(!(await isAdmin(user,env))) return json({error:'دسترسی مدیر لازم است.'},403);
      const id=am[1], action=am[2]; const target=await env.DB.prepare('SELECT id,role FROM users WHERE id=?').bind(id).first(); if(!target)return json({error:'کاربر پیدا نشد.'},404);
      if(action==='active' && request.method==='PUT'){const b=await request.json();await env.DB.prepare('UPDATE users SET active=? WHERE id=?').bind(b.active?1:0,id).run();return json({ok:true});}
      if(action==='device' && request.method==='DELETE'){await env.DB.batch([env.DB.prepare("UPDATE users SET device_id=NULL,device_ids='[]' WHERE id=?").bind(id),env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id)]);return json({ok:true});}
    }
    if(url.pathname==='/api/projects' && request.method==='GET'){
      // فقط فیلدهای لازم داخل خود SQLite استخراج می‌شوند؛ دیگر دادهٔ کامل همهٔ پروژه‌ها (تا ۵ مگابایت هرکدام) به Worker نمی‌آید و JSON.parse نمی‌شود.
      const jx=p=>`CASE WHEN json_valid(data) THEN json_extract(data,'${p}') END`;
      const rows=await env.DB.prepare(`SELECT id,name,updated_at,created_at,${jx('$.parentProjectId')} AS pp1,${jx('$.project.parentProjectId')} AS pp2,${jx('$.projectType')} AS pt1,${jx('$.project.type')} AS pt2,${jx('$.calculationName')} AS cn1,${jx('$.project.calculationName')} AS cn2 FROM projects WHERE user_id=? ORDER BY updated_at DESC`).bind(user.id).all();
      const projects=(rows.results||[]).map(r=>{const pp=r.pp1||r.pp2||null;return {id:r.id,name:r.name,updated_at:r.updated_at,created_at:r.created_at,parentProjectId:pp,projectType:r.pt1||r.pt2||(pp?'calculation':'main'),calculationName:r.cn1||r.cn2||''};});
      return json({projects});
    }
    if(url.pathname==='/api/projects' && request.method==='POST'){
      const body=await request.json(); const name=String(body.name||'پروژه بدون نام').trim().slice(0,120); const data=String(body.data||'');
      if(data.length>5000000) return json({error:'حجم پروژه بیش از حد مجاز است.'},413);
      const id=crypto.randomUUID(), now=Date.now();
      await env.DB.prepare('INSERT INTO projects(id,user_id,name,data,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(id,user.id,name,data,now,now).run();
      return json({ok:true,id,name,updated_at:now});
    }
    const pma=url.pathname.match(/^\/api\/projects\/([^/]+)\/analysis$/);
    if(pma){
      await ensureProjectAnalysisSchema(env);
      const id=pma[1];
      const own=await env.DB.prepare('SELECT id,name,data,analysis_data FROM projects WHERE id=? AND user_id=?').bind(id,user.id).first();
      if(!own) return json({error:'پروژه پیدا نشد.'},404);
      if(request.method==='GET'){
        let a={};
        try{a=JSON.parse(own.analysis_data||'{}')||{};}catch{}
        /* مهاجرت خواندنی: پروژه‌های قدیمی ممکن است آنالیز را هنوز داخل data داشته باشند. */
        if(!Object.keys(a).length){
          try{
            const d=JSON.parse(own.data||'{}');
            a={
              analysisOverrides:d.analysisOverrides||{},
              analysisCustomRows:d.analysisCustomRows||{},
              analysisItemMeta:d.analysisItemMeta||{},
              analysisPageState:d.analysisPageState||{}
            };
          }catch{}
        }
        return json({analysis:a});
      }
      if(request.method==='PUT'){
        const body=await request.json();
        const a={
          analysisOverrides:(body.analysisOverrides&&typeof body.analysisOverrides==='object')?body.analysisOverrides:{},
          analysisCustomRows:(body.analysisCustomRows&&typeof body.analysisCustomRows==='object')?body.analysisCustomRows:{},
          analysisItemMeta:(body.analysisItemMeta&&typeof body.analysisItemMeta==='object')?body.analysisItemMeta:{},
          analysisPageState:(body.analysisPageState&&typeof body.analysisPageState==='object')?body.analysisPageState:{}
        };
        const aj=JSON.stringify(a);
        if(aj.length>5000000)return json({error:'حجم اطلاعات آنالیز بیش از حد مجاز است.'},413);
        /* فقط بار اول، آنالیز قدیمی را از data اصلی جدا می‌کنیم تا پروژه‌های موجود سبک شوند. */
        let cleanData=own.data||'';
        try{
          const d=JSON.parse(cleanData||'{}');
          if(d && typeof d==='object'){
            delete d.analysisOverrides;
            delete d.analysisCustomRows;
            delete d.analysisItemMeta;
            delete d.analysisPageState;
            cleanData=JSON.stringify(d);
          }
        }catch{}
        await env.DB.prepare('UPDATE projects SET data=?,analysis_data=?,updated_at=? WHERE id=? AND user_id=?')
          .bind(cleanData,aj,Date.now(),id,user.id).run();
        return json({ok:true,updated_at:Date.now()});
      }
      return json({error:'متد نامعتبر است.'},405);
    }
    const pm=url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if(pm){
      const id=pm[1];
      const own=await env.DB.prepare('SELECT id,name,data,created_at,updated_at FROM projects WHERE id=? AND user_id=?').bind(id,user.id).first();
      if(!own) return json({error:'پروژه پیدا نشد.'},404);
      if(request.method==='GET') return json({project:own});
      if(request.method==='PUT'){
        const body=await request.json(); const name=String(body.name||own.name).trim().slice(0,120);
        // Rename only (no data sent): keep the stored data, never blank it; patch the name stored inside the JSON too.
        if(body.renameOnly===true && (body.data===undefined||body.data===null)){
          if(!name) return json({error:'نام نمی‌تواند خالی باشد.'},400);
          let data=own.data;
          try{
            const d=JSON.parse(own.data||'{}');
            if(d && typeof d==='object'){
              if(body.calculationName!==undefined){const cn=String(body.calculationName||'').trim().slice(0,120); d.calculationName=cn; if(d.project&&typeof d.project==='object') d.project.calculationName=cn;}
              data=JSON.stringify(d);
            }
          }catch{}
          // keep updated_at so a rename does not reorder the history list
          await env.DB.prepare('UPDATE projects SET name=?,data=? WHERE id=? AND user_id=?').bind(name,data,id,user.id).run();
          return json({ok:true,updated_at:own.updated_at});
        }
        const data=String(body.data||'');
        if(data.length>5000000) return json({error:'حجم پروژه بیش از حد مجاز است.'},413);
        const now=Date.now(); await env.DB.prepare('UPDATE projects SET name=?,data=?,updated_at=? WHERE id=? AND user_id=?').bind(name,data,now,id,user.id).run();
        return json({ok:true,updated_at:now});
      }
      if(request.method==='DELETE'){await env.DB.prepare('DELETE FROM projects WHERE id=? AND user_id=?').bind(id,user.id).run();return json({ok:true});}
    }
    return json({error:'مسیر نامعتبر است.'},404);
  }catch(e){console.error('api error',url.pathname,e&&e.message);return json({error:'خطای سرور. دوباره تلاش کنید.'},500)}
}
