// ── tests/dead-helpers.js ─────────────────────────────────────────────────
// Guards the guard. scripts/check-dead-helpers.js exists because
// helpers/reconcile.js sat in this tree for a month with 41 green checks and
// no caller, while she struggled with the problem it was written to solve.
//
// A reachability check that can be fooled is worse than none, because its
// green becomes the reason nobody looks. Both ways I actually fooled this one
// get a check here.

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
const G = require(path.join(ROOT, 'scripts/check-dead-helpers'));

// ── A — IT FINDS THE FILE IT WAS WRITTEN FOR ──────────────────────────────
{
    section('A — reconcile.js, the reason this exists');

    const { dead, scanned } = G.deadHelpers();
    ck('it scanned the repo rather than one directory', scanned > 200, String(scanned));

    const names = dead.map((d) => d.file);
    // NOT asserted as "exactly reconcile.js". The day she wires reconcile.js
    // to a screen this must go green on its own, and the day another helper
    // dies it must go red — an exact-list check would need editing for both
    // and would get deleted for it.
    ck('a helper with a test and no production caller is reported',
       names.includes('helpers/reconcile.js'),
       names.join(', ') || '(nothing reported)');
    const rec = dead.find((d) => d.file === 'helpers/reconcile.js');
    ck('  and it says the test is the only thing keeping it green',
       rec && rec.tested === true, JSON.stringify(rec));

    const wa = dead.find((d) => d.file === 'helpers/wa_supervisor.js');
    ck('a helper with no caller AND no test is distinguished from one with a test',
       wa && wa.tested === false, JSON.stringify(wa));

    // The ones I wrongly accused. Each is required in api.js, and each was
    // reported dead by a broken version of this scan.
    for (const alive of ['bolPdf', 'loadTruckerBill', 'vendorFromText', 'bankMatch', 'bankLearn', 'salesReceipts']) {
        ck(`  ${alive}.js is NOT reported — it has a real caller`,
           !names.includes('helpers/' + alive + '.js'), names.join(', '));
    }
}

// ── B — THE PROSE FALSE NEGATIVE ──────────────────────────────────────────
// helpers/bankMatchRoutes.js contains the words require('./reconcile') in a
// comment explaining that reconcile.js has no caller. A scan that reads
// comments counts that as the caller and clears the very file it is hunting.
{
    section('B — a comment that mentions a require is not a caller');

    const prose = [
        '// reconcile.js is unreachable: require(\'./reconcile\') appears only in its own test',
        ' * and require("../helpers/reconcile") is nowhere in production',
        'const x = 1;',
    ].join('\n');
    const names = G.requiredNames
        ? (() => { const f = path.join(ROOT, 'outputs', '.probe-prose.js');
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, prose);
            const got = G.requiredNames([f]);
            fs.unlinkSync(f);
            return got; })()
        : new Set();
    ck('a require inside a // comment is not counted', !names.has('reconcile'),
       JSON.stringify([...names]));
    ck('  nor one inside a * continuation line', !names.has('reconcile'));

    // And the converse, so the filter is not just deleting everything.
    const real = path.join(ROOT, 'outputs', '.probe-real.js');
    fs.writeFileSync(real, "const r = require('./helpers/reconcile');\n");
    const got = G.requiredNames([real]);
    fs.unlinkSync(real);
    ck('  while a real require IS counted', got.has('reconcile'), JSON.stringify([...got]));
}

// ── C — THE BLOCK-COMMENT FALSE POSITIVE ──────────────────────────────────
// A /\*[\s\S]*?\*\// strip ate ~6,000 lines of api.js because a regex
// literal containing */ closed the match early, and the run reported three
// live helpers as dead. Real code must survive the comment filter even when
// the file contains a sequence that looks like a comment terminator.
{
    section('C — real code survives, even beside something that looks like a comment end');

    const nasty = [
        'const re = /\\*\\//;                        // a regex holding a comment terminator',
        'const s = "/* not a comment */";',
        "const r = require('./helpers/bolPdf');",
        'const t = require("./helpers/loadTruckerBill");',
    ].join('\n');
    const f = path.join(ROOT, 'outputs', '.probe-nasty.js');
    fs.writeFileSync(f, nasty);
    const got = G.requiredNames([f]);
    fs.unlinkSync(f);
    ck('a require after a regex containing */ is still found', got.has('bolPdf'), JSON.stringify([...got]));
    ck('  and so is the one after a string containing a comment', got.has('loadTruckerBill'));

    // The filter is line-based on purpose. Proving it, so nobody swaps it
    // back for a block regex.
    const src = fs.readFileSync(path.join(ROOT, 'scripts/check-dead-helpers.js'), 'utf8');
    ck('the comment filter is line-based, not a block regex',
       /split\('\\n'\)[\s\S]{0,200}filter\(/.test(src) && !/\[\\s\\S\]\*\?\\\*\\\//.test(src.replace(/\/\/.*$/gm, '')),
       'a block regex cannot be made safe on a 9,000-line file');
}

// ── D — TESTS DO NOT COUNT AS CALLERS ─────────────────────────────────────
// The single assumption the whole check rests on. A dead helper always has
// exactly one caller — its test — and counting it is what made reconcile.js
// look alive for a month.
{
    section('D — the one assumption everything rests on');

    const files = G.productionFiles();
    const rel = files.map((f) => path.relative(ROOT, f));
    ck('no file under tests/ is treated as production',
       !rel.some((r) => r === 'tests' || r.startsWith('tests' + path.sep)),
       rel.filter((r) => r.startsWith('tests')).slice(0, 5).join(', '));
    ck('  api.js is', rel.includes('api.js'));
    ck('  so are the helpers themselves, since one helper may require another',
       rel.includes(path.join('helpers', 'sales.js')));
    ck('  and the dashboard pages, which call routes rather than require',
       rel.some((r) => r === path.join('dashboard', 'index.html')));
    ck('  the mutation sidecar is excluded — it holds copies of helper source',
       !rel.includes(path.join('scripts', 'mutate.js')),
       'counting it would mark every mutated helper as alive');
    ck('  and node_modules is nowhere in the scan',
       !rel.some((r) => r.includes('node_modules')), String(rel.length));
}

// ── E — THE ALLOWLIST HAS TO BE JUSTIFIED ─────────────────────────────────
{
    section('E — BY_DESIGN is not a rubber stamp');

    ck('every allowlist entry carries a reason',
       Object.entries(G.BY_DESIGN).every(([, why]) => typeof why === 'string' && why.trim().length > 15),
       JSON.stringify(G.BY_DESIGN));
    ck('  and it is empty today, so nothing is being waved through',
       Object.keys(G.BY_DESIGN).length === 0, JSON.stringify(Object.keys(G.BY_DESIGN)));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
