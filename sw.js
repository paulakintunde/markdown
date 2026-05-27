/**
 * Markdown Editor — Service Worker
 * Strategy:
 *   - App shell (HTML + manifest + icons): cache-first, update in background
 *   - Known CDN resources (jsDelivr): cache-first (URLs are pinned/immutable)
 *   - esm.sh (CodeMirror dynamic imports): network-first, cache as fallback
 *   - Everything else: network-first, cache as fallback
 */

const SHELL_CACHE   = 'md-shell-v1';
const CDN_CACHE     = 'md-cdn-v1';
const RUNTIME_CACHE = 'md-runtime-v1';

// ── App shell ─────────────────────────────────────────────────────────────────
const SHELL_URLS = [
  '/markdown/',
  '/markdown/manifest.json',
  '/markdown/icons/icon.svg',
  '/markdown/icons/icon-192.png',
  '/markdown/icons/icon-512.png',
];

// ── Pinned CDN resources (versioned URLs = safe to cache forever) ─────────────
const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css',
  'https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js',
  'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js',
  'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js',
  'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
];

// ─────────────────────────────────────────────────────────────────────────────
// INSTALL — pre-cache shell + CDN resources
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then(cache =>
        // Use individual add() so one failure doesn't block the whole install
        Promise.allSettled(SHELL_URLS.map(url => cache.add(url)))
      ),
      caches.open(CDN_CACHE).then(cache =>
        Promise.allSettled(CDN_URLS.map(url => cache.add(url)))
      ),
    ]).then(() => self.skipWaiting())
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATE — delete stale caches from old versions
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  const KEEP = [SHELL_CACHE, CDN_CACHE, RUNTIME_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// FETCH — routing logic
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Non-GET requests: always go to network
  if (request.method !== 'GET') return;

  // ── esm.sh (CodeMirror dynamic imports) ──────────────────────────────────
  // Network-first; cache on success so it works offline after first load.
  if (url.hostname === 'esm.sh') {
    event.respondWith(networkFirstWithCache(request, RUNTIME_CACHE));
    return;
  }

  // ── Pinned CDN resources (jsDelivr) ──────────────────────────────────────
  // Cache-first — these URLs never change content (pinned versions).
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  // ── App shell (same origin, /markdown/* paths) ────────────────────────────
  if (url.origin === self.location.origin && url.pathname.startsWith('/markdown/')) {
    event.respondWith(shellStrategy(request));
    return;
  }

  // ── Everything else: network-first ───────────────────────────────────────
  event.respondWith(networkFirstWithCache(request, RUNTIME_CACHE));
});

// ─────────────────────────────────────────────────────────────────────────────
// Strategy helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache-first: return cached response if available, otherwise fetch and cache.
 */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('Offline — resource not cached', { status: 503 });
  }
}

/**
 * Network-first: try network, fall back to cache.
 * On success, update the cache in the background.
 */
async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached ?? new Response('Offline — resource not cached', { status: 503 });
  }
}

/**
 * Shell strategy: serve from cache immediately, then update cache in background
 * (stale-while-revalidate for the app HTML so updates land on next visit).
 */
async function shellStrategy(request) {
  const cache  = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);

  const networkFetch = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  // Serve cache immediately if available, otherwise wait for network
  return cached ?? (await networkFetch) ?? new Response('Offline', { status: 503 });
}
