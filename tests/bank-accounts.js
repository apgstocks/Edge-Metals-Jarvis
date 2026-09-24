// tests/bank-accounts.js — the Bank tab's data and its one route.
// These numbers are what customers are told to send money to, so the shape is
// pinned: a wire routing that is not the ACH routing, and no silent blanks.
const fs = require('fs'), path = require('path');
const express = require('express');
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : JSON.stringify(extra).slice(0, 160)); } };

(async () => {
    const file = path.join(__dirname, '..', 'qb-settings', 'bank-accounts.json');
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    ck('the file parses and has accounts', Array.isArray(d.accounts) && d.accounts.length >= 2);
    for (const a of d.accounts) {
        ck(`${a.company}: has a company, a bank and an account number`, !!(a.company && a.bank && a.accountNumber), a);
        ck(`${a.company}: has an address to print`, !!a.address, a.address);
        ck(`${a.company}: has a wire routing number`, !!a.wireRouting, a);
        ck(`${a.company}: account and routing are digits only`, /^\d+$/.test(a.accountNumber) && /^\d{9}$/.test(a.wireRouting), a);
        if (a.achRouting) ck(`${a.company}: ACH routing is NOT the wire routing`, a.achRouting !== a.wireRouting, a);
    }
    const ids = d.accounts.map((a) => a.id);
    ck('ids are unique', new Set(ids).size === ids.length, ids);
    ck('the two companies are kept apart', new Set(d.accounts.map((a) => a.company)).size === d.accounts.length);

    // ── the routes, against a throwaway documents folder ───────────────────
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bankdocs-'));
    const cfg = { ROOT: path.join(__dirname, '..'), DATA_DIR: tmp };
    const app = express();
    app.use(express.json({ limit: '40mb' }));
    let role = 'admin';
    app.use((req, res, next) => { req.role = role; next(); });
    require('../helpers/bankDocs').mount(app, cfg);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { code: r.status, body: await r.json().catch(() => ({})) }; };

    const r = await fetch(base + '/api/bank-accounts');
    const j = await r.json();
    ck('the route serves them', r.status === 200 && j.accounts.length === d.accounts.length);
    ck('each account comes with its documents list', j.accounts.every((a) => Array.isArray(a.documents)));

    const id = d.accounts[0].id;
    const pdf = Buffer.from('%PDF-1.4 a voided cheque').toString('base64');
    const up = await post(`/api/bank-accounts/${id}/docs`, { filename: 'voided cheque.pdf', base64: pdf });
    ck('an admin can upload', up.code === 200 && up.body.name === 'voided cheque.pdf', up.body);
    const again = await post(`/api/bank-accounts/${id}/docs`, { filename: 'voided cheque.pdf', base64: pdf });
    ck('a second file of the same name never overwrites the first', again.code === 200 && again.body.name === 'voided cheque (2).pdf', again.body);

    const dl = await fetch(base + `/api/bank-accounts/${id}/docs/${encodeURIComponent('voided cheque.pdf')}`);
    ck('...and it downloads again, byte for byte', dl.status === 200 && (await dl.text()).startsWith('%PDF-1.4'));

    ck('an executable is refused', (await post(`/api/bank-accounts/${id}/docs`, { filename: 'payload.sh', base64: pdf })).code === 400);
    ck('an empty file is refused', (await post(`/api/bank-accounts/${id}/docs`, { filename: 'empty.pdf', base64: '' })).code === 400);
    const traverse = await post(`/api/bank-accounts/${id}/docs`, { filename: '../../../etc/passwd.pdf', base64: pdf });
    ck('a path in the filename is flattened, never followed', traverse.code === 200 && !traverse.body.name.includes('/'), traverse.body);
    ck('an unknown account is a 404', (await post('/api/bank-accounts/not-a-bank/docs', { filename: 'x.pdf', base64: pdf })).code === 404);

    role = 'staff';
    ck('staff cannot upload', (await post(`/api/bank-accounts/${id}/docs`, { filename: 'x.pdf', base64: pdf })).code === 403);
    const staffDl = await fetch(base + `/api/bank-accounts/${id}/docs/${encodeURIComponent('voided cheque.pdf')}`);
    ck('...but staff CAN download — it is what customers are given anyway', staffDl.status === 200);
    const del = await fetch(base + `/api/bank-accounts/${id}/docs/${encodeURIComponent('voided cheque.pdf')}`, { method: 'DELETE' });
    ck('staff cannot delete', del.status === 403);
    role = 'admin';
    const del2 = await fetch(base + `/api/bank-accounts/${id}/docs/${encodeURIComponent('voided cheque.pdf')}`, { method: 'DELETE' });
    ck('an admin can delete', del2.status === 200);

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });

    // the page
    const page = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'documents.html'), 'utf8');
    ck('Documents has a Bank tab', /data-subtab="bank"/.test(page) && /id="panelBank"/.test(page));
    ck('...that loads when opened', /if \(name === 'bank'\) bankInit\(\);/.test(page));
    ck('...and can print wire instructions', /function bankPrint\(/.test(page) && /Wire transfer instructions/.test(page));
    ck('...and has an upload control and download links', /class="bank-upload"/.test(page) && /async function bankUpload/.test(page) && /\/docs\//.test(page));
    ck('the ACH warning is on the printed sheet', /For ACH and direct deposit only/.test(page));
    ck('no account number is hard-coded into the page', !/2911072816|325072483301/.test(page));

    console.log(`\nbank-accounts: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})();
