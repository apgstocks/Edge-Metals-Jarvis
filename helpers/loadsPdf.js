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
// opts.kind ('sale' | 'purchase', default purchase) reaches the generators so a
// sale prints "SALE TICKET / Buyer:" and carries no signature line — see
// helpers/pdf.js. Storage is identical either way: same Drive folder, same
// pdf_link/pdf_drive_id fields, so every reader downstream keeps working
// without knowing which kind it is looking at.
async function generateAndStoreLoadPdfs(load, opts = {}) {
    // Payment status is looked up HERE rather than being passed in by each
    // caller. Every route and the scheduler's end-of-day report funnel through
    // this function, so doing it once means no caller can generate a ticket
    // that silently omits a payment — which is exactly what "on generating
    // invoice, this should get reflected" has to mean in practice.
    //
    // Best-effort: a failure to read the ledger must not stop a ticket being
    // produced. A ticket without the payment block is a lesser problem than no
    // ticket at all.
    let payment = opts.payment || null;
    if (!payment) {
        try {
            const { paymentSummary } = require('./payments');
            // A PURCHASE may carry a trucking deduction, so the "Paid X of Y"
            // block on the ticket has to measure against what the seller is
            // actually owed, not what the metal came to. A SALE cannot carry
            // one — netting haulage out of what a customer owes HER would be
            // an invention — so it keeps reading .amount. Named by kind rather
            // than left to payableOf's fallback: this is a deliberate
            // difference between the two documents, not an accident of which
            // store the record came from.
            payment = opts.kind === 'sale'
                ? paymentSummary(load.id, load.amount)
                : paymentSummary(load.id, require('./loads').payableOf(load));
        } catch (e) {
            console.warn('[LOADS-PDF] payment lookup failed, ticket will omit it:', e.message);
        }
    }
    const buf = await generateLoadPdf(load, { ...opts, payment });
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
            // `e`, not `e.message` — see describeError in loadWarnings.js. A
            // network failure to Drive arrives as an AggregateError whose
            // .message is '', so passing the message recorded nothing.
            const { describeError } = require('./loadWarnings');
            console.error(`[loadsPdf] weights-pdf failed for ${load.id}:`, describeError(e));
            warnings.push(buildWarning('weights_pdf_failed', e));
        }
    }

    // Receipt PDF — per Apsara 2026-08-17 ("I want print option once pdf
    // generated... I want it to be pos dimension for printing"). Generated
    // here, alongside the other two, so the Print button is ready the
    // moment the rest of "Generate PDF" finishes — no separate click/round
    // trip needed. Best-effort same as the weights PDF: a render/upload
    // failure here shouldn't block the main ticket from counting as
    // generated.
    //
    // ── GENERATING AND UPLOADING ARE SEPARATE FAILURES (2026-10-10) ──────
    // They shared one `try`, so "The POS receipt could not be generated"
    // was also what she saw when Drive was unreachable — and Drive is by
    // far the likelier of the two, because generating is pdfkit in this
    // process with no network and no browser. Her EDGE_130 warning sent
    // whoever read it looking at a renderer that had worked fine.
    let receiptPatch = {};
    let receiptBuf = null;
    try {
        receiptBuf = await generateLoadReceiptPdf(load, opts);
    } catch (e) {
        const { describeError } = require('./loadWarnings');
        console.error(`[loadsPdf] receipt-pdf RENDER failed for ${load.id}:`, describeError(e));
        warnings.push(buildWarning('receipt_pdf_failed', e));
    }
    if (receiptBuf) {
        try {
            const receiptFile = await uploadLoadPdf(load.id, receiptBuf, `receipt_${load.id}.pdf`);
            receiptPatch = { receipt_pdf_drive_id: receiptFile.id, receipt_pdf_link: receiptFile.webViewLink };
        } catch (e) {
            const { describeError } = require('./loadWarnings');
            console.error(`[loadsPdf] receipt-pdf UPLOAD failed for ${load.id}:`, describeError(e));
            warnings.push(buildWarning('receipt_upload_failed', e));
        }
    }

    // pdf_template_version records WHICH layout produced this file, so a
    // later change can flag it as out of date rather than leaving the
    // operator to compare two tickets and guess which is right. See
    // PDF_TEMPLATE_VERSION in helpers/pdf.js.
    await updateLoad(load.id, { pdf_drive_id: file.id, pdf_link: file.webViewLink, status: 'pdf_generated', pdf_template_version: PDF_TEMPLATE_VERSION, pdf_generated_at: new Date().toISOString(), ...weightsPatch, ...receiptPatch });

    // The main ticket succeeded if we got here (a failure there throws), so
    // always clear its warnings — a successful Regenerate must wipe the
    // previous complaint, or the badge never goes away and stops meaning
    // anything. Sub-document warnings are then re-applied if they recurred.
    // receipt_upload_failed belongs in this list for the same reason as the
    // rest: a code that is never cleared is a badge that never goes away.
    await clearLoadWarnings(load.id, ['pdf_generate_failed', 'pdf_upload_failed', 'weights_pdf_failed', 'receipt_pdf_failed', 'receipt_upload_failed']);
    if (warnings.length) {
        const withWarn = await setLoadWarnings(load.id, warnings);
        if (withWarn) return withWarn;
    }
    // ── RE-READ, DO NOT REUSE updateLoad'S ARRAY (2026-10-10) ───────────
    // Apsara: "when i try to print pos receipt,it is generating,but still
    // this error is showing in my load."
    //
    // updateLoad returns the store as it stood at ITS write — which is
    // BEFORE clearLoadWarnings ran. So a regenerate that fixed the problem
    // handed the client back a load still wearing the warning it had just
    // cleared on disk: the badge only went away on the next full reload,
    // and until then the screen said the receipt had failed while the
    // Print button happily opened it.
    //
    // Reading again after the clear costs one file read on a path that has
    // already generated up to three PDFs and talked to Drive three times.
    // The alternative — threading the cleared array through — makes the
    // return value depend on which of two writes happened last, which is
    // exactly the bug.
    const { getLoad } = require('./loads');
    return getLoad(load.id) || null;
}

module.exports = { generateAndStoreLoadPdfs };
