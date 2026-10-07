// ── tests/party-invoices.js ───────────────────────────────────────────────
// The invoice register for Zimex / Jio / Sher / Pan Metal / AJ / Garduno's (Apsara 2026-10-07).
// A: normalize rules. B: END TO END (CLAUDE.md §3): a sweep-style export file -> the real
// importer script -> the real server -> GET /api/party-invoices (the route the tab reads).
// Also pins that the register writes to NO bill, sale or book store.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-partyinv-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const PI = require(path.join(ROOT, 'helpers/partyInvoices'));

section('A. normalize');
{
    const n = (r) => PI.normalize(r);
    const j = n({ party: 'jio', invoice_no: 'J1', container_no: 'abcd 1234567', net_amount: 1025, status: 'verified' });
    ck('Jio line: container upper-cased/trimmed, amount from net_amount', j.row && j.row.container_no === 'ABCD1234567' && j.row.amount === 1025);
    ck('key = party:invoice:line', j.row.key === 'jio:J1:ABCD1234567');
    ck('Pan Metal amount is the commission', n({ party: 'panmetal', invoice_no: 'P1', order_no: 'O1', commission: 300, status: 'match' }).row.amount === 300);
    ck('AJ uses total_amount', n({ party: 'ajtransport', invoice_no: '6405', container_no: 'AAAA1111111', total_amount: 990 }).row.amount === 990);
    ck('Zimex keyed on HBL', n({ party: 'zimex', invoice_no: 'Z1', hbl_no: 'hbl 9', amount: 500 }).row.key === 'zimex:Z1:HBL9');
    ck('$0 line (booking confirmation) is skipped, not listed', /no amount/.test(n({ party: 'zimex', hbl_no: 'H', amount: 0 }).skip));
    ck('Edge\'s own $20,671 outbound invoice on a trucker is skipped (the Jio/Sher junk rows)', /over \$3000 per load/.test(n({ party: 'jio', invoice_no: 'X', container_no: 'HMMU4285998', net_amount: 20671.2 }).skip));
    ck('the same amount on Zimex (ocean freight) is NOT capped', !!n({ party: 'zimex', invoice_no: 'Z2', hbl_no: 'H2', amount: 20671.2 }).row);
    ck('Sher: cap is per load (quantity 3 x $2,400 is fine)', !!n({ party: 'sher', booking_no: 'BK1', quantity: 3, amount: 7200 }).row);
    ck('unknown party / failed extraction / nothing to key on are skipped', n({ party: 'tql', amount: 5 }).skip && n({ party: 'jio', extraction_failed: true }).skip && n({ party: 'jio', amount: 50 }).skip);
}

section('B. end to end');
(async () => {
    const exp = path.join(TMP, 'export.json');
    const recs = [
        { party: 'zimex', invoice_no: 'Z1', hbl_no: 'HBL1', amount: 1500, status: 'match', source_file: 'z.pdf' },
        { party: 'zimex', hbl_no: 'DALA1', amount: 0, status: 'not_in_sheet' },
        { party: 'jio', invoice_no: 'J1', container_no: 'AAAA1111111', net_amount: 900, status: 'verified' },
        { party: 'jio', invoice_no: 'J1', container_no: 'AAAA1111111', net_amount: 950, status: 'verified' },        // re-seen: last wins
        { party: 'jio', invoice_no: 'JX', container_no: 'HMMU4285998', net_amount: 20671.2, status: 'verified' },     // junk
        { party: 'sher', booking_no: 'BKS1', quantity: 1, amount: 640, status: 'not_in_sheet', invoice_no: 'S1' },
        { party: 'panmetal', invoice_no: 'PM1', order_no: '25MT13', commission: 410, status: 'match' },
        { party: 'ajtransport', invoice_no: '6387', container_no: 'KOCU4646380', total_amount: 1100, status: 'not_in_sheet' },
        { party: 'gardunos', invoice_no: '169', container_no: 'SMCU1176865', total_amount: 930, status: 'verified' },
    ];
    fs.writeFileSync(exp, JSON.stringify({ exported_at: 'now', records: recs }));
    const run = (...a) => execFileSync('node', [path.join(ROOT, 'scripts/party-invoices-import.js'), '--file', exp, ...a], { env: { ...process.env }, encoding: 'utf8' });
    const store = path.join(TMP, 'party_invoices.json');
    const prev = run();
    ck('preview writes nothing', /PREVIEW/.test(prev) && !fs.existsSync(store));
    ck('preview says what it left out', /over \$3000 per load/.test(prev) && /no amount/.test(prev));
    const w = run('--write');
    ck('--write saves 6 lines (9 − $0 − junk − duplicate)', /Wrote: 6 added/.test(w), w.split('\n').find((l) => /Wrote/.test(l)));
    ck('second --write adds nothing (idempotent)', /Wrote: 0 added, 6 updated/.test(run('--write')));
    const stored = JSON.parse(fs.readFileSync(store, 'utf8'));
    ck('Jio J1 holds the LAST figure (950)', stored.find((r) => r.invoice_no === 'J1').amount === 950);
    stored.find((r) => r.invoice_no === 'Z1').locked = true; stored.find((r) => r.invoice_no === 'Z1').amount = 1;
    fs.writeFileSync(store, JSON.stringify(stored));
    ck('a hand-edited (locked) row survives a re-import', /1 hand-edited kept/.test(run('--write')) && PI.list().find((r) => r.invoice_no === 'Z1').amount === 1);

    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { sid, body } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body); const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
    ck('route needs a login', [401, 403].includes((await req('GET', '/api/party-invoices')).status));
    const sid = (await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json.sid;
    const all = (await req('GET', '/api/party-invoices', { sid })).json;
    ck('route returns the 6 imported lines + the party list', all.rows.length === 6 && Object.keys(all.parties).length === 6, String(all.rows.length));
    ck('party filter reaches the store: Jio -> 1 line', (await req('GET', '/api/party-invoices?party=jio', { sid })).json.rows.length === 1);
    ck('"NOT on sheet" filter: Sher + AJ', (await req('GET', '/api/party-invoices?status=not_in_sheet', { sid })).json.rows.map((r) => r.party).sort().join() === 'ajtransport,sher');
    ck('"On the sheet" filter counts verified AND Pan Metal "match"', (await req('GET', '/api/party-invoices?status=on_sheet', { sid })).json.rows.length === 4);
    ck('search by container', (await req('GET', '/api/party-invoices?q=smcu117', { sid })).json.rows.length === 1);
    ck('summary per party carries not_on_sheet counts', all.summary.ajtransport.not_on_sheet === 1 && all.summary.zimex.count === 1);
    const before = JSON.stringify(fs.readdirSync(TMP).sort());
    await req('GET', '/api/party-invoices?party=zimex', { sid });
    ck('GET writes nothing', JSON.stringify(fs.readdirSync(TMP).sort()) === before);
    ck('it wrote to NO bill / sale / payment store', ['bills.json', 'sales.json', 'bill_payments.json', 'metals_trucking.json', 'trucker_bills.json'].every((f) => !fs.existsSync(path.join(TMP, f))));
    ck('no write route exists', (await req('POST', '/api/party-invoices', { sid, body: { party: 'jio' } })).status >= 400);
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    ck('page reads the route just tested', /api\('\/api\/party-invoices\?'/.test(html));
    ck('Register group wired (button, panel, maps)', /data-verify-group="register"/.test(html) && /register: 'verifyGroupRegister'/.test(html) && /register: 'verifyPanelRegister'/.test(html) && /register: \['register'\]/.test(html));
    ck('existing groups untouched', ['freight', 'transport', 'commission'].every((g) => html.includes(`data-verify-group="${g}"`)));
    server.close();
    
// ── THE FOUR TRANSPORT TABS SHE SAID WERE EMPTY ───────────────────────────
// Apsara, 2026-10-07: "Transport -all data should be filled".
//
// The Transport group has seven sub-tabs; only NTG, TQL and Schneider listed
// invoices. AJ Transport, Sher Trucking, Jio and Garduno's were verification
// forms with nothing showing what the carrier had billed — while their
// invoices sat in this store behind a route the Invoice Register already used.
{
    const fs2 = require('fs');
    const path2 = require('path');
    const page = fs2.readFileSync(path2.join(__dirname, '..', 'dashboard/documents.html'), 'utf8');
    console.log('\n=== the four Transport tabs are filled from this store ===');

    ck('all four sub-tabs map to a party',
       /'aj-transport': 'ajtransport'/.test(page) && /'sher-trucking': 'sher'/.test(page)
       && /jio: 'jio'/.test(page) && /gardunos: 'gardunos'/.test(page),
       (page.match(/const PARTY_OF_SUBTAB = \{[^}]*\}/) || [''])[0]);
    ck('  and clicking one loads it', /if \(PARTY_OF_SUBTAB\[k\]\) loadParty\(k\);/.test(page),
       'a loader nothing calls is the dead-screen pattern again');
    ck('  from the read-only party route', /\/api\/party-invoices\?party=/.test(page));
    ck('  without touching the carrier loader beside it',
       /if \(CARRIER_KEYS\[k\]\) loadCarrier\(k\);/.test(page),
       'NTG/TQL/Schneider must keep their own table');

    // ── NO PAID COLUMN HERE, AND THAT IS THE POINT ───────────────────────
    // This store's own header: "It says NOTHING about paid/unpaid — a PDF
    // invoice carries no remittance." NTG/TQL/Schneider know what is paid
    // because those carriers email one. Printing "Paid $0.00" for these four
    // would assert, in a column she reads as fact, that nothing has been
    // settled — when the truth is this store was never told either way.
    // Sliced FORWARD from loadParty. A first version searched for the
    // subtab-click line from the start of the file and found an EARLIER
    // occurrence of the same selector, so end < start and the slice was empty
    // — every check below it then passed against "". The length guard is what
    // caught it, which is why it is here rather than implied.
    const startAt = page.indexOf('async function loadParty');
    const block = page.slice(startAt, page.indexOf('.verify-subtab-btn', startAt));
    ck('the four-tab table was located', block.length > 400 && block.length < 6000,
       `${block.length} chars — if this is wrong the next checks prove nothing`);
    ck('  it shows the amount billed', /Amount/.test(block));
    ck('  and NEVER a paid figure', !/>Paid</.test(block) && !/paid_dates/.test(block),
       'a fabricated zero is worse than a blank column');
    ck('  and says why the column is absent',
       /no remittance|No paid column/i.test(block),
       'an unexplained missing column reads as a bug');
    ck('  and points at where payments really live',
       /Bills . Trucking|Bills &rarr; Trucking|Bills → Trucking/.test(block),
       'she must be told where to go, not just what is missing');

    ck('it flags invoices that are NOT on the sheet',
       /not_in_sheet/.test(block) && /not on the sheet/i.test(block),
       'the one thing this store does know beyond the amount');
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
