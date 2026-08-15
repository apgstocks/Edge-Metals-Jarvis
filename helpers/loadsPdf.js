// ── helpers/loadsPdf.js — generate + upload + store a load's PDFs ────────────
// Pulled out of api.js's POST /api/loads/:id/generate-pdf route so the SAME
// generation pipeline can be reused by scheduler.js's end-of-day yard report
// (which needs to make sure every one of today's loads has PDFs before it
// can email/attach them) without duplicating this logic in two places and
// having them drift apart. The route itself now just calls this.
const { generateLoadPdf, generateWeightsPdf } = require('./pdf');
const { uploadLoadPdf } = require('./drive');
const { updateLoad } = require('./loads');

// Generates the priced ticket + the separate weights-only PDF for a load,
// uploads both to Drive, and patches the load record with the resulting
// links — returns the UPDATED load object. Mirrors the exact behavior the
// dashboard's "Generate PDF" button already triggers: the main ticket is
// required (a failure there throws), the weights PDF is best-effort (a
// failure there is logged and skipped, not fatal — the main ticket having
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
        }
    }

    const loads = await updateLoad(load.id, { pdf_drive_id: file.id, pdf_link: file.webViewLink, status: 'pdf_generated', ...weightsPatch });
    return loads.find(l => l.id === load.id) || null;
}

module.exports = { generateAndStoreLoadPdfs };
