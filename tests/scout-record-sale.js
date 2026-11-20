// ── tests/scout-record-sale.js ────────────────────────────────────────────
// Apsara, 2026-11-21, pasting one container into Scout:
//   "create a sale for 11/17/2026 Edge Yard Metalco, Inc. 261117_HMS_26Metalco29 NAM8794895 CMAU8789121 0345215 HMS
//    81500 31060 … 50,440 for Metalco"
// Scout had only record_outbound_sale — which sells ALL stock — and recorded 111,069 lb as OUT_38.
//
// A — record_sale: one sale, her weights, nothing inferred; mismatches and duplicates said out loud.
// B — END TO END (CLAUDE.md §3): her paste through Scout's real route, the card she sees, the confirm, the sale read
//     back from the store and stock down by exactly 50,440 lb.
// C — the all-stock tool now says EVERYTHING on its card, and its description steers away from any weight.

const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (x !== undefined) console.log('        ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 600)); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-recsale-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.CHANGE_LOG_DIR = path.join(TMP, 'change-log');
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

// 111,069 lb of HMS on hand across two lots — what the all-stock tool sold.
fs.writeFileSync(cfg.LOADS_FILE, JSON.stringify([
    { id: 'EDGE_10', date: '2026-11-01', seller: 'Randy', net_weight: 70069, items: [{ description: 'HMS', gross_weight: 70069, tare_weight: 0, net_weight: 70069, price: 0.1, amount: 7006.9 }] },
    { id: 'EDGE_11', date: '2026-11-05', seller: 'Fred', net_weight: 41000, items: [{ description: 'HMS', gross_weight: 41000, tare_weight: 0, net_weight: 41000, price: 0.1, amount: 4100 }] },
]));
fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, JSON.stringify([
    { id: 'OUT_37', date: '2026-11-17', buyer: 'Metalco, Inc.', description: 'Container SELU1111111', items: [] },
]));

const tools = require(path.join(ROOT, 'helpers/tools'));
const ya = require(path.join(ROOT, 'helpers/yardActions'));
const stock = require(path.join(ROOT, 'helpers/stock'));
const onHand = (item) => { const r = stock.stockReport(require(path.join(ROOT, 'helpers/loads')).loadLoads(), require(path.join(ROOT, 'helpers/outboundLoads')).loadOutboundLoads()).find((x) => String(x.description).toLowerCase() === item.toLowerCase()); return r ? Math.round(r.purchased - r.shipped) : 0; };
const HER = { buyer: 'Metalco, Inc.', date: '2026-11-17', item: 'HMS', gross: 81500, tare: 31060, net: 50440, price: 330, price_per: 'metric_ton',
    container: 'CMAU8789121', booking: 'NAM8794895', seal: '0345215', reference: '261117_HMS_26Metalco29', company: 'Edge Yard' };
const AMOUNT = Math.round(50440 * (330 / 2204.62) * 100) / 100;

(async () => {
section('A — record_sale: one sale, her weights');
{
    ck('record_sale is a write tool Scout is offered', tools.writeToolNames().includes('record_sale') && ya.ACTION_NAMES.includes('record_sale'));
    const card = await ya.proposeAction({ kind: 'record_sale', params: HER }, { role: 'admin' });
    const d = Object.fromEntries(card.details);
    ck('the card shows her weights: 81,500 − 31,060 = 50,440 lb net', d.Weight === '81,500 − 31,060 = 50,440 lb net', d.Weight);
    ck('  the price as she said it, and per lb', /\$330\.00 per metric ton/.test(d.Price) && /per lb/.test(d.Price), d.Price);
    ck(`  the total for 50,440 lb, not 111,069 (${AMOUNT})`, d['Sale total'] === '$' + AMOUNT.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || d['Sale total'].replace(/[$,]/g, '') === AMOUNT.toFixed(2), d['Sale total']);
    ck('  container, booking, seal and her reference are on it', /CMAU8789121/.test(d.References) && /NAM8794895/.test(d.References) && /0345215/.test(d.References) && /261117_HMS_26Metalco29/.test(d.References), d.References);
    ck('  and no mismatch warning, because her net agrees with gross − tare', !card.warnings.some((w) => /also gave a net/.test(w)), card.warnings);
    ck('  the summary says 50,440 lb', /50,440 lb net/.test(card.summary), card.summary);
    await ya.cancelAction(card.id);

    const mis = await ya.proposeAction({ kind: 'record_sale', params: { ...HER, container: 'X1', net: 49000 } });
    ck('if her net disagrees with gross − tare, the card says so and uses gross − tare', mis.warnings.some((w) => /also gave a net of 49,000/.test(w)) && /= 50,440 lb net/.test(Object.fromEntries(mis.details).Weight), mis.warnings);
    ya.cancelAction(mis.id);
    const netOnly = await ya.proposeAction({ kind: 'record_sale', params: { buyer: 'Metalco, Inc.', date: '2026-11-17', item: 'HMS', net: 50440, price: 330, price_per: 'mt', container: 'X2' } });
    ck('a net weight alone is enough', Object.fromEntries(netOnly.details).Weight === '50,440 lb net');
    ya.cancelAction(netOnly.id);
    const err = async (params) => { try { await ya.proposeAction({ kind: 'record_sale', params }); return null; } catch (e) { return e.message; } };
    ck('no weight → it asks for one, never guesses', /what weight/.test(await err({ ...HER, gross: null, tare: null, net: null })));
    ck('no price → it asks', /what price|needs price/.test(await err({ ...HER, price: null })));
    ck('no date → it asks', /what date|needs date/.test(await err({ ...HER, date: '' })));
    ck('a container already on a sale is refused', /already on sale OUT_37/.test(await err({ ...HER, container: 'SELU1111111' })));
    ck('$330 "per lb" is caught as a per-ton price', /far too high/.test(await err({ ...HER, price_per: 'lb' })));
}

section('B — end to end: her paste through Scout\'s real route');
{
    const gem = require(path.join(ROOT, 'helpers', 'gemini'));
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const port = server.address().port;
    const req = (m, p, body, sid) => new Promise((resolve) => {
        const dd = body ? JSON.stringify(body) : null; const h = {};
        if (dd) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(dd); }
        if (sid) h.Authorization = 'Bearer ' + sid;
        const r = http.request({ host: '127.0.0.1', port, path: p, method: m, headers: h }, (res) => { let raw = ''; res.on('data', (x) => { raw += x; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) { /* */ } resolve({ status: res.statusCode, json: j, raw }); }); });
        r.on('error', () => resolve({ status: 0 })); if (dd) r.write(dd); r.end();
    });
    let prompt = '';
    const real = gem.callGeminiJSON;
    gem.callGeminiJSON = async (pr) => { prompt = pr; return { answer: 'Here is the sale I will record.', have_data: true, tool: null, action: { kind: 'record_sale', params: HER } }; };
    try {
        const sid = ((await req('POST', '/login', { password: process.env.ADMIN_PASSWORD })).json || {}).sid;
        const before = onHand('HMS');
        ck('111,069 lb of HMS on hand before', before === 111069, before);
        const PASTE = 'create a sale for 11/17/2026\tEdge Yard\tMetalco, Inc.\t261117_HMS_26Metalco29\tNAM8794895\tCMAU8789121\t0345215\tHMS\t81500\t31060\t\t\t\t31,060\t50,440 for Metalco';
        const asked = await req('POST', '/api/yard/ask', { question: PASTE, source: 'website' }, sid);
        const card = asked.json && asked.json.proposal;
        ck('Scout proposes one sale on its real route', asked.status === 200 && card && card.kind === 'record_sale', asked.raw.slice(0, 300));
        ck('  the model was offered record_sale, and told the all-stock tool is never for a weight',
            /record_sale/.test(prompt) && /If ANY weight or a single load \/ lot is mentioned, use record_sale instead/.test(prompt));
        ck('  the card she confirms shows 50,440 lb', card && card.details.some(([k, v]) => k === 'Weight' && /= 50,440 lb net/.test(v)), card && card.details);
        const done = await req('POST', '/api/yard/act', { id: card.id, source: 'website' }, sid);
        ck('she confirms and it is recorded', done.status === 200 && done.json && done.json.ok, done.raw.slice(0, 200));
        const sales = (await req('GET', '/api/outbound-loads', null, sid)).json || [];
        const list = Array.isArray(sales) ? sales : (sales.loads || sales.rows || []);
        const made = list.find((o) => /CMAU8789121/.test(o.description || ''));
        const net = made && (made.items || []).reduce((a, i) => a + (Number(i.net_weight) || (Number(i.gross_weight) - Number(i.tare_weight)) || 0), 0);
        ck('the stored sale is 50,440 lb net, gross 81,500, tare 31,060', made && Math.round(net) === 50440 && made.items[0].gross_weight === 81500 && made.items[0].tare_weight === 31060, made);
        // Edge Trading IS Edge Yard (helpers/entities.js uiName); addOutboundLoad stores the record name.
        ck('  to Metalco, Inc. on 2026-11-17, sold by Edge Yard (stored as Edge Trading, the same company)', made && made.buyer === 'Metalco, Inc.' && made.date === '2026-11-17' && /^(Edge Yard|Edge Trading)$/.test(made.seller_company || 'Edge Yard'), made && { buyer: made.buyer, date: made.date, co: made.seller_company });
        ck('  with booking, seal and her reference in the description', made && /NAM8794895/.test(made.description) && /0345215/.test(made.description) && /261117_HMS_26Metalco29/.test(made.description));
        ck('stock fell by exactly 50,440 lb (111,069 → 60,629), not to zero', onHand('HMS') === 111069 - 50440, onHand('HMS'));
        const again = await req('POST', '/api/yard/ask', { question: PASTE, source: 'website' }, sid);
        ck('pasting the same container again records nothing and says why', !(again.json && again.json.proposal) && /already on sale/.test(JSON.stringify(again.json || {})), again.raw.slice(0, 300));
    } finally { gem.callGeminiJSON = real; server.close(); }
}

section('C — the all-stock tool now says EVERYTHING');
{
    const d = tools.TOOLS.record_outbound_sale.description;
    ck('its description: ONLY when she sold all and gave no weight; otherwise record_sale', /ONLY when she says she sold all/.test(d) && !/one go/.test(d) && /use record_sale instead/.test(d));
    const card = await ya.proposeAction({ kind: 'record_outbound_sale', params: { buyer: 'Metalco, Inc.', date: '2026-11-18', price: 330, price_per: 'metric_ton', descriptions: ['HMS'] } });
    const first = card.details[0];
    ck('the first line of its card is "This sells EVERYTHING on hand", with the weight', first[0] === 'This sells' && /EVERYTHING on hand of HMS — 60,629 lb/.test(first[1]), card.details[0]);
    ck('  the first warning says it is ALL and to cancel for one load', /This sells ALL 60,629 lb on hand/.test(card.warnings[0]) && /cancel and give me its weights/.test(card.warnings[0]), card.warnings);
    ck('  and its summary begins "Sell ALL on hand"', /^Sell ALL on hand to Metalco/.test(card.summary), card.summary);
    ya.cancelAction(card.id);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
