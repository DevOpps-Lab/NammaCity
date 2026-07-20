/**
 * Hand-written service worker.
 *
 * Deliberately not next-pwa/Serwist: Next 16 defaults to Turbopack and fails
 * the build outright when a webpack config is present, which both of those
 * plugins require.
 *
 * Scope here is modest on purpose — cache the shell and the ward polygons so
 * the map and the Tier 1 resolver survive a dead network. Report submission
 * queues in IndexedDB rather than failing, which matters on Indian streets
 * where signal is unreliable.
 */

const CACHE = "civicagent-v3";

// The ward file is the Tier 1 routing dataset — 594KB, and the single most
// important thing to have offline. Without it the demo loses its centrepiece.
//
// HTML documents are deliberately NOT precached. The app is behind auth, and a
// cached navigation response is served without the proxy ever running — which
// means a stale login redirect, or one account's shell handed to the next. You
// cannot sign in offline regardless, so an offline HTML shell buys nothing and
// costs correctness.
const PRECACHE = ["/data/chennai-wards.geojson", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never serve a stale routing answer.
  if (url.pathname.startsWith("/api/")) return;

  // Never intercept a document navigation — those must reach the proxy so the
  // session is checked and refreshed on every load.
  if (request.mode === "navigate") return;

  // Cache-first for the big static ward dataset and app icons.
  if (url.pathname.startsWith("/data/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return res;
      }))
    );
    return;
  }

  // Build output (/_next/static/) is deliberately NOT cached here. It is
  // already served with long-lived immutable headers in production, so the HTTP
  // cache covers it — and a cache-first rule in the worker is actively harmful,
  // because a chunk filename that gets reused with new contents pins the stale
  // copy forever with no way to invalidate it short of clearing site data.

  // Everything else goes straight to the network, uncached.
});
