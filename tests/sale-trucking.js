// ── tests/sale-trucking.js ────────────────────────────────────────────────
// Apsara, 2026-11-04: "Similar to loads trucking in edge yard,sales trucking
// should be there na", and asked who bears it: "You haul, buyer is charged".
//
// So a sale's trucking is the MIRROR of a purchase's, not a copy: there the
// haulage comes OFF what the seller is paid, here it goes ON what the buyer
// owes. The sign is the whole of the difference, and the sign is what every
// check below is about.
//
// ── WHY SECTION E EXISTS ─────────────────────────────────────────────────
// CLAUDE.md rule 3: "ALwyas test end to end when you add a new feature",
// because helper tests and screen tests can both be green while the feature
// does not work — "the route does not forward the new field to the helper".
// Both outbound routes whitelist their fields explicitly, so that gap was
// real here: the form could have filled trucking in perfectly and the route
// would have dropped it. Section E posts through the real route and reads
// the figure back out of the real route.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
// Set BEFORE config is required, so the real server in section E reads the
// same store these helpers write to. Assigning cfg.DATA_DIR afterwards works
// for a direct helper call and NOT for api.js, which wires its routes off the
// config it saw at require time — a split-brain that would have made section
// E test an empty store and pass for the wrong reason.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-trucking-'));
process.env.DATA_DIR = dir;
process.env.API_TOKEN = 't';
const cfg = require(path.join(ROOT, 'config'));
cfg.DATA_DIR = dir;
cfg.OUTBOUND_LOADS_FILE = path.join(dir, 'outbound_loads.json');

const O = require(path.join(ROOT, 'helpers/outboundLoads'));
const item = (price) => ({ description: 'Al wheels', gross_weight: 1000, tare_weight: 0, price, unit: 'lb' });

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the arithmetic, and its sign');
// ══════════════════════════════════════════════════════════════════════════
{
    const a = await O.addOutboundLoad({ date: '2026-11-04', buyer: 'Acme', weight_unit: 'lb',
        items: [item(0.50)], trucking_company: 'Zimex', trucking_amount: 200,
        trucking_note: 'LA to Long Beach', created_by: 't' });
    ck('the metal is still the metal', a.amount === 500, String(a.amount));
    ck('the haul is recorded with who did it', a.trucking_amount === 200 && a.trucking_company === 'Zimex',
       `${a.trucking_amount} / ${a.trucking_company}`);
    ck('the buyer owes metal PLUS haul', a.net_receivable === 700, String(a.net_receivable));
    // The thing that makes it a mirror and not a copy. If this ever reads
    // 300 someone has pasted the purchase side in.
    ck('  not metal MINUS haul', a.net_receivable !== 300, String(a.net_receivable));
    ck('receivableOf is the single reader', O.receivableOf(a) === 700, String(O.receivableOf(a)));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — a sale without trucking is the sale it has always been');
// ══════════════════════════════════════════════════════════════════════════
{
    const b = await O.addOutboundLoad({ date: '2026-11-04', buyer: 'Plain Co', weight_unit: 'lb',
        items: [item(0.40)], created_by: 't' });
    ck('no haul, no addition', b.net_receivable === 400 && b.amount === 400, String(b.net_receivable));
    ck('  and nothing is invented on the record',
       b.trucking_amount === null && b.trucking_company === null, JSON.stringify([b.trucking_amount, b.trucking_company]));
    // Every sale recorded before this existed has no net_receivable key at
    // all. Those must read as "nothing added", not as null.
    ck('a sale recorded before this existed reads as its amount',
       O.receivableOf({ amount: 123 }) === 123, String(O.receivableOf({ amount: 123 })));
    ck('a sale with no amount yet owes nothing, not the freight',
       O.receivableFrom(null, 200) === null, String(O.receivableFrom(null, 200)));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — an edit must not quietly drop what the buyer owes');
// ══════════════════════════════════════════════════════════════════════════
{
    const c = await O.addOutboundLoad({ date: '2026-11-04', buyer: 'Edit Co', weight_unit: 'lb',
        items: [item(0.50)], trucking_company: 'Zimex', trucking_amount: 200, created_by: 't' });

    // The caller CLAUDE.md records breaking twice is the one without a form.
    const kept = await O.editOutboundLoad(c.id, { date: c.date, buyer: 'Edit Co',
        weight_unit: 'lb', items: [item(0.60)] });
    ck('an edit that never mentions trucking keeps it',
       kept.trucking_amount === 200 && kept.trucking_company === 'Zimex',
       `${kept.trucking_amount} / ${kept.trucking_company}`);
    ck('  and re-derives the receivable off the NEW amount',
       kept.amount === 600 && kept.net_receivable === 800, `${kept.amount} / ${kept.net_receivable}`);

    // ...but she must still be able to take it off.
    const cleared = await O.editOutboundLoad(c.id, { date: c.date, buyer: 'Edit Co',
        weight_unit: 'lb', items: [item(0.60)], trucking_amount: '', trucking_company: '' });
    ck('an edit that CLEARS it clears it', cleared.trucking_amount === null, String(cleared.trucking_amount));
    ck('  and the buyer owes the metal again', cleared.net_receivable === 600, String(cleared.net_receivable));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — margin is NOT improved by hauling');
// ══════════════════════════════════════════════════════════════════════════
// The freight is collected and paid out again. Counting it as margin would
// make every sale with a truck on it look better than it was — the same
// double-count helpers/yardProfit.js warns about, with the sign flipped.
{
    const m = O.getLoadMargin({ amount: 600, net_receivable: 800, trucking_amount: 200,
        linked_inbound_load_ids: [] });
    ck('an unlinked sale still has UNKNOWN margin, not zero', m.margin === null, JSON.stringify(m));
    const src = fs.readFileSync(path.join(ROOT, 'helpers/outboundLoads.js'), 'utf8');
    const fn = src.slice(src.indexOf('function getLoadMargin'), src.indexOf('function getOutboundReport'));
    ck('getLoadMargin computes off amount, never off the receivable',
       /outboundLoad\.amount - cost/.test(fn) && !/receivableOf\(outboundLoad\)/.test(fn),
       'freight is passed through, not earned');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — END TO END, through the routes the screens actually post to');
// ══════════════════════════════════════════════════════════════════════════
{
    // THE REAL SERVER, not routes/yard mounted by hand: mounting the module
    // directly needs a ctx it does not get, and faking that ctx would be
    // testing my fake instead of her app.
    const app = require(path.join(ROOT, 'api.js')).createApi();
    const server = http.createServer(app).listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    const call = (method, p, body) => new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ port, method, path: p,
            headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
            (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
                let j = null; try { j = JSON.parse(b); } catch (e) { /* not json */ }
                resolve({ status: res.statusCode, body: j, raw: b }); }); });
        req.on('error', () => resolve({ status: 0, body: null, raw: '' }));
        if (data) req.write(data);
        req.end();
    });

    const created = await call('POST', '/api/outbound-loads', {
        date: '2026-11-04', buyer: 'E2E Co', weight_unit: 'lb', items: [item(0.50)],
        trucking_company: 'Zimex', trucking_amount: 200, trucking_note: 'LA to Long Beach',
    });
    ck('the route accepts a sale with trucking', created.status === 200, `${created.status} ${created.raw.slice(0, 160)}`);
    const rec = created.body && created.body.load;
    ck('  and FORWARDS it to the helper', rec && rec.trucking_amount === 200,
       rec ? JSON.stringify({ a: rec.trucking_amount, c: rec.trucking_company }) : 'no record');
    ck('  so the saved sale says the buyer owes 700', rec && rec.net_receivable === 700,
       rec ? String(rec.net_receivable) : 'no record');

    // Read it back out of the route the LIST screen reads.
    const list = await call('GET', '/api/outbound-loads');
    const row = (list.body || []).find((l) => l.id === (rec && rec.id));
    ck('the list route returns the haul to the card', row && row.trucking_amount === 200,
       row ? String(row.trucking_amount) : 'row missing');
    ck('  and the figure the card prints as due', row && row.net_receivable === 700,
       row ? String(row.net_receivable) : 'row missing');
    // The paid badge and "outstanding" are measured against this. Left on
    // the bare amount, a buyer who paid only for the metal would read as
    // settled with the freight still owed.
    ck('  outstanding is measured against 700, not 500',
       row && row.payment && row.payment.total === 700,
       row && row.payment ? JSON.stringify(row.payment) : 'no payment block');

    // An edit through the real route, with the field absent — the shape a
    // caller without a form sends.
    const edited = await call('PUT', `/api/outbound-loads/${rec.id}`, {
        date: '2026-11-04', buyer: 'E2E Co', weight_unit: 'lb', items: [item(0.60)],
    });
    ck('editing without the field keeps the haul', edited.body && edited.body.load
       && edited.body.load.trucking_amount === 200,
       edited.body && edited.body.load ? String(edited.body.load.trucking_amount) : edited.raw.slice(0, 120));
    ck('  and re-derives 800 off the new amount', edited.body && edited.body.load
       && edited.body.load.net_receivable === 800,
       edited.body && edited.body.load ? String(edited.body.load.net_receivable) : '');

    await new Promise((r) => server.close(r));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — both clients send it, and neither hides it on a sale any more');
// ══════════════════════════════════════════════════════════════════════════
{
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    for (const [name, payloadFile, modalFile] of [
        ['the Edge Yard app', 'mobile-app/www/app/09-loads-deck.js', 'mobile-app/www/app/08-load-modal.js'],
        ['the website',       'dashboard/app/13-loads-render.js',    'dashboard/app/05-load-pricing.js'],
    ]) {
        const payload = read(payloadFile);
        const sale = payload.slice(payload.indexOf('const salePayload'), payload.indexOf('const sendSale'));
        ck(`${name}: the sale payload carries trucking`,
           /trucking_company: payload\.trucking_company/.test(sale)
           && /trucking_amount: payload\.trucking_amount/.test(sale),
           'the form collected it and this object used to drop it');
        const modal = read(modalFile);
        ck(`  and the section is no longer hidden on a sale`,
           !/truck\.style\.display = sale \? 'none' : ''/.test(modal),
           "it was hidden because trucking was a DEDUCTION; it adds now");
        ck(`  with the sign flipped in the live summary`,
           /due from the buyer/.test(modal) && /payable to the seller/.test(modal),
           'both sentences must exist — the purchase one is not removed');
    }
    // The outbound-loads page is a THIRD place a sale can be recorded.
    const ob = read('dashboard/outbound-loads.html');
    ck('the outbound page has the three boxes', /lm_trucking_company/.test(ob)
       && /lm_trucking_amount/.test(ob) && /lm_trucking_note/.test(ob));
    ck('  and sends them', /trucking_company: \$\('lm_trucking_company'\)/.test(ob));
    ck('  and clears them when the modal opens',
       /\$\('lm_trucking_company'\)\.value = ''/.test(ob),
       'a hauler left behind would be charged to the next buyer');
}

// ══════════════════════════════════════════════════════════════════════════
section('G — every reader of "what a sale is worth" agrees');
// ══════════════════════════════════════════════════════════════════════════
// Five callers measured a sale against bare `amount`. A figure that
// disagrees between the card, the ticket, the pay sheet and what Jarvis says
// out loud is worse than no figure at all — helpers/loads.js's words.
{
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    for (const [what, file, needle] of [
        ['the pay ledger',  'helpers/payments.js',   /kind === 'sale' \? receivableOf\(load\)/],
        ['the ticket PDF',  'helpers/loadsPdf.js',   /receivableOf\(load\)/],
        ['the voice path',  'helpers/tools.js',      /paymentSummary\(l\.id, receivableOf\(l\)\)/],
        ['the list route',  'routes/yard.js',        /receivableOf\(l\)\)/],
        ['the yard profit', 'helpers/yardProfit.js', /receivableOf\(l\) \|\| 0/],
    ]) {
        ck(`${what} measures a sale against the receivable`, needle.test(read(file)),
           'left on `amount`, this one would disagree with the other four');
    }
    // And the purchase side is untouched by all of it.
    ck('the purchase side still uses payableOf',
       /kind === 'sale' \? receivableOf\(load\) : payableOf\(load\)/.test(read('helpers/payments.js')),
       'a mirror adds a side, it does not move the existing one');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
