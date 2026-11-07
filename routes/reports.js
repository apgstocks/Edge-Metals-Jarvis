// routes/reports.js — split from api.js (helpers/sourceParts.js reconstructs the original)
module.exports = function (app, ctx) {
    const { actorOf, requireAdmin } = ctx;
// @@chunk-start
    // ── ONE READER FOR THREE ROUTES ──────────────────────────────────────
    // Apsara, 2026-11-07, asked for the Spend report to export as xls and
    // pdf. The one way to get that wrong is for the export to be a DIFFERENT
    // report from the screen — the same month with a filter quietly dropped,
    // downloaded, and sent to someone. So the query is read ONCE, here, and
    // the JSON the screen draws and both exports all come out of it.
    //
    // A second copy of this parsing is the bug, not the typing.
    function spendFromQuery(req) {
            const { buildSpendReport } = require('./helpers/spendReport');
            const { listPayments } = require('./helpers/payments');
            const { loadExpenses } = require('./helpers/expenses');
            const { listEntries } = require('./helpers/pettyCash');
            const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

            // ── WHOM WE BUY, WHOM WE SELL ────────────────────────────────
            // Apsara, 2026-11-07: "What if i want supplier wise filter in
            // edge yard" → "TWO FILTERS,WHOM WE BUY,WHOM WE SELL".
            //
            // A spend row knew how much, by what method, out of which
            // account and whose company, and had NO idea who received it —
            // its label was "Load 1234". The name lives in a different store
            // for every kind, and helpers/spendReport.js deliberately
            // reaches into none of them: it takes an optional `parties` map
            // and reads "Not recorded" when there is none.
            //
            // That is why this lookup is HERE and not in the helper. The
            // other two callers — helpers/tools.js (the voice path) and ~50
            // test call sites — pass no map and must keep working untouched.
            // CLAUDE.md records two outages caused by a new requirement in
            // shared code that the voice path could not satisfy.
            //
            // Keyed `kind:ref`, matching the kinds collectRows assigns. A
            // store that will not load is skipped rather than failing the
            // report: a missing name shows as the gap it is, and a Spend
            // report that 500s because one store is unreadable is worse than
            // one that cannot name every payee.
            const parties = {};
            const put = (kind, id, name) => {
                const n = name == null ? '' : String(name).trim();
                if (!n || id == null) return;
                parties[`${kind}:${id}`] = n;
            };
            const safely = (what, fn) => {
                try { fn(); } catch (e) {
                    console.warn('[SPEND] could not read ' + what + ' for names:', e && e.message);
                }
            };
            // ── AND WHICH RECORD IS BEHIND EACH PAYMENT ──────────────────
            // Apsara, 2026-11-07: "What if i want ti see the correspodning
            // loads/invoices based on that filter".
            //
            // Built in the SAME pass as the names, off stores already being
            // read — no extra file reads for this. `doc` carries a title she
            // will recognise and, when one was generated, the stored PDF.
            // A record with no document gets a title and no link, because a
            // dead link is worse than an honest absence.
            const docs = {};
            const doc = (kind, id, title, link) => {
                if (id == null || !title) return;
                docs[`${kind}:${id}`] = link ? { title, link } : { title };
            };
            // Yard purchases — the seller on the load. This is the one she
            // asked for: Edge Yard's own counterparties.
            safely('loads', () => {
                for (const l of (require('./helpers/loads').loadLoads() || [])) {
                    put('load', l.id, l.seller);
                    const when = String(l.date || '').slice(0, 10);
                    doc('load', l.id, `Load ${l.id}${when ? ' \u00b7 ' + when : ''}`,
                        l.pdf_link || l.receipt_pdf_link || null);
                }
            });
            // Sales — the buyer on the outbound load. The money-IN side.
            safely('outbound loads', () => {
                for (const l of (require('./helpers/outboundLoads').loadOutboundLoads() || [])) {
                    put('sale', l.id, l.buyer);
                    const when = String(l.date || '').slice(0, 10);
                    doc('sale', l.id, `Sale ${l.id}${when ? ' \u00b7 ' + when : ''}`,
                        l.pdf_link || l.receipt_pdf_link || null);
                }
            });
            // Edge Yard haulage: a trucker payment's load_id IS the bill id
            // (helpers/truckerBills.js:21), and the carrier is `company`.
            safely('trucker bills', () => {
                for (const b of (require('./helpers/truckerBills').listBills() || [])) put('trucker', b.id, b.company);
            });
            // Edge METALS supplier payments. A different company from the
            // yard, which is exactly why they are a separate kind and never
            // summed with the yard's sellers.
            safely('bill payments', () => {
                for (const b of (require('./helpers/billPayments').list() || [])) put('supplier', b.id, b.supplier);
            });
            // What a sale COSTS — freight, commission. `payee` is free text
            // and deliberately unverified; it is recorded as given.
            safely('sale settlements', () => {
                for (const x of (require('./helpers/salesSettlements').list() || [])) put('sale_cost', x.id, x.payee);
            });
            safely('metals trucking', () => {
                for (const x of (require('./helpers/metalsTrucking').list() || [])) put('metals_trucking', x.id, x.trucking_company);
            });

            return buildSpendReport({
                parties,
                docs,
                // Each narrows its OWN side: bought_from the money out,
                // sold_to the money in. Not validated, same as bank and
                // paid_via — "Not recorded" is a legitimate thing to ask for.
                boughtFrom: req.query.bought_from,
                soldTo: req.query.sold_to,
                // Which company's books the row belongs on — NOT whose money
                // paid (that is paid_via). Absent means every company, which
                // is what the voice path and the old clients get. The web
                // screen sends edge-trading by default, per Apsara
                // 2026-11-07: it "should be the one stop thing for the edge
                // yard".
                company: req.query.company,
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
            });
    }

    // A label she will recognise on the printed page: the period, the
    // company, and whichever filters are on.
    function spendLabel(rep) {
        const bits = [rep.from || rep.to
            ? `${rep.from || 'the beginning'} to ${rep.to || 'today'}` : 'All time'];
        bits.push(rep.companyName || 'Both companies');
        if (rep.method) bits.push(`paid by ${rep.method}`);
        if (rep.bank) bits.push(`out of ${rep.bank}`);
        if (rep.paidVia) bits.push(`via ${rep.paidVia}`);
        if (rep.boughtFrom) bits.push(`bought from ${rep.boughtFrom}`);
        if (rep.soldTo) bits.push(`sold to ${rep.soldTo}`);
        return bits.join(' \u00b7 ');
    }

    app.get('/api/reports/spend', requireAdmin, (req, res) => {
        try { res.json(spendFromQuery(req)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── THE SAME REPORT, AS A FILE ───────────────────────────────────────
    // Apsara, 2026-11-07: "export as xls and pdf". Both routes go through
    // spendFromQuery, so a download can never be a different period, company
    // or filter from the page she pressed it on — which is the one way this
    // feature goes wrong, and it goes wrong silently, in a file she sends to
    // somebody. The filename carries the company and the period for the same
    // reason.
    const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'all';
    const fileName = (rep, ext) =>
        `spend-${slug(rep.companyName || 'both')}-${slug(rep.from || 'all')}.${ext}`;

    app.get('/api/reports/spend/export.xlsx', requireAdmin, async (req, res) => {
        try {
            const rep = spendFromQuery(req);
            const { spendWorkbookBuffer } = require('./helpers/spendExport');
            const buf = await spendWorkbookBuffer(rep, spendLabel(rep));
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName(rep, 'xlsx')}"`);
            res.send(Buffer.from(buf));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/reports/spend/export.pdf', requireAdmin, async (req, res) => {
        try {
            const rep = spendFromQuery(req);
            const { generateSpendReportPdf } = require('./helpers/pdf');
            const buf = await generateSpendReportPdf(spendLabel(rep), rep);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName(rep, 'pdf')}"`);
            res.send(buf);
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
    // ── AI USAGE AND ACTIVITY (2026-10-12) ──────────────────────────────
    // Apsara: "observability should be there ... what actions does that agent
    // perform, constantly monitoring cost". Read-only. Admin only: it shows
    // what the business is spending. See helpers/aiUsage.js, activityFeed.js.
    app.get('/api/ai-usage', requireAdmin, (req, res) => {
        try {
            const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
            const aiUsage = require('./helpers/aiUsage'), watch = require('./helpers/aiCostWatch');
            res.json({ ok: true, ...aiUsage.summarise({ days }), limit_usd: watch.limitUsd(),
                prices: aiUsage.prices(), recording: aiUsage.enabled() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/activity', requireAdmin, (req, res) => {
        try {
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
            res.json({ ok: true, ...require('./helpers/activityFeed').feed({ limit }) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
// @@chunk-end

};
