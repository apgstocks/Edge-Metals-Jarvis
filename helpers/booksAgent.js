// ── helpers/booksAgent.js ─────────────────────────────────────────────────
// Apsara, 2026-10-07: "built that qb portal professionally with an qb agent".
//
// ── WHY THIS IS NOT AN EIGHTH AGENT ──────────────────────────────────────
// There are already seven agent files: qbAgent, quickbooks/agent, ledgerAgent,
// claimsAgent and their three jobs. The QuickBooks agent talks to Intuit — it
// needs a live connection, and it has its own page. This one never leaves the
// building: it reads the journal helpers/booksBuild.js has just derived from
// her own stores and says what is wrong with it.
//
// They answer different questions. "Does QuickBooks agree with us" is the QB
// agent's. "Can these books be trusted at all" is this one's, and nothing
// could answer it before, because booksBuild returns `unplaced`, `problems`
// and `tb.unknown` as raw arrays that a screen would have had to interpret.
// Interpreting money in a template is how a wrong number gets a nice font.
//
// ── IT IS DETERMINISTIC, AND THAT IS THE POINT ───────────────────────────
// No model call. Every finding here is arithmetic or a set difference, so the
// same books produce the same findings every time and a finding can be
// mutation-tested. The AI is good at wording and bad at being the reason a
// figure is trusted; `/api/qb/ask` already exists for the wording.
//
// ── READ-ONLY, WITH NO ARGUMENT ABOUT IT ─────────────────────────────────
// This module has no write path and requires none. helpers/ledgerAgent.js
// applies fixes and has a careful `allowMoney` gate for exactly that reason;
// the books are DERIVED, so there is nothing here to fix in place — the fix is
// always in the source row, on the screen that owns it. Every finding
// therefore names where she would go, not a button that writes.

const E = require('./entities');
const C = require('./chartOfAccounts');
const S = require('./statements');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${r2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Worst first. A trial balance that does not balance makes every figure below
// it meaningless, so it must never sort under a note about a missing category.
const SEVERITIES = ['blocker', 'high', 'normal'];
const rank = (s) => {
    const i = SEVERITIES.indexOf(s);
    return i === -1 ? SEVERITIES.length : i;
};

// ── THE INTER-COMPANY PAIR ───────────────────────────────────────────────
// CLAUDE.md rule 5: Edge Yard and Edge Metals are different companies, and the
// separation is most of what this app is for. The chart carries 1400 "Due from
// group company" and 2400 "Due to group company" as a PAIR: whatever one
// company is owed by the group, the others must owe. If the two sides disagree
// the money exists on one set of books and not the other, which is the single
// most expensive thing that can be wrong here and is invisible on any one
// company's statements — each balances perfectly on its own.
const DUE_FROM = '1400';
const DUE_TO = '2400';

function interCompany(lines, { from = null, to = null } = {}) {
    let due = 0, owed = 0;
    const byEntity = new Map();
    // S.inRange takes a DATE, not an array — a first draft of this called it
    // as `inRange(lines, {from, to})` and iterated the boolean it returned.
    // The dates are filtered here, by hand, deliberately WITHOUT an entity
    // filter: both sides of the pair have to be in view or there is nothing to
    // compare.
    for (const l of lines) {
        if (!S.inRange(l.date, from, to)) continue;
        if (l.account !== DUE_FROM && l.account !== DUE_TO) continue;
        const e = l.entity || '(none)';
        const cur = byEntity.get(e) || { from: 0, to: 0 };
        // Each side is read on its own normal side: a receivable is a debit
        // balance, a payable a credit balance.
        if (l.account === DUE_FROM) cur.from += (Number(l.debit) || 0) - (Number(l.credit) || 0);
        else cur.to += (Number(l.credit) || 0) - (Number(l.debit) || 0);
        byEntity.set(e, cur);
    }
    for (const v of byEntity.values()) { due += v.from; owed += v.to; }
    return {
        due: r2(due),
        owed: r2(owed),
        difference: r2(due - owed),
        agrees: Math.abs(r2(due - owed)) < 0.005,
        byEntity: [...byEntity.entries()].map(([entity, v]) => ({
            entity, due: r2(v.from), owed: r2(v.to),
        })),
    };
}

// ── THE FINDINGS ─────────────────────────────────────────────────────────
// `built` is helpers/booksBuild.js's return. `entity` is whose books are on
// screen — required, because statements.js refuses to combine companies and so
// does this ("there is no combined taxpayer").
function review(built, { entity, from = null, to = null } = {}) {
    if (!built || !Array.isArray(built.lines)) throw new Error('booksAgent needs a built journal');
    const ent = E.get(entity);
    if (!ent) throw new Error(`no company ${entity}`);
    // uiName, NOT name. entities.js carries `legalName`, `uiName` and `id`;
    // there is no `name`. A first draft read ent.name and every sentence this
    // module produces began "undefined:" — including the one that tells her
    // not to trust the figures.
    const who = ent.uiName || ent.legalName || ent.id;

    const packed = S.pack(built.lines, { entity, from, to });
    const tb = packed.trialBalance;
    const bs = packed.balanceSheet;
    const pl = packed.profitAndLoss;
    const findings = [];
    const add = (f) => findings.push(f);

    // How many journal lines are THIS company's, inside the range. Lines, not
    // transactions: booksBuild counts transactions across all companies and
    // there is no per-entity count on it.
    const mine = built.lines.filter((l) => l.entity === entity
        && S.inRange(l.date, from, to)).length;

    // 1. THE BOOKS DO NOT ADD UP. Nothing else matters until this is fixed.
    if (!tb.balanced) {
        add({
            code: 'trial-balance-unbalanced', severity: 'blocker',
            what: 'the debits and credits do not match',
            why: `debits come to ${money(tb.debit)} and credits to ${money(tb.credit)}, a gap of `
                + `${money(Math.abs(r2(tb.debit - tb.credit)))}. Every figure below this is wrong by `
                + 'some part of that gap, including the profit.',
            money: Math.abs(r2(tb.debit - tb.credit)),
            fix: 'This is a bug in how a transaction is posted, not something wrong with her '
                + 'paperwork. helpers/postings.js has a rule per transaction kind and each must '
                + 'balance on its own.',
            where: 'helpers/postings.js',
        });
    }

    if (!bs.balances) {
        add({
            code: 'balance-sheet-out', severity: 'blocker',
            what: `the balance sheet is out by ${money(Math.abs(bs.difference))}`,
            why: `assets ${money(bs.assetTotal)} against liabilities, equity and profit `
                + `${money(bs.rightSide)}.`,
            money: Math.abs(r2(bs.difference)),
            fix: 'Same cause as an unbalanced trial balance in almost every case — find the '
                + 'posting rule that does not balance.',
            where: 'helpers/postings.js',
        });
    }

    // 2. MONEY THAT BELONGS TO NOBODY. The journal was built, it balances, and
    //    rows were left out of it — so the profit on screen is SMALLER than the
    //    truth and looks exactly like a correct one. booksBuild sets `complete`
    //    false for this; that flag is easy to ignore and a figure is not.
    if ((built.unplaced || []).length) {
        // ── COUNTED IN ROWS, NOT IN DOLLARS, ON PURPOSE ──────────────────
        // booksBuild's unplaced entries are { store, row, why } — there is no
        // `amount`, and the amount field differs per store (a bill's is
        // supplier_invoice_amount, a sale has none and must be computed by
        // sales.listWithTotals). An earlier version of scripts/entity-audit.js
        // read `row.amount` and printed $0.00 against seven real invoices,
        // which is worse than printing nothing: a zero reads as "no money
        // involved". So this reports rows and names the stores, and leaves the
        // figure to entity-audit.js, which knows how to total each store.
        const byStore = new Map();
        for (const u of built.unplaced) {
            const k = u.store || '(unknown store)';
            const cur = byStore.get(k) || { rows: 0, why: u.why || null };
            cur.rows += 1;
            if (!cur.why && u.why) cur.why = u.why;
            byStore.set(k, cur);
        }
        add({
            code: 'unplaced-rows', severity: 'high',
            what: `${built.unplaced.length} row${built.unplaced.length === 1 ? '' : 's'} could not be `
                + 'put on any company, so they are on no statement',
            why: [...byStore.entries()]
                .map(([store, v]) => `${store}: ${v.rows} row${v.rows === 1 ? '' : 's'}`
                    + (v.why ? ` — ${v.why}` : ''))
                .join('; ')
                + '. These are missing from the profit, not wrong in it. '
                + 'The amount is deliberately not totalled here — see the note in booksAgent.js.',
            money: 0,
            rows: built.unplaced.length,
            fix: 'Each row needs to say which company it belongs to. '
                + '`node scripts/entity-audit.js --show 30` lists them with what it would guess, '
                + 'and changes nothing.',
            where: 'scripts/entity-audit.js',
        });
    }

    // 3. AN ACCOUNT THE CHART HAS NEVER HEARD OF. The money is in the journal
    //    and on no statement, because every statement is built by walking the
    //    chart. This is the silent one: the trial balance still balances.
    for (const u of (tb.unknown || [])) {
        const amount = Math.abs(r2((Number(u.debit) || 0) - (Number(u.credit) || 0)));
        add({
            code: 'account-not-in-chart', severity: 'high',
            what: `account ${u.code} is not in the chart of accounts`,
            why: `${money(u.debit)} debit and ${money(u.credit)} credit are posted to it, and it `
                + 'appears on no statement — the trial balance still balances, so nothing else '
                + 'shows this.',
            money: amount,
            fix: `Add ${u.code} to helpers/chartOfAccounts.js with its type, or correct the posting `
                + 'rule that invented it.',
            where: 'helpers/chartOfAccounts.js',
        });
    }

    // 4. THE TWO COMPANIES DISAGREE. See the note on DUE_FROM above: this is
    //    invisible on either company's own statements.
    const ic = interCompany(built.lines, { from, to });
    if (!ic.agrees) {
        add({
            code: 'inter-company-mismatch', severity: 'blocker',
            what: 'the companies do not agree on what they owe each other',
            why: `one side is owed ${money(ic.due)} and the other side owes ${money(ic.owed)}, a `
                + `difference of ${money(Math.abs(ic.difference))}. Each company's own books still `
                + 'balance, which is why no single statement shows this.',
            money: Math.abs(r2(ic.difference)),
            fix: 'A payment made by one company for another has been recorded on one set of books '
                + 'only. The Spend Report, filtered by paying company, is where the one-sided '
                + 'entry shows up.',
            where: 'Spend Report, filtered by paying company',
        });
    }

    // 5. A STORE THAT WOULD NOT LOAD. booksBuild carries on and notes it, which
    //    is right — one unreadable store must not take the whole P&L down — but
    //    the statements are then built from less than everything.
    for (const n of (built.notes || [])) {
        add({
            code: 'store-note', severity: 'normal',
            what: 'a store could not be read, so its rows are missing',
            why: String(n),
            money: 0,
            fix: 'Until that store loads, these statements are built from less than all of her '
                + 'data.',
            where: null,
        });
    }

    // 6. NOTHING TO REPORT ON AT ALL. A clean, empty answer and a correct one
    //    look identical: zero profit with zero transactions is not a result.
    //
    //    COUNTED FOR THIS COMPANY, not for the build. The first version tested
    //    built.transactions, which is every company's rows added together — so
    //    AAA Investment reported "1 transactions, books balance, nothing
    //    unplaced" off a single Edge Metals bill while every figure on its
    //    statements was zero. That is the exact failure this finding exists to
    //    prevent, defeated by its own headline.
    if (!mine) {
        add({
            code: 'no-transactions', severity: 'normal',
            what: 'there is nothing in this date range',
            why: 'no transaction fell inside it, so every figure below is zero because there is '
                + 'no data, not because the business made nothing.',
            money: 0,
            fix: 'Widen the dates, or check the company — rows belonging to another company are '
                + 'not counted here.',
            where: null,
        });
    }

    findings.sort((a, b) => rank(a.severity) - rank(b.severity)
        || Math.abs(b.money) - Math.abs(a.money));

    const worst = findings.length ? findings[0].severity : null;
    return {
        entity, entityName: who, legalName: ent.legalName || who, taxId: ent.taxId || null,
        from, to,
        // `trustworthy` is the one word the screen should lead with. A blocker
        // means the figures are wrong; `high` means they are incomplete, which
        // is a different and quieter kind of wrong.
        trustworthy: !findings.some((f) => f.severity === 'blocker' || f.severity === 'high'),
        worst,
        findings,
        counts: SEVERITIES.reduce((o, s) => {
            o[s] = findings.filter((f) => f.severity === s).length;
            return o;
        }, {}),
        interCompany: ic,
        // Repeated here so a caller showing the agent's verdict beside the
        // numbers is showing the SAME build, not a second read of the stores.
        headline: {
            // This company's journal lines, and the build's transaction count
            // separately — conflating them is what made an empty company look
            // busy.
            lines: mine,
            transactionsAllCompanies: built.transactions,
            netIncome: pl.netIncome,
            balanced: tb.balanced,
            complete: built.complete === true,
        },
    };
}

// One line she could be told out loud, or put in an email subject. Deliberately
// not generated by a model: this sentence is the one that decides whether she
// trusts the page, so it says only what the arithmetic found.
function summary(r) {
    if (!r.findings.length) {
        const n = r.headline.lines;
        return `${r.entityName}: ${n} journal line${n === 1 ? '' : 's'}, books balance, `
            + `nothing unplaced. Net ${money(r.headline.netIncome)}.`;
    }
    const worst = r.findings[0];
    const rest = r.findings.length - 1;
    return `${r.entityName}: ${worst.what}.`
        + (worst.money > 0 ? ` ${money(worst.money)}.` : '')
        + (rest > 0 ? ` And ${rest} other thing${rest === 1 ? '' : 's'}.` : '')
        + (r.trustworthy ? '' : ' Do not use these figures for anything yet.');
}

module.exports = { review, summary, interCompany, SEVERITIES, DUE_FROM, DUE_TO };
