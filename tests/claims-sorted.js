// ── tests/claims-sorted.js ────────────────────────────────────────────────
// Apsara, 2026-10-20: "we buy al wheel dirty.there would be claim on that
// like clad wheel,chrome wheel,truck wheel".
//
// A dirty grade, sorted, and what comes out is several named contaminants —
// each with its own weight and its own real value. The 'contamination'
// assessment could not say that: one accepted percentage and one rate, so
// three named types collapse into a figure she cannot defend line by line to
// the supplier who sold it to her.
//
// ── THE ARITHMETIC IS HERS, AND IT WAS NEARLY WRONG ──────────────────────
// Asked how the money works she answered "both 1,2". That had three readings
// which, on the SAME material, differed by more than a thousand dollars:
// $2,320 (the difference), $3,400 (full weight at the price paid) and $1,760
// (each type at its own rate). She was shown the three in dollars and chose
// the difference. Her example is section A, to the cent, and it is the reason
// this file leads with it: the test that matters most here is not that the
// code runs but that it computes HER number.
//
//   A  her worked example, to the cent
//   B  one line at a time: the rules, and what is refused
//   C  units — a per-LB rate is not a per-MT rate
//   D  nothing that already existed assesses differently
//   E  END TO END through the route the page posts to (CLAUDE.md rule 3)
//   F  the branch that used to be a catch-all

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra !== undefined) console.log('        ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const throwsWith = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sorted-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }
const claims = require(path.join(ROOT, 'helpers/claims'));

// Her purchase: 40,000 lb of Al wheel dirty from Ace Metals at $0.85/lb.
const mk = (over = {}) => claims.create(Object.assign({
    invoice_no: 'INV-' + Math.random().toString(36).slice(2, 8),
    container_no: 'MSNU' + Math.floor(Math.random() * 1e6),
    supplier: 'Ace Metals', customer: 'Taewon',
    supplier_price: 0.85, supplier_price_unit: 'LB',
    weight_unit: 'LB', invoice_weight: 40000,
}, over));

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — her worked example, to the cent');
{
    const c = await mk();
    const r = await claims.assess(c.id, { assessment: 'sorted', weight_unit: 'LB', sorted_lines: [
        { type: 'Clad wheel', weight: 2000, worth: 0.30 },
        { type: 'Chrome wheel', weight: 1200, worth: 0.40 },
        { type: 'Truck wheel', weight: 800 },
    ] }, 'test');

    const line = (t) => (r.sorted_lines || []).find((l) => l.type === t) || {};
    ck('clad wheel: 2,000 x (0.85 - 0.30) = $1,100', line('Clad wheel').amount === 1100, line('Clad wheel').amount);
    ck('chrome wheel: 1,200 x (0.85 - 0.40) = $540', line('Chrome wheel').amount === 540, line('Chrome wheel').amount);
    ck('truck wheel: no rate, so claimed in full, 800 x 0.85 = $680',
       line('Truck wheel').amount === 680, line('Truck wheel').amount);
    ck('THE CLAIM IS $2,320', r.claim_amount === 2320, r.claim_amount);

    ck('the basis recorded is what Edge PAID, not what it sold for',
       r.paid_price === 0.85 && r.paid_price_unit === 'LB', `${r.paid_price} / ${r.paid_price_unit}`);
    ck('the sorted weight is carried', r.sorted_weight === 4000, r.sorted_weight);
    ck('a line with no rate keeps worth null, not 0',
       line('Truck wheel').worth === null, line('Truck wheel').worth);
    ck('  so the page can say "claimed in full" rather than show a rate she never typed',
       line('Truck wheel').worth_unit === null, line('Truck wheel').worth_unit);
    ck('it is recorded as a sorted assessment', r.assessment === 'sorted', r.assessment);
    ck('confirming the figure verifies the claim', r.status === 'verified', r.status);

    // our_claim belongs to raiseRecovery. If assess set it, routes.js would
    // stop raising the recovery to-do — `if (!rec.our_claim)` — and the claim
    // would quietly fall out of her list.
    ck('our_claim is left alone, so the recovery to-do still fires',
       r.our_claim === null || r.our_claim === undefined, r.our_claim);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — one line at a time');
{
    const c = await mk();
    const bad = (lines, re) => throwsWith(() => claims.assess(c.id,
        { assessment: 'sorted', weight_unit: 'LB', sorted_lines: lines }, 'test'), re);

    ck('no lines at all is refused',
       await throwsWith(() => claims.assess(c.id, { assessment: 'sorted', weight_unit: 'LB', sorted_lines: [] }), /at least one line/));
    ck('a line with no name is refused', await bad([{ weight: 100, worth: 0.1 }], /needs a name/));
    ck('a line with no weight is refused', await bad([{ type: 'Clad wheel' }], /needs the weight/));
    ck('a zero weight is refused', await bad([{ type: 'Clad wheel', weight: 0 }], /needs the weight/));
    ck('a negative worth is refused', await bad([{ type: 'Clad wheel', weight: 10, worth: -1 }], /less than nothing/));

    // Mirrors "that is not a downgrade" on the grade branch. Without it a
    // contaminant priced above the grade would make a NEGATIVE line and
    // quietly reduce the total she claims.
    ck('a contaminant priced ABOVE what she paid is refused',
       await bad([{ type: 'Gold wheel', weight: 10, worth: 2.00 }], /not a loss/));

    ck('more sorted out than was invoiced is refused',
       await throwsWith(() => claims.assess(c.id, { assessment: 'sorted', weight_unit: 'LB',
           invoice_weight: 1000, sorted_lines: [{ type: 'Clad wheel', weight: 1500 }] }), /more than the 1000/));

    // The price is the whole basis. Without it there is no claim to compute,
    // and defaulting it to the sale price would value a purchase claim at
    // her own margin.
    const noPrice = await mk({ supplier_price: null, supplier_price_unit: null });
    ck('no purchase price, no figure — and it says where to find one',
       await throwsWith(() => claims.assess(noPrice.id, { assessment: 'sorted', weight_unit: 'LB',
           sorted_lines: [{ type: 'Clad wheel', weight: 10 }] }), /price Edge paid this supplier/));

    const cap = Array.from({ length: 41 }, (_, i) => ({ type: 'T' + i, weight: 1 }));
    ck('forty lines is the cap', await bad(cap, /capped at 40/));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — a per-LB rate is not a per-MT rate');
{
    // helpers/claims.js's own warning, about its author's tab: "A parser that
    // guesses MT is wrong by a factor of 1000, and that number would land in
    // the figure she shows her uncle and her customers." So the factor is
    // pinned here, in both directions, rather than trusted.
    const LB_PER_MT = 2204.62262;

    // ── A THROW HERE MUST BE A RED, NOT A CRASH ──────────────────────────
    // Dropping the rate conversion makes a per-MT worth compare against a
    // per-LB price, which trips the "not a loss" guard and THROWS. Called
    // bare, that aborted the whole file and the mutation harness scored it
    // CRASHED — technically killed, but a crash hides which check noticed
    // and buries every section after it. CLAUDE.md's first failure shape is
    // exactly this: a file that exits badly instead of saying what is wrong.
    const tryAssess = async (id, patch) => {
        try { return await claims.assess(id, patch, 'test'); }
        catch (e) { return { claim_amount: null, sorted_lines: [{}], _threw: e.message }; }
    };

    // Weights in LB, price in MT. 1 MT of clad out of a $1,874/MT purchase.
    const c = await mk({ supplier_price: 1874, supplier_price_unit: 'MT' });
    const r = await tryAssess(c.id, { assessment: 'sorted', weight_unit: 'LB',
        sorted_lines: [{ type: 'Clad wheel', weight: LB_PER_MT }] });
    ck('one metric tonne of LB, claimed in full at the MT price = $1,874',
       Math.abs(r.claim_amount - 1874) < 0.02, r.claim_amount);

    // A worth quoted per LB against a purchase priced per MT. $0.30/lb is
    // $661.39/MT, so the loss is 1874 - 661.39 = $1,212.61 on one tonne.
    const c2 = await mk({ supplier_price: 1874, supplier_price_unit: 'MT' });
    const r2 = await tryAssess(c2.id, { assessment: 'sorted', weight_unit: 'LB',
        sorted_lines: [{ type: 'Clad wheel', weight: LB_PER_MT, worth: 0.30, worth_unit: 'LB' }] });
    const expect = Math.round((1874 - 0.30 * LB_PER_MT) * 100) / 100;
    ck(`a per-LB worth is converted to the per-MT basis ($${expect})`,
       Math.abs(r2.claim_amount - expect) < 0.02, `${r2.claim_amount} vs ${expect}`);
    ck('  and it is NOT the un-converted 1874 - 0.30',
       Math.abs(r2.claim_amount - (1874 - 0.30)) > 1, r2.claim_amount);
    ck('  the typed rate is stored as she typed it, with its unit',
       r2.sorted_lines[0].worth === 0.30 && r2.sorted_lines[0].worth_unit === 'LB',
       JSON.stringify(r2.sorted_lines[0]));

    // And the other direction: an MT worth against a per-LB purchase.
    const c3 = await mk({ supplier_price: 0.85, supplier_price_unit: 'LB' });
    const r3 = await tryAssess(c3.id, { assessment: 'sorted', weight_unit: 'LB',
        sorted_lines: [{ type: 'Clad wheel', weight: 1000, worth: 661.3868, worth_unit: 'MT' }] });
    // 661.3868/MT is 0.30/lb, so 1,000 lb x (0.85 - 0.30) = $550.
    ck('a per-MT worth is converted to the per-LB basis ($550)',
       Math.abs(r3.claim_amount - 550) < 0.5, r3._threw || r3.claim_amount);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — nothing that already existed assesses differently');
{
    // The whole point of adding a MEMBER to a closed set rather than changing
    // one. These three figures come from tests/claims-assess.js and must not
    // move: an existing claim keeps its assessment and its arithmetic.
    const c1 = await mk({ weight_unit: 'MT' });
    const con = await claims.assess(c1.id, { assessment: 'contamination', weight_unit: 'MT',
        invoice_weight: 21.4, contam_claimed_pct: 4, contam_accepted_pct: 3.5,
        sell_price: 2000, sell_price_unit: 'MT' }, 'test');
    ck('contamination: 21.4 x 3.5% x $2,000 = $1,498', con.claim_amount === 1498, con.claim_amount);
    ck('  and it did not acquire sorted lines',
       Array.isArray(con.sorted_lines) && con.sorted_lines.length === 0, JSON.stringify(con.sorted_lines));

    const c2 = await mk({ weight_unit: 'MT' });
    const g = await claims.assess(c2.id, { assessment: 'grade', weight_unit: 'MT',
        grade_sold: 'Zorba', grade_received: 'Zebra', grade_weight: 8.2,
        grade_price_sold: 2140, grade_price_received: 1850 }, 'test');
    ck('downgrade: 8.2 x (2140 - 1850) = $2,378', g.claim_amount === 2378, g.claim_amount);
    ck('  still recorded as a grade assessment, not swallowed by the new branch',
       g.assessment === 'grade', g.assessment);

    const c3 = await mk({ weight_unit: 'MT' });
    const q = await claims.assess(c3.id, { assessment: 'quality', weight_unit: 'MT',
        quality_qty: 1.005, sell_price: 2318, sell_price_unit: 'MT' }, 'test');
    ck('quality: 1.005 x $2,318 = $2,329.59', q.claim_amount === 2329.59, q.claim_amount);

    ck('an unknown assessment is still refused, and now names sorted',
       await throwsWith(() => claims.assess(c3.id, { assessment: 'vibes', weight_unit: 'MT' }),
           /contamination, grade, quality or sorted/));
    ck('a weight shortage still goes through verify',
       await throwsWith(() => claims.assess(c3.id, { assessment: 'weight', weight_unit: 'MT' }), /through verify/));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — END TO END, through the route the page posts to');
{
    // CLAUDE.md rule 3. The engine above would pass with the route dropping
    // every new field on the floor — helpers/claims/routes.js filters the body
    // through a `pick` whitelist, and a field missing from it saves a claim
    // with no breakdown and no error. That is the paidVia/paid_via failure,
    // and it is the only reason this section exists.
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const req = (method, p2, opts) => new Promise((resolve, reject) => {
        const { body, sid } = (opts || {});
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = 'Bearer ' + sid;
        const r2 = http.request(base + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (ch) => { raw += ch; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    try {
        const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
        ck('signed in', !!sid);

        const c = await mk();
        const res = await req('POST', `/api/claims/${c.id}/assess`, { sid, body: {
            assessment: 'sorted', weight_unit: 'LB',
            sorted_lines: [
                { type: 'Clad wheel', weight: 2000, worth: 0.30 },
                { type: 'Chrome wheel', weight: 1200, worth: 0.40 },
                { type: 'Truck wheel', weight: 800 },
            ],
            by: 'apsara',
        } });
        ck('the route accepts a sorted assessment', res.status === 200,
           `${res.status} ${JSON.stringify(res.json)}`);

        // THE WHITELIST. If sorted_lines were missing from `pick`, the route
        // would 400 on "needs at least one line" — which is the good failure.
        // The bad one would be a 200 with an empty breakdown, so both the
        // total AND the rows are checked here.
        ck('  the breakdown survived the route whitelist',
           ((res.json || {}).sorted_lines || []).length === 3,
           JSON.stringify((res.json || {}).sorted_lines));
        ck('  and the figure is her $2,320', (res.json || {}).claim_amount === 2320,
           (res.json || {}).claim_amount);

        // Read back through the route the page reads, not the store.
        const back = await req('GET', '/api/claims', { sid });
        const mine = ((back.json || {}).claims || []).find((x) => x.id === c.id);
        ck('it reads back through the list route', !!mine);
        ck('  with the lines intact', mine && (mine.sorted_lines || []).length === 3,
           JSON.stringify(mine && mine.sorted_lines));
        ck('  and the per-line amounts, so she is not re-adding them by hand',
           mine && mine.sorted_lines.every((l) => typeof l.amount === 'number'),
           JSON.stringify(mine && mine.sorted_lines));

        const refused = await req('POST', `/api/claims/${c.id}/assess`, { sid, body: {
            assessment: 'sorted', weight_unit: 'LB',
            sorted_lines: [{ type: 'Gold wheel', weight: 10, worth: 2.0 }],
        } });
        ck('a refusal comes back as 400 with the reason', refused.status === 400
           && /not a loss/.test(String((refused.json || {}).error || '')),
           `${refused.status} ${JSON.stringify(refused.json)}`);
    } finally {
        await new Promise((r) => server.close(r));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the branch that used to be a catch-all');
{
    // assess() ended with a bare `else` that handled grade. Adding 'sorted' to
    // ASSESSMENTS without a branch would have landed there and demanded grade
    // prices for a claim that has none — a new assessment silently becoming a
    // downgrade. The else is now explicit and the fall-through throws.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/claims.js'), 'utf8');
    ck('grade is matched by name, not by being last',
       /else if \(kind === 'grade'\)/.test(src));
    ck('and an assessment with no branch fails loudly',
       /in ASSESSMENTS but helpers\/claims\.js has no branch for it/.test(src));
    ck('sorted is in the closed set', claims.ASSESSMENTS
        ? claims.ASSESSMENTS.includes('sorted')
        : /'quality', 'sorted'\]/.test(src));

    // The contaminant NAMES are free text, deliberately. FINDINGS is a
    // hardcoded list and Apsara's rule on 2026-09-26 was "let ai decide
    // dynamically" — so clad/chrome/truck wheel are not three new constants.
    ck('clad/chrome/truck wheel were NOT hardcoded into FINDINGS',
       !/clad|chrome|truck/i.test((src.match(/const FINDINGS = \[[^\]]*\]/) || [''])[0]),
       (src.match(/const FINDINGS = \[[^\]]*\]/) || [''])[0]);
}

// ══════════════════════════════════════════════════════════════════════════
section('G2 — the party pickers: suppliers and customers she has traded with');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-10-21: "you have list of suppliers and customers.show that as
// drop down in claims.then match as i type".
//
// Not only convenience. helpers/claimPrice.js finds the price Edge paid by
// matching the supplier on the CLAIM against the supplier on the BILL, so a
// name typed differently from the bill means no price found — and a sorted
// claim with no price cannot be assessed at all. Offering the bill's own
// spellings is what keeps that join working, which is why this is tested
// against the ROUTE's output rather than against the page's markup.
{
    const http2 = require('http');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app2 = createApi();
    const srv = await new Promise((r) => { const x = app2.listen(0, '127.0.0.1', () => r(x)); });
    const base2 = 'http://127.0.0.1:' + srv.address().port;
    const get = (p2, sid) => new Promise((resolve, reject) => {
        const r2 = http2.request(base2 + p2, { method: 'GET', headers: sid ? { Authorization: 'Bearer ' + sid } : {} }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); r2.end();
    });
    const post = (p2, body, sid) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const r2 = http2.request(base2 + p2, { method: 'POST', headers: Object.assign(
            { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            sid ? { Authorization: 'Bearer ' + sid } : {}) }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); r2.write(data); r2.end();
    });

    try {
        const sid = ((await post('/login', { password: process.env.ADMIN_PASSWORD })).json || {}).sid;

        // A supplier known only from a BILL — never typed on a claim. This is
        // the one that matters: it is the spelling claimPrice will match.
        const bills = require(path.join(ROOT, 'helpers/bills'));
        await bills.addBill({ supplier: 'Perez Alloys', container_no: 'TEST0001',
            date: '2026-10-01', items: [{ description: 'Al wheel dirty', weight: 1000, price: 0.8 }] })
            .catch(() => {});

        const r = await get('/api/claims', sid);
        ck('the claims route answers', r.status === 200, String(r.status));
        const parties = (r.json || {}).parties;
        ck('it carries a party list', !!parties && Array.isArray(parties.suppliers) && Array.isArray(parties.customers),
           JSON.stringify(parties));

        ck('a supplier known only from a bill is offered',
           (parties.suppliers || []).includes('Perez Alloys'),
           'claimPrice matches the claim\'s supplier against the BILL\'s — if the '
           + 'picker does not offer the bill spelling, she types one that finds no price');

        // Anyone already named on a claim is offered too, bill or no bill.
        ck('a supplier used on a claim is offered',
           (parties.suppliers || []).includes('Ace Metals'), (parties.suppliers || []).join(', '));

        // Deduped and sorted, her spelling kept.
        const lower = (parties.suppliers || []).map((x) => x.toLowerCase());
        ck('  no duplicates', new Set(lower).size === lower.length, lower.join(', '));
        ck('  sorted', lower.join('|') === [...lower].sort().join('|'), lower.join(', '));
        ck('  and nothing blank crept in', (parties.suppliers || []).every((x) => x && x.trim()),
           JSON.stringify(parties.suppliers));

        // ── THE PAGE MUST ACTUALLY ATTACH THEM ──────────────────────────
        // A populated <datalist> with no input pointing at it never opens.
        // dashboard/edge-inventory.html has had exactly that since it was
        // written: #suplist is filled on every load and no input references
        // it, so that dropdown has never worked. Asserted here so this one
        // cannot ship the same way.
        const HTML2 = fs.readFileSync(path.join(ROOT, 'dashboard/claims.html'), 'utf8');
        // ── CO-LOCATION IN A FILE IS NOT CO-LOCATION IN A DOCUMENT ──────
        // The first version of this checked that `<datalist id="n_custList">`
        // and `list="n_custList"` both appeared in claims.html. Both did —
        // in two functions that are NEVER rendered at the same time. The
        // datalists were emitted inside openNew()'s modal; the Claim details
        // section on each card referenced them by id. On the card they
        // pointed at nothing, and Apsara reported "claim edit not working".
        //
        // That is the identical fault this file mocks edge-inventory.html
        // for, committed within the hour of writing the mockery. So the
        // property asserted is now the one that matters: the lists are built
        // ONCE, on the body, where every reference can reach them.
        ck('the datalists are created on the body, not inside a card or modal',
           /document\.body\.appendChild\(dl\)/.test(HTML2),
           'emitted inside a per-item function they are either duplicated or unreachable');
        ck('  and are rebuilt whenever the lists change', /ensureDatalists\(\);/.test(HTML2));
        for (const id of ['n_custList', 'n_supList', 's_matList']) {
            ck(`  ${id} is referenced by an input`, HTML2.includes(`list="${id}"`),
               'a datalist nothing references is a dropdown that never opens');
            ck(`    and is NOT hand-written into any template`,
               !HTML2.includes(`<datalist id="${id}">`),
               'a literal datalist tag in a card or modal is the bug that was just fixed');
        }
        ck('  every id ensureDatalists builds is one an input uses',
           ['n_custList', 'n_supList', 's_matList'].every((id) => HTML2.includes("['" + id + "'")
               || HTML2.includes('[\'' + id + '\'')),
           'a list built and never referenced is dead weight on every page load');
        ck('the page reads the list the route sends', /STATE\.parties = j\.parties/.test(HTML2));

        // ── "how do i know material are this" ───────────────────────────
        // Two answers, both of which already existed in Jarvis and neither
        // of which this pane was using.
        //
        // 1. WHICH material: her own item types, the same list the load and
        //    inventory forms offer. Her real list holds "Al rims(Dirty)" and
        //    "Chrome", so these are her words, not invented ones.
        const mats = (r.json || {}).materials;
        ck('the route sends her item types', Array.isArray(mats) && mats.length > 0,
           JSON.stringify(mats));
        ck('  the Material box offers them', /list="s_matList"/.test(HTML2));
        // Re-pointed with the fix: the list is no longer a <datalist> tag
        // beside the input, it is built by ensureDatalists from STATE.
        ck('  and the datalist is built from them',
           /\['s_matList', STATE\.materials \|\| \[\]\]/.test(HTML2),
           'the material list must come from the route, not be hand-written');
        ck('  free text still works — a contaminant she has never bought',
           !/required/.test((HTML2.match(/class="s_type"[^>]*/) || [''])[0]),
           'a closed list would refuse a material she has not traded before');

        // 2. HOW she knows: the evidence. MEASURED/STRENGTH were on the
        //    contamination pane only; a sorted claim is ENTIRELY a claim
        //    about what the material turned out to be, so it needed them
        //    more than contamination did.
        const sortedPane = HTML2.slice(HTML2.indexOf('data-pane="sorted"'),
                                       HTML2.indexOf('data-kind="sorted"'));
        ck('the sorted pane asks how she knows', /How do you know it is this material/.test(sortedPane));
        ck('  with the same four methods, not a new list', /MEASURED\.map/.test(sortedPane));
        ck('  and shows what that evidence is worth in an argument',
           /class="hint s_ev"/.test(sortedPane) && /STRENGTH\[pk\.measured_by\]/.test(HTML2));
        // SCOPED TO THE SORTED BRANCH. The first version searched the whole
        // file, and `measured_by: pk.measured_by` also appears in the
        // CONTAMINATION branch — so gutting the sorted one still matched and
        // the mutation SURVIVED. A check that can be satisfied by a different
        // branch is not testing this branch.
        const sortedSubmit = HTML2.slice(
            HTML2.indexOf("else if (btn.dataset.kind === 'sorted')"),
            HTML2.indexOf('else Object.assign(body, {'));
        ck('  the sorted branch exists to scope this check',
           sortedSubmit.length > 40 && sortedSubmit.includes('sorted_lines'),
           'could not isolate the sorted submit branch — the checks below prove nothing');
        ck('  the answer is SENT with the assessment', /measured_by: pk\.measured_by,/.test(sortedSubmit),
           'the field exists on the record; without this the pane collects it and drops it');
        ck('  along with the price and the lines',
           /paid_price: numOf/.test(sortedSubmit) && /sorted_lines: readSortedLines/.test(sortedSubmit));

        // Two chip rows now mirror ONE value. Clicking in one must light the
        // other, or the row she is not looking at shows a different answer
        // from the one being saved.
        ck('the two chip rows stay in sync', /x\.dataset\.m === b\.dataset\.m/.test(HTML2),
           'comparing x === b lights only the row she clicked');
        ck('  and survives a server that does not send one',
           /j\.parties \|\| \{ suppliers: \[\], customers: \[\] \}/.test(HTML2),
           'an older server would otherwise throw on page load');
    } finally {
        await new Promise((r) => srv.close(r));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('G3 — the details can be corrected after the fact');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-10-21: "Add a option to change teh details later like
// supplier,customer,container number etc.."
//
// POST /api/claims/:id/edit has ALWAYS allowed customer, supplier,
// invoice_no, container_no and claim_date. The page offered a control for
// exactly one of them — supplier, buried in Recover. Route permitted, screen
// silent, which is #152's shape: the permission existed and could not be used.
{
    const http3 = require('http');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app3 = createApi();
    const srv3 = await new Promise((r) => { const x = app3.listen(0, '127.0.0.1', () => r(x)); });
    const b3 = 'http://127.0.0.1:' + srv3.address().port;
    const call = (method, p2, body, sid) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = 'Bearer ' + sid;
        const r2 = http3.request(b3 + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c2) => { raw += c2; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    try {
        const sid = ((await call('POST', '/login', { password: process.env.ADMIN_PASSWORD })).json || {}).sid;
        const c = await mk({ container_no: 'WRONG0001', customer: '', supplier: '' });
        const keyBefore = claims.get(c.id).key;

        const res = await call('POST', `/api/claims/${c.id}/edit`, {
            customer: 'Taewon', supplier: 'Ace Metals',
            container_no: 'MSNU2238929', invoice_no: '26JY52',
        }, sid);
        ck('the edit route accepts all four', res.status === 200, `${res.status} ${JSON.stringify(res.json)}`);

        const after = claims.get(c.id);
        ck('  customer saved', after.customer === 'Taewon', after.customer);
        ck('  supplier saved', after.supplier === 'Ace Metals', after.supplier);
        ck('  container saved', after.container_no === 'MSNU2238929', after.container_no);
        ck('  invoice saved', after.invoice_no === '26JY52', after.invoice_no);

        // THE ONE THAT COULD HAVE BITTEN. The claim's `key` is built from
        // invoice+container and is what groups it on the page. If update()
        // did not recompute it, a renamed container would keep grouping
        // under the OLD number — the claim would look moved and not be.
        // Case-insensitive: keyOf runs the parts through norm(), which does
        // NOT lower-case them. The first version of this check looked for a
        // lower-case key and failed on correct code — the re-key had worked
        // all along (INVERWLYV|WRONG0001 -> 26JY52|MSNU2238929).
        ck('  and the claim RE-KEYS to the new container',
           after.key !== keyBefore && after.key.toLowerCase().includes('msnu2238929'),
           `${keyBefore} -> ${after.key}`);
        ck('    the old container is gone from the key',
           !after.key.toLowerCase().includes('wrong0001'), after.key);

        // ── THE SCREEN HAS THE CONTROL ──────────────────────────────────
        const HTML3 = fs.readFileSync(path.join(ROOT, 'dashboard/claims.html'), 'utf8');
        ck('there is a Claim details section', /data-sec="details"/.test(HTML3));
        for (const [cls, what] of [['d_cust', 'customer'], ['d_sup', 'supplier'],
                                   ['d_inv', 'invoice no'], ['d_cont', 'container no'],
                                   ['d_date', 'claim date']]) {
            ck(`  a box for the ${what}`, HTML3.includes(cls), `.${cls} missing`);
        }
        ck('  with a Save that posts to the edit route',
           /d_save/.test(HTML3) && /\/edit', patch\)/.test(HTML3));

        // Only what changed is sent: a blanket rewrite would silently
        // overwrite fields she never touched.
        ck('  and it sends ONLY the changed fields',
           /if \(want\[k\] !== String\(c\[k\] == null \? '' : c\[k\]\)\) patch\[k\] = want\[k\]/.test(HTML3),
           'sending the whole form rewrites fields she did not edit');
        ck('  refuses to blank both identifiers',
           /Keep at least a container number or an invoice number/.test(HTML3),
           'a claim with neither cannot be identified on the page or the note');
        ck('  and the two party boxes reuse the pickers',
           /class="d_cust" list="n_custList"/.test(HTML3) && /class="d_sup" list="n_supList"/.test(HTML3));
    } finally {
        await new Promise((r) => srv3.close(r));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('G — and the controls are on the page');
// ══════════════════════════════════════════════════════════════════════════
// scripts/check-route-reach.js will NOT catch a gap here: POST
// /api/claims/:id/assess already had a caller, so the route looks reached
// while the three new FIELDS have nowhere to be typed. That is the same shape
// as #152 (the route existed, the button did not) one level down — a field
// instead of a route.
{
    const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/claims.html'), 'utf8');

    ck('"Sorted by type" is offered as an assessment', /id:'sorted',\s*label:'Sorted by type'/.test(HTML));
    ck('there is a pane for it', /data-pane="sorted"/.test(HTML));
    for (const [cls, what] of [
        ['f_spaid', 'the price she paid'],
        ['f_spaidUnit', 'the unit that price is in'],
        ['s_type', 'what was found'],
        ['s_w', 'the weight of it'],
        ['s_worth', 'what it is actually worth'],
        ['s_wu', "the worth's unit"],
    ]) {
        ck(`  a box for ${what}`, HTML.includes(cls), `.${cls} missing`);
    }
    ck('rows can be added', /class="btn s_add"/.test(HTML));
    ck('  and removed', /class="btn s_del"/.test(HTML));
    ck('a Confirm button posts it as sorted', /data-kind="sorted"/.test(HTML));

    // THE SUBMIT BRANCH. The chain ended in a bare `else` meaning grade, so a
    // sorted claim would have posted grade_sold/grade_price_* and the server
    // would have refused it with a message about downgrades.
    ck('the submit branch for sorted is EXPLICIT, not the catch-all',
       /else if \(btn\.dataset\.kind === 'sorted'\)/.test(HTML),
       'without this, a sorted claim posts grade fields');
    ck('  and it sends all three new fields',
       /sorted_lines: readSortedLines\(el\)/.test(HTML)
       && /paid_price: numOf/.test(HTML) && /paid_price_unit:/.test(HTML));

    // An empty worth box must not become 0 on the way out: null means
    // "claimed in full" to the server, and 0 would mean it by accident.
    ck('an empty worth is omitted rather than sent as zero',
       /if \(worthRaw !== ''\) \{ line\.worth = numOf\(worthRaw\)/.test(HTML),
       'sending 0 would be the right number for the wrong reason');
    ck('blank rows are not posted as lines', /\.filter\(\(l\) => l\.type \|\| l\.weight != null\)/.test(HTML));

    // The preview is a convenience, not a second rulebook. It refuses to
    // guess across units and shows a dash instead — the server converts.
    ck('the live total does not re-implement unit conversion',
       /the server converts; this preview will not guess/.test(HTML));
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
