/* Qonnect Smart House service worker.
 *
 * Caching policy (privacy first):
 *   - ONLY the static app shell (index.html, manifest, icons, logo) and content-hashed
 *     build assets (/assets/*) are cached.
 *   - /api/* is never intercepted or cached: no project data, payments, uploads or any
 *     authenticated response is ever stored by the service worker.
 *   - No offline editing and no queued writes; non-GET requests pass straight through.
 *   - Page loads always come from the network; if it is unreachable a small "Can't reach Qonnect" page is shown.
 * Push:
 *   - Shows the generic notification sent by the server and opens the in-app link on tap.
 *     The app then requires the normal login and permission checks before showing details.
 */
const VERSION = '__SW_VERSION__';
const SHELL_CACHE = `qonnect-shell-${VERSION}`;
const ASSET_CACHE = 'qonnect-assets-v1';
const SHELL = ['/', '/manifest.webmanifest', '/qonnect-logo.png', '/favicon.ico', '/favicon-64.png',
  '/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload', credentials: 'omit' })))),
  );
  // the new version waits until the page asks it to activate (see SKIP_WAITING)
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('qonnect-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    // trim hashed assets that the current shell no longer references
    await trimAssets();
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function trimAssets() {
  try {
    const shell = await caches.open(SHELL_CACHE);
    const res = await shell.match('/');
    if (!res) return;
    const html = await res.text();
    const cache = await caches.open(ASSET_CACHE);
    for (const req of await cache.keys()) {
      const p = new URL(req.url).pathname;
      if (!html.includes(p)) await cache.delete(req);
    }
  } catch { /* best effort */ }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never touch API traffic

  // App navigation: always from the network. When the server can't be reached, show a clear
  // offline page instead of an old cached shell (Qonnect has no offline mode and an old shell can
  // reference build files that are not cached, which shows a blank page).
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok && (fresh.headers.get('content-type') || '').includes('text/html')) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put('/', fresh.clone()); // kept only to know which build files are current
        }
        return fresh;
      } catch {
        return offlinePage(req.url);
      }
    })());
    return;
  }

  // Content-hashed build assets are immutable → cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) await cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Other shell files (icons, manifest, logo): cache, refreshed in the background.
  if (SHELL.includes(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(url.pathname);
      const refresh = fetch(req).then((res) => { if (res.ok) cache.put(url.pathname, res.clone()); return res; }).catch(() => hit || Response.error());
      return hit || refresh;
    })());
  }
  // everything else: default network behaviour, not cached
});

function offlinePage(url) {
  // a changed query string forces a real page load (a same-URL link with only a #hash would not reload)
  const retry = new URL(url);
  retry.searchParams.set('retry', String(Date.now()));
  const href = retry.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qonnect — can't connect</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#0f172a;font-family:'Plus Jakarta Sans',system-ui,sans-serif}
main{max-width:420px;margin:24px;padding:28px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;text-align:center}
img{width:48px;height:48px}h1{font-size:18px;margin:12px 0 6px}p{font-size:14px;color:#475569;line-height:1.5;margin:0 0 18px}
a{display:inline-block;padding:10px 18px;border-radius:10px;background:#0284c7;color:#fff;font-weight:600;font-size:14px;text-decoration:none}</style></head>
<body><main><img src="/icons/icon-192.png" alt=""><h1>Can't reach Qonnect</h1>
<p>The server didn't respond. Check your internet connection (or, for staging, that the SSH tunnel is open), then try again.</p>
<a href="${href}">Try again</a></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ------------------------------------------------------------------ push
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === 'string' ? data.title : 'Qonnect';
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : 'You have a new notification.',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: 'OPEN_URL', url: target.pathname + target.search + target.hash });
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
