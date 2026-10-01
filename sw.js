// Minimal service worker — registers only so iOS PWA install gets a few
// install-time perks. We deliberately do NOT cache API responses (the user
// expects live data), and we do NOT precache the shell aggressively because
// v1 ships rapidly. Network-only with a tiny same-origin runtime cache for
// static assets is good enough.

const STATIC_CACHE = "mes-static-v16";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => null))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never intercept API calls — the PWA hits a different origin (mesh-gateway).
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;
  // NEVER cache the auth backend (same-origin in prod): a cached /auth/me or
  // /auth/identity-token would serve a stale/expired gateway-trusted bearer.
  if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/gw/")) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
