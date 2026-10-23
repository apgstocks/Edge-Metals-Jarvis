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
function withTimeout(promise, ms, fallback) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
    ]);
}

async function criticalAlert(subject, body) {
    console.error(`[NOTIFY] CRITICAL: ${subject} — ${body}`);
    try { _pushAlert({ type: 'critical', message: `${subject} — ${body}`, severity: 'high' }); } catch {}
    // Hard 8s cap — a hung SMTP/Twilio connection must never block a caller
    // that's awaiting this before doing something time-critical, like
    // exiting for a WhatsApp respawn. Better to give up on the alert than
    // leave the whole bot stuck because a mail server didn't respond.
    const [emailOk, smsOk] = await Promise.all([
        withTimeout(sendEmailAlert(subject, body).catch(() => false), 8000, false),
        withTimeout(sendSmsAlert(`${subject}: ${body}`).catch(() => false), 8000, false),
    ]);
    if (!emailOk && !smsOk) {
        console.error('[NOTIFY] Both email and SMS alerts failed, timed out, or are unconfigured — this failure is currently INVISIBLE outside server logs and the dashboard.');
    }
    return { emailOk, smsOk };
}

// ── MESSAGING ONE NAMED PERSON, ON BOTH CHANNELS ────────────────────────────
// Apsara, 2026-10-23: "send a message to accounts team of edge metals asking
// about payment sent status.They are forgetting to record the payment in
// jarvis", and on how: "Both in Jarvis and WHatsapp to the person who i give
// number in website."
//
// sendSmsAlert above cannot do this — it is hardwired to cfg.ALERT_SMS_TO,
// the ops alert number. This takes a recipient, which is the whole point:
// the person who records payments is not the person who gets woken up when
// a backup fails.
//
// ── WHATSAPP IS TWILIO WITH A PREFIX ────────────────────────────────────────
// Same account, same credentials, `whatsapp:` on both ends. No new
// dependency and no second set of secrets to look after.
//
// ── IT REFUSES RATHER THAN HALF-SENDING ─────────────────────────────────────
// With no contact configured it sends NOTHING and says so. A reminder about
// unrecorded money that quietly goes nowhere is worse than no reminder: she
// would believe it had been sent and stop chasing.
function waNumber(raw) {
    const digits = String(raw || '').replace(/[^0-9]/g, '');
    return digits ? 'whatsapp:+' + digits : '';
}

async function messageContact(contact, subject, body, { twilioLib = null, sendEmail = null } = {}) {
    const to = contact || {};
    const out = { whatsapp: false, email: false, skipped: [], errors: [] };

    const wa = waNumber(to.whatsapp);
    if (!wa) out.skipped.push('no WhatsApp number on file');
    else if (!cfg.TWILIO_SID || !cfg.TWILIO_AUTH_TOKEN || !cfg.TWILIO_FROM) {
        out.skipped.push('Twilio not configured on this host');
    } else {
        try {
            const twilio = twilioLib || require('twilio')(cfg.TWILIO_SID, cfg.TWILIO_AUTH_TOKEN);
            await twilio.messages.create({
                body: `${subject}\n\n${body}`.slice(0, 1600),
                from: waNumber(cfg.TWILIO_FROM) || cfg.TWILIO_FROM,
                to: wa,
            });
            out.whatsapp = true;
        } catch (e) { out.errors.push('whatsapp: ' + e.message); }
    }

    if (!String(to.email || '').trim()) out.skipped.push('no email address on file');
    else {
        try {
            const send = sendEmail || ((m) => require('./gmail').sendEmail(m));
            await send({ to: to.email, subject, text: body });
            out.email = true;
        } catch (e) { out.errors.push('email: ' + e.message); }
    }

    out.sent = out.whatsapp || out.email;
    return out;
}

// The accounts person from Settings. Separate from messageContact so the
// caller cannot accidentally message a contact she has not set.
async function messageAccounts(subject, body, opts = {}) {
    const { loadSettings } = require('./json');
    const who = (loadSettings() || {}).accounts_contact || {};
    if (!String(who.whatsapp || '').trim() && !String(who.email || '').trim()) {
        return { sent: false, whatsapp: false, email: false,
            skipped: ['no accounts contact set — Settings > Accounts contact'], errors: [] };
    }
    return messageContact(who, subject, body, opts);
}

module.exports = { init, sendEmailAlert, sendSmsAlert, criticalAlert, messageContact, messageAccounts, waNumber };