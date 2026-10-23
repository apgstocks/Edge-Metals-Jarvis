// ── tests/settle-against.js ──────────────────────────────────────────────
// Apsara, 2026-10-17: "when we pay load/sales-there should be a option to
// adjust against sale incase of load and against load in case of sale", and
// then, confirming what it means in her own words:
//
//   "his seller is also a buyer, he owes you $3,000 on a sale, you're paying
//    him $5,000 for a load, so you hand over $2,000 and the $3,000 is
//    settled ... This happend"
//
// So it is a REAL contra between two documents, not a bookkeeping tidy-up,
// and the numbers above are the fixture.
//
// ── THE THREE WAYS THIS GOES WRONG, AND WHAT EACH WOULD COST ────────────
//   · cash moves for the settled part — the drawer loses $5,000 when only
//     $2,000 left the building, and petty cash never reconciles again
//   · one side is written and the other is not — a load that looks paid and
//     a sale that still looks owed, with no way to tell which is the lie
//   · it nets two DIFFERENT people — two errors that happen to cancel
//
// Each has a section. The engine is tested on its own here; no screen calls
// it yet, deliberately.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-settle-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// SET BEFORE config IS REQUIRED, not inside section H where they are used.
// config.js reads these once, at require time, into cfg.STAFF_PASSWORD — so
// assigning them later leaves the staff password EMPTY and api.js's login
// silently refuses. Section H's staff-403 check then skipped itself, which is
// the quiet shape of a security check that proves nothing.
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const pay = require(path.join(ROOT, 'helpers/payments'));
const petty = require(path.join(ROOT, 'helpers/pettyCash'));
const loads = require(path.join(ROOT, 'helpers/loads'));
const outbound = require(path.join(ROOT, 'helpers/outboundLoads'));

const readPayments = () => JSON.parse(fs.readFileSync(cfg.PAYMENTS_FILE, 'utf8'));
const pettyRows = () => {
    try { return JSON.parse(fs.readFileSync(cfg.PETTY_CASH_FILE, 'utf8')); } catch (e) { return []; }
};
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e); } };

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — her actual case: $5,000 load, $3,000 sale, one man');

// Cash in the drawer first, or the $2,000 she actually hands over cannot be
// recorded and section B would be measuring an empty tin.
await petty.addTopUp({ amount: 10000, cash_source: 'Chase Bank', note: 'fixture', created_by: 'test' });

const buy = await loads.addLoad({
    date: '2026-10-10', seller: 'Gomez Scrap',
    items: [{ description: 'Alternator', gross_weight: 5100, tare_weight: 100, net_weight: 5000, price: 1, amount: 5000 }],
});
const sell = await outbound.addOutboundLoad({
    date: '2026-10-11', buyer: 'GOMEZ SCRAP',
    items: [{ description: 'Alternator', gross_weight: 3000, tare_weight: 0, net_weight: 3000, price: 1, amount: 3000 }],
});

ck('the purchase is $5,000 payable', loads.payableOf(loads.getLoad(buy.id)) === 5000,
   String(loads.payableOf(loads.getLoad(buy.id))));
ck('the sale is $3,000', outbound.getOutboundLoad(sell.id).amount === 3000,
   String(outbound.getOutboundLoad(sell.id).amount));

{
    const out = await pay.settleAgainst({
        load_id: buy.id, load_kind: 'purchase',
        against_id: sell.id, amount: 3000, created_by: 'test',
    });
    ck('the settlement is accepted', !!out && out.amount === 3000, JSON.stringify(out && out.amount));
    ck('  and names the party it netted', out.party === 'Gomez Scrap', String(out && out.party));

    // TWO ROWS, ONE ID.
    const rows = readPayments().filter((p) => p.settlement_id === out.settlement_id);
    ck('  two rows were written', rows.length === 2, String(rows.length));
    ck('  one against the purchase', rows.some((r) => r.load_id === buy.id && r.load_kind === 'purchase'));
    ck('  one against the sale', rows.some((r) => r.load_id === sell.id && r.load_kind === 'sale'));
    ck('  each points at the other', rows.every((r) => r.settled_against === (r.load_id === buy.id ? sell.id : buy.id)));
    ck('  both for the same amount', rows.every((r) => r.amount === 3000));
}

// ── THE $2,000 THAT ACTUALLY MOVED ──────────────────────────────────────
// Recorded the ordinary way, through the path that already exists. The
// settlement does not replace paying her supplier, it reduces what is left.
await pay.addPayment({
    load_id: buy.id, load_kind: 'purchase', mode: 'Cash', amount: 2000,
    cash_source: 'Chase Bank', created_by: 'test',
});

{
    const s = pay.paymentSummary(buy.id, loads.payableOf(loads.getLoad(buy.id)));
    ck('the load is settled in full', s.status === 'paid', `${s.status} — paid ${s.paid} of ${s.total}`);
    ck('  $5,000 against it', s.paid === 5000, String(s.paid));
    ck('  nothing outstanding', s.pending === 0, String(s.pending));

    const r = pay.paymentSummary(sell.id, outbound.getOutboundLoad(sell.id).amount);
    ck('and the sale is settled too', r.status === 'paid', `${r.status} — received ${r.paid} of ${r.total}`);
    ck('  $3,000 received', r.paid === 3000, String(r.paid));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — only $2,000 ever left the drawer');
{
    // THE EXPENSIVE MISTAKE. A settlement that moved cash would take $5,000
    // out of petty cash for a day she only handed over $2,000, and nothing
    // would ever reconcile again.
    const cash = pettyRows().filter((e) => e && String(e.load_id || '') === buy.id);
    const taken = cash.reduce((t, e) => t + Math.abs(Number(e.amount) || 0), 0);
    ck('petty cash moved exactly once for this load', cash.length === 1, `${cash.length} entries`);
    ck('  and for $2,000, not $5,000', Math.abs(taken - 2000) < 0.005, String(taken));

    const rows = readPayments().filter((p) => p.is_settlement);
    ck('no settlement row claims a cash entry', rows.every((r) => r.petty_cash_entry_id === null));
    ck('  or a cash_taken figure', rows.every((r) => r.cash_taken === null),
       'deleteByLoad would try to put back money that was never taken');
    ck('  and none of them calls itself Cash', rows.every((r) => r.mode === 'Settlement'),
       'the spend report and the bank matcher read mode — a fake Cash row is money she cannot find');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — what it refuses');
{
    const other = await outbound.addOutboundLoad({
        date: '2026-10-12', buyer: 'Vega Hauling',
        items: [{ description: 'Starter', gross_weight: 100, tare_weight: 0, net_weight: 100, price: 1, amount: 100 }],
    });
    const buy2 = await loads.addLoad({
        date: '2026-10-12', seller: 'Gomez Scrap',
        items: [{ description: 'Starter', gross_weight: 500, tare_weight: 0, net_weight: 500, price: 1, amount: 500 }],
    });

    // DIFFERENT PEOPLE. Netting Gomez against Vega is two errors cancelling.
    let msg = await threw(() => pay.settleAgainst({
        load_id: buy2.id, load_kind: 'purchase', against_id: other.id, amount: 50 }));
    ck('two different parties are refused', !!msg, 'it netted one man against another');
    ck('  and both names are in the message',
       !!msg && /Gomez/i.test(msg) && /Vega/i.test(msg), msg);

    // MORE THAN IS OWED, either side.
    const sale2 = await outbound.addOutboundLoad({
        date: '2026-10-12', buyer: 'Gomez Scrap',
        items: [{ description: 'Starter', gross_weight: 80, tare_weight: 0, net_weight: 80, price: 1, amount: 80 }],
    });
    msg = await threw(() => pay.settleAgainst({
        load_id: buy2.id, load_kind: 'purchase', against_id: sale2.id, amount: 500 }));
    ck('settling more than the SALE has outstanding is refused', !!msg, 'over-settled the sale');
    ck('  and says how much it has', !!msg && /80\.00/.test(msg), msg);

    msg = await threw(() => pay.settleAgainst({
        load_id: buy.id, load_kind: 'purchase', against_id: sale2.id, amount: 10 }));
    ck('settling a load that owes nothing is refused', !!msg, 'the load was already paid in full');

    // ITSELF.
    msg = await threw(() => pay.settleAgainst({
        load_id: buy2.id, load_kind: 'purchase', against_id: buy2.id, amount: 10 }));
    ck('a load cannot be settled against itself', !!msg, msg);

    // NOTHING WAS WRITTEN by any refusal.
    const before = readPayments().filter((p) => p.load_id === buy2.id).length;
    ck('a refused settlement wrote nothing', before === 0, `${before} rows against the refused load`);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a settlement is removed from BOTH sides or neither');
{
    const b = await loads.addLoad({
        date: '2026-10-13', seller: 'Calderon',
        items: [{ description: 'Motors', gross_weight: 1000, tare_weight: 0, net_weight: 1000, price: 1, amount: 1000 }],
    });
    const s = await outbound.addOutboundLoad({
        date: '2026-10-13', buyer: 'Calderon',
        items: [{ description: 'Motors', gross_weight: 400, tare_weight: 0, net_weight: 400, price: 1, amount: 400 }],
    });
    const out = await pay.settleAgainst({ load_id: b.id, load_kind: 'purchase', against_id: s.id, amount: 400 });

    ck('both sides show it', pay.paymentSummary(b.id, 1000).paid === 400
        && pay.paymentSummary(s.id, 400).paid === 400);

    const res = await pay.deleteSettlement(out.settlement_id);
    ck('deleting removes two rows', res.removed === 2, JSON.stringify(res));
    ck('  the purchase is owed again', pay.paymentSummary(b.id, 1000).paid === 0,
       String(pay.paymentSummary(b.id, 1000).paid));
    ck('  and so is the sale', pay.paymentSummary(s.id, 400).paid === 0,
       String(pay.paymentSummary(s.id, 400).paid));
    ck('  a half-settled pair cannot survive',
       readPayments().filter((p) => p.settlement_id === out.settlement_id).length === 0);

    const msg = await threw(() => pay.deleteSettlement(out.settlement_id));
    ck('deleting it twice is refused, not silently ignored', !!msg, msg);
}

// ══════════════════════════════════════════════════════════════════════════
section('F — what is OWED, not what the items came to');
{
    // THE ONE THAT SURVIVED THE FIRST MUTATION RUN. Every fixture above has
    // amount === net_payable, so reading `.amount` instead of payableOf()
    // looked identical and a mutation swapping them went unnoticed.
    //
    // It is not identical in her yard. A purchase with haulage deducted owes
    // the seller LESS than its items came to (helpers/loads.js's payableOf is
    // the single reader for exactly this reason, and #78 routed every "what
    // is owed" through it). Settling against the gross hands over money that
    // is not due — on the contra side, it would close a sale using credit the
    // seller never had.
    const b = await loads.addLoad({
        date: '2026-10-15', seller: 'Haulage Co',
        trucking_amount: 200,
        items: [{ description: 'Motors', gross_weight: 1000, tare_weight: 0, net_weight: 1000, price: 1, amount: 1000 }],
    });
    const rec = loads.getLoad(b.id);
    ck('the items came to $1,000', rec.amount === 1000, String(rec.amount));
    ck('  but only $800 is payable after haulage', loads.payableOf(rec) === 800, String(loads.payableOf(rec)));

    const s2 = await outbound.addOutboundLoad({
        date: '2026-10-15', buyer: 'Haulage Co',
        items: [{ description: 'Motors', gross_weight: 900, tare_weight: 0, net_weight: 900, price: 1, amount: 900 }],
    });

    // $900 is under the GROSS and over the PAYABLE. Reading `.amount` accepts
    // it; reading payableOf refuses it. That is the whole difference.
    const msg = await threw(() => pay.settleAgainst({
        load_id: b.id, load_kind: 'purchase', against_id: s2.id, amount: 900 }));
    ck('settling $900 against an $800 payable is refused', !!msg,
       'it settled against the gross, so $100 of haulage was handed to the seller as credit');
    ck('  and the message quotes the PAYABLE, not the gross',
       !!msg && /800\.00/.test(msg) && !/1000\.00/.test(msg), msg);

    // And the honest figure still works.
    const ok = await pay.settleAgainst({
        load_id: b.id, load_kind: 'purchase', against_id: s2.id, amount: 800 });
    ck('  settling exactly the payable is accepted', !!ok && ok.amount === 800, JSON.stringify(ok && ok.amount));
    ck('  and the load is then fully settled',
       pay.paymentSummary(b.id, loads.payableOf(loads.getLoad(b.id))).status === 'paid',
       pay.paymentSummary(b.id, loads.payableOf(loads.getLoad(b.id))).status);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — nothing existing changed');
{
    // CLAUDE.md §1. addPayment is reached by the pay modal on two clients AND
    // by helpers/tools.js's record_payment — the voice path, which has no
    // form to put a new field on and has broken twice on exactly that. This
    // went in as its own function for that reason, so the proof is that
    // addPayment still takes what it always took.
    const b = await loads.addLoad({
        date: '2026-10-14', seller: 'Inesh',
        items: [{ description: 'Motors', gross_weight: 100, tare_weight: 0, net_weight: 100, price: 1, amount: 100 }],
    });
    const p = await pay.addPayment({
        load_id: b.id, load_kind: 'purchase', mode: 'Cash', amount: 100,
        cash_source: 'Chase Bank', created_by: 'voice',
    });
    ck('an ordinary payment still records with no settlement fields', !!p && p.amount === 100);
    ck('  and is not marked as one', !p.is_settlement && p.settlement_id === undefined,
       JSON.stringify({ is_settlement: p.is_settlement, settlement_id: p.settlement_id }));

    const src = fs.readFileSync(path.join(ROOT, 'helpers/payments.js'), 'utf8');
    ck('settleAgainst is its own entry point, not a branch inside addPayment',
       /async function settleAgainst/.test(src)
       && !/function addPayment[\s\S]{0,4000}against_id/.test(src),
       'folding it into addPayment is what breaks the voice path');
    ck('  and both are exported', typeof pay.settleAgainst === 'function' && typeof pay.addPayment === 'function');
}

// ══════════════════════════════════════════════════════════════════════════
section('G — $3,000 that never left the building is not SPEND');
{
    // THE CHECK THAT CAUGHT A REAL DEFECT. 'Settlement' is a mode that did
    // not exist until today, and helpers/spendReport.js reads `mode` against
    // a fixed METHODS list — so the row fell through to Unclassified AND WAS
    // STILL COUNTED, which is the dangerous combination: the total was wrong
    // and the row was parked in a bucket nobody audits.
    //
    // Her words were "you hand over $2,000 and the $3,000 is settled". The
    // spend report answers "what did we pay out". For that day the only
    // honest answer is $2,000.
    const { buildSpendReport } = require(path.join(ROOT, 'helpers/spendReport'));
    const today = require(path.join(ROOT, 'helpers/time')).todayLocal();
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

    // THE WINDOW IS TODAY, not the load's date. collectRows ranges on
    // `paid_on || created_at`, and these fixtures set no paid_on — so a
    // 2026-10-15 window excluded BOTH rows and every figure below came out
    // zero. A delta of 0 - 0 = 0 would have "passed" while proving nothing,
    // which is the failure mode this repo's mutation doctrine is about. The
    // three-point measurement below exists so that cannot happen quietly:
    // the middle step has to MOVE or the section is not testing the report.
    const spendNow = () => buildSpendReport({
        payments: pay.listPayments(), expenses: [], from: today, to: today }).total;

    const buy = await loads.addLoad({
        date: today, seller: 'Ravi',
        items: [{ description: 'Motors', gross_weight: 500, tare_weight: 0, net_weight: 500, price: 10, amount: 5000 }],
    });
    const sold = await outbound.addOutboundLoad({
        date: today, buyer: 'Ravi', amount: 3000,
        items: [{ description: 'Motors', gross_weight: 300, tare_weight: 0, net_weight: 300, price: 10, amount: 3000 }],
    });

    // ── 1. the baseline, whatever earlier sections left behind ───────────
    const base = spendNow();

    // ── 2. the $2,000 that really did leave the drawer ───────────────────
    await pay.addPayment({
        load_id: buy.id, load_kind: 'purchase', mode: 'Cash', amount: 2000,
        cash_source: 'Chase Bank', created_by: 'test',
    });
    const withCash = spendNow();
    ck('the report SEES this fixture — $2,000 paid moved the total by $2,000',
       round2(withCash - base) === 2000,
       `${base} → ${withCash}; if this is 0 the section below proves nothing`);

    // ── 3. the $3,000 that was settled, not paid ─────────────────────────
    await pay.settleAgainst({ load_id: buy.id, load_kind: 'purchase',
        against_id: sold.id, against_kind: 'sale', amount: 3000, created_by: 'test' });
    const withSettlement = spendNow();

    ck('  and the settlement moved it by nothing at all',
       round2(withSettlement - withCash) === 0,
       `${withCash} → ${withSettlement} — the $3,000 is being counted as money paid out`);
    ck('  so the day\'s outflow is the $2,000, exactly as she described it',
       round2(withSettlement - base) === 2000, `${base} → ${withSettlement}`);

    // Unclassified is where an unrecognised mode lands, and it is the bucket
    // nobody audits — a settlement sitting there with a figure against it is
    // the first shape this defect took.
    const byMethod = buildSpendReport({ payments: pay.listPayments(), expenses: [],
        from: today, to: today }).byMethod || {};
    ck('  and it is not parked in Unclassified either',
       Number(byMethod.Unclassified || 0) === 0, JSON.stringify(byMethod));

    // The guard must be shaped so that ABSENCE means today's behaviour. A
    // row with no flag is an ordinary payment and still spend — otherwise
    // every historical row would vanish from her report.
    const sp = fs.readFileSync(path.join(ROOT, 'helpers/spendReport.js'), 'utf8');
    ck('the skip is in the same guard as the unapplied-advance skip',
       /if \(!p\.load_id \|\| p\.is_advance \|\| p\.is_settlement\) continue;/.test(sp),
       'a separate branch elsewhere is a second place to forget');

    // AND THE BOOKS ARE NOT AFFECTED, for a reason worth asserting rather
    // than remembering: booksBuild takes the yard off the LOAD records'
    // amount, never off payments.json. If that ever changes, a settlement
    // starts posting a cash credit to a bank account and the trial balance
    // balances while being wrong.
    const bb = fs.readFileSync(path.join(ROOT, 'helpers/booksBuild.js'), 'utf8');
    ck('booksBuild still does not read the yard payments store',
       !/PAYMENTS_FILE/.test(bb) && !/payments\.json/.test(bb),
       'the yard cash side now reaches the posting layer — settlements must be excluded there too');
}

// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
section('H — END TO END, through the routes the screens will post to');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
//
// Sections A–G prove the engine. Every one of them would still pass with no
// route at all — which is exactly the state this feature was in an hour ago,
// and the state scripts/check-route-reach.js exists because of: "A PRIVILEGED
// ROUTE THAT NOTHING CALLS IS A PERMISSION THAT EXISTS ON PAPER."
//
// Her words, as the fixture: "his seller is also a buyer, he owes you $3,000
// on a sale, you're paying him $5,000 for a load, so you hand over $2,000 and
// the $3,000 is settled".
{
    const http = require('http');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const req = (method, p2, opts) => new Promise((resolve, reject) => {
        const { body, sid } = (opts || {});
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = 'Bearer ' + sid;
        const r2 = http.request(base + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    try {
        const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
        ck('signed in', !!sid);

        // One man, both sides. $5,000 owed to him on a purchase, $3,000 owed
        // by him on a sale — and the spellings DIFFER, because they do in her
        // data, and canonicalName is what makes him one person.
        const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
        await mutateJson(cfg.LOADS_FILE, [], (list) => {
            const l = Array.isArray(list) ? list : [];
            l.unshift({ id: 'E2E_BUY', date: '2026-10-16', seller: 'Gomez Scrap', amount: 5000, items: [], weight_unit: 'lb' });
            return l;
        });
        await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], (list) => {
            const l = Array.isArray(list) ? list : [];
            l.unshift({ id: 'E2E_SELL', date: '2026-10-16', buyer: 'GOMEZ SCRAP', amount: 3000, items: [], weight_unit: 'lb' });
            return l;
        });

        // ── 1. THE OPTIONS ROUTE: what can this be netted against ────────
        const opts = await req('GET', '/api/payments/settle-options?load_id=E2E_BUY&load_kind=purchase', { sid });
        ck('the options route answers', opts.status === 200, opts.status + ' ' + JSON.stringify(opts.json));
        const o = opts.json || {};
        ck('  it found his open sale', (o.options || []).some((x) => x.id === 'E2E_SELL'), JSON.stringify(o.options));
        ck('  across the two spellings of his name', o.party === 'Gomez Scrap', String(o.party));
        ck('  and says $3,000 is outstanding on it',
           ((o.options || []).find((x) => x.id === 'E2E_SELL') || {}).outstanding === 3000, JSON.stringify(o.options));
        ck('  the purchase side owes $5,000', o.outstanding === 5000, String(o.outstanding));
        ck('  so the most that can be netted is $3,000', o.max === 3000, String(o.max));

        // ── 2. THE SETTLEMENT, THROUGH THE ROUTE ─────────────────────────
        const done = await req('POST', '/api/payments/settle', { sid, body: {
            load_id: 'E2E_BUY', load_kind: 'purchase',
            against_id: 'E2E_SELL', against_kind: 'sale', amount: 3000,
        } });
        ck('the route settles it', done.status === 200, done.status + ' ' + JSON.stringify(done.json));
        const d = done.json || {};
        ck('  and hands back an id to undo it with', !!d.settlement_id, JSON.stringify(d));

        // BOTH summaries, because both documents changed. A route returning
        // only the side she was looking at leaves the other screen showing a
        // figure that is wrong in front of her.
        ck('  the purchase now shows $3,000 applied', (d.summary || {}).paid === 3000, JSON.stringify(d.summary));
        ck('  and the SALE side came back too', !!d.against_summary, JSON.stringify(d));
        ck('    showing $3,000 received', (d.against_summary || {}).paid === 3000, JSON.stringify(d.against_summary));

        // ── 3. $2,000 IS WHAT IS LEFT TO HAND OVER — HER NUMBER ──────────
        const after = await req('GET', '/api/payments/settle-options?load_id=E2E_BUY&load_kind=purchase', { sid });
        ck('his sale is gone from the options, being fully settled',
           !(((after.json || {}).options) || []).some((x) => x.id === 'E2E_SELL'),
           JSON.stringify((after.json || {}).options));
        ck('  and the purchase has $2,000 left on it',
           (after.json || {}).outstanding === 2000, String((after.json || {}).outstanding));

        // ── 4. REFUSALS ARRIVE AS 400, NOT 500 ───────────────────────────
        const twice = await req('POST', '/api/payments/settle', { sid, body: {
            load_id: 'E2E_BUY', load_kind: 'purchase',
            against_id: 'E2E_SELL', against_kind: 'sale', amount: 3000,
        } });
        ck('settling it a second time is refused', twice.status === 400, twice.status + ' ' + JSON.stringify(twice.json));
        ck('  with a message, not a stack trace',
           /outstanding/i.test(String((twice.json || {}).error || '')), JSON.stringify(twice.json));

        // ── 5. AND IT COMES BACK OFF ─────────────────────────────────────
        const undo = await req('DELETE', '/api/payments/settle/' + d.settlement_id, { sid });
        ck('the delete route reverses it', undo.status === 200, undo.status + ' ' + JSON.stringify(undo.json));
        const back = await req('GET', '/api/payments/settle-options?load_id=E2E_BUY&load_kind=purchase', { sid });
        ck('  the purchase owes the full $5,000 again',
           (back.json || {}).outstanding === 5000, String((back.json || {}).outstanding));
        ck('  and his sale is back on offer',
           (((back.json || {}).options) || []).some((x) => x.id === 'E2E_SELL'),
           JSON.stringify((back.json || {}).options));

        // ── 6. STAFF CANNOT WRITE OFF WHAT A CUSTOMER OWES ───────────────
        // Not a new rule: '/api/payments' is absent from
        // STAFF_ALLOWED_PATH_PREFIXES and that check is a true prefix test.
        // Asserted anyway, because "it inherits the guard" is a claim about
        // code in another file that somebody will edit.
        const staffSid = ((await req('POST', '/login', { body: { password: process.env.STAFF_PASSWORD } })).json || {}).sid;
        if (staffSid) {
            const refused = await req('POST', '/api/payments/settle', { sid: staffSid, body: {
                load_id: 'E2E_BUY', load_kind: 'purchase',
                against_id: 'E2E_SELL', against_kind: 'sale', amount: 100,
            } });
            ck('a staff session is refused outright', refused.status === 403,
               refused.status + ' ' + JSON.stringify(refused.json));
            const refusedRead = await req('GET', '/api/payments/settle-options?load_id=E2E_BUY', { sid: staffSid });
            ck('  including the options list', refusedRead.status === 403, String(refusedRead.status));
        } else {
            ck('staff login worked, so the guard could be checked', false, 'no staff sid — section 6 proved nothing');
        }
    } finally {
        await new Promise((r) => server.close(r));
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
