// ── helpers/loadsPdf.js — generate + upload + store a load's PDFs ────────────
// Pulled out of api.js's POST /api/loads/:id/generate-pdf route so the SAME
// generation pipeline can be reused by scheduler.js's end-of-day yard report
// (which needs to make sure every one of today's loads has PDFs before it
// can email/attach them) without duplicating this logic in two places and
// having them drift apart. The route itself now just calls this.
const { generateLoadPdf, generateWeightsPdf, generateLoadReceiptPdf, PDF_TEMPLATE_VERSION } = require('./pdf');
const { uploadLoadPdf } = require('./drive');
const { updateLoad } = require('./loads');

// Generates the priced ticket + the separate weights-only PDF + the POS
// receipt-format PDF for a load, uploads all three to Drive, and patches
// the load record with the resulting links — returns the UPDATED load
// object. Mirrors the exact behavior the dashboard's "Generate PDF" button
// already triggers: the main ticket is required (a failure there throws),
// the weights PDF and the receipt PDF are both best-effort (a failure in
// either is logged and skipped, not fatal — the main ticket having
// uploaded successfully is what actually matters).
async function generateAndStoreLoadPdfs(load, opts = {}) {
    const buf = await generateLoadPdf(load, opts);
    const file = await uploadLoadPdf(load.id, buf);

    // Added 2026-08-12 per Apsara: the weights PDF exists to be photo-backed
    // proof of weight, so if no scale photos were ever captured for this load
    // there is nothing for it to prove and it shouldn't be produced at all —
    // previously it was generated unconditionally, yielding a document whose
    // whole purpose (the photo links under each weight) was empty.
    const items = Array.isArray(load.items) ? load.items : [];
    const hasScalePhotos = items.some(it => it.gross_photo_link || it.tare_photo_link);

    // Warnings are recorded on the load so a failed sub-document is visible
    // in the UI instead of only in pm2 logs (helpers/loadWarnings.js).
    const { buildWarning, setLoadWarnings, clearLoadWarnings } = require('./loadWarnings');
    const warnings = [];

    let weightsPatch = {};
    if (!hasScalePhotos) {
        console.log(`[loadsPdf] ${load.id}: no scale photos captured, skipping the weights PDF`);
    } else {
        try {
            const weightsBuf = await generateWeightsPdf(load, opts);
            const weightsFile = await uploadLoadPdf(load.id, weightsBuf, `weights_${load.id}.pdf`);
            weightsPatch = { weights_pdf_drive_id: weightsFile.id, weights_pdf_link: weightsFile.webViewLink };
        } catch (e) {
            console.error(`[loadsPdf] weights-pdf generation failed for ${load.id}:`, e.message);
            warnings.push(buildWarning('weights_pdf_failed', e.message));
        }
    }

    // Receipt PDF — per Apsara 2026-08-17 ("I want print option once pdf
    // generated... I want it to be pos dimension for printing"). Generated
    // here, alongside the other two, so the Print button is ready the
    // moment the rest of "Generate PDF" finishes — no separate click/round
    // trip needed. Best-effort same as the weights PDF: a render/upload
    // failure here shouldn't block the main ticket from counting as
    // generated.
    let receiptPatch = {};
    try {
        const receiptBuf = await generateLoadReceiptPdf(load, opts);
        const receiptFile = await uploadLoadPdf(load.id, receiptBuf, `receipt_${load.id}.pdf`);
        receiptPatch = { receipt_pdf_drive_id: receiptFile.id, receipt_pdf_link: receiptFile.webViewLink };
    } catch (e) {
        console.error(`[loadsPdf] receipt-pdf generation failed for ${load.id}:`, e.message);
        warnings.push(buildWarning('receipt_pdf_failed', e.message));
    }

    // pdf_template_version records WHICH layout produced this file, so a
    // later change can flag it as out of date rather than leaving the
    // operator to compare two tickets and guess which is right. See
    // PDF_TEMPLATE_VERSION in helpers/pdf.js.
    const loads = await updateLoad(load.id, { pdf_drive_id: file.id, pdf_link: file.webViewLink, status: 'pdf_generated', pdf_template_version: PDF_TEMPLATE_VERSION, pdf_generated_at: new Date().toISOString(), ...weightsPatch, ...receiptPatch });

    // The main ticket succeeded if we got here (a failure there throws), so
    // always clear its warnings — a successful Regenerate must wipe the
    // previous complaint, or the badge never goes away and stops meaning
    // anything. Sub-document warnings are then re-applied if they recurred.
    await clearLoadWarnings(load.id, ['pdf_generate_failed', 'pdf_upload_failed', 'weights_pdf_failed', 'receipt_pdf_failed']);
    if (warnings.length) {
        const withWarn = await setLoadWarnings(load.id, warnings);
        if (withWarn) return withWarn;
    }
    return loads.find(l => l.id === load.id) || null;
}

module.exports = { generateAndStoreLoadPdfs };
