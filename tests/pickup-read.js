// ── tests/pickup-read.js ──────────────────────────────────────────────────
// Apsara, 2026-11-06: "even if i dont tell,based on my email,it should know".
//
// She was offered this entry point that morning and chose the other two.
// Changing her mind is the right call: a pickup arranged by replying "yes
// please" to a carrier is one she will never go and type into a screen.
//
// ── WHAT IS ACTUALLY AT RISK HERE ────────────────────────────────────────
// workflow/emailWatcher.js already auto-creates BOOKINGS from her mail with
// no approval gate ("I don't want any human to do that", 2026-08-20), so
// automatic is the house style. The difference is that a booking writes a
// row and a pickup makes Jarvis EMAIL A THIRD PARTY, on a day it chose,
// about an arrangement it inferred.
//
// The danger in that is not misreading. It is INVENTING A RECIPIENT. So the
// single most important check in this file is section D: the address is the
// sender's, the model is never asked for one, and an address it volunteers
// is thrown away.
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const read = require(path.join(ROOT, 'helpers/pickupRead'));

// A model that answers with whatever the test hands it, and records the
// prompt so the prompt itself can be checked.
function model(answer, sink = {}) {
    return async (prompt) => { sink.prompt = prompt; return answer; };
}
const MAIL = {
    from: 'Dispatch <dispatch@zimex.example>',
    subject: 'Pickup confirmed — MSDU1122334',
    body: 'Hi, our driver will collect the container from the yard on Friday the 20th. Regards, Zimex',
    received_at: '2026-11-17',
    thread_id: 'thr_99',
};
const GOOD = { is_pickup: true, company: 'Zimex Freight', pickup_date: '2026-11-20',
    location: 'the yard', confidence: 'high', why: 'driver collects Friday' };

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the prefilter: loose on purpose, but not useless');
// ══════════════════════════════════════════════════════════════════════════
// It is allowed to pass junk to the model, which can decline. It must NOT
// drop a real pickup — a dropped one is the silent gap the whole feature
// exists to close.
{
    ck('a real pickup confirmation gets through', read.looksLikePickup(MAIL));
    ck('  so does one worded as a collection',
       read.looksLikePickup({ subject: 'Collection scheduled', body: 'we will collect booking 123 Tuesday' }));
    ck('  and one that only says driver + container',
       read.looksLikePickup({ subject: 'Tomorrow', body: 'driver will be at the yard for the container at 9' }));

    ck('a rate quote does not buy a model call',
       !read.looksLikePickup({ subject: 'Rates for Q1', body: 'our prices per mile are attached' }));
    ck('  nor does an out-of-office',
       !read.looksLikePickup({ subject: 'Automatic reply: Pickup', body: 'I am away. pickup container' }));
    ck('  nor a bounce', !read.looksLikePickup({ from: 'mailer-daemon@x', subject: 'Undeliverable: pickup container', body: 'x' }));
    // The two-list rule: one freight word alone is not enough.
    ck('  nor "pick up the phone"',
       !read.looksLikePickup({ subject: 'call me', body: 'please pick up the phone when you can' }));
    ck('  nor an empty mail', !read.looksLikePickup({}));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — it reads a real one');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = await read.readPickup(MAIL, { callGemini: model(GOOD) });
    ck('a pickup comes back', !!r.pickup, r.why);
    ck('  with the company as written', r.pickup.company === 'Zimex Freight');
    ck('  and the date resolved to a real day', r.pickup.pickup_date === '2026-11-20');
    ck('  marked as learnt from email', r.pickup.source === 'email');
    ck('  carrying the thread, so the chase is a reply not a cold mail',
       r.pickup.thread_id === 'thr_99');
    ck('  and the confidence it claimed', r.confidence === 'high', r.confidence);

    // ── THE CONTAINER IS READ IN CODE ────────────────────────────────────
    // ISO 6346 is a checkable shape. A model transposing two digits would
    // file this against a box that does not exist, and nobody would notice
    // until the claim did not match.
    ck('the container is taken from the text, not from the model',
       r.pickup.container_no === 'MSDU1122334', r.pickup.container_no);
    const spaced = await read.readPickup(
        Object.assign({}, MAIL, { body: 'collect container MSDU 1122334 from the yard Friday' }),
        { callGemini: model(GOOD) });
    ck('  and a space inside it does not defeat that',
       spaced.pickup.container_no === 'MSDU1122334', spaced.pickup.container_no);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — it declines, and says why');
// ══════════════════════════════════════════════════════════════════════════
// "If you are unsure, say is_pickup false." A missed pickup is recoverable;
// a wrong one has Jarvis asking a carrier about a job that does not exist.
{
    const no = await read.readPickup(MAIL, { callGemini: model({ is_pickup: false, why: 'this is a rate quote' }) });
    ck('a model "no" is honoured', !no.pickup && /rate quote/.test(no.why), JSON.stringify(no));

    const noDate = await read.readPickup(MAIL, { callGemini: model(
        { is_pickup: true, company: 'Zimex', pickup_date: 'sometime next week' }) });
    ck('a pickup with no real date is refused', !noDate.pickup, JSON.stringify(noDate));
    ck('  and says why, in words', /no day to chase on/.test(noDate.why), noDate.why);

    const noCo = await read.readPickup(MAIL, { callGemini: model(
        { is_pickup: true, company: '', pickup_date: '2026-11-20' }) });
    ck('a pickup with no company is refused', !noCo.pickup && /nobody to ask/.test(noCo.why), noCo.why);

    const dead = await read.readPickup(MAIL, { callGemini: async () => { throw new Error('quota'); } });
    ck('a model that is down costs the reading and nothing else', !dead.pickup, JSON.stringify(dead));
    const none = await read.readPickup(MAIL, {});
    ck('  and with no model at all it simply declines', !none.pickup);
    const junk = await read.readPickup(MAIL, { callGemini: model('not json') });
    ck('  as does an unusable answer', !junk.pickup, JSON.stringify(junk));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — THE ADDRESS IS THE SENDER. THIS IS THE ONE THAT MATTERS');
// ══════════════════════════════════════════════════════════════════════════
// An auto-created pickup causes Jarvis to send mail. If the recipient could
// come from the model, a hallucination reaches a stranger — the failure
// helpers/nameMatch.js refuses for money, in a different currency.
{
    const sink = {};
    const r = await read.readPickup(MAIL, { callGemini: model(GOOD, sink) });
    ck('the contact is the address that actually wrote to her',
       r.pickup.contact_email === 'dispatch@zimex.example', r.pickup.contact_email);

    // The model is never even asked.
    ck('  the prompt tells the model not to return an address',
       /Do NOT return any email address/.test(sink.prompt), 'the instruction is missing');

    // And if it returns one anyway — which models do — it is discarded.
    const liar = await read.readPickup(MAIL, { callGemini: model(Object.assign({}, GOOD, {
        contact_email: 'accounts@totally-different.example',
        email: 'someone@else.example',
    })) });
    ck('  an address it volunteers anyway is thrown away',
       liar.pickup.contact_email === 'dispatch@zimex.example', liar.pickup.contact_email);
    ck('  and nothing it returned leaks onto the record',
       !JSON.stringify(liar.pickup).includes('totally-different'), JSON.stringify(liar.pickup));

    // No sender, no pickup. Better to miss it than to guess who to mail.
    const anon = await read.readPickup(Object.assign({}, MAIL, { from: 'Dispatch Desk' }),
        { callGemini: model(GOOD) });
    ck('a mail with no readable sender creates nothing',
       !anon.pickup && /will not invent one/.test(anon.why), anon.why);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — one truck, however many emails');
// ══════════════════════════════════════════════════════════════════════════
// A carrier confirms, re-confirms, then replies to its own thread. Three
// mails, one truck. Creating three pickups would chase them three times.
{
    const existing = [
        { id: 'a', company: 'Zimex Freight', pickup_date: '2026-11-20', container_no: 'MSDU1122334' },
        { id: 'b', company: 'AJ Transport', pickup_date: '2026-11-21', container_no: '' },
    ];
    ck('the same container on the same day is already known',
       (read.alreadyKnown({ company: 'Zimex', pickup_date: '2026-11-20', container_no: 'msdu1122334' }, existing) || {}).id === 'a');
    ck('  the same company on the same day, with no container, too',
       (read.alreadyKnown({ company: 'aj transport', pickup_date: '2026-11-21' }, existing) || {}).id === 'b');
    ck('a different day is a different truck',
       !read.alreadyKnown({ company: 'Zimex', pickup_date: '2026-11-25', container_no: 'MSDU1122334' }, existing));
    ck('  and a different container on the same day is too',
       !read.alreadyKnown({ company: 'Zimex', pickup_date: '2026-11-20', container_no: 'TEMU7944250' }, existing));
    ck('nothing on file means nothing is known', !read.alreadyKnown({ company: 'X', pickup_date: '2026-11-20' }, []));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
