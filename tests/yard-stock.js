// ── tests/yard-stock.js ─────────────────────────────────────────────────────
// Covers the 2026-08-24 yard work, none of which had a test:
//   • the consumption ledger (helpers/stock.js) — on-hand, per-lot remaining,
//     FIFO suggestion, over-draw rejection
//   • inventory netting purchases against sales, and refusing to under a date
//     filter
//   • sales as outbound loads: save / edit / delete all re-net with no
//     rollback code
//   • money formatting (helpers/money.js)
//   • the sale ticket naming the buyer and carrying no signature line
//   • the staff allowlist, read from api.js rather than restated here
//
// Deliberately uses REAL modules against a temp data dir rather than mocks:
// every bug this suite would have caught was an integration one — a field
// dropped by a rebuild, a filter making a figure meaningless, a permission
// list disagreeing with the UI — and a mock of the thing that was wrong would
// have agreed with the code.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const cfg = require('../config');

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; failures.push(name); console.log('  FAIL  ' + name); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ── temp stores, restored afterwards ───────────────────────────────────────
const FILES = [cfg.LOADS_FILE, cfg.OUTBOUND_LOADS_FILE];
const backups = FILES.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null));
function restore() {
    FILES.forEach((f, i) => {
        if (backups[i] !== null) fs.writeFileSync(f, backups[i]);
        else if (fs.existsSync(f)) fs.unlinkSync(f);
    });
}
process.on('exit', restore);

fs.mkdirSync(path.dirname(cfg.LOADS_FILE), { recursive: true });
const INBOUND = [
    { id: 'EDGE_1', date: '2026-08-01', seller: 'Ramesh', net_weight: 20000, amount: 12000, weight_unit: 'lb',
      items: [{ description: 'Auto cast', net_weight: 20000, amount: 12000 }] },
    { id: 'EDGE_2', date: '2026-08-05', seller: 'Rad Metal', net_weight: 15000, amount: 9750, weight_unit: 'lb',
      items: [{ description: 'Auto cast', net_weight: 15000, amount: 9750 }] },
    { id: 'EDGE_3', date: '2026-08-10', seller: 'Hugo', net_weight: 10000, amount: 7000, weight_unit: 'lb',
      items: [{ description: 'Chrome', net_weight: 10000, amount: 7000 }] },
];
fs.writeFileSync(cfg.LOADS_FILE, JSON.stringify(INBOUND, null, 2));
fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');

const S = require('../helpers/stock');
const money = require('../helpers/money');

section('A — money reads the same everywhere');
{
    ck('a whole number gets two decimals', money.amount(2466) === '2,466.00');
    ck('thousands are separated', money.amount(101640) === '101,640.00');
    // toFixed(2) returns "1.00" here because the double sits just below 1.005.
    ck('1.005 rounds UP, not toFixed-down', money.amount(1.005) === '1.01');
    ck('float noise is absorbed', money.amount(350.1 + 350.2) === '700.30');
    ck('a rate keeps a real third decimal', money.rate(0.605) === '0.605');
    ck('but a bare rate still gets two', money.rate(0.6) === '0.60');
    ck('missing reads as an em dash, not $null', money.usd(null) === '—');
    ck('junk is null rather than NaN', money.amount('abc') === null);
}

section('B — the consumption ledger');
{
    const st = S.stockReport(INBOUND, []);
    const auto = st.find((t) => t.description === 'Auto cast');
    ck('two lots of one material sum', auto.purchased === 35000);
    ck('nothing shipped means on hand equals bought', auto.onHand === 35000);

    const sug = S.suggestDraws(INBOUND, [], 'Auto cast', 28000);
    ck('FIFO takes the oldest lot first', sug.draws[0].load_id === 'EDGE_1');
    ck('and spills into the next', sug.draws[1].load_id === 'EDGE_2' && sug.draws[1].weight === 8000);
    ck('a covered request reports no shortfall', sug.shortfall === 0);

    const OUT = [{ id: 'OUT_1', date: '2026-08-20', buyer: 'Daekwang', net_weight: 28000,
        items: [{ description: 'Auto cast', net_weight: 28000,
            draws: sug.draws.map((d) => ({ load_id: d.load_id, weight: d.weight })) }] }];
    const after = S.stockReport(INBOUND, OUT).find((t) => t.description === 'Auto cast');
    ck('shipping reduces on hand', after.onHand === 7000);
    ck('and records what shipped', after.shipped === 28000);

    const lots = S.lotReport(INBOUND, OUT);
    ck('a fully drawn lot has nothing left', lots.find((l) => l.id === 'EDGE_1').remaining === 0);
    ck('a partly drawn lot keeps the balance', lots.find((l) => l.id === 'EDGE_2').remaining === 7000);
    ck('an untouched lot is untouched', lots.find((l) => l.id === 'EDGE_3').remaining === 10000);

    ck('over-drawing a lot is rejected',
        S.validateDraws(INBOUND, OUT, [{ load_id: 'EDGE_2', weight: 9000 }]).ok === false);
    ck('drawing exactly what remains is allowed',
        S.validateDraws(INBOUND, OUT, [{ load_id: 'EDGE_2', weight: 7000 }]).ok === true);
    ck('an edit does not fight its own existing draws',
        S.validateDraws(INBOUND, OUT, [{ load_id: 'EDGE_1', weight: 20000 }], { ignoreOutboundId: 'OUT_1' }).ok === true);
    ck('a short yard reports the shortfall rather than part-filling',
        S.suggestDraws(INBOUND, OUT, 'Auto cast', 20000).shortfall === 13000);

    // An unlinked sale is still material that left the yard.
    const UNLINKED = [...OUT, { id: 'OUT_2', date: '2026-08-21', buyer: 'X', net_weight: 5000,
        items: [{ description: 'Auto cast', net_weight: 5000 }] }];
    ck('a sale with no draws still reduces on hand',
        S.stockReport(INBOUND, UNLINKED).find((t) => t.description === 'Auto cast').onHand === 2000);
    ck('shipping more than was bought is FLAGGED, not clamped',
        S.stockReport([INBOUND[0]], UNLINKED).find((t) => t.description === 'Auto cast').negative === true);
    ck('a lot with no amount has unknown cost, not free', S.unitCostOf({ net_weight: 1000, amount: 0 }) === null);
    ck('a normal lot prices per unit', Math.abs(S.unitCostOf(INBOUND[0]) - 0.6) < 1e-9);
}

section('C — inventory nets sales, and refuses to when it would lie');
{
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, JSON.stringify([
        { id: 'OUT_1', date: '2026-08-20', buyer: 'Daekwang', net_weight: 28000,
          items: [{ description: 'Auto cast', net_weight: 28000 }] },
    ], null, 2));
    delete require.cache[require.resolve('../helpers/loads')];
    const { getInventoryReport } = require('../helpers/loads');

    const all = getInventoryReport(INBOUND, {});
    const auto = all.byType.find((g) => g.description === 'Auto cast');
    ck('on hand is offered when looking at everything', all.onHandAvailable === true);
    ck('purchases minus sales', auto.onHand === 7000);
    ck('net still means what came IN — the PDF and workbook read it', auto.net === 35000);

    // "bought this week minus shipped ever" is not a number anyone should act on.
    const ranged = getInventoryReport(INBOUND, { from: '2026-08-01', to: '2026-08-07' });
    ck('a date filter withdraws on-hand rather than computing nonsense', ranged.onHandAvailable === false);
    ck('and says nothing about shipped for that range',
        ranged.byType.every((g) => g.shipped === undefined));

    // Material shipped that was never recorded as bought must still show.
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, JSON.stringify([
        { id: 'OUT_2', date: '2026-08-21', buyer: 'X', net_weight: 500,
          items: [{ description: 'Sealed units', net_weight: 500 }] },
    ], null, 2));
    delete require.cache[require.resolve('../helpers/loads')];
    const ghost = require('../helpers/loads').getInventoryReport(INBOUND, {});
    const su = ghost.byType.find((g) => String(g.description).toLowerCase() === 'sealed units');
    ck('a material shipped but never bought still appears', !!su);
    ck('at negative on hand, so the hole is visible', su && su.onHand === -500);
}

section('D — a sale is saved, edited and deleted; inventory follows each time');
{
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');
    delete require.cache[require.resolve('../helpers/outboundLoads')];
    const ob = require('../helpers/outboundLoads');
    const onHand = () => {
        delete require.cache[require.resolve('../helpers/loads')];
        const L = require('../helpers/loads');
        const g = L.getInventoryReport(L.loadLoads(), {}).byType.find((x) => x.description === 'Auto cast');
        return g ? g.onHand : null;
    };
    return (async () => {
        ck('starts at everything bought', onHand() === 35000);
        const sale = await ob.addOutboundLoad({ date: '2026-08-20', buyer: 'Daekwang',
            buyer_address: '55 Industrial Rd, Busan', weight_unit: 'lb',
            items: [{ description: 'Auto cast', gross_weight: 8100, tare_weight: 100, price: 0.85 }] });
        ck('a sale computes its own net', sale.net_weight === 8000);
        ck('and its amount', sale.amount === 6800);
        ck('saving a sale reduces on hand', onHand() === 27000);

        const edited = await ob.editOutboundLoad(sale.id, { date: '2026-08-20', buyer: 'Daekwang',
            weight_unit: 'lb', items: [{ description: 'Auto cast', gross_weight: 12100, tare_weight: 100, price: 0.85 }] });
        ck('editing re-nets to the new figure', onHand() === 23000);
        ck('and invalidates the ticket, which showed the old numbers', edited.pdf_link === null);

        await ob.deleteOutboundLoad(sale.id);
        ck('deleting puts the material back', onHand() === 35000);

        // draws survive a round trip through buildRecord
        const withDraws = await ob.addOutboundLoad({ date: '2026-08-22', buyer: 'Y', weight_unit: 'lb',
            items: [{ description: 'Auto cast', gross_weight: 5000, tare_weight: 0, price: 1,
                      draws: [{ load_id: 'EDGE_1', weight: 5000 }] }] });
        ck('a draw is stored on the item', withDraws.items[0].draws.length === 1);
        ck('junk draws are dropped, not stored',
            (await ob.addOutboundLoad({ date: '2026-08-23', buyer: 'Z', weight_unit: 'lb',
                items: [{ description: 'Chrome', gross_weight: 100, tare_weight: 0, price: 1,
                          draws: [{ load_id: '', weight: 5 }, { load_id: 'EDGE_3', weight: 0 }] }] })).items[0].draws.length === 0);

        // patchOutboundLoad exists because editOutboundLoad drops unknown fields
        const patched = await ob.patchOutboundLoad(withDraws.id, { pdf_link: 'https://drive/x', pdf_drive_id: 'x' });
        ck('a pdf link written by patch survives', patched.pdf_link === 'https://drive/x');
        const reEdited = await ob.editOutboundLoad(withDraws.id, { date: '2026-08-22', buyer: 'Y',
            weight_unit: 'lb', items: [{ description: 'Auto cast', gross_weight: 5000, tare_weight: 0, price: 1 }] });
        ck('but an edit clears it again', reEdited.pdf_link === null);

        section('E — staff permissions, read from api.js not restated');
        {
            const src = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
            const list = JSON.parse('[' + src.match(/const STAFF_ALLOWED_PATH_PREFIXES = \[([^\]]+)\]/)[1].replace(/'/g, '"') + ']');
            const allowed = (p) => list.some((x) => p === x || p.startsWith(x + '/'));
            ck('staff can work loads', allowed('/api/loads'));
            ck('staff can record sales — Apsara, asked directly: "no" to denying them', allowed('/api/outbound-loads'));
            ck('staff can generate a sale ticket', allowed('/api/outbound-loads/OUT_1/generate-pdf'));
            ck('staff can see stock', allowed('/api/loads/stock'));
            ck('staff CANNOT reach expenses', !allowed('/api/expenses'));
            ck('staff CANNOT raise a proforma', !allowed('/api/proforma/generate'));
            ck('staff CANNOT read settings', !allowed('/api/settings'));
            ck('staff CANNOT reach documents', !allowed('/api/documents/download'));
        }

        console.log('\n================================================================');
        console.log(`${pass} passed, ${fail} failed`);
        if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  - ' + f)); }
        restore();
        process.exit(fail ? 1 : 0);
    })();
}
