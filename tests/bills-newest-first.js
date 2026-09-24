// ── tests/bills-newest-first.js ───────────────────────────────────────────
// Apsara, 2026-09-25: "Also latest bill should come at the top".
//
// ── THE POINT OF THIS FILE IS THE BLAST RADIUS, NOT THE SORT ──────────────
// Sorting is four lines. The reason it needed a test file is that the obvious
// place to put it — helpers/bills.js's list() or listWithTotals() — is read
// by THIRTY-THREE callers, and at least one of them decides money by
// position:
//
//     helpers/saleInvoiceFlow.js
//     billByContainer(c) -> bills.listWithTotals().find(b => cont(b.container_no) === c)
//
// The FIRST match wins. Reverse the order underneath it and a container with
// two bills starts building its invoice from the other one — a different
// supplier at a different price, on a document that goes to a customer.
// Nobody would see it until the invoice was wrong.
//
// So the order belongs to the TABLE and only the table. Section C is the
// section that matters: it proves the shared list is untouched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-billsort-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const bills = require(path.join(ROOT, 'helpers/bills'));

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — newest first, undated last');
// ══════════════════════════════════════════════════════════════════════════
{
    const rows = [
        { id: 'A', date: '2026-01-05' },
        { id: 'B', date: '2026-09-20' },
        { id: 'C', date: '' },
        { id: 'D', date: '2026-09-20' },
        { id: 'E', date: '2025-11-30' },
    ];
    const got = bills.newestFirst(rows).map((r) => r.id).join('');
    ck('the latest bill is at the top', got[0] === 'B', got);
    ck('  the order is newest to oldest', got.startsWith('BDA'), got);
    // A bill with no date is INCOMPLETE, not new. An empty string compares
    // low, so the naive sort puts her half-typed rows exactly where she is
    // looking for her most recent ones.
    ck('an undated bill sinks to the bottom, not the top', got.endsWith('C'), got);
    ck('  and the 2025 row sits above it', got === 'BDAEC', got);

    // Two bills on the same day keep the order they were entered — a table
    // that reshuffles rows it has no reason to reshuffle is one she cannot
    // keep her place in.
    ck('same-day bills keep their entry order', got.indexOf('B') < got.indexOf('D'), got);

    // It must not mutate what it was handed: `all` is used for facets and
    // summary after this runs.
    ck('the input array is left alone', rows.map((r) => r.id).join('') === 'ABCDE');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — edges');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('empty is empty', bills.newestFirst([]).length === 0);
    ck('null is not a crash', bills.newestFirst(null).length === 0);
    ck('every row undated keeps file order',
       bills.newestFirst([{ id: 'X' }, { id: 'Y' }]).map((r) => r.id).join('') === 'XY');
    // Dates are ISO text in this store, so string compare IS date compare —
    // but a year boundary is where a sloppy comparator shows up.
    ck('across a year boundary',
       bills.newestFirst([{ id: 'old', date: '2025-12-31' }, { id: 'new', date: '2026-01-01' }])
            .map((r) => r.id).join('') === 'newold');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — THE SHARED LIST IS UNTOUCHED');
// ══════════════════════════════════════════════════════════════════════════
// The whole reason this is in the route and not in the helper.
{
    const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
    await mutateJson(cfg.BILLS_FILE, [], () => ([
        { id: 'OLD', date: '2025-06-01', supplier: 'Fede', container_no: 'AAAU1111111',
          gross: 60000, truck: 14000, container: 5000, supplier_price: 0.32 },
        { id: 'NEW', date: '2026-09-20', supplier: 'Gomez', container_no: 'AAAU1111111',
          gross: 60000, truck: 14000, container: 5000, supplier_price: 0.40 },
    ]));

    const raw = bills.list().map((r) => r.id).join(',');
    ck('list() still returns file order', raw === 'OLD,NEW', raw);
    const wt = bills.listWithTotals().map((r) => r.id).join(',');
    ck('listWithTotals() still returns file order', wt === 'OLD,NEW', wt);

    // The caller that decides money by position. Both bills are on the SAME
    // container, so .find() picks whichever the list puts first.
    const flow = require(path.join(ROOT, 'helpers/saleInvoiceFlow'));
    if (typeof flow.billByContainer === 'function') {
        const picked = flow.billByContainer('AAAU1111111');
        ck('billByContainer still picks the bill it always picked',
           picked && picked.id === 'OLD',
           picked ? `${picked.id} (${picked.supplier} @ ${picked.supplier_price})` : 'null');
        ck('  which is the one whose supplier the invoice is built from',
           picked && picked.supplier === 'Fede', picked && picked.supplier);
    } else {
        ck('saleInvoiceFlow.billByContainer exists to be checked', false,
           'the guard this file exists for cannot run');
    }

    // And the sorted view is genuinely a different order, or section C proves
    // nothing — two lists that happen to match cannot show independence.
    const sorted = bills.newestFirst(bills.listWithTotals()).map((r) => r.id).join(',');
    ck('the TABLE view is the reverse of the stored order', sorted === 'NEW,OLD', sorted);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — END TO END, through GET /api/bills');
// ══════════════════════════════════════════════════════════════════════════
// CLAUDE.md rule 3. The helper can sort correctly while the route never calls
// it, which is a green test and an unchanged screen.
{
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

    const r = await req('GET', '/api/bills', { sid });
    ck('the bills route answers', r.status === 200, String(r.status));
    const ids = ((r.json && r.json.bills) || []).map((b) => b.id);
    ck('the newest bill is the first row on screen', ids[0] === 'NEW', ids.join(','));
    ck('  and the older one is below it', ids.join(',') === 'NEW,OLD', ids.join(','));

    // The summary must still be over the SAME rows — sorting is not filtering.
    const sum = (r.json && r.json.summary) || {};
    ck('the summary still covers every row',
       (r.json.total_unfiltered === 2) && ids.length === 2,
       `${r.json.total_unfiltered} unfiltered / ${ids.length} shown`);
    ck('  and a total is still reported', sum && typeof sum === 'object' && Object.keys(sum).length > 0);

    server.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
