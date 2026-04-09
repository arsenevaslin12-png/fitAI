"use strict";
// FitAI Service Worker — v1
// Strategy:
//   Static assets (/, /app.js, /manifest.json) → cache-first, update in background
//   API calls (/api/*) → network-first, no cache
//   Everything else → network-first with cache fallback

const CACHE = "fitai-v2";
const STATIC = ["/", "/index.html", "/manifest.json"];

// ── Install: pre-cache shell ──────────────────────────────────────────────────
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Skip non-GET, cross-origin, and Supabase/external requests
  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // API calls → network-first, never cache
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(request).catch(() => new Response(
      JSON.stringify({ ok: false, error: "Vous êtes hors ligne." }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    )));
    return;
  }

  // Static assets → cache-first, update cache in background (stale-while-revalidate)
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const fetchPromise = fetch(request).then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
      }).catch(() => null);
      return cached || fetchPromise || new Response("Offline", { status: 503 });
    })
  );
});
