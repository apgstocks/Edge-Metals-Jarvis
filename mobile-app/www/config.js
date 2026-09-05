// ── Jarvis Loads app — API base URL ─────────────────────────────────────
// Points at the yard server on Apsara's own domain.
//
// CHANGED 2026-09-03, and the change is the point. This used to be a random
// *.trycloudflare.com hostname tied to one cloudflared process — a URL that
// changed every time the VM rebooted, that process restarted, or it crashed
// and PM2 respawned it. Every one of those events silently broke the app
// until someone edited this file and rebuilt the APK. That is why the
// in-app server box exists at all.
//
// jarvis.edgemetals.com is an A record pointing at the VM's STATIC IP
// (35.233.131.198), with Caddy terminating HTTPS in front of the app on
// :8080. It survives reboots, restarts and crashes, because none of those
// change the address any more.
//
// WHAT STILL BREAKS IT: letting edgemetals.com lapse, or releasing the
// static IP. The domain renews Aug 2028 with auto-renew on. The IP is
// promoted to static and must stay attached to the VM — a static address
// left detached from any resource is both billed at a higher rate and
// liable to be cleaned up.
//
// The in-app server box (Settings, and the login screen when the server is
// unreachable) still overrides this at runtime and is stored in
// localStorage, so a URL change never again requires a rebuild — this is
// only the default a FRESH install starts from.
//
// Nothing else in this app needs to change when the backend URL changes —
// every api() call in index.html reads API_BASE from here.
window.JARVIS_CONFIG = {
  API_BASE: 'https://jarvis.edgemetals.com',
};
