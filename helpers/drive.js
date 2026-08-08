// ── helpers/drive.js — Google Drive booking PDFs (service account) ───────────
// Only Drive remains from Google Cloud — it's free tier and holds booking PDFs.
// Keyfile path + folder ID come from config. Fails soft: booking still forwards
// as a text card if the PDF can't be found.
//
// SCOPE NOTE: drive.file scope means the SA can only read/write files IT created
// or that were explicitly shared with it. Combined with SHARED DRIVE usage below.
//
// SHARED DRIVE: Service accounts have NO personal storage quota. Files must live
// in a Shared Drive (owned by the Workspace org, not by any user). Every API call
// therefore needs `supportsAllDrives: true`; `files.list` also needs `corpora:
// 'drive'` and the `driveId` to search inside the Shared Drive.

const fs  = require('fs');
const cfg = require('../config');

let driveClient = null;

function getDrive() {
    if (driveClient) return driveClient;
    if (!fs.existsSync(cfg.GDRIVE_KEYFILE)) {
        throw new Error(`Drive keyfile missing: ${cfg.GDRIVE_KEYFILE}`);
    }
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
        keyFile: cfg.GDRIVE_KEYFILE,
        // drive: read/write/delete access to any file in Shared Drives the SA is a member of.
        // Broader than drive.file (which restricts to files created by this SA session), but
        // Edge Bot Shared Drive is dedicated to Jarvis — no other files live there.
        // Fixes "File not found" on delete for files uploaded in prior SA sessions.
        scopes : ['https://www.googleapis.com/auth/drive'],
    });
    driveClient = google.drive({ version: 'v3', auth });
    return driveClient;
}

// Find a PDF whose name contains the booking number (inside the Shared Drive)
async function findPdfByBooking(bkgNo) {
    const drive = getDrive();
    if (!cfg.GDRIVE_FOLDER_ID) return null;

    const q = [`name contains '${bkgNo}'`, `mimeType = 'application/pdf'`, 'trashed = false'].join(' and ');

    const res = await drive.files.list({
        q,
        fields: 'files(id, name)',
        pageSize: 5,
        orderBy: 'modifiedTime desc',
        // Shared Drive support
        supportsAllDrives      : true,
        includeItemsFromAllDrives: true,
        corpora                : 'drive',
        driveId                : cfg.GDRIVE_FOLDER_ID,
    });
    return res.data.files?.[0] || null;
}

// Returns { base64, filename, mimetype } for whatsapp-web.js MessageMedia, or null
async function fetchPdfFromDrive(bkgNo) {
    try {
        const file = await findPdfByBooking(bkgNo);
        if (!file) {
            console.log(`[DRIVE] No PDF found for ${bkgNo}`);
            return null;
        }
        const drive = getDrive();
        const res = await drive.files.get(
            { fileId: file.id, alt: 'media', supportsAllDrives: true },
            { responseType: 'arraybuffer' }
        );
        console.log(`[DRIVE] Fetched ${file.name} for ${bkgNo}`);
        return {
            base64  : Buffer.from(res.data).toString('base64'),
            filename: file.name,
            mimetype: 'application/pdf',
        };
    } catch (err) {
        console.error(`[DRIVE] Fetch failed for ${bkgNo}:`, err.message);
        return null;
    }
}

// Pure decision, pulled out so it's directly testable without a live Drive/
// Gemini call: does this classification result mean the incoming file is
// genuinely a booking confirmation and therefore safe to let it replace an
// existing one? Fails closed — null, a missing flag, or is_invoice_or_other
// all resolve to "no."
function isConfirmationClassification(classification) {
    return !!classification && classification.is_booking_confirmation === true && !classification.is_invoice_or_other;
}

// ── Upload a booking PDF to Shared Drive (used by the Bookings tab) ──────────
// Naming convention: <BKG_NO>.pdf so findPdfByBooking() locates it later.
// If a PDF with the same booking number already exists, we update it in-place
// so the booking never has two PDFs (last-upload-wins matches user expectation)
// — BUT ONLY when the new upload is itself a booking confirmation. A real
// booking (GLTOEH-27233) lost its confirmation PDF this way: its Bill of
// Lading legitimately shares the SAME booking/reference number (completely
// normal in freight — a carrier issues a booking confirmation first, then a
// B/L once cargo is loaded), and used to silently overwrite the confirmation
// here with zero warning. A later "forward booking to trucker" would then
// send the B/L instead of the confirmation. Returns { fileId, name,
// webViewLink } or throws — including when refusing to overwrite.
async function uploadPdfToDrive(bkgNo, pdfBase64, originalFilename) {
    if (!bkgNo) throw new Error('booking number required');
    if (!pdfBase64) throw new Error('PDF data required');
    if (!cfg.GDRIVE_FOLDER_ID) throw new Error('GDRIVE_FOLDER_ID not configured');

    const drive = getDrive();
    const { Readable } = require('stream');
    const buffer = Buffer.from(pdfBase64, 'base64');
    const name   = `${bkgNo}.pdf`;

    // Update in place if we already have one for this booking
    const existing = await findPdfByBooking(bkgNo).catch(() => null);
    const media    = { mimeType: 'application/pdf', body: Readable.from(buffer) };

    if (existing) {
        // Classify the INCOMING file before letting it replace whatever's
        // already on file. Fails safe: a classification error or a "no"
        // both refuse the overwrite rather than trusting the upload blindly.
        const { classifyDocument } = require('./gemini');
        const classification = await classifyDocument(pdfBase64).catch((err) => {
            console.error(`[DRIVE] Classification failed for ${bkgNo} upload — refusing to overwrite the existing PDF as a precaution:`, err.message);
            return null;
        });
        if (!isConfirmationClassification(classification)) {
            const docType = classification?.document_type || 'an unclassifiable document';
            console.warn(`[DRIVE] ${bkgNo}: refused to overwrite existing PDF — new upload looks like ${docType}, not a booking confirmation. Existing file left untouched: ${existing.name} (${existing.id})`);
            const err = new Error(`Refused to overwrite ${bkgNo}'s existing booking confirmation — the new file looks like ${docType}, not a booking confirmation. The existing PDF was left untouched.`);
            err.code = 'NOT_A_BOOKING_CONFIRMATION';
            err.existingFile = { id: existing.id, name: existing.name };
            err.classification = classification;
            throw err;
        }

        const updated = await drive.files.update({
            fileId: existing.id,
            media,
            fields: 'id, name, webViewLink',
            supportsAllDrives: true,
        });
        console.log(`[DRIVE] Updated ${name} (${updated.data.id}) — new upload confirmed as a booking confirmation`);
        return updated.data;
    }

    // First upload — place inside the target folder.
    // GDRIVE_UPLOAD_FOLDER_ID (a real folder inside the Shared Drive) is used
    // as the parent. Do NOT use the Shared Drive root ID as a parent — Drive
    // rejects that with "File not found" because a drive root isn't a file.
    const parentId = cfg.GDRIVE_UPLOAD_FOLDER_ID;
    if (!parentId) {
        throw new Error('GDRIVE_UPLOAD_FOLDER_ID not configured (folder ID inside the Shared Drive)');
    }
    const created = await drive.files.create({
        requestBody: { name, parents: [parentId] },
        media,
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
    });
    console.log(`[DRIVE] Uploaded ${name} (${created.data.id})`);
    return created.data;
}

// ── Upload a yard scale-ticket photo to Shared Drive ──────────────────────────
// Conceptually separate from booking PDFs (not tied to a booking number, no
// overwrite-in-place semantics — every ticket is its own file, named by its
// scale_tickets.json record id) but reuses the SAME Shared Drive + service
// account, so this works with zero new Google Cloud setup. Uses
// GDRIVE_SCALE_TICKETS_FOLDER_ID if set, else falls back to the existing
// GDRIVE_UPLOAD_FOLDER_ID. Fails soft is the CALLER's responsibility here
// (see workflow/actions.js's yardScaleTicketReceived) — the extracted fields
// and the WhatsApp reply must never block on Drive being reachable.
// Returns { fileId, name, webViewLink } or throws.
async function uploadScaleTicketImage(ticketId, imageBase64, mimeType, originalFilename) {
    if (!ticketId) throw new Error('ticketId required');
    if (!imageBase64) throw new Error('image data required');

    const drive = getDrive();
    const { Readable } = require('stream');
    const buffer = Buffer.from(imageBase64, 'base64');
    const ext  = (mimeType || '').includes('png') ? 'png' : 'jpg';
    const name = `${ticketId}.${ext}`;

    const parentId = cfg.GDRIVE_SCALE_TICKETS_FOLDER_ID || cfg.GDRIVE_UPLOAD_FOLDER_ID;
    if (!parentId) throw new Error('GDRIVE_UPLOAD_FOLDER_ID (or GDRIVE_SCALE_TICKETS_FOLDER_ID) not configured');

    const created = await drive.files.create({
        requestBody: { name, parents: [parentId] },
        media: { mimeType: mimeType || 'image/jpeg', body: Readable.from(buffer) },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
    });
    console.log(`[DRIVE] Uploaded scale ticket ${name} (${created.data.id})`);
    return created.data;
}

// ── List every PDF in the upload folder (paginated) ───────────────────────
// Read-only — never touches file content or metadata. Built for one-off
// audits (e.g. checking which stored "booking" PDFs are actually invoices
// or other documents that slipped through the creation gate).
async function listAllPdfs() {
    const drive = getDrive();
    if (!cfg.GDRIVE_UPLOAD_FOLDER_ID) throw new Error('GDRIVE_UPLOAD_FOLDER_ID not configured');
    const files = [];
    let pageToken = null;
    do {
        const res = await drive.files.list({
            q: `'${cfg.GDRIVE_UPLOAD_FOLDER_ID}' in parents and mimeType = 'application/pdf' and trashed = false`,
            fields: 'nextPageToken, files(id, name, modifiedTime)',
            pageSize: 100,
            pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            corpora: 'drive',
            driveId: cfg.GDRIVE_FOLDER_ID,
        });
        files.push(...(res.data.files || []));
        pageToken = res.data.nextPageToken || null;
    } while (pageToken);
    return files;
}

// Raw PDF bytes as base64, by file ID — for classification/extraction calls.
async function downloadPdfById(fileId) {
    const drive = getDrive();
    const res = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data).toString('base64');
}

// Export a native Google Doc's content as plain text, by file ID — for
// helpers/addressBook.js's syncFromDoc(). Uses files.export (Drive API's
// standard way to pull a Google Doc's content), not files.get — files.get's
// alt:'media' only works on actual binary files (PDFs, etc.), not native
// Docs, which don't have raw bytes of their own. Reuses the SAME service
// account already authorized for booking PDFs; the target Doc just needs to
// be shared with that account's email as Viewer (same prerequisite as
// helpers/sheets.js's price list). NOT scoped to the Shared Drive — a
// regular personal/shared Doc works as long as it's shared with the SA.
async function exportDocAsText(docId) {
    const drive = getDrive();
    const res = await drive.files.export(
        { fileId: docId, mimeType: 'text/plain' },
        { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data).toString('utf8');
}

// ── Upload a generated load-ticket PDF to Shared Drive ────────────────────────
// Same Shared Drive/service account as everything else here. Called by
// helpers/pdf.js's generateLoadPdf() after rendering, never called directly
// with a hand-built buffer from elsewhere — keeps the "how is a load PDF
// named/filed" decision in one place.
async function uploadLoadPdf(loadId, pdfBuffer) {
    if (!loadId) throw new Error('loadId required');
    if (!pdfBuffer) throw new Error('pdf buffer required');

    const drive = getDrive();
    const { Readable } = require('stream');
    const name = `${loadId}.pdf`;

    const parentId = cfg.GDRIVE_SCALE_TICKETS_FOLDER_ID || cfg.GDRIVE_UPLOAD_FOLDER_ID;
    if (!parentId) throw new Error('GDRIVE_UPLOAD_FOLDER_ID (or GDRIVE_SCALE_TICKETS_FOLDER_ID) not configured');

    const created = await drive.files.create({
        requestBody: { name, parents: [parentId] },
        media: { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
    });
    console.log(`[DRIVE] Uploaded load PDF ${name} (${created.data.id})`);
    return created.data;
}

module.exports = { fetchPdfFromDrive, findPdfByBooking, uploadPdfToDrive, deletePdfByBooking, listAllPdfs, downloadPdfById, isConfirmationClassification, exportDocAsText, uploadScaleTicketImage, uploadLoadPdf };

// ── Delete a booking's PDF from Drive (used by DELETE /api/bookings/:bkgNo) ──
// Uses files.update with trashed=true instead of files.delete. The hard-delete
// path has a documented Google Drive API issue where SA-uploaded files in Shared
// Drives return "File not found" on delete despite existing. Trashing works
// reliably and Drive auto-purges after 30 days.
// Fails soft: if the PDF isn't found, returns { deleted: false, reason: 'not_found' }.
async function deletePdfByBooking(bkgNo) {
    if (!bkgNo) throw new Error('booking number required');
    const file = await findPdfByBooking(bkgNo);
    if (!file) return { deleted: false, reason: 'not_found' };
    const drive = getDrive();
    await drive.files.update({
        fileId: file.id,
        requestBody: { trashed: true },
        supportsAllDrives: true,
    });
    console.log(`[DRIVE] Trashed ${file.name} (${file.id}) for booking ${bkgNo}`);
    return { deleted: true, fileId: file.id, name: file.name };
}