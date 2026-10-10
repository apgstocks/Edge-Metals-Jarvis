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

// Every bank row interCompany.detect() proposes as a transfer between her
// own companies. Both queues leave these out and the screen shows them in
// their own section, so a transfer is never asked about as a customer
// payment or a supplier payment.
function transferRowIds(rows) {
    try {
        const IC = require('./interCompany');
        const f = IC.detect(rows);
        // Rows already recorded as a transfer too: bankLedger.worklist keeps
        // matched rows, so without this a recorded transfer's deposit came
        // straight back as an unknown payer.
        const ids = new Set((rows || []).filter((r) => IC.linked(r)).map((r) => r.id));
        for (const p of [...f.pairs, ...f.oneSided]) {
            if (p.out_row) ids.add(p.out_row.id);
            if (p.in_row) ids.add(p.in_row.id);
        }
        return ids;
    } catch (e) { return new Set(); }
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

            // ── MONEY FROM HER OWN COMPANIES IS NEVER INCOME ─────────────
            // Apsara, 2026-10-09. A deposit that interCompany.detect() pairs
            // with money leaving Edge Yard or AAA Investment (or that names
            // one of them) is shown under "Between your companies" on the
            // same tab, NOT offered against a customer's invoice. Same
            // partition shape as not_trade above: moved, and named.
            const transferIds = transferRowIds(bankRows);
            const transferRows = deposits.filter((d) => transferIds.has(d.id));
            deposits = deposits.filter((d) => !transferIds.has(d.id));

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

            // ── A SHORT PAYMENT THAT LOOKS LIKE HER CUSTOMER'S CLAIM ─────
            // A HINT, never an action. When what a deposit leaves unpaid on
            // one invoice is within a few dollars of a claim already raised
            // on that invoice, the row says so. Settling the claim from here
            // is not wired: the deduction reasons feed the QuickBooks push
            // (quickbooks/pushPayments.js knows bank_charge and discount
            // only), so adding a third is a change to that path, not to this
            // screen.
            try {
                const claims = require('./claims').list();
                const docById = new Map(docs.map((d) => [d.id, d]));
                const norm = (v) => String(v || '').trim().toUpperCase();
                for (const r of out.rows) {
                    const p = (r.proposals || [])[0];
                    if (!p || (p.allocations || []).length !== 1) continue;
                    const a = p.allocations[0];
                    const gap = round2(num0(a.shortfall) || num0(a.leaves));
                    const doc = docById.get(a.doc_id);
                    if (!(gap > 0.005) || !doc || !doc.invoice_no) continue;
                    const c = claims.find((x) => x && norm(x.invoice_no) === norm(doc.invoice_no)
                        && num0(x.claim_amount) > 0
                        && Math.abs(num0(x.claim_amount) - gap) <= Math.max(5, gap * 0.02)
                        && !['rejected', 'withdrawn'].includes(x.status));
                    if (c) r.claim_hint = { claim_id: c.id, invoice_no: doc.invoice_no,
                        claim_amount: round2(num0(c.claim_amount)), gap, status: c.status };
                }
            } catch (e) { /* a hint that cannot be computed is simply not shown */ }

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
                // On the screen under "Between your companies".
                transfer_rows: transferRows.map((d) => ({ id: d.id, date: d.date, amount: d.amount, desc: d.desc })),
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
    // ── GET /api/bank/review ─────────────────────────────────────────────
    // Apsara, 2026-10-08: "i want like pending,posted transactions like qb
    // with match,post", and "add as a carrier bill that is also better".
    //
    // One queue covering BOTH directions. /api/bank/match above is money
    // IN only and always has been — bankOut.js, written this morning, is
    // the other half and had no route at all, which made it as dead as
    // reconcile.js was for a month.
    //
    // ── WHY THIS DOES NOT REUSE THE HANDLER ABOVE ───────────────────────
    // The obvious move is to extract /api/bank/match's 165 lines into a
    // function and call it from both. I did not, and the reason is worth
    // recording rather than rediscovering: that handler serves the screen
    // she uses, my local store is empty, and I cannot prove an extraction
    // is behaviour-preserving against data I do not have. The
    // helpers/partyName.js precedent is that an extraction must change
    // NOTHING and be proven by snapshot — and the snapshot is exactly what
    // is unavailable here.
    //
    // So this composes the same pieces in the same order, and
    // tests/bank-review-route.js asserts the two routes agree on the
    // inflow rows for identical input. That catches the drift an
    // extraction would have prevented, without touching a live screen on
    // the strength of a test that cannot see her data.
    app.get('/api/bank/review', (req, res) => {
        try {
            const ledger = require('./bankLedger');
            const BO = require('./bankOut');
            const BR = require('./bankReview');
            const BB = require('./booksBuild');
            const BRec = require('./bankReconcile');

            const from = String(req.query.from || '').slice(0, 10) || null;
            const to = String(req.query.to || '').slice(0, 10) || null;
            const rows = ledger.list();

            // ── MONEY OUT, AGAINST WHAT THE JOURNAL SAYS SHE PAID ───────
            // The journal, not the six payment stores: booksBuild already
            // enumerates every store that moves money, so a store added
            // later is matched the day it is posted rather than needing a
            // second enumeration kept in step.
            const built = BB.build({ from, to });
            // Money leaving for one of her own companies is shown under
            // "Between your companies", not asked about here as a payment.
            const tIds = transferRowIds(rows);
            const sweepRows = rows.filter((r) => !tIds.has(r.id));
            const outByBank = BRec.bankAccounts().map((a) => ({
                ...a,
                sweep: BO.sweep({ rows: sweepRows, lines: built.lines, code: a.code, from, to }),
            }));
            const withdrawalResults = outByBank.flatMap((b) => b.sweep.results);

            // Money IN is NOT computed here. Mixing a half-built inflow
            // path into this route would be the duplication the note above
            // refuses — the screen asks /api/bank/match for that side, and
            // the queue merges them client-side until one of the two is
            // genuinely extractable.
            const queue = BR.queue({ withdrawalResults });

            res.json({
                from, to,
                queue,
                // Per bank, so one dead feed cannot hide behind the other.
                banks: outByBank.map((b) => ({ code: b.code, bank: b.bank, name: b.name,
                    recorded: b.sweep.recorded, counts: b.sweep.counts,
                    autoCount: b.sweep.autoCount, unclaimed: b.sweep.unclaimed.length })),
                journal: { complete: built.complete, problems: (built.problems || []).length },
                // Same rule as /api/bank/reconcile: an incomplete journal
                // makes every figure a floor, and the screen must say so
                // before it shows a queue built on one.
                note: built.complete ? null
                    : 'the journal could not post everything, so payments may be missing from this queue',
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── POST /api/bank/review/match ──────────────────────────────────────
    // Apsara, 2026-10-08: "wire them".
    //
    // ── ONLY THE MATCH BUTTON IS WIRED, AND THAT IS THE POINT ───────────
    // The queue shows five states. This route serves exactly one of them,
    // because a match is the only action that CREATES NOTHING — it ties a
    // bank row to a payment she already recorded, so no money moves and no
    // figure changes. That is what makes it safe to offer in bulk and safe
    // for the overnight auto-tick.
    //
    // "Add as a carrier bill" is a different animal wearing a similar
    // button: it writes a new record into her books. It goes through
    // ledgerPlan/ledgerApply — verify, preview the per-supplier diff,
    // confirm, apply with an undo — and until that is wired the screen
    // renders those rows WITHOUT a button rather than with a dead one.
    // Half-wiring a create is worse than not wiring it.
    //
    // The row must still be in the queue as a `match`. The screen's idea of
    // the state is from whenever it last loaded; the server recomputes and
    // refuses if the row has moved on — the same world-moved guard as
    // ledgerApply, for the same reason.
    app.post('/api/bank/review/match', async (req, res) => {
        if (!admin(req, res)) return;
        const id = String((req.body || {}).id || '').trim();
        if (!id) return res.status(400).json({ error: 'which row?' });
        try {
            const ledger = require('./bankLedger');
            const BO = require('./bankOut');
            const BR = require('./bankReview');
            const BRec = require('./bankReconcile');
            const BB = require('./booksBuild');

            const rows = ledger.list();
            if (!rows.some((r) => r && r.id === id)) {
                return res.status(404).json({ error: 'no bank row with that id' });
            }

            const built = BB.build({});
            const results = BRec.bankAccounts()
                .flatMap((a) => BO.sweep({ rows, lines: built.lines, code: a.code }).results);
            const row = BR.queue({ withdrawalResults: results }).rows.find((r) => r.id === id);

            if (!row) {
                return res.status(409).json({ error: 'that row is no longer in the review queue — '
                    + 'it may already be matched, or excluded. Reload and look again.' });
            }
            if (row.state !== 'match') {
                // Named states, not a generic refusal: "Choose" and "Add"
                // are different problems and she needs to know which.
                return res.status(409).json({ error: row.state === 'choose'
                    ? 'several recorded payments fit this exactly — Jarvis will not pick one'
                    : `this row is "${row.label}", not a match — it would CREATE a record, which `
                      + 'goes through the plan screen so you can see the effect first',
                    state: row.state, why: row.why });
            }

            const keys = ((row.match || {}).payments || []).map((p) => p.key);
            const saved = await ledger.markMatched(id, { keys, why: row.why },
                { by: req.profile || req.role || null, how: 'her' });
            res.json({ ok: true, row: saved, matched: keys.length });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

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
        // item_id present = SIGN IN AGAIN to a bank already linked (Plaid's
        // update mode). Absent = link a new bank, exactly as before.
        const itemId = String(((req.body || {}).item_id) || '').trim() || null;
        try { res.json(await require('./plaid').linkToken({ itemId })); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    // After she signs back in through update mode there is no new token to
    // exchange — the old one works again. This clears the flag and pulls, so
    // the screen shows the result of the fix rather than the old warning.
    app.post('/api/plaid/reconnected', async (req, res) => {
        if (!admin(req, res)) return;
        const id = String(((req.body || {}).item_id) || '').trim();
        if (!id) return res.status(400).json({ error: 'which bank?' });
        try {
            const P = require('./plaid');
            await P.clearNeedsLogin(id);
            const out = await P.syncAll({});
            res.json({ ok: true, ...out });
        } catch (e) { res.status(400).json({ error: e.message }); }
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

    // ── GET /api/bank/overview — the account cards and "coming in" ──────
    // Apsara, 2026-10-09, on the Bank mock-up: one card per company account
    // (Edge Metals BofA, AAA Investment, Edge Yard Chase), a warning on the
    // one that needs signing in again, and what customers still owe.
    //
    // Read-only and makes NO billed Plaid call. A balance is shown only when
    // Plaid sent one WITH an ordinary transactions pull; otherwise the card
    // shows what moved in the chosen dates, and says which it is.
    app.get('/api/bank/overview', (req, res) => {
        try {
            const ledger = require('./bankLedger');
            const E = require('./entities');
            const P = require('./plaid');
            const from = String(req.query.from || '').slice(0, 10) || null;
            const to = String(req.query.to || '').slice(0, 10) || null;
            const rows = ledger.list();
            const inDates = (r) => (!from || String(r.date) >= from) && (!to || String(r.date) <= to);
            const items = P.configured() ? P.itemsPublic() : [];
            const plaidAcct = new Map();
            for (const it of items) for (const a of (it.accounts || [])) plaidAcct.set(a.account_id, { it, a });

            const last4 = (v) => String(v || '').replace(/\D/g, '').slice(-4);
            const mine = ledger.readAccounts();
            const cards = [];
            const seenPlaid = new Set();
            const totals = (ids) => {
                const rs = rows.filter((r) => ids.includes(r.account_id) && !r.pending && inDates(r));
                const sum = (k) => round2(rs.reduce((t, r) => t + num0(r[k]), 0)) || 0;
                return { in: sum('received'), out: sum('spent'), rows: rs.length,
                    waiting: rs.filter((r) => !r.excluded && !r.matched).length };
            };
            for (const a of mine) {
                const ent = E.resolve(a.company);
                const pid = a.plaid_account_id || null;
                const hit = pid ? plaidAcct.get(pid) : null;
                if (pid) seenPlaid.add(pid);
                const ids = [a.id, pid].filter(Boolean);
                const bal = hit && hit.it.balances ? hit.it.balances[pid] : null;
                cards.push({
                    key: a.id, entity: ent, company: ent ? E.get(ent).uiName : a.company,
                    bank: /chase/i.test(a.bank || '') ? 'Chase' : (/america/i.test(a.bank || '') ? 'Bank of America' : (a.bank || '')),
                    mask: last4(a.accountNumber) || (hit && hit.a.mask) || null,
                    linked: !!hit, item_id: hit ? hit.it.item_id : null,
                    institution: hit ? hit.it.institution : null,
                    last_sync_at: hit ? hit.it.last_sync_at : null,
                    needs_login: hit ? hit.it.needs_login : null,
                    balance: bal ? bal.current : null, balance_as_of: bal ? bal.as_of : null,
                    ...totals(ids),
                });
            }
            // Linked at Plaid but not in her account list: shown, not guessed
            // into a company — the same rule as /api/bank/match.
            for (const [pid, { it, a }] of plaidAcct) {
                if (seenPlaid.has(pid)) continue;
                const bal = it.balances ? it.balances[pid] : null;
                cards.push({ key: pid, entity: null, company: null, bank: it.institution || 'Bank',
                    mask: a.mask || null, linked: true, item_id: it.item_id, institution: it.institution,
                    last_sync_at: it.last_sync_at, needs_login: it.needs_login,
                    balance: bal ? bal.current : null, balance_as_of: bal ? bal.as_of : null,
                    unassigned: true, ...totals([pid]) });
            }
            // A company with no bank account record at all (AAA today).
            const covered = new Set(cards.map((c) => c.entity).filter(Boolean));
            const missing = E.ENTITIES.filter((e) => !covered.has(e.id))
                .map((e) => ({ entity: e.id, company: e.uiName, banks: e.banks }));

            // Coming in: what customers still owe Edge Metals, oldest first.
            let coming = { total: 0, count: 0, invoices: [] };
            try {
                const { docs } = openReceivables(require('./sales').listWithTotals());
                const today = new Date().toISOString().slice(0, 10);
                const list = docs.map((d) => ({ id: d.id, invoice_no: d.invoice_no, customer: d.party,
                    date: d.date, open: bankMatch.openBalance(d),
                    days: d.date ? Math.max(0, Math.round((Date.parse(today) - Date.parse(d.date)) / 86400000)) : null }))
                    .sort((x, y) => String(x.date).localeCompare(String(y.date)));
                coming = { total: round2(list.reduce((t, x) => t + x.open, 0)) || 0, count: list.length,
                    invoices: list.slice(0, 8) };
            } catch (e) { coming.error = e.message; }

            res.json({ from, to, accounts: cards, missing, coming_in: coming,
                needs_login: items.filter((i) => i.needs_login).map((i) => ({ item_id: i.item_id,
                    institution: i.institution, ...i.needs_login })) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── RULES: "lines like this are always a bank charge" ────────────────
    // POST with dry:true answers "how many rows would this set aside?" so the
    // screen can say the number before anything happens.
    app.get('/api/bank/rules', (req, res) => {
        res.json({ rules: bankLearn.listRules(), labels: bankLearn.RULE_LABELS });
    });
    app.post('/api/bank/rules', async (req, res) => {
        if (!admin(req, res)) return;
        const b = req.body || {};
        try {
            const rule = bankLearn.cleanRule(b);
            const hits = bankLearn.ruleHits(rule, require('./bankLedger').list());
            if (b.dry) {
                return res.json({ ok: true, dry: true, rule, would: hits.length,
                    money: round2(hits.reduce((t, r) => t + num0(r.amount != null ? Math.abs(r.amount) : (r.spent || r.received)), 0)) || 0,
                    sample: hits.slice(0, 5).map((r) => ({ id: r.id, date: r.date, desc: r.desc || r.party || '' })) });
            }
            const saved = await bankLearn.addRule(rule, { by: req.profile || req.role || null });
            const applied = await bankLearn.applyRules({ by: req.profile || req.role || 'rule', only: saved });
            res.json({ ok: true, rule: saved, ...applied });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/api/bank/rules', async (req, res) => {
        if (!admin(req, res)) return;
        const b = req.body || {};
        try {
            const gone = await bankLearn.deleteRule(b.text, b.direction);
            if (!gone) return res.status(404).json({ error: 'no such rule' });
            // Rows it already set aside STAY set aside — each one is a decision
            // with its own reason and history, and putting forty rows back in
            // the queue because a rule was tidied away would be a surprise.
            res.json({ ok: true, deleted: gone });
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
