/* METRIZ — لایه‌ی آفلاین (خواندن و نوشتن)
   ایده: همه‌ی ذخیره‌ها اول روی دستگاه (IndexedDB) انجام می‌شود؛ اگر اینترنت بود فوراً به سرور می‌رود، اگر نبود
   در صف (outbox) می‌ماند و با برگشتن اینترنت به‌ترتیب ارسال می‌شود.
   - window.__offline.request(path, opt) جای fetch در api() است (فقط مسیرهای /api/projects...).
   - /api/me در حالت آفلاین از نسخه‌ی ذخیره‌شده‌ی کاربر جواب می‌دهد (حداکثر MAX_OFFLINE_DAYS روز از آخرین تأیید آنلاین).
   - رمز عبور هیچ‌جا ذخیره نمی‌شود؛ ورود با رمز فقط آنلاین ممکن است. */
(function () {
  'use strict';
  if (window.__offline) return;

  var MAX_OFFLINE_DAYS = 14, DAY = 86400000;
  var NET_TIMEOUT = 30000, PREFETCH_MAX = 60;
  var EXPIRED_MSG = 'اشتراک شما به پایان رسیده است؛ فقط امکان مشاهده و گزارش‌گیری دارید.\nبرای تمدید با مدیر تماس بگیرید.';
  var NO_NET_MSG = 'اتصال اینترنت برقرار نیست.';
  var NOT_CACHED_MSG = 'این مورد روی این دستگاه ذخیره نشده و در حالت آفلاین در دسترس نیست. یک‌بار با اینترنت بازش کنید.';
  var rawFetch = window.fetch.bind(window);

  /* ---------- IndexedDB ---------- */
  var idbReady = new Promise(function (res) {
    try {
      if (!window.indexedDB) return res(null);
      var rq = indexedDB.open('metriz-offline', 1);
      rq.onupgradeneeded = function () {
        var d = rq.result;
        d.createObjectStore('kv');
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('analysis', { keyPath: 'id' });
        d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = rq.onblocked = function () { res(null); };
    } catch (e) { res(null); }
  });
  function op(store, mode, fn) {
    return idbReady.then(function (db) {
      if (!db) throw new Error('idb');
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode), r = fn(t.objectStore(store));
        t.oncomplete = function () { res(r && r.result); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  function kvGet(k) { return op('kv', 'readonly', function (s) { return s.get(k); }).catch(function () { return undefined; }); }
  function kvSet(k, v) { return op('kv', 'readwrite', function (s) { return s.put(v, k); }).catch(function () {}); }
  function kvDel(k) { return op('kv', 'readwrite', function (s) { return s.delete(k); }).catch(function () {}); }
  function getRec(store, id) { return op(store, 'readonly', function (s) { return s.get(id); }).catch(function () { return undefined; }); }
  function putRec(store, v) { return op(store, 'readwrite', function (s) { return s.put(v); }).catch(function () {}); }
  function delRec(store, id) { return op(store, 'readwrite', function (s) { return s.delete(id); }).catch(function () {}); }
  function allRecs(store) { return op(store, 'readonly', function (s) { return s.getAll(); }).catch(function () { return []; }); }
  function clearStore(store) { return op(store, 'readwrite', function (s) { return s.clear(); }).catch(function () {}); }

  /* ---------- وضعیت ---------- */
  var cur = null;                       /* {key,user,sub,verifiedAt} کاربر آخرین ورود تأییدشده */
  var st = { online: navigator.onLine !== false, syncing: false, pending: 0, needLogin: false, expired: false };
  var inflightSeq = 0, inflightPid = '';
  var flushing = false, retryTimer = null, retryN = 0, pendingLogout = false;
  var chain = Promise.resolve();
  function lock(fn) { var p = chain.then(fn, fn); chain = p.catch(function () {}); return p; }
  function demo() { return !!window.DEMO_MODE; }
  function uuid() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function keyOf(u) { return u && u.code ? String(u.code).toLowerCase() : ''; }
  function writeBlocked() {
    var s = cur && cur.sub;
    if (!s || s.unlimited) return false;
    return s.expires_at != null && Number(s.expires_at) <= Date.now();
  }
  function offlineSub(sub) {
    if (!sub || sub.unlimited) return sub;
    var s = Object.assign({}, sub), now = Date.now();
    if (s.expires_at != null) {
      s.expired = Number(s.expires_at) <= now;
      s.days_left = Math.max(0, Math.ceil((Number(s.expires_at) - now) / DAY));
      s.warn = !s.expired && s.days_left <= 7;
      s.now = now;
    }
    return s;
  }

  /* ---------- شبکه ---------- */
  function NetErr(msg) { var e = new Error(msg || NO_NET_MSG); e.net = true; return e; }
  async function net(path, method, body) {
    if (navigator.onLine === false) { st.online = false; throw NetErr(); }
    var ac = new AbortController(), t = setTimeout(function () { ac.abort(); }, NET_TIMEOUT), r, d = {};
    try {
      r = await rawFetch(path, { method: method, credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal });
      try { d = await r.json(); } catch (e) { if (r.ok) throw NetErr(); }
    } catch (e) { st.online = false; render(); throw e.net ? e : NetErr(); }
    finally { clearTimeout(t); }
    st.online = true;
    return { r: r, d: d };
  }
  function httpErr(x) {
    var e = new Error((x.d && x.d.error) || 'خطا در ارتباط با سرور');
    e.status = x.r.status; e.data = x.d; return e;
  }

  /* ---------- ابزارهای پروژه ---------- */
  function parseData(s) { try { var d = JSON.parse(s || '{}'); return d && typeof d === 'object' ? d : {}; } catch (e) { return {}; } }
  function rowFromRec(r) {
    var d = parseData(r.data), pp = d.parentProjectId || (d.project && d.project.parentProjectId) || null;
    return {
      id: r.id, name: r.name, updated_at: r.updated_at, created_at: r.created_at, parentProjectId: pp,
      projectType: d.projectType || (d.project && d.project.type) || (pp ? 'calculation' : 'main'),
      calculationName: d.calculationName || (d.project && d.project.calculationName) || ''
    };
  }
  function patchCalcName(dataStr, cn) { /* مثل سرور: فقط نام محاسبه داخل JSON */
    var d = parseData(dataStr); if (!Object.keys(d).length && dataStr && dataStr !== '{}') return dataStr;
    cn = String(cn || '').trim().slice(0, 120); d.calculationName = cn; if (d.project && typeof d.project === 'object') d.project.calculationName = cn;
    return JSON.stringify(d);
  }
  function asProject(r) { return { id: r.id, name: r.name, data: r.data, created_at: r.created_at, updated_at: r.updated_at }; }
  function mine(r) { return r && cur && r.userKey === cur.key; }
  async function myOps() {
    if (!cur) return [];
    return (await allRecs('outbox')).filter(function (o) { return o.userKey === cur.key; }).sort(function (a, b) { return a.seq - b.seq; });
  }
  async function refreshPending() { try { st.pending = (await myOps()).length; } catch (e) { st.pending = 0; } }

  /* ---------- صف (outbox) با ادغام تغییرات ---------- */
  function enqueue(kind, pid, o) {
    return lock(async function () {
      var ops = (await myOps()).filter(function (x) { return x.pid === pid && x.seq !== inflightSeq; });
      var create = ops.find(function (x) { return x.kind === 'create'; });
      var puts = ops.filter(function (x) { return x.kind === 'put'; });
      var add = function (rec) { rec.userKey = cur.key; rec.pid = pid; rec.ts = Date.now(); rec.kind = kind; return putRec('outbox', rec); };
      if (kind === 'delete') {
        for (var i = 0; i < ops.length; i++) await delRec('outbox', ops[i].seq);
        if (create && inflightPid !== pid) return;           /* هیچ‌وقت به سرور نرسیده بود: نیازی به حذف نیست */
        return add({ method: 'DELETE', path: '/api/projects/' + pid });
      }
      if (kind === 'put') {
        if (create) {                                        /* هنوز ساخته نشده: داخل همان درخواست ساخت ادغام می‌شود */
          create.body.name = o.body.name; create.body.data = o.body.data; await putRec('outbox', create);
          for (var j = 0; j < ops.length; j++) if (ops[j].kind === 'put' || ops[j].kind === 'rename') await delRec('outbox', ops[j].seq);
          return;
        }
        var base = puts.length ? puts[0].base : o.base;
        for (var k = 0; k < ops.length; k++) if (ops[k].kind === 'put' || ops[k].kind === 'rename') await delRec('outbox', ops[k].seq);
        return add({ method: 'PUT', path: '/api/projects/' + pid, body: o.body, base: base });
      }
      if (kind === 'rename') {
        var tgt = create || puts[puts.length - 1];
        if (tgt) {
          tgt.body.name = o.body.name;
          if (o.body.calculationName !== undefined) tgt.body.data = patchCalcName(tgt.body.data, o.body.calculationName);
          return putRec('outbox', tgt);
        }
        var oldRn = ops.filter(function (x) { return x.kind === 'rename'; });
        for (var m = 0; m < oldRn.length; m++) await delRec('outbox', oldRn[m].seq);
        return add({ method: 'PUT', path: '/api/projects/' + pid, body: o.body });
      }
      if (kind === 'analysis') {
        var oldA = ops.filter(function (x) { return x.kind === 'analysis'; });
        for (var n = 0; n < oldA.length; n++) await delRec('outbox', oldA[n].seq);
        return add({ method: 'PUT', path: '/api/projects/' + pid + '/analysis', body: o.body });
      }
      if (kind === 'create') return add({ method: 'POST', path: '/api/projects', body: o.body });
    }).then(function (r) { return refreshPending().then(function () { render(); return r; }); });
  }

  /* ---------- request: جای fetch در api() ---------- */
  var RE = /^\/api\/projects(?:\/([^/?#]+))?(?:\/(analysis))?\/?(?:\?.*)?$/;
  async function request(path, opt) {
    opt = opt || {};
    var method = String(opt.method || 'GET').toUpperCase(), m = RE.exec(String(path));
    if (!m || demo()) return plain(path, opt);
    var id = m[1], sub = m[2], body = {};
    try { body = opt.body ? JSON.parse(opt.body) : {}; } catch (e) {}
    try { await idbReady; } catch (e) {}
    if (!(await idbReady) || !cur) return plain(path, opt);   /* ذخیره‌ی محلی در دسترس نیست: رفتار قبلی */
    if (!id) return method === 'POST' ? create(body) : list(path, opt);
    if (sub) return method === 'GET' ? getAnalysis(id) : putAnalysis(id, body);
    if (method === 'GET') return getProject(id);
    if (method === 'DELETE') return remove(id);
    return put(id, body);
  }
  async function plain(path, opt) {
    var r = await window.fetch(path, Object.assign({ credentials: 'same-origin' }, opt, { headers: Object.assign({ 'content-type': 'application/json' }, opt.headers || {}) }));
    var d = {}; try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(d.error || 'خطا در ارتباط با سرور');
    return d;
  }
  function recFromOps(id, ops) {
    var rec = null;
    ops.forEach(function (o) {
      if ((o.kind === 'create' || o.kind === 'put') && o.body && o.body.data !== undefined) rec = { id: id, userKey: o.userKey, name: o.body.name, data: o.body.data, created_at: (rec && rec.created_at) || o.ts, updated_at: o.ts, localOnly: o.kind === 'create' || !!(rec && rec.localOnly) };
    });
    return rec;
  }
  async function hasPending(id) { return (await myOps()).some(function (o) { return o.pid === id; }); }

  /* --- لیست --- */
  async function mergeList(rows) {
    var map = {}, order = [];
    (rows || []).forEach(function (r) { map[r.id] = r; });
    var recs = {}; (await allRecs('projects')).filter(mine).forEach(function (r) { recs[r.id] = r; if (!map[r.id]) map[r.id] = rowFromRec(r); });
    var all = await myOps();
    (all).forEach(function (o) {
      var id = o.pid;
      if (o.kind === 'delete') { delete map[id]; return; }
      var rec = recs[id] || recFromOps(id, all.filter(function (z) { return z.pid === id; }));
      if ((o.kind === 'create' || o.kind === 'put') && rec) { map[id] = Object.assign({}, map[id] || {}, rowFromRec(rec)); }
      else if (o.kind === 'rename' && map[id]) { map[id] = Object.assign({}, map[id], { name: o.body.name }); if (o.body.calculationName !== undefined) map[id].calculationName = String(o.body.calculationName || ''); }
    });
    for (var k in map) order.push(map[k]);
    order.sort(function (a, b) { return (b.updated_at || 0) - (a.updated_at || 0); });
    return order;
  }
  async function list(path, opt) {
    var pend = (await myOps()).length > 0;
    try {
      var x = await net(path, 'GET');
      if (!x.r.ok) throw httpErr(x);
      var rows = x.d.projects || [];
      await kvSet('list', { userKey: cur.key, rows: rows, at: Date.now() });
      var out = pend ? await mergeList(rows) : rows;
      prefetch(rows);
      if (pend) flush();
      return { projects: out };
    } catch (e) {
      if (!e.net) throw e;
      var c = await kvGet('list');
      return { projects: await mergeList(c && c.userKey === cur.key ? c.rows : []), offline: true };
    }
  }

  /* --- یک پروژه --- */
  async function getProject(id) {
    var rec = await getRec('projects', id); if (rec && !mine(rec)) rec = null;
    var ops = (await myOps()).filter(function (o) { return o.pid === id; });
    if (ops.some(function (o) { return o.kind === 'delete'; })) throw new Error('پروژه پیدا نشد.');
    if (ops.length && !rec) rec = recFromOps(id, ops);
    if (ops.length && rec) { flush(); return { project: asProject(rec) }; }   /* نسخه‌ی محلی جدیدتر از سرور است */
    try {
      var x = await net('/api/projects/' + id, 'GET');
      if (x.r.status === 404) { if (rec) await delRec('projects', id); throw httpErr(x); }
      if (!x.r.ok) throw httpErr(x);
      var p = x.d.project;
      await putRec('projects', { id: p.id, userKey: cur.key, name: p.name, data: p.data, created_at: p.created_at, updated_at: p.updated_at, su: p.updated_at });
      return x.d;
    } catch (e) {
      if (!e.net) throw e;
      if (rec) return { project: asProject(rec), offline: true };
      throw new Error(NOT_CACHED_MSG);
    }
  }

  /* --- ساخت --- */
  async function create(body) {
    var id = /^[0-9a-f-]{36}$/i.test(String(body.id || '')) ? String(body.id).toLowerCase() : uuid();
    var name = String(body.name || 'پروژه بدون نام').trim().slice(0, 120), data = String(body.data || '');
    if (data.length > 5000000) throw new Error('حجم پروژه بیش از حد مجاز است.');
    try {
      var x = await net('/api/projects', 'POST', Object.assign({}, body, { id: id }));
      if (!x.r.ok) throw httpErr(x);
      await putRec('projects', { id: x.d.id, userKey: cur.key, name: name, data: data, created_at: x.d.updated_at, updated_at: x.d.updated_at, su: x.d.updated_at });
      return x.d;
    } catch (e) { if (!e.net) throw e; }
    if (writeBlocked()) throw new Error(EXPIRED_MSG);
    var now = Date.now();
    await putRec('projects', { id: id, userKey: cur.key, name: name, data: data, created_at: now, updated_at: now, localOnly: true });
    await enqueue('create', id, { body: Object.assign({}, body, { id: id, name: name, data: data }) });
    flush();
    return { ok: true, id: id, name: name, updated_at: now, offline: true };
  }

  /* --- ذخیره/تغییر نام --- */
  async function put(id, body) {
    var renameOnly = body.renameOnly === true && (body.data === undefined || body.data === null);
    var rec = await getRec('projects', id); if (rec && !mine(rec)) rec = null;
    var pend = await hasPending(id);
    var name = String(body.name || (rec && rec.name) || '').trim().slice(0, 120);
    if (!pend) {
      try {
        var x = await net('/api/projects/' + id, 'PUT', body);
        if (!x.r.ok) throw httpErr(x);
        if (rec) {
          if (renameOnly) {
            rec.name = name; if (body.calculationName !== undefined) rec.data = patchCalcName(rec.data, body.calculationName);
          } else { rec.name = name; rec.data = String(body.data || ''); rec.updated_at = rec.su = x.d.updated_at; }
          await putRec('projects', rec);
        } else if (!renameOnly) {
          await putRec('projects', { id: id, userKey: cur.key, name: name, data: String(body.data || ''), created_at: x.d.updated_at, updated_at: x.d.updated_at, su: x.d.updated_at });
        }
        return x.d;
      } catch (e) { if (!e.net) throw e; }
    }
    if (writeBlocked()) throw new Error(EXPIRED_MSG);
    var now = Date.now();
    if (renameOnly) {
      if (!name) throw new Error('نام نمی‌تواند خالی باشد.');
      if (rec) { rec.name = name; if (body.calculationName !== undefined) rec.data = patchCalcName(rec.data, body.calculationName); await putRec('projects', rec); }
      await enqueue('rename', id, { body: { name: name, renameOnly: true, calculationName: body.calculationName } });
      flush();
      return { ok: true, updated_at: rec ? rec.updated_at : now, offline: true };
    }
    var data = String(body.data || '');
    if (data.length > 5000000) throw new Error('حجم پروژه بیش از حد مجاز است.');
    var nr = Object.assign({ id: id, userKey: cur.key, created_at: now }, rec || {}, { name: name, data: data, updated_at: now });
    await putRec('projects', nr);
    var pb = { name: name, data: data };
    ['parentProjectId', 'projectType', 'calculationName'].forEach(function (k) { if (body[k] !== undefined) pb[k] = body[k]; });
    await enqueue('put', id, { body: pb, base: rec ? rec.su : undefined });
    flush();
    return { ok: true, updated_at: now, offline: true };
  }

  /* --- حذف --- */
  async function remove(id) {
    var pend = await hasPending(id);
    if (!pend) {
      try {
        var x = await net('/api/projects/' + id, 'DELETE');
        if (!x.r.ok && x.r.status !== 404) throw httpErr(x);
        await delRec('projects', id); await delRec('analysis', id);
        return { ok: true };
      } catch (e) { if (!e.net) throw e; }
    }
    if (writeBlocked()) throw new Error(EXPIRED_MSG);
    await delRec('projects', id); await delRec('analysis', id);
    await enqueue('delete', id, {});
    flush();
    return { ok: true, offline: true };
  }

  /* --- آنالیز --- */
  async function getAnalysis(id) {
    var rec = await getRec('analysis', id); if (rec && !mine(rec)) rec = null;
    if (rec && rec.dirty) { flush(); return { analysis: rec.analysis }; }
    var pr = await getRec('projects', id);
    if (pr && pr.localOnly) return { analysis: rec ? rec.analysis : {} };
    try {
      var x = await net('/api/projects/' + id + '/analysis', 'GET');
      if (!x.r.ok) throw httpErr(x);
      await putRec('analysis', { id: id, userKey: cur.key, analysis: x.d.analysis || {} });
      return x.d;
    } catch (e) {
      if (!e.net) throw e;
      if (rec) return { analysis: rec.analysis, offline: true };
      throw new Error(NOT_CACHED_MSG);
    }
  }
  async function putAnalysis(id, body) {
    var pend = await hasPending(id);
    var a = {};
    ['analysisOverrides', 'analysisCustomRows', 'analysisItemMeta', 'analysisPageState'].forEach(function (k) { a[k] = (body[k] && typeof body[k] === 'object') ? body[k] : {}; });
    if (JSON.stringify(a).length > 5000000) throw new Error('حجم اطلاعات آنالیز بیش از حد مجاز است.');
    if (!pend) {
      try {
        var x = await net('/api/projects/' + id + '/analysis', 'PUT', body);
        if (!x.r.ok) throw httpErr(x);
        await putRec('analysis', { id: id, userKey: cur.key, analysis: a });
        var pr = await getRec('projects', id); if (pr && mine(pr)) { pr.su = x.d.updated_at; await putRec('projects', pr); }
        return x.d;
      } catch (e) { if (!e.net) throw e; }
    }
    if (writeBlocked()) throw new Error(EXPIRED_MSG);
    await putRec('analysis', { id: id, userKey: cur.key, analysis: a, dirty: true });
    await enqueue('analysis', id, { body: a });
    flush();
    return { ok: true, updated_at: Date.now(), offline: true };
  }

  /* ---------- پیش‌بارگذاری برای استفاده‌ی آفلاین ---------- */
  var prefetching = false;
  async function prefetch(rows) {
    if (prefetching || demo() || !cur) return;
    try { if (navigator.connection && navigator.connection.saveData) return; } catch (e) {}
    prefetching = true;
    try {
      var list = (rows || []).slice().sort(function (a, b) { return (b.updated_at || 0) - (a.updated_at || 0); }).slice(0, PREFETCH_MAX);
      for (var i = 0; i < list.length; i++) {
        if (!st.online || !cur) break;
        var row = list[i], rec = await getRec('projects', row.id);
        if ((rec && mine(rec) && Number(rec.su) >= Number(row.updated_at)) || await hasPending(row.id)) continue;
        try {
          var x = await net('/api/projects/' + row.id, 'GET');
          if (x.r.ok && x.d.project && !(await hasPending(row.id))) {
            var p = x.d.project;
            await putRec('projects', { id: p.id, userKey: cur.key, name: p.name, data: p.data, created_at: p.created_at, updated_at: p.updated_at, su: p.updated_at });
            var ax = await net('/api/projects/' + row.id + '/analysis', 'GET');
            if (ax.r.ok && !(await hasPending(row.id))) await putRec('analysis', { id: row.id, userKey: cur.key, analysis: ax.d.analysis || {} });
          }
        } catch (e) { if (e.net) break; }
        await new Promise(function (r) { setTimeout(r, 120); });
      }
    } finally { prefetching = false; }
  }

  /* ---------- همگام‌سازی صف ---------- */
  function notify(msg, ms) {
    try { console.info('[offline]', msg); } catch (e) {}
    var host = document.getElementById('mzOfflineToasts');
    if (!host && document.body) {
      host = document.createElement('div'); host.id = 'mzOfflineToasts';
      host.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:48px;z-index:2147483646;display:flex;flex-direction:column;gap:6px;max-width:92vw;pointer-events:none';
      document.body.appendChild(host);
    }
    if (!host) return;
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'background:#1f2937;color:#fff;border:1px solid #f59e0b;border-radius:10px;padding:10px 14px;font-size:14px;line-height:1.7;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:auto;direction:rtl;text-align:right';
    host.appendChild(t); setTimeout(function () { try { t.remove(); } catch (e) {} }, 2000); /* همه‌ی پیغام‌ها دقیقاً ۲ ثانیه */
  }
  async function meCheck() {
    try {
      var r = await rawFetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) return { auth: false };
      if (!r.ok) return { net: true };
      var d = await r.json(); st.online = true;
      if (d && d.user) { await saveUser(d.user, d.sub, true); return { code: keyOf(d.user) }; }
      return { auth: false };
    } catch (e) { st.online = false; return { net: true }; }
  }
  async function remap(oldId, newId) {
    var ops = (await myOps()).filter(function (o) { return o.pid === oldId; });
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i]; o.pid = newId; o.path = o.path.replace(oldId, newId); o.base = undefined;
      if (o.body && o.kind === 'create') o.body.id = newId;
      await putRec('outbox', o);
    }
    var rec = await getRec('projects', oldId);
    if (rec) { await delRec('projects', oldId); rec.id = newId; await putRec('projects', rec); }
    var an = await getRec('analysis', oldId);
    if (an) { await delRec('analysis', oldId); an.id = newId; await putRec('analysis', an); }
  }
  async function sendOp(o) {
    var body = o.body ? Object.assign({}, o.body) : undefined;
    if (o.kind === 'put' && o.base != null) body.baseUpdatedAt = o.base;
    var x;
    try { x = await net(o.path, o.method, body); } catch (e) { return 'net'; }
    var s = x.r.status, d = x.d || {};
    if (x.r.ok || (o.kind === 'delete' && s === 404)) {
      return lock(function () { return afterOk(o, d); });
    }
    return sendOpFail(o, x);
  }
  async function afterOk(o, d) {
    {
      var upd = d.updated_at;
      await delRec('outbox', o.seq);
      if (o.kind === 'create' && d.id && d.id !== o.pid) await remap(o.pid, d.id);
      var pid = (o.kind === 'create' && d.id) ? d.id : o.pid;
      var left = (await myOps()).filter(function (z) { return z.pid === pid; });
      var rec = await getRec('projects', pid);
      if (rec && mine(rec) && o.kind !== 'delete') {
        if (upd != null && o.kind !== 'rename') rec.su = upd;
        if (!left.length) { rec.localOnly = false; if (upd != null && o.kind !== 'rename') rec.updated_at = upd; }
        await putRec('projects', rec);
      }
      if (o.kind === 'analysis') { var an = await getRec('analysis', pid); if (an && !left.some(function (z) { return z.kind === 'analysis'; })) { an.dirty = false; await putRec('analysis', an); } }
      if (upd != null && o.kind !== 'rename') for (var i = 0; i < left.length; i++) if (left[i].kind === 'put') { left[i].base = upd; await putRec('outbox', left[i]); }
      return 'done';
    }
  }
  async function sendOpFail(o, x) {
    var s = x.r.status, d = x.d || {};
    if (s === 401) { st.needLogin = true; return 'stop'; }
    if (s === 403 && d.expired) { st.expired = true; return 'stop'; }
    if (s >= 500 || s === 429) return 'net';
    if (o.kind === 'create' && s === 409) { await lock(function () { return remap(o.pid, uuid()); }); return 'retry'; }
    if ((s === 409 && d.conflict) || (s === 404 && o.kind === 'put' && o.body && o.body.data !== undefined)) {
      /* پروژه روی دستگاه دیگر تغییر کرده یا حذف شده: نسخه‌ی آفلاین را جدا نگه می‌داریم تا چیزی از دست نرود */
      var nid = uuid(), nm = (String(o.body.name || 'پروژه') + ' (نسخه آفلاین)').slice(0, 120);
      var cx; try { cx = await net('/api/projects', 'POST', { id: nid, name: nm, data: o.body.data }); } catch (e) { return 'net'; }
      if (!cx.r.ok) return 'net';
      await lock(async function () {
        await delRec('outbox', o.seq);
        await remap(o.pid, nid);                       /* بقیه‌ی تغییرات این پروژه هم به نسخه‌ی جدید می‌رود */
        var oldRec = await getRec('projects', nid); if (oldRec) { oldRec.su = cx.d.updated_at; oldRec.updated_at = cx.d.updated_at; oldRec.name = nm; oldRec.localOnly = false; await putRec('projects', oldRec); }
      });
      notify('«' + String(o.body.name || 'پروژه') + '» هم‌زمان در جای دیگری تغییر کرده بود. تغییرات آفلاین شما به‌صورت پروژه‌ی جدیدی با نام «' + nm + '» ذخیره شد و نسخه‌ی سرور دست‌نخورده ماند.', 10000);
      try { window.__fpCache = null; } catch (e) {}
      return 'done';
    }
    if (s === 404) { await lock(function () { return delRec('outbox', o.seq); }); return 'done'; }   /* پروژه‌ی هدف دیگر وجود ندارد */
    /* خطای دائمی (۴۰۰/۴۱۳/…): این تغییر را کنار بگذار تا صف گیر نکند */
    await lock(function () { return delRec('outbox', o.seq); });
    notify('یکی از تغییرات آفلاین قابل ارسال نبود و کنار گذاشته شد: ' + (d.error || ('کد ' + s)), 8000);
    return 'done';
  }
  async function flushInner() {
    var me = await meCheck();
    if (me.net) return 'net';
    if (me.auth === false) { st.needLogin = true; return 'stop'; }
    if (!cur || me.code !== cur.key) return 'stop';   /* نشست مال کاربر دیگری است: هرگز تغییرات این کاربر را با آن ارسال نکن */
    st.needLogin = false;
    for (var guard = 0; guard < 500; guard++) {
      var ops = await myOps(); if (!ops.length) return 'ok';
      var o = ops[0]; inflightSeq = o.seq; inflightPid = o.pid;
      var r; try { r = await sendOp(o); } finally { inflightSeq = 0; inflightPid = ''; }
      await refreshPending(); render();
      if (r === 'net' || r === 'stop') return r;
    }
    return 'ok';
  }
  async function flush() {
    if (flushing || !cur || demo()) return;
    var n = await refreshPending(); if (!st.pending) { render(); return; }
    flushing = true; st.syncing = true; render();
    var res = 'net';
    try {
      if (navigator.locks && navigator.locks.request) {
        await navigator.locks.request('metriz-flush', { ifAvailable: true }, async function (l) { if (l) res = await flushInner(); else res = 'stop'; });
      } else res = await flushInner();
    } catch (e) { res = 'net'; }
    flushing = false; st.syncing = false;
    await refreshPending(); render();
    clearTimeout(retryTimer);
    if (st.pending && res === 'net') { retryN = Math.min(retryN + 1, 6); retryTimer = setTimeout(flush, Math.min(300000, 15000 * retryN)); }
    else if (res === 'ok') { retryN = 0; try { window.__fpCache = null; document.dispatchEvent(new Event('offline-synced')); } catch (e) {} }
  }

  /* ---------- کاربر، ورود/خروج و سرویس‌ورکر ---------- */
  function toSW(msg) {
    try { if (navigator.serviceWorker) navigator.serviceWorker.ready.then(function (r) { if (r.active) r.active.postMessage(msg); }).catch(function () {}); } catch (e) {}
  }
  async function saveUser(user, sub, noFlush) {
    var key = keyOf(user); if (!key) return;
    var prev = cur && cur.key;
    if (prev && prev !== key) await wipeCaches(true);
    cur = { key: key, user: user, sub: sub || null, verifiedAt: Date.now() };
    await kvSet('user', cur);
    toSW({ type: 'meta', userKey: key, expires_at: sub && !sub.unlimited && sub.expires_at != null ? sub.expires_at : null, verifiedAt: cur.verifiedAt });
    await refreshPending();
    if (st.pending && !noFlush) setTimeout(flush, 300);
    render();
  }
  async function wipeCaches(keepOutbox) {
    await Promise.all([clearStore('projects'), clearStore('analysis'), kvDel('list')]);
    try { if (window.caches) await caches.delete('metriz-data-v1'); } catch (e) {}
    toSW({ type: 'clear' });
  }
  function jsonResp(o, status) { return new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8' } }); }
  async function authFetch(path, input, init) {
    if (path === '/api/me') {
      if (pendingLogout) {
        try { await rawFetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }); pendingLogout = false; await kvDel('pendingLogout'); } catch (e) {}
        if (pendingLogout) return jsonResp({ ok: false, error: 'ابتدا وارد حساب کاربری شوید.' }, 401);
      }
      try {
        var r = await rawFetch(input, init);
        if (r.ok) { st.online = true; try { var d = await r.clone().json(); if (d && d.user) await saveUser(d.user, d.sub); } catch (e) {} }
        return r;
      } catch (e) {
        st.online = false; render();
        await idbReady;
        var c = cur || await kvGet('user');
        if (c && c.user && !pendingLogout && Date.now() - c.verifiedAt <= MAX_OFFLINE_DAYS * DAY) {
          cur = c;
          return jsonResp({ ok: true, user: c.user, sub: offlineSub(c.sub), offline: true });
        }
        throw e;
      }
    }
    if (path === '/api/login') {
      var lr = await rawFetch(input, init);
      if (lr.ok) {
        try { var ld = await lr.clone().json(); await saveUser(ld.user || { code: ld.code, name: ld.name, role: ld.role, perms: ld.perms }, ld.sub); } catch (e) {}
      }
      return lr;
    }
    /* /api/logout */
    try { await Promise.race([flush(), new Promise(function (r) { setTimeout(r, 6000); })]); } catch (e) {}
    var out;
    try { out = await rawFetch(input, init); } catch (e) { pendingLogout = true; await kvSet('pendingLogout', true); out = jsonResp({ ok: true, offline: true }); }
    cur = null; await kvDel('user'); await wipeCaches(true); render();
    return out;
  }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (demo() || (path !== '/api/me' && path !== '/api/login' && path !== '/api/logout')) return rawFetch(input, init);
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (path === '/api/me' ? method === 'GET' : method === 'POST') return authFetch(path, input, init);
    return rawFetch(input, init);
  };

  /* ---------- نشانگر وضعیت ---------- */
  var pill = null;
  function fa(n) { try { return Number(n).toLocaleString('fa-IR'); } catch (e) { return String(n); } }
  function render() {
    if (!document.body) return;
    try { syncUi(); } catch (e) {}
    var text = '', color = '#b45309';
    var online = st.online && navigator.onLine !== false;
    if (cur && !demo()) {
      if (st.expired && st.pending) { text = 'اشتراک تمام شده؛ ' + fa(st.pending) + ' تغییر آفلاین ارسال نشد'; color = '#b91c1c'; }
      else if (st.needLogin && st.pending) { text = 'برای ارسال ' + fa(st.pending) + ' تغییر آفلاین دوباره وارد شوید'; color = '#b91c1c'; }
      else if (!online) text = 'آفلاین' + (st.pending ? ' — ' + fa(st.pending) + ' تغییر در انتظار ارسال' : ' — تغییرات روی دستگاه ذخیره می‌شود');
      else if (st.syncing && st.pending) { text = 'در حال همگام‌سازی…'; color = '#0369a1'; }
      else if (st.pending) text = fa(st.pending) + ' تغییر هنوز به سرور نرسیده — برای ارسال لمس کنید';
    }
    if (!text || inlineSyncVisible()) { if (pill) pill.style.display = 'none'; return; }   /* دکمه‌ی کنار «خانه» نشانگر است؛ کادر شناور فقط جایگزین */
    if (!pill) {
      pill = document.createElement('button'); pill.type = 'button'; pill.id = 'mzOfflinePill';
      pill.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);left:8px;z-index:2147483645;border:0;border-radius:999px;padding:6px 12px;font-family:inherit;font-weight:600;font-size:13px;line-height:1.4;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.35);cursor:pointer;direction:rtl;max-width:80vw';
      pill.addEventListener('click', function () { flush(); });
      document.body.appendChild(pill);
    }
    pill.textContent = text; pill.style.background = color; pill.style.display = '';
  }

  window.addEventListener('online', function () { st.online = true; retryN = 0; render(); flush(); });
  window.addEventListener('offline', function () { st.online = false; render(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && st.pending) flush(); });
  setInterval(function () { if (st.pending && !flushing) flush(); }, 30000);

  /* ---------- آماده‌سازی آفلاین داده‌ی قیمت (۱۳۹۹–۱۴۰۴، ابنیه/مکانیک/برق + آنالیزها) ---------- */
  var prepBusy = false;
  async function prepareOffline(btn, auto) {
    if (prepBusy || demo() || !cur) return;
    if (auto && !st.online) return;
    if (!window.caches) { notify('این مرورگر ذخیره‌ی آفلاین را پشتیبانی نمی‌کند.'); return; }
    prepBusy = true;
    var label = btn ? btn.textContent : '', say = function (t) { if (btn) btn.textContent = t; };
    try {
      say('در حال آماده‌سازی…');
      var ir = await rawFetch('./data/shard-index.json', { cache: 'no-store', credentials: 'same-origin' });
      if (!ir.ok) { var ij = {}; try { ij = await ir.json(); } catch (e) {} throw new Error(ij.error || 'دریافت فهرست داده ناموفق بود.'); }
      var idx = await ir.json(), DISC = ['ابنیه', 'مکانیک', 'برق'], files = ['adjustment-index-v158.json'];
      (idx.shards || []).forEach(function (s) { var y = Number(s.y); if (y >= 1399 && y <= 1404 && DISC.indexOf(s.d) >= 0) files.push(s.f); });
      for (var y = 1399; y <= 1404; y++) ['abnieh', 'mechanic', 'bargh'].forEach(function (d) { files.push('analysis-' + y + '-' + d + '-v196.json'); });
      var c = await caches.open('metriz-data-v1'), todo = [];
      for (var i = 0; i < files.length; i++) if (!(await c.match('/data/' + files[i], { ignoreVary: true }))) todo.push(files[i]);
      var done = 0, failed = 0, stopMsg = '', next = 0, total = todo.length;
      var worker = async function () {
        while (!stopMsg) {
          var k = next++; if (k >= todo.length) return;
          try {
            var r = await rawFetch('./data/' + todo[k], { cache: 'no-store', credentials: 'same-origin' });
            if (r.ok) { await r.arrayBuffer(); done++; }
            else { failed++; if (r.status === 429 || r.status === 403 || r.status === 401) { var j = {}; try { j = await r.json(); } catch (e) {} stopMsg = j.error || 'دریافت متوقف شد.'; } }
          } catch (e) { stopMsg = NO_NET_MSG; }
          say('دریافت ' + fa(done) + ' از ' + fa(total) + '…');
        }
      };
      if (total) await Promise.all([worker(), worker(), worker()]);
      if (stopMsg) notify(stopMsg + ' (' + fa(done) + ' فایل دریافت شد؛ بعداً دوباره بزن تا بقیه کامل شود.)');
      else if (failed) notify(fa(failed) + ' فایل دریافت نشد؛ دوباره بزن.');
      else if (total || !auto) notify(total ? 'همه‌ی داده‌ی ۱۳۹۹ تا ۱۴۰۴ برای استفاده‌ی آفلاین ذخیره شد.' : 'همه‌ی داده‌ها از قبل روی دستگاه ذخیره بود.');
    } catch (e) { notify(e.message || 'آماده‌سازی ناموفق بود.'); }
    finally { prepBusy = false; if (btn) btn.textContent = label; }
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('#mzPrepOffline');
    if (b) { e.preventDefault(); prepareOffline(b); }
  });

  /* ---------- دکمه‌ی همگام‌سازی دستی کنار «خانه» (همه‌ی منوها و صفحه‌ی اول) ---------- */
  var SYNC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><line class="mzSl" x1="3.5" y1="3.5" x2="20.5" y2="20.5"/></svg><span class="mzT" dir="ltr">Online</span><span class="mzB"></span>';
  (function css() {
    var t = document.createElement('style');
    /* رنگ فقط از متغیر --mz می‌آید و روی استایل‌های هر صفحه غلبه می‌کند تا همه‌جا یکسان باشد؛ پس‌زمینه‌ی کادر همان دکمه‌های دیگر می‌ماند */
    t.textContent = '.mzSyncBtn{--mz:#22c55e;border-radius:999px!important;position:relative;display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:5px;width:auto!important;min-width:46px!important;flex:0 0 auto!important;padding:0 10px!important;color:var(--mz)!important}' +
      '.mzSyncBtn svg{width:24px;height:24px;flex:0 0 24px;pointer-events:none;stroke:var(--mz)!important;color:var(--mz)!important}' +
      '.mzSyncBtn svg *{stroke:var(--mz)!important}.mzSyncBtn .mzSl{display:none}.mzSyncBtn.mzOff .mzSl{display:block}' +
      '.mzSyncBtn .mzT{font:700 11px/1 sans-serif;color:var(--mz)!important;pointer-events:none;letter-spacing:.2px}' +
      '.mzSyncBtn.mzWarn,.mzSyncBtn.mzOff{--mz:#f59e0b}.mzSyncBtn.mzBusy svg{animation:mzpulse 1s ease-in-out infinite}@keyframes mzpulse{50%{opacity:.35}}' +
      '.mzSyncBtn .mzB{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;border-radius:9px;background:#f59e0b;color:#111;font:700 11px/18px sans-serif;text-align:center;display:none;padding:0 4px;pointer-events:none}' +
      '.mzSyncBtn[data-n] .mzB{display:block}' +
      ':root:root:root:root:root:root:root:root:root:root body .mzSyncBtn.mzSyncBtn.mzSyncBtn.mzSyncBtn{width:auto!important;border-radius:999px!important;min-width:46px!important;max-width:none!important;flex:0 0 auto!important;padding:0 10px!important;box-sizing:border-box!important;white-space:nowrap;overflow:visible!important}' +
      ':root:root:root:root:root:root:root:root:root:root:root body .mzSyncBtn.mzSyncBtn.mzSyncBtn.mzSyncBtn.mzCompact{width:var(--mzh,44px)!important;min-width:var(--mzh,44px)!important;padding:0!important;gap:0!important}' +
      '.mzSyncBtn.mzCompact .mzT{display:none!important}' +
      '#cplHome>#mzSyncHome{position:absolute;top:calc(14px + env(safe-area-inset-top,0px));right:118px;left:auto;height:46px;border:1px solid var(--c5);background:var(--c8);cursor:pointer;z-index:2}';
    (document.head || document.documentElement).appendChild(t);
  })();
  function mkSync(cls) {
    var b = document.createElement('button'); b.type = 'button'; b.className = cls + ' mzSyncBtn';
    b.title = 'همگام‌سازی'; b.setAttribute('aria-label', 'همگام‌سازی'); b.innerHTML = SYNC_SVG; return b;
  }
  function ensureSyncButtons() {
    if (!cur || demo()) return;
    var hosts = document.querySelectorAll('.mnHomeBtn:not(#stTrHome), #cplHomeQuickBtn');
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i], P = h.parentElement; if (!P) continue;
      var b = h.nextElementSibling && h.nextElementSibling.classList.contains('mzSyncBtn') ? h.nextElementSibling : null;
      if (!b) { b = P.querySelector(':scope>.mzSyncBtn'); }
      if (!b) b = mkSync(h.id === 'cplHomeQuickBtn' ? 'btn projectIconBtn' : 'btn mnIco');
      /* جای دکمه: آخرین گزینه‌ی گروه، یعنی بعد از خانه/ذخیره/فیلتر/مرتب‌سازی…، ولی قبل از دکمه‌های «قبل/بعد» (مرحله) */
      var kids = [].filter.call(P.children, function (c) { return c !== b && (c.tagName === 'BUTTON' || (c.classList && c.classList.contains('mnSortField'))); });
      var navRe = /مرحله|بازگشت|تأیید/, nav = [];
      for (var k = kids.length - 1; k >= 0 && nav.length < 2; k--) { if (navRe.test(kids[k].title || kids[k].getAttribute('aria-label') || '')) nav.unshift(kids[k]); else break; }
      var group = kids.filter(function (c) { return nav.indexOf(c) < 0; }), last = group[group.length - 1] || h, ord = 0;
      /* order فقط از دکمه‌های واقعی گرفته می‌شود (نه از کادر سورت/پنل منو که order=6 دارند و با فاصله‌انداز هدر یکی‌اند) تا دکمه بلافاصله کنار آخرین دکمه بنشیند */
      group.forEach(function (c) {
        var bs = c.tagName === 'BUTTON' ? [c] : [].slice.call(c.querySelectorAll('button'));
        bs.forEach(function (x) { try { var cs = getComputedStyle(x); if (cs.display === 'none') return; ord = Math.max(ord, parseInt(cs.order, 10) || 0); } catch (e) {} });
      });
      var placed = b.parentElement === P && (nav.length ? nav[0].previousElementSibling === b : last.nextElementSibling === b);
      if (!placed) { if (nav.length) P.insertBefore(b, nav[0]); else last.insertAdjacentElement('afterend', b); }
      b.style.order = String(ord);
    }
    var home = document.getElementById('cplHome');
    if (home && !document.getElementById('mzSyncHome')) { var hb = mkSync(''); hb.id = 'mzSyncHome'; home.insertBefore(hb, home.firstChild); }
    var sh = document.getElementById('mzSyncHome'), mb = document.getElementById('cplHomeMenuBtn');
    if (sh && mb && home) {   /* هم‌اندازه و هم‌ردیف دکمه‌ی منو، یک فاصله بعد از دکمه‌ی خانه */
      var m = mb.getBoundingClientRect(), hr = home.getBoundingClientRect();
      if (m.width > 0) { sh.style.top = (m.top - hr.top) + 'px'; sh.style.height = m.height + 'px'; sh.style.right = (hr.right - m.right + 2 * (m.width + 8)) + 'px'; }
    }
  }
  function inlineSyncVisible() {
    var l = document.querySelectorAll('.mzSyncBtn');
    for (var i = 0; i < l.length; i++) { var r = l[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0) return true; }
    return false;
  }
  function syncUi() {
    ensureSyncButtons();
    var online = st.online && navigator.onLine !== false, l = document.querySelectorAll('.mzSyncBtn');
    for (var i = 0; i < l.length; i++) {
      var b = l[i], host = b.previousElementSibling;
      if (host && host.classList && host.classList.contains('mnHomeBtn')) b.style.display = getComputedStyle(host).display === 'none' ? 'none' : '';
      /* هم‌ارتفاع با دکمه‌های کناری (در همه‌ی صفحه‌ها) */
      if (b.id !== 'mzSyncHome') {
        var nb = null, sb = b.previousElementSibling;
        while (sb && !nb) { if (sb.tagName === 'BUTTON' && sb.getBoundingClientRect().height > 0) nb = sb; sb = sb.previousElementSibling; }
        if (!nb) { sb = b.nextElementSibling; while (sb && !nb) { if (sb.tagName === 'BUTTON' && sb.getBoundingClientRect().height > 0) nb = sb; sb = sb.nextElementSibling; } }
        if (!nb) { var sf = b.parentElement && b.parentElement.querySelector('.mnSortField button, button:not(.mzSyncBtn)'); if (sf && sf.getBoundingClientRect().height > 0) nb = sf; }
        if (nb) { var hh = Math.round(nb.getBoundingClientRect().height) + 'px'; if (b.style.height !== hh) { b.style.setProperty('height', hh, 'important'); b.style.setProperty('min-height', hh, 'important'); b.style.setProperty('max-height', hh, 'important'); } }
      }
      /* اگر در موبایل جا نشد و دکمه‌های «قبلی/بعدی» رفتند ردیف پایین، کادر فقط آیکون می‌شود تا همه در یک ردیف بمانند */
      if (b.id !== 'mzSyncHome') {
        var w0 = window.innerWidth;
        if (b.__cw !== undefined && b.__cw !== w0) { b.__cw = undefined; b.classList.remove('mzCompact'); }
        if (!b.classList.contains('mzCompact') && b.getBoundingClientRect().width > 0) {
          var hd = b.closest('.mnHead,.analysisHead'), wr = false;
          if (hd) {
            var bt = b.getBoundingClientRect().top, bs2 = hd.querySelectorAll('button');
            for (var q = 0; q < bs2.length; q++) {
              var x = bs2[q]; if (x === b || x.closest('.mnMenuPanel')) continue;
              var xr = x.getBoundingClientRect(); if (xr.width > 0 && xr.top > bt + 10) { wr = true; break; }
            }
          }
          if (wr) { b.classList.add('mzCompact'); b.__cw = w0; b.style.setProperty('--mzh', Math.round(b.getBoundingClientRect().height) + 'px'); }
        }
      }
      b.classList.toggle('mzOff', !online); b.classList.toggle('mzBusy', !!st.syncing);
      b.classList.toggle('mzWarn', online && (st.pending > 0 || st.needLogin || st.expired));
      var tx = b.querySelector('.mzT'); if (tx) tx.textContent = online ? 'Online' : 'Offline';
      if (st.pending) { b.setAttribute('data-n', '1'); b.firstElementChild && b.querySelector('.mzB') && (b.querySelector('.mzB').textContent = fa(st.pending)); } else b.removeAttribute('data-n');
      b.title = !online ? 'آفلاین — برای همگام‌سازی لمس کنید' : (st.pending ? fa(st.pending) + ' تغییر در انتظار ارسال' : 'همگام‌سازی');
    }
  }
  var syncRaf = 0;
  try { new MutationObserver(function () { if (!syncRaf) syncRaf = requestAnimationFrame(function () { syncRaf = 0; try { syncUi(); } catch (e) {} }); }).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  setInterval(function () { try { syncUi(); } catch (e) {} }, 2000);
  async function manualSync() {
    if (!cur) { notify('ابتدا وارد حساب شوید.'); return; }
    if (navigator.onLine === false) { notify(st.pending ? 'آفلاین هستید؛ ' + fa(st.pending) + ' تغییر روی دستگاه ذخیره است و با اتصال اینترنت ارسال می‌شود.' : 'آفلاین هستید. همه‌ی تغییرات روی دستگاه ذخیره می‌شود و بعداً خودکار همگام می‌شود.'); return; }
    st.syncing = true; render();
    try { await flush(); await request('/api/projects', {}); } catch (e) {}
    st.syncing = false; await refreshPending(); render();
    try { window.__fpCache = null; document.dispatchEvent(new Event('offline-synced')); } catch (e) {}
    if (st.needLogin) notify('نشست شما تمام شده؛ دوباره وارد شوید تا تغییرات ارسال شود.');
    else if (st.expired) notify('اشتراک تمام شده؛ تغییرات آفلاین ارسال نشد.');
    else if (!st.pending && st.online) notify('همه‌چیز همگام است ✓');
    else notify('ارسال کامل نشد؛ اینترنت را بررسی کنید و دوباره بزنید.');
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('.mzSyncBtn');
    if (b) { e.preventDefault(); e.stopPropagation(); manualSync(); }
  }, true);

  /* پیام برای بخشی که هنوز دانلود نشده و اینترنت نیست */
  var LOAD_OFFLINE_MSG = 'برای بارگذاری اولیه‌ی این بخش نیاز به اینترنت دارید. یک‌بار با اینترنت بازش کنید تا برای استفاده‌ی آفلاین روی دستگاه ذخیره شود.';
  window.__loadMsg = function () { return (navigator.onLine === false || !st.online) ? LOAD_OFFLINE_MSG : 'در حال بارگذاری اطلاعات قیمت…'; };
  var lastMissToast = 0;
  window.__offlineDataMissing = function () { var n = Date.now(); if (n - lastMissToast > 30000) { lastMissToast = n; notify(LOAD_OFFLINE_MSG); } };
  window.addEventListener('online', function () { try { for (var k in __rcFails) delete __rcFails[k]; } catch (e) {} try { if (window.__reconcileShards) setTimeout(window.__reconcileShards, 300); } catch (e) {} });

  /* دانلود خودکار پس‌زمینه‌ی داده‌ی پایه (۳ دفترچه × ۱۳۹۹–۱۴۰۴) بعد از ورود، یک‌بار در هر بار باز شدن برنامه */
  var autoPrep = false;
  document.addEventListener('app-data-ready', function () {
    if (autoPrep || demo()) return; autoPrep = true;
    setTimeout(function () { try { if (cur && st.online && navigator.onLine !== false && !(navigator.connection && navigator.connection.saveData)) prepareOffline(null, true); } catch (e) {} }, 6000);
  });

  window.__offline = {
    request: request, flush: flush, prefetch: prefetch, prepareOffline: prepareOffline,
    status: function () { return Object.assign({}, st, { user: cur && cur.key }); },
    maxOfflineDays: MAX_OFFLINE_DAYS
  };

  /* ---------- شروع ---------- */
  (async function init() {
    if (!(await idbReady)) return;
    pendingLogout = !!(await kvGet('pendingLogout'));
    var u = await kvGet('user');
    if (u && u.key) cur = u;
    await refreshPending();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
    if (cur && st.pending) setTimeout(flush, 1500);
  })();

  /* ثبت سرویس‌ورکر */
  try {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(function (e) { console.warn('sw register', e); });
      });
    }
  } catch (e) {}
})();
