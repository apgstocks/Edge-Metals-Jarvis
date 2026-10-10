// routes/loads.js — split from api.js (helpers/sourceParts.js reconstructs the original)
const { loadSettings, saveSettings } = require('../helpers/json');

module.exports = function (app, ctx) {
    const { actorOf, isSuper, largeJson } = ctx;
// @@chunk-start
    app.get('/api/loads', (req, res) => {
        try {
            const { loadLoads } = require('./helpers/loads');
            const { PDF_TEMPLATE_VERSION } = require('./helpers/pdf');
            // pdf_stale is computed SERVER-SIDE and sent as a plain boolean so
            // the clients never need to know the current template number — one
            // place owns the version, and a client can't drift out of step
            // with it (which would be its own version-skew bug).
            // A load whose PDF predates versioning has no field at all, so it
            // reads as 0 and is correctly reported stale — those really were
            // built by older code.
            // payment: attached SERVER-SIDE for the same reason pdf_stale is.
            // The paid/pending arithmetic lives in one place, so a card, a
            // ticket and an invoice cannot each round it slightly differently.
            const { paymentSummary } = require('./helpers/payments');
            res.json(loadLoads().map(l => {
                // ── THE SIGNATURE IMAGE DOES NOT TRAVEL WITH THE LIST ──────
                // Apsara 2026-09-03: "it is taking 5 seconds every time post
                // clicking tab." Measured before changing anything, on a
                // 250-load fixture: the server built this response in 57 ms
                // and the response was 4.49 MB. 4.4 MB of that was
                // seller_signature — a base64 PNG, 10-40 KB each, on every
                // signed load. Over a Cloudflare tunnel on a phone that is
                // the five seconds.
                //
                // And the list never renders it. Every single use of
                // seller_signature in both clients is a TRUTHINESS CHECK —
                // "is this signed", to label the button "Sign" or "✓ Signed —
                // re-sign", and to decide loadIsSignable. Nothing draws the
                // image. So the blob was pure freight.
                //
                // The PDF builders and the signature route read the real
                // value from disk (helpers/pdf.js, POST /api/loads/:id/
                // signature) and are untouched — this strips it from ONE
                // response, not from the record.
                //
                // OLD CLIENTS: an APK from before this change reads
                // seller_signature and now finds nothing, so a signed load
                // shows "Sign" rather than "✓ Signed — re-sign". Cosmetic,
                // and the dangerous half of it — re-signing a paid load — is
                // refused by the server regardless (SIGNATURE_FROZEN).
                const { seller_signature, ...rest } = l;
                return {
                    ...rest,
                    // What the clients actually wanted all along.
                    seller_signed: !!seller_signature,
                    pdf_stale: !!l.pdf_link && (Number(l.pdf_template_version) || 0) < PDF_TEMPLATE_VERSION,
                    // payableOf, not l.amount — a load carrying a trucking
                    // deduction owes the seller less than the metal came to,
                    // and this is the figure both clients draw the card's
                    // outstanding balance from. Identical to l.amount on every
                    // load without one, which is all of them until she enters
                    // the first.
                    payment: paymentSummary(l.id, require('./helpers/loads').payableOf(l)),
                };
            }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // Item-type inventory + per-day rollup — per Apsara 2026-08-15. Computed
    // live on every request from helpers/loads.js's getInventoryReport, not
    // a stored/cached value, so a deleted load is reflected on the very
    // next call with no extra cleanup step. Optional ?from=YYYY-MM-DD and/or
    // ?to=YYYY-MM-DD (inclusive) narrow the range; omitted = all-time.
    // Visible to every role (staff included) — same as the rest of
    // /api/loads/* under STAFF_ALLOWED_PATH_PREFIXES, no extra gate needed.
    // Every line of ONE material, across every load — the detail behind an
    // Inventory row. Per Apsara 2026-09-02. Same optional from/to as the
    // report above, so opening a type while a date filter is applied shows
    // the lines from that window rather than silently all of them.
    //
    // Sits under /api/loads, so it is on the staff allowlist like the rest of
    // the yard screens — it exposes nothing a staff user cannot already see
    // on the load itself.
    app.get('/api/loads/inventory/items', (req, res) => {
        try {
            const { loadLoads, getItemLines } = require('./helpers/loads');
            const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined);
            res.json(getItemLines(loadLoads(), {
                description: req.query.description,
                from: ymd(req.query.from),
                to: ymd(req.query.to),
            }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/loads/inventory', (req, res) => {
        try {
            const { loadLoads, getInventoryReport } = require('./helpers/loads');
            res.json(getInventoryReport(loadLoads(), { from: req.query.from, to: req.query.to }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // On-demand Inventory tab export — Apsara 2026-08-15 ("export as
    // excel/pdf" via a "⋮" menu). Same optional from/to as the JSON route
    // above, so the download always matches exactly whatever's on screen.
    // Registered before /api/loads/:id for the same route-ordering reason
    // as /api/loads/inventory itself, even though :id only ever matches a
    // single path segment so "inventory" here couldn't collide anyway.
    function inventoryRangeLabel(from, to) {
        if (from && to) return `${from} to ${to}`;
        if (from) return `From ${from}`;
        if (to) return `Through ${to}`;
        return 'All time';
    }
    app.get('/api/loads/inventory/export.xlsx', async (req, res) => {
        try {
            const { loadLoads, getInventoryReport } = require('./helpers/loads');
            const { filteredInventoryWorkbookBuffer } = require('./helpers/inventoryExcel');
            const report = getInventoryReport(loadLoads(), { from: req.query.from, to: req.query.to });
            const buf = await filteredInventoryWorkbookBuffer(report, inventoryRangeLabel(req.query.from, req.query.to));
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename="inventory.xlsx"');
            res.send(Buffer.from(buf));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/loads/inventory/export.pdf', async (req, res) => {
        try {
            const { loadLoads, getInventoryReport } = require('./helpers/loads');
            const { generateInventoryExportPdf } = require('./helpers/pdf');
            const report = getInventoryReport(loadLoads(), { from: req.query.from, to: req.query.to });
            const buf = await generateInventoryExportPdf(inventoryRangeLabel(req.query.from, req.query.to), report);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename="inventory.pdf"');
            res.send(buf);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Staff-safe next-load-number floor — Apsara 2026-08-16 wants this in a
    // staff-facing mobile Settings panel too, alongside item description
    // delete. /api/settings itself stays requireAdmin (manager number, team
    // roster, WA groups, email cc/bcc, yard report toggle all live there —
    // none of that is staff's business). Rather than loosen that gate, this
    // is a narrow, single-field endpoint under /api/loads (already on
    // STAFF_ALLOWED_PATH_PREFIXES) that reads/writes ONLY next_load_number —
    // explicitly whitelisted, never spreads req.body into settings, so
    // there's no way to smuggle other settings fields through it.
    app.get('/api/loads/next-number', (req, res) => {
        try { res.json({ next_load_number: loadSettings().next_load_number ?? null }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.put('/api/loads/next-number', async (req, res) => {
        try {
            const raw = req.body.next_load_number;
            const val = (raw === null || raw === undefined || raw === '') ? null : parseInt(raw, 10);
            if (val !== null && !Number.isFinite(val)) return res.status(400).json({ error: 'next_load_number must be a number' });
            await saveSettings({ ...loadSettings(), next_load_number: val });
            res.json({ ok: true, next_load_number: val });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── REGISTRATION ORDER MATTERS HERE ───────────────────────────────────
    // Moved above /api/loads/:id on 2026-09-02. Express matches routes in the
    // order they are registered, and ':id' matches ANY single segment — so
    // with these declared afterwards, GET /api/loads/lookup was being served
    // by the :id handler, which looked for a load called "lookup", failed, and
    // returned 404. Same for /api/loads/stock and /api/loads/stock/suggest.
    //
    // NOT THEORETICAL: dashboard/outbound-loads.html calls /api/loads/lookup
    // to search loads when building a sale, and that search has been returning
    // 404 in production. tests/yard-stock.js stayed green because it asserts
    // the staff ALLOWLIST contains the path, not that the route resolves.
    //
    // Any future /api/loads/<literal> route must go above the :id line too.
    // Lightweight lookup for the outbound-load form's "link inbound loads"
    // picker — id/date/seller/net/amount only, not the full record (items,
    // photo links, etc.), since all this needs is enough to let Apsara pick
    // which purchase(s) this sale's material came from.
    app.get('/api/loads/lookup', (req, res) => {
        try {
            const { loadLoads } = require('./helpers/loads');
            const q = String(req.query.q || '').trim().toLowerCase();
            const rows = loadLoads()
                .filter((l) => !q || (l.id || '').toLowerCase().includes(q) || (l.seller || '').toLowerCase().includes(q))
                .slice(0, 50)
                .map((l) => ({ id: l.id, date: l.date, seller: l.seller, net_weight: l.net_weight, amount: l.amount, weight_unit: l.weight_unit }));
            res.json({ loads: rows });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // FIFO proposal for drawing a quantity of one material — the client shows
    // it pre-filled and she adjusts when reality differs (a specific pile went
    // into a specific container).
    app.get('/api/loads/stock/suggest', (req, res) => {
        try {
            const { loadLoads } = require('./helpers/loads');
            const { loadOutboundLoads } = require('./helpers/outboundLoads');
            const { suggestDraws } = require('./helpers/stock');
            res.json(suggestDraws(loadLoads(), loadOutboundLoads(), req.query.description || '', req.query.weight));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // ── Stock — what is still in the yard ───────────────────────────────────
    // Per Apsara 2026-08-24. Kept OFF /api/loads/inventory deliberately: she
    // asked for these to stay separate, so the Inventory tab remains the
    // purchase log it has always been and this is its own view. Same staff
    // visibility as the rest of /api/loads/*.
    app.get('/api/loads/stock', (req, res) => {
        try {
            const { loadLoads } = require('./helpers/loads');
            const { loadOutboundLoads } = require('./helpers/outboundLoads');
            const { stockReport, lotReport } = require('./helpers/stock');
            const inbound = loadLoads(), outbound = loadOutboundLoads();
            // unitCost is NOT hidden from staff, and briefly was — that was
            // wrong. Staff type the purchase price into every load they
            // create, so a per-lot cost derived from those same figures is
            // nothing they haven't already entered by hand. Hiding it here
            // while showing it on the form it came from is theatre, and
            // theatre in an access check is worse than none: it reads as a
            // boundary that isn't one.
            res.json({ byType: stockReport(inbound, outbound), lots: lotReport(inbound, outbound) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/loads/:id', (req, res) => {
        try {
            const { getLoad } = require('./helpers/loads');
            const load = getLoad(req.params.id);
            if (!load) return res.status(404).json({ error: 'not found' });
            res.json(load);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // Creates the load record, then uploads each ITEM's gross/tare photos to
    // Drive if provided — photos are per item now (a load can be several
    // items, each weighed separately), so this uploads up to 2 photos per
    // item instead of 2 total for the whole load. Fails soft per-photo — a
    // Drive outage on one item's photo never blocks the load itself or any
    // other item's photo; that link just stays null and can be retried later.
    app.post('/api/loads', largeJson, async (req, res) => {
        const b = req.body || {};
        try {
            const { addLoad, updateLoad } = require('./helpers/loads');
            const record = await addLoad({
                date: b.date, seller: b.seller, description: b.description,
                seller_address: b.seller_address, seller_phone: b.seller_phone,
                buyer: b.buyer, buyer_address: b.buyer_address,
                items: b.items, weight_unit: b.weight_unit,
                // Optional haulage deducted from what the seller is paid.
                // Unconditional here, unlike the edit route below: a CREATE
                // has no prior value to preserve, so absent means none.
                trucking_company: b.trucking_company, trucking_amount: b.trucking_amount,
                trucking_note: b.trucking_note,
                created_by: b.created_by || req.role || 'unknown',
                // One-time ticket — see helpers/oncePerSave.js.
                client_request_id: b.client_request_id,
                // The draft this load is being typed up from, if any. One
                // draft may become at most one load — Apsara, 2026-09-29:
                // "ALWAYS ONE LOAD SHOULD BE CREATED". Optional: absent is
                // the old behaviour, unchanged.
                draft_id: b.draft_id,
            });

            const { uploadScaleTicketImage } = require('./helpers/drive');
            const items = record.items || [];
            const inputItems = Array.isArray(b.items) ? b.items : [];
            let anyPhotoUploaded = false;
            // Photo failures are collected, not just logged. Still non-fatal —
            // the load saves either way — but the operator is told, instead of
            // discovering days later that a weight has no photo behind it.
            const photoFailures = [];
            await Promise.all(items.map(async (item, i) => {
                const input = inputItems[i] || {};
                const tag = `${record.id}-item${i}`;
                if (input.gross_photo_base64) {
                    try {
                        const f = await uploadScaleTicketImage(`${tag}-gross`, input.gross_photo_base64, input.gross_photo_mime, undefined, record.id);
                        item.gross_photo_drive_id = f.id; item.gross_photo_link = f.webViewLink;
                        anyPhotoUploaded = true;
                    } catch (e) {
                        console.error(`[API] gross photo upload failed for ${tag}:`, e.message);
                        // Recorded on the load, not just logged — see helpers/loadWarnings.js
                        photoFailures.push(`item ${i + 1} gross: ${e.message}`);
                    }
                }
                if (input.tare_photo_base64) {
                    try {
                        const f = await uploadScaleTicketImage(`${tag}-tare`, input.tare_photo_base64, input.tare_photo_mime, undefined, record.id);
                        item.tare_photo_drive_id = f.id; item.tare_photo_link = f.webViewLink;
                        anyPhotoUploaded = true;
                    } catch (e) {
                        console.error(`[API] tare photo upload failed for ${tag}:`, e.message);
                        // Recorded on the load, not just logged — see helpers/loadWarnings.js
                        photoFailures.push(`item ${i + 1} tare: ${e.message}`);
                    }
                }
            }));

            const finalLoads = anyPhotoUploaded ? await updateLoad(record.id, { items }) : null;
            let finalLoad = finalLoads ? finalLoads.find(l => l.id === record.id) : record;
            // Attach/clear the photo warning so the badge reflects THIS save:
            // a retry that succeeds must clear the previous complaint,
            // otherwise the badge becomes permanent and people learn to
            // ignore it.
            {
                const { buildWarning, setLoadWarnings, clearLoadWarnings } = require('./helpers/loadWarnings');
                const withWarn = photoFailures.length
                    ? await setLoadWarnings(record.id, [buildWarning('photo_upload_failed', photoFailures.join('; '))])
                    : await clearLoadWarnings(record.id, 'photo_upload_failed');
                if (withWarn) finalLoad = withWarn;
            }
            // Live sheet sync — per Apsara 2026-08-19. Fire-and-forget by
            // design: a Drive hiccup must never make saving a load fail, and
            // every sync rebuilds from loads.json anyway, so a missed one
            // self-heals on the next change. See helpers/sheetSync.js.
            require('./helpers/sheetSync').scheduleSync([require('./helpers/sheetSync').monthKeyFor(finalLoad && finalLoad.date)]);
            // The offered trucker bill — see helpers/loadTruckerBill.js. Runs
            // AFTER the load is safely written and never fails the save: the
            // metal is in the yard whether or not a debt to the hauler got
            // recorded, and a load that refuses to save because a second
            // ledger complained would be the worse bug by a distance. The
            // outcome rides back on the response so the screen can say what
            // happened instead of leaving a ticked box unexplained.
            let truckerBill = null;
            try {
                truckerBill = await require('./helpers/loadTruckerBill').maybeCreateTruckerBill(
                    finalLoad, { wanted: b.create_trucker_bill, createdBy: b.created_by || req.role || 'unknown' });
            } catch (e) {
                console.error('[API] trucker bill from load failed:', e.message);
                truckerBill = { skipped: true, reason: 'error', message: e.message };
            }
            res.json({ ok: true, load: finalLoad, trucker_bill: truckerBill });
        } catch (err) {
            // validateLoadForSave (helpers/loads.js) throws a plain Error
            // prefixed "Validation:" for a missing mandatory field — that's a
            // client mistake (400), not a server fault (500), so it's
            // surfaced distinctly here for correct status-code semantics/
            // monitoring, even though both paths return the same shape to
            // the UI, which already displays err.message either way.
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] create load failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });
    // Full edit (dashboard's Edit button — date/seller/description/items,
    // including added/removed line items). Mirrors POST /api/loads' photo
    // handling: each item's gross/tare photo is only re-uploaded if the
    // client sent NEW base64 data for it (i.e. the user actually re-captured
    // that item's photo); otherwise editLoad() already carried the item's
    // existing photo link forward untouched, so nothing to do here for it.
    app.put('/api/loads/:id', largeJson, async (req, res) => {
        const b = req.body || {};
        try {
            const { editLoad, getLoad, updateLoad } = require('./helpers/loads');
            const existing = getLoad(req.params.id);
            if (!existing) return res.status(404).json({ error: 'not found' });

            // Edit lock, per Apsara 2026-08-17 ("once pdf generated, edit
            // option should be locked. on clicking edit, it should ask
            // admin password to unlock and edit"). Enforced HERE, not just
            // hidden/disabled client-side — same "real, non-bypassable
            // gate" pattern validateLoadForSave already uses in
            // helpers/loads.js, so a direct API call can't skip it either.
            // Keyed off existing.status (helpers/loadsPdf.js stamps
            // 'pdf_generated' the moment a PDF is produced) rather than a
            // new field — that status already exists and is already
            // surfaced as the "PDF ready" badge in both UIs. cfg.ADMIN_PASSWORD
            // may be unset on some deployments (see /login's same check) —
            // treated as "no admin tier configured," so a locked load can
            // never be unlocked there rather than silently allowing it.
            //
            // NOTE: this block, and the /send-to-seller route below, went
            // missing from api.js once already this session (2026-08-17)
            // between when they were first written and when a later
            // "address book changes" commit landed — that commit's api.js
            // has the renumber fix but not these two, meaning something
            // outside this conversation (a manual edit, another tool, a
            // git checkout) touched this exact file mid-session. If this
            // keeps happening, it's worth checking whether anything else
            // is writing to api.js while I'm mid-edit on it.
            // NO EDIT LOCK. The admin-password gate that used to sit here was
            // removed 2026-08-20 per Apsara ("remove the admin password asking
            // for editing even for staff access") — it now applies to nobody,
            // not just admins.
            // Safe to drop because the PDF is not the record: loads.json is.
            // editLoad() already clears pdf_link/weights_pdf_link and resets
            // status to 'open' on every edit, so a corrected load cannot keep
            // serving a stale ticket as if it were current — Regenerate PDF
            // rebuilds it from the corrected numbers.

            const record = await editLoad(req.params.id, {
                date: b.date, seller: b.seller, description: b.description,
                seller_address: b.seller_address, seller_phone: b.seller_phone,
                buyer: b.buyer, buyer_address: b.buyer_address,
                items: b.items, weight_unit: b.weight_unit,
                // ── FORWARDED ONLY IF THE CLIENT SENT IT ─────────────────
                // Spread, not listed, and this is the point of the whole
                // design. The APK on her phone was built before trucking
                // existed and will keep PUTting loads without these keys for
                // as long as it takes to ship a new build. editLoad reads the
                // KEY'S PRESENCE as "the caller means to set this" — so if
                // this route named the fields unconditionally, `b.trucking_amount`
                // would arrive as undefined, editLoad would see the key, and
                // every edit made on her phone would wipe a deduction entered
                // at the desk. Absence has to travel all the way down as
                // absence, not as undefined.
                ...('trucking_company' in b ? { trucking_company: b.trucking_company } : {}),
                ...('trucking_amount'  in b ? { trucking_amount:  b.trucking_amount  } : {}),
                ...('trucking_note'    in b ? { trucking_note:    b.trucking_note    } : {}),
            });
            if (!record) return res.status(404).json({ error: 'not found' });

            const { uploadScaleTicketImage } = require('./helpers/drive');
            const items = record.items || [];
            const inputItems = Array.isArray(b.items) ? b.items : [];
            let anyPhotoUploaded = false;
            // Photo failures are collected, not just logged. Still non-fatal —
            // the load saves either way — but the operator is told, instead of
            // discovering days later that a weight has no photo behind it.
            const photoFailures = [];
            await Promise.all(items.map(async (item, i) => {
                const input = inputItems[i] || {};
                const tag = `${record.id}-item${i}`;
                if (input.gross_photo_base64) {
                    try {
                        const f = await uploadScaleTicketImage(`${tag}-gross`, input.gross_photo_base64, input.gross_photo_mime, undefined, record.id);
                        item.gross_photo_drive_id = f.id; item.gross_photo_link = f.webViewLink;
                        anyPhotoUploaded = true;
                    } catch (e) {
                        console.error(`[API] gross photo upload failed for ${tag}:`, e.message);
                        // Recorded on the load, not just logged — see helpers/loadWarnings.js
                        photoFailures.push(`item ${i + 1} gross: ${e.message}`);
                    }
                }
                if (input.tare_photo_base64) {
                    try {
                        const f = await uploadScaleTicketImage(`${tag}-tare`, input.tare_photo_base64, input.tare_photo_mime, undefined, record.id);
                        item.tare_photo_drive_id = f.id; item.tare_photo_link = f.webViewLink;
                        anyPhotoUploaded = true;
                    } catch (e) {
                        console.error(`[API] tare photo upload failed for ${tag}:`, e.message);
                        // Recorded on the load, not just logged — see helpers/loadWarnings.js
                        photoFailures.push(`item ${i + 1} tare: ${e.message}`);
                    }
                }
            }));

            const finalLoads = anyPhotoUploaded ? await updateLoad(record.id, { items }) : null;
            let finalLoad = finalLoads ? finalLoads.find(l => l.id === record.id) : record;
            // Attach/clear the photo warning so the badge reflects THIS save:
            // a retry that succeeds must clear the previous complaint,
            // otherwise the badge becomes permanent and people learn to
            // ignore it.
            {
                const { buildWarning, setLoadWarnings, clearLoadWarnings } = require('./helpers/loadWarnings');
                const withWarn = photoFailures.length
                    ? await setLoadWarnings(record.id, [buildWarning('photo_upload_failed', photoFailures.join('; '))])
                    : await clearLoadWarnings(record.id, 'photo_upload_failed');
                if (withWarn) finalLoad = withWarn;
            }
            // Live sheet sync. Passes BOTH the old and new month: an edit can
            // move a load across months (correcting a date from 08-01 to
            // 07-31), which would otherwise leave July's workbook stale.
            {
                const sheetSync = require('./helpers/sheetSync');
                sheetSync.scheduleSync([sheetSync.monthKeyFor(existing.date), sheetSync.monthKeyFor(finalLoad && finalLoad.date)]);
            }
            // Same offer on an edit — she may add the haulage after the fact,
            // once the hauler's invoice turns up. maybeCreateTruckerBill
            // refuses to write a second bill against a ticket that already has
            // one and reports the existing id instead, so ticking the box
            // twice cannot double her payable.
            let truckerBill = null;
            try {
                truckerBill = await require('./helpers/loadTruckerBill').maybeCreateTruckerBill(
                    finalLoad, { wanted: b.create_trucker_bill, createdBy: b.created_by || req.role || 'unknown' });
            } catch (e) {
                console.error('[API] trucker bill from load failed:', e.message);
                truckerBill = { skipped: true, reason: 'error', message: e.message };
            }
            res.json({ ok: true, load: finalLoad, trucker_bill: truckerBill });
        } catch (err) {
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] edit load failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });
    // Deletes the loads.json record only — see helpers/loads.js's deleteLoad
    // for why Drive photos/PDFs are deliberately left alone.
    app.delete('/api/loads/:id', async (req, res) => {
        try {
            const { deleteLoad, getLoad } = require('./helpers/loads');
            // Read the date BEFORE deleting — afterwards the record is gone
            // and there's no way to know which month's workbook to rebuild.
            const doomed = getLoad(req.params.id);
            const doomedMonth = doomed && doomed.date;

            // ── the payment lock, ON THE SERVER ───────────────────────────
            // Added 2026-09-03, and it is new. "A load cannot be deleted once
            // it has been paid against" has been a rule since the load card
            // was built, and until now it was enforced by NOT RENDERING THE
            // BUTTON — in both clients, and nowhere else. Any request that
            // reached this route deleted the load and its payments no matter
            // what had been paid, and this route is not even behind
            // requireAdmin: it sits under /api/loads, which staff can reach.
            // The rule was a suggestion made of HTML.
            //
            // So this guard is not scaffolding for the Jarvis profile. It is
            // the rule finally being enforced, and the profile is the reason
            // it got looked at.
            const audit = require('./helpers/audit');
            const paidRows = require('./helpers/payments').paymentsForLoad(req.params.id);
            const paidTotal = paidRows.reduce((a, p) => a + (Number(p.amount) || 0), 0);
            if (paidTotal > 0 && !isSuper(req)) {
                await audit.refused({
                    action: 'delete-paid-load', subject: req.params.id,
                    actor: actorOf(req), role: req.role, ip: req.ip,
                    detail: { paid: paidTotal, payments: paidRows.length },
                    reason: 'load has payments against it',
                });
                return res.status(409).json({
                    error: 'This load has payments recorded against it. Remove the payments first, or sign in with the Jarvis profile.',
                    code: 'LOAD_HAS_PAYMENTS', paid: paidTotal,
                });
            }

            // Everything worth knowing is captured BEFORE the delete, because
            // in a moment none of it will exist anywhere else. Written first
            // and stamped after, so a crash mid-delete still leaves a trace of
            // who asked — see helpers/audit.js.
            let entry = null;
            if (paidTotal > 0) {
                entry = await audit.record({
                    action: 'delete-paid-load', subject: req.params.id,
                    actor: actorOf(req), role: req.role, ip: req.ip,
                    detail: {
                        seller: doomed && doomed.seller, date: doomedMonth,
                        amount: doomed && doomed.amount, paid: paidTotal,
                        payments: paidRows.map((p) => ({ id: p.id, mode: p.mode, amount: p.amount, paid_on: p.paid_on })),
                    },
                });
            }

            const found = await deleteLoad(req.params.id);
            if (!found) {
                if (entry) await audit.complete(entry, 'failed', { reason: 'load not found' });
                return res.status(404).json({ error: 'not found' });
            }
            // Payments follow the load. A deleted load leaving its
            // receipts behind would sum against nothing and quietly inflate
            // any future "what have we paid" figure. Cash payments are
            // refunded to petty cash on the way out — see
            // deletePaymentsForLoad — so erasing a paid load does not silently
            // leave the drawer reading low.
            const removedPayments = await require('./helpers/payments').deletePaymentsForLoad(req.params.id);
            if (entry) await audit.complete(entry, 'done', { payments_removed: removedPayments });

            // Live sheet sync — this is the "if load deleted, modify
            // accordingly" half of the requirement. Works with no delete
            // handling of its own because every sync rebuilds from current
            // loads.json: the deleted load simply isn't there anymore.
            {
                const sheetSync = require('./helpers/sheetSync');
                sheetSync.scheduleSync([sheetSync.monthKeyFor(doomedMonth)]);
            }
            // Per Apsara 2026-08-15: deleting a load (from mobile or the
            // dashboard — both hit this same route) now also removes its
            // Drive artifacts, not just the JSON record. Gross/tare photos
            // and generated PDFs for a load all live in ONE Drive subfolder
            // (see helpers/drive.js's getOrCreateLoadSubfolder), so trashing
            // that one folder cleans up everything. Trashed, not permanently
            // deleted — recoverable from Drive's Trash for 30 days if this
            // was a mistake. Best-effort AFTER the JSON delete already
            // succeeded: a Drive hiccup must not make the load
            // un-deletable, and the load record itself is already gone by
            // this point regardless of what happens here.
            try {
                const { trashLoadFolder } = require('./helpers/drive');
                await trashLoadFolder(req.params.id);
            } catch (driveErr) {
                console.warn(`[API] Drive cleanup failed for deleted load ${req.params.id}:`, driveErr.message);
            }
            res.json({ ok: true });
        } catch (err) {
            console.error('[API] delete load failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Outbound loads — mirror of /api/loads above, for material SOLD/
    // SHIPPED OUT to a real buyer (Eccomelt or anyone else — general-
    // purpose, see helpers/outboundLoads.js's header). Deliberately NOT on
    // STAFF_ALLOWED_PATH_PREFIXES: unlike the yard scale-weighing workflow
    // (a physical floor task staff already own), a sale record carries
    // buyer pricing — a business-data exposure call Apsara didn't ask for,
    // so this defaults to normal authenticated (manager/team) access only.
    // No photo/Drive/PDF integration (not asked for) — a plain CRUD store.
    // ── Edge Yard helper bot ──────────────────────────────────────────────
    // Per Apsara 2026-08-28: a bot that knows the yard and answers questions
    // about the data. Extended 2026-08-29 — "it can do anything but within
    // scope of edge yard" — so it can now also PROPOSE an action.
    //
    // Still kept firmly separate from /api/bot/command, which routes into
    // workflow/brain.js and can message truckers, book loads and send WhatsApp
    // for real. Asking "how much do we owe Acme?" must not be one keystroke
    // away from messaging Acme. This endpoint has no route into the brain, and
    // this route itself still writes NOTHING: the most it returns is a
    // validated proposal that /api/yard/act below can execute after a human
    // confirms it. Answering and acting stay two separate requests with a
    // person in between.
    //
    // Figures come from helpers/yardBrief.js, computed by the same code the
    // screens use. The model may reason over them and do its own arithmetic
    // (her call, 2026-08-29) but is told to prefer the pre-computed exact
    // figures wherever one fits — a fluent, confident, slightly-wrong number
    // about money is still the worst failure this could have.
// @@chunk-end

};
