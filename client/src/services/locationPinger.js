// client/src/services/locationPinger.js
// ─────────────────────────────────────────────────────────────────────────────
//  PWA Location Pinger + Push Subscription Manager
//
//  Responsibilities:
//   1. Request geolocation permission and store pings to the server.
//   2. Batch-sync offline pings on reconnect.
//   3. Register the device for Web Push notifications (VAPID).
//   4. Expose a clean API for the ReportWizard to use.
//
//  Privacy:
//   • Location is NEVER stored locally beyond a 100-ping offline buffer.
//   • The user must explicitly call startPinging() (called after they consent).
//   • Pings stop as soon as stopPinging() is called or the page unloads.
// ─────────────────────────────────────────────────────────────────────────────

const PING_INTERVAL_MS    = 5 * 60 * 1000;  // 5 minutes
const OFFLINE_PING_KEY    = 'lastseen_pending_pings';
const MAX_OFFLINE_PINGS   = 100;

let pingIntervalId = null;

// ─────────────────────────────────────────────────────────────────────────────
//  Location pinging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start background location pinging.
 * Stores pings locally when offline; syncs when back online.
 */
export function startPinging() {
  if (pingIntervalId) return; // already running

  // Ping immediately on start, then every PING_INTERVAL_MS
  captureAndSendPing();
  pingIntervalId = setInterval(captureAndSendPing, PING_INTERVAL_MS);

  window.addEventListener('online', flushOfflinePings);
  window.addEventListener('beforeunload', stopPinging);
}

export function stopPinging() {
  if (pingIntervalId) {
    clearInterval(pingIntervalId);
    pingIntervalId = null;
  }
  window.removeEventListener('online', flushOfflinePings);
}

async function captureAndSendPing() {
  let position;
  try {
    position = await getCurrentPosition();
  } catch (err) {
    // Permission denied or unavailable — silently skip this ping
    return;
  }

  const ping = {
    lat:        position.coords.latitude,
    lng:        position.coords.longitude,
    accuracyM:  Math.round(position.coords.accuracy),
    recordedAt: new Date().toISOString(),
  };

  if (navigator.onLine) {
    try {
      await sendPing(ping);
    } catch {
      queueOfflinePing(ping);
    }
  } else {
    queueOfflinePing(ping);
  }
}

async function sendPing(ping) {
  const res = await fetch('/api/location/ping', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(ping),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Ping rejected: ${res.status}`);
}

export async function flushOfflinePings() {
  const raw = localStorage.getItem(OFFLINE_PING_KEY);
  if (!raw) return;

  let pings;
  try { pings = JSON.parse(raw); } catch { return; }
  if (!pings.length) return;

  try {
    const res = await fetch('/api/location/ping/batch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ pings }),
      credentials: 'include',
    });
    if (res.ok) {
      localStorage.removeItem(OFFLINE_PING_KEY);
    }
  } catch {
    // Still offline — leave queue intact
  }
}

function queueOfflinePing(ping) {
  let queue = [];
  try { queue = JSON.parse(localStorage.getItem(OFFLINE_PING_KEY) || '[]'); } catch {}

  queue.push(ping);

  // Cap the queue to avoid unbounded localStorage growth
  if (queue.length > MAX_OFFLINE_PINGS) {
    queue = queue.slice(-MAX_OFFLINE_PINGS);
  }

  try {
    localStorage.setItem(OFFLINE_PING_KEY, JSON.stringify(queue));
  } catch {
    // localStorage full — drop silently
  }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: 60_000,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Web Push subscription registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register this device for Web Push alerts.
 * Should be called once after the user has logged in and granted permission.
 *
 * @param {number} [radiusKm]  Optional alert radius preference in km.
 * @returns {Promise<boolean>} true if successfully subscribed.
 */
export async function registerPushSubscription(radiusKm) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[Push] Not supported in this browser.');
    return false;
  }

  // 1. Request notification permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.warn('[Push] Permission not granted.');
    return false;
  }

  try {
    // 2. Fetch the VAPID public key from the server
    const keyRes  = await fetch('/api/push/vapid-key');
    const { publicKey } = await keyRes.json();

    // 3. Get the active service worker registration
    const registration = await navigator.serviceWorker.ready;

    // 4. Subscribe to push manager
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    // 5. Send subscription to our server
    const res = await fetch('/api/push/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        subscription: subscription.toJSON(),
        radiusKm: radiusKm || undefined,
      }),
      credentials: 'include',
    });

    if (!res.ok) throw new Error(`Subscribe endpoint returned ${res.status}`);

    console.log('[Push] Subscription registered ✓');
    return true;
  } catch (err) {
    console.error('[Push] Registration failed:', err);
    return false;
  }
}

/**
 * Register the service worker and kick off push + location.
 * Call this once from your app's main entry point after user login.
 */
export async function initPWAServices({ enableLocation = true, alertRadiusKm } = {}) {
  // Register service worker
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[SW] Registered:', reg.scope);
    } catch (err) {
      console.error('[SW] Registration failed:', err);
    }
  }

  // Register for push notifications
  await registerPushSubscription(alertRadiusKm);

  // Start location pinging (requires user consent — only call if user agreed)
  if (enableLocation && 'geolocation' in navigator) {
    startPinging();
    // Flush any offline pings accumulated before login
    if (navigator.onLine) flushOfflinePings();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utility: convert base64 VAPID key to Uint8Array for the browser API
// ─────────────────────────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding  = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64   = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData  = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}
