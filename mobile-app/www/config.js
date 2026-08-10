// ── Jarvis Loads app — API base URL ─────────────────────────────────────
// Points at the Cloudflare Tunnel already running on the VM under PM2
// (process name "jarvis-tunnel", tunnels https://<this> -> localhost:8080).
//
// IMPORTANT — this URL is NOT permanent. It's a randomly-generated
// *.trycloudflare.com hostname tied to that specific cloudflared process.
// It only stays this exact URL as long as that PM2 process keeps running
// without restarting. If the VM reboots, or you run
// `pm2 restart jarvis-tunnel`, or the process crashes and PM2 respawns it,
// you'll get a DIFFERENT random URL — and this app will stop being able to
// reach the backend until this file is updated with the new URL and the
// APK is rebuilt (Build > Generate APKs in Android Studio).
//
// To check the current URL at any time, SSH into the VM and run:
//   pm2 logs jarvis-tunnel --lines 20 --nostream
//
// For a URL that never changes, see HTTPS_SETUP.md's Option A (real domain
// + Caddy) — worth doing once you're past prototyping, since every app
// restart on a bare Cloudflare Tunnel is a silent breakage risk otherwise.
//
// Nothing else in this app needs to change when the backend URL changes —
// every api() call in index.html reads API_BASE from here.
window.JARVIS_CONFIG = {
  API_BASE: 'https://loc-court-geographical-interface.trycloudflare.com',
};
