// ── tests/voice-recording-0920.js ─────────────────────────────────────────
// Apsara's screen recording, 2026-09-20 06:54 IST — "Jarvis not responding
// properly". Every sentence below is what Chrome actually transcribed, in
// the order she said it, with a Houston bookings list already on screen
// (which is what made the bookings machinery claim everything).

const path = require('path');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const BOOKINGISH = /one booking from|bookings? from houston|ports have those|which one —|earliest booking|cuts off on|no other bookings on your screen/i;

(async () => {
    const j = await boot({});
    const say = async (q) => { const r = await j.say(q, 'jarvis'); return { a: r.json.answer || '', s: r.json.spoken || r.json.answer || '', j: r.json }; };

    section('the recording, replayed');
    const list = await say('show me the bookings from houston');
    ck('(a Houston list is on screen, as in the recording)', !!list.j.cards, list.a);

    for (const q of ["what's up today good morning good morning", 'good morning WhatsApp WhatsApp today', 'Good morning.']) {
        const r = await say(q);
        ck(`"${q}" → the briefing`, /Here's Edge Metals/.test(r.s), r.s);
        ck('  not a Houston answer', !BOOKINGISH.test(r.a), r.a);
    }

    for (const q of ['WhatsApp What needs my attention', 'is there any mail that we have received', 'check my mail']) {
        const r = await say(q);
        // The harness has no Gmail, so the inbox path answers that it cannot
        // read mail — which proves the sentence REACHED the inbox path.
        ck(`"${q}" → her inbox, not the bookings on screen`, !BOOKINGISH.test(r.a) && !r.j.cards
            && /Gmail|mail|repl/i.test(r.a) && !/couldn't pin/i.test(r.a), r.a);
    }

    const noise = await say('or or or');
    ck('"or or or" is noise, not a question', noise.a === "Didn't catch that." && noise.s === 'Sorry?', noise.a);

    section('what must still work');
    const f = await say('show me the bookings from houston');
    const fu = await say('when is the erd of that booking');
    ck('a real follow-up on the list still answers from the list', /ERD on this booking|\d{2}\/\d{2}\/\d{4}/.test(fu.s) && !/Here's Edge Metals/.test(fu.s), fu.a);
    const wa = await say('send a WhatsApp to NTG that the truck is late');
    ck('"send a WhatsApp" is not turned into "what\'s up"', !/Here's Edge Metals/.test(wa.s), wa.a);

    section('the port question lists each place once');
    const bq = require(path.join(__dirname, '..', 'helpers/bookingQuery.js'));
    const ports = bq.needsPort({}, { ports: ['Houston', 'LONG BEACH', 'Oakland', 'LOS ANGELES', 'Long Beach', 'CHICAGO', 'Los Angeles'] });
    ck('7 spellings, 5 places', Array.isArray(ports) && ports.length === 5, JSON.stringify(ports));

    await j.stop();
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail) { console.log('\n  failed:'); failures.forEach((x) => console.log('    · ' + x)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
