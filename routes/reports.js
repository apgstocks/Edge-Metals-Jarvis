// routes/reports.js — split from api.js (helpers/sourceParts.js reconstructs the original)
module.exports = function (app, ctx) {
    const { actorOf, requireAdmin } = ctx;
// @@chunk-start
    app.get('/api/reports/spend', requireAdmin, (req, res) => {
        try {
            const { buildSpendReport } = require('./helpers/spendReport');
            const { listPayments } = require('./helpers/payments');
            const { loadExpenses } = require('./helpers/expenses');
            const { listEntries } = require('./helpers/pettyCash');
            const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
            res.json(buildSpendReport({
                payments: listPayments(),
                expenses: loadExpenses(),
                pettyEntries: listEntries(),
                from: ymd(req.query.from),
                to: ymd(req.query.to),
                // "just Zelle" / "just Wire" / "just Cash" — narrows every
                // figure, not only the rows. See helpers/spendReport.js.
                method: req.query.method,
                // "how much went out of Chase last month". Narrows the same
                // way the method does — every figure, not only the rows.
                bank: req.query.bank,
                // Apsara, 2026-09-17: the Spend report narrows to one company
                // as well as to one bank. Not validated here for the same
                // reason the bank is not — "Not recorded" is a legitimate
                // thing to filter for, and it is how she finds the transfers
                // written before the field existed.
                paidVia: req.query.paid_via,
            }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Petty cash — the physical cash box ────────────────────────────────
    // Per Apsara 2026-09-02. A ledger of top-ups and cash withdrawals; the
    // balance is their sum. See helpers/pettyCash.js for why it is rows rather
    // than a stored number.
    //
    // READ is open to staff, WRITE is admin only — her choice ("staff can see
    // the balance, admin can top up"). The path is on
    // STAFF_ALLOWED_PATH_PREFIXES so a staff session can GET it, and the two
    // mutating routes carry requireAdmin individually. That combination is the
    // boundary: the prefix list is path-based and cannot distinguish methods,
    // so the method-level gate has to be on the route itself. Hiding the form
    // in the client is UX, not security.
    app.get('/api/petty-cash', (req, res) => {
        try {
            const petty = require('./helpers/pettyCash');
            // `balance` keeps its name and its meaning — Cash in hand, the sum
            // of every row. Both clients already read it and a screen she uses
            // daily must not change shape because a new figure arrived beside
            // it. Everything per-bucket is ADDED alongside.
            res.json({
                balance: petty.balance(),
                entries: petty.history(200),
                sources: petty.SOURCES,
                by_source: petty.balanceBySource(petty.listEntries()),
                // ── WHAT IS WAITING TO BE ASSIGNED ───────────────────────
                // Apsara, 2026-10-01: "as of now put it n unassigned.ask the
                // user to assign it correctly later". Cash recorded under a
                // name this app no longer recognises now READS as Unassigned
                // — spendable, and reassignable with transfer(reason:
                // 'reassign'). That makes it usable but indistinguishable
                // from her opening float, so the amount and the original
                // names travel too. Additive key; a client that does not
                // know it is unaffected.
                pending_assignment: petty.pendingAssignment(petty.listEntries()),
                // Added 2026-09-21, alongside again and for the same reason:
                // BofA became two accounts belonging to two companies, and
                // her answer was one total with the split underneath it.
                // `company_of` travels with the list so a screen labels a
                // bucket without carrying its own copy of the map.
                by_company: petty.balanceByCompany(petty.listEntries()),
                company_of: petty.SOURCES.reduce((m, s) => { m[s] = petty.companyOf(s); return m; }, {}),
                // The bank each account sits in, so the screens can group
                // them the way she described it: "Under BofA. 1.Edge Metals
                // 2.AAA Investment". Unassigned has no bank and returns null.
                bank_of: petty.SOURCES.reduce((m, s) => { m[s] = petty.bankOf(s); return m; }, {}),
                company_unknown: petty.COMPANY_UNKNOWN,
                borrowings: petty.borrowings(),
                transfers: petty.transfers(),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── MOVING CASH BETWEEN BUCKETS ───────────────────────────────────────
    // One route for all three reasons, because they are one movement:
    //   repay    — she settles what one bucket borrowed from another
    //   reassign — unbanked cash gets a bank put behind it, once banked
    //   borrow   — refused here on purpose. A borrow is only ever created by
    //              a payment that needed it, inside the same lock that takes
    //              the money (helpers/pettyCash.js's withdrawForPayment). A
    //              borrow with no payment behind it is a debt from nowhere.
    //
    // requireAdmin, matching POST and DELETE on this store. Staff read the
    // balance; they do not move money between her bank accounts.
    app.post('/api/petty-cash/transfer', requireAdmin, async (req, res) => {
        try {
            const petty = require('./helpers/pettyCash');
            const b = req.body || {};
            const reason = String(b.reason || '').trim().toLowerCase();
            if (reason === 'borrow') {
                return res.status(400).json({ error: 'a borrow is created by the payment that needs it, not on its own' });
            }
            const moved = await petty.transfer({
                from: b.from, to: b.to, amount: b.amount, reason,
                note: b.note, date: b.date, createdBy: (req.role || null),
            });
            res.json({ ok: true, transfer: moved, balance: petty.balance(),
                       by_source: petty.balanceBySource(petty.listEntries()),
                       borrowings: petty.borrowings() });
        } catch (e) {
            // PETTY_CASH_TRANSFER_SHORT is the one the Repay button turns into
            // "Chase only holds $0 — add cash to Chase first". Carried through
            // with its figures rather than flattened to a message, so the
            // screen can say which bucket and how much.
            const body = { error: e.message };
            if (e.code) { body.code = e.code; body.bucket = e.bucket; body.bucket_available = e.bucket_available; body.requested = e.requested; }
            res.status(400).json(body);
        }
    });
    app.post('/api/petty-cash', requireAdmin, async (req, res) => {
        try {
            const petty = require('./helpers/pettyCash');
            const entry = await petty.addTopUp({ ...(req.body || {}), created_by: (req.role || null) });
            res.json({ ok: true, entry, balance: petty.balance() });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    // Top-ups only — a withdrawal is undone by deleting the payment that made
    // it, which reverses it properly. helpers/pettyCash.js enforces that
    // rather than this route, so the rule holds however it is reached.
    app.delete('/api/petty-cash/:id', requireAdmin, async (req, res) => {
        try {
            const petty = require('./helpers/pettyCash');
            const removed = await petty.deleteEntry(String(req.params.id));
            res.json({ ok: true, removed, balance: petty.balance() });
        } catch (e) { res.status(400).json({ error: e.message, code: e.code || null }); }
    });

    // The three /api/advances routes were removed 2026-08-29 per Apsara
    // ("remove that advance concept"). Payments against a load are unchanged.

    // Removing a payment is how an admin corrects a mistyped amount, so this
    // is NOT locked behind the Jarvis profile — it never was, and making it so
    // would turn a routine correction into a privileged act. What is new is
    // that when the top-level profile does it, the row is recorded, because
    // that is the one case where the deletion might be covering something
    // rather than fixing it. Logged either way when super; silent for admin,
    // as before.
    // Admin, not any signed-in session. This route had NO gate at all: staff
    // were blocked only because '/api/payments' is absent from
    // STAFF_ALLOWED_PATH_PREFIXES, which left the plain 'user' role able to
    // delete a payment from either client. Found 2026-09-16 while wiring
    // Apsara's "give delete partial payment to admin".
    app.delete('/api/payments/:id', requireAdmin, async (req, res) => {
        try {
            const { deletePayment, listPayments } = require('./helpers/payments');
            const audit = require('./helpers/audit');
            const doomed = listPayments().find((p) => p && String(p.id) === String(req.params.id)) || null;
            // ── EVERY DELETION, NOT JUST JARVIS'S ────────────────────────
            // This was wrapped in `if (isSuper(req))`, so an ADMIN removing a
            // payment left no trace at all — money could leave the books with
            // nothing recording who took it out. Apsara, asked directly on
            // 2026-09-16, chose to log every deletion: "Log every deletion".
            //
            // Recorded BEFORE the delete and stamped after, which is this
            // audit log's protocol (see helpers/audit.js): a crash between
            // the two leaves a row saying the attempt started, where logging
            // afterwards would leave nothing at all.
            //
            // The role is on the row, so an admin deletion and a Jarvis one
            // are still told apart — by what the log says, not by whether the
            // log exists.
            const entry = await audit.record({
                action: 'delete-payment', subject: String(req.params.id),
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: doomed ? {
                    load_id: doomed.load_id, load_kind: doomed.load_kind || 'purchase',
                    mode: doomed.mode, bank: doomed.bank || null,
                    amount: doomed.amount, paid_on: doomed.paid_on,
                    reference: doomed.reference || null,
                } : { note: 'no matching payment found' },
            });
            const removed = await deletePayment(String(req.params.id));
            await audit.complete(entry, removed ? 'done' : 'failed', { removed });
            res.json({ ok: true, removed });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // One place that answers "what is this load worth", for either store, so
    // the payment routes and the load listings cannot disagree about the
    // figure a balance is measured against.
// @@chunk-end

};
