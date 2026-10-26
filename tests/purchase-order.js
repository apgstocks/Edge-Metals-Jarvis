// ── tests/purchase-order.js ───────────────────────────────────────────────
// Apsara, 2026-10-26: "Create a purchase order tab in documents."
//
// The tab writes nothing and calls no route of its own, so the ways it can go
// wrong are on the page: the wrong company on a commitment, a total that does
// not match its lines, a typed value that becomes markup, a print window that
// opens on an incomplete order, and a new panel that leaks onto other tabs.
// This boots the real page and drives the real tab.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'documents.html'), 'utf8');

const ACCOUNTS = [
    { id: 'edge-metals-bofa', company: 'Edge Metals INC', address: '14750 Devonshire Ln, Frisco, TX 75035', accountNumber: 'X' },
    { id: 'edge-trading-chase', company: 'EDGE TRADING INC', address: '2453 E 25th Street, Los Angeles, CA 90058', accountNumber: 'Y' },
];
const SIG = require('../helpers/signature').signatureDataUrl();
const BOOK = [
    { id: 's1', aliases: ['Ray'], raw: 'Ray Scrap Co\n12 Yard Rd\nBrea CA 92821' },
    { id: null, aliases: ['Marta/Sunrise Recycling'], raw: 'Sunrise Recycling\n9 Harbour St' },
    { id: 'm1', aliases: ['MK Metal Trading'], raw: 'MK Metal Trading\n5 Foundry Ave\nCarson CA 90745' },
    { id: 'd1', aliases: ['Daekwang'], raw: 'Daekwang Metals\n77 Pier Rd' },
    { id: 'r2', aliases: ['Rays Recycling'], raw: 'Rays Recycling\n3 Oak St' },
    { id: 't1', aliases: ['Tom'], raw: 'Tom Haulage\n8 Quay Rd\nSan Pedro CA' },
    { id: 'z1', aliases: ['Zed'], raw: 'Zed Co\n1 Metaltrader Way' },
    { id: 'w1', aliases: ['Twin Metals'], raw: 'Twin Metals\n1 North St' },
    { id: 'w2', aliases: ['Twin Metals'], raw: 'Twin Metals\n2 South St' },
];

(async () => {
    const hits = [];
    const dom = new JSDOM(SRC, {
        runScripts: 'dangerously', url: 'http://localhost/',
        beforeParse(w) {
            w.fetch = (u) => {
                const k = String(u).split('?')[0].replace(/^https?:\/\/[^/]+/, '');
                hits.push(k);
                const body = k === '/api/bank-accounts' ? { accounts: ACCOUNTS }
                    : k === '/api/po/signature' ? { signature: SIG }
                    : k === '/api/address-book' ? BOOK : { ok: true };
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
            };
            w.alert = () => {}; w.confirm = () => true;
            w.HTMLElement.prototype.scrollIntoView = () => {};
        },
    });
    await wait(700);
    const w = dom.window; const d = w.document;
    const $ = (id) => d.getElementById(id);
    const type = (id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event('input', { bubbles: true })); };
    const pick = (id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event('change', { bubbles: true })); };
    const line = (n, desc, qty, price, unit) => {
        const row = d.querySelectorAll('#poLines .po-line')[n];
        const set = (f, v) => { const el = row.querySelector(`[data-f="${f}"]`); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
        set('desc', desc); set('qty', qty); set('price', price);
        if (unit) { const u = row.querySelector('[data-f="unit"]'); u.value = unit; u.dispatchEvent(new w.Event('change', { bubbles: true })); }
    };
    const preview = () => $('poPreview').querySelector('.po-sheet').textContent;
    const problems = () => $('poProblems').classList.contains('hidden') ? '' : $('poProblems').textContent;

    section('A — the tab exists and switches like the others');
    {
        const btn = d.querySelector('.subtab-btn[data-subtab="po"]');
        ck('there is a "Purchase order" tab button', !!btn && /purchase order/i.test(btn.textContent));
        ck('it is NOT the tab the page opens on', !btn.classList.contains('active'));
        ck('its panel starts hidden', $('panelPO').classList.contains('hidden'));
        btn.click(); await wait(80);
        ck('clicking it shows the panel', !$('panelPO').classList.contains('hidden'));
        const others = ['panelInvoice', 'panelProforma', 'panelBol', 'panelPacking', 'panelVerification', 'panelBank'];
        ck('and hides every other panel', others.every((p) => $(p).classList.contains('hidden')),
            others.filter((p) => !$(p).classList.contains('hidden')).join(', '));
        d.querySelector('.subtab-btn[data-subtab="bank"]').click(); await wait(80);
        ck('leaving for Bank hides it again', $('panelPO').classList.contains('hidden'));
        d.querySelector('.subtab-btn[data-subtab="proforma"]').click(); await wait(80);
        ck('and it stays hidden on Proforma', $('panelPO').classList.contains('hidden'));
        d.querySelector('.subtab-btn[data-subtab="po"]').click(); await wait(200);
    }

    section('B — which company is buying');
    {
        const sel = $('po_company');
        const opts = [...sel.options].map((o) => o.textContent);
        ck('both companies are offered, from the Bank tab data', opts.includes('Edge Metals INC') && opts.includes('EDGE TRADING INC'), opts.join(' | '));
        ck('NOTHING is pre-selected', sel.value === '', 'a PO is a commitment in one company\'s name — never a default');
        ck('the sheet says to choose, rather than naming a company', /choose the issuing company/i.test(preview()));
        pick('po_company', 'edge-trading-chase');
        ck('choosing Edge Trading prints Edge Trading and its address', /EDGE TRADING INC/.test(preview()) && /2453 E 25th Street/.test(preview()));
        ck('and does not print Edge Metals', !/Edge Metals INC/.test(preview()) && !/Frisco/.test(preview()));
        pick('po_company', 'edge-metals-bofa');
        ck('switching to Edge Metals swaps both name and address', /Edge Metals INC/.test(preview()) && /Frisco/.test(preview()) && !/EDGE TRADING/.test(preview()));
    }

    section('C — supplier typeahead, same as the other tabs');
    {
        type('po_supplier', 'sunrise');
        const items = [...$('poSupplierList').querySelectorAll('.autocomplete-item')];
        ck('typing a company name found only in the raw address finds it', items.length === 1, String(items.length));
        items[0].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        ck('picking an entry with NO id still fills the name (after the "/")', $('po_supplier').value === 'Sunrise Recycling', $('po_supplier').value);
        ck('and the address', /9 Harbour St/.test($('po_supplier_address').value));
        ck('and the list closes', $('poSupplierList').classList.contains('hidden'));
        ck('the preview shows the supplier and address', /Sunrise Recycling/.test(preview()) && /9 Harbour St/.test(preview()));
    }

    section('D — the figures');
    {
        type('po_number', 'PO-1001');
        line(0, 'Copper birch/cliff', '22.571', '0.58', 'MT');
        ck('line total is rounded once, to the cent (22.571 x 0.58 = 13.09118)', /Line total \$13\.09/.test($('poLines').textContent), $('poLines').textContent);
        $('poAddLine').click();
        line(1, 'Aluminium 6063', '49,760', '$1.0425', 'LB');
        ck('a unit price keeps four decimals on paper', /\$1\.0425/.test(preview()), preview());
        ck('commas and a dollar sign are accepted (49,760 x $1.0425 = $51,874.80)', /\$51,874\.80/.test(preview()), preview());
    }
    {
        // 22.571 x 0.58 = 13.09118 -> 1309 cents ; 49760 x 1.0425 = 51874.80 -> 5187480 cents
        const d1 = w.eval('poCollect()');
        const sub = d1.lines.reduce((s, l) => s + l.amountCents, 0);
        ck('subtotal equals the sum of the printed lines, in cents', d1.subtotalCents === sub && sub === 1309 + 5187480, `${d1.subtotalCents} vs ${sub}`);
        type('po_other', '-$205');
        ck('"-$205" is a deduction of 205 dollars (the 2026-09 invoice bug, not repeated)', w.eval('poCollect()').otherCents === -20500);
        ck('the total includes it', w.eval('poCollect()').totalCents === 1309 + 5187480 - 20500);
        ck('the total on the sheet matches', new RegExp(w.eval('poMoney')(1309 + 5187480 - 20500).replace(/[$.]/g, '\\$&')).test(preview()), preview());
        type('po_other', 'abc');
        ck('junk in freight is reported, not read as zero', /not a number/i.test((w.eval('poProblems')(w.eval('poCollect()'))).join(' ')));
        type('po_other', '');
    }

    section('E — it refuses to print an incomplete order');
    {
        let opened = 0; let written = '';
        w.open = () => { opened++; return { document: { write: (s) => { written += s; }, close() {} }, focus() {}, print() {} }; };
        // Missing date and terms are fine; missing supplier is not.
        type('po_supplier', '');
        $('poPrint').click();
        ck('no print window opens without a supplier', opened === 0);
        ck('and the reason is shown', /supplier/i.test(problems()), problems());
        type('po_supplier', 'Sunrise Recycling');
        pick('po_deliver', '');
        $('poPrint').click();
        ck('no print window opens without a delivery place', opened === 0 && /delivered/i.test(problems()), problems());
        pick('po_deliver', 'edge-metals-bofa');
        pick('po_company', '');
        $('poPrint').click();
        ck('no print window opens without a company', opened === 0 && /company/i.test(problems()), problems());
        pick('po_company', 'edge-metals-bofa');
        type('po_date', '13/45/2026');
        $('poPrint').click();
        ck('an impossible date blocks printing', opened === 0 && /not a real date/i.test(problems()), problems());
        type('po_date', '10/26/2026');
        line(1, 'Half-filled line', '5', '', 'LB');
        $('poPrint').click();
        ck('a half-filled item blocks printing and is named', opened === 0 && /Item 2/.test(problems()), problems());
        line(1, '', '', '', 'LB');
        $('poPrint').click();
        ck('a complete order opens exactly one print window', opened === 1, String(opened));
        ck('the sheet it prints carries the number, company and supplier', /PO-1001/.test(written) && /Edge Metals INC/.test(written) && /Sunrise Recycling/.test(written));
        ck('and the problem list clears', $('poProblems').classList.contains('hidden'));
    }

    section('F — what is typed is text, never markup');
    {
        type('po_supplier', '<img src=x onerror="window.__po_xss=1">');
        type('po_notes', '<script>window.__po_xss=2</script>');
        await wait(50);
        ck('no <img> was created from the typed text', [...$('poPreview').querySelectorAll('img')].every((i) => /^data:image\/png/.test(i.getAttribute('src') || '')),
            'only the signature image may exist, and it is a data: PNG');
        ck('no <script> was created inside the preview', $('poPreview').querySelectorAll('script').length === 0);
        ck('and nothing ran', w.__po_xss === undefined);
        ck('the text itself is still shown', /<img src=x/.test(preview()));
    }

    section('G — dates have the calendar, and the tab touches only its own data');
    {
        ck('PO date is a MM/DD/YYYY text box, not type=date', $('po_date').type === 'text' && $('po_date').placeholder === 'MM/DD/YYYY');
        ck('PO date has a calendar button beside it', !!$('po_date').parentElement.querySelector('button[title="Pick a date"]'));
        ck('Required-by has one too', !!$('po_required').parentElement.querySelector('button[title="Pick a date"]'));
        ck('PO date defaults to today in MM/DD/YYYY', /^\d{2}\/\d{2}\/\d{4}$/.test($('po_date').value) || $('po_date').value === '10/26/2026');
        type('po_required', '9/1/26'); $('po_required').dispatchEvent(new w.Event('blur'));
        ck('a short date settles to MM/DD/YYYY on blur', $('po_required').value === '09/01/2026', $('po_required').value);
        const mine = new Set(['/api/bank-accounts', '/api/address-book', '/api/po/signature']);
        hits.length = 0;
        d.querySelector('.subtab-btn[data-subtab="bank"]').click(); await wait(80);
        hits.length = 0;
        d.querySelector('.subtab-btn[data-subtab="po"]').click(); await wait(200);
        ck('entering the tab reads only the Bank data, the address book and the signature', hits.length > 0 && hits.every((h) => mine.has(h)), hits.join(', '));
        ck('and it never posts anything', !/method:\s*['"](POST|PUT|PATCH|DELETE)/.test(SRC.slice(SRC.indexOf('// ── Purchase order tab'))));
    }

    section('I — header contact, and who signs');
    {
        ck('the real signature file exists to test with', typeof SIG === 'string' && SIG.startsWith('data:image/png'));
        pick('po_company', 'edge-metals-bofa');
        ck('the header carries the phone number', /Tel \+1 \(310\) 938-2525/.test(preview()), preview().slice(0, 200));
        ck('and Bose\'s email', /bose@edgemetals\.com/.test(preview()));
        ck('the buyer signs as Chandra Bose by default', $('po_signer').value === 'Chandra Bose');
        const img = () => $('poPreview').querySelectorAll('.sign img').length;
        ck('Edge Metals + Chandra Bose: his signature image is on the buyer line', img() === 1);
        ck('the buyer line is labelled with the company and his name', /Buyer — Edge Metals INC/.test(preview()) && /Chandra Bose/.test(preview()));
        ck('the seller line carries the supplier and NO image', /Seller — /.test(preview()) && $('poPreview').querySelectorAll('.sign .sg')[1].querySelectorAll('img').length === 0);
        pick('po_company', 'edge-trading-chase');
        ck('Edge Trading: his signature is NOT printed under another company', img() === 0);
        ck('  but the buyer line, name and header contact still print', /Buyer — EDGE TRADING INC/.test(preview()) && /bose@edgemetals\.com/.test(preview()));
        pick('po_company', 'edge-metals-bofa');
        type('po_signer', 'Someone Else');
        ck('another name in the box: no signature image', img() === 0);
        type('po_signer', 'chandra  bose');
        ck('his name typed loosely still counts', img() === 1);
        pick('po_company', '');
        ck('no company chosen: no contact line and no signature', !/Tel \+1/.test(preview()) && img() === 0);
        pick('po_company', 'edge-metals-bofa');
        ck('"Edge Metals Inc." typed loosely is Edge Metals, "Edge Metals Yard" is not',
            w.eval("poIsEdgeMetals('edge metals inc.')") === true && w.eval("poIsEdgeMetals('Edge Metals LLC')") === true
            && w.eval("poIsEdgeMetals('Edge Yard')") === false && w.eval("poIsEdgeMetals('Edge Metals Yard')") === false);
    }

    section('J — the signature route, for real');
    {
        const http = require('http');
        process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
        process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
        process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
        const { createApi } = require(path.join(__dirname, '..', 'api'));
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
                res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j }); });
            });
            r2.on('error', reject); if (data) r2.write(data); r2.end();
        });
        try {
            const none = await req('GET', '/api/po/signature');
            ck('no session: refused', none.status === 401 || none.status === 403, String(none.status));
            const staff = (await req('POST', '/login', { body: { password: process.env.STAFF_PASSWORD } })).json || {};
            ck('staff can sign in (so the refusal below is about the role, not the login)', !!staff.sid, JSON.stringify(staff).slice(0, 80));
            const usr = (await req('POST', '/login', { body: { password: process.env.APP_PASSWORD } })).json || {};
            ck('a plain user can sign in', !!usr.sid);
            const u = await req('GET', '/api/po/signature', { sid: usr.sid });
            ck('a plain user session is refused (the case requireAdmin exists for)', u.status === 403, String(u.status));
            const s = await req('GET', '/api/po/signature', { sid: staff.sid });
            ck('a staff session is refused', s.status === 403, String(s.status));
            const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
            ck('admin signs in', !!sid);
            const ok = await req('GET', '/api/po/signature', { sid });
            ck('admin gets the same PNG the invoice uses', ok.status === 200 && ok.json && ok.json.signature === SIG, String(ok.status));
            // and the page reads exactly that shape
            ck('the page accepts that response', w.eval('poSignatureUrl') === SIG);
        } finally { server.close(); }
    }

    section('L — supplier matching as she types');
    {
        const labels = () => [...$('poSupplierList').querySelectorAll('.autocomplete-item')].map((e) => e.textContent);
        const q = (s) => { type('po_supplier', s); return labels(); };
        const has = (arr, s) => arr.some((x) => x.includes(s));
        ck('spacing is ignored: "mkmetal" finds MK Metal Trading', has(q('mkmetal'), 'MK Metal Trading'));
        ck('so is punctuation: "m.k. metal"', has(q('m.k. metal'), 'MK Metal Trading'));
        ck('word order does not matter: "metal mk"', has(q('metal mk'), 'MK Metal Trading'));
        ck('a partial word works: "daek"', has(q('daek'), 'Daekwang'));
        ck('one slip is forgiven: "sunrize"', has(q('sunrize'), 'Sunrise'));
        ck('but nonsense does not match everything: "zzzq"', q('zzzq').every((x) => /Not in your address book/.test(x)));
        ck('and says so out loud when nothing matches', /Not in your address book/.test(q('zzzq')[0] || ''));
        ck('an address-only hit still finds it: "quay"', has(q('quay'), 'Tom'));
        const ray = q('ray');
        ck('a name that STARTS with the text outranks one found in an address', /^Ray\b/.test(ray[0]) , ray.join(' | '));
        ck('the empty-result row is not clickable into the form', (() => { q('zzzq'); const before = $('po_supplier').value;
            $('poSupplierList').querySelector('.autocomplete-item').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            return $('po_supplier').value === before; })());
        // keyboard
        q('ray');
        const key = (k) => $('po_supplier').dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        key('ArrowDown'); key('Enter');
        ck('arrow-down then Enter picks the second match', /Rays Recycling/.test($('po_supplier').value), $('po_supplier').value);
        ck('and fills its address', /3 Oak St/.test($('po_supplier_address').value));
        q('ray'); key('Enter');
        ck('Enter alone takes the best match', $('po_supplier').value === 'Ray' && /12 Yard Rd/.test($('po_supplier_address').value), $('po_supplier').value);
        q('ray'); key('Escape');
        ck('Escape closes the list', $('poSupplierList').classList.contains('hidden'));
        // blur auto-fill
        $('po_supplier_address').value = ''; type('po_supplier', 'Daekwang'); $('po_supplier').dispatchEvent(new w.Event('blur'));
        ck('typing a full name and leaving fills the address when it is empty', /77 Pier Rd/.test($('po_supplier_address').value), $('po_supplier_address').value);
        $('po_supplier_address').value = 'my own address'; type('po_supplier', 'Daekwang'); $('po_supplier').dispatchEvent(new w.Event('blur'));
        ck('but never overwrites an address she already typed', $('po_supplier_address').value === 'my own address');
        $('po_supplier_address').value = ''; type('po_supplier', 'Ra'); $('po_supplier').dispatchEvent(new w.Event('blur'));
        ck('and never guesses from a partial name', $('po_supplier_address').value === '');
        $('po_supplier_address').value = ''; type('po_supplier', 'Twin Metals'); $('po_supplier').dispatchEvent(new w.Event('blur'));
        ck('two entries with the same name: nothing is guessed', $('po_supplier_address').value === '', $('po_supplier_address').value);
        const mt = q('metaltr');
        ck('a name containing the text outranks an address that does', mt.length >= 2 && /MK Metal Trading/.test(mt[0]), mt.join(' | '));
        // does not touch the shared matcher the other tabs use
        ck('the shared address-book search is unchanged (substring only)', w.eval("searchAddressBook('mkmetal').length") === 0);
        type('po_supplier', ''); $('po_supplier_address').value = '';
    }

    section('M — price depends on condition (clean / dirty)');
    {
        $('poClear').click();
        pick('po_company', 'edge-metals-bofa');
        const row = () => d.querySelector('#poLines .po-line');
        const set = (f, v) => { const el = row().querySelector(`[data-f="${f}"]`); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
        ck('off by default: one price, no second box shown', !$('poLines').classList.contains('two') && $('poTwoLabels').classList.contains('hidden'));
        $('po_two').checked = true; $('po_two').dispatchEvent(new w.Event('change', { bubbles: true }));
        ck('turning it on shows the second price and the two names', $('poLines').classList.contains('two') && !$('poTwoLabels').classList.contains('hidden'));
        ck('the names default to Clean and Dirty', $('po_label_a').value === 'Clean' && $('po_label_b').value === 'Dirty');
        ck('the price boxes are labelled with them', /Clean/.test(row().querySelector('[data-f="price-label"]').textContent) && /Dirty/.test(row().querySelector('[data-f="price2-label"]').textContent));
        set('desc', 'Aluminum wheels'); set('qty', '80,000'); set('unit', 'LB'); set('price', '1.31');
        ck('with the second price missing the item is incomplete', w.eval('poCollect()').lines[0].ok === false);
        set('price2', '1.29');
        const c = w.eval('poCollect()');
        ck('80,000 x 1.31 = $104,800.00 clean', c.subtotalCents === 10480000, String(c.subtotalCents));
        ck('80,000 x 1.29 = $103,200.00 dirty', c.subtotal2Cents === 10320000, String(c.subtotal2Cents));
        const cell = () => [...$('poPreview').querySelectorAll('tbody tr td')].map((x) => x.textContent);
        ck('the Unit price cell shows BOTH prices, labelled', /Clean\s*\$1\.31/.test(cell()[3]) && /Dirty\s*\$1\.29/.test(cell()[3]), cell()[3]);
        ck('the Amount cell shows both amounts', /\$104,800\.00/.test(cell()[4]) && /\$103,200\.00/.test(cell()[4]), cell()[4]);
        ck('there are two totals, one for each', /Total if Clean[^$]*\$104,800\.00/.test(preview()) && /Total if Dirty[^$]*\$103,200\.00/.test(preview()), preview());
        ck('and freight shows the subtotal lines again', (() => { type('po_other', '10'); const r = /Subtotal if Clean/.test(preview()); type('po_other', ''); return r; })());
        ck('with no freight the prices are not stated a third time as subtotals', !/Subtotal/.test(preview()), preview());
        type('po_other', '-$200');
        ck('freight applies to both totals', w.eval('poCollect()').totalCents === 10460000 && w.eval('poCollect()').total2Cents === 10300000);
        type('po_other', '');
        type('po_label_b', 'clean');
        ck('two options with the same name are refused', /different names/i.test(w.eval('poProblems')(w.eval('poCollect()')).join(' ')));
        type('po_label_b', '');
        ck('and an unnamed option is refused', /Name both/i.test(w.eval('poProblems')(w.eval('poCollect()')).join(' ')));
        type('po_label_b', 'Dirty');
        $('po_two').checked = false; $('po_two').dispatchEvent(new w.Event('change', { bubbles: true }));
        ck('turning it off goes back to ONE price and one total (the second is ignored)',
            !/Total if/.test(preview()) && /Total \(USD\)/.test(preview()) && w.eval('poCollect()').totalCents === 10480000);
        ck('and the single-price sheet is exactly as before', cell()[3].trim() === '$1.31', cell()[3]);
        $('po_two').checked = true; $('po_two').dispatchEvent(new w.Event('change', { bubbles: true }));
        $('poClear').click();
        ck('Clear turns it off and restores the names', !$('po_two').checked && $('po_label_a').value === 'Clean' && $('po_label_b').value === 'Dirty' && !$('poLines').classList.contains('two'));
    }

    section('N — subtotal only when it differs from the total');
    {
        $('poClear').click();
        const row = () => d.querySelector('#poLines .po-line');
        const set = (f, v) => { const el = row().querySelector(`[data-f="${f}"]`); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
        set('desc', 'Copper'); set('qty', '10'); set('price', '2');
        ck('single price, no freight: Total only, no Subtotal', /Total \(USD\)/.test(preview()) && !/Subtotal/.test(preview()), preview());
        $('poAddLine').click();
        const row2 = d.querySelectorAll('#poLines .po-line')[1];
        const set2 = (f, v) => { const el = row2.querySelector(`[data-f="${f}"]`); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
        set2('desc', 'Brass'); set2('qty', '1'); set2('price', '3');
        ck('two different materials: the Subtotal comes back', /Subtotal/.test(preview()) && /Total \(USD\)[^$]*\$23\.00/.test(preview()), preview());
        d.querySelectorAll('#poLines [data-f="remove"]')[1].click();
        ck('back to one material: no Subtotal again', !/Subtotal/.test(preview()));
        type('po_other', '5');
        ck('with freight: Subtotal, Freight and Total all appear', /Subtotal/.test(preview()) && /Freight \/ other/.test(preview()) && /Total \(USD\)[^$]*\$25\.00/.test(preview()), preview());
        type('po_other', '');
        pick('po_company', 'edge-metals-bofa');
    }

    section('K — Deliver to: Edge Yard or Edge Metals, each at its own address');
    {
        const opts = [...$('po_deliver').options].map((o) => o.textContent);
        ck('the choices are Edge Yard, Edge Metals and Other', opts.some((o) => /^Edge Yard — 2453 E 25th Street/.test(o))
            && opts.some((o) => /^Edge Metals — 14750 Devonshire Ln/.test(o)) && opts.some((o) => /^Other/.test(o)), opts.join(' | '));
        pick('po_company', 'edge-metals-bofa');
        pick('po_deliver', 'edge-trading-chase');
        ck('Edge Yard fills the LA address', /Edge Yard\n2453 E 25th Street, Los Angeles/.test($('po_shipto').value), $('po_shipto').value);
        const dcard = () => $('poPreview').querySelectorAll('.party')[1].textContent;
        ck('and the sheet\'s Deliver-to card shows it, not the Frisco one', /2453 E 25th Street/.test(dcard()) && !/Devonshire/.test(dcard()), dcard());
        pick('po_deliver', 'edge-metals-bofa');
        ck('Edge Metals fills the Frisco address', /Edge Metals\n14750 Devonshire Ln, Frisco/.test($('po_shipto').value), $('po_shipto').value);
        ck('the issuing company is NOT changed by the delivery choice', $('po_company').value === 'edge-metals-bofa');
        pick('po_company', 'edge-trading-chase');
        ck('and the delivery choice is NOT changed by the issuing company', $('po_deliver').value === 'edge-metals-bofa' && /Devonshire/.test($('po_shipto').value));
        pick('po_company', 'edge-metals-bofa');
        $('po_shipto').value = '9 Harbour St'; $('po_shipto').dispatchEvent(new w.Event('input', { bubbles: true }));
        ck('typing over the address flips the choice to Other', $('po_deliver').value === 'other');
        ck('and what she typed is what prints in the card', /9 Harbour St/.test(dcard()) && !/Devonshire/.test(dcard()), dcard());
        pick('po_deliver', 'edge-trading-chase');
        ck('picking a preset again replaces her typed address', /2453 E 25th/.test($('po_shipto').value) && !/Harbour/.test($('po_shipto').value));
        pick('po_deliver', 'edge-metals-bofa');
    }

    section('O — the sheet is even: Deliver-to reads like Vendor, no repeated labels');
    {
        pick('po_company', 'edge-metals-bofa');
        pick('po_deliver', 'edge-metals-bofa');
        type('po_supplier', 'FMC Metals'); type('po_supplier_address', '800 East 62nd Street\nLos Angeles');
        const cards = () => $('poPreview').querySelectorAll('.party');
        ck('Deliver-to has a bold name line, as Vendor does', cards()[1].querySelector('.nm') && cards()[1].querySelector('.nm').textContent === 'Edge Metals', cards()[1].innerHTML);
        ck('and the address sits under it, not in the name', /Devonshire/.test(cards()[1].querySelector('.v').textContent) && !/Devonshire/.test(cards()[1].querySelector('.nm').textContent));
        ck('Vendor still has its name and address', cards()[0].querySelector('.nm').textContent === 'FMC Metals' && /62nd/.test(cards()[0].querySelector('.v').textContent));
        pick('po_deliver', '');
        ck('with no delivery chosen the card shows a dash, not a blank', cards()[1].querySelector('.nm') && /—/.test(cards()[1].textContent), cards()[1].innerHTML);
        pick('po_deliver', 'edge-metals-bofa');
        $('poClear').click();
        pick('po_company', 'edge-metals-bofa');
        $('po_two').checked = true; $('po_two').dispatchEvent(new w.Event('change', { bubbles: true }));
        const r = d.querySelector('#poLines .po-line');
        const s1 = (f, v) => { const e = r.querySelector(`[data-f="${f}"]`); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); };
        s1('desc', 'Wheels'); s1('qty', '1000'); s1('price', '1.31'); s1('price2', '1.29');
        const tds = $('poPreview').querySelectorAll('tbody tr:first-child td');
        ck('Unit price shows CLEAN / DIRTY beside each price', tds[3].querySelectorAll('span').length === 2 && /Clean/i.test(tds[3].textContent), tds[3].innerHTML);
        ck('Amount shows the two figures only, no labels repeated', tds[4].querySelectorAll('span').length === 0 && !/clean|dirty/i.test(tds[4].textContent), tds[4].innerHTML);
        ck('and both amounts are there, clean first', /\$1,310\.00[^$]*\$1,290\.00/.test(tds[4].textContent), tds[4].textContent);
        $('po_two').checked = false; $('po_two').dispatchEvent(new w.Event('change', { bubbles: true }));
        $('poClear').click();
        pick('po_company', 'edge-metals-bofa');
    }

    section('H — Clear and the last item row');
    {
        const rows = () => d.querySelectorAll('#poLines .po-line').length;
        $('poAddLine').click(); $('poAddLine').click();
        ck('items can be added', rows() >= 3);
        while (rows() > 1) d.querySelector('#poLines [data-f="remove"]').click();
        d.querySelector('#poLines [data-f="remove"]').click();
        ck('removing the last item leaves one empty row to type into', rows() === 1);
        $('poClear').click();
        ck('Clear empties the number, supplier and company', $('po_number').value === '' && $('po_supplier').value === '' && $('po_company').value === '');
        ck('and puts Chandra Bose back as the buyer', $('po_signer').value === 'Chandra Bose');
        ck('and clears the delivery choice', $('po_deliver').value === '' && $('po_shipto').value === '');
        ck('and puts one empty item row back', rows() === 1 && d.querySelector('#poLines [data-f="desc"]').value === '');
    }

    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
