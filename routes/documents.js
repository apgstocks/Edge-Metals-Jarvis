// routes/documents.js — split from api.js (helpers/sourceParts.js reconstructs the original)
const path = require('path');

module.exports = function (app, ctx) {
    const { actorOf, requireAdmin } = ctx;
// @@chunk-start
    const proformaPricing = require('./helpers/proformaPricing');
    const documentsSaved = require('./helpers/documentsSaved');
    const invoiceVersions = require('./helpers/invoiceVersions');

    // preview=1 (query string) returns the PDF inline without saving a copy
    // or touching pricing memory — used by the "Preview" button so a user
    // can check the layout before committing to a generation. Anything
    // else is a real generation: saves a copy to the flat proforma archive
    // and records/updates customer pricing memory from what was actually
    // typed, wrapped in try/catch per proformaPricing.js's own contract —
    // a pricing-memory failure must never break PDF generation.
    app.post('/api/proforma/generate', async (req, res) => {
        try {
            const body = req.body || {};
            const { generateProformaDc2Pdf } = require('./helpers/proformaPdf');
            const pdf = await generateProformaDc2Pdf(body);

            if (req.query.preview === '1') {
                res.set('Content-Type', 'application/pdf');
                res.set('Content-Disposition', 'inline; filename="proforma-preview.pdf"');
                return res.send(pdf);
            }

            const safeInv = documentsSaved.safeName(body.inv_no || 'PROFORMA').replace(/_+/g, '_');
            const filename = `${safeInv}_${(body.consignee || 'customer').toString().slice(0, 40).replace(/[^A-Za-z0-9_\- ]/g, '')}.pdf`.replace(/\s+/g, '_');
            const savedPath = documentsSaved.saveProformaCopy(pdf, filename);

            // ── THE FORM BEHIND THE FILE ────────────────────────────────────
            // Apsara, 2026-09-17: "copy option so that itwill get coppied to
            // proforma for say..". Copy needs the payload, and until now this
            // route archived the PDF and threw the payload away — so there was
            // nothing to copy from.
            //
            // Keyed on the name the file was ACTUALLY saved under, not the one
            // built above: saveProformaCopy basenames what it is given, and a
            // key that disagrees with the saved list is a Copy button that
            // finds nothing.
            //
            // Non-fatal, like the two calls below it. The proforma exists and
            // is filed by this point; losing a convenience must not cost her a
            // document.
            try {
                await require('./helpers/proformaVersions')
                    .saveProformaPayload(path.basename(savedPath), body);
            } catch (e) {
                console.error('[proforma] saving the form state failed (non-fatal):', e.message);
            }

            try {
                await proformaPricing.recordFromGeneration(
                    body.consignee || '',
                    body.trade_terms || '',
                    body.port_discharge || '',
                    (body.containers || []).flatMap((c) => c.items || []),
                    body.payment_term || '',
                );
            } catch (e) {
                console.error('[proforma] pricing-memory record failed (non-fatal):', e.message);
            }

            // Added per Apsara: "once proforma generated.i want a new sheet
            // called Edge Metals should be generated first time..." — logs
            // this generation into a Google Sheet (see
            // helpers/proformaSheetLog.js for the full column mapping and
            // reasoning). Non-fatal like the pricing-memory record above —
            // a Sheets/Drive hiccup should never block the PDF the person
            // is actually waiting on.
            let sheetLogResult = null;
            try {
                sheetLogResult = await require('./helpers/proformaSheetLog').logProformaToSheet(body);
            } catch (e) {
                console.error('[proforma] Edge Metals sheet log failed (non-fatal):', e.message);
            }

            res.json({ ok: true, saved_filename: path.basename(savedPath), sheet_log: sheetLogResult });
        } catch (e) {
            console.error('[proforma] generate failed:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ── BILL OF LADING ──────────────────────────────────────────────────
    // Apsara, 2026-09-15: "I want to create a BOL for edge metals with seller
    // as edge metals". EDGE METALS, NOT EDGE YARD — she corrected me on that
    // directly, after I started designing it against outbound loads.
    //
    // NOT in STAFF_ALLOWED_PATH_PREFIXES, deliberately and by omission, the
    // same as every other Edge Metals route. A BOL names the buyer, the
    // container and the weights of a shipment; it is the commercial side of
    // the business, which staff do not see.
    //
    // Shape mirrors /api/proforma/generate exactly: preview=1 streams the PDF
    // inline and saves nothing, otherwise a copy is filed and the filename
    // comes back. Same reason as there — she looks at it before it is real.
    app.post('/api/bol/generate', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const { generateBolPdf, buildBolHtml } = require('./helpers/bolPdf');

            // ── WHICH FIELDS THIS CUSTOMER'S BOL CARRIES ─────────────────
            // Apsara, 2026-09-16: "For different customer,i can have
            // different field in bol". Resolved HERE, from the consignee on
            // the document, rather than taken from the request — so a BOL
            // generated by the app, the website, or anything else gets the
            // layout she designed, and a client that has not been updated
            // cannot quietly print the wrong field set.
            //
            // A client MAY still send one (body.layout); it is ignored. The
            // layout is hers to set on the Design screen, not the caller's
            // to assert per document.
            const resolved = require('./helpers/bolLayouts').layoutFor(body.consignee_name);

            // ── THE NUMBER ───────────────────────────────────────────────
            // Apsara, 2026-09-16: "make bol number auto generate/customerbasis
            // in sequence" -> "include year in bol number as in 26ECC001".
            //
            // RESERVED HERE, not in the browser. The form shows a suggestion
            // the moment she picks a consignee, but nothing is consumed until
            // a document actually exists — and two screens open on the same
            // customer would otherwise be shown the same number, and
            // helpers/bols.js upserts by bol_no, so the second save would
            // REPLACE the first rather than sit beside it.
            //
            // A number she typed WINS ("Yours wins, counter untouched") and is
            // used exactly as typed. noteUsed only drags the counter forward
            // when what she typed is in this series and ahead of it, because
            // the alternative is suggesting a number that already exists.
            const bolNumbers = require('./helpers/bolNumbers');
            if (!String(body.bol_no || '').trim()) {
                try {
                    body.bol_no = await bolNumbers.reserve(body.consignee_name, body.bol_date);
                } catch (e) {
                    // A BOL with no number is still a document she can correct;
                    // a failed generate is a driver at a gate.
                    console.error('[bol] could not reserve a number (non-fatal):', e.message);
                }
            } else if (req.query.preview !== '1') {
                try { await bolNumbers.noteUsed(body.bol_no); }
                catch (e) { console.error('[bol] could not note the number used (non-fatal):', e.message); }
            }

            const withLayout = { ...body, layout: resolved.fields };

            // The weight check runs on the server too, not only in the
            // browser. The client shows these warnings before she clicks, but
            // the client is not the last word on anything — and they ride
            // back on the response so a BOL generated by any other caller
            // still reports that its net does not equal gross minus tare.
            // They are WARNINGS, never a rejection: she types the weights,
            // and a document that refuses to print because two numbers she
            // read off a scale ticket disagree is a document she stops using.
            let warnings = [];
            try { warnings = buildBolHtml(withLayout).warnings || []; } catch { /* generate below reports the real error */ }

            const pdf = await generateBolPdf(withLayout);

            if (req.query.preview === '1') {
                res.set('Content-Type', 'application/pdf');
                res.set('Content-Disposition', 'inline; filename="bol-preview.pdf"');
                return res.send(pdf);
            }

            // Filed under the BOL number and the consignee, so the archive
            // reads like a list of shipments rather than a list of hashes.
            const safeNo = documentsSaved.safeName(body.bol_no || 'BOL').replace(/_+/g, '_');
            const who = String(body.consignee_name || 'customer').slice(0, 40).replace(/[^A-Za-z0-9_\- ]/g, '');
            const filename = `${safeNo}_${who}.pdf`.replace(/\s+/g, '_');
            // The date the archive actually filed it under — today when she
            // left the BOL date blank. Returned below so the client can build
            // a download URL for THIS file rather than guessing the folder.
            // toLocaleDateString, not toISOString: the latter is UTC, so from
            // 7pm in Frisco a BOL with no date of its own would be filed in
            // TOMORROW's archive folder — and then not be where anyone looks
            // for it. Same rule as the clients now use for the date printed
            // on the document, so the folder and the paper agree.
            const savedDate = body.bol_date
                || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            const savedPath = documentsSaved.saveBolCopy(pdf, filename, savedDate);

            // ── AND THE FIELDS, SO IT CAN BE EDITED ──────────────────────
            // Apsara, 2026-09-16: "Edit Bol option also needed". Saving only
            // the PDF left nothing to reopen — see helpers/bols.js. Upserted
            // by BOL number, so correcting a typo and generating again
            // replaces the record rather than leaving two documents both
            // claiming to be EM-1047.
            //
            // Non-fatal, on purpose and for the same reason the proforma's
            // sheet log is: she is standing there waiting for a PDF, and a
            // failure to file the form data must not cost her the document.
            let record = null;
            try {
                record = await require('./helpers/bols').saveBol({
                    ...body,
                    created_by: req.role || null,
                    last_filename: path.basename(savedPath),
                    last_saved_date: savedDate,
                });
            } catch (e) {
                console.error('[bol] could not store the form fields (non-fatal):', e.message);
            }

            res.json({
                ok: true,
                saved_filename: path.basename(savedPath),
                saved_date: savedDate,
                // The number actually used, which is NOT always the one the
                // client sent: it posts a blank to mean "you choose". A
                // response that stayed silent about it would leave the form
                // showing an empty box for a document that has a number on it.
                bol_no: body.bol_no || '',
                id: record ? record.id : null,
                warnings,
            });
        } catch (e) {
            console.error('[bol] generate failed:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ── BOUGHT VS SOLD, FOR THE YARD ────────────────────────────────────
    // Apsara, 2026-09-16, choosing it off a list of reports she actually
    // opens: "Profit — bought vs sold". It existed nowhere before this.
    //
    // requireAdmin, like the spend report: this is every figure the business
    // turns on, and staff keep Loads and the cash balance.
    //
    // EDGE YARD ONLY. Edge Metals has its own margin and the two must never
    // be added together. See helpers/yardProfit.js for why the obvious
    // "sold this month minus bought this month" is the wrong number and what
    // is reported instead.
    app.get('/api/reports/yard-profit', requireAdmin, (req, res) => {
        try {
            res.json(require('./helpers/yardProfit').yardProfit({
                from: req.query.from || null,
                to: req.query.to || null,
            }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── WHICH ITEM NAMES MEAN THE SAME METAL ────────────────────────────
    // Apsara, 2026-09-16: "Warn me if al combo and aluminium combo,remember
    // my selection-then next time let ai decide based on knowldge".
    //
    // GET  asks the question (the model proposes; nothing is joined)
    // POST records HER answer, yes or no — both are remembered, because a
    //      store that only keeps agreement turns into a nagging machine and
    //      the prompt that matters gets clicked through with the rest.
    app.get('/api/item-aliases', requireAdmin, (req, res) => {
        try {
            const a = require('./helpers/itemAliases');
            res.json({ ok: true, aliases: a.list(), conflicts: a.conflicts() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/item-aliases/suggest', requireAdmin, async (req, res) => {
        try {
            const unknown = String(req.query.item || '').trim();
            if (!unknown) return res.json({ ask: false, why: 'empty' });
            // Candidates are the descriptions that actually CAME IN — a
            // suggestion must name something she could really have in stock.
            const { loadLoads } = require('./helpers/loads');
            const known = [...new Set(loadLoads()
                .flatMap((l) => (Array.isArray(l.items) ? l.items : []))
                .map((it) => String((it && it.description) || '').trim())
                .filter(Boolean))];
            const out = await require('./helpers/itemMatch').suggestItemMatch(unknown, known);
            res.json(out);
        } catch (e) {
            // Never fatal: an unanswered question is a row left visibly
            // unmatched, which is recoverable. A 500 here would look like the
            // sale failed.
            console.error('[item-aliases] suggest failed (non-fatal):', e.message);
            res.json({ ask: false, why: 'error' });
        }
    });

    app.post('/api/item-aliases', requireAdmin, async (req, res) => {
        try {
            const b = req.body || {};
            if (!String(b.a || '').trim() || !String(b.b || '').trim()) {
                return res.status(400).json({ error: 'two item descriptions are required' });
            }
            // source is forced to 'user' — this route exists because SHE
            // answered. An AI verdict is never settled (see itemAliases.js),
            // and letting a client claim otherwise would make one wrong guess
            // permanent with nobody ever asked.
            const saved = await require('./helpers/itemAliases')
                .remember(b.a, b.b, b.same === true, { by: req.role || null, source: 'user', note: b.note || null });
            if (!saved) return res.status(400).json({ error: 'those are the same text, or empty' });
            res.json({ ok: true, alias: saved });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/item-aliases', requireAdmin, async (req, res) => {
        try {
            const removed = await require('./helpers/itemAliases').forget(req.query.a, req.query.b);
            res.json({ ok: true, removed });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── SAVED BILLS OF LADING ───────────────────────────────────────────
    // Apsara, 2026-09-16: "Edit Bol option also needed". The list is a list —
    // enough to recognise a document and no more; GET /:id returns the whole
    // record for loading back into the form.
    //
    // requireAdmin like the generate route: a BOL names the buyer, the
    // container and the weights of a shipment, which is the commercial side
    // of the business and not staff's.
    // ── PER-CUSTOMER BOL LAYOUTS ─────────────────────────────────────────
    // Apsara, 2026-09-16: "For different customer,i can have different field
    // in bol .. make the fields drag and drop in website as Design menu then
    // under it BOL". See helpers/bolLayouts.js for what a layout may and may
    // not change, and why it is stored here rather than in the browser.
    //
    // requireAdmin, matching every other BOL route. Staff never reach this
    // file's Edge Metals document routes at all (STAFF_ALLOWED_PATH_PREFIXES).
    app.get('/api/bol-layouts', requireAdmin, (req, res) => {
        try {
            const L = require('./helpers/bolLayouts');
            res.json({
                ok: true,
                // The catalogue rides along so the Design screen does not keep
                // its own copy of the field list. Two lists of fields, one in
                // a helper and one hand-typed into a page, drift the first
                // time a field is added — and the drift shows up as a field
                // she can switch on that never prints.
                optional: L.OPTIONAL_FIELDS.map((f) => ({ key: f.key, label: f.label })),
                required: L.REQUIRED_FIELDS,
                custom_prefix: L.CUSTOM_PREFIX,
                layouts: L.listLayouts(),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // The layout that WOULD be used for a given customer, and where it came
    // from ('customer', 'default' or 'built-in'). Both BOL forms call this
    // when a consignee is picked, and the Design screen calls it to fill the
    // editor. `source` is returned so a screen can say "this customer has no
    // layout of their own" instead of implying one exists.
    app.get('/api/bol-layouts/resolve', requireAdmin, (req, res) => {
        try {
            res.json({ ok: true, ...require('./helpers/bolLayouts').layoutFor(req.query.customer || '') });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.put('/api/bol-layouts', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            if (!Array.isArray(body.fields)) return res.status(400).json({ error: 'fields must be a list' });
            // sanitise() inside saveLayout drops anything unrecognised and
            // re-appends catalogue fields the client left out, so a client one
            // version behind cannot delete a field it has never heard of.
            const saved = await require('./helpers/bolLayouts').saveLayout(body.customer || '', body.fields);
            res.json({ ok: true, layout: saved });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Removes a customer's own layout so they fall back to the default. NOT
    // a destructive act on any document: BOLs already generated keep the
    // fields they were printed with, because the PDF is a file on disk.
    app.delete('/api/bol-layouts', requireAdmin, async (req, res) => {
        try {
            const customer = String(req.query.customer || '').trim();
            if (!customer) return res.status(400).json({ error: 'the default layout cannot be deleted, only edited' });
            const removed = await require('./helpers/bolLayouts').deleteLayout(customer);
            if (!removed) return res.status(404).json({ error: 'no layout for that customer' });
            res.json({ ok: true, note: 'that customer now uses the default layout' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── PACKING LISTS ────────────────────────────────────────────────────
    // Apsara, 2026-09-16: "in edge metals,i want to create a sub tab under
    // invoice -documents as packing list.it should allow to upload photo/pdf,
    // it scan and fill fields and then create fields like container nuber,
    // booking no,invoice number,rows and columns of items."
    //
    // EDGE METALS. requireAdmin like every other document route; staff never
    // reach this file's Edge Metals routes at all.
    //
    // ── SCAN AND SAVE ARE SEPARATE ROUTES, ON PURPOSE ────────────────────
    // /scan reads a file and returns fields. It writes NOTHING. Saving is a
    // second, explicit request she makes after looking at what came back.
    // One route that scanned and filed would produce a drawer of documents
    // nobody has read, and the first wrong container number would be found by
    // a customer rather than by her.
    app.post('/api/packing-lists/scan', requireAdmin, async (req, res) => {
        try {
            const b = req.body || {};
            const base64 = String(b.file_base64 || '').replace(/^data:[^;]+;base64,/, '');
            if (!base64) return res.status(400).json({ error: 'no file' });
            // Size-capped before it reaches the model. A 40MB phone photo is a
            // slow request and a large bill, and the cap is a sentence she can
            // act on rather than a timeout she cannot.
            if (base64.length > 28 * 1024 * 1024) {
                return res.status(413).json({ error: 'That file is too big — under 20MB, please.' });
            }
            const out = await require('./helpers/packingList').scan(base64, b.mime_type || 'application/pdf');
            res.json(out);
        } catch (e) {
            // Fail soft: she is left with an empty form she can type into,
            // which is where she would be without this feature at all.
            console.error('[packing-list] scan route failed:', e.message);
            res.json({ ok: false, error: 'Could not read that file. Fill the form in by hand.', fields: null });
        }
    });

    app.get('/api/packing-lists', requireAdmin, (req, res) => {
        try { res.json({ ok: true, packing_lists: require('./helpers/packingList').list() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/packing-lists/:id', requireAdmin, (req, res) => {
        try {
            const rec = require('./helpers/packingList').get(req.params.id);
            if (!rec) return res.status(404).json({ error: 'no such packing list' });
            res.json({ ok: true, packing_list: rec });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/packing-lists', requireAdmin, async (req, res) => {
        try {
            const b = req.body || {};
            // A packing list with no container and no rows is an empty form
            // saved by accident. Refused with a sentence rather than stored,
            // because a drawer of blanks makes the real ones harder to find.
            if (!String(b.container_no || '').trim() && !(Array.isArray(b.rows) && b.rows.length)) {
                return res.status(400).json({ error: 'A packing list needs at least a container number or one item line.' });
            }
            const pl = require('./helpers/packingList');
            const saved = await pl.save({ ...b, created_by: req.role || null });
            // Checked on SAVE too, not only on Generate. A packing list she
            // files and never prints can still disagree with its invoice, and
            // the moment she is looking at it is the moment to say so.
            res.json({ ok: true, packing_list: saved, warnings: pl.compareToInvoice(saved) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── GENERATE THE PDF ─────────────────────────────────────────────────
    // Apsara, 2026-09-16, on what the tab should do: "Scan ,fill data auto and
    // generate pdf."
    //
    // Renders the SAME document the invoice's "Separate invoice & packing
    // list" flag produces — see helpers/packingList.js's generatePdf for why
    // it borrows the invoice header rather than asking her to retype it, and
    // why it refuses rather than printing a headerless page.
    app.post('/api/packing-lists/generate', requireAdmin, async (req, res) => {
        try {
            const pl = require('./helpers/packingList');
            const body = req.body || {};
            // Generated from what is ON SCREEN, not from what is stored: she
            // may have corrected a scanned figure and not saved yet, and a
            // Generate that quietly printed the older stored version would be
            // the worst kind of surprise on a document going to a customer.
            const rec = pl.buildRecord(body, null);
            // ── HER OVERRIDE ────────────────────────────────────────────────
            // Apsara, 2026-09-17: "it should not restrict me from generating
            // packing list without invoice. just show warning and ask to
            // override. on accept, proceed".
            //
            // Absent or false, generatePdf refuses exactly as it always has —
            // the client asks first and only sends this once she has said yes,
            // so the warning cannot be skipped by accident. Accepted from the
            // query string as well as the body because the PREVIEW call is a
            // form post that opens a tab.
            const allowWithoutInvoice = body.allow_without_invoice === true
                || body.allow_without_invoice === 'true'
                || req.query.allow_without_invoice === '1';
            const pdf = await pl.generatePdf(rec, { allowWithoutInvoice });

            // The cross-check rides back on the same response rather than
            // needing a second call — she is looking at the result right now,
            // which is the moment a disagreement is worth raising.
            const warnings = pl.compareToInvoice(rec);
            // Said on the RESULT too, not only in the dialog she clicked
            // through. She may generate several in a row, and "which of these
            // went out without an invoice behind it" is a question she will
            // have later, when the dialog is long gone.
            if (allowWithoutInvoice
                && !require('./helpers/invoiceVersions').getLatestInvoicePayload(rec.container_no)) {
                // ── SAME SHAPE AS EVERY OTHER WARNING ───────────────────
                // compareToInvoice yields { message } objects and the screen
                // renders w.message. A plain string here rendered as nothing
                // at all — the notice was silently dropped. Caught by the
                // screen test, not by reading this line.
                warnings.unshift({
                    kind: 'no_invoice',
                    message: `${rec.container_no} has no invoice on file, so the buyer details and invoice number come from this form only.`,
                });
            }

            if (req.query.preview === '1') {
                res.set('Content-Type', 'application/pdf');
                res.set('Content-Disposition', 'inline; filename="packing-list-preview.pdf"');
                return res.send(pdf);
            }

            const safe = documentsSaved.safeName(rec.container_no || 'PACKING').replace(/_+/g, '_');
            const savedDate = rec.date
                || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            // Filed in the invoice archive alongside the invoice it belongs
            // to, under the same container. saveInvoiceCopy's signature is
            // (buffer, filename, containerNo, dateStr) — getting that order
            // wrong files the document under a date-shaped container.
            const savedPath = documentsSaved.saveInvoiceCopy(
                pdf, `${safe}_packing.pdf`, rec.container_no, savedDate);

            // saved_container rides back with the filename and the date
            // because all THREE are needed to find the file again through
            // /api/documents/download (kind=invoice files under
            // <date>/<container>/). The client has a container in its form,
            // but buildRecord trims it — handing back what was actually used
            // to write the file is the difference between a download that
            // works and one that 404s on a trailing space.
            res.json({
                ok: true,
                saved_filename: path.basename(savedPath),
                saved_date: savedDate,
                saved_container: rec.container_no,
                warnings,
            });
        } catch (e) {
            // NO_INVOICE / NO_CONTAINER / NO_ROWS all carry a sentence she can
            // act on; anything else is a real failure and says so.
            const known = ['NO_INVOICE', 'NO_CONTAINER', 'NO_ROWS'].includes(e.code);
            // can_override tells the client this one is a QUESTION, not a
            // dead end — it is what turns the refusal into "Generate anyway?".
            // Only NO_INVOICE sets it: a packing list with no container number
            // genuinely cannot be filed or found again, so that one stays a
            // refusal.
            res.status(known ? 400 : 500).json({
                error: e.message,
                code: e.code || null,
                can_override: e.canOverride === true,
            });
        }
    });

    app.delete('/api/packing-lists/:id', requireAdmin, async (req, res) => {
        try {
            const pl = require('./helpers/packingList');
            const audit = require('./helpers/audit');
            const doomed = pl.get(req.params.id);
            if (!doomed) return res.status(404).json({ error: 'no such packing list' });
            // Recorded before the act and stamped after, the same as the BOL
            // delete. Which container's list went, and who removed it,
            // outlives the record.
            const entry = await audit.record({
                action: 'delete-packing-list', subject: String(req.params.id),
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { container_no: doomed.container_no, booking_no: doomed.booking_no,
                          invoice_no: doomed.invoice_no, lines: (doomed.rows || []).length },
            });
            const removed = await pl.remove(req.params.id);
            await audit.complete(entry, removed ? 'done' : 'failed', {});
            if (!removed) return res.status(404).json({ error: 'no such packing list' });
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // What the form should put in the box when she picks a consignee.
    // A SUGGESTION ONLY — nothing is reserved until a document is generated,
    // because a number consumed by opening a screen leaves a gap in a series
    // a buyer can see. /api/bol/generate does the reserving.
    // ── WHERE THE SECONDS GO ────────────────────────────────────────────
    // Apsara, 2026-09-16: "why invoice and bol takes more time to generate?"
    //
    // Every generate logs one [PDF-TIME] line to pm2; this is the same data
    // without needing shell access, plus a rollup by document kind, which is
    // the shape that actually answers the question: not "that one took 4s" but
    // "launching Chromium is 60% of every document".
    //
    // In memory and capped at the last fifty. Admin-only for no security
    // reason beyond consistency — it holds document numbers and durations,
    // nothing else.
    app.get('/api/pdf-timings', requireAdmin, (req, res) => {
        try {
            const t = require('./helpers/pdfTiming');
            res.json({ summary: t.summary(), recent: t.recent(Number(req.query.n) || 20) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/bols/next-number', requireAdmin, (req, res) => {
        try {
            const n = require('./helpers/bolNumbers');
            res.json({ bol_no: n.suggest(req.query.customer, req.query.date),
                       code: n.codeFor(req.query.customer) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/bols', requireAdmin, (req, res) => {
        try { res.json({ ok: true, bols: require('./helpers/bols').listBols() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/bols/:id', requireAdmin, (req, res) => {
        try {
            const rec = require('./helpers/bols').getBol(req.params.id);
            if (!rec) return res.status(404).json({ error: 'no such bill of lading' });
            res.json({ ok: true, bol: rec });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // Removes the FORM record, not the PDF. Said plainly in the response
    // because the two are different things and a delete that silently took
    // the archived document with it would be a surprise: the copy that was
    // handed to a driver stays in documents_saved/bol/.
    //
    // AUDITED, added 2026-09-16 when Apsara asked for the delete button that
    // exposes this route ("also add delete option in bol generated"). The
    // route itself predates her "Log every deletion" decision and was the
    // only delete in this file still writing no trace. A bill of lading is a
    // document that was handed to a driver; which of them was removed, by
    // whom, is worth more than the record itself.
    //
    // Recorded BEFORE the delete and stamped after — the order this project
    // uses everywhere, so a crash mid-delete still leaves the intent on file.
    app.delete('/api/bols/:id', requireAdmin, async (req, res) => {
        try {
            const bols = require('./helpers/bols');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);

            // Read it first: after the delete there is nothing left to
            // describe, and "deleted bol 7f3a" tells her nothing she can use.
            const doomed = bols.getBol(id);
            if (!doomed) return res.status(404).json({ error: 'no such bill of lading' });

            const entry = await audit.record({
                action: 'delete-bol', subject: id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: {
                    bol_no: doomed.bol_no, bol_date: doomed.bol_date,
                    consignee_name: doomed.consignee_name, container_no: doomed.container_no,
                    generated_count: doomed.generated_count,
                    last_filename: doomed.last_filename,
                },
            });

            const removed = await bols.deleteBol(id);
            if (!removed) {
                await audit.complete(entry, 'failed', { reason: 'bill of lading not found' });
                return res.status(404).json({ error: 'no such bill of lading' });
            }
            await audit.complete(entry, 'done', {});
            res.json({ ok: true, removed, note: 'the saved PDF is kept' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Added per Apsara: auto-suggest the next invoice number for a selected
    // consignee, derived from her REAL historical numbers in the Invoice
    // Google Sheet (see helpers/nextInvoiceNo.js for the full reasoning —
    // matching strategy, year-prefix behavior, etc. were confirmed with her
    // directly against live sheet data, not guessed). Returns {} (not a 404)
    // when there's no usable history for that consignee, so the client can
    // fall back to manual entry the same way it always has.
    app.get('/api/proforma/next-inv-no', async (req, res) => {
        try {
            const suggestion = await require('./helpers/nextInvoiceNo').suggestNextInvNo(req.query.consignee || '');
            res.json(suggestion || {});
        } catch (e) {
            console.error('[proforma] next-inv-no lookup failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ── Commercial Invoice ────────────────────────────────────────────────
    // Added per Apsara: "build invoice now.similar to proforma ask me who is
    // the buyer.then follow python anywhere invoice flow" — see
    // helpers/invoiceSheet.js for the sourcing/mapping notes (including the
    // stale-column-index caveat found while building this) and
    // helpers/invoicePdf.js for the PDF itself. Same deny-by-default
    // staff gate as everything else in this Documents block — not added to
    // STAFF_ALLOWED_PATH_PREFIXES.
// @@chunk-end

    return { proformaPricing, documentsSaved, invoiceVersions };
};
