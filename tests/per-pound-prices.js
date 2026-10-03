// ── tests/per-pound-prices.js ──────────────────────────────────────────────
// ── PER-POUND PRICES (2026-10-03) ──────────────────────────────────────────
// Found while auditing whether a proforma could be auto-sent. The rate_basis
// enum was ['per_mt','per_lot','unknown'], and on her real mail the model
// answered "per_lb" -- so the extraction FAILED SCHEMA three times and Joey's
// order was lost -- or coerced it to "per_mt", which is wrong by 2204.62x.
(function perPoundPrices() {
    const { toProformaDraft } = require(require('path').join(__dirname, '..', 'helpers/proformaFromEmail.js'));
    const results = [];
    const ck2 = (name, cond, detail) => { results.push([name, cond, detail]); };

    const lb = toProformaDraft({ consignee: 'Jaemulpo', container_count: 1,
        items: [{ desc: 'Chrome wheels', qty: 21, rate: 0.42, rate_confidence: 0.9, rate_basis: 'per_lb' }] }, {});
    ck2('PL1 a per-lb figure NEVER prints as a per-MT rate', lb.items[0].rate === 0, `rate = ${lb.items[0].rate}`);
    ck2('PL2 the draft is blocked on rate', (lb.needs || []).includes('rate'), JSON.stringify(lb.needs));
    ck2('PL3 the conversion is shown with its arithmetic',
        (lb.assumed || []).some((a) => /\$0\.42\/lb/.test(a) && /925\.94\/MT/.test(a) && /2204\.62/.test(a)),
        JSON.stringify(lb.assumed));
    ck2('PL4 and it is listed as unconfirmed, not quietly grounded',
        (lb.unconfirmed || []).length > 0 && (lb.grounded || []).length === 0);

    const mt = toProformaDraft({ consignee: 'Daekwang', container_count: 2,
        items: [{ desc: 'Auto Cast', qty: 21, rate: 2420, rate_confidence: 0.9, rate_basis: 'per_mt' }] }, {});
    ck2('PL5 an honest per-MT rate is still trusted, unchanged', mt.items[0].rate === 2420 && !(mt.needs || []).length,
        `rate = ${mt.items[0].rate}, needs = ${JSON.stringify(mt.needs)}`);
    ck2('PL6 and carries no spurious assumption', (mt.assumed || []).length === 0, JSON.stringify(mt.assumed));

    const lot = toProformaDraft({ consignee: 'X', container_count: 1,
        items: [{ desc: 'Auto Cast', qty: 21, rate: 2420, rate_confidence: 0.9, rate_basis: 'per_lot' }] }, {});
    ck2('PL7 per_lot is still blocked with its own reason', lot.items[0].rate === 0
        && (lot.unconfirmed || []).some((u) => /total for the lot/.test(u)), JSON.stringify(lot.unconfirmed));

    // THE HALF OF THE BUG A toProformaDraft TEST CANNOT SEE, and reverse
    // verification is what exposed the gap: removing per_lb from the enum
    // left PL1-PL7 all green, because those call toProformaDraft directly and
    // never pass through schema validation. The enum is where Joey's order
    // was lost outright -- three failed attempts, nothing returned.
    const { OrderSchema } = require(require('path').join(__dirname, '..', 'helpers/proformaFromEmail.js'));
    const schema = OrderSchema && OrderSchema();
    const live = { is_order: true, confidence: 0.9, consignee: 'Jaemulpo', container_count: 1,
        items: [{ desc: 'Chrome wheels', qty: null, rate: 0.42, rate_confidence: 0.9, rate_basis: 'per_lb' }] };
    ck2('PL8 the SCHEMA accepts per_lb (the model really answers this)',
        !!schema && schema.safeParse(live).success,
        schema ? JSON.stringify(schema.safeParse(live).error && schema.safeParse(live).error.issues) : 'zod missing');
    ck2('PL9 and still rejects a basis nobody defined',
        !schema || !schema.safeParse({ ...live, items: [{ ...live.items[0], rate_basis: 'per_banana' }] }).success);
    ck2('PL10 the prompt tells the model per_lb is an option',
        /per_lb/.test(require(require('path').join(__dirname, '..', 'helpers/proformaFromEmail.js')).buildOrderPrompt(
            { from: 'a@b.com', subject: 's', body: 'b', date: null })));

    console.log('\n=== PL — per-pound prices ===');
    let bad = 0;
    for (const [n, c, d] of results) {
        if (c) console.log(`  PASS  ${n}`);
        else { bad++; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); }
    }
    console.log(`${results.length - bad} passed, ${bad} failed  (PL section)`);
    if (bad) process.exit(1);
})();

