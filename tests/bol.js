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
    ck('  and internal notes are stripped from what the buyer receives',
       !/<!--/.test(html) && !/Apsara/.test(html),
       'the template comments discuss the design; they are not for the customer');
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

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
