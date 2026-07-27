// ── helpers/notify.js — Critical-failure alerting (email + SMS) ─────────────
// For when WhatsApp or Gemini itself is down — the two channels Jarvis
// normally uses to tell anyone anything. Both email and SMS are optional
// independently; each is silently skipped (not an error) if its config
// isn't set, so this works incrementally as credentials get added.

const cfg = require('../config');

let _pushAlert = () => {};
function init({ pushAlert } = {}) {
    if (pushAlert) _pushAlert = pushAlert;
}

async function sendEmailAlert(subject, body) {
    if (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS || !cfg.ALERT_EMAIL_TO) {
        console.warn('[NOTIFY] Email alert skipped — SMTP not fully configured');
        return false;
    }
    try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
            host: cfg.SMTP_HOST,
            port: cfg.SMTP_PORT,
            secure: cfg.SMTP_PORT === 465,
            auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
        });
        await transporter.sendMail({
            from: cfg.SMTP_USER,
            to: cfg.ALERT_EMAIL_TO,
            subject: `[Jarvis Alert] ${subject}`,
            text: body,
        });
        return true;
    } catch (e) {
        console.error('[NOTIFY] Email alert failed:', e.message);
        return false;
    }
}

async function sendSmsAlert(body) {
    if (!cfg.TWILIO_SID || !cfg.TWILIO_AUTH_TOKEN || !cfg.TWILIO_FROM || !cfg.ALERT_SMS_TO) {
        console.warn('[NOTIFY] SMS alert skipped — Twilio not fully configured');
        return false;
    }
    try {
        const twilio = require('twilio')(cfg.TWILIO_SID, cfg.TWILIO_AUTH_TOKEN);
        await twilio.messages.create({
            body: `[Jarvis] ${body}`.slice(0, 1600), // SMS length safety margin
            from: cfg.TWILIO_FROM,
            to: cfg.ALERT_SMS_TO,
        });
        return true;
    } catch (e) {
        console.error('[NOTIFY] SMS alert failed:', e.message);
        return false;
    }
}

// Fires both channels in parallel, never throws — a failed alert should
// never crash whatever critical-failure handler is calling this.
async function criticalAlert(subject, body) {
    console.error(`[NOTIFY] CRITICAL: ${subject} — ${body}`);
    try { _pushAlert({ type: 'critical', message: `${subject} — ${body}`, severity: 'high' }); } catch {}
    const [emailOk, smsOk] = await Promise.all([
        sendEmailAlert(subject, body).catch(() => false),
        sendSmsAlert(`${subject}: ${body}`).catch(() => false),
    ]);
    if (!emailOk && !smsOk) {
        console.error('[NOTIFY] Both email and SMS alerts failed or are unconfigured — this failure is currently INVISIBLE outside server logs and the dashboard.');
    }
    return { emailOk, smsOk };
}

module.exports = { init, sendEmailAlert, sendSmsAlert, criticalAlert };