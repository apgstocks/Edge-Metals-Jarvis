// ── helpers/quickbooks/checks.js — everything that can be wrong ────────────
// Apsara, 2026-10-02: "I want this quickbook agent to be sharp, intelligent
// who can handle any qb problem."
//
// Sharpness is not a better prompt. It is a LIBRARY — every way her books
// have ever been wrong, written down as a check that runs every night and
// says the number. Six invariants is a scoreboard; this is the eyesight
// behind it, and it is meant to grow: every problem she brings that is not
// in here becomes a new entry, the same way the container rule, the voyage
// window and the payee guard were each learnt by being wrong in front of her.
//
// Each check is honest about three things: what it looks for, how sure it is
// (certain / likely / worth a look), and whether anybody can act on it.
// Nothing here writes. Checks observe; the agent decides.
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const today = () => new Date().toISOString().slice(0, 10);

const LINES = (x) => (x.Line || []).filter((l) => l.DetailType !== 'SubTotalLineDetail');
const party = (x) => ((x.VendorRef || x.CustomerRef || x.EntityRef || {}).name) || '';
const docOf = (x) => String(x.DocNumber || '').trim();

// ctx: { bills, invoices, purchases, payments, billPayments, vendors, customers, accounts, year }
const CHECKS = [
    {
        id: 'empty-document', title: 'A document with no lines, or no money on it',
        sure: 'certain', why: 'It contributes nothing and usually means a save went wrong half way.',
        run: (c) => [...c.bills, ...c.invoices].filter((x) => !LINES(x).length || !(Number(x.TotalAmt) > 0))
            .map((x) => ({ id: String(x.Id), kind: x.DocNumber !== undefined && x.VendorRef ? 'bill' : 'invoice',
                doc: docOf(x), date: x.TxnDate, party: party(x), amount: r2(x.TotalAmt),
                what: LINES(x).length ? 'no money on it' : 'no lines at all' })),
    },
    {
        id: 'lines-do-not-sum', title: "The lines do not add up to the document total",
        sure: 'certain', why: 'Her own arithmetic and QuickBooks disagree, so one of the two reports is wrong.',
        run: (c) => [...c.bills, ...c.invoices].map((x) => {
            const sum = r2(LINES(x).reduce((s, l) => s + Number(l.Amount || 0), 0));
            return { x, sum, gap: r2(sum - Number(x.TotalAmt || 0)) };
        }).filter((r) => Math.abs(r.gap) >= 0.01)
            .map(({ x, sum, gap }) => ({ id: String(x.Id), doc: docOf(x), date: x.TxnDate, party: party(x),
                amount: r2(x.TotalAmt), what: `lines add to ${sum}, the document says ${r2(x.TotalAmt)} (${gap > 0 ? '+' : ''}${gap})` })),
    },
    {
        id: 'future-dated', title: 'Dated in the future',
        sure: 'certain', why: 'It lands in a period that has not happened, so every report between now and then is wrong.',
        run: (c) => [...c.bills, ...c.invoices].filter((x) => String(x.TxnDate) > today())
            .map((x) => ({ id: String(x.Id), doc: docOf(x), date: x.TxnDate, party: party(x), amount: r2(x.TotalAmt),
                what: `dated ${x.TxnDate}, which is after today` })),
    },
    {
        id: 'no-reference', title: 'A document with no number at all',
        sure: 'likely', why: 'Nothing ties it to a shipment, so it cannot be matched, chased or found again.',
        run: (c) => [...c.bills, ...c.invoices].filter((x) => !docOf(x))
            .map((x) => ({ id: String(x.Id), doc: '', date: x.TxnDate, party: party(x), amount: r2(x.TotalAmt),
                what: 'no document number' })),
    },
    {
        id: 'same-number-two-parties', title: 'One document number used by two different parties',
        sure: 'worth a look', why: 'Her numbers carry the shipment, so the same one on two parties usually means one is typed wrong.',
        run: (c) => {
            const by = {};
            for (const x of [...c.bills, ...c.invoices]) {
                const d = KEY(docOf(x)); if (!d) continue;
                (by[d] = by[d] || []).push(x);
            }
            return Object.entries(by).filter(([, g]) => new Set(g.map(party)).size > 1)
                .map(([d, g]) => ({ id: g.map((x) => String(x.Id)).join('+'), doc: d, date: g[0].TxnDate,
                    party: [...new Set(g.map(party))].join(' / '), amount: r2(g.reduce((s, x) => s + Number(x.TotalAmt || 0), 0)),
                    what: `${g.length} documents share this number across ${new Set(g.map(party)).size} parties` }));
        },
    },
    {
        id: 'both-sides', title: 'The same company is both a supplier and a customer record',
        sure: 'worth a look', why: 'Legitimate when she buys from and sells to them — but the two balances never net, and a payment can land on the wrong one.',
        run: (c) => {
            const vend = new Map(c.vendors.map((v) => [KEY(v.DisplayName), v]));
            return c.customers.filter((cu) => vend.has(KEY(cu.DisplayName)))
                .map((cu) => ({ id: `${vend.get(KEY(cu.DisplayName)).Id}+${cu.Id}`, doc: '', date: '', party: cu.DisplayName,
                    amount: r2(Number(cu.Balance || 0) + Number(vend.get(KEY(cu.DisplayName)).Balance || 0)),
                    what: `customer #${cu.Id} (${r2(cu.Balance)}) and supplier #${vend.get(KEY(cu.DisplayName)).Id} (${r2(vend.get(KEY(cu.DisplayName)).Balance)})` }));
        },
    },
    {
        id: 'stale-open', title: 'Still open after a year',
        sure: 'likely', why: 'Either it was paid some other way and nobody closed it, or it is a debt old enough to need a decision.',
        run: (c) => {
            const cut = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
            return [...c.bills, ...c.invoices].filter((x) => Number(x.Balance) > 0 && String(x.TxnDate) < cut)
                .map((x) => ({ id: String(x.Id), doc: docOf(x), date: x.TxnDate, party: party(x), amount: r2(x.Balance),
                    what: `open since ${x.TxnDate}` }));
        },
    },
    {
        id: 'generic-cogs', title: 'Supplier money on the catch-all cost account',
        sure: 'likely', why: 'She keeps a cost account per supplier; the plain one is where money lands when nobody decided whose it was.',
        run: (c) => c.purchases.filter((p) => LINES(p).some((l) => /^cost of goods sold$/i.test((((l.AccountBasedExpenseLineDetail || {}).AccountRef) || {}).name || '')))
            .map((p) => ({ id: String(p.Id), doc: docOf(p), date: p.TxnDate, party: party(p) || '(no payee)',
                amount: r2(p.TotalAmt), what: party(p) ? 'on the catch-all cost account' : 'on the catch-all cost account, and no payee either' })),
    },
    {
        id: 'payee-missing', title: 'Money out with nobody named',
        sure: 'certain', why: 'Nobody can say whose money it was, so it can never be matched to a bill or a supplier.',
        run: (c) => c.purchases.filter((p) => !party(p))
            .map((p) => ({ id: String(p.Id), doc: docOf(p), date: p.TxnDate, party: '(no payee)', amount: r2(p.TotalAmt),
                what: 'no payee on the payment' })),
    },
    {
        id: 'negative-line', title: 'A negative line hiding inside a sale',
        sure: 'worth a look', why: 'A credit buried in an invoice reads as a smaller sale instead of as a credit note.',
        run: (c) => c.invoices.filter((x) => LINES(x).some((l) => Number(l.Amount) < 0))
            .map((x) => ({ id: String(x.Id), doc: docOf(x), date: x.TxnDate, party: party(x), amount: r2(x.TotalAmt),
                what: `${LINES(x).filter((l) => Number(l.Amount) < 0).map((l) => l.Amount).join(', ')} on the invoice` })),
    },
];

// ── AND THE ONES THAT ARE ONLY ABOUT HER BUSINESS ─────────────────────────
// Apsara, 2026-10-02: "with respect to our things." Generic bookkeeping
// checks find generic problems. These are the ones that only make sense for
// a scrap exporter: a container is bought once, sold once, at a margin, and
// hauled once. Everything below reads the container off the LINES, because
// the memo lists the whole shipment — the mistake that made four good
// September invoices look like one invoice four times.
const CONTAINER = /[A-Z]{4}\d{7}/;
function containersOf(x) {
    const out = [];
    for (const l of LINES(x)) {
        const m = String(l.Description || '').match(CONTAINER);
        if (m) out.push({ container: m[0], amount: r2(l.Amount), qty: ((l.ItemBasedExpenseLineDetail || l.SalesItemLineDetail || {}).Qty),
            what: (((l.ItemBasedExpenseLineDetail || l.SalesItemLineDetail || {}).ItemRef) || {}).name || '' });
    }
    return out;
}
// A container is only itself for one voyage — the shipping line reuses the
// box, and HMMU6166160 proved it twice: once as a "duplicate sale" a year
// apart, once as a weight that doubled. So the two sides are PAIRED inside a
// window, not matched on the number alone. And both sides must be read over
// the same period, or "bought and never sold" just counts how much further
// back the purchases were read.
const VOYAGE_DAYS = 120;
const apart = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;

function sideIndex(docs) {
    const by = {};
    for (const x of docs) {
        for (const l of containersOf(x)) {
            (by[l.container] = by[l.container] || []).push({
                container: l.container, id: String(x.Id), doc: docOf(x), date: x.TxnDate, party: party(x),
                money: l.amount, weight: Number(l.qty) > 0 ? Number(l.qty) : 0, what: l.what });
        }
    }
    // several lines of one document on one container roll into one entry
    for (const [c, rows] of Object.entries(by)) {
        const byDoc = {};
        for (const r of rows) {
            const g = byDoc[r.id] = byDoc[r.id] || { ...r, money: 0, weight: 0 };
            g.money = r2(g.money + r.money); g.weight = r2(g.weight + r.weight);
        }
        by[c] = Object.values(byDoc).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }
    return by;
}

// every sale paired with the purchase of the same box closest in time, inside
// one voyage. Unpaired rows on either side are returned too, because those
// are findings of their own.
function pairSides(bills, invoices) {
    const bought = sideIndex(bills), sold = sideIndex(invoices);
    const pairs = [], soldAlone = [], boughtAlone = [];
    const usedBuy = new Set();
    for (const [container, sales] of Object.entries(sold)) {
        for (const s of sales) {
            const candidates = (bought[container] || [])
                .filter((b) => !usedBuy.has(b.id + '|' + container) && apart(b.date, s.date) <= VOYAGE_DAYS)
                .sort((a, b) => apart(a.date, s.date) - apart(b.date, s.date));
            if (!candidates.length) { soldAlone.push(s); continue; }
            usedBuy.add(candidates[0].id + '|' + container);
            pairs.push({ container, buy: candidates[0], sell: s });
        }
    }
    for (const [container, buys] of Object.entries(bought)) {
        for (const b of buys) if (!usedBuy.has(b.id + '|' + container)) boughtAlone.push(b);
    }
    return { pairs, soldAlone, boughtAlone };
}

const DOMAIN_CHECKS = [
    {
        id: 'sold-not-bought', title: 'A container sold with no purchase behind it',
        sure: 'likely', why: 'Revenue with no cost against it — the margin on that shipment is overstated by the whole purchase price.',
        run: (c) => (c.pairing ? c.pairing.soldAlone : []).map((s) => ({ id: s.id, doc: s.container, date: s.date,
            party: s.party, amount: s.money, what: `sold ${s.date} for ${s.money}, no purchase of that box within ${VOYAGE_DAYS} days` })),
    },
    {
        id: 'bought-not-sold', title: 'A container bought and still not sold',
        sure: 'likely', why: 'Cost sitting with no revenue. Either it has not shipped yet, or the sale went out under a number with no container on it.',
        run: (c) => {
            const old = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
            return (c.pairing ? c.pairing.boughtAlone : []).filter((b) => b.date < old && b.date >= (c.since || '2026-01-01'))
                .map((b) => ({ id: b.id, doc: b.container, date: b.date, party: b.party, amount: b.money,
                    what: `bought ${b.date}, nothing sold against it in ${Math.round((Date.now() - new Date(b.date)) / 864e5)} days` }));
        },
    },
    {
        id: 'margin-upside-down', title: 'Sold for less than it cost',
        sure: 'certain', why: 'A real loss, a mistyped price, or the two sides are not the same material.',
        run: (c) => (c.pairing ? c.pairing.pairs : []).filter((p) => p.sell.money < p.buy.money)
            .map((p) => ({ id: `${p.buy.id} / ${p.sell.id}`, doc: p.container, date: p.sell.date,
                party: `${p.buy.party} → ${p.sell.party}`, amount: r2(p.buy.money - p.sell.money),
                what: `cost ${p.buy.money}, sold ${p.sell.money} — ${r2(p.buy.money - p.sell.money)} under` })),
    },
    {
        id: 'weight-drift', title: 'The weight bought and the weight sold disagree',
        sure: 'worth a look', why: 'Some drift is real — moisture, dirt, a re-weigh at the port. A lot of it is a claim waiting to happen, or a typed figure.',
        run: (c) => (c.pairing ? c.pairing.pairs : []).filter((p) => p.buy.weight > 0 && p.sell.weight > 0)
            .map((p) => ({ p, ratio: p.sell.weight / p.buy.weight }))
            // a ratio near 2000 is pounds against metric tonnes, not drift
            .filter(({ ratio }) => ratio > 0.5 && ratio < 2 && Math.abs(1 - ratio) > 0.02)
            .map(({ p, ratio }) => ({ id: `${p.buy.id} / ${p.sell.id}`, doc: p.container, date: p.sell.date,
                party: `${p.buy.party} → ${p.sell.party}`, amount: r2(p.sell.money),
                what: `bought ${p.buy.weight}, sold ${p.sell.weight} — ${Math.round((ratio - 1) * 1000) / 10}%` })),
    },
    {
        id: 'trucking-twice', title: 'Trucking charged twice on one container',
        sure: 'worth a look', why: 'The haulage is taken off the supplier bill AND billed by the trucker, so the same move is paid for twice.',
        run: (c) => {
            const out = [];
            const deducted = {};
            for (const b of c.bills) {
                for (const l of LINES(b)) {
                    const name = (((l.AccountBasedExpenseLineDetail || {}).AccountRef) || {}).name || '';
                    if (!/truck|freight|haul/i.test(name) || Number(l.Amount) >= 0) continue;
                    const m = String(l.Description || '').match(CONTAINER) || String(b.PrivateNote || '').match(CONTAINER);
                    if (m) deducted[m[0]] = { doc: String(b.Id), amount: r2(Math.abs(l.Amount)), party: party(b), date: b.TxnDate };
                }
            }
            for (const b of c.bills) {
                if (!/truck|trans|logistic|haul/i.test(party(b))) continue;
                for (const l of containersOf(b)) {
                    const d = deducted[l.container];
                    if (!d || apart(d.date, b.TxnDate) > VOYAGE_DAYS) continue;
                    out.push({ id: `${b.Id} / ${d.doc}`, doc: l.container, date: b.TxnDate, party: `${party(b)} + ${d.party}`,
                        amount: r2(Math.min(l.amount, d.amount)),
                        what: `${party(b)} billed ${l.amount} and ${d.amount} was already taken off ${d.party}'s bill` });
                }
            }
            return out;
        },
    },
];

function run(ctx) {
    // the two sides are paired once, here, so every container check sees the
    // same pairing and they cannot disagree with each other
    if (!ctx.pairing) ctx.pairing = pairSides(ctx.bills || [], ctx.invoices || []);
    const out = [];
    for (const check of [...CHECKS, ...DOMAIN_CHECKS]) {
        let found = [];
        let error = null;
        try { found = check.run(ctx) || []; } catch (e) { error = e.message; }
        out.push({ id: check.id, title: check.title, sure: check.sure, why: check.why,
            count: found.length, money: r2(found.reduce((s, f) => s + (Number(f.amount) || 0), 0)),
            rows: found.sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 50), error });
    }
    return out.sort((a, b) => b.count - a.count);
}

module.exports = { CHECKS, DOMAIN_CHECKS, run, pairSides, containersOf, VOYAGE_DAYS };
