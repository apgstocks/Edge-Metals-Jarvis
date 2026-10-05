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
    if (res.outage) return 'Jarvis: NOBODY CAN REACH JARVIS';
    if (res.oldLinksDead) return 'Jarvis: the old address is dead again — people holding it cannot get in';
    return 'Jarvis: an address is not working';
}

function bodyFor(res) {
    const E = require('./entrances');
    return [E.report(res), '', 'Run `node scripts/check-entrances.js` on the VM to see this again.'].join('\n');
}

async function run({ fetchImpl, sendEmail, to, sendAlways = process.env.SEND_ALWAYS === '1' } = {}) {
    const E = require('./entrances');
    const res = await E.checkAll({ fetchImpl });
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
