// routes/scans.js — split from api.js (helpers/sourceParts.js reconstructs the original)
const cfg = require('../config');
const express = require('express');
const { loadWorkflow, mutateJson } = require('../helpers/json');

module.exports = function (app, ctx) {
// @@chunk-start
    const largeJson = express.json({ limit: '40mb' });

    // Extract booking fields from an uploaded PDF (multimodal Gemini call)
    app.post('/api/documents/scan', largeJson, async (req, res) => {
        const { pdf_base64 } = req.body || {};
        if (!pdf_base64) return res.status(400).json({ error: 'pdf_base64 required' });

        try {
            const { extractPdfFields } = require('./helpers/gemini');
            const fields = await extractPdfFields(pdf_base64);
            if (!fields) return res.status(422).json({ error: 'could not extract fields from this PDF' });
            res.json({ ok: true, fields });
        } catch (err) {
            console.error('[API] scan failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── "12 Boxes x 110Lb", off a supplier's scale ticket ─────────────────
    // Apsara, 2026-09-22, on where the box figures should come from: both
    // typed and read off the ticket. This is the reading half.
    //
    // READ-ONLY AND STORES NOTHING. No file is kept, no record is written,
    // and the answer goes into two input boxes she confirms before any PDF
    // is rendered. A parser that wrote anything would be a parser whose
    // misreads outlive the moment she could have caught them.
    //
    // No Gemini, unlike /api/verify/zimex above: a scale ticket's boxes line
    // is a fixed shape, and a regex that fails loudly beats a model that
    // improvises a plausible box count onto a customs document.
    app.post('/api/packing/boxes-from-ticket', largeJson, async (req, res) => {
        try {
            const b64 = (req.body || {}).pdf_base64;
            if (!b64) return res.status(400).json({ found: false, why: 'No file was attached.' });
            const { boxesFromPdf } = require('./helpers/scaleTicketBoxes');
            // boxesFromPdf never throws for a business reason — an unreadable
            // PDF comes back as { found: false, why }. A 200 with found:false
            // is the honest shape here: the request worked, the ticket did
            // not say what we hoped.
            res.json(await boxesFromPdf(Buffer.from(String(b64), 'base64')));
        } catch (e) {
            console.error('[boxes-from-ticket] failed:', e && e.stack);
            res.status(500).json({ found: false, why: e.message });
        }
    });

    // Verification tab's Zimex sub-tab — Apsara: "build verification .in
    // that create sub tab as zimex". Body: { pdfs: [{name, base64}], year,
    // month }. Extracts HBL/amount records from each uploaded carrier
    // freight PDF (Gemini, same multimodal pattern as /api/documents/scan
    // above) then cross-checks every record against the Invoice sheet's own
    // Freight column — see helpers/invoiceVerify.js for the match/mismatch/
    // not_in_sheet logic and why year/month only scopes the reverse
    // "sheet_only" list. year/month are both optional; omit either to skip
    // that filter.
    app.post('/api/verify/zimex', largeJson, async (req, res) => {
        try {
            const { pdfs = [], year, month } = req.body || {};
            if (!Array.isArray(pdfs) || !pdfs.length) return res.status(400).json({ error: 'No PDFs provided.' });

            const { extractFreightInvoiceRecords } = require('./helpers/gemini');
            const { crossCheckZimexRecords } = require('./helpers/invoiceVerify');

            const extractedPerFile = await Promise.all(pdfs.map(async (pdf) => {
                try {
                    const extracted = await extractFreightInvoiceRecords(pdf.base64);
                    const records = (extracted && extracted.records) || [];
                    return records.map((r) => ({ ...r, source_file: pdf.name || 'unnamed.pdf' }));
                } catch (e) {
                    console.error(`[verify/zimex] extraction failed for ${pdf.name || 'unnamed.pdf'}:`, e.message);
                    // One bad/unreadable PDF in a batch shouldn't fail the whole
                    // run — surface it as its own row instead of losing it silently.
                    return [{ hbl_no: null, amount: null, description: `Extraction failed: ${e.message}`, source_file: pdf.name || 'unnamed.pdf', extraction_failed: true }];
                }
            }));
            const pdfRecords = extractedPerFile.flat();

            const result = await crossCheckZimexRecords(pdfRecords, { year, month });
            // ── AND WHAT IT WOULD PUT ON THE INVOICE ─────────────────────
            // Apsara, 2026-09-20, on where each verification's figures go:
            // "For transports, second tab of Bills.. For zimex - in freight
            // of invoice.." Zimex is ocean freight per HBL, not haulage, so
            // it is offered as a charge on the SALE row — never as a bill's
            // trucking. Different helper, different store, different key; see
            // helpers/freightProposal.js's header for why the two are not one
            // file.
            //
            // Never fails the verification, same reason as the truckers.
            try {
                result.sale_proposals = require('./helpers/freightProposal').proposals(result.matched);
            } catch (e) {
                console.error('[verify/zimex] freight proposals failed:', e.message);
                result.sale_proposals = [];
                result.sale_proposals_error = e.message;
            }
            res.json(result);
        } catch (e) {
            console.error('[verify/zimex] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/verify/panmetal', largeJson, async (req, res) => {
        try {
            const { pdfs = [] } = req.body || {};
            if (!Array.isArray(pdfs) || !pdfs.length) return res.status(400).json({ error: 'No PDFs provided.' });

            const { extractCommissionDebitNoteRecords } = require('./helpers/gemini');
            const { crossCheckPanMetalRecords } = require('./helpers/invoiceVerify');

            const extractedPerFile = await Promise.all(pdfs.map(async (pdf) => {
                try {
                    const extracted = await extractCommissionDebitNoteRecords(pdf.base64);
                    const records = (extracted && extracted.records) || [];
                    return records.map((r) => ({ ...r, source_file: pdf.name || 'unnamed.pdf' }));
                } catch (e) {
                    console.error(`[verify/panmetal] extraction failed for ${pdf.name || 'unnamed.pdf'}:`, e.message);
                    // One bad/unreadable PDF in a batch shouldn't fail the whole
                    // run — surface it as its own row instead of losing it silently.
                    return [{ order_no: null, commission: null, description: `Extraction failed: ${e.message}`, source_file: pdf.name || 'unnamed.pdf', extraction_failed: true }];
                }
            }));
            const pdfRecords = extractedPerFile.flat();

            const result = await crossCheckPanMetalRecords(pdfRecords);

            // Log post-comparison into the "Pan metal" tab of the Edge
            // Metals sheet (see helpers/panMetalSheetLog.js). Never let a
            // logging hiccup (sheet permissions, transient API error, etc.)
            // fail the verification response itself — the comparison
            // Apsara actually asked to see already succeeded above.
            try {
                const { logPanMetalVerification } = require('./helpers/panMetalSheetLog');
                result.sheet_log = await logPanMetalVerification(result.matched);
            } catch (e) {
                console.error('[verify/panmetal] sheet logging failed:', e.message);
                result.sheet_log = { logged: 0, error: e.message };
            }

            res.json(result);
        } catch (e) {
            console.error('[verify/panmetal] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/verify/jio', largeJson, async (req, res) => {
        try {
            const { pdfs = [] } = req.body || {};
            if (!Array.isArray(pdfs) || !pdfs.length) return res.status(400).json({ error: 'No PDFs provided.' });

            const { extractJioInvoiceRecords } = require('./helpers/gemini');
            const { crossCheckJioRecords } = require('./helpers/invoiceVerify');

            const extractedPerFile = await Promise.all(pdfs.map(async (pdf) => {
                try {
                    const extracted = await extractJioInvoiceRecords(pdf.base64);
                    const records = (extracted && extracted.records) || [];
                    return records.map((r) => ({ ...r, source_file: pdf.name || 'unnamed.pdf' }));
                } catch (e) {
                    console.error(`[verify/jio] extraction failed for ${pdf.name || 'unnamed.pdf'}:`, e.message);
                    // One bad/unreadable PDF in a batch shouldn't fail the whole
                    // run — surface it as its own row instead of losing it silently.
                    return [{ container_no: null, net_amount: null, description: `Extraction failed: ${e.message}`, source_file: pdf.name || 'unnamed.pdf', extraction_failed: true }];
                }
            }));
            const pdfRecords = extractedPerFile.flat();

            const result = await crossCheckJioRecords(pdfRecords);

            // Log post-comparison into the "Jio" tab of the Edge Metals
            // sheet (see helpers/jioSheetLog.js) — only rows that actually
            // verified (container found on our sheet) get written. Never
            // let a logging hiccup fail the verification response itself.
            try {
                const { logJioVerification } = require('./helpers/jioSheetLog');
                result.sheet_log = await logJioVerification(result.matched);
            } catch (e) {
                console.error('[verify/jio] sheet logging failed:', e.message);
                result.sheet_log = { logged: 0, error: e.message };
            }

            // ── AND WHAT IT WOULD PUT ON THE BILL ────────────────────────
            // Apsara, 2026-09-20: "that verified bill is not coming into
            // trucking of bills?" — it was not, and it should. Computed in
            // THIS response rather than stored: a proposal is about the run
            // that just happened, and a saved one would be a figure aging
            // quietly against a bill somebody has since edited.
            //
            // Never fails the verification. She ran this to check an invoice;
            // a fault in the offer that follows must not cost her the check.
            try {
                result.bill_proposals = require('./helpers/truckingProposal')
                    .proposals(result.matched, 'jio');
            } catch (e) {
                console.error('[verify/jio] bill proposals failed:', e.message);
                result.bill_proposals = [];
                result.bill_proposals_error = e.message;
            }

            res.json(result);
        } catch (e) {
            console.error('[verify/jio] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/verify/sher', largeJson, async (req, res) => {
        try {
            const { pdfs = [] } = req.body || {};
            if (!Array.isArray(pdfs) || !pdfs.length) return res.status(400).json({ error: 'No PDFs provided.' });

            const { extractSherTruckingInvoiceRecords } = require('./helpers/gemini');
            const { crossCheckSherRecords } = require('./helpers/invoiceVerify');

            const extractedPerFile = await Promise.all(pdfs.map(async (pdf) => {
                try {
                    const extracted = await extractSherTruckingInvoiceRecords(pdf.base64);
                    const records = (extracted && extracted.records) || [];
                    return records.map((r) => ({ ...r, source_file: pdf.name || 'unnamed.pdf' }));
                } catch (e) {
                    console.error(`[verify/sher] extraction failed for ${pdf.name || 'unnamed.pdf'}:`, e.message);
                    // One bad/unreadable PDF in a batch shouldn't fail the whole
                    // run — surface it as its own row instead of losing it silently.
                    return [{ booking_no: null, amount: null, description: `Extraction failed: ${e.message}`, source_file: pdf.name || 'unnamed.pdf', extraction_failed: true }];
                }
            }));
            const pdfRecords = extractedPerFile.flat();

            const result = await crossCheckSherRecords(pdfRecords);

            // Log post-comparison into the "Sher" tab of the Edge Metals
            // sheet (see helpers/sherSheetLog.js) — only rows where the
            // sheet's booking row-count matched the invoice's stated
            // quantity exactly get written. Never let a logging hiccup
            // fail the verification response itself.
            try {
                const { logSherVerification } = require('./helpers/sherSheetLog');
                result.sheet_log = await logSherVerification(result.matched);
            } catch (e) {
                console.error('[verify/sher] sheet logging failed:', e.message);
                result.sheet_log = { logged: 0, error: e.message };
            }

            // ── AND WHAT IT WOULD PUT ON THE BILL ────────────────────────
            // Apsara, 2026-09-20: "that verified bill is not coming into
            // trucking of bills?" — it was not, and it should. Computed in
            // THIS response rather than stored: a proposal is about the run
            // that just happened, and a saved one would be a figure aging
            // quietly against a bill somebody has since edited.
            //
            // Never fails the verification. She ran this to check an invoice;
            // a fault in the offer that follows must not cost her the check.
            try {
                result.bill_proposals = require('./helpers/truckingProposal')
                    .proposals(result.matched, 'sher');
            } catch (e) {
                console.error('[verify/sher] bill proposals failed:', e.message);
                result.bill_proposals = [];
                result.bill_proposals_error = e.message;
            }

            res.json(result);
        } catch (e) {
            console.error('[verify/sher] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ── GARDUNO'S LOGISTICS ──────────────────────────────────────────────
    // Apsara, 2026-10-04: "I want to upload all these invoices in Edge metals
    // trucking under gardunos like AJ Transport".
    //
    // The shape differs from AJ Transport's and that is why the work is split
    // in two. Garduno's bills one line per BOOKING with its containers listed
    // in the description, at a per-container rate, plus a SCALE TICKETS line
    // for the whole invoice. Turning that into one record per container is
    // arithmetic, so helpers/gardunosInvoice.expandInvoice() does it and
    // tests/gardunos-invoice.js runs it against her real invoice 169 — the
    // model is asked only to transcribe the table.
    //
    // CHARGES ONLY. Her decision, asked directly: the import creates what is
    // OWED and she records the payment herself on the Trucking screen. Invoice
    // 169 says "Paid in Full" and this route still writes no payment — a PDF
    // should not be able to decide that money left her account.
    app.post('/api/verify/gardunos', largeJson, async (req, res) => {
        try {
            const { pdfs = [] } = req.body || {};
            if (!Array.isArray(pdfs) || !pdfs.length) return res.status(400).json({ error: 'No PDFs provided.' });

            const { extractGardunosInvoiceRecords } = require('./helpers/gemini');
            const { expandInvoice } = require('./helpers/gardunosInvoice');
            const { crossCheckGardunosRecords } = require('./helpers/invoiceVerify');

            const perFile = await Promise.all(pdfs.map(async (pdf) => {
                const name = pdf.name || 'unnamed.pdf';
                try {
                    const extracted = await extractGardunosInvoiceRecords(pdf.base64);
                    const expanded = expandInvoice(extracted);
                    return {
                        source_file: name,
                        invoice: {
                            invoice_no: expanded.invoice_no, invoice_date: expanded.invoice_date,
                            invoice_total: expanded.invoice_total, revised: expanded.revised,
                            records_total: expanded.records_total, accounted: expanded.accounted,
                            reconciled: expanded.reconciled,
                            scale_total: expanded.scale_total, scale_applied: expanded.scale_applied,
                            // Said out loud on the response, not only in a log:
                            // "Paid in Full" is the single most likely thing to
                            // be misread as "already recorded".
                            balance_due: (extracted && extracted.balance_due) || 0,
                        },
                        warnings: expanded.warnings,
                        records: expanded.records.map((r) => ({
                            ...r,
                            invoice_no: expanded.invoice_no,
                            invoice_date: expanded.invoice_date,
                            source_file: name,
                        })),
                    };
                } catch (e) {
                    console.error(`[verify/gardunos] extraction failed for ${name}:`, e.message);
                    // One unreadable PDF must not lose the rest of the batch —
                    // the same rule the AJ Transport route follows.
                    return { source_file: name, invoice: null, warnings: [`Extraction failed: ${e.message}`],
                             records: [{ container_no: null, amount: null, source_file: name, extraction_failed: true,
                                         description: `Extraction failed: ${e.message}` }] };
                }
            }));

            const pdfRecords = perFile.flatMap((f) => f.records);
            const result = await crossCheckGardunosRecords(pdfRecords);

            // Per-invoice totals and warnings ride alongside the matched rows,
            // so the screen can show "this invoice did not add up" next to the
            // containers it produced rather than as a detached banner.
            // The same "put these on the bill" offer the other trucker tabs
            // make — renderBillProposals() in the client is generic over the
            // prefix, so the whole accept-into-trucking flow comes for free
            // once the server names the hauler. Never fails the verification:
            // she ran this to check an invoice, and a fault in the offer that
            // follows must not cost her the check.
            try {
                result.bill_proposals = require('./helpers/truckingProposal')
                    .proposals(result.matched, 'gardunos');
            } catch (e) {
                console.error('[verify/gardunos] bill proposals failed:', e.message);
                result.bill_proposals = [];
                result.bill_proposals_error = e.message;
            }

            result.invoices = perFile.map((f) => ({
                source_file: f.source_file, ...(f.invoice || {}), warnings: f.warnings,
            }));
            result.warnings = perFile.flatMap((f) => f.warnings.map((w) => `${f.source_file}: ${w}`));

            res.json(result);
        } catch (e) {
            console.error('[verify/gardunos] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ── EAGLE TRANS SHIPPING & LOGISTICS (EagleBrit) — ocean freight ─────
    // Apsara, 2026-10-07: "yes.build". VERIFY ONLY: reads the PDFs and checks the
    // containers against the Invoice sheet. It does not write to the sheet, a
    // bill or a sale — where Eagle's freight should land is hers to decide.
    app.post('/api/verify/eagle', largeJson, async (req, res) => {
        try {
            const { pdfs = [] } = req.body || {};
            if (!Array.isArray(pdfs) || !pdfs.length) return res.status(400).json({ error: 'No PDFs provided.' });
            const { extractEagleInvoiceRecords } = require('./helpers/gemini');
            const eagle = require('./helpers/eagleInvoice');
            const { crossCheckEagleRecords } = require('./helpers/invoiceVerify');
            const perFile = await Promise.all(pdfs.map(async (pdf) => {
                const name = pdf.name || 'unnamed.pdf';
                try {
                    const n = eagle.normalize(await extractEagleInvoiceRecords(pdf.base64), name);
                    return { record: n.record, warnings: n.warnings.map((w) => `${name}: ${w}`) };
                } catch (e) {
                    console.error(`[verify/eagle] extraction failed for ${name}:`, e.message);
                    return { record: { invoice_no: null, kind: 'invoice', containers: [], amount: null, source_file: name, extraction_failed: true }, warnings: [`${name}: extraction failed: ${e.message}`] };
                }
            }));
            const result = await crossCheckEagleRecords(perFile.map((f) => f.record));
            result.warnings = perFile.flatMap((f) => f.warnings);
            result.credits = eagle.pairCredits(result.matched);
            res.json(result);
        } catch (e) {
            console.error('[verify/eagle] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/verify/aj-transport', largeJson, async (req, res) => {
        try {
            const { pdfs = [] } = req.body || {};
            if (!Array.isArray(pdfs) || !pdfs.length) return res.status(400).json({ error: 'No PDFs provided.' });

            const { extractAjTransportInvoiceRecords } = require('./helpers/gemini');
            const { crossCheckAjTransportRecords } = require('./helpers/invoiceVerify');

            const extractedPerFile = await Promise.all(pdfs.map(async (pdf) => {
                try {
                    const extracted = await extractAjTransportInvoiceRecords(pdf.base64);
                    const records = (extracted && extracted.records) || [];
                    // invoice_no/invoice_date come back ONCE per PDF (one
                    // invoice, many container lines) — not per record, so
                    // stamp them onto every extracted line here.
                    return records.map((r) => ({
                        ...r,
                        invoice_no: (extracted && extracted.invoice_no) || null,
                        invoice_date: (extracted && extracted.invoice_date) || null,
                        source_file: pdf.name || 'unnamed.pdf',
                    }));
                } catch (e) {
                    console.error(`[verify/aj-transport] extraction failed for ${pdf.name || 'unnamed.pdf'}:`, e.message);
                    // One bad/unreadable PDF in a batch shouldn't fail the whole
                    // run — surface it as its own row instead of losing it silently.
                    return [{ container_no: null, amount: null, description: `Extraction failed: ${e.message}`, source_file: pdf.name || 'unnamed.pdf', extraction_failed: true }];
                }
            }));
            const pdfRecords = extractedPerFile.flat();

            const result = await crossCheckAjTransportRecords(pdfRecords);

            // Log post-comparison into the "AJ Transport" tab of the Edge
            // Metals sheet (see helpers/ajTransportSheetLog.js) — only
            // rows where the container matched AND the booking no. on file
            // agreed get written. Never let a logging hiccup fail the
            // verification response itself.
            try {
                const { logAjTransportVerification } = require('./helpers/ajTransportSheetLog');
                result.sheet_log = await logAjTransportVerification(result.matched);
            } catch (e) {
                console.error('[verify/aj-transport] sheet logging failed:', e.message);
                result.sheet_log = { logged: 0, error: e.message };
            }

            // ── AND WHAT IT WOULD PUT ON THE BILL ────────────────────────
            // Apsara, 2026-09-20: "that verified bill is not coming into
            // trucking of bills?" — it was not, and it should. Computed in
            // THIS response rather than stored: a proposal is about the run
            // that just happened, and a saved one would be a figure aging
            // quietly against a bill somebody has since edited.
            //
            // Never fails the verification. She ran this to check an invoice;
            // a fault in the offer that follows must not cost her the check.
            try {
                result.bill_proposals = require('./helpers/truckingProposal')
                    .proposals(result.matched, 'aj');
            } catch (e) {
                console.error('[verify/aj-transport] bill proposals failed:', e.message);
                result.bill_proposals = [];
                result.bill_proposals_error = e.message;
            }

            res.json(result);
        } catch (e) {
            console.error('[verify/aj-transport] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Upload PDF to Drive and (optionally) attach to a booking record
    app.post('/api/bookings/upload-pdf', largeJson, async (req, res) => {
        const { booking_number, pdf_base64, original_filename } = req.body || {};
        if (!booking_number) return res.status(400).json({ error: 'booking_number required' });
        if (!pdf_base64)     return res.status(400).json({ error: 'pdf_base64 required' });

        const bkg = String(booking_number).toUpperCase();
        try {
            const { uploadPdfToDrive } = require('./helpers/drive');
            const file = await uploadPdfToDrive(bkg, pdf_base64, original_filename);
            // Stamp the booking so the WhatsApp forward path knows a PDF exists
            await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
                if (all[bkg]) {
                    all[bkg].pdf_drive_id   = file.id;
                    all[bkg].pdf_uploaded_at = new Date().toISOString();
                }
                return all;
            });
            res.json({ ok: true, file });
        } catch (err) {
            console.error('[API] upload-pdf failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Workflow ──────────────────────────────────────────────────────────────
    app.get('/api/workflow', (req, res) => res.json(loadWorkflow()));

    // ── Yard scale tickets (standalone — not tied to bookings/workflow) ───────
    app.get('/api/scale-tickets', (req, res) => {
        try {
            const { loadScaleTickets } = require('./helpers/scaleTickets');
            res.json(loadScaleTickets());
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/scale-tickets/:id', (req, res) => {
        try {
            const { loadScaleTickets } = require('./helpers/scaleTickets');
            const ticket = loadScaleTickets().find(t => t.id === req.params.id);
            if (!ticket) return res.status(404).json({ error: 'not found' });
            res.json(ticket);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Vision: read a weight number off a scale-display photo ────────────────
    // Stateless — used by the dashboard's camera-capture buttons on the Add
    // New Load form BEFORE a load exists yet, so it can't be scoped to a
    // load id. largeJson (10mb) because base64 photos inflate ~33% over binary.
    app.post('/api/vision/read-weight', largeJson, async (req, res) => {
        const { image_base64, mime_type, pre_cropped, frames, live } = req.body || {};
        if (!image_base64) return res.status(400).json({ error: 'image_base64 required' });
        try {
            // frames: added 2026-08-27. The scanner now grabs several frames off
            // the live preview instead of one, and sends the extras here.
            //
            // image_base64 REMAINS the primary frame and remains required, so
            // the APK already on Apsara's phone — which knows nothing about
            // this field — keeps working byte-for-byte as before. frames is
            // purely additional evidence when a newer client sends it.
            //
            // Why extra frames and not more processing of one frame: measured
            // 2026-08-27, re-rendering the SAME pixels fails in correlated
            // ways (a greyscale pass reproduces the plain read's ghost digit
            // exactly), so it cannot corroborate the cases that actually go
            // wrong. Separate frames carry independent sensor noise, so two of
            // them agreeing is real evidence. The weight itself is static
            // while this happens, which is what makes the comparison valid.
            const extraFrames = Array.isArray(frames)
                ? frames.filter((f) => typeof f === 'string' && f.length > 100).slice(0, 4)
                : [];
            // pre_cropped: sent by the mobile app's guided scanner (2026-08-17)
            // when the user has already framed the display inside the on-screen
            // box, so the uploaded image IS the display. Lets the pipeline skip
            // its locate stage — see extractWeightFromImage's own comment. An
            // older client that doesn't send this field is simply undefined
            // here and gets the unchanged full-locate behavior.
            const { extractWeightFromImage } = require('./helpers/gemini');
            // live: a tick from the continuous scanner, which will ask again
            // in well under a second.
            //
            // fastOnly rather than a shorter budget, deliberately. A budget is
            // a hard cut — it abandons a read that is already running and can
            // return a half-finished answer. fastOnly instead never STARTS the
            // slow pipeline on a live frame, because that pipeline exists to
            // wring an answer out of a single image and this caller has a
            // stream of them. Nothing is interrupted; a frame that does not
            // read quickly just yields nothing and the next one is read
            // instead. Measured: unreadable frames cost 5.6s each on the full
            // path, which is the entire reason live scanning felt slow.
            const result = await extractWeightFromImage(image_base64, mime_type, undefined, {
                preCropped: !!pre_cropped,
                extraFrames,
                ...(live ? { fastOnly: true } : {}),
            });
            res.json({ ok: true, ...result });
        } catch (err) {
            console.error('[API] read-weight failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Vision: fast capture-time quality gate (no OCR, no Gemini call) ───────
    // Called by the mobile app immediately after a photo is taken, BEFORE the
    // (slower, more expensive) read-weight call above. Pixel-only, typically
    // under 500ms — see checkPhotoQuality's own comment in helpers/gemini.js
    // for why this exists and how it was validated.
    app.post('/api/vision/check-photo-quality', largeJson, async (req, res) => {
        const { image_base64, mime_type } = req.body || {};
        if (!image_base64) return res.status(400).json({ error: 'image_base64 required' });
        try {
            const { checkPhotoQuality } = require('./helpers/gemini');
            const result = await checkPhotoQuality(image_base64, mime_type);
            res.json({ ok: true, ...result });
        } catch (err) {
            console.error('[API] check-photo-quality failed:', err.message);
            res.json({ ok: true, reason: 'check_failed' }); // fail open — never block a real capture over this endpoint erroring
        }
    });

    // ── Loads (standalone — the dashboard's Add New Load feature) ─────────────
    // Accessible to staff/user/admin (see the staff-allowlist middleware above).
// @@chunk-end

    return { largeJson };
};
