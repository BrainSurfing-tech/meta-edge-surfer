// Minimal service worker — registers only so iOS PWA install gets a few
// install-time perks. We deliberately do NOT cache API responses (the user
// expects live data), and we do NOT precache the shell aggressively because
// v1 ships rapidly. Network-only with a tiny same-origin runtime cache for
// static assets is good enough.

const STATIC_CACHE = "mes-static-v40";
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
    caches
      .open(STATIC_CACHE)
      // {cache:"reload"}: precache must bypass the HTTP cache. A plain
      // addAll consults it, so an app.js pinned stale by a long max-age
      // would be precached stale and the installed PWA would keep old code
      // past the version bump (card #1007).
      .then((cache) =>
        cache
          .addAll(STATIC_ASSETS.map((u) => new Request(u, { cache: "reload" })))
          .catch(() => null),
      )
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

// card #1230: the push payload is ids only. The words on the notification
// come from the gateway render, never from the payload. A failed or unknown
// row still shows a notice — a silent push is how Safari burns the channel.
const PUSH_GENERIC = "board: open rows";

async function pushNotice(payload, fetchImpl) {
  const row = payload && payload.row_id;
  const msg = payload && payload.msg_id;
  const data = { row_id: row ?? null, msg_id: msg ?? null };
  const generic = { title: PUSH_GENERIC, body: "", data };
  if (row == null || msg == null) return generic;
  try {
    // /gw/ does not turn the SSO cookie into an Authorization header.
    // Mint a bearer from the same-origin identity cookie, then send it.
    const tokRes = await fetchImpl("/auth/identity-token", { credentials: "include" });
    if (!tokRes || !tokRes.ok) return generic;
    const tokBody = await tokRes.json();
    const token = tokBody && tokBody.token;
    if (!token) return generic;
    const res = await fetchImpl(`/gw/push/render/${row}?msg=${encodeURIComponent(msg)}`, {
      credentials: "include",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res || !res.ok) return generic;
    const body = await res.json();
    if (!body || typeof body.title !== "string" || !body.title.trim()) return generic;
    return {
      title: body.title,
      body: body.label ? String(body.label) : "",
      data: { ...data, card_id: body.card_id },
    };
  } catch {
    return generic;
  }
}

function pushOpenUrl(data) {
  const url = new URL("./", self.location);
  url.searchParams.set("view", "actions");
  if (data && data.row_id != null) url.searchParams.set("row", String(data.row_id));
  if (data && data.msg_id != null) url.searchParams.set("msg", String(data.msg_id));
  return url.href;
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
    const note = await pushNotice(payload, (url, opts) => fetch(url, opts));
    await self.registration.showNotification(note.title, {
      body: note.body,
      data: note.data,
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = pushOpenUrl(event.notification.data || {});
  event.waitUntil(self.clients.openWindow(url));
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
