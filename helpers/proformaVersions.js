// ── helpers/proformaVersions.js — the form behind a saved proforma ──────────
//
// Apsara, 2026-09-17: "copy option so that itwill get coppied to proforma for
// say.." — and, asked what Copy should produce: "A new proforma, pre-filled".
//
// ── WHY THIS FILE HAD TO EXIST BEFORE COPY COULD ────────────────────────────
// The proforma route archived the PDF and recorded the pricing memory, and
// threw the form payload away. So "copy this proforma" had nothing to copy:
// the only trace of a generated proforma was a PDF, and reading fields back
// out of a rendered PDF is guesswork that fails silently on the one document
// that matters. This stores the payload that produced each file, the same way
// helpers/invoiceVersions.js does for the invoice screen.
//
// ── KEYED BY THE SAVED FILENAME ─────────────────────────────────────────────
// Not by invoice number, and not by customer. The filename is what the saved
// list shows, what /api/documents/download resolves, and what she clicks —
// so it is the only key that cannot disagree with the row she pressed Copy
// on. Two proformas for the same customer on the same day are two files and
// two entries; keyed by customer they would be one, and Copy would silently
// fetch the wrong one.
//
// ── IT ONLY KNOWS ABOUT WHAT IT HAS SEEN ────────────────────────────────────
// Every proforma generated before this shipped has a PDF and no payload.
// Copy is not offered for those, and the screen says why rather than
// presenting a button that does nothing. There is no backfill to write: the
// data was never captured, and inventing it from a filename would put a
// guessed customer and no items into a document she is about to send.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// Bounded, because this grows by one entry per proforma forever and it is a
// convenience store, not a ledger — the PDF archive is the record. Oldest
// entries are dropped first; losing the ability to copy a proforma from
// eighteen months ago costs nothing, and an unbounded JSON file that is read
// on every save eventually costs her a generate.
const MAX_ENTRIES = 300;

function keyFor(filename) {
    // basename, so a caller that passes a path cannot write an entry keyed on
    // something the saved list will never match.
    return String(filename || '').trim().split(/[\\/]/).pop();
}

function loadAll() {
    const raw = loadJson(cfg.PROFORMA_VERSIONS_FILE, {});
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

// Called after the PDF is archived, with the exact body that produced it.
//
// NON-FATAL BY CONTRACT. The caller wraps this, and it must stay that way:
// the proforma already exists and is already filed by the time this runs, and
// failing her generate to protect a convenience feature would be the tail
// wagging the dog. The same reasoning as the pricing-memory and sheet-log
// calls that sit beside it.
async function saveProformaPayload(filename, payload) {
    const key = keyFor(filename);
    if (!key || !payload || typeof payload !== 'object') return false;
    await mutateJson(cfg.PROFORMA_VERSIONS_FILE, {}, (raw) => {
        const all = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        all[key] = { ...payload, saved_at: new Date().toISOString() };
        const keys = Object.keys(all);
        if (keys.length > MAX_ENTRIES) {
            // Oldest first by saved_at, falling back to insertion order for
            // anything written before saved_at existed.
            keys.sort((a, b) => String(all[a].saved_at || '').localeCompare(String(all[b].saved_at || '')));
            for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[k];
        }
        return all;
    });
    return true;
}

// The payload behind one saved file, or null when it predates this store.
// Null is a normal answer, not an error — see the header.
function getProformaPayload(filename) {
    const key = keyFor(filename);
    if (!key) return null;
    const all = loadAll();
    const rec = all[key];
    return (rec && typeof rec === 'object') ? rec : null;
}

// Which of these filenames can be copied. One call for a whole list, so the
// saved-documents screen does not make one request per row to find out which
// buttons to draw.
function copyableSet(filenames) {
    const all = loadAll();
    const out = {};
    for (const f of (Array.isArray(filenames) ? filenames : [])) {
        out[keyFor(f)] = Object.prototype.hasOwnProperty.call(all, keyFor(f));
    }
    return out;
}

// Dropped when she deletes the document itself — a payload for a PDF that no
// longer exists is a Copy button on a row that is gone.
async function forgetProformaPayload(filename) {
    const key = keyFor(filename);
    if (!key) return false;
    let removed = false;
    await mutateJson(cfg.PROFORMA_VERSIONS_FILE, {}, (raw) => {
        const all = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        if (Object.prototype.hasOwnProperty.call(all, key)) { delete all[key]; removed = true; }
        return all;
    });
    return removed;
}

module.exports = {
    saveProformaPayload, getProformaPayload, copyableSet, forgetProformaPayload,
    keyFor, MAX_ENTRIES,
};
