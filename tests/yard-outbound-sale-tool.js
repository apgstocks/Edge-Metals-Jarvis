// ── tests/yard-outbound-sale-tool.js ────────────────────────────────────────
// Apsara, 2026-11-14, to the yard assistant: "We have sold all rotors and drums
// before 11/13. Make changes in my inventory accordingly. We sold this to
// metalco" — refused ("I cannot record outbound sales"). She chose to teach it,
// and to have it ASK the price and the date. Same propose-then-confirm as every
// other write. Section E goes through the real server: /api/yard/act to write,
// /api/loads/stock to read the figure back, as the screens do.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-outsale-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const { mutateJson, loadJson } = require(path.join(ROOT, 'helpers/json'));
const ya = require(path.join(ROOT, 'helpers/yardActions'));
const stock = require(path.join(ROOT, 'helpers/stock'));

(async () => {
const inbound = () => loadJson(cfg.LOADS_FILE, []);
const outbound = () => loadJson(cfg.OUTBOUND_LOADS_FILE, []);
const onHand = (name) => {
    const r = stock.stockReport(inbound(), outbound()).find((x) => x.description.toLowerCase() === name.toLowerCase());
    return r ? Math.round((r.purchased - r.shipped) * 100) / 100 : 0;
};

await mutateJson(cfg.LOADS_FILE, [], () => [
    { id: 'EDGE_1', date: '2026-11-02', seller: 'Ramesh', net_weight: 3000, amount: 900, items: [{ description: 'Rotors', net_weight: 2000, amount: 600 }, { description: 'Drums', net_weight: 1000, amount: 300 }] },
    { id: 'EDGE_2', date: '2026-11-09', seller: 'Suresh', net_weight: 1500, amount: 500, items: [{ description: 'Rotors', net_weight: 1500, amount: 500 }] },
    { id: 'EDGE_3', date: '2026-11-13', seller: 'Mani', net_weight: 800, amount: 200, items: [{ description: 'Rotors', net_weight: 800, amount: 200 }] },
    { id: 'EDGE_4', date: '2026-11-05', seller: 'Gomez', net_weight: 700, amount: 140, items: [{ description: 'Auto cast', net_weight: 700, amount: 140 }] },
]);
await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], () => [
    { id: 'OUT_1', date: '2026-11-06', buyer: 'Daekwang', status: 'sent', items: [{ description: 'Rotors', net_weight: 500, draws: [{ load_id: 'EDGE_1', weight: 500 }] }] },
]);
const base0 = { rotors: onHand('Rotors'), drums: onHand('Drums'), auto: onHand('Auto cast') };
const metalsSnap = JSON.stringify(['bills.json', 'sales.json'].map((f) => fs.existsSync(path.join(TMP, f))));

section('A. the assistant now knows it');
{
    const tools = require(path.join(ROOT, 'helpers/tools'));
    ck('record_outbound_sale is a declared write tool', tools.writeToolNames().includes('record_outbound_sale'));
    ck('  and is in the assistant\'s action vocabulary', ya.ACTION_NAMES.includes('record_outbound_sale'));
    ck('  and still no delete or send', !ya.ACTION_NAMES.some((n) => /delete|remove|void|send|email|whatsapp/i.test(n)));
    ck('  its prompt tells the model to ask for the price and the date', /ASK, do not guess/.test(tools.describeTools()) && /ASK, do not assume today/.test(tools.describeTools()));
}

section('B. refuses what it must ask first');
{
    const miss = async (p) => { try { await ya.proposeAction({ kind: 'record_outbound_sale', params: p }); return null; } catch (e) { return e.message; } };
    const full = { buyer: 'Metalco', date: '2026-11-14', price: 0.25, descriptions: ['Rotors', 'Drums'], received_before: '2026-11-13' };
    ck('no price → asks', /price/i.test(await miss({ ...full, price: undefined }) || ''));
    ck('no date → asks', /date/i.test(await miss({ ...full, date: undefined }) || ''));
    ck('no buyer → asks', /buyer|sell to/i.test(await miss({ ...full, buyer: undefined }) || ''));
    ck('zero price → refused', /price/i.test(await miss({ ...full, price: 0 }) || ''));
    ck('an item with nothing on hand → refused, says so', /no Widgets on hand/i.test(await miss({ ...full, descriptions: ['Widgets'] }) || ''));
}

section('B2. Apsara 2026-11-15: she typed 0.159 and the card said "$0.16"');
{
    const card = await ya.proposeAction({ kind: 'record_outbound_sale', params: { buyer: 'Metalco', date: '2026-11-14', price: 0.159, descriptions: ['Rotors'], received_before: '2026-11-13' } });
    const priceRow = (card.details || []).find((d) => d[0] === 'Price');
    ck('the card shows the price as typed, not rounded to cents', priceRow && priceRow[1] === '$0.159 per lb', JSON.stringify(priceRow));
    ck('  and so does the one-line summary', /at \$0\.159\/lb/.test(card.summary || ''), card.summary);
    try { await ya.cancelAction(card.id); } catch (_) {}
}

section('B3. Apsara 2026-11-15: "per mt weight is 350" - the system converts, the model does not');
{
    const P = { buyer: 'Metalco', date: '2026-11-14', descriptions: ['Rotors'], received_before: '2026-11-13' };
    const ask = async (extra) => { try { return await ya.proposeAction({ kind: 'record_outbound_sale', params: { ...P, ...extra } }); } catch (e) { return { error: e.message }; } };
    const mt = await ask({ price: 350, price_per: 'metric_ton' });
    const want = Math.round(3000 * 350 / 2204.62 * 100) / 100;
    ck('350 per metric ton: total = weight / 2,204.62 x 350', !mt.error && JSON.stringify(mt.details).includes('$' + want.toFixed(2)), JSON.stringify(mt.error || mt.details));
    ck('  the card shows the quote AND the per-lb price worked out from it', /Quoted price[^\]]*\$350\.00 per metric ton \(2,204\.62 lb\)/.test(JSON.stringify(mt.details)) && /\$0\.1588 per lb/.test(JSON.stringify(mt.details)), JSON.stringify(mt.details));
    const alias = await ask({ price: 350, price_per: 'MT' });
    ck('"MT" means metric ton, same answer', !alias.error && JSON.stringify(alias.details) === JSON.stringify(mt.details), JSON.stringify(alias.error));
    const gt = await ask({ price: 350, price_per: 'gross_ton' });
    ck('gross ton divides by 2,240', !gt.error && JSON.stringify(gt.details).includes('$' + (Math.round(3000 * 350 / 2240 * 100) / 100).toFixed(2)), JSON.stringify(gt.error || gt.details));
    const nt = await ask({ price: 350, price_per: 'per net ton' });
    ck('"per net ton" divides by 2,000', !nt.error && JSON.stringify(nt.details).includes('$' + (Math.round(3000 * 350 / 2000 * 100) / 100).toFixed(2)), JSON.stringify(nt.error || nt.details));
    const bare = await ask({ price: 350 });
    ck('350 with no unit is refused, asking which ton - never sold at $350 a pound', /per metric ton|per gross ton/.test(bare.error || ''), JSON.stringify(bare));
    const odd = await ask({ price: 350, price_per: 'per bucket' });
    ck('an unknown unit is refused', /don't know the price unit/.test(odd.error || ''), JSON.stringify(odd));
    const lb = await ask({ price: 0.159 });
    ck('a plain per-lb price still works exactly as before', !lb.error && /\$0\.159 per lb/.test(JSON.stringify(lb.details)) && !/Quoted price/.test(JSON.stringify(lb.details)), JSON.stringify(lb.error || lb.details));
    for (const c of [mt, alias, gt, nt, lb]) { try { if (c && c.id) await ya.cancelAction(c.id); } catch (_) {} }
}

section('C. the proposal is exact and writes nothing');
let proposal;
{
    const before = JSON.stringify(outbound());
    proposal = await ya.proposeAction({ kind: 'record_outbound_sale', params: { buyer: 'Metalco', date: '2026-11-14', price: 0.25, descriptions: ['Rotors', 'Drums'], received_before: '2026-11-13' } }, { role: 'admin' });
    ck('wrote nothing', before === JSON.stringify(outbound()));
    // Lots before 11/13: EDGE_1 (3000, 500 already drawn → 2500 left) and EDGE_2 (1500). EDGE_3 is dated 11/13, not before.
    // Rotors: EDGE_1 2000 - 500 already shipped = 1500, + EDGE_2 1500 = 3000. Drums: 1000 (never shipped).
    const text = JSON.stringify(proposal.details);
    ck('rotors: 3,000 lb (EDGE_3, dated 11/13, is NOT "before 11/13")', /Rotors[^\]]*3,000 lb/.test(text), text);
    ck('drums: 1,000 lb, and the 500 lb of rotors already shipped is not sold twice', /Drums[^\]]*1,000 lb/.test(text), text);
    ck('total = weight × price', /\$1000\.00/.test(text), text);
    ck('summary names buyer, date and price', /Metalco/.test(proposal.summary) && /2026-11-14/.test(proposal.summary) && /\$0\.25\/lb/.test(proposal.summary), proposal.summary);
    ck('it warns the buyer is new to the yard', proposal.warnings.some((w) => /no earlier sale/i.test(w)));
}

section('D. confirm: stock falls by exactly that, nothing else moves');
{
    const out = await ya.confirmAction(proposal.id, { role: 'admin' });
    ck('written', out.ok === true && out.result && /^OUT_/.test(out.result.id), JSON.stringify(out.result && out.result.id));
    ck('Rotors on hand fell by 3,000 (the 800 lb on the 11/13 lot is left)', Math.abs((base0.rotors - onHand('Rotors')) - 3000) < 0.02, `${base0.rotors} → ${onHand('Rotors')}`);
    ck('Drums on hand fell by 1,000', Math.abs((base0.drums - onHand('Drums')) - 1000) < 0.02, `${base0.drums} → ${onHand('Drums')}`);
    ck('Auto cast untouched', onHand('Auto cast') === base0.auto);
    const rec = outbound()[0];
    ck('the sale carries the buyer, date and price', rec.buyer === 'Metalco' && rec.date === '2026-11-14' && rec.items.every((i) => i.price === 0.25), JSON.stringify(rec).slice(0, 200));
    ck('  and draws against the real lots', rec.items.every((i) => i.draws.length && i.draws.every((d) => ['EDGE_1', 'EDGE_2'].includes(d.load_id))));
    let again = null; try { await ya.confirmAction(proposal.id, {}); } catch (e) { again = e; }
    ck('a second tap cannot sell it twice', !!again);
    let nothing = null; try { await ya.proposeAction({ kind: 'record_outbound_sale', params: { buyer: 'Metalco', date: '2026-11-14', price: 0.25, descriptions: ['Rotors', 'Drums'], received_before: '2026-11-13' } }); } catch (e) { nothing = e.message; }
    ck('asking again finds nothing left before 11/13 to sell', /on hand/i.test(nothing || ''), nothing);
}

section('D2. stock moved between the card and the tap');
{
    const pr = await ya.proposeAction({ kind: 'record_outbound_sale', params: { buyer: 'Metalco', date: '2026-11-14', price: 0.2, descriptions: ['Auto cast'] } }, { role: 'admin' });
    await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], (d) => { d.unshift({ id: 'OUT_X', date: '2026-11-14', buyer: 'Other', status: 'sent', items: [{ description: 'Auto cast', net_weight: 400, draws: [{ load_id: 'EDGE_4', weight: 400 }] }] }); return d; });
    let err = null; try { await ya.confirmAction(pr.id, {}); } catch (e) { err = e.message; }
    ck('confirm is refused when the lot no longer has that much', /stock changed/i.test(err || ''), err);
    ck('  and nothing was written for it', !outbound().some((o) => o.items.some((i) => i.price === 0.2)));
}

section('D2. a price quoted per metric ton is STORED per lb, divided from what she said');
{
    const card = await ya.proposeAction({ kind: 'record_outbound_sale', params: { buyer: 'Metalco', date: '2026-11-15', price: 350, price_per: 'MT', descriptions: ['Auto cast'] } }, { role: 'admin' });
    const out = await ya.confirmAction(card.id, { role: 'admin' });
    const rec = outbound().find((o) => o.id === out.result.id);
    const kg = rec.items[0].gross_weight;
    ck('the saved line carries 350 / 2,204.62 per lb, not a rounded 0.159', rec && Math.abs(rec.items[0].price - 350 / 2204.62) < 1e-9, JSON.stringify(rec && rec.items[0].price));
    ck('  and the load amount is weight x that price (to the cent)', Math.abs((rec.amount != null ? rec.amount : rec.total_amount) - Math.round(kg * 350 / 2204.62 * 100) / 100) < 0.02, JSON.stringify([rec.amount, rec.total_amount, kg]));
}

section('E. END TO END, through the real server');
{
    const { createApi } = require(path.join(ROOT, 'api'));
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
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    const admin = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!admin);
    // The 11/13 lot is now the sale's target: "sell all Rotors" with no cutoff.
    const p2 = await ya.proposeAction({ kind: 'record_outbound_sale', params: { buyer: 'Metalco', date: '2026-11-14', price: 0.3, descriptions: ['Rotors'] } }, { role: 'admin' });
    const before = ((await req('GET', '/api/loads/stock', { sid: admin })).json.byType.find((t) => /rotors/i.test(t.description)) || {});
    const invRow = async () => (((await req('GET', '/api/loads/inventory', { sid: admin })).json || {}).byType || []).find((t) => /rotors/i.test(t.description)) || {};
    const invBefore = await invRow();   // the Inventory SCREEN reads this route, not /stock
    const act = await req('POST', '/api/yard/act', { sid: admin, body: { id: p2.id } });
    ck('/api/yard/act writes it', act.status === 200 && act.json.ok === true, JSON.stringify(act.json));
    const after = ((await req('GET', '/api/loads/stock', { sid: admin })).json.byType.find((t) => /rotors/i.test(t.description)) || {});
    ck('  the stock route shows 800 lb more shipped (delta, not absolute)', Math.abs((after.shipped - before.shipped) - 800) < 0.02, JSON.stringify([before, after]));
    ck('  and nothing left on hand — no negative stock', Math.abs(after.purchased - after.shipped) < 0.02 && !after.negative, JSON.stringify(after));
    const invAfter = await invRow();
    ck('  the INVENTORY screen route shows it too: shipped +800 and on hand -800 (Apsara 2026-11-15: "why my inventory is not adjusted?")', Math.abs((invAfter.shipped - invBefore.shipped) - 800) < 0.02 && Math.abs((invBefore.onHand - invAfter.onHand) - 800) < 0.02, JSON.stringify([invBefore, invAfter]));
    const list = await req('GET', '/api/outbound-loads', { sid: admin });
    ck('  the outbound list shows it for Metalco', JSON.stringify(list.json).includes('Metalco'));
    ck('Edge Metals data untouched', JSON.stringify(['bills.json', 'sales.json'].map((f) => fs.existsSync(path.join(TMP, f)))) === metalsSnap);
    server.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
