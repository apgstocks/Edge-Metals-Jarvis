// ── tests/bol.js — Edge Metals Bill of Lading ─────────────────────────────
// Apsara, 2026-09-15: "I want to create a BOL for edge metals with seller as
// edge metals .you have the address already.Buyer i will just give the name.
// It should be matched with address book as i type", design C of three shown,
// then the fields she caught missing: "Driver name,Pickup date and time,PO
// number,appointment id,Gross trare net weight missing?", and the correction
// that set the whole shape: "No.its for edge metals."
//
// The screen half is RENDERED in jsdom, not grepped. The type-ahead is the
// feature she actually asked for ("matched with address book as i type"), and
// whether a dropdown item can be clicked is a fact about the DOM — this
// project has already lost two sessions to a type-ahead that looked correct
// in source and did nothing on screen.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

process.env.JARVIS_TEST = '1';

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const bol = require('../helpers/bolPdf');
const saved = require('../helpers/documentsSaved');

section('A — the document carries every field she named');
{
    const { html } = bol.buildBolHtml({
        bol_no: 'EM-1047', bol_date: '2026-09-15',
        consignee_name: 'Eccomelt LLC',
        consignee_address: 'Eccomelt LLC\n1234 Foundry Rd\nFontana, CA 92337',
        po_number: 'PO-55410', appointment_id: 'APT-77213',
        pickup_date: '2026-09-15', pickup_time: '09:30',
        carrier: 'Santiago Trucking', driver: 'Miguel Ortiz',
        container_no: 'TRL-8821', seal_no: '40217',
        items: [{ description: 'Aluminium combo scrap', pieces: 14, gross_weight: 46300, tare_weight: 4120, net_weight: 42180 }],
    });
    const has = (s) => html.includes(s);
    // Named one at a time rather than in a loop, so a failure says WHICH
    // field went missing instead of "one of eleven".
    ck('driver name',      has('Miguel Ortiz'));
    ck('  pickup date and time', /09\/15\/2026 · 9:30 AM/.test(html),
       'she asked for both, and they share one box');
    ck('  PO number',      has('PO-55410'));
    ck('  appointment id', has('APT-77213'));
    ck('  gross',          has('46,300'));
    ck('  tare',           has('4,120'));
    ck('  net',            has('42,180'));
    ck('  pieces',         has('>14<'));
    ck('  container and seal', has('TRL-8821') && has('40217'));

    // EDGE METALS, NOT EDGE YARD — the correction that reset the whole design.
    ck('the shipper is Edge Metals and is not a parameter',
       has('EDGE METALS INC') && has('14750 Devonshire Ln'),
       'there is exactly one company issuing this document');
    ck('  and a seller cannot be passed in to override it',
       !/\{\{\s*seller/.test(html) && !bol.buildBolHtml({ seller_name: 'Edge Yard', items: [] }).html.includes('Edge Yard'),
       'a yard BOL would be a different template, not a placeholder here');

    // Her standing instruction, 2026-09-01: "wherever date applicable it
    // should be mm/dd/yyyy only." The first version of this file printed
    // "15 Sep 2026", which also disagreed with the invoice for the same
    // container — so formatDate is borrowed from proformaPdf, not rewritten.
    ck('dates are MM/DD/YYYY, the same as the invoice',
       has('09/15/2026') && !/15 Sep 2026/.test(html),
       'two formats across two documents for one shipment is a mistake waiting to be read aloud');

    ck('  and the legal acknowledgement above the signatures is present',
       /Received, subject to the classifications/.test(html),
       'without it the page is a packing list with a signature box, not a contract of carriage');
    ck('  with three signature lines: shipper, driver, consignee',
       has('SHIPPER') && has('DRIVER') && has('RECEIVED BY'));

    // ── THE SHIPPER'S SIGNATURE ──────────────────────────────────────────
    // Apsara, 2026-09-16: "Give chandra bose sign to shipper".
    const flat = html.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, 'IMG').replace(/\n\s*/g, ' ');
    ck('the shipper line is signed',
       /sigcol">\s*<div class="sigink"[^>]*><img src="IMG"[^>]*><\/div>\s*<div class="sig">SHIPPER/.test(flat),
       'the image has to sit ABOVE the rule and inside the SHIPPER column — ' +
       'anywhere else on the page is not a signature on that line');
    // Signing for the driver or the consignee would be signing on someone
    // else's behalf. They sign on the spot, for goods they are receiving.
    ck('  and the driver and consignee lines are left blank',
       (flat.match(/<div class="sigink"><\/div>/g) || []).length === 2
       && (flat.match(/<img/g) || []).length === 1,
       'printing a signature for the people receiving the goods would be ' +
       'signing on their behalf');
    ck('  it is the SAME signature the invoice and proforma already carry',
       html.includes(require('../helpers/signature').signatureDataUrl()),
       'a second copy of the image would rebuild the exact problem ' +
       'helpers/signature.js was written to remove');
    ck('  and internal notes are stripped from what the buyer receives',
       !/<!--/.test(html) && !/Apsara/.test(html),
       'the template comments discuss the design; they are not for the customer');
}

section('A2 — a missing signature file must not cost her the document');
{
    // Inherited from helpers/signature.js, and worth asserting HERE because
    // the BOL adds a placeholder that would otherwise print raw: a document
    // refusing to render because a PNG was unreadable is far worse than one
    // printing a blank rule. The driver is waiting either way, and a blank
    // line can be signed by hand.
    //
    // ── RUN IN A CHILD PROCESS, AND HERE IS WHY ──────────────────────────
    // The first version of this section set process.env.SIGNATURE_FILE and
    // called buildBolHtml. It passed, and it tested NOTHING: that variable is
    // read once at module load, so by the time a test can set it the real
    // path is already baked in and the module has cached the image besides.
    // A green check that cannot fail is worse than no check, because it is
    // read as coverage.
    //
    // A fresh node with the variable already wrong is the only honest way to
    // reach the branch.
    const { execFileSync } = require('child_process');
    const script = `
        const bol = require(${JSON.stringify(path.join(ROOT, 'helpers/bolPdf'))});
        const out = bol.buildBolHtml({ consignee_name: 'X', items: [{ description: 'Al', net_weight: 1 }] });
        const flat = out.html.replace(/\\n\\s*/g, ' ');
        process.stdout.write(JSON.stringify({
            rendered: flat.includes('SHIPPER'),
            noImage: !/<img/.test(flat),
            noPlaceholder: !/\\{\\{/.test(flat),
            spacerKept: /<div class="sigink" style="height:30px;"><\\/div>\\s*<div class="sig">SHIPPER/.test(flat),
            inkColumns: (flat.match(/class="sigink"/g) || []).length,
        }));
    `;
    let res = null, threw = null;
    try {
        res = JSON.parse(execFileSync(process.execPath, ['-e', script], {
            env: { ...process.env, SIGNATURE_FILE: '/definitely/not/here.png', JARVIS_TEST: '1' },
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }));
    } catch (e) { threw = e; }

    ck('the document still renders with no signature file', !threw && res && res.rendered,
       threw ? String(threw.message).split('\n')[0] : JSON.stringify(res));
    ck('  with no broken-image icon on a customer-facing page', !!res && res.noImage);
    ck('  and no {{placeholder}} left on the page', !!res && res.noPlaceholder,
       'the unfilled-placeholder guard would throw, which is the point of it');
    // The height is reserved either way, or the shipper's rule prints higher
    // than the driver's and the page looks misprinted.
    ck('  the 30px space is still reserved, so the three lines stay level',
       !!res && res.spacerKept && res.inkColumns === 3,
       JSON.stringify(res));
}

section('B — blank is an absence, not a zero');
{
    // On a weight document these are different claims. "0" under TARE says
    // the containers weighed nothing; a dash says it was not recorded.
    const { html, totals } = bol.buildBolHtml({ consignee_name: 'X', items: [{ description: 'Scrap', net_weight: 100 }] });
    ck('an unfilled tare column totals to nothing, not 0', totals.tare_weight === null,
       JSON.stringify(totals));
    // ASSERTED ON THE FORMATTER, not on the page containing a dash somewhere.
    // The first version tested html.includes('>—<'), which passed even with
    // the formatter mutated to print 0 — because the empty PO and appointment
    // boxes also render a dash. It was green for a reason that had nothing to
    // do with weights.
    ck('  because a null weight formats as a dash, never as 0',
       bol.fmtWeight(null) === '—' && bol.fmtWeight('') === '—' && bol.fmtWeight(undefined) === '—',
       `got ${JSON.stringify([bol.fmtWeight(null), bol.fmtWeight(''), bol.fmtWeight(undefined)])}`);
    ck('  while a real zero still prints as 0', bol.fmtWeight(0) === '0',
       'a tare she actually entered as 0 is a claim she made, and stays');
    ck('  and the goods row shows the dash in the tare cell',
       /<td>—<\/td>\s*<td>100<\/td>/.test(html.replace(/\n\s*/g, '')),
       'tare empty, net 100 — checked as a pair so a dash elsewhere cannot satisfy it');
    ck('  while the column that WAS filled still totals', totals.net_weight === 100);
    ck('  and an empty fact box is still printed, greyed',
       /class="v empty">—</.test(html),
       'a missing box reads as "this document has no such field", and a driver ' +
       'holding a BOL with no seal row will not think to ask for one');
}

section('C — the weights are checked, and never corrected');
{
    const bad = bol.buildBolHtml({ items: [{ description: 'Al', gross_weight: 1000, tare_weight: 100, net_weight: 800 }] });
    ck('net that disagrees with gross minus tare is reported',
       bad.warnings.length === 1 && /gross minus tare is 900/.test(bad.warnings[0]),
       JSON.stringify(bad.warnings));
    // THE POINT OF THE WHOLE CHECK. A document that silently rewrites a
    // weight she typed is worse than one that disagrees with her, because
    // she would never find out — and the buyer re-weighs.
    ck('  but the PDF still prints exactly what she typed',
       bad.html.includes('800') && !bad.html.includes('900'),
       'auto-correcting a weight on a legal shipping document is the single ' +
       'worst thing this screen could do');
    ck('  a tare heavier than gross is caught',
       bol.buildBolHtml({ items: [{ gross_weight: 100, tare_weight: 900, net_weight: -800 }] }).warnings.length >= 2);
    ck('  a clean line warns about nothing',
       bol.buildBolHtml({ items: [{ gross_weight: 1000, tare_weight: 100, net_weight: 900 }] }).warnings.length === 0);
    ck('  and 1 lb of rounding slack is allowed',
       bol.buildBolHtml({ items: [{ gross_weight: 1000, tare_weight: 100, net_weight: 901 }] }).warnings.length === 0);
}

section('D — an unfilled placeholder can never reach a driver');
{
    let threw = null;
    try {
        const tpl = fs.readFileSync(path.join(ROOT, 'assets/bol/template.html'), 'utf8');
        ck('the template has no placeholder the code does not fill',
           (() => { try { bol.buildBolHtml({ items: [] }); return true; } catch { return false; } })(),
           'buildBolHtml throws rather than shipping a literal {{seal_no}}');
        // THE GUARD IS FIRED, not merely grepped for. Checking that the
        // happy path does not throw says nothing about whether the guard
        // exists — deleting it entirely leaves that check green, and a
        // mutation doing exactly that survived until this assertion existed.
        let fired = false;
        try { bol.assertNoUnfilledPlaceholders('<div>{{seal_no}}</div>'); }
        catch (e) { fired = /seal_no/.test(e.message); }
        ck('  and it actually throws when one is left unfilled', fired,
           'a guard that cannot be shown to fire is indistinguishable from no guard');
        ck('  while clean output passes', bol.assertNoUnfilledPlaceholders('<div>fine</div>') === true);
        void tpl;
    } catch (e) { threw = e; }
    ck('  reading the template does not throw', !threw, threw && threw.message);
}

section('E — the archive, and the download guard');
{
    ck("'bol' is an accepted saved-document kind", saved.SAVED_KINDS.has('bol'));
    ck('  and the kinds are an allowlist, not a chain of !==',
       saved.SAVED_KINDS instanceof Set,
       'a chain where one && is typed as || lets every kind through');
    // resolveSavedPath is the path-traversal guard for /api/documents/download.
    // Adding a kind must not open it.
    ck('  a crafted filename cannot climb out of the archive',
       saved.resolveSavedPath({ kind: 'bol', filename: '../../../config.js', date: '2026-09-15' }) === null);
    ck('  nor can a crafted date',
       saved.resolveSavedPath({ kind: 'bol', filename: 'x.pdf', date: '../../..' }) === null);
    ck('  and an unknown kind is still refused',
       saved.resolveSavedPath({ kind: 'passwd', filename: 'x.pdf' }) === null);
}

section('F — the screen: type a name, get an address');
(async () => {
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
const BOOK = [
    { aliases: ['Eccomelt'], raw: 'Eccomelt LLC\n1234 Foundry Rd\nFontana, CA 92337' },
    // No `id` — 27 of her 98 real entries have none, which is what broke
    // selection the first two times a type-ahead was built in this app.
    { aliases: ['Joey/Taewon'], raw: 'Taewon Metals\n900 Industrial Blvd\nDallas, TX 75201' },
];
const ROUTES = {
    '/api/me': { ok: true, role: 'admin' },
    '/api/address-book': BOOK,
    '/api/documents/saved': { invoices: [], proformas: [], bols: [] },
};
const errors = [];
const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'http://localhost/',
    beforeParse(w) {
        w.fetch = (u, opts) => {
            const k = String(u).split('?')[0];
            w.__sent = w.__sent || [];
            if (opts && opts.method === 'POST') w.__sent.push({ url: k, body: JSON.parse(opts.body || '{}') });
            return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({}),
                json: () => Promise.resolve(k in ROUTES ? ROUTES[k] : { ok: true }) });
        };
        w.alert = () => {}; w.confirm = () => true;
        w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
        w.open = () => {};
        w.addEventListener('error', (e) => errors.push(e.message));
    },
});
await new Promise((r) => setTimeout(r, 600));
const w = dom.window, d = w.document;

w.setSubtab('bol');
await new Promise((r) => setTimeout(r, 200));

ck('the BOL tab exists beside Invoice and Proforma',
   !!d.querySelector('[data-subtab="bol"]') && !d.getElementById('panelBol').classList.contains('hidden'));

const inp = d.getElementById('bol_consignee');
inp.value = 'ecc';
inp.dispatchEvent(new w.Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
const items = [...d.querySelectorAll('#bolConsigneeList .autocomplete-item')];
ck('  typing part of a name offers a match', items.length === 1,
   `${items.length} matches for "ecc"`);

// mousedown, not click — a click blurs the input first and the 150ms
// blur-hide timer wins the race, which is exactly what "when i click
// consignee name, it is not filling up" turned out to be.
items[0].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
await new Promise((r) => setTimeout(r, 40));
ck('  picking it fills the name', inp.value === 'Eccomelt', JSON.stringify(inp.value));
ck('  and fills the address without typing', /1234 Foundry Rd/.test(d.getElementById('bol_consignee_address').value));

// The entry with no id — the case that silently failed for a quarter of her
// address book when selection was matched by entry.id.
inp.value = 'taewon';
inp.dispatchEvent(new w.Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
const second = [...d.querySelectorAll('#bolConsigneeList .autocomplete-item')];
ck('  an entry found only by its ADDRESS text is offered', second.length === 1,
   'searchAddressBook matches raw text, not just aliases');
second[0].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
await new Promise((r) => setTimeout(r, 40));
ck('  and an entry with no id is still selectable', inp.value === 'Taewon',
   `got ${JSON.stringify(inp.value)} — selection must be by position, not by entry.id`);

// Fill the rest and send.
const set = (id, v) => { const el = d.getElementById(id); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
set('bol_no', 'EM-1047'); set('bol_po', 'PO-55410'); set('bol_appointment', 'APT-77213');
set('bol_pickup_date', '2026-09-15'); set('bol_pickup_time', '09:30');
set('bol_carrier', 'Santiago Trucking'); set('bol_driver', 'Miguel Ortiz');
set('bol_container', 'TRL-8821'); set('bol_seal', '40217');
const rows = [...d.querySelectorAll('#bolItems input[data-bi="0"]')];
rows.forEach((el) => {
    const v = { description: 'Aluminium combo scrap', pieces: '14', gross_weight: '46300', tare_weight: '4120', net_weight: '42180' }[el.dataset.bf];
    el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true }));
});

ck('  the running total adds up on screen', /42,180/.test(d.getElementById('bolTotals').innerHTML),
   d.getElementById('bolTotals').textContent);
ck('  and a clean line shows no warning', d.getElementById('bolWarnings').innerHTML.trim() === '');

// Now break it, and check the screen says so BEFORE she generates.
set('bol_no', 'EM-1047');
const net = d.querySelector('#bolItems input[data-bi="0"][data-bf="net_weight"]');
net.value = '40000'; net.dispatchEvent(new w.Event('input', { bubbles: true }));
ck('  a mismatched net is flagged as you type', /gross minus tare/.test(d.getElementById('bolWarnings').textContent));
ck('  and it says the PDF is not changed for her',
   /prints exactly what you typed/.test(d.getElementById('bolWarnings').textContent),
   'she needs to know the document will carry her number, not a corrected one');
net.value = '42180'; net.dispatchEvent(new w.Event('input', { bubbles: true }));

d.getElementById('btnBolGenerate').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 120));
const sent = (w.__sent || []).filter((s) => s.url === '/api/bol/generate');
ck('  Generate posts to /api/bol/generate', sent.length === 1, `${sent.length} posts`);
const body = sent.length ? sent[0].body : {};
ck('  and every typed field reaches the server',
   body.driver === 'Miguel Ortiz' && body.pickup_time === '09:30' && body.po_number === 'PO-55410'
   && body.appointment_id === 'APT-77213' && body.seal_no === '40217'
   && body.items[0].gross_weight === '46300' && body.items[0].tare_weight === '4120',
   JSON.stringify(body).slice(0, 260));

// PICKUP IS NOT DELIVERY. The yard stores delivery_eta_*; this records when
// the truck was loaded. Printing one as the other would be plausible and
// wrong, and only found when a buyer disputes a delivery window.
// COMMENTS STRIPPED FIRST. The first version of this check scanned the raw
// panel markup and failed on the panel's own comment — the one that explains
// that pickup is not delivery. An assertion that trips over the documentation
// of the rule it is enforcing is testing the prose, not the code.
const panelCode = HTML
    .slice(HTML.indexOf('id="panelBol"'), HTML.indexOf('id="panelVerification"'))
    .replace(/<!--[\s\S]*?-->/g, '');
const bolJs = HTML.slice(HTML.indexOf('function bolPayload'), HTML.indexOf('function bolPayload') + 1200)
    .replace(/\/\/[^\n]*/g, '');
// ── PREVIEW HAS TO ACTUALLY OPEN ─────────────────────────────────────────
// Apsara, 2026-09-16: "in bol,preview not opened".
//
// Two different faults with the same symptom, one per client, both mine:
//
//   WEBSITE  window.open ran AFTER the fetch, by which point the click that
//            authorised it had expired and the popup blocker ate it in
//            silence. The tab is now claimed synchronously and pointed at the
//            PDF when it arrives.
//   APP      window.open does nothing at all in an Android WebView. This file
//            already said so in two places, from 2026-08-17, and her words
//            then were "it is pressed, but nothing happening". The app now
//            uses deliverExportedFile, like its own proforma and invoice
//            previews always did.
{
    const appSrc = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    // Bounded at the function's own closing brace, not a character count. A
    // fixed window ran past bolSubmit into neighbouring code that legitimately
    // uses window.open, and the assertion below failed for a reason that had
    // nothing to do with the preview.
    // Bounded at the function's own closing brace, and with COMMENTS STRIPPED.
    // Both matter and both bit: a fixed character window ran past bolSubmit
    // into neighbouring code that legitimately uses window.open, and once that
    // was fixed the check still failed on the comment in bolSubmit explaining
    // why window.open is NOT used. That is the second time today an assertion
    // has tripped over the documentation of the rule it enforces — scan the
    // code, not the prose about the code.
    const cut = (src) => {
        const from = src.indexOf('async function bolSubmit');
        const end = src.indexOf('\n}', from);
        return src.slice(from, end === -1 ? from + 3400 : end).replace(/\/\/[^\n]*/g, '');
    };
    const webPreview = cut(HTML);
    const appPreview = cut(appSrc);

    ck('website: the tab is opened BEFORE the fetch, while the click is still live',
       webPreview.indexOf("window.open('', '_blank')") !== -1
       && webPreview.indexOf("window.open('', '_blank')") < webPreview.indexOf('/api/bol/generate?preview=1'),
       'opening it afterwards is what a popup blocker swallows, silently');
    ck('  and a blocked tab falls back to downloading the preview',
       /blocked the new tab/.test(webPreview) && /a\.download = `bol-preview-/.test(webPreview),
       'telling her it opened when it did not is worse than either outcome');
    ck('app: the preview does NOT use window.open',
       !/window\.open/.test(appPreview),
       "Android's WebView no-ops it — this codebase found that out on 2026-08-17");
    ck('  it goes through deliverExportedFile, like the proforma preview',
       /deliverExportedFile\(blob, `bol-preview-/.test(appPreview));
    ck('  and neither client calls a preview "saved"',
       /Nothing was saved/.test(webPreview) && /Nothing was saved/.test(appPreview),
       'a preview that reads as saved is a document she thinks she has issued');
}

ck('  and nothing borrows the delivery ETA for the pickup time',
   !/delivery_eta/.test(JSON.stringify(body))
   && !/delivery_eta/.test(panelCode) && !/delivery_eta/.test(bolJs),
   'they are different moments: delivery_eta is when a trucker promised to ARRIVE, ' +
   'pickup is when the truck was loaded');
ck('  pickup comes from its own two fields and nowhere else',
   /pickup_date: \$\('bol_pickup_date'\)\.value/.test(bolJs)
   && /pickup_time: \$\('bol_pickup_time'\)\.value/.test(bolJs),
   bolJs.slice(0, 200));

ck('no page threw while rendering', errors.length === 0, errors.join(' | '));
dom.window.close();

// ── THE SAME DOCUMENT ON THE PHONE ──────────────────────────────────────
// Apsara, 2026-09-16: "Build bol into edge yard app and website(under
// documents)". Driven rather than diffed against the website: the two
// screens are deliberately laid out differently (four fact boxes per row is
// unusable on a phone), so form-parity's field-by-field comparison is the
// wrong tool here. What must match is the PAYLOAD — both clients have to ask
// the same server for the same document.
section('G — the app');
{
    const APP = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    const appErrors = [];
    const appDom = new JSDOM(APP, {
        runScripts: 'dangerously', url: 'http://localhost/',
        beforeParse(w) {
            w.fetch = (u, opts) => {
                const k = String(u).split('?')[0].replace(/^https?:\/\/[^/]+/, '');
                w.__sent = w.__sent || [];
                if (opts && opts.method === 'POST') w.__sent.push({ url: k, body: JSON.parse(opts.body || '{}') });
                return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({}),
                    json: () => Promise.resolve(k === '/api/address-book' ? BOOK
                        : k === '/api/me' ? { ok: true, role: 'admin' } : { ok: true }) });
            };
            w.alert = () => {}; w.confirm = () => true;
            w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
            w.open = () => {};
            w.addEventListener('error', (e) => appErrors.push(e.message));
        },
    });
    await new Promise((r) => setTimeout(r, 700));
    const aw = appDom.window, ad = aw.document;

    ck('the app offers a BOL sub-tab under Documents',
       /\['bol', 'BOL'\]/.test(APP) && typeof aw.renderBolForm === 'function',
       'it sits beside Proforma and Invoice, where her other documents already are');

    // Reached by CLICKING the sub-tab, not by setting docsSubTab. That is a
    // top-level `let`, so it is not a property of window — assigning it makes
    // a stray the page never reads, the Proforma wizard renders instead, and
    // the assertion below fails for a reason that has nothing to do with the
    // BOL. Third time this trap has cost this project a debugging session.
    if (typeof aw.renderDocumentsTab === 'function') {
        await aw.renderDocumentsTab();
        await new Promise((r) => setTimeout(r, 200));
        const tab = ad.querySelector('.doc-subtab-btn[data-subtab="bol"]');
        ck('  the BOL button is on screen beside Proforma and Invoice', !!tab);
        if (tab) {
            tab.dispatchEvent(new aw.MouseEvent('click', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 250));
        }
    }
    const inp = ad.getElementById('bolw_consignee');
    ck('  the form renders', !!inp && !!ad.getElementById('bolw_seal'));

    if (inp) {
        inp.value = 'ecc';
        inp.dispatchEvent(new aw.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
        const items = [...ad.querySelectorAll('#bolwConsigneeList .ac-item')];
        ck('  typing part of a name offers a match', items.length === 1, `${items.length} matches`);
        if (items.length) {
            items[0].dispatchEvent(new aw.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            await new Promise((r) => setTimeout(r, 40));
            ck('  picking it fills the name and the address',
               inp.value === 'Eccomelt' && /1234 Foundry Rd/.test(ad.getElementById('bolw_address').value),
               `${JSON.stringify(inp.value)} / ${JSON.stringify(ad.getElementById('bolw_address').value)}`);
        }

        const setA = (id, v) => { const el = ad.getElementById(id); el.value = v; el.dispatchEvent(new aw.Event('input', { bubbles: true })); };
        setA('bolw_no', 'EM-1047'); setA('bolw_po', 'PO-55410'); setA('bolw_appt', 'APT-77213');
        setA('bolw_pdate', '2026-09-15'); setA('bolw_ptime', '09:30');
        setA('bolw_carrier', 'Santiago Trucking'); setA('bolw_driver', 'Miguel Ortiz');
        setA('bolw_container', 'TRL-8821'); setA('bolw_seal', '40217');
        ad.querySelectorAll('#docBody input[data-bi="0"]').forEach((el) => {
            const v = { description: 'Aluminium combo scrap', pieces: '14', gross_weight: '46300', tare_weight: '4120', net_weight: '42180' }[el.dataset.bf];
            el.value = v; el.dispatchEvent(new aw.Event('input', { bubbles: true }));
        });

        // ── NODE IDENTITY, NOT VALUE ─────────────────────────────────────
        // A phone repaint that rebuilds every input throws the caret to the
        // end of the box on every keystroke. The first version of this check
        // compared the field's VALUE, which a rebuilt input carries just the
        // same — so a mutation replacing the targeted redraw with a full
        // re-render sailed through. The question is not "does it hold the
        // right text" but "is it the same element the finger is in", so the
        // node is captured before typing and compared by identity after.
        const before = ad.querySelector('#docBody input[data-bi="0"][data-bf="gross_weight"]');
        before.value = '46301';
        before.dispatchEvent(new aw.Event('input', { bubbles: true }));
        const after = ad.querySelector('#docBody input[data-bi="0"][data-bf="gross_weight"]');
        ck('  typing a weight does not rebuild the field under the caret',
           after === before && before.isConnected,
           'a full repaint per keystroke replaces the element and sends the cursor to the end of the box');
        // …while the figures below it still keep up, which is why the
        // targeted redraw exists at all.
        ck('  but the running total still updates',
           /46,301/.test(ad.getElementById('docBody').textContent),
           ad.getElementById('docBody').textContent.slice(-200));
        before.value = '46300';
        before.dispatchEvent(new aw.Event('input', { bubbles: true }));

        ad.getElementById('bolwGenerate').dispatchEvent(new aw.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 150));
        const sentA = (aw.__sent || []).filter((x) => x.url === '/api/bol/generate');
        ck('  Generate posts to the same route as the website', sentA.length === 1, `${sentA.length} posts`);
        const b = sentA.length ? sentA[0].body : {};
        ck('  and sends the same payload shape',
           b.driver === 'Miguel Ortiz' && b.pickup_time === '09:30' && b.po_number === 'PO-55410'
           && b.appointment_id === 'APT-77213' && b.seal_no === '40217'
           && b.items[0].gross_weight === '46300' && b.items[0].tare_weight === '4120',
           JSON.stringify(b).slice(0, 240));
        ck('  so both clients ask for one document, not two versions of it',
           JSON.stringify(Object.keys(b).sort()) === JSON.stringify(Object.keys(body).sort()),
           `app: ${Object.keys(b).sort().join(',')}\n        web: ${Object.keys(body).sort().join(',')}`);
    }

    ck('  and nothing threw', appErrors.length === 0, appErrors.slice(0, 2).join(' | '));
    appDom.window.close();
}

section('H — the store behind Edit');
{
    // Apsara, 2026-09-16: "Edit Bol option also needed". The BOL used to save
    // only the rendered PDF, which is where the typing ENDED — there was
    // nothing to reopen. So "add an Edit button" was not a UI change; the
    // data it edits had to exist first.
    const os = require('os');
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bols-'));
    const cfg = require('../config');
    cfg.BOLS_FILE = path.join(TMP, 'bols.json');
    fs.writeFileSync(cfg.BOLS_FILE, '[]');
    const store = require('../helpers/bols');

    const mk = (over) => Object.assign({
        bol_no: 'EM-1047', bol_date: '2026-09-15', consignee_name: 'Eccomelt LLC',
        consignee_address: 'Eccomelt LLC\n1234 Foundry Rd', po_number: 'PO-55410',
        appointment_id: 'APT-77213', pickup_date: '2026-09-15', pickup_time: '09:30',
        carrier: 'Santiago Trucking', driver: 'Miguel Ortiz',
        container_no: 'TRL-8821', seal_no: '40217', weight_unit: 'lb',
        items: [{ description: 'Aluminium combo scrap', pieces: '14',
                  gross_weight: '46,300', tare_weight: '4120', net_weight: '42180' }],
    }, over || {});

    const first = await store.saveBol(mk());
    ck('a generated BOL stores its fields, not just a PDF', !!first && !!first.id,
       JSON.stringify(first && first.id));
    const back = store.getBol(first.id);
    ck('  and every field comes back',
       back && back.driver === 'Miguel Ortiz' && back.pickup_time === '09:30'
       && back.seal_no === '40217' && back.po_number === 'PO-55410',
       JSON.stringify(back && { driver: back.driver, seal: back.seal_no }));

    // ── WEIGHTS COME BACK AS TYPED ───────────────────────────────────
    // Kept as strings on purpose. Parsing them here would make "46,300"
    // reappear as 46300 after an edit that never touched that box, which
    // is a number silently changing itself on a weight document.
    ck('  weights come back exactly as typed, commas and all',
       back && back.items[0].gross_weight === '46,300',
       JSON.stringify(back && back.items[0]));

    // ── EDITING REPLACES, IT DOES NOT ACCUMULATE ─────────────────────
    // Two records both claiming to be EM-1047 is the failure this guards:
    // the number IS the document's identity, it is what the buyer quotes.
    const second = await store.saveBol(mk({ driver: 'Luis Ramos', bol_no: 'em 1047' }));
    ck('editing and regenerating replaces the same record',
       second.id === first.id && store.listBols().length === 1,
       `${store.listBols().length} rows; ids ${first.id} / ${second.id}`);
    ck('  matching the number loosely, so "em 1047" is not a second BOL',
       store.keyOf('em 1047') === store.keyOf('EM-1047'));
    ck('  the edit took', store.getBol(first.id).driver === 'Luis Ramos');
    ck('  and a reissue is visible as one', second.generated_count === 2,
       `generated_count ${second.generated_count} — a BOL on its second printing ` +
       'looks identical to a fresh one without this');
    ck('  while the original creation time is kept',
       second.created_at === first.created_at,
       'an edit is not a new document');

    // A blank number is not a number. Merging two unnumbered BOLs would
    // silently destroy one.
    await store.saveBol(mk({ bol_no: '', consignee_name: 'A' }));
    await store.saveBol(mk({ bol_no: '', consignee_name: 'B' }));
    ck('two BOLs with no number stay two BOLs', store.listBols().length === 3,
       `${store.listBols().length} rows`);

    ck('the list carries enough to recognise a document',
       store.listBols().every((r) => 'bol_no' in r && 'consignee_name' in r && 'container_no' in r),
       JSON.stringify(store.listBols()[0]));
    ck('  but not the whole record', !('items' in (store.listBols()[0] || {})),
       'shipping every item line to draw a few rows is what made other lists slow');

    ck('a BOL can be removed from the list', await store.deleteBol(first.id) === true);
    ck('  and removing a missing one says so', await store.deleteBol('nope') === false);

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

    section('H2 — the date it starts on');
{
    // Apsara, 2026-09-16: "by default bol date should be today date".
    //
    // It always DID default to today — through new Date().toISOString(),
    // which is UTC. That is the shape of date bug worth having a test for:
    // correct for most of the working day, and quietly wrong at the end of
    // it. Frisco is UTC-5 in summer, so from 7pm local the UTC date is
    // already tomorrow, and an evening BOL printed tomorrow's date and filed
    // itself in tomorrow's archive folder.
    //
    // ── PINNED TO 8PM, THE HOUR THAT BREAKS ──────────────────────────────
    // A test run at any other time passes either way, which is exactly how
    // this survived being written in the first place. The clock is fixed at
    // 01:30 UTC on the 17th — 8:30pm on the 16th in Frisco — so the two
    // answers differ and only the right one passes.
    const AT_8PM_FRISCO = Date.parse('2026-09-17T01:30:00Z');
    const bad = new Date(AT_8PM_FRISCO).toISOString().slice(0, 10);
    const good = new Date(AT_8PM_FRISCO).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    ck('the fixture really is on the far side of the rollover',
       bad === '2026-09-17' && good === '2026-09-16',
       `UTC says ${bad}, the yard says ${good} — if these matched, this section would prove nothing`);

    for (const [label, file, name] of [
        ['website', 'dashboard/documents.html', 'bolTodayStr'],
        ['app', 'mobile-app/www/index.html', 'bolTodayISO'],
    ]) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        // Bounded at the function's own closing brace. A fixed character
        // slice cut the body in half and the eval failed with a syntax error
        // that had nothing to do with dates.
        const at = src.indexOf(`function ${name}()`);
        const close = src.indexOf('\n}', at);
        const body = src.slice(at, close + 2);

        // EVALUATED with the clock pinned, not grepped. A function that
        // mentions America/Los_Angeles and still returns a UTC string would
        // sail through a source check — which is how the UTC version got
        // written in the first place.
        const RealDate = Date;
        class Pinned extends RealDate {
            constructor(...a) { super(...(a.length ? a : [AT_8PM_FRISCO])); }
            static now() { return AT_8PM_FRISCO; }
        }
        let pinned = null, err = null;
        try {
            // eslint-disable-next-line no-new-func
            pinned = new Function('Date', `${body}\nreturn ${name}();`)(Pinned);
        } catch (e) { err = e; }

        ck(`${label}: at 8:30pm in Frisco the default is TODAY, not tomorrow`,
           !err && pinned === '2026-09-16',
           err ? err.message : `got ${pinned} — UTC would say 2026-09-17, which is the bug`);
    }

    // And the archive folder has to agree with the paper, or a BOL raised in
    // the evening is filed under a day nobody looks in.
    const apiTxt = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const block = apiTxt.slice(apiTxt.indexOf('const savedDate = body.bol_date'), apiTxt.indexOf('const savedDate = body.bol_date') + 220);
    ck('  and the server files it under the same day',
       /America\/Los_Angeles/.test(block) && !/toISOString/.test(block),
       block.trim());
}

section('I — Generate hands back the file');
    {
        // Apsara: "When i click generate-It needs to get as downloadable
        // file". It used to report a filename, which is an inventory
        // number rather than a document.
        const web = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
        const app3 = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');

        // ANCHORED TO THE RESPONSE, not to the words. The first version
        // matched /saved_date: savedDate,/ anywhere in api.js — which the
        // stored record's own `last_saved_date: savedDate,` line satisfies,
        // so deleting the real one from the response left this green. A
        // mutation doing exactly that survived until the two were told apart.
        const apiSrc = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
        ck('the route returns the date the archive filed it under',
           /saved_filename: path\.basename\(savedPath\),\s*\n\s*saved_date: savedDate,/.test(apiSrc),
           'without it the client has to guess the folder, and guesses wrong ' +
           'every time the BOL date is left blank');

        ck('website: Generate downloads the saved file',
           /await bolDownload\(out\.saved_filename, out\.saved_date\)/.test(web));
        ck('  through an <a download>, like a normal link',
           /a\.download = filename;/.test(web.slice(web.indexOf('async function bolDownload'),
                                                    web.indexOf('async function bolDownload') + 1200)));
        ck('  and pulls it from the ARCHIVE, not from the generate response',
           /\/api\/documents\/download' \+ qs/.test(web.slice(web.indexOf('async function bolDownload'),
                                                               web.indexOf('async function bolDownload') + 1200)),
           'so what lands in her Downloads folder is the exact file the archive holds');

        ck('app: Generate downloads too',
           /deliverExportedFile\(blob, out\.saved_filename, 'pdf'\)/.test(app3),
           'an <a download> does nothing in an Android WebView — deliverExportedFile ' +
           'writes the file and opens the share sheet on a real device');

        // A failure to hand over is not a failure to save, and saying so
        // matters: "could not download" alone reads as "it did not save",
        // and she would generate it again.
        for (const [label, src] of [['website', web], ['app', app3]]) {
            ck(`${label}: a failed download still says the PDF was saved`,
               /but the download did not start/.test(src),
               '"could not download" alone reads as "it did not save"');
        }
    }

    }

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
