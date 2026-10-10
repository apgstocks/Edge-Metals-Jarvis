// routes/invoices.js — split from api.js (helpers/sourceParts.js reconstructs the original)
const path = require('path');

module.exports = function (app, ctx) {
    const { documentsSaved, invoiceVersions, proformaPricing, requireAdmin } = ctx;
// @@chunk-start
    const invoiceSheet = require('./helpers/invoiceSheet');

    // Step 1 of the buyer-first flow: every container on record for a buyer,
    // most recent first, so she can pick which shipment to invoice.
    app.get('/api/invoice/by-buyer', async (req, res) => {
        try {
            const containers = await invoiceSheet.findContainersForBuyer(req.query.buyer || '');
            res.json({ containers });
        } catch (e) {
            console.error('[invoice] by-buyer lookup failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Search by container number directly — the ONLY lookup her original
    // PythonAnywhere tool had (invoice_gen.py's --container flag), added
    // back here as a second path alongside the buyer-first flow above, per
    // Apsara: "search by container number". Same summary shape as
    // by-buyer so the Step 2 pick-list renders identically either way.
    app.get('/api/invoice/by-container', async (req, res) => {
        try {
            const containers = await invoiceSheet.findContainersByNumber(req.query.q || '');
            res.json({ containers });
        } catch (e) {
            console.error('[invoice] by-container lookup failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Sibling of by-container: finds the same container rows, but keyed on
    // the Inv No.'s trailing segment. Apsara, 2026-08-22: "SEARCH BY INV NO.
    // MULTI ENTRY SUPPORT. IT SHOULD BE LAST PART AFTER _." Returns the
    // identical { containers } shape so the dashboard reuses one renderer and
    // one downstream select/preview/generate flow for both searches.
    app.get('/api/invoice/by-inv-no', async (req, res) => {
        try {
            const containers = await invoiceSheet.findContainersByInvNo(req.query.q || '');
            res.json({ containers });
        } catch (e) {
            console.error('[invoice] by-inv-no lookup failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Preview for SEVERAL containers merged into one invoice — used when a
    // multi-select batch on Step 2 has containers sharing a booking #. Per
    // Apsara: "if both containers belong to the same booking, it should get
    // generated in same invoice". See helpers/invoiceSheet.js's
    // buildMultiContainerInvoiceData() for how Container #/Seal # end up
    // per-line-item instead of one shared top-level value.
    app.get('/api/invoice/preview-multi', async (req, res) => {
        try {
            const containers = String(req.query.containers || '').split(',').map((s) => s.trim()).filter(Boolean);
            if (!containers.length) return res.status(400).json({ error: 'No containers specified.' });
            const data = await invoiceSheet.buildMultiContainerInvoiceData(containers);
            if (!data) return res.status(404).json({ error: `None of the containers [${containers.join(', ')}] were found in the Invoice sheet.` });
            res.json(data);
        } catch (e) {
            console.error('[invoice] preview-multi failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Step 2: full computed preview for one chosen container — every field
    // editable client-side before generating, same "never send a real
    // invoice without a human look" principle the old Flask tool's
    // generate.html already used.
    app.get('/api/invoice/preview', async (req, res) => {
        try {
            const data = await invoiceSheet.buildContainerInvoiceData(req.query.container || '');
            if (!data) return res.status(404).json({ error: `Container '${req.query.container}' not found in the Invoice sheet.` });
            res.json(data);
        } catch (e) {
            console.error('[invoice] preview failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Step 3: generate + save the PDF from the (possibly hand-edited)
    // preview data the client sends back. preview=1 returns the PDF inline
    // without archiving a copy, same convention as /api/proforma/generate.
    app.post('/api/invoice/generate', async (req, res) => {
        try {
            const body = req.body || {};
            const { generateInvoiceClassicPdf } = require('./helpers/invoicePdf');

            // ── separate ────────────────────────────────────────────────────
            // Apsara, 2026-09-09: "Use seprate flag." Off by default, so an
            // existing client that does not send it gets the combined PDF it
            // has always got. The old Flask tool used the same field name.
            // ── invoice only ────────────────────────────────────────────────
            // Apsara, 2026-09-16: "add a checkbox called invoice only in
            // invoice of documents". The invoice alone, no packing list in the
            // PDF and no second file.
            //
            // Checked BEFORE separate and wins over it: the two are a
            // contradiction, and the safe reading of a contradiction is the
            // narrower one — she gets fewer documents than she expected rather
            // than a packing list she asked not to send.
            const invoiceOnly = body.invoice_only === true || body.invoice_only === 'true';
            const separate = !invoiceOnly && (body.separate === true || body.separate === 'true');

            // ── DOES THE QUANTITY AGREE WITH THE WEIGHTS ON THE SAME ROW? ───
            // Apsara, 2026-09-19: 260918_AP_26ARIS02 went to the buyer stating
            // 15,642 MT where her own packing list says 7.095 — pounds in the
            // MT column, on a customs document. Every figure needed to catch
            // it was already on the row; nothing compared them. See
            // helpers/invoiceWeights.js.
            //
            // REFUSED, not warned. A warning on the screen is a warning she
            // can be past before she has read it, and the cost here is a
            // corrected invoice to a buyer and a broker.
            //
            // ── weights_ok IS A NEW REQUIRED ANSWER, SO: WHO CALLS THIS? ────
            // dashboard/documents.html and mobile-app/www/index.html. That is
            // the whole list — grepped, every hit opened — and BOTH send it,
            // so there is no caller left holding a requirement it cannot
            // satisfy. That check is here in writing because skipping it on
            // 2026-09-17 is what broke recording a wire payment by voice: the
            // one caller with no form to put a field on.
            //
            // There is no voice or assistant path to this route. If one is
            // ever added it must be able to answer this question before it
            // ships, not after.
            const invoiceWeights = require('./helpers/invoiceWeights');
            const weightProblems = invoiceWeights.weightProblems(body.line_items, body.units);
            if (weightProblems.length && body.weights_ok !== true && body.weights_ok !== 'true') {
                return res.status(409).json({
                    error: invoiceWeights.refusalMessage(weightProblems),
                    code: 'WEIGHT_MISMATCH',
                    problems: weightProblems,
                });
            }

            const out = await generateInvoiceClassicPdf(body, { separate, invoiceOnly });

            if (req.query.preview === '1') {
                // Preview is a single inline PDF by construction — a browser
                // tab cannot show two. Previewing the INVOICE half is the
                // right choice: it is the document with the money on it, and
                // the packing list is derived from the same rows.
                const one = separate ? out.invoice : out;
                res.set('Content-Type', 'application/pdf');
                res.set('Content-Disposition', 'inline; filename="invoice-preview.pdf"');
                return res.send(one);
            }

            return res.json(await saveGeneratedInvoice(out, body, { separate, invoiceOnly }));
        } catch (e) {
            console.error('[invoice] generate failed:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ── EMAILING WHAT THE DOCUMENTS TAB JUST GENERATED ────────────────────
    //
    // Apsara, 2026-09-23: "ADD SEND MAIL BUTTON IN INVOICE POST GENERATION".
    //
    // TWO STOPS, NOT ONE, and that is not me being cautious for its own sake.
    // Sending is the single action on this screen that cannot be taken back,
    // and this is the screen where 260831_SU_26EM05 was made — an invoice
    // that billed $13.09 for a container worth $28,860.80. It is also the
    // shape she chose for the Sale row on 2026-09-19 and has been using
    // since: read the real message, addressed to the real people, with the
    // real files named, THEN press Send. A one-click send would be faster
    // exactly once and wrong exactly once.
    //
    // ── KEYED BY CONTAINER, BECAUSE THIS SCREEN HAS NO SALE ───────────────
    // /api/sales/:id/invoice/draft-mail and /send do this already, but they
    // need a sale row and the Documents tab is a typed form with no id. Both
    // of these reach the SAME helpers — shipmentMail.draftFor,
    // shipmentDocs.attachmentsFor, gmail.sendEmail — rather than restating
    // any of it. draftFor has always taken a container; nothing new was
    // needed to address a message, only a route that has no sale to offer.
    //
    // WHAT GETS ATTACHED is what is on disk for that container, which is what
    // Generate has just put there. Deliberately not a list of filenames from
    // the browser: a client that names its own attachments is a client that
    // can attach last week's invoice to this week's email.
    const invoiceMailDraft = (req) => {
        const shipmentMail = require('./helpers/shipmentMail');
        const container = String(req.query.container || (req.body || {}).container || '').trim();
        const recipients = req.query.recipients || (req.body || {}).recipients || null;
        // The buyer as typed on the form, so a container whose document
        // history has no consignee still resolves — same fallback the sale
        // route makes, for the same reason.
        const consignee = String(req.query.consignee || (req.body || {}).consignee || '').trim() || null;

        // The loading photos live on the BILL for that container. Looked up
        // here rather than asked of the browser, so the email carries the
        // same links the Sale-row path sends.
        let photos = [];
        try {
            const bills = require('./helpers/bills');
            const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();
            const bill = (bills.list() || []).find((b) => norm(b.container_no) === norm(container));
            if (bill) photos = require('./helpers/saleInvoice').photosFor(bill) || [];
        } catch (e) { photos = []; }

        let draft = shipmentMail.draftFor(container, { photos, recipients });
        if (!draft.ok && draft.reason === 'no_customer' && consignee) {
            const retry = shipmentMail.draftFor(container, { photos, recipients, consignee });
            if (retry.ok || retry.reason !== 'no_customer') draft = retry;
        }
        return draft;
    };

    // Stop one. READ ONLY — it looks at what is on disk and at the address
    // book, and sends nothing.
    app.get('/api/invoice/draft-mail', requireAdmin, (req, res) => {
        try {
            res.json(invoiceMailDraft(req));
        } catch (e) {
            console.error('[invoice] draft-mail failed:', e && e.stack);
            res.status(500).json({ error: e.message });
        }
    });

    // Stop two, and the only one that cannot be taken back.
    app.post('/api/invoice/send', requireAdmin, async (req, res) => {
        try {
            const b = req.body || {};
            // Explicitly true. The screen sets it when she presses Send on a
            // draft she has just read; nothing else does, and a GET or a
            // stray POST can never be mistaken for her saying yes.
            if (b.confirm !== true && b.confirm !== 'true') {
                return res.status(400).json({ error: 'confirm is required', code: 'NOT_CONFIRMED' });
            }
            const draft = invoiceMailDraft(req);
            if (!draft.ok) {
                return res.status(409).json({
                    error: draft.message, code: String(draft.reason || 'no_draft').toUpperCase(),
                    ask_recipients: draft.ask_recipients === true,
                    consignee: draft.consignee || null, bad: draft.bad || undefined,
                });
            }

            // ── WHAT SHE EDITED WINS ──────────────────────────────────────
            // Her rule from 2026-09-19, "also make the email editable": the
            // draft is a starting point. Trimmed-empty falls back to the
            // generated text rather than sending a blank subject — clearing
            // a box is far more likely an accident than an instruction.
            const subject = String(b.subject || '').trim() || draft.subject;
            const body = String(b.body || '').trim() ? String(b.body) : draft.body;

            const shipmentDocs = require('./helpers/shipmentDocs');
            const { sendEmail } = require('./helpers/gmail');
            const sent = await sendEmail({
                to: draft.to, cc: draft.contact_cc || null, bcc: null,
                subject, body, attachments: shipmentDocs.attachmentsFor(draft.found),
            });

            // AFTER the send, never before: a contact written for a message
            // that then failed to go is one she never asked for, sitting
            // there looking like it worked. Non-fatal for the same reason
            // the sale route gives — the invoice has left the building, and
            // a bookkeeping failure must not turn a 200 into a 500.
            let saved_contact = null;
            if (draft.save_as && draft.save_as.name) {
                try {
                    const { addContact } = require('./helpers/emailContacts');
                    await addContact(draft.save_as.name, draft.save_as.email,
                                     (draft.save_as.cc || []).length ? { cc: draft.save_as.cc } : {});
                    saved_contact = draft.save_as.name;
                } catch (e) {
                    console.error('[invoice] sent, but could not save the contact:', e.message);
                }
            }

            // draft.attachments, not found.names — `names` is not a thing
            // findForContainer returns, and reporting an empty list after a
            // successful send would read as "nothing was attached".
            res.json({ ok: true, id: sent && sent.id, to: draft.to, cc: draft.contact_cc || null,
                       subject, attached: draft.attachments || [], saved_contact });
        } catch (e) {
            console.error('[invoice] send failed:', e && e.stack);
            res.status(500).json({ error: e.message });
        }
    });

    // ── FILING A GENERATED INVOICE ────────────────────────────────────────
    // Extracted from the route body on 2026-09-19 so the Sale row's Generate
    // can file its documents the same way. It was inline, and copying forty
    // lines of "name it, save it, record the version" into a second route is
    // how two folders full of differently-named invoices happen.
    //
    // Everything below is that code unchanged — the names, the order, the
    // non-fatal version write. The only new thing is that it returns the
    // payload instead of sending it.
    async function saveGeneratedInvoice(out, body, { separate, invoiceOnly }) {
        const safeInv = documentsSaved.safeName(body.inv_no || body.container_no || 'INVOICE').replace(/_+/g, '_');

        if (separate) {
            // Same names the old tool produced, so her filing does not
            // have to learn a new convention.
            const invName = `${safeInv}_INVOICE.pdf`;
            const pkgName = `${safeInv}_PACKING_LIST.pdf`;
            const invPath = documentsSaved.saveInvoiceCopy(out.invoice, invName, body.container_no || 'UNKNOWN');
            const pkgPath = documentsSaved.saveInvoiceCopy(out.packing, pkgName, body.container_no || 'UNKNOWN');
            try {
                await invoiceVersions.saveInvoiceVersion(body.container_no, body);
            } catch (verErr) {
                console.error('[invoice] saving version history failed (non-fatal):', verErr.message);
            }
            return {
                ok: true,
                separate: true,
                saved_filename: path.basename(invPath),
                saved_filenames: [path.basename(invPath), path.basename(pkgPath)],
            };
        }

        const pdf = out;
        // Named _INVOICE so a file on her desk says which of the two it
        // is. The same name separate mode gives its invoice half, because
        // it is the same document — one filing convention, not two.
        const filename = invoiceOnly ? `${safeInv}_INVOICE.pdf` : `${safeInv}.pdf`;
        const savedPath = documentsSaved.saveInvoiceCopy(pdf, filename, body.container_no || 'UNKNOWN');

        // Save the form-state snapshot that produced this real PDF, so a
        // later visit to the same container can offer "Load previous
        // edits" instead of starting from raw sheet data again. Deliberately
        // does not block the response on failure — losing this convenience
        // history is not worth failing a real invoice generation over.
        try {
            await invoiceVersions.saveInvoiceVersion(body.container_no, body);
        } catch (verErr) {
            console.error('[invoice] saving version history failed (non-fatal):', verErr.message);
        }

        return { ok: true, saved_filename: path.basename(savedPath) };
    }

    // ══ GENERATE FROM A SALE ROW ══════════════════════════════════════════
    //
    // Apsara, 2026-09-19: "if all important details of bills is entered,if i
    // say create invoice(it needs to ask-separate invoice and packing list/
    // normal) -upon my confirmation-it needs to create automatically (get
    // verfiication from me by showing that on screen)andupon confirm- mail it
    // to the customer with loading photos", and then: "Instead of create
    // invoice->Have it as generate".
    //
    // Three routes, because the flow has three stops and she named the order
    // herself: "first need to show the generated invoice then draft mail".
    //
    //   generate    build it from the sale, file it, hand back what it found
    //   draft-mail  who it would go to and what it would say
    //   send        the only irreversible one, and the only one that refuses
    //
    // ── WHY THE WEIGHT GUARD MOVED TO THE LAST STOP ───────────────────────
    // /api/invoice/generate refuses a 409 WEIGHT_MISMATCH and is NOT changed
    // by any of this — the Documents screen behaves today exactly as it did
    // yesterday. Here the guard sits on send instead, and that was her call:
    // "weights_ok it should generate and then ask for my conf to mail".
    //
    // It is also the better place for it. Generating is reversible — a PDF in
    // a folder that nobody has seen harms nobody — and emailing a buyer is
    // not. Guarding the step that cannot be taken back, with the figures on
    // screen while she answers, is a stronger check than guarding the step
    // that can.
    //
    // ── AND THE ROUTE THAT CANNOT MAKE THE MISTAKE ANYWAY ─────────────────
    // 260918_AP_26ARIS02 said 15,642.000 MT because pounds were typed into a
    // column headed MT. Nothing is typed here: helpers/saleInvoice.js
    // converts the sale's pounds into the tonnes that column is labelled
    // with, and its per-pound price into the US$/MT the next column is
    // labelled with. The guard still runs, and on a correctly built invoice
    // it finds nothing.
    const requireSaleInvoice = requireAdmin;

    app.post('/api/sales/:id/invoice/generate', requireSaleInvoice, async (req, res) => {
        try {
            const saleInvoice = require('./helpers/saleInvoice');
            const salesHelper = require('./helpers/sales');
            const sale = salesHelper.getSale(req.params.id);
            if (!sale) return res.status(404).json({ error: 'no such sale' });

            const body0 = req.body || {};
            // Same exclusion the Documents screen enforces and for the same
            // reason: "invoice only" and "separate invoice and packing list"
            // contradict each other, and the safe reading of a contradiction
            // is the narrower one — fewer documents than expected, never a
            // packing list she asked not to send.
            const invoiceOnly = body0.invoice_only === true || body0.invoice_only === 'true';
            const separate = !invoiceOnly && (body0.separate === true || body0.separate === 'true');

            // ── WHICH ROWS GO ON IT, WHEN NO CONTAINER SAYS ──────────────
            // Her answer to the grouping question, posted back as the ids she
            // ticked. Absent on the first press, and absent forever on a
            // container — helpers/saleInvoice.siblingGroup only asks where a
            // booking is all there is to go on.
            const includeSaleIds = Array.isArray(body0.include_sale_ids)
                ? body0.include_sale_ids.map(String) : null;

            const built = saleInvoice.buildFrom(sale, { includeSaleIds });
            if (!built.readiness.ok) {
                // 422, not 500: the sale is fine, it is just not finished.
                return res.status(422).json({
                    error: `This sale still needs: ${built.readiness.missing.join(', ')}.`,
                    code: 'SALE_INCOMPLETE',
                    missing: built.readiness.missing,
                });
            }

            // ── ASKED BEFORE ANYTHING IS RENDERED, NOT AFTER ──────────────
            // 409 and no PDF. Rendering first and asking afterwards would put
            // a file on disk carrying rows she had not agreed to, and the
            // Send step attaches what is on disk.
            //
            // ── AND IT IS UNREACHABLE TODAY. SAID PLAINLY ─────────────────
            // saleInvoice.REQUIRED lists container_no, so the 422 above fires
            // for every one of her 52 local deliveries before this is
            // consulted — and a row WITH a container is never an unsafe
            // group. So no test can reach this branch, and scripts/mutate.js
            // deliberately carries no mutation for it: one that can never go
            // red would weaken what "0 SURVIVED" means. The screen side IS
            // exercised (tests/sale-invoice.js section I drives the 409 with
            // a stubbed route) so the answer path is not dead code.
            // If container_no ever stops being required, write the route test.
            if (built.grouping && built.grouping.safe === false) {
                return res.status(409).json({
                    error: built.grouping.why,
                    code: 'GROUPING_UNCERTAIN',
                    candidates: built.grouping.candidates,
                });
            }

            const { generateInvoiceClassicPdf } = require('./helpers/invoicePdf');
            const out = await generateInvoiceClassicPdf(built.body, { separate, invoiceOnly });
            const saved = await saveGeneratedInvoice(out, built.body, { separate, invoiceOnly });

            // Reported, not refused. The screen puts these above the Send
            // button on the next stop, where they are still answerable.
            const invoiceWeights = require('./helpers/invoiceWeights');
            const problems = invoiceWeights.weightProblems(built.body.line_items);

            res.json({
                ...saved,
                container_no: built.body.container_no,
                inv_no: built.body.inv_no,
                consignee: built.body.consignee,
                line_items: built.body.line_items,
                photos: built.photos,
                warnings: built.warnings,
                weight_problems: problems,
                weight_message: problems.length ? invoiceWeights.refusalMessage(problems) : null,
            });
        } catch (e) {
            console.error('[sale-invoice] generate failed:', e && e.stack);
            res.status(500).json({ error: e.message });
        }
    });

    // Stop two. Read-only — it looks at what is on disk and at the address
    // book, and sends nothing. The photos come from the matching BILL, which
    // is where she pastes them.
    app.get('/api/sales/:id/invoice/draft-mail', requireSaleInvoice, (req, res) => {
        try {
            const saleInvoice = require('./helpers/saleInvoice');
            const shipmentMail = require('./helpers/shipmentMail');
            const salesHelper = require('./helpers/sales');
            const sale = salesHelper.getSale(req.params.id);
            if (!sale) return res.status(404).json({ error: 'no such sale' });

            const photos = saleInvoice.photosFor(saleInvoice.billFor(sale));
            // Addresses she typed into the box, when the address book had
            // none. Passed through on a GET so the screen can re-draw the
            // draft with them before anything is sent — she reads the real
            // message either way.
            const recipients = req.query.recipients || null;
            const draft = shipmentMail.draftFor(sale.container_no, {
                photos,
                recipients,
                // The sale KNOWS its customer, so a container whose invoice
                // history has not recorded a consignee still resolves. The
                // invoice's own record still wins when it has one — it is the
                // name printed on the document being sent.
                consignee: null,
            });
            if (!draft.ok && draft.reason === 'no_customer' && String(sale.customer || '').trim()) {
                const retry = shipmentMail.draftFor(sale.container_no,
                    { photos, recipients, consignee: sale.customer });
                if (retry.ok || retry.reason !== 'no_customer') return res.json(retry);
            }
            res.json(draft);
        } catch (e) {
            console.error('[sale-invoice] draft-mail failed:', e && e.stack);
            res.status(500).json({ error: e.message });
        }
    });

    // Stop three, and the only one that cannot be taken back.
    app.post('/api/sales/:id/invoice/send', requireSaleInvoice, async (req, res) => {
        try {
            const saleInvoice = require('./helpers/saleInvoice');
            const shipmentMail = require('./helpers/shipmentMail');
            const shipmentDocs = require('./helpers/shipmentDocs');
            const salesHelper = require('./helpers/sales');
            const sale = salesHelper.getSale(req.params.id);
            if (!sale) return res.status(404).json({ error: 'no such sale' });

            const body0 = req.body || {};
            const photos = saleInvoice.photosFor(saleInvoice.billFor(sale));

            // ── THE WEIGHT ANSWER IS REQUIRED HERE ────────────────────────
            // Built from the SALE again rather than trusted from the client:
            // a figure the browser sends back is a figure the browser could
            // have changed, and this is the document that goes to customs.
            //
            // The ids ARE taken from the client, and only the ids: they say
            // which rows she ticked at the generate step, and without them
            // this would weigh one row against a PDF carrying three. Every
            // figure is still read out of her ledger; siblingGroup discards
            // any id that was not among the rows it gathered itself.
            const built = saleInvoice.buildFrom(sale, {
                includeSaleIds: Array.isArray(body0.include_sale_ids)
                    ? body0.include_sale_ids.map(String) : null,
            });
            const invoiceWeights = require('./helpers/invoiceWeights');
            const problems = invoiceWeights.weightProblems(built.body.line_items);
            if (problems.length && body0.weights_ok !== true && body0.weights_ok !== 'true') {
                return res.status(409).json({
                    error: invoiceWeights.refusalMessage(problems),
                    code: 'WEIGHT_MISMATCH',
                    problems,
                });
            }

            const recipients = body0.recipients || null;
            let draft = shipmentMail.draftFor(sale.container_no, { photos, recipients });
            if (!draft.ok && draft.reason === 'no_customer' && String(sale.customer || '').trim()) {
                draft = shipmentMail.draftFor(sale.container_no,
                    { photos, recipients, consignee: sale.customer });
            }
            if (!draft.ok) {
                return res.status(409).json({
                    error: draft.message, code: draft.reason.toUpperCase(),
                    // The screen shows the recipients box on this flag rather
                    // than on a string match against the sentence.
                    ask_recipients: draft.ask_recipients === true,
                    consignee: draft.consignee || null,
                    bad: draft.bad || undefined,
                });
            }

            // ── SENDING IS NOT A THING A GET CAN DO BY ACCIDENT ───────────
            // confirm must be explicitly true. The screen sets it when she
            // presses Send on the draft she has just read; nothing else does.
            if (body0.confirm !== true && body0.confirm !== 'true') {
                return res.status(400).json({ error: 'confirm is required', code: 'NOT_CONFIRMED' });
            }

            // ── WHAT SHE EDITED WINS ──────────────────────────────────────
            // Apsara, 2026-09-19: "also make the email editable."
            //
            // The draft is a starting point, not a template she has to accept.
            // Whatever is in the boxes when she presses Send is what goes —
            // and because the screen posts back exactly what it is showing,
            // the message she read is the message that left.
            //
            // Trimmed-empty falls back to the generated text rather than
            // sending a blank subject: clearing a box is far more likely to be
            // an accident than an instruction.
            const subject = String(body0.subject || '').trim() || draft.subject;
            const mailBody = String(body0.body || '').trim() ? String(body0.body) : draft.body;

            const { sendEmail } = require('./helpers/gmail');
            const attachments = shipmentDocs.attachmentsFor(draft.found);
            const sent = await sendEmail({
                to: draft.to,
                cc: draft.contact_cc || null,
                bcc: null,
                subject,
                body: mailBody,
                attachments,
            });
            // ── AND THEN IT IS IN THE ADDRESS BOOK ────────────────────────
            // Apsara, 2026-09-19: "then it should get stored in email
            // contacts tab". Saved AFTER the send, not before: a contact
            // written for a message that then failed to go is a contact she
            // never asked for, sitting there looking like it worked.
            //
            // Non-fatal on purpose. The invoice has left the building by this
            // point and a bookkeeping failure must not turn a 200 into a 500 —
            // she would resend it, and the buyer would have two.
            let saved_contact = null;
            if (draft.save_as && draft.save_as.name) {
                try {
                    const { addContact } = require('./helpers/emailContacts');
                    await addContact(draft.save_as.name, draft.save_as.email,
                                     (draft.save_as.cc || []).length ? { cc: draft.save_as.cc } : {});
                    saved_contact = draft.save_as.name;
                } catch (e) {
                    console.error('[sale-invoice] sent, but could not save the contact:', e.message);
                }
            }

            // The subject that WENT, not the one that was generated — she may
            // have rewritten it, and the confirmation screen has to report
            // what happened rather than what was planned.
            res.json({ ok: true, to: draft.to, cc: draft.contact_cc || [], subject,
                       attached: attachments.map((a) => a.filename), id: sent && sent.id,
                       saved_contact });
        } catch (e) {
            console.error('[sale-invoice] send failed:', e && e.stack);
            res.status(500).json({ error: e.message });
        }
    });

    // Review & Generate screen's version-history banner — "You last generated
    // this container on [date] — N versions saved". See helpers/invoiceVersions.js
    // for why this is separate from the saved-PDF archive above.
    app.get('/api/invoice/versions', (req, res) => {
        try {
            res.json(invoiceVersions.getInvoiceVersionSummary(req.query.container || ''));
        } catch (e) {
            console.error('[invoice] versions lookup failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ── PORTS SHE HAS ACTUALLY USED ───────────────────────────────────────
    // Apsara, 2026-09-29: "In port of discharge,save when generated,for say
    // Busan,South Korea.Port of loading as Los Angeles,CA... I want a drop
    // down to be added as i type."
    //
    // Not a shipped list of world seaports — see helpers/ports.js for why.
    // The suggestions are her own history: every generated invoice's saved
    // form state, plus the POL/POD already on her bookings so the dropdown is
    // useful before she has generated anything.
    //
    // Read only, and it fails soft to an empty list: a type-ahead that 500s
    // would block typing in the box it is meant to help with.
    app.get('/api/ports', (req, res) => {
        try {
            const ports = require('./helpers/ports');
            const which = req.query.which === 'loading' ? 'loading' : 'discharge';
            res.json({ which, ports: ports.search(which, req.query.q || '', 10) });
        } catch (e) {
            console.error('[ports] lookup failed:', e.message);
            res.json({ which: req.query.which || 'discharge', ports: [] });
        }
    });

    // ── THE INVOICES SHE HAS GENERATED, AND THE ONE SHE WANTS BACK ────────
    // Apsara, 2026-09-29: "Generated invoice should be editable.It should
    // display below the invoice things.with edit option."
    //
    // The list is a summary per container; the full form payload comes from
    // the second route, only when she presses Edit. Ten complete invoice
    // payloads to draw a ten-row table would make the screen slower the more
    // she used it.
    // ── NAMED "history", NOT "generated" ──────────────────────────────────
    // The first name was /api/invoice/generated, which CONTAINS the existing
    // /api/invoice/generate as a substring. Anything matching by substring —
    // tests/invoice-weight-guard.js's fetch stub did, and so would a log
    // filter or a proxy rule — reads a GET of the list as a POST to the
    // generator. That test started reporting three generate posts where there
    // were two, and the "extra" one was this list loading.
    //
    // Renamed rather than papering over it in the test: a route whose name is
    // a prefix of another route's is a trap for the next person too.
    app.get('/api/invoice/history', requireAdmin, (req, res) => {
        try { res.json({ invoices: invoiceVersions.listGeneratedInvoices() }); }
        catch (e) {
            console.error('[invoice] generated list failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // The saved form state behind one of them. Same shape /api/invoice/preview
    // returns, which is why the client can pour it straight into the review
    // screen with applyInvoiceDataToForm.
    //
    // 404 rather than an empty object when there is nothing: an invoice
    // generated before this store existed is a PDF and has no form state, and
    // quietly handing back a blank payload would wipe the screen she is on.
    app.get('/api/invoice/history/payload', requireAdmin, (req, res) => {
        try {
            const p = invoiceVersions.getLatestInvoicePayload(req.query.container || '');
            if (!p) {
                return res.status(404).json({
                    error: 'No saved form for this container — it was generated before edits were kept, '
                         + 'so only the PDF exists.' });
            }
            const { saved_at, ...payload } = p;
            res.json({ container: req.query.container || '', saved_at: saved_at || null, payload });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/customer-pricing/list', (req, res) => {
        try { res.json(proformaPricing.listCustomers()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/customer-pricing/lookup', (req, res) => {
        try { res.json(proformaPricing.lookup(req.query.customer || '')); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/customer-pricing/item-rate', (req, res) => {
        try { res.json(proformaPricing.lookupItemRate(req.query.customer || '', req.query.item || '') || {}); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/customer-pricing/parse-paste', (req, res) => {
        try { res.json(proformaPricing.parsePastedText((req.body || {}).text || '')); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/customer-pricing/save', async (req, res) => {
        try {
            const body = req.body || {};
            const updated = await proformaPricing.upsert(body.customer || '', {
                tradeTerms: body.trade_terms || '',
                portDischarge: body.port_discharge || '',
                paymentTerms: body.payment_terms || body.payment_term || '',
                items: body.items || [],
            });
            res.json(updated);
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Archive listing/download — currently proforma-only (see comment
    // above); the invoice branch is wired for when the Invoice tab lands so
    // this route doesn't need to change shape again later.
// @@chunk-end

};
