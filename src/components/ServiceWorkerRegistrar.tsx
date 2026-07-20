"use client";

import { useEffect } from "react";

/**
 * Registers the hand-written service worker. No-op where unsupported.
 *
 * PRODUCTION ONLY, deliberately. Turbopack reuses chunk filenames across dev
 * rebuilds while the contents change, so any caching service worker will happily
 * serve yesterday's stylesheet from a URL that looks unchanged — edits appear to
 * do nothing and you go hunting for a bug in your CSS. In production the
 * filenames are content-hashed and this problem doesn't exist.
 *
 * It also actively unregisters itself in dev, so a worker installed by an
 * earlier build doesn't linger and keep poisoning the cache.
 */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      void navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const r of regs) void r.unregister();
      });
      void caches?.keys().then((keys) => {
        for (const k of keys) if (k.startsWith("civicagent-")) void caches.delete(k);
      });
      return;
    }

    // Registration failures are non-fatal — the app works fine without it.
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {});
  }, []);

  return null;
}
