// ── tests/load-deck-grouping.js ───────────────────────────────────────────
// Apsara, 2026-09-16: "in loads once the onth gets over,just make group as
// monthwise exppand/collapse-then weekwise-on clicking daywise expand".
//
// ── THE ONE THING THAT MUST NEVER HAPPEN ───────────────────────────────────
// A load that is in the list but on no screen. Folding is a presentation
// change over the SAME set of records, and the failure mode of any grouping
// code is a row that falls between two groups — a load dated the last day of a
// month, or the first day of a week, or with no date at all. Nobody notices a
// missing card; they notice the total not adding up, weeks later, and by then
// nothing points at the deck.
//
// So every section below counts. Section A is the whole feature in one
// assertion: every load in, every load on screen.
//
// Driven in jsdom rather than grepped. Nesting that renders the right headings
// and drops the cards looks perfect in source.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');

// The current month is decided from the clock, so the fixture is built
// relative to today — hard-coded dates would start failing in October for a
// reason that has nothing to do with the grouping.
const now = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
const monthsAgo = (n, day) => { const d = new Date(now.getFullYear(), now.getMonth() - n, day); return iso(new Date(d.getTime() - d.getTimezoneOffset() * 60000)); };

const mk = (id, date) => ({ id, date, seller: 'Ramesh', net_weight: 100, amount: 10, items: [], _kind: 'purchase' });

function mount(file) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const SCRIPT = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    // ── boot() MUST NOT OUTLIVE THE WINDOW ───────────────────────────────
    // boot() is async. It starts during eval, awaits a fetch, and RESUMES as
    // a microtask — by which time the process is tearing down and its first
    // $() throws "Cannot read properties of undefined". This file printed
    // "36 passed, 0 failed" and then EXITED 1, so every run of it by name
    // looked perfect and the full runner marked it failed.
    //
    // Held at its first await rather than swallowed: a fetch that never
    // settles means boot never reaches the DOM, and it also guarantees this
    // suite touches no network. Same fix as tests/sidebar-collapse.js, which
    // hit this first and wrote it down — it just never travelled to the other
    // files that mount these pages.
    dom.window.fetch = () => new Promise(() => {});
    dom.window.setInterval = () => 0;
    try { dom.window.eval(SCRIPT); } catch (e) { /* see above */ }
    return dom;
}

// A fresh document to parse the returned HTML into, so nothing on the real
// page can satisfy a query by accident.
function render(w, loads, opts) {
    const d = new JSDOM('<div id="r"></div>').window.document;
    d.getElementById('r').innerHTML = w.loadDeckSectionsHtml(loads, 'No loads yet.', opts || {});
    return d;
}

for (const file of ['dashboard/index.html', 'mobile-app/www/index.html']) {
    const who = file.includes('mobile') ? 'app' : 'website';
    const dom = mount(file);
    const w = dom.window;

    // ── THE FIXTURE HAD A DATE BOMB OF ITS OWN (found 2026-10-01) ────────
    // "Two this month" was mk('B', daysAgo(1)) — and on the FIRST of a month
    // yesterday is in the PREVIOUS month, so B stopped being one of the two
    // and became a sixth folded day. That turned the hardcoded `=== 5`
    // below red, on a day when nothing about the grouping had changed.
    //
    // Worse than always-red: it passes on 28 days out of 31 and fails on the
    // 1st and 2nd, which is the kind of failure that gets re-run, shrugged
    // at, and eventually deleted.
    //
    // So "this month" now means a day that IS in this month whatever the
    // date: today, and the day after the 1st clipped to today. And the
    // counts below are computed from this list rather than written down.
    // BOTH on today. A second DISTINCT day in the current month does not
    // exist on the 1st, so asking for one is asking the calendar for a
    // favour. Two loads on one day exercises the same thing the section
    // below actually checks — that this month renders as day sections with
    // the newest open — without depending on the date.
    //
    // Two this month (same day), five across two older months, one undated.
    const loads = [
        mk('A', daysAgo(0)), mk('B', daysAgo(0)),
        mk('C', monthsAgo(1, 28)), mk('D', monthsAgo(1, 27)), mk('E', monthsAgo(1, 14)), mk('F', monthsAgo(1, 3)),
        mk('G', monthsAgo(2, 9)),
        mk('H', null),
    ];

    // ══════════════════════════════════════════════════════════════════════
    section(`${who} — A: nothing is lost`);
    // ══════════════════════════════════════════════════════════════════════
    const d = render(w, loads);
    const q = (sel) => [...d.querySelectorAll(sel)];
    const cards = q('.load-deck-grid').reduce((n, g) => n + g.children.length, 0);
    ck(`${who}: every load is on screen somewhere`, cards === loads.length,
       `${cards} of ${loads.length} — a load in the list and on no screen is the failure this whole file is for`);
    const ids = q('.load-deck-grid > *').map((el) => el.textContent);
    ck(`  ${who}: and each appears exactly once`,
       q('.load-deck-grid > *').length === loads.length,
       'a load counted under two headings inflates every total on the page');

    // ══════════════════════════════════════════════════════════════════════
    section(`${who} — B: this month is left alone`);
    // ══════════════════════════════════════════════════════════════════════
    // Her words are "once the month gets over". The screen she works in every
    // day must not get two folds deeper to tidy up last March.
    const dayTops = q('.load-date-section');
    // ONE day section for this month's loads plus ONE for the undated — and
    // asserted as that, rather than as ">= 2". The loose version passed on
    // the 1st for the wrong reason: the two "this month" loads had silently
    // collapsed into one day and the count was made up by the undated
    // section, so a real regression in this-month grouping would have been
    // invisible.
    const thisMonthDays = new Set(loads
        .filter((l) => l.date && l.date.slice(0, 7) === iso(now).slice(0, 7))
        .map((l) => l.date));
    const undated = loads.filter((l) => !l.date).length ? 1 : 0;
    ck(`${who}: this month still shows as day sections`,
       dayTops.length === thisMonthDays.size + undated,
       `${dayTops.length} rendered; expected ${thisMonthDays.size} dated day(s) + ${undated} undated — `
       + dayTops.map((e) => e.querySelector('summary').textContent.trim()).join(' | '));
    ck(`  ${who}: newest day still opens on arrival`, dayTops[0] && dayTops[0].hasAttribute('open'),
       'if today is shut, every visit starts with a click');
    ck(`  ${who}: and an undated load stays at the top level`,
       dayTops.some((e) => /No date set/.test(e.textContent)),
       'filing an undated load under a month means inventing one, and those are the rows most likely to need fixing');

    // ══════════════════════════════════════════════════════════════════════
    section(`${who} — C: older months fold, month > week > day`);
    // ══════════════════════════════════════════════════════════════════════
    const months = q('.load-month-section');
    ck(`${who}: the two older months are folded`, months.length === 2,
       months.map((e) => e.querySelector('summary').textContent.trim()).join(' | '));
    // Newest month first. Asserted by DATE, not by comparing the rendered
    // labels — "August" sorts before "July" alphabetically, so a string
    // comparison here would pass on a list in the wrong order.
    const monthOf = (m) => {
        const first = m.querySelector('.load-day-section .load-day-heading');
        return Date.parse(first ? first.firstChild.textContent : '') || 0;
    };
    ck(`  ${who}: newest month first`, monthOf(months[0]) > monthOf(months[1]),
       months.map((m) => m.querySelector('.load-date-count').textContent).join(' | '));
    ck(`  ${who}: weeks inside months`, q('.load-month-section .load-week-section').length >= 3,
       `${q('.load-week-section').length} weeks`);
    // ── COUNTED FROM THE FIXTURE, NOT WRITTEN DOWN ───────────────────────
    // This said `=== 5`. Five was right for the list above on most days of
    // the month and wrong on the 1st. The PROPERTY is "one folded day per
    // distinct date that is not in the current month", so that is what is
    // asserted — and it stays true whichever day the suite runs.
    const thisMonth = iso(now).slice(0, 7);
    const olderDays = new Set(loads
        .filter((l) => l.date && l.date.slice(0, 7) !== thisMonth)
        .map((l) => l.date));
    ck(`  ${who}: days inside weeks`,
       q('.load-week-section .load-day-section').length === olderDays.size,
       `${q('.load-day-section').length} rendered, ${olderDays.size} distinct older dates in the fixture`);
    ck(`  ${who}: and cards inside days`,
       q('.load-day-section .load-deck-grid').length === olderDays.size);

    // Everything shut. A fold that opens by default is not a fold.
    ck(`  ${who}: every older fold starts closed`,
       q('.load-month-section, .load-week-section, .load-day-section').every((e) => !e.hasAttribute('open')),
       'the point is that last month is out of the way until she asks for it');

    // ══════════════════════════════════════════════════════════════════════
    section(`${who} — D: the headings say what is inside`);
    // ══════════════════════════════════════════════════════════════════════
    // So she never has to open a fold to find out whether it is worth opening.
    ck(`${who}: each month heading carries a count`,
       months.every((e) => /\d+ loads?/.test((e.querySelector('.load-date-count') || {}).textContent || '')),
       months.map((e) => e.querySelector('summary').textContent.trim()).join(' | '));
    // Read off .load-date-count, NOT the whole summary. The first version
    // regexed the summary text and matched "August 20264 loads" -> 20264: the
    // label and the count are separated on screen by a flex gap, which leaves
    // no separator at all in textContent. The assertion failed on correct code.
    ck(`  ${who}: and the month count matches the cards inside it`,
       months.every((m) => {
           const said = Number((m.querySelector('.load-date-count').textContent.match(/(\d+)/) || [])[1]);
           const got = [...m.querySelectorAll('.load-deck-grid')].reduce((n, g) => n + g.children.length, 0);
           return said === got;
       }),
       months.map((m) => `${m.querySelector('.load-date-count').textContent} vs ${[...m.querySelectorAll('.load-deck-grid')].reduce((n, g) => n + g.children.length, 0)} cards`).join(' | ')
       + ' — a count that disagrees with the fold is worse than no count');
    ck(`  ${who}: weeks carry counts too`,
       q('.load-week-section').every((e) => /\d+ loads?/.test((e.querySelector('.load-date-count') || {}).textContent || '')));

    // A week label must describe the days actually in it, not the calendar
    // week — a heading advertising a range that is mostly empty is a heading
    // that misleads.
    const single = q('.load-week-section').find((e) => /^1 load$/.test((e.querySelector('.load-date-count') || {}).textContent || ''));
    ck(`  ${who}: a one-day week is labelled as one day, not a range`,
       !!single && !/–/.test(single.querySelector('.load-week-heading').firstChild.textContent),
       single && single.querySelector('summary').textContent.trim());

    // ══════════════════════════════════════════════════════════════════════
    section(`${who} — E: the flat view is untouched`);
    // ══════════════════════════════════════════════════════════════════════
    // Searching or filtering by item switches the deck to flat. Folding a
    // search result would hide the answer she just asked for.
    const flat = render(w, loads, { flat: true });
    ck(`${who}: a filtered deck has no folds at all`,
       flat.querySelectorAll('.load-month-section, .load-date-section').length === 0,
       'a search result behind a collapsed month is a search that looks broken');
    ck(`  ${who}: and still shows every match`,
       [...flat.querySelectorAll('.load-deck-grid')].reduce((n, g) => n + g.children.length, 0) === loads.length);

    // An empty deck must still say so rather than rendering nothing.
    const none = render(w, []);
    ck(`  ${who}: an empty deck says so`, /No loads yet/.test(none.getElementById('r').textContent));

    dom.window.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
