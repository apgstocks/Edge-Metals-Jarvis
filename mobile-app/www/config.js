// ── Jarvis Loads app — API base URL ─────────────────────────────────────
// EDIT THIS FILE once the Jarvis backend is actually deployed and reachable
// from a phone (see the standing "Deploy weight-reading + dashboard changes
// to VM" task — as of this build that deploy is still blocked, so this is a
// placeholder, not a real address).
//
// Whatever you put here must be:
//   - Reachable from the phone the app runs on (a public HTTPS URL for a
//     real device; 10.0.2.2 is a special alias the Android EMULATOR uses
//     to reach "localhost" on the machine running the emulator — it will
//     NOT work on a real phone or on iOS).
//   - HTTPS in production. Capacitor apps CAN talk to plain HTTP for local
//     dev, but Android/iOS both restrict cleartext HTTP by default in
//     release builds — don't ship this pointed at an http:// URL.
//
// Nothing else in this app needs to change when the backend URL changes —
// every api() call in index.html reads API_BASE from here.
window.JARVIS_CONFIG = {
  API_BASE: 'http://10.0.2.2:4000', // ← placeholder, see above
};
