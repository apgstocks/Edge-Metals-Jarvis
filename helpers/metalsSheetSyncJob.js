// ── helpers/sheetSyncJob.js — the 11pm run, and the email it sends ────────
//
// Apsara, 2026-09-24: "at everyday night,a bot should run which need to update
// my bills and invoices in website from live sheet..if anything is missing,
// enter that as well", with "1 with discrepancy should be notified via email
// report" and "Dry run first — report only, write nothing".
//
// helpers/sheetSync.js decides WHAT would happen and cannot write. This file
// is the part with side effects: it fetches, it emails, and one day it will
// commit. Split that way on purpose — the decision stays testable without a
// network, a mailbox or a live ledger, and the risky half is small enough to
// read in one sitting.
//
// ── WRITING TAKES TWO KEYS, AND NEITHER IS THE DEFAULT ─────────────────────
// A live run needs opts.write === true AND SHEET_SYNC_WRITE=1 in the
// environment. She asked to see a report first; a flag that defaults to
// "write" is one typo away from a night nobody asked for, and this job runs
// while she is asleep.
//
// Until she turns it on, every night is a dry run: read, compare, email, stop.

const sync = require('./metalsSheetSync');

const enabled = () => String(process.env.SHEET_SYNC_WRITE || '').trim() === '1';

// ── THE REPORT ─────────────────────────────────────────────────────────────
// Plain text, because she reads it on a phone at 6am. The summary line first
// so the common case — nothing happened — is answered without scrolling.
function reportText(report, { dryRun, committed }) {
    const L = [];
    L.push(sync.summarise(report));
    L.push('');
    L.push(dryRun
        ? 'DRY RUN — nothing was written. This is what it would have added.'
        : `Written as batch ${committed && committed.batchId ? committed.batchId : '(none)'} — undo it from the Import screen if it looks wrong.`);

    if (report.newBills.length) {
        L.push('', `NEW BILLS (${report.newBills.length})`);
        for (const b of report.newBills.slice(0, 40)) {
            L.push(`  ${b.date || '—'}  ${b.container_no || '—'}  ${b.supplier || '—'}  ${b.description || ''}`);
        }
        if (report.newBills.length > 40) L.push(`  … ${report.newBills.length - 40} more`);
    }
    if (report.newSales.length) {
        L.push('', `NEW INVOICES (${report.newSales.length})`);
        for (const s of report.newSales.slice(0, 40)) {
            L.push(`  ${s.date || '—'}  ${s.invoice_no || '—'}  ${s.container_no || '—'}  ${s.customer || ''}`);
        }
        if (report.newSales.length > 40) L.push(`  … ${report.newSales.length - 40} more`);
    }

    // ── THE DISAGREEMENTS, WHICH ARE THE POINT ─────────────────────────────
    // Nothing here was changed. Both sides are printed so she can see which
    // is right without opening either system.
    const changed = [...report.changedBills, ...report.changedSales];
    if (changed.length) {
        L.push('', `DISAGREEMENTS (${changed.length}) — NOT changed, for you to settle`);
        for (const c of changed.slice(0, 30)) {
            const who = c.invoice_no ? `${c.invoice_no} / ${c.container_no || '—'}` : (c.container_no || c.key);
            L.push(`  ${who}`);
            for (const d of c.differences) {
                L.push(`      ${d.field}: sheet "${d.sheet}"  vs  Jarvis "${d.jarvis}"`);
            }
        }
        if (changed.length > 30) L.push(`  … ${changed.length - 30} more`);
    }

    if (report.unkeyed.length) {
        L.push('', `UNREADABLE (${report.unkeyed.length}) — no booking and no container, so they cannot be matched`);
        L.push('  These are skipped every night rather than added every night.');
    }
    return L.join('\n');
}

// ── THE RUN ────────────────────────────────────────────────────────────────
// Returns the report and what it did, and never throws at the caller: a cron
// job that throws at 11pm is a silent failure until someone reads the logs.
async function runNightly(opts = {}) {
    const dryRun = !(opts.write === true && enabled());
    const out = { ok: false, dryRun, report: null, committed: null, error: null };
    try {
        const buffer = opts.buffer || await sync.fetchWorkbook(opts.sheetId);
        const parsed = await require('./sheetImport').readWorkbook(buffer);

        const bills = require('./bills').list();
        const sales = require('./sales').list();
        const report = sync.diff({
            sheetBills: parsed.bills || [], sheetSales: parsed.sales || [], bills, sales,
        });
        out.report = report;

        if (!dryRun && (report.newBills.length || report.newSales.length)) {
            // Through the SAME commit the Upload screen uses, so the night's
            // work is a batch with an id and an undo — not a scatter of rows
            // that have to be found again one by one.
            const siw = require('./sheetImportWrite');
            out.committed = await siw.commit(
                { bills: report.newBills, sales: report.newSales },
                { source: `nightly-sheet-sync ${new Date().toISOString().slice(0, 10)}`, force: true });
        }
        out.ok = true;
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

// Sent to her, once, whatever happened — including the failures. A night the
// job could not run is a night her ledgers did not get the new rows, and
// silence would read as "nothing to add".
async function emailReport(result, opts = {}) {
    const to = opts.to || process.env.SHEET_SYNC_TO || 'apg0596@gmail.com';
    const when = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
    const subject = result.error
        ? `Sheet sync FAILED — ${when}`
        : `Sheet sync ${result.dryRun ? '(dry run)' : ''} — ${sync.summarise(result.report)} ${when}`;
    const body = result.error
        ? `The nightly sheet sync could not run.\n\n${result.error}\n\nNothing was written.`
        : reportText(result.report, result);
    const gmail = require('./gmail');
    return gmail.sendEmail({ to, subject, body });
}

module.exports = { runNightly, emailReport, reportText, enabled };
