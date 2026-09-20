// ── tests/voice-scope.js ──────────────────────────────────────────────────
// Three reports from Apsara, 2026-09-19, all through /api/voice/ask:
//
//   "when i ask scout what are the loads that we have taken yesterday - it
//    should not show edge metal loads. its scope is strictly restricted to
//    edge yard"
//   "show me number of bookings that we have loaded this month. It said 0
//    bookings from null."
//   "when i say shut up - it said 0 booking from shutup."
//
// A real server, one sentence per request. For the two bookings reports the
// classifier is stubbed to make EXACTLY the mistake the live model made —
// bookings_count_query with location null / "shutup" — because the bug is
// what the code does with a bad classification, and a stub that classifies
// well would prove nothing.

const path = require('path');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const A = (r) => (r && r.json && r.json.answer) || (r && r.raw) || '';
const ROOT = path.join(__dirname, '..');

function misclassify() {
    const gm = require(path.join(ROOT, 'helpers/gemini.js'));
    const orig = gm.callGeminiJSON;
    gm.callGeminiJSON = async (prompt, ...rest) => {
        const said = (/═══ NEW MESSAGE ═══\s*\n"([\s\S]*?)"\s*\n/.exec(prompt) || [])[1] || '';
        if (/AVAILABLE ACTIONS/i.test(prompt)) {
            if (/loaded this month/i.test(said)) return { action: 'bookings_count_query', location: null, confidence: 0.9 };
            if (/^\s*shut ?up\s*$/i.test(said)) return { action: 'bookings_count_query', location: 'shutup', confidence: 0.9 };
            if (/from mars/i.test(said)) return { action: 'bookings_count_query', location: 'Mars', confidence: 0.9 };
            if (/how many bookings from houston/i.test(said)) return { action: 'bookings_count_query', location: 'Houston', confidence: 0.9 };
        }
        return orig(prompt, ...rest);
    };
}

(async () => {

section('A — Scout answers yard questions with no Edge Metals in sight');
{
    const j = await boot({});
    const one = await j.say('what are the loads that we have taken yesterday', 'scout');
    ck('"Hey Scout, what loads did we take yesterday" is answered by Scout', one.json.agent === 'scout', JSON.stringify(one.json).slice(0, 200));
    ck('  with no bookings panel', !one.json.cards, JSON.stringify(one.json.cards));
    ck('  and no booking in the answer', !/HOU111|HOU222|bookings? from/i.test(A(one)), A(one));

    const two = await j.say('show me the bookings from houston', 'scout');
    ck('even a BOOKINGS question to Scout gets no Metals panel', two.json.agent === 'scout' && !two.json.cards,
        JSON.stringify({ agent: two.json.agent, cards: !!two.json.cards }));
    ck('  and no Metals booking in the words', !/HOU111|HOU222|2 bookings/i.test(A(two)), A(two));

    // The Metals path itself is untouched.
    const three = await j.say('show me the bookings from houston', 'jarvis');
    ck('the same question to JARVIS still shows the bookings', three.json.agent === 'jarvis'
        && three.json.cards && three.json.cards.rows.length === 2, A(three));

    // And a Jarvis offer does not leak into Scout's next turn.
    const four = await j.say('yes', 'scout');
    ck('Scout does not act on Jarvis\'s "want me to forward one?"', four.json.agent === 'scout'
        && !/forward/i.test(A(four)) && j.sent.length === 0, A(four));
    await j.stop();
}

section('B — "0 bookings from null"');
{
    const j = await boot({});
    misclassify();
    const r = await j.say('show me number of bookings that we have loaded this month');
    ck('no "from null"', !/null/i.test(A(r)), A(r));
    ck('  no fake zero', !/^0 /.test(A(r)), A(r));
    ck('  it asks which port and says what it cannot do', /which port/i.test(A(r)) && /loading date/i.test(A(r)), A(r));

    // The same handler serves WhatsApp — the typed path, /api/bot/command,
    // reaches it directly with no voice query layer in front.
    const cmd = (text) => new Promise((resolve, reject) => {
        const body = JSON.stringify({ text });
        const rq = require('http').request({ host: '127.0.0.1', port: j.port, path: '/api/bot/command', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                Authorization: `Bearer ${process.env.API_TOKEN}` } }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let js = null; try { js = JSON.parse(raw); } catch (e) {} resolve({ raw, js }); });
        });
        rq.on('error', reject); rq.write(body); rq.end();
    });
    const T = (r) => JSON.stringify((r.js && (r.js.replies || r.js.reply || r.js)) || r.raw);
    const wn = await cmd('show me number of bookings that we have loaded this month');
    ck('typed: no "from null" either', !/from null/i.test(T(wn)) && /which port/i.test(T(wn)), T(wn));
    const ws = await cmd('shut up');
    ck('typed "shut up": no "from shutup"', !/from shutup/i.test(T(ws)), T(ws));
    const m = await cmd('how many bookings from mars');
    ck('a place with no bookings at all is not counted as zero', /port called \\"mars\\"/i.test(T(m)) && !/"0 /.test(T(m)), T(m));
    const h = await cmd('how many bookings from houston');
    ck('a real port still counts', /(?:2 bookings? from houston|bookings from houston \(2\))/i.test(T(h)), T(h));
    await j.stop();
}

section('C — "shut up"');
{
    const j = await boot({});
    misclassify();
    for (const s of ['shut up', 'Shut up.', 'jarvis, shut up', 'be quiet']) {
        const r = await j.say(s);
        ck(`"${s}" gets a short "Okay." — not a bookings count`, A(r) === 'Okay.' && !r.json.cards, A(r));
    }
    const st = await j.say('stop');
    ck('"stop" with nothing open is a dismissal too', A(st) === 'Okay.', A(st));
    await j.stop();
}
{
    // With a question OPEN, "stop" is her "no" — the brain must see it.
    const j = await boot({});
    const d = await j.say('send a mail to Yurim about the Houston cutoff');
    ck('(a draft is open)', /Send this\?/i.test(A(d)), A(d));
    const st = await j.say('stop');
    ck('"stop" at an open draft cancels it, not "Okay."', A(st) !== 'Okay.' && /cancel/i.test(A(st)), A(st));
    ck('  and nothing was sent', j.mails.length === 0);
    await j.stop();
}
{
    const j = await boot({});
    const d = await j.say('send a mail to Yurim about the Houston cutoff');
    const s = await j.say('shut up');
    ck('"shut up" at an open draft is quiet and leaves the draft alone', A(s) === 'Okay.', A(s));
    const y = await j.say('yes');
    ck('  so "yes" afterwards still sends it', /^Sent to/i.test(A(y)) && j.mails.length === 1, A(y));
    await j.stop();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
