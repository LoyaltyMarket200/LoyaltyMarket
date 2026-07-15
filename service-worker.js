const CACHE_NAME = "loyaltymarket-cache-v2";

// Pages and static assets to pre-cache on install.
// NOTE: bump CACHE_NAME (v2 -> v3 etc.) any time you add/remove entries here
// or change CSS/JS significantly, so returning visitors get the update.
const CORE_ASSETS = [
  "/index.html",
  "/login.html",
  "/register.html",
  "/welcome.html",
  "/dashboard.html",
  "/sell.html",
  "/edit-product.html",
  "/search.html",
  "/product-detail.html",
  "/seller-profile.html",
  "/business-profile.html",
  "/category-vehicles.html",
  "/category-property.html",
  "/category-jobs.html",
  "/style.css",
  "/marketplace.css",
  "/footer.css",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png"
];

// Domains the service worker should NEVER intercept — Firebase Auth,
// Firestore, and Storage all rely on their own network/streaming behavior,
// and wrapping their requests in respondWith() can break login, real-time
// listeners, and uploads in subtle ways.
const BYPASS_HOSTS = [
  "googleapis.com",
  "firebaseapp.com",
  "firebaseio.com",
  "gstatic.com"
];

function shouldBypass(url) {
  return BYPASS_HOSTS.some((host) => url.hostname.endsWith(host));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll fails entirely if even one asset 404s — use individual
      // add() calls so one missing file doesn't block the whole install.
      return Promise.all(
        CORE_ASSETS.map((asset) =>
          cache.add(asset).catch((err) => {
            console.warn("Service worker: failed to cache", asset, err);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle same-origin GET requests. Everything else (Firebase calls,
  // POST/PUT, third-party scripts) passes straight to the network untouched.
  if (request.method !== "GET" || shouldBypass(url) || url.origin !== self.location.origin) {
    return;
  }

  // Page navigations: network-first, so deployed updates show up right away.
  // Falls back to the cached copy (or cached index.html) when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          return networkResponse;
        })
        .catch(() => {
          return caches.match(request).then((cached) => cached || caches.match("/index.html"));
        })
    );
    return;
  }

  // Static assets (CSS, images, icons): cache-first for speed, falling
  // back to network and caching the result for next time.
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => undefined);
    })
  );
});
