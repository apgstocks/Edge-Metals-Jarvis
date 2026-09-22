// ── tests/invoice-weight-chain.js ─────────────────────────────────────────
// Apsara, 2026-09-16: "When i change the gross,tare,box,container wight is
// invoice tab,corresponding net weight in mt,lbs should be computed auto so as
// rate.provide refresh button so that it can fetch latets data from order
// details"
//
// ── WHAT IS ACTUALLY BEING TESTED ───────────────────────────────────────────
// A chain that ends in money:
//
//     gross - (truck + container tare + chassis + boxes) = NET LBS
//     net lbs / 2204.62                                  = QTY MT
//     qty x rate                                         = AMOUNT
//
// She was typing a corrected gross and then working the other three out on a
// calculator, into boxes that had no idea they were related. Now they do —
// which means CORRECTING A WEIGHT CHANGES WHAT IS BILLED. That is the point of
// correcting it, and it is also the reason for the sharpest check in this
// file: section C, that rendering a STORED invoice recomputes nothing. An
// invoice from March must not restate its tonnage because 2204.62 disagrees
// with the figure her sheet carried when it was issued.
//
// ── AND IT IS TESTED TWICE ──────────────────────────────────────────────────
// The website and the phone have the same thirteen-column grid. One invoice
// corrected on a phone and the same one corrected on the website must reach
// the same total, so section D runs the identical arithmetic through the app's
// own code and compares the two to the digit.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const WEB = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');

// Her real shape: 56,000 gross over a 29,500 tare.
const GROSS = 56000, TRUCK = 15000, CTARE = 8000, CHASSIS = 6000, BOXES = 500;
const NET = GROSS - (TRUCK + CTARE + CHASSIS + BOXES);      // 26,500
const MT = (NET / 2204.62).toFixed(3);                      // 12.020
const RATE = 1000;

function mountWeb(preview) {
    const dom = new JSDOM(WEB, { runScripts: 'dangerously', url: 'http://localhost/documents',
        beforeParse(w) {
            w.__hits = [];
            w.fetch = (u) => {
                const s = String(u);
                if (s.includes('invoice/preview')) {
                    w.__hits.push(s);
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(preview || {}) });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, entries: [], bols: [], packing_lists: [] }) });
            };
            w.alert = () => {}; w.confirm = () => true;
        } });
    return dom;
}

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the chain, on the website');
// ══════════════════════════════════════════════════════════════════════════
{
    const dom = mountWeb();
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window, d = w.document;
    // ── THIS SECTION IS ABOUT THE MT CHAIN, SO IT ASKS FOR MT ────────────
    // The invoice now carries a unit and new ones default to POUNDS, after
    // 260831_SU_26EM05 billed $13.09 for a container worth $28,860.80 — the
    // Quantity column headed MT while the Rate box held her per-pound price.
    // Apsara, 2026-09-23: "If i want to generate inv in lbs?"
    //
    // Every assertion below is unchanged and still guards the tonnes chain
    // she asked for on 2026-09-16; it just has to say which unit it means
    // now, the same way she does. Section C covers pounds.
    w.eval("$('inv_units').value = 'mt';");
    w.eval("$('invItemsEditor').innerHTML = invItemRowHtml({ item_desc: 'Aluminium combo', rate: " + RATE + ", packing: {} }, 0);"
         + " wireInvItemRow($('invItemsEditor').firstElementChild);");
    const row = d.querySelector('.inv-item-row');
    const set = (cls, v) => { const e = row.querySelector(cls); e.value = String(v); e.dispatchEvent(new w.Event('input', { bubbles: true })); };
    const val = (cls) => row.querySelector(cls).value;

    set('.inv-p-gross', GROSS);
    ck('a gross on its own is the net', val('.inv-p-net') === GROSS.toLocaleString('en-US'), val('.inv-p-net'));
    set('.inv-p-truck', TRUCK); set('.inv-p-tare', CTARE); set('.inv-p-chassis', CHASSIS); set('.inv-p-boxes', BOXES);

    ck('net lbs is gross minus the four tare columns',
       val('.inv-p-net') === NET.toLocaleString('en-US'), `${val('.inv-p-net')} — expected ${NET.toLocaleString('en-US')}`);
    ck('  MT follows the pounds', val('.inv-item-weight') === MT, `${val('.inv-item-weight')} — expected ${MT}`);
    ck('  and the amount follows the MT',
       val('.inv-item-amount') === '$' + (Number(MT) * RATE).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
       val('.inv-item-amount'));
    ck('  and the invoice total with it',
       d.getElementById('invFinalAmountDisplay').textContent === val('.inv-item-amount'),
       `${d.getElementById('invFinalAmountDisplay').textContent} vs ${val('.inv-item-amount')}`);

    // ── THE WHOLE POINT: A CORRECTION REPRICES ───────────────────────────
    set('.inv-p-gross', 57000);
    ck('correcting the gross reprices the line',
       val('.inv-p-net') === '27,500' && val('.inv-item-weight') === (27500 / 2204.62).toFixed(3),
       `${val('.inv-p-net')} / ${val('.inv-item-weight')}`);
    ck('  which is the point of correcting it',
       val('.inv-item-amount') !== '$' + (Number(MT) * RATE).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
       'a weight that does not reach the total is a weight she has to retype into the total');

    // ── NET IS NOT TYPEABLE ──────────────────────────────────────────────
    // Two answers to "what is the net" eventually differ, and they differ on
    // a commercial invoice a buyer checks with a calculator.
    ck('the net box cannot be typed into', row.querySelector('.inv-p-net').readOnly === true);

    // ── BLANK IS NOT ZERO ────────────────────────────────────────────────
    set('.inv-p-gross', '');
    ck('clearing the gross empties the net rather than printing 0',
       val('.inv-p-net') === '' && val('.inv-item-weight') === '',
       `net "${val('.inv-p-net')}", mt "${val('.inv-item-weight')}" — a zero net is a CLAIM that the container weighed nothing`);

    // Rate still works on its own: she changes a price without touching a
    // scale ticket far more often than the reverse.
    set('.inv-p-gross', GROSS); set('.inv-item-rate', 1200);
    ck('the rate alone still reprices',
       val('.inv-item-amount') === '$' + (Number(MT) * 1200).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
       `${val('.inv-item-amount')} at ${val('.inv-item-weight')} mt`);

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('B — refresh asks, and keeps what it said it would');
// ══════════════════════════════════════════════════════════════════════════
{
    // Apsara, asked what Refresh should overwrite: "Ask me each time."
    const fresh = {
        inv_no: 'SHEET-NEW', terms: 'CIF', container_no: 'K1',
        line_items: [
            { item_desc: 'Aluminium combo', weight: 23.469, rate: 1000, container_no: 'K1', packing: { gross_weight_lbs: '56,000' } },
            { item_desc: 'Regular combo', weight: 20, rate: 900, container_no: 'K1', packing: { gross_weight_lbs: '50,000' } },
        ],
    };
    const dom = mountWeb(fresh);
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window, d = w.document;
    w.eval("enterInvoiceReview({ inv_no: 'MINE-1', terms: 'LC', container_no: 'K1',"
         + " line_items: [{ item_desc: 'one old line', weight: 1, rate: 1, packing: {} }] },"
         + " { source: { containers: ['K1'], multi: false } });");
    d.getElementById('inv_terms').value = 'TERMS I TYPED';
    w.eval("$('invNotesEditor').innerHTML = invNoteRowHtml({ label: 'Less: Freight', amount: -250 }, 0);"
         + " wireInvNoteRow($('invNotesEditor').firstElementChild);");

    ck('there is a refresh button', !!d.getElementById('btnInvRefresh'));
    ck('  which does not fire on its own', (w.__hits || []).length === 0,
       'a button that refreshes on click is a button; one that refreshes on render is a surprise');

    d.getElementById('btnInvRefresh').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ck('  clicking it ASKS rather than doing', !d.getElementById('invRefreshChoice').classList.contains('hidden'));
    ck('    offering both scopes',
       !!d.getElementById('btnInvRefreshRows') && !!d.getElementById('btnInvRefreshAll'),
       'her answer was "Ask me each time"');
    ck('    and a way out', !!d.getElementById('btnInvRefreshCancel'));

    d.getElementById('btnInvRefreshRows').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    ck('rows only: the sheet\'s lines arrive', d.querySelectorAll('.inv-item-row').length === 2,
       String(d.querySelectorAll('.inv-item-row').length));
    ck('  and nothing she typed is lost',
       d.getElementById('inv_terms').value === 'TERMS I TYPED' && d.getElementById('inv_no').value === 'MINE-1',
       `${d.getElementById('inv_terms').value} / ${d.getElementById('inv_no').value}`);
    ck('  including her adjustments',
       d.querySelectorAll('.inv-note-row').length === 1,
       'a freight deduction she entered is not in the order sheet and cannot come back from it');
    ck('  and it says what it did', /2 lines/.test(d.getElementById('invRefreshStatus').textContent),
       d.getElementById('invRefreshStatus').textContent);

    d.getElementById('btnInvRefresh').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    d.getElementById('btnInvRefreshAll').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    ck('the whole invoice: the header comes back too',
       d.getElementById('inv_no').value === 'SHEET-NEW' && d.getElementById('inv_terms').value === 'CIF',
       `${d.getElementById('inv_no').value} / ${d.getElementById('inv_terms').value}`);

    // ── THE CONTAINER IT ASKS ABOUT IS THE ONE IT OPENED ─────────────────
    // Not the one in the header box: she may have corrected that, and
    // refreshing would then pull a DIFFERENT shipment's figures into an
    // invoice already carrying this one's.
    d.getElementById('inv_container').value = 'SOMETHING-ELSE';
    d.getElementById('btnInvRefresh').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    d.getElementById('btnInvRefreshRows').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    ck('refresh asks about the container it opened',
       (w.__hits || []).every((h) => h.includes('container=K1')),
       (w.__hits || []).join(' , '));

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('C — a stored invoice is NOT recomputed on load');
// ══════════════════════════════════════════════════════════════════════════
{
    // THE SHARPEST CHECK IN THIS FILE. The chain runs on an EDIT, never on a
    // render. An invoice issued in March carries the tonnage her sheet had
    // that day; opening it to reprint must not restate it because 2204.62
    // disagrees by two kilos. A silent restatement on a document already sent
    // is the worst failure this feature could have.
    const dom = mountWeb();
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window, d = w.document;
    w.eval("enterInvoiceReview({ inv_no: 'OLD', container_no: 'K1', line_items: [{"
         + " item_desc: 'Aluminium combo', weight: 23.999, rate: 1000, container_no: 'K1',"
         + " packing: { gross_weight_lbs: '56,000', truck_lbs: '15,000', container_tare_lbs: '8,000',"
         + "            chassis_lbs: '6,000', boxes_weight_lbs: '500', net_weight_lbs: '26,500' } }] },"
         + " { source: { containers: ['K1'], multi: false } });");
    const row = d.querySelector('.inv-item-row');
    ck('the stored MT is shown exactly as filed',
       row.querySelector('.inv-item-weight').value === '23.999',
       `${row.querySelector('.inv-item-weight').value} — 12.020 would be this code quietly restating a sent invoice`);
    ck('  and the stored net lbs too',
       row.querySelector('.inv-p-net').value === '26,500', row.querySelector('.inv-p-net').value);
    ck('  and the amount is the stored one',
       row.querySelector('.inv-item-amount').value === '$23,999.00',
       row.querySelector('.inv-item-amount').value);

    // Touching one weight opts INTO the chain, which is the whole contract:
    // she changed something, so the figures that depend on it move.
    const g = row.querySelector('.inv-p-gross');
    g.value = '56000'; g.dispatchEvent(new w.Event('input', { bubbles: true }));
    ck('but touching a weight opts into it', row.querySelector('.inv-item-weight').value === MT,
       row.querySelector('.inv-item-weight').value);

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the phone reaches the same figure');
// ══════════════════════════════════════════════════════════════════════════
{
    // One invoice corrected on a phone and the same one corrected on the
    // website must reach the same total. The two have separate code — they
    // are separate clients — so the check is on the RESULT, not on the source
    // looking similar.
    const dom = new JSDOM(APP, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const SCRIPT = [...APP.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    w.fetch = () => new Promise(() => {});   // boot must never reach the DOM after close()
    w.setInterval = () => 0;
    try { w.eval(SCRIPT); } catch (e) { /* boot needs a session; the helpers are defined by then */ }

    // invwRowNetLbs is a top-level function declaration, so it IS on window —
    // unlike a top-level const, which is not, and which this project has been
    // caught by seven times.
    ck('the phone has the same net rule', typeof w.invwRowNetLbs === 'function',
       'a rule that exists on one client only is a rule that will disagree with itself');

    const mk = (vals) => ({ querySelector: (sel) => ({ value: vals[sel] == null ? '' : String(vals[sel]) }) });
    const net = w.invwRowNetLbs(mk({
        '.invw-p-gross': GROSS, '.invw-p-truck': TRUCK, '.invw-p-tare': CTARE,
        '.invw-p-chassis': CHASSIS, '.invw-p-boxes': BOXES,
    }));
    ck('  and it gives the same net', net === NET, `${net} vs ${NET}`);
    ck('  and therefore the same MT', (net / 2204.62).toFixed(3) === MT,
       `${(net / 2204.62).toFixed(3)} vs ${MT}`);
    ck('  a missing gross is null on the phone too',
       w.invwRowNetLbs(mk({ '.invw-p-truck': 15000 })) === null,
       'a zero net would claim a container that weighed nothing');
    // Read out of the SOURCE, not off the window. INVW_LBS_PER_MT is a
    // top-level `const`, which is a script-scope binding and NOT a window
    // property — the eighth time this project has been caught by that, and
    // the first version of this check failed on correct code because of it.
    ck('  and the conversion is the same constant on both clients',
       /INVW_LBS_PER_MT = 2204\.62/.test(APP) && /LBS_PER_MT = 2204\.62/.test(WEB),
       'two constants that drift are two invoices that disagree');

    ck('the phone offers the refresh too', /id="btnInvwRefresh"/.test(APP),
       'she uses the phone at the scale, which is exactly where a sheet correction lands');
    ck('  and asks the same question',
       /id="btnInvwRefreshRows"/.test(APP) && /id="btnInvwRefreshAll"/.test(APP));
    ck('  against the container it opened, not the form',
       /invw\.source = \{ containers:/.test(APP),
       'reading the container back off the form pulls another shipment into this invoice');
    ck('  and its net box is read-only as well',
       /class="invw-p-net" readonly/.test(APP),
       'typeable on one client and derived on the other is two answers to one question');

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the same chain in POUNDS, where nothing converts');
// ══════════════════════════════════════════════════════════════════════════
// 260831_SU_26EM05 billed $13.09 for a container worth $28,860.80. Every
// figure on it was right — 49,760 lb net, $0.58 a pound — and the money was
// wrong by 2204x because the Quantity column was headed MT while the Rate
// box still held the per-pound price. recalcWeights created that mismatch
// itself, by dividing the quantity and leaving the rate alone.
//
// Apsara, 2026-09-23: "If i want to generate inv in lbs?"
//
// In pounds there is no conversion anywhere, which is the point: the printed
// figures multiply out EXACTLY. 22.571 x a rounded per-MT rate is 29 cents
// adrift; 49,760 x 0.58 is not.
{
    const dom = mountWeb();
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window, d = w.document;
    ck('a new invoice is in pounds', w.eval("$('inv_units').value") === 'lb',
       'she buys and prices per pound; that is the default now');

    w.eval("$('invItemsEditor').innerHTML = invItemRowHtml({ item_desc: 'Sealed Units', rate: 0.58, packing: {} }, 0);"
         + " wireInvItemRow($('invItemsEditor').firstElementChild);");
    const row = d.querySelector('.inv-item-row');
    const set = (cls, v) => { const e = row.querySelector(cls); e.value = String(v); e.dispatchEvent(new w.Event('input', { bubbles: true })); };
    const val = (cls) => row.querySelector(cls).value;

    // Her real container: 79,100 gross, 27,900 truck, 12 boxes x 120 lb.
    set('.inv-p-gross', 79100); set('.inv-p-truck', 27900); set('.inv-p-boxes', 1440);

    ck('net lbs is still gross minus the tares', val('.inv-p-net') === '49,760', val('.inv-p-net'));
    // THE LINE THAT COST THE MONEY. It used to divide by 2204.62 here.
    ck('  the quantity stays in POUNDS', val('.inv-item-weight') === '49760',
       `${val('.inv-item-weight')} — a tonnage here is what produced $13.09`);
    ck('  and the amount is the real one', val('.inv-item-amount') === '$28,860.80',
       `${val('.inv-item-amount')} — the sent invoice said $13.09`);

    // Switching unit must restate the quantity, or the box keeps a figure in
    // the unit she just left — which IS the bug, arrived at another way.
    w.eval("$('inv_units').value = 'mt'; $('inv_units').dispatchEvent(new Event('change'));");
    ck('switching to MT restates the quantity', val('.inv-item-weight') === '22.571', val('.inv-item-weight'));
    w.eval("$('inv_units').value = 'lb'; $('inv_units').dispatchEvent(new Event('change'));");
    ck('  and switching back restores the pounds', val('.inv-item-weight') === '49760', val('.inv-item-weight'));
    ck('  with the amount right again', val('.inv-item-amount') === '$28,860.80', val('.inv-item-amount'));

    // The payload the route receives has to say which unit it is in, or the
    // headings are a guess.
    const payload = w.eval('JSON.stringify(collectInvoicePayload())');
    ck('the payload states its unit', JSON.parse(payload).units === 'lb', payload.slice(0, 80));

    dom.window.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
