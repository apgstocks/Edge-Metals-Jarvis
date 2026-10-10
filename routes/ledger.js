// routes/ledger.js — split from api.js (helpers/sourceParts.js reconstructs the original)
module.exports = function (app, ctx) {
    const { actorOf, requireAdmin, requireSuper } = ctx;
// @@chunk-start
    app.get('/api/bills', (req, res) => {
        try {
            const b = require('./helpers/bills');
            const all = b.listWithTotals();
            // ── FILTERED HERE, SO THE TOTALS AGREE WITH THE TABLE ────────
            // Apsara: "also i want filter.ultiple filters can also be
            // applied." Doing it in the browser would leave summary() adding
            // up rows that are no longer on screen — a balance belonging to a
            // different set of bills, which is worse than no filter at all.
            const rows = b.newestFirst(b.filterRows(all, req.query || {}));
            res.json({
                // Same warning the sales table carries. A duplicate here is
                // worse: margin.js keeps only the LAST bill for a container,
                // so the container reads as cheaper than it was.
                duplicates: b.duplicates(all),
                bills: rows,
                summary: b.summary(rows),
                // ── CREDIT SITTING WITH EACH SUPPLIER ────────────────────
                // Apsara, 2026-09-29: "see all unapplied advacne against the
                // suppl[i]er".
                //
                // An advance is a payment whose allocations do not yet add up
                // to it; the remainder is credit against that supplier.
                // helpers/billPayments.js has computed this for weeks —
                // creditBySupplier() — and the ONLY place it reached was the
                // "who are you paying?" step of the pay modal. So the figure
                // existed and could not be seen unless she was already in the
                // act of paying someone.
                //
                // Keyed by supplier name so the row badge can look up its own
                // without a second request. Fails soft: a bills table that
                // refuses to load because an advance could not be read would
                // be far worse than one with no badges.
                credit: (() => {
                    try { return require('./helpers/billPayments').creditBySupplier(); }
                    catch (e) { return {}; }
                })(),
                // Built from EVERY row, not the filtered ones, or narrowing by
                // supplier would empty the supplier dropdown she just used.
                facets: b.facets(all),
                filterable: b.FILTERABLE,
                total_unfiltered: all.length,
                // tableColumns() is her order; COLUMNS is grouped for the
                // form. Both travel, so neither client re-derives one from
                // the other and gets it subtly wrong.
                columns: b.tableColumns(),
                fields: b.COLUMNS,
                groups: b.GROUPS,
                writable: b.WRITABLE,
                // So the form can show "/lb" or "/MT" beside the price and
                // she can override the inference — her choice when asked:
                // "Yes — show '/lb' or '/MT' on the row".
                per_lb_ceiling: b.PER_LB_CEILING,
                lb_per_mt: b.LB_PER_MT,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── PRE-FILL FROM THE BOOKING SHE PICKS ───────────────────────────────
    // Her answer when asked how a bill should start: "Pick a booking, the rest
    // fills in." Everything here is already on the booking record, so typing
    // it again is an invitation to mistype a container number.
    //
    // Returns a SUGGESTION, never a saved row. Nothing is written until she
    // posts it, and every field stays editable — a booking's port pair is
    // right almost always, and "almost always" is not a reason to lock it.
    app.get('/api/bills/from-booking/:bkgNo', (req, res) => {
        try {
            const bkgNo = String(req.params.bkgNo || '').trim();
            // DESTRUCTURED. getBooking returns { booking, status }, and my
            // first version read the fields straight off that wrapper — so an
            // unknown booking came back 200 with every field null instead of
            // 404, and a real one pre-filled nothing. Caught by the test in
            // tests/bills-sales.js, which then found the same mistake sitting
            // live in two places in workflow/actions.js.
            const { booking: bk } = require('./helpers/booking').getBooking(bkgNo);
            if (!bk) return res.status(404).json({ error: `no booking ${bkgNo}` });
            const seq = Number(req.query.container || 1);
            const box = (bk.containers || []).find((c) => Number(c.seq) === seq)
                || (bk.containers || [])[0] || {};
            res.json({
                ok: true,
                prefill: {
                    booking_no: bk.booking_number || bkgNo,
                    carrier: bk.carrier || null,
                    route: [bk.port_of_loading, bk.port_of_discharge].filter(Boolean).join(' / ') || null,
                    container_no: box.container_number || null,
                    supplier: box.supplier || null,
                    trucking_company: box.trucker || null,
                },
                // So the form can offer the other containers on the same
                // booking rather than making her go back for each one.
                containers: (bk.containers || []).map((c) => ({
                    seq: c.seq, size: c.size, container_number: c.container_number,
                    supplier: c.supplier, trucker: c.trucker,
                })),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── LIVE TOTALS WHILE SHE TYPES, WITHOUT A SECOND IMPLEMENTATION ──────
    // Apsara, 2026-09-10: "This is ugly and not user friendly." Part of what
    // made it so was that she filled in five weights and four money fields and
    // saw nothing until she saved — the whole point of computing net, amount
    // and balance is that she can check them against the supplier's invoice.
    //
    // The obvious way to show them live is to do the arithmetic in the
    // browser. That would be a SECOND implementation of her formulas, and
    // helpers/bills.js's own header says why not: three implementations of one
    // sum is two chances to disagree about money. So the preview asks the
    // server, which is the only thing that knows how to compute a bill.
    //
    // Writes nothing, and deliberately has no id: it is compute() over a
    // request body and back.
    // ── IMPORTING HER SHIPMENT WORKBOOK ──────────────────────────────────
    // Apsara, 2026-09-19: "I want to have a upload option in jarvis for bills
    // and invoice where i can import this."
    //
    // THREE ROUTES, AND THE SPLIT IS THE SAFETY PROPERTY. /preview reads the
    // file and writes NOTHING; /commit writes what a preview described; and
    // the undo removes one import whole. She asked to see it before anything
    // landed, and 568 bills appearing unannounced is not something to find
    // out about afterwards.
    //
    // The preview is re-read on commit rather than carried in a session:
    // holding a parsed 19MB workbook in memory between two requests is a
    // memory leak waiting for a busy afternoon, and re-reading the same bytes
    // gives the same answer. What she approved IS what gets written because
    // both calls run the same helpers/sheetImport.js over the same file.
    function importOptionsFrom(body) {
        const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
        return { shipmentsLastRow: n(body.shipments_last_row), ordersLastRow: n(body.orders_last_row) };
    }

    // Base64 in JSON, the same shape /api/packing-lists/scan already uses.
    // Her workbook is 19MB, which is ~25MB encoded — under the 40MB body cap,
    // but close enough that the limit is stated rather than discovered.
    function workbookFrom(body) {
        const b64 = String(body.file_base64 || '').replace(/^data:[^;]+;base64,/, '');
        if (!b64) { const e = new Error('no file'); e.status = 400; throw e; }
        if (b64.length > 34 * 1024 * 1024) {
            const e = new Error('That workbook is too big — under 25MB, please.');
            e.status = 413; throw e;
        }
        return Buffer.from(b64, 'base64');
    }

    app.post('/api/import/preview', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const parsed = await require('./helpers/sheetImport')
                .readWorkbook(workbookFrom(body), importOptionsFrom(body));
            const planned = require('./helpers/sheetImportWrite')
                .plan(parsed, { source: String(body.filename || 'workbook.xlsx'), actor: actorOf(req) });
            // The rows themselves are NOT sent back — 568 bills is a large
            // response to render and she is deciding on the shape of it, not
            // reading all of them. Counts, every refusal, and one of each
            // kind as a sample.
            res.json({
                ok: true,
                summary: { ...parsed.summary, ...planned.summary },
                sheets: parsed.sheets,
                refused: planned.refused,
                skipped: parsed.skipped,
                problems: parsed.problems,
                cancelled: parsed.cancelled || [],
                mismatches: parsed.mismatches || [],
                // How her one "Advance /Trucking" column was divided, and any
                // row close enough to the line to be worth her eye.
                near_threshold: parsed.near_threshold || [],
                already_imported: planned.alreadyImported,
                samples: {
                    bill: planned.bills.find((b) => !b.items) || null,
                    multi: planned.bills.find((b) => (b.items || []).length > 1) || null,
                    local: planned.bills.find((b) => !b.container_no) || null,
                    invoice: planned.sales[0] || null,
                },
            });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.post('/api/import/commit', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const parsed = await require('./helpers/sheetImport')
                .readWorkbook(workbookFrom(body), importOptionsFrom(body));
            const siw = require('./helpers/sheetImportWrite');
            const planned = siw.plan(parsed, { source: String(body.filename || 'workbook.xlsx'), actor: actorOf(req) });

            // Audited BEFORE the write, like the document delete: the record
            // this describes is the one that will not exist if it goes wrong.
            const audit = require('./helpers/audit');
            const entry = await audit.record({
                action: 'import-workbook', subject: planned.batch,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { source: planned.source, bills: planned.summary.bills,
                          sales: planned.summary.sales, refused: planned.summary.refused },
            });
            try {
                const result = await siw.commit(planned, { force: body.force === true });
                await audit.complete(entry, 'done', result);
                res.json({ ok: true, ...result, refused: planned.refused });
            } catch (e) {
                await audit.complete(entry, 'failed', { reason: e.message, code: e.code || null });
                throw e;
            }
        } catch (e) {
            res.status(e.code === 'ALREADY_IMPORTED' ? 409 : (e.status || 500))
               .json({ error: e.message, code: e.code || null, batch: e.batch || null });
        }
    });

    app.get('/api/import/batches', requireAdmin, (req, res) => {
        try { res.json({ batches: require('./helpers/sheetImportWrite').listBatches() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // The way back. requireSuper, not requireAdmin: undoing an import removes
    // hundreds of financial records at once, which is a bigger act than
    // deleting one bill and belongs behind the same gate as unwinding a
    // supplier payment.
    app.delete('/api/import/:batch', requireSuper, async (req, res) => {
        try {
            const audit = require('./helpers/audit');
            const entry = await audit.record({
                action: 'undo-import', subject: req.params.batch,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { batch: req.params.batch },
            });
            const removed = await require('./helpers/sheetImportWrite').undo(req.params.batch);
            await audit.complete(entry, 'done', { removed });
            res.json({ ok: true, removed });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── ONE NAME, ONE SPELLING — FOR WHICHEVER FIELD SHE PICKS ──────────
    // Apsara, 2026-09-19: "Even in carrier-that supplier name same problem is
    // there.dont make sepratae button for this.instead ,make one button give
    // an opion for each field to correct this."
    //
    // So the field is a parameter, not a second copy of the feature. An
    // unknown one throws in helpers/nameCleanup.js rather than quietly
    // cleaning nothing.
    app.get('/api/names/:field/preview', requireAdmin, (req, res) => {
        try {
            const nc = require('./helpers/nameCleanup');
            const field = req.params.field;
            const planned = nc.plan(field);
            res.json({
                ok: true, field,
                fields: nc.FIELD_KEYS.map((k) => ({ key: k, label: nc.FIELDS[k].label, where: nc.FIELDS[k].where })),
                clusters: planned.clusters,
                byStore: planned.byStore,
                total: planned.total,
                proposals: nc.proposals(field),
                aliases: nc.aliases(field),
                names: nc.usage(field).sort((a, b) => a.name.localeCompare(b.name)),
                // Every merge ever run, whatever the field — so an undo is
                // reachable from whichever tab she happens to be on.
                merges: nc.merges(),
            });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post('/api/names/:field/alias', requireAdmin, async (req, res) => {
        try {
            const nc = require('./helpers/nameCleanup');
            const { from, to } = req.body || {};
            res.json({ ok: true, ...(await nc.addAlias(req.params.field, from, to, actorOf(req))) });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete('/api/names/:field/alias/:from', requireAdmin, async (req, res) => {
        try {
            const removed = await require('./helpers/nameCleanup').removeAlias(req.params.field, req.params.from);
            res.json({ ok: true, removed });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // requireSuper, and deliberately: this rewrites hundreds of live records
    // across several stores at once, which is a bigger act than editing one
    // bill and sits behind the same gate as undoing an import.
    app.post('/api/names/:field/merge', requireSuper, async (req, res) => {
        try {
            const nc = require('./helpers/nameCleanup');
            const audit = require('./helpers/audit');
            const field = req.params.field;
            const planned = nc.plan(field, { keys: Array.isArray(req.body && req.body.keys) ? req.body.keys : null });
            if (!planned.total) return res.json({ ok: true, field, changed: 0, byStore: {}, merge_id: null });
            const entry = await audit.record({
                action: 'merge-names', subject: planned.merge_id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { field, rows: planned.total, byStore: planned.byStore,
                          clusters: planned.clusters.map((c) => ({ to: c.winner, from: c.losers.map((l) => l.name) })) },
            });
            try {
                const out = await nc.apply(planned);
                await audit.complete(entry, 'done', out);
                res.json({ ok: true, ...out });
            } catch (e) { await audit.complete(entry, 'failed', { reason: e.message }); throw e; }
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // The merge id names its own field, so the undo route does not need one.
    app.delete('/api/names/merge/:id', requireSuper, async (req, res) => {
        try {
            const audit = require('./helpers/audit');
            const entry = await audit.record({
                action: 'undo-name-merge', subject: req.params.id,
                actor: actorOf(req), role: req.role, ip: req.ip, detail: { merge_id: req.params.id },
            });
            const restored = await require('./helpers/nameCleanup').undo(req.params.id);
            await audit.complete(entry, 'done', { restored });
            res.json({ ok: true, restored });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── EXPORTING WHAT IS ON SCREEN ─────────────────────────────────────
    // Apsara, 2026-09-19: "Add export option to bill and invoice-export as xls
    // and pdf", and, asked what it should contain: exactly what is on screen.
    //
    // So it takes the SAME query string the table was drawn with and runs it
    // through the same filterRows/tableColumns/summary the /api/bills route
    // uses. A second definition of "which columns" would be discovered by
    // whoever she sent the file to.
    //
    // requireAdmin, matching /api/bills and /api/sales: a ledger export is the
    // whole ledger in one file, so it cannot be looser than reading the table.
    app.get('/api/:kind(bills|sales)/export', requireAdmin, async (req, res) => {
        try {
            const le = require('./helpers/ledgerExport');
            const kind = req.params.kind;
            const format = String(req.query.format || 'xlsx').toLowerCase();
            const built = le.build(kind, req.query || {});
            if (format === 'pdf') {
                const pdf = await le.toPdf(built);
                res.set('Content-Type', 'application/pdf');
                res.set('Content-Disposition', `attachment; filename="${le.filenameFor(built, 'pdf')}"`);
                return res.send(pdf);
            }
            if (format !== 'xlsx' && format !== 'xls') {
                return res.status(400).json({ error: `unknown export format "${format}" — xlsx or pdf` });
            }
            const buf = await le.toWorkbook(built);
            // .xlsx even when she asked for "xls": the file IS a modern
            // workbook, and naming it .xls makes Excel warn that the contents
            // do not match the extension every single time she opens it.
            res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.set('Content-Disposition', `attachment; filename="${le.filenameFor(built, 'xlsx')}"`);
            return res.send(buf);
        } catch (e) {
            console.error('[export] failed:', e && e.stack);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/bills/preview', (req, res) => {
        try { res.json({ ok: true, ...require('./helpers/bills').compute(req.body || {}) }); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/sales/preview', (req, res) => {
        try { res.json({ ok: true, ...require('./helpers/sales').compute(req.body || {}) }); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post('/api/bills', async (req, res) => {
        try {
            const b = require('./helpers/bills');
            const bill = await b.addBill({ ...(req.body || {}), created_by: (req.role || null) });
            require('./helpers/quickbooks/sync').after('bill', bill && bill.id);   // QuickBooks follows, never blocks (helpers/quickbooks/sync.js)
            // Apsara: "post save of a bill,i want Shipment tab to be created
            // in edge metals sheet." AFTER the bill is safely in bills.json,
            // and non-fatally — a Drive hiccup must not fail a Save she has
            // just typed eighteen fields into. See shipmentSheetLog's header.
            require('./helpers/shipmentSheetLog').logBillSafely(bill, 'saved');
            res.json({ ok: true, bill });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── ACCEPTING A VERIFIED HAULER INVOICE ONTO ONE BILL ─────────────────
    //
    // Apsara, 2026-09-20, chose to confirm each one rather than have a
    // verification write straight in — so this is the confirm. It takes the
    // bill SHE picked and the split she was shown, and goes through the same
    // editBill/cleanTruckingSplit path as a hand edit: no second way to write
    // money, no second sanitizer to keep in step.
    //
    // ASSEMBLED HERE, NOT IN THE BROWSER, and that is the point of the route
    // existing at all. splitToSave carries the bill's own `verified_on`
    // through untouched — a browser building this payload would have to
    // remember to, and the day it forgot, accepting a proposal would silently
    // blank a date she had typed. Her decision that verified_on stays a human
    // statement is enforced on this side of the wire.
    //
    // ONE BILL PER CALL, deliberately. A container is one row per grade and a
    // haul is charged once; a route that took a list would be one loop away
    // from trebling her haulage, which is the mistake this whole feature was
    // shaped to avoid.
    app.post('/api/bills/:id/accept-trucking', async (req, res) => {
        try {
            const b = require('./helpers/bills');
            const tp = require('./helpers/truckingProposal');
            const id = String(req.params.id);
            const bill = b.listWithTotals().find((x) => x.id === id);
            if (!bill) return res.status(404).json({ error: `no bill ${id}` });

            const split = (req.body || {}).split;
            if (!split || typeof split !== 'object') return res.status(400).json({ error: 'a split is required' });

            // The trucker's name rides along when the bill has none. It does
            // NOT overwrite one she typed — she chose to see both figures and
            // change nothing, and a company name is a figure of a kind.
            const patch = { trucking_split: tp.splitToSave(split, tp.currentOf(bill)) };
            const hauler = String((req.body || {}).hauler || '').trim();
            if (hauler && !String(bill.trucking_company || '').trim()) patch.trucking_company = hauler;

            const saved = await b.editBill(id, patch);
            require('./helpers/quickbooks/sync').after('bill', saved && saved.id);
            require('./helpers/shipmentSheetLog').logBillSafely(saved, 'edited');
            res.json({ ok: true, bill: saved });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── ACCEPTING A VERIFIED ZIMEX INVOICE ONTO ONE SALE ──────────────────
    // The same confirm, for ocean freight — her "for zimex, in freight of
    // invoice". chargesToSave rebuilds the charge list server-side because
    // helpers/salesSettlements.js pays charges off BY ID: a list rebuilt in
    // the browser that loses an id moves a settled freight payment onto an
    // unrelated line, and nothing would say so.
    app.post('/api/sales/:id/accept-freight', async (req, res) => {
        try {
            const s = require('./helpers/sales');
            const fp = require('./helpers/freightProposal');
            const id = String(req.params.id);
            const sale = s.listWithTotals().find((x) => x.id === id);
            if (!sale) return res.status(404).json({ error: `no invoice row ${id}` });

            const charge = (req.body || {}).charge;
            if (!charge || typeof charge !== 'object') return res.status(400).json({ error: 'a charge is required' });

            const charges = fp.chargesToSave(sale, charge, { replaceId: (req.body || {}).replace_id || null });
            const saved = await s.editSale(id, { charges });
            require('./helpers/quickbooks/sync').after('sale', saved && saved.id);
            res.json({ ok: true, sale: saved });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.put('/api/bills/:id', async (req, res) => {
        try {
            const b = require('./helpers/bills');
            const bill = await b.editBill(String(req.params.id), req.body || {});
            require('./helpers/quickbooks/sync').after('bill', bill && bill.id);
            // "on every edit of the bill,i want that row to be modified" —
            // upsertRowsByKey matches on the bill id, so this updates the row
            // it wrote before instead of appending a second one.
            require('./helpers/shipmentSheetLog').logBillSafely(bill, 'edited');
            res.json({ ok: true, bill });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete('/api/bills/:id', async (req, res) => {
        try {
            const b = require('./helpers/bills');
            await b.deleteBill(String(req.params.id));
            require('./helpers/quickbooks/sync').after('bill', String(req.params.id), 'deleted');
            res.json({ ok: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── CLEARING SEVERAL ROWS AT ONCE ─────────────────────────────────────
    // Apsara, 2026-09-29: "What if i want to delte multiple rows in bills and
    // invoice". Asked which she needed she said all three — a bad import, a
    // date range, and rows she ticks — and asked that a row with money against
    // it be REFUSED while the rest go.
    //
    // ── requireSuper, LIKE EVERY OTHER DELETION OF METALS MONEY ───────────
    // /api/bills/:id is not behind it because a single bill is an admin's to
    // correct. A SELECTION is a different thing: it is the one control here
    // that can empty a year in one press, and it changes what is owed to
    // suppliers and what customers owe. Same lock as sales-receipts,
    // bill-payments and sales-settlements.
    //
    // Plan and commit are separate routes on purpose. The screen shows her
    // exactly what will go and what was refused, and NOTHING has happened
    // when she is reading it.
    app.post('/api/ledger/bulk-delete/plan', requireSuper, (req, res) => {
        try {
            const bd = require('./helpers/ledgerBulkDelete');
            const { kind, selector, reason } = req.body || {};
            res.json(bd.planBy(String(kind || ''), selector || {}, { reason }));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── THE PLAN IS RE-RUN, NOT TRUSTED ───────────────────────────────────
    // The client posts back the SELECTOR, not the row list it was shown. A
    // plan sent to the browser and posted back is a list the caller can edit:
    // it would be the one path into these ledgers where the payment and claim
    // guards are decided by whoever is holding the page. Re-planning server
    // side costs a few milliseconds and means the refusals are always this
    // instant's, not the ones from before she went to lunch.
    app.post('/api/ledger/bulk-delete/commit', requireSuper, async (req, res) => {
        try {
            const bd = require('./helpers/ledgerBulkDelete');
            const { kind, selector, reason } = req.body || {};
            const planned = bd.planBy(String(kind || ''), selector || {}, { reason });
            if (!planned.going.length) {
                return res.json({ batch: planned.batch, removed: 0, refused: planned.refused,
                                  how: planned.how });
            }
            const result = await bd.commit(planned);
            for (const row of planned.going) {
                try {
                    require('./helpers/quickbooks/sync')
                        .after(planned.kind === 'bills' ? 'bill' : 'sale', String(row.id), 'deleted');
                } catch (e) { /* the rows are already gone; a sync hiccup must not 500 */ }
            }
            res.json({ ...result, how: planned.how, going: planned.going.length });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post('/api/ledger/bulk-delete/restore', requireSuper, async (req, res) => {
        try {
            const bd = require('./helpers/ledgerBulkDelete');
            const back = await bd.restore(String((req.body || {}).batch || ''));
            res.json({ ok: true, restored: back });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // What can be put back, and what imports there are to clear — the two
    // lists the screen needs to offer ways in 1 and the undo.
    app.get('/api/ledger/bulk-delete/batches', requireSuper, (req, res) => {
        try {
            const bd = require('./helpers/ledgerBulkDelete');
            let imports = [];
            try { imports = require('./helpers/sheetImportWrite').listBatches() || []; }
            catch (e) { imports = []; }
            res.json({ deletions: bd.batches(), imports });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── Paying for containers ─────────────────────────────────────────────
    // Apsara, 2026-09-10: "We need pay option.in payment,there is a possible
    // of giving advance deduction and multiple container paynebt at once."
    //
    // One payment, N containers, amount typed per container — her choice when
    // asked. An advance is the same shape with no containers yet. See
    // helpers/billPayments.js for why this is not helpers/payments.js.
    //
    // Same staff rule as /api/bills: absent from STAFF_ALLOWED_PATH_PREFIXES,
    // so the yard cannot see or move supplier money.
// @@chunk-end

};
