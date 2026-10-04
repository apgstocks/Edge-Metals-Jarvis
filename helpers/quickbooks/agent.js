// ── helpers/quickbooks/agent.js — QB Agent ─────────────────────────────────
// Apsara, 2026-10-02: "an agent which handles qb completely … it is called
// agent qb … auto resolves discrepancy … whose only job is to make qb
// perfect."
//
// ── WHAT "PERFECT" MEANS, SO IT CAN BE MEASURED ───────────────────────────
// Not "nothing open" — some bills are genuinely unpaid and that is correct
// bookkeeping. Perfect is: every figure in QuickBooks is explainable and
// agrees with something outside QuickBooks. That is a list of invariants,
// each with a number that should be zero. The agent's whole job is driving
// those numbers down and saying out loud which ones it may not touch.
//
// ── WHAT IT MAY DO ALONE ──────────────────────────────────────────────────
// Only what is reversible AND certain: allocate a payment whose match is
// unambiguous, enter a document it can PROVE is not already there, confirm a
// name that is character-identical. Everything else is a question or a
// proposal. It never voids, never deletes, never merges, never invents a
// party, and never touches a document dated before 2026.
//
// ── THE EVIDENCE BOUNDARY (2026-10-02) ────────────────────────────────────
// She asked for all of 2026, not just after the cutover. Taken literally that
// means re-entering everything her accountant keyed by hand. So the date
// boundary is replaced by an evidence one: the window is the whole year, and
// nothing is entered until its absence is PROVED — by container within one
// shipment cycle, by document number, by party+amount+date. And one case the
// ordinary duplicate check cannot see: a container whose cost already went
// straight to Cost of Goods Sold on a cheque has NO bill in QuickBooks, so
// nothing is found and a new bill would double the cost. Those cheques are
// read too.
const books = require('./books');
const applyPayments = require('./applyPayments');
const journal = require('./journal');
const push = require('./push');
const auth = require('./auth');
const client = require('./client');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── THE INVARIANTS ────────────────────────────────────────────────────────
// Kept as data, in one place, so what the agent believes "correct" means can
// be read in one sitting — and so a new one is a line here, not a change to
// the loop. `who` is the honest part: most of these it cannot close alone.
const INVARIANTS = [
    { id: 'unallocated', title: 'Every payment sits on a document', unit: 'money',
        who: 'agent', why: 'The money left the bank and QuickBooks knows it, but nothing says which bill it paid — so every bill reads open.' },
    { id: 'duplicates', title: 'Every container bought once, sold once', unit: 'money',
        who: 'her', why: 'Voiding cannot be undone, so the agent names them and she clears them.' },
    { id: 'miscoded', title: 'Supplier money hits payables, not cost of goods', unit: 'money',
        who: 'proposal', why: 'Re-coding moves money out of cost of goods sold, which changes reported profit for a period that may be filed.' },
    { id: 'payableAccounts', title: 'One payables account, not two', unit: 'count',
        who: 'proposal', why: 'QuickBooks refuses an account merge over the API, so the documents move instead and she retires the empty account.' },
    { id: 'receiptsUnapplied', title: 'Every receipt sits on an invoice', unit: 'money',
        who: 'agent', why: 'Money already in the bank against no invoice — chase a customer for it and she is apologising by return of post.' },
    { id: 'unmatched', title: 'Every name maps to exactly one record', unit: 'count',
        who: 'agent', why: 'An exact name is matched automatically; a new one is always a question.' },
    { id: 'bankGap', title: 'Bank balance equals books balance', unit: 'money',
        who: 'blocked', why: 'Intuit exposes the For Review queue to no app. It needs her CSV export.' },
];

// ── SURVEY ────────────────────────────────────────────────────────────────
async function survey({ year = new Date().getFullYear(), env = auth.qbEnv() } = {}) {
    const out = { year, env, at: new Date().toISOString(), invariants: {}, errors: {} };
    const safe = async (id, fn) => { try { return await fn(); } catch (e) { out.errors[id] = e.message; return null; } };

    const [overview, dupes, miscoded, ar] = await Promise.all([
        safe('books', () => books.overview(env, { year })),
        safe('duplicates', () => books.duplicates(env, { year })),
        safe('miscoded', () => miscodedCheques(year, env)),
        safe('receivables', () => require('./receivables').survey({ env })),
    ]);

    const la = (overview && overview.owe) || null;
    out.invariants.unallocated = {
        number: dupes ? dupes.unapplied.total : null,
        count: dupes ? dupes.unapplied.payments : null,
        worst: dupes ? dupes.unapplied.byParty.slice(0, 5) : [],
    };
    const side = (s) => (s ? r2(s.duplicate.cost + s.doubledLine.cost + s.sameContainer.cost) : 0);
    out.invariants.duplicates = {
        number: dupes ? r2(side(dupes.suppliers) + side(dupes.customers)) : null,
        count: dupes ? (dupes.suppliers.duplicate.groups.length + dupes.suppliers.doubledLine.groups.length
            + dupes.suppliers.sameContainer.groups.length + dupes.customers.duplicate.groups.length
            + dupes.customers.doubledLine.groups.length + dupes.customers.sameContainer.groups.length) : null,
        suppliers: dupes ? dupes.suppliers : null, customers: dupes ? dupes.customers : null,
    };
    out.invariants.miscoded = miscoded || { number: null };
    out.invariants.payableAccounts = {
        number: overview ? (overview.payable || []).length : null,
        accounts: overview ? overview.payable : [],
    };
    out.invariants.receiptsUnapplied = {
        number: ar ? ar.totals.received : null,
        count: ar ? ar.customers.filter((c) => c.received > 0).length : null,
        // the ones where writing to them would be a mistake
        doNotChase: ar ? ar.customers.filter((c) => c.verdict === 'do-not-chase' || c.verdict === 'apply-first')
            .map((c) => ({ customer: c.customer, open: c.open, received: c.received, why: c.why })) : [],
        chase: ar ? ar.customers.filter((c) => c.verdict === 'chase')
            .slice(0, 10).map((c) => ({ customer: c.customer, open: c.open, over60: r2(c.aging.d60 + c.aging.d90), pays: c.typicalDaysToPay })) : [],
    };
    out.invariants.bankGap = {
        number: null,
        banks: overview ? overview.banks : [],
        note: 'needs the Banking export — Intuit exposes no API for the For Review queue',
    };
    out.owe = la;
    out.owedToYou = overview ? overview.owedToYou : null;
    return out;
}

// ── THE CHEQUES THAT BYPASSED PAYABLES ────────────────────────────────────
// Supplier money paid straight to Cost of Goods Sold with no bill behind it.
// Two reasons it matters: the supplier's balance never moves, and if a bill
// is ever entered for the same container the cost lands twice.
async function miscodedCheques(year, env) {
    const since = `${year}-01-01`;
    const rows = [];
    let start = 1;
    for (;;) {
        const r = await client.query(`select * from Purchase where TxnDate >= '${since}' startposition ${start} maxresults 1000`, { env });
        const got = r.Purchase || [];
        rows.push(...got);
        if (got.length < 1000) break;
        start += 1000;
    }
    const hits = [];
    for (const p of rows) {
        const lines = (p.Line || []).filter((l) => /cost of goods/i.test((((l.AccountBasedExpenseLineDetail || {}).AccountRef) || {}).name || ''));
        if (!lines.length) continue;
        const text = (p.Line || []).map((l) => l.Description || '').join(' ') + ' ' + (p.PrivateNote || '');
        hits.push({ id: String(p.Id), date: p.TxnDate, total: r2(p.TotalAmt),
            payee: (p.EntityRef || {}).name || null, payeeId: String((p.EntityRef || {}).value || ''),
            amount: r2(lines.reduce((s, l) => s + Number(l.Amount || 0), 0)),
            containers: [...new Set(text.match(/[A-Z]{4}\d{7}/g) || [])] });
    }
    const named = hits.filter((h) => h.payee);
    const anonymous = hits.filter((h) => !h.payee);
    return {
        number: r2(hits.reduce((s, h) => s + h.amount, 0)),
        count: hits.length,
        // the agent can place these; the nameless ones it cannot, and they are
        // usually the bigger half
        fixable: { count: named.length, money: r2(named.reduce((s, h) => s + h.amount, 0)), rows: named },
        noPayee: { count: anonymous.length, money: r2(anonymous.reduce((s, h) => s + h.amount, 0)), rows: anonymous },
        span: hits.length ? [hits.map((h) => h.date).sort()[0], hits.map((h) => h.date).sort().slice(-1)[0]] : null,
    };
}

// Does a container already carry cost in QuickBooks WITHOUT a bill? If it
// does, entering a bill for it doubles the cost — and no duplicate check sees
// it, because there is no document to find.
function costAlreadyBooked(containerNo, miscoded) {
    if (!containerNo || !miscoded || !miscoded.fixable) return null;
    const k = KEY(containerNo);
    const all = [...(miscoded.fixable.rows || []), ...(miscoded.noPayee.rows || [])];
    const hit = all.find((h) => h.containers.some((c) => KEY(c) === k));
    return hit ? { cheque: hit.id, date: hit.date, amount: hit.amount,
        why: `${containerNo} already has ${hit.amount} of cost on cheque #${hit.id} (${hit.date}) with no bill behind it — a bill here would count it twice` } : null;
}

// ── THE QUEUE ─────────────────────────────────────────────────────────────
// Every invariant becomes items, each with a verdict. `do` is reversible AND
// certain. Nothing else is ever done without her.
function queue(surveyed) {
    const items = [];
    const inv = surveyed.invariants;

    if (inv.unallocated && inv.unallocated.number > 0) {
        items.push({ id: 'allocate', verdict: 'do', money: inv.unallocated.number,
            title: `Place ${inv.unallocated.count} payments that sit on no bill`,
            detail: `${inv.unallocated.worst.map((w) => `${w.party} ${w.amount}`).join(', ')}`,
            note: 'No money moves: no bank entry, no profit and loss, no change to the payable total.' });
    }
    if (inv.receiptsUnapplied && inv.receiptsUnapplied.number > 0) {
        items.push({ id: 'receiptsUnapplied', verdict: 'do', money: inv.receiptsUnapplied.number,
            title: `${inv.receiptsUnapplied.count} customers have paid money that sits on no invoice`,
            detail: (inv.receiptsUnapplied.doNotChase || []).map((c) => `${c.customer} ${c.received}`).join(', '),
            note: 'Apply these BEFORE any reminder goes out — chasing someone for money already in the bank is the one mistake a customer remembers.' });
    }
    if (inv.duplicates && inv.duplicates.number > 0) {
        items.push({ id: 'duplicates', verdict: 'ask', money: inv.duplicates.number,
            title: `${inv.duplicates.count} documents look doubled`,
            note: 'Voiding cannot be undone, so the agent will not. Each one opens with its impact on the page.' });
    }
    if (inv.miscoded && inv.miscoded.number > 0) {
        items.push({ id: 'miscoded', verdict: 'propose', money: inv.miscoded.number,
            title: `${inv.miscoded.count} cheques went straight to cost of goods sold`,
            detail: `${inv.miscoded.fixable.count} have a payee (${inv.miscoded.fixable.money}); ${inv.miscoded.noPayee.count} have none (${inv.miscoded.noPayee.money})`,
            note: 'Re-coding moves money out of cost of goods sold and changes reported profit. One approval, never silent. The nameless ones are never guessed.' });
    }
    if (inv.payableAccounts && inv.payableAccounts.number > 1) {
        items.push({ id: 'payableAccounts', verdict: 'propose', money: null,
            title: `${inv.payableAccounts.number} payable accounts are in use`,
            detail: inv.payableAccounts.accounts.map((a) => `${a.name} ${a.balance}`).join(' · '),
            note: 'QuickBooks refuses an account merge over the API. The documents can be moved onto one account; retiring the empty one is yours.' });
    }
    items.push({ id: 'bankGap', verdict: 'blocked', money: null,
        title: 'The bank "For Review" queue cannot be read by any app',
        note: 'Export it from the Banking screen and drop it on the bank lines screen.' });

    return items.sort((a, b) => (b.money || 0) - (a.money || 0));
}

// ── THE RUN ───────────────────────────────────────────────────────────────
// Dry by default. Only `do` items are ever executed, and today that is one
// thing: placing payments whose match is unambiguous.
async function run({ year = new Date().getFullYear(), env = auth.qbEnv(), really = false, reason } = {}) {
    const surveyed = await survey({ year, env });
    const items = queue(surveyed);
    const out = { at: new Date().toISOString(), year, env, dryRun: !really, survey: surveyed, queue: items, did: [], asked: [] };

    for (const item of items) {
        if (item.verdict !== 'do') { out.asked.push(item); continue; }
        if (item.id === 'allocate') {
            const planned = await applyPayments.plan({ since: `${year}-01-01`, env });
            const done = await applyPayments.apply(planned, {
                reason: reason || 'QB Agent: payments recorded without being matched to their bills', env, really });
            out.did.push({ id: item.id, placed: done.totals.placed, payments: done.totals.payments, skipped: done.skipped.length });
        }
    }
    try {
        journal.record({ env, kind: 'billpayment', action: 'allocated',
            qb: {}, jarvis: { agent: 'qb' }, by: 'qb-agent',
            reason: `QB Agent ${out.dryRun ? 'dry run' : 'run'}: ${out.did.map((d) => `${d.id} ${d.placed || ''}`).join('; ') || 'nothing to do'}` });
    } catch { /* the raw write log already holds whatever reached her books */ }
    return out;
}

// ── THE VOICE ─────────────────────────────────────────────────────────────
// One email a morning, written the way a person would write it: what it did,
// what it is waiting on, what it is not allowed to touch, and the one number
// that says whether this is getting better.
const money = (n) => (n === null || n === undefined) ? '—'
    : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function reportText(out) {
    const s = out.survey || {};
    const inv = s.invariants || {};
    const L = [];

    if (out.dryRun) L.push('DRY RUN — nothing was written. The agent writes when it is told to.', '');
    const did = (out.did || []).find((d) => d.id === 'allocate');
    L.push(did
        ? `Placed ${money(did.placed)} across ${did.payments} payments${did.skipped ? `, ${did.skipped} skipped because they changed in QuickBooks` : ''}.`
        : 'Nothing to place today.');
    L.push('');
    L.push(`You owe ${money(s.owe && s.owe.total)} · owed to you ${money(s.owedToYou && s.owedToYou.total)}`);
    L.push('');

    L.push('WHERE THE BOOKS ARE NOT YET RIGHT');
    const line = (label, n, extra) => L.push(`  ${label}: ${money(n)}${extra ? ` — ${extra}` : ''}`);
    // ── WHAT IS LEFT, NOT WHAT WAS THERE BEFORE THIS RUN (2026-10-04) ────
    // survey() is called ONCE, above the action loop, and this section read
    // it straight. So on 4 October the email said
    //
    //    Placed $312,640.87 across 10 payments.
    //    ...
    //    Payments sitting on no bill: $312,640.87 — 10 payments
    //
    // the same money, to the cent, reported as done and as outstanding in
    // one email. Nothing was wrong in QuickBooks: the agent had placed them
    // and this line was quoting the state from before it did.
    //
    // Re-surveying would cost another sweep of her books for a figure that
    // is already known — `did` says exactly what was placed — so it is
    // subtracted instead, and the pre-run figure is kept visible so the run
    // can be seen to have done something.
    if (inv.unallocated) {
        const placed = (did && did.placed) || 0;
        const placedCount = (did && did.payments) || 0;
        const leftMoney = Math.round((inv.unallocated.number - placed) * 100) / 100;
        const leftCount = Math.max(0, inv.unallocated.count - placedCount);
        if (leftMoney > 0.005) {
            line('Payments sitting on no bill', leftMoney,
                `${leftCount} payments${placed ? `, after the ${money(placed)} this run placed` : ''}`
                + `; worst ${(inv.unallocated.worst || []).slice(0, 3).map((w) => `${w.party} ${money(w.amount)}`).join(', ')}`);
        } else if (placed) {
            L.push(`  Payments sitting on no bill: none left — this run placed all ${money(placed)} of it.`);
        }
    }
    if (inv.duplicates) line('Documents doubled', inv.duplicates.number, `${inv.duplicates.count} to look at — a void cannot be undone, so they wait for you`);
    if (inv.miscoded) line('Supplier money in cost of goods', inv.miscoded.number,
        `${inv.miscoded.count} cheques; ${inv.miscoded.noPayee.count} of them (${money(inv.miscoded.noPayee.money)}) have no payee and will never be guessed`);
    if (inv.payableAccounts && inv.payableAccounts.number > 1) {
        L.push(`  Payable accounts in use: ${inv.payableAccounts.number} — ${(inv.payableAccounts.accounts || []).map((a) => `${a.name} ${money(a.balance)}`).join(' · ')}`);
    }
    L.push('  The bank For Review queue: no app can read it. Export it from the Banking screen.');

    const asks = (out.asked || []).filter((i) => i.verdict === 'ask' || i.verdict === 'propose');
    if (asks.length) {
        L.push('', 'WAITING ON YOU');
        for (const a of asks) L.push(`  ${a.title}${a.detail ? ` — ${a.detail}` : ''}`, `      ${a.note || ''}`);
    }
    if (Object.keys(s.errors || {}).length) {
        L.push('', 'COULD NOT BE READ');
        for (const [k, v] of Object.entries(s.errors)) L.push(`  ${k}: ${v}`);
    }
    L.push('', 'Open the QuickBooks page in Jarvis to act on any of this.');
    return L.join('\n');
}

async function emailReport(out, opts = {}) {
    const to = opts.to || process.env.QB_REPORT_TO || process.env.SHEET_SYNC_TO || 'apg0596@gmail.com';
    const when = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
    const did = (out.did || []).find((d) => d.id === 'allocate');
    // Same correction as reportText's: `left` is the PRE-RUN survey, so the
    // subject said "$312,640.87 placed, $312,640.87 still loose" about one
    // pile of money. The subject is the part she reads in a list of unread
    // mail, so it is the worst place to be wrong by a whole run's work.
    const surveyed = ((out.survey || {}).invariants || {}).unallocated;
    const stillLoose = surveyed
        ? Math.round((surveyed.number - ((did && did.placed) || 0)) * 100) / 100
        : 0;
    const subject = `QB Agent — ${did && did.placed ? `${money(did.placed)} placed` : 'nothing placed'}`
        + `${stillLoose > 0.005 ? `, ${money(stillLoose)} still loose` : ''}${out.dryRun ? ' (dry run)' : ''} — ${when}`;
    return require('../gmail').sendEmail({ to, subject, body: reportText(out) });
}

module.exports = { INVARIANTS, survey, queue, run, reportText, emailReport, miscodedCheques, costAlreadyBooked };
