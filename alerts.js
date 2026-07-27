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

// ── WA_SUPERVISOR_ALERTS_v1 ──────────────────────────────────────────────────
// Additional alert channels for PR 1 (WA supervisor + operational failures).
// Do not remove the marker line above.
//
// sendEmailAlert  : SMTP via nodemailer. Primary channel for WA-down events —
//                    only channel that can fire when WA itself is broken.
// sendWaSelfAlert : reuses the existing _sendToManager wire (already
//                    initialised by index.js in init()). CANNOT fire during
//                    a WA disconnect (WA is the failing channel); use only
//                    for non-WA failures (Gemini, Drive, brain crashes).
const nodemailer = require('nodemailer');

let _mailer = null;
function _getMailer() {
    if (_mailer) return _mailer;
    if (!process.env.SMTP_HOST) return null;
    _mailer = nodemailer.createTransport({
        host  : process.env.SMTP_HOST,
        port  : Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || 'false') === 'true',
        auth  : process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
    });
    return _mailer;
}

async function sendEmailAlert(subject, body) {
    const to = process.env.ALERT_EMAIL_TO;
    if (!to) { console.warn('[ALERTS] ALERT_EMAIL_TO not set — email skipped'); return false; }
    const m = _getMailer();
    if (!m)  { console.warn('[ALERTS] SMTP_HOST not set — email skipped'); return false; }
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'jarvis@edgemetals.local';
    try {
        await m.sendMail({ from, to, subject, text: body });
        console.log('[ALERTS] email sent →', to);
        return true;
    } catch (e) {
        console.error('[ALERTS] email send failed:', e.message);
        return false;
    }
}

async function sendWaSelfAlert(text) {
    try { return await _sendToManager('🚨 ' + text); }
    catch (e) { console.error('[ALERTS] WA self-alert failed:', e.message); return false; }
}

module.exports.sendEmailAlert  = sendEmailAlert;
module.exports.sendWaSelfAlert = sendWaSelfAlert;
