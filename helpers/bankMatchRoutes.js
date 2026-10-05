// ── helpers/bankMatchRoutes.js — the bank matcher, reachable ──────────────
//
// Apsara, 2026-10-05: "My biggest problem is matching only."
//
// ── WHY THIS FILE IS THE WHOLE POINT ─────────────────────────────────────
// helpers/reconcile.js has existed since 3 September. 212 lines, 41 green
// checks, and `require('./reconcile')` appears in exactly one place in this
// repo: its own test. No route, no screen, no caller. She has spent a month
// struggling with matching while a matcher sat in the tree that nobody could
// reach.
//
// That is the same failure as the guarded route with no button and the
// sixteen miscoded cheques shown as a single number in a chip. So this file
// exists before any more engine work does, and scripts/check-route-reach.js
// is extended in the same commit so a matcher with no caller fails CI. An
// intention is not a guard.
//
// ── IT READS. CONFIRMING POSTS SOMEWHERE ELSE, ON PURPOSE ────────────────
// There is NO apply route here. A confirmed match is a receipt, and receipts
// already have a route — POST /api/sales-receipts, which goes through
// salesReceipts.addReceipt and therefore gets its validation, its
// one-customer-per-receipt rule, its deduction classification and its
// existing delete/reverse path for free.
//
// Adding a second write path would mean two places that can mark an invoice
// paid, and the newer one would miss whichever rule gets added next. The
// screen posts the proposal through the route the receipts screen already
// posts through, which is CLAUDE.md rule 3 read forwards instead of
// backwards.

const { loadJson } = require('./json');
const bankMatch = require('./bankMatch');
const bankLearn = require('./bankLearn');

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const num0 = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

// ── open receivables, in the engine's shape ──────────────────────────────
// `receivable` and NOT `amount`. They differ whenever a sale carries charges
// — amount is the goods, receivable is what the customer actually owes once
// charges in and out are applied. Matching on `amount` would silently
// mis-state the balance on every sale that has a charge on it, and the
// deposits that then failed to match would look like the matcher's fault.
//
// The DISAGREEMENT GUARD below matters more than it looks. sales.js computes
// `balance` itself; this file computes openBalance from receivable minus
// received minus deducted. Those must be the same number, and if sales.js's
// definition ever moves, the honest outcome is a loud refusal rather than a
// matcher quietly working from a stale idea of what is owed. Two sources of
// truth about money is the bug this repo has paid for more than once.
function openReceivables(sales) {
    const docs = [];
    const disagreements = [];
    for (const s of sales) {
        const receivable = round2(num0(s.receivable));
        const applied = round2(num0(s.received) + num0(s.deducted));
        const doc = {
            id: s.id,
            party: String(s.customer || '').trim(),
            date: String(s.date || '').slice(0, 10),
            amount: receivable,
            applied,
            label: s.invoice_no ? `${s.invoice_no} (${s.item || 'sale'})` : (s.item || s.id),
            invoice_no: s.invoice_no || null,
            item: s.item || null,
        };
        const mine = bankMatch.openBalance(doc);
        if (s.balance != null && Math.abs(mine - num0(s.balance)) > 0.005) {
            disagreements.push({ id: s.id, sales_js: round2(num0(s.balance)), here: mine });
        }
        if (!doc.party) continue;            // a sale with no customer cannot be matched to a payer
        if (mine <= 0.005) continue;         // settled
        docs.push(doc);
    }
    return { docs, disagreements };
}

function mount(app, cfg) {
    // Learning an alias decides which customer's invoices a future deposit is
    // allowed to pay, so it is an admin act — the same bar bankDocs.js sets
    // for changing a bank document.
    const admin = (req, res) => {
        if (req.role !== 'admin') {
            res.status(403).json({ error: 'only an admin can teach the bank matcher a name' });
            return false;
        }
        return true;
    };

    // ── GET /api/bank/match ──────────────────────────────────────────────
    // Read-only. Everything the screen needs in one call, because a screen
    // that needs four calls to show one list is a screen that shows a
    // half-populated list while two of them are still in flight.
    app.get('/api/bank/match', (req, res) => {
        try {
            const sales = require('./sales');
            const receipts = require('./salesReceipts');

            const all = sales.listWithTotals();
            const { docs, disagreements } = openReceivables(all);

            // Customers come from the SALES, not from the address book: a
            // deposit can only pay an invoice that exists, so a name with no
            // sale against it is not a candidate and offering it would invite
            // an allocation that cleanAllocations would then reject.
            const customers = [...new Set(all.map((s) => String(s.customer || '').trim()).filter(Boolean))];

            const aliases = bankLearn.listAliases();
            const resolveParty = bankLearn.resolverFrom(aliases, customers);

            const salesById = new Map(all.map((s) => [s.id, { date: s.date, amount: round2(num0(s.receivable)) }]));
            const patterns = bankLearn.patternsFromHistory(receipts.list(), salesById);

            // BANK_TX_FILE is written by the Plaid sync and is keyed by
            // transaction_id. It is also in SECRET_PATTERNS — excluded from
            // the nightly Drive backup — so nothing here logs a row of it.
            const txs = loadJson(cfg.BANK_TX_FILE, []);
            const rows = Array.isArray(txs) ? txs : (txs && Array.isArray(txs.transactions) ? txs.transactions : []);
            let deposits = bankMatch.bankInflows(rows);

            const from = String(req.query.from || '').slice(0, 10) || null;
            const to = String(req.query.to || '').slice(0, 10) || null;
            if (from) deposits = deposits.filter((d) => d.date >= from);
            if (to) deposits = deposits.filter((d) => d.date <= to);
            if (req.query.account) deposits = deposits.filter((d) => d.account_id === req.query.account);

            const out = bankMatch.matchStatement({
                deposits, openDocs: docs,
                resolveParty,
                patternsFor: (party) => patterns[party] || null,
            });

            // A row she cannot act on is worse than no row, so an unresolved
            // descriptor carries its suggestions with it. They are labelled
            // suggestions the whole way to the screen and resolve nothing.
            for (const r of out.rows) {
                if (r.outcome === 'no_party') {
                    r.suggestions = bankLearn.suggestParty(r.deposit.descriptor, customers);
                }
            }

            res.json({
                ...out,
                from, to,
                open_invoices: docs.length,
                customers_with_open: [...new Set(docs.map((d) => d.party))].length,
                // NOT a count of rows — the actual mismatches, because a
                // number she cannot investigate is a number she will ignore.
                balance_disagreements: disagreements,
                // Said plainly rather than left for her to infer from an
                // empty list: no feed means no deposits, which is not the
                // same as a clean reconciliation.
                feed: rows.length ? 'bank-transactions.json' : 'none yet — connect the bank feed or no deposits have been pulled',
                learned_names: aliases.length,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── the names she has taught it ──────────────────────────────────────
    // A list, because an alias store with no way to SEE it is the item-alias
    // problem all over again: a learned fact that silently steers money and
    // cannot be reviewed or undone from the screen.
    app.get('/api/bank/aliases', (req, res) => {
        try { res.json({ aliases: bankLearn.listAliases() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/bank/aliases', async (req, res) => {
        if (!admin(req, res)) return;
        const { descriptor, customer, why } = req.body || {};
        try {
            const row = await bankLearn.learnAlias(descriptor, customer,
                { by: req.profile || req.role || null, why: why || null });
            res.json({ ok: true, alias: row });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.delete('/api/bank/aliases', async (req, res) => {
        if (!admin(req, res)) return;
        const descriptor = (req.body && req.body.descriptor) || req.query.descriptor;
        try {
            const gone = await bankLearn.forgetAlias(descriptor);
            if (!gone) return res.status(404).json({ error: 'nothing learned for that description' });
            res.json({ ok: true, forgot: gone });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
}

module.exports = { mount, openReceivables };
