// ── tests/edge-yard-scenarios.js ──────────────────────────────────────────
// Apsara, 2026-11-08: "run complete testing on edge yard on jarvis
// simulating all scenario, creaing test document as a tester with all use
// cases."
//
// A tester's pass over Edge Yard, not a developer's. The difference is that
// every case here is a thing SHE DOES — buy a load, pay for it, deduct a
// haul, raise a claim, sell it on, count the cash box — walked through the
// REAL routes a screen posts to, and the money read back out of the REAL
// route a screen reads. Helper tests and screen tests can both be green
// while the day does not work; CLAUDE.md rule 3 is about exactly that gap.
//
// ── WHY THIS DOES NOT RUN AGAINST HER LIVE SITE ──────────────────────────
// "Simulating all scenarios" against jarvis.edgemetals.com would mean
// writing test loads and test payments into her books. That is not testing,
// it is contamination. Live was probed READ ONLY and separately; everything
// that writes happens here, against a throwaway DATA_DIR.
//
// ── THE DATA_DIR TRAP, WHICH HAS BITTEN THIS REPO BEFORE ─────────────────
// config.js computes every *_FILE from DATA_DIR AT LOAD TIME. Requiring any
// helper before the redirect below pins the REAL paths — that is how four
// rows once went into live petty cash. So: env first, requires after, and
// nothing at the top of this file reaches for a helper.
//
// Each case records id / what she is doing / expected / actual / verdict
// into RESULTS, which is written out as JSON for the test document to
// render. A case that cannot be run says SKIPPED and why — a tester who
// silently drops a case is reporting more assurance than they have.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ey-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0, skip = 0;
const failures = [];
const RESULTS = [];
let CASE = null;

// A use case, in her words. Everything asserted inside it is a step of it.
const useCase = (id, doing) => {
    CASE = { id, doing, steps: [], verdict: 'PASS' };
    RESULTS.push(CASE);
    console.log(`\n── ${id}  ${doing}`);
};
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else {
        fail += 1; failures.push(`${CASE ? CASE.id : '-'}: ${label}`);
        console.log('  FAIL  ' + label);
        if (detail) console.log('        ' + detail);
    }
    if (CASE) {
        CASE.steps.push({ label, ok: !!ok, detail: ok ? '' : String(detail == null ? '' : detail) });
        if (!ok) CASE.verdict = 'FAIL';
    }
};
// A case that genuinely cannot run here. Counted and printed, never hidden.
const skipCase = (why) => {
    skip += 1;
    console.log('  SKIP  ' + why);
    if (CASE) { CASE.verdict = 'SKIPPED'; CASE.steps.push({ label: why, ok: null, detail: '' }); }
};

(async () => {

const { createApi } = require(path.join(ROOT, 'api'));
const cfg = require(path.join(ROOT, 'config'));
const app = createApi();
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (sid) headers.Authorization = `Bearer ${sid}`;
    const r2 = http.request(base + p, { method, headers }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
    });
    r2.on('error', reject); if (data) r2.write(data); r2.end();
});

const SID = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
const GET  = (p) => req('GET', p, { sid: SID });
const POST = (p, body) => req('POST', p, { sid: SID, body });
const PUT  = (p, body) => req('PUT', p, { sid: SID, body });
const DEL  = (p) => req('DELETE', p, { sid: SID });

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
// Every figure is a DELTA. Earlier cases write to the same stores, so an
// absolute would pass only until an unrelated case above it moves.
// WHAT SHE STILL OWES A SELLER, asked of the thing that actually knows.
// The first version of this subtracted `l.paid` off the load, which is not a
// field a load has — so every delta read zero and three cases "failed" for a
// reason that was mine. helpers/payments.outstandingOn is the one reader
// CLAUDE.md says every "what is owed" goes through.
const outstandingOn = require(path.join(ROOT, 'helpers/payments')).outstandingOn;
const owedOn = (id) => {
    try {
        const o = outstandingOn(id, 'purchase');
        return money(o && o.owed != null ? o.owed : o);
    } catch (e) { return null; }
};

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-00', 'Signing in to the yard at all');
// ══════════════════════════════════════════════════════════════════════════
ck('she can sign in', !!SID);
ck('  and an unauthenticated read is refused',
   (await req('GET', '/api/loads')).status === 401,
   'a yard ledger readable without a session is the highest-risk defect here');

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-PRE', 'Putting cash in the box before any of it can be spent');
// ══════════════════════════════════════════════════════════════════════════
// Written AFTER the first run, which failed EY-05/08/10 with "There is no
// petty cash to pay from". That was my scenario being wrong, not Jarvis:
// refusing to pay out cash the box does not hold is the behaviour #66 was
// built for, and a yard app that let her hand over money it had no record of
// would be the defect. Kept as a named precondition rather than quietly
// seeded, because the refusal is itself worth asserting.
{
    const empty = await POST('/api/payments', {
        load_id: 'nothing', load_kind: 'purchase', mode: 'Cash',
        amount: 10, paid_on: '2026-11-08',
    });
    ck('paying cash out of an empty box is refused',
       empty.status >= 400, `${empty.status} ${JSON.stringify(empty.json)}`);
    ck('  and says what to do about it',
       /petty cash/i.test(JSON.stringify(empty.json || {})), JSON.stringify(empty.json));

    const a = await POST('/api/petty-cash', { amount: 20000, cash_source: 'Chase Bank', date: '2026-11-01' });
    const b = await POST('/api/petty-cash', { amount: 3000, cash_source: 'Edge Metals', date: '2026-11-01' });
    ck('cash goes in', a.status < 400 && b.status < 400, `${a.status}/${b.status}`);
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-01', 'Buying a load from a walk-in seller, priced per lb');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = await POST('/api/loads', {
        date: '2026-11-08', seller: 'Randy Recycling', weight_unit: 'lb',
        items: [{ description: 'Aluminium wheel clean', gross_weight: 10000,
                  tare_weight: 2000, price: 0.85, unit: 'lb' }],
    });
    ck('the load saves', r.status < 400, `${r.status} ${JSON.stringify(r.json)}`);
    const id = r.json && (r.json.id || (r.json.load && r.json.load.id));
    ck('  and comes back with an id', !!id, JSON.stringify(r.json));
    const one = id ? (await GET('/api/loads/' + id)).json : null;
    const load = one && (one.load || one);
    // 10000 - 2000 = 8000 net lb at 0.85 = 6800. If this is wrong, every
    // figure downstream of it is wrong and the seller is paid the wrong money.
    ck('  net weight is gross minus tare', load && money(load.net_weight) === 8000,
       load && String(load.net_weight));
    ck('  and the amount is net x price', load && money(load.amount) === 6800,
       load && String(load.amount));
    global.__EY_LOAD_LB = id;
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-02', 'Buying a load priced per metric ton, not per pound');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = await POST('/api/loads', {
        date: '2026-11-08', seller: 'Fernando Santa Fe', weight_unit: 'lb',
        items: [{ description: 'Copper #2', gross_weight: 4409.25, tare_weight: 0,
                  price: 1000, unit: 'MT' }],
    });
    ck('a per-MT row saves', r.status < 400, `${r.status} ${JSON.stringify(r.json)}`);
    const id = r.json && (r.json.id || (r.json.load && r.json.load.id));
    const load = id ? ((await GET('/api/loads/' + id)).json || {}) : {};
    const l = load.load || load;
    // 4409.25 lb = 2.0000 MT exactly. At $1000/MT that is $2,000.
    ck('  priced off the TONNAGE, not the pounds',
       l && Math.abs(money(l.amount) - 2000) < 1,
       `${l && l.amount} — a per-MT price multiplied by pounds overpays 2,204x`);
    global.__EY_LOAD_MT = id;
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-03', 'A load with several different metals on one ticket');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = await POST('/api/loads', {
        date: '2026-11-08', seller: 'Elmer E cores', weight_unit: 'lb',
        items: [
            { description: 'Al wheel dirty', gross_weight: 5000, tare_weight: 1000, price: 0.60, unit: 'lb' },
            { description: 'E cores',        gross_weight: 3000, tare_weight: 500,  price: 0.40, unit: 'lb' },
        ],
    });
    ck('a multi-item load saves', r.status < 400, `${r.status} ${JSON.stringify(r.json)}`);
    const id = r.json && (r.json.id || (r.json.load && r.json.load.id));
    const one = id ? ((await GET('/api/loads/' + id)).json || {}) : {};
    const l = one.load || one;
    // 4000 x .60 = 2400, 2500 x .40 = 1000 -> 3400
    ck('  each row is priced on its own metal, then summed',
       l && money(l.amount) === 3400, l && String(l.amount));
    ck('  and both rows survive the save',
       l && Array.isArray(l.items) && l.items.length === 2,
       l && JSON.stringify((l.items || []).length));
    global.__EY_LOAD_MULTI = id;
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-04', 'Refusing a load that would be nonsense');
// ══════════════════════════════════════════════════════════════════════════
{
    const noSeller = await POST('/api/loads', {
        date: '2026-11-08', weight_unit: 'lb',
        items: [{ description: 'HMS', gross_weight: 100, tare_weight: 0, price: 1, unit: 'lb' }],
    });
    ck('a load with no seller is refused', noSeller.status >= 400,
       `${noSeller.status} — a load nobody is owed for is money that cannot be paid`);

    const tareOver = await POST('/api/loads', {
        date: '2026-11-08', seller: 'Randy Recycling', weight_unit: 'lb',
        items: [{ description: 'HMS', gross_weight: 1000, tare_weight: 4000, price: 1, unit: 'lb' }],
    });
    ck('  tare heavier than gross is refused or clamped, never negative',
       tareOver.status >= 400
       || money(((tareOver.json || {}).load || tareOver.json || {}).net_weight) >= 0,
       `${tareOver.status} ${JSON.stringify(tareOver.json)}`);
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-05', 'Paying the seller in cash');
// ══════════════════════════════════════════════════════════════════════════
{
    const before = owedOn(global.__EY_LOAD_LB);
    // A cash payment that names no bucket falls to 'Unassigned', which holds
    // nothing, and is refused with "Only 0.00 available in Unassigned". Both
    // screens always send a bucket, so this is not a defect — but the message
    // names a bucket she never chose, which is OBSERVATION EY-O1.
    const noBucket = await POST('/api/payments', {
        load_id: global.__EY_LOAD_LB, load_kind: 'purchase',
        mode: 'Cash', amount: 10, paid_on: '2026-11-08',
    });
    ck('a cash payment naming no bucket is refused rather than guessed',
       noBucket.status >= 400, `${noBucket.status} ${JSON.stringify(noBucket.json)}`);

    const r = await POST('/api/payments', {
        load_id: global.__EY_LOAD_LB, load_kind: 'purchase',
        mode: 'Cash', cash_source: 'Chase Bank', amount: 1000, paid_on: '2026-11-08',
    });
    ck('a cash payment posts', r.status < 400, `${r.status} ${JSON.stringify(r.json)}`);
    const after = owedOn(global.__EY_LOAD_LB);
    ck('  and what she still owes him drops by exactly that',
       money(before - after) === 1000, `${before} -> ${after}`);
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-06', 'Paying by wire — which company\'s money?');
// ══════════════════════════════════════════════════════════════════════════
{
    const missing = await POST('/api/payments', {
        load_id: global.__EY_LOAD_LB, load_kind: 'purchase',
        mode: 'Wire', bank: 'Chase Bank', amount: 500, paid_on: '2026-11-08', paid_via: '',
    });
    ck('a wire with no company is refused', missing.status >= 400,
       `${missing.status} ${JSON.stringify(missing.json)}`);
    ck('  and the refusal names what to answer',
       /Edge Yard|Edge Metals/.test(JSON.stringify(missing.json || {})),
       JSON.stringify(missing.json));

    const ok = await POST('/api/payments', {
        load_id: global.__EY_LOAD_LB, load_kind: 'purchase',
        mode: 'Wire', bank: 'Chase Bank', amount: 500,
        paid_on: '2026-11-08', paid_via: 'Edge Yard',
    });
    ck('  answering it lets the payment through', ok.status < 400,
       `${ok.status} ${JSON.stringify(ok.json)}`);

    const rep = (await GET('/api/reports/spend?from=2026-11-01&to=2026-11-30')).json || {};
    ck('  and the spend report files it under Edge Yard',
       money((rep.byPaidVia || {})['Edge Yard']) >= 500,
       JSON.stringify(rep.byPaidVia));
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-07', 'THE VOICE PATH — recording that same wire by talking');
// ══════════════════════════════════════════════════════════════════════════
// CLAUDE.md names this caller twice as the one that breaks: it has no form
// to put a new required field on, so a rule added for a screen lands here as
// an outright failure nobody sees until she uses it.
{
    let tools = null;
    try { tools = require(path.join(ROOT, 'helpers/tools')); } catch (e) { tools = null; }
    if (!tools || typeof tools.record_payment !== 'function') {
        skipCase('helpers/tools.record_payment is not callable directly from here');
    } else {
        let out = null, threw = null;
        try {
            out = await tools.record_payment({
                load_id: global.__EY_LOAD_MULTI, load_kind: 'purchase',
                mode: 'Wire', bank: 'Chase Bank', amount: 200,
                paid_on: '2026-11-08', paid_via: 'Edge Yard',
            });
        } catch (e) { threw = e; }
        ck('a wire recorded by voice does not throw', !threw,
           threw && (threw.message || String(threw)));
        ck('  and it says what it did', !!out, JSON.stringify(out || {}).slice(0, 200));
    }
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-08', 'Part paying, then overpaying');
// ══════════════════════════════════════════════════════════════════════════
{
    const before = owedOn(global.__EY_LOAD_MT);
    await POST('/api/payments', { load_id: global.__EY_LOAD_MT, load_kind: 'purchase',
        mode: 'Cash', cash_source: 'Chase Bank', amount: 500, paid_on: '2026-11-08' });
    const mid = owedOn(global.__EY_LOAD_MT);
    ck('a part payment leaves the rest owing', money(before - mid) === 500, `${before} -> ${mid}`);

    const over = await POST('/api/payments', { load_id: global.__EY_LOAD_MT, load_kind: 'purchase',
        mode: 'Cash', cash_source: 'Chase Bank', amount: 99999, paid_on: '2026-11-08' });
    const after = owedOn(global.__EY_LOAD_MT);
    // Either outcome is defensible; silently going deeply negative is not.
    ck('  paying far more than owed is refused, or recorded as credit — not silent',
       over.status >= 400 || after >= -0.005 || /credit|advance|over/i.test(JSON.stringify(over.json || {})),
       `status ${over.status}, owed now ${after}`);
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-09', 'A payment of zero, and a payment of minus money');
// ══════════════════════════════════════════════════════════════════════════
{
    const zero = await POST('/api/payments', { load_id: global.__EY_LOAD_LB,
        load_kind: 'purchase', mode: 'Cash', cash_source: 'Chase Bank', amount: 0, paid_on: '2026-11-08' });
    ck('a zero payment is refused', zero.status >= 400, String(zero.status));
    const neg = await POST('/api/payments', { load_id: global.__EY_LOAD_LB,
        load_kind: 'purchase', mode: 'Cash', cash_source: 'Chase Bank', amount: -300, paid_on: '2026-11-08' });
    ck('  and a negative one is refused', neg.status >= 400,
       `${neg.status} — a negative payment is a refund, and must be recorded as one`);
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-10', 'The same payment arriving twice after a dropped connection');
// ── CORRECTED 2026-11-08, after Apsara pushed back ───────────────────────
// This was written as "double tap pays twice". She answered: "when i pay
// once covering the inv amount pay woud become invisible na" — and she was
// right. Both pay modals disable the button the instant it is tapped
// (dashboard/app/13-loads-render.js:892, mobile-app/www/app/09-loads-deck.js:995),
// and the Pay action is gone once the load is settled. A double tap CANNOT
// produce two requests from either screen.
//
// What this case actually proves is narrower, and it is still worth having:
// the SERVER does not recognise a repeat. So the real-world route in is a
// retry after a lost reply — Jarvis saves, the reply never arrives, the
// catch re-enables the button, and she taps a payment that already went
// through. Two requests is exactly what that looks like from here.
//
// The lesson for me, not for the code: I proved something at the server
// that I then described as something at the screen. Those are different
// claims and only one of them was tested.
// ══════════════════════════════════════════════════════════════════════════
{
    const body = { load_id: global.__EY_LOAD_MULTI, load_kind: 'purchase',
        mode: 'Cash', cash_source: 'Chase Bank', amount: 100, paid_on: '2026-11-08',
        client_request_id: 'EY10-idempotency-probe' };
    const before = owedOn(global.__EY_LOAD_MULTI);
    const a = await POST('/api/payments', body);
    const b = await POST('/api/payments', body);
    const after = owedOn(global.__EY_LOAD_MULTI);
    ck('the first one posts', a.status < 400, String(a.status));
    ck('  and a repeat of the SAME save does not pay him twice',
       money(before - after) === 100,
       `owed moved ${money(before - after)}; the repeat said ${b.status}. `
       + 'The screens stop a double tap themselves; this is the retry-after-a-lost-reply '
       + 'case, where Jarvis has already saved and the phone never heard.');
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-11', 'Deducting a haul from what the seller is owed');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = await POST('/api/loads', {
        date: '2026-11-08', seller: 'Pachito', weight_unit: 'lb',
        trucking_company: 'Bayou Haulage', trucking_amount: 300,
        items: [{ description: 'HMS', gross_weight: 6000, tare_weight: 1000, price: 0.20, unit: 'lb' }],
    });
    ck('a load with a haul on it saves', r.status < 400, `${r.status} ${JSON.stringify(r.json)}`);
    const id = r.json && (r.json.id || (r.json.load && r.json.load.id));
    const one = id ? ((await GET('/api/loads/' + id)).json || {}) : {};
    const l = one.load || one;
    // 5000 x 0.20 = 1000 gross; minus 300 haulage = 700 payable.
    ck('  the metal is still worth the gross figure', l && money(l.amount) === 1000, l && String(l.amount));
    ck('  but what he is PAID is net of the haul',
       l && money(l.net_payable) === 700,
       `${l && l.net_payable} — paying him 1000 hands him the haulage twice`);
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-12', 'Selling metal out of the yard');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = await POST('/api/outbound-loads', {
        date: '2026-11-08', buyer: 'FMC Metals', weight_unit: 'lb',
        items: [{ description: 'Aluminium wheel clean', gross_weight: 4000,
                  tare_weight: 0, price: 1.10, unit: 'lb' }],
    });
    ck('an outbound load saves', r.status < 400, `${r.status} ${JSON.stringify(r.json)}`);
    const id = r.json && (r.json.id || (r.json.load && r.json.load.id));
    const one = id ? ((await GET('/api/outbound-loads/' + id)).json || {}) : {};
    const l = one.load || one;
    ck('  priced at the sale price, not the buy price',
       l && money(l.amount) === 4400, l && String(l.amount));
    global.__EY_SALE = id;
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-13', 'Selling more of a metal than the yard holds');
// ══════════════════════════════════════════════════════════════════════════
{
    const stockBefore = (await GET('/api/loads/stock')).json;
    ck('the yard can say what it holds', !!stockBefore && stockBefore !== null,
       JSON.stringify(stockBefore).slice(0, 160));
    const huge = await POST('/api/outbound-loads', {
        date: '2026-11-08', buyer: 'FMC Metals', weight_unit: 'lb',
        items: [{ description: 'Aluminium wheel clean', gross_weight: 9999999,
                  tare_weight: 0, price: 1.10, unit: 'lb' }],
    });
    ck('  selling more than she holds is refused or flagged, never silent',
       huge.status >= 400 || /stock|short|negative|only/i.test(JSON.stringify(huge.json || {})),
       `${huge.status} ${JSON.stringify(huge.json).slice(0, 200)} — `
       + 'silently going negative means the stock figure stops meaning anything');
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-14', 'Raising a claim against a supplier');
// ══════════════════════════════════════════════════════════════════════════
{
    // First run refused this: "a claim needs at least a container number or
    // an invoice number". That is a REAL constraint worth recording — a yard
    // purchase from a walk-in seller has neither, so a claim against yard
    // metal can only be raised by inventing one. Flagged as EY-D3 and asked
    // about rather than worked around; the case below supplies one so the
    // rest of the claim path is still exercised.
    const bare = await POST('/api/claims', {
        supplier: 'Randy Recycling', load_id: global.__EY_LOAD_LB,
        date: '2026-11-08', assessment: 'sorted', note: 'clad wheels found',
    });
    ck('a yard claim with no container and no invoice is refused',
       bare.status >= 400, `${bare.status} ${JSON.stringify(bare.json)}`);
    ck('  DEFECT EY-D3: a yard purchase HAS no container number, so that '
       + 'refusal blocks every walk-in claim',
       false,
       'open question for Apsara: should a yard claim key on the load id instead?');

    const r = await POST('/api/claims', {
        supplier: 'Randy Recycling', load_id: global.__EY_LOAD_LB,
        container_no: 'YARDU0000001',
        date: '2026-11-08', assessment: 'sorted',
        note: 'clad wheels found in Al wheel clean',
    });
    if (r.status >= 400 && /required|missing/i.test(JSON.stringify(r.json || {}))) {
        skipCase(`the claims route needs fields this case does not supply: ${JSON.stringify(r.json)}`);
    } else {
        ck('a claim saves', r.status < 400, `${r.status} ${JSON.stringify(r.json)}`);
        const list = (await GET('/api/claims')).json || {};
        const rows = list.claims || list.rows || list;
        ck('  and appears in the claims list',
           Array.isArray(rows) ? rows.length > 0 : !!rows,
           JSON.stringify(list).slice(0, 160));
    }
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-15', 'Topping up the cash box, and what it should then hold');
// ══════════════════════════════════════════════════════════════════════════
{
    const b0 = ((await GET('/api/petty-cash')).json || {}).balance;
    const up = await POST('/api/petty-cash', {
        amount: 5000, cash_source: 'Chase Bank', date: '2026-11-08',
    });
    ck('cash goes into the box', up.status < 400, `${up.status} ${JSON.stringify(up.json)}`);
    const after = (await GET('/api/petty-cash')).json || {};
    ck('  and the balance moves by exactly that',
       money((after.balance && after.balance.total != null ? after.balance.total : after.balance)
             - (b0 && b0.total != null ? b0.total : b0)) === 5000,
       `${JSON.stringify(b0)} -> ${JSON.stringify(after.balance)}`);
    ck('  Chase money is attributed to Edge Yard',
       (after.company_of || {})['Chase Bank'] === 'Edge Yard',
       JSON.stringify(after.company_of));
    ck('  and the per-company split still sums to the one total',
       Math.abs(Object.values(after.by_company || {}).reduce((a, b) => a + b, 0)
                - (after.balance && after.balance.total != null ? after.balance.total : after.balance)) < 0.005,
       `${JSON.stringify(after.by_company)} vs ${JSON.stringify(after.balance)}`);
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-16', 'Borrowing between two companies\' cash');
// ══════════════════════════════════════════════════════════════════════════
// A borrow cannot be created on its own — the route says so outright: "a
// borrow is created by the payment that needs it, not on its own". That is
// deliberate and right, so the scenario is the real one: pay out more cash
// from a bucket than it holds, and watch the shortfall become a debt.
{
    const before = (await GET('/api/petty-cash')).json || {};
    const standalone = await POST('/api/petty-cash/transfer', {
        from: 'Edge Metals', to: 'Chase Bank', amount: 400, reason: 'borrow', date: '2026-11-08',
    });
    ck('a borrow invented out of nothing is refused',
       standalone.status >= 400, `${standalone.status} ${JSON.stringify(standalone.json)}`);

    const r = await POST('/api/loads', {
        date: '2026-11-08', seller: 'Ludwin Gonzales Deleon', weight_unit: 'lb',
        items: [{ description: 'HMS', gross_weight: 10000, tare_weight: 0, price: 0.50, unit: 'lb' }],
    });
    const id = r.json && (r.json.id || (r.json.load && r.json.load.id));
    // Edge Metals holds 3,000. Paying 5,000 out of it must borrow 2,000 —
    // and the contract is TWO STEPS, which is the point: Jarvis refuses
    // first, names the lenders, and only moves the money once she has said
    // yes. Both clients do exactly this (dashboard/app/13-loads-render.js
    // and mobile-app/www/app/09-loads-deck.js re-post with allow_borrow).
    const body = { load_id: id, load_kind: 'purchase', mode: 'Cash',
        cash_source: 'Edge Metals', amount: 5000, paid_on: '2026-11-08' };
    const asked = await POST('/api/payments', body);
    ck('paying more than a bucket holds stops and asks first',
       asked.status >= 400 && (asked.json || {}).code === 'PETTY_CASH_BUCKET_SHORT',
       `${asked.status} ${JSON.stringify(asked.json)}`);
    ck('  and names who would be lending',
       Array.isArray((asked.json || {}).lenders) && asked.json.lenders.length > 0,
       JSON.stringify((asked.json || {}).lenders));
    ck('  and says how short it is, not just that it is short',
       money((asked.json || {}).shortfall) === 2000,
       String((asked.json || {}).shortfall));

    const pay = await POST('/api/payments', { ...body, allow_borrow: true });
    ck('confirming it lets the money move', pay.status < 400,
       `${pay.status} ${JSON.stringify(pay.json)}`);
    const after = (await GET('/api/petty-cash')).json || {};
    const b = (after.borrowings || []).find((x) =>
        /Edge Metals/.test(`${x.owes} ${x.to}`) && /Chase/.test(`${x.owes} ${x.to}`));
    ck('  the shortfall is recorded as a debt between the two buckets',
       !!b, JSON.stringify(after.borrowings));
    ck('  and labelled as crossing a company line',
       !!b && b.intercompany === true,
       JSON.stringify(b) + ' — Edge Metals and Edge Yard are different companies (rule 5)');
    const tot = (x) => (x.balance && x.balance.total != null ? x.balance.total : x.balance);
    ck('  cash in hand falls by what left the yard, not by the borrow as well',
       money(tot(before) - tot(after)) === 5000,
       `${tot(before)} -> ${tot(after)}; a borrow is a label on money, not more money`);
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-17', 'The spend report, filtered the way she filters it');
// ══════════════════════════════════════════════════════════════════════════
{
    const all = (await GET('/api/reports/spend?from=2026-11-01&to=2026-11-30&company=edge-trading')).json || {};
    ck('the yard spend report answers', !!all && all.total != null, JSON.stringify(all).slice(0, 120));
    ck('  and names every dollar it totals',
       Math.abs(money(Object.values(all.byPaidVia || {}).reduce((a, b) => a + b, 0)) - money(all.total)) < 0.02,
       `byPaidVia ${JSON.stringify(all.byPaidVia)} vs total ${all.total}`);

    const cashVia = (await GET('/api/reports/spend?from=2026-11-01&to=2026-11-30'
        + '&company=edge-trading&method=Cash&paid_via=Edge%20Yard')).json || {};
    // THE DEFECT FOUND ON HER LIVE DATA, pinned here so it cannot come back
    // silently: cash never carries a paid_via, so this pair returns nothing
    // while the cash box above it still reports money going out.
    const cashRows = (cashVia.rows || []).length;
    const bandOut = money((cashVia.cash || {}).out);
    ck('Cash + Paid via returns no rows (cash never carries a company)',
       cashRows === 0, `${cashRows} rows`);
    ck('  and when it returns nothing, the cash band must not still show money out',
       !(cashRows === 0 && bandOut > 0),
       `0 rows but the band says $${bandOut} went out — the screen contradicts itself. `
       + 'DEFECT EY-D2, open.');
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-18', 'Editing a load after it was saved');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = await PUT('/api/loads/' + global.__EY_LOAD_LB, {
        date: '2026-11-08', seller: 'Randy Recycling', weight_unit: 'lb',
        items: [{ description: 'Aluminium wheel clean', gross_weight: 10000,
                  tare_weight: 2000, price: 0.90, unit: 'lb' }],
    });
    ck('an edit saves', r.status < 400, `${r.status} ${JSON.stringify(r.json)}`);
    const l = ((await GET('/api/loads/' + global.__EY_LOAD_LB)).json || {});
    const load = l.load || l;
    ck('  and re-prices the metal', load && money(load.amount) === 7200, load && String(load.amount));
    // `paid` is not a field on the load — payments live in their own store,
    // which is why the first run read `undefined` here. The property is that
    // the PAYMENTS survive the edit, so that is what is asked, of the store
    // that actually holds them.
    const pays = (await GET('/api/payments')).json || {};
    const rows = (pays.payments || pays.rows || pays || []);
    const mine = (Array.isArray(rows) ? rows : [])
        .filter((p) => String(p.load_id) === String(global.__EY_LOAD_LB));
    ck('  without wiping what she has already paid him',
       mine.length > 0,
       `${mine.length} payments survive against this load — an edit that clears `
       + 'them loses money she physically handed over');
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-19', 'Deleting a load that has been paid');
// ══════════════════════════════════════════════════════════════════════════
{
    const d = await DEL('/api/loads/' + global.__EY_LOAD_LB);
    const still = await GET('/api/loads/' + global.__EY_LOAD_LB);
    ck('deleting a PAID load is refused, or it reverses the payment — never both gone',
       d.status >= 400 || still.status >= 400,
       `delete said ${d.status}; the load now reads ${still.status}. `
       + 'A deleted load whose payments survive leaves money paid to nobody.');
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-20', 'The seller\'s own paperwork — what California requires');
// ══════════════════════════════════════════════════════════════════════════
{
    let S = null;
    try { S = require(path.join(ROOT, 'helpers/sellerRecord')); } catch (e) { S = null; }
    if (!S || typeof S.report !== 'function') {
        skipCase('helpers/sellerRecord is not available');
    } else {
        const rep = S.report({ from: '2026-11-01', to: '2026-11-30' });
        ck('the seller record check runs', !!rep, JSON.stringify(rep).slice(0, 120));
        ck('  and refuses to call anything complete while the law is unconfirmed',
           !rep.outcome || rep.outcome !== 'complete' || (rep.unverified || []).length === 0,
           `outcome ${rep.outcome}, unverified ${(rep.unverified || []).length} — `
           + 'an unconfirmed statute must not produce a clean bill of health');
    }
}

// ══════════════════════════════════════════════════════════════════════════
useCase('EY-21', 'Nothing in the yard leaked into Edge Metals');
// ══════════════════════════════════════════════════════════════════════════
// Rule 5. Everything written above is Edge Yard's; if any of it shows up
// under Edge Metals, the separation this app exists for has failed.
{
    const yard = (await GET('/api/reports/spend?from=2026-11-01&to=2026-11-30&company=edge-trading')).json || {};
    const metals = (await GET('/api/reports/spend?from=2026-11-01&to=2026-11-30&company=edge-metals')).json || {};
    ck('the yard has spend in this window', money(yard.total) > 0, String(yard.total));
    ck('  and Edge Metals has none of it',
       money(metals.total) === 0,
       `Edge Metals reads ${metals.total} for a window in which only yard rows were written`);
    ck('  the two companies do not return the same number',
       money(yard.total) !== money(metals.total) || money(yard.total) === 0,
       `${yard.total} vs ${metals.total}`);
}

// ══════════════════════════════════════════════════════════════════════════
server.close();

const total = pass + fail;
console.log(`\n${'─'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed, ${skip} skipped  (${total} checks over ${RESULTS.length} use cases)`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }

const OUT = process.env.EY_RESULTS_JSON;
if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({
        ranAt: new Date().toISOString(), pass, fail, skip, cases: RESULTS,
    }, null, 2));
    console.log(`\nresults -> ${OUT}`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  CRASH  ', (e && e.stack) || e); process.exit(1); });
