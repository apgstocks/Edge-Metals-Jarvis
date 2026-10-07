// ── tests/party-invoice-actions.js ────────────────────────────────────────
// Invoice register actions (Apsara, 2026-10-07): "sync from sheet, edit, delete, pay ...
// single inv payment against multiple". A: the rules, on the store. B: END TO END through the
// real routes the register screen calls, with the real ledger-delete lock (admin vs Jarvis
// profile). Only the Google sheet read is stubbed (never her live sheet).
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-piact-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbb'; process.env.JARVIS_PASSWORD = 'jarvis-pw-ddd'; process.env.STAFF_PASSWORD = 'staff-pw-ccc';
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const PI = require(path.join(ROOT, 'helpers/partyInvoices'));
const SYNC = require(path.join(ROOT, 'helpers/partyInvoiceSheetSync'));
const rej = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
const mk = (party, inv, line, amount, extra = {}) => PI.normalize({ party, invoice_no: inv, container_no: line, amount, net_amount: party === 'jio' ? amount : undefined, status: 'verified', ...extra }).row;

(async () => {
    section('A. the rules');
    await PI.upsertMany([mk('jio', 'J1', 'AAAA1111111', 900), mk('jio', 'J2', 'BBBB2222222', 600), mk('ajtransport', 'A1', 'CCCC3333333', 800)]);
    const id = (inv) => PI.list().find((r) => r.invoice_no === inv).id;
    const st = (inv) => PI.withPaid().find((r) => r.invoice_no === inv);
    ck('unpaid to start', st('J1').pay_status === 'unpaid' && st('J1').balance === 900);
    ck('no allocations refused', /pick at least one/.test(await rej(PI.addPayment({ amount: 5, paid_on: '2026-10-07', mode: 'Wire', allocations: [] }))));
    ck('allocations must add up to the payment', /allocations come to 1000.00 but the payment is 900.00/.test(await rej(PI.addPayment({ amount: 900, paid_on: '2026-10-07', mode: 'Wire', allocations: [{ row_id: id('J1'), amount: 400 }, { row_id: id('J2'), amount: 600 }] }))));
    ck('cannot pay a line more than it is owed', /owes only 900.00, cannot allocate 950.00/.test(await rej(PI.addPayment({ amount: 950, paid_on: '2026-10-07', mode: 'Wire', allocations: [{ row_id: id('J1'), amount: 950 }] }))));
    ck('one payment never spans two parties', /different parties/.test(await rej(PI.addPayment({ amount: 1700, paid_on: '2026-10-07', mode: 'Wire', allocations: [{ row_id: id('J1'), amount: 900 }, { row_id: id('A1'), amount: 800 }] }))));
    ck('mode must be in the list (no empty mode)', /mode must be one of/.test(await rej(PI.addPayment({ amount: 10, paid_on: '2026-10-07', mode: '', allocations: [{ row_id: id('J1'), amount: 10 }] }))));
    ck('bad date refused', /YYYY-MM-DD/.test(await rej(PI.addPayment({ amount: 10, paid_on: '10/07/2026', mode: 'Wire', allocations: [{ row_id: id('J1'), amount: 10 }] }))));
    ck('same line twice refused', /listed twice/.test(await rej(PI.addPayment({ amount: 20, paid_on: '2026-10-07', mode: 'Wire', allocations: [{ row_id: id('J1'), amount: 10 }, { row_id: id('J1'), amount: 10 }] }))));
    ck('none of the refusals wrote anything', PI.payments().length === 0);
    // ONE payment, TWO invoices: pays J1 in full and part-pays J2.
    const pay = await PI.addPayment({ amount: 1300, paid_on: '2026-10-07', mode: 'wire', ref: 'W-1', allocations: [{ row_id: id('J1'), amount: 900 }, { row_id: id('J2'), amount: 400 }] });
    ck('a single payment settles one invoice and part-pays another', st('J1').pay_status === 'paid' && st('J2').pay_status === 'part' && st('J2').balance === 200 && PI.payments().length === 1);
    ck('mode is normalised to the list entry', pay.mode === 'Wire' && pay.party === 'jio');
    ck('summary outstanding = what is still owed (200 + 800)', PI.summary().jio.outstanding === 200 && PI.summary().ajtransport.outstanding === 800);
    ck('a paid line cannot be over-paid again', /owes only 0.00/.test(await rej(PI.addPayment({ amount: 1, paid_on: '2026-10-07', mode: 'Wire', allocations: [{ row_id: id('J1'), amount: 1 }] }))));
    ck('edit cannot take the amount below what is paid', /already been paid/.test(await rej(PI.editRow(id('J1'), { amount: 800 }))));
    ck('delete refused while money is paid against the line', /delete that payment first/.test(await rej(PI.deleteRow(id('J2')))));
    const e = await PI.editRow(id('A1'), { amount: 850, note: 'rate corrected' }, { actor: 'tester' });
    ck('edit works, locks the line, keeps what it was', e.amount === 850 && e.locked === true && e.edit_history[0].before.amount === 800 && e.edit_history[0].by === 'tester');
    const re = await PI.upsertMany([{ ...mk('ajtransport', 'A1', 'CCCC3333333', 800) }]);
    ck('a re-import does not undo the edit', re.kept_locked === 1 && PI.list().find((r) => r.invoice_no === 'A1').amount === 850);
    const re2 = await PI.upsertMany([mk('jio', 'J2', 'BBBB2222222', 300)]);
    ck('a re-import cannot lower a line below what is paid', re2.kept_locked === 1 && PI.list().find((r) => r.invoice_no === 'J2').amount === 600);
    ck('edit with nothing / bad amount refused', /nothing to change/.test(await rej(PI.editRow(id('A1'), {}))) && /greater than 0/.test(await rej(PI.editRow(id('A1'), { amount: 0 }))));
    await PI.deletePayment(pay.id);
    ck('deleting the payment reopens both lines', st('J1').pay_status === 'unpaid' && st('J2').balance === 600);
    await PI.deleteRow(id('J2'));
    ck('now the line can be deleted', !PI.list().some((r) => r.invoice_no === 'J2'));
    ck('deleting a payment / row that does not exist errors', /no payment/.test(await rej(PI.deletePayment('nope'))) && /no invoice line/.test(await rej(PI.deleteRow('nope'))));

    section('lock (helpers default to the old behaviour; the routes enforce)');
    {
        const lid = PI.list().find((r) => r.invoice_no === 'A1').id;
        ck('a line with no unlock stamp is locked', PI.isUnlocked(PI.list().find((r) => r.id === lid)) === false);
        ck('enforceLock refuses edit / copy / delete on a locked line', /locked/.test(await rej(PI.editRow(lid, { note: 'n' }, { enforceLock: true }))) && /locked/.test(await rej(PI.copyRow(lid, { enforceLock: true }))) && /locked/.test(await rej(PI.deleteRow(lid, { enforceLock: true }))));
        ck('without the flag the helpers behave as before (importer, supersede script, suites)', (await PI.editRow(lid, { note: 'script edit' })).note === 'script edit');
        await PI.setLock(lid, true);
        ck('unlock stamps one line; a future/blank/expired stamp is locked', PI.isUnlocked(PI.list().find((r) => r.id === lid)) && !PI.isUnlocked({ unlocked_at: new Date(Date.now() + 3600e3).toISOString() }) && !PI.isUnlocked({ unlocked_at: new Date(Date.now() - 11 * 60e3).toISOString() }) && !PI.isUnlocked({}));
        const cp = await PI.copyRow(lid, { enforceLock: true });
        ck('copy: new id, new key, locked, source=copy, same figures', cp.id !== lid && cp.key !== PI.list().find((r) => r.id === lid).key && cp.is_unlocked === false && cp.source === 'copy' && cp.amount === 850);
        await PI.deleteRow(cp.id);
        await PI.setLock(lid, false);
    }

    section('sheet sync rules (pure)');
    const tabs = {
        jio: [['Date', 'Invoice No.', 'Container', 'Shipper', 'Line Haul', 'Port Fees', 'Chassis Rent', 'Others', 'Net Amount', 'Last Verified'],
            ['01/01/2026', 'J1', 'AAAA1111111', 'X', 900, '', '', '', 900, 't'],        // already there, same
            ['01/02/2026', 'J9', 'DDDD4444444', 'X', 500, '', '', '', 500, 't'],        // new
            ['01/03/2026', 'JX', 'HMMU4285998', 'EDGE METALS INC', 0, 0, 0, 0, 20671.2, 't']], // junk: over cap
        sher: [['Date', 'Booking No.', 'Quantity', 'Chassis', 'Others', 'Amount'], ['02/01/2026', 'BKS1', 1, 60, '', 640]],
        ajtransport: [['Invoice Date', 'Invoice No.', 'Container No.', 'Booking No.', 'Shipper', 'Pickup Date', 'Rate', 'Line Haul', 'Others', 'Dry Run', 'Extra Scale', 'Total amount'], ['03/01/2026', 'A1', 'CCCC3333333', 'B', 'X', '', '', 800, '', '', '', 800]],
        panmetal: [['Inv No.', 'Weight', 'Comm/MT', 'Commission', 'Verified On'], ['PM7', 20, 15, 300, '2026-10-01']],
    };
    await PI.upsertMany([mk('sher', 'S-EMAIL', 'BKS1', 640, { container_no: undefined, booking_no: 'BKS1' })]);   // email row, has an invoice no.; sheet row has none
    const p = SYNC.plan(tabs, PI.list());
    ck('adds only what Jarvis lacks (Jio J9, Pan Metal PM7)', p.to_add.map((r) => r.invoice_no).sort().join() === 'J9,PM7', p.to_add.map((r) => r.invoice_no).join());
    ck('Sher sheet line (no invoice no.) matches the email row by booking — not duplicated', p.already_there >= 2 && !p.to_add.some((r) => r.party === 'sher'));
    ck('a differing amount is REPORTED, not applied (AJ: Jarvis 850 vs sheet 800)', p.differs.length === 1 && p.differs[0].jarvis === 850 && p.differs[0].sheet === 800);
    ck('the over-cap junk row is skipped', Object.keys(p.skipped).some((k) => /over \$3000/.test(k)));
    ck('Pan Metal row amount is the commission', p.to_add.find((r) => r.invoice_no === 'PM7').amount === 300);

    section('B. end to end through the routes');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    app.locals.partyInvoiceReadTabs = async () => ({ tabs, problems: [] });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p2, { sid, body } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body); const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p2, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
    const admin = (await req('POST', '/login', { body: { password: 'admin-pw-bbb' } })).json.sid;
    const jarvis = (await req('POST', '/login', { body: { password: 'jarvis-pw-ddd' } })).json.sid;
    ck('signed in as admin and as the Jarvis profile', !!admin && !!jarvis);

    const dry = await req('POST', '/api/party-invoices/sync?dry=1', { sid: admin, body: {} });
    ck('sync dry run reports, writes nothing', dry.json.would_add === 2 && dry.json.added === 0 && !PI.list().some((r) => r.invoice_no === 'J9'));
    const real = await req('POST', '/api/party-invoices/sync', { sid: admin, body: {} });
    ck('sync adds the 2 missing lines', real.json.added === 2 && PI.list().some((r) => r.invoice_no === 'J9' && r.source === 'sheet'));
    ck('sync says what it cannot sync (Zimex, Garduno\'s) and what differs', real.json.no_tab_for.length === 2 && real.json.differs.length === 1);
    ck('a second sync adds nothing', (await req('POST', '/api/party-invoices/sync', { sid: admin, body: {} })).json.added === 0);

    const list0 = (await req('GET', '/api/party-invoices?party=jio', { sid: admin })).json;
    const rowsJio = list0.rows.filter((r) => r.balance > 0);
    ck('the list carries paid / balance / pay status and the mode list', rowsJio.length >= 2 && list0.modes.includes('Wire') && 'pay_status' in list0.rows[0]);
    const [r1, r2] = rowsJio;
    const bad = await req('POST', '/api/party-invoice-payments', { sid: admin, body: { amount: 1, paid_on: '2026-10-07', mode: 'Wire', allocations: [{ row_id: r1.id, amount: 2 }] } });
    ck('route refuses a bad payment with the reason', bad.status === 400 && /allocations come to/.test(bad.json.error), JSON.stringify(bad.json));
    const total = Math.round((r1.balance + 100) * 100) / 100;
    const ok = await req('POST', '/api/party-invoice-payments', { sid: admin, body: { amount: total, paid_on: '2026-10-07', mode: 'Wire', ref: 'E2E', allocations: [{ row_id: r1.id, amount: r1.balance }, { row_id: r2.id, amount: 100 }] } });
    ck('ONE payment across TWO invoices accepted through the route', ok.status === 200 && ok.json.payment.allocations.length === 2, JSON.stringify(ok.json));
    const after = (await req('GET', '/api/party-invoices?party=jio', { sid: admin })).json;
    const g = (r) => after.rows.find((x) => x.id === r.id);
    ck('read back through the list route: first paid, second part', g(r1).pay_status === 'paid' && g(r2).pay_status === 'part' && g(r2).paid === 100);
    ck('pay filter reaches the store', (await req('GET', '/api/party-invoices?pay=part', { sid: admin })).json.rows.every((r) => r.pay_status === 'part'));
    ck('the payment is listed', after.payments.length === 1 && after.payments[0].ref === 'E2E');

    const unl = (rid, sid) => req('POST', `/api/party-invoices/${rid}/unlock`, { sid });
    // LOCK (every line starts locked): refused until unlocked; paying was never blocked (proved above).
    const lockedPut = await req('PUT', `/api/party-invoices/${r2.id}`, { sid: admin, body: { note: 'x' } });
    ck('a LOCKED line cannot be edited through the route', lockedPut.status === 400 && /locked/.test(lockedPut.json.error), JSON.stringify(lockedPut.json));
    ck('a LOCKED line cannot be copied', (await req('POST', `/api/party-invoices/${r2.id}/copy`, { sid: admin })).status === 400);
    ck('a LOCKED line cannot be deleted (even by the Jarvis profile)', /locked/.test((await req('DELETE', `/api/party-invoices/${r2.id}`, { sid: jarvis })).json.error));
    ck('the list says every line is locked', (await req('GET', '/api/party-invoices', { sid: admin })).json.rows.every((r) => r.is_unlocked === false));
    ck('unlock opens that ONE line', (await unl(r2.id, admin)).json.is_unlocked === true && (await req('GET', '/api/party-invoices', { sid: admin })).json.rows.filter((r) => r.is_unlocked).length === 1);
    const put = await req('PUT', `/api/party-invoices/${r2.id}`, { sid: admin, body: { note: 'checked with Jio' } });
    ck('edit through the route', put.status === 200 && put.json.row.locked === true && put.json.row.note === 'checked with Jio');
    ck('saving an edit RE-LOCKS the line', (await req('GET', '/api/party-invoices', { sid: admin })).json.rows.find((r) => r.id === r2.id).is_unlocked === false);
    await unl(r2.id, admin);
    ck('edit below paid refused with the reason', (await req('PUT', `/api/party-invoices/${r2.id}`, { sid: admin, body: { amount: 1 } })).status === 400);
    // COPY
    const cp = await req('POST', `/api/party-invoices/${r2.id}/copy`, { sid: admin });
    ck('copy of an unlocked line makes a NEW line, locked, carrying no payment', cp.status === 200 && cp.json.row.id !== r2.id && cp.json.row.is_unlocked === false && cp.json.row.paid === 0 && cp.json.row.copied_from === r2.id && cp.json.row.amount === r2.amount, JSON.stringify(cp.json));
    ck('the copy cannot be re-added or overwritten by a re-import (own key, marked edited)', cp.json.row.key !== r2.key && cp.json.row.locked === true);
    ck('the original is untouched by the copy', PI.list().find((r) => r.id === r2.id).amount === r2.amount);
    // EXPIRY: an unlock is not forever
    const stale = JSON.parse(fs.readFileSync(path.join(TMP, 'party_invoices.json'), 'utf8')); stale.find((r) => r.id === r2.id).unlocked_at = new Date(Date.now() - 11 * 60 * 1000).toISOString(); fs.writeFileSync(path.join(TMP, 'party_invoices.json'), JSON.stringify(stale));
    ck('an unlock EXPIRES after ten minutes by itself', (await req('POST', `/api/party-invoices/${r2.id}/copy`, { sid: admin })).status === 400);
    await unl(r2.id, admin);
    ck('Lock closes it at once', (await req('POST', `/api/party-invoices/${r2.id}/lock`, { sid: admin })).json.is_unlocked === false);
    ck('paying a LOCKED line still works', (await req('POST', '/api/party-invoice-payments', { sid: admin, body: { amount: 10, paid_on: '2026-10-07', mode: 'Wire', allocations: [{ row_id: r2.id, amount: 10 }] } })).status === 200);
    const lastPay = (await req('GET', '/api/party-invoices', { sid: admin })).json.payments.find((p) => p.amount === 10);
    await req('DELETE', `/api/party-invoice-payments/${lastPay.id}`, { sid: jarvis });

    await unl(r1.id, admin);
    const delAdmin = await req('DELETE', `/api/party-invoices/${r1.id}`, { sid: admin });
    ck('delete is locked to the Jarvis profile (admin refused, 403)', delAdmin.status === 403);
    const delPayAdmin = await req('DELETE', `/api/party-invoice-payments/${ok.json.payment.id}`, { sid: admin });
    ck('deleting a payment is locked the same way', delPayAdmin.status === 403);
    const delPaidRow = await req('DELETE', `/api/party-invoices/${r1.id}`, { sid: jarvis });
    ck('even the Jarvis profile cannot delete a line with money paid against it', delPaidRow.status === 400 && /delete that payment first/.test(delPaidRow.json.error));
    ck('delete the payment as the Jarvis profile', (await req('DELETE', `/api/party-invoice-payments/${ok.json.payment.id}`, { sid: jarvis })).status === 200);
    await unl(r1.id, jarvis);
    ck('then the line deletes', (await req('DELETE', `/api/party-invoices/${r1.id}`, { sid: jarvis })).status === 200 && !PI.list().some((r) => r.id === r1.id));
    ck('404 on a line that does not exist', (await req('DELETE', '/api/party-invoices/NOPE', { sid: jarvis })).status === 404);
    ck('unlock of a line that does not exist errors', (await unl('NOPE', admin)).status === 400);
    ck('nothing was written to bills, sales or the books', ['bills.json', 'sales.json', 'bill_payments.json', 'metals_trucking.json'].every((f) => !fs.existsSync(path.join(TMP, f))));

    const html = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    ck('screen calls every route tested here', ['/api/party-invoices/sync', "/api/party-invoice-payments'", '/api/party-invoices/\' + encodeURIComponent'].every((x) => html.includes(x)));
    ck('Pay modal: mode default is IN the list (an unlisted default posts an empty mode)', /regModes\.map\(\(m, i\) => `<option value="\$\{esc\(m\)\}"\$\{i === 0 \? ' selected'/.test(html));
    ck('Sync / Edit / Delete / Pay controls present', ['btnRegSync', 'btnRegPay', 'regEdit', 'regDel'].every((x) => html.includes(x)));
    // The Transport / Freight / Commission list tabs (loadParty) carry Delete too — the same DELETE route tested above.
    const lp = html.slice(html.indexOf('async function loadParty('), html.indexOf("document.querySelectorAll('.verify-subtab-btn').forEach((b) => b.addEventListener('click', () => {\n  const k"));
    ck('list tabs: a lock cell per row (Delete inside it) and a ticked "Delete selected"', /lockCell\(r, \{ edit: false, del: 'partyDel' \}\)/.test(lp) && /partyDelSel/.test(lp) && /partyCk/.test(lp));
    ck('list tabs: delete calls the route the e2e section just exercised, method DELETE', /api\('\/api\/party-invoices\/' \+ encodeURIComponent\(id\), \{ method: 'DELETE' \}\)/.test(lp));
    ck('both screens use the shared lock cell (Unlock -> Copy / Delete / Lock) and bind it', (html.match(/lockCell\(/g) || []).length >= 3 && /bindLockActions\(body, loadRegister\)/.test(html) && /bindLockActions\(box, \(\) => loadParty\(subtab\)\)/.test(html));
    ck('delete links have DISTINCT classes per screen (a shared one would fire two handlers)', /lockCell\(r, \{ edit: false, del: 'partyDel' \}\)/.test(html) && /del = 'regDel'/.test(html));
    ck('list tabs: asks before deleting, and reports lines the server refused', /confirm\(/.test(lp) && /not deleted/.test(lp));
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
