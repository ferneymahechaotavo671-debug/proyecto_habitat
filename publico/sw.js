const CACHE_NAME = "habitat-v2";
const STATIC = [
  "/",
  "/index.html",
  "/manifest.json",
  "/logo.png",
  "/icon-192.png",
  "/icon-512.png",
];

// Instalar: cachear recursos estáticos
self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC).catch(() => {}))
  );
});

// Activar: borrar caches viejas
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first para estáticos, network-first para API
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // API calls: siempre red (no cachear)
  if (url.pathname.startsWith("/registro") ||
      url.pathname.startsWith("/admin") ||
      url.pathname.startsWith("/login")) {
    return; // comportamiento por defecto (red)
  }

  // Estáticos: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type === "opaque") return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      }).catch(() => caches.match("/index.html"));
    })
  );
});
