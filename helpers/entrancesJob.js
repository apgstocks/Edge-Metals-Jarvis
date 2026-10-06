// ── helpers/entrancesJob.js — the front door, in her inbox ────────────────
//
// helpers/entrances.js checks. This sends. Split for the same reason
// integritySweepJob is split from integritySweep: the checking can be run and
// read without a mailbox, and rewording an email cannot break a check.
//
// SILENT WHEN EVERY ADDRESS BEHAVES. The exception is the whole point: an
// unreachable front door is the one failure where she cannot find out from
// Jarvis, because Jarvis is the thing that is unreachable. So this mail is
// the only one in the system that must still arrive when everything else
// cannot be seen.
const cfg = require('../config');

function subjectFor(res) {
    // ── A NAMED OUTAGE BEATS A GENERIC ONE ───────────────────────────────
    // An expired certificate IS an outage, so this used to come out as
    // "NOBODY CAN REACH JARVIS" — true, and useless. That subject sends her
    // looking at the server, the firewall and the load balancer, when the
    // cause has a name, a date and a one-line fix. The generic shout is for
    // when we genuinely do not know why.
    if (res.certificate && res.certificate.expired) return 'Jarvis: THE HTTPS CERTIFICATE HAS EXPIRED — nobody can reach Jarvis';
    if (res.outage) return 'Jarvis: NOBODY CAN REACH JARVIS';
    if (res.oldLinksDead) return 'Jarvis: the old address is dead again — people holding it cannot get in';
    // ── A DEADLINE IS NOT A BREAKAGE ─────────────────────────────────────
    // Added 2026-10-06. The certificate on the Google load balancer is a
    // hand-uploaded copy of Caddy's and does not renew; it runs out
    // 2026-12-04. Nothing is wrong on the day this first sends, and a
    // subject saying "an address is not working" would be read as a false
    // alarm and then ignored for the four weeks that actually matter.
    // The number of days is IN the subject, because the whole value of this
    // mail is that it arrives before rather than after.
    if (res.certificateExpiring) {
        const d = res.certificate && res.certificate.days;
        return `Jarvis: the HTTPS certificate expires in ${typeof d === 'number' ? d : '?'} days`;
    }
    return 'Jarvis: an address is not working';
}

function bodyFor(res) {
    const E = require('./entrances');
    return [E.report(res), '', 'Run `node scripts/check-entrances.js` on the VM to see this again.'].join('\n');
}

async function run({ fetchImpl, tlsImpl, sendEmail, to, sendAlways = process.env.SEND_ALWAYS === '1' } = {}) {
    const E = require('./entrances');
    // ── THE TLS CONNECTION IS INJECTED HERE, NOT DEFAULTED THERE ─────────
    // helpers/entrances.js reaches no network of its own, so the certificate
    // expiry check does nothing unless something hands it a way to connect.
    // This is that something. A test passes its own stub and never opens a
    // socket; if this line is ever removed the check goes quiet rather than
    // wrong, and tests/entrances.js asserts it is here for that reason.
    const tls = tlsImpl || (() => {
        try { return require('tls').connect; } catch (e) { return null; }
    })();
    const res = await E.checkAll({ fetchImpl, tlsImpl: tls });
    if (res.ok && !sendAlways) return { ...res, sent: false, reason: 'every address behaves' };

    const send = sendEmail || (async (m) => require('./gmail').sendEmail(m));
    // cfg.ALERT_EMAIL_TO — config.js:676 records a job that fell back to a
    // cfg.ALERT_EMAIL which does not exist and therefore sent nothing, for
    // ever, without erroring.
    const target = to || cfg.ALERT_EMAIL_TO || null;
    if (!target) return { ...res, sent: false, reason: 'no address to send to — set ALERT_EMAIL_TO' };
    try {
        await send({ to: target, subject: subjectFor(res), body: bodyFor(res) });
        return { ...res, sent: true };
    } catch (e) {
        console.error('[ENTRANCES] could not send:', e && e.message);
        return { ...res, sent: false, reason: e && e.message };
    }
}

module.exports = { run, subjectFor, bodyFor };
