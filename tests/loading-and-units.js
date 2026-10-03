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

// Stubbed BEFORE proformaFromEmail loads: it destructures callGeminiJSON at
// require time, so a later assignment is invisible to it. This exists so the
// note scrub can be tested THROUGH extractOrderFromEmail -- reverse
// verification showed that calling scrubCommissionNote directly proves the
// function works and not that it is wired in, the same gap that hid half the
// rate_basis bug this morning.
const gem = require(R('helpers/gemini.js'));
let AI_ORDER = null;
gem.callGeminiJSON = async (_p, _n, schema) => {
    if (!AI_ORDER) throw new Error('no stubbed order set');
    return schema && schema.parse ? schema.parse(AI_ORDER) : AI_ORDER;
};

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

    section('LD — "5c" is five CONTAINERS, and a silent default is a price error');
    // THE WORST SHAPE A BUG CAN HAVE HERE. Her real mail:
    //   "Daekwang confirmed 5c of Auto casting tense at $2,520 CIF Busan
    //    (10c for Mr.Kim and 10c for Hynos included)"
    // was extracted as qty 5 TONNES, container_count null -- and the draft came
    // back needs: [], nothing assumed, nothing unconfirmed. CLEAN. Five
    // containers of material priced at $12,600 instead of about $276,000.
    const { containerCountFromText } = require(R('helpers/proformaFromEmail.js'));
    ck('LD1 "5c of Auto casting tense" is five containers',
        containerCountFromText('Daekwang confirmed 5c of Auto casting tense at $2,520 CIF Busan') === 5,
        String(containerCountFromText('Daekwang confirmed 5c of Auto casting tense at $2,520 CIF Busan')));
    ck('LD2 "10c for Mr.Kim" is a COMMISSION, not ten containers',
        containerCountFromText('at $2,520 CIF Busan (10c for Mr.Kim and 10c for Hynos included)') === null,
        String(containerCountFromText('at $2,520 CIF Busan (10c for Mr.Kim and 10c for Hynos included)')));
    ck('LD3 the real email, both idioms together, resolves to 5',
        containerCountFromText('Daekwang confirmed 5c of Auto casting tense at $2,520 CIF Busan (10c for Mr.Kim and 10c for Hynos included)') === 5,
        String(containerCountFromText('Daekwang confirmed 5c of Auto casting tense at $2,520 CIF Busan (10c for Mr.Kim and 10c for Hynos included)')));
    ck('LD4 "2 containers" spelled out still reads',
        containerCountFromText('confirmed 2 containers of auto casting tense') === 2);
    ck('LD5 two DIFFERENT counts means a human decides, not a guess',
        containerCountFromText('3c of auto cast and 7c of al combo') === null);
    ck('LD6 a bare sentence yields no count', containerCountFromText('Please send the proforma today') === null);

    // The multiplier must never default in silence: containerCount multiplies
    // the whole total.
    const noCount = toProformaDraft(await groundRates({ consignee: 'Daekwang', container_count: null,
        items: [{ desc: 'Auto cast', qty: null, rate: 2270, rate_confidence: 0.9, rate_basis: 'per_mt' }] }), {});
    ck('LD7 a defaulted container count is declared as an assumption',
        (noCount.assumed || []).some((a) => /1 container assumed/.test(a)), JSON.stringify(noCount.assumed));
    const withCount = toProformaDraft(await groundRates({ consignee: 'Daekwang', container_count: 5,
        items: [{ desc: 'Auto cast', qty: null, rate: 2270, rate_confidence: 0.9, rate_basis: 'per_mt' }] }), {});
    ck('LD8 a stated count carries no such assumption',
        !(withCount.assumed || []).some((a) => /container assumed/.test(a)), JSON.stringify(withCount.assumed));
    ck('LD9 and it multiplies the total', withCount.containerCount === 5);

    section('LE — one invoice is not history');
    // Splitting the bands by unit made some buckets tiny, and judgeRate then
    // printed "in line with the 1 past invoice(s)" -- a band of median*0.3 to
    // median*3 around a SINGLE point, confirming a figure against itself.
    // CHROME WHEELS has exactly TWO per-MT rows in the fixture ($2,650 and
    // $2,680 -- the other two chrome rows are per-pound purchases). $2,670
    // sits right between them, so a band built on two points would "confirm"
    // it. That is the circularity, and it must not be reported as evidence.
    // (The first version of this test asked about a material the fixture does
    // not contain at all, so it passed with the minimum disabled -- a fake
    // test, caught by reverse verification.)
    const thin = await rp.judgeRate('Chrome Wheels', 2670, 'per_mt');
    ck('LE1 two invoices are not enough to confirm a rate', !thin.confirmed,
        `confirmed = ${thin.confirmed}, reason = ${thin.reason}`);
    ck('LE1b and it says how thin the evidence is', /only 2 past/.test(thin.reason || ''), thin.reason);
    const thinLot = await rp.judgeRate('Chrome Wheels', 2670, 'per_lot');
    ck('LE2 and thin history does NOT promote per_lot to per_mt',
        thinLot.basis === 'per_lot', `basis = ${thinLot.basis}`);
    const thick = await rp.judgeRate('Al Wheels Dirty', 1.60, 'per_lb');
    ck('LE3 six per-pound purchases ARE enough', thick.confirmed === true,
        `confirmed = ${thick.confirmed}, reason = ${thick.reason}`);

    section('LF — commission is never deducted, itemised, or mentioned');
    // Apsara, 2026-10-03: "Do not include commission."
    //
    // VERIFIED AGAINST HER OWN INVOICES, not assumed from the instruction:
    // Joey confirms "$2,520 CIF Busan (10c for Mr.Kim and 10c for Hynos
    // included)" and she bills Joey/Daekwang Autocasting Tense at $2,520.00 --
    // five rows of it, the confirmed figure exactly. So "do not include"
    // means do not SHOW it and do not NET it out: the stated price stands.
    // That distinction was worth $20/MT, about $2,180 on her five-container
    // order, in either direction.
    const { scrubCommissionNote } = require(R('helpers/proformaFromEmail.js'));
    const gross = toProformaDraft(await groundRates({ consignee: 'Daekwang', container_count: 5,
        items: [{ desc: 'Auto cast', qty: null, rate: 2520, rate_confidence: 0.9, rate_basis: 'per_mt' }] }), {});
    ck('LF1 the stated price stands, not netted to 2500', gross.items[0].rate === 2520,
        `rate = ${gross.items[0].rate}`);
    ck('LF2 no commission line is added to the items', gross.items.length === 1
        && !/commission/i.test(JSON.stringify(gross.items)), JSON.stringify(gross.items));
    ck('LF3 a note that is ONLY about commission is dropped',
        scrubCommissionNote('The price includes $10 Mr.Kim and $10 Hynos commission.') === null);
    ck('LF4 and so is the wordier version the model actually produced',
        scrubCommissionNote('The email mentions commissions for Mr. Kim and Hynos included in the price, but these are not deducted from the stated rate.') === null);
    // The scrub must not become a way to lose a real warning.
    const realWarning = 'The $2,420 figure may be a lot total rather than a per-MT rate; commission is included.';
    ck('LF5 a note that ALSO raises a per-lot doubt survives intact',
        scrubCommissionNote(realWarning) === realWarning, JSON.stringify(scrubCommissionNote(realWarning)));
    ck('LF6 a note with nothing about commission is untouched',
        scrubCommissionNote('Two materials share one price — check which applies.')
            === 'Two materials share one price — check which applies.');
    // THROUGH the real entry point, not just the helper.
    const { extractOrderFromEmail } = require(R('helpers/proformaFromEmail.js'));
    AI_ORDER = { is_order: true, confidence: 0.9, consignee: 'Daekwang', container_count: 5,
        items: [{ desc: 'Auto casting tense', qty: null, rate: 2520, rate_confidence: 0.9, rate_basis: 'per_mt' }],
        missing: [], note: 'The price includes $10 Mr.Kim and $10 Hynos commission.' };
    const viaEntry = await extractOrderFromEmail({ from: 'Joey <joey@hynos.co.kr>',
        subject: 'Confirmation of auto casting tense', body: 'Daekwang confirmed 5c at $2,520 CIF Busan', date: null });
    ck('LF7 the scrub is WIRED IN — extractOrderFromEmail drops it too',
        viaEntry && viaEntry.note === null, `note = ${JSON.stringify(viaEntry && viaEntry.note)}`);
    ck('LF7b and the rate survives the same trip unchanged',
        viaEntry && viaEntry.items[0].rate === 2520, `rate = ${viaEntry && viaEntry.items[0].rate}`);
    AI_ORDER = { ...AI_ORDER, note: 'The $2,420 figure may be a lot total rather than a per-MT rate.' };
    const kept = await extractOrderFromEmail({ from: 'a@b.com', subject: 's', body: 'b', date: null });
    ck('LF7c a real warning still reaches her through the entry point',
        kept && /lot total/.test(kept.note || ''), JSON.stringify(kept && kept.note));
    AI_ORDER = null;

    ck('LF8 the prompt states the rule, with her invoice evidence',
        /Do not include commission/.test(require(R('helpers/proformaFromEmail.js')).buildOrderPrompt(
            { from: 'a@b.com', subject: 's', body: 'b', date: null })));

    section('LG — a quoted quantity is a WHOLE number: 21 normally, 22 on an L/C');
    // Apsara: "21.85 MT instead of that make it standard as 21 MT", then
    // "Unless it is an LC where we need to put 22 MT".
    //
    // A proforma is issued BEFORE loading, so 21.85 is false precision about a
    // weight nobody has weighed. DOWN by default, UP under a letter of credit:
    //   · On TT, quoting under what loads means the commercial invoice goes UP
    //     at shipment. Quoting over means it goes DOWN -- the version a buyer
    //     disputes.
    //   · Under an L/C the credit is drawn against the quantity on the
    //     document, so the nominal figure has to sit ABOVE the load.
    // Auto casting tense measures 21.85 here, which floors to 21 and ceils to
    // 22 -- her two numbers exactly. Her sheet carries 68 L/C rows against
    // 612 TT, so this is a real second case.
    const { isLcOrder } = require(R('helpers/proformaFromEmail.js'));
    const qtyFor = async (term) => {
        const d = toProformaDraft(await groundRates({ consignee: 'Daekwang', container_count: 5,
            payment_term: term,
            items: [{ desc: 'Auto casting tense', qty: null, rate: 2035, rate_confidence: 0.9, rate_basis: 'per_mt' }] }), {});
        return d.items[0].qty;
    };
    ck('LG1 TT terms give the round 21 MT, not 21.85', (await qtyFor('TT 7 days before ETA')) === 21,
        String(await qtyFor('TT 7 days before ETA')));
    ck('LG2 no stated terms also give 21 MT', (await qtyFor(null)) === 21);
    ck('LG3 "L/C at sight" gives 22 MT', (await qtyFor('L/C at sight')) === 22,
        String(await qtyFor('L/C at sight')));
    ck('LG4 bare "LC" gives 22 MT', (await qtyFor('LC')) === 22);
    ck('LG5 "letter of credit 60 days" gives 22 MT', (await qtyFor('letter of credit 60 days')) === 22);
    ck('LG6 the figure is always a whole number', Number.isInteger(await qtyFor('TT'))
        && Number.isInteger(await qtyFor('L/C')));
    // The read-back must show the BASIS, not just the rounded answer -- she
    // should be able to see that 21 came from a measured 21.85.
    const lcDraft = toProformaDraft(await groundRates({ consignee: 'D', container_count: 1,
        payment_term: 'L/C at sight',
        items: [{ desc: 'Auto casting tense', qty: null, rate: 2035, rate_confidence: 0.9, rate_basis: 'per_mt' }] }), {});
    ck('LG7 the L/C read-back says it is the L/C quantity and why',
        (lcDraft.assumed || []).some((a) => /standard L\/C quantity/.test(a) && /must sit above the load/.test(a)),
        JSON.stringify(lcDraft.assumed));
    ck('LG8 and it still shows the measured median behind it',
        (lcDraft.assumed || []).some((a) => /median 21\.88 MT across 3 past container/.test(a)),
        JSON.stringify(lcDraft.assumed));
    ck('LG9 isLcOrder does not fire on ordinary TT wording',
        !isLcOrder({ payment_term: 'TT 7 days before arrival' })
        && !isLcOrder({ payment_term: 'cash against documents' }) && !isLcOrder({}));
    // A quantity the EMAIL stated is never overwritten by either figure.
    const stated = toProformaDraft(await groundRates({ consignee: 'D', container_count: 1,
        payment_term: 'L/C at sight',
        items: [{ desc: 'Auto casting tense', qty: 19.5, rate: 2035, rate_confidence: 0.9, rate_basis: 'per_mt' }] }), {});
    ck('LG10 a stated tonnage wins over the standard, L/C or not', stated.items[0].qty === 19.5
        && !(stated.assumed || []).some((a) => /standard/.test(a)), `qty = ${stated.items[0].qty}`);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})();
