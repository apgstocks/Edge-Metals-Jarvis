// ── helpers/postings.js — her rows become debits and credits ─────────────
//
// Apsara, 2026-10-06: the year-end pack for her CPA. A trial balance, a
// general ledger, a P&L and a balance sheet are four views over ONE thing —
// a list of journal lines. This is the thing.
//
// ── DERIVED, NEVER STORED. THIS IS THE WHOLE DESIGN ──────────────────────
// Nothing here writes to bills.json, sales.json, payments.json or any other
// store. The journal is COMPUTED from them on demand and can be thrown away
// and rebuilt at any moment.
//
// That is not tidiness, it is CLAUDE.md rule 1 made structural. A posting
// layer that stored its own copy would be a second place her money lives,
// and the two would disagree the first time a bill was edited. It would also
// mean the books could only be fixed by migrating data. This way, correcting
// a rule here re-states every year instantly, and getting a rule WRONG
// cannot corrupt anything — the worst case is a wrong report, not a wrong
// ledger.
//
// It also reaches no stores itself. Rows are passed in, already carrying
// their own arithmetic. That matters: sales.json has NO amount field —
// weight and price are stored and sales.js computes the figure, with the
// lb/MT handling that makes it right. scripts/entity-audit.js read the raw
// row, found nothing, and printed $0.00 for seven real invoices. CLAUDE.md
// records that same mistake once before. Reading a raw row and calling the
// result money is how it happens every time.
//
// ── EVERY TRANSACTION BALANCES, OR IT IS NOT POSTED ──────────────────────
// Debits must equal credits to the cent. A rule that cannot produce balanced
// lines returns a PROBLEM instead of lines. Half a transaction in the
// journal is worse than none: the trial balance stops balancing and the
// cause is somewhere in a year of rows.

const C = require('./chartOfAccounts');
const E = require('./entities');

// Money is compared to the cent. payments.js:CENT exists for the same
// reason — 4010 * 2.2 is 8822.000000000001 in floating point, and a
// transaction that balances to the penny would otherwise look unbalanced by
// a billionth of one.
const CENT = 0.005;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ── THE RULES ────────────────────────────────────────────────────────────
// One per kind of thing she does. Each returns { debits, credits } as
// [account, amount] pairs; the balancing check is done once, below, rather
// than trusted to each rule.
//
// `bank` chooses between the two bank accounts and petty cash. A payment
// whose bank cannot be identified is a PROBLEM, not a guess: crediting the
// wrong bank makes both balances wrong and the error balances.
function bankAccount(tx) {
    const mode = String(tx.mode || '').trim().toLowerCase();
    if (mode === 'cash') return '1050';                 // the yard's drawer
    const b = String(tx.bank || '').trim().toLowerCase();
    if (/chase/.test(b)) return '1020';
    if (/bofa|bank of america|b of a/.test(b)) return '1010';
    return null;
}

const RULES = {
    // ── EDGE METALS: a supplier bill ─────────────────────────────────────
    // The material becomes a cost; the supplier becomes owed. Trucking on
    // the same bill is its own line because it is a different cost of sale
    // and her CPA will want it separable.
    // ── `amount` IS THE SUPPLIER'S INVOICE FIGURE, GROSS ─────────────────
    // bills.js:402-408 names the chain and it is worth repeating here,
    // because getting it backwards is a money error that still balances:
    //
    //   amount        what the metal came to
    //   − trucking    haulage she pays on the supplier's behalf
    //   = net_payable what the supplier is owed
    //
    // So the COST is the gross figure — the metal really did cost that —
    // while the supplier is owed the net, and the haulage she covers for
    // them is a liability to whoever hauled it.
    //
    // The first version took net_payable as `amount` AND subtracted
    // trucking again, booking material at 37,000 on a 40,000 bill. It
    // balanced perfectly, which is exactly why tests/books-build.js asserts
    // the figure rather than merely that something posted.
    'metals-purchase': (tx) => {
        const gross = r2(num(tx.amount));
        const trucking = r2(num(tx.trucking));
        const owedToSupplier = r2(gross - trucking);
        const credits = [['2010', owedToSupplier]];
        if (trucking > 0) credits.push(['2050', trucking]);
        return { debits: [['5000', gross]], credits };
    },

    // ── EDGE METALS: an invoice ──────────────────────────────────────────
    // The customer owes; the sale is income. Commission is a cost of THIS
    // sale (sales.js folds it into sale_side_cost) and becomes owed to the
    // agent — it is not netted off the invoice, because the customer pays
    // the full amount and the agent is paid separately.
    'metals-sale': (tx) => {
        const debits = [['1200', r2(num(tx.amount))]];
        const credits = [['4000', r2(num(tx.amount))]];
        const comm = r2(num(tx.commission));
        if (comm > 0) { debits.push(['5300', comm]); credits.push(['2100', comm]); }
        return { debits, credits };
    },

    // ── PAYING A SUPPLIER ────────────────────────────────────────────────
    // THE DISTINCTION THAT MATTERS: an APPLIED payment settles what she
    // owes (2010). An UNAPPLIED advance is money gone with nothing yet
    // against it — an ASSET (1350), not a cost. Her Payments tab shows
    // $1,184,471.93 sent and the same figure unapplied; treating that as
    // expense would take the whole lot off profit.
    'supplier-payment': (tx) => {
        const bank = bankAccount(tx);
        if (!bank) return { problem: `cannot tell which bank "${tx.bank || ''}" is, so the credit has nowhere to go` };
        const total = r2(num(tx.amount));
        const applied = r2(Math.min(num(tx.applied), total));
        const advance = r2(total - applied);
        const debits = [];
        if (applied > 0) debits.push(['2010', applied]);
        if (advance > 0) debits.push(['1350', advance]);
        return { debits, credits: [[bank, total]] };
    },

    // Applying an advance later moves it from the asset to the payable.
    // No money leaves the bank, which is why there is no bank line here —
    // a rule that touched the bank twice would double-count the payment.
    'advance-applied': (tx) => ({
        debits: [['2010', r2(num(tx.amount))]],
        credits: [['1350', r2(num(tx.amount))]],
    }),

    // ── A CUSTOMER PAYS ──────────────────────────────────────────────────
    // Bank up, receivable down. A short payment is NOT a smaller receipt:
    // the difference is a deduction she has taken on the chin, and burying
    // it would leave the invoice looking unpaid for ever.
    'customer-receipt': (tx) => {
        const bank = bankAccount(tx);
        if (!bank) return { problem: `cannot tell which bank "${tx.bank || ''}" is, so the receipt has nowhere to land` };
        const received = r2(num(tx.amount));
        const shortfall = r2(num(tx.shortfall));
        const debits = [[bank, received]];
        if (shortfall > 0) debits.push([String(tx.shortfallAccount || '5400'), shortfall]);
        return { debits, credits: [['1200', r2(received + shortfall)]] };
    },

    // ── THE YARD ─────────────────────────────────────────────────────────
    'yard-purchase': (tx) => ({
        debits: [['5000', r2(num(tx.amount))]],
        credits: [['2010', r2(num(tx.amount))]],
    }),
    'yard-sale': (tx) => ({
        debits: [['1200', r2(num(tx.amount))]],
        credits: [['4100', r2(num(tx.amount))]],
    }),
    // ── A LOCAL-DELIVERY CARRIER'S INVOICE ───────────────────────────────
    // ── 5200 TRUCKING. HER DECISION, AND SHE CORRECTED ME ────────────────
    // Apsara, 2026-10-08, asked which account, first said "5100 for them"
    // and later the same day "5200 THEN .CHECK QUICKBOOK". 5200 Trucking is
    // the answer and the QuickBooks check confirms it: qb-party-map.json
    // already maps the role "trucking" to her real QuickBooks account id
    // 374, named "Trucking". So these post where her accountant already
    // looks for them, instead of into 5100 Freight and shipping, which the
    // chart reserves for OCEAN freight.
    //
    // It also makes the two trucking paths agree. 'trucker-bill' below has
    // always debited 5200; a carrier invoice going to 5100 would have split
    // the same kind of cost across two accounts, so her trucking total
    // would have been understated wherever anyone read one of them.
    //
    // BOTH of her answers are recorded rather than just the last one,
    // because the first is in a commit message and in memory, and a reader
    // finding 5200 here after reading 5100 there deserves to know which
    // way the correction went and that it was hers both times.
    //
    // The credit is 2050 Accrued trucking and freight, which the chart already
    // describes as "Hauliers and carriers billed but unpaid".
    'carrier-invoice': (tx) => ({
        debits: [['5200', r2(num(tx.amount))]],
        credits: [['2050', r2(num(tx.amount))]],
    }),

    // ── AND PAYING ONE ───────────────────────────────────────────────────
    // Separate from the invoice so an unpaid one still shows as owed. Follows
    // 'supplier-payment' exactly on the bank: a payment whose account cannot
    // be identified is a PROBLEM, not a guess. An imported "Schneider PAID
    // mail" row says the money went but never which account it left, so it
    // surfaces as a problem she can answer rather than a credit invented
    // against BofA — which would balance perfectly and be wrong.
    'carrier-invoice-payment': (tx) => {
        const bank = bankAccount(tx);
        if (!bank) {
            return { problem: `${tx.party || 'a carrier'} invoice ${tx.ref || ''} is marked paid `
                + `${r2(num(tx.amount))} but nothing says which account it left`.replace(/\s+/g, ' ') };
        }
        return { debits: [['2050', r2(num(tx.amount))]], credits: [[bank, r2(num(tx.amount))]] };
    },

    'trucker-bill': (tx) => ({
        debits: [['5200', r2(num(tx.amount))]],
        credits: [['2050', r2(num(tx.amount))]],
    }),

    // ── AN EXPENSE ───────────────────────────────────────────────────────
    // The category chooses the account, and an unknown category is a
    // PROBLEM. Defaulting to 6900 Other would hide that the chart is
    // missing an account she needs — chartOfAccounts.js refuses to default
    // for exactly this reason and this rule must not undo it.
    expense: (tx) => {
        const account = C.accountForCategory(tx.category);
        if (!account) {
            return { problem: `no account for the category "${tx.category || '(blank)'}" — `
                + 'add one to the chart rather than letting it fall into Other' };
        }
        const bank = bankAccount(tx);
        if (!bank) return { problem: `cannot tell which bank "${tx.bank || ''}" is` };
        return { debits: [[account, r2(num(tx.amount))]], credits: [[bank, r2(num(tx.amount))]] };
    },

    // ── A BANK CHARGE ────────────────────────────────────────────────────
    'bank-charge': (tx) => {
        const bank = bankAccount(tx);
        if (!bank) return { problem: `cannot tell which bank "${tx.bank || ''}" is` };
        return { debits: [['6200', r2(num(tx.amount))]], credits: [[bank, r2(num(tx.amount))]] };
    },
};

// ── INTER-COMPANY ────────────────────────────────────────────────────────
// entities.js reports `paidBy` separately from `ledger` precisely so this
// can exist. When another company's money settled this transaction, the
// bank line belongs on THEIR books, not these ones — so on these books the
// credit goes to 2400 "due to related companies" instead of a bank account
// they do not own.
//
// The mirror entry on the paying company's books is emitted as a SECOND
// transaction (see `mirrorFor`). Both or neither: a one-sided inter-company
// entry unbalances two companies at once and is close to impossible to find
// later.
const BANK_ACCOUNTS = new Set(['1010', '1020', '1050']);

function redirectBankToInterCompany(lines) {
    return lines.map(([acct, amt]) => (BANK_ACCOUNTS.has(acct) ? ['2400', amt] : [acct, amt]));
}

function mirrorFor(tx, bankCode) {
    // On the payer's books: they are owed by the other company, and their
    // bank went down.
    return {
        kind: 'inter-company-funding',
        date: tx.date,
        entity: tx.paidBy,
        source: tx.source,
        memo: `funded ${E.get(tx.entity) ? E.get(tx.entity).uiName : tx.entity}`,
        debits: [['1400', r2(num(tx.amount))]],
        credits: [[bankCode, r2(num(tx.amount))]],
    };
}

// ── POST ONE ─────────────────────────────────────────────────────────────
// Never throws. Returns { lines, problems } — a transaction that cannot be
// posted contributes a problem and NO lines, because half a transaction in
// the journal breaks the trial balance for the whole year.
function post(kind, tx = {}) {
    const out = { kind, lines: [], problems: [] };
    const t = (tx && typeof tx === 'object') ? tx : {};
    const rule = RULES[String(kind || '')];
    if (!rule) {
        out.problems.push(`no posting rule for "${kind}"`);
        return out;
    }
    if (!t.entity || !E.get(t.entity)) {
        out.problems.push(`"${kind}" has no company against it — entities.js could not place it, `
            + 'and a line with no company cannot go on any return');
        return out;
    }
    if (Math.abs(num(t.amount)) < CENT && kind !== 'advance-applied') {
        out.problems.push(`"${kind}" has no amount`);
        return out;
    }

    const built = rule(t);
    if (built.problem) { out.problems.push(`${kind}: ${built.problem}`); return out; }

    let debits = built.debits.filter(([, a]) => Math.abs(a) >= CENT);
    let credits = built.credits.filter(([, a]) => Math.abs(a) >= CENT);

    // Another company's money settled this. Redirect the bank side here and
    // emit the matching entry on their books.
    let mirror = null;
    if (t.paidBy && t.paidBy !== t.entity && E.get(t.paidBy)) {
        const bankLine = [...debits, ...credits].find(([a]) => BANK_ACCOUNTS.has(a));
        if (bankLine) {
            debits = redirectBankToInterCompany(debits);
            credits = redirectBankToInterCompany(credits);
            mirror = mirrorFor(t, bankLine[0]);
        } else {
            // ── A SILENT DROP, CAUGHT ────────────────────────────────────
            // entities.js went to the trouble of telling us another
            // company's money settled this. If the rule produced no bank
            // line there is nothing to redirect, and the first version of
            // this simply posted the transaction as though it were funded
            // in-house — losing the inter-company fact entirely, on both
            // sets of books, with everything still balancing.
            //
            // A yard purchase is the honest case: it creates a payable, no
            // money moves, and `paidBy` on it means nothing. Which is
            // precisely why this must be said out loud rather than assumed
            // either way.
            out.problems.push(`${kind} says ${E.get(t.paidBy).uiName} paid it, but this rule moves `
                + 'no bank money, so there is nothing to record against the other company. Either '
                + 'the paidBy belongs on the PAYMENT rather than here, or this rule needs a bank line.');
            return out;
        }
    }

    const dSum = r2(debits.reduce((s, [, a]) => s + a, 0));
    const cSum = r2(credits.reduce((s, [, a]) => s + a, 0));
    if (Math.abs(dSum - cSum) >= CENT) {
        out.problems.push(`${kind} does not balance: debits ${dSum} vs credits ${cSum} — `
            + 'not posted, because half a transaction breaks the whole year\'s trial balance');
        return out;
    }

    const base = { date: t.date || null, entity: t.entity, kind,
        source: t.source || null, memo: t.memo || null, party: t.party || null };
    for (const [account, amount] of debits) out.lines.push({ ...base, account, debit: amount, credit: 0 });
    for (const [account, amount] of credits) out.lines.push({ ...base, account, debit: 0, credit: amount });

    if (mirror) {
        const mb = { date: mirror.date || null, entity: mirror.entity, kind: mirror.kind,
            source: mirror.source, memo: mirror.memo, party: null };
        for (const [account, amount] of mirror.debits) out.lines.push({ ...mb, account, debit: amount, credit: 0 });
        for (const [account, amount] of mirror.credits) out.lines.push({ ...mb, account, debit: 0, credit: amount });
        out.interCompany = true;
    }

    // Every account used must exist. A line against an unknown code lands
    // nowhere on a statement and silently shrinks a total.
    for (const l of out.lines) {
        if (!C.get(l.account)) out.problems.push(`${kind}: account ${l.account} is not in the chart`);
    }
    if (out.problems.length) out.lines = [];
    return out;
}

// ── POST MANY, AND PROVE IT ──────────────────────────────────────────────
// `balanced` is checked across the WHOLE journal as well as per transaction,
// because that is the property a trial balance depends on and it is cheap
// to assert.
function journal(entries = []) {
    const lines = [];
    const problems = [];
    let interCompany = 0;
    for (const e of (Array.isArray(entries) ? entries : [])) {
        const r = post(e && e.kind, e);
        lines.push(...r.lines);
        problems.push(...r.problems);
        if (r.interCompany) interCompany += 1;
    }
    const debit = r2(lines.reduce((s, l) => s + l.debit, 0));
    const credit = r2(lines.reduce((s, l) => s + l.credit, 0));

    // Per company too. The whole journal balancing while one company does
    // not is exactly what an inter-company entry posted on one side looks
    // like, and it is the failure these books exist to avoid.
    const byEntity = new Map();
    for (const l of lines) {
        const cur = byEntity.get(l.entity) || { debit: 0, credit: 0 };
        cur.debit += l.debit; cur.credit += l.credit;
        byEntity.set(l.entity, cur);
    }
    const entities = [...byEntity.entries()].map(([entity, v]) => ({
        entity, debit: r2(v.debit), credit: r2(v.credit),
        balanced: Math.abs(r2(v.debit) - r2(v.credit)) < CENT,
    }));

    return {
        lines, problems, interCompany,
        debit, credit,
        balanced: Math.abs(debit - credit) < CENT,
        entities,
        everyEntityBalanced: entities.every((e) => e.balanced),
        complete: problems.length === 0,
    };
}

module.exports = { post, journal, RULES, bankAccount, CENT };
