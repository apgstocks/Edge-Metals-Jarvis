// ── helpers/drive.js — Google Drive booking PDFs (service account) ───────────
// Only Drive remains from Google Cloud — it's free tier and holds booking PDFs.
// Keyfile path + folder ID come from config. Fails soft: booking still forwards
// as a text card if the PDF can't be found.
//
// SCOPE NOTE: drive.file scope means the SA can only read/write files IT created
// or that were explicitly shared with it. So existing bookings uploaded outside
// this app need the SA email added as an editor on the parent folder.

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
        // drive.file: read/write only files created by or shared with the SA.
        // Safer than drive.readwrite, avoids seeing the whole workspace.
        scopes : ['https://www.googleapis.com/auth/drive.file'],
    });
    driveClient = google.drive({ version: 'v3', auth });
    return driveClient;
}

// Find a PDF whose name contains the booking number (inside the booking folder)
async function findPdfByBooking(bkgNo) {
    const drive = getDrive();
    const parts = [`name contains '${bkgNo}'`, `mimeType = 'application/pdf'`, 'trashed = false'];
    if (cfg.GDRIVE_FOLDER_ID) parts.push(`'${cfg.GDRIVE_FOLDER_ID}' in parents`);

    const res = await drive.files.list({
        q: parts.join(' and '),
        fields: 'files(id, name)',
        pageSize: 5,
        orderBy: 'modifiedTime desc',
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
            { fileId: file.id, alt: 'media' },
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

// ── Upload a booking PDF to Drive (used by the Bookings tab) ─────────────────
// Naming convention: <BKG_NO>.pdf so findPdfByBooking() locates it later.
// If a PDF with the same booking number already exists, we update it in-place
// so the booking never has two PDFs (last-upload-wins matches user expectation).
// Returns { fileId, name, webViewLink } or throws.
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
        const updated = await drive.files.update({
            fileId: existing.id,
            media,
            fields: 'id, name, webViewLink',
        });
        console.log(`[DRIVE] Updated ${name} (${updated.data.id})`);
        return updated.data;
    }

    const created = await drive.files.create({
        requestBody: { name, parents: [cfg.GDRIVE_FOLDER_ID] },
        media,
        fields: 'id, name, webViewLink',
    });
    console.log(`[DRIVE] Uploaded ${name} (${created.data.id})`);
    return created.data;
}

module.exports = { fetchPdfFromDrive, findPdfByBooking, uploadPdfToDrive };