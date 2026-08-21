// ── helpers/invoiceVersions.js — Review & Generate edit-state history ──────
// Added per Apsara's "Load previous edits" mockup: every real (non-preview)
// Generate & Download on the Commercial Invoice screen saves the full form
// payload that produced it, keyed by container #. Reopening the review
// screen for that same container later can then show "You last generated
// this on [date] — N versions saved" and offer to reload those exact edits
// instead of starting from the raw sheet data again.
//
// Deliberately separate from helpers/documentsSaved.js, which archives the
// finished PDF FILE — this stores the FORM STATE (every editable field) so
// it can be poured back into the review screen's inputs, which a PDF
// obviously can't be.
//
// Storage shape: { [containerNo]: [{ ...payload, saved_at }, ...] }, newest
// last. Capped at the last 10 versions per container — this is a UI
// convenience for catching a recent re-edit, not a full audit trail (see
// documentsSaved.js's dated PDF archive for that).

const cfg = require('../config');
const { mutateJson, loadJson } = require('./json');

const MAX_VERSIONS_PER_CONTAINER = 10;

function keyFor(containerNo) {
    return String(containerNo || '').trim().toUpperCase();
}

async function saveInvoiceVersion(containerNo, payload) {
    const key = keyFor(containerNo);
    if (!key) return; // no container assigned yet — nothing to key this history off of
    await mutateJson(cfg.INVOICE_VERSIONS_FILE, {}, (all) => {
        if (!Array.isArray(all[key])) all[key] = [];
        all[key].push({ ...payload, saved_at: new Date().toISOString() });
        if (all[key].length > MAX_VERSIONS_PER_CONTAINER) {
            all[key] = all[key].slice(-MAX_VERSIONS_PER_CONTAINER);
        }
        return all;
    });
}

// Returns { count, latest, saved_at } — latest is the full payload of the
// most recent version (or null if this container has never been generated
// before), saved_at is that version's own timestamp separated out for easy
// display without the caller needing to reach into the payload.
function getInvoiceVersionSummary(containerNo) {
    const key = keyFor(containerNo);
    if (!key) return { count: 0, latest: null, saved_at: null };
    const all = loadJson(cfg.INVOICE_VERSIONS_FILE, {});
    const versions = Array.isArray(all[key]) ? all[key] : [];
    if (!versions.length) return { count: 0, latest: null, saved_at: null };
    const last = versions[versions.length - 1];
    const { saved_at, ...latest } = last;
    return { count: versions.length, latest, saved_at };
}

module.exports = { saveInvoiceVersion, getInvoiceVersionSummary };
