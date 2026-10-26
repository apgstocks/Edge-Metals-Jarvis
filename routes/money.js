// routes/money.js — split from api.js (helpers/sourceParts.js reconstructs the original)
module.exports = function (app, ctx) {
    const { actorOf, largeJson, requireSuper } = ctx;
// @@chunk-start
    app.get('/api/bill-payments', (req, res) => {
        try {
            const bp = require('./helpers/billPayments');
            const b = require('./helpers/bills');
            const unpaid = b.listWithTotals()
                .filter((x) => (x.balance === null ? false : x.balance > 0.005))
                .map((x) => ({ id: x.id, date: x.date, supplier: x.supplier,
                               container_no: x.container_no, booking_no: x.booking_no,
                               amount: x.amount, paid: x.paid, balance: x.balance }));
            res.json({
                payments: bp.list(),
                summary: bp.summary(),
                // What is still owed, so the pay form can list containers to
                // tick rather than making her remember which are open.
                open_bills: unpaid,
                credit: bp.creditBySupplier(),
                // The individual advances behind those totals, so the panel can
                // show WHICH payment is sitting unapplied and from when — a
                // total alone does not tell her what to go and look at.
                // Only the ones with something left; a fully applied advance is
                // history, not an open item.
                advances: bp.advancesFor(null).filter((a) => (a.available || 0) > 0.005),
                modes: bp.BILL_PAYMENT_MODES,
                banks: require('./helpers/banks').options(),
                other: require('./helpers/banks').OTHER,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/bill-payments', async (req, res) => {
        try {
            const bp = require('./helpers/billPayments');
            const body = { ...(req.body || {}), created_by: (req.role || null) };
            const rec = body.kind === 'advance'
                ? await bp.addAdvance(body)
                : await bp.addBillPayment(body);
            require('./helpers/quickbooks/sync').after('billpayment', rec && rec.id);
            require('./helpers/shipmentSheetLog');   // loaded lazily elsewhere
            // Every container this touched moves in the sheet too — its
            // Balance changed, and the Shipment tab is meant to mirror the
            // bill. Non-fatal, coalesced, same as any other bill write.
            try {
                const bills = require('./helpers/bills');
                const ship = require('./helpers/shipmentSheetLog');
                const paid = bp.paidByBill();
                for (const a of (rec.allocations || [])) {
                    const bill = bills.list().find((x) => x.id === a.bill_id);
                    if (bill) ship.logBillSafely({ ...bill, paid: paid[bill.id] || 0 }, 'paid');
                }
            } catch (e) { console.warn('[BILL-PAY] sheet mirror skipped:', e.message); }
            res.json({ ok: true, payment: rec });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Applying an advance moves NO money — it attaches credit that was
    // already paid and already counted. See billPayments.applyAdvance.
    app.post('/api/bill-payments/:id/apply', async (req, res) => {
        try {
            const bp = require('./helpers/billPayments');
            const rec = await bp.applyAdvance(String(req.params.id), (req.body || {}).allocations || []);
            require('./helpers/quickbooks/sync').after('billpayment', rec && rec.id);
            res.json({ ok: true, payment: rec });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── DELETING A PAYMENT ───────────────────────────────────────────────
    // Apsara, 2026-09-10: "Now i want to have delete option in payment".
    //
    // Two things were missing here before the button existed, and adding the
    // button without them would have made both easy to hit:
    //
    // 1. NO AUDIT. Money coming off the record is the single most
    //    consequential thing this file does, and the Yard has audited its
    //    equivalent since 2026-08-30 (delete-payment, delete-paid-trucker-
    //    bill). Edge Metals is a different company, not a lower standard.
    //
    // 2. NO SHEET MIRROR. POST /api/bill-payments rewrites the Shipment tab
    //    rows for every container it touched, because Paid and Balance moved.
    //    DELETE moved exactly the same numbers back and told the sheet
    //    nothing — so her Edge Metals Shipment tab would have kept showing a
    //    payment that no longer exists, and the only place the two disagreed
    //    is the place she actually reads.
    //
    // Deleting an ADVANCE also un-applies whatever it was covering, which
    // raises those containers' balances. That is correct, and it is why the
    // response says which containers moved: the UI names them before asking.
    // ── EDITING A RECORDED PAYMENT ───────────────────────────────────────
    // Apsara, 2026-10-07: "give option to pay multiple invoices together and
    // option to edit". Paying several at once already worked; editing existed
    // on no payment path at all, so a typo meant delete-and-re-enter, which
    // reopens containers in between and loses what the original said.
    //
    // Six routes, three pairs. The PREVIEW is a separate GET that writes
    // nothing — her rule was "Recompute everything, show me before saving",
    // and a screen cannot honour that if the only way to find out is to do it.
    //
    // requireSuper on every one, matching DELETE beside it: changing what a
    // payment settled moves a supplier's running account and reopens
    // containers, which is the reason Edge Metals ledger changes are the
    // Jarvis profile's (her rule, 2026-09-16). Office staff hold the admin
    // password — she confirmed that on 2026-10-06 — so admin is not enough.
    //
    // The QuickBooks refusal lives in the helpers, not here, so the voice
    // path and any future caller get it too. api.js only reports it.
    // ── EDITING A RECORDED PAYMENT ───────────────────────────────────────
    // Apsara, 2026-10-07: "give option to pay multiple invoices together and
    // option to edit". Paying several at once already worked; editing existed
    // on no payment path at all, so a typo meant delete-and-re-enter, which
    // reopens containers in between and loses what the original said.
    //
    // TWO ROUTES, FOR THE ONE SCREEN THAT CALLS THEM. The helpers also carry
    // editSettlement and editTruckingPayment, and they are deliberately NOT
    // routed yet: tests/route-reach.js refuses a guarded route with no
    // client, and it is right to — "a guarded route nothing calls is a
    // permission that cannot be used". #152 and #165 are both that mistake.
    // Those two get their routes when their screens are built.
    //
    // REGISTERED EXPLICITLY, not in a loop over a table. A first version did
    // the clever thing and check-route-reach.js read the path as the literal
    // "/api/${slug}/:id" — defeating the very guard that exists because
    // routes went dead here before. The repo's tooling reads source, so
    // source is what has to be readable.
    //
    // requireSuper on both, matching DELETE beside them: changing what a
    // payment settled moves a supplier's running account and reopens
    // containers, which is why Edge Metals ledger changes are the Jarvis
    // profile's (her rule, 2026-09-16, and office staff hold the admin
    // password — she confirmed that on 2026-10-06).
    //
    // The QuickBooks refusal lives in the helper, not here, so the voice path
    // and any future caller inherit it. api.js only reports it.

    // Show, change nothing — "Recompute everything, show me before saving".
    app.post('/api/bill-payments/:id/preview-edit', requireSuper, largeJson, async (req, res) => {
        try {
            const bp = require('./helpers/billPayments');
            return res.json({ ok: true, plan: bp.previewEdit(String(req.params.id), req.body || {}) });
        } catch (e) {
            // A refusal is a sentence she can act on — an unknown bank, a
            // mode that is not offered. 400, not 500: nothing is broken.
            const msg = String((e && e.message) || e);
            return res.status(/^no payment/.test(msg) ? 404 : 400).json({ error: msg });
        }
    });

    // And then do it.
    app.put('/api/bill-payments/:id', requireSuper, largeJson, async (req, res) => {
        try {
            const bp = require('./helpers/billPayments');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            if (!bp.list().find((p) => p && p.id === id)) {
                return res.status(404).json({ error: `no payment ${id}` });
            }
            const result = await bp.editBillPayment(id, req.body || {}, { actor: actorOf(req) });

            // Audited with both sides. The helper keeps edit_history on the
            // row too; this is the same event where she reads who changed what.
            await audit.record({
                action: 'edit-bill-payment', subject: id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { company: 'edge-metals', before: result.before,
                    after: result.after, changes: result.changes },
            }).catch(() => {});

            return res.json({ ok: true, ...result });
        } catch (e) {
            const msg = String((e && e.message) || e);
            // The QuickBooks refusal is a 409: the request is fine, the state
            // of her books is what says no.
            const code = /QuickBooks/.test(msg) ? 409 : /^no payment/.test(msg) ? 404 : 400;
            return res.status(code).json({ error: msg });
        }
    });

    app.delete('/api/bill-payments/:id', requireSuper, async (req, res) => {
        try {
            const bp = require('./helpers/billPayments');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            // Read the allocations BEFORE the row is gone — afterwards there
            // is nothing left to say which containers to re-mirror.
            const doomed = bp.list().find((p) => p.id === id) || null;
            if (!doomed) return res.status(404).json({ error: `no payment ${id}` });
            const touched = (doomed.allocations || []).map((a) => a.bill_id);

            const entry = await audit.record({
                action: doomed.kind === 'advance' ? 'delete-bill-advance' : 'delete-bill-payment',
                subject: id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: {
                    company: 'edge-metals',
                    date: doomed.date, mode: doomed.mode, bank: doomed.bank,
                    ref: doomed.ref, supplier: doomed.supplier, amount: doomed.amount,
                    allocations: doomed.allocations || [],
                },
            });

            await bp.deleteBillPayment(id);
            require('./helpers/quickbooks/sync').after('billpayment', id, 'deleted');
            await audit.complete(entry, 'done', { containers_reopened: touched.length });

            // Same mirror as the POST path, same non-fatal treatment.
            try {
                const bills = require('./helpers/bills');
                const ship = require('./helpers/shipmentSheetLog');
                const paid = bp.paidByBill();
                for (const billId of touched) {
                    const bill = bills.list().find((x) => x.id === billId);
                    if (bill) ship.logBillSafely({ ...bill, paid: paid[bill.id] || 0 }, 'payment-removed');
                }
            } catch (e) { console.warn('[BILL-PAY] sheet mirror skipped:', e.message); }

            res.json({ ok: true, removed: true, containers_reopened: touched });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── MONEY IN FROM CUSTOMERS ──────────────────────────────────────────
    // Apsara, 2026-09-10: "In outgoing-give the option as mark as paid..
    // sometimes there might be a deduction in received amount because of wire
    // deduction by bank".
    //
    // Mark-as-paid is a POST here with the balance allocated and the shortfall
    // classified — NOT a flag on the container. See the header of
    // helpers/salesReceipts.js for why a boolean would have been wrong.
    app.get('/api/sales-receipts', (req, res) => {
        try {
            const r = require('./helpers/salesReceipts');
            const s = require('./helpers/sales');
            const outstanding = s.listWithTotals()
                .filter((x) => (x.balance === null ? false : x.balance > 0.005))
                .map((x) => ({ id: x.id, date: x.date, customer: x.customer,
                               booking_no: x.booking_no, container_no: x.container_no,
                               invoice_no: x.invoice_no, amount: x.amount,
                               receivable: x.receivable, received: x.received,
                               deducted: x.deducted, balance: x.balance }));
            res.json({
                receipts: r.list(),
                summary: r.summary(),
                open_invoices: outstanding,
                modes: r.RECEIPT_MODES,
                deduction_reasons: r.DEDUCTION_REASONS,
                banks: require('./helpers/banks').options(),
                other: require('./helpers/banks').OTHER,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/sales-receipts', async (req, res) => {
        try {
            const r = require('./helpers/salesReceipts');
            const rec = await r.addReceipt({ ...(req.body || {}), created_by: (req.role || null) });
            require('./helpers/quickbooks/sync').after('receipt', rec && rec.id);
            res.json({ ok: true, receipt: rec });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Audited, for the same reason the purchase side is: money coming off the
    // record is the most consequential thing these routes do.
    app.delete('/api/sales-receipts/:id', requireSuper, async (req, res) => {
        try {
            const r = require('./helpers/salesReceipts');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            const doomed = r.list().find((x) => x.id === id);
            if (!doomed) return res.status(404).json({ error: `no receipt ${id}` });

            const entry = await audit.record({
                action: 'delete-sales-receipt', subject: id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: {
                    company: 'edge-metals', date: doomed.date, mode: doomed.mode,
                    bank: doomed.bank, ref: doomed.ref, customer: doomed.customer,
                    amount: doomed.amount, allocations: doomed.allocations || [],
                },
            });
            await r.deleteReceipt(id);
            require('./helpers/quickbooks/sync').after('receipt', id, 'deleted');
            await audit.complete(entry, 'done',
                { containers_reopened: (doomed.allocations || []).length });
            res.json({ ok: true, removed: true,
                       containers_reopened: (doomed.allocations || []).map((a) => a.sale_id) });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── WHAT A SALE COSTS, AND PAYING IT OFF ─────────────────────────────
    // Her answer, asked whether freight and commission are settled
    // separately: "Yes — both get settled separately."
    // ── A SALE STARTS FROM THE BILL IT WAS BOUGHT ON ─────────────────────
    // Apsara, 2026-09-10, asked how a Sales row should be created: "From the
    // matching Bill."
    //
    // It carries the container number across rather than having it typed a
    // second time — which is the whole reason margin-per-container works at
    // all. A typo here breaks the join silently: no error, just a container
    // that cost something and earned nothing.
    //
    // A SUGGESTION, not a save. Same contract as /api/bills/from-booking:
    // nothing is written until she presses save on the form.
    app.get('/api/sales/from-bill/:billId', (req, res) => {
        try {
            const b = require('./helpers/bills');
            const s = require('./helpers/sales');
            const bill = b.listWithTotals().find((x) => x.id === String(req.params.billId));
            if (!bill) return res.status(404).json({ error: 'no such bill' });

            const already = s.list().find((x) =>
                String(x.booking_no || '').trim().toUpperCase() === String(bill.booking_no || '').trim().toUpperCase()
                && String(x.container_no || '').trim().toUpperCase() === String(bill.container_no || '').trim().toUpperCase()
                && String(bill.container_no || '').trim());

            res.json({
                ok: true,
                suggestion: {
                    booking_no: bill.booking_no || '',
                    container_no: bill.container_no || '',
                    item: bill.description || '',
                    // The purchased weight, as a STARTING point. The invoiced
                    // weight is what the customer is billed and can differ
                    // after reweighing — and commission runs off the invoiced
                    // one, so this must stay editable rather than derived.
                    weight: bill.net_lb === null || bill.net_lb === undefined ? '' : bill.net_lb,
                    weight_unit: 'lb',
                    hbl_no: '', date: '',
                },
                bill: { id: bill.id, supplier: bill.supplier, amount: bill.amount,
                        net_lb: bill.net_lb, net_mt: bill.net_mt, route: bill.route },
                // Reported so the form can say so rather than making a second
                // row that would double-count on the join.
                already_sold: already ? { id: already.id, invoice_no: already.invoice_no || null } : null,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // The bills she has bought that have no sale against them yet.
    app.get('/api/sales/sellable', (req, res) => {
        try {
            const b = require('./helpers/bills');
            const s = require('./helpers/sales');
            const sold = new Set(s.list().map((x) =>
                `${String(x.booking_no || '').trim().toUpperCase()}|${String(x.container_no || '').trim().toUpperCase()}`));
            const rows = b.listWithTotals()
                .filter((x) => String(x.container_no || '').trim())
                .map((x) => ({ id: x.id, booking_no: x.booking_no || '', container_no: x.container_no,
                               supplier: x.supplier || '', description: x.description || '',
                               net_lb: x.net_lb, amount: x.amount,
                               sold: sold.has(`${String(x.booking_no || '').trim().toUpperCase()}|${String(x.container_no || '').trim().toUpperCase()}`) }));
            res.json({ bills: rows, unsold: rows.filter((x) => !x.sold).length });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── EDGE METALS HAULAGE ──────────────────────────────────────────────
    // Apsara, 2026-09-10: "Similar to sales,crate a tab called Trucking,and
    // put all the relevant details from bill to this..give an option to pay.
    // Also give an option to filter by date,month,trucking company,status".
    //
    // The rows are DERIVED from the bills — nothing is copied into a store of
    // its own — and the filters run here so the summary always describes the
    // rows on screen.
    // ── WHAT A CONTAINER MADE ────────────────────────────────────────────
    // The join the container-grain rebuild was for. Bills and Sales are keyed
    // on the same booking + container, so what a box cost and what it sold
    // for can finally be subtracted.
    app.get('/api/margin', (req, res) => {
        try {
            const m = require('./helpers/margin');
            const all = m.rows();
            const rows = m.filterRows(all, req.query || {});
            res.json({
                rows,
                summary: m.summary(rows),
                total_unfiltered: all.length,
                facets: m.facets(all),
                states: m.STATES,
                // Rows with no container number can never join. Reported so
                // an unmatched bill is something she can fix rather than a
                // margin that quietly never appears.
                unjoinable: m.unjoinable(),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Invoice register: Zimex / Jio / Sher / Pan Metal / AJ Transport / Garduno's ──
    // Rows come from scripts/party-invoices-import.js (the email sweep's export) or
    // POST /api/party-invoices/sync (the sheet tabs). It is not a bill, sale or book
    // entry; payments here (helpers/partyInvoices.js) are a register-only record and
    // post nothing to bills, the books, bank matching or QuickBooks.
    app.get('/api/party-invoices', (req, res) => {
        try {
            const pi = require('./helpers/partyInvoices');
            const pays = pi.payments();
            const all = pi.withPaid(pi.list(), pays);
            const { party, status, pay, q } = req.query || {};
            const needle = String(q || '').trim().toLowerCase();
            const rows = all.filter((r) => (!party || r.party === party)
                && (!status || (status === 'on_sheet' ? (r.check_status === 'verified' || r.check_status === 'match') : r.check_status === status))
                && (!pay || r.pay_status === pay)
                && (!needle || [r.invoice_no, r.container_no, r.booking_no, r.hbl_no].some((v) => String(v || '').toLowerCase().includes(needle))));
            res.json({ rows, summary: pi.summary(pi.list()), parties: pi.PARTIES, modes: pi.MODES, payments: pays, lock: pi.lockState() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Edit one line. Locks it, so a re-import or a sheet sync never overwrites the edit.
    app.put('/api/party-invoices/:id', async (req, res) => {
        try {
            const pi = require('./helpers/partyInvoices');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            const before = pi.list().find((r) => r.id === id);
            if (!before) return res.status(404).json({ error: `no invoice line ${id}` });
            const row = await pi.editRow(id, req.body || {}, { actor: actorOf(req), enforceLock: true });
            await audit.record({ action: 'edit-party-invoice', subject: id, actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { company: 'edge-metals', party: before.party, invoice_no: before.invoice_no, before: Object.fromEntries(Object.keys(req.body || {}).filter((k) => pi.EDITABLE.includes(k)).map((k) => [k, before[k] === undefined ? null : before[k]])) } });
            res.json({ ok: true, row });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete('/api/party-invoices/:id', requireSuper, async (req, res) => {
        try {
            const pi = require('./helpers/partyInvoices');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            const doomed = pi.list().find((r) => r.id === id);
            if (!doomed) return res.status(404).json({ error: `no invoice line ${id}` });
            const entry = await audit.record({ action: 'delete-party-invoice', subject: id, actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { company: 'edge-metals', party: doomed.party, invoice_no: doomed.invoice_no, container_no: doomed.container_no, booking_no: doomed.booking_no, amount: doomed.amount } });
            await pi.deleteRow(id, { enforceLock: true });
            await audit.complete(entry, 'done', {});
            res.json({ ok: true, removed: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // THE ONE LOCK over the register and the carrier lists. Locked by default; unlocking makes every
    // line editable and gives each row Copy and Delete. It closes by itself (helpers/partyInvoices.LOCK_MS).
    app.post('/api/party-invoices/lock', async (req, res) => {
        try {
            const pi = require('./helpers/partyInvoices');
            const unlock = !!(req.body || {}).unlock;
            const state = await pi.setLock(unlock, { actor: actorOf(req) });
            await require('./helpers/audit').record({ action: unlock ? 'unlock-party-invoices' : 'lock-party-invoices', subject: 'party-invoices', actor: actorOf(req), role: req.role, ip: req.ip, detail: { company: 'edge-metals', until: state.until } });
            res.json({ ok: true, lock: state });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/party-invoices/:id/copy', async (req, res) => {
        try {
            const pi = require('./helpers/partyInvoices');
            const row = await pi.copyRow(String(req.params.id), { actor: actorOf(req), enforceLock: true });
            await require('./helpers/audit').record({ action: 'copy-party-invoice', subject: row.id, actor: actorOf(req), role: req.role, ip: req.ip, detail: { company: 'edge-metals', copied_from: row.copied_from } });
            res.json({ ok: true, row });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ONE payment, MANY lines: { amount, paid_on, mode, ref?, note?, allocations: [{ row_id, amount }] }.
    app.post('/api/party-invoice-payments', async (req, res) => {
        try {
            const pi = require('./helpers/partyInvoices');
            const audit = require('./helpers/audit');
            const rec = await pi.addPayment(req.body || {}, { actor: actorOf(req) });
            await audit.record({ action: 'pay-party-invoices', subject: rec.id, actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { company: 'edge-metals', party: rec.party, amount: rec.amount, mode: rec.mode, paid_on: rec.paid_on, lines: rec.allocations.length } });
            res.json({ ok: true, payment: rec });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete('/api/party-invoice-payments/:id', requireSuper, async (req, res) => {
        try {
            const pi = require('./helpers/partyInvoices');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            const doomed = pi.payments().find((p) => p.id === id);
            if (!doomed) return res.status(404).json({ error: `no payment ${id}` });
            const entry = await audit.record({ action: 'delete-party-invoice-payment', subject: id, actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { company: 'edge-metals', party: doomed.party, amount: doomed.amount, mode: doomed.mode, paid_on: doomed.paid_on, allocations: doomed.allocations } });
            await pi.deletePayment(id);
            await audit.complete(entry, 'done', { reopened: doomed.allocations.length });
            res.json({ ok: true, removed: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Sync from the Google tabs. ?dry=1 reports without writing. Only ADDS lines Jarvis lacks;
    // a line that already exists is never changed — a differing amount is reported.
    app.post('/api/party-invoices/sync', async (req, res) => {
        try {
            const sync = require('./helpers/partyInvoiceSheetSync');
            const dry = String(req.query.dry || (req.body || {}).dry || '') === '1' || (req.body || {}).dry === true;
            res.json({ ok: true, ...(await sync.sync({ dryRun: dry, readTabsFn: app.locals.partyInvoiceReadTabs })) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Edge Metals carrier invoices (NTG / TQL / Schneider) ─────────────
    // READ for everyone; two WRITE routes below for rows she adds by hand.
    // Rows still come from scripts/carrier-invoices-import.js in the normal
    // case, and nothing else reads this store (helpers/carrierInvoices.js).
    //
    // The comment here used to say READ-ONLY and that stopped being true on
    // 2026-10-08 — Apsara: "If source is manual ,pay button can be there na".
    // Saying so rather than leaving the old claim, because a stale "nothing
    // here writes" is exactly the kind of note someone trusts later.
    app.get('/api/carrier-invoices', (req, res) => {
        try {
            const ci = require('./helpers/carrierInvoices');
            const all = ci.list();
            const { carrier, status } = req.query || {};
            const rows = all.filter((r) => (!carrier || r.carrier === carrier) && (!status || r.status === status));
            res.json({ rows, summary: ci.summary(all), carriers: ci.CARRIERS, statuses: ci.STATUSES });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── A CARRIER INVOICE SHE TYPES ───────────────────────────────────────
    // Apsara, 2026-10-08: "If source is manual ,pay button can be there na".
    //
    // requireSuper, matching every other path that moves Edge Metals money:
    // her rule from 2026-09-16, and office staff hold the admin password.
    app.post('/api/carrier-invoices', requireSuper, largeJson, async (req, res) => {
        try {
            const ci = require('./helpers/carrierInvoices');
            const audit = require('./helpers/audit');
            const row = await ci.addManual(req.body || {}, { actor: actorOf(req) });
            await audit.record({
                action: 'add-carrier-invoice', subject: row.id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { company: 'edge-metals', carrier: row.carrier, ref: row.ref,
                    amount: row.amount, source: 'manual' },
            }).catch(() => {});
            return res.json({ ok: true, row });
        } catch (e) { return res.status(400).json({ error: String((e && e.message) || e) }); }
    });

    // ── PAYING ONE ────────────────────────────────────────────────────────
    // The helper refuses an IMPORTED row and says why; this only reports it.
    // 409 rather than 400 for that case: the request is well formed, it is the
    // row's own provenance that says no.
    app.post('/api/carrier-invoices/:id/pay', requireSuper, largeJson, async (req, res) => {
        try {
            const ci = require('./helpers/carrierInvoices');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            const row = await ci.payManual(id, req.body || {}, { actor: actorOf(req) });
            await audit.record({
                action: 'pay-carrier-invoice', subject: id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { company: 'edge-metals', carrier: row.carrier, ref: row.ref,
                    amount: Number((req.body || {}).amount), paid: row.paid, status: row.status },
            }).catch(() => {});
            return res.json({ ok: true, row });
        } catch (e) {
            const msg = String((e && e.message) || e);
            const code = /own email/.test(msg) ? 409 : /^no carrier invoice/.test(msg) ? 404 : 400;
            return res.status(code).json({ error: msg });
        }
    });

    app.get('/api/metals-trucking', (req, res) => {
        try {
            const mt = require('./helpers/metalsTrucking');
            const all = mt.payables();
            const rows = mt.filterPayables(all, req.query || {});
            res.json({
                payables: rows,
                open_payables: rows.filter((r) => r.balance > 0.005),
                summary: mt.summary(rows),
                total_unfiltered: all.length,
                facets: mt.facets(all),
                payments: mt.list(),
                modes: mt.TRUCKING_MODES,
                statuses: mt.STATUSES,
                banks: require('./helpers/banks').options(),
                other: require('./helpers/banks').OTHER,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/metals-trucking', async (req, res) => {
        try {
            const mt = require('./helpers/metalsTrucking');
            const rec = await mt.addTruckingPayment({ ...(req.body || {}), created_by: (req.role || null) });
            res.json({ ok: true, payment: rec });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete('/api/metals-trucking/:id', requireSuper, async (req, res) => {
        try {
            const mt = require('./helpers/metalsTrucking');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            const doomed = mt.list().find((x) => x.id === id);
            if (!doomed) return res.status(404).json({ error: `no payment ${id}` });
            const entry = await audit.record({
                action: 'delete-metals-trucking', subject: id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: {
                    company: 'edge-metals', date: doomed.date, mode: doomed.mode,
                    bank: doomed.bank, trucking_company: doomed.trucking_company,
                    amount: doomed.amount, allocations: doomed.allocations || [],
                },
            });
            await mt.deleteTruckingPayment(id);
            await audit.complete(entry, 'done', { reopened: (doomed.allocations || []).length });
            res.json({ ok: true, removed: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── THE BOOKS: TRIAL BALANCE, LEDGER, P&L, BALANCE SHEET ──────────────
    // Apsara, 2026-10-06: "Make the qb thing as separate portal" and "Include
    // all the options oin quickbook and beter than it".
    //
    // The engine for this shipped on 2026-10-06 — helpers/entities.js,
    // chartOfAccounts.js, postings.js, statements.js, booksBuild.js, 1,344
    // lines and some 370 assertions — AND NOTHING COULD REACH IT. No route,
    // no screen. She could not look at a single statement. That is the same
    // dead-code failure scripts/check-route-reach.js exists to catch, and the
    // guard could not see it because there was no route to be unreachable.
    // Writing the engine and stopping is the mistake; this is the other half.
    //
    // ── ONE BUILD SERVES ALL FOUR STATEMENTS ──────────────────────────────
    // booksBuild.build() re-derives the journal from her stores on every call
    // — nothing is stored, so there is never a second truth to reconcile. The
    // four statements are then computed from THAT ONE journal, in one request,
    // so the P&L and the balance sheet cannot be built from different reads of
    // a store that changed in between. That is also why there is no separate
    // /api/books/pnl route: four routes would be four builds.
    //
    // READ-ONLY. GET, no gate beyond the session: looking at her own books is
    // not a privileged act, and nothing here writes.
    app.get('/api/books', (req, res) => {
        try {
            const E = require('./helpers/entities');
            const C = require('./helpers/chartOfAccounts');
            const S = require('./helpers/statements');
            const B = require('./helpers/booksBuild');

            const q = req.query || {};
            const from = String(q.from || '').trim() || null;
            const to = String(q.to || '').trim() || null;
            const entity = String(q.entity || '').trim() || null;

            // ── THE ENTITY IS REQUIRED, AND THAT IS DELIBERATE ────────────
            // statements.js throws without one: "there is no combined
            // taxpayer". Edge Metals, Edge Trading and AAA Investment file
            // separately (CLAUDE.md rule 5), so a combined P&L is not a
            // convenience — it is a number that describes nobody. The list of
            // companies is returned so the screen can offer the choice rather
            // than guess.
            // uiName for the switcher, legalName and taxId for the statement
            // headings — a pack going to her CPA has to carry the filing name,
            // not the short one. There is no `e.name` on an entity; reading it
            // gave the agent sentences beginning "undefined:".
            const companies = E.ENTITIES.map((e) => ({
                id: e.id, name: e.uiName, legalName: e.legalName, taxId: e.taxId || null,
            }));
            if (!entity) {
                return res.json({ needs_entity: true, companies, accounts: C.ACCOUNTS });
            }
            if (!E.get(entity)) {
                return res.status(400).json({ error: `no company ${entity}`, companies });
            }

            const built = B.build({ from, to });
            const opts = { entity, from, to };
            const packed = S.pack(built.lines, opts);

            // The chosen company's names at the TOP level, not only inside the
            // agent's verdict: the statement headings read them, and a P&L
            // whose heading is blank is not a document she can send anyone.
            // legalName is what a CPA needs — Edge Trading trades as "Edge
            // Yard", so the short name on a filing would be wrong.
            const chosen = E.get(entity);
            res.json({
                companies, entity, from, to,
                entityName: chosen.uiName,
                legalName: chosen.legalName || chosen.uiName,
                taxId: chosen.taxId || null,
                accounts: C.ACCOUNTS,
                // What the journal was built from, and what it could not
                // place. `complete` false means the statements below are
                // SMALLER than the truth and look exactly like correct ones,
                // so the screen must show this, not tuck it away.
                build: {
                    transactions: built.transactions,
                    lines: built.lines.length,
                    complete: built.complete,
                    unplaced: built.unplaced,
                    problems: built.problems,
                    notes: built.notes,
                },
                // ── THE AGENT'S VERDICT, FROM THIS BUILD ──────────────────
                // Computed from the SAME journal as the statements beside it.
                // Run as a second request it could disagree with the numbers
                // on screen, which is the one thing a page about trust must
                // never do.
                agent: (() => {
                    const A = require('./helpers/booksAgent');
                    const r = A.review(built, { entity, from, to });
                    // summary() is the one sentence the page leads with, so it
                    // travels WITH the findings it summarises rather than being
                    // rebuilt in the browser from the same data.
                    return { ...r, summary: A.summary(r) };
                })(),
                ...packed,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── THE PACK SHE SENDS HER CPA ────────────────────────────────────────
    // Her stated purpose for the whole books stack: "The year-end pack for
    // your CPA", read by "You, then your CPA". Everything above renders in a
    // browser; this is the only way the figures leave it.
    //
    // ONE COMPANY per workbook — statements.js refuses to combine them and a
    // tab-per-company file would be read as a group return.
    app.get('/api/books/pack', async (req, res) => {
        try {
            const E = require('./helpers/entities');
            const B = require('./helpers/booksBuild');
            const P = require('./helpers/booksPack');
            const q = req.query || {};
            const entity = String(q.entity || '').trim();
            if (!E.get(entity)) return res.status(400).json({ error: `no company ${entity}` });
            const from = String(q.from || '').trim() || null;
            const to = String(q.to || '').trim() || null;

            const built = B.build({ from, to });
            const { workbook, filename } = await P.toWorkbook(built, { entity, from, to });
            const buf = await workbook.xlsx.writeBuffer();
            res.setHeader('Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            // The filename carries DRAFT-INCOMPLETE when the journal was not
            // complete, because a file gets forwarded without the email that
            // explained it.
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.end(Buffer.from(buf));
        } catch (e) { return res.status(400).json({ error: e.message }); }
    });

    // One account's history, on demand. Separate because the general ledger
    // needs an account and nobody wants all 34 at once.
    app.get('/api/books/account/:code', (req, res) => {
        try {
            const E = require('./helpers/entities');
            const S = require('./helpers/statements');
            const B = require('./helpers/booksBuild');
            const q = req.query || {};
            const entity = String(q.entity || '').trim();
            if (!E.get(entity)) return res.status(400).json({ error: `no company ${entity}` });
            const from = String(q.from || '').trim() || null;
            const to = String(q.to || '').trim() || null;
            const built = B.build({ from, to });
            return res.json({
                ledger: S.generalLedger(built.lines,
                    { entity, from, to, account: String(req.params.code) }),
            });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── EDIT A TRUCKING PAYMENT ───────────────────────────────────────────
    // The third of the three cost types she named ("trucker/commission/
    // freight ... and option to edit"). Same shape as the bill-payments pair
    // above, and registered explicitly for the same reason: a loop over a
    // table makes check-route-reach.js read "/api/${slug}/:id" literally and
    // the dead-route guard stops guarding.
    //
    // NOT factored into a shared helper with the bill-payments routes, even
    // though the bodies rhyme. The 404 strings differ ("no trucking payment"
    // vs "no payment"), the audit actions differ, and the two stores are
    // deliberately separate (see helpers/metalsTrucking.js on why). A shared
    // route factory would be exactly the "requirement in shared code" that
    // CLAUDE.md rule 1 is written about — and the caller that could not
    // satisfy it would be whichever of these two changes next.
    app.post('/api/metals-trucking/:id/preview-edit', requireSuper, largeJson, async (req, res) => {
        try {
            const mt = require('./helpers/metalsTrucking');
            return res.json({ ok: true, plan: mt.previewTruckingEdit(String(req.params.id), req.body || {}) });
        } catch (e) {
            const msg = String((e && e.message) || e);
            return res.status(/^no trucking payment/.test(msg) ? 404 : 400).json({ error: msg });
        }
    });

    app.put('/api/metals-trucking/:id', requireSuper, largeJson, async (req, res) => {
        try {
            const mt = require('./helpers/metalsTrucking');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            if (!mt.list().find((p) => p && p.id === id)) {
                return res.status(404).json({ error: `no trucking payment ${id}` });
            }
            const result = await mt.editTruckingPayment(id, req.body || {}, { actor: actorOf(req) });
            await audit.record({
                action: 'edit-metals-trucking', subject: id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { company: 'edge-metals', before: result.before,
                    after: result.after, changes: result.changes },
            }).catch(() => {});
            return res.json({ ok: true, ...result });
        } catch (e) {
            const msg = String((e && e.message) || e);
            const code = /QuickBooks/.test(msg) ? 409
                : /^no trucking payment/.test(msg) ? 404 : 400;
            return res.status(code).json({ error: msg });
        }
    });

    // ── EDIT A SALE COST: COMMISSION OR FREIGHT ───────────────────────────
    // The other two of the three. One store covers both, because both are a
    // cost settled against a SALE — see helpers/salesSettlements.js.
    app.post('/api/sales-settlements/:id/preview-edit', requireSuper, largeJson, async (req, res) => {
        try {
            const st = require('./helpers/salesSettlements');
            return res.json({ ok: true, plan: st.previewSettlementEdit(String(req.params.id), req.body || {}) });
        } catch (e) {
            const msg = String((e && e.message) || e);
            return res.status(/^no settlement/.test(msg) ? 404 : 400).json({ error: msg });
        }
    });

    app.put('/api/sales-settlements/:id', requireSuper, largeJson, async (req, res) => {
        try {
            const st = require('./helpers/salesSettlements');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            if (!st.list().find((p) => p && p.id === id)) {
                return res.status(404).json({ error: `no settlement ${id}` });
            }
            const result = await st.editSettlement(id, req.body || {}, { actor: actorOf(req) });
            await audit.record({
                action: 'edit-sale-cost', subject: id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { company: 'edge-metals', before: result.before,
                    after: result.after, changes: result.changes },
            }).catch(() => {});
            return res.json({ ok: true, ...result });
        } catch (e) {
            const msg = String((e && e.message) || e);
            const code = /QuickBooks/.test(msg) ? 409 : /^no settlement/.test(msg) ? 404 : 400;
            return res.status(code).json({ error: msg });
        }
    });

    app.get('/api/sales-settlements', (req, res) => {
        try {
            const st = require('./helpers/salesSettlements');
            const all = st.payables();
            res.json({
                settlements: st.list(),
                summary: st.summary(),
                payables: all,
                open_payables: all.filter((p) => p.balance > 0.005),
                modes: st.SETTLEMENT_MODES,
                banks: require('./helpers/banks').options(),
                other: require('./helpers/banks').OTHER,
                payees: [...new Set(st.list().map((x) => x.payee).filter(Boolean))].sort(),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/sales-settlements', async (req, res) => {
        try {
            const st = require('./helpers/salesSettlements');
            const rec = await st.addSettlement({ ...(req.body || {}), created_by: (req.role || null) });
            res.json({ ok: true, settlement: rec });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete('/api/sales-settlements/:id', requireSuper, async (req, res) => {
        try {
            const st = require('./helpers/salesSettlements');
            const audit = require('./helpers/audit');
            const id = String(req.params.id);
            const doomed = st.list().find((x) => x.id === id);
            if (!doomed) return res.status(404).json({ error: `no settlement ${id}` });
            const entry = await audit.record({
                action: 'delete-sale-cost', subject: id,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: {
                    company: 'edge-metals', date: doomed.date, mode: doomed.mode,
                    bank: doomed.bank, payee: doomed.payee, amount: doomed.amount,
                    allocations: doomed.allocations || [],
                },
            });
            await st.deleteSettlement(id);
            await audit.complete(entry, 'done', { reopened: (doomed.allocations || []).length });
            res.json({ ok: true, removed: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.get('/api/sales', (req, res) => {
        try {
            const s = require('./helpers/sales');
            const all = s.listWithTotals();
            // ONE filter implementation (bills.filterRows), given the SALE's
            // own columns. Sharing the code is right; sharing bills' field
            // list would have made this search box match nothing.
            const rows = s.filterRows(all, req.query || {});
            res.json({
                sales: rows,
                summary: s.summary(rows),
                // ── THE ADDRESS BOOK FEEDS THE CUSTOMER BOX ──────────────
                // Apsara, 2026-09-10: "also i want customer to be populated
                // with address book data as i type match".
                //
                // Merged on the SERVER into the same facets the type-ahead
                // already reads, so the form needs no second lookup and the
                // list is one list. Every alias is offered, not just the
                // first: an entry labelled "Daekwang/DK Metals" is one
                // company she calls two things, and offering only the first
                // is how the second gets typed by hand and stops matching.
                facets: (() => {
                    const f = s.facets(all);
                    try {
                        const book = require('./helpers/addressBook').loadAddressBook();
                        const names = [];
                        for (const e of (book || [])) for (const a of (e.aliases || [])) {
                            if (String(a || '').trim()) names.push(String(a).trim());
                        }
                        // Her own past customers first — those are the ones
                        // spelled the way the invoices already say.
                        f.customer = [...new Set([...(f.customer || []), ...names])];
                    } catch (e) { console.warn('[SALES] address book unavailable:', e.message); }
                    return f;
                })(),
                filterable: s.FILTERABLE,
                total_unfiltered: all.length,
                columns: s.tableColumns(),
                fields: s.COLUMNS,
                groups: s.GROUPS,
                writable: s.WRITABLE,
                // Reported, never refused — see helpers/sales.duplicates. The
                // same container twice under one booking would double-count
                // when Bills and Sales are joined for margin per container.
                duplicates: s.duplicates(all),
                terms: s.TERMS,
                charge_directions: s.CHARGE_DIRECTIONS,
                per_lb_ceiling: require('./helpers/bills').PER_LB_CEILING,
                lb_per_mt: require('./helpers/bills').LB_PER_MT,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── PAYMENT FOLLOW-UPS (Apsara, 2026-10-26) ──────────────────────────────
    // Drafts chasing customers who owe Edge Metals: payment status + remittance details. Customers on ETA-based
    // payment terms are skipped. READ-ONLY and SENDS NOTHING — the Sales screen shows the drafts to copy / open in
    // mail. The only write is the per-customer ETA-terms label (helpers/paymentFollowups.js).
    app.get('/api/payment-followups', (req, res) => {
        try { res.json(require('./helpers/paymentFollowups').build()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.put('/api/payment-followups/terms', async (req, res) => {
        try {
            const pf = require('./helpers/paymentFollowups');
            const b = req.body || {};
            const out = await pf.setEtaTerms(b.customer, b.eta_terms, { actor: actorOf(req) });
            await require('./helpers/audit').record({ action: 'set-customer-eta-terms', subject: out.customer, actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { company: 'edge-metals', eta_terms: out.eta_terms } });
            res.json({ ok: true, ...out });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post('/api/sales', async (req, res) => {
        try {
            const s = require('./helpers/sales');
            const sale = await s.addSale({ ...(req.body || {}), created_by: (req.role || null) });
            require('./helpers/quickbooks/sync').after('sale', sale && sale.id);
            res.json({ ok: true, sale });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.put('/api/sales/:id', async (req, res) => {
        try {
            const s = require('./helpers/sales');
            const sale = await s.editSale(String(req.params.id), req.body || {});
            require('./helpers/quickbooks/sync').after('sale', sale && sale.id);
            res.json({ ok: true, sale });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete('/api/sales/:id', async (req, res) => {
        try {
            const s = require('./helpers/sales');
            await s.deleteSale(String(req.params.id));
            require('./helpers/quickbooks/sync').after('sale', String(req.params.id), 'deleted');
            res.json({ ok: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── Spend report ──────────────────────────────────────────────────────
    // Per Apsara 2026-09-02: "a report ... where i can track the monthly spent
    // of cash/zelle/wire. date wise filter can also be there like quickbook."
    //
    // Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD, inclusive; omitted means
    // all-time. Computed on every request from payments, expenses and the
    // petty cash ledger — nothing cached, so a deleted payment is gone from
    // the report on the next call.
    //
    // requireAdmin: this is every figure the business spends, across both
    // sides. Staff see their own yard screens and the cash balance, not this.
// @@chunk-end

};
