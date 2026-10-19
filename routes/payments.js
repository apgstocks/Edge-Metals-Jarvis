// routes/payments.js — split from api.js (helpers/sourceParts.js reconstructs the original)
module.exports = function (app, ctx) {
    const { actorOf, amountForLoad, isSuper } = ctx;
// @@chunk-start
    app.get('/api/payments', (req, res) => {
        try {
            const { listPayments, PAYMENT_MODES } = require('./helpers/payments');
            const loadId = req.query && req.query.load_id;
            const all = listPayments();
            // The banks travel with the modes for the same reason the modes
            // travel at all: the dropdown is built from the SERVER's list, so
            // it cannot offer something the server would reject. `other` is
            // the exact label that reveals the text box — sent rather than
            // hardcoded in two clients, because "Other" against a server
            // expecting "Others" is a 400 she would read as a broken button.
            const banks = require('./helpers/banks');
            res.json({
                modes: PAYMENT_MODES,
                banks: banks.options(),
                bank_modes: banks.MODES_WITH_BANK,
                other: banks.OTHER,
                payments: loadId ? all.filter((p) => p.load_id === loadId) : all,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/payments', async (req, res) => {
        try {
            const { addPayment, paymentSummary } = require('./helpers/payments');
            const b = req.body || {};

            // ── Zelle or Wire only, for a trucker bill ────────────────────
            // Apsara 2026-09-03: "when i click pay - option should be as
            // zelle/wire." Enforced on the WRITE PATH and not only in the
            // dropdown, because the dropdown is not a rule — the last three
            // money rules in this app were enforced by a hidden control and
            // two of them turned out to be enforced nowhere else.
            //
            // The practical consequence is that trucker bills never touch
            // petty cash: Cash is the only mode that withdraws from it, so
            // refusing Cash here means the whole reserve-then-write dance in
            // addPayment cannot apply to this ledger at all.
            if (String(b.load_kind || '') === 'trucker') {
                const { TRUCKER_PAYMENT_MODES } = require('./helpers/truckerBills');
                const mode = TRUCKER_PAYMENT_MODES
                    .find((m) => m.toLowerCase() === String(b.mode || '').trim().toLowerCase());
                if (!mode) {
                    return res.status(400).json({
                        error: `A trucker bill is paid by ${TRUCKER_PAYMENT_MODES.join(' or ')}.`,
                        code: 'TRUCKER_MODE_NOT_ALLOWED',
                    });
                }
            }

            // ── REQUIRED ONLY OF A CLIENT THAT KNOWS ABOUT BANKS ─────────
            // The obvious version — require_bank: true, always — is wrong, and
            // the reason is the mobile app: it is an installed APK, so the
            // server can be a week ahead of whatever build is on her phone.
            // A blanket requirement would mean every Zelle and Wire recorded
            // from an old app started failing the moment this deployed, in the
            // yard, with no way to fix it from there.
            //
            // So the test is whether the client SENT THE FIELD AT ALL. Present
            // means it has the dropdown: an empty value is then a real
            // omission — she picked Others and typed nothing — and refusing is
            // right, because she is looking at the box she needs to fill.
            // Absent means an older build, and the payment is recorded with
            // the bank unknown, which the spend report shows under "Not
            // recorded" rather than hiding.
            //
            // Degrading to a visible gap beats refusing a payment somebody is
            // standing there trying to make.
            const clientKnowsBanks = Object.prototype.hasOwnProperty.call(b || {}, 'bank');
            const payment = await addPayment({
                ...b, require_bank: clientKnowsBanks, created_by: (req.role || null),
            });
            // A cash payment short of the asked-for amount has to say so
            // loudly enough that the client can tell the operator, per Apsara
            // 2026-09-02 ("make it as partial payment and notify user"). The
            // client already had to acknowledge the shortfall to get here —
            // this is the confirmation of what was actually taken.
            const cashNote = (payment.mode === 'Cash' && Number(payment.amount) < Number(b.amount) - 0.005)
                ? { capped: true, requested: Number(b.amount), paid: Number(payment.amount) }
                : null;
            // The fresh summary comes back with the payment so the client can
            // repaint the card without a second round trip, and so the
            // partial/pending figure it shows is the SERVER's arithmetic
            // rather than a second implementation of it in the browser.
            const amount = amountForLoad(b.load_id, b.load_kind);
            let pettyBalance = null;
            try { pettyBalance = require('./helpers/pettyCash').balance(); } catch (e) {}
            res.json({ ok: true, payment, summary: paymentSummary(b.load_id, amount), cash: cashNote, petty_cash_balance: pettyBalance });
        } catch (e) {
            // Petty cash refusals carry the numbers the operator needs to
            // decide, so they are passed through as structured fields rather
            // than flattened into a message the client would have to parse.
            // PETTY_CASH_SHORT is the one the Pay form turns into "only $400
            // in the box — record $400 and leave the rest outstanding?".
            const body = { error: e.message };
            if (e.code) body.code = e.code;
            if (e.available != null) body.available = e.available;
            if (e.requested != null) body.requested = e.requested;
            // ── AND THE BUCKET CASE, WHICH CARRIES DIFFERENT FIELDS ──────
            // PETTY_CASH_BUCKET_SHORT (2026-09-21) means the BOX can cover
            // this but the bank she nominated cannot — "only 3,000 in Chase,
            // borrow 4,000 from BofA?". It carries the bucket, the shortfall
            // and who could lend. Those were being dropped by the three lines
            // above, which name `available` and `requested` and nothing else,
            // so the form would have had the question and none of the figures
            // to ask it with.
            if (e.bucket != null) body.bucket = e.bucket;
            if (e.bucket_available != null) body.bucket_available = e.bucket_available;
            if (e.shortfall != null) body.shortfall = e.shortfall;
            if (Array.isArray(e.lenders)) body.lenders = e.lenders;
            res.status(400).json(body);
        }
    });

    // ── SETTLE AGAINST THE OTHER SIDE ────────────────────────────────────
    // Apsara, 2026-10-16: "when we pay load/sales-there should be a option to
    // adjust against sale incase of load and against load in case of sale."
    // And the case, in her words: "his seller is also a buyer, he owes you
    // $3,000 on a sale, you're paying him $5,000 for a load, so you hand over
    // $2,000 and the $3,000 is settled".
    //
    // ── A SEPARATE ROUTE, NOT A FIELD ON POST /api/payments ──────────────
    // The temptation is an `against_id` on the existing payment body, and it
    // is the exact mistake this repo has made three times (CLAUDE.md records
    // two of them, both live before she caught them). POST /api/payments is
    // reached by two screens, the Jarvis voice path through helpers/tools.js,
    // and the trucker-bill flow. A new branch inside it is a new way for all
    // four to behave differently, and the one that breaks is always the voice
    // path, because it has no form to put a field on.
    //
    // So this is its own door. Nothing that works today changes shape, and
    // helpers/payments.js's settleAgainst is likewise its own function rather
    // than a branch in addPayment.
    //
    // ── STAFF ARE ALREADY REFUSED, BY OMISSION ──────────────────────────
    // '/api/payments' is deliberately absent from STAFF_ALLOWED_PATH_PREFIXES
    // in api.js, and that check is a true prefix test — req.path === p ||
    // startsWith(p + '/') — so '/api/payments/settle' inherits the flat 403
    // without a new entry. Verified rather than assumed: writing off what a
    // customer owes is not yard paperwork.

    // What could this be netted against? Server-computed, so the dropdown
    // cannot offer a row the write path would refuse.
    app.get('/api/payments/settle-options', (req, res) => {
        try {
            const { settleOptions } = require('./helpers/payments');
            const q = req.query || {};
            if (!q.load_id) return res.status(400).json({ error: 'load_id is required' });
            res.json(settleOptions(String(q.load_id), String(q.load_kind || 'purchase')));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/payments/settle', async (req, res) => {
        try {
            const { settleAgainst, paymentSummary } = require('./helpers/payments');
            const b = req.body || {};
            const result = await settleAgainst({ ...b, created_by: (req.role || null) });

            // BOTH sides repaint, because both just changed. Returning only
            // the side she was looking at is how a screen ends up showing a
            // sale as still fully outstanding after it was settled — the
            // figure is right on the server and wrong in front of her.
            const kind = String(b.load_kind || 'purchase') === 'sale' ? 'sale' : 'purchase';
            const againstKind = kind === 'sale' ? 'purchase' : 'sale';
            res.json({
                ok: true,
                settlement_id: result.settlement_id,
                amount: result.amount,
                party: result.party,
                summary: paymentSummary(b.load_id, amountForLoad(b.load_id, kind)),
                against_summary: paymentSummary(b.against_id, amountForLoad(b.against_id, againstKind)),
            });
        } catch (e) {
            const body = { error: e.message };
            if (e.code) body.code = e.code;
            res.status(400).json(body);
        }
    });

    // Removing one takes BOTH rows or neither — deleteSettlement enforces
    // that, and a half-removed settlement would leave one document reopened
    // and the other still closed.
    app.delete('/api/payments/settle/:id', async (req, res) => {
        try {
            const { deleteSettlement } = require('./helpers/payments');
            const removed = await deleteSettlement(String(req.params.id));
            res.json({ ok: true, removed });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── SUPPLIER PREPAYMENTS, EDGE YARD ──────────────────────────────────
    // Apsara: "Add a supplier prepayment option in loads", "no for edge
    // yard", "streamline the process", "Build prepayment properly".
    //
    // THREE routes, not a screen's worth. The shape is Odoo's, checked rather
    // than remembered: a vendor prepayment sits as an OUTSTANDING CREDIT on
    // the supplier, and the bill offers it inline — "Outstanding Debits: ADD"
    // — at the moment of paying. Odoo's own forum threads and a row of
    // third-party modules exist because surfacing advances on a separate
    // screen is unpopular enough to be a market. The first attempt here
    // shipped three surfaces and she deleted it the same day; this is why
    // there is no fourth tab.
    //
    //   POST /api/prepayments                 record one (no load yet)
    //   GET  /api/prepayments/credit?seller=  what a supplier is holding
    //   POST /api/prepayments/apply           put some of it on a load
    app.post('/api/prepayments', async (req, res) => {
        try {
            const pay = require('./helpers/payments');
            const b = req.body || {};
            // Same reasoning as /api/payments: whether the client SENT the
            // field is the test, not whether the server would like it. An
            // installed APK can be a week behind, and a prepayment refused in
            // the yard because an old build has no bank dropdown is worse
            // than one recorded with the bank unknown. See the long comment
            // on that route.
            const clientKnowsBanks = Object.prototype.hasOwnProperty.call(b, 'bank');
            const rec = await pay.addPrepayment({
                ...b, require_bank: clientKnowsBanks, created_by: (req.role || null),
            });
            res.json({
                ok: true, prepayment: rec,
                credit: pay.prepaymentCredit(rec.seller),
            });
        } catch (e) {
            // Carried through with its figures, like the pay route, so the
            // client can say WHICH bucket was short rather than flattening it
            // to a sentence.
            const body = { error: e.message };
            if (e.code) body.code = e.code;
            if (e.available != null) body.available = e.available;
            if (e.bucket != null) body.bucket = e.bucket;
            if (e.bucket_available != null) body.bucket_available = e.bucket_available;
            if (e.shortfall != null) body.shortfall = e.shortfall;
            if (Array.isArray(e.lenders)) body.lenders = e.lenders;
            res.status(400).json(body);
        }
    });

    app.get('/api/prepayments/credit', (req, res) => {
        try {
            const pay = require('./helpers/payments');
            // No seller means every supplier holding something — what the Pay
            // modal needs to decide whether to show its inline line at all,
            // in ONE call rather than one per row.
            const seller = String(req.query.seller || '').trim();
            if (seller) return res.json(pay.prepaymentCredit(seller));
            const held = {};
            for (const p of pay.listPrepayments()) {
                const name = String(p.seller || '').trim();
                if (!name || held[name]) continue;
                const c = pay.prepaymentCredit(name);
                if (c.available > 0) held[name] = c;
            }
            res.json({ held });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/prepayments/apply', async (req, res) => {
        try {
            const pay = require('./helpers/payments');
            const b = req.body || {};
            const rec = await pay.applyPrepayment({ ...b, created_by: (req.role || null) });
            // The figures the card needs, recomputed from the ledger rather
            // than returned from what the client sent.
            const loads = require('./helpers/loads');
            const load = loads.getLoad(b.load_id);
            res.json({
                ok: true,
                payment: rec,
                summary: pay.paymentSummary(b.load_id, load ? loads.payableOf(load) : null),
                credit: pay.prepaymentCredit(rec.seller || (b.seller || '')),
                remaining: pay.prepaymentRemaining(b.prepayment_id),
            });
        } catch (e) {
            res.status(400).json({ error: e.message, code: e.code || undefined });
        }
    });

    // ── Trucker bills ─────────────────────────────────────────────────────
    // Apsara 2026-09-03: "now include a tab called trucker for everyone ... it
    // contains date, company name, load ticket number (optional), amount.
    // edit, delete, pay option should be there. when i click pay - option
    // should be as zelle/wire. once paid, hide delete option for staff and
    // admin."
    //
    // "FOR EVERYONE" is why '/api/trucker-bills' is on
    // STAFF_ALLOWED_PATH_PREFIXES. What that does NOT include is paying:
    // '/api/payments' is absent from that list and stays absent, so a staff
    // session can record what is owed and cannot record that it was settled.
    // That is the same division that already exists for loads — staff weigh
    // and price them, admin pays for them — and widening it silently, in the
    // middle of a request about a tab, would be the wrong way to change how
    // money moves in this business. Say the word and it is one entry.
    //
    // No requireAdmin on GET/POST/PUT: the staff allowlist above is the gate,
    // and every other role passes it anyway.
    app.get('/api/trucker-bills', (req, res) => {
        try {
            const t = require('./helpers/truckerBills');
            const { from, to, company } = req.query || {};
            const bills = t.listBillsWithPayments({ from, to, company });
            res.json({
                bills,
                report: t.billsReport(bills),
                // The modes travel with the payload for the same reason the
                // expense methods do: the dropdown is built from the server's
                // list, so it cannot offer something the server would reject.
                modes: t.TRUCKER_PAYMENT_MODES,
                // Same list, same reason. A trucker bill is Zelle or Wire, so
                // on this form the bank is always required.
                banks: require('./helpers/banks').options(),
                bank_modes: require('./helpers/banks').MODES_WITH_BANK,
                other: require('./helpers/banks').OTHER,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/trucker-bills', async (req, res) => {
        try {
            const t = require('./helpers/truckerBills');
            const bill = await t.addBill({ ...(req.body || {}), created_by: (req.role || null) });
            res.json({ ok: true, bill });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.put('/api/trucker-bills/:id', async (req, res) => {
        try {
            const t = require('./helpers/truckerBills');
            const bill = await t.editBill(String(req.params.id), req.body || {});
            if (!bill) return res.status(404).json({ error: 'not found' });
            res.json({ ok: true, bill });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── delete, with the payment lock enforced HERE and not in the button ──
    // "Once paid, hide delete option for staff and admin." The hiding is in
    // both clients; this is the rule. Written at the same time as the button
    // this time — the load equivalent went two weeks with the button as the
    // only enforcement, and staff can reach these routes.
    //
    // Jarvis goes past it, consistent with loads, and is audited for it.
    app.delete('/api/trucker-bills/:id', async (req, res) => {
        try {
            const t = require('./helpers/truckerBills');
            const audit = require('./helpers/audit');
            const { paymentsForLoad, deletePaymentsForLoad } = require('./helpers/payments');
            const id = String(req.params.id);
            const doomed = t.getBill(id);
            if (!doomed) return res.status(404).json({ error: 'not found' });

            const paidRows = paymentsForLoad(id);
            const paidTotal = paidRows.reduce((a, p) => a + (Number(p.amount) || 0), 0);
            if (paidTotal > 0 && !isSuper(req)) {
                await audit.refused({
                    action: 'delete-paid-trucker-bill', subject: id,
                    actor: actorOf(req), role: req.role, ip: req.ip,
                    detail: { company: doomed.company, paid: paidTotal, payments: paidRows.length },
                    reason: 'bill has payments against it',
                });
                return res.status(409).json({
                    error: 'This bill has payments recorded against it. Remove the payments first, or sign in with the Jarvis profile.',
                    code: 'BILL_HAS_PAYMENTS', paid: paidTotal,
                });
            }

            let entry = null;
            if (paidTotal > 0) {
                entry = await audit.record({
                    action: 'delete-paid-trucker-bill', subject: id,
                    actor: actorOf(req), role: req.role, ip: req.ip,
                    detail: {
                        company: doomed.company, date: doomed.date,
                        load_ticket: doomed.load_ticket, amount: doomed.amount, paid: paidTotal,
                        payments: paidRows.map((p) => ({ id: p.id, mode: p.mode, amount: p.amount, paid_on: p.paid_on })),
                    },
                });
            }

            const removed = await t.deleteBill(id);
            if (!removed) {
                if (entry) await audit.complete(entry, 'failed', { reason: 'bill not found' });
                return res.status(404).json({ error: 'not found' });
            }
            // Payments follow the bill, exactly as they follow a load. Receipts
            // left behind would sum against nothing and inflate the spend
            // report. Nothing here can be Cash, so petty cash is untouched.
            const removedPayments = await deletePaymentsForLoad(id);
            if (entry) await audit.complete(entry, 'done', { payments_removed: removedPayments });
            res.json({ ok: true, removed_payments: removedPayments });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Bills and Sales — the Edge Metals pair ────────────────────────────
    // Apsara, 2026-09-09: "This is for edge metals not for edge yard. now i
    // want to build a bill tab which contains Source/Destination,Carrier,
    // TRUCKING,Date,SUPPLIER,Invoice no,Booking no,Container no,Seal no,item
    // Description,GROSS,Truck,container,Chassis,Boxes,Total,Net weight(lbs),
    // Net weight(MT),supplier price,Supplier invoice amount,Trucking,Advance,
    // Balance in one tab.. In sales tab-i want customer name,date,invoice
    // number,HBL number,Proforma date,Reference,weight,invoice price,invoice
    // amount,Freight charges to be there"
    //
    // What a container COST her, and what it SOLD for.
    //
    // ── NOT ON STAFF_ALLOWED_PATH_PREFIXES, AND THAT IS THE POINT ─────────
    // '/api/bills' and '/api/sales' are deliberately absent from that list,
    // so a staff session gets a flat 403. These are supplier prices, customer
    // invoices and margins on the freight side of the business — a different
    // thing entirely from the yard paperwork staff own. Same reasoning that
    // keeps '/api/payments' and '/api/trade-catalog' off it. Say the word and
    // each is one entry, but widening it silently inside a request about a
    // tab would be the wrong way to change who sees her pricing.
    //
    // EVERY DERIVED NUMBER IS COMPUTED SERVER-SIDE, in helpers/bills.js and
    // helpers/sales.js, and the COLUMNS list travels with the payload — so
    // the table is built from the server's idea of what a bill is and the two
    // cannot drift into disagreeing about which fields exist.
// @@chunk-end

};
