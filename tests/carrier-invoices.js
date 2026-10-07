// tests/carrier-invoices.js — Edge Metals carrier-invoices store (helpers/carrierInvoices.js)
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-inv-'));
process.env.JARVIS_TEST = '1';
const cfg = require('../config');
const CI = require('../helpers/carrierInvoices');
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
(async () => {
    ck('empty store reads as []', CI.list().length === 0);
    ck('status: none/part/full', CI.statusOf(100, 0) === 'open' && CI.statusOf(100, 40) === 'part' && CI.statusOf(100, 100) === 'paid');
    ck('rejects unknown carrier / no ref / zero amount', !!CI.validate({ carrier: 'zimex', ref: '1', amount: 5 }) && !!CI.validate({ carrier: 'tql', amount: 5 }) && !!CI.validate({ carrier: 'tql', ref: '1', amount: 0 }));
    let threw = false; try { await CI.upsertMany([{ carrier: 'tql', amount: 5 }]); } catch (e) { threw = true; }
    ck('invalid row throws and writes nothing', threw && CI.list().length === 0);
    const r1 = await CI.upsertMany([{ carrier: 'tql', ref: '37359825', amount: 4500, lane: 'CA TO TX' }, { carrier: 'ntg', ref: '9621418', amount: 4900, paid: 4900 }]);
    ck('adds two rows, company Edge Metals', r1.added === 2 && CI.list().every((r) => r.company === 'Edge Metals'));
    ck('statuses derived', CI.list().find((r) => r.ref === '37359825').status === 'open' && CI.list().find((r) => r.ref === '9621418').status === 'paid');
    const r2 = await CI.upsertMany([{ carrier: 'tql', ref: '37359825', amount: 4500, paid: 1000 }]);
    ck('re-run updates, never duplicates', r2.updated === 1 && CI.list().length === 2 && CI.list().find((r) => r.ref === '37359825').status === 'part');
    ck('same ref under another carrier is a different row', (await CI.upsertMany([{ carrier: 'ntg', ref: '37359825', amount: 10 }])).added === 1);
    const raw = JSON.parse(fs.readFileSync(cfg.CARRIER_INVOICES_FILE, 'utf8')); raw[0].locked = true; raw[0].amount = 1234; fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, JSON.stringify(raw));
    await CI.upsertMany([{ carrier: raw[0].carrier, ref: raw[0].ref, amount: 9999 }]);
    ck('a locked (hand-edited) row is not overwritten', CI.list()[0].amount === 1234);
    const s = CI.summary();
    ck('summary per carrier', s.ntg.count === 2 && s.schneider.count === 0, JSON.stringify(s));
    ck('does not touch existing stores', !fs.existsSync(cfg.BILLS_FILE || '/nonexistent') && !fs.existsSync(cfg.METALS_TRUCKING_FILE));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
