/**
 * Offline play: keeps the whole app (page, scripts, emulator cores, covers.json)
 * on the device so it opens and plays without a network. Built by the
 * service-worker plugin in vite.config.ts, which fills in VERSION and PRECACHE;
 * each deploy is a new version that installs alongside the old one and takes
 * over once every tab of the old one is closed.
 *
 * /api is left to the network (SaveSync already queues saves while offline),
 * except box art, which is kept once it has been shown.
 */

const VERSION = "__VERSION__";
const PRECACHE = /** @type {string[]} */ (__PRECACHE__);

const APP_CACHE = `app-${VERSION}`;
const COVERS_CACHE = "covers";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => (k.startsWith("app-") && k !== APP_CACHE) || k === "fonts").map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith("/api/covers/")) {
    event.respondWith(cacheFirst(request, COVERS_CACHE));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;

  // Pages: the newest when online, this version's copy when not (every route is the same SPA page).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("/", { cacheName: APP_CACHE })) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(url.pathname, { cacheName: APP_CACHE }).then((cached) => cached ?? fetch(request)),
  );
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}
