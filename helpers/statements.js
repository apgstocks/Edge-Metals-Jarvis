// ── helpers/statements.js — the four things her CPA asks for ─────────────
//
// Apsara, 2026-10-06: the year-end pack. Trial balance, general ledger,
// profit and loss, balance sheet — PER COMPANY, because she has three that
// each file their own return.
//
// All four are views over the one list of journal lines helpers/postings.js
// produces. They are built in one file ON PURPOSE: their value is not that
// each prints, it is that they AGREE WITH EACH OTHER. Four files would let
// them drift, and a P&L whose profit does not appear on the balance sheet
// is the kind of thing an accountant finds and a business owner does not.
//
// ── THE THREE TIES THAT MUST HOLD ────────────────────────────────────────
//   1. A trial balance's debits equal its credits.
//   2. A general ledger for one account sums to that account's trial
//      balance figure.
//   3. Assets = liabilities + equity + the profit on the P&L.
//
// If any of those breaks, the pack is wrong and says so rather than
// printing. CLAUDE.md's lesson about figures that balance while being
// wrong applies to every line of this file.
//
// ── NEVER ACROSS COMPANIES ───────────────────────────────────────────────
// CLAUDE.md rule 5. Every function here takes ONE entity and refuses to
// work without it. There is no "all companies" total, because there is no
// such taxpayer — summing Edge Metals and Edge Trading produces a figure
// that belongs on no return and reassures nobody.

const C = require('./chartOfAccounts');
const E = require('./entities');

const CENT = 0.005;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Dates are compared as strings. Every store writes ISO-ish dates and a
// string compare is correct for those; parsing them into Date objects would
// drag in a timezone, and a container invoiced on the 31st must not move
// into the next month because the server is in another zone. Her Pacific
// filing date already caused that once (#56).
function inRange(date, from, to) {
    const d = String(date || '');
    if (from && d < String(from)) return false;
    if (to && d > String(to)) return false;
    return true;
}

function linesFor(lines, { entity, from, to } = {}) {
    if (!entity) throw new Error('statements need a company — there is no combined taxpayer');
    return (Array.isArray(lines) ? lines : [])
        .filter((l) => l && l.entity === entity && inRange(l.date, from, to));
}

// ── TRIAL BALANCE ────────────────────────────────────────────────────────
// Every account, its debits, its credits, and the balance on its own normal
// side. The totals must match; if they do not, nothing above this is worth
// reading and the caller is told so rather than shown a statement.
function trialBalance(lines, opts = {}) {
    const rows = new Map();
    for (const l of linesFor(lines, opts)) {
        const cur = rows.get(l.account) || { debit: 0, credit: 0 };
        cur.debit += Number(l.debit) || 0;
        cur.credit += Number(l.credit) || 0;
        rows.set(l.account, cur);
    }

    const accounts = [...rows.entries()].map(([code, v]) => {
        const a = C.get(code);
        const debit = r2(v.debit);
        const credit = r2(v.credit);
        // Balance is shown on the side the account normally sits. A supplier
        // payable with a debit balance is not a typo to be hidden — it means
        // she has overpaid someone, and the sign is how she finds out.
        const normal = a ? C.normalOf(a.type) : null;
        const net = normal === 'credit' ? r2(credit - debit) : r2(debit - credit);
        return {
            code,
            name: a ? a.name : `(not in the chart: ${code})`,
            type: a ? a.type : null,
            known: !!a,
            debit, credit, balance: net, normal,
        };
    }).sort((a, b) => a.code.localeCompare(b.code));

    const debit = r2(accounts.reduce((s, a) => s + a.debit, 0));
    const credit = r2(accounts.reduce((s, a) => s + a.credit, 0));
    const unknown = accounts.filter((a) => !a.known);

    return {
        entity: opts.entity, from: opts.from || null, to: opts.to || null,
        accounts, debit, credit,
        balanced: Math.abs(debit - credit) < CENT,
        // An account not in the chart lands on no statement. It would make
        // the P&L and balance sheet silently disagree with this, so it is
        // surfaced here where it is still findable.
        unknown,
        ok: Math.abs(debit - credit) < CENT && unknown.length === 0,
    };
}

// ── GENERAL LEDGER ───────────────────────────────────────────────────────
// Every movement on one account, in date order, with a running balance —
// so a figure she disputes can be followed down to the row that caused it.
// `source` rides along from the posting, which is what makes that possible.
function generalLedger(lines, opts = {}) {
    const { account } = opts;
    if (!account) throw new Error('the general ledger needs an account');
    const a = C.get(account);

    const rows = linesFor(lines, opts)
        .filter((l) => l.account === account)
        .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));

    const normal = a ? C.normalOf(a.type) : 'debit';
    let running = 0;
    const entries = rows.map((l) => {
        const move = normal === 'credit'
            ? (Number(l.credit) || 0) - (Number(l.debit) || 0)
            : (Number(l.debit) || 0) - (Number(l.credit) || 0);
        running = r2(running + move);
        return {
            date: l.date, kind: l.kind, party: l.party || null, memo: l.memo || null,
            source: l.source || null,
            debit: r2(l.debit), credit: r2(l.credit), balance: running,
        };
    });

    return {
        entity: opts.entity, account,
        name: a ? a.name : `(not in the chart: ${account})`,
        type: a ? a.type : null,
        from: opts.from || null, to: opts.to || null,
        entries,
        debit: r2(entries.reduce((s, e) => s + e.debit, 0)),
        credit: r2(entries.reduce((s, e) => s + e.credit, 0)),
        closing: running,
    };
}

// ── PROFIT AND LOSS ──────────────────────────────────────────────────────
// Income less cost of sales is gross profit; less overheads is net. Laid
// out in the order an accountant reads, and every section carries its own
// accounts so a number can be opened rather than argued with.
function profitAndLoss(lines, opts = {}) {
    const tb = trialBalance(lines, opts);
    const pick = (type) => tb.accounts.filter((a) => a.type === type);

    const income = pick('income');
    const cogs = pick('cogs');
    const expense = pick('expense');

    const total = (rows) => r2(rows.reduce((s, a) => s + a.balance, 0));
    const incomeTotal = total(income);
    const cogsTotal = total(cogs);
    const expenseTotal = total(expense);
    const grossProfit = r2(incomeTotal - cogsTotal);
    const netIncome = r2(grossProfit - expenseTotal);

    return {
        entity: opts.entity, from: opts.from || null, to: opts.to || null,
        income, cogs, expense,
        incomeTotal, cogsTotal, expenseTotal, grossProfit, netIncome,
        // Carried through so a caller cannot read a profit off a pack whose
        // trial balance did not balance.
        trialBalanceOk: tb.ok,
    };
}

// ── EVERYTHING THAT HAPPENED BEFORE THIS PERIOD STARTED ──────────────────
// Exclusive on `from`, and no `to` — the whole of history up to the day the
// period opens. Used for one thing only: retained earnings.
//
// Deliberately NOT expressed as `inRange(date, null, dayBefore(from))`. That
// would need date arithmetic on a string, and this file's own note at the top
// explains why that is a trap here: her Pacific filing date already moved a
// container into the wrong month once (#56). `date < from` is a string
// compare that needs no calendar and cannot drift by a timezone.
function priorLines(lines, { entity, from } = {}) {
    if (!entity) throw new Error('statements need a company — there is no combined taxpayer');
    if (!from) return [];
    return (Array.isArray(lines) ? lines : [])
        .filter((l) => l && l.entity === entity && String(l.date || '') < String(from));
}

// ── BALANCE SHEET ────────────────────────────────────────────────────────
// And the check that makes the whole pack trustworthy: assets must equal
// liabilities plus equity plus retained earnings plus the profit the P&L has
// just reported.
//
// ── WHAT WAS ACTUALLY WRONG HERE, 2026-10-23 — MY FINDING, NOT HERS ──────
// The note that stood here said the period's profit is included "because it
// has not been moved into retained earnings yet — that happens at year end".
// The first half is right. The second half was never true: nothing in this
// repo closes a year, and `retainedEarnings` had no occurrence anywhere.
//
// But that is NOT the defect, and I nearly shipped a fix for the wrong thing.
// Adding retained earnings to the right-hand side alone made a second-year
// sheet go OUT by exactly the first year's profit. A probe showed why, and
// the real problem is worse:
//
// ── THE OLD TIE COULD NOT FAIL, SO IT PROVED NOTHING ─────────────────────
// This function filtered EVERY account by the period, `from` included. So
// for from=2027-01-01 it reported 2027's MOVEMENT in cash and payables, not
// the cash and payables the company holds. On a two-year journal it showed
// assets of 31,000 when the company's assets were 80,000.
//
// And it balanced. Every journal entry balances, so any complete subset of
// them balances: debits = credits gives Δassets = Δliabilities + Δequity +
// period profit, which is precisely what rightSide computed. The check that
// this whole file treats as its proof of correctness was an identity that
// holds for any date range whatsoever. Same class of error as the assertion
// deleted from tests/claims-read-mail.js this week, which tested a string it
// had just concatenated onto its own input.
//
// A balance sheet is an AS-AT statement. So:
//   positions (asset, liability, equity)  — everything up to `to`, and
//                                           `from` is deliberately ignored
//   profit for the period                 — from..to, as before
//   retained earnings                     — profit before `from`, DERIVED
//                                           from the same profitAndLoss, so
//                                           there is still one definition of
//                                           profit in this file and no
//                                           year-end journal to remember
//
// Cumulative assets = cumulative liabilities + equity + retained + period
// profit, and now the tie can actually fail: feed it an unbalanced journal
// and it reports the gap instead of absorbing it.
//
// ── WHAT THIS CHANGES ON HER DOCUMENTS ───────────────────────────────────
// With `from` unset or earlier than every line, retained earnings is 0 and
// every figure is identical to yesterday's — which is the whole of the 2026
// year-to-date pack she has been looking at. It changes only a period that
// OPENS after earlier activity: a quarterly or second-year sheet, where
// assetTotal and liabilityTotal stop being movements and become balances.
// Those figures were wrong and are now right, but they are figures her CPA
// receives, so this wants her yes before it ships.
function balanceSheet(lines, opts = {}) {
    // POSITIONS, as at `to`. `from` is dropped on purpose — see above.
    const asAt = trialBalance(lines, { entity: opts.entity, to: opts.to });
    // PROFIT, for the period as asked.
    const pl = profitAndLoss(lines, opts);
    const pick = (type) => asAt.accounts.filter((a) => a.type === type);

    const assets = pick('asset');
    const liabilities = pick('liability');
    const equity = pick('equity');
    const total = (rows) => r2(rows.reduce((s, a) => s + a.balance, 0));

    const assetTotal = total(assets);
    const liabilityTotal = total(liabilities);
    const equityTotal = total(equity);
    const netIncome = pl.netIncome;

    // The entity is passed on, but no date bounds: profitAndLoss must see the
    // whole of the prior lines it has been handed, not re-apply this period's.
    const prior = priorLines(lines, opts);
    const retainedEarnings = prior.length
        ? profitAndLoss(prior, { entity: opts.entity }).netIncome
        : 0;

    const rightSide = r2(liabilityTotal + equityTotal + retainedEarnings + netIncome);
    const difference = r2(assetTotal - rightSide);

    return {
        entity: opts.entity, from: opts.from || null, to: opts.to || null,
        assets, liabilities, equity,
        assetTotal, liabilityTotal, equityTotal, retainedEarnings, netIncome,
        rightSide, difference,
        balances: Math.abs(difference) < CENT,
        // The as-at view's, not the period's — these are the accounts this
        // statement is actually built from.
        trialBalanceOk: asAt.ok,
    };
}

// ── THE WHOLE PACK, WITH ITS OWN VERDICT ─────────────────────────────────
// Returns the four statements AND whether they agree. `ok` is the only
// thing a caller should act on: a pack that does not tie is not a pack, and
// printing one anyway is how a wrong return gets filed.
function pack(lines, opts = {}) {
    const entity = opts.entity;
    const ent = E.get(entity);
    const tb = trialBalance(lines, opts);
    const pl = profitAndLoss(lines, opts);
    const bs = balanceSheet(lines, opts);

    const problems = [];
    if (!tb.balanced) problems.push(`the trial balance does not balance: debits ${tb.debit} vs credits ${tb.credit}`);
    for (const u of tb.unknown) {
        problems.push(`account ${u.code} is not in the chart, so it appears on no statement `
            + `(${u.debit} debit, ${u.credit} credit)`);
    }
    if (!bs.balances) {
        problems.push(`the balance sheet is out by ${bs.difference}: assets ${bs.assetTotal} `
            + `against liabilities + equity`
            // Named only when there is one, so the sentence for a first-year
            // company reads exactly as it did before this was added.
            + (bs.retainedEarnings ? ' + retained earnings' : '')
            + ` + profit ${bs.rightSide}`);
    }

    // ── CAN A RETURN ACTUALLY BE FILED FROM THIS? ────────────────────────
    // Separate from whether the arithmetic ties. Edge Trading has no tax ID
    // and AAA Investment has neither a tax ID nor an address — entities.js
    // knows, and the pack must refuse to present itself as filable rather
    // than printing a blank where the number goes.
    const f = entity ? E.filable(entity) : { ok: false, missing: ['a company'] };

    return {
        entity, company: ent || null,
        from: opts.from || null, to: opts.to || null,
        trialBalance: tb, profitAndLoss: pl, balanceSheet: bs,
        problems,
        ok: problems.length === 0,
        filable: f.ok,
        filingBlockers: f.ok ? [] : f.missing,
    };
}

module.exports = { trialBalance, generalLedger, profitAndLoss, balanceSheet, pack, inRange, priorLines, CENT };
