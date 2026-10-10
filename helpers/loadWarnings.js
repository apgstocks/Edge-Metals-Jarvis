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
    // Split out 2026-10-10: these two shared one message, and the one she
    // was shown blamed the renderer for what was almost certainly Drive.
    // "Generate PDF again" is the right instruction for a connection
    // problem and the wrong one for a render problem, which is why they
    // cannot keep sharing a sentence.
    receipt_upload_failed: 'The POS receipt was made but could not be saved to Drive. Use Generate PDF again once the connection is back — the main ticket is unaffected.',
    sheet_sync_failed   : 'This load is saved, but the Google Sheet could not be updated. It will retry on the next change.',
    drive_cleanup_failed: 'Drive files for this load could not be removed.',
};

// ── describeError — because .message is EMPTY for the likeliest failure ──
//
// Apsara, 2026-10-10, on EDGE_130: "I dont even have any idea what caused
// this error." Neither did anyone, and this function is why. The warning she
// was looking at read:
//
//     "code": "receipt_pdf_failed",
//     "detail": null,
//     "at": "2026-10-09T00:00:36.217Z"
//
// `detail: null` because callers passed `e.message`, and the error class most
// likely to arrive here has none. When Node connects to a host that resolves
// to several addresses and every attempt fails, it does NOT throw an Error —
// it throws an AggregateError whose `.message` is the empty string and whose
// real content is in `.errors`. Every Drive call in this app goes through
// exactly that path. So the one failure that was always going to happen is
// the one that recorded nothing.
//
// What this keeps, in order of usefulness: the code (ENOTFOUND, ETIMEDOUT —
// the thing that actually names the fault), the message, the class, and for
// an AggregateError the nested messages, which is the only place the cause is
// written down at all. Still truncated, still never shown to a yard operator.
function describeError(e) {
    if (e === null || e === undefined) return null;
    if (typeof e === 'string') return e || null;

    const bits = [];
    if (e.code) bits.push(String(e.code));
    if (e.message) bits.push(String(e.message));
    // The class only earns a place when it is the only thing distinguishing
    // this from a blank record — "Error:" in front of a message is noise.
    if (!bits.length && e.name) bits.push(String(e.name));
    if (Array.isArray(e.errors) && e.errors.length) {
        const inner = e.errors.slice(0, 4)
            .map(x => (x && (x.message || x.code)) || String(x)).filter(Boolean);
        if (inner.length) bits.push(`[${e.name || 'AggregateError'}: ${inner.join('; ')}]`);
    }
    // A Drive/googleapis rejection carries its HTTP status somewhere else
    // entirely, and "403" vs "500" is the difference between a permissions
    // problem and waiting five minutes.
    const status = e.status || e.code === undefined && e.response && e.response.status;
    if (status && !bits.includes(String(status))) bits.push(`status ${status}`);

    const out = bits.join(' ').trim();
    // Last resort rather than first: String(someAggregateError) is the word
    // "AggregateError" and nothing else, which is how we got here.
    return out || (String(e) !== '[object Object]' ? String(e) : null) || null;
}

// `detail` may be an Error or a string: every caller before 2026-10-10 passed
// `e.message`, which still works, and the ones that matter now pass `e` so
// describeError can get at what .message threw away.
function buildWarning(code, detail) {
    return {
        code,
        message: MESSAGES[code] || code,
        // The raw error is kept for whoever debugs it later, but is NOT what
        // the operator is shown — "ENOTFOUND www.googleapis.com" helps nobody
        // at a weighbridge.
        detail: (() => { const d = describeError(detail); return d ? d.slice(0, 300) : null; })(),
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

module.exports = { buildWarning, describeError, setLoadWarnings, clearLoadWarnings, MESSAGES };
