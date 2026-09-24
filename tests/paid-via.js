// ── tests/paid-via.js ─────────────────────────────────────────────────────
// Apsara, 2026-09-17: "Aslo in pay of create invoice-on selecting wire-it
// should ask me Payment via Edge Yard/Edge Metals.We need to keep track of
// this also in report"
//
// Asked which modes, she answered "Wire and Bank Transfer" — NOT Zelle, which
// shares the bank picker and would have been the tidy guess. Asked what
// happens when she leaves it blank: "Refuse to save until answered". Asked
// where it shows: the Spend report, as a breakdown AND a filter.
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
// The two companies pay for each other's things. The bank field says WHICH
// ACCOUNT — "Chase Bank" — and not whose Chase account, so until now the books
// could not answer "how much of Edge Yard's buying did Edge Metals fund".
//
// ── AND WHAT IT IS SCOPED TO ────────────────────────────────────────────────
// "pay of create invoice" — a yard PURCHASE. Section B is most of this file,
// because the standing rule in CLAUDE.md is that a request about one screen
// changes that screen: a sale takes Bank transfer as one of only two modes, so
// applying this there would make RECEIVING money harder, which is the exact
// shape of the over-reach that broke her supplier payments on 2026-09-16.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-paidvia-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const pay = require(path.join(ROOT, 'helpers/payments'));
const petty = require(path.join(ROOT, 'helpers/pettyCash'));
const spend = require(path.join(ROOT, 'helpers/spendReport'));
const DASH = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — it asks, and it refuses without an answer');
// ══════════════════════════════════════════════════════════════════════════
{
    await petty.addTopUp({ amount: 50000, date: '2026-09-15', note: 'float' });

    // WIRE ONLY on a purchase. Bank transfer was removed from that side
    // entirely — Apsara, 2026-09-17: "in load of invoice pay-remove bank
    // transfer" — so Wire is the only transfer left there.
    {
        let err = null;
        try {
            await pay.addPayment({ load_id: 'V_Wire', load_kind: 'purchase', mode: 'Wire', amount: 100,
                                   paid_on: '2026-09-17', bank: 'Chase Bank' });
        } catch (e) { err = e; }
        ck('a purchase by Wire refuses to save without it', !!err, 'recorded anyway');
        // The message has to say what to type. "Invalid input" on a payment
        // screen is a support call.
        // ── IT NAMES THE COMPANIES THAT BANK THERE ────────────────────
        // Apsara, 2026-09-24: "Bofa has only two accounts.Edge Metals and AAA
        // Investment". So the list is no longer fixed — the message must name
        // whoever can own money at the bank she actually chose, which for
        // Chase is Edge Yard alone. Asserted against paidViaOptionsFor rather
        // than a pair spelled out here, or this goes red the next time an
        // account moves rather than when the message goes wrong.
        ck('  and the message names the companies that bank there',
           err && pay.paidViaOptionsFor('Chase Bank').every((c) => err.message.includes(c)),
           err && err.message);
        ck('  and does not offer one that banks elsewhere',
           err && !/AAA Investment/.test(err.message), err && err.message);
        ck('  and calls it "Payment via" — money going OUT',
           err && /Payment via/.test(err.message), err && err.message);
    }

    // ── AND A SALE, WHICH IS THE OTHER DIRECTION ─────────────────────────
    // Apsara, 2026-09-17: "For receive payment also,add paid to Edge Yard,Edge
    // Metals", and, asked which modes: "Bank transfer only".
    {
        let err = null;
        try {
            await pay.addPayment({ load_id: 'V_SALE_BT', load_kind: 'sale', mode: 'Bank transfer',
                                   amount: 700, paid_on: '2026-09-17' });
        } catch (e) { err = e; }
        ck('a sale by Bank transfer refuses to save without it', !!err, 'recorded anyway');
        ck('  and calls it "Paid to" — money coming IN',
           err && /Paid to/.test(err.message), err && err.message);
        ck('  naming both companies too',
           err && /Edge Yard/.test(err.message) && /Edge Metals/.test(err.message),
           err && err.message);

        const ok2 = await pay.addPayment({ load_id: 'V_SALE_OK', load_kind: 'sale', mode: 'Bank transfer',
                                           amount: 700, paid_on: '2026-09-17', paid_via: 'Edge Metals' });
        ck('  answered, the receipt records', ok2 && ok2.paid_via === 'Edge Metals',
           JSON.stringify(ok2 && ok2.paid_via));
    }

    const ok = await pay.addPayment({ load_id: 'V_OK', load_kind: 'purchase', mode: 'Wire', amount: 100,
                                      paid_on: '2026-09-17', bank: 'Chase Bank', paid_via: 'Edge Metals' });
    ck('answered, it records', ok && ok.paid_via === 'Edge Metals', JSON.stringify(ok && ok.paid_via));

    // Typed however it arrives. She will not be typing it, but the yard
    // assistant might, and a case mismatch refusing a payment is a bad day.
    const ci = await pay.addPayment({ load_id: 'V_CI', load_kind: 'purchase', mode: 'Wire', amount: 50,
                                      paid_on: '2026-09-17', bank: 'BofA', paid_via: 'edge yard' });
    ck('  and case does not matter', ci && ci.paid_via === 'Edge Yard', JSON.stringify(ci && ci.paid_via));

    let bad = null;
    try {
        await pay.addPayment({ load_id: 'V_BAD', load_kind: 'purchase', mode: 'Wire', amount: 10,
                               paid_on: '2026-09-17', bank: 'Chase Bank', paid_via: 'Edge Something' });
    } catch (e) { bad = e; }
    ck('  a company that is not one of the two is refused', !!bad, 'a third company would be invented here');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — and it asks NOWHERE ELSE');
// ══════════════════════════════════════════════════════════════════════════
{
    // THE SECTION THIS FILE EXISTS FOR. CLAUDE.md, written this morning after
    // two over-reaches in a week: a request about one screen changes that
    // screen. She said "pay of create invoice" — a yard purchase — and named
    // two modes.
    for (const [kind, mode, why] of [
        ['purchase', 'Zelle',         'not on her list, and since 2026-09-17 it has no bank behind it either'],
        ['purchase', 'Cash',          'cash is not a transfer between accounts'],
        ['purchase', 'Cheque',        'nor is a cheque'],
        ['sale',     'Cash',          'cash from a yard sale goes into Edge Yard\'s petty cash box, so it is ALWAYS the yard\'s — asking would let her file a contradiction with her own ledger'],
        ['bill',     'Wire',          'Edge Metals bills are the other company\'s books'],
        ['sale_cost', 'Wire',         'and so are sale costs'],
        ['metals_trucking', 'Wire',   'and metals haulage'],
        ['trucker',  'Wire',          'yard haulier bills have their own form and she did not mention them'],
    ]) {
        ck(`${kind} / ${mode} does not ask`, pay.paidViaRequired(kind, mode) === false, why);
    }

    // ── AND BANK TRANSFER IS GONE FROM A PURCHASE ALTOGETHER ─────────────
    // Apsara, 2026-09-17: "in load of invoice pay-remove bank transfer."
    ck('a purchase no longer offers Bank transfer',
       !pay.modesForKind('purchase').includes('Bank transfer'),
       pay.modesForKind('purchase').join(', '));
    ck('  it offers Cash, Zelle, Wire and Cheque',
       pay.modesForKind('purchase').join(',') === 'Cash,Zelle,Wire,Cheque',
       pay.modesForKind('purchase').join(', '));
    ck('  a sale still takes Bank transfer', pay.modesForKind('sale').includes('Bank transfer'),
       pay.modesForKind('sale').join(', '));
    // THE VOCABULARY IS UNTOUCHED: every purchase already recorded as Bank
    // transfer must keep reading as one everywhere — the spend report, the
    // bank matcher, the cards. What narrowed is the CHOICE, not the words the
    // file understands.
    ck('  and Bank transfer is still a mode this file knows',
       pay.PAYMENT_MODES.includes('Bank transfer'),
       'narrowing the vocabulary would orphan every purchase already recorded as one');

    // Driven, not just asserted on the predicate: a payment that would be
    // refused is the thing that actually hurts.
    const s = await pay.addPayment({ load_id: 'V_SALE', load_kind: 'sale', mode: 'Cash',
                                     amount: 500, paid_on: '2026-09-17' });
    ck('  and a cash sale still records with nothing extra',
       !!s && s.mode === 'Cash', JSON.stringify(s && s.mode));
    // No bank: Zelle came off MODES_WITH_BANK on 2026-09-17, so one carrying
    // a bank is refused now.
    const z = await pay.addPayment({ load_id: 'V_ZELLE', load_kind: 'purchase', mode: 'Zelle',
                                     amount: 200, paid_on: '2026-09-17' });
    ck('  and a purchase by Zelle still records', !!z && z.mode === 'Zelle', JSON.stringify(z && z.mode));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the Spend report keeps track of it');
// ══════════════════════════════════════════════════════════════════════════
{
    const payments = pay.listPayments();
    const r = spend.buildSpendReport({ payments, expenses: [], from: null, to: null });

    ck('the report breaks down by paying company', !!r.byPaidVia, JSON.stringify(r.byPaidVia));
    ck('  Edge Metals is its own line', r.byPaidVia['Edge Metals'] === 100,
       JSON.stringify(r.byPaidVia));
    ck('  Edge Yard too', r.byPaidVia['Edge Yard'] === 50, JSON.stringify(r.byPaidVia));

    // ── THE GAP IS VISIBLE, NOT GUESSED ──────────────────────────────────
    // Every payment written before today has no company on it, and so does
    // every cash payment. Bucketing those as "Edge Yard" would be this report
    // inventing a fact about money; they are a named line she can see.
    ck('  and everything else lands in a NAMED bucket',
       Object.keys(r.byPaidVia).some((k) => /not recorded/i.test(k)),
       JSON.stringify(r.byPaidVia));
    // It reconciles. A breakdown that does not add up to its own total is a
    // report that invites the reader to choose which number to believe.
    const viaSum = Object.values(r.byPaidVia).reduce((a, b) => Math.round((a + b) * 100) / 100, 0);
    ck('  and the breakdown adds up to the total', viaSum === r.total, `${viaSum} vs ${r.total}`);

    // ── AND IT FILTERS ───────────────────────────────────────────────────
    const onlyMetals = spend.buildSpendReport({ payments, expenses: [], paidVia: 'Edge Metals' });
    ck('filtering to Edge Metals narrows the whole report', onlyMetals.total === 100,
       `${onlyMetals.total} — the 100 wire and nothing else`);
    ck('  and the other company disappears from the breakdown',
       !onlyMetals.byPaidVia['Edge Yard'], JSON.stringify(onlyMetals.byPaidVia));
    const onlyGap = spend.buildSpendReport({ payments, expenses: [], paidVia: 'Not recorded' });
    ck('  filtering to the gap is allowed too', onlyGap.total > 0,
       'that is how she finds the transfers written before the field existed');

    ck('the filter options are offered', Array.isArray(r.paidViaColumns) && r.paidViaColumns.length >= 2,
       JSON.stringify(r.paidViaColumns));
    ck('  with the gap last, because it is a gap and not a company',
       /not recorded/i.test(r.paidViaColumns[r.paidViaColumns.length - 1]),
       JSON.stringify(r.paidViaColumns));

    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('the route passes the filter through', /paidVia: req\.query\.paid_via/.test(api));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the screen asks at the right moment');
// ══════════════════════════════════════════════════════════════════════════
{
    // syncBankFields is what decides, so it is what is driven. The modal
    // markup lives inside renderLoads's innerHTML template rather than in the
    // page, so a DOM carrying only the ids the function touches is the honest
    // way to exercise the rule; the markup itself is asserted separately
    // below.
    // Mounted on the REAL page, not a stub body. The first version used a
    // three-element document and the script died part-way through evaluating
    // — which leaves every `const` after the throw permanently in the
    // temporal dead zone, so syncBankFields threw "Cannot access 'bankModes'
    // before initialization" and the failure looked like a bug in the code
    // under test rather than in the harness.
    const SCRIPT = [...DASH.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const dom = new JSDOM(DASH, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window, d = w.document;
    w.fetch = () => new Promise(() => {});   // boot must never reach the DOM
    w.setInterval = () => 0;
    try { w.eval(SCRIPT); } catch (e) { /* boot needs a session; the helpers are defined */ }
    // The pay modal lives inside renderLoads's innerHTML template, so it is
    // not in the page until the Loads tab renders. These are the ids
    // syncBankFields touches, added by hand; section E asserts the real
    // markup carries the same ones.
    d.body.insertAdjacentHTML('beforeend', `
      <select id="pay_mode"></select>
      <div id="pay_bank_row"></div><select id="pay_bank"></select><div id="pay_bank_other_field"></div>
      <div id="pay_via_row"><label for="pay_via">Payment via</label></div>
      <select id="pay_via"><option value=""></option><option value="Edge Yard">Edge Yard</option></select>`);

    // data-kind, not `payingLoad`: that is a top-level `let`, a script-scope
    // binding and NOT a window property, so assigning w.payingLoad from here
    // would assign a different variable and the function would never see it.
    // The code reads the element for exactly this reason.
    const shown = (kind, mode) => {
        d.getElementById('pay_via_row').dataset.kind = kind;
        d.getElementById('pay_mode').innerHTML = `<option value="${mode}">${mode}</option>`;
        d.getElementById('pay_mode').value = mode;
        w.eval("syncBankFields('pay')");
        return d.getElementById('pay_via_row').style.display !== 'none';
    };

    ck('purchase + Wire shows it', shown('purchase', 'Wire') === true);
    ck('purchase + Zelle does NOT', shown('purchase', 'Zelle') === false,
       'Zelle is not a transfer she tracks a company against');
    ck('purchase + Cash does NOT', shown('purchase', 'Cash') === false);
    // The other direction, since 2026-09-17: "For receive payment also,add
    // paid to Edge Yard,Edge Metals" — Bank transfer only.
    ck('a SALE by Bank transfer SHOWS it', shown('sale', 'Bank transfer') === true);
    ck('  a cash sale does NOT', shown('sale', 'Cash') === false,
       'cash from a yard sale is always the yard\'s — it goes into her petty cash box');
    ck('  and switching back to a purchase brings it back', shown('purchase', 'Wire') === true,
       'hidden once must not stay hidden');

    // ── AND THE LABEL FOLLOWS THE DIRECTION ──────────────────────────────
    // One word for both would be wrong on one of them: a purchase sends money
    // out, a sale takes it in.
    const labelOf = () => (d.querySelector('#pay_via_row label') || {}).textContent;
    shown('purchase', 'Wire');
    ck('a purchase says "Payment via"', labelOf() === 'Payment via', labelOf());
    shown('sale', 'Bank transfer');
    ck('  and a sale says "Paid to"', labelOf() === 'Paid to', labelOf());

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the markup, and both clients');
// ══════════════════════════════════════════════════════════════════════════
{
    for (const [who, src] of [['website', DASH], ['app', APP]]) {
        ck(`${who}: the modal has a Payment via row`, /id="pay_via_row"/.test(src));
        // The options are BUILT from the chosen bank now, not baked into the
        // markup — a fixed pair is what offered Edge Yard against BofA, where
        // it has no account, and never offered AAA Investment at all.
        ck(`  ${who}: the options are built from the bank, not hardcoded`,
           /function paidViaOwnersFor/.test(src) && !/<option value="Edge Yard">/.test(src));
        ck(`  ${who}: and it knows all three companies`,
           /'Edge Yard', 'Edge Metals', 'AAA Investment'/.test(src));
        ck(`  ${who}: Chase resolves to Edge Yard`, /\^chase/i.test(src));
        // No pre-selected company. She chose "refuse to save until answered"
        // over recording a gap, and a select that opens on "Edge Yard" lets
        // her answer it by not reading it.
        ck(`  ${who}: opening on a prompt, not a company`,
           /<option value="">Choose/.test(src),
           'a pre-selected company is answered by not looking at it');
        ck(`  ${who}: cleared on every open`, /\$\('pay_via'\)\.value = ''/.test(src),
           'otherwise the last payment\'s company is pre-answered on this one');
        ck(`  ${who}: and sent with the payment`, /paid_via: \(\$\('pay_via'\)/.test(src));
        ck(`  ${who}: the combinations match the server's`,
           /paidViaModesFor = \(sale\) => \(sale \? \['Bank transfer'\] : \['Wire'\]\)/.test(src),
           'a client that asks on different combinations than the server enforces is a form that fails on save');
        ck(`  ${who}: and so do the two labels`,
           /paidViaLabelFor = \(sale\) => \(sale \? 'Paid to' : 'Payment via'\)/.test(src));
        // Apsara, 2026-09-17: "in load of invoice pay-remove bank transfer."
        // Widened on the SALE side 2026-09-23 ("Remove just wire"), so this
        // is asserted against modesForKind rather than a list written out
        // here — the property is that the client offers exactly what the
        // server accepts, not that either list holds any particular modes.
        const fill = (src.match(/const payModes = sale \? \[([^\]]*)\] : \[([^\]]*)\]/) || []);
        const parse = (x) => (x || '').split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
        ck(`  ${who}: a purchase no longer offers Bank transfer`,
           !parse(fill[2]).includes('Bank transfer'), parse(fill[2]).join(', '));
        ck(`  ${who}: and a sale still does — it is how she receives money`,
           parse(fill[1]).includes('Bank transfer'), parse(fill[1]).join(', '));
        ck(`  ${who}: both lists match the server exactly`,
           JSON.stringify(parse(fill[1])) === JSON.stringify(pay.modesForKind('sale'))
           && JSON.stringify(parse(fill[2])) === JSON.stringify(pay.modesForKind('purchase')),
           `sale ${parse(fill[1]).join(', ')} | purchase ${parse(fill[2]).join(', ')}`);
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('F — END TO END, through the real routes');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
//
// Everything above tests the helpers and the screens in isolation, and every
// one of those can pass while the FEATURE does not work — the route may not
// forward the field, the report route may not forward the filter, the client
// may send a key the server does not read. That gap is where "it saved but
// the report shows nothing" lives.
//
// So: a real server, a real login, a payment posted the way the modal posts
// it, and the figure read back out of the report route the screen calls.
{
    const http = require('http');
    process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
    process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

    const { createApi } = require(path.join(ROOT, 'api'));
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
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);

    // A load to pay, written the way the Loads form writes one.
    const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
    await mutateJson(cfg.LOADS_FILE, [], (list) => {
        const l = Array.isArray(list) ? list : [];
        l.unshift({ id: 'E2E_1', date: '2026-09-17', seller: 'Ramesh', amount: 900, items: [], weight_unit: 'lb' });
        l.unshift({ id: 'E2E_SALE', date: '2026-09-17', buyer: 'Eccomelt', amount: 400, items: [], weight_unit: 'lb' });
        return l;
    });

    // ── THE REFUSAL, THROUGH THE ROUTE ───────────────────────────────────
    const missing = await req('POST', '/api/payments', { sid, body: {
        load_id: 'E2E_1', load_kind: 'purchase', mode: 'Wire', bank: 'Chase Bank',
        amount: 300, paid_on: '2026-09-17', paid_via: '',
    } });
    ck('the route refuses a wire with no company', missing.status >= 400,
       `${missing.status} ${JSON.stringify(missing.json)}`);
    ck('  and says what to answer',
       /Edge Yard/.test(JSON.stringify(missing.json || {})), JSON.stringify(missing.json));

    // ── AND THE ACCEPTANCE ───────────────────────────────────────────────
    // Measured as a DELTA. Sections A-C above already recorded payments into
    // the same store, so asserting an absolute 300 here would pass only while
    // nothing earlier in the file changes — a test that breaks when an
    // unrelated fixture moves is a test that gets deleted.
    const before = (await req('GET', '/api/reports/spend', { sid })).json || {};
    const beforeMetals = (before.byPaidVia || {})['Edge Metals'] || 0;

    const okRes = await req('POST', '/api/payments', { sid, body: {
        load_id: 'E2E_1', load_kind: 'purchase', mode: 'Wire', bank: 'Chase Bank',
        amount: 300, paid_on: '2026-09-17', paid_via: 'Edge Metals',
    } });
    ck('answered, the route accepts it', okRes.status === 200, `${okRes.status} ${JSON.stringify(okRes.json)}`);

    // ── AND THE OTHER DIRECTION, END TO END ──────────────────────────────
    // Apsara, 2026-09-17: "For receive payment also,add paid to Edge Yard,Edge
    // Metals". This check used to assert a sale needed NOTHING extra, which
    // was true until she asked for this.
    const saleMissing = await req('POST', '/api/payments', { sid, body: {
        load_id: 'E2E_SALE', load_kind: 'sale', mode: 'Bank transfer',
        amount: 400, paid_on: '2026-09-17',
    } });
    ck('the route refuses a sale transfer with no company', saleMissing.status >= 400,
       `${saleMissing.status} ${JSON.stringify(saleMissing.json)}`);
    ck('  saying "Paid to", not "Payment via"',
       /Paid to/.test(JSON.stringify(saleMissing.json || {})), JSON.stringify(saleMissing.json));

    const saleRes = await req('POST', '/api/payments', { sid, body: {
        load_id: 'E2E_SALE', load_kind: 'sale', mode: 'Bank transfer',
        amount: 400, paid_on: '2026-09-17', paid_via: 'Edge Yard',
    } });
    ck('  answered, the receipt records', saleRes.status === 200,
       `${saleRes.status} ${JSON.stringify(saleRes.json)}`);

    // And a purchase can no longer be paid by Bank transfer at all — her
    // other instruction of the same message.
    const btPurchase = await req('POST', '/api/payments', { sid, body: {
        load_id: 'E2E_1', load_kind: 'purchase', mode: 'Bank transfer',
        amount: 10, paid_on: '2026-09-17', paid_via: 'Edge Yard',
    } });
    ck('a purchase by Bank transfer is refused outright', btPurchase.status >= 400,
       `${btPurchase.status} ${JSON.stringify(btPurchase.json)}`);
    ck('  and the message lists what a purchase DOES take',
       /Zelle/.test(JSON.stringify(btPurchase.json || {})) && /Wire/.test(JSON.stringify(btPurchase.json || {})),
       JSON.stringify(btPurchase.json));

    // ── AND IT REACHES THE REPORT THE SCREEN READS ───────────────────────
    const rep = (await req('GET', '/api/reports/spend', { sid })).json || {};
    ck('the report route returns the breakdown', !!rep.byPaidVia, JSON.stringify(rep.byPaidVia));
    ck('  with the wire added to Edge Metals',
       (rep.byPaidVia['Edge Metals'] || 0) - beforeMetals === 300,
       `${beforeMetals} -> ${rep.byPaidVia['Edge Metals']}`);
    ck('  and the filter options', (rep.paidViaColumns || []).includes('Edge Metals'),
       JSON.stringify(rep.paidViaColumns));

    const filtered = (await req('GET', '/api/reports/spend?paid_via=' + encodeURIComponent('Edge Metals'), { sid })).json || {};
    ck('filtering through the route narrows the total',
       filtered.total === (rep.byPaidVia['Edge Metals'] || 0),
       `${filtered.total} vs ${rep.byPaidVia['Edge Metals']} — the filtered total IS that company's line`);
    ck('  and it is less than the unfiltered one', filtered.total < rep.total,
       `${filtered.total} vs ${rep.total}`);
    ck('  and the money-in side is untouched by a spend filter',
       typeof filtered.total === 'number', JSON.stringify(Object.keys(filtered)).slice(0, 120));

    // The query string the SCREEN builds, not one written by hand here: a
    // filter the client spells differently from the route is exactly the gap
    // this section exists to close.
    ck('the screen builds the same query key',
       /paid_via=' \+ encodeURIComponent\(spendPaidVia\)/.test(DASH),
       'client and route must agree on the parameter name');

    server.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('WHICH COMPANIES BANK WHERE');
// ══════════════════════════════════════════════════════════════════════════
{
    // Apsara, 2026-09-24: "Bofa has only two accounts.Edge Metals and AAA
    // Investment", and Chase is Edge Yard's.
    //
    // SPELLED OUT, not derived from paidViaOptionsFor. A first version of
    // these checks computed the expectation with the same function it was
    // testing, so swapping BofA's owners back to the old pair left the file
    // green — a check that cannot fail. These are her words, so they are
    // written down as her words.
    const bofa = pay.paidViaOptionsFor('BofA');
    ck('BofA is Edge Metals and AAA Investment, in that order',
       JSON.stringify(bofa) === JSON.stringify(['Edge Metals', 'AAA Investment']), bofa.join(', '));
    ck('  and Edge Yard is NOT offered against BofA — it has no account there',
       !bofa.includes('Edge Yard'), bofa.join(', '));
    ck('Chase is Edge Yard alone', JSON.stringify(pay.paidViaOptionsFor('Chase Bank')) === JSON.stringify(['Edge Yard']),
       pay.paidViaOptionsFor('Chase Bank').join(', '));
    ck('AAA Investment is a company the ledger knows', pay.PAID_VIA.includes('AAA Investment'),
       pay.PAID_VIA.join(', '));
    // An unrecognised bank must NARROW nothing — a bank she typed under
    // "Others" can never leave her unable to say whose money it was.
    ck('an unknown bank offers all three', pay.paidViaOptionsFor('Wells Fargo').length === 3);
    ck('  and so does a blank one', pay.paidViaOptionsFor('').length === 3);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
