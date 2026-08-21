// ── helpers/loadWarnings.js — make silent failures visible ──────────────────
// Per Apsara 2026-08-20, after an evening spent asking why scale photos
// weren't appearing on an invoice.
//
// THE PROBLEM this exists to fix: this codebase has ~250 console.error /
// console.warn calls, and almost none of them reach a human. Photo uploads,
// Drive writes, PDF generation and the Sheets sync are all deliberately
// "best-effort" — a failure is logged and swallowed so that saving a load
// never hard-fails. That decision is right, but the half that was missing is
// telling anyone afterwards. The load saves, the app says success, and the
// missing evidence is discovered days later, if at all. A yard operator is
// never going to read pm2 logs.
//
// So: failures are still non-fatal, but they are now RECORDED ON THE LOAD
// and surfaced in both UIs as a warning badge. The operator finds out while
// they're still standing at the scale and can retake the photo, instead of
// finding out when a buyer disputes a weight.
//
// Deliberately stored on the load record rather than a separate log: the
// warning is only meaningful next to the load it concerns, it needs to
// survive a restart, and it must appear for whoever opens that load next —
// not just the person whose screen was open when it happened.

const { mutateJson } = require('./json');
const cfg = require('../config');

// A warning is { code, message, at }. `code` is machine-readable so the UI
// can decide severity/wording; `message` is what a yard operator actually
// reads, so it says what to DO, not what threw.
const MESSAGES = {
    photo_upload_failed : 'A scale photo could not be saved to Drive. The weight is recorded, but there is no photo backing it — retake the photo if you need the evidence.',
    pdf_upload_failed   : 'The PDF could not be saved to Drive. Use Regenerate PDF once the connection is back.',
    pdf_generate_failed : 'The PDF could not be generated. Use Regenerate PDF to try again.',
    weights_pdf_failed  : 'The weights PDF could not be generated. The main ticket is unaffected.',
    receipt_pdf_failed  : 'The POS receipt could not be generated. The main ticket is unaffected.',
    sheet_sync_failed   : 'This load is saved, but the Google Sheet could not be updated. It will retry on the next change.',
    drive_cleanup_failed: 'Drive files for this load could not be removed.',
};

function buildWarning(code, detail) {
    return {
        code,
        message: MESSAGES[code] || code,
        // The raw error is kept for whoever debugs it later, but is NOT what
        // the operator is shown — "ENOTFOUND www.googleapis.com" helps nobody
        // at a weighbridge.
        detail: detail ? String(detail).slice(0, 300) : null,
        at: new Date().toISOString(),
    };
}

// Attach warnings to a load. Replaces any existing warnings with the SAME
// code rather than appending, so retrying a save doesn't accumulate five
// copies of the same complaint — the newest state of each problem wins.
async function setLoadWarnings(loadId, warnings) {
    if (!loadId) return null;
    const list = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
    let updated = null;
    await mutateJson(cfg.LOADS_FILE, [], (loads) => {
        const l = loads.find(x => x.id === loadId);
        if (!l) return loads;
        const codes = new Set(list.map(w => w.code));
        const kept = (l.warnings || []).filter(w => !codes.has(w.code));
        l.warnings = [...kept, ...list];
        if (!l.warnings.length) delete l.warnings;
        updated = l;
        return loads;
    });
    return updated;
}

// Clear specific codes (e.g. a successful Regenerate PDF clears the PDF
// warnings) — without this a load would wear a warning badge forever even
// after the problem was fixed, which trains people to ignore the badge.
async function clearLoadWarnings(loadId, codes) {
    if (!loadId) return null;
    const drop = new Set(Array.isArray(codes) ? codes : [codes]);
    let updated = null;
    await mutateJson(cfg.LOADS_FILE, [], (loads) => {
        const l = loads.find(x => x.id === loadId);
        if (!l || !l.warnings) return loads;
        l.warnings = l.warnings.filter(w => !drop.has(w.code));
        if (!l.warnings.length) delete l.warnings;
        updated = l;
        return loads;
    });
    return updated;
}

module.exports = { buildWarning, setLoadWarnings, clearLoadWarnings, MESSAGES };
