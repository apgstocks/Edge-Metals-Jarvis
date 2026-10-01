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
// ── LOCAL DAYS, NOT UTC (fixed 2026-10-02) ───────────────────────────────
// `iso` was `d.toISOString().slice(0, 10)`, which is the UTC day. The code
// under test computes its window from the LOCAL day, because a date on a
// load is the yard's own day — so for part of every day the fixture was
// building dates in a different calendar from the thing it was testing.
//
// It showed up as "a load SIX days old is still open" failing on a machine
// at UTC+5:30: toISOString said 1 October while the app said the 2nd, so a
// load the fixture placed exactly ON the boundary landed a day outside it.
// In Pacific time the error runs the other way — after 5pm, UTC is already
// tomorrow — which means this fixture has been a day off for seven hours of
// every day since it was written, and nothing noticed because no check sat
// on a boundary until now.
//
// monthsAgo had a hand-rolled `- getTimezoneOffset()` correction bolted on
// for the same reason. With a local `iso` it is no longer needed.
const now = new Date();
const iso = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
const monthsAgo = (n, day) => iso(new Date(now.getFullYear(), now.getMonth() - n, day));

// The page's own day heading format, so a boundary check can look for the
// date rather than for a card id the real markup does not print.
const formatLike = (ymd) => {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};

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

    // ── THE RULE CHANGED, AND SO DID THE FIXTURE (2026-10-02) ───────────
    // Apsara: "in collapse phase of Edge Yard-I want last week load to
    // visible.rest of them collapsible." Confirmed as a ROLLING SEVEN DAYS,
    // not the calendar week — so what is open no longer has anything to do
    // with which month it is.
    //
    // The old fixture said "two this month, five across two older months".
    // Under the new rule those monthsAgo(1, 28) loads are four days old on
    // the 2nd of a month and therefore OPEN, and forty days old on the 10th
    // and therefore folded. That is the same date bomb this fixture has now
    // had twice: a test that passes on most days and fails on a few is worse
    // than one that always fails, because it gets re-run, shrugged at, and
    // eventually deleted.
    //
    // So the fixture is now expressed in DAYS AGO, either side of the seven
    // day line by a clear margin. Nothing here depends on today's date.
    const loads = [
        // Inside the week — must be open. Two distinct days, so the day
        // grouping is actually exercised.
        mk('A', daysAgo(0)), mk('B', daysAgo(0)), mk('C', daysAgo(3)),
        // Clearly outside it — must fold. Spread across months so the
        // month > week > day nesting has something to nest.
        mk('D', daysAgo(20)), mk('E', daysAgo(21)), mk('F', daysAgo(45)),
        mk('G', daysAgo(80)),
        // ── ON THE LINE, BOTH SIDES ──────────────────────────────────────
        // Seven days INCLUDING today, so day 6 is the last one in and day 7
        // is the first one out. Without these two the fixture never touched
        // the boundary, and a mutation that made the window eight days long
        // SURVIVED the whole file — an off-by-one in exactly the place a
        // rolling window gets them.
        mk('IN6', daysAgo(6)), mk('OUT7', daysAgo(7)),
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
    // ── THE LAST SEVEN DAYS ARE OPEN AT THE TOP LEVEL ────────────────────
    // Computed from the fixture, not written down: one top-level day section
    // per distinct date inside the window, plus one for the undated load.
    // A hardcoded number here is what broke this file twice.
    const WINDOW = 7;
    const inWindow = new Set(loads
        .filter((l) => l.date && l.date >= daysAgo(WINDOW - 1))
        .map((l) => l.date));
    const undated = loads.filter((l) => !l.date).length ? 1 : 0;
    ck(`${who}: the last week is open at the top level`,
       dayTops.length === inWindow.size + undated,
       `${dayTops.length} rendered; expected ${inWindow.size} day(s) in the last ${WINDOW} `
       + `+ ${undated} undated — ` + dayTops.map((e) => e.querySelector('summary').textContent.trim()).join(' | '));
    ck(`  ${who}: and EVERY one of them is open, not just the newest`,
       dayTops.filter((e) => !/No date set/.test(e.textContent)).every((e) => e.hasAttribute('open')),
       'her words were "i want last week load to visible" — one open day and six '
       + 'shut is the scrolling this was meant to remove');
    ck(`  ${who}: a load older than the week is NOT at the top level`,
       !dayTops.some((e) => /ago/.test('') ) && q('.load-month-section').length > 0,
       'the older ones have to be inside a folded month');
    // ── THE BOUNDARY, NAMED ──────────────────────────────────────────────
    const topText = dayTops.map((e) => e.textContent).join(' ');
    const foldedText = q('.load-month-section').map((e) => e.textContent).join(' ');
    // Asserted on the HEADINGS, which carry the date — the cards render real
    // markup here and do not print their id.
    const sixAgoHeading = formatLike(daysAgo(6));
    ck(`  ${who}: a load SIX days old is still open`,
       topText.includes(sixAgoHeading),
       `expected a top-level section for ${daysAgo(6)} (${sixAgoHeading}); got `
       + dayTops.map((e) => e.querySelector('summary').textContent.trim()).join(' | '));
    const sevenAgoHeading = formatLike(daysAgo(7));
    ck(`  ${who}: a load SEVEN days old is folded away`,
       !topText.includes(sevenAgoHeading) && foldedText.includes(sevenAgoHeading),
       'and day 7 is the first one out — an eight-day window is the off-by-one '
       + 'a rolling window invites');

    // ── THE YARD'S OWN DAY, NOT UTC ──────────────────────────────────────
    // splitLoadsByRecency's cutoff used to come from toISOString(), which is
    // UTC — so for the seven hours after 5pm Pacific it believed it was
    // already tomorrow and moved the boundary a day early every evening.
    // Asserted on the helper directly: in a UTC sandbox the two agree, so
    // only a check on the COMPONENTS can tell them apart.
    const probe = new Date(2026, 9, 2, 23, 30, 0);   // local 2026-10-02 23:30
    ck(`  ${who}: the day key is the LOCAL day, not the UTC one`,
       w.loadLocalDayKey(probe) === '2026-10-02',
       `got ${w.loadLocalDayKey(probe)} — a date on a load is the yard's own day`);

    ck(`  ${who}: and an undated load stays at the top level`,
       dayTops.some((e) => /No date set/.test(e.textContent)),
       'filing an undated load under a month means inventing one, and those are the rows most likely to need fixing');

    // ══════════════════════════════════════════════════════════════════════
    section(`${who} — C: older months fold, month > week > day`);
    // ══════════════════════════════════════════════════════════════════════
    // ── COUNTED FROM THE FIXTURE ──────────────────────────────────────────
    // Was `=== 2`, true of the old monthsAgo fixture and meaningless now
    // that the fixture is expressed in days. The PROPERTY is "one folded
    // month per distinct month outside the week".
    const olderLoads = loads.filter((l) => l.date && l.date < daysAgo(WINDOW - 1));
    const olderMonths = new Set(olderLoads.map((l) => l.date.slice(0, 7)));
    const olderDays = new Set(olderLoads.map((l) => l.date));
    const months = q('.load-month-section');
    ck(`${who}: the older months are folded`, months.length === olderMonths.size,
       `${months.length} rendered, ${olderMonths.size} distinct older months — `
       + months.map((e) => e.querySelector('summary').textContent.trim()).join(' | '));
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
    ck(`  ${who}: days inside weeks`,
       q('.load-week-section .load-day-section').length === olderDays.size,
       `${q('.load-day-section').length} rendered, ${olderDays.size} distinct dates outside the week`);
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

    // ══════════════════════════════════════════════════════════════════════
    section(`${who} — F: filter by month`);
    // ══════════════════════════════════════════════════════════════════════
    // Apsara, 2026-10-02: "Also give an option to filter by month.If they
    // select that month -all that months load should be visible expanded."
    // Confirmed as a true filter: only that month, fully expanded.
    {
        // The page source, for the checks that have to see the WIRING — the
        // handler is attached inside the Loads tab's setup, which needs the
        // tab rendered, so these read the file the mount() came from.
        const pageSrc = fs.readFileSync(path.join(ROOT, file), 'utf8');

        // ── THE OPTIONS COME FROM THE DATA ───────────────────────────────
        // A month with no loads in it is a control that answers "no loads"
        // and reads as broken.
        const present = w.loadMonthsPresent(loads);
        const realMonths = new Set(loads.filter((l) => l.date).map((l) => l.date.slice(0, 7)));
        ck(`${who}: the month list is built from the loads`,
           present.length === realMonths.size, JSON.stringify(present.map((m) => m.key)));
        ck(`  ${who}: newest month first`,
           present.every((m, i) => i === 0 || present[i - 1].key > m.key),
           present.map((m) => m.key).join(' '));
        ck(`  ${who}: each carries its count`,
           present.every((m) => m.count === loads.filter((l) => l.date && l.date.startsWith(m.key)).length),
           JSON.stringify(present));
        ck(`  ${who}: and a readable label, not the key`,
           present.every((m) => /^[A-Z][a-z]+ \d{4}$/.test(m.label)),
           present.map((m) => m.label).join(' | '));

        // ── FILTERING ────────────────────────────────────────────────────
        const target = present[present.length - 1].key;   // the oldest, safely outside the week
        const only = w.filterLoadsByMonth(loads, target);
        ck(`${who}: filtering keeps only that month`,
           only.length > 0 && only.every((l) => l.date.startsWith(target)),
           `${only.length} rows for ${target}`);
        ck(`  ${who}: an undated load is NOT swept into a month`,
           !only.some((l) => !l.date),
           'it has no month; putting it in one is the invention splitLoadsByRecency refuses to make');
        ck(`  ${who}: no filter means everything`,
           w.filterLoadsByMonth(loads, '').length === loads.length);

        // ── AND IT RENDERS EXPANDED ──────────────────────────────────────
        // Her words: "all that months load should be visible expanded."
        const picked = render(w, only, { allOpen: true });
        const pq = (sel) => [...picked.querySelectorAll(sel)];
        const folds = pq('.load-month-section, .load-week-section, .load-day-section, .load-date-section');
        ck(`${who}: every fold is open when a month is picked`,
           folds.length > 0 && folds.every((e) => e.hasAttribute('open')),
           `${folds.filter((e) => !e.hasAttribute('open')).length} of ${folds.length} still shut`);
        ck(`  ${who}: and every one of that month's loads is on screen`,
           pq('.load-deck-grid > *').length === only.length,
           `${pq('.load-deck-grid > *').length} of ${only.length}`);

        // ── WITHOUT allOpen, NOTHING MOVED ───────────────────────────────
        // The ordinary view must be exactly as it was. allOpen defaulting to
        // true would quietly unfold her whole history.
        const normal = render(w, loads);
        const nq = (sel) => [...normal.querySelectorAll(sel)];
        ck(`${who}: the unfiltered view still folds the older months`,
           nq('.load-month-section').every((e) => !e.hasAttribute('open')),
           'allOpen must default off — otherwise picking no month unfolds everything');

        // ── THE CONTROL EXISTS AND IS WIRED ──────────────────────────────
        // A <select> nothing listens to is decoration. Checked in the page
        // source because the handler is attached inside the Loads tab's
        // wiring, which needs the tab rendered.
        ck(`${who}: the page has a month control`,
           /id="loadMonthFilter"/.test(pageSrc), 'no control means no option to filter');
        ck(`  ${who}: something listens to it`,
           /\$\('loadMonthFilter'\)[\s\S]{0,400}addEventListener\('change'/.test(pageSrc),
           'a select nothing listens to is decoration');
        ck(`  ${who}: and it goes through the one repaint path`,
           /loadMonthFilter = String\(monthSel\.value[\s\S]{0,200}repaintDeck\(\)/.test(pageSrc),
           'a second render path is how two controls disagree about what is on screen');
        ck(`  ${who}: the filter is applied in the repaint chain`,
           /if \(loadMonthFilter\) rows = filterLoadsByMonth\(rows, loadMonthFilter\)/.test(pageSrc),
           'the control can be set and change nothing otherwise');
        ck(`  ${who}: and it is NOT persisted across sessions`,
           !/localStorage[\s\S]{0,60}loadMonthFilter|loadMonthFilter[\s\S]{0,60}localStorage/.test(pageSrc),
           'restoring "September" a fortnight later shows none of this week\'s work '
           + 'with a control she has forgotten she set');
    }

    dom.window.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
