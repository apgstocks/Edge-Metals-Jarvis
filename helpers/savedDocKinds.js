// ── helpers/savedDocKinds.js — what each saved PDF actually is ─────────────
// Apsara, 2026-09-30: "why invoices coming in proforma tab?", then the rule
// — "proform ashould be in proforma,inv in invoice" — and then, on the old
// ones: "find a way to keep old invoice in inv tab only".
//
// ── THE PROBLEM THIS SOLVES, AND THE ONE IT DOES NOT ──────────────────────
// documents_saved/proforma/ is a FLAT folder and listSavedProformas() is a
// flat read of it, so the proforma tab shows whatever is in there. No code
// path files a commercial invoice into it — /api/proforma/generate and the
// voice path both render assets/proforma-dc2/template.html — so anything
// that is really an invoice got there some other way, before this code or
// beside it. Those are the "old invoices" she means, and they cannot be
// wished away by fixing a writer that was never wrong.
//
// ── WHY A CACHE, AND WHY IT IS FILLED ON PURPOSE ──────────────────────────
// Telling a proforma from an invoice honestly means reading the title
// PRINTED on the document — not the filename, which is an invoice number on
// both (helpers/nextInvoiceNo.js numbers proformas from her live invoice
// sheet), and not the folder, which is the thing in question. That means
// opening the PDF, which is far too slow to do on every page load and would
// turn one slow parse into a hung Documents tab.
//
// So the split is a LOOKUP here, and the reading is done once by
// scripts/documents-folder-audit.js --write-cache. Consequences, both
// deliberate:
//   · the tabs are instant and cannot time out;
//   · a file nobody has classified yet is NOT hidden. It stays where it is,
//     visible, with its Open and Delete working. Hiding a document because
//     a cache has not been warmed is the one outcome worse than showing it
//     under the wrong heading — she would go looking for a file that the
//     app had silently stopped listing.
//
// NOTHING HERE MOVES, RENAMES OR DELETES A FILE. Moving was the obvious
// fix and it is the wrong one: an invoice moved into invoice/ needs a DATE
// and a CONTAINER folder that a flat proforma filename does not carry, and
// helpers/proformaVersions.js keys a proforma's stored form on its filename,
// so renaming one breaks its Copy button. Filing stays as it is; only what
// each TAB shows changes.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// filename -> { kind, size, mtime, at }
// Keyed on the basename because that is what the saved lists and the
// download/delete routes pass around; size and mtime are carried so a file
// REPLACED under the same name is treated as unknown again rather than
// trusted on a stale verdict.
function loadKinds() {
    const raw = loadJson(cfg.SAVED_DOC_KINDS_FILE, {});
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

const KNOWN = new Set(['proforma', 'invoice', 'packing list', 'bill of lading']);

function keyFor(filename) {
    return String(filename || '').trim().split(/[\\/]/).pop();
}

// Returns 'proforma' | 'invoice' | 'packing list' | 'bill of lading' | null.
// null means "nobody has looked at this one", which callers must treat as
// "leave it where it is" — never as a kind.
function kindOf(filename, { kinds = null, stat = null } = {}) {
    const all = kinds || loadKinds();
    const rec = all[keyFor(filename)];
    if (!rec || !KNOWN.has(rec.kind)) return null;
    // A file swapped out under the same name invalidates the verdict. Only
    // checked when the caller supplies the stat it already has — this must
    // not turn a cheap lookup into a stat() per row.
    if (stat && rec.size != null && Number(rec.size) !== Number(stat.size)) return null;
    return rec.kind;
}

async function record(entries) {
    const rows = Array.isArray(entries) ? entries : [entries];
    const now = new Date().toISOString();
    return mutateJson(cfg.SAVED_DOC_KINDS_FILE, {}, (all) => {
        const map = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
        for (const e of rows) {
            if (!e || !e.filename || !KNOWN.has(e.kind)) continue;
            map[keyFor(e.filename)] = {
                kind: e.kind,
                size: e.size == null ? null : Number(e.size),
                mtime: e.mtime || null,
                at: now,
            };
        }
        return map;
    }, { strict: true });
}

module.exports = { loadKinds, kindOf, record, keyFor, KNOWN };
