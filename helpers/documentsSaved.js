// ── helpers/documentsSaved.js — Save-a-copy archive for generated PDFs ────────
// Added 2026-08-19, ported from the Flask app's doc_storage.py (already
// built and tested there). Distinct from anything already in this repo:
// this saves the actual generated PDF FILE for a browsable archive, not
// form/JSON state.
//
// Folder layout (under cfg.DOCUMENTS_SAVED_DIR):
//   invoice/<YYYY-MM-DD>/<CONTAINER_NO>/<filename>.pdf
//   proforma/<filename>.pdf
//
// Invoice is always nested by container, even for a single file that day —
// a conditional layout (flat until a second file shows up) would put the
// same container's file in different places depending on what else ran
// that day. Proforma is flat: proformas aren't tied to a single container
// the way an invoice is (some don't have a container assigned yet), so
// there's nothing sensible to nest by.

const fs   = require('fs');
const path = require('path');
const cfg  = require('../config');

function safeName(name) {
    return String(name || 'UNKNOWN').trim().toUpperCase().replace(/[^A-Z0-9_\-]/g, '_');
}

// date accepted as 'YYYY-MM-DD' or omitted (defaults to today).
function saveInvoiceCopy(buffer, filename, containerNo, dateStr) {
    const date = dateStr || new Date().toISOString().slice(0, 10);
    const destDir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice', date, safeName(containerNo));
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(filename));
    fs.writeFileSync(destPath, buffer);
    return destPath;
}

function saveProformaCopy(buffer, filename) {
    const destDir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'proforma');
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(filename));
    fs.writeFileSync(destPath, buffer);
    return destPath;
}

function listSavedInvoices() {
    const root = path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice');
    if (!fs.existsSync(root)) return [];
    const out = [];
    const dateFolders = fs.readdirSync(root).sort().reverse();
    for (const dateFolder of dateFolders) {
        const datePath = path.join(root, dateFolder);
        if (!fs.statSync(datePath).isDirectory()) continue;
        for (const containerFolder of fs.readdirSync(datePath).sort()) {
            const cPath = path.join(datePath, containerFolder);
            if (!fs.statSync(cPath).isDirectory()) continue;
            const files = fs.readdirSync(cPath).filter((f) => f.toLowerCase().endsWith('.pdf'));
            if (files.length) out.push({ date: dateFolder, container: containerFolder, files });
        }
    }
    return out;
}

function listSavedProformas() {
    const root = path.join(cfg.DOCUMENTS_SAVED_DIR, 'proforma');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.pdf')).sort().reverse();
}

// ── BILL OF LADING (2026-09-15) ─────────────────────────────────────────
// Nested by date, NOT by container, which splits the difference between the
// two layouts above and is a deliberate choice rather than a coin toss:
//
//   bol/<YYYY-MM-DD>/<filename>.pdf
//
// A BOL is one truck leaving on one day, so the day is the thing you look it
// up by ("what went out on the 15th"). Nesting by container like the invoice
// would scatter a single day's five BOLs into five folders, and several will
// have no container number at all — she types everything fresh, so a blank
// container would file them all under "UNKNOWN" together, which is the worst
// of both. Flat like the proforma would work today and turn into a thousand-
// file directory inside two years.
function saveBolCopy(buffer, filename, dateStr) {
    const date = dateStr || new Date().toISOString().slice(0, 10);
    const destDir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'bol', date);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(filename));
    fs.writeFileSync(destPath, buffer);
    return destPath;
}

function listSavedBols() {
    const root = path.join(cfg.DOCUMENTS_SAVED_DIR, 'bol');
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const dateFolder of fs.readdirSync(root).sort().reverse()) {
        const datePath = path.join(root, dateFolder);
        if (!fs.statSync(datePath).isDirectory()) continue;
        const files = fs.readdirSync(datePath).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
        if (files.length) out.push({ date: dateFolder, files });
    }
    return out;
}

// Resolves a saved PDF's on-disk path from a (kind, filename[, date,
// container]) request, checked to still be inside DOCUMENTS_SAVED_DIR
// before returning — closes the obvious path-traversal hole (e.g.
// "../../config.js") a raw querystring path would otherwise open.
// Returns null if invalid or the file doesn't exist.
// KINDS ARE AN ALLOWLIST, not a check for the one bad value. Written as a
// Set so adding 'bol' (2026-09-15) could not accidentally become
// `kind !== 'invoice' && kind !== 'proforma' && kind !== 'bol'` — a chain
// where one `&&` typed as `||` silently lets every kind through, including
// ones that resolve to directories that do not exist and paths nobody
// intended. The traversal guard below is the real defence, but a guard is
// cheaper to keep correct when the thing in front of it cannot go wrong.
const SAVED_KINDS = new Set(['invoice', 'proforma', 'bol']);

function resolveSavedPath({ kind, filename, date, container }) {
    if (!SAVED_KINDS.has(kind) || !filename) return null;

    const safeDate = () => String(date || '').trim().replace(/[^0-9\-]/g, '_');
    let targetDir;
    if (kind === 'invoice') {
        targetDir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice', safeDate(), safeName(container));
    } else if (kind === 'bol') {
        targetDir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'bol', safeDate());
    } else {
        targetDir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'proforma');
    }

    const safeFilename = path.basename(filename); // strips any directory components a crafted filename might smuggle in
    const targetPath = path.normalize(path.join(targetDir, safeFilename));

    const savedDocsRoot = path.normalize(cfg.DOCUMENTS_SAVED_DIR);
    if (!(targetPath === savedDocsRoot || targetPath.startsWith(savedDocsRoot + path.sep))) return null;
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) return null;
    return targetPath;
}

// ── DELETING A SAVED DOCUMENT ──────────────────────────────────────────────
// Apsara, 2026-09-17: "add delete option in saved proforma/invoice/bol/packing
// list", and, asked what it should remove: "The PDF and the record".
//
// Resolved through resolveSavedPath rather than by joining the filename onto a
// directory here. That function already refuses anything that escapes the
// archive root — a filename of "../../data/banks.json" resolves to null — and
// a second path-building code path beside it is a second place to get that
// wrong. This one returns the path it removed, or null when there was nothing
// there, so the caller can tell "deleted" from "already gone" and say so.
function deleteSaved({ kind, filename, date, container }) {
    const target = resolveSavedPath({ kind, filename, date, container });
    if (!target) return null;
    fs.unlinkSync(target);
    return target;
}

module.exports = {
    safeName, SAVED_KINDS,
    saveInvoiceCopy, saveProformaCopy, saveBolCopy,
    listSavedInvoices, listSavedProformas, listSavedBols,
    resolveSavedPath, deleteSaved,
};
