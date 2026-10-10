// ── tests/price-units.js ──────────────────────────────────────────────────
// Apsara, 2026-10-10: "in edge yard app,in addition to lbs-MT-Item can be
// /piece as well. and gross ton and net ton as well."
//
// Three things this file is for, in order of how expensive they are to get
// wrong:
//
//   1 NET TON IS NOT GROSS TON. 2,000 lb against 2,240 — twelve per cent,
//     and in conversation both are "a ton". A row priced at $300/net ton
//     booked as gross ton is $300 x 20.79 instead of $300 x 23.28 on a
//     46,560 lb load: $890 wrong, in her favour on the buy side, which is
//     the direction nobody questions.
//
//   2 AN UNKNOWN UNIT MUST NOT BECOME POUNDS. This is the $15m bug's shape
//     (2026-10-09: renderItemRows multiplied pounds by a per-tonne price
//     because it was the one copy that had never heard of units). A /piece
//     row falling through to the pound branch prices 46,560 lb at $5 a
//     piece as $232,800.
//
//   3 THE FOUR COPIES MUST AGREE. The arithmetic existed in four places and
//     now reads one table — but the two clients cannot require a module, so
//     they carry it inline. Section E reads their HTML and compares the
//     numbers, because "same constant, deliberately" in a comment is a
//     promise and not a check. That exact comment was in both clients while
//     one of them was wrong.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const PU = require(path.join(ROOT, 'helpers/priceUnits'));

// ── A — THE DIVISORS ─────────────────────────────────────────────────────
{
    section('A — what a ton means, and which ton');
    ck('a pound is a pound', PU.LB_PER.lb === 1);
    ck('a net ton is 2,000 lb — the short ton, the US one', PU.LB_PER.nt === 2000, String(PU.LB_PER.nt));
    ck('a gross ton is 2,240 lb — the long ton, the UK one', PU.LB_PER.gt === 2240, String(PU.LB_PER.gt));
    ck('and they are NOT the same number', PU.LB_PER.nt !== PU.LB_PER.gt);
    ck('  12% apart, which is why they are separate codes',
       Math.abs(PU.LB_PER.gt / PU.LB_PER.nt - 1.12) < 0.001,
       String(PU.LB_PER.gt / PU.LB_PER.nt));

    // ── 2204.62, NOT 2204.62262 ──────────────────────────────────────────
    // I reached for the longer figure first. It is what helpers/bills.js
    // uses — and bills.js is the EDGE METALS invoice side, a different
    // company. All four yard copies already agreed on 2204.62, so the
    // longer one would have moved every /MT amount on every yard load by a
    // few cents on its next recompute, shown up as the nightly sheet sync
    // reporting disagreements she did not cause, and been indistinguishable
    // from a rounding bug six months later.
    ck('a tonne is 2204.62 — the yard\'s own figure, not the invoice side\'s',
       PU.LB_PER.mt === 2204.62, String(PU.LB_PER.mt));
    const bills = fs.readFileSync(path.join(ROOT, 'helpers/bills.js'), 'utf8');
    ck('  and Edge Metals keeps its longer one, untouched',
       /LB_PER_MT = 2204\.62262/.test(bills));

    ck('a piece is not a weight at all', PU.LB_PER.piece === null);
    ck('  and says so', PU.isCounted('piece') === true && PU.isCounted('lb') === false);
    ck('pounds is first in the order, because it is the default',
       PU.ORDER[0] === 'lb', JSON.stringify(PU.ORDER));
    ck('all five are offered', PU.ORDER.length === 5, JSON.stringify(PU.ORDER));
    ck('every one has a label she would recognise',
       PU.ORDER.every((u) => /^\/\S/.test(PU.LABEL[u])), JSON.stringify(PU.LABEL));
    ck('  and the two tons are spelled out, never just "ton"',
       PU.LABEL.nt === '/net ton' && PU.LABEL.gt === '/gross ton',
       `${PU.LABEL.nt} ${PU.LABEL.gt}`);
}

// ── B — AN EMPTY UNIT IS POUNDS, AND THAT IS A FACT ABOUT HER DATA ───────
// Every row entered before 2026-09-24 has no unit on it and they are all
// pound rows. That is what makes every load already on file safe.
{
    section('B — the rows already on file');
    ck('an empty unit is pounds', PU.normalise('') === 'lb');
    ck('  so is null, and undefined', PU.normalise(null) === 'lb' && PU.normalise(undefined) === 'lb');
    ck('  and it divides by one, so a historic row is arithmetically untouched',
       PU.qtyFor({ unit: '', net: 46560 }) === 46560);
    ck('  exactly as an explicit lb row does',
       PU.qtyFor({ unit: 'lb', net: 46560 }) === 46560);
    ck('case and spacing do not matter', PU.normalise('  MT ') === 'mt');
    ck('the spellings a human would type are tolerated',
       PU.normalise('lbs') === 'lb' && PU.normalise('net ton') === 'nt'
       && PU.normalise('long ton') === 'gt' && PU.normalise('pcs') === 'piece',
       JSON.stringify(['lbs', 'net ton', 'long ton', 'pcs'].map(PU.normalise)));
    // Short ton / long ton are the names a scale ticket or a broker uses.
    ck('  including short ton and long ton, which is what a ticket says',
       PU.normalise('short ton') === 'nt' && PU.normalise('lt') === 'gt');
}

// ── C — THE REFUSAL THAT IS THE WHOLE POINT ──────────────────────────────
{
    section('C — an unknown unit is an error, never pounds');
    let threw = null;
    try { PU.qtyFor({ unit: 'bushel', net: 46560 }); } catch (e) { threw = e; }
    ck('an unrecognised unit THROWS', !!threw, String(threw));
    ck('  naming what it does take', /\/lb/.test(String(threw && threw.message))
       && /\/net ton/.test(String(threw && threw.message)), String(threw && threw.message));
    ck('  and it is not reported as a known unit', PU.isKnown('bushel') === false);
    // The number that would have been produced if it fell through, so the
    // cost of the bug is in the test rather than only in the comment.
    ck('  it does NOT quietly answer 46,560', (() => {
        try { return PU.qtyFor({ unit: 'bushel', net: 46560 }) !== 46560; }
        catch (e) { return true; }
    })());
}

// ── D — THE ARITHMETIC, ON A LOAD SHE WOULD RECOGNISE ────────────────────
// 46,560 lb net, the figure from the invoice bug of 2026-09-24.
{
    section('D — 46,560 lb, priced five ways');
    const net = 46560;
    const q = (unit) => PU.qtyFor({ unit, net });
    ck('per pound, the quantity is the net itself', q('lb') === 46560);
    ck('per net ton, 23.28', Math.abs(q('nt') - 23.28) < 0.0001, String(q('nt')));
    ck('per gross ton, 20.7857…', Math.abs(q('gt') - 20.785714) < 0.0001, String(q('gt')));
    // 21.119285…, which is 46,560 / 2204.62. I first wrote 21.119776 here —
    // the answer for 2204.62262, the Edge Metals constant. The arithmetic
    // caught me reaching for the wrong company's figure a second time, which
    // is the whole argument for pinning the number in a test.
    ck('per tonne, 21.11928…', Math.abs(q('mt') - 21.119286) < 0.0001, String(q('mt')));

    // ── AND THE 12% THAT SEPARATES THE TWO TONS, IN MONEY ────────────────
    const atNt = PU.amountFor({ unit: 'nt', net, price: 300 });
    const atGt = PU.amountFor({ unit: 'gt', net, price: 300 });
    ck('at $300 a net ton that is $6,984.00', atNt === 6984, String(atNt));
    ck('at $300 a gross ton it is $6,235.71', atGt === 6235.71, String(atGt));
    ck('  so confusing the two tons costs $748.29 on one row',
       Math.abs((atNt - atGt) - 748.29) < 0.005, String(atNt - atGt));

    ck('the net is NEVER converted — only the quantity changes',
       PU.qtyFor({ unit: 'mt', net }) !== net && net === 46560);
    ck('a missing net gives no quantity, not zero',
       PU.qtyFor({ unit: 'mt', net: null }) === null);
    ck('  and no amount', PU.amountFor({ unit: 'mt', net: null, price: 5 }) === null);
    ck('a missing price gives no amount',
       PU.amountFor({ unit: 'lb', net, price: null }) === null);

    // ── PIECES ───────────────────────────────────────────────────────────
    ck('a piece row multiplies the COUNT, not the weight',
       PU.qtyFor({ unit: 'piece', net, pieces: 12 }) === 12);
    ck('  so 12 pieces at $5 is $60, not $232,800',
       PU.amountFor({ unit: 'piece', net, pieces: 12, price: 5 }) === 60,
       String(PU.amountFor({ unit: 'piece', net, pieces: 12, price: 5 })));
    ck('a piece row with no count yet has no amount — it is not zero',
       PU.amountFor({ unit: 'piece', net, pieces: null, price: 5 }) === null);
    // Zero is a real answer (nothing was delivered) and must not read as
    // "she has not typed it".
    ck('  but a count of ZERO is a real answer, and gives zero',
       PU.amountFor({ unit: 'piece', net, pieces: 0, price: 5 }) === 0,
       String(PU.amountFor({ unit: 'piece', net, pieces: 0, price: 5 })));
    ck('a negative count is neither', PU.qtyFor({ unit: 'piece', pieces: -3 }) === null);
    // A stray pieces value on a weight row must change nothing, or editing a
    // row from /piece back to /lb would keep pricing by the count.
    ck('pieces is IGNORED on a weight row',
       PU.amountFor({ unit: 'lb', net: 100, pieces: 9999, price: 2 }) === 200,
       String(PU.amountFor({ unit: 'lb', net: 100, pieces: 9999, price: 2 })));
}

// ── E — THE FOUR COPIES AGREE ────────────────────────────────────────────
// The clients cannot require a module. So they carry the table inline, and
// this is what stops them drifting — the failure that produced the $15m
// figure was one copy not knowing what the others knew.
{
    section('E — the clients carry the same numbers');
    const app = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    const web = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');

    // Each client declares its table as LB_PER_UNIT = { ... }. Parsed rather
    // than eyeballed, so adding a sixth unit to the module and forgetting a
    // client is a red test and not a wrong invoice.
    const tableOf = (html, who) => {
        const m = html.match(/LB_PER_UNIT\s*=\s*\{([^}]*)\}/);
        if (!m) return null;
        const out = {};
        for (const part of m[1].split(',')) {
            const kv = part.match(/([a-z]+)\s*:\s*(null|[\d.]+)/);
            if (kv) out[kv[1]] = kv[2] === 'null' ? null : Number(kv[2]);
        }
        return out;
    };
    const appT = tableOf(app, 'app');
    const webT = tableOf(web, 'web');
    ck('the Edge Yard app declares a unit table', !!appT, JSON.stringify(appT));
    ck('the website declares one too', !!webT, JSON.stringify(webT));
    ck('the app matches helpers/priceUnits.js exactly',
       JSON.stringify(appT) === JSON.stringify(PU.LB_PER),
       `${JSON.stringify(appT)} vs ${JSON.stringify(PU.LB_PER)}`);
    ck('the website matches it exactly',
       JSON.stringify(webT) === JSON.stringify(PU.LB_PER),
       `${JSON.stringify(webT)} vs ${JSON.stringify(PU.LB_PER)}`);

    // ── NO LOOSE 2204.62 LEFT IN THE ITEM MATH ───────────────────────────
    // A hard-coded divisor beside a table is the drift, back again.
    for (const [who, html] of [['app', app], ['website', web]]) {
        const itemMath = (html.match(/perMt[^\n]*\n[^\n]*\n/g) || []).join('\n');
        ck(`the ${who} no longer divides by a literal in the item math`,
           !/\/\s*2204\.62/.test(itemMath), itemMath.slice(0, 200));
    }
}

// ── F — HER CALL: THE WEBSITE DISPLAYS THEM, BUT ONLY THE APP OFFERS ─────
// Asked whether the website should offer the new units too, she chose
// display-only. The server recomputes every row on save, so a website that
// could not READ 'nt' would show the pound figure until save and then jump —
// which is why display is not optional even though the picker is.
{
    section('F — display everywhere, picker in the app only');
    const app = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    const web = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    // Both pickers BUILD their options from an array now rather than listing
    // them as literal markup, so the array is what to read. My first version
    // of this check scanned for `<option value="...">` and went red on both
    // clients the moment they were generated — a check shaped like the old
    // code, which is CLAUDE.md §2's second failure shape.
    const optionsOf = (html) => {
        const m = html.match(/class="ld-item-unit"[\s\S]{0,1600}?<\/select>/);
        if (!m) return null;
        // The source array feeding .map(), e.g. ['lb', 'nt', 'gt', 'mt', 'piece']
        const arr = m[0].match(/\[((?:\s*'[a-z]+'\s*,?)+)\]/);
        return arr ? arr[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean) : null;
    };
    const appOpts = optionsOf(app);
    const webOpts = optionsOf(web);
    ck('the app offers all five', !!appOpts && PU.ORDER.every((u) => appOpts.includes(u)),
       JSON.stringify(appOpts));
    ck('the website offers only lb and MT — her call',
       !!webOpts && webOpts.length === 2 && webOpts.includes('lb') && webOpts.includes('mt'),
       JSON.stringify(webOpts));
    ck('  but it can still COMPUTE a net ton, or it would show a wrong figure',
       /LB_PER_UNIT/.test(web) && /nt/.test((web.match(/LB_PER_UNIT\s*=\s*\{[^}]*\}/) || [''])[0]));
    ck('  and a Pieces box exists in the app', /ld-item-pieces/.test(app));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
