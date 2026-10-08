// tests/carrier-invoices-route.js — END TO END (CLAUDE.md §3): real server, real login,
// the route the NTG/TQL/Schneider tabs read, and the page that renders it.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-route-'));
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
// Added 2026-10-08. The write routes below are requireSuper — Edge Metals money
// is the Jarvis profile's (her rule, 2026-09-16; office staff hold the admin
// password). Set BEFORE config is required, which reads these once at load.
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';
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
    const adminSid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!adminSid);
    // The READ checks keep running as admin, deliberately: reading the register
    // is not privileged and that is worth holding. The write checks below use
    // the Jarvis profile, which is what the new routes require.
    const sid = adminSid;
    const jarvisSid = ((await req('POST', '/login', { body: { password: process.env.JARVIS_PASSWORD } })).json || {}).sid;
    ck('  and the Jarvis profile too', !!jarvisSid);
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
    // ── THIS USED TO SAY "no write route exists" ─────────────────────────
    // True when it was written; false since 2026-10-08, when Apsara asked for
    // a Pay button on manual rows. It kept PASSING either way, because `sid`
    // here is the ADMIN session and the new route is requireSuper — so the
    // label would have gone on asserting, to whoever read it next, that this
    // store cannot be written. The check now says what it actually proves.
    const post = await req('POST', '/api/carrier-invoices', { sid, body: { carrier: 'tql', ref: '1', amount: 5 } });
    ck('the write route refuses ADMIN — Edge Metals money is the Jarvis profile\'s',
       post.status === 401 || post.status === 403, String(post.status));
    // The page: the three tabs call this exact route and no longer say "not wired up".
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    ck('page reads the route the test just exercised', /api\('\/api\/carrier-invoices\?carrier='/.test(html));
    ck('NTG/TQL/Schneider placeholders are gone', !/NTG verification isn't wired up|TQL verification isn't wired up|Schneider verification isn't wired up/.test(html));
    ck('panels exist for all three, plus bodies', ['ntg', 'tql', 'schneider'].every((c) => html.includes(`id="carrierBody_${c}"`)));
    ck('other carrier panels untouched', ['verifyPanelZimex', 'verifyPanelJio', 'verifyPanelGardunos', 'verifyPanelPanMetal'].every((id) => html.includes(`id="${id}"`)));
    // server.close() MOVED to the end of the file on 2026-10-08. It sat here,
    // and the manual-invoice section appended after it got 'socket hang up'
    // on its first request — the server was already shut. The route was fine;
    // the harness had gone home.
    
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


// ── THE MANUAL ROW, AND THE ONE IT MAY NOT TOUCH ──────────────────────────
// Apsara, 2026-10-08: "If source is manual ,pay button can be there na".
//
// Her rule resolves the conflict the read-only design existed to avoid: an
// IMPORTED row's truth is the carrier's remittance mail, a MANUAL row has no
// mail behind it and never will. The refusal is the feature, so it is tested
// harder than the happy path.
{
    console.log('\n=== a row she typed, and the imported one beside it ===');

    const fs3 = require('fs');
    const path3 = require('path');
    const page = fs3.readFileSync(path3.join(__dirname, '..', 'dashboard/documents.html'), 'utf8');
    const CI = require(path3.join(__dirname, '..', 'helpers/carrierInvoices'));
    const cfg = require(path3.join(__dirname, '..', 'config'));

    // An imported row to protect, written straight to the store.
    fs3.writeFileSync(cfg.CARRIER_INVOICES_FILE, JSON.stringify([{
        id: 'CI_mail', company: 'Edge Metals', key: 'schneider:ORD-1', carrier: 'schneider',
        ref: 'ORD-1', amount: 4450, paid: 0, status: 'open', paid_dates: [],
        evidence: 'Schneider Pay by Link',
    }], null, 2));

    const made = await req('POST', '/api/carrier-invoices', { sid: jarvisSid, body: {
        carrier: 'tql', ref: 'PO-9001', amount: 1850, invoice_date: '2026-10-01', lane: 'Dallas' } });
    ck('a hand-typed invoice is accepted', made.status === 200,
       `${made.status} ${JSON.stringify(made.json)}`);
    const row = made.json && made.json.row;
    ck('  marked manual AND locked', !!row && row.source === 'manual' && row.locked === true,
       JSON.stringify(row && { s: row.source, l: row.locked }));
    ck('  so the next import cannot overwrite her figures',
       /locked/.test(fs3.readFileSync(path3.join(__dirname, '..', 'helpers/carrierInvoices.js'), 'utf8')));
    ck('  and it starts open', !!row && row.paid === 0 && row.status === 'open');

    const part = await req('POST', `/api/carrier-invoices/${row.id}/pay`,
        { sid: jarvisSid, body: { amount: 1000, date: '2026-10-05', ref: 'WIRE-77' } });
    ck('a part payment is recorded', part.status === 200 && part.json.row.paid === 1000
       && part.json.row.status === 'part', `${part.status} ${JSON.stringify(part.json)}`);
    ck('  and the paid date is kept', (part.json.row.paid_dates || []).includes('2026-10-05'));

    const rest = await req('POST', `/api/carrier-invoices/${row.id}/pay`,
        { sid: jarvisSid, body: { amount: 850, date: '2026-10-07' } });
    ck('paying the rest settles it', rest.status === 200 && rest.json.row.status === 'paid'
       && rest.json.row.paid === 1850, JSON.stringify(rest.json && rest.json.row));
    ck('  with BOTH dates, not the last one only',
       (rest.json.row.paid_dates || []).length === 2,
       JSON.stringify(rest.json.row.paid_dates));

    // ── THE REFUSALS ─────────────────────────────────────────────────────
    const onMail = await req('POST', '/api/carrier-invoices/CI_mail/pay',
        { sid: jarvisSid, body: { amount: 100, date: '2026-10-05' } });
    ck('paying an IMPORTED row is refused', onMail.status === 409,
       `${onMail.status} ${JSON.stringify(onMail.json)}`);
    ck('  with a 409, because the request is fine and the row\'s provenance says no',
       onMail.status === 409 && /own email/.test(String(onMail.json && onMail.json.error)),
       JSON.stringify(onMail.json));
    ck('  and it is left untouched',
       (CI.list().find((r) => r.id === 'CI_mail') || {}).paid === 0);

    const over = await req('POST', `/api/carrier-invoices/${row.id}/pay`,
        { sid: jarvisSid, body: { amount: 1, date: '2026-10-08' } });
    ck('overpaying is refused with both figures', over.status === 400
       && /1851\.00/.test(String(over.json.error)) && /1850\.00/.test(String(over.json.error)),
       JSON.stringify(over.json));

    const dup = await req('POST', '/api/carrier-invoices', { sid: jarvisSid, body: {
        carrier: 'schneider', ref: 'ORD-1', amount: 50 } });
    ck('typing a ref that already exists is REFUSED, not merged', dup.status === 400
       && /already here/.test(String(dup.json.error)),
       'upsertMany merges by carrier+ref so a re-import is safe; typing one is not the same act');

    const noDate = await req('POST', `/api/carrier-invoices/${row.id}/pay`, { sid: jarvisSid, body: { amount: 5 } });
    ck('a payment with no date is refused', noDate.status === 400, JSON.stringify(noDate.json));
    const gone = await req('POST', '/api/carrier-invoices/NOPE/pay',
        { sid: jarvisSid, body: { amount: 5, date: '2026-10-08' } });
    ck('a missing invoice is a 404, not a 500', gone.status === 404, String(gone.status));

    const asAdmin = await req('POST', '/api/carrier-invoices', { sid: adminSid, body: {
        carrier: 'ntg', ref: 'N-1', amount: 10 } });
    ck('admin is refused — Edge Metals money is the Jarvis profile\'s',
       asAdmin.status === 401 || asAdmin.status === 403, String(asAdmin.status));

    // ── AND THE SCREEN ───────────────────────────────────────────────────
    ck('the tab offers Add invoice', /id="ciAdd_/.test(page));
    ck('  on the empty state too, or a carrier with no rows is a dead end',
       (page.match(/ciAdd_/g) || []).length >= 3, 'summary line, empty state, and the handler');
    ck('Pay is drawn only for a manual row',
       /r\.source !== 'manual'/.test(page) && /class="ciPay/.test(page),
       (page.match(/function payCell[\s\S]{0,400}/) || [''])[0].slice(0, 200));
    ck('  and an imported row says where its figure comes from',
       /from their mail/.test(page));
    ck('the calls use the page\'s real api(path, opts) shape',
       /api\('\/api\/carrier-invoices', \{ method: 'POST'/.test(page),
       'api() SPREADS opts into fetch; a bare object is a GET with stray keys');

    fs3.writeFileSync(cfg.CARRIER_INVOICES_FILE, '[]');
}


    // ── WHAT AN INVOICE COVERS, ON CLICK ─────────────────────────────────
    // Apsara, 2026-10-08: "One container per row should be there.when i click
    // on tht row,i can show detailed split of what is what".
    //
    // Two facts had to come first, and both say no to the literal ask:
    //   · helpers/carrierRemittance.js's own header — these three bill
    //     "domestic loads (CA→TX, Oakland→Eccomelt), not containers". There is
    //     no container number in the data to put one per row.
    //   · one Schneider order settles several LOADS for ONE figure. Her
    //     $9,700 row covers two. The email carries no per-load amount, so a
    //     row each would mean inventing two numbers that add up.
    // So the row opens instead, and says what it covers without dividing it.
    console.log('\n=== what the invoice covers, without inventing a split ===');

    const page2 = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    ck('the loads survive as a LIST, not only as prose',
       /loads: Array\.isArray\(i\.loads\)/.test(
         fs.readFileSync(path.join(__dirname, '..', 'helpers/carrierInvoices.js'), 'utf8')),
       'they were parsed and flattened into "loads A, B" and thrown away');
    ck('  and the parser passes them through',
       /loads: o\.loads\.slice\(\)/.test(
         fs.readFileSync(path.join(__dirname, '..', 'helpers/carrierRemittance.js'), 'utf8')));

    // ── THE NUMBER IS THE LINK, NOT THE ROW ──────────────────────────────
    // Apsara, 2026-10-08: "Instead of expanding,can i hae like qb,cinvoice no
    // as clicakble,on clicking it,it will show detailed". The row-click was
    // my instinct and hers is better: invisible until tried, and it COLLIDED
    // with Pay — paying an invoice also toggled its detail, which I had to
    // special-case. A link on the number has no such collision to fix.
    ck('the invoice number is the link', /class="ciRef"/.test(page2) && /ciSplit/.test(page2));
    ck('  and the row itself is NOT clickable any more',
       !/class="ciRow"/.test(page2),
       'two things opening the same panel is how the Pay collision happened');
    ck('  and no special case is needed to protect Pay',
       !/ev\.target\.closest\('button'\)/.test(page2),
       'the workaround should have gone with the row click it existed for');
    ck('  only one detail is open at a time',
       /querySelectorAll\('\.ciSplit'\)\.forEach\(\(x\) => \{ x\.style\.display = 'none'; \}\)/.test(page2),
       'a list of open panels is a wall to scroll past to reach the next number');

    // The helper, exercised. This is where a guessed split would show up.
    const sm = page2.match(/function splitOf\(r\) \{[\s\S]*?\n\}/);
    ck('splitOf is there to test', !!sm);
    if (sm) {
        const splitOf = new Function('r', 'esc',
            sm[0].replace(/^function splitOf\(r\) \{/, '').replace(/\}$/, ''));
        const run = (r) => splitOf(r, (x) => String(x == null ? '' : x));

        const two = run({ loads: ['3010354116', '3010355035'], amount: 9700, carrier: 'schneider' });
        ck('two loads are both listed', /3010354116/.test(two) && /3010355035/.test(two));
        ck('  the invoice total is shown once', (two.match(/9,700\.00/g) || []).length >= 1);
        ck('  and NEITHER load is given a made-up share',
           !/4,850\.00/.test(two) && /not split/.test(two),
           'half of 9,700 is 4,850 — that number must not appear anywhere');
        ck('  with the reason in her words', /carrier did not/.test(two));

        const one = run({ loads: ['3010756059'], amount: 4450, carrier: 'schneider' });
        ck('a single load DOES carry the whole amount', /4,450\.00/.test(one) && !/not split/.test(one),
           'there is nothing to divide, so saying "not split" would be noise');

        // ── AND WHAT THE LINK OPENS ──────────────────────────────────────────
    const dm = page2.match(/function detailOf\(r\) \{[\s\S]*?\n\}/);
    ck('detailOf is there to test', !!dm);
    if (dm) {
        const detailOf = new Function('r', 'esc', 'splitOf',
            dm[0].replace(/^function detailOf\(r\) \{/, '').replace(/\}$/, ''));
        const D = (r) => detailOf(r, (x) => String(x == null ? '' : x), (x) => run(x));

        const manual = D({ carrier: 'tql', ref: 'P1', amount: 1850, paid: 1000, source: 'manual',
            added_by: 'apsara', loads: [], invoice_date: '2026-10-01',
            payments: [{ amount: 1000, date: '2026-10-05', mode: 'Wire', bank: 'BofA', ref: 'W-77' }] });
        ck('the detail shows billed, paid and outstanding',
           /1,850\.00/.test(manual) && /1,000\.00/.test(manual) && /850\.00/.test(manual));
        ck('  and every payment recorded against it',
           /2026-10-05/.test(manual) && /BofA/.test(manual) && /W-77/.test(manual),
           'this is the ONLY place payments[] can be seen at all');
        ck('  and says it was added by hand', /Added by hand/.test(manual) && /apsara/.test(manual));

        // The case that must not read as "nothing happened".
        const mailPaid = D({ carrier: 'schneider', ref: 'O2', amount: 9700, paid: 9700,
            evidence: 'Schneider PAID mail', loads: ['3010354116', '3010355035'], payments: [] });
        ck('a mail-paid invoice explains why no payment is listed',
           /no payment was recorded in Jarvis/.test(mailPaid)
           && /did not say from which account/.test(mailPaid),
           'an empty payments table on a PAID invoice reads as data loss');
        ck('  and names the mail it came from', /Schneider PAID mail/.test(mailPaid));
        ck('  and still shows what it covers', /3010354116/.test(mailPaid));
    }

    const none = run({ loads: [], amount: 100, lane: null, carrier: 'ntg' });
        ck('an invoice naming no loads says so', /does not say which loads/.test(none));
        const prose = run({ loads: [], amount: 100, lane: 'Oakland to Frisco', carrier: 'ntg' });
        ck('  and falls back to the prose when there is some', /Oakland to Frisco/.test(prose));
    }

    server.close();

console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
