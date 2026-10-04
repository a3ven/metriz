export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url);

    // Never let an old browser/service-worker cache bypass the current app.
    // Always serve the latest index for the root and index.html.
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const res = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
      const h = new Headers(res.headers);
      h.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      h.set('Pragma','no-cache');
      h.set('Expires','0');
      return new Response(res.body,{status:res.status,statusText:res.statusText,headers:h});
    }

    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    if (url.pathname === '/sw.js') {
      h.set('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');
    } else if (/^\/(?:data\/|Icon\/)?(manifest[^/]*\.json|browserconfig\.xml|favicon\.ico|apple-touch-icon[^/]*\.png|hh-[^/]+\.(png|ico))$/.test(url.pathname)) {
      // App icons / manifest: always revalidate so a replaced icon is never stuck in an old cache.
      h.set('Cache-Control','no-cache, must-revalidate, max-age=0');
    } else if (/^\/(?:data\/)?(pricelist-|adjustment-index-|analysis-1|chapter-intro-)/.test(url.pathname)) {
      // Price-list data files are versioned by filename (e.g. pricelist-v157.json),
      // so they can be cached aggressively on the device; a future release just
      // ships a new filename and index.html (which is never cached) points to it.
      h.set('Cache-Control','public, max-age=31536000, immutable');
    }
    return new Response(res.body,{status:res.status,statusText:res.statusText,headers:h});
  }
};

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
      `ALTER TABLE users ADD COLUMN device_ids TEXT DEFAULT '[]'`
    ];
    const have=new Set(((await env.DB.prepare(`SELECT name FROM pragma_table_info('users')`).all()).results||[]).map(x=>x.name));
    for(const sql of alters){const col=sql.match(/ADD COLUMN (\w+)/)[1];if(have.has(col))continue;try{await env.DB.prepare(sql).run()}catch(e){if(!/duplicate column|already exists/i.test(e.message||'')) throw e;}}
    const admin=await env.DB.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).first();
    if(!admin){const first=await env.DB.prepare(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`).first();if(first) await env.DB.prepare(`UPDATE users SET role='admin' WHERE id=?`).bind(first.id).run();}
    const amir=await env.DB.prepare(`SELECT id FROM users WHERE LOWER(name)='amir' OR LOWER(code)='amir' LIMIT 1`).first(); if(amir) await env.DB.prepare(`UPDATE users SET role='admin',device_id=NULL,max_devices=0,device_ids='[]' WHERE id=? AND (role IS NOT 'admin' OR device_id IS NOT NULL OR max_devices IS NOT 0 OR device_ids IS NOT '[]')`).bind(amir.id).run();
  })().catch(e=>{schemaReady=null;throw e});
  return schemaReady;
}
async function isAdmin(user,env){await ensureLicenseSchema(env); const r=await env.DB.prepare(`SELECT role FROM users WHERE id=?`).bind(user.id).first();return r?.role==='admin'}
function deviceFrom(body){return String(body?.deviceId||'').trim().slice(0,180)}
function isUnlimitedAdmin(u){return String(u?.role||'').toLowerCase()==='admin' || String(u?.name||'').trim().toLowerCase()==='amir' || String(u?.code||'').trim().toLowerCase()==='amir'}

async function userFrom(request,env){
  const sid=getSession(request); if(!sid) return null;
  const h=await sha256(sid);
  const row=await env.DB.prepare(`SELECT u.id,u.code,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).bind(h,Date.now()).first();
  return row||null;
}
async function api(request,env,url){
  await ensureLicenseSchema(env);
  if(request.method==='OPTIONS') return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':'*'}});
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
      const body=await request.json(); const login=String(body.code||'').trim(); const code=login.toUpperCase(); const password=String(body.password||''); const deviceId=deviceFrom(body);
      let u=await env.DB.prepare('SELECT * FROM users WHERE LOWER(code)=LOWER(?) LIMIT 1').bind(login).first();
      // نام کاربری/نام نمایشی نیز نسبت به حروف بزرگ و کوچک حساس نیست.
      if(!u && login){
        const matches=await env.DB.prepare('SELECT * FROM users WHERE LOWER(name)=LOWER(?) LIMIT 2').bind(login).all();
        const rows=matches.results||[];
        if(rows.length===1) u=rows[0];
        else if(rows.length>1) return json({error:'این نام برای چند حساب ثبت شده است؛ لطفاً با کد یکتا وارد شوید.'},409);
      }
      if(!u) return json({error:'کد کاربری یا رمز عبور اشتباه است.'},401);
      if(Number(u.active)===0) return json({error:'این کاربر غیرفعال شده است.'},403);
      if(!isUnlimitedAdmin(u) && deviceId){
        let ids=[]; try{ids=JSON.parse(u.device_ids||'[]')}catch{}
        if(!ids.length && u.device_id) ids=[u.device_id];
        if(!ids.includes(deviceId) && ids.length>=Math.max(1,Number(u.max_devices||1))) return json({error:'ظرفیت دستگاه این حساب تکمیل است. از مدیر بخواهید ظرفیت را افزایش دهد یا دستگاه قبلی را آزاد کند.'},403);
        if(!ids.includes(deviceId)) ids.push(deviceId);
        await env.DB.prepare('UPDATE users SET device_id=?,device_ids=?,last_login=? WHERE id=?').bind(ids[0]||null,JSON.stringify(ids),Date.now(),u.id).run();
      } else await env.DB.prepare('UPDATE users SET last_login=? WHERE id=?').bind(Date.now(),u.id).run();
      const pass=await hashPassword(password,u.password_salt); if(pass!==u.password_hash) return json({error:'کد کاربری یا رمز عبور اشتباه است.'},401);
      const sid=rand(32), sh=await sha256(sid);
      await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(sh,u.id,Date.now()+2592000000).run();
      return json({ok:true,code:u.code,name:u.name,role:u.role||'user'},200,{'Set-Cookie':cookie('sid',sid)});
    }
    const user=await userFrom(request,env);
    if(url.pathname==='/api/me' && request.method==='GET'){ const full=await env.DB.prepare('SELECT id,code,name,role,active,last_login FROM users WHERE id=?').bind(user.id).first(); return full?json({ok:true,user:full}):json({ok:false},401); }
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
    if(!user) return json({error:'ابتدا وارد حساب کاربری شوید.'},401);
    if(url.pathname==='/api/admin/users' && request.method==='GET'){
      if(!(await isAdmin(user,env))) return json({error:'دسترسی مدیر لازم است.'},403);
      const rows=await env.DB.prepare('SELECT id,code,name,role,active,device_id,device_ids,max_devices,last_login,created_at FROM users ORDER BY created_at ASC').all();
      return json({users:rows.results||[]});
    }
    if(url.pathname==='/api/admin/users' && request.method==='POST'){
      if(!(await isAdmin(user,env))) return json({error:'دسترسی مدیر لازم است.'},403);
      const body=await request.json(); const name=String(body.name||'کاربر').trim().slice(0,80); const password=String(body.password||'');
      if(password.length<6) return json({error:'رمز عبور باید حداقل ۶ کاراکتر باشد.'},400);
      let code=''; for(let i=0;i<30;i++){code='A7-'+rand(6).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8); if(!(await env.DB.prepare('SELECT id FROM users WHERE code=?').bind(code).first())) break;}
      const id=crypto.randomUUID(),salt=rand(16),pass=await hashPassword(password,salt);
      await env.DB.prepare('INSERT INTO users(id,code,name,password_hash,password_salt,created_at,role,active,device_id,last_login) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,code,name,pass,salt,Date.now(),'user',1,null,null).run();
      return json({ok:true,id,code,name});
    }
    const editMatch=url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if(editMatch && request.method==='PUT'){
      if(!(await isAdmin(user,env))) return json({error:'دسترسی مدیر لازم است.'},403);
      const id=editMatch[1], target=await env.DB.prepare('SELECT id,role,name,code,max_devices FROM users WHERE id=?').bind(id).first();
      if(!target) return json({error:'کاربر پیدا نشد.'},404);
      const b=await request.json();
      const name=String(b.name??target.name).trim().slice(0,80);
      const password=String(b.password||'');
      if(!name) return json({error:'نام کاربر نمی‌تواند خالی باشد.'},400);
      if(password && password.length<6) return json({error:'رمز عبور باید حداقل ۶ کاراکتر باشد.'},400);
      let maxDevices=Number.isFinite(Number(b.max_devices))?Math.max(1,Math.min(9999,Math.floor(Number(b.max_devices)))):Number(target.max_devices||1);
      if(password){const salt=rand(16),pass=await hashPassword(password,salt); await env.DB.prepare('UPDATE users SET name=?,password_hash=?,password_salt=?,max_devices=? WHERE id=?').bind(name,pass,salt,maxDevices,id).run();}
      else await env.DB.prepare('UPDATE users SET name=?,max_devices=? WHERE id=?').bind(name,maxDevices,id).run();
      if(name.toLowerCase()==='amir') await env.DB.prepare("UPDATE users SET role='admin',device_id=NULL,max_devices=0,device_ids='[]' WHERE id=?").bind(id).run();
      return json({ok:true,max_devices:maxDevices});
    }
    const am=url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(active|device)$/);
    if(am){
      if(!(await isAdmin(user,env))) return json({error:'دسترسی مدیر لازم است.'},403);
      const id=am[1], action=am[2]; const target=await env.DB.prepare('SELECT id,role FROM users WHERE id=?').bind(id).first(); if(!target)return json({error:'کاربر پیدا نشد.'},404);
      if(action==='active' && request.method==='PUT'){const b=await request.json();await env.DB.prepare('UPDATE users SET active=? WHERE id=?').bind(b.active?1:0,id).run();return json({ok:true});}
      if(action==='device' && request.method==='DELETE'){await env.DB.prepare("UPDATE users SET device_id=NULL,device_ids='[]' WHERE id=?").bind(id).run();return json({ok:true});}
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
  }catch(e){return json({error:'خطای سرور: '+e.message},500)}
}
