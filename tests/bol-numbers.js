// ── tests/bol-numbers.js ──────────────────────────────────────────────────
// Apsara, 2026-09-16: "in bol,make bol number auto generate/customerbasis in
// sequence" and, on the shape: "include year in bol number as in 26ECC001".
//
// ── WHY A NUMBERING SCHEME GETS ITS OWN SUITE ───────────────────────────────
// A BOL number is not a counter, it is an IDENTITY. It is what a driver, a
// broker and a buyer quote back, and helpers/bols.js upserts by bol_no — so
// two documents sharing a number do not sit beside each other in the list,
// the second REPLACES the first. Every check here is some version of "can
// this hand out a number twice".
//
// The three ways it could:
//   the counter is lost or restored from a backup and starts under numbers
//   that already exist (section B);
//   a BOL is deleted and its number is handed to the next document, which is
//   still in a buyer's inbox (section B);
//   two screens are open on one customer and both are shown the same
//   suggestion (section C).
//
// And the fourth thing, which is not about collisions at all: a number SHE
// typed must survive untouched. Her words, asked what should happen: "Yours
// wins, counter untouched".

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bolno-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const N = require(path.join(ROOT, 'helpers/bolNumbers'));
const writeBols = (rows) => fs.writeFileSync(cfg.BOLS_FILE, JSON.stringify(rows));

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the shape she asked for');
// ══════════════════════════════════════════════════════════════════════════
{
    writeBols([]);
    ck('26ECC001 for Eccomelt in 2026', await N.reserve('Eccomelt Inc', '2026-09-16') === '26ECC001');
    ck('  then 002', await N.reserve('Eccomelt Inc', '2026-09-16') === '26ECC002');
    ck('  a different customer starts at 001',
       await N.reserve('Taewon Automotive Co., Ltd', '2026-09-16') === '26TAE001',
       'one series per customer is the whole request');
    ck('  and Eccomelt carries on from where IT was',
       await N.reserve('Eccomelt Inc', '2026-09-16') === '26ECC003',
       'a shared counter would make the numbers say nothing about whose they are');
    ck('a new year restarts the series',
       await N.reserve('Eccomelt Inc', '2027-01-05') === '27ECC001',
       'the year is in the number precisely so it can');
    ck('  without disturbing this year',
       await N.reserve('Eccomelt Inc', '2026-12-31') === '26ECC004');

    // ── THE CODE ─────────────────────────────────────────────────────────
    // From the first word that carries letters, skipping company suffixes: a
    // code that changes when she types "Inc" splits one customer's series in
    // two, and nothing would tell her it had happened.
    ck('the code ignores Inc / LLC / Ltd',
       N.codeFor('Eccomelt') === 'ECC' && N.codeFor('Eccomelt Inc') === 'ECC'
       && N.codeFor('Eccomelt, LLC') === 'ECC',
       [N.codeFor('Eccomelt'), N.codeFor('Eccomelt Inc'), N.codeFor('Eccomelt, LLC')].join(','));
    ck('  and leading "The"', N.codeFor('The Metal Company') === 'MET', N.codeFor('The Metal Company'));
    ck('  a short name is padded, not left short',
       N.codeFor('BM Metals') === 'BMX', N.codeFor('BM Metals') + ' — 26BM001 reads as a different format');
    ck('  a name with no letters falls back visibly',
       N.codeFor('') === 'CUS' && N.codeFor('   ') === 'CUS',
       'CUS is ugly on purpose: it says fix the name, rather than quietly filing three customers together');
    ck('  case and punctuation do not make a second series',
       N.codeFor('eccomelt inc.') === N.codeFor('ECCOMELT INC'),
       'she types the name freehand every time');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — it cannot reissue a number');
// ══════════════════════════════════════════════════════════════════════════
{
    // ── A DELETED BOL DOES NOT GIVE ITS NUMBER BACK ──────────────────────
    // The document is deleted here; it is not deleted from the buyer's inbox.
    fs.writeFileSync(cfg.BOL_COUNTERS_FILE, JSON.stringify({}));
    writeBols([{ bol_no: '26DEL001' }, { bol_no: '26DEL002' }, { bol_no: '26DEL003' }]);
    ck('a series with three on file continues at 004',
       await N.reserve('Delta Metals', '2026-06-01') === '26DEL004',
       'the counter was empty — derived numbering would have said 001');

    writeBols([{ bol_no: '26DEL001' }, { bol_no: '26DEL002' }]);  // 003 deleted
    ck('  deleting the newest does NOT hand 003 back',
       await N.reserve('Delta Metals', '2026-06-01') === '26DEL005',
       'the stored counter is what makes this true; the file no longer knows 003 or 004 existed');

    // ── A COUNTER RESTORED FROM AN OLDER BACKUP ──────────────────────────
    // The counter file is small and is the sort of thing that gets rolled
    // back. On its own it would start handing out numbers that exist.
    fs.writeFileSync(cfg.BOL_COUNTERS_FILE, JSON.stringify({ '26ROL': 2 }));
    writeBols([{ bol_no: '26ROL001' }, { bol_no: '26ROL002' }, { bol_no: '26ROL003' },
               { bol_no: '26ROL004' }]);
    ck('a stale counter is floored by what is on file',
       await N.reserve('Rolled Steel', '2026-06-01') === '26ROL005',
       'the counter said 3 was next; three documents already say otherwise');

    // ── A GAP IN THE MIDDLE IS NOT FILLED IN ─────────────────────────────
    // 002 is missing — deleted, or never issued. The next number is 004, not
    // 002: a series with a hole in it is a filing question, a reused number is
    // a replaced document.
    fs.writeFileSync(cfg.BOL_COUNTERS_FILE, JSON.stringify({ '26GAP': 0 }));
    writeBols([{ bol_no: '26GAP001' }, { bol_no: '26GAP003' }]);
    const g = await N.reserve('Gap Metals', '2026-06-01');
    ck('a hole in the middle is left alone', g === '26GAP004', g);

    // HONEST NOTE ON THE taken-set CHECK in reserve(): mutating it away breaks
    // nothing in this file, and that is correct rather than a missing test.
    // highestOnFile() is the MAXIMUM parsed sequence on file, so the floor
    // already sits above every existing number and the skip loop cannot be
    // reached through any input. It is kept as a second lock on the one thing
    // that must never happen, not as live logic — and this comment is here so
    // the next person does not spend an afternoon writing a case for it.
    ck('  the floor is what makes that true', N.highestOnFile('26', 'GAP') === 3,
       String(N.highestOnFile('26', 'GAP')));

    // Numbers in her OLD shape are not part of any series and must not be
    // parsed as one.
    ck('EM-1047 is not read as a sequence', N.parse('EM-1047') === null);
    ck('  nor is a bare number', N.parse('1047') === null,
       'every BOL she has issued so far was typed by hand, in another shape');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — suggesting is not reserving');
// ══════════════════════════════════════════════════════════════════════════
{
    fs.writeFileSync(cfg.BOL_COUNTERS_FILE, JSON.stringify({}));
    writeBols([]);
    // The form asks for a suggestion every time she picks a consignee. If
    // that consumed a number, a morning of changing her mind would leave a
    // series full of gaps a buyer can see.
    const a = N.suggest('Suggest Co', '2026-06-01');
    const b = N.suggest('Suggest Co', '2026-06-01');
    ck('two suggestions in a row are the same number', a === b && a === '26SUG001', `${a} / ${b}`);
    ck('  and nothing was written', !fs.existsSync(cfg.BOL_COUNTERS_FILE)
       || !Object.keys(JSON.parse(fs.readFileSync(cfg.BOL_COUNTERS_FILE, 'utf8'))).includes('26SUG'),
       'opening a screen must not spend a document number');

    // Two screens open on one customer see the same suggestion — and only one
    // of them can have it. This is the case where a silent overwrite would
    // happen, because helpers/bols.js upserts by bol_no.
    const first = await N.reserve('Suggest Co', '2026-06-01');
    const second = await N.reserve('Suggest Co', '2026-06-01');
    ck('but two reservations are different numbers', first !== second, `${first} / ${second}`);
    ck('  in order', first === '26SUG001' && second === '26SUG002', `${first} / ${second}`);

    // Concurrency: mutateJson holds the file lock, so ten at once are ten
    // distinct numbers rather than ten copies of the same one.
    const many = await Promise.all(Array.from({ length: 10 }, () => N.reserve('Race Metals', '2026-06-01')));
    ck('ten at once are ten different numbers', new Set(many).size === 10, many.join(','));
    ck('  and contiguous', many.slice().sort().join(',') ===
       Array.from({ length: 10 }, (_, i) => `26RAC${String(i + 1).padStart(3, '0')}`).join(','),
       many.slice().sort().join(','));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a number she typed is hers');
// ══════════════════════════════════════════════════════════════════════════
{
    // Apsara, asked what happens when she types over the suggestion: "Yours
    // wins, counter untouched."
    fs.writeFileSync(cfg.BOL_COUNTERS_FILE, JSON.stringify({}));
    writeBols([]);
    await N.reserve('Manual Metals', '2026-06-01');          // 26MAN001
    ck('a number in another shape does not move the counter',
       (await N.noteUsed('EM-1047')) === false,
       'her old numbering is not this series');
    ck('  and the next automatic one is unaffected',
       await N.reserve('Manual Metals', '2026-06-01') === '26MAN002');

    // The one exception, and why: a number she typed that IS in this series
    // and ahead of the counter would otherwise be suggested again later, and
    // accepting that suggestion would REPLACE the document she typed it on.
    await N.noteUsed('26MAN050');
    ck('a typed number inside the series drags the counter past it',
       await N.reserve('Manual Metals', '2026-06-01') === '26MAN051',
       'otherwise 050 is suggested again and the upsert replaces her document');
    ck('  but one BEHIND the counter changes nothing',
       (await N.noteUsed('26MAN002')) === false
       && await N.reserve('Manual Metals', '2026-06-01') === '26MAN052');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the year comes off the document');
// ══════════════════════════════════════════════════════════════════════════
{
    // A BOL back-dated to December belongs in that year's series, not in the
    // one we happen to be standing in.
    ck('the BOL date decides the year', N.yearOf('2025-12-31') === '25', N.yearOf('2025-12-31'));
    // toISOString() is UTC and is already tomorrow after 5pm in Frisco — on a
    // 31 December that files the document under the wrong YEAR. Same bug this
    // project fixed on the BOL date itself.
    const local = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(2, 4);
    ck('  and a blank date uses the yard\'s year, not UTC\'s', N.yearOf('') === local,
       `${N.yearOf('')} vs ${local}`);
    ck('  garbage does not produce NaN in a document number',
       /^\d\d$/.test(N.yearOf('not a date')), N.yearOf('not a date'));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
