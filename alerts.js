// ── alerts.js — Alert log + manager escalation + snooze/mute ─────────────────
// Every operational event lands here. History feeds the dashboard's
// "Needs Attention" rail. High-severity alerts ping the manager unless
// snoozed (per alert type+booking, timed) or muted (per booking, indefinite).

const { loadAlertsState, saveAlertsState, mutateJson } = require('./helpers/json');
const cfg = require('./config');

let _sendToManager = async () => {};
function init({ sendToManager }) { _sendToManager = sendToManager; }

function suppressKey(type, bkgNo) { return `${type}:${bkgNo || 'global'}`; }

function isAlertSuppressed(type, bkgNo) {
    const s = loadAlertsState();
    if (bkgNo && s.muted[bkgNo]) return true;
    const until = s.snoozed[suppressKey(type, bkgNo)];
    return !!until && new Date(until).getTime() > Date.now();
}

// pushAlert({ type, bkgNo, message, severity: 'info'|'warning'|'high' })
async function pushAlert(alert) {
    const entry = { ...alert, at: new Date().toISOString() };
    await mutateJson(cfg.ALERTS_FILE, { snoozed: {}, muted: {}, history: [] }, (s) => {
        s.history = s.history || [];
        s.history.push(entry);
        if (s.history.length > 200) s.history = s.history.slice(-200);
        return s;
    });

    if (alert.severity === 'high' && !isAlertSuppressed(alert.type, alert.bkgNo)) {
        try { await _sendToManager(`ALERT: ${alert.message}`); }
        catch (e) { console.error('[ALERTS] Manager notify failed:', e.message); }
    }
    console.log(`[ALERT:${alert.severity}] ${alert.message}`);
    return entry;
}

async function snoozeAlert(type, bkgNo, hours = 4) {
    await mutateJson(cfg.ALERTS_FILE, { snoozed: {}, muted: {}, history: [] }, (s) => {
        s.snoozed[suppressKey(type, bkgNo)] = new Date(Date.now() + hours * 3600000).toISOString();
        return s;
    });
}

async function muteBooking(bkgNo, on = true) {
    await mutateJson(cfg.ALERTS_FILE, { snoozed: {}, muted: {}, history: [] }, (s) => {
        if (on) s.muted[bkgNo] = new Date().toISOString();
        else    delete s.muted[bkgNo];
        return s;
    });
}

function listAlerts(n = 50) {
    return (loadAlertsState().history || []).slice(-n).reverse();
}

module.exports = { init, pushAlert, isAlertSuppressed, snoozeAlert, muteBooking, listAlerts };
