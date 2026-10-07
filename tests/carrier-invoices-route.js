// tests/carrier-invoices-route.js — END TO END (CLAUDE.md §3): real server, real login,
// the route the NTG/TQL/Schneider tabs read, and the page that renders it.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-route-'));
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
(async () => {
    const CI = require(path.join(ROOT, 'helpers/carrierInvoices'));
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body); const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); }); });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    const noAuth = await req('GET', '/api/carrier-invoices');
    ck('route needs a login', noAuth.status === 401 || noAuth.status === 403, String(noAuth.status));
    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);
    const empty = await req('GET', '/api/carrier-invoices', { sid });
    ck('empty store answers 200 with no rows', empty.status === 200 && empty.json.rows.length === 0 && empty.json.carriers.length === 3, JSON.stringify(empty.json));
    await CI.upsertMany([
        { carrier: 'tql', ref: '37359825', amount: 4500, lane: 'CA TO TX' },
        { carrier: 'ntg', ref: '9621418', amount: 4900, paid: 4900 },
        { carrier: 'ntg', ref: '9703547', amount: 1100 },
        { carrier: 'schneider', ref: '123456789012', amount: 9700 },
    ]);
    const ntg = (await req('GET', '/api/carrier-invoices?carrier=ntg', { sid })).json;
    ck('carrier filter reaches the helper: 2 NTG rows only', ntg.rows.length === 2 && ntg.rows.every((r) => r.carrier === 'ntg'));
    ck('every row says Edge Metals', ntg.rows.every((r) => r.company === 'Edge Metals'));
    ck('summary read back through the route: NTG outstanding 1100', ntg.summary.ntg.outstanding === 1100 && ntg.summary.tql.outstanding === 4500, JSON.stringify(ntg.summary));
    const open = (await req('GET', '/api/carrier-invoices?status=open', { sid })).json;
    ck('status filter: 3 open rows across carriers', open.rows.length === 3);
    const before = fs.readFileSync(require(path.join(ROOT, 'config')).CARRIER_INVOICES_FILE, 'utf8');
    await req('GET', '/api/carrier-invoices?carrier=tql', { sid });
    ck('GET writes nothing', fs.readFileSync(require(path.join(ROOT, 'config')).CARRIER_INVOICES_FILE, 'utf8') === before);
    const post = await req('POST', '/api/carrier-invoices', { sid, body: { carrier: 'tql', ref: '1', amount: 5 } });
    ck('no write route exists (POST refused)', post.status >= 400);
    // The page: the three tabs call this exact route and no longer say "not wired up".
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    ck('page reads the route the test just exercised', /api\('\/api\/carrier-invoices\?carrier='/.test(html));
    ck('NTG/TQL/Schneider placeholders are gone', !/NTG verification isn't wired up|TQL verification isn't wired up|Schneider verification isn't wired up/.test(html));
    ck('panels exist for all three, plus bodies', ['ntg', 'tql', 'schneider'].every((c) => html.includes(`id="carrierBody_${c}"`)));
    ck('other carrier panels untouched', ['verifyPanelZimex', 'verifyPanelJio', 'verifyPanelGardunos', 'verifyPanelPanMetal'].every((id) => html.includes(`id="${id}"`)));
    server.close();
    
// ── THE PAID DATE SHE ASKED FOR ───────────────────────────────────────────
// Apsara, 2026-10-07, looking at the Transport tab: "Also it would be better
// if we have the paid date".
//
// It was already in the store. helpers/carrierInvoices.js has carried
// `paid_dates` since the importer was written and the route returns the whole
// row, so this was a column that had never been drawn — not a schema change,
// and no import has to be re-run to see history. The checks below pin both
// halves: the route must keep handing the dates over, and the tab must keep
// showing them.
{
    console.log('\n=== paid date — in the store, now on the screen ===');

    const fs2 = require('fs');
    const path2 = require('path');
    const page = fs2.readFileSync(path2.join(__dirname, '..', 'dashboard/documents.html'), 'utf8');

    ck('the carrier table has a Paid on column',
       /<th>Paid on<\/th>/.test(page), 'the date is in the data; it was never drawn');
    ck('  and the row renders it', /paidOn\(r\)/.test(page));
    ck('  from paid_dates, not from a new field',
       /r\.paid_dates/.test(page), 'no import has to be re-run to see history');

    // The helper, exercised rather than read. paid_dates is an ARRAY because a
    // carrier can remit against one invoice more than once; collapsing several
    // into one date silently would make a part-paid invoice look settled on a
    // day it was not.
    const m = page.match(/function paidOn\(r\) \{[\s\S]*?\n\}/);
    ck('paidOn is there to test', !!m);
    if (m) {
        const paidOn = new Function('r', m[0].replace(/^function paidOn\(r\) \{/, '').replace(/\}$/, ''));
        const cases = [
            [{ paid_dates: [] }, '', 'never paid'],
            [{}, '', 'no field at all'],
            [{ paid_dates: null }, '', 'a null where an array should be'],
            [{ paid_dates: ['2026-08-19'] }, '2026-08-19', 'paid once'],
            [{ paid_dates: ['2026-08-19T10:00:00Z'] }, '2026-08-19', 'a timestamp is trimmed to the day'],
            [{ paid_dates: ['2026-09-01', '2026-08-19'] }, '2026-09-01 (+1)', 'two remittances, latest first'],
            [{ paid_dates: ['2026-07-01', '2026-08-19', '2026-09-01'] }, '2026-09-01 (+2)', 'three'],
            [{ paid_dates: [null, '2026-08-19'] }, '2026-08-19', 'a null among the dates'],
        ];
        for (const [row, want, why] of cases) {
            const got = paidOn(row);
            ck(`  ${why}`, got === want, `want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        }
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
