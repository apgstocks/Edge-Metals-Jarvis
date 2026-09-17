// ── helpers/shipmentDocs.js — the documents for one container ────────────────
//
// Apsara, 2026-09-17: "now once the invoice and packing list is created - when
// i give command to jarvis to send---> it should able to mail customer with
// documents", and on how she names the shipment: BY CONTAINER NUMBER.
//
// So this answers exactly one question: given a container number, which files
// on disk are that shipment's invoice and its packing list?
//
// ── IT FINDS, IT NEVER GENERATES ────────────────────────────────────────────
// Nothing here builds a PDF. The documents she is asking to send are the ones
// she already made and checked — regenerating them at send time would email a
// buyer a document she has never seen, and any drift since (a rate she edited,
// an address book that moved) would go out under her name. If a document is
// not on disk, the honest answer is "it isn't there", not a fresh one.
//
// ── THREE NAMING CONVENTIONS, ONE FOLDER ────────────────────────────────────
// The archive grew three ways of naming these, all of them still in use and
// all of them sitting in the same invoice/<date>/<container>/ folder:
//
//   <inv_no>_INVOICE.pdf        invoice tab, "separate" mode, and "invoice only"
//   <inv_no>_PACKING_LIST.pdf   invoice tab, "separate" mode
//   <container>_packing.pdf     the packing list TAB (a different document —
//                               the compact one, gross/tare/net only)
//   <inv_no>.pdf                invoice tab, combined: invoice WITH its
//                               packing list bound into the one file
//
// That last one is why classify() cannot simply look for the word "invoice".
// A combined file is an invoice, and it already contains a packing list, so
// attaching a separate packing list beside it sends the customer the same
// weights twice. hasPackingInside marks it so the caller can say so.
//
// ── NEWEST WINS, AND ONLY WITHIN ONE DAY ────────────────────────────────────
// She regenerates. A container that was invoiced on the 15th and corrected on
// the 17th has two folders, and the 17th is the one a buyer should receive.
// But the pair is taken from a SINGLE folder — never an invoice from the 17th
// beside a packing list from the 15th. Weights that do not match the invoice
// they arrive with is precisely the problem this feature exists to avoid.

const fs   = require('fs');
const path = require('path');
const cfg  = require('../config');
const { loadJson } = require('./json');
const { safeName } = require('./documentsSaved');

// Which document is this file?
//
// Both tests are ANCHORED TO THE END of the name, which is what makes
// "EM1047_INVOICE_PACKING_LIST.pdf" — a name carrying both words — classify
// as a packing list. Reordering the two tests does not change that, and an
// earlier version of this comment claimed the order was what protected it.
// It isn't; the anchors are. (My error, not a decision of Apsara's: a
// mutation swapping the order left every check green, which is how it
// surfaced.) Drop the `$` and the order starts to matter very much.
function classify(filename) {
    const f = String(filename || '');
    if (!/\.pdf$/i.test(f)) return null;
    const base = f.replace(/\.pdf$/i, '');
    if (/_PACKING[_-]?LIST$/i.test(base) || /_PACKING$/i.test(base)) {
        return { kind: 'packing', combined: false };
    }
    if (/_INVOICE$/i.test(base)) {
        // "invoice only" and "separate" both produce this name. Neither has a
        // packing list bound in — separate mode files that alongside, and
        // invoice-only deliberately has none.
        return { kind: 'invoice', combined: false };
    }
    // Anything else ending .pdf in an invoice folder is the combined document.
    return { kind: 'invoice', combined: true };
}

// Every date folder holding files for this container, newest first.
function foldersFor(containerNo) {
    const wanted = safeName(containerNo);
    const root = path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice');
    if (!fs.existsSync(root)) return [];
    const out = [];
    let dates;
    try { dates = fs.readdirSync(root).sort().reverse(); } catch (e) { return []; }
    for (const date of dates) {
        const datePath = path.join(root, date);
        let stat;
        try { stat = fs.statSync(datePath); } catch (e) { continue; }
        if (!stat.isDirectory()) continue;
        const cPath = path.join(datePath, wanted);
        let cStat;
        try { cStat = fs.statSync(cPath); } catch (e) { continue; }
        if (!cStat.isDirectory()) continue;
        let files;
        try { files = fs.readdirSync(cPath).filter((f) => /\.pdf$/i.test(f)); } catch (e) { continue; }
        if (files.length) out.push({ date, container: wanted, dir: cPath, files });
    }
    return out;
}

// Most recently written file wins when one folder holds two of the same kind
// — she regenerated the invoice twice on the same day, and the later one is
// the one she meant. mtime rather than filename, because "separate" mode
// overwrites under the same name and the name therefore says nothing.
function newestOf(dir, names) {
    let best = null;
    let bestAt = -1;
    for (const n of names) {
        let at = 0;
        try { at = fs.statSync(path.join(dir, n)).mtimeMs; } catch (e) { continue; }
        if (at > bestAt) { bestAt = at; best = n; }
    }
    return best;
}

// The consignee on file for this container, from the version history the
// invoice route writes on every save. Used to look the email address up —
// she names a CONTAINER, and a container does not carry a customer's name.
function customerFor(containerNo) {
    const wanted = String(containerNo || '').trim().toUpperCase();
    if (!wanted) return null;
    const store = loadJson(cfg.INVOICE_VERSIONS_FILE, {});
    if (!store || typeof store !== 'object') return null;
    // Keyed by the container as typed, which may differ in case or spacing
    // from what she just said out loud.
    const key = Object.keys(store).find((k) => String(k).trim().toUpperCase() === wanted)
        || Object.keys(store).find((k) => safeName(k) === safeName(wanted));
    if (!key) return null;
    const entry = store[key];
    const rec = Array.isArray(entry) ? entry[entry.length - 1] : entry;
    if (!rec || typeof rec !== 'object') return null;
    return {
        consignee: String(rec.consignee || '').trim() || null,
        inv_no: String(rec.inv_no || '').trim() || null,
    };
}

// ── THE ANSWER ──────────────────────────────────────────────────────────────
// Returns null when the container has no documents at all. Otherwise always
// returns a result — including an incomplete one, with `missing` filled in.
// Deciding what to do about a missing packing list is the caller's business;
// this function's job is to be straight about what is there.
function findForContainer(containerNo) {
    const folders = foldersFor(containerNo);
    if (!folders.length) return null;

    // The newest folder that has an INVOICE in it. A folder holding only a
    // packing list (the packing tab was used before the invoice was raised)
    // is not the shipment's document set, and picking it would report the
    // invoice missing when a perfectly good one sits in yesterday's folder.
    let chosen = null;
    for (const f of folders) {
        const classified = f.files.map((n) => ({ name: n, ...(classify(n) || {}) }));
        if (classified.some((c) => c.kind === 'invoice')) { chosen = { ...f, classified }; break; }
    }
    if (!chosen) {
        const f = folders[0];
        chosen = { ...f, classified: f.files.map((n) => ({ name: n, ...(classify(n) || {}) })) };
    }

    const invoiceNames = chosen.classified.filter((c) => c.kind === 'invoice').map((c) => c.name);
    const packingNames = chosen.classified.filter((c) => c.kind === 'packing').map((c) => c.name);

    const invoice = newestOf(chosen.dir, invoiceNames);
    let packing = newestOf(chosen.dir, packingNames);
    const combined = invoice ? !!(classify(invoice) || {}).combined : false;

    // ── A PACKING LIST FILED UNDER A DIFFERENT DAY ──────────────────────────
    // Apsara, 2026-09-17, describing exactly this: "Say i have checked invoice
    // only and generated packing list sep for container-123. When i say to
    // jarvis to send documents of 123-how does it work?"
    //
    // It did not work. The two routes disagreed about what "today" was — the
    // invoice filed under UTC, the packing list under Pacific — so an evening
    // pair landed in two folders and this function reported the packing list
    // missing. That clock bug is fixed at source now (helpers/documentsSaved.js),
    // but two cases remain and always will:
    //
    //   the packing list carries ITS OWN date (rec.date), so dating one to the
    //     shipment date files it under that day while the invoice files under
    //     today — no clock involved, and no fix at source possible;
    //   everything already in the archive, which is split as it stands.
    //
    // So: look wider, but ONLY when the invoice's own folder has nothing. A
    // packing list sitting beside the invoice always wins — this can never
    // override a correctly-paired document.
    //
    // ── AND IT SAYS SO OUT LOUD ─────────────────────────────────────────────
    // This is the one place that pairs documents filed on different days,
    // which the rest of this file exists to prevent. The protection is not
    // cleverness about which one is right — it cannot know — it is that
    // `packingFromDate` is set and the read-back names the date, so she sees
    // "packing list from 2026-09-15" before she says yes.
    let packingFromDate = null;
    if (!packing && !combined) {
        for (const f of folders) {
            if (f.dir === chosen.dir) continue;
            const names = f.files.filter((n) => (classify(n) || {}).kind === 'packing');
            const best = newestOf(f.dir, names);
            if (best) {
                packing = best;
                packingFromDate = f.date;
                chosen.packingDir = f.dir;
                break;   // folders are newest-first, so this is the latest one
            }
        }
    }
    const packingDir = packingFromDate ? chosen.packingDir : chosen.dir;

    const missing = [];
    if (!invoice) missing.push('invoice');
    // A combined document already carries the packing list inside it, so a
    // missing separate one is not a gap — see the header.
    if (!packing && !combined) missing.push('packing list');

    return {
        container: chosen.container,
        date: chosen.date,
        dir: chosen.dir,
        invoice: invoice ? { filename: invoice, path: path.join(chosen.dir, invoice) } : null,
        packing: packing ? { filename: packing, path: path.join(packingDir, packing) } : null,
        hasPackingInside: combined,
        // Null when the pair came from one folder, which is the normal case.
        // A date here means the caller MUST tell her — see the block above.
        packingFromDate,
        missing,
        ...(customerFor(containerNo) || { consignee: null, inv_no: null }),
    };
}

// What the send path attaches: [{ filename, content:<Buffer>, mimeType }],
// the exact shape helpers/gmail.js sendEmail() already takes.
//
// Reads the files HERE rather than handing back paths, so that a document
// deleted between the read-back and her "yes" fails loudly at build time
// instead of sending an email with an empty attachment on it.
function attachmentsFor(found) {
    if (!found) return [];
    const out = [];
    for (const doc of [found.invoice, found.packing]) {
        if (!doc) continue;
        out.push({
            filename: doc.filename,
            content: fs.readFileSync(doc.path),
            mimeType: 'application/pdf',
        });
    }
    return out;
}

module.exports = { classify, foldersFor, customerFor, findForContainer, attachmentsFor, newestOf };
