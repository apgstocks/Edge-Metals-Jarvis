// ── dashboard/sw.js — minimal service worker, added ONLY to satisfy
// Chrome/Edge's PWA installability check ────────────────────────────────────
// Per Apsara: manifest.webmanifest + icons + HTTPS (via the Cloudflare
// tunnel) were already in place, but no "Install Jarvis" icon ever showed up
// in Chrome's address bar. Confirmed by reading the repo: there was no
// service worker anywhere (no sw.js, no service-worker.js, nothing
// registering one from dashboard/index.html) — and a registered service
// worker is part of Chrome/Edge's standard installability criteria on
// desktop, alongside the manifest and HTTPS. This is almost certainly why
// the icon never appeared, on either the old plain-HTTP address or the new
// Cloudflare HTTPS one (the service worker requirement would have blocked
// it regardless of HTTPS).
//
// Deliberately does NOT do offline caching, background sync, or anything
// that could make the dashboard show stale data — Jarvis's whole value is
// live booking/inventory/quote state, and a caching service worker that
// silently served yesterday's numbers would be actively dangerous for an
// operations tool like this. It exists purely to make the browser consider
// the page installable; every request still goes straight to the network.
self.addEventListener('install', () => {
    // Activate immediately rather than waiting for all tabs to close — this
    // is a passthrough worker, there's no old cache to worry about
    // conflicting with.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// A no-op fetch handler that just lets every request go to the network
// exactly as if this worker didn't exist. Some installability checks look
// for the mere presence of a fetch handler, not caching behavior — this
// satisfies that without changing what the dashboard actually loads.
self.addEventListener('fetch', () => {
    // Intentionally does not call event.respondWith() — the browser's
    // default network handling takes over unchanged.
});
