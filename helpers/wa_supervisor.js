// ── helpers/wa_supervisor.js ──────────────────────────────────────────────────
// Marker: WA_SUPERVISOR_v1
//
// PURPOSE: alerting + crash-loop detection around the WhatsApp client.
// This module does NOT attempt in-process reconnect. That pattern is
// documented broken for whatsapp-web.js in this repo — see the comment in
// index.js's `disconnected` handler about Puppeteer session teardown. The
// reconnect strategy remains: exit(1), let pm2/systemd respawn a fresh
// process. What we add on top:
//   1. Persist every disconnect event to disk so crash-loop detection
//      survives the process restart (the loop itself is a chain of restarts).
//   2. Detect looping ("N disconnects in M minutes") and email an alert
//      BEFORE process.exit — so the operator gets one email per loop, not
//      silence followed by a dead bot.
//   3. On `ready` after a loop, email a recovery notice and reset counters.
//   4. `auth_failure` alerts fire from index.js directly (session invalid,
//      operator must rescan QR — no crash-loop context needed).
//
// State file: data/wa_supervisor_state.json (gitignored via data/).

const path = require('path');
const cfg  = require('../config');
const { mutateJson, loadJson } = require('./json');

const STATE_FILE = path.join(cfg.DATA_DIR, 'wa_supervisor_state.json');

// Env-driven config with defensive defaults.
const LOOP_WINDOW_MS  = Number(process.env.WA_SUPERVISOR_LOOP_WINDOW_MS  || 10 * 60 * 1000); // 10 min
const LOOP_THRESHOLD  = Number(process.env.WA_SUPERVISOR_LOOP_THRESHOLD  || 3);               // 3 disconnects in window
const ALERT_COOLDOWN_MS = Number(process.env.WA_SUPERVISOR_ALERT_COOLDOWN_MS || 10 * 60 * 1000); // 10 min between repeat alerts
const MAX_LOG_ENTRIES = 100;

function _defaultState() {
    return { disconnects: [], last_alert_at: null, last_recovery_at: null, in_loop: false };
}

// Called from index.js's `disconnected` handler BEFORE process.exit(1).
// Returns { looping, count }: `looping` = crash-loop threshold crossed inside window.
async function recordDisconnect(reason) {
    const now = Date.now();
    let looping = false;
    let count = 0;
    await mutateJson(STATE_FILE, _defaultState(), (s) => {
        // Trim first, then append — keeps file bounded even on runaway loops.
        s.disconnects = (s.disconnects || []).slice(-(MAX_LOG_ENTRIES - 1));
        s.disconnects.push({ at: new Date(now).toISOString(), reason: String(reason || 'unknown') });
        const cutoff = now - LOOP_WINDOW_MS;
        count = s.disconnects.filter(d => new Date(d.at).getTime() >= cutoff).length;
        if (count >= LOOP_THRESHOLD) { s.in_loop = true; looping = true; }
        return s;
    });
    return { looping, count };
}

// Called from index.js's `ready` handler. Returns { wasLooping } so caller
// can decide whether to send a recovery notice.
async function recordReady() {
    let wasLooping = false;
    await mutateJson(STATE_FILE, _defaultState(), (s) => {
        wasLooping = !!s.in_loop;
        s.in_loop = false;
        s.last_recovery_at = new Date().toISOString();
        return s;
    });
    return { wasLooping };
}

async function markAlertSent() {
    await mutateJson(STATE_FILE, _defaultState(), (s) => {
        s.last_alert_at = new Date().toISOString();
        return s;
    });
}

function getState() {
    return loadJson(STATE_FILE, _defaultState());
}

// Suppresses repeat alerts inside cooldown window. Prevents email spam when
// pm2 restarts us many times quickly and each restart tries to alert.
function shouldSendAlert() {
    const s = getState();
    if (!s.last_alert_at) return true;
    return (Date.now() - new Date(s.last_alert_at).getTime()) >= ALERT_COOLDOWN_MS;
}

module.exports = {
    recordDisconnect, recordReady, markAlertSent,
    getState, shouldSendAlert,
    LOOP_WINDOW_MS, LOOP_THRESHOLD, ALERT_COOLDOWN_MS,
};
