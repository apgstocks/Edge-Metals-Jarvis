// ── helpers/integritySweepJob.js — the sweep, in her inbox ────────────────
//
// Apsara, 2026-09-26: "Is it possible to run an agent everyday in website to
// find out any issue or discrepancy?" — email, and everything it notices.
//
// helpers/integritySweep.js finds. This sends. Split so the finding can be
// run and read without a mailbox, and so a change to the wording of an email
// cannot break a check.
//
// ── SILENT WHEN CLEAN ─────────────────────────────────────────────────────
// My call, and worth stating because "everything it notices" could be read as
// "mail every morning". A report that arrives daily saying "all fine" is one
// she stops opening inside a fortnight, and then the morning it says
// something she does not open that either. Nothing found, nothing sent — so
// an email from this job always means there is something to look at.
//
// SEND_ALWAYS=1 overrides it, for the first few days when she will want to
// see that it is actually running.

const cfg = require('../config');

function subjectFor(res) {
    if (res.clean) return 'Jarvis: nothing to report';
    const n = res.total;
    const worst = res.findings[0];
    return `Jarvis: ${n} thing${n === 1 ? '' : 's'} to look at — ${worst ? worst.title.toLowerCase() : 'see inside'}`;
}

async function run({ send = true, force = false } = {}) {
    const sweep = require('./integritySweep');
    const res = sweep.run();
    const text = sweep.reportText(res);

    if (!send) return { ...res, text, sent: false, why: 'send:false' };
    if (res.clean && !force && process.env.SWEEP_SEND_ALWAYS !== '1') {
        console.log('[SWEEP] clean — nothing sent');
        return { ...res, text, sent: false, why: 'clean' };
    }

    // ── WHERE IT GOES ────────────────────────────────────────────────────
    // Resolved the same way the log digest resolves it, never assumed:
    // ALERT_EMAIL_TO when configured, her own sending address otherwise.
    // helpers/gmail.js carries the note about the fortnight its comments
    // claimed one mailbox while all three tokens pointed at another.
    const gmail = require('./gmail');
    let to = cfg.ALERT_EMAIL_TO || '';
    if (!to) {
        try { to = await gmail.getMyEmailAddress(gmail.getGmailWrite()); } catch (e) { /* resolved below */ }
    }
    if (!to) {
        console.warn('[SWEEP] no destination (set ALERT_EMAIL_TO) — not sent');
        return { ...res, text, sent: false, why: 'no destination' };
    }

    const subject = subjectFor(res);
    // Monospace, for the same reason the log digest supplies its own HTML:
    // the default renders in Arial with pre-wrap, which is right for a letter
    // to a buyer and wrong for a list whose meaning is in its alignment.
    const bodyHtml = '<div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
                   + 'font-size:12px;line-height:1.45;white-space:pre;color:#202124;">'
                   + gmail.escapeHtmlText(text) + '</div>';

    try {
        await gmail.sendEmail({ to, subject, body: text, bodyHtml });
        console.log(`[SWEEP] ${subject} → ${to}`);
        return { ...res, text, sent: true, to };
    } catch (e) {
        // A failed report must not take the scheduler down, and must not be
        // silent either — that would make this job an instance of the exact
        // problem it exists to find.
        console.error('[SWEEP] could not send:', e.message);
        return { ...res, text, sent: false, why: e.message };
    }
}

module.exports = { run, subjectFor };
