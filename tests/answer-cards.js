// ── tests/answer-cards.js ─────────────────────────────────────────────────
// Apsara, 2026-09-06: "like JARVIS in iron man, a screen should appear, where
// it shows me all relevant answer to my question as jarvis is talking back.
// For eg: If i ask any available bookings from Houston? It should show
// Booking number, ERD, cut off."
//
// WHAT THIS GUARDS
// ----------------
// The rows are looked up from the SAME STORE the spoken answer comes from,
// never parsed out of the sentence Jarvis says. That is the whole design
// decision, and the failure it avoids is specific: a regex over the reply
// loses rows the moment the wording changes, or the model summarises three
// bookings as "a few" — and a table that is confidently incomplete is worse
// than no table at all, because she would act on it.
//
// The numbering is load-bearing too. "Forward the FIRST booking to Sher
// Trucking" only means something if something was numbered, and the number
// she sees has to be the number the server used.

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const { cardsFor, portIn, bookingRows } = require(path.join(ROOT, 'helpers/answerCards.js'));

console.log('\n─ the screen behind the answer ──────────────────────────────');

section('A — HER EXAMPLE, against her real bookings');
{
    const c = cardsFor('any available bookings from Houston?');
    ck('a panel appears', !!c && c.kind === 'bookings');
    ck('  titled with the port', /HOUSTON/i.test(c.title), c && c.title);
    ck('  and only Houston bookings are in it',
       c.rows.every((r) => /HOUSTON/i.test(r.from) || /HOUSTON/i.test(r.to)),
       c.rows.map((r) => r.from + '→' + r.to).join(', '));
    ck('  from data/bookings.json, not a fixture', c.rows.length > 0);

    // The three fields she named, by name.
    const r = c.rows[0];
    ck('every row has a booking number', c.rows.every((x) => !!x.booking_number));
    ck('  an ERD', c.rows.every((x) => 'erd' in x));
    ck('  and a cutoff', c.rows.every((x) => 'cutoff' in x));
    ck('  with the real values', /\d{2}\/\d{2}\/\d{4}/.test(r.cutoff), 'cutoff: ' + r.cutoff);
}

section('B — the numbering that makes "the first one" mean something');
{
    const c = cardsFor('what bookings do we have');
    ck('rows are numbered from 1', c.rows[0].n === 1);
    ck('  consecutively', c.rows.every((r, i) => r.n === i + 1),
       c.rows.map((r) => r.n).join(','));

    // Sorted by SOONEST CUTOFF. Not arbitrary: the booking cutting off first
    // is the one needing a trucker, so "the first one" is the one she most
    // likely means — and an unstable order would make the same words refer
    // to different bookings on different days.
    const ymd = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || ''); return m ? m[3] + m[1] + m[2] : '9999'; };
    const cutoffs = c.rows.map((r) => ymd(r.cutoff));
    ck('  and ordered by soonest cutoff first',
       cutoffs.every((v, i) => i === 0 || cutoffs[i - 1] <= v),
       cutoffs.join(' , ') + ' — an arbitrary order makes "the first one" mean something different each time');
}

section('C — an instruction does not redraw the list under her');
{
    // THE SUBTLE ONE. She looks at three numbered bookings and says "forward
    // the first booking to Sher Trucking". If that instruction rebuilt the
    // panel, the list could reorder — a cutoff passes, a booking is added —
    // and "the first one" would then mean a different booking from the one
    // she was looking at when she said it.
    for (const q of [
        'forward the first booking to Sher Trucking',
        'assign a supplier to that booking',
        'send the booking to the trucker',
        'message the trucker about the container',
    ]) {
        ck(`"${q}" leaves the panel alone`, cardsFor(q) === null,
           'redrawing here is how "the first one" comes to mean a different booking');
    }
}

section('D — no panel where there is nothing to show');
{
    for (const q of [
        'how much do we owe acme',
        'what is in inventory',
        'how many loads this week',
        '',
    ]) {
        ck(`"${q || '(nothing)'}" has no panel`, cardsFor(q) === null,
           'a table invented for a question that has none is noise on the screen');
    }
    ck('a port with no bookings shows nothing rather than everything',
       cardsFor('any bookings from reykjavik') === null,
       'falling back to ALL bookings would answer a different question than the one asked');
}

section('E — the ports she actually says');
{
    ck('"Houston" → HOUSTON', portIn('bookings from houston') === 'HOUSTON');
    ck('  "LA" → LOS ANGELES', portIn('anything out of LA') === 'LOS ANGELES',
       'she says LA, the bookings say LOS ANGELES');
    ck('  "Long Beach" is not read as "Beach"', portIn('from long beach') === 'LONG BEACH');
    ck('  and "LA" does not match inside another word',
       portIn('bookings from atlanta') !== 'LOS ANGELES',
       'an unanchored two-letter alias matches half the map');
    ck('  no port named → no filter', portIn('what bookings are there') === '');
}

section('F — what each row carries for the next step');
{
    const rows = bookingRows('HOUSTON');
    const r = rows[0];
    // The forward flow needs these: which containers exist, which have a
    // supplier, which have a trucker. Without them the panel is a picture
    // and the follow-up has to go back to the server to ask again.
    ck('containers are listed', Array.isArray(r.containers));
    ck('  with supplier and trucker per container',
       r.containers.every((c) => 'supplier' in c && 'trucker' in c));
    // COUNTED, not merely present. `typeof === 'number'` passed happily
    // with the count hard-wired to 0, which is the version where nothing is
    // ever flagged as needing a supplier and the panel looks calm while
    // three containers have nobody to collect from.
    const expectUnassigned = r.containers.filter((c) => !c.supplier).length;
    const expectNotFwd = r.containers.filter((c) => !c.trucker).length;
    ck('  and a count of what still needs a supplier',
       r.unassigned === expectUnassigned && (r.containers.length === 0 || r.unassigned > 0 || expectUnassigned === 0),
       'says ' + r.unassigned + ', containers without a supplier: ' + expectUnassigned
       + ' — this is what turns a row amber');
    ck('  and what still needs forwarding', r.not_forwarded === expectNotFwd,
       'says ' + r.not_forwarded + ', containers without a trucker: ' + expectNotFwd);
    // Her real Houston booking has one container with no supplier, so this
    // is a live value rather than an invariant that holds trivially.
    ck('  which on her Houston booking is a real, non-zero number',
       expectUnassigned > 0 && r.unassigned === expectUnassigned,
       'if this ever goes to zero the fixture changed — check the data, not the test');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
