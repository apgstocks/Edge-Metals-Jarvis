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

    const [overview, dupes, miscoded, ar, payables, receipts] = await Promise.all([
        safe('books', () => books.overview(env, { year })),
        safe('duplicates', () => books.duplicates(env, { year })),
        safe('miscoded', () => miscodedCheques(year, env)),
        safe('receivables', () => require('./receivables').survey({ env })),
        safe('payables', () => require('./payables').survey({ env })),
        safe('receipts', () => require('./applyReceipts').plan({ env, since: `${year}-01-01`, limit: 200 })),
    ]);

    const la = (overview && overview.owe) || null;
    out.invariants.unallocated = {
        number: dupes ? dupes.unapplied.total : null,
        count: dupes ? dupes.unapplied.payments : null,
        worst: dupes ? dupes.unapplied.byParty.slice(0, 5) : [],
    };
    // ── WHAT SHE HAS ALREADY ANSWERED (2026-10-05) ───────────────────────
    // helpers/quickbooks/decisions.js opens by saying what it is for: "The
    // difference between an agent and a cron job that nags is that the agent
    // asks once." It was consulted in exactly one place — checks.js — and
    // never by this agent. So the morning mail re-reported the same ten
    // doubled documents and the same sixteen cheques every day, including
    // the ones she had opened, judged and dismissed. An agent that cannot be
    // told anything is one she stops reading, and then it is worse than
    // nothing because the day something NEW appears it is in a list she has
    // learned to skip.
    //
    // SILENCED IS NOT HIDDEN — checks.js's rule, copied deliberately: "a rule
    // quietly hiding a growing pile is its own problem, so they stay
    // counted". Every silenced finding is still counted and still reported
    // as a count, with her own reason attached. Money never leaves the page
    // because she pressed something once.
    let decided = null;
    try { decided = require('./decisions'); } catch { decided = null; }
    const silence = (rows, about, pattern) => {
        if (!decided || !Array.isArray(rows) || !rows.length) return { keep: rows || [], silenced: [] };
        const keep = []; const silenced = [];
        for (const f of rows) {
            let hit = null;
            try { hit = decided.answered(f, { about, pattern }); } catch (e) { hit = null; }
            if (hit) silenced.push({ ...f, answeredAt: hit.at, answeredWhy: hit.reason, decision: hit.id });
            else keep.push(f);
        }
        return { keep, silenced };
    };

    const side = (s) => (s ? r2(s.duplicate.cost + s.doubledLine.cost + s.sameContainer.cost) : 0);
    // Each of the six duplicate buckets is filtered, because a decision is
    // about a PAIR of documents and lives in whichever bucket found them.
    let dupSilenced = 0;
    if (dupes && decided) {
        for (const sideName of ['suppliers', 'customers']) {
            for (const bucket of ['duplicate', 'doubledLine', 'sameContainer']) {
                const b = dupes[sideName] && dupes[sideName][bucket];
                if (!b || !Array.isArray(b.groups)) continue;
                const r = silence(b.groups, 'duplicate', bucket);
                dupSilenced += r.silenced.length;
                b.groups = r.keep;
                b.silencedGroups = r.silenced;
                // The money figure must shrink with the list, or the total
                // and the rows it is made of stop agreeing.
                b.cost = r2(r.keep.reduce((t, g) => t + (Number(g.cost) || Number(g.amount) || 0), 0));
            }
        }
    }
    out.invariants.duplicates = {
        number: dupes ? r2(side(dupes.suppliers) + side(dupes.customers)) : null,
        count: dupes ? (dupes.suppliers.duplicate.groups.length + dupes.suppliers.doubledLine.groups.length
            + dupes.suppliers.sameContainer.groups.length + dupes.customers.duplicate.groups.length
            + dupes.customers.doubledLine.groups.length + dupes.customers.sameContainer.groups.length) : null,
        silenced: dupSilenced,
        suppliers: dupes ? dupes.suppliers : null, customers: dupes ? dupes.customers : null,
    };

    // A cheque she has looked at and accepted — "that one really is cost of
    // goods" — is an answer about a FINDING, not about a duplicate pair.
    if (miscoded && decided) {
        for (const pile of ['fixable', 'noPayee']) {
            const r = silence(miscoded[pile].rows, 'finding', null);
            miscoded[pile].rows = r.keep;
            miscoded[pile].count = r.keep.length;
            miscoded[pile].money = r2(r.keep.reduce((t, x) => t + (Number(x.amount) || 0), 0));
            miscoded[pile].silenced = r.silenced;
        }
        miscoded.silenced = miscoded.fixable.silenced.length + miscoded.noPayee.silenced.length;
        miscoded.count = miscoded.fixable.count + miscoded.noPayee.count;
        miscoded.number = r2(miscoded.fixable.money + miscoded.noPayee.money);
    }
    out.invariants.miscoded = miscoded || { number: null };
    // Not "there are three" but how much of the extra ones can actually be
    // emptied. A bill with a payment against it can never move (sandbox,
    // 2026-10-05) and another company's payable is never touched, so the only
    // honest figure is the movable part — the difference between a proposal
    // she can act on and a complaint she cannot.
    const extra = payables ? payables.accounts.filter((a) => !a.company && a.id !== payables.keep) : [];
    out.invariants.payableAccounts = {
        number: overview ? (overview.payable || []).length : (payables ? payables.accounts.length : null),
        accounts: overview ? overview.payable : (payables ? payables.accounts : []),
        keep: payables ? payables.keep : null,
        separate: payables ? payables.separate : [],
        movable: payables ? extra.reduce((t, a) => t + a.movable, 0) : null,
        movableMoney: payables ? r2(extra.reduce((t, a) => t + a.movableMoney, 0)) : null,
        held: payables ? extra.reduce((t, a) => t + a.held, 0) : null,
        heldMoney: payables ? r2(extra.reduce((t, a) => t + a.heldMoney, 0)) : null,
    };
    out.invariants.receiptsUnapplied = {
        number: ar ? ar.totals.received : null,
        count: ar ? ar.customers.filter((c) => c.received > 0).length : null,
        // What can actually be placed, and how much of that to the cent. The
        // queue said verdict 'do' against this from the day it was written
        // while run() had no path for it at all — so these numbers exist to
        // keep the claim and the code honest about each other.
        placeable: receipts ? receipts.totals.placed : null,
        certain: receipts ? receipts.totals.certain : null,
        certainMoney: receipts ? r2((receipts.receipts || []).filter((x) => x.certain).reduce((t, x) => t + r2(x.loose - (x.leftOver || 0)), 0)) : null,
        stuck: receipts ? (receipts.unplaceable || []).map((u) => ({ customer: u.customer, loose: u.loose, why: u.why, twin: u.twin || null })) : [],
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
        const ru = inv.receiptsUnapplied;
        // 'do' only where there is something it is actually allowed to do. A
        // verdict of 'do' on work the agent cannot do is the worst line in
        // this file: it reads as handled and nothing happens.
        const canDo = (ru.certain || 0) > 0;
        items.push({ id: 'receiptsUnapplied', verdict: canDo ? 'do' : 'ask', money: ru.number,
            title: `${ru.count} customers have paid money that sits on no invoice`,
            detail: (ru.certain !== null && ru.certain !== undefined
                ? `${ru.certain} match an invoice to the cent (${ru.certainMoney}) and the agent places those; ${(ru.stuck || []).length} cannot be placed at all`
                : (ru.doNotChase || []).map((c) => `${c.customer} ${c.received}`).join(', ')),
            note: 'Apply these BEFORE any reminder goes out — chasing someone for money already in the bank is the one mistake a customer remembers.'
                + ' Placing a receipt moves no money: it only says which invoice it was for.'
                + ((ru.stuck || []).some((x) => x.twin) ? ' Some of it is on the wrong customer record, and QuickBooks refuses to link a receipt to another customer\'s invoice — those need the receipt moved, which is yours.' : '') });
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
        const pa = inv.payableAccounts;
        const sep = (pa.separate || []).length ? ` ${(pa.separate || []).map((x) => x.name).join(', ')} belong to another company and are left alone.` : '';
        items.push({ id: 'payableAccounts', verdict: 'propose', money: pa.movableMoney,
            title: `${pa.number} payable accounts are in use`,
            detail: (pa.accounts || []).map((a) => `${a.name} ${a.balance}`).join(' · ')
                + (pa.movable !== null && pa.movable !== undefined ? ` — ${pa.movable} bill(s) can move onto #${pa.keep}, ${pa.held} cannot` : ''),
            note: 'QuickBooks refuses an account merge over the API, so the documents move instead.'
                + ' A bill that has already been paid is never moved: QuickBooks accepts the write and silently unapplies the payment'
                + ' (sandbox, 2026-10-05), which would turn settled bills back into debts and add to the unallocated pile.'
                + ' Those stay put until they are settled and age out.' + sep });
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
        if (item.id === 'receiptsUnapplied') {
            const applyReceipts = require('./applyReceipts');
            const planned = await applyReceipts.plan({ since: `${year}-01-01`, env, limit: 200 });
            const done = await applyReceipts.apply(planned, { certainOnly: true, really, env, by: 'qb-agent',
                reason: reason || 'QB Agent: customer money in the bank with no invoice against it' });
            out.did.push({ id: item.id, placed: done.totals.placed, receipts: done.totals.receipts,
                leftForYou: done.skipped.length, unplaceable: (planned.unplaceable || []).length });
            continue;
        }
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
    if (inv.duplicates) line('Documents doubled', inv.duplicates.number,
        `${inv.duplicates.count} to look at — a void cannot be undone, so they wait for you`
        + (inv.duplicates.silenced ? `; ${inv.duplicates.silenced} not shown, you have already answered those` : ''));
    if (inv.miscoded && inv.miscoded.number != null) line('Supplier money in cost of goods', inv.miscoded.number,
        `${inv.miscoded.count} cheques; ${((inv.miscoded.noPayee || {}).count) || 0} of them (${money((inv.miscoded.noPayee || {}).money || 0)}) have no payee and will never be guessed`
        + (inv.miscoded.silenced ? `; ${inv.miscoded.silenced} not shown, you have already answered those` : ''));

    // ── SILENCED IS NOT HIDDEN ───────────────────────────────────────────
    // Said once, plainly, with the way back. The risk of an agent that can be
    // told to stop asking is that it stops asking about something that later
    // matters — so the count is always on the page, and so is the fact that
    // it is reversible. Without this line, "silenced" becomes "disappeared"
    // within a week.
    {
        const quiet = ((inv.duplicates && inv.duplicates.silenced) || 0)
            + ((inv.miscoded && inv.miscoded.silenced) || 0);
        if (quiet) {
            L.push(`  ${quiet} finding${quiet === 1 ? '' : 's'} above are not listed because you answered them `
                + 'already. They are still counted, never deleted — the QuickBooks page lists them under '
                + 'what you have decided, and any one of them can be un-answered.');
        }
    }
    // ── A PAYABLE BALANCE THAT EXPLAINS ITSELF (2026-10-05) ──────────────
    // This printed QuickBooks' raw signed balances:
    //
    //   Payable accounts in use: 3 — Accounts Payable $-57,224.15 ·
    //   Accounts Payable - Zimex $0.00 · Vendor Payable $-5,113,259.13
    //
    // A reader sees minus five million against a payable and reasonably
    // concludes something is badly wrong. It is not: those are credit
    // balances, they are what she OWES, and 57,224.15 + 0 + 5,113,259.13 is
    // 5,170,483.28 — the "You owe" figure at the top of this same email, to
    // the cent. The line held the answer to the alarm it was causing.
    //
    // I spent a morning on that alarm, so the line now shows each balance as
    // what it means and says whether the parts add up to the total.
    //
    // THE SIGN CONVENTION IS CHECKED, NOT ASSUMED. Rather than hard-coding
    // "negative means owed", it compares the absolute sum against the figure
    // QuickBooks itself reports for what is owed. When they agree it says so;
    // when they do not it says THAT, which is a real finding and the whole
    // reason to print the line at all.
    if (inv.payableAccounts && inv.payableAccounts.number > 1) {
        const accs = inv.payableAccounts.accounts || [];
        const owe = (s.owe && typeof s.owe.total === 'number') ? s.owe.total : null;
        const sum = Math.round(accs.reduce((t, a) => t + Math.abs(Number(a.balance) || 0), 0) * 100) / 100;
        const reconciles = owe !== null && Math.abs(sum - owe) <= 0.02;
        L.push(`  Payable accounts in use: ${inv.payableAccounts.number} — `
            + accs.map((a) => {
                const n = Number(a.balance) || 0;
                if (!n) return `${a.name} nothing owed`;
                return `${a.name} ${money(Math.abs(n))}${reconciles ? ' owed' : ` (QuickBooks says ${money(n)})`}`;
            }).join(' · '));
        if (reconciles) {
            L.push(`      These are credit balances — the minus sign in QuickBooks means owed, not overdrawn. `
                + `They come to ${money(sum)}, which is the "You owe" figure above.`);
        } else if (owe !== null) {
            L.push(`      WORTH A LOOK: these come to ${money(sum)} but "You owe" says ${money(owe)}, `
                + `a difference of ${money(Math.round((sum - owe) * 100) / 100)}. One of the two is not counting something.`);
        }
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
