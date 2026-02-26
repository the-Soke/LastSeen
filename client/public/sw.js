// ─────────────────────────────────────────────────────────────────────────────
//  LastSeen — Service Worker  (sw.js)
//  Strategy: Cache-first for static assets, Network-first for API calls.
//  Offline report submissions are queued via Background Sync (with localStorage
//  fallback for browsers that don't support it).
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME    = 'lastseen-v1';
const OFFLINE_QUEUE = 'lastseen_offline_queue';

// Assets to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/report.html',
  '/offline.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: route requests ──────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API POST requests → queue if offline
  if (url.pathname.startsWith('/api/') && request.method === 'POST') {
    event.respondWith(networkWithOfflineQueue(request));
    return;
  }

  // API GET requests → network first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Static assets → cache first
  event.respondWith(cacheFirst(request));
});

// ── Background Sync ───────────────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-reports') {
    event.waitUntil(syncOfflineReports());
  }
});

// ── Push Notifications ────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'LastSeen Alert', body: 'A new missing child alert near you.' };
  try { data = event.data.json(); } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     data.caseId || 'lastseen-alert',
      data:    { url: data.caseUrl || '/cases' },
      actions: [
        { action: 'view',   title: 'View Case' },
        { action: 'tip',    title: 'Submit Tip' },
        { action: 'dismiss',title: 'Dismiss'   },
      ],
      vibrate: [200, 100, 200],
      requireInteraction: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      const existing = clientList.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow(targetUrl);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
//  Strategy helpers
// ─────────────────────────────────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return caches.match('/offline.html');
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function networkWithOfflineQueue(request) {
  try {
    const response = await fetch(request.clone());
    return response;
  } catch {
    // Save to queue via IDB (IndexedDB through a helper)
    // The client-side JS also saves to localStorage as a secondary fallback.
    const body = await request.clone().json();
    await saveToQueue(body);

    // Register a background sync task
    try {
      await self.registration.sync.register('sync-reports');
    } catch {}

    return new Response(JSON.stringify({
      queued: true,
      message: 'Report saved offline. Will sync when back online.'
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Offline queue helpers (IndexedDB)
// ─────────────────────────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lastseen-sw-db', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('offlineQueue', {
        keyPath: 'id', autoIncrement: true
      });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function saveToQueue(payload) {
  const db    = await openDB();
  const tx    = db.transaction('offlineQueue', 'readwrite');
  const store = tx.objectStore('offlineQueue');
  store.add({ payload, savedAt: new Date().toISOString() });
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function syncOfflineReports() {
  const db      = await openDB();
  const tx      = db.transaction('offlineQueue', 'readwrite');
  const store   = tx.objectStore('offlineQueue');
  const allReq  = store.getAll();

  return new Promise((resolve) => {
    allReq.onsuccess = async () => {
      const items = allReq.result;
      for (const item of items) {
        try {
          const res = await fetch('/api/reports', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(item.payload)
          });
          if (res.ok) {
            store.delete(item.id);
            console.log('[SW] Synced offline report', item.id);
          }
        } catch (err) {
          console.warn('[SW] Sync failed for item', item.id, err);
        }
      }
      resolve();
    };
  });
}
