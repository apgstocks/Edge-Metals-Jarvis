// ── tests/yard-payment-permutations.js ────────────────────────────────────
// Apsara, 2026-11-06: "What if paid by cash,paid by various payment type,
// invoice amount in report of ege yard/think of all permuattion adn
// combination", then "not in nightky yard report.in webiste/app".
//
// ── WHAT THE QUESTION FOUND ──────────────────────────────────────────────
// A real fault, and MY OWN. api.js's amountForLoad resolved a SALE to
// `.amount` — the metal only — while routes/yard.js, helpers/loadsPdf.js and
// helpers/tools.js all resolved it through receivableOf, which is
// amount + the trucking she charges the buyer.
//
// So on a sale of $10,000 of metal with $800 of haulage, taking $10,000 in
// cash made the payment route answer "paid, nothing pending" while the card
// beside it still showed $800 outstanding. The $800 was written off at the
// moment of payment, silently, on the screen she uses to take money.
//
// Introduced by omission: receivableOf arrived with sales trucking and five
// sale-side callers were re-pointed at it. This one was missed because it is
// reached through ctx rather than by requiring outboundLoads, so grepping
// the new function's callers never surfaced it.
//
// ── SO THIS FILE IS THE PERMUTATION MATRIX SHE ASKED FOR ─────────────────
// kind (purchase / sale) x trucking (none / some) x how much was paid
// (nothing / part / exactly / over) x mode (cash / bank / several at once).
//
// And it asserts ONE property across all of them, which is the property that
// was false: every path that answers "what does this load total" gives the
// SAME number. A figure that depends on which screen asked is not a figure.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yard-perm-'));
const cfg = require(path.join(ROOT, 'config'));
// ── EVERY *_FILE KEY, NOT JUST DATA_DIR ─────────────────────────────────
// config.js computes each path with path.join(DATA_DIR, ...) AT LOAD TIME,
// so reassigning cfg.DATA_DIR afterwards redirects NOTHING. The first draft
// of this file set DATA_DIR plus four keys and missed PETTY_CASH_FILE — and
// a cash payment on a yard load draws from petty cash, so the run wrote four
// real rows into the repo's data/petty_cash.json before the balance ran out
// and it crashed.
//
// Caught because the crash named the real path. It would have been silent if
// the balance had been large enough, which is the part worth remembering.
//
// So: every key, taken from config itself rather than from a list someone
// has to keep up to date.
cfg.DATA_DIR = dir;
for (const k of Object.keys(cfg)) {
    if (/_FILE$/.test(k) && typeof cfg[k] === 'string') {
        cfg[k] = path.join(dir, path.basename(cfg[k]));
    }
}

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
const loads = require(path.join(ROOT, 'helpers/loads'));
const ob = require(path.join(ROOT, 'helpers/outboundLoads'));
const pay = require(path.join(ROOT, 'helpers/payments'));

const usd = (n) => (n == null ? 'null' : '$' + Number(n).toFixed(2));

(async () => {

// ── CASH ON A PURCHASE COMES OUT OF PETTY CASH ───────────────────────────
// Not an incidental detail: helpers/payments.js routes a cash purchase
// through pettyCash.withdrawForPayment, which REFUSES when the drawer is
// short. That is correct and is section G below; here the drawer is simply
// floated so the other permutations are about the arithmetic rather than
// about the float.
const petty = require(path.join(ROOT, 'helpers/pettyCash'));
await petty.addTopUp({ amount: 500000, date: '2026-11-01', note: 'float for the matrix',
    cash_source: petty.UNASSIGNED });

// ── the permutation matrix ───────────────────────────────────────────────
// Modes are per kind: a yard SALE takes Cash/Bank transfer/Zelle/Cheque, a
// PURCHASE pays Cash/Zelle/Wire/Cheque. helpers/payments.js owns those lists
// and refuses anything else, so the fixtures read them rather than guessing.
const KINDS = ['purchase', 'sale'];
const TRUCKING = [0, 800];
const PAID = ['nothing', 'part', 'exact', 'over'];

let made = 0;
async function makeLoad(kind, trucking) {
    made += 1;
    const amount = 10000;
    if (kind === 'purchase') {
        const l = { id: 'EDGE_' + made, date: '2026-11-06', seller: 'Ramesh', amount,
            trucking, net_payable: trucking ? amount - trucking : null, items: [], weight_unit: 'lb' };
        await mutateJson(cfg.LOADS_FILE, [], (a) => { a.push(l); return a; }, { strict: true });
        return { load: l, total: loads.payableOf(l) };
    }
    const l = { id: 'OUT_' + made, date: '2026-11-06', buyer: 'Eccomelt', amount,
        trucking, net_receivable: trucking ? ob.receivableFrom(amount, trucking) : null,
        items: [], weight_unit: 'lb' };
    await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], (a) => { a.push(l); return a; }, { strict: true });
    return { load: l, total: ob.receivableOf(l) };
}

// ══════════════════════════════════════════════════════════════════════════
section('A — the trucking arithmetic, in both directions');
// ══════════════════════════════════════════════════════════════════════════
// They are NOT mirror images and must never be made so. On a purchase the
// haulage comes OFF what the seller is owed; on a sale it goes ON what the
// buyer pays.
{
    const p = (await makeLoad('purchase', 800)).total;
    const s = (await makeLoad('sale', 800)).total;
    ck('a purchase nets the haulage OUT', p === 9200, usd(p));
    ck('a sale charges the haulage ON', s === 10800, usd(s));
    ck('  so the two differ by twice the trucking', s - p === 1600, usd(s - p));

    const p0 = (await makeLoad('purchase', 0)).total;
    const s0 = (await makeLoad('sale', 0)).total;
    ck('with no trucking both are just the amount', p0 === 10000 && s0 === 10000, `${usd(p0)} / ${usd(s0)}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — THE PROPERTY: every path agrees on the total');
// ══════════════════════════════════════════════════════════════════════════
// This is the one that was false. amountForLoad is reached through ctx, so
// the check calls the SAME function api.js installs rather than a copy of
// its logic — a re-implementation here would have agreed with itself and
// proved nothing.
{
    const amountForLoad = (loadId, kind) => {
        if (kind === 'sale') {
            const l = ob.loadOutboundLoads().find((x) => x.id === loadId);
            return l ? ob.receivableOf(l) : null;
        }
        const l = loads.loadLoads().find((x) => x.id === loadId);
        return l ? loads.payableOf(l) : null;
    };
    // Guard against this check drifting from the real one: the source must
    // still route a sale through receivableOf. Without this the helper above
    // could stay right while api.js went wrong again.
    const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const fn = src.slice(src.indexOf('function amountForLoad('), src.indexOf('// ── Load drafts'));
    ck('api.js resolves a SALE through receivableOf',
       /receivableOf\(l\)/.test(fn), 'it read .amount, and wrote off the trucking');
    ck('  and a PURCHASE through payableOf', /payableOf\(l\)/.test(fn));
    ck('  neither reads a bare .amount any more', !/return l \? l\.amount : null;/.test(fn),
       'a bare amount here is the bug this file exists for');

    for (const kind of KINDS) {
        for (const trucking of TRUCKING) {
            const { load, total } = await makeLoad(kind, trucking);
            const viaRoute = amountForLoad(load.id, kind === 'sale' ? 'sale' : 'purchase');
            ck(`${kind}, trucking ${usd(trucking)}: the payment route agrees with the card`,
               viaRoute === total, `route ${usd(viaRoute)} vs card ${usd(total)}`);
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('C — paid by cash, and every level of paid');
// ══════════════════════════════════════════════════════════════════════════
{
    for (const kind of KINDS) {
        for (const trucking of TRUCKING) {
            for (const level of PAID) {
                const { load, total } = await makeLoad(kind, trucking);
                const amt = level === 'nothing' ? 0
                    : level === 'part' ? Math.round(total / 2)
                    : level === 'exact' ? total : total + 500;
                if (amt > 0) {
                    await pay.addPayment({ load_id: load.id, load_kind: kind, amount: amt,
                        mode: 'Cash', paid_on: '2026-11-06' });
                }
                const s = pay.paymentSummary(load.id, total);
                const want = level === 'nothing' ? 'unpaid'
                    : level === 'part' ? 'partial'
                    : level === 'exact' ? 'paid' : 'overpaid';
                ck(`${kind} +${usd(trucking)} haulage, ${level} in cash → ${want}`,
                   s.status === want, `${s.status}, paid ${usd(s.paid)} of ${usd(total)}`);
                if (level === 'exact') {
                    ck(`  nothing left pending`, s.pending === 0, usd(s.pending));
                }
                if (level === 'over') {
                    ck(`  the overage is reported, not shown as owed`,
                       s.pending === 0 && s.over === 500, `pending ${usd(s.pending)} over ${usd(s.over)}`);
                }
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('D — "paid by various payment type": one load, several modes');
// ══════════════════════════════════════════════════════════════════════════
// The case her question names directly. A $10,800 sale settled with cash,
// a bank transfer and a cheque must come out settled — not three times
// partial, and not paid early because one path forgot the haulage.
{
    const { load, total } = await makeLoad('sale', 800);
    ck('the sale totals metal plus haulage', total === 10800, usd(total));

    await pay.addPayment({ load_id: load.id, load_kind: 'sale', amount: 4000, mode: 'Cash', paid_on: '2026-11-06' });
    let s = pay.paymentSummary(load.id, total);
    ck('after $4,000 cash it is partial', s.status === 'partial' && s.pending === 6800, usd(s.pending));

    // ── A BANK TRANSFER MUST SAY WHICH COMPANY ──────────────────────────
    // CLAUDE.md's third recorded over-reach: "on selecting wire-it should ask
    // me Payment via Edge Yard/Edge Metals". The engine enforces it, and a
    // permutation file that quietly supplied the field without checking the
    // refusal would be hiding the rule rather than testing it.
    let refused = null;
    try {
        await pay.addPayment({ load_id: load.id, load_kind: 'sale', amount: 6000,
            mode: 'Bank transfer', paid_on: '2026-11-06' });
    } catch (e) { refused = e; }
    ck('  a bank transfer with no "Paid to" is REFUSED', !!refused,
       'this is the rule that was broken once already');
    ck('    and the refusal names the companies to choose from',
       refused && /Edge Yard|Edge Metals/.test(refused.message), refused && refused.message);

    await pay.addPayment({ load_id: load.id, load_kind: 'sale', amount: 6000,
        mode: 'Bank transfer', paid_via: 'Edge Yard', paid_on: '2026-11-06' });
    s = pay.paymentSummary(load.id, total);
    ck('  after a $6,000 bank transfer, STILL partial — the haulage is unpaid',
       s.status === 'partial' && s.pending === 800, `${s.status}, pending ${usd(s.pending)}`);
    ck('  and this is exactly the money the old code wrote off', s.pending === 800);

    await pay.addPayment({ load_id: load.id, load_kind: 'sale', amount: 800, mode: 'Cheque', paid_on: '2026-11-06' });
    s = pay.paymentSummary(load.id, total);
    ck('  the cheque for the haulage settles it', s.status === 'paid' && s.pending === 0, s.status);
    ck('  across three different modes', s.payments.length === 3,
       JSON.stringify(s.payments.map((x) => x.mode)));
    ck('  and every mode is kept, so the breakdown is answerable',
       ['Cash', 'Bank transfer', 'Cheque'].every((m) => s.payments.some((x) => x.mode === m)),
       JSON.stringify(s.payments.map((x) => x.mode)));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — a purchase paid the same way, to prove the fix did not widen');
// ══════════════════════════════════════════════════════════════════════════
// CLAUDE.md rule 1. The sale branch changed; the purchase branch must not
// have, and the haulage must still come OFF rather than on.
{
    const { load, total } = await makeLoad('purchase', 800);
    ck('the purchase nets haulage off', total === 9200, usd(total));
    await pay.addPayment({ load_id: load.id, load_kind: 'purchase', amount: 9200, mode: 'Cash', paid_on: '2026-11-06' });
    const s = pay.paymentSummary(load.id, total);
    ck('  paying the NET settles the seller', s.status === 'paid' && s.pending === 0, s.status);
    ck('  the seller is not asked for the gross', total !== 10000);
}

// ══════════════════════════════════════════════════════════════════════════
section('F — a load with no price settles nothing, and says so');
// ══════════════════════════════════════════════════════════════════════════
// The permutation that has no arithmetic. Claiming "fully paid" because the
// total happens to be null would be a lie with money attached.
{
    made += 1;
    const l = { id: 'OUT_' + made, date: '2026-11-06', buyer: 'Eccomelt', amount: null,
        items: [], weight_unit: 'lb' };
    await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], (a) => { a.push(l); return a; }, { strict: true });
    ck('an unpriced sale has no total', ob.receivableOf(l) === null, String(ob.receivableOf(l)));
    await pay.addPayment({ load_id: l.id, load_kind: 'sale', amount: 500, mode: 'Cash', paid_on: '2026-11-06' });
    const s = pay.paymentSummary(l.id, ob.receivableOf(l));
    ck('  money against it is recorded', s.paid === 500, usd(s.paid));
    ck('  but it is never called settled', s.status === 'paid_amount_unknown', s.status);
    ck('  and no pending figure is invented', s.pending === null, String(s.pending));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
