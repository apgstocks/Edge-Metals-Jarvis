// ── tests/loading-and-units.js ─────────────────────────────────────────────
// Apsara, 2026-10-03: "by default if its a single thing,its quantity is 21 MT.
// All these would be saved in jarvis memory."
//
// She is right about the mechanism and wrong about the constant, and the
// difference is money. Her own invoice sheet says auto cast loads at 21.9 MT
// (90 containers) and CHROME WHEELS at 14.0 MT (3 containers, 12.9-14.6) --
// so defaulting Joey's chrome wheels to 21 would overstate the quantity by
// 50%, about $6,500 on one container.
//
// THE FIXTURE ROWS BELOW ARE REAL ROWS off that sheet, including the mixed
// units that turned out to be the bigger bug: a per-tonne export sale and a
// per-pound domestic purchase sit in the SAME two columns.
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

// Stub the sheet BEFORE anything requires it, via the module cache -- the same
// seam tests/two-mailbox.js uses for gmail.
const HEADERS = ['consignee', 'container no.', 'item description', 'weight', 'inv price', 'inv date'];
const ROWS = [
    // Joey's real export sales: price per MT, weight in MT.
    ['Joey/Wooshin', 'C001', 'Aluminium Wheels Clean', '14.098', '$2,930.00', '3/24/2026'],
    ['Joey/Wooshin', 'C002', 'Aluminium Wheels Clean', '14.243', '$3,095.00', '4/10/2026'],
    ['Joey/Wooshin', 'C003', 'Aluminium wheels clean', '13.644', '$3,180.00', '4/22/2026'],
    // Chrome wheels: one per-MT sale, one per-LB purchase. The mixed bucket.
    ['MAPTRASCO', 'C004', 'CHROME WHEELS', '14.007', '$2,650.00', '1/13/2026'],
    ['Daiki', 'C005', 'Chrome Wheels', '32080', '$1.310', '4/23/2026'],
    ['Nicro Metals', 'C006', 'DIRTY CHROME WHEELS', '29000', '$1.310', '5/11/2026'],
    // A third CHROME WHEELS container, because three is the minimum before a
    // default may be learnt. Note "DIRTY CHROME WHEELS" above does NOT join
    // this bucket -- dirty and clean are different grades and load differently,
    // and the fuzzy matcher correctly keeps them apart.
    ['Varo Trading', 'C022', 'Chrome Wheels', '13.90', '$2,680.00', '3/19/2026'],
    // Al Wheels Dirty: every row per-pound. Six containers, tight spread.
    ['Eccomelt', 'C007', 'AL WHEELS DIRTY', '43600', '$1.42', '4/9/2026'],
    ['Eccomelt', 'C008', 'AL WHEELS DIRTY', '44640', '$1.42', '4/17/2026'],
    ['Eccomelt', 'C009', 'AL WHEELS DIRTY', '43200', '$1.51', '4/28/2026'],
    ['G&C', 'C010', 'Al Wheels Dirty', '44000', '$1.72', '6/25/2026'],
    ['G&C', 'C011', 'Al Wheels Dirty', '43900', '$1.72', '6/30/2026'],
    ['G&C', 'C012', 'Al Wheels Dirty', '44100', '$1.70', '7/2/2026'],
    // Auto cast: the control she gave a figure for herself.
    ['Hynos', 'C013', 'Auto cast', '21.88', '$2,270.00', '2/1/2026'],
    ['Hynos', 'C014', 'Auto cast', '22.10', '$2,420.00', '2/8/2026'],
    ['Hynos', 'C015', 'Auto cast', '21.50', '$2,300.00', '2/15/2026'],
    // A material loaded wildly differently every time: NO default may be learnt.
    ['X', 'C016', 'Alum Scrap 356 Wheel', '2.9', '$2,900.00', '3/1/2026'],
    ['X', 'C017', 'Alum Scrap 356 Wheel', '7.78', '$2,900.00', '3/2/2026'],
    ['X', 'C018', 'Alum Scrap 356 Wheel', '10.7', '$2,900.00', '3/3/2026'],
    // Two materials in ONE container: says nothing about a single-material load.
    ['Y', 'C019', 'Al combo', '13.0', '$2,100.00', '3/4/2026'],
    ['Y', 'C019', 'Regular combo', '9.0', '$1,900.00', '3/4/2026'],
    ['Y', 'C020', 'Al combo', '13.1', '$2,100.00', '3/5/2026'],
    ['Y', 'C020', 'Regular combo', '9.1', '$1,900.00', '3/5/2026'],
    ['Y', 'C021', 'Al combo', '13.0', '$2,100.00', '3/6/2026'],
    ['Y', 'C021', 'Regular combo', '9.0', '$1,900.00', '3/6/2026'],
];
const real = require(R('helpers/invoiceSheet.js'));
real.fetchRawSheet = async () => ({ headers: HEADERS, rows: ROWS });

const lh = require(R('helpers/loadingHistory.js'));
const rp = require(R('helpers/ratePlausibility.js'));
const { groundRates, toProformaDraft } = require(R('helpers/proformaFromEmail.js'));

let pass = 0, fail = 0;
const failures = [];
const ck = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

(async () => {
    lh._resetCache();

    section('LA — the loading is remembered PER MATERIAL, from her own invoices');
    const wheels = await lh.standardLoadFor('Aluminium wheels clean');
    ck('LA1 clean alu wheels load at ~14 MT, not 21', wheels && Math.round(wheels.mt) === 14,
        wheels ? `${wheels.mt} MT over ${wheels.n}` : 'no default found');
    const cast = await lh.standardLoadFor('Auto cast');
    ck('LA2 auto cast loads at ~22 MT — her own "21 MT" confirmed independently',
        cast && cast.mt >= 21 && cast.mt <= 23, cast ? `${cast.mt} MT over ${cast.n}` : 'none');
    ck('LA3 the two differ by ~50%, which is why one number cannot serve both',
        wheels && cast && (cast.mt / wheels.mt) > 1.4, wheels && cast ? `${cast.mt} vs ${wheels.mt}` : 'n/a');
    ck('LA4 a material loaded 2.9-10.7 MT teaches NO default — it keeps asking',
        (await lh.standardLoadFor('Alum Scrap 356 Wheel')) === null);
    ck('LA5 a material never invoiced teaches no default', (await lh.standardLoadFor('Unobtainium')) === null);
    // Pounds and tonnes in one column. Al Wheels Dirty is recorded in POUNDS;
    // read as tonnes it would claim a 44,000 MT container.
    const dirty = await lh.standardLoadFor('Al Wheels Dirty');
    ck('LA6 pound weights are converted, not taken literally',
        dirty && dirty.mt > 15 && dirty.mt < 21, dirty ? `${dirty.mt} MT` : 'none');
    ck('LA7 a two-material container teaches nothing about a single-material load',
        (await lh.standardLoadFor('Regular combo')) === null,
        JSON.stringify(await lh.standardLoadFor('Regular combo')));

    section('LB — the rate band is per UNIT, not per material');
    const trap = await rp.judgeRate('Al Wheels Dirty', 1.72, 'per_mt');
    ck('LB1 THE TRAP: $1.72 as a per-MT rate is NOT confirmed', !trap.confirmed,
        `confirmed = ${trap.confirmed}, reason = ${trap.reason}`);
    ck('LB2 and it says WHY — the history on record is per-pound',
        /per-pound/.test(trap.reason || ''), trap.reason);
    const asLb = await rp.judgeRate('Al Wheels Dirty', 1.72, 'per_lb');
    ck('LB3 the same figure IS confirmed as a per-pound purchase price', asLb.confirmed === true
        && asLb.basis === 'per_lb', `${asLb.basis} / ${asLb.confirmed}`);
    const joey = await rp.judgeRate('Aluminium wheels clean', 3095, 'per_mt');
    ck('LB4 Joey\'s real $3,095/MT is confirmed against his own past invoices',
        joey.confirmed === true && joey.basis === 'per_mt', `${joey.basis} / ${joey.reason}`);
    const low = await rp.judgeRate('Aluminium wheels clean', 925.94, 'per_mt');
    ck('LB5 $925.94/MT for the same material is flagged, not confirmed',
        !low.confirmed && low.basis === 'unknown', `${low.basis} / ${low.reason}`);

    section('LC — the draft tells the truth about which it is');
    const d1 = toProformaDraft(await groundRates({ consignee: 'Joey/Wooshin', container_count: 1,
        items: [{ desc: 'Aluminium wheels clean', qty: null, rate: 3095, rate_confidence: 0.9, rate_basis: 'per_mt' }] }), {});
    ck('LC1 the quantity is filled from history, and shown as assumed', d1.items[0].qty != null
        && (d1.assumed || []).some((a) => /14\.1/.test(a) && /past container/.test(a)),
        `qty ${d1.items[0].qty} / ${JSON.stringify(d1.assumed)}`);
    ck('LC2 a CONFIRMED rate lands in grounded', (d1.grounded || []).some((g) => /in line with/.test(g)),
        JSON.stringify(d1.grounded));
    ck('LC3 nothing is missing on a fully grounded order', !(d1.needs || []).length, JSON.stringify(d1.needs));

    const d2 = toProformaDraft(await groundRates({ consignee: 'X', container_count: 1,
        items: [{ desc: 'Al Wheels Dirty', qty: null, rate: 1.72, rate_confidence: 0.9, rate_basis: 'per_mt' }] }), {});
    ck('LC4 an UNCONFIRMED rate never appears as grounded', !(d2.grounded || []).length,
        JSON.stringify(d2.grounded));
    ck('LC5 it appears as unconfirmed instead — absence of evidence is not evidence',
        (d2.unconfirmed || []).some((u) => /no past per-MT invoice/.test(u)), JSON.stringify(d2.unconfirmed));

    const d3 = toProformaDraft(await groundRates({ consignee: 'Jaemulpo', container_count: 1,
        items: [{ desc: 'Chrome wheels', qty: null, rate: 0.42, rate_confidence: 0.9, rate_basis: 'per_lb' }] }), {});
    ck('LC6 Joey\'s real email is no longer blocked on quantity',
        !(d3.needs || []).includes('quantity'), JSON.stringify(d3.needs));
    ck('LC7 the per-lb conversion survives grounding and is shown with its working',
        (d3.assumed || []).some((a) => /\$0\.42\/lb/.test(a) && /925\.94\/MT/.test(a)),
        JSON.stringify(d3.assumed));

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})();
