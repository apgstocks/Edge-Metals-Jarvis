// ── tests/pay-cash-empty-note.js ──────────────────────────────────────────
// Apsara, 2026-09-29, on the Pay modal of a yard load:
//
//   "In load pay,for one of the load,when i click cash and choose bank-it
//    has every thing as 0.Bofa ,chase,AAA,unassigned as 0."
//
// Then, 2026-10-01: "it was all showing 0 na.did you fix".
//
// ── WHAT WAS AND WAS NOT WRONG ────────────────────────────────────────────
// The dropdowns were doing their job: listing each account with what it
// holds. What they held was nothing. The server already refuses this with a
// sentence that names the fix — "There is no petty cash to pay from. Add cash
// on the Petty cash tab first." — but only AFTER she has picked a bank, typed
// an amount and pressed Pay. So the screen knew the answer and declined to
// give it until she had done the work.
//
// That is the part I can fix from here. Whether her live box is genuinely
// empty, or holds money under the pre-split 'BofA' name that the migration
// has not yet moved, is a question about HER DATA and only
// scripts/migrate-bofa-to-edge-metals.js --dry-run on the VM can answer it.
// This note is correct either way: if the named buckets really do sum to
// zero, a cash payment has nothing to draw on, whatever the reason.
//
// ── WHY THE "STILL LOADING" CASE IS THE ONE THAT MATTERS ──────────────────
// by_source arrives from the server. If "no figures yet" were treated as
// "no cash", the warning would flash on every open and clear a moment later
// — a false alarm that teaches her to ignore the one message on this screen
// that is worth reading. Section C is that case.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const CLIENTS = {
    website: path.join(ROOT, 'dashboard/index.html'),
    app: path.join(ROOT, 'mobile-app/www/index.html'),
};

// ── THE REAL DECISION, LIFTED OUT AND RUN ─────────────────────────────────
// Not a regex over the source. The block is extracted from each client and
// executed, so a change to its LOGIC fails this file even when the words
// around it still look right. The shape it needs is tiny: srcs, held() and
// a note object with classList.toggle.
function decide(file, by_source, sources, balance) {
    const src = fs.readFileSync(file, 'utf8');
    // ── BRACE-BALANCED, NOT REGEX-TO-THE-FIRST-BRACE ──────────────────────
    // The first version matched lazily up to the next `}`, which worked only
    // while the block had no nested braces. The moment it grew an if/else it
    // was being cut mid-expression and every check in this file failed with
    // "Unexpected token )" — a test broken by the code getting MORE correct.
    const start = src.indexOf("const note = $('pay_cash_empty');");
    if (start < 0) return { error: 'the pay_cash_empty block was not found — if it moved, fix this test rather than deleting it' };
    const bodyAt = src.indexOf('{', src.indexOf('if (note)', start));
    let depth = 0, end = -1;
    for (let i = bodyAt; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return { error: 'the pay_cash_empty block never closes' };
    const m = [null, src.slice(bodyAt + 1, end)];
    let hidden = null;
    let html = '';
    const note = {
        classList: { toggle: (_c, on) => { hidden = on; } },
        set innerHTML(v) { html = v; },
        get innerHTML() { return html; },
    };
    const pettyCash = { by_source, sources, balance };
    const srcs = (pettyCash.sources || []).length ? pettyCash.sources
        : ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'];
    const held = (x) => Number((pettyCash.by_source || {})[x]) || 0;
    try {
        // eslint-disable-next-line no-new-func
        const esc = (x) => String(x == null ? '' : x)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const fmtAmount = (n) => '$' + (Number(n) || 0).toFixed(2);
        new Function('note', 'pettyCash', 'srcs', 'held', 'esc', 'fmtAmount', m[1])
            (note, pettyCash, srcs, held, esc, fmtAmount);
    } catch (e) {
        return { error: 'THREW: ' + e.message };
    }
    // toggle(cls, true) HIDES. So the note is shown when hidden === false.
    return { shown: hidden === false, hidden, html };
}

const SOURCES = ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'];
const zeros = { 'Edge Metals': 0, 'AAA Investment': 0, 'Chase Bank': 0, Unassigned: 0 };

// ══════════════════════════════════════════════════════════════════════════
section('A — her screen: every bucket zero');
for (const [who, file] of Object.entries(CLIENTS)) {
    const r = decide(file, zeros, SOURCES, 0);
    ck(`${who}: the block was found and ran`, !r.error, r.error);
    ck(`${who}: the note IS shown`, r.shown === true,
       'this is exactly what she was looking at — four zeros and no explanation');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — and stays quiet when there is money');
for (const [who, file] of Object.entries(CLIENTS)) {
    ck(`${who}: money in one account hides it`,
       decide(file, { ...zeros, 'Edge Metals': 500 }, SOURCES, 500).shown === false);
    // A single empty bucket is ordinary — the borrow prompt covers that, and
    // warning here would fire on a normal day.
    ck(`${who}: one empty bucket among several is NOT a warning`,
       decide(file, { 'Edge Metals': 1200, 'AAA Investment': 0, 'Chase Bank': 300, Unassigned: 0 }, SOURCES, 1500).shown === false,
       'this fires on an ordinary day and the message stops being read');
    ck(`${who}: a tiny balance still counts as money`,
       decide(file, { ...zeros, Unassigned: 0.01 }, SOURCES, 0.01).shown === false);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — NOT YET LOADED IS NOT EMPTY');
// The false alarm that would train her to ignore this line.
for (const [who, file] of Object.entries(CLIENTS)) {
    ck(`${who}: no by_source at all -> no claim`,
       decide(file, undefined, SOURCES, 0).shown === false,
       'claiming "there is no cash" while the figures are loading is a lie that clears itself');
    ck(`${who}: null by_source -> no claim`, decide(file, null, SOURCES, 0).shown === false);
    // An empty object IS an answer: the server replied and nothing is held.
    ck(`${who}: an empty by_source object IS an answer, and shows the note`,
       decide(file, {}, SOURCES, 0).shown === true,
       'every account reading 0 is the same situation however the server spelled it');
}

// ══════════════════════════════════════════════════════════════════════════
section('C2 — HER ACTUAL CASE: cash present, every listed bucket zero');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-10-01: "Also check why it was all showiung 0 when i have
// available petty cash."
//
// This is the case the first version of this feature got WRONG. Her rows are
// filed under 'BofA' — the pre-split name — which balanceBySource keeps and
// counts, and which petty.balance() includes. The picker lists SOURCES only,
// so her money is in the payload and every bucket above reads zero.
//
// The first note said "There is no cash recorded in any account yet". That
// is a FALSEHOOD printed on her screen, and worse than the four zeros it
// replaced, because it would have sent her to add a float she already has.
{
    const legacy = { ...zeros, BofA: 4200 };
    for (const [who, file] of Object.entries(CLIENTS)) {
        const r = decide(file, legacy, SOURCES, 4200);
        ck(`${who}: the note is shown`, r.shown === true);
        ck(`${who}: it does NOT claim there is no cash`, !/no cash recorded/i.test(r.html),
           `said: ${r.html}`);
        ck(`${who}: it names where the money actually is`, /BofA/.test(r.html),
           `said: ${r.html}`);
        ck(`${who}: and says how much`, /4200\.00/.test(r.html), `said: ${r.html}`);
        ck(`${who}: and says it is not lost`, /not lost/i.test(r.html));
        ck(`${who}: and offers a way to pay today`, /another mode/i.test(r.html));
    }
    // Genuinely empty must still say the other thing — one message for both
    // situations is how a true sentence becomes a false one.
    for (const [who, file] of Object.entries(CLIENTS)) {
        const r = decide(file, zeros, SOURCES, 0);
        ck(`${who}: a genuinely empty box still says so`, /no cash recorded/i.test(r.html),
           `said: ${r.html}`);
        ck(`${who}:   and does not invent a stranded bucket`, !/filed under/i.test(r.html));
    }
    // Money on the list AND money off it: the list works, so no note.
    for (const [who, file] of Object.entries(CLIENTS)) {
        const r = decide(file, { ...zeros, 'Edge Metals': 100, BofA: 900 }, SOURCES, 1000);
        ck(`${who}: no note when the listed accounts can pay`, r.shown === false);
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the sentence names what to do');
for (const [who, file] of Object.entries(CLIENTS)) {
    const src = fs.readFileSync(file, 'utf8');
    // The words now come from JS, because which sentence is true depends on
    // which situation she is in. So they are checked on the OUTPUT.
    const empty = decide(file, zeros, SOURCES, 0);
    const strand = decide(file, { ...zeros, BofA: 50 }, SOURCES, 50);
    ck(`${who}: the empty message says where to add cash`, /Petty cash/.test(empty.html),
       'a warning with no next step is just bad news');
    ck(`${who}: the stranded message does too`, /Petty cash/.test(strand.html));
    ck(`${who}: both offer another mode`,
       /another mode/i.test(empty.html) && /another mode/i.test(strand.html),
       'she may need to pay this supplier today');
    ck(`${who}: the element starts hidden and EMPTY`,
       /id="pay_cash_empty" class="hidden"[^>]*><\/div>/.test(src),
       'hard-coded copy in the markup is one of the two sentences shown unconditionally');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
