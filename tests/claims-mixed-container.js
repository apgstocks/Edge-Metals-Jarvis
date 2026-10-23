// ── tests/claims-mixed-container.js ──────────────────────────────────────────
// An auto-parts container: several materials in one box, one weight slip.
//
// Apsara, 2026-10-21: "say there are like auto parts container where we will
// put more than one material. if there is a weight shortage claim, we will
// take avergae price of all the material that was loaded into the container."
// Asked which average, her answer was about the WEIGHING, not the arithmetic:
// "They will have weight slip for overall container."
//
// That settles it. A container-level slip means nobody knows which grade went
// missing, so there is no grade to match and no per-item rate to choose. The
// only rate that means anything is what the container itself cost per pound —
// money divided by weight — which IS the weighted average and which falls out
// of figures already on the bill.
//
// THE MEAN OF THE RATES IS NOT THAT NUMBER, and section A proves they differ:
// it treats 200 lb of one grade as equal to 40,000 lb of another, and it
// corresponds to no money anyone paid.
//
// Section C is the one that protects her: claims that do not set the flag must
// price EXACTLY as they did before this file existed. CLAUDE.md rule 1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-mixed-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT — DATA_DIR outside the temp dir'); process.exit(1); }

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; failures.push(n); console.log('  FAIL ' + n + (extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 240))); } };
const section = (t) => console.log('\n' + t);

const claimPrice = require(R('helpers/claimPrice.js'));
const claims = require(R('helpers/claims.js'));
const bills = require(R('helpers/bills.js'));

(async () => {

// Her own worked shape, from helpers/bills.js's own example.
const AL   = { description: 'Al combo',  weight: 12000, price: 0.32, price_unit: 'lb', amount: 3840 };
const CAST = { description: 'Auto cast', weight: 17000, price: 0.28, price_unit: 'lb', amount: 4760 };
const EXACT = (3840 + 4760) / (12000 + 17000);           // 0.2965517…
const MEAN  = (0.32 + 0.28) / 2;                          // 0.30

// ══════════════════════════════════════════════════════════════════════════
section('A — money ÷ weight, and it is NOT the mean of the rates');
// ══════════════════════════════════════════════════════════════════════════
{
    const b = claimPrice.blendFor({ items: [AL, CAST] }, 'TEMU9');
    ck('a rate comes back', b.price !== null && b.unit === 'LB');
    ck('it is total money over total weight', Math.abs(b.price - EXACT) < 1e-4, { got: b.price, want: EXACT });
    ck('which is $0.2966, not the $0.30 a simple mean gives', b.price === 0.2966 && b.price !== MEAN, b.price);

    // The gap is the whole reason the choice matters. On her own figures it is
    // small; the next check shows it is not always.
    ck('on a lopsided container the two answers are far apart', (() => {
        const tiny = { description: 'Rads', weight: 200, price: 1.80, price_unit: 'lb', amount: 360 };
        const bulk = { description: 'Cast', weight: 40000, price: 0.28, price_unit: 'lb', amount: 11200 };
        const bl = claimPrice.blendFor({ items: [tiny, bulk] }, 'T');
        const mean = (1.80 + 0.28) / 2;                   // 1.04 — nearly 4x
        // 11,560 / 40,200 = 0.28756…
        return Math.abs(bl.price - 0.2876) < 1e-3 && mean > bl.price * 3;
    })());

    // Four decimals, not two. A rate is multiplied by tens of thousands of lb.
    ck('the rate keeps four decimals', String(claimPrice.blendFor({ items: [AL, CAST] }, 'T').price).split('.')[1].length === 4);

    const bl = claimPrice.blendFor({ items: [AL, CAST] }, 'TEMU9');
    ck('the working is carried, so the note can show it',
        bl.blend && bl.blend.materials.length === 2 && bl.blend.total_weight === 29000 && bl.blend.total_amount === 8600, bl.blend);
    ck('and it says it is an average, in her words', /averaged across all 2 materials loaded, by weight/.test(bl.why), bl.why);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — it refuses rather than blending something half-entered');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('one material is not an average', /only one material/.test(claimPrice.blendFor({ items: [AL] }, 'T').why));
    ck('  and it offers no rate', claimPrice.blendFor({ items: [AL] }, 'T').price === null);

    // The dangerous one: blending the complete lines and ignoring the rest
    // gives a confident rate for a container nobody finished entering, and
    // nothing downstream would ever show that it was short.
    const half = claimPrice.blendFor({ items: [AL, { description: 'Rads', weight: null, price: 1.8, amount: null }] }, 'TEMU9');
    ck('a material with no weight stops the whole blend', half.price === null, half.price);
    ck('  and the refusal NAMES the line to fix', /Rads/.test(half.why), half.why);
    ck('  it does not quietly price off the complete lines', !/0\.32/.test(String(half.price)));

    ck('no weight at all is refused, not divided by zero',
        claimPrice.blendFor({ items: [{ description: 'a', weight: 0, price: 1, amount: 0 }, { description: 'b', weight: 0, price: 2, amount: 0 }] }, 'T').price === null);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — NOTHING CHANGED for a claim that does not ask for it');
// ══════════════════════════════════════════════════════════════════════════
// The rule-1 guard. Blending is opt-in: a mixed container whose claim names a
// grade must price off that grade exactly as it did yesterday. If this ever
// goes red, every existing claim on a multi-item container has been re-rated.
{
    await bills.addBill({
        container_no: 'TEMU9', supplier: 'Mazareigos', date: '2026-10-01',
        items: [AL, CAST],
    }, 'test');

    const named = { container_no: 'TEMU9', supplier: 'Mazareigos', claim_type: 'weight shortage', note: 'Al combo was short' };
    const got = claimPrice.priceFor(named);
    ck('a claim naming a grade still prices off that grade', got.price === 0.32, { price: got.price, why: got.why });
    ck('  and carries no blend', !got.blend);

    const vague = { container_no: 'TEMU9', supplier: 'Mazareigos', claim_type: 'weight shortage' };
    const v = claimPrice.priceFor(vague);
    ck('a claim naming no grade still REFUSES rather than blending silently', v.price === null, v.price);
    ck('  and the refusal now offers the container option as a third way out',
        /mark it weighed on the whole container/.test(v.why), v.why);

    const single = { container_no: 'TEMU9', supplier: 'Mazareigos', price_basis: '' };
    ck('an empty price_basis is the old behaviour, not the new one', claimPrice.priceFor(single).blend === null);

    // Opt in, and only then does it change.
    const blended = claimPrice.priceFor({ ...vague, price_basis: 'container_blend' });
    ck('with the flag set it blends', Math.abs(blended.price - EXACT) < 1e-4, blended.price);
    ck('  and says where the rate came from', /what the whole of TEMU9 cost/.test(blended.source), blended.source);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — trucking is never folded into a material rate');
// ══════════════════════════════════════════════════════════════════════════
// bills.js computes `amount` as `stated ?? computed`. If she has typed the
// supplier's invoice total and that total carries freight, blending off it
// would quietly overstate the claim against him. The blend reads the material
// lines and only the material lines.
{
    await bills.addBill({
        container_no: 'TEMU8', supplier: 'Mazareigos', date: '2026-10-02',
        items: [AL, CAST],
        stated_amount: 12000,          // 8,600 of material + 3,400 of freight
        trucking_amount: 3400,
    }, 'test');
    const b = claimPrice.priceFor({ container_no: 'TEMU8', supplier: 'Mazareigos', price_basis: 'container_blend' });
    ck('the blend ignores the stated invoice total', Math.abs(b.price - EXACT) < 1e-4, b.price);
    ck('  it is NOT 12,000 / 29,000 = $0.4138', Math.abs(b.price - (12000 / 29000)) > 0.1, b.price);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — end to end: the flag survives the route whitelist');
// ══════════════════════════════════════════════════════════════════════════
// CLAUDE.md rule 3's exact shape — a field missing from the route's `pick`
// list is dropped in silence and the screen shows no error.
{
    const { createApi } = require(R('api.js'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, raw, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    try {
        const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
        ck('signed in', !!sid);

        const made = await req('POST', '/api/claims', { sid, body: {
            supplier: 'Mazareigos', container_no: 'TEMU9', claim_type: 'weight shortage', created_by: 'manual' } });
        ck('a claim is created through the route', made.status === 200 && made.json && made.json.id, made.raw.slice(0, 160));
        const id = made.json.id;

        const ed = await req('POST', `/api/claims/${id}/edit`, { sid, body: { price_basis: 'container_blend' } });
        ck('price_basis saves through /edit', ed.status === 200 && ed.json.price_basis === 'container_blend',
            { status: ed.status, got: ed.json && ed.json.price_basis });

        // The supporting-document link rides the same whitelist, and a field
        // missing from it is dropped in silence — she pastes the link, the
        // screen says saved, and the note prints nothing. Added here because
        // the mutation that removes 'docs_url' from that list SURVIVED until
        // this existed: the field was whitelisted and never exercised.
        const dl = await req('POST', `/api/claims/${id}/edit`, { sid, body: {
            docs_url: 'https://drive.google.com/drive/folders/1AbC' } });
        ck('docs_url saves through /edit', dl.status === 200 && dl.json.docs_url === 'https://drive.google.com/drive/folders/1AbC',
            { status: dl.status, got: dl.json && dl.json.docs_url });

        // Cleaned on the way IN now, not only at render. Before this, a
        // paste that was not a web link saved happily, showed back in the
        // box as if kept, and then silently never appeared on a note.
        const junk = await req('POST', `/api/claims/${id}/edit`, { sid, body: { docs_url: 'javascript:alert(1)' } });
        ck('a non-web link is refused AT SAVE, not silently dropped later',
            junk.status === 200 && junk.json.docs_url === '', junk.json && junk.json.docs_url);
        const bare = await req('POST', `/api/claims/${id}/edit`, { sid, body: { docs_url: 'drive.google.com/drive/folders/1AbC' } });
        ck('  and a scheme-less paste comes back with https:// on it',
            bare.json.docs_url === 'https://drive.google.com/drive/folders/1AbC', bare.json.docs_url);
        await req('POST', `/api/claims/${id}/edit`, { sid, body: { docs_url: 'https://drive.google.com/drive/folders/1AbC' } });

        const read = await req('GET', `/api/claims`, { sid });
        const row = ((read.json || {}).claims || []).find((c) => c.id === id);
        ck('  and it is still there when the claim is read back', row && row.price_basis === 'container_blend', row && row.price_basis);

        // The route is /price, not /recoverable — I guessed the name writing
        // this and it 404'd, which is the cheap version of the same mistake
        // the screen would make.
        const rec = await req('GET', `/api/claims/${id}/price`, { sid });
        ck('the rate route returns the blended rate, not a refusal',
            rec.status === 200 && rec.json && Math.abs((rec.json.price || 0) - EXACT) < 1e-4,
            { status: rec.status, body: rec.raw.slice(0, 200) });
        ck('  and hands the screen the working to draw', !!(rec.json && rec.json.blend && rec.json.blend.materials.length === 2));

        // The money itself, once the weights are confirmed: 1,000 lb short on
        // a container that cost $0.2966/lb is $296.60 — not the $300.00 a
        // simple mean of the rates would have asked Mazareigos for.
        const ver = await req('POST', `/api/claims/${id}/verify`, { sid, body: {
            invoice_weight: 42000, claimed_weight: 41000, weight_unit: 'LB' } });
        ck('the claim verifies on the container weight slip', ver.status === 200, ver.raw.slice(0, 180));
        const priced = await req('GET', `/api/claims/${id}/price`, { sid });
        ck('1,000 lb short comes to $296.60, not $300.00',
            priced.json && Math.abs(priced.json.amount - 296.60) < 0.02 && priced.json.amount !== 300,
            priced.json && priced.json.amount);
    } finally {
        server.close();
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('  FAILED:'); failures.forEach((f) => console.log('   · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('THREW', e && e.stack || e); process.exit(1); });
