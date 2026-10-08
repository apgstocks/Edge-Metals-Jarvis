// ── helpers/bankReconcile.js — does the bank agree with the books? ────────
//
// Apsara, 2026-10-08: "Build that plaid bank thing completely so that i dont
// need to look out for statements whether payment received or sent ever
// again."
//
// ── WHY THIS FILE EXISTS BEFORE THE OUT-MATCHER ──────────────────────────
// The obvious next build was matching withdrawals, because bankMatch.js only
// has bankInflows() and her sentence names both directions. I put this first
// on purpose, and the reason is the whole design:
//
//   Matching rows tells her what Jarvis COULD explain.
//   Only a reconciliation tells her whether anything is MISSING.
//
// A matcher can tick off every row it is shown and still be looking at a
// feed that is short three transactions, or a ledger that double-counted a
// payment. "I never need to look at a statement again" is a claim about
// completeness, and completeness is a sum, not a list. So: the sum first,
// then the list of what breaks it. Building the fixer first would have meant
// no way to tell whether the fixer worked.
//
// ── IT COMPARES MOVEMENT, NOT AN ABSOLUTE BALANCE, AND THAT IS HONEST ────
// The tempting version prints "bank says $84,210.17, books say $84,210.17,
// all clear". It cannot be computed, and printing it anyway would be the
// most dangerous thing in this repo:
//
//   · her ledger starts whenever her data starts, not when the account was
//     opened, so Jarvis's 1010 is a partial history;
//   · Plaid returns up to 24 months and only from the day she linked, so the
//     feed is a different partial history;
//   · the two partial histories do not share a starting point.
//
// Comparing those two running totals produces a difference equal to the
// opening balance, every single day, for ever. A screen that always shows a
// large unexplained difference teaches her to ignore it, which is worse than
// having no screen.
//
// So this compares MOVEMENT inside a window — what the bank says moved
// between two dates versus what the books say moved — which is a figure both
// sides can honestly produce. If she wants an absolute balance checked, an
// anchor (a real statement balance on one date, typed once) is the missing
// ingredient, and `anchorNeeded` says so rather than this file inventing it.
//
// ── ONE REAL ACCOUNT, SEVERAL SETS OF BOOKS ──────────────────────────────
// 1010 is Bank of America. chartOfAccounts.js says it is "Edge Metals INC's
// account, and the one AAA Investment also draws on", and postings.js posts
// a bank line under whichever company the transaction belongs to. So the
// ledger's view of ONE bank account is spread across several entities.
//
// statements.js::linesFor THROWS without an entity — "statements need a
// company — there is no combined taxpayer" — which is correct for a tax
// return and wrong for this. A bank does not know about her companies. So
// the bank-side total here is summed ACROSS entities and the per-company
// split is shown underneath as information, never as the total. Using one
// company's 1010 would understate the books by whatever the other companies
// moved, and it would look like a feed problem.
//
// Nothing here writes. No store, no Plaid call, no email.

const C = require('./chartOfAccounts');

const CENT = 0.005;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const day = (d) => String(d || '').slice(0, 10);

// ── which chart account is which bank ────────────────────────────────────
// Read off the chart, where 1010 already carries `bank: 'BofA'` and 1020
// `bank: 'Chase Bank'`. Not duplicated here: a hardcoded second copy is how
// a rename in one file silently stops matching the other, and bankLedger.js
// already learned that lesson with SWIFT_TO_BANK.
function bankAccounts() {
    return C.ACCOUNTS
        .filter((a) => a && a.bank && a.type === 'asset')
        .map((a) => ({ code: a.code, name: a.name, bank: a.bank }));
}
function codeForBank(bank) {
    const want = String(bank || '').trim().toLowerCase();
    const hit = bankAccounts().find((a) => a.bank.toLowerCase() === want);
    return hit ? hit.code : null;
}

const inWindow = (d, from, to) => {
    const x = day(d);
    if (!x) return false;
    if (from && x < day(from)) return false;
    if (to && x > day(to)) return false;
    return true;
};

// ── THE BOOKS' SIDE ──────────────────────────────────────────────────────
// Every journal line against this bank account, from every company. A DEBIT
// to a bank asset is money arriving; a CREDIT is money leaving. That is the
// opposite sign convention to Plaid's (where a positive amount is money
// leaving), and the flip happens in the two functions below and nowhere
// else — bankMatch.js's comment on the same trap is worth repeating: get it
// backwards and every deposit looks like a withdrawal, which reads as "the
// matcher is broken" rather than as a sign error.
function ledgerSide(lines, { code, from, to } = {}) {
    const mine = (Array.isArray(lines) ? lines : [])
        .filter((l) => l && l.account === code && inWindow(l.date, from, to));

    const inRows = mine.filter((l) => num(l.debit) > CENT);
    const outRows = mine.filter((l) => num(l.credit) > CENT);

    const byEntity = new Map();
    for (const l of mine) {
        const cur = byEntity.get(l.entity) || { in: 0, out: 0, lines: 0 };
        cur.in += num(l.debit); cur.out += num(l.credit); cur.lines += 1;
        byEntity.set(l.entity, cur);
    }

    return {
        code,
        lines: mine,
        in: r2(inRows.reduce((t, l) => t + num(l.debit), 0)),
        out: r2(outRows.reduce((t, l) => t + num(l.credit), 0)),
        get net() { return r2(this.in - this.out); },
        inRows, outRows,
        // Information, not a total. See the header.
        byEntity: [...byEntity.entries()]
            .map(([entity, v]) => ({ entity, in: r2(v.in), out: r2(v.out), net: r2(v.in - v.out), lines: v.lines }))
            .sort((a, b) => String(a.entity).localeCompare(String(b.entity))),
    };
}

// ── THE BANK'S SIDE ──────────────────────────────────────────────────────
// bankLedger rows, which already carry `direction`, `spent`, `received` and
// `bank` — QuickBooks' own column names, deliberately, so the Plaid feed and
// her QuickBooks CSV export are the same record type.
//
// PENDING ROWS ARE EXCLUDED, and that is not tidiness. A pending amount
// still changes and the row can disappear entirely, so counting one here
// would produce a difference that resolves itself overnight and sends her
// looking for a problem that was never there. bankLedger::worklist already
// draws that line; this uses the same one.
//
// EXCLUDED ROWS ARE *INCLUDED* IN THE BANK TOTAL, which is the opposite of
// what QuickBooks does. An excluded row is one she has said is not a
// business transaction — but the money still left the bank, so the bank's
// movement figure must contain it or the two sides can never agree. It is
// reported separately so the difference it causes is named rather than
// mysterious.
function bankSide(rows, { bank, code, from, to } = {}) {
    const want = bank || (bankAccounts().find((a) => a.code === code) || {}).bank || null;
    const mine = (Array.isArray(rows) ? rows : []).filter((r) => r
        && !r.pending
        && inWindow(r.date, from, to)
        && (!want || String(r.bank || '').toLowerCase() === String(want).toLowerCase()));

    const live = mine.filter((r) => !r.excluded);
    const excluded = mine.filter((r) => r.excluded);
    const sum = (list, k) => r2(list.reduce((t, r) => t + num(r[k]), 0));

    return {
        bank: want, code: code || codeForBank(want),
        rows: mine,
        in: sum(mine, 'received'),
        out: sum(mine, 'spent'),
        net: r2(sum(mine, 'received') - sum(mine, 'spent')),
        // Named, because they are the usual reason the two sides differ by a
        // round number and she should not have to guess.
        excluded: { count: excluded.length, in: sum(excluded, 'received'), out: sum(excluded, 'spent') },
        counted: live.length,
        // Pending is reported so "the bank moved more than this" is visible
        // rather than being a silent omission.
        pendingHeldBack: (Array.isArray(rows) ? rows : [])
            .filter((r) => r && r.pending && inWindow(r.date, from, to)
                && (!want || String(r.bank || '').toLowerCase() === String(want).toLowerCase()))
            .length,
    };
}

// ── THE ANSWER ───────────────────────────────────────────────────────────
// Three differences, separately, because they have different causes and
// different fixes:
//
//   inGap    the bank received money the books do not show arriving
//            → a customer paid and nobody recorded it
//   outGap   the bank paid money the books do not show leaving
//            → a supplier, carrier or fee paid outside Jarvis
//   netGap   the two together
//
// A single net figure would let a missing $5,000 receipt and a missing
// $5,000 payment cancel out to "all clear", which is the one output this
// file must never produce.
function reconcile({ lines = [], rows = [], bank = null, code = null, from = null, to = null } = {}) {
    const acct = code || codeForBank(bank);
    if (!acct) {
        return { ok: false, problem: `no chart account for bank "${bank}" — `
            + 'chartOfAccounts.js is where a bank account gets its code' };
    }
    const books = ledgerSide(lines, { code: acct, from, to });
    const feed = bankSide(rows, { bank, code: acct, from, to });

    const inGap = r2(feed.in - books.in);
    const outGap = r2(feed.out - books.out);
    const agrees = Math.abs(inGap) < CENT && Math.abs(outGap) < CENT;

    return {
        ok: true,
        bank: feed.bank, code: acct,
        name: (bankAccounts().find((a) => a.code === acct) || {}).name || acct,
        from: from || null, to: to || null,
        books: { in: books.in, out: books.out, net: books.net, byEntity: books.byEntity, lines: books.lines.length },
        feed: { in: feed.in, out: feed.out, net: feed.net, rows: feed.rows.length,
                excluded: feed.excluded, pendingHeldBack: feed.pendingHeldBack },
        inGap, outGap, netGap: r2(inGap - outGap),
        agrees,
        // ── WHAT THIS CANNOT TELL HER, SAID OUT LOUD ─────────────────────
        // See the header: an absolute balance check needs a starting point
        // neither side has. Rather than omit the limitation, it is returned,
        // so a screen can say "movement agrees" instead of "all clear" —
        // which are different claims and only one of them is true.
        compares: 'movement inside the window, not the account balance',
        anchorNeeded: 'a real statement balance on one date, typed once, is what '
            + 'would let Jarvis check the balance itself rather than only the movement',
    };
}

// ── WHAT ACTUALLY NEEDS HER ──────────────────────────────────────────────
// The reconciliation says whether something is wrong. This says what. Both
// directions, each row the other side cannot account for, so the morning
// answer is either "nothing needs you" or a list — never a number she has to
// interpret.
//
// It is deliberately NOT a matcher. It pairs nothing and decides nothing: it
// reports rows on one side whose amount and date have no counterpart on the
// other. Pairing is bankMatch.js's job for receipts, and the out-matcher's
// job once it exists. Doing a cheap version of it here would produce a
// second, worse opinion that disagrees with the real one.
function unexplained({ lines = [], rows = [], bank = null, code = null, from = null, to = null,
                       days = 4 } = {}) {
    const acct = code || codeForBank(bank);
    if (!acct) return { ok: false, problem: `no chart account for bank "${bank}"` };

    const books = ledgerSide(lines, { code: acct, from, to });
    const feed = bankSide(rows, { bank, code: acct, from, to });

    const near = (a, b) => {
        const ms = Math.abs(new Date(day(a) + 'T00:00:00Z') - new Date(day(b) + 'T00:00:00Z'));
        return isFinite(ms) && ms <= days * 86400000;
    };

    // A bank row is "accounted for" if the books hold a line on the same
    // side, for the same amount, within a few days. Several bank rows can
    // legitimately share one book line's amount, so claims are consumed:
    // without that, two identical $1,200 withdrawals both point at one
    // recorded payment and the second one looks explained when it is not.
    const unclaimed = (bookRows, amountOf) => bookRows.map((l) => ({ l, taken: false, amt: r2(amountOf(l)) }));

    const bookIn = unclaimed(books.inRows, (l) => l.debit);
    const bookOut = unclaimed(books.outRows, (l) => l.credit);

    const sweep = (bankRows, pool, amountKey) => {
        const orphans = [];
        for (const r of bankRows) {
            const amt = r2(num(r[amountKey]));
            const hit = pool.find((p) => !p.taken && Math.abs(p.amt - amt) < CENT && near(p.l.date, r.date));
            if (hit) { hit.taken = true; continue; }
            orphans.push({
                id: r.id, date: r.date, amount: amt,
                desc: r.desc || '', party: r.party || '',
                bank: r.bank || null, company: r.company || null,
                excluded: !!r.excluded,
            });
        }
        return orphans;
    };

    const liveFeed = feed.rows.filter((r) => !r.excluded);
    const bankInOrphans = sweep(liveFeed.filter((r) => r.direction === 'in'), bookIn, 'received');
    const bankOutOrphans = sweep(liveFeed.filter((r) => r.direction === 'out'), bookOut, 'spent');

    const ledgerOrphan = (p, side) => ({
        date: p.l.date, amount: p.amt, side,
        entity: p.l.entity, kind: p.l.kind, party: p.l.party || null,
        source: p.l.source || null, memo: p.l.memo || null,
    });

    return {
        ok: true,
        bank: feed.bank, code: acct, from: from || null, to: to || null, days,
        // The bank moved money Jarvis has no record of. This is the half that
        // costs her money, because an unrecorded receipt is an invoice still
        // chasing a customer who has paid.
        bankNotInBooks: { in: bankInOrphans, out: bankOutOrphans },
        // Jarvis recorded money moving that the bank never did. Usually a
        // payment entered twice, or entered before it was actually sent.
        booksNotInBank: {
            in: bookIn.filter((p) => !p.taken).map((p) => ledgerOrphan(p, 'in')),
            out: bookOut.filter((p) => !p.taken).map((p) => ledgerOrphan(p, 'out')),
        },
        get clean() {
            return !this.bankNotInBooks.in.length && !this.bankNotInBooks.out.length
                && !this.booksNotInBank.in.length && !this.booksNotInBank.out.length;
        },
    };
}

// ── IS THE FEED ALIVE? ───────────────────────────────────────────────────
// A reconciliation is only as true as the date of the data under it, and a
// Plaid Item dies quietly: ITEM_LOGIN_REQUIRED after she changes her bank
// password, or consent expiring. Nothing throws — the nightly sync just
// returns no rows. Two failure modes follow, and neither announces itself:
//
//   · on a quiet day both sides are unchanged, so everything agrees about a
//     feed that stopped a fortnight ago. "Nothing needs you", said falsely,
//     is the worst sentence this code can produce.
//   · on a busy day her payments have no bank rows to meet, so a gap grows
//     that reads as missing money when the answer is "nothing is connected".
//
// ── WHY IT LIVES HERE AND NOT IN THE ROUTE ─────────────────────────────
// It was inline in bankMatchRoutes.js first. The mutation "a stale feed is
// judged fresh" then SURVIVED, because Plaid is not configured in the test
// environment so the branch never ran — arithmetic that cannot be reached
// by a test is arithmetic nobody is checking. Out here it takes items and a
// clock as arguments and the staleness rule is pinned.
//
// Takes plaid.itemsPublic() shape — which never carries the access token.
const STALE_AFTER_DAYS = 2;   // the pull is 05:45 daily; a quiet weekend is normal

function feedHealth(items, { now = new Date(), configured = true } = {}) {
    if (!configured) {
        return { linked: 0, lastSyncAt: null, staleDays: null, ok: false,
            note: 'Plaid is not configured on this server' };
    }
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
        return { linked: 0, lastSyncAt: null, staleDays: null, ok: false,
            note: 'no bank is linked yet' };
    }
    // The NEWEST sync across items, because one healthy bank must not hide a
    // dead one — but the note names the count so two banks and one sync is
    // visible rather than averaged away.
    const syncs = list.map((i) => i && i.last_sync_at).filter(Boolean).sort();
    const newest = syncs.length ? syncs[syncs.length - 1] : null;
    if (!newest) {
        return { linked: list.length, lastSyncAt: null, staleDays: null, ok: false,
            note: 'linked, but it has never synced' };
    }
    const staleDays = Math.floor((now.getTime() - new Date(newest).getTime()) / 86400000);
    const everySynced = list.every((i) => i && i.last_sync_at);
    if (!everySynced) {
        return { linked: list.length, lastSyncAt: newest, staleDays, ok: false,
            note: `${list.length - syncs.length} of ${list.length} linked banks have never synced` };
    }
    return {
        linked: list.length, lastSyncAt: newest, staleDays,
        ok: staleDays <= STALE_AFTER_DAYS,
        note: staleDays > STALE_AFTER_DAYS
            ? `the last successful sync was ${staleDays} days ago — the connection may need `
              + 're-authenticating at the bank'
            : null,
    };
}

// ── THE SENTENCE SHE ACTS ON ─────────────────────────────────────────────
// "Nothing needs you" is the whole point of the screen and the one output
// that can do real harm, because she will stop looking on the strength of
// it. It was assembled inline in the route, and the mutation "nothing needs
// you ignores an incomplete journal" then SURVIVED: Plaid is unconfigured
// under test so `feed.ok` was already false, and a second broken guard
// changed nothing. Two guards in one expression, where either being false
// hides the other being broken.
//
// Out here each clause is checkable on its own, and the function returns
// WHY rather than only whether — so the screen can say which of the four
// things is untrue instead of a bare no.
//
// All four must hold. They are in this order deliberately: the first is
// about whether there IS data, the rest are about what the data says, and
// the first is the only one that can be false while the others are
// serenely true.
function nothingNeedsYou({ feed, journalComplete, banks } = {}) {
    const reasons = [];
    if (!feed || !feed.ok) reasons.push(feed && feed.note ? feed.note : 'the bank feed is not current');
    if (!journalComplete) reasons.push('the journal could not post everything, so every figure is a floor');
    for (const b of (Array.isArray(banks) ? banks : [])) {
        if (!b || !b.reconcile || !b.reconcile.ok) { reasons.push(`${(b && b.bank) || 'a bank'} could not be reconciled`); continue; }
        if (!b.reconcile.agrees) reasons.push(`${b.bank} does not agree with the books`);
        if (!b.unexplained || !b.unexplained.clean) reasons.push(`${b.bank} has rows nobody has explained`);
    }
    return { ok: reasons.length === 0, reasons };
}

module.exports = {
    bankAccounts, codeForBank, ledgerSide, bankSide, reconcile, unexplained,
    feedHealth, nothingNeedsYou, STALE_AFTER_DAYS, CENT,
};
