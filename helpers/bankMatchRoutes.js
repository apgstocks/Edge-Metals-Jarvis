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

const bankMatch = require('./bankMatch');
const bankLearn = require('./bankLearn');

// Which company the receivables in sales.json belong to. Edge Metals, and
// stated once here rather than guessed at three call sites.
const METALS = 'Edge Metals INC';

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
    // ── THE PAGE ─────────────────────────────────────────────────────────
    // Same standalone-page pattern as /quickbooks and /edge-inventory, and
    // the reason this whole file exists: helpers/reconcile.js has had no
    // screen since 3 September. A route with no client is the same defect
    // one step along, so the page lands in the same commit as the route.
    app.get('/bank-match', (req, res) => {
        res.sendFile(require('path').join(cfg.ROOT, 'dashboard', 'bank-match.html'));
    });

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

            // ── THE ROWS COME THROUGH bankLedger, NOT RAW ────────────────
            // This read raw JSON and handed it to bankMatch.bankInflows(),
            // which expects PLAID's signed amount (negative = money in).
            // bankLedger stores QuickBooks' shape instead — spent/received
            // and a direction — so once rows arrived through ingestPlaid
            // every deposit would have read as a withdrawal and NOTHING
            // would have matched. It would have looked like the matcher was
            // broken rather than the one line that converts between them.
            //
            // Going through worklist() is also what makes her exclusions
            // real: a row she set aside must not come back as a proposal, or
            // the Exclude button is decoration.
            const ledger = require('./bankLedger');
            const bankRows = ledger.list();
            let deposits = ledger.worklist(bankRows)
                .filter((t) => t.direction === 'in' && num0(t.received) > 0.005)
                .map((t) => ({ id: t.id, date: t.date, amount: round2(num0(t.received)),
                    descriptor: t.party || t.desc || '', account_id: t.account_id,
                    company: t.company || null, desc: t.desc || '',
                    // Which account it landed in, in the words addReceipt
                    // accepts, resolved once at ingest by bankLedger.bankOf
                    // and stored on the row. A wire has to name one, so
                    // pre-filling it saves a dropdown per row, and a wrong
                    // guess is visible and editable rather than silently
                    // posted.
                    bank_guess: t.bank || null }))
                .sort((a, b) => String(b.date).localeCompare(String(a.date)));
            const ledgerSummary = ledger.summary(bankRows);

            const from = String(req.query.from || '').slice(0, 10) || null;
            const to = String(req.query.to || '').slice(0, 10) || null;
            if (from) deposits = deposits.filter((d) => d.date >= from);
            if (to) deposits = deposits.filter((d) => d.date <= to);
            if (req.query.account) deposits = deposits.filter((d) => d.account_id === req.query.account);
            // ── RULE 5: EDGE METALS AND EDGE TRADING ARE DIFFERENT ───────
            // The receivables in sales.json are Edge Metals'. A deposit into
            // the Edge Trading account must therefore never be offered
            // against them — that is the separation most of this app exists
            // for, and an amount coincidence across two companies would be
            // the worst possible match.
            // ── AN UNKNOWN COMPANY IS NOT A PASS ─────────────────────────
            // My first version was `!d.company || d.company === METALS`,
            // which reads as cautious and is the opposite. The account_id on
            // a Plaid row is PLAID's id; qb-settings/bank-accounts.json is
            // keyed by her own ids and carries no plaid_account_id yet. So
            // in production company would be null on EVERY row and that
            // filter would have matched Edge Trading deposits against Edge
            // Metals invoices — the one thing rule 5 exists to prevent.
            //
            // Unmapped rows therefore get their own list and are NOT matched.
            // That leaves the feature inert until the accounts are linked,
            // which is correct: doing nothing beats crediting one company's
            // money to the other, and the response says exactly what to add.
            const crossCompany = deposits.filter((d) => d.company && d.company !== METALS);
            const unknownAccount = deposits.filter((d) => !d.company);
            deposits = deposits.filter((d) => d.company === METALS);

            // ── WHAT WAS NEVER TRADE, SET ASIDE HERE AND NOT IN THE ENGINE ───
            // #167. Most of a bank feed is not a customer or a supplier — bank
            // fees, the phone bill, the IRS, loan repayments, transfers between
            // her own accounts. Without this every one of them reached
            // matchDeposit, failed to resolve to a party, and came back as
            // `no_party`: "name it once and every future deposit from them
            // matches itself". For a bank charge that is an invitation to alias
            // a fee to a customer, and on the CSV path MOST of 661 pending
            // lines were this — a review queue made mostly of questions with
            // no right answer, which is how a queue stops being read.
            //
            // ── WHY NOT INSIDE helpers/bankMatch.js ──────────────────────────
            // I put it there first. tests/bank-match.js section I went red, and
            // correctly: that file is asserted to require NOTHING — no store,
            // no fs, no QuickBooks — which is what makes the matching engine
            // auditable, and one `require` of a pure helper is still the first
            // crack in it. The invariant is worth more than my convenience.
            //
            // It also belongs here on the merits. Deciding WHAT IS TRADE is
            // curating the feed; the engine's job is matching what it is given.
            // This is the same shape as crossCompany and unknownAccount
            // directly above — partition, then report the set-aside rows under
            // their own name so she knows they exist and why they are not in
            // the queue.
            const { notTrade } = require('./notTrade');
            const notTradeRows = deposits
                .map((d) => ({ row: d, why: notTrade(d) }))
                .filter((x) => x.why);
            const asideIds = new Set(notTradeRows.map((x) => x.row.id));
            deposits = deposits.filter((d) => !asideIds.has(d.id));

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
                ledger: ledgerSummary,
                // Named, not silently dropped: she needs to know these rows
                // exist and why they are not here.
                other_company: crossCompany.map((d) => ({ id: d.id, date: d.date,
                    amount: d.amount, company: d.company, desc: d.desc })),
                // Set aside, with the RULE that set each one aside — a line
                // that merely vanished from the queue would be a figure she
                // cannot account for at tax time.
                not_trade: notTradeRows.map((x) => ({ id: x.row.id, date: x.row.date,
                    amount: x.row.amount, desc: x.row.desc || x.row.descriptor || null,
                    why: x.why })),
                // Not matched, and told why, with the fix named. An account
                // whose company is unknown is a one-line edit away.
                unknown_account: unknownAccount.map((d) => ({ id: d.id, date: d.date,
                    amount: d.amount, account_id: d.account_id, desc: d.desc })),
                unknown_account_fix: unknownAccount.length
                    ? 'Add "plaid_account_id" to the matching entry in qb-settings/bank-accounts.json so Jarvis knows which company each account belongs to. Until then these are not matched against anything.'
                    : null,
                open_invoices: docs.length,
                customers_with_open: [...new Set(docs.map((d) => d.party))].length,
                // NOT a count of rows — the actual mismatches, because a
                // number she cannot investigate is a number she will ignore.
                balance_disagreements: disagreements,
                // Said plainly rather than left for her to infer from an
                // empty list: no feed means no deposits, which is not the
                // same as a clean reconciliation.
                feed: bankRows.length ? 'bank-transactions.json' : 'none yet — connect the bank feed or no deposits have been pulled',
                learned_names: aliases.length,
                // ── THE FORM IS SERVER-DRIVEN ────────────────────────────
                // Confirming posts to POST /api/sales-receipts, which
                // validates mode and bank against its own lists. A page
                // carrying its own copy of those lists would drift and she
                // would get a refusal with no way to see why.
                modes: require('./salesReceipts').RECEIPT_MODES,
                banks: (() => { try { return require('./banks').options(); } catch (e) { return []; } })(),
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

    // ── set aside, never deleted ─────────────────────────────────────────
    // Apsara, 2026-10-05, choosing how this should behave: "Hidden from the
    // worklist, still counted and reversible". So this flips a flag and
    // writes a history line; nothing is removed, and the money stays in the
    // ledger's own total where the screen shows it.
    //
    // Admin, because excluding decides what she never sees again. A real
    // payment that the bank miscategorised, excluded by someone guessing,
    // would simply stop being offered.
    app.post('/api/bank/exclude', async (req, res) => {
        if (!admin(req, res)) return;
        const b = req.body || {};
        const id = String(b.id || '').trim();
        if (!id) return res.status(400).json({ error: 'which row?' });
        // A REASON IS REQUIRED. "Why is this excluded" is asked months later
        // by someone who was not here, and an empty reason makes the history
        // line worthless at exactly the moment it is needed.
        const reason = String(b.reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'say why — an excluded row with no reason is unexplainable at tax time' });
        try {
            const ledger = require('./bankLedger');
            if (!ledger.list().some((r) => r && r.id === id)) {
                return res.status(404).json({ error: 'no bank row with that id' });
            }
            const row = await ledger.exclude(id, reason, req.profile || req.role || null);
            res.json({ ok: true, row });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post('/api/bank/include', async (req, res) => {
        if (!admin(req, res)) return;
        const id = String((req.body || {}).id || '').trim();
        if (!id) return res.status(400).json({ error: 'which row?' });
        try {
            const ledger = require('./bankLedger');
            if (!ledger.list().some((r) => r && r.id === id)) {
                return res.status(404).json({ error: 'no bank row with that id' });
            }
            const row = await ledger.include(id, req.profile || req.role || null);
            res.json({ ok: true, row });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── THE FEED ─────────────────────────────────────────────────────────
    // helpers/plaid.js holds the four calls. These routes exist so the whole
    // path — link, sync, match, confirm — is reachable from the screen rather
    // than from a shell on the VM.
    //
    // ── GET /api/bank/reconcile ──────────────────────────────────────────
    // Apsara, 2026-10-08: "so that i dont need to look out for statements
    // whether payment received or sent ever again."
    //
    // Read-only, and it answers the completeness question rather than the
    // matching one. helpers/bankReconcile.js's header has the full reasoning;
    // the part that matters at this layer is that it builds the journal from
    // booksBuild and NOT from a per-company statement, because 1010 is one
    // real bank account drawn on by more than one of her companies.
    //
    // ── WHY NO /accounts/balance/get CALL HERE ───────────────────────────
    // Plaid bills a flat fee for every successful Balance call, and this
    // route is hit on every page load. Hanging a billed call off a page load
    // is a monthly invoice that grows with how often she refreshes. The
    // movement comparison needs no live balance at all, so it makes no call.
    app.get('/api/bank/reconcile', (req, res) => {
        try {
            const BB = require('./booksBuild');
            const BR = require('./bankReconcile');
            const ledger = require('./bankLedger');

            const from = String(req.query.from || '').slice(0, 10) || null;
            const to = String(req.query.to || '').slice(0, 10) || null;
            const days = Math.max(0, Math.min(45, Number(req.query.days) || 4));

            const built = BB.build({ from, to });
            const rows = ledger.list();

            // ── IS THE FEED EVEN ALIVE? ──────────────────────────────────
            // Added 2026-10-08, a day after the rest of this route, having
            // read Plaid's webhook documentation and realised what it meant
            // for what I had already shipped.
            //
            // A Plaid Item dies on its own: ITEM_LOGIN_REQUIRED after she
            // changes her bank password, or consent expiring. Nothing throws
            // — the nightly sync simply returns no rows. Without this check
            // the page then has two failure modes and no way to tell them
            // apart:
            //
            //   · on a quiet day both sides are unchanged, so it says
            //     "movement agrees" about a feed that stopped a fortnight
            //     ago. That is the sentence she asked for, said falsely.
            //   · on a busy day her recorded payments have no bank rows to
            //     match, so it shows a growing out-gap she would chase as
            //     missing money when the answer is "nothing is connected".
            //
            // So freshness travels WITH the figures, and a stale feed makes
            // nothingNeedsYou false. A reconciliation is only as true as the
            // date of the data under it.
            // The rule itself is BR.feedHealth — see its header. It was
            // inline here and the mutation "a stale feed is judged fresh"
            // survived, because Plaid is unconfigured under test so this
            // branch never ran. Arithmetic a test cannot reach is
            // arithmetic nobody is checking.
            let feed;
            try {
                const P = require('./plaid');
                feed = BR.feedHealth(P.configured() ? P.itemsPublic() : [],
                    { configured: P.configured() });
            } catch (e) {
                feed = { linked: 0, lastSyncAt: null, staleDays: null, ok: false, note: e.message };
            }

            const banks = BR.bankAccounts().map((a) => {
                const rec = BR.reconcile({ lines: built.lines, rows, code: a.code, bank: a.bank, from, to });
                const un = BR.unexplained({ lines: built.lines, rows, code: a.code, bank: a.bank, from, to, days });
                return { ...a, reconcile: rec, unexplained: un };
            });

            const verdict = BR.nothingNeedsYou({
                feed, journalComplete: built.complete, banks });

            res.json({
                from, to, days,
                banks,
                feed,
                // An incomplete journal makes every figure above a floor
                // rather than a total, so it travels WITH them. The books
                // portal learned this the hard way: a statement built from an
                // incomplete journal looks exactly like a correct one.
                journal: { complete: built.complete, problems: built.problems || [],
                           unplaced: (built.unplaced || []).length, transactions: built.transactions },
                // ── THE SENTENCE SHE ACTS ON ─────────────────────
                // Composed by BR.nothingNeedsYou, not here. It was four
                // clauses in one expression and the mutation that broke
                // the journal clause survived, because feed.ok was already
                // false under test and hid it. Out in the helper each
                // clause is checkable on its own, and `because` lets the
                // screen say WHICH of the four is untrue.
                nothingNeedsYou: verdict.ok,
                because: verdict.reasons,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // NOTHING HERE RETURNS THE ACCESS TOKEN. config.js:342: it "must never
    // appear in an API response or a log line". plaid.itemsPublic() is the
    // only shape that leaves, and tests/plaid.js searches every response for
    // the fixture token rather than trusting that sentence.
    app.get('/api/plaid/status', (req, res) => {
        try { res.json(require('./plaid').status()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // A link token is short-lived and only starts Plaid's own iframe. Her
    // bank password is typed into Plaid, never into this server — which is
    // the entire reason to use Link rather than ask for credentials.
    app.post('/api/plaid/link-token', async (req, res) => {
        if (!admin(req, res)) return;
        try { res.json(await require('./plaid').linkToken({})); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post('/api/plaid/exchange', async (req, res) => {
        if (!admin(req, res)) return;
        const b = req.body || {};
        try {
            const out = await require('./plaid').exchange(b.public_token, { institution: b.institution || null });
            res.json({ ok: true, ...out });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Sandbox only, and plaid.js refuses outside it. This is how the path is
    // proved before Plaid grants production access, which takes a review.
    app.post('/api/plaid/sandbox-link', async (req, res) => {
        if (!admin(req, res)) return;
        try {
            const out = await require('./plaid').sandboxLink({});
            res.json({ ok: true, ...out });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post('/api/plaid/sync', async (req, res) => {
        if (!admin(req, res)) return;
        try {
            const out = await require('./plaid').syncAll({});
            // A partial failure is reported as a 200 with the errors in it,
            // not a 500: one bank needing re-authentication must not hide the
            // other bank's deposits, and a 500 would throw the good half away.
            res.json(out);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/plaid/item', async (req, res) => {
        if (!admin(req, res)) return;
        const id = String(((req.body || {}).item_id) || req.query.item_id || '').trim();
        if (!id) return res.status(400).json({ error: 'which item?' });
        try { res.json(await require('./plaid').unlink(id, {})); }
        catch (e) { res.status(400).json({ error: e.message }); }
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
