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
function decide(file, by_source, sources) {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/const note = \$\('pay_cash_empty'\);\s*if \(note\) \{([\s\S]*?)\n(\s*)\}\n/);
    if (!m) return { error: 'the pay_cash_empty block was not found — if it moved, fix this test rather than deleting it' };
    let hidden = null;
    const note = { classList: { toggle: (_c, on) => { hidden = on; } } };
    const pettyCash = { by_source, sources };
    const srcs = (pettyCash.sources || []).length ? pettyCash.sources
        : ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'];
    const held = (x) => Number((pettyCash.by_source || {})[x]) || 0;
    try {
        // eslint-disable-next-line no-new-func
        new Function('note', 'pettyCash', 'srcs', 'held', m[1])(note, pettyCash, srcs, held);
    } catch (e) {
        return { error: 'THREW: ' + e.message };
    }
    // toggle(cls, true) HIDES. So the note is shown when hidden === false.
    return { shown: hidden === false, hidden };
}

const SOURCES = ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'];
const zeros = { 'Edge Metals': 0, 'AAA Investment': 0, 'Chase Bank': 0, Unassigned: 0 };

// ══════════════════════════════════════════════════════════════════════════
section('A — her screen: every bucket zero');
for (const [who, file] of Object.entries(CLIENTS)) {
    const r = decide(file, zeros, SOURCES);
    ck(`${who}: the block was found and ran`, !r.error, r.error);
    ck(`${who}: the note IS shown`, r.shown === true,
       'this is exactly what she was looking at — four zeros and no explanation');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — and stays quiet when there is money');
for (const [who, file] of Object.entries(CLIENTS)) {
    ck(`${who}: money in one account hides it`,
       decide(file, { ...zeros, 'Edge Metals': 500 }, SOURCES).shown === false);
    // A single empty bucket is ordinary — the borrow prompt covers that, and
    // warning here would fire on a normal day.
    ck(`${who}: one empty bucket among several is NOT a warning`,
       decide(file, { 'Edge Metals': 1200, 'AAA Investment': 0, 'Chase Bank': 300, Unassigned: 0 }, SOURCES).shown === false,
       'this fires on an ordinary day and the message stops being read');
    ck(`${who}: a tiny balance still counts as money`,
       decide(file, { ...zeros, Unassigned: 0.01 }, SOURCES).shown === false);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — NOT YET LOADED IS NOT EMPTY');
// The false alarm that would train her to ignore this line.
for (const [who, file] of Object.entries(CLIENTS)) {
    ck(`${who}: no by_source at all -> no claim`,
       decide(file, undefined, SOURCES).shown === false,
       'claiming "there is no cash" while the figures are loading is a lie that clears itself');
    ck(`${who}: null by_source -> no claim`, decide(file, null, SOURCES).shown === false);
    // An empty object IS an answer: the server replied and nothing is held.
    ck(`${who}: an empty by_source object IS an answer, and shows the note`,
       decide(file, {}, SOURCES).shown === true,
       'every account reading 0 is the same situation however the server spelled it');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the sentence names what to do');
for (const [who, file] of Object.entries(CLIENTS)) {
    const src = fs.readFileSync(file, 'utf8');
    const block = src.slice(src.indexOf('id="pay_cash_empty"'), src.indexOf('id="pay_cash_empty"') + 600);
    ck(`${who}: it says where to add cash`, /Petty cash/.test(block),
       'a warning with no next step is just bad news');
    ck(`${who}: and that another mode is available`, /another mode/i.test(block),
       'she may need to pay this supplier today, and the box being empty is not a reason she cannot');
    ck(`${who}: it starts hidden`, /id="pay_cash_empty" class="hidden"/.test(src),
       'visible-by-default would show it for the instant before the figures arrive');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
