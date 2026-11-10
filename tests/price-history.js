// tests/price-history.js — price facts END TO END (CLAUDE.md rule 3): real sales and bills written the way the app writes them, read through
// the real helper and the real command, then handed to the real learner service as "price-check" cases. READ-ONLY and rule-free are properties under test.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, spawnSync } = require('child_process');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-price-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT config is not isolated'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    const ph = require(path.join(ROOT, 'helpers/priceHistory'));
    console.log('\n=== pure ===');
    ck('$/lb stays $/lb', ph.perLb(1.65, 'lb') === 1.65);
    ck('$/MT is converted to $/lb', Math.abs(ph.perLb(2200, 'mt') - 0.9979) < 0.001, String(ph.perLb(2200, 'mt')));
    ck('a missing unit uses the app\'s own rule: under $10 is per lb, $10+ is per MT', ph.perLb(0.32) === 0.32 && Math.abs(ph.perLb(1650) - 0.7484) < 0.001);
    ck('a zero, negative or blank price is not a price', ph.perLb(0, 'lb') === null && ph.perLb(-1, 'lb') === null && ph.perLb('', 'lb') === null && ph.perLb(null) === null);
    ck('both date shapes the app stores are read', ph.dayOf('09/10/2026') === '2026-09-10' && ph.dayOf('2026-09-10T12:00:00Z') === '2026-09-10' && ph.dayOf('garbage') === null);
    ck('her own companies are recognised, a customer is not', ['EDGEYARD', 'Edge Metals', 'edge yard', 'AAA Investment'].every(ph.isIntercompany) && !ph.isIntercompany('Edgewood Metals') && !ph.isIntercompany('Calderon'));

    console.log('\n=== real stores ===');
    const sales = require(path.join(ROOT, 'helpers/sales')), bills = require(path.join(ROOT, 'helpers/bills'));
    const sale = (customer, item, date, price, unit = 'lb') => sales.addSale({ customer, item, date, invoice_no: '', weight: 10000, invoice_price: price, price_unit: unit, weight_unit: 'lb' });
    for (const [d, p] of [['2026-08-01', 1.60], ['2026-08-10', 1.62], ['2026-08-20', 1.60], ['2026-09-01', 1.61], ['2026-09-10', 1.62]]) await sale('Eccomelt', 'AL WHEELS DIRTY', d, p);
    await sale('Eccomelt', 'AL WHEELS DIRTY', '2026-10-01', 2.10);                 // the odd one
    for (const [d, p] of [['2026-08-02', 1.50], ['2026-08-12', 1.52], ['2026-09-02', 1.51], ['2026-09-12', 1.50], ['2026-09-20', 1.51]]) await sale('Zimex', 'AL WHEELS DIRTY', d, p);
    await sale('Newco', 'AL WHEELS DIRTY', '2026-10-02', 1.58);                    // one price only
    await sale('Mtco', 'COPPER', '2026-10-03', 6600, 'mt');                        // $/MT
    for (const [d, p] of [['2026-09-21', 0.5], ['2026-09-22', 0.5], ['2026-09-23', 0.5], ['2026-09-24', 0.5]]) await sale('EDGEYARD', 'AL WHEELS DIRTY', d, p);   // transfer prices between her own companies
    for (const [d, p] of [['2026-09-01', 4.0], ['2026-09-08', 4.1], ['2026-09-15', 4.0], ['2026-09-22', 5.5]]) await sale('Fourco', 'TIN', d, p);                // 4 prices: only 3 earlier, so no "typical" yet
    const obs = ph.observations();
    ck('every dated price is an observation, in date order', obs.length === 21 && obs.every((o, i) => i === 0 || obs[i - 1].date <= o.date), String(obs.length));
    const ser = ph.series(obs);
    const ecc = ser.find((s) => s.party === 'Eccomelt');
    ck('Eccomelt: 6 prices, last 2.10, typical is the MEDIAN of the earlier ones, and the gap is a fact', ecc.n === 6 && ecc.last === 2.1 && ecc.typical === 1.61 && ecc.pct_off === 30.4, JSON.stringify({ n: ecc.n, last: ecc.last, typical: ecc.typical, off: ecc.pct_off }));
    ck('a party with too little history gets facts but NO claimed "typical"', (() => { const n = ser.find((s) => s.party === 'Newco'); return n.n === 1 && n.typical === null && n.pct_off === null && n.enough_history === false; })());
    ck('the $/MT invoice is on the same $/lb scale as the others', Math.abs(ser.find((s) => s.party === 'Mtco').last - 2.9937) < 0.001);
    ck('series are separate per party AND per item (Zimex is not mixed into Eccomelt)', ser.filter((s) => s.item === 'AL WHEELS DIRTY').length === 4 && ser.find((s) => s.party === 'Zimex').typical === 1.505);
    ck('ordered with the biggest gap first', ser[0].party === 'Eccomelt');

    const c = ph.caseFor(obs.find((o) => o.party === 'Eccomelt' && o.date === '2026-10-01'), obs);
    ck('the case for the learner is exact facts, nothing to calculate', c.price_per_lb === 2.1 && c.typical_for_this_party === 1.61 && c.pct_off_typical === 30.4 && c.times_seen_before === 5 && /2026-09-10 1.62/.test(c.last_three_for_this_party), JSON.stringify(c));
    ck('  the market figure is the OTHER outside parties (Zimex), and her own company\'s 0.50 transfer price is not in it', c.market_among_other_parties === 1.51, JSON.stringify(c.market_among_other_parties));
    ck('a series with only 3 earlier prices claims no typical, however odd the last one looks', ser.find((x) => x.party === 'Fourco').typical === null && ser.find((x) => x.party === 'Fourco').pct_off === null);
    ck('  the case never uses a price from AFTER its own date', ph.caseFor(obs.find((o) => o.party === 'Eccomelt' && o.date === '2026-08-20'), obs).times_seen_before === 2);

    console.log('\n=== supplier bills, and what cannot be compared ===');
    const addBill = (supplier, date, price, items) => bills.addBill ? bills.addBill({ supplier, date, supplier_price: price, price_unit: 'lb', gross: 40000, truck: 15000, container: 8000, chassis: 6000, boxes: 500, carrier: 'MSC', booking_no: 'B' + Math.random(), container_no: 'C' + Math.random(), route: 'H/B', items }) : null;
    const hasAdd = typeof bills.addBill === 'function';
    ck('(bills API found)', hasAdd);
    if (hasAdd) {
        for (const [d, p] of [['2026-08-01', 0.30], ['2026-08-15', 0.31], ['2026-09-01', 0.30], ['2026-09-15', 0.31], ['2026-10-01', 0.30]]) await addBill('Calderon', d, p);
        await addBill('Calderon', '2026-10-10', 0.40);
        await addBill('EDGEYARD', '2026-10-11', 0.55);
        const s2 = ph.series(ph.observations());
        const cal = s2.find((s) => s.party === 'Calderon');
        ck('supplier prices are read from bills, last 0.40 vs typical 0.30', cal.side === 'bill' && cal.last === 0.4 && cal.typical === 0.3, JSON.stringify({ last: cal.last, typical: cal.typical }));
        ck('a bill with no grade stated is marked so the AI knows it may be mixing grades', cal.item_stated === false);
        ck('a purchase from her own company is marked intercompany, not "the market"', s2.find((s) => s.party === 'EDGEYARD').intercompany === true && cal.intercompany === false);
    }

    console.log('\n=== read-only, and the real command ===');
    const snap = () => fs.readdirSync(TMP).map((f) => f + ':' + fs.statSync(path.join(TMP, f)).size + ':' + fs.statSync(path.join(TMP, f)).mtimeMs).sort().join('|');
    const before = snap();
    const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'price-facts.js'), ...a], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATA_DIR: TMP, JARVIS_TEST: '1' } });
    const all = run(), one = run('Eccomelt');
    ck('the command lists every series with its gap', all.status === 0 && /Eccomelt/.test(all.stdout) && /off \+30\.4%/.test(all.stdout) && /not enough history yet/.test(all.stdout), all.stdout + all.stderr);
    ck('the command prints one party\'s full history', one.status === 0 && /2026-10-01\s+\$2\.1000\/lb/.test(one.stdout) && !/Zimex/.test(one.stdout));
    ck('reading changed no file', snap() === before);
    const src = fs.readFileSync(path.join(ROOT, 'helpers/priceHistory.js'), 'utf8').replace(/\/\/.*$/gm, '');
    ck('the helper has no write call and no price threshold that decides anything', !/writeFile|appendFile|mutateJson|saveJson|rename\(/.test(src) && !/flag|alert|suspicious|threshold\s*=/i.test(src));

    console.log('\n=== handed to the learner as "price-check" cases (shadow) ===');
    if (spawnSync('python3', ['--version']).status !== 0) console.log('  SKIP python3 missing');
    else {
        const port = 22000 + Math.floor(Math.random() * 12000), TOK = 'price-test-token-zzzzzzzz';
        const srv = spawn('python3', [path.join(ROOT, 'learner', 'server.py'), String(port)], { env: { ...process.env, LEARNER_TOKEN: TOK, LEARNER_DATA: path.join(TMP, 'learner'), LEARNER_FAKE_LM: '1' }, stdio: 'ignore' });
        try {
            for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch (e) {} await sleep(150); }
            process.env.JARVIS_LEARNER_URL = `http://127.0.0.1:${port}`; process.env.JARVIS_LEARNER_TOKEN = TOK;
            const lc = require(path.join(ROOT, 'helpers/learnerClient'));
            const odd = ph.caseFor(obs.find((o) => o.party === 'Eccomelt' && o.date === '2026-10-01'), obs);
            const normal = ph.caseFor(obs.find((o) => o.party === 'Eccomelt' && o.date === '2026-09-10'), obs);
            const cold = await lc.judge('price-check', odd, 'p0');
            ck('before she has said anything about prices it abstains (no guessing)', cold && cold.abstained === true);
            for (let i = 0; i < 6; i++) await lc.example('price-check', { ...normal, price_per_lb: 1.6 + i / 100, date: '2026-09-1' + i }, 'normal', { ref: 'n' + i });
            for (let i = 0; i < 6; i++) await lc.example('price-check', { ...odd, price_per_lb: 2.1 + i / 100, date: '2026-10-0' + i }, 'check', { ref: 'c' + i });
            const j = await lc.judge('price-check', odd, 'p1'), j2 = await lc.judge('price-check', normal, 'p2');
            ck('once she has labelled some, a price like her "check" ones is predicted check', j && !j.abstained && j.decision === 'check', JSON.stringify(j));
            ck('  and a price like her "normal" ones is predicted normal', j2 && j2.decision === 'normal', JSON.stringify(j2));
            delete process.env.JARVIS_LEARNER_URL; delete process.env.JARVIS_LEARNER_TOKEN;
        } finally { srv.kill(); }
    }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
