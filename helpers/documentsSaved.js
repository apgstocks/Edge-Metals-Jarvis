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

// Resolves a saved PDF's on-disk path from a (kind, filename[, date,
// container]) request, checked to still be inside DOCUMENTS_SAVED_DIR
// before returning — closes the obvious path-traversal hole (e.g.
// "../../config.js") a raw querystring path would otherwise open.
// Returns null if invalid or the file doesn't exist.
function resolveSavedPath({ kind, filename, date, container }) {
    if ((kind !== 'invoice' && kind !== 'proforma') || !filename) return null;

    let targetDir;
    if (kind === 'invoice') {
        const safeDate = String(date || '').trim().replace(/[^0-9\-]/g, '_');
        targetDir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice', safeDate, safeName(container));
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

module.exports = { safeName, saveInvoiceCopy, saveProformaCopy, listSavedInvoices, listSavedProformas, resolveSavedPath };
