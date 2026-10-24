/* METRIZ service worker — استفاده‌ی آفلاین
   - پوسته‌ی برنامه (index/فونت/آیکن): اول شبکه، اگر نبود از کش. همیشه آخرین نسخه‌ی سرور وقتی آنلاین هستید.
   - /data/*: اول شبکه (سقف روزانه‌ی سرور مثل قبل حساب می‌شود)، فقط اگر شبکه قطع بود از کش.
     کش داده فقط وقتی استفاده می‌شود که اشتراک منقضی نشده و آخرین تأیید آنلاین حداکثر MAX_OFFLINE_DAYS روز پیش بوده باشد.
   - /api/* را هرگز دست نمی‌زند (صف آفلاین پروژه‌ها در صفحه است: offline.js). */
const VERSION = 'v1';
const SHELL = 'metriz-shell-' + VERSION;
const DATA = 'metriz-data-v1';
const META = 'metriz-meta-v1';
const MAX_OFFLINE_DAYS = 14;
const DAY = 86400000;

const SHELL_URLS = [
  '/', '/offline.js', '/logo.png', '/browserconfig.xml',
  '/data/manifest.json', '/data/manifest-light.json',
  '/AGhasem.ttf', '/BNazanin.ttf', '/BYekan__Bold.ttf', '/stencil-Regular.ttf',
  '/Icon/hh-dark-favicon-16.png', '/Icon/hh-dark-favicon-32.png', '/Icon/hh-dark-192.png', '/Icon/hh-dark-apple-180.png',
  '/Icon/hh-light-favicon-16.png', '/Icon/hh-light-favicon-32.png', '/Icon/hh-light-192.png', '/Icon/hh-light-apple-180.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil((async function () {
    const c = await caches.open(SHELL);
    /* هر فایل جدا: نبودن یک فایل کل نصب را خراب نکند */
    await Promise.all(SHELL_URLS.map(function (u) {
      return fetch(u, { cache: 'reload', credentials: 'same-origin' }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {});
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keep = new Set([SHELL, DATA, META]);
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return !keep.has(k); }).map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

/* صفحه بعد از ورود/خروج به ما خبر می‌دهد: {type:'meta', userKey, expires_at, verifiedAt} یا {type:'clear'} */
self.addEventListener('message', function (e) {
  const d = e.data || {};
  e.waitUntil((async function () {
    if (d.type === 'meta') {
      const c = await caches.open(META);
      await c.put('/__meta', new Response(JSON.stringify({ userKey: d.userKey || '', expires_at: d.expires_at == null ? null : Number(d.expires_at), verifiedAt: Number(d.verifiedAt) || Date.now() }), { headers: { 'content-type': 'application/json' } }));
    } else if (d.type === 'clear') {
      await caches.delete(DATA); await caches.delete(META);
    }
  })());
});

async function offlineAllowed() {
  try {
    const c = await caches.open(META);
    const r = await c.match('/__meta');
    if (!r) return false;
    const m = await r.json();
    const now = Date.now();
    if (!m.verifiedAt || now - m.verifiedAt > MAX_OFFLINE_DAYS * DAY) return false;
    if (m.expires_at != null && now >= m.expires_at) return false; /* اشتراک تمام شده: داده‌ی پایه بسته است */
    return true;
  } catch (_) { return false; }
}

function isShellAsset(p) {
  return p === '/offline.js' || p === '/logo.png' || p === '/browserconfig.xml' ||
    /^\/(?:Icon\/)?(?:favicon\.ico|apple-touch-icon[^/]*\.png|hh-[^/]+\.(?:png|ico))$/.test(p) ||
    /\.(?:ttf|woff2?)$/i.test(p) || /^\/data\/manifest(?:-light)?\.json$/.test(p);
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.indexOf('/api/') === 0 || p === '/sw.js') return;

  if (req.mode === 'navigate') { e.respondWith(navigate(req)); return; }
  if (isShellAsset(p)) { e.respondWith(staticAsset(req, p)); return; }
  if (/^\/data\//.test(p)) { e.respondWith(dataRequest(req, p)); return; }
});

/* صفحه‌ی اصلی: همیشه اول شبکه؛ نسخه‌ی کش‌شده فقط وقتی شبکه نیست */
async function navigate(req) {
  const c = await caches.open(SHELL);
  try {
    const r = await fetch(req);
    if (r.ok && r.type !== 'opaqueredirect') c.put('/', r.clone()).catch(function () {});
    return r;
  } catch (_) {
    const hit = await c.match('/', { ignoreSearch: true });
    return hit || new Response('آفلاین هستید و هنوز نسخه‌ای از برنامه روی این دستگاه ذخیره نشده است. یک‌بار با اینترنت باز کنید.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

/* فونت/آیکن/offline.js: از کش بده و در پس‌زمینه تازه کن */
async function staticAsset(req, p) {
  const c = await caches.open(SHELL);
  const hit = await c.match(p, { ignoreSearch: true });
  const net = fetch(req).then(function (r) { if (r.ok) c.put(p, r.clone()).catch(function () {}); return r; });
  if (hit) { net.catch(function () {}); return hit; }
  return net;
}

/* داده‌ی قیمت: اول شبکه (تا کنترل سرور—لاگین، اشتراک، سقف—مثل قبل بماند)، شبکه قطع بود از کش */
async function dataRequest(req, p) {
  const c = await caches.open(DATA);
  let r;
  try {
    r = await fetch(req);
  } catch (_) {
    if (await offlineAllowed()) {
      const hit = await c.match(p, { ignoreVary: true, ignoreSearch: true });
      if (hit) return hit;
    }
    return new Response(JSON.stringify({ error: 'آفلاین هستید و این بخش از داده قبلاً روی دستگاه ذخیره نشده است.' }), { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  if (r.status === 200) c.put(p, r.clone()).catch(function () {});
  else if (r.status === 401 || r.status === 403) { caches.delete(DATA).catch(function () {}); } /* خروج/انقضا: نسخه‌های محلی هم بسته شوند */
  return r;
}
