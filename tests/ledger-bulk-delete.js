// ── tests/ledger-bulk-delete.js ───────────────────────────────────────────
// Apsara, 2026-09-29: "What if i want to delte multiple rows in bills and
// invoice" — a bad import, an old date range, rows she picks on screen; and
// when a row has payments against it, refuse that one and take the rest.
//
// ── WHY THIS FILE IS MOSTLY ABOUT WHAT IS *NOT* DELETED ───────────────────
// deleteBill(id) finds the row, splices it out, returns. No check of any kind
// and no way back. One row at a time that is a small risk; a selection of
// forty is not, and two things go wrong quietly:
//
//   ORPHANED MONEY. A payment reaches a bill through allocations[].bill_id.
//   Delete the bill and the payment survives, allocated to an id nothing
//   answers to. It does not show as missing anywhere — the money simply stops
//   being attached to a cost. Section B.
//
//   NO WAY BACK. Section C.
//
// ── AND THE GUARD ITSELF HAS TO BE ABLE TO FIRE ───────────────────────────
// I wrote this exact check the wrong way earlier today, in
// scripts/bills-year-audit.js: it read `p.bill_id`, a field that exists
// nowhere in this codebase, so it counted zero payments everywhere and the
// refusal could never trigger. It passed its fixture because the fixture had
// the field I imagined. So section B uses the REAL shape — allocations[] —
// and section E proves the guard fires rather than assuming it.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bulkdel-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// Set BEFORE anything requires config.js, which reads these at require time.
// Setting them inside section H — where they are used — was too late: config
// had already been loaded by helpers/bills at the top of this file, the Jarvis
// login returned no sid, and eleven checks failed on a password that was
// present in the environment but not in the config the server was holding.
process.env.APP_PASSWORD    = process.env.APP_PASSWORD    || 'user-password-aaa';
process.env.ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || 'admin-password-bbb';
process.env.JARVIS_PASSWORD = process.env.JARVIS_PASSWORD || 'jarvis-password-ddd';

const ROOT = path.join(__dirname, '..');
const bd = require(path.join(ROOT, 'helpers/ledgerBulkDelete'));
const bills = require(path.join(ROOT, 'helpers/bills'));
const sales = require(path.join(ROOT, 'helpers/sales'));

const bill = (id, cont, o) => Object.assign({
    id, date: '2026-01-15', supplier: 'Fede', booking_no: 'BK1', container_no: cont,
    gross: 60000, truck: 14000, container: 5000, supplier_price: 0.32, advance: 0,
}, o || {});
const sale = (id, cont, o) => Object.assign({
    id, date: '2026-01-15', customer: 'MK Trading', booking_no: 'BK1', container_no: cont,
    weight: 20, price: 1000,
}, o || {});

const write = (name, rows) => fs.writeFileSync(path.join(TMP, name), JSON.stringify(rows, null, 1));
const idsIn = (store) => (store === 'bills' ? bills.list() : sales.list()).map((r) => String(r.id)).sort().join(',');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — it plans before it touches anything');
// ══════════════════════════════════════════════════════════════════════════
{
    write('bills.json', [bill('B1', 'AAAU1111111'), bill('B2', 'BBBU2222222'), bill('B3', 'CCCU3333333')]);
    write('bill_payments.json', []);

    const p = bd.plan('bills', ['B1', 'B3']);
    ck('the plan says what would go', p.going.map((r) => r.id).join(',') === 'B1,B3',
       p.going.map((r) => r.id).join(','));
    ck('  and nothing has been deleted yet', idsIn('bills') === 'B1,B2,B3', idsIn('bills'));
    ck('  it carries a batch id from the start', /^DEL_/.test(p.batch), p.batch);

    ck('an empty selection is refused outright', (() => {
        try { bd.plan('bills', []); return false; } catch (e) { return /no rows selected/.test(e.message); }
    })());
    ck('an unknown ledger is refused', (() => {
        try { bd.plan('loads', ['x']); return false; } catch (e) { return /unknown ledger/.test(e.message); }
    })());
    // Duplicated ids in a selection must not delete twice or report twice.
    ck('the same id twice is one row', bd.plan('bills', ['B1', 'B1']).counts.asked === 1);
    // A row that is already gone is reported, not silently dropped.
    const ghost = bd.plan('bills', ['B1', 'NOPE']);
    ck('an id that does not exist is reported', ghost.refused.some((r) => r.id === 'NOPE'),
       JSON.stringify(ghost.refused));
    ck('  and does not stop the rest', ghost.going.length === 1);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — MONEY. A row with payments is refused, the rest go');
// ══════════════════════════════════════════════════════════════════════════
// Her answer when asked: refuse it, delete the rest.
{
    write('bills.json', [bill('B1', 'AAAU1111111'), bill('B2', 'BBBU2222222'), bill('B3', 'CCCU3333333')]);
    // THE REAL SHAPE. One wire settling one container, through allocations.
    write('bill_payments.json', [{
        id: 'P1', date: '2026-02-01', supplier: 'Fede', amount: 4000, mode: 'Wire',
        allocations: [{ bill_id: 'B2', amount: 4000 }],
    }]);

    const p = bd.plan('bills', ['B1', 'B2', 'B3']);
    ck('the paid bill is refused', p.refused.some((r) => r.id === 'B2'), JSON.stringify(p.refused));
    ck('  and the reason names the amount', p.refused.some((r) => /4000/.test(r.why)),
       JSON.stringify(p.refused));
    ck('  the other two still go', p.going.map((r) => r.id).join(',') === 'B1,B3');

    const res = await bd.commit(p);
    ck('the paid bill survives the commit', idsIn('bills') === 'B2', idsIn('bills'));
    ck('  and the payment still points at a bill that exists',
       (require(path.join(ROOT, 'helpers/billPayments')).paidByBill() || {}).B2 === 4000);
    ck('  the refusals come back with the result', res.refused.length === 1);

    // A wire that settles SEVERAL containers protects every one of them.
    write('bills.json', [bill('C1', 'DDDU4444444'), bill('C2', 'EEEU5555555')]);
    write('bill_payments.json', [{
        id: 'P2', date: '2026-02-01', supplier: 'Fede', amount: 900, mode: 'Wire',
        allocations: [{ bill_id: 'C1', amount: 500 }, { bill_id: 'C2', amount: 400 }],
    }]);
    const p2 = bd.plan('bills', ['C1', 'C2']);
    ck('one wire across two containers protects both', p2.going.length === 0 && p2.refused.length === 2,
       JSON.stringify(p2.counts));
}

// ══════════════════════════════════════════════════════════════════════════
section('B2 — the same, for invoices');
// ══════════════════════════════════════════════════════════════════════════
// Receipts reach a sale through allocations[].sale_id — the same shape, a
// different file. A deduction counts too: a container settled partly by
// credit note still has something pointing at it.
{
    write('sales.json', [sale('S1', 'AAAU1111111'), sale('S2', 'BBBU2222222')]);
    write('sales_receipts.json', [{
        id: 'R1', date: '2026-02-01', customer: 'MK Trading', amount: 2000,
        allocations: [{ sale_id: 'S2', amount: 2000 }],
    }]);

    const p = bd.plan('sales', ['S1', 'S2']);
    ck('an invoice with a receipt is refused', p.refused.some((r) => r.id === 'S2'),
       JSON.stringify(p.refused));
    ck('  and the unpaid one goes', p.going.map((r) => r.id).join(',') === 'S1');
    await bd.commit(p);
    ck('  the receipted invoice survives', idsIn('sales') === 'S2', idsIn('sales'));

    // ── SETTLED ENTIRELY BY CREDIT NOTE ───────────────────────────────────
    // No cash against it at all: the only thing pointing at this invoice is a
    // deduction. deductedBySale() returns { total, bank_charge, discount } per
    // sale, and reading that object as a number gives NaN, which plan()'s
    // `Number(x) || 0` quietly turns back into 0 — unpaid, delete it. This is
    // the check that catches that; the source regex above did not.
    write('sales.json', [sale('S3', 'FFFU6666666'), sale('S4', 'GGGU7777777')]);
    write('sales_receipts.json', [{
        id: 'R2', date: '2026-02-02', customer: 'MK Trading', amount: 0,
        allocations: [{ sale_id: 'S4', amount: 0, deduction_amount: 1500, deduction_reason: 'discount' }],
    }]);
    const p3 = bd.plan('sales', ['S3', 'S4']);
    ck('an invoice settled only by credit note is refused',
       p3.refused.some((r) => r.id === 'S4'), JSON.stringify(p3.refused));
    ck('  and the reason names the 1500', p3.refused.some((r) => /1500/.test(r.why)),
       JSON.stringify(p3.refused));
    ck('  the clean one still goes', p3.going.map((r) => r.id).join(',') === 'S3',
       p3.going.map((r) => r.id).join(','));
}

// ══════════════════════════════════════════════════════════════════════════
section('B3 — A CLAIM AGAINST THE ROW');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-29: "What if we receive a claim against that invoice?"
//
// THE REASON THIS IS A SEPARATE SECTION: a claim carries NO sale_id and no
// bill_id. helpers/claims.js keys it on invoice_no|container_no. So the guard
// in B and B2 — which reads allocations by ROW ID — is looking somewhere a
// claim has never been, and returns "nothing allocated" against a claimed
// invoice every time. The checks below are on the container, which is the
// field a claim actually carries.
{
    write('bills.json', [bill('K1', 'JJJU1111111'), bill('K2', 'KKKU2222222')]);
    write('bill_payments.json', []);
    write('sales.json', [sale('T1', 'JJJU1111111'), sale('T2', 'KKKU2222222')]);
    write('sales_receipts.json', []);
    write('claims.json', [{
        id: 'CL1', key: 'INV-900|JJJU1111111', status: 'verified',
        claim_type: 'weight_shortage', customer: 'MK Trading', supplier: 'Calderon',
        invoice_no: 'INV-900', container_no: 'JJJU1111111',
        claim_amount: 3100, our_claim: 2800, evidence: [], mail: [], flags: [], history: [],
    }]);

    // ── THE INVOICE SIDE — her question, literally ────────────────────────
    const pS = bd.plan('sales', ['T1', 'T2']);
    ck('an invoice with an open claim is refused',
       pS.refused.some((r) => r.id === 'T1'), JSON.stringify(pS.refused));
    ck('  and the reason says it is a claim',
       pS.refused.some((r) => /claim/i.test(r.why)), JSON.stringify(pS.refused));
    ck('  naming the container it is against',
       pS.refused.some((r) => /JJJU1111111/.test(r.why)), JSON.stringify(pS.refused));
    ck('  the unclaimed invoice still goes', pS.going.map((r) => r.id).join(',') === 'T2',
       pS.going.map((r) => r.id).join(','));

    // ── THE BILL SIDE ─────────────────────────────────────────────────────
    // raiseRecovery() goes after the SUPPLIER on that container ("recovery
    // raised on supplier"), so the bill is part of the same claim. Deleting
    // it leaves the recovery with no cost document behind it.
    const pB = bd.plan('bills', ['K1', 'K2']);
    ck('the BILL for a claimed container is refused too',
       pB.refused.some((r) => r.id === 'K1'), JSON.stringify(pB.refused));
    ck('  and the clean bill is untouched', pB.going.map((r) => r.id).join(',') === 'K2',
       pB.going.map((r) => r.id).join(','));

    // ── A CLOSED CLAIM DOES NOT BLOCK FOREVER ─────────────────────────────
    // My call, not hers, and flagged as such in the helper: settled/rejected/
    // withdrawn let the row go, or an old invoice could never be cleared once
    // anyone had ever claimed on it.
    for (const st of ['settled', 'rejected', 'withdrawn']) {
        write('claims.json', [{
            id: 'CL2', key: 'INV-900|JJJU1111111', status: st,
            invoice_no: 'INV-900', container_no: 'JJJU1111111',
            claim_amount: 3100, evidence: [], mail: [], flags: [], history: [],
        }]);
        const p = bd.plan('sales', ['T1']);
        ck(`  a ${st} claim does not block the delete`, p.going.length === 1,
           JSON.stringify(p.refused));
    }

    // ── A CLAIM WHOSE FILE CANNOT BE READ ─────────────────────────────────
    // Same rule as the payments file: cannot tell is not nothing to worry
    // about. loadJson would hand back [] and every claimed row would go.
    fs.writeFileSync(path.join(TMP, 'claims.json'), '{ this is not json');
    let threw = null;
    try { bd.plan('sales', ['T1', 'T2']); } catch (e) { threw = e.message; }
    ck('an unreadable claims file stops the delete', !!threw, 'it returned a plan instead');
    ck('  and says which file', /claim/i.test(threw || ''), threw || '');
    write('claims.json', []);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — THE WAY BACK');
// ══════════════════════════════════════════════════════════════════════════
// The single-row path has none. A bulk one without it is the bug this whole
// file is guarding against.
{
    write('bills.json', [bill('D1', 'FFFU1111111'), bill('D2', 'GGGU2222222'), bill('D3', 'HHHU3333333')]);
    write('bill_payments.json', []);

    const p = bd.plan('bills', ['D1', 'D2'], { reason: 'a bad import' });
    const res = await bd.commit(p);
    ck('two go', res.removed === 2 && idsIn('bills') === 'D3', idsIn('bills'));

    ck('the deletion is listed so it can be named', bd.batches().some((b) => b.batch === res.batch),
       JSON.stringify(bd.batches()));
    ck('  with the reason she gave', bd.batches().find((b) => b.batch === res.batch).reason === 'a bad import');

    const back = await bd.restore(res.batch);
    ck('restoring puts them back', back === 2 && idsIn('bills') === 'D1,D2,D3', idsIn('bills'));

    // The rows must come back WHOLE, not as stubs.
    const d1 = bills.list().find((r) => r.id === 'D1');
    ck('  with every field intact', d1 && d1.supplier === 'Fede' && d1.gross === 60000 && d1.container_no === 'FFFU1111111',
       JSON.stringify(d1));

    // Restoring twice must not duplicate — two bills on one container is the
    // finding the nightly sweep exists to report, and restore must not make
    // one.
    const again = await bd.restore(res.batch);
    ck('restoring twice adds nothing', again === 0 && idsIn('bills') === 'D1,D2,D3', idsIn('bills'));

    ck('an unknown batch is refused', await (async () => {
        try { await bd.restore('DEL_nope'); return false; } catch (e) { return /no deletion/.test(e.message); }
    })());
    ck('restore with no batch id is refused', await (async () => {
        try { await bd.restore(); return false; } catch (e) { return /batch id is required/.test(e.message); }
    })());
}

// ══════════════════════════════════════════════════════════════════════════
section('D — archived BEFORE removed, never after');
// ══════════════════════════════════════════════════════════════════════════
// In that order deliberately: if the archive write fails the rows are still in
// the ledger and nothing is lost. The other order loses them both.
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/ledgerBulkDelete.js'), 'utf8');
    const archiveAt = src.indexOf('mutateJson(ARCHIVE');
    const removeAt = src.indexOf('mutateJson(K.file()');
    ck('the archive write comes first in commit()', archiveAt > 0 && removeAt > archiveAt,
       `archive at ${archiveAt}, remove at ${removeAt}`);

    // And both writes are strict — a silent failure here would report a
    // deletion that did not happen, or lose the archive of one that did.
    ck('both writes are strict', (src.match(/\{ strict: true \}/g) || []).length >= 3,
       'helpers/json.js returns the PREVIOUS contents on a non-strict failure');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the guard can actually fire');
// ══════════════════════════════════════════════════════════════════════════
// The lesson from scripts/bills-year-audit.js this morning: that guard read
// `p.bill_id`, which exists nowhere, so it counted zero payments and could
// never refuse anything. It passed its fixture because the fixture had the
// field I had imagined. So: prove the reader here is the ledger's own.
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/ledgerBulkDelete.js'), 'utf8');
    ck('bills reuse paidByBill, not a second reading of the file',
       /require\('\.\/billPayments'\)\.paidByBill\(\)/.test(src));
    ck('invoices reuse receivedBySale', /receivedBySale\(\)/.test(src));
    ck('  and count deductions too', /deductedBySale/.test(src),
       'a container settled by credit note still has money pointing at it');
    // Code only — the comment above deliberately NAMES the wrong field, and
    // the first version of this check matched its own explanation.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    ck('no flat bill_id is read anywhere', !/\bp\.bill_id\b|row\.bill_id/.test(code),
       'the field that made the last guard unable to fire');

    // If the payments file cannot be read, nothing may be deleted — an
    // unreadable ledger must not look like "no payments".
    write('bills.json', [bill('X1', 'IIIU1111111')]);
    fs.writeFileSync(path.join(TMP, 'bill_payments.json'), '{ not json');
    let threw = null;
    try { bd.plan('bills', ['X1']); } catch (e) { threw = e.message; }
    ck('an unreadable payments file stops the delete', threw !== null, 'it returned a plan instead');
    ck('  and says why', threw === null || /payments/.test(threw), threw);
    ck('  the row is untouched', idsIn('bills') === 'X1');
}

// ══════════════════════════════════════════════════════════════════════════
section('G — THE THREE WAYS IN');
// ══════════════════════════════════════════════════════════════════════════
// She was asked which she needed and answered "1,2,3": a bad import, a date
// range, and rows she ticks. All three resolve to a list of ids and go
// through plan(), so the guards above are the only exit — a selector that
// bypassed them would be a second, unguarded delete.
{
    write('bills.json', [
        bill('G1', 'AAAU0000001', { date: '01/10/2026', imported_batch: 'IMP_A' }),
        bill('G2', 'BBBU0000002', { date: '02/14/2026', imported_batch: 'IMP_A' }),
        bill('G3', 'CCCU0000003', { date: '08/20/2026', imported_batch: 'IMP_B' }),
        bill('G4', 'DDDU0000004', { date: '09/01/2026', supplier: 'Calderon' }),
    ]);
    write('bill_payments.json', []);
    write('claims.json', []);

    // 1 — rows ticked on screen
    const ticked = bd.planBy('bills', { ids: ['G1', 'G4'] });
    ck('ticked rows resolve to exactly those rows',
       ticked.going.map((r) => r.id).sort().join(',') === 'G1,G4',
       ticked.going.map((r) => r.id).join(','));

    // 2 — a bad import, by batch
    const imp = bd.planBy('bills', { import_batch: 'IMP_A' });
    ck('an import batch picks up its own rows and only those',
       imp.going.map((r) => r.id).sort().join(',') === 'G1,G2',
       imp.going.map((r) => r.id).join(','));
    ck('  and says what it matched', /IMP_A/.test(imp.how || ''), imp.how);

    // 3 — a date range, through the SCREEN's own filter
    const range = bd.planBy('bills', { filters: { from: '01/01/2026', to: '02/28/2026' } });
    ck('a date range picks the rows in it',
       range.going.map((r) => r.id).sort().join(',') === 'G1,G2',
       range.going.map((r) => r.id).join(','));
    ck('  and nothing outside it', !range.going.some((r) => r.id === 'G3' || r.id === 'G4'));

    // Same query object the screen sends, so a supplier filter narrows too.
    const supp = bd.planBy('bills', { filters: { supplier: 'Calderon' } });
    ck('any ledger filter works, not just dates',
       supp.going.map((r) => r.id).join(',') === 'G4', supp.going.map((r) => r.id).join(','));

    // ── THE ONE THAT MUST NEVER MEAN "EVERYTHING" ─────────────────────────
    // An empty filter object reaching filterRows matches every row. If that
    // became a plan, one stray press with the filters cleared would take the
    // whole ledger. It has to throw, not return 400 rows.
    let threw = null;
    try { bd.planBy('bills', { filters: {} }); } catch (e) { threw = e.message; }
    ck('an EMPTY filter refuses instead of selecting everything', !!threw,
       'it returned a plan for the entire ledger');
    let threw2 = null;
    try { bd.planBy('bills', {}); } catch (e) { threw2 = e.message; }
    ck('  and so does a selector with nothing in it at all', !!threw2, threw2 || 'no throw');

    // A selector that matches nothing is not an error — it is an empty plan.
    const none = bd.planBy('bills', { import_batch: 'IMP_NOPE' });
    ck('a batch that matches nothing is an empty plan, not a throw',
       none.going.length === 0 && none.counts.asked === 0);

    // The guards still apply through a selector — this is the whole point.
    write('bill_payments.json', [{
        id: 'GP1', date: '02/20/2026', supplier: 'Fede', amount: 500, mode: 'Wire',
        allocations: [{ bill_id: 'G2', amount: 500 }],
    }]);
    const guarded = bd.planBy('bills', { import_batch: 'IMP_A' });
    ck('A SELECTOR DOES NOT BYPASS THE PAYMENT GUARD',
       guarded.refused.some((r) => r.id === 'G2'), JSON.stringify(guarded.refused));
    ck('  and the unpaid one in the same batch still goes',
       guarded.going.map((r) => r.id).join(',') === 'G1', guarded.going.map((r) => r.id).join(','));
    write('bill_payments.json', []);
}

// ══════════════════════════════════════════════════════════════════════════
section('H — END TO END, through the real routes');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
//
// Everything above is the helper. The helper being right is not the feature
// working: the route may not forward the selector, the client may send `kind`
// where the route reads `ledger`, the lock may be on the wrong verb. So: a
// real server, a real login, posted the way the modal posts it, and the rows
// read back out of the ledger route the screen actually reads.
//
// Measured as a DELTA — sections above have already written to this store,
// and a test that breaks when an unrelated fixture moves gets deleted.
{
    const http = require('http');

    write('bills.json', [
        bill('H1', 'EEEU0000001', { date: '03/01/2026' }),
        bill('H2', 'FFFU0000002', { date: '03/02/2026' }),
        bill('H3', 'GGGU0000003', { date: '03/03/2026' }),
    ]);
    write('bill_payments.json', [{
        id: 'HP1', date: '03/05/2026', supplier: 'Fede', amount: 700, mode: 'Wire',
        allocations: [{ bill_id: 'H2', amount: 700 }],
    }]);
    write('claims.json', []);

    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, pth, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + pth, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const jarvis = ((await req('POST', '/login', { body: { password: process.env.JARVIS_PASSWORD } })).json || {}).sid;
    const admin  = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in as the Jarvis profile', !!jarvis);
    ck('  and as a plain admin', !!admin);

    // ── THE LOCK ──────────────────────────────────────────────────────────
    // /api/bills/:id is open to an admin, because one bill is an admin's to
    // correct. A SELECTION is not: it is the one control that can empty a
    // year in a press, so it carries the same lock as every other deletion of
    // Edge Metals money. Hiding the button is not a permission — this is.
    const asAdmin = await req('POST', '/api/ledger/bulk-delete/commit',
        { sid: admin, body: { kind: 'bills', selector: { ids: ['H1'] } } });
    ck('a plain admin CANNOT bulk delete', asAdmin.status === 403, String(asAdmin.status));
    ck('  and the row is still there', bills.list().some((b) => b.id === 'H1'));

    // ── PLAN CHANGES NOTHING ──────────────────────────────────────────────
    const before = bills.list().length;
    const plan = await req('POST', '/api/ledger/bulk-delete/plan',
        { sid: jarvis, body: { kind: 'bills', selector: { ids: ['H1', 'H2', 'H3'] } } });
    ck('the plan route answers', plan.status === 200, String(plan.status));
    ck('  the paid one is refused', (plan.json.refused || []).some((r) => r.id === 'H2'),
       JSON.stringify(plan.json.refused));
    ck('  two are going', (plan.json.going || []).length === 2,
       String((plan.json.going || []).length));
    ck('  AND NOTHING WAS DELETED BY PLANNING', bills.list().length === before,
       `${before} -> ${bills.list().length}`);

    // ── COMMIT, THROUGH THE ROUTE THE MODAL POSTS TO ──────────────────────
    const done = await req('POST', '/api/ledger/bulk-delete/commit',
        { sid: jarvis, body: { kind: 'bills', selector: { ids: ['H1', 'H2', 'H3'] }, reason: 'typed twice' } });
    ck('the commit route answers', done.status === 200, JSON.stringify(done.json));
    ck('  it removed two', done.json.removed === 2, String(done.json.removed));

    // Read back out of the route the SCREEN reads, not the helper.
    const listed = await req('GET', '/api/bills', { sid: jarvis });
    const left = (listed.json.bills || []).map((b) => b.id);
    ck('the ledger route no longer returns them', !left.includes('H1') && !left.includes('H3'),
       left.join(','));
    ck('  and the paid one is still on the books', left.includes('H2'), left.join(','));
    ck('  the payment still points at a bill that exists',
       (require(path.join(ROOT, 'helpers/billPayments')).paidByBill() || {}).H2 === 700);

    // ── AND BACK AGAIN ────────────────────────────────────────────────────
    const back = await req('POST', '/api/ledger/bulk-delete/restore',
        { sid: jarvis, body: { batch: done.json.batch } });
    ck('restore answers', back.status === 200, String(back.status));
    ck('  it put both back', back.json.restored === 2, String(back.json.restored));
    const again = await req('GET', '/api/bills', { sid: jarvis });
    const now = (again.json.bills || []).map((b) => b.id);
    ck('  and the ledger route shows them again',
       now.includes('H1') && now.includes('H3'), now.join(','));

    // ── THE SELECTOR IS RE-PLANNED SERVER SIDE ────────────────────────────
    // The client posts the selector, never the row list it was shown. If the
    // route trusted a posted list, the guards would be decided by whoever
    // holds the page — so a commit naming the PAID row directly must still
    // refuse it.
    const sneaky = await req('POST', '/api/ledger/bulk-delete/commit',
        { sid: jarvis, body: { kind: 'bills', selector: { ids: ['H2'] },
                               going: [{ id: 'H2' }], refused: [] } });
    ck('a commit cannot smuggle past the guard', sneaky.json.removed === 0,
       JSON.stringify(sneaky.json));
    ck('  the paid bill survives it', bills.list().some((b) => b.id === 'H2'));

    await new Promise((r) => server.close(r));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
