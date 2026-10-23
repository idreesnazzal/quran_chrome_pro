/* Service worker: the app works offline and installs as an app (PWA).
 *  - code (html/js/css): NETWORK FIRST — always the latest when online, the
 *    cached copy offline (so edits are never hidden behind a stale cache)
 *  - mushaf pages, data files, icons, vendored libraries: CACHE FIRST; only the
 *    data files are refreshed in the background (stale-while-revalidate) — the
 *    22 MB vendored runtime and the icons are fixed: BUMP VERSION when they change.
 *    A page is cached once viewed, or all 604 at once from ⚙️ الإعدادات →
 *    «تنزيل كل الصفحات»
 *  - everything else (recitation audio, online tafsir, the local server's
 *    endpoints, POSTs): straight to the network, never cached
 */
const VERSION = 'mushaf-v2';
const CODE = VERSION + '-code', ASSETS = VERSION + '-assets', PAGES = 'mushaf-pages';   // pages survive version bumps
const PRECACHE_CODE = ['./', 'index.html', 'manifest.webmanifest', 'assets/js/recite-by-mic.js', 'assets/js/ayah-lists.js',
  'assets/js/settings.js', 'assets/js/reader-plus.js', 'assets/js/hifz-test.js', 'assets/css/ayah-lists.css', 'assets/css/settings.css',
  'assets/css/reader-plus.css', 'assets/css/hifz-test.css'];
const PRECACHE_ASSETS = ['data/quran_data.js', 'data/word_boxes.js', 'data/quran_meta.js', 'data/asbab_data.js',
  'assets/icons/icon-192.png', 'assets/icons/icon-512.png', 'assets/icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CODE), a = await caches.open(ASSETS);
    await Promise.all([
      ...PRECACHE_CODE.map((u) => c.add(u).catch(() => {})),
      ...PRECACHE_ASSETS.map((u) => a.add(u).catch(() => {})),
    ]);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CODE && k !== ASSETS && k !== PAGES) await caches.delete(k);
    await self.clients.claim();
  })());
});

function kind(url) {
  if (url.origin !== self.location.origin) {
    return /raw\.githubusercontent\.com\/zdig1\/quran\/main\/quran_pages\//.test(url.href) ? 'page' : null;   // page-image fallback
  }
  const p = url.pathname;
  if (/\/(health|debug-save|transcribe|status)\b/.test(p)) return null;     // local server endpoints
  if (/\/pages\/\d{3}\.webp$/.test(p)) return 'page';
  if (/\/data\/|\/assets\/(icons|vendor|models)\//.test(p)) return 'asset';
  if (/\.(html|js|mjs|css|webmanifest)$/.test(p) || p.endsWith('/')) return 'code';
  return null;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url), k = kind(url);
  if (!k) return;
  if (k === 'code') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CODE)).put(req, res.clone());
        return res;
      } catch (err) {
        return (await caches.match(req, { ignoreSearch: true })) || (await caches.match('index.html')) || Response.error();
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(k === 'page' ? PAGES : ASSETS);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = () => fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { if (/\/data\//.test(url.pathname)) e.waitUntil(net()); return hit; }   // pages, icons, vendor never change
    return (await net()) || Response.error();
  })());
});

/* «تنزيل كل الصفحات»: the page asks, the worker fetches and reports progress */
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'cache-pages') return;
  const port = e.ports && e.ports[0];
  e.waitUntil((async () => {
    const cache = await caches.open(PAGES);
    let done = 0, failed = 0;
    const urls = Array.from({ length: 604 }, (_, i) => 'pages/' + String(i + 1).padStart(3, '0') + '.webp');
    const next = async () => {
      while (urls.length) {
        const u = urls.shift();
        try {
          if (!(await cache.match(u))) { const r = await fetch(u); if (r.ok) await cache.put(u, r); else failed++; }
        } catch (err) { failed++; }
        done++;
        if (port && (done % 8 === 0 || done === 604)) port.postMessage({ done, failed, total: 604 });
      }
    };
    await Promise.all([next(), next(), next(), next()]);
  })());
});
