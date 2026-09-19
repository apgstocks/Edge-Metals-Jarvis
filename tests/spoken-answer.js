// ── tests/spoken-answer.js ────────────────────────────────────────────────
// Apsara, 2026-09-19: "i dont want it to say out the booking number aloud.
// bcoz it doesnt make any sense"
//
// Two halves: the rewrite itself, and — because unit tests on both ends pass
// while a feature does not work — a REAL server answering a real sentence,
// with the screen copy and the spoken copy both read back out of the route.

const { forSpeech } = require('../helpers/spokenAnswer');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

(async () => {
section('A — the rewrite');
{
    const known = () => new Set(['272766480', 'DALA23991600', 'HOU111', 'HOU222']);
    const rows = [{ n: 1, booking_number: 'HOU111' }, { n: 2, booking_number: 'HOU222' }];
    const t = (s, o) => forSpeech(s, Object.assign({ known: known() }, o || {}));

    ck('a known number becomes "this booking"',
       t('272766480 cuts off next Wednesday.') === 'This booking cuts off next Wednesday.', t('272766480 cuts off next Wednesday.'));
    ck('a numbered row becomes its ordinal — what she says back',
       t('Forward HOU111 to Sher Trucking?', { rows }) === 'Forward the first booking to Sher Trucking?');
    ck('"booking HOU222" does not become "booking the second booking"',
       t('The ERD of booking HOU222 is 09/24/2026.', { rows }) === 'The ERD of the second booking is 09/24/2026.',
       t('The ERD of booking HOU222 is 09/24/2026.', { rows }));
    ck('a bracketed repeat goes entirely',
       t('Your Houston booking (DALA23991600) cuts off tomorrow.') === 'Your Houston booking cuts off tomorrow.');
    ck('"booking no. X" is caught even when the store does not know X',
       t('Booking no. 998877665 is confirmed.') === 'This booking is confirmed.');
    const other = t('Container MSCU1234567 weighs 21,450 kg; PO 4302902; $8,450.00 per MT.');
    ck('containers, POs and amounts are still spoken — scope is booking numbers only',
       other === 'Container MSCU1234567 weighs 21,450 kg; PO 4302902; $8,450.00 per MT.', other);
    ck('a sentence with no booking number is untouched',
       t('You have 2 bookings from Houston.') === 'You have 2 bookings from Houston.');
    ck('empty in, empty out', forSpeech('') === '');
    ck('"HOU111/1" is a container of the booking, not "this booking slash one"',
       t('HOU111/1 forwarded to Sher Trucking.') === 'Container 1 of this booking forwarded to Sher Trucking.',
       t('HOU111/1 forwarded to Sher Trucking.'));
}

section('B — a real server: shown with the number, spoken without it');
{
    const j = await boot({});
    const one = await j.say('show me the bookings from houston');
    const rows = (one.json.cards && one.json.cards.rows) || [];
    ck('the list answers', one.status === 200 && rows.length > 0, one.raw && one.raw.slice(0, 160));
    ck('  and carries a spoken copy', typeof one.json.spoken === 'string' && one.json.spoken.length > 0);

    const two = await j.say('when is the erd of that booking');
    const bn = rows[0] && rows[0].booking_number;
    ck('the SCREEN still names the booking', !!bn && two.json.answer.includes(bn), two.json.answer);
    ck('  the SPOKEN copy does not', !!bn && !two.json.spoken.includes(bn), two.json.spoken);
    ck('  and still says the date', /\d{2}\/\d{2}\/\d{4}/.test(two.json.spoken), two.json.spoken);

    const three = await j.say('forward the first one to Sher Trucking');
    ck('a forward confirmation is spoken without the number',
       !!bn && !three.json.spoken.includes(bn) && !/\/\d/.test(three.json.spoken), three.json.spoken);
    await j.stop();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
