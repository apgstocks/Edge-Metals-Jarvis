// ── tests/pdf-timing.js ───────────────────────────────────────────────────
// Apsara, 2026-09-16: "why invoice and bol takes more time to generate?"
//
// I can read the answer out of the code — one Chromium launched per document,
// a 500ms network-idle wait with nothing to wait for, up to thirteen
// sequential round trips to fit the page. Reading is not measuring, and this
// sandbox cannot launch Chromium at all, so nothing gets optimised until the
// real server says which of those is costing her the wait.
//
// ── WHAT THIS SUITE IS ACTUALLY FOR ─────────────────────────────────────────
// A stopwatch is being attached to the code path that produces her commercial
// invoices and bills of lading. The risk is not that it measures wrongly — a
// wrong number is a wrong number. The risk is that it THROWS, and takes a
// document with it. So most of what follows is about the stopwatch surviving
// abuse, and about pdfFittedToOnePage being exactly as correct without one as
// with one.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'helpers/pdfTiming'));
const { pdfFittedToOnePage } = require(path.join(ROOT, 'helpers/pdfFit'));

// Chromium cannot launch here. A fake page is the whole reason pdfFit was
// written with its arithmetic separable in the first place.
const fakePage = (height) => {
    let h = height;
    return {
        evaluate: async () => h,
        addStyleTag: async () => { h *= 0.9; },
        pdf: async () => Buffer.from('%PDF'),
    };
};

// Quiet: this suite generates dozens of [PDF-TIME] lines and they are the
// feature, not the output of the test.
const realLog = console.log;
const hush = (fn) => { const lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return fn(lines); } finally { console.log = realLog; } };

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — it measures the four phases she asked about');
// ══════════════════════════════════════════════════════════════════════════
{
    T.reset();
    const lines = [];
    hush((captured) => {
        const t = T.start('bol 26ECC001');
        t.mark('build-html'); t.mark('launch-chromium'); t.mark('load-page');
        t.mark('fit(3 passes)'); t.mark('render'); t.mark('close-chromium');
        t.done({ html_kb: 610 });
        lines.push(...captured);
    });

    const [entry] = T.recent(1);
    ck('an entry is kept', !!entry);
    ck('  labelled with the document', entry.label === 'bol 26ECC001', entry && entry.label);
    ck('  and carries every phase, in order',
       entry.phases.map((p) => p.phase).join(',')
       === 'build-html,launch-chromium,load-page,fit(3 passes),render,close-chromium',
       entry.phases.map((p) => p.phase).join(','));
    ck('  with the html size, because the BOL inlines 615KB of fonts',
       entry.html_kb === 610, String(entry.html_kb));
    ck('  and a total', Number.isFinite(entry.total_ms) && entry.total_ms >= 0, String(entry.total_ms));
    ck('one line per document reaches the log',
       lines.filter((l) => /^\[PDF-TIME\]/.test(l)).length === 1,
       lines.join(' | '));
    ck('  naming the phases in it', /launch-chromium/.test(lines.find((l) => /PDF-TIME/.test(l)) || ''),
       'a line that only says "4210ms" answers nothing');

    // ── NEVER NEGATIVE ───────────────────────────────────────────────────
    // Date.now() steps backwards over an NTP correction, and a negative phase
    // reads as a bug in the thing being measured rather than in the clock.
    // hrtime is monotonic; this asserts the choice rather than trusting it.
    ck('no phase can come out negative', entry.phases.every((p) => p.ms >= 0),
       JSON.stringify(entry.phases));
    // Asserted on process.hrtime BY NAME. The first version of this check
    // looked for "Date.now() -" and passed happily when the clock source was
    // swapped back, because the subtraction had moved into a helper — a check
    // shaped like the old code rather than like the property.
    ck('  and durations come from the monotonic clock',
       /process\.hrtime/.test(fs.readFileSync(path.join(ROOT, 'helpers/pdfTiming.js'), 'utf8')),
       'Date.now steps backwards over an NTP correction and prints a negative phase');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the rollup, which is the answer to her question');
// ══════════════════════════════════════════════════════════════════════════
{
    T.reset();
    hush(() => {
        for (let i = 0; i < 3; i++) {
            const t = T.start(`invoice invoice+packing`);
            t.mark('launch-chromium'); t.mark('load-page'); t.mark('render');
            t.done({});
        }
        const b = T.start('bol 26ECC009');
        b.mark('launch-chromium'); b.mark('render');
        b.done({});
    });

    const s = T.summary();
    ck('documents are grouped by kind', s.map((g) => g.kind).sort().join(','), 'bol,invoice');
    const inv = s.find((g) => g.kind === 'invoice');
    ck('  counting the runs', inv.runs === 3, String(inv.runs));
    ck('  and averaging each phase', inv.avg_phases.length === 3, JSON.stringify(inv.avg_phases));
    // ── BIGGEST FIRST ────────────────────────────────────────────────────
    // The rollup exists to answer "what do I fix", so the phase to fix has to
    // be the first line. Checked with phases that are DELIBERATELY out of
    // order — the first version used three phases of roughly equal length, so
    // any order passed and removing the sort changed nothing.
    T.reset();
    hush(() => {
        const t2 = T.start('invoice invoice+packing');
        t2.phasesForTest = true;
        t2.mark('quick');
        // A real gap, so the sort has something to do.
        const until = Date.now() + 12; while (Date.now() < until) { /* spin */ }
        t2.mark('slow');
        t2.done({});
    });
    const inv2 = T.summary().find((g) => g.kind === 'invoice');
    ck('  biggest first, because that is the thing to fix',
       inv2.avg_phases[0].phase === 'slow',
       JSON.stringify(inv2.avg_phases) + ' — the phase to fix has to be the first line');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — it cannot take a document down with it');
// ══════════════════════════════════════════════════════════════════════════
{
    // This is attached to the path that prints her commercial invoices. A
    // missing measurement is nothing; a BOL that fails to generate because the
    // stopwatch fell over is a driver at a gate.
    T.reset();
    let threw = null;
    // A NULL-PROTOTYPE OBJECT, not a plain one. The first version of this
    // check passed nonsense that String() happens to cope with — {} becomes
    // "[object Object]", null becomes "null" — so removing the guard changed
    // nothing and the check proved nothing. Object.create(null) has no
    // toString, so String() on it genuinely throws, which is the only way to
    // show the guard is doing work.
    hush(() => {
        try {
            const t = T.start(Object.create(null));
            t.mark(Object.create(null));   // the phase name, unconvertible too
            t.mark(null);
            t.done('not an object');
            t.done();
        } catch (e) { threw = e; }
    });
    ck('nonsense in, nothing thrown out', !threw, threw && threw.message);
    ck('  and it still filed something', T.recent(1).length === 1);
    // Each conversion is guarded SEPARATELY, so the entry survives with a
    // placeholder rather than being lost: a document whose label could not be
    // read is still a document whose launch took four seconds.
    ck('    with a usable label', T.recent(1)[0].label === 'document', T.recent(1)[0].label);
    ck('    and a usable phase name', T.recent(1)[0].phases[0].phase === 'phase',
       JSON.stringify(T.recent(1)[0].phases));

    // The ring is capped. A diagnostic that grows forever to answer a question
    // asked once is its own small problem.
    T.reset();
    hush(() => { for (let i = 0; i < T.MAX_KEPT + 25; i++) { const t = T.start(`bol ${i}`); t.mark('x'); t.done({}); } });
    ck(`only the last ${T.MAX_KEPT} are kept`, T.recent(999).length === T.MAX_KEPT,
       String(T.recent(999).length));
    ck('  and they are the NEWEST', T.recent(1)[0].label === `bol ${T.MAX_KEPT + 24}`,
       T.recent(1)[0].label);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the renderer is identical with and without a timer');
// ══════════════════════════════════════════════════════════════════════════
{
    // The stopwatch is opt-in. Every existing caller passes no timer at all,
    // and must behave exactly as it did before this existed.
    const a = await pdfFittedToOnePage(fakePage(900), { printBackground: true }, { pageHeightMm: 297 });
    ck('no timer: a fitting document still renders', Buffer.isBuffer(a));

    let got = null;
    const t = T.start('probe');
    await hush(async () => {}) ;
    const b = await pdfFittedToOnePage(
        { evaluate: async () => 900, addStyleTag: async () => {}, pdf: async (o) => { got = o; return Buffer.from('%PDF'); } },
        { printBackground: true }, { pageHeightMm: 297, timer: t });
    ck('with a timer: the same document comes out', Buffer.isBuffer(b));
    ck('  and the pdf options are untouched', got.printBackground === true && got.scale === 1,
       JSON.stringify(got));

    // A timer that throws on every call must not reach the renderer either —
    // the fitter guards its own marks.
    const hostile = { mark() { throw new Error('boom'); }, done() { throw new Error('boom'); } };
    let threw2 = null;
    try {
        await pdfFittedToOnePage(fakePage(900), {}, { pageHeightMm: 297, timer: hostile });
    } catch (e) { threw2 = e; }
    ck('a timer that throws does not stop the render', !threw2, threw2 && threw2.message);

    // And the fit phase reports how many passes it took, which is the number
    // that says whether the measure/restyle loop is worth optimising.
    T.reset();
    let marks = [];
    const counting = { mark: (n) => marks.push(n), done: () => {} };
    await pdfFittedToOnePage(fakePage(1400), {}, { pageHeightMm: 297, timer: counting });
    ck('the fit phase says how many passes it took',
       marks.some((m) => /^fit\(\d+ passes\)$/.test(m)), marks.join(','));
    ck('  and a document that needs trimming reports more than one',
       Number((marks.find((m) => /^fit\(/.test(m)) || '').replace(/\D/g, '')) > 1,
       marks.join(','));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — every renderer is wired, including the one she did not ask about');
// ══════════════════════════════════════════════════════════════════════════
{
    // The three share a shape. A baseline from the proforma — the one she has
    // NOT complained about — is what says whether the invoice and the BOL are
    // slow for a reason of their own, or whether every document costs this.
    for (const f of ['helpers/bolPdf.js', 'helpers/invoicePdf.js', 'helpers/proformaPdf.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        ck(`${f} times its render`, /pdfTiming'\)\.start\(/.test(src));
        ck(`  ${f} marks the Chromium launch`, /timer\.mark\('launch-chromium'\)/.test(src),
           'the launch is the phase most likely to be the whole answer');
        ck(`  ${f} closes the entry in a finally`,
           /finally\s*\{[\s\S]{0,400}timer\.done\(/.test(src),
           'a document that throws mid-render must still report where the time went');
        ck(`  ${f} passes the timer to the fitter`, /timer,/.test(src));
    }
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('and there is a route to read it without shell access',
       /\/api\/pdf-timings/.test(api) && /requireAdmin/.test(api.slice(api.indexOf('/api/pdf-timings') - 120, api.indexOf('/api/pdf-timings') + 120)));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
