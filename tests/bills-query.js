// ── tests/bills-query.js ────────────────────────────────────────────────────
// Apsara, 2026-09-19: "also like in qb,it should allow jarvis to modify
// everything as per command.if i say show me unfilled bills-it should show".
//
// This is the READ half. Before it, Jarvis could find SALES and could not find
// BILLS at all — her question had nothing to call, so it could only ever be
// answered with a shrug.
//
// ── THE BOUNDARY THIS NEARLY BROKE ──────────────────────────────────────────
// The obvious place to put a bills tool is helpers/tools.js, where find_sales
// and find_loads live. That file is SCOUT — the yard assistant, fenced to Edge
// Yard on purpose — and it opens with a long note about a bookings tool that
// was added there and removed the same day, predicting the exact reasoning
// that would put another one back: "it cannot answer about X, so give it an X
// tool." Purchase bills are EDGE METALS. Section D is that boundary, asserted
// rather than remembered.
//
// ── AND ONE DEFINITION OF "UNFILLED" ────────────────────────────────────────
// It lives in helpers/bills.js's filterRows, which the ledger screen, the
// export and the assistant all call. Three answers to "which bills are
// unfinished" would eventually disagree, and she would be the one to find out.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-billsq-'));
process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-iiiiiiiiiii';

const ROOT = path.join(__dirname, '..');
const bills = require(path.join(ROOT, 'helpers/bills'));

(async () => {

// A finished bill, one waiting on the weighbridge, one waiting on the
// supplier's invoice, and one barely started. Her words for why they arrive
// separately are in bills.js: the weighbridge ticket, the supplier invoice and
// the trucker's number turn up on different days.
const DONE = await bills.addBill({ date: '09/10/2026', supplier: 'Gomez', container_no: 'AAAU1111111',
    booking_no: 'DALA89635900', gross: 79520, truck: 16300, container: 8510, chassis: 6600,
    supplier_price: 0.82, price_unit: 'lb' });
const NO_WEIGHTS = await bills.addBill({ date: '09/11/2026', supplier: 'Aussins', container_no: 'BBBU2222222',
    supplier_price: 850, price_unit: 'mt' });
const NO_PRICE = await bills.addBill({ date: '09/12/2026', supplier: 'Calderon', container_no: 'CCCU3333333',
    gross: 60000, truck: 15000 });
const BARELY = await bills.addBill({ supplier: 'Gomez' });

// ── A. WHAT "UNFILLED" MEANS ────────────────────────────────────────────────
section('A. what is still missing');
{
    ck('a finished bill is missing nothing', bills.missingFor(DONE).length === 0,
       bills.missingFor(DONE).join(', '));
    ck('one with no weighbridge ticket is waiting on weights',
       bills.missingFor(NO_WEIGHTS).join(',') === 'weights', bills.missingFor(NO_WEIGHTS).join(','));
    ck('one with no supplier invoice is waiting on price',
       bills.missingFor(NO_PRICE).join(',') === 'price', bills.missingFor(NO_PRICE).join(','));
    ck('and a barely-started one says all of it',
       bills.missingFor(BARELY).join(',') === 'date,container no,weights,price',
       bills.missingFor(BARELY).join(','));

    // ── EITHER A PRICE OR AN AMOUNT IS ENOUGH ───────────────────────────
    // She prices most containers per pound and occasionally agrees a flat
    // figure. Demanding both would mark finished bills as unfinished, and a
    // list of "unfilled" bills that are actually finished is a list she stops
    // opening.
    // supplier_invoice_amount is the WRITABLE field; `amount` is derived and
    // is silently dropped by addBill. Passing `amount` here made this check
    // fail for the right reason and found the bug in missingFor.
    const flat = await bills.addBill({ date: '09/13/2026', supplier: 'Gomez', container_no: 'DDDU4444444',
        gross: 50000, truck: 14000, supplier_invoice_amount: 12000 });
    ck('  (the fixture really did store it)', flat.supplier_invoice_amount == 12000,
       JSON.stringify(flat.supplier_invoice_amount));
    ck('a flat agreed amount counts as priced', bills.missingFor(flat).length === 0,
       bills.missingFor(flat).join(','));

    // ── AND `incomplete` IS UNTOUCHED ───────────────────────────────────
    // It drives the "◦ still needs" marker on the ledger row and means
    // something narrower on purpose. Widening it would have changed a marker
    // on every row of a screen she reads daily — not what she asked for.
    ck('the ledger row marker still means only date and supplier',
       JSON.stringify(bills.compute(NO_WEIGHTS).incomplete) === '[]',
       JSON.stringify(bills.compute(NO_WEIGHTS).incomplete));
    ck('  and still fires when they ARE missing',
       bills.compute({ supplier: 'Gomez' }).incomplete.join(',') === 'date');
}

// ── B. THE FILTER EVERYTHING SHARES ─────────────────────────────────────────
section('B. one filter, three callers');
{
    const all = bills.listWithTotals();
    ck('no filter is not a filter', bills.filterRows(all, {}).length === all.length);
    ck('unfilled narrows to the unfinished ones',
       bills.filterRows(all, { unfilled: '1' }).length === 3,
       String(bills.filterRows(all, { unfilled: '1' }).length));
    ck('  and never to the finished ones',
       !bills.filterRows(all, { unfilled: '1' }).some((r) => bills.missingFor(r).length === 0));

    // ── ABSENT AND FALSE ARE NOT "ONLY THE FINISHED ONES" ───────────────
    // The shape of bug that would quietly hide most of her ledger.
    ck('unfilled=false is not a filter either',
       bills.filterRows(all, { unfilled: 'false' }).length === all.length,
       String(bills.filterRows(all, { unfilled: 'false' }).length));
    ck('  nor is an empty string', bills.filterRows(all, { unfilled: '' }).length === all.length);

    // Combined with the filters that were already there.
    ck('unfilled narrows WITH a supplier, not instead of one',
       bills.filterRows(all, { unfilled: '1', supplier: 'Gomez' }).length === 1,
       String(bills.filterRows(all, { unfilled: '1', supplier: 'Gomez' }).length));

    // ── UNPAID ──────────────────────────────────────────────────────────
    const unpaid = bills.filterRows(all, { unpaid: '1' });
    ck('unpaid finds bills with something owing', unpaid.length > 0, String(unpaid.length));
    ck('  and every one of them really does owe',
       unpaid.every((r) => r.balance === undefined || r.balance === null || Number(r.balance) > 0.005));

    // A row with no computed balance is not evidence of anything. Keeping it
    // is the safe reading; claiming it is paid is not.
    ck('a row with no balance is kept rather than claimed as paid',
       bills.filterRows([{ supplier: 'X' }], { unpaid: '1' }).length === 1);
}

// ── C. THE ROUTE THE SCREEN USES ────────────────────────────────────────────
// The filter has to survive the trip through the query string, or the ledger
// screen and the export cannot offer it however right the helper is.
section('C. through /api/bills');
{
    const http = require('http');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;
    const call = (method, p2, body) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (global.__sid) headers.Authorization = `Bearer ${global.__sid}`;
        const r2 = http.request(base + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    global.__sid = ((await call('POST', '/login', { password: 'admin-pw-iiiiiiiiiii' })).json || {}).sid;
    ck('logged in', !!global.__sid);

    const every = await call('GET', '/api/bills');
    const narrowed = await call('GET', '/api/bills?unfilled=1');
    ck('the route accepts unfilled', narrowed.status === 200 && narrowed.json.bills.length === 3,
       `${narrowed.status} ${narrowed.json && narrowed.json.bills && narrowed.json.bills.length}`);
    ck('  and it really narrows', narrowed.json.bills.length < every.json.bills.length,
       `${narrowed.json.bills.length} of ${every.json.bills.length}`);
    // The totals must describe the rows returned, which is the rule the route
    // already states for every other filter.
    ck('  with totals for the narrowed rows only',
       narrowed.json.summary.net_lb !== every.json.summary.net_lb,
       'the summary would describe a different set of bills than the list beside it');

    listener.close();
}

// ── D. THE ASSISTANT BOUNDARY ───────────────────────────────────────────────
// Edge Yard and Edge Metals are different companies, and helpers/tools.js is
// the YARD assistant. This is the check that stops the next bills tool landing
// there — including one written by me in six months having forgotten.
section('D. bills belong to Jarvis, not to Scout');
{
    const scout = fs.readFileSync(path.join(ROOT, 'helpers/tools.js'), 'utf8');
    ck('Scout has no bills tool', !/find_bills|bills_query/.test(scout),
       'the yard assistant would be answering about the metals ledger');
    ck('  and still cannot reach helpers/bills.js', !/require\(['"]\.\/bills['"]\)/.test(scout),
       'a tool is not the only way a boundary dissolves');

    const brain = fs.readFileSync(path.join(ROOT, 'workflow/brain.js'), 'utf8');
    ck('Jarvis has the intent', /case 'bills_query'/.test(brain));
    ck('  the classifier is told it exists', /bills_query, get_quote/.test(brain),
       'an intent the model is never offered is an intent it cannot choose');
    ck('  and is allowed to choose it', /'bills_query', 'get_quote'/.test(brain),
       'an intent not on the allowlist is discarded after the model picks it');
    ck('  with "unfilled" described in her own words',
       /not filled in, missing something/.test(brain), 'the model has to recognise the phrasing she uses');

    // ── IT READS. IT DOES NOT WRITE. ────────────────────────────────────
    // She asked for "modify everything as per command" too. That half is NOT
    // here, and the handler must not grow into it by accident: every write in
    // this codebase goes through a confirm card, and a spoken instruction
    // that rewrites a bill with no confirmation is the 2026-09-17 failure
    // with worse consequences.
    const handler = brain.slice(brain.indexOf("case 'bills_query'"), brain.indexOf("case 'empty_drop_confirmed'"));
    ck('the bills handler only reads', !/addBill|editBill|deleteBill|mutateJson/.test(handler),
       'a spoken command that edits a bill must go through a confirm card first');
}

// ── E. WHAT IT SAYS BACK ────────────────────────────────────────────────────
// A count she then has to go and look up is not an answer to "show me".
section('E. the reply names the gap');
{
    const brain = fs.readFileSync(path.join(ROOT, 'workflow/brain.js'), 'utf8');
    const handler = brain.slice(brain.indexOf("case 'bills_query'"), brain.indexOf("case 'empty_drop_confirmed'"));
    ck('each line says what that bill still needs', /needs \$\{miss\.join/.test(handler),
       '"12 unfilled bills" is a number she then has to go and look up');
    ck('  the list is capped', /SHOW = 15/.test(handler));
    ck('  and the cap is STATED',
       /and \$\{rows\.length - SHOW\} more/.test(handler),
       'a truncated list presented as the whole is how a confident wrong total gets spoken aloud');
    ck('  an empty result says so plainly', /No \$\{label\}/.test(handler));
    ck('  and it sorts newest first', /sortableDate\(b2\.date\)/.test(handler));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
