// ── tests/proforma-copy.js ────────────────────────────────────────────────
// Apsara, 2026-09-17: "copy option so that itwill get coppied to proforma for
// say..", and, asked what Copy should produce: "A new proforma, pre-filled".
//
// ── WHAT IS ACTUALLY AT RISK ────────────────────────────────────────────────
// Copying a document is one keystroke away from sending the wrong one:
//
//   the new proforma carries the OLD invoice number, so two documents claim
//     one identity and the second replaces the first everywhere it is keyed;
//   it carries the old CONTAINER numbers, putting a container already on the
//     water onto a document for a shipment that has not sailed;
//   it carries the old DATE, so a proforma sent today reads three weeks old;
//   Copy is offered on a proforma with no stored form and does nothing when
//     pressed;
//   the form state outlives the PDF she deleted.
//
// Every section below is one of those.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pfcopy-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// BEFORE config.js is required below — it reads these once, at load, and
// caches. Set inside the end-to-end section they arrive too late and every
// login 401s, which reads as a broken route rather than a broken fixture.
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(os.tmpdir())) {
    console.error('REFUSING TO RUN: DATA_DIR is not a temp directory — this test writes.');
    process.exit(1);
}
const pv = require(path.join(ROOT, 'helpers/proformaVersions'));
const documentsSaved = require(path.join(ROOT, 'helpers/documentsSaved'));

// A realistic payload — the shape pfPayload() builds on the website.
const PAYLOAD = {
    inv_no: '260901_AC_26JY95', inv_date: '2026-09-01', reference: 'REF-1',
    qty_unit: 'MT', consignee: 'Taewon', consignee_sheet_tag: 'Joey/Taewon',
    consignee_address: ['TAEWON METAL', '55 HARBOUR WAY, BUSAN', 'KOREA'],
    trade_terms: 'CIF BUSAN', port_discharge: 'BUSAN',
    payment_term: 'T/T 100% Against Shipping Documents',
    freight_label: 'CIF (freight included)', buyer_po: 'PO-77', buyer_po_date: '2026-08-20',
    country_of_origin: 'USA', shipment_allowance: '+/- 10% on weights',
    containers: [
        { container_no: '26JY95', item_code: 'AC', items: [
            { desc: 'AC Compressor', qty: 20, rate: 1450, unit: 'MT' },
            { desc: 'Alternator', qty: 5, rate: 1200, unit: 'MT' },
        ] },
        { container_no: '26JY96', item_code: 'AC', items: [
            { desc: 'AC Compressor', qty: 20, rate: 1450, unit: 'MT' },
        ] },
    ],
};

(async () => {

// ── A. The store ────────────────────────────────────────────────────────────
section('A. helpers/proformaVersions');

await pv.saveProformaPayload('260901_AC_26JY95_Taewon.pdf', PAYLOAD);

let back = pv.getProformaPayload('260901_AC_26JY95_Taewon.pdf');
ck('a saved payload comes back', !!back);
ck('  with the consignee', back.consignee === 'Taewon');
ck('  the address lines', Array.isArray(back.consignee_address) && back.consignee_address.length === 3);
ck('  the sheet tag, which cannot be rebuilt from the name',
   back.consignee_sheet_tag === 'Joey/Taewon',
   'the Edge Metals sheet files this under a tag the consignee name does not carry');
ck('  both containers', (back.containers || []).length === 2);
ck('  and every item on them',
   back.containers[0].items.length === 2 && back.containers[0].items[1].rate === 1200);
ck('  stamped with when it was generated', !!back.saved_at);

// A path must not create an entry the saved list can never match.
await pv.saveProformaPayload('/var/tmp/somewhere/PATHY_Taewon.pdf', { consignee: 'X' });
ck('a full path is keyed by its basename',
   !!pv.getProformaPayload('PATHY_Taewon.pdf'),
   'the entry was keyed on a path, so the Copy button would never find it');

ck('an unknown file has no payload — null, not a throw',
   pv.getProformaPayload('NEVER_EXISTED.pdf') === null);
ck('  and neither does an empty name', pv.getProformaPayload('') === null);

// ── B. Which rows get a button ──────────────────────────────────────────────
section('B. copyableSet');

const set = pv.copyableSet(['260901_AC_26JY95_Taewon.pdf', 'OLD_ONE.pdf']);
ck('a stored proforma is copyable', set['260901_AC_26JY95_Taewon.pdf'] === true);
ck('one from before this existed is NOT',
   set['OLD_ONE.pdf'] === false,
   'she would be shown a Copy button that finds nothing when pressed');

// ── C. It is bounded ────────────────────────────────────────────────────────
// One entry per proforma, forever, read on every generate. Oldest go first.
section('C. the store does not grow without limit');

for (let i = 0; i < pv.MAX_ENTRIES + 20; i++) {
    await pv.saveProformaPayload(`BULK_${String(i).padStart(4, '0')}.pdf`,
        { consignee: 'Bulk', saved_at_hint: i });
}
const all = require(path.join(ROOT, 'helpers/json'))
    .loadJson(cfg.PROFORMA_VERSIONS_FILE, {});
ck('it is capped', Object.keys(all).length <= pv.MAX_ENTRIES,
   `${Object.keys(all).length} entries`);
ck('  and the NEWEST survive', !!pv.getProformaPayload(`BULK_${String(pv.MAX_ENTRIES + 19).padStart(4, '0')}.pdf`),
   'the cap dropped the most recent instead of the oldest');
ck('  while the oldest are gone', pv.getProformaPayload('BULK_0000.pdf') === null);

// ── D. Forgetting ───────────────────────────────────────────────────────────
section('D. the form state goes with the PDF');

await pv.saveProformaPayload('TO_DELETE_Taewon.pdf', PAYLOAD);
ck('it is there first', !!pv.getProformaPayload('TO_DELETE_Taewon.pdf'));
ck('forgetting it reports true', (await pv.forgetProformaPayload('TO_DELETE_Taewon.pdf')) === true);
ck('  and it is gone', pv.getProformaPayload('TO_DELETE_Taewon.pdf') === null);
ck('forgetting one that was never there is false, not a throw',
   (await pv.forgetProformaPayload('NOPE.pdf')) === false);

// ── E. THROUGH THE REAL ROUTES ──────────────────────────────────────────────
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
// The store working proves nothing about whether the generate route FILES a
// payload, whether the copy route strips the invoice number, or whether the
// delete route takes the form state with it.
section('E. end to end');
{
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;

    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
    });

    const admin = ((await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } })).json || {}).sid;
    ck('logged in', !!admin);

    // Stand a saved proforma up the way the generate route does, since the
    // PDF itself needs Chromium and this sandbox has none.
    const savedName = 'E2E_260901_AC_26JY95_Taewon.pdf';
    documentsSaved.saveProformaCopy(Buffer.from('%PDF-1.4 e2e\n%%EOF'), savedName);
    await pv.saveProformaPayload(savedName, PAYLOAD);

    const listed = await req('GET', '/api/proforma/copyable', { sid: admin });
    ck('the route reports which saved proformas are copyable',
       listed.status === 200 && listed.json.copyable[savedName] === true,
       JSON.stringify(listed.json));

    const got = await req('GET', '/api/proforma/saved-payload?file=' + encodeURIComponent(savedName), { sid: admin });
    ck('the payload comes back through the route', got.status === 200 && !!got.json.payload);

    // The one thing that must not travel.
    ck('THE INVOICE NUMBER IS NOT HANDED BACK',
       got.json.payload.inv_no === undefined,
       'two proformas would carry one number, and the second replaces the first');
    ck('  but everything else is', got.json.payload.consignee === 'Taewon'
       && got.json.payload.containers.length === 2);
    ck('  and it says when the original was generated', !!got.json.generated_at);

    const missing = await req('GET', '/api/proforma/saved-payload?file=NOT_STORED.pdf', { sid: admin });
    ck('a proforma with no stored form is a 404 that explains itself',
       missing.status === 404 && missing.json.code === 'NO_PAYLOAD',
       JSON.stringify(missing.json));

    // Staff must not read a customer's prices off a stored proforma.
    const staff = ((await req('POST', '/login', { body: { password: 'staff-pw-ccccccccccc' } })).json || {}).sid;
    const denied = await req('GET', '/api/proforma/saved-payload?file=' + encodeURIComponent(savedName), { sid: staff });
    ck('staff cannot read a saved proforma payload', [401, 403].includes(denied.status), String(denied.status));

    // ── DELETING THE PDF TAKES THE FORM WITH IT ─────────────────────────
    const del = await req('DELETE', '/api/documents/saved?kind=proforma&file=' + encodeURIComponent(savedName), { sid: admin });
    ck('the document deletes', del.status === 200, JSON.stringify(del.json));
    ck('  and the stored form goes with it',
       pv.getProformaPayload(savedName) === null,
       'Copy would be offered on a row that no longer exists');

    listener.close();
}

// ── F. THE SCREEN ───────────────────────────────────────────────────────────
// The route stripping inv_no is worth nothing if the client puts the old
// container numbers back, or leaves the copy banner up over the next one.
section('F. the form is filled, and what is left blank is said');
{
    const DOCS = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    const dom = new JSDOM(DOCS, { runScripts: 'dangerously', url: 'http://localhost/documents',
        beforeParse(w) {
            w.alert = () => {}; w.confirm = () => true;
            w.URL.createObjectURL = () => 'blob:stub'; w.URL.revokeObjectURL = () => {};
            w.HTMLElement.prototype.scrollIntoView = () => {};
            w.fetch = (url) => {
                const u = String(url);
                if (u.includes('/api/documents/saved')) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
                        invoices: [], bols: [],
                        proformas: ['260901_AC_26JY95_Taewon.pdf', 'ANCIENT_ONE.pdf'],
                    }) });
                }
                if (u.includes('/api/proforma/copyable')) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
                        copyable: { '260901_AC_26JY95_Taewon.pdf': true, 'ANCIENT_ONE.pdf': false },
                    }) });
                }
                if (u.includes('/api/proforma/saved-payload')) {
                    // Deliberately hands back the FULL payload, inv_no and
                    // all — even though the real route strips it. Stubbing a
                    // stripped payload meant the client's own blanking was
                    // never exercised: a mutation making it fill pf_inv_no
                    // from the payload stayed green. Two independent guards
                    // are only two guards if both are tested.
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
                        ok: true, payload: { ...PAYLOAD }, generated_at: '2026-09-01T18:00:00.000Z',
                    }) });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, packing_lists: [], bols: [] }) });
            };
        } });
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window, d = w.document;

    [...d.querySelectorAll('.subtab-btn')].find((b) => b.dataset.subtab === 'proforma')
        .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));

    const copyBtns = d.querySelectorAll('.pf-copy');
    ck('a stored proforma gets a Copy button', copyBtns.length === 1, `${copyBtns.length} buttons`);
    ck('  and one from before this feature does NOT',
       !/ANCIENT_ONE\.pdf<\/td>\s*<td>[^<]*<a[^>]*>Open<\/a><\/td>\s*<td><button[^>]*pf-copy/.test(d.getElementById('pfSavedList').innerHTML)
       && copyBtns.length === 1,
       'she would press a button that cannot do anything');

    // ── COPY OVER A FORM THAT IS ALREADY FILLED ─────────────────────────
    // The realistic second copy: she copies one proforma, then copies
    // another. Container numbers left from the first must not survive into
    // the second. Without this the clearing line is never exercised —
    // addContainer() takes ITEMS only and never sets a container number, so
    // deleting the clear changed nothing and the mutation stayed green.
    w.eval("addContainer([{desc:'Stale',qty:1,rate:1}]);");
    d.querySelectorAll('#pfContainers .container-no').forEach((el) => { el.value = 'LEFTOVER123'; });
    d.getElementById('pf_inv_no').value = 'LEFTOVER_INV';
    d.getElementById('pf_inv_date').value = '08/01/2026';

    copyBtns[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));

    ck('the full form is shown, not the wizard',
       !d.getElementById('pfFullForm').classList.contains('hidden')
       && d.getElementById('pfWizard').classList.contains('hidden'));

    ck('the consignee is filled', d.getElementById('pf_consignee').value === 'Taewon');
    ck('  the address too',
       /55 HARBOUR WAY/.test(d.getElementById('pf_consignee_address').value),
       d.getElementById('pf_consignee_address').value);
    ck('  the trade terms', d.getElementById('pf_trade_terms').value === 'CIF BUSAN');
    ck('  the payment term',
       /T\/T 100%/.test(d.getElementById('pf_payment_term').value));
    ck('  and the sheet tag rides along',
       w.eval('window._pfConsigneeSheetTag') === 'Joey/Taewon',
       'the Edge Metals sheet row would be filed under the wrong tag');

    // ── THE THREE THINGS THAT MUST NOT BE COPIED ────────────────────────
    // Blanked by the CLIENT here: the stub above deliberately sends inv_no,
    // so this proves the screen does not rely solely on the route stripping it.
    ck('THE INVOICE NUMBER IS BLANK', d.getElementById('pf_inv_no').value === '',
       `it carried ${d.getElementById('pf_inv_no').value} — two documents, one identity`);
    ck('THE DATE IS BLANK', d.getElementById('pf_inv_date').value === '',
       'a proforma sent today would read three weeks old');

    const containerNos = [...d.querySelectorAll('#pfContainers .container-no')].map((el) => el.value);
    ck('both containers are rebuilt', containerNos.length === 2, `${containerNos.length}`);
    ck('THE CONTAINER NUMBERS ARE BLANK', containerNos.every((v) => v === ''),
       `carried ${JSON.stringify(containerNos)} — a container already on the water on a new document`);
    ck('  including any left over from a previous copy',
       !containerNos.includes('LEFTOVER123'),
       'the previous proforma\'s container numbers survived into this one');
    // The guarantee is structural: the container list is emptied and rebuilt,
    // and addContainer() has no container-number parameter. Stated here
    // because an explicit clearing line was removed once it turned out to
    // clear nothing — and to also wipe the auto-code she does want.
    ck('    and blankness comes from rebuilding, not from a clearing line',
       !/querySelectorAll\('\.container-no'\)[^\n]*value = ''/.test(
           fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8')),
       'dead defensive code is back, and it wipes the running container-code sequence');

    // The items ARE the copy.
    const descs = [...d.querySelectorAll('#pfContainers .item-desc')].map((el) => el.value);
    const rates = [...d.querySelectorAll('#pfContainers .item-rate')].map((el) => el.value);
    ck('the items come across', descs.filter((x) => /AC Compressor/i.test(x)).length === 2
       && descs.some((x) => /Alternator/i.test(x)), JSON.stringify(descs));
    ck('  with their rates', rates.includes('1450') && rates.includes('1200'), JSON.stringify(rates));

    const note = d.getElementById('pfCopyNote');
    ck('she is told what it was copied from',
       !note.classList.contains('hidden') && /260901_AC_26JY95_Taewon\.pdf/.test(note.textContent),
       note.textContent);
    ck('  and that the number and date are deliberately blank',
       /invoice number and date are blank/i.test(note.textContent), note.textContent);

    // The banner belongs to ONE copied document.
    w.eval('resetWizard()');
    ck('starting a fresh proforma clears the copy banner',
       note.classList.contains('hidden'),
       'the next proforma would claim it was copied from a document it has nothing to do with');

    dom.window.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log('Failures:\n  ' + failures.join('\n  '));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => {
    console.error('CRASHED:', e && e.stack);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
    process.exit(1);
});
