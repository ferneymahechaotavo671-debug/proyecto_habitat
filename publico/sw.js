const CACHE_NAME  = "habitat-v3";
const SYNC_TAG    = "sync-rondas";
const IDB_NAME    = "habitat-offline";
const IDB_VER     = 1;
const IDB_STORE   = "rondas_pendientes";

const STATIC = [
  "/", "/index.html", "/manifest.json",
  "/logo.png", "/icon-192.png", "/icon-512.png",
];

// ── IndexedDB helpers ──────────────────────────────────────────────────────
function abrirIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const store = db.createObjectStore(IDB_STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("fecha_hora", "fecha_hora", { unique: false });
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function guardarPendiente(payload) {
  const db    = await abrirIDB();
  const tx    = db.transaction(IDB_STORE, "readwrite");
  tx.objectStore(IDB_STORE).add(payload);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function obtenerPendientes() {
  const db    = await abrirIDB();
  const tx    = db.transaction(IDB_STORE, "readonly");
  const store = tx.objectStore(IDB_STORE);
  return new Promise((res, rej) => {
    const req = store.getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function eliminarPendiente(id) {
  const db  = await abrirIDB();
  const tx  = db.transaction(IDB_STORE, "readwrite");
  tx.objectStore(IDB_STORE).delete(id);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

// ── Install ────────────────────────────────────────────────────────────────
self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC).catch(() => {}))
  );
});

// ── Activate ───────────────────────────────────────────────────────────────
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Interceptar POST /ronda para soporte offline
  if (url.pathname === "/ronda" && e.request.method === "POST") {
    e.respondWith(manejarRonda(e.request.clone()));
    return;
  }

  // Endpoint /lugares: network-first con fallback a cache (para modo offline)
  if (url.pathname === "/lugares") {
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put("/lugares", clone));
        return res;
      }).catch(() => caches.match("/lugares"))
    );
    return;
  }

  // Admin y login: solo red
  if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/login") ||
      url.pathname.startsWith("/registro")) {
    return;
  }

  // Estáticos: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type === "opaque") return res;
        caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => caches.match("/index.html"));
    })
  );
});

// ── Lógica de ronda con fallback offline ──────────────────────────────────
async function manejarRonda(request) {
  let payload;
  try { payload = await request.json(); } catch { payload = {}; }

  // Marcar con timestamp exacto del escaneo (antes de cualquier intento de red)
  payload.fecha_hora_local = new Date().toISOString();

  try {
    const res = await fetch("/ronda", {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(payload),
    });
    // Subió bien — notificar a la página si estaba pendiente
    if (res.ok) notificarClientes({ tipo: "ronda_ok", online: true });
    return res;
  } catch {
    // Sin internet — guardar en IDB
    await guardarPendiente({ ...payload, guardado: new Date().toISOString() });

    // Registrar sync para cuando vuelva la red
    try { await self.registration.sync.register(SYNC_TAG); } catch {}

    // Notificar a la página
    notificarClientes({ tipo: "ronda_offline", lugar: payload.lugarNombre || "" });

    // Respuesta fake exitosa para que la UI muestre confirmación
    return new Response(JSON.stringify({
      mensaje  : "Guardado sin conexión — se enviará automáticamente",
      offline  : true,
      lugar    : payload.lugarNombre || "",
      vigilante: "Vigilante",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
}

// ── Background Sync ────────────────────────────────────────────────────────
self.addEventListener("sync", e => {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(sincronizarPendientes());
  }
});

async function sincronizarPendientes() {
  const pendientes = await obtenerPendientes();
  if (!pendientes.length) return;

  let subidos = 0;
  for (const item of pendientes) {
    try {
      const { id, guardado, ...payload } = item;
      const res = await fetch("/ronda", {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify(payload),
      });
      if (res.ok) {
        await eliminarPendiente(id);
        subidos++;
      }
    } catch {
      break; // Si falla de nuevo, esperar al siguiente sync
    }
  }

  if (subidos > 0) {
    notificarClientes({ tipo: "sync_completado", subidos });
    // Mostrar notificación push si la app está en segundo plano
    try {
      await self.registration.showNotification("Habitat — Rondas sincronizadas", {
        body: `${subidos} ronda${subidos > 1 ? "s" : ""} enviada${subidos > 1 ? "s" : ""} al servidor`,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: "sync-ok",
      });
    } catch {}
  }
}

// ── Mensaje desde la página: sincronizar manualmente ─────────────────────
self.addEventListener("message", async e => {
  if (e.data?.tipo === "sync_manual") {
    const result = await sincronizarManual();
    e.source?.postMessage({ tipo: "sync_resultado", ...result });
  }
  if (e.data?.tipo === "contar_pendientes") {
    const items = await obtenerPendientes();
    e.source?.postMessage({ tipo: "pendientes_count", count: items.length });
  }
});

async function sincronizarManual() {
  const pendientes = await obtenerPendientes();
  if (!pendientes.length) return { subidos: 0, pendientes: 0 };
  let subidos = 0, errores = 0;
  for (const item of pendientes) {
    try {
      const { id, guardado, ...payload } = item;
      const res = await fetch("/ronda", {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify(payload),
      });
      if (res.ok) { await eliminarPendiente(id); subidos++; }
      else errores++;
    } catch { errores++; }
  }
  notificarClientes({ tipo: "sync_completado", subidos });
  return { subidos, pendientes: errores };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function notificarClientes(msg) {
  self.clients.matchAll({ includeUncontrolled: true, type: "window" })
    .then(clients => clients.forEach(c => c.postMessage(msg)));
}
