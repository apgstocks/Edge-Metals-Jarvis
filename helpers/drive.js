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

// Resolved load-subfolder IDs, cached per process lifetime — a single load
// triggers 2-3 uploads in quick succession (gross photo, tare photo, PDF),
// and without this every one of them would re-run a Drive files.list lookup
// for the same folder. Not persisted across restarts; worst case after a
// restart is one extra lookup per load, never a duplicate folder (the lookup
// itself is what prevents that).
const loadSubfolderCache = new Map();

// Finds (or creates) a subfolder named exactly `loadId` directly under
// `parentId` — per Apsara, every load's gross/tare photos + PDF should land
// together in their own folder inside Yard, not all loads dumped flat into
// one folder. Idempotent: safe to call for the same load repeatedly (e.g.
// gross photo then tare photo then PDF, all for "EDGE_05") — finds the
// already-created subfolder on the 2nd/3rd call instead of making a
// duplicate. Returns parentId unchanged (never throws) if the lookup/create
// itself fails, so a Drive hiccup degrades to "flat in Yard" instead of
// blocking the upload entirely.
async function getOrCreateLoadSubfolder(drive, parentId, loadId) {
    const cacheKey = `${parentId}::${loadId}`;
    if (loadSubfolderCache.has(cacheKey)) return loadSubfolderCache.get(cacheKey);
    try {
        const escapedId = loadId.replace(/'/g, "\\'");
        const list = await drive.files.list({
            q: `'${parentId}' in parents and name = '${escapedId}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id, name)',
            pageSize: 1,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            corpora: 'allDrives',
        });
        let folderId;
        if (list.data.files && list.data.files.length > 0) {
            folderId = list.data.files[0].id;
        } else {
            const created = await drive.files.create({
                requestBody: { name: loadId, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
                fields: 'id',
                supportsAllDrives: true,
            });
            folderId = created.data.id;
            console.log(`[DRIVE] Created load subfolder "${loadId}" (${folderId})`);
        }
        loadSubfolderCache.set(cacheKey, folderId);
        return folderId;
    } catch (err) {
        console.warn(`[DRIVE] Could not find/create subfolder for load "${loadId}", uploading to the parent folder instead:`, err.message);
        return parentId;
    }
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
// `loadId`, when passed, files this into a per-load subfolder (see
// getOrCreateLoadSubfolder above) instead of flat in the parent folder —
// optional so workflow/actions.js's standalone WhatsApp scale-ticket flow
// (which has no "load" concept at all) keeps its existing flat behavior.
// Returns { fileId, name, webViewLink } or throws.
async function uploadScaleTicketImage(ticketId, imageBase64, mimeType, originalFilename, loadId) {
    if (!ticketId) throw new Error('ticketId required');
    if (!imageBase64) throw new Error('image data required');

    const drive = getDrive();
    const { Readable } = require('stream');
    const buffer = Buffer.from(imageBase64, 'base64');
    const ext  = (mimeType || '').includes('png') ? 'png' : 'jpg';
    const name = `${ticketId}.${ext}`;

    let parentId = cfg.GDRIVE_SCALE_TICKETS_FOLDER_ID || cfg.GDRIVE_UPLOAD_FOLDER_ID;
    if (!parentId) throw new Error('GDRIVE_UPLOAD_FOLDER_ID (or GDRIVE_SCALE_TICKETS_FOLDER_ID) not configured');
    if (loadId) parentId = await getOrCreateLoadSubfolder(drive, parentId, loadId);

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

// Resolves the SAME parentId uploadScaleTicketImage/uploadLoadPdf use before
// calling getOrCreateLoadSubfolder — pulled out so the rename/trash helpers
// below search the right place without duplicating this fallback logic a
// third time.
function loadSubfolderParentId() {
    return cfg.GDRIVE_SCALE_TICKETS_FOLDER_ID || cfg.GDRIVE_UPLOAD_FOLDER_ID;
}

// Finds a load's existing subfolder by name WITHOUT creating one if it's
// missing (unlike getOrCreateLoadSubfolder, which is wrong for rename/trash —
// creating an empty folder just to immediately rename or trash it would be
// pointless and, for trash, would leave a stray empty folder in some edge
// case). Returns null (not the parentId fallback) if nothing is found, so
// callers can tell "no folder exists" apart from "folder found, id below."
async function findLoadSubfolder(drive, parentId, loadId) {
    const escapedId = loadId.replace(/'/g, "\\'");
    const list = await drive.files.list({
        q: `'${parentId}' in parents and name = '${escapedId}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
    });
    return (list.data.files && list.data.files[0]) || null;
}

// Renames a load's Drive subfolder to match a renumbered load id — called by
// api.js's PUT /api/loads/:id/renumber route right after helpers/loads.js's
// renumberLoad() changes the JSON record. Per Apsara 2026-08-15 ("there
// should be a way to adjust the load number"). Deliberately RENAMES the
// existing folder in place rather than creating a new one and moving files —
// a rename is one API call, atomic, and every existing photo/PDF inside it
// stays exactly where it is. Skipping this (or it failing) would leave the
// load's files sitting under their OLD name while any future upload for the
// new id creates a second, new-named folder via getOrCreateLoadSubfolder —
// splitting one load's files across two folders. Best-effort: returns a
// { renamed: false } shape instead of throwing on any failure, since the
// load record itself is already renamed by the time this runs and a Drive
// hiccup here shouldn't make renumbering look like it failed outright.
async function renameLoadSubfolder(oldLoadId, newLoadId) {
    const parentId = loadSubfolderParentId();
    if (!parentId) return { renamed: false, reason: 'not_configured' };
    const drive = getDrive();
    try {
        const folder = await findLoadSubfolder(drive, parentId, oldLoadId);
        if (!folder) return { renamed: false, reason: 'not_found' }; // load never had a photo/PDF uploaded — nothing to rename
        await drive.files.update({ fileId: folder.id, requestBody: { name: newLoadId }, supportsAllDrives: true });
        loadSubfolderCache.delete(`${parentId}::${oldLoadId}`);
        loadSubfolderCache.set(`${parentId}::${newLoadId}`, folder.id);
        console.log(`[DRIVE] Renamed load subfolder "${oldLoadId}" -> "${newLoadId}" (${folder.id})`);
        return { renamed: true, folderId: folder.id };
    } catch (err) {
        console.warn(`[DRIVE] Could not rename subfolder for load "${oldLoadId}" -> "${newLoadId}":`, err.message);
        return { renamed: false, reason: 'error', error: err.message };
    }
}

// Trashes (NOT permanently deletes — same reasoning as deletePdfByBooking
// below: recoverable from Drive's Trash for 30 days) a load's entire Drive
// subfolder — its gross/tare photos AND its generated PDFs, since
// uploadScaleTicketImage and uploadLoadPdf both file into the SAME per-load
// subfolder via getOrCreateLoadSubfolder. One trash call therefore cleans up
// everything for that load, rather than needing to trash each item photo and
// PDF file individually. Called by api.js's DELETE /api/loads/:id route,
// per Apsara 2026-08-15 ("whatever the artifacts stored under that load
// should get deleted in my drive"). Best-effort/fails soft: a Drive error
// here must not make the load un-deletable from the dashboard/mobile app —
// the JSON record delete (helpers/loads.js's deleteLoad) is what actually
// matters to the user and always proceeds regardless of this outcome.
async function trashLoadFolder(loadId) {
    if (!loadId) return { trashed: false, reason: 'no_load_id' };
    const parentId = loadSubfolderParentId();
    if (!parentId) return { trashed: false, reason: 'not_configured' };
    const drive = getDrive();
    try {
        const folder = await findLoadSubfolder(drive, parentId, loadId);
        if (!folder) return { trashed: false, reason: 'not_found' }; // load never had a photo/PDF uploaded
        await drive.files.update({ fileId: folder.id, requestBody: { trashed: true }, supportsAllDrives: true });
        loadSubfolderCache.delete(`${parentId}::${loadId}`);
        console.log(`[DRIVE] Trashed load subfolder "${loadId}" (${folder.id}) — recoverable from Drive's Trash for 30 days`);
        return { trashed: true, folderId: folder.id };
    } catch (err) {
        console.warn(`[DRIVE] Could not trash subfolder for load "${loadId}":`, err.message);
        return { trashed: false, reason: 'error', error: err.message };
    }
}

// ── Upload a generated load-ticket PDF to Shared Drive ────────────────────────
// Same Shared Drive/service account as everything else here. Called by
// helpers/pdf.js's generateLoadPdf() after rendering, never called directly
// with a hand-built buffer from elsewhere — keeps the "how is a load PDF
// named/filed" decision in one place. `filenameOverride` lets the SAME
// upload path be reused for the separate weights_<id>.pdf (see
// generateWeightsPdf in helpers/pdf.js + the /generate-pdf route in api.js)
// instead of duplicating this whole function for one filename difference.
async function uploadLoadPdf(loadId, pdfBuffer, filenameOverride) {
    if (!loadId) throw new Error('loadId required');
    if (!pdfBuffer) throw new Error('pdf buffer required');

    const drive = getDrive();
    const { Readable } = require('stream');
    const name = filenameOverride || `${loadId}.pdf`;

    let parentId = cfg.GDRIVE_SCALE_TICKETS_FOLDER_ID || cfg.GDRIVE_UPLOAD_FOLDER_ID;
    if (!parentId) throw new Error('GDRIVE_UPLOAD_FOLDER_ID (or GDRIVE_SCALE_TICKETS_FOLDER_ID) not configured');
    // Same subfolder the gross/tare photos for this load land in (see
    // getOrCreateLoadSubfolder above) — the PDF and its source photos end up
    // together in one place per load instead of split across folders.
    parentId = await getOrCreateLoadSubfolder(drive, parentId, loadId);

    const created = await drive.files.create({
        requestBody: { name, parents: [parentId] },
        media: { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
    });
    console.log(`[DRIVE] Uploaded load PDF ${name} (${created.data.id})`);
    return created.data;
}

// ── "Reports" folder — nightly inventory backup + daily PDF ────────────────
// Per Apsara 2026-08-15: "an excel should be created to track this inventory
// ... everyday a pdf should be created for inventory for that day and it
// should stored in drive as report folder." One fixed-name subfolder under
// the same GDRIVE_UPLOAD_FOLDER_ID everything else already uses — cached per
// process lifetime, same reasoning as loadSubfolderCache above (this gets
// hit once a night, not per-load, but the pattern's cheap and consistent).
let reportsFolderId = null;
async function getOrCreateReportsFolder(drive) {
    if (reportsFolderId) return reportsFolderId;
    const parentId = cfg.GDRIVE_SCALE_TICKETS_FOLDER_ID || cfg.GDRIVE_UPLOAD_FOLDER_ID;
    if (!parentId) throw new Error('GDRIVE_UPLOAD_FOLDER_ID (or GDRIVE_SCALE_TICKETS_FOLDER_ID) not configured');
    const list = await drive.files.list({
        q: `'${parentId}' in parents and name = 'Reports' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
    });
    if (list.data.files && list.data.files.length > 0) {
        reportsFolderId = list.data.files[0].id;
    } else {
        const created = await drive.files.create({
            requestBody: { name: 'Reports', mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
            fields: 'id',
            supportsAllDrives: true,
        });
        reportsFolderId = created.data.id;
        console.log(`[DRIVE] Created Reports folder (${reportsFolderId})`);
    }
    return reportsFolderId;
}

// The Excel backup is ONE persistent, always-current file — updated in
// place every night (per Apsara: "last 5 day tab loads and one overall
// sheet", i.e. a rolling snapshot, not a dated archive) rather than piling
// up a new copy every day. Finds-and-replaces by fixed name.
// Create-or-replace a file in the Reports folder by NAME, returning the
// same file id (and therefore the same shareable URL) every time — added
// 2026-08-19 for the live inventory sheet + monthly workbook. Generalises
// the pattern uploadInventoryBackupXlsx already used so the two new
// artefacts don't each re-implement the list/update/create dance.
//
// asGoogleSheet:true uploads the SAME xlsx bytes but asks Drive to store
// the result as a native Google Sheet (requestBody.mimeType =
// application/vnd.google-apps.spreadsheet with an xlsx media body — Drive
// converts on ingest). This is deliberately how the "google sheet"
// requirement is met without touching credentials: helpers/sheets.js is
// scoped 'spreadsheets.readonly', so the Sheets API cannot write anything,
// but THIS client already holds the full 'drive' scope, and a conversion
// upload is an ordinary Drive write. A files.update with new media on an
// existing Google Sheet replaces its content in place, so the link never
// changes and anyone who has it keeps working.
async function upsertReportFile(name, buffer, { asGoogleSheet = false } = {}) {
    if (!buffer) throw new Error('file buffer required');
    const drive = getDrive();
    const parentId = await getOrCreateReportsFolder(drive);
    const { Readable } = require('stream');
    const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const media = { mimeType: XLSX_MIME, body: Readable.from(buffer) };

    // Escape single quotes — a name is interpolated into the Drive query
    // string, and an apostrophe would otherwise break the query.
    const safeName = String(name).replace(/'/g, "\\'");
    const list = await drive.files.list({
        q: `'${parentId}' in parents and name = '${safeName}' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
    });
    if (list.data.files && list.data.files.length > 0) {
        const updated = await drive.files.update({
            fileId: list.data.files[0].id, media,
            fields: 'id, name, webViewLink', supportsAllDrives: true,
        });
        return updated.data;
    }
    const created = await drive.files.create({
        requestBody: asGoogleSheet
            ? { name, parents: [parentId], mimeType: 'application/vnd.google-apps.spreadsheet' }
            : { name, parents: [parentId] },
        media,
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
    });
    console.log(`[DRIVE] Created ${asGoogleSheet ? 'Google Sheet' : 'file'} "${name}" (${created.data.id})`);
    return created.data;
}

async function uploadInventoryBackupXlsx(buffer) {
    if (!buffer) throw new Error('workbook buffer required');
    const drive = getDrive();
    const parentId = await getOrCreateReportsFolder(drive);
    const { Readable } = require('stream');
    const name = 'Inventory-Backup.xlsx';
    const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    const list = await drive.files.list({
        q: `'${parentId}' in parents and name = '${name}' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
    });
    const media = { mimeType, body: Readable.from(buffer) };
    if (list.data.files && list.data.files.length > 0) {
        const updated = await drive.files.update({ fileId: list.data.files[0].id, media, fields: 'id, name, webViewLink', supportsAllDrives: true });
        console.log(`[DRIVE] Updated ${name} (${updated.data.id})`);
        return updated.data;
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

// The daily inventory PDF is the opposite: a dated ARCHIVE, one new file per
// day, per Apsara ("everyday a pdf should be created ... and stored"). Never
// overwrites — a duplicate call for the same date (e.g. a manual re-run)
// would just leave two files with the same name in Drive rather than
// silently losing one, which is an acceptable edge case for a once-nightly
// job with idempotency already handled one layer up (scheduler.js's
// brain.proactive_sent guard).
async function uploadDailyInventoryPdf(dateKey, buffer) {
    if (!buffer) throw new Error('pdf buffer required');
    const drive = getDrive();
    const parentId = await getOrCreateReportsFolder(drive);
    const { Readable } = require('stream');
    const name = `Inventory-Report-${dateKey}.pdf`;
    const created = await drive.files.create({
        requestBody: { name, parents: [parentId] },
        media: { mimeType: 'application/pdf', body: Readable.from(buffer) },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
    });
    console.log(`[DRIVE] Uploaded ${name} (${created.data.id})`);
    return created.data;
}

module.exports = { upsertReportFile, fetchPdfFromDrive, findPdfByBooking, uploadPdfToDrive, deletePdfByBooking, listAllPdfs, downloadPdfById, isConfirmationClassification, exportDocAsText, uploadScaleTicketImage, uploadLoadPdf, renameLoadSubfolder, trashLoadFolder, getOrCreateReportsFolder, uploadInventoryBackupXlsx, uploadDailyInventoryPdf };

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