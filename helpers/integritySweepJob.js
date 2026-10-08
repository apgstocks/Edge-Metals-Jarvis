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
    // A ledger finding still names the subject when there is one, because
    // that is what she acts on the same morning. A dependency finding alone
    // gets its own subject rather than the misleading "0 things to look at".
    if (!n) return 'Jarvis: a dependency needs attention';
    return `Jarvis: ${n} thing${n === 1 ? '' : 's'} to look at — ${worst ? worst.title.toLowerCase() : 'see inside'}`;
}

// ── THE DEPENDENCY SECTION ───────────────────────────────────────────────
// Apsara, 2026-10-08, attested to Plaid that Edge Metals "monitors
// end-of-life (EOL) software in use" and "patches identified
// vulnerabilities within a defined SLA". Neither had anything behind it:
// no dependency scanning anywhere, and the only GitHub workflow is
// path-filtered to the iOS build. This is what makes the first one true and
// gives the second something to measure against.
//
// ── IT RIDES THIS JOB AND NOT integritySweep.js, DELIBERATELY ───────────
// integritySweep.run() is SYNCHRONOUS and calls every check synchronously
// (integritySweep.js:329-331). `npm audit` is a subprocess, so putting it in
// CHECKS would mean making that function async — and every caller of a
// shared function would have to be found and changed to await it, for one
// new check. This job is already async because it sends mail, so the audit
// is awaited here and appended to the report. integritySweep.js is untouched.
//
// SILENT WHEN CLEAN, the same rule as the rest of this job: a dependency
// section that says "nothing" every morning is one she stops reading.
async function depSection({ auditImpl } = {}) {
    // ── OFF UNDER JARVIS_TEST UNLESS A STUB IS HANDED IN ─────────────────
    // The same doctrine helpers/drive.js uses, and for the same reason. The
    // real check shells out to `npm audit`, which wants the registry — so
    // without this guard every existing test that calls this job would make
    // a network request, and tests/integrity-sweep.js's "nothing is sent
    // when clean" went red the moment the section was added, because
    // pdf-parse genuinely is unmaintained and the job correctly stopped
    // being silent.
    //
    // That red was right about the code and wrong about the test's subject:
    // that test is about the LEDGER sweep's silence, not about
    // dependencies. So the dependency section is opt-in under test, and
    // tests/dep-audit.js opts in with a stub on every call.
    if (process.env.JARVIS_TEST === '1' && !auditImpl) return { lines: [], findings: 0, dep: null };
    let dep = null;
    try { dep = await require('./depAudit').run(auditImpl ? { auditImpl } : {}); }
    catch (e) {
        // A broken check reports itself. Silence here would mean the
        // attestation is backed by a thing that stopped working.
        return { lines: ['', 'DEPENDENCIES', '  the dependency check did not run: ' + String(e.message || e).slice(0, 200)],
            findings: 1, dep: null };
    }
    if (!dep.findings.length) return { lines: [], findings: 0, dep };
    const lines = ['', 'DEPENDENCIES AND END-OF-LIFE SOFTWARE'];
    for (const f of dep.findings) {
        lines.push(`  [${f.severity}] ${f.what}`);
        lines.push(`      ${f.why}`);
        lines.push(`      → ${f.action}`);
    }
    lines.push(`  (Node ${dep.node.version}${dep.node.eol ? `, supported until ${dep.node.eol}` : ''}`
        + `; ${dep.packages == null ? 'package count unknown' : dep.packages + ' packages installed'})`);
    return { lines, findings: dep.findings.length, dep };
}

async function run({ send = true, force = false, auditImpl = null } = {}) {
    const sweep = require('./integritySweep');
    const res = sweep.run();
    const deps = await depSection(auditImpl ? { auditImpl } : {});
    const text = sweep.reportText(res) + (deps.lines.length ? '\n' + deps.lines.join('\n') + '\n' : '');

    // A dependency finding is a reason to send even when the ledger agrees
    // with itself. Recomputed rather than mutating res, so the sweep's own
    // notion of clean is still reported unchanged to any caller reading it.
    res.clean = res.clean && deps.findings === 0;
    res.dependencies = deps.dep;

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
